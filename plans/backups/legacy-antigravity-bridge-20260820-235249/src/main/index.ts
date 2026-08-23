/**
 * AntiFan Browser Desktop — Main Electron Bootstrap Entry Point
 * High-performance, ultra-lightweight Chromium host and Extension Bridge companion.
 */
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, Menu, session } from 'electron';
import { NativeTabHost } from './browser/native-tab-host';
import { BridgeServer } from './bridge/bridge-server';
import { AntiFanMcpServer } from './mcp/mcp-server';
import { CookiePersister } from './browser/cookie-persister';
import { buildApplicationMenu } from './browser/app-menu';
import { WindowStateManager } from './browser/window-state';
import { googleAuthUserAgent, isGoogleAuthUrl, setUserAgentHeader, stripClientHints } from './browser/google-auth-identity';
import { ControlPlaneRuntime } from './control-plane/control-plane-runtime';
import { BrowserControlPort } from './tools/browser-control-port';
import { CapabilityTransportAdapter } from './tools/capability-transport';
import { validateControlPlaneId } from '../shared/control-plane-contracts';

process.on('uncaughtException', (err) => {
  console.error('[antifan uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[antifan unhandledRejection]', reason);
});

const IS_PROD = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const IS_DEV = !IS_PROD;
const IS_MCP_SERVER = process.argv.includes('--mcp-server');
const IS_MCP_HIGH_RISK = process.argv.includes('--mcp-high-risk');

// Configure dedicated persistent Chromium user data path for Dev vs Prod
const profileFolder = IS_PROD ? 'Chromium-prod' : 'Chromium-dev';
const persistentUserData = path.join(process.cwd(), 'appdata', 'antigravity-browser-desktop', profileFolder);
app.setPath('userData', persistentUserData);

if (IS_DEV) {
  app.name = 'AntiFan Browser Desktop (Dev)';
} else {
  app.name = 'AntiFan Browser Desktop';
}

// Configure high-performance Chromium hardware acceleration and security switches
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('enable-features', 'PasswordManager,Autofill,CanvasOopRasterization,SmoothScrolling');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const CHROME_VERSION = process.versions.chrome || '134.0.0.0';
const CHROME_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
app.userAgentFallback = CHROME_USER_AGENT;

let mainWindow: BrowserWindow | null = null;
let tabHost: NativeTabHost | null = null;
let bridgeServer: BridgeServer | null = null;
let windowStateManager: WindowStateManager | null = null;
let controlPlane: ControlPlaneRuntime | null = null;

// Enforce single instance lock (except in pure MCP server child mode)
if (!IS_MCP_SERVER) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    console.log(`[antifan] Another instance is already running (${IS_DEV ? 'DEV' : 'PROD'}). Exiting.`);
    app.quit();
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

  tabHost = new NativeTabHost(mainWindow);
  const projectId = validateControlPlaneId(process.env.ANTIFAN_PROJECT_ID || 'project-00000000-0000-4000-8000-000000000001', 'project');
  const workspaceId = validateControlPlaneId(process.env.ANTIFAN_WORKSPACE_ID || 'workspace-00000000-0000-4000-8000-000000000001', 'workspace');
  controlPlane = new ControlPlaneRuntime({ projectId, workspaceId, dataRoot: path.join(persistentUserData, 'control-plane-v2'), allowEval: IS_MCP_HIGH_RISK });
  controlPlane.registerBrowser(new BrowserControlPort({
    getTabList: () => tabHost!.getTabList(),
    navigate: (tabId, url) => tabHost!.navigate(tabId, url),
    reload: (tabId) => tabHost!.reload(tabId),
    getDom: (selector) => tabHost!.getDom(selector),
    captureScreenshot: () => tabHost!.captureScreenshot(),
    evalJs: (expression) => tabHost!.evalJs(expression),
    isCurrentTarget: (target) => tabHost!.isCurrentTarget(target),
  }));
  const capabilityTransport = new CapabilityTransportAdapter(controlPlane.capabilities);

  // Set Top Menubar (File, Edit, Selection, View, Go, Run, Terminal, Help)
  Menu.setApplicationMenu(buildApplicationMenu(mainWindow, tabHost));

  // Check URL from command line arguments or restore tabs
  const initialUrl = process.argv.find((arg) => (arg.startsWith('http://') || arg.startsWith('https://')) && !arg.includes('localhost:20128') && !arg.includes('localhost:20129') && !arg.includes('localhost:20130'));
  tabHost.restoreTabs(initialUrl);

  // Start Bridge Server
  bridgeServer = new BridgeServer(tabHost, IS_PROD ? 20129 : 20130, IS_DEV, capabilityTransport, () => {
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
  });
  const bridgePort = await bridgeServer.start();
  console.log(`[antifan] Bridge Server running on 127.0.0.1:${bridgePort} (${IS_DEV ? 'DEV' : 'PROD'})`);

  // Start MCP Server if requested
  if (IS_MCP_SERVER) {
    console.log('[antifan] Starting stdio MCP server...');
    const mcpServer = new AntiFanMcpServer(tabHost, IS_MCP_HIGH_RISK, capabilityTransport);
    await mcpServer.start();
  }

  if (winBounds.isMaximized) {
    mainWindow.maximize();
  } else if (typeof winBounds.x !== 'number' || typeof winBounds.y !== 'number') {
    mainWindow.center();
  }

  mainWindow.show();
  mainWindow.focus();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Set real Chrome User Agent across session to allow Google/Gmail OAuth login without "insecure browser" blocking
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      if (isGoogleAuthUrl(details.url)) {
        const headers = { ...details.requestHeaders };
        setUserAgentHeader(headers, googleAuthUserAgent());
        stripClientHints(headers);
        callback({ requestHeaders: headers });
        return;
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // Restore persistent storefront, Haravan, and session cookies
  await CookiePersister.getInstance().restoreCookies();
  CookiePersister.getInstance().startAutoPersistence();

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  try {
    await session.defaultSession.cookies.flushStore();
  } catch {}
});

app.on('will-quit', () => {
  bridgeServer?.dispose();
  tabHost?.dispose();
});
