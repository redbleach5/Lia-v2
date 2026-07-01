import 'server-only';

// ============================================================================
// safeParseEmotion — безопасный парсинг emotion JSON из БД.
// ============================================================================
//
// Дубликат логики из lib/memory/emotional-memory.ts.
// В Phase 5 (RL finalization) можно вынести в общий lib/emotion-utils.ts,
// пока оставлено здесь чтобы не создавать circular dependency.

import type { EmotionVector } from '@/lib/personality';

export function safeParseEmotion(json: string): EmotionVector | null {
  try {
    const obj = JSON.parse(json);
    if (typeof obj !== 'object' || obj === null) return null;
    const e = obj as Record<string, unknown>;
    return {
      joy: typeof e.joy === 'number' ? e.joy : 0.5,
      curiosity: typeof e.curiosity === 'number' ? e.curiosity : 0.5,
      calm: typeof e.calm === 'number' ? e.calm : 0.7,
      irritation: typeof e.irritation === 'number' ? e.irritation : 0.1,
      sadness: typeof e.sadness === 'number' ? e.sadness : 0.15,
    };
  } catch {
    return null;
  }
}
