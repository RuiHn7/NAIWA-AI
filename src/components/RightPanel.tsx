/* ============================================================================
 * src/components/RightPanel.tsx —— 右侧工具面板
 *   · 文件：当前工作区的目录树（扁平列表 + 分类图标），点开预览
 *   · 浏览：内嵌 webview 打开网页（受 main.ts 的 allowlist 限制）
 * ==========================================================================*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { formatBytes } from '@/lib/format';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import type { WorkspaceFile } from '@shared/types';

type Preview =
  | { kind: 'image'; url: string; name: string }
  | { kind: 'text'; text: string; name: string }
  | { kind: 'none'; name: string; reason: string };

/** 稳定的空数组引用：zustand 选择器返回新数组会触发 React #185 */
const EMPTY_LIST: string[] = [];

const KIND_ICON: Record<WorkspaceFile['kind'], 'image' | 'file' | 'folder' | 'globe'> = {
  image: 'image',
  html: 'globe',
  code: 'file',
  markdown: 'file',
  json: 'file',
  text: 'file',
  binary: 'file',
};

export function RightPanel() {
  const t = useT();
  // 性能：只订阅 workspaceId / chatId（右栏只需要知道当前会话绑了哪个工作区）
  const chatWorkspaceId = useApp(s => s.chat?.workspaceId);
  const chatId = useApp(s => s.chat?.id);
  const previewRequest = useApp(s => s.previewRequest);
  const artifactsVersion = useApp(s => s.artifactsVersion);
  const workspaces = useApp(s => s.workspaces);
  const tab = useApp(s => s.rightTab);
  const setRightTab = useApp(s => s.setRightTab);
  const openSettings = useApp(s => s.openSettings);
  const toast = useApp(s => s.toast);
  const settings = useApp(s => s.settings);
  const saveSettings = useApp(s => s.saveSettings);

  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);

  const workspace = useMemo(
    () => workspaces.find(w => w.id === chatWorkspaceId) ?? null,
    [workspaces, chatWorkspaceId],
  );

  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<WorkspaceFile | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [filter, setFilter] = useState('');

  const [url, setUrl] = useState('https://developer.mozilla.org');
  const [address, setAddress] = useState('https://developer.mozilla.org');
  const webRef = useRef<any>(null);

  /* --------------------------------------------------------- 浏览白名单 */
  // 主进程在 will-attach-webview 里做同样的通配校验；这里提前判一次，
  // 免得白屏让人以为是加载失败。
  // 注意：`?? []` 每次都会造一个新数组，zustand 会判定快照变化 → React #185
  // 无限重渲染，所以空值必须落到模块级常量上。
  const allowlist = useApp(s => s.settings?.webviewAllowlist) ?? EMPTY_LIST;
  const allowed = useMemo(() => {
    // 与主进程 matchAllow() 保持一致：忽略末尾斜杠，支持 `*` 通配
    const trim = (s: string) => s.replace(/\/+$/, '');
    const target = trim(url);
    return allowlist.some(pattern => {
      const escaped = trim(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      try {
        return new RegExp(`^${escaped}$`, 'i').test(target);
      } catch {
        return false;
      }
    });
  }, [allowlist, url]);

  /* --------------------------------------------------------------- 文件列表 */

  // 数据源：绑了工作区就列工作区文件；没绑工作区就列当前会话自己的产物。
  // 后者是「没有工作区的会话看不到产物」那个坑的修法 —— 以前这里直接 setFiles([])。
  const reload = useCallback(async () => {
    if (workspace) {
      setLoading(true);
      try {
        const list = await invoke('workspace:files', { id: workspace.id });
        setFiles(list);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!chatId) {
      setFiles([]);
      return;
    }
    setLoading(true);
    try {
      const res = await invoke('chat:artifacts', { id: chatId });
      setFiles(res.items);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [workspace, chatId, toast]);

  useEffect(() => {
    void reload();
  }, [reload, artifactsVersion]);

  const openFile = async (file: WorkspaceFile) => {
    setActive(file);
    setPreview(null);
    const res = await invoke('workspace:read-file', { path: file.path });
    if (!res.ok) {
      setPreview({ kind: 'none', name: file.name, reason: res.error ?? t('无法读取该文件') });
      return;
    }
    if (res.dataUrl) setPreview({ kind: 'image', url: res.dataUrl, name: file.name });
    else if (typeof res.text === 'string') setPreview({ kind: 'text', text: res.text, name: file.name });
    else setPreview({ kind: 'none', name: file.name, reason: t('这个类型不支持内联预览') });
  };

  // 工具卡里点「在右侧打开」→ 右栏直接把这个文件读出来预览。
  // 文件可能不在当前列表里（比如会话产物），所以这里构造一个临时条目。
  useEffect(() => {
    if (!previewRequest) return;
    const known = files.find(f => f.path === previewRequest.path);
    void openFile(
      known ?? {
        name: previewRequest.name,
        path: previewRequest.path,
        relPath: previewRequest.name,
        size: 0,
        mtime: Date.now(),
        kind: 'text',
      },
    );
    // files 变化不该重新触发预览，只认 nonce
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRequest?.nonce]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? files.filter(f => f.relPath.toLowerCase().includes(q)) : files;
    return list.slice(0, 400);
  }, [files, filter]);

  /* ------------------------------------------------------- 拖宽（PRD 二.2） */

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (maximized) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = settings?.rightPanelWidth ?? 340;
      setResizing(true);
      document.body.classList.add('resizing');

      const onMove = (e: PointerEvent) => {
        // 往左拖变宽，clamp 到 260–720
        const next = Math.max(260, Math.min(720, startWidth + (startX - e.clientX)));
        document.documentElement.style.setProperty('--right-w', `${next}px`);
      };
      const onUp = (e: PointerEvent) => {
        const next = Math.max(260, Math.min(720, startWidth + (startX - e.clientX)));
        void saveSettings({ rightPanelWidth: next });
        setResizing(false);
        document.body.classList.remove('resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [maximized, settings?.rightPanelWidth, saveSettings],
  );

  // 窗口宽度变化后，如果满屏了但窗口变小，退出满屏更稳妥
  useEffect(() => {
    if (!maximized) return;
    const onResize = () => undefined;
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [maximized]);

  if (!tab) return null;

  return (
    <aside
      className="right-panel"
      data-open="true"
      data-tab={tab}
      data-fullscreen={maximized ? 'true' : undefined}
    >
      <div
        className="right-resizer"
        data-dragging={resizing ? 'true' : undefined}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('调整面板宽度')}
        onPointerDown={startResize}
        hidden={maximized}
      />
      <div className="right-inner">
        <div className="right-head">
          <div className="right-tabs">
            <button type="button" className="right-tab" data-active={tab === 'files'} onClick={() => setRightTab('files')}>
              {t('文件')}
            </button>
            <button type="button" className="right-tab" data-active={tab === 'browser'} onClick={() => setRightTab('browser')}>
              {t('浏览')}
            </button>
          </div>
          <div className="grow" />
          <button
            type="button"
            className="icon-btn"
            title={maximized ? t('退出窗口内全屏') : t('窗口内全屏')}
            aria-label={maximized ? t('退出窗口内全屏') : t('窗口内全屏')}
            aria-pressed={maximized}
            onClick={() => setMaximized(v => !v)}
          >
            <Icon name={maximized ? 'collapse' : 'expand'} size={15} />
          </button>
          <button type="button" className="icon-btn" title={t('收起面板')} aria-label={t('收起面板')} onClick={() => setRightTab(null)}>
            <Icon name="panel-right-off" size={15} />
          </button>
        </div>

        {tab === 'files' && (
          <div className="right-body">
            <div className="panel-head">
              <span className="panel-title ellipsis" title={workspace?.path ?? undefined}>
                {workspace ? workspace.name : t('本会话产物')}
              </span>
              <div className="grow" />
              <button type="button" className="icon-btn" title={t('刷新')} aria-label={t('刷新')} onClick={() => void reload()}>
                <Icon name="refresh" size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={workspace ? t('在文件管理器里打开') : t('打开会话文件夹')}
                aria-label={workspace ? t('在文件管理器里打开') : t('打开会话文件夹')}
                onClick={() => {
                  if (workspace) void invoke('workspace:open-folder', { id: workspace.id });
                  else if (chatId) void invoke('chat:reveal', { id: chatId });
                }}
              >
                <Icon name="external" size={14} />
              </button>
            </div>

            <input
              className="input"
              data-w="md"
              placeholder={t('过滤文件…')}
              value={filter}
              onChange={e => setFilter(e.target.value)}
              style={{ margin: '0 0 8px' }}
            />

            {loading && <div className="skeleton" style={{ height: 60, borderRadius: 10 }} />}

            {!loading && filtered.length === 0 && (
              <div className="panel-empty">
                <Icon name="file" size={20} />
                <p>
                  {filter
                    ? t('没有匹配的文件')
                    : workspace
                      ? t('工作区还是空的')
                      : t('这个会话还没有产物')}
                </p>
                {!filter && !workspace && <p className="dim">{t('让 Agent 生成点东西，产物会落在这个会话的文件夹里。')}</p>}
              </div>
            )}

            <div className="file-list">
              {filtered.map(file => (
                <button
                  key={file.path}
                  type="button"
                  className="file-row"
                  data-active={active?.path === file.path}
                  onClick={() => void openFile(file)}
                >
                  <span className="file-kind" data-kind={file.kind}>
                    <Icon name={KIND_ICON[file.kind]} size={13} />
                  </span>
                  <span className="file-meta">
                    <span className="file-name ellipsis">{file.relPath}</span>
                    <span className="file-sub">{formatBytes(file.size)}</span>
                  </span>
                </button>
              ))}
            </div>

            {active && (
              <div className="preview">
                <div className="preview-head">
                  <span className="ellipsis">{preview?.name ?? active.name}</span>
                  <div className="grow" />
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('打开存放位置')}
                    aria-label={t('打开存放位置')}
                    onClick={() => void invoke('workspace:open-path', { path: active.path })}
                  >
                    <Icon name="external" size={13} />
                  </button>
                  <button type="button" className="icon-btn" title={t('关闭预览')} aria-label={t('关闭预览')} onClick={() => {
                    setActive(null);
                    setPreview(null);
                  }}>
                    <Icon name="x" size={13} />
                  </button>
                </div>
                {!preview && <div className="skeleton" style={{ height: 120, borderRadius: 10 }} />}
                {preview?.kind === 'image' && <img className="preview-image" src={preview.url} alt={preview.name} />}
                {preview?.kind === 'text' && <pre className="preview-text">{preview.text}</pre>}
                {preview?.kind === 'none' && <p className="dim" style={{ padding: '4px 2px' }}>{preview.reason}</p>}
              </div>
            )}
          </div>
        )}

        {tab === 'browser' && (
          <div className="right-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <form
              className="row gap-6"
              onSubmit={e => {
                e.preventDefault();
                const next = /^https?:\/\//i.test(address) ? address : `https://${address}`;
                setUrl(next);
              }}
            >
              <input className="input" data-w="md" value={address} onChange={e => setAddress(e.target.value)} placeholder={t('输入网址')} />
              <button type="submit" className="btn" data-size="sm">
                {t('打开')}
              </button>
            </form>
            <div className="preview-frame">
              {/* webview 由 main.ts 的 allowlist 把关，不在白名单会直接被拦 */}
              {allowed ? (
                <webview ref={webRef} src={url} style={{ width: '100%', height: '100%' }} />
              ) : (
                <div className="webview-blocked">
                  <Icon name="globe" size={22} />
                  <p>{t('这个地址不在内置浏览的白名单里。')}</p>
                  <p className="dim">
                    {t('当前允许')} · {allowlist.length ? allowlist.join(' ') : t('（空）')}
                  </p>
                  <button
                    type="button"
                    className="btn"
                    data-size="sm"
                    onClick={() => openSettings('general')}
                  >
                    {t('去设置里调整')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
