/**
 * AntiFan Browser Desktop — Universal Persistent Cookie & Session Manager
 * Retains all user authentication, session cookies, and storefront tokens across app restarts.
 * Handles localhost, 127.0.0.1 (9Router, local dashboards), Haravan, Sapo, Shopify, and web apps.
 */
import { session, Cookie, CookiesSetDetails, Session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

function shouldPersistCookie(c: Cookie): boolean {
  if (!c || !c.name) return false;
  const domain = (c.domain || '').toLowerCase().replace(/^\./, '');
  // Skip short-lived Google OAuth handshake internal cookies that require fresh exchange
  if (domain.includes('accounts.google.com') && c.name.startsWith('__Host-GAPS')) {
    return false;
  }
  return true;
}

/**
 * Normalizes one live cookie into its persisted cache shape.
 *
 * Session cookies must stay session-scoped in the cache — writing a +1-year
 * expiry rewrites them into persistent cookies at restore time, which Google's
 * integrity checks treat as tampered state. Expired persistent cookies are
 * refreshed to a live +1-year horizon instead of being persisted dead.
 */
export function preparePersistableCookie(c: Cookie): Cookie {
  const oneYearAhead = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
  return {
    ...c,
    expirationDate: c.session === true ? undefined : (c.expirationDate && c.expirationDate > Date.now() / 1000
      ? c.expirationDate
      : oneYearAhead),
  };
}

/**
 * Reads and parses the persisted cache file. Returns null when the file is
 * missing, malformed, or holds non-array data so callers can treat "nothing
 * to restore" and "corrupt cache" distinctly.
 */
export function readCookieCache(cachePath: string): Cookie[] | null {
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error('[CookiePersister] Failed to read cookie cache:', err);
    return null;
  }
}

/**
 * Builds the cookies.set() payload for restoring one persisted cookie.
 *
 * RFC 6265bis: a `__Host-` prefixed cookie MUST be host-only — passing a
 * Domain attribute makes Chromium reject the set call outright. Host-only
 * cookies generally must be restored without a Domain attribute, or the
 * same-name cookie silently turns into a domain cookie (duplicate records,
 * shadowed values). Session cookies must be restored without a forced
 * expirationDate, or session-bound auth tokens become +1-year persistent
 * cookies that Google's integrity checks reject.
 */
export function buildRestoreDetails(c: Cookie): CookiesSetDetails {
  const scheme = c.secure ? 'https://' : 'http://';
  const domain = c.domain?.startsWith('.') ? c.domain.substring(1) : (c.domain || 'localhost');
  const url = `${scheme}${domain}${c.path || '/'}`;

  const sameSiteValue: CookiesSetDetails['sameSite'] =
    c.sameSite === 'strict' || c.sameSite === 'lax' || c.sameSite === 'no_restriction'
      ? c.sameSite
      : 'unspecified';

  const details: CookiesSetDetails = {
    url,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite: sameSiteValue,
  };

  const mustBeHostOnly = c.name.startsWith('__Host-') || c.hostOnly === true || !c.domain;
  if (!mustBeHostOnly) {
    details.domain = c.domain;
  }

  const hasLiveExpiry = typeof c.expirationDate === 'number' && c.expirationDate > Date.now() / 1000;
  if (c.session === true) {
    // Session cookies stay session-scoped; do not rewrite them to +1 year.
  } else {
    details.expirationDate = hasLiveExpiry
      ? c.expirationDate
      : Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
  }
  return details;
}

export class CookiePersister {
  private static instance: CookiePersister;
  private cachePath: string;
  private isSaving = false;
  private saveDebounceTimer: NodeJS.Timeout | undefined = undefined;

  private constructor(cachePath?: string) {
    // Injectable for tests; production uses the default state cache.
    if (cachePath) {
      this.cachePath = cachePath;
      return;
    }
    const dir = path.join(process.cwd(), 'appdata', 'antifan-browser-desktop', 'state', 'v1');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    this.cachePath = path.join(dir, 'cookies_cache.json');
  }

  public static getInstance(): CookiePersister {
    if (!CookiePersister.instance) {
      CookiePersister.instance = new CookiePersister();
    }
    return CookiePersister.instance;
  }

  public async restoreCookies(targetSession?: Session, cookiesOverride?: Cookie[] | null): Promise<number> {
    const ses = targetSession || session.defaultSession;
    const cookies = Array.isArray(cookiesOverride)
      ? cookiesOverride
      : readCookieCache(this.cachePath);
    if (!cookies) return 0;

    let count = 0;
    let rejected = 0;
    for (const c of cookies) {
      if (!shouldPersistCookie(c)) continue;
      try {
        await ses.cookies.set(buildRestoreDetails(c));
        count++;
      } catch (err) {
        rejected++;
        console.warn(`[CookiePersister] Rejected restore for ${c.name} @ ${c.domain}:`, err);
      }
    }

    try {
      await ses.cookies.flushStore();
    } catch (err) {
      console.error('[CookiePersister] Failed to flush restored cookies:', err);
    }
    if (rejected > 0) {
      console.warn(`[CookiePersister] ${rejected} cookie(s) failed to restore and were skipped.`);
    }
    return count;
  }

  public async saveAllCookies(): Promise<number> {
    if (this.isSaving) return 0;
    this.isSaving = true;
    try {
      const cookies = await session.defaultSession.cookies.get({});
      const eligible = cookies.filter((c) => shouldPersistCookie(c));

      const processed = eligible.map((c) => preparePersistableCookie(c));

      fs.writeFileSync(this.cachePath, JSON.stringify(processed, null, 2), 'utf8');
      await session.defaultSession.cookies.flushStore();
      return processed.length;
    } catch (err) {
      console.warn('[CookiePersister] Save note:', err);
      return 0;
    } finally {
      this.isSaving = false;
    }
  }

  public startAutoPersistence(): void {
    const triggerSave = () => {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = setTimeout(() => {
        this.saveAllCookies().catch(() => {});
      }, 1000);
    };

    session.defaultSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (!removed && shouldPersistCookie(cookie)) {
        triggerSave();
      }
    });

    // Periodic auto-save every 30 seconds
    setInterval(() => {
      this.saveAllCookies().catch(() => {});
    }, 30000);
  }
}