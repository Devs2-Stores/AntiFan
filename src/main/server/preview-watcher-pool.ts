import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface PreviewChangeEvent {
  type: 'css-swap' | 'full-reload';
  file: string;
  capsuleId: string;
}

interface WatcherEntry {
  watcher: fs.FSWatcher;
  refCount: number;
  canonicalPath: string;
  subscriptions: Map<string, (event: PreviewChangeEvent) => void>;
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
    const subToken = `sub-${crypto.randomUUID()}`;

    let canonicalPath = path.resolve(workspacePath);
    try {
      if (fs.existsSync(canonicalPath)) {
        canonicalPath = fs.realpathSync.native(canonicalPath);
      }
    } catch {}

    let entry = this.watchers.get(key);

    if (entry) {
      entry.refCount++;
      entry.subscriptions.set(subToken, onChanged);
    } else {
      if (!fs.existsSync(workspacePath)) {
        return () => {};
      }

      const subscriptions = new Map<string, (event: PreviewChangeEvent) => void>();
      subscriptions.set(subToken, onChanged);

      const entryRef: WatcherEntry = {
        watcher: null as unknown as fs.FSWatcher,
        refCount: 1,
        canonicalPath,
        subscriptions,
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

              for (const cb of Array.from(entryRef.subscriptions.values())) {
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
          this.release(capsuleId, subToken);
        });

        entryRef.watcher = watcher;
        this.watchers.set(key, entryRef);
      } catch {
        return () => {};
      }
    }

    // Return cleanup callback with bound unique subscription token
    return () => {
      this.release(capsuleId, subToken);
    };
  }

  public release(
    capsuleId: string,
    tokenOrCallback?: string | ((event: PreviewChangeEvent) => void)
  ): void {
    const key = capsuleId.toLowerCase();
    const entry = this.watchers.get(key);
    if (!entry) return;

    if (typeof tokenOrCallback === 'string') {
      entry.subscriptions.delete(tokenOrCallback);
      entry.refCount--;
    } else if (typeof tokenOrCallback === 'function') {
      for (const [token, cb] of entry.subscriptions.entries()) {
        if (cb === tokenOrCallback) {
          entry.subscriptions.delete(token);
          break;
        }
      }
      entry.refCount--;
    } else {
      entry.refCount--;
    }

    if (entry.refCount <= 0 || entry.subscriptions.size === 0) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
        entry.debounceTimer = null;
      }
      entry.pendingFiles.clear();
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
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
        entry.debounceTimer = null;
      }
      entry.pendingFiles.clear();
      entry.subscriptions.clear();
      try {
        entry.watcher.close();
      } catch {
        // Ignore close error
      }
    }
    this.watchers.clear();
  }
}
