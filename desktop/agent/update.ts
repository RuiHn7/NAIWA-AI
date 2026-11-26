/* ============================================================================
 * desktop/agent/update.ts —— 版本检查
 *
 *   默认从 GitHub Releases 取最新 tag；仓库没有 release 时退一步读 tags，
 *   再退一步直接读 package.json 里的 version（master/main 分支）。
 *   任何一步都能失败，失败就返回 reason，绝不让 UI 卡在「检查中」。
 * ==========================================================================*/

import { app, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const REPO = 'RuiHn7/NAIWA-AI';

/** "1.2.3" / "v1.2.3-beta.1" → [1,2,3] */
function parseVersion(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map(n => Number.parseInt(n, 10) || 0);
}

/** a 是否比 b 新 */
export function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** Release 里挂的安装包 */
export interface UpdateAsset {
  name: string;
  url: string;
  /** 字节数，0 表示未知 */
  size: number;
  /** SHA-256（十六进制），没有就不校验 */
  sha256?: string;
}

export interface UpdateCheck {
  ok: boolean;
  current: string;
  latest?: string;
  url?: string;
  reason?: string;
  /** 发布时间（ISO），没有就空 */
  publishedAt?: string;
  /** 版本说明，取自 release body 或 commit message */
  notes?: string;
  source?: 'release' | 'tag' | 'package' | 'manifest';
  /** 当前平台可用的安装包；没有就只能在浏览器里下 */
  installer?: UpdateAsset;
}

/** 按平台挑安装包：Windows 优先 Setup-*.exe，mac 挑 dmg，linux 挑 AppImage */
function pickInstaller(assets: unknown): UpdateAsset | undefined {
  if (!Array.isArray(assets)) return undefined;
  const list = assets
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map(a => ({
      name: String(a.name ?? ''),
      url: String(a.browser_download_url ?? ''),
      size: Number(a.size ?? 0) || 0,
      sha256: typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : undefined,
    }))
    .filter(a => a.name && /^https:\/\//i.test(a.url));

  const platform = process.platform;
  const patterns =
    platform === 'win32' ? [/\.exe$/i] : platform === 'darwin' ? [/\.dmg$/i] : [/\.appimage$/i, /\.deb$/i];
  for (const pattern of patterns) {
    const hit =
      list.find(a => pattern.test(a.name) && /setup|install|nai-wa/i.test(a.name)) ??
      list.find(a => pattern.test(a.name));
    if (hit) return hit;
  }
  return undefined;
}

async function getJson(url: string, timeoutMs = 8000): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'NAI-WA-Desktop' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 自定义更新源优先（企业内网 / 自建分发），否则走 GitHub */
async function fromManifest(manifest: string): Promise<UpdateCheck | null> {
  try {
    const res = await fetch(manifest, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string; url?: string; notes?: string };
    if (!json.version) return null;
    return {
      ok: true,
      current: app.getVersion(),
      latest: json.version,
      url: json.url ?? `https://github.com/${REPO}`,
      notes: json.notes,
      source: 'manifest',
    };
  } catch {
    return null;
  }
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = app.getVersion();
  const manifest = process.env.NAIWA_UPDATE_MANIFEST ?? '';
  if (manifest) {
    const hit = await fromManifest(manifest);
    if (hit) return hit;
  }

  // 1) 正式 release
  const release = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (release?.tag_name) {
    return {
      ok: true,
      current,
      latest: String(release.tag_name).replace(/^v/i, ''),
      url: release.html_url ?? `https://github.com/${REPO}/releases`,
      publishedAt: release.published_at,
      notes: typeof release.body === 'string' ? release.body.slice(0, 1200) : undefined,
      source: 'release',
      installer: pickInstaller(release.assets),
    };
  }

  // 2) 没有 release 就读 tags（仓库刚建、只推过 tag 的情况）
  const tags = await getJson(`https://api.github.com/repos/${REPO}/tags?per_page=10`);
  if (Array.isArray(tags) && tags.length > 0) {
    const name = String(tags[0].name ?? '');
    if (name) {
      return {
        ok: true,
        current,
        latest: name.replace(/^v/i, ''),
        url: `https://github.com/${REPO}/tags`,
        source: 'tag',
      };
    }
  }

  // 3) 最后读默认分支上的 package.json —— 保证「有更新」这件事一定能被发现
  for (const branch of ['main', 'master']) {
    const pkg = await getJson(`https://raw.githubusercontent.com/${REPO}/${branch}/package.json`);
    if (pkg?.version) {
      return {
        ok: true,
        current,
        latest: String(pkg.version),
        url: `https://github.com/${REPO}`,
        source: 'package',
      };
    }
  }

  return {
    ok: false,
    current,
    reason: '连不上 GitHub 或仓库还没有可读的版本信息',
    url: `https://github.com/${REPO}`,
  };
}

/* ------------------------------------------------------- 应用内下载与安装 */

/** 只允许从 GitHub 官方域名下载，防止被篡改成任意地址 */
const TRUSTED_HOST = /^https:////(github/.com|objects/.githubusercontent/.com|release-assets/.githubusercontent/.com)///i;

export interface DownloadProgress {
  phase: 'downloading' | 'verifying' | 'done';
  received: number;
  total: number;
  /** 0-100，total 未知时是 0 */
  percent: number;
}

/**
 * 把安装包下到临时目录。已存在且大小一致时直接复用（断点续传的简化版：
 * 至少重复点「下载」不会重下一遍 100MB）。
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  onProgress: (p: DownloadProgress) => void,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!TRUSTED_HOST.test(asset.url)) {
    return { ok: false, error: `拒绝从非 GitHub 域名下载：${asset.url}` };
  }
  const dir = path.join(app.getPath('temp'), 'naiwa-updates');
  await fsp.mkdir(dir, { recursive: true });
  const safeName = asset.name.replace(/[^\w.\-]+/g, '_') || 'naiwa-update.exe';
  const file = path.join(dir, safeName);

  try {
    const stat = await fsp.stat(file);
    if (!asset.size || stat.size === asset.size) {
      onProgress({ phase: 'done', received: stat.size, total: stat.size, percent: 100 });
      return { ok: true, path: file };
    }
  } catch {
    /* 没下过就正常下载 */
  }

  let res: Response;
  try {
    res = await fetch(asset.url, {
      headers: { 'user-agent': 'NAI-WA-Desktop' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch (err) {
    return { ok: false, error: `连不上下载地址：${(err as Error).message}` };
  }
  if (!res.ok || !res.body) return { ok: false, error: `下载失败：HTTP ${res.status}` };

  const total = Number(res.headers.get('content-length') ?? 0) || asset.size || 0;
  const handle = await fsp.open(file, 'w');
  let received = 0;
  let lastTick = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      await handle.write(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastTick > 200) {
        lastTick = now;
        onProgress({ phase: 'downloading', received, total, percent: total ? Math.round((received / total) * 100) : 0 });
      }
    }
  } catch (err) {
    return { ok: false, error: `下载中断：${(err as Error).message}` };
  } finally {
    await handle.close();
  }

  onProgress({ phase: 'verifying', received, total, percent: 100 });
  if (total && received !== total) {
    return { ok: false, error: `下载不完整（${received}/${total} 字节），请重试。` };
  }
  if (asset.sha256) {
    try {
      const buf = await fsp.readFile(file);
      const got = createHash('sha256').update(buf).digest('hex');
      if (got.toLowerCase() !== asset.sha256.toLowerCase()) {
        return { ok: false, error: '安装包校验失败（SHA-256 不一致），已中止，请重新下载。' };
      }
    } catch (err) {
      return { ok: false, error: `校验失败：${(err as Error).message}` };
    }
  }
  onProgress({ phase: 'done', received, total, percent: 100 });
  return { ok: true, path: file };
}

/** 启动安装程序并退出应用，让安装器接管文件替换 */
export async function launchInstaller(file: string): Promise<{ ok: boolean; error?: string }> {
  if (!file || !fs.existsSync(file)) return { ok: false, error: '安装包不存在，请重新下载。' };
  if (process.platform === 'win32') {
    if (!/\.exe$/i.test(file)) return { ok: false, error: '这个文件不是 Windows 安装包（.exe）。' };
    try {
      const child = spawn(file, [], { detached: true, stdio: 'ignore' });
      child.unref();
      // 给安装器一点时间起来，再退出自己，避免「文件正在使用」
      setTimeout(() => app.quit(), 800);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `启动安装程序失败：${(err as Error).message}` };
    }
  }
  const err = await shell.openPath(file);
  if (err) return { ok: false, error: err };
  setTimeout(() => app.quit(), 800);
  return { ok: true };
}
