/* ============================================================================
 * desktop/llm/anthropic.ts —— Anthropic Messages API（claude-*）
 * 流式事件：message_start / content_block_start / content_block_delta / message_delta / message_stop
 * ==========================================================================*/

import type { LlmMessage, LlmRequest, LlmStreamEvent } from './types';
import { LlmError, classifyStatus } from './types';
import { postJson, sseLines } from './sse';

const ANTHROPIC_VERSION = '2023-06-01';

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

function toApiMessages(messages: LlmMessage[]): { system: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const out: unknown[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('\n'));
      continue;
    }
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('\n');
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: text }] });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      const text = typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('\n');
      if (text.trim()) blocks.push({ type: 'text', text });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }
    // user
    if (typeof m.content === 'string') {
      out.push({ role: 'user', content: m.content });
    } else {
      out.push({
        role: 'user',
        content: m.content.map(p =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image', source: { type: 'base64', media_type: p.mime, data: dataUrlToBase64(p.url) } },
        ),
      });
    }
  }
  return { system: systemParts.join('\n\n'), messages: out };
}

function dataUrlToBase64(url: string): string {
  const idx = url.indexOf('base64,');
  return idx >= 0 ? url.slice(idx + 7) : url;
}

export async function* streamAnthropic(req: LlmRequest): AsyncGenerator<LlmStreamEvent> {
  const { system, messages } = toApiMessages(req.messages);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages,
    stream: true,
  };
  if (system) body.system = system;
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  if (req.reasoningBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, req.reasoningBudget) };
  }

  let response: Response;
  try {
    response = await postJson(
      `${req.baseUrl.replace(/\/+$/, '')}/v1/messages`,
      { 'x-api-key': req.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body,
      req.signal,
    );
  } catch (err) {
    const e = err as Error;
    throw new LlmError(e.name === 'AbortError' ? 'timeout' : 'network', e.message || '网络不可达');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(classifyStatus(response.status), `${response.status} ${text.slice(0, 300)}`, response.status);
  }

  let promptTokens = 0;
  let completionTokens = 0;
  const activeBlocks = new Map<number, Block>();

  for await (const data of sseLines(response, req.signal)) {
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    switch (json.type) {
      case 'message_start': {
        promptTokens = json.message?.usage?.input_tokens ?? 0;
        break;
      }
      case 'content_block_start': {
        const idx = json.index as number;
        activeBlocks.set(idx, json.content_block as Block);
        if (json.content_block?.type === 'tool_use') {
          // 起始块只带 id/name，参数靠后续 input_json_delta 累加
          activeBlocks.set(idx, { type: 'tool_use', id: json.content_block.id, name: json.content_block.name, text: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const idx = json.index as number;
        const block = activeBlocks.get(idx);
        const delta = json.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          yield { type: 'text', delta: delta.text };
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'reasoning', delta: delta.thinking };
        } else if (delta?.type === 'input_json_delta' && block) {
          block.text = (block.text ?? '') + (delta.partial_json ?? '');
        }
        break;
      }
      case 'content_block_stop': {
        const idx = json.index as number;
        const block = activeBlocks.get(idx);
        if (block?.type === 'tool_use' && block.name) {
          let args: Record<string, unknown> = {};
          try {
            args = block.text ? JSON.parse(block.text) : {};
          } catch {
            args = { _raw: block.text };
          }
          yield { type: 'tool-call', call: { id: block.id ?? `call_${idx}`, name: block.name, args } };
        }
        break;
      }
      case 'message_delta': {
        completionTokens = json.usage?.output_tokens ?? completionTokens;
        break;
      }
      case 'error': {
        yield { type: 'error', kind: 'unknown', message: json.error?.message ?? 'Anthropic 流式错误' };
        break;
      }
      default:
        break;
    }
  }

  if (promptTokens || completionTokens) yield { type: 'usage', promptTokens, completionTokens };
  yield { type: 'done', finishReason: 'stop' };
}

export async function listAnthropicModels(baseUrl: string, apiKey: string): Promise<{ id: string }[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new LlmError('network', (err as Error).message);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(classifyStatus(response.status), `${response.status} ${text.slice(0, 240)}`, response.status);
  }
  const json: any = await response.json().catch(() => null);
  if (!json) throw new LlmError('unknown', '返回内容不是 JSON');
  const rows: any[] = json.data ?? [];
  return rows.map(r => ({ id: String(r.id ?? '') })).filter(r => r.id);
}
