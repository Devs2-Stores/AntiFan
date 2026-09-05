import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { cookieImportSetDetails, extensionCookieImportSetDetails, ChromeProfileSyncManager } from '../../src/main/browser/chrome-profile-sync';
describe('ChromeProfileSync Cookie Import Semantics', () => {
  it('omits Domain for host-only cookies (bare SQLite host_key) and __Host- prefixed names', () => {
    const domainCookie = cookieImportSetDetails('SID', '.google.com', 'v', '/', false, false, 0);
    assert.ok(domainCookie);
    assert.strictEqual(domainCookie.url, 'http://google.com/');
    assert.strictEqual(domainCookie.domain, '.google.com', 'domain cookies (leading dot) keep their Domain attribute');

    const hostOnly = cookieImportSetDetails('LSID', 'accounts.google.com', 'v', '/', true, true, 0);
    assert.ok(hostOnly);
    assert.strictEqual(hostOnly.url, 'https://accounts.google.com/');
    assert.strictEqual(hostOnly.domain, undefined, 'host-only cookies must not carry a Domain attribute');

    // Malformed/external record: __Host- prefix on a dotted host must still not get a Domain attribute.
    const hostPrefixDotted = cookieImportSetDetails('__Host-1PLSID', '.accounts.google.com', 'v', '/', true, true, 0);
    assert.ok(hostPrefixDotted);
    assert.strictEqual(hostPrefixDotted.domain, undefined, '__Host- cookies never carry a Domain attribute even on dotted hosts');
  });

  it('maps SQLite samesite flags and derives the secure scheme', () => {
    const lax = cookieImportSetDetails('A', '.google.com', 'v', '/', false, false, 1);
    assert.ok(lax);
    assert.strictEqual(lax.sameSite, 'lax');

    const strict = cookieImportSetDetails('A', '.google.com', 'v', '/', false, false, 2);
    assert.ok(strict);
    assert.strictEqual(strict.sameSite, 'strict');

    const noRestriction = cookieImportSetDetails('A', '.google.com', 'v', '/', true, false, 0);
    assert.ok(noRestriction);
    assert.strictEqual(noRestriction.sameSite, 'no_restriction', 'samesite=0 requires secure to map to no_restriction');

    const unspecified = cookieImportSetDetails('A', '.google.com', 'v', '/', false, false, 0);
    assert.ok(unspecified);
    assert.strictEqual(unspecified.sameSite, 'unspecified', 'samesite=0 without secure stays unspecified');

    assert.strictEqual(noRestriction.url, 'https://google.com/', 'secure cookies import over https');
    assert.strictEqual(unspecified.url, 'http://google.com/', 'insecure cookies import over http');
  });

  it('converts Chromium Windows epoch microsecond timestamps to valid Unix expiration dates', () => {
    const futureUnix = Math.floor(Date.now() / 1000) + 86400 * 30;
    const chromeMicroseconds = (futureUnix * 1000000) + 11644473600000000;
    const withExpiry = cookieImportSetDetails('store_session', '.myharavan.com', 'val', '/', true, false, 1, chromeMicroseconds);
    assert.ok(withExpiry);
    assert.strictEqual(withExpiry.expirationDate, futureUnix);

    const pastUnix = Math.floor(Date.now() / 1000) - 86400;
    const pastChromeMicroseconds = (pastUnix * 1000000) + 11644473600000000;
    const expired = cookieImportSetDetails('store_session', '.myharavan.com', 'val', '/', true, false, 1, pastChromeMicroseconds);
    assert.strictEqual(expired, null, 'past expirations return null so expired cookies are skipped completely');
  });

  it('persists extension session cookies with durable fallback TTL when persistSessionCookies is requested', () => {
    const nowSec = Math.floor(Date.now() / 1000);

    // Default / backwards-compatible behavior: session cookie stays undefined when persistSessionCookies is not set
    const sessionOnly = extensionCookieImportSetDetails({
      name: 'SESSION_ID',
      value: 'session_123',
      domain: '.myharavan.com',
    });
    assert.ok(sessionOnly);
    assert.strictEqual(sessionOnly.expirationDate, undefined, 'omitted options must retain undefined expiration for backward compatibility');

    // Elevated behavior: when persistSessionCookies: true, assigns 30-day TTL so SQLite flushes to disk
    const persistedSession = extensionCookieImportSetDetails(
      {
        name: 'SESSION_ID',
        value: 'session_123',
        domain: '.myharavan.com',
      },
      { persistSessionCookies: true }
    );
    assert.ok(persistedSession);
    assert.ok(typeof persistedSession.expirationDate === 'number');
    const expectedTtl = 30 * 24 * 60 * 60;
    assert.ok(persistedSession.expirationDate >= nowSec + expectedTtl - 5);
    assert.ok(persistedSession.expirationDate <= nowSec + expectedTtl + 5);

    // Custom TTL support
    const customTtl = extensionCookieImportSetDetails(
      {
        name: 'CUSTOM_SESSION',
        value: 'custom_val',
        domain: '.shopify.com',
      },
      { persistSessionCookies: true, sessionTtlSeconds: 86400 * 7 }
    );
    assert.ok(customTtl);
    assert.ok(customTtl.expirationDate! >= nowSec + 86400 * 7 - 5);
    assert.ok(customTtl.expirationDate! <= nowSec + 86400 * 7 + 5);

    // Persistent cookies from Chrome keep their authentic future expirationDate untouched
    const futureTimestamp = nowSec + 3600;
    const chromePersistent = extensionCookieImportSetDetails(
      {
        name: 'PERSISTENT_COOKIE',
        value: 'auth_token',
        domain: '.google.com',
        expirationDate: futureTimestamp,
      },
      { persistSessionCookies: true }
    );
    assert.ok(chromePersistent);
    assert.strictEqual(chromePersistent.expirationDate, futureTimestamp);
  });


  it('ChromeProfileSyncManager locates Chrome executable or returns null safely', () => {
    const manager = ChromeProfileSyncManager.getInstance();
    const chromePath = manager.getChromeExecutablePath();
    if (chromePath) {
      assert.ok(chromePath.toLowerCase().includes('chrome.exe'));
    } else {
      assert.strictEqual(chromePath, null);
    }
  });

  it('ChromeProfileSyncManager.syncProfile reports accurate status', async () => {
    const manager = ChromeProfileSyncManager.getInstance();
    const res = await manager.syncProfile('Default');
    assert.strictEqual(typeof res.success, 'boolean');
    assert.strictEqual(typeof res.bookmarksCount, 'number');
    assert.strictEqual(typeof res.cookiesCount, 'number');
    assert.strictEqual(typeof res.hasLiveCookies, 'boolean');
    // No target session was passed — CDP hydration cannot run, so counts are real zeros, never fabricated.
    assert.strictEqual(res.cookiesCount, 0);
    assert.strictEqual(res.hasLiveCookies, false);
    assert.ok(res.message.includes('dấu trang') || res.message.includes('not found'));
  });

  it('syncProfile fails fast BEFORE any CDP work when the profile directory is missing', async () => {
    const manager = ChromeProfileSyncManager.getInstance();
    const activeBefore = manager.activeProfileId;
    const res = await manager.syncProfile('__profile_that_does_not_exist__');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.cookiesCount, 0, 'no CDP pull may run for an unverifiable profile');
    assert.strictEqual(res.bookmarksCount, 0);
    assert.strictEqual(res.hasLiveCookies, false);
    assert.ok(res.message.includes('not found'), `expected not-found message, got: ${res.message}`);
    assert.strictEqual(manager.activeProfileId, activeBefore, 'a missing profile must never mutate the active profile');
    assert.strictEqual(manager.hasProfile('__profile_that_does_not_exist__'), false);
  });
});