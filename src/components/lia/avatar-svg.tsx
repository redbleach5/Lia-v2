'use client';

import type { EmotionVector } from '@/lib/personality';
import { EMOTION_AXES, EMOTION_LABELS_RU } from '@/lib/personality';

// ============================================================================
// EmotionBars — small visualization of the 5 emotion axes
// (joy / curiosity / calm / irritation / sadness)
// ============================================================================
// NOTE: Ранее в этом файле жил мёртвый AvatarSvg (SVG-аватар).
// Удалён в Phase 0 — фактические аватары это VRM (3D) и Live2D (PixiJS),
// а SVG-фоллбэк никогда не рендерился. Если понадобится простой SVG-аватар,
// он должен жить в отдельном файле `svg-avatar.tsx`.
// ============================================================================

export function EmotionBars({ emotion }: { emotion: EmotionVector }) {
  return (
    <div className="space-y-2">
      {EMOTION_AXES.map(axis => {
        const value = emotion[axis];
        const pct = Math.round(value * 100);
        return (
          <div key={axis} className="space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground capitalize">
                {EMOTION_LABELS_RU[axis]}
              </span>
              <span className="font-mono text-text-dim">
                {pct.toString().padStart(2, '0')}
              </span>
            </div>
            <div className="h-1 bg-surface-2 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-500 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
