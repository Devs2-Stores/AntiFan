import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { googleAuthUserAgent, isGoogleAuthUrl, isGoogleUrl, isGoogleDomain, setUserAgentHeader, stripClientHints, setChromeClientHints, cleanCorruptedGoogleCookies, clearAllGoogleCookies } from '../../src/main/browser/google-auth-identity';
test('Google auth identity is scoped to exact auth hosts', () => {
  assert.equal(isGoogleAuthUrl('https://accounts.google.com/v3/signin/identifier'), true);
  assert.equal(isGoogleAuthUrl('https://accounts.youtube.com/signin'), true);
  assert.equal(isGoogleAuthUrl('https://mail.google.com/'), false);
  assert.equal(isGoogleAuthUrl('https://accounts.google.com.evil.test/'), false);
});

test('Google auth identity uses consistent Chromium headers without duplicates', () => {
  const headers = { 'user-agent': 'old', 'Sec-CH-UA': 'Chromium', 'sec-ch-ua-platform': 'Windows' };
  setUserAgentHeader(headers, googleAuthUserAgent());
  stripClientHints(headers);
  assert.match(headers['user-agent'], /Chrome\/\d+\.\d+\.\d+\.\d+/);
  assert.doesNotMatch(headers['user-agent'], /Firefox/);
  assert.equal(Object.keys(headers).some((key) => key.toLowerCase().startsWith('sec-ch-ua')), false);
  assert.equal(Object.keys(headers).filter((key) => key.toLowerCase() === 'user-agent').length, 1);
});
test('isGoogleUrl and isGoogleDomain recognize Google search and localized domains', () => {
  assert.equal(isGoogleUrl('https://www.google.com/search?q=test'), true);
  assert.equal(isGoogleUrl('https://www.google.com.vn/'), true);
  assert.equal(isGoogleUrl('https://google.vn/search'), true);
  assert.equal(isGoogleUrl('https://apis.google.com/js/api.js'), true);
  assert.equal(isGoogleUrl('https://accounts.google.com/signin'), true);
  assert.equal(isGoogleUrl('https://example.com/'), false);

  assert.equal(isGoogleDomain('google.com.vn'), true);
  assert.equal(isGoogleDomain('www.google.com.vn'), true);
  assert.equal(isGoogleDomain('.google.com'), true);
  assert.equal(isGoogleDomain('haravan.com'), false);
});

test('setChromeClientHints sets Chromium client hints aligned with desktop Chrome', () => {
  const headers: Record<string, string> = {};
  setChromeClientHints(headers);
  assert.ok(headers['sec-ch-ua']);
  assert.match(headers['sec-ch-ua'], /"Google Chrome";v="\d+"/);
  assert.match(headers['sec-ch-ua'], /"Chromium";v="\d+"/);
  assert.equal(headers['sec-ch-ua-mobile'], '?0');
  assert.ok(headers['sec-ch-ua-platform']);
});

test('cleanCorruptedGoogleCookies safely identifies and removes only verifiable corruption markers', async () => {
  const removedKeys: string[] = [];
  const fakeSession = {
    cookies: {
      get: async () => [
        { name: 'CookieMismatch', value: '1', domain: '.google.com', secure: true, path: '/' },
        { name: '__Secure-BAD', value: 'bad', domain: '.google.com.vn', secure: false, path: '/' }, // Insecure __Secure- cookie
        { name: '__Host-BAD', value: 'bad', domain: '.google.com', secure: true, path: '/' }, // Dotted domain on __Host- cookie
        { name: 'VALID_SESSION', value: 'ok', domain: '.google.com', secure: true, path: '/' },
        { name: 'AEC', value: 'valid_aec', domain: '.google.com.vn', secure: true, path: '/' },
        { name: 'store_token', value: 'haravan', domain: '.myharavan.com', secure: true, path: '/' },
      ],
      remove: async (url: string, name: string) => {
        removedKeys.push(`${name}@${url}`);
      },
      flushStore: async () => {},
    },
  };

  const count = await cleanCorruptedGoogleCookies(fakeSession as never);
  assert.equal(count, 3);
  assert.ok(removedKeys.some((k) => k.startsWith('CookieMismatch@')));
  assert.ok(removedKeys.some((k) => k.startsWith('__Secure-BAD@')));
  assert.ok(removedKeys.some((k) => k.startsWith('__Host-BAD@')));
  assert.ok(!removedKeys.some((k) => k.startsWith('VALID_SESSION@')));
  assert.ok(!removedKeys.some((k) => k.startsWith('AEC@')));
  assert.ok(!removedKeys.some((k) => k.startsWith('store_token@')));
});

test('tab-preload does not monkey-patch window.chrome or navigator prototypes', () => {
  const preloadPath = path.resolve(process.cwd(), 'src/preload/tab-preload.ts');
  assert.ok(fs.existsSync(preloadPath), `tab-preload.ts must exist at ${preloadPath}`);
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  assert.doesNotMatch(preloadSource, /STEALTH_SCRIPT/);
  assert.doesNotMatch(preloadSource, /dummyPlugin/);
  assert.doesNotMatch(preloadSource, /window\.chrome\s*=/);
  assert.doesNotMatch(preloadSource, /window\.chrome\.runtime\s*=/);
  assert.doesNotMatch(preloadSource, /webFrame/);
});
