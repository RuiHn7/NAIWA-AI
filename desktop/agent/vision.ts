/* ============================================================================
 * desktop/agent/vision.ts —— 识图：把图片交给「接入项里支持图片输入的模型」读
 * 主模型是纯文本（DeepSeek 等）也没关系：识图走的是另一个有视觉能力的接入项，
 * 与当前会话用的主模型解耦。找不到视觉模型时给出能照着改的提示。
 *
 * 三种来源都收：
 *   · 本地绝对路径（用户贴图落盘后的附件）
 *   · http(s) 图片链接（工具入参 image_url 直接给链接）
 *   · data URL（粘贴的截图 / 上游直接给 base64）
 * 统一收敛成 bytes + mime 再喂给视觉模型，避免 anthropic / gemini 分支
 * 把非 data URL 的字符串当 base64 解出来是坏数据。
 * ==========================================================================*/

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ProviderKind } from '@shared/types';
import type { LlmMessage } from '../llm/types';
import { streamFor } from '../llm/registry';
import { getProviderApiKey, listProviders } from '../store/providers';
import { getChat } from '../store/chats';
import { getSettings } from '../store/settings';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

export function mimeOf(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'image/png';
}

/** 会话里最近一张用户贴的图片（attachments 里 kind === 'image' 的最后一个） */
export function latestImageAttachment(chatId: string): string | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    const m = chat.messages[i];
    if (m.summary) continue;
    const img = (m.attachments ?? []).filter(a => a.kind === 'image' && a.path && fs.existsSync(a.path)).pop();
    if (img?.path) return img.path;
  }
  return null;
}

export interface UnderstandResult {
  ok: boolean;
  /** 识图模型给出的文字描述 */
  text?: string;
  error?: string;
  /** 干活的接入项与模型，便于向用户说明 */
  provider?: string;
  model?: string;
}

/** 图片过大时直接拒（视觉接口普遍单图 ~10MB 上限，提前给人话） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 下载远端图片的超时 */
const FETCH_TIMEOUT_MS = 30_000;

export interface ImageBytes {
  bytes: Buffer;
  mime: string;
  /** 便于在提示里说明来源 */
  label: string;
}

/** data URL → bytes。只认 base64 形式；不是 data URL 返回 null。 */
function parseDataUrl(url: string): ImageBytes | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(url);
  if (!m) return null;
  const mime = m[1] && m[1].startsWith('image/') ? m[1] : 'image/png';
  const payload = m[3] ?? '';
  if (m[2]) return { bytes: Buffer.from(payload, 'base64'), mime, label: '粘贴的图片' };
  return { bytes: Buffer.from(decodeURIComponent(payload), 'latin1'), mime, label: '粘贴的图片' };
}

/**
 * 把一个图片地址收敛成可发送的字节。支持 本地路径 / file:// / http(s) / data URL。
 * 失败时给的是人话，不抛异常。
 */
export async function loadImageSource(source: string): Promise<{ ok: true; image: ImageBytes } | { ok: false; error: string }> {
  const raw = (source ?? '').trim();
  if (!raw) return { ok: false, error: '没有给图片地址。' };

  if (/^data:/i.test(raw)) {
    const parsed = parseDataUrl(raw);
    if (!parsed || !parsed.bytes.byteLength) return { ok: false, error: '这个 data URL 解不出图片数据。' };
    if (parsed.bytes.byteLength > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片有 ${(parsed.bytes.byteLength / 1024 / 1024).toFixed(1)}MB，超过视觉接口单图 10MB 上限。请先压缩或裁剪后再试。` };
    }
    return { ok: true, image: parsed };
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const response = await fetch(raw, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        return { ok: false, error: `下载图片失败：HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}。` };
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (!buf.byteLength) return { ok: false, error: '下载回来的图片是空的。' };
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        return { ok: false, error: `图片有 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，超过视觉接口单图 10MB 上限。请先压缩或裁剪后再试。` };
      }
      const header = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const mime = header.startsWith('image/') ? header : mimeOf(new URL(raw).pathname);
      return { ok: true, image: { bytes: buf, mime, label: '链接图片' } };
    } catch (err) {
      const msg = (err as Error).message || '';
      const reason = /timeout|abort/i.test(msg) ? '下载超时' : `下载出错（${msg}）`;
      return { ok: false, error: `${reason}：${raw}` };
    }
  }

  const file = raw.startsWith('file://') ? decodeURIComponent(raw.slice('file://'.length)) : raw;
  if (!fs.existsSync(file)) return { ok: false, error: `图片不存在：${file}` };
  const stat = fs.statSync(file);
  if (!stat.isFile()) return { ok: false, error: `这不是文件：${file}` };
  if (stat.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: `图片有 ${(stat.size / 1024 / 1024).toFixed(1)}MB，超过视觉接口单图 10MB 上限。请先压缩或裁剪后再试。` };
  }
  return { ok: true, image: { bytes: fs.readFileSync(file), mime: mimeOf(file), label: path.basename(file) } };
}

interface VisionHit {
  baseUrl: string;
  apiKey: string;
  kind: ProviderKind;
  modelId: string;
  label: string;
}

/**
 * 挑一个用来识图的接入项 + 模型。优先级：
 *   1. 设置里显式指定的「识图模型」（底部那个视觉 LLM 胶囊 / 设置页选的）
 *      · 指定了 modelId 就用它，不管模型名里有没有 vision 字样
 *      · 只指定了接入项就优先挑该接入项里带 vision 标记的模型，没有就用第一个
 *   2. 没指定就自动挑第一个「启用 + 有 Key + 模型列表里有视觉标记」的接入项
 * 这样用户接一个名字里不含 vision 的多模态模型（比如自建网关的任意别名）
 * 也能靠手动指定跑通识图。
 */
function pickVisionTarget(): VisionHit | null {
  const settings = getSettings();
  const providers = listProviders();

  const wantedProvider = (settings.visionProviderId ?? '').trim();
  if (wantedProvider) {
    const p = providers.find(item => item.id === wantedProvider);
    if (p && p.enabled && p.models.length) {
      const apiKey = getProviderApiKey(p.id);
      if (apiKey) {
        const wantedModel = (settings.visionModelId ?? '').trim();
        const byId = wantedModel ? p.models.find(m => m.id === wantedModel) : undefined;
        const vm = byId ?? p.models.find(m => m.vision) ?? p.models[0];
        if (vm) return { baseUrl: p.baseUrl, apiKey, kind: p.kind, modelId: vm.id, label: p.label };
      }
    }
  }

  for (const p of providers) {
    if (!p.enabled || !p.models.length) continue;
    const apiKey = getProviderApiKey(p.id);
    if (!apiKey) continue;
    const vm = p.models.find(m => m.vision);
    if (!vm) continue;
    return { baseUrl: p.baseUrl, apiKey, kind: p.kind, modelId: vm.id, label: p.label };
  }
  return null;
}

/** 当前会用来识图的接入项与模型（给界面显示「现在是谁在识图」） */
export function currentVisionTarget(): { providerId: string; providerLabel: string; modelId: string } | null {
  const settings = getSettings();
  const wantedProvider = (settings.visionProviderId ?? '').trim();
  const wantedModel = (settings.visionModelId ?? '').trim();
  const hit = pickVisionTarget();
  if (!hit) return null;
  if (wantedProvider) {
    return { providerId: wantedProvider, providerLabel: hit.label, modelId: wantedModel || hit.modelId };
  }
  const matched = listProviders().find(p => p.baseUrl === hit.baseUrl && p.label === hit.label);
  return { providerId: matched?.id ?? '', providerLabel: hit.label, modelId: hit.modelId };
}

/** 把图片字节交给「启用中、有 Key、模型列表里有视觉模型」的接入项读 */
export async function understandImageBytes(input: { bytes: Buffer; mime: string; query: string }): Promise<UnderstandResult> {
  const { bytes, mime, query } = input;

  const hit = pickVisionTarget();
  if (!hit) {
    return {
      ok: false,
      error:
        '当前没有任何接入项带视觉模型，识图做不了。可以在输入框底部点「识图」选一个支持图片输入的模型（如 gpt-4o、claude-sonnet、gemini、qwen-vl），或到「设置 → 接入模型」接入一个多模态接入项。',
    };
  }

  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image', url: dataUrl, mime },
        { type: 'text', text: query || '描述这张图片的内容。' },
      ],
    },
  ];

  let text = '';
  try {
    const stream = streamFor(hit.kind, {
      kind: hit.kind,
      baseUrl: hit.baseUrl,
      apiKey: hit.apiKey,
      model: hit.modelId,
      messages,
      reasoningBudget: 0,
      maxTokens: 4096,
      signal: AbortSignal.timeout(120_000),
    });
    for await (const event of stream) {
      if (event.type === 'text') text += event.delta;
      else if (event.type === 'error') throw new Error(event.message);
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message, provider: hit.label, model: hit.modelId };
  }

  if (!text.trim()) {
    return { ok: false, error: '视觉模型没有返回任何内容。', provider: hit.label, model: hit.modelId };
  }
  return { ok: true, text: text.trim(), provider: hit.label, model: hit.modelId };
}

/** 本地路径识图（会话附件走这里） */
export async function understandImage(input: { imagePath: string; query: string }): Promise<UnderstandResult> {
  const loaded = await loadImageSource(input.imagePath);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return understandImageBytes({ bytes: loaded.image.bytes, mime: loaded.image.mime, query: input.query });
}

/** 任意来源识图（image_url：本地路径 / http(s) / data URL） */
export async function understandImageSource(input: { imageUrl: string; query: string }): Promise<UnderstandResult> {
  const loaded = await loadImageSource(input.imageUrl);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return understandImageBytes({ bytes: loaded.image.bytes, mime: loaded.image.mime, query: input.query });
}

/** 当前有没有可用视觉模型（UI / 工具层用来决定是否提示） */
export function hasVisionTarget(): boolean {
  return pickVisionTarget() !== null;
}

/** 当前视觉模型的名字，例如「OpenAI · gpt-4o」；没有就返回 null */
export function visionTargetLabel(): string | null {
  const hit = pickVisionTarget();
  return hit ? `${hit.label} · ${hit.modelId}` : null;
}

/**
 * 出图之后的「视觉核对」：把刚生成的图交给视觉模型，客观描述画面上到底有什么。
 * 存在的意义 —— 主模型（DeepSeek 等纯文本）拿不到像素，只能靠这段文字确认
 * 「用户要的主体到底画出来没有」，而不是对着图片路径瞎猜或说「我无法确认」。
 */
export async function describeGeneratedImage(input: { imagePath: string; prompt: string }): Promise<UnderstandResult> {
  const target = input.prompt.trim().slice(0, 300);
  const query = [
    `这张图是按提示词「${target}」生成的。请只做客观描述，不要客套话：`,
    '1) 画面主体是什么、大概在什么位置；',
    '2) 背景与整体色调（冷 / 暖、亮 / 暗）；',
    '3) 构图与光线；',
    '4) 提示词里的主体是否真的出现在画面中 —— 没出现就直说「没有出现」。',
    '如果这只是一张模板化的风景 / 星空 / 渐变底图，而不是提示词里那个具体东西，请明确指出「这是模板画面，不是主体本身」。',
  ].join('\n');
  return understandImage({ imagePath: input.imagePath, query });
}

/** 顺手导出，给需要把图片落到临时文件的地方用（当前只在调试里用得上） */
export async function writeTempImage(dir: string, name: string, bytes: Buffer): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await fsp.writeFile(target, bytes);
  return target;
}
