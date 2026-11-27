/* ============================================================================
 * desktop/agent/vision.ts —— 识图（软件内置能力，主模型是纯文本也能用）
 *
 * 主路径永远是**本机识图**：
 *   · 回查图片生成历史（本软件生成的图知道当时的提示词与主体）
 *   · 像素分析（尺寸 / 明暗 / 主色 / 版面）
 *   · Windows 自带 OCR 离线读出图中文字
 *   三者合成一段「识图报告」，交给当前会话里已经在跑的主模型理解并回答。
 *   本机路径不需要 Key，也不需要用户额外配置视觉模型（想更准可以另接多模态）。
 *
 * 可选增强：若用户在设置里额外指定了多模态模型，会在本机识图结果之上
 * 再叠加一段该模型的画面描述；外部调用失败也不影响本机识图结果。
 *
 * 三种来源都收：
 *   · 本地绝对路径（用户贴图落盘后的附件）
 *   · http(s) 图片链接（工具入参 image_url 直接给链接）
 *   · data URL（粘贴的截图 / 上游直接给 base64）
 * 统一收敛成 bytes + mime，避免 anthropic / gemini 分支把非 data URL 的
 * 字符串当 base64 解出来是坏数据。
 * ==========================================================================*/

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, nativeImage } from 'electron';
import type { ProviderKind } from '@shared/types';
import type { LlmMessage } from '../llm/types';
import { streamFor } from '../llm/registry';
import { getProviderApiKey, listProviders } from '../store/providers';
import { getChat } from '../store/chats';
import { getSettings } from '../store/settings';
import { listImages } from '../store/images';
import { detectSubject } from './scene';

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
  /** 识图得到的文字报告（本机识图为主，可叠加可选多模态模型的描述） */
  text?: string;
  /** 本机 OCR 读到的原文；上层用它校正视觉模型对「图中文字」的误判 */
  ocrText?: string;
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

/**
 * 软件内置的本机识图 —— 主路径，任何时候都可用，不需要任何外部服务。
 * 把「生成历史 + 像素统计 + 离线 OCR」合成一段识图报告，交给主模型理解并回答。
 * 这三样都由软件自身在本机完成。
 */
async function localUnderstand(input: { bytes: Buffer; mime: string; query: string; sourcePath?: string }): Promise<UnderstandResult> {
  const { perceive, assessImage, assessmentToText } = await import('./perceive');
  const { ocrImageFile } = await import('./ocr');
  const { classifyImage, classifyToText } = await import('./classify');

  // 1) 本软件生成的图：历史里有提示词，直接说清「这是什么」
  const source = lookupGenerated(input.sourcePath);
  // 2) 识别模型：离线 1000 类物体识别（回答「这是什么」的主力）
  const cls = await classifyImage({ bytes: input.bytes });
  const classified = cls.ok && cls.top?.length ? classifyToText(cls.top, input.query) : '';
  // 3) 像素层：色彩 / 明暗 / 构图
  const percept = perceive({ bytes: input.bytes });

  // 3) 文字层：Windows 自带 OCR（离线）。优先用原始文件，字节来源则落成临时 PNG。
  let ocrTarget: string | null = null;
  if (input.sourcePath && /^file:\/\//i.test(input.sourcePath)) {
    const local = decodeURIComponent(input.sourcePath.replace(/^file:\/\//i, ''));
    if (fs.existsSync(local)) ocrTarget = local;
  } else if (input.sourcePath && !/^https?:\/\//i.test(input.sourcePath) && fs.existsSync(input.sourcePath)) {
    ocrTarget = input.sourcePath;
  }
  const tempFiles: string[] = [];
  if (!ocrTarget) {
    try {
      const img = nativeImage.createFromBuffer(input.bytes);
      if (!img.isEmpty()) {
        const tmp = path.join(app.getPath('temp'), `naiwa-ocr-${Date.now()}.png`);
        fs.writeFileSync(tmp, img.toPNG());
        ocrTarget = tmp;
        tempFiles.push(tmp);
      }
    } catch {
      /* 解不出图就不 OCR */
    }
  }

  let ocrText = '';
  let ocrLines = 0;
  let ocrAvailable = false;
  let ocrNote = '';
  if (ocrTarget) {
    const ocr = await ocrImageFile(ocrTarget);
    if (ocr.ok) {
      ocrAvailable = true;
      ocrText = tidyOcrText(ocr.text);
      ocrLines = ocr.lines;
    } else {
      ocrNote = `本机 OCR 不可用：${ocr.error ?? '未知原因'}`;
    }
  }
  for (const file of tempFiles) void fsp.unlink(file).catch(() => {});

  if (!percept && !source && !ocrText && !classified) {
    return { ok: false, error: `本机解不开这张图（${input.mime}）。可能是格式不支持或文件损坏；换一张 PNG / JPG 再试。` };
  }

  const assessment = assessImage({ percept, ocrText, ocrLines, ocrAvailable, source, query: input.query });
  let text = assessmentToText(assessment, classified);
  if (!classified && !cls.ok && cls.error) {
    text += `\n\n（识别模型这次没能加载：${cls.error}；像素与文字结果不受影响。）`;
  }
  if (ocrNote) text += `\n\n（${ocrNote}；其余识图结果不受影响。）`;
  const bits = ['识别模型', '像素', 'OCR'].filter((_, i) => (i === 0 ? !!classified : i === 1 ? !!percept : !!ocrAvailable));
  return {
    ok: true,
    text,
    ocrText: ocrText || undefined,
    provider: '本机',
    model: source ? `图片历史 + ${bits.join(' + ')}` : bits.join(' + '),
  };
}

/** 这张图是不是本软件生成的？按文件路径回查图片历史，拿到当时的提示词 */
function lookupGenerated(sourcePath?: string): string | null {
  if (!sourcePath || /^https?:\/\//i.test(sourcePath)) return null;
  const raw = /^file:\/\//i.test(sourcePath) ? decodeURIComponent(sourcePath.replace(/^file:\/\//i, '')) : sourcePath;
  let target = '';
  try {
    target = path.resolve(raw);
  } catch {
    return null;
  }
  for (const rec of listImages()) {
    const hit = rec.files.find(f => {
      try {
        return path.resolve(f.path) === target;
      } catch {
        return false;
      }
    });
    if (!hit) continue;
    const subject = detectSubject(rec.prompt);
    const when = new Date(rec.createdAt).toLocaleString('zh-CN', { hour12: false });
    const via = rec.providerId === 'builtin' ? '内置渲染' : rec.providerId;
    const lines = [
      `来源：这是 NAI WA 在 ${when} 自己生成的图（${via} · ${rec.size}）。`,
      `当时的提示词：「${rec.prompt}」`,
    ];
    if (subject.kind !== 'none') {
      lines.push(
        `按提示词，画面主体应是「${subject.label}」${subject.colorName ? `（${subject.colorName}）` : ''}；内置渲染画的是程序化插画，不是照片。`,
      );
    } else {
      lines.push('提示词里没有明确主体，画面是风景 / 氛围底图。');
    }
    return lines.join('\n');
  }
  return null;
}

/**
 * 识图主入口。三层能力，按这个顺序挑，任何一层失败都不影响下一层：
 *   1. 用户在设置里显式指定的多模态接入项（可选精度增强）
 *   2. 软件内置的本地视觉模型（Qwen2.5-VL-3B，离线，模型按需下载）
 *   3. 本机兜底：MobileNet 1000 类 + 像素分析 + Windows OCR + 生成历史反查
 * 永远返回一段可以据此回答的文字，不会出现「我看不了图」。
 */
export async function understandImageBytes(input: { bytes: Buffer; mime: string; query: string; sourcePath?: string }): Promise<UnderstandResult> {
  const { bytes, mime, query } = input;
  const local = await localUnderstand({ bytes, mime, query, sourcePath: input.sourcePath });
  const settings = getSettings();

  /** 把本地兜底报告和视觉模型描述合成一段 */
  const merge = (vlmText: string, vlmLabel: string): UnderstandResult => {
    // 视觉模型经常在「图中文字」这一行写「无」，而本机 OCR 明明读到了 —— 以 OCR 为准：
    // 有 OCR 原文时就把模型那一段剪掉，避免同一份报告里前后打架；没有 OCR 时保留模型的判断。
    const clean = local.ocrText ? vlmText.replace(/\n*图中文字[：:][\s\S]*$/, '').trimEnd() : vlmText;
    return {
      ok: true,
      text: `${clean.trim()}\n\n${local.ok ? local.text ?? '' : ''}`.trim(),
      ocrText: local.ocrText,
      provider: `本机视觉模型 · ${vlmLabel}`,
      model: local.ok ? '视觉模型 + 分类 + OCR' : '视觉模型',
    };
  };

  /* ---------- 1. 用户显式指定的多模态模型 ---------- */
  const hit = pickVisionTarget();
  const explicit = (settings.visionProviderId ?? '').trim().length > 0 && !!hit;
  if (hit && explicit) {
    const described = await requestVision(hit, bytes, mime, query);
    if (described.ok) {
      const vlm = `【画面描述（${hit.label} · ${hit.modelId}）】\n${described.text}`;
      return { ...merge(vlm, `${hit.label} · ${hit.modelId}`), provider: `本机 + ${hit.label}` };
    }
    // 外部模型失败：继续走内置本地视觉模型，别停在错误上
    const fallback = await tryLocalVlm(bytes, mime, query, settings.localVlm !== false);
    const note = `（多模态模型调用失败：${described.error}；已改用内置识图）`;
    if (fallback) return { ...merge(`${fallback.text}\n\n${note}`, fallback.label), provider: '本机视觉模型' };
    return local.ok ? { ...local, text: `${local.text}\n\n${note}` } : { ok: false, error: described.error };
  }

  /* ---------- 2. 内置本地视觉模型 ---------- */
  const builtin = await tryLocalVlm(bytes, mime, query, settings.localVlm !== false);
  if (builtin) return merge(builtin.text, builtin.label);

  /* ---------- 3. 兜底 + 可选增强（用户没显式指定，但有可用视觉接入项） ---------- */
  if (hit) {
    const described = await requestVision(hit, bytes, mime, query);
    if (described.ok) {
      const vlm = `【画面描述（${hit.label} · ${hit.modelId}）】\n${described.text}`;
      return { ...merge(vlm, `${hit.label} · ${hit.modelId}`), provider: `本机 + ${hit.label}` };
    }
    if (!local.ok) return { ok: false, error: described.error, provider: hit.label, model: hit.modelId };
  }

  return local.ok
    ? {
        ...local,
        text: `${local.text}\n\n（本地视觉模型未就绪，以上为本机分类 + OCR + 像素分析结果）`,
      }
    : local;
}

/** 调一次外部多模态模型，只拿描述文本；失败返回 ok:false，不抛异常 */
async function requestVision(
  hit: VisionHit,
  bytes: Buffer,
  mime: string,
  query: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
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
    return { ok: false, error: (err as Error).message };
  }
  return text.trim() ? { ok: true, text: text.trim() } : { ok: false, error: '模型没有返回内容' };
}

/** 内置本地视觉模型：没下载 / 关闭 / 失败都返回 null，绝不让主链路卡住 */
async function tryLocalVlm(
  bytes: Buffer,
  mime: string,
  query: string,
  enabled: boolean,
): Promise<{ text: string; label: string } | null> {
  if (!enabled) return null;
  try {
    const { describeWithLocalVlm, localVlmAvailable, localVlmLabel } = await import('./vlm');
    if (!localVlmAvailable()) return null;
    const result = await describeWithLocalVlm({ bytes, query: visionQuery(query) });
    if (!result.ok || !result.text) return null;
    const seconds = result.ms ? `（${(result.ms / 1000).toFixed(1)}s）` : '';
    return {
      text: `【画面描述（本地视觉模型 ${localVlmLabel()}，本机离线推理${seconds}）】\n${result.text}`,
      label: localVlmLabel(),
    };
  } catch {
    return null;
  }
}

/**
 * 给视觉模型的用户侧指令：只放用户这一问，格式要求全在 vlm.ts 的 system prompt 里。
 * 之前把「逐字抄出图中文字…」这类规则写进 user 消息，模型会把规则当成图里的文字抄出来。
 */
function visionQuery(query: string): string {
  return (query ?? '').trim() || '描述这张图片的内容。';
}

/**
 * Windows OCR 会把每个汉字之间塞一个空格（"和 对 话"），直接交给模型读起来费劲，
 * 也会让"逐字抄写"变成抄一堆空格。这里只收拾「汉字↔汉字」之间的空格和全角标点两侧，
 * 英文单词之间的空格原样保留。
 */
function tidyOcrText(text: string): string {
  return text
    .replace(/(\p{Script=Han})\s+(\p{Script=Han})/gu, '$1$2')
    .replace(/(\p{Script=Han})\s+([，。、；：？！）》」』])/gu, '$1$2')
    .replace(/([《「『（])\s+(\p{Script=Han})/gu, '$1$2')
    .replace(/(\p{Script=Han})\s+(\p{Script=Han})/gu, '$1$2');
}

/** 本地路径识图（会话附件走这里） */
export async function understandImage(input: { imagePath: string; query: string }): Promise<UnderstandResult> {
  const loaded = await loadImageSource(input.imagePath);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return understandImageBytes({ bytes: loaded.image.bytes, mime: loaded.image.mime, query: input.query, sourcePath: input.imagePath });
}

/** 任意来源识图（image_url：本地路径 / http(s) / data URL） */
export async function understandImageSource(input: { imageUrl: string; query: string }): Promise<UnderstandResult> {
  const loaded = await loadImageSource(input.imageUrl);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return understandImageBytes({ bytes: loaded.image.bytes, mime: loaded.image.mime, query: input.query, sourcePath: input.imageUrl });
}

/** 有没有额外的多模态模型可用于「精度增强」（本机识图不依赖它） */
export function hasVisionTarget(): boolean {
  return pickVisionTarget() !== null;
}

/** 可选的增强模型名字，例如「OpenAI · gpt-4o」；没有就返回 null */
export function visionTargetLabel(): string | null {
  const hit = pickVisionTarget();
  return hit ? `${hit.label} · ${hit.modelId}` : null;
}

/**
 * 出图之后的「视觉核对」：用软件内置的本机识图（可叠加可选的多模态模型）
 * 客观描述画面上到底有什么。
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
