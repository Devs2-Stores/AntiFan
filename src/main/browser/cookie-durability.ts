/**
 * Durable cookie commits.
 *
 * Chromium batches cookie writes (a timer plus an operation count) and commits
 * whatever is still in memory only on a graceful quit. A page-set cookie —
 * including an OAuth rotation — therefore survives a clean exit but is lost to
 * a crash or a hard kill, which is exactly what "the session expires very
 * fast, sometimes it holds and sometimes it does not" looks like from outside.
 *
 * The fix is a trailing-edge debounce on every durable (`persist:`) jar: the
 * first change arms a timer, further changes extend it, and one
 * `cookies.flushStore()` commits the whole burst once the page stops mutating
 * cookies. A jar that never goes quiet (analytics cookies rewritten every few
 * hundred milliseconds, cap evictions on a full jar) would push that commit
 * back forever, so a burst is also committed at most `maxWaitMs` after its
 * first change. Worst-case loss is one max-wait window instead of a session.
 *
 * Deliberately Electron-free: the contract is the two cookie-store methods the
 * debounce actually calls, so the policy is unit-testable with a plain double.
 */

export interface CookieDurabilityTarget {
  cookies: {
    on: (event: 'changed', listener: (...args: any[]) => void) => unknown;
    flushStore: () => Promise<void>;
  };
}

/**
 * Trailing-edge window. Sized against the failure it prevents: a page-set or
 * rotated cookie should reach SQLite within a second of the page going quiet,
 * while a burst (a login redirect setting a dozen cookies) still collapses into
 * a single commit rather than one write per mutation.
 */
export const COOKIE_FLUSH_DEBOUNCE_MS = 1000;

/** Longest a change may wait for its commit while the jar keeps changing. */
export const COOKIE_FLUSH_MAX_WAIT_MS = 5000;

/** Sessions already armed (attach exactly once per session). */
const durabilityArmed = new WeakSet<object>();

/**
 * Arms the debounced commit on one cookie store. Returns whether the listener
 * was attached: a store without `cookies.on`/`cookies.flushStore` (a partial
 * double, or a session type that cannot persist) is left alone rather than
 * throwing.
 */
export function armCookieDurability(
  target: CookieDurabilityTarget | null | undefined,
  debounceMs: number = COOKIE_FLUSH_DEBOUNCE_MS,
  maxWaitMs: number = COOKIE_FLUSH_MAX_WAIT_MS
): boolean {
  if (!target || typeof target !== 'object') return false;
  const { cookies } = target;
  if (typeof cookies?.on !== 'function' || typeof cookies.flushStore !== 'function') return false;
  if (durabilityArmed.has(target)) return false;
  durabilityArmed.add(target);
  let quietTimer: NodeJS.Timeout | undefined;
  let maxWaitTimer: NodeJS.Timeout | undefined;
  const commit = (): void => {
    clearTimeout(quietTimer);
    clearTimeout(maxWaitTimer);
    quietTimer = undefined;
    maxWaitTimer = undefined;
    cookies.flushStore().catch(() => {});
  };
  cookies.on('changed', () => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(commit, debounceMs);
    quietTimer.unref?.();
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(commit, maxWaitMs);
      maxWaitTimer.unref?.();
    }
  });
  return true;
}
