/**
 * AntiFan TabDevToolsHost CDP Queue Lifecycle & Non-Dispatch Live Electron Probe
 *
 * Exercises real Electron Chromium WebContents & real CDP Debugger:
 * 1. Proves Command A is truly in-flight in Chromium V8 when caller times out.
 * 2. Instruments win.webContents.debugger.sendCommand to empirically prove
 *    Command B (and repeated calls) NEVER reach CDP when rejected at admission.
 * 3. Proves target remains draining while Command A is unsettled.
 * 4. Proves queue is drained cleanly and transitions to 0 when Command A settles.
 * 5. Proves Command C executes and succeeds on the same TabDevToolsHost instance without recreate.
 *
 * Note on Recycled ID Token Fencing:
 * Recycled numeric WebContents IDs cannot be deterministically forced in live Electron
 * without process-level mocking (Electron's ID generator increments monotonically).
 * Token fencing across recycled IDs is covered deterministically in test/main/tab-devtools-host.test.ts;
 * this live probe focuses strictly on the live Chromium transport & admission invariants.
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const { TabDevToolsHost } = require('../.compiled/src/main/browser/tab-devtools-host.js');

let exitCode = 0;

app.whenReady().then(async () => {
  let win = null;
  try {
    console.log('[Live Electron Probe] Initializing Chromium window & DevToolsHost...');
    win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    await win.loadURL('about:blank');

    // Instrument debugger.sendCommand to record every call actually sent to Chromium CDP
    const dispatchedCalls = [];
    const originalDebugger = win.webContents.debugger;
    const rawSendCommand = originalDebugger.sendCommand.bind(originalDebugger);

    originalDebugger.sendCommand = function (method, params, sessionId) {
      dispatchedCalls.push({ method, params, timestamp: Date.now() });
      return rawSendCommand(method, params, sessionId);
    };

    const ctx = {
      getTabWebContents: () => win.webContents,
      getTabTerminalSession: () => undefined,
      resolveTargetWorkspace: () => '',
      resolveAnnotationWorkspace: () => '',
      createTab: () => 'tab-probe',
      withTabAgentWorking: (_id, fn) => fn(),
    };

    const devTools = new TabDevToolsHost(ctx);

    console.log('\n=== REAL CHROMIUM IN-FLIGHT TIMEOUT & ADMISSION INVARIANT PROBE ===\n');

    // [1/5] Dispatch Command A: A Promise held open in Chromium V8
    console.log('[1/5] Dispatching Command A (Runtime.evaluate awaiting window.__resolveA) with 400ms timeout...');
    const cmdAPromise = devTools.sendCdpCommand(
      win.webContents,
      'Runtime.evaluate',
      {
        expression: 'new Promise((resolve) => { window.__resolveA = resolve; })',
        awaitPromise: true,
        returnByValue: true,
      },
      400
    );

    let cmdAError = null;
    try {
      await cmdAPromise;
    } catch (err) {
      cmdAError = err;
    }
    assert(cmdAError && /timed out/.test(cmdAError.message), 'Command A must reject with caller timeout');
    console.log('  ✔ Command A timed out from caller perspective as expected');

    // Assert dispatch tracking: Command A was dispatched exactly once
    assert.strictEqual(dispatchedCalls.length, 1, 'Exactly one command must have been dispatched to Chromium debugger');
    assert.strictEqual(dispatchedCalls[0].method, 'Runtime.evaluate', 'Dispatched command must be Runtime.evaluate');

    // Assert Chromium state: window.__resolveA is active in V8
    const isDefined = await win.webContents.executeJavaScript('typeof window.__resolveA === "function"');
    assert.strictEqual(isDefined, true, 'window.__resolveA must be actively registered in Chromium V8 engine');
    console.log('  ✔ Command A confirmed actively in-flight in Chromium V8 engine');

    // Assert host state: target is draining, queue holds pending drain
    assert.strictEqual(devTools.getStats().drainingTargetCount, 1, 'Target must be marked draining in host telemetry');
    assert.strictEqual(devTools.getStats().queuedTargetCount, 1, 'Queue must retain pending drain promise');
    console.log('  ✔ Target in draining state (draining=1, queued=1)');

    // [2/5] Dispatch Command B while target is draining: prove non-dispatch
    console.log('[2/5] Dispatching Command B (DOM.getDocument) to draining target...');
    let cmdBError = null;
    const tStart = Date.now();
    try {
      await devTools.sendCdpCommand(win.webContents, 'DOM.getDocument', {}, 1000);
    } catch (err) {
      cmdBError = err;
    }
    const admissionDuration = Date.now() - tStart;
    assert(cmdBError && /TARGET_BUSY_DRAINING/.test(cmdBError.message), 'Command B must fail fast with TARGET_BUSY_DRAINING');
    assert(admissionDuration < 100, `Admission check must reject immediately (took ${admissionDuration}ms)`);

    // Empirical proof of non-dispatch: debugger.sendCommand was NOT called for Command B
    assert.strictEqual(dispatchedCalls.length, 1, 'debugger.sendCommand must NOT be called for Command B');
    assert(!dispatchedCalls.some(c => c.method === 'DOM.getDocument'), 'DOM.getDocument must never reach Chromium debugger');
    console.log(`  ✔ Command B rejected at admission (${admissionDuration}ms) and EMPIRICALLY PROVEN NOT DISPATCHED to CDP`);

    // [3/5] Test repeated admissions during draining state
    console.log('[3/5] Testing 5 repeated admissions during draining state...');
    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        devTools.sendCdpCommand(win.webContents, 'DOM.getDocument', {}, 500),
        /TARGET_BUSY_DRAINING/
      );
    }
    // Debugger call count must remain strictly 1
    assert.strictEqual(dispatchedCalls.length, 1, 'debugger.sendCommand call count must remain strictly 1 after 5 rejected calls');
    assert.strictEqual(devTools.getStats().drainingTargetCount, 1, 'Draining count must remain 1');
    assert.strictEqual(devTools.getStats().queuedTargetCount, 1, 'Queued target count must remain 1');
    console.log('  ✔ All 5 repeated admissions rejected with ZERO additional CDP dispatches');

    // [4/5] Settle Command A in Chromium and observe clean drain
    console.log('[4/5] Settling Command A in Chromium V8 engine...');
    await win.webContents.executeJavaScript('window.__resolveA({ result: "done_A" })');

    // Yield so Chromium delivers CDP event and microtasks run
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 150));

    // Telemetry must transition to 0
    assert.strictEqual(devTools.getStats().drainingTargetCount, 0, 'Draining state must clear after settlement');
    assert.strictEqual(devTools.getStats().queuedTargetCount, 0, 'Queue must drain to 0 after settlement');
    console.log('  ✔ Command A settled; draining cleared and queue drained cleanly (draining=0, queued=0)');

    // [5/5] Command C runs and succeeds on the same TabDevToolsHost instance
    console.log('[5/5] Dispatching Command C to verify post-recovery execution...');
    const resC = await devTools.sendCdpCommand(
      win.webContents,
      'Runtime.evaluate',
      { expression: '21 * 2', returnByValue: true },
      2000
    );
    assert.strictEqual(resC?.result?.value, 42, 'Command C must return evaluated value 42');

    // Exactly 2 commands dispatched across the entire lifetime of the probe
    assert.strictEqual(dispatchedCalls.length, 2, 'Exactly 2 commands must have been dispatched to Chromium debugger overall');
    assert.deepStrictEqual(
      dispatchedCalls.map(c => c.method),
      ['Runtime.evaluate', 'Runtime.evaluate'],
      'Dispatched calls must be [Command A, Command C]'
    );
    assert.strictEqual(devTools.getStats().drainingTargetCount, 0);
    assert.strictEqual(devTools.getStats().queuedTargetCount, 0);
    console.log('  ✔ Command C executed and returned 42 on real Chromium');
    console.log('  ✔ Lifetime dispatch ledger verified: exactly [Runtime.evaluate (A), Runtime.evaluate (C)]');

    console.log('\n======================================================');
    console.log('  ALL LIVE CHROMIUM INVARIANT CRITERIA VERIFIED (5/5) ');
    console.log('======================================================\n');
  } catch (err) {
    console.error('\n[Live Electron Probe] ERROR / ASSERTION FAILURE:', err);
    exitCode = 1;
  } finally {
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
    app.exit(exitCode);
  }
});
