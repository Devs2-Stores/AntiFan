import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PreviewChangeEvent {
  type: 'css-swap' | 'full-reload';
  file: string;
  capsuleId: string;
}

interface WatcherEntry {
  watcher: fs.FSWatcher;
  refCount: number;
  callbacks: Set<(event: PreviewChangeEvent) => void>;
}

const IGNORED_DIR_PATTERNS = [
  /^[/\\]?node_modules([/\\]|$)/i,
  /^[/\\]?\.git([/\\]|$)/i,
  /^[/\\]?\.antifan([/\\]|$)/i,
  /^[/\\]?dist([/\\]|$)/i,
  /^[/\\]?build([/\\]|$)/i,
  /^[/\\]?\.cache([/\\]|$)/i,
];

/**
 * Reference-counted file watcher pool for active preview tabs.
 * Watches workspace directory changes and dispatches debounced scoped reload events.
 */
export class PreviewWatcherPool {
  private watchers = new Map<string, WatcherEntry>();

  public retain(
    capsuleId: string,
    workspacePath: string,
    onChanged: (event: PreviewChangeEvent) => void
  ): () => void {
    const key = capsuleId.toLowerCase();
    let entry = this.watchers.get(key);

    if (entry) {
      entry.refCount++;
      entry.callbacks.add(onChanged);
    } else {
      if (!fs.existsSync(workspacePath)) {
        return () => {};
      }

      const callbacks = new Set<(event: PreviewChangeEvent) => void>();
      callbacks.add(onChanged);

      let debounceTimer: NodeJS.Timeout | null = null;
      let pendingFiles = new Set<string>();

      try {
        const watcher = fs.watch(
          workspacePath,
          { recursive: true },
          (_eventType: string, filename: string | null) => {
            if (!filename) return;

            // Filter out ignored paths
            const normalized = filename.replace(/\\/g, '/');
            for (const pattern of IGNORED_DIR_PATTERNS) {
              if (pattern.test(normalized) || pattern.test('/' + normalized)) {
                return;
              }
            }

            pendingFiles.add(normalized);

            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              const files = Array.from(pendingFiles);
              pendingFiles.clear();

              if (files.length === 0) return;

              const isAllCss = files.every((f) => f.toLowerCase().endsWith('.css'));
              const eventType: PreviewChangeEvent['type'] = isAllCss ? 'css-swap' : 'full-reload';

              const event: PreviewChangeEvent = {
                type: eventType,
                file: files[0] || '',
                capsuleId: key,
              };

              for (const cb of callbacks) {
                try {
                  cb(event);
                } catch {
                  // Ignore callback errors in listener loop
                }
              }
            }, 150);
          }
        );

        watcher.on('error', () => {
          // Fail-safe cleanup on watcher error
          this.release(capsuleId, onChanged);
        });

        entry = { watcher, refCount: 1, callbacks };
        this.watchers.set(key, entry);
      } catch {
        return () => {};
      }
    }

    // Return cleanup callback
    return () => {
      this.release(capsuleId, onChanged);
    };
  }

  public release(capsuleId: string, onChanged?: (event: PreviewChangeEvent) => void): void {
    const key = capsuleId.toLowerCase();
    const entry = this.watchers.get(key);
    if (!entry) return;

    if (onChanged) {
      entry.callbacks.delete(onChanged);
    }

    entry.refCount--;
    if (entry.refCount <= 0 || entry.callbacks.size === 0) {
      try {
        entry.watcher.close();
      } catch {
        // Ignore close error
      }
      this.watchers.delete(key);
    }
  }

  public getActiveWatcherCount(): number {
    return this.watchers.size;
  }

  public getRefCount(capsuleId: string): number {
    const entry = this.watchers.get(capsuleId.toLowerCase());
    return entry ? entry.refCount : 0;
  }

  public clear(): void {
    for (const entry of this.watchers.values()) {
      try {
        entry.watcher.close();
      } catch {
        // Ignore close error
      }
    }
    this.watchers.clear();
  }
}
