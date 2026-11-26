/* ============================================================================
 * src/lib/format.ts —— 纯展示层的小工具（无副作用）
 *   带文案的函数统一走 translate(..., currentLocale())，
 *   这样 en-US 下不会残留中文；词典缺条目时自动回落中文。
 * ==========================================================================*/

import { currentLocale, translate } from '@/lib/i18n';

/** 取当前语言下的一条文案 */
function T(source: string): string {
  return translate(source, currentLocale());
}

/** 把 `{n}` 之类的占位换成实际值 */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 会话列表分组（PRD 五：今天 / 昨天 / 本周 / 更早） */
export type Bucket = '今天' | '昨天' | '本周' | '更早';

/** 本周起点：周一 00:00 */
function startOfWeek(now: number): number {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // 周一 = 0
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return base - day * 86400000;
}

export function dayBucket(ts: number, now = Date.now()): Bucket {
  const a = new Date(ts);
  const b = new Date(now);
  const startOfToday = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  const diffDays = Math.floor((startOfToday - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / 86400000);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (ts >= startOfWeek(now)) return '本周';
  return '更早';
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

export function formatCost(n: number): string {
  if (!n) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** 上下文窗口大小的紧凑写法：32k / 128K / 1M */
export function formatContext(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${Number.isInteger(k) ? k : Math.round(k)}K`;
  }
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return fill(T('{n} 分 {m} 秒'), {
    n: Math.floor(ms / 60000),
    m: Math.round((ms % 60000) / 1000),
  });
}

/** 上下文用量色阶：安全 / 偏高 / 危险 */
export function usageLevel(tokens: number, limit: number): 'safe' | 'warn' | 'danger' {
  const ratio = limit > 0 ? tokens / limit : 0;
  if (ratio >= 0.9) return 'danger';
  if (ratio >= 0.7) return 'warn';
  return 'safe';
}

export function relativeTime(ts: number, now = Date.now()): string {
  const d = Math.floor((now - ts) / 1000);
  if (d < 0) return relativeFuture(ts, now);
  if (d < 60) return T('刚刚');
  if (d < 3600) return fill(T('{n} 分钟前'), { n: Math.floor(d / 60) });
  if (d < 86400) return fill(T('{n} 小时前'), { n: Math.floor(d / 3600) });
  if (d < 86400 * 30) return fill(T('{n} 天前'), { n: Math.floor(d / 86400) });
  return formatDay(ts);
}

/** 面向未来的时间点：3 分钟后 / 明天 09:00 / 11 月 30 日 09:00 */
export function relativeFuture(ts: number, now = Date.now()): string {
  const d = Math.floor((ts - now) / 1000);
  if (d <= 0) return T('已到时间');
  if (d < 60) return fill(T('{n} 秒后'), { n: d });
  if (d < 3600) return fill(T('{n} 分钟后'), { n: Math.floor(d / 60) });
  if (d < 86400) {
    const h = Math.floor(d / 3600);
    return h < 6 ? fill(T('{n} 小时后'), { n: h }) : formatTime(ts);
  }
  if (d < 86400 * 2) return fill(T('明天 {t}'), { t: formatTime(ts) });
  if (d < 86400 * 7) return fill(T('{n} 天后 {t}'), { n: Math.floor(d / 86400), t: formatTime(ts) });
  return `${formatDay(ts)} ${formatTime(ts)}`;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function truncate(s: string, n: number): string {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** 把参数对象压成一行摘要，给工具卡片头部用 */
export function argSummary(args: Record<string, unknown>, max = 72): string {
  const keys = ['query', 'q', 'url', 'path', 'file', 'command', 'prompt', 'target', 'name'];
  const order = [...keys.filter(k => k in args), ...Object.keys(args).filter(k => !keys.includes(k))];
  const parts: string[] = [];
  for (const k of order) {
    const v = args[k];
    if (v === undefined || v === null || v === '') continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(text);
    if (parts.join(' · ').length > max) break;
  }
  return truncate(parts.join(' · ') || T('（无参数）'), max);
}
