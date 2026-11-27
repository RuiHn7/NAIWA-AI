/* ============================================================================
 * desktop/agent/websearch.ts —— 联网搜索
 *
 *   两种模式：
 *     · 用户配了搜索接口（settings.webSearchEndpoint）→ 直接请求该接口；
 *     · 没配 → 内置检索：抓 Bing 结果页并解析，不需要 Key、不需要任何配置。
 *   内置检索是默认路径，所以不会再出现「联网搜索未配置」这种把人挡回去的回复。
 * ==========================================================================*/

export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

/** 搜索结果页的链接有时是 Bing 的跳转地址，把真实 URL 还原出来 */
function resolveSearchUrl(href: string): string {
  try {
    const url = new URL(href);
    if (/(^|\.)bing\.com$/i.test(url.hostname) && url.pathname.startsWith('/ck/a')) {
      const encoded = url.searchParams.get('u') ?? '';
      if (encoded.startsWith('a1')) {
        const raw = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const base64 = raw + '='.repeat((4 - (raw.length % 4)) % 4);
        const decoded = Buffer.from(base64, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
      const direct = url.searchParams.get('url');
      if (direct && /^https?:\/\//i.test(direct)) return direct;
    }
    return href;
  } catch {
    return href;
  }
}

/**
 * 解析 Bing 的结果页。只认 `<li class="b_algo">` 这种标准结果块，
 * 广告、侧栏推荐都不在里面，所以不用额外过滤。
 */
export function parseBingResults(html: string): SearchItem[] {
  const blocks = html.split(/<li class="b_algo/i).slice(1);
  const results: SearchItem[] = [];
  for (const block of blocks) {
    const head = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!head) continue;
    const url = resolveSearchUrl(decodeHtmlEntities(head[1]));
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeHtmlEntities(head[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const para =
      block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = para ? decodeHtmlEntities(para[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
    results.push({ title, url, snippet });
    if (results.length >= 6) break;
  }
  return results;
}

/** 内置检索：直接抓 Bing（cn.bing.com 优先，失败换 www.bing.com） */
export async function builtinWebSearch(query: string, signal: AbortSignal): Promise<string> {
  const hosts = ['https://cn.bing.com/search', 'https://www.bing.com/search'];
  let lastError = '';
  for (const host of hosts) {
    try {
      const url = `${host}?q=${encodeURIComponent(query)}&setlang=zh-CN&count=8`;
      const response = await fetch(url, {
        signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const html = await response.text();
      const items = parseBingResults(html);
      if (!items.length) {
        lastError = '结果页里没有解析到条目';
        continue;
      }
      const lines = [`联网搜索结果（${new URL(host).hostname} · 实时网页）`];
      items.forEach((item, i) => {
        lines.push(`${i + 1}. ${item.title}`);
        lines.push(`   ${item.url}`);
        if (item.snippet) lines.push(`   ${item.snippet}`);
      });
      lines.push('（以上是搜索引擎返回的摘要，引用前如需确认细节，可以用 read_web_page 打开原文。）');
      return lines.join('\n').slice(0, 6000);
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return `联网搜索这次没有结果：${lastError || '搜索源不可达'}。可以换个更短的关键词再试。`;
}

/**
 * 搜索入口。endpoint 为空就走内置 Bing；
 * 配了自建接口就按 `{{q}}` 或 `?q=` 拼 URL 请求。
 */
export async function searchWeb(query: string, endpoint: string, signal: AbortSignal): Promise<string> {
  const trimmed = endpoint.trim();
  if (!trimmed) return builtinWebSearch(query, signal);
  try {
    const url = trimmed.includes('{{q}}')
      ? trimmed.replace('{{q}}', encodeURIComponent(query))
      : `${trimmed}${trimmed.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal });
    const text = await response.text();
    return text.slice(0, 6000);
  } catch (err) {
    return `搜索失败：${(err as Error).message}`;
  }
}
