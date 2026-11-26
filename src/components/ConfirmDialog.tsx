/* ============================================================================
 * src/components/ConfirmDialog.tsx —— 通用确认框
 *   用 store 里的轻量 pendingConfirm 通道有点重，这里用受控组件即可。
 * ==========================================================================*/

import { useEffect, useRef } from 'react';
import { useT } from '@/lib/i18n';

interface ConfirmDialogProps {
  /** 省略时视为始终打开（用条件渲染挂载的场景） */
  open?: boolean;
  title: string;
  children?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open = true,
  title,
  children,
  confirmText,
  cancelText,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  const okRef = useRef<HTMLButtonElement>(null);
  const okLabel = confirmText ?? t('确定');
  const cancelLabel = cancelText ?? t('取消');

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => okRef.current?.focus(), 30);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" style={{ width: 'min(92vw,440px)' }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">{title}</h3>
        </div>
        {children && <div className="modal-body">{children}</div>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={okRef}
            type="button"
            className="btn"
            data-variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
