import 'server-only';

// save_artifact — сохранить артефакт (SVG, HTML, код) как файл для пользователя.
//
// Файлы кладутся в <project_root>/download/lia-artifacts/ (кросс-платформенно).
// Скачиваются через /api/artifacts/[filename].
//
// Имена файлов санитизируются через paths.ts:sanitizeFilename.
//
// Phase 1 fix: атомарный create-or-rename через fs.open(path, 'wx') (O_EXCL).
// Раньше access + writeFile имели TOCTOU race: между access и writeFile
// другой процесс мог создать файл. Теперь EEXIST обрабатывается атомарно.

import { writeFile, mkdir, open } from 'fs/promises';
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
  const { content, mime } = params;
  let filename = sanitizeFilename(params.filename);

  // Strip any path components (defensive — sanitizeFilename already did this)
  const basename = path.basename(filename);

  // Prevent hidden files
  if (basename.startsWith('.')) {
    filename = 'artifact-' + basename;
  }

  // Ensure artifacts directory exists
  await mkdir(PATHS.artifacts, { recursive: true });

  // Атомарный create-or-rename через fs.open(path, 'wx') (O_EXCL).
  // 'wx' flag: open for writing, fail with EEXIST if file exists.
  // Это решает TOCTOU race: между проверкой "существует ли" и записью
  // другой процесс не может вмешаться.
  let finalName = basename;
  let finalPath = path.join(PATHS.artifacts, finalName);
  try {
    const handle = await open(finalPath, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.close();
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      // File exists — prepend timestamp and retry
      const ext = path.extname(basename);
      const stem = path.basename(basename, ext);
      finalName = `${stem}-${Date.now()}${ext}`;
      finalPath = path.join(PATHS.artifacts, finalName);
      await writeFile(finalPath, content, 'utf8');
    } else {
      throw e;
    }
  }

  // Persist to DB for listing.
  // size — byte length, не char length (для не-ASCII контента Cyrillic SVG etc).
  const id = randomUUID();
  const record: SaveArtifactResult = {
    id,
    filename: finalName,
    path: finalPath,
    url: `/api/artifacts/${finalName}`,
    size: Buffer.byteLength(content, 'utf8'),
    mime,
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
