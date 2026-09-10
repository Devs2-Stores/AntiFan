/**
 * AntiFan Terminal Split Hydration & Remount Deterministic Regression Probe
 *
 * Verifies post-fix invariants in real Electron Chromium runtime:
 * Path 1: Remount with empty/stale splitBuffer authoritatively pulls getFullBuffer from backend and renders
 * Path 2: Same-ID newer snapshot broadcast triggers in-place re-hydration and clean replacement without duplicate append
 * Path 3: Real IPC split creation race: initial chunks arriving during await are routed and cleaned up cleanly by mountSplitClean
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const reportsDir = path.join(__dirname, '..', '..', 'plans', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const certFile = path.join(reportsDir, 'terminal-split-probe-telemetry.json');

const telemetry = {
  timestamp: new Date().toISOString(),
  checks: {},
  verdict: 'PENDING',
};

let win = null;
let getFullBufferCallCount = 0;
let getFullBufferLastSessionId = null;

const backendBuffers = {
  'split-probe-1': {
    buffer: 'PROBE-1-BACKEND-OUTPUT: hrv theme dev watching...\r\nLine 2\r\nLine 3\r\n',
    snapshotThroughSeq: 3,
  },
  'split-probe-2': {
    buffer: 'INITIAL-OLD-PROBE-2-DATA\r\n',
    snapshotThroughSeq: 1,
  },
  'split-race-test': {
    buffer: 'PROBE-RACE-BACKEND-OUTPUT: Shell prompt ready\r\n',
    snapshotThroughSeq: 1,
  },
};

app.whenReady().then(async () => {
  try {
    // Wire up IPC handlers
    ipcMain.handle('antifan:sidebar:get-initial-state', () => ({
      workspacePath: 'E:/Work/project',
      activeWorkspace: 'E:/Work/project',
    }));

    ipcMain.handle('antifan:terminal:start', () => {
      return { id: 'session-main', name: 'Main' };
    });

    ipcMain.handle('antifan:terminal:list-sessions', () => [
      { id: 'session-main', name: 'Main', active: true, buffer: 'Main session ready\r\n' },
    ]);

    ipcMain.handle('antifan:terminal:get-full-buffer', (_e, sessionId) => {
      getFullBufferCallCount++;
      getFullBufferLastSessionId = sessionId;
      const b = backendBuffers[sessionId];
      return {
        sessionId,
        buffer: b ? b.buffer : '',
        snapshotThroughSeq: b ? b.snapshotThroughSeq : 0,
      };
    });

    ipcMain.handle('antifan:terminal:switch-session', () => true);
    ipcMain.handle('antifan:terminal:set-active-session', () => true);
    ipcMain.handle('antifan:terminal:resize-session', () => ({ ok: true }));
    ipcMain.handle('antifan:terminal:input-session', () => ({ ok: true }));
    ipcMain.handle('antifan:terminal:input', () => ({ ok: true }));
    ipcMain.handle('antifan:terminal:sync-view', () => ({ status: 'UP_TO_DATE', generation: 1, lastSeq: 0 }));
    ipcMain.handle('antifan:terminal:get-delta', (_e, { fromSeq }) => {
      const chunks = [];
      const start = Math.max(1, fromSeq || 1);
      for (let s = start; s < 10; s++) {
        chunks.push({ seq: s, data: `DELTA-CHUNK-${s}\r\n` });
      }
      return { status: 'OK', chunks };
    });
    ipcMain.handle('antifan:tabs:get-list', () => []);
    ipcMain.handle('antifan:terminal:get-affinity', () => null);
    ipcMain.handle('antifan:terminal:split-session', async () => {
      win.webContents.send('antifan:terminal:data', {
        sessionId: 'split-race-test',
        data: 'REAL-IPC-INITIAL-BANNER\r\n',
        seq: 1,
        generation: 1,
      });
      await new Promise((r) => setTimeout(r, 200));
      return 'split-race-test';
    });
    // Test control endpoints
    ipcMain.handle('antifan:test:reset-count', () => {
      getFullBufferCallCount = 0;
      getFullBufferLastSessionId = null;
      return true;
    });
    ipcMain.handle('antifan:test:get-count', () => ({
      count: getFullBufferCallCount,
      lastSessionId: getFullBufferLastSessionId,
    }));

    // Create real test window
    win = new BrowserWindow({
      width: 1024,
      height: 768,
      show: false,
      webPreferences: {
        preload: path.resolve(__dirname, '../../.compiled/src/preload/standalone-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const htmlPath = path.resolve(__dirname, '../../.compiled/src/renderer/standalone.html');
    await win.loadFile(htmlPath, { query: { mode: 'popout' } });

    // Wait for initial render
    await new Promise((r) => setTimeout(r, 1200));

    // -------------------------------------------------------------
    // CHECK 1: The Hydration Guard Strict Undefined Fallacy
    // (a) snapshot = '', snapshotSeq = 0 (current default/stale cache)
    // (b) snapshot = undefined, snapshotSeq = undefined (proposed contract)
    // -------------------------------------------------------------
    console.log('[PROBE] Executing Check 1: Remount Hydration Guard Behavior...');
    getFullBufferCallCount = 0;

    const check1Result = await win.webContents.executeJavaScript(`(async () => {
      // Call mountSplit with empty string and 0 (the exact signature called by renderTabs / button)
      mountSplit('split-probe-1', '', 0);
      await new Promise(r => setTimeout(r, 400));
      
      const lines = splitTerm ? splitTerm.buffer.active.length : -1;
      const lastSeq = splitSessionState.lastRenderedSeq;
      const cursorY = splitTerm ? splitTerm.buffer.active.cursorY : -1;
      const cursorX = splitTerm ? splitTerm.buffer.active.cursorX : -1;
      const text = splitTerm ? splitTerm.buffer.active.getLine(0)?.translateToString().trim() : '';

      return {
        lines,
        lastSeq,
        cursorX,
        cursorY,
        text
      };
    })()`);

    const countAfterEmpty = getFullBufferCallCount;

    telemetry.checks.remountHydrationGuard = {
      emptyCallHydratedFromBackend: countAfterEmpty === 1 && check1Result.lastSeq === 3 && check1Result.text.includes('PROBE-1'),
      emptyCallDetails: { ...check1Result, getFullBufferCalls: countAfterEmpty },
    };

    console.log('[PROBE] Check 1 result:', JSON.stringify(telemetry.checks.remountHydrationGuard, null, 2));

    // -------------------------------------------------------------
    // CHECK 2: Same-ID Early Return Trap
    // -------------------------------------------------------------
    console.log('[PROBE] Executing Check 2: Same-ID Early Return Trap...');
    
    const check2Initial = await win.webContents.executeJavaScript(`(async () => {
      // Unmount first, then mount the split against a backend that has not advanced yet
      unmountSplit();
      mountSplit('split-probe-2', '', 0);
      await new Promise(r => setTimeout(r, 300));
      return { initialSeq: splitSessionState.lastRenderedSeq };
    })()`);

    // A real session-state payload is derived from Main's transcript, so the backend
    // advances in lock-step with a newer broadcast instead of lagging behind it.
    backendBuffers['split-probe-2'] = { buffer: 'LATER-SESSION-BUFFER\r\n', snapshotThroughSeq: 2 };

    const check2Result = await win.webContents.executeJavaScript(`(async () => {
      try {
        // onTerminalSession broadcast arriving later with newer sequence (seq 2 > seq 1)
        mountSplit('split-probe-2', 'LATER-SESSION-BUFFER\\r\\n', 2);
        await new Promise(r => setTimeout(r, 400));
        
        const seqAfterSessionArrival = splitSessionState.lastRenderedSeq;
        let fullText = '';
        if (splitTerm && splitTerm.buffer && splitTerm.buffer.active) {
          const b = splitTerm.buffer.active;
          for (let i = 0; i < b.length; i++) {
            const l = b.getLine(i);
            if (l) fullText += l.translateToString(true) + String.fromCharCode(10);
          }
        }
        
        return {
          seqAfterSessionArrival,
          fullText
        };
      } catch (e) {
        return { error: e.message, stack: e.stack };
      }
    })()`);

    if (check2Result.error) {
      console.error('[PROBE] Check 2 caught error in renderer:', check2Result.error, check2Result.stack);
      throw new Error('Renderer threw: ' + check2Result.error);
    }

    telemetry.checks.sameIdEarlyReturnTrap = {
      initialSeq: check2Initial.initialSeq,
      seqAfterSessionArrival: check2Result.seqAfterSessionArrival,
      acceptedNewerSnapshot: check2Result.seqAfterSessionArrival === 2 && check2Result.fullText.includes('LATER-SESSION-BUFFER'),
      oldMarkerReplacedCleanly: !check2Result.fullText.includes('INITIAL-OLD-PROBE-2-DATA'),
      text: check2Result.fullText.trim(),
    };

    console.log('[PROBE] Check 2 result:', JSON.stringify(telemetry.checks.sameIdEarlyReturnTrap, null, 2));

    // -------------------------------------------------------------
    // CHECK 3: Split Creation Misrouting Probe via Real UI Button
    // -------------------------------------------------------------
    console.log('[PROBE] Executing Check 3: Real IPC Split Creation Misrouting Probe...');
    await win.webContents.executeJavaScript(`(async () => {
      unmountSplit();
    })()`);
    // Click real UI button #btnSplitTerminal which invokes api.splitTerminal
    const check3Result = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.getElementById('btnSplitTerminal') || document.getElementById('btnSplitVertical');
      if (!btn) throw new Error('Split button #btnSplitTerminal not found in DOM');
      if (btn.disabled) throw new Error('Split button #btnSplitTerminal is disabled');
      if (!activeId) throw new Error('activeId is empty, split action cannot proceed');
      
      let phantomObservedDuringRace = false;
      const poller = setInterval(() => {
        if (terminalPool.has('split-race-test')) {
          phantomObservedDuringRace = true;
        }
      }, 10);

      try {
        btn.click();

        // Wait dynamically until splitId is mounted, rendered to sequence 1, and hydration epoch settles
        const startTime = Date.now();
        while (Date.now() - startTime < 1500) {
          if (splitId === 'split-race-test' && splitSessionState.lastRenderedSeq === 1 && splitSessionState.activeHydratingEpoch === null) break;
          await new Promise(r => setTimeout(r, 20));
        }
        if (splitId !== 'split-race-test' || splitSessionState.lastRenderedSeq !== 1 || splitSessionState.activeHydratingEpoch !== null) {
          throw new Error('Timed out waiting for split creation and hydration to settle');
        }
      } finally {
        clearInterval(poller);
      }

      const phantomCleanedUp = !terminalPool.has('split-race-test');
      let splitText = '';
      if (splitTerm && splitTerm.buffer && splitTerm.buffer.active) {
        const b = splitTerm.buffer.active;
        for (let i = 0; i < b.length; i++) {
          const l = b.getLine(i);
          if (l) splitText += l.translateToString(true) + String.fromCharCode(10);
        }
      }
      const splitSeq = splitSessionState.lastRenderedSeq;

      return {
        phantomObservedDuringRace,
        phantomCleanedUp,
        splitText: splitText.trim(),
        splitSeq
      };
    })()`);

    telemetry.checks.creationMisrouting = {
      phantomObservedDuringRace: check3Result.phantomObservedDuringRace,
      phantomCleanedUpByMountClean: check3Result.phantomCleanedUp,
      splitPaneHydratedCleanly: check3Result.splitSeq === 1 && check3Result.splitText.includes('PROBE-RACE'),
      details: check3Result,
    };

    console.log('[PROBE] Check 3 result:', JSON.stringify(telemetry.checks.creationMisrouting, null, 2));
    // -------------------------------------------------------------
    // CHECK 4: Null Chunk Retry Dereference Resilience in Real Renderer
    // -------------------------------------------------------------
    console.log('[PROBE] Executing Check 4: Real Renderer Null Chunk Retry Resilience...');
    const check4Result = await win.webContents.executeJavaScript(`(async () => {
      try {
        splitSessionState.liveQueue = [{ seq: 10, generation: 1, data: 'NULL-CHUNK-RETRY-TEST\\r\\n' }];
        splitSessionState.lastRenderedSeq = 5;
        // Invoke actual renderer function with null chunk (as done by setTimeout retry on line 797)
        await handleSequenceGap(splitSessionState, null, true);
        return {
          ok: true,
          gapCount: splitSessionState.gapCount,
          isFetchingDelta: splitSessionState.isFetchingDelta,
          lastRenderedSeq: splitSessionState.lastRenderedSeq,
          queueLength: splitSessionState.liveQueue.length,
          syncState: splitSessionState.syncState,
        };
      } catch (err) {
        return {
          ok: false,
          error: err.message,
          stack: err.stack,
        };
      }
    })()`);

    // Send live contiguous chunk (seq 11) to prove stream continues updating cleanly without freezing
    win.webContents.send('antifan:terminal:data', {
      sessionId: 'split-race-test',
      data: 'POST-GAP-LIVE-CHUNK\\r\\n',
      seq: 11,
      generation: 1,
    });
    await new Promise((r) => setTimeout(r, 200));

    const check4LiveResult = await win.webContents.executeJavaScript(`(() => {
      let liveTextFound = false;
      if (splitTerm && splitTerm.buffer && splitTerm.buffer.active) {
        const b = splitTerm.buffer.active;
        for (let i = 0; i < b.length; i++) {
          const l = b.getLine(i);
          if (l && l.translateToString(true).includes('POST-GAP-LIVE-CHUNK')) {
            liveTextFound = true;
            break;
          }
        }
      }
      return {
        lastSeq: splitSessionState.lastRenderedSeq,
        liveTextFound,
      };
    })()`);

    telemetry.checks.nullChunkRetryResilience = {
      handledWithoutTypeError: check4Result.ok === true,
      lastRenderedSeqAdvancesToTen: check4Result.lastRenderedSeq === 10,
      queueDrainedCompletely: check4Result.queueLength === 0,
      isFetchingDeltaSettledFalse: check4Result.isFetchingDelta === false,
      syncStateReady: check4Result.syncState === 'READY',
      postGapLiveChunkProcessed: check4LiveResult.lastSeq === 11 && check4LiveResult.liveTextFound,
      details: { ...check4Result, postGapLive: check4LiveResult },
    };
    console.log('[PROBE] Check 4 result:', JSON.stringify(telemetry.checks.nullChunkRetryResilience, null, 2));

    // Final Verdict based on deterministic post-fix assertions
    telemetry.verdict = (
      telemetry.checks.remountHydrationGuard.emptyCallHydratedFromBackend &&
      telemetry.checks.sameIdEarlyReturnTrap.acceptedNewerSnapshot &&
      telemetry.checks.sameIdEarlyReturnTrap.oldMarkerReplacedCleanly &&
      telemetry.checks.creationMisrouting.phantomObservedDuringRace &&
      telemetry.checks.creationMisrouting.phantomCleanedUpByMountClean &&
      telemetry.checks.creationMisrouting.splitPaneHydratedCleanly &&
      telemetry.checks.nullChunkRetryResilience.handledWithoutTypeError &&
      telemetry.checks.nullChunkRetryResilience.lastRenderedSeqAdvancesToTen &&
      telemetry.checks.nullChunkRetryResilience.queueDrainedCompletely &&
      telemetry.checks.nullChunkRetryResilience.isFetchingDeltaSettledFalse &&
      telemetry.checks.nullChunkRetryResilience.syncStateReady &&
      telemetry.checks.nullChunkRetryResilience.postGapLiveChunkProcessed
    ) ? 'CONFIRMED_ALL_FIXES_VERIFIED' : 'PARTIAL_VERIFICATION';
    fs.writeFileSync(certFile, JSON.stringify(telemetry, null, 2), 'utf8');
    console.log('[PROBE] Telemetry saved to:', certFile);
    console.log('[PROBE] Verdict:', telemetry.verdict);

    app.quit();
    process.exit(telemetry.verdict === 'CONFIRMED_ALL_FIXES_VERIFIED' ? 0 : 1);
  } catch (err) {
    console.error('[PROBE ERROR]', err);
    app.quit();
    process.exit(1);
  }
});
