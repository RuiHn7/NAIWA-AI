/* ============================================================================
 * desktop/llm/types.ts —— 统一的消息与流式事件形状
 * 三家协议（OpenAI / Anthropic / Gemini）都收敛到这个内部表示。
 * ==========================================================================*/

import type { ProviderKind } from '@shared/types';

export interface LlmToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmTextPart {
  type: 'text';
  text: string;
}

export interface LlmImagePart {
  type: 'image';
  /** data URL 或 http(s) URL */
  url: string;
  mime: string;
}

export type LlmPart = LlmTextPart | LlmImagePart;

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: LlmPart[] | string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  toolName?: string;
  /**
   * 上一轮产生的推理内容。思考型模型（DeepSeek reasoner、部分通义/Kimi 端点）
   * 在「开思考 + 带工具调用」的多轮里，要求把 reasoning_content 原样回传，
   * 否则返回 400：`The reasoning_content in the thinking mode must be passed back to the API`。
   */
  reasoning?: string;
}

export interface LlmRequest {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolSchema[];
  /** 思考强度映射后的推理预算（tokens），0 表示不请求思考 */
  reasoningBudget: number;
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
}

export type LlmStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-call'; call: LlmToolCall }
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens?: number }
  | { type: 'error'; kind: LlmErrorKind; message: string }
  | { type: 'done'; finishReason: string };

export type LlmErrorKind = 'network' | 'auth' | 'rate-limit' | 'timeout' | 'endpoint' | 'unknown';

export class LlmError extends Error {
  kind: LlmErrorKind;
  status?: number;
  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export function classifyStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 404) return 'endpoint';
  if (status >= 500) return 'network';
  return 'unknown';
}

export function friendlyMessage(kind: LlmErrorKind, detail: string): string {
  switch (kind) {
    case 'auth':
      return `鉴权失败：API Key 无效或没有该模型的权限（${detail}）`;
    case 'rate-limit':
      return `请求被限流，已自动退避重试（${detail}）`;
    case 'network':
      return `网络错误：无法连接到接口地址（${detail}）`;
    case 'timeout':
      return `请求超时（${detail}）`;
    case 'endpoint':
      return `接口地址不正确，找不到对应端点（${detail}）`;
    default:
      return detail;
  }
}
