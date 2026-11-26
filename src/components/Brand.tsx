/* ============================================================================
 * src/components/Brand.tsx —— 品牌标识（NAI WA / NW）
 * ==========================================================================*/

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      NW
    </span>
  );
}

export function AiAvatar({ size = 26 }: { size?: number }) {
  return (
    <span className="ai-avatar" style={{ width: size, height: size }} aria-hidden="true">
      NW
    </span>
  );
}
