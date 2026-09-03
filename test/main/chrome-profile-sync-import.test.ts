import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { cookieImportSetDetails, extensionCookieImportSetDetails, ChromeProfileSyncManager } from '../../src/main/browser/chrome-profile-sync';
import { CookieDebouncer } from '../../src/extension/cookie-debouncer';
import { isCookieInScope } from '../../src/extension/domain-scoper';
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

  it('CookieDebouncer ignores non-explicit removals (expired, evicted, overwrite) and flushes explicit removals', async () => {
    const batches: any[] = [];
    const debouncer = new CookieDebouncer((b) => { batches.push(b); }, 10, 50);
    // 1. Non-explicit causes must NOT enter the queue as removals
    debouncer.addChange({
      cookie: { name: 'EXPIRED_ON_EXIT', value: '1', domain: '.google.com', path: '/', secure: true, httpOnly: true },
      removed: true,
      cause: 'expired',
    });
    debouncer.addChange({
      cookie: { name: 'EVICTED_COOKIE', value: '2', domain: '.google.com', path: '/', secure: true, httpOnly: true },
      removed: true,
      cause: 'evicted',
    });
    debouncer.addChange({
      cookie: { name: 'OVERWRITTEN_COOKIE', value: '3', domain: '.google.com', path: '/', secure: true, httpOnly: true },
      removed: true,
      cause: 'overwrite',
    });

    assert.strictEqual(debouncer.pendingCount, 0, 'non-explicit removals must be dropped immediately');

    // 2. Explicit removals must be queued and dispatched
    debouncer.addChange({
      cookie: { name: 'EXPLICIT_LOGOUT', value: 'logged_out', domain: '.google.com', path: '/', secure: true, httpOnly: true },
      removed: true,
      cause: 'explicit',
    });
    assert.strictEqual(debouncer.pendingCount, 1);

    debouncer.flush();
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].removed.length, 1);
    assert.strictEqual(batches[0].removed[0].name, 'EXPLICIT_LOGOUT');

    // 3. clear() on suspend/shutdown wipes queue and timers without dispatch
    batches.length = 0;
    debouncer.addChange({
      cookie: { name: 'PENDING_EVENT', value: 'val', domain: '.google.com', path: '/', secure: true, httpOnly: true },
      removed: true,
      cause: 'explicit',
    });
    assert.strictEqual(debouncer.pendingCount, 1);
    debouncer.clear();
    assert.strictEqual(debouncer.pendingCount, 0);
    assert.strictEqual((debouncer as any).timer, null, 'active timer must be cancelled');
    assert.strictEqual((debouncer as any).maxTimer, null, 'max timer must be cancelled');
    debouncer.flush();
    assert.strictEqual(batches.length, 0, 'cleared debouncer must not dispatch any batches');
  });

  it('isCookieInScope supports wildcard and all-profiles configuration', () => {
    const customDomainCookie = { domain: 'my-custom-store.vn', name: 'cart_token' };
    assert.strictEqual(isCookieInScope(customDomainCookie, ['google', 'ecommerce']), false);
    assert.strictEqual(isCookieInScope(customDomainCookie, ['all']), true);
    assert.strictEqual(isCookieInScope(customDomainCookie, ['*']), true);
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

  it('ChromeProfileSyncManager.syncProfile reports hasLiveCookies and accurate status', async () => {
    const manager = ChromeProfileSyncManager.getInstance();
    const res = await manager.syncProfile('Default');
    assert.strictEqual(typeof res.success, 'boolean');
    assert.strictEqual(typeof res.bookmarksCount, 'number');
    assert.strictEqual(typeof res.cookiesCount, 'number');
    assert.strictEqual(typeof res.hasLiveCookies, 'boolean');
    assert.ok(res.message.includes('dấu trang') || res.message.includes('not found'));
  });
});