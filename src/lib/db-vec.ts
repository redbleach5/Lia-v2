// SQLite + sqlite-vec for vector ops.
//
// Architecture:
//   - VectorMemory table (managed by Prisma) stores text + metadata + embedding BLOB
//   - vec0 virtual table (managed here) is a separate index pointing to VectorMemory rows
//   - We sync them: on insert into VectorMemory, also insert into vec_virtual
//   - Search: query vec_virtual with MATCH + pre-filter by episode_id, JOIN back to VectorMemory
//
// Why virtual table instead of scalar function:
//   - vec0 supports KNN search with LIMIT + WHERE in one query (faster)
//   - Pre-filtering by episode_id is native SQL WHERE
//   - No need to scan all rows and compute cosine manually

import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { arch, platform } from 'node:process';

// ============================================================================
// sqlite-vec loader
// ============================================================================
function getSqliteVecPath(): string {
  const ext = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so';
  const osName = platform === 'win32' ? 'windows' : platform;
  const pkgName = `sqlite-vec-${osName}-${arch}`;
  const filename = `vec0.${ext}`;

  const candidates = [
    path.join(process.cwd(), 'node_modules', pkgName, filename),
    path.join(process.cwd(), '..', '..', 'node_modules', pkgName, filename),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `sqlite-vec native binary not found. Looked for:\n${candidates.join('\n')}\n` +
    `Install it: bun add ${pkgName}`
  );
}

const DB_PATH = process.env.DATABASE_URL?.replace('file:', '') || path.join(process.cwd(), 'db/custom.db');

mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Singleton — survives HMR in dev
const globalForVec = globalThis as unknown as { __vecDb?: Database.Database };

let db: Database.Database;
if (globalForVec.__vecDb) {
  db = globalForVec.__vecDb;
} else {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  try {
    const vecPath = getSqliteVecPath();
    db.loadExtension(vecPath);
    console.log('[db-vec] sqlite-vec loaded from', vecPath);
  } catch (e) {
    console.error('[db-vec] Failed to load sqlite-vec:', e);
    throw e;
  }

  // Create vec0 virtual table — 768-dim float vectors (nomic-embed-text dimension)
  // We store episode_id as a metadata column for pre-filtering.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_virtual USING vec0(
        embedding float[768],
        episode_id text,
        source_type text
      )
    `);
    console.log('[db-vec] vec_virtual table ready');
  } catch (e) {
    console.error('[db-vec] Failed to create vec_virtual table:', e);
    throw e;
  }

  globalForVec.__vecDb = db;
}

export { db as vecDb };

// ============================================================================
// Vector operations
// ============================================================================

/**
 * Pack a Float32Array as a Buffer for BLOB storage.
 */
export function packEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Unpack a BLOB back into a Float32Array.
 */
export function unpackEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Insert a vector memory row.
 * Writes to BOTH VectorMemory (Prisma-managed, full data) AND vec_virtual (vec0 index).
 *
 * NOTE: caller must also insert into VectorMemory via Prisma to keep metadata.
 * This function only updates the vec0 index. For symmetry, we provide a combined
 * helper `insertVectorMemory` below that does both via the raw db.
 */
export function insertVectorMemory(params: {
  id: string;
  episodeId: string;
  sourceType: string;
  text: string;
  embedding: Float32Array;
}): void {
  const embeddingStr = `[${Array.from(params.embedding).join(',')}]`;

  // Insert into VectorMemory (raw SQL — Prisma schema has this table)
  const stmt1 = db.prepare(`
    INSERT INTO VectorMemory (id, episodeId, sourceType, text, embedding, ts)
    VALUES (@id, @episodeId, @sourceType, @text, @embedding, datetime('now'))
  `);
  stmt1.run({
    id: params.id,
    episodeId: params.episodeId,
    sourceType: params.sourceType,
    text: params.text,
    embedding: packEmbedding(params.embedding),
  });

  // Insert into vec_virtual index (using rowid = hash of id for stable mapping)
  // We use the VectorMemory.id as the rowid by hashing it to an integer.
  // Actually vec0 requires integer rowid — we use a counter or hash.
  // Simpler: store the VectorMemory.id in a metadata table and use auto-increment rowid.
  // But we don't have that. Workaround: use a separate mapping table.
  const rowid = hashToRowid(params.id);
  const stmt2 = db.prepare(`
    INSERT INTO vec_virtual (rowid, embedding, episode_id, source_type)
    VALUES (?, vec_f32(?), ?, ?)
  `);
  stmt2.run(rowid, embeddingStr, params.episodeId, params.sourceType);

  // Store mapping rowid → id so we can JOIN back
  db.prepare(`
    CREATE TABLE IF NOT EXISTS vec_rowid_map (rowid INTEGER PRIMARY KEY, vector_id TEXT NOT NULL, episode_id TEXT NOT NULL)
  `).run();
  db.prepare(`INSERT OR REPLACE INTO vec_rowid_map (rowid, vector_id, episode_id) VALUES (?, ?, ?)`)
    .run(rowid, params.id, params.episodeId);
}

/**
 * Hash a string to a 32-bit integer for use as vec0 rowid.
 * Collisions are possible but extremely rare for UUIDs.
 */
function hashToRowid(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Semantic search WITHIN a single episode — pre-filtered at SQL level.
 *
 * Uses vec0 KNN search with WHERE episode_id = ?.
 * Returns top-N matches with similarity (1 - distance).
 */
export function searchVectorsInEpisode(params: {
  episodeId: string;
  queryEmbedding: Float32Array;
  limit?: number;
  minSimilarity?: number;
}): Array<{ id: string; sourceType: string; text: string; similarity: number }> {
  const { episodeId, queryEmbedding, limit = 5, minSimilarity = 0.3 } = params;
  const embeddingStr = `[${Array.from(queryEmbedding).join(',')}]`;

  // vec0 KNN search: MATCH with the query vector, ORDER BY distance, LIMIT
  // We pre-filter by episode_id using a subquery on vec_rowid_map
  // Actually, vec0 supports KNN with WHERE on metadata columns directly:
  //
  //   SELECT rowid, distance
  //   FROM vec_virtual
  //   WHERE episode_id = ?
  //   AND embedding MATCH vec_f32(?)
  //   ORDER BY distance
  //   LIMIT ?
  //
  // But there's a quirk: in vec0, MATCH must come last in WHERE.
  // The correct syntax:
  //   WHERE episode_id = ? AND embedding MATCH ?
  //
  // distance is cosine distance (0=identical, 2=opposite). similarity = 1 - distance.

  try {
    const stmt = db.prepare(`
      SELECT v.rowid, v.distance, m.vector_id as id
      FROM vec_virtual v
      JOIN vec_rowid_map m ON v.rowid = m.rowid
      WHERE m.episode_id = ?
        AND v.embedding MATCH vec_f32(?)
        AND v.distance <= ?
      ORDER BY v.distance
      LIMIT ?
    `);

    const rows = stmt.all(episodeId, embeddingStr, 1 - minSimilarity, limit) as Array<{
      rowid: number;
      distance: number;
      id: string;
    }>;

    if (rows.length === 0) return [];

    // Fetch text + sourceType from VectorMemory for matched ids
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const metaStmt = db.prepare(`
      SELECT id, sourceType, text FROM VectorMemory WHERE id IN (${placeholders})
    `);
    const metas = metaStmt.all(...ids) as Array<{ id: string; sourceType: string; text: string }>;
    const metaMap = new Map(metas.map(m => [m.id, m]));

    return rows
      .map(r => {
        const meta = metaMap.get(r.id);
        if (!meta) return null;
        return {
          id: r.id,
          sourceType: meta.sourceType,
          text: meta.text,
          similarity: 1 - r.distance,
        };
      })
      .filter((x): x is { id: string; sourceType: string; text: string; similarity: number } => x !== null);
  } catch (e) {
    console.warn('[db-vec] search failed:', e);
    return [];
  }
}

/**
 * Count vectors in an episode (for stats / debug).
 */
export function countVectorsInEpisode(episodeId: string): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM VectorMemory WHERE episodeId = ?').get(episodeId) as { c: number };
  return row.c;
}

/**
 * Delete all vectors for an episode.
 */
export function deleteVectorsInEpisode(episodeId: string): void {
  // Get rowids to delete from vec_virtual
  const rowids = db.prepare('SELECT rowid FROM vec_rowid_map WHERE episode_id = ?').all(episodeId) as Array<{ rowid: number }>;
  if (rowids.length > 0) {
    const placeholders = rowids.map(() => '?').join(',');
    db.prepare(`DELETE FROM vec_virtual WHERE rowid IN (${placeholders})`).run(...rowids.map(r => r.rowid));
  }
  db.prepare('DELETE FROM vec_rowid_map WHERE episode_id = ?').run(episodeId);
  db.prepare('DELETE FROM VectorMemory WHERE episodeId = ?').run(episodeId);
}

/**
 * Generate a UUID.
 */
export function generateId(): string {
  return randomUUID();
}
