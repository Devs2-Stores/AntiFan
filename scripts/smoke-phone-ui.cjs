/**
 * AntiFan Phone Status Toolbar UI - Real Electron Smoke Test
 *
 * Boots Electron with the real toolbar.html + toolbar-preload.js and drives the phone surface over the
 * real IPC channels. The status payloads below are SYNTHETIC renderer-contract fixtures - they exist to
 * pin how the badge and the panel render each state, and they are NOT evidence about any attached
 * hardware. Live hardware facts come from `npm run probe:device`.
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

    let currentPhoneStatus = { state: 'disconnected' };

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

    const evalInPage = (code) => win.webContents.executeJavaScript(code);
    const push = async (status) => {
      currentPhoneStatus = status;
      win.webContents.send(CHANNELS.PHONE_STATUS, status);
      await new Promise((r) => setTimeout(r, 200));
    };
    const badge = () => evalInPage("({ display: document.getElementById('btnPhoneStatus').style.display, text: document.getElementById('phoneStatusText').textContent, amber: document.getElementById('btnPhoneStatus').classList.contains('phone-wda-offline') })");
    const modalBody = () => evalInPage("document.getElementById('phoneStatusBody').innerHTML");

    // 3. Initial disconnected state
    await new Promise((r) => setTimeout(r, 600));
    const initDisplay = await evalInPage("document.getElementById('btnPhoneStatus').style.display");
    assert.strictEqual(initDisplay, 'none', 'Badge should be hidden when disconnected');
    console.log('  PASS  [1] Disconnected state keeps #btnPhoneStatus hidden (display: none)');

    // 4. A host that never saw a phone must stay quiet: an unanswered usbmuxd is not evidence of a
    //    problem on a machine where no phone was ever attached.
    await push({ state: 'unknown', detail: 'usbmuxd (tcp:27015) không phản hồi' });
    const quietHost = await badge();
    assert.strictEqual(quietHost.display, 'none', 'Badge must stay hidden for unknown state before any phone was seen');
    assert.strictEqual(quietHost.amber, false, 'Amber class must not be applied while the badge is hidden');
    console.log('  PASS  [2] Unknown state before any attachment stays quiet (badge hidden, no false alarm)');

    // 5. Connected device
    await push({
      state: 'connected',
      name: "Admin's iPhone",
      model: 'iPhone14,5',
      osVersion: '26.5.2',
      deviceId: '00008110-00013942210A401E',
      connection: 'usb',
      detail: 'Physical iPhone connected via USB (usbmuxd)',
    });
    const connected = await badge();
    assert.strictEqual(connected.display, 'inline-flex', 'Badge should be visible when connected');
    assert.strictEqual(connected.text, "Admin's iPhone Connected", 'Badge should show the device-reported name');
    assert.strictEqual(connected.amber, false, 'Badge should not have offline class when connected');
    console.log("  PASS  [3] Connected state renders green badge \"Admin's iPhone Connected\"");

    // 6. Modal shows only device-reported facts
    await evalInPage("document.getElementById('btnPhoneStatus').click()");
    await new Promise((r) => setTimeout(r, 200));
    const modalDisplay = await evalInPage("document.getElementById('phoneStatusOverlay').style.display");
    const connectedBody = await modalBody();
    assert.strictEqual(modalDisplay, 'flex', 'Modal overlay should open with display: flex');
    assert.ok(connectedBody.includes("Admin's iPhone"), 'Modal must contain the reported device name');
    assert.ok(connectedBody.includes('iPhone14,5'), 'Modal must contain the raw reported ProductType');
    assert.ok(connectedBody.includes('iOS 26.5.2'), 'Modal must contain the reported iOS version');
    assert.ok(connectedBody.includes('00008110-00013942210A401E'), 'Modal must contain the device UDID');
    assert.ok(
      !connectedBody.includes('A2633'),
      'Modal must not invent a marketing model code the device never reported'
    );
    console.log('  PASS  [4] Modal renders device-reported name, ProductType, iOS version and UDID');

    // 7. A reconnect on an observed host is worth an amber badge
    await push({ state: 'unknown', name: "Admin's iPhone", model: 'iPhone14,5', detail: 'usbmuxd transport unreachable' });
    const unknown = await badge();
    assert.strictEqual(unknown.display, 'inline-flex', 'Badge should be visible when unknown follows a real attachment');
    assert.strictEqual(unknown.text, "Admin's iPhone (Muxer Offline)", 'Badge text should indicate muxer offline');
    assert.strictEqual(unknown.amber, true, 'Badge should have amber phone-wda-offline class');
    console.log('  PASS  [5] Unknown state after an observed attachment renders the amber badge');

    // 8. Disconnect while the panel is open must not leave stale "connected" content behind
    await evalInPage("document.getElementById('btnPhoneStatus').click()");
    await new Promise((r) => setTimeout(r, 200));
    await push({ state: 'disconnected' });
    const afterDisconnectBody = await modalBody();
    assert.ok(
      afterDisconnectBody.includes('Không phát hiện thiết bị iPhone nào'),
      'Open panel must switch to the unplugged message when the phone goes away'
    );
    assert.ok(!afterDisconnectBody.includes('Đã kết nối'), 'Panel must not keep claiming a connected phone');
    await evalInPage("document.getElementById('phoneStatusClose').click()");
    const modalClosedDisplay = await evalInPage("document.getElementById('phoneStatusOverlay').style.display");
    assert.strictEqual(modalClosedDisplay, 'none', 'Modal should close on close button click');
    console.log('  PASS  [6] Disconnecting with the panel open clears stale "connected" content');

    // 9. Device strings are data, not markup: a name carrying HTML must not become DOM
    await push({
      state: 'connected',
      name: '<b id="probe-markup">evil</b>',
      model: '</span><img id="probe-img" src=x onerror="window.__probeXss=1">',
      osVersion: '26.5.2',
      deviceId: '</span><i id="probe-udid"></i>',
      connection: 'usb',
      detail: '</div><script id="probe-script">window.__probeXss=2</script>',
    });
    await evalInPage("document.getElementById('btnPhoneStatus').click()");
    await new Promise((r) => setTimeout(r, 200));
    const injection = await evalInPage(
      "({ markup: document.getElementById('probe-markup'), img: document.getElementById('probe-img'), udid: document.getElementById('probe-udid'), script: document.getElementById('probe-script'), xss: window.__probeXss === undefined ? 0 : window.__probeXss })"
    );
    assert.strictEqual(injection.markup, null, 'Device name markup must not be parsed into elements');
    assert.strictEqual(injection.img, null, 'Model markup must not be parsed into elements');
    assert.strictEqual(injection.udid, null, 'UDID markup must not be parsed into elements');
    assert.strictEqual(injection.script, null, 'Detail markup must not be parsed into elements');
    assert.strictEqual(injection.xss, 0, 'No injected handler may execute');
    const escapedBody = await modalBody();
    assert.ok(escapedBody.includes('&lt;b id="probe-markup"&gt;'), 'Hostile name must appear as escaped text');
    console.log('  PASS  [7] Device-supplied strings are escaped, never parsed as markup');

    // 10. Escape closes the panel
    await evalInPage("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await new Promise((r) => setTimeout(r, 100));
    const escapeClosed = await evalInPage("document.getElementById('phoneStatusOverlay').style.display");
    assert.strictEqual(escapeClosed, 'none', 'Escape must close the phone panel');
    console.log('  PASS  [8] Escape closes the phone panel');

    console.log('\n[Phone UI Smoke] ALL 8 CHECKS PASSED: Real Electron toolbar UI verified end-to-end!');
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
