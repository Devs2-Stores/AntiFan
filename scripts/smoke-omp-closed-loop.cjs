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
 * Every cycle also drives the defect families the remediation plan fixed
 * (target identity, capture, media freeze, inspection, terminal projection,
 * verification register, args transport and refusal naming). The cycle set is
 * derived from the proxy's live `tools/list` at run time — no tool name or
 * family count is hard-coded, so a surface that loses a namespace fails here
 * instead of passing against a stale list.
 *
 * Every probe carries an explicit expectation (phase 10 R5/R7): `success`
 * (a refusal or error fails the iteration and is counted) or `refused:<CODE>`
 * for deliberate negatives (the refusal must arrive carrying that typed code —
 * a success or a different code fails). A sample that could not read the
 * surface, or whose probe missed its expectation, is a FAILED sample, never a
 * logged pass. Deliberate negatives exercised each cycle: unknown-tool
 * (CAPABILITY_NOT_FOUND), string-args (refused), foreign tabId
 * (TARGET_MISMATCH), and every 60th cycle an induced drain
 * (TARGET_BUSY_DRAINING) produced by the product's own CDP machinery — a
 * sacrificial tab's renderer is wedged, a real sendCdpCommand times out and
 * marks the target draining, and the capture is refused by the drain guard.
 *
 * The register is sampled every cycle: its byte length must be monotone and
 * `anti.verification.list` must equal the parsed on-disk record count. That
 * surface declares no ambient target field, so the proxy never injects a tabId
 * into the harness's call (`{}`) and no scoped reading is legitimate: a
 * totalCount below the on-disk count is a register divergence, full stop.
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

// ─── Probe expectation model (phase 10 R5/R7) ────────────────────────────────
// Every probe declares what a healthy surface must do; a call that does not
// meet its expectation fails the iteration and is counted — a refusal can never
// pass silently again.
//   'success'        — the call must succeed; any refusal/error fails.
//   'refused'        — the call must be refused; any code class passes, a
//                      success fails.
//   'refused:<CODE>' — the call must be refused carrying exactly that typed
//                      code; a success or a different code fails.
function evaluateProbeOutcome(expect, outcome) {
  const text = (outcome && outcome.text) || '';
  if (expect === 'success') {
    return outcome && outcome.ok
      ? { pass: true }
      : { pass: false, reason: `expected success, call refused (${(outcome && outcome.code) || 'NO_CODE'}): ${text}` };
  }
  if (expect === 'refused') {
    return outcome && !outcome.ok
      ? { pass: true }
      : { pass: false, reason: 'expected a refusal, call succeeded' };
  }
  const match = /^refused:([A-Z0-9_]+)$/.exec(expect || '');
  if (match) {
    const wanted = match[1];
    if (outcome && outcome.ok) {
      return { pass: false, reason: `expected refusal ${wanted}, call succeeded` };
    }
    if (!outcome || outcome.code !== wanted) {
      return { pass: false, reason: `expected refusal ${wanted}, got ${(outcome && outcome.code) || 'NO_CODE'}: ${text}` };
    }
    return { pass: true };
  }
  return { pass: false, reason: `unknown probe expectation '${expect}'` };
}

// Normalize one tools/call response into { ok, code, text }. The proxy relays a
// refused dispatch as isError content whose text is either a JSON envelope
// ({code, message}) or the bridge's `CODE: message` string — both carry the
// typed code, and both are extracted here so expectations can name it.
function describeToolResult(resp) {
  if (!resp || resp.result === undefined) {
    const rpcError = resp && resp.error !== undefined ? JSON.stringify(resp.error) : null;
    return {
      ok: false,
      code: rpcError ? 'RPC_ERROR' : 'NO_RESULT',
      text: (rpcError || JSON.stringify(resp || {})).slice(0, 400),
    };
  }
  const result = resp.result;
  const text = Array.isArray(result.content)
    ? result.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n')
    : '';
  if (result.isError) {
    let code = null;
    try {
      const parsed = JSON.parse(text);
      code = parsed && (parsed.code || (parsed.error && parsed.error.code)) || null;
    } catch {
      code = null;
    }
    if (!code) {
      const prefixed = /^([A-Z][A-Z0-9_]{2,})\s*:/.exec(text.trim());
      if (prefixed) code = prefixed[1];
    }
    return { ok: false, code: code || 'UNSTRUCTURED_ERROR', text: text.slice(0, 400) };
  }
  return { ok: true, structured: result.structuredContent !== undefined, text: text.slice(0, 200) };
}

if (require.main === module) {
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
}

module.exports = { evaluateProbeOutcome, describeToolResult };

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
  const { StorageLocations } = require(path.join(rootDir, '.compiled', 'src', 'main', 'config', 'storage-locations.js'));
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

      function callRpc(id, method, params = {}, timeoutMs = 20000, label = method) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`MCP '${label}' (id: ${id}) timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          pendingRequests.set(id, { resolve, reject, timer });
          mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      }

      function callMcp(id, name, args = {}, timeoutMs = 20000) {
        return callRpc(id, 'tools/call', { name, arguments: args }, timeoutMs, name);
      }

      // A call whose arguments are a JSON string instead of an object: the exact
      // shape that reached the server as `[object Object]`/unterminated JSON when
      // the caller rode a text-device write. Refused with a typed error, never a
      // crash and never a silent coercion.
      function callMcpStringArgs(id, name, argsJson, timeoutMs = 20000) {
        return callRpc(id, 'tools/call', { name, arguments: argsJson }, timeoutMs, `${name} (string args)`);
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

      // ---------------------------------------------------------------
      // Scenario matrix (phase 10 R2). The cycle set is derived from what
      // the proxy advertises right now — a tool list or a family count
      // hard-coded here would pass while the surface it describes is gone.
      // ---------------------------------------------------------------
      const catalogueResp = await callRpc(++rpcId, 'tools/list', {}, 20000, 'tools/list');
      assert.equal(catalogueResp.error, undefined, 'tools/list must not fail');
      const catalogueEntries = Array.isArray(catalogueResp.result?.tools) ? catalogueResp.result.tools : [];
      const catalogueTools = catalogueEntries.map((t) => t && t.name).filter((n) => typeof n === 'string');
      assert.ok(
        catalogueTools.length >= 20,
        `advertised catalogue must carry the AntiFan surface (got ${catalogueTools.length} tools)`
      );
      const toolSchemas = new Map(catalogueEntries.filter((t) => t && t.name).map((t) => [t.name, t.inputSchema || {}]));

      const pickTool = (patterns) => catalogueTools.find((n) => patterns.some((p) => p.test(n))) || null;

      const FAMILY_SPECS = [
        { id: 'target_identity', required: true, patterns: [/tabs[._-]?list/i, /get[._-]?viewport/i], args: () => ({}) },
        { id: 'capture_viewport', required: true, patterns: [/screenshot[._-]?viewport/i], args: () => ({ format: 'png' }) },
        { id: 'capture_full_page', required: true, patterns: [/screenshot[._-]?full[._-]?page/i], args: () => ({ format: 'png' }) },
        { id: 'media_freeze', required: true, patterns: [/media[._-]?freeze/i], args: () => ({ freeze: true }) },
        { id: 'inspect', required: true, patterns: [/inspect[._-]?snapshot/i, /inspect[._-]?page[._-]?inventory/i, /inspect[._-]?dom/i], args: () => ({}) },
        // Read-only terminal projections only: create/write/close would mutate the
        // harness's own session pool every cycle and measure nothing the plan fixed.
        { id: 'terminal', required: true, patterns: [/terminal[._-]?(list|snapshot|transcript|read|status)/i], args: () => ({}) },
        { id: 'register', required: true, patterns: [/verification[._-]?list/i], args: () => ({}) },
        // Adoption/release is a two-step scenario (create then close), driven
        // separately below; it is advertised here only as a coverage requirement.
        { id: 'quota', required: true, mutating: true, patterns: [/tabs[._-]?create/i], args: () => ({}) },
        { id: 'visual_compare', required: false, everyN: 10, patterns: [/visual[._-]?compare/i], args: () => ({}) },
      ];

      const familyMatrix = FAMILY_SPECS.map((spec) => {
        const tools = catalogueTools.filter((n) => spec.patterns.some((p) => p.test(n)));
        return {
          id: spec.id,
          required: spec.required,
          mutating: Boolean(spec.mutating),
          everyN: spec.everyN || 1,
          tools,
          tool: tools[0] || null,
          args: spec.args,
        };
      });
      const closeTabTool = pickTool([/tabs[._-]?close/i]);
      const missingFamilies = familyMatrix.filter((f) => f.required && !f.tool).map((f) => f.id);
      assert.equal(
        missingFamilies.length,
        0,
        `advertised surface is missing required defect families: ${missingFamilies.join(', ')}`
      );

      // Arguments for a probed tool are synthesized from its advertised schema,
      // then overridden where the family needs a specific safe value.
      function synthesizeArgs(name, overrides = {}) {
        const schema = toolSchemas.get(name) || {};
        const props = schema.properties || {};
        const required = Array.isArray(schema.required) ? schema.required : [];
        const args = {};
        for (const key of required) {
          const spec = props[key] || {};
          if (Array.isArray(spec.enum) && spec.enum.length > 0) args[key] = spec.enum[0];
          else if (spec.type === 'array') args[key] = [];
          else if (spec.type === 'object') args[key] = {};
          else if (spec.type === 'boolean') args[key] = false;
          else if (spec.type === 'number' || spec.type === 'integer') args[key] = 0;
          else args[key] = 'soak';
        }
        return { ...args, ...overrides };
      }

      // describeToolResult is the module-level normalizer (shared with the
      // runner's --selfcheck): it extracts the typed code from both JSON
      // envelopes and `CODE: message` refusal strings.

      const catalogueSummary = {
        advertised: catalogueTools.length,
        families: Object.fromEntries(familyMatrix.map((f) => [f.id, { tool: f.tool, candidates: f.tools.length, required: f.required }])),
      };
      console.log(
        `[OMP-Closed-Loop] Catalogue: ${catalogueTools.length} tools | families: ` +
        familyMatrix.map((f) => `${f.id}=${f.tool || 'MISSING'}`).join(', ')
      );

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
      let lastRegisterBytes = 0;

      // Per-iteration failure ledger (phase 10 R5/R7): a sample that could not
      // read the surface, or whose probe missed its expectation, is a FAILED
      // sample — recorded, counted, and never silently passed. Structural
      // asserts before the loop stay fatal; inside the loop every check feeds
      // this ledger so one bad cycle cannot abort the evidence window.
      const iterationFailures = [];
      const recordFailure = (checkId, detail) => {
        const entry = { check: checkId, detail: String(detail).slice(0, 500) };
        iterationFailures.push(entry);
        console.log(`[OMP-Closed-Loop] Iteration ${iteration} FAIL [${checkId}]: ${entry.detail}`);
      };
      const check = (checkId, condition, detail) => {
        if (!condition) recordFailure(checkId, detail);
        return Boolean(condition);
      };
      const checkExpectation = (checkId, expect, outcome, label) => {
        const verdict = evaluateProbeOutcome(expect, outcome);
        if (!verdict.pass) recordFailure(checkId, `${label}: ${verdict.reason}`);
        return verdict;
      };
      while (iteration < targetIterations && Date.now() < deadline) {
        iteration += 1;
        const iterStart = performance.now();
        const iterTimestamp = Date.now();

        if (!cliArgs.quiet || iteration === 1) {
          console.log(`\n[OMP-Closed-Loop] === Iteration ${iteration} ===`);
        }

        // --- Step 1: MCP Dispatch ---
        const dispatchT0 = performance.now();
        let screenshotResp = null;
        try {
          screenshotResp = await callMcp(++rpcId, 'anti.screenshot.viewport', { format: 'png' });
        } catch (err) {
          recordFailure('dispatch.screenshot_viewport', `call threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        const dispatchMs = performance.now() - dispatchT0;

        // --- Step 2: Capability Execution ---
        // The dispatch probe expects success: a refusal or malformed envelope is
        // a failed sample, never a logged pass.
        const dispatchOutcome = describeToolResult(screenshotResp);
        checkExpectation('dispatch.screenshot_viewport', 'success', dispatchOutcome, 'anti.screenshot.viewport');
        const imageContent = screenshotResp?.result?.content?.find((c) => c.type === 'image');
        let pngBytes = null;
        if (check('dispatch.screenshot_viewport.image', Boolean(imageContent), `response carried no image content: ${dispatchOutcome.text}`)) {
          check('dispatch.screenshot_viewport.mime', imageContent.mimeType === 'image/png', `image mimeType was ${imageContent.mimeType}`);
          if (check('dispatch.screenshot_viewport.payload', typeof imageContent.data === 'string' && imageContent.data.length > 500, `image base64 payload invalid (${typeof imageContent.data === 'string' ? imageContent.data.length : 'missing'} bytes)`)) {
            pngBytes = Buffer.from(imageContent.data, 'base64');
            check(
              'dispatch.screenshot_viewport.png_magic',
              pngBytes.length > 4 && pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47,
              'image payload is not a PNG (bad magic bytes)'
            );
            totalArtifactBytes += pngBytes.length;
          }
        }

        // --- Step 2b: Defect-family rotation (phase 10 R2) ---
        // One representative call per family each cycle, rotated across every
        // candidate the catalogue advertises so the whole surface is exercised.
        const familyResults = {};
        for (let f = 0; f < familyMatrix.length; f += 1) {
          const family = familyMatrix[f];
          if (!family.tool) {
            familyResults[family.id] = { ok: true, skipped: 'not advertised (optional)' };
            continue;
          }
          if (family.mutating) {
            familyResults[family.id] = { ok: true, tool: family.tool, skipped: 'driven as its own scenario' };
            continue;
          }
          if (iteration % family.everyN !== 0) {
            familyResults[family.id] = { ok: true, tool: family.tool, skipped: `every ${family.everyN} cycles` };
            continue;
          }
          const toolName = family.tools[iteration % family.tools.length];
          const familyArgs = synthesizeArgs(toolName, family.args());
          const t0 = performance.now();
          let resp = null;
          try {
            resp = await callMcp(++rpcId, toolName, familyArgs, 30000);
          } catch (err) {
            resp = { error: String(err instanceof Error ? err.message : err) };
          }
          const outcome = describeToolResult(resp);
          // Every family probe expects success: a refusal is a failed sample,
          // counted — a 100%-refused family can never read as 0 failures again.
          const verdict = checkExpectation(`family.${family.id}`, 'success', outcome, `${family.id} via ${toolName}`);
          familyResults[family.id] = {
            tool: toolName,
            expect: 'success',
            ok: verdict.pass,
            callOk: outcome.ok,
            code: outcome.code || null,
            text: outcome.text,
            ms: Number((performance.now() - t0).toFixed(1)),
          };
          check(
            `family.${family.id}.hygiene.mcp_prefix`,
            !/mcp__mcp__/.test(outcome.text || ''),
            `family '${family.id}' refusal doubled the mcp__ prefix: ${outcome.text}`
          );
          check(
            `family.${family.id}.hygiene.object_object`,
            !/\[object Object\]/.test(outcome.text || ''),
            `family '${family.id}' refusal leaked [object Object]`
          );
        }

        // --- Step 2c: Transport refusals (args transport + name resolution) ---
        // Deliberate negatives: each must arrive refused with its typed code, or
        // the iteration fails — a refusal that never arrives is not evidence of
        // enforcement.
        const unknownToolName = `anti.soak.probe.missing_${iteration}`;
        let unknownResp = null;
        try {
          unknownResp = await callMcp(++rpcId, unknownToolName, {});
        } catch (err) {
          unknownResp = { error: String(err instanceof Error ? err.message : err) };
        }
        const unknownOutcome = describeToolResult(unknownResp);
        const unknownVerdict = checkExpectation(
          'transport.unknown_tool',
          'refused:CAPABILITY_NOT_FOUND',
          unknownOutcome,
          `unknown tool '${unknownToolName}'`
        );
        const unknownText = JSON.stringify(unknownResp?.result ?? unknownResp?.error ?? {});
        check(
          'transport.unknown_tool.hygiene.mcp_prefix',
          !/mcp__mcp__/.test(unknownText),
          `unknown-tool refusal doubled the mcp__ prefix: ${unknownText}`
        );
        check(
          'transport.unknown_tool.hygiene.xd_path',
          !/xd:\/\//.test(unknownText),
          `unknown-tool refusal leaked an xd:// path: ${unknownText}`
        );
        familyResults.transport_unknown_tool = {
          tool: unknownToolName,
          expect: 'refused:CAPABILITY_NOT_FOUND',
          ok: unknownVerdict.pass,
          callOk: unknownOutcome.ok,
          code: unknownOutcome.code || null,
        };

        const stringArgsTarget = familyMatrix.find((fm) => fm.tool && fm.id === 'register')?.tool
          || familyMatrix.find((fm) => fm.tool)?.tool;
        let stringArgsResp = null;
        try {
          stringArgsResp = await callMcpStringArgs(++rpcId, stringArgsTarget, '{}');
        } catch (err) {
          stringArgsResp = { error: String(err instanceof Error ? err.message : err) };
        }
        const stringArgsOutcome = describeToolResult(stringArgsResp);
        const stringArgsVerdict = checkExpectation(
          'transport.string_args',
          'refused',
          stringArgsOutcome,
          `string-args call to ${stringArgsTarget}`
        );
        const stringArgsText = JSON.stringify(stringArgsResp?.result ?? stringArgsResp?.error ?? {});
        check(
          'transport.string_args.hygiene.object_object',
          !/\[object Object\]/.test(stringArgsText),
          `string-args refusal leaked [object Object]: ${stringArgsText}`
        );
        const transport = {
          unknownTool: /No such tool|not found|unknown/i.test(unknownText) ? 'named' : 'unnamed',
          stringArgs: /expects a JSON args object as content/.test(stringArgsText) ? 'absorbed' : 'refused',
        };
        check(
          'transport.string_args.not_absorbed',
          transport.stringArgs === 'refused',
          `string args must be refused, not absorbed: ${stringArgsText}`
        );
        familyResults.transport_string_args = {
          tool: stringArgsTarget,
          expect: 'refused',
          ok: stringArgsVerdict.pass && transport.stringArgs === 'refused',
          callOk: stringArgsOutcome.ok,
          code: stringArgsOutcome.code || null,
        };

        // --- Step 2c-ter: Foreign-tabId refusal (phase 10 R4 evidence) ---
        // A tab id this session does not own must be refused with the typed
        // mismatch code — TARGET_MISMATCH=0 in the counters then means the
        // refusal was exercised and held, not that it was never probed.
        const foreignTabIdTool = pickTool([/tabs[._-]?activate/i]) || closeTabTool;
        if (foreignTabIdTool) {
          const foreignTabId = `tab-foreign-${iteration}-not-owned`;
          const foreignSchema = toolSchemas.get(foreignTabIdTool) || {};
          const foreignProps = foreignSchema.properties || {};
          const foreignRequired = Array.isArray(foreignSchema.required) ? foreignSchema.required : [];
          const foreignArgs = synthesizeArgs(foreignTabIdTool);
          const foreignKey = ['tabId', 'targetId', 'id'].find(
            (key) => foreignRequired.includes(key) || Object.prototype.hasOwnProperty.call(foreignProps, key)
          );
          if (foreignKey) foreignArgs[foreignKey] = foreignTabId;
          const foreignT0 = performance.now();
          let foreignResp = null;
          try {
            foreignResp = await callMcp(++rpcId, foreignTabIdTool, foreignArgs, 30000);
          } catch (err) {
            foreignResp = { error: String(err instanceof Error ? err.message : err) };
          }
          const foreignOutcome = describeToolResult(foreignResp);
          const foreignVerdict = checkExpectation(
            'foreign_tabid',
            'refused:TARGET_MISMATCH',
            foreignOutcome,
            `${foreignTabIdTool} with foreign tabId '${foreignTabId}'`
          );
          familyResults.foreign_tabid = {
            tool: foreignTabIdTool,
            expect: 'refused:TARGET_MISMATCH',
            ok: foreignVerdict.pass,
            callOk: foreignOutcome.ok,
            code: foreignOutcome.code || null,
            ms: Number((performance.now() - foreignT0).toFixed(1)),
          };
        }

        // --- Step 2c-bis: Quota adoption/release (phase 8 R4) ---
        // A session that creates a tab must get its slot back when that tab
        // closes: repeated adopt→release cycles never exhaust the cap.
        const quotaFamily = familyMatrix.find((fm) => fm.id === 'quota');
        if (quotaFamily && quotaFamily.tool && closeTabTool && iteration % 5 === 0) {
          // Only set keys the advertised schema actually carries: an unknown key
          // can be refused outright, and a wrong one silently targets nothing.
          const createSchemaProps = (toolSchemas.get(quotaFamily.tool) || {}).properties || {};
          const createArgs = synthesizeArgs(quotaFamily.tool);
          if (Object.prototype.hasOwnProperty.call(createSchemaProps, 'activate')) createArgs.activate = false;
          if (Object.prototype.hasOwnProperty.call(createSchemaProps, 'url')) createArgs.url = 'about:blank';
          let createResp = null;
          try {
            createResp = await callMcp(++rpcId, quotaFamily.tool, createArgs, 30000);
          } catch (err) {
            createResp = { error: String(err instanceof Error ? err.message : err) };
          }
          const createOutcome = describeToolResult(createResp);
          let createdTabId = null;
          if (createOutcome.ok) {
            const structured = createResp.result?.structuredContent;
            const text = (createResp.result?.content || []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
            const candidates = [structured?.tabId, structured?.id, structured?.tab?.id];
            createdTabId = candidates.find((v) => typeof v === 'string' && v.length > 0) || null;
            if (!createdTabId) {
              try {
                const parsed = JSON.parse(text);
                const fromText = [parsed?.tabId, parsed?.id, parsed?.tab?.id].find((v) => typeof v === 'string' && v.length > 0);
                createdTabId = fromText || null;
              } catch {}
            }
          } else {
            // A refusal here must be self-diagnosing (phase 8 R3): used/limit + noun.
            check(
              'quota.refusal_diagnosis',
              /used|limit/i.test(createOutcome.text || ''),
              `tab adoption refusal does not name used/limit: ${createOutcome.text}`
            );
          }
          let releasedTabId = null;
          if (createdTabId) {
            const closeSchema = toolSchemas.get(closeTabTool) || {};
            const closeProps = closeSchema.properties || {};
            const closeRequired = Array.isArray(closeSchema.required) ? closeSchema.required : [];
            const closeArgs = synthesizeArgs(closeTabTool);
            const targetKey = ['tabId', 'targetId', 'id'].find(
              (key) => closeRequired.includes(key) || Object.prototype.hasOwnProperty.call(closeProps, key)
            );
            if (targetKey) closeArgs[targetKey] = createdTabId;
            let closeResp = null;
            try {
              closeResp = await callMcp(++rpcId, closeTabTool, closeArgs, 30000);
            } catch (err) {
              closeResp = { error: String(err instanceof Error ? err.message : err) };
            }
            const closeOutcome = describeToolResult(closeResp);
            releasedTabId = closeOutcome.ok ? createdTabId : null;
          }
          const createVerdict = checkExpectation(
            'quota.create',
            'success',
            createOutcome,
            `adopt→release create via ${quotaFamily.tool}`
          );
          check(
            'quota.release',
            Boolean(releasedTabId),
            `adopt→release scenario created ${createdTabId} but could not close it`
          );
          familyResults.quota = {
            tool: quotaFamily.tool,
            expect: 'success',
            ok: createVerdict.pass && Boolean(releasedTabId),
            callOk: createOutcome.ok,
            code: createOutcome.code || null,
            ms: null,
            created: Boolean(createdTabId),
            released: Boolean(releasedTabId),
          };
        }

        // --- Step 2c-quat: Induced drain refusal (phase 4 taxonomy, phase 10 R2) ---
        // A capture against a target whose CDP transport is draining must return
        // the typed TARGET_BUSY_DRAINING code — never a generic failure and
        // never NO_RENDER_SURFACE. The drain is induced with the product's own
        // machinery: a sacrificial session tab's renderer is wedged, a real
        // sendCdpCommand is allowed to time out (which marks the target
        // draining), and the capture is then refused by the drain guard.
        // A close-race cannot produce this deterministically — destroying the
        // WebContents settles or kills the in-flight command instead of leaving
        // it draining — so the wedge is the honest induction path.
        const drainEveryN = 60;
        if (quotaFamily && quotaFamily.tool && iteration % drainEveryN === 0) {
          const drainT0 = performance.now();
          let drainTabId = null;
          let drainOutcome = { ok: false, code: 'SETUP_FAILED', text: 'drain probe did not run' };
          try {
            const drainCreateProps = (toolSchemas.get(quotaFamily.tool) || {}).properties || {};
            const drainCreateArgs = synthesizeArgs(quotaFamily.tool);
            if (Object.prototype.hasOwnProperty.call(drainCreateProps, 'activate')) drainCreateArgs.activate = false;
            if (Object.prototype.hasOwnProperty.call(drainCreateProps, 'url')) drainCreateArgs.url = 'about:blank';
            let drainCreateResp = null;
            try {
              drainCreateResp = await callMcp(++rpcId, quotaFamily.tool, drainCreateArgs, 30000);
            } catch (err) {
              drainCreateResp = { error: String(err instanceof Error ? err.message : err) };
            }
            const drainCreateOutcome = describeToolResult(drainCreateResp);
            if (drainCreateOutcome.ok) {
              const structured = drainCreateResp.result?.structuredContent;
              const text = (drainCreateResp.result?.content || []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
              const candidates = [structured?.tabId, structured?.id, structured?.tab?.id];
              drainTabId = candidates.find((v) => typeof v === 'string' && v.length > 0) || null;
              if (!drainTabId) {
                try {
                  const parsed = JSON.parse(text);
                  drainTabId = [parsed?.tabId, parsed?.id, parsed?.tab?.id].find((v) => typeof v === 'string' && v.length > 0) || null;
                } catch {}
              }
            }
            if (!drainTabId) {
              drainOutcome = { ok: false, code: 'SETUP_FAILED', text: `sacrificial tab create failed: ${drainCreateOutcome.code} ${drainCreateOutcome.text}` };
            } else {
              const drainWc = tabHost.getTabWebContents(drainTabId);
              if (!drainWc || drainWc.isDestroyed()) {
                drainOutcome = { ok: false, code: 'SETUP_FAILED', text: `sacrificial tab '${drainTabId}' has no live webContents` };
              } else {
                // Wedge the renderer's main thread for real — no mock: every
                // renderer-scoped CDP command now hangs.
                drainWc.executeJavaScript('while (true) {}').catch(() => {});
                await new Promise((r) => setTimeout(r, 150));
                // Drive one real command through the product's CDP transport at a
                // short bound; its timeout marks the target draining.
                try {
                  await tabHost.getDevToolsHost().sendCdpCommand(drainWc, 'Runtime.evaluate', { expression: '1', returnByValue: true }, 400);
                } catch {}
                const draining = typeof tabHost.getDevToolsHost().isTargetDraining === 'function'
                  ? tabHost.getDevToolsHost().isTargetDraining(drainTabId)
                  : null;
                if (draining !== true) {
                  drainOutcome = { ok: false, code: 'SETUP_FAILED', text: `drain inducer did not leave target '${drainTabId}' draining (isTargetDraining=${draining})` };
                } else {
                  const drainCallT0 = performance.now();
                  let drainResp = null;
                  try {
                    drainResp = await callMcp(++rpcId, 'anti.screenshot.full_page', { tabId: drainTabId }, 30000);
                  } catch (err) {
                    drainResp = { error: String(err instanceof Error ? err.message : err) };
                  }
                  drainOutcome = describeToolResult(drainResp);
                  drainOutcome.ms = Number((performance.now() - drainCallT0).toFixed(1));
                }
              }
            }
          } finally {
            if (drainTabId) {
              try { tabHost.closeTab(drainTabId); } catch {}
            }
          }
          const drainVerdict = checkExpectation(
            'drain_refusal',
            'refused:TARGET_BUSY_DRAINING',
            drainOutcome,
            'anti.screenshot.full_page on draining target'
          );
          familyResults.drain_refusal = {
            tool: 'anti.screenshot.full_page',
            expect: 'refused:TARGET_BUSY_DRAINING',
            ok: drainVerdict.pass,
            callOk: drainOutcome.ok,
            code: drainOutcome.code || null,
            text: drainOutcome.text,
            ms: drainOutcome.ms ?? Number((performance.now() - drainT0).toFixed(1)),
          };
        }

        // --- Step 2d: Failure taxonomy consistency ---
        // Code and message must not describe different failures (audit: 62
        // NO_RENDER_SURFACE refusals whose message read TARGET_BUSY_DRAINING).
        for (const [familyId, outcome] of Object.entries(familyResults)) {
          const text = outcome.text || '';
          if (outcome.code === 'NO_RENDER_SURFACE') {
            check(
              `taxonomy.${familyId}.no_drain_message`,
              !/TARGET_BUSY_DRAINING/.test(text),
              `${familyId} carried code NO_RENDER_SURFACE with a TARGET_BUSY_DRAINING message: ${text}`
            );
          }
          if (/TARGET_BUSY_DRAINING/.test(text)) {
            check(
              `taxonomy.${familyId}.drain_code`,
              outcome.code === 'TARGET_BUSY_DRAINING',
              `${familyId} message named TARGET_BUSY_DRAINING while code was ${outcome.code}`
            );
          }
        }

        // --- Step 2e: Register integrity (phase 10 R5.1/R5.2 in-harness) ---
        // The register is disk-authoritative: it must never shrink, and the surface
        // count must equal the parsed on-disk record count every cycle. The called
        // surface takes tabId as a filter and declares no ambient target field, so
        // the proxy injects nothing into this call and no scoped reading is
        // legitimate — a count below the on-disk count is a register divergence.
        const registerFile = path.join(StorageLocations.getDataRoot(), 'issues', 'verification-register.jsonl');
        let registerBytes = 0;
        let registerRecordCount = 0;
        if (fs.existsSync(registerFile)) {
          const rawRegister = fs.readFileSync(registerFile, 'utf8');
          registerBytes = Buffer.byteLength(rawRegister, 'utf8');
          for (const line of rawRegister.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
              JSON.parse(trimmed);
              registerRecordCount += 1;
            } catch {}
          }
        }
        check(
          'register.monotone',
          registerBytes >= lastRegisterBytes,
          `verification register shrank (${lastRegisterBytes} -> ${registerBytes} bytes)`
        );
        lastRegisterBytes = registerBytes;

        const registerToolName = familyMatrix.find((fm) => fm.id === 'register')?.tool;
        let listResp = null;
        if (registerToolName) {
          try {
            listResp = await callMcp(++rpcId, registerToolName, {});
          } catch (err) {
            listResp = { error: String(err instanceof Error ? err.message : err) };
          }
        }
        const listOutcome = listResp ? describeToolResult(listResp) : null;
        // The surface read itself is an expectation: a refused or unreadable
        // register surface is a FAILED sample, never a skipped check.
        let reportedCount = null;
        let registerCheck = 'unreadable';
        if (!registerToolName) {
          recordFailure('register.surface', 'no verification-list tool advertised');
        } else if (!listOutcome || !listOutcome.ok) {
          recordFailure('register.surface', `verification list refused (${(listOutcome && listOutcome.code) || 'NO_RESULT'}): ${(listOutcome && listOutcome.text) || ''}`);
        } else {
          const structured = listResp.result?.structuredContent;
          if (structured && typeof structured.totalCount === 'number') {
            reportedCount = structured.totalCount;
          } else {
            // Text-only payloads are the MCP default; parse the full body, not the
            // truncated preview held in the sample.
            const fullText = Array.isArray(listResp.result?.content)
              ? listResp.result.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
              : '';
            try {
              const parsed = JSON.parse(fullText);
              if (parsed && typeof parsed.totalCount === 'number') reportedCount = parsed.totalCount;
            } catch {}
          }
          if (reportedCount === null) {
            recordFailure('register.surface', 'verification list returned no totalCount');
          } else if (reportedCount === registerRecordCount) {
            registerCheck = 'match';
          } else {
            registerCheck = 'diverged';
            recordFailure(
              'register.count',
              `verification surface totalCount (${reportedCount}) != on-disk records (${registerRecordCount})`
            );
          }
        }

        // --- Step 3: Receipt / Ledger Settles ---
        const ledgerStats = controlPlane.ledger.getStats();
        check('ledger.inflight', ledgerStats.inFlightCount === 0, `Ledger inFlightCount must be 0 (all settled), got ${ledgerStats.inFlightCount}`);
        check('ledger.frames', ledgerStats.frameCount >= 2, `Ledger frameCount must record claim and settle frames, got ${ledgerStats.frameCount}`);

        const receiptStats = controlPlane.receipts.getStats();
        check('receipts.pending', receiptStats.pendingCount === 0, `Receipts pendingCount must be 0, got ${receiptStats.pendingCount}`);

        // --- Step 4: Evidence Artifact Written ---
        const artifactStats = controlPlane.artifacts.getStats();
        check('artifacts.count', artifactStats.artifactCount >= 1, `ArtifactStore must have at least 1 artifact, got ${artifactStats.artifactCount}`);
        check('artifacts.bytes', artifactStats.storedBytes > 0, `ArtifactStore storedBytes must be > 0, got ${artifactStats.storedBytes}`);

        const artifactsDir = path.join(tempUserData, 'artifacts');
        check('artifacts.dir', fs.existsSync(artifactsDir), 'Artifacts folder must exist on disk');

        // --- Step 5: Health Surface Reflects It ---
        const resourceStats = controlPlane.getResourceStats();
        check('health.artifacts', resourceStats.artifacts.artifactCount >= 1, `ResourceStats must reflect artifacts, got ${resourceStats.artifacts.artifactCount}`);
        check('health.inflight', resourceStats.invocations.inFlightCount === 0, `ResourceStats must reflect settled ledger, got ${resourceStats.invocations.inFlightCount}`);

        const healthSnapshot = await getCoreHealthService().getSnapshot();
        check('health.status', Boolean(healthSnapshot.status), 'Health snapshot status must be present');

        const iterDurationMs = performance.now() - iterStart;
        const memory = process.memoryUsage();

        const sample = {
          iteration,
          timestamp: iterTimestamp,
          isoTime: new Date(iterTimestamp).toISOString(),
          elapsedMs: Math.round(Date.now() - startTime),
          durationMs: Number(iterDurationMs.toFixed(2)),
          status: iterationFailures.length === 0 ? 'PASS' : 'FAIL',
          failures: iterationFailures.slice(),
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
            imageByteLength: pngBytes ? pngBytes.length : 0,
          },
          catalogue: catalogueSummary,
          families: familyResults,
          transport,
          register: {
            bytes: registerBytes,
            records: registerRecordCount,
            surfaceCount: reportedCount,
            check: registerCheck,
          },
        };

        samples.push(sample);

        // Write sample to JSONL if requested
        if (cliArgs.jsonlPath) {
          fs.appendFileSync(cliArgs.jsonlPath, `${JSON.stringify(sample)}\n`, 'utf8');
        }

        console.log(
          `[OMP-Closed-Loop] Iteration ${iteration} ${sample.status} (${iterDurationMs.toFixed(1)}ms): ` +
          `heap=${sample.memory.heapUsedMb}MB, rss=${sample.memory.rssMb}MB, ` +
          `artifacts=${artifactStats.artifactCount}, ledgerInFlight=${ledgerStats.inFlightCount}, health=${healthSnapshot.status}` +
          (iterationFailures.length > 0 ? ` | failures=${iterationFailures.length}` : '')
        );
        iterationFailures.length = 0;

        if (cliArgs.intervalMs > 0 && Date.now() < deadline && iteration < targetIterations) {
          await new Promise((r) => setTimeout(r, cliArgs.intervalMs));
        }
      }

      const totalElapsedMs = Date.now() - startTime;
      const initialSample = samples[0];
      const finalSample = samples[samples.length - 1];

      const heapDeltaMb = Number((finalSample.memory.heapUsedMb - initialSample.memory.heapUsedMb).toFixed(2));
      const rssDeltaMb = Number((finalSample.memory.rssMb - initialSample.memory.rssMb).toFixed(2));

      const familyTally = {};
      for (const s of samples) {
        for (const [id, outcome] of Object.entries(s.families || {})) {
          if (outcome.skipped && !outcome.ms) continue;
          const entry = familyTally[id] || (familyTally[id] = { tool: outcome.tool || null, expect: outcome.expect || null, calls: 0, ok: 0, refused: 0, codes: {} });
          if (outcome.tool && !entry.tool) entry.tool = outcome.tool;
          if (outcome.expect && !entry.expect) entry.expect = outcome.expect;
          entry.calls += 1;
          if (outcome.ok) entry.ok += 1;
          else {
            entry.refused += 1;
            const code = outcome.code || 'UNKNOWN';
            entry.codes[code] = (entry.codes[code] || 0) + 1;
          }
        }
      }
      const transportTally = samples.reduce((acc, s) => {
        const key = s.transport ? `${s.transport.unknownTool}/${s.transport.stringArgs}` : 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const failedSamples = samples.filter((s) => s.status !== 'PASS');
      const registerCheckCounts = samples.reduce((acc, s) => {
        const key = s.register && s.register.check ? s.register.check : 'unreadable';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const registerSummary = {
        firstBytes: initialSample.register.bytes,
        lastBytes: finalSample.register.bytes,
        monotone: samples.every((s, i) => i === 0 || s.register.bytes >= samples[i - 1].register.bytes),
        lastRecordCount: finalSample.register.records,
        // 'match' = surface count equalled the full on-disk count;
        // 'diverged'/'unreadable' = real failures already counted per sample.
        // No scoped reading is legitimate here (see Step 2e), so 'match' is the
        // only state that may certify the surface.
        checkCounts: registerCheckCounts,
        surfaceCountMatchesDisk: samples.every((s) => s.register.check === 'match'),
      };

      const summary = {
        verdict: failedSamples.length === 0 ? 'PASS' : 'FAIL',
        timestamp: new Date().toISOString(),
        totalIterations: samples.length,
        failedIterations: failedSamples.length,
        failedChecks: failedSamples.reduce((acc, s) => acc + (Array.isArray(s.failures) ? s.failures.length : 0), 0),
        totalElapsedMs,
        totalElapsedMinutes: Number((totalElapsedMs / 60000).toFixed(2)),
        meanIterationMs: Number((totalElapsedMs / samples.length).toFixed(2)),
        scenarioMatrix: catalogueSummary,
        familyTally,
        transportTally,
        registerSummary,
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
      console.log(`OMP CLOSED-LOOP HARNESS VERDICT: ${summary.verdict}`);
      console.log(`Completed ${samples.length} iterations in ${(totalElapsedMs / 1000).toFixed(1)}s | failed iterations: ${summary.failedIterations} | failed checks: ${summary.failedChecks}`);
      console.log(`Heap delta: ${heapDeltaMb >= 0 ? '+' : ''}${heapDeltaMb} MB | RSS delta: ${rssDeltaMb >= 0 ? '+' : ''}${rssDeltaMb} MB`);
      console.log(`Artifacts: ${finalSample.artifacts.count} stored | In-flight ledger: ${finalSample.ledger.inFlightCount}`);
      console.log(`Families: ${Object.entries(familyTally).map(([id, t]) => `${id}(${t.ok}/${t.calls})`).join(' ')}`);
      console.log(`Transport: ${JSON.stringify(transportTally)} | Register bytes ${registerSummary.firstBytes}->${registerSummary.lastBytes} (monotone=${registerSummary.monotone}, checks=${JSON.stringify(registerCheckCounts)})`);
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
