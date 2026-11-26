/* ============================================================================
 * src/components/ConfirmHost.tsx —— 应用内确认框宿主
 *   替代 window.confirm：原生 confirm 会挂起渲染进程，
 *   在 Electron 里既卡住动画也卡住 CDP 求值，所以统一走 store 的 confirm 通道。
 * ==========================================================================*/

import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { ConfirmDialog } from '@/components/ConfirmDialog';

export function ConfirmHost() {
  const request = useApp(s => s.confirm);
  const settle = useApp(s => s.settleConfirm);
  const t = useT();

  if (!request) return null;

  return (
    <ConfirmDialog
      title={request.title}
      confirmText={request.confirmText ?? t('确定')}
      cancelText={request.cancelText ?? t('取消')}
      danger={request.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      {request.body ? <p className="confirm-text">{request.body}</p> : null}
    </ConfirmDialog>
  );
}
