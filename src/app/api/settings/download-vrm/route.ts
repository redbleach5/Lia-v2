// POST /api/settings/download-vrm — download the sample VRM from Pixiv repo
//
// Saves to public/models/sample.vrm
// Useful when the user doesn't have their own VRM yet.

import { NextResponse } from 'next/server';
import { writeFile, mkdir, access } from 'fs/promises';
import path from 'path';
import { PATHS } from '@/lib/paths';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 1 min for download

const SAMPLE_VRM_URL = 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm';
const SAMPLE_VRM_FILENAME = 'sample.vrm';

export async function POST() {
  try {
    // Check if already exists
    const localPath = path.join(PATHS.publicModels, SAMPLE_VRM_FILENAME);
    try {
      await access(localPath);
      // Already exists — just set as active
      await db.setting.upsert({
        where: { key: 'avatar_vrm_path' },
        create: { key: 'avatar_vrm_path', value: `/models/${SAMPLE_VRM_FILENAME}` },
        update: { value: `/models/${SAMPLE_VRM_FILENAME}` },
      });
      return NextResponse.json({
        ok: true,
        message: 'Sample VRM already exists',
        url: `/models/${SAMPLE_VRM_FILENAME}`,
        alreadyExisted: true,
      });
    } catch {
      // Doesn't exist — download
    }

    // Download
    const res = await fetch(SAMPLE_VRM_URL, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return NextResponse.json({
        error: `Failed to download sample VRM: HTTP ${res.status}`,
      }, { status: 502 });
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // Ensure dir
    await mkdir(PATHS.publicModels, { recursive: true });

    // Write
    await writeFile(localPath, buffer);

    // Set as active
    await db.setting.upsert({
      where: { key: 'avatar_vrm_path' },
      create: { key: 'avatar_vrm_path', value: `/models/${SAMPLE_VRM_FILENAME}` },
      update: { value: `/models/${SAMPLE_VRM_FILENAME}` },
    });

    return NextResponse.json({
      ok: true,
      message: 'Sample VRM downloaded successfully',
      url: `/models/${SAMPLE_VRM_FILENAME}`,
      sizeMb: (buffer.length / 1024 / 1024).toFixed(1),
    });
  } catch (e) {
    logger.error('api', 'failed', {}, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
