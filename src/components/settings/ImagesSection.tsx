/* ============================================================================
 * src/components/settings/ImagesSection.tsx —— 图片生成
 *   内置渲染（本地程序化绘制，永远可用）+ 四种外部后端
 * ==========================================================================*/

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { relativeTime } from '@/lib/format';
import { Card, Empty, Group } from './ui';
import type { GeneratedImage, ImageProviderConfig, ImageProviderKind } from '@shared/types';

const KIND_LABEL: Record<ImageProviderKind, string> = {
  builtin: '内置渲染（本地）',
  openai: 'OpenAI Images',
  stability: 'Stability AI',
  sdwebui: 'SD WebUI',
  comfyui: 'ComfyUI',
};

const KIND_URL: Record<ImageProviderKind, string> = {
  builtin: '',
  openai: 'https://api.openai.com/v1',
  stability: 'https://api.stability.ai',
  sdwebui: 'http://127.0.0.1:7860',
  comfyui: 'http://127.0.0.1:8188',
};

const NEEDS_KEY: Record<ImageProviderKind, boolean> = {
  builtin: false,
  openai: true,
  stability: true,
  sdwebui: false,
  comfyui: false,
};

/** 内置渲染的「伪接入项」id：主进程认这个 id，不需要真的存进接入项列表 */
const BUILTIN_ID = 'builtin';

const SIZES = ['1024x1024', '1024x1536', '1536x1024', '512x512', '768x768'];

/* 与主进程 imagegen.ts 的 TEXT_ONLY_HOSTS 保持一致的提示文案：
 * 这些厂商只有文本接口，把 Base URL 指过去只会拿到 404。 */
const TEXT_ONLY_HOST = /(^|\.)(deepseek\.com|moonshot\.(cn|ai)|dashscope\.aliyuncs\.com|volces\.com|bigmodel\.cn)$/i;

function looksTextOnly(baseUrl: string): boolean {
  try {
    return TEXT_ONLY_HOST.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}const STYLES: { value: string; label: string }[] = [
  { value: 'none', label: '不加风格' },
  { value: 'photo', label: '摄影' },
  { value: 'cinematic', label: '电影感' },
  { value: 'anime', label: '动漫' },
  { value: 'watercolor', label: '水彩' },
  { value: '3d', label: '3D 渲染' },
  { value: 'flat', label: '扁平插画' },
];

interface Draft {
  id?: string;
  kind: ImageProviderKind;
  label: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export function ImagesSection() {
  const t = useT();
  const workspaces = useApp(s => s.workspaces);
  // 性能：只订阅 workspaceId / chatId，不跟着流式内容重渲染
  const chatWorkspaceId = useApp(s => s.chat?.workspaceId);
  const chatId = useApp(s => s.chat?.id);
  const toast = useApp(s => s.toast);

  const [providers, setProviders] = useState<ImageProviderConfig[]>([]);
  const [history, setHistory] = useState<GeneratedImage[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [size, setSize] = useState(SIZES[0]);
  const [style, setStyle] = useState('none');
  const [count, setCount] = useState(1);
  const [providerId, setProviderId] = useState('');
  const [generating, setGenerating] = useState(false);

  const load = async () => {
    const [ps, hs] = await Promise.all([
      invoke('image:providers', undefined),
      invoke('image:history', { workspaceId: chatWorkspaceId ?? null, chatId: chatId ?? null }),
    ]);
    setProviders(ps);
    setHistory(hs);
    // 没有启用的外部后端就默认选内置渲染 —— 永远有得选，不会卡在「没有接入项」
    if (!providerId) setProviderId(ps.find(p => p.enabled)?.id ?? BUILTIN_ID);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatWorkspaceId, chatId]);

  const beginNew = () =>
    setDraft({ kind: 'openai', label: KIND_LABEL.openai, baseUrl: KIND_URL.openai, apiKey: '', enabled: true });

  const beginEdit = (p: ImageProviderConfig) =>
    setDraft({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, apiKey: '', enabled: p.enabled });

  const saveProvider = async () => {
    if (!draft) return;
    if (!draft.label.trim()) {
      toast(t('给这个接入项起个名字'), 'warn');
      return;
    }
    setBusy(true);
    try {
      await invoke('image:save-provider', {
        id: draft.id,
        kind: draft.kind,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey || undefined,
        enabled: draft.enabled,
      });
      await load();
      setDraft(null);
      toast(t('已保存'), 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async (p: ImageProviderConfig) => {
    await invoke('image:delete-provider', { id: p.id });
    await load();
    toast(t('已删除'), 'ok');
  };

  const generate = async () => {
    if (!prompt.trim()) {
      toast(t('先写点提示词'), 'warn');
      return;
    }
    setGenerating(true);
    try {
      const res = await invoke('image:generate', {
        prompt: prompt.trim(),
        negativePrompt: negative.trim() || undefined,
        size,
        count,
        style,
        providerId: providerId || BUILTIN_ID,
        workspaceId: chatWorkspaceId ?? null,
        chatId: chatId ?? null,
      });
      if (!res.ok) {
        toast(res.error ?? t('生成失败'), 'error');
        return;
      }
      await load();
      const note = (res as { note?: string }).note;
      toast(note ? `${t('出图')} ${res.images?.length ?? 0} ${t('张')} · ${note}` : `${t('出图')} ${res.images?.length ?? 0} ${t('张')}`, 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      {/* ------------------------------------------------------------ 生成 */}
      <Group
        title={t('直接出图')}
        desc={t('默认用内置渲染在本地画，产物落在当前会话的 artifacts/images 里。')}
      >
        <div className="form-grid">
          <div className="field full">
            <label className="field-label">{t('提示词')}</label>
            <textarea
              className="textarea"
              rows={3}
              placeholder={t('深夜的机房里，一排服务器指示灯像星图一样闪烁，冷青色，电影感打光')}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
            />
          </div>
          <div className="field full">
            <label className="field-label">{t('负向提示词')}</label>
            <input
              className="input"
              placeholder={t('模糊, 变形, 多余的手指')}
              value={negative}
              onChange={e => setNegative(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">{t('尺寸')}</label>
            <select className="select" style={{ width: '100%' }} value={size} onChange={e => setSize(e.target.value)}>
              {SIZES.map(s => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label">{t('风格')}</label>
            <select className="select" style={{ width: '100%' }} value={style} onChange={e => setStyle(e.target.value)}>
              {STYLES.map(s => (
                <option key={s.value} value={s.value}>
                  {t(s.label)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label">{t('张数')}</label>
            <input
              className="input"
              type="number"
              min={1}
              max={4}
              value={count}
              onChange={e => setCount(Math.min(4, Math.max(1, Number(e.target.value) || 1)))}
            />
          </div>
          <div className="field">
            <label className="field-label">{t('后端')}</label>
            <select
              className="select"
              style={{ width: '100%' }}
              value={providerId}
              onChange={e => setProviderId(e.target.value)}
            >
              <option value={BUILTIN_ID}>{t('内置渲染（本地，不需要 Key）')}</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.enabled ? '' : t('（停用）')}
                </option>
              ))}
            </select>
            <div className="field-hint">
              <Icon name="spark" size={11} />
              {t('内置渲染是本地程序化绘制：不联网、不要 Key，画星空、山脊、海面倒影、抽象光晕最好用。')}
            </div>
          </div>
        </div>
        <div className="row gap-8" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            onClick={() => void generate()}
            disabled={generating}
          >
            <Icon name="image" size={13} />
            {generating ? t('生成中…') : t('生成图片')}
          </button>
          {!chatWorkspaceId && workspaces.length > 0 && (
            <span className="dim" style={{ fontSize: 11.5 }}>
              {t('当前会话没绑工作区，图片会落到应用数据目录。')}
            </span>
          )}
        </div>
      </Group>

      {/* ------------------------------------------------------------ 接入 */}
      <Group title={t('图片后端')} desc={t('本地 SD WebUI / ComfyUI 不需要 Key，只要服务在跑。')}>
        {draft ? (
          <Card title={draft.id ? t('编辑接入项') : t('新增接入项')}>
            <div className="form-grid">
              <div className="field">
                <label className="field-label">{t('类型')}</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={draft.kind}
                  onChange={e => {
                    const kind = e.target.value as ImageProviderKind;
                    setDraft({ ...draft, kind, label: KIND_LABEL[kind], baseUrl: KIND_URL[kind] });
                  }}
                >
                  {(Object.keys(KIND_LABEL) as ImageProviderKind[])
                    .filter(k => k !== 'builtin')
                    .map(k => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label">{t('名称')}</label>
                <input
                  className="input"
                  value={draft.label}
                  onChange={e => setDraft({ ...draft, label: e.target.value })}
                />
              </div>
              <div className="field full">
                <label className="field-label">Base URL</label>
                <input
                  className="input mono"
                  value={draft.baseUrl}
                  onChange={e => setDraft({ ...draft, baseUrl: e.target.value })}
                />
                {draft.kind === 'openai' && looksTextOnly(draft.baseUrl) && (
                  <div className="field-hint" data-tone="warn">
                    <Icon name="alert" size={11} />
                    {t('这个地址只有文本接口，出图会返回 404。要生图请换成 OpenAI 官方、Stability，或本地 SD WebUI / ComfyUI。')}
                  </div>
                )}
              </div>
              {NEEDS_KEY[draft.kind] && (
                <div className="field full">
                  <label className="field-label">API Key</label>
                  <input
                    className="input"
                    type="password"
                    placeholder={draft.id ? t('留空表示不修改已保存的 Key') : 'sk-…'}
                    value={draft.apiKey}
                    onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
                  />
                </div>
              )}
              <div className="field">
                <label className="field-label">{t('启用')}</label>
                <button
                  type="button"
                  className="switch"
                  role="switch"
                  aria-checked={draft.enabled}
                  data-on={draft.enabled ? 'true' : 'false'}
                  onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                />
              </div>
            </div>
            <div className="row gap-8" style={{ marginTop: 14 }}>
              <div className="grow" />
              <button type="button" className="btn" onClick={() => setDraft(null)}>
                {t('取消')}
              </button>
              <button
                type="button"
                className="btn"
                data-variant="primary"
                onClick={() => void saveProvider()}
                disabled={busy}
              >
                {busy ? t('保存中…') : t('保存')}
              </button>
            </div>
          </Card>
        ) : (
          <>
            {providers.length === 0 ? (
              <Card title={t('还没有图片后端')}>
                <Empty
                  icon="image"
                  title={t('加一个后端')}
                  desc={t('本地已经有 ComfyUI 的话，填上地址就能直接用。')}
                />
              </Card>
            ) : (
              providers.map(p => (
                <Card
                  key={p.id}
                  title={
                    <span className="row gap-6">
                      {p.label}
                      {!p.enabled && <span className="badge">{t('已停用')}</span>}
                      {NEEDS_KEY[p.kind] && !p.hasKey && (
                        <span className="badge" data-tone="warn">
                          {t('缺 Key')}
                        </span>
                      )}
                    </span>
                  }
                  sub={KIND_LABEL[p.kind]}
                  actions={
                    <>
                      <button type="button" className="btn" data-size="sm" onClick={() => beginEdit(p)}>
                        <Icon name="edit" size={12} />
                      </button>
                      <button
                        type="button"
                        className="btn"
                        data-size="sm"
                        data-variant="danger"
                        onClick={() => void removeProvider(p)}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </>
                  }
                >
                  <div className="mono dim" style={{ fontSize: 10.8, overflowWrap: 'anywhere' }}>
                    {p.baseUrl}
                  </div>
                </Card>
              ))
            )}
            <div className="row gap-8" style={{ marginTop: 12 }}>
              <button type="button" className="btn" data-variant="primary" onClick={beginNew}>
                <Icon name="plus" size={13} />
                {t('新增后端')}
              </button>
            </div>
          </>
        )}
      </Group>

      {/* ------------------------------------------------------------ 历史 */}
      <Group
        title={`${t('生成历史')} · ${history.length}`}
        desc={t('只保留最近的记录，文件本身在磁盘上。')}
      >
        {history.length === 0 ? (
          <Card title={t('还没有生成过图片')}>
            <Empty icon="image" title={t('空的')} />
          </Card>
        ) : (
          <div className="gallery">
            {history
              .flatMap(img => img.files.map(f => ({ img, file: f })))
              .slice(0, 24)
              .map(({ img, file }) => (
                <div
                  key={file.path}
                  className="gallery-item"
                  title={t('点击在系统里打开')}
                  onClick={() => void invoke('workspace:open-path', { path: file.path })}
                >
                  <img src={file.url} alt={img.prompt.slice(0, 30)} loading="lazy" />
                  <div className="gallery-item-meta">
                    <span className="ellipsis">{img.prompt}</span>
                    <span className="dim">{relativeTime(img.createdAt)}</span>
                  </div>
                </div>
              ))}
          </div>
        )}
      </Group>
    </>
  );
}
