/* ============================================================================
 * src/components/settings/UpdateSection.tsx —— 软件更新
 *   · 默认检查 GitHub RuiHn7/NAIWA-AI 的最新版本
 *   · 打开软件时自动检查（bootstrap 里触发，结果存 store）
 *   · 发现新版本 → 主页用户卡片上方出现蓝色「新版本」胶囊
 * ==========================================================================*/

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { Card, Group } from './ui';
const REPO_URL = 'https://github.com/RuiHn7/NAIWA-AI';

/** app:info 的子集，这里只关心版本号 */
interface AppInfoLite {
  version: string;
}

export function UpdateSection() {
  const t = useT();
  const settings = useApp(s => s.settings);
  const saveSettings = useApp(s => s.saveSettings);
  const update = useApp(s => s.update);
  const checkUpdate = useApp(s => s.checkUpdate);

  const [busy, setBusy] = useState(false);
  // 当前版本优先用主进程给的（app:info），免得检查还没回来时显示成「—」
  const [version, setVersion] = useState('');

  useEffect(() => {
    invoke('app:info', undefined)
      .then((info: AppInfoLite) => setVersion(info.version))
      .catch(() => setVersion(''));
  }, []);

  // 进这个页面时如果还没检查过，顺手查一次
  useEffect(() => {
    if (!update?.checkedAt) void checkUpdate({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    setBusy(true);
    try {
      await checkUpdate({ silent: false });
    } finally {
      setBusy(false);
    }
  };

  const latest = update?.latest;
  const newer = update?.hasUpdate;
  const openUrl = () => {
    void invoke('workspace:open-path', { path: update?.url ?? REPO_URL });
  };

  const autoOn = settings?.autoUpdate !== false;

  return (
    <Group title={t('版本')} desc={t('默认检查 GitHub 上 RuiHn7/NAIWA-AI 的最新版本。')}>
      <Card
        title={
          <span className="row gap-6">
            {t('当前版本')}
            <span className="mono">{update?.current || version || '—'}</span>
            {newer && (
              <span className="badge" data-tone="accent">
                {t('有新版本')} {latest}
              </span>
            )}
          </span>
        }
        sub={
          update?.checkedAt
            ? `${t('上次检查')} ${new Date(update.checkedAt).toLocaleString()}`
            : t('还没有检查过')
        }
        actions={
          <button
            type="button"
            className="btn"
            data-variant="primary"
            data-size="sm"
            onClick={() => void run()}
            disabled={busy}
          >
            <Icon name="refresh" size={12} />
            {busy ? t('检查中…') : t('检查更新')}
          </button>
        }
      >
        {update?.error ? (
          <div className="field-hint" data-tone="warn">
            <Icon name="alert" size={11} />
            {update.error}
          </div>
        ) : newer ? (
          <div className="row gap-8 wrap">
            <span>
              {t('新版本')} <span className="mono">{latest}</span>
              {update?.publishedAt ? ` · ${new Date(update.publishedAt).toLocaleDateString()}` : ''}
            </span>
            <button type="button" className="btn" data-size="sm" onClick={openUrl}>
              <Icon name="external" size={12} />
              {t('打开下载页')}
            </button>
          </div>
        ) : (
          <div className="dim">{update ? t('已经是最新版本。') : t('点右边的按钮检查一次。')}</div>
        )}
        {newer && update?.notes && <pre className="update-notes">{update.notes}</pre>}
      </Card>

      <Card title={t('自动检查')} sub={t('每次启动时查一次，有新版就在侧栏显示胶囊。')}>
        <div className="row gap-10">
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={autoOn}
            data-on={autoOn ? 'true' : 'false'}
            onClick={() => void saveSettings({ autoUpdate: !autoOn })}
          />
          <span>{t('打开软件后自动检查新版本')}</span>
        </div>
      </Card>

      <Card title={t('更新源')} sub={REPO_URL}>
        <div className="mono dim" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
          {REPO_URL}
        </div>
        <div className="row gap-8" style={{ marginTop: 10 }}>
          <button type="button" className="btn" data-size="sm" onClick={openUrl}>
            <Icon name="external" size={12} />
            {t('在浏览器里打开仓库')}
          </button>
        </div>
      </Card>
    </Group>
  );
}
