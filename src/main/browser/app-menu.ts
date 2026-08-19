/**
 * AntiFan Browser Desktop — Application Menu System
 * Provides standard VS Code style top Menubar: File, Edit, Selection, View, Go, Run, Terminal, Help
 * Includes "Check for Updates / Hot Recompile & Restart" functionality.
 */
import { app, dialog, Menu, MenuItemConstructorOptions, BrowserWindow } from 'electron';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NativeTabHost } from './native-tab-host';

function getPendingSourceModifications(srcDir: string, compiledDir: string): string[] {
  const modifiedFiles: string[] = [];
  if (!fs.existsSync(srcDir)) return modifiedFiles;

  function scan(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.ts', '.js', '.html', '.css', '.json', '.mjs', '.cjs'].includes(ext)) {
          const relPath = path.relative(srcDir, fullPath);
          const compiledJs = path.join(compiledDir, relPath.replace(/\.ts$/, '.js'));
          const compiledRaw = path.join(compiledDir, relPath);
          const targetCompiled = fs.existsSync(compiledJs) ? compiledJs : (fs.existsSync(compiledRaw) ? compiledRaw : null);

          if (!targetCompiled) {
            modifiedFiles.push(`src/${relPath.replace(/\\/g, '/')}`);
          } else {
            const srcStat = fs.statSync(fullPath);
            const compStat = fs.statSync(targetCompiled);
            if (srcStat.mtimeMs > compStat.mtimeMs + 500) {
              modifiedFiles.push(`src/${relPath.replace(/\\/g, '/')}`);
            }
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
    '- Message Copy and Undo Edit in Sidebar Chat',
    '- Stop / Pause active Agent turn with 1-click',
    '- Clean Image Lightbox zoom viewer without extra buttons',
    '- Transparent Omnibox Search Suggestion dropdown overlay',
    '- Ctrl+T (New Tab) and Ctrl+Shift+T (Reopen Closed Tab)',
    '- Terminal Shell profiles (PowerShell, CMD, Git Bash)',
    '- Session Locking (prevent chat jumping when IDE runs in background)',
    '- Deterministic DOM selector verification and auto queue processing',
  ].join('\n');

  if (modified.length === 0) {
    const choice = dialog.showMessageBoxSync(window || (undefined as any), {
      type: 'info',
      buttons: ['OK', 'Force Recompile and Restart'],
      defaultId: 0,
      cancelId: 0,
      title: 'Check for Updates',
      message: 'AntiFan Browser Desktop is Up to Date',
      detail: `All components are running the latest compiled build.\n\nCurrent Release Features and Changelog:\n${curatedChangelog}`,
    });

    if (choice !== 1) return;
  } else {
    const fileListPreview = modified.slice(0, 6).map((f) => `  - ${f}`).join('\n') + (modified.length > 6 ? `\n  ... and ${modified.length - 6} more file(s)` : '');

    const choice = dialog.showMessageBoxSync(window || (undefined as any), {
      type: 'question',
      buttons: ['Compile and Restart Now', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Updates Available',
      message: `New Updates Detected (${modified.length} modified file(s))`,
      detail: `Pending source code changes detected:\n${fileListPreview}\n\nChangelog for this update:\n${curatedChangelog}\n\nWould you like to compile and restart now?`,
    });

    if (choice !== 0) return;
  }

  cp.exec('npm run compile', { cwd }, (err) => {
    if (err) {
      dialog.showErrorBox('Update / Recompile Failed', `Failed to compile source code:\n\n${err.message}`);
      return;
    }
    app.relaunch();
    app.exit(0);
  });
}

export function buildApplicationMenu(mainWindow: BrowserWindow, tabHost?: NativeTabHost | null): Menu {
  const isMac = process.platform === 'darwin';

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
          click: () => tabHost?.captureScreenshot(),
        },
        {
          label: 'Capture Full Page Screenshot',
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

    // 3. Selection Menu
    {
      label: 'Selection',
      submenu: [
        {
          label: 'Quick Inspect (Annotate DOM)',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => tabHost?.toggleInspect(),
        },
        {
          label: 'Font Finder',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => tabHost?.toggleFontFinder(),
        },
        {
          label: 'Color Lens Zoom Glass',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => tabHost?.toggleLens(),
        },
        {
          label: 'Precision Ruler',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => tabHost?.toggleRuler(),
        },
      ],
    },

    // 4. View Menu
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
          label: 'Force Reload Page',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (tabHost) tabHost.reload(tabHost.getActiveTabId());
          },
        },
        { type: 'separator' },
        {
          label: 'Toggle AI Sidebar Chat',
          accelerator: 'CmdOrCtrl+B',
          click: () => tabHost?.toggleSidebar(),
        },
        {
          label: 'Toggle Bookmarks Bar',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => tabHost?.toggleBookmarkBar(),
        },
        {
          label: 'Toggle Terminal Drawer',
          accelerator: 'CmdOrCtrl+`',
          click: () => tabHost?.toggleTerminal(),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'F12',
          click: () => tabHost?.toggleDevTools(),
        },
      ],
    },

    // 5. Go Menu
    {
      label: 'Go',
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
      ],
    },

    // 6. Run Menu
    {
      label: 'Run',
      submenu: [
        {
          label: '🔄 Recompile & Restart App',
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => checkForUpdatesAndRestart(mainWindow),
        },
        {
          label: 'Clear Cookies & Cache for this site',
          click: () => tabHost?.clearStorageForActiveTab(),
        },
      ],
    },

    // 7. Terminal Menu
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Toggle Terminal Drawer',
          accelerator: 'CmdOrCtrl+`',
          click: () => tabHost?.toggleTerminal(),
        },
      ],
    },

    // 8. Help Menu
    {
      label: 'Help',
      submenu: [
        {
          label: '🔄 Check for Updates... (Recompile & Restart)',
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => checkForUpdatesAndRestart(mainWindow),
        },
        { type: 'separator' },
        {
          label: 'Open in System Browser',
          click: () => tabHost?.openExternal(),
        },
        {
          label: 'Keyboard Shortcuts...',
          click: () => tabHost?.showShortcuts(),
        },
        { type: 'separator' },
        {
          label: 'About AntiFan Browser Desktop',
          click: () => {
            dialog.showMessageBoxSync(mainWindow, {
              type: 'info',
              title: 'About AntiFan Browser Desktop',
              message: 'AntiFan Browser Desktop',
              detail: 'Version: 1.0.0\nPlatform: Electron + Chromium\nEngine: Antigravity AI Bridge & Haravan Multi-Platform Engine',
            });
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
