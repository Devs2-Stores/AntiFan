/**
 * Concurrent access mode for `.super-core/core.db`.
 *
 * The runner writes the Core DB while the MCP server may be reading it. The mode
 * is locked here so both sides agree: WAL journal (readers never block the
 * writer, the writer never blocks readers) plus a busy_timeout so a contended
 * write waits instead of failing with SQLITE_BUSY. This mirrors the DDL in
 * `packages/super-core/src/schema.ts` (journal_mode = WAL) and the connection
 * setup in `packages/super-core/src/index.ts` (busy_timeout = 5000) — the runner
 * opens the same file under the same contract rather than inventing a second
 * access mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CORE_DB_BUSY_TIMEOUT_MS = 5_000;

export function defaultCoreDbPath(root = process.cwd()) {
  return path.join(root, '.super-core', 'core.db');
}

/**
 * Open the Core DB under the locked concurrent-access mode.
 * Returns `{ db, journalMode, busyTimeoutMs }` so the caller can record which
 * mode the run actually used.
 */
export function openCoreDb(dbPath = defaultCoreDbPath(), { busyTimeoutMs = CORE_DB_BUSY_TIMEOUT_MS } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
  db.exec('PRAGMA journal_mode = WAL');
  const { journal_mode: journalMode } = db.prepare('PRAGMA journal_mode').get();
  return { db, journalMode, busyTimeoutMs };
}
