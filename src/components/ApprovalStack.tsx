/* ============================================================================
 * src/components/ApprovalStack.tsx —— 审批卡片栈
 * 显示在输入框上方、随消息列同宽；每张卡片可同意/拒绝/本次会话内永久同意。
 * ==========================================================================*/

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { localizeApprovalDetail } from '@/lib/approval';
import type { ApprovalRequest } from '@shared/types';

const KIND_LABEL: Record<ApprovalRequest['kind'], string> = {
  'fs-write': '写入文件',
  'fs-delete': '删除文件',
  command: '执行命令',
  dependency: '安装依赖',
  network: '网络请求',
  mcp: '外部工具',
};

export function ApprovalStack() {
  const pending = useApp(s => s.pendingApprovals);
  const approve = useApp(s => s.approve);

  if (!pending.length) return null;

  return (
    <div className="approval-stack">
      {pending.map(req => (
        <ApprovalCard key={req.id} request={req} onDecide={approve} />
      ))}
    </div>
  );
}

function ApprovalCard({
  request,
  onDecide,
}: {
  request: ApprovalRequest;
  onDecide: (id: string, approved: boolean, remember?: boolean) => Promise<void>;
}) {
  const t = useT();
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      await onDecide(request.id, approved, approved && remember);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval-card">
      <div className="approval-head">
        <Icon name="shield" size={14} />
        <span>
          {t('需要你确认')} · {t(KIND_LABEL[request.kind])}
        </span>
        <div className="grow" />
        <span className="badge" data-tone={request.risk === 'high' ? 'danger' : request.risk === 'medium' ? 'warn' : 'ok'}>
          {request.risk === 'high' ? t('高风险') : request.risk === 'medium' ? t('中风险') : t('低风险')}
        </span>
      </div>
      <div className="approval-body">
        <div className="approval-detail">{localizeApprovalDetail(request.detail, t)}</div>
        <div className="approval-target">{request.target}</div>
        <div className="approval-actions">
          <button type="button" className="btn" data-variant="primary" data-size="sm" disabled={busy} onClick={() => void decide(true)}>
            {t('同意')}
          </button>
          <button type="button" className="btn" data-size="sm" disabled={busy} onClick={() => void decide(false)}>
            {t('拒绝')}
          </button>
          <label className="approval-remember">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            {t('本次会话内同类操作不再询问')}
          </label>
        </div>
      </div>
    </div>
  );
}
