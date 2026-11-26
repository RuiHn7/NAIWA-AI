/* ============================================================================
 * desktop/llm/registry.ts —— 协议分发 + 模型列表拉取 + 重试退避
 * 上层（agent）只调用这里，不关心是哪家协议。
 * ==========================================================================*/

import type { ProviderKind, RemoteModel, ThinkingLevel } from '@shared/types';
import type { LlmMessage, LlmRequest, LlmStreamEvent } from './types';
import { LlmError, friendlyMessage } from './types';
import { streamOpenAi, listOpenAiModels } from './openai';
import { streamAnthropic, listAnthropicModels } from './anthropic';
import { streamGemini, listGeminiModels } from './gemini';

export function streamFor(kind: ProviderKind, req: LlmRequest): AsyncGenerator<LlmStreamEvent> {
  switch (kind) {
    case 'anthropic':
      return streamAnthropic(req);
    case 'gemini':
      return streamGemini(req);
    default:
      return streamOpenAi(req);
  }
}

/** 思考强度 → 推理预算（tokens）。接入项可自定义覆盖。 */
export function budgetFor(level: ThinkingLevel, override?: Partial<Record<ThinkingLevel, number>>): number {
  const defaults: Record<ThinkingLevel, number> = { low: 1024, high: 4096, max: 16384 };
  return override?.[level] ?? defaults[level];
}

/* ------------------------------------------------------------- 模型列表 */

const KNOWN_CONTEXT: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_000_000,
  'o3': 200_000,
  'o4-mini': 200_000,
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-7-sonnet': 200_000,
  'claude-sonnet-4': 200_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'qwen-max': 32_000,
  'moonshot-v1-128k': 128_000,
};

const VISION_HINT = /(vision|4o|4\.1|o3|o4|gemini|claude-3|claude-sonnet|claude-opus|qwen-vl|llava|pixtral)/i;
const REASON_HINT = /(reason|thinking|o1|o3|o4|r1|deepseek-r|claude-3-7|sonnet-4|opus-4|gemini-2\.5)/i;

export function inferModelInfo(id: string): RemoteModel {
  const lower = id.toLowerCase();
  let contextWindow = 32_000;
  for (const [key, value] of Object.entries(KNOWN_CONTEXT)) {
    if (lower.includes(key.toLowerCase())) {
      contextWindow = value;
      break;
    }
  }
  const ctxMatch = /(\d+)\s*k/.exec(lower);
  if (ctxMatch) contextWindow = Math.max(contextWindow, Number(ctxMatch[1]) * 1000);
  return {
    id,
    label: id,
    contextWindow,
    vision: VISION_HINT.test(lower),
    reasoning: REASON_HINT.test(lower),
  };
}

export async function pullModels(kind: ProviderKind, baseUrl: string, apiKey: string): Promise<RemoteModel[]> {
  let rows: { id: string }[];
  switch (kind) {
    case 'anthropic':
      rows = await listAnthropicModels(baseUrl, apiKey);
      break;
    case 'gemini':
      rows = await listGeminiModels(baseUrl, apiKey);
      break;
    default:
      rows = await listOpenAiModels(baseUrl, apiKey);
      break;
  }
  return rows.map(r => inferModelInfo(r.id)).sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------- 退避重试 */

/**
 * 限流 / 网络错误时按指数退避重试（最多 3 次）。
 * 由于流式已经吐了一部分 token 就无法安全重来，调用方只在「尚未产出任何 token」时使用本函数。
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const kind = err instanceof LlmError ? err.kind : 'unknown';
      if (kind !== 'rate-limit' && kind !== 'network') throw err;
      if (attempt === retries) throw err;
      const delay = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

export function describeError(err: unknown): { kind: LlmError['kind']; message: string } {
  if (err instanceof LlmError) return { kind: err.kind, message: friendlyMessage(err.kind, err.message) };
  const e = err as Error;
  if (e?.name === 'AbortError') return { kind: 'timeout', message: '请求已取消' };
  return { kind: 'unknown', message: e?.message ?? '未知错误' };
}

export type { LlmMessage, LlmRequest, LlmStreamEvent };
