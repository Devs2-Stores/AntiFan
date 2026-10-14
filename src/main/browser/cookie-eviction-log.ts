// Records cookie names and domains only: cookie values (session secrets) must never reach the journal.

export interface CookieEvictionTarget {
  cookies: {
    on: (event: 'changed', listener: (...args: unknown[]) => void) => unknown;
  };
}

export interface CookieEvictionBatch {
  partition: string;
  count: number;
  byDomain: Record<string, string[]>;
  unlisted: number;
}

export type CookieEvictionSink = (batch: CookieEvictionBatch) => void;

export const COOKIE_EVICTION_BATCH_MS = 250;

export const COOKIE_EVICTION_MAX_NAMES = 200;

const evictionArmed = new WeakSet<object>();

export function armCookieEvictionLog(
  target: CookieEvictionTarget | null | undefined,
  partition: string,
  sink: CookieEvictionSink,
  batchMs: number = COOKIE_EVICTION_BATCH_MS
): boolean {
  if (!target || typeof target !== 'object') return false;
  const { cookies } = target;
  if (typeof cookies?.on !== 'function') return false;
  if (evictionArmed.has(target)) return false;
  evictionArmed.add(target);

  let pending: CookieEvictionBatch | null = null;
  let listed = 0;
  let flushTimer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    flushTimer = undefined;
    const batch = pending;
    pending = null;
    listed = 0;
    if (batch) {
      try {
        sink(batch);
      } catch {
        // A diagnostic write must never break the cookie store listener.
      }
    }
  };

  const field = (cookie: unknown, key: 'domain' | 'name'): string => {
    if (!cookie || typeof cookie !== 'object' || !(key in cookie)) return '(unknown)';
    const value: unknown = (cookie as Record<string, unknown>)[key];
    return typeof value === 'string' && value ? value : '(unknown)';
  };

  cookies.on('changed', (...args: unknown[]) => {
    const [, cookie, cause, removed] = args;
    if (cause !== 'evicted' || removed !== true) return;
    if (!pending) {
      pending = { partition, count: 0, byDomain: {}, unlisted: 0 };
      flushTimer = setTimeout(flush, batchMs);
      flushTimer.unref?.();
    }
    pending.count += 1;
    if (listed >= COOKIE_EVICTION_MAX_NAMES) {
      pending.unlisted += 1;
      return;
    }
    (pending.byDomain[field(cookie, 'domain')] ??= []).push(field(cookie, 'name'));
    listed += 1;
  });
  return true;
}
