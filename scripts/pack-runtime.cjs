#!/usr/bin/env node
/**
 * 把主进程的运行时依赖复制进打包目录（app/node_modules），并按平台裁剪。
 *
 * 目前只有 onnxruntime-node 需要在运行时从 node_modules 加载（原生 .node 不能进 asar bundle）。
 * 它自带 darwin / linux / win32 多平台二进制，全部打进去会多出 90MB，这里只保留目标平台。
 *
 * 用法：node scripts/pack-runtime.cjs <目标 app 目录> [win32-x64|darwin-arm64|...]
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const srcRoot = path.join(root, 'node_modules');
const destRoot = process.argv[2];
const platform = process.argv[3] || `${process.platform}/${process.arch}`;

if (!destRoot) {
  console.error('用法：node scripts/pack-runtime.cjs <目标 app 目录> [平台]');
  process.exit(1);
}

const ROOTS = ['onnxruntime-node'];
/** 只保留这些包的完整内容；其余依赖整包复制 */
const seen = new Set();

function shouldSkip(rel) {
  const norm = rel.split(path.sep).join('/');
  if (norm.startsWith('node_modules/')) return true; // 嵌套依赖单独复制
  const bin = norm.match(/^bin\/napi-v6\/([^/]+)(?:\/([^/]+))?/);
  if (bin) {
    const [keepOs, keepArch] = platform.split('/');
    if (bin[1] !== keepOs) return true;
    // 平台目录本身保留（里面还有 arch 子目录），其它 arch 整棵跳过
    if (bin[2] && bin[2] !== keepArch) return true;
    // Windows CPU 推理只需要 onnxruntime.dll + binding.node；
    // DirectML.dll / dxcompiler.dll 是 GPU 路径，占 36MB，直接省掉
    if (keepOs === 'win32' && /\/x64\/./.test(norm)) {
      const base = path.basename(norm);
      if (!/^(onnxruntime\.dll|onnxruntime_binding\.node)$/i.test(base)) return true;
    }
    return false;
  }
  if (/(^|\/)test(s)?\//.test(norm)) return true;
  return false;
}

function copyDir(src, dst, rel = '') {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (shouldSkip(childRel)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to, childRel);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function copyPkg(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const src = path.join(srcRoot, name);
  const pkgFile = path.join(src, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    console.warn(`[pack-runtime] 缺少依赖 ${name}，跳过`);
    return;
  }
  copyDir(src, path.join(destRoot, 'node_modules', name));
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  for (const dep of Object.keys(pkg.dependencies || {})) copyPkg(dep);
}

fs.mkdirSync(path.join(destRoot, 'node_modules'), { recursive: true });
for (const name of ROOTS) copyPkg(name);
console.log(`[pack-runtime] 已复制 ${seen.size} 个包 · 平台 ${platform} → ${path.join(destRoot, 'node_modules')}`);
