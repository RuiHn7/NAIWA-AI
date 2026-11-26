/* ============================================================================
 * desktop/agent/compress.ts —— 上下文压缩
 * 策略（PRD 4.6 / 五）：用量超过阈值的 75% 时，保留最近 KEEP_RECENT 条消息，
 * 更早的消息折叠成一条 summary 消息插到最前面，并在 chat.compressions 留痕。
 * 摘要用抽取式（首句 + 关键行 + 主题词），不额外消耗一次模型请求。
 * ==========================================================================*/

import type { Chat, ChatMessage, ContextUsage } from '@shared/types';
import { randomUUID } from 'node:crypto';
import { estimateTokens } from '../store/usage';
import { getSettings } from '../store/settings';

/** 每次压缩后至少保留的近期消息条数 */
const KEEP_RECENT = 10;
/** 触发压缩的用量比例（默认值，可在设置里调，见 AppSettings.compressThreshold） */
const TRIGGER_RATIO = 0.75;

export function chatTokenCount(chat: Chat): number {
  let total = 0;
  for (const m of chat.messages) {
    total += estimateTokens(m.content);
    if (m.reasoning) total += estimateTokens(m.reasoning);
    if (m.toolCalls?.length) {
      for (const t of m.toolCalls) total += estimateTokens(t.result ?? '') + 40;
    }
    total += 12;
  }
  return total;
}

export function contextUsage(chat: Chat, limit: number): ContextUsage {
  let rounds = 0;
  let steps = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let tokPerSec = 0;

  for (const m of chat.messages) {
    if (m.role === 'user') rounds += 1;
    if (m.role === 'assistant') steps += 1 + (m.toolCalls?.length ?? 0);
    if (m.usage) {
      promptTokens += m.usage.promptTokens;
      completionTokens += m.usage.completionTokens;
      totalTokens += m.usage.totalTokens;
      cachedTokens += m.usage.cachedTokens ?? 0;
    }
    // tok/s 取最近一条有耗时的助手消息
    if (m.role === 'assistant' && m.durationMs && m.usage?.completionTokens) {
      tokPerSec = m.usage.completionTokens / Math.max(0.05, m.durationMs / 1000);
    }
  }

  return {
    chatId: chat.id,
    tokens: chatTokenCount(chat),
    limit,
    messageCount: chat.messages.length,
    compressed: chat.compressions?.reduce((n, c) => n + c.dropped, 0) ?? 0,
    rounds,
    steps,
    totalTokens,
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
    tokPerSec,
  };
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 抽取式摘要：用户意图 + 助手结论 + 涉及文件 */
function summarize(dropped: ChatMessage[]): string {
  const userLines: string[] = [];
  const aiLines: string[] = [];
  const files = new Set<string>();
  let toolCount = 0;

  for (const m of dropped) {
    if (m.role === 'user') {
      userLines.push(`- 用户：${clip(m.content, 90)}`);
    } else if (m.role === 'assistant') {
      if (m.content) aiLines.push(`- 助手：${clip(m.content, 110)}`);
      for (const t of m.toolCalls ?? []) {
        toolCount += 1;
        if (t.filePath) files.add(t.filePath);
      }
    }
  }

  const head = `早前 ${dropped.length} 条消息已压缩为摘要（含 ${toolCount} 次工具调用）。`;
  const parts = [head];
  if (userLines.length) parts.push('用户诉求：\n' + userLines.slice(-8).join('\n'));
  if (aiLines.length) parts.push('已给出的结论：\n' + aiLines.slice(-6).join('\n'));
  if (files.size) parts.push('涉及文件：\n' + [...files].slice(0, 10).map(f => `- ${f}`).join('\n'));
  return parts.join('\n\n');
}

export interface CompressOutcome {
  changed: boolean;
  dropped: number;
  summary: string;
  usage: ContextUsage;
}

/**
 * 按需压缩：返回是否改动、丢掉多少条、摘要文本。
 * force = true 时无视阈值强制压缩一次（供「立即压缩」按钮使用）。
 * 自动压缩由设置里的 autoCompress / compressThreshold 控制；手动压缩永远允许，
 * 因为用户可能在自动压缩结果不理想时想自己再折一次。
 */
export function maybeCompress(chat: Chat, limit: number, force = false): CompressOutcome {
  const usage = contextUsage(chat, limit);
  const settings = getSettings();
  const ratio = Number(settings.compressThreshold) || TRIGGER_RATIO;
  const overBudget = usage.tokens > limit * ratio;
  if (!force) {
    if (!settings.autoCompress) return { changed: false, dropped: 0, summary: '', usage };
    if (!overBudget) return { changed: false, dropped: 0, summary: '', usage };
    if (chat.messages.length <= KEEP_RECENT + 4) return { changed: false, dropped: 0, summary: '', usage };
  }

  // 已经压缩过：从最后一条 summary 之后开始算可折叠区间
  const lastSummaryIdx = [...chat.messages].map((m, i) => (m.summary ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const tail = chat.messages.slice(lastSummaryIdx + 1);
  if (tail.length <= KEEP_RECENT) return { changed: false, dropped: 0, summary: '', usage };

  const cut = tail.length - KEEP_RECENT;
  const dropped = tail.slice(0, cut);
  const keep = tail.slice(cut);
  if (!dropped.length) return { changed: false, dropped: 0, summary: '', usage };

  const summaryText = summarize(dropped);
  const summaryMsg: ChatMessage = {
    id: randomUUID(),
    role: 'system',
    content: summaryText,
    summary: true,
    ts: Date.now(),
    status: 'done',
  };

  const head = lastSummaryIdx >= 0 ? chat.messages.slice(0, lastSummaryIdx) : [];
  chat.messages = [...head, summaryMsg, ...keep];
  chat.compressions = [...(chat.compressions ?? []), { at: Date.now(), dropped: dropped.length, summary: summaryText }];

  return {
    changed: true,
    dropped: dropped.length,
    summary: summaryText,
    usage: contextUsage(chat, limit),
  };
}

/** 当前有效的压缩摘要（供 prompt 组装注入） */
export function latestSummary(chat: Chat): string | undefined {
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    const m = chat.messages[i];
    if (m.summary) return m.content;
  }
  return undefined;
}
