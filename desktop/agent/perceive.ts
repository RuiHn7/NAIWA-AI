/* ============================================================================
 * desktop/agent/perceive.ts —— 软件内置的本机识图（不联网、不依赖任何外部模型）
 *
 * 分两步：
 *   1) perceive()：Electron nativeImage 解码，统计尺寸、明暗、对比度、饱和度、
 *      主色占比、上中下三段色彩、边缘密度、是不是大面积平滑（模板 / 截图 / 照片）。
 *   2) assessImage()：把像素统计 + 本机 OCR 读到的文字 + 图片生成历史合起来，
 *      判断「这是一张什么图」「图里写了什么」，产出一段能直接回答用户问题的
 *      识图报告（assessmentToText）。
 *
 * 语义理解由当前会话里已经在运行的主模型完成 —— 它本来就能读文字、能推断。
 * 本机只负责把图片翻译成**文字事实**：图里写了什么、是什么类型的图、若是软件
 * 自己生成的还知道当时的提示词。这样软件不需要用户接任何外部视觉模型就能识图。
 *
 * 边界（如实告知，不假装能做到）：纯像素认不出「一张无文字、也不是本软件生成的
 * 照片里具体是什么物体」。这种时候报告里让主模型请用户用一句话补充来历，
 * 而不是让用户去配置模型。
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

/* ----------------------------------------------------------------------------
 * 本机图像理解：把「像素事实 + OCR 文字 + 生成历史」组织成能直接回答
 * 「这是什么 / 里面有没有文字」的识图报告。
 * -------------------------------------------------------------------------- */

export interface ImageAssessment {
  kind:
    | 'generated'
    | 'error'
    | 'code'
    | 'web'
    | 'document'
    | 'text-image'
    | 'photo'
    | 'illustration'
    | 'template'
    | 'blank'
    | 'unknown';
  /** 一句话说清「这是一张什么图」 */
  label: string;
  /** 结论段，可直接用来回答「这是什么」 */
  summary: string;
  /** 支撑结论的依据 */
  clues: string[];
  /** 外观附录（尺寸 / 明暗 / 主色 / 构图） */
  appearance: string;
  ocrText: string;
  ocrLines: number;
  /** 本机 OCR 引擎是否可用（非 Windows / 调用失败时为 false） */
  ocrAvailable: boolean;
  source: string;
  query: string;
}

function countHits(text: string, needles: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const s of needles) if (lower.includes(s)) n += 1;
  return n;
}

/**
 * 综合判断。文字线索优先 —— 桌面 Agent 用户贴的最多的是截图 / 报错 / 文档，
 * OCR 读出来的内容比任何像素统计都更能回答「这是什么」。
 * 没有文字时才退回到版面 / 色彩判断，并且只说能确定的部分。
 */
export function assessImage(input: {
  percept: Percept | null;
  ocrText?: string;
  ocrLines?: number;
  ocrAvailable?: boolean;
  source?: string | null;
  query?: string;
}): ImageAssessment {
  const p = input.percept;
  const ocrText = (input.ocrText ?? '').trim();
  const lines = ocrText ? ocrText.split(/\n+/).map(s => s.trim()).filter(Boolean) : [];
  const ocrLines = input.ocrLines ?? lines.length;
  const ocrAvailable = input.ocrAvailable !== false;
  const source = (input.source ?? '').trim();
  const query = (input.query ?? '').trim();
  const noText = ocrAvailable ? '没有识别到文字' : '本机 OCR 在这台设备上不可用，没能读取文字';
  const clues: string[] = [];
  let kind: ImageAssessment['kind'] = 'unknown';
  let label = '一张图片';
  let summary = '';

  const paper = !!p && p.brightness > 0.8 && (p.colors[0]?.ratio ?? 0) > 0.5 && p.saturation < 0.16;

  if (source) {
    kind = 'generated';
    label = '本软件生成的图片';
    summary = '这是 NAI WA 自己生成的图，不是用户从外部贴进来的照片。画面主体以生成时的提示词为准。';
    clues.push('按文件路径回查了本机的图片生成历史，找到了当时的生成记录与提示词。');
  } else if (ocrText) {
    const errHits = countHits(ocrText, [
      'error', 'exception', 'traceback', 'failed', 'failure', 'fatal', 'panic', 'undefined',
      'not found', 'enoent', 'eaddrinuse', 'stack trace', 'cannot read', 'npm err',
      '报错', '异常', '失败', '无法', '找不到', '未定义', '超时', '拒绝访问', '404', '500', '502',
    ]);
    const codeHits = countHits(ocrText, [
      'function', 'const ', 'let ', 'var ', 'import ', 'export ', '=>', 'def ', 'class ',
      '#include', 'package ', 'npm ', 'git ', 'python', ';', '{', '}', '<div', '</', '===', '[', ']',
    ]);
    const webHits = countHits(ocrText, [
      'http://', 'https://', 'www.', '.com', '.cn', '登录', '注册', '搜索', '首页', '设置', '提交', '下一页',
    ]);
    if (errHits >= 1) {
      kind = 'error';
      label = '报错 / 异常信息截图';
      summary = '图里是一段报错或异常信息。下面「图里的文字」是本机 OCR 读出的原文，可直接据此解释错误原因。';
      clues.push(`文字里出现 ${errHits} 处报错 / 异常关键词（Error、Exception、Traceback、failed、错误码等）。`);
    } else if (codeHits >= 4 || (codeHits >= 2 && /^\s*(import |from .+ import|def |class |function |const |let |var |#include|package )/m.test(ocrText))) {
      kind = 'code';
      label = '代码 / 终端 / 命令行截图';
      summary = '图里主要是代码或终端输出。下面「图里的文字」是本机 OCR 读出的原文（可能有错字），可据此理解内容。';
      clues.push(`文字里出现 ${codeHits} 处代码特征（关键字、括号、分号等）。`);
    } else if (webHits >= 1 && ocrLines >= 3) {
      kind = 'web';
      label = '网页 / 应用界面截图';
      summary = '这是一张网页或应用界面的截图，图里的文字已由本机 OCR 读出，见下方。';
      clues.push(`文字里出现 ${webHits} 处网址 / 界面控件词，共 ${ocrLines} 行，符合界面截图特征。`);
    } else if (ocrLines >= 6) {
      kind = 'document';
      label = '文档 / 图文 / 界面截图';
      summary = `这是一张以文字为主的图片，本机 OCR 读到 ${ocrLines} 行文字（全文见下方），可据此概括内容。`;
      clues.push(`OCR 读到 ${ocrLines} 行文字，信息密度较高，更像文档、聊天记录或界面截图。`);
    } else {
      kind = 'text-image';
      label = '带文字的图片 / 截图';
      summary = `图里有少量文字，本机 OCR 读到 ${ocrLines} 行（全文见下方）。`;
      clues.push(`OCR 读到 ${ocrLines} 行文字。`);
    }
  } else if (!p) {
    kind = 'unknown';
    label = '无法解码的图片';
    summary = '本机没能解开这张图片的数据，无法给出画面信息。';
  } else if (p.flat && paper) {
    kind = 'blank';
    label = '白底 / 空白文档 / 极简界面';
    summary = `画面大面积是白底、几乎没有细节，${noText} —— 更像空白画布、空白文档或极简界面。`;
    clues.push(`白底占比高、边缘密度很低、饱和度低；${noText}。`);
  } else if (p.flat) {
    kind = 'template';
    label = '模板底图 / 渐变 / 扁平图形';
    summary = `画面以大面积平滑色块或渐变为主，${noText}，也没有可辨认的具体物体 —— 更像背景底图、渐变或扁平图形。`;
    clues.push('主色占比很高、边缘密度很低，符合模板 / 渐变底图特征。');
  } else if (p.accent && p.edge < 0.08) {
    kind = 'illustration';
    label = '插画 / 图形设计';
    summary = `画面里有明显的色块与结构，${noText}；从色彩看更像插画或图形设计，而不是写实照片。最显眼的是${p.accent.name}（${p.accent.hex}）。`;
    clues.push(`除背景外有一块显著的${p.accent.name}，边缘密度 ${(p.edge * 100).toFixed(2)}%，结构偏简洁。`);
  } else {
    kind = 'photo';
    label = '照片 / 细节丰富的画面';
    summary = `画面细节较多、${noText}；本机只能判断它的色彩与构图，认不出具体是什么物体，可请用户用一句话补充来历或想确认的内容。`;
    clues.push(`边缘密度 ${(p.edge * 100).toFixed(2)}%、平均饱和度 ${pct(p.saturation)}，细节分布更像照片或复杂画面。`);
  }

  if (p) {
    if (paper && ocrText) clues.push('大面积白底 + 文字，符合文档 / 网页 / 界面截图的版面特征。');
    if (p.accent && kind !== 'illustration') {
      clues.push(`除背景外还有一块显著的${p.accent.name}（${p.accent.hex}，约 ${pct(p.accent.ratio)}），可能是主体或强调色。`);
    }
  }

  const appearance = p
    ? [
        `尺寸 ${p.width}×${p.height}，${p.height > p.width * 1.05 ? '竖图' : p.width > p.height * 1.05 ? '横图' : '方图'}`,
        `明暗：${tone(p)}`,
        `主色：${p.colors.map(c => `${c.name} ${c.hex}（${pct(c.ratio)}）`).join('；')}`,
        `三段色彩：上 ${p.bands.top} / 中 ${p.bands.mid} / 下 ${p.bands.bottom}`,
        edgeText(p),
      ].join('\n- ')
    : '本机没能解出像素数据。';

  return { kind, label, summary, clues, appearance, ocrText, ocrLines, ocrAvailable, source, query };
}

/**
 * 识图报告。除了事实，还带一段给主模型的使用说明 —— 这样它不会再把
 * 「本机像素分析」照抄成「我只能给外观、要真正认出得接识图模型」。
 */
export function assessmentToText(a: ImageAssessment): string {
  const out: string[] = [];
  out.push('识图结果（软件内置 · 本机完成，不联网、不需要配置任何视觉模型）：');
  out.push('');
  out.push(`【结论】${a.label}。${a.summary}`);
  if (a.source) {
    out.push('');
    out.push(`【来历】${a.source}`);
  }
  out.push('');
  out.push('【判断依据】');
  for (const c of a.clues) out.push(`- ${c}`);
  out.push('');
  if (a.ocrText) {
    out.push(`【图里的文字】本机 OCR 读到 ${a.ocrLines} 行（Windows 自带识别引擎，离线，可能有错字）：`);
    out.push(a.ocrText);
  } else if (a.ocrAvailable) {
    out.push('【图里的文字】本机 OCR 没有识别到文字。');
  } else {
    out.push('【图里的文字】本机 OCR 在这台设备上不可用，因此没有读取文字；下面的画面外观仍然有效。');
  }
  out.push('');
  out.push('【画面外观】');
  out.push(`- ${a.appearance}`);
  out.push('');
  out.push('【怎么回答用户】');
  out.push('- 上面这些是软件从图片里读到的**事实**：图里写了什么、是什么类型的图、如果是本软件生成的还知道当时的提示词。直接基于它们理解并回答用户；禁止说「我看不了图」「无法确认」「需要接入视觉模型」「请到设置里选识图模型」。');
  out.push('- 用户问「这是什么」→ 用【结论】【来历】和【图里的文字】作答；文字内容足够时，直接据此概括主题、解释报错、总结要点 —— 这就是软件在理解用户要什么。');
  out.push('- 用户问「里面有没有文字 / 写了什么」→ 直接引用【图里的文字】的原文，并说明是本机 OCR 离线读出的。');
  out.push('- 用户问「你是怎么识图的」→ 如实说明：软件先用本机解码与像素统计判断图像类型和版面，再用 Windows 自带的离线 OCR 读出图中文字，如果这张图是软件自己生成的还会回查图片历史拿到当时的提示词；这些文字事实交给当前对话的主模型来理解并回答。整个过程不联网、不需要用户接任何外部视觉模型。');
  out.push('- 本机无法凭像素认出「一张没有文字、也不是本软件生成的照片里具体是什么物体」。遇到这种情况，如实说明能确定的部分（类型、色调、构图），并请用户用一句话补充它的来历或想确认什么，不要让用户去配置模型。');
  if (a.query) out.push(`- 用户这次的原话是「${a.query.slice(0, 80)}」，优先回答这个问题。`);
  return out.join('\n');
}
