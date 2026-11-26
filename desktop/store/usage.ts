/* ============================================================================
 * desktop/store/usage.ts —— token 用量与费用统计
 * ==========================================================================*/

import type { UsageRecord } from '@shared/types';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './json';
import { usageFile } from './paths';
import { getSettings } from './settings';

function load(): UsageRecord[] {
  return readJson<UsageRecord[]>(usageFile(), []);
}

export function recordUsage(input: Omit<UsageRecord, 'id' | 'at' | 'cost'>): UsageRecord {
  const rates = getSettings().rates;
  const cost =
    (input.promptTokens / 1_000_000) * rates.input + (input.completionTokens / 1_000_000) * rates.output;
  const record: UsageRecord = {
    ...input,
    id: randomUUID(),
    at: Date.now(),
    cost: Math.round(cost * 1e6) / 1e6,
  };
  const list = load();
  list.push(record);
  // 只保留最近 5000 条，避免文件无限增长
  writeJson(usageFile(), list.slice(-5000));
  return record;
}

export function listUsage(): UsageRecord[] {
  return load().sort((a, b) => b.at - a.at);
}

export function clearUsage(): void {
  writeJson(usageFile(), []);
}

/** 粗略 token 估算：中文按 1.6 字/token，英文按 4 字符/token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.6 + other / 4);
}
