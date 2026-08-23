/**
 * AntiFan Browser Desktop — Universal Persistent Cookie & Session Manager
 * Retains all user authentication, session cookies, and storefront tokens across app restarts.
 * Handles localhost, 127.0.0.1 (9Router, local dashboards), Haravan, Sapo, Shopify, and web apps.
 */
import { session, Cookie, CookiesSetDetails } from 'electron';
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

export class CookiePersister {
  private static instance: CookiePersister;
  private cachePath: string;
  private isSaving = false;
  private saveDebounceTimer: NodeJS.Timeout | undefined = undefined;

  private constructor() {
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

  public async restoreCookies(): Promise<number> {
    if (!fs.existsSync(this.cachePath)) return 0;
    try {
      const raw = fs.readFileSync(this.cachePath, 'utf8');
      const cookies: Cookie[] = JSON.parse(raw);
      if (!Array.isArray(cookies)) return 0;
      let count = 0;

      const oneYearAhead = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);

      for (const c of cookies) {
        if (!shouldPersistCookie(c)) continue;
        try {
          const scheme = c.secure ? 'https://' : 'http://';
          let domain = c.domain?.startsWith('.') ? c.domain.substring(1) : (c.domain || 'localhost');
          if (!domain) domain = 'localhost';
          const url = `${scheme}${domain}${c.path || '/'}`;

          const sameSiteValue: CookiesSetDetails['sameSite'] =
            c.sameSite === 'strict' || c.sameSite === 'lax' || c.sameSite === 'no_restriction'
              ? c.sameSite
              : 'unspecified';

          const cookieDetails: CookiesSetDetails = {
            url,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: Boolean(c.secure),
            httpOnly: Boolean(c.httpOnly),
            sameSite: sameSiteValue,
            expirationDate: c.expirationDate && c.expirationDate > Date.now() / 1000
              ? c.expirationDate
              : oneYearAhead,
          };

          await session.defaultSession.cookies.set(cookieDetails);
          count++;
        } catch {}
      }

      await session.defaultSession.cookies.flushStore();
      return count;
    } catch (err) {
      console.error('[CookiePersister] Failed to restore cookies:', err);
      return 0;
    }
  }

  public async saveAllCookies(): Promise<number> {
    if (this.isSaving) return 0;
    this.isSaving = true;
    try {
      const cookies = await session.defaultSession.cookies.get({});
      const eligible = cookies.filter((c) => shouldPersistCookie(c));
      const oneYearAhead = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);

      const processed = eligible.map((c) => ({
        ...c,
        expirationDate: c.expirationDate && c.expirationDate > Date.now() / 1000
          ? c.expirationDate
          : oneYearAhead,
      }));

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
