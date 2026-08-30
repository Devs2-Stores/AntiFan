/**
 * AntiFan Browser Desktop — Chrome Profile & Companion Extension Sync
 * Provides Chrome profile & bookmark integration, with cookie synchronization
 * unified via the AntiFan Chrome Companion Extension & Native Messaging Bridge.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { session } from 'electron';
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
  expires?: number
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
}

/**
 * Builds the cookies.set() payload for a cookie exported from a Chrome Extension (chrome.cookies API).
 * Handles Unix epoch seconds for expirationDate, RFC 6265bis __Host- constraints, and sameSite mappings.
 */
export function extensionCookieImportSetDetails(
  cookie: ExtensionCookieInput
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
  if (typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0) {
    const unixSeconds = Math.floor(cookie.expirationDate);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (unixSeconds <= nowSeconds) {
      // Expired cookie: skip it
      return null;
    }
    details.expirationDate = unixSeconds;
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
   * Syncs a new bookmark back to the active Chrome Profile Bookmarks file
   */
  public async saveChromeBookmark(profileId: string, title: string, url: string): Promise<boolean> {
    const bookmarksPath = path.join(this.chromeUserDataPath, profileId, 'Bookmarks');
    if (!fs.existsSync(bookmarksPath)) return false;
    try {
      const raw = await fs.promises.readFile(bookmarksPath, 'utf8');
      const data = JSON.parse(raw);
      if (!data.roots) data.roots = {};
      if (!data.roots.bookmark_bar) data.roots.bookmark_bar = { children: [], name: 'Bookmarks bar', type: 'folder' };
      if (!Array.isArray(data.roots.bookmark_bar.children)) data.roots.bookmark_bar.children = [];

      const exists = data.roots.bookmark_bar.children.some((c: any) => c.url === url);
      if (!exists) {
        data.roots.bookmark_bar.children.push({
          date_added: String(Date.now() * 1000),
          id: String(Date.now()),
          name: title,
          type: 'url',
          url: url,
        });
        await fs.promises.writeFile(bookmarksPath, JSON.stringify(data, null, 2), 'utf8');
      }
      return true;
    } catch (err) {
      console.warn('[ChromeProfileSync] Failed to sync bookmark back to Chrome:', err);
      return false;
    }
  }

  /**
   * Removes a bookmark from the Chrome Profile Bookmarks file asynchronously
   */
  public async removeChromeBookmark(profileId: string, url: string): Promise<boolean> {
    const bookmarksPath = path.join(this.chromeUserDataPath, profileId, 'Bookmarks');
    if (!fs.existsSync(bookmarksPath)) return false;
    try {
      const raw = await fs.promises.readFile(bookmarksPath, 'utf8');
      const data = JSON.parse(raw);
      if (data.roots && data.roots.bookmark_bar && Array.isArray(data.roots.bookmark_bar.children)) {
        data.roots.bookmark_bar.children = data.roots.bookmark_bar.children.filter((c: any) => c.url !== url);
        await fs.promises.writeFile(bookmarksPath, JSON.stringify(data, null, 2), 'utf8');
      }
      return true;
    } catch (err) {
      return false;
    }
  }


  /**
   * Synchronizes bookmarks from the selected Chrome profile.
   * Cookie synchronization is handled continuously in real-time via the AntiFan Chrome Sync Extension.
   */
  public async syncProfile(profileId = 'Default', _targetSession?: Electron.Session): Promise<{
    success: boolean;
    cookiesCount: number;
    bookmarksCount: number;
    message: string;
  }> {
    this.activeProfileId = profileId;
    const profilePath = path.join(this.chromeUserDataPath, profileId);
    if (!fs.existsSync(profilePath)) {
      return { success: false, cookiesCount: 0, bookmarksCount: 0, message: `Profile '${profileId}' not found.` };
    }

    // 1. Import Bookmarks cleanly from Chrome's Bookmarks JSON file
    const bookmarks = this.getChromeBookmarks(profileId);

    return {
      success: true,
      cookiesCount: 0,
      bookmarksCount: bookmarks.length,
      message: `Đã nạp ${bookmarks.length} dấu trang từ Chrome Profile '${profileId}'. Cookies được đồng bộ tự động qua AntiFan Chrome Extension!`,
    };
  }
}
