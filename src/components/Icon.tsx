/* ============================================================================
 * src/components/Icon.tsx —— 线性图标（stroke 复用 currentColor）
 * 统一 24 视窗、1.6 描边，避免各处的矢量风格不一致。
 * ==========================================================================*/

import type { CSSProperties } from 'react';

export type IconName =
  | 'sidebar'
  | 'plus'
  | 'search'
  | 'dots'
  | 'arrow-up'
  | 'stop'
  | 'copy'
  | 'check'
  | 'retry'
  | 'edit'
  | 'trash'
  | 'pin'
  | 'pin-off'
  | 'download'
  | 'paperclip'
  | 'image'
  | 'mic'
  | 'x'
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-right'
  | 'spark'
  | 'folder'
  | 'file'
  | 'globe'
  | 'settings'
  | 'brain'
  | 'tool'
  | 'shield'
  | 'clock'
  | 'chart'
  | 'persona'
  | 'mcp'
  | 'wrench'
  | 'panel-right'
  | 'panel-right-off'
  | 'alert'
  | 'external'
  | 'refresh'
  | 'keyboard'
  | 'sun'
  | 'moon'
  | 'thumbs-up'
  | 'thumbs-down'
  | 'collapse'
  | 'expand';

const PATHS: Record<IconName, string> = {
  sidebar: 'M4 5.5h16M4 12h11M4 18.5h16',
  plus: 'M12 5v14M5 12h14',
  search: 'M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13ZM15.5 15.5 20 20',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  stop: 'M12 6.5v11',
  copy: 'M9 9V6.5A1.5 1.5 0 0 1 10.5 5h7A1.5 1.5 0 0 1 19 6.5v7a1.5 1.5 0 0 1-1.5 1.5H15M6.5 9h7A1.5 1.5 0 0 1 15 10.5v7A1.5 1.5 0 0 1 13.5 19h-7A1.5 1.5 0 0 1 5 17.5v-7A1.5 1.5 0 0 1 6.5 9Z',
  check: 'M5 12.5 9.5 17 19 7',
  retry: 'M19 12a7 7 0 1 1-2.6-5.4M19 4.5V10h-5.5',
  edit: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3ZM14.5 6.5l3 3',
  trash: 'M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M7 7l.8 11.6A1.5 1.5 0 0 0 9.3 20h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7',
  pin: 'M12 3.5 14.6 9l5.9.7-4.3 4.1 1.1 5.8-5.3-2.9-5.3 2.9 1.1-5.8L3.5 9.7 9.4 9 12 3.5Z',
  'pin-off': 'M12 3.5 14.6 9l5.9.7-4.3 4.1M3 3l18 18',
  download: 'M12 4v10M7.5 10 12 14.5 16.5 10M5 19h14',
  paperclip: 'M15.5 8 9 14.5a2.5 2.5 0 0 0 3.5 3.5l7-7a4.5 4.5 0 0 0-6.4-6.4L5.3 12.4a6 6 0 0 0 8.5 8.5',
  image: 'M4.5 5.5h15v13h-15zM4.5 15l4.2-4.2 3.3 3.3 3-3 4.5 4.5M9 9.5h.01',
  mic: 'M12 4.5a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0V7A2.5 2.5 0 0 1 12 4.5ZM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20M9.5 20h5',
  x: 'M6 6l12 12M18 6 6 18',
  'chevron-down': 'M6 9.5 12 15l6-5.5',
  'chevron-up': 'M6 14.5 12 9l6 5.5',
  'chevron-right': 'M9.5 6 15 12l-5.5 6',
  spark: 'M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 18l-1.7-5.6L5 10.7 10.3 9 12 3.5Z',
  folder: 'M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.8 2.2h8A1.5 1.5 0 0 1 20 9.7v7.8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-10Z',
  file: 'M14 4.5H7.5A1.5 1.5 0 0 0 6 6v12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 18V8.5L14 4.5ZM14 4.5V8.5h4',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.2 2.3 3.3 5.3 3.3 8.5S14.2 19.2 12 20.5c-2.2-1.3-3.3-5.3-3.3-8.5S9.8 5.8 12 3.5Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12c0-.5-.05-1-.14-1.45l1.7-1.3-1.6-2.75-1.98.78a7.1 7.1 0 0 0-2.5-1.45L14 3.5h-4l-.48 2.33A7.1 7.1 0 0 0 7.02 7.3L5.04 6.5l-1.6 2.75 1.7 1.3A7.5 7.5 0 0 0 5 12c0 .5.05 1 .14 1.45l-1.7 1.3 1.6 2.75 1.98-.78a7.1 7.1 0 0 0 2.5 1.45L10 20.5h4l.48-2.33a7.1 7.1 0 0 0 2.5-1.45l1.98.78 1.6-2.75-1.7-1.3c.09-.45.14-.95.14-1.45Z',
  brain: 'M9.5 4.5A3 3 0 0 0 7 7.4 3 3 0 0 0 5 10.2a3 3 0 0 0 1.2 2.4A3 3 0 0 0 7.5 18a3 3 0 0 0 2 1.5V4.5ZM14.5 4.5a3 3 0 0 1 2.5 2.9 3 3 0 0 1 2 2.8 3 3 0 0 1-1.2 2.4A3 3 0 0 1 16.5 18a3 3 0 0 1-2 1.5V4.5Z',
  tool: 'M14.5 4.5a4.5 4.5 0 0 1 5.4 6.8l-8.6 8.6a2.6 2.6 0 0 1-3.7-3.7l8.6-8.6a4.5 4.5 0 0 1-1.7-3.1ZM4.5 4.5l3 3',
  shield: 'M12 3.5 5 6v6c0 4 3 7 7 8.5 4-1.5 7-4.5 7-8.5V6l-7-2.5ZM9.5 12l1.8 1.8L15 10',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7.5V12l3 2',
  chart: 'M4.5 19.5h15M7.5 16V9M12 16V5.5M16.5 16v-4.5',
  persona: 'M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5',
  mcp: 'M4.5 9.5 9 5l5.5 5.5-4.5 4.5L4.5 9.5ZM12 17l3.5-3.5 4 4-3.5 3.5L12 17Z',
  wrench: 'M14 5.5a4 4 0 0 0 5.2 5.2L10 20a2.5 2.5 0 0 1-3.5-3.5L15.7 7.3A4 4 0 0 0 14 5.5Z',
  'panel-right': 'M4.5 5.5h15v13h-15zM14.5 5.5v13',
  'panel-right-off': 'M4.5 5.5h15v13h-15zM14.5 5.5v13M14.5 12h5',
  alert: 'M12 4.5 3.5 19.5h17L12 4.5ZM12 10v4M12 16.5h.01',
  external: 'M14 4.5h5.5V10M19.5 4.5 11 13M17.5 14v4.5A1.5 1.5 0 0 1 16 20H5.5A1.5 1.5 0 0 1 4 18.5V8a1.5 1.5 0 0 1 1.5-1.5H10',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
  keyboard: 'M3.5 7.5h17v9h-17zM7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17 10.5h.01M8 13.5h8',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z',
  'thumbs-up': 'M8 10.5 11 4.5c1.4 0 2.2.9 2 2.3l-.5 2.7h4.6c1.2 0 2 1 1.8 2.2l-1 5.6A2 2 0 0 1 15.9 19H8M8 10.5V19M8 10.5H5A1 1 0 0 0 4 11.5v6a1 1 0 0 0 1 1h3',
  'thumbs-down': 'M8 13.5 11 19.5c1.4 0 2.2-.9 2-2.3l-.5-2.7h4.6c1.2 0 2-1 1.8-2.2l-1-5.6A2 2 0 0 0 15.9 5H8M8 13.5V5M8 13.5H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h3',
  collapse: 'M9 5v4H5M15 19v-4h4M5 9l5-4M19 15l-5 4',
  expand: 'M9 9H5V5M15 15h4v4M5 9l4-4M19 15l-4 4',
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}

export function Icon({ name, size = 17, className, style, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
