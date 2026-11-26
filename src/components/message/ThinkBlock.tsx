/* ============================================================================
 * src/components/message/ThinkBlock.tsx —— 思考过程折叠块
 * 默认收起，流式期间显示「思考中」与跳动点。
 * ==========================================================================*/

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useT } from '@/lib/i18n';

interface ThinkBlockProps {
  text: string;
  streaming: boolean;
}

export function ThinkBlock({ text, streaming }: ThinkBlockProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!text) return null;

  return (
    <div className="think" data-open={open}>
      <button type="button" className="think-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="think-caret">
          <Icon name="chevron-right" size={13} />
        </span>
        <span className="think-label">{streaming ? t('思考中') : t('思考过程')}</span>
        {streaming ? (
          <span className="think-dots">
            <span />
            <span />
            <span />
          </span>
        ) : (
          <span className="dim mono" style={{ fontSize: 10.5 }}>
            {text.length} {t('字')}
          </span>
        )}
        <div className="grow" />
        {!streaming && (
          <span className="dim" style={{ fontSize: 11 }}>
            {open ? t('收起') : t('展开')}
          </span>
        )}
      </button>
      {open && <div className="think-body">{text}</div>}
    </div>
  );
}
