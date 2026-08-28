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
} from '../../src/main/browser/cookie-persister';

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
      name: '__Host-1PLSID',
      value: 'v',
      domain: 'accounts.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'unspecified',
      hostOnly: true,
    } as CookieLike as never);
    assert.strictEqual(hostCookie.url, 'https://accounts.google.com/');
    assert.strictEqual(hostCookie.secure, true);
    assert.strictEqual(hostCookie.httpOnly, true);
    assert.strictEqual(hostCookie.path, '/');
    assert.strictEqual(hostCookie.domain, undefined, '__Host- cookie must not carry a Domain attribute (RFC 6265bis)');

    const hostOnlyCookie = buildRestoreDetails({
      name: 'LSID',
      value: 'v',
      domain: 'accounts.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'unspecified',
      hostOnly: true,
    } as CookieLike as never);
    assert.strictEqual(hostOnlyCookie.domain, undefined, 'host-only cookie must not be rewritten into a domain cookie');

    const domainCookie = buildRestoreDetails({
      name: 'SID',
      value: 'v',
      domain: '.google.com',
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
      hostOnly: false,
    } as CookieLike as never);
    assert.strictEqual(domainCookie.url, 'http://google.com/', 'non-secure cookies restore over plain http');
    assert.strictEqual(domainCookie.domain, '.google.com', 'regular domain cookies keep their Domain attribute');
  });

  it('preserves session cookies as session-scoped instead of forcing a +1 year expiry', () => {
    const sessionCookie = buildRestoreDetails({
      name: 'SID',
      value: 'v',
      domain: '.google.com',
      path: '/',
      secure: false,
      sameSite: 'unspecified',
      session: true,
    } as CookieLike as never);
    assert.strictEqual(sessionCookie.expirationDate, undefined, 'session cookie must not gain a forced expiry');

    const persistentCookie = buildRestoreDetails({
      name: 'SID',
      value: 'v',
      domain: '.google.com',
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
      domain: '.google.com',
      path: '/',
      secure: false,
      session: true,
    } as CookieLike as never);
    assert.strictEqual(sessionCookie.expirationDate, undefined, 'session cookie serialized without an expiry');

    const livePersistent = preparePersistableCookie({
      name: 'SAPISID',
      value: 'v',
      domain: '.google.com',
      path: '/',
      secure: true,
      session: false,
      expirationDate: now + 1000,
    } as CookieLike as never);
    assert.strictEqual(livePersistent.expirationDate, now + 1000, 'live persistent cookies keep their expiry');

    const deadPersistent = preparePersistableCookie({
      name: 'OLD',
      value: 'v',
      domain: '.google.com',
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
      { name: 'SID', value: 'v', domain: '.google.com', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', hostOnly: false },
      { name: '__Host-1PLSID', value: 'v', domain: 'accounts.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', hostOnly: true },
      // Filtered by shouldPersistCookie (short-lived Google OAuth handshake): never attempted.
      { name: '__Host-GAPS', value: 'v', domain: 'accounts.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', hostOnly: true },
      // Deliberately rejected by the sink regardless of payload: simulates Chromium rejecting a set call.
      { name: 'GAPS-REJECT', value: 'v', domain: 'accounts.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', hostOnly: true },
    ];
    const fakeSession = {
      cookies: {
        set: async (details: Record<string, unknown>) => {
          setDetails.push(details);
          if (details.name === 'GAPS-REJECT') throw new Error('Failed to set cookie (simulated)');
        },
        flushStore: async () => { flushCalls++; },
      },
      on: () => {},
    };

    try {
      const count = await persister.restoreCookies(fakeSession as never, fixture as never);
      assert.strictEqual(setDetails.length, 3, 'filtered cookie excluded; every eligible cookie attempted');
      const sid = setDetails.find((d) => d.name === 'SID');
      assert.strictEqual(sid?.domain, '.google.com', 'domain cookies keep their Domain attribute');
      const host = setDetails.find((d) => d.name === '__Host-1PLSID');
      assert.strictEqual(host?.domain, undefined, '__Host- cookie restored without Domain attribute');
      assert.strictEqual(count, 2, 'success count must exclude rejected sets');
      assert.strictEqual(flushCalls, 1, 'store flushed after restore attempt');
      assert.strictEqual(warnSpy.calls, 2, 'rejection logged per cookie + summary');
      assert.match(warnSpy.lastMsg, /1 cookie\(s\) failed to restore/, 'summary warning names the rejected count');
    } finally {
      console.warn = origWarn;
    }
  });
});