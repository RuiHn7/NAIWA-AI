/* ============================================================================
 * desktop/store/paths.ts —— 应用数据目录规划
 * 所有落盘路径集中在这里，其它模块不要自己拼路径。
 *
 * 两类数据分开：
 *   · 应用数据（设置/密钥/接入项/审计/用量）→ userData，跟安装位置无关
 *   · 会话数据（一个会话一个文件夹）→ 默认「非系统盘/NAI WA」，用户可改
 * ==========================================================================*/

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

let root = '';

/** 必须在 app ready 之后调用一次 */
export function initPaths(): void {
  root = app.getPath('userData');
  for (const dir of [root, chats(), workspaces(), memory(), images(), logs(), scratchDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const dataRoot = (): string => root;
export const settingsFile = (): string => path.join(root, 'settings.json');
export const secretsFile = (): string => path.join(root, 'secrets.json');
export const providersFile = (): string => path.join(root, 'providers.json');
export const personasFile = (): string => path.join(root, 'personas.json');
export const mcpFile = (): string => path.join(root, 'mcp.json');
export const tasksFile = (): string => path.join(root, 'tasks.json');
export const usageFile = (): string => path.join(root, 'usage.json');
export const imagesFile = (): string => path.join(root, 'image-providers.json');
export const imageHistoryFile = (): string => path.join(root, 'image-history.json');
export const auditFile = (): string => path.join(root, 'audit.jsonl');
/** 会话索引文件（会话 JSON 本体，与磁盘文件夹分离存放） */
export const chats = (): string => path.join(root, 'chats');
export const chatFile = (id: string): string => path.join(root, 'chats', `${id}.json`);
export const workspaces = (): string => path.join(root, 'workspaces');
export const workspacesFile = (): string => path.join(root, 'workspaces.json');
export const memory = (): string => path.join(root, 'memory');
export const globalMemoryFile = (): string => path.join(root, 'memory', 'global.json');
export const images = (): string => path.join(root, 'images');
export const logs = (): string => path.join(root, 'logs');

/* ------------------------------------------------------------------ 会话根目录 */

const APP_FOLDER = 'NAI WA';

/** 是否系统盘（Windows 只有 C；其它平台认为是） */
function isSystemDrive(drive: string): boolean {
  return drive.replace(/[\\/:]/g, '').toUpperCase() === 'C';
}

function canWrite(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.naiwa-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 自动探测默认会话根目录：
 *   Windows 上找第一个可写的非系统盘（D: → Z:），建 `<盘>\NAI WA`；
 *   都不行就退回用户主目录下的 `NAI WA`。
 */
export function detectChatRoot(): { dir: string; fallback: string | null } {
  if (process.platform === 'win32') {
    for (let code = 68; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:`;
      let exists = false;
      try {
        exists = fs.existsSync(`${drive}\\`);
      } catch {
        exists = false;
      }
      if (!exists || isSystemDrive(drive)) continue;
      const candidate = path.join(`${drive}\\`, APP_FOLDER);
      if (canWrite(candidate)) return { dir: candidate, fallback: null };
    }
  }
  const home = path.join(app.getPath('home'), APP_FOLDER);
  if (canWrite(home)) {
    return { dir: home, fallback: '没有找到可用的非系统盘，已回退到用户目录。' };
  }
  const under = path.join(root, 'chats-data');
  fs.mkdirSync(under, { recursive: true });
  return { dir: under, fallback: '没有找到可写目录，已回退到应用数据目录。' };
}

/* ------------------------------------------------------------------ 工作区内 */

/** 工作区内的应用数据子目录（记忆、附件、产物） */
export function workspaceMemoryDir(wsPath: string): string {
  return path.join(wsPath, 'memory');
}
export function workspaceMemoryFile(wsPath: string): string {
  return path.join(wsPath, 'memory', 'memory.json');
}
export function workspaceMemoryDoc(wsPath: string): string {
  return path.join(wsPath, 'memory', 'MEMORY.md');
}
export function workspaceAttachments(wsPath: string): string {
  return path.join(wsPath, 'attachments');
}
export function workspaceArtifacts(wsPath: string): string {
  return path.join(wsPath, 'artifacts');
}
export function workspaceSandbox(wsPath: string): string {
  return path.join(wsPath, '.sandbox');
}
export function workspaceExportDir(wsPath: string): string {
  return path.join(wsPath, 'exports');
}

/** 无工作区且还没建会话目录时的兜底 */
export function scratchDir(): string {
  const dir = path.join(root, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 会话文件夹内的固定子目录 */
export const chatAttachments = (dir: string): string => path.join(dir, 'attachments');
export const chatArtifacts = (dir: string): string => path.join(dir, 'artifacts');
export const chatFiles = (dir: string): string => path.join(dir, 'files');
export const chatSandbox = (dir: string): string => path.join(dir, '.sandbox');
export const chatExportDir = (dir: string): string => path.join(dir, 'exports');
