/* ============================================================================
 * src/components/ToastStack.tsx —— 轻提示堆栈
 * ==========================================================================*/

import { Icon, type IconName } from '@/components/Icon';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';

const TONE_ICON: Record<string, IconName> = {
  info: 'spark',
  ok: 'check',
  warn: 'alert',
  error: 'alert',
};

export function ToastStack() {
  const tr = useT();
  const toasts = useApp(s => s.toasts);
  const dismiss = useApp(s => s.dismissToast);

  if (!toasts.length) return null;

  return (
    <div className="toast-stack">
      {toasts.map(item => (
        <div key={item.id} className="toast" data-tone={item.tone} role="status">
          <span className="toast-icon">
            <Icon name={TONE_ICON[item.tone] ?? 'spark'} size={14} />
          </span>
          <span>{item.text}</span>
          <button type="button" className="icon-btn" aria-label={tr('关闭')} onClick={() => dismiss(item.id)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
