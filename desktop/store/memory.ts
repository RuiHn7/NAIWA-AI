/* ============================================================================
 * desktop/store/memory.ts —— 三层记忆
 *   会话记忆  ：随会话文件持久化（Chat.messages / compressions），这里只提供读写摘要能力
 *   工作区记忆：<workspace>/memory/memory.json + 同目录 MEMORY.md（人类可读镜像）
 *   全局记忆  ：<userData>/memory/global.json
 * 只有「显式记住」和「Agent 判定为长期信息」才落盘；其余一律不进记忆。
 * ==========================================================================*/

import type { MemoryEntry, MemoryLayer } from '@shared/types';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './json';
import { globalMemoryFile, workspaceMemoryDoc, workspaceMemoryFile } from './paths';
import { getWorkspace } from './workspaces';

interface MemoryFile {
  entries: MemoryEntry[];
}

function readLayer(file: string): MemoryEntry[] {
  return readJson<MemoryFile>(file, { entries: [] }).entries ?? [];
}

function writeLayer(file: string, entries: MemoryEntry[]): void {
  writeJson<MemoryFile>(file, { entries });
}

function fileFor(layer: MemoryLayer, workspaceId?: string | null): string {
  if (layer === 'global') return globalMemoryFile();
  if (layer === 'workspace') {
    const ws = workspaceId ? getWorkspace(workspaceId) : null;
    if (!ws) throw new Error('工作区不存在，无法读写工作区记忆');
    fs.mkdirSync(path.dirname(workspaceMemoryFile(ws.path)), { recursive: true });
    return workspaceMemoryFile(ws.path);
  }
  throw new Error('会话记忆随会话文件存储，请使用会话接口');
}

/** 同步 MEMORY.md，让用户能在文件夹里直接看到记忆内容 */
function syncMarkdown(workspaceId: string): void {
  const ws = getWorkspace(workspaceId);
  if (!ws) return;
  const entries = readLayer(workspaceMemoryFile(ws.path)).sort((a, b) => b.createdAt - a.createdAt);
  const lines = ['# 工作区记忆', '', `> 工作区：${ws.name}（${ws.path}）`, `> 更新于：${new Date().toLocaleString()}`, '', '---', ''];
  if (!entries.length) lines.push('_暂无记忆_');
  for (const e of entries) {
    lines.push(`- ${e.content}`);
    if (e.tags.length) lines.push(`  - 标签：${e.tags.join('、')}`);
    lines.push(`  - 写入：${new Date(e.createdAt).toLocaleString()} · 来源：${e.source}`);
  }
  try {
    fs.writeFileSync(workspaceMemoryDoc(ws.path), lines.join('\n'), 'utf8');
  } catch {
    /* 磁盘不可写时静默 */
  }
}

export function listMemory(opts: { layer?: MemoryLayer; workspaceId?: string; chatId?: string }): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  if (!opts.layer || opts.layer === 'global') out.push(...readLayer(globalMemoryFile()));
  if ((!opts.layer || opts.layer === 'workspace') && opts.workspaceId) {
    const ws = getWorkspace(opts.workspaceId);
    if (ws) out.push(...readLayer(workspaceMemoryFile(ws.path)));
  }
  return out
    .filter(e => (opts.chatId ? e.chatId === opts.chatId || !e.chatId : true))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function addMemory(input: {
  layer: MemoryLayer;
  content: string;
  workspaceId?: string;
  chatId?: string;
  tags?: string[];
  source?: MemoryEntry['source'];
}): MemoryEntry {
  const now = Date.now();
  const entry: MemoryEntry = {
    id: randomUUID(),
    layer: input.layer,
    content: input.content.trim(),
    tags: input.tags ?? extractTags(input.content),
    source: input.source ?? 'user',
    createdAt: now,
    updatedAt: now,
    workspaceId: input.workspaceId,
    chatId: input.chatId,
  };
  if (input.layer === 'session') return entry; // 会话记忆由 chat 文件承载

  const file = fileFor(input.layer, input.workspaceId);
  const entries = readLayer(file);
  // 去重：内容完全一样就不再写
  if (entries.some(e => e.content === entry.content)) {
    return entries.find(e => e.content === entry.content)!;
  }
  entries.push(entry);
  writeLayer(file, entries);
  if (input.layer === 'workspace' && input.workspaceId) syncMarkdown(input.workspaceId);
  return entry;
}

export function updateMemory(id: string, content: string, tags?: string[], workspaceId?: string): MemoryEntry {
  for (const [layer, file] of layerCandidates(workspaceId)) {
    const entries = readLayer(file);
    const idx = entries.findIndex(e => e.id === id);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], content: content.trim(), tags: tags ?? entries[idx].tags, updatedAt: Date.now() };
      writeLayer(file, entries);
      if (layer === 'workspace' && workspaceId) syncMarkdown(workspaceId);
      return entries[idx];
    }
  }
  throw new Error('记忆不存在');
}

export function deleteMemory(id: string, workspaceId?: string): void {
  for (const [layer, file] of layerCandidates(workspaceId)) {
    const entries = readLayer(file);
    const next = entries.filter(e => e.id !== id);
    if (next.length !== entries.length) {
      writeLayer(file, next);
      if (layer === 'workspace' && workspaceId) syncMarkdown(workspaceId);
      return;
    }
  }
}

function layerCandidates(workspaceId?: string): [MemoryLayer, string][] {
  const out: [MemoryLayer, string][] = [['global', globalMemoryFile()]];
  if (workspaceId) {
    const ws = getWorkspace(workspaceId);
    if (ws) out.push(['workspace', workspaceMemoryFile(ws.path)]);
  }
  return out;
}

const STOP = new Set(['的', '了', '是', '在', '和', '我', '你', '他', '她', '它', '们', '这', '那', '有', '就', '也', '都', '要', '会', '不', '把', '被', '给', '让', '对', '从', '到', '而', '与', '或', '但', '如果', '因为', '所以', 'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'it']);

export function extractTags(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

/** 相关性 top-k 检索：字面重叠 + 标签命中 + 新旧程度加权 */
export function retrieveMemory(query: string, opts: { workspaceId?: string | null; limit?: number }): MemoryEntry[] {
  const limit = opts.limit ?? 6;
  const pool: MemoryEntry[] = [
    ...readLayer(globalMemoryFile()).map(e => ({ ...e, layer: 'global' as const })),
  ];
  if (opts.workspaceId) {
    const ws = getWorkspace(opts.workspaceId);
    if (ws) pool.push(...readLayer(workspaceMemoryFile(ws.path)).map(e => ({ ...e, layer: 'workspace' as const })));
  }
  if (!pool.length) return [];

  const q = query.toLowerCase();
  const qChars = new Set(q.replace(/[^\p{L}\p{N}]/gu, '').split('').filter(Boolean));
  const scored = pool.map(e => {
    const text = e.content.toLowerCase();
    let score = 0;
    if (q && text.includes(q.slice(0, 8))) score += 5;
    for (const tag of e.tags) if (q.includes(tag.toLowerCase())) score += 3;
    const chars = new Set(text.replace(/[^\p{L}\p{N}]/gu, '').split('').filter(Boolean));
    let overlap = 0;
    for (const c of qChars) if (chars.has(c)) overlap += 1;
    score += Math.min(6, overlap * 0.35);
    // 工作区记忆优先于全局（同一工作区内更具体）
    if (e.layer === 'workspace') score += 1.5;
    // 时间衰减：30 天前的记忆权重略降
    const days = (Date.now() - e.updatedAt) / 86_400_000;
    score += Math.max(0, 1.2 - days / 60);
    return { e, score };
  });
  return scored
    .filter(s => s.score > 1.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.e);
}
