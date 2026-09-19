/**
 * Read-only inventory of the real data root via the shipped cleaner (dryRun).
 *
 * Touches nothing: the reclaim itself runs inside the app at boot and journals
 * `housekeeping.deadStores.applied`. Use this to see what that pass will find.
 *
 * `livePartitions` is deliberately empty, so this is a worst-case inventory: the
 * boot pass additionally vetoes anything a tab owns and defers anything held.
 */
const { pruneDeadStores } = require('../.compiled/src/main/browser/dead-store-cleaner.js');
const { StorageLocations } = require('../.compiled/src/main/config/storage-locations.js');
const path = require('node:path');
const fs = require('node:fs');

const profileDir = path.join(StorageLocations.getDataRoot(), 'Profile');
const configDir = StorageLocations.getConfigDir();
const report = pruneDeadStores({ profileDir, configDir, livePartitions: [], dryRun: true });
console.log(JSON.stringify({
  profileDir, configDir,
  scanned: report.scannedCount,
  deadPartitions: report.deletedPartitions.length,
  reclaimedMB: +(report.reclaimedBytes / (1024 * 1024)).toFixed(2),
  cacheDirPresent: fs.existsSync(path.join(profileDir, 'Cache')),
  files: report.deletedFiles,
  deferred: report.deferredPaths,
  errors: report.errors,
  sample: report.deletedPartitions.slice(0, 3),
}, null, 2));
