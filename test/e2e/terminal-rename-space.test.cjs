/**
 * AntiFan Terminal Tab Rename with Spaces Test (E2E in Electron)
 * 
 * Verifies:
 * 1. Renaming a terminal tab allows spaces without premature cancellation or focus loss.
 * 2. Multi-word names with spaces (e.g. "Dev Server 1") are typed smoothly.
 * 3. Space keyup does not trigger synthetic click on the parent tab button.
 * 4. Enter confirms the new name and calls renameTerminal with the spaced name.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { TerminalManager, SessionRecord } = require('../../.compiled/src/main/browser/terminal-manager.js');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

// Run against a throwaway profile: the default userData directory belongs to the developer's
// installed AntiFan, and sharing it would contend with a live instance and pollute its state.
// Electron can recreate profile files while tearing down, so the exit sweep below is best effort;
// this startup sweep keeps the footprint bounded at one directory per host.
const tempPrefix = 'antifan-terminal-rename-';
const processStartedAt = Date.now();
for (const entry of fs.readdirSync(os.tmpdir())) {
  if (!entry.startsWith(tempPrefix)) continue;
  const candidate = path.join(os.tmpdir(), entry);
  try {
    // Reap only stale directories: a concurrently running lane keeps writing into its own profile,
    // and deleting it out from under Electron would gut that run.
    if (fs.statSync(candidate).mtimeMs < processStartedAt) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  } catch {}
}
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
app.setPath('userData', tempUserData);
process.env.ANTIFAN_DATA_ROOT = path.join(tempUserData, 'data');
process.env.ANTIFAN_CONFIG_DIR = path.join(tempUserData, 'config');
try {
  fs.mkdirSync(process.env.ANTIFAN_DATA_ROOT, { recursive: true });
  fs.mkdirSync(process.env.ANTIFAN_CONFIG_DIR, { recursive: true });
} catch {}

const tm = TerminalManager.getInstance();

const removeTempUserData = () => {
  try {
    fs.rmSync(tempUserData, { recursive: true, force: true });
  } catch {}
};
process.on('exit', removeTempUserData);

const WATCHDOG_TIMEOUT_MS = 60000;
let watchdog = null;

// app.exit() tears the process down without running the exit hooks, and Electron keeps profile
// files open while a window is alive, so close the windows and sweep the profile before exiting.
const finish = (code) => {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
  for (const window of BrowserWindow.getAllWindows()) {
    window.destroy();
  }
  try {
    tm.dispose();
  } catch {}
  removeTempUserData();
  app.exit(code);
};

// Real wall-clock watchdog ensures deterministic exit on startup failure or hang (U31).
watchdog = setTimeout(() => {
  console.error('[TEST] WATCHDOG: test exceeded 60s; exiting 1');
  finish(1);
}, WATCHDOG_TIMEOUT_MS);
if (watchdog.unref) watchdog.unref();

const mockWorkspace = path.join(os.tmpdir(), 'antifan-terminal-rename-workspace');
try {
  fs.mkdirSync(mockWorkspace, { recursive: true });
} catch {}

// Seed real SessionRecord instances in TerminalManager instead of dummy mock array closures (U16).
const session1 = new SessionRecord({
  id: 'session-1',
  name: 'Terminal 1',
  cwd: mockWorkspace,
  capsuleId: 'default',
  sessionGeneration: 1,
  state: 'running',
});
const session2 = new SessionRecord({
  id: 'session-2',
  name: 'Terminal 2',
  cwd: mockWorkspace,
  capsuleId: 'default',
  sessionGeneration: 1,
  state: 'running',
});
tm.sessions.set('session-1', session1);
tm.sessions.set('session-2', session2);
tm.activeSessionId = 'session-1';

let renamedData = null;
app.whenReady().then(async () => {
  try {
    ipcMain.handle('antifan:sidebar:get-initial-state', () => ({
      workspacePath: mockWorkspace,
      activeWorkspace: mockWorkspace,
    }));

    ipcMain.handle('antifan:terminal:start', (_e, cwd) => {
      tm.startTerminal(cwd || mockWorkspace);
      const activeId = tm.getActiveSessionId() || 'session-1';
      return { id: activeId, name: tm.getSession(activeId)?.name || 'Terminal 1' };
    });

    ipcMain.handle('antifan:terminal:list-sessions', () => tm.listSessions());

    ipcMain.handle('antifan:terminal:switch-session', (_e, id) => tm.switchSession(id));

    ipcMain.handle('antifan:terminal:rename-session', (_e, payload) => {
      renamedData = payload;
      const id = typeof payload === 'string' ? '' : (payload?.id || payload?.sessionId);
      const name = typeof payload === 'string' ? payload : (payload?.name || payload?.newTitle);
      return tm.renameSession(id || tm.getActiveSessionId(), name || '');
    });

    ipcMain.handle('antifan:terminal:new-session', (_e, cwd) => {
      const id = tm.createSession(cwd || mockWorkspace);
      return { id, name: tm.getSession(id)?.name || id };
    });

    ipcMain.handle('antifan:terminal:close-session', (_e, id) => tm.closeSession(id));

    ipcMain.handle('antifan:terminal:write', (_e, payload) => {
      if (typeof payload === 'string') {
        tm.write(payload);
      } else if (payload && payload.id && payload.data) {
        tm.writeTo(payload.id, payload.data);
      }
      return true;
    });

    ipcMain.handle('antifan:terminal:resize', (_e, payload) => {
      if (payload && payload.id) {
        tm.resizeTo(payload.id, payload.cols, payload.rows);
      } else if (payload && payload.cols && payload.rows) {
        tm.resize(payload.cols, payload.rows);
      }
      return true;
    });
    const win = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', '.compiled', 'src', 'preload', 'standalone-preload.js'),
        contextIsolation: true,
        // Mirrors production's standalone views (native-tab-host.ts): a sandboxed
        // preload cannot require a relative module, so leaving the default sandbox
        // on makes this harness exercise a window the app never creates.
        sandbox: false,
        nodeIntegration: false,
      },
    });

    const htmlPath = path.join(__dirname, '..', '..', '.compiled', 'src', 'renderer', 'standalone.html');
    await win.loadFile(htmlPath);

    // Mirror production session event propagation from TerminalManager to renderer
    tm.on('session', (state) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('antifan:terminal:session', state);
      }
    });

    // Send initial session state directly from TerminalManager
    win.webContents.send('antifan:terminal:session', tm.getSessionState());

    await new Promise((r) => setTimeout(r, 300));

    // Trigger double click on first tab to start inline rename
    const startedRename = await win.webContents.executeJavaScript(`
      (() => {
        const tab = document.querySelector('.terminal-tab');
        if (!tab) return false;
        const dblEvent = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
        tab.dispatchEvent(dblEvent);
        const input = document.querySelector('.terminal-tab-rename-input');
        return !!input;
      })()
    `);

    if (!startedRename) {
      console.error('FAIL: Could not start inline rename');
      finish(1);
      return;
    }
    console.log('SUCCESS: Inline rename started.');

    // Type: "Dev Server 1"
    const newTabName = 'Dev Server 1';
    // Send backspace first to clear selection
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });

    for (const char of newTabName) {
      if (char === ' ') {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      } else {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: char });
        win.webContents.sendInputEvent({ type: 'char', keyCode: char });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: char });
      }
    }

    await new Promise((r) => setTimeout(r, 100));

    // Check intermediate state: input should still exist and contain "Dev Server 1"
    const intermediate = await win.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector('.terminal-tab-rename-input');
        const wrap = document.querySelector('.terminal-tab-wrap');
        return {
          inputFound: !!input,
          inputValue: input?.value,
          isRenaming: wrap?.classList.contains('renaming')
        };
      })()
    `);

    console.log('Intermediate state:', intermediate);
    if (!intermediate.inputFound || intermediate.inputValue !== 'Dev Server 1') {
      console.error('FAIL: Input lost or value mismatch before Enter!');
      finish(1);
      return;
    }
    console.log('SUCCESS: Intermediate value with spaces preserved:', intermediate.inputValue);

    // Press Enter to confirm rename
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    await new Promise((r) => setTimeout(r, 200));

    const finalCheck = await win.webContents.executeJavaScript(`
      (() => {
        const titleSpan = document.querySelector('.terminal-tab-title');
        const input = document.querySelector('.terminal-tab-rename-input');
        const wrap = document.querySelector('.terminal-tab-wrap');
        return {
          inputRemoved: !input,
          isRenaming: wrap?.classList.contains('renaming'),
          titleText: titleSpan?.textContent
        };
      })()
    `);

    tm.persistSync();
    const session1After = tm.getSession('session-1');
    const sessionListAfter = tm.listSessions();
    const summaryAfter = sessionListAfter.find((s) => s.id === 'session-1');

    const stateFilePath = path.join(process.env.ANTIFAN_CONFIG_DIR, 'terminal-sessions.json');
    let persistedOk = false;
    try {
      if (fs.existsSync(stateFilePath)) {
        const persisted = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
        const list = Array.isArray(persisted) ? persisted : (persisted.sessions || []);
        const found = list.find((s) => s.id === 'session-1');
        persistedOk = Boolean(found && found.name === 'Dev Server 1');
      }
    } catch (err) {
      console.warn('Could not verify persisted session file:', err);
    }

    console.log('Final check:', finalCheck);
    console.log('IPC rename payload received in main:', renamedData);
    console.log('TerminalManager state after rename:', {
      sessionName: session1After?.name,
      summaryName: summaryAfter?.name,
      persistedOk,
    });

    if (
      finalCheck.inputRemoved &&
      !finalCheck.isRenaming &&
      finalCheck.titleText === 'Dev Server 1' &&
      renamedData &&
      renamedData.name === 'Dev Server 1' &&
      session1After &&
      session1After.name === 'Dev Server 1' &&
      summaryAfter &&
      summaryAfter.name === 'Dev Server 1' &&
      persistedOk
    ) {
      console.log('ALL VERIFICATION CHECKS PASSED: Terminal tab renaming with spaces verified successfully!');
      finish(0);
    } else {
      console.error('FAIL: Final check did not match expected values!');
      finish(1);
    }
  } catch (err) {
    console.error('FAIL: Error during test execution:', err && err.stack ? err.stack : err);
    finish(1);
  }
}).catch((err) => {
  console.error('FAIL: Unhandled rejection in whenReady:', err && err.stack ? err.stack : err);
  finish(1);
});
