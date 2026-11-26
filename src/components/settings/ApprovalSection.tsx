/* ============================================================================
 * src/components/settings/ApprovalSection.tsx —— 权限与审计
 *   策略 + 待审批 + 操作记录
 * ==========================================================================*/

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { relativeTime } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { localizeApprovalDetail } from '@/lib/approval';
import { Card, Empty, Group, Row, Switch } from './ui';
import type { AuditEntry } from '@shared/types';

const KIND_LABEL: Record<AuditEntry['kind'], string> = {
  'fs-write': '写入文件',
  'fs-delete': '删除文件',
  command: '执行命令',
  dependency: '安装依赖',
  network: '网络请求',
  mcp: '外部工具',
};

const DECISION_LABEL: Record<AuditEntry['decision'], string> = {
  approved: '已同意',
  denied: '已拒绝',
  auto: '自动放行',
};

const RISK_LABEL = { high: '高风险', medium: '中风险', low: '低风险' } as const;

export function ApprovalSection() {
  const t = useT();
  const settings = useApp(s => s.settings);
  const saveSettings = useApp(s => s.saveSettings);
  const pending = useApp(s => s.pendingApprovals);
  const approve = useApp(s => s.approve);
  const locale = useApp(s => s.settings?.locale);

  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setAudit(await invoke('audit:list', { limit: 200 }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!settings) return null;
  const full = settings.permission === 'full';

  return (
    <>
      <Group
        title={t('确认策略')}
        desc={
          full
            ? t('当前是「完全放行」：读写文件、执行命令都不会再问你。审计记录仍然会写。')
            : t('当前是「按需确认」：涉及磁盘写入、删除、执行命令、外部工具调用时会先弹确认卡。')
        }
      >
        <Row
          label={t('完全放行')}
          hint={t('只在你完全信任当前工作区时打开。打开后 Agent 的任何动作都不会再征询。')}
        >
          <Switch on={full} onChange={on => void saveSettings({ permission: on ? 'full' : 'approval' })} />
        </Row>
        <Row
          label={t('风险提示')}
          hint={t('低风险是工作区内的读操作，高风险是删除、越界路径与命令执行。')}
        >
          <div className="row gap-6">
            <span className="badge" data-tone="ok">
              {t('低')}
            </span>
            <span className="badge" data-tone="warn">
              {t('中')}
            </span>
            <span className="badge" data-tone="danger">
              {t('高')}
            </span>
          </div>
        </Row>
      </Group>

      <Group
        title={`${t('待确认')} · ${pending.length}`}
        desc={t('这些是 Agent 正在等待你回答的动作。')}
      >
        {pending.length === 0 ? (
          <Card title={t('没有待确认的动作')}>
            <Empty icon="shield" title={t('一切正常')} />
          </Card>
        ) : (
          pending.map(req => (
            <Card
              key={req.id}
              title={
                <span className="row gap-6">
                  {t(KIND_LABEL[req.kind])}
                  <span
                    className="badge"
                    data-tone={req.risk === 'high' ? 'danger' : req.risk === 'medium' ? 'warn' : 'ok'}
                  >
                    {t(RISK_LABEL[req.risk])}
                  </span>
                </span>
              }
              sub={relativeTime(req.createdAt)}
              actions={
                <>
                  <button type="button" className="btn" data-size="sm" onClick={() => void approve(req.id, true)}>
                    {t('同意')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-size="sm"
                    data-variant="danger"
                    onClick={() => void approve(req.id, false)}
                  >
                    {t('拒绝')}
                  </button>
                </>
              }
            >
              <div style={{ fontSize: 12.4, lineHeight: 1.7 }}>{localizeApprovalDetail(req.detail, t)}</div>
              <div className="mono dim" style={{ fontSize: 10.8, marginTop: 6, overflowWrap: 'anywhere' }}>
                {req.target}
              </div>
            </Card>
          ))
        )}
      </Group>

      <Group
        title={`${t('操作记录')} · ${audit.length}`}
        desc={t('每次确认或拒绝都会留一条，只存在本机。')}
      >
        <div className="row gap-8" style={{ marginBottom: 8 }}>
          <div className="grow" />
          <button type="button" className="btn" data-size="sm" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={12} />
            {t('刷新')}
          </button>
        </div>

        {audit.length === 0 ? (
          <div className="dim" style={{ fontSize: 12 }}>
            {t('还没有记录。')}
          </div>
        ) : (
          audit.map(entry => (
            <div key={entry.id} className="list-item">
              <div className="list-item-main">
                <div className="list-item-text">
                  <span className="dim">{t(KIND_LABEL[entry.kind])}</span> · {localizeApprovalDetail(entry.detail || entry.target, t)}
                </div>
                <div className="list-item-meta">
                  <span
                    className="badge"
                    data-tone={entry.decision === 'approved' ? 'ok' : entry.decision === 'denied' ? 'danger' : undefined}
                  >
                    {t(DECISION_LABEL[entry.decision])}
                  </span>
                  <span className="dim">{new Date(entry.at).toLocaleString(locale ?? 'zh-CN')}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </Group>
    </>
  );
}
