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
import { createRequire } from 'node:module';
import { StorageLocations } from '../config/storage-locations';
import { extensionCookieImportSetDetails, ExtensionCookieInput } from './chrome-profile-sync';
import type * as PartitionModule from './browser-session-partition';

const lazyRequire = createRequire(__filename);

/**
 * Partition helpers, loaded on demand. `./browser-session-partition` captures the
 * Electron `session` export when it loads, so a static edge from this module would
 * make anyone who merely imports the vault (the bridge, or a test that installs
 * its own session stub before loading that module) bind the real export first.
 * The vault needs only the naming predicates, so it asks for them when it runs.
 */
let partitionHelpers: typeof PartitionModule | null = null;
function partitionNaming(): typeof PartitionModule {
  partitionHelpers ??= lazyRequire('./browser-session-partition') as typeof PartitionModule;
  return partitionHelpers;
}

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
  error?: string;
}

export type VaultSessionResolver = (
  event?: unknown,
  payload?: unknown,
  binding?: { valid: boolean; attachmentId?: string; error?: string }
) => Electron.Session | null;

export interface SessionVaultIpcOptions {
  validateSender?: (event: unknown) => boolean;
  resolveAttachmentBinding?: (
    event: unknown,
    payload?: unknown
  ) => { valid: boolean; attachmentId?: string; error?: string };
}

export interface CookieImportOptions {
  attachmentBinding?: {
    attachmentId?: string;
    valid?: boolean;
    isBound?: boolean;
  } | null;
  requireAttachmentBinding?: boolean;
}

/**
 * Fail-closed derivation of sender trustworthiness for Session Vault operations.
 * Requires a TOP frame (senderFrame === sender.mainFrame) with an internal app
 * UI origin (file: pointing to toolbar/sidebar/renderer or antifan: scheme).
 * Untrusted top frames (external http/https) and all subframes resolve to false.
 */
export function isTrustedSessionVaultSender(event: unknown): boolean {
  const ipcEvent = (event ?? null) as {
    senderFrame?: { url?: string } | null;
    sender?: { mainFrame?: unknown } | null;
  } | null;
  if (!ipcEvent) return false;
  const frame = ipcEvent.senderFrame;
  if (!frame || typeof frame.url !== 'string') return false;
  const mainFrame = ipcEvent.sender?.mainFrame;
  if (mainFrame === undefined || frame !== mainFrame) return false;

  try {
    const parsed = new URL(frame.url);
    if (parsed.protocol === 'file:') {
      const pathname = parsed.pathname.toLowerCase();
      return pathname.endsWith('toolbar.html') || pathname.endsWith('sidebar.html') || pathname.includes('/renderer/');
    }
    if (parsed.protocol === 'antifan:') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Boundary coercion for cookie records arriving from a vault file or Chrome
 * CDP: every field is untrusted, so each is checked before use instead of
 * being stringified blindly.
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Cookie names that carry a Google account session. `SID`/`HSID`/`SSID`/`APISID`
 * are the classic account cookies; google.com issues the `__Secure-*` variants
 * over HTTPS today, and `LOGIN_INFO` is the YouTube-side marker. A jar holding
 * none of them cannot sign the user in, whatever its total cookie count says.
 */
const GOOGLE_AUTH_COOKIE_NAMES = new Set([
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  'LOGIN_INFO',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
]);

function isGoogleHost(domain: string): boolean {
  const host = domain.startsWith('.') ? domain.slice(1) : domain;
  return (
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    host === 'google.com.vn' ||
    host.endsWith('.google.com.vn') ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com')
  );
}

/**
 * True when a cookie is a Google sign-in credential rather than a tracking or
 * preferences cookie. Used to tell a restore that actually re-authenticated the
 * user from one that only moved anonymous cookies.
 */
export function isGoogleAuthCookie(cookie: { name?: unknown; domain?: unknown } | null | undefined): boolean {
  if (!cookie) return false;
  const name = typeof cookie.name === 'string' ? cookie.name : '';
  const domain = typeof cookie.domain === 'string' ? cookie.domain.toLowerCase() : '';
  return GOOGLE_AUTH_COOKIE_NAMES.has(name) && isGoogleHost(domain);
}

export function countGoogleAuthCookies(cookies: Array<{ name?: unknown; domain?: unknown }>): number {
  let count = 0;
  for (const cookie of cookies) {
    if (isGoogleAuthCookie(cookie)) count++;
  }
  return count;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** CDP reports `SameSite=None`; Chromium's cookie API expects `no_restriction`. */
function normalizeSameSite(value: unknown): 'no_restriction' | 'lax' | 'strict' | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  if (lower === 'none') return 'no_restriction';
  if (lower === 'lax') return 'lax';
  if (lower === 'strict') return 'strict';
  return undefined;
}

/** Windows paths are case-insensitive; CDP echoes the path exactly as spawned. */
function sameLocalPath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

/**
 * Asks a CDP endpoint which user-data-dir it actually runs on, via
 * `SystemInfo.getInfo` on the browser target. Returns `null` when the endpoint
 * does not answer or does not expose its command line — the caller decides
 * whether that is fatal.
 *
 * Why this exists: a port number is not an identity. Another Chrome (a bundled
 * tool, an extension host) may already listen on the port we intend to read,
 * and `Network.getAllCookies` against it returns that other profile's cookies —
 * or, for an empty profile, nothing at all.
 */
function probeCdpUserDataDir(cdpPort: number, timeoutMs: number): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  let settled = false;
  const finish = (value: string | null): void => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  const versionReq = http.get(`http://127.0.0.1:${cdpPort}/json/version`, { timeout: timeoutMs }, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      let wsUrl: string | undefined;
      try {
        const parsed = JSON.parse(body || '{}') as { webSocketDebuggerUrl?: unknown };
        if (typeof parsed.webSocketDebuggerUrl === 'string') wsUrl = parsed.webSocketDebuggerUrl;
      } catch {}
      if (!wsUrl) return finish(null);
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        return finish(null);
      }
      const guard = setTimeout(() => {
        try { ws.close(); } catch {}
        finish(null);
      }, timeoutMs);
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }));
      });
      ws.on('message', (raw: Buffer | string) => {
        clearTimeout(guard);
        let commandLine: string | undefined;
        try {
          const msg = JSON.parse(raw.toString()) as { id?: number; result?: { commandLine?: unknown } };
          if (msg.id === 1 && typeof msg.result?.commandLine === 'string') commandLine = msg.result.commandLine;
        } catch {}
        try { ws.close(); } catch {}
        if (!commandLine) return finish(null);
        const match = /--user-data-dir=(?:"([^"]+)"|([^\s]+))/.exec(commandLine);
        finish(match ? (match[1] ?? match[2] ?? null) : null);
      });
      ws.on('error', () => {
        clearTimeout(guard);
        finish(null);
      });
    });
  });
  versionReq.on('timeout', () => {
    versionReq.destroy();
    finish(null);
  });
  versionReq.on('error', () => finish(null));
  return promise;
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
   * Resolves the credential jar a target session writes to and refuses
   * non-durable targets. An ephemeral (`ephemeral-*` / in-memory) session
   * accepts the write and drops it with the process, which is how a bundled
   * "sync" reported success while the next launch had no session at all. The
   * jar name is returned on every path so callers can report where cookies
   * actually landed.
   */
  private resolveCredentialJar(targetSession: Electron.Session): { jar: string; error?: string } {
    const { getBrowserSessionPartition, isEphemeralSession, isCapsuleSession } = partitionNaming();
    const jar = getBrowserSessionPartition(targetSession) || 'unknown';
    if (isEphemeralSession(targetSession)) {
      return { jar, error: `EPHEMERAL_TARGET_REJECTED: refusing credential operation against non-durable jar '${jar}'` };
    }
    if (isCapsuleSession(targetSession)) {
      return { jar, error: `CAPSULE_TARGET_REJECTED: refusing credential operation against workspace-scoped jar '${jar}'` };
    }
    return { jar };
  }

  /**
   * Exports all cookies from the specified Electron session to a local JSON file.
   */
  public async exportVaultToFile(
    targetSession: Electron.Session,
    targetFilePath?: string
  ): Promise<{ success: boolean; count: number; googleAuthCount?: number; filePath: string; targetJar: string; error?: string }> {
    const outPath = targetFilePath ? path.resolve(targetFilePath) : this.getDefaultVaultPath();
    const target = this.resolveCredentialJar(targetSession);
    if (target.error) {
      return { success: false, count: 0, filePath: outPath, targetJar: target.jar, error: target.error };
    }
    try {
      const liveCookies = await targetSession.cookies.get({});
      // A backup of nothing is not a backup: overwriting the vault file with an
      // empty array silently destroyed the last good copy.
      if (liveCookies.length === 0) {
        return { success: false, count: 0, filePath: outPath, targetJar: target.jar, error: 'EMPTY_STORE_REJECTED: no live cookies in target jar; refusing to overwrite the vault file' };
      }
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
      return {
        success: true,
        count: serializableCookies.length,
        googleAuthCount: countGoogleAuthCookies(serializableCookies),
        filePath: outPath,
        targetJar: target.jar,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[LocalSessionVault] Failed to export session vault:', msg);
      return { success: false, count: 0, filePath: outPath, targetJar: target.jar, error: msg };
    }
  }

  /**
   * Imports cookies from a local JSON file into the target session with durable fallback TTL.
   */
  public async importVaultFromFile(
    targetSession: Electron.Session,
    inputFilePath?: string,
    options?: CookieImportOptions
  ): Promise<{ success: boolean; importedCount: number; googleAuthCount?: number; failedCount: number; targetJar: string; error?: string }> {
    const inPath = inputFilePath ? path.resolve(inputFilePath) : this.getDefaultVaultPath();
    const target = this.resolveCredentialJar(targetSession);
    if (target.error) {
      return { success: false, importedCount: 0, failedCount: 0, targetJar: target.jar, error: target.error };
    }
    if (!fs.existsSync(inPath)) {
      return { success: false, importedCount: 0, failedCount: 0, targetJar: target.jar, error: `Vault file does not exist: ${inPath}` };
    }

    try {
      const raw = await fs.promises.readFile(inPath, 'utf8');
      const parsed = JSON.parse(raw);
      return await this.importVaultFromJson(targetSession, parsed, options);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, importedCount: 0, failedCount: 0, targetJar: target.jar, error: msg };
    }
  }

  /**
   * Imports cookies from a JSON array or JSON string with durable 30-day session cookie TTL.
   * Refuses non-durable target jars and never reports success when nothing landed.
   */
  public async importVaultFromJson(
    targetSession: Electron.Session,
    input: string | VaultCookie[],
    options?: CookieImportOptions
  ): Promise<{ success: boolean; importedCount: number; googleAuthCount?: number; failedCount: number; targetJar: string; error?: string }> {
    const target = this.resolveCredentialJar(targetSession);
    if (target.error) {
      return { success: false, importedCount: 0, failedCount: 0, targetJar: target.jar, error: target.error };
    }
    if (options?.requireAttachmentBinding) {
      if (!options.attachmentBinding || !options.attachmentBinding.attachmentId || options.attachmentBinding.valid === false || options.attachmentBinding.isBound === false) {
        return { success: false, importedCount: 0, failedCount: 0, targetJar: target.jar, error: 'ATTACHMENT_REQUIRED: Valid attachment binding required for cookie import' };
      }
    }
    if (options?.attachmentBinding && (options.attachmentBinding.valid === false || options.attachmentBinding.isBound === false)) {
      return { success: false, importedCount: 0, failedCount: 0, targetJar: target.jar, error: 'ATTACHMENT_INVALID: Foreign or unbound attachment binding rejected' };
    }
    let cookieList: unknown[];
    if (typeof input === 'string') {
      try {
        cookieList = JSON.parse(input);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, importedCount: 0, failedCount: 0, targetJar: target.jar, error: `Invalid JSON: ${msg}` };
      }
    } else if (Array.isArray(input)) {
      cookieList = input;
    } else {
      return { success: false, importedCount: 0, failedCount: 0, targetJar: target.jar, error: 'Input must be a JSON string or array' };
    }
    if (cookieList.length === 0) {
      return { success: false, importedCount: 0, failedCount: 0, targetJar: target.jar, error: 'EMPTY_IMPORT_REJECTED: source contains no cookies' };
    }

    let importedCount = 0;
    let googleAuthCount = 0;
    let failedCount = 0;

    for (const candidate of cookieList) {
      if (!candidate || typeof candidate !== 'object' || !('name' in candidate)) {
        failedCount++;
        continue;
      }
      const name = optionalString(candidate.name);
      if (!name) {
        failedCount++;
        continue;
      }

      const sameSite = normalizeSameSite('sameSite' in candidate ? candidate.sameSite : undefined);

      // Support CDP 'expires' (epoch seconds) as fallback for 'expirationDate'
      const expirationDate =
        ('expirationDate' in candidate ? optionalNumber(candidate.expirationDate) : undefined) ??
        ('expires' in candidate ? optionalNumber(candidate.expires) : undefined);

      const inputCookie: ExtensionCookieInput = {
        name,
        value: 'value' in candidate ? String(candidate.value ?? '') : '',
        domain: 'domain' in candidate ? optionalString(candidate.domain) : undefined,
        host: 'host' in candidate ? optionalString(candidate.host) : undefined,
        path: ('path' in candidate ? optionalString(candidate.path) : undefined) ?? '/',
        secure: 'secure' in candidate ? Boolean(candidate.secure) : false,
        httpOnly: 'httpOnly' in candidate ? Boolean(candidate.httpOnly) : false,
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
        if (isGoogleAuthCookie(inputCookie)) googleAuthCount++;
      } catch {
        failedCount++;
      }
    }

    try {
      await targetSession.cookies.flushStore();
    } catch {}

    if (importedCount === 0) {
      return { success: false, importedCount, failedCount, targetJar: target.jar, error: `ZERO_COOKIES_IMPORTED: all ${failedCount} cookie records were rejected` };
    }
    return { success: true, importedCount, googleAuthCount, failedCount, targetJar: target.jar };
  }

  /**
   * Pulls all decrypted cookies from a live Google Chrome instance running with --remote-debugging-port
   * via Chrome DevTools Protocol (CDP). Bypasses Windows 11 App-Bound Encryption (v20) cleanly.
   */
  public async importFromLiveChromeCDP(
    targetSession: Electron.Session,
    cdpPort: number,
    ownerUserDataDir?: string
  ): Promise<{ success: boolean; count: number; message: string }> {
    const { promise, resolve } = Promise.withResolvers<{ success: boolean; count: number; message: string }>();
    const target = this.resolveCredentialJar(targetSession);
    if (target.error) {
      return { success: false, count: 0, message: target.error };
    }
    // Guard the CDP port itself: a foreign or unresolved value would probe an
    // unrelated local service (or an arbitrary host) with a cookie-read call.
    if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
      return { success: false, count: 0, message: `CDP_PORT_INVALID: refusing live-Chrome import on port '${cdpPort}'` };
    }
    // A port number is not an identity: when the caller claims ownership of a
    // user-data-dir (an app-spawned clone), prove the endpoint really runs on
    // it before reading a single cookie. Without this, a foreign Chrome that
    // already holds the port (e.g. a tool launched with --remote-debugging-port
    // and its own user-data-dir) is silently read as if it were ours — which is
    // indistinguishable from "Chrome returned 0 cookies".
    if (ownerUserDataDir) {
      const ownerDir = await probeCdpUserDataDir(cdpPort, 4000);
      if (!ownerDir) {
        return { success: false, count: 0, message: `CDP_OWNERSHIP_UNVERIFIED: endpoint on port ${cdpPort} did not report its user-data-dir; refusing to read an unverified browser` };
      }
      if (!sameLocalPath(ownerDir, ownerUserDataDir)) {
        return { success: false, count: 0, message: `FOREIGN_CDP_PORT_REJECTED: port ${cdpPort} belongs to '${ownerDir}', not '${ownerUserDataDir}'` };
      }
    }
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
                message: res.success
                  ? `Đã nạp ${res.importedCount} cookies từ Chrome vào ${res.targetJar} qua CDP Port ${cdpPort}!`
                  : `Không nạp được cookies từ Chrome vào ${res.targetJar}: ${res.error ?? 'UNKNOWN_ERROR'}`,
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
  public registerIpcHandlers(getSessionFn: VaultSessionResolver, options?: SessionVaultIpcOptions): void {
    const isAuthorized = (event: unknown): boolean => {
      if (options?.validateSender) {
        return options.validateSender(event);
      }
      return isTrustedSessionVaultSender(event);
    };

    ipcMain.removeHandler('antifan:vault:export');
    ipcMain.handle('antifan:vault:export', async (event, customPath?: string) => {
      if (!isAuthorized(event)) {
        return { success: false, count: 0, filePath: '', targetJar: '', error: 'UNVERIFIED_SENDER' };
      }
      const targetSession = getSessionFn(event);
      if (!targetSession) {
        return { success: false, count: 0, filePath: '', targetJar: '', error: 'TARGET_SESSION_REQUIRED: Explicit target session could not be resolved' };
      }
      return await this.exportVaultToFile(targetSession, customPath);
    });

    ipcMain.removeHandler('antifan:vault:import');
    ipcMain.handle('antifan:vault:import', async (event, customPath?: string, importOptions?: unknown) => {
      if (!isAuthorized(event)) {
        return { success: false, importedCount: 0, failedCount: 0, targetJar: '', error: 'UNVERIFIED_SENDER' };
      }
      let binding: { valid: boolean; attachmentId?: string; error?: string } | undefined;
      if (options?.resolveAttachmentBinding) {
        binding = options.resolveAttachmentBinding(event, importOptions);
        if (!binding.valid) {
          return {
            success: false,
            importedCount: 0,
            failedCount: 0,
            targetJar: '',
            error: binding.error || 'ATTACHMENT_REQUIRED: Valid attachment binding required for cookie import',
          };
        }
      }
      const targetSession = getSessionFn(event, importOptions, binding);
      if (!targetSession) {
        return {
          success: false,
          importedCount: 0,
          failedCount: 0,
          targetJar: '',
          error: 'TARGET_SESSION_REQUIRED: Explicit target session could not be resolved',
        };
      }
      return await this.importVaultFromFile(targetSession, customPath, {
        attachmentBinding: binding ? {
          attachmentId: binding.attachmentId,
          valid: binding.valid,
          isBound: Boolean(binding.attachmentId),
        } : undefined,
        requireAttachmentBinding: Boolean(options?.resolveAttachmentBinding),
      });
    });

    ipcMain.removeHandler('antifan:vault:import-json');
    ipcMain.handle('antifan:vault:import-json', async (event, jsonContent: string, importOptions?: unknown) => {
      if (!isAuthorized(event)) {
        return { success: false, importedCount: 0, failedCount: 0, targetJar: '', error: 'UNVERIFIED_SENDER' };
      }
      let binding: { valid: boolean; attachmentId?: string; error?: string } | undefined;
      if (options?.resolveAttachmentBinding) {
        binding = options.resolveAttachmentBinding(event, importOptions);
        if (!binding.valid) {
          return {
            success: false,
            importedCount: 0,
            failedCount: 0,
            targetJar: '',
            error: binding.error || 'ATTACHMENT_REQUIRED: Valid attachment binding required for cookie import',
          };
        }
      }
      const targetSession = getSessionFn(event, importOptions, binding);
      if (!targetSession) {
        return {
          success: false,
          importedCount: 0,
          failedCount: 0,
          targetJar: '',
          error: 'TARGET_SESSION_REQUIRED: Explicit target session could not be resolved',
        };
      }
      return await this.importVaultFromJson(targetSession, jsonContent, {
        attachmentBinding: binding ? {
          attachmentId: binding.attachmentId,
          valid: binding.valid,
          isBound: Boolean(binding.attachmentId),
        } : undefined,
        requireAttachmentBinding: Boolean(options?.resolveAttachmentBinding),
      });
    });

    ipcMain.removeHandler('antifan:vault:get-stats');
    ipcMain.handle('antifan:vault:get-stats', async (event, customPath?: string) => {
      if (!isAuthorized(event)) {
        return { exists: false, count: 0, filePath: '', error: 'UNVERIFIED_SENDER' };
      }
      return await this.getVaultStats(customPath);
    });
  }
}
