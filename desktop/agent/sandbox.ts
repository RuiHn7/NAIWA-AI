/* ============================================================================
 * desktop/agent/sandbox.ts —— 受限代码沙箱
 *   · 工作目录固定为 <workspace>/.sandbox 或应用 scratch/sandbox
 *   · 超时可调（默认 30s），输出上限截断
 *   · Python / Node 启动时探测，缺失返回安装指引而不是静默失败
 *   · stdout / stderr 逐块回显
 * ==========================================================================*/

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Workspace } from '@shared/types';
import { getWorkspace } from '../store/workspaces';
import { scratchDir, workspaceSandbox } from '../store/paths';
import { getSettings } from '../store/settings';

export type Runtime = 'python' | 'node';

export interface SandboxOptions {
  runtime: Runtime;
  code: string;
  workspaceId: string | null;
  chatId: string;
  timeoutMs?: number;
  onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

export interface SandboxResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  files: string[];
  workDir: string;
  scriptPath: string;
}

const runtimeCache = new Map<Runtime, string | null>();

export function detectRuntime(runtime: Runtime): string | null {
  if (runtimeCache.has(runtime)) return runtimeCache.get(runtime)!;
  const candidates = runtime === 'python'
    ? (process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'])
    : ['node'];
  let found: string | null = null;
  for (const cmd of candidates) {
    const result = tryWhich(cmd);
    if (result) {
      found = result;
      break;
    }
  }
  runtimeCache.set(runtime, found);
  return found;
}

function tryWhich(cmd: string): string | null {
  const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* 权限不足等，跳过 */
      }
    }
  }
  return null;
}

export function runtimeInfo(): { python: string | null; node: string | null } {
  return { python: detectRuntime('python'), node: detectRuntime('node') };
}

export function installHint(runtime: Runtime): string {
  if (runtime === 'python') {
    return '未检测到 Python。请到 https://www.python.org/downloads/ 安装（Windows 安装时勾选 "Add python.exe to PATH"），或改用 Node 运行。';
  }
  return '未检测到 Node.js。请到 https://nodejs.org/ 安装 LTS 版本后重试。';
}

function workDirFor(workspaceId: string | null, chatId: string): string {
  const ws: Workspace | null = workspaceId ? getWorkspace(workspaceId) : null;
  if (ws) {
    const dir = path.join(workspaceSandbox(ws.path), chatId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(scratchDir(), 'sandbox', chatId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function runCode(opts: SandboxOptions): Promise<SandboxResult> {
  const settings = getSettings();
  const timeoutMs = Math.min(300_000, Math.max(1_000, opts.timeoutMs ?? settings.sandboxTimeoutMs));
  const maxOutput = settings.sandboxMaxOutput;

  const exe = detectRuntime(opts.runtime);
  if (!exe) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: installHint(opts.runtime),
      timedOut: false,
      durationMs: 0,
      files: [],
      workDir: '',
      scriptPath: '',
    };
  }

  const workDir = workDirFor(opts.workspaceId, opts.chatId);
  const ext = opts.runtime === 'python' ? 'py' : 'mjs';
  const scriptPath = path.join(workDir, `run-${Date.now()}.${ext}`);
  await fsp.writeFile(scriptPath, opts.code, 'utf8');

  const args = opts.runtime === 'python' ? ['-u', scriptPath] : [scriptPath];
  const started = Date.now();

  return new Promise<SandboxResult>(resolve => {
    const child = spawn(exe, args, {
      cwd: workDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        NAIWA_SANDBOX: '1',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const appendOutput = (stream: 'stdout' | 'stderr', text: string) => {
      if (stream === 'stdout') {
        if (stdout.length < maxOutput) stdout += text;
      } else if (stderr.length < maxOutput) {
        stderr += text;
      }
      opts.onChunk?.({ stream, text });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, timeoutMs);

    child.stdout?.on('data', (buf: Buffer) => appendOutput('stdout', buf.toString('utf8')));
    child.stderr?.on('data', (buf: Buffer) => appendOutput('stderr', buf.toString('utf8')));

    const finish = async (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (spawnError) stderr += `\n${spawnError.message}`;
      let files: string[] = [];
      try {
        files = (await fsp.readdir(workDir)).filter(f => f !== path.basename(scriptPath));
      } catch {
        /* 目录可能被外部删除 */
      }
      resolve({
        ok: !spawnError && exitCode === 0 && !timedOut,
        exitCode,
        stdout: truncate(stdout, maxOutput),
        stderr: truncate(timedOut ? `${stderr}\n\x00超时：已终止执行（${timeoutMs}ms）`.replace('\x00', '') : stderr, maxOutput),
        timedOut,
        durationMs: Date.now() - started,
        files,
        workDir,
        scriptPath,
      });
    };

    child.on('error', err => {
      void finish(null, err);
    });
    child.on('close', code => {
      void finish(code);
    });
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…【输出已截断，共 ${text.length} 字符】`;
}

/** 命令行工具执行（终端命令工具），同样受超时与输出上限约束 */
export async function runCommand(input: {
  command: string;
  workspaceId: string | null;
  chatId: string;
  timeoutMs?: number;
  onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}): Promise<SandboxResult> {
  const settings = getSettings();
  const timeoutMs = Math.min(300_000, Math.max(1_000, input.timeoutMs ?? settings.sandboxTimeoutMs));
  const maxOutput = settings.sandboxMaxOutput;
  const workDir = workDirFor(input.workspaceId, input.chatId);
  const started = Date.now();

  const isWin = process.platform === 'win32';
  const shell = isWin ? 'cmd.exe' : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', input.command] : ['-c', input.command];

  return new Promise<SandboxResult>(resolve => {
    const child = spawn(shell, args, {
      cwd: workDir,
      env: { ...process.env, NAIWA_SANDBOX: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, timeoutMs);

    const collect = (stream: 'stdout' | 'stderr', text: string) => {
      if (stream === 'stdout') stdout = truncate(stdout + text, maxOutput);
      else stderr = truncate(stderr + text, maxOutput);
      input.onChunk?.({ stream, text });
    };
    child.stdout?.on('data', (b: Buffer) => collect('stdout', b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => collect('stderr', b.toString('utf8')));

    const done = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) stderr += `\n${err.message}`;
      resolve({
        ok: !err && code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr: timedOut ? `${stderr}\n超时：已终止执行（${timeoutMs}ms）` : stderr,
        timedOut,
        durationMs: Date.now() - started,
        files: [],
        workDir,
        scriptPath: '',
      });
    };
    child.on('error', e => done(null, e));
    child.on('close', code => done(code));
  });
}

export function platformLabel(): string {
  return `${os.type()} ${os.release()} (${process.platform}/${os.arch()})`;
}
