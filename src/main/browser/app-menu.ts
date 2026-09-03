/**
 * AntiFan Browser Desktop — Modern Application Menu System
 * Clean, organized top menubar tailored for AntiFan Browser Desktop:
 * File, Edit, View, Browser, Tools, Terminal, Help
 */
import { app, dialog, Menu, MenuItemConstructorOptions, BrowserWindow, shell, clipboard } from 'electron';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NativeTabHost } from './native-tab-host';
import { ChromeProfileSyncManager } from './chrome-profile-sync';
import { TerminalManager } from './terminal-manager';
function getPendingSourceModifications(srcDir: string, compiledDir: string): string[] {
  const modifiedFiles: string[] = [];
  if (!fs.existsSync(srcDir)) return modifiedFiles;

  function scan(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.css') || entry.name.endsWith('.html'))) {
        const relative = path.relative(srcDir, fullPath);
        const compiledPath = path.join(compiledDir, relative.replace(/\.ts$/, '.js'));

        if (!fs.existsSync(compiledPath)) {
          modifiedFiles.push(relative);
        } else {
          const srcStat = fs.statSync(fullPath);
          const compStat = fs.statSync(compiledPath);
          if (srcStat.mtimeMs > compStat.mtimeMs + 100) {
            modifiedFiles.push(relative);
          }
        }
      }
    }
  }

  try {
    scan(srcDir);
  } catch {}
  return modifiedFiles;
}

export function checkForUpdatesAndRestart(window?: BrowserWindow | null): void {
  const cwd = process.cwd();
  const srcDir = path.join(cwd, 'src');
  const compiledDir = path.join(cwd, '.compiled', 'src');

  const modified = getPendingSourceModifications(srcDir, compiledDir);

  const curatedChangelog = [
    '• Terminal Workbench: Multi-session, split-screen AI Agent runner & pop-out window',
    '• Google Auth & Login: Real Chrome User-Agent & Client Hints security spoofing',
    '• Quick Inspect DOM: Instant inline comment modal for AI Agent workflow',
    '• Font Finder: High-precision typography inspector & CSS typography extractor',
    '• Bookmarks & Chrome Sync: Persistent bookmarks & Chrome profile integration',
    '• Capture Viewport: Instant high-DPI screenshot copied to clipboard',
  ].join('\n');

  if (modified.length === 0) {
    const choice = dialog.showMessageBoxSync(window || (null as any), {
      type: 'info',
      title: 'AntiFan Update System',
      message: 'Mã nguồn đã được biên dịch hoàn chỉnh!',
      detail: `Tất cả file nguồn đã sẵn sàng.\n\nTính năng mới:\n${curatedChangelog}\n\nBạn có muốn khởi động lại ứng dụng ngay để áp dụng phiên bản mới nhất không?`,
      buttons: ['Khởi động lại ngay', 'Biên dịch lại từ đầu (Force Recompile)', 'Đóng'],
      defaultId: 0,
      cancelId: 2,
    });

    if (choice === 0) {
      try {
        TerminalManager.getInstance().persistSync();
      } catch {}
      app.relaunch();
      app.exit(0);
      return;
    }

    if (choice !== 1) {
      return;
    }
  }

  const fileList = modified.slice(0, 8).map((f) => `  - ${f}`).join('\n') + (modified.length > 8 ? `\n  ... và ${modified.length - 8} file khác` : '');

  const choice = dialog.showMessageBoxSync(window || null as any, {
    type: 'question',
    title: 'Phát hiện mã nguồn đã cập nhật',
    message: `Tìm thấy ${modified.length} file mã nguồn đã thay đổi. Bạn có muốn biên dịch lại và khởi động lại ngay không?`,
    detail: `File đã thay đổi:\n${fileList}\n\nChangelog mới nhất:\n${curatedChangelog}`,
    buttons: ['Biên dịch & Khởi động lại ngay', 'Bỏ qua'],
    defaultId: 0,
    cancelId: 1,
  });

  if (choice !== 0) return;

  cp.exec('npm run compile', { cwd }, (err) => {
    if (err) {
      dialog.showErrorBox('Lỗi biên dịch', `Không thể biên dịch mã nguồn:\n${err.message}`);
      return;
    }
    try {
      TerminalManager.getInstance().persistSync();
    } catch {}
    app.relaunch();
    app.exit(0);
  });
}

export function buildApplicationMenu(mainWindow: BrowserWindow, tabHost?: NativeTabHost | null): Menu {
  const isMac = process.platform === 'darwin';

  const chromeProfiles = ChromeProfileSyncManager.getInstance().getAvailableProfiles();
  const profileSubmenu: MenuItemConstructorOptions[] = chromeProfiles.length > 0
    ? chromeProfiles.map((p) => ({
        label: `Sync: ${p.name} (${p.id})`,
        click: async () => {
          const targetSession = tabHost?.getActiveTabSession();
          const res = await ChromeProfileSyncManager.getInstance().syncProfile(p.id, targetSession);
          const bm = ChromeProfileSyncManager.getInstance().getChromeBookmarks(p.id);
          if (bm.length > 0 && tabHost) {
            tabHost.bookmarks = bm.map((b) => ({ id: b.url, title: b.title, url: b.url, createdAt: Date.now() }));
            tabHost.broadcastState();
          }
          dialog.showMessageBox(mainWindow, {
            type: res.success ? 'info' : 'warning',
            title: 'Chrome Profile Sync',
            message: res.message,
          });
        },
      }))
    : [{ label: 'Không tìm thấy Chrome Profile', enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    // 1. File Menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => tabHost?.createTab('https://www.google.com'),
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => tabHost?.reopenClosedTab(),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (tabHost) {
              tabHost.closeTab(tabHost.getActiveTabId());
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Capture Viewport Screenshot',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => tabHost?.captureScreenshot(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
      ],
    },

    // 2. Edit Menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },

    // 3. View Menu
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (tabHost) tabHost.reload(tabHost.getActiveTabId());
          },
        },
        {
          label: 'Reload Page (F5)',
          accelerator: 'F5',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => {
            if (tabHost) tabHost.reload(tabHost.getActiveTabId());
          },
        },
        {
          label: 'Force Reload Page',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (tabHost) tabHost.reload(tabHost.getActiveTabId());
          },
        },
        {
          label: 'Toggle Bookmarks Bar',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => tabHost?.toggleBookmarkBar(),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        {
          label: 'Toggle Full Screen',
          accelerator: 'F11',
          click: () => tabHost?.toggleFullScreen(),
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => tabHost?.toggleDevTools(),
        },
        {
          label: 'Toggle Developer Tools (F12)',
          accelerator: 'F12',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => tabHost?.toggleDevTools(),
        },
      ],
    },

    // 4. Browser Menu
    {
      label: 'Browser',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => {
            if (tabHost) tabHost.goBack(tabHost.getActiveTabId());
          },
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => {
            if (tabHost) tabHost.goForward(tabHost.getActiveTabId());
          },
        },
        {
          label: 'Home',
          click: () => {
            if (tabHost) tabHost.navigate(tabHost.getActiveTabId(), 'https://www.google.com');
          },
        },
        { type: 'separator' },
        {
          label: 'Bookmark This Tab',
          accelerator: 'CmdOrCtrl+D',
          click: () => tabHost?.bookmarkActiveTab(),
        },
        {
          label: 'Sync Google Chrome Profile',
          submenu: profileSubmenu,
        },
        { type: 'separator' },
        {
          label: 'Clear Cookies & Site Cache',
          click: () => tabHost?.clearStorageForActiveTab(),
        },
        {
          label: 'Open in System Browser',
          click: () => tabHost?.openExternal(),
        },
      ],
    },

    // 5. Tools Menu
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Quick Inspect DOM (Annotate)',
          accelerator: 'CmdOrCtrl+B',
          click: () => tabHost?.toggleInspect(),
        },
        {
          label: 'Font Finder (Inspect Typography)',
          click: () => tabHost?.toggleFontFinder(),
        },
        {
          label: 'GPU Lens Zoom Glass',
          accelerator: 'CmdOrCtrl+Alt+L',
          click: () => tabHost?.toggleLens(),
        },
        {
          label: 'Precision Ruler & Layout Grid',
          click: () => tabHost?.toggleRuler(),
        },
        { type: 'separator' },
        {
          label: 'Find in Page...',
          accelerator: 'CmdOrCtrl+F',
          click: () => tabHost?.focusFindBar(),
        },
      ],
    },

    // 6. Terminal Menu
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Toggle Sidebar Terminal',
          accelerator: 'CmdOrCtrl+Alt+B',
          click: () => tabHost?.toggleSidebar(),
        },
        {
          label: 'Toggle Terminal Workbench',
          accelerator: 'CmdOrCtrl+`',
          click: () => tabHost?.toggleSidebar(),
        },
        {
          label: 'Pop out Terminal Workbench',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => tabHost?.togglePopoutTerminal(),
        },
      ],
    },

    // 7. Help Menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'Developer: Reload Window (Hot Reload UI)',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => tabHost?.reloadWindow(),
        },
        {
          label: 'Developer: Recompile & Restart App',
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => checkForUpdatesAndRestart(mainWindow),
        },
        { type: 'separator' },
        {
          label: 'Keyboard Shortcuts...',
          click: () => tabHost?.showShortcuts(),
        },
        {
          label: 'Open in System Browser',
          click: () => tabHost?.openExternal(),
        },
        { type: 'separator' },
        {
          label: 'About AntiFan Browser Desktop',
          click: () => {
            dialog.showMessageBoxSync(mainWindow, {
              type: 'info',
              title: 'About AntiFan Browser Desktop',
              message: 'AntiFan Browser Desktop',
              detail: 'Version: 1.0.0\nPlatform: Electron + Chromium\nEngine: Antigravity AI Bridge & Haravan Multi-Platform Engine\nTerminal AI Workbench: Enabled',
            });
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
