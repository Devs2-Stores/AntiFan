/**
 * Security contract of the password vault IPC layer.
 *
 * Regression for review findings: the renderer must never supply the target
 * origin. `save` and `get-for-origin` resolve the origin from the (main-process)
 * sender frame, save uses an object payload (not positional args), and a
 * main-process consent callback can reject the write (CONSENT_DENIED).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalCredentialVault, resolveSenderFrameOrigin, type SafeStorageLike } from '../../src/main/browser/local-credential-vault';

const FAKE_KEY = 'fake-vault-key-0123456789';
const PREFIX = `ENC:${FAKE_KEY}:`;

class FakeSafeStorage implements SafeStorageLike {
  public encryptionAvailable = true;

  public isEncryptionAvailable(): boolean {
    return this.encryptionAvailable;
  }

  public encryptString(plainText: string): Buffer {
    return Buffer.from(`${PREFIX}${plainText}`, 'utf8');
  }

  public decryptString(encrypted: Buffer): string {
    const text = encrypted.toString('utf8');
    return text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
  }
}

class FakeIpc {
  public handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

  public handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }

  public removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  public async invokeEvent(channel: string, event: unknown, ...args: unknown[]): Promise<any> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return await handler(event, ...args);
  }

  /** Top-frame event: senderFrame === sender.mainFrame (identity, like Electron). */
  public async invoke(channel: string, frameUrl: string, ...args: unknown[]): Promise<any> {
    const frame = { url: frameUrl };
    return await this.invokeEvent(channel, { senderFrame: frame, sender: { mainFrame: frame } }, ...args);
  }
}

function makeContext(options?: { frameUrl?: string; resolver?: ((event: unknown) => string | null) | null; consent?: (entry: { origin: string; username: string }) => boolean | Promise<boolean> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afbpw-'));
  const ipc = new FakeIpc();
  const vault = new LocalCredentialVault({
    safeStorage: new FakeSafeStorage(),
    filePath: path.join(dir, 'password-vault.json'),
    ipc: ipc as never,
    resolveEventOrigin: options?.resolver !== null ? (options?.resolver ?? resolveSenderFrameOrigin) : undefined,
    requestSaveConsent: options?.consent,
  });
  vault.registerIpcHandlers();
  return { vault, ipc, dir };
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

describe('Password vault IPC security', () => {
  it('save stores to the sender-frame origin from an object payload', async () => {
    const { vault, ipc, dir } = makeContext();
    try {
      const res = await ipc.invoke('antifan:password:save', 'https://accounts.example.com/', {
        username: 'admin',
        password: 's3cret!',
      });
      assert.strictEqual(res?.ok, true);
      const entries = vault.list();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]!.origin, 'https://accounts.example.com');
      assert.strictEqual(entries[0]!.username, 'admin');
      const creds = vault.getForOrigin('https://accounts.example.com');
      assert.strictEqual(creds.length, 1);
      assert.strictEqual(creds[0]!.password, 's3cret!');
    } finally {
      cleanup(dir);
    }
  });

  it('refuses to save when the sender-frame origin cannot be verified', async () => {
    const { vault, ipc, dir } = makeContext({ resolver: () => null });
    try {
      const res = await ipc.invoke('antifan:password:save', 'https://accounts.example.com/', {
        username: 'admin',
        password: 's3cret!',
      });
      assert.strictEqual(res?.ok, false);
      assert.strictEqual(res?.error, 'UNVERIFIED_ORIGIN');
      assert.strictEqual(vault.list().length, 0, 'Nothing may be persisted without a verified origin');
    } finally {
      cleanup(dir);
    }
  });

  it('respects the main-process consent gate: denied consent persists nothing', async () => {
    const { vault, ipc, dir } = makeContext({ consent: () => false });
    try {
      const res = await ipc.invoke('antifan:password:save', 'https://accounts.example.com/', {
        username: 'admin',
        password: 's3cret!',
      });
      assert.strictEqual(res?.ok, false);
      assert.strictEqual(res?.error, 'CONSENT_DENIED');
      assert.strictEqual(vault.list().length, 0, 'Denied consent must abort the write');
    } finally {
      cleanup(dir);
    }
  });

  it('allows save when consent is granted', async () => {
    const { vault, ipc, dir } = makeContext({ consent: () => true });
    try {
      const res = await ipc.invoke('antifan:password:save', 'https://accounts.example.com/', {
        username: 'admin',
        password: 's3cret!',
      });
      assert.strictEqual(res?.ok, true);
      assert.strictEqual(vault.list().length, 1);
    } finally {
      cleanup(dir);
    }
  });

  it('get-for-origin only ever returns credentials for the sender-frame origin', async () => {
    const { vault, ipc, dir } = makeContext();
    try {
      await ipc.invoke('antifan:password:save', 'https://accounts.example.com/', {
        username: 'admin',
        password: 's3cret!',
      });
      // A page on a DIFFERENT origin must receive nothing, even though it asks.
      const other = await ipc.invoke('antifan:password:get-for-origin', 'https://evil.example/');
      assert.deepStrictEqual(other, []);
      const owner = await ipc.invoke('antifan:password:get-for-origin', 'https://accounts.example.com/');
      assert.ok(Array.isArray(owner));
      assert.strictEqual(owner.length, 1);
      assert.strictEqual((owner[0] as { powerPassword?: never } & { password: string }).password, 's3cret!');
    } finally {
      cleanup(dir);
    }
  });

  it('get-for-origin fails closed ([]) when origin resolution is unavailable', async () => {
    const { ipc, dir } = makeContext({ resolver: () => null });
    try {
      const res = await ipc.invoke('antifan:password:get-for-origin', 'https://accounts.example.com/');
      assert.deepStrictEqual(res, []);
    } finally {
      cleanup(dir);
    }
  });

  it('rejects the legacy positional-args contract (empty payload is not a save)', async () => {
    const { vault, ipc, dir } = makeContext();
    try {
      const res = await ipc.invoke('antifan:password:save', 'https://accounts.example.com/', 'https://evil.example/', 'admin', 'pw');
      // String payload is not the object contract: username/password are empty → EMPTY_PASSWORD
      assert.strictEqual(res?.ok, false);
      assert.strictEqual(res?.error, 'EMPTY_PASSWORD');
      assert.strictEqual(vault.list().length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('rejects a payload whose origin disagrees with the sender frame (ORIGIN_MISMATCH)', async () => {
    const { vault, ipc, dir } = makeContext();
    try {
      const res = await ipc.invoke('antifan:password:save', 'https://accounts.example.com/', {
        origin: 'https://evil.example/',
        username: 'admin',
        password: 's3cret!',
      });
      assert.strictEqual(res?.ok, false);
      assert.strictEqual(res?.error, 'ORIGIN_MISMATCH');
      assert.strictEqual(vault.list().length, 0, 'Mismatched payload must never be stored');
      // A matching origin in the payload is tolerated (frame only is authoritative).
      const matched = await ipc.invoke('antifan:password:save', 'https://accounts.example.com/', {
        origin: 'https://accounts.example.com',
        username: 'admin',
        password: 's3cret!',
      });
      assert.strictEqual(matched?.ok, true);
      assert.strictEqual(vault.list().length, 1);
    } finally {
      cleanup(dir);
    }
  });

  it('refuses save from a subframe (senderFrame !== mainFrame)', async () => {
    const { vault, ipc, dir } = makeContext();
    try {
      const topFrame = { url: 'https://accounts.example.com/' };
      const subFrame = { url: 'https://accounts.example.com/iframe' };
      const res = await ipc.invokeEvent(
        'antifan:password:save',
        { senderFrame: subFrame, sender: { mainFrame: topFrame } },
        { username: 'admin', password: 's3cret!' }
      );
      assert.strictEqual(res?.ok, false);
      assert.strictEqual(res?.error, 'UNVERIFIED_ORIGIN');
      assert.strictEqual(vault.list().length, 0, 'subframe saves must be refused');
    } finally {
      cleanup(dir);
    }
  });
});

describe('resolveSenderFrameOrigin (fail-closed top-frame resolver)', () => {
  const frame = (url: string) => ({ url });

  it('returns null for missing events, missing frames, or frames without a URL', () => {
    assert.strictEqual(resolveSenderFrameOrigin(null), null);
    assert.strictEqual(resolveSenderFrameOrigin(undefined), null);
    assert.strictEqual(resolveSenderFrameOrigin({}), null);
    assert.strictEqual(resolveSenderFrameOrigin({ senderFrame: null }), null);
    assert.strictEqual(resolveSenderFrameOrigin({ senderFrame: {} }), null);
  });

  it('returns null when the frame has no mainFrame (fail-closed, not soft-pass)', () => {
    const f = frame('https://accounts.example.com/');
    assert.strictEqual(resolveSenderFrameOrigin({ senderFrame: f }), null);
    assert.strictEqual(resolveSenderFrameOrigin({ senderFrame: f, sender: {} }), null);
  });

  it('returns null for subframes', () => {
    const top = frame('https://accounts.example.com/');
    const sub = frame('https://accounts.example.com/iframe');
    assert.strictEqual(resolveSenderFrameOrigin({ senderFrame: sub, sender: { mainFrame: top } }), null);
  });

  it('returns null for non-http(s) URLs (about:, file:, chrome:)', () => {
    const main = frame('about:blank');
    assert.strictEqual(resolveSenderFrameOrigin({ senderFrame: main, sender: { mainFrame: main } }), null);
    const file = frame('file:///C:/index.html');
    assert.strictEqual(resolveSenderFrameOrigin({ senderFrame: file, sender: { mainFrame: file } }), null);
  });

  it('returns the exact http(s) origin only for top frames', () => {
    const main = frame('https://accounts.example.com/login?next=/x#top');
    assert.strictEqual(resolveSenderFrameOrigin({ senderFrame: main, sender: { mainFrame: main } }), 'https://accounts.example.com');
    const insecure = frame('http://shop.example.com/');
    assert.strictEqual(resolveSenderFrameOrigin({ senderFrame: insecure, sender: { mainFrame: insecure } }), 'http://shop.example.com');
  });
});