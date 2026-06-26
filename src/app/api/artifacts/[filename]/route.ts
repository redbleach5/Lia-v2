// GET /api/artifacts/[filename] — download an artifact saved by save_artifact

import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ARTIFACTS_DIR = path.join(process.cwd(), 'download', 'lia-artifacts');

// Strict whitelist — prevents path traversal
const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/;

const MIME_MAP: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  // Sanitize
  if (!SAFE_FILENAME.test(filename)) {
    return NextResponse.json({ error: 'invalid filename' }, { status: 400 });
  }

  const filePath = path.join(ARTIFACTS_DIR, filename);

  try {
    const buf = await readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = MIME_MAP[ext] ?? 'application/octet-stream';

    return new Response(buf, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return NextResponse.json({ error: 'artifact not found' }, { status: 404 });
    }
    console.error('[api/artifacts] read failed:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
