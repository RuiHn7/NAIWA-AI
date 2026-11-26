/* ============================================================================
 * desktop/agent/update.ts —— 版本检查
 *
 *   默认从 GitHub Releases 取最新 tag；仓库没有 release 时退一步读 tags，
 *   再退一步直接读 package.json 里的 version（master/main 分支）。
 *   任何一步都能失败，失败就返回 reason，绝不让 UI 卡在「检查中」。
 * ==========================================================================*/

import { app } from 'electron';

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
