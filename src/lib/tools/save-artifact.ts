// save_artifact — сохранить артефакт (SVG, HTML, код) как файл для пользователя.
//
// Файлы кладутся в /home/z/my-project/download/lia-artifacts/
// Скачиваются через /api/artifacts/[filename]
//
// Имена файлов санитизируются: только [a-zA-Z0-9._-], без path traversal.

import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { randomUUID } from 'crypto';

const ARTIFACTS_DIR = path.join(process.cwd(), 'download', 'lia-artifacts');

// Allowed filename pattern — strict whitelist to prevent path traversal
const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/;

export type SaveArtifactResult = {
  id: string;
  filename: string;
  path: string;
  url: string;
  size: number;
  mime: string;
};

export async function saveArtifact(params: {
  filename: string;
  content: string;
  mime: string;
}): Promise<SaveArtifactResult> {
  let { filename, content, mime } = params;

  // Sanitize filename
  filename = filename.replace(/\s+/g, '_').toLowerCase();

  // Strip any path components
  const basename = path.basename(filename);

  if (!SAFE_FILENAME.test(basename)) {
    throw new Error(`Invalid filename: ${filename}. Only letters, digits, dots, hyphens, underscores allowed.`);
  }

  // Prevent hidden files
  if (basename.startsWith('.')) {
    filename = 'artifact-' + basename;
  }

  // Ensure directory exists
  await mkdir(ARTIFACTS_DIR, { recursive: true });

  // If file exists, append timestamp
  const fullPath = path.join(ARTIFACTS_DIR, basename);
  const { access } = await import('fs/promises');
  let finalName = basename;
  try {
    await access(fullPath);
    // Exists — prepend timestamp
    const ext = path.extname(basename);
    const stem = path.basename(basename, ext);
    finalName = `${stem}-${Date.now()}${ext}`;
  } catch {
    // Doesn't exist — use as-is
  }

  const finalPath = path.join(ARTIFACTS_DIR, finalName);
  await writeFile(finalPath, content, 'utf8');

  // Persist to DB for listing
  const id = randomUUID();
  await db.setting.upsert({
    where: { key: `artifact:${id}` },
    create: {
      key: `artifact:${id}`,
      value: JSON.stringify({
        id,
        filename: finalName,
        path: finalPath,
        url: `/api/artifacts/${finalName}`,
        size: content.length,
        mime,
        createdAt: Date.now(),
      }),
    },
    update: {
      value: JSON.stringify({
        id,
        filename: finalName,
        path: finalPath,
        url: `/api/artifacts/${finalName}`,
        size: content.length,
        mime,
        createdAt: Date.now(),
      }),
    },
  });

  return {
    id,
    filename: finalName,
    path: finalPath,
    url: `/api/artifacts/${finalName}`,
    size: content.length,
    mime,
  };
}
