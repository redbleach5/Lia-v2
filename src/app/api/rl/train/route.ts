// POST /api/rl/train — trigger training on the sidecar

import { NextRequest, NextResponse } from 'next/server';
import { trainSidecar } from '@/lib/rl/inference';
import { db } from '@/lib/db';

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

    // Записываем версию в RlModelVersion — для истории и UI.
    // Раньше версия хранилась только в Setting (rl_active_version), без метрик.
    if (result.result) {
      try {
        await db.rlModelVersion.create({
          data: {
            version: result.result.version,
            onnxPath: result.result.onnx_path,
            metricsJson: JSON.stringify({
              avgReward: result.result.avg_reward,
              avgLoss: result.result.avg_loss,
              avgValueLoss: result.result.avg_value_loss,
              avgPolicyLoss: result.result.avg_policy_loss,
              avgEntropy: result.result.avg_entropy,
              samplesCount: result.result.samples_count,
              durationSec: result.result.duration_sec,
              nEpochs: nEpochs ?? 10,
              parentVersion: parentVersion ?? null,
            }),
            parentVersion: parentVersion ?? null,
          },
        });
        console.log(`[api/rl/train] recorded model version ${result.result.version} in RlModelVersion`);
      } catch (e) {
        // Non-fatal — версия уже создана в sidecar, просто не записана в БД
        console.warn('[api/rl/train] failed to record model version (non-fatal):', e);
      }
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
