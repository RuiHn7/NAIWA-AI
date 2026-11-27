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
  phase: 'probing' | 'downloading' | 'verifying' | 'done';
  received: number;
  total: number;
  percent: number;
  speed?: number;
  source?: string;
  sources?: number;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtSpeed(bps?: number): string {
  if (!bps || bps <= 0) return '';
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
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
  /** 用户点了「停止下载」：分块已保留，可以继续下 */
  const [paused, setPaused] = useState(false);
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
    setPaused(false);
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
    setPaused(false);
    setDownloadError(null);
    setProgress({ phase: 'probing', received: 0, total: installer.size, percent: 0 });
    try {
      const res = await invoke('update:download', {
        name: installer.name,
        url: installer.url,
        size: installer.size,
        sha256: installer.sha256,
      });
      if (res.ok && res.path) {
        setDownloaded(res.path);
        setPaused(false);
        toast(t('安装包已下载，可以重启安装了'), 'ok');
      } else if (res.canceled) {
        // 用户主动停止：保留已下载分块，显示「继续下载 / 重新下载」
        setPaused(true);
      } else {
        setDownloadError(res.error ?? t('下载失败'));
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  /** 停止下载：主进程中止请求，已下分块留在临时目录，下次继续 */
  const stop = async () => {
    try {
      await invoke('update:cancel', undefined);
    } catch {
      /* 主进程可能刚好下完 */
    }
    setDownloading(false);
    setPaused(true);
  };

  /** 重新下载：先删掉原文件与所有分块，再从零开始 */
  const redo = async () => {
    if (!installer) return;
    setDownloaded(null);
    setProgress(null);
    setPaused(false);
    setDownloadError(null);
    await invoke('update:reset', { name: installer.name }).catch(() => {});
    await download();
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
  const speedText = fmtSpeed(progress?.speed);

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
                ) : downloading ? (
                  <button type="button" className="btn" data-size="sm" onClick={() => void stop()}>
                    <Icon name="x" size={12} />
                    {t('停止下载')}
                  </button>
                ) : paused ? (
                  <button
                    type="button"
                    className="btn"
                    data-variant="primary"
                    data-size="sm"
                    onClick={() => void download()}
                  >
                    <Icon name="download" size={12} />
                    {t('继续下载')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    data-variant="primary"
                    data-size="sm"
                    onClick={() => void download()}
                  >
                    <Icon name="download" size={12} />
                    {t('下载并安装')}
                  </button>
                )}

                {/* 停止过或已下载完：给一个从零重来的入口（会先删掉旧文件和分块） */}
                {!downloading && (paused || downloaded) && (
                  <button type="button" className="btn" data-size="sm" onClick={() => void redo()}>
                    <Icon name="refresh" size={12} />
                    {t('重新下载')}
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
                {paused && !downloaded && (
                  <span className="dim" style={{ fontSize: 11.5 }}>
                    {t('已停止：已下载的进度会保留，点「继续下载」接着下，或「重新下载」从头来。')}
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
                  {progress.phase === 'probing'
                    ? t('正在测速，自动选择最快线路…')
                    : progress.phase === 'verifying'
                      ? t('校验安装包…')
                      : `${t('已下载')} ${fmtMB(progress.received)}${progress.total ? ` / ${fmtMB(progress.total)}` : ''}${speedText ? ` · ${speedText}` : ''}${progress.source ? ` · ${progress.source}` : ''}`}
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
