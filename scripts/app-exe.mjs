/* ============================================================================
 * scripts/app-exe.mjs —— 生成「进程名是 NAI WA」的开发版启动器
 *
 * 背景：开发版直接跑 node_modules/electron/dist/electron.exe，任务管理器里
 * 只能看到 Electron。这里把同一个 exe 复制成 `NAI WA.exe`（放在同一目录，
 * 兄弟 DLL / resources / locales 都还在原位），再用 rcedit 改写版本资源里的
 * FileDescription / ProductName / InternalName 与图标，这样任务管理器、
 * 任务栏分组、通知标题都显示 NAI WA，而未打包的运行方式完全不变。
 *
 * 用法：node scripts/app-exe.mjs        生成（已存在且比源 exe 新则跳过）
 *       node scripts/app-exe.mjs --force 强制重建
 * ==========================================================================*/

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const force = process.argv.includes('--force');

/** 复制出来的启动器路径（与 electron.exe 同目录，依赖同级资源） */
export const APP_EXE_NAME = 'NAI WA.exe';

export function appExePath() {
  return path.join(path.dirname(electronPath), APP_EXE_NAME);
}

/** rcedit 的几种可能位置（electron-builder / electron-winstaller 都会带一份） */
function findRcedit() {
  const candidates = [
    path.join(root, 'node_modules/electron-winstaller/vendor/rcedit.exe'),
    path.join(root, 'node_modules/electron-builder/templates/nsis/rcedit.exe'),
    path.join(root, 'node_modules/rcedit/bin/rcedit-x64.exe'),
    path.join(root, 'node_modules/rcedit/bin/rcedit.exe'),
  ];
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

export function ensureAppExe() {
  const src = electronPath;
  const dst = appExePath();
  if (!fs.existsSync(src)) return null;

  const needCopy = force || !fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs;
  if (!needCopy) return dst;

  fs.copyFileSync(src, dst);

  const rcedit = findRcedit();
  if (rcedit) {
    const icon = path.join(root, 'build/icon.ico');
    const args = [
      dst,
      '--set-version-string', 'FileDescription', 'NAI WA',
      '--set-version-string', 'ProductName', 'NAI WA',
      '--set-version-string', 'InternalName', 'NAI WA',
      '--set-version-string', 'OriginalFilename', APP_EXE_NAME,
      '--set-file-version', '1.0.0.0',
      '--set-product-version', '1.0.0.0',
    ];
    if (fs.existsSync(icon)) args.push('--set-icon', icon);
    try {
      execFileSync(rcedit, args, { stdio: 'ignore' });
    } catch {
      /* rcedit 失败不影响启动，只是进程名回退成 Electron */
    }
  }
  return dst;
}

if (process.argv[1] && process.argv[1].endsWith('app-exe.mjs')) {
  const out = ensureAppExe();
  console.log(out ? `[app-exe] ${out}` : '[app-exe] 找不到 electron 可执行文件');
}
