'use client';

// ============================================================================
// BackgroundLayer — CSS-фон под Canvas (solid / gradient / radial / transparent).
// ============================================================================

import type { AvatarConfig } from '@/lib/avatar-config';

export function BackgroundLayer({ config }: { config: AvatarConfig }) {
  const { style, color, edgeColor } = config.background;
  if (style === 'transparent') return null;

  let bg: React.CSSProperties;
  if (style === 'solid') {
    bg = { background: color };
  } else if (style === 'gradient') {
    bg = { background: `linear-gradient(135deg, ${color} 0%, ${edgeColor} 100%)` };
  } else {
    bg = { background: `radial-gradient(circle at 50% 40%, ${color} 0%, ${edgeColor} 100%)` };
  }

  return (
    <div
      className="absolute inset-0 rounded-lg pointer-events-none"
      style={bg}
    />
  );
}
