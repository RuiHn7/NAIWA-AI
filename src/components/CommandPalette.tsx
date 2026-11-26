/* ============================================================================
 * src/components/CommandPalette.tsx —— 命令面板（Ctrl/⌘ + K 之外的 Ctrl/⌘ + P 也走这里）
 *   支持：切会话、新建会话、跳设置分区、导出、压缩上下文、切换主题
 * ==========================================================================*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { useApp } from '@/store/useApp';
import { invoke } from '@/lib/bridge';
import { relativeTime } from '@/lib/format';
import { translate } from '@/lib/i18n';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const open = useApp(s => s.paletteOpen);
  const setPalette = useApp(s => s.setPalette);
  const chats = useApp(s => s.chats);
  const openChat = useApp(s => s.openChat);
  const newChat = useApp(s => s.newChat);
  const openSettings = useApp(s => s.openSettings);
  const compress = useApp(s => s.compress);
  const saveSettings = useApp(s => s.saveSettings);
  const settings = useApp(s => s.settings);
  // 性能：只订阅会话 id（导出命令只需要它）
  const chatId = useApp(s => s.chat?.id);
  const toast = useApp(s => s.toast);
  const locale = useApp(s => s.settings?.locale);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const close = () => setPalette(false);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'new-chat',
        label: '新建对话',
        hint: 'Ctrl N',
        icon: 'plus',
        run: () => void newChat(null),
      },
      {
        id: 'settings-general',
        label: '打开设置',
        hint: 'Ctrl ,',
        icon: 'settings',
        run: () => openSettings('general'),
      },
      {
        id: 'settings-general-tab',
        label: '设置 · 通用',
        icon: 'settings',
        run: () => openSettings('general'),
      },
      {
        id: 'settings-providers',
        label: '设置 · 接入模型',
        icon: 'spark',
        run: () => openSettings('providers'),
      },
      {
        id: 'settings-workspaces',
        label: '设置 · 工作区',
        icon: 'folder',
        run: () => openSettings('workspaces'),
      },
      {
        id: 'settings-memory',
        label: '设置 · 记忆',
        icon: 'brain',
        run: () => openSettings('memory'),
      },
      {
        id: 'settings-personas',
        label: '设置 · 人格',
        icon: 'persona',
        run: () => openSettings('personas'),
      },
      {
        id: 'settings-mcp',
        label: '设置 · MCP 工具',
        icon: 'mcp',
        run: () => openSettings('mcp'),
      },
      {
        id: 'settings-tasks',
        label: '设置 · 定时任务',
        icon: 'clock',
        run: () => openSettings('tasks'),
      },
      {
        id: 'settings-images',
        label: '设置 · 图片生成',
        icon: 'image',
        run: () => openSettings('images'),
      },
      {
        id: 'settings-usage',
        label: '设置 · 用量统计',
        icon: 'chart',
        run: () => openSettings('usage'),
      },
      {
        id: 'settings-approval',
        label: '设置 · 权限与审计',
        icon: 'shield',
        run: () => openSettings('approval'),
      },
      {
        id: 'settings-shortcuts',
        label: '设置 · 快捷键',
        icon: 'keyboard',
        run: () => openSettings('shortcuts'),
      },
      {
        id: 'compress',
        label: '压缩当前上下文',
        icon: 'collapse',
        run: async () => {
          await compress(true);
        },
      },
      {
        id: 'export',
        label: '导出当前会话（Markdown）',
        icon: 'download',
        run: async () => {
          if (!chatId) return;
          const res = await invoke('chat:export', { id: chatId, format: 'md' });
          if (res) toast(`${translate('已导出到', locale)} ${res.path}`, 'ok');
        },
      },
      {
        id: 'theme',
        label: settings?.theme === 'light' ? '切换到深色主题' : '切换到浅色主题',
        icon: settings?.theme === 'light' ? 'moon' : 'sun',
        run: () => void saveSettings({ theme: settings?.theme === 'light' ? 'dark' : 'light' }),
      },
    ];
    return list;
  }, [newChat, openSettings, compress, chatId, toast, saveSettings, settings?.theme, locale]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cmd = q ? commands.filter(c => c.label.toLowerCase().includes(q)) : commands;
    const chatHits = q
      ? chats.filter(c => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q)).slice(0, 8)
      : chats.slice(0, 5);
    return [
      ...cmd.map(c => ({ type: 'cmd' as const, command: c })),
      ...chatHits.map(c => ({ type: 'chat' as const, summary: c })),
    ];
  }, [query, commands, chats]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    if (cursor >= items.length) setCursor(Math.max(0, items.length - 1));
  }, [items.length, cursor]);

  // 键盘滚动到可见
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const runAt = (index: number) => {
    const item = items[index];
    if (!item) return;
    close();
    if (item.type === 'cmd') void item.command.run();
    else void openChat(item.summary.id);
  };

  return (
    <div className="overlay" style={{ alignItems: 'flex-start' }} onClick={close}>
      <div className="palette" onClick={e => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder={translate('搜索会话或输入命令…', locale)}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                close();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor(c => Math.min(items.length - 1, c + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor(c => Math.max(0, c - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runAt(cursor);
              }
            }}
          />
          <span className="kbd">Esc</span>
        </div>

        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">{translate('没有匹配的会话或命令', locale)}</div>}
          {items.map((item, index) =>
            item.type === 'cmd' ? (
              <button
                key={`cmd-${item.command.id}`}
                type="button"
                className="palette-item"
                data-active={index === cursor}
                onMouseEnter={() => setCursor(index)}
                onClick={() => runAt(index)}
              >
                <Icon name={item.command.icon} size={14} />
                <span className="ellipsis">{translate(item.command.label, locale)}</span>
                {item.command.hint && <span className="pi-hint">{item.command.hint}</span>}
              </button>
            ) : (
              <button
                key={`chat-${item.summary.id}`}
                type="button"
                className="palette-item"
                data-active={index === cursor}
                onMouseEnter={() => setCursor(index)}
                onClick={() => runAt(index)}
              >
                <Icon name="dots" size={14} />
                <span className="ellipsis">{item.summary.title}</span>
                <span className="pi-hint">{relativeTime(item.summary.updatedAt)}</span>
              </button>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
