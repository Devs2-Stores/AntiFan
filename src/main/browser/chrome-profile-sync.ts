/**
 * AntiFan Browser Desktop — Chrome Profile & Bookmark Sync
 * Provides Chrome profile & bookmark integration (read-only, local-first).
 * Cookie hydration is handled securely via LocalSessionVault / CDP.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
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
   * Launches Google Chrome with remote debugging port enabled (for live CDP cookie extraction).
   * Extension-free: cookies are pulled later via CDP Network.getAllCookies (LocalSessionVault).
   */
  public launchChromeWithCdp(port = 9222, profileId?: string): { success: boolean; message: string; isRunning?: boolean } {
    const chromeExe = this.getChromeExecutablePath();
    if (!chromeExe) {
      return { success: false, message: 'Không tìm thấy Google Chrome trên máy tính.' };
    }
    const isRunning = this.isChromeRunning();
    const targetProfile = profileId || this.activeProfileId || 'Default';
    const args = [
      `--remote-debugging-port=${port}`,
      `--profile-directory=${targetProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    try {
      const child = spawn(chromeExe, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return {
        success: true,
        isRunning,
        message: isRunning
          ? `Chrome đang chạy sẵn — cờ --remote-debugging-port=${port} chỉ có hiệu lực khi khởi động mới. Hãy đóng hẳn Chrome rồi mở lại qua nút này!`
          : `Đã mở Google Chrome với CDP port ${port} (Profile: ${targetProfile}). Giờ bấm 'Hút Cookies từ Chrome (CDP)' để nạp cookies!`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Lỗi khởi chạy Google Chrome: ${msg}` };
    }
  }

  /**
   * Synchronizes a Chrome profile: imports bookmarks (read-only) and, when a
   * Chrome instance is reachable via CDP (--remote-debugging-port), hydrates
   * cookies directly into the target session — fully extension-free & local-first.
   */
  public async syncProfile(profileId = 'Default', targetSession?: Electron.Session): Promise<{
    success: boolean;
    cookiesCount: number;
    bookmarksCount: number;
    hasLiveCookies: boolean;
    message: string;
  }> {
    this.activeProfileId = profileId;
    const profilePath = path.join(this.chromeUserDataPath, profileId);
    const profileMissing = !fs.existsSync(profilePath);

    // 1. Bookmarks — read-only import from Chrome's Bookmarks JSON
    const bookmarks = profileMissing ? [] : this.getChromeBookmarks(profileId);

    // 2. Extension-free cookie hydration via CDP (when Chrome exposes a debug port)
    let cookiesCount = 0;
    let cdpNote = '';
    if (targetSession && targetSession.cookies) {
      try {
        const cdpRes = await LocalSessionVault.getInstance().importFromLiveChromeCDP(targetSession, 9222);
        if (cdpRes.success) {
          const liveCookies = await targetSession.cookies.get({});
          cookiesCount = liveCookies.length;
          cdpNote = ` Đã hút ${cdpRes.count} cookies trực tiếp từ Chrome qua CDP!`;
        } else {
          try {
            const liveCookies = await targetSession.cookies.get({});
            cookiesCount = liveCookies.length;
          } catch {}
          cdpNote = ` Chưa hút được cookies qua CDP: ${cdpRes.message}`;
        }
      } catch (err: unknown) {
        cdpNote = ` Lỗi hút cookies qua CDP: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (profileMissing) {
      return { success: false, cookiesCount: 0, bookmarksCount: 0, hasLiveCookies: false, message: `Profile '${profileId}' not found.` };
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
