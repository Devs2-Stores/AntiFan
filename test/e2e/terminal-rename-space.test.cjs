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

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const mockSessions = [
  { id: 'session-1', name: 'Terminal 1', cwd: 'E:/Work/project', active: true, buffer: '' },
  { id: 'session-2', name: 'Terminal 2', cwd: 'E:/Work/project', active: false, buffer: '' },
];

let renamedData = null;

app.whenReady().then(async () => {
  ipcMain.handle('antifan:sidebar:get-initial-state', () => ({
    workspacePath: 'E:/Work/project',
    activeWorkspace: 'E:/Work/project',
  }));

  ipcMain.handle('antifan:terminal:start', () => {
    return { id: 'session-1', name: 'Terminal 1' };
  });

  ipcMain.handle('antifan:terminal:list-sessions', () => mockSessions);

  ipcMain.handle('antifan:terminal:switch-session', (_e, id) => true);

  ipcMain.handle('antifan:terminal:rename-session', (_e, payload) => {
    renamedData = payload;
    const session = mockSessions.find((s) => s.id === payload.id);
    if (session) session.name = payload.name;
    return true;
  });

  ipcMain.handle('antifan:terminal:new-session', () => ({ id: 'session-3', name: 'Terminal 3' }));
  ipcMain.handle('antifan:terminal:close-session', () => true);
  ipcMain.handle('antifan:terminal:write', () => true);
  ipcMain.handle('antifan:terminal:resize', () => true);

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', '.compiled', 'src', 'preload', 'standalone-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const htmlPath = path.join(__dirname, '..', '..', '.compiled', 'src', 'renderer', 'standalone.html');
  await win.loadFile(htmlPath);

  // Send session state
  win.webContents.send('antifan:terminal:session', {
    sessions: mockSessions,
    activeSessionId: 'session-1',
    snapshot: '',
    snapshotThroughSeq: 0,
  });

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
    app.exit(1);
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
    app.exit(1);
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

  console.log('Final check:', finalCheck);
  console.log('IPC rename payload received in main:', renamedData);

  if (
    finalCheck.inputRemoved &&
    !finalCheck.isRenaming &&
    finalCheck.titleText === 'Dev Server 1' &&
    renamedData &&
    renamedData.name === 'Dev Server 1'
  ) {
    console.log('ALL VERIFICATION CHECKS PASSED: Terminal tab renaming with spaces verified successfully!');
    app.exit(0);
  } else {
    console.error('FAIL: Final check did not match expected values!');
    app.exit(1);
  }
});
