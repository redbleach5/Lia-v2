// Episodes — CRUD for chat threads.
//
// Каждый эпизод = отдельный чат. Память привязана к эпизоду:
//   - EpisodeFact — контекстные факты (только этот чат)
//   - VectorMemory — векторная память (только этот чат)
//   - Message — сообщения (только этот чат)
//
// Глобально (переживает смену чата) только GlobalFact — профиль пользователя.

import { db } from '@/lib/db';
import { randomUUID } from 'crypto';

export type Episode = {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
  summary: string | null;
  messageCount: number;
};

export async function createEpisode(title?: string): Promise<Episode> {
  const ep = await db.episode.create({
    data: title ? { title } : {},
  });
  return {
    id: ep.id,
    title: ep.title,
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
    endedAt: ep.endedAt,
    summary: ep.summary,
    messageCount: 0,
  };
}

export async function listEpisodes(limit = 50): Promise<Episode[]> {
  const episodes = await db.episode.findMany({
    orderBy: { updatedAt: 'desc' },
    take: limit,
    include: {
      _count: { select: { messages: true } },
    },
  });
  return episodes.map(e => ({
    id: e.id,
    title: e.title,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    endedAt: e.endedAt,
    summary: e.summary,
    messageCount: e._count.messages,
  }));
}

export async function getEpisode(id: string): Promise<Episode | null> {
  const ep = await db.episode.findUnique({
    where: { id },
    include: { _count: { select: { messages: true } } },
  });
  if (!ep) return null;
  return {
    id: ep.id,
    title: ep.title,
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
    endedAt: ep.endedAt,
    summary: ep.summary,
    messageCount: ep._count.messages,
  };
}

export async function renameEpisode(id: string, title: string): Promise<void> {
  await db.episode.update({
    where: { id },
    data: { title: title.slice(0, 200) },
  });
}

export async function deleteEpisode(id: string): Promise<void> {
  try {
    await db.episode.delete({ where: { id } });
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === 'P2025') return; // already deleted
    throw e;
  }
}

export async function closeEpisode(id: string, summary?: string): Promise<void> {
  await db.episode.update({
    where: { id },
    data: {
      endedAt: new Date(),
      summary,
    },
  }).catch(() => null);
}

// ============================================================================
// Messages
// ============================================================================
export type ChatMessage = {
  id: string;
  episodeId: string;
  role: 'user' | 'companion' | 'tool' | 'system';
  content: string;
  emotionJson: string | null;
  toolCallsJson: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  createdAt: Date;
};

export async function saveMessage(episodeId: string, params: {
  role: 'user' | 'companion' | 'tool' | 'system';
  content: string;
  emotionJson?: string;
  toolCallsJson?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
}): Promise<ChatMessage> {
  const msg = await db.message.create({
    data: {
      episodeId,
      role: params.role,
      content: params.content,
      emotionJson: params.emotionJson,
      toolCallsJson: params.toolCallsJson,
      tokensIn: params.tokensIn,
      tokensOut: params.tokensOut,
      durationMs: params.durationMs,
    },
  });
  return {
    id: msg.id,
    episodeId: msg.episodeId,
    role: msg.role as ChatMessage['role'],
    content: msg.content,
    emotionJson: msg.emotionJson,
    toolCallsJson: msg.toolCallsJson,
    tokensIn: msg.tokensIn,
    tokensOut: msg.tokensOut,
    durationMs: msg.durationMs,
    createdAt: msg.createdAt,
  };
}

export async function getMessages(episodeId: string, limit = 50): Promise<ChatMessage[]> {
  const rows = await db.message.findMany({
    where: { episodeId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.reverse().map(r => ({
    id: r.id,
    episodeId: r.episodeId,
    role: r.role as ChatMessage['role'],
    content: r.content,
    emotionJson: r.emotionJson,
    toolCallsJson: r.toolCallsJson,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
  }));
}

/**
 * Auto-derive a title from the first user message.
 * Called after the first message in an untitled episode.
 */
export async function autoTitleEpisode(episodeId: string, firstUserMessage: string): Promise<string | null> {
  try {
    const ep = await db.episode.findUnique({ where: { id: episodeId }, select: { title: true } });
    if (!ep) return null;
    if (ep.title && ep.title.trim().length > 0) return ep.title;

    const cleaned = firstUserMessage
      .replace(/[*_`#>~[\]()]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;

    const MAX = 60;
    const title = cleaned.length <= MAX
      ? cleaned
      : (cleaned.slice(0, cleaned.lastIndexOf(' ', MAX)) || cleaned.slice(0, MAX)) + '…';

    await db.episode.update({ where: { id: episodeId }, data: { title } });
    return title;
  } catch {
    return null;
  }
}

export function generateId(): string {
  return randomUUID();
}
