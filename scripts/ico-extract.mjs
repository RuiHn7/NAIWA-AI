/* ============================================================================
 * scripts/ico-extract.mjs —— 从 .ico 里抽出最大的一帧，存成 PNG
 *   用法：node scripts/ico-extract.mjs <src.ico> <out.png>
 *   说明：System.Drawing.Icon 只会取到第一个（通常最小）帧，所以直接解 ICO
 *   目录，找到面积最大的那一帧，PNG 帧原样写出、BMP 帧再转码。
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';

const [, , src, out] = process.argv;
if (!src || !out) {
  console.error('usage: node scripts/ico-extract.mjs <src.ico> <out.png>');
  process.exit(1);
}

const buf = fs.readFileSync(src);
if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
  console.error('不是合法的 .ico 文件');
  process.exit(1);
}

const count = buf.readUInt16LE(4);
let best = null;
for (let i = 0; i < count; i += 1) {
  const o = 6 + i * 16;
  const w = buf[o] === 0 ? 256 : buf[o];
  const h = buf[o + 1] === 0 ? 256 : buf[o + 1];
  const size = buf.readUInt32LE(o + 8);
  const offset = buf.readUInt32LE(o + 12);
  const row = { w, h, size, offset };
  if (!best || row.w * row.h > best.w * best.h) best = row;
  console.log(`frame ${i}: ${w}x${h} size=${size}`);
}

if (!best) {
  console.error('ICO 里没有任何帧');
  process.exit(1);
}

const frame = buf.subarray(best.offset, best.offset + best.size);
const isPng = frame.length > 8 && frame[0] === 0x89 && frame[1] === 0x50 && frame[2] === 0x4e && frame[3] === 0x47;

if (isPng) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, frame);
  console.log(`已写出 PNG 帧 ${best.w}x${best.h} -> ${out}`);
} else {
  // 非 PNG 帧（老式 BMP）交给调用方用 System.Drawing 处理，这里只报尺寸
  console.log(`最大帧是 BMP 格式 ${best.w}x${best.h}，请改用 System.Drawing 处理`);
  process.exit(2);
}
