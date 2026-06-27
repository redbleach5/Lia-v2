// GET  /api/settings — get Ollama settings + available models
// POST /api/settings — update Ollama settings

import { NextRequest, NextResponse } from 'next/server';
import { getOllamaSettings, setOllamaSettings, checkOllamaHealth } from '@/lib/ollama';
import { db } from '@/lib/db';
import { PATHS } from '@/lib/paths';
import { existsSync, readdirSync } from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await getOllamaSettings();
  const health = await checkOllamaHealth();

  // List available VRM models
  const vrmFiles: string[] = [];
  try {
    if (existsSync(PATHS.publicModels)) {
      vrmFiles.push(...readdirSync(PATHS.publicModels)
        .filter(f => f.toLowerCase().endsWith('.vrm'))
        .map(f => `/models/${f}`));
    }
  } catch { /* ignore */ }

  // Read active VRM from DB
  let activeVrm: string | null = null;
  try {
    const row = await db.setting.findUnique({ where: { key: 'avatar_vrm_path' } });
    activeVrm = row?.value ?? null;
  } catch { /* ignore */ }

  // Avatar mode (2D / 3D)
  let avatarMode = '3d';
  try {
    const row = await db.setting.findUnique({ where: { key: 'avatar_mode' } });
    avatarMode = row?.value ?? '3d';
  } catch { /* ignore */ }

  return NextResponse.json({
    ...settings,
    ollamaOk: health.ok,
    ollamaError: health.error,
    availableModels: health.models ?? [],
    // Available embed models — user can choose, with descriptions
    availableEmbedModels: (health.models ?? []).filter(m =>
      m.startsWith('nomic-embed') ||
      m.startsWith('mxbai-embed') ||
      m.startsWith('bge-m3') ||
      m.startsWith('snowflake-arctic-embed') ||
      m.startsWith('bge-') ||
      m.startsWith('e5-')
    ),
    vrmFiles,
    activeVrm,
    avatarMode,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    // Ollama settings
    if (typeof body.baseUrl === 'string') {
      await setOllamaSettings({ baseUrl: body.baseUrl });
    }
    if (typeof body.model === 'string') {
      await setOllamaSettings({ model: body.model });
    }
    if (typeof body.embedModel === 'string') {
      await setOllamaSettings({ embedModel: body.embedModel });
    }

    // Avatar settings
    if (typeof body.avatarMode === 'string' && ['live2d', '3d'].includes(body.avatarMode)) {
      await db.setting.upsert({
        where: { key: 'avatar_mode' },
        create: { key: 'avatar_mode', value: body.avatarMode },
        update: { value: body.avatarMode },
      });
    }
    if (typeof body.activeVrm === 'string') {
      await db.setting.upsert({
        where: { key: 'avatar_vrm_path' },
        create: { key: 'avatar_vrm_path', value: body.activeVrm },
        update: { value: body.activeVrm },
      });
    }

    const settings = await getOllamaSettings();
    return NextResponse.json(settings);
  } catch (e) {
    console.error('[api/settings] POST failed:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
