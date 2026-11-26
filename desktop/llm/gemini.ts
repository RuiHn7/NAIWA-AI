/* ============================================================================
 * desktop/llm/gemini.ts —— Google Gemini generateContent（v1beta）
 * 流式走 ?alt=sse，候选候选里的 parts 里可能有 text / functionCall。
 * ==========================================================================*/

import type { LlmMessage, LlmRequest, LlmStreamEvent } from './types';
import { LlmError, classifyStatus } from './types';
import { postJson, sseLines } from './sse';

function toContents(messages: LlmMessage[]): { systemInstruction: string; contents: unknown[] } {
  const systemParts: string[] = [];
  const contents: unknown[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('\n'));
      continue;
    }
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('\n');
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.toolName ?? 'tool', response: { result: text } } }] });
      continue;
    }
    const parts: unknown[] = [];
    if (typeof m.content === 'string') {
      parts.push({ text: m.content });
    } else {
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ text: p.text });
        else parts.push({ inlineData: { mimeType: p.mime, data: dataUrlToBase64(p.url) } });
      }
    }
    for (const call of m.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: call.args } });
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return { systemInstruction: systemParts.join('\n\n'), contents };
}

function dataUrlToBase64(url: string): string {
  const idx = url.indexOf('base64,');
  return idx >= 0 ? url.slice(idx + 7) : url;
}

export async function* streamGemini(req: LlmRequest): AsyncGenerator<LlmStreamEvent> {
  const { systemInstruction, contents } = toContents(req.messages);
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: req.maxTokens,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(req.reasoningBudget > 0 ? { thinkingConfig: { includeThoughts: true, thinkingBudget: req.reasoningBudget } } : {}),
    },
  };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }

  const url = `${req.baseUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.apiKey)}`;

  let response: Response;
  try {
    response = await postJson(url, {}, body, req.signal);
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

  for await (const data of sseLines(response, req.signal)) {
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const meta = json.usageMetadata;
    if (meta) {
      promptTokens = meta.promptTokenCount ?? promptTokens;
      completionTokens = meta.candidatesTokenCount ?? completionTokens;
    }
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        if (part.thought) yield { type: 'reasoning', delta: part.text };
        else yield { type: 'text', delta: part.text };
      }
      if (part.functionCall) {
        yield {
          type: 'tool-call',
          call: {
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            name: part.functionCall.name,
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
          },
        };
      }
    }
  }

  if (promptTokens || completionTokens) yield { type: 'usage', promptTokens, completionTokens };
  yield { type: 'done', finishReason: 'stop' };
}

export async function listGeminiModels(baseUrl: string, apiKey: string): Promise<{ id: string }[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new LlmError('network', (err as Error).message);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(classifyStatus(response.status), `${response.status} ${text.slice(0, 240)}`, response.status);
  }
  const json: any = await response.json().catch(() => null);
  if (!json) throw new LlmError('unknown', '返回内容不是 JSON');
  const rows: any[] = json.models ?? [];
  return rows
    .filter(r => (r.supportedGenerationMethods ?? []).includes('generateContent') || !r.supportedGenerationMethods)
    .map(r => ({ id: String(r.name ?? '').replace(/^models\//, '') }))
    .filter(r => r.id);
}
