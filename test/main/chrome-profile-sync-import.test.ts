import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { cookieImportSetDetails } from '../../src/main/browser/chrome-profile-sync';

describe('ChromeProfileSync Cookie Import Semantics', () => {
  it('omits Domain for host-only cookies (bare SQLite host_key) and __Host- prefixed names', () => {
    const domainCookie = cookieImportSetDetails('SID', '.google.com', 'v', '/', false, false, 0);
    assert.strictEqual(domainCookie.url, 'http://google.com/');
    assert.strictEqual(domainCookie.domain, '.google.com', 'domain cookies (leading dot) keep their Domain attribute');

    const hostOnly = cookieImportSetDetails('LSID', 'accounts.google.com', 'v', '/', true, true, 0);
    assert.strictEqual(hostOnly.url, 'https://accounts.google.com/');
    assert.strictEqual(hostOnly.domain, undefined, 'host-only cookies must not carry a Domain attribute');

    // Malformed/external record: __Host- prefix on a dotted host must still not get a Domain attribute.
    const hostPrefixDotted = cookieImportSetDetails('__Host-1PLSID', '.accounts.google.com', 'v', '/', true, true, 0);
    assert.strictEqual(hostPrefixDotted.domain, undefined, '__Host- cookies never carry a Domain attribute even on dotted hosts');
  });

  it('maps SQLite samesite flags and derives the secure scheme', () => {
    const lax = cookieImportSetDetails('A', '.google.com', 'v', '/', false, false, 1);
    assert.strictEqual(lax.sameSite, 'lax');

    const strict = cookieImportSetDetails('A', '.google.com', 'v', '/', false, false, 2);
    assert.strictEqual(strict.sameSite, 'strict');

    const noRestriction = cookieImportSetDetails('A', '.google.com', 'v', '/', true, false, 0);
    assert.strictEqual(noRestriction.sameSite, 'no_restriction', 'samesite=0 requires secure to map to no_restriction');

    const unspecified = cookieImportSetDetails('A', '.google.com', 'v', '/', false, false, 0);
    assert.strictEqual(unspecified.sameSite, 'unspecified', 'samesite=0 without secure stays unspecified');

    assert.strictEqual(noRestriction.url, 'https://google.com/', 'secure cookies import over https');
    assert.strictEqual(unspecified.url, 'http://google.com/', 'insecure cookies import over http');
  });
});