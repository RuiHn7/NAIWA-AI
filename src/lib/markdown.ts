/* ============================================================================
 * src/lib/markdown.ts —— Markdown → 干净 HTML
 *   · marked 解析 + highlight.js 高亮 + DOMPurify 消毒
 *   · 流式增量：把已经很长的内容按「最后一个空行」切成稳定前缀 + 活动尾巴，
 *     前缀渲染结果缓存复用，每帧只重算尾巴，避免整篇重绘（PRD 六）
 * ==========================================================================*/

import { Marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { currentLocale, translate } from '@/lib/i18n';

const marked = new Marked({
  gfm: true,
  breaks: true,
});

const cache = new Map<string, string>();
const CACHE_LIMIT = 400;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      let body: string;
      let label = language || 'text';
      if (language && hljs.getLanguage(language)) {
        try {
          body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } catch {
          body = escapeHtml(text);
          label = 'text';
        }
      } else {
        body = escapeHtml(text);
      }
      const copyText = translate('复制', currentLocale());
      return (
        `<div class="code-block" data-lang="${escapeHtml(label)}">` +
        `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
        `<button class="code-copy" type="button" data-copy-code aria-label="${escapeHtml(copyText)}">${escapeHtml(copyText)}</button></div>` +
        `<pre class="code-body"><code class="hljs language-${escapeHtml(label)}">${body}</code></pre>` +
        `</div>`
      );
    },
    link({ href, text }) {
      const safe = String(href || '');
      return `<a href="${escapeHtml(safe)}" data-external="1" rel="noreferrer">${text}</a>`;
    },
    image({ href, title, text }) {
      const safe = String(href || '');
      return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text || '')}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
    },
    table(token) {
      // 表格外包一层容器，窄屏可横向滚动
      const header = `<thead><tr>${token.header
        .map(cell => `<th align="${cell.align || 'left'}">${this.parser.parseInline(cell.tokens)}</th>`)
        .join('')}</tr></thead>`;
      const body = `<tbody>${token.rows
        .map(
          row =>
            `<tr>${row
              .map(cell => `<td align="${cell.align || 'left'}">${this.parser.parseInline(cell.tokens)}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</tbody>`;
      return `<div class="table-wrap"><table>${header}${body}</table></div>`;
    },
  },
});

/** 流式输出时补全未闭合的 ** 与 ` ，避免半截语法裸露 */
export function balance(src: string): string {
  let out = String(src ?? '');
  const fences = (out.match(/```/g) || []).length;
  if (fences % 2 === 1) out += '\n```';
  const ticks = (out.match(/(?<!`)`(?!`)/g) || []).length;
  if (ticks % 2 === 1) out += '`';
  const bolds = (out.match(/\*\*/g) || []).length;
  if (bolds % 2 === 1) out += '**';
  const italics = (out.match(/(?<![*_])(?:^|[\s(])([*_])[^*_\s]/g) || []).length;
  if (italics % 2 === 1) out += out.includes('_') && !out.includes('*') ? '_' : '*';
  return out;
}

function parse(src: string): string {
  let html: string;
  try {
    html = marked.parse(src) as string;
  } catch {
    html = `<p>${escapeHtml(src)}</p>`;
  }
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-copy-code', 'data-lang', 'data-external', 'align', 'loading', 'type', 'checked', 'disabled'],
    ADD_TAGS: ['button', 'input'],
  });
}

function memo(key: string, compute: () => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = compute();
  if (cache.size > CACHE_LIMIT) {
    // 简单的 FIFO 清理，够用且不会泄漏
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, html);
  return html;
}

/**
 * 流式增量渲染：
 *   找到最后一个「空行」作为分界，前面整段只渲染一次并缓存，
 *   后面还在长的部分每帧重算 —— 长回复的流式成本从 O(全文) 降到 O(尾巴)。
 *   代码块未闭合时不切分，避免把 fence 拆开。
 */
function renderStreaming(src: string): string {
  const safe = balance(src);
  const fenceCount = (safe.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) return memo(`s\u0000${currentLocale()}\u0000${safe}`, () => parse(safe));

  const cut = safe.lastIndexOf('\n\n');
  if (cut < 120) return memo(`s\u0000${currentLocale()}\u0000${safe}`, () => parse(safe));

  const head = safe.slice(0, cut);
  const tail = safe.slice(cut);
  const headHtml = memo(`h\u0000${currentLocale()}\u0000${head}`, () => parse(head));
  const tailHtml = memo(`t\u0000${currentLocale()}\u0000${tail}`, () => parse(tail));
  return headHtml + tailHtml;
}

export function renderMarkdown(src: string, streaming = false): string {
  if (streaming) return renderStreaming(src);
  const key = `f\u0000${currentLocale()}\u0000${src}`;
  return memo(key, () => parse(String(src ?? '')));
}

/** 纯文本预览（侧栏摘要 / 工具结果折叠） */
export function plain(src: string, max = 120): string {
  const text = String(src ?? '')
    .replace(/```[\s\S]*?```/g, ` ${translate('代码', currentLocale())} `)
    .replace(/[#>*_`~]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
