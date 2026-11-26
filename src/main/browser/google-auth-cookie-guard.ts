// Protects a durable jar's Google session from Chromium cookie-limit purges.
//
// Chromium keeps at most ~180 cookies per registrable domain and purges the
// least-useful ones when a write would cross it. Every `*.google.com`
// subdomain shares one budget with the account session, so a profile jar that
// browses a lot of Google surfaces (gemini, aistudio, one, workspace, mail)
// stays at the cap and every page view triggers another purge. The measured
// sequence escalates `_ga` -> `SIDCC` (observed 188 evictions in ~1 day on
// persist:profile-profile-2, main.log 2026-11-25..26); `SID` sits in the same
// purge bucket, which reads as "Gmail logs itself out".
//
// Two defences, both driven by the `cookies.on('changed')` listener:
//
// 1. Session restore: a sign-in cookie (`SID` family, `SIDCC`/`SIDTS`,
//    `__Secure-*PSID*`, `LSID`, `__Host-GAPS`) removed with cause `evicted` is
//    re-set with the value the store just reported — the page re-fetches it
//    harmlessly anyway, and the eviction stops being a sign-out. An eviction
//    caused by Google itself (`overwrite`, `expired`, `explicit`) is a real
//    sign-out and is never undone.
//
// 2. Analytics pruning: removed cookies are ALSO deleted proactively —
//    `_ga*`, `_gcl_*`, `_gac_*`, `__utm*` on any Google domain are deleted on
//    a debounce, keeping the domain's count away from the 180 cap so Chromium
//    stops purging at all. Only the analytics families are deleted; their
//    absence costs a GA visit distinction, never a session.
//
// A jar that does not touch Google keeps neither: both arms check
// `isGoogleDomain` before acting.

import { buildCookieSetDetails, type CapsuleMigrationCookie, type CookieSetDetails } from './capsule-partition-migration';
import { isGoogleDomain } from './google-auth-identity';

export const GOOGLE_RESTORE_COOLDOWN_MS = 3000;
export const GOOGLE_ANALYTICS_PRUNE_DEBOUNCE_MS = 2000;
/** Re-arm the per-domain prune no sooner than this, so a busy jar does not delete on every change. */
export const GOOGLE_ANALYTICS_PRUNE_PERIOD_MS = 60_000;

export interface GoogleAuthCookieGuardTarget {
  cookies: {
    on: (event: 'changed', listener: (...args: unknown[]) => void) => unknown;
    set: (details: CookieSetDetails) => Promise<void>;
    get?: (filter: { domain?: string }) => Promise<unknown[]>;
    remove?: (url: string, name: string) => Promise<void>;
  };
}

export interface GoogleAuthCookieGuardRecord {
  partition: string;
  action:
    | 'session-restored'
    | 'session-restore-skipped'
    | 'session-restore-failed'
    | 'analytics-pruned'
    | 'analytics-prune-failed';
  domain: string;
  name?: string;
  count?: number;
  reason?: string;
}

export type GoogleAuthCookieGuardSink = (record: GoogleAuthCookieGuardRecord) => void;

export interface GoogleAuthCookieGuardOptions {
  cooldownMs?: number;
  pruneDebounceMs?: number;
  prunePeriodMs?: number;
  now?: () => number;
  /** Injectable for tests; defaults to a live `cookies.get`+`cookies.remove` sweep. */
  pruneAnalytics?: () => Promise<number>;
}

/** Sign-in family: session cookies + the DBS/xsrf satellites that share their purge bucket. */
export function isGoogleSessionCookieName(name: string): boolean {
  if (/^(SID|HSID|SSID|APISID|SAPISID|LSID|SIDCC|SIDTS|LOGIN_INFO|ACCOUNT_CHOOSER)$/.test(name)) return true;
  if (/^__Secure-[13]P(SID|APISID|SIDTS|SIDCC)$/.test(name)) return true;
  if (/^__Host-(GAPS|[13]PLSID|MAIL_SSID)$/.test(name)) return true;
  return false;
}

/** Analytics/ads families safe to drop on Google domains: visit identity only, never auth. */
export function isGoogleAnalyticsCookieName(name: string): boolean {
  return /^(_ga|_gac_|_gcl_|_gat_|_gid$|__utm|AMP_TOKEN|NID$|OTZ$|SOCS$|AEC$|DV$|CONSENT$)/.test(name)
    ? !isGoogleSessionCookieName(name)
    : false;
}

const SAME_SITE: Record<string, true> = { unspecified: true, no_restriction: true, lax: true, strict: true };

const guardArmed = new WeakSet<object>();

function readCookie(raw: unknown): (CapsuleMigrationCookie & { domain: string; path: string }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string' || !c.domain) return null;
  const sameSite = typeof c.sameSite === 'string' && SAME_SITE[c.sameSite]
    ? (c.sameSite as CapsuleMigrationCookie['sameSite'])
    : undefined;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === 'string' && c.path ? c.path : '/',
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    ...(typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {}),
    ...(sameSite ? { sameSite } : {}),
  };
}

export function armGoogleAuthCookieGuard(
  target: GoogleAuthCookieGuardTarget | null | undefined,
  partition: string,
  sink: GoogleAuthCookieGuardSink,
  options: GoogleAuthCookieGuardOptions = {}
): boolean {
  if (!target || typeof target !== 'object') return false;
  const { cookies } = target;
  if (typeof cookies?.on !== 'function' || typeof cookies.set !== 'function') return false;
  if (guardArmed.has(target)) return false;
  guardArmed.add(target);

  const cooldownMs = options.cooldownMs ?? GOOGLE_RESTORE_COOLDOWN_MS;
  const pruneDebounceMs = options.pruneDebounceMs ?? GOOGLE_ANALYTICS_PRUNE_DEBOUNCE_MS;
  const prunePeriodMs = options.prunePeriodMs ?? GOOGLE_ANALYTICS_PRUNE_PERIOD_MS;
  const now = options.now ?? Date.now;
  const lastRestoreAt = new Map<string, number>();

  const emit = (record: GoogleAuthCookieGuardRecord): void => {
    try {
      sink(record);
    } catch {
      // A diagnostic write must never break the cookie store listener.
    }
  };

  // Records carry domain+name only: session secret values must never reach a log.
  const restore = (cookie: CapsuleMigrationCookie & { domain: string; path: string }): void => {
    let pending: Promise<void>;
    try {
      pending = cookies.set(buildCookieSetDetails(cookie));
    } catch (err) {
      emit({ partition, action: 'session-restore-failed', domain: cookie.domain, name: cookie.name, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    pending.then(
      () => emit({ partition, action: 'session-restored', domain: cookie.domain, name: cookie.name }),
      (err: unknown) => emit({ partition, action: 'session-restore-failed', domain: cookie.domain, name: cookie.name, reason: err instanceof Error ? err.message : String(err) })
    );
  };

  const defaultPrune = async (): Promise<number> => {
    if (typeof cookies.get !== 'function' || typeof cookies.remove !== 'function') return 0;
    let removed = 0;
    const domains = ['google.com', 'youtube.com'];
    for (const domain of domains) {
      let list: unknown[];
      try {
        list = await cookies.get({ domain });
      } catch {
        continue;
      }
      for (const raw of list) {
        const cookie = readCookie(raw);
        if (!cookie || !isGoogleAnalyticsCookieName(cookie.name)) continue;
        const host = cookie.domain.replace(/^\./, '');
        const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
        try {
          await cookies.remove(url, cookie.name);
          removed += 1;
        } catch {
          // One failed delete must not stop the sweep.
        }
      }
    }
    return removed;
  };

  let pruneTimer: NodeJS.Timeout | undefined;
  let lastPruneAt = 0;
  const schedulePrune = (): void => {
    if (pruneTimer) return;
    if (now() - lastPruneAt < prunePeriodMs) return;
    pruneTimer = setTimeout(() => {
      pruneTimer = undefined;
      const run = options.pruneAnalytics ?? defaultPrune;
      lastPruneAt = now();
      Promise.resolve()
        .then(run)
        .then((count) => {
          if (count > 0) emit({ partition, action: 'analytics-pruned', domain: 'google.com', count });
        })
        .catch((err: unknown) => emit({ partition, action: 'analytics-prune-failed', domain: 'google.com', reason: err instanceof Error ? err.message : String(err) }));
    }, pruneDebounceMs);
    pruneTimer.unref?.();
  };

  cookies.on('changed', (...args: unknown[]) => {
    const [, raw, cause, removed] = args;
    const cookie = readCookie(raw);
    if (!cookie || !isGoogleDomain(cookie.domain)) return;

    // Any Google-domain write is a chance to drop analytics before the next purge.
    if (removed === false && isGoogleAnalyticsCookieName(cookie.name)) schedulePrune();

    if (removed !== true || cause !== 'evicted' || !isGoogleSessionCookieName(cookie.name)) return;
    const at = now();
    if (typeof cookie.expirationDate === 'number' && cookie.expirationDate * 1000 <= at) {
      emit({ partition, action: 'session-restore-skipped', domain: cookie.domain, name: cookie.name, reason: 'expired' });
      return;
    }
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    const last = lastRestoreAt.get(key);
    if (last !== undefined && at - last < cooldownMs) {
      emit({ partition, action: 'session-restore-skipped', domain: cookie.domain, name: cookie.name, reason: 'cooldown' });
      return;
    }
    lastRestoreAt.set(key, at);
    restore(cookie);
    schedulePrune();
  });
  return true;
}
