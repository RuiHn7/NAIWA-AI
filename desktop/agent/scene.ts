/* ============================================================================
 * desktop/agent/scene.ts —— 内置渲染的「主体」绘制
 *
 * 旧版内置渲染只会铺天空、山脊、星空，所以「画一张桌子」出来还是一片银河。
 * 这里补上真正的物体：先按提示词认出主体（桌子 / 椅子 / 杯子 / 瓶子 / 球 /
 * 方块 / 房子 / 树 / 花 / 猫 / 狗 / 人 / 车），再用几何 + 光影把它画出来。
 *
 * 定位要诚实：这是**程序化插画**，不是扩散模型。画得出「一张四条腿的桌子」，
 * 画不出照片级质感与复杂细节；每张图都会返回一句场景描述，出图核对直接用这句，
 * 不需要外部视觉模型也能说清「这张图到底画了什么」。
 * ==========================================================================*/

export type SubjectKind =
  | 'table'
  | 'chair'
  | 'cup'
  | 'bottle'
  | 'ball'
  | 'box'
  | 'house'
  | 'tree'
  | 'flower'
  | 'cat'
  | 'dog'
  | 'person'
  | 'car'
  | 'none';

export interface Subject {
  kind: SubjectKind;
  label: string;
  /** 提示词里点名的颜色，没点名就是 null（用材质默认色） */
  color: RGB | null;
  colorName: string | null;
}

type RGB = [number, number, number];

/* ------------------------------------------------------------ 主体识别 */

/**
 * 顺序即优先级：
 *   「花瓶」要判成瓶子而不是花，「书桌」判成桌子，「汽车」不落到别的规则。
 *   只认画面主体，不认风格词 —— 风格交给主题识别。
 */
const SUBJECT_RULES: { match: RegExp; kind: SubjectKind; label: string }[] = [
  { match: /(桌子|书桌|餐桌|茶几|办公桌|木桌|桌|table|desk)/i, kind: 'table', label: '桌子' },
  { match: /(椅子|座椅|沙发椅|chair|stool)/i, kind: 'chair', label: '椅子' },
  { match: /(杯子|马克杯|咖啡杯|茶杯|水杯|瓷杯|杯|cup|mug)/i, kind: 'cup', label: '杯子' },
  { match: /(瓶子|酒瓶|花瓶|水瓶|bottle|vase)/i, kind: 'bottle', label: '瓶子' },
  { match: /(篮球|basketball)/i, kind: 'ball', label: '篮球' },
  { match: /(足球|soccer|football)/i, kind: 'ball', label: '足球' },
  { match: /(网球|tennis)/i, kind: 'ball', label: '网球' },
  { match: /(排球|volleyball)/i, kind: 'ball', label: '排球' },
  { match: /(球体|圆球|球|ball|sphere)/i, kind: 'ball', label: '球体' },
  { match: /(盒子|方块|立方体|纸箱|box|cube)/i, kind: 'box', label: '方块' },
  { match: /(房子|小屋|房屋|砖房|平房|楼房|别墅|木屋|house|cabin|cottage|building)/i, kind: 'house', label: '房子' },
  { match: /(松树|大树|树木|树|tree)/i, kind: 'tree', label: '树' },
  { match: /(花朵|玫瑰|向日葵|花|flower|rose|tulip)/i, kind: 'flower', label: '花' },
  { match: /(猫|橘猫|小猫|猫咪|cat|kitten)/i, kind: 'cat', label: '猫' },
  { match: /(狗|小狗|柴犬|狗子|dog|puppy)/i, kind: 'dog', label: '狗' },
  { match: /(人物|人像|女孩|男孩|男人|女人|少女|person|man|woman|girl|boy)/i, kind: 'person', label: '人物剪影' },
  { match: /(汽车|轿车|小车|车|car|sedan|vehicle)/i, kind: 'car', label: '汽车' },
];

const COLOR_RULES: { match: RegExp; rgb: RGB; name: string }[] = [
  { match: /(朱红|大红|红色|红|red|crimson)/i, rgb: [0.42, 0.045, 0.035], name: '红' },
  { match: /(橙色|橘色|橙|orange)/i, rgb: [0.5, 0.19, 0.03], name: '橙' },
  { match: /(黄色|金色|黄|yellow|gold)/i, rgb: [0.52, 0.4, 0.06], name: '黄' },
  { match: /(绿色|墨绿|绿|green)/i, rgb: [0.06, 0.26, 0.09], name: '绿' },
  { match: /(青色|蓝绿|青|cyan|teal)/i, rgb: [0.04, 0.26, 0.28], name: '青' },
  { match: /(深蓝|藏蓝|蓝色|蓝|blue)/i, rgb: [0.04, 0.1, 0.34], name: '蓝' },
  { match: /(紫色|紫|purple|violet)/i, rgb: [0.16, 0.06, 0.3], name: '紫' },
  { match: /(粉色|粉|pink)/i, rgb: [0.55, 0.2, 0.28], name: '粉' },
  { match: /(白色|纯白|白|white)/i, rgb: [0.62, 0.62, 0.6], name: '白' },
  { match: /(灰色|灰|gray|grey)/i, rgb: [0.16, 0.165, 0.175], name: '灰' },
  { match: /(黑色|纯黑|黑|black)/i, rgb: [0.015, 0.015, 0.018], name: '黑' },
  { match: /(木头|木质|原木|木色|棕色|棕|木|wood|brown|oak|walnut)/i, rgb: [0.2, 0.1, 0.045], name: '木色' },
];

export function detectSubject(prompt: string): Subject {
  const text = prompt ?? '';
  const hit = SUBJECT_RULES.find(rule => rule.match.test(text));
  if (!hit) return { kind: 'none', label: '', color: null, colorName: null };
  const colorHit = COLOR_RULES.find(rule => rule.match.test(text));
  return {
    kind: hit.kind,
    label: hit.label,
    color: colorHit ? colorHit.rgb : null,
    colorName: colorHit ? colorHit.name : null,
  };
}

/** 材质默认色（线性光）；用户点名颜色时以用户为准 */
const DEFAULT_TINT: Record<SubjectKind, RGB> = {
  table: [0.2, 0.1, 0.045],
  chair: [0.18, 0.09, 0.04],
  cup: [0.6, 0.6, 0.58],
  bottle: [0.1, 0.24, 0.2],
  ball: [0.5, 0.18, 0.03],
  box: [0.3, 0.22, 0.12],
  house: [0.42, 0.38, 0.32],
  tree: [0.05, 0.2, 0.07],
  flower: [0.5, 0.08, 0.12],
  cat: [0.4, 0.22, 0.08],
  dog: [0.28, 0.18, 0.1],
  person: [0.03, 0.035, 0.045],
  car: [0.08, 0.1, 0.14],
  none: [0.2, 0.2, 0.2],
};

/* ------------------------------------------------------------ 像素工具 */

interface Canvas {
  lin: Float32Array;
  width: number;
  height: number;
}

function blend(cv: Canvas, x: number, y: number, rgb: RGB, alpha: number): void {
  if (alpha <= 0 || x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
  const i = (y * cv.width + x) * 3;
  const a = alpha > 1 ? 1 : alpha;
  cv.lin[i] = cv.lin[i] * (1 - a) + rgb[0] * a;
  cv.lin[i + 1] = cv.lin[i + 1] * (1 - a) + rgb[1] * a;
  cv.lin[i + 2] = cv.lin[i + 2] * (1 - a) + rgb[2] * a;
}

function mul(rgb: RGB, k: number): RGB {
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

function pointInPoly(px: number, py: number, pts: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** 多边形填充：2×2 超采样做抗锯齿，shade(x,y) 用来做渐变/明暗 */
function poly(cv: Canvas, pts: number[][], rgb: RGB, alpha = 1, shade?: (x: number, y: number) => number): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(cv.width - 1, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(cv.height - 1, Math.ceil(maxY));
  const samples = [0.25, 0.75];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      let cov = 0;
      for (const sy of samples) for (const sx of samples) if (pointInPoly(x + sx, y + sy, pts)) cov += 0.25;
      if (cov <= 0) continue;
      const k = shade ? shade(x + 0.5, y + 0.5) : 1;
      if (k <= 0) continue;
      blend(cv, x, y, mul(rgb, k), alpha * cov);
    }
  }
}

/** 椭圆填充（上下左右都收边），shade 里可以传入球面法线近似 */
function ellipse(cv: Canvas, cx: number, cy: number, rx: number, ry: number, rgb: RGB, alpha = 1, shade?: (nx: number, ny: number) => number): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(cv.width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(cv.height - 1, Math.ceil(cy + ry));
  const feather = Math.max(0.6, Math.min(rx, ry) * 0.08);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const d = Math.hypot(nx, ny);
      if (d >= 1 + feather / Math.max(rx, ry)) continue;
      const cover = d <= 1 ? 1 : Math.max(0, 1 - (d - 1) * Math.max(rx, ry) / feather);
      if (cover <= 0) continue;
      const k = shade ? shade(nx, ny) : 1;
      blend(cv, x, y, mul(rgb, k), alpha * cover);
    }
  }
}

/**
 * 按像素给颜色的椭圆：shade 直接返回 RGB（球面法线 nx/ny/nz 可用来算纹理、沟槽、斑块），
 * 返回 null 表示这个像素不上色。球类需要「橙色球面 + 黑色沟槽 + 白色缝线」这种多色叠加，
 * 只靠亮度乘子（ellipse）做不到，所以单独留一条路径。
 */
function ellipseRGB(
  cv: Canvas,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  shade: (nx: number, ny: number, nz: number) => RGB | null,
  alpha = 1,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(cv.width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(cv.height - 1, Math.ceil(cy + ry));
  const feather = 1.2; // 只做 1px 抗锯齿；过大会在球边缘糊出一圈光晕
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const d = Math.hypot(nx, ny);
      if (d >= 1 + feather / Math.max(rx, ry)) continue;
      const cover = d <= 1 ? 1 : Math.max(0, 1 - ((d - 1) * Math.max(rx, ry)) / feather);
      if (cover <= 0) continue;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const rgb = shade(nx, ny, nz);
      if (!rgb) continue;
      blend(cv, x, y, rgb, alpha * cover);
    }
  }
}

/** 粗线（描边）：沿折线撒圆点，用来画提手、花茎、尾巴 */function stroke(cv: Canvas, pts: number[][], width: number, rgb: RGB, alpha = 1): void {
  const r = Math.max(0.8, width / 2);
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / (r * 0.7)));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      ellipse(cv, ax + (bx - ax) * t, ay + (by - ay) * t, r, r, rgb, alpha);
    }
  }
}

/** 地面接触阴影：先压暗背景，物体才有「落在地上」的重量 */
function contactShadow(cv: Canvas, cx: number, cy: number, rx: number, ry: number, strength = 0.34): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(cv.width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(cv.height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const d = nx * nx + ny * ny;
      if (d >= 1) continue;
      const a = (1 - d) ** 1.6 * strength;
      const i = (y * cv.width + x) * 3;
      cv.lin[i] *= 1 - a;
      cv.lin[i + 1] *= 1 - a;
      cv.lin[i + 2] *= 1 - a;
    }
  }
}

/* ------------------------------------------------------------ 表面纹理 */

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 整数格点哈希：同一坐标 + 同一 seed 永远给同一个 [0,1) */
function thash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function tnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smoothstep(x - xi);
  const v = smoothstep(y - yi);
  const a = thash(xi, yi, seed);
  const b = thash(xi + 1, yi, seed);
  const c = thash(xi, yi + 1, seed);
  const d = thash(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function tfbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * tnoise(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / (norm || 1);
}

/**
 * 材质颗粒：把「纯色块」变成有表面的东西。
 * scale 是纹理频率（越大颗粒越细），amp 是明暗起伏幅度。
 * 返回 1 附近的亮度乘子，直接乘进 shade。
 */
function grain(u: number, v: number, scale: number, seed: number, amp: number, octaves = 3): number {
  const n = tfbm(u * scale, v * scale, seed, octaves) - 0.5;
  return 1 + n * 2 * amp;
}

/** 木纹：沿 u 方向的长条纹 + 年轮扰动 */
function woodGrain(u: number, v: number, seed: number, amp = 0.16): number {
  const warp = tfbm(u * 3, v * 9, seed + 11, 3) * 0.6;
  const rings = Math.sin((v * 26 + warp * 5) * Math.PI) * 0.5 + 0.5;
  const fine = tfbm(u * 40, v * 160, seed + 23, 2) - 0.5;
  return 1 + (rings - 0.5) * amp + fine * amp * 0.8;
}

/** 砖纹：水平砖缝 + 交错竖缝 */
function brickGrain(u: number, v: number, seed: number): number {
  const rows = 7;
  const cols = 4;
  const fy = v * rows;
  const row = Math.floor(fy);
  const fx = u * cols + (row % 2 ? 0.5 : 0);
  const col = Math.floor(fx);
  const dx = Math.abs(fx - Math.round(fx));
  const dy = Math.abs(fy - Math.round(fy));
  const mortar = Math.min(dx / 0.06, dy / 0.12);
  const n = tfbm(u * 30, v * 30, seed + col * 7 + row * 13, 2) - 0.5;
  // 缝隙处压暗，砖面有轻微色差
  return (mortar < 1 ? 0.78 + 0.22 * mortar : 1) * (1 + n * 0.14);
}

/** 球面沟槽：几个大圆（过球心的平面）投影到球面上，得到篮球那种十字 + 侧弧 */
function grooveAmount(nx: number, ny: number, nz: number, width: number): number {
  const circles = [Math.abs(ny), Math.abs(nx), Math.abs(nx - nz), Math.abs(nx + nz)];
  let m = 0;
  for (const d of circles) {
    if (d < width) m = Math.max(m, 1 - d / width);
  }
  return m;
}

/* ------------------------------------------------------------ 通用光照 */

/** 左上主光的朗伯近似：法线朝左上最亮 */
function lit(nx: number, ny: number, nz = 0.8): number {
  const lx = -0.52;
  const ly = -0.62;
  const lz = 0.58;
  const len = Math.hypot(nx, ny, nz) || 1;
  const d = (nx * lx + ny * ly + nz * lz) / len;
  return 0.42 + 0.72 * Math.max(0, d);
}

/* ------------------------------------------------------------ 各主体 */

interface Ctx {
  cv: Canvas;
  cx: number;
  /** 物体底部（落地点） */
  baseY: number;
  /** 主体高度 */
  h: number;
  tint: RGB;
  /** 主体名（篮球 / 足球 / 桌子…）：同一 kind 下按材质细分纹理 */
  label: string;
  /** 用户是否点名了颜色：点名了就尊重用户，不套材质默认色 */
  hasColor: boolean;
}

function leg(c: Ctx, x: number, top: number, bottom: number, w: number, rgb: RGB): void {
  poly(c.cv, [
    [x - w * 0.5, top],
    [x + w * 0.5, top],
    [x + w * 0.38, bottom],
    [x - w * 0.38, bottom],
  ], rgb, 1, (px) => (px < x ? 1.08 : 0.82));
}

function drawTable(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const topY = baseY - h * 0.52;
  const halfW = h * 0.62;
  const thick = h * 0.055;
  // 后腿（先画，被桌面压住一截）
  leg(c, cx - halfW * 0.62, topY + thick * 0.4, baseY - h * 0.06, h * 0.05, mul(tint, 0.72));
  leg(c, cx + halfW * 0.62, topY + thick * 0.4, baseY - h * 0.06, h * 0.05, mul(tint, 0.72));
  // 桌面（透视梯形 + 前缘厚度）
  poly(cv, [
    [cx - halfW, topY],
    [cx + halfW, topY],
    [cx + halfW * 0.86, topY + h * 0.16],
    [cx - halfW * 0.86, topY + h * 0.16],
  ], tint, 1, (x, y) => {
    const u = (x - (cx - halfW)) / (2 * halfW);
    const v = (y - topY) / (h * 0.16);
    // 木纹 + 细颗粒：桌面不是一块纯色板
    return (0.95 + 0.35 * (1 - v)) * woodGrain(u, v, 71, 0.15) * grain(u, v, 26, 91, 0.05, 2);
  });
  poly(cv, [
    [cx - halfW * 0.86, topY + h * 0.16],
    [cx + halfW * 0.86, topY + h * 0.16],
    [cx + halfW * 0.86, topY + h * 0.16 + thick],
    [cx - halfW * 0.86, topY + h * 0.16 + thick],
  ], mul(tint, 0.55));
  // 前腿
  leg(c, cx - halfW * 0.78, topY + h * 0.16, baseY, h * 0.062, tint);
  leg(c, cx + halfW * 0.78, topY + h * 0.16, baseY, h * 0.062, tint);
}

function drawChair(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const seatY = baseY - h * 0.42;
  const halfW = h * 0.3;
  leg(c, cx - halfW * 0.8, seatY, baseY, h * 0.045, mul(tint, 0.7));
  leg(c, cx + halfW * 0.8, seatY, baseY, h * 0.045, mul(tint, 0.7));
  // 靠背立柱 + 横板
  poly(cv, [
    [cx - halfW, seatY - h * 0.42],
    [cx - halfW * 0.72, seatY - h * 0.42],
    [cx - halfW * 0.72, seatY],
    [cx - halfW, seatY],
  ], mul(tint, 0.75));
  poly(cv, [
    [cx + halfW * 0.72, seatY - h * 0.42],
    [cx + halfW, seatY - h * 0.42],
    [cx + halfW, seatY],
    [cx + halfW * 0.72, seatY],
  ], mul(tint, 0.75));
  poly(cv, [
    [cx - halfW * 0.94, seatY - h * 0.36],
    [cx + halfW * 0.94, seatY - h * 0.36],
    [cx + halfW * 0.94, seatY - h * 0.26],
    [cx - halfW * 0.94, seatY - h * 0.26],
  ], mul(tint, 0.95));
  // 座面
  poly(cv, [
    [cx - halfW, seatY],
    [cx + halfW, seatY],
    [cx + halfW * 0.9, seatY + h * 0.08],
    [cx - halfW * 0.9, seatY + h * 0.08],
  ], tint, 1, (x, y) => 0.92 + 0.3 * (1 - (y - seatY) / (h * 0.08)));
  leg(c, cx - halfW * 0.86, seatY + h * 0.08, baseY, h * 0.05, tint);
  leg(c, cx + halfW * 0.86, seatY + h * 0.08, baseY, h * 0.05, tint);
}

function drawCup(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const topY = baseY - h;
  const topW = h * 0.34;
  const botW = h * 0.25;
  // 杯身
  poly(cv, [
    [cx - topW, topY],
    [cx + topW, topY],
    [cx + botW, baseY],
    [cx - botW, baseY],
  ], tint, 1, (x) => lit((x - cx) / topW, 0, 0.9) * 0.95);
  // 杯口内壁
  ellipse(cv, cx, topY, topW, topW * 0.3, mul(tint, 0.32), 1);
  ellipse(cv, cx, topY, topW * 0.94, topW * 0.26, mul(tint, 0.75), 1);
  // 提手
  const handleR = h * 0.15;
  const arc: number[][] = [];
  for (let i = 0; i <= 8; i += 1) {
    const a = -Math.PI / 2 + (i / 8) * Math.PI;
    arc.push([cx + botW * 0.86 + Math.cos(a) * handleR, topY + h * 0.42 + Math.sin(a) * handleR * 1.25]);
  }
  stroke(cv, arc, h * 0.05, mul(tint, 0.88));
}

function drawBottle(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const bodyW = h * 0.2;
  const neckW = h * 0.065;
  const shoulderY = baseY - h * 0.52;
  const neckY = baseY - h * 0.84;
  poly(cv, [
    [cx - bodyW, baseY],
    [cx + bodyW, baseY],
    [cx + bodyW, shoulderY],
    [cx + neckW, shoulderY - h * 0.06],
    [cx + neckW, neckY],
    [cx - neckW, neckY],
    [cx - neckW, shoulderY - h * 0.06],
    [cx - bodyW, shoulderY],
  ], tint, 1, (x) => lit((x - cx) / bodyW, 0, 0.85));
  // 高光带
  poly(cv, [
    [cx - bodyW * 0.55, baseY - h * 0.02],
    [cx - bodyW * 0.28, baseY - h * 0.02],
    [cx - bodyW * 0.22, shoulderY + h * 0.04],
    [cx - bodyW * 0.48, shoulderY + h * 0.04],
  ], [1, 0.96, 0.9], 0.18);
  // 瓶盖
  poly(cv, [
    [cx - neckW * 1.25, neckY],
    [cx + neckW * 1.25, neckY],
    [cx + neckW * 1.25, neckY - h * 0.055],
    [cx - neckW * 1.25, neckY - h * 0.055],
  ], mul(tint, 0.5));
}

function drawBall(c: Ctx): void {
  const { cv, cx, baseY, h, label } = c;
  const r = h * 0.5;
  const cy = baseY - r;

  // 材质基色：用户点名颜色优先，否则按球类给默认色
  let base: RGB = c.tint;
  if (!c.hasColor) {
    if (label === '足球') base = [0.72, 0.72, 0.7];
    else if (label === '网球') base = [0.46, 0.57, 0.04];
    else if (label === '排球') base = [0.66, 0.64, 0.6];
    else base = [0.44, 0.14, 0.022];
  }

  const seed = 613;
  const groove: RGB = [0.012, 0.01, 0.009];
  const seam: RGB = [0.8, 0.79, 0.74];
  const isVolley = label === '排球';
  const bouncy = label === '篮球' || label === '球体' || label === '网球';

  // 足球斑块方向：球面均匀分布（斐波那契点），投影后可见 5-7 块，接近真实拼块
  const spotDirs: number[][] = Array.from({ length: 12 }, (_, i) => {
    const y = 1 - (i / 11) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * 2.399963229728653;
    return [Math.cos(phi) * rad, y, Math.sin(phi) * rad];
  });

  ellipseRGB(cv, cx, cy, r, r, (nx, ny, nz) => {
    // 凹凸颗粒：用噪声轻微扰动球面法线，颗粒才有真实的明暗起伏
    let lx = nx;
    let ly = ny;
    let lnz = nz;
    if (bouncy && nz > 0.3) {
      const bump = 0.22;
      lx = nx + (tfbm(nx * 24 + 3.1, ny * 24 + 7.7, seed, 3) - 0.5) * bump;
      ly = ny + (tfbm(nx * 24 + 11.3, ny * 24 + 2.9, seed + 5, 3) - 0.5) * bump;
      lnz = Math.sqrt(Math.max(0.05, 1 - lx * lx - ly * ly));
    }

    // 基础明暗：左上主光 + 边缘环境光遮蔽 + 高光
    let k = lit(lx, ly, lnz);
    k *= 0.52 + 0.48 * nz ** 0.5;
    k += Math.exp(-(((nx + 0.4) ** 2 + (ny + 0.46) ** 2) / 0.026)) * 1.25;

    // 材质颗粒：皮面细纹 / 网球绒毛 / 合成革
    if (bouncy) {
      k *= grain(nx + 1.7, ny + 1.7, 120, seed + 9, 0.28, 2);
      k *= grain(nx + 4.3, ny + 4.3, 6, seed + 3, 0.1, 3);
    } else {
      k *= grain(nx + 2.1, ny + 2.1, 70, seed, 0.06, 2);
    }

    // 篮球 / 排球：大圆沟槽（球面投影出的十字 + 侧弧）
    if (label === '篮球' || isVolley) {
      const g = grooveAmount(nx, ny, nz, isVolley ? 0.022 : 0.03);
      if (g > 0) {
        if (isVolley) {
          const w = 0.62 + 0.38 * (1 - g);
          return [seam[0] * w, seam[1] * w, seam[2] * w];
        }
        // 沟槽中心接近纯黑（线性空间要很小才够黑），靠外缘才回一点点亮
        const v = 0.0025 + 0.0055 * (1 - g) ** 2;
        return [groove[0] + v, groove[1] + v * 0.85, groove[2] + v * 0.7];
      }
    }

    // 足球：黑色拼块 + 块间浅灰缝线
    if (label === '足球') {
      let best = -1;
      for (const d of spotDirs) best = Math.max(best, nx * d[0] + ny * d[1] + nz * d[2]);
      if (best > 0.925) return [0.022, 0.022, 0.024];
      if (best > 0.9) {
        const w = 1 - (best - 0.9) / 0.025;
        const c = 0.24 + 0.16 * w;
        return [c, c, c * 0.98];
      }
    }

    // 网球：白色弧形缝线
    if (label === '网球') {
      const band = 0.62 * Math.sqrt(Math.max(0.05, 1 - ny * ny * 0.8));
      const d = Math.abs(Math.abs(nx) - band);
      if (d < 0.035 && Math.abs(ny) < 0.92) {
        const w = 0.68 + 0.32 * (1 - d / 0.035);
        return [seam[0] * w, seam[1] * w, seam[2] * w];
      }
    }

    const kk = Math.min(1.8, Math.max(0, k));
    return [base[0] * kk, base[1] * kk, base[2] * kk];
  });
}

function drawBox(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const s = h * 0.5;
  const topY = baseY - s * 1.35;
  const d = s * 0.42;
  // 顶面
  poly(cv, [
    [cx - s, topY],
    [cx - s + d, topY - d * 0.55],
    [cx + s + d, topY - d * 0.55],
    [cx + s, topY],
  ], tint, 1, () => 1.25);
  // 正面
  poly(cv, [
    [cx - s, topY],
    [cx + s, topY],
    [cx + s, baseY],
    [cx - s, baseY],
  ], tint, 1, (x) => 0.95 + 0.25 * (1 - (x - (cx - s)) / (2 * s)));
  // 侧面
  poly(cv, [
    [cx + s, topY],
    [cx + s + d, topY - d * 0.55],
    [cx + s + d, baseY - d * 0.55],
    [cx + s, baseY],
  ], mul(tint, 0.55));
}

function drawHouse(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const w = h * 0.42;
  const wallTop = baseY - h * 0.56;
  const roofTop = baseY - h * 0.92;
  poly(cv, [
    [cx - w, wallTop],
    [cx + w, wallTop],
    [cx + w, baseY],
    [cx - w, baseY],
  ], tint, 1, (x, y) => {
    const u = (x - (cx - w)) / (2 * w);
    const v = (y - wallTop) / Math.max(1, baseY - wallTop);
    // 墙面：砖缝 + 抹灰颗粒，避免一整片死白
    return (0.9 + 0.3 * (1 - u)) * brickGrain(u, v, 37) * grain(u, v, 18, 55, 0.04, 2);
  });
  // 屋顶
  poly(cv, [
    [cx - w * 1.16, wallTop],
    [cx, roofTop],
    [cx + w * 1.16, wallTop],
  ], mul(tint, 0.45), 1, (x) => 0.85 + 0.35 * (1 - Math.abs(x - cx) / (w * 1.2)));
  // 门
  poly(cv, [
    [cx - w * 0.24, baseY],
    [cx + w * 0.24, baseY],
    [cx + w * 0.24, baseY - h * 0.28],
    [cx - w * 0.24, baseY - h * 0.28],
  ], [0.06, 0.045, 0.035]);
  // 窗
  for (const sx of [-1, 1]) {
    poly(cv, [
      [cx + sx * w * 0.6 - w * 0.16, wallTop + h * 0.06],
      [cx + sx * w * 0.6 + w * 0.16, wallTop + h * 0.06],
      [cx + sx * w * 0.6 + w * 0.16, wallTop + h * 0.2],
      [cx + sx * w * 0.6 - w * 0.16, wallTop + h * 0.2],
    ], [0.42, 0.36, 0.16], 1, () => 1);
  }
}

function drawTree(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const trunkW = h * 0.05;
  poly(cv, [
    [cx - trunkW, baseY],
    [cx + trunkW, baseY],
    [cx + trunkW * 0.6, baseY - h * 0.55],
    [cx - trunkW * 0.6, baseY - h * 0.55],
  ], [0.14, 0.075, 0.04], 1, (x) => (x < cx ? 1.1 : 0.8));
  const canopy = [
    { x: cx, y: baseY - h * 0.72, r: h * 0.28 },
    { x: cx - h * 0.17, y: baseY - h * 0.6, r: h * 0.2 },
    { x: cx + h * 0.16, y: baseY - h * 0.64, r: h * 0.19 },
    { x: cx + h * 0.02, y: baseY - h * 0.9, r: h * 0.17 },
  ];
  for (const c2 of canopy) {
    ellipse(cv, c2.x, c2.y, c2.r, c2.r * 0.92, tint, 1, (nx, ny) => {
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      return lit(nx, ny, nz) * 0.95;
    });
  }
}

function drawFlower(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  stroke(cv, [
    [cx, baseY],
    [cx - h * 0.02, baseY - h * 0.6],
    [cx + h * 0.01, baseY - h * 0.78],
  ], h * 0.022, [0.05, 0.2, 0.07]);
  // 叶
  ellipse(cv, cx - h * 0.09, baseY - h * 0.34, h * 0.1, h * 0.045, [0.06, 0.24, 0.08], 1, () => 1);
  // 花瓣
  const headY = baseY - h * 0.86;
  const pr = h * 0.075;
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    ellipse(cv, cx + Math.cos(a) * pr * 1.25, headY + Math.sin(a) * pr * 1.25, pr, pr * 0.92, tint, 1, (nx, ny) => lit(nx, ny, 0.7));
  }
  ellipse(cv, cx, headY, pr * 0.6, pr * 0.6, [0.5, 0.34, 0.05], 1, () => 1);
}

function drawCat(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const bodyW = h * 0.36;
  const bodyH = h * 0.23;
  const bodyCy = baseY - bodyH * 1.12;
  // 尾巴
  stroke(cv, [
    [cx + bodyW * 0.8, bodyCy],
    [cx + bodyW * 1.45, bodyCy - h * 0.05],
    [cx + bodyW * 1.6, bodyCy - h * 0.22],
  ], h * 0.035, mul(tint, 0.9));
  // 身体
  ellipse(cv, cx, bodyCy, bodyW, bodyH, tint, 1, (nx, ny) => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    return lit(nx, ny, nz);
  });
  // 腿
  for (const sx of [-0.58, -0.2, 0.2, 0.6]) {
    poly(cv, [
      [cx + bodyW * sx - h * 0.028, bodyCy + bodyH * 0.45],
      [cx + bodyW * sx + h * 0.028, bodyCy + bodyH * 0.45],
      [cx + bodyW * sx + h * 0.022, baseY],
      [cx + bodyW * sx - h * 0.022, baseY],
    ], mul(tint, 0.85));
  }
  // 头
  const headR = h * 0.165;
  const headCy = bodyCy - bodyH * 0.78;
  const headCx = cx - bodyW * 0.6;
  for (const sx of [-0.6, 0.6]) {
    poly(cv, [
      [headCx + headR * sx - headR * 0.46, headCy - headR * 0.42],
      [headCx + headR * sx + headR * 0.46, headCy - headR * 0.42],
      [headCx + headR * sx * 1.08, headCy - headR * 1.55],
    ], mul(tint, 0.88));
  }
  ellipse(cv, headCx, headCy, headR, headR * 0.94, tint, 1, (nx, ny) => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    return lit(nx, ny, nz);
  });
  // 眼睛（绿）
  for (const sx of [-0.36, 0.36]) {
    ellipse(cv, headCx + headR * sx, headCy + headR * 0.05, headR * 0.13, headR * 0.17, [0.1, 0.4, 0.16], 1);
  }
}

function drawDog(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const bodyW = h * 0.36;
  const bodyH = h * 0.22;
  const bodyCy = baseY - bodyH * 1.2;
  stroke(cv, [
    [cx + bodyW * 0.9, bodyCy - h * 0.02],
    [cx + bodyW * 1.25, bodyCy - h * 0.18],
  ], h * 0.045, mul(tint, 0.9));
  ellipse(cv, cx, bodyCy, bodyW, bodyH, tint, 1, (nx, ny) => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    return lit(nx, ny, nz);
  });
  for (const sx of [-0.6, -0.24, 0.24, 0.6]) {
    poly(cv, [
      [cx + bodyW * sx - h * 0.026, bodyCy + bodyH * 0.35],
      [cx + bodyW * sx + h * 0.026, bodyCy + bodyH * 0.35],
      [cx + bodyW * sx + h * 0.022, baseY],
      [cx + bodyW * sx - h * 0.022, baseY],
    ], mul(tint, 0.85));
  }
  const headR = h * 0.165;
  const headCy = bodyCy - bodyH * 0.85;
  const headCx = cx - bodyW * 0.68;
  // 耳朵（垂耳）
  for (const sx of [-1, 1]) {
    ellipse(cv, headCx + headR * 0.95 * sx, headCy + headR * 0.18, headR * 0.3, headR * 0.55, mul(tint, 0.8), 1);
  }
  ellipse(cv, headCx, headCy, headR, headR * 0.95, tint, 1, (nx, ny) => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    return lit(nx, ny, nz);
  });
  // 口鼻
  ellipse(cv, headCx - headR * 0.55, headCy + headR * 0.28, headR * 0.42, headR * 0.3, mul(tint, 1.15), 1);
  ellipse(cv, headCx - headR * 1.0, headCy + headR * 0.18, headR * 0.12, headR * 0.1, [0.02, 0.02, 0.02], 1);
}

function drawPerson(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const headR = h * 0.085;
  const headCy = baseY - h * 0.9;
  // 腿
  poly(cv, [
    [cx - h * 0.075, baseY - h * 0.42],
    [cx - h * 0.005, baseY - h * 0.42],
    [cx - h * 0.02, baseY],
    [cx - h * 0.085, baseY],
  ], mul(tint, 0.9));
  poly(cv, [
    [cx + h * 0.005, baseY - h * 0.42],
    [cx + h * 0.075, baseY - h * 0.42],
    [cx + h * 0.085, baseY],
    [cx + h * 0.02, baseY],
  ], mul(tint, 0.9));
  // 躯干
  poly(cv, [
    [cx - h * 0.11, baseY - h * 0.42],
    [cx + h * 0.11, baseY - h * 0.42],
    [cx + h * 0.085, baseY - h * 0.74],
    [cx - h * 0.085, baseY - h * 0.74],
  ], tint, 1, (x) => lit((x - cx) / (h * 0.11), 0, 0.9));
  // 手臂
  stroke(cv, [
    [cx - h * 0.085, baseY - h * 0.7],
    [cx - h * 0.14, baseY - h * 0.52],
    [cx - h * 0.12, baseY - h * 0.38],
  ], h * 0.035, mul(tint, 0.95));
  stroke(cv, [
    [cx + h * 0.085, baseY - h * 0.7],
    [cx + h * 0.14, baseY - h * 0.52],
    [cx + h * 0.12, baseY - h * 0.38],
  ], h * 0.035, mul(tint, 0.95));
  // 头 + 肩
  ellipse(cv, cx, headCy, headR, headR * 1.08, mul(tint, 1.05), 1, (nx, ny) => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    return lit(nx, ny, nz);
  });
  poly(cv, [
    [cx - h * 0.085, baseY - h * 0.74],
    [cx + h * 0.085, baseY - h * 0.74],
    [cx + h * 0.06, baseY - h * 0.79],
    [cx - h * 0.06, baseY - h * 0.79],
  ], mul(tint, 1.05));
}

function drawCar(c: Ctx): void {
  const { cv, cx, baseY, h, tint } = c;
  const w = h * 0.62;
  const bodyTop = baseY - h * 0.34;
  const bodyBot = baseY - h * 0.1;
  // 车身
  poly(cv, [
    [cx - w, bodyBot],
    [cx - w * 0.96, bodyTop + h * 0.06],
    [cx + w * 0.96, bodyTop + h * 0.06],
    [cx + w, bodyBot],
  ], tint, 1, (x) => lit((x - cx) / w, 0, 0.95));
  // 车顶
  poly(cv, [
    [cx - w * 0.5, bodyTop + h * 0.06],
    [cx - w * 0.32, bodyTop - h * 0.2],
    [cx + w * 0.3, bodyTop - h * 0.2],
    [cx + w * 0.5, bodyTop + h * 0.06],
  ], mul(tint, 0.85), 1, (x) => 0.9 + 0.3 * (1 - Math.abs(x - cx) / w));
  // 车窗
  poly(cv, [
    [cx - w * 0.42, bodyTop + h * 0.04],
    [cx - w * 0.28, bodyTop - h * 0.15],
    [cx - w * 0.02, bodyTop - h * 0.15],
    [cx - w * 0.02, bodyTop + h * 0.04],
  ], [0.12, 0.17, 0.22], 1);
  poly(cv, [
    [cx + w * 0.02, bodyTop + h * 0.04],
    [cx + w * 0.02, bodyTop - h * 0.15],
    [cx + w * 0.26, bodyTop - h * 0.15],
    [cx + w * 0.4, bodyTop + h * 0.04],
  ], [0.12, 0.17, 0.22], 1);
  // 轮子
  for (const sx of [-0.6, 0.6]) {
    ellipse(cv, cx + w * sx, bodyBot, h * 0.11, h * 0.11, [0.02, 0.02, 0.025], 1);
    ellipse(cv, cx + w * sx, bodyBot, h * 0.055, h * 0.055, [0.14, 0.14, 0.15], 1);
  }
}

/* ------------------------------------------------------------ 场景描述 */

function describeScene(subject: Subject, tint: RGB): string {
  const colorText = subject.colorName ? `，主色偏${subject.colorName}` : '';
  const ballText = (): string => {
    if (subject.label === '篮球') return '一颗篮球：橙色皮面 + 荔枝纹颗粒 + 黑色橡胶沟槽（十字与两侧弧线）+ 左上高光 + 地面投影';
    if (subject.label === '足球') return '一颗足球：白色球面 + 黑色五边形斑块 + 球面明暗 + 地面投影';
    if (subject.label === '网球') return '一颗网球：黄绿色绒面 + 白色弧形缝线 + 左上高光 + 地面投影';
    if (subject.label === '排球') return '一颗排球：浅色球面 + 白色拼缝 + 球面明暗 + 地面投影';
    return '一个球体：球面明暗过渡 + 表面颗粒 + 左上高光 + 地面投影';
  };
  const base: Record<SubjectKind, string> = {
    table: '一张长方形桌子：透视桌面 + 前缘厚度 + 四条桌腿，桌面有木纹与细颗粒',
    chair: '一把椅子：靠背、座面与四条腿，侧向受光',
    cup: '一只带提手的杯子：杯口椭圆内壁、杯身斜面与柔和投影',
    bottle: '一只瓶子：瓶身收肩到瓶颈，带竖向高光与瓶盖',
    ball: ballText(),
    box: '一个立方体：顶面 / 正面 / 侧面三面受光不同，表面有细微颗粒',
    house: '一栋房子：墙体（带砖缝）+ 双坡屋顶 + 门与两扇窗',
    tree: '一棵树：树干与四团树冠，冠层有球面明暗',
    flower: '一朵花：花茎、叶片与六片花瓣围成的花冠',
    cat: '一只猫：身体、四条腿、三角耳与眼睛，尾巴向右上翘起',
    dog: '一只狗：身体、四条腿、垂耳与口鼻，尾巴向右上',
    person: '一个人物剪影：头部、肩线、躯干、双臂与双腿',
    car: '一辆汽车：车身、车顶、两块车窗与两个车轮',
    none: '',
  };
  const tone = tint[0] > tint[2] ? '暖调' : '冷调';
  return `程序化插画（内置渲染，非照片）：${base[subject.kind]}${colorText}；整体${tone}，左上主光，底部有接触阴影。`;
}

/* ------------------------------------------------------------ 对外入口 */

export interface DrawOptions {
  width: number;
  height: number;
  /** 地平线比例（0-1），物体底部落在这条线稍下方 */
  horizon: number;
  subject: Subject;
}

export interface DrawResult {
  drawn: boolean;
  description: string;
}

export function drawSubject(lin: Float32Array, opts: DrawOptions): DrawResult {
  const { width, height, horizon, subject } = opts;
  if (subject.kind === 'none') return { drawn: false, description: '' };

  const cv: Canvas = { lin, width, height };
  const tint = subject.color ?? DEFAULT_TINT[subject.kind];
  const baseY = Math.min(height * 0.94, height * (horizon + 0.1));
  // 高瘦物体（瓶子 / 人物 / 树）给更高的尺寸，扁平物体（桌子 / 车）给小一点
  const tall = subject.kind === 'bottle' || subject.kind === 'person' || subject.kind === 'tree' || subject.kind === 'flower';
  // 球类给更大画幅：小圆球在 1024 画布上容易显得空
  const ratio = subject.kind === 'ball' ? 0.56 : tall ? 0.46 : 0.4;
  const h = height * ratio;
  const ctx: Ctx = {
    cv,
    cx: width * 0.5,
    baseY,
    h,
    tint,
    label: subject.label,
    hasColor: !!subject.color,
  };

  contactShadow(cv, ctx.cx, baseY, h * (subject.kind === 'car' ? 0.78 : 0.5), h * 0.075, 0.4);

  switch (subject.kind) {
    case 'table':
      drawTable(ctx);
      break;
    case 'chair':
      drawChair(ctx);
      break;
    case 'cup':
      drawCup(ctx);
      break;
    case 'bottle':
      drawBottle(ctx);
      break;
    case 'ball':
      drawBall(ctx);
      break;
    case 'box':
      drawBox(ctx);
      break;
    case 'house':
      drawHouse(ctx);
      break;
    case 'tree':
      drawTree(ctx);
      break;
    case 'flower':
      drawFlower(ctx);
      break;
    case 'cat':
      drawCat(ctx);
      break;
    case 'dog':
      drawDog(ctx);
      break;
    case 'person':
      drawPerson(ctx);
      break;
    case 'car':
      drawCar(ctx);
      break;
    default:
      return { drawn: false, description: '' };
  }

  return { drawn: true, description: describeScene(subject, tint) };
}
