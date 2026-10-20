// Records Google session cookie names, domains, causes and timings only: cookie values (session
// secrets) must never reach the journal.
//
// Purpose: tell apart the two ways a profile ends up signed out of Google. A local loss shows as
// the session cookies missing from the `present` record written when the jar is armed at boot, or
// as an `explicit`/`evicted` removal. A sign-out decided by Google shows as the cookies still
// present at boot, followed by Google rewriting or expiring them (`overwrite`, `expired-overwrite`).

import { isGoogleDomain } from './google-auth-identity';

export interface GoogleAuthCookieTarget {
  cookies: {
    on: (event: 'changed', listener: (...args: unknown[]) => void) => unknown;
    get: (filter: { domain?: string }) => Promise<Array<{ name?: unknown; domain?: unknown }>>;
  };
}

export interface GoogleAuthCookieChange {
  domain: string;
  name: string;
  cause: string;
  removed: boolean;
}

export type GoogleAuthCookieRecord =
  | { kind: 'present'; partition: string; cookies: string[] }
  | { kind: 'changed'; partition: string; changes: GoogleAuthCookieChange[] };

export type GoogleAuthCookieSink = (record: GoogleAuthCookieRecord) => void;

/** The account session (`SID` family) and its rotated freshness tokens (`__Secure-*PSIDTS`). */
export const GOOGLE_SESSION_COOKIE_NAMES: Readonly<Record<string, true>> = {
  SID: true,
  HSID: true,
  SSID: true,
  APISID: true,
  SAPISID: true,
  LOGIN_INFO: true,
  '__Secure-1PSID': true,
  '__Secure-3PSID': true,
  '__Secure-1PAPISID': true,
  '__Secure-3PAPISID': true,
  '__Secure-1PSIDTS': true,
  '__Secure-3PSIDTS': true,
};

export const GOOGLE_AUTH_COOKIE_BATCH_MS = 250;

const googleAuthLogArmed = new WeakSet<object>();

function sessionCookie(cookie: unknown): { domain: string; name: string } | null {
  if (!cookie || typeof cookie !== 'object') return null;
  const { domain, name } = cookie as { domain?: unknown; name?: unknown };
  if (typeof name !== 'string' || typeof domain !== 'string') return null;
  if (!Object.hasOwn(GOOGLE_SESSION_COOKIE_NAMES, name) || !isGoogleDomain(domain)) return null;
  return { domain, name };
}

function emit(sink: GoogleAuthCookieSink, record: GoogleAuthCookieRecord): void {
  try {
    sink(record);
  } catch {
    // A diagnostic write must never break the cookie store listener.
  }
}

export function armGoogleAuthCookieLog(
  target: GoogleAuthCookieTarget | null | undefined,
  partition: string,
  sink: GoogleAuthCookieSink,
  batchMs: number = GOOGLE_AUTH_COOKIE_BATCH_MS
): boolean {
  if (!target || typeof target !== 'object') return false;
  const { cookies } = target;
  if (typeof cookies?.on !== 'function' || typeof cookies.get !== 'function') return false;
  if (googleAuthLogArmed.has(target)) return false;
  googleAuthLogArmed.add(target);

  let pending: GoogleAuthCookieChange[] | null = null;
  cookies.on('changed', (...args: unknown[]) => {
    const [, cookie, cause, removed] = args;
    const match = sessionCookie(cookie);
    if (!match) return;
    if (!pending) {
      pending = [];
      const timer = setTimeout(() => {
        const changes = pending ?? [];
        pending = null;
        emit(sink, { kind: 'changed', partition, changes });
      }, batchMs);
      timer.unref?.();
    }
    pending.push({ ...match, cause: typeof cause === 'string' ? cause : '(unknown)', removed: removed === true });
  });

  // What the jar loaded from disk, before any page of this run has touched it.
  Promise.all([cookies.get({ domain: 'google.com' }), cookies.get({ domain: 'youtube.com' })])
    .then((lists) => {
      const found = new Set<string>();
      for (const cookie of lists.flat()) {
        const match = sessionCookie(cookie);
        if (match) found.add(`${match.domain} ${match.name}`);
      }
      emit(sink, { kind: 'present', partition, cookies: [...found].sort() });
    })
    .catch(() => {});
  return true;
}
