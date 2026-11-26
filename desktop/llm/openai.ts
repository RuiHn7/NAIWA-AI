/* ============================================================================
 * desktop/llm/openai.ts —— OpenAI 兼容协议（OpenAI / DeepSeek / 通义 / Moonshot / Ollama…）
 * 走 /chat/completions 的流式 SSE，工具调用按 tool_calls 增量拼装。
 * ==========================================================================*/

import type { LlmMessage, LlmRequest, LlmStreamEvent } from './types';
import { LlmError, classifyStatus, type LlmErrorKind } from './types';
import { postJson, sseLines } from './sse';

interface OpenAiDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
}

/** 把内部消息整理成 OpenAI 兼容的 messages。 */
function textOf(content: LlmMessage['content']): string {
  return typeof content === 'string' ? content : content.map(p => (p.type === 'text' ? p.text : '')).join('\n');
}

/**
 * 有些推理端点在 assistant 消息上要求回传 reasoning_content（缺失直接 400）。
 * 这里只在确实有值时才带这个字段，避免不支持它的服务端因为未知字段报错。
 */
function withReasoning<T extends Record<string, unknown>>(row: T, reasoning?: string): T {
  if (!reasoning || !reasoning.trim()) return row;
  return { ...row, reasoning_content: reasoning };
}

function toApiMessages(messages: LlmMessage[]): unknown[] {
  return messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: textOf(m.content) };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return withReasoning(
        {
          role: 'assistant',
          content: textOf(m.content),
          tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        },
        m.reasoning,
      );
    }
    if (typeof m.content === 'string') {
      return m.role === 'assistant' ? withReasoning({ role: m.role, content: m.content }, m.reasoning) : { role: m.role, content: m.content };
    }
    const parts = m.content.map(p =>
      p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.url } },
    );
    return { role: m.role, content: parts };
  });
}

export async function* streamOpenAi(req: LlmRequest): AsyncGenerator<LlmStreamEvent> {
  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toApiMessages(req.messages),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens,
  };
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  if (req.reasoningBudget > 0) {
    // OpenAI 兼容端点对推理参数命名不一，同时给出常见几种，服务端忽略不认识的字段
    body.reasoning_effort = req.reasoningBudget >= 8000 ? 'high' : req.reasoningBudget >= 3000 ? 'medium' : 'low';
    body.thinking = { type: 'enabled', budget_tokens: req.reasoningBudget };
  }

  let response: Response;
  try {
    response = await postJson(url, { Authorization: `Bearer ${req.apiKey}` }, body, req.signal);
  } catch (err) {
    const e = err as Error;
    throw new LlmError(e.name === 'AbortError' ? 'timeout' : 'network', e.message || '网络不可达');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(classifyStatus(response.status), `${response.status} ${text.slice(0, 300)}`, response.status);
  }

  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let finishReason = 'stop';

  for await (const data of sseLines(response, req.signal)) {
    if (data === '[DONE]') break;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.usage) {
      promptTokens = json.usage.prompt_tokens ?? promptTokens;
      completionTokens = json.usage.completion_tokens ?? completionTokens;
      // OpenAI: prompt_tokens_details.cached_tokens；DeepSeek: prompt_cache_hit_tokens
      const cached =
        json.usage.prompt_tokens_details?.cached_tokens ??
        json.usage.prompt_cache_hit_tokens ??
        json.usage.cached_tokens ??
        0;
      if (cached) cachedTokens = Number(cached);
    }
    const choice = json.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta: OpenAiDelta = choice.delta ?? {};

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) yield { type: 'reasoning', delta: reasoning };
    if (delta.content) yield { type: 'text', delta: delta.content };

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const slot = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        toolAcc.set(tc.index, slot);
      }
    }
  }

  for (const [, slot] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!slot.name) continue;
    let args: Record<string, unknown> = {};
    try {
      args = slot.args.trim() ? JSON.parse(slot.args) : {};
    } catch {
      args = { _raw: slot.args };
    }
    yield { type: 'tool-call', call: { id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: slot.name, args } };
  }

  if (promptTokens || completionTokens) yield { type: 'usage', promptTokens, completionTokens, cachedTokens };
  yield { type: 'done', finishReason };
}

/* -------------------------------------------------------------- 模型列表 */

export async function listOpenAiModels(baseUrl: string, apiKey: string): Promise<{ id: string; created?: number }[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new LlmError('network', (err as Error).message);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const kind: LlmErrorKind = classifyStatus(response.status);
    throw new LlmError(kind, `${response.status} ${text.slice(0, 240)}`, response.status);
  }
  const json: any = await response.json().catch(() => null);
  if (!json) throw new LlmError('unknown', '返回内容不是 JSON');
  const rows: any[] = json.data ?? json.models ?? [];
  return rows
    .map(r => ({ id: String(r.id ?? r.name ?? r.model ?? ''), created: r.created }))
    .filter(r => r.id);
}
