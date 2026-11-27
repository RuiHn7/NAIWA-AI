#!/usr/bin/env node
/**
 * 取 llama.cpp 的 Windows Vulkan 运行时，裁剪成只够 llama-server 识图用的最小集合。
 *
 * 为什么要脚本而不是直接把二进制塞进仓库：
 *   · 二进制 ~38MB 压缩 / ~90MB 解压，git 历史会被撑爆；
 *   · 版本要能跟 llama.cpp 的模型兼容性一起升级，脚本里改个 tag 就行。
 *
 * 用法：
 *   node scripts/fetch-llama.mjs           # 下载 → 解压 → 裁剪
 *   node scripts/fetch-llama.mjs --force   # 忽略已有文件重新来一遍
 *
 * 产物：assets/llama（已被 .gitignore 忽略，打包时由 electron-builder 的
 * extraResources 复制到 resources/llama）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 固定版本：llama.cpp 的 Windows Vulkan 构建，兼容 NVIDIA / AMD / Intel 核显 */
const BUILD = process.env.LLAMA_BUILD || 'b12815';
const ZIP = `llama-${BUILD}-bin-win-vulkan-x64.zip`;
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${ZIP}`;

/** 只留 llama-server 及其依赖；其余 CLI / 调试工具全部删掉 */
const KEEP = [
  /^llama-server\.exe$/,
  /^llama-server-impl\.dll$/,
  /^llama\.dll$/,
  /^llama-common\.dll$/,
  /^mtmd\.dll$/,
  /^ggml\.dll$/,
  /^ggml-base\.dll$/,
  /^ggml-vulkan\.dll$/,
  /^ggml-cpu-[a-z0-9]+\.dll$/,
  /^libomp\.dll$/,
  /^LICENSE/i,
];

const outDir = path.join(root, 'assets', 'llama');

async function download(target) {
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${URL}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body.getReader();
  const fd = await fsp.open(target, 'w');
  let received = 0;
  let mark = Date.now();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await fd.write(Buffer.from(value));
      received += value.length;
      if (Date.now() - mark > 500) {
        mark = Date.now();
        const pct = total ? ((received / total) * 100).toFixed(0) : '?';
        process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB (${pct}%)`);
      }
    }
    process.stdout.write('\n');
  } finally {
    await fd.close();
  }
}

async function extract(zip, dest) {
  if (process.platform !== 'win32') {
    await run('unzip', ['-o', zip, '-d', dest]);
    return;
  }
  await run('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
  ]);
}

async function main() {
  const force = process.argv.includes('--force');
  const exe = path.join(outDir, 'llama-server.exe');
  if (!force && fs.existsSync(exe)) {
    console.log(`[fetch-llama] 运行时已存在：${outDir}（要重下加 --force）`);
    return;
  }

  await fsp.mkdir(outDir, { recursive: true });
  const tmp = path.join(os.tmpdir(), ZIP);
  console.log(`[fetch-llama] 下载 ${BUILD} …`);
  await download(tmp);
  console.log(`[fetch-llama] 解压到 ${outDir}`);
  await extract(tmp, outDir);
  await fsp.rm(tmp, { force: true });

  // 裁剪：先删掉不在白名单里的文件
  const entries = await fsp.readdir(outDir, { withFileTypes: true });
  let removed = 0;
  let keptBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (KEEP.some(re => re.test(entry.name))) {
      keptBytes += fs.statSync(path.join(outDir, entry.name)).size;
      continue;
    }
    await fsp.rm(path.join(outDir, entry.name), { force: true });
    removed += 1;
  }
  console.log(
    `[fetch-llama] 完成：保留 ${entries.length - removed} 个文件 · ${(keptBytes / 1024 / 1024).toFixed(1)} MB（删掉 ${removed} 个）`,
  );
  if (!fs.existsSync(exe)) throw new Error('解压后没有 llama-server.exe，请检查构建产物命名是否变了');
}

main().catch(err => {
  console.error(`[fetch-llama] 失败：${err.message}`);
  process.exit(1);
});
