// GET    /api/episodes/[id] — get episode with messages
// PATCH  /api/episodes/[id] — rename
// DELETE /api/episodes/[id] — delete

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEpisode, renameEpisode, deleteEpisode, getMessages } from '@/lib/memory/episodes';

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
    console.error('[api/episodes/[id]] GET failed:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const title: string | undefined = body?.title;

    if (typeof title !== 'string' || title.trim().length === 0) {
      return NextResponse.json({ error: 'title required' }, { status: 400 });
    }

    await renameEpisode(id, title);
    const episode = await getEpisode(id);
    return NextResponse.json({ episode });
  } catch (e) {
    console.error('[api/episodes/[id]] PATCH failed:', e);
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
    console.error('[api/episodes/[id]] DELETE failed:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
