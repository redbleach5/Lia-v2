import 'server-only';

// Emotional Memory — эмоциональные якоря Лии.
//
// Лия помнит не только ЧТО было, но и КАК пользователь себя чувствовал.
// Это позволяет ей:
//   - "В прошлый раз, когда мы обсуждали X, ты был раздражён. Сейчас ты
//      выглядишь спокойнее — могу я вернуться к той теме?"
//   - Замечать паттерны: "Я заметила, что ты каждый раз напрягаешься,
//      когда заходит речь о [тема]"
//   - Адаптировать тон: если в похожей ситуации пользователь ранее был
//      недоволен — Lia будет аккуратнее.
//
// Decay: intensity экспоненциально затухает с halfTime 180 дней.
// Анти-паттерн (от Qwen): не бередить раны — если прошлый эпизод был
// экстремально интенсивным, а текущий тон нейтральный — не упоминать прямо.

import { db } from '@/lib/db';
import { embed } from '@/lib/ollama';
import {
  insertEmotionalVectorIndex,
  searchEmotionalVectorsInEpisode,
} from '@/lib/db-vec';
import type { EmotionVector } from '@/lib/personality';
import { logger } from '@/lib/logger';

// ============================================================================
// Types
// ============================================================================
export type EmotionType =
  | 'frustration'
  | 'joy'
  | 'sadness'
  | 'anger'
  | 'anxiety'
  | 'enthusiasm'
  | 'curiosity'
  | 'warmth'
  | 'boredom'
  | 'other';

export type EmotionalAnchor = {
  id: string;
  episodeId: string;
  emotion: EmotionType;
  intensity: number;        // 0..1, после decay
  originalIntensity: number; // 0..1, как было записано
  trigger: string;
  context: string;
  emotionVector?: EmotionVector;
  ts: Date;
  ageDays: number;
};

// ============================================================================
// Decay — exponential with halfTime 180 days
// ============================================================================
const DECAY_HALF_TIME_DAYS = 180;

function decayIntensity(originalIntensity: number, ageDays: number): number {
  // intensity *= 0.5 ^ (ageDays / halfTime)
  const factor = Math.pow(0.5, ageDays / DECAY_HALF_TIME_DAYS);
  return originalIntensity * factor;
}

// ============================================================================
// Detect emotion type from rule-based perceive result
// ============================================================================
export function detectEmotionType(emotion: EmotionVector, triggers: string[]): EmotionType {
  // Если был trigger rudeness → anger
  if (triggers.includes('rudeness')) return 'anger';
  // Если была грустная тема → sadness
  if (triggers.includes('sadTopic')) return 'sadness';
  // Если энтузиазм → enthusiasm
  if (triggers.includes('enthusiasm')) return 'enthusiasm';
  // Если тепло → warmth
  if (triggers.includes('warmth')) return 'warmth';
  // Если любопытство → curiosity
  if (triggers.includes('curiosity') || triggers.includes('deepQuestion')) return 'curiosity';
  // Если несогласие → frustration (лёгкое)
  if (triggers.includes('disagreement')) return 'frustration';

  // По emotion vector: если irritation высокая → frustration/anger
  if (emotion.irritation > 0.5) return emotion.irritation > 0.7 ? 'anger' : 'frustration';
  if (emotion.sadness > 0.5) return 'sadness';
  if (emotion.joy > 0.7) return 'joy';
  if (emotion.curiosity > 0.7) return 'curiosity';
  if (emotion.calm < 0.3) return 'anxiety';

  return 'other';
}

// ============================================================================
// Record — сохранить эмоциональный якорь
// ============================================================================
/**
 * Записывает эмоциональный якорь в БД + векторный индекс.
 *
 * Используется после того, как Lia ответила — мы знаем:
 *   - что пользователь сказал (context)
 *   - какую эмоцию это вызвало (emotionType, intensity)
 *   - что было триггером (trigger — короткое описание)
 *
 * Embedding считается для context — для последующего семантического поиска.
 */
export async function recordEmotionalAnchor(params: {
  episodeId: string;
  emotion: EmotionType;
  intensity: number;
  trigger: string;
  context: string;
  emotionVector?: EmotionVector;
}): Promise<void> {
  const { episodeId, emotion, intensity, trigger, context, emotionVector } = params;

  // Clamp intensity
  const clampedIntensity = Math.max(0, Math.min(1, intensity));

  // Skip if intensity too low — not worth remembering
  if (clampedIntensity < 0.2) return;

  try {
    // Compute embedding for context (for later semantic search)
    let embedding: Float32Array | null = null;
    try {
      embedding = await embed(context.slice(0, 500));
    } catch (e) {
      logger.warn('memory', 'embed failed, storing without vector', {}, e);
    }

    // Store in Prisma
    // NOTE: Prisma's `Bytes` type is `ReturnType<Uint8Array['slice']>` = `Uint8Array<ArrayBuffer>`.
    // `Buffer.from(float32.buffer, offset, length)` produces `Buffer<ArrayBufferLike>`
    // (where ArrayBufferLike may be SharedArrayBuffer), which TS rejects.
    // Solution: allocate a fresh `ArrayBuffer` and copy bytes into a `Uint8Array` view on it.
    // This produces a strict `Uint8Array<ArrayBuffer>` that satisfies Prisma's `Bytes` type.
    let embeddingBytes: Uint8Array<ArrayBuffer> | null = null;
    if (embedding) {
      const ab = new ArrayBuffer(embedding.byteLength);
      const view = new Uint8Array(ab);
      view.set(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
      embeddingBytes = view;
    }

    const record = await db.emotionalMemory.create({
      data: {
        episodeId,
        emotion,
        intensity: clampedIntensity,
        trigger: trigger.slice(0, 200),
        context: context.slice(0, 1000),
        emotionVectorJson: emotionVector ? JSON.stringify(emotionVector) : null,
        embedding: embeddingBytes,
      },
    });

    // Also add to vec_virtual index for semantic search.
    // Использует обёртку insertEmotionalVectorIndex из db-vec.ts —
    // инкапсулирует vec0 virtual table (раньше был прямой vecDb доступ).
    if (embedding) {
      try {
        const vecId = `emo:${record.id}`;
        insertEmotionalVectorIndex({
          vectorId: vecId,
          episodeId,
          embedding,
        });
      } catch (e) {
        // Non-fatal — emotional anchor is stored in Prisma, just not searchable via vec
        logger.warn('memory', 'vec index insert failed (non-fatal)', {}, e);
      }
    }
  } catch (e) {
    logger.warn('memory', 'record failed (non-fatal)', {}, e);
  }
}

// ============================================================================
// Recall — найти эмоционально похожие ситуации
// ============================================================================
export type EmotionalRecallResult = {
  anchors: EmotionalAnchor[];
  warning: string | null; // anti-pattern warning
};

/**
 * Ищет эмоциональные якоря, релевантные текущему сообщению.
 *
 * Алгоритм:
 *   1. Векторный поиск по context пользователя
 *   2. Применяем decay (старые якоря слабее)
 *   3. Анти-паттерн: если найденный якорь экстремально интенсивный
 *      (>= 0.8 после decay) И текущий тон нейтральный — добавляем warning
 *
 * Возвращает якоря отсортированные по decayed intensity + опциональный warning.
 */
export async function recallEmotionalAnchors(params: {
  episodeId: string;
  queryText: string;
  currentEmotion: EmotionVector;
  limit?: number;
  minDecayedIntensity?: number;
}): Promise<EmotionalRecallResult> {
  const { episodeId, queryText, currentEmotion, limit = 3, minDecayedIntensity = 0.15 } = params;

  try {
    // Get query embedding
    const queryEmbedding = await embed(queryText.slice(0, 500));

    // Search vec_virtual through wrapper (инкапсуляция vec0 virtual table).
    const rows = searchEmotionalVectorsInEpisode({
      episodeId,
      queryEmbedding,
      limit: limit * 2,
      maxDistance: 0.9,
    });

    if (rows.length === 0) {
      return { anchors: [], warning: null };
    }

    // Strip "emo:" prefix
    const anchorIds = rows.map(r => r.vectorId.replace(/^emo:/, ''));

    // Fetch from Prisma.
    // Defence-in-depth: also filter by episodeId — even though vec_rowid_map
    // already filtered by episode_id, this prevents any theoretical leak
    // if vec_virtual/vec_rowid_map ever return ids from wrong episode.
    const records = await db.emotionalMemory.findMany({
      where: { id: { in: anchorIds }, episodeId },
    });

    // Build EmotionalAnchor array with decay
    const now = Date.now();
    const anchors: EmotionalAnchor[] = records.map(rec => {
      const ageDays = (now - rec.ts.getTime()) / (1000 * 60 * 60 * 24);
      const decayedIntensity = decayIntensity(rec.intensity, ageDays);
      return {
        id: rec.id,
        episodeId: rec.episodeId,
        emotion: rec.emotion as EmotionType,
        intensity: decayedIntensity,
        originalIntensity: rec.intensity,
        trigger: rec.trigger,
        context: rec.context,
        emotionVector: rec.emotionVectorJson ? safeParseEmotion(rec.emotionVectorJson) : undefined,
        ts: rec.ts,
        ageDays,
      };
    });

    // Filter by minDecayedIntensity
    const filtered = anchors.filter(a => a.intensity >= minDecayedIntensity);

    // Sort by decayed intensity (highest first)
    filtered.sort((a, b) => b.intensity - a.intensity);

    // Take top N
    const top = filtered.slice(0, limit);

    // ── Анти-паттерн: "не бередить раны" ──
    // Если самый интенсивный якорь >= 0.8 (после decay) И текущий тон нейтральный
    // → warning для промпта: "не упоминай прямо, будь мягче"
    let warning: string | null = null;
    if (top.length > 0) {
      const strongest = top[0];
      const isExtreme = strongest.originalIntensity >= 0.8;
      const isCurrentNeutral = currentEmotion.irritation < 0.3 && currentEmotion.sadness < 0.3 && currentEmotion.joy < 0.6;
      if (isExtreme && isCurrentNeutral) {
        warning = `Найден болезненный прошлый эпизод (эмоция: ${strongest.emotion}, интенсивность: ${strongest.originalIntensity.toFixed(2)}). Пользователь сейчас спокоен — не упоминай этот эпизод прямо. Будь мягче и эмпатичнее в тоне, но не тыкай носом в прошлое.`;
      }
    }

    return { anchors: top, warning };
  } catch (e) {
    logger.warn('memory', 'recall failed (non-fatal)', {}, e);
    return { anchors: [], warning: null };
  }
}

// ============================================================================
// Format for prompt
// ============================================================================
export function formatEmotionalAnchorsForPrompt(anchors: EmotionalAnchor[]): string {
  if (anchors.length === 0) return '';

  const lines = anchors.map(a => {
    const ageLabel = a.ageDays < 1 ? 'сегодня'
      : a.ageDays < 7 ? `${Math.floor(a.ageDays)} дн. назад`
      : a.ageDays < 30 ? `${Math.floor(a.ageDays / 7)} нед. назад`
      : `${Math.floor(a.ageDays / 30)} мес. назад`;

    return `- [${ageLabel}, эмоция: ${a.emotion}, интенсивность: ${a.intensity.toFixed(2)}] ${a.trigger}\n  Контекст: "${a.context.slice(0, 200)}"`;
  });

  return lines.join('\n');
}

// ============================================================================
// Stats
// ============================================================================
export async function getEmotionalMemoryStats(episodeId?: string) {
  if (episodeId) {
    const count = await db.emotionalMemory.count({ where: { episodeId } });
    return { count };
  }
  const total = await db.emotionalMemory.count();
  const byEmotion = await db.emotionalMemory.groupBy({
    by: ['emotion'],
    _count: true,
  });
  return {
    total,
    byEmotion: Object.fromEntries(byEmotion.map(e => [e.emotion, e._count])),
  };
}

// ============================================================================
// Helpers
// ============================================================================
function safeParseEmotion(json: string): EmotionVector | undefined {
  try {
    const obj = JSON.parse(json);
    if (typeof obj !== 'object' || obj === null) return undefined;
    return {
      joy: typeof obj.joy === 'number' ? obj.joy : 0.5,
      curiosity: typeof obj.curiosity === 'number' ? obj.curiosity : 0.5,
      calm: typeof obj.calm === 'number' ? obj.calm : 0.7,
      irritation: typeof obj.irritation === 'number' ? obj.irritation : 0.1,
      sadness: typeof obj.sadness === 'number' ? obj.sadness : 0.15,
    };
  } catch {
    return undefined;
  }
}
