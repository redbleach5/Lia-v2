// GET    /api/episodes/[id] — get episode with messages
// PATCH  /api/episodes/[id] — rename
// DELETE /api/episodes/[id] — delete

import { NextRequest, NextResponse } from 'next/server';
import { getEpisode, renameEpisode, deleteEpisode, getMessages } from '@/lib/memory/episodes';
import { logger } from '@/lib/logger';
import { parseBody, updateEpisodeSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const episode = await getEpisode(id);
    if (!episode) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const messages = await getMessages(id, 200);
    return NextResponse.json({ episode, messages });
  } catch (e) {
    logger.error('api', '] GET failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const parsed = await parseBody(req, updateEpisodeSchema);
    if (!parsed.success) return parsed.response;
    const { title } = parsed.data;

    if (!title || title.trim().length === 0) {
      return NextResponse.json({ error: 'title required' }, { status: 400 });
    }

    await renameEpisode(id, title);
    const episode = await getEpisode(id);
    return NextResponse.json({ episode });
  } catch (e) {
    logger.error('api', '] PATCH failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await deleteEpisode(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    logger.error('api', '] DELETE failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
