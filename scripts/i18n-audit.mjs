/* 找出所有 t('...') / translate('...') 用到但 EN 里没有的键 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const i18nSrc = fs.readFileSync(path.join(root, 'src/lib/i18n.ts'), 'utf8');

const body = i18nSrc.slice(i18nSrc.indexOf('export const EN'));
const keys = new Set();
for (const raw of body.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('/*') || line.startsWith('*') || line.startsWith('//')) continue;
  if (line === '};') break;
  const m = /^(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^:'"]+?))\s*:\s*(?:\S|$)/.exec(line);
  if (!m) continue;
  const k = (m[1] ?? m[2] ?? m[3]).trim();
  if (k) keys.add(k);
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && e.name !== 'i18n.ts') files.push(p);
  }
})(path.join(root, 'src'));

const used = [];
const callRe = /\b(?:t|tr|translate|T)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
for (const f of files) {
  const rel = path.relative(root, f).replace(/\\/g, '/');
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    callRe.lastIndex = 0;
    let c;
    while ((c = callRe.exec(line))) {
      const lit = c[1] ?? c[2];
      if (!lit || !/[\u4e00-\u9fa5]/.test(lit)) continue;
      used.push({ rel, line: i + 1, lit });
    }
  });
}

const missing = new Map();
for (const u of used) {
  if (keys.has(u.lit)) continue;
  const prev = missing.get(u.lit) ?? [];
  prev.push(`${u.rel}:${u.line}`);
  missing.set(u.lit, prev);
}

console.log(`EN keys: ${keys.size} · CJK call sites: ${used.length} · missing: ${missing.size}`);
for (const [lit, where] of missing) {
  console.log(`MISSING  ${lit}   <- ${where.slice(0, 3).join(', ')}`);
}
