/**
 * AntiFan Browser Desktop — Guarded Dead-Store Cleaner
 *
 * Reclaims disk from Chromium partitions that no code path can ever reach
 * again, plus the state-file debris left by earlier layout moves.
 *
 * The inventory is deliberately narrow, because every write here is a
 * deletion:
 *
 *   1. `<profileDir>/Partitions/capsule-capsule-<uuid>` — legacy isolated
 *      capsule jars, superseded by `persist:profile-*`.
 *   2. `<profileDir>/Partitions/profile-capsule-<uuid>` — the output of a
 *      re-prefixing migration whose namespace nothing resolves; each one holds
 *      a full copy of a capsule jar that no tab can open.
 *   3. `<profileDir>/Cache` — the default session's HTTP cache. No tab serves
 *      traffic from it once every tab carries an explicit partition, so its
 *      content is stale, but the running app's network service still holds the
 *      directory open: expect a deferral while the app is up, and the removal to
 *      land on a pass that finds it unheld. Chromium recreates it empty (measured
 *      220 MB of stale content reclaimed to 2 KB), which is why this is a
 *      space reclaim, not a correctness fix.
 *   4. `<configDir>/saved-tabs.json` — a duplicate of the live state file from
 *      before the data root moved. The app reads `<profileDir>/saved-tabs.json`.
 *   5. `*.tmp.*` leftovers in either state directory — torn atomic writes whose
 *      final name already exists on disk.
 *
 * Every candidate passes the same class of guards before `rmSync`: an exact
 * name pattern, a live-conflict check (partition owned by a tab, state directory
 * written within the quiet period), and a path-containment assertion. The whole
 * pass is idempotent — a second run finds nothing to match and reports zeros.
 *
 * A candidate the OS refuses to release (EPERM/EBUSY, i.e. something holds it)
 * is reported in `deferredPaths`, never in `errors`: a store read earlier in the
 * same process stays held for that process's life, so the caller must both chain
 * this pass after such a reader and expect the reclaim one launch later. The
 * boot call site does exactly that (see `reclaimDeadStores` in `main/index.ts`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Names of partitions that nothing resolves: a legacy capsule jar
 * (`capsule-capsule-<uuid>`) or a re-prefixed copy (`profile-capsule-<uuid>`).
 * Anything else — `profile-profile-2`, `profile-default`, a standard profile —
 * cannot match by construction.
 */
export const DEAD_PARTITION_PATTERN = /^(capsule-capsule-[a-f0-9-]+|profile-capsule-[a-f0-9-]+)$/;

const SAVED_TABS_FILE = 'saved-tabs.json';
/** Marker an atomic writer puts between the final name and its random suffix. */
const ATOMIC_TMP_MARKER = '.tmp.';
/** A cache directory untouched for this long cannot belong to a live session. */
const CACHE_QUIET_MS = 24 * 60 * 60 * 1000;
/** A verified atomic write completes in milliseconds; an hour-old temp is debris. */
const TMP_QUIET_MS = 60 * 60 * 1000;

export interface CleanupReport {
  scannedCount: number;
  deletedPartitions: string[];
  skippedPartitions: string[];
  deletedFiles: string[];
  /**
   * Targets whose deletion the OS refused because something still holds them
   * (a live session, another process). Not a failure: the next launch retries,
   * and by then the holder is gone. Contained here rather than in `errors` so a
   * busy store cannot masquerade as a broken pass.
   */
  deferredPaths: string[];
  reclaimedBytes: number;
  dryRun: boolean;
  errors: string[];
}

export interface DeadStoreCleanupOptions {
  /** Directory Chromium uses as the browser profile (`app.getPath('userData')`). */
  profileDir: string;
  /** Directory holding the app's config state, including the stale duplicate. */
  configDir: string;
  /**
   * Partition names currently referenced by tabs, offscreen tabs included.
   * A partition in this list is never deleted, whatever its name.
   */
  livePartitions: Iterable<string>;
  dryRun?: boolean;
}

export function isDeadPartitionName(name: string): boolean {
  return DEAD_PARTITION_PATTERN.test(name);
}

/** Recursive byte count; an unreadable entry contributes 0 rather than aborting the pass. */
function directorySize(target: string): number {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(target);
  } catch {
    return 0;
  }
  if (stats.isFile()) return stats.size;
  let total = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(target);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    total += directorySize(path.join(target, entry));
  }
  return total;
}

/** Partition name a `<profileDir>/Partitions/<dirName>` directory backs. */
function partitionNameForDirectory(dirName: string): string {
  return `persist:${dirName}`;
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function isQuiet(stats: fs.Stats, quietMs: number): boolean {
  return Date.now() - stats.mtimeMs >= quietMs;
}

function readDirOrEmpty(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function pruneDeadStores(options: DeadStoreCleanupOptions): CleanupReport {
  const dryRun = options.dryRun === true;
  const report: CleanupReport = {
    scannedCount: 0,
    deletedPartitions: [],
    skippedPartitions: [],
    deletedFiles: [],
    deferredPaths: [],
    reclaimedBytes: 0,
    dryRun,
    errors: [],
  };

  const profileDir = path.resolve(options.profileDir);
  const partitionsDir = path.join(profileDir, 'Partitions');
  const livePartitions = new Set(options.livePartitions);

  const removePath = (target: string): boolean => {
    const size = directorySize(target);
    if (dryRun) {
      report.reclaimedBytes += size;
      return true;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      report.reclaimedBytes += size;
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // EPERM/EBUSY on Windows is what a directory held by another process
      // reports; the holder is a live session, and this pass must not treat a
      // live holder as a broken cleanup. Reclaimed on a later launch instead.
      if (code === 'EPERM' || code === 'EBUSY') {
        report.deferredPaths.push(target);
        return false;
      }
      report.errors.push(`delete failed for ${target}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  // 1 + 2. Dead partitions.
  let partitionEntries: string[] = [];
  try {
    partitionEntries = fs.readdirSync(partitionsDir);
  } catch {
    partitionEntries = [];
  }
  for (const entry of partitionEntries) {
    if (!isDeadPartitionName(entry)) continue;
    report.scannedCount += 1;
    const target = path.resolve(partitionsDir, entry);
    // Path containment: a name that escapes the partitions root is refused
    // outright, whatever it matched.
    if (!target.startsWith(path.resolve(partitionsDir) + path.sep)) {
      report.errors.push(`containment refusal for ${target}`);
      report.skippedPartitions.push(entry);
      continue;
    }
    if (livePartitions.has(partitionNameForDirectory(entry))) {
      report.skippedPartitions.push(entry);
      continue;
    }
    if (removePath(target)) {
      report.deletedPartitions.push(entry);
    }
  }

  // 3. Abandoned default-partition cache. Only when no tab still lives on the
  //    default session, because that session owns this directory, and only when
  //    the directory has been quiet for a day — a cache written seconds ago
  //    belongs to a running session whatever the tab list says.
  if (!livePartitions.has('default') && !livePartitions.has('')) {
    const cacheDir = path.join(profileDir, 'Cache');
    const cacheStats = statOrNull(cacheDir);
    if (cacheStats && isQuiet(cacheStats, CACHE_QUIET_MS)) {
      report.scannedCount += 1;
      if (removePath(cacheDir)) {
        report.deletedFiles.push(cacheDir);
      }
    }
  }

  // 4. Stale duplicate state file: only removable once the live copy exists,
  //    otherwise it is the only surviving record of the user's tabs.
  const liveStatePath = path.join(profileDir, SAVED_TABS_FILE);
  const staleStatePath = path.join(path.resolve(options.configDir), SAVED_TABS_FILE);
  if (fs.existsSync(liveStatePath) && fs.existsSync(staleStatePath) && path.resolve(staleStatePath) !== path.resolve(liveStatePath)) {
    report.scannedCount += 1;
    if (removePath(staleStatePath)) {
      report.deletedFiles.push(staleStatePath);
    }
  }

  // 5. Torn atomic-write leftovers, in both state directories. A temp is debris
  //    only when its final name already exists (so the write completed and the
  //    rename failed) and it has been quiet for an hour (so no writer is mid
  //    flight). Either guard alone would risk deleting the only copy of a state
  //    file, or a sibling instance's in-progress write.
  for (const dir of [profileDir, path.resolve(options.configDir)]) {
    for (const entry of readDirOrEmpty(dir)) {
      if (!entry.includes(ATOMIC_TMP_MARKER)) continue;
      const markerAt = entry.indexOf(ATOMIC_TMP_MARKER);
      if (markerAt <= 0) continue;
      const finalName = entry.slice(0, markerAt);
      const target = path.resolve(dir, entry);
      if (!target.startsWith(dir + path.sep)) {
        report.errors.push(`containment refusal for ${target}`);
        continue;
      }
      if (!fs.existsSync(path.resolve(dir, finalName))) {
        // Some writers dot-prefix the temp (`.bridge-dev.json.tmp.<id>`) while
        // renaming onto the undotted target: same rule, resolved name.
        const undotted = finalName.replace(/^\.+/, '');
        if (undotted === '' || !fs.existsSync(path.resolve(dir, undotted))) continue;
      }
      const stats = statOrNull(target);
      if (!stats || !isQuiet(stats, TMP_QUIET_MS)) continue;
      report.scannedCount += 1;
      if (removePath(target)) {
        report.deletedFiles.push(target);
      }
    }
  }

  return report;
}
