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
  debounceTimer: NodeJS.Timeout | null;
  pendingFiles: Set<string>;
}

const IGNORED_DIR_PATTERNS = [
  /^[/\\]?node_modules([/\\]|$)/i,
  /^[/\\]?\.git([/\\]|$)/i,
  /^[/\\]?\.antifan([/\\]|$)/i,
  /^[/\\]?dist([/\\]|$)/i,
  /^[/\\]?build([/\\]|$)/i,
  /^[/\\]?\.cache([/\\]|$)/i,
  /\.tmp-[0-9a-zA-Z-]+$/i,
  /\.tmp[/\\]?$/i,
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

      const entryRef: WatcherEntry = {
        watcher: null as any,
        refCount: 1,
        callbacks,
        debounceTimer: null,
        pendingFiles: new Set<string>(),
      };
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

            entryRef.pendingFiles.add(normalized);

            if (entryRef.debounceTimer) clearTimeout(entryRef.debounceTimer);
            entryRef.debounceTimer = setTimeout(() => {
              const files = Array.from(entryRef.pendingFiles);
              entryRef.pendingFiles.clear();
              entryRef.debounceTimer = null;

              if (files.length === 0) return;

              const isAllCss = files.every((f) => f.toLowerCase().endsWith('.css'));
              const eventType: PreviewChangeEvent['type'] = isAllCss ? 'css-swap' : 'full-reload';

              const event: PreviewChangeEvent = {
                type: eventType,
                file: files[0] || '',
                capsuleId: key,
              };

              for (const cb of Array.from(entryRef.callbacks)) {
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

        entryRef.watcher = watcher;
        this.watchers.set(key, entryRef);
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
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
        entry.debounceTimer = null;
      }
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
