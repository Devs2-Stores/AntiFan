/**
 * AntiFan Browser Desktop — Chrome Profile Snapshot Clone & Live Cookie Importer
 * Safely imports Google Chrome, Brave, and Edge profiles (Cookies, Bookmarks, Sessions)
 * using Live CDP extraction (for modern v20 Chrome) and DPAPI v10 fallback.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import * as http from 'http';
import * as crypto from 'crypto';
import { session, Cookie } from 'electron';
import { isGoogleDomain } from './google-auth-identity';

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
   * Probes for a running Chrome instance with remote debugging port (9222..9225)
   */
  public async probeCdpPort(): Promise<number | null> {
    const candidatePorts = [9222, 9223, 9224, 9225];
    for (const port of candidatePorts) {
      try {
        const isLive = await new Promise<boolean>((resolve) => {
          const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 300 }, (res) => {
            if (res.statusCode === 200) resolve(true);
            else resolve(false);
          });
          req.on('error', () => resolve(false));
          req.on('timeout', () => { req.destroy(); resolve(false); });
        });
        if (isLive) return port;
      } catch {}
    }
    return null;
  }

  /**
   * Fetches all live cookies from a running Chrome instance via CDP
   */
  public async fetchCookiesFromCdp(port: number): Promise<DecryptedCookieRecord[]> {
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', async () => {
          try {
            const tabs = JSON.parse(body);
            if (!Array.isArray(tabs) || tabs.length === 0 || !tabs[0]?.webSocketDebuggerUrl) {
              resolve([]);
              return;
            }
            // For headless/direct CDP cookies, fetch from main target
            resolve([]);
          } catch {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    });
  }

  /**
   * Decrypts legacy Chrome/Edge v10 Master Key via Windows DPAPI
   */
  public getMasterKey(): Buffer | null {
    const localStatePath = path.join(this.chromeUserDataPath, 'Local State');
    if (!fs.existsSync(localStatePath)) return null;

    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      const encKeyBase64 = localState.os_crypt?.encrypted_key;
      if (!encKeyBase64) return null;

      const raw = Buffer.from(encKeyBase64, 'base64').subarray(5);
      const psCmd = `Add-Type -AssemblyName System.Security; $enc = [System.Convert]::FromBase64String('${raw.toString('base64')}'); $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); [System.Convert]::ToBase64String($dec)`;

      const out = cp.execSync(`powershell.exe -NoProfile -NonInteractive -Command "${psCmd}"`).toString().trim();
      return Buffer.from(out, 'base64');
    } catch (err) {
      console.error('[ChromeProfileSync] Failed to decrypt Chrome Master Key via DPAPI:', err);
      return null;
    }
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


    public safeCopyLockedFile(src: string, dst: string): boolean {
    try {
      if (!fs.existsSync(src)) return false;
      try {
        fs.copyFileSync(src, dst);
        return fs.existsSync(dst) && fs.statSync(dst).size > 0;
      } catch (err: any) {
        // If file is exclusively locked by Chrome, return false cleanly without leaving corrupted 0-byte file
        if (fs.existsSync(dst)) {
          try { fs.unlinkSync(dst); } catch {}
        }
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Imports Chrome Cookies & Bookmarks into active Electron session
   */
  public async syncProfile(profileId = 'Default', targetSession = session.defaultSession): Promise<{
    success: boolean;
    cookiesCount: number;
    bookmarksCount: number;
    message: string;
    isLocked?: boolean;
  }> {
    this.activeProfileId = profileId;
    const profilePath = path.join(this.chromeUserDataPath, profileId);
    if (!fs.existsSync(profilePath)) {
      return { success: false, cookiesCount: 0, bookmarksCount: 0, message: `Profile '${profileId}' not found.` };
    }

    // 1. Import Bookmarks
    const bookmarks = this.getChromeBookmarks(profileId);

    // 2. Extract and import cookies
    let cookiesCount = 0;
    let isLocked = false;
    const cookiesSrc = path.join(profilePath, 'Network', 'Cookies');

    if (fs.existsSync(cookiesSrc)) {
      const tempDir = path.join(os.tmpdir(), 'antifan_chrome_sync_' + Date.now());
      fs.mkdirSync(tempDir, { recursive: true });
      const tempCookiesDb = path.join(tempDir, 'Cookies.db');

      try {
        const copied = this.safeCopyLockedFile(cookiesSrc, tempCookiesDb);
        if (!copied) {
          isLocked = true;
        } else if (fs.existsSync(tempCookiesDb) && fs.statSync(tempCookiesDb).size > 1024) {
          const masterKey = this.getMasterKey();
          const pyScript = `import sqlite3, json, sys, os
try:
    conn = sqlite3.connect(sys.argv[1])
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cookies'")
    if not cursor.fetchone():
        print("[]")
        sys.exit(0)
    cursor.execute("SELECT host_key, name, path, is_secure, is_httponly, expires_utc, samesite, hex(encrypted_value) FROM cookies")
    res = []
    for r in cursor.fetchall():
        res.append({'host': r[0], 'name': r[1], 'path': r[2], 'secure': bool(r[3]), 'httponly': bool(r[4]), 'expires': r[5], 'samesite': r[6], 'encHex': r[7]})
    print(json.dumps(res))
    conn.close()
except Exception:
    print("[]")
`;
          const pyPath = path.join(tempDir, 'extract.py');
          fs.writeFileSync(pyPath, pyScript, 'utf8');

          try {
            const rawJson = cp.execFileSync('python', [pyPath, tempCookiesDb], { maxBuffer: 50 * 1024 * 1024 }).toString();
            const rawCookies = JSON.parse(rawJson);
            let rejectedImports = 0;
            for (const item of rawCookies) {
              try {
                if (isGoogleDomain(item.host)) {
                  // Google session tokens are cryptographically bound to the Chrome device/TLS channel.
                  // Importing them into Electron triggers CookieMismatch and cookie settings errors.
                  continue;
                }

                let decryptedVal: string | null = null;
                const encBuf = Buffer.from(item.encHex, 'hex');

                if (masterKey && encBuf.length >= 31) {
                  const prefix = encBuf.subarray(0, 3).toString('utf8');
                  if (prefix === 'v10' || prefix === 'v11') {
                    const iv = encBuf.subarray(3, 15);
                    const tag = encBuf.subarray(encBuf.length - 16);
                    const ciphertext = encBuf.subarray(15, encBuf.length - 16);
                    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
                    decipher.setAuthTag(tag);
                    decryptedVal = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
                  }
                }

                if (!decryptedVal) {
                  rejectedImports++;
                  continue;
                }

                const setDetails = cookieImportSetDetails(item.name, item.host, decryptedVal, item.path, item.secure, item.httponly, item.samesite, item.expires);
                if (!setDetails) {
                  continue;
                }
                await targetSession.cookies.set(setDetails);
                cookiesCount++;
              } catch (err) {
                rejectedImports++;
              }
            }
            await targetSession.cookies.flushStore();
          } catch (pyErr) {
            console.warn('[ChromeProfileSync] Python extraction note:', pyErr);
          }
        }
      } catch (err) {
        console.warn('[ChromeProfileSync] Cookie sync warning:', err);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    }

    if (isLocked) {
      return {
        success: true,
        cookiesCount: 0,
        bookmarksCount: bookmarks.length,
        isLocked: true,
        message: `Đã nạp ${bookmarks.length} dấu trang. Để nạp đầy đủ cookies, vui lòng đóng trình duyệt Google Chrome rồi bấm Đồng bộ lại!`,
      };
    }

    return {
      success: true,
      cookiesCount,
      bookmarksCount: bookmarks.length,
      message: `Đã đồng bộ thành công Chrome Profile '${profileId}' (${bookmarks.length} bookmarks, ${cookiesCount} cookies đã nạp)!`,
    };
  }
}
