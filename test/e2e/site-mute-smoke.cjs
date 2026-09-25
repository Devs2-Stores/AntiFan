/**
 * Site Mute Smoke & Regression Certification Test
 * Tests #btnMute visibility, 960px layout, non-HTTP disabled state, UI click,
 * multi-surface sync (desktop, mobile, background tab), 127.0.0.1 vs localhost isolation,
 * navigation reload/away/back persistence, new tab inheritance, and fresh-process restoration.
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
const { spawn } = require('node:child_process');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.on('window-all-closed', () => {});

// Top-level userData isolation BEFORE app.whenReady
const isVerifyPhase = process.argv.includes('--phase=verify');
const userDataDir = process.env.ANTIFAN_SITE_MUTE_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-site-mute-smoke-'));
app.setPath('userData', userDataDir);
process.env.ANTIFAN_DATA_ROOT = userDataDir;
process.env.ANTIFAN_CONFIG_DIR = userDataDir;
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';

const watchdog = setTimeout(() => {
  console.error('[SMOKE-MUTE] Watchdog timeout after 120s; exiting 1');
  process.exit(1);
}, 120000);

async function waitFor(desc, fn, timeoutMs = 10000, intervalMs = 50) {
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

async function getToolbarMuteState(tabHost) {
  return await tabHost.toolbarView.webContents.executeJavaScript(`
    (() => {
      const btn = document.getElementById('btnMute');
      if (!btn) return { exists: false };
      const s = window.getComputedStyle(btn);
      const r = btn.getBoundingClientRect();
      return {
        exists: true,
        disabled: Boolean(btn.disabled),
        ariaPressed: btn.getAttribute('aria-pressed'),
        isMuted: btn.classList.contains('muted'),
        visible: s.display !== 'none' && s.visibility !== 'hidden',
        rect: { width: r.width, height: r.height, right: r.right, left: r.left }
      };
    })()
  `);
}

async function clickToolbarMute(tabHost) {
  return await tabHost.toolbarView.webContents.executeJavaScript(`
    (() => {
      const btn = document.getElementById('btnMute');
      if (!btn) throw new Error('#btnMute not found');
      btn.click();
      return true;
    })()
  `);
}

const { NativeTabHost } = require(path.resolve(__dirname, '../../.compiled/src/main/browser/native-tab-host.js'));

async function runVerifyPhase() {
  const port = Number(process.env.ANTIFAN_SITE_MUTE_PORT);
  const targetUrl = `http://127.0.0.1:${port}/`;
  const win = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { contextIsolation: true } });
  const tabHost = new NativeTabHost(win);

  try {
    const tabId = tabHost.createTab(targetUrl, true);
    await waitFor('verify tab load', () => {
      const t = tabHost.getTabList().find((x) => x.id === tabId);
      const wc = tabHost.getTabWebContents(tabId);
      return t && !t.isLoading && wc && !wc.isDestroyed() && wc.getURL().startsWith(targetUrl);
    });

    const wc = tabHost.getTabWebContents(tabId);
    assert.equal(wc.isAudioMuted(), true, 'Constructor must restore audio mute for persisted host');
    assert.equal(tabHost.getTabList().find((x) => x.id === tabId)?.isMuted, true);

    await waitFor('verify toolbar muted', async () => {
      const s = await getToolbarMuteState(tabHost);
      return s.exists && s.isMuted && s.ariaPressed === 'true';
    });

    // Unmute via UI click
    await clickToolbarMute(tabHost);
    await waitFor('verify unmuted', () => !wc.isAudioMuted() && tabHost.getTabList().find((x) => x.id === tabId)?.isMuted === false);
    assert.equal(wc.isAudioMuted(), false);

    tabHost.persistTabs();
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, 'saved-tabs.json'), 'utf8'));
    assert.equal((raw.mutedSites || []).includes('127.0.0.1'), false, 'Unmute must remove host from saved-tabs.json');
    console.log('[SMOKE-MUTE] Phase 2 verification passed.');
  } finally {
    tabHost.dispose();
    if (!win.isDestroyed()) win.destroy();
    clearTimeout(watchdog);
  }
}

async function runMainPhase() {
  let server, win, tabHost;
  try {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><h1>Mute Fixture</h1><p>${req.url}</p></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url127 = `http://127.0.0.1:${port}/`;
    const url127Page2 = `http://127.0.0.1:${port}/page2`;
    const urlLocalhost = `http://localhost:${port}/`;

    win = new BrowserWindow({ width: 1440, height: 900, show: true, webPreferences: { contextIsolation: true } });
    tabHost = new NativeTabHost(win);

    // 1. Initial HTTP silent page: enabled, unmuted, 960px layout check, blank page disabled
    const tab1Id = tabHost.createTab(url127, true);
    await waitFor('tab 1 load', () => {
      const t = tabHost.getTabList().find((x) => x.id === tab1Id);
      const wc = tabHost.getTabWebContents(tab1Id);
      return t && !t.isLoading && wc && !wc.isDestroyed() && wc.getURL().startsWith(url127);
    });

    const tab1Wc = tabHost.getTabWebContents(tab1Id);
    assert.equal(tab1Wc.isAudioMuted(), false);
    await waitFor('toolbar btnMute ready', async () => {
      const state = await getToolbarMuteState(tabHost);
      return state.exists && !state.disabled;
    });

    const btnInit = await getToolbarMuteState(tabHost);
    assert.equal(btnInit.exists, true, '#btnMute must exist in toolbar');
    assert.equal(btnInit.visible, true);
    assert.equal(btnInit.disabled, false);
    assert.equal(btnInit.isMuted, false);
    assert.equal(btnInit.ariaPressed, 'false');

    // 960px bounding box check
    win.setBounds({ x: 0, y: 0, width: 960, height: 800 });
    await waitFor('960px bounds settled', async () => (await getToolbarMuteState(tabHost)).rect?.width > 0);
    const btn960 = await getToolbarMuteState(tabHost);
    assert.equal(btn960.visible, true);
    assert.ok(btn960.rect.width > 0 && btn960.rect.height > 0);
    assert.ok(btn960.rect.right <= 960, '#btnMute must be within 960px viewport');
    win.setBounds({ x: 0, y: 0, width: 1440, height: 900 });

    // about:blank disables #btnMute
    tabHost.navigate(tab1Id, 'about:blank');
    await waitFor('about:blank loaded', () => tabHost.getTabWebContents(tab1Id)?.getURL() === 'about:blank');
    await waitFor('btnMute disabled on blank', async () => (await getToolbarMuteState(tabHost)).disabled === true);
    assert.equal((await getToolbarMuteState(tabHost)).disabled, true);

    tabHost.navigate(tab1Id, url127);
    await waitFor('tab 1 returns to http', () => tabHost.getTabWebContents(tab1Id)?.getURL().startsWith(url127));
    await waitFor('btnMute re-enabled', async () => (await getToolbarMuteState(tabHost)).disabled === false);

    // 2. Multi-surface sync: desktop + split mobile + same-host tab 2
    const tab2Id = tabHost.createTab(url127Page2, false);
    await waitFor('tab 2 load', () => !tabHost.getTabList().find((x) => x.id === tab2Id)?.isLoading);

    tabHost.toggleSplitReview(tab1Id, true);
    await waitFor('split mobile ready and loaded', () => {
      const t = tabHost.getTabList().find((x) => x.id === tab1Id);
      const m = tabHost.getTabWebContents(tab1Id, 'mobile');
      return t?.splitMode && m && !m.isDestroyed() && !m.isLoading() && m.getURL().startsWith(url127);
    });

    const mobileWc = tabHost.getTabWebContents(tab1Id, 'mobile');
    const tab2Wc = tabHost.getTabWebContents(tab2Id);
    assert.equal(tab1Wc.isAudioMuted(), false);
    assert.equal(mobileWc.isAudioMuted(), false);
    assert.equal(tab2Wc.isAudioMuted(), false);

    // Click UI #btnMute
    await clickToolbarMute(tabHost);
    await waitFor('all same-host surfaces muted', () =>
      tab1Wc.isAudioMuted() && mobileWc.isAudioMuted() && tab2Wc.isAudioMuted() &&
      tabHost.getTabList().find((x) => x.id === tab1Id)?.isMuted &&
      tabHost.getTabList().find((x) => x.id === tab2Id)?.isMuted
    );
    assert.equal(tab1Wc.isAudioMuted(), true);
    assert.equal(mobileWc.isAudioMuted(), true);
    assert.equal(tab2Wc.isAudioMuted(), true);

    await waitFor('toolbar mute state rendered', async () => (await getToolbarMuteState(tabHost)).isMuted === true);
    const btnMuted = await getToolbarMuteState(tabHost);
    assert.equal(btnMuted.isMuted, true);
    assert.equal(btnMuted.ariaPressed, 'true');
    assert.equal(await tabHost.toolbarView.webContents.executeJavaScript(`
      document.querySelector('.tab[data-tab-id="${tab1Id}"] .tab-audio-btn')?.getAttribute('aria-pressed')
    `), 'true');

    // 3. Different hostname isolation (127.0.0.1 vs localhost)
    const tab3Id = tabHost.createTab(urlLocalhost, false);
    await waitFor('tab 3 localhost load', () => !tabHost.getTabList().find((x) => x.id === tab3Id)?.isLoading);
    const tab3Wc = tabHost.getTabWebContents(tab3Id);
    assert.equal(tab3Wc.isAudioMuted(), false, 'Localhost tab must NOT be muted by 127.0.0.1 preference');
    assert.equal(tabHost.getTabList().find((x) => x.id === tab3Id)?.isMuted, false);

    tabHost.switchTab(tab3Id);
    await waitFor('toolbar unmuted on localhost', async () => !(await getToolbarMuteState(tabHost)).isMuted);
    assert.equal((await getToolbarMuteState(tabHost)).ariaPressed, 'false');

    tabHost.switchTab(tab1Id);
    await waitFor('toolbar muted on 127.0.0.1', async () => (await getToolbarMuteState(tabHost)).isMuted);
    assert.equal((await getToolbarMuteState(tabHost)).ariaPressed, 'true');

    // 4. Navigation lifecycle: reload maintains, away clears, back restores
    const reloadFinished = new Promise((resolve) => tab1Wc.once('did-finish-load', resolve));
    tabHost.reload(tab1Id);
    await reloadFinished;
    assert.equal(tab1Wc.isAudioMuted(), true);

    tabHost.navigate(tab1Id, urlLocalhost);
    await waitFor('nav away completes', () => tab1Wc.getURL().startsWith(urlLocalhost) && !tabHost.getTabList().find((x) => x.id === tab1Id)?.isLoading);
    assert.equal(tab1Wc.isAudioMuted(), false);

    tabHost.navigate(tab1Id, url127);
    await waitFor('nav back completes', () => tab1Wc.getURL().startsWith(url127) && !tabHost.getTabList().find((x) => x.id === tab1Id)?.isLoading);
    assert.equal(tab1Wc.isAudioMuted(), true);

    // 5. New tab inherits
    const tab4Id = tabHost.createTab(url127Page2, false);
    await waitFor('tab 4 load', () => !tabHost.getTabList().find((x) => x.id === tab4Id)?.isLoading);
    assert.equal(tabHost.getTabWebContents(tab4Id).isAudioMuted(), true);

    // 6. Persistence & fresh process
    tabHost.persistTabs();
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'saved-tabs.json'), 'utf8'));
    assert.equal((saved.mutedSites || []).includes('127.0.0.1'), true);
    assert.equal((saved.mutedSites || []).includes('localhost'), false);

    // Parent dispose before child
    tabHost.dispose();
    tabHost = null;
    win.destroy();
    win = null;

    const childEnv = { ...process.env, ANTIFAN_SITE_MUTE_USERDATA: userDataDir, ANTIFAN_SITE_MUTE_PORT: String(port) };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const childExit = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [__filename, '--phase=verify'], { stdio: 'inherit', env: childEnv });
      c.on('error', reject);
      c.on('exit', resolve);
    });
    assert.equal(childExit, 0, 'Phase 2 process must exit cleanly');
    console.log('[SMOKE-MUTE] All site-mute smoke checks passed successfully.');
  } finally {
    if (tabHost) { try { tabHost.dispose(); } catch {} }
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch {} }
    if (server) { try { server.close(); } catch {} }
    if (userDataDir && fs.existsSync(userDataDir)) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
    clearTimeout(watchdog);
  }
}

app.whenReady().then(async () => {
  if (isVerifyPhase) await runVerifyPhase();
  else await runMainPhase();
  app.exit(0);
}).catch((err) => {
  console.error('[SMOKE-MUTE] Fatal error:', err);
  clearTimeout(watchdog);
  app.exit(1);
});
