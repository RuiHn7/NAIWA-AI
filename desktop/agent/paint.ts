/* ============================================================================
 * desktop/agent/paint.ts —— 内置程序化出图（纯 Node，无任何外部依赖）
 *
 *   为什么需要它：
 *     很多「OpenAI 兼容」的文本厂商（DeepSeek / Moonshot / 通义 …）根本没有
 *     /images/generations；用户没接出图后端时，模型只能回一句「无法生成图片」。
 *     这里用 zlib + 手写 PNG 编码器，直接在本地把画面算出来 —— 只要进程活着就
 *     一定能出图，不依赖网络、不依赖 API Key、不依赖显卡。
 *
 *   能画什么（六种主题，按 prompt 自动挑）：
 *     night     夜空银河（山脊 + 星野）      dawn 类关键词才会命中
 *     dusk      黄昏 / 日落 / 夕阳 / 日出（暖色天空 + 太阳 + 云）
 *     day       白天晴空 / 云海（蓝天 + 白云 + 太阳光晕）
 *     landscape 山脊 / 森林 / 雪峰（白天山景）
 *     sea       海面 / 湖面（黄昏倒影 + 波光）
 *     studio    静物 / 产品 / 桌面（中性背景 + 主光）—— 任何主题都不铺星空
 *
 *   画不出什么：写实的人、动物、具体物体造型（那是扩散模型的活）。
 *
 *   渲染管线：线性光浮点缓冲 → fbm 噪声铺天空 → 云层 / 银河带 → 太阳光斑 →
 *   星点 PSF（只有夜间主题才画）→ 前景剪影 → 色调映射 / 饱和度 / 暗角 / 颗粒
 *   → sRGB 8bit → PNG。
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export type PaintTheme = 'night' | 'dusk' | 'day' | 'landscape' | 'sea' | 'studio';

export interface PaintInput {
  prompt: string;
  width: number;
  height: number;
  /** 不传就按 prompt + 时间生成 */
  seed?: number;
}

export interface PaintResult {
  path: string;
  width: number;
  height: number;
  theme: PaintTheme;
}

/* --------------------------------------------------------------- 随机与噪声 */

/** mulberry32：32 位状态，够快够均匀 */
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 整数格点哈希：同一坐标 + 同一 seed 永远给同一个 [0,1) */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smooth(xf);
  const v = smooth(yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, seed: number, octaves: number, gain = 0.5, lac = 2): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgb 长度必须是 width*height*3 */
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- 主题识别 */

/**
 * 关键词 → 主题。**顺序即优先级**：
 *   1. 夜景线索（夜景 / 霓虹 / 午夜）最先判定 —— 「赛博朋克城市夜景」不能因为「城市」被拉去画白天；
 *   2. 明确的星象词（银河 / 星空 / 繁星 / 极光），避免「银河」里的「河」被水景规则抢走；
 *   3. 太阳 / 静物 / 山野 / 水景 排在「白天 / 天空」前面，
 *      这样「雪峰森林清晨蓝天白云」会给出山景、「一轮明亮的太阳」不会被拉去画星空；
 *   4. 笼统的「星 / 夜」放最后兜底。
 */
const THEME_RULES: { match: RegExp; theme: PaintTheme }[] = [
  { match: /(夜景|夜色|夜幕|霓虹|午夜|月夜|星轨|night\s*view|night\s*scene|neon|cyberpunk)/i, theme: 'night' },
  { match: /(银河|星空|繁星|星河|流星|极光|星云|星座|milky\s*way|galaxy|nebula|aurora|astro)/i, theme: 'night' },
  { match: /(太阳|日出|日落|落日|夕阳|斜阳|朝阳|朝霞|晚霞|黄昏|暮色|黎明|余晖|霞光|sunset|sunrise|dusk|dawn|golden\s*hour)/i, theme: 'dusk' },
  { match: /(桌子|桌面|产品|静物|杯子|瓶子|椅子|花瓶|书本|几何|方块|球体|圆柱|极简|抽象|studio|product|still\s*life|desk|table|chair|vase|geometr|minimal)/i, theme: 'studio' },
  {
    match: /(山|峰|岭|松|林|雪|风景|野外|谷|坡|草|田野|花|树|建筑|城堡|房子|庭院|街道|小镇|沙漠|峡谷|瀑布|岛|mountain|ridge|peak|forest|valley|snow|landscape|field|grass|castle|building|street|desert|canyon|waterfall|island)/i,
    theme: 'landscape',
  },
  { match: /(海|湖|水|倒影|岸|滩|河川|河流|河面|河水|运河|sea|ocean|lake|water|reflect|shore|beach|river)/i, theme: 'sea' },
  { match: /(白天|晴朗|晴空|蓝天|多云|云海|白云|正午|清晨|上午|天空|day|daylight|blue\s*sky|cloud|noon|morning|sunny)/i, theme: 'day' },
  { match: /(星|夜|宇宙|太空|夜空|深夜|star|night|cosmos|space)/i, theme: 'night' },
];

/**
 * 先洗掉「不是画面主体、但会让关键词误判」的词：
 *   「海报」里的「海」会把一张人物海报判成海景，「星球大战」里的「星」会把海报判成星空。
 * 只做最小替换，不影响真正的主体词。
 */
function scrubForTheme(prompt: string): string {
  return prompt
    .replace(/海报|封面|宣传图|poster|banner/gi, ' ')
    .replace(/星球大战|星球|star\s*wars/gi, ' ')
    .replace(/\s+/g, ' ');
}

/** 明确的「大白天」线索：出现这些词时，就算同时提了太阳，也画白天而不是黄昏 */
const DAYLIGHT_HINT = /(白天|正午|上午|中午|晴朗|晴空|蓝天|晴好|blue\s*sky|noon|midday|daylight|sunny)/i;

export function pickTheme(prompt: string): PaintTheme {
  const text = scrubForTheme(prompt ?? '');
  for (const rule of THEME_RULES) {
    if (!rule.match.test(text)) continue;
    // 「正午蓝天 + 一轮太阳」是白天，不是黄昏：太阳这个词本身两边都成立，用白昼线索纠偏
    if (rule.theme === 'dusk' && DAYLIGHT_HINT.test(text)) return 'day';
    return rule.theme;
  }
  return 'studio';
}

/* ------------------------------------------------------------------ 色板 */

interface Palette {
  zenith: number[];
  mid: number[];
  low: number[];
  warm: number[];
  air: number[];
}

const PALETTES: Record<PaintTheme, Palette> = {
  night: {
    zenith: [0.0016, 0.0024, 0.0072],
    mid: [0.0032, 0.005, 0.0135],
    low: [0.0125, 0.0142, 0.0224],
    warm: [0.042, 0.031, 0.018],
    air: [0.03, 0.04, 0.06],
  },
  dusk: {
    zenith: [0.022, 0.016, 0.062],
    mid: [0.16, 0.062, 0.085],
    low: [0.62, 0.26, 0.1],
    warm: [0.95, 0.5, 0.16],
    air: [0.2, 0.1, 0.09],
  },
  day: {
    zenith: [0.035, 0.13, 0.38],
    mid: [0.11, 0.28, 0.6],
    low: [0.36, 0.56, 0.8],
    warm: [0.34, 0.34, 0.28],
    air: [0.3, 0.44, 0.6],
  },
  landscape: {
    zenith: [0.03, 0.12, 0.36],
    mid: [0.12, 0.3, 0.62],
    low: [0.4, 0.58, 0.8],
    warm: [0.4, 0.4, 0.34],
    air: [0.3, 0.44, 0.62],
  },
  sea: {
    zenith: [0.03, 0.07, 0.18],
    mid: [0.18, 0.22, 0.36],
    low: [0.72, 0.48, 0.32],
    warm: [0.9, 0.56, 0.26],
    air: [0.24, 0.26, 0.34],
  },
  studio: {
    zenith: [0.018, 0.019, 0.022],
    mid: [0.042, 0.045, 0.052],
    low: [0.088, 0.092, 0.102],
    warm: [0.12, 0.112, 0.1],
    air: [0.07, 0.074, 0.084],
  },
};

const HORIZON: Record<PaintTheme, number> = {
  night: 0.84,
  dusk: 0.72,
  day: 0.8,
  landscape: 0.78,
  sea: 0.62,
  studio: 0.7,
};

/* ------------------------------------------------------------------ 渲染器 */

interface Scene {
  lin: Float32Array;
  width: number;
  height: number;
}

/** 银河带：只在 night / dusk 用，strength 控制强弱 */
function paintGalaxy(
  lin: Float32Array,
  width: number,
  height: number,
  seed: number,
  rand: () => number,
  aspect: number,
  opts: { angleDeg: number; cx: number; cy: number; strength: number },
): void {
  const { strength } = opts;
  if (strength <= 0.01) return;
  const angle = opts.angleDeg * (Math.PI / 180);
  const cx = opts.cx;
  const cy = opts.cy;
  const sigma = 0.062 + rand() * 0.022;
  const curve = 0.09 + rand() * 0.08;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  // 核心偏暖（老恒星），外沿偏冷（年轻星团与电离气体）
  const tintCore = [1.0, 0.9, 0.74];
  const tintMid = [0.86, 0.84, 0.94];
  const tintOuter = [0.58, 0.7, 1.0];

  for (let y = 0; y < height; y += 1) {
    const vy = y / height - cy;
    for (let x = 0; x < width; x += 1) {
      const vx = (x / width - cx) * aspect;
      const along = vx * ca + vy * sa;
      const across = -vx * sa + vy * ca + curve * along * along;
      const band = Math.exp(-((across / sigma) ** 2));
      const halo = Math.exp(-((across / (sigma * 2.4)) ** 2)) * 0.34;
      const core = band + halo;
      if (core < 0.006) continue;

      // 大块云气团 + 高频颗粒（这两层一起才有「星尘」的质感，不然是一条灰带）
      const clump = fbm(vx * 3.4 + 3.1, vy * 3.4 + 7.7, seed + 71, 5, 0.55);
      const grain = fbm(vx * 30 + 11, vy * 30 + 5, seed + 301, 3, 0.55);
      // 尘埃带：沿银河拉长的噪声云，边缘不规则，不画硬边平行条
      const dustN = fbm(along * 1.8 + 21, across * 13 + 13, seed + 911, 4, 0.62);
      const dust = smooth(Math.max(0, Math.min(1, (dustN - 0.34) / 0.5)));

      const glow = (band * 0.5 + halo * 0.16) * (0.26 + 0.9 * clump) * (0.5 + 0.8 * grain);
      const light = glow * (1 - 0.9 * dust);
      if (light < 1e-5) continue;

      const idx = (y * width + x) * 3;
      // 三段配色：核心暖 → 中段灰紫 → 外沿冷蓝
      const tWarm = Math.max(0, Math.min(1, (band - 0.42) / 0.5));
      const tCool = Math.max(0, Math.min(1, (0.4 - band) / 0.4));
      for (let c = 0; c < 3; c += 1) {
        const base = tintMid[c] * (1 - tWarm) * (1 - tCool)
          + tintCore[c] * tWarm * (1 - tCool)
          + tintOuter[c] * tCool * (1 - tWarm);
        lin[idx + c] += light * base * 0.5 * strength;
      }
    }
  }

  // 沿银河额外撒一层密集小星，才是「一条星海」而不是「一条光带」
  const bandStars = Math.round(5200 * ((width * height) / (1024 * 1024)) * strength);
  for (let i = 0; i < bandStars; i += 1) {
    const along = (rand() * 2 - 1) * 1.35;
    // 三角分布撒到 2.6σ 范围，比只堆在中心更像星海
    const across = (rand() + rand() + rand() - 1.5) * sigma * 2.6;
    const vx = along * ca - across * sa;
    const vy = along * sa + across * ca;
    const px = (vx / aspect + cx) * width;
    const py = (vy + cy) * height;
    if (px < 0 || px >= width || py < 0 || py >= height) continue;
    const f = Math.pow(rand(), 5.5) * 0.42 * strength;
    if (f < 0.002) continue;
    const r = 0.62 + rand() * 0.28;
    const span = Math.ceil(r * 2);
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    for (let dy = -span; dy <= span; dy += 1) {
      const sy = iy + dy;
      if (sy < 0 || sy >= height) continue;
      for (let dx = -span; dx <= span; dx += 1) {
        const sx = ix + dx;
        if (sx < 0 || sx >= width) continue;
        const d2 = (sx + 0.5 - px) ** 2 + (sy + 0.5 - py) ** 2;
        const e = f * Math.exp(-d2 / (r * r * 0.55));
        if (e < 1e-5) continue;
        const idx = (sy * width + sx) * 3;
        lin[idx] += e;
        lin[idx + 1] += e * 0.93;
        lin[idx + 2] += e * 0.86;
      }
    }
  }
}

/** 云层：day / dusk / landscape / sea 用，越靠地平线越密 */
function paintClouds(
  lin: Float32Array,
  width: number,
  height: number,
  seed: number,
  rand: () => number,
  aspect: number,
  horizon: number,
  tint: number[],
  strength: number,
): void {
  const offA = rand() * 17;
  const offB = rand() * 23;
  const centerY = horizon * 0.52;
  const cutoff = Math.min(height, Math.ceil(horizon * height));
  for (let y = 0; y < cutoff; y += 1) {
    const ty = y / height;
    const band = Math.exp(-((ty - centerY) ** 2) / 0.075);
    if (band < 0.004) continue;
    for (let x = 0; x < width; x += 1) {
      const nx = (x / width) * aspect;
      const big = fbm(nx * 2.6 + offA, ty * 5.4 + offB, seed + 4021, 5, 0.55);
      const fine = fbm(nx * 9.5 + 5, ty * 17 + 9, seed + 8821, 4, 0.5);
      const v = big * 0.74 + fine * 0.26;
      const mask = smooth(Math.max(0, Math.min(1, (v - 0.5) / 0.32)));
      if (mask <= 0.002) continue;
      const a = mask * band * strength;
      if (a < 0.003) continue;
      const idx = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) lin[idx + c] += tint[c] * a;
    }
  }
}

/** 太阳 / 落日圆盘 + 大气光晕 */
function paintSun(
  lin: Float32Array,
  width: number,
  height: number,
  opts: { x: number; y: number; radius: number; core: number[]; glow: number[]; halo: number },
): void {
  const { x: cx, y: cy, radius, core, glow, halo } = opts;
  const reach = radius * 12;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(width - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(height - 1, Math.ceil(cy + reach));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      const dn = d / radius;
      // 圆盘边缘做一圈柔化，否则会出现「贴上去的硬边圆」那种假月亮感
      const disc = dn >= 1 ? 0 : smooth(Math.min(1, (1 - dn) / 0.22));
      // 光晕必须在包围盒边缘归零，否则会在矩形边界上留一道直边
      const fade = smooth(Math.min(1, Math.max(0, (reach - d) / (radius * 3))));
      if (fade <= 0) continue;
      const bloom = Math.exp(-((d / (radius * 2.6)) ** 2)) * halo * fade;
      const spread = Math.exp(-((d / (radius * 7)) ** 2)) * halo * 0.22 * fade;
      const e = disc * 1.0 + bloom + spread;
      if (e < 0.002) continue;
      const idx = (y * width + x) * 3;
      const tint = disc > 0.2 ? core : glow;
      for (let c = 0; c < 3; c += 1) lin[idx + c] += tint[c] * e;
    }
  }
}

function makeScene(width: number, height: number, seed: number, theme: PaintTheme): Scene {
  const lin = new Float32Array(width * height * 3);
  const rand = rng(seed);
  const aspect = width / height;
  const palette = PALETTES[theme];
  const horizon = HORIZON[theme];

  /* ------------------------------------------------------------ 天空底色 */
  for (let y = 0; y < height; y += 1) {
    const ty = y / Math.max(1, height - 1);
    const t = Math.min(1, ty / Math.max(0.001, horizon));
    // 天顶 → 中天 → 地平线
    const m0 = smooth(Math.min(1, t * 2));
    const m1 = smooth(Math.max(0, (t - 0.5) * 2));
    const base: number[] = [0, 0, 0];
    for (let c = 0; c < 3; c += 1) {
      base[c] = (palette.zenith[c] * (1 - m0) + palette.mid[c] * m0) * (1 - m1) + palette.low[c] * m1;
    }
    // 地平线暖色气辉 + 冷色空气光（有它山脊才看得出是剪影，而不是一坨黑）
    const glow = Math.exp(-((ty - horizon) ** 2) / 0.009) * 0.9 + Math.exp(-((ty - horizon) ** 2) / 0.05) * 0.22;
    const haze = Math.exp(-((ty - horizon) ** 2) / 0.02) * 0.9;
    const add: number[] = [0, 0, 0];
    for (let c = 0; c < 3; c += 1) {
      add[c] = palette.warm[c] * glow + palette.air[c] * haze;
      base[c] += add[c];
    }
    const rowBase = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const idx = rowBase + x * 3;
      lin[idx] = base[0];
      lin[idx + 1] = base[1];
      lin[idx + 2] = base[2];
    }
  }

  /* ------------------------------------------------------ 银河 / 抽象光晕 */
  if (theme === 'night') {
    paintGalaxy(lin, width, height, seed, rand, aspect, { angleDeg: 18 + rand() * 8, cx: 0.44 + rand() * 0.14, cy: 0.34 + rand() * 0.1, strength: 1 });
  } else if (theme === 'dusk') {
    // 天还没全黑，银河只剩一点点，位置压低
    paintGalaxy(lin, width, height, seed, rand, aspect, { angleDeg: 26, cx: 0.5, cy: 0.2, strength: 0.26 });
  }

  /* ---------------------------------------------------------------- 云层 */
  if (theme === 'day') {
    paintClouds(lin, width, height, seed, rand, aspect, horizon, [0.52, 0.56, 0.62], 0.9);
  } else if (theme === 'dusk') {
    paintClouds(lin, width, height, seed, rand, aspect, horizon, [0.86, 0.5, 0.32], 0.78);
  } else if (theme === 'landscape') {
    paintClouds(lin, width, height, seed, rand, aspect, horizon, [0.46, 0.5, 0.58], 0.55);
  } else if (theme === 'sea') {
    paintClouds(lin, width, height, seed, rand, aspect, horizon, [0.7, 0.46, 0.34], 0.42);
  }

  /* ------------------------------------------------------------ 太阳 / 主光 */
  if (theme === 'day') {
    paintSun(lin, width, height, {
      x: width * (0.72 + rand() * 0.1),
      y: height * 0.16,
      radius: Math.min(width, height) * 0.028,
      core: [1.0, 0.98, 0.9],
      glow: [0.86, 0.9, 1.0],
      halo: 0.55,
    });
  } else if (theme === 'dusk') {
    paintSun(lin, width, height, {
      x: width * (0.36 + rand() * 0.28),
      y: height * (horizon - 0.02),
      radius: Math.min(width, height) * 0.062,
      core: [1.0, 0.72, 0.34],
      glow: [1.0, 0.45, 0.16],
      halo: 1.15,
    });
  } else if (theme === 'studio') {
    // 静物：背景中心一团柔和主光（只有柔渐变，没有硬边圆盘 —— 否则会像个月亮）
    const cx = width * 0.5;
    const cy = height * 0.34;
    const radius = Math.min(width, height) * 0.62;
    const tint = [0.085, 0.088, 0.098];
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const d = Math.hypot((x - cx) / radius, (y - cy) / radius);
        if (d >= 1) continue;
        const falloff = (1 - d) ** 2.2 * 0.9;
        if (falloff < 0.002) continue;
        const idx = (y * width + x) * 3;
        for (let c = 0; c < 3; c += 1) lin[idx + c] += tint[c] * falloff;
      }
    }
  }

  /* ---------------------------------------------------------------- 星点 */
  const starProfile =
    theme === 'night'
      ? { layers: 3, flux: 1, cap: 0.86, sparkle: true }
      : theme === 'dusk'
        ? { layers: 1, flux: 0.16, cap: 0.5, sparkle: false }
        : null;

  if (starProfile) {
    const area = (width * height) / (1024 * 1024);
    const allLayers = [
      { count: Math.round(6200 * area), power: 7.5, flux: 0.34, radius: 0.85 },
      { count: Math.round(900 * area), power: 4.2, flux: 0.95, radius: 1.25 },
      { count: Math.round(70 * area), power: 2.2, flux: 2.6, radius: 2.0 },
    ];
    const layers = allLayers.slice(0, starProfile.layers);
    const brightest: { x: number; y: number; f: number }[] = [];

    for (const layer of layers) {
      for (let i = 0; i < layer.count; i += 1) {
        const x = rand() * width;
        const y = rand() * height * starProfile.cap;
        const f = Math.pow(rand(), layer.power) * layer.flux * starProfile.flux;
        if (f < 0.0025) continue;
        // 暖白 / 冷白 / 微蓝的星色
        const ct = rand();
        const cr = 1.0;
        const cg = 0.86 + ct * 0.14;
        const cb = 0.74 + ct * 0.26;
        const r = layer.radius;
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const span = Math.ceil(r * 2);
        for (let dy = -span; dy <= span; dy += 1) {
          const py = iy + dy;
          if (py < 0 || py >= height) continue;
          for (let dx = -span; dx <= span; dx += 1) {
            const px = ix + dx;
            if (px < 0 || px >= width) continue;
            const d2 = (px + 0.5 - x) ** 2 + (py + 0.5 - y) ** 2;
            const core = Math.exp(-d2 / (r * r * 0.62));
            const halo = Math.exp(-d2 / (r * r * 5)) * 0.05;
            const e = f * (core + halo);
            if (e < 1e-5) continue;
            const idx = (py * width + px) * 3;
            lin[idx] += e * cr;
            lin[idx + 1] += e * cg;
            lin[idx + 2] += e * cb;
          }
        }
        if (f > 1.1 && brightest.length < 12) brightest.push({ x, y, f });
      }
    }

    // 最亮的几颗画十字星芒
    if (starProfile.sparkle) {
      for (const star of brightest) {
        const len = Math.min(width, height) * (0.018 + rand() * 0.022);
        for (let d = 1; d < len; d += 1) {
          const fall = (1 - d / len) ** 2 * star.f * 0.3;
          for (const [dx, dy] of [
            [d, 0],
            [-d, 0],
            [0, d],
            [0, -d],
          ]) {
            const px = Math.round(star.x + dx);
            const py = Math.round(star.y + dy);
            if (px < 0 || px >= width || py < 0 || py >= height) continue;
            const idx = (py * width + px) * 3;
            lin[idx] += fall;
            lin[idx + 1] += fall * 0.94;
            lin[idx + 2] += fall * 0.86;
          }
        }
      }
    }
  }

  /* -------------------------------------------------------------- 前景剪影 */
  if (theme === 'landscape' || theme === 'sea' || theme === 'night' || theme === 'dusk') {
    const baseY = Math.floor(height * horizon);
    // 山脊高度线：三层叠加，越靠下越近越黑
    const ridges = [
      { y: baseY + height * 0.005, amp: height * 0.085, freq: 1.9, dark: 0.62 },
      { y: baseY + height * 0.05, amp: height * 0.055, freq: 3.2, dark: 0.84 },
      { y: baseY + height * 0.1, amp: height * 0.034, freq: 5.0, dark: 1.0 },
    ];
    for (const ridge of ridges) {
      const seedOff = Math.floor(rand() * 1000);
      for (let x = 0; x < width; x += 1) {
        const nx = (x / width) * aspect;
        const h1 = fbm(nx * ridge.freq, 0.5, seed + seedOff, 5, 0.52);
        const h2 = fbm(nx * ridge.freq * 3.1, 2.5, seed + seedOff + 77, 3, 0.5);
        const top = ridge.y - (h1 - 0.5) * ridge.amp * 2 - (h2 - 0.5) * ridge.amp * 0.35;
        const y0 = Math.max(0, Math.floor(top));
        for (let y = y0; y < height; y += 1) {
          const idx = (y * width + x) * 3;
          const depth = Math.min(1, (y - y0) / Math.max(1, height - y0));
          const k = ridge.dark * (0.72 + 0.28 * depth);
          lin[idx] *= 1 - k;
          lin[idx + 1] *= 1 - k;
          lin[idx + 2] *= 1 - k;
        }
      }
    }

    // 松树剪影（只在前景最靠下的一条带里）
    if (theme === 'landscape') {
      const trees = Math.round((width / 1024) * 34);
      for (let i = 0; i < trees; i += 1) {
        const tx = rand() * width;
        const heightPx = height * (0.04 + rand() ** 1.6 * 0.16);
        const basePY = baseY + height * (0.045 + rand() * 0.06);
        const halfW = heightPx * (0.16 + rand() * 0.08);
        const tiers = 5 + Math.floor(rand() * 4);
        const topY = basePY - heightPx;
        for (let y = Math.max(0, Math.floor(topY)); y < Math.min(height, Math.ceil(basePY)); y += 1) {
          const tp = (basePY - y) / heightPx;
          if (tp < 0 || tp > 1) continue;
          // 一层层收窄，边缘带一点锯齿
          const tier = Math.floor(tp * tiers) / tiers;
          const taper = (1 - tier) * halfW;
          const wobble = (noise2(y * 0.35, tx * 0.02, seed + i) - 0.5) * halfW * 0.28;
          const x0 = Math.max(0, Math.floor(tx - taper + wobble));
          const x1 = Math.min(width - 1, Math.ceil(tx + taper + wobble));
          for (let x = x0; x <= x1; x += 1) {
            const idx = (y * width + x) * 3;
            lin[idx] *= 0.05;
            lin[idx + 1] *= 0.055;
            lin[idx + 2] *= 0.065;
          }
        }
      }
    }

    // 海面：下半部分做垂直拉伸的倒影 + 水平波纹
    if (theme === 'sea') {
      for (let y = baseY; y < height; y += 1) {
        const t = (y - baseY) / Math.max(1, height - baseY);
        const srcY = Math.max(0, Math.floor(baseY - (y - baseY) * 1.35 - 1));
        for (let x = 0; x < width; x += 1) {
          const wobble = Math.sin(y * 0.15 + x * 0.004) * 4 + Math.sin(y * 0.05) * 6;
          const sx = Math.min(width - 1, Math.max(0, Math.round(x + wobble)));
          const dst = (y * width + x) * 3;
          // 水平方向取三点均值，把倒影糊开，避免出现硬镜面
          let ar = 0;
          let ag = 0;
          let ab = 0;
          for (const off of [-2, 0, 2]) {
            const sxp = Math.min(width - 1, Math.max(0, sx + off));
            const src = (srcY * width + sxp) * 3;
            ar += lin[src];
            ag += lin[src + 1];
            ab += lin[src + 2];
          }
          const fade = (1 - t) ** 1.2 * 0.42 + 0.03;
          lin[dst] = (ar / 3) * fade * 0.92 + 0.0016;
          lin[dst + 1] = (ag / 3) * fade * 0.95 + 0.002;
          lin[dst + 2] = (ab / 3) * fade * 1.04 + 0.0032;
        }
      }
      // 近处压暗，做出水面的纵深
      for (let y = baseY; y < height; y += 1) {
        const t = (y - baseY) / Math.max(1, height - baseY);
        const k = 1 - 0.45 * t * t;
        for (let x = 0; x < width; x += 1) {
          const idx = (y * width + x) * 3;
          lin[idx] *= k;
          lin[idx + 1] *= k;
          lin[idx + 2] *= k;
        }
      }
    }
  }

  /* ---------------------------------------------- 静物：桌面 + 柔和渐变地面 */
  if (theme === 'studio') {
    const baseY = Math.floor(height * horizon);
    const floorTop = [0.055, 0.058, 0.066];
    for (let y = baseY; y < height; y += 1) {
      const t = (y - baseY) / Math.max(1, height - baseY);
      const entry = smooth(Math.min(1, t * 6)); // 台面与背景之间做一段过渡，避免硬切线
      const k = 1 - 0.55 * t;
      for (let x = 0; x < width; x += 1) {
        const idx = (y * width + x) * 3;
        // 中心略微提亮，像一束打下来的主光照在台面上
        const nx = (x / width - 0.5) * 2;
        const spot = Math.exp(-(nx * nx) / 0.28) * (1 - t) * 0.5;
        for (let c = 0; c < 3; c += 1) {
          const floor = floorTop[c] * k + floorTop[c] * spot;
          lin[idx + c] = lin[idx + c] * (1 - entry) + floor * entry;
        }
      }
    }

    // 主体：一个柔边的立式静物（花瓶 / 杯子那一类），左上方来光
    const subjH = height * 0.3;
    const subjW = width * 0.11;
    const cx = width * 0.5;
    const bottom = baseY + height * 0.045;
    const top = bottom - subjH;
    const subjTint = [0.2, 0.196, 0.19];
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(bottom)); y += 1) {
      const v = (y - top) / subjH; // 0 顶 1 底
      // 上下都收一点，做出瓶身轮廓
      const taper = 0.78 + 0.22 * Math.sin(Math.PI * Math.min(1, Math.max(0, v)));
      const halfW = subjW * taper;
      for (let x = Math.max(0, Math.floor(cx - halfW)); x < Math.min(width, Math.ceil(cx + halfW)); x += 1) {
        const u = (x - cx) / Math.max(1, halfW); // -1..1
        if (Math.abs(u) >= 1) continue;
        const edge = smooth(Math.min(1, (1 - Math.abs(u)) / 0.22));
        // 光从左上打过来：左侧亮、右侧暗
        const shade = 0.42 + 0.58 * (1 - (u + 1) / 2) * (0.55 + 0.45 * (1 - v));
        const a = edge * shade;
        if (a < 0.004) continue;
        const idx = (y * width + x) * 3;
        for (let c = 0; c < 3; c += 1) lin[idx + c] += subjTint[c] * a;
      }
    }

    // 主体脚下的接触阴影，让它坐在台面上而不是浮着
    const shadowR = subjW * 1.9;
    for (let y = Math.max(0, Math.floor(bottom - height * 0.006)); y < Math.min(height, Math.ceil(bottom + height * 0.022)); y += 1) {
      const dy = (y - bottom) / (height * 0.028);
      for (let x = Math.max(0, Math.floor(cx - shadowR)); x < Math.min(width, Math.ceil(cx + shadowR)); x += 1) {
        const dx = (x - cx) / shadowR;
        const a = Math.max(0, 1 - dx * dx - dy * dy * 0.6) * 0.28;
        if (a < 0.003) continue;
        const idx = (y * width + x) * 3;
        lin[idx] *= 1 - a;
        lin[idx + 1] *= 1 - a;
        lin[idx + 2] *= 1 - a;
      }
    }
  }

  return { lin, width, height };
}

/* ---------------------------------------------------------------- 后期处理 */

function finish(scene: Scene, seed: number): Uint8Array {
  const { lin, width, height } = scene;
  const rand = rng(seed ^ 0x5f3759df);
  const out = new Uint8Array(width * height * 3);
  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.hypot(cx, cy);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      let r = lin[idx];
      let g = lin[idx + 1];
      let b = lin[idx + 2];

      // 曝光 + 胶片曲线
      r = 1 - Math.exp(-r * 1.55);
      g = 1 - Math.exp(-g * 1.55);
      b = 1 - Math.exp(-b * 1.55);
      r = Math.pow(r, 0.92);
      g = Math.pow(g, 0.92);
      b = Math.pow(b, 0.92);

      // 饱和度
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = lum + (r - lum) * 1.32;
      g = lum + (g - lum) * 1.32;
      b = lum + (b - lum) * 1.32;

      // 暗角
      const dist = Math.hypot(x - cx, y - cy) / maxR;
      const vig = 1 - 0.4 * dist * dist;
      r *= vig;
      g *= vig;
      b *= vig;

      // 黑位 + 颗粒
      const grain = (rand() - 0.5) * 0.016;
      r = (r - 0.01) / 0.99 + grain;
      g = (g - 0.01) / 0.99 + grain;
      b = (b - 0.01) / 0.99 + grain;

      // 线性 → sRGB
      out[idx] = toSrgb(r);
      out[idx + 1] = toSrgb(g);
      out[idx + 2] = toSrgb(b);
    }
  }
  return out;
}

function toSrgb(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(255, Math.max(0, s * 255)));
}

/* ------------------------------------------------------------------ 对外 */

function strSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 把 prompt 渲染成一张 PNG，写到 dir 里 */
export function paintImage(dir: string, input: PaintInput, index = 0): PaintResult {
  const width = Math.max(256, Math.min(2048, Math.round(input.width) || 1024));
  const height = Math.max(256, Math.min(2048, Math.round(input.height) || 1024));
  const seed = input.seed ?? (strSeed(input.prompt) ^ (Date.now() & 0x7fffffff) ^ (index * 2654435761)) >>> 0;
  const theme = pickTheme(input.prompt);

  const scene = makeScene(width, height, seed, theme);
  const rgb = finish(scene, seed);

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `paint-${Date.now()}-${index}.png`);
  fs.writeFileSync(file, encodePng(width, height, rgb));
  return { path: file, width, height, theme };
}

/** 主题的中文说明，给工具返回文案用 */
export function themeLabel(theme: PaintTheme): string {
  switch (theme) {
    case 'night':
      return '夜空银河';
    case 'dusk':
      return '黄昏天空';
    case 'day':
      return '白天晴空';
    case 'landscape':
      return '山脊风景';
    case 'sea':
      return '海面波光';
    default:
      return '静物柔光';
  }
}
