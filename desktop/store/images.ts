/* ============================================================================
 * desktop/store/images.ts —— 图片生成接入与历史
 * ==========================================================================*/

import type { GeneratedImage, ImageProviderConfig, ImageProviderKind } from '@shared/types';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './json';
import { imageHistoryFile, imagesFile } from './paths';
import { deleteSecret, getSecret, hasSecret, setSecret } from './secrets';

type ImageRecord = Omit<ImageProviderConfig, 'hasKey'>;

function keyOf(id: string): string {
  return `image:${id}`;
}

export function listImageProviders(): ImageProviderConfig[] {
  return readJson<ImageRecord[]>(imagesFile(), []).map(r => ({ ...r, hasKey: hasSecret(keyOf(r.id)) }));
}

export function getImageProvider(id: string): ImageProviderConfig | null {
  return listImageProviders().find(p => p.id === id) ?? null;
}

export function getImageProviderKey(id: string): string | null {
  return getSecret(keyOf(id));
}

export function saveImageProvider(input: {
  id?: string;
  kind: ImageProviderKind;
  label: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
}): ImageProviderConfig {
  const list = readJson<ImageRecord[]>(imagesFile(), []);
  const existing = input.id ? list.find(p => p.id === input.id) : undefined;
  const record: ImageRecord = {
    id: existing?.id ?? randomUUID(),
    kind: input.kind,
    label: (input.label ?? '').trim() || input.kind,
    baseUrl: (input.baseUrl ?? '').trim().replace(/\/+$/, ''),
    enabled: input.enabled,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  if (existing) list[list.findIndex(p => p.id === existing.id)] = record;
  else list.push(record);
  writeJson(imagesFile(), list);
  if (typeof input.apiKey === 'string' && input.apiKey !== '') setSecret(keyOf(record.id), input.apiKey);
  return { ...record, hasKey: hasSecret(keyOf(record.id)) };
}

export function deleteImageProvider(id: string): void {
  writeJson(imagesFile(), readJson<ImageRecord[]>(imagesFile(), []).filter(p => p.id !== id));
  deleteSecret(keyOf(id));
}

export function listImages(workspaceId?: string | null, chatId?: string | null): GeneratedImage[] {
  const all = readJson<GeneratedImage[]>(imageHistoryFile(), []);
  let filtered = all;
  if (chatId) filtered = filtered.filter(i => i.chatId === chatId);
  else if (workspaceId !== undefined && workspaceId !== null) filtered = filtered.filter(i => i.workspaceId === workspaceId);
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

export function addImages(items: GeneratedImage[]): void {
  const all = readJson<GeneratedImage[]>(imageHistoryFile(), []);
  writeJson(imageHistoryFile(), [...all, ...items].slice(-800));
}
