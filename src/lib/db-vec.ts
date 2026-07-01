import 'server-only';

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
import { mkdirSync } from 'fs';
import { resolveSqliteVecPath, resolveDbPath } from '@/lib/paths';
import { logger } from '@/lib/logger';

// ============================================================================
// DB path — cross-platform resolution via paths.ts
// ============================================================================
const DB_PATH = resolveDbPath(process.env.DATABASE_URL);

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
    const vecPath = resolveSqliteVecPath();
    db.loadExtension(vecPath);
    logger.info('db', `sqlite-vec loaded`, { path: vecPath });
  } catch (e) {
    logger.error('db', 'Failed to load sqlite-vec extension', {}, e);
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

    // Mapping table: vec0 rowid (integer) → VectorMemory id (UUID string) + episode_id
    // Created at init so that search doesn't fail with "no such table" on first call
    // (which happens before any insertVectorMemory has been called).
    db.exec(`
      CREATE TABLE IF NOT EXISTS vec_rowid_map (
        rowid INTEGER PRIMARY KEY,
        vector_id TEXT NOT NULL,
        episode_id TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vec_rowid_map_episode ON vec_rowid_map(episode_id)`);

    // ── Auto-create Prisma tables that vec operations depend on ──
    // If user has an older DB file (created before VectorMemory / EmotionalMemory
    // were added to schema), Prisma's `db push` was not run on it — and our
    // raw SQL queries against VectorMemory fail with "no such table".
    // We create them here as a fallback. Prisma's own client also creates
    // them on first use IF the schema was pushed, so this is idempotent.
    db.exec(`
      CREATE TABLE IF NOT EXISTS VectorMemory (
        id         TEXT NOT NULL PRIMARY KEY,
        episodeId  TEXT NOT NULL,
        sourceType TEXT NOT NULL,
        text       TEXT NOT NULL,
        embedding  BLOB NOT NULL,
        ts         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vectormemory_episodeId ON VectorMemory(episodeId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vectormemory_sourceType ON VectorMemory(sourceType)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS EmotionalMemory (
        id                TEXT NOT NULL PRIMARY KEY,
        episodeId         TEXT NOT NULL,
        emotion           TEXT NOT NULL,
        intensity         REAL NOT NULL DEFAULT 0.5,
        trigger           TEXT NOT NULL,
        context           TEXT NOT NULL,
        emotionVectorJson TEXT,
        embedding         BLOB,
        consolidated      BOOLEAN NOT NULL DEFAULT 0,
        sourceIds         TEXT,
        ts                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_emotionalmemory_episodeId ON EmotionalMemory(episodeId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_emotionalmemory_emotion ON EmotionalMemory(emotion)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_emotionalmemory_intensity ON EmotionalMemory(intensity)`);

    logger.info('db', 'vec_virtual + vec_rowid_map + Prisma tables ready');
  } catch (e) {
    logger.error('db', 'Failed to create vec tables', {}, e);
    throw e;
  }

  globalForVec.__vecDb = db;
}

// NOTE: `db` НЕ экспортируется напрямую. Все операции с vec index
// проходят через функции-обёртки ниже (insertVectorMemory, searchVectorsInEpisode,
// deleteVectorsInEpisode, insertEmotionalVectorIndex, searchEmotionalVectorsInEpisode,
// deleteEmotionalVectorsByEpisodeId).
// Это инкапсулирует vec0 virtual table и предотвращает прямой SQL-доступ
// из других модулей (emotional-memory.ts раньше импортировал vecDb и писал
// raw SQL — теперь использует обёртки).

// ============================================================================
// Vector operations — dialogue memory (VectorMemory table + vec_virtual index)
// ============================================================================

/**
 * Pack a Float32Array as a Buffer for BLOB storage.
 */
export function packEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Insert a vector memory row.
 * Writes to BOTH VectorMemory (Prisma-managed, full data) AND vec_virtual (vec0 index).
 *
 * Все 3 записи обёрнуты в транзакцию better-sqlite3 — если любая падает,
 * откатываются все. Решает проблему orphaned VectorMemory rows,
 * которые не находятся векторным поиском, но учитываются в COUNT.
 */
export function insertVectorMemory(params: {
  id: string;
  episodeId: string;
  sourceType: string;
  text: string;
  embedding: Float32Array;
}): void {
  const embeddingStr = `[${Array.from(params.embedding).join(',')}]`;
  const rowid = hashToRowid(params.id);

  const txn = db.transaction(() => {
    // 1. Insert into VectorMemory (raw SQL — Prisma schema has this table)
    db.prepare(`
      INSERT INTO VectorMemory (id, episodeId, sourceType, text, embedding, ts)
      VALUES (@id, @episodeId, @sourceType, @text, @embedding, datetime('now'))
    `).run({
      id: params.id,
      episodeId: params.episodeId,
      sourceType: params.sourceType,
      text: params.text,
      embedding: packEmbedding(params.embedding),
    });

    // 2. Insert into vec_virtual index (using rowid = hash of id for stable mapping)
    db.prepare(`
      INSERT OR REPLACE INTO vec_virtual (rowid, embedding, episode_id, source_type)
      VALUES (?, vec_f32(?), ?, ?)
    `).run(rowid, embeddingStr, params.episodeId, params.sourceType);

    // 3. Store mapping rowid → id so we can JOIN back
    db.prepare(`INSERT OR REPLACE INTO vec_rowid_map (rowid, vector_id, episode_id) VALUES (?, ?, ?)`)
      .run(rowid, params.id, params.episodeId);
  });

  txn();
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
 * Uses vec0 KNN search with WHERE episode_id = ? (AND optionally source_type = ?).
 * Returns top-N matches with similarity (1 - distance).
 *
 * sourceType filter решает cross-contamination: без него recall(dialogue)
 * мог вернуть emotional anchors, и наоборот. Теперь recall() в vector.ts
 * передаёт sourceType='dialogue', recallEmotionalAnchors — 'emotional'.
 */
export function searchVectorsInEpisode(params: {
  episodeId: string;
  queryEmbedding: Float32Array;
  limit?: number;
  minSimilarity?: number;
  sourceType?: string;  // если задан — фильтрует по source_type в vec_virtual
}): Array<{ id: string; sourceType: string; text: string; similarity: number }> {
  const { episodeId, queryEmbedding, limit = 5, minSimilarity = 0.3, sourceType } = params;
  const embeddingStr = `[${Array.from(queryEmbedding).join(',')}]`;

  try {
    // vec0 KNN: MATCH должен идти последним в WHERE.
    // source_type filter добавляется только если задан (иначе возвращаем все типы).
    const sourceTypeClause = sourceType ? 'AND v.source_type = ?' : '';
    const stmt = db.prepare(`
      SELECT v.rowid, v.distance, m.vector_id as id
      FROM vec_virtual v
      JOIN vec_rowid_map m ON v.rowid = m.rowid
      WHERE m.episode_id = ?
        ${sourceTypeClause}
        AND v.embedding MATCH vec_f32(?)
        AND v.k = ?
        AND v.distance <= ?
      ORDER BY v.distance
    `);

    const bindParams: (string | number)[] = sourceType
      ? [episodeId, sourceType, embeddingStr, limit, 1 - minSimilarity]
      : [episodeId, embeddingStr, limit, 1 - minSimilarity];

    const rows = stmt.all(...bindParams) as Array<{
      rowid: number;
      distance: number;
      id: string;
    }>;

    if (rows.length === 0) return [];

    // Fetch text + sourceType from VectorMemory for matched ids.
    // Defence-in-depth: also filter by episodeId — even though vec_rowid_map
    // already filtered by episode_id, this prevents any theoretical leak
    // if vec_virtual/vec_rowid_map ever return ids from wrong episode.
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const metaStmt = db.prepare(`
      SELECT id, sourceType, text FROM VectorMemory WHERE id IN (${placeholders}) AND episodeId = ?
    `);
    const metas = metaStmt.all(...ids, episodeId) as Array<{ id: string; sourceType: string; text: string }>;
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
    logger.warn('db', `Vector search failed`, {
      episodeId: episodeId.slice(0, 8),
      sourceType: sourceType ?? 'any',
      limit,
      minSimilarity,
    }, e);
    return [];
  }
}

/**
 * Delete all vectors for an episode.
 *
 * Все 3 DELETE обёрнуты в транзакцию — гарантирует консистентность:
 * либо все vec_virtual + vec_rowid_map + VectorMemory записи удалены,
 * либо ни одна (откат).
 */
export function deleteVectorsInEpisode(episodeId: string): void {
  const txn = db.transaction(() => {
    const rowids = db.prepare('SELECT rowid FROM vec_rowid_map WHERE episode_id = ?').all(episodeId) as Array<{ rowid: number }>;
    if (rowids.length > 0) {
      const placeholders = rowids.map(() => '?').join(',');
      db.prepare(`DELETE FROM vec_virtual WHERE rowid IN (${placeholders})`).run(...rowids.map(r => r.rowid));
    }
    db.prepare('DELETE FROM vec_rowid_map WHERE episode_id = ?').run(episodeId);
    db.prepare('DELETE FROM VectorMemory WHERE episodeId = ?').run(episodeId);
  });

  try {
    txn();
  } catch (e) {
    // Таблицы могут не существовать если DB не мигрирована — логируем, но не падаем.
    logger.warn('db', 'deleteVectorsInEpisode failed (non-fatal)', { episodeId: episodeId.slice(0, 8) }, e);
  }
}

// ============================================================================
// Emotional memory vec operations — для emotional-memory.ts.
// ============================================================================
//
// Emotional anchors хранятся в Prisma EmotionalMemory table (полные данные),
// но индексируются в vec_virtual с source_type='emotional' для семантического поиска.
// vector_id имеет префикс "emo:" чтобы отличать от dialogue vectors.
//
// Раньше emotional-memory.ts импортировал vecDb напрямую и писал raw SQL.
// Теперь использует эти обёртки — инкапсуляция vec0 virtual table.

/**
 * Insert emotional anchor into vec_virtual index (atomic, transactional).
 * vector_id должен иметь префикс "emo:" для отличия от dialogue vectors.
 */
export function insertEmotionalVectorIndex(params: {
  vectorId: string;  // "emo:<cuid>"
  episodeId: string;
  embedding: Float32Array;
}): void {
  const embeddingStr = `[${Array.from(params.embedding).join(',')}]`;
  const rowid = hashToRowid(params.vectorId);

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO vec_virtual (rowid, embedding, episode_id, source_type)
      VALUES (?, vec_f32(?), ?, 'emotional')
    `).run(rowid, embeddingStr, params.episodeId);

    db.prepare(`INSERT OR REPLACE INTO vec_rowid_map (rowid, vector_id, episode_id) VALUES (?, ?, ?)`)
      .run(rowid, params.vectorId, params.episodeId);
  });

  txn();
}

/**
 * Search emotional anchors in vec_virtual index (source_type='emotional').
 * Возвращает array of { vectorId, distance } — caller делает JOIN с Prisma
 * EmotionalMemory table для полных данных.
 */
export function searchEmotionalVectorsInEpisode(params: {
  episodeId: string;
  queryEmbedding: Float32Array;
  limit: number;
  maxDistance?: number;
}): Array<{ vectorId: string; distance: number }> {
  const { episodeId, queryEmbedding, limit, maxDistance = 0.9 } = params;
  const embeddingStr = `[${Array.from(queryEmbedding).join(',')}]`;

  try {
    const rows = db.prepare(`
      SELECT v.rowid, v.distance, m.vector_id as id
      FROM vec_virtual v
      JOIN vec_rowid_map m ON v.rowid = m.rowid
      WHERE m.episode_id = ?
        AND v.source_type = 'emotional'
        AND v.embedding MATCH vec_f32(?)
        AND v.k = ?
        AND v.distance <= ?
      ORDER BY v.distance
    `).all(episodeId, embeddingStr, limit, maxDistance) as Array<{
      rowid: number;
      distance: number;
      id: string;
    }>;

    return rows.map(r => ({ vectorId: r.id, distance: r.distance }));
  } catch (e) {
    logger.warn('db', 'searchEmotionalVectorsInEpisode failed', { episodeId: episodeId.slice(0, 8) }, e);
    return [];
  }
}

/**
 * Delete emotional vectors for an episode (vec_virtual + vec_rowid_map only).
 * EmotionalMemory Prisma rows удаляются отдельно через cascade или явный delete.
 * Используется при deleteEpisode.
 */
export function deleteEmotionalVectorsByEpisodeId(episodeId: string): void {
  const txn = db.transaction(() => {
    const rowids = db.prepare(`
      SELECT v.rowid FROM vec_virtual v
      JOIN vec_rowid_map m ON v.rowid = m.rowid
      WHERE m.episode_id = ? AND v.source_type = 'emotional'
    `).all(episodeId) as Array<{ rowid: number }>;

    if (rowids.length > 0) {
      const placeholders = rowids.map(() => '?').join(',');
      db.prepare(`DELETE FROM vec_virtual WHERE rowid IN (${placeholders})`).run(...rowids.map(r => r.rowid));
    }
    db.prepare('DELETE FROM vec_rowid_map WHERE episode_id = ?').run(episodeId);
  });

  try {
    txn();
  } catch (e) {
    logger.warn('db', 'deleteEmotionalVectorsByEpisodeId failed (non-fatal)', { episodeId: episodeId.slice(0, 8) }, e);
  }
}

