/**
 * AntiFan Browser Desktop — Local Session Vault
 * 100% offline, local-first cookie vault and snapshot persistence engine.
 * Supports JSON cookie backup/restore, Cookie-Editor format import,
 * durable 30-day fallback TTL, and zero-cloud direct Chrome CDP hydration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { WebSocket } from 'ws';
import { session, ipcMain, dialog, BrowserWindow } from 'electron';
import { StorageLocations } from '../config/storage-locations';
import { extensionCookieImportSetDetails, ExtensionCookieInput } from './chrome-profile-sync';

export interface VaultCookie {
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

export interface VaultStats {
  exists: boolean;
  count: number;
  lastModified?: number;
  filePath: string;
}

export class LocalSessionVault {
  private static instance: LocalSessionVault | null = null;
  public static readonly DEFAULT_VAULT_FILENAME = 'session-vault.json';

  public static getInstance(): LocalSessionVault {
    if (!LocalSessionVault.instance) {
      LocalSessionVault.instance = new LocalSessionVault();
    }
    return LocalSessionVault.instance;
  }

  public getDefaultVaultPath(): string {
    const configDir = StorageLocations.getConfigDir();
    if (!fs.existsSync(configDir)) {
      try {
        fs.mkdirSync(configDir, { recursive: true });
      } catch {}
    }
    return path.join(configDir, LocalSessionVault.DEFAULT_VAULT_FILENAME);
  }

  /**
   * Exports all cookies from the specified Electron session to a local JSON file.
   */
  public async exportVaultToFile(
    targetSession: Electron.Session,
    targetFilePath?: string
  ): Promise<{ success: boolean; count: number; filePath: string; error?: string }> {
    const outPath = targetFilePath ? path.resolve(targetFilePath) : this.getDefaultVaultPath();
    try {
      const liveCookies = await targetSession.cookies.get({});
      const serializableCookies: VaultCookie[] = liveCookies.map((c) => {
        let sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict' = 'unspecified';
        if (c.sameSite === 'lax') sameSite = 'lax';
        else if (c.sameSite === 'strict') sameSite = 'strict';
        else if (c.sameSite === 'no_restriction') sameSite = 'no_restriction';

        return {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite,
          expirationDate: c.expirationDate,
        };
      });

      const parentDir = path.dirname(outPath);
      if (!fs.existsSync(parentDir)) {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }

      await fs.promises.writeFile(outPath, JSON.stringify(serializableCookies, null, 2), 'utf8');
      return { success: true, count: serializableCookies.length, filePath: outPath };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[LocalSessionVault] Failed to export session vault:', msg);
      return { success: false, count: 0, filePath: outPath, error: msg };
    }
  }

  /**
   * Imports cookies from a local JSON file into the target session with durable fallback TTL.
   */
  public async importVaultFromFile(
    targetSession: Electron.Session,
    inputFilePath?: string
  ): Promise<{ success: boolean; importedCount: number; failedCount: number; error?: string }> {
    const inPath = inputFilePath ? path.resolve(inputFilePath) : this.getDefaultVaultPath();
    if (!fs.existsSync(inPath)) {
      return { success: false, importedCount: 0, failedCount: 0, error: `Vault file does not exist: ${inPath}` };
    }

    try {
      const raw = await fs.promises.readFile(inPath, 'utf8');
      const parsed = JSON.parse(raw);
      return await this.importVaultFromJson(targetSession, parsed);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, importedCount: 0, failedCount: 0, error: msg };
    }
  }

  /**
   * Imports cookies from a JSON array or JSON string with durable 30-day session cookie TTL.
   */
  public async importVaultFromJson(
    targetSession: Electron.Session,
    input: string | VaultCookie[]
  ): Promise<{ success: boolean; importedCount: number; failedCount: number; error?: string }> {
    let cookieList: any[];
    if (typeof input === 'string') {
      try {
        cookieList = JSON.parse(input);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, importedCount: 0, failedCount: 0, error: `Invalid JSON: ${msg}` };
      }
    } else if (Array.isArray(input)) {
      cookieList = input;
    } else {
      return { success: false, importedCount: 0, failedCount: 0, error: 'Input must be a JSON string or array' };
    }
    if (cookieList.length === 0) {
      return { success: true, importedCount: 0, failedCount: 0 };
    }

    let importedCount = 0;
    let failedCount = 0;

    for (const raw of cookieList) {
      if (!raw || typeof raw !== 'object' || !raw.name) {
        failedCount++;
        continue;
      }

      let sameSite = raw.sameSite;
      if (typeof sameSite === 'string') {
        const lower = sameSite.toLowerCase();
        if (lower === 'none') sameSite = 'no_restriction';
        else if (lower === 'lax') sameSite = 'lax';
        else if (lower === 'strict') sameSite = 'strict';
      }

      // Support CDP 'expires' (epoch seconds) as fallback for 'expirationDate'
      let expirationDate: number | undefined;
      if (typeof raw.expirationDate === 'number') {
        expirationDate = raw.expirationDate;
      } else if (typeof raw.expires === 'number') {
        expirationDate = raw.expires;
      }

      const inputCookie: ExtensionCookieInput = {
        name: String(raw.name),
        value: String(raw.value ?? ''),
        domain: raw.domain ? String(raw.domain) : undefined,
        host: raw.host ? String(raw.host) : undefined,
        path: raw.path ? String(raw.path) : '/',
        secure: Boolean(raw.secure),
        httpOnly: Boolean(raw.httpOnly),
        sameSite,
        expirationDate,
      };
      const setDetails = extensionCookieImportSetDetails(inputCookie, {
        persistSessionCookies: true,
        sessionTtlSeconds: 30 * 24 * 60 * 60, // 30 days durable TTL
      });

      if (!setDetails) {
        failedCount++;
        continue;
      }

      try {
        await targetSession.cookies.set(setDetails);
        importedCount++;
      } catch {
        failedCount++;
      }
    }

    try {
      await targetSession.cookies.flushStore();
    } catch {}

    return { success: importedCount > 0, importedCount, failedCount };
  }

  /**
   * Pulls all decrypted cookies from a live Google Chrome instance running with --remote-debugging-port
   * via Chrome DevTools Protocol (CDP). Bypasses Windows 11 App-Bound Encryption (v20) cleanly.
   */
  public async importFromLiveChromeCDP(
    targetSession: Electron.Session,
    cdpPort = 9222
  ): Promise<{ success: boolean; count: number; message: string }> {
    const { promise, resolve } = Promise.withResolvers<{ success: boolean; count: number; message: string }>();
    // Owned one-shot Chrome cold start (temp clone + fresh process on a busy
    // machine + AV scan) can take seconds before the page-target WebSocket
    // answers Network.getAllCookies. A tight 3s budget turned a WORKING sync
    // into "CDP connection timed out after 3000ms" (reported on Profile 2);
    // 12s keeps the failure mode real (never hangs) while covering cold start.
    const timeoutMs = 12000;
      // Serialize all terminal paths: finish/fallback may only fire once, so a
      // listReq timeout + error double-trigger can never open two connections
      // or resolve the outer promise twice.
      let finished = false;
      const finish = (payload: { success: boolean; count: number; message: string }): void => {
        if (finished) return;
        finished = true;
        resolve(payload);
      };
      let wsInProgress = false;
      let fallbackArmed = false;
      const armFallback = (): void => {
        if (wsInProgress || fallbackArmed) return;
        fallbackArmed = true;
        fallbackToBrowserEndpoint();
      };
      const offlineMessage = `Không thể kết nối Chrome CDP trên cổng ${cdpPort}. Hãy dùng Import JSON hoặc mở Chrome với --remote-debugging-port=${cdpPort}.`;

      // 1. Prefer a PAGE target — Network.getAllCookies only exists on page targets.
      const listReq = http.get(`http://127.0.0.1:${cdpPort}/json/list`, { timeout: 4000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let wsUrl: string | undefined;
          try {
            const targets = JSON.parse(body || '[]') as Array<{ type?: string; webSocketDebuggerUrl?: string }> | null;
            const page = Array.isArray(targets)
              ? targets.find((t) => t && t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
              : undefined;
            wsUrl = page ? page.webSocketDebuggerUrl : undefined;
          } catch {}
          if (wsUrl) {
            useWebSocket(wsUrl, true);
          } else {
            armFallback();
          }
        });
      });
      listReq.on('timeout', () => {
        listReq.destroy();
        armFallback();
      });
      listReq.on('error', () => armFallback());

      // 2. Fallback: the browser-level endpoint (Storage.getCookies instead of Network).
      const fallbackToBrowserEndpoint = (): void => {
        const versionReq = http.get(`http://127.0.0.1:${cdpPort}/json/version`, { timeout: 4000 }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const data = JSON.parse(body || '{}') as { webSocketDebuggerUrl?: string };
              if (data.webSocketDebuggerUrl) {
                useWebSocket(data.webSocketDebuggerUrl, false);
              } else {
                finish({
                  success: false,
                  count: 0,
                  message: `Chrome DevTools active on port ${cdpPort} but missing webSocketDebuggerUrl`,
                });
              }
            } catch (err: unknown) {
              finish({ success: false, count: 0, message: `Lỗi parse version: ${err}` });
            }
          });
        });
        versionReq.on('timeout', () => {
          versionReq.destroy();
          finish({ success: false, count: 0, message: offlineMessage });
        });
        versionReq.on('error', () => {
          finish({ success: false, count: 0, message: offlineMessage });
        });
      };

      // 3. Shared WebSocket cookie fetch: Network.getAllCookies on page targets,
      //    Storage.getCookies on the browser endpoint.
      const useWebSocket = (wsUrl: string, hasNetworkApi: boolean): void => {
        wsInProgress = true;
        let ws: WebSocket;
        try {
          ws = new WebSocket(wsUrl);
        } catch (err: unknown) {
          finish({ success: false, count: 0, message: `Không mở được CDP WebSocket: ${err}` });
          return;
        }
        let timeoutTimer: NodeJS.Timeout;
        const armTimeout = (): void => {
          timeoutTimer = setTimeout(() => {
            try { ws.close(); } catch {}
            finish({ success: false, count: 0, message: `CDP connection timed out after ${timeoutMs}ms` });
          }, timeoutMs);
        };
        armTimeout();
        let triedStorageApi = false;

        ws.on('open', () => {
          ws.send(JSON.stringify({ id: 100, method: hasNetworkApi ? 'Network.getAllCookies' : 'Storage.getCookies' }));
        });

        ws.on('message', async (rawMsg: string | Buffer) => {
          try {
            const response = JSON.parse(rawMsg.toString()) as {
              id?: number;
              error?: { message?: string; code?: string };
              result?: { cookies?: unknown };
            };
            if (response.id !== 100) return;
            clearTimeout(timeoutTimer);
            if (response.error) {
              const errText = `${response.error.message || ''} ${response.error.code || ''}`;
              // Browser endpoint (or locked-down page) may reject Network.getAllCookies —
              // retry once with Storage.getCookies which also returns {cookies: []}.
              if (!triedStorageApi && errText.includes("wasn't found")) {
                triedStorageApi = true;
                // Retry must stay bounded: re-arm the timeout before issuing the fallback call.
                clearTimeout(timeoutTimer);
                armTimeout();
                ws.send(JSON.stringify({ id: 100, method: 'Storage.getCookies' }));
                return;
              }
              try { ws.close(); } catch {}
              finish({
                success: false,
                count: 0,
                message: `Lỗi CDP từ Chrome: ${response.error.message || JSON.stringify(response.error)}`,
              });
              return;
            }
            if (response.result && Array.isArray(response.result.cookies)) {
              const chromeCookies = response.result.cookies;
              const res = await this.importVaultFromJson(targetSession, chromeCookies);
              // NO plaintext backup here: session-vault.json must only ever be
              // written by explicit user action (export menu item). CDP cookies
              // (incl. HttpOnly auth cookies) stay in the in-memory Electron
              // session only.
              try { ws.close(); } catch {}
              finish({
                success: res.success,
                count: res.importedCount,
                message: `Đã nạp ${res.importedCount} cookies trực tiếp từ Chrome qua CDP Port ${cdpPort}!`,
              });
              return;
            }
            try { ws.close(); } catch {}
            finish({ success: false, count: 0, message: 'Phản hồi CDP không chứa cookies' });
          } catch (err: unknown) {
            clearTimeout(timeoutTimer);
            try { ws.close(); } catch {}
            finish({ success: false, count: 0, message: `Lỗi đọc CDP cookies: ${err}` });
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timeoutTimer);
          finish({ success: false, count: 0, message: `CDP WebSocket error: ${err.message}` });
        });
      };

    return promise;
  }

  /**
   * Retrieves status metadata for the local session vault file.
   */
  public async getVaultStats(customFilePath?: string): Promise<VaultStats> {
    const filePath = customFilePath ? path.resolve(customFilePath) : this.getDefaultVaultPath();
    if (!fs.existsSync(filePath)) {
      return { exists: false, count: 0, filePath };
    }

    try {
      const stats = await fs.promises.stat(filePath);
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const count = Array.isArray(parsed) ? parsed.length : 0;
      return { exists: true, count, lastModified: stats.mtimeMs, filePath };
    } catch {
      return { exists: false, count: 0, filePath };
    }
  }

  /**
   * Registers IPC handlers for toolbar and app menu integration.
   */
  public registerIpcHandlers(getSessionFn: () => Electron.Session): void {
    ipcMain.removeHandler('antifan:vault:export');
    ipcMain.handle('antifan:vault:export', async (_event, customPath?: string) => {
      const targetSession = getSessionFn();
      return await this.exportVaultToFile(targetSession, customPath);
    });

    ipcMain.removeHandler('antifan:vault:import');
    ipcMain.handle('antifan:vault:import', async (_event, customPath?: string) => {
      const targetSession = getSessionFn();
      return await this.importVaultFromFile(targetSession, customPath);
    });

    ipcMain.removeHandler('antifan:vault:import-json');
    ipcMain.handle('antifan:vault:import-json', async (_event, jsonContent: string) => {
      const targetSession = getSessionFn();
      return await this.importVaultFromJson(targetSession, jsonContent);
    });

    ipcMain.removeHandler('antifan:vault:get-stats');
    ipcMain.handle('antifan:vault:get-stats', async (_event, customPath?: string) => {
      return await this.getVaultStats(customPath);
    });
  }
}
