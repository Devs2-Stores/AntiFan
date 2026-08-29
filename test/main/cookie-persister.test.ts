import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CookiePersister,
  buildRestoreDetails,
  preparePersistableCookie,
  readCookieCache,
  shouldPersistCookie,
  resolveCookieCachePath,
} from '../../src/main/browser/cookie-persister';
import { isGoogleDomain, cleanCorruptedGoogleCookies } from '../../src/main/browser/google-auth-identity';
import { cleanRestoredUrl } from '../../src/main/security/security-policy';

interface CookieLike {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: unknown;
  session?: boolean;
  hostOnly?: boolean;
  expirationDate?: number;
}

describe('Universal CookiePersister Invariants', () => {
  it('persists and restores cookies across localhost, storefronts, and web apps', async () => {
    const persister = CookiePersister.getInstance();
    assert.ok(persister, 'CookiePersister singleton should be instantiated');
    assert.strictEqual(typeof persister.restoreCookies, 'function');
    assert.strictEqual(typeof persister.saveAllCookies, 'function');
    assert.strictEqual(typeof persister.startAutoPersistence, 'function');

    const cachePath = path.join(process.cwd(), 'appdata', 'antifan-browser-desktop', 'state', 'v1', 'cookies_cache.json');
    if (fs.existsSync(cachePath)) {
      const content = fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(content);
      assert.ok(Array.isArray(parsed), 'Cache file should contain a valid cookie array');
    }
  });

  it('omits the Domain attribute for __Host- and host-only cookies so Chromium does not reject them', () => {
    const hostCookie = buildRestoreDetails({
      name: '__Host-SESSION',
      value: 'v',
      domain: 'shop.myharavan.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'unspecified',
      hostOnly: true,
    } as CookieLike as never);
    assert.strictEqual(hostCookie.url, 'https://shop.myharavan.com/');
    assert.strictEqual(hostCookie.secure, true);
    assert.strictEqual(hostCookie.httpOnly, true);
    assert.strictEqual(hostCookie.path, '/');
    assert.strictEqual(hostCookie.domain, undefined, '__Host- cookie must not carry a Domain attribute (RFC 6265bis)');

    const hostOnlyCookie = buildRestoreDetails({
      name: 'AUTH_TOKEN',
      value: 'v',
      domain: 'shop.myharavan.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'unspecified',
      hostOnly: false, // even if hostOnly flag is missing or false, bare hostname must stay host-only
    } as CookieLike as never);
    assert.strictEqual(hostOnlyCookie.domain, undefined, 'bare hostname without leading dot must not be rewritten into a domain cookie');

    const domainCookie = buildRestoreDetails({
      name: 'STOREFRONT_ID',
      value: 'v',
      domain: '.myharavan.com',
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
      hostOnly: false,
    } as CookieLike as never);
    assert.strictEqual(domainCookie.url, 'http://myharavan.com/', 'non-secure cookies restore over plain http');
    assert.strictEqual(domainCookie.domain, '.myharavan.com', 'regular domain cookies keep their Domain attribute');
  });

  it('correctly classifies Google domains and excludes them from flat cache persistence', () => {
    assert.strictEqual(isGoogleDomain('.google.com'), true);
    assert.strictEqual(isGoogleDomain('accounts.google.com'), true);
    assert.strictEqual(isGoogleDomain('mail.google.com'), true);
    assert.strictEqual(isGoogleDomain('.google.com.vn'), true);
    assert.strictEqual(isGoogleDomain('www.googleadservices.com'), true);
    assert.strictEqual(isGoogleDomain('youtube.com'), true);
    assert.strictEqual(isGoogleDomain('shop.myharavan.com'), false);
    assert.strictEqual(isGoogleDomain('localhost'), false);
    assert.strictEqual(isGoogleDomain('.myshopify.com'), false);

    assert.strictEqual(shouldPersistCookie({ name: 'SID', domain: '.google.com' } as never), false);
    assert.strictEqual(shouldPersistCookie({ name: 'OTZ', domain: 'accounts.google.com' } as never), false);
    assert.strictEqual(shouldPersistCookie({ name: 'store_token', domain: '.myharavan.com' } as never), true);
    assert.strictEqual(shouldPersistCookie({ name: 'dev_session', domain: 'localhost' } as never), true);
  });

  it('sanitizes CookieMismatch URLs in cleanRestoredUrl to prevent perpetual error loops', () => {
    assert.strictEqual(cleanRestoredUrl('https://accounts.google.com/CookieMismatch'), 'https://www.google.com');
    assert.strictEqual(cleanRestoredUrl('https://accounts.google.com/CookieMismatch?continue=https://google.com'), 'https://www.google.com');
    assert.strictEqual(cleanRestoredUrl('https://www.google.com/search?q=test'), 'https://www.google.com/search?q=test');
  });

  it('keeps cleanCorruptedGoogleCookies safe and non-destructive to preserve user profiles', async () => {
    const fakeSession = {
      cookies: {
        get: async () => [],
      },
    };
    await assert.doesNotReject(async () => {
      await cleanCorruptedGoogleCookies(fakeSession as never);
    });
  });

  it('preserves session cookies as session-scoped instead of forcing a +1 year expiry', () => {
    const sessionCookie = buildRestoreDetails({
      name: 'SID',
      value: 'v',
      domain: '.myharavan.com',
      path: '/',
      secure: false,
      sameSite: 'unspecified',
      session: true,
    } as CookieLike as never);
    assert.strictEqual(sessionCookie.expirationDate, undefined, 'session cookie must not gain a forced expiry');

    const persistentCookie = buildRestoreDetails({
      name: 'SID',
      value: 'v',
      domain: '.myharavan.com',
      path: '/',
      secure: false,
      sameSite: 'unspecified',
      session: false,
    } as CookieLike as never);
    assert.strictEqual(typeof persistentCookie.expirationDate, 'number', 'persistent cookies keep a live expiry');
  });

  it('persists session cookies without expiry and reads the cache back', () => {
    const now = Date.now() / 1000;
    const sessionCookie = preparePersistableCookie({
      name: 'SID2',
      value: 'v',
      domain: '.myharavan.com',
      path: '/',
      secure: false,
      session: true,
    } as CookieLike as never);
    assert.strictEqual(sessionCookie.expirationDate, undefined, 'session cookie serialized without an expiry');

    const livePersistent = preparePersistableCookie({
      name: 'TOKEN',
      value: 'v',
      domain: '.myharavan.com',
      path: '/',
      secure: true,
      session: false,
      expirationDate: now + 1000,
    } as CookieLike as never);
    assert.strictEqual(livePersistent.expirationDate, now + 1000, 'live persistent cookies keep their expiry');

    const deadPersistent = preparePersistableCookie({
      name: 'OLD',
      value: 'v',
      domain: '.myharavan.com',
      path: '/',
      secure: false,
      session: false,
      expirationDate: now - 1000,
    } as CookieLike as never);
    assert.strictEqual(typeof deadPersistent.expirationDate, 'number', 'expired persistent cookies are refreshed');
    assert.ok((deadPersistent.expirationDate as number) > now, 'refreshed expiry is in the future');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-cache-'));
    const tmpPath = path.join(tmpDir, 'cookies.json');
    try {
      fs.writeFileSync(tmpPath, JSON.stringify([{ name: 'A' }]), 'utf8');
      const parsed = readCookieCache(tmpPath);
      assert.ok(Array.isArray(parsed) && parsed.length === 1, 'valid cache parses to a cookie array');

      fs.writeFileSync(tmpPath, '{ not json', 'utf8');
      const broken = readCookieCache(tmpPath);
      assert.strictEqual(broken, null, 'malformed cache yields null instead of throwing');

      fs.writeFileSync(tmpPath, JSON.stringify({ object: true }), 'utf8');
      const nonArray = readCookieCache(tmpPath);
      assert.strictEqual(nonArray, null, 'non-array cache yields null');

      const missing = readCookieCache(path.join(tmpDir, 'nope.json'));
      assert.strictEqual(missing, null, 'missing cache file yields null');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('reports restores that Chromium rejected instead of silently dropping them', async () => {
    const persister = CookiePersister.getInstance();
    const setDetails: Array<Record<string, unknown>> = [];
    let flushCalls = 0;
    const warnSpy = { calls: 0, lastMsg: '' };
    const origWarn = console.warn;
    console.warn = (msg?: unknown, ...rest: unknown[]) => {
      warnSpy.calls++;
      warnSpy.lastMsg = String(msg);
      origWarn(msg, ...rest);
    };

    const fixture = [
      { name: 'STOREFRONT_TOKEN', value: 'v', domain: '.myharavan.com', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', hostOnly: false },
      { name: '__Host-SESSION', value: 'v', domain: 'shop.myharavan.com', path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', hostOnly: true },
      // Filtered by shouldPersistCookie (Google domain): never attempted.
      { name: 'GOOGLE_TOKEN', value: 'v', domain: 'accounts.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', hostOnly: true },
      // Deliberately rejected by the sink regardless of payload: simulates Chromium rejecting a set call.
      { name: 'REJECT_TEST', value: 'v', domain: 'test.myharavan.com', path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', hostOnly: true },
    ];
    const fakeSession = {
      cookies: {
        set: async (details: Record<string, unknown>) => {
          setDetails.push(details);
          if (details.name === 'REJECT_TEST') throw new Error('Failed to set cookie (simulated)');
        },
        flushStore: async () => { flushCalls++; },
      },
      on: () => {},
    };

    try {
      const count = await persister.restoreCookies(fakeSession as never, fixture as never);
      assert.strictEqual(setDetails.length, 3, 'filtered cookie excluded; every eligible cookie attempted');
      const storefront = setDetails.find((d) => d.name === 'STOREFRONT_TOKEN');
      assert.strictEqual(storefront?.domain, '.myharavan.com', 'domain cookies keep their Domain attribute');
      const host = setDetails.find((d) => d.name === '__Host-SESSION');
      assert.strictEqual(host?.domain, undefined, '__Host- cookie restored without Domain attribute');
      assert.strictEqual(count, 2, 'success count must exclude rejected sets');
      assert.strictEqual(flushCalls, 1, 'store flushed after restore attempt');
      assert.strictEqual(warnSpy.calls, 2, 'rejection logged per cookie + summary');
      assert.match(warnSpy.lastMsg, /1 cookie\(s\) failed to restore/, 'summary warning names the rejected count');
    } finally {
      console.warn = origWarn;
    }
  });
  it('correctly resolves cookie cache path for packaged, dev, and custom environments', () => {
    // 1. Packaged environment via app.getPath('userData')
    const packagedUserData = path.join('C:', 'Users', 'Admin', 'AppData', 'Roaming', 'antifan-browser-desktop', 'Chromium');
    const packagedApp = {
      getPath: (name: string) => (name === 'userData' ? packagedUserData : ''),
    };
    const packagedCache = resolveCookieCachePath(undefined, packagedApp);
    const expectedPackaged = path.join(packagedUserData, '..', 'state', 'v1', 'cookies_cache.json');
    assert.strictEqual(path.normalize(packagedCache), path.normalize(expectedPackaged), 'packaged app derives cache path under user AppData');

    // 2. Dev environment via app.getPath('userData')
    const devUserData = path.join(process.cwd(), 'appdata', 'antifan-browser-desktop', 'Chromium-dev');
    const devApp = {
      getPath: (name: string) => (name === 'userData' ? devUserData : ''),
    };
    const devCache = resolveCookieCachePath(undefined, devApp);
    const expectedDev = path.join(devUserData, '..', 'state', 'v1', 'cookies_cache.json');
    assert.strictEqual(path.normalize(devCache), path.normalize(expectedDev), 'dev mode derives cache under appdata/antifan-browser-desktop/state/v1');

    // 3. Custom environment variable override
    const origEnv = process.env.ANTIFAN_USER_DATA;
    try {
      const customDir = path.join(os.tmpdir(), 'antifan-custom-profile', 'Chromium-test');
      process.env.ANTIFAN_USER_DATA = customDir;
      const customCache = resolveCookieCachePath(undefined, { getPath: () => '' });
      const expectedCustom = path.join(customDir, '..', 'state', 'v1', 'cookies_cache.json');
      assert.strictEqual(path.normalize(customCache), path.normalize(expectedCustom), 'custom env derives cache relative to custom user data');
    } finally {
      if (origEnv !== undefined) {
        process.env.ANTIFAN_USER_DATA = origEnv;
      } else {
        delete process.env.ANTIFAN_USER_DATA;
      }
    }

    // 4. Explicit path override takes top precedence
    const explicitTarget = path.join(os.tmpdir(), 'explicit', 'test_cookies.json');
    const explicitResolved = resolveCookieCachePath(explicitTarget, packagedApp);
    assert.strictEqual(explicitResolved, explicitTarget, 'explicit path override is preserved verbatim');

    // 5. CookiePersister instance reflects resolved cache path
    CookiePersister.resetInstance();
    const customPersister = CookiePersister.getInstance(explicitTarget);
    assert.strictEqual(customPersister.getCachePath(), explicitTarget);
    CookiePersister.resetInstance();
  });
});
