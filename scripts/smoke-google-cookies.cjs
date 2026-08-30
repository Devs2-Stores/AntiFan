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
  chromeSessionUserAgent,
  isGoogleAuthUrl,
  setUserAgentHeader,
  setChromeClientHints,
  applyGoogleAuthIdentity,
} = require('../.compiled/src/main/browser/google-auth-identity.js');
const {
  configureBrowserSessionPartition,
  deriveCapsulePartition,
} = require('../.compiled/src/main/browser/browser-session-partition.js');

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
  // Branch A: Native Partition (Zero UA/Header Laundering for Auth)
  // -------------------------------------------------------------
  console.log('\n[Branch A] Testing Native Partition (persist:capsule-test-native)...');
  const nativePartition = deriveCapsulePartition('test', 'native');
  const nativeSes = configureBrowserSessionPartition(nativePartition, 'native');
  const nativeTelemetry = [];
  nativeSes.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    nativeTelemetry.push({ url: details.url, status: details.statusCode, type: details.resourceType });
  });

  const winA = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      partition: nativePartition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await winA.loadURL('https://accounts.google.com/');
    const finalUrlA = winA.webContents.getURL();
    const titleA = winA.getTitle();
    const cookiesA = await nativeSes.cookies.get({});
    const mainResponseA = nativeTelemetry.find((t) => t.type === 'mainFrame') || nativeTelemetry[0];
    const statusA = mainResponseA ? mainResponseA.status : 'unknown';

    console.log(`[Branch A Native Result] Loaded: ${finalUrlA}`);
    console.log(`[Branch A Native Result] Status: ${statusA}, Title: "${titleA}", Cookies: ${cookiesA.length}`);
    if (finalUrlA.includes('CookieMismatch')) {
      throw new Error('Branch A navigation encountered CookieMismatch');
    }
  } finally {
    winA.destroy();
    await new Promise((r) => setTimeout(r, 500));
  }

  // -------------------------------------------------------------
  // Branch B: Clean Partition (Clean Desktop Chrome UA for Storefronts)
  // -------------------------------------------------------------
  console.log('\n[Branch B] Testing Clean Partition (persist:capsule-test-clean)...');
  const cleanPartition = deriveCapsulePartition('test', 'clean');
  const cleanSes = configureBrowserSessionPartition(cleanPartition, 'clean');
  const cleanTelemetry = [];
  cleanSes.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    cleanTelemetry.push({ url: details.url, status: details.statusCode, type: details.resourceType });
  });

  const winB = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      partition: cleanPartition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await winB.loadURL('https://www.google.com/');
    const finalUrlB = winB.webContents.getURL();
    const titleB = winB.getTitle();
    const cookiesB = await cleanSes.cookies.get({});
    const mainResponseB = cleanTelemetry.find((t) => t.type === 'mainFrame') || cleanTelemetry[0];
    const statusB = mainResponseB ? mainResponseB.status : 'unknown';

    console.log(`[Branch B Clean Result] Loaded: ${finalUrlB}`);
    console.log(`[Branch B Clean Result] Status: ${statusB}, Title: "${titleB}", Cookies: ${cookiesB.length}`);
    if (finalUrlB.includes('CookieMismatch')) {
      throw new Error('Branch B navigation encountered CookieMismatch');
    }
  } finally {
    winB.destroy();
  }
  // -------------------------------------------------------------
  // Branch C: Live Google Sign-In Identifier Test (hangquoctai.157)
  // -------------------------------------------------------------
  console.log('\n[Branch C] Testing Live Google Sign-In Identifier Flow...');
  const authPartition = deriveCapsulePartition('smoke-auth-c', 'clean');
  const authSes = configureBrowserSessionPartition(authPartition, 'clean');
  const preloadPath = path.join(__dirname, '../.compiled/src/preload/tab-preload.js');

  const winC = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      partition: authPartition,
      contextIsolation: false,
      sandbox: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });
  const baseUa = chromeSessionUserAgent();
  applyGoogleAuthIdentity(winC.webContents, 'https://accounts.google.com/', baseUa);
  winC.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) applyGoogleAuthIdentity(winC.webContents, url, baseUa);
  });
  try {
    await winC.loadURL('https://accounts.google.com/');
    await new Promise((r) => setTimeout(r, 2000));

    const debugProps = await winC.webContents.executeJavaScript(`
      ({
        ua: navigator.userAgent,
        hasChrome: 'chrome' in window,
        hasUserAgentData: 'userAgentData' in navigator,
        hasInstallTrigger: 'InstallTrigger' in window,
        oscpu: navigator.oscpu,
        pdfViewerEnabled: navigator.pdfViewerEnabled,
        webdriver: navigator.webdriver,
        title: document.title,
      })
    `);
    console.log('[Branch C Debug Props]:', debugProps);

    await winC.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector('input[type="email"]') || document.querySelector('input[name="identifier"]');
        if (input) {
          input.focus();
          input.value = 'hangquoctai.157@gmail.com';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          const btn = document.querySelector('#identifierNext button') || document.querySelector('button[type="button"]');
          if (btn) btn.click();
        }
      })()
    `);

    await new Promise((r) => setTimeout(r, 5000));

    const resultC = await winC.webContents.executeJavaScript(`
      (() => {
        const text = document.body ? document.body.innerText : '';
        return {
          url: window.location.href,
          title: document.title,
          hasInsecureWarning: text.includes("Couldn't sign you in") ||
                              text.includes("This browser or app may not be secure") ||
                              text.includes("Trình duyệt hoặc ứng dụng này có thể không an toàn"),
          hasPasswordPrompt: !!document.querySelector('input[type="password"]'),
        };
      })()
    `);

    console.log(`[Branch C Auth Result] Final URL: ${resultC.url}`);
    console.log(`[Branch C Auth Result] Title: "${resultC.title}", PasswordPrompt: ${resultC.hasPasswordPrompt}, InsecureWarning: ${resultC.hasInsecureWarning}`);

    if (resultC.hasInsecureWarning) {
      throw new Error('Branch C encountered Google insecure browser rejection');
    }
  } finally {
    winC.destroy();
  }

  // -------------------------------------------------------------
  // Branch D: Gmail GlifWebSignIn Live Flow (User Reported URL)
  // -------------------------------------------------------------
  console.log('\n[Branch D] Testing Gmail Direct Sign-In Flow...');
  const gmailPartition = deriveCapsulePartition('smoke-gmail-d', 'clean');
  const gmailSes = configureBrowserSessionPartition(gmailPartition, 'clean');

  const winD = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      partition: gmailPartition,
      contextIsolation: false,
      sandbox: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  const gmailSigninUrl = 'https://mail.google.com/mail/?service=mail&flowName=GlifWebSignIn&flowEntry=AccountChooser&ec=asw-gmail-globalnav-signin';
  applyGoogleAuthIdentity(winD.webContents, gmailSigninUrl, chromeSessionUserAgent());

  try {
    await winD.loadURL(gmailSigninUrl);
    await new Promise((r) => setTimeout(r, 2500));

    const resultD = await winD.webContents.executeJavaScript(`
      (() => {
        const text = document.body ? document.body.innerText : '';
        return {
          url: window.location.href,
          title: document.title,
          hasInsecureWarning: text.includes("Couldn't sign you in") ||
                              text.includes("This browser or app may not be secure") ||
                              text.includes("Trình duyệt hoặc ứng dụng này có thể không an toàn"),
          hasIdentifierInput: !!(document.querySelector('input[type="email"]') || document.querySelector('input[name="identifier"]')),
        };
      })()
    `);

    console.log(`[Branch D Gmail Result] Final URL: ${resultD.url}`);
    console.log(`[Branch D Gmail Result] Title: "${resultD.title}", IdentifierInput: ${resultD.hasIdentifierInput}, InsecureWarning: ${resultD.hasInsecureWarning}`);

    if (resultD.hasInsecureWarning || !resultD.hasIdentifierInput) {
      throw new Error('Branch D Gmail sign-in flow failed or showed insecure warning');
    }
  } finally {
    winD.destroy();
  }
  console.log('  [ALL VERIFICATION CHECKS PASSED WITH LIVE TELEMETRY]         ');
  console.log('===============================================================');
  try {
    sentinel.destroy();
    fs.rmSync(tempUserData, { recursive: true, force: true });
  } catch {}
  app.exit(0);
  process.exit(0);
}

app.whenReady().then(runLiveABSmoke).catch((err) => {
  console.error('[AB_SMOKE_FAILED]', err);
  app.exit(1);
});
