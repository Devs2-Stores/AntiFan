/**
 * AntiFan Browser Desktop — Main Electron Bootstrap Entry Point
 * High-performance, ultra-lightweight Chromium host and Extension Bridge companion.
 */
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, Menu, protocol, session, nativeTheme, webContents, crashReporter } from 'electron';

// Register custom privileged scheme for local workspace preview before app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'antifan-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);
import { registerPreviewProtocolHandler } from './server/preview-protocol-handler';
import { StorageLocations } from './config/storage-locations';
import { WorkspaceCapsuleManager } from './project/workspace-capsule';
import { NativeTabHost } from './browser/native-tab-host';
import { BridgeServer, DEFAULT_EXTENSION_ALLOWED_DOMAINS, redactCredentials } from './bridge/bridge-server';
import { TerminalManager } from './browser/terminal-manager';
import { buildApplicationMenu } from './browser/app-menu';
import { WindowStateManager } from './browser/window-state';
import { HistoryManager } from './browser/history-manager';
import { configureBrowserSessionPartition } from './browser/browser-session-partition';
import { LocalIpcServer } from './native-messaging/local-ipc-server';
import { installNativeHost, COMPANION_EXTENSION_ID } from './native-messaging/manifest-installer';
import { chromeSessionUserAgent } from './browser/google-auth-identity';
import { ControlPlaneRuntime, resolveArtifactStoreOptionsFromEnv } from './control-plane/control-plane-runtime';
import { BrowserControlPort } from './tools/browser-control-port';
import { CapabilityTransportAdapter } from './tools/capability-transport';
import { DeviceManager } from './device/device-manager';
import { IosDeviceAdapter } from './device/ios-device-adapter';
import { validateControlPlaneId } from '../shared/control-plane-contracts';
import { assertDeadlineChain } from '../shared/deadline-chain';
import { preparePersistentProfile, ProfileMigrationError, ProfileOwnership, ProfileOwnershipError, type PersistentProfileResult, type ProfileLease } from './browser/profile-ownership';
import { recordBenchmark, startEventLoopDelayMonitor, isBenchmarkEnabled } from './benchmark/telemetry';
import type { ActionSequenceParams } from './browser/tab-automation-host';
import {
  recordLifecycleEvent,
  installExitInterceptor,
  installExitRecorder,
  getLifecycleLogPath,
} from './diagnostics/main-lifecycle-log';
import { pruneOldCrashDumps } from './diagnostics/crash-dump-retention';
import { intakeCrashReports } from './diagnostics/crash-report-intake';

// Fail-closed boot guard (`AP-DEADLINE-001`): the request deadline chain must strictly
// increase from the innermost callee bound to the outermost caller bound. A flattened or
// inverted chain lets a caller abandon a request while its callee still admits it, which
// converts a recoverable timeout into an orphaned command. Refuse to boot on an incoherent
// chain instead of serving requests under one. Deliberately above the uncaughtException
// handler: this throw must be fatal, never swallowed into a boot that continues anyway.
assertDeadlineChain();

// Every fatal path below also writes a durable journal line. A launch from Explorer
// or a shortcut has no attached console, so the console.* lines alone are discarded:
// the app used to die without leaving any record of how. See
// diagnostics/main-lifecycle-log.ts for why the appends are synchronous.
process.on('uncaughtException', (err) => {
  console.error('[antifan uncaughtException]', redactCredentials(err?.stack || String(err)));
  recordLifecycleEvent('uncaughtException', { detail: redactCredentials(err?.stack || String(err)) });
});

process.on('unhandledRejection', (reason) => {
  console.error('[antifan unhandledRejection]', redactCredentials(String(reason)));
  recordLifecycleEvent('unhandledRejection', { detail: redactCredentials(String(reason)) });
});

app.on('render-process-gone', (_event, webContents, details) => {
  console.warn('[antifan render-process-gone]', details.reason, 'exitCode:', details.exitCode, 'url:', webContents?.getURL?.() || 'unknown');
  recordLifecycleEvent('render-process-gone', {
    reason: details.reason,
    exitCode: details.exitCode,
    url: webContents?.getURL?.() || 'unknown',
  });
});

app.on('child-process-gone', (_event, details) => {
  console.warn('[antifan child-process-gone]', details.type, details.reason, 'exitCode:', details.exitCode);
  recordLifecycleEvent('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode });
});

// One interceptor covers every explicit exit — including `app.exit`, which fires no
// before-quit/will-quit event and is therefore invisible to all lifecycle listeners
// below. Recording the call site is what turns "the app vanished" into "the app
// exited here". Installed before any later code can exit.
installExitInterceptor(app, process);
installExitRecorder(process);

// Electron's own crash reporter is enabled so that a fatal native crash leaves a dump with
// metadata inside the app's data directory, instead of only in the machine-wide WER store
// that has to be found by hand. Measured 2026-09-14: pid 20812 died with exception code
// 0xC000041D (STATUS_FATAL_USER_CALLBACK_EXCEPTION) and wrote NO journal line at all,
// because the exception left through a native callback before any handler above could run.
// For that class of death the dump is the only surviving artifact, and this is what makes
// it findable on the next launch. The dump path must be set before the reporter starts.
let crashDumpsDir: string | null = null;
try {
  crashDumpsDir = path.join(StorageLocations.getRuntimeDir(), 'crashDumps');
  fs.mkdirSync(crashDumpsDir, { recursive: true });
  app.setPath('crashDumps', crashDumpsDir);
  crashReporter.start({
    productName: 'AntiFan Desktop',
    companyName: 'AntiFan',
    submitURL: '',
    uploadToServer: false,
    compress: false,
  });
  const prunedDumps = pruneOldCrashDumps(crashDumpsDir, 3);
  recordLifecycleEvent('crashReporter.enabled', { crashDumps: crashDumpsDir, prunedDumps: prunedDumps.length });
} catch (err) {
  // Never fatal: failing to arm the crash reporter must not stop the app from starting.
  recordLifecycleEvent('crashReporter.failed', { detail: redactCredentials(String(err)) });
}

// Read what earlier deaths left behind BEFORE retention can delete it. The dump is written by a
// native fault that runs no JS handler, so this launch is the first moment the death can be
// named; pruneOldCrashDumps keeps only the newest few, so pruning first would delete an
// unrecorded dump and turn a named death back into silence. The same is true when intake
// itself fails: pruning then would delete dumps that were never read, so retention runs only
// when intake reports it completed. Intake never throws and never blocks startup: it is
// awaited by nothing, and its failures are its own.
try {
  if (crashDumpsDir) {
    const dumpsDir = crashDumpsDir;
    void intakeCrashReports({ crashDumpsDir: dumpsDir })
      .then((intake) => {
        if (!intake.completed) return;
        const prunedDumps = pruneOldCrashDumps(dumpsDir, 3);
        if (prunedDumps.length > 0) {
          recordLifecycleEvent('crashReporter.pruned', { prunedDumps: prunedDumps.length });
        }
      })
      .catch(() => undefined);
  }
} catch (err) {
  recordLifecycleEvent('crashReporter.intakeFailed', { detail: redactCredentials(String(err)) });
}

const IS_PROD = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const IS_DEV = !IS_PROD;
if (process.argv.includes('--mcp-server')) {
  console.error('[antifan] Electron --mcp-server is discontinued. Use the standalone Node MCP proxy (scripts/antifan-omp-mcp.cjs) to connect to a running AntiFan Desktop instance.');
  app.exit(1);
  process.exit(1);
}
const IS_CI = Boolean(process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0');
const HAS_EVAL_FLAG = process.argv.includes('--allow-eval') || process.argv.includes('--mcp-high-risk');
const HAS_EVAL_ENV = process.env.ANTIFAN_ALLOW_EVAL === 'true' || process.env.ANTIFAN_ALLOW_EVAL === '1';
// Require explicit opt-in (ANTIFAN_ALLOW_EVAL=true or --allow-eval/--mcp-high-risk); exclude CI; never default eval-on for win32 prod
const ALLOW_EVAL = !process.env.ANTIFAN_CLOUD_HOSTED && (HAS_EVAL_FLAG || (!IS_CI && HAS_EVAL_ENV));
// Every packaged, shortcut, and development launch owns the same Chromium
// profile. The environment override remains available for isolated tests and
// benchmarks, but launch mode never changes a user's browser identity.
const customUserData = process.env.ANTIFAN_USER_DATA || process.env.ANTIFAN_USER_DATA_DIR;
StorageLocations.ensureDirectories();
if (!process.env.ANTIFAN_CONFIG_DIR) {
  process.env.ANTIFAN_CONFIG_DIR = StorageLocations.getConfigDir();
}
if (!process.env.ANTIFAN_DATA_ROOT) {
  process.env.ANTIFAN_DATA_ROOT = StorageLocations.getDataRoot();
}
let preparedProfile: PersistentProfileResult;
try {
  preparedProfile = preparePersistentProfile({
    appDataPath: app.getPath('appData'),
    appPath: app.getAppPath(),
    customUserData,
    canonicalPath: StorageLocations.getProfileDir(),
  });
} catch (error) {
  if (error instanceof ProfileMigrationError) {
    console.error(`[antifan] ${error.message}`);
  }
  throw error;
}
const persistentUserData = preparedProfile.profilePath;
if (preparedProfile.migratedFrom) {
  console.log(`[antifan] Migrated Chromium profile from ${preparedProfile.migratedFrom} to ${persistentUserData}`);
}
const chromiumCachePath = StorageLocations.getCacheDir();
try { fs.mkdirSync(persistentUserData, { recursive: true }); } catch {}
try { fs.mkdirSync(chromiumCachePath, { recursive: true }); } catch {}
app.setPath('userData', persistentUserData);
app.setPath('sessionData', persistentUserData);
app.setPath('cache', chromiumCachePath);
app.commandLine.appendSwitch('disk-cache-dir', StorageLocations.getNetworkCacheDir());
app.commandLine.appendSwitch('gpu-cache-dir', StorageLocations.getGpuCacheDir());
app.name = 'AntiFan Browser Desktop';
nativeTheme.themeSource = 'system';

// Configure high-performance Chromium hardware acceleration, memory caps, and security switches
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-quic');
app.commandLine.appendSwitch('enable-fast-unload');
app.commandLine.appendSwitch('enable-tcp-fast-open');
app.commandLine.appendSwitch('renderer-process-limit', '4');
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('disk-cache-size', '134217728'); // 128 MB
app.commandLine.appendSwitch('media-cache-size', '67108864');  // 64 MB
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
app.commandLine.appendSwitch('enable-features', 'PasswordManager,Autofill,SmoothScrolling,ParallelDownloading,BackForwardCache,AsyncImageDecoding');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
const CHROME_USER_AGENT = chromeSessionUserAgent();
app.userAgentFallback = CHROME_USER_AGENT;

let mainWindow: BrowserWindow | null = null;
let tabHost: NativeTabHost | null = null;
let capsuleManager: WorkspaceCapsuleManager | null = null;
let bridgeServer: BridgeServer | null = null;
let windowStateManager: WindowStateManager | null = null;
let controlPlane: ControlPlaneRuntime | null = null;
let profileLease: ProfileLease | null = null;
let localIpcServer: LocalIpcServer | null = null;
// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log(`[antifan] Another instance is already running (${IS_DEV ? 'DEV' : 'PROD'}). Exiting.`);
  app.exit(0);
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();

      const urlArg = commandLine.find((arg) => (arg.startsWith('http://') || arg.startsWith('https://')) && !arg.includes('localhost:20128') && !arg.includes('localhost:20129') && !arg.includes('localhost:20130'));
      if (urlArg && tabHost) {
        tabHost.createTab(urlArg);
      }
    }
  });
}

// Benchmark-mode-only telemetry (ANTIFAN_BENCHMARK=1 / --benchmark). Disabled
// in normal startup; emits startup milestones and event-loop delay samples.
const ownsElectronInstance = app.hasSingleInstanceLock();
const benchmarkStopEventLoop = startEventLoopDelayMonitor();
recordBenchmark({ surface: 'startup', name: 'bootstrap' });
/** Samples Electron app metrics per process type; benchmark mode only. */
function recordProcessMetrics(label: string): void {
  if (!isBenchmarkEnabled()) return;
  try {
    const byType: Record<string, { processes: number; workingSetKB: number; privateBytesKB: number }> = {};
    for (const metric of app.getAppMetrics()) {
      const key = metric.type || 'Unknown';
      const agg = byType[key] ?? (byType[key] = { processes: 0, workingSetKB: 0, privateBytesKB: 0 });
      agg.processes += 1;
      agg.workingSetKB += metric.memory?.workingSetSize ?? 0;
      agg.privateBytesKB += metric.memory?.privateBytes ?? 0;
    }
    const breakdown: Record<string, unknown> = {};
    for (const [type, agg] of Object.entries(byType)) breakdown[type] = agg;
    recordBenchmark({ surface: 'process', name: label, extra: { breakdown, mainRssKB: process.memoryUsage().rss / 1024 } });
  } catch {}
}

async function createWindow(): Promise<void> {
  const windowTitle = IS_DEV ? 'AntiFan Browser Desktop [DEV]' : 'AntiFan Browser Desktop';
  
  windowStateManager = new WindowStateManager(StorageLocations.getConfigDir(), 1360, 880);
  const winBounds = windowStateManager.getValidBounds();
  const appIconCandidates = [
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    path.join(process.cwd(), 'assets', 'icon.png'),
  ];
  const appIconPath = appIconCandidates.find((candidate) => fs.existsSync(candidate));

  mainWindow = new BrowserWindow({
    title: windowTitle,
    icon: appIconPath,
    x: winBounds.x,
    y: winBounds.y,
    width: winBounds.width,
    height: winBounds.height,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#080c14',
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  windowStateManager.manage(mainWindow);
  recordBenchmark({ surface: 'startup', name: 'windowCtor' });

  // Canonical single TerminalManager: this is the one instance shared by UI IPC,
  // Bridge, NativeTabHost, control-plane capabilities, and theme transactions.
  // TerminalManager.getInstance() returns this instance (private constructor, no
  // second owner can be spawned); the control plane receives it explicitly below.
  const terminalManager = TerminalManager.getInstance();
  tabHost = new NativeTabHost(mainWindow, capsuleManager || undefined);
  recordBenchmark({ surface: 'startup', name: 'tabHostCtor' });

  // Restore tabs immediately so web pages start loading and window layout is established
  const initialUrl = process.argv.find((arg) => (arg.startsWith('http://') || arg.startsWith('https://')) && !arg.includes('localhost:20128') && !arg.includes('localhost:20129') && !arg.includes('localhost:20130'));
  tabHost.restoreTabs(initialUrl);
  recordBenchmark({ surface: 'startup', name: 'tabsRestored' });

  // Set Top Menubar (File, Edit, Selection, View, Go, Run, Terminal, Help)
  Menu.setApplicationMenu(buildApplicationMenu(mainWindow, tabHost));

  const projectId = validateControlPlaneId(process.env.ANTIFAN_PROJECT_ID || 'project-00000000-0000-4000-8000-000000000001', 'project');
  const workspaceId = validateControlPlaneId(process.env.ANTIFAN_WORKSPACE_ID || 'workspace-00000000-0000-4000-8000-000000000001', 'workspace');
  controlPlane = new ControlPlaneRuntime({
    projectId,
    workspaceId,
    dataRoot: StorageLocations.getControlPlaneDir(),
    allowEval: ALLOW_EVAL,
    terminal: terminalManager,
    artifactStoreOptions: resolveArtifactStoreOptionsFromEnv(),
    getAutomationTabId: () => tabHost!.getAutomationTabId(),
    getDocumentGeneration: (tabId) => tabHost!.getDocumentGeneration(tabId),
    isTabAllowed: (primaryTabId, requestedTabId) => tabHost!.isTabAllowedForPrimary(primaryTabId, requestedTabId),
    resolveTabId: (id) => tabHost!.resolveTargetTabId(id),
    resolveFailoverTabId: (staleTabId) => tabHost!.getFailoverTargetTab(staleTabId),
    releaseSessionTab: (sessionId, tabId) => tabHost!.releaseSessionTab(sessionId, tabId),
    releaseSessionTabPool: (sessionId) => tabHost!.releaseSessionTabPool(sessionId),
  });
  // Show the window as soon as its renderer paints
  // init below), so the user sees chrome immediately instead of waiting for the
  // ~4s ledger/attachments replay.
  let showFallbackTimer: NodeJS.Timeout | null = null;
  const showMainWindow = () => {
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer);
      showFallbackTimer = null;
    }
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    if (winBounds.isMaximized) {
      mainWindow.maximize();
    } else if (typeof winBounds.x !== 'number' || typeof winBounds.y !== 'number') {
      mainWindow.center();
    }
    mainWindow.show();
    mainWindow.focus();
    recordBenchmark({ surface: 'startup', name: 'firstVisible' });
    recordProcessMetrics('afterFirstVisible');
  };
  mainWindow.once('ready-to-show', showMainWindow);
  showFallbackTimer = setTimeout(showMainWindow, 300);
  mainWindow.on('closed', async () => {
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer);
      showFallbackTimer = null;
    }
    mainWindow = null;
    await shutdown();
    app.quit();
  });

  // Finish control-plane init (async relative to the window show above; the
  // renderer already painted and is interactive). The ledger/attachment replay
  // is CPU-bound JSON.parse+sha256 per frame — on populated profiles it
  // saturates the main thread for seconds. Start it only after the window is
  // visible (or a bounded fallback) so first paint is never queued behind it.
  const initDone = Promise.withResolvers<void>();
  let initStarted = false;
  const startControlPlaneInit = () => {
    if (initStarted) return;
    initStarted = true;
    controlPlane!.initialize().then(initDone.resolve, initDone.reject);
  };
  if (mainWindow.isVisible()) {
    setTimeout(startControlPlaneInit, 0);
  } else {
    mainWindow.once('ready-to-show', () => setTimeout(startControlPlaneInit, 0));
    setTimeout(startControlPlaneInit, 1500);
  }
  await initDone.promise;
  startLifecycleHeartbeat();
  tabHost.setControlPlane(controlPlane);

  // Phase 2 (step 10): deterministic attachment disposal. When an attachment is
  // revoked or expires, close ONLY the agent tab it owns (offscreen) and its
  // terminal affinity — never a user-visible tab nor another attachment's
  // resource. Agent tabs are provisioned offscreen, so isTabOffscreen is the safe
  // discriminator: a user-visible tab is never offscreen and is never closed here.
  // tabHost.closeTab already releases viewport locks, agent-working state,
  // terminal affinity, session pools, and partitions for that single tab.
  controlPlane.runs.attachments.setDisposeListener(({ attachmentId, tabId }) => {
    if (!tabId || !tabHost) return;
    if (tabHost.isTabOffscreen(tabId) !== true) return; // never close a user-visible tab
    try {
      tabHost.closeTab(tabId);
      console.log(`[antifan] Attachment ${attachmentId} disposed; closed owned agent tab ${tabId}`);
    } catch (err) {
      console.warn(`[antifan] Attachment ${attachmentId} disposal: failed to close agent tab ${tabId}`, err);
    }
  });
  const browserPort = new BrowserControlPort({
    hasTab: (tabId) => tabHost!.hasTab(tabId),
    resolveTargetTabId: (tabId) => tabHost!.resolveTargetTabId(tabId),
    adoptChildTab: (primaryOrBoundTabId, childTabId) => tabHost!.adoptChildTabForBoundTab(primaryOrBoundTabId, childTabId),
    getManagedTabIds: (primaryOrBoundTabId) => tabHost!.getManagedTabIdsForBoundTab(primaryOrBoundTabId),
    isTabAllowed: (primaryOrBoundTabId, requestedTabId) => tabHost!.isTabAllowedForPrimary(primaryOrBoundTabId, requestedTabId),
    getTabList: () => tabHost!.getTabList(),
    getSessionTabList: (boundTabId) => tabHost!.getSessionTabRecords(boundTabId),
    getFailoverTargetTab: (tabId) => tabHost!.getFailoverTargetTab(tabId),
    getBrowserEpoch: () => tabHost!.getBrowserEpoch(),
    getActiveTabId: () => tabHost!.getActiveTabId(),
    getAutomationTabId: () => tabHost!.getAutomationTabId(),
    setAutomationTabId: (tabId) => tabHost!.setAutomationTabId(tabId),
    isTabOffscreen: (tabId) => tabHost!.isTabOffscreen(tabId),
    createTab: (url, activate = false, options) => tabHost!.createTab(url, activate, options),
    closeTab: (tabId) => tabHost!.closeTab(tabId),
    switchTab: (tabId) => tabHost!.switchTab(tabId),
    navigate: (tabId, url) => tabHost!.navigateAndWait(tabId, url),
    reload: (tabId: string) => tabHost!.reloadAndWait(tabId),
    getTabDebugger: (tabId: string) => {
      const wc = tabHost!.getTabWebContents(tabId, 'desktop');
      return wc && !wc.isDestroyed() ? wc.debugger : undefined;
    },
    getDom: (selector, tabId, paneId) => tabHost!.getDom(selector, tabId, paneId),
    captureScreenshot: (rect, tabId, paneId, options) => tabHost!.captureScreenshot(rect as any, tabId, paneId, options),
    captureVerificationScreenshot: (rect, tabId, paneId, options) => tabHost!.captureVerificationScreenshot(rect as any, tabId, paneId, options),
    drainTarget: (tabId, paneId, timeoutMs) => tabHost!.drainTarget(tabId, paneId, timeoutMs),
    readRenderSurface: (tabId, paneId, timeoutMs) => tabHost!.readRenderSurface(tabId, paneId, timeoutMs),
    reapplyTabGeometry: (tabId, paneId, before) => tabHost!.reapplyTabGeometry(tabId, paneId, before),
    evalJs: (expression, tabId, paneId, userGesture, timeoutMs) => tabHost!.evalJs(expression, tabId, paneId, userGesture, timeoutMs),
    evalJsInFrame: (expression, frameUrl, tabId, paneId, userGesture, timeoutMs) => tabHost!.evalJsInFrame(expression, frameUrl, tabId, paneId, userGesture, timeoutMs),
    getNetworkTracker: () => tabHost!.getNetworkTracker(),
    getDiagnostics: (tabId, level) => tabHost!.getDiagnostics(tabId, level),
    runResponsiveCheck: (params) => tabHost!.runResponsiveCheck(params),
    agentTrajectory: (params) => tabHost!.agentTrajectory(params),
    dispatchAgentAction: (action, params) => tabHost!.dispatchAgentAction(action as any, params as any),
    agentMove: (args) => tabHost!.agentMove(args),
    agentClick: (params) => tabHost!.agentClick(params),
    agentType: (params) => tabHost!.agentType(params),
    agentScroll: (params) => tabHost!.agentScroll(params),
    agentHover: (params) => tabHost!.agentHover(params),
    agentHighlight: (params) => tabHost!.agentHighlight(params),
    agentClear: (tabId, paneId) => tabHost!.agentClear(tabId, paneId),
    agentDrag: (params) => tabHost!.agentDrag(params),
    setTrackerIsolation: (tabId, paneId, active) => (active
      ? tabHost!.beginTrackerIsolation(tabId, paneId).then((receipt) => ({ active: receipt.active, reason: receipt.degradedReason }))
      // `active` means "isolation is still applied to this target", matching
      // `isTrackerIsolationActive`. A failed rollback leaves the blocklist in
      // place, so reporting `active: false` here would tell the QA workflow and
      // the port that a tab which is still blocked was released cleanly.
      : tabHost!.endTrackerIsolation(tabId, paneId).then((receipt) => (receipt.released
        ? { active: false, reason: receipt.reason }
        : { active: true, reason: receipt.reason }))),
    agentSnapshot: (tabId, paneId) => tabHost!.agentSnapshot(tabId, paneId),
    agentFind: (params) => tabHost!.agentFind(params),
    sendKeyboardPress: (params) => tabHost!.sendKeyboardPress(params),
    setViewportSize: (options) => tabHost!.setViewportSize(options),
    setDevicePreset: (tabId, presetId) => tabHost!.setDevicePreset(tabId, presetId),
    getDevicePresets: () => tabHost!.getDevicePresets(),
    setZoom: (tabId, zoomFactor) => tabHost!.setZoom(tabId, zoomFactor),
    toggleInspect: () => tabHost!.toggleInspect(),
    toggleSplitReview: (tabId, enabled) => tabHost!.toggleSplitReview(tabId, enabled),
    isCurrentTarget: (target) => tabHost!.isCurrentTarget(target),
    clearAllAgentWorking: () => tabHost!.clearAllAgentWorking(),
    getDocumentGeneration: (tabId) => tabHost!.getDocumentGeneration(tabId),
    bumpDocumentGeneration: (tabId) => tabHost!.bumpDocumentGeneration(tabId),
    getMutationRevision: (tabId) => tabHost!.getMutationRevision(tabId),
    bumpMutationRevision: (tabId) => tabHost!.bumpMutationRevision(tabId),
    uploadFileInput: (params) => tabHost!.uploadFileInput(params),
    dropFiles: (params) => tabHost!.dropFiles(params),
    executeActionSequence: (params) => tabHost!.executeActionSequence(params as ActionSequenceParams),
    inspectStyles: (params) => tabHost!.inspectStyles(params),
    inspectRegion: (params) => tabHost!.inspectRegion(params),
    inspectFont: (params) => tabHost!.inspectFont(params),
    getMatchedStylesForNode: (params) => tabHost!.getMatchedStylesForNode(params),
  }, controlPlane.artifacts);
  recordBenchmark({ surface: 'startup', name: 'browserPortReady' });
  tabHost.setViewportGate(browserPort.viewportGate);
  controlPlane.registerBrowser(browserPort);
  recordBenchmark({ surface: 'startup', name: 'browserRegistered' });

  // Tier-2 reality gate: the physical phone is registered as a peer adapter beside the browser port,
  // never inside it. Its lifecycle (attachment epoch + automation session generation) is independent
  // of tab/document generation, and it stages evidence into the same artifact store.
  const deviceManager = new DeviceManager({
    projectId: controlPlane.getLease().projectId,
    workspaceId: controlPlane.getLease().workspaceId || '',
    runtimeId: controlPlane.getLease().runtimeId,
  });
  const deviceAdapter = new IosDeviceAdapter({ devices: deviceManager, artifacts: controlPlane.artifacts });
  controlPlane.registerDevice(deviceAdapter, deviceManager);
  recordBenchmark({ surface: 'startup', name: 'deviceRegistered' });
  // `setControlPlane` above ran before the device surface existed, so its status query correctly saw an
  // unregistered adapter. Now that the port is live, re-read and push the real state instead of letting
  // the toolbar wait for its next poll tick to stop showing "not registered yet".
  tabHost.refreshPhoneStatus();

  const capabilityTransport = controlPlane.transport;

  // One-time migration of legacy capsule partitions to the unified profile
  // partitions (persist:capsule-* -> persist:profile-*). Marker-gated and
  // local-only; never touches a Chrome profile.
  void tabHost
    .migrateLegacyCapsuleToProfile()
    .then((res) => {
      if (res.migrated > 0) {
        console.log(`[antifan] Migrated ${res.migrated} cookies from legacy capsule partitions to profile partitions`);
      }
    })
    .catch((err) => console.warn('[antifan] Capsule->profile migration failed:', err));
  // Start Bridge Server + Native Messaging IPC past first paint. The
  // BridgeServer constructor pays synchronous icacls/powershell DACL spawns
  // (~4s on Windows) for the pairing queue, and start() pays more for
  // bridge-info persistence — all main-thread work that stalled window
  // creation. Neither the bridge socket nor the IPC pipe is needed before the
  // user interacts; both come up ~1.5s after first paint.
  const startBridgeAndIpc = async () => {
    // Fail-closed against a quit racing the 1.5s deferral: never construct or
    // keep a listener alive after shutdown began.
    if (isShuttingDown) return;
    const host = tabHost!;
    const plane = controlPlane!;
    bridgeServer = new BridgeServer(
      host,
      Number(process.env.ANTIFAN_BRIDGE_PORT) || (IS_PROD ? 20129 : 20130),
      IS_DEV,
      capabilityTransport,
      () => {
        const lease = plane.getLease();
        // Dual-Plane Runtime Isolation: bind the agent's authority to a dedicated
        // automation tab, never the user's active foreground tab. This prevents any
        // MCP/CLI session bootstrapping without an explicit target from latching onto
        // and hijacking the user's working tab.
        const automationTarget = host.getAutomationTarget() as
          | { tabId: string; url?: string; documentGeneration?: number }
          | undefined;
        const targetTabId = automationTarget?.tabId;
        if (!targetTabId) {
          // Unbound authority: no ambient fallback. Agent sessions must explicitly
          // provision a target via antifan.cli.startSession, which creates a dedicated
          // background agent tab. Return undefined so unbound tools fail-closed instead
          // of capturing the user's active tab.
          return { lease, projectId, workspaceId, browserTarget: undefined };
        }
        return {
          lease,
          projectId,
          workspaceId,
          browserTarget: {
            projectId,
            workspaceId,
            runtimeId: lease.runtimeId,
            tabId: targetTabId,
            browserEpoch: 1,
            documentGeneration:
              typeof host.getDocumentGeneration === 'function'
                ? host.getDocumentGeneration(targetTabId)
                : 1,
            url: automationTarget?.url,
          },
        };
      },
      plane.runs.attachments,
      '127.0.0.1',
      plane
    );
    bridgeServer.setControlPlane(plane);
    recordBenchmark({ surface: 'startup', name: 'bridgeCtor' });
    const bridgePort = await bridgeServer.start();
    recordBenchmark({ surface: 'startup', name: 'bridgeStarted' });
    // Terminals spawned by this instance carry this instance's own endpoint identity.
    TerminalManager.getInstance().setBridgeEndpoint({ port: bridgePort, host: '127.0.0.1', pid: process.pid });

    // Windows Native Messaging Local IPC Server — re-check shutdown: the
    // bridge start above awaited, and a quit may have landed meanwhile.
    if (process.platform === 'win32' && !isShuttingDown) {
      try {
        localIpcServer = new LocalIpcServer();
        await localIpcServer.start(bridgePort, () => {
          const activeCapsule = capsuleManager?.getActive();
          const activePartition = tabHost!.getSharedProfilePartition('clean');
          const grant = bridgeServer!.issueExtensionGrant(activePartition, DEFAULT_EXTENSION_ALLOWED_DOMAINS);
          return {
            token: grant.grantToken,
            port: bridgePort,
            activeCapsuleId: activeCapsule?.id,
            activePartition,
          };
        }, StorageLocations.getRuntimeDir());
        console.log(`[antifan] Native Messaging Local IPC Server listening at ${localIpcServer.getSocketPath()}`);

        // Auto-register Chrome/Edge/Brave native messaging manifest on Windows
        installNativeHost(COMPANION_EXTENSION_ID).catch((err) => {
          console.warn('[antifan] Native messaging manifest registration notice:', err?.message || err);
        });
      } catch (err) {
        console.warn('[antifan] Failed to start Native Messaging Local IPC Server:', err);
      }
    }
  };
  setTimeout(() => {
    startBridgeAndIpc().catch((err) => console.warn('[antifan] Deferred bridge/IPC startup failed:', err));
  }, 1500);
}

app.whenReady().then(async () => {
  if (!ownsElectronInstance) return;
  recordBenchmark({ surface: 'startup', name: 'ready' });
  try {
    profileLease = new ProfileOwnership().acquire(persistentUserData);
    // Journal the predecessor's verdict BEFORE it can be overwritten: acquire()
    // writes cleanShutdown:false unconditionally (profile-ownership.ts:299-305), so
    // the on-disk marker is this boot's state, never a verdict about the last one.
    recordLifecycleEvent('boot.profile', {
      leasePid: profileLease.info.pid,
      leaseStartedAt: profileLease.info.startedAt,
      prevCleanShutdown: profileLease.recovery.cleanShutdown,
      prevLastCleanShutdownAt: profileLease.recovery.lastCleanShutdownAt,
      prevSafeStartRecommended: profileLease.recovery.safeStartRecommended,
      lifecycleLog: getLifecycleLogPath(),
    });
    if (profileLease.recovery.safeStartRecommended) {
      console.warn('[antifan] Previous shutdown was unclean; restoring the active tab only (safe start).');
    }
  } catch (error) {
    if (error instanceof ProfileOwnershipError) {
      console.error(`[antifan] Profile is already owned: ${error.message}`);
    } else {
      console.error('[antifan] Failed to acquire profile ownership:', error);
    }
    app.exit(0);
    return;
  }
  // Configure default session policies cleanly without global header tampering
  configureBrowserSessionPartition('', 'clean');
  const capsuleStoragePath = path.join(StorageLocations.getConfigDir(), 'workspace-capsules.json');
  capsuleManager = new WorkspaceCapsuleManager({ filePath: capsuleStoragePath });
  if (!capsuleManager.getActive()) {
    const defaultDir = fs.existsSync('E:/Work') ? 'E:/Work' : (fs.existsSync('E:\\Work') ? 'E:\\Work' : process.cwd());
    capsuleManager.create('Default Workspace', defaultDir);
  }
  registerPreviewProtocolHandler(capsuleManager);
  await createWindow();
  recordBenchmark({ surface: 'startup', name: 'windowCreated' });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
}).catch((error) => {
  console.error('[antifan startup failed]', redactCredentials(error?.stack || String(error)));
  app.exit(1);
});

let lifecycleHeartbeat: NodeJS.Timeout | null = null;
/**
 * Absolute-epoch heartbeat. The next boot bounds the death window from the last beat
 * instead of inferring one: a journal that stops mid-run with no shutdown.step line
 * means the process was ended from outside, while a stop immediately after a step
 * names the step it was inside. Every line carries `ts` in epoch milliseconds so the
 * gap is computable without guessing a timezone.
 */
function startLifecycleHeartbeat(): void {
  if (lifecycleHeartbeat) return;
  const beat = (): void => {
    let tabCount: number | null = null;
    let webContentsCount: number | null = null;
    try { tabCount = tabHost ? tabHost.getTabList().length : null; } catch {}
    try { webContentsCount = webContents.getAllWebContents().length; } catch {}
    const memory = process.memoryUsage();
    recordLifecycleEvent('heartbeat', {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      tabCount,
      webContentsCount,
    });
  };
  beat();
  lifecycleHeartbeat = setInterval(beat, 5000);
  lifecycleHeartbeat.unref?.();
}

let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  // `before-quit` caches this promise and calls preventDefault(), so a hang anywhere
  // inside it means the app never quits at all. Journaling every step is what makes
  // "a graceful quit that hung" distinguishable from "a process killed from outside".
  recordLifecycleEvent('shutdown.begin', { lifecycleLog: getLifecycleLogPath() });
  shutdownPromise = (async () => {
    const step = async (name: string, run: () => unknown): Promise<void> => {
      recordLifecycleEvent('shutdown.step.begin', { step: name });
      try {
        await run();
        recordLifecycleEvent('shutdown.step.done', { step: name });
      } catch (err) {
        recordLifecycleEvent('shutdown.step.failed', { step: name, detail: String(err) });
      }
    };
    // First step, deliberately: if any later step hangs, these frames are already
    // terminal, so the next boot's replay cannot claim their outcome was never written.
    await step('ledger.settleInFlight', async () => {
      const settlement = await controlPlane?.ledger.settleInFlightForShutdown('graceful shutdown');
      if (settlement && settlement.pending > 0) {
        recordLifecycleEvent('ledger.settleInFlight', { ...settlement });
      }
    });
    await step('terminal.persistSync', () => TerminalManager.getInstance().persistSync());
    await step('history.persistSync', () => HistoryManager.getInstance().persistSync());
    await step('tabHost.flushAllSessions', () => (tabHost ? tabHost.flushAllSessions() : undefined));
    await step('cookies.flushStore', () => session.defaultSession.cookies.flushStore());
    await step('tabHost.dispose', () => tabHost?.dispose());
    await step('bridgeServer.dispose', () => bridgeServer?.dispose());
    await step('localIpcServer.close', () => localIpcServer?.close());
    await step('terminal.dispose', () => TerminalManager.getInstance().dispose());
    try {
      profileLease?.markCleanShutdown();
      profileLease?.release();
      profileLease = null;
      recordLifecycleEvent('shutdown.clean', {});
    } catch (err) {
      recordLifecycleEvent('shutdown.markCleanShutdown.failed', { detail: String(err) });
    }
  })();
  return shutdownPromise;
}

app.on('window-all-closed', async () => {
  recordLifecycleEvent('window-all-closed', {});
  await shutdown();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let isShuttingDown = false;
app.on('before-quit', (event) => {
  recordLifecycleEvent('before-quit', { alreadyShuttingDown: isShuttingDown });
  if (isShuttingDown) return;
  isShuttingDown = true;
  event.preventDefault();
  shutdown().finally(() => {
    app.quit();
  });
});
app.on('will-quit', () => {
  recordLifecycleEvent('will-quit', {});
  bridgeServer?.dispose();
  tabHost?.dispose();
  profileLease?.release();
  profileLease = null;
  benchmarkStopEventLoop?.();
  recordBenchmark({ surface: 'startup', name: 'shutdown' });
  recordProcessMetrics('atShutdown');
});

let isSignalExiting = false;
function handleSignal(signal: NodeJS.Signals): void {
  recordLifecycleEvent('signal', { signal, alreadyExiting: isSignalExiting });
  if (isSignalExiting) return;
  isSignalExiting = true;
  isShuttingDown = true;
  const forceTimer = setTimeout(() => {
    // A silent exit: no clean marker is written, because shutdown() never reached it.
    recordLifecycleEvent('shutdown.forceExit', { code: 1, reason: 'shutdown did not finish within 2000ms' });
    process.exit(1);
  }, 2000);
  forceTimer.unref?.();
  shutdown().finally(() => {
    clearTimeout(forceTimer);
    recordLifecycleEvent('shutdown.complete', { code: 0 });
    process.exit(0);
  });
}

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
