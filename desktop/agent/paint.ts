/* ============================================================================
 * desktop/agent/paint.ts —— 内置程序化出图（纯 Node，无任何外部依赖）
 *
 *   为什么需要它：
 *     很多「OpenAI 兼容」的文本厂商（DeepSeek / Moonshot / 通义 …）根本没有
 *     /images/generations；用户没接出图后端时，模型只能回一句「无法生成图片」。
 *     这里用 zlib + 手写 PNG 编码器，直接在本地把画面算出来 —— 只要进程活着就
 *     一定能出图，不依赖网络、不依赖 API Key、不依赖显卡。
 *
 *   能画什么：夜空银河、山脊松林、海面倒影、抽象光晕四类。
 *   画不出什么：写实的人、动物、产品照（那是扩散模型的活）。
 *
 *   渲染管线：线性光浮点缓冲 → fbm 噪声铺天空 → 银河带 → 三层星点 PSF →
 *   前景剪影 → 色调映射 / 饱和度 / 暗角 / 色散 / 颗粒 → sRGB 8bit → PNG。
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export type PaintTheme = 'night' | 'landscape' | 'sea' | 'abstract';

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

const THEME_RULES: { match: RegExp; theme: PaintTheme }[] = [
  { match: /(山|峰|岭|松|林|雪|风景|野外|谷|坡|mountain|ridge|peak|forest|valley|snow|landscape)/i, theme: 'landscape' },
  { match: /(海|湖|水|倒影|岸|滩|河|sea|ocean|lake|water|reflect|shore|beach|river)/i, theme: 'sea' },
  { match: /(银河|星空|星|夜|宇宙|太空|流星|极光|milky|galaxy|star|night|cosmos|space|nebula|astro)/i, theme: 'night' },
];

export function pickTheme(prompt: string): PaintTheme {
  for (const rule of THEME_RULES) if (rule.match.test(prompt)) return rule.theme;
  return 'abstract';
}

/* ------------------------------------------------------------------ 渲染器 */

interface Scene {
  lin: Float32Array;
  width: number;
  height: number;
}

function makeScene(width: number, height: number, seed: number, theme: PaintTheme): Scene {
  const lin = new Float32Array(width * height * 3);
  const rand = rng(seed);
  const aspect = width / height;

  // 天际线位置（0 顶部 → 1 底部）
  const horizon = theme === 'abstract' ? 1.0 : theme === 'sea' ? 0.62 : 0.78;

  /* ------------------------------------------------------------ 天空底色 */
  const zenith = [0.0016, 0.0024, 0.0072];
  const mid = [0.0032, 0.005, 0.0135];
  const low = [0.0125, 0.0142, 0.0224];
  const warm = [0.020, 0.0152, 0.0098];

  for (let y = 0; y < height; y += 1) {
    const ty = y / Math.max(1, height - 1);
    const t = Math.min(1, ty / Math.max(0.001, horizon));
    // 天顶 → 中天 → 地平线
    const m0 = smooth(Math.min(1, t * 2));
    const m1 = smooth(Math.max(0, (t - 0.5) * 2));
    for (let c = 0; c < 3; c += 1) {
      const col = (zenith[c] * (1 - m0) + mid[c] * m0) * (1 - m1) + low[c] * m1;
      lin[(y * width) * 3 + c] = col;
    }
    // 地平线暖色气辉
    const glow = Math.exp(-((ty - horizon) ** 2) / 0.009) * 0.9 + Math.exp(-((ty - horizon) ** 2) / 0.05) * 0.22;
    for (let c = 0; c < 3; c += 1) lin[(y * width) * 3 + c] += warm[c] * glow;
  }

  /* -------------------------------------------------------------- 银河带 */
  if (theme !== 'abstract') {
    const angle = (theme === 'sea' ? 14 : 18 + rand() * 8) * (Math.PI / 180);
    const cx = theme === 'sea' ? 0.5 : 0.44 + rand() * 0.14;
    const cy = theme === 'sea' ? 0.3 : 0.34 + rand() * 0.1;
    const sigma = 0.085 + rand() * 0.03;
    const curve = 0.09 + rand() * 0.08;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const tintWarm = [1.0, 0.9, 0.72];
    const tintCool = [0.62, 0.74, 1.0];

    for (let y = 0; y < height; y += 1) {
      const vy = y / height - cy;
      for (let x = 0; x < width; x += 1) {
        const vx = (x / width - cx) * aspect;
        const along = vx * ca + vy * sa;
        const across = -vx * sa + vy * ca + curve * along * along;
        const core = Math.exp(-((across / sigma) ** 2));
        if (core < 0.004) continue;
        const structure = 0.45 + 0.75 * fbm(vx * 5 + 3.1, vy * 5 + 7.7, seed + 71, 5, 0.55);
        // 尘埃暗带
        const dust = fbm(vx * 11 + 21, vy * 11 + 13, seed + 911, 4, 0.6);
        const rift = Math.exp(-(((across + 0.028) / 0.026) ** 2)) * 0.7;
        const light = (core * 0.05 + core * structure * 0.115) * (1 - 0.9 * Math.min(0.98, dust * 0.85 + rift));
        const idx = (y * width + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          lin[idx + c] += light * 0.3 * (core > 0.55 ? tintWarm[c] : tintCool[c]);
        }
      }
    }
  } else {
    // 抽象主题：几团柔和光晕
    const blobs = 3 + Math.floor(rand() * 3);
    for (let b = 0; b < blobs; b += 1) {
      const bx = rand() * width;
      const by = rand() * height * 0.85;
      const radius = (0.18 + rand() * 0.3) * Math.min(width, height);
      const huePick = rand();
      const col = huePick > 0.6 ? [0.16, 0.1, 0.24] : huePick > 0.3 ? [0.05, 0.14, 0.26] : [0.22, 0.12, 0.14];
      const x0 = Math.max(0, Math.floor(bx - radius * 2));
      const x1 = Math.min(width - 1, Math.ceil(bx + radius * 2));
      const y0 = Math.max(0, Math.floor(by - radius * 2));
      const y1 = Math.min(height - 1, Math.ceil(by + radius * 2));
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const d = Math.hypot(x - bx, y - by) / radius;
          const falloff = Math.exp(-d * d * 1.6);
          if (falloff < 0.002) continue;
          const idx = (y * width + x) * 3;
          for (let c = 0; c < 3; c += 1) lin[idx + c] += col[c] * falloff * 0.5;
        }
      }
    }
  }

  /* ---------------------------------------------------------------- 星点 */
  const area = (width * height) / (1024 * 1024);
  const layers = [
    { count: Math.round(15000 * area), power: 6, flux: 0.5, radius: 0.9 },
    { count: Math.round(2600 * area), power: 3.4, flux: 1.5, radius: 1.35 },
    { count: Math.round(180 * area), power: 1.8, flux: 4.2, radius: 2.2 },
  ];
  const brightest: { x: number; y: number; f: number }[] = [];

  for (const layer of layers) {
    for (let i = 0; i < layer.count; i += 1) {
      const x = rand() * width;
      const y = rand() * height * (theme === 'sea' ? 0.58 : theme === 'abstract' ? 0.9 : 0.86);
      const f = Math.pow(rand(), layer.power) * layer.flux;
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
          const core = Math.exp(-d2 / (r * r));
          const halo = Math.exp(-d2 / (r * r * 6)) * 0.12;
          const e = f * (core + halo);
          if (e < 1e-5) continue;
          const idx = (py * width + px) * 3;
          lin[idx] += e * cr;
          lin[idx + 1] += e * cg;
          lin[idx + 2] += e * cb;
        }
      }
      if (f > 2.0 && brightest.length < 14) brightest.push({ x, y, f });
    }
  }

  // 最亮的几颗画十字星芒
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

  /* -------------------------------------------------------------- 前景剪影 */
  if (theme === 'landscape' || theme === 'sea' || theme === 'night') {
    const baseY = Math.floor(height * horizon);
    // 山脊高度线：三层叠加，越靠下越近越黑
    const ridges = [
      { y: baseY - height * 0.02, amp: height * 0.075, freq: 2.2, dark: 0.62 },
      { y: baseY + height * 0.03, amp: height * 0.05, freq: 3.6, dark: 0.86 },
      { y: baseY + height * 0.085, amp: height * 0.032, freq: 5.4, dark: 1.0 },
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
      const trees = Math.round((width / 1024) * 26);
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
            lin[idx] *= 0.06;
            lin[idx + 1] *= 0.07;
            lin[idx + 2] *= 0.08;
          }
        }
      }
    }

    // 海面：下半部分做垂直拉伸的倒影 + 水平波纹
    if (theme === 'sea') {
      for (let y = baseY; y < height; y += 1) {
        const t = (y - baseY) / Math.max(1, height - baseY);
        const srcY = Math.max(0, Math.floor(baseY - (y - baseY) * 1.6 - 1));
        for (let x = 0; x < width; x += 1) {
          const wobble = Math.sin(y * 0.18 + x * 0.004) * 3 + Math.sin(y * 0.06) * 5;
          const sx = Math.min(width - 1, Math.max(0, Math.round(x + wobble)));
          const src = (srcY * width + sx) * 3;
          const dst = (y * width + x) * 3;
          const fade = (1 - t) * 0.62 + 0.06;
          lin[dst] = lin[src] * fade * 0.95 + 0.0018;
          lin[dst + 1] = lin[src + 1] * fade * 0.97 + 0.0022;
          lin[dst + 2] = lin[src + 2] * fade * 1.02 + 0.0034;
        }
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
    case 'landscape':
      return '山脊星空';
    case 'sea':
      return '海面星空倒影';
    default:
      return '抽象光晕';
  }
}
