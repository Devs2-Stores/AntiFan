/**
 * RFC 6265bis ingestion semantics for Chrome cookie payloads.
 *
 * The HTTP endpoint `/api/cookies/import` was REMOVED (delta-sync architecture
 * eliminated — see plan winner-C): cookie hydration is now local-only via CDP
 * one-shot / session vault. The transformer `extensionCookieImportSetDetails`
 * still backs the local ingestion engine (LocalSessionVault CDP path), so its
 * contract is covered here as a pure unit test.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { extensionCookieImportSetDetails } from '../../src/main/browser/chrome-profile-sync';

describe('Extension Cookie Import Set Details (unit semantics)', () => {
  it('handles Unix epoch seconds, RFC 6265bis, and sameSite', () => {
    const futureUnix = Math.floor(Date.now() / 1000) + 3600;
    const pastUnix = Math.floor(Date.now() / 1000) - 3600;

    // 1. Valid persistent cookie
    const validCookie = extensionCookieImportSetDetails({
      name: 'SID',
      value: 'valid-sid-value',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: futureUnix,
    });
    assert.ok(validCookie);
    assert.strictEqual(validCookie?.name, 'SID');
    assert.strictEqual(validCookie?.value, 'valid-sid-value');
    assert.strictEqual(validCookie?.url, 'https://google.com/');
    assert.strictEqual(validCookie?.domain, '.google.com');
    assert.strictEqual(validCookie?.expirationDate, futureUnix);
    assert.strictEqual(validCookie?.sameSite, 'no_restriction');

    // 2. Expired persistent cookie must be skipped (null)
    const expiredCookie = extensionCookieImportSetDetails({
      name: 'EXPIRED',
      value: 'old-val',
      domain: '.google.com',
      expirationDate: pastUnix,
    });
    assert.strictEqual(expiredCookie, null);

    // 3. __Host- cookie must not have domain attribute per RFC 6265bis
    const hostCookie = extensionCookieImportSetDetails({
      name: '__Host-GAPS',
      value: 'secret-host-val',
      domain: 'accounts.google.com',
      path: '/',
      secure: true,
    });
    assert.ok(hostCookie);
    assert.strictEqual(hostCookie?.name, '__Host-GAPS');
    assert.strictEqual(hostCookie?.domain, undefined);
    assert.strictEqual(hostCookie?.url, 'https://accounts.google.com/');

    // 4. Secure cookie with sameSite 'unspecified' must remain 'unspecified' (never converted to no_restriction)
    const unspecifiedCookie = extensionCookieImportSetDetails({
      name: 'SECURE_UNSPECIFIED',
      value: 'secure-unspecified-val',
      domain: '.google.com',
      path: '/',
      secure: true,
      sameSite: 'unspecified',
    });
    assert.ok(unspecifiedCookie);
    assert.strictEqual(unspecifiedCookie?.sameSite, 'unspecified');

    // 5. sameSite 'lax' and 'strict' exact preservation
    const laxCookie = extensionCookieImportSetDetails({
      name: 'LAX_COOKIE',
      value: 'lax-val',
      domain: '.google.com',
      sameSite: 'lax',
    });
    assert.strictEqual(laxCookie?.sameSite, 'lax');

    const strictCookie = extensionCookieImportSetDetails({
      name: 'STRICT_COOKIE',
      value: 'strict-val',
      domain: '.google.com',
      sameSite: 'strict',
    });
    assert.strictEqual(strictCookie?.sameSite, 'strict');

    // 6. Session cookie (no expirationDate) must not have expirationDate set
    const sessionCookie = extensionCookieImportSetDetails({
      name: 'SESSION_ONLY',
      value: 'session-val',
      domain: '.google.com',
    });
    assert.ok(sessionCookie);
    assert.strictEqual(sessionCookie?.expirationDate, undefined);

    // 7. Domain vs Host-only cookie:
    // Domain cookie (with leading dot) sets details.domain
    const dotDomainCookie = extensionCookieImportSetDetails({
      name: 'DOMAIN_COOKIE',
      value: 'dot-val',
      domain: '.example.com',
    });
    assert.strictEqual(dotDomainCookie?.domain, '.example.com');
    assert.strictEqual(dotDomainCookie?.url, 'http://example.com/');

    // Host-only cookie (without leading dot) omits details.domain
    const hostOnlyCookie = extensionCookieImportSetDetails({
      name: 'HOST_ONLY_COOKIE',
      value: 'host-val',
      domain: 'sub.example.com',
    });
    assert.strictEqual(hostOnlyCookie?.domain, undefined);
    assert.strictEqual(hostOnlyCookie?.url, 'http://sub.example.com/');

    // 8. Invalid / empty cookie returns null
    assert.strictEqual(extensionCookieImportSetDetails(null as unknown as Parameters<typeof extensionCookieImportSetDetails>[0]), null);
    assert.strictEqual(extensionCookieImportSetDetails({ name: '', value: 'test' }), null);
    assert.strictEqual(extensionCookieImportSetDetails({ name: 'test', value: 'val', domain: '' }), null);
  });
});