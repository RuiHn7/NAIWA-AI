/* ============================================================================
 * desktop/store/providers.ts —— 文本模型接入（API 提供方）管理
 * ==========================================================================*/

import type { ProviderConfig, ProviderKind, RemoteModel, ThinkingLevel } from '@shared/types';
import { readJson, writeJson } from './json';
import { providersFile } from './paths';
import { deleteSecret, getSecret, hasSecret, setSecret } from './secrets';
import { randomUUID } from 'node:crypto';

export interface ProviderRecord extends Omit<ProviderConfig, 'hasKey'> {}

function load(): ProviderRecord[] {
  return readJson<ProviderRecord[]>(providersFile(), []);
}

function save(list: ProviderRecord[]): void {
  writeJson(providersFile(), list);
}

export function secretKey(providerId: string): string {
  return `provider:${providerId}`;
}

export function hydrate(record: ProviderRecord): ProviderConfig {
  return { ...record, hasKey: hasSecret(secretKey(record.id)) };
}

export function listProviders(): ProviderConfig[] {
  return load().map(hydrate);
}

export function getProvider(id: string): ProviderConfig | null {
  const found = load().find(p => p.id === id);
  return found ? hydrate(found) : null;
}

export function getRawProvider(id: string): ProviderRecord | null {
  return load().find(p => p.id === id) ?? null;
}

export function getProviderApiKey(id: string): string | null {
  return getSecret(secretKey(id));
}

export function saveProvider(input: {
  id?: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  apiKey?: string;
  defaultThinking: ThinkingLevel;
  enabled: boolean;
  models?: RemoteModel[];
  thinkingBudget?: ProviderConfig['thinkingBudget'];
}): ProviderConfig {
  const list = load();
  const now = Date.now();
  const existing = input.id ? list.find(p => p.id === input.id) : undefined;

  const record: ProviderRecord = {
    id: existing?.id ?? randomUUID(),
    kind: input.kind,
    label: input.label.trim() || input.kind,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    models: input.models ?? existing?.models ?? [],
    defaultThinking: input.defaultThinking,
    thinkingBudget: input.thinkingBudget ?? existing?.thinkingBudget,
    enabled: input.enabled,
    createdAt: existing?.createdAt ?? now,
  };

  if (existing) {
    const idx = list.findIndex(p => p.id === existing.id);
    list[idx] = record;
  } else {
    list.push(record);
  }
  save(list);

  // 空字符串表示「保持原样」；显式传 '' 才清除
  if (typeof input.apiKey === 'string' && input.apiKey !== '') {
    setSecret(secretKey(record.id), input.apiKey);
  }

  return hydrate(record);
}

export function deleteProvider(id: string): void {
  save(load().filter(p => p.id !== id));
  deleteSecret(secretKey(id));
}

export function setProviderModels(id: string, models: RemoteModel[]): ProviderConfig {
  const list = load();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) throw new Error('接入项不存在');
  list[idx] = { ...list[idx], models };
  save(list);
  return hydrate(list[idx]);
}

/** 所有已勾选模型拍平成下拉列表 */
export function allModels(): { provider: ProviderConfig; model: RemoteModel }[] {
  const out: { provider: ProviderConfig; model: RemoteModel }[] = [];
  for (const p of listProviders()) {
    if (!p.enabled) continue;
    for (const m of p.models) out.push({ provider: p, model: m });
  }
  return out;
}
