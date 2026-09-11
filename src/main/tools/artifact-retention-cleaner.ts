import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RetentionSweepOptions {
  maxBytes?: number; // default: 200 MB
  maxAgeMs?: number; // default: 24h
  minProtectAgeMs?: number; // default: 1h (never delete files newer than this)
  /**
   * Owner-supplied exemption for individual files. The store uses it to keep permanent
   * evidence (report artifacts) alive through age- and budget-driven sweeps.
   */
  isProtected?: (absolutePath: string) => boolean;
}

export interface RetentionSweepResult {
  scannedFiles: number;
  deletedFiles: number;
  freedBytes: number;
  remainingBytes: number;
  protectedFiles: number;
}

/** Per-run bookkeeping file written by ArtifactStore.persistRunIndex. */
const RUN_INDEX_FILE_NAME = 'index.json';

export class ArtifactRetentionCleaner {
  /**
   * Sweeps the artifact root directory for stale `.artifact` files and unlinks them.
   * Prioritizes keeping newest files by mtime (LRU).
   * Invariant: Never deletes files with mtime < minProtectAgeMs (default 1 hour).
   * Invariant: Never deletes files the owner declares protected (permanent report evidence).
   *
   * Scope: this sweeper owns the run-scoped artifact root only — content-addressed captures and
   * the run index that describes them. A run whose artifacts are all gone keeps no index stub.
   * Workspace-owned evidence is deliberately out of scope and is never swept here: annotation
   * documents and snapshots written by AnnotationManager live under `<workspace>/.antifan/
   * annotations` and `<workspace>/.antifan/snapshots`, where the user owns them.
   */
  public static sweep(rootDir: string, options: RetentionSweepOptions = {}): RetentionSweepResult {
    const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
    const maxAgeMs = options.maxAgeMs ?? 24 * 3600 * 1000;
    const minProtectAgeMs = options.minProtectAgeMs ?? 3600 * 1000;

    const result: RetentionSweepResult = {
      scannedFiles: 0,
      deletedFiles: 0,
      freedBytes: 0,
      remainingBytes: 0,
      protectedFiles: 0,
    };

    if (!rootDir || !fs.existsSync(rootDir)) {
      return result;
    }

    const now = Date.now();
    const fileEntries: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const runIndexEntries: Array<{ path: string; dir: string; mtimeMs: number }> = [];

    const walkDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.artifact')) {
            try {
              const stat = fs.statSync(fullPath);
              fileEntries.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
            } catch {}
          } else if (entry.isFile() && entry.name === RUN_INDEX_FILE_NAME) {
            try {
              const stat = fs.statSync(fullPath);
              runIndexEntries.push({ path: fullPath, dir, mtimeMs: stat.mtimeMs });
            } catch {}
          }
        }
      } catch {}
    };

    walkDir(rootDir);
    result.scannedFiles = fileEntries.length;

    // Sort by mtimeMs ascending (oldest first)
    fileEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalBytes = fileEntries.reduce((sum, f) => sum + f.size, 0);

    for (const file of fileEntries) {
      const ageMs = now - file.mtimeMs;
      // Invariant: Never delete files younger than minProtectAgeMs
      if (ageMs < minProtectAgeMs) {
        continue;
      }

      // Invariant: files the owner declares protected are never unlinked, by age or by budget
      if (options.isProtected?.(file.path) === true) {
        result.protectedFiles++;
        continue;
      }

      const isStaleByAge = ageMs > maxAgeMs;
      const isOverBudget = totalBytes > maxBytes;

      if (isStaleByAge || isOverBudget) {
        try {
          fs.unlinkSync(file.path);
          result.deletedFiles++;
          result.freedBytes += file.size;
          totalBytes -= file.size;
        } catch {}
      }
    }

    result.remainingBytes = totalBytes;

    // Runs whose artifacts are all gone keep no bookkeeping: the index exists to describe
    // captures, so an evacuated run tree is pruned instead of lingering as an unreadable stub.
    for (const runIndex of runIndexEntries) {
      if (now - runIndex.mtimeMs < minProtectAgeMs) {
        continue;
      }
      if (options.isProtected?.(runIndex.path) === true) {
        result.protectedFiles++;
        continue;
      }
      if (ArtifactRetentionCleaner.directoryHoldsArtifacts(runIndex.dir)) {
        continue;
      }
      try {
        fs.unlinkSync(runIndex.path);
      } catch {}
    }

    // Clean up empty directories
    const cleanEmptyDirs = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          try {
            if (fs.statSync(fullPath).isDirectory()) {
              cleanEmptyDirs(fullPath);
            }
          } catch {}
        }
        if (dir !== rootDir && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
      } catch {}
    };

    cleanEmptyDirs(rootDir);
    return result;
  }

  /** Whether a run directory still holds captures worth indexing. Unreadable means "assume yes". */
  private static directoryHoldsArtifacts(dir: string): boolean {
    try {
      return fs.readdirSync(dir).some((name) => name.endsWith('.artifact'));
    } catch {
      return true;
    }
  }
}
