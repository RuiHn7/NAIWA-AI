/* ============================================================================
 * src/components/Menu.tsx —— 轻量弹出菜单
 *   · 依据锚点矩形自动判断向上/向下展开，并夹取到视口内
 *   · 点击外部 / Esc / 滚动关闭
 * ==========================================================================*/

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/Icon';

export interface MenuAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function anchorOf(el: HTMLElement | null): MenuAnchor | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

interface MenuProps {
  anchor: MenuAnchor;
  onClose: () => void;
  children: ReactNode;
  minWidth?: number;
  align?: 'left' | 'right';
  gap?: number;
  /** 额外类名（二级菜单用 .menu-sub 标记自己，方便父菜单判断点击归属） */
  className?: string;
  /**
   * 点击「外部」时是否保持打开。
   * 二级菜单是独立 portal，物理上在父菜单之外，需要父菜单放行它的点击。
   */
  stayOpenWhen?: (target: Node) => boolean;
  /** 展开方向：默认在锚点下方；right 表示贴在锚点右侧（二级菜单用） */
  side?: 'bottom' | 'right';
}

export function Menu({
  anchor,
  onClose,
  children,
  minWidth = 186,
  align = 'left',
  gap = 6,
  className,
  stayOpenWhen,
  side = 'bottom',
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'up' | 'down'; maxWidth?: number }>({
    left: anchor.left,
    top: anchor.bottom + gap,
    placement: 'down',
  });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (side === 'right') {
      // 二级菜单：紧贴锚点右侧。右侧空间够放最小宽度就按剩余空间收窄塞进去（不翻边），
      // 实在放不下才翻到左侧。留 6px 窗口边距，别糊在屏幕边上。
      const room = vw - anchor.right - gap - 6;
      if (room >= minWidth) {
        setPos({
          left: anchor.right + gap,
          top: Math.max(8, Math.min(anchor.top, vh - rect.height - 8)),
          placement: 'down',
          maxWidth: Math.max(minWidth, Math.min(rect.width, room)),
        });
        return;
      }
      setPos({
        left: Math.max(8, Math.min(anchor.left - gap - rect.width, vw - rect.width - 8)),
        top: Math.max(8, Math.min(anchor.top, vh - rect.height - 8)),
        placement: 'down',
        maxWidth: rect.width,
      });
      return;
    }

    const wantUp = anchor.bottom + gap + rect.height > vh - 8 && anchor.top - gap - rect.height > 8;
    const top = wantUp ? anchor.top - gap - rect.height : anchor.bottom + gap;
    let left = align === 'right' ? anchor.right - rect.width : anchor.left;
    left = Math.max(8, Math.min(left, vw - rect.width - 8));

    setPos({ left, top: Math.max(8, Math.min(top, vh - rect.height - 8)), placement: wantUp ? 'up' : 'down' });
  }, [anchor, align, gap, side, minWidth]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current && !ref.current.contains(target)) {
        if (stayOpenWhen?.(target)) return;
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const onScroll = () => onClose();

    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('wheel', onScroll, { passive: true });
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('wheel', onScroll);
    };
  }, [onClose, stayOpenWhen]);

  return createPortal(
    <div
      ref={ref}
      className={className ? `menu ${className}` : 'menu'}
      role="menu"
      data-placement={pos.placement}
      style={{ left: pos.left, top: pos.top, minWidth, maxWidth: pos.maxWidth }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ 子项 */

interface MenuItemProps {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  hint?: string;
  tone?: 'danger';
  picked?: boolean;
  disabled?: boolean;
  /** 子菜单指示：鼠标移入时由父级打开二级菜单 */
  onHover?: (el: HTMLElement) => void;
  /** 该行是否正在展开二级菜单（只影响视觉） */
  expanded?: boolean;
  /** 右侧显示 › 而不是 hint */
  chevron?: boolean;
  /** 触发打开二级菜单的方式：默认悬停（PRD 要求悬停即开） */
  hoverOpen?: boolean;
}

export function MenuItem({
  icon,
  children,
  onClick,
  hint,
  tone,
  picked,
  disabled,
  onHover,
  expanded,
  chevron,
  hoverOpen = true,
}: MenuItemProps) {
  return (
    <button
      type="button"
      className="menu-item"
      role="menuitem"
      data-tone={tone}
      data-picked={picked ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={event => {
        if (onHover && hoverOpen) onHover(event.currentTarget);
      }}
      onFocus={event => {
        if (onHover && hoverOpen) onHover(event.currentTarget);
      }}
    >
      {icon}
      <span className="ellipsis">{children}</span>
      {picked ? <span className="menu-check">✓</span> : hint ? <span className="menu-hint">{hint}</span> : null}
      {chevron ? <Icon name="chevron-right" size={12} /> : null}
    </button>
  );
}

export function MenuSep() {
  return <div className="menu-sep" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>;
}

/* ------------------------------------------------------------------ Hook */

export function useMenu() {
  const [state, setState] = useState<{ anchor: MenuAnchor; align: 'left' | 'right' } | null>(null);

  const open = useCallback((el: HTMLElement | null, side: 'left' | 'right' = 'left') => {
    const anchor = anchorOf(el);
    if (anchor) setState({ anchor, align: side });
  }, []);

  const close = useCallback(() => setState(null), []);

  return { menu: state, open, close };
}
