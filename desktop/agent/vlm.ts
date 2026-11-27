/* ============================================================================
 * desktop/agent/vlm.ts —— 内置本地视觉模型（离线识图主力）
 *
 * 设计原则：
 *   · 安装包只带推理运行时（llama.cpp Vulkan 版，约 70MB），模型按需下载，
 *     所以朋友装完不会因为模型体积而放弃更新；
 *   · 模型放在会话根目录下的 models/vlm（默认非系统盘），卸载重装不丢，
 *     也不占 C 盘；
 *   · 下载走 hf-mirror / huggingface 双源 + Range 断点续传 + SHA-256 校验，
 *     跟 update.ts 的多线路思路一致；
 *   · 推理用 llama-server 托管一个本地 HTTP 服务，OpenAI 兼容格式，
 *     空闲 5 分钟自动回收，不常驻吃显存。
 *
 * 能力边界：Qwen2.5-VL-3B 能描述画面、读图中文字、回答「这是什么」，
 * 但密集小字 / 复杂图表不如云端 7B 以上模型；这条链路失败时由
 * vision.ts 回退到 MobileNet + 像素 + OCR，保证永远有识图结果。
 * ==========================================================================*/

import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { VlmPhase, VlmProgress, VlmStatus } from '@shared/types';
import { getSettings } from '../store/settings';

/* ------------------------------------------------------------ 模型清单 */

const REPO = 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF';

interface ModelFile {
  name: string;
  /** 期望字节数，仅用于进度显示与完整性预检；以 SHA-256 为准 */
  bytes: number;
  sha256: string;
  label: string;
}

const MODEL_FILES: ModelFile[] = [
  {
    name: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
    bytes: 1_929_901_056,
    sha256: 'd02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12',
    label: '主模型',
  },
  {
    name: 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',
    bytes: 844_757_728,
    sha256: '980c9b2f78c04e6cff93d277ada09e768394f112d75db3b4e9dea8a69f9fb904',
    label: '视觉投影层',
  },
];

const TOTAL_BYTES = MODEL_FILES.reduce((n, f) => n + f.bytes, 0);

/** 下载源：国内优先镜像，失败回落到官方 */
const SOURCES = [
  { name: 'hf-mirror', base: 'https://hf-mirror.com' },
  { name: 'huggingface', base: 'https://huggingface.co' },
];

/* ------------------------------------------------------------ 路径 */

/**
 * 运行时目录。打包后放在 resources/llama；开发态在仓库 assets/llama。
 * 多给几个候选路径：`electron .` 启动时 app.getAppPath 偶尔会指到 default_app.asar，
 * 打包版从别的目录启动时 cwd 也不一定是安装目录 —— 谁那里有 llama-server 就用谁。
 */
export function runtimeDir(): string {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'llama') : '',
    path.join(app.getAppPath(), 'assets', 'llama'),
    path.join(process.cwd(), 'assets', 'llama'),
    path.join(process.resourcesPath, 'llama'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, name))) return dir;
    } catch {
      /* 继续试下一个 */
    }
  }
  return candidates[0] ?? path.join(process.resourcesPath, 'llama');
}

function serverExe(): string {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.join(runtimeDir(), name);
}

export function runtimeAvailable(): boolean {
  try {
    return fs.existsSync(serverExe());
  } catch {
    return false;
  }
}

/**
 * 模型目录：设置里显式指定优先；否则放在会话根目录的 models/vlm
 * （会话根目录默认探测到非系统盘，避免 2.7GB 模型落到 C 盘）。
 */
export function modelDir(): string {
  const settings = getSettings();
  const custom = (settings.vlmDir ?? '').trim();
  if (custom) return path.resolve(custom);
  const root = (settings.chatRoot ?? '').trim();
  if (root) return path.join(path.resolve(root), 'models', 'vlm');
  return path.join(app.getPath('userData'), 'vlm');
}

function modelPath(): string {
  return path.join(modelDir(), MODEL_FILES[0].name);
}
function mmprojPath(): string {
  return path.join(modelDir(), MODEL_FILES[1].name);
}

function partPath(file: string): string {
  return `${file}.part`;
}

/** 模型文件是否都齐（大小与 GGUF 魔数都过一遍，防止下载中断留下的半成品被当成模型） */
export function modelInstalled(): { ok: boolean; missing: string[]; bytes: number } {
  const missing: string[] = [];
  let bytes = 0;
  for (const file of MODEL_FILES) {
    const full = path.join(modelDir(), file.name);
    try {
      const stat = fs.statSync(full);
      bytes += stat.size;
      // 允许 1MB 误差（不同镜像 Content-Length 可能略有差异，真正的把关是 SHA-256）
      if (stat.size < file.bytes - 1024 * 1024) {
        missing.push(file.name);
        continue;
      }
      const magic = Buffer.alloc(4);
      const fd = fs.openSync(full, 'r');
      fs.readSync(fd, magic, 0, 4, 0);
      fs.closeSync(fd);
      if (magic.toString('ascii') !== 'GGUF') missing.push(file.name);
    } catch {
      missing.push(file.name);
    }
  }
  return { ok: missing.length === 0, missing, bytes };
}

/* ------------------------------------------------------------ 状态与进度 */

export type { VlmPhase, VlmProgress, VlmStatus };

type Sink = (progress: VlmProgress) => void;
let sink: Sink | null = null;
/** IPC 层注册一个进度出口；没有界面时（比如命令行验收）允许为空 */
export function setVlmProgressSink(next: Sink | null): void {
  sink = next;
}

let phase: VlmPhase = 'missing';
let lastMessage = '';
let downloading = false;
let cancelRequested = false;

function emit(progress: Omit<VlmProgress, 'percent'> & { percent?: number }): void {
  const percent =
    progress.percent ??
    (progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 1000) / 10) : 0);
  phase = progress.phase;
  if (progress.message) lastMessage = progress.message;
  try {
    sink?.({ ...progress, percent });
  } catch {
    /* 界面没起来时忽略 */
  }
}

export function vlmStatus(): VlmStatus {
  const userDataDir = modelDir();
  const installed = modelInstalled();
  const runtime = runtimeAvailable();
  let bytes = 0;
  for (const file of MODEL_FILES) {
    try {
      bytes += fs.existsSync(path.join(userDataDir, file.name)) ? fs.statSync(path.join(userDataDir, file.name)).size : 0;
    } catch {
      /* ignore */
    }
  }
  let phaseNow: VlmPhase = phase;
  if (downloading) phaseNow = 'downloading';
  else if (!runtime) phaseNow = 'missing';
  else if (!installed.ok) phaseNow = 'missing';
  else if (server?.ready) phaseNow = 'running';
  else if (serverPromise) phaseNow = 'starting';
  else if (phase === 'error') phaseNow = 'error';
  else phaseNow = 'ready';
  return {
    runtime,
    model: installed.ok,
    dir: userDataDir,
    bytes,
    total: installed.ok ? bytes : TOTAL_BYTES,
    expected: TOTAL_BYTES,
    phase: phaseNow,
    server: !!server?.ready,
    message: lastMessage || undefined,
  };
}

/* ------------------------------------------------------------ 下载 */

function sourceUrl(source: string, name: string): string {
  return `${source}/${REPO}/resolve/main/${name}`;
}

async function sha256File(file: string, onProgress?: (n: number) => void): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(file);
  let read = 0;
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    read += (chunk as Buffer).length;
    onProgress?.(read);
  }
  return hash.digest('hex');
}

/** 单文件下载：Range 续传 + 多源回落；失败抛出人话错误 */
async function downloadFile(file: ModelFile, index: number): Promise<void> {
  const target = path.join(modelDir(), file.name);
  const part = partPath(target);
  await fsp.mkdir(modelDir(), { recursive: true });

  let offset = 0;
  try {
    offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
  } catch {
    offset = 0;
  }

  let lastError = '';
  for (const source of SOURCES) {
    if (cancelRequested) throw new Error('已取消');
    try {
      const headers: Record<string, string> = {};
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      const response = await fetch(sourceUrl(source.base, file.name), {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 416) {
        // 续传位置超出总长度：说明 .part 已经不是这个文件，从头来
        await fsp.rm(part, { force: true });
        offset = 0;
        throw new Error(`${source.name} 续传位置无效，重试`);
      }
      if (!response.ok) throw new Error(`${source.name} HTTP ${response.status}`);
      const total = offset + Number(response.headers.get('content-length') ?? file.bytes - offset);
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`${source.name} 没有返回数据流`);

      const write = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });
      let received = offset;
      let windowBytes = 0;
      let windowStart = Date.now();
      let lastEmit = 0;

      try {
        for (;;) {
          if (cancelRequested) {
            await reader.cancel().catch(() => {});
            throw new Error('已取消');
          }
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (!write.write(chunk)) {
            await new Promise<void>(resolve => write.once('drain', () => resolve()));
          }
          received += chunk.length;
          windowBytes += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 200) {
            lastEmit = now;
            const speed = windowBytes / Math.max(0.5, (now - windowStart) / 1000);
            emit({
              phase: 'downloading',
              file: file.name,
              label: `${index + 1}/${MODEL_FILES.length} ${file.label}`,
              received,
              total: file.bytes,
              percent: Math.min(100, (received / file.bytes) * 100),
              speed,
              source: source.name,
            });
          }
          if (windowBytes > 4 * 1024 * 1024) {
            windowBytes = 0;
            windowStart = now;
          }
        }
      } finally {
        await new Promise<void>(resolve => write.end(() => resolve()));
      }

      if (received < file.bytes - 1024 * 1024) throw new Error(`${source.name} 下载不完整（${received} 字节）`);
      await fsp.rm(target, { force: true });
      await fsp.rename(part, target);
      return;
    } catch (err) {
      lastError = (err as Error).message;
      if (lastError === '已取消') throw err;
      try {
        offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
      } catch {
        offset = 0;
      }
    }
  }
  throw new Error(`模型下载失败：${lastError || '所有下载源都不可用'}`);
}

/** 下载全部模型并校验；返回人话结果，不抛异常 */
export async function downloadModel(): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  if (downloading) return { ok: false, error: '已经在下载中' };
  if (!runtimeAvailable()) {
    return { ok: false, error: '安装包里没有找到 llama-server 运行时，无法本地推理。请重新安装最新版本。' };
  }
  downloading = true;
  cancelRequested = false;
  try {
    for (let i = 0; i < MODEL_FILES.length; i += 1) {
      const file = MODEL_FILES[i];
      const target = path.join(modelDir(), file.name);
      const existing = fs.existsSync(target) ? fs.statSync(target) : null;
      if (existing && existing.size >= file.bytes - 1024 * 1024) continue;
      emit({
        phase: 'downloading',
        file: file.name,
        label: `${i + 1}/${MODEL_FILES.length} ${file.label}`,
        received: 0,
        total: file.bytes,
        percent: 0,
        message: '开始下载',
      });
      await downloadFile(file, i);
      emit({
        phase: 'verifying',
        file: file.name,
        label: `${i + 1}/${MODEL_FILES.length} ${file.label}`,
        received: file.bytes,
        total: file.bytes,
        percent: 100,
        message: '校验文件完整性',
      });
      const digest = await sha256File(target);
      if (digest !== file.sha256) {
        await fsp.rm(target, { force: true });
        throw new Error(`${file.name} 校验失败（SHA-256 不匹配），已删除，请重新下载`);
      }
    }
    lastMessage = '本地视觉模型已就绪';
    emit({ phase: 'ready', received: TOTAL_BYTES, total: TOTAL_BYTES, percent: 100, message: lastMessage });
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message || '下载失败';
    if (message === '已取消') {
      lastMessage = '下载已取消，已下载的部分保留，可继续';
      emit({ phase: 'missing', received: 0, total: TOTAL_BYTES, percent: 0, message: lastMessage });
      return { ok: false, canceled: true, error: lastMessage };
    }
    lastMessage = message;
    emit({ phase: 'error', received: 0, total: TOTAL_BYTES, percent: 0, message });
    return { ok: false, error: message };
  } finally {
    downloading = false;
    cancelRequested = false;
  }
}

export function cancelDownload(): { ok: boolean; canceled: boolean } {
  if (!downloading) return { ok: true, canceled: false };
  cancelRequested = true;
  return { ok: true, canceled: true };
}

/** 删除模型（保留运行时），给界面「释放空间」用 */
export async function deleteModel(): Promise<{ ok: boolean; removed: number }> {
  let removed = 0;
  for (const file of MODEL_FILES) {
    const target = path.join(modelDir(), file.name);
    for (const candidate of [target, partPath(target)]) {
      try {
        if (fs.existsSync(candidate)) {
          removed += 1;
          await fsp.rm(candidate, { force: true });
        }
      } catch {
        /* ignore */
      }
    }
  }
  await stopServer();
  lastMessage = '';
  emit({ phase: 'missing', received: 0, total: TOTAL_BYTES, percent: 0 });
  return { ok: true, removed };
}

/* ------------------------------------------------------------ 本地服务托管 */

interface ServerHandle {
  proc: ChildProcess | null;
  port: number;
  ready: boolean;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
  stderr: string[];
}

let server: ServerHandle | null = null;
/** 同一时刻只允许一个启动流程，避免并发识图拉起两个 llama-server */
let serverPromise: Promise<ServerHandle> | null = null;
/** 连续失败后短时间别再重试，避免每张图都卡一次启动 */
let cooldownUntil = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))));
    });
  });
}

async function health(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const json = (await res.json()) as { status?: string };
    return json.status === 'ok' || json.status === 'ready';
  } catch {
    return false;
  }
}

const IDLE_MS = 5 * 60 * 1000;

function scheduleIdle(handle: ServerHandle): void {
  if (handle.idleTimer) clearTimeout(handle.idleTimer);
  handle.idleTimer = setTimeout(() => {
    void stopServer();
  }, IDLE_MS);
}

function killProc(handle: ServerHandle, signal: NodeJS.Signals = 'SIGTERM'): void {
  const proc = handle.proc;
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      // Windows 下直接 kill 子进程，避免 llama-server 的子线程残留
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      proc.kill(signal);
    }
  } catch {
    /* ignore */
  }
  handle.proc = null;
  handle.ready = false;
}

export async function stopServer(): Promise<void> {
  if (!server) return;
  const handle = server;
  server = null;
  if (handle.idleTimer) clearTimeout(handle.idleTimer);
  killProc(handle);
}

/** 起一次 llama-server 并等 /health 就绪；失败时带上最后几行 stderr 方便排查 */
async function launchAndWait(port: number, gpu: boolean, timeoutMs: number): Promise<ServerHandle> {
  const handle: ServerHandle = {
    proc: null,
    port,
    ready: false,
    lastUsed: Date.now(),
    idleTimer: null,
    stderr: [],
  };

  const args = [
    '--model',
    modelPath(),
    '--mmproj',
    mmprojPath(),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-c',
    '8192',
    '-b',
    '2048',
    '--parallel',
    '1',
    '--image-min-tokens',
    '1024',
    '--no-webui',
    '-ngl',
    gpu ? '99' : '0',
  ];

  let exited = false;
  const proc = spawn(serverExe(), args, {
    cwd: runtimeDir(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  handle.proc = proc;
  proc.stderr?.on('data', (chunk: Buffer) => {
    handle.stderr.push(chunk.toString());
    if (handle.stderr.length > 120) handle.stderr.splice(0, handle.stderr.length - 120);
  });
  proc.once('error', () => {
    exited = true;
  });
  proc.once('exit', () => {
    exited = true;
    handle.ready = false;
    handle.proc = null;
  });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) break;
    if (await health(port)) {
      handle.ready = true;
      scheduleIdle(handle);
      return handle;
    }
    if (Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 600));
  }

  const tail = handle.stderr
    .join('')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-8)
    .join(' | ');
  killProc(handle);
  throw new Error(tail || (exited ? '进程提前退出' : '加载超时'));
}

async function startServer(): Promise<ServerHandle> {
  emit({
    phase: 'starting',
    received: TOTAL_BYTES,
    total: TOTAL_BYTES,
    percent: 100,
    message: '正在加载本地视觉模型（GPU）',
  });
  let gpuError = '';
  try {
    const handle = await launchAndWait(await freePort(), true, 90_000);
    emit({
      phase: 'running',
      received: TOTAL_BYTES,
      total: TOTAL_BYTES,
      percent: 100,
      message: '本地视觉模型已加载',
    });
    return handle;
  } catch (err) {
    gpuError = (err as Error).message;
  }

  // 没显卡 / Vulkan 驱动缺失时退回纯 CPU：慢很多，但不会有「完全不能用」
  emit({
    phase: 'starting',
    received: TOTAL_BYTES,
    total: TOTAL_BYTES,
    percent: 100,
    message: 'GPU 加载失败，改用 CPU（会慢一些）',
  });
  try {
    const handle = await launchAndWait(await freePort(), false, 180_000);
    emit({
      phase: 'running',
      received: TOTAL_BYTES,
      total: TOTAL_BYTES,
      percent: 100,
      message: '本地视觉模型已加载（CPU）',
    });
    return handle;
  } catch (err) {
    throw new Error(`本地视觉模型加载失败：GPU ${gpuError} / CPU ${(err as Error).message}`);
  }
}

async function ensureServer(): Promise<ServerHandle> {
  if (server?.ready) {
    if (await health(server.port)) {
      server.lastUsed = Date.now();
      scheduleIdle(server);
      return server;
    }
    await stopServer();
  }
  if (Date.now() < cooldownUntil) throw new Error('本地视觉模型刚加载失败，稍后再试');
  if (!serverPromise) {
    serverPromise = startServer()
      .then(handle => {
        server = handle;
        return handle;
      })
      .finally(() => {
        serverPromise = null;
      });
  }
  return serverPromise;
}

/* ------------------------------------------------------------ 推理 */

/** 大图先缩到 1600 长边再送模型：省显存又不至于把小字糊掉（1280 时截图文字会看错） */
function toJpegDataUrl(bytes: Buffer): { dataUrl: string; note: string } {
  try {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return { dataUrl: '', note: '' };
    const size = image.getSize();
    const edge = Math.max(size.width, size.height);
    const target = edge > 1600 ? image.resize({ width: Math.round((size.width * 1600) / edge), quality: 'good' }) : image;
    const jpeg = target.toJPEG(88);
    if (!jpeg?.length) return { dataUrl: '', note: '' };
    return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, note: '' };
  } catch {
    return { dataUrl: '', note: '' };
  }
}

const SYSTEM_PROMPT = [
  '你是 NAI WA 的识图引擎，运行在用户本机，只负责客观描述图片。',
  '输出格式（严格照这个结构，不要自由发挥）：',
  '第一句：这张图整体是什么。',
  '然后分条：主体（是什么、在哪个位置）、背景与环境、构图、光线、色调与风格。',
  '最后一行以「图中文字：」开头，把图里所有可见文字逐字抄出来（保留原有换行）；确实没有文字才写「图中文字：无」，字太小看不清就写「图中文字：小字看不清」，不要瞎猜也不是直接写「无」。',
  '如果这是截图，额外说明它是什么软件/界面、关键信息是什么。',
  '硬性要求：不确定的地方写「不确定」，禁止编造；只描述图片本身，禁止把本段任何要求、句式、提示词复述进答案；全程中文，不要客套话，不要提「作为 AI」。',
].join('\n');

export interface LocalVlmResult {
  ok: boolean;
  text?: string;
  error?: string;
  ms?: number;
}

/** 本地视觉模型识图；模型没下载 / 加载失败都返回 ok:false，由上层降级 */
export async function describeWithLocalVlm(input: {
  bytes: Buffer;
  query: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<LocalVlmResult> {
  const started = Date.now();
  if (!runtimeAvailable()) return { ok: false, error: '运行时缺失' };
  if (!modelInstalled().ok) return { ok: false, error: '模型未下载' };

  let handle: ServerHandle;
  try {
    handle = await ensureServer();
  } catch (err) {
    cooldownUntil = Date.now() + 60_000;
    return { ok: false, error: (err as Error).message };
  }

  const { dataUrl } = toJpegDataUrl(input.bytes);
  if (!dataUrl) return { ok: false, error: '图片解码失败' };

  const userText = (input.query ?? '').trim() || '描述这张图片的内容。';
  const body = {
    model: 'local',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: input.maxTokens ?? 700,
    stream: false,
  };

  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? 180_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: `本地视觉模型返回 HTTP ${res.status}：${detail}` };
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    let text = json.choices?.[0]?.message?.content ?? '';
    // Qwen 系列偶尔会带特殊 token，清掉再交给主模型
    text = text.replace(/<\|[^|]*\|>/g, '').trim();
    if (!text) return { ok: false, error: '本地视觉模型没有返回内容' };
    handle.lastUsed = Date.now();
    scheduleIdle(handle);
    return { ok: true, text, ms: Date.now() - started };
  } catch (err) {
    const message = (err as Error).message || '请求失败';
    // 超时通常意味着显存不够或模型在 CPU 上太慢：直接回收，下次重来
    if (/timeout|abort/i.test(message)) await stopServer();
    return { ok: false, error: `本地视觉模型调用失败：${message}` };
  }
}

/** 预热：提前把模型加载进显存，第一张图不用等 */
export async function warmupLocalVlm(): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const started = Date.now();
  if (!runtimeAvailable()) return { ok: false, error: '运行时缺失' };
  if (!modelInstalled().ok) return { ok: false, error: '模型未下载' };
  try {
    await ensureServer();
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    cooldownUntil = Date.now() + 60_000;
    return { ok: false, error: (err as Error).message };
  }
}

/** 是否可以直接用本地视觉模型（运行时就位 + 模型齐） */
export function localVlmAvailable(): boolean {
  return runtimeAvailable() && modelInstalled().ok;
}

/** 给界面/工具用的简短标签 */
export function localVlmLabel(): string {
  return 'Qwen2.5-VL-3B';
}

/* 应用退出时一定要把服务收掉，否则会留下 llama-server 进程 */
app.on('will-quit', () => {
  void stopServer();
});
