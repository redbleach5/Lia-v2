// GET /api/health — Ollama health check

import { NextResponse } from 'next/server';
import { checkOllamaHealth, getOllamaSettings } from '@/lib/ollama';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const settings = await getOllamaSettings();
    const health = await checkOllamaHealth();
    return NextResponse.json({
      ...health,
      baseUrl: settings.baseUrl,
      model: settings.model,
      embedModel: settings.embedModel,
    });
  } catch (e) {
    console.error('[api/health] failed:', e);
    return NextResponse.json(
      { ok: false, models: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
