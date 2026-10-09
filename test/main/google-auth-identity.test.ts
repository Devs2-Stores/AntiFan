import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from 'electron';
import { googleAuthUserAgent, chromeSessionUserAgent, chromeUserAgentMetadata, windowsPlatformVersion, setupClientHintsOverride, isGoogleAuthUrl, isGoogleUrl, isGoogleDomain, setUserAgentHeader, stripClientHints, setChromeClientHints, setGoogleAuthClientHints, applyGoogleAuthIdentity } from '../../src/main/browser/google-auth-identity';
import { ANDROID_MOBILE_USER_AGENT, ANDROID_TABLET_USER_AGENT, IPHONE_USER_AGENT } from '../../src/main/browser/device-presets';
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

test('Google auth identity uses authentic Chrome session UA and sets standard Client Hints', () => {
  const headers: Record<string, string> = {
    'user-agent': 'old',
  };
  setUserAgentHeader(headers, googleAuthUserAgent());
  setGoogleAuthClientHints(headers);
  assert.match(String(headers['user-agent']), /Chrome\/\d+/);
  assert.doesNotMatch(String(headers['user-agent']), /Firefox/);
  assert.ok(headers['sec-ch-ua']);
  assert.equal(headers['sec-ch-ua-mobile'], '?0');
  assert.equal(Object.keys(headers).filter((key) => key.toLowerCase() === 'user-agent').length, 1);
});

test('Chrome session user agent produces standard Chrome desktop identity', () => {
  const chromeUa = chromeSessionUserAgent();
  assert.match(chromeUa, /Chrome\/\d+\.\d+\.\d+\.\d+/);
  assert.doesNotMatch(chromeUa, /Firefox/);
});

type HeaderDetails = { requestHeaders: Record<string, string>; resourceType?: string };

function captureHintsRewrite(ua: string): (headers: Record<string, string>, resourceType?: string) => Record<string, string> {
  let listener: ((details: HeaderDetails, cb: (r: { requestHeaders: Record<string, string> }) => void) => void) | undefined;
  const webRequest = { onBeforeSendHeaders: (_filter: unknown, fn: typeof listener) => { listener = fn; } };
  // Only webRequest.onBeforeSendHeaders is touched by setupClientHintsOverride.
  setupClientHintsOverride({ webRequest } as unknown as Session, ua);
  return (headers, resourceType = 'xhr') => {
    let out: Record<string, string> = {};
    listener!({ requestHeaders: { ...headers }, resourceType }, (r) => { out = r.requestHeaders; });
    return out;
  };
}

test('UA metadata for the session UA names the same brands the sec-ch-ua rewrite sends', () => {
  const ua = chromeSessionUserAgent();
  const metadata = chromeUserAgentMetadata(ua);
  assert.ok(metadata, 'a Chrome UA must yield Client Hints metadata');
  const brandNames = metadata.brands.map((b) => b.brand);
  assert.ok(brandNames.includes('Google Chrome') && brandNames.includes('Chromium'), brandNames.join(','));
  assert.equal(metadata.fullVersion, /Chrome\/([\d.]+)/.exec(ua)![1]);
  assert.equal(metadata.platform, process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux');
  assert.match(metadata.platformVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(metadata.mobile, false);

  const rewritten = captureHintsRewrite(ua)({ 'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150"' });
  assert.equal(rewritten['sec-ch-ua'], metadata.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '));
});

const desktopChromeUa = (version: string): string =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

test('brand list reproduces Chromium GREASE punctuation, version and order per major version', () => {
  // Real Chrome 154 on this host: navigator.userAgentData.brands, in order.
  const chrome154 = chromeUserAgentMetadata(desktopChromeUa('154.0.8037.98'))!;
  assert.deepEqual(chrome154.brands, [
    { brand: 'Chromium', version: '154' },
    { brand: 'Google Chrome', version: '154' },
    { brand: 'Not A(Brand', version: '99' },
  ]);
  assert.deepEqual(chrome154.fullVersionList.map((b) => b.version), ['154.0.8037.98', '154.0.8037.98', '99.0.0.0']);

  // Chrome 128's published sec-ch-ua, and Electron 150's own GREASE entry ("Not;A=Brand"/8).
  const toHeader = (ua: string): string =>
    chromeUserAgentMetadata(ua)!.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  assert.equal(toHeader(desktopChromeUa('128.0.6613.114')), '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"');
  assert.equal(toHeader(desktopChromeUa('150.0.7871.250')), '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"');
});

test('sec-ch-ua rewrite leaves a browser-branded list from a metadata override untouched', () => {
  const android = chromeUserAgentMetadata(ANDROID_MOBILE_USER_AGENT)!;
  const androidHeader = android.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  const rewritten = captureHintsRewrite(chromeSessionUserAgent())({ 'Sec-CH-UA': androidHeader });
  assert.equal(rewritten['Sec-CH-UA'], androidHeader);
  assert.match(androidHeader, /"Google Chrome";v="128"/);
});

test('frame navigations get the low-entropy hints of their own User-Agent; other requests are not given any', () => {
  const rewrite = captureHintsRewrite(chromeSessionUserAgent());
  const desktopUa = chromeSessionUserAgent();
  const desktop = chromeUserAgentMetadata(desktopUa)!;
  const nav = rewrite({ 'User-Agent': desktopUa, Accept: 'text/html' }, 'mainFrame');
  assert.equal(nav['sec-ch-ua'], desktop.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '));
  assert.equal(nav['sec-ch-ua-mobile'], '?0');
  assert.equal(nav['sec-ch-ua-platform'], `"${desktop.platform}"`);

  // A per-tab Android override shows up in the request's User-Agent; hints must follow it.
  const phone = rewrite({ 'User-Agent': ANDROID_MOBILE_USER_AGENT }, 'subFrame');
  assert.match(phone['sec-ch-ua']!, /"Google Chrome";v="128"/);
  assert.equal(phone['sec-ch-ua-mobile'], '?1');
  assert.equal(phone['sec-ch-ua-platform'], '"Android"');

  assert.equal(Object.keys(rewrite({ 'User-Agent': IPHONE_USER_AGENT }, 'mainFrame')).some((k) => k.startsWith('sec-ch-')), false);
  assert.equal(Object.keys(rewrite({ 'User-Agent': desktopUa }, 'image')).some((k) => k.startsWith('sec-ch-')), false);

  const already = rewrite({ 'User-Agent': desktopUa, 'Sec-CH-UA-Mobile': '?0' }, 'mainFrame');
  assert.deepEqual(Object.keys(already).filter((k) => k.toLowerCase().startsWith('sec-ch-')), ['Sec-CH-UA-Mobile']);
});

test('UA metadata follows the emulated device, and Safari identities get none', () => {
  const phone = chromeUserAgentMetadata(ANDROID_MOBILE_USER_AGENT)!;
  assert.equal(phone.platform, 'Android');
  assert.equal(phone.platformVersion, '14.0.0');
  assert.equal(phone.mobile, true);
  assert.equal(phone.fullVersion, '128.0.6613.114');
  assert.equal(chromeUserAgentMetadata(ANDROID_TABLET_USER_AGENT)!.mobile, false);
  assert.equal(chromeUserAgentMetadata(IPHONE_USER_AGENT), null);
});

test('Windows platformVersion is the UniversalApiContract version of the OS build', () => {
  assert.equal(windowsPlatformVersion(19045), '10.0.0');
  assert.equal(windowsPlatformVersion(21999), '10.0.0');
  assert.equal(windowsPlatformVersion(22000), '14.0.0');
  assert.equal(windowsPlatformVersion(22631), '15.0.0');
  assert.equal(windowsPlatformVersion(26100), '19.0.0');
  assert.equal(windowsPlatformVersion(26200), '19.0.0');
});
test('applyGoogleAuthIdentity maintains consistent base Chrome session UA across all URLs', () => {
  let currentUa = '';
  const mockWebContents = {
    isDestroyed: () => false,
    getUserAgent: () => currentUa,
    setUserAgent: (ua: string) => { currentUa = ua; },
  };
  const baseUa = chromeSessionUserAgent();

  applyGoogleAuthIdentity(mockWebContents as any, 'https://accounts.google.com/signin', baseUa);
  assert.match(currentUa, /Chrome\/\d+/);
  assert.doesNotMatch(currentUa, /Firefox/);

  applyGoogleAuthIdentity(mockWebContents as any, 'https://mail.google.com/', baseUa);
  assert.match(currentUa, /Chrome\/\d+/);
  assert.doesNotMatch(currentUa, /Firefox/);
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


test('tab-preload does not monkey-patch window.chrome, navigator prototypes, or identity', () => {
  const preloadPath = path.resolve(process.cwd(), 'src/preload/tab-preload.ts');
  assert.ok(fs.existsSync(preloadPath), `tab-preload.ts must exist at ${preloadPath}`);
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  assert.doesNotMatch(preloadSource, /STEALTH_SCRIPT/);
  assert.doesNotMatch(preloadSource, /dummyPlugin/);
  assert.doesNotMatch(preloadSource, /isGoogleAuth/);
  assert.doesNotMatch(preloadSource, /InstallTrigger/);
  assert.doesNotMatch(preloadSource, /Firefox\//);
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

  // Ephemeral mode creates in-memory non-persistent partition names
  const eph1 = deriveCapsulePartition('workspace-1', 'clean', true);
  const eph2 = deriveCapsulePartition('workspace-1', 'clean', true);
  assert.equal(eph1.startsWith('ephemeral-workspace-1-'), true);
  assert.equal(eph1.includes('persist:'), false);
  assert.notEqual(eph1, eph2, 'Ephemeral partitions must be unique per derivation to guarantee isolation');

  const ephNative = deriveCapsulePartition('workspace-1', 'native', true);
  assert.equal(ephNative.startsWith('ephemeral-workspace-1-'), true);
  assert.equal(ephNative.endsWith('-native'), true);
});
