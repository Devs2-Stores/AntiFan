/**
 * AntiFan Terminal Paint Pipeline Benchmark (Real Electron Runtime)
 *
 * Harness shape cloned from test/e2e/terminal-transport-sync.cjs:
 * - Real compiled TerminalManager & SessionDeliveryJournal in Electron Main
 * - Real standalone.html, standalone-preload.js, and standalone.js in BrowserWindow
 * - Real IPC delivery over webContents.send('antifan:terminal:data')
 *
 * Difference: instead of a fake PTY burst for correctness gates, this streams
 * chunks for PAINT_BENCH_DURATION_MS (default 60s) and reads the renderer
 * telemetry hook pinned for Phase 1:
 *
 *   window.__antifanTerminalBench = {
 *     record(stage: 'T1'|'T2'|'T3'|'T4', extra?): void,
 *     snapshot(): Array<{ stage, ts, extra? }>,   // ts = performance.now()
 *     clear(): void,
 *   }
 *
 *   T1 = onTerminalData receipt, T2 = queueWrite entry,
 *   T3 = onPostWrite parse complete, T4 = next rAF paint.
 *
 * The hook lives in src/renderer/standalone.js (sibling-owned). If it is absent
 * the run reports NOT_INSTALLED and exits 1 — a missing hook is a failed
 * prerequisite, never a TypeError.
 *
 * Report: plans/reports/terminal-paint-bench.json
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { TerminalManager, SessionDeliveryJournal } = require('../../.compiled/src/main/browser/terminal-manager.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const STREAM_DURATION_MS = Math.max(1000, Number.parseInt(process.env.PAINT_BENCH_DURATION_MS || '60000', 10) || 60000);
const CHUNK_INTERVAL_MS = Math.max(1, Number.parseInt(process.env.PAINT_BENCH_CHUNK_INTERVAL_MS || '10', 10) || 10);
const CHUNK_BYTES = Math.max(64, Number.parseInt(process.env.PAINT_BENCH_CHUNK_BYTES || '2048', 10) || 2048);

const reportsDir = path.join(__dirname, '..', '..', 'plans', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const reportFile = path.join(reportsDir, 'terminal-paint-bench.json');

const report = {
  timestamp: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  streamDurationMs: STREAM_DURATION_MS,
  chunkIntervalMs: CHUNK_INTERVAL_MS,
  chunkBytes: CHUNK_BYTES,
  verdict: 'PENDING',
};

const tm = TerminalManager.getInstance();
const sessionId = 'bench-paint-session';
let win = null;

// Same real-session record shape as terminal-transport-sync.cjs: the renderer
// pipeline under test is identical, only the data source is paced by us.
const realSession = {
  id: sessionId,
  name: 'Terminal Paint Bench',
  cwd: process.cwd(),
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
tm.sessions.set(sessionId, realSession);
tm.activeSessionId = sessionId;

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

/** Percentile stats over a numeric sample array; empty input yields nulls. */
function stageStats(samples) {
  const values = (samples || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return { count: 0, mean: null, p50: null, p95: null, max: null };
  const sorted = values.slice().sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    count: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: pick(50),
    p95: pick(95),
    max: sorted[sorted.length - 1],
  };
}

/**
 * Pair consecutive stage stamps into pipeline deltas. The dispatcher may
 * coalesce several T1 receipts into one write or split one chunk across frame
 * budgets, so each later-stage stamp is measured against the most recent
 * earlier-stage stamp rather than a fixed index.
 */
function computeStageDeltas(events) {
  const deltas = { ipcToQueue: [], queueToParse: [], parseToPaint: [], ipcToPaint: [] };
  const counts = { T1: 0, T2: 0, T3: 0, T4: 0 };
  let lastT1 = null;
  let lastT2 = null;
  let lastT3 = null;
  for (const ev of events) {
    if (!ev || typeof ev.ts !== 'number') continue;
    counts[ev.stage] = (counts[ev.stage] || 0) + 1;
    if (ev.stage === 'T1') {
      lastT1 = ev.ts;
    } else if (ev.stage === 'T2') {
      if (lastT1 !== null) deltas.ipcToQueue.push(ev.ts - lastT1);
      lastT2 = ev.ts;
    } else if (ev.stage === 'T3') {
      if (lastT2 !== null) deltas.queueToParse.push(ev.ts - lastT2);
      lastT3 = ev.ts;
    } else if (ev.stage === 'T4') {
      if (lastT3 !== null) deltas.parseToPaint.push(ev.ts - lastT3);
      if (lastT1 !== null) deltas.ipcToPaint.push(ev.ts - lastT1);
    }
  }
  return { deltas, counts };
}

function writeReport() {
  try {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    console.error('[PaintBench] failed to write report:', err);
  }
}

function finish(code) {
  writeReport();
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
  process.exit(code);
}

app.whenReady().then(async () => {
  // Wire the same real TerminalManager IPC surface the renderer consumes.
  ipcMain.handle('antifan:terminal:get-delta', (_event, query) => {
    return tm.getTerminalDelta(query.sessionId, query.generation, query.fromSeq);
  });
  ipcMain.handle('antifan:terminal:sync-view', (_event, query) => {
    return tm.syncTerminalView(query);
  });
  ipcMain.on('antifan:terminal:ack', (_event, payload) => {
    tm.recordSubscriberAck(payload);
  });
  ipcMain.handle('antifan:terminal:dump-diagnostics', () => tm.getDiagnostics());
  ipcMain.handle('antifan:terminal:resize-session', () => true);
  ipcMain.handle('antifan:terminal:resize', () => true);
  ipcMain.handle('antifan:terminal:get-full-buffer', (_event, id) => {
    return tm.getFullBuffer(id || sessionId);
  });
  ipcMain.handle('antifan:terminal:list-sessions', () => [
    {
      id: realSession.id,
      name: realSession.name,
      cwd: realSession.cwd,
      active: true,
      buffer: realSession.buffer,
      sessionGeneration: realSession.sessionGeneration,
      snapshotThroughSeq: realSession.lastSeq,
    },
  ]);
  ipcMain.handle('antifan:sidebar:get-initial-state', () => ({
    workspacePath: process.cwd(),
    activeWorkspace: process.cwd(),
  }));
  ipcMain.handle('antifan:terminal:start', () => true);
  ipcMain.handle('antifan:tabs:get-list', () => []);
  ipcMain.handle('antifan:terminal:get-affinity', () => null);
  ipcMain.handle('antifan:terminal:set-affinity', () => true);

  win = new BrowserWindow({
    width: 1024,
    height: 768,
    // T4 is a real rAF paint: the window must actually produce frames.
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', '.compiled', 'src', 'preload', 'standalone-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
    },
  });

  win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    console.log(`[Renderer Console L${level}] ${msg} (${sourceId}:${line})`);
  });

  const htmlPath = path.resolve(__dirname, '../../.compiled/src/renderer/standalone.html');
  // __bench=1 opts the renderer hook in; harmless if the hook keys off a
  // different flag, since the presence probe below is authoritative.
  await win.loadFile(htmlPath, { query: { mode: 'popout', __bench: '1' } });
  await new Promise((r) => setTimeout(r, 600));
  broadcastSessionState();
  await new Promise((r) => setTimeout(r, 400));
  console.log('[PaintBench] Real Electron window loaded with genuine TerminalManager.');

  try {
    const hookStatus = await win.webContents.executeJavaScript(`(() => {
      const b = window.__antifanTerminalBench;
      if (!b) return 'missing';
      if (typeof b.snapshot !== 'function' || typeof b.clear !== 'function') return 'shape-mismatch';
      return 'ok';
    })()`);
    if (hookStatus !== 'ok') {
      report.verdict = 'NOT_INSTALLED';
      report.error = hookStatus === 'missing'
        ? 'window.__antifanTerminalBench is absent — the renderer telemetry hook (src/renderer/standalone.js) has not landed; cannot measure paint stages'
        : 'window.__antifanTerminalBench exists but does not expose snapshot()+clear() per the pinned contract';
      console.error(`[PaintBench] ${report.error}`);
      finish(1);
      return;
    }

    await win.webContents.executeJavaScript('window.__antifanTerminalBench.clear()');

    // 60s paced stream: fixed-size chunks on a fixed cadence so throughput is
    // an input, not a shell-dependent variable.
    const line = `bench-line ${'x'.repeat(48)}\r\n`;
    const chunkText = line.repeat(Math.max(1, Math.floor(CHUNK_BYTES / line.length)));
    let sentChunks = 0;
    let sentBytes = 0;
    const streamStart = Date.now();
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (Date.now() - streamStart >= STREAM_DURATION_MS) {
          clearInterval(timer);
          resolve();
          return;
        }
        const chunk = feedAndStoreChunk(chunkText);
        sentChunks++;
        sentBytes += Buffer.byteLength(chunkText, 'utf8');
        deliverChunk(chunk);
      }, CHUNK_INTERVAL_MS);
    });
    const streamElapsedMs = Date.now() - streamStart;

    // Drain: wait until the renderer's receipt marker reaches the last seq,
    // then give trailing rAF (T4) stamps a beat to land.
    const drainDeadline = Date.now() + 10000;
    let drained = false;
    while (Date.now() < drainDeadline) {
      const health = await win.webContents.executeJavaScript('window.__antifanTerminalHealth()');
      const view = health?.views?.find((x) => x.sessionId === sessionId);
      if (view && view.lastRenderedSeq >= realSession.lastSeq) {
        drained = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500));

    const events = await win.webContents.executeJavaScript('window.__antifanTerminalBench.snapshot()');
    if (!Array.isArray(events)) {
      report.verdict = 'FAILED';
      report.error = `snapshot() returned ${typeof events}, expected an array of { stage, ts }`;
      console.error(`[PaintBench] ${report.error}`);
      finish(1);
      return;
    }

    const { deltas, counts } = computeStageDeltas(events);
    report.stream = {
      sentChunks,
      sentBytes,
      streamElapsedMs,
      drained,
      finalSeq: realSession.lastSeq,
      throughputChunksPerSec: streamElapsedMs > 0 ? (sentChunks / streamElapsedMs) * 1000 : null,
      throughputBytesPerSec: streamElapsedMs > 0 ? (sentBytes / streamElapsedMs) * 1000 : null,
    };
    report.stageEventCounts = counts;
    report.stages = {
      ipcToQueue: stageStats(deltas.ipcToQueue),
      queueToParse: stageStats(deltas.queueToParse),
      parseToPaint: stageStats(deltas.parseToPaint),
      ipcToPaint: stageStats(deltas.ipcToPaint),
    };
    report.verdict = 'MEASURED';

    const fmt = (s) => (s.count === 0 ? 'n/a' : `p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms mean=${s.mean.toFixed(2)}ms n=${s.count}`);
    console.log('\n======================================================');
    console.log(`[PaintBench] stream: ${sentChunks} chunks / ${sentBytes} bytes in ${streamElapsedMs}ms ` +
      `(${report.stream.throughputChunksPerSec.toFixed(1)} chunks/s, ${(report.stream.throughputBytesPerSec / 1024).toFixed(1)} KiB/s)`);
    console.log(`[PaintBench] stage counts: T1=${counts.T1 || 0} T2=${counts.T2 || 0} T3=${counts.T3 || 0} T4=${counts.T4 || 0}`);
    console.log(`[PaintBench] T1->T2 ipcToQueue:   ${fmt(report.stages.ipcToQueue)}`);
    console.log(`[PaintBench] T2->T3 queueToParse: ${fmt(report.stages.queueToParse)}`);
    console.log(`[PaintBench] T3->T4 parseToPaint: ${fmt(report.stages.parseToPaint)}`);
    console.log(`[PaintBench] T1->T4 ipcToPaint:   ${fmt(report.stages.ipcToPaint)}`);
    console.log(`[PaintBench] drained=${drained} report=${reportFile}`);
    console.log('======================================================\n');

    finish(0);
  } catch (err) {
    console.error('[PaintBench] FAILED', err);
    report.verdict = 'FAILED';
    report.error = String(err && err.stack ? err.stack : err);
    finish(1);
  }
});
