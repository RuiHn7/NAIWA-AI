/* ============================================================================
 * desktop/agent/update.ts —— 版本检查
 *
 *   默认从 GitHub Releases 取最新 tag；仓库没有 release 时退一步读 tags，
 *   再退一步直接读 package.json 里的 version（master/main 分支）。
 *   任何一步都能失败，失败就返回 reason，绝不让 UI 卡在「检查中」。
 * ==========================================================================*/

import { app, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const REPO = 'RuiHn7/NAIWA-AI';

/** "1.2.3" / "v1.2.3-beta.1" → [1,2,3] */
function parseVersion(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map(n => Number.parseInt(n, 10) || 0);
}

/** a 是否比 b 新 */
export function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** Release 里挂的安装包 */
export interface UpdateAsset {
  name: string;
  url: string;
  /** 字节数，0 表示未知 */
  size: number;
  /** SHA-256（十六进制），没有就不校验 */
  sha256?: string;
}

export interface UpdateCheck {
  ok: boolean;
  current: string;
  latest?: string;
  url?: string;
  reason?: string;
  /** 发布时间（ISO），没有就空 */
  publishedAt?: string;
  /** 版本说明，取自 release body 或 commit message */
  notes?: string;
  source?: 'release' | 'tag' | 'package' | 'manifest';
  /** 当前平台可用的安装包；没有就只能在浏览器里下 */
  installer?: UpdateAsset;
}

/** 按平台挑安装包：Windows 优先 Setup-*.exe，mac 挑 dmg，linux 挑 AppImage */
function pickInstaller(assets: unknown): UpdateAsset | undefined {
  if (!Array.isArray(assets)) return undefined;
  const list = assets
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map(a => ({
      name: String(a.name ?? ''),
      url: String(a.browser_download_url ?? ''),
      size: Number(a.size ?? 0) || 0,
      sha256: typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : undefined,
    }))
    .filter(a => a.name && /^https:\/\//i.test(a.url));

  const platform = process.platform;
  const patterns =
    platform === 'win32' ? [/\.exe$/i] : platform === 'darwin' ? [/\.dmg$/i] : [/\.appimage$/i, /\.deb$/i];
  for (const pattern of patterns) {
    const hit =
      list.find(a => pattern.test(a.name) && /setup|install|nai-wa/i.test(a.name)) ??
      list.find(a => pattern.test(a.name));
    if (hit) return hit;
  }
  return undefined;
}

async function getJson(url: string, timeoutMs = 8000): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'NAI-WA-Desktop' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 自定义更新源优先（企业内网 / 自建分发），否则走 GitHub */
async function fromManifest(manifest: string): Promise<UpdateCheck | null> {
  try {
    const res = await fetch(manifest, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string; url?: string; notes?: string };
    if (!json.version) return null;
    return {
      ok: true,
      current: app.getVersion(),
      latest: json.version,
      url: json.url ?? `https://github.com/${REPO}`,
      notes: json.notes,
      source: 'manifest',
    };
  } catch {
    return null;
  }
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = app.getVersion();
  const manifest = process.env.NAIWA_UPDATE_MANIFEST ?? '';
  if (manifest) {
    const hit = await fromManifest(manifest);
    if (hit) return hit;
  }

  // 1) 正式 release
  const release = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (release?.tag_name) {
    return {
      ok: true,
      current,
      latest: String(release.tag_name).replace(/^v/i, ''),
      url: release.html_url ?? `https://github.com/${REPO}/releases`,
      publishedAt: release.published_at,
      notes: typeof release.body === 'string' ? release.body.slice(0, 1200) : undefined,
      source: 'release',
      installer: pickInstaller(release.assets),
    };
  }

  // 2) 没有 release 就读 tags（仓库刚建、只推过 tag 的情况）
  const tags = await getJson(`https://api.github.com/repos/${REPO}/tags?per_page=10`);
  if (Array.isArray(tags) && tags.length > 0) {
    const name = String(tags[0].name ?? '');
    if (name) {
      return {
        ok: true,
        current,
        latest: name.replace(/^v/i, ''),
        url: `https://github.com/${REPO}/tags`,
        source: 'tag',
      };
    }
  }

  // 3) 最后读默认分支上的 package.json —— 保证「有更新」这件事一定能被发现
  for (const branch of ['main', 'master']) {
    const pkg = await getJson(`https://raw.githubusercontent.com/${REPO}/${branch}/package.json`);
    if (pkg?.version) {
      return {
        ok: true,
        current,
        latest: String(pkg.version),
        url: `https://github.com/${REPO}`,
        source: 'package',
      };
    }
  }

  return {
    ok: false,
    current,
    reason: '连不上 GitHub 或仓库还没有可读的版本信息',
    url: `https://github.com/${REPO}`,
  };
}

/* ------------------------------------------------------- 应用内下载与安装 */

/**
 * 下载线路：
 *   · GitHub 直连：只有官方域名可信
 *   · 加速镜像：只为「有 SHA-256 校验」的资产启用 —— 镜像不可信，校验兜底
 * 先并发测速（各拉 1MB 计时），选最快的一条，再分块并发下载。
 */
const GITHUB_HOST =
  /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//i;

const MIRRORS: Array<{ name: string; prefix: string }> = [
  { name: '加速线路 1', prefix: 'https://ghfast.top/' },
  { name: '加速线路 2', prefix: 'https://gh-proxy.com/' },
  { name: '加速线路 3', prefix: 'https://ghproxy.net/' },
  { name: '加速线路 4', prefix: 'https://gh.llkk.cc/' },
];

interface Source {
  name: string;
  url: string;
}

/** 候选线路：直连永远第一；镜像只在有 SHA-256 时加入（否则无法校验来源） */
function candidateSources(asset: UpdateAsset): Source[] {
  const list: Source[] = [{ name: 'GitHub 直连', url: asset.url }];
  if (asset.sha256) {
    for (const m of MIRRORS) list.push({ name: m.name, url: `${m.prefix}${asset.url}` });
  }
  return list;
}

export interface DownloadProgress {
  phase: 'probing' | 'downloading' | 'verifying' | 'done';
  received: number;
  total: number;
  /** 0-100，total 未知时是 0 */
  percent: number;
  /** 当前速度（字节/秒），测速阶段为 0 */
  speed?: number;
  /** 当前使用的线路名 */
  source?: string;
  /** 竞速后采用的线路数（让 UI 能说明「已自动选最快线路」） */
  sources?: number;
}

/** 正在进行的下载，用于「停止下载」 */
let activeDownload: AbortController | null = null;

/** 停止当前下载（已下载的分块保留，下次可继续） */
export function cancelDownload(): { ok: boolean; canceled: boolean } {
  if (!activeDownload) return { ok: true, canceled: false };
  activeDownload.abort();
  activeDownload = null;
  return { ok: true, canceled: true };
}

function updateDir(): string {
  return path.join(app.getPath('temp'), 'naiwa-updates');
}

function targetFile(asset: UpdateAsset): string {
  const safeName = asset.name.replace(/[^\w.\-]+/g, '_') || 'naiwa-update.exe';
  return path.join(updateDir(), safeName);
}

/** 清掉某个安装包的所有下载产物（正式文件 + 分块），用于「重新下载」 */
export async function clearDownload(asset: UpdateAsset): Promise<{ ok: boolean; removed: number }> {
  cancelDownload();
  const file = targetFile(asset);
  const dir = path.dirname(file);
  const base = path.basename(file);
  let removed = 0;
  try {
    const entries = await fsp.readdir(dir);
    for (const name of entries) {
      if (name === base || name.startsWith(`${base}.part`)) {
        await fsp.unlink(path.join(dir, name)).catch(() => {});
        removed += 1;
      }
    }
  } catch {
    /* 目录不存在就是没下过 */
  }
  return { ok: true, removed };
}

/** 并发测速：各线路拉前 1MB，返回吞吐（字节/毫秒）；失败返回 0 */
async function probeSource(src: Source, signal: AbortSignal): Promise<number> {
  const started = Date.now();
  try {
    const res = await fetch(src.url, {
      headers: { range: 'bytes=0-1048575', 'user-agent': 'NAI-WA-Desktop' },
      redirect: 'follow',
      signal,
    });
    if (!res.ok && res.status !== 206) return 0;
    if (!res.body) return 0;
    let got = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (got >= 1024 * 1024) break;
    }
    const ms = Math.max(1, Date.now() - started);
    // 小于 64KB 视为被限速/被劫持，不参与竞速
    return got < 64 * 1024 ? 0 : got / ms;
  } catch {
    return 0;
  }
}

/**
 * 把安装包下到临时目录。
 *  · 多线路并发测速，自动选最快的一条（直连 + 3 条加速镜像）
 *  · 4 路 Range 分块并发下载；分块文件保留，支持「停止后继续」
 *  · 完成后校验大小与 SHA-256，失败自动换下一条线路重试一次
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  onProgress: (p: DownloadProgress) => void,
): Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }> {
  if (!GITHUB_HOST.test(asset.url)) {
    return { ok: false, error: `拒绝从非 GitHub 域名下载：${asset.url}` };
  }
  await fsp.mkdir(updateDir(), { recursive: true });
  const file = targetFile(asset);

  // 已经下完（大小对得上）就直接用
  try {
    const stat = await fsp.stat(file);
    if (!asset.size || stat.size === asset.size) {
      onProgress({ phase: 'done', received: stat.size, total: stat.size, percent: 100, speed: 0 });
      return { ok: true, path: file };
    }
    await fsp.unlink(file).catch(() => {});
  } catch {
    /* 没下过就正常下载 */
  }

  activeDownload?.abort();
  const controller = new AbortController();
  activeDownload = controller;
  const { signal } = controller;

  const sources = candidateSources(asset);
  onProgress({ phase: 'probing', received: 0, total: asset.size, percent: 0, speed: 0, sources: sources.length });

  // 1) 并发测速（整体 6 秒上限，直连慢就自动走镜像）
  let ranked = sources;
  if (sources.length > 1) {
    const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const scores = await Promise.all(sources.map(s => probeSource(s, probeSignal)));
    const withScore = sources.map((s, i) => ({ s, score: scores[i] }));
    const usable = withScore.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    if (usable.length) ranked = usable.map(x => x.s);
    else ranked = sources;
  }

  const total = asset.size || 0;

  // 2) 依次尝试线路，成功即用
  let lastError = '';
  for (let attempt = 0; attempt < Math.min(2, ranked.length); attempt += 1) {
    const src = ranked[attempt];
    try {
      const done = await fetchToFile(src, file, total, signal, onProgress, attempt);
      if (done.canceled) return { ok: false, canceled: true, error: '已停止下载' };
      if (!done.ok) {
        lastError = done.error ?? '下载失败';
        continue;
      }
    } catch (err) {
      if (signal.aborted) return { ok: false, canceled: true, error: '已停止下载' };
      lastError = (err as Error).message;
      continue;
    }

    // 3) 校验
    onProgress({ phase: 'verifying', received: total, total, percent: 100, speed: 0, source: src.name });
    const stat = await fsp.stat(file).catch(() => null);
    if (asset.size && (!stat || stat.size !== asset.size)) {
      lastError = `下载不完整（${stat?.size ?? 0}/${asset.size} 字节）`;
      await fsp.unlink(file).catch(() => {});
      continue;
    }
    if (asset.sha256) {
      const got = await sha256File(file);
      if (got.toLowerCase() !== asset.sha256.toLowerCase()) {
        lastError = '安装包校验失败（SHA-256 不一致），已删除，请重新下载。';
        await fsp.unlink(file).catch(() => {});
        continue;
      }
    }
    onProgress({ phase: 'done', received: asset.size || stat?.size || 0, total: asset.size || stat?.size || 0, percent: 100, speed: 0, source: src.name });
    activeDownload = null;
    return { ok: true, path: file };
  }

  activeDownload = null;
  return { ok: false, error: lastError || '所有下载线路都失败了，请稍后重试。' };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/** 单条线路下载：优先 4 路 Range 并发；不支持 Range 就退回单流 */
async function fetchToFile(
  src: Source,
  file: string,
  knownTotal: number,
  signal: AbortSignal,
  onProgress: (p: DownloadProgress) => void,
  attempt: number,
): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  const head = await fetch(src.url, {
    headers: { range: 'bytes=0-0', 'user-agent': 'NAI-WA-Desktop' },
    redirect: 'follow',
    signal,
  });
  if (!head.ok && head.status !== 206) throw new Error(`HTTP ${head.status}`);
  const contentRange = head.headers.get('content-range') ?? '';
  const total =
    Number(contentRange.split('/')[1] ?? 0) ||
    Number(head.headers.get('content-length') ?? 0) ||
    knownTotal ||
    0;
  const supportsRange = head.status === 206 && total > 0;
  // 立刻释放测速连接
  await head.body?.cancel().catch(() => {});

  if (!supportsRange) {
    return singleStream(src, file, total, signal, onProgress, attempt);
  }

  const parts = chunkCount(total);
  const per = Math.ceil(total / parts);
  const partFiles: string[] = [];
  let received = 0;
  let lastTick = 0;
  const started = Date.now();
  let lastBytes = 0;

  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 200) return;
    lastTick = now;
    const speed = lastBytes > 0 && now > started ? lastBytes / ((now - started) / 1000) : 0;
    onProgress({
      phase: 'downloading',
      received,
      total,
      percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
      speed,
      source: src.name,
    });
  };

  try {
    for (let i = 0; i < parts; i += 1) {
      const start = i * per;
      const end = Math.min(total, start + per) - 1;
      if (end < start) continue;
      const partFile = `${file}.part${i}`;
      partFiles.push(partFile);
      const expected = end - start + 1;

      // 断点续传：已有的分块直接计入进度
      let have = 0;
      try {
        const st = await fsp.stat(partFile);
        have = Math.min(st.size, expected);
      } catch {
        have = 0;
      }
      received += have;

      if (have >= expected) continue;

      const res = await fetch(src.url, {
        headers: { range: `bytes=${start + have}-${end}`, 'user-agent': 'NAI-WA-Desktop' },
        redirect: 'follow',
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}（分块 ${i + 1}）`);
      const handle = await fsp.open(partFile, have > 0 ? 'a' : 'w');
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          await handle.write(chunk);
          received += chunk.length;
          lastBytes += chunk.length;
          report();
        }
      } finally {
        await handle.close();
      }
      report(true);
    }

    // 合并分块
    const out = await fsp.open(file, 'w');
    try {
      for (const partFile of partFiles) {
        const buf = await fsp.readFile(partFile);
        await out.write(buf);
      }
    } finally {
      await out.close();
    }
    await Promise.all(partFiles.map(p => fsp.unlink(p).catch(() => {})));
    return { ok: true };
  } catch (err) {
    if (signal.aborted) return { ok: false, canceled: true, error: '已停止下载' };
    // 失败时保留分块，方便下次继续
    return { ok: false, error: (err as Error).message };
  }
}

/** 不支持 Range 的线路：单流顺序下载 */
async function singleStream(
  src: Source,
  file: string,
  total: number,
  signal: AbortSignal,
  onProgress: (p: DownloadProgress) => void,
  _attempt: number,
): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  const res = await fetch(src.url, {
    headers: { 'user-agent': 'NAI-WA-Desktop' },
    redirect: 'follow',
    signal,
  });
  if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
  const size = Number(res.headers.get('content-length') ?? 0) || total;
  const handle = await fsp.open(file, 'w');
  let received = 0;
  let lastTick = 0;
  const started = Date.now();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      await handle.write(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastTick > 200) {
        lastTick = now;
        onProgress({
          phase: 'downloading',
          received,
          total: size,
          percent: size ? Math.min(99, Math.round((received / size) * 100)) : 0,
          speed: received / Math.max(0.2, (now - started) / 1000),
          source: src.name,
        });
      }
    }
  } catch (err) {
    if (signal.aborted) return { ok: false, canceled: true, error: '已停止下载' };
    return { ok: false, error: (err as Error).message };
  } finally {
    await handle.close();
  }
  return { ok: true };
}

function chunkCount(total: number): number {
  if (total <= 0) return 1;
  // 大文件 6 路并发：国内直连单线程常被限速，多连接能明显提速
  if (total >= 64 * 1024 * 1024) return 6;
  if (total >= 8 * 1024 * 1024) return 4;
  return 1;
}


/** 启动安装程序并退出应用，让安装器接管文件替换 */
export async function launchInstaller(file: string): Promise<{ ok: boolean; error?: string }> {
  if (!file || !fs.existsSync(file)) return { ok: false, error: '安装包不存在，请重新下载。' };
  if (process.platform === 'win32') {
    if (!/\.exe$/i.test(file)) return { ok: false, error: '这个文件不是 Windows 安装包（.exe）。' };
    try {
      const child = spawn(file, [], { detached: true, stdio: 'ignore' });
      child.unref();
      // 给安装器一点时间起来，再退出自己，避免「文件正在使用」
      setTimeout(() => app.quit(), 800);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `启动安装程序失败：${(err as Error).message}` };
    }
  }
  const err = await shell.openPath(file);
  if (err) return { ok: false, error: err };
  setTimeout(() => app.quit(), 800);
  return { ok: true };
}
