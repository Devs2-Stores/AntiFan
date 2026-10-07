/**
 * AntiFan Browser Desktop — Modern Application Menu System
 * Clean, organized top menubar tailored for AntiFan Browser Desktop:
 * File, Edit, View, Browser, Tools, Terminal, Help
 */
import { app, dialog, Menu, MenuItemConstructorOptions, BrowserWindow, shell, clipboard, safeStorage } from 'electron';
import type { BaseWindow } from 'electron';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NativeTabHost } from './native-tab-host';
import { ChromeProfileSyncManager } from './chrome-profile-sync';
import { TerminalManager } from './terminal-manager';
import { LocalSessionVault } from './local-session-vault';
import { LocalCredentialVault } from './local-credential-vault';
import { parseOwnerKey } from '../project/project-context';
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

export function checkForUpdatesAndRestart(window?: BaseWindow | null): void {
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

export interface ApplicationMenuOptions {
  /**
   * Which window's host an application-menu command acts on. A native menu click
   * carries no renderer sender, but it does carry the window the user clicked in,
   * and for the user's own action that focused window is legitimate evidence of
   * which window they meant: the window directory answers with its host.
   *
   * Omitting the resolver keeps the passed host for every command, which is what a
   * single-window caller already relies on.
   */
  resolveHostForWindow?: (window: BrowserWindow | null) => NativeTabHost | null;
  /**
   * Main's project-opening surface, injected by the process that owns the registry.
   *
   * A menu click carries no renderer sender, so Main cannot be reached the way a chrome
   * channel is; the window the user clicked in is passed instead, which is what makes the
   * dialog modal to that window. Omitting the callback leaves the entry visibly disabled
   * rather than offering an action that would do nothing.
   */
  openProjectPicker?: (window: BrowserWindow | null) => void;
  /**
   * Main's shared-terminal-manager surface: the Unassigned window, whose sidebar is the one
   * terminal list that reaches every project and where a row is filed under another capsule.
   *
   * No chrome route opens that window kind — a renderer that could ask would be asking for a
   * window no project owns — so a native menu click, which reaches Main directly, is what makes
   * the manager reachable at all. Omitting the callback leaves the entry visibly disabled rather
   * than offering an action that would do nothing.
   */
  openSharedTerminalManager?: (window: BrowserWindow | null) => void;
  /**
   * Main's project-detach surface: move the project a window currently presents into
   * its own `project:<id>` shell. Receives the project id the clicked window's host
   * is presenting — `null` or a non-detachable scope disables the entry rather than
   * offering an action that would do nothing. Omitting the callback leaves the entry
   * visibly disabled.
   */
  detachProject?: (projectId: string, window: BrowserWindow | null) => void;
  /**
   * Main's project-reattach surface: close a detached `project:<id>` shell through the
   * close coordinator, fold its owner record into the hub's, and land the rows live.
   * The click is scoped by the clicked window's OWN key — a detached window's host
   * presents no active project, so `activeProject()` could never reach this action.
   * Omitting the callback leaves the entry visibly disabled.
   */
  reattachProject?: (projectId: string, window: BrowserWindow | null) => void;
}

/**
 * The host an application-menu command runs against. With a resolver, the focused
 * window decides — and a window the directory cannot resolve refuses the command
 * instead of running it against another window. Without one, the caller's own host
 * answers, exactly as it did before this seam existed.
 */
export function resolveApplicationMenuHost(
  passedHost: NativeTabHost | null | undefined,
  focusedWindow: BaseWindow | null | undefined,
  resolveHostForWindow?: (window: BrowserWindow | null) => NativeTabHost | null
): NativeTabHost | null {
  if (resolveHostForWindow) {
    // Electron reports the click's window as a BaseWindow. Every window this application
    // creates — and therefore every window a host can be registered for — is a
    // BrowserWindow, so the conversion is the identity here; a window that somehow is not
    // one simply matches no registered shell, and the resolver answers null, which
    // refuses the command.
    return resolveHostForWindow(focusedWindow as BrowserWindow | null) ?? null;
  }
  return passedHost ?? null;
}

/**
 * Keyboard fallback for the shell windows whose native menubar is removed
 * (see `ProjectWindowShell`: `setMenu(null)` retires `electron::MenuBar`, which
 * is the only owner of the `RootView::RestoreFocus` calls that can be fed a
 * stale `last_focused_view_tracker_` after a tab WebContentsView is reparented).
 *
 * With the menubar gone the window's menu accelerators are unregistered, so the
 * same commands are dispatched from `before-input-event` instead. The chord table
 * below is deliberately the exact accelerator list `buildApplicationMenu`
 * registers, routed through the same `hostForClick` semantics: the sender's own
 * window — not whichever window the menu was built against — answers for the
 * command.
 */
export interface ApplicationMenuShortcutContext {
  /**
   * The host the sender belongs to, resolved exactly the way `resolveSender`
   * resolves chrome and tab senders. Null hosts keep the chord reserved (consumed,
   * no-op) — same outcome as a menu accelerator that resolves no host.
   */
  host: NativeTabHost | null;
  /** The window the sender lives in, for options callbacks that are window-modal. */
  window: BrowserWindow | null;
  /** The webContents that received the key — zoom roles act on the focused contents. */
  sender: Electron.WebContents;
  /** The same option bag the installed menu was built with. */
  options?: ApplicationMenuOptions;
}

function shortcutChord(input: Electron.Input): string {
  const parts: string[] = [];
  if (input.control) parts.push('Ctrl');
  if (input.meta) parts.push('Meta');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  // Alphabetic keys arrive lowercase or uppercase depending on Shift; the
  // accelerator table names them uppercase, so the letter is normalized while
  // the modifier flags keep the real distinction (Ctrl+Shift+T stays Ctrl+Shift+T).
  const key = /^[a-zA-Z]$/.test(input.key) ? input.key.toUpperCase() : input.key;
  parts.push(key);
  return parts.join('+');
}

/**
 * Run one menu command for a physical keystroke. Returns true when the chord is a
 * registered application accelerator and must not reach the page (caller should
 * `preventDefault`), false when the key is not ours.
 */
export function dispatchApplicationMenuShortcut(input: Electron.Input, ctx: ApplicationMenuShortcutContext): boolean {
  if (input.type !== 'keyDown') return false;
  const { host, options } = ctx;
  const window = ctx.window;
  switch (shortcutChord(input)) {
    // File
    case 'Ctrl+Shift+O':
      options?.openProjectPicker?.(window);
      return true;
    case 'Ctrl+Shift+D': {
      // Detach/reattach toggle: the chord mirrors the two File-menu clicks exactly.
      // A detached `project:` shell has no active project, so its owner key says
      // reattach; a hub window detaches the project it presents.
      const ownerKeyValue = host?.windowOwnerKey() ?? '';
      const owner = parseOwnerKey(ownerKeyValue);
      if (owner.kind === 'project' && owner.projectId) {
        options?.reattachProject?.(owner.projectId, window);
        return true;
      }
      const detachId = host?.activeProject() ?? null;
      if (detachId) options?.detachProject?.(detachId, window);
      return true;
    }
    case 'Ctrl+T':
      host?.createTab('https://www.google.com');
      return true;
    case 'Ctrl+Shift+T':
      host?.reopenClosedTab();
      return true;
    case 'Ctrl+W': {
      const activeId = host?.getActiveTabId();
      if (host && activeId) host.closeTab(activeId, 'user-menu');
      return true;
    }
    case 'Ctrl+Shift+S':
      void host?.captureScreenshot();
      return true;
    case 'Ctrl+Q':
      app.quit();
      return true;

    // View — the three reload entries all run host.reload, matching the menu.
    case 'Ctrl+R':
    case 'Ctrl+Shift+R':
      if (host) {
        const id = host.getActiveTabId();
        if (id) host.reload(id);
      }
      return true;
    case 'F5':
      if (host) {
        const id = host.getActiveTabId();
        if (id) host.reload(id);
      }
      return true;
    case 'Ctrl+Shift+B':
      host?.toggleBookmarkBar();
      return true;
    // Zoom — no native menubar means no zoom role; go through host.setZoom so
    // `state.zoomFactor` stays the single authoritative value (the same pipeline
    // the wheel-zoom IPC and `zoom-changed` listener already feed).
    case 'Ctrl+0':
    case 'Ctrl+num0':
      if (host) host.setZoom(host.getActiveTabId(), 1.0);
      return true;
    case 'Ctrl+=':
    case 'Ctrl++':
    case 'Ctrl+numadd': {
      if (host) {
        const id = host.getActiveTabId();
        const current = host.getTabList().find((tab) => tab.id === id)?.zoomFactor || 1.0;
        host.setZoom(id, Math.min(5.0, Number((current + 0.1).toFixed(2))));
      }
      return true;
    }
    case 'Ctrl+-':
    case 'Ctrl+numsub': {
      if (host) {
        const id = host.getActiveTabId();
        const current = host.getTabList().find((tab) => tab.id === id)?.zoomFactor || 1.0;
        host.setZoom(id, Math.max(0.25, Number((current - 0.1).toFixed(2))));
      }
      return true;
    }
    case 'F11':
      host?.toggleFullScreen();
      return true;
    case 'Ctrl+Shift+I':
    case 'F12':
      host?.toggleDevTools();
      return true;

    // Browser
    case 'Alt+Left':
      if (host) {
        const id = host.getActiveTabId();
        if (id) host.goBack(id);
      }
      return true;
    case 'Alt+Right':
      if (host) {
        const id = host.getActiveTabId();
        if (id) host.goForward(id);
      }
      return true;
    case 'Ctrl+D':
      host?.bookmarkActiveTab();
      return true;

    // Tools
    case 'Ctrl+B':
      host?.toggleInspect();
      return true;
    case 'Ctrl+Alt+L':
      host?.toggleLens();
      return true;
    case 'Ctrl+F':
      host?.focusFindBar();
      return true;

    // Terminal
    case 'Ctrl+Shift+M':
      options?.openSharedTerminalManager?.(window);
      return true;
    case 'Ctrl+Alt+B':
    case 'Ctrl+`':
      host?.toggleSidebar();
      return true;

    // Help
    case 'Ctrl+Alt+R':
      host?.reloadWindow();
      return true;
    case 'Ctrl+Shift+U':
      checkForUpdatesAndRestart(window);
      return true;

    default:
      return false;
  }
}

export function buildApplicationMenu(mainWindow: BrowserWindow, tabHost?: NativeTabHost | null, options?: ApplicationMenuOptions): Menu {
  const isMac = process.platform === 'darwin';
  /**
   * Resolve per click, from the window the user clicked in. Every command below runs
   * against this host so one menu can never mix windows: the accelerators are global,
   * so the focused window — not the window the menu was built for — is what the user
   * is driving.
   */
  const hostForClick = (focusedWindow: BaseWindow | null | undefined): NativeTabHost | null =>
    resolveApplicationMenuHost(tabHost, focusedWindow, options?.resolveHostForWindow);


  const managePasswordVault = async (window: BrowserWindow | null): Promise<void> => {
    const targetWindow = window || BrowserWindow.getFocusedWindow();
    if (!targetWindow) return;
    // Use the instance bootstrapped by NativeTabHost (constructor →
    // setupToolbarIpc) WITH its security hooks. NEVER construct via
    // getInstance(options) here: a bare-instance created this late would lack
    // resolveEventOrigin/requestSaveConsent and could never be re-hooked.
    let vault: LocalCredentialVault;
    try {
      vault = LocalCredentialVault.getInstance();
    } catch {
      dialog.showMessageBox(targetWindow, {
        type: 'info',
        title: 'Password Vault',
        message: 'Kho mật khẩu chưa được khởi tạo.',
        detail: 'Vui lòng mở lại ứng dụng để khởi tạo kho mật khẩu.',
      });
      return;
    }
    const entries = vault.list();
    if (entries.length === 0) {
      dialog.showMessageBox(targetWindow, {
        type: 'info',
        title: 'Password Vault',
        message: 'Chưa có mật khẩu nào được lưu.',
        detail: 'Mật khẩu sẽ tự động được lưu (mã hoá DPAPI) khi bạn đăng nhập trên một trang web có form mật khẩu — hoàn toàn local, không có extension.',
      });
      return;
    }
    const detail =
      entries.slice(0, 25).map((entry) => `${entry.origin} — ${entry.username}`).join('\n') +
      (entries.length > 25 ? `\n… và ${entries.length - 25} mật khẩu khác` : '');
    const res = await dialog.showMessageBox(targetWindow, {
      type: 'info',
      title: `Password Vault (${entries.length} tài khoản)`,
      message: 'Autofill tự động khi mở trang đăng nhập. Mật khẩu được mã hoá bằng safeStorage (DPAPI), chỉ lưu trên máy này.',
      detail,
      buttons: ['Đóng', 'Xoá tất cả'],
      cancelId: 0,
    });
    if (res.response === 1) {
      const confirm = await dialog.showMessageBox(targetWindow, {
        type: 'warning',
        title: 'Xác nhận xoá',
        message: `Xoá toàn bộ ${entries.length} mật khẩu đã lưu?`,
        buttons: ['Huỷ', 'Xoá'],
        cancelId: 0,
      });
      if (confirm.response === 1) {
        const cleared = vault.clear();
        dialog.showMessageBox(targetWindow, {
          type: 'info',
          title: 'Password Vault',
          message: cleared.ok ? `Đã xoá ${cleared.data?.removedCount ?? 0} mật khẩu.` : 'Không có mật khẩu nào được xoá.',
        });
      }
    }
  };

  const chromeProfiles = ChromeProfileSyncManager.getInstance().getAvailableProfiles();
  const profileSubmenu: MenuItemConstructorOptions[] = [
    ...(chromeProfiles.length > 0
      ? chromeProfiles.map((p) => ({
          label: `Sync: ${p.name} (${p.id})`,
          click: async (_item: unknown, focusedWindow: BaseWindow | undefined) => {
            const host = hostForClick(focusedWindow);
            // Unified target: shared profile partition (explicit profileId — no
            // dependence on prior active state). Menu items only exist for
            // discovered profiles, but the sync itself validates again.
            const manager = ChromeProfileSyncManager.getInstance();
            if (!manager.hasProfile(p.id)) {
              dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Chrome Profile Sync', message: `Profile '${p.id}' not found.` });
              return;
            }
            manager.activeProfileId = p.id;
            const res = await manager.syncProfile(p.id, host?.resolveTargetProfileSession(p.id));
            const bm = ChromeProfileSyncManager.getInstance().getChromeBookmarks(p.id);
            if (bm.length > 0 && host) {
              host.bookmarks = bm.map((b) => ({ id: b.url, title: b.title, url: b.url, createdAt: Date.now() }));
              host.broadcastState();
            }
            dialog.showMessageBox(mainWindow, {
              type: res.success ? 'info' : 'warning',
              title: 'Chrome Profile Sync',
              message: res.message,
            });
          },
        }))
      : [{ label: 'Không tìm thấy Chrome Profile', enabled: false }]),
    { type: 'separator' },
    {
      label: '💾 Sao lưu Session Vault (Export JSON)',
      click: async (_item, focusedWindow: BaseWindow | undefined) => {
        const targetSession = hostForClick(focusedWindow)?.resolveTargetProfileSession();
        if (!targetSession) return;
        const res = await LocalSessionVault.getInstance().exportVaultToFile(targetSession);
        const googleAuth = res.googleAuthCount ?? 0;
        dialog.showMessageBox(mainWindow, {
          type: res.success ? 'info' : 'error',
          title: 'Session Vault Backup',
          message: res.success
            ? `Đã sao lưu thành công ${res.count} cookies từ ${res.targetJar} vào:\n${res.filePath}`
            : `Lỗi sao lưu: ${res.error}`,
          detail:
            res.success && googleAuth === 0
              ? '⚠️ Bản sao lưu không chứa cookie đăng nhập Google (SID/HSID/SSID/…). Khôi phục lại sẽ không tự đăng nhập Google — hãy đồng bộ qua 🧩 Tiện ích AntiFan Companion ngay khi Chrome đang đăng nhập.'
              : undefined,
        });
      },
    },
    {
      label: '📥 Khôi phục Session Vault (Import JSON)',
      click: async (_item, focusedWindow: BaseWindow | undefined) => {
        const targetSession = hostForClick(focusedWindow)?.resolveTargetProfileSession();
        if (!targetSession) return;
        const res = await LocalSessionVault.getInstance().importVaultFromFile(targetSession);
        const googleAuth = res.googleAuthCount ?? 0;
        const missingGoogleAuth = res.success && googleAuth === 0;
        dialog.showMessageBox(mainWindow, {
          type: res.success ? (missingGoogleAuth ? 'warning' : 'info') : 'warning',
          title: 'Session Vault Restore',
          message: res.success
            ? `Đã nạp thành công ${res.importedCount} cookies vào ${res.targetJar}!`
            : `Lỗi nạp: ${res.error || 'Không tìm thấy file session-vault.json'}`,
          detail: missingGoogleAuth
            ? '⚠️ Không có cookie đăng nhập Google nào trong file này (chỉ có cookie phụ/thống kê), nên Google vẫn sẽ ở trạng thái chưa đăng nhập. Hãy đồng bộ qua 🧩 Tiện ích AntiFan Companion khi Chrome đang đăng nhập.'
            : undefined,
        });
      },
    },
  ];

  const template: MenuItemConstructorOptions[] = [
    // 1. File Menu
    {
      label: 'File',
      submenu: [
        {
          label: 'Mở dự án…',
          accelerator: 'CmdOrCtrl+Shift+O',
          // A disabled entry is the honest shape of "this build was given no picker": the
          // accelerator stays reserved, and no click can silently do nothing.
          enabled: typeof options?.openProjectPicker === 'function',
          click: (_item, focusedWindow: BaseWindow | undefined) =>
            options?.openProjectPicker?.((focusedWindow as BrowserWindow | undefined) ?? null),
        },
        {
          // A native click carries no project identity: the focused window's host is
          // asked which project it is presenting, and a window that presents none —
          // an unscoped hub or a detached `project:` window — has nothing to detach.
          label: 'Detach Project into Own Window',
          enabled: typeof options?.detachProject === 'function',
          click: (_item, focusedWindow: BaseWindow | undefined) => {
            const projectId = hostForClick(focusedWindow)?.activeProject() ?? null;
            if (!projectId) return;
            options?.detachProject?.(projectId, (focusedWindow as BrowserWindow | undefined) ?? null);
          },
        },
        {
          // The inverse of the detach above, scoped differently on purpose: the click
          // reads the clicked window's OWNER key, because a detached window's host
          // presents no active project and `activeProject()` could never reach it.
          // The affordance stays reachable while the marked-live shell exists — the
          // reattach itself is what retires that shell.
          label: 'Reattach Project into Hub Window',
          enabled: typeof options?.reattachProject === 'function',
          click: (_item, focusedWindow: BaseWindow | undefined) => {
            const ownerKeyValue = hostForClick(focusedWindow)?.windowOwnerKey() ?? '';
            const owner = parseOwnerKey(ownerKeyValue);
            if (owner.kind !== 'project' || !owner.projectId) return;
            options?.reattachProject?.(owner.projectId, (focusedWindow as BrowserWindow | undefined) ?? null);
          },
        },
        { type: 'separator' },
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.createTab('https://www.google.com'),
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.reopenClosedTab(),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, focusedWindow: BaseWindow | undefined) => {
            const host = hostForClick(focusedWindow);
            if (host) {
              host.closeTab(host.getActiveTabId(), 'user-menu');
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Capture Viewport Screenshot',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: (_item, focusedWindow: BaseWindow | undefined) => void hostForClick(focusedWindow)?.captureScreenshot(),
        },
        { type: 'separator' },
        {
          label: 'Thoát hoàn toàn (Dừng cả GUI và Terminal Host)',
          click: async () => {
            try {
              const tm: unknown = TerminalManager.getInstance();
              if (tm && typeof tm === 'object' && 'shutdownHost' in tm && typeof tm.shutdownHost === 'function') {
                await (tm.shutdownHost as () => Promise<void>)();
              } else if (tm && typeof tm === 'object' && 'dispose' in tm && typeof tm.dispose === 'function') {
                await (tm.dispose as () => Promise<void>)();
              }
            } catch {}
            app.quit();
          },
        },
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
          click: (_item, focusedWindow: BaseWindow | undefined) => {
            const host = hostForClick(focusedWindow);
            if (host) host.reload(host.getActiveTabId());
          },
        },
        {
          label: 'Reload Page (F5)',
          accelerator: 'F5',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: (_item, focusedWindow: BaseWindow | undefined) => {
            const host = hostForClick(focusedWindow);
            if (host) host.reload(host.getActiveTabId());
          },
        },
        {
          label: 'Force Reload Page',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: (_item, focusedWindow: BaseWindow | undefined) => {
            const host = hostForClick(focusedWindow);
            if (host) host.reload(host.getActiveTabId());
          },
        },
        {
          label: 'Toggle Bookmarks Bar',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleBookmarkBar(),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        {
          label: 'Toggle Full Screen',
          accelerator: 'F11',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleFullScreen(),
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleDevTools(),
        },
        {
          label: 'Toggle Developer Tools (F12)',
          accelerator: 'F12',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleDevTools(),
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
          click: (_item, focusedWindow: BaseWindow | undefined) => {
            const host = hostForClick(focusedWindow);
            if (host) host.goBack(host.getActiveTabId());
          },
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: (_item, focusedWindow: BaseWindow | undefined) => {
            const host = hostForClick(focusedWindow);
            if (host) host.goForward(host.getActiveTabId());
          },
        },
        {
          label: 'Home',
          click: (_item, focusedWindow: BaseWindow | undefined) => {
            const host = hostForClick(focusedWindow);
            if (host) host.navigate(host.getActiveTabId(), 'https://www.google.com');
          },
        },
        { type: 'separator' },
        {
          label: 'Bookmark This Tab',
          accelerator: 'CmdOrCtrl+D',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.bookmarkActiveTab(),
        },
        {
          label: 'Sync Google Chrome Profile',
          submenu: profileSubmenu,
        },
        { type: 'separator' },
        {
          label: 'Clear Cookies & Site Cache',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.clearStorageForActiveTab(),
        },
        {
          label: 'Open in System Browser',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.openExternal(),
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
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleInspect(),
        },
        {
          label: 'Font Finder (Inspect Typography)',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleFontFinder(),
        },
        {
          label: 'GPU Lens Zoom Glass',
          accelerator: 'CmdOrCtrl+Alt+L',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleLens(),
        },
        {
          label: 'Precision Ruler & Layout Grid',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleRuler(),
        },
        { type: 'separator' },
        {
          label: 'Find in Page...',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.focusFindBar(),
        },
        { type: 'separator' },
        {
          label: '🔑 Quản lý mật khẩu đã lưu (Password Vault)',
          click: () => void managePasswordVault(mainWindow),
        },
      ],
    },

    // 6. Terminal Menu
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Cửa sổ Terminal chung (Shared Terminal Manager)',
          accelerator: 'CmdOrCtrl+Shift+M',
          // Same honesty as "Mở dự án…": the accelerator stays reserved, and an un-injected
          // opener disables the entry instead of offering a click that would do nothing.
          enabled: typeof options?.openSharedTerminalManager === 'function',
          click: (_item, focusedWindow: BaseWindow | undefined) =>
            options?.openSharedTerminalManager?.((focusedWindow as BrowserWindow | undefined) ?? null),
        },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar Terminal',
          accelerator: 'CmdOrCtrl+Alt+B',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleSidebar(),
        },
        {
          label: 'Toggle Terminal Workbench',
          accelerator: 'CmdOrCtrl+`',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.toggleSidebar(),
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
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.reloadWindow(),
        },
        {
          label: 'Developer: Recompile & Restart App',
          accelerator: 'CmdOrCtrl+Shift+U',
          click: (_item, focusedWindow: BaseWindow | undefined) => checkForUpdatesAndRestart(focusedWindow ?? mainWindow),
        },
        { type: 'separator' },
        {
          label: 'Keyboard Shortcuts...',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.showShortcuts(),
        },
        {
          label: 'Open in System Browser',
          click: (_item, focusedWindow: BaseWindow | undefined) => hostForClick(focusedWindow)?.openExternal(),
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
