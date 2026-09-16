import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Retain only the newest crash dumps in a directory tree.
 *
 * Every native death leaves a dump behind, and the crash reporter exists so those deaths
 * stay diagnosable. Keeping every dump instead turns that diagnostic surface into
 * unbounded disk growth on a machine that is already crashing repeatedly, which is how a
 * crash turns into a disk-full failure that is much harder to read.
 *
 * Ordering is by mtime, so the dumps that survive are the ones describing the most recent
 * deaths. A file that cannot be read or unlinked is skipped rather than failing startup:
 * retention is housekeeping, and it must never be the reason the app does not launch.
 */
export function pruneOldCrashDumps(dir: string, maxRetained = 3): string[] {
  const unlinked: string[] = [];
  try {
    if (!fs.existsSync(dir)) return unlinked;

    const collectDumps = (currentDir: string): Array<{ path: string; mtime: number }> => {
      const results: Array<{ path: string; mtime: number }> = [];
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            results.push(...collectDumps(fullPath));
          } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dmp')) {
            try {
              results.push({ path: fullPath, mtime: fs.statSync(fullPath).mtimeMs });
            } catch {}
          }
        }
      } catch {}
      return results;
    };

    const dumps = collectDumps(dir);
    if (dumps.length <= maxRetained) return unlinked;

    dumps.sort((a, b) => b.mtime - a.mtime);
    for (const dump of dumps.slice(maxRetained)) {
      try {
        fs.unlinkSync(dump.path);
        unlinked.push(dump.path);
      } catch {}
    }
  } catch {}
  return unlinked;
}
