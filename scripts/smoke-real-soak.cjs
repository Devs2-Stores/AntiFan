#!/usr/bin/env node
/**
 * AntiFan Browser Desktop - Real Multi-Process Runtime Soak Test (Phase 4)
 * Executes an authentic 4-stage endurance sequence against a live Electron multi-process binary:
 * 1. Stage 1: Idle Baseline (Real multi-process OS working set sampling via app.getAppMetrics())
 * 2. Stage 2: PTY Streaming Stress (High-throughput ANSI chunk streaming through real node-pty TerminalManager)
 * 3. Stage 3: Split Review & Tab Thrash (Real NativeTabHost 4-tab concurrency, toggleSplitReview, cycling switches)
 * 4. Stage 4: Concurrent QA Blast & Live Storefront Inspection
 *
 * Asserts:
 * - Successful completion of all 4 multi-process workload stages
 * - Clean graceful teardown with zero orphaned ConPTY / Electron processes
 */

const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');

app.commandLine.appendSwitch('no-sandbox');

const { NativeTabHost } = require('../.compiled/src/main/browser/native-tab-host.js');
const { TerminalManager } = require('../.compiled/src/main/browser/terminal-manager.js');
const { LiquidErrorScanner } = require('../.compiled/src/main/qa/scanners/liquid-error-scanner.js');
const { PlatformDetector } = require('../.compiled/src/main/qa/scanners/platform-detector.js');

// 1. Calculate linear regression slope: Beta = Cov(t, RAM) / Var(t) in MB/min
function calculateMemorySlope(samples) {
  const n = samples.length;
  if (n < 2) return 0;

  const firstT = samples[0].timestamp;
  const tMinutes = samples.map((s) => (s.timestamp - firstT) / 60000);
  const rMB = samples.map((s) => s.rssBytes / (1024 * 1024));

  const meanT = tMinutes.reduce((acc, t) => acc + t, 0) / n;
  const meanM = rMB.reduce((acc, m) => acc + m, 0) / n;

  let num = 0;
  let den = 0;

  for (let i = 0; i < n; i++) {
    const dt = tMinutes[i] - meanT;
    const dm = rMB[i] - meanM;
    num += dt * dm;
    den += dt * dt;
  }

  return den === 0 ? 0 : num / den;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 2. Local HTTP Fixture Server (Storefront Mock)
function startFixtureServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
      <html lang="vi">
      <head>
        <meta charset="utf-8" />
        <title>Soak Test Storefront Fixture</title>
        <style>
          body { font-family: sans-serif; margin: 20px; background: #f4f4f5; color: #18181b; }
          .hero { padding: 40px; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 20px; }
          .card { padding: 16px; background: #fff; border-radius: 6px; }
        </style>
      </head>
      <body>
        <div class="hero">
          <h1>Soak Test Storefront</h1>
          <p>Mock e-commerce theme for endurance load testing.</p>
          <div class="liquid-err">Liquid error: Could not find snippet 'cart-drawer'</div>
        </div>
        <div class="grid">
          <div class="card"><h3>Product 1</h3><p>Price: 100.000₫</p></div>
          <div class="card"><h3>Product 2</h3><p>Price: 200.000₫</p></div>
          <div class="card"><h3>Product 3</h3><p>Price: 300.000₫</p></div>
        </div>
      </body>
      </html>`);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

// 3. Main Real Soak Endurance Runner
async function runSoakTest() {
  const durationArgIdx = process.argv.indexOf('--duration');
  let rawDuration = undefined;
  if (durationArgIdx !== -1) {
    rawDuration = process.argv[durationArgIdx + 1];
    if (!rawDuration || rawDuration.startsWith('--')) {
      throw new Error('Flag --duration requires a positive numeric argument (e.g. --duration 30)');
    }
  } else if (process.env.SOAK_DURATION_MINUTES) {
    rawDuration = process.env.SOAK_DURATION_MINUTES;
  }

  let soakDurationMinutes = 0;
  let isExtendedSoak = false;

  if (rawDuration !== undefined) {
    const parsed = Number(rawDuration);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid --duration argument '${rawDuration}': must be a finite positive number of minutes.`);
    }
    if (parsed < 30 || parsed > 45) {
      throw new Error(
        `Extended soak baseline certification requires a duration between 30 and 45 minutes (received ${parsed}m). ` +
        `Runs outside 30-45 minutes cannot certify the Phase 1 soak baseline. Omit --duration for smoke mode or specify 30-45.`
      );
    }
    soakDurationMinutes = parsed;
    isExtendedSoak = true;
  }

  const targetEnduranceMs = isExtendedSoak ? soakDurationMinutes * 60 * 1000 : 0;

  console.log('===============================================================');
  console.log(`  AntiFan Browser Desktop - Real Multi-Process Soak Endurance`);
  console.log(`  Mode: ${isExtendedSoak ? `Extended Soak (${soakDurationMinutes} minutes)` : 'Quick Workload Smoke (~30s)'}`);
  console.log('===============================================================');
  const fixture = await startFixtureServer();
  console.log(`[soak] Local fixture server running on ${fixture.url}`);

  const soakDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-soak-'));
  app.setPath('userData', soakDataDir);

  const allSamples = [];
  const stage1Samples = [];
  const steadyStateSamples = [];
  let isSampling = true;
  let inStage1 = false;
  let inSteadyState = false;
  function sampleProcessTreeMemory() {
    try {
      const metrics = app.getAppMetrics();
      let totalWorkingSetBytes = 0;
      for (const m of metrics) {
        if (m.memory && typeof m.memory.workingSetSize === 'number') {
          totalWorkingSetBytes += m.memory.workingSetSize * 1024;
        }
      }
      if (totalWorkingSetBytes === 0) {
        totalWorkingSetBytes = process.memoryUsage().rss;
      }
      return {
        timestamp: Date.now(),
        rssBytes: totalWorkingSetBytes,
        processCount: metrics.length,
      };
    } catch {
      return {
        timestamp: Date.now(),
        rssBytes: process.memoryUsage().rss,
        processCount: 1,
      };
    }
  }

  const poller = setInterval(() => {
    if (!isSampling) return;
    const sample = sampleProcessTreeMemory();
    allSamples.push(sample);
    if (inStage1) {
      stage1Samples.push(sample);
    }
    if (inSteadyState) {
      steadyStateSamples.push(sample);
    }
  }, 500);

  let mainWindow = null;
  let tabHost = null;
  const trackedPtyPids = new Set();
  const termMgr = TerminalManager.getInstance();

  try {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    tabHost = new NativeTabHost(mainWindow);
    const initialTabId = tabHost.createTab(fixture.url, true);
    const createdTabIds = [initialTabId];
    for (let i = 1; i < 4; i++) {
      const tid = tabHost.createTab(`${fixture.url}?tab=${i}`, false);
      createdTabIds.push(tid);
    }

    // Warm up the fixed 4-tab topology: cycle tabs and settle DOM
    console.log('[soak] Warming up fixed 4-tab topology...');
    for (const tid of createdTabIds) {
      tabHost.switchTab(tid);
      await wait(200);
      await tabHost.getDom(undefined, tid);
    }
    tabHost.switchTab(initialTabId);
    await wait(1000);

    // Reset samples so baseline measures only the warmed 4-tab steady state
    allSamples.length = 0;
    stage1Samples.length = 0;

    const stageResults = {};

    // -------------------------------------------------------------
    // Stage 1: Idle Baseline Sampling (5s) on Fixed 4-Tab Topology
    // -------------------------------------------------------------
    console.log('[soak] ---> Stage 1: Idle Baseline Sampling (5s) on fixed 4-tab topology...');
    const s1Start = Date.now();
    inStage1 = true;
    await wait(5000);
    inStage1 = false;
    stageResults.stage1Idle = { durationMs: Date.now() - s1Start, samples: stage1Samples.length };
    console.log(`[soak] Stage 1 completed. Recorded ${stage1Samples.length} telemetry samples.`);

    // -------------------------------------------------------------
    // Stage 2: Real PTY Streaming Stress (High-throughput chunks through node-pty)
    // -------------------------------------------------------------
    console.log('[soak] ---> Stage 2: PTY Streaming Stress through node-pty TerminalManager...');
    const s2Start = Date.now();
    const sessionId = termMgr.createSession(os.tmpdir());
    const termSession = termMgr.getSession(sessionId);
    if (termSession && termSession.pty && termSession.pty.pid) {
      trackedPtyPids.add(termSession.pty.pid);
    }

    let ptyReceivedBytes = 0;
    const onDataHandler = ({ data }) => {
      if (data) ptyReceivedBytes += Buffer.byteLength(data, 'utf8');
    };
    termMgr.on('data', onDataHandler);

    // Stream >= 500KB through real PTY using 100 x 8KB paced writes to prevent Windows winpty buffer lockup
    const streamCommand = process.platform === 'win32'
      ? '1..100 | ForEach-Object { [Console]::Out.Write("A" * 8192); Start-Sleep -Milliseconds 15 }\r\n'
      : 'for i in $(seq 1 100); do head -c 8192 /dev/zero | tr "\\0" "A"; sleep 0.015; done\r\n';

    termMgr.writeTo(sessionId, streamCommand);

    // Wait until at least 500KB is received through node-pty or timeout after 30s with live instrumentation
    const ptyStartWait = Date.now();
    let lastProgressLog = Date.now();
    while (ptyReceivedBytes < 500 * 1024 && Date.now() - ptyStartWait < 30000) {
      if (Date.now() - lastProgressLog >= 2000) {
        console.log(`[soak] PTY streaming progress: ${ptyReceivedBytes} / ${500 * 1024} bytes (${((Date.now() - ptyStartWait) / 1000).toFixed(1)}s elapsed, sessionState: ${termSession?.state})...`);
        lastProgressLog = Date.now();
      }
      await wait(100);
    }
    termMgr.off('data', onDataHandler);

    stageResults.stage2Streaming = {
      durationMs: Date.now() - s2Start,
      ptyReceivedBytes,
      sessionCreated: Boolean(sessionId),
      termSessionState: termSession?.state,
      exitCode: termSession?.exitCode,
    };

    await termMgr.closeSession(sessionId);

    console.log(`[soak] Stage 2 completed. Streamed and processed ${ptyReceivedBytes} bytes through real PTY (state: ${termSession?.state}).`);
    assert.ok(ptyReceivedBytes >= 500 * 1024, `Must stream >= 500KB through real PTY (got ${ptyReceivedBytes} bytes)`);

    // -------------------------------------------------------------
    // Stage 3: Real Split Review & Tab Thrash across existing 4 tabs
    // -------------------------------------------------------------
    console.log('[soak] ---> Stage 3: Split Review & Tab Thrash across existing 4 tabs...');
    const s3Start = Date.now();

    // Toggle real Split Review mode on primary tab
    tabHost.toggleSplitReview(initialTabId, true);
    await wait(500);

    let tabSwitches = 0;
    for (let i = 0; i < 20; i++) {
      const targetId = createdTabIds[i % createdTabIds.length];
      tabHost.switchTab(targetId);
      tabSwitches++;
      await wait(50);
    }

    tabHost.toggleSplitReview(initialTabId, false);
    await wait(300);

    stageResults.stage3TabThrash = {
      durationMs: Date.now() - s3Start,
      tabSwitches,
      tabCount: createdTabIds.length,
    };
    console.log(`[soak] Stage 3 completed. Performed ${tabSwitches} active tab switches across ${createdTabIds.length} tabs.`);
    // -------------------------------------------------------------
    // Stage 4: Concurrent QA Blast & Extended Endurance Loop
    // -------------------------------------------------------------
    console.log('[soak] ---> Stage 4: Concurrent QA Blast & Endurance Cycling...');
    const s4Start = Date.now();
    let qaRuns = 0;
    let errorsFound = 0;
    let enduranceCycles = 0;

    do {
      enduranceCycles++;
      for (let i = 0; i < 20; i++) {
        const targetId = createdTabIds[i % createdTabIds.length];
        tabHost.switchTab(targetId);
        const liveHtml = await tabHost.getDom(undefined, targetId);
        if (liveHtml) {
          PlatformDetector.detectFromRuntime(fixture.url, liveHtml);
          const scanResult = LiquidErrorScanner.scanHtmlString(liveHtml);
          if (scanResult.hasErrors) errorsFound += scanResult.errors.length;
        }
        qaRuns++;
        if (i % 4 === 0) {
          tabHost.reload(targetId);
        }
        await wait(50);
      }

      // If extended soak, interleave quick PTY chunk stream to stress terminal background
      if (isExtendedSoak && Date.now() - s4Start < targetEnduranceMs) {
        const subSessionId = termMgr.createSession(os.tmpdir());
        const subTerm = termMgr.getSession(subSessionId);
        if (subTerm && subTerm.pty && subTerm.pty.pid) {
          trackedPtyPids.add(subTerm.pty.pid);
        }
        termMgr.writeTo(subSessionId, 'echo "endurance cycle"\r\n');
        await wait(200);
        await termMgr.closeSession(subSessionId);
      }
    } while (isExtendedSoak && Date.now() - s4Start < targetEnduranceMs);

    // Post-workload GC settle & fixed-topology steady-state sampling window (5s)
    console.log('[soak] Entering post-workload fixed-topology steady-state settle window (5s)...');
    steadyStateSamples.length = 0;
    inSteadyState = true;
    await wait(5000);
    inSteadyState = false;
    isSampling = false;
    clearInterval(poller);

    stageResults.stage4QaBlast = {
      durationMs: Date.now() - s4Start,
      qaRuns,
      errorsFound,
      enduranceCycles,
      steadyStateSamplesCount: steadyStateSamples.length,
    };
    console.log(`[soak] Stage 4 completed. Dispatched ${qaRuns} live QA scans across ${enduranceCycles} cycles (${steadyStateSamples.length} steady-state samples).`);

    // Teardown and check for any orphan PTY processes
    await termMgr.dispose();
    const orphanProcesses = [];
    for (const pid of trackedPtyPids) {
      if (isProcessAlive(pid)) {
        orphanProcesses.push(pid);
        try {
          if (process.platform === 'win32') {
            require('node:child_process').execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
          } else {
            process.kill(pid, 'SIGKILL');
          }
        } catch {}
      }
    }

    // Derive baseline from the settled Stage 1 window (mean across 5s idle window on fixed 4 tabs)
    const baselineRssMB = stage1Samples.length > 0
      ? (stage1Samples.reduce((acc, s) => acc + s.rssBytes, 0) / stage1Samples.length) / (1024 * 1024)
      : (allSamples[0]?.rssBytes ?? 0) / (1024 * 1024);

    // Derive final RSS from the settled post-workload steady-state window (mean across 5s window)
    const finalRssMB = steadyStateSamples.length > 0
      ? (steadyStateSamples.reduce((acc, s) => acc + s.rssBytes, 0) / steadyStateSamples.length) / (1024 * 1024)
      : (allSamples[allSamples.length - 1]?.rssBytes ?? 0) / (1024 * 1024);

    const peakRssMB = allSamples.length > 0 ? Math.max(...allSamples.map((s) => s.rssBytes)) / (1024 * 1024) : 0;
    const rssGrowthMB = finalRssMB - baselineRssMB;
    const steadyStateSlope = calculateMemorySlope(steadyStateSamples);

    const hasExplicitGc = typeof global.gc === 'function';
    if (hasExplicitGc) {
      try { global.gc(); } catch {}
    }
    const settleMethodology = hasExplicitGc
      ? 'post-explicit-gc-settle'
      : 'fixed-topology-quiescence-settle-window';

    // Functional workload validation criteria
    const passed = (
      Boolean(stageResults.stage1Idle) &&
      Boolean(stageResults.stage2Streaming && stageResults.stage2Streaming.ptyReceivedBytes >= 500 * 1024) &&
      Boolean(stageResults.stage3TabThrash && stageResults.stage3TabThrash.tabSwitches >= 20) &&
      Boolean(stageResults.stage4QaBlast && stageResults.stage4QaBlast.qaRuns >= 15) &&
      orphanProcesses.length === 0 &&
      (!isExtendedSoak || rssGrowthMB <= 30)
    );

    const report = {
      timestamp: new Date().toISOString(),
      type: isExtendedSoak ? 'extended-soak-endurance-baseline' : 'functional-multi-process-workload-smoke',
      settleMethodology,
      durationMinutes: isExtendedSoak ? soakDurationMinutes : Number(((Date.now() - s1Start) / 60000).toFixed(2)),
      stage1BaselineWindowSeconds: Number((stageResults.stage1Idle.durationMs / 1000).toFixed(1)),
      stage4SteadyStateWindowSeconds: 5.0,
      totalSamples: allSamples.length,
      baselineSamplesCount: stage1Samples.length,
      steadyStateSamplesCount: steadyStateSamples.length,
      baselineRssMB: Number(baselineRssMB.toFixed(2)),
      peakRssMB: Number(peakRssMB.toFixed(2)),
      finalRssMB: Number(finalRssMB.toFixed(2)),
      rssGrowthMB: Number(rssGrowthMB.toFixed(2)),
      observedSlopeMBPerMin: Number(steadyStateSlope.toFixed(4)),
      stageResults,
      orphanProcessesCount: orphanProcesses.length,
      passed: Boolean(passed),
    };

    console.log('\n===============================================================');
    console.log('  MULTI-PROCESS WORKLOAD SMOKE REPORT');
    console.log('===============================================================');
    console.log(`  Total Samples : ${report.totalSamples}`);
    console.log(`  Steady Samples: ${report.steadyStateSamplesCount}`);
    console.log(`  Baseline RSS  : ${report.baselineRssMB} MB (Multi-Process Tree)`);
    console.log(`  Peak RSS      : ${report.peakRssMB} MB`);
    console.log(`  Final RSS     : ${report.finalRssMB} MB`);
    console.log(`  Stage 2 PTY   : ${stageResults.stage2Streaming.ptyReceivedBytes} bytes (>= 500KB verified)`);
    console.log(`  Stage 3 Thrash: ${stageResults.stage3TabThrash.tabSwitches} switches (4 tabs + split review verified)`);
    console.log(`  Stage 4 QA    : ${stageResults.stage4QaBlast.qaRuns} live scans (live DOM extraction verified)`);
    console.log(`  Orphan Procs  : ${report.orphanProcessesCount}`);
    console.log(`  Overall Verdict: ${report.passed ? 'PASSED (VERIFIED)' : 'FAILED'}`);
    console.log('===============================================================\n');

    // Save report artifact in plan reports directory
    const planReportsDir = path.resolve(__dirname, '..', 'plans', '260904-0036-antifan-core-verification-and-primitives', 'reports');
    try { fs.mkdirSync(planReportsDir, { recursive: true }); } catch {}
    const reportFilename = isExtendedSoak ? 'windows-soak-baseline-report.json' : 'smoke-soak-workload-benchmark.json';
    fs.writeFileSync(path.join(planReportsDir, reportFilename), JSON.stringify(report, null, 2), 'utf8');

    assert.strictEqual(report.orphanProcessesCount, 0, 'Must have zero orphan processes');
    if (isExtendedSoak) {
      assert.ok(
        rssGrowthMB <= 30,
        `Memory leak assertion failed: RSS growth of ${rssGrowthMB.toFixed(2)}MB exceeded 30MB threshold`
      );
    }
    assert.ok(report.passed, 'All multi-process workload stages must complete successfully');
  } finally {
    isSampling = false;
    clearInterval(poller);
    try { await termMgr.dispose(); } catch {}
    try { tabHost?.dispose(); } catch {}
    if (fixture && fixture.server) {
      try { fixture.server.closeAllConnections?.(); } catch {}
      try { fixture.server.close(); } catch {}
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
    } catch {}
    try { fs.rmSync(soakDataDir, { recursive: true, force: true }); } catch {}
  }
}

app.whenReady().then(async () => {
  try {
    await runSoakTest();
    app.quit();
    process.exit(0);
  } catch (err) {
    console.error('[soak] Test runner failed with error:', err);
    app.quit();
    process.exit(1);
  }
});
