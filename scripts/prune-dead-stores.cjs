/**
 * Guarded reclaim of dead Chromium stores on the REAL data root.
 *
 * The app runs the same pass at boot (`reclaimDeadStores` in `src/main/index.ts`,
 * journaled as `housekeeping.deadStores.planned` / `.applied`). This runner exists
 * for the case where the reclaim must be observable without booting the app: it
 * calls the shipped cleaner directly, derives the live-partition vetoes from the
 * same sources the boot pass uses, and prints the audit report.
 *
 * Safety contract:
 *   - dry-run by default; `--apply` is required to delete anything
 *   - a state file that exists but cannot be parsed aborts the run: without it the
 *     live partitions are unknown and the veto would be a guess
 *   - every live-partition source is over-inclusive on purpose: a name the app
 *     can derive for a real Chrome profile or for a restored tab is vetoed even
 *     when it looks dead, because a wrong deletion is unrecoverable
 *   - the cleaner itself re-checks the exact name pattern, path containment, a
 *     quiet period, and a live-conflict set before removing anything
 *
 * Usage:
 *   node scripts/prune-dead-stores.cjs            # report only
 *   node scripts/prune-dead-stores.cjs --apply    # reclaim
 */
const { pruneDeadStores } = require('../.compiled/src/main/browser/dead-store-cleaner.js');
const { ChromeProfileSyncManager } = require('../.compiled/src/main/browser/chrome-profile-sync.js');
const { StorageLocations } = require('../.compiled/src/main/config/storage-locations.js');
const path = require('node:path');
const fs = require('node:fs');

const apply = process.argv.includes('--apply');

const profileDir = path.join(StorageLocations.getDataRoot(), 'Profile');
const configDir = StorageLocations.getConfigDir();

/**
 * Every partition a tab can own once the session state is restored. A tab
 * carries either an explicit partition or a capsule id, which the host turns
 * into `persist:capsule-<capsuleId>` — and `capsule-<uuid>` capsule ids collapse
 * into exactly the `capsule-capsule-<uuid>` directory name the dead-store
 * pattern matches.
 */
function livePartitionNamesFromState() {
  const statePath = path.join(profileDir, 'saved-tabs.json');
  if (!fs.existsSync(statePath)) return [];
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    console.error(`Refusing to run: ${statePath} exists but cannot be parsed (${err.message}).`);
    console.error('Without it the live partitions are unknown, so every veto would be a guess.');
    process.exit(2);
  }
  const names = [];
  for (const tab of Array.isArray(state?.tabs) ? state.tabs : []) {
    if (typeof tab?.partition === 'string' && tab.partition) {
      names.push(tab.partition.replace(/^persist:/, ''));
    }
    const capsuleId = tab?.capsuleId || tab?.capsule;
    if (typeof capsuleId === 'string' && capsuleId) names.push(`capsule-${capsuleId}`);
  }
  return names;
}

/**
 * Partitions the profile resolver can derive for a real Chrome profile
 * (`persist:profile-<id.toLowerCase()>`, native-tab-host.ts). A Chrome profile
 * directory may legitimately be named `capsule-*`, whose derived partition lands
 * in the namespace the dead-store pattern matches — only this list tells them
 * apart, which is why the boot pass carries the same half.
 */
function livePartitionNamesFromChromeProfiles() {
  const names = [];
  try {
    for (const profile of ChromeProfileSyncManager.getInstance().getAvailableProfiles()) {
      if (!profile?.id) continue;
      names.push(`profile-${profile.id.toLowerCase()}`);
    }
  } catch (err) {
    console.error(`Refusing to run: Chrome profile enumeration failed (${err.message}).`);
    process.exit(2);
  }
  return names;
}

const livePartitions = [...livePartitionNamesFromState(), ...livePartitionNamesFromChromeProfiles()];
const options = { profileDir, configDir, livePartitions };

const planned = pruneDeadStores({ ...options, dryRun: true });
const applied = apply ? pruneDeadStores(options) : planned;

console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      profileDir,
      configDir,
      livePartitionVetoes: livePartitions.length,
      scanned: applied.scannedCount,
      deletedPartitions: applied.deletedPartitions.length,
      skippedPartitions: applied.skippedPartitions.length,
      deletedFiles: applied.deletedFiles,
      deferred: applied.deferredPaths,
      reclaimedMB: +(applied.reclaimedBytes / (1024 * 1024)).toFixed(2),
      errors: applied.errors,
    },
    null,
    2
  )
);

if (applied.errors.length > 0) process.exitCode = 1;
