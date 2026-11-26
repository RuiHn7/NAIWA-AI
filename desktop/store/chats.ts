/* ============================================================================
 * desktop/store/chats.ts —— 会话持久化（一条会话一个 JSON 文件）
 * 分文件存储避免单文件无限膨胀，标题/预览等摘要走 chat:list 现场汇总。
 *
 * 会话磁盘文件夹（PRD 四.1 / 四.2 / 四.3）：
 *   · 空白会话不建目录，folder 为 null
 *   · 首条消息发出时由 ensureChatFolder() 按创建时间建 `<根目录>/2026-11-26_05-53-09`
 *   · 改名同步重命名目录；迁移工作区/根目录时整体移动
 *   目录操作全部集中在这里，渲染进程一律通过 IPC 触发。
 * ==========================================================================*/

import type { Chat, ChatMessage, ChatSummary, ModelRef, ThinkingLevel } from '@shared/types';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './json';
import { chatAttachments, chatArtifacts, chatExportDir, chatFile, chatFiles, chatSandbox, chats } from './paths';
import { getSettings } from './settings';

export const DEFAULT_TITLE = '新对话';

export function createChat(workspaceId: string | null = null, personaId?: string, model: ModelRef | null = null): Chat {
  const now = Date.now();
  const settings = getSettings();
  const chat: Chat = {
    id: randomUUID(),
    title: DEFAULT_TITLE,
    renamed: false,
    workspaceId,
    personaId: personaId ?? settings.defaultPersonaId,
    model,
    thinking: settings.defaultThinking,
    messages: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
    folder: null,
  };
  saveChat(chat);
  return chat;
}

export function saveChat(chat: Chat): void {
  chat.updatedAt = Date.now();
  writeJson(chatFile(chat.id), chat);
}

export function getChat(id: string): Chat | null {
  const file = chatFile(id);
  if (!fs.existsSync(file)) return null;
  return readJson<Chat | null>(file, null);
}

/**
 * 删除会话记录；传 withFolder 时连磁盘文件夹一起删（在主进程内完成，先校验路径）。
 * 返回 { ok, folder } —— folder 表示被删掉的目录。
 */
export function deleteChat(id: string, withFolder = false): { ok: boolean; folder: string | null } {
  const chat = getChat(id);
  let folder: string | null = null;
  if (withFolder && chat?.folder && isSafeChatFolder(chat.folder)) {
    // 目录可能已被手动删除，或被杀软/索引短暂占用 —— 能删就删，删不掉不阻塞记录删除
    if (removeDirHard(chat.folder)) folder = chat.folder;
  }
  try {
    fs.rmSync(chatFile(id));
  } catch {
    /* 已删除 */
  }
  return { ok: true, folder };
}

export function listChats(): ChatSummary[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(chats()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ChatSummary[] = [];
  for (const f of files) {
    const chat = readJson<Chat | null>(path.join(chats(), f), null);
    if (!chat) continue;
    const visible = chat.messages.filter(m => m.role !== 'system');
    const last = [...visible].reverse().find(m => m.role !== 'system');
    const blank = visible.length === 0;
    // 空白会话照实返回（blank 字段交给渲染层判断）。
    // 早期这里写成 `if (blank && chat.folder) continue;` —— 结果「工作区右键 → 创建新对话」
    // 一开始就建好目录的空白会话会直接从侧栏消失，用户点了半天以为没生效。
    // 空壳的清理交给启动时的 pruneBlankChats()，列表本身不做隐藏。
    out.push({
      id: chat.id,
      title: chat.title,
      workspaceId: chat.workspaceId,
      pinned: chat.pinned,
      createdAt: chat.createdAt ?? chat.updatedAt,
      updatedAt: chat.updatedAt,
      messageCount: visible.length,
      preview: last ? last.content.replace(/\s+/g, ' ').slice(0, 80) : '',
      folder: chat.folder ?? null,
      blank,
    });
  }
  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  return out;
}

export function searchChats(query: string): ChatSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return listChats();
  return listChats().filter(c => {
    if (c.title.toLowerCase().includes(q)) return true;
    const chat = getChat(c.id);
    if (!chat) return false;
    return chat.messages.some(m => m.content.toLowerCase().includes(q));
  });
}

export function appendMessage(chatId: string, message: ChatMessage): Chat | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  chat.messages.push(message);
  saveChat(chat);
  return chat;
}

export function updateMessage(chatId: string, messageId: string, patch: Partial<ChatMessage>): Chat | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const idx = chat.messages.findIndex(m => m.id === messageId);
  if (idx < 0) return null;
  chat.messages[idx] = { ...chat.messages[idx], ...patch };
  saveChat(chat);
  return chat;
}

export function removeMessage(chatId: string, messageId: string): Chat | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  chat.messages = chat.messages.filter(m => m.id !== messageId);
  saveChat(chat);
  return chat;
}

export function updateChat(
  id: string,
  patch: Partial<
    Pick<
      Chat,
      'title' | 'renamed' | 'workspaceId' | 'personaId' | 'model' | 'thinking' | 'pinned' | 'folder' | 'contextLimit'
    >
  >,
): Chat | null {
  const chat = getChat(id);
  if (!chat) return null;
  Object.assign(chat, patch);
  saveChat(chat);
  return chat;
}

/** 首条用户消息 → 短标题（本地关键词，不走网络） */
export function autoTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return DEFAULT_TITLE;
  const cut = clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
  return cut;
}

export function messagesForContext(chat: Chat): ChatMessage[] {
  return chat.messages.filter(m => m.role !== 'system' && m.status !== 'streaming' && !m.error);
}

export function findMessage(chat: Chat, id: string): ChatMessage | undefined {
  return chat.messages.find(m => m.id === id);
}

export function touch(chatId: string): void {
  const chat = getChat(chatId);
  if (chat) saveChat(chat);
}

export function setThinking(chatId: string, thinking: ThinkingLevel): void {
  updateChat(chatId, { thinking });
}

/* ============================================================ 文件夹生命周期 */

/** 会话文件夹名：按创建时间 `2026-11-26_05-53-09`（PRD 四.1） */
export function folderNameFor(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** 把标题洗成可用作文件夹名的形式；空则回退 `会话` */
export function sanitizeFolderName(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || '会话';
}

/** 只允许删除/移动我们自己建的会话目录，避免误伤用户其它文件 */
function isSafeChatFolder(dir: string): boolean {
  const resolved = path.resolve(dir);
  const segs = resolved.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return false;
  const roots = [path.resolve(getSettings().chatRoot || ''), path.resolve(process.env.USERPROFILE || ''), path.resolve(process.env.HOME || '')].filter(
    r => r && r !== path.resolve('.'),
  );
  return roots.some(r => resolved.startsWith(r + path.sep)) || /^NAI WA[\\/]/i.test(path.basename(resolved));
}

/** 在 baseDir 下找一个不冲突的目录名（同名追加 -2、-3…） */
function uniqueDir(baseDir: string, name: string): string {
  let candidate = path.join(baseDir, name);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${name}-${n}`);
    n += 1;
    if (n > 999) break;
  }
  return candidate;
}

function seedChatDir(dir: string): void {
  for (const sub of [chatAttachments(dir), chatArtifacts(dir), chatFiles(dir), chatSandbox(dir), chatExportDir(dir)]) {
    fs.mkdirSync(sub, { recursive: true });
  }
}

/**
 * 确保会话有磁盘文件夹（幂等）。baseDir 为空时用设置里的 chatRoot。
 * 返回更新后的 Chat；建目录失败时抛出，由 IPC 层转成中文错误。
 */
export function ensureChatFolder(chatId: string, baseDir?: string): Chat | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  if (chat.folder && fs.existsSync(chat.folder)) return chat;
  const base = baseDir || getSettings().chatRoot;
  if (!base) throw new Error('还没有设置会话存放位置，请到「设置 → 通用」里选择。');
  const dir = uniqueDir(base, folderNameFor(chat.createdAt));
  fs.mkdirSync(dir, { recursive: true });
  seedChatDir(dir);
  chat.folder = dir;
  saveChat(chat);
  return chat;
}

/** 阻塞式小睡（主进程里为了重试删目录，最多几百毫秒） */
function nap(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

/**
 * 删目录：Windows 上杀软 / 索引 / 资源管理器可能刚好拿着句柄，
 * `fs.rmSync` 会抛 ENOTEMPTY。这里重试几次，仍不行就返回 false 交给调用方决定。
 */
function removeDirHard(dir: string): boolean {
  for (let i = 0; i < 6; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 下一轮再试 */
    }
    if (!fs.existsSync(dir)) return true;
    nap(120);
  }
  return !fs.existsSync(dir);
}

/**
 * 把会话文件夹移动到新的基准目录（换工作区 / 换默认存放位置）。
 * 先复制到目标并确认存在，再删源；复制失败时回滚并抛错。返回更新后的 Chat。
 */
export function moveChatFolder(chatId: string, targetBase: string, keepName = true): Chat | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  if (!chat.folder) return ensureChatFolder(chatId, targetBase);
  const source = path.resolve(chat.folder);
  const destBase = path.resolve(targetBase);
  if (source.startsWith(destBase + path.sep)) return chat;
  if (!fs.existsSync(source)) return ensureChatFolder(chatId, destBase);

  const name = keepName ? path.basename(source) : sanitizeFolderName(chat.title);
  const dest = uniqueDir(destBase, name);
  try {
    fs.cpSync(source, dest, { recursive: true, errorOnExist: false });
  } catch (err) {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* 回滚本身失败也只能继续 */
    }
    throw new Error(`移动会话文件夹失败：${(err as Error).message}`);
  }
  // 目标已经是完整副本，源删不掉也不影响正确性（宁可留个空壳，也不回滚丢数据）
  removeDirHard(source);
  chat.folder = dest;
  saveChat(chat);
  return chat;
}

/**
 * 改名同步重命名文件夹（PRD 四.3）。冲突时用 uniqueDir 追加序号，不静默覆盖。
 * 未建目录（空白会话）时什么也不做。
 */
export function renameChatFolder(chatId: string, newTitle: string): Chat | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  if (!chat.folder || !fs.existsSync(chat.folder)) return chat;
  const parent = path.dirname(chat.folder);
  const want = sanitizeFolderName(newTitle);
  if (path.basename(chat.folder) === want) return chat;
  const dest = uniqueDir(parent, want);
  try {
    fs.renameSync(chat.folder, dest);
  } catch {
    // 跨盘或占用：退回复制+删除
    try {
      fs.cpSync(chat.folder, dest, { recursive: true });
      fs.rmSync(chat.folder, { recursive: true, force: true });
    } catch (err) {
      throw new Error(`重命名会话文件夹失败：${(err as Error).message}`);
    }
  }
  chat.folder = dest;
  saveChat(chat);
  return chat;
}

/**
 * 清理启动时的空壳会话。
 * 只删「还没建目录」的那种纯空壳（点了几次新对话残留的）；
 * 已经落到磁盘目录里的空白会话是用户显式创建的（工作区右键 → 创建新对话），要保留。
 */
export function pruneBlankChats(): number {
  let removed = 0;
  for (const summary of listChats()) {
    if (!summary.blank) continue;
    if (summary.folder) continue;
    try {
      fs.rmSync(chatFile(summary.id));
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/**
 * 把某个工作区里的会话全部变回「独立会话」：
 *   · workspaceId 置空
 *   · 会话文件夹从 `<工作区>/chats/…` 搬回默认存放位置（chatRoot）
 * 必须在删除工作区目录之前调用，否则会话数据会跟着目录一起没。
 */
export function releaseWorkspaceChats(workspaceId: string): { moved: number; failed: { id: string; error: string }[] } {
  const root = getSettings().chatRoot;
  let moved = 0;
  const failed: { id: string; error: string }[] = [];
  for (const summary of listChats()) {
    if (summary.workspaceId !== workspaceId) continue;
    const chat = getChat(summary.id);
    if (!chat) continue;
    try {
      if (chat.folder && root && fs.existsSync(chat.folder) && !path.resolve(chat.folder).startsWith(path.resolve(root) + path.sep)) {
        moveChatFolder(chat.id, root);
      }
    } catch (err) {
      // 搬不动就保留在原处（工作区目录若被删，folder 指向失效路径，下次发消息会自动重建）
      failed.push({ id: chat.id, error: (err as Error).message });
    }
    const fresh = getChat(chat.id);
    if (fresh) {
      fresh.workspaceId = null;
      saveChat(fresh);
      moved += 1;
    }
  }
  return { moved, failed };
}

/** 迁移全部会话到新的根目录（PRD 四.1 的「迁移已有会话」） */
export function migrateChatRoot(from: string, to: string): { moved: number; failed: { id: string; error: string }[] } {
  const fromResolved = from ? path.resolve(from) : '';
  const toResolved = path.resolve(to);
  let moved = 0;
  const failed: { id: string; error: string }[] = [];
  for (const summary of listChats()) {
    if (!summary.folder) continue;
    if (fromResolved && !path.resolve(summary.folder).startsWith(fromResolved + path.sep)) continue;
    try {
      moveChatFolder(summary.id, toResolved);
      moved += 1;
    } catch (err) {
      failed.push({ id: summary.id, error: (err as Error).message });
    }
  }
  return { moved, failed };
}
