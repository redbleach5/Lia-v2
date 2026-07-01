// ============================================================================
// VRM blendshape helpers — emotion→blendshapes mapping + safe setExpr.
// ============================================================================

import type { VRM, VRMExpressionPresetName } from '@pixiv/three-vrm';
import type { EmotionVector } from '@/lib/personality';

/**
 * Безопасно установить значение blendshape на VRM-модели.
 * Молча игнорирует ошибки — некоторые VRM-модели не имеют определённых blendshapes.
 */
export function setExpr(vrm: VRM, name: VRMExpressionPresetName | string, value: number): void {
  if (!vrm.expressionManager) return;
  try {
    const clamped = Math.max(0, Math.min(1, value));
    vrm.expressionManager.setValue(name as VRMExpressionPresetName, clamped);
  } catch {
    // Некоторые VRM-модели могут не иметь определённых blendshapes.
    // Молча игнорируем — это не критично.
  }
}

/**
 * Маппинг 5-axis emotion → VRM blendshape preset names.
 *
 * VRM 0.x/1.0 expression presets:
 *   happy, angry, sad, relaxed, surprised, aa, ih, ou, ee, oh, blink, etc.
 *
 * Мы используем: happy (joy), angry (irritation), sad (sadness),
 * relaxed (calm), surprised (always 0 — нет оси surprise), aa (mouth open for lip-sync).
 */
export function emotionToBlendshapes(e: EmotionVector): Record<string, number> {
  return {
    happy:     Math.max(0, e.joy - 0.4) * 1.0,
    angry:     Math.max(0, e.irritation - 0.35) * 1.2,
    sad:       Math.max(0, e.sadness - 0.3) * 1.1,
    relaxed:   Math.max(0, e.calm - 0.5) * 0.7,
    surprised: 0,
    aa: 0,
  };
}
