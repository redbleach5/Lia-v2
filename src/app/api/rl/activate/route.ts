// POST /api/rl/activate — set the active RL model version

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { reloadModel } from '@/lib/rl/inference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const version: number | undefined = body?.version;

    if (typeof version !== 'number' || version < 1) {
      return NextResponse.json({ error: 'version required' }, { status: 400 });
    }

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
    console.error('[api/rl/activate] failed:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
