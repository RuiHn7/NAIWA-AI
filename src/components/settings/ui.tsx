/* ============================================================================
 * src/components/settings/ui.tsx —— 设置页共用小构件
 * ==========================================================================*/

import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/Icon';

export function Group({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="setting-group">
      <div className="setting-group-title">{title}</div>
      {desc && <div className="setting-group-desc">{desc}</div>}
      {children}
    </section>
  );
}

export function Row({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      <div className="setting-control">{children}</div>
      {hint && <div className="setting-hint">{hint}</div>}
    </div>
  );
}

export function Switch({ on, onChange, disabled }: { on: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={on}
      data-on={on ? 'true' : 'false'}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map(opt => (
        <button key={opt.value} type="button" data-active={opt.value === value} onClick={() => onChange(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, desc }: { icon: IconName; title: string; desc?: string }) {
  return (
    <div className="card-empty">
      <Icon name={icon} size={22} />
      <div style={{ marginTop: 8 }}>{title}</div>
      {desc && <div className="dim" style={{ fontSize: 11.5, marginTop: 4 }}>{desc}</div>}
    </div>
  );
}

export function Card({
  title,
  sub,
  actions,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title ellipsis">{title}</span>
        {sub && <span className="card-sub">{sub}</span>}
        <div className="grow" />
        {actions}
      </div>
      {children && <div className="card-body">{children}</div>}
    </div>
  );
}
