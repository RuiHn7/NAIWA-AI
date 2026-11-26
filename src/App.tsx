/* ============================================================================
 * src/App.tsx —— 根布局
 *   ┌────────┬──────────────────────────────────┬──────────┐
 *   │ 侧栏   │ 顶栏                              │ 右面板   │
 *   │        │ 消息列 / 空状态                    │          │
 *   │        │ 审批卡 + 输入区                    │          │
 *   └────────┴──────────────────────────────────┴──────────┘
 * ==========================================================================*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SidebarMemo } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { MessageList, scrollThreadToBottom } from '@/components/MessageList';
import { EmptyState } from '@/components/EmptyState';
import { Composer } from '@/components/Composer';
import { ApprovalStack } from '@/components/ApprovalStack';
import { RightPanel } from '@/components/RightPanel';
import { CommandPalette } from '@/components/CommandPalette';
import { ToastStack } from '@/components/ToastStack';
import { ConfirmHost } from '@/components/ConfirmHost';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { Icon } from '@/components/Icon';
import { api, isDesktop } from '@/lib/bridge';
import { useT } from '@/lib/i18n';
import { useApp } from '@/store/useApp';

const MOBILE_QUERY = '(max-width: 900px)';

export default function App() {
  const t = useT();
  const ready = useApp(s => s.ready);
  const bootError = useApp(s => s.bootError);
  const settings = useApp(s => s.settings);
  // 性能：只订阅消息条数，避免流式期间（45ms 一次 flush）根组件整棵树重渲染
  const messageCount = useApp(s => s.chat?.messages.length ?? 0);
  const streamingChatId = useApp(s => s.streamingChatId);
  const paletteOpen = useApp(s => s.paletteOpen);
  const settingsOpen = useApp(s => s.settingsOpen);

  const bootstrap = useApp(s => s.bootstrap);
  const newChat = useApp(s => s.newChat);
  const stop = useApp(s => s.stop);
  const setPalette = useApp(s => s.setPalette);
  const openSettings = useApp(s => s.openSettings);
  const closeSettings = useApp(s => s.closeSettings);
  const saveSettings = useApp(s => s.saveSettings);

  const [drawerOpen, setDrawerOpen] = useState(false);
  // 「回到最新」胶囊现在挂在输入框上方右侧，所以离底状态要提到这一层
  const [atBottom, setAtBottom] = useState(true);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );

  /* ------------------------------------------------------------- 启动 */

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /* ------------------------------------------------------------- 侧栏宽度 */

  useEffect(() => {
    if (!settings) return;
    document.documentElement.style.setProperty('--sidebar-w', `${settings.sidebarWidth}px`);
    document.documentElement.style.setProperty('--right-w', `${settings.rightPanelWidth}px`);
    document.documentElement.dataset.platform = api.platform;
  }, [settings]);

  /* ------------------------------------------------------------- 窄屏 */

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => {
      setIsMobile(mql.matches);
      setDrawerOpen(false);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  /* ------------------------------------------------------------- 快捷键 */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        void newChat(null);
        return;
      }
      if (mod && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setPalette(!paletteOpen);
        return;
      }
      if (mod && event.key === ',') {
        event.preventDefault();
        openSettings('general');
        return;
      }
      if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        if (settings) void saveSettings({ sidebarCollapsed: !settings.sidebarCollapsed });
        return;
      }
      if (event.key === 'Escape') {
        if (settingsOpen) {
          closeSettings();
          return;
        }
        if (paletteOpen) {
          setPalette(false);
          return;
        }
        if (drawerOpen) {
          setDrawerOpen(false);
          return;
        }
        if (streamingChatId) void stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    newChat,
    setPalette,
    paletteOpen,
    openSettings,
    settingsOpen,
    closeSettings,
    drawerOpen,
    streamingChatId,
    stop,
    settings,
    saveSettings,
  ]);

  /* ------------------------------------------------------------- 派生 */

  const collapsed = isMobile ? !drawerOpen : (settings?.sidebarCollapsed ?? false);
  const hasMessages = messageCount > 0;

  const onOpenDrawer = useCallback(() => setDrawerOpen(true), []);
  const onCloseDrawer = useCallback(() => setDrawerOpen(false), []);

  /* ------------------------------------------------------------- 渲染 */

  if (bootError) {
    return (
      <div className="crash">
        <div className="crash-card">
          <h2 className="crash-title">{t('启动失败')}</h2>
          <p className="crash-detail">{bootError}</p>
          <button type="button" className="btn" data-variant="primary" onClick={() => window.location.reload()}>
            {t('重新加载')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="app" data-collapsed={collapsed} data-resizing="false">
        <SidebarMemo onCloseDrawer={onCloseDrawer} />

        {isMobile && drawerOpen && <div className="scrim" onClick={onCloseDrawer} />}

        <main className="main">
          <TopBar onOpenDrawer={onOpenDrawer} />

          <div className="thread-shell">
            {!ready ? (
              <div className="thread-scroll">
                <div className="thread">
                  <div className="skeleton" style={{ height: 26, width: '38%', borderRadius: 8 }} />
                  <div className="skeleton" style={{ height: 96, borderRadius: 12 }} />
                  <div className="skeleton" style={{ height: 96, borderRadius: 12 }} />
                </div>
              </div>
            ) : hasMessages ? (
              <MessageList onAtBottomChange={setAtBottom} />
            ) : (
              <div className="thread-scroll" id="thread-scroll">
                <EmptyState />
              </div>
            )}

            <ApprovalStack />

            {/* 「回到最新」贴输入框上沿、靠右 —— 留在滚动容器里会跟着内容一起滚走 */}
            {hasMessages && !atBottom && (
              <div className="jump-latest-row">
                <button
                  type="button"
                  className="jump-latest"
                  onClick={() => scrollThreadToBottom(true)}
                  title={t('回到最新')}
                >
                  <Icon name="chevron-down" size={13} />
                  {t('回到最新')}
                </button>
              </div>
            )}

            <Composer />
          </div>
        </main>

        <RightPanel />
      </div>

      {settingsOpen && <SettingsModal />}
      <CommandPalette />
      <ToastStack />
      <ConfirmHost />

      {!isDesktop && (
        <div className="browser-hint">
          <Icon name="alert" size={13} />
          {t('正在浏览器中预览，桌面能力（文件 / 命令 / 模型）不可用')}
        </div>
      )}
    </ErrorBoundary>
  );
}
