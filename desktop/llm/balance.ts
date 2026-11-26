/* ============================================================================
 * desktop/llm/balance.ts —— 账户余额探测
 *
 * 各家开放程度差别很大：
 *   · DeepSeek   GET /user/balance               → balance_infos[]
 *   · Moonshot   GET /v1/users/me/balance        → data.available_balance
 *   · 硅基流动    GET /v1/user/info               → data.balance
 *   · OpenAI / Anthropic / Gemini 没有可用 API Key 查余额的公开接口
 * 所以这里做「按已知模板依次尝试 + 通用字段兜底」，全都失败就返回 ok:false。
 * 绝不影响主流程：探不到就是探不到，输入区不显示余额而已。
 * ==========================================================================*/

import type { BalanceResult } from '@shared/ipc';
import type { ProviderKind } from '@shared/types';
import { getJson } from './sse';

/** baseUrl 可能是 https://api.deepseek.com 或 https://api.deepseek.com/v1，取出源站 */
function originOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
}

interface Candidate {
  url: string;
  /** 该模板的解析方式名，仅用于排查 */
  tag: string;
}

function candidatesFor(kind: ProviderKind, baseUrl: string): Candidate[] {
  const origin = originOf(baseUrl);
  const lower = baseUrl.toLowerCase();
  const list: Candidate[] = [];

  if (lower.includes('deepseek')) list.push({ url: `${origin}/user/balance`, tag: 'deepseek' });
  if (lower.includes('moonshot')) list.push({ url: `${origin}/v1/users/me/balance`, tag: 'moonshot' });
  if (lower.includes('siliconflow')) list.push({ url: `${origin}/v1/user/info`, tag: 'siliconflow' });

  // 通用兜底：不同网关（one-api / new-api / 自建）习惯用这几个路径
  list.push({ url: `${origin}/v1/dashboard/billing/credit_grants`, tag: 'openai-legacy' });
  list.push({ url: `${origin}/user/balance`, tag: 'deepseek' });
  list.push({ url: `${origin}/v1/users/me/balance`, tag: 'moonshot' });
  list.push({ url: `${origin}/v1/user/info`, tag: 'siliconflow' });
  list.push({ url: `${origin}/api/user/self`, tag: 'new-api' });

  // 去重，保留顺序
  const seen = new Set<string>();
  return list.filter(c => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

/** 在任意深度的对象里找第一个能当余额用的数字字段 */
const AMOUNT_KEYS = [
  'total_balance',
  'available_balance',
  'balance',
  'total_available',
  'credit_balance',
  'credit',
  'quota',
  'total',
  'remain',
  'remaining',
];

const CURRENCY_KEYS = ['currency', 'unit', 'currency_code'];

function deepFind(obj: unknown, keys: string[], depth = 0): { key: string; value: unknown } | null {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in rec) {
      const v = rec[k];
      if (v !== null && v !== undefined && v !== '') return { key: k, value: v };
    }
  }
  for (const v of Object.values(rec)) {
    const hit = deepFind(v, keys, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function currencySymbol(code: string): string {
  const c = code.toUpperCase();
  if (c === 'CNY' || c === 'RMB') return '¥';
  if (c === 'USD') return '$';
  if (c === 'EUR') return '€';
  return '';
}

function formatAmount(total: number, code: string): string {
  const sym = currencySymbol(code);
  const digits = Math.abs(total) >= 100 ? 2 : 4;
  const num = total.toFixed(digits).replace(/\.?0+$/, '');
  return sym ? `${sym}${num}` : `${num} ${code}`;
}

/**
 * 探测一个接入项的余额。
 * 任何一步失败都静默跳到下一个候选；全部失败返回 ok:false + reason。
 */
export async function fetchBalance(input: {
  kind?: ProviderKind;
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<BalanceResult> {
  const checkedAt = Date.now();
  const { kind = 'openai', baseUrl, apiKey } = input;

  if (!baseUrl.trim()) return { ok: false, checkedAt, reason: '没有填写接口地址' };
  if (!apiKey.trim()) return { ok: false, checkedAt, reason: '没有配置 API Key' };

  const candidates = candidatesFor(kind, baseUrl.trim());
  const attempts: string[] = [];

  for (const c of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort);
    try {
      const res = await getJson(c.url, { Authorization: `Bearer ${apiKey}` }, controller.signal);
      if (!res.ok) {
        attempts.push(`${c.tag} ${res.status}`);
        continue;
      }
      const json: unknown = await res.json().catch(() => null);
      if (!json) {
        attempts.push(`${c.tag} 非 JSON`);
        continue;
      }
      const amount = deepFind(json, AMOUNT_KEYS);
      const total = toNumber(amount?.value);
      if (total === null) {
        attempts.push(`${c.tag} 无余额字段`);
        continue;
      }
      const cur = deepFind(json, CURRENCY_KEYS);
      const currency = typeof cur?.value === 'string' ? cur.value : 'CNY';
      const granted = toNumber(deepFind(json, ['granted_balance', 'voucher_balance', 'granted'])?.value) ?? undefined;
      const toppedUp = toNumber(deepFind(json, ['topped_up_balance', 'cash_balance', 'topped_up'])?.value) ?? undefined;
      return {
        ok: true,
        total,
        currency,
        display: formatAmount(total, currency),
        granted,
        toppedUp,
        endpoint: c.url,
        checkedAt,
      };
    } catch (err) {
      attempts.push(`${c.tag} ${(err as Error).name === 'AbortError' ? '超时' : '网络错误'}`);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    ok: false,
    checkedAt,
    reason:
      kind === 'anthropic' || kind === 'gemini'
        ? '该厂商没有提供可用的余额查询接口'
        : `探测不到余额接口（已尝试 ${attempts.slice(0, 3).join('；')}）`,
  };
}
