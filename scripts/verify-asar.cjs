#!/usr/bin/env node
/**
 * 打包后断言：asar 内的 package.json 版本号必须和仓库根一致。
 *
 * 背景：1.3.2 打包时先复制了 package.json、之后才升版本号，结果 asar 里还是旧版本，
 * 装完 app.getVersion() 仍是上一版，软件一直提示「有新版本」。这个脚本把这类错误
 * 挡在发布之前。
 *
 * 用法：node scripts/verify-asar.cjs [asar 路径] [期望版本]
 */
const fs = require('node:fs');
const path = require('node:path');

const asarPath = process.argv[2] || path.join(__dirname, '..', 'release-build', 'app.asar');
const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const expected = process.argv[3] || rootPkg.version;

if (!fs.existsSync(asarPath)) {
  console.error(`[verify-asar] 找不到 asar：${asarPath}`);
  process.exit(1);
}

const asar = require('@electron/asar');
const pack = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));

const problems = [];
if (pack.version !== expected) {
  problems.push(`版本号不一致：asar 内 ${pack.version}，期望 ${expected}（会导致装完仍显示旧版本、反复提示更新）`);
}

// 关键文件存在性：前端入口、主进程、内置模型说明
const files = asar.listPackage(asarPath).map(f => f.replace(/\\/g, '/'));
for (const need of ['/dist/index.html', '/dist-electron/main.cjs']) {
  if (!files.some(f => f.endsWith(need))) problems.push(`asar 缺少 ${need}`);
}

if (problems.length) {
  console.error('[verify-asar] 失败：\n- ' + problems.join('\n- '));
  process.exit(1);
}

console.log(`[verify-asar] OK · 版本 ${pack.version} · 文件 ${files.length} 个 · ${asarPath}`);
