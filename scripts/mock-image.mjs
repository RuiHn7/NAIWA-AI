/* ============================================================================
 * scripts/mock-image.mjs —— 本地图片生成 mock
 *   支持两种后端：
 *     · sdwebui：POST /sdapi/v1/txt2img  →  { images: [base64png] }
 *     · openai ：POST /images/generations →  { data: [{ b64_json }] }
 *   用法：node scripts/mock-image.mjs 8798
 * ==========================================================================*/

import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.argv[2] || 8798);

/** 生成一张 w×h 的纯色 PNG（带一点渐变色带，方便肉眼区分） */
function makePng(w = 256, h = 256, tint = [0x2b, 0x7c, 0xc4]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const k = 0.35 + 0.65 * (x / w);
      raw[o++] = Math.min(255, Math.round(tint[0] * k + 20));
      raw[o++] = Math.min(255, Math.round(tint[1] * k + 30));
      raw[o++] = Math.min(255, Math.round(tint[2] * k + 40));
    }
  }
  const idat = zlib.deflateSync(raw);

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const readBody = req =>
  new Promise(resolve => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });

const TINTS = [
  [0x2b, 0x7c, 0xc4],
  [0xc4, 0x7a, 0x2b],
  [0x2b, 0xc4, 0x8a],
  [0x8a, 0x2b, 0xc4],
];

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (req.method === 'POST' && url.startsWith('/sdapi/v1/txt2img')) {
    const raw = await readBody(req);
    let n = 1;
    try {
      const body = JSON.parse(raw);
      n = Math.max(1, Math.min(4, Number(body.batch_size) || 1));
    } catch {
      /* 忽略 */
    }
    const images = [];
    for (let i = 0; i < n; i++) images.push(makePng(256, 256, TINTS[i % TINTS.length]).toString('base64'));
    console.log(`[sdwebui] txt2img → ${n} 张`);
    return send(200, { images, info: JSON.stringify({ mock: true }) });
  }

  if (req.method === 'POST' && url.startsWith('/images/generations')) {
    const raw = await readBody(req);
    let n = 1;
    try {
      n = Math.max(1, Math.min(4, Number(JSON.parse(raw).n) || 1));
    } catch {
      /* 忽略 */
    }
    const data = [];
    for (let i = 0; i < n; i++) data.push({ b64_json: makePng(256, 256, TINTS[i % TINTS.length]).toString('base64') });
    console.log(`[openai] images/generations → ${n} 张`);
    return send(200, { data, created: Math.floor(Date.now() / 1000) });
  }

  if (url.startsWith('/v1/models')) return send(200, { data: [{ id: 'mock-image' }] });

  console.log(`[404] ${req.method} ${url}`);
  return send(404, { error: { message: 'not found' } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock image server on http://127.0.0.1:${PORT}`);
});
