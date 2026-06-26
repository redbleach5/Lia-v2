// Cross-platform path resolution for Lia v2.
//
// All file paths should go through this module — no hardcoded absolute paths
// anywhere else. Works on macOS, Windows, Linux.
//
// The project root is detected via:
//   1. LIA_ROOT env var (if set)
//   2. process.cwd() (default — works when `bun run dev` is called from project root)
//
// DATABASE_URL in .env should be RELATIVE:
//   DATABASE_URL=file:./db/custom.db
// (Prisma resolves it relative to the schema.prisma location).
//
// On Tauri/desktop, you'd set LIA_ROOT to the user data dir explicitly.

import path from 'path';
import { existsSync } from 'fs';

// ============================================================================
// Project root
// ============================================================================
export const PROJECT_ROOT = process.env.LIA_ROOT || process.cwd();

// ============================================================================
// Standard directories
// ============================================================================
export const PATHS = {
  root: PROJECT_ROOT,
  db: path.join(PROJECT_ROOT, 'db'),
  dbFile: path.join(PROJECT_ROOT, 'db', 'custom.db'),
  artifacts: path.join(PROJECT_ROOT, 'download', 'lia-artifacts'),
  public: path.join(PROJECT_ROOT, 'public'),
  publicModels: path.join(PROJECT_ROOT, 'public', 'models'),
  logs: path.join(PROJECT_ROOT, 'logs'),
} as const;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a path that may be:
 *   - absolute (returned as-is, normalized)
 *   - relative (resolved against PROJECT_ROOT)
 */
export function resolveProjectPath(p: string): string {
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.join(PROJECT_ROOT, p);
}

/**
 * Convert a DB path from .env to a filesystem path.
 *
 * Prisma's SQLite URL format: `file:./db/custom.db` or `file:/abs/path/db.db`
 * We strip the `file:` prefix and resolve the rest.
 *
 * If the path is relative, it's resolved against PROJECT_ROOT (NOT the cwd
 * of whoever started the process — important for Tauri/desktop scenarios).
 */
export function resolveDbPath(dbUrl: string | undefined): string {
  const raw = dbUrl?.replace(/^file:/, '') || path.join('db', 'custom.db');
  return resolveProjectPath(raw);
}

/**
 * Resolve the sqlite-vec native binary path.
 *
 * Searches multiple candidate locations to support:
 *   - Standard install: <root>/node_modules/sqlite-vec-<platform>-<arch>/vec0.<ext>
 *   - Monorepo: <root>/../../node_modules/...
 *   - Tauri bundled: <root>/resources/vec0.<ext>
 */
export function resolveSqliteVecPath(): string {
  const ext = process.platform === 'win32' ? 'dll'
    : process.platform === 'darwin' ? 'dylib'
    : 'so';
  const osName = process.platform === 'win32' ? 'windows' : process.platform;
  const pkgName = `sqlite-vec-${osName}-${process.arch}`;
  const filename = `vec0.${ext}`;

  const candidates = [
    // Standard install
    path.join(PROJECT_ROOT, 'node_modules', pkgName, filename),
    // Monorepo: project is in packages/<name>
    path.join(PROJECT_ROOT, '..', '..', 'node_modules', pkgName, filename),
    // Bun global cache fallback
    path.join(process.env.HOME || process.env.USERPROFILE || '~', '.bun', 'install', 'cache', pkgName, filename),
    // Tauri: bundled alongside the binary
    path.join(PROJECT_ROOT, 'resources', filename),
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // skip — fs may not be available in some contexts
    }
  }

  throw new Error(
    `sqlite-vec native binary not found. Looked for:\n${candidates.join('\n')}\n` +
    `Install it: bun add ${pkgName}`
  );
}

/**
 * Sanitize a filename — strip path separators, prevent traversal.
 * Used for user-provided filenames (e.g., save_artifact).
 */
export function sanitizeFilename(filename: string): string {
  // Replace path separators and dangerous chars
  const cleaned = filename
    .replace(/[\\/:]/g, '_')  // path separators → underscore
    .replace(/\s+/g, '_')     // whitespace → underscore
    .replace(/^\./, '_')      // no leading dot (hidden files)
    .toLowerCase();

  // Whitelist: letters, digits, dots, hyphens, underscores
  const safe = cleaned.replace(/[^a-zа-яё0-9._-]/gi, '_');

  // Limit length
  return safe.slice(0, 200) || 'untitled';
}
