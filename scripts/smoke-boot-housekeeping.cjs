/**
 * Boot-time housekeeping smoke (real app boots, isolated data root).
 *
 * Proves the wiring and its ordering across two real launches:
 *
 *  launch 1 — the legacy migration runs (no done marker yet) and opens the
 *             legacy partitions it reads, so their directories are held for the
 *             life of that process. The reclaim pass must not race it: it runs
 *             after the migration settles, deletes what is free, and defers the
 *             held store as "in use" instead of reporting a failed pass. The
 *             `deferredPaths` assertion pins that held-store contract (it stays
 *             green whether or not the reclaim waits, because the migration
 *             grabs its partitions in the same tick), and the planned-vs-marker
 *             timestamp assertion is the one that discriminates the ordering:
 *             firing the reclaim without waiting for the migration makes the
 *             plan predate the done marker and turns this smoke red.
 *  launch 2 — the done marker makes the migration a no-op, nothing is held, and
 *             the deferred store is reclaimed.
 *
 * The isolated root keeps the user's own profile out of the experiment, and the
 * terminal daemon and bridge port are moved aside so this instance shares no
 * resource with a running one. The cleaner's own rules are covered by
 * scripts/smoke-dead-store-housekeeping.cjs.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_PORT = process.env.ANTIFAN_SMOKE_BRIDGE_PORT || '20999';
const BOOT_TIMEOUT_MS = 180000;
const DAY_MS = 24 * 60 * 60 * 1000;

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = 1;
}

const UUID_A = '81ca1de4-42b9-4a1f-9f0e-3f0a5b7c9d21';
const UUID_B = '5b0f2c77-8c0e-4a6b-9d13-7e2f4a8c1b90';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-boot-housekeeping-'));
const profileDir = path.join(dataRoot, 'Profile');
const configDir = path.join(dataRoot, 'config');
const runtimeDir = path.join(dataRoot, 'runtime');
const partitionsDir = path.join(profileDir, 'Partitions');
const journalPath = path.join(runtimeDir, 'logs', 'main.log');
const markerPath = path.join(configDir, 'antifan-migration-capsule-to-profile.done');

const legacyDeadDir = path.join(partitionsDir, `capsule-capsule-${UUID_A}`);
const profileKeyedDeadDir = path.join(partitionsDir, `profile-capsule-${UUID_B}`);
const livePartitionDir = path.join(partitionsDir, 'profile-profile-2');
const liveStatePath = path.join(profileDir, 'saved-tabs.json');
const staleStatePath = path.join(configDir, 'saved-tabs.json');
const tornTmpPath = `${liveStatePath}.tmp.4242.deadbeef`;

function age(target, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(target, when, when);
}

function seed() {
  fs.mkdirSync(partitionsDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  // Legacy dead store: NO cookie database, only filler. The migration opens
  // this partition to read it (which is what holds the directory), finds
  // nothing to copy, and therefore completes cleanly and writes its marker.
  fs.mkdirSync(path.join(legacyDeadDir, 'Network'), { recursive: true });
  fs.writeFileSync(path.join(legacyDeadDir, 'Network', 'filler.bin'), Buffer.alloc(2048, 3));

  // Profile-keyed dead store: unreachable by name, and no migration ever opens
  // it, so it is reclaimable in the very first launch.
  fs.mkdirSync(path.join(profileKeyedDeadDir, 'Network'), { recursive: true });
  fs.writeFileSync(path.join(profileKeyedDeadDir, 'Network', 'Cookies'), Buffer.alloc(2048, 3));

  // Live: an ordinary profile partition that must survive both launches.
  fs.mkdirSync(path.join(livePartitionDir, 'Network'), { recursive: true });
  fs.writeFileSync(path.join(livePartitionDir, 'Network', 'Cookies'), Buffer.alloc(256, 9));

  fs.writeFileSync(liveStatePath, JSON.stringify({ tabs: [{ url: 'https://example.com/' }] }));
  fs.writeFileSync(staleStatePath, JSON.stringify({ tabs: [{ url: 'https://stale.example.com/' }] }));
  fs.writeFileSync(tornTmpPath, '{}');
  age(tornTmpPath, 2 * DAY_MS);

  const cacheDir = path.join(profileDir, 'Cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'data_0'), Buffer.alloc(4096, 1));
  age(cacheDir, 2 * DAY_MS);
}

function readJournalLines() {
  try {
    return fs.readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** Graceful window close first (the app has a closed-handler shutdown path). */
function stopApp(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    spawnSync('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' });
    setTimeout(() => {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
      setTimeout(resolve, 2000);
    }, 8000);
  });
}

/** Boots the real app on the seeded root and waits for the applied pass. */
async function launchAndWaitForApplied(label) {
  const journalBefore = readJournalLines().length;
  const child = spawn(process.execPath, [path.join('scripts', 'run-electron.cjs'), '.'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ANTIFAN_DATA_ROOT: dataRoot,
      ANTIFAN_RUNTIME_DIR: runtimeDir,
      ANTIFAN_ALLOW_EVAL: 'true',
      ANTIFAN_BRIDGE_PORT: BRIDGE_PORT,
      // Never attach to (or spawn) the shared terminal daemon: this instance
      // owns nothing outside its temp root.
      ANTIFAN_USE_TERMINAL_DAEMON: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const started = Date.now();
  let applied = null;
  while (Date.now() - started < BOOT_TIMEOUT_MS) {
    for (const line of readJournalLines().slice(journalBefore)) {
      if (!line.includes('housekeeping.deadStores.applied')) continue;
      try {
        applied = JSON.parse(line);
      } catch {}
    }
    if (applied) break;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  if (!applied) {
    console.error(`FAIL: ${label} never recorded housekeeping.deadStores.applied`);
    console.error('--- journal tail ---');
    console.error(readJournalLines().slice(-10).join('\n') || '(empty)');
    console.error('--- app stdout tail ---');
    console.error(stdout.split(/\r?\n/).slice(-10).join('\n') || '(empty)');
    console.error('--- app stderr tail ---');
    console.error(stderr.split(/\r?\n/).slice(-10).join('\n') || '(empty)');
    failed = 1;
  }

  await stopApp(child);
  return { applied, journal: readJournalLines().slice(journalBefore), stdout, stderr };
}

(async () => {
  console.log(`Data root: ${dataRoot}`);
  seed();

  // ---------------------------------------------------------------------
  // Launch 1: fresh root, so the legacy migration runs beside the reclaim.
  // ---------------------------------------------------------------------
  const first = await launchAndWaitForApplied('launch 1');
  if (first.applied) {
    const applied = first.applied;
    console.log(`Launch 1 journal: ${JSON.stringify(applied).slice(0, 600)}`);
    check('launch 1 reclaims the profile-keyed dead store', !fs.existsSync(profileKeyedDeadDir) && (applied.deletedPartitions || []).includes(`profile-capsule-${UUID_B}`), JSON.stringify(applied.deletedPartitions));
    check('launch 1 reclaims the stale state duplicate', !fs.existsSync(staleStatePath));
    check('launch 1 reclaims the torn temp', !fs.existsSync(tornTmpPath));
    check('launch 1 keeps the live partition', fs.existsSync(path.join(livePartitionDir, 'Network', 'Cookies')));
    check('launch 1 keeps the live tab state', fs.existsSync(liveStatePath));
    check('launch 1 pass reports no errors', (applied.errors || []).length === 0, JSON.stringify(applied.errors));
    check(
      'launch 1 defers the store the migration holds',
      fs.existsSync(legacyDeadDir) &&
        (applied.deferredPaths || []).includes(legacyDeadDir) &&
        !(applied.deletedPartitions || []).includes(`capsule-capsule-${UUID_A}`),
      `deleted=${JSON.stringify(applied.deletedPartitions)} deferred=${JSON.stringify(applied.deferredPaths)}`,
    );
    // The migration must have finished before the pass was planned. Its done
    // marker carries the completion time, and the reclaim is chained behind the
    // migration promise, so the plan can never predate that marker.
    const planned = first.journal
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((record) => record && record.event === 'housekeeping.deadStores.planned');
    let markerMtimeMs = null;
    try {
      markerMtimeMs = fs.statSync(markerPath).mtimeMs;
    } catch {}
    check(
      'reclaim was planned after the migration completed',
      markerMtimeMs !== null && Boolean(planned) && planned.ts >= markerMtimeMs - 1,
      planned
        ? `planned.ts=${planned.ts} marker.mtimeMs=${markerMtimeMs}`
        : 'no housekeeping.deadStores.planned record in launch 1',
    );
  }

  // ---------------------------------------------------------------------
  // Launch 2: the marker retires the migration, so the held store is free.
  // ---------------------------------------------------------------------
  const legacyStillThere = fs.existsSync(legacyDeadDir);
  check(
    'the deferred store survived launch 1 intact for launch 2',
    legacyStillThere,
    legacyStillThere ? 'deferred, reclaimed below' : 'launch 1 deleted the held store — the reclaim raced the migration',
  );

  const second = await launchAndWaitForApplied('launch 2');
  if (second.applied) {
    console.log(`Launch 2 journal: ${JSON.stringify(second.applied).slice(0, 600)}`);
    check('launch 2 pass reports no errors', (second.applied.errors || []).length === 0, JSON.stringify(second.applied.errors));
    check(
      'launch 2 reclaims the store the migration had held',
      !fs.existsSync(legacyDeadDir) && (second.applied.deletedPartitions || []).includes(`capsule-capsule-${UUID_A}`),
      `deleted=${JSON.stringify(second.applied.deletedPartitions)}`,
    );
    check('launch 2 keeps the live partition', fs.existsSync(path.join(livePartitionDir, 'Network', 'Cookies')));
    check('launch 2 has nothing left to defer', (second.applied.deferredPaths || []).length === 0, JSON.stringify(second.applied.deferredPaths));
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } catch {}
  console.log(failed ? 'SMOKE_BOOT_HOUSEKEEPING: FAILED' : 'SMOKE_BOOT_HOUSEKEEPING: PASSED');
  process.exit(failed);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
