/* ============================================================================
 * src/components/settings/LocalVlmCard.tsx —— 内置本地视觉模型（离线识图）
 *   · 运行时随安装包分发，模型按需下载（2.7GB，放非系统盘）
 *   · 下载进度走 vlm:progress 事件；下载完自动校验 SHA-256
 *   · 这里只管配置与状态，真正的识图在桌面端 agent 里
 * ==========================================================================*/

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke, on } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import type { VlmProgress, VlmStatus } from '@shared/types';
import { Card, Row, Switch } from './ui';

function fmtGB(bytes: number): string {
  if (!bytes) return '0 GB';
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function fmtSpeed(bytes?: number): string {
  if (!bytes) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}

const PHASE_TEXT: Record<VlmStatus['phase'], string> = {
  missing: '未就绪',
  ready: '已就绪（未加载）',
  downloading: '下载中',
  verifying: '校验中',
  starting: '加载中',
  running: '已加载，可识图',
  error: '异常',
};

export function LocalVlmCard() {
  const t = useT();
  const settings = useApp(s => s.settings);
  const saveSettings = useApp(s => s.saveSettings);
  const toast = useApp(s => s.toast);

  const [status, setStatus] = useState<VlmStatus | null>(null);
  const [progress, setProgress] = useState<VlmProgress | null>(null);
  const [busy, setBusy] = useState<'download' | 'delete' | 'warm' | null>(null);

  const refresh = useCallback(() => {
    void invoke('vlm:status', undefined)
      .then(next => setStatus(next))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const off = on('vlm:progress', p => {
      setProgress(p);
      if (p.phase === 'ready' || p.phase === 'running' || p.phase === 'error' || p.phase === 'missing') void refresh();
    });
    return off;
  }, [refresh]);

  const download = async () => {
    setBusy('download');
    try {
      const res = await invoke('vlm:download', undefined);
      if (res.ok) toast(t('本地视觉模型下载完成'), 'ok');
      else toast(res.error ?? t('下载失败'), res.canceled ? 'warn' : 'error');
    } finally {
      setBusy(null);
      setProgress(null);
      void refresh();
    }
  };

  const cancel = async () => {
    await invoke('vlm:cancel', undefined);
    toast(t('已停止下载，已下载的部分保留，可继续'), 'warn');
  };

  const remove = async () => {
    setBusy('delete');
    try {
      const res = await invoke('vlm:delete', undefined);
      toast(res.removed ? t('已删除本地视觉模型') : t('没有可删除的模型'), res.removed ? 'ok' : 'warn');
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const warm = async () => {
    setBusy('warm');
    try {
      const res = await invoke('vlm:warmup', undefined);
      if (res.ok) toast(`${t('模型已加载')}${res.ms ? ` · ${(res.ms / 1000).toFixed(1)}s` : ''}`, 'ok');
      else toast(res.error ?? t('加载失败'), 'error');
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const phase = progress?.phase === 'downloading' || progress?.phase === 'verifying' ? progress.phase : status?.phase;
  const downloading = busy === 'download' || phase === 'downloading' || phase === 'verifying';
  const ready = !!status?.model;
  const meta = status;

  return (
    <Card
      title={t('本地视觉模型（本机）')}
      sub={
        <span className="dim" style={{ fontSize: 11.5 }}>
          Qwen2.5-VL-3B · {ready ? fmtGB(meta?.bytes ?? 0) : t('未下载')}
        </span>
      }
      actions={
        <span className="tag" data-tone={phase === 'running' ? 'ok' : ready ? 'normal' : 'warn'}>
          {t(PHASE_TEXT[phase ?? 'missing'])}
        </span>
      }
    >
      <div className="setting-hint" style={{ textAlign: 'left', marginBottom: 10 }}>
        {t('安装包只带推理运行时（约 70MB），模型下载后长期留在本机，识图在本机完成，不依赖外部接口：描述画面内容、读图中文字、回答「这是什么」。不下载也照样能用原来的本机识图。')}
      </div>

      <Row label={t('用本地视觉模型识图')}>
        <Switch on={settings?.localVlm !== false} onChange={localVlm => void saveSettings({ localVlm })} />
      </Row>

      <Row label={t('运行时')}>
        <span className="dim" style={{ fontSize: 12 }}>
          {meta?.runtime ? `llama-server · ${t('已随安装包就位')}` : t('缺失，需重新安装最新版本')}
        </span>
      </Row>

      <Row label={t('模型')}>
        <span className="dim" style={{ fontSize: 12 }}>
          {ready ? `${fmtGB(meta?.bytes ?? 0)} / ${fmtGB(meta?.expected ?? 0)}` : `${t('未下载')} · ${fmtGB(meta?.expected ?? 0)}`}
        </span>
      </Row>

      <Row label={t('存放目录')}>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <span className="dim" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
            {meta?.dir ?? '—'}
          </span>
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={() => meta?.dir && void invoke('workspace:open-path', { path: meta.dir })}
          >
            <Icon name="folder" size={12} />
            {t('打开')}
          </button>
        </div>
      </Row>

      {phase === 'downloading' || phase === 'verifying' ? (
        <div className="update-progress" data-phase={phase}>
          <div
            className="update-progress-bar"
            style={{ width: `${phase === 'verifying' ? 100 : (progress?.percent ?? 0)}%` }}
          />
          <div className="update-progress-text">
            {phase === 'verifying'
              ? t('校验模型完整性…')
              : `${progress?.label ? `${progress.label} · ` : ''}${fmtGB(progress?.received ?? 0)} / ${fmtGB(progress?.total ?? meta?.expected ?? 0)} · ${(progress?.percent ?? 0).toFixed(0)}%${progress?.speed ? ` · ${fmtSpeed(progress.speed)}` : ''}`}
          </div>
        </div>
      ) : null}

      <div className="row gap-8" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        {!ready && !downloading && (
          <button type="button" className="btn" data-variant="primary" onClick={() => void download()} disabled={!meta?.runtime || busy !== null}>
            <Icon name="download" size={13} />
            {t('下载模型（约 2.7GB，可断点续传）')}
          </button>
        )}
        {downloading && (
          <button type="button" className="btn" onClick={() => void cancel()}>
            <Icon name="x" size={13} />
            {t('停止下载')}
          </button>
        )}
        {ready && !downloading && (
          <>
            <button type="button" className="btn" onClick={() => void warm()} disabled={busy !== null}>
              <Icon name="spark" size={13} />
              {busy === 'warm' ? t('加载中…') : t('预热（先把模型读进显存）')}
            </button>
            <button type="button" className="btn" data-variant="danger" onClick={() => void remove()} disabled={busy !== null}>
              <Icon name="trash" size={13} />
              {t('删除模型')}
            </button>
          </>
        )}
      </div>

      {(progress?.message || meta?.message) && (
        <div className="field-hint" style={{ marginTop: 8 }} data-tone={phase === 'error' ? 'warn' : undefined}>
          {progress?.phase === 'error' || status?.phase === 'error' ? <Icon name="alert" size={11} /> : null}{' '}
          {progress?.message ?? meta?.message}
        </div>
      )}
    </Card>
  );
}
