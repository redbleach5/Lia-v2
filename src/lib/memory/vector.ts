// Vector memory — semantic search WITHIN a single episode.
//
// Это КЛЮЧЕВАЯ фиксация бага LIA v1: утечки фактов между чатами.
// Vector search всегда фильтрует по episodeId на уровне SQL —
// вектор из чата #1 НИКОГДА не появится в контексте чата #5.

import { embed } from '@/lib/ollama';
import { insertVectorMemory, searchVectorsInEpisode, generateId } from '@/lib/db-vec';
import { db } from '@/lib/db';

/**
 * Сохранить фрагмент в векторную память текущего эпизода.
 */
export async function remember(params: {
  episodeId: string;
  sourceType: 'dialogue' | 'summary' | 'fact';
  text: string;
}): Promise<void> {
  try {
    const embedding = await embed(params.text);
    insertVectorMemory({
      id: generateId(),
      episodeId: params.episodeId,
      sourceType: params.sourceType,
      text: params.text,
      embedding,
    });
  } catch (e) {
    console.warn('[memory:vector] remember failed (non-fatal):', e);
  }
}

/**
 * Семантический поиск в пределах эпизода.
 * Возвращает top-N совпадений с similarity >= minSimilarity.
 *
 * ВАЖНО: episodeId — обязательный параметр. Без него поиск не выполняется.
 */
export async function recall(params: {
  episodeId: string;
  query: string;
  limit?: number;
  minSimilarity?: number;
}): Promise<Array<{ sourceType: string; text: string; similarity: number }>> {
  try {
    const queryEmbedding = await embed(params.query);
    const hits = searchVectorsInEpisode({
      episodeId: params.episodeId,
      queryEmbedding,
      limit: params.limit ?? 5,
      minSimilarity: params.minSimilarity ?? 0.3,
    });
    return hits.map(h => ({
      sourceType: h.sourceType,
      text: h.text,
      similarity: h.similarity,
    }));
  } catch (e) {
    console.warn('[memory:vector] recall failed (non-fatal):', e);
    return [];
  }
}

/**
 * Format vector hits for system prompt.
 */
export function formatVectorHitsForPrompt(hits: Array<{ sourceType: string; text: string; similarity: number }>): string {
  if (hits.length === 0) return '';
  return hits
    .map(h => `[${h.sourceType}, sim=${h.similarity.toFixed(2)}]\n${h.text.slice(0, 500)}`)
    .join('\n---\n');
}

/**
 * Stats for debug UI.
 */
export async function getVectorStats(episodeId?: string) {
  if (episodeId) {
    const count = await db.vectorMemory.count({ where: { episodeId } });
    return { episodeCount: count };
  }
  const total = await db.vectorMemory.count();
  return { total };
}
