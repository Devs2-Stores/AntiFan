/**
 * Shared Terminal Manager hub smoke (real Electron Chromium, stubbed Main).
 *
 * Verifies, against the shipped renderer:
 *  1. A shell described as the unassigned owner groups rows by folder: one section per
 *     `folderKey`, titled by `folderLabel`, with the minted `displayLabel` on each row.
 *  2. Each folder section carries a "new terminal" and a "Space" affordance, and firing
 *     them sends that section's own `folderPath` over the shipped channels.
 *  3. A `NEEDS_CONFIRM` Space answer shows the exact commands and re-calls with the hash.
 *  4. A shell that is NOT the shared manager shows no folder section and no hub button.
 *  5. Zero renderer errors.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const assert = require('node:assert');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const row = (id, name, folder, label, display) => ({
  id, name, cwd: folder, active: id === 'h-1', buffer: `${id} ready\\r\\n`,
  folderKey: folder.toLowerCase(), folderLabel: label, folderPath: folder, displayLabel: display,
});
const sessions = [
  row('h-1', 'Terminal 1', 'E:\\Work\\x', 'x', 'x · 1'),
  row('h-2', 'Terminal 2', 'E:\\Work\\x', 'x', 'x · 2'),
  row('h-3', 'Terminal 3', 'E:\\Work\\y', 'y', 'y · 1'),
];
let managerShell = true;
const calls = { newInFolder: [], spaceOpen: [] };
const errors = [];
let win = null;

app.whenReady().then(async () => {
  ipcMain.handle('antifan:sidebar:get-initial-state', () => ({
    workspacePath: 'E:/Work/x',
    terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 280 },
    projectWindow: managerShell
      ? { owner: { kind: 'unassigned' }, title: 'Shared', pathLabel: '', workspacePath: 'E:/Work/x' }
      : { owner: { kind: 'project', projectId: 'p1' }, title: 'P1', pathLabel: 'E:/Work/x', workspacePath: 'E:/Work/x' },
  }));
  ipcMain.handle('antifan:terminal:start', () => true);
  ipcMain.handle('antifan:terminal:list-sessions', () => sessions);
  ipcMain.handle('antifan:terminal:get-full-buffer', (_e, id) => {
    const s = sessions.find((x) => x.id === id);
    return { sessionId: id, buffer: s ? s.buffer : '', snapshotThroughSeq: 0 };
  });
  ipcMain.handle('antifan:terminal:switch-session', () => true);
  ipcMain.handle('antifan:terminal:resize-session', () => true);
  ipcMain.on('antifan:terminal:input-session', () => {});
  ipcMain.handle('antifan:terminal:new-in-folder', (_e, payload) => {
    calls.newInFolder.push(payload && payload.folder);
    return { ok: true, sessionId: 'h-new', capsuleId: 'c1' };
  });
  ipcMain.handle('antifan:space:open', (_e, payload) => {
    calls.spaceOpen.push(payload);
    if (!payload.confirmHash) {
      return { ok: false, reason: 'NEEDS_CONFIRM', hash: 'abc123', commands: [{ label: 'Dev', command: 'npm run dev' }] };
    }
    return { ok: true, terminalsOpened: 1, terminalsReused: 0, tabsOpened: 0, tabsReused: 0 };
  });

  win = new BrowserWindow({
    width: 1100, height: 750, show: false,
    webPreferences: { preload: path.resolve(__dirname, './e2e-combined-preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.on('console-message', (event, ...legacy) => {
    const has = event && typeof event === 'object' && ('message' in event || 'level' in event);
    const msg = has ? event.message : String(legacy[1] ?? legacy[0] ?? event);
    const level = has ? event.level : legacy[0];
    if ((level === 3 || (typeof msg === 'string' && (msg.includes('Error:') || msg.includes('Uncaught ')))) && !msg.includes('Insecure Content-Security-Policy')) {
      errors.push(msg);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`crashed: ${d.reason}`));

  const html = path.resolve(__dirname, '../../.compiled/src/renderer/standalone.html');
  await win.loadFile(html, { query: { mode: 'popout' } });

  const js = (code) => win.webContents.executeJavaScript(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));${code}})()`);
  try {
    // 1 + 2: folder sections
    const info = await js(`
      let heads = [];
      for (let i = 0; i < 50; i++) {
        heads = [...document.querySelectorAll('.terminal-tab-category-header[data-folder-path]')];
        if (heads.length === 2) break;
        await sleep(100);
      }
      return heads.map((h) => ({
        path: h.getAttribute('data-folder-path'),
        label: (h.querySelector('.terminal-tab-category-label') || {}).textContent,
        mints: h.querySelectorAll('.terminal-tab-category-mint').length,
      }));
    `);
    assert.deepStrictEqual(info.map((i) => i.path).sort(), ['E:\\Work\\x', 'E:\\Work\\y'], 'one section per folder');
    assert.deepStrictEqual(info.map((i) => i.label).sort(), ['x', 'y'], 'sections titled by folderLabel');
    assert.ok(info.every((i) => i.mints >= 2), 'each section has mint + Space buttons');
    console.log('[HUB PASS] 1-2: folder sections, labels, affordances');

    await js(`
      const h = [...document.querySelectorAll('.terminal-tab-category-header[data-folder-path]')].find((e) => e.getAttribute('data-folder-path').endsWith('y'));
      h.querySelectorAll('.terminal-tab-category-mint')[0].click();
    `);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(calls.newInFolder, ['E:\\Work\\y'], 'mint sends the clicked section folder');
    console.log('[HUB PASS] 2: mint routed with its own folder');

    // 3: Space confirm flow (auto-accept the dialog)
    await js(`
      window.__confirmText = '';
      window.confirm = (t) => { window.__confirmText = t; return true; };
      const h = [...document.querySelectorAll('.terminal-tab-category-header[data-folder-path]')].find((e) => e.getAttribute('data-folder-path').endsWith('x'));
      h.querySelectorAll('.terminal-tab-category-mint')[1].click();
      await sleep(400);
    `);
    const confirmText = await win.webContents.executeJavaScript('window.__confirmText');
    assert.ok(confirmText.includes('npm run dev'), `confirm must show the exact command, got: ${confirmText}`);
    assert.strictEqual(calls.spaceOpen.length, 2, 'open, then confirmed re-open');
    assert.strictEqual(calls.spaceOpen[0].confirmHash, undefined);
    assert.strictEqual(calls.spaceOpen[1].confirmHash, 'abc123');
    console.log('[HUB PASS] 3: Space NEEDS_CONFIRM shows commands and echoes hash');

    // 4: project shell hides the hub
    managerShell = false;
    await win.loadFile(html, { query: { mode: 'popout' } });
    const hidden = await js(`
      await sleep(1500);
      const btn = document.getElementById('btnNewInFolder');
      return {
        sections: document.querySelectorAll('.terminal-tab-category-header[data-folder-path]').length,
        hubButtonVisible: !!btn && btn.style.display !== 'none',
      };
    `);
    assert.strictEqual(hidden.sections, 0, 'project shell shows no folder sections');
    assert.strictEqual(hidden.hubButtonVisible, false, 'project shell hides the hub button');
    console.log('[HUB PASS] 4: project shell keeps the hub hidden');

    assert.deepStrictEqual(errors, [], `renderer errors: ${JSON.stringify(errors)}`);
    console.log('[HUB PASS] 5: zero renderer errors');
    app.exit(0);
  } catch (err) {
    console.error('[HUB FAIL]', err);
    try {
      const dump = await win.webContents.executeJavaScript(`JSON.stringify({
        headers: [...document.querySelectorAll('.terminal-tab-category-header')].map((h) => h.outerHTML.slice(0, 200)),
        wraps: document.querySelectorAll('.terminal-tab-wrap').length,
        chip: (document.querySelector('.shell-scope-chip, #shellScopeChip') || {}).textContent,
      })`);
      console.error('[HUB DOM]', dump);
    } catch {}
    app.exit(1);
  }
});
