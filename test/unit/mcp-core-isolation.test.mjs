import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { openCore } = require(path.join(ROOT, 'packages', 'super-core', 'dist', 'index.js'));

// A store written by a build that never stamped it: opening it has to fold every
// principle, which keeps whichever thread runs the open busy for a long while.
function heavyUnstampedStore(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-core-iso-'));
  const file = path.join(dir, 'core.db');
  openCore(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 0');
  raw.exec('BEGIN');
  const insert = raw.prepare('INSERT INTO principles(principleId, statement, createdAt) VALUES (?,?,?)');
  for (let i = 0; i < rows; i++) insert.run(`p-${i}`, `isolation fixture principle number ${i} about unrelated things`, '2026-01-01T00:00:00Z');
  raw.exec('COMMIT');
  raw.close();
  return file;
}

test('a slow core.* call leaves the proxy event loop free for other requests', async () => {
  process.env.SUPER_CORE_DB = heavyUnstampedStore(20_000);
  const proxy = require(path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs'));

  // A timer armed before the call can only fire on time if nothing held the event loop:
  // a synchronous store open inside the call would push it back by the whole open.
  const started = performance.now();
  const probe = new Promise((resolve) => setTimeout(() => resolve(performance.now()), 5));
  const call = proxy.invokeCore('core.stats', {});
  const [stats, firedAt] = await Promise.all([call, probe]);
  const elapsedMs = performance.now() - started;
  const lateMs = firedAt - (started + 5);

  assert.equal(typeof stats.principles, 'number', 'the call still returns the store counts');
  assert.ok(elapsedMs > 400, `fixture must keep the core busy long enough to mean something (took ${Math.round(elapsedMs)} ms)`);
  assert.ok(lateMs < 100, `the event loop was held ${Math.round(lateMs)} ms while core.stats ran for ${Math.round(elapsedMs)} ms`);
});
