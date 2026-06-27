// POST /api/settings/upload-vrm — upload a VRM file via multipart/form-data
//
// Saves to public/models/<original-name>.vrm
// Returns the public URL for the file.

import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { PATHS, sanitizeFilename } from '@/lib/paths';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_VRM_SIZE = 50 * 1024 * 1024; // 50 MB

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith('.vrm')) {
      return NextResponse.json({ error: 'Only .vrm files are supported' }, { status: 400 });
    }

    if (file.size > MAX_VRM_SIZE) {
      return NextResponse.json({
        error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB. Max ${MAX_VRM_SIZE / 1024 / 1024} MB.`,
      }, { status: 413 });
    }

    // Sanitize filename
    const safeName = sanitizeFilename(file.name);
    if (!safeName.endsWith('.vrm')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    // Ensure dir exists
    await mkdir(PATHS.publicModels, { recursive: true });

    // Write the file
    const buffer = Buffer.from(await file.arrayBuffer());
    const fullPath = path.join(PATHS.publicModels, safeName);
    await writeFile(fullPath, buffer);

    const publicUrl = `/models/${safeName}`;

    // Set as active VRM
    await db.setting.upsert({
      where: { key: 'avatar_vrm_path' },
      create: { key: 'avatar_vrm_path', value: publicUrl },
      update: { value: publicUrl },
    });

    return NextResponse.json({
      ok: true,
      filename: safeName,
      url: publicUrl,
      size: file.size,
      sizeMb: (file.size / 1024 / 1024).toFixed(1),
    });
  } catch (e) {
    console.error('[api/settings/upload-vrm] failed:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
