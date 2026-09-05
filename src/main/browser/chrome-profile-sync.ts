/**
 * AntiFan Browser Desktop — Chrome Profile & Bookmark Sync
 * Provides Chrome profile & bookmark integration (read-only, local-first).
 * Cookie hydration is handled securely via LocalSessionVault / CDP.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { LocalSessionVault } from './local-session-vault';
export interface ChromeProfileInfo {
  id: string; // 'Default', 'Profile 1', etc.
  name: string; // 'Personal', 'Work', etc.
  avatar?: string;
  path: string;
  active?: boolean;
}

export interface DecryptedCookieRecord {
  domain: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

/**
 * Builds the cookies.set() payload for one decrypted Chrome cookie.
 *
 * Chrome's SQLite host_key distinguishes host-only cookies (bare host, no
 * leading dot) from domain cookies (leading dot). A host-only cookie — and
 * every `__Host-` prefixed cookie per RFC 6265bis — must be set without a
 * Domain attribute, or Chromium rejects the set call and the cookie silently
 * never imports. sameSite is mapped from SQLite's numeric flags; level 0 is
 * only treated as no_restriction when the cookie is secure, matching Chrome's
 * own session-restore behavior.
 */
export function cookieImportSetDetails(
  name: string,
  host: string,
  value: string,
  path: string,
  secure: boolean,
  httpOnly: boolean,
  samesite: number,
  expires?: number,
  options?: { persistSessionCookies?: boolean; sessionTtlSeconds?: number }
): Electron.CookiesSetDetails | null {
  const scheme = secure ? 'https://' : 'http://';
  const domain = host.startsWith('.') ? host.substring(1) : host;
  const cookieUrl = `${scheme}${domain}${path || '/'}`;

  let sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict' = 'unspecified';
  if (samesite === 1) sameSite = 'lax';
  else if (samesite === 2) sameSite = 'strict';
  else if (samesite === 0 && secure) sameSite = 'no_restriction';

  const details: Electron.CookiesSetDetails = {
    url: cookieUrl,
    name,
    value,
    path: path || '/',
    secure,
    httpOnly,
    sameSite,
  };
  // Host-only cookies (bare host_key, and `__Host-` prefix by RFC 6265bis)
  // must not carry a Domain attribute or Chromium rejects the set call.
  if (host.startsWith('.') && !name.startsWith('__Host-')) {
    details.domain = host;
  }

  // Chromium SQLite stores expires_utc in microseconds since Jan 1, 1601 (Windows epoch)
  if (typeof expires === 'number' && expires > 0) {
    if (expires > 11644473600000000) {
      const unixSeconds = Math.floor((expires - 11644473600000000) / 1000000);
      if (unixSeconds <= Math.floor(Date.now() / 1000)) {
        // Expired persistent cookie: return null so caller skips it rather than reviving it as a session cookie
        return null;
      }
      details.expirationDate = unixSeconds;
    }
  } else if (options?.persistSessionCookies) {
    const ttl = options.sessionTtlSeconds ?? 30 * 24 * 60 * 60;
    details.expirationDate = Math.floor(Date.now() / 1000) + ttl;
  }

  return details;
}

export interface ExtensionCookieInput {
  name: string;
  value: string;
  domain?: string;
  host?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict' | string;
  expirationDate?: number;
  persistSession?: boolean;
}

export const DEFAULT_PERSISTENT_SESSION_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface ExtensionCookieImportOptions {
  /**
   * When true, session cookies without an explicit expiration date are assigned
   * a durable expirationDate (default: 30 days) so Electron commits them to disk SQLite
   * instead of dropping them from volatile RAM upon browser exit or restart.
   */
  persistSessionCookies?: boolean;
  /** Custom TTL in seconds for persisted session cookies (defaults to 30 days) */
  sessionTtlSeconds?: number;
}

/**
 * Builds the cookies.set() payload for a cookie exported from a Chrome Extension (chrome.cookies API).
 * Handles Unix epoch seconds for expirationDate, RFC 6265bis __Host- constraints, and sameSite mappings.
 */
export function extensionCookieImportSetDetails(
  cookie: ExtensionCookieInput,
  options?: ExtensionCookieImportOptions
): Electron.CookiesSetDetails | null {
  if (!cookie || !cookie.name || cookie.value === undefined || cookie.value === null) {
    return null;
  }

  const host = cookie.domain || cookie.host || '';
  if (!host) return null;

  const secure = Boolean(cookie.secure);
  const scheme = secure ? 'https://' : 'http://';
  const domain = host.startsWith('.') ? host.substring(1) : host;
  const cookiePath = cookie.path || '/';
  const cookieUrl = `${scheme}${domain}${cookiePath}`;

  let sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict' = 'unspecified';
  if (cookie.sameSite === 'lax') sameSite = 'lax';
  else if (cookie.sameSite === 'strict') sameSite = 'strict';
  else if (cookie.sameSite === 'no_restriction') sameSite = 'no_restriction';
  else sameSite = 'unspecified';

  const details: Electron.CookiesSetDetails = {
    url: cookieUrl,
    name: cookie.name,
    value: cookie.value,
    path: cookiePath,
    secure,
    httpOnly: Boolean(cookie.httpOnly),
    sameSite,
  };

  if (host.startsWith('.') && !cookie.name.startsWith('__Host-')) {
    details.domain = host;
  }

  // Chrome Extension expirationDate is in Unix epoch seconds (float or integer)
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0) {
    const unixSeconds = Math.floor(cookie.expirationDate);
    if (unixSeconds <= nowSeconds) {
      // Expired cookie: skip it
      return null;
    }
    details.expirationDate = unixSeconds;
  } else if (options?.persistSessionCookies || cookie.persistSession) {
    // Elevate volatile in-memory session cookie to persistent cookie so login survives restart
    const ttl = options?.sessionTtlSeconds ?? DEFAULT_PERSISTENT_SESSION_COOKIE_TTL_SECONDS;
    details.expirationDate = nowSeconds + ttl;
  }

  return details;
}

export class ChromeProfileSyncManager {
  private static instance: ChromeProfileSyncManager;
  private chromeUserDataPath: string;
  public activeProfileId: string = 'Default';
  private cachedProfiles: ChromeProfileInfo[] | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 5000;

  private constructor() {
    this.chromeUserDataPath = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Google',
      'Chrome',
      'User Data'
    );
  }

  public static getInstance(): ChromeProfileSyncManager {
    if (!ChromeProfileSyncManager.instance) {
      ChromeProfileSyncManager.instance = new ChromeProfileSyncManager();
    }
    return ChromeProfileSyncManager.instance;
  }

  public getActiveProfile(): ChromeProfileInfo | undefined {
    const profiles = this.getAvailableProfiles();
    return profiles.find((p) => p.id === this.activeProfileId) || profiles[0];
  }

  /**
   * Get all detected Google Chrome Profiles on the user's computer
   */
  public getAvailableProfiles(forceRefresh = false): ChromeProfileInfo[] {
    const now = Date.now();
    if (!forceRefresh && this.cachedProfiles && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cachedProfiles;
    }

    const localStatePath = path.join(this.chromeUserDataPath, 'Local State');
    if (!fs.existsSync(localStatePath)) {
      this.cachedProfiles = [];
      this.cacheTimestamp = now;
      return [];
    }

    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      const infoCache = localState.profile?.info_cache || {};
      const profiles: ChromeProfileInfo[] = [];

      for (const [id, info] of Object.entries(infoCache)) {
        const pInfo = info as any;
        profiles.push({
          id,
          name: pInfo.name || id,
          avatar: pInfo.avatar_icon,
          path: path.join(this.chromeUserDataPath, id),
          active: id === this.activeProfileId,
        });
      }

      if (profiles.length === 0 && fs.existsSync(path.join(this.chromeUserDataPath, 'Default'))) {
        profiles.push({
          id: 'Default',
          name: 'Default Profile',
          path: path.join(this.chromeUserDataPath, 'Default'),
          active: true,
        });
      }

      this.cachedProfiles = profiles;
      this.cacheTimestamp = now;
      return profiles;
    } catch (err) {
      console.error('[ChromeProfileSync] Failed to read Chrome profiles:', err);
      return this.cachedProfiles || [];
    }
  }

  public invalidateCache(): void {
    this.cachedProfiles = null;
    this.cacheTimestamp = 0;
  }

  /** True when the named profile directory exists on disk (fail-closed partition routing). */
  public hasProfile(profileId: string): boolean {
    return fs.existsSync(path.join(this.chromeUserDataPath, profileId));
  }

  /**
   * Reads Bookmarks from selected Chrome profile
   */
  public getChromeBookmarks(profileId = 'Default'): Array<{ title: string; url: string }> {
    const bookmarksPath = path.join(this.chromeUserDataPath, profileId, 'Bookmarks');
    if (!fs.existsSync(bookmarksPath)) return [];

    try {
      const data = JSON.parse(fs.readFileSync(bookmarksPath, 'utf8'));
      const result: Array<{ title: string; url: string }> = [];

      const traverse = (node: any) => {
        if (!node) return;
        if (node.type === 'url' && node.url && node.name) {
          result.push({ title: node.name, url: node.url });
        }
        if (node.children && Array.isArray(node.children)) {
          node.children.forEach(traverse);
        }
      };

      if (data.roots) {
        traverse(data.roots.bookmark_bar);
        traverse(data.roots.other);
        traverse(data.roots.synced);
      }

      return result;
    } catch (err) {
      console.error('[ChromeProfileSync] Failed to read Chrome bookmarks:', err);
      return [];
    }
  }
  /**
   * Discovers the Google Chrome executable path on the host system
   */
  public getChromeExecutablePath(): string | null {
    const candidates = [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  /**
   * Checks if Chrome is actively running on the machine
   */
  public isChromeRunning(): boolean {
    if (process.platform === 'win32') {
      try {
        const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.toLowerCase().includes('chrome.exe');
      } catch {
        return false;
      }
    }
    return false;
  }


  /**
   * Copies just enough of a Chrome profile for a one-shot cookie pull into an
   * owned temp user-data-dir: the profile's Network cookie store (LevelDB) and
   * the user-data-dir's Local State (where App-Bound Encryption keys live).
   * The real profile is never opened for writing, so a running Chrome cannot
   * race us — but we still refuse to run while Chrome is open (see caller).
   * NOTE: cookie rows only exist on disk if Chrome was shut down normally;
   * a hard-killed Chrome never gets to flush its cookie store.
   */
  private cloneMinimalProfile(profileId: string, profilePath: string, tempDir: string): void {
    const localStateSrc = path.join(this.chromeUserDataPath, 'Local State');
    if (fs.existsSync(localStateSrc)) {
      fs.copyFileSync(localStateSrc, path.join(tempDir, 'Local State'));
    }
    const networkSrc = path.join(profilePath, 'Network');
    if (fs.existsSync(networkSrc)) {
      fs.cpSync(networkSrc, path.join(tempDir, profileId, 'Network'), { recursive: true });
    }
  }
  /**
   * Waits for Chrome (launched with --remote-debugging-port=0) to write its
   * DevToolsActivePort file in the owned user-data-dir. Returns the OS-assigned
   * ephemeral port, or null on timeout. NOTE: callers must remove any stale
   * DevToolsActivePort BEFORE spawning — an old file from a previous launch
   * would be read before the new Chrome overwrites it.
   */
  private async waitForDevToolsPort(tempDir: string, timeoutMs: number): Promise<number | null> {
    const devtoolsFile = path.join(tempDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(devtoolsFile, 'utf8');
        const port = Number.parseInt((raw.split(/\r?\n/)[0] || '').trim(), 10);
        if (Number.isInteger(port) && port > 0) return port;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  /**
   * Confirms the DevTools HTTP endpoint actually answers before the CDP WS
   * import (DevToolsActivePort is written at bind time; this guards against
   * races and stale-file reads). Bounded retries, then false.
   */
  private async probeCdpReachable(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 600 }, (res) => {
          res.resume();
          res.on('end', () => resolve(true));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }
  /**
   * Terminates the owned Chrome process tree. Only ever called on processes
   * this class spawned — never on the user's running Chrome.
   */
  private killOwnedChrome(child: ChildProcess | null): void {
    if (!child || child.pid === undefined || child.pid <= 0) return;
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {}
    } else {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
  /**
   * One-shot cookie hydration with an app-owned headless Chrome:
   *  1. refuse while the user's Chrome is running (never touch a live profile),
   *  2. clone the minimal profile into a temp user-data-dir,
   *  3. launch `--headless=new --remote-debugging-port=0` (OS-assigned port),
   *  4. pull cookies once via CDP, kill Chrome, remove the temp dir.
   * Fully local & independent: no extension, no fixed port, no leftover process.
   */
  private async hydrateCookiesViaOwnedChrome(
    profileId: string,
    profilePath: string,
    targetSession: Electron.Session
  ): Promise<{ count: number; message: string }> {
    if (this.isChromeRunning()) {
      return { count: 0, message: 'Chrome đang chạy — app không đụng profile đang mở. Hãy đóng hẳn Chrome rồi đồng bộ lại.' };
    }
    const chromeExe = this.getChromeExecutablePath();
    if (!chromeExe) {
      return { count: 0, message: 'Không tìm thấy Google Chrome trên máy tính.' };
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cdp-'));
    let child: ChildProcess | null = null;
    try {
      this.cloneMinimalProfile(profileId, profilePath, tempDir);
      // Remove any stale DevToolsActivePort BEFORE spawn: a leftover file from
      // a previous launch would be read before the new Chrome overwrites it.
      try {
        fs.rmSync(path.join(tempDir, 'DevToolsActivePort'), { force: true });
      } catch {}
      child = spawn(
        chromeExe,
        [
          '--headless=new',
          `--user-data-dir=${tempDir}`,
          '--remote-debugging-port=0',
          '--remote-debugging-address=127.0.0.1',
          `--profile-directory=${profileId}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--mute-audio',
          'about:blank',
        ],
        { stdio: 'ignore', windowsHide: true }
      );
      if (child.exitCode !== null) {
        return { count: 0, message: 'Chrome headless thoát sớm trước khi mở cổng CDP.' };
      }
      const port = await this.waitForDevToolsPort(tempDir, 15000);
      if (port === null) {
        return { count: 0, message: 'Chrome headless không mở được cổng CDP (hết thời gian chờ).' };
      }
      // DevToolsActivePort can predate the HTTP bind — confirm real readiness.
      const reachable = await this.probeCdpReachable(port, 6000);
      if (!reachable) {
        return { count: 0, message: 'Chrome headless CDP không phản hồi (hết thời gian chờ).' };
      }
      const res = await LocalSessionVault.getInstance().importFromLiveChromeCDP(targetSession, port);
      if (!res.success) {
        return { count: 0, message: res.message };
      }
      return { count: res.count, message: '' };
    } catch (err: unknown) {
      return { count: 0, message: `Lỗi hút cookies qua CDP: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      // Deterministic teardown — no untracked timers: kill the process tree,
      // wait for the child to actually exit, then retry-remove the temp dir.
      this.killOwnedChrome(child);
      if (child && child.exitCode === null) {
        try {
          await new Promise<void>((resolve) => {
            const guard = setTimeout(resolve, 2000);
            child!.once('exit', () => {
              clearTimeout(guard);
              resolve();
            });
          });
        } catch {}
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
  }

  /**
   * Synchronizes a Chrome profile: imports bookmarks (read-only) and hydrates
   * cookies once via an app-owned headless Chrome clone — fully extension-free,
   * local-first & independent of any Chrome the user keeps open.
   */
  public async syncProfile(profileId = 'Default', targetSession?: Electron.Session): Promise<{
    success: boolean;
    cookiesCount: number;
    bookmarksCount: number;
    hasLiveCookies: boolean;
    message: string;
  }> {
    const profilePath = path.join(this.chromeUserDataPath, profileId);

    // Fail fast BEFORE any CDP work and BEFORE mutating the active profile:
    // a missing profile must never change activeProfileId or create a partition.
    if (!this.hasProfile(profileId)) {
      return { success: false, cookiesCount: 0, bookmarksCount: 0, hasLiveCookies: false, message: `Profile '${profileId}' not found.` };
    }
    this.activeProfileId = profileId;

    // 1. Bookmarks — read-only import from Chrome's Bookmarks JSON
    const bookmarks = this.getChromeBookmarks(profileId);

    // 2. One-shot cookie hydration via owned headless Chrome (profile-bound)
    let cookiesCount = 0;
    let cdpNote = '';
    if (targetSession && targetSession.cookies) {
      try {
        const cdp = await this.hydrateCookiesViaOwnedChrome(profileId, profilePath, targetSession);
        if (cdp.count > 0) {
          try {
            const liveCookies = await targetSession.cookies.get({});
            cookiesCount = liveCookies.length;
          } catch {
            cookiesCount = cdp.count;
          }
        }
        if (cdp.message) {
          cdpNote = ` ${cdp.message}`;
        }
      } catch (err: unknown) {
        cdpNote = ` Lỗi hút cookies qua CDP: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return {
      success: true,
      cookiesCount,
      bookmarksCount: bookmarks.length,
      hasLiveCookies: cookiesCount > 0,
      message: `Đã nạp ${bookmarks.length} dấu trang từ Chrome Profile '${profileId}'.${cdpNote}`,
    };
  }
}
