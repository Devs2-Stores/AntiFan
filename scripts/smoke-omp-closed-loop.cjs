#!/usr/bin/env node
'use strict';

/**
 * AntiFan OMP Closed-Loop E2E Smoke & Soak Workload Harness
 * (P1-6 + P1-7 Acceptance Gate)
 *
 * Real Electron + Windows + OMP closed-loop E2E verification:
 *   1. MCP dispatch ->
 *   2. Capability executes in Chromium ->
 *   3. Receipt / ledger settles (inFlightCount === 0, WAL frame committed) ->
 *   4. Evidence artifact written & validated on disk ->
 *   5. Health surface reflects it (ControlPlane resource stats + Super Core health)
 *
 * Can be run standalone as a single-shot smoke test or as a sustained soak harness:
 *   node scripts/smoke-omp-closed-loop.cjs
 *   node scripts/smoke-omp-closed-loop.cjs --iterations 5
 *   node scripts/smoke-omp-closed-loop.cjs --soak --minutes 2 --jsonl reports/soak.jsonl
 *
 * If executed directly under Node.js, it automatically spawns real Electron via
 * scripts/run-electron.cjs forwarding all arguments.
 */

const isElectron = Boolean(process.versions && process.versions.electron);

if (!isElectron) {
  // Spawn under Electron via scripts/run-electron.cjs
  const { spawn } = require('node:child_process');
  const path = require('node:path');

  const rootDir = path.resolve(__dirname, '..');
  const runElectronScript = path.join(rootDir, 'scripts', 'run-electron.cjs');
  const selfScript = path.join(rootDir, 'scripts', 'smoke-omp-closed-loop.cjs');

  const childArgs = [runElectronScript, selfScript, ...process.argv.slice(2)];
  const child = spawn(process.execPath, childArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    process.exit(code !== null ? code : (signal ? 1 : 0));
  });

  child.on('error', (err) => {
    console.error('[smoke-omp-closed-loop] Failed to spawn Electron:', err);
    process.exit(1);
  });
} else {
  // Running inside Electron main process
  runElectronWorkload();
}

function parseArgs(argv) {
  const parsed = {
    iterations: 1,
    minutes: null,
    durationSeconds: null,
    intervalMs: 500,
    jsonlPath: null,
    reportPath: null,
    soak: false,
    quiet: false,
    showWindow: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--iterations' && argv[i + 1]) {
      parsed.iterations = parseInt(argv[++i], 10) || 1;
    } else if (arg === '--minutes' && argv[i + 1]) {
      parsed.minutes = parseFloat(argv[++i]) || 1;
    } else if (arg === '--duration' && argv[i + 1]) {
      parsed.durationSeconds = parseFloat(argv[++i]) || 1;
    } else if (arg === '--interval-ms' && argv[i + 1]) {
      parsed.intervalMs = parseInt(argv[++i], 10) || 500;
    } else if (arg === '--jsonl' && argv[i + 1]) {
      parsed.jsonlPath = argv[++i];
    } else if (arg === '--report' && argv[i + 1]) {
      parsed.reportPath = argv[++i];
    } else if (arg === '--soak') {
      parsed.soak = true;
    } else if (arg === '--quiet') {
      parsed.quiet = true;
    } else if (arg === '--headless') {
      parsed.showWindow = false;
    }
  }

  if (parsed.soak && !parsed.minutes && !parsed.durationSeconds && parsed.iterations === 1) {
    parsed.minutes = 30; // default soak duration
  }

  return parsed;
}

function runElectronWorkload() {
  const { app, BrowserWindow } = require('electron');
  const http = require('node:http');
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const assert = require('node:assert/strict');

  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.on('window-all-closed', (event) => {
    event.preventDefault();
  });

  const rootDir = path.resolve(__dirname, '..');
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-omp-closed-loop-'));
  app.setPath('userData', tempUserData);

  const { makeControlPlaneId } = require(path.join(rootDir, '.compiled', 'src', 'shared', 'control-plane-contracts.js'));
  const { BrowserControlPort } = require(path.join(rootDir, '.compiled', 'src', 'main', 'tools', 'browser-control-port.js'));
  const { ControlPlaneRuntime } = require(path.join(rootDir, '.compiled', 'src', 'main', 'control-plane', 'control-plane-runtime.js'));
  const { NativeTabHost } = require(path.join(rootDir, '.compiled', 'src', 'main', 'browser', 'native-tab-host.js'));
  const { BridgeServer } = require(path.join(rootDir, '.compiled', 'src', 'main', 'bridge', 'bridge-server.js'));
  const { getCoreHealthService } = require(path.join(rootDir, '.compiled', 'src', 'main', 'diagnostics', 'core-health.js'));

  const cliArgs = parseArgs(process.argv.slice(2));

  async function executeHarness() {
    const startTime = Date.now();
    console.log(`[OMP-Closed-Loop] Initializing real Electron E2E harness on ${process.platform} (${process.arch})...`);

    let server;
    let mainWindow;
    let tabHost;
    let controlPlane;
    let bridgeServer;
    let mcpProc;
    const samples = [];

    // Ensure report directories exist if requested
    if (cliArgs.jsonlPath) {
      fs.mkdirSync(path.dirname(path.resolve(cliArgs.jsonlPath)), { recursive: true });
    }
    if (cliArgs.reportPath) {
      fs.mkdirSync(path.dirname(path.resolve(cliArgs.reportPath)), { recursive: true });
    }

    try {
      // 1. Start local synthetic storefront server
      const storefrontHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AntiFan E2E Storefront Verification</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; background: #f8fafc; color: #0f172a; }
    #product-card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); width: 360px; }
    h1 { font-size: 20px; margin: 0 0 8px 0; }
    .price { font-size: 18px; font-weight: 600; color: #2563eb; margin: 0 0 16px 0; }
    button { background: #2563eb; color: white; border: none; padding: 10px 18px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; }
    #status-banner { margin-top: 16px; padding: 10px; border-radius: 6px; background: #e0f2fe; color: #0369a1; font-size: 13px; }
  </style>
</head>
<body>
  <div id="product-card">
    <h1 id="product-title">E2E Autonomous Test Storefront</h1>
    <p class="price" id="product-price">250,000 VND</p>
    <button id="add-to-cart">Add to Cart</button>
    <div id="status-banner">Ready for MCP capability inspection and capture</div>
  </div>
  <script>
    window.recordedEvents = [];
    document.getElementById('add-to-cart').addEventListener('click', (e) => {
      window.recordedEvents.push({ type: 'click', isTrusted: e.isTrusted, ts: Date.now() });
      document.getElementById('status-banner').textContent = 'Cart updated';
    });
  </script>
</body>
</html>`;

      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(storefrontHtml);
      });
      const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
      const storefrontUrl = `http://127.0.0.1:${port}/`;

      // 2. Launch BrowserWindow and NativeTabHost
      mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: cliArgs.showWindow,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      tabHost = new NativeTabHost(mainWindow);
      const tabId = tabHost.createTab(storefrontUrl, true);
      tabHost.setAutomationTabId(tabId);

      const targetWc = tabHost.getTabWebContents(tabId);
      if (targetWc) {
        await new Promise((resolve) => {
          if (targetWc.isLoading()) targetWc.once('did-finish-load', () => setTimeout(resolve, 300));
          else setTimeout(resolve, 300);
        });
      }

      // 3. Initialize ControlPlaneRuntime
      const projectId = makeControlPlaneId('project');
      const workspaceId = makeControlPlaneId('workspace');
      controlPlane = new ControlPlaneRuntime({
        dataRoot: tempUserData,
        projectId,
        workspaceId,
        allowEval: false,
        getAutomationTabId: () => tabHost.getAutomationTabId(),
        getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
        resolveTabId: (id) => tabHost.resolveTargetTabId(id),
        resolveFailoverTabId: (id) => tabHost.getFailoverTargetTab(id),
        isTabAllowed: (p, r) => tabHost.isTabAllowedForPrimary(p, r),
      });
      await controlPlane.initialize();

      const browserPort = new BrowserControlPort(tabHost, controlPlane.artifacts);
      tabHost.setControlPlane(controlPlane);
      tabHost.setViewportGate(browserPort.viewportGate);
      controlPlane.registerBrowser(browserPort);

      const session = await controlPlane.createCliSession({
        projectId,
        workspaceId,
        backendId: 'omp-closed-loop-harness',
        tabId,
        grant: 'write',
      });

      // 4. Start BridgeServer
      bridgeServer = new BridgeServer(
        tabHost,
        0,
        false,
        controlPlane.transport,
        undefined,
        controlPlane.runs.attachments,
        '127.0.0.1',
        controlPlane
      );
      bridgeServer.setControlPlane(controlPlane);
      const bridgePort = await bridgeServer.start();
      console.log(`[OMP-Closed-Loop] Bridge server running on port ${bridgePort} (attachment: ${session.launch.attachmentId})`);

      // 5. Spawn real MCP stdio proxy
      const proxyScript = path.resolve(rootDir, 'scripts', 'antifan-omp-mcp.cjs');
      const harnessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('ANTIFAN_'))
      );

      mcpProc = spawn(process.execPath, [proxyScript], {
        env: {
          ...harnessEnv,
          ELECTRON_RUN_AS_NODE: '1',
          ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
            port: bridgePort,
            secret: session.launch.secret,
            attachmentId: session.launch.attachmentId,
            authorityRevision: session.launch.authorityRevision,
            runId: session.run.id,
            attemptId: session.attempt.id,
            projectId,
            workspaceId,
          }),
        },
      });

      mcpProc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg && !cliArgs.quiet) console.log(`[MCP-STDERR] ${msg}`);
      });

      const pendingRequests = new Map();
      let stdoutBuffer = '';
      mcpProc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed && parsed.id !== undefined && pendingRequests.has(parsed.id)) {
              const entry = pendingRequests.get(parsed.id);
              pendingRequests.delete(parsed.id);
              clearTimeout(entry.timer);
              entry.resolve(parsed);
            }
          } catch {}
        }
      });

      function callMcp(id, name, args = {}, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`MCP call '${name}' (id: ${id}) timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          pendingRequests.set(id, { resolve, reject, timer });
          mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
        });
      }

      // Initialize MCP protocol handshake
      mcpProc.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'omp-closed-loop-harness', version: '1.0' } }
      }) + '\n');
      await new Promise((r) => setTimeout(r, 250));

      console.log('[OMP-Closed-Loop] MCP stdio session established.');

      // Determine iteration / duration targets
      let targetDurationMs = null;
      if (cliArgs.minutes) {
        targetDurationMs = cliArgs.minutes * 60 * 1000;
      } else if (cliArgs.durationSeconds) {
        targetDurationMs = cliArgs.durationSeconds * 1000;
      }
      const isTimeBounded = targetDurationMs !== null;
      const targetIterations = isTimeBounded ? Infinity : cliArgs.iterations;
      const deadline = isTimeBounded ? (startTime + targetDurationMs) : Infinity;

      console.log(`[OMP-Closed-Loop] Execution mode: ${isTimeBounded ? `Time-bounded (${(targetDurationMs / 60000).toFixed(2)} min)` : `Iteration-bounded (${targetIterations} cycles)`}`);

      let iteration = 0;
      let rpcId = 100;
      let totalArtifactBytes = 0;

      while (iteration < targetIterations && Date.now() < deadline) {
        iteration += 1;
        const iterStart = performance.now();
        const iterTimestamp = Date.now();

        if (!cliArgs.quiet || iteration === 1) {
          console.log(`\n[OMP-Closed-Loop] === Iteration ${iteration} ===`);
        }

        // --- Step 1: MCP Dispatch ---
        const dispatchT0 = performance.now();
        const screenshotResp = await callMcp(++rpcId, 'anti.screenshot.viewport', { format: 'png' });
        const dispatchMs = performance.now() - dispatchT0;

        // --- Step 2: Capability Execution ---
        assert.equal(screenshotResp.error, undefined, `Iteration ${iteration}: MCP response error must be undefined`);
        assert.equal(screenshotResp.result?.isError, undefined, `Iteration ${iteration}: MCP result.isError must be undefined`);
        const imageContent = screenshotResp.result?.content?.find((c) => c.type === 'image');
        assert.ok(imageContent, `Iteration ${iteration}: Response must contain image content`);
        assert.equal(imageContent.mimeType, 'image/png');
        assert.ok(typeof imageContent.data === 'string' && imageContent.data.length > 500, `Iteration ${iteration}: Image base64 data must be valid`);

        const pngBytes = Buffer.from(imageContent.data, 'base64');
        assert.equal(pngBytes[0], 0x89);
        assert.equal(pngBytes[1], 0x50); // P
        assert.equal(pngBytes[2], 0x4e); // N
        assert.equal(pngBytes[3], 0x47); // G
        totalArtifactBytes += pngBytes.length;

        // --- Step 3: Receipt / Ledger Settles ---
        const ledgerStats = controlPlane.ledger.getStats();
        assert.equal(ledgerStats.inFlightCount, 0, `Iteration ${iteration}: Ledger inFlightCount must be 0 (all settled)`);
        assert.ok(ledgerStats.frameCount >= 2, `Iteration ${iteration}: Ledger frameCount must record claim and settle frames`);

        const receiptStats = controlPlane.receipts.getStats();
        assert.equal(receiptStats.pendingCount, 0, `Iteration ${iteration}: Receipts pendingCount must be 0`);

        // --- Step 4: Evidence Artifact Written ---
        const artifactStats = controlPlane.artifacts.getStats();
        assert.ok(artifactStats.artifactCount >= 1, `Iteration ${iteration}: ArtifactStore must have at least 1 artifact`);
        assert.ok(artifactStats.storedBytes > 0, `Iteration ${iteration}: ArtifactStore storedBytes must be > 0`);

        const artifactsDir = path.join(tempUserData, 'artifacts');
        assert.ok(fs.existsSync(artifactsDir), `Iteration ${iteration}: Artifacts folder must exist on disk`);

        // --- Step 5: Health Surface Reflects It ---
        const resourceStats = controlPlane.getResourceStats();
        assert.ok(resourceStats.artifacts.artifactCount >= 1, `Iteration ${iteration}: ResourceStats must reflect artifacts`);
        assert.equal(resourceStats.invocations.inFlightCount, 0, `Iteration ${iteration}: ResourceStats must reflect settled ledger`);

        const healthSnapshot = await getCoreHealthService().getSnapshot();
        assert.ok(healthSnapshot.status, `Iteration ${iteration}: Health snapshot status must be present`);

        const iterDurationMs = performance.now() - iterStart;
        const memory = process.memoryUsage();

        const sample = {
          iteration,
          timestamp: iterTimestamp,
          isoTime: new Date(iterTimestamp).toISOString(),
          elapsedMs: Math.round(Date.now() - startTime),
          durationMs: Number(iterDurationMs.toFixed(2)),
          status: 'PASS',
          memory: {
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal,
            externalBytes: memory.external,
            rssMb: Number((memory.rss / (1024 * 1024)).toFixed(2)),
            heapUsedMb: Number((memory.heapUsed / (1024 * 1024)).toFixed(2)),
            heapTotalMb: Number((memory.heapTotal / (1024 * 1024)).toFixed(2)),
          },
          artifacts: {
            count: artifactStats.artifactCount,
            storedBytes: artifactStats.storedBytes,
            totalGeneratedBytes: totalArtifactBytes,
          },
          ledger: {
            inFlightCount: ledgerStats.inFlightCount,
            frameCount: ledgerStats.frameCount,
            hotRecordCount: ledgerStats.hotRecordCount,
            persistedBytes: ledgerStats.persistedBytes,
          },
          receipts: {
            receiptCount: receiptStats.receiptCount,
            pendingCount: receiptStats.pendingCount,
          },
          health: {
            status: healthSnapshot.status,
            checksCount: healthSnapshot.checks?.length || 0,
          },
          mcp: {
            dispatchMs: Number(dispatchMs.toFixed(2)),
            imageByteLength: pngBytes.length,
          },
        };

        samples.push(sample);

        // Write sample to JSONL if requested
        if (cliArgs.jsonlPath) {
          fs.appendFileSync(cliArgs.jsonlPath, `${JSON.stringify(sample)}\n`, 'utf8');
        }

        console.log(
          `[OMP-Closed-Loop] Iteration ${iteration} PASS (${iterDurationMs.toFixed(1)}ms): ` +
          `heap=${sample.memory.heapUsedMb}MB, rss=${sample.memory.rssMb}MB, ` +
          `artifacts=${artifactStats.artifactCount}, ledgerInFlight=${ledgerStats.inFlightCount}, health=${healthSnapshot.status}`
        );

        if (cliArgs.intervalMs > 0 && Date.now() < deadline && iteration < targetIterations) {
          await new Promise((r) => setTimeout(r, cliArgs.intervalMs));
        }
      }

      const totalElapsedMs = Date.now() - startTime;
      const initialSample = samples[0];
      const finalSample = samples[samples.length - 1];

      const heapDeltaMb = Number((finalSample.memory.heapUsedMb - initialSample.memory.heapUsedMb).toFixed(2));
      const rssDeltaMb = Number((finalSample.memory.rssMb - initialSample.memory.rssMb).toFixed(2));

      const summary = {
        verdict: 'PASS',
        timestamp: new Date().toISOString(),
        totalIterations: samples.length,
        totalElapsedMs,
        totalElapsedMinutes: Number((totalElapsedMs / 60000).toFixed(2)),
        meanIterationMs: Number((totalElapsedMs / samples.length).toFixed(2)),
        memorySummary: {
          initialHeapMb: initialSample.memory.heapUsedMb,
          finalHeapMb: finalSample.memory.heapUsedMb,
          heapDeltaMb,
          initialRssMb: initialSample.memory.rssMb,
          finalRssMb: finalSample.memory.rssMb,
          rssDeltaMb,
          peakHeapMb: Math.max(...samples.map((s) => s.memory.heapUsedMb)),
          peakRssMb: Math.max(...samples.map((s) => s.memory.rssMb)),
        },
        resourceSummary: {
          finalArtifactCount: finalSample.artifacts.count,
          finalArtifactBytes: finalSample.artifacts.storedBytes,
          finalLedgerFrames: finalSample.ledger.frameCount,
          finalLedgerInFlight: finalSample.ledger.inFlightCount,
        },
        healthSummary: {
          finalHealthStatus: finalSample.health.status,
        },
      };

      if (cliArgs.reportPath) {
        fs.writeFileSync(cliArgs.reportPath, JSON.stringify(summary, null, 2), 'utf8');
        console.log(`[OMP-Closed-Loop] Summary report saved to: ${cliArgs.reportPath}`);
      }

      console.log('\n========================================');
      console.log('OMP CLOSED-LOOP HARNESS VERDICT: PASS');
      console.log(`Completed ${samples.length} iterations in ${(totalElapsedMs / 1000).toFixed(1)}s`);
      console.log(`Heap delta: ${heapDeltaMb >= 0 ? '+' : ''}${heapDeltaMb} MB | RSS delta: ${rssDeltaMb >= 0 ? '+' : ''}${rssDeltaMb} MB`);
      console.log(`Artifacts: ${finalSample.artifacts.count} stored | In-flight ledger: ${finalSample.ledger.inFlightCount}`);
      console.log('========================================\n');

      return summary;
    } finally {
      if (mcpProc) {
        try { mcpProc.stdin.end(); mcpProc.kill(); } catch {}
      }
      if (bridgeServer) {
        try { bridgeServer.dispose(); } catch {}
      }
      if (tabHost) {
        try { tabHost.dispose(); } catch {}
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.destroy(); } catch {}
      }
      if (server) {
        try {
          server.closeAllConnections?.();
          server.close();
        } catch {}
      }
      try {
        fs.rmSync(tempUserData, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {}
    }
  }

  app.whenReady().then(() => {
    executeHarness()
      .then(() => app.exit(0))
      .catch((err) => {
        console.error('[OMP-Closed-Loop FATAL]', err);
        app.exit(1);
      });
  });
}
