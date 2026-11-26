/* ============================================================================
 * scripts/mock-tap.mjs —— 抓包代理：把请求体原样转给 mock-llm 并落盘
 *   用法：node scripts/mock-tap.mjs 8800 8799
 *   产物：scripts/tap.jsonl（每行一个 {at, path, body}）
 *   用途：验证 reasoning_content 等字段是否真的回传给了 API
 * ==========================================================================*/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2] || 8800);
const UPSTREAM = Number(process.argv[3] || 8799);
const LOG = path.join(process.cwd(), 'scripts', 'tap.jsonl');

fs.writeFileSync(LOG, '');

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      let parsed = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* 非 JSON 原样记录 */
      }
      fs.appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), url: req.url, body: parsed })}\n`);
    }

    const up = http.request(
      {
        host: '127.0.0.1',
        port: UPSTREAM,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM}`, 'content-length': Buffer.byteLength(raw) },
      },
      upRes => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', err => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `tap upstream error: ${err.message}` } }));
    });
    up.end(raw);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-tap] ${PORT} -> ${UPSTREAM}, log ${LOG}`);
});
