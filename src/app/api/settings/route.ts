// GET  /api/settings — get Ollama settings + available models + avatar config
// POST /api/settings — update Ollama settings + avatar config

import { NextRequest, NextResponse } from 'next/server';
import { getOllamaSettings, setOllamaSettings, checkOllamaHealth, reloadSettings, GROQ_MODELS } from '@/lib/ollama';
import { db } from '@/lib/db';
import { PATHS } from '@/lib/paths';
import { existsSync, readdirSync } from 'fs';
import { DEFAULT_AVATAR_CONFIG, parseAvatarConfig, type AvatarConfig } from '@/lib/avatar-config';
import { logger } from '@/lib/logger';
import { parseBody, updateSettingsSchema } from '@/lib/infra/api-validation';

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

  // Avatar customization config (camera, platform, background, animation, body)
  let avatarConfig: AvatarConfig = { ...DEFAULT_AVATAR_CONFIG };
  try {
    const row = await db.setting.findUnique({ where: { key: 'avatar_config' } });
    if (row?.value) {
      avatarConfig = parseAvatarConfig(row.value);
    }
  } catch { /* ignore */ }

  return NextResponse.json({
    ...settings,
    ollamaOk: health.ok,
    ollamaError: health.error,
    availableModels: health.models ?? [],
    availableEmbedModels: (health.models ?? []).filter(m =>
      m.startsWith('nomic-embed') ||
      m.startsWith('mxbai-embed') ||
      m.startsWith('bge-m3') ||
      m.startsWith('snowflake-arctic-embed') ||
      m.startsWith('bge-') ||
      m.startsWith('e5-')
    ),
    groqModels: GROQ_MODELS,
    vrmFiles,
    activeVrm,
    avatarMode,
    avatarConfig,
  });
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, updateSettingsSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const ollamaChanged = body.baseUrl !== undefined || body.model !== undefined || body.embedModel !== undefined;
    const providerChanged = body.provider !== undefined || body.groqApiKey !== undefined || body.groqModel !== undefined;

    // Ollama settings
    if (body.baseUrl !== undefined) {
      await setOllamaSettings({ baseUrl: body.baseUrl });
    }
    if (body.model !== undefined) {
      await setOllamaSettings({ model: body.model });
    }
    if (body.embedModel !== undefined) {
      await setOllamaSettings({ embedModel: body.embedModel });
    }

    // Groq / provider settings
    if (body.provider !== undefined) {
      await setOllamaSettings({ provider: body.provider });
    }
    if (body.groqApiKey !== undefined) {
      await setOllamaSettings({ groqApiKey: body.groqApiKey });
    }
    if (body.groqModel !== undefined) {
      await setOllamaSettings({ groqModel: body.groqModel });
    }

    // Avatar mode
    if (body.avatarMode !== undefined) {
      await db.setting.upsert({
        where: { key: 'avatar_mode' },
        create: { key: 'avatar_mode', value: body.avatarMode },
        update: { value: body.avatarMode },
      });
    }

    // Active VRM
    if (body.activeVrm !== undefined && body.activeVrm !== null) {
      await db.setting.upsert({
        where: { key: 'avatar_vrm_path' },
        create: { key: 'avatar_vrm_path', value: body.activeVrm },
        update: { value: body.activeVrm },
      });
    }

    // Avatar customization config — full JSON blob
    if (body.avatarConfig) {
      const merged = parseAvatarConfig(JSON.stringify({
        ...DEFAULT_AVATAR_CONFIG,
        ...body.avatarConfig,
      }));
      await db.setting.upsert({
        where: { key: 'avatar_config' },
        create: { key: 'avatar_config', value: JSON.stringify(merged) },
        update: { value: JSON.stringify(merged) },
      });
    }

    // Если Ollama-настройки или provider менялись — перечитываем и инвалидируем кэш.
    if (ollamaChanged || providerChanged) {
      await reloadSettings();
    }

    // Возвращаем обновлённые настройки + свежий health.
    const settings = await getOllamaSettings();
    const health = await checkOllamaHealth();
    return NextResponse.json({
      ...settings,
      ollamaOk: health.ok,
      ollamaError: health.error,
      availableModels: health.models ?? [],
      availableEmbedModels: (health.models ?? []).filter(m =>
        m.startsWith('nomic-embed') ||
        m.startsWith('mxbai-embed') ||
        m.startsWith('bge-m3') ||
        m.startsWith('snowflake-arctic-embed') ||
        m.startsWith('bge-') ||
        m.startsWith('e5-')
      ),
    });
  } catch (e) {
    logger.error('api', 'POST failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
