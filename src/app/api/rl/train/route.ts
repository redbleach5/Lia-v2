// POST /api/rl/train — trigger training on the sidecar

import { NextRequest, NextResponse } from 'next/server';
import { trainSidecar } from '@/lib/rl/inference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min for training

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const nEpochs: number | undefined = typeof body?.nEpochs === 'number'
      ? Math.min(100, Math.max(1, body.nEpochs))
      : undefined;
    const parentVersion: number | undefined = typeof body?.parentVersion === 'number'
      ? Math.max(0, body.parentVersion)
      : undefined;

    const result = await trainSidecar({ nEpochs, parentVersion });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? 'training failed' },
        { status: 500 },
      );
    }

    return NextResponse.json({ result: result.result });
  } catch (e) {
    console.error('[api/rl/train] failed:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
