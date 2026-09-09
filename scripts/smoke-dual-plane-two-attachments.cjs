/**
 * Live Electron certification: Explicit Authority & Dual-Plane cutover.
 *
 * Proves the plan 260909-0032 phase-6 runtime contract with two independent
 * attachments operating concurrently against distinct browser targets while a
 * user sentinel tab stays untouched:
 *
 *   1. Two attachment-scoped MCP sessions (A -> /target-a, B -> /target-b),
 *      no process-global automation target, no ambient active-tab fallback.
 *   2. Interleaved browser (DOM read, input, viewport, capture) and terminal
 *      operations; each attachment sees only its own target.
 *   3. Cross-target access from A to B's tab fails closed.
 *   4. Both offscreen captures are non-empty, target-specific, and distinct.
 *   5. Sentinel tab: id/url/document generation/screenshot hash unchanged.
 *   6. Revoking A reaps only A; B keeps operating.
 *   7. Mismatched credential and closed target fail closed before side effects.
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dual-plane-smoke-'));
app.setPath('userData', tempUserData);

const { makeControlPlaneId } = require('../.compiled/src/shared/control-plane-contracts.js');
const { CapabilityTransportAdapter } = require('../.compiled/src/main/tools/capability-transport.js');
const { BrowserControlPort } = require('../.compiled/src/main/tools/browser-control-port.js');
const { ControlPlaneRuntime } = require('../.compiled/src/main/control-plane/control-plane-runtime.js');
const { AttachmentRegistry } = require('../.compiled/src/main/run/attachment-registry.js');
const { NativeTabHost } = require('../.compiled/src/main/browser/native-tab-host.js');
const { AntiFanMcpServer } = require('../.compiled/src/main/mcp/mcp-server.js');

let cleanupFn = async () => {};

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function imageBytes(result) {
  assert.strictEqual(result.isError, undefined, `capture must succeed: ${textOf(result).slice(0, 300)}`);
  const item = (result.content || []).find((c) => c.type === 'image');
  let base64;
  if (item) {
    assert.strictEqual(item.mimeType, 'image/png');
    base64 = item.data;
  } else {
    // Direct in-process MCP surface returns the artifact envelope as JSON text;
    // the stdio proxy converts it into an MCP image content item.
    const parsed = JSON.parse(textOf(result));
    assert.ok(parsed.ok === true, `capture envelope must be ok: ${textOf(result).slice(0, 200)}`);
    base64 = parsed.data;
  }
  assert.ok(typeof base64 === 'string' && base64.length > 0, 'capture must carry base64 data');
  const buffer = Buffer.from(base64, 'base64');
  assert.ok(buffer.length > 500, `capture must be non-empty (got ${buffer.length} bytes)`);
  assert.strictEqual(buffer[0], 0x89, 'PNG signature byte 0');
  assert.strictEqual(buffer[1], 0x50, 'PNG signature byte 1');
  return buffer;
}

function textOf(result) {
  return (result.content || [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

// The in-process MCP surface wraps capability payloads as {"ok":true,"data":...}.
function envelope(result) {
  assert.strictEqual(result.isError, undefined, `call must succeed: ${textOf(result).slice(0, 300)}`);
  const parsed = JSON.parse(textOf(result));
  return parsed && typeof parsed === 'object' && parsed.ok === true && parsed.data !== undefined ? parsed.data : parsed;
}

const traceStart = Date.now();
function trace(label) {
  if (process.env.DUAL_PLANE_TRACE) {
    console.log(`[Dual-Plane Smoke] +${Date.now() - traceStart}ms ${label}`);
  }
}

async function runDualPlaneSmokeTest() {
  console.log('[Dual-Plane Smoke] Starting live two-attachment certification...');

  let server;
  let mainWindow;
  let tabHost;

  let cleanupPromise = null;
  cleanupFn = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (tabHost) {
        try { tabHost.dispose(); } catch {}
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.destroy(); } catch {}
      }
      if (server) {
        try {
          server.closeAllConnections?.();
          await new Promise((resolve) => server.close(resolve));
        } catch {}
      }
      try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    })();
    return cleanupPromise;
  };

  try {
    // 1. Local pages: sentinel (user plane) + two distinct agent targets.
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (req.url.startsWith('/target-a')) {
        res.end(`<!DOCTYPE html><html><head><title>Target Alpha</title></head><body>
  <h1 id="marker">TARGET-ALPHA-MARKER</h1>
  <input id="notes" placeholder="alpha notes" />
  <div id="pane" style="width:420px;height:180px;background:#eef">alpha pane</div>
</body></html>`);
        return;
      }
      if (req.url.startsWith('/target-b')) {
        res.end(`<!DOCTYPE html><html><head><title>Target Beta</title></head><body>
  <h1 id="marker">TARGET-BETA-MARKER</h1>
  <input id="notes" placeholder="beta notes" />
  <div id="pane" style="width:640px;height:320px;background:#fee">beta pane</div>
</body></html>`);
        return;
      }
      res.end(`<!DOCTYPE html><html><head><title>User Sentinel</title></head><body>
  <h1 id="marker">SENTINEL-USER-PLANE</h1>
  <input id="user-search" placeholder="user typing here" />
</body></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    // 2. Electron window + tab host.
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    tabHost = new NativeTabHost(mainWindow);

    const tabA = tabHost.createTab(`${base}/target-a`, false);
    const tabB = tabHost.createTab(`${base}/target-b`, false);
    const sentinelId = tabHost.createTab(`${base}/sentinel`, true);
    assert.ok(tabA && tabB && sentinelId, 'three tabs created');
    assert.strictEqual(tabHost.getActiveTabId(), sentinelId, 'user sentinel is the active tab');

    await new Promise((r) => setTimeout(r, 1800));

    const sentinelBefore = {
      id: sentinelId,
      url: tabHost.getTabList().find((t) => t.id === sentinelId).url,
      generation: tabHost.getDocumentGeneration(sentinelId),
      captureHash: sha256(Buffer.from(await tabHost.captureScreenshot(undefined, sentinelId, 'desktop', { format: 'png' }), 'base64')),
    };

    // 3. Control plane + attachment registry (attachment-scoped target authority).
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtime = new ControlPlaneRuntime({
      dataRoot: tempUserData,
      projectId,
      workspaceId,
      allowEval: false,
      getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
      getAutomationTabId: () => tabHost.getAutomationTabId(),
    });
    const lease = runtime.getLease();
    const browserPort = new BrowserControlPort(tabHost);
    runtime.registerBrowser(browserPort);
    tabHost.setControlPlane(runtime);
    tabHost.setViewportGate(browserPort.viewportGate);

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => lease.hostEpoch,
      getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
    });

    const issue = async (tabId, label) => {
      const runId = makeControlPlaneId('run');
      const attemptId = makeControlPlaneId('attempt');
      const { record, launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
        backendId: 'mcp',
        lease,
        leaseToken: lease.token,
        hostEpoch: lease.hostEpoch,
        tabId,
        grant: 'write',
      });
      const mcp = new AntiFanMcpServer(tabHost, false, new CapabilityTransportAdapter(runtime.capabilities, attachmentRegistry), {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        authorityRevision: launch.authorityRevision,
      });
      console.log(`[Dual-Plane Smoke] Issued attachment ${label} -> tab ${tabId}`);
      return { record, launch, mcp, label };
    };

    trace('3-registry-ready');
    const A = await issue(tabA, 'A');
    const B = await issue(tabB, 'B');
    assert.notStrictEqual(A.record.id, B.record.id, 'attachments are distinct');
    assert.notStrictEqual(A.record.tabId, B.record.tabId, 'attachments bind distinct targets');

    trace('3-attachments-issued');

    // 4. Interleaved browser operations: each attachment sees only its target.
    const domA = await A.mcp.callTool('anti.inspect.dom', { tabId: tabA });
    assert.strictEqual(domA.isError, undefined, 'A DOM read succeeded');
    assert.ok(textOf(domA).includes('TARGET-ALPHA-MARKER'), 'A DOM contains only alpha marker');
    assert.ok(!textOf(domA).includes('TARGET-BETA-MARKER'), 'A DOM must not contain beta content');

    const domB = await B.mcp.callTool('anti.inspect.dom', { tabId: tabB });
    assert.strictEqual(domB.isError, undefined, 'B DOM read succeeded');
    assert.ok(textOf(domB).includes('TARGET-BETA-MARKER'), 'B DOM contains beta marker');

    const typeA = await A.mcp.callTool('anti.agent.cursor.type', { tabId: tabA, selector: '#notes', text: 'alpha-write' });
    assert.strictEqual(typeA.isError, undefined, 'A input succeeded');

    const viewportB = await B.mcp.callTool('anti.browser.viewport.set', { tabId: tabB, width: 900, height: 700 });
    assert.strictEqual(viewportB.isError, undefined, 'B viewport change succeeded');

    trace('4-browser-ops-done');

    // 5. Offscreen captures: non-empty, target-specific, distinct.
    const capA = imageBytes(await A.mcp.callTool('anti.screenshot.viewport', { tabId: tabA }));
    const capB = imageBytes(await B.mcp.callTool('anti.screenshot.viewport', { tabId: tabB }));
    assert.notStrictEqual(sha256(capA), sha256(capB), 'captures must be target-specific (distinct bytes)');
    console.log(`[Dual-Plane Smoke] Captures: A=${capA.length}B B=${capB.length}B (distinct)`);

    trace('5-captures-done');

    // 6. Terminal plane interleave: A owns the session, B observes the same canonical registry.
    const termCreate = await A.mcp.callTool('terminal.create', { cwd: process.cwd() });
    assert.strictEqual(termCreate.isError, undefined, 'A terminal.create succeeded');
    const termSessionId = envelope(termCreate).sessionId;
    assert.ok(termSessionId, 'terminal session id returned');

    trace('6-create-done');
    const termWrite = await A.mcp.callTool('terminal.write', { sessionId: termSessionId, input: 'echo alpha\r' });
    assert.strictEqual(termWrite.isError, undefined, 'A terminal.write succeeded');

    trace('6-write-done');
    const termListB = await B.mcp.callTool('terminal.list', {});
    assert.strictEqual(termListB.isError, undefined, 'B terminal.list succeeded');
    assert.ok(textOf(termListB).includes(termSessionId), 'B observes the canonical terminal registry');

    trace('6-list-done');
    const termClose = await A.mcp.callTool('terminal.close', { sessionId: termSessionId });
    assert.strictEqual(termClose.isError, undefined, 'A terminal.close succeeded');

    trace('6-close-done');

    // 7. Cross-target authority: A must not reach B's tab.
    const crossTarget = await A.mcp.callTool('anti.inspect.dom', { tabId: tabB });
    assert.strictEqual(crossTarget.isError, true, 'A targeting B must fail closed');
    const crossText = textOf(crossTarget);
    assert.ok(/AUTHORITY|FORBIDDEN|TARGET|SCOPE|DENIED/i.test(crossText), `cross-target denial code present: ${crossText.slice(0, 160)}`);
    console.log('[Dual-Plane Smoke] Cross-target access denied as expected.');

    trace('7-cross-target-done');

    // 8. Sentinel invariance: untouched by any agent operation.
    const sentinelAfter = {
      id: tabHost.getActiveTabId(),
      url: tabHost.getTabList().find((t) => t.id === sentinelId).url,
      generation: tabHost.getDocumentGeneration(sentinelId),
      captureHash: sha256(Buffer.from(await tabHost.captureScreenshot(undefined, sentinelId, 'desktop', { format: 'png' }), 'base64')),
    };
    assert.strictEqual(sentinelAfter.id, sentinelBefore.id, 'sentinel stayed the active tab');
    assert.strictEqual(sentinelAfter.url, sentinelBefore.url, 'sentinel URL unchanged');
    assert.strictEqual(sentinelAfter.generation, sentinelBefore.generation, 'sentinel document generation unchanged');
    assert.strictEqual(sentinelAfter.captureHash, sentinelBefore.captureHash, 'sentinel rendered content unchanged');
    console.log('[Dual-Plane Smoke] Sentinel invariance verified.');

    trace('8-sentinel-done');

    // 9. Revoke A: only A is reaped; B keeps operating.
    await attachmentRegistry.revokeAttachment(A.record.id);
    const revokedA = await A.mcp.callTool('anti.inspect.dom', { tabId: tabA });
    assert.strictEqual(revokedA.isError, true, 'revoked attachment A must fail closed');
    const stillB = await B.mcp.callTool('anti.inspect.dom', { tabId: tabB });
    assert.strictEqual(stillB.isError, undefined, 'attachment B continues after A revocation');
    console.log('[Dual-Plane Smoke] Revocation isolation verified.');

    trace('9-revoke-done');

    // 10. Mismatched credential fails closed.
    const forged = new AntiFanMcpServer(tabHost, false, new CapabilityTransportAdapter(runtime.capabilities, attachmentRegistry), {
      attachmentId: B.launch.attachmentId,
      attachmentSecret: 'forged-secret-0000000000000000000000000000000000000000000000000000000000000000',
      authorityRevision: B.launch.authorityRevision,
    });
    const forgedRes = await forged.callTool('anti.inspect.dom', { tabId: tabB });
    assert.strictEqual(forgedRes.isError, true, 'mismatched attachment secret must fail closed');

    trace('10-forged-done');

    // 11. Closed target fails closed.
    tabHost.closeTab(tabB);
    await new Promise((r) => setTimeout(r, 400));
    const closedTarget = await B.mcp.callTool('anti.inspect.dom', { tabId: tabB });
    assert.strictEqual(closedTarget.isError, true, 'closed target must fail closed');

    trace('11-closed-target-done');
    console.log('ALL LIVE DUAL-PLANE TWO-ATTACHMENT CERTIFICATION CHECKS PASSED.');
  } finally {
    trace('cleanup-start');
    await cleanupFn();
    trace('cleanup-done');
  }
}

process.on('unhandledRejection', async (reason) => {
  console.error('[Dual-Plane Smoke] Unhandled Rejection:', reason);
  try { await cleanupFn(); } catch {}
  app.exit(1);
});

app.whenReady().then(async () => {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('[Dual-Plane Smoke] Watchdog timeout reached (120s)')), 120_000);
  });
  try {
    await Promise.race([runDualPlaneSmokeTest(), timeoutPromise]);
    clearTimeout(timer);
    app.exit(0);
  } catch (err) {
    clearTimeout(timer);
    console.error('[Dual-Plane Smoke FAIL]', err);
    try { await cleanupFn(); } catch {}
    app.exit(1);
  }
});
