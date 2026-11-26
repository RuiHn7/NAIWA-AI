/* ============================================================================
 * desktop/agent/perceive.ts —— 本机识图（像素级分析，不联网、不依赖外部模型）
 *
 * 用途：没有接视觉模型时，至少还能说清一张图「长什么样」——
 *   尺寸、明暗、对比度、饱和度、主色占比、上中下三段色彩、边缘密度、
 *   是不是大面积渐变（模板底图 / 截图 / 照片）。
 * 解码交给 Electron 的 nativeImage（PNG / JPEG / WebP / GIF / BMP 都吃），
 * 不引入任何第三方图像库。
 *
 * 边界要说清：这里**认不出语义**（不知道是猫还是桌子）。
 * 语义认知来自两处：① 内置渲染自己知道画了什么（scene 自述）；② 用户接入的视觉模型。
 * 输出文案里必须带上这句边界，避免主模型把「主色是灰」当成「图里有一只灰猫」。
 * ==========================================================================*/

import { nativeImage } from 'electron';

export interface ColorBucket {
  hex: string;
  name: string;
  /** 0-1 */
  ratio: number;
}

export interface Percept {
  width: number;
  height: number;
  /** 平均亮度 0-1 */
  brightness: number;
  /** 亮度标准差 0-1 */
  contrast: number;
  /** 平均饱和度 0-1 */
  saturation: number;
  /** 相邻像素平均梯度，0-1 */
  edge: number;
  colors: ColorBucket[];
  /** 除背景外最显眼的彩色块（面积 × 饱和度），没有就 null */
  accent: ColorBucket | null;
  bands: { top: string; mid: string; bottom: string };
  /** 是否大面积平滑（更像模板底图 / 渐变 / 纯色截图） */
  flat: boolean;
  /** 抽样像素数（有效，不含全透明） */
  sampled: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** 把 RGB 说成人话（色相 + 深浅），够用就行，不追求色卡精度 */
export function colorName(r: number, g: number, b: number): string {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = max === 0 ? 0 : d / max;
  if (sat < 0.1 || d < 0.04) {
    if (l < 0.12) return '近黑';
    if (l < 0.3) return '深灰';
    if (l < 0.55) return '中灰';
    if (l < 0.82) return '浅灰';
    return '近白';
  }
  let hue = 0;
  if (max === rn) hue = ((gn - bn) / d + 6) % 6;
  else if (max === gn) hue = (bn - rn) / d + 2;
  else hue = (rn - gn) / d + 4;
  hue *= 60;
  const base =
    hue < 15 || hue >= 345
      ? '红'
      : hue < 45
        ? '橙'
        : hue < 70
          ? '黄'
          : hue < 165
            ? '绿'
            : hue < 195
              ? '青'
              : hue < 255
                ? '蓝'
                : hue < 290
                  ? '紫'
                  : '品红';
  if (l < 0.2) return `深${base}`;
  if (l > 0.8) return `浅${base}`;
  return base;
}

interface Acc {
  r: number;
  g: number;
  b: number;
  n: number;
}

/** 解码任意常见图片并做统计；解不出来返回 null */
export function perceive(image: { bytes: Buffer } | { path: string }): Percept | null {
  let img: Electron.NativeImage;
  try {
    img = 'bytes' in image ? nativeImage.createFromBuffer(image.bytes) : nativeImage.createFromPath(image.path);
  } catch {
    return null;
  }
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  if (!size.width || !size.height) return null;

  // 统一缩到 ~192 宽再统计：几万像素足够稳，又不会卡住主线程
  const targetW = Math.min(192, size.width);
  const scaled = size.width > targetW ? img.resize({ width: targetW, quality: 'good' }) : img;
  const { width, height } = scaled.getSize();
  const bmp = scaled.toBitmap(); // BGRA
  if (!bmp || !bmp.length) return null;

  const buckets = new Map<number, Acc>();
  let sumL = 0;
  let sumL2 = 0;
  let sumSat = 0;
  let n = 0;
  const bandAcc = [
    { r: 0, g: 0, b: 0, n: 0 },
    { r: 0, g: 0, b: 0, n: 0 },
    { r: 0, g: 0, b: 0, n: 0 },
  ];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      const a = bmp[i + 3];
      if (a < 24) continue;
      const rn = r / 255;
      const gn = g / 255;
      const bn = b / 255;
      const l = 0.2126 * rn + 0.7152 * gn + 0.0722 * bn;
      sumL += l;
      sumL2 += l * l;
      const max = Math.max(rn, gn, bn);
      const min = Math.min(rn, gn, bn);
      sumSat += max === 0 ? 0 : (max - min) / max;
      n += 1;

      // 4bit/通道量化，减少桶数
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const acc = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      acc.r += r;
      acc.g += g;
      acc.b += b;
      acc.n += 1;
      buckets.set(key, acc);

      const band = y < height / 3 ? 0 : y < (height * 2) / 3 ? 1 : 2;
      bandAcc[band].r += r;
      bandAcc[band].g += g;
      bandAcc[band].b += b;
      bandAcc[band].n += 1;
    }
  }

  if (!n) return null;

  const brightness = sumL / n;
  const variance = Math.max(0, sumL2 / n - brightness * brightness);
  const contrast = Math.sqrt(variance);
  const saturation = sumSat / n;

  // 量化桶会把同一种颜色拆成好几个相邻桶（#43464C / #4A4C53…），先按色距合并再排名
  const raw = [...buckets.values()]
    .map(acc => ({ r: acc.r / acc.n, g: acc.g / acc.n, b: acc.b / acc.n, n: acc.n }))
    .sort((a, b) => b.n - a.n);
  const clusters: { r: number; g: number; b: number; n: number }[] = [];
  for (const c of raw) {
    const near = clusters.find(cl => Math.abs(cl.r - c.r) + Math.abs(cl.g - c.g) + Math.abs(cl.b - c.b) < 54);
    if (near) {
      const total = near.n + c.n;
      near.r = (near.r * near.n + c.r * c.n) / total;
      near.g = (near.g * near.n + c.g * c.n) / total;
      near.b = (near.b * near.n + c.b * c.n) / total;
      near.n = total;
    } else {
      clusters.push({ ...c });
    }
  }
  const colors: ColorBucket[] = clusters
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map(c => ({ hex: hex(c.r, c.g, c.b), name: colorName(c.r, c.g, c.b), ratio: c.n / n }));

  // 背景往往吃掉大半面积，主色全是灰。单独挑一个「面积 × 饱和度」最高的色块当显著色，
  // 这样「灰背景里有一只橘猫」至少能提示出「有一块橙色」。
  let accent: ColorBucket | null = null;
  let accentScore = 0;
  for (const c of clusters) {
    const max = Math.max(c.r, c.g, c.b) / 255;
    const min = Math.min(c.r, c.g, c.b) / 255;
    const sat = max === 0 ? 0 : (max - min) / max;
    const ratio = c.n / n;
    if (sat < 0.18 || ratio < 0.015) continue;
    const score = ratio * sat;
    if (score > accentScore) {
      accentScore = score;
      accent = { hex: hex(c.r, c.g, c.b), name: colorName(c.r, c.g, c.b), ratio };
    }
  }

  const bandText = bandAcc.map(acc => {
    if (!acc.n) return '透明';
    const r = acc.r / acc.n;
    const g = acc.g / acc.n;
    const b = acc.b / acc.n;
    return colorName(r, g, b);
  });

  // 边缘密度：水平 + 竖直相邻像素亮度差
  let edgeSum = 0;
  let edgeN = 0;
  const lumAt = (x: number, y: number): number => {
    const i = (y * width + x) * 4;
    return (0.2126 * bmp[i + 2] + 0.7152 * bmp[i + 1] + 0.0722 * bmp[i]) / 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const l0 = lumAt(x, y);
      if (x + 1 < width) {
        edgeSum += Math.abs(l0 - lumAt(x + 1, y));
        edgeN += 1;
      }
      if (y + 1 < height) {
        edgeSum += Math.abs(l0 - lumAt(x, y + 1));
        edgeN += 1;
      }
    }
  }
  const edge = edgeN ? edgeSum / edgeN : 0;
  const flat = (colors[0]?.ratio ?? 0) > 0.62 && edge < 0.012;

  return {
    width: size.width,
    height: size.height,
    brightness: clamp01(brightness),
    contrast: clamp01(contrast),
    saturation: clamp01(saturation),
    edge,
    colors,
    accent,
    bands: { top: bandText[0], mid: bandText[1], bottom: bandText[2] },
    flat,
    sampled: n,
  };
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** 明暗 / 对比 / 饱和度的定性描述 */
function tone(p: Percept): string {
  const light = p.brightness < 0.18 ? '很暗' : p.brightness < 0.35 ? '偏暗' : p.brightness < 0.62 ? '中等亮度' : p.brightness < 0.82 ? '偏亮' : '很亮';
  const contrast = p.contrast < 0.08 ? '对比度低' : p.contrast < 0.18 ? '对比度中等' : '对比度强';
  const sat = p.saturation < 0.12 ? '几乎无彩色' : p.saturation < 0.3 ? '低饱和' : p.saturation < 0.55 ? '中等饱和' : '高饱和';
  return `${light}（平均亮度 ${pct(p.brightness)}），${contrast}，${sat}`;
}

function edgeText(p: Percept): string {
  const paper = p.brightness > 0.8 && (p.colors[0]?.ratio ?? 0) > 0.5 && p.saturation < 0.16;
  if (p.flat) {
    if (paper) {
      return `边缘密度 ${(p.edge * 100).toFixed(2)}%（很低）—— 大面积白底、文字稀疏，更像文档 / 网页 / 聊天界面截图，或一张空白画布`;
    }
    return `边缘密度 ${(p.edge * 100).toFixed(2)}%（很低）—— 大面积平滑色块/渐变，像模板底图、纯色背景或扁平插画，不像有丰富细节的照片`;
  }
  if (p.edge < 0.03) return `边缘密度 ${(p.edge * 100).toFixed(2)}%（偏低）—— 画面偏干净，线稿 / 插画 / 简洁界面都有可能`;
  if (p.edge < 0.08) return `边缘密度 ${(p.edge * 100).toFixed(2)}%（中等）—— 有明确结构，像普通照片或图文混排界面`;
  return `边缘密度 ${(p.edge * 100).toFixed(2)}%（偏高）—— 细节密集，像文字很多的截图、表格或复杂场景`;
}

/**
 * 生成给主模型看的描述。query 只用来决定是否额外提示「用户想问什么」，
 * 不影响统计本身 —— 本机分析没有语义，不假装能回答「图里是谁」。
 */
export function perceptToText(p: Percept, query?: string): string {
  const orientation = p.height > p.width * 1.05 ? '竖图' : p.width > p.height * 1.05 ? '横图' : '方图';
  const lines = [
    '本机像素分析（离线完成，未调用任何外部模型）：',
    `- 尺寸 ${p.width}×${p.height}，${orientation}`,
    `- 明暗：${tone(p)}`,
    `- 主色：${p.colors.map(c => `${c.name} ${c.hex}（${pct(c.ratio)}）`).join('；')}`,
    p.accent ? `- 除背景外最显眼的颜色：${p.accent.name} ${p.accent.hex}（约 ${pct(p.accent.ratio)}）` : '',
    `- 三段色彩：上 ${p.bands.top} / 中 ${p.bands.mid} / 下 ${p.bands.bottom}`,
    `- ${edgeText(p)}`,
  ];
  if (p.flat) {
    const paper = p.brightness > 0.8 && (p.colors[0]?.ratio ?? 0) > 0.5 && p.saturation < 0.16;
    lines.push(
      paper
        ? '- 判断：白底为主、细节很少 —— 更像文档 / 网页 / 界面截图或空白画布。'
        : '- 判断：这更像一张模板 / 渐变底图，而不是有明确主体的写实画面。',
    );
  }
  if (query && query.trim()) {
    lines.push(`（用户这条问题问的是「${query.trim().slice(0, 60)}」；本机分析只能回答色彩、明暗、构图这类问题。）`);
  }
  lines.push('能力边界：本机分析认不出具体物体和文字。要知道「这是什么 / 图里写了什么」，需要接入视觉模型（设置 → 接入模型 → 识图模型），或对内置渲染生成的图直接看它的画面自述。');
  return lines.join('\n');
}
