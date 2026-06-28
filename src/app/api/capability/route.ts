// GET  /api/capability — get current capability profile + tier info
// POST /api/capability/refresh — force re-detect (after model change)

import { NextResponse } from 'next/server';
import { getCapabilityProfile, detectProfile, TIER_DESCRIPTIONS, getTierParams } from '@/lib/capability-profile';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const profile = await getCapabilityProfile();
    if (!profile) {
      return NextResponse.json({
        profile: null,
        tier: null,
        tierInfo: null,
        params: null,
      });
    }

    return NextResponse.json({
      profile,
      tier: profile.tier,
      tierInfo: TIER_DESCRIPTIONS[profile.tier],
      params: getTierParams(profile.tier),
    });
  } catch (e) {
    logger.error('api', 'GET failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
