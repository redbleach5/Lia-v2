// GET  /api/episodes — list episodes
// POST /api/episodes — create new episode

import { NextRequest, NextResponse } from 'next/server';
import { listEpisodes, createEpisode } from '@/lib/memory/episodes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const episodes = await listEpisodes(50);
    return NextResponse.json({ episodes });
  } catch (e) {
    console.error('[api/episodes] GET failed:', e);
    return NextResponse.json({ error: 'failed to list episodes' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const title: string | undefined = body?.title;

    const episode = await createEpisode(typeof title === 'string' ? title : undefined);
    return NextResponse.json({ episode }, { status: 201 });
  } catch (e) {
    console.error('[api/episodes] POST failed:', e);
    return NextResponse.json({ error: 'failed to create episode' }, { status: 500 });
  }
}
