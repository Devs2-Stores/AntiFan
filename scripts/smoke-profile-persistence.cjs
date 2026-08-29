const { app, BrowserWindow, protocol, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mode = process.argv[2];
if (mode !== 'write' && mode !== 'read') {
  console.error('usage: electron smoke-profile-persistence.cjs <write|read>');
  process.exit(2);
}

const profilePath = process.env.ANTIFAN_PERSISTENCE_SMOKE_PROFILE || path.join(os.tmpdir(), 'antifan-profile-persistence-smoke');
if (mode === 'write') {
  fs.rmSync(profilePath, { recursive: true, force: true });
}
fs.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', profilePath);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'antifan-smoke',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

const pageHtml = '<!doctype html><meta charset="utf-8"><title>AntiFan persistence smoke</title><body>ready</body>';

function openDatabase(action) {
  return `new Promise((resolve, reject) => {
    const request = indexedDB.open('antifan-persistence-smoke', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if ('${action}' === 'write') {
        const tx = db.transaction('state', 'readwrite');
        tx.objectStore('state').put('indexed-db-value', 'token');
        tx.oncomplete = () => { db.close(); resolve('indexed-db-value'); };
        tx.onerror = () => reject(tx.error);
      } else {
        const tx = db.transaction('state', 'readonly');
        const get = tx.objectStore('state').get('token');
        get.onsuccess = () => { db.close(); resolve(get.result); };
        get.onerror = () => reject(get.error);
      }
    };
  })`;
}

async function run() {
  protocol.handle('antifan-smoke', () => new Response(pageHtml, { headers: { 'content-type': 'text/html' } }));
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadURL('antifan-smoke://app/index.html');
    if (mode === 'write') {
      await session.defaultSession.cookies.set({
        url: 'https://persist.test/',
        name: 'antifan_persistence_smoke',
        value: 'cookie-value',
        secure: true,
        httpOnly: true,
        expirationDate: Math.floor(Date.now() / 1000) + 3600,
      });
      await win.webContents.executeJavaScript("localStorage.setItem('token', 'local-storage-value')");
      const indexedValue = await win.webContents.executeJavaScript(openDatabase('write'));
      if (indexedValue !== 'indexed-db-value') throw new Error(`IndexedDB write returned ${indexedValue}`);
      await session.defaultSession.cookies.flushStore();
      console.log('[profile-smoke] WRITE_OK cookie + localStorage + IndexedDB flushed');
      app.exit(0);
      return;
    }

    const cookies = await session.defaultSession.cookies.get({ url: 'https://persist.test/' });
    const cookie = cookies.find((item) => item.name === 'antifan_persistence_smoke');
    const localValue = await win.webContents.executeJavaScript("localStorage.getItem('token')");
    const indexedValue = await win.webContents.executeJavaScript(openDatabase('read'));
    if (cookie?.value !== 'cookie-value') throw new Error(`Cookie did not survive restart: ${cookie?.value}`);
    if (localValue !== 'local-storage-value') throw new Error(`localStorage did not survive restart: ${localValue}`);
    if (indexedValue !== 'indexed-db-value') throw new Error(`IndexedDB did not survive restart: ${indexedValue}`);

    const { OAuthPopupManager } = require('../.compiled/src/main/browser/oauth-popup-manager.js');
    win.webContents.setWindowOpenHandler((details) => OAuthPopupManager.getInstance().handleWindowOpen(win.webContents, win, details));
    const popup = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OAuth child window was not created')), 5000);
      win.webContents.once('did-create-window', (child) => {
        clearTimeout(timer);
        resolve(child);
      });
      win.webContents.executeJavaScript("window.open('antifan-smoke://identity/oauth/authorize?client_id=smoke', 'oauth-smoke')").catch(reject);
    });
    const sameSession = popup.webContents.session === win.webContents.session;
    const hasOpener = await popup.webContents.executeJavaScript('window.opener !== null');
    popup.destroy();
    if (!sameSession) throw new Error('OAuth child did not share the parent Chromium Session');
    if (!hasOpener) throw new Error('OAuth child lost window.opener');

    console.log('[profile-smoke] READ_OK cookie + localStorage + IndexedDB survived process restart');
    console.log('[profile-smoke] OAUTH_OK child shares Session and preserves window.opener');
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error('[profile-smoke] FAILED', error);
    try { win.destroy(); } catch {}
    app.exit(1);
  }
}

app.whenReady().then(run).catch((error) => {
  console.error('[profile-smoke] START_FAILED', error);
  app.exit(1);
});
