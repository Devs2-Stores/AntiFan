/**
 * AntiFan Phone Status Toolbar UI - Real Electron Smoke Test
 * Boots Electron with real toolbar.html & toolbar-preload.js,
 * exercises renderPhoneStatus over IPC and validates DOM elements.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');

app.commandLine.appendSwitch('no-sandbox');
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-phone-ui-smoke-'));
app.setPath('userData', tempUserData);

async function runSmoke() {
  console.log('[Phone UI Smoke] Starting real Electron Toolbar UI smoke test...');
  let win = null;

  try {
    // 1. Mock IPC channels needed by toolbar
    const CHANNELS = {
      GET_INITIAL_STATE: 'antifan:toolbar:get-initial-state',
      GET_PHONE_STATUS: 'antifan:toolbar:get-phone-status',
      PHONE_STATUS: 'antifan:toolbar:phone-status',
      STATE_UPDATED: 'antifan:toolbar:state-updated',
    };

    let currentPhoneStatus = {
      state: 'disconnected',
    };

    ipcMain.handle(CHANNELS.GET_INITIAL_STATE, () => ({
      tabs: [{ id: 'tab-1', url: 'https://example.com', title: 'Example', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1 }],
      activeTabId: 'tab-1',
      phoneStatus: currentPhoneStatus,
    }));

    ipcMain.handle(CHANNELS.GET_PHONE_STATUS, () => currentPhoneStatus);
    ipcMain.handle('antifan:toolbar:set-overlay', () => true);

    // 2. Create window loading toolbar.html
    const preloadPath = path.join(__dirname, '..', '.compiled', 'src', 'preload', 'toolbar-preload.js');
    const toolbarHtmlPath = path.join(__dirname, '..', '.compiled', 'src', 'renderer', 'toolbar.html');

    win = new BrowserWindow({
      width: 1200,
      height: 600,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    await win.loadFile(toolbarHtmlPath);
    console.log('[Phone UI Smoke] toolbar.html loaded successfully in Electron WebContents');

    // Helper to evaluate in page
    const evalInPage = (code) => win.webContents.executeJavaScript(code);

    // 3. Test initial state (disconnected -> badge hidden)
    await new Promise((r) => setTimeout(r, 600));
    const initDisplay = await evalInPage("document.getElementById('btnPhoneStatus').style.display");
    assert.strictEqual(initDisplay, 'none', 'Badge should be hidden when disconnected');
    console.log('  PASS  [1] Initial disconnected state keeps #btnPhoneStatus hidden (display: none)');

    // 4. Push connected iPhone 13 status via IPC
    const connectedStatus = {
      state: 'connected',
      name: "Admin's iPhone",
      model: 'iPhone14,5',
      osVersion: '26.5.2',
      deviceId: '00008110-00013942210A401E',
      connection: 'usb',
      detail: 'Physical iPhone connected via USB (usbmuxd)',
    };
    win.webContents.send(CHANNELS.PHONE_STATUS, connectedStatus);
    await new Promise((r) => setTimeout(r, 200));

    const connectedDisplay = await evalInPage("document.getElementById('btnPhoneStatus').style.display");
    const connectedText = await evalInPage("document.getElementById('phoneStatusText').textContent");
    const hasWdaOffline = await evalInPage("document.getElementById('btnPhoneStatus').classList.contains('phone-wda-offline')");

    assert.strictEqual(connectedDisplay, 'inline-flex', 'Badge should be visible when connected');
    assert.strictEqual(connectedText, 'iPhone 13 Connected', 'Badge text should display "iPhone 13 Connected"');
    assert.strictEqual(hasWdaOffline, false, 'Badge should not have offline class when connected');
    console.log('  PASS  [2] Connected state renders green badge with text "iPhone 13 Connected" (inline-flex)');

    // 5. Test modal details on click
    await evalInPage("document.getElementById('btnPhoneStatus').click()");
    await new Promise((r) => setTimeout(r, 200));

    const modalDisplay = await evalInPage("document.getElementById('phoneStatusOverlay').style.display");
    const modalBodyHtml = await evalInPage("document.getElementById('phoneStatusBody').innerHTML");

    assert.strictEqual(modalDisplay, 'flex', 'Modal overlay should open with display: flex');
    assert.ok(modalBodyHtml.includes("Admin's iPhone"), 'Modal must contain device name');
    assert.ok(modalBodyHtml.includes("iPhone 13 (A2633/iPhone14,5)"), 'Modal must contain friendly model name');
    assert.ok(modalBodyHtml.includes("iOS 26.5.2"), 'Modal must contain iOS version');
    assert.ok(modalBodyHtml.includes("00008110-00013942210A401E"), 'Modal must contain device UDID');
    console.log('  PASS  [3] Clicking badge opens modal overlay with full hardware specifications');

    // Close modal
    await evalInPage("document.getElementById('phoneStatusClose').click()");
    const modalClosedDisplay = await evalInPage("document.getElementById('phoneStatusOverlay').style.display");
    assert.strictEqual(modalClosedDisplay, 'none', 'Modal should close on close button click');
    console.log('  PASS  [4] Closing modal hides the overlay');

    // 6. Test unknown / transport offline state
    const unknownStatus = {
      state: 'unknown',
      name: "Admin's iPhone",
      model: 'iPhone14,5',
      detail: 'usbmuxd transport unreachable',
    };
    win.webContents.send(CHANNELS.PHONE_STATUS, unknownStatus);
    await new Promise((r) => setTimeout(r, 200));

    const unknownDisplay = await evalInPage("document.getElementById('btnPhoneStatus').style.display");
    const unknownText = await evalInPage("document.getElementById('phoneStatusText').textContent");
    const unknownClass = await evalInPage("document.getElementById('btnPhoneStatus').classList.contains('phone-wda-offline')");

    assert.strictEqual(unknownDisplay, 'inline-flex', 'Badge should be visible when status is unknown');
    assert.strictEqual(unknownText, 'iPhone 13 (Muxer Offline)', 'Badge text should indicate muxer offline');
    assert.strictEqual(unknownClass, true, 'Badge should have amber phone-wda-offline class');
    console.log('  PASS  [5] Unknown / muxer offline state renders amber badge "iPhone 13 (Muxer Offline)"');

    // 7. Test disconnected state hides badge again
    win.webContents.send(CHANNELS.PHONE_STATUS, { state: 'disconnected' });
    await new Promise((r) => setTimeout(r, 200));

    const finalDisplay = await evalInPage("document.getElementById('btnPhoneStatus').style.display");
    assert.strictEqual(finalDisplay, 'none', 'Badge should be hidden on disconnect');
    console.log('  PASS  [6] Disconnected state hides #btnPhoneStatus');

    console.log('\n[Phone UI Smoke] ALL 6 CHECKS PASSED: Real Electron toolbar UI verified end-to-end!');
    win.destroy();
    app.quit();
    process.exit(0);
  } catch (err) {
    console.error('\n[Phone UI Smoke] FAIL:', err);
    if (win) win.destroy();
    app.quit();
    process.exit(1);
  }
}

app.whenReady().then(runSmoke);
