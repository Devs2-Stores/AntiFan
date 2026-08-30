import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { googleAuthUserAgent, chromeSessionUserAgent, isGoogleAuthUrl, isGoogleUrl, isGoogleDomain, setUserAgentHeader, stripClientHints, setChromeClientHints, setGoogleAuthClientHints, applyGoogleAuthIdentity } from '../../src/main/browser/google-auth-identity';
import { cleanElectronUserAgent, setBrowserSessionUserAgentMode, getBrowserSessionUserAgentMode, deriveCapsulePartition } from '../../src/main/browser/browser-session-partition';
test('Google auth identity is scoped to exact auth hosts and service signin flows', () => {
  assert.equal(isGoogleAuthUrl('https://accounts.google.com/v3/signin/identifier'), true);
  assert.equal(isGoogleAuthUrl('https://accounts.youtube.com/signin'), true);
  assert.equal(isGoogleAuthUrl('https://mail.google.com/mail/?service=mail&flowName=GlifWebSignIn&flowEntry=AccountChooser&ec=asw-gmail-globalnav-signin'), true);
  assert.equal(isGoogleAuthUrl('https://mail.google.com/signin/v2/identifier'), true);
  assert.equal(isGoogleAuthUrl('https://myaccount.google.com/'), false);
  assert.equal(isGoogleAuthUrl('https://oauth2.googleapis.com/token'), false);
  assert.equal(isGoogleAuthUrl('https://accounts.google.com.evil.test/'), false);
});

test('Google auth identity uses Firefox 140 UA and strips Client Hints for auth hosts', () => {
  const headers = { 'user-agent': 'old', 'Sec-CH-UA': 'Chromium', 'sec-ch-ua-platform': 'Windows' };
  setUserAgentHeader(headers, googleAuthUserAgent());
  setGoogleAuthClientHints(headers);
  assert.match(headers['user-agent'], /Firefox\/140\.0/);
  assert.doesNotMatch(headers['user-agent'], /Chrome/);
  assert.equal(Object.keys(headers).some((key) => key.toLowerCase().startsWith('sec-ch-ua')), false);
  assert.equal(Object.keys(headers).filter((key) => key.toLowerCase() === 'user-agent').length, 1);
});

test('Chrome session user agent produces standard Chrome desktop identity', () => {
  const chromeUa = chromeSessionUserAgent();
  assert.match(chromeUa, /Chrome\/\d+\.\d+\.\d+\.\d+/);
  assert.doesNotMatch(chromeUa, /Firefox/);
});
test('applyGoogleAuthIdentity switches between Firefox auth UA and base Chrome session UA', () => {
  let currentUa = '';
  const mockWebContents = {
    isDestroyed: () => false,
    getUserAgent: () => currentUa,
    setUserAgent: (ua: string) => { currentUa = ua; },
  };
  const baseUa = chromeSessionUserAgent();

  applyGoogleAuthIdentity(mockWebContents as any, 'https://accounts.google.com/signin', baseUa);
  assert.match(currentUa, /Firefox\/140\.0/);

  applyGoogleAuthIdentity(mockWebContents as any, 'https://mail.google.com/', baseUa);
  assert.match(currentUa, /Chrome\/\d+/);
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

test('cleanElectronUserAgent strips Electron and app branding tokens', () => {
  const rawUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AntiFan/1.0.0 Chrome/130.0.6723.44 Electron/33.0.0 Safari/537.36';
  const cleaned = cleanElectronUserAgent(rawUa);
  assert.doesNotMatch(cleaned, /Electron/);
  assert.doesNotMatch(cleaned, /AntiFan/);
  assert.match(cleaned, /Chrome\/130\.0\.6723\.44/);
  assert.match(cleaned, /Safari\/537\.36/);
});

test('session user agent mode tracking defaults to clean and records native', () => {
  const mockSession: any = {};
  assert.equal(getBrowserSessionUserAgentMode(mockSession), 'clean');
  setBrowserSessionUserAgentMode(mockSession, 'native');
  assert.equal(getBrowserSessionUserAgentMode(mockSession), 'native');
  setBrowserSessionUserAgentMode(mockSession, 'clean');
  assert.equal(getBrowserSessionUserAgentMode(mockSession), 'clean');
});

test('deriveCapsulePartition suffixes native mode with -native and defaults clean mode', () => {
  assert.equal(deriveCapsulePartition('workspace-1', 'clean'), 'persist:capsule-workspace-1');
  assert.equal(deriveCapsulePartition('workspace-1', 'native'), 'persist:capsule-workspace-1-native');
  assert.equal(deriveCapsulePartition('', 'clean'), 'persist:capsule-default');
  assert.equal(deriveCapsulePartition('', 'native'), 'persist:capsule-default-native');
});
