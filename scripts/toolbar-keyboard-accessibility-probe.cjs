/**
 * AntiFan Toolbar Keyboard & Accessibility Empirical Probe
 * Uses real compiled toolbar.html + toolbar-preload.js with contextIsolation: true.
 * Exercises:
 * 1. Multi-tab initialization via real antifan:toolbar:get-initial-state IPC
 * 2. Real DOM rendering by compiled toolbar.js
 * 3. Asserts exact roving tabindex (active=0, inactive=-1)
 * 4. Dispatches keyboard ArrowRight and asserts switch-tab IPC call and focus movement
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const switchedTabs = [];
let win = null;

const initialTabs = [
  { id: 'tab-1', url: 'https://example.com/1', title: 'First Tab', state: { url: 'https://example.com/1' } },
  { id: 'tab-2', url: 'https://example.com/2', title: 'Second Tab (Active)', state: { url: 'https://example.com/2' } },
  { id: 'tab-3', url: 'https://example.com/3', title: 'Third Tab', state: { url: 'https://example.com/3' } }
];

app.whenReady().then(async () => {
  // 1. Mock Toolbar IPC surface
  ipcMain.handle('antifan:toolbar:get-initial-state', () => {
    return {
      tabs: initialTabs,
      activeTabId: 'tab-2',
      bookmarks: [],
      chromeProfiles: [],
      themeQa: { status: 'idle', issueCount: 0, updatedAt: Date.now() }
    };
  });

  ipcMain.handle('antifan:toolbar:switch-tab', (_event, tabId) => {
    switchedTabs.push(tabId);
    return true;
  });

  ipcMain.handle('antifan:toolbar:close-tab', (_event, _tabId) => true);
  ipcMain.handle('antifan:toolbar:toggle-mute', (_event, _tabId) => true);
  ipcMain.handle('antifan:toolbar:get-mobile-remote-info', () => null);

  // 2. Launch BrowserWindow with real toolbar preload and contextIsolation
  const preloadPath = path.resolve(__dirname, '../.compiled/src/preload/toolbar-preload.js');
  const toolbarHtmlPath = path.resolve(__dirname, '../.compiled/src/renderer/toolbar.html');

  win = new BrowserWindow({
    width: 1000,
    height: 300,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });

  await win.loadFile(toolbarHtmlPath);

  // Allow DOM to settle and renderTabs to execute
  await new Promise(resolve => setTimeout(resolve, 800));

  // 3. Probe real production DOM in the isolated world
  const domReport = await win.webContents.executeJavaScript(`
    (() => {
      const tabElements = Array.from(document.querySelectorAll('.tab'));
      if (tabElements.length === 0) {
        return { error: 'NO_TABS_RENDERED' };
      }

      const activeTabEl = document.querySelector('.tab.active');
      const tabindexes = tabElements.map(el => el.getAttribute('tabindex'));
      const activeTabId = activeTabEl ? activeTabEl.getAttribute('data-tab-id') : null;

      // Focus the currently active tab
      if (activeTabEl) {
        activeTabEl.focus();
      }

      // Dispatch ArrowRight keydown
      const arrowRightEvt = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        code: 'ArrowRight',
        bubbles: true,
        cancelable: true
      });
      activeTabEl.dispatchEvent(arrowRightEvt);

      const focusedAfterArrow = document.activeElement ? document.activeElement.getAttribute('data-tab-id') : null;

      return {
        tabCount: tabElements.length,
        tabindexes,
        activeTabId,
        focusedAfterArrow,
        activeBg: activeTabEl ? window.getComputedStyle(activeTabEl).backgroundColor : null
      };
    })()
  `);

  console.log('[Accessibility Probe] Production Toolbar Report:', domReport);

  assert.ok(!domReport.error, `DOM rendering error: ${domReport.error}`);
  assert.strictEqual(domReport.tabCount, 3, 'Must render 3 production tabs');
  assert.strictEqual(domReport.activeTabId, 'tab-2', 'Production active tab must match initial state tab-2');
  assert.deepStrictEqual(domReport.tabindexes, ['-1', '0', '-1'], 'Roving tabindex must assign 0 exclusively to active tab');
  assert.strictEqual(domReport.focusedAfterArrow, 'tab-3', 'ArrowRight must advance focus to tab-3');
  assert.ok(switchedTabs.includes('tab-3'), 'ArrowRight must trigger switch-tab IPC call for tab-3');

  console.log('[Accessibility Probe] ALL CHECKS PASSED WITH ZERO SYNTHETIC FALLBACKS.');
  win.destroy();
  app.quit();
}).catch(err => {
  console.error('[Accessibility Probe] FAILED:', err);
  if (win && !win.isDestroyed()) win.destroy();
  process.exit(1);
});
