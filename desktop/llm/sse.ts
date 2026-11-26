/* ============================================================================
 * desktop/llm/sse.ts —— 通用 SSE 行解析器
 * 各家都用 text/event-stream，只是事件字段不同；这里只负责把流拆成 data 行。
 * ==========================================================================*/

export async function* sseLines(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const rawLine = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (rawLine.startsWith('data:')) {
          const payload = rawLine.slice(5).trim();
          if (payload) yield payload;
        }
        idx = buffer.indexOf('\n');
      }
    }
    // 收尾：处理没有换行符结尾的最后一行
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已释放 */
    }
  }
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
}

export async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  return fetch(url, { method: 'GET', headers, signal });
}
