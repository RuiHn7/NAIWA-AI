/* 扫描 src/ 里没有经过 t()/translate() 的中文字面量，输出可疑行 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(process.cwd(), 'src');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && e.name !== 'i18n.ts') files.push(p);
  }
})(root);

const CJK = /[\u4e00-\u9fa5]/;
const OK = /t\(|translate\(|currentLocale/;

let count = 0;
for (const f of files) {
  const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  let inBlock = false;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (!CJK.test(line)) return;
    if (OK.test(line)) return;
    count += 1;
    console.log(`${rel}:${i + 1}: ${trimmed}`);
  });
}
console.log(`--- ${count} suspicious line(s)`);
