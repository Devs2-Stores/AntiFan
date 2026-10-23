/**
 * JavaScript dialog smoke (real Electron, real NativeTabHost, real Chromium, real Win32 boxes).
 *
 * The field failure: an agent clicked a "delete" button whose handler calls `confirm()`. The click's
 * mouseReleased froze until the dialog was answered, the agent had no way to answer it, and every
 * later call on the tab timed out (TARGET_BUSY_DRAINING). Here the same click must return at once,
 * the open dialog must be readable, new CDP work must be refused with DIALOG_OPEN instead of hanging,
 * answering must resume the page with the chosen result, and the native `#32770` box Electron leaves
 * on screen after a CDP answer must be gone, even when the answer lands before the box has shown.
 * A background tab's unowned box is closed too, but only when no other dialog is open: a box that
 * cannot be proven the answered dialog's is never closed, since closing it answers its own dialog.
 *
 * Run: node test/e2e/js-dialog-smoke.cjs   (needs `npm run compile` output in .compiled)
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

const { app } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { ProjectWindowShell } = require(path.resolve(__dirname, '../../.compiled/src/main/browser/project-window-shell.js'));
const { NativeTabHost } = require(path.resolve(__dirname, '../../.compiled/src/main/browser/native-tab-host.js'));
const { setChromeSenderResolver } = require(path.resolve(__dirname, '../../.compiled/src/main/browser/ipc-router.js'));
const { listOwnedMessageBoxes, hwndOf } = require(path.resolve(__dirname, '../../.compiled/src/main/browser/native-dialog-boxes.js'));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.on('window-all-closed', () => {});

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-js-dialog-smoke-'));
app.setPath('userData', userDataDir);
process.env.ANTIFAN_DATA_ROOT = userDataDir;
process.env.ANTIFAN_CONFIG_DIR = userDataDir;
process.env.ANTIFAN_USER_DATA = userDataDir;
process.env.ANTIFAN_USER_DATA_DIR = userDataDir;
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';

const watchdog = setTimeout(() => {
  console.error('[SMOKE-JS-DIALOG] Watchdog timeout after 120s; exiting 1');
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

const PAGE = `<!DOCTYPE html><html><head><title>idle</title></head><body style="margin:0">
<button id="del" style="position:fixed;left:20px;top:20px;width:160px;height:48px"
  onclick="document.title = 'R:' + confirm('Xóa comment này?')">Xóa</button>
<button id="warn" style="position:fixed;left:20px;top:100px;width:160px;height:48px"
  onclick="alert('Đã lưu'); document.title = 'A:done'">Lưu</button>
</body></html>`;

/** Polls for `ms` and fails if any dialog box of the app, owned by `owner` or unowned, shows at any sample. */
async function assertNoBoxFor(ms, owner, title, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const left = [...listOwnedMessageBoxes(owner, title), ...listOwnedMessageBoxes(0n, title)];
    assert.equal(left.length, 0, `a native dialog box is left on screen ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  let server;
  let tabHost;
  try {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    const winShell = new ProjectWindowShell({ owner: { kind: 'project', projectId: 'project-00000000-0000-4000-8000-0000000000e2' }, title: 'AntiFan JS Dialog Smoke', bounds: { width: 1280, height: 800 }, show: true });
    tabHost = new NativeTabHost(winShell);
    setChromeSenderResolver((webContents) => {
      const surface = winShell.chromeSurfaceFor(webContents.id) || tabHost.surfaceForWebContents(webContents.id);
      return surface ? { host: tabHost, surface } : undefined;
    });

    const tabId = tabHost.createTab(`${origin}/`, true);
    const wc = await waitFor('page load', () => {
      const live = tabHost.getTabWebContents(tabId, 'desktop');
      const row = tabHost.getTabList().find((tab) => tab.id === tabId);
      return live && !live.isDestroyed() && row && !row.isLoading && live.getURL().startsWith(origin) ? live : false;
    });
    const owner = hwndOf(winShell.window.getNativeWindowHandle());
    const boxTitle = app.getName();

    // 1. A trusted click whose handler opens confirm() returns instead of freezing on mouseReleased.
    const clickStarted = Date.now();
    const clicked = await Promise.race([
      tabHost.agentClick({ selector: '#del', tabId, trusted: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('click froze behind the dialog')), 8000)),
    ]);
    const clickMs = Date.now() - clickStarted;
    const dialog = await waitFor('dialog reported', () => tabHost.getOpenJsDialog(tabId), 15000, 5);
    assert.deepEqual(dialog, { type: 'confirm', message: 'Xóa comment này?', url: `${origin}/` });
    console.log(`[SMOKE-JS-DIALOG] click=${clicked} in ${clickMs}ms`);

    // 2. Page work is refused with the dialog instead of queueing behind it.
    const evalStarted = Date.now();
    await assert.rejects(tabHost.evalJs('document.title', tabId), (err) => err && err.code === 'DIALOG_OPEN');
    assert.ok(Date.now() - evalStarted < 2000, 'the refusal must be immediate, not a timeout');

    // 3. Dismissed right after it was reported, i.e. before Electron shows its native box: the
    //    answer still closes that box, so none is left on screen afterwards.
    const dismissed = await tabHost.answerJsDialog(tabId, undefined, false);
    console.log(`[SMOKE-JS-DIALOG] dismiss -> ${JSON.stringify(dismissed)}`);
    assert.equal(dismissed.action, 'dismiss');
    assert.equal(dismissed.closedEventSeen, true);
    assert.deepEqual(dismissed.nativeBox, { closed: true });
    assert.equal(tabHost.getOpenJsDialog(tabId), undefined);
    assert.equal(await waitFor('page resumed', async () => (await wc.executeJavaScript('document.title')) === 'R:false'), true);
    await assertNoBoxFor(2000, owner, boxTitle, 'after dismiss');

    // 4. An alert accepted after its box has been on screen a while.
    await tabHost.agentClick({ selector: '#warn', tabId, trusted: true });
    assert.equal((await waitFor('alert reported', () => tabHost.getOpenJsDialog(tabId))).type, 'alert');
    await waitFor('alert box shown', () => listOwnedMessageBoxes(owner, boxTitle).length === 1, 5000);
    const accepted = await tabHost.answerJsDialog(tabId, undefined, true);
    console.log(`[SMOKE-JS-DIALOG] alert -> ${JSON.stringify(accepted.nativeBox)}`);
    assert.deepEqual(accepted.nativeBox, { closed: true });
    assert.equal(await waitFor('alert returned', async () => (await wc.executeJavaScript('document.title')) === 'A:done'), true);
    await assertNoBoxFor(1000, owner, boxTitle, 'after alert');

    // 5. With nothing open, an answer is a typed refusal.
    await assert.rejects(tabHost.answerJsDialog(tabId, undefined, true), (err) => err && err.code === 'NO_DIALOG_OPEN');

    // 6. Background tab B is in no window, so Electron draws its box unowned. With no other dialog
    //    open anywhere, that box is provably B's and is closed.
    const otherId = tabHost.createTab(`${origin}/`, false);
    const otherWc = await waitFor('second tab load', () => {
      const live = tabHost.getTabWebContents(otherId, 'desktop');
      return live && !live.isDestroyed() && !live.isLoading() && live.getURL().startsWith(origin) ? live : false;
    });
    otherWc.executeJavaScript("document.title = 'R:' + confirm('Tab nền?')", true).catch(() => undefined);
    await waitFor('B reported', () => tabHost.getOpenJsDialog(otherId));
    const answeredAlone = await tabHost.answerJsDialog(otherId, undefined, true);
    console.log(`[SMOKE-JS-DIALOG] background B alone -> ${JSON.stringify(answeredAlone.nativeBox)}`);
    assert.deepEqual(answeredAlone.nativeBox, { closed: true });
    assert.equal(await waitFor('B resumed', async () => (await otherWc.executeJavaScript('document.title')) === 'R:true'), true);
    await assertNoBoxFor(1000, owner, boxTitle, 'after the background answer');

    // 7. A shows its box, then B opens again in the background. B's unowned box cannot be proven
    //    B's while A is open, so nothing is closed; A's box and dialog survive (closing A's box
    //    would answer A natively).
    await tabHost.agentClick({ selector: '#del', tabId, trusted: true });
    await waitFor('A reported', () => tabHost.getOpenJsDialog(tabId));
    const boxesOfA = await waitFor('A box shown', () => {
      const boxes = listOwnedMessageBoxes(owner, boxTitle);
      return boxes.length === 1 ? boxes : false;
    }, 5000);
    otherWc.executeJavaScript("document.title = 'R:' + confirm('Tab khác?')", true).catch(() => undefined);
    await waitFor('B reported again', () => tabHost.getOpenJsDialog(otherId));
    const besideA = await tabHost.answerJsDialog(otherId, undefined, false);
    console.log(`[SMOKE-JS-DIALOG] background B beside A -> ${JSON.stringify(besideA.nativeBox)}`);
    assert.equal(besideA.nativeBox.closed, false);
    assert.equal(besideA.nativeBox.reason, 'AMBIGUOUS');
    assert.equal(await waitFor('B resumed again', async () => (await otherWc.executeJavaScript('document.title')) === 'R:false'), true);
    assert.ok(tabHost.getOpenJsDialog(tabId), 'A\'s dialog is still open');
    assert.deepEqual(listOwnedMessageBoxes(owner, boxTitle), boxesOfA, 'A\'s box is untouched');

    // 8. B moves into the window and opens beside A. Whatever box B gets, A's survives.
    assert.equal(tabHost.switchTab(otherId), true);
    otherWc.executeJavaScript("document.title = 'R:' + confirm('Tab khác lần 3?')", true).catch(() => undefined);
    await waitFor('B reported a third time', () => tabHost.getOpenJsDialog(otherId));
    const inWindow = await tabHost.answerJsDialog(otherId, undefined, true);
    console.log(`[SMOKE-JS-DIALOG] B in window beside A -> ${JSON.stringify(inWindow.nativeBox)}`);
    assert.equal(inWindow.nativeBox.closed, false);
    assert.equal(await waitFor('B resumed a third time', async () => (await otherWc.executeJavaScript('document.title')) === 'R:true'), true);
    assert.ok(tabHost.getOpenJsDialog(tabId), 'A\'s dialog is still open');
    assert.ok(listOwnedMessageBoxes(owner, boxTitle).includes(boxesOfA[0]), 'A\'s box is untouched');

    console.log('[SMOKE-JS-DIALOG] passed.');
    app.exit(0);
  } catch (error) {
    console.error('[SMOKE-JS-DIALOG] FAILED:', error && error.stack ? error.stack : error);
    app.exit(1);
  } finally {
    clearTimeout(watchdog);
    if (server) server.close();
  }
}

app.whenReady().then(main);
