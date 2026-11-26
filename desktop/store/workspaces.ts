/* ============================================================================
 * desktop/store/workspaces.ts —— 工作区管理
 * 工作区 = 磁盘上的一个真实文件夹 + 应用内的一条记录。
 * 删除工作区时必须由调用方决定是否真的删磁盘文件夹（PRD 4.2）。
 * ==========================================================================*/

import type { Workspace, WorkspaceFile } from '@shared/types';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './json';
import {
  workspacesFile,
  workspaceArtifacts,
  workspaceAttachments,
  workspaceMemoryDir,
  workspaceSandbox,
  workspaceExportDir,
} from './paths';

function load(): Workspace[] {
  return readJson<Workspace[]>(workspacesFile(), []);
}

function save(list: Workspace[]): void {
  writeJson(workspacesFile(), list);
}

export function listWorkspaces(): Workspace[] {
  return load().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getWorkspace(id: string): Workspace | null {
  return load().find(w => w.id === id) ?? null;
}

export function createWorkspace(name: string, dirPath: string): Workspace {
  const list = load();
  const normalized = path.resolve(dirPath);
  if (list.some(w => path.resolve(w.path).toLowerCase() === normalized.toLowerCase())) {
    throw new Error('该文件夹已经是一个工作区');
  }
  fs.mkdirSync(normalized, { recursive: true });
  seedWorkspace(normalized);

  const now = Date.now();
  const ws: Workspace = {
    id: randomUUID(),
    name: name.trim() || '新工作区',
    path: normalized,
    createdAt: now,
    updatedAt: now,
  };
  list.push(ws);
  save(list);
  return ws;
}

/** 工作区内建立应用需要的子目录 */
export function seedWorkspace(wsPath: string): void {
  for (const dir of [workspaceMemoryDir(wsPath), workspaceAttachments(wsPath), workspaceArtifacts(wsPath), workspaceSandbox(wsPath), workspaceExportDir(wsPath)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function updateWorkspace(id: string, patch: { name?: string }): Workspace {
  const list = load();
  const idx = list.findIndex(w => w.id === id);
  if (idx < 0) throw new Error('工作区不存在');
  list[idx] = { ...list[idx], ...patch, updatedAt: Date.now() };
  save(list);
  return list[idx];
}

/**
 * 删除工作区。
 * deleteFolder=false → 只移除应用内记录，磁盘文件夹原样保留（PRD 4.2 备选项）。
 */
export function deleteWorkspace(id: string, deleteFolder: boolean): void {
  const list = load();
  const ws = list.find(w => w.id === id);
  if (!ws) return;
  if (deleteFolder) {
    const target = path.resolve(ws.path);
    // 安全阀：拒绝删除盘符根目录 / 用户主目录 / 系统目录
    const risky = [path.parse(target).root, process.env.USERPROFILE ?? '', process.env.HOME ?? '', 'C:\\Windows'].filter(Boolean);
    const isRisky = risky.some(r => path.resolve(r).toLowerCase() === target.toLowerCase());
    if (isRisky || target.split(path.sep).filter(Boolean).length < 2) {
      throw new Error('出于安全考虑，拒绝对该路径执行磁盘删除');
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  save(list.filter(w => w.id !== id));
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.sql', '.css', '.scss', '.vue', '.svelte', '.lua', '.kt']);

export function classifyFile(name: string): WorkspaceFile['kind'] {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json') return 'json';
  if (CODE_EXT.has(ext)) return 'code';
  if (['.txt', '.log', '.csv', '.yml', '.yaml', '.ini', '.toml', '.env'].includes(ext)) return 'text';
  return 'binary';
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.sandbox', 'memory']);

/** 递归列出工作区文件（最多 400 条，深度 3 层，避免大目录卡死） */
export async function listWorkspaceFiles(ws: Workspace): Promise<WorkspaceFile[]> {
  const out: WorkspaceFile[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= 400 || depth > 3) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 400) return;
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      out.push({
        name: entry.name,
        path: full,
        relPath: path.relative(ws.path, full),
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: classifyFile(entry.name),
      });
    }
  }
  await walk(ws.path, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 会话附件/产物的落盘目录：有工作区进工作区，否则进应用 scratch */
export function resolveChatDir(ws: Workspace | null, sub: 'attachments' | 'artifacts' | 'exports'): string {
  if (!ws) return '';
  if (sub === 'attachments') return workspaceAttachments(ws.path);
  if (sub === 'artifacts') return workspaceArtifacts(ws.path);
  return workspaceExportDir(ws.path);
}

/** 会话产物目录（相对 root 的展示用名字与扫描根），按顺序排列 */
const CHAT_ARTIFACT_SUBS = ['artifacts', 'files', 'exports', 'attachments'] as const;

/**
 * 列出某个会话文件夹里的产物：扫 `<folder>/artifacts`、`files`、`exports`、`attachments`
 * 四个子目录，relPath 一律相对于会话文件夹，便于右栏直接分层显示。
 */
export async function listChatArtifacts(folder: string | null): Promise<WorkspaceFile[]> {
  if (!folder) return [];
  const root: string = folder;
  const out: WorkspaceFile[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= 400 || depth > 3) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 400) return;
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      out.push({
        name: entry.name,
        path: full,
        relPath: path.relative(root, full).split(path.sep).join('/'),
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: classifyFile(entry.name),
      });
    }
  }
  for (const sub of CHAT_ARTIFACT_SUBS) await walk(path.join(folder, sub), 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

let cache: Workspace[] | null = null;
export function workspacesCached(): Workspace[] {
  if (!cache) cache = listWorkspaces();
  return cache;
}
export function invalidateWorkspaceCache(): void {
  cache = null;
}
