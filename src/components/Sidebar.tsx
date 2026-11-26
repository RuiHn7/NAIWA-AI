/* ============================================================================
 * src/components/Sidebar.tsx —— 左侧会话栏
 *   · 工作区分组（有工作区时才出现）：节点可展开/收起，列出该工作区下的会话
 *   · 工作区节点支持右键菜单：在资源管理器中打开 / 重命名 / 移除 / 连目录删除
 *   · 其余会话按最后活跃时间分桶：今天 / 昨天 / 本周 / 更早
 *   · 会话项可拖拽：拖到工作区节点 = 迁移（磁盘文件夹一并移动，PRD 五）
 *   · 折叠态只保留图标与圆点；拖右缘调宽（clamp 200–520）
 *   · 底部用户卡靠左、设置按钮靠右，同一行
 * ==========================================================================*/

import { memo, useCallback, useMemo, useState } from 'react';
import { useApp } from '@/store/useApp';
import { Icon } from '@/components/Icon';
import { BrandMark } from '@/components/Brand';
import { Menu, MenuItem, MenuLabel, MenuSep, useMenu } from '@/components/Menu';
import { dayBucket, formatDay } from '@/lib/format';
import { invoke } from '@/lib/bridge';
import { useT } from '@/lib/i18n';
import type { ChatSummary } from '@shared/types';

interface SidebarProps {
  onCloseDrawer: () => void;
}

const ORDER = ['今天', '昨天', '本周', '更早'] as const;

/** 主进程新建会话时写的中文默认标题；显示时换成当前语言 */
const DEFAULT_TITLE = '新对话';

/** 版本更新的仓库地址（侧栏「新版本」胶囊点开就是这里） */
const REPO_URL = 'https://github.com/RuiHn7/NAIWA-AI';

function highlightText(title: string, query: string) {
  const q = query.trim();
  if (!q) return title;
  const idx = title.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return title;
  return (
    <>
      {title.slice(0, idx)}
      <mark>{title.slice(idx, idx + q.length)}</mark>
      {title.slice(idx + q.length)}
    </>
  );
}

export function Sidebar({ onCloseDrawer }: SidebarProps) {
  const chats = useApp(s => s.chats);
  // 性能：只订阅当前会话的 id。订阅整个 chat 会让侧栏在流式期间（45ms 一次 flush）跟着重渲染。
  const activeChatId = useApp(s => s.chat?.id);
  const settings = useApp(s => s.settings);
  const searchQuery = useApp(s => s.searchQuery);
  const workspaces = useApp(s => s.workspaces);
  const pendingCount = useApp(s => s.pendingApprovals.length);

  const setSearchQuery = useApp(s => s.setSearchQuery);
  const openChat = useApp(s => s.openChat);
  const newChat = useApp(s => s.newChat);
  const deleteChat = useApp(s => s.deleteChat);
  const renameChat = useApp(s => s.renameChat);
  const togglePin = useApp(s => s.togglePin);
  const t = useT();
  const openSettings = useApp(s => s.openSettings);
  const saveSettings = useApp(s => s.saveSettings);
  const setRightTab = useApp(s => s.setRightTab);
  const toast = useApp(s => s.toast);
  const update = useApp(s => s.update);
  const dismissUpdate = useApp(s => s.dismissUpdate);

  const { menu, open, close } = useMenu();
  const [menuChatId, setMenuChatId] = useState<string | null>(null);
  const [menuWorkspaceId, setMenuWorkspaceId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [renamingWs, setRenamingWs] = useState<{ id: string; value: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragOver, setDragOver] = useState<string | null>(null);

  const collapsed = settings?.sidebarCollapsed ?? false;

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(c => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q));
  }, [chats, searchQuery]);

  /* 工作区分组 + 时间分桶 */
  const { pinned, byWorkspace, looseGroups } = useMemo(() => {
    const pinnedList: ChatSummary[] = [];
    const wsMap = new Map<string, ChatSummary[]>();
    const bucketMap = new Map<string, ChatSummary[]>();

    for (const c of filtered) {
      if (c.pinned) {
        pinnedList.push(c);
        continue;
      }
      if (c.workspaceId) {
        const list = wsMap.get(c.workspaceId) ?? [];
        list.push(c);
        wsMap.set(c.workspaceId, list);
      } else {
        const bucket = dayBucket(c.updatedAt);
        const list = bucketMap.get(bucket) ?? [];
        list.push(c);
        bucketMap.set(bucket, list);
      }
    }

    const loose: { label: string; items: ChatSummary[] }[] = [];
    for (const label of ORDER) {
      const items = bucketMap.get(label);
      if (items?.length) loose.push({ label, items });
    }
    return { pinned: pinnedList, byWorkspace: wsMap, looseGroups: loose };
  }, [filtered]);

  const workspaceGroups = useMemo(
    () =>
      workspaces
        .map(w => ({ workspace: w, items: byWorkspace.get(w.id) ?? [] }))
        // 搜索时隐藏没有命中的工作区节点
        .filter(g => !searchQuery.trim() || g.items.length > 0),
    [workspaces, byWorkspace, searchQuery],
  );

  /* -------------------------------------------------------------- 拖拽迁移 */

  const moveChat = useCallback(
    async (chatId: string, workspaceId: string | null) => {
      const res = await invoke('chat:move-to-workspace', { id: chatId, workspaceId });
      const state = useApp.getState();
      if (state.chat?.id === chatId) useApp.setState({ chat: res.chat });
      await state.reloadChats();
      if (res.error) toast(res.error, 'error');
      else if (workspaceId) toast(t('已移动到工作区'), 'ok');
      else toast(t('已移出工作区'), 'ok');
    },
    [toast, t],
  );

  const onDragStart = (e: React.DragEvent, item: ChatSummary) => {
    e.dataTransfer.setData('text/naiwa-chat', item.id);
    e.dataTransfer.effectAllowed = 'move';
    // 整条会话项跟随鼠标的半透明拖影（PRD 五）
    const node = e.currentTarget as HTMLElement;
    const ghost = node.cloneNode(true) as HTMLElement;
    ghost.style.cssText = `position:fixed;top:-9999px;left:-9999px;width:${node.offsetWidth}px;opacity:.72;pointer-events:none`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 18, 16);
    setTimeout(() => ghost.remove(), 0);
    setDragging(true);
  };

  const onDragEnd = () => {
    setDragging(false);
    setDragOver(null);
  };

  const dragOverZone = (e: React.DragEvent, key: string) => {
    if (!e.dataTransfer.types.includes('text/naiwa-chat')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOver !== key) setDragOver(key);
  };

  const dropOnZone = (e: React.DragEvent, key: string, workspaceId: string | null) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/naiwa-chat');
    setDragOver(null);
    setDragging(false);
    if (id) void moveChat(id, workspaceId);
  };

  /* -------------------------------------------------------------- 拖拽调宽 */

  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = settings?.sidebarWidth ?? 268;
      setDragging(true);
      document.body.classList.add('resizing');

      const onMove = (e: PointerEvent) => {
        const next = Math.max(200, Math.min(520, startWidth + (e.clientX - startX)));
        document.documentElement.style.setProperty('--sidebar-w', `${next}px`);
      };
      const onUp = (e: PointerEvent) => {
        const next = Math.max(200, Math.min(520, startWidth + (e.clientX - startX)));
        void saveSettings({ sidebarWidth: next });
        setDragging(false);
        document.body.classList.remove('resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [collapsed, settings?.sidebarWidth, saveSettings],
  );

  /* -------------------------------------------------------------- 渲染 */

  const onSelect = (id: string) => {
    void openChat(id);
    if (window.innerWidth <= 900) onCloseDrawer();
  };

  const submitRename = () => {
    if (!renaming) return;
    const value = renaming.value.trim();
    if (value) void renameChat(renaming.id, value);
    setRenaming(null);
  };

  const submitWsRename = () => {
    const target = renamingWs;
    setRenamingWs(null);
    if (!target) return;
    const value = target.value.trim();
    if (!value) return;
    void invoke('workspace:update', { id: target.id, patch: { name: value } }).then(() => {
      const state = useApp.getState();
      void state.reloadWorkspaces();
      void state.reloadChats();
    });
  };

  /** 工作区右键：在资源管理器中打开 / 重命名 / 移除（磁盘可选） */
  const openWorkspaceMenu = (el: HTMLElement, workspaceId: string) => {
    setMenuChatId(null);
    setMenuWorkspaceId(workspaceId);
    open(el, 'left');
  };

  const removeWorkspace = async (workspaceId: string, deleteFolder: boolean) => {
    const ws = workspaces.find(w => w.id === workspaceId);
    if (!ws) return;
    const tip = deleteFolder
      ? `${t('同时删除磁盘目录')} ${ws.path}？`
      : t('只从列表里移除，磁盘文件保留。');
    const ok = await useApp.getState().askConfirm({
      title: `${t('移除工作区')}「${ws.name}」`,
      body: tip,
      confirmText: deleteFolder ? t('连目录一起删除') : t('移除工作区'),
      danger: deleteFolder,
    });
    if (!ok) return;
    try {
      await invoke('workspace:delete', { id: ws.id, deleteFolder });
      const state = useApp.getState();
      await state.reloadWorkspaces();
      await state.reloadChats();
      toast(t('已移除'), 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  /** 点「新对话」后把光标送回输入框：就算复用的是同一个空白会话，也有可见反馈 */
  const startNewChat = () => {
    void newChat(null).then(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>('.composer textarea');
        el?.focus();
      });
    });
  };

  /** 侧栏直接创建工作区：选目录 → 用末段目录名当名字 → 建好后立刻展开 */
  const createWorkspace = async () => {
    try {
      const picked = await invoke('workspace:pick-folder', undefined);
      if (!picked?.path) return;
      const name = picked.path.split(/[\\/]/).filter(Boolean).pop() || t('工作区');
      const ws = await invoke('workspace:create', { name, path: picked.path });
      const state = useApp.getState();
      await state.reloadWorkspaces();
      await state.reloadChats();
      setExpanded(prev => ({ ...prev, [ws.id]: true }));
      toast(t('工作区已创建'), 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const renderItem = (item: ChatSummary, zoneKey: string) => (
    <div
      key={item.id}
      className="sb-item"
      data-active={item.id === activeChatId}
      data-drag-over={dragOver === zoneKey}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={e => onDragStart(e, item)}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(item.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(item.id);
        }
      }}
      onContextMenu={e => {
        e.preventDefault();
        setMenuWorkspaceId(null);
        setMenuChatId(item.id);
        open(e.currentTarget.querySelector('.sb-item-more') as HTMLElement, 'left');
      }}
      title={`${item.title === DEFAULT_TITLE ? t(DEFAULT_TITLE) : item.title}\n${formatDay(item.updatedAt)} · ${item.messageCount} ${t('条消息')}${item.folder ? `\n${item.folder}` : ''}`}
    >
      {item.pinned && (
        <span className="sb-item-pin sb-hide">
          <Icon name="pin" size={11} />
        </span>
      )}
      <span className="sb-item-title">
        {renaming?.id === item.id ? (
          <input
            className="tb-title-input"
            autoFocus
            value={renaming.value}
            onChange={e => setRenaming({ id: item.id, value: e.target.value })}
            onClick={e => e.stopPropagation()}
            onBlur={submitRename}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          highlightText(item.title === DEFAULT_TITLE ? t(DEFAULT_TITLE) : item.title, searchQuery)
        )}
      </span>
      <button
        type="button"
        className="sb-item-more"
        aria-label={t('会话操作')}
        onClick={e => {
          e.stopPropagation();
          setMenuWorkspaceId(null);
          setMenuChatId(item.id);
          open(e.currentTarget, 'left');
        }}
      >
        <Icon name="dots" size={14} />
      </button>
    </div>
  );

  const hasAny = pinned.length > 0 || workspaceGroups.length > 0 || looseGroups.length > 0;

  return (
    <aside className="sidebar" aria-label={t('会话栏')}>
      <div className="sb-head">
        <button
          type="button"
          className="wordmark"
          onClick={() => openSettings('general')}
          title={`NAI WA · ${t('设置')}`}
        >
          <BrandMark size={24} />
          <span className="wordmark-text sb-hide">
            <span className="wordmark-title">NAI·WA</span>
            <span className="wordmark-sub">AIGC</span>
          </span>
        </button>
        <div className="grow" />
        {!collapsed && (
          <button
            type="button"
            className="icon-btn sb-hide"
            title={t('折叠侧栏 (Ctrl+B)')}
            aria-label={t('折叠侧栏')}
            onClick={() => void saveSettings({ sidebarCollapsed: true })}
          >
            <Icon name="collapse" size={16} />
          </button>
        )}
      </div>

      <div className="sb-actions">
        <button type="button" className="sb-action" onClick={startNewChat} title={t('新对话 (Ctrl+N)')}>
          <Icon name="plus" size={16} />
          <span>{t('新对话')}</span>
          <span className="kbd sb-hide">Ctrl N</span>
        </button>
        <button
          type="button"
          className="sb-action"
          onClick={() => setRightTab('files')}
          title={t('工作区与产物')}
        >
          <Icon name="folder" size={16} />
          <span>{t('工作区')}</span>
          {workspaces.length > 0 && <span className="kbd sb-hide">{workspaces.length}</span>}
        </button>
        <button
          type="button"
          className="sb-action"
          onClick={() => void createWorkspace()}
          title={t('创建工作区')}
        >
          <Icon name="plus" size={16} />
          <span>{t('创建工作区')}</span>
        </button>
        <button type="button" className="sb-action" onClick={() => openSettings('approval')} title={t('权限与审计')}>
          <Icon name="shield" size={16} />
          <span>{t('权限')}</span>
          {pendingCount > 0 ? (
            <span className="kbd sb-hide" style={{ color: 'var(--warn)' }}>{pendingCount}</span>
          ) : null}
        </button>
      </div>

      <div className="sb-search sb-hide">
        <span className="sb-search-icon">
          <Icon name="search" size={13} />
        </span>
        <input
          value={searchQuery}
          placeholder={t('搜索会话')}
          aria-label={t('搜索会话')}
          onChange={e => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button type="button" className="sb-search-clear" aria-label={t('清空')} onClick={() => setSearchQuery('')}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      <div className="sb-list" data-dragging={dragging}>
        {!hasAny && (
          <p className="sb-empty">{searchQuery ? t('没有匹配的会话') : t('还没有会话')}</p>
        )}

        {pinned.length > 0 && (
          <div>
            <div className="sb-group-label">
              <span>{t('置顶')}</span>
            </div>
            {pinned.map(item => renderItem(item, `pin:${item.id}`))}
          </div>
        )}

        {/* 工作区分组：只在存在工作区时显示（PRD 五） */}
        {workspaceGroups.map(({ workspace, items }) => {
          const opened = expanded[workspace.id] ?? true;
          const zoneKey = `ws:${workspace.id}`;
          return (
            <div
              key={workspace.id}
              className="sb-ws"
              data-drop={dragOver === zoneKey}
              onDragOver={e => {
                dragOverZone(e, zoneKey);
                // 悬停自动展开（PRD 五）
                if (!opened) setExpanded(s => ({ ...s, [workspace.id]: true }));
              }}
              onDragLeave={() => setDragOver(cur => (cur === zoneKey ? null : cur))}
              onDrop={e => dropOnZone(e, zoneKey, workspace.id)}
            >
              <div
                className="sb-group-label sb-ws-head"
                role="button"
                tabIndex={0}
                onClick={() => setExpanded(s => ({ ...s, [workspace.id]: !opened }))}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setExpanded(s => ({ ...s, [workspace.id]: !opened }));
                  }
                }}
                onContextMenu={e => {
                  e.preventDefault();
                  openWorkspaceMenu(e.currentTarget, workspace.id);
                }}
                title={workspace.path}
              >
                <Icon name={opened ? 'chevron-down' : 'chevron-right'} size={11} />
                <Icon name="folder" size={12} />
                <span className="ellipsis">
                  {renamingWs?.id === workspace.id ? (
                    <input
                      className="tb-title-input"
                      autoFocus
                      value={renamingWs.value}
                      onChange={e => setRenamingWs({ id: workspace.id, value: e.target.value })}
                      onClick={e => e.stopPropagation()}
                      onBlur={submitWsRename}
                      onKeyDown={e => {
                        e.stopPropagation();
                        if (e.key === 'Enter') submitWsRename();
                        if (e.key === 'Escape') setRenamingWs(null);
                      }}
                    />
                  ) : (
                    workspace.name
                  )}
                </span>
                {items.length > 0 && <span className="sb-ws-count">{items.length}</span>}
              </div>
              {opened && items.map(item => renderItem(item, `${zoneKey}:${item.id}`))}
            </div>
          );
        })}

        {/* 未关联工作区的会话，按活跃时间分桶，可拖走也可拖回来 */}
        {looseGroups.map(group => {
          const zoneKey = `bucket:${group.label}`;
          return (
            <div
              key={group.label}
              data-drop={dragOver === zoneKey}
              onDragOver={e => dragOverZone(e, zoneKey)}
              onDragLeave={() => setDragOver(cur => (cur === zoneKey ? null : cur))}
              onDrop={e => dropOnZone(e, zoneKey, null)}
            >
              <div className="sb-group-label">
                <span>{t(group.label)}</span>
              </div>
              {group.items.map(item => renderItem(item, `${zoneKey}:${item.id}`))}
            </div>
          );
        })}
      </div>

      {/* 有新版时：用户卡片正上方一条蓝色胶囊，点开就去 GitHub 看 release */}
      {update?.hasUpdate && update.latest && (
        <button
          type="button"
          className="sb-update"
          onClick={() => {
            const url = update.url ?? REPO_URL;
            void invoke('workspace:open-path', { path: url });
          }}
          title={`${t('新版本')} ${update.latest}`}
        >
          <Icon name="download" size={12} />
          <span className="sb-update-text">{t('新版本')}</span>
          <span className="sb-update-ver mono">{update.latest}</span>
          <span
            className="sb-update-x"
            role="button"
            tabIndex={-1}
            aria-label={t('忽略')}
            onClick={e => {
              e.stopPropagation();
              dismissUpdate();
            }}
          >
            <Icon name="x" size={10} />
          </span>
        </button>
      )}

      {/* 底部：用户卡靠左、设置按钮靠右（同一行） */}
      <div className="sb-foot">
        <button
          type="button"
          className="sb-user"
          onClick={() => openSettings('general')}
          title="NAI WA"
          aria-label="NAI WA"
        >
          <BrandMark size={24} />
          <span className="sb-user-meta sb-hide">
            <span className="sb-user-name">NAI WA</span>
            <span className="sb-user-sub">{t('本地工作台')}</span>
          </span>
        </button>
        <button
          type="button"
          className="sb-icon-btn"
          onClick={() => openSettings('general')}
          title={t('设置')}
          aria-label={t('设置')}
        >
          <Icon name="settings" size={16} />
        </button>
      </div>

      <div
        className="sb-resizer"
        data-dragging={dragging}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('调整侧栏宽度')}
        onPointerDown={onResizeStart}
      />

      {menu && (
        <Menu anchor={menu.anchor} align={menu.align} onClose={close}>
          {menuWorkspaceId ? (
            <>
              <MenuLabel>{t('工作区')}</MenuLabel>
              <MenuItem
                icon={<Icon name="plus" size={14} />}
                onClick={() => {
                  const id = menuWorkspaceId;
                  close();
                  if (id) void newChat(id);
                }}
              >
                {t('创建新对话')}
              </MenuItem>
              <MenuItem
                icon={<Icon name="folder" size={14} />}
                onClick={() => {
                  const id = menuWorkspaceId;
                  close();
                  if (id) void invoke('workspace:open-folder', { id });
                }}
              >
                {t('在资源管理器中打开')}
              </MenuItem>
              <MenuItem
                icon={<Icon name="edit" size={14} />}
                onClick={() => {
                  const id = menuWorkspaceId;
                  close();
                  if (!id) return;
                  const target = workspaces.find(w => w.id === id);
                  setRenamingWs({ id, value: target?.name ?? '' });
                }}
              >
                {t('重命名工作区')}
              </MenuItem>
              <MenuSep />
              <MenuItem
                icon={<Icon name="x" size={14} />}
                onClick={() => {
                  const id = menuWorkspaceId;
                  close();
                  if (id) void removeWorkspace(id, false);
                }}
              >
                {t('移除工作区')}
              </MenuItem>
              <MenuItem
                icon={<Icon name="trash" size={14} />}
                tone="danger"
                onClick={() => {
                  const id = menuWorkspaceId;
                  close();
                  if (id) void removeWorkspace(id, true);
                }}
              >
                {t('连目录一起删除')}
              </MenuItem>
            </>
          ) : (
            <>
              <MenuLabel>{t('会话')}</MenuLabel>
              <MenuItem
                icon={<Icon name="edit" size={14} />}
                onClick={() => {
                  const id = menuChatId;
                  close();
                  if (!id) return;
                  const target = chats.find(c => c.id === id);
                  setRenaming({ id, value: target?.title ?? '' });
                }}
              >
                {t('重命名')}
              </MenuItem>
              <MenuItem
                icon={<Icon name="folder" size={14} />}
                onClick={() => {
                  const id = menuChatId;
                  close();
                  if (!id) return;
                  void invoke('chat:reveal', { id }).then(res => {
                    if (res.error) useApp.getState().toast(res.error, 'error');
                  });
                }}
              >
                {t('在资源管理器中查看')}
              </MenuItem>
              <MenuItem
                icon={<Icon name="file" size={14} />}
                onClick={() => {
                  const id = menuChatId;
                  close();
                  if (!id) return;
                  void invoke('chat:rename-folder', { id }).then(res => {
                    const state = useApp.getState();
                    if (res.error) state.toast(res.error, 'error');
                    else {
                      void state.reloadChats();
                      state.toast(t('文件夹名已同步'), 'ok');
                    }
                  });
                }}
              >
                {t('同步文件夹名')}
              </MenuItem>
              <MenuItem
                icon={<Icon name="pin" size={14} />}
                onClick={() => {
                  const id = menuChatId;
                  close();
                  if (id) void togglePin(id);
                }}
              >
                {chats.find(c => c.id === menuChatId)?.pinned ? t('取消置顶') : t('置顶')}
              </MenuItem>
              <MenuSep />
              <MenuLabel>{t('移动到工作区')}</MenuLabel>
              <MenuItem
                picked={!chats.find(c => c.id === menuChatId)?.workspaceId}
                onClick={() => {
                  const id = menuChatId;
                  close();
                  if (id) void moveChat(id, null);
                }}
              >
                {t('不关联')}
              </MenuItem>
              {workspaces.map(w => (
                <MenuItem
                  key={w.id}
                  picked={chats.find(c => c.id === menuChatId)?.workspaceId === w.id}
                  onClick={() => {
                    const id = menuChatId;
                    close();
                    if (id) void moveChat(id, w.id);
                  }}
                >
                  {w.name}
                </MenuItem>
              ))}
              <MenuSep />
              <MenuLabel>{t('导出')}</MenuLabel>
              {(['md', 'json', 'html'] as const).map(f => (
                <MenuItem
                  key={f}
                  icon={<Icon name="download" size={14} />}
                  hint={`.${f}`}
                  onClick={() => {
                    const id = menuChatId;
                    close();
                    if (id) {
                      void invoke('chat:export', { id, format: f }).then(
                        res => res && useApp.getState().toast(`${t('已导出到')} ${res.path}`, 'ok'),
                      );
                    }
                  }}
                >
                  {f === 'md' ? 'Markdown' : f === 'json' ? 'JSON' : t('单文件 HTML')}
                </MenuItem>
              ))}
              <MenuSep />
              <MenuItem
                icon={<Icon name="trash" size={14} />}
                tone="danger"
                onClick={() => {
                  const id = menuChatId;
                  close();
                  if (id) void deleteChat(id);
                }}
              >
                {t('删除会话')}
              </MenuItem>
            </>
          )}
        </Menu>
      )}
    </aside>
  );
}

export const SidebarMemo = memo(Sidebar);
