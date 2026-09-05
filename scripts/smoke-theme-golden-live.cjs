const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const WebSocket = require('ws');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', (event) => {
  event.preventDefault();
});

const rootDir = path.resolve(__dirname, '..');
const tempRoot = process.env.ANTIFAN_LIVE_PROOF_TEMP_ROOT;
const proofPath = process.env.ANTIFAN_LIVE_PROOF_STAGING_PATH;
if (!tempRoot || !proofPath) {
  throw new Error('Live theme proof worker requires orchestrator-owned temp and staging paths');
}
const tempUserData = path.join(tempRoot, 'user-data');
const workspaceRoot = path.join(tempRoot, 'workspace');
app.setPath('userData', tempUserData);

const { BridgeServer } = require('../.compiled/src/main/bridge/bridge-server.js');
const { makeControlPlaneId } = require('../.compiled/src/shared/control-plane-contracts.js');
const { BrowserControlPort } = require('../.compiled/src/main/tools/browser-control-port.js');
const { ControlPlaneRuntime } = require('../.compiled/src/main/control-plane/control-plane-runtime.js');
const { NativeTabHost } = require('../.compiled/src/main/browser/native-tab-host.js');
const { TerminalManager } = require('../.compiled/src/main/browser/terminal-manager.js');

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function checksumObject(value, checksumField) {
  const copy = { ...value };
  delete copy[checksumField];
  return sha256(Buffer.from(JSON.stringify(copy), 'utf8'));
}

function parseTextResult(response, name) {
  assert.equal(response.error, undefined, `${name} returned JSON-RPC error`);
  assert.equal(response.result?.isError, undefined, `${name} returned MCP error: ${response.result?.content?.[0]?.text || ''}`);
  const text = response.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', `${name} must return text content`);
  return JSON.parse(text);
}

async function waitForLoad(webContents, timeoutMs = 10_000) {
  if (!webContents || webContents.isDestroyed()) throw new Error('Target WebContents is unavailable');
  if (!webContents.isLoading()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for Chromium load`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      webContents.removeListener('did-finish-load', onLoad);
      webContents.removeListener('did-fail-load', onFail);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onFail = (_event, code, description) => {
      cleanup();
      reject(new Error(`Chromium load failed (${code}): ${description}`));
    };
    webContents.once('did-finish-load', onLoad);
    webContents.once('did-fail-load', onFail);
  });
}

async function closeServer(server) {
  if (!server) return;
  try { server.closeAllConnections?.(); } catch {}
  await new Promise((resolve) => server.close(() => resolve()));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.stdin.end(); } catch {}
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch {}
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Theme MCP did not exit after termination')), 5000)),
    ]);
  }
}

async function dispatchBridgeCapability(port, launch, authorityRevision, name, params = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(launch.secret)}`, {
    headers: { 'X-Antifan-Attachment-Secret': launch.secret },
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge canary connection timed out')), 5000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const id = `canary-${crypto.randomUUID()}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge canary dispatch timed out')), 5000);
      const onMessage = (raw) => {
        const response = JSON.parse(raw.toString());
        if (response.id !== id) return;
        clearTimeout(timer);
        ws.removeListener('message', onMessage);
        resolve(response);
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({
        id,
        method: 'antifan.capability.dispatch',
        params: {
          name,
          params,
          requestId: `request-${crypto.randomUUID()}`,
          idempotencyKey: `idempotency-${crypto.randomUUID()}`,
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          authorityRevision,
        },
      }));
    });
  } finally {
    try { ws.close(); } catch {}
  }
}

async function run() {
  console.log('[Live Theme Proof] Starting real Chromium Product Card slice...');
  let server;
  let window;
  let tabHost;
  let bridge;
  let mcp;
  let runtime;
  let session;
  let sessionOutcome = 'failed';
  let proofSummary;
  try { fs.unlinkSync(proofPath); } catch {}

  try {
    const fixtureRoot = path.join(rootDir, 'test', 'fixtures', 'golden-workflow', 'product-card');
    copyDirectory(path.join(fixtureRoot, 'theme'), workspaceRoot);
    fs.mkdirSync(path.join(workspaceRoot, 'storefront'), { recursive: true });
    const storefrontHtml = fs.readFileSync(path.join(fixtureRoot, 'storefront', 'index.html'), 'utf8')
      .replace('../theme/assets/component-card.css', '/assets/component-card.css');
    fs.writeFileSync(path.join(workspaceRoot, 'storefront', 'index.html'), storefrontHtml, 'utf8');
    const drawerFixtureRoot = path.join(rootDir, 'test', 'fixtures', 'golden-workflow', 'hamburger-drawer');
    copyDirectory(path.join(drawerFixtureRoot, 'theme'), workspaceRoot);
    fs.copyFileSync(
      path.join(drawerFixtureRoot, 'storefront', 'index.html'),
      path.join(workspaceRoot, 'storefront', 'drawer.html')
    );

    server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      let filePath;
      let contentType;
      if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
        filePath = path.join(workspaceRoot, 'storefront', 'index.html');
        contentType = 'text/html; charset=utf-8';
      } else if (requestUrl.pathname === '/drawer.html') {
        filePath = path.join(workspaceRoot, 'storefront', 'drawer.html');
        contentType = 'text/html; charset=utf-8';
      } else if (requestUrl.pathname === '/assets/component-card.css') {
        filePath = path.join(workspaceRoot, 'assets', 'component-card.css');
        contentType = 'text/css; charset=utf-8';
      } else if (requestUrl.pathname === '/assets/component-drawer.css') {
        filePath = path.join(workspaceRoot, 'assets', 'component-drawer.css');
        contentType = 'text/css; charset=utf-8';
      } else {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end('Not Found');
        return;
      }
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store, max-age=0' });
      response.end(fs.readFileSync(filePath));
    });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    const storefrontUrl = `http://127.0.0.1:${port}/index.html`;
    const drawerUrl = `http://127.0.0.1:${port}/drawer.html`;

    window = new BrowserWindow({
      width: 1200,
      height: 900,
      show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    tabHost = new NativeTabHost(window);
    const tabId = tabHost.createTab(storefrontUrl, true);
    tabHost.setAutomationTabId(tabId);
    await waitForLoad(tabHost.getTabWebContents(tabId));

    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    runtime = new ControlPlaneRuntime({
      dataRoot: tempUserData,
      workspaceRoot,
      projectId,
      workspaceId,
      allowEval: false,
      hostEpoch: tabHost.getBrowserEpoch(),
      getAutomationTabId: () => tabHost.getAutomationTabId(),
      getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
    });
    await runtime.initialize();
    tabHost.setControlPlane(runtime);

    const browser = new BrowserControlPort({
      getTabList: () => tabHost.getTabList(),
      getBrowserEpoch: () => tabHost.getBrowserEpoch(),
      getActiveTabId: () => tabHost.getActiveTabId(),
      getAutomationTabId: () => tabHost.getAutomationTabId(),
      setAutomationTabId: (id) => tabHost.setAutomationTabId(id),
      createTab: (url, activate = false) => tabHost.createTab(url, activate),
      closeTab: (id) => tabHost.closeTab(id),
      switchTab: (id) => tabHost.switchTab(id),
      navigate: (id, url) => tabHost.navigateAndWait(id, url),
      reload: (id) => tabHost.reloadAndWait(id),
      getDom: (selector, id, paneId) => tabHost.getDom(selector, id, paneId),
      captureScreenshot: (rect, id, paneId, options) => tabHost.captureScreenshot(rect, id, paneId, options),
      evalJs: (expression, id, paneId) => tabHost.evalJs(expression, id, paneId),
      getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
      getMutationRevision: (id) => tabHost.getMutationRevision(id),
      bumpMutationRevision: (id) => tabHost.bumpMutationRevision(id),
      isCurrentTarget: (target) => tabHost.isCurrentTarget(target),
      getDiagnostics: (id, level) => tabHost.getDiagnostics(id, level),
      runResponsiveCheck: (params) => tabHost.runResponsiveCheck(params),
      agentTrajectory: (params) => tabHost.agentTrajectory(params),
      dispatchAgentAction: (action, params) => tabHost.dispatchAgentAction(action, params),
      agentMove: (args) => tabHost.agentMove(args),
      agentClick: (params) => tabHost.agentClick(params),
      agentType: (params) => tabHost.agentType(params),
      agentScroll: (params) => tabHost.agentScroll(params),
      agentHover: (params) => tabHost.agentHover(params),
      agentHighlight: (params) => tabHost.agentHighlight(params),
      agentClear: (id, paneId) => tabHost.agentClear(id, paneId),
      agentSnapshot: (id, paneId, selector, viewportOnly) => tabHost.agentSnapshot(id, paneId, selector, viewportOnly),
      agentFind: (params) => tabHost.agentFind(params),
      sendKeyboardPress: (params) => tabHost.sendKeyboardPress(params),
      inspectStyles: (params) => tabHost.inspectStyles(params),
      inspectRegion: (params) => tabHost.inspectRegion(params),
      inspectFont: (params) => tabHost.inspectFont(params),
      getMatchedStylesForNode: (params) => tabHost.getMatchedStylesForNode(params),
      setViewportSize: (options) => tabHost.setViewportSize(options),
      setDevicePreset: (id, presetId) => tabHost.setDevicePreset(id, presetId),
      getDevicePresets: () => tabHost.getDevicePresets(),
      getTabViewportMetrics: (id, paneId) => tabHost.getTabViewportMetrics(id, paneId),
    }, runtime.artifacts);
    tabHost.setViewportGate(browser.viewportGate);
    runtime.registerBrowser(browser);

    session = await runtime.createCliSession({
      projectId,
      workspaceId,
      backendId: 'theme-golden-live',
      tabId,
      browserEpoch: tabHost.getBrowserEpoch(),
      grant: 'write',
    });
    bridge = new BridgeServer(tabHost, 0, false, runtime.transport, undefined, runtime.runs.attachments, '127.0.0.1', runtime);
    const bridgePort = await bridge.start();

    mcp = spawn(process.execPath, [path.join(rootDir, 'scripts', 'antifan-omp-mcp.cjs')], {
      cwd: rootDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ANTIFAN_HEARTBEAT_MS: '1000',
        ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
          port: bridgePort,
          secret: session.launch.secret,
          attachmentId: session.launch.attachmentId,
          authorityRevision: session.launch.authorityRevision,
          runId: session.run.id,
          attemptId: session.attempt.id,
          projectId,
          workspaceId,
          tabId,
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    mcp.stderr.on('data', (chunk) => process.stderr.write(`[Theme MCP] ${chunk}`));

    const decoder = new StringDecoder('utf8');
    const pending = new Map();
    let stdoutBuffer = '';
    mcp.stdout.on('data', (chunk) => {
      stdoutBuffer += decoder.write(chunk);
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          const entry = pending.get(response.id);
          if (!entry) continue;
          pending.delete(response.id);
          clearTimeout(entry.timer);
          entry.resolve(response);
        } catch {}
      }
    });

    let rpcId = 0;
    function rpc(method, params, timeoutMs = 30_000) {
      const id = rpcId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }
    function tool(name, args = {}, timeoutMs = 30_000) {
      return rpc('tools/call', { name, arguments: args }, timeoutMs);
    }

    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'theme-golden-live', version: '1.0.0' },
    });

    const screenshot = await tool('anti.screenshot.viewport', { tabId, format: 'png' });
    assert.equal(screenshot.result?.content?.[0]?.type, 'image');
    const png = Buffer.from(screenshot.result.content[0].data, 'base64');
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const preGeneration = tabHost.getDocumentGeneration(tabId);
    const preStyles = parseTextResult(await tool('anti.inspect.styles', {
      selector: '.product-card',
      properties: ['margin-top'],
      tabId,
    }), 'anti.inspect.styles pre-mutation');
    assert.equal(preStyles.styles['margin-top'], '24px');

    const preMatched = parseTextResult(await tool('anti.inspect.matched_styles', {
      selector: '.product-card',
      tabId,
    }), 'anti.inspect.matched_styles pre-mutation');
    assert.equal(preMatched.data.definitionOfDone, 'STRONG PASS', JSON.stringify({ signals: preMatched.signals, activeRules: preMatched.data.activeRules }));
    assert.equal(preMatched.signals.hasSourceRange, true);
    assert.ok(preMatched.data.activeRules.every((rule) => typeof rule.styleSheetId === 'string' && Number.isInteger(rule.line) && Number.isInteger(rule.column)));
    assert.ok(preMatched.data.activeRules.some((rule) => String(rule.sourceUrl).includes('/assets/component-card.css')));

    const source = parseTextResult(await tool('anti.theme.resolve_element', {
      selector: '.product-card',
      tabId,
    }), 'anti.theme.resolve_element');
    assert.equal(source.data.ambiguous, false);
    assert.equal(source.data.primaryCandidate.file, 'snippets/card-product.liquid');
    assert.equal(source.data.primaryCandidate.confidence, 'HIGH');
    assert.equal(source.data.primaryCandidate.correlated, true);
    assert.ok(new Set(source.data.primaryCandidate.evidence.map((item) => item.kind)).size >= 2);

    const cssPath = path.join(workspaceRoot, 'assets', 'component-card.css');
    const initialCss = fs.readFileSync(cssPath, 'utf8');
    const updatedCss = initialCss.replace('.product-card {\n  margin-top: 24px;', '.product-card {\n  margin-top: 31px;');
    assert.notEqual(updatedCss, initialCss, 'Fixture CSS mutation target must exist exactly once');
    const writeResult = parseTextResult(await tool('file.write', {
      path: 'assets/component-card.css',
      content: updatedCss,
    }), 'file.write');
    assert.equal(writeResult.sha256, sha256(Buffer.from(updatedCss, 'utf8')));
    assert.equal(writeResult.sha256, sha256(fs.readFileSync(cssPath)));

    const reloadResult = parseTextResult(await tool('anti.browser.reload', { tabId }, 40_000), 'anti.browser.reload');
    assert.equal(reloadResult.reloaded, true);
    assert.ok(reloadResult.target.documentGeneration > preGeneration);
    assert.equal(tabHost.getDocumentGeneration(tabId), reloadResult.target.documentGeneration);

    const postStyles = parseTextResult(await tool('anti.inspect.styles', {
      selector: '.product-card',
      properties: ['margin-top'],
      tabId,
    }), 'anti.inspect.styles post-mutation');
    assert.equal(postStyles.styles['margin-top'], '31px');

    const postMatched = parseTextResult(await tool('anti.inspect.matched_styles', {
      selector: '.product-card',
      tabId,
    }), 'anti.inspect.matched_styles post-mutation');
    assert.equal(postMatched.data.definitionOfDone, 'STRONG PASS');
    assert.ok(postMatched.data.activeRules.some((rule) => rule.property === 'margin-top' && rule.value === '31px'));

    const responsive = parseTextResult(await tool('anti.inspect.responsive_matrix', {
      selector: '.product-card',
      tabId,
    }, 40_000), 'anti.inspect.responsive_matrix');
    const breakpointValues = Object.values(responsive.data.breakpoints);
    assert.deepEqual(breakpointValues.map((item) => item.width).sort((a, b) => a - b), [320, 375, 768, 1024, 1440]);
    assert.equal(responsive.signals.allBreakpointsTested, true);
    assert.equal(responsive.signals.hasTargetOverflow, false);
    assert.equal(responsive.signals.hasDocOverflow, false);
    assert.ok(breakpointValues.every((item) => typeof item.targetOverflowX === 'boolean' && typeof item.documentOverflowX === 'boolean'));

    const obligations = [
      { id: 'source', metric: 'theme.source_mapping.file_identified', expected: true, critical: true },
      { id: 'css-active', metric: 'theme.css.active_rule_matched', expected: true, critical: true },
      { id: 'target-overflow', metric: 'theme.responsive.no_target_overflow', expected: true, critical: true },
      { id: 'css-strong', metric: 'theme.css.strong_pass_resolved', expected: true, critical: true },
      { id: 'document-overflow', metric: 'theme.responsive.no_doc_overflow', expected: true },
    ];
    const claim = parseTextResult(await tool('anti.verification.record_claim', {
      claim: 'Product card source, active CSS, mutation result, and responsive boundaries are proven in live Chromium',
      category: 'CUSTOM',
      actor: 'agent',
      tabId,
      selector: '.product-card',
      proofObligations: obligations,
    }), 'anti.verification.record_claim');
    assert.equal(claim.verdict, 'UNVERIFIED');

    const verification = parseTextResult(await tool('anti.verification.verify_claim', {
      claimId: claim.id,
    }, 60_000), 'anti.verification.verify_claim');
    assert.equal(verification.verdict, 'VERIFIED');
    assert.equal(verification.proofProfile.completeness, 'FULL');
    assert.equal(verification.proofProfile.violations.length, 0);
    assert.equal(verification.proofProfile.documentGeneration, reloadResult.target.documentGeneration);
    assert.ok(verification.lifecycle.lastInvocationId);
    const receipt = runtime.receipts.findByCommand(verification.lifecycle.lastInvocationId);
    assert.ok(receipt, 'Verification receipt must be persisted under the invocation ID returned in lifecycle');
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.deliveryState, 'accepted-exact');
    assert.equal(receipt.binding.commandId, verification.lifecycle.lastInvocationId);
    assert.equal(path.resolve(receipt.binding.canonicalWorkspace), path.resolve(workspaceRoot));

    const productReceiptCommandId = verification.lifecycle.lastInvocationId;
    const mobileViewport = parseTextResult(await tool('browser.set-viewport', {
      width: 375,
      height: 667,
      mobile: true,
      deviceScaleFactor: 2,
      tabId,
    }), 'browser.set-viewport');
    assert.equal(mobileViewport.success, true);

    const drawerNavigation = parseTextResult(await tool('anti.browser.navigate', {
      url: drawerUrl,
      tabId,
    }, 40_000), 'anti.browser.navigate drawer');
    assert.equal(drawerNavigation.navigated, true);
    assert.equal(drawerNavigation.target.documentGeneration, tabHost.getDocumentGeneration(tabId));

    const drawerClaim = parseTextResult(await tool('anti.verification.record_claim', {
      claim: 'Hamburger control opens the navigation drawer from a trusted Chromium gesture without layout overflow',
      category: 'INTERACTION',
      actor: 'agent',
      tabId,
      selector: '#menu-toggle',
    }), 'anti.verification.record_claim drawer');
    assert.equal(drawerClaim.verdict, 'UNVERIFIED');
    assert.equal(drawerClaim.interactionBaseline.hasActive, false);
    const drawerRevisionBefore = tabHost.getMutationRevision(tabId);
    assert.equal(drawerClaim.targetMutationRevision, drawerRevisionBefore + 1);

    const drawerTrace = parseTextResult(await tool('anti.trace.interaction', {
      action: 'click',
      selector: '#menu-toggle',
      settleMs: 180,
      tabId,
    }, 40_000), 'anti.trace.interaction drawer');
    assert.equal(drawerTrace.interactionMode, 'trusted_cdp');
    assert.equal(drawerTrace.verified, true);
    assert.equal(drawerTrace.verdict, 'DRAWER_EXPANDED');
    assert.equal(drawerTrace.evidence.observationIntegrity.status, 'COMPLETE');
    assert.equal(tabHost.getMutationRevision(tabId), drawerRevisionBefore + 1);
    const drawerMutationRevisionAdvanced = true;
    assert.equal(drawerTrace.evidence.delta.target.aria.status, 'changed');
    assert.equal(drawerTrace.evidence.delta.document.bodyClasses.status, 'changed');
    assert.ok(drawerTrace.evidence.delta.overlayCandidateDelta.added.some((item) => item.id === 'site-drawer'));
    assert.ok(drawerTrace.evidence.attribution.records.some((item) => item.classification.scope === 'RELATED'));

    const drawerLiveState = await tabHost.getTabWebContents(tabId).executeJavaScript(`(() => {
      const toggle = document.querySelector('#menu-toggle');
      const drawer = document.querySelector('#site-drawer');
      const style = drawer ? getComputedStyle(drawer) : null;
      return {
        action: window.drawerActions && window.drawerActions[0],
        expanded: toggle && toggle.getAttribute('aria-expanded'),
        drawerClass: drawer && drawer.className,
        drawerHidden: drawer && drawer.getAttribute('aria-hidden'),
        drawerVisible: Boolean(drawer && style && style.visibility === 'visible' && drawer.getBoundingClientRect().width > 0),
        bodyClass: document.body.className,
        bodyOverflow: getComputedStyle(document.body).overflow,
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    })()`);
    assert.equal(drawerLiveState.action.isTrusted, true);
    assert.equal(drawerLiveState.expanded, 'true');
    assert.match(drawerLiveState.drawerClass, /\bopen\b/);
    assert.equal(drawerLiveState.drawerHidden, 'false');
    assert.equal(drawerLiveState.drawerVisible, true);
    assert.match(drawerLiveState.bodyClass, /\bdrawer-open\b/);
    assert.ok(drawerLiveState.bodyOverflow === 'hidden' || drawerLiveState.bodyOverflow === 'clip');
    assert.equal(drawerLiveState.documentOverflow, false);
    const drawerVerification = parseTextResult(await tool('anti.verification.verify_claim', {
      claimId: drawerClaim.id,
    }, 60_000), 'anti.verification.verify_claim drawer');
    assert.equal(drawerVerification.verdict, 'VERIFIED');
    assert.equal(drawerVerification.proofProfile.completeness, 'FULL');
    assert.equal(drawerVerification.proofProfile.violations.length, 0);
    assert.ok(drawerVerification.lifecycle.lastInvocationId);
    assert.notEqual(drawerVerification.lifecycle.lastInvocationId, productReceiptCommandId);
    const drawerReceipt = runtime.receipts.findByCommand(drawerVerification.lifecycle.lastInvocationId);
    assert.ok(drawerReceipt);
    assert.equal(drawerReceipt.state, 'completed');
    assert.equal(drawerReceipt.deliveryState, 'accepted-exact');
    assert.equal(drawerReceipt.binding.commandId, drawerVerification.lifecycle.lastInvocationId);
    assert.equal(path.resolve(drawerReceipt.binding.canonicalWorkspace), path.resolve(workspaceRoot));


    const drawerResponsive = parseTextResult(await tool('anti.inspect.responsive_matrix', {
      selector: '#site-drawer',
      tabId,
    }, 40_000), 'anti.inspect.responsive_matrix drawer');
    const drawerBreakpoints = Object.values(drawerResponsive.data.breakpoints);
    assert.deepEqual(drawerBreakpoints.map((item) => item.width).sort((a, b) => a - b), [320, 375, 768, 1024, 1440]);
    assert.equal(drawerResponsive.signals.hasTargetOverflow, false);
    assert.equal(drawerResponsive.signals.hasDocOverflow, false);

    const noOpClaim = parseTextResult(await tool('anti.verification.record_claim', {
      claim: 'No-op control produces a completed interaction transition',
      category: 'INTERACTION',
      actor: 'agent',
      tabId,
      selector: '#noop-action',
    }), 'anti.verification.record_claim no-op');
    const noOpTrace = parseTextResult(await tool('anti.trace.interaction', {
      action: 'click',
      selector: '#noop-action',
      settleMs: 120,
      tabId,
    }, 40_000), 'anti.trace.interaction no-op');
    assert.equal(noOpTrace.actionSuccess, true);
    assert.equal(noOpTrace.interactionMode, 'trusted_cdp');
    assert.equal(noOpTrace.verified, false);
    assert.equal(noOpTrace.verdict, 'NO_OBSERVABLE_EFFECT');
    assert.equal(noOpTrace.evidence.observationIntegrity.status, 'COMPLETE');
    const noOpVerification = parseTextResult(await tool('anti.verification.verify_claim', {
      claimId: noOpClaim.id,
    }, 60_000), 'anti.verification.verify_claim no-op');
    assert.equal(noOpVerification.verdict, 'REJECTED');
    assert.ok(noOpVerification.proofProfile.violations.some((item) => item.metric === 'observable_mutation_effect'));
    assert.notEqual(noOpVerification.lifecycle.lastInvocationId, drawerVerification.lifecycle.lastInvocationId);
    const noOpReceipt = runtime.receipts.findByCommand(noOpVerification.lifecycle.lastInvocationId);
    assert.ok(noOpReceipt);
    assert.equal(noOpReceipt.state, 'completed');
    assert.equal(noOpReceipt.deliveryState, 'accepted-exact');

    const sourceFile = parseTextResult(await tool('file.read', {
      path: 'snippets/card-product.liquid',
    }), 'file.read source canary');
    assert.equal(sourceFile.truncated, false);
    const sectionFile = parseTextResult(await tool('file.read', {
      path: 'sections/main-collection.liquid',
    }), 'file.read section canary');
    assert.equal(sectionFile.truncated, false);
    const duplicateWrite = parseTextResult(await tool('file.write', {
      path: 'snippets/card-product-copy.liquid',
      content: sourceFile.content,
    }), 'file.write duplicate source canary');
    assert.equal(duplicateWrite.sha256, sha256(Buffer.from(sourceFile.content, 'utf8')));
    const tiedSectionContent = `${sectionFile.content}\n{% render 'card-product-copy', section_id: 'featured-collection' %}\n`;
    const edgeWrite = parseTextResult(await tool('file.write', {
      path: 'sections/main-collection.liquid',
      content: tiedSectionContent,
    }), 'file.write duplicate edge canary');
    assert.equal(edgeWrite.sha256, sha256(Buffer.from(tiedSectionContent, 'utf8')));

    const ambiguousSource = parseTextResult(await tool('anti.theme.resolve_element', {
      selector: '.product-card',
      tabId,
    }), 'anti.theme.resolve_element ambiguous canary');
    assert.equal(ambiguousSource.data.ambiguous, true);
    assert.equal(ambiguousSource.data.primaryCandidate, undefined);
    assert.deepEqual(
      ambiguousSource.data.candidates.slice(0, 2).map((candidate) => candidate.file),
      ['snippets/card-product-copy.liquid', 'snippets/card-product.liquid']
    );
    const ambiguousClaim = parseTextResult(await tool('anti.verification.record_claim', {
      claim: 'Ambiguous product card source is authoritative',
      category: 'CUSTOM',
      actor: 'agent',
      tabId,
      selector: '.product-card',
      proofObligations: [{ id: 'source', metric: 'theme.source_mapping.file_identified', expected: true, critical: true }],
    }), 'anti.verification.record_claim ambiguous source');
    const ambiguousVerification = parseTextResult(await tool('anti.verification.verify_claim', {
      claimId: ambiguousClaim.id,
    }, 60_000), 'anti.verification.verify_claim ambiguous source');
    assert.equal(ambiguousVerification.verdict, 'REJECTED');
    assert.ok(ambiguousVerification.proofProfile.violations.some((item) => item.metric === 'theme.source_mapping.file_identified'));

    const staleAuthorityRevision = session.launch.authorityRevision;
    for (let index = 0; index < 101; index += 1) {
      await runtime.runs.attachments.rotateAuthorityRevision(session.launch.attachmentId);
    }
    const staleAuthorityResponse = await dispatchBridgeCapability(
      bridgePort,
      session.launch,
      staleAuthorityRevision,
      'anti.inspect.dom',
      { selector: 'body', tabId }
    );
    assert.equal(staleAuthorityResponse.success, false);
    assert.match(staleAuthorityResponse.error, /^AUTHENTICATION_DENIED:/);

    proofSummary = {
      schemaVersion: 1,
      type: 'antifan-live-theme-proof',
      verdict: 'PROOF_PASSED_CLEANUP_PENDING',
      productCard: {
        pngSignatureValid: true,
        pngBytes: png.length,
        sourceCandidate: source.data.primaryCandidate.file,
        sourceConfidence: source.data.primaryCandidate.confidence,
        sourceCorrelated: source.data.primaryCandidate.correlated,
        matchedCssDefinitionOfDone: postMatched.data.definitionOfDone,
        matchedCssHasSourceRange: preMatched.signals.hasSourceRange,
        fileWriteSha256: writeResult.sha256,
        documentGenerationAdvanced: reloadResult.target.documentGeneration > preGeneration,
        responsiveWidths: breakpointValues.map((item) => item.width).sort((a, b) => a - b),
        targetOverflow: responsive.signals.hasTargetOverflow,
        documentOverflow: responsive.signals.hasDocOverflow,
        verificationVerdict: verification.verdict,
        receiptCompleted: receipt.state === 'completed' && receipt.deliveryState === 'accepted-exact',
      },
      drawer: {
        interactionMode: drawerTrace.interactionMode,
        interactionVerdict: drawerTrace.verdict,
        trustedClick: drawerLiveState.action.isTrusted,
        mutationRevisionAdvanced: drawerMutationRevisionAdvanced,
        drawerVisible: drawerLiveState.drawerVisible,
        responsiveWidths: drawerBreakpoints.map((item) => item.width).sort((a, b) => a - b),
        targetOverflow: drawerResponsive.signals.hasTargetOverflow,
        documentOverflow: drawerResponsive.signals.hasDocOverflow,
        verificationVerdict: drawerVerification.verdict,
        receiptCompleted: drawerReceipt.state === 'completed' && drawerReceipt.deliveryState === 'accepted-exact',
        distinctReceipt: drawerVerification.lifecycle.lastInvocationId !== productReceiptCommandId,
      },
      negativeCanaries: {
        noOpVerdict: noOpVerification.verdict,
        ambiguousSourceVerdict: ambiguousVerification.verdict,
        staleAuthorityDenied: staleAuthorityResponse.success === false,
      },
    };

    console.log('[OK] Negative canaries: no-op claim REJECTED, ambiguous source REJECTED, pruned authority denied.');
    console.log('[OK] Drawer: mobile viewport, trusted CDP click, sparse attributed delta, visible state, five widths, VERIFIED receipt.');
    console.log('[OK] Product Card: real PNG, CDP provenance, source candidacy, file.write SHA, reload generation, five widths, VERIFIED receipt.');
    sessionOutcome = 'completed';
  } finally {
    let cleanupError;
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupError ||= error;
      }
    };

    await cleanup(() => stopChild(mcp));
    if (runtime && session) {
      await cleanup(() => runtime.endCliSession(session.run.id, session.attempt.id, sessionOutcome));
    }
    await cleanup(async () => { bridge?.dispose(); });
    await cleanup(() => runtime?.terminal?.dispose());
    await cleanup(() => TerminalManager.getInstance().dispose());
    await cleanup(async () => { tabHost?.dispose(); });
    const teardownResources = tabHost?.getResourceStats();
    await cleanup(async () => {
      if (window && !window.isDestroyed()) window.destroy();
    });
    await cleanup(() => closeServer(server));

    if (sessionOutcome === 'completed' && proofSummary && !cleanupError) {
      const resourceOwners = {
        tabs: teardownResources?.tabCount,
        attachedViews: teardownResources?.attachedTabViewCount,
        terminalWindows: teardownResources?.terminalWindowCount,
        terminalMetadata: teardownResources?.terminalWindowMetadataCount,
        previewWatchers: teardownResources?.previewWatcherCount,
        previewSubscriptions: teardownResources?.previewSubscriptionCount,
        targetQueues: teardownResources?.targetOperationQueueCount,
        agentTimers: teardownResources?.agentWorkingTimerCount,
        agentRefs: teardownResources?.agentWorkingRefCount,
        networkTargets: teardownResources?.network?.attachedTargetCount,
        networkListeners: teardownResources?.network?.listenerCount,
        networkInflight: teardownResources?.network?.inflightRequestCount,
        devtoolsAttachments: teardownResources?.devTools?.attachedWebContentsCount,
        devtoolsListeners: teardownResources?.devTools?.listenerTargetCount,
        devtoolsQueues: teardownResources?.devTools?.queuedTargetCount,
        devtoolsStylesheets: teardownResources?.devTools?.stylesheetTargetCount,
        devtoolsContexts: teardownResources?.devTools?.isolatedContextCount,
        terminalSessions: teardownResources?.terminal?.sessionCount,
        runningPtys: teardownResources?.terminal?.runningPtyCount,
        terminalDataSubscriptions: teardownResources?.terminal?.dataSubscriptionCount,
        terminalExitSubscriptions: teardownResources?.terminal?.exitSubscriptionCount,
      };
      assert.equal(teardownResources?.disposed, true, 'NativeTabHost must report disposed after live proof');
      assert.ok(Object.values(resourceOwners).every((value) => value === 0), JSON.stringify(resourceOwners));
      assert.equal(mcp?.exitCode !== null || mcp?.signalCode !== null, true, 'Theme MCP must exit before proof staging');
      assert.equal(window?.isDestroyed(), true, 'Live proof window must be destroyed before proof staging');
      assert.equal(fs.existsSync(tempRoot), true, 'Process-bound profile root must remain until Electron exits');
      const report = {
        ...proofSummary,
        coreTeardownCompletedAt: new Date().toISOString(),
        teardown: { passed: true, processBoundTempCleanup: 'pending', resourceOwners },
      };
      report.proofChecksum = checksumObject(report, 'proofChecksum');
      atomicWriteJson(proofPath, report);
      console.log(`[OK] Staged bounded live proof for post-exit cleanup: ${path.basename(proofPath)}`);
    }
    if (cleanupError) throw cleanupError;
  }
}

app.whenReady().then(() => run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('[Live Theme Proof FAIL]', error);
    app.exit(1);
  }));
