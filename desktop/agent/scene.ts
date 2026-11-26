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
  { match: /(篮球|足球|球体|圆球|球|ball|sphere)/i, kind: 'ball', label: '球体' },
  { match: /(盒子|方块|立方体|纸箱|box|cube)/i, kind: 'box', label: '方块' },
  { match: /(房子|小屋|房屋|别墅|木屋|house|cabin|cottage)/i, kind: 'house', label: '房子' },
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

/** 粗线（描边）：沿折线撒圆点，用来画提手、花茎、尾巴 */
function stroke(cv: Canvas, pts: number[][], width: number, rgb: RGB, alpha = 1): void {
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
  ], tint, 1, (x, y) => 0.95 + 0.35 * (1 - (y - topY) / (h * 0.16)));
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
  const { cv, cx, baseY, h, tint } = c;
  const r = h * 0.42;
  const cy = baseY - r;
  ellipse(cv, cx, cy, r, r, tint, 1, (nx, ny) => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const d = lit(nx, ny, nz);
    const spec = Math.exp(-(((nx + 0.42) ** 2 + (ny + 0.5) ** 2) / 0.02)) * 0.55;
    return d + spec;
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
  ], tint, 1, (x) => 0.9 + 0.3 * (1 - (x - (cx - w)) / (2 * w)));
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
  const base: Record<SubjectKind, string> = {
    table: '一张长方形桌子：透视桌面 + 前缘厚度 + 四条桌腿，桌下有接触阴影',
    chair: '一把椅子：靠背、座面与四条腿，侧向受光',
    cup: '一只带提手的杯子：杯口椭圆内壁、杯身斜面与柔和投影',
    bottle: '一只瓶子：瓶身收肩到瓶颈，带竖向高光与瓶盖',
    ball: '一个球体：球面明暗过渡 + 左上高光 + 地面投影',
    box: '一个立方体：顶面 / 正面 / 侧面三面受光不同',
    house: '一栋房子：墙体 + 双坡屋顶 + 门与两扇窗',
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
  const h = height * (tall ? 0.46 : 0.4);
  const ctx: Ctx = { cv, cx: width * 0.5, baseY, h, tint };

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
