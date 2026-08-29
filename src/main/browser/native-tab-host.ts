/**
 * AntiFan Browser Desktop — Full Native Tab Host & AI Sidebar (Chromium Engine)
 * Features: 100% parity with Antigravity Desktop architecture:
 * Multi-tab, Docked DevTools, GPU Lens, Font Finder, Device Emulation, Bookmarks,
 * AI Chat Sidebar (WebSocket Relay with Antigravity IDE), Global Shortcuts, and Context Menu.
 */
import { app, BrowserWindow, WebContentsView, Menu, MenuItem, clipboard, Rectangle, ipcMain, shell, dialog, net } from 'electron';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { AntiFanTab, SplitPaneId, AntiFanPickedElement, TOOLBAR_CHANNELS, SIDEBAR_CHANNELS, TERMINAL_CHANNELS, FRAME_BACKDROP_CHANNELS } from '../../shared/contracts';
import { getSecureWebPreferences, sanitizeUrl, isAllowedNavigation, cleanRestoredUrl, isInternalWidgetOrSubframeUrl } from '../security/security-policy';
import { ELEMENT_PICKER_SCRIPT } from './element-picker';
import { dispatchAnnotationToTerminal, stripDeliveryMode } from './annotation-dispatch';
import { resolveWorkspaceFromUrl, DEFAULT_WORKSPACE_ROOTS } from './workspace-resolver';
import { FONT_FINDER_SCRIPT } from './font-finder';
import { GPU_LENS_SCRIPT } from './gpu-lens';
import { RULER_SCRIPT } from './ruler';
import { AGENT_BROWSER_SCRIPT } from './agent-browser';
import {
  DEVICE_PRESETS,
  DevicePreset,
  getPresetUserAgent,
  getPresetCornerRadius,
  IPHONE_USER_AGENT,
  MAC_DESKTOP_USER_AGENT,
} from './device-presets';
import { googleAuthUserAgent } from './google-auth-identity';
import { TabDiagnosticsManager, computeOrigin } from './tab-diagnostics';
import { buildKeyboardInputEvents } from './keyboard-normalizer';
import { WorkspaceCapsuleManager, type WorkspaceCapsule } from '../project/workspace-capsule';
import { PreviewWatcherPool, type PreviewChangeEvent } from '../server/preview-watcher-pool';
import { buildPreviewUrl, parsePreviewUrl } from '../server/preview-url-codec';
import type { ControlPlaneRuntime } from '../control-plane/control-plane-runtime';
import type { BrowserTarget } from '../../shared/control-plane-contracts';
import type { WorkflowDefinition } from '../workflow/workflow-schema';
import { AnnotationManager } from '../bridge/annotation-manager';
import { ChromeProfileSyncManager } from './chrome-profile-sync';
import { HaravanUploader } from './haravan-uploader';
import { TerminalManager } from './terminal-manager';
import { checkForUpdatesAndRestart } from './app-menu';
import { SkillScanner } from './skill-scanner';
import { WindowStateManager, WindowState } from './window-state';
import { BridgeServer } from '../bridge/bridge-server';

import { HistoryManager } from './history-manager';
import { OAuthPopupManager } from './oauth-popup-manager';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
import {
  DEFAULT_SPLIT_DESKTOP_PRESET,
  DEFAULT_SPLIT_MOBILE_PRESET,
  calculateSplitLayout,
  SplitNavigationCoordinator,
  sanitizeTabForPersistence,
  migratePersistedTab,
} from './split-review-coordinator';
export const TOOLBAR_HEIGHT_WITH_BOOKMARKS = 102;
export const TOOLBAR_HEIGHT_COMPACT = 74;
/**
 * Safely dispatches IPC messages to a WebContents instance, guarding against
 * frame lifecycle races (e.g. disposed WebFrameMain during process termination/reloads).
 */
export function safeSendWebContents(
  wc: Electron.WebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!wc || wc.isDestroyed()) return false;
  try {
    if (typeof wc.isCrashed === 'function' && wc.isCrashed()) return false;
    if (!wc.mainFrame) return false;
    wc.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}


export const MOBILE_OVERLAY_SCROLLBAR_CSS = `
/* AntiFan Chrome DevTools Mobile Scrollbar Simulation */
::-webkit-scrollbar {
  width: 0px !important;
  height: 0px !important;
  background: transparent !important;
}
::-webkit-scrollbar-track {
  background: transparent !important;
}
::-webkit-scrollbar-thumb {
  background: transparent !important;
}
::-webkit-scrollbar-button {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
::-webkit-scrollbar-corner {
  background: transparent !important;
}
html, body {
  -webkit-touch-callout: default;
  -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
  touch-action: manipulation;
}
`;

export const MOBILE_TOUCH_CLIENT_SCRIPT = `(() => {
  if (window.__antifanMobileEmulated) return;
  window.__antifanMobileEmulated = true;
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
  } catch {}
  if (!('ontouchstart' in window)) {
    try { window.ontouchstart = null; } catch {}
  }
  let isDown = false;
  let startX = 0, startY = 0;
  let scrollLeft = 0, scrollTop = 0;
  let activeScrollEl = null;

  function findScrollableParent(el) {
    let curr = el;
    while (curr && curr !== document.documentElement) {
      if (curr instanceof HTMLElement) {
        const style = window.getComputedStyle(curr);
        const overflowX = style.overflowX;
        const overflowY = style.overflowY;
        const isScrollableX = (overflowX === 'auto' || overflowX === 'scroll') && curr.scrollWidth > curr.clientWidth;
        const isScrollableY = (overflowY === 'auto' || overflowY === 'scroll') && curr.scrollHeight > curr.clientHeight;
        if (isScrollableX || isScrollableY) return curr;
      }
      curr = curr.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    isDown = true;
    startX = e.pageX;
    startY = e.pageY;
    activeScrollEl = findScrollableParent(e.target);
    if (activeScrollEl) {
      scrollLeft = activeScrollEl.scrollLeft;
      scrollTop = activeScrollEl.scrollTop;
    }
  }, { capture: true, passive: true });

  window.addEventListener('mousemove', (e) => {
    if (!isDown || !activeScrollEl) return;
    const dx = e.pageX - startX;
    const dy = e.pageY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      activeScrollEl.scrollLeft = scrollLeft - dx;
      activeScrollEl.scrollTop = scrollTop - dy;
    }
  }, { capture: true, passive: true });

  const stopDrag = () => { isDown = false; activeScrollEl = null; };
  window.addEventListener('mouseup', stopDrag, { capture: true, passive: true });
  window.addEventListener('mouseleave', stopDrag, { capture: true, passive: true });
})();`;
export interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

export interface NativeTabRecord {
  view: WebContentsView;
  mobileView?: WebContentsView;
  state: AntiFanTab;
  focusedPane?: SplitPaneId;
}

export class NativeTabHost extends EventEmitter {
  private window: BrowserWindow;
  private toolbarView: WebContentsView;
  private frameBackdropView: WebContentsView | null = null;
  private sidebarView: WebContentsView | null = null;
  private terminalView: WebContentsView | null = null;
  private popoutWindow: BrowserWindow | null = null;
  private terminalWindows: Map<number, BrowserWindow> = new Map();
  private terminalWindowMeta: Map<number, { sessionId?: string; isPopout?: boolean }> = new Map();
  private terminalWindowStateManager: WindowStateManager;
  private isSidebarOpen: boolean = true;
  private wasSidebarOpenBeforePopout: boolean = false;
  private isTerminalOpen: boolean = false;
  private isBookmarkBarVisible: boolean = false;
  private sidebarWidth: number = 380;
  private isToolbarOverlayActive: boolean = false;
  private toolbarOverlayCustomHeight?: number;
  private readonly splitCoordinator = new SplitNavigationCoordinator();
  private defaultUserAgent: string = googleAuthUserAgent();
  private tabs: Map<string, NativeTabRecord> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string = '';

  public bookmarks: BookmarkItem[] = [];
  private readonly diagnosticsManager = new TabDiagnosticsManager();
  private readonly previewWatcherPool = new PreviewWatcherPool();
  private readonly capsuleManager: WorkspaceCapsuleManager;
  private controlPlane: ControlPlaneRuntime | null = null;
  private activeWorkflowAbortController: AbortController | null = null;
  private documentGenerations: Map<string, number> = new Map();
  private browserEpoch: number = 1;
  private tabPreviewUnsubscribers: Map<string, () => void> = new Map();
  private recentlyClosedTabs: Array<{ url: string; title: string }> = [];
  private automationTabId: string | null = null;
  private themeQaState: { status: 'idle' | 'running' | 'pass' | 'fail' | 'error'; issueCount: number; reportArtifactId?: string; report?: unknown; error?: string; updatedAt: number } = { status: 'idle', issueCount: 0, updatedAt: Date.now() };

  private isInspecting: boolean = false;
  private inspectedTabId: string | null = null;
  private isFontFinderActive: boolean = false;
  private isLensActive: boolean = false;
  private isRulerActive: boolean = false;
  private inspectPollTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private agentWorkingTimers = new Map<string, NodeJS.Timeout>();
  private agentWorkingRefs = new Map<string, number>();
  private appliedClipRadius = new WeakMap<Electron.WebContents, number>();
  private emulatedWebContents = new WeakSet<Electron.WebContents>();

  private safeEnableDeviceEmulation(
    wc: Electron.WebContents | null | undefined,
    params: Parameters<Electron.WebContents['enableDeviceEmulation']>[0]
  ): void {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
    if (typeof wc.getURL === 'function' && wc.getURL() === '') return;
    try {
      if (typeof wc.enableDeviceEmulation === 'function') {
        wc.enableDeviceEmulation(params);
        this.emulatedWebContents.add(wc);
      }
    } catch (err) {
      console.error('[native-tab-host] safeEnableDeviceEmulation error:', err);
    }
  }

  /** Benchmark-mode helper: counts attached desktop+mobile views; no behavior. */
  private countAttachedViews(): number {
    if (!this.window || this.window.isDestroyed() || !this.window.contentView) return 0;
    let count = 0;
    for (const [, tab] of this.tabs.entries()) {
      try {
        if (this.window.contentView.children.includes(tab.view)) count += 1;
        if (tab.mobileView && this.window.contentView.children.includes(tab.mobileView)) count += 1;
      } catch {}
    }
    return count;
  }

  private safeDisableDeviceEmulation(wc: Electron.WebContents | null | undefined): void {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
    if (!this.emulatedWebContents.has(wc)) return;
    if (typeof wc.getURL === 'function' && wc.getURL() === '') return;
    try {
      if (typeof wc.disableDeviceEmulation === 'function') {
        wc.disableDeviceEmulation();
      }
    } catch (err) {
      console.error('[native-tab-host] safeDisableDeviceEmulation error:', err);
    } finally {
      this.emulatedWebContents.delete(wc);
    }
  }

  private getCanGoBack(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      const nav = (wc as unknown as { navigationHistory?: { canGoBack?: () => boolean } }).navigationHistory;
      if (nav && typeof nav.canGoBack === 'function') return Boolean(nav.canGoBack());
    } catch {}
    return false;
  }

  private getCanGoForward(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      const nav = (wc as unknown as { navigationHistory?: { canGoForward?: () => boolean } }).navigationHistory;
      if (nav && typeof nav.canGoForward === 'function') return Boolean(nav.canGoForward());
    } catch {}
    return false;
  }

  private safeGoBack(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      const nav = (wc as unknown as { navigationHistory?: { canGoBack?: () => boolean; goBack?: () => void } }).navigationHistory;
      if (nav && typeof nav.canGoBack === 'function' && nav.canGoBack()) {
        if (typeof nav.goBack === 'function') nav.goBack();
        return true;
      }
    } catch {}
    return false;
  }

  private safeGoForward(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      const nav = (wc as unknown as { navigationHistory?: { canGoForward?: () => boolean; goForward?: () => void } }).navigationHistory;
      if (nav && typeof nav.canGoForward === 'function' && nav.canGoForward()) {
        if (typeof nav.goForward === 'function') nav.goForward();
        return true;
      }
    } catch {}
    return false;
  }
  constructor(window: BrowserWindow, capsuleManager?: WorkspaceCapsuleManager) {
    super();
    this.window = window;
    const stateDir = app ? app.getPath('userData') : path.join(os.homedir(), '.antifan-browser');
    this.terminalWindowStateManager = new WindowStateManager(stateDir, 900, 600, 'terminal-popout-window-state.json');
    this.capsuleManager = capsuleManager || new WorkspaceCapsuleManager({ filePath: path.join(stateDir, 'workspace-capsules.json') });
    if (!this.capsuleManager.getActive()) {
      const defaultDir = fs.existsSync('E:/Work') ? 'E:/Work' : (fs.existsSync('E:\\Work') ? 'E:\\Work' : process.cwd());
      this.capsuleManager.create('Default Workspace', defaultDir, {
        sidebarOpen: this.isSidebarOpen,
        sidebarWidth: this.sidebarWidth,
      });
    }
    // 0. Create Frame Backdrop View (Bottom-most layer for realistic device chassis)
    try {
      this.frameBackdropView = new WebContentsView({
        webPreferences: {
          preload: path.join(__dirname, '..', '..', 'preload', 'frame-backdrop-preload.js'),
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
        },
      });
      this.frameBackdropView.setBackgroundColor('#060910');
      this.window.contentView.addChildView(this.frameBackdropView);

      let backdropHtml = path.join(__dirname, '..', '..', 'renderer', 'frame-backdrop.html');
      if (!fs.existsSync(backdropHtml)) {
        backdropHtml = path.join(process.cwd(), 'src', 'renderer', 'frame-backdrop.html');
      }
      this.frameBackdropView.webContents.loadFile(backdropHtml);
      this.setupBackdropContextMenu(this.frameBackdropView.webContents);
    } catch (err) {
      console.error('[native-tab-host] Failed to initialize frameBackdropView:', err);
    }
    // 1. Create Toolbar View
    this.toolbarView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'toolbar-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    this.toolbarView.setBackgroundColor('#00000000');
    this.window.contentView.addChildView(this.toolbarView);

    let toolbarHtml = path.join(__dirname, '..', '..', 'renderer', 'toolbar.html');
    if (!fs.existsSync(toolbarHtml)) {
      toolbarHtml = path.join(process.cwd(), 'src', 'renderer', 'toolbar.html');
    }
    this.toolbarView.webContents.loadFile(toolbarHtml);

    // 2. Create Terminal Workbench Sidebar View (Standalone)
    this.sidebarView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'standalone-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    this.sidebarView.setBackgroundColor('#060a11');
    this.window.contentView.addChildView(this.sidebarView);

    let standaloneHtml = path.join(__dirname, '..', '..', 'renderer', 'standalone.html');
    if (!fs.existsSync(standaloneHtml)) {
      standaloneHtml = path.join(process.cwd(), 'src', 'renderer', 'standalone.html');
    }
    this.sidebarView.webContents.on('did-finish-load', () => {
      const tm = TerminalManager.getInstance();
      const activeId = tm.getActiveSessionId();
      const s = tm.getSession(activeId);
      const activeSession = tm.listSessions().find(x => x.id === activeId);
      safeSendWebContents(this.sidebarView?.webContents, 'antifan:terminal:session', {
        activeSessionId: activeId,
        sessions: tm.listSessions(),
        splitSessionId: activeSession?.splitSessionId,
        snapshot: s?.buffer || '',
      });
    });
    this.sidebarView.webContents.loadFile(standaloneHtml);
    // 3. Create Bottom Docked Terminal View
    this.terminalView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'terminal-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    this.terminalView.setBackgroundColor('#0c0c0c');
    this.window.contentView.addChildView(this.terminalView);

    let terminalHtml = path.join(__dirname, '..', '..', 'renderer', 'terminal.html');
    if (!fs.existsSync(terminalHtml)) {
      terminalHtml = path.join(process.cwd(), 'src', 'renderer', 'terminal.html');
    }
    this.terminalView.webContents.loadFile(terminalHtml);

    this.updateLayout();

    this.window.on('resize', () => {
      this.updateLayout();
    });

    this.setupToolbarIpc();
    this.setupSidebarIpc();
    this.setupFrameBackdropIpc();
    this.setupGlobalShortcutsOnView(this.toolbarView.webContents);
  }

  public getToolbarHeight(): number {
    return (this.isBookmarkBarVisible && this.bookmarks.length > 0)
      ? TOOLBAR_HEIGHT_WITH_BOOKMARKS
      : TOOLBAR_HEIGHT_COMPACT;
  }

  public updateLayout(): void {
    const { width, height } = this.window.getContentBounds();
    const availableWidth = this.isSidebarOpen ? Math.max(400, width - this.sidebarWidth) : width;
    const sidebarActualWidth = width - availableWidth;
    const toolbarHeight = this.getToolbarHeight();
    const terminalHeight = this.isTerminalOpen ? 240 : 0;
    const availableHeight = Math.max(0, height - toolbarHeight - terminalHeight);
    const layoutStartMs = performance.now();

    // 0. Frame Backdrop bounds (starts at y = toolbarHeight)
    if (this.frameBackdropView) {
      this.frameBackdropView.setBounds({ x: 0, y: toolbarHeight, width: availableWidth, height: availableHeight });
    }

    // 1. Toolbar bounds
    if (this.isToolbarOverlayActive) {
      const overlayHeight = this.toolbarOverlayCustomHeight && this.toolbarOverlayCustomHeight > 0
        ? Math.min(height, toolbarHeight + this.toolbarOverlayCustomHeight)
        : height;
      this.toolbarView.setBounds({ x: 0, y: 0, width: availableWidth, height: overlayHeight });
    } else {
      this.toolbarView.setBounds({ x: 0, y: 0, width: availableWidth, height: toolbarHeight });
    }
    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab) {
        this.applyTabDeviceEmulation(tab, availableWidth, availableHeight, toolbarHeight);
      }
    }

    // 3. Bottom Terminal bounds
    if (this.terminalView) {
      if (this.isTerminalOpen && terminalHeight > 0) {
        this.terminalView.setBounds({ x: 0, y: height - terminalHeight, width: availableWidth, height: terminalHeight });
      } else {
        this.terminalView.setBounds({ x: 0, y: height, width: 0, height: 0 });
      }
    }

    // 4. Sidebar bounds
    if (this.sidebarView) {
      if (this.isSidebarOpen && sidebarActualWidth > 0) {
        this.sidebarView.setBounds({ x: availableWidth, y: 0, width: sidebarActualWidth, height });
      } else {
        this.sidebarView.setBounds({ x: width, y: 0, width: 0, height: 0 });
      }
    }
    // 5. Broadcast to Frame Backdrop
    if (isBenchmarkEnabled()) {
      recordBenchmark({ surface: 'tabs', name: 'layout', value: performance.now() - layoutStartMs, extra: { width, height, attachedViews: this.countAttachedViews() } });
    }
    this.syncFrameBackdrop();
  }

  private syncFrameBackdrop(): void {
    if (!this.frameBackdropView || this.frameBackdropView.webContents.isDestroyed()) return;
    if (!this.window || typeof this.window.getContentBounds !== 'function') return;
    const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    const { width, height } = this.window.getContentBounds();
    const availableWidth = this.isSidebarOpen ? Math.max(400, width - this.sidebarWidth) : width;
    const toolbarHeight = this.getToolbarHeight();
    const terminalHeight = this.isTerminalOpen ? 240 : 0;
    const availableHeight = Math.max(0, height - toolbarHeight - terminalHeight);

    const isAgentWorking = Boolean(activeTab && activeTab.state.aiState === 'agent_working');
    if (activeTab && activeTab.state.splitMode) {
      const userZoom = activeTab.state.zoomFactor || 1.0;
      const splitLayout = calculateSplitLayout(
        { width: availableWidth, height: availableHeight, yOffset: 0 },
        activeTab.state.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET,
        activeTab.state.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET,
        userZoom
      );
      const payload = {
        splitMode: true,
        focusedPane: activeTab.focusedPane || activeTab.state.splitFocusedPane || 'desktop',
        desktopFrame: splitLayout.desktopFrame,
        mobileFrame: splitLayout.mobileFrame,
        containerWidth: availableWidth,
        containerHeight: availableHeight,
        url: activeTab.state.url || '',
        agentWorking: isAgentWorking,
      };
      safeSendWebContents(this.frameBackdropView?.webContents, FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT, payload);
    } else {
      safeSendWebContents(this.frameBackdropView?.webContents, FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT, {
        splitMode: false,
        focusedPane: 'desktop',
        containerWidth: availableWidth,
        containerHeight: availableHeight,
        agentWorking: isAgentWorking,
      });
    }
  }

  private setupFrameBackdropIpc(): void {
    ipcMain.on(FRAME_BACKDROP_CHANNELS.FOCUS_PANE, (_event, paneId: SplitPaneId) => {
      if (this.activeTabId) {
        this.setSplitFocusedPane(this.activeTabId, paneId);
      }
    });

    ipcMain.on(FRAME_BACKDROP_CHANNELS.READY, () => {
      this.syncFrameBackdrop();
    });
  }
  public toggleSidebar(): boolean {
    this.isSidebarOpen = !this.isSidebarOpen;
    this.updateLayout();
    this.broadcastState();
    return this.isSidebarOpen;
  }

  public toggleTerminal(): boolean {
    this.isTerminalOpen = !this.isTerminalOpen;
    this.updateLayout();
    this.broadcastState();
    return this.isTerminalOpen;
  }

  private setupToolbarIpc(): void {
    ipcMain.handle(TOOLBAR_CHANNELS.GET_INITIAL_STATE, () => {
      return {
        tabs: this.getTabList(),
        activeTabId: this.activeTabId,
        isInspecting: this.isInspecting,
        isFontFinderActive: this.isFontFinderActive,
        isLensActive: this.isLensActive,
        isRulerActive: this.isRulerActive,
        isSidebarOpen: this.isSidebarOpen,
        bookmarks: this.bookmarks,
        devicePresets: DEVICE_PRESETS,
        activeChromeProfile: ChromeProfileSyncManager.getInstance().getActiveProfile(),
        chromeProfiles: ChromeProfileSyncManager.getInstance().getAvailableProfiles(),
        themeQa: this.themeQaState,
      };
    });
    ipcMain.handle(TOOLBAR_CHANNELS.THEME_QA_RUN, async (_event, options?: { workspaceRoot?: string }) => this.runThemeQa(options));

    ipcMain.handle(TOOLBAR_CHANNELS.CREATE_TAB, (_event, url?: string) => this.createTab(url));
    ipcMain.handle(TOOLBAR_CHANNELS.SWITCH_TAB, (_event, tabId: string) => this.switchTab(tabId));
    ipcMain.handle(TOOLBAR_CHANNELS.CLOSE_TAB, (_event, tabId: string) => this.closeTab(tabId));
    ipcMain.handle(TOOLBAR_CHANNELS.MOVE_TAB, (_event, { tabId, toIndex }: { tabId: string; toIndex: number }) => this.moveTab(tabId, toIndex));
    ipcMain.handle(TOOLBAR_CHANNELS.DUPLICATE_TAB, (_event, tabId: string) => this.duplicateTab(tabId));
    ipcMain.handle(TOOLBAR_CHANNELS.CLOSE_OTHER_TABS, (_event, tabId: string) => this.closeOtherTabs(tabId));
    ipcMain.handle(TOOLBAR_CHANNELS.CLOSE_TABS_TO_RIGHT, (_event, tabId: string) => this.closeTabsToRight(tabId));
    ipcMain.handle(TOOLBAR_CHANNELS.NAVIGATE, (_event, { tabId, url }: { tabId?: string; url: string }) => this.navigate(tabId || this.activeTabId, url));
    ipcMain.handle(TOOLBAR_CHANNELS.RELOAD, (_event, tabId?: string) => this.reload(tabId || this.activeTabId));
    ipcMain.handle(TOOLBAR_CHANNELS.STOP_LOADING, (_event, tabId?: string) => this.stopLoading(tabId || this.activeTabId));
    ipcMain.handle(TOOLBAR_CHANNELS.GO_BACK, (_event, tabId?: string) => this.goBack(tabId || this.activeTabId));
    ipcMain.handle(TOOLBAR_CHANNELS.GO_FORWARD, (_event, tabId?: string) => this.goForward(tabId || this.activeTabId));
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_INSPECT, () => this.toggleInspect());
    ipcMain.handle(TOOLBAR_CHANNELS.SET_TAB_TERMINAL_SESSION, (_event, { tabId, terminalSessionId }: { tabId?: string; terminalSessionId?: string }) => this.setTabTerminalSession(tabId || this.activeTabId, terminalSessionId));
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_FONT_FINDER, () => this.toggleFontFinder());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_LENS, () => this.toggleLens());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_RULER, () => this.toggleRuler());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_DEVTOOLS, () => this.toggleDevTools());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_TERMINAL, () => this.toggleTerminal());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_SIDEBAR, () => this.toggleSidebar());
    ipcMain.handle(TOOLBAR_CHANNELS.SET_DEVICE_PRESET, (_event, { tabId, presetId }: { tabId?: string; presetId: string }) => this.setDevicePreset(tabId || this.activeTabId, presetId));
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_SPLIT_REVIEW, (_event, payload?: { tabId?: string; enabled?: boolean }) => this.toggleSplitReview(payload?.tabId || this.activeTabId, payload?.enabled));
    ipcMain.handle(TOOLBAR_CHANNELS.SET_SPLIT_PRESET, (_event, { tabId, paneId, presetId }: { tabId?: string; paneId: SplitPaneId; presetId: string }) => this.setSplitPreset(tabId || this.activeTabId, paneId, presetId));
    ipcMain.handle(TOOLBAR_CHANNELS.SET_SPLIT_FOCUSED_PANE, (_event, { tabId, paneId }: { tabId?: string; paneId: SplitPaneId }) => this.setSplitFocusedPane(tabId || this.activeTabId, paneId));
    ipcMain.handle(TOOLBAR_CHANNELS.SET_ZOOM, (_event, { tabId, zoom }: { tabId?: string; zoom: number }) => this.setZoom(tabId || this.activeTabId, zoom));
    ipcMain.on('antifan:tab-wheel-zoom', (event, { isZoomIn }: { isZoomIn: boolean }) => {
      const senderWc = event.sender;
      for (const [id, t] of this.tabs.entries()) {
        if (t.view.webContents === senderWc) {
          const current = t.state.zoomFactor || 1.0;
          const step = 0.1;
          const nextZoom = isZoomIn
            ? Math.min(5.0, Number((current + step).toFixed(2)))
            : Math.max(0.25, Number((current - step).toFixed(2)));
          this.setZoom(id, nextZoom);
          break;
        }
      }
    });
    ipcMain.handle(TOOLBAR_CHANNELS.CAPTURE_FULL_PAGE, () => this.captureScreenshot());
    ipcMain.handle(TOOLBAR_CHANNELS.CAPTURE_VIEWPORT, () => this.captureScreenshot());
    ipcMain.handle(TOOLBAR_CHANNELS.OPEN_EXTERNAL, (_event, url?: string) => this.openExternal(url));
    ipcMain.handle(TOOLBAR_CHANNELS.OPEN_IN_VSCODE, () => this.openInVSCode());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_BOOKMARK, (_event, { url, title }: { url: string; title?: string }) => this.toggleBookmark(url, title));
    ipcMain.handle(TOOLBAR_CHANNELS.FIND_IN_PAGE, (_event, { text, forward, findNext }: { text: string; forward?: boolean; findNext?: boolean }) => this.findInPage(text, forward, findNext));
    ipcMain.handle(TOOLBAR_CHANNELS.STOP_FIND_IN_PAGE, () => this.stopFindInPage());
    ipcMain.handle(TOOLBAR_CHANNELS.SHOW_MENU, () => this.showMainMenu());
    ipcMain.handle('antifan:toolbar:check-updates', () => checkForUpdatesAndRestart(this.window));
    ipcMain.handle(TOOLBAR_CHANNELS.SET_OVERLAY, (_event, active: boolean, customHeight?: number) => this.setToolbarOverlay(active, customHeight));
    ipcMain.handle(TOOLBAR_CHANNELS.CLEAR_STORAGE, () => this.clearStorageForActiveTab());
    ipcMain.handle(TOOLBAR_CHANNELS.GET_CHROME_PROFILES, () => ChromeProfileSyncManager.getInstance().getAvailableProfiles());
    ipcMain.handle(TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE, async (_event, profileId: string) => {
      const res = await ChromeProfileSyncManager.getInstance().syncProfile(profileId);
      const bm = ChromeProfileSyncManager.getInstance().getChromeBookmarks(profileId);
      if (bm && bm.length > 0) {
        this.bookmarks = bm.map(b => ({ id: b.url, title: b.title, url: b.url, createdAt: Date.now() }));
      }
      this.updateLayout();
      this.broadcastState();
      return res;
    });
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_BOOKMARK_BAR, () => {
      this.isBookmarkBarVisible = !this.isBookmarkBarVisible;
      this.updateLayout();
      this.broadcastState();
      return this.isBookmarkBarVisible;
    });
    ipcMain.handle(TOOLBAR_CHANNELS.ADD_BOOKMARK, (_event, { title, url }: { title: string; url: string }) => {
      const existing = this.bookmarks.find(b => b.url === url);
      if (!existing) {
        this.bookmarks.push({ id: url, title: title || url, url, createdAt: Date.now() });
        this.updateLayout();
        this.broadcastState();

        const activeProfile = ChromeProfileSyncManager.getInstance().getActiveProfile();
        if (activeProfile) {
          ChromeProfileSyncManager.getInstance().saveChromeBookmark(activeProfile.id, title || url, url);
        }
      }
      return { ok: true, bookmarks: this.bookmarks };
    });
    ipcMain.removeHandler('antifan:preview:open');
    ipcMain.handle('antifan:preview:open', (_event, { path: filePath, capsuleId }: { path: string; capsuleId?: string }) => {
      return this.createPreviewTab(filePath, capsuleId);
    });
    ipcMain.handle(TOOLBAR_CHANNELS.GET_SUGGESTIONS, async (_event, query: string) => {
      const q = (query || '').trim();
      if (!q) {
        const results = this.bookmarks.slice(0, 5).map(b => ({
          type: 'bookmark' as const,
          text: b.title,
          url: b.url,
          subText: b.url,
        }));
        return { suggestions: results };
      }

      const results: Array<{ type: 'search' | 'url' | 'bookmark' | 'history' | 'tab'; text: string; url?: string; tabId?: string; subText?: string }> = [];
      const lower = q.toLowerCase();

      // 1. Search browser history (frecency matched)
      try {
        const historyMatches = HistoryManager.getInstance().search(q, 6);
        for (const h of historyMatches) {
          if (!results.some(r => r.url === h.url)) {
            results.push({
              type: 'history',
              text: h.title || h.domain || h.url,
              url: h.url,
              subText: h.domain || h.url,
            });
          }
        }
      } catch {}

      // 2. Check local bookmarks match
      this.bookmarks.forEach(b => {
        if (b.title.toLowerCase().includes(lower) || b.url.toLowerCase().includes(lower)) {
          if (!results.some(r => r.url === b.url)) {
            results.push({ type: 'bookmark', text: b.title, url: b.url, subText: b.url });
          }
        }
      });

      // 3. Check local open tabs match
      this.tabOrder.forEach(id => {
        const tab = this.tabs.get(id);
        if (tab && (tab.state.title.toLowerCase().includes(lower) || tab.state.url.toLowerCase().includes(lower))) {
          if (!results.some(r => r.url === tab.state.url)) {
            results.push({ type: 'tab', text: tab.state.title, url: tab.state.url, tabId: id, subText: 'Chuyển sang tab' });
          }
        }
      });

      // 4. Fetch live Google search suggestions with UTF-8 encoding
      try {
        const apiUrl = `https://suggestqueries.google.com/complete/search?client=chrome&hl=vi&gl=vn&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`;
        const res = await fetch(apiUrl, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Charset': 'utf-8',
          },
        });
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          const buffer = await res.arrayBuffer();
          let text = '';
          if (/charset=iso-8859-1/i.test(contentType)) {
            text = new TextDecoder('iso-8859-1').decode(buffer);
          } else if (/charset=windows-1258/i.test(contentType)) {
            text = new TextDecoder('windows-1258').decode(buffer);
          } else {
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            } catch {
              text = new TextDecoder('utf-8').decode(buffer);
            }
          }
          const data: unknown = JSON.parse(text);
          if (Array.isArray(data) && Array.isArray(data[1])) {
            const rawQueries = data[1] as unknown[];
            const googleQueries = rawQueries.filter((item): item is string => typeof item === 'string').slice(0, 6);
            googleQueries.forEach(suggestedText => {
              if (suggestedText && !results.some(r => r.text === suggestedText)) {
                results.push({
                  type: 'search',
                  text: suggestedText,
                  url: `https://www.google.com/search?q=${encodeURIComponent(suggestedText)}`
                });
              }
            });
          }
        }
      } catch {
        if (!results.some(r => r.type === 'search')) {
          results.push({ type: 'search', text: q, url: `https://www.google.com/search?q=${encodeURIComponent(q)}` });
        }
      }

      return { suggestions: results.slice(0, 8) };
    });
    ipcMain.handle(TOOLBAR_CHANNELS.REMOVE_BOOKMARK, (_event, url: string) => {
      this.bookmarks = this.bookmarks.filter(b => b.url !== url);
      this.updateLayout();
      this.broadcastState();

      const activeProfile = ChromeProfileSyncManager.getInstance().getActiveProfile();
      if (activeProfile) {
        ChromeProfileSyncManager.getInstance().removeChromeBookmark(activeProfile.id, url);
      }
      return { ok: true, bookmarks: this.bookmarks };
    });

    // Terminal IPC Handlers
    TerminalManager.getInstance().on('data', (payload: { sessionId: string; data: string } | string) => {
      const formatted = typeof payload === 'string'
        ? { sessionId: TerminalManager.getInstance().getActiveSessionId(), data: payload }
        : payload;
      safeSendWebContents(this.sidebarView?.webContents, 'antifan:terminal:data', formatted);
      safeSendWebContents(this.terminalView?.webContents, TERMINAL_CHANNELS.DATA, formatted.data);
      for (const [id, win] of this.terminalWindows.entries()) {
        if (win && !win.isDestroyed()) {
          safeSendWebContents(win.webContents, 'antifan:terminal:data', formatted);
        } else {
          this.terminalWindows.delete(id);
        }
      }
    });

    TerminalManager.getInstance().on('session', (state: unknown) => {
      safeSendWebContents(this.sidebarView?.webContents, 'antifan:terminal:session', state);
      for (const [id, win] of this.terminalWindows.entries()) {
        if (win && !win.isDestroyed()) {
          safeSendWebContents(win.webContents, 'antifan:terminal:session', state);
        } else {
          this.terminalWindows.delete(id);
        }
      }
    });
    ipcMain.handle(TERMINAL_CHANNELS.START, (_event, cwd?: string) => {
      return TerminalManager.getInstance().startTerminal(cwd);
    });

    ipcMain.handle(TERMINAL_CHANNELS.INPUT, (_event, input: string) => {
      TerminalManager.getInstance().write(input);
      return true;
    });

    ipcMain.handle('antifan:terminal:input-session', (_event, { id, input }: { id: string; input: string }) => {
      TerminalManager.getInstance().writeTo(id, input);
      return true;
    });

    ipcMain.handle(TERMINAL_CHANNELS.KILL, () => {
      TerminalManager.getInstance().kill();
      return true;
    });
    ipcMain.handle(TERMINAL_CHANNELS.RESTART, (_event, cwd?: string) => {
      TerminalManager.getInstance().restart(cwd);
      return true;
    });

    ipcMain.handle(TERMINAL_CHANNELS.OPEN_IN_VSCODE, (_event, cwd?: string) => {
      return this.openInVSCode(cwd);
    });

    ipcMain.handle(TERMINAL_CHANNELS.RESIZE, (_event, { cols, rows }: { cols: number; rows: number }) => {
      TerminalManager.getInstance().resize(cols, rows);
      return true;
    });

    ipcMain.handle('antifan:terminal:resize-session', (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
      TerminalManager.getInstance().resizeTo(id, cols, rows);
      return true;
    });

    ipcMain.handle('antifan:terminal:new-session', (_event, cwd?: string) => {
      return TerminalManager.getInstance().createSession(cwd);
    });

    ipcMain.handle('antifan:terminal:split-session', (_event, p: any) => {
      const parentId = typeof p === 'string' ? p : (p?.parentId || p?.id);
      const cwd = typeof p === 'object' ? p?.cwd : undefined;
      const cols = typeof p === 'object' ? p?.cols : undefined;
      const rows = typeof p === 'object' ? p?.rows : undefined;
      return TerminalManager.getInstance().createSplitSession(parentId, cwd, cols, rows);
    });

    ipcMain.handle('antifan:terminal:unsplit-session', (_event, parentId: string) => {
      return TerminalManager.getInstance().closeSplitSession(parentId);
    });

    ipcMain.handle('antifan:terminal:close-split', (_event, { id }: { id: string }) => {
      return TerminalManager.getInstance().closeSplitSession(id);
    });

    ipcMain.handle(TERMINAL_CHANNELS.LIST_SESSIONS, () => {
      return TerminalManager.getInstance().listSessions();
    });
    ipcMain.handle(TERMINAL_CHANNELS.SWITCH_SESSION, (event, id: string) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      if (senderWin && this.terminalWindowMeta.has(senderWin.id)) {
        const meta = this.terminalWindowMeta.get(senderWin.id);
        if (meta) meta.sessionId = id;
        this.schedulePersist();
      }
      return TerminalManager.getInstance().switchSession(id);
    });

    ipcMain.handle(TERMINAL_CHANNELS.RENAME_SESSION, (_event, p: any) => {
      const id = typeof p === 'string' ? '' : (p?.id || p?.sessionId);
      const name = typeof p === 'string' ? p : (p?.name || p?.newTitle);
      return TerminalManager.getInstance().renameSession(id || TerminalManager.getInstance().getActiveSessionId(), name || '');
    });

    ipcMain.handle('antifan:terminal:reorder-sessions', (_event, orderIds: string[]) => {
      return TerminalManager.getInstance().reorderSessions(orderIds);
    });

    ipcMain.handle('antifan:terminal:close-session', (_event, id: string) => {
      return TerminalManager.getInstance().closeSession(id);
    });

    ipcMain.handle('antifan:terminal:delete-session', (_event, id: string) => {
      return TerminalManager.getInstance().closeSession(id);
    });

    ipcMain.handle(TERMINAL_CHANNELS.POPOUT, () => {
      return this.togglePopoutTerminal();
    });

    ipcMain.handle(TERMINAL_CHANNELS.NEW_WINDOW, (_event, opts?: { sessionId?: string }) => {
      return this.openNewTerminalWindow(opts?.sessionId);
    });

    ipcMain.handle(TERMINAL_CHANNELS.CLOSE_WINDOW, (event) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      if (senderWin && !senderWin.isDestroyed() && senderWin !== this.window) {
        senderWin.close();
      } else if (this.popoutWindow && !this.popoutWindow.isDestroyed()) {
        this.popoutWindow.close();
      }
      return true;
    });

    ipcMain.handle(TERMINAL_CHANNELS.SET_ACTIVE_SESSION, (_event, p: any) => {
      const sessionId = typeof p === 'string' ? p : (p?.sessionId || p?.id);
      if (sessionId) {
        TerminalManager.getInstance().switchSession(sessionId);
      }
      return true;
    });

    ipcMain.handle(TERMINAL_CHANNELS.REDOCK, (event) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      if (senderWin && !senderWin.isDestroyed() && senderWin !== this.window) {
        senderWin.close();
        if (this.wasSidebarOpenBeforePopout && !this.isSidebarOpen) {
          this.toggleSidebar();
        }
        this.wasSidebarOpenBeforePopout = false;
      } else if (this.popoutWindow && !this.popoutWindow.isDestroyed()) {
        this.popoutWindow.close();
      } else {
        if (this.wasSidebarOpenBeforePopout && !this.isSidebarOpen) {
          this.toggleSidebar();
        }
        this.wasSidebarOpenBeforePopout = false;
      }
      return true;
    });

    ipcMain.handle(TERMINAL_CHANNELS.GET_POPOUT_STATE, () => {
      return Boolean(this.popoutWindow && !this.popoutWindow.isDestroyed());
    });

    ipcMain.handle('antifan:window:toggle-fullscreen', (event) => {
      const callingWin = BrowserWindow.fromWebContents(event.sender) || this.window;
      if (callingWin && !callingWin.isDestroyed()) {
        const next = !callingWin.isFullScreen();
        callingWin.setFullScreen(next);
        return next;
      }
      return false;
    });
    ipcMain.handle('antifan:toolbar:get-mobile-remote-info', () => {
      return BridgeServer.getInstance()?.getRemoteConnectionInfo() || null;
    });

    ipcMain.handle('antifan:workflow:get-state', () => {
      const workflows = this.controlPlane ? this.controlPlane.workflowRegistry.getAll() : [];
      const tools = [
        { id: 'antifan_open_tab', name: 'antifan_open_tab', description: 'Mở tab Chromium mới trong AntiFan Desktop', category: 'browser', permissions: ['execute'] },
        { id: 'antifan_navigate_tab', name: 'antifan_navigate_tab', description: 'Điều hướng tab hiện tại đến URL chỉ định', category: 'browser', permissions: ['execute'] },
        { id: 'antifan_screenshot_tab', name: 'antifan_screenshot_tab', description: 'Chụp ảnh màn hình Viewport hoặc toàn trang (.PNG)', category: 'media', permissions: ['read'] },
        { id: 'antifan_execute_javascript', name: 'antifan_execute_javascript', description: 'Thực thi mã JavaScript trong trang web đang mở', category: 'eval', permissions: ['eval'] },
        { id: 'antifan_click_element', name: 'antifan_click_element', description: 'Click vào phần tử theo CSS selector hoặc XPath', category: 'browser', permissions: ['execute'] },
        { id: 'antifan_input_text', name: 'antifan_input_text', description: 'Nhập văn bản vào input hoặc textarea trên trang', category: 'browser', permissions: ['execute'] },
        { id: 'antifan_inspect_element', name: 'antifan_inspect_element', description: 'Phân tích phần tử DOM tại tọa độ (x, y)', category: 'inspect', permissions: ['read'] },
        { id: 'antifan_find_elements', name: 'antifan_find_elements', description: 'Tìm danh sách phần tử khớp CSS selector', category: 'inspect', permissions: ['read'] },
        { id: 'antifan_set_device_preset', name: 'antifan_set_device_preset', description: 'Chuyển đổi chuẩn thiết bị mô phỏng di động', category: 'device', permissions: ['execute'] },
        { id: 'antifan_sync_chrome_profile', name: 'antifan_sync_chrome_profile', description: 'Đồng bộ Bookmarks, Cookies và History từ Chrome', category: 'auth', permissions: ['read', 'write'] },
        { id: 'antifan_write_terminal', name: 'antifan_write_terminal', description: 'Gửi lệnh thực thi vào phiên Terminal', category: 'terminal', permissions: ['execute'] },
        { id: 'antifan_switch_capsule', name: 'antifan_switch_capsule', description: 'Chuyển đổi dự án Workspace Capsule đang hoạt động', category: 'workspace', permissions: ['write'] },
      ];
      return { workflows, tools };
    });

    ipcMain.handle('antifan:workflow:save', (_event, item: unknown) => {
      if (!this.controlPlane) {
        throw new Error('Control plane runtime is not initialized');
      }
      return this.controlPlane.workflowRegistry.saveCustom(item as Parameters<typeof this.controlPlane.workflowRegistry.saveCustom>[0]);
    });

    ipcMain.handle('antifan:workflow:delete', (_event, id: unknown) => {
      if (!this.controlPlane) {
        throw new Error('Control plane runtime is not initialized');
      }
      return typeof id === 'string' ? this.controlPlane.workflowRegistry.deleteCustom(id) : false;
    });

    ipcMain.handle('antifan:workflow:run', async (_event, payload: unknown) => {
      if (!this.controlPlane) {
        return { ok: false, status: 'failed', error: 'Control plane runtime is not initialized' };
      }
      const raw = (payload && typeof payload === 'object') ? payload as { workflowDef?: unknown; workflowId?: unknown } : undefined;
      let wfDef: WorkflowDefinition | undefined;
      if (raw?.workflowDef && typeof raw.workflowDef === 'object') {
        wfDef = raw.workflowDef as WorkflowDefinition;
      } else if (typeof raw?.workflowId === 'string') {
        const item = this.controlPlane.workflowRegistry.getById(raw.workflowId);
        if (item?.definition) {
          wfDef = item.definition;
        }
      }
      if (!wfDef) {
        return { ok: false, status: 'failed', error: 'Không tìm thấy kịch bản Workflow' };
      }
      const activeTab = this.getActiveTab();
      const activeTabId = this.getActiveTabId();
      if (!activeTab || !activeTabId) {
        return { ok: false, status: 'failed', error: 'No active browser tab for workflow execution' };
      }
      const lease = this.controlPlane.getLease();
      const hostEpoch = typeof this.browserEpoch === 'number' ? this.browserEpoch : 1;
      if (hostEpoch !== lease.hostEpoch) {
        return {
          ok: false,
          status: 'failed',
          error: `Stale browser epoch: host is at epoch ${hostEpoch} but lease is at epoch ${lease.hostEpoch}`,
          completedAt: new Date().toISOString(),
        };
      }
      const target: BrowserTarget = {
        tabId: activeTabId,
        url: activeTab.url || '',
        browserEpoch: hostEpoch,
        documentGeneration: this.getDocumentGeneration(activeTabId),
        projectId: lease.projectId,
        workspaceId: lease.workspaceId || '',
        runtimeId: lease.runtimeId || '',
      };
      const abortController = new AbortController();
      this.activeWorkflowAbortController = abortController;
      try {
        const result = await this.controlPlane.executeWorkflow({
          workflow: wfDef,
          target,
          signal: abortController.signal,
          onEvent: (event) => {
            try {
              this.toolbarView?.webContents?.send?.('antifan:workflow:event', event);
            } catch {}
          },
        });
        return {
          ok: result.status === 'passed',
          status: result.status,
          completedAt: new Date().toISOString(),
          totalDurationMs: result.totalDurationMs,
          passedSteps: result.passedSteps,
          failedSteps: result.failedSteps,
          skippedSteps: result.skippedSteps,
          stepResults: result.stepResults,
          artifacts: result.artifacts,
        };
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          status: 'failed',
          error: errMessage,
          completedAt: new Date().toISOString(),
        };
      } finally {
        if (this.activeWorkflowAbortController === abortController) {
          this.activeWorkflowAbortController = null;
        }
      }
    });

    ipcMain.handle('antifan:workflow:abort', () => {
      if (this.activeWorkflowAbortController) {
        this.activeWorkflowAbortController.abort();
        this.activeWorkflowAbortController = null;
        return true;
      }
      return false;
    });
    ipcMain.handle('antifan:capsule:list', () => {
      return {
        activeCapsuleId: this.capsuleManager.getActive()?.id || '',
        capsules: this.capsuleManager.list(),
      };
    });

    ipcMain.handle('antifan:capsule:pick-folder', async (_event, opts?: { sessionId?: string }) => {
      const defaultDir = fs.existsSync('E:/Work')
        ? 'E:/Work'
        : (fs.existsSync('E:\\Work')
          ? 'E:\\Work'
          : (fs.existsSync('e:\\Work')
            ? 'e:\\Work'
            : (fs.existsSync('e:/Work')
              ? 'e:/Work'
              : process.cwd())));
      const result = await dialog.showOpenDialog(this.window, {
        defaultPath: defaultDir,
        properties: ['openDirectory', 'createDirectory'],
        title: 'Chọn thư mục Workspace (Select Workspace Folder)',
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length || !result.filePaths[0]) {
        return null;
      }
      const chosenPath = result.filePaths[0];
      const folderName = path.basename(chosenPath) || 'Workspace';
      const created = this.capsuleManager.create(folderName, chosenPath);
      this.capsuleManager.switchTo(created.id);
      TerminalManager.getInstance().setCapsule(created.id, chosenPath, opts?.sessionId);
      return created;
    });

    ipcMain.handle('antifan:capsule:create', (_event, { name, workspacePath }: { name: string; workspacePath: string }) => {
      return this.capsuleManager.create(name, workspacePath);
    });

    ipcMain.handle('antifan:capsule:switch', (_event, { capsuleId, sessionId }: { capsuleId: string; sessionId?: string }) => {
      this.capsuleManager.switchTo(capsuleId);
      TerminalManager.getInstance().setCapsule(capsuleId, this.capsuleManager.getActive()?.workspacePath, sessionId);
      return true;
    });
    ipcMain.handle('antifan:standalone:open-workspace', async (_event, opts?: { sessionId?: string }) => {
      const activeTab = this.tabs.get(this.activeTabId);
      const targetWorkspace = this.resolveTargetWorkspace(opts?.sessionId, activeTab?.state.url);
      if (targetWorkspace) {
        const normalized = path.normalize(targetWorkspace);
        if (fs.existsSync(normalized)) {
          const errMsg = await shell.openPath(normalized);
          if (errMsg) {
            console.error('[OpenWorkspace] shell.openPath error:', errMsg);
            return { ok: false, error: errMsg };
          }
          return { ok: true, workspacePath: normalized };
        }
      }
      const fallback = fs.existsSync('e:\\Work') ? 'e:\\Work' : process.cwd();
      await shell.openPath(fallback);
      return { ok: true, workspacePath: fallback };
    });
  }
  private openInVSCode(targetPath?: string): { ok: boolean; error?: string; workspacePath?: string } {
    let workspacePath = targetPath;
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      const activeSessionId = TerminalManager.getInstance().getActiveSessionId();
      const activeSession = activeSessionId ? TerminalManager.getInstance().getSession(activeSessionId) : undefined;
      if (activeSession?.cwd && fs.existsSync(activeSession.cwd)) {
        workspacePath = activeSession.cwd;
      } else if (TerminalManager.getInstance().getCurrentCwd() && fs.existsSync(TerminalManager.getInstance().getCurrentCwd())) {
        workspacePath = TerminalManager.getInstance().getCurrentCwd();
      } else {
        const activeTab = this.tabs.get(this.activeTabId);
        workspacePath = this.resolveTargetWorkspace(undefined, activeTab?.state.url);
      }
    }
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      return { ok: false, error: 'Workspace not found' };
    }
    try {
      const child = spawn('code', ['--reuse-window', workspacePath], {
        cwd: workspacePath,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: process.platform === 'win32',
      });
      child.unref();
      return { ok: true, workspacePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  private setupSidebarIpc(): void {
    ipcMain.handle(SIDEBAR_CHANNELS.GET_INITIAL_STATE, () => {
      const activeTab = this.tabs.get(this.activeTabId);
      const targetWorkspace = this.resolveTargetWorkspace(undefined, activeTab?.state.url);
      return {
        isOpen: this.isSidebarOpen,
        width: this.sidebarWidth,
        workspacePath: targetWorkspace,
        activeWorkspace: targetWorkspace,
      };
    });

    ipcMain.handle(SIDEBAR_CHANNELS.CLOSE_SIDEBAR, () => {
      this.toggleSidebar();
    });

    ipcMain.handle(SIDEBAR_CHANNELS.SET_WIDTH, (_event, width: number) => {
      this.sidebarWidth = Math.max(260, Math.min(width, 850));
      this.updateLayout();
      this.schedulePersist();
    });
  }

  private setupGlobalShortcutsOnView(wc: Electron.WebContents): void {
    wc.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;

      const isCtrlOrCmd = input.control || input.meta;

      // Note: Standard application shortcuts (CmdOrCtrl+T, CmdOrCtrl+Shift+T, CmdOrCtrl+W,
      // CmdOrCtrl+R, CmdOrCtrl+Shift+R, CmdOrCtrl+Alt+B, F12, CmdOrCtrl+F, zoom, etc.)
      // are authoritatively registered in app-menu.ts to prevent duplicate execution.
      // This listener handles ONLY non-menu WebContents navigation & inspection shortcuts.

      // 1. Ctrl+Tab / Ctrl+Shift+Tab -> Switch Tab
      if (isCtrlOrCmd && input.key === 'Tab') {
        _event.preventDefault();
        if (this.tabOrder.length > 1) {
          const currIdx = this.tabOrder.indexOf(this.activeTabId);
          const nextIdx = input.shift ? (currIdx - 1 + this.tabOrder.length) % this.tabOrder.length : (currIdx + 1) % this.tabOrder.length;
          this.switchTab(this.tabOrder[nextIdx]!);
        }
        return;
      }

      // 2. Ctrl+U -> View Page Source
      if (isCtrlOrCmd && !input.shift && input.key.toLowerCase() === 'u') {
        _event.preventDefault();
        this.viewPageSource(this.activeTabId);
        return;
      }

      // 3. Ctrl+L -> Focus Omnibox
      if (isCtrlOrCmd && input.key.toLowerCase() === 'l') {
        _event.preventDefault();
        safeSendWebContents(this.toolbarView?.webContents, 'antifan:focus-omnibox');
        return;
      }

      // 4. Esc -> Stop Inspect / Font Finder / Lens / Find
      if (input.key === 'Escape') {
        _event.preventDefault();
        if (this.isInspecting) this.stopInspect();
        if (this.isFontFinderActive) this.stopFontFinder();
        if (this.isLensActive) this.stopLens();
        this.stopFindInPage();
      }
    });
  }

  private setupContextMenu(wc: Electron.WebContents, paneId?: SplitPaneId): void {
    wc.on('context-menu', async (_event, params) => {
      if (this.activeTabId) {
        const tab = this.tabs.get(this.activeTabId);
        if (tab && tab.state.splitMode && paneId && tab.focusedPane !== paneId) {
          tab.focusedPane = paneId;
          tab.state.splitFocusedPane = paneId;
          this.broadcastState();
        }
      }

      try {
        const menu = new Menu();
        const uploader = HaravanUploader.getInstance();

        // ─── 1. AI & Design Inspection Tools ───
      menu.append(
        new MenuItem({
          label: '🎯 Inspect Element (Attach to AI Chat)',
          accelerator: 'Alt+Ctrl+A',
          click: () => this.startInspect(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔤 Font Finder (Typography)',
          accelerator: 'Alt+Ctrl+F',
          click: () => this.toggleFontFinder(),
        })
      );
      menu.append(
        new MenuItem({
          label: '📐 Pixel Ruler Layout Grid',
          accelerator: 'Alt+Ctrl+R',
          click: () => this.toggleRuler(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔍 GPU Lens (Pixel Zoom)',
          accelerator: 'Alt+Ctrl+L',
          click: () => this.toggleLens(),
        })
      );
      menu.append(
        new MenuItem({
          label: '💬 Toggle AI Chat Sidebar',
          accelerator: 'Alt+Ctrl+B',
          click: () => this.toggleSidebar(),
        })
      );

      menu.append(new MenuItem({ type: 'separator' }));

      // ─── 2. Haravan Image Toolkit (Always Active for Images) ───
      let imageUrl = (params.srcURL && (params.mediaType === 'image' || params.srcURL.match(/\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i))) ? params.srcURL : '';

      if (!imageUrl && !wc.isDestroyed()) {
        try {
          const detected = await wc.executeJavaScript(`
            (function() {
              try {
                var el = document.elementFromPoint(${params.x}, ${params.y});
                if (!el) return '';
                if (el.tagName === 'IMG' && (el.currentSrc || el.src)) return el.currentSrc || el.src;
                var img = el.querySelector('img');
                if (img && (img.currentSrc || img.src)) return img.currentSrc || img.src;
                var bg = window.getComputedStyle(el).backgroundImage;
                if (bg && bg.startsWith('url(')) {
                  return bg.slice(4, -1).replace(/^["']|["']$/g, '');
                }
                var p = el.parentElement;
                for (var i = 0; i < 6 && p && p !== document.body; i++) {
                  if (p.tagName === 'IMG' && (p.currentSrc || p.src)) return p.currentSrc || p.src;
                  var pImg = p.querySelector('img');
                  if (pImg && (pImg.currentSrc || pImg.src)) return pImg.currentSrc || pImg.src;
                  var pBg = window.getComputedStyle(p).backgroundImage;
                  if (pBg && pBg.startsWith('url(')) {
                    return pBg.slice(4, -1).replace(/^["']|["']$/g, '');
                  }
                  p = p.parentElement;
                }
                return '';
              } catch (e) {
                return '';
              }
            })()
          `, true);
          if (detected && typeof detected === 'string' && (detected.startsWith('http://') || detected.startsWith('https://') || detected.startsWith('data:image/'))) {
            imageUrl = detected;
          }
        } catch {}
      }

      if (imageUrl) {
        menu.append(
          new MenuItem({
            label: '⚡ Save PNG + Upload Haravan (Copy CDN)',
            click: () => uploader.uploadImageToHaravan(imageUrl, undefined, this.window),
          })
        );

        const saveAsSubmenu = new Menu();
        for (const format of ['png', 'jpg', 'webp', 'pdf', 'gif'] as const) {
          saveAsSubmenu.append(
            new MenuItem({
              label: `Save as ${format.toUpperCase()}`,
              click: () => uploader.saveImageAs(imageUrl, format, this.window),
            })
          );
        }

        menu.append(
          new MenuItem({
            label: '💾 Save Image As',
            submenu: saveAsSubmenu,
          })
        );

        menu.append(
          new MenuItem({
            label: 'ℹ️ View Image Info & Dimensions',
            click: () => uploader.showImageInfo(imageUrl, this.window, wc),
          })
        );
        menu.append(
          new MenuItem({
            label: '📋 Copy Image Address',
            click: () => clipboard.writeText(imageUrl),
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // ─── 3. Link Actions ───
      if (params.linkURL) {
        menu.append(
          new MenuItem({
            label: 'Open Link in New Tab',
            click: () => this.createTab(params.linkURL),
          })
        );
        menu.append(
          new MenuItem({
            label: 'Copy Link Address',
            click: () => clipboard.writeText(params.linkURL),
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // ─── 4. Selection Tools ───
      if (params.selectionText) {
        menu.append(
          new MenuItem({
            label: `Search Google for "${params.selectionText.slice(0, 20)}..."`,
            click: () => this.createTab(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`),
          })
        );
        menu.append(
          new MenuItem({
            label: 'Copy Selection',
            role: 'copy',
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // ─── 5. Navigation ───
      interface NavigationHistoryCarrier {
        navigationHistory?: {
          canGoBack?: () => boolean;
          canGoForward?: () => boolean;
          goBack?: () => void;
          goForward?: () => void;
        };
      }
      const navHistory = (wc as unknown as NavigationHistoryCarrier).navigationHistory;
      const canBack = navHistory?.canGoBack?.() ?? false;
      menu.append(
        new MenuItem({
          label: '⬅️ Back',
          enabled: canBack,
          click: () => {
            if (navHistory?.canGoBack?.() && typeof navHistory.goBack === 'function') {
              navHistory.goBack();
            } else {
              this.goBack(this.activeTabId);
            }
          },
        })
      );
      const canForward = navHistory?.canGoForward?.() ?? false;
      menu.append(
        new MenuItem({
          label: '➡️ Forward',
          enabled: canForward,
          click: () => {
            if (navHistory?.canGoForward?.() && typeof navHistory.goForward === 'function') {
              navHistory.goForward();
            } else {
              this.goForward(this.activeTabId);
            }
          },
        })
      );
      menu.append(
        new MenuItem({
          label: '🔄 Reload',
          accelerator: 'Ctrl+R',
          click: () => {
            if (!wc.isDestroyed()) {
              wc.reload();
            } else {
              this.reload(this.activeTabId);
            }
          },
        })
      );
      menu.append(
        new MenuItem({
          label: '↗️ Open in External Browser',
          click: () => {
            const active = this.getActiveTab();
            if (active?.url) shell.openExternal(active.url);
          },
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));

      // ─── 6. Developer Tools & Source Viewer ───
      menu.append(
        new MenuItem({
          label: '📄 View Page Source',
          accelerator: 'Ctrl+U',
          click: () => this.viewPageSource(this.activeTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '🛠️ Inspect in DevTools',
          accelerator: 'F12',
          click: () => {
            if (!wc.isDestroyed()) {
              if (wc.isDevToolsOpened()) {
                wc.closeDevTools();
              } else {
                wc.openDevTools({ mode: 'detach' });
              }
            } else {
              this.toggleDevTools();
            }
          },
        })
      );

        menu.popup({ window: this.window });
      } catch {}
    });
  }

  private setupBackdropContextMenu(wc: Electron.WebContents): void {
    wc.on('context-menu', async (_event, _params) => {
      const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
      if (!tab) return;

      try {
        const menu = new Menu();
      // ─── 1. Split Pane Focus & Presets ───
      if (tab.state.splitMode) {
        menu.append(
          new MenuItem({
            label: '💻 Focus Desktop Pane',
            click: () => this.setSplitFocusedPane(this.activeTabId, 'desktop'),
          })
        );
        menu.append(
          new MenuItem({
            label: '📱 Focus Mobile Pane',
            click: () => this.setSplitFocusedPane(this.activeTabId, 'mobile'),
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));

        const desktopPresetsMenu = new Menu();
        for (const preset of DEVICE_PRESETS.filter((p) => !p.mobile && p.id !== 'responsive')) {
          desktopPresetsMenu.append(
            new MenuItem({
              label: preset.name,
              type: 'radio',
              checked: (tab.state.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET) === preset.id,
              click: () => this.setSplitPreset(this.activeTabId, 'desktop', preset.id),
            })
          );
        }
        menu.append(
          new MenuItem({
            label: '🖥️ Desktop Device Preset',
            submenu: desktopPresetsMenu,
          })
        );

        const mobilePresetsMenu = new Menu();
        for (const preset of DEVICE_PRESETS.filter((p) => p.mobile)) {
          mobilePresetsMenu.append(
            new MenuItem({
              label: preset.name,
              type: 'radio',
              checked: (tab.state.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET) === preset.id,
              click: () => this.setSplitPreset(this.activeTabId, 'mobile', preset.id),
            })
          );
        }
        menu.append(
          new MenuItem({
            label: '📱 Mobile Device Preset',
            submenu: mobilePresetsMenu,
          })
        );

        menu.append(new MenuItem({ type: 'separator' }));
      }

      // ─── 2. AI & Design Inspection Tools ───
      menu.append(
        new MenuItem({
          label: '🎯 Inspect Element (Attach to AI Chat)',
          accelerator: 'Alt+Ctrl+A',
          click: () => this.startInspect(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔤 Font Finder (Typography)',
          accelerator: 'Alt+Ctrl+F',
          click: () => this.toggleFontFinder(),
        })
      );
      menu.append(
        new MenuItem({
          label: '📐 Pixel Ruler Layout Grid',
          accelerator: 'Alt+Ctrl+R',
          click: () => this.toggleRuler(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔍 GPU Lens (Pixel Zoom)',
          accelerator: 'Alt+Ctrl+L',
          click: () => this.toggleLens(),
        })
      );
      menu.append(
        new MenuItem({
          label: '💬 Toggle AI Chat Sidebar',
          accelerator: 'Alt+Ctrl+B',
          click: () => this.toggleSidebar(),
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));

      // ─── 3. Navigation & DevTools ───
      menu.append(
        new MenuItem({
          label: '🔄 Reload Tab / Both Panes',
          accelerator: 'Ctrl+R',
          click: () => this.reload(this.activeTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '📄 View Page Source',
          accelerator: 'Ctrl+U',
          click: () => this.viewPageSource(this.activeTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '🛠️ Inspect in DevTools',
          accelerator: 'F12',
          click: () => this.toggleDevTools(),
        })
      );

        menu.popup({ window: this.window });
      } catch {}
    });
  }


  public showMainMenu(): void {
    const chromeProfiles = ChromeProfileSyncManager.getInstance().getAvailableProfiles();
    const profileSubmenu = chromeProfiles.length > 0
      ? chromeProfiles.map((p) => ({
          label: `Sync: ${p.name} (${p.id})`,
          click: async () => {
            const res = await ChromeProfileSyncManager.getInstance().syncProfile(p.id);
            const bm = ChromeProfileSyncManager.getInstance().getChromeBookmarks(p.id);
            if (bm.length > 0) {
              this.bookmarks = bm.map((b) => ({ id: b.url, title: b.title, url: b.url, createdAt: Date.now() }));
              this.broadcastState();
            }
            dialog.showMessageBox(this.window, {
              type: res.success ? 'info' : 'warning',
              title: 'Chrome Profile Sync',
              message: res.message,
            });
          },
        }))
      : [{ label: 'Không tìm thấy Chrome Profile', enabled: false }];

    const menu = Menu.buildFromTemplate([
      {
        label: '🔄 Check for Updates... (Recompile & Restart)',
        accelerator: 'CmdOrCtrl+Shift+U',
        click: () => checkForUpdatesAndRestart(this.window),
      },
      { type: 'separator' },
      {
        label: '🌟 Sync Google Chrome Profile',
        submenu: profileSubmenu,
      },
      {
        label: '⭐ Bookmark this Tab...',
        accelerator: 'CmdOrCtrl+D',
        click: () => this.bookmarkActiveTab(),
      },
      {
        label: 'Toggle Bookmarks Bar',
        accelerator: 'CmdOrCtrl+Shift+B',
        click: () => this.toggleBookmarkBar(),
      },
      { type: 'separator' },
      {
        label: 'Find in Page...',
        accelerator: 'CmdOrCtrl+F',
        click: () => this.focusFindBar(),
      },
      { type: 'separator' },
      {
        label: 'Quick Inspect (Annotate DOM)',
        accelerator: 'CmdOrCtrl+B',
        click: () => this.toggleInspect(),
      },
      {
        label: 'Font Finder',
        click: () => this.toggleFontFinder(),
      },
      {
        label: 'GPU Lens Zoom Glass',
        click: () => this.toggleLens(),
      },
      { type: 'separator' },
      {
        label: 'Capture Viewport Screenshot',
        click: () => this.captureScreenshot(),
      },
      {
        label: 'Open in System Browser',
        click: () => this.openExternal(),
      },
      {
        label: 'Toggle Developer Tools',
        accelerator: 'F12',
        click: () => this.toggleDevTools(),
      },
      { type: 'separator' },
      {
        label: 'Clear Cookies & Cache for this site',
        click: () => this.clearStorageForActiveTab(),
      },
      {
        label: 'Keyboard Shortcuts...',
        click: () => this.showShortcuts(),
      },
    ]);

    menu.popup({ window: this.window });
  }

  public bookmarkActiveTab(): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;
    const url = active.state.url;
    const title = active.state.title || url;
    const existing = this.bookmarks.find((b) => b.url === url);
    if (!existing) {
      this.bookmarks.push({ id: url, title, url, createdAt: Date.now() });
      this.broadcastState();
    }
  }

  public toggleBookmarkBar(): boolean {
    this.isBookmarkBarVisible = !this.isBookmarkBarVisible;
    this.updateLayout();
    this.broadcastState();
    return this.isBookmarkBarVisible;
  }

  public attachTabView(view: WebContentsView | null | undefined, isMobile = false): void {
    if (!view || !this.window || this.window.isDestroyed() || !this.window.contentView) return;
    if (view.webContents && view.webContents.isDestroyed()) return;
    try {
      if (this.window.contentView.children.includes(view)) return;
      const children = this.window.contentView.children;
      let insertIndex = 0;
      if (this.frameBackdropView && children.includes(this.frameBackdropView)) {
        insertIndex = children.indexOf(this.frameBackdropView) + 1;
      }
      if (isMobile && this.activeTabId) {
        const activeTab = this.tabs.get(this.activeTabId);
        if (activeTab?.view && children.includes(activeTab.view)) {
          insertIndex = children.indexOf(activeTab.view) + 1;
        }
      }
      insertIndex = Math.max(0, Math.min(insertIndex, children.length));
      this.window.contentView.addChildView(view, insertIndex);
    } catch (err) {
      console.error('[native-tab-host] attachTabView error:', err);
    }
  }

  public bringViewToFront(_view: WebContentsView | null | undefined): void {
    // Shell views (toolbarView, sidebarView, terminalView) are permanently positioned
    // above tab views in the window.contentView hierarchy via attachTabView indexing.
  }

  public ensureShellViewsZOrder(): void {
    // Maintained by attachTabView indexing
  }

  public setToolbarOverlay(active: boolean, customHeight?: number): void {
    this.isToolbarOverlayActive = active;
    this.toolbarOverlayCustomHeight = customHeight;
    const { width, height } = this.window.getContentBounds();
    const availableWidth = this.isSidebarOpen ? Math.max(200, width - this.sidebarWidth) : width;
    if (active) {
      // Give full window height or custom height so dropdowns, popovers, context menus are NEVER clipped!
      const overlayHeight = customHeight && customHeight > 0 ? Math.min(height, this.getToolbarHeight() + customHeight) : height;
      this.toolbarView.setBounds({ x: 0, y: 0, width: availableWidth, height: overlayHeight });
    } else {
      this.toolbarView.setBounds({ x: 0, y: 0, width: availableWidth, height: this.getToolbarHeight() });
    }
  }

  private ensureToolbarOnTop(): void {
    // Retained for API compatibility; shell views are permanently ordered above tab views
  }
  public async clearStorageForActiveTab(): Promise<void> {
    const activeTab = this.tabs.get(this.activeTabId);
    if (activeTab) {
      try {
        const ses = activeTab.view.webContents.session;
        await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage'] });
        if (!activeTab.view.webContents.isDestroyed()) {
          activeTab.view.webContents.reload();
        }
        if (activeTab.state.splitMode && activeTab.mobileView && !activeTab.mobileView.webContents.isDestroyed()) {
          activeTab.mobileView.webContents.reload();
        }
      } catch (err) {
        console.error('[native-tab-host] Failed to clear storage:', err);
      }
    }
  }

  public showShortcuts(): void {
    this.setToolbarOverlay(true);
    safeSendWebContents(this.toolbarView?.webContents, 'antifan:show-shortcuts');
  }

  public focusFindBar(): void {
    safeSendWebContents(this.toolbarView?.webContents, 'antifan:focus-find');
  }

  public getTabList(): AntiFanTab[] {
    return this.tabOrder
      .map((id) => {
        const tab = this.tabs.get(id);
        if (!tab) return undefined;
        return { ...tab.state, isAgentControlled: id === this.automationTabId };
      })
      .filter(Boolean) as AntiFanTab[];
  }

  public getActiveTabId(): string {
    return this.activeTabId;
  }

  public getActiveTab(): AntiFanTab | null {
    const t = this.tabs.get(this.activeTabId);
    return t ? { ...t.state, isAgentControlled: this.activeTabId === this.automationTabId } : null;
  }

  public getTabWebContents(tabId?: string, paneId?: SplitPaneId): Electron.WebContents | null {
    const targetId = tabId || this.activeTabId;
    const tab = this.tabs.get(targetId);
    if (!tab) return null;

    if (paneId === 'mobile') {
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        return tab.mobileView.webContents;
      }
      return null;
    }

    if (paneId === 'desktop') {
      return tab.view.webContents.isDestroyed() ? null : tab.view.webContents;
    }

    if (tab.state.splitMode && tab.focusedPane === 'mobile' && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      return tab.mobileView.webContents;
    }
    return tab.view.webContents.isDestroyed() ? null : tab.view.webContents;
  }
  public getAutomationTabId(): string | null {
    return this.automationTabId;
  }
  public setAutomationTabId(tabId?: string): void {
    const nextTabId = tabId && this.tabs.has(tabId) ? tabId : null;
    if (nextTabId === this.automationTabId) return;
    this.automationTabId = nextTabId;
    this.broadcastState();
  }

  public getAutomationTarget(): BrowserTarget | undefined {
    const tabId = this.automationTabId;
    if (!tabId || !this.tabs.has(tabId) || !this.controlPlane) return undefined;
    const lease = this.controlPlane.getLease();
    const tab = this.tabs.get(tabId);
    return {
      projectId: lease.projectId,
      workspaceId: lease.workspaceId || '',
      runtimeId: lease.runtimeId,
      tabId,
      browserEpoch: lease.hostEpoch,
      documentGeneration: this.getDocumentGeneration(tabId),
      url: tab?.state.url,
    };
  }

  private clearInitialNavigationHistory(wc: Electron.WebContents, state?: AntiFanTab): void {
    const navigationHistory = wc.navigationHistory;
    if (!navigationHistory || navigationHistory.length() <= 1) return;
    try {
      navigationHistory.clear();
      if (state) {
        state.canGoBack = navigationHistory.canGoBack();
        state.canGoForward = navigationHistory.canGoForward();
      }
      this.broadcastState();
    } catch (err) {
      console.warn('[native-tab-host] Failed to clear initial navigation history:', err);
    }
  }

  private setupTabWebContentsEvents(
    id: string,
    view: WebContentsView,
    state: AntiFanTab,
    paneId: SplitPaneId = 'desktop'
  ): void {
    const wc = view.webContents;
    let loadingSafetyTimer: NodeJS.Timeout | null = null;
    const clearLoadingTimer = () => {
      if (loadingSafetyTimer) {
        clearTimeout(loadingSafetyTimer);
        loadingSafetyTimer = null;
      }
    };

    wc.on('did-start-loading', () => {
      state.isLoading = true;
      clearLoadingTimer();
      loadingSafetyTimer = setTimeout(() => {
        loadingSafetyTimer = null;
        if (!wc.isDestroyed() && this.tabs.has(id) && state.isLoading) {
          state.isLoading = false;
          this.broadcastState();
        }
      }, 12000);
      this.broadcastState();
    });

    wc.on('did-stop-loading', () => {
      clearLoadingTimer();
      state.isLoading = false;
      state.canGoBack = this.getCanGoBack(wc);
      state.canGoForward = this.getCanGoForward(wc);
      this.broadcastState();
    });
    wc.on('console-message', (_event, level, message, line, sourceId) => {
      const source = String(sourceId || '');
      const origin = computeOrigin(source, wc.getURL());
      this.diagnosticsManager.recordConsole(id, {
        level,
        message: String(message || ''),
        source,
        line: Number(line || 0),
        timestamp: Date.now(),
        origin: origin.origin,
        isFirstParty: origin.isFirstParty,
      });
    });
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      const currentTab = this.tabs.get(id);
      const splitHasLiveMobile = Boolean(state.splitMode && currentTab?.mobileView && !currentTab.mobileView.webContents.isDestroyed());
      const authorityPane = splitHasLiveMobile ? (currentTab?.focusedPane || state.splitFocusedPane || 'desktop') : 'desktop';
      if (isMainFrame && !isInPlace && authorityPane === paneId) {
        this.documentGenerations.set(id, (this.documentGenerations.get(id) || 0) + 1);
        // Clear diagnostics buffer ĐỒNG BỘ tại start navigation (main-frame,
        // không in-place, pane có quyền điều hướng). Không clear tại
        // did-finish-load: lỗi console phát trong lúc parse phải được GIỮ LẠI
        // cho QA. Không clear trên hash navigation (did-navigate-in-page,
        // isInPlace=true) hoặc subframe; split-mode mirror navigation ở pane
        // khác cũng không clear (gate authorityPane).
        this.diagnosticsManager.clear(id);
        if (id === this.activeTabId) {
          this.themeQaState = { status: 'idle', issueCount: 0, updatedAt: Date.now() };
          this.broadcastState();
        }
      }
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      clearLoadingTimer();
      state.isLoading = false;
      this.broadcastState();
      const rawUrl = String(validatedURL || '');
      const origin = computeOrigin(rawUrl, wc.getURL());
      this.diagnosticsManager.recordFailure(id, {
        errorCode,
        errorDescription: String(errorDescription || ''),
        validatedURL: rawUrl,
        isMainFrame: Boolean(isMainFrame),
        timestamp: Date.now(),
        origin: origin.origin,
        isFirstParty: origin.isFirstParty,
      });
      this.splitCoordinator.handleNavigationFailure(id, paneId, String(errorDescription || ''));
    });

    wc.on('did-finish-load', () => {
      this.appliedClipRadius.delete(wc);
      wc.session.cookies.flushStore().catch(() => {});
      this.injectAutoJsonViewer(wc);
      // Idempotent layout and clipping synchronization on page load
      const isMobilePane = paneId === 'mobile' || Boolean(DEVICE_PRESETS.find((p) => p.id === state.devicePresetId)?.mobile);
      if (isMobilePane) {
        wc.insertCSS(MOBILE_OVERLAY_SCROLLBAR_CSS).catch(() => {});
        wc.executeJavaScript(MOBILE_TOUCH_CLIENT_SCRIPT).catch(() => {});
      }
      if (paneId === 'mobile') {
        const splitMobilePreset = DEVICE_PRESETS.find((p) => p.id === state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const splitMobileClipRadius = getPresetCornerRadius(splitMobilePreset);
        this.applyDeviceCornerClipping(wc, splitMobileClipRadius, true);
      } else if (state.devicePresetId && state.devicePresetId !== 'responsive') {
        const clipRadius = getPresetCornerRadius(state.devicePresetId);
        this.applyDeviceCornerClipping(wc, clipRadius, true);
      }
      if (id === this.activeTabId) {
        this.updateLayout();
      }
      if (this.isRulerActive && id === this.activeTabId) {
        wc.executeJavaScript(RULER_SCRIPT).catch(() => {});
      }
      if (this.isLensActive && id === this.activeTabId) {
        wc.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
      }
      if (this.isFontFinderActive && id === this.activeTabId) {
        wc.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
      }
      if (this.isInspecting && id === this.activeTabId) {
        const tm = TerminalManager.getInstance();
        const tabSessionId = this.getTabTerminalSession(id);
        const termContextData: Record<string, unknown> = {
          tabId: id,
          sessions: tm.listSessions(),
          selectedSessionId: tm.getActiveSessionId(),
        };
        if (tabSessionId !== undefined) {
          termContextData.annotationSessionId = tabSessionId;
        }
        const termContextScript = `(() => {
          window.__antifanTerminalContext = Object.assign(window.__antifanTerminalContext || {}, ${JSON.stringify(termContextData)});
          ${tabSessionId === undefined ? 'delete window.__antifanTerminalContext.annotationSessionId;' : `window.__antifanTerminalContext.annotationSessionId = ${JSON.stringify(tabSessionId)};`}
        })();`;
        wc.executeJavaScript(`${termContextScript}\n${ELEMENT_PICKER_SCRIPT}`).catch(() => {});
      }
    });

    wc.on('dom-ready', () => {
      const isMobilePane = paneId === 'mobile' || Boolean(DEVICE_PRESETS.find((p) => p.id === state.devicePresetId)?.mobile);
      if (isMobilePane) {
        wc.insertCSS(MOBILE_OVERLAY_SCROLLBAR_CSS).catch(() => {});
        wc.executeJavaScript(MOBILE_TOUCH_CLIENT_SCRIPT).catch(() => {});
      }
      if (paneId === 'mobile') {
        const splitMobilePreset = DEVICE_PRESETS.find((p) => p.id === state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const splitMobileClipRadius = getPresetCornerRadius(splitMobilePreset);
        this.applyDeviceCornerClipping(wc, splitMobileClipRadius, true);
      } else if (state.devicePresetId && state.devicePresetId !== 'responsive') {
        const clipRadius = getPresetCornerRadius(state.devicePresetId);
        this.applyDeviceCornerClipping(wc, clipRadius, true);
      }
      if (id === this.activeTabId) {
        this.updateLayout();
      }
    });
    wc.on('page-title-updated', (_event, title) => {
      if (paneId === 'desktop') {
        state.title = title || 'Untitled';
        if (state.url && state.url !== 'about:blank' && !state.url.startsWith('view-source:')) {
          HistoryManager.getInstance().updateTitle(state.url, state.title);
        }
        this.broadcastState();

        // Auto-close OAuth completion tab if title indicates success
        if (/Authentication Success|Xác thực thành công|Đăng nhập thành công|Login Success/i.test(title)) {
          setTimeout(() => {
            if (this.tabs.has(id) && this.tabs.size > 1) {
              this.closeTab(id);
            }
          }, 1200);
        }
      }
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      if (paneId === 'desktop' && favicons.length > 0) {
        state.favicon = favicons[0];
        this.broadcastState();
      }
    });

    wc.on('did-navigate', (_event, navUrl) => {
      if (isInternalWidgetOrSubframeUrl(navUrl)) return;
      const currentUrl = wc.getURL();
      const chosenUrl = (currentUrl && currentUrl !== 'about:blank' && !isInternalWidgetOrSubframeUrl(currentUrl))
        ? currentUrl
        : navUrl;
      const cleanUrl = cleanRestoredUrl(chosenUrl);

      if (paneId === 'desktop') {
        state.url = cleanUrl;
        if (state.url && state.url !== 'about:blank' && !state.url.startsWith('view-source:')) {
          HistoryManager.getInstance().recordVisit(state.url, state.title, state.favicon);
        }
      }

        if (OAuthPopupManager.getInstance().isOAuthCallbackUrl(cleanUrl)) {
          setTimeout(() => {
            if (this.tabs.has(id) && this.tabs.size > 1) {
              this.closeTab(id);
            }
          }, 1200);
        }
      const decision = this.splitCoordinator.handleNavigationEvent(id, paneId, cleanUrl, false);
      if (decision.shouldMirror && state.splitMode) {
        const tab = this.tabs.get(id);
        const siblingView = decision.targetPane === 'mobile' ? tab?.mobileView : tab?.view;
        if (siblingView && !siblingView.webContents.isDestroyed()) {
          this.splitCoordinator.markMirrorStarted(id);
          if (decision.historyDirection === 'back') {
            this.safeGoBack(siblingView.webContents);
          } else if (decision.historyDirection === 'forward') {
            this.safeGoForward(siblingView.webContents);
          } else if (decision.mirrorUrl) {
            const siblingUrl = cleanRestoredUrl(siblingView.webContents.getURL());
            if (siblingUrl !== decision.mirrorUrl) {
              siblingView.webContents.loadURL(decision.mirrorUrl).catch(() => {});
            }
          }
        }
      }
      state.canGoBack = this.getCanGoBack(wc);
      state.canGoForward = this.getCanGoForward(wc);
      this.broadcastState();
      this.schedulePersist();
      if (this.isRulerActive && id === this.activeTabId) {
        wc.executeJavaScript(RULER_SCRIPT).catch(() => {});
      }
    });

    wc.on('did-navigate-in-page', (_event, navUrl, isMainFrame) => {
      if (isMainFrame !== false && !isInternalWidgetOrSubframeUrl(navUrl)) {
        const cleanUrl = cleanRestoredUrl(navUrl);
        if (paneId === 'desktop') {
          state.url = cleanUrl;
          if (state.url && state.url !== 'about:blank' && !state.url.startsWith('view-source:')) {
            HistoryManager.getInstance().recordVisit(state.url, state.title, state.favicon);
          }
        }

        const decision = this.splitCoordinator.handleNavigationEvent(id, paneId, cleanUrl, true);
        if (decision.shouldMirror && state.splitMode) {
          const tab = this.tabs.get(id);
          const siblingView = decision.targetPane === 'mobile' ? tab?.mobileView : tab?.view;
          if (siblingView && !siblingView.webContents.isDestroyed()) {
            this.splitCoordinator.markMirrorStarted(id);
            if (decision.historyDirection === 'back') {
              this.safeGoBack(siblingView.webContents);
            } else if (decision.historyDirection === 'forward') {
              this.safeGoForward(siblingView.webContents);
            } else if (decision.mirrorUrl) {
              const siblingUrl = cleanRestoredUrl(siblingView.webContents.getURL());
              if (siblingUrl !== decision.mirrorUrl) {
                siblingView.webContents.loadURL(decision.mirrorUrl).catch(() => {});
              }
            }
          }
        }
        state.canGoBack = this.getCanGoBack(wc);
        state.canGoForward = this.getCanGoForward(wc);
        this.broadcastState();
        this.schedulePersist();
        if (this.isRulerActive && id === this.activeTabId) {
          wc.executeJavaScript(RULER_SCRIPT).catch(() => {});
        }
      }
    });

    wc.on('focus', () => {
      const tab = this.tabs.get(id);
      if (tab && state.splitMode && tab.focusedPane !== paneId) {
        tab.focusedPane = paneId;
        state.splitFocusedPane = paneId;
        this.broadcastState();
      }
    });

    wc.on('render-process-gone', () => {
      clearLoadingTimer();
      state.crashed = true;
      this.broadcastState();
    });

    (wc as unknown as EventEmitter).on('close', () => {
      clearLoadingTimer();
      if (!this.isDisposed && this.tabs.has(id)) {
        this.closeTab(id);
      }
    });

    wc.on('destroyed', () => {
      clearLoadingTimer();
      if (!this.isDisposed && this.tabs.has(id)) {
        this.closeTab(id);
      }
    });

    wc.on('found-in-page', (_event, result) => {
      safeSendWebContents(this.toolbarView?.webContents, TOOLBAR_CHANNELS.FIND_RESULT, result);
    });

    wc.setWindowOpenHandler((details) => {
      return OAuthPopupManager.getInstance().handleWindowOpen(
        wc,
        this.window,
        details,
        {
          onNewTabRequested: (url: string) => {
            if (isAllowedNavigation(url)) {
              this.createTab(url, true);
            }
          },
          onOAuthCompleted: (_callbackUrl: string) => {
            if (!wc.isDestroyed()) {
              wc.reload();
            }
          },
          onExternalRequested: (externalUrl: string) => {
            if (isAllowedNavigation(externalUrl)) {
              shell.openExternal(externalUrl);
            }
          }
        }
      );
    });

    wc.on('zoom-changed', (_event, zoomDirection) => {
      const current = state.zoomFactor || 1.0;
      const step = 0.1;
      const nextZoom = zoomDirection === 'in'
        ? Math.min(5.0, Number((current + step).toFixed(2)))
        : Math.max(0.25, Number((current - step).toFixed(2)));
      this.setZoom(id, nextZoom);
    });

    this.setupGlobalShortcutsOnView(wc);
    this.setupContextMenu(wc, paneId);
  }

  public createTab(initialUrl = 'https://www.google.com', activate = true): string {
    if (this.isDisposed) return '';
    const trimmed = (initialUrl || '').trim();
    if (trimmed && (trimmed.startsWith('file://') || /^[a-zA-Z]:[/\\]/.test(trimmed))) {
      const previewTabId = this.createPreviewTab(trimmed);
      if (previewTabId) return previewTabId;
    }

    const id = randomUUID();
    let capsuleIdForPreview: string | null = null;
    let url = initialUrl;

    if (initialUrl.startsWith('antifan-preview://')) {
      try {
        const { capsuleId, relativePath } = parsePreviewUrl(initialUrl);
        const allCapsules = this.capsuleManager.list();
        const cap = allCapsules.find((c) => c.id.toLowerCase() === capsuleId.toLowerCase());
        if (!cap || !cap.workspacePath || !fs.existsSync(cap.workspacePath)) {
          console.warn(`[native-tab-host] Workspace capsule not found: ${capsuleId}`);
          return '';
        }
        const canonicalRoot = fs.realpathSync.native(path.resolve(cap.workspacePath));
        const resolvedPath = path.resolve(canonicalRoot, relativePath);
        const rel = path.relative(canonicalRoot, resolvedPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          console.warn(`[native-tab-host] Preview path escapes workspace root: ${relativePath}`);
          return '';
        }
        capsuleIdForPreview = cap.id;
        url = initialUrl;
      } catch (err) {
        console.warn(`[native-tab-host] Failed to parse preview url: ${initialUrl}`, err);
        return '';
      }
    } else {
      const cleanInitialUrl = cleanRestoredUrl(initialUrl);
      url = sanitizeUrl(cleanInitialUrl);
    }

    const view = new WebContentsView({
      webPreferences: getSecureWebPreferences(),
    });
    try { view.setBackgroundColor('#ffffff'); } catch {}
    const isBlankUrl = !url || url === 'about:blank';
    const state: AntiFanTab = {
      id,
      url,
      title: 'New Tab',
      isLoading: !isBlankUrl,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1.0,
      devicePresetId: 'responsive',
      crashed: false,
      capsuleId: capsuleIdForPreview || undefined,
    };

    this.setupTabWebContentsEvents(id, view, state, 'desktop');

    this.tabs.set(id, { view, state, focusedPane: 'desktop' });
    this.tabOrder.push(id);

    if (capsuleIdForPreview) {
      const cap = this.capsuleManager.list().find((c) => c.id.toLowerCase() === capsuleIdForPreview!.toLowerCase());
      if (cap && cap.workspacePath && fs.existsSync(cap.workspacePath)) {
        const unsub = this.previewWatcherPool.retain(cap.id, cap.workspacePath, (event) => {
          this.dispatchScopedReload(cap.id, event);
        });
        this.tabPreviewUnsubscribers.set(id, unsub);
      }
    }
    const wc = view.webContents;
    this.setSafeUserAgent(wc, this.defaultUserAgent);
    if (url.startsWith('view-source:')) {
      const sourceTargetUrl = url.slice('view-source:'.length).trim();
      state.title = `view-source:${sourceTargetUrl}`;
      state.url = url;
      this.fetchAndLoadPageSource(wc, sourceTargetUrl, state);
    } else if (url !== 'about:blank') {
      wc.loadURL(url)
        .then(() => this.clearInitialNavigationHistory(wc, state))
        .catch((err: unknown) => {
          if (err && typeof err === 'object' && ('code' in err || 'errno' in err)) {
            const code = 'code' in err ? String(err.code) : '';
            const errno = 'errno' in err ? Number(err.errno) : 0;
            if (code === 'ERR_ABORTED' || errno === -3 || code === 'ERR_FAILED' || errno === -2) {
              state.isLoading = false;
              this.broadcastState();
              return;
            }
          }
          console.warn(`[native-tab-host] Failed to load initial url ${url} on tab ${id}:`, err);
          state.isLoading = false;
          this.broadcastState();
        });
    } else {
      state.isLoading = false;
    }
    if (activate) this.switchTab(id);
    this.schedulePersist();
    recordBenchmark({ surface: 'tabs', name: 'created', extra: { activate, url: url.slice(0, 80) } });
    return id;
  }

  public switchTab(tabId: string): boolean {
    if (this.isDisposed) return false;
    try {
      const target = this.tabs.get(tabId);
      if (!target) return false;
      const switchStartMs = performance.now();

      // Guard against destroyed WebContents/WebContentsView
      if (!target.view || target.view.webContents.isDestroyed()) {
        console.warn(`[native-tab-host] Target tab ${tabId} webContents is destroyed; recreating view`);
        target.view = new WebContentsView({
          webPreferences: getSecureWebPreferences(),
        });
        try { target.view.setBackgroundColor('#ffffff'); } catch {}
        target.state.crashed = false;
        this.setSafeUserAgent(target.view.webContents, this.defaultUserAgent);
        const isBlank = !target.state.url || target.state.url === 'about:blank';
        target.state.isLoading = !isBlank;
        this.setupTabWebContentsEvents(tabId, target.view, target.state, 'desktop');
        if (!isBlank) {
          target.view.webContents.loadURL(target.state.url).catch((err: unknown) => {
            if (err && typeof err === 'object' && ('code' in err || 'errno' in err)) {
              const code = 'code' in err ? String(err.code) : '';
              const errno = 'errno' in err ? Number(err.errno) : 0;
              if (code === 'ERR_ABORTED' || errno === -3) {
                return;
              }
            }
            target.state.isLoading = false;
            this.broadcastState();
          });
        }
      } else if (!target.state.url || target.state.url === 'about:blank') {
        target.state.isLoading = false;
      }

      this.activeTabId = tabId;

      // Safely attach target active tab views FIRST before detaching old views
      // to maintain a continuous valid view hierarchy and avoid focus access violations
      this.attachTabView(target.view, false);
      if (target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed()) {
        this.attachTabView(target.mobileView, true);
      }

      // Defensively ensure no other inactive tab views remain attached
      if (this.window && !this.window.isDestroyed() && this.window.contentView) {
        for (const [id, tab] of this.tabs.entries()) {
          if (id !== tabId) {
            if (tab.view && this.window.contentView.children.includes(tab.view)) {
              try { this.window.contentView.removeChildView(tab.view); } catch {}
            }
            if (tab.mobileView && this.window.contentView.children.includes(tab.mobileView)) {
              try { this.window.contentView.removeChildView(tab.mobileView); } catch {}
            }
          }
        }
      }

      this.updateLayout();
      this.broadcastState();

      if (this.isRulerActive && !target.view.webContents.isDestroyed()) {
        target.view.webContents.executeJavaScript(RULER_SCRIPT).catch(() => {});
        if (target.mobileView && !target.mobileView.webContents.isDestroyed()) {
          target.mobileView.webContents.executeJavaScript(RULER_SCRIPT).catch(() => {});
        }
      }
      if (this.isLensActive && !target.view.webContents.isDestroyed()) {
        target.view.webContents.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
        if (target.mobileView && !target.mobileView.webContents.isDestroyed()) {
          target.mobileView.webContents.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
        }
      }
      if (this.isFontFinderActive && !target.view.webContents.isDestroyed()) {
        target.view.webContents.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
        if (target.mobileView && !target.mobileView.webContents.isDestroyed()) {
          target.mobileView.webContents.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
        }
      }
      if (isBenchmarkEnabled()) {
        recordBenchmark({ surface: 'tabs', name: 'switched', value: performance.now() - switchStartMs, extra: { attachedViews: this.countAttachedViews() } });
      }
      return true;
    } catch (err) {
      console.error('[native-tab-host] switchTab unexpected error:', err);
      return false;
    }
  }

  private activateAgentVisualGlow(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const script = `(() => {
      try {
        if (typeof window.__antifanAgentActive === 'function') {
          window.__antifanAgentActive();
        }
      } catch {}
    })()`;
    if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.executeJavaScript(script).catch(() => {});
    }
    if (tab.mobileView?.webContents && !tab.mobileView.webContents.isDestroyed()) {
      tab.mobileView.webContents.executeJavaScript(script).catch(() => {});
    }
    this.syncFrameBackdrop();
  }

  private deactivateAgentVisualGlow(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const script = `(() => {
      try {
        if (typeof window.__antifanAgentClear === 'function') {
          window.__antifanAgentClear();
        }
      } catch {}
    })()`;
    if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.executeJavaScript(script).catch(() => {});
    }
    if (tab.mobileView?.webContents && !tab.mobileView.webContents.isDestroyed()) {
      tab.mobileView.webContents.executeJavaScript(script).catch(() => {});
    }
    this.syncFrameBackdrop();
  }

  private beginTabAgentWorking(tabId: string): void {
    const target = this.tabs.get(tabId);
    if (!target) return;
    this.agentWorkingRefs.set(tabId, (this.agentWorkingRefs.get(tabId) || 0) + 1);
    if (target.state.aiState !== 'agent_working') {
      target.state.aiState = 'agent_working';
      this.broadcastState();
    }
    this.activateAgentVisualGlow(tabId);
  }

  private clearTabAgentWorking(tabId: string): void {
    const timer = this.agentWorkingTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.agentWorkingTimers.delete(tabId);
    this.agentWorkingRefs.delete(tabId);
    this.deactivateAgentVisualGlow(tabId);
  }

  private endTabAgentWorking(tabId: string): void {
    const refs = (this.agentWorkingRefs.get(tabId) || 0) - 1;
    if (refs > 0) {
      this.agentWorkingRefs.set(tabId, refs);
      return;
    }
    this.agentWorkingRefs.delete(tabId);
    if (!this.agentWorkingTimers.has(tabId)) {
      const target = this.tabs.get(tabId);
      if (target?.state.aiState === 'agent_working') {
        target.state.aiState = 'idle';
        this.broadcastState();
      }
      this.deactivateAgentVisualGlow(tabId);
    }
  }

  private async withTabAgentWorking<T>(tabId: string, action: () => Promise<T>): Promise<T> {
    this.beginTabAgentWorking(tabId);
    try {
      return await action();
    } finally {
      this.endTabAgentWorking(tabId);
    }
  }

  public markTabAgentWorking(tabId?: string, durationMs = 5000): void {
    const targetId = tabId || this.activeTabId;
    const tab = this.tabs.get(targetId);
    if (!tab) return;

    tab.state.aiState = 'agent_working';
    this.broadcastState();
    this.activateAgentVisualGlow(targetId);

    const existingTimer = this.agentWorkingTimers.get(targetId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      if ((this.agentWorkingRefs.get(targetId) || 0) === 0) {
        const current = this.tabs.get(targetId);
        if (current?.state.aiState === 'agent_working') {
          current.state.aiState = 'idle';
          this.broadcastState();
        }
        this.deactivateAgentVisualGlow(targetId);
      }
      this.agentWorkingTimers.delete(targetId);
    }, durationMs);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }

    this.agentWorkingTimers.set(targetId, timer);
  }
  public setTabAiState(tabId: string, aiState: 'idle' | 'thinking' | 'streaming' | 'completed' | 'agent_working'): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.state.aiState = aiState;
    this.broadcastState();
  }
  public clearAllAgentWorking(): void {
    for (const [, timer] of this.agentWorkingTimers.entries()) {
      clearTimeout(timer);
    }
    this.agentWorkingTimers.clear();
    this.agentWorkingRefs.clear();
    for (const [tabId, tab] of this.tabs.entries()) {
      if (tab.state.aiState === 'agent_working') {
        tab.state.aiState = 'idle';
      }
      this.deactivateAgentVisualGlow(tabId);
    }
    this.broadcastState();
    this.syncFrameBackdrop();
  }

  public closeTab(tabId: string): boolean {
    if (this.isDisposed) return false;
    const target = this.tabs.get(tabId);
    if (!target) return false;
    this.clearTabAgentWorking(tabId);
    if (target.state.url && target.state.url !== 'about:blank') {
      this.recentlyClosedTabs.push({ url: target.state.url, title: target.state.title || 'Tab' });
      if (this.recentlyClosedTabs.length > 20) this.recentlyClosedTabs.shift();
    }

    const unsub = this.tabPreviewUnsubscribers.get(tabId);
    if (unsub) {
      try { unsub(); } catch {}
      this.tabPreviewUnsubscribers.delete(tabId);
    }
    this.diagnosticsManager.deleteTab(tabId);
    this.documentGenerations.delete(tabId);
    if (this.automationTabId === tabId) {
      this.automationTabId = null;
    }
    if (this.isInspecting && this.inspectedTabId === tabId) {
      this.stopInspect(tabId);
    }
    if (this.activeTabId === tabId) {
      try {
        this.window.contentView.removeChildView(target.view);
      } catch {}
      if (target.mobileView) {
        try {
          this.window.contentView.removeChildView(target.mobileView);
        } catch {}
      }
    }
    try {
      if (!target.view.webContents.isDestroyed()) {
        (target.view.webContents as unknown as { destroy?: () => void })?.destroy?.();
      }
    } catch {}
    if (target.mobileView) {
      try {
        if (!target.mobileView.webContents.isDestroyed()) {
          (target.mobileView.webContents as unknown as { destroy?: () => void })?.destroy?.();
        }
      } catch {}
    }
    this.splitCoordinator?.cleanupTab(tabId);
    this.tabs.delete(tabId);
    this.tabOrder = this.tabOrder.filter((id) => id !== tabId);

    if (this.activeTabId === tabId) {
      if (this.tabOrder.length > 0) {
        this.switchTab(this.tabOrder[this.tabOrder.length - 1]!);
      } else {
        this.createTab('https://www.google.com');
      }
    } else {
      this.broadcastState();
    }
    recordBenchmark({ surface: 'tabs', name: 'closed', extra: { attachedViews: this.countAttachedViews() } });
    return true;
  }

  public reopenClosedTab(): string | null {
    if (this.recentlyClosedTabs.length === 0) return null;
    const last = this.recentlyClosedTabs.pop();
    if (last && last.url) {
      return this.createTab(last.url);
    }
    return null;
  }

  public moveTab(tabId: string, toIndex: number): boolean {
    const fromIndex = this.tabOrder.indexOf(tabId);
    if (fromIndex === -1 || toIndex < 0 || toIndex >= this.tabOrder.length) return false;
    this.tabOrder.splice(fromIndex, 1);
    this.tabOrder.splice(toIndex, 0, tabId);
    this.broadcastState();
    return true;
  }
  public duplicateTab(tabId: string): string {
    const tab = this.tabs.get(tabId);
    if (!tab) return '';
    const targetUrl = tab.state.url || 'https://www.google.com';
    const newTabId = this.createTab(targetUrl);
    const oldIndex = this.tabOrder.indexOf(tabId);
    if (newTabId && oldIndex !== -1) {
      // Place the duplicated tab directly to the right of the original tab
      this.moveTab(newTabId, oldIndex + 1);
    }
    return newTabId;
  }

  public closeOtherTabs(tabId: string): void {
    const toClose = this.tabOrder.filter((id) => id !== tabId);
    for (const id of toClose) {
      this.closeTab(id);
    }
  }

  public closeTabsToRight(tabId: string): void {
    const idx = this.tabOrder.indexOf(tabId);
    if (idx === -1) return;
    const toClose = this.tabOrder.slice(idx + 1);
    for (const id of toClose) {
      this.closeTab(id);
    }
  }

  public navigate(tabId: string, inputUrl: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const cleanUrl = sanitizeUrl(inputUrl);
    tab.state.url = cleanUrl;
    if (cleanUrl.startsWith('view-source:')) {
      const sourceTargetUrl = cleanUrl.slice('view-source:'.length).trim();
      tab.state.title = `view-source:${sourceTargetUrl}`;
      this.fetchAndLoadPageSource(tab.view.webContents, sourceTargetUrl, tab.state);
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        this.fetchAndLoadPageSource(tab.mobileView.webContents, sourceTargetUrl, tab.state);
      }
    } else {
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        const authorityPane = tab.focusedPane || tab.state.splitFocusedPane || 'desktop';
        this.splitCoordinator.startTransaction(tabId, authorityPane, cleanUrl);
        const authorityView = authorityPane === 'mobile' ? tab.mobileView : tab.view;
        authorityView.webContents.loadURL(cleanUrl).catch(() => {});
      } else {
        tab.view.webContents.loadURL(cleanUrl).catch(() => {});
      }
    }
    return true;
  }
  public async navigateAndWait(tabId: string, inputUrl: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const cleanUrl = sanitizeUrl(inputUrl);
    if (cleanUrl.startsWith('view-source:')) {
      return this.navigate(tabId, inputUrl);
    }
    const authorityPane = tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()
      ? (tab.focusedPane || tab.state.splitFocusedPane || 'desktop')
      : 'desktop';
    const authorityView = authorityPane === 'mobile' && tab.mobileView ? tab.mobileView : tab.view;
    if (!authorityView || authorityView.webContents.isDestroyed()) return false;

    const waiter = this.createNavigationStartWaiter(authorityView.webContents);
    const initiated = this.navigate(tabId, inputUrl);
    if (!initiated) {
      waiter.cancel();
      return false;
    }
    return await waiter.promise;
  }
  public reload(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.reload();
      }
      if (tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        tab.mobileView.webContents.reload();
      }
    } else {
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.reload();
      }
    }
    return true;
  }
  public async reloadAndWait(tabId: string, timeoutMs: number = 3000): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const authorityPane = tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()
      ? (tab.focusedPane || tab.state.splitFocusedPane || 'desktop')
      : 'desktop';
    const authorityView = authorityPane === 'mobile' && tab.mobileView ? tab.mobileView : tab.view;
    if (!authorityView || authorityView.webContents.isDestroyed()) return false;

    const waiter = this.createLoadCompletionWaiter(authorityView.webContents, timeoutMs);
    const initiated = this.reload(tabId);
    if (!initiated) {
      waiter.cancel();
      return false;
    }
    return await waiter.promise;
  }

  private createLoadCompletionWaiter(wc: Electron.WebContents, timeoutMs: number = 3000): { promise: Promise<boolean>; cancel: () => void } {
    let cancelFn: () => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      if (!wc || wc.isDestroyed()) {
        resolve(false);
        return;
      }
      let settled = false;
      const onFinish = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(true);
        }
      };
      const onFail = (_event: unknown, _errorCode: unknown, _errorDescription: unknown, _validatedURL: unknown, isMainFrame?: boolean) => {
        if (isMainFrame === false) {
          return;
        }
        if (!settled) {
          settled = true;
          cleanup();
          resolve(false);
        }
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(false);
        }
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        try { wc.removeListener('did-finish-load', onFinish); } catch {}
        try { wc.removeListener('did-fail-load', onFail); } catch {}
      };
      cancelFn = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(false);
        }
      };
      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
    });
    return { promise, cancel: cancelFn };
  }

  private createNavigationStartWaiter(wc: Electron.WebContents, timeoutMs: number = 3000): { promise: Promise<boolean>; cancel: () => void } {
    let cancelFn: () => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      if (!wc || wc.isDestroyed()) {
        resolve(false);
        return;
      }
      let settled = false;
      const onStart = (_event: unknown, _url: unknown, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace && !settled) {
          settled = true;
          cleanup();
          resolve(true);
        }
      };
      const onFail = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(false);
        }
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(false);
        }
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        try { wc.removeListener('did-start-navigation', onStart); } catch {}
        try { wc.removeListener('did-fail-load', onFail); } catch {}
      };
      cancelFn = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(false);
        }
      };
      wc.on('did-start-navigation', onStart);
      wc.on('did-fail-load', onFail);
    });
    return { promise, cancel: cancelFn };
  }

  public stopLoading(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.view.webContents.stop();
    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      tab.mobileView.webContents.stop();
    }
    return true;
  }

  public goBack(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      const authorityPane = tab.focusedPane || tab.state.splitFocusedPane || 'desktop';
      const authorityView = authorityPane === 'mobile' ? tab.mobileView : tab.view;

      const canAuthBack = this.getCanGoBack(authorityView.webContents);
      if (!canAuthBack) return false;

      this.splitCoordinator.startHistoryTransaction(tabId, authorityPane, 'back');
      return this.safeGoBack(authorityView.webContents);
    }

    return this.safeGoBack(tab.view.webContents);
  }

  public goForward(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      const authorityPane = tab.focusedPane || tab.state.splitFocusedPane || 'desktop';
      const authorityView = authorityPane === 'mobile' ? tab.mobileView : tab.view;

      const canAuthFwd = this.getCanGoForward(authorityView.webContents);
      if (!canAuthFwd) return false;

      this.splitCoordinator.startHistoryTransaction(tabId, authorityPane, 'forward');
      return this.safeGoForward(authorityView.webContents);
    }

    return this.safeGoForward(tab.view.webContents);
  }

  public toggleSplitReview(tabId: string, enabled?: boolean): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const targetEnabled = enabled !== undefined ? enabled : !tab.state.splitMode;

    if (targetEnabled === tab.state.splitMode) {
      return Boolean(tab.state.splitMode);
    }

    tab.state.splitMode = targetEnabled;
    if (targetEnabled) {
      tab.state.splitDesktopPresetId = tab.state.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET;
      tab.state.splitMobilePresetId = tab.state.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET;
      tab.state.splitFocusedPane = 'desktop';
      tab.focusedPane = 'desktop';
      tab.state.splitError = null;

      if (!tab.mobileView) {
        const mobileView = new WebContentsView({
          webPreferences: getSecureWebPreferences(),
        });
        mobileView.setBackgroundColor('#00000000');
        const mobilePreset = DEVICE_PRESETS.find((p) => p.id === tab.state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const mobileUA = getPresetUserAgent(mobilePreset, IPHONE_USER_AGENT);
        this.setSafeUserAgent(mobileView.webContents, mobileUA || IPHONE_USER_AGENT);
        tab.mobileView = mobileView;
        this.setupTabWebContentsEvents(tabId, mobileView, tab.state, 'mobile');

        if (tabId === this.activeTabId) {
          this.attachTabView(mobileView, true);
        }

        if (tab.state.url && tab.state.url !== 'about:blank' && !tab.state.url.startsWith('view-source:')) {
          mobileView.webContents.loadURL(tab.state.url).catch(() => {});
        }
      }
    } else {
      if (tab.mobileView) {
        if (tabId === this.activeTabId) {
          try {
            this.window.contentView.removeChildView(tab.mobileView);
          } catch {}
        }
        try {
          (tab.mobileView.webContents as unknown as { destroy?: () => void })?.destroy?.();
        } catch {}
        tab.mobileView = undefined;
      }
      tab.state.splitFocusedPane = undefined;
      tab.focusedPane = undefined;
      tab.state.splitError = null;
      this.splitCoordinator.cleanupTab(tabId);
    }

    this.updateLayout();
    this.broadcastState();
    this.schedulePersist();
    return Boolean(tab.state.splitMode);
  }

  public setSplitPreset(tabId: string, paneId: SplitPaneId, presetId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    if (paneId === 'desktop') {
      tab.state.splitDesktopPresetId = presetId;
    } else {
      tab.state.splitMobilePresetId = presetId;
    }

    this.updateLayout();
    this.broadcastState();
    this.schedulePersist();
    return true;
  }

  public setSplitFocusedPane(tabId: string, paneId: SplitPaneId): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.focusedPane = paneId;
    tab.state.splitFocusedPane = paneId;
    this.broadcastState();
    return true;
  }

  private applyTabDeviceEmulation(
    tab: NativeTabRecord,
    availableWidth: number,
    availableHeight: number,
    toolbarHeight: number
  ): void {
    if (!tab || !tab.view) return;
    if (tab.view.webContents.isDestroyed()) return;

    try {
      // Case A: Split Review Mode (Desktop + Mobile Paired WebContentsViews)
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        const userZoom = tab.state.zoomFactor || 1.0;
        const splitLayout = calculateSplitLayout(
          { width: availableWidth, height: availableHeight, yOffset: toolbarHeight },
          tab.state.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET,
          tab.state.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET,
          userZoom
        );
        // Ensure transparent view backgrounds so clipped corners do not render opaque white rectangles
        try { tab.view.setBackgroundColor('#00000000'); } catch {}
        try { tab.mobileView?.setBackgroundColor('#00000000'); } catch {}

        // Dynamic corner clipping for mobile pane, clear for desktop
        const splitMobilePreset = DEVICE_PRESETS.find((p) => p.id === tab.state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const splitMobileClipRadius = getPresetCornerRadius(splitMobilePreset);
        this.applyDeviceCornerClipping(tab.view.webContents, 0);
        this.applyDeviceCornerClipping(tab.mobileView.webContents, splitMobileClipRadius);
        const desktopPreset = DEVICE_PRESETS.find((p) => p.id === tab.state.splitDesktopPresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_DESKTOP_PRESET);
        const desktopUA = getPresetUserAgent(desktopPreset, this.defaultUserAgent);
        this.setSafeUserAgent(tab.view.webContents, desktopUA || this.defaultUserAgent);
        this.applyCdpTouchEmulation(tab.view.webContents, false);

        this.safeEnableDeviceEmulation(tab.view.webContents, {
          screenPosition: 'desktop',
          screenSize: { width: splitLayout.desktop.emulatedWidth, height: splitLayout.desktop.emulatedHeight },
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: splitLayout.desktop.deviceScaleFactor,
          viewSize: { width: splitLayout.desktop.emulatedWidth, height: splitLayout.desktop.emulatedHeight },
          scale: splitLayout.desktop.scale,
        });
        // Emulation scale already handles visual zoom; keep zoomFactor at 1 to prevent double-scaling
        try {
          if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.setZoomFactor(1);
          }
        } catch {}
        try {
          tab.view.setBounds({
            x: splitLayout.desktop.x,
            y: splitLayout.desktop.y,
            width: splitLayout.desktop.width,
            height: splitLayout.desktop.height,
          });
        } catch {}

        // Mobile view emulation & bounds
        const mobilePreset = DEVICE_PRESETS.find((p) => p.id === tab.state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const mobileUA = getPresetUserAgent(mobilePreset, IPHONE_USER_AGENT);
        this.setSafeUserAgent(tab.mobileView.webContents, mobileUA || IPHONE_USER_AGENT);
        this.applyCdpTouchEmulation(tab.mobileView.webContents, true);
        try {
          if (!tab.mobileView.webContents.isDestroyed()) {
            tab.mobileView.webContents.insertCSS(MOBILE_OVERLAY_SCROLLBAR_CSS).catch(() => {});
          }
        } catch {}

        this.safeEnableDeviceEmulation(tab.mobileView.webContents, {
          screenPosition: 'mobile',
          screenSize: { width: splitLayout.mobile.emulatedWidth, height: splitLayout.mobile.emulatedHeight },
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: splitLayout.mobile.deviceScaleFactor,
          viewSize: { width: splitLayout.mobile.emulatedWidth, height: splitLayout.mobile.emulatedHeight },
          scale: splitLayout.mobile.scale,
        });
        // Emulation scale already handles visual zoom; keep zoomFactor at 1 to prevent double-scaling
        try {
          if (!tab.mobileView.webContents.isDestroyed()) {
            tab.mobileView.webContents.setZoomFactor(1);
          }
        } catch {}
        try {
          tab.mobileView.setBounds({
            x: splitLayout.mobile.x,
            y: splitLayout.mobile.y,
            width: splitLayout.mobile.width,
            height: splitLayout.mobile.height,
          });
        } catch {}
        return;
      }

      // Case B: Standard Single-View Preset or Fluid Responsive
      const preset = DEVICE_PRESETS.find((p) => p.id === tab.state.devicePresetId);

      if (preset && preset.width && preset.height) {
        const userZoom = tab.state.zoomFactor || 1.0;
        const maxW = Math.max(100, availableWidth);
        const maxH = Math.max(100, availableHeight);

        const fitScale = Math.min(1.0, maxW / preset.width, maxH / preset.height);
        const renderScale = Math.max(0.1, Math.min(5.0, fitScale * userZoom));
        const renderedW = Math.round(preset.width * renderScale);
        const renderedH = Math.round(preset.height * renderScale);
        const targetX = Math.max(0, Math.floor((maxW - renderedW) / 2));
        const targetY = toolbarHeight + Math.max(0, Math.floor((maxH - renderedH) / 2));

        const ua = getPresetUserAgent(preset, preset.mobile ? IPHONE_USER_AGENT : this.defaultUserAgent);
        this.setSafeUserAgent(tab.view.webContents, ua || this.defaultUserAgent);
        this.applyCdpTouchEmulation(tab.view.webContents, Boolean(preset.mobile));
        if (preset.mobile) {
          try {
            if (!tab.view.webContents.isDestroyed()) {
              tab.view.webContents.insertCSS(MOBILE_OVERLAY_SCROLLBAR_CSS).catch(() => {});
            }
          } catch {}
        }

        this.safeEnableDeviceEmulation(tab.view.webContents, {
          screenPosition: preset.mobile ? 'mobile' : 'desktop',
          screenSize: { width: preset.width, height: preset.height },
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: preset.deviceScaleFactor || (preset.category === 'desktop' ? 1 : 2),
          viewSize: { width: preset.width, height: preset.height },
          scale: renderScale,
        });
        // Dynamic corner clipping per-device preset, clear for desktop/flat screens
        const clipRadius = getPresetCornerRadius(preset);
        if (clipRadius > 0) {
          try { tab.view.setBackgroundColor('#00000000'); } catch {}
        }
        this.applyDeviceCornerClipping(tab.view.webContents, clipRadius);

        // Emulation scale already handles visual zoom; keep zoomFactor at 1 to prevent double-scaling
        try {
          if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.setZoomFactor(1);
          }
        } catch {}
        try {
          tab.view.setBounds({
            x: targetX,
            y: targetY,
            width: renderedW,
            height: renderedH,
          });
        } catch {}
      } else {
        this.applyDeviceCornerClipping(tab.view.webContents, 0);
        try { tab.view.setBackgroundColor('#ffffff'); } catch {}
        this.applyCdpTouchEmulation(tab.view.webContents, false);
        this.setSafeUserAgent(tab.view.webContents, this.defaultUserAgent);
        this.safeDisableDeviceEmulation(tab.view.webContents);

        const userZoom = tab.state.zoomFactor || 1.0;
        try {
          if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.setZoomFactor(userZoom);
          }
        } catch {}
        try {
          tab.view.setBounds({
            x: 0,
            y: toolbarHeight,
            width: availableWidth,
            height: availableHeight,
          });
        } catch {}
      }
    } catch (err) {
      console.error('[native-tab-host] applyTabDeviceEmulation error:', err);
    }
  }
  public setZoom(tabId: string, zoomFactor: number): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const clamped = Math.max(0.25, Math.min(zoomFactor, 5.0));
    tab.state.zoomFactor = clamped;
    this.updateLayout();
    this.broadcastState();
    return true;
  }
  private async applyCdpTouchEmulation(wc: Electron.WebContents, enableTouch: boolean): Promise<void> {
    if (!wc || (wc as unknown as { isDestroyed?: () => boolean }).isDestroyed?.()) return;
    try {
      if (!wc.debugger) return;
      if (!enableTouch) {
        if (wc.debugger.isAttached()) {
          try {
            await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
              enabled: false,
            }).catch(() => {});
            await wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', {
              enabled: false,
            }).catch(() => {});
          } catch {}
        }
        return;
      }

      // enableTouch === true: only attach if necessary
      if (!wc.debugger.isAttached()) {
        try {
          wc.debugger.attach('1.3');
        } catch {}
      }
      if (wc.debugger.isAttached()) {
        await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: 5,
        }).catch(() => {});
        // Keep touch capability without hijacking mouse movements so hover, context menu, and annotation picker work smoothly
        await wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', {
          enabled: false,
        }).catch(() => {});
      }
    } catch {}
  }

  private setSafeUserAgent(wc: Electron.WebContents, targetUA: string): void {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
    if (!targetUA) return;
    try {
      if (typeof wc.setUserAgent === 'function') {
        const currentUA = typeof wc.getUserAgent === 'function' ? wc.getUserAgent() : undefined;
        if (currentUA !== targetUA) {
          wc.setUserAgent(targetUA);
        }
      }
    } catch (err) {
      console.warn('[native-tab-host] Failed to set user agent:', err);
    }
  }

  private applyDeviceCornerClipping(wc: Electron.WebContents, radiusPx: number, force: boolean = false): void {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
    const prev = this.appliedClipRadius.get(wc);
    if (!force && prev === radiusPx) return;
    this.appliedClipRadius.set(wc, radiusPx);
    if (radiusPx <= 0 && (prev === undefined || prev <= 0)) return;
    const script = `(() => {
      const style = document.getElementById('antifan-device-clip');
      if (style) style.remove();
    })()`;
    wc.executeJavaScript(script).catch(() => {});
  }

  public setDevicePreset(tabId: string, presetId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.state.devicePresetId = presetId;
    this.updateLayout();
    return true;
  }

  public openExternal(url?: string): boolean {
    const targetUrl = url || this.getActiveTab()?.url;
    if (targetUrl && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      shell.openExternal(targetUrl);
      return true;
    }
    return false;
  }

  public toggleBookmark(url: string, title?: string): boolean {
    const existingIndex = this.bookmarks.findIndex((b) => b.url === url);
    if (existingIndex >= 0) {
      this.bookmarks.splice(existingIndex, 1);
      return false;
    } else {
      this.bookmarks.push({
        id: randomUUID(),
        url,
        title: title || url,
        createdAt: Date.now(),
      });
      return true;
    }
  }

  public toggleDevTools(): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;
    const wc = active.view.webContents;
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools();
    } else {
      wc.openDevTools({ mode: 'bottom' });
    }
  }

  public toggleFontFinder(): boolean {
    if (this.isFontFinderActive) {
      this.stopFontFinder();
    } else {
      this.startFontFinder();
    }
    return this.isFontFinderActive;
  }

  public startFontFinder(): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;
    this.isFontFinderActive = true;
    active.view.webContents.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
    this.broadcastState();
  }

  public stopFontFinder(): void {
    this.isFontFinderActive = false;
    const active = this.tabs.get(this.activeTabId);
    if (active) {
      active.view.webContents.executeJavaScript(`(() => {
        const bg = document.getElementById('antifan-font-badge');
        if (bg) bg.remove();
        const ov = document.getElementById('antifan-font-overlay');
        if (ov) ov.remove();
        if (document.documentElement) document.documentElement.style.cursor = '';
        window.__antifanFontFinderActive = false;
      })()`).catch(() => {});
    }
    this.broadcastState();
  }

  public toggleLens(): boolean {
    if (this.isLensActive) {
      this.stopLens();
    } else {
      this.startLens();
    }
    return this.isLensActive;
  }

  public async startLens(): Promise<void> {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;
    this.isLensActive = true;
    try {
      const img = await active.view.webContents.capturePage();
      const dataUrl = img.toDataURL();
      await active.view.webContents.executeJavaScript(`(() => {
        window.__antifanLensScreenshot = ${JSON.stringify(dataUrl)};
        if (window.__antifanLensUpdateSnapshot) {
          window.__antifanLensUpdateSnapshot(${JSON.stringify(dataUrl)});
        }
      })()`);
    } catch (err) {
      console.error('[native-tab-host] Failed to capture page for lens:', err);
    }
    active.view.webContents.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
    this.broadcastState();
  }

  public stopLens(): void {
    this.isLensActive = false;
    const active = this.tabs.get(this.activeTabId);
    if (active) {
      active.view.webContents.executeJavaScript(`(() => {
        if (window.__antifanLensCleanup) window.__antifanLensCleanup();
        const lens = document.getElementById('antifan-gpu-lens');
        if (lens) lens.remove();
        window.__antifanLensActive = false;
      })()`).catch(() => {});
    }
    this.broadcastState();
  }

  public toggleRuler(): boolean {
    if (this.isRulerActive) {
      this.stopRuler();
    } else {
      this.startRuler();
    }
    return this.isRulerActive;
  }

  public startRuler(): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;
    this.isRulerActive = true;
    active.view.webContents.executeJavaScript(RULER_SCRIPT).catch(() => {});
    this.broadcastState();
  }

  public stopRuler(): void {
    this.isRulerActive = false;
    for (const [, tab] of this.tabs) {
      tab.view.webContents.executeJavaScript(`(() => {
        if (window.__antifanRulerCleanup) window.__antifanRulerCleanup();
        const grid = document.getElementById('__antifan_ruler_grid');
        if (grid) grid.remove();
        window.__antifanRulerActive = false;
      })()`).catch(() => {});
    }
    this.broadcastState();
  }

  // ─── Agent Browser Automation & Visual Cursor ───
  public async ensureAgentBrowserInjected(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    const target = this.tabs.get(tabId || this.activeTabId);
    if (!target) return false;
    const wc = this.getTabWebContents(target.state.id, paneId || target.focusedPane);
    if (!wc) return false;
    try {
      await wc.executeJavaScript(AGENT_BROWSER_SCRIPT);
      return true;
    } catch {
      return false;
    }
  }

  public async agentClick(params: { selector?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const targetId = params.tabId || this.automationTabId || this.activeTabId;
    const target = this.tabs.get(targetId);
    if (!target) return false;
    const wc = this.getTabWebContents(targetId, params.paneId || target.focusedPane);
    if (!wc) return false;
    this.beginTabAgentWorking(targetId);
    try {
      if (!await this.ensureAgentBrowserInjected(targetId, params.paneId || target.focusedPane)) return false;
      return Boolean(await wc.executeJavaScript(`(async () => {
        if (typeof window.__antifanAgentClick !== 'function') return false;
        return await window.__antifanAgentClick(${JSON.stringify(params.selector || '')}, ${typeof params.x === 'number' ? params.x : 'null'}, ${typeof params.y === 'number' ? params.y : 'null'}, ${JSON.stringify(params.label || '')});
      })()`));
    } catch (err) {
      console.error('[native-tab-host] agentClick error:', err);
      return false;
    } finally {
      this.endTabAgentWorking(targetId);
    }
  }

  public async agentType(params: { selector: string; text: string; clear?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const targetId = params.tabId || this.automationTabId || this.activeTabId;
    const target = this.tabs.get(targetId);
    if (!target) return false;
    const wc = this.getTabWebContents(targetId, params.paneId || target.focusedPane);
    if (!wc) return false;
    return this.withTabAgentWorking(targetId, async () => {
      if (!await this.ensureAgentBrowserInjected(targetId, params.paneId || target.focusedPane)) return false;
      try {
        return Boolean(await wc.executeJavaScript(`(async () => {
          if (typeof window.__antifanAgentType !== 'function') return false;
          return await window.__antifanAgentType(${JSON.stringify(params.selector)}, ${JSON.stringify(params.text)}, ${params.clear ? 'true' : 'false'});
        })()`));
      } catch (err) {
        console.error('[native-tab-host] agentType error:', err);
        return false;
      }
    });
  }

  public async agentScroll(params: { deltaY?: number; selector?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const targetId = params.tabId || this.automationTabId || this.activeTabId;
    const target = this.tabs.get(targetId);
    if (!target) return false;
    const wc = this.getTabWebContents(targetId, params.paneId || target.focusedPane);
    if (!wc) return false;
    return this.withTabAgentWorking(targetId, async () => {
      if (!await this.ensureAgentBrowserInjected(targetId, params.paneId || target.focusedPane)) return false;
      try {
        return Boolean(await wc.executeJavaScript(`(async () => {
          if (typeof window.__antifanAgentScroll !== 'function') return false;
          return await window.__antifanAgentScroll(${typeof params.deltaY === 'number' ? params.deltaY : 400}, ${JSON.stringify(params.selector || '')});
        })()`));
      } catch (err) {
        console.error('[native-tab-host] agentScroll error:', err);
        return false;
      }
    });
  }

  public async agentHover(params: { selector?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const targetId = params.tabId || this.automationTabId || this.activeTabId;
    const target = this.tabs.get(targetId);
    if (!target) return false;
    const wc = this.getTabWebContents(targetId, params.paneId || target.focusedPane);
    if (!wc) return false;
    return this.withTabAgentWorking(targetId, async () => {
      if (!await this.ensureAgentBrowserInjected(targetId, params.paneId || target.focusedPane)) return false;
      try {
        let targetX = params.x;
        let targetY = params.y;
        if (params.selector) {
          const rect = await wc.executeJavaScript(`(() => {
            const el = document.querySelector(${JSON.stringify(params.selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()`);
          if (rect) {
            targetX = rect.x;
            targetY = rect.y;
          }
        }
        if (typeof targetX === 'number' && typeof targetY === 'number') {
          return Boolean(await wc.executeJavaScript(`(async () => {
            if (typeof window.__antifanAgentMove !== 'function') return false;
            return await window.__antifanAgentMove(${targetX}, ${targetY}, ${JSON.stringify(params.label || 'Hovering')});
          })()`));
        }
        return false;
      } catch (err) {
        console.error('[native-tab-host] agentHover error:', err);
        return false;
      }
    });
  }

  public async agentHighlight(params: { selector: string; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const targetId = params.tabId || this.automationTabId || this.activeTabId;
    const target = this.tabs.get(targetId);
    if (!target) return false;
    const wc = this.getTabWebContents(targetId, params.paneId || target.focusedPane);
    if (!wc) return false;
    return this.withTabAgentWorking(targetId, async () => {
      if (!await this.ensureAgentBrowserInjected(targetId, params.paneId || target.focusedPane)) return false;
      try {
        return Boolean(await wc.executeJavaScript(`(async () => {
          if (typeof window.__antifanAgentHighlight !== 'function') return false;
          return await window.__antifanAgentHighlight(${JSON.stringify(params.selector)}, ${JSON.stringify(params.label || '')});
        })()`));
      } catch (err) {
        console.error('[native-tab-host] agentHighlight error:', err);
        return false;
      }
    });
  }

  public async agentClear(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    const target = this.tabs.get(tabId || this.automationTabId || this.activeTabId);
    if (!target) return false;
    const wc = this.getTabWebContents(target.state.id, paneId || target.focusedPane);
    if (!wc) return false;
    try {
      await wc.executeJavaScript(`(() => {
        if (window.__antifanAgentClear) {
          window.__antifanAgentClear();
        }
      })()`);
      return true;
    } catch {
      return false;
    }
  }

  public toggleInspect(): boolean {
    if (this.isInspecting) {
      this.stopInspect();
    } else {
      this.startInspect();
    }
    return this.isInspecting;
  }

  public isInspectActive(): boolean {
    return this.isInspecting;
  }

  public startInspect(): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;
    this.inspectedTabId = this.activeTabId;

    const tm = TerminalManager.getInstance();
    const activeSessionId = tm.getActiveSessionId();
    const tabSessionId = this.getTabTerminalSession(this.activeTabId);
    const termContextData: Record<string, unknown> = {
      tabId: this.activeTabId,
      sessions: tm.listSessions(),
      selectedSessionId: activeSessionId,
    };
    if (tabSessionId !== undefined) {
      termContextData.annotationSessionId = tabSessionId;
    }
    const termContextScript = `(() => {
      window.__antifanTerminalContext = Object.assign(window.__antifanTerminalContext || {}, ${JSON.stringify(termContextData)});
      ${tabSessionId === undefined ? 'delete window.__antifanTerminalContext.annotationSessionId;' : `window.__antifanTerminalContext.annotationSessionId = ${JSON.stringify(tabSessionId)};`}
    })();`;
    this.isInspecting = true;
    const targetWcs: Array<{ wc: Electron.WebContents; paneId: SplitPaneId }> = [];
    if (active.view && !active.view.webContents.isDestroyed()) {
      targetWcs.push({ wc: active.view.webContents, paneId: 'desktop' });
    }
    if (active.state.splitMode && active.mobileView && !active.mobileView.webContents.isDestroyed()) {
      targetWcs.push({ wc: active.mobileView.webContents, paneId: 'mobile' });
    }

    for (const { wc } of targetWcs) {
      wc.executeJavaScript(`${termContextScript}\n${ELEMENT_PICKER_SCRIPT}`).catch(() => {});
    }
    this.broadcastState();

    if (this.inspectPollTimer) clearInterval(this.inspectPollTimer);
    this.inspectPollTimer = setInterval(async () => {
      if (!this.isInspecting) {
        if (this.inspectPollTimer) clearInterval(this.inspectPollTimer);
        return;
      }
      try {
        const liveSessions = TerminalManager.getInstance().listSessions();
        const targetTabId = this.inspectedTabId || this.activeTabId;
        const targetTab = this.tabs.get(targetTabId);
        if (!targetTab) return;

        const currentWcs: Array<{ wc: Electron.WebContents; paneId: SplitPaneId }> = [];
        if (targetTab.view && !targetTab.view.webContents.isDestroyed()) {
          currentWcs.push({ wc: targetTab.view.webContents, paneId: 'desktop' });
        }
        if (targetTab.state.splitMode && targetTab.mobileView && !targetTab.mobileView.webContents.isDestroyed()) {
          currentWcs.push({ wc: targetTab.mobileView.webContents, paneId: 'mobile' });
        }

        for (const { wc, paneId } of currentWcs) {
          if (!this.isInspecting) break;
          if (wc.isDestroyed()) continue;
          const currentCtx = await wc.executeJavaScript('window.__antifanTerminalContext?.annotationSessionId').catch(() => null);
          if (typeof currentCtx === 'string' && (currentCtx === 'auto' || liveSessions.some((s) => s.id === currentCtx))) {
            targetTab.state.terminalSessionId = currentCtx;
          }
          const rawResult = await wc.executeJavaScript('window.__antifanPick').catch(() => null);
          if (rawResult) {
            await wc.executeJavaScript('window.__antifanPick = null;').catch(() => {});
            this.stopInspect(targetTabId);
            if (rawResult.canceled) return;

            // Automatically focus the pane where user picked/annotated the element!
            if (targetTab.state.splitMode) {
              targetTab.focusedPane = paneId;
              targetTab.state.splitFocusedPane = paneId;
              this.broadcastState();
            }

            if (typeof rawResult.targetSessionId === 'string' && (rawResult.targetSessionId === 'auto' || liveSessions.some((s) => s.id === rawResult.targetSessionId))) {
              targetTab.state.terminalSessionId = rawResult.targetSessionId;
            }

            let targetImageBase64: string | undefined = rawResult.targetImageBase64 || rawResult.screenshotBase64;
            let viewportImageBase64: string | undefined = rawResult.viewportImageBase64;

            try {
              const fullImage = await wc.capturePage();
              if (!fullImage.isEmpty()) {
                viewportImageBase64 = fullImage.toPNG().toString('base64');
                const imgSize = fullImage.getSize();
                if (rawResult.clientRect && rawResult.clientRect.width > 0 && rawResult.clientRect.height > 0 && imgSize.width > 0 && imgSize.height > 0) {
                  const domSize = await wc.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })').catch(() => null);
                  const scaleX = (domSize && typeof domSize.w === 'number' && domSize.w > 0) ? (imgSize.width / domSize.w) : 1.0;
                  const scaleY = (domSize && typeof domSize.h === 'number' && domSize.h > 0) ? (imgSize.height / domSize.h) : 1.0;

                  const cropX = Math.max(0, Math.min(imgSize.width - 1, Math.floor(rawResult.clientRect.x * scaleX)));
                  const cropY = Math.max(0, Math.min(imgSize.height - 1, Math.floor(rawResult.clientRect.y * scaleY)));
                  const cropW = Math.max(1, Math.min(imgSize.width - cropX, Math.ceil(rawResult.clientRect.width * scaleX)));
                  const cropH = Math.max(1, Math.min(imgSize.height - cropY, Math.ceil(rawResult.clientRect.height * scaleY)));

                  const cropped = fullImage.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
                  if (!cropped.isEmpty()) {
                    targetImageBase64 = cropped.toPNG().toString('base64');
                  }
                }
              }
            } catch (err) {
              console.error('[native-tab-host] capture and crop error:', err);
            }
            const tmActiveId = TerminalManager.getInstance().getActiveSessionId();
            const targetSessionId = rawResult.targetSessionId || (tmActiveId !== 'auto' ? tmActiveId : undefined);
            const targetWorkspace = this.resolveTargetWorkspace(targetSessionId, targetTab?.state.url);
            const annotationWorkspace = this.resolveAnnotationWorkspace(targetSessionId, targetTab?.state.url);

            const annotationResult = await AnnotationManager.getInstance().processAnnotationPayload({
              ...rawResult,
              url: targetTab.state.url,
              title: targetTab.state.title,
              targetImageBase64,
              viewportImageBase64,
              workspaceDir: annotationWorkspace,
            });
            const annotationPayload = stripDeliveryMode(rawResult);
            const pickedData: AntiFanPickedElement = {
              ...annotationPayload,
              screenshotBase64: targetImageBase64,
              markdownPath: annotationResult.markdownPath,
              markdownContent: annotationResult.markdownContent,
              targetImagePath: annotationResult.targetImagePath,
              viewportImagePath: annotationResult.viewportImagePath,
              userComment: rawResult.userComment,
              timestamp: Date.now(),
            };

            this.emit('element-picked', pickedData);

            // Notify Toolbar
            safeSendWebContents(this.toolbarView?.webContents, TOOLBAR_CHANNELS.ELEMENT_PICKED, pickedData);

            const formatPath = (p?: string) => {
              if (!p) return '';
              if (targetWorkspace) {
                try {
                  const rel = path.relative(targetWorkspace, p).replace(/\\/g, '/');
                  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                    return rel.startsWith('.') ? rel : `./${rel}`;
                  }
                } catch {}
              }
              return p.replace(/\\/g, '/');
            };

            const promptText = rawResult.userComment?.trim() || 'Inspect the attached browser annotation, report observed evidence, and ask for the intended outcome before editing.';
            let fullPrompt = promptText;
            if (annotationResult.markdownPath) {
              fullPrompt += ` @${formatPath(annotationResult.markdownPath)}`;
            }
            if (annotationResult.targetImagePath) {
              fullPrompt += ` @${formatPath(annotationResult.targetImagePath)}`;
            }

            // 1. Direct write to TerminalManager session PTY (immediate submit; queue/draft removed)
            dispatchAnnotationToTerminal(tm, targetSessionId, fullPrompt);

            // 2. Also copy to OS clipboard for instant convenience
            try {
              clipboard.writeText(fullPrompt);
            } catch {}

            break;
          }
        }
      } catch {}
    }, 200);
  }

  public stopInspect(targetTabId?: string): void {
    this.isInspecting = false;
    if (this.inspectPollTimer) {
      clearInterval(this.inspectPollTimer);
      this.inspectPollTimer = null;
    }
    const tabIdToClean = targetTabId || this.inspectedTabId || this.activeTabId;
    this.inspectedTabId = null;
    const target = this.tabs.get(tabIdToClean);
    if (target) {
      const cleanScript = `(() => {
        try { if (typeof window.__antifanPickerCleanup === 'function') window.__antifanPickerCleanup(); } catch {}
        document.querySelectorAll('#antifan-inspect-overlay, #antifan-inspect-badge, #antifan-comment-modal, #antifan-multi-dock, .antifan-element-pin').forEach(el => {
          try { el.remove(); } catch {}
        });
        if (document.documentElement) document.documentElement.style.cursor = '';
        window.__antifanPickerActive = false;
      })()`;
      if (!target.view.webContents.isDestroyed()) {
        target.view.webContents.executeJavaScript(cleanScript).catch(() => {});
      }
      if (target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed()) {
        target.mobileView.webContents.executeJavaScript(cleanScript).catch(() => {});
      }
    }
    this.emit('inspect-toggled', false);
    this.broadcastState();
  }
  public getTabTerminalSession(tabId: string): string | undefined {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.state.terminalSessionId) return undefined;
    const sessionId = tab.state.terminalSessionId;
    if (sessionId === 'auto') return 'auto';
    const tm = TerminalManager.getInstance();
    const valid = tm.listSessions().some((s) => s.id === sessionId);
    if (!valid) {
      tab.state.terminalSessionId = undefined;
      return undefined;
    }
    return sessionId;
  }

  public setTabTerminalSession(tabId: string, terminalSessionId?: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (typeof terminalSessionId === 'string' && terminalSessionId) {
      const tm = TerminalManager.getInstance();
      const valid = terminalSessionId === 'auto' || tm.listSessions().some((s) => s.id === terminalSessionId);
      tab.state.terminalSessionId = valid ? terminalSessionId : undefined;
    } else {
      tab.state.terminalSessionId = undefined;
    }
    this.broadcastState();
    return true;
  }

  public getLastAnnotationSessionId(tabId?: string): string | undefined {
    return this.getTabTerminalSession(tabId || this.activeTabId);
  }

  public setLastAnnotationSessionId(sessionId?: string, tabId?: string): void {
    this.setTabTerminalSession(tabId || this.activeTabId, sessionId);
  }

  public resolveTargetWorkspace(targetSessionId?: string, tabUrl?: string): string {
    const tm = TerminalManager.getInstance();
    if (targetSessionId && targetSessionId !== 'auto') {
      const session = tm.getSession(targetSessionId);
      if (session?.cwd && fs.existsSync(path.normalize(session.cwd))) {
        return path.normalize(session.cwd);
      }
    }

    // 2. Active capsule workspace
    const capsuleWs = this.capsuleManager.getActive()?.workspacePath;
    if (capsuleWs && fs.existsSync(path.normalize(capsuleWs))) {
      return path.normalize(capsuleWs);
    }

    // 3. Check active session from TerminalManager
    const activeTermId = tm.getActiveSessionId();
    if (activeTermId) {
      const activeTerm = tm.getSession(activeTermId);
      if (activeTerm?.cwd && fs.existsSync(path.normalize(activeTerm.cwd))) {
        return path.normalize(activeTerm.cwd);
      }
    }

    // 4. Try to classify based on tab URL (e.g. seahorse.com.vn -> customizes/Seahorse2)
    if (tabUrl) {
      const urlWorkspace = resolveWorkspaceFromUrl(tabUrl, DEFAULT_WORKSPACE_ROOTS);
      if (urlWorkspace) {
        return urlWorkspace;
      }
    }


    // 6. Current CWD from TerminalManager
    const tmCwd = tm.getCurrentCwd();
    if (tmCwd && fs.existsSync(path.normalize(tmCwd))) {
      return path.normalize(tmCwd);
    }

    // 7. Default fallback: e:\Work if exists, else process.cwd()
    if (fs.existsSync('e:\\Work')) {
      return 'e:\\Work';
    }
    return process.cwd();
  }

  /**
   * Workspace for storing annotation artifacts. An explicit terminal session
   * chosen in the picker dropdown wins (user intent), else the annotated URL's
   * project (so annotations never leak into an unrelated active session),
   * else the same delivery resolution as before.
   */
  public resolveAnnotationWorkspace(targetSessionId?: string, tabUrl?: string): string {
    if (targetSessionId && targetSessionId !== 'auto') {
      const tm = TerminalManager.getInstance();
      const session = tm.getSession(targetSessionId);
      if (session?.cwd && fs.existsSync(path.normalize(session.cwd))) {
        return path.normalize(session.cwd);
      }
    }
    const urlWorkspace = resolveWorkspaceFromUrl(tabUrl, DEFAULT_WORKSPACE_ROOTS);
    if (urlWorkspace) {
      return urlWorkspace;
    }
    return this.resolveTargetWorkspace(targetSessionId, tabUrl);
  }


  public findInPage(text: string, forward = true, findNext = false): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active || !text) return;
    active.view.webContents.findInPage(text, { forward, findNext });
  }

  public stopFindInPage(): void {
    const active = this.tabs.get(this.activeTabId);
    if (active) {
      active.view.webContents.stopFindInPage('clearSelection');
    }
  }

  public async captureScreenshot(rect?: Rectangle, tabId?: string, paneId?: SplitPaneId): Promise<string> {
    const targetId = tabId || this.activeTabId;
    const target = this.tabs.get(targetId);
    if (!target) return '';
    const wc = this.getTabWebContents(targetId, paneId || target.focusedPane);
    if (!wc) return '';
    return this.withTabAgentWorking(targetId, async () => {
      try {
        let img = await wc.capturePage(rect);
        for (let retry = 0; retry < 3 && (typeof img?.isEmpty === 'function' ? img.isEmpty() : false); retry++) {
          await new Promise((r) => setTimeout(r, 150));
          img = await wc.capturePage(rect);
        }
        const hasContent = typeof img?.isEmpty === 'function' ? !img.isEmpty() : Boolean(img && typeof img.toPNG === 'function');
        if (hasContent) {
          return img.toPNG().toString('base64');
        }
      } catch {}

      try {
        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3');
        }
        const cdpRes = (await wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          clip: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } : undefined,
        })) as { data?: string };
        if (cdpRes && typeof cdpRes.data === 'string' && cdpRes.data.length > 0) {
          return cdpRes.data;
        }
      } catch {}

      return '';
    });
  }

  public async getDom(selector?: string, tabId?: string, paneId?: SplitPaneId): Promise<string> {
    const targetId = tabId || this.activeTabId;
    const target = this.tabs.get(targetId);
    if (!target) return '';
    const wc = this.getTabWebContents(targetId, paneId || target.focusedPane);
    if (!wc) return '';
    return this.withTabAgentWorking(targetId, async () => {
      const script = selector
        ? `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            return el ? el.outerHTML : '';
          })()`
        : `(() => document.documentElement ? document.documentElement.outerHTML : '')()`;
      return wc.executeJavaScript(script);
    });
  }

  public async evalJs(expression: string, tabId?: string, paneId?: SplitPaneId): Promise<unknown> {
    const targetId = tabId || this.activeTabId;
    const target = this.tabs.get(targetId);
    if (!target) return undefined;
    const wc = this.getTabWebContents(targetId, paneId || target.focusedPane);
    if (!wc) return undefined;
    return this.withTabAgentWorking(targetId, async () => {
      return wc.executeJavaScript(expression);
    });
  }

  private getTabsStoragePath(): string {
    const userData = app ? app.getPath('userData') : path.join(os.homedir(), '.antifan-browser');
    if (!fs.existsSync(userData)) {
      try { fs.mkdirSync(userData, { recursive: true }); } catch {}
    }
    return path.join(userData, 'saved-tabs.json');
  }

  private isDisposed = false;

  private schedulePersist(): void {
    if (this.isDisposed) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTabs();
    }, 400);
  }

  public persistTabs(): void {
    if (this.isDisposed) return;
    try {
      const filePath = this.getTabsStoragePath();
      const tabList = this.tabOrder.map((id) => {
        const tab = this.tabs.get(id);
        if (!tab) return null;
        return sanitizeTabForPersistence(tab.state);
      }).filter(Boolean);

      const openTerminalWindows: Array<{
        sessionId?: string;
        bounds: {
          x?: number;
          y?: number;
          width: number;
          height: number;
          isMaximized: boolean;
        };
        isPopout?: boolean;
      }> = [];

      for (const [winId, win] of this.terminalWindows.entries()) {
        if (win && !win.isDestroyed()) {
          let bounds = win.getBounds();
          if ('getNormalBounds' in win && typeof (win as any).getNormalBounds === 'function') {
            try {
              bounds = (win as any).getNormalBounds();
            } catch {}
          }
          const isMaximized = win.isMaximized();
          const meta = this.terminalWindowMeta.get(winId);
          openTerminalWindows.push({
            sessionId: meta?.sessionId || undefined,
            isPopout: win === this.popoutWindow,
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              isMaximized,
            },
          });
        }
      }

      const data = {
        activeTabId: this.activeTabId,
        tabs: tabList,
        bookmarks: this.bookmarks,
        activeChromeProfileId: ChromeProfileSyncManager.getInstance().activeProfileId,
        sidebarWidth: this.sidebarWidth,
        isSidebarOpen: this.isSidebarOpen,
        isTerminalPopoutOpen: Boolean(this.popoutWindow && !this.popoutWindow.isDestroyed()),
        wasSidebarOpenBeforePopout: this.wasSidebarOpenBeforePopout,
        popoutSessionId: this.popoutWindow && !this.popoutWindow.isDestroyed() ? TerminalManager.getInstance().getActiveSessionId() : undefined,
        terminalWindows: openTerminalWindows,
        updatedAt: Date.now(),
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      console.log('[native-tab-host] Persisted tabs to:', filePath);
    } catch (err) {
      console.warn('[native-tab-host] Failed to persist tabs:', err);
    }
  }

  public restoreTabs(fallbackUrl?: string): void {
    try {
      const filePath = this.getTabsStoragePath();
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data) {
          if (typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 260 && data.sidebarWidth <= 850) {
            this.sidebarWidth = data.sidebarWidth;
          }
          if (typeof data.isSidebarOpen === 'boolean') {
            this.isSidebarOpen = data.isSidebarOpen;
          }
          if (Array.isArray(data.terminalWindows) && data.terminalWindows.length > 0) {
            TerminalManager.getInstance().startTerminal();
            const wasOpen = typeof data.wasSidebarOpenBeforePopout === 'boolean' ? data.wasSidebarOpenBeforePopout : true;
            for (const tw of data.terminalWindows) {
              if (tw.isPopout) {
                this.togglePopoutTerminal(tw.sessionId, { wasSidebarOpenBeforePopout: wasOpen, bounds: tw.bounds });
              } else {
                this.openNewTerminalWindow(tw.sessionId, tw.bounds);
              }
            }
          } else if (data.isTerminalPopoutOpen) {
            TerminalManager.getInstance().startTerminal();
            const wasOpen = typeof data.wasSidebarOpenBeforePopout === 'boolean' ? data.wasSidebarOpenBeforePopout : true;
            this.togglePopoutTerminal(data.popoutSessionId, { wasSidebarOpenBeforePopout: wasOpen });
          }
          if (data.activeChromeProfileId) {
            ChromeProfileSyncManager.getInstance().activeProfileId = data.activeChromeProfileId;
            ChromeProfileSyncManager.getInstance().syncProfile(data.activeChromeProfileId).catch(() => {});
          }
          if (Array.isArray(data.bookmarks) && data.bookmarks.length > 0) {
            this.bookmarks = data.bookmarks;
          }
          if (Array.isArray(data.tabs) && data.tabs.length > 0) {
            let restoredActiveId = data.activeTabId;
            for (const rawTab of data.tabs) {
              const migrated = migratePersistedTab(rawTab);
              const safeUrl = cleanRestoredUrl(migrated.url || 'about:blank');
              const id = this.createTab(safeUrl, false);
              const tab = this.tabs.get(id);
              if (tab) {
                if (migrated.title) tab.state.title = migrated.title;
                if (migrated.devicePresetId) this.setDevicePreset(id, migrated.devicePresetId);
                if (typeof migrated.zoomFactor === 'number') tab.state.zoomFactor = migrated.zoomFactor;
                if (migrated.splitMode) {
                  this.toggleSplitReview(id, true);
                  if (migrated.splitDesktopPresetId) tab.state.splitDesktopPresetId = migrated.splitDesktopPresetId;
                  if (migrated.splitMobilePresetId) tab.state.splitMobilePresetId = migrated.splitMobilePresetId;
                }
                if (migrated.capsuleId && typeof migrated.capsuleId === 'string' && !tab.state.capsuleId) {
                  tab.state.capsuleId = migrated.capsuleId;
                  const targetCapsuleId = migrated.capsuleId;
                  const capsule = this.capsuleManager.list().find((c) => c.id.toLowerCase() === targetCapsuleId.toLowerCase());
                  if (capsule && fs.existsSync(capsule.workspacePath) && !this.tabPreviewUnsubscribers.has(id)) {
                    const unsub = this.previewWatcherPool.retain(capsule.id, capsule.workspacePath, (event) => {
                      this.dispatchScopedReload(capsule.id, event);
                    });
                    this.tabPreviewUnsubscribers.set(id, unsub);
                  }
                }
              }
              if (rawTab.id === data.activeTabId || migrated.id === data.activeTabId) {
                restoredActiveId = id;
              }
            }
            if (restoredActiveId && this.tabs.has(restoredActiveId)) {
              this.switchTab(restoredActiveId);
            } else if (this.tabOrder.length > 0) {
              this.switchTab(this.tabOrder[0]!);
            }
            this.updateLayout();
            return;
          }
        }
      }
    } catch (err) {
      console.warn('[native-tab-host] Failed to restore tabs:', err);
    }

    // Default fallback
    this.createTab(fallbackUrl || 'https://www.google.com');
  }

  private injectAutoJsonViewer(wc: Electron.WebContents): void {
    if (!wc || wc.isDestroyed()) return;
    const script = `
(function autoJsonView() {
  if (window.__masterJsonInjected) return;
  const raw = (document.body && document.body.innerText) || (document.body && document.body.textContent) || '';
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.length < 2) return;
  
  let parsed = null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { parsed = JSON.parse(trimmed); } catch {}
  }
  if (!parsed && /(?:=\\s*)?([{\[][\\s\\S]*[}\]])\\s*;?\\s*$/.test(trimmed)) {
    const m = trimmed.match(/(?:=\\s*)?([{\[][\\s\\S]*[}\]])\\s*;?\\s*$/);
    if (m) { try { parsed = JSON.parse(m[1]); } catch {} }
  }
  if (parsed === null || typeof parsed !== 'object') return;
  window.__masterJsonInjected = true;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  
  const renderValue = (v) => {
    if (v === null) return '<span class="jv-null">null</span>';
    if (typeof v === 'string') return '<span class="jv-str">"' + esc(v) + '"</span>';
    if (typeof v === 'number') return '<span class="jv-num">' + v + '</span>';
    if (typeof v === 'boolean') return '<span class="jv-bool">' + v + '</span>';
    return '';
  };
  
  const renderNode = (key, v, depth) => {
    const keyHtml = key === null ? '' : '<span class="jv-key">"' + esc(key) + '"</span><span class="jv-br">: </span>';
    if (Array.isArray(v)) {
      if (v.length === 0) return '<div class="jv-node">' + keyHtml + '<span class="jv-br">[</span><span class="jv-br">]</span></div>';
      const children = v.map((item) => renderNode(null, item, depth + 1)).join('');
      return '<div class="jv-node"><span class="jv-toggle">▾</span>' + keyHtml + '<span class="jv-br">[</span> <span class="jv-badge">' + v.length + ' items</span></div><div class="jv-children">' + children + '</div><div class="jv-close"><span class="jv-br">]</span></div>';
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v);
      if (entries.length === 0) return '<div class="jv-node">' + keyHtml + '<span class="jv-br">{</span><span class="jv-br">}</span></div>';
      const children = entries.map(([k, item]) => renderNode(k, item, depth + 1)).join('');
      return '<div class="jv-node"><span class="jv-toggle">▾</span>' + keyHtml + '<span class="jv-br">{</span> <span class="jv-badge">' + entries.length + ' keys</span></div><div class="jv-children">' + children + '</div><div class="jv-close"><span class="jv-br">}</span></div>';
    }
    return '<div class="jv-node">' + keyHtml + renderValue(v) + '</div>';
  };

  const style = document.createElement('style');
  style.textContent = [
    ':root { --jv-bg:#121216; --jv-panel:#1a1a22; --jv-border:#2a2a36; --jv-muted:#94a3b8; --jv-text:#f1f5f9; --jv-str:#86efac; --jv-num:#fdba74; --jv-bool:#93c5fd; --jv-null:#94a3b8; --jv-key:#c084fc; --jv-br:#64748b; }',
    '* { box-sizing: border-box; }',
    'body { margin: 0; padding: 0; background: var(--jv-bg) !important; color: var(--jv-text) !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '.jv-header { position: sticky; top: 0; z-index: 1000; display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; background: var(--jv-panel); border-bottom: 1px solid var(--jv-border); font-size: 12px; }',
    '.jv-header-left { display: flex; align-items: center; gap: 10px; }',
    '.jv-header-title { font-weight: 600; color: #38bdf8; display: flex; align-items: center; gap: 6px; }',
    '.jv-header-actions { display: flex; align-items: center; gap: 6px; }',
    '.jv-btn { background: #272732; color: #cbd5e1; border: 1px solid var(--jv-border); border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; transition: all 0.12s ease; }',
    '.jv-btn:hover { background: #0284c7; color: #ffffff; border-color: #0284c7; }',
    '.jv-tree { padding: 16px 20px; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; line-height: 1.6; white-space: normal; overflow-wrap: break-word; }',
    '.jv-node { padding: 1px 6px; border-radius: 4px; transition: background 0.1s ease; }',
    '.jv-node:hover { background: rgba(255, 255, 255, 0.05); }',
    '.jv-toggle { cursor: pointer; color: var(--jv-muted); user-select: none; display: inline-block; width: 16px; font-size: 11px; }',
    '.jv-toggle:hover { color: #ffffff; }',
    '.jv-key { color: var(--jv-key); font-weight: 500; }',
    '.jv-str { color: var(--jv-str); overflow-wrap: anywhere; }',
    '.jv-num { color: var(--jv-num); }',
    '.jv-bool { color: var(--jv-bool); font-weight: 600; }',
    '.jv-null { color: var(--jv-null); font-style: italic; opacity: 0.8; }',
    '.jv-br { color: var(--jv-br); }',
    '.jv-badge { font-size: 10px; color: #64748b; font-style: italic; margin-left: 6px; }',
    '.jv-children { padding-left: 20px; border-left: 1px solid rgba(100, 116, 139, 0.25); margin-left: 6px; }',
    '.jv-close { color: var(--jv-br); padding-left: 6px; }',
    '.jv-hidden { display: none; }',
    '.jv-raw-view { padding: 16px 20px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; display: none; }'
  ].join('\\n');
  document.head.appendChild(style);

  const rawJsonFormatted = JSON.stringify(parsed, null, 2);
  document.body.innerHTML = [
    '<div class="jv-header">',
    '  <div class="jv-header-left">',
    '    <span class="jv-header-title">⚡ Haravan JSON View</span>',
    '    <span style="color:#64748b;font-size:11px;">(Auto Unicode Decoded)</span>',
    '  </div>',
    '  <div class="jv-header-actions">',
    '    <button class="jv-btn" id="jvBtnCopy">📋 Copy JSON</button>',
    '    <button class="jv-btn" id="jvBtnExpand">⇲ Expand All</button>',
    '    <button class="jv-btn" id="jvBtnCollapse">⇱ Collapse All</button>',
    '    <button class="jv-btn" id="jvBtnToggleRaw">{} Raw View</button>',
    '  </div>',
    '</div>',
    '<div class="jv-tree" id="jvTree">' + renderNode(null, parsed, 0) + '</div>',
    '<div class="jv-raw-view" id="jvRaw">' + esc(rawJsonFormatted) + '</div>'
  ].join('');

  const tree = document.getElementById('jvTree');
  const rawView = document.getElementById('jvRaw');
  
  tree.addEventListener('click', (e) => {
    const t = e.target.closest('.jv-toggle');
    if (!t) return;
    const n = t.closest('.jv-node');
    if (!n) return;
    const c = n.nextElementSibling;
    if (!c || !c.classList.contains('jv-children')) return;
    const hidden = c.classList.toggle('jv-hidden');
    t.textContent = hidden ? '▸' : '▾';
  });

  document.getElementById('jvBtnCopy')?.addEventListener('click', () => {
    navigator.clipboard.writeText(rawJsonFormatted);
    const btn = document.getElementById('jvBtnCopy');
    if (btn) {
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = '📋 Copy JSON'; }, 1500);
    }
  });

  document.getElementById('jvBtnExpand')?.addEventListener('click', () => {
    tree.querySelectorAll('.jv-children').forEach(el => el.classList.remove('jv-hidden'));
    tree.querySelectorAll('.jv-toggle').forEach(el => el.textContent = '▾');
  });

  document.getElementById('jvBtnCollapse')?.addEventListener('click', () => {
    tree.querySelectorAll('.jv-children').forEach(el => el.classList.add('jv-hidden'));
    tree.querySelectorAll('.jv-toggle').forEach(el => el.textContent = '▸');
  });

  document.getElementById('jvBtnToggleRaw')?.addEventListener('click', () => {
    const isRaw = rawView.style.display === 'block';
    rawView.style.display = isRaw ? 'none' : 'block';
    tree.style.display = isRaw ? 'block' : 'none';
    const toggleBtn = document.getElementById('jvBtnToggleRaw');
    if (toggleBtn) {
      toggleBtn.textContent = isRaw ? '{} Raw View' : '🌲 Tree View';
    }
  });
})();
`;
    wc.executeJavaScript(script).catch(() => {});
  }
  public renderPageSourceSkeletonHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>View Source</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e6edf3; font-family: ui-monospace, "Cascadia Code", "Fira Code", Consolas, monospace; font-size: 13px; line-height: 1.5; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    .src-header { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; background: #161b22; border-bottom: 1px solid #30363d; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 12px; }
    .src-title-wrap { display: flex; align-items: center; gap: 10px; overflow: hidden; }
    .src-badge { background: #238636; color: #fff; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
    .src-url { color: #58a6ff; font-weight: 600; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 600px; }
    .src-url:hover { text-decoration: underline; }
    .src-meta { color: #8b949e; font-size: 11px; margin-left: 8px; }
    .src-actions { display: flex; align-items: center; gap: 8px; }
    .src-btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.15s ease; }
    .src-btn:hover { background: #30363d; color: #ffffff; border-color: #8b949e; }
    .src-container { flex: 1; overflow: auto; padding: 16px 20px; background: #0d1117; }
    .src-code-pre { margin: 0; font-family: inherit; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; tab-size: 2; color: #e6edf3; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #238636; color: #fff; padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 600; opacity: 0; transition: opacity 0.2s ease; pointer-events: none; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="src-header">
    <div class="src-title-wrap">
      <span class="src-badge">VIEW SOURCE</span>
      <a class="src-url" id="srcUrl" href="#" target="_blank">Loading source...</a>
      <span class="src-meta" id="srcMeta"></span>
    </div>
    <div class="src-actions">
      <button class="src-btn" id="btnCopy">📋 Copy All</button>
      <button class="src-btn" id="btnDownload">💾 Save HTML</button>
    </div>
  </div>
  <div class="src-container">
    <pre class="src-code-pre" id="srcCode">Loading page source...</pre>
  </div>
  <div class="toast" id="toast">Copied to clipboard!</div>
  <script>
    let rawStore = '';
    window.__antifanRenderSource = (url, content) => {
      rawStore = content || '';
      document.title = 'view-source:' + url;
      const urlEl = document.getElementById('srcUrl');
      if (urlEl) {
        urlEl.textContent = url;
        urlEl.href = url;
        urlEl.title = url;
      }

      const linesCount = rawStore.split('\\n').length;
      const sizeKb = (new Blob([rawStore]).size / 1024).toFixed(1);
      const metaEl = document.getElementById('srcMeta');
      if (metaEl) {
        metaEl.textContent = linesCount.toLocaleString() + ' lines · ' + sizeKb + ' KB';
      }

      const codeEl = document.getElementById('srcCode');
      if (codeEl) {
        codeEl.textContent = rawStore;
      }
    };

    document.getElementById('btnCopy').onclick = () => {
      navigator.clipboard.writeText(rawStore).then(() => {
        const t = document.getElementById('toast');
        if (t) {
          t.classList.add('show');
          setTimeout(() => t.classList.remove('show'), 2000);
        }
      });
    };
    document.getElementById('btnDownload').onclick = () => {
      const blob = new Blob([rawStore], { type: 'text/html;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'page-source.html';
      a.click();
    };
  </script>
</body>
</html>`;
  }

  public async fetchAndLoadPageSource(
    wc: Electron.WebContents,
    targetUrl: string,
    tabState?: AntiFanTab,
    preloadedHtml?: string
  ): Promise<void> {
    let rawHtml = preloadedHtml || '';

    if (!rawHtml) {
      for (const t of this.tabs.values()) {
        if (t.state.url === targetUrl && !t.view.webContents.isDestroyed()) {
          try {
            rawHtml = await t.view.webContents.executeJavaScript(
              'document.documentElement.outerHTML || document.body.outerHTML',
              true
            );
            if (rawHtml) break;
          } catch {}
        }
      }
    }

    if (!rawHtml && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const res = await net.fetch(targetUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        rawHtml = await res.text();
      } catch (err) {
        rawHtml = `<!-- Failed to fetch page source: ${String(err)} -->`;
      }
    }

    if (!rawHtml) {
      rawHtml = '<!-- No source HTML available for this URL -->';
    }

    if (tabState) {
      tabState.isLoading = false;
      tabState.title = `view-source:${targetUrl}`;
      this.broadcastState();
    }

    const skeletonHtml = this.renderPageSourceSkeletonHtml();
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(skeletonHtml);

    try {
      if (!wc.isDestroyed()) {
        await wc.loadURL(dataUrl);
        if (!wc.isDestroyed()) {
          await wc.executeJavaScript(
            `if (typeof window.__antifanRenderSource === 'function') { window.__antifanRenderSource(${JSON.stringify(targetUrl)}, ${JSON.stringify(rawHtml)}); }`
          );
        }
      }
    } catch (err) {
      console.error('[native-tab-host] Failed to load source viewer:', err);
    }
  }

  public async viewPageSource(tabId?: string): Promise<string> {
    const targetId = tabId || this.activeTabId;
    const targetTab = this.tabs.get(targetId);
    if (!targetTab) return '';

    const sourceUrl = targetTab.state.url || 'https://www.google.com';
    let initialHtml = '';
    if (!targetTab.view.webContents.isDestroyed()) {
      try {
        initialHtml = await targetTab.view.webContents.executeJavaScript(
          'document.documentElement.outerHTML || document.body.outerHTML',
          true
        );
      } catch {}
    }

    const newTabId = this.createTab(`view-source:${sourceUrl}`);
    if (newTabId && initialHtml) {
      const newTab = this.tabs.get(newTabId);
      if (newTab && !newTab.view.webContents.isDestroyed()) {
        this.fetchAndLoadPageSource(newTab.view.webContents, sourceUrl, newTab.state, initialHtml);
      }
    }
    return newTabId;
  }

  public broadcastState(): void {
    const payload = {
      tabs: this.getTabList(),
      activeTabId: this.activeTabId,
      isInspecting: this.isInspecting,
      isFontFinderActive: this.isFontFinderActive,
      isLensActive: this.isLensActive,
      isRulerActive: this.isRulerActive,
      isSidebarOpen: this.isSidebarOpen,
      isTerminalOpen: this.isTerminalOpen,
      bookmarks: this.bookmarks,
      devicePresets: DEVICE_PRESETS,
      activeChromeProfile: ChromeProfileSyncManager.getInstance().getActiveProfile(),
      chromeProfiles: ChromeProfileSyncManager.getInstance().getAvailableProfiles(),
      themeQa: this.themeQaState,
    };
    this.emit('tabs-changed', payload.tabs, payload.activeTabId);
    safeSendWebContents(this.toolbarView?.webContents, TOOLBAR_CHANNELS.STATE_UPDATED, payload);
    this.schedulePersist();
  }

  public setControlPlane(cp: ControlPlaneRuntime): void {
    this.controlPlane = cp;
  }
  private async runThemeQa(options?: { workspaceRoot?: string }): Promise<{ ok: boolean; report?: unknown; error?: string }> {
    if (!this.controlPlane) {
      const error = 'Control plane runtime is not initialized';
      this.themeQaState = { status: 'error', issueCount: 0, error, updatedAt: Date.now() };
      this.broadcastState();
      return { ok: false, error };
    }
    const tab = this.tabs.get(this.activeTabId);
    const target = this.getAutomationTarget() || (() => {
      if (!tab) return undefined;
      const lease = this.controlPlane!.getLease();
      return { projectId: lease.projectId, workspaceId: lease.workspaceId || '', runtimeId: lease.runtimeId, tabId: this.activeTabId, browserEpoch: lease.hostEpoch, documentGeneration: this.getDocumentGeneration(this.activeTabId), url: tab.state.url };
    })();
    if (!target) {
      const error = 'No active browser tab for Theme QA validation';
      this.themeQaState = { status: 'error', issueCount: 0, error, updatedAt: Date.now() };
      this.broadcastState();
      return { ok: false, error };
    }
    const workspaceRoot = options?.workspaceRoot || this.capsuleManager.getActive()?.workspacePath || this.controlPlane.getWorkspaceRoot();
    this.themeQaState = { status: 'running', issueCount: 0, updatedAt: Date.now() };
    this.broadcastState();
    try {
      const report = await this.controlPlane.validateThemeQa(target, { workspaceRoot });
      const summary = report.summary;
      const findings = report.findings;
      const issueCount = typeof summary?.criticalCount === 'number'
        ? summary.criticalCount
        : (findings ? (
            (findings.liquid?.errors?.length || 0) +
            (findings.overflow?.culprits?.length || 0) +
            (findings.assets?.brokenAssets?.length || 0) +
            (findings.hsRules?.totalViolations || 0) +
            (findings.diagnosticIssues?.length || 0)
          ) : 0);
      const isPassed = typeof summary?.passed === 'boolean' ? summary.passed : issueCount === 0;
      const status: 'pass' | 'fail' = isPassed ? 'pass' : 'fail';
      const reportArtifactId = report.artifacts?.find((item: { kind?: string; id?: string }) => item.kind === 'report')?.id;
      this.themeQaState = { status, issueCount, reportArtifactId, report, updatedAt: Date.now() };
      this.broadcastState();
      return { ok: true, report };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.themeQaState = { status: 'error', issueCount: 0, error: message, updatedAt: Date.now() };
      this.broadcastState();
      return { ok: false, error: message };
    }
  }
  public getBrowserEpoch(): number {
    return this.browserEpoch;
  }

  public setBrowserEpoch(epoch: number): void {
    this.browserEpoch = epoch;
  }


  public getDiagnostics(tabId?: string, level?: number | string): { console: any[]; failures: any[] } {
    const targetId = tabId || this.activeTabId;
    return this.diagnosticsManager.getDiagnostics(targetId, level);
  }

  public async runResponsiveCheck(tabId?: string): Promise<Record<string, unknown>> {
    const targetId = tabId || this.activeTabId;
    const tab = this.tabs.get(targetId);
    if (!tab || tab.view.webContents.isDestroyed()) return { ok: false, error: 'Tab not found or destroyed' };

    const wc = tab.view.webContents;
    const previousPreset = tab.state.devicePresetId;
    const testBreakpoints = [
      { id: 'mobile-iphone15', name: 'Mobile iPhone 15', width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
      { id: 'tablet-ipad-air', name: 'Tablet iPad Air', width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
      { id: 'desktop-laptop', name: 'Desktop Laptop 14"', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    ];

    const results: Record<string, unknown> = {};

    try {
      for (const bp of testBreakpoints) {
        this.safeEnableDeviceEmulation(wc, {
          screenPosition: bp.mobile ? 'mobile' : 'desktop',
          screenSize: { width: bp.width, height: bp.height },
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: bp.deviceScaleFactor,
          viewSize: { width: bp.width, height: bp.height },
          scale: 1,
        });

        await new Promise((resolve) => setTimeout(resolve, 60));

        const evalPromise = wc.executeJavaScript(`(() => {
          const docEl = document.documentElement;
          const body = document.body;
          const scrollW = Math.max(docEl ? docEl.scrollWidth : 0, body ? body.scrollWidth : 0);
          const clientW = docEl ? docEl.clientWidth : window.innerWidth;
          const scrollH = Math.max(docEl ? docEl.scrollHeight : 0, body ? body.scrollHeight : 0);
          const clientH = docEl ? docEl.clientHeight : window.innerHeight;
          const hasHorizontalOverflow = scrollW > clientW + 1;
          const viewportMeta = document.querySelector('meta[name="viewport"]');
          return {
            scrollWidth: scrollW,
            clientWidth: clientW,
            scrollHeight: scrollH,
            clientHeight: clientH,
            hasHorizontalOverflow,
            hasViewportMeta: Boolean(viewportMeta),
            viewportContent: viewportMeta ? viewportMeta.getAttribute('content') : null,
          };
        })()`).catch((err: unknown) => ({ error: String(err) }));

        const timeoutPromise = new Promise<{ timeout: boolean }>((resolve) => setTimeout(() => resolve({ timeout: true }), 1500));
        const evaluation = await Promise.race([evalPromise, timeoutPromise]);

        results[bp.id] = {
          name: bp.name,
          width: bp.width,
          height: bp.height,
          mobile: bp.mobile,
          ...evaluation,
        };
      }
    } finally {
      try {
        this.safeDisableDeviceEmulation(wc);
        if (previousPreset && previousPreset !== 'responsive') {
          this.setDevicePreset(targetId, previousPreset);
        } else {
          this.updateLayout();
        }
      } catch {}
    }

    return {
      ok: true,
      tabId: targetId,
      url: tab.state.url,
      timestamp: Date.now(),
      breakpoints: results,
    };
  }

  public async agentTrajectory(params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string }): Promise<Record<string, unknown>> {
    const targetId = params?.tabId || this.automationTabId || this.activeTabId;
    const steps = Array.isArray(params?.steps) ? params.steps : null;
    if (!steps) {
      return { success: false, executedSteps: 0, totalSteps: 0, reason: 'Missing or invalid steps array' };
    }
    const tab = this.tabs.get(targetId);
    const totalSteps = steps.length;
    if (!tab || tab.view.webContents.isDestroyed()) {
      return { success: false, executedSteps: 0, totalSteps, reason: 'Target tab is unavailable' };
    }
    return this.withTabAgentWorking(targetId, async () => {
      if (!await this.ensureAgentBrowserInjected(targetId)) {
        return { success: false, executedSteps: 0, totalSteps, reason: 'Agent browser injection failed' };
      }
      const generationBefore = this.getDocumentGeneration(targetId);
      const urlBefore = tab.view.webContents.getURL();
      let normalizedSteps: Array<Record<string, unknown>>;
      try {
        normalizedSteps = steps.map((step, index) => {
          if (!step || typeof step !== 'object') throw new Error(`Trajectory step ${index} must be an object`);
          const candidate = step as Record<string, unknown>;
          const action = candidate.action || candidate.type;
          if (action !== 'move' && action !== 'hover' && action !== 'click' && action !== 'type' && action !== 'scroll') {
            throw new Error(`Unsupported trajectory action at step ${index}: ${String(action || 'missing')}`);
          }
          return { ...candidate, action };
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Invalid trajectory steps';
        return { success: false, executedSteps: 0, totalSteps, reason };
      }
      try {
        const result = await tab.view.webContents.executeJavaScript(`window.__antifanAgentTrajectory(${JSON.stringify(normalizedSteps)}, ${JSON.stringify({ speed: params?.speed, smoothScroll: params?.smoothScroll })})`);
        const generationChanged = this.getDocumentGeneration(targetId) !== generationBefore;
        const urlChanged = tab.view.webContents.isDestroyed() || tab.view.webContents.getURL() !== urlBefore;
        const obj = result && typeof result === 'object' ? result as Record<string, unknown> : null;
        const rawExecuted = obj?.executedSteps;
        const rawTotal = obj?.totalSteps;
        const hasValidExecuted = typeof rawExecuted === 'number' && Number.isInteger(rawExecuted) && rawExecuted >= 0 && rawExecuted <= totalSteps;
        const hasValidTotal = typeof rawTotal === 'number' && Number.isInteger(rawTotal) && rawTotal === totalSteps;
        const executedSteps = hasValidExecuted ? rawExecuted as number : 0;
        const invalidResult = !obj || typeof obj.success !== 'boolean' || !hasValidExecuted || !hasValidTotal;
        const countsMatch = hasValidExecuted && hasValidTotal && executedSteps === totalSteps;
        const interrupted = generationChanged || urlChanged;
        const reason = interrupted
          ? (typeof obj?.reason === 'string' ? obj.reason : 'Interrupted by navigation or document change')
          : invalidResult
            ? 'Trajectory returned an invalid result'
            : !countsMatch
              ? (typeof obj?.reason === 'string' ? obj.reason : 'Trajectory did not complete all steps')
              : (typeof obj?.reason === 'string' ? obj.reason : undefined);
        return {
          ...(obj || {}),
          success: !interrupted && !invalidResult && countsMatch && obj?.success === true,
          executedSteps,
          totalSteps,
          ...(reason ? { reason } : {}),
        };
      } catch (err) {
        console.error('[native-tab-host] agentTrajectory error:', err);
        return { success: false, executedSteps: 0, totalSteps, reason: 'Trajectory execution failed' };
      }
    });
  }

  public async agentMove(args: { selector?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    return this.agentHover(args);
  }

  public async agentSnapshot(tabId?: string, paneId?: SplitPaneId): Promise<string> {
    const targetId = tabId || this.automationTabId || this.activeTabId;
    return this.getDom(undefined, targetId, paneId);
  }

  public async sendKeyboardPress(params: { key: string; modifiers?: string[]; tabId?: string }): Promise<{ success: boolean; key: string; modifiers: string[] }> {
    const targetId = params.tabId || this.automationTabId || this.activeTabId;
    const tab = this.tabs.get(targetId);
    if (!tab || tab.view.webContents.isDestroyed()) {
      return { success: false, key: params.key, modifiers: params.modifiers || [] };
    }
    return this.withTabAgentWorking(targetId, async () => {
      const events = buildKeyboardInputEvents(params.key, params.modifiers);
      for (const evt of events) {
        tab.view.webContents.sendInputEvent(evt);
      }
      return { success: true, key: params.key, modifiers: params.modifiers || [] };
    });
  }

  public setViewportSize(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string }): boolean {
    const targetId = options.tabId || this.activeTabId;
    const tab = this.tabs.get(targetId);
    if (!tab) return false;
    tab.state.devicePresetId = `${options.width}x${options.height}`;
    this.updateLayout();
    return true;
  }

  public getDevicePresets(): DevicePreset[] {
    return DEVICE_PRESETS;
  }

  public isCurrentTarget(target: BrowserTarget): boolean {
    if (!target || typeof target.tabId !== 'string' || !this.tabs.has(target.tabId)) return false;

    const currentGen = this.getDocumentGeneration(target.tabId);
    if (typeof target.documentGeneration !== 'number' || target.documentGeneration !== currentGen) return false;

    if (!this.controlPlane) return false;

    const lease = this.controlPlane.getLease();
    if (typeof target.browserEpoch !== 'number' || target.browserEpoch !== lease.hostEpoch) return false;
    if (typeof target.projectId !== 'string' || target.projectId !== lease.projectId) return false;
    if (typeof target.workspaceId !== 'string' || (lease.workspaceId && target.workspaceId !== lease.workspaceId)) return false;
    if (typeof target.runtimeId !== 'string' || target.runtimeId !== lease.runtimeId) return false;

    return true;
  }

  public getDocumentGeneration(tabId?: string): number {
    const id = tabId || this.activeTabId;
    return this.documentGenerations.get(id) || 1;
  }

  public toggleFullScreen(): void {
    this.window.setFullScreen(!this.window.isFullScreen());
  }

  public reloadWindow(): void {
    this.persistTabs();
    TerminalManager.getInstance().persistSync();
    if (this.toolbarView && !this.toolbarView.webContents.isDestroyed()) {
      this.toolbarView.webContents.reload();
    }
    if (this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
      this.sidebarView.webContents.reload();
    }
    if (this.terminalView && !this.terminalView.webContents.isDestroyed()) {
      this.terminalView.webContents.reload();
    }
  }

  public createPreviewTab(rawPathOrUri: string, targetCapsuleId?: string): string | null {
    try {
      let cleanPath = rawPathOrUri.trim();
      if (cleanPath.startsWith('file:///')) {
        cleanPath = decodeURIComponent(cleanPath.slice(8));
        if (/^\/[a-zA-Z]:/.test(cleanPath)) {
          cleanPath = cleanPath.slice(1);
        }
      } else if (cleanPath.startsWith('file://')) {
        cleanPath = decodeURIComponent(cleanPath.slice(7));
      }

      const allCapsules = this.capsuleManager.list();
      let matchedCapsule: WorkspaceCapsule | null = null;
      let relativePath = '';

      if (targetCapsuleId) {
        matchedCapsule = allCapsules.find((c) => c.id.toLowerCase() === targetCapsuleId.toLowerCase()) || null;
      }

      if (!matchedCapsule) {
        const resolvedAbsolute = path.resolve(cleanPath);
        for (const cap of allCapsules) {
          if (cap.workspacePath && fs.existsSync(cap.workspacePath)) {
            const capRoot = fs.realpathSync.native(path.resolve(cap.workspacePath));
            const rel = path.relative(capRoot, resolvedAbsolute);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
              matchedCapsule = cap;
              relativePath = rel;
              break;
            }
          }
        }
      }

      if (!matchedCapsule) {
        matchedCapsule = this.ensureActiveCapsule();
        const capRoot = fs.realpathSync.native(path.resolve(matchedCapsule.workspacePath));
        if (path.isAbsolute(cleanPath)) {
          const rel = path.relative(capRoot, path.resolve(cleanPath));
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            relativePath = rel;
          } else {
            relativePath = path.basename(cleanPath);
          }
        } else {
          relativePath = cleanPath;
        }
      } else if (!relativePath) {
        const capRoot = fs.realpathSync.native(path.resolve(matchedCapsule.workspacePath));
        relativePath = path.relative(capRoot, path.resolve(cleanPath));
      }

      const previewUrl = buildPreviewUrl(matchedCapsule.id, relativePath);
      const tabId = this.createTab(previewUrl);
      if (tabId) {
        const tab = this.tabs.get(tabId);
        if (tab) {
          tab.state.title = `Preview: ${path.basename(relativePath) || 'Workspace'}`;
          this.broadcastState();
        }
      }
      return tabId;
    } catch (err) {
      console.warn('[native-tab-host] Failed to create preview tab:', err);
      return null;
    }
  }

  private ensureActiveCapsule(): WorkspaceCapsule {
    const active = this.capsuleManager.getActive();
    if (active) return active;
    const all = this.capsuleManager.list();
    if (all.length > 0) {
      this.capsuleManager.switchTo(all[0]!.id);
      return all[0]!;
    }
    return this.capsuleManager.create('Default Workspace', process.cwd(), {
      sidebarOpen: this.isSidebarOpen,
      sidebarWidth: this.sidebarWidth,
    });
  }

  private dispatchScopedReload(capsuleId: string, event: PreviewChangeEvent): void {
    const targetKey = capsuleId.toLowerCase();
    for (const tab of this.tabs.values()) {
      if (tab.state.capsuleId?.toLowerCase() === targetKey && !tab.view.webContents.isDestroyed()) {
        if (event.type === 'css-swap') {
          tab.view.webContents.executeJavaScript(`(() => {
            document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
              const url = new URL(link.href);
              url.searchParams.set('antifan_ts', Date.now().toString());
              link.href = url.toString();
            });
          })()`).catch(() => {});
        } else {
          if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.reload();
          }
          if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
            tab.mobileView.webContents.reload();
          }
        }
      }
    }
  }
  public togglePopoutTerminal(sessionId?: string, options?: { wasSidebarOpenBeforePopout?: boolean; bounds?: Partial<WindowState> }): boolean {
    if (this.popoutWindow && !this.popoutWindow.isDestroyed()) {
      this.popoutWindow.close();
      this.popoutWindow = null;
      this.broadcastPopoutState(false);
      if (this.wasSidebarOpenBeforePopout && !this.isSidebarOpen) {
        this.toggleSidebar();
      }
      this.wasSidebarOpenBeforePopout = false;
      this.schedulePersist();
      return false;
    }

    const bounds = WindowStateManager.validateBounds(options?.bounds || this.terminalWindowStateManager.getState(), 900, 600);
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width || 900,
      height: bounds.height || 600,
      minWidth: 500,
      minHeight: 350,
      backgroundColor: '#060a11',
      title: 'AntiFan Terminal Workbench',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'standalone-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });

    const showPopoutWin = () => {
      if (!win.isDestroyed() && !win.isVisible()) {
        if (bounds.isMaximized) {
          win.maximize();
        }
        win.show();
      }
    };
    win.once('ready-to-show', showPopoutWin);
    setTimeout(showPopoutWin, 300);
    this.terminalWindowStateManager.manage(win);
    this.popoutWindow = win;
    this.terminalWindows.set(win.id, win);
    const activeSessionId = sessionId || TerminalManager.getInstance().getActiveSessionId();
    this.terminalWindowMeta.set(win.id, { sessionId: activeSessionId, isPopout: true });

    const onWindowChange = () => {
      this.schedulePersist();
    };
    win.on('resize', onWindowChange);
    win.on('move', onWindowChange);
    win.on('maximize', onWindowChange);
    win.on('unmaximize', onWindowChange);

    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') {
        event.preventDefault();
        win.setFullScreen(!win.isFullScreen());
      }
    });
    let standaloneHtml = path.join(__dirname, '..', '..', 'renderer', 'standalone.html');
    if (!fs.existsSync(standaloneHtml)) {
      standaloneHtml = path.join(process.cwd(), 'src', 'renderer', 'standalone.html');
    }

    win.webContents.on('did-finish-load', () => {
      const tm = TerminalManager.getInstance();
      const activeId = sessionId || tm.getActiveSessionId();
      const s = tm.getSession(activeId);
      const activeSession = tm.listSessions().find(x => x.id === activeId);
      safeSendWebContents(win.webContents, 'antifan:terminal:session', {
        activeSessionId: activeId,
        sessions: tm.listSessions(),
        splitSessionId: activeSession?.splitSessionId,
        snapshot: s?.buffer || '',
      });
    });

    win.loadFile(standaloneHtml, { query: { mode: 'popout', ...(sessionId ? { sessionId } : {}) } });
    if (options && typeof options.wasSidebarOpenBeforePopout === 'boolean') {
      this.wasSidebarOpenBeforePopout = options.wasSidebarOpenBeforePopout;
    } else {
      this.wasSidebarOpenBeforePopout = this.isSidebarOpen;
    }
    if (this.isSidebarOpen) {
      this.toggleSidebar();
    }
    win.on('closed', () => {
      this.terminalWindows.delete(win.id);
      this.terminalWindowMeta.delete(win.id);
      if (this.popoutWindow === win) {
        this.popoutWindow = null;
        this.broadcastPopoutState(false);
        if (this.wasSidebarOpenBeforePopout && !this.isSidebarOpen) {
          this.toggleSidebar();
        }
        this.wasSidebarOpenBeforePopout = false;
      }
      this.schedulePersist();
    });
    this.broadcastPopoutState(true);
    this.schedulePersist();
    return true;
  }

  public openNewTerminalWindow(sessionId?: string, customBounds?: Partial<WindowState>): boolean {
    const baseBounds = customBounds ? WindowStateManager.validateBounds(customBounds, 900, 600) : this.terminalWindowStateManager.getValidBounds();
    const count = this.terminalWindows.size;
    const offsetX = (!customBounds && count > 0 && typeof baseBounds.x === 'number') ? baseBounds.x + (count * 25) : baseBounds.x;
    const offsetY = (!customBounds && count > 0 && typeof baseBounds.y === 'number') ? baseBounds.y + (count * 25) : baseBounds.y;

    const win = new BrowserWindow({
      x: offsetX,
      y: offsetY,
      width: baseBounds.width || 900,
      height: baseBounds.height || 600,
      minWidth: 500,
      minHeight: 350,
      backgroundColor: '#060a11',
      title: 'AntiFan Terminal Workbench',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'standalone-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });

    const showNewTermWin = () => {
      if (!win.isDestroyed() && !win.isVisible()) {
        if (baseBounds.isMaximized) {
          win.maximize();
        }
        win.show();
      }
    };
    win.once('ready-to-show', showNewTermWin);
    setTimeout(showNewTermWin, 300);

    this.terminalWindows.set(win.id, win);
    const activeSessionId = sessionId || TerminalManager.getInstance().getActiveSessionId();
    this.terminalWindowMeta.set(win.id, { sessionId: activeSessionId, isPopout: false });

    const onWindowChange = () => {
      this.schedulePersist();
    };
    win.on('resize', onWindowChange);
    win.on('move', onWindowChange);
    win.on('maximize', onWindowChange);
    win.on('unmaximize', onWindowChange);

    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') {
        event.preventDefault();
        win.setFullScreen(!win.isFullScreen());
      }
    });
    let standaloneHtml = path.join(__dirname, '..', '..', 'renderer', 'standalone.html');
    if (!fs.existsSync(standaloneHtml)) {
      standaloneHtml = path.join(process.cwd(), 'src', 'renderer', 'standalone.html');
    }

    win.webContents.on('did-finish-load', () => {
      const tm = TerminalManager.getInstance();
      const activeId = sessionId || tm.getActiveSessionId();
      const s = tm.getSession(activeId);
      const activeSession = tm.listSessions().find(x => x.id === activeId);
      safeSendWebContents(win.webContents, 'antifan:terminal:session', {
        activeSessionId: activeId,
        sessions: tm.listSessions(),
        splitSessionId: activeSession?.splitSessionId,
        snapshot: s?.buffer || '',
      });
    });

    win.loadFile(standaloneHtml, { query: { mode: 'popout', ...(sessionId ? { sessionId } : {}) } });

    win.on('closed', () => {
      this.terminalWindows.delete(win.id);
      this.terminalWindowMeta.delete(win.id);
      this.schedulePersist();
    });
    this.schedulePersist();
    return true;
  }

  private broadcastPopoutState(isPopout: boolean): void {
    safeSendWebContents(this.sidebarView?.webContents, 'antifan:terminal:popout-state-changed', isPopout);
    for (const [, win] of this.terminalWindows) {
      safeSendWebContents(win?.webContents, 'antifan:terminal:popout-state-changed', isPopout);
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.persistTabs();
    this.isDisposed = true;
    if (this.frameBackdropView) {
      try {
        this.window.contentView.removeChildView(this.frameBackdropView);
      } catch {}
      try {
        if (!this.frameBackdropView.webContents.isDestroyed()) {
          (this.frameBackdropView.webContents as any).destroy?.();
        }
      } catch {}
      this.frameBackdropView = null;
    }
    if (this.inspectPollTimer) {
      clearInterval(this.inspectPollTimer);
      this.inspectPollTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    for (const timer of this.agentWorkingTimers.values()) clearTimeout(timer);
    this.agentWorkingTimers.clear();
    this.agentWorkingRefs.clear();
    for (const [, win] of this.terminalWindows) {
      if (win && !win.isDestroyed()) {
        try { win.close(); } catch {}
      }
    }
    this.terminalWindows.clear();
    this.popoutWindow = null;
    for (const unsub of this.tabPreviewUnsubscribers.values()) {
      try { unsub(); } catch {}
    }
    this.tabPreviewUnsubscribers.clear();
    const tabsToClean = [...this.tabs.entries()];
    this.tabs.clear();
    this.tabOrder = [];
    for (const [id, tab] of tabsToClean) {
      try {
        if (!tab.view.webContents.isDestroyed()) {
          tab.view.webContents.stop();
        }
      } catch {}
      try {
        this.window.contentView.removeChildView(tab.view);
      } catch {}
      if (tab.mobileView) {
        try {
          if (!tab.mobileView.webContents.isDestroyed()) {
            tab.mobileView.webContents.stop();
          }
        } catch {}
        try {
          this.window.contentView.removeChildView(tab.mobileView);
        } catch {}
      }
      this.splitCoordinator.cleanupTab(id);
    }
  }
}
