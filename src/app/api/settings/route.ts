// GET  /api/settings — get Ollama settings
// POST /api/settings — update Ollama settings

import { NextRequest, NextResponse } from 'next/server';
import { getOllamaSettings, setOllamaSettings } from '@/lib/ollama';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await getOllamaSettings();
  return NextResponse.json(settings);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    await setOllamaSettings({
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      embedModel: typeof body.embedModel === 'string' ? body.embedModel : undefined,
    });
    const settings = await getOllamaSettings();
    return NextResponse.json(settings);
  } catch (e) {
    console.error('[api/settings] POST failed:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
