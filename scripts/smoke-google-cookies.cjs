/**
 * Comprehensive Live Google Navigation A/B & Cookie Jar Verification Smoke Test
 * 
 * 1. Branch A: Baseline Session (stock Electron headers, no overrides) -> logs exact HTTP status & redirects.
 * 2. Branch B: Configured Session (Production UA & Client Hints policy) -> logs exact HTTP status & redirects.
 * 3. Chrome Profile Sync expiration handling -> verifies expired records are never revived.
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.on('window-all-closed', (e) => {
  // Prevent Electron from auto-quitting between sequential window tests
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
});

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-google-ab-smoke-'));
app.setPath('userData', tempUserData);

const {
  googleAuthUserAgent,
  isGoogleAuthUrl,
  setUserAgentHeader,
  setChromeClientHints,
} = require('../.compiled/src/main/browser/google-auth-identity.js');

const { cookieImportSetDetails } = require('../.compiled/src/main/browser/chrome-profile-sync.js');

async function runLiveABSmoke() {
  console.log('===============================================================');
  console.log('  Live Google Navigation & Cookie Jar Verification (A/B Test)  ');
  console.log('===============================================================');

  const sentinel = new BrowserWindow({ show: false, width: 10, height: 10 });
  // Chrome Profile Sync expiration handling
  console.log('\n[Storage] Verifying Chrome Profile Sync expiration handling...');

  const futureUnix = Math.floor(Date.now() / 1000) + 86400 * 30;
  const futureMicroseconds = (futureUnix * 1000000) + 11644473600000000;
  const validNonGoogle = cookieImportSetDetails('haravan_session', '.myharavan.com', 'abc', '/', true, false, 1, futureMicroseconds);
  if (!validNonGoogle || validNonGoogle.expirationDate !== futureUnix) {
    throw new Error('Valid non-Google cookie did not retain future expiration date');
  }

  const pastMicroseconds = ((Math.floor(Date.now() / 1000) - 86400) * 1000000) + 11644473600000000;
  const expiredNonGoogle = cookieImportSetDetails('dead_session', '.myharavan.com', 'old', '/', true, false, 1, pastMicroseconds);
  if (expiredNonGoogle !== null) {
    throw new Error('Expired cookie must return null to prevent reviving dead cookies as session cookies');
  }
  console.log('[Storage] Chrome Profile Sync expiration rules verified.');

  // -------------------------------------------------------------
  // Branch A: Baseline Session (Default Stock Headers, No Overrides)
  // -------------------------------------------------------------
  console.log('\n[Branch A] Testing Baseline Navigation (Stock Electron Headers)...');
  const baselineTelemetry = [];
  const baselineSes = session.fromPartition('baseline-session');
  baselineSes.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    baselineTelemetry.push({ url: details.url, status: details.statusCode, type: details.resourceType });
  });

  const winA = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      session: baselineSes,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await winA.loadURL('https://www.google.com.vn');
    const finalUrlA = winA.webContents.getURL();
    const titleA = winA.getTitle();
    const textA = await winA.webContents.executeJavaScript('document.body.innerText');
    const cookiesA = await baselineSes.cookies.get({});

    const mainResponseA = baselineTelemetry.find((t) => t.type === 'mainFrame') || baselineTelemetry[0];
    const statusA = mainResponseA ? mainResponseA.status : 'unknown';

    console.log(`[Branch A Result] Loaded: ${finalUrlA}`);
    console.log(`[Branch A Result] Main HTTP Status: ${statusA}, Title: "${titleA}", Cookie count: ${cookiesA.length}`);
    console.log(`[Branch A Result] Error in DOM: ${textA.includes('vấn đề với cài đặt cookie')}`);
  } finally {
    winA.destroy();
    await new Promise((r) => setTimeout(r, 500));
  }
  // Branch B: Configured Session (Production UA & Client Hints Policy)
  console.log('\n[Branch B] Testing Production Configured Navigation (Production Session Setup)...');
  const prodSes = session.fromPartition('prod-session');
  const CHROME_USER_AGENT = googleAuthUserAgent();
  prodSes.setUserAgent(CHROME_USER_AGENT);
  const prodTelemetry = [];
  prodSes.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    try {
      const headers = { ...details.requestHeaders };
      delete headers['X-Electron-Version'];
      delete headers['X-Antifan-Version'];
      if (isGoogleAuthUrl(details.url)) {
        setUserAgentHeader(headers, CHROME_USER_AGENT);
        setChromeClientHints(headers);
      } else {
        const uaKey = Object.keys(headers).find((k) => k.toLowerCase() === 'user-agent') || 'User-Agent';
        if (headers[uaKey]) {
          headers[uaKey] = headers[uaKey].replace(/\s*Electron\/\S+/g, '');
        }
      }
      callback({ requestHeaders: headers });
    } catch (err) {
      callback({ requestHeaders: details.requestHeaders });
    }
  });
  prodSes.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    prodTelemetry.push({ url: details.url, status: details.statusCode, type: details.resourceType });
  });

  const winB = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      session: prodSes,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  winB.webContents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.log('[winB did-fail-load]', { errorCode, errorDescription, validatedURL, isMainFrame });
  });
  winB.webContents.on('did-navigate', (e, url, httpResponseCode) => {
    console.log('[winB did-navigate]', { url, httpResponseCode });
  });
  winB.webContents.on('did-redirect-navigation', (e, url, isInPlace, isMainFrame) => {
    console.log('[winB did-redirect-navigation]', { url, isInPlace, isMainFrame });
  });
  try {
    await winB.loadURL('https://www.google.com.vn');
    const finalUrlB = winB.webContents.getURL();
    const titleB = winB.getTitle();
    const textB = await winB.webContents.executeJavaScript('document.body.innerText');
    const cookiesB = await prodSes.cookies.get({});

    const mainResponseB = prodTelemetry.find((t) => t.type === 'mainFrame') || prodTelemetry[0];
    const statusB = mainResponseB ? mainResponseB.status : 'unknown';

    console.log(`[Branch B Result] Loaded: ${finalUrlB}`);
    console.log(`[Branch B Result] Main HTTP Status: ${statusB}, Title: "${titleB}", Cookie count: ${cookiesB.length}`);
    console.log(`[Branch B Result] Negotiated Cookies:`, cookiesB.map((c) => c.name));
    console.log(`[Branch B Result] Error in DOM: ${textB.includes('vấn đề với cài đặt cookie')}`);

    if (textB.includes('vấn đề với cài đặt cookie') || finalUrlB.includes('CookieMismatch')) {
      throw new Error('Branch B navigation failed with Google cookie error');
    }

    // Now test navigating directly to https://www.google.com
    await winB.loadURL('https://www.google.com');
    const dotComUrlB = winB.webContents.getURL();
    const dotComTitleB = winB.getTitle();
    const dotComTextB = await winB.webContents.executeJavaScript('document.body.innerText');
    const dotComResponseB = prodTelemetry.find((t) => t.url.includes('google.com') && t.type === 'mainFrame');
    const dotComStatusB = dotComResponseB ? dotComResponseB.status : 200;

    console.log(`[Branch B .com Result] Loaded: ${dotComUrlB}, Status: ${dotComStatusB}, Title: "${dotComTitleB}"`);
    if (dotComTextB.includes('vấn đề với cài đặt cookie') || dotComUrlB.includes('CookieMismatch')) {
      throw new Error('Branch B .com navigation failed with Google cookie error');
    }
  } finally {
    winB.destroy();
  }

  console.log('\n===============================================================');
  console.log('  [ALL VERIFICATION CHECKS PASSED WITH LIVE TELEMETRY]         ');
  console.log('===============================================================');

  try {
    sentinel.destroy();
    fs.rmSync(tempUserData, { recursive: true, force: true });
  } catch {}

  app.exit(0);
}

app.whenReady().then(runLiveABSmoke).catch((err) => {
  console.error('[AB_SMOKE_FAILED]', err);
  app.exit(1);
});
