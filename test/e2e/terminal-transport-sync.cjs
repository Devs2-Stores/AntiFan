/**
 * AntiFan Terminal Transport Sync & Invariant Certification (Real Electron Runtime)
 *
 * Uses:
 * - Real compiled TerminalManager & SessionDeliveryJournal in Electron Main
 * - Real standalone.html, standalone-preload.js, and standalone.js in BrowserWindow
 * - Real IPC communication over ipcRenderer/ipcMain
 *
 * Exercises all 5 Core Transport Gates:
 * 1. GATE-B: Sequence Gap Healing (drops chunk 2..9 in transit, journal provides delta, settles at 10)
 * 2. GATE-C1: Continuous Background Streaming (50 chunks streamed, 0 lost)
 * 3. GATE-C2 & GATE-J: Delta Expiry & Honest Degradation (eviction in journal -> DELTA_EXPIRED -> banner -> resync)
 * 4. GATE-I: Bootstrap Recovery on Attach (real tm.syncTerminalView pulls missing chunks)
 * 5. Coalesced ACK Protocol (real tm.getSubscribers() records lastAckedSeq, no IPC flood)
 *
 * Produces authoritative certification receipt:
 * `plans/reports/terminal-p0-transport-certification.json`
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { TerminalManager, SessionDeliveryJournal } = require('../../.compiled/src/main/browser/terminal-manager.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const reportsDir = path.join(__dirname, '..', '..', 'plans', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const certFile = path.join(reportsDir, 'terminal-p0-transport-certification.json');

const testResults = {
  timestamp: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  gates: {},
  verdict: 'PENDING',
};

const tm = TerminalManager.getInstance();
const sessionId = 'test-transport-session-real';
let win = null;
let ackEventCount = 0;

// Set up real session in TerminalManager
const privates = tm;
const realSession = {
  id: sessionId,
  name: 'Terminal Real Transport',
  cwd: 'E:/Work',
  pty: {
    pid: 99999,
    cols: 120,
    rows: 30,
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    kill: () => {},
    write: () => {},
  },
  buffer: '',
  capsuleId: 'default',
  disposed: false,
  lastSeq: 0,
  sessionGeneration: 1,
  state: 'running',
  deliveryJournal: new SessionDeliveryJournal(),
};
privates.sessions.set(sessionId, realSession);
privates.activeSessionId = sessionId;

function deliverChunk(chunk) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('antifan:terminal:data', chunk);
  }
}
function broadcastSessionState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('antifan:terminal:session', {
      sessions: [
        {
          id: realSession.id,
          name: realSession.name,
          cwd: realSession.cwd,
          active: true,
          buffer: realSession.buffer,
          sessionGeneration: realSession.sessionGeneration,
          snapshotThroughSeq: realSession.lastSeq,
        },
      ],
      activeSessionId: sessionId,
      snapshot: realSession.buffer,
      snapshotThroughSeq: realSession.lastSeq,
    });
  }
}

function feedAndStoreChunk(data) {
  realSession.lastSeq++;
  realSession.deliveryJournal.append(realSession.sessionGeneration, realSession.lastSeq, data);
  realSession.buffer += data;
  return {
    sessionId,
    seq: realSession.lastSeq,
    generation: realSession.sessionGeneration,
    data,
  };
}

function deliverChunk(chunk) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('antifan:terminal:data', chunk);
  }
}

app.whenReady().then(async () => {
  // Wire real TerminalManager handlers
  ipcMain.handle('antifan:terminal:get-delta', (_event, query) => {
    return tm.getTerminalDelta(query.sessionId, query.generation, query.fromSeq);
  });

  ipcMain.handle('antifan:terminal:sync-view', (_event, query) => {
    return tm.syncTerminalView(query);
  });

  ipcMain.on('antifan:terminal:ack', (_event, payload) => {
    ackEventCount++;
    tm.recordSubscriberAck(payload);
  });

  ipcMain.handle('antifan:terminal:dump-diagnostics', () => {
    return tm.getDiagnostics();
  });
  ipcMain.handle('antifan:terminal:resize-session', () => true);
  ipcMain.handle('antifan:terminal:resize', () => true);
  ipcMain.handle('antifan:terminal:get-full-buffer', (_event, id) => {
    return tm.getFullBuffer(id || sessionId);
  });
  ipcMain.handle('antifan:terminal:list-sessions', () => {
    return [
      {
        id: realSession.id,
        name: realSession.name,
        cwd: realSession.cwd,
        active: true,
        buffer: realSession.buffer,
        sessionGeneration: realSession.sessionGeneration,
        snapshotThroughSeq: realSession.lastSeq,
      },
    ];
  });

  ipcMain.handle('antifan:sidebar:get-initial-state', () => ({
    workspacePath: 'E:/Work',
    activeWorkspace: 'E:/Work',
  }));

  ipcMain.handle('antifan:terminal:start', () => true);
  ipcMain.handle('antifan:tabs:get-list', () => []);
  ipcMain.handle('antifan:terminal:get-affinity', () => null);
  ipcMain.handle('antifan:terminal:set-affinity', () => true);
  win = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', '.compiled', 'src', 'preload', 'standalone-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    console.log(`[Renderer Console L${level}] ${msg} (${sourceId}:${line})`);
  });

  const htmlPath = path.resolve(__dirname, '../../.compiled/src/renderer/standalone.html');
  await win.loadFile(htmlPath, { query: { mode: 'popout' } });
  await new Promise((r) => setTimeout(r, 600));
  broadcastSessionState();
  await new Promise((r) => setTimeout(r, 400));
  console.log('[E2E Certification] Real Electron window loaded with genuine TerminalManager.');

  try {
    // =======================================================
    // 1. GATE-B: Sequence Gap Healing with real SessionDeliveryJournal
    // =======================================================
    console.log('[E2E Certification] Testing GATE-B: Sequence Gap Healing (Real Journal)...');

    // Chunks 1..10 are produced by PTY
    const chunk1 = feedAndStoreChunk('Line 1\r\n');
    const droppedChunks = [];
    for (let i = 2; i <= 9; i++) {
      droppedChunks.push(feedAndStoreChunk(`Line ${i}\r\n`));
    }
    const chunk10 = feedAndStoreChunk('Line 10\r\n');

    // Send chunk 1
    deliverChunk(chunk1);
    await new Promise((r) => setTimeout(r, 80));

    // Jump directly to chunk 10 (chunks 2..9 dropped in transit)
    const t0 = Date.now();
    deliverChunk(chunk10);

    // Wait for renderer to detect gap, query getTerminalDelta from real journal, and heal
    let healed = false;
    for (let attempts = 0; attempts < 40; attempts++) {
      await new Promise((r) => setTimeout(r, 50));
      const health = await win.webContents.executeJavaScript('window.__antifanTerminalHealth()');
      const v = health.views.find((x) => x.sessionId === sessionId);
      if (v && v.lastRenderedSeq === 10 && v.health === 'SYNCED') {
        healed = true;
        break;
      }
      if (attempts === 0) {
        console.log(`[DEBUG GATE-B attempt ${attempts}] health:`, JSON.stringify(health));
      }
    }
    const gapLatency = Date.now() - t0;
    assert.ok(healed, `GATE-B: Renderer must heal sequence gap and reach seq 10 (healed: ${healed})`);
    assert.ok(gapLatency < 1000, `GATE-B: Recovery latency (${gapLatency}ms) must be < 1000ms`);
    testResults.gates['GATE-B'] = { status: 'PASS', latencyMs: gapLatency };
    console.log(`[E2E Certification] ✔ GATE-B PASS (${gapLatency}ms)`);

    // =======================================================
    // 2. GATE-C1: Background Data Streaming
    // =======================================================
    console.log('[E2E Certification] Testing GATE-C1: Continuous Data Streaming...');
    for (let i = 11; i <= 60; i++) {
      const c = feedAndStoreChunk(`Stream line ${i}\r\n`);
      deliverChunk(c);
    }
    let viewC1;
    const c1Deadline = Date.now() + 1500;
    while (Date.now() < c1Deadline) {
      const healthC1 = await win.webContents.executeJavaScript('window.__antifanTerminalHealth()');
      viewC1 = healthC1.views.find((x) => x.sessionId === sessionId);
      if (viewC1?.lastRenderedSeq === 60) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.strictEqual(viewC1?.lastRenderedSeq, 60, 'GATE-C1: All 60 chunks must be rendered');
    testResults.gates['GATE-C1'] = { status: 'PASS', totalChunksRendered: 60 };
    console.log('[E2E Certification] ✔ GATE-C1 PASS (60/60 chunks rendered)');

    // =======================================================
    // 3. GATE-C2 & GATE-J: Delta Expiry via Natural Journal Eviction
    // =======================================================
    console.log('[E2E Certification] Testing GATE-C2 & GATE-J: Delta Expiry & Degradation...');
    // Real SessionDeliveryJournal has MAX_CHUNKS = 4096.
    // We add 4200 chunks so that seq 61 is completely evicted from the journal!
    for (let i = 61; i <= 4200; i++) {
      feedAndStoreChunk(`Eviction burst ${i}\r\n`);
    }

    // Now deliver chunk 4201 to the renderer (which is currently at lastRenderedSeq = 60).
    // The renderer attempts to fetch delta starting at 61.
    // The real SessionDeliveryJournal naturally returns DELTA_EXPIRED!
    const chunk4201 = feedAndStoreChunk('Chunk after 4100 evictions\r\n');
    deliverChunk(chunk4201);

    let degraded = false;
    for (let attempts = 0; attempts < 40; attempts++) {
      await new Promise((r) => setTimeout(r, 50));
      const health = await win.webContents.executeJavaScript('window.__antifanTerminalHealth()');
      const v = health.views.find((x) => x.sessionId === sessionId);
      if (v && v.health === 'DEGRADED') {
        degraded = true;
        break;
      }
    }
    assert.ok(degraded, 'GATE-C2/J: Renderer must enter DEGRADED state on natural DELTA_EXPIRED');

    // Verify degraded warning banner in DOM
    const bannerPresent = await win.webContents.executeJavaScript(`
      Boolean(document.querySelector('.terminal-degraded-banner'))
    `);
    assert.ok(bannerPresent, 'GATE-C2/J: Warning banner must be visible in DOM');

    // Click Resync button in banner to verify recovery via fullBuffer
    await win.webContents.executeJavaScript(`
      document.querySelector('.terminal-degraded-banner button')?.click();
    `);
    await new Promise((r) => setTimeout(r, 300));

    const healthRecovered = await win.webContents.executeJavaScript('window.__antifanTerminalHealth()');
    const viewRecovered = healthRecovered.views.find((x) => x.sessionId === sessionId);
    assert.strictEqual(viewRecovered?.health, 'SYNCED', 'GATE-C2/J: Clicking resync must restore SYNCED state');
    assert.strictEqual(viewRecovered?.lastRenderedSeq, realSession.lastSeq, 'GATE-C2/J: lastRenderedSeq must match full buffer sequence');
    testResults.gates['GATE-C2'] = { status: 'PASS', honestDegradationEnforced: true };
    testResults.gates['GATE-J'] = { status: 'PASS', bannerRecoveryVerified: true };
    console.log('[E2E Certification] ✔ GATE-C2 & GATE-J PASS (Honest degradation & user recovery verified)');

    // =======================================================
    // 4. GATE-I: Bootstrap Recovery on Attach
    // =======================================================
    console.log('[E2E Certification] Testing GATE-I: Bootstrap Recovery on Attach...');
    // Add 10 chunks while client is idle
    const currentSeqBeforeIdle = realSession.lastSeq;
    for (let i = 1; i <= 10; i++) {
      feedAndStoreChunk(`Idle backlog ${i}\r\n`);
    }

    // Call real tm.syncTerminalView from renderer simulating reattach
    const syncRes = await win.webContents.executeJavaScript(`
      window.antifanStandalone.syncTerminalView({
        sessionId: '${sessionId}',
        knownGeneration: ${realSession.sessionGeneration},
        lastAppliedSeq: ${currentSeqBeforeIdle}
      })
    `);
    assert.strictEqual(syncRes?.status, 'DELTA');
    assert.strictEqual(syncRes?.chunks?.length, 10, 'GATE-I: Must pull exactly 10 missing chunks from real journal');
    testResults.gates['GATE-I'] = { status: 'PASS', backlogChunksRecovered: 10 };
    console.log('[E2E Certification] ✔ GATE-I PASS (Real journal served backlog on attach)');

    // =======================================================
    // 5. Coalesced ACK Protocol Verification
    // =======================================================
    console.log('[E2E Certification] Verifying Real Coalesced ACK in Main Registry...');
    const subs = tm.getSubscribers();
    const activeSub = subs.find((s) => s.sessionId === sessionId);
    assert.ok(activeSub, 'Main TerminalManager must have registered subscriber');
    assert.ok(activeSub.lastAckedSeq > 0, `Subscriber watermark must be > 0 (got: ${activeSub.lastAckedSeq})`);
    assert.ok(ackEventCount <= 60, `Rate limiting: expected <= 60 ACKs, got ${ackEventCount}`);
    testResults.gates['COALESCED_ACK'] = {
      status: 'PASS',
      totalAcksReceived: ackEventCount,
      lastAckedSeq: activeSub.lastAckedSeq,
    };
    console.log(`[E2E Certification] ✔ Coalesced ACK PASS (${ackEventCount} ACKs received, watermark: ${activeSub.lastAckedSeq})`);

    // All gates passed
    testResults.verdict = '[P0-Transport Certified]';
    fs.writeFileSync(certFile, JSON.stringify(testResults, null, 2), 'utf8');
    console.log(`\n======================================================`);
    console.log(`🏆 ALL 5 GATES PASSED: [P0-Transport Certified]`);
    console.log(`Certification Receipt: ${certFile}`);
    console.log(`======================================================\n`);

    win.destroy();
    app.quit();
    process.exit(0);
  } catch (err) {
    console.error('[E2E Certification Failed]', err);
    testResults.verdict = 'FAILED';
    testResults.error = String(err);
    fs.writeFileSync(certFile, JSON.stringify(testResults, null, 2), 'utf8');
    if (win && !win.isDestroyed()) win.destroy();
    app.quit();
    process.exit(1);
  }
});
