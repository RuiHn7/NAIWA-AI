/* ============================================================================
 * src/components/settings/ShortcutsSection.tsx —— 快捷键一览
 * ==========================================================================*/

import { Group } from './ui';
import { useT } from '@/lib/i18n';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: '会话',
    items: [
      ['Ctrl / ⌘ + K', '新建会话'],
      ['Ctrl / ⌘ + B', '折叠 / 展开侧栏'],
      ['Ctrl / ⌘ + P', '命令面板'],
      ['Ctrl / ⌘ + ,', '打开设置'],
      ['Esc', '依次关闭：设置 → 面板 → 抽屉 → 停止生成'],
    ],
  },
  {
    title: '输入框',
    items: [
      ['Enter', '发送'],
      ['Shift + Enter', '换行'],
      ['Ctrl / ⌘ + Enter', '发送（编辑态下则是保存）'],
      ['粘贴图片或文件', '自动加入附件'],
    ],
  },
  {
    title: '列表与菜单',
    items: [
      ['↑ / ↓', '在菜单与命令面板里移动'],
      ['Enter', '执行当前项'],
      ['右键会话', '重命名 / 置顶 / 导出 / 删除'],
    ],
  },
];

export function ShortcutsSection() {
  const t = useT();

  return (
    <>
      {GROUPS.map(g => (
        <Group key={g.title} title={t(g.title)}>
          <div className="shortcut-grid">
            {g.items.map(([keys, desc]) => (
              <div key={keys} className="shortcut-row" style={{ display: 'contents' }}>
                <span className="kbd">{t(keys)}</span>
                <span style={{ fontSize: 12.3, color: 'var(--ink-2)' }}>{t(desc)}</span>
              </div>
            ))}
          </div>
        </Group>
      ))}

      <Group title={t('说明')}>
        <div className="dim" style={{ fontSize: 12, lineHeight: 1.8 }}>
          {t('macOS 上把 Ctrl 换成 ⌘。所有快捷键在输入框获得焦点时仍然生效，除了纯字母组合。')}
        </div>
      </Group>
    </>
  );
}
