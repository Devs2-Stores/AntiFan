import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LocalCredentialVault,
  type SafeStorageLike,
} from '../../src/main/browser/local-credential-vault';

const FAKE_KEY = 'fake-vault-key-0123456789';
const PREFIX = `ENC:${FAKE_KEY}:`;

class FakeSafeStorage implements SafeStorageLike {
  public encryptionAvailable = true;

  public async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.encryptionAvailable;
  }

  public async encryptStringAsync(plainText: string): Promise<Buffer> {
    return Buffer.from(`${PREFIX}${plainText}`, 'utf8');
  }

  /** Plaintexts listed here fail to decrypt, to model one corrupt entry. */
  public readonly undecryptable = new Set<string>();

  public async decryptStringAsync(encrypted: Buffer): Promise<{ result: string }> {
    const text = encrypted.toString('utf8');
    if (!text.startsWith(PREFIX) || this.undecryptable.has(text.slice(PREFIX.length))) {
      throw new Error('FakeSafeStorage: bad ciphertext');
    }
    return { result: text.slice(PREFIX.length) };
  }
}

async function makeVault(options?: { safeStorage?: SafeStorageLike; filePath?: string; withSeed?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afbvault-'));
  const filePath = options?.filePath ?? path.join(dir, 'password-vault.json');
  const safeStorage = options?.safeStorage ?? new FakeSafeStorage();
  const vault = new LocalCredentialVault({ safeStorage, filePath });
  if (options?.withSeed) {
    await vault.save('https://accounts.example.com', 'admin', 's3cret!');
  }
  return { vault, filePath, dir, safeStorage };
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

describe('LocalCredentialVault', () => {
  it('saves a credential encrypted at rest (no plaintext on disk, no tmp leftovers)', async () => {
    const { vault, filePath, dir } = await makeVault();
    try {
      const res = await vault.save('https://accounts.example.com', 'admin', 'hunter2');
      assert.strictEqual(res.ok, true);
      assert.ok(res.data);
      assert.strictEqual(res.data.origin, 'https://accounts.example.com');
      assert.strictEqual(res.data.username, 'admin');
      assert.ok(!('passwordEnc' in res.data!), 'meta must not leak encrypted payload');
      assert.ok(!('password' in res.data!), 'meta must not expose decrypted password');

      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(raw.version, 1);
      assert.strictEqual(raw.entries.length, 1);
      const stored = raw.entries[0];
      assert.strictEqual(stored.passwordEnc, Buffer.from(`${PREFIX}hunter2`, 'utf8').toString('base64'));
      assert.ok(!raw.entries[0].password, 'credential stored only as ciphertext');
      const leftovers = fs.readdirSync(path.dirname(filePath)).filter((f) => f.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, []);
    } finally {
      cleanup(dir);
    }
  });

  it('updates the existing entry for the same origin+username instead of duplicating', async () => {
    const { vault, dir } = await makeVault();
    try {
      const first = await vault.save('https://a.example.com', 'u', 'pass-one');
      assert.strictEqual(first.ok, true);
      const firstId = first.data!.id;
      const second = await vault.save('https://a.example.com', 'u', 'pass-two');
      assert.strictEqual(second.ok, true);
      assert.strictEqual(second.data!.id, firstId);
      assert.strictEqual(vault.list().length, 1);
      const [liveCred] = await vault.getForOrigin('https://a.example.com');
      assert.ok(liveCred, 'expected a decrypted credential');
      assert.strictEqual(liveCred.password, 'pass-two');
    } finally {
      cleanup(dir);
    }
  });

  it('rejects non-http(s) origins and never persists them', async () => {
    const { vault, filePath, dir } = await makeVault();
    try {
      const bad = await vault.save('ftp://files.example.com', 'u', 'p');
      assert.strictEqual(bad.ok, false);
      assert.match(bad.error || '', /INVALID_ORIGIN/);
      assert.strictEqual((await vault.save('not-a-url', 'u', 'p')).ok, false);
      assert.strictEqual((await vault.save('', 'u', 'p')).ok, false);
      assert.strictEqual(vault.list().length, 0);
      assert.ok(!fs.existsSync(filePath), 'no store file should be written for rejected inputs');
    } finally {
      cleanup(dir);
    }
  });

  it('rejects empty passwords (fail-closed)', async () => {
    const { vault, dir } = await makeVault();
    try {
      const res = await vault.save('https://a.example.com', 'u', '');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'EMPTY_PASSWORD');
      assert.strictEqual(vault.list().length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('an unavailable async encryption refuses to save and returns no credentials', async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.encryptionAvailable = false;
    const { vault, filePath, dir } = await makeVault({ safeStorage });
    try {
      const res = await vault.save('https://a.example.com', 'u', 'p');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'ENCRYPTION_UNAVAILABLE');
      assert.deepStrictEqual(await vault.getForOrigin('https://a.example.com'), []);
      assert.ok(!fs.existsSync(filePath));
    } finally {
      cleanup(dir);
    }
  });

  it('lists meta by origin without exposing passwords', async () => {
    const { vault, dir } = await makeVault();
    try {
      await vault.save('https://one.example.com', 'a', 'pa');
      await vault.save('https://one.example.com', 'b', 'pb');
      await vault.save('https://two.example.com', 'c', 'pc');
      const one = vault.list('https://one.example.com');
      assert.strictEqual(one.length, 2);
      assert.deepStrictEqual(one.map((e) => e.username).sort(), ['a', 'b']);
      const all = vault.list();
      assert.strictEqual(all.length, 3);
      for (const entry of all) {
        assert.strictEqual(Object.hasOwn(entry, 'passwordEnc'), false);
        assert.strictEqual(Object.hasOwn(entry, 'password'), false);
      }
    } finally {
      cleanup(dir);
    }
  });

  it('returns decrypted credentials only for the matching origin', async () => {
    const { vault, dir } = await makeVault();
    try {
      await vault.save('https://one.example.com', 'a', 'pa');
      const creds = await vault.getForOrigin('https://one.example.com');
      assert.strictEqual(creds.length, 1);
      const [firstCred] = creds;
      assert.ok(firstCred, 'expected a decrypted credential');
      assert.strictEqual(firstCred.password, 'pa');
      assert.deepStrictEqual(await vault.getForOrigin('https://other.example.com'), []);
    } finally {
      cleanup(dir);
    }
  });

  it('persists across instances (same file, same encryption key)', async () => {
    const { filePath, dir } = await makeVault({ withSeed: true });
    try {
      const reloaded = new LocalCredentialVault({ safeStorage: new FakeSafeStorage(), filePath });
      assert.strictEqual(reloaded.list().length, 1);
      const [reloadedCred] = await reloaded.getForOrigin('https://accounts.example.com');
      assert.ok(reloadedCred, 'expected a decrypted credential');
      assert.strictEqual(reloadedCred.password, 's3cret!');
    } finally {
      cleanup(dir);
    }
  });

  it('removes a single credential by id and clears all', async () => {
    const { vault, dir } = await makeVault();
    try {
      await vault.save('https://one.example.com', 'a', 'pa');
      await vault.save('https://two.example.com', 'b', 'pb');
      const target = vault.list('https://one.example.com')[0];
      assert.ok(target, 'expected a seeded credential');
      const removed = vault.remove(target.id);
      assert.strictEqual(removed.ok, true);
      assert.strictEqual(removed.data!.removedCount, 1);
      assert.strictEqual(vault.list().length, 1);
      assert.strictEqual(vault.remove('no-such-id').ok, false);
      const cleared = vault.clear();
      assert.strictEqual(cleared.data!.removedCount, 1);
      assert.strictEqual(vault.list().length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('quarantines a corrupt store instead of overwriting it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afbvault-'));
    try {
      const filePath = path.join(dir, 'password-vault.json');
      fs.writeFileSync(filePath, '{ this is not valid json', 'utf8');
      const vault = new LocalCredentialVault({ safeStorage: new FakeSafeStorage(), filePath });
      assert.strictEqual(vault.list().length, 0);
      const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith('password-vault.json.corrupt-'));
      assert.strictEqual(quarantined.length, 1, 'corrupt file must be quarantined, not lost');
      const saved = await vault.save('https://a.example.com', 'u', 'p');
      assert.strictEqual(saved.ok, true);
    } finally {
      cleanup(dir);
    }
  });

  it('a decrypt failure on one entry does not hide the others', async () => {
    const safeStorage = new FakeSafeStorage();
    const { vault, dir } = await makeVault({ safeStorage });
    try {
      await vault.save('https://a.example.com', 'first', 'good-one');
      await vault.save('https://a.example.com', 'second', 'poisoned');
      await vault.save('https://a.example.com', 'third', 'good-two');
      safeStorage.undecryptable.add('poisoned');
      const creds = await vault.getForOrigin('https://a.example.com');
      assert.deepStrictEqual(creds.map((c) => c.password), ['good-one', 'good-two']);
    } finally {
      cleanup(dir);
    }
  });
});