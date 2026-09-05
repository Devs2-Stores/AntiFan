/**
 * AntiFan Terminal Recovery & Empty State Smoke Test (Real Electron Chromium)
 *
 * Verifies:
 * 1. PULL-BASED BOOTSTRAP RECOVERY:
 *    - Main process INTENTIONALLY OMITS pushing initial session state on did-finish-load
 *    - Renderer executes bootstrapTerminalState():
 *      calls getInitialState() -> startTerminal() -> listTerminals()
 *    - Successfully renders terminal pane and tab without initial push
 *    - Asserts startTerminalInvocations >= 1 and listTerminalsInvocations >= 1
 * 2. EMPTY-STATE DISPLAY CONTRACT:
 *    - When all sessions close (sessions = []), the terminal does NOT become a dead black void
 *    - Renderer displays .terminal-empty-state with prominent "Tạo Terminal mới" button
 * 3. RECOVERY VIA EMPTY-STATE BUTTON:
 *    - Clicking #btnEmptyCreateTerminal invokes api.newTerminal()
 *    - Transitions cleanly from empty state to an active terminal pane
 * 4. RECOVERY VIA TAB STRIP '+' BUTTON (#btnNewTerminal):
 *    - When empty, clicking #btnNewTerminal creates and mounts a fresh terminal session
 *    - Asserts newTerminalInvocations === 2 (one from empty-state button, one from '+' button)
 * 5. CONSOLE AND RENDERER ERROR PROOF:
 *    - Strictly asserts zero uncaught exceptions, page errors, or script crashes in renderer
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const assert = require('node:assert');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const mockSessions = [
  { id: 'session-recovery-1', name: 'Terminal 1', cwd: 'E:/Work/project', active: true, buffer: 'Welcome to Recovery Terminal\\r\\n' }
];
let activeSessionId = 'session-recovery-1';
let startTerminalInvocations = 0;
let listTerminalsInvocations = 0;
let newTerminalInvocations = 0;
const rendererErrors = [];
let win = null;

function broadcastSessionState() {
  if (win && !win.isDestroyed()) {
    const active = mockSessions.find((s) => s.id === activeSessionId);
    win.webContents.send('antifan:terminal:session', {
      sessions: mockSessions.map((s) => ({ ...s, snapshotThroughSeq: 0 })),
      activeSessionId,
      snapshot: active ? active.buffer : '',
      snapshotThroughSeq: 0,
    });
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('antifan:sidebar:get-initial-state', () => ({
    workspacePath: 'E:/Work/project',
    activeWorkspace: 'E:/Work/project',
  }));

  ipcMain.handle('antifan:terminal:start', () => {
    startTerminalInvocations++;
    return true;
  });

  ipcMain.handle('antifan:terminal:list-sessions', () => {
    listTerminalsInvocations++;
    return mockSessions;
  });

  ipcMain.handle('antifan:terminal:new-session', () => {
    newTerminalInvocations++;
    const newId = `session-recovery-${mockSessions.length + 1}`;
    const newSession = {
      id: newId,
      name: `Terminal ${mockSessions.length + 1}`,
      cwd: 'E:/Work/project',
      active: true,
      buffer: `Session ${newId} initialized\\r\\n`
    };
    mockSessions.push(newSession);
    activeSessionId = newId;
    broadcastSessionState();
    return newId;
  });

  ipcMain.handle('antifan:terminal:switch-session', (_e, id) => {
    activeSessionId = id;
    mockSessions.forEach((s) => { s.active = s.id === id; });
    broadcastSessionState();
    return true;
  });

  ipcMain.handle('antifan:terminal:resize-session', () => true);
  ipcMain.handle('antifan:terminal:input-session', () => ({ ok: true }));
  ipcMain.handle('antifan:tabs:get-list', () => []);
  ipcMain.handle('antifan:terminal:get-affinity', () => undefined);

  win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, './e2e-combined-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.webContents.on('console-message', (event, ...legacyArgs) => {
    const hasParams = event && typeof event === 'object' && ('message' in event || 'level' in event);
    const msg = hasParams ? event.message : (typeof legacyArgs[1] === 'string' ? legacyArgs[1] : (typeof legacyArgs[0] === 'string' ? legacyArgs[0] : String(legacyArgs[1] ?? legacyArgs[0] ?? event)));
    const level = hasParams ? event.level : legacyArgs[0];
    if (level === 3 || (typeof msg === 'string' && (msg.includes('Error:') || msg.includes('Uncaught ')))) {
      if (!msg.includes('Insecure Content-Security-Policy')) {
        rendererErrors.push(msg);
      }
    }
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    rendererErrors.push(`Renderer process crashed: ${details.reason}`);
  });

  // INTENTIONAL: No win.webContents.on('did-finish-load') session push!
  // This simulates the exact worst-case race condition where the initial push was dropped or delayed.

  const htmlPath = path.resolve(__dirname, '../../.compiled/src/renderer/standalone.html');
  await win.loadFile(htmlPath, { query: { mode: 'popout' } });

  console.log('[SMOKE-RECOVERY] Page loaded without initial push. Running assertions...');

  try {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // Test 1: Verify pull-based bootstrap recovers session without push
        let p1Pane = null;
        for (let i = 0; i < 40; i++) {
          p1Pane = document.querySelector('.terminal-session-pane[data-session-id="session-recovery-1"]');
          if (p1Pane && p1Pane.classList.contains('active')) break;
          await sleep(100);
        }
        if (!p1Pane) throw new Error('Bootstrap pull failed to mount session-recovery-1 pane without initial push');

        const tab1 = document.querySelector('.terminal-tab-wrap[data-session-id="session-recovery-1"]');
        if (!tab1) throw new Error('Bootstrap pull failed to render tab for session-recovery-1');

        return { success: true, paneId: 'session-recovery-1' };
      })()
    `);

    assert.strictEqual(result.success, true, 'Test 1 bootstrap pull must succeed');
    assert.ok(startTerminalInvocations >= 1, `startTerminal must be invoked via bootstrap (got ${startTerminalInvocations})`);
    assert.ok(listTerminalsInvocations >= 1, `listTerminals must be invoked via bootstrap (got ${listTerminalsInvocations})`);
    console.log('[E2E PASS] Test 1: Pull-based bootstrap successfully mounted active pane & tab without initial push');

    // Now clear mockSessions on main process and broadcast empty state to test empty state UI
    mockSessions.length = 0;
    activeSessionId = '';
    broadcastSessionState();

    const emptyTestRes = await win.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // Test 2 Assertion: Verify .terminal-empty-state is rendered
        let emptyStateEl = null;
        for (let i = 0; i < 30; i++) {
          emptyStateEl = document.getElementById('terminalEmptyState');
          if (emptyStateEl) break;
          await sleep(50);
        }
        if (!emptyStateEl) throw new Error('Empty state element #terminalEmptyState not displayed when sessions are empty');
        const emptyBtn = emptyStateEl.querySelector('#btnEmptyCreateTerminal');
        if (!emptyBtn) throw new Error('Action button #btnEmptyCreateTerminal missing in empty state');

        // Test 3: Click #btnEmptyCreateTerminal to recover from empty state
        emptyBtn.click();
        let recoveredPane = null;
        for (let i = 0; i < 30; i++) {
          recoveredPane = document.querySelector('.terminal-session-pane.active');
          if (recoveredPane && !document.getElementById('terminalEmptyState')) break;
          await sleep(50);
        }
        if (!recoveredPane) throw new Error('Failed to recover active terminal pane after clicking #btnEmptyCreateTerminal');
        if (document.getElementById('terminalEmptyState')) throw new Error('Empty state element was not removed after recovery');

        return { success: true, recoveredSessionId: recoveredPane.getAttribute('data-session-id') };
      })()
    `);

    assert.strictEqual(emptyTestRes.success, true, 'Test 2 and 3 empty state & recovery must succeed');
    assert.strictEqual(newTerminalInvocations, 1, 'Clicking empty-state button must invoke new-session once');
    console.log('[E2E PASS] Test 2 & 3: Empty-state UI rendered and cleanly recovered via #btnEmptyCreateTerminal');

    // Clear mockSessions again to test '+' button recovery
    mockSessions.length = 0;
    activeSessionId = '';
    broadcastSessionState();

    const btnPlusTestRes = await win.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        for (let i = 0; i < 30; i++) {
          if (document.getElementById('terminalEmptyState')) break;
          await sleep(50);
        }
        const btnNew = document.getElementById('btnNewTerminal');
        if (!btnNew) throw new Error('#btnNewTerminal (+) button missing');
        btnNew.click();

        let newPane = null;
        for (let i = 0; i < 30; i++) {
          newPane = document.querySelector('.terminal-session-pane.active');
          if (newPane && !document.getElementById('terminalEmptyState')) break;
          await sleep(50);
        }
        if (!newPane) throw new Error('Failed to recover active terminal pane after clicking #btnNewTerminal (+)');
        return { success: true, plusRecoveredSessionId: newPane.getAttribute('data-session-id') };
      })()
    `);

    assert.strictEqual(btnPlusTestRes.success, true, 'Test 4 plus button recovery must succeed');
    assert.strictEqual(newTerminalInvocations, 2, 'Clicking #btnNewTerminal must invoke new-session a second time');
    console.log('[E2E PASS] Test 4: Successfully recovered from empty state via #btnNewTerminal (+)');

    // Test 5: Verify zero unhandled errors in renderer
    assert.strictEqual(rendererErrors.length, 0, `Renderer must have 0 errors, got: ${JSON.stringify(rendererErrors)}`);
    console.log('[E2E PASS] Test 5: Zero renderer console errors or uncaught exceptions during execution');

    console.log('\\x1b[32m✔ [ALL SMOKE TESTS RIGOROUSLY VERIFIED]\\x1b[0m Terminal pull bootstrap, empty-state UI, and recovery verified in real Chromium.');
    app.exit(0);
  } catch (err) {
    console.error('\\x1b[31m✖ [SMOKE FAILED]\\x1b[0m', err);
    app.exit(1);
  }
});
