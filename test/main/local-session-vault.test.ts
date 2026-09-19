import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalSessionVault, VaultCookie, isTrustedSessionVaultSender } from '../../src/main/browser/local-session-vault';
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

  it('rejects an empty cookie array instead of reporting a successful no-op import', async () => {
    // Pre-fix this returned `success: true` with zero cookies, which is how a
    // bundled "sync" looked successful while nothing had been written.
    const mockSession = new MockElectronSession();
    const vault = LocalSessionVault.getInstance();
    const res = await vault.importVaultFromJson(mockSession as any, []);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.importedCount, 0);
    assert.strictEqual(res.failedCount, 0);
    assert.ok(res.error && res.error.startsWith('EMPTY_IMPORT_REJECTED'), `error was '${res.error}'`);
    assert.ok(res.targetJar.length > 0, 'every refusal must name the jar it refused to touch');
    assert.strictEqual(mockSession.cookies.flushed, false, 'a refused import must not touch the store');
  });

  it('rejects credential operations against a non-durable (ephemeral) jar', async () => {
    const ephemeralSession = new MockElectronSession();
    // Non-persistent is what an in-memory jar reports: the write would be
    // accepted and then vanish with the process.
    (ephemeralSession as unknown as { isPersistent: () => boolean }).isPersistent = () => false;
    await ephemeralSession.cookies.set({ name: 'seed', value: 'v', domain: '.example.com', path: '/' });

    const vault = LocalSessionVault.getInstance();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-ephemeral-'));
    const tempFile = path.join(tempDir, 'ephemeral-vault.json');
    try {
      const exportRes = await vault.exportVaultToFile(ephemeralSession as any, tempFile);
      assert.strictEqual(exportRes.success, false);
      assert.ok(exportRes.error?.startsWith('EPHEMERAL_TARGET_REJECTED'), `error was '${exportRes.error}'`);
      assert.strictEqual(fs.existsSync(tempFile), false, 'a refused export must not write a file');

      const importRes = await vault.importVaultFromJson(ephemeralSession as any, [
        { name: 'a', value: 'b', domain: '.example.com', path: '/' },
      ]);
      assert.strictEqual(importRes.success, false);
      assert.ok(importRes.error?.startsWith('EPHEMERAL_TARGET_REJECTED'), `error was '${importRes.error}'`);
      assert.strictEqual(importRes.importedCount, 0);

      const cdpRes = await vault.importFromLiveChromeCDP(ephemeralSession as any, 9222);
      assert.strictEqual(cdpRes.success, false);
      assert.ok(cdpRes.message.startsWith('EPHEMERAL_TARGET_REJECTED'), `message was '${cdpRes.message}'`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses an export that would overwrite the vault with an empty store', async () => {
    const emptySession = new MockElectronSession();
    const vault = LocalSessionVault.getInstance();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-empty-'));
    const tempFile = path.join(tempDir, 'existing-vault.json');
    fs.writeFileSync(tempFile, JSON.stringify([{ name: 'keep', value: 'me' }]), 'utf8');
    try {
      const res = await vault.exportVaultToFile(emptySession as any, tempFile);
      assert.strictEqual(res.success, false);
      assert.ok(res.error?.startsWith('EMPTY_STORE_REJECTED'), `error was '${res.error}'`);
      assert.strictEqual(fs.readFileSync(tempFile, 'utf8'), JSON.stringify([{ name: 'keep', value: 'me' }]), 'the last good backup must survive');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports ZERO_COOKIES_IMPORTED when every record in a non-empty source is rejected', async () => {
    const mockSession = new MockElectronSession();
    const vault = LocalSessionVault.getInstance();
    const res = await vault.importVaultFromJson(mockSession as any, [{ noNameField: true }, 'not-an-object', 7] as unknown as VaultCookie[]);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.importedCount, 0);
    assert.strictEqual(res.failedCount, 3);
    assert.ok(res.error?.startsWith('ZERO_COOKIES_IMPORTED'), `error was '${res.error}'`);
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

  it('Phase 5: isTrustedSessionVaultSender accepts only top-frame internal/toolbar senders', () => {
    // Top-frame file: renderer (toolbar) and antifan: scheme: trusted.
    const toolbarFrame = { url: 'file:///C:/AntiFan/renderer/toolbar.html' };
    const sidebarFrame = { url: 'file:///C:/AntiFan/renderer/sidebar.html' };
    const shellFrame = { url: 'antifan://shell/index.html' };
    const evilFrame = { url: 'https://evil.example.com/' };
    assert.strictEqual(isTrustedSessionVaultSender({ senderFrame: toolbarFrame, sender: { mainFrame: toolbarFrame } }), true);
    assert.strictEqual(isTrustedSessionVaultSender({ senderFrame: sidebarFrame, sender: { mainFrame: sidebarFrame } }), true);
    assert.strictEqual(isTrustedSessionVaultSender({ senderFrame: shellFrame, sender: { mainFrame: shellFrame } }), true);
    // Hostile external page in a real tab: never trusted.
    assert.strictEqual(isTrustedSessionVaultSender({ senderFrame: evilFrame, sender: { mainFrame: evilFrame } }), false);
    // Subframe of trusted toolbar page: rejected (senderFrame !== mainFrame identity).
    assert.strictEqual(isTrustedSessionVaultSender({ senderFrame: { url: 'https://ads.example.com/iframe' }, sender: { mainFrame: toolbarFrame } }), false);
    // Missing mainFrame: fail-closed.
    assert.strictEqual(isTrustedSessionVaultSender({ senderFrame: toolbarFrame }), false);
    // Missing senderFrame entirely: fail-closed.
    assert.strictEqual(isTrustedSessionVaultSender({}), false);
    // null event: fail-closed.
    assert.strictEqual(isTrustedSessionVaultSender(null), false);
  });

  it('reports Google sign-in cookie presence on export so a jar of tracking cookies is not mistaken for a login', async () => {
    const mockSession = new MockElectronSession();
    // One sign-in credential plus cookies that say nothing about auth.
    await mockSession.cookies.set({ name: 'SID', value: 'sid', domain: '.google.com', path: '/' });
    await mockSession.cookies.set({ name: 'NID', value: 'nid', domain: '.google.com', path: '/' });
    await mockSession.cookies.set({ name: 'SID', value: 'impostor', domain: '.notgoogle.com', path: '/' });
    await mockSession.cookies.set({ name: 'haravan_session', value: 's', domain: '.myharavan.com', path: '/' });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-google-auth-'));
    const tempFile = path.join(tempDir, 'session-vault.json');
    try {
      const res = await LocalSessionVault.getInstance().exportVaultToFile(mockSession as any, tempFile);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.count, 4);
      assert.strictEqual(res.googleAuthCount, 1, 'only SID@.google.com is a Google sign-in credential');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('counts only real Google sign-in cookies when importing a vault', async () => {
    const mockSession = new MockElectronSession();
    const res = await LocalSessionVault.getInstance().importVaultFromJson(mockSession as any, [
      { name: '__Secure-1PSID', value: 'v', domain: '.google.com', path: '/' },
      { name: 'LOGIN_INFO', value: 'v', domain: '.youtube.com', path: '/' },
      { name: 'SID', value: 'v', domain: '.google.com.evil.test', path: '/' },
      { name: 'OTZ', value: 'v', domain: '.google.com', path: '/' },
      { name: 'SSID', value: 'v', domain: '.google.com.vn', path: '/' },
    ]);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.importedCount, 5);
    assert.strictEqual(res.googleAuthCount, 3, 'PSID + LOGIN_INFO + SSID@google.com.vn are auth; OTZ and a lookalike host are not');
  });
});
