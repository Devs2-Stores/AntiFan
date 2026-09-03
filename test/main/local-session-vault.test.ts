import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalSessionVault, VaultCookie } from '../../src/main/browser/local-session-vault';
import { ChromeProfileSyncManager } from '../../src/main/browser/chrome-profile-sync';

class MockCookieStore {
  public cookies: Map<string, Record<string, unknown>> = new Map();
  public flushed = false;

  public async set(details: Record<string, unknown>): Promise<void> {
    const key = `${details.domain || ''}|${details.path || '/'}|${details.name}`;
    this.cookies.set(key, { ...details });
  }

  public async get(_query: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    return Array.from(this.cookies.values());
  }

  public async flushStore(): Promise<void> {
    this.flushed = true;
  }
}

class MockElectronSession {
  public cookies = new MockCookieStore();
}

describe('LocalSessionVault & Shared Profile Persistence Suite', () => {
  it('exports session cookies to clean portable JSON vault file', async () => {
    const mockSession = new MockElectronSession();
    await mockSession.cookies.set({
      name: 'SSID',
      value: 'secure_auth_token_123',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 86400,
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
    const tempFile = path.join(tempDir, 'test-vault.json');

    try {
      const vault = LocalSessionVault.getInstance();
      const exportRes = await vault.exportVaultToFile(mockSession as any, tempFile);

      assert.strictEqual(exportRes.success, true);
      assert.strictEqual(exportRes.count, 1);
      assert.strictEqual(fs.existsSync(tempFile), true);

      const raw = fs.readFileSync(tempFile, 'utf8');
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0].name, 'SSID');
      assert.strictEqual(parsed[0].value, 'secure_auth_token_123');
      assert.strictEqual(parsed[0].domain, '.google.com');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('imports cookies from JSON array and applies 30-day durable fallback TTL for session cookies', async () => {
    const mockSession = new MockElectronSession();
    const vault = LocalSessionVault.getInstance();

    const cookiesToImport: VaultCookie[] = [
      {
        name: 'haravan_session',
        value: 'sess_abc123',
        domain: '.myharavan.com',
        path: '/',
        secure: true,
        httpOnly: true,
        // No expirationDate -> session cookie!
      },
      {
        name: 'user_pref',
        value: 'dark_theme',
        domain: '.example.com',
        path: '/',
        secure: false,
        httpOnly: false,
        expirationDate: 1893456000, // Explicit future timestamp
      },
    ];

    const importRes = await vault.importVaultFromJson(mockSession as any, cookiesToImport);

    assert.strictEqual(importRes.success, true);
    assert.strictEqual(importRes.importedCount, 2);
    assert.strictEqual(importRes.failedCount, 0);
    assert.strictEqual(mockSession.cookies.flushed, true, 'Must call cookies.flushStore() after import');

    const imported = Array.from(mockSession.cookies.cookies.values());
    const sessCookie = imported.find((c) => c.name === 'haravan_session');
    assert.ok(sessCookie);
    assert.ok(typeof sessCookie.expirationDate === 'number');
    const nowSec = Math.floor(Date.now() / 1000);
    // Durable fallback TTL should be ~30 days in future (> 25 days)
    assert.ok((sessCookie.expirationDate as number) > nowSec + 25 * 86400);

    const explicitCookie = imported.find((c) => c.name === 'user_pref');
    assert.ok(explicitCookie);
    assert.strictEqual(explicitCookie.expirationDate, 1893456000);
  });

  it('reports accurate vault stats from disk', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-stats-test-'));
    const tempFile = path.join(tempDir, 'session-vault.json');
    fs.writeFileSync(tempFile, JSON.stringify([{ name: 'c1', value: 'v1' }, { name: 'c2', value: 'v2' }]), 'utf8');

    try {
      const vault = LocalSessionVault.getInstance();
      const stats = await vault.getVaultStats(tempFile);
      assert.strictEqual(stats.exists, true);
      assert.strictEqual(stats.count, 2);
      assert.ok(typeof stats.lastModified === 'number');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('imports empty cookie array with success true and zero count', async () => {
    const mockSession = new MockElectronSession();
    const vault = LocalSessionVault.getInstance();
    const res = await vault.importVaultFromJson(mockSession as any, []);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.importedCount, 0);
    assert.strictEqual(res.failedCount, 0);
  });

  it('correctly maps CDP cookie expires and title-case sameSite None to no_restriction', async () => {
    const mockSession = new MockElectronSession();
    const vault = LocalSessionVault.getInstance();

    // Chrome CDP Network.getAllCookies format
    const cdpCookies = [
      {
        name: 'SAPISID',
        value: 'sapisid_value',
        domain: '.google.com',
        path: '/',
        expires: 1893456789,
        secure: true,
        httpOnly: false,
        sameSite: 'None', // Capitalized CDP value
      },
      {
        name: 'haravan_token',
        value: 'tok_123',
        domain: '.myharavan.com',
        path: '/',
        expires: 1893456999,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ];

    const res = await vault.importVaultFromJson(mockSession as any, cdpCookies);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.importedCount, 2);

    const imported = Array.from(mockSession.cookies.cookies.values());
    const sapisid = imported.find((c) => c.name === 'SAPISID');
    assert.ok(sapisid);
    assert.strictEqual(sapisid.expirationDate, 1893456789);
    assert.strictEqual(sapisid.sameSite, 'no_restriction', 'Must map CDP None to Chromium no_restriction');

    const hToken = imported.find((c) => c.name === 'haravan_token');
    assert.ok(hToken);
    assert.strictEqual(hToken.expirationDate, 1893456999);
    assert.strictEqual(hToken.sameSite, 'lax');
  });
});
