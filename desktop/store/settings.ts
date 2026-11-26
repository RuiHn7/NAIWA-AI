/* ============================================================================
 * desktop/store/settings.ts —— 应用设置持久化
 * ==========================================================================*/

import type { AppSettings, CloseAction, Locale, ThemeMode, ThinkingLevel } from '@shared/types';
import { readJson, writeJson } from './json';
import { settingsFile } from './paths';

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  locale: 'zh-CN',
  permission: 'approval',
  sidebarWidth: 268,
  sidebarCollapsed: false,
  rightPanelWidth: 320,
  rightPanelOpen: false,
  defaultPersonaId: 'persona-general',
  defaultThinking: 'high',
  rates: { input: 0.5, output: 2 },
  sandboxTimeoutMs: 30_000,
  sandboxMaxOutput: 20_000,
  webSearchEndpoint: '',
  hasWebSearchKey: false,
  notifications: true,
  webviewAllowlist: ['https://*.wikipedia.org', 'https://developer.mozilla.org', 'https://*.github.com', 'https://*.npmjs.com'],
  autoUpdate: true,
  chatRoot: '',
  closeAction: 'tray',
  autoCompress: true,
  compressThreshold: 0.75,
  visionProviderId: '',
  visionModelId: '',
  visionAutoCheck: true,
};

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  const stored = readJson<Partial<AppSettings>>(settingsFile(), {});
  cache = { ...DEFAULT_SETTINGS, ...stored, rates: { ...DEFAULT_SETTINGS.rates, ...(stored.rates ?? {}) } };
  return cache;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = {
    ...getSettings(),
    ...patch,
    rates: { ...getSettings().rates, ...(patch.rates ?? {}) },
  };
  // 基本范围保护
  next.sidebarWidth = clamp(next.sidebarWidth, 200, 520);
  next.rightPanelWidth = clamp(next.rightPanelWidth, 260, 720);
  next.sandboxTimeoutMs = clamp(next.sandboxTimeoutMs, 1_000, 300_000);
  next.sandboxMaxOutput = clamp(next.sandboxMaxOutput, 1_000, 500_000);
  next.compressThreshold = Math.min(0.95, Math.max(0.5, Number(next.compressThreshold) || 0.75));
  next.visionProviderId = typeof next.visionProviderId === 'string' ? next.visionProviderId.trim() : '';
  next.visionModelId = typeof next.visionModelId === 'string' ? next.visionModelId.trim() : '';
  // 只留 providerId 没留 modelId 时，modelId 保持空串，由识图逻辑在该接入项里自动挑
  if (!next.visionProviderId) next.visionModelId = '';
  next.visionAutoCheck = next.visionAutoCheck !== false;
  if (!VALID_THEME.includes(next.theme)) next.theme = 'system';
  if (!VALID_LOCALE.includes(next.locale)) next.locale = 'zh-CN';
  if (!VALID_THINKING.includes(next.defaultThinking)) next.defaultThinking = 'high';
  cache = next;
  writeJson(settingsFile(), next);
  return next;
}

const VALID_THEME: ThemeMode[] = ['system', 'dark', 'light'];
const VALID_LOCALE: Locale[] = ['zh-CN', 'en-US'];
const VALID_THINKING: ThinkingLevel[] = ['low', 'high', 'max'];

function clamp(v: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
