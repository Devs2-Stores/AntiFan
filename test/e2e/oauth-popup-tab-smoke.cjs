/**
 * OAuth popup tab smoke (real Electron, real NativeTabHost, real Chromium).
 *
 * An OAuth `window.open` must become a regular AntiFan tab of the opener's window, not a native
 * BrowserWindow: it keeps `window.opener`, reads the opener's cookie jar, appears in the tab list
 * marked `popupOf`, is presented to the user, and when the popup page calls `window.close()` the
 * tab disappears and the opener is the active tab again. A non-OAuth `window.open` keeps its
 * ordinary path (denied native window, plain tab, no `popupOf`).
 *
 * Run: node test/e2e/oauth-popup-tab-smoke.cjs   (needs `npm run compile` output in .compiled)
 */

'use strict';

const isElectron = Boolean(process.versions && process.versions.electron);

if (!isElectron) {
  const path = require('node:path');
  const { spawn } = require('node:child_process');
  const runElectron = path.resolve(__dirname, '../../scripts/run-electron.cjs');
  const child = spawn(process.execPath, [runElectron, __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  child.on('error', (error) => { console.error(error); process.exit(1); });
  child.on('exit', (code) => process.exit(typeof code === 'number' ? code : 1));
  return;
}

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { ProjectWindowShell } = require(path.resolve(__dirname, '../../.compiled/src/main/browser/project-window-shell.js'));
const { NativeTabHost } = require(path.resolve(__dirname, '../../.compiled/src/main/browser/native-tab-host.js'));
const { setChromeSenderResolver } = require(path.resolve(__dirname, '../../.compiled/src/main/browser/ipc-router.js'));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.on('window-all-closed', () => {});

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-oauth-popup-smoke-'));
app.setPath('userData', userDataDir);
process.env.ANTIFAN_DATA_ROOT = userDataDir;
process.env.ANTIFAN_CONFIG_DIR = userDataDir;
process.env.ANTIFAN_USER_DATA = userDataDir;
process.env.ANTIFAN_USER_DATA_DIR = userDataDir;
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';

const watchdog = setTimeout(() => {
  console.error('[SMOKE-OAUTH-POPUP] Watchdog timeout after 120s; exiting 1');
  process.exit(1);
}, 120000);

async function waitFor(desc, fn, timeoutMs = 15000, intervalMs = 50) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fn();
      if (res) return res;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for ${desc}${lastErr ? ': ' + lastErr.message : ''}`);
}

function installChromeSenderResolver(winShell, tabHost) {
  setChromeSenderResolver((webContents) => {
    const surface = winShell.chromeSurfaceFor(webContents.id) || tabHost.surfaceForWebContents(webContents.id);
    return surface ? { host: tabHost, surface } : undefined;
  });
}

const PARENT_PAGE = `<!DOCTYPE html><html><body>parent<script>
  window.__messages = [];
  window.addEventListener('message', (event) => { window.__messages.push(event.data); });
</script></body></html>`;

const POPUP_PAGE = `<!DOCTYPE html><html><body>popup<script>
  window.__report = { hasOpener: window.opener !== null, cookie: document.cookie };
  if (window.opener) window.opener.postMessage({ from: 'popup', cookie: document.cookie }, '*');
</script></body></html>`;

async function main() {
  let server;
  let winShell;
  let tabHost;
  try {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.url.startsWith('/oauth/authorize') ? POPUP_PAGE : (req.url.startsWith('/plain') ? '<!DOCTYPE html><html><body>plain</body></html>' : PARENT_PAGE));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    winShell = new ProjectWindowShell({ owner: { kind: 'project', projectId: 'project-00000000-0000-4000-8000-0000000000e2' }, title: 'AntiFan OAuth Popup Smoke', bounds: { width: 1280, height: 800 }, show: true });
    tabHost = new NativeTabHost(winShell);
    installChromeSenderResolver(winShell, tabHost);

    const openerId = tabHost.createTab(`${origin}/`, true);
    const openerWc = await waitFor('opener load', () => {
      const wc = tabHost.getTabWebContents(openerId, 'desktop');
      const row = tabHost.getTabList().find((tab) => tab.id === openerId);
      return wc && !wc.isDestroyed() && row && !row.isLoading && wc.getURL().startsWith(origin) ? wc : false;
    });
    await openerWc.session.cookies.set({ url: origin, name: 'sid', value: 'opener-cookie' });
    const windowsBefore = BrowserWindow.getAllWindows().length;

    // 1. OAuth window.open -> a registered popup tab hosted by the opener's host.
    await openerWc.executeJavaScript(`window.__popup = window.open('${origin}/oauth/authorize?client_id=1', '_blank'); 1`, true);
    const popupId = await waitFor('popup tab registration', () => {
      const row = tabHost.getTabList().find((tab) => tab.popupOf === openerId);
      return row ? row.id : false;
    });
    assert.notEqual(popupId, openerId);
    assert.equal(BrowserWindow.getAllWindows().length, windowsBefore, 'no native popup window may be created');
    await waitFor('popup presented', () => tabHost.getActiveTabId() === popupId);

    const popupWc = tabHost.getTabWebContents(popupId, 'desktop');
    assert.ok(popupWc && !popupWc.isDestroyed(), 'the popup tab owns a live WebContents');
    assert.strictEqual(popupWc.session, openerWc.session, 'the popup shares the opener\'s Session object');
    const popupRow = tabHost.getTabList().find((tab) => tab.id === popupId);
    const openerRow = tabHost.getTabList().find((tab) => tab.id === openerId);
    assert.equal(popupRow.popupOf, openerId);
    assert.equal(openerRow.popupOf, undefined);
    assert.equal(popupRow.partition, openerRow.partition, 'same partition label as the opener');

    await waitFor('popup page load', async () => {
      const state = await popupWc.executeJavaScript('document.readyState + "|" + typeof window.__report');
      return state === 'complete|object';
    });
    const report = await popupWc.executeJavaScript('window.__report');
    assert.equal(report.hasOpener, true, 'window.opener must be set in the popup');
    assert.match(report.cookie, /sid=opener-cookie/, 'the popup must read the opener\'s cookie jar');
    const messages = await waitFor('opener receives the popup message', async () => {
      const received = await openerWc.executeJavaScript('window.__messages');
      return received.length > 0 ? received : false;
    });
    assert.equal(messages[0].from, 'popup');
    assert.match(messages[0].cookie, /sid=opener-cookie/);

    // 2. The popup page closes itself: the tab goes away and the opener is active again.
    await popupWc.executeJavaScript('window.close()').catch(() => undefined);
    await waitFor('popup tab removal', () => tabHost.hasExactTab(popupId) === false);
    await waitFor('opener re-activated', () => tabHost.getActiveTabId() === openerId);
    assert.equal(await openerWc.executeJavaScript('window.__popup.closed'), true, 'the opener sees the popup as closed');

    // 3. A non-OAuth window.open keeps its ordinary path.
    const tabsBeforePlain = tabHost.getTabList().map((tab) => tab.id);
    const plainResult = await openerWc.executeJavaScript(`String(window.open('${origin}/plain', '_blank'))`, true);
    assert.equal(plainResult, 'null', 'a non-OAuth popup is denied as a native window');
    const plainRow = await waitFor('plain tab creation', () => tabHost.getTabList().find((tab) => !tabsBeforePlain.includes(tab.id)));
    assert.equal(plainRow.popupOf, undefined, 'an ordinary link tab is not a popup tab');
    assert.equal(BrowserWindow.getAllWindows().length, windowsBefore, 'still no native popup window');

    console.log('[SMOKE-OAUTH-POPUP] passed.');
    app.exit(0);
  } catch (error) {
    console.error('[SMOKE-OAUTH-POPUP] FAILED:', error && error.stack ? error.stack : error);
    app.exit(1);
  } finally {
    clearTimeout(watchdog);
  }
}

app.whenReady().then(main);
