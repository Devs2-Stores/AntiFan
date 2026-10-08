/**
 * Isolated Electron host for the full MCP latency benchmark (scripts/benchmark-mcp-tools.mjs).
 *
 * Wires the production capability stack — ControlPlaneRuntime, BrowserControlPort,
 * CockpitPort, BridgeServer — against one private window, exactly as the composition
 * root does (src/main/index.ts, browserPortLocal/cockpitPortLocal), but with a single
 * NativeTabHost so every host route resolves to it. The data root is a throwaway temp
 * directory, so registers, artifacts and baselines never reach the user's live data.
 * The stdio proxy is spawned with the minted bootstrap on its stdin pipe, the same
 * channel the app's terminal launcher uses.
 *
 * Usage: npm run benchmark:mcp -- [--samples N] [--only <substring>] [--out <path>] [--disable-gpu]
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

// Isolation before any compiled module resolves a path: drop every ambient AntiFan
// binding inherited from the launching terminal (config dir, bridge pid, terminal
// tokens) and pin all three register roots inside this run's temp dir.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ANTIFAN_')) delete process.env[key];
}
app.commandLine.appendSwitch('no-sandbox');
if (process.argv.includes('--disable-gpu')) app.commandLine.appendSwitch('disable-gpu');
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-bench-'));
app.setPath('userData', tempUserData);
process.env.ANTIFAN_DATA_ROOT = tempUserData;
process.env.ANTIFAN_ISSUE_REGISTER_DIR = path.join(tempUserData, 'issue-register');
process.env.ANTIFAN_VERIFICATION_REGISTER_DIR = path.join(tempUserData, 'verification-register');
// bridge-server.ts falls back to StorageLocations.getConfigDir() without this pin,
// which would publish a bridge record next to the live app's discovery file.
process.env.ANTIFAN_CONFIG_DIR = path.join(tempUserData, 'config');

const { ProjectWindowShell } = require('../.compiled/src/main/browser/project-window-shell.js');
const { NativeTabHost } = require('../.compiled/src/main/browser/native-tab-host.js');
const { BridgeServer } = require('../.compiled/src/main/bridge/bridge-server.js');
const { makeControlPlaneId } = require('../.compiled/src/shared/control-plane-contracts.js');
const { BrowserControlPort } = require('../.compiled/src/main/tools/browser-control-port.js');
const { CockpitPort } = require('../.compiled/src/main/tools/cockpit-port.js');
const { ControlPlaneRuntime } = require('../.compiled/src/main/control-plane/control-plane-runtime.js');

/** BrowserControlPort host for a single window: the production field set, every route bound to `h`. */
function browserHostFields(h, affiliation) {
  return {
    hasTab: (tabId) => Boolean(tabId && h.hasTab(tabId)),
    resolveTargetTabId: (tabId) => (tabId ? h.resolveTargetTabId(tabId) : undefined),
    adoptChildTab: (primary, child) => h.adoptChildTabForBoundTab(primary, child),
    getManagedTabIds: (primary) => h.getManagedTabIdsForBoundTab(primary),
    noteAgentTabActivity: (tabId) => h.noteAgentTabActivity(tabId),
    isTabAllowed: (primary, requested) => h.isTabAllowedForPrimary(primary, requested),
    getTabList: () => h.getTabList(),
    getSessionTabList: (boundTabId) => h.getSessionTabRecords(boundTabId),
    getFailoverTargetTab: (tabId) => (tabId ? h.getFailoverTargetTab(tabId) : undefined),
    getBrowserEpoch: () => h.getBrowserEpoch(),
    getActiveTabId: () => h.getActiveTabId(),
    getAutomationTabId: () => h.getAutomationTabId(),
    setAutomationTabId: (tabId) => h.setAutomationTabId(tabId && h.hasTab(tabId) ? tabId : undefined),
    isTabOffscreen: (tabId) => (tabId ? h.isTabOffscreen(tabId) : false),
    resolveTabAffiliation: (tabId) => (h.hasTab(tabId) ? affiliation : undefined),
    createTab: (url, activate = false, options) => {
      const { anchorTabId: _anchor, ...hostOptions } = options ?? {};
      return h.createTab(url, activate, hostOptions);
    },
    closeTab: (tabId, source) => h.closeTab(tabId, source),
    switchTab: (tabId, opts) => h.switchTab(tabId, opts),
    trySwitchTab: (tabId, opts) => h.trySwitchTab(tabId, opts),
    navigate: (tabId, url) => h.navigateAndWait(tabId, url),
    navigateAndWait: (tabId, url, timeoutMs) => h.navigateAndWait(tabId, url, timeoutMs),
    getLastNavigationFailure: (tabId) => h.getLastNavigationFailure(tabId),
    reload: (tabId) => h.reloadAndWait(tabId),
    getTabDebugger: (tabId) => {
      const wc = h.getTabWebContents(tabId, 'desktop');
      return wc && !wc.isDestroyed() ? wc.debugger : undefined;
    },
    getDom: (selector, tabId, paneId) => h.getDom(selector, tabId, paneId),
    captureScreenshot: (rect, tabId, paneId, options) => h.captureScreenshot(rect, tabId, paneId, options),
    captureVerificationScreenshot: (rect, tabId, paneId, options) => h.captureVerificationScreenshot(rect, tabId, paneId, options),
    drainTarget: (tabId, paneId, timeoutMs) => h.drainTarget(tabId, paneId, timeoutMs),
    readRenderSurface: (tabId, paneId, timeoutMs) => h.readRenderSurface(tabId, paneId, timeoutMs),
    reapplyTabGeometry: (tabId, paneId, before) => h.reapplyTabGeometry(tabId, paneId, before),
    evalJs: (expression, tabId, paneId, userGesture, timeoutMs) => h.evalJs(expression, tabId, paneId, userGesture, timeoutMs),
    evalJsInFrame: (expression, frameUrl, tabId, paneId, userGesture, timeoutMs) => h.evalJsInFrame(expression, frameUrl, tabId, paneId, userGesture, timeoutMs),
    getNetworkTracker: () => h.getNetworkTracker(),
    getDiagnostics: (tabId, level) => h.getDiagnostics(tabId, level),
    runResponsiveCheck: (params) => h.runResponsiveCheck(params),
    agentTrajectory: (params) => h.agentTrajectory(params),
    dispatchAgentAction: (action, params) => h.dispatchAgentAction(action, params),
    agentMove: (args) => h.agentMove(args),
    agentClick: (params) => h.agentClick(params),
    agentType: (params) => h.agentType(params),
    agentScroll: (params) => h.agentScroll(params),
    agentHover: (params) => h.agentHover(params),
    agentHighlight: (params) => h.agentHighlight(params),
    agentClear: (tabId, paneId) => h.agentClear(tabId, paneId),
    agentDrag: (params) => h.agentDrag(params),
    setTrackerIsolation: (tabId, paneId, active) => (active
      ? h.beginTrackerIsolation(tabId, paneId).then((r) => ({ active: r.active, reason: r.degradedReason }))
      : h.endTrackerIsolation(tabId, paneId).then((r) => (r.released ? { active: false, reason: r.reason } : { active: true, reason: r.reason }))),
    agentSnapshot: (tabId, paneId) => h.agentSnapshot(tabId, paneId),
    agentFind: (params) => h.agentFind(params),
    sendKeyboardPress: (params) => h.sendKeyboardPress(params),
    setViewportSize: (options) => h.setViewportSize(options),
    setDevicePreset: (tabId, presetId) => h.setDevicePreset(tabId, presetId),
    getDevicePresets: () => h.getDevicePresets(),
    setZoom: (tabId, zoomFactor) => h.setZoom(tabId, zoomFactor),
    toggleInspect: () => h.toggleInspect(),
    toggleSplitReview: (tabId, enabled) => h.toggleSplitReview(tabId, enabled),
    isCurrentTarget: (target) => Boolean(target?.tabId && h.hasTab(target.tabId) && h.isCurrentTarget(target)),
    clearAllAgentWorking: () => h.clearAllAgentWorking(),
    getDocumentGeneration: (tabId) => h.getDocumentGeneration(tabId),
    bumpDocumentGeneration: (tabId) => h.bumpDocumentGeneration(tabId),
    getMutationRevision: (tabId) => h.getMutationRevision(tabId),
    bumpMutationRevision: (tabId) => h.bumpMutationRevision(tabId),
    uploadFileInput: (params) => h.uploadFileInput(params),
    dropFiles: (params) => h.dropFiles(params),
    executeActionSequence: (params) => h.executeActionSequence(params),
    inspectStyles: (params) => h.inspectStyles(params),
    inspectRegion: (params) => h.inspectRegion(params),
    inspectFont: (params) => h.inspectFont(params),
    getMatchedStylesForNode: (params) => h.getMatchedStylesForNode(params),
  };
}

function cockpitHostFields(h) {
  return {
    hasTab: (tabId) => Boolean(tabId && h.hasTab(tabId)),
    getTabUrl: (tabId) => h.getTabUrl(tabId),
    resolveTabWorkspaceRoot: (tabId, tabUrl) => h.resolveTabWorkspace(tabId, tabUrl),
    navigateAndWait: (tabId, url, timeoutMs) => h.navigateAndWait(tabId, url, timeoutMs),
    runThemeQa: (tabId, options) => h.runThemeQa(tabId, options),
    getThemeQaState: (tabId) => h.getThemeQaState(tabId),
    checklistLoad: (_tabId, input) => h.themeChecklistLoad(input),
    checklistMutate: (_tabId, input) => h.themeChecklistMutate(input),
    checklistSave: (_tabId, input) => h.themeChecklistSave(input),
  };
}

async function run() {
  const bench = await import(pathToFileURL(path.join(__dirname, 'benchmark-mcp-tools.mjs')).href);
  const opts = bench.cliOptions('plans/reports/mcp-tool-latency-benchmark.json');
  const { server, url } = await bench.startStorefront();
  let shell;
  let tabHost;
  let bridgeServer;
  try {
    shell = new ProjectWindowShell({
      owner: { kind: 'project', projectId: 'project-00000000-0000-4000-8000-000000000001' },
      title: 'AntiFan MCP Benchmark',
      bounds: { width: 1280, height: 860 },
      show: true,
    });
    // A rooted workspace, so file.read / theme.qa_validate are timed instead of refusing
    // WORKSPACE_UNBOUND. It must not equal dataRoot or its parent (control-plane-runtime.ts
    // rejects both as roots).
    const workspaceRoot = path.join(tempUserData, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(workspaceRoot, 'package.json'));
    tabHost = new NativeTabHost(shell);
    // The session's bound tab: a laid-out page in the private window. The benchmark
    // opens its own measured tab beside it through anti.browser.tabs.create.
    const boundTabId = tabHost.createTab('about:blank', true);
    tabHost.setAutomationTabId(boundTabId);

    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const controlPlane = new ControlPlaneRuntime({
      dataRoot: tempUserData,
      workspaceRoot,
      projectId,
      workspaceId,
      // Mirrors the app launched with --allow-eval, so evaluate/evaluate_frame are timed
      // rather than refused.
      allowEval: true,
      getAutomationTabId: () => tabHost.getAutomationTabId(),
      getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
      isTabAllowed: (primary, requested) => tabHost.isTabAllowedForPrimary(primary, requested),
      resolveTabId: (id) => tabHost.resolveTargetTabId(id),
      resolveFailoverTabId: (staleTabId) => tabHost.getFailoverTargetTab(staleTabId),
    });
    const session = await controlPlane.createCliSession({ projectId, workspaceId, backendId: 'bench', tabId: boundTabId, grant: 'eval' });
    tabHost.setControlPlane(controlPlane);

    const browserPort = new BrowserControlPort(browserHostFields(tabHost, { projectId, workspaceId }), controlPlane.artifacts);
    tabHost.setViewportGate(browserPort.viewportGate);
    controlPlane.registerBrowser(browserPort, new CockpitPort(cockpitHostFields(tabHost)));

    bridgeServer = new BridgeServer(tabHost, 0, false, controlPlane.transport, undefined, controlPlane.runs.attachments, '127.0.0.1', controlPlane);
    const bridgePort = await bridgeServer.start();
    const bootstrap = JSON.stringify({
      port: bridgePort,
      secret: session.launch.secret,
      attachmentId: session.launch.attachmentId,
      authorityRevision: session.launch.authorityRevision,
      runId: session.run.id,
      attemptId: session.attempt.id,
      projectId,
      workspaceId,
    });
    const proxyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANTIFAN_')));
    const spawnProxy = () => {
      const child = spawn(process.execPath, [path.join(__dirname, 'antifan-omp-mcp.cjs')], {
        cwd: ROOT,
        env: { ...proxyEnv, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.write(`${bootstrap}\n`);
      return child;
    };
    // activate: the measured tab must be laid out, or every capture tool reports
    // NO_RENDER_SURFACE instead of a capture time.
    await bench.runBenchmark({ mode: 'electron', spawnProxy, url, tabCreateArgs: { activate: true }, scratchDir: path.join(workspaceRoot, '.bench-tmp'), ...opts });
  } finally {
    if (bridgeServer) bridgeServer.dispose();
    if (tabHost) { try { tabHost.dispose(); } catch {} }
    if (shell && shell.window && !shell.window.isDestroyed()) shell.window.destroy();
    server.close();
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  }
}

const WATCHDOG_MS = 30 * 60_000;
const watchdog = setTimeout(() => {
  console.error(`[MCP benchmark] watchdog fired after ${WATCHDOG_MS / 60_000} min`);
  app.exit(1);
}, WATCHDOG_MS);

app.whenReady().then(() => run().then(
  () => { clearTimeout(watchdog); app.exit(0); },
  (err) => { clearTimeout(watchdog); console.error(`BENCHMARK FAILED: ${err?.stack || err}`); app.exit(1); },
));
