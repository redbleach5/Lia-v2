// save_artifact — сохранить артефакт (SVG, HTML, код) как файл для пользователя.
//
// Файлы кладутся в <project_root>/download/lia-artifacts/ (кросс-платформенно).
// Скачиваются через /api/artifacts/[filename].
//
// Имена файлов санитизируются через paths.ts:sanitizeFilename.

import { writeFile, mkdir, access } from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { randomUUID } from 'crypto';
import { PATHS, sanitizeFilename } from '@/lib/paths';

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

  // Sanitize filename — cross-platform safe
  filename = sanitizeFilename(filename);

  // Strip any path components (defensive — sanitizeFilename already did this)
  const basename = path.basename(filename);

  // Prevent hidden files
  if (basename.startsWith('.')) {
    filename = 'artifact-' + basename;
  }

  // Ensure artifacts directory exists
  await mkdir(PATHS.artifacts, { recursive: true });

  // If file exists, append timestamp
  const fullPath = path.join(PATHS.artifacts, basename);
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

  const finalPath = path.join(PATHS.artifacts, finalName);
  await writeFile(finalPath, content, 'utf8');

  // Persist to DB for listing
  const id = randomUUID();
  const record = {
    id,
    filename: finalName,
    path: finalPath,
    url: `/api/artifacts/${finalName}`,
    size: content.length,
    mime,
    createdAt: Date.now(),
  };
  await db.setting.upsert({
    where: { key: `artifact:${id}` },
    create: {
      key: `artifact:${id}`,
      value: JSON.stringify(record),
    },
    update: {
      value: JSON.stringify(record),
    },
  });

  return record;
}
