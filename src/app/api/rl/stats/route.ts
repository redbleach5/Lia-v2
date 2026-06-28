// GET  /api/rl/stats — RL sidecar status + local experience count
// POST /api/rl/stats — refresh (re-fetch from sidecar)

import { NextResponse } from 'next/server';
import { getSidecarStats } from '@/lib/rl/inference';
import { countExperiences } from '@/lib/rl/recorder';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [sidecar, localCount] = await Promise.all([
      getSidecarStats(),
      countExperiences(),
    ]);

    return NextResponse.json({
      sidecar_ok: sidecar.ok,
      sidecar_stats: sidecar.stats,
      sidecar_error: sidecar.error,
      local_experiences: localCount,
    });
  } catch (e) {
    logger.error('rl', 'failed', {}, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
