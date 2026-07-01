// POST /api/chat — adaptive streaming chat.
//
// Thin handler: валидация (zod) → runChatPipeline → return response.
// Вся логика в lib/chat/pipeline.ts (ChatPipeline).

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runChatPipeline } from '@/lib/chat/pipeline';
import { parseBody, chatRequestSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // ── Валидация (zod) ──
  const parsed = await parseBody(req, chatRequestSchema);
  if (!parsed.success) return parsed.response;
  const { text, episodeId, mode } = parsed.data;

  const episode = await db.episode.findUnique({ where: { id: episodeId } });
  if (!episode) {
    return NextResponse.json({ error: 'episode not found' }, { status: 404 });
  }

  // ── Pipeline ──
  const result = await runChatPipeline({ text, episodeId, mode });
  if (result instanceof NextResponse) {
    return result;  // pre-flight error
  }
  return result.response;
}
