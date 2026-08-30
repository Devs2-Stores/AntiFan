/**
 * AntiFan Browser Desktop — Main Electron Bootstrap Entry Point
 * High-performance, ultra-lightweight Chromium host and Extension Bridge companion.
 */
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, Menu, protocol, session, nativeTheme } from 'electron';

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
import { WorkspaceCapsuleManager } from './project/workspace-capsule';
import { registerPreviewProtocolHandler } from './server/preview-protocol-handler';
import { NativeTabHost } from './browser/native-tab-host';
import { BridgeServer } from './bridge/bridge-server';
import { AntiFanMcpServer } from './mcp/mcp-server';
import { TerminalManager } from './browser/terminal-manager';
import { buildApplicationMenu } from './browser/app-menu';
import { WindowStateManager } from './browser/window-state';
import { HistoryManager } from './browser/history-manager';
import { configureBrowserSessionPartition } from './browser/browser-session-partition';
import { chromeSessionUserAgent } from './browser/google-auth-identity';
import { ControlPlaneRuntime } from './control-plane/control-plane-runtime';
import { BrowserControlPort } from './tools/browser-control-port';
import { CapabilityTransportAdapter } from './tools/capability-transport';
import { validateControlPlaneId } from '../shared/control-plane-contracts';
import { preparePersistentProfile, ProfileMigrationError, ProfileOwnership, ProfileOwnershipError, type PersistentProfileResult, type ProfileLease } from './browser/profile-ownership';
import { recordBenchmark, startEventLoopDelayMonitor, isBenchmarkEnabled } from './benchmark/telemetry';

process.on('uncaughtException', (err) => {
  console.error('[antifan uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[antifan unhandledRejection]', reason);
});

app.on('render-process-gone', (_event, webContents, details) => {
  console.warn('[antifan render-process-gone]', details.reason, 'exitCode:', details.exitCode, 'url:', webContents?.getURL?.() || 'unknown');
});

app.on('child-process-gone', (_event, details) => {
  console.warn('[antifan child-process-gone]', details.type, details.reason, 'exitCode:', details.exitCode);
});

const IS_PROD = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const IS_DEV = !IS_PROD;
const IS_MCP_SERVER = process.argv.includes('--mcp-server');
const IS_MCP_HIGH_RISK = process.argv.includes('--mcp-high-risk');

// Every packaged, shortcut, and development launch owns the same Chromium
// profile. The environment override remains available for isolated tests and
// benchmarks, but launch mode never changes a user's browser identity.
const customUserData = process.env.ANTIFAN_USER_DATA || process.env.ANTIFAN_USER_DATA_DIR;
let preparedProfile: PersistentProfileResult;
try {
  preparedProfile = preparePersistentProfile({
    appDataPath: app.getPath('appData'),
    appPath: app.getAppPath(),
    customUserData,
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
const chromiumCachePath = `${persistentUserData}-cache`;
try { fs.mkdirSync(persistentUserData, { recursive: true }); } catch {}
try { fs.mkdirSync(chromiumCachePath, { recursive: true }); } catch {}
app.setPath('userData', persistentUserData);
app.setPath('sessionData', persistentUserData);
app.setPath('cache', chromiumCachePath);
app.commandLine.appendSwitch('disk-cache-dir', path.join(chromiumCachePath, 'network'));
app.commandLine.appendSwitch('gpu-cache-dir', path.join(chromiumCachePath, 'gpu'));
app.name = 'AntiFan Browser Desktop';

nativeTheme.themeSource = 'system';

// Configure high-performance Chromium hardware acceleration and security switches
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-quic');
app.commandLine.appendSwitch('enable-fast-unload');
app.commandLine.appendSwitch('enable-tcp-fast-open');
app.commandLine.appendSwitch('disk-cache-size', '536870912');
app.commandLine.appendSwitch('media-cache-size', '268435456');
app.commandLine.appendSwitch('enable-features', 'PasswordManager,Autofill,CanvasOopRasterization,SmoothScrolling,ParallelDownloading,BackForwardCache,AsyncImageDecoding');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
const CHROME_USER_AGENT = chromeSessionUserAgent();
app.userAgentFallback = CHROME_USER_AGENT;

let mainWindow: BrowserWindow | null = null;
let tabHost: NativeTabHost | null = null;
let capsuleManager: WorkspaceCapsuleManager | null = null;
let bridgeServer: BridgeServer | null = null;
let mcpServer: AntiFanMcpServer | null = null;
let windowStateManager: WindowStateManager | null = null;
let controlPlane: ControlPlaneRuntime | null = null;
let profileLease: ProfileLease | null = null;
// Enforce single instance lock (except in pure MCP server child mode)
if (!IS_MCP_SERVER) {
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
}

// Benchmark-mode-only telemetry (ANTIFAN_BENCHMARK=1 / --benchmark). Disabled
// in normal startup; emits startup milestones and event-loop delay samples.
const ownsElectronInstance = IS_MCP_SERVER || app.hasSingleInstanceLock();
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
  
  windowStateManager = new WindowStateManager(persistentUserData, 1360, 880);
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

  tabHost = new NativeTabHost(mainWindow, capsuleManager || undefined);
  const projectId = validateControlPlaneId(process.env.ANTIFAN_PROJECT_ID || 'project-00000000-0000-4000-8000-000000000001', 'project');
  const workspaceId = validateControlPlaneId(process.env.ANTIFAN_WORKSPACE_ID || 'workspace-00000000-0000-4000-8000-000000000001', 'workspace');
  controlPlane = new ControlPlaneRuntime({
    projectId,
    workspaceId,
    dataRoot: path.join(persistentUserData, 'control-plane-v2'),
    allowEval: IS_MCP_HIGH_RISK,
    getDocumentGeneration: (tabId) => tabHost!.getDocumentGeneration(tabId),
    getAutomationTabId: () => tabHost!.getAutomationTabId(),
  });
  tabHost.setControlPlane(controlPlane);
  controlPlane.registerBrowser(new BrowserControlPort({
    getTabList: () => tabHost!.getTabList(),
    getActiveTabId: () => tabHost!.getActiveTabId(),
    getAutomationTabId: () => tabHost!.getAutomationTabId(),
    setAutomationTabId: (tabId) => tabHost!.setAutomationTabId(tabId),
    createTab: (url, activate = false) => tabHost!.createTab(url, activate),
    closeTab: (tabId) => tabHost!.closeTab(tabId),
    switchTab: (tabId) => tabHost!.switchTab(tabId),
    navigate: (tabId, url) => tabHost!.navigateAndWait(tabId, url),
    reload: (tabId) => tabHost!.reloadAndWait(tabId),
    getDom: (selector, tabId, paneId) => tabHost!.getDom(selector, tabId, paneId),
    captureScreenshot: (rect, tabId, paneId) => tabHost!.captureScreenshot(rect as any, tabId, paneId),
    evalJs: (expression, tabId, paneId) => tabHost!.evalJs(expression, tabId, paneId),
    getDiagnostics: (tabId, level) => tabHost!.getDiagnostics(tabId, level),
    runResponsiveCheck: (tabId) => tabHost!.runResponsiveCheck(tabId),
    agentTrajectory: (params) => tabHost!.agentTrajectory(params),
    agentMove: (args) => tabHost!.agentMove(args),
    agentClick: (params) => tabHost!.agentClick(params),
    agentType: (params) => tabHost!.agentType(params),
    agentScroll: (params) => tabHost!.agentScroll(params),
    agentHover: (params) => tabHost!.agentHover(params),
    agentHighlight: (params) => tabHost!.agentHighlight(params),
    agentClear: (tabId, paneId) => tabHost!.agentClear(tabId, paneId),
    agentSnapshot: (tabId, paneId) => tabHost!.agentSnapshot(tabId, paneId),
    sendKeyboardPress: (params) => tabHost!.sendKeyboardPress(params),
    setViewportSize: (options) => tabHost!.setViewportSize(options),
    setDevicePreset: (tabId, presetId) => tabHost!.setDevicePreset(tabId, presetId),
    getDevicePresets: () => tabHost!.getDevicePresets(),
    setZoom: (tabId, zoomFactor) => tabHost!.setZoom(tabId, zoomFactor),
    toggleInspect: () => tabHost!.toggleInspect(),
    isCurrentTarget: (target) => tabHost!.isCurrentTarget(target),
    clearAllAgentWorking: () => tabHost!.clearAllAgentWorking(),
    getDocumentGeneration: (tabId) => tabHost!.getDocumentGeneration(tabId),
  }));
  const capabilityTransport = new CapabilityTransportAdapter(controlPlane.capabilities);

  // Set Top Menubar (File, Edit, Selection, View, Go, Run, Terminal, Help)
  Menu.setApplicationMenu(buildApplicationMenu(mainWindow, tabHost));

  // Check URL from command line arguments or restore tabs
  const initialUrl = process.argv.find((arg) => (arg.startsWith('http://') || arg.startsWith('https://')) && !arg.includes('localhost:20128') && !arg.includes('localhost:20129') && !arg.includes('localhost:20130'));
  tabHost.restoreTabs(initialUrl);

  // Start Bridge Server
  bridgeServer = new BridgeServer(
    tabHost,
    IS_PROD ? 20129 : 20130,
    IS_DEV,
    capabilityTransport,
    () => {
      const lease = controlPlane!.getLease();
      const activeTab = tabHost!.getActiveTab();
      return {
        lease,
        projectId,
        workspaceId,
        browserTarget: activeTab ? {
          projectId,
          workspaceId,
          runtimeId: lease.runtimeId,
          tabId: activeTab.id,
          browserEpoch: 1,
          documentGeneration: tabHost!.getDocumentGeneration(activeTab.id),
          url: activeTab.url,
        } : undefined,
      };
    },
    controlPlane.runs.attachments,
    '127.0.0.1',
    controlPlane
  );
  bridgeServer.setControlPlane(controlPlane);
  const bridgePort = await bridgeServer.start();
  console.log(`[antifan] Bridge Server running on 127.0.0.1:${bridgePort} (${IS_DEV ? 'DEV' : 'PROD'})`);

  // Start MCP Server if requested
  if (IS_MCP_SERVER) {
    console.log('[antifan] Starting stdio MCP server...');
    mcpServer = new AntiFanMcpServer(tabHost, IS_MCP_HIGH_RISK, capabilityTransport, controlPlane.runs.attachments);
    await mcpServer.start();
  }

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
}

app.whenReady().then(async () => {
  if (!ownsElectronInstance) return;
  recordBenchmark({ surface: 'startup', name: 'ready' });
  try {
    profileLease = new ProfileOwnership().acquire(persistentUserData);
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
  const capsuleStoragePath = path.join(app.getPath('userData'), 'workspace-capsules.json');
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
  console.error('[antifan startup failed]', error);
  app.exit(1);
});

let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try {
      TerminalManager.getInstance().persistSync();
    } catch {}
    try {
      HistoryManager.getInstance().persistSync();
    } catch {}
    try {
      await session.defaultSession.cookies.flushStore();
    } catch {}
    try {
      tabHost?.dispose();
    } catch {}
    try {
      bridgeServer?.dispose();
    } catch {}
    try {
      await mcpServer?.stop();
    } catch {}
    try {
      await TerminalManager.getInstance().dispose();
    } catch {}
    try {
      profileLease?.markCleanShutdown();
      profileLease?.release();
      profileLease = null;
    } catch {}
  })();
  return shutdownPromise;
}

app.on('window-all-closed', async () => {
  await shutdown();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let isShuttingDown = false;
app.on('before-quit', (event) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  event.preventDefault();
  shutdown().finally(() => {
    app.quit();
  });
});
app.on('will-quit', () => {
  bridgeServer?.dispose();
  tabHost?.dispose();
  profileLease?.release();
  profileLease = null;
  benchmarkStopEventLoop?.();
  recordBenchmark({ surface: 'startup', name: 'shutdown' });
  recordProcessMetrics('atShutdown');
});
