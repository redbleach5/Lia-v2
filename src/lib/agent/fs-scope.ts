import 'server-only';

// ============================================================================
// fsScope helpers — безопасная работа с путями внутри рабочей директории агента.
// ============================================================================
//
// Используется:
//   - lib/agent/tools.ts — все FS-инструменты агента (read_file, write_file, ...)
//   - app/api/agent/[id]/workspace/route.ts — workspace UI file browser
//
// Защита от path traversal:
//   1. resolve(base) и resolve(target) — нормализуют пути
//   2. realpath() — резолвит символьные ссылки (предотвращает symlink-атаки)
//   3. relative(base, target) — вычисляет относительный путь
//   4. Если rel начинается с '..' или является абсолютным → попытка выхода
//
// Особый случай: target не существует (write_file создаёт новый файл).
// Тогда realpath(target) бросает ENOENT — мы проверяем parent directory.

import { realpath } from 'fs/promises';
import { resolve, relative, isAbsolute } from 'path';

/**
 * Проверить, что путь находится внутри scope, и вернуть абсолютный путь.
 * Возвращает null, если путь выходит за пределы scope или scope не задан.
 *
 * Если target не существует (создание нового файла), проверяется parent directory.
 */
export async function safePathWithinScope(path: string, scope: string | null): Promise<string | null> {
  if (!scope) return null;
  const base = resolve(scope);
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path);

  try {
    const realBase = await realpath(base);
    const realTarget = await realpath(target);
    const rel = relative(realBase, realTarget);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return realTarget;
  } catch {
    // File doesn't exist yet — check the parent directory
    try {
      const realBase = await realpath(base);
      const parentDir = resolve(target, '..');
      const realParent = await realpath(parentDir);
      const rel = relative(realBase, realParent);
      if (rel.startsWith('..') || isAbsolute(rel)) return null;
      return target; // Return non-realpath'd target for writing
    } catch {
      return null;
    }
  }
}

/**
 * Синхронная проверка без realpath — для случаев, когда файл может не существовать
 * и нет нужды резолвить симлинки (например, быстрый guard в route handler).
 *
 * Менее безопасна, чем safePathWithinScope — не защищает от symlink-атак.
 * Используйте safePathWithinScope везде, где возможна атака через симлинки.
 */
export function isPathWithinScope(path: string, scope: string | null): boolean {
  if (!scope) return false;
  const base = resolve(scope);
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, target);
  return !rel.startsWith('..') && !isAbsolute(rel);
}
