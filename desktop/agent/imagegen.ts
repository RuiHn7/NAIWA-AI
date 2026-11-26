/* ============================================================================
 * desktop/agent/imagegen.ts —— 图片生成（OpenAI Images / Stability / SD WebUI / ComfyUI）
 * 产物一律落到当前工作区；没有工作区时落应用数据目录 images/。
 * ==========================================================================*/

import type { GeneratedImage, ImageProviderConfig } from '@shared/types';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listImageProviders, getImageProvider, getImageProviderKey, addImages } from '../store/images';
import { getWorkspace } from '../store/workspaces';
import { getChat } from '../store/chats';
import { chatArtifacts, images as imagesDir, workspaceArtifacts } from '../store/paths';
import { paintImage, pickTheme, themeLabel } from './paint';

export interface GenerateImagesInput {
  prompt: string;
  negativePrompt?: string;
  size: string;
  count: number;
  style: string;
  workspaceId: string | null;
  /** 当前会话的磁盘文件夹；有值时图片落 `<会话目录>/artifacts/images` */
  chatFolder?: string | null;
  /** 发起生成的会话 id，记进历史，右栏可按会话过滤 */
  chatId?: string | null;
  providerId?: string;
}

const STYLE_SUFFIX: Record<string, string> = {
  none: '',
  photo: ', photorealistic, natural lighting, 50mm lens, high detail',
  cinematic: ', cinematic lighting, dramatic composition, film grain',
  anime: ', anime style, clean line art, vibrant colors',
  watercolor: ', watercolor painting, soft edges, paper texture',
  '3d': ', 3d render, soft studio lighting, octane',
  flat: ', flat vector illustration, minimal palette',
};

function targetDir(workspaceId: string | null, chatFolder?: string | null, chatId?: string | null): string {
  // 优先级：会话文件夹 → 工作区 → 应用数据目录。
  // 产物跟着会话走，用户点会话卡片上的「打开产物文件夹」就能直接看到。
  const folder = chatFolder ?? (chatId ? getChat(chatId)?.folder ?? null : null);
  const ws = workspaceId ? getWorkspace(workspaceId) : null;
  const dir = folder
    ? path.join(chatArtifacts(folder), 'images')
    : ws
      ? path.join(workspaceArtifacts(ws.path), 'images')
      : path.join(imagesDir(), 'generated');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function saveBase64(dir: string, base64: string, index: number): Promise<{ path: string; url: string }> {
  const file = path.join(dir, `gen-${Date.now()}-${index}.png`);
  await fsp.writeFile(file, Buffer.from(base64, 'base64'));
  return { path: file, url: `file://${file.replace(/\\/g, '/')}` };
}

async function saveUrl(dir: string, url: string, index: number): Promise<{ path: string; url: string }> {
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = /\.(png|jpe?g|webp)$/i.exec(new URL(url).pathname)?.[1] ?? 'png';
  const file = path.join(dir, `gen-${Date.now()}-${index}.${ext}`);
  await fsp.writeFile(file, buffer);
  return { path: file, url: `file://${file.replace(/\\/g, '/')}` };
}

function pickProvider(providerId?: string): ImageProviderConfig {
  const all = listImageProviders().filter(p => p.enabled);
  if (providerId) {
    const hit = all.find(p => p.id === providerId) ?? null;
    if (hit) return hit;
    if (providerId === BUILTIN_PROVIDER.id) return BUILTIN_PROVIDER;
  }
  // 永远有兜底：没有启用任何后端、或指定的后端不存在时，用内置渲染
  return all[0] ?? BUILTIN_PROVIDER;
}

/**
 * 内置渲染后端：不出现在接入项列表里，但永远可用。
 * 没有启用任何图片后端、或者启用的后端报错时，都会回退到它 ——
 * 这样「无法生成图片」这句话在 NAI WA 里不会再出现。
 */
export const BUILTIN_PROVIDER: ImageProviderConfig = {
  id: 'builtin',
  kind: 'builtin',
  label: '内置渲染',
  baseUrl: '',
  hasKey: false,
  enabled: true,
  createdAt: 0,
};

/** 把 "1024x1024" 拆成像素；正方形以外的尺寸给内置渲染用 */
function parseSize(size: string): { width: number; height: number } {
  const m = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i.exec(size ?? '');
  if (!m) return { width: 1024, height: 1024 };
  return { width: Number(m[1]) || 1024, height: Number(m[2]) || 1024 };
}

/* --------------------------------------------------------------- 能力预检
 * 很多「OpenAI 兼容」的文本厂商（DeepSeek / Moonshot / 通义 …）根本没有
 * /images/generations，直连过去只会拿到一个 404 Not Found，用户完全看不出
 * 是自己把 Base URL 填错了。这里先按域名判一次，给出能照着改的提示。
 * --------------------------------------------------------------------- */
const TEXT_ONLY_HOSTS: { match: RegExp; name: string; hint: string }[] = [
  { match: /(^|\.)deepseek\.com$/i, name: 'DeepSeek', hint: 'DeepSeek 只有文本接口，没有图片生成能力。' },
  { match: /(^|\.)moonshot\.(cn|ai)$/i, name: 'Moonshot', hint: 'Moonshot（Kimi）不提供图片生成接口。' },
  {
    match: /(^|\.)dashscope\.aliyuncs\.com$/i,
    name: '阿里云百炼',
    hint: '百炼的通义千问文本接口不在这里出图，通义万相要走 DashScope 自己的异步任务接口。',
  },
  { match: /(^|\.)volces\.com$/i, name: '火山方舟', hint: '火山方舟的文本与图像是两套不同的接入点。' },
  { match: /(^|\.)bigmodel\.cn$/i, name: '智谱', hint: '智谱的文本与图像（CogView）是两套不同的接入点。' },
];

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

/** 返回一句「这个后端不适合生图」的说明；能生图就返回 null。 */
function unsupportedReason(provider: ImageProviderConfig): string | null {
  const host = hostOf(provider.baseUrl);
  if (!host) return `这个接入项的地址不是合法的 http(s) URL：${provider.baseUrl}。请到「设置 → 图片生成」里改掉。`;
  if (provider.kind !== 'openai') return null;
  const hit = TEXT_ONLY_HOSTS.find(t => t.match.test(host));
  if (!hit) return null;
  return [
    `当前图片后端「${provider.label}」指向 ${host}，${hit.hint}`,
    `所以请求 ${provider.baseUrl.replace(/\/+$/, '')}/images/generations 必然返回 404 Not Found —— 这不是网络问题，是这个地址根本没有这个接口。`,
    '要到「设置 → 图片生成」里换一个真正能出图的后端：OpenAI 官方（https://api.openai.com/v1）、Stability（https://api.stability.ai），或者本地跑着的 SD WebUI（http://127.0.0.1:7860）/ ComfyUI（http://127.0.0.1:8188）。',
  ].join('\n');
}

/** 把厂商返回的原始错误翻译成人能看懂的一句话 */
function explainHttpError(status: number, body: string, provider: ImageProviderConfig): string {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 240);
  if (status === 404) {
    return [
      `HTTP 404 —— ${provider.baseUrl.replace(/\/+$/, '')} 上没有这个接口。`,
      '说明这个接入项的 Base URL 不是图片生成服务（文本类厂商、或是漏写了 /v1 之类的路径）。',
      '可以到「设置 → 图片生成」里核对地址，或者换成本地 SD WebUI / ComfyUI。',
      `原始返回：${snippet}`,
    ].join('\n');
  }
  if (status === 401 || status === 403) {
    return `HTTP ${status} —— API Key 无效或没有出图权限。到「设置 → 图片生成」里重新填一次 Key。原始返回：${snippet}`;
  }
  if (status === 429) return `HTTP 429 —— 触发限流或余额不足。原始返回：${snippet}`;
  return `HTTP ${status} ${snippet}`;
}

export interface GenerateResult {
  ok: boolean;
  images?: GeneratedImage[];
  error?: string;
  /** 走内置渲染时的说明（含降级原因），工具层会拼进返回文案 */
  note?: string;
  /** 真正干活的后端：builtin 表示本地程序化渲染 */
  provider?: string;
}

export async function generateImages(input: GenerateImagesInput): Promise<GenerateResult> {
  const provider = pickProvider(input.providerId);
  const dir = targetDir(input.workspaceId, input.chatFolder, input.chatId);
  const count = Math.max(1, Math.min(4, input.count || 1));

  /* ------------------------------------------------ 内置渲染：直接画，不联网 */
  const paint = (why: string): GenerateResult => {
    const { width, height } = parseSize(input.size);
    const files: { path: string; url: string }[] = [];
    let theme = pickTheme(input.prompt);
    for (let i = 0; i < count; i += 1) {
      const out = paintImage(dir, { prompt: input.prompt, width, height }, i);
      theme = out.theme;
      files.push({ path: out.path, url: `file://${out.path.replace(/\\/g, '/')}` });
    }
    const record: GeneratedImage = {
      id: randomUUID(),
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      size: `${width}x${height}`,
      style: input.style,
      count: files.length,
      files,
      providerId: BUILTIN_PROVIDER.id,
      createdAt: Date.now(),
      workspaceId: input.workspaceId,
      chatId: input.chatId ?? null,
    };
    addImages([record]);
    return { ok: true, images: [record], note: why, provider: `builtin:${themeLabel(theme)}` };
  };

  if (provider.kind === 'builtin') return paint('内置渲染');

  const unsupported = unsupportedReason(provider);
  if (unsupported) {
    // 后端明显不可用：不再回一句「无法生成图片」，直接用内置渲染顶上
    return paint(unsupported);
  }

  const apiKey = getImageProviderKey(provider.id) ?? '';
  const prompt = input.prompt + (STYLE_SUFFIX[input.style] ?? '');
  const base = provider.baseUrl.replace(/\/+$/, '');
  let lastError = '';

  try {
    let files: { path: string; url: string }[] = [];

    if (provider.kind === 'openai') {
      const response = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-image-1', prompt, n: count, size: input.size, response_format: 'b64_json' }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) {
        const text = await response.text();
        lastError = explainHttpError(response.status, text, provider);
        return paint(lastError);
      }
      const json: any = await response.json();
      const items: any[] = json.data ?? [];
      let i = 0;
      for (const item of items) {
        if (item.b64_json) files.push(await saveBase64(dir, item.b64_json, i));
        else if (item.url) files.push(await saveUrl(dir, item.url, i));
        i += 1;
      }
    } else if (provider.kind === 'stability') {
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('output_format', 'png');
      if (input.negativePrompt) form.append('negative_prompt', input.negativePrompt);
      const response = await fetch(`${base}/v2beta/stable-image/generate/core`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'image/*' },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) {
        const text = await response.text();
        lastError = explainHttpError(response.status, text, provider);
        return paint(lastError);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const file = path.join(dir, `gen-${Date.now()}-0.png`);
      await fsp.writeFile(file, buffer);
      files.push({ path: file, url: `file://${file.replace(/\\/g, '/')}` });
    } else if (provider.kind === 'sdwebui') {
      const response = await fetch(`${base}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, negative_prompt: input.negativePrompt ?? '', width: Number(input.size.split('x')[0]) || 1024, height: Number(input.size.split('x')[1]) || 1024, batch_size: count }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) {
        const text = await response.text();
        lastError = explainHttpError(response.status, text, provider);
        return paint(lastError);
      }
      const json: any = await response.json();
      const list: string[] = json.images ?? [];
      let i = 0;
      for (const b64 of list) {
        files.push(await saveBase64(dir, b64.replace(/^data:image\/\w+;base64,/, ''), i));
        i += 1;
      }
    } else {
      // ComfyUI：走最简 workflow 提交 + 轮询 history
      const workflow = {
        3: { class_type: 'KSampler', inputs: { seed: Math.floor(Math.random() * 1e9), steps: 24, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
        4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
        5: { class_type: 'EmptyLatentImage', inputs: { width: Number(input.size.split('x')[0]) || 1024, height: Number(input.size.split('x')[1]) || 1024, batch_size: count } },
        6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
        7: { class_type: 'CLIPTextEncode', inputs: { text: input.negativePrompt ?? '', clip: ['4', 1] } },
        8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
        9: { class_type: 'SaveImage', inputs: { filename_prefix: 'naiwa', images: ['8', 0] } },
      };
      const post = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!post.ok) return paint(`ComfyUI 提交失败 HTTP ${post.status}，已改用内置渲染。`);
      const created: any = await post.json();
      const id: string = created.prompt_id;
      let done: any = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise(r => setTimeout(r, 2000));
        const hist = await fetch(`${base}/history/${id}`, { signal: AbortSignal.timeout(20_000) });
        const json: any = await hist.json();
        if (json[id]?.outputs) {
          done = json[id];
          break;
        }
      }
      if (!done) return paint('ComfyUI 生成超时，已改用内置渲染。');
      const outputs = done.outputs as Record<string, any>;
      let i = 0;
      for (const node of Object.values(outputs)) {
        for (const img of (node.images ?? []) as any[]) {
          const src = `${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? '')}&type=${img.type ?? 'output'}`;
          files.push(await saveUrl(dir, src, i));
          i += 1;
        }
      }
    }

    if (!files.length) return paint('接口没有返回图片数据，已改用内置渲染。');

    const record: GeneratedImage = {
      id: randomUUID(),
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      size: input.size,
      style: input.style,
      count: files.length,
      files,
      providerId: provider.id,
      createdAt: Date.now(),
      workspaceId: input.workspaceId,
      chatId: input.chatId ?? null,
    };
    addImages([record]);
    return { ok: true, images: [record], provider: provider.label };
  } catch (err) {
    // 网络不通 / 超时 / 解析失败：同样降级到内置渲染，而不是回一句「无法生成图片」
    return paint(`${(err as Error).message}，已改用内置渲染。`);
  }
}
