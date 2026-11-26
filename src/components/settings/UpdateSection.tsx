/* ============================================================================
 * src/components/settings/UpdateSection.tsx —— 软件更新
 *   · 默认检查 GitHub RuiHn7/NAIWA-AI 的最新版本
 *   · 打开软件时自动检查（bootstrap 里触发，结果存 store）
 *   · 发现新版本 → 主页用户卡片上方出现蓝色「新版本」胶囊
 *   · 有安装包时可以在应用内直接下载并启动安装，不用去浏览器
 * ==========================================================================*/

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke, on } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { Card, Group, Switch } from './ui';
const REPO_URL = 'https://github.com/RuiHn7/NAIWA-AI';

/** app:info 的子集，这里只关心版本号 */
interface AppInfoLite {
  version: string;
}

interface Progress {
  phase: 'downloading' | 'verifying' | 'done';
  received: number;
  total: number;
  percent: number;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateSection() {
  const t = useT();
  const settings = useApp(s => s.settings);
  const saveSettings = useApp(s => s.saveSettings);
  const update = useApp(s => s.update);
  const checkUpdate = useApp(s => s.checkUpdate);
  const toast = useApp(s => s.toast);

  const [busy, setBusy] = useState(false);
  // 当前版本优先用主进程给的（app:info），免得检查还没回来时显示成「—」
  const [version, setVersion] = useState('');

  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const progressTimer = useRef<number | null>(null);

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

  // 下载进度由主进程推过来
  useEffect(() => {
    const off = on('update:progress', p => {
      setProgress(p);
      if (p.phase === 'done') {
        if (progressTimer.current) window.clearTimeout(progressTimer.current);
        progressTimer.current = window.setTimeout(() => setProgress(null), 1200);
      }
    });
    return () => {
      off();
      if (progressTimer.current) window.clearTimeout(progressTimer.current);
    };
  }, []);

  // 目标版本变了就把上次的下载状态清掉
  useEffect(() => {
    setDownloaded(null);
    setProgress(null);
    setDownloadError(null);
  }, [update?.latest]);

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
  const installer = update?.installer ?? null;
  const openUrl = () => {
    void invoke('workspace:open-path', { path: update?.url ?? REPO_URL });
  };

  const download = async () => {
    if (!installer) return;
    setDownloading(true);
    setDownloadError(null);
    setProgress({ phase: 'downloading', received: 0, total: installer.size, percent: 0 });
    try {
      const res = await invoke('update:download', {
        name: installer.name,
        url: installer.url,
        size: installer.size,
        sha256: installer.sha256,
      });
      if (res.ok && res.path) {
        setDownloaded(res.path);
        toast(t('安装包已下载，可以重启安装了'), 'ok');
      } else {
        setDownloadError(res.error ?? t('下载失败'));
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const install = async () => {
    if (!downloaded) return;
    setInstalling(true);
    try {
      const res = await invoke('update:install', { path: downloaded });
      if (!res.ok) {
        setInstalling(false);
        setDownloadError(res.error ?? t('启动安装程序失败'));
      }
      // 成功的话应用会自己退出，这里不用再处理
    } catch (err) {
      setInstalling(false);
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  };

  const autoOn = settings?.autoUpdate !== false;
  const percent = progress?.percent ?? 0;

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
            disabled={busy || downloading}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              <span>
                {t('新版本')} <span className="mono">{latest}</span>
                {update?.publishedAt ? ` · ${new Date(update.publishedAt).toLocaleDateString()}` : ''}
                {installer?.size ? <span className="dim"> · {fmtMB(installer.size)}</span> : null}
              </span>
            </div>

            {installer ? (
              <div className="row gap-10" style={{ flexWrap: 'wrap' }}>
                {downloaded ? (
                  <button
                    type="button"
                    className="btn"
                    data-variant="primary"
                    data-size="sm"
                    onClick={() => void install()}
                    disabled={installing}
                  >
                    <Icon name="download" size={12} />
                    {installing ? t('正在启动安装程序…') : t('重启并安装')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    data-variant="primary"
                    data-size="sm"
                    onClick={() => void download()}
                    disabled={downloading}
                  >
                    <Icon name="download" size={12} />
                    {downloading ? `${t('下载中')}${progress?.total ? ` ${percent}%` : '…'}` : t('下载并安装')}
                  </button>
                )}
                <button type="button" className="btn" data-size="sm" onClick={openUrl}>
                  <Icon name="external" size={12} />
                  {t('打开下载页')}
                </button>
                {downloaded && (
                  <span className="dim" style={{ fontSize: 11.5 }}>
                    {t('安装包已就绪：点「重启并安装」会自动关闭本程序并启动安装器')}
                  </span>
                )}
              </div>
            ) : (
              <div className="row gap-10" style={{ flexWrap: 'wrap' }}>
                <span className="dim" style={{ fontSize: 11.5 }}>
                  {t('这次发布没有挂安装包，只能到下载页手动下。')}
                </span>
                <button type="button" className="btn" data-size="sm" onClick={openUrl}>
                  <Icon name="external" size={12} />
                  {t('打开下载页')}
                </button>
              </div>
            )}

            {progress && (
              <div className="update-progress" data-phase={progress.phase}>
                <div
                  className="update-progress-bar"
                  style={{ width: `${progress.phase === 'verifying' ? 100 : percent}%` }}
                />
                <div className="update-progress-text">
                  {progress.phase === 'verifying'
                    ? t('校验安装包…')
                    : `${t('已下载')} ${fmtMB(progress.received)}${progress.total ? ` / ${fmtMB(progress.total)}` : ''}`}
                </div>
              </div>
            )}

            {downloadError && (
              <div className="field-hint" data-tone="warn">
                <Icon name="alert" size={11} />
                {downloadError}
              </div>
            )}
          </div>
        ) : (
          <div className="dim">{update ? t('已经是最新版本。') : t('点右边的按钮检查一次。')}</div>
        )}
        {newer && update?.notes && <pre className="update-notes">{update.notes}</pre>}
      </Card>

      <Card title={t('自动检查')} sub={t('每次启动时查一次，有新版就在侧栏显示胶囊。')}>
        <div className="row gap-12">
          <Switch on={autoOn} onChange={next => void saveSettings({ autoUpdate: next })} />
          <span style={{ lineHeight: 1.5 }}>{t('打开软件后自动检查新版本')}</span>
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
