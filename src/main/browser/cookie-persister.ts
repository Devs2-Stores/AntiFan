/**
 * AntiFan Browser Desktop — Persistent Cookie & Session Store Manager
 * Automatically retains session cookies (Storefront Passwords, Haravan, Shopify, Google auth)
 * across app restarts, tab reloads, and system resets.
 */
import { session, Cookie } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export class CookiePersister {
  private static instance: CookiePersister;
  private cachePath: string;
  private isSaving = false;

  private constructor() {
    const dir = path.join(process.cwd(), 'appdata', 'antigravity-browser-desktop', 'state', 'v1');
    fs.mkdirSync(dir, { recursive: true });
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
      let count = 0;

      for (const c of cookies) {
        try {
          const scheme = c.secure ? 'https://' : 'http://';
          const domain = c.domain?.startsWith('.') ? c.domain.substring(1) : (c.domain || 'localhost');
          const url = `${scheme}${domain}${c.path || '/'}`;

          // Extend expiration date for session cookies to 1 year
          const expirationDate = c.expirationDate && c.expirationDate > Date.now() / 1000
            ? c.expirationDate
            : Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);

          await session.defaultSession.cookies.set({
            url,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: (c.sameSite as any) || 'unspecified',
            expirationDate,
          });
          count++;
        } catch {}
      }

      await session.defaultSession.cookies.flushStore();
      console.log(`[CookiePersister] Restored ${count} persistent cookies.`);
      return count;
    } catch (err) {
      console.error('[CookiePersister] Failed to restore cookies:', err);
      return 0;
    }
  }

  public startAutoPersistence(): void {
    const saveAll = async () => {
      if (this.isSaving) return;
      this.isSaving = true;
      try {
        const cookies = await session.defaultSession.cookies.get({});
        const processed = cookies.map((c) => ({
          ...c,
          expirationDate: c.expirationDate && c.expirationDate > Date.now() / 1000
            ? c.expirationDate
            : Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60),
        }));

        fs.writeFileSync(this.cachePath, JSON.stringify(processed, null, 2), 'utf8');
        await session.defaultSession.cookies.flushStore();
      } catch (err) {
        console.warn('[CookiePersister] Save note:', err);
      } finally {
        this.isSaving = false;
      }
    };

    session.defaultSession.cookies.on('changed', (_event, _cookie, _cause, removed) => {
      if (!removed) {
        setTimeout(saveAll, 500);
      }
    });

    setInterval(saveAll, 30000);
  }
}
