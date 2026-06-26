// GET /api/artifacts/[filename] — download an artifact saved by save_artifact

import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { PATHS, sanitizeFilename } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// MIME types for common artifact extensions
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

  // Sanitize — prevents path traversal on all platforms
  const safeName = sanitizeFilename(filename);
  if (!safeName || safeName !== filename) {
    return NextResponse.json({ error: 'invalid filename' }, { status: 400 });
  }

  // Use path.basename to strip any directory components (defense in depth)
  const basename = path.basename(filename);
  const filePath = path.join(PATHS.artifacts, basename);

  try {
    const buf = await readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = MIME_MAP[ext] ?? 'application/octet-stream';

    return new Response(buf, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="${basename}"`,
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
