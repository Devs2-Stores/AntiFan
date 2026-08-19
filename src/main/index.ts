/**
 * AntiFan Browser Desktop — Main Electron Bootstrap Entry Point
 * High-performance, ultra-lightweight Chromium host and Extension Bridge companion.
 */
import * as path from 'path';
import { app, BrowserWindow, Menu, session } from 'electron';
import { NativeTabHost } from './browser/native-tab-host';
import { BridgeServer } from './bridge/bridge-server';
import { AntiFanMcpServer } from './mcp/mcp-server';
import { CookiePersister } from './browser/cookie-persister';

process.on('uncaughtException', (err) => {
  console.error('[antifan uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[antifan unhandledRejection]', reason);
});

// Configure dedicated persistent Chromium user data path
const persistentUserData = path.join(process.cwd(), 'appdata', 'antigravity-browser-desktop', 'Chromium');
app.setPath('userData', persistentUserData);

// Configure Chromium command line switches for password & form auto-retention
app.commandLine.appendSwitch('enable-features', 'PasswordManager,Autofill');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
app.userAgentFallback = CHROME_USER_AGENT;

const IS_MCP_SERVER = process.argv.includes('--mcp-server');
const IS_MCP_HIGH_RISK = process.argv.includes('--mcp-high-risk');

let mainWindow: BrowserWindow | null = null;
let tabHost: NativeTabHost | null = null;
let bridgeServer: BridgeServer | null = null;

// Remove native OS menu bar for clean modern browser look
Menu.setApplicationMenu(null);

// Enforce single instance lock (except in pure MCP server child mode)
if (!IS_MCP_SERVER) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    console.log('[antifan] Another instance is already running. Exiting.');
    app.quit();
  } else {
    app.on('second-instance', (_event, commandLine) => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();

        const urlArg = commandLine.find((arg) => (arg.startsWith('http://') || arg.startsWith('https://')) && !arg.includes('localhost:20128'));
        if (urlArg && tabHost) {
          tabHost.createTab(urlArg);
        }
      }
    });
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    title: 'AntiFan Browser Desktop',
    width: 1360,
    height: 880,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#080c14',
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  tabHost = new NativeTabHost(mainWindow);

  // Check URL from command line arguments or restore tabs
  const initialUrl = process.argv.find((arg) => (arg.startsWith('http://') || arg.startsWith('https://')) && !arg.includes('localhost:20128'));
  tabHost.restoreTabs(initialUrl);

  // Start Bridge Server
  bridgeServer = new BridgeServer(tabHost);
  const bridgePort = await bridgeServer.start();
  console.log(`[antifan] Bridge Server running on 127.0.0.1:${bridgePort}`);

  // Start MCP Server if requested
  if (IS_MCP_SERVER) {
    console.log('[antifan] Starting stdio MCP server...');
    const mcpServer = new AntiFanMcpServer(tabHost, IS_MCP_HIGH_RISK);
    await mcpServer.start();
  }

  mainWindow.center();
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
      const headers = { ...details.requestHeaders };
      headers['User-Agent'] = CHROME_USER_AGENT;
      headers['Sec-CH-UA'] = '"Chromium";v="134", "Google Chrome";v="134", "Not_A Brand";v="24"';
      headers['Sec-CH-UA-Mobile'] = '?0';
      headers['Sec-CH-UA-Platform'] = '"Windows"';
      delete headers['X-Requested-With'];
      callback({ requestHeaders: headers });
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
