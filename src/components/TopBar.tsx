/* ============================================================================
 * src/components/TopBar.tsx —— 自绘标题栏 + 会话工具条（PRD 二.1）
 *   左侧：折叠按钮 + 会话标题（点击可改名）
 *   右侧：人格 / 工作区信息位 + 导出 + 右栏开关 + 最小化 / 最大化 / 关闭
 *   条本身是窗口拖拽区（-webkit-app-region: drag），可交互元素一律 no-drag。
 *   模型 + 思考强度已移入输入区（PRD 三），这里不再出现。
 * ==========================================================================*/

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Menu, MenuItem, MenuLabel, MenuSep, useMenu } from '@/components/Menu';
import { useApp } from '@/store/useApp';
import { invoke } from '@/lib/bridge';
import { useT } from '@/lib/i18n';

type MenuKind = 'persona' | 'workspace' | 'export';

/** 主进程新建会话时写的中文默认标题；显示时换成当前语言 */
const DEFAULT_TITLE = '新对话';

const EXPORT_FORMATS: { value: 'md' | 'json' | 'html'; label: string; hint: string }[] = [
  { value: 'md', label: 'Markdown', hint: '.md' },
  { value: 'json', label: 'JSON', hint: '.json' },
  { value: 'html', label: '单文件 HTML', hint: '.html' },
];

export function TopBar({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  // 性能：拆成窄选择器。订阅整个 chat 会在流式期间（45ms 一次 flush）让顶栏跟着重渲染。
  const chatId = useApp(s => s.chat?.id);
  const chatTitle = useApp(s => s.chat?.title);
  const personaId = useApp(s => s.chat?.personaId);
  const workspaceId = useApp(s => s.chat?.workspaceId);
  const settings = useApp(s => s.settings);
  const personas = useApp(s => s.personas);
  const workspaces = useApp(s => s.workspaces);
  const rightTab = useApp(s => s.rightTab);

  const saveSettings = useApp(s => s.saveSettings);
  const patchChat = useApp(s => s.patchChat);
  const renameChat = useApp(s => s.renameChat);
  const setRightTab = useApp(s => s.setRightTab);
  const openSettings = useApp(s => s.openSettings);
  const toast = useApp(s => s.toast);

  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [kind, setKind] = useState<MenuKind | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const { menu, open, close } = useMenu();

  useEffect(() => {
    const el = document.getElementById('thread-scroll');
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 6);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [chatId]);

  // 窗口最大化状态同步（图标与双击行为都要跟得上）
  useEffect(() => {
    let alive = true;
    void invoke('window:state', undefined).then(s => {
      if (alive) setMaximized(s.maximized);
    });
    const off = window.naiwa?.on('window:state', s => setMaximized(s.maximized));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (editing !== null) titleRef.current?.select();
  }, [editing]);

  const commitTitle = () => {
    if (!chatId || editing === null) return;
    const next = editing.trim();
    setEditing(null);
    if (next && next !== chatTitle) void renameChat(chatId, next);
  };

  const collapsed = settings?.sidebarCollapsed ?? false;

  const openMenu = (k: MenuKind, el: HTMLElement) => {
    setKind(k);
    open(el, 'right');
  };

  return (
    <header
      className="topbar"
      data-scrolled={scrolled}
      onDoubleClick={e => {
        // 双击空白处最大化 / 还原
        if ((e.target as HTMLElement).closest('button, input, a, .no-drag')) return;
        void invoke('window:toggle-maximize', undefined).then(s => setMaximized(s.maximized));
      }}
    >
      <button
        type="button"
        className="icon-btn no-drag"
        title={collapsed ? t('展开侧栏 (Ctrl+B)') : t('折叠侧栏 (Ctrl+B)')}
        aria-label={t('切换侧栏')}
        onClick={() => {
          if (window.innerWidth <= 900) onOpenDrawer();
          else void saveSettings({ sidebarCollapsed: !collapsed });
        }}
      >
        <Icon name="sidebar" size={17} />
      </button>

      {chatId &&
        (editing !== null ? (
          <input
            ref={titleRef}
            className="tb-title-input no-drag"
            value={editing}
            onChange={e => setEditing(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={e => {
              if (e.key === 'Enter') commitTitle();
              if (e.key === 'Escape') setEditing(null);
            }}
          />
        ) : (
          <button
            type="button"
            className="tb-title no-drag"
            title={t('点击重命名')}
            onClick={() => setEditing(chatTitle ?? '')}
          >
            <span className="ellipsis">{chatTitle === DEFAULT_TITLE ? t(DEFAULT_TITLE) : chatTitle}</span>
            <Icon name="edit" size={12} />
          </button>
        ))}

      <div className="grow tb-drag" />

      <button
        type="button"
        className="pill no-drag"
        data-optional="true"
        title={t('切换人格')}
        onClick={e => openMenu('persona', e.currentTarget)}
      >
        <Icon name="persona" size={13} />
        <span className="ellipsis" style={{ maxWidth: 116 }}>
          {t(personas.find(p => p.id === personaId)?.name ?? '通用助手')}
        </span>
        <Icon name="chevron-down" size={12} />
      </button>

      <button
        type="button"
        className="pill no-drag"
        data-optional="true"
        title={t('关联工作区')}
        onClick={e => openMenu('workspace', e.currentTarget)}
      >
        <Icon name="folder" size={13} />
        <span className="ellipsis" style={{ maxWidth: 128 }}>
          {workspaces.find(w => w.id === workspaceId)?.name ?? t('无工作区')}
        </span>
        <Icon name="chevron-down" size={12} />
      </button>

      <button
        type="button"
        className="icon-btn no-drag"
        title={t('导出当前会话')}
        aria-label={t('导出')}
        onClick={e => {
          if (!chatId) return;
          openMenu('export', e.currentTarget);
        }}
      >
        <Icon name="download" size={16} />
      </button>

      <button
        type="button"
        className="icon-btn no-drag"
        data-on={rightTab !== null}
        title={rightTab ? t('收起右侧栏') : t('打开右侧栏')}
        aria-label={t('右侧栏')}
        onClick={() => setRightTab(rightTab ? null : 'files')}
      >
        <Icon name={rightTab ? 'panel-right-off' : 'panel-right'} size={16} />
      </button>

      {/* 窗口控制：Windows / Linux 自绘；macOS 用系统红绿灯，这里不重复画 */}
      {window.naiwa?.platform !== 'darwin' && (
        <div className="win-ctl no-drag">
          <button
            type="button"
            className="win-btn"
            title={t('最小化')}
            aria-label={t('最小化')}
            onClick={() => void invoke('window:minimize', undefined)}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="win-btn"
            title={maximized ? t('向下还原') : t('最大化')}
            aria-label={maximized ? t('向下还原') : t('最大化')}
            onClick={() => void invoke('window:toggle-maximize', undefined).then(s => setMaximized(s.maximized))}
          >
            {maximized ? (
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <rect x="2.2" y="3.6" width="6.2" height="6.2" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
                <path d="M4 3.6V2.4h5.6v5.6H8.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            ) : (
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="win-btn win-close"
            title={t('关闭')}
            aria-label={t('关闭')}
            onClick={() => void invoke('window:close', undefined)}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      {menu && kind && (
        <Menu anchor={menu.anchor} align={menu.align} onClose={close}>
          {kind === 'persona' && (
            <>
              <MenuLabel>{t('人格')}</MenuLabel>
              {personas.map(p => (
                <MenuItem
                  key={p.id}
                  picked={personaId === p.id}
                  onClick={() => {
                    close();
                    void patchChat({ personaId: p.id });
                  }}
                >
                  {t(p.name)}
                </MenuItem>
              ))}
              <MenuSep />
              <MenuItem icon={<Icon name="persona" size={13} />} onClick={() => { close(); openSettings('personas'); }}>
                {t('管理人格')}
              </MenuItem>
            </>
          )}

          {kind === 'workspace' && (
            <>
              <MenuLabel>{t('关联工作区')}</MenuLabel>
              <MenuItem
                picked={!workspaceId}
                onClick={() => {
                  close();
                  if (!chatId) return;
                  void invoke('chat:move-to-workspace', { id: chatId, workspaceId: null }).then(res => {
                    useApp.setState({ chat: res.chat });
                    void useApp.getState().reloadChats();
                    if (res.error) toast(res.error, 'warn');
                  });
                }}
              >
                {t('不关联')}
              </MenuItem>
              {workspaces.map(w => (
                <MenuItem
                  key={w.id}
                  picked={workspaceId === w.id}
                  hint={w.path.split(/[\\/]/).filter(Boolean).pop()}
                  onClick={() => {
                    close();
                    if (!chatId) return;
                    void invoke('chat:move-to-workspace', { id: chatId, workspaceId: w.id }).then(res => {
                      useApp.setState({ chat: res.chat });
                      void useApp.getState().reloadChats();
                      if (res.error) toast(res.error, 'warn');
                      else if (res.moved) toast(t('会话已迁移到该工作区'), 'ok');
                    });
                  }}
                >
                  {w.name}
                </MenuItem>
              ))}
              <MenuSep />
              <MenuItem icon={<Icon name="folder" size={13} />} onClick={() => { close(); openSettings('workspaces'); }}>
                {t('管理工作区')}
              </MenuItem>
            </>
          )}

          {kind === 'export' && (
            <>
              <MenuLabel>{t('导出为')}</MenuLabel>
              {EXPORT_FORMATS.map(f => (
                <MenuItem
                  key={f.value}
                  hint={f.hint}
                  onClick={() => {
                    close();
                    if (!chatId) return;
                    void invoke('chat:export', { id: chatId, format: f.value }).then(
                      res => res && toast(`${t('已导出到')} ${res.path}`, 'ok'),
                    );
                  }}
                >
                  {t(f.label)}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
      )}
    </header>
  );
}
