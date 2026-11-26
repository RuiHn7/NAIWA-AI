/* ============================================================================
 * src/components/settings/SettingsModal.tsx —— 设置弹窗外壳
 *   左侧分区导航 + 右侧内容区，Escape 关闭由 App 统一处理。
 * ==========================================================================*/

import { useMemo, type ReactElement } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { GeneralSection } from './GeneralSection';
import { ProvidersSection } from './ProvidersSection';
import { WorkspacesSection } from './WorkspacesSection';
import { MemorySection } from './MemorySection';
import { PersonasSection } from './PersonasSection';
import { McpSection } from './McpSection';
import { TasksSection } from './TasksSection';
import { ImagesSection } from './ImagesSection';
import { UsageSection } from './UsageSection';
import { ApprovalSection } from './ApprovalSection';
import { ShortcutsSection } from './ShortcutsSection';
import { UpdateSection } from './UpdateSection';

interface SectionDef {
  key: string;
  label: string;
  icon: IconName;
  title: string;
  desc: string;
  Comp: () => ReactElement | null;
}

export const SECTIONS: SectionDef[] = [
  { key: 'general', label: '通用', icon: 'settings', title: '通用', desc: '主题、语言、默认思考强度', Comp: GeneralSection },
  { key: 'providers', label: '接入模型', icon: 'spark', title: '接入模型', desc: 'OpenAI 兼容 / Anthropic / Gemini 接入项', Comp: ProvidersSection },
  { key: 'workspaces', label: '工作区', icon: 'folder', title: '工作区', desc: '关联本地目录，文件与记忆都以它为单位', Comp: WorkspacesSection },
  { key: 'memory', label: '记忆', icon: 'brain', title: '记忆', desc: '全局 / 工作区 / 会话三层长期记忆', Comp: MemorySection },
  { key: 'personas', label: '人格', icon: 'persona', title: '人格', desc: '自定义系统提示词，可按会话切换', Comp: PersonasSection },
  { key: 'mcp', label: 'MCP 工具', icon: 'mcp', title: 'MCP 工具', desc: '连接外部 MCP 服务器并挑选工具', Comp: McpSection },
  { key: 'tasks', label: '定时任务', icon: 'clock', title: '定时任务', desc: '按时间或 cron 自动跑一段对话', Comp: TasksSection },
  { key: 'images', label: '图片生成', icon: 'image', title: '图片生成', desc: '接入出图后端，直接生成图片', Comp: ImagesSection },
  { key: 'usage', label: '用量', icon: 'chart', title: '用量统计', desc: 'Token 消耗与预估费用', Comp: UsageSection },
  { key: 'update', label: '软件更新', icon: 'download', title: '软件更新', desc: '检查 GitHub 上的最新版本', Comp: UpdateSection },
  { key: 'approval', label: '权限与审计', icon: 'shield', title: '权限与审计', desc: '两档权限、待确认请求与审计日志', Comp: ApprovalSection },
  { key: 'shortcuts', label: '快捷键', icon: 'keyboard', title: '快捷键', desc: '键盘操作一览', Comp: ShortcutsSection },
];

export function SettingsModal() {
  const section = useApp(s => s.settingsSection);
  const openSettings = useApp(s => s.openSettings);
  const close = useApp(s => s.closeSettings);
  const pendingApprovals = useApp(s => s.pendingApprovals);
  const mcpStates = useApp(s => s.mcpStates);
  const tasks = useApp(s => s.tasks);
  const t = useT();

  const active = useMemo(() => SECTIONS.find(s => s.key === section) ?? SECTIONS[0], [section]);

  const badgeOf = (key: string): number => {
    if (key === 'approval') return pendingApprovals.length;
    if (key === 'mcp') return mcpStates.filter(s => s.status === 'error').length;
    if (key === 'tasks') return tasks.filter(t => t.enabled).length;
    return 0;
  };

  const Current = active.Comp;

  return (
    <div className="overlay" onClick={close}>
      <div className="settings-shell" onClick={e => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="settings-nav-title">{t('设置')}</div>
          {SECTIONS.map(item => {
            const badge = badgeOf(item.key);
            return (
              <button
                key={item.key}
                type="button"
                className="settings-nav-item"
                data-active={item.key === section}
                onClick={() => openSettings(item.key)}
              >
                <Icon name={item.icon} size={15} />
                <span>{t(item.label)}</span>
                {badge > 0 && (
                  <span className="badge" data-tone={item.key === 'approval' ? 'warn' : 'danger'} style={{ marginLeft: 'auto' }}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="settings-content">
          <div className="settings-head">
            <span className="settings-title">{t(active.title)}</span>
            <span className="dim" style={{ fontSize: 11.5 }}>
              {t(active.desc)}
            </span>
            <div className="grow" />
            <button type="button" className="icon-btn" title="关闭 (Esc)" aria-label={t('关闭')} onClick={close}>
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="settings-body">
            <Current />
          </div>
        </div>
      </div>
    </div>
  );
}
