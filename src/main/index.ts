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
import { CookiePersister } from './browser/cookie-persister';
import { buildApplicationMenu } from './browser/app-menu';
import { WindowStateManager } from './browser/window-state';
import { googleAuthUserAgent, isGoogleAuthUrl, setUserAgentHeader, setChromeClientHints, cleanCorruptedGoogleCookies } from './browser/google-auth-identity';
import { ControlPlaneRuntime } from './control-plane/control-plane-runtime';
import { BrowserControlPort } from './tools/browser-control-port';
import { CapabilityTransportAdapter } from './tools/capability-transport';
import { validateControlPlaneId } from '../shared/control-plane-contracts';
import { ProfileOwnership, ProfileOwnershipError, type ProfileLease } from './browser/profile-ownership';

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

// Configure persistent Chromium user data path (shared across Desktop shortcut & dev launch)
const profileFolder = 'Chromium-dev';
const appRoot = app.getAppPath();
const persistentUserData = path.join(appRoot, 'appdata', 'antifan-browser-desktop', profileFolder);
const chromiumCachePath = path.join(appRoot, 'appdata', 'antifan-browser-desktop', `${profileFolder}-cache`);
try { fs.mkdirSync(chromiumCachePath, { recursive: true }); } catch {}
app.setPath('userData', persistentUserData);
app.setPath('cache', chromiumCachePath);
app.commandLine.appendSwitch('disk-cache-dir', path.join(chromiumCachePath, 'network'));
app.commandLine.appendSwitch('gpu-cache-dir', path.join(chromiumCachePath, 'gpu'));

app.name = 'AntiFan Browser Desktop';

app.commandLine.appendSwitch('force-dark-mode');
nativeTheme.themeSource = 'dark';

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
const CHROME_USER_AGENT = googleAuthUserAgent();
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

const ownsElectronInstance = IS_MCP_SERVER || app.hasSingleInstanceLock();

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
  try {
    profileLease = new ProfileOwnership({ force: ownsElectronInstance }).acquire(persistentUserData);
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
  // Set real Chrome User Agent across session to allow Google/Gmail OAuth login without "insecure browser" blocking
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      delete headers['X-Electron-Version'];
      delete headers['X-Antifan-Version'];
      setUserAgentHeader(headers, CHROME_USER_AGENT);
      setChromeClientHints(headers);
      callback({ requestHeaders: headers });
    }
  );
  // Clean any corrupted Google cookies from previous sessions
  await cleanCorruptedGoogleCookies(session.defaultSession);

  // Restore persistent storefront, Haravan, and session cookies
  await CookiePersister.getInstance().restoreCookies();
  CookiePersister.getInstance().startAutoPersistence();
  const capsuleStoragePath = path.join(app.getPath('userData'), 'workspace-capsules.json');
  capsuleManager = new WorkspaceCapsuleManager({ filePath: capsuleStoragePath });
  if (!capsuleManager.getActive()) {
    const defaultDir = fs.existsSync('E:/Work') ? 'E:/Work' : (fs.existsSync('E:\\Work') ? 'E:\\Work' : process.cwd());
    capsuleManager.create('Default Workspace', defaultDir);
  }
  registerPreviewProtocolHandler(capsuleManager);
  await createWindow();

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
      await CookiePersister.getInstance().saveAllCookies();
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

app.on('before-quit', (event) => {
  if (!shutdownPromise) {
    event.preventDefault();
    shutdown().finally(() => {
      app.quit();
    });
  }
});
app.on('will-quit', () => {
  bridgeServer?.dispose();
  tabHost?.dispose();
  profileLease?.release();
  profileLease = null;
});
