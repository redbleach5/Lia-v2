// POST /api/rl/train — trigger training on the sidecar

import { NextRequest, NextResponse } from 'next/server';
import { trainSidecar } from '@/lib/rl/inference';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { parseBody, rlTrainSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min for training

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, rlTrainSchema);
    if (!parsed.success) return parsed.response;
    const { nEpochs } = parsed.data;

    const result = await trainSidecar({ nEpochs });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? 'training failed' },
        { status: 500 },
      );
    }

    // Записываем версию в RlModelVersion — для истории и UI.
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
              nEpochs,
            }),
          },
        });
        logger.info('rl', `Recorded model version ${result.result.version} in RlModelVersion`);
      } catch (e) {
        // Non-fatal — версия уже создана в sidecar, просто не записана в БД
        logger.warn('rl', 'failed to record model version (non-fatal)', {}, e);
      }
    }

    return NextResponse.json({ result: result.result });
  } catch (e) {
    logger.error('rl', 'failed', {}, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
