// POST /api/rl/activate — set the active RL model version

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { reloadModel } from '@/lib/rl/inference';
import { logger } from '@/lib/logger';
import { parseBody, rlActivateSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, rlActivateSchema);
    if (!parsed.success) return parsed.response;
    const { version } = parsed.data;

    // Save to DB
    await db.setting.upsert({
      where: { key: 'rl_active_version' },
      create: { key: 'rl_active_version', value: String(version) },
      update: { value: String(version) },
    });

    // Reload the inference session
    const ok = await reloadModel(version);

    return NextResponse.json({ ok, version });
  } catch (e) {
    logger.error('rl', 'failed', {}, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
