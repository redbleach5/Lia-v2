// Facts — global profile + episode-scoped context.
//
// ГЛОБАЛЬНЫЕ факты (GlobalFact) — переживают смену чата:
//   user.name, user.profession, user.favorite_language и т.п.
//
// ЭПИЗОДНЫЕ факты (EpisodeFact) — стираются при закрытии чата:
//   "текущий проект — Lia v2", "пользователь просит проанализировать X"

import { db } from '@/lib/db';

// ============================================================================
// Global facts — профиль пользователя
// ============================================================================
export async function getGlobalFact(key: string): Promise<string | null> {
  const row = await db.globalFact.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function getAllGlobalFacts(): Promise<Array<{ key: string; value: string; confidence: number }>> {
  const rows = await db.globalFact.findMany({
    orderBy: { key: 'asc' },
  });
  return rows.map(r => ({ key: r.key, value: r.value, confidence: r.confidence }));
}

export async function upsertGlobalFact(key: string, value: string, confidence = 0.7): Promise<void> {
  const existing = await db.globalFact.findUnique({ where: { key } });
  if (existing) {
    if (existing.value !== value) {
      await db.globalFact.update({
        where: { key },
        data: { value, confidence, updatedAt: new Date() },
      });
    } else {
      await db.globalFact.update({
        where: { key },
        data: {
          confidence: Math.min(0.95, existing.confidence + 0.1),
          updatedAt: new Date(),
        },
      });
    }
  } else {
    try {
      await db.globalFact.create({ data: { key, value, confidence } });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code !== 'P2002') throw e;
    }
  }
}

/**
 * Build a textual user profile from global facts (for system prompt).
 * Groups by prefix: user.* → "Собеседник", lia.* → "Я", прочее → "Прочее".
 */
export function formatGlobalFactsForPrompt(facts: Array<{ key: string; value: string }>): string {
  if (facts.length === 0) return '';

  const grouped: Record<string, string[]> = {};
  for (const f of facts) {
    const prefix = f.key.split('.')[0] ?? 'other';
    (grouped[prefix] ??= []).push(`${f.key}: ${f.value}`);
  }

  const lines: string[] = [];
  if (grouped.user) {
    lines.push('Собеседник:');
    for (const l of grouped.user) lines.push(`  ${l}`);
  }
  if (grouped.lia) {
    lines.push('Я (по прошлым чатам):');
    for (const l of grouped.lia) lines.push(`  ${l}`);
  }
  const otherKeys = Object.keys(grouped).filter(k => k !== 'user' && k !== 'lia');
  if (otherKeys.length > 0) {
    lines.push('Прочее:');
    for (const k of otherKeys) {
      for (const l of grouped[k]) lines.push(`  ${l}`);
    }
  }
  return lines.join('\n');
}

// ============================================================================
// Episode facts — контекст текущего чата
// ============================================================================
export async function getEpisodeFacts(episodeId: string): Promise<Array<{ key: string; value: string }>> {
  const rows = await db.episodeFact.findMany({
    where: { episodeId },
    orderBy: { ts: 'desc' },
    take: 30,
  });
  return rows.map(r => ({ key: r.key, value: r.value }));
}

export async function upsertEpisodeFact(episodeId: string, key: string, value: string): Promise<void> {
  try {
    await db.episodeFact.upsert({
      where: { episodeId_key: { episodeId, key } },
      create: { episodeId, key, value },
      update: { value, ts: new Date() },
    });
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== 'P2002') throw e;
  }
}

export function formatEpisodeFactsForPrompt(facts: Array<{ key: string; value: string }>): string {
  if (facts.length === 0) return '';
  return facts.map(f => `${f.key}: ${f.value}`).join('\n');
}
