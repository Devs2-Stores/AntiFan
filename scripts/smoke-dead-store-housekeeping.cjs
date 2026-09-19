/**
 * Dead-store housekeeping smoke (compiled cleaner, real filesystem).
 *
 * Proves the rules the boot-time housekeeping depends on, on a seeded data root
 * in an isolated temp directory: dead partitions are reclaimed, live ones are
 * never touched, and every "keep" branch keeps. Also proves the pass is
 * idempotent, because it runs on every launch.
 *
 * Scope: the cleaner's semantics. The app-boot wiring that calls it is covered
 * by scripts/smoke-boot-housekeeping.cjs.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { pruneDeadStores } = require(path.join(ROOT, '.compiled', 'src', 'main', 'browser', 'dead-store-cleaner.js'));

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = 1;
}

const UUID_A = 'ce983add-4a51-461c-90f2-414fad5607a0';
const UUID_B = 'd06fa05b-4b69-4c9c-ac37-a68bf7fa078';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Creates a throwaway data root and returns its parts. */
function seedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-housekeeping-'));
  const profileDir = path.join(root, 'Profile');
  const configDir = path.join(root, 'config');
  const partitionsDir = path.join(profileDir, 'Partitions');
  fs.mkdirSync(partitionsDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return { root, profileDir, configDir, partitionsDir };
}

/** Creates a partition directory carrying a payload whose size is known. */
function seedPartition(partitionsDir, name, bytes) {
  const dir = path.join(partitionsDir, name);
  fs.mkdirSync(path.join(dir, 'Network'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Network', 'Cookies'), Buffer.alloc(bytes, 7));
  return dir;
}

/** Ages a path so the quiet-period guards treat it as debris. */
function age(target, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(target, when, when);
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
}

/** Polls a predicate instead of sleeping a guessed duration. */
async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = predicate() === true;
    } catch {}
    if (ok) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Whether the directory can be renamed right now — the cheapest probe for "no
 * process holds this path". Windows returns EBUSY/EPERM while a holder has it
 * open, which is exactly the state the deferral path exists for.
 */
function canRename(target) {
  const probe = `${target}.probe`;
  try {
    fs.renameSync(target, probe);
    fs.renameSync(probe, target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Case 1: dead partitions are reclaimed, live and unrelated ones are not.
// ---------------------------------------------------------------------------
(() => {
  const { root, profileDir, configDir, partitionsDir } = seedRoot();
  try {
    const deadLegacy = seedPartition(partitionsDir, `capsule-capsule-${UUID_A}`, 4096);
    const deadProfile = seedPartition(partitionsDir, `profile-capsule-${UUID_B}`, 2048);
    const liveDeadNamed = seedPartition(partitionsDir, `capsule-capsule-${UUID_B}`, 1024);
    const unrelated = seedPartition(partitionsDir, 'profile-profile-2', 512);

    const report = pruneDeadStores({
      profileDir,
      configDir,
      // `capsule-capsule-<UUID_B>` is dead-named but a tab is using it.
      livePartitions: [`persist:capsule-capsule-${UUID_B}`],
    });

    check(
      'dead partitions reclaimed',
      report.deletedPartitions.sort().join(',') === [`capsule-capsule-${UUID_A}`, `profile-capsule-${UUID_B}`].sort().join(','),
      JSON.stringify(report.deletedPartitions),
    );
    check('legacy dead partition gone from disk', !fs.existsSync(deadLegacy));
    check('derived dead partition gone from disk', !fs.existsSync(deadProfile));
    check('dead-named partition owned by a live tab kept', fs.existsSync(liveDeadNamed) && report.skippedPartitions.includes(`capsule-capsule-${UUID_B}`));
    check('unrelated partition untouched', fs.existsSync(unrelated));
    check('reclaimed bytes counted', report.reclaimedBytes === 4096 + 2048, `reclaimedBytes=${report.reclaimedBytes}`);
    check('no errors', report.errors.length === 0, JSON.stringify(report.errors));

    // Second pass on the same root, with the same live claim: nothing left to
    // do, which is what makes a per-launch housekeeping run safe.
    const again = pruneDeadStores({ profileDir, configDir, livePartitions: [`persist:capsule-capsule-${UUID_B}`] });
    check('second pass is a no-op', again.deletedPartitions.length === 0 && again.reclaimedBytes === 0, JSON.stringify(again.deletedPartitions));
    check('live partition survives the second pass', fs.existsSync(liveDeadNamed));

    // A pass that forgets the live claim would reap it — the guard, not the
    // name pattern, is what protects a live store. Proving that here keeps the
    // boot wiring (which always supplies the claim) on the hook.
    const unclaimed = pruneDeadStores({ profileDir, configDir, livePartitions: [] });
    check('an unclaimed dead-named live store is reaped (guard is load-bearing)', !fs.existsSync(liveDeadNamed) && unclaimed.deletedPartitions.length === 1);
  } finally {
    cleanup(root);
  }
})();

// ---------------------------------------------------------------------------
// Case 2: cache is only reclaimed when no tab owns the default session.
// ---------------------------------------------------------------------------
(() => {
  const { root, profileDir, configDir } = seedRoot();
  try {
    const cacheDir = path.join(profileDir, 'Cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'data_0'), Buffer.alloc(1024, 1));
    age(cacheDir, 2 * DAY_MS);

    const kept = pruneDeadStores({ profileDir, configDir, livePartitions: ['default'] });
    check('cache kept while a tab owns the default session', fs.existsSync(cacheDir) && kept.deletedFiles.length === 0, JSON.stringify(kept.deletedFiles));

    const swept = pruneDeadStores({ profileDir, configDir, livePartitions: ['persist:profile-2'] });
    check('quiet orphan cache reclaimed when no tab owns the default session', !fs.existsSync(cacheDir) && swept.reclaimedBytes === 1024, JSON.stringify(swept.deletedFiles));

    // A cache written minutes ago belongs to a running session: quiet period.
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'data_0'), Buffer.alloc(512, 1));
    const fresh = pruneDeadStores({ profileDir, configDir, livePartitions: [] });
    check('fresh cache kept (quiet period)', fs.existsSync(cacheDir) && fresh.deletedFiles.length === 0);
  } finally {
    cleanup(root);
  }
})();

// ---------------------------------------------------------------------------
// Case 3: the duplicate state file only goes once the live copy exists.
// ---------------------------------------------------------------------------
(() => {
  const { root, profileDir, configDir } = seedRoot();
  try {
    const liveState = path.join(profileDir, 'saved-tabs.json');
    const staleState = path.join(configDir, 'saved-tabs.json');
    fs.writeFileSync(staleState, JSON.stringify({ tabs: [{ url: 'https://example.com' }] }));

    const guarded = pruneDeadStores({ profileDir, configDir, livePartitions: [] });
    check('duplicate kept while it is the only copy of the tab state', fs.existsSync(staleState) && guarded.deletedFiles.length === 0);

    fs.writeFileSync(liveState, JSON.stringify({ tabs: [{ url: 'https://example.com' }] }));
    const swept = pruneDeadStores({ profileDir, configDir, livePartitions: [] });
    check('duplicate reclaimed once the live copy exists', !fs.existsSync(staleState), JSON.stringify(swept.deletedFiles));
    check('live tab state untouched', fs.existsSync(liveState));
  } finally {
    cleanup(root);
  }
})();

// ---------------------------------------------------------------------------
// Case 4: torn atomic-write leftovers (both naming shapes) with their guards.
// ---------------------------------------------------------------------------
(() => {
  const { root, profileDir, configDir } = seedRoot();
  try {
    const finalProfile = path.join(profileDir, 'saved-tabs.json');
    fs.writeFileSync(finalProfile, '{}');

    const completedTmp = `${finalProfile}.tmp.7123.abc`;
    fs.writeFileSync(completedTmp, '{}');
    age(completedTmp, 2 * DAY_MS);

    // Dot-prefixed temp writing onto the undotted target: the shape the wider
    // resolver-visible match exists for.
    const dotTmp = path.join(configDir, '.bridge-dev.json.tmp.991.zz');
    fs.writeFileSync(dotTmp, '{}');
    fs.writeFileSync(path.join(configDir, 'bridge-dev.json'), '{}');
    age(dotTmp, 2 * DAY_MS);

    // Final name absent: the temp may be the only copy of the write.
    const orphanTmp = path.join(profileDir, 'window-state.json.tmp.5.qq');
    fs.writeFileSync(orphanTmp, '{}');
    age(orphanTmp, 2 * DAY_MS);

    // Mid-flight write: still recent.
    const busyTmp = path.join(configDir, 'ui-state.json.tmp.7.rr');
    fs.writeFileSync(busyTmp, '{}');
    fs.writeFileSync(path.join(configDir, 'ui-state.json'), '{}');

    const report = pruneDeadStores({ profileDir, configDir, livePartitions: [] });

    check('torn temp with a completed rename target reclaimed', !fs.existsSync(completedTmp));
    check('dot-prefixed temp with an undotted target reclaimed', !fs.existsSync(dotTmp), JSON.stringify(report.deletedFiles));
    check('temp whose final name is absent kept', fs.existsSync(orphanTmp));
    check('recent temp kept (a writer may be mid-flight)', fs.existsSync(busyTmp));
    check('no errors on the seeded leftovers', report.errors.length === 0, JSON.stringify(report.errors));
  } finally {
    cleanup(root);
  }
})();

// ---------------------------------------------------------------------------
// Case 5: dry run plans the same work without touching anything.
// ---------------------------------------------------------------------------
(() => {
  const { root, profileDir, configDir, partitionsDir } = seedRoot();
  try {
    const dead = seedPartition(partitionsDir, `capsule-capsule-${UUID_A}`, 8192);
    const plan = pruneDeadStores({ profileDir, configDir, livePartitions: [], dryRun: true });
    check('dry run reports the dead partition', plan.deletedPartitions.length === 1 && plan.reclaimedBytes === 8192, JSON.stringify(plan));
    check('dry run leaves the disk untouched', fs.existsSync(dead));
  } finally {
    cleanup(root);
  }
})();

// ---------------------------------------------------------------------------
// Case 5: a store something still holds is deferred, never reported as error.
// ---------------------------------------------------------------------------
const case5 = (async () => {
  const { root, profileDir, configDir, partitionsDir } = seedRoot();
  try {
    const held = seedPartition(partitionsDir, `capsule-capsule-${UUID_A}`, 4096);
    // A second process holding the directory as its working directory is the
    // deterministic stand-in for a live session holding a partition: on Windows
    // the removal comes back EPERM (verified) and a rename comes back EBUSY.
    const holder = spawn(
      process.execPath,
      ['-e', 'process.chdir(process.argv[1]); console.log("HOLDER_READY"); setInterval(() => {}, 1000)', held],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let holderOut = '';
    holder.stdout.on('data', (c) => (holderOut += c));
    const holderReady = await waitFor(() => holderOut.includes('HOLDER_READY'), 15000);
    // Ready signal first, then prove the hold is real: a free directory renames,
    // a held one comes back EBUSY/EPERM. Without this the pass could run before
    // the holder exists and "deferral" would silently become a deletion.
    const holdVerified = await waitFor(() => !canRename(held), 15000);
    check('the store is genuinely held before the pass runs', holderReady && holdVerified, `ready=${holderReady} held=${holdVerified}`);

    const report = pruneDeadStores({ profileDir, configDir, livePartitions: [] });
    check('held store is deferred, not deleted', fs.existsSync(held) && report.deferredPaths.includes(held), JSON.stringify(report.deferredPaths));
    check('held store is not counted as reclaimed', report.reclaimedBytes === 0, `reclaimedBytes=${report.reclaimedBytes}`);
    check('held store raises no error', report.errors.length === 0, JSON.stringify(report.errors));

    holder.kill('SIGKILL');
    // Wait for the handle to actually clear rather than guessing a duration.
    const released = await waitFor(() => canRename(held), 15000);
    check('the holder released the store', released);

    const settled = pruneDeadStores({ profileDir, configDir, livePartitions: [] });
    check('deferred store is reclaimed once the holder is gone', !fs.existsSync(held) && settled.reclaimedBytes === 4096, JSON.stringify(settled));
  } finally {
    cleanup(root);
  }
})();

// The held-store case awaits a second process, so the verdict follows it.
case5.then(() => {
  console.log(failed === 0 ? 'SMOKE_DEAD_STORE_HOUSEKEEPING: PASSED' : 'SMOKE_DEAD_STORE_HOUSEKEEPING: FAILED');
  process.exit(failed);
});
