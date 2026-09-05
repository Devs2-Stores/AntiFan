/**
 * AntiFan Browser Desktop — Local Credential Vault (password save & autofill)
 * 100% offline, local-first: passwords are encrypted with Electron `safeStorage`
 * (DPAPI on Windows) and persisted to `<configDir>/password-vault.json`.
 * No cloud, no extension, no plaintext at rest.
 *
 * The module itself is Electron-free: `SafeStorageLike` / `IpcMainLike` are
 * injected so the core can be unit-tested under plain Node while the app
 * bootstrap (native-tab-host, app-menu) wires the real Electron APIs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface VaultEntryMeta {
  id: string;
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
}

export interface VaultEntry extends VaultEntryMeta {
  passwordEnc: string; // base64(safeStorage.encryptString(password))
}

export interface DecryptedCredential {
  id: string;
  origin: string;
  username: string;
  password: string;
}

export interface VaultStoreFile {
  version: 1;
  entries: VaultEntry[];
}

export interface CredentialVaultOptions {
  safeStorage: SafeStorageLike;
  filePath: string;
  ipc?: IpcMainLike;
  /**
   * Main-process only: derives the REAL page origin from the IPC event
   * (`event.senderFrame.url`, top frame, HTTP(S) only). When provided, the
   * renderer-supplied origin is never trusted — save/get-for-origin resolve
   * the target origin exclusively from this resolver.
   */
  resolveEventOrigin?: (event: unknown) => string | null;
  /**
   * Main-process consent gate shown before persisting a password. Returning
   * false aborts the save (`CONSENT_DENIED`). Absent in unit tests means
   * save proceeds after origin validation.
   */
  requestSaveConsent?: (entry: { origin: string; username: string }) => boolean | Promise<boolean>;
}

export interface VaultResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

interface SenderFrameLike {
  url?: string;
}

/**
 * Fail-closed derivation of the page origin for an IPC event. Requires a TOP
 * frame (`event.senderFrame === event.sender.mainFrame`) with an http(s) URL.
 * Subframes, opaque frames (about:/file:/chrome:), and events missing a
 * mainFrame all resolve to null so callers refuse rather than trust the
 * renderer. Electron-free: typed against the event shape only.
 */
export function resolveSenderFrameOrigin(event: unknown): string | null {
  const ipcEvent = (event ?? null) as {
    senderFrame?: SenderFrameLike | null;
    sender?: { mainFrame?: unknown } | null;
  } | null;
  if (!ipcEvent) return null;
  const frame = ipcEvent.senderFrame;
  if (!frame || typeof frame.url !== 'string') return null;
  const mainFrame = ipcEvent.sender?.mainFrame;
  if (mainFrame === undefined || frame !== mainFrame) return null;
  try {
    const parsed = new URL(frame.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export class LocalCredentialVault {
  private static instance: LocalCredentialVault | null = null;
  public static readonly DEFAULT_VAULT_FILENAME = 'password-vault.json';

  private readonly safeStorage: SafeStorageLike;
  private readonly filePath: string;
  private readonly ipc?: IpcMainLike;
  private readonly resolveEventOrigin?: (event: unknown) => string | null;
  private readonly requestSaveConsent?: (entry: { origin: string; username: string }) => boolean | Promise<boolean>;
  private entries: VaultEntry[] = [];

  public constructor(options: CredentialVaultOptions) {
    this.safeStorage = options.safeStorage;
    this.filePath = options.filePath;
    this.ipc = options.ipc;
    this.resolveEventOrigin = options.resolveEventOrigin;
    this.requestSaveConsent = options.requestSaveConsent;
    this.loadStore();
  }

  /**
   * Lazily creates (once) the app-wide vault. Callers pass the real Electron
   * safeStorage/ipcMain; unit tests instantiate `new LocalCredentialVault()`.
   */
  public static getInstance(options?: CredentialVaultOptions): LocalCredentialVault {
    if (!LocalCredentialVault.instance) {
      if (!options) {
        throw new Error('[LocalCredentialVault] Instance not bootstrapped; pass options on first getInstance() call');
      }
      LocalCredentialVault.instance = new LocalCredentialVault(options);
    }
    return LocalCredentialVault.instance;
  }

  public static resetInstanceForTests(): void {
    LocalCredentialVault.instance = null;
  }

  public getVaultFilePath(): string {
    return this.filePath;
  }

  private loadStore(): void {
    if (!fs.existsSync(this.filePath)) {
      this.entries = [];
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: VaultStoreFile = JSON.parse(raw);
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.filter((e) => e && typeof e.id === 'string' && typeof e.origin === 'string');
      }
    } catch (err) {
      // Corrupt store: never silently overwrite — quarantine the file and start empty.
      try {
        const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
        fs.renameSync(this.filePath, backupPath);
        console.warn(`[LocalCredentialVault] Corrupt vault file quarantined to ${backupPath}:`, err);
      } catch {}
      this.entries = [];
    }
  }

  private persistStore(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const store: VaultStoreFile = { version: 1, entries: this.entries };
    const tmpFile = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmpFile, this.filePath);
  }

  private sanitizeOrigin(origin: string): string | null {
    if (!origin || typeof origin !== 'string') return null;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }

  /**
   * Saves (or updates) one credential for an origin. Fail-closed: if OS-level
   * encryption is unavailable, the password is NOT persisted.
   */
  public save(origin: string, username: string, password: string): VaultResult<VaultEntryMeta> {
    const cleanOrigin = this.sanitizeOrigin(origin);
    if (!cleanOrigin) {
      return { ok: false, error: `INVALID_ORIGIN: ${origin}` };
    }
    const cleanUsername = String(username ?? '').trim();
    const cleanPassword = String(password ?? '');
    if (cleanPassword.length === 0) {
      return { ok: false, error: 'EMPTY_PASSWORD' };
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'ENCRYPTION_UNAVAILABLE' };
    }

    const encrypted = this.safeStorage.encryptString(cleanPassword);
    const passwordEnc = encrypted.toString('base64');
    const now = Date.now();

    const existing = this.entries.find((e) => e.origin === cleanOrigin && e.username === cleanUsername);
    if (existing) {
      existing.passwordEnc = passwordEnc;
      existing.updatedAt = now;
    } else {
      this.entries.push({
        id: crypto.randomUUID(),
        origin: cleanOrigin,
        username: cleanUsername,
        passwordEnc,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.persistStore();
    const saved = this.entries.find((e) => e.origin === cleanOrigin && e.username === cleanUsername);
    return { ok: true, data: saved ? this.toMeta(saved) : undefined };
  }

  public list(origin?: string): VaultEntryMeta[] {
    const cleanOrigin = origin ? this.sanitizeOrigin(origin) : null;
    return this.entries
      .filter((e) => !cleanOrigin || e.origin === cleanOrigin)
      .map((e) => this.toMeta(e));
  }

  /**
   * Returns decrypted credentials for autofill. Empty when encryption is
   * unavailable or nothing matches the origin.
   */
  public getForOrigin(origin: string): DecryptedCredential[] {
    const cleanOrigin = this.sanitizeOrigin(origin);
    if (!cleanOrigin || !this.safeStorage.isEncryptionAvailable()) return [];
    const result: DecryptedCredential[] = [];
    for (const entry of this.entries) {
      if (entry.origin !== cleanOrigin) continue;
      try {
        const password = this.safeStorage.decryptString(Buffer.from(entry.passwordEnc, 'base64'));
        result.push({ id: entry.id, origin: entry.origin, username: entry.username, password });
      } catch (err) {
        console.warn(`[LocalCredentialVault] Failed to decrypt credential ${entry.id}:`, err);
      }
    }
    return result;
  }

  public remove(id: string): VaultResult<{ removedCount: number }> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    const removedCount = before - this.entries.length;
    if (removedCount > 0) {
      this.persistStore();
    }
    return { ok: removedCount > 0, data: { removedCount } };
  }

  public clear(): VaultResult<{ removedCount: number }> {
    const removedCount = this.entries.length;
    this.entries = [];
    if (removedCount > 0) {
      this.persistStore();
    }
    return { ok: true, data: { removedCount } };
  }

  private toMeta(entry: VaultEntry): VaultEntryMeta {
    return {
      id: entry.id,
      origin: entry.origin,
      username: entry.username,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  public registerIpcHandlers(): void {
    if (!this.ipc) return;

    // Save: object payload; the target origin is derived from the (main-process)
    // sender frame — the renderer never chooses which site the password is
    // stored for. The renderer SHOULD send `origin` (its own location.origin)
    // as a cross-check: if it disagrees with the sender frame the payload is
    // rejected (ORIGIN_MISMATCH) because the frame is authoritative. Consent
    // (if wired) gates the write with a trusted main-process dialog.
    this.ipc.removeHandler('antifan:password:save');
    this.ipc.handle('antifan:password:save', async (event: unknown, payload: unknown) => {
      const origin = this.resolveEventOrigin ? this.resolveEventOrigin(event) : null;
      if (origin === null) {
        return { ok: false, error: 'UNVERIFIED_ORIGIN' };
      }
      const p = (payload && typeof payload === 'object' ? payload : {}) as {
        origin?: unknown;
        username?: unknown;
        password?: unknown;
      };
      // An origin supplied by the renderer that disagrees with the sender
      // frame gets rejected — the frame is authoritative.
      if (typeof p.origin === 'string' && p.origin.length > 0 && p.origin !== origin) {
        return { ok: false, error: 'ORIGIN_MISMATCH' };
      }
      const username = typeof p.username === 'string' ? p.username : '';
      const password = typeof p.password === 'string' ? p.password : '';
      if (this.requestSaveConsent) {
        const granted = await this.requestSaveConsent({ origin, username });
        if (!granted) {
          return { ok: false, error: 'CONSENT_DENIED' };
        }
      }
      return this.save(origin, username, password);
    });

    this.ipc.removeHandler('antifan:password:list');
    this.ipc.handle('antifan:password:list', (_event, origin?: unknown) => {
      return this.list(typeof origin === 'string' ? origin : undefined);
    });

    // Autofill: origin is always the sender frame's origin — no renderer
    // argument can request another site's decrypted credential.
    this.ipc.removeHandler('antifan:password:get-for-origin');
    this.ipc.handle('antifan:password:get-for-origin', (event: unknown) => {
      const origin = this.resolveEventOrigin ? this.resolveEventOrigin(event) : null;
      return origin ? this.getForOrigin(origin) : [];
    });

    this.ipc.removeHandler('antifan:password:remove');
    this.ipc.handle('antifan:password:remove', (_event, id: unknown) => {
      return this.remove(String(id ?? ''));
    });

    this.ipc.removeHandler('antifan:password:clear');
    this.ipc.handle('antifan:password:clear', () => {
      return this.clear();
    });
  }
}