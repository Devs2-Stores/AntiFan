/**
 * AntiFan Browser Desktop — Full Native Tab Host & AI Sidebar (Chromium Engine)
 * Features: 100% parity with Antigravity Desktop architecture:
 * Multi-tab, Docked DevTools, GPU Lens, Font Finder, Device Emulation, Bookmarks,
 * AI Chat Sidebar (WebSocket Relay with Antigravity IDE), Global Shortcuts, and Context Menu.
 */
import { app, BrowserWindow, WebContentsView, Menu, MenuItem, clipboard, Rectangle, ipcMain, shell, dialog, net, session } from 'electron';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { StorageLocations } from '../config/storage-locations';
import { AntiFanTab, SplitPaneId, AntiFanPickedElement, TOOLBAR_CHANNELS, SIDEBAR_CHANNELS, TERMINAL_CHANNELS, FRAME_BACKDROP_CHANNELS } from '../../shared/contracts';
import { getSecureWebPreferences, sanitizeUrl, isAllowedNavigation, cleanRestoredUrl, isInternalWidgetOrSubframeUrl } from '../security/security-policy';
import { ELEMENT_PICKER_SCRIPT } from './element-picker';
import { resolveWorkspaceFromUrl, DEFAULT_WORKSPACE_ROOTS } from './workspace-resolver';
import { FONT_FINDER_SCRIPT } from './font-finder';
import { GPU_LENS_SCRIPT } from './gpu-lens';
import { RULER_SCRIPT } from './ruler';
import {
  DEVICE_PRESETS,
  DevicePreset,
  getPresetUserAgent,
  getPresetCornerRadius,
  IPHONE_USER_AGENT,
  MAC_DESKTOP_USER_AGENT,
} from './device-presets';
import { chromeSessionUserAgent } from './google-auth-identity';
import { configureBrowserSessionPartition, deriveCapsulePartition, unconfigureBrowserSessionPartition, type BrowserSessionUserAgentMode } from './browser-session-partition';
import { TabDiagnosticsManager, computeOrigin } from './tab-diagnostics';
import { buildKeyboardInputEvents } from './keyboard-normalizer';
import { FirstPartyNetworkTracker } from './first-party-network-tracker';
import { WorkspaceCapsuleManager, type WorkspaceCapsule } from '../project/workspace-capsule';
import { PreviewWatcherPool, type PreviewChangeEvent } from '../server/preview-watcher-pool';
import { buildPreviewUrl, parsePreviewUrl } from '../server/preview-url-codec';
import type { ControlPlaneRuntime } from '../control-plane/control-plane-runtime';
import type { BrowserTarget } from '../../shared/control-plane-contracts';
import type { WorkflowDefinition } from '../workflow/workflow-schema';
import { ChromeProfileSyncManager } from './chrome-profile-sync';
import { LocalSessionVault } from './local-session-vault';
import { HaravanUploader } from './haravan-uploader';
import type { ActionSequenceParams, ActionSequenceResult } from './tab-automation-host';
import { TerminalManager } from './terminal-manager';
import { checkForUpdatesAndRestart } from './app-menu';
import { SkillScanner } from './skill-scanner';
import { WindowStateManager, WindowState } from './window-state';
import { BridgeServer } from '../bridge/bridge-server';
import { ViewportGate } from '../tools/browser-control-port';

import { HistoryManager } from './history-manager';
import { OAuthPopupManager } from './oauth-popup-manager';
import { SemanticRefRegistry, makeTargetKey } from './semantic-ref-registry';
import { TabAutomationHost } from './tab-automation-host';
import { TabDevToolsHost } from './tab-devtools-host';
import {
  buildIsolatedExecutorScript,
  buildIsolatedCollectorScript,
  ISOLATED_AGENT_WORLD_ID,
  validateActionResponse,
} from './semantic-ref-executor';
import type { SemanticElementDescriptor } from './semantic-ref-types';
import { generateCollectionNonce, validateCollectionEnvelope } from './semantic-ref-types';
import { CapabilityError } from '../../shared/control-plane-contracts';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
import { AsyncThemeQaQueue } from '../qa/async-qa-job-queue';
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
  private popoutWindow: BrowserWindow | null = null;
  private terminalWindows: Map<number, BrowserWindow> = new Map();
  private terminalWindowMeta: Map<number, { sessionId?: string; isPopout?: boolean }> = new Map();
  private terminalWindowStateManager: WindowStateManager;
  private isSidebarOpen: boolean = true;
  private wasSidebarOpenBeforePopout: boolean = false;
  private isBookmarkBarVisible: boolean = false;
  private sidebarWidth: number = 380;
  private isToolbarOverlayActive: boolean = false;
  private toolbarOverlayCustomHeight?: number;
  private readonly splitCoordinator = new SplitNavigationCoordinator();
  private defaultUserAgent: string = chromeSessionUserAgent();
  private tabs: Map<string, NativeTabRecord> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string = '';

  public bookmarks: BookmarkItem[] = [];
  private readonly diagnosticsManager = new TabDiagnosticsManager();
  private readonly networkTracker = new FirstPartyNetworkTracker();
  private readonly previewWatcherPool = new PreviewWatcherPool();
  private readonly capsuleManager: WorkspaceCapsuleManager;
  private controlPlane: ControlPlaneRuntime | null = null;
  private activeWorkflowAbortController: AbortController | null = null;
  private documentGenerations: Map<string, number> = new Map();
  private browserEpoch: number = 1;
  private tabPreviewUnsubscribers: Map<string, () => void> = new Map();
  private recentlyClosedTabs: Array<{ url: string; title: string }> = [];
  private automationTabId: string | null = null;
  private terminalAgentAffinity = new Map<string, {
    tabId: string;
    primaryTabId: string;
    managedTabIds: Set<string>;
    lineage?: Map<string, {
      tabId: string;
      parentTabId?: string;
      source: 'agent_spawned' | 'native_window_open' | 'user_attached';
      createdAt: number;
    }>;
    lastUrls?: Map<string, string>;
    lastUrl?: string;
    closedAt?: number;
  }>();
  private readonly sessionTabPools = new Map<string, Set<string>>();
  private tabThemeQaStates = new Map<string, { status: 'idle' | 'running' | 'pass' | 'fail' | 'error'; issueCount: number; reportArtifactId?: string; report?: unknown; error?: string; updatedAt: number }>();
  private asyncQaQueue = new AsyncThemeQaQueue();
  public readonly semanticRefRegistry = new SemanticRefRegistry();
  private semanticDocumentGenerations = new Map<string, number>();
  private targetOperationQueues = new Map<string, Promise<void>>();
  public agentInputInFlight = 0;
  private viewportGate: ViewportGate | null = null;

  public setViewportGate(gate: ViewportGate): void {
    this.viewportGate = gate;
  }

  public syncWithAgentInput<T>(action: () => T): T {
    this.agentInputInFlight++;
    try {
      return action();
    } finally {
      this.agentInputInFlight = Math.max(0, this.agentInputInFlight - 1);
    }
  }

  public get isInspecting(): boolean {
    return this.devToolsHost ? this.devToolsHost.getIsInspecting() : false;
  }
  public set isInspecting(val: boolean) {
    this.getDevToolsHost().setIsInspecting(val);
  }
  public get isFontFinderActive(): boolean {
    return this.devToolsHost ? this.devToolsHost.getIsFontFinderActive() : false;
  }
  public set isFontFinderActive(val: boolean) {
    this.getDevToolsHost().setIsFontFinderActive(val);
  }
  public get isLensActive(): boolean {
    return this.devToolsHost ? this.devToolsHost.getIsLensActive() : false;
  }
  public set isLensActive(val: boolean) {
    this.getDevToolsHost().setIsLensActive(val);
  }
  public get isRulerActive(): boolean {
    return this.devToolsHost ? this.devToolsHost.getIsRulerActive() : false;
  }
  public set isRulerActive(val: boolean) {
    this.getDevToolsHost().setIsRulerActive(val);
  }
  public get inspectedTabId(): string | null {
    return this.devToolsHost ? this.devToolsHost.getInspectedTabId() : null;
  }
  public set inspectedTabId(val: string | null) {
    this.getDevToolsHost().setInspectedTabId(val);
  }
  public get inspectGeneration(): number {
    return this.devToolsHost ? this.devToolsHost.inspectGeneration : 0;
  }
  public set inspectGeneration(val: number) {
    this.getDevToolsHost().inspectGeneration = val;
  }
  public get agentWorkingRefs(): Map<string, number> {
    return this.getAutomationHost().agentWorkingRefs;
  }
  public set agentWorkingRefs(val: Map<string, number>) {
    this.getAutomationHost().agentWorkingRefs = val;
  }
  public get agentWorkingTimers(): Map<string, NodeJS.Timeout> {
    return this.getAutomationHost().agentWorkingTimers;
  }
  public set agentWorkingTimers(val: Map<string, NodeJS.Timeout>) {
    this.getAutomationHost().agentWorkingTimers = val;
  }
  private devToolsHost?: TabDevToolsHost;
  private getDevToolsHost(): TabDevToolsHost {
    if (!this.devToolsHost) {
      this.devToolsHost = new TabDevToolsHost({
        getTabWebContents: (tabId, paneId) => this.getTabWebContents(tabId, paneId),
        getTabRecord: (tabId) => this.tabs?.get(tabId),
        getActiveTabId: () => this.activeTabId,
        getAllTabs: () => (this.tabs ? this.tabs.entries() : [][Symbol.iterator]()),
        broadcastState: () => this.broadcastState(),
        emitInspectToggled: (active) => this.emit('inspect-toggled', active),
        emitElementPicked: (picked) => this.emit('element-picked', picked),
        sendToolbarElementPicked: (picked) => safeSendWebContents(this.toolbarView?.webContents, TOOLBAR_CHANNELS.ELEMENT_PICKED, picked),
        getTabTerminalSession: (tabId) => this.getTabTerminalSession(tabId),
        resolveTargetWorkspace: (targetSessionId, tabUrl) => this.resolveTargetWorkspace(targetSessionId, tabUrl),
        resolveAnnotationWorkspace: (targetSessionId, tabUrl) => this.resolveAnnotationWorkspace(targetSessionId, tabUrl),
        getDiagnostics: (tabId, level) => (this.diagnosticsManager && typeof this.diagnosticsManager.getDiagnostics === 'function') ? this.diagnosticsManager.getDiagnostics(tabId, level as any) : null,
        createTab: (url, activate) => this.createTab(url, activate),
        withTabAgentWorking: (tabId, action) => this.withTabAgentWorking(tabId, action),
        runWithAttachedTabView: (view, action, isMobile) => this.runWithAttachedTabView(view, action, isMobile),
      });
    }
    return this.devToolsHost;
  }
  private persistTimer: NodeJS.Timeout | null = null;
  private automationHost?: TabAutomationHost;

  private getAutomationHost(): TabAutomationHost {
    if (!this.automationHost) {
      this.automationHost = new TabAutomationHost({
        getTabWebContents: (tabId, paneId) => this.getTabWebContents(tabId, paneId),
        getTabRecord: (tabId) => this.tabs?.get(tabId),
        getAutomationTabId: () => this.automationTabId,
        getActiveTabId: () => this.activeTabId,
        getBrowserEpoch: () => this.browserEpoch,
        getSemanticDocumentGeneration: (tabId, paneId) => (this.getSemanticDocumentGeneration ? this.getSemanticDocumentGeneration(tabId, paneId) : 0),
        getLegacyDocumentGeneration: (tabId) => (this.getDocumentGeneration ? this.getDocumentGeneration(tabId) : (this.documentGenerations?.get(tabId) || 0)),
        semanticRefRegistry: this.semanticRefRegistry,
        runTargetOperation: (tabId, paneId, op) => this.runTargetOperation(tabId, paneId, op),
        broadcastState: () => this.broadcastState(),
        syncFrameBackdrop: () => this.syncFrameBackdrop(),
        getAllTabs: () => this.tabs ? this.tabs.entries() : [][Symbol.iterator](),
        applyTabThrottling: () => this.applyTabThrottling(),
        tabDevToolsHost: this.getDevToolsHost(),
        resolveTargetWorkspace: (targetSessionId, tabUrl) => this.resolveTabStrictWorkspace(targetSessionId, tabUrl),
        getTabTerminalSession: (tabId) => this.getTabTerminalSession(tabId),
        sendKeyboardPress: (params) => this.sendKeyboardPress(params),
        navigateAndWait: (tabId, inputUrl, timeoutMs) => this.navigateAndWait(tabId, inputUrl, timeoutMs),
      });
    }
    return this.automationHost;
  }
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

  public getSemanticDocumentGeneration(tabId: string, paneId?: string): number {
    const key = makeTargetKey(tabId, paneId);
    return this.semanticDocumentGenerations.get(key) || 1;
  }

  public setSemanticDocumentGeneration(tabId: string, paneId: string | undefined, gen: number): void {
    const key = makeTargetKey(tabId, paneId);
    this.semanticDocumentGenerations.set(key, gen);
  }

  public async runTargetOperation<T>(tabId: string, paneId: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (this.isDisposed) {
      throw new CapabilityError('RUNTIME_DRAINING', 'NativeTabHost is disposed');
    }
    const key = makeTargetKey(tabId, paneId);
    const previousTail = this.targetOperationQueues.get(key) || Promise.resolve();

    let resolveTail!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      resolveTail = resolve;
    });

    this.targetOperationQueues.set(key, currentTail);

    try {
      await previousTail;
      if (this.isDisposed) {
        throw new CapabilityError('RUNTIME_DRAINING', 'NativeTabHost disposed before operation began');
      }
      return await operation();
    } finally {
      resolveTail();
      if (this.targetOperationQueues.get(key) === currentTail) {
        this.targetOperationQueues.delete(key);
      }
    }
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
      if (typeof (wc as unknown as { canGoBack?: () => boolean }).canGoBack === 'function') {
        return Boolean((wc as unknown as { canGoBack: () => boolean }).canGoBack());
      }
    } catch {}
    return false;
  }

  private getCanGoForward(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      const nav = (wc as unknown as { navigationHistory?: { canGoForward?: () => boolean } }).navigationHistory;
      if (nav && typeof nav.canGoForward === 'function') return Boolean(nav.canGoForward());
      if (typeof (wc as unknown as { canGoForward?: () => boolean }).canGoForward === 'function') {
        return Boolean((wc as unknown as { canGoForward: () => boolean }).canGoForward());
      }
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
    const stateDir = app ? app.getPath('userData') : StorageLocations.getConfigDir();
    this.terminalWindowStateManager = new WindowStateManager(stateDir, 900, 600, 'terminal-popout-window-state.json');
    this.capsuleManager = capsuleManager || new WorkspaceCapsuleManager({ filePath: path.join(stateDir, 'workspace-capsules.json') });
    this.getAutomationHost();
    this.getDevToolsHost();
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
      safeSendWebContents(this.sidebarView?.webContents, 'antifan:terminal:session', TerminalManager.getInstance().getSessionState());
    });
    this.sidebarView.webContents.loadFile(standaloneHtml);

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
    const availableHeight = Math.max(0, height - toolbarHeight);
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
    const availableHeight = Math.max(0, height - toolbarHeight);

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
    if (this.isSidebarOpen && this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
      safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:session', TerminalManager.getInstance().getSessionState());
    }
    return this.isSidebarOpen;
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
        themeQa: this.getThemeQaState(this.activeTabId),
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
    ipcMain.handle(TOOLBAR_CHANNELS.CAPTURE_FULL_PAGE, () => this.captureScreenshot(undefined, undefined, undefined, { fullPage: true }));
    ipcMain.handle(TOOLBAR_CHANNELS.CAPTURE_VIEWPORT, () => this.captureScreenshot());
    ipcMain.handle(TOOLBAR_CHANNELS.OPEN_EXTERNAL, (_event, url?: string) => this.openExternal(url));
    ipcMain.handle(TOOLBAR_CHANNELS.OPEN_IN_VSCODE, () => this.openInVSCode());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_BOOKMARK, (_event, { url, title }: { url: string; title?: string }) => this.toggleBookmark(url, title));
    ipcMain.handle(TOOLBAR_CHANNELS.FIND_IN_PAGE, (_event, { text, forward, findNext }: { text: string; forward?: boolean; findNext?: boolean }) => this.findInPage(text, forward, findNext));
    ipcMain.handle(TOOLBAR_CHANNELS.STOP_FIND_IN_PAGE, () => this.stopFindInPage());
    ipcMain.handle(TOOLBAR_CHANNELS.SHOW_MENU, () => this.showMainMenu());
    ipcMain.handle('antifan:toolbar:check-updates', () => checkForUpdatesAndRestart(this.window));
    ipcMain.handle('antifan:copy-bridge-token', () => {
      const bridge = BridgeServer.getInstance();
      if (bridge) {
        const token = bridge.getToken();
        clipboard.writeText(token);
        return { success: true };
      }
      return { success: false, error: 'Bridge server not running' };
    });
    ipcMain.handle('antifan:rotate-bridge-token', () => {
      const bridge = BridgeServer.getInstance();
      if (bridge) {
        const token = bridge.rotateToken();
        clipboard.writeText(token);
        return { success: true };
      }
      return { success: false, error: 'Bridge server not running' };
    });
    ipcMain.handle(TOOLBAR_CHANNELS.SET_OVERLAY, (_event, active: boolean, customHeight?: number) => this.setToolbarOverlay(active, customHeight));
    ipcMain.handle(TOOLBAR_CHANNELS.CLEAR_STORAGE, () => this.clearStorageForActiveTab());
    ipcMain.handle(TOOLBAR_CHANNELS.GET_CHROME_PROFILES, () => ChromeProfileSyncManager.getInstance().getAvailableProfiles());
    LocalSessionVault.getInstance().registerIpcHandlers(() => this.getActiveTabSession());
    ipcMain.handle(TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE, async (_event, profileId: string) => {
      const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
      const targetSession = activeTab?.view?.webContents && !activeTab.view.webContents.isDestroyed()
        ? activeTab.view.webContents.session
        : (activeTab?.state.partition ? session.fromPartition(activeTab.state.partition) : this.getSharedProfileSession());
      const res = await ChromeProfileSyncManager.getInstance().syncProfile(profileId, targetSession);
      const bm = ChromeProfileSyncManager.getInstance().getChromeBookmarks(profileId);
      if (bm && bm.length > 0) {
        this.bookmarks = bm.map(b => ({ id: b.url, title: b.title, url: b.url, createdAt: Date.now() }));
      }
      try {
        await targetSession.cookies.flushStore();
      } catch {}
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
    TerminalManager.getInstance().on('data', (payload: { sessionId: string; data: string; seq: number }) => {
      if (this.isSidebarOpen && this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
        safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:data', payload);
      }
      for (const [id, win] of this.terminalWindows.entries()) {
        if (win && !win.isDestroyed()) {
          safeSendWebContents(win.webContents, 'antifan:terminal:data', payload);
        } else {
          this.terminalWindows.delete(id);
        }
      }
    });

    TerminalManager.getInstance().on('session', (state: unknown) => {
      if (this.isSidebarOpen && this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
        safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:session', state);
      }
      for (const [id, win] of this.terminalWindows.entries()) {
        if (win && !win.isDestroyed()) {
          safeSendWebContents(win.webContents, 'antifan:terminal:session', state);
        } else {
          this.terminalWindows.delete(id);
        }
      }
    });
    TerminalManager.getInstance().on('session-closed', ({ id }: { id: string }) => {
      this.clearTerminalAgentAffinity(id);
    });
    TerminalManager.getInstance().on('session-restarted', ({ id, generation }: { id: string; generation: number }) => {
      this.migrateTerminalAgentAffinityGeneration(id, generation);
    });
    TerminalManager.getInstance().on('session-created', ({ id, parentId, generation }: { id: string; parentId?: string; generation?: number }) => {
      let targetTab = this.activeTabId;
      if (parentId) {
        const parentAffinity = this.getTerminalAgentAffinity(parentId);
        if (parentAffinity && parentAffinity.status === 'alive') {
          targetTab = parentAffinity.tabId;
        }
      }
      if (targetTab && this.hasTab(targetTab)) {
        this.bindTerminalAgentAffinity(id, generation || 1, targetTab);
      }
    });

    ipcMain.handle(TERMINAL_CHANNELS.GET_FULL_BUFFER, (_event, sessionId?: string) => {
      const tm = TerminalManager.getInstance();
      const targetId = sessionId || tm.getActiveSessionId();
      return tm.getFullBuffer(targetId);
    });
    ipcMain.handle(TERMINAL_CHANNELS.START, (_event, cwd?: string) => {
      const ok = TerminalManager.getInstance().startTerminal(cwd);
      const activeSessionId = TerminalManager.getInstance().getActiveSessionId();
      if (ok && activeSessionId && this.activeTabId) {
        const session = TerminalManager.getInstance().getSession(activeSessionId);
        this.bindTerminalAgentAffinity(activeSessionId, session?.sessionGeneration, this.activeTabId);
      }
      return ok;
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
      const sessionId = TerminalManager.getInstance().createSession(cwd);
      if (this.activeTabId) {
        const session = TerminalManager.getInstance().getSession(sessionId);
        this.bindTerminalAgentAffinity(sessionId, session?.sessionGeneration, this.activeTabId);
      }
      return sessionId;
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
      this.clearTerminalAgentAffinity(id);
      return TerminalManager.getInstance().closeSession(id);
    });
    ipcMain.handle('antifan:terminal:delete-session', (_event, id: string) => {
      this.clearTerminalAgentAffinity(id);
      return TerminalManager.getInstance().closeSession(id);
    });

    ipcMain.handle('antifan:terminal:rebind-affinity', (_event, { tabId, terminalId }: { tabId?: string; terminalId?: string }) => {
      const targetTabId = tabId || this.activeTabId;
      const targetTerminalId = terminalId || TerminalManager.getInstance().getActiveSessionId();
      if (!this.hasTab(targetTabId)) return false;
      const session = TerminalManager.getInstance().getSession(targetTerminalId);
      if (!session) return false;
      const ok = this.bindTerminalAgentAffinity(targetTerminalId, session.sessionGeneration, targetTabId);
      if (ok) {
        this.broadcastState();
      }
      return ok;
    });
    ipcMain.handle('antifan:terminal:adopt-tab', (_event, { tabId, terminalId }: { tabId?: string; terminalId?: string }) => {
      const targetTabId = tabId || this.activeTabId;
      const targetTerminalId = terminalId || TerminalManager.getInstance().getActiveSessionId();
      if (!targetTerminalId || !this.hasTab(targetTabId)) return false;
      const session = TerminalManager.getInstance().getSession(targetTerminalId);
      if (!session) return false;
      return this.adoptChildTab(targetTerminalId, targetTabId, session.sessionGeneration);
    });

    ipcMain.handle('antifan:terminal:remove-tab', (_event, { tabId, terminalId }: { tabId?: string; terminalId?: string }) => {
      const targetTabId = tabId || this.activeTabId;
      const targetTerminalId = terminalId || TerminalManager.getInstance().getActiveSessionId();
      if (!targetTerminalId) return false;
      const session = TerminalManager.getInstance().getSession(targetTerminalId);
      if (!session) return false;
      return this.removeManagedTab(targetTerminalId, targetTabId, session.sessionGeneration);
    });

    ipcMain.handle('antifan:tabs:get-list', () => {
      return this.getTabList().map((t) => ({
        id: t.id,
        title: t.title || 'Tab',
        url: t.url || 'about:blank',
      }));
    });

    ipcMain.handle('antifan:terminal:get-affinity', (_event, terminalId?: string) => {
      const targetId = terminalId || TerminalManager.getInstance().getActiveSessionId();
      if (!targetId) return undefined;
      return this.getTerminalAgentAffinity(targetId);
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

  private setupGlobalShortcutsOnView(wc: Electron.WebContents, tabId?: string): void {
    wc.on('before-input-event', (_event, input) => {
      if (this.agentInputInFlight === 0 && this.viewportGate) {
        const automationTargetTabId = this.automationTabId;
        // Scoped User Preemption (RT-01):
        // If tabId is not explicitly bound (e.g. toolbarView), the event belongs to the current foreground tab (this.activeTabId).
        // Only preempt the active agent if the physical keyboard input occurred on the automation target tab.
        // User typing on Tab 2 (YouTube/Chat or toolbar URL bar) must never cancel or poison background agent work on Tab 1.
        const eventTabId = tabId ?? this.activeTabId;
        if (automationTargetTabId && eventTabId === automationTargetTabId) {
          this.viewportGate.preemptActiveAgent('Manual keyboard input detected on tab', eventTabId);
        }
      }
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
        label: '🔑 Copy Bridge Token (for Extension)',
        click: () => {
          const bridge = BridgeServer.getInstance();
          if (bridge) {
            const token = bridge.getToken();
            clipboard.writeText(token);
            dialog.showMessageBox(this.window, {
              type: 'info',
              title: 'Bridge Token',
              message: 'Đã sao chép mã Bridge Token vào Clipboard.\nBạn có thể dán vào Chrome Extension.',
            });
          }
        },
      },
      {
        label: '🔄 Rotate Bridge Token (Invalidate & Regenerate)',
        click: () => {
          const bridge = BridgeServer.getInstance();
          if (bridge) {
            const token = bridge.rotateToken();
            clipboard.writeText(token);
            dialog.showMessageBox(this.window, {
              type: 'info',
              title: 'Bridge Token Rotated',
              message: 'Đã tạo mới mã Bridge Token và sao chép vào Clipboard.\nCác kết nối cũ đã bị vô hiệu hóa.',
            });
          }
        },
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

  private temporaryViewAttachCounts = new WeakMap<WebContentsView, { count: number; attachedByHelper: boolean }>();

  public isTabViewAttached(view: WebContentsView | null | undefined): boolean {
    if (!view || !this.window || (typeof this.window.isDestroyed === 'function' && this.window.isDestroyed()) || !this.window.contentView) return false;
    return Array.isArray(this.window.contentView.children) && this.window.contentView.children.includes(view);
  }
  public async runWithAttachedTabView<T>(view: WebContentsView | null | undefined, action: () => Promise<T>, isMobile = false): Promise<T> {
    if (!view || !this.window || (typeof this.window.isDestroyed === 'function' && this.window.isDestroyed()) || !this.window.contentView) {
      return action();
    }
    if (!this.temporaryViewAttachCounts) {
      this.temporaryViewAttachCounts = new WeakMap();
    }
    const state = this.temporaryViewAttachCounts.get(view);
    if (!state || state.count === 0) {
      const wasAttached = this.isTabViewAttached(view);
      if (!wasAttached) {
        this.attachTabView(view, isMobile);
      }
      this.temporaryViewAttachCounts.set(view, { count: 1, attachedByHelper: !wasAttached });
    } else {
      state.count++;
    }
    try {
      return await action();
    } finally {
      const current = this.temporaryViewAttachCounts.get(view);
      if (current) {
        current.count--;
        if (current.count <= 0) {
          this.temporaryViewAttachCounts.delete(view);
          const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
          const isActiveView = activeTab && (activeTab.view === view || activeTab.mobileView === view);
          if (!isActiveView && current.attachedByHelper) {
            try {
              if (this.window && (typeof this.window.isDestroyed !== 'function' || !this.window.isDestroyed()) && this.window.contentView && this.isTabViewAttached(view)) {
                this.window.contentView.removeChildView(view);
              }
            } catch {}
          }
        }
      }
    }
  }

  public attachTabView(view: WebContentsView | null | undefined, isMobile = false): void {
    if (!view || !this.window || (typeof this.window.isDestroyed === 'function' && this.window.isDestroyed()) || !this.window.contentView) return;
    if (view.webContents && typeof view.webContents.isDestroyed === 'function' && view.webContents.isDestroyed()) return;
    try {
      if (Array.isArray(this.window.contentView.children) && this.window.contentView.children.includes(view)) return;
      const children = Array.isArray(this.window.contentView.children) ? this.window.contentView.children : [];
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
    // Shell views stay above tab views through attachTabView indexing.
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
  public getTabSession(tabId: string): Electron.Session | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      return tab.view.webContents.session;
    }
    if (tab.state.partition) {
      return session.fromPartition(tab.state.partition);
    }
    return session.defaultSession;
  }

  public getActiveTabSession(): Electron.Session {
    if (this.activeTabId) {
      const activeSes = this.getTabSession(this.activeTabId);
      if (activeSes) return activeSes;
    }
    return this.getSharedProfileSession();
  }

  public isValidCapsulePartition(partition: string): boolean {
    if (!partition || typeof partition !== 'string') return false;
    const clean = partition.trim();
    if (clean.startsWith('persist:profile-') || clean.startsWith('ephemeral-profile-')) {
      return true;
    }
    if (clean.startsWith('ephemeral-')) {
      if (!/^ephemeral-[a-zA-Z0-9_-]+-[a-z0-9]+(-native)?$/.test(clean)) {
        return false;
      }
      for (const tab of this.tabs.values()) {
        if (tab.state.partition === clean) {
          return true;
        }
      }
      return false;
    }
    if (clean === deriveCapsulePartition('default') || clean === 'persist:capsule-default') {
      return true;
    }
    const allCapsules = this.capsuleManager.list();
    for (const cap of allCapsules) {
      if (
        clean === deriveCapsulePartition(cap.id, 'clean') ||
        clean === deriveCapsulePartition(cap.id, 'native')
      ) {
        return true;
      }
    }
    for (const tab of this.tabs.values()) {
      if (tab.state.partition === clean) {
        return true;
      }
    }
    return false;
  }

  public getPartitionSession(partition: string): Electron.Session {
    if (!partition || partition === 'default' || partition === 'persist:default') {
      return session.defaultSession;
    }
    return session.fromPartition(partition);
  }

  public getSharedProfilePartition(userAgentMode: BrowserSessionUserAgentMode = 'clean', ephemeral = false): string {
    const activeProfileId = ChromeProfileSyncManager.getInstance().activeProfileId || 'default';
    const safeProfileKey = activeProfileId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (ephemeral) {
      const nonce = Math.random().toString(36).slice(2, 10);
      return userAgentMode === 'native'
        ? `ephemeral-profile-${safeProfileKey}-${nonce}-native`
        : `ephemeral-profile-${safeProfileKey}-${nonce}`;
    }
    return userAgentMode === 'native'
      ? `persist:profile-${safeProfileKey}-native`
      : `persist:profile-${safeProfileKey}`;
  }

  public getSharedProfileSession(userAgentMode: BrowserSessionUserAgentMode = 'clean'): Electron.Session {
    const partition = this.getSharedProfilePartition(userAgentMode);
    configureBrowserSessionPartition(partition, userAgentMode);
    return session.fromPartition(partition);
  }

  public async flushAllSessions(): Promise<void> {
    const sessions = new Set<Electron.Session>();
    try {
      sessions.add(session.defaultSession);
    } catch {}
    try {
      const sharedSes = this.getSharedProfileSession();
      if (sharedSes) sessions.add(sharedSes);
    } catch {}
    for (const tab of this.tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        sessions.add(tab.view.webContents.session);
      } else if (tab.state.partition) {
        sessions.add(session.fromPartition(tab.state.partition));
      }
    }
    const promises = Array.from(sessions).map(async (s) => {
      try {
        if (s && s.cookies && typeof s.cookies.flushStore === 'function') {
          await s.cookies.flushStore();
        }
      } catch (err) {
        console.warn('[native-tab-host] Failed to flush cookie store for session:', err);
      }
    });
    await Promise.allSettled(promises);
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

    this.networkTracker.ensureAttached(id, paneId, wc, () => wc.getURL()).catch(() => {});
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
      const currentTab = this.tabs.get(id);
      const splitHasLiveMobile = Boolean(state.splitMode && currentTab?.mobileView && !currentTab.mobileView.webContents.isDestroyed());
      const authorityPane = splitHasLiveMobile ? (currentTab?.focusedPane || state.splitFocusedPane || 'desktop') : 'desktop';
      if (paneId === authorityPane) {
        state.canGoBack = this.getCanGoBack(wc);
        state.canGoForward = this.getCanGoForward(wc);
      }
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
    wc.on('did-start-navigation', (_event, navUrl, isInPlace, isMainFrame) => {
      const semanticKey = makeTargetKey(id, paneId);
      if (!this.semanticDocumentGenerations) this.semanticDocumentGenerations = new Map();
      this.semanticDocumentGenerations.set(semanticKey, (this.semanticDocumentGenerations.get(semanticKey) || 1) + 1);
      this.semanticRefRegistry?.invalidateTarget(id, paneId);
      const currentTab = this.tabs.get(id);
      const splitHasLiveMobile = Boolean(state.splitMode && currentTab?.mobileView && !currentTab.mobileView.webContents.isDestroyed());
      const authorityPane = splitHasLiveMobile ? (currentTab?.focusedPane || state.splitFocusedPane || 'desktop') : 'desktop';
      if (isMainFrame && !isInPlace && authorityPane === paneId) {
        this.documentGenerations.set(id, (this.documentGenerations.get(id) || 0) + 1);
        this.asyncQaQueue?.abort(id);
        // cho QA. Không clear trên hash navigation (did-navigate-in-page,
        // isInPlace=true) hoặc subframe; split-mode mirror navigation ở pane
        // khác cũng không clear (gate authorityPane).
        this.diagnosticsManager.clear(id);
        this.tabThemeQaStates?.set(id, { status: 'idle', issueCount: 0, updatedAt: Date.now() });
        if (id === this.activeTabId) {
          this.broadcastState();
        }
      }
    });
    wc.on('will-redirect', (_event, _redirectUrl) => {});

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

      }
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      if (paneId === 'desktop' && favicons.length > 0) {
        state.favicon = favicons[0];
        this.broadcastState();
      }
    });

    wc.on('did-navigate', (_event, navUrl, httpResponseCode, httpStatusText) => {
      if (isInternalWidgetOrSubframeUrl(navUrl)) return;
      const currentUrl = wc.getURL();
      const chosenUrl = (currentUrl && currentUrl !== 'about:blank' && !isInternalWidgetOrSubframeUrl(currentUrl))
        ? currentUrl
        : navUrl;
      const cleanUrl = cleanRestoredUrl(chosenUrl);

      if (typeof httpResponseCode === 'number' && httpResponseCode >= 400) {
        const origin = computeOrigin(cleanUrl, currentUrl);
        this.diagnosticsManager.recordFailure(id, {
          errorCode: httpResponseCode,
          status: httpResponseCode,
          errorDescription: `HTTP ${httpResponseCode} ${httpStatusText || 'Error'}`,
          validatedURL: cleanUrl,
          isMainFrame: true,
          timestamp: Date.now(),
          origin: origin.origin,
          isFirstParty: origin.isFirstParty,
        });
      }

      if (paneId === 'desktop') {
        state.url = cleanUrl;
        if (state.url && state.url !== 'about:blank' && !state.url.startsWith('view-source:')) {
          HistoryManager.getInstance().recordVisit(state.url, state.title, state.favicon);
        }
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
      if (paneId === 'desktop') {
        state.crashed = true;
        this.broadcastState();
      } else {
        this.toggleSplitReview(id, false);
        state.splitError = 'Mobile view process exited unexpectedly';
        this.broadcastState();
      }
    });
    (wc as unknown as EventEmitter).on('close', () => {
      clearLoadingTimer();
      if (paneId === 'desktop' && !this.isDisposed && this.tabs.has(id)) {
        this.closeTab(id);
      }
    });

    wc.on('destroyed', () => {
      clearLoadingTimer();
      if (paneId === 'desktop' && !this.isDisposed && this.tabs.has(id)) {
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
              const newTabId = this.createTab(url, true);
              if (newTabId) {
                this.adoptChildTab(id, newTabId, undefined, 'native_window_open', id);
              }
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

    this.setupGlobalShortcutsOnView(wc, id);
    this.setupContextMenu(wc, paneId);
  }

  public createTab(
    initialUrl = 'https://www.google.com',
    activate = true,
    options?: {
      capsuleId?: string;
      userAgentMode?: BrowserSessionUserAgentMode;
      ephemeral?: boolean;
      isolateSession?: boolean;
      partition?: string;
    }
  ): string {
    if (this.isDisposed) return '';
    const trimmed = (initialUrl || '').trim();
    if (trimmed && (trimmed.startsWith('file://') || /^[a-zA-Z]:[/\\]/.test(trimmed))) {
      const previewTabId = this.createPreviewTab(trimmed);
      if (previewTabId) return previewTabId;
    }

    const id = randomUUID();
    let capsuleIdForTab: string | undefined = options?.capsuleId;
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
        capsuleIdForTab = cap.id;
        url = initialUrl;
      } catch (err) {
        console.warn(`[native-tab-host] Failed to parse preview url: ${initialUrl}`, err);
        return '';
      }
    } else {
      const cleanInitialUrl = cleanRestoredUrl(initialUrl);
      url = sanitizeUrl(cleanInitialUrl);
    }

    if (!capsuleIdForTab) {
      capsuleIdForTab = this.capsuleManager.getActive()?.id;
    }

    const userAgentMode: BrowserSessionUserAgentMode = options?.userAgentMode || 'clean';
    const isEphemeral = Boolean(options?.ephemeral);
    let partition: string;
    if (options?.partition && typeof options.partition === 'string') {
      partition = options.partition.trim();
    } else if (options?.isolateSession) {
      partition = deriveCapsulePartition(capsuleIdForTab, userAgentMode, isEphemeral);
    } else {
      partition = this.getSharedProfilePartition(userAgentMode, isEphemeral);
    }
    configureBrowserSessionPartition(partition, userAgentMode);
    const view = new WebContentsView({
      webPreferences: getSecureWebPreferences(partition),
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
      capsuleId: capsuleIdForTab,
      userAgentMode,
      partition,
      ephemeral: isEphemeral,
    };
    this.setupTabWebContentsEvents(id, view, state, 'desktop');

    this.tabs.set(id, { view, state, focusedPane: 'desktop' });
    this.tabOrder.push(id);

    if (capsuleIdForTab && url.startsWith('antifan-preview://')) {
      const cap = this.capsuleManager.list().find((c) => c.id.toLowerCase() === capsuleIdForTab!.toLowerCase());
      if (cap && cap.workspacePath && fs.existsSync(cap.workspacePath)) {
        const unsub = this.previewWatcherPool.retain(cap.id, cap.workspacePath, (event) => {
          this.dispatchScopedReload(cap.id, event);
        });
        this.tabPreviewUnsubscribers.set(id, unsub);
      }
    }
    const wc = view.webContents;
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
    if (activate) {
      this.switchTab(id);
    } else {
      try {
        wc.setBackgroundThrottling(true);
      } catch {}
      this.updateLayout();
      this.broadcastState();
    }
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
          webPreferences: getSecureWebPreferences(target.state.partition),
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
      this.applyTabThrottling();
      if (isBenchmarkEnabled()) {
        recordBenchmark({ surface: 'tabs', name: 'switched', value: performance.now() - switchStartMs, extra: { attachedViews: this.countAttachedViews() } });
      }
      return true;
    } catch (err) {
      console.error('[native-tab-host] switchTab unexpected error:', err);
      return false;
    }
  }
  public applyTabThrottling(): void {
    if (this.isDisposed) return;
    for (const [id, tab] of this.tabs.entries()) {
      const isForeground = id === this.activeTabId;
      const isAgentWorking = tab.state.aiState === 'agent_working' || (this.automationHost?.agentWorkingRefs.get(id) || 0) > 0;
      // Dynamic In-Flight Throttling Exemption (RT-02):
      // Unthrottle if the tab is foreground OR currently executing active agent operations.
      // Once agent finishes (returns to idle), tab immediately throttles to conserve CPU/RAM.
      const shouldThrottle = !isForeground && !isAgentWorking;
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        try {
          tab.view.webContents.setBackgroundThrottling(shouldThrottle);
        } catch {}
      }
      if (tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        try {
          tab.mobileView.webContents.setBackgroundThrottling(shouldThrottle);
        } catch {}
      }
    }
  }


  private activateAgentVisualGlow(tabId: string): void {
    this.getAutomationHost().activateAgentVisualGlow(tabId);
  }

  private deactivateAgentVisualGlow(tabId: string): void {
    this.getAutomationHost().deactivateAgentVisualGlow(tabId);
  }

  private beginTabAgentWorking(tabId: string): void {
    this.getAutomationHost().beginTabAgentWorking(tabId);
  }

  private clearTabAgentWorking(tabId: string): void {
    this.getAutomationHost().clearTabAgentWorking(tabId);
  }

  private endTabAgentWorking(tabId: string): void {
    this.getAutomationHost().endTabAgentWorking(tabId);
  }

  private async withTabAgentWorking<T>(tabId: string, action: () => Promise<T>): Promise<T> {
    return this.getAutomationHost().withTabAgentWorking(tabId, action);
  }

  public markTabAgentWorking(tabId?: string, durationMs = 5000): void {
    this.getAutomationHost().markTabAgentWorking(tabId, durationMs);
  }
  public setTabAiState(tabId: string, aiState: 'idle' | 'thinking' | 'streaming' | 'completed' | 'agent_working'): void {
    this.getAutomationHost().setTabAiState(tabId, aiState);
  }
  public clearAllAgentWorking(): void {
    this.getAutomationHost().clearAllAgentWorking();
  }

  public closeTab(tabId: string): boolean {
    if (this.isDisposed) return false;
    const target = this.tabs.get(tabId);
    if (!target) return false;
    this.viewportGate?.cleanupTab(tabId);
    this.semanticRefRegistry?.invalidateTab(tabId);
    if (this.semanticDocumentGenerations) {
      const prefix = `${String(tabId).trim()}:`;
      for (const key of Array.from(this.semanticDocumentGenerations.keys())) {
        if (key.startsWith(prefix)) this.semanticDocumentGenerations.delete(key);
      }
    }
    if (this.targetOperationQueues) {
      const prefix = `${String(tabId).trim()}:`;
      for (const key of Array.from(this.targetOperationQueues.keys())) {
        if (key.startsWith(prefix)) this.targetOperationQueues.delete(key);
      }
    }
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
    this.networkTracker?.detachTarget(tabId, 'desktop');
    this.networkTracker?.detachTarget(tabId, 'mobile');
    this.tabThemeQaStates?.delete(tabId);
    this.documentGenerations?.delete(tabId);
    if (this.automationTabId === tabId) {
      this.automationTabId = null;
    }
    this.tombstoneTerminalAgentAffinity(tabId, target.state.url);
    if (this.sessionTabPools) {
      for (const [sId, pool] of Array.from(this.sessionTabPools.entries())) {
        pool.delete(tabId);
        if (pool.size === 0) {
          this.sessionTabPools.delete(sId);
        }
      }
      this.sessionTabPools.delete(tabId);
    }
    if (target.state.partition) {
      unconfigureBrowserSessionPartition(target.state.partition);
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
  public async navigateAndWait(tabId: string, inputUrl: string, timeoutMs: number = 8000): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const cleanUrl = sanitizeUrl(inputUrl);
    if (cleanUrl.startsWith('view-source:')) {
      return this.navigate(tabId, inputUrl);
    }
    const currentUrl = (tab.state.url || '').replace(/\/$/, '');
    const targetUrl = sanitizeUrl(inputUrl).replace(/\/$/, '');
    if (currentUrl && targetUrl === currentUrl) {
      return this.reloadAndWait(tabId, timeoutMs);
    }
    const authorityPane = tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()
      ? (tab.focusedPane || tab.state.splitFocusedPane || 'desktop')
      : 'desktop';
    const authorityView = authorityPane === 'mobile' && tab.mobileView ? tab.mobileView : tab.view;
    if (!authorityView || authorityView.webContents.isDestroyed()) return false;

    const waiter = this.createNavigationLifecycleWaiter(authorityView.webContents, timeoutMs, Math.min(3000, timeoutMs));
    const initiated = this.navigate(tabId, inputUrl);
    if (!initiated) {
      waiter.cancel();
      return false;
    }
    const loadOk = await waiter.promise;
    if (!loadOk) return false;
    return true;
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
  public async reloadAndWait(tabId: string, timeoutMs: number = 8000): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    const isBackground = tabId !== this.activeTabId;
    const effectiveTimeoutMs = timeoutMs !== 8000 ? timeoutMs : (isBackground ? 10000 : 8000);
    const isSplit = Boolean(tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed());

    // Reset inflight records for reload and ensure active debugger attachment
    this.networkTracker.resetInflight(tabId, 'desktop');
    await this.networkTracker.ensureAttached(
      tabId,
      'desktop',
      tab.view.webContents,
      () => this.tabs.get(tabId)?.state.url || ''
    );
    const desktopWaiter = this.createLoadCompletionWaiter(tab.view.webContents, effectiveTimeoutMs);

    let mobileWaiter: { promise: Promise<boolean>; cancel: () => void } | null = null;
    if (isSplit && tab.mobileView) {
      this.networkTracker.resetInflight(tabId, 'mobile');
      await this.networkTracker.ensureAttached(
        tabId,
        'mobile',
        tab.mobileView.webContents,
        () => this.tabs.get(tabId)?.state.url || ''
      );
      mobileWaiter = this.createLoadCompletionWaiter(tab.mobileView.webContents, effectiveTimeoutMs);
    }

    const initiated = this.reload(tabId);
    if (!initiated) {
      desktopWaiter.cancel();
      mobileWaiter?.cancel();
      return false;
    }

    const [desktopOk, mobileOk] = await Promise.all([
      desktopWaiter.promise,
      mobileWaiter ? mobileWaiter.promise : Promise.resolve(true),
    ]);

    if (!desktopOk || !mobileOk) return false;

    await Promise.all([
      this.networkTracker.awaitQuiescence(tabId, 'desktop', { idleWindowMs: 500, maxCeilingMs: Math.min(2000, effectiveTimeoutMs) }),
      isSplit ? this.networkTracker.awaitQuiescence(tabId, 'mobile', { idleWindowMs: 500, maxCeilingMs: Math.min(2000, effectiveTimeoutMs) }) : Promise.resolve(),
    ]);

    return true;
  }
  public getNetworkTracker(): FirstPartyNetworkTracker {
    return this.networkTracker;
  }

  private createLoadCompletionWaiter(wc: Electron.WebContents, timeoutMs: number = 8000): { promise: Promise<boolean>; cancel: () => void } {
    let cancelFn: () => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      if (!wc || wc.isDestroyed()) {
        resolve(false);
        return;
      }
      let settled = false;
      let domIsReady = false;
      const onDomReady = () => {
        domIsReady = true;
      };
      const onFinish = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(true);
        }
      };
      const onFail = (_event: unknown, errorCode: unknown, errorDescription: unknown, _validatedURL: unknown, isMainFrame?: boolean) => {
        if (isMainFrame === false) {
          return;
        }
        if (errorCode === -3 || errorDescription === 'ERR_ABORTED') {
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
        try { wc.removeListener('dom-ready', onDomReady); } catch {}
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
      try { wc.once('dom-ready', onDomReady); } catch {}
      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
    });
    return { promise, cancel: cancelFn };
  }

  private createNavigationLifecycleWaiter(
    wc: Electron.WebContents,
    timeoutMs: number = 8000,
    startTimeoutMs: number = 3000
  ): { promise: Promise<boolean>; cancel: () => void } {
    let cancelFn: () => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      if (!wc || wc.isDestroyed()) {
        resolve(false);
        return;
      }
      let settled = false;
      let navStarted = false;
      let startTimer: NodeJS.Timeout | null = null;
      let totalTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (startTimer) {
          clearTimeout(startTimer);
          startTimer = null;
        }
        if (totalTimer) {
          clearTimeout(totalTimer);
          totalTimer = null;
        }
        try { wc.removeListener('did-start-navigation', onStart); } catch {}
        try { wc.removeListener('did-finish-load', onFinish); } catch {}
        try { wc.removeListener('did-fail-load', onFail); } catch {}
        try { wc.removeListener('did-navigate-in-page', onInPage); } catch {}
      };

      const finish = (result: boolean) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(result);
        }
      };

      const onStart = (_event: unknown, _url: unknown, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace && !settled) {
          navStarted = true;
          if (startTimer) {
            clearTimeout(startTimer);
            startTimer = null;
          }
        }
      };

      const onFinish = () => {
        // ONLY accept finish after this navigation has started in main-frame (non-in-place)
        if (!settled && navStarted) {
          finish(true);
        }
      };

      const onInPage = (_event: unknown, _url: unknown, isMainFrame: boolean) => {
        if (isMainFrame && !settled) {
          finish(true);
        }
      };
      const onFail = (_event: unknown, errorCode: unknown, errorDescription: unknown, _validatedURL: unknown, isMainFrame?: boolean) => {
        if (isMainFrame === false) {
          return;
        }
        // Chromium emits ERR_ABORTED (-3) on HTTP 301/302/307 redirects or request replacements
        if (errorCode === -3 || errorDescription === 'ERR_ABORTED') {
          return;
        }
        // ONLY accept real failure after this navigation has started in main-frame
        if (!settled && navStarted) {
          finish(false);
        }
      };

      startTimer = setTimeout(() => {
        if (!settled && !navStarted) {
          finish(false);
        }
      }, Math.min(startTimeoutMs, timeoutMs));

      totalTimer = setTimeout(() => {
        if (!settled) {
          finish(false);
        }
      }, timeoutMs);

      cancelFn = () => {
        finish(false);
      };

      wc.on('did-start-navigation', onStart);
      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
      wc.on('did-navigate-in-page', onInPage);
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
          webPreferences: getSecureWebPreferences(tab.state.partition),
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
    this.applyTabThrottling();
    this.updateLayout();
    this.broadcastState();
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
    return this.getDevToolsHost().toggleFontFinder();
  }
  public startFontFinder(): void {
    this.getDevToolsHost().startFontFinder();
  }
  public stopFontFinder(): void {
    this.getDevToolsHost().stopFontFinder();
  }

  public toggleLens(): boolean {
    return this.getDevToolsHost().toggleLens();
  }
  public async startLens(): Promise<void> {
    return this.getDevToolsHost().startLens();
  }
  public stopLens(): void {
    this.getDevToolsHost().stopLens();
  }

  public toggleRuler(): boolean {
    return this.getDevToolsHost().toggleRuler();
  }
  public startRuler(): void {
    this.getDevToolsHost().startRuler();
  }
  public stopRuler(): void {
    this.getDevToolsHost().stopRuler();
  }

  // ─── Agent Browser Automation & Visual Cursor ───
  public async ensureAgentBrowserInjected(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    return this.getAutomationHost().ensureAgentBrowserInjected(tabId, paneId);
  }
  public async dispatchAgentAction(action: 'click' | 'type' | 'move' | 'hover' | 'scroll' | 'highlight' | 'clear' | 'trajectory', params: { selector?: string; ref?: string; x?: number; y?: number; text?: string; clear?: boolean; trusted?: boolean; deltaY?: number; label?: string; tabId?: string; paneId?: SplitPaneId; steps?: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean }): Promise<{ success: boolean; data?: unknown; reason?: string }> {
    return this.getAutomationHost().dispatchAgentAction(action, params);
  }
  private async executeInIsolatedWorld(wc: Electron.WebContents, script: string): Promise<unknown> {
    return this.getAutomationHost().executeInIsolatedWorld(wc, script);
  }

  public async agentClick(params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    return this.getAutomationHost().agentClick(params);
  }

  public async agentType(params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    return this.getAutomationHost().agentType(params);
  }
  public async agentScroll(params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    return this.getAutomationHost().agentScroll(params);
  }

  public async agentHover(params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    return this.getAutomationHost().agentHover(params);
  }

  public async agentHighlight(params: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    return this.getAutomationHost().agentHighlight(params);
  }
  public async agentClear(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    return this.getAutomationHost().agentClear(tabId, paneId);
  }
  public async inspectStyles(params: { selector?: string; ref?: string; properties?: string[]; tabId?: string; paneId?: SplitPaneId }): Promise<Record<string, unknown>> {
    return this.getAutomationHost().inspectStyles(params);
  }

  public async inspectRegion(params: { x?: number; y?: number; width?: number; height?: number; selector?: string; ref?: string; tabId?: string; paneId?: SplitPaneId }): Promise<Record<string, unknown>> {
    return this.getAutomationHost().inspectRegion(params);
  }

  public toggleInspect(): boolean {
    return this.getDevToolsHost().toggleInspect();
  }

  public startInspect(): void {
    this.getDevToolsHost().startInspect();
  }

  public stopInspect(targetTabId?: string): void {
    this.getDevToolsHost().stopInspect(targetTabId);
  }

  public isInspectActive(): boolean {
    return this.getDevToolsHost().isInspectActive();
  }

  public hasTab(tabId?: string | null): boolean {
    return Boolean(tabId && this.tabs && this.tabs.has(tabId));
  }

  private resolveTerminalAffinityEntry(terminalId: string, generation?: number | string) {
    const normGen = generation !== undefined && generation !== '' ? String(generation).trim() : undefined;
    if (normGen) {
      return this.terminalAgentAffinity.get(`${terminalId}@${normGen}`);
    }
    const prefix = `${terminalId}@`;
    let latestEntry: any = undefined;
    let maxGen = -1;
    for (const [key, entry] of this.terminalAgentAffinity.entries()) {
      if (key.startsWith(prefix)) {
        const genNum = parseInt(key.slice(prefix.length), 10);
        if (!isNaN(genNum) && genNum > maxGen) {
          maxGen = genNum;
          latestEntry = entry;
        }
      }
    }
    return latestEntry;
  }

  public bindTerminalAgentAffinity(terminalId: string, generation: number | string | undefined, tabId: string): boolean {
    if (!this.terminalAgentAffinity) this.terminalAgentAffinity = new Map();
    if (!terminalId || !tabId) return false;
    const tab = this.tabs?.get(tabId);
    if (!tab) return false;
    const tm = TerminalManager.getInstance();
    const session = tm.getSession(terminalId);
    if (!session) return false;
    const resolvedGen = generation !== undefined && generation !== '' ? generation : session.sessionGeneration;
    this.clearTerminalAgentAffinity(terminalId);
    const managedTabIds = new Set<string>([tabId]);
    const lastUrls = new Map<string, string>([[tabId, tab.state.url || '']]);
    const lineage = new Map<string, { tabId: string; parentTabId?: string; source: 'agent_spawned' | 'native_window_open' | 'user_attached'; createdAt: number }>();
    lineage.set(tabId, { tabId, source: 'user_attached', createdAt: Date.now() });
    this.terminalAgentAffinity.set(`${terminalId}@${resolvedGen}`, {
      tabId,
      primaryTabId: tabId,
      managedTabIds,
      lineage,
      lastUrls,
      lastUrl: tab.state.url,
      closedAt: undefined,
    });
    tab.state.terminalSessionId = terminalId;
    return true;
  }

  public adoptChildTabForSession(sessionId: string, childTabId: string): boolean {
    if (!sessionId || !childTabId) return false;
    if (!this.sessionTabPools) (this as any).sessionTabPools = new Map<string, Set<string>>();
    let pool = this.sessionTabPools.get(sessionId);
    if (!pool) {
      pool = new Set<string>();
      this.sessionTabPools.set(sessionId, pool);
    }
    if (pool.size >= 10 && !pool.has(childTabId)) {
      return false;
    }
    pool.add(childTabId);
    const tab = this.tabs.get(childTabId);
    if (tab) {
      tab.state.terminalSessionId = sessionId;
      this.broadcastState();
    }
    return true;
  }

  public adoptChildTab(
    identifier: string,
    childTabId: string,
    generation?: number | string,
    source: 'agent_spawned' | 'native_window_open' | 'user_attached' = 'agent_spawned',
    parentTabId?: string
  ): boolean {
    if (!this.terminalAgentAffinity || !identifier || !childTabId) return false;
    if (!this.sessionTabPools) (this as any).sessionTabPools = new Map<string, Set<string>>();
    const childTab = this.tabs?.get(childTabId);
    if (!childTab) return false;

    // Check if identifier is an active session or found in sessionTabPools
    let targetSessionId: string | undefined;
    if (this.sessionTabPools.has(identifier)) {
      targetSessionId = identifier;
    } else {
      for (const [sId, pool] of this.sessionTabPools.entries()) {
        if (pool.has(identifier)) {
          targetSessionId = sId;
          break;
        }
      }
    }

    if (!targetSessionId) {
      try {
        const tm = TerminalManager.getInstance();
        if (tm.getSession(identifier) || tm.getActiveSessionId() === identifier) {
          targetSessionId = identifier;
        }
      } catch {}
    }

    if (!targetSessionId) {
      const parentTab = this.tabs.get(identifier);
      if (parentTab?.state.terminalSessionId) {
        const termSessId = parentTab.state.terminalSessionId;
        if (this.sessionTabPools.has(termSessId)) {
          targetSessionId = termSessId;
        } else {
          try {
            const tm = TerminalManager.getInstance();
            if (tm.getSession(termSessId) || tm.getActiveSessionId() === termSessId) {
              targetSessionId = termSessId;
            }
          } catch {}
        }
      }
    }

    // Fallback: If identifier is a live tab (e.g. MCP bound tab without terminal affinity),
    // initialize an ad-hoc session pool anchored at identifier so child tabs are recognized.
    if (!targetSessionId && this.tabs.has(identifier)) {
      targetSessionId = identifier;
    }
    // 1. Try finding entry as terminalId
    let entry = this.resolveTerminalAffinityEntry(identifier, generation);
    let resolvedTerminalId = identifier;

    // 2. If not found by terminalId, try finding by boundTabId
    if (!entry) {
      for (const [key, ent] of this.terminalAgentAffinity.entries()) {
        if (ent.primaryTabId === identifier || ent.managedTabIds?.has(identifier)) {
          entry = ent;
          resolvedTerminalId = key.split('@')[0] || identifier;
          if (!parentTabId) parentTabId = identifier;
          break;
        }
      }
    }

    // Hard limit: max 10 tabs per terminal session - reject before mutating sessionTabPools
    if (entry && entry.managedTabIds && entry.managedTabIds.size >= 10 && !entry.managedTabIds.has(childTabId)) {
      return false;
    }

    let adoptedIntoPool = false;
    if (targetSessionId) {
      if (this.tabs.has(identifier)) {
        this.adoptChildTabForSession(targetSessionId, identifier);
      }
      adoptedIntoPool = this.adoptChildTabForSession(targetSessionId, childTabId);
      if (!adoptedIntoPool && !entry) {
        return false;
      }
    }

    if (!entry) return adoptedIntoPool;

    if (!entry.managedTabIds) entry.managedTabIds = new Set<string>([entry.tabId]);
    entry.managedTabIds.add(childTabId);
    if (!entry.lastUrls) entry.lastUrls = new Map();
    entry.lastUrls.set(childTabId, childTab.state.url || '');
    if (!entry.lineage) entry.lineage = new Map();
    entry.lineage.set(childTabId, {
      tabId: childTabId,
      parentTabId: parentTabId || entry.primaryTabId || entry.tabId,
      source,
      createdAt: Date.now(),
    });

    childTab.state.terminalSessionId = resolvedTerminalId;
    this.broadcastState();
    return true;
  }

  public adoptChildTabForBoundTab(
    boundTabId: string,
    childTabId: string,
    source: 'agent_spawned' | 'native_window_open' | 'user_attached' = 'agent_spawned',
    parentTabId?: string
  ): boolean {
    return this.adoptChildTab(boundTabId, childTabId, undefined, source, parentTabId || boundTabId);
  }

  public getManagedTabIdsForBoundTab(boundTabId: string): Set<string> {
    if (!boundTabId) return new Set();
    if (!this.sessionTabPools) (this as any).sessionTabPools = new Map<string, Set<string>>();
    const directPool = this.sessionTabPools.get(boundTabId);
    if (directPool) {
      return new Set(directPool);
    }
    for (const pool of this.sessionTabPools.values()) {
      if (pool.has(boundTabId)) {
        return new Set(pool);
      }
    }
    for (const entry of this.terminalAgentAffinity.values()) {
      if (entry.primaryTabId === boundTabId || entry.managedTabIds?.has(boundTabId)) {
        return new Set(entry.managedTabIds);
      }
    }
    return new Set([boundTabId]);
  }

  public getManagedTabIds(boundTabIdOrTerminalId: string): Set<string> {
    if (!boundTabIdOrTerminalId) return new Set();
    if (!this.sessionTabPools) (this as any).sessionTabPools = new Map<string, Set<string>>();
    const found = this.sessionTabPools.get(boundTabIdOrTerminalId);
    if (found) {
      return new Set(found);
    }
    for (const pool of this.sessionTabPools.values()) {
      if (pool.has(boundTabIdOrTerminalId)) {
        return new Set(pool);
      }
    }
    return this.getManagedTabIdsForBoundTab(boundTabIdOrTerminalId);
  }

  public isTabAllowedForPrimary(primaryTabId: string, requestedTabId: string): boolean {
    if (!primaryTabId || !requestedTabId) return false;
    if (primaryTabId === requestedTabId) return true;
    if (this.sessionTabPools) {
      for (const pool of this.sessionTabPools.values()) {
        if (pool.has(primaryTabId) && pool.has(requestedTabId)) {
          return true;
        }
      }
    }
    if (this.terminalAgentAffinity) {
      for (const entry of this.terminalAgentAffinity.values()) {
        const matchesSession =
          entry.primaryTabId === primaryTabId ||
          entry.managedTabIds?.has(primaryTabId) ||
          entry.lineage?.has(primaryTabId) ||
          entry.lastUrls?.has(primaryTabId);
        if (matchesSession && (entry.managedTabIds?.has(requestedTabId) || entry.primaryTabId === requestedTabId)) {
          return !entry.closedAt;
        }
      }
    }
    return false;
  }

  public isTabAllowed(primaryOrBoundTabId: string, requestedTabId: string): boolean {
    return this.isTabAllowedForPrimary(primaryOrBoundTabId, requestedTabId);
  }

  public getFailoverTargetTab(staleTabId: string): string | undefined {
    if (!this.terminalAgentAffinity || !staleTabId) return undefined;
    for (const entry of this.terminalAgentAffinity.values()) {
      if (entry.primaryTabId && entry.primaryTabId !== staleTabId && this.hasTab(entry.primaryTabId)) {
        if (entry.managedTabIds?.has(staleTabId) || entry.lineage?.has(staleTabId) || entry.lastUrls?.has(staleTabId)) {
          return entry.primaryTabId;
        }
      }
    }
    return undefined;
  }

  public getTabLineage(tabId: string): { tabId: string; parentTabId?: string; source: string; createdAt: number } | undefined {
    if (!this.terminalAgentAffinity || !tabId) return undefined;
    for (const entry of this.terminalAgentAffinity.values()) {
      if (entry.lineage?.has(tabId)) {
        return entry.lineage.get(tabId);
      }
    }
    return undefined;
  }
  public removeManagedTab(terminalId: string, tabId: string, generation?: number | string): boolean {
    if (!this.terminalAgentAffinity || !terminalId || !tabId) return false;
    const entry = this.resolveTerminalAffinityEntry(terminalId, generation);
    if (!entry) return false;

    entry.managedTabIds.delete(tabId);
    if (entry.lastUrls) entry.lastUrls.delete(tabId);
    const tab = this.tabs?.get(tabId);
    if (tab && tab.state.terminalSessionId === terminalId) {
      tab.state.terminalSessionId = undefined;
    }

    if (entry.primaryTabId === tabId) {
      let nextPrimary: string | undefined;
      for (const id of entry.managedTabIds) {
        if (this.hasTab(id)) {
          nextPrimary = id;
          break;
        }
      }
      if (nextPrimary) {
        entry.primaryTabId = nextPrimary;
        entry.tabId = nextPrimary;
        entry.lastUrl = entry.lastUrls?.get(nextPrimary) || '';
      } else {
        entry.closedAt = Date.now();
      }
    }
    this.broadcastState();
    return true;
  }

  public clearTerminalAgentAffinity(terminalId: string): void {
    if (!this.terminalAgentAffinity || !terminalId) return;
    const prefix = `${terminalId}@`;
    for (const key of Array.from(this.terminalAgentAffinity.keys())) {
      if (key === terminalId || key.startsWith(prefix)) {
        this.terminalAgentAffinity.delete(key);
      }
    }
    for (const tab of this.tabs.values()) {
      if (tab.state.terminalSessionId === terminalId) {
        tab.state.terminalSessionId = undefined;
      }
    }
  }

  public tombstoneTerminalAgentAffinity(tabId: string, lastUrl?: string): void {
    if (!this.terminalAgentAffinity || !tabId) return;
    for (const entry of this.terminalAgentAffinity.values()) {
      if (entry.managedTabIds && entry.managedTabIds.has(tabId)) {
        entry.managedTabIds.delete(tabId);
        if (entry.lastUrls) entry.lastUrls.delete(tabId);
        if (entry.primaryTabId === tabId) {
          let nextPrimary: string | undefined;
          for (const id of entry.managedTabIds) {
            if (this.hasTab(id)) {
              nextPrimary = id;
              break;
            }
          }
          if (nextPrimary) {
            entry.primaryTabId = nextPrimary;
            entry.tabId = nextPrimary;
            entry.lastUrl = entry.lastUrls?.get(nextPrimary) || '';
          } else {
            entry.closedAt = Date.now();
            entry.lastUrl = lastUrl || entry.lastUrl;
          }
        }
      } else if (entry.tabId === tabId) {
        entry.closedAt = Date.now();
        entry.lastUrl = lastUrl || entry.lastUrl;
      }
    }
  }

  public migrateTerminalAgentAffinityGeneration(terminalId: string, newGeneration: number): void {
    if (!this.terminalAgentAffinity || !terminalId) return;
    const prefix = `${terminalId}@`;
    let existingEntry: any = undefined;
    for (const [key, entry] of this.terminalAgentAffinity.entries()) {
      if (key.startsWith(prefix)) {
        existingEntry = entry;
        this.terminalAgentAffinity.delete(key);
      }
    }
    if (existingEntry) {
      this.terminalAgentAffinity.set(`${terminalId}@${newGeneration}`, existingEntry);
    }
  }

  public getTerminalAgentAffinity(terminalSessionId: string, generation?: number | string): {
    tabId: string;
    primaryTabId: string;
    managedTabIds: string[];
    status: 'alive' | 'closed';
    lastUrl?: string;
  } | undefined {
    if (!this.terminalAgentAffinity || !terminalSessionId) return undefined;
    const entry = this.resolveTerminalAffinityEntry(terminalSessionId, generation);
    if (!entry) return undefined;

    const managedArr: string[] = Array.from(entry.managedTabIds ? entry.managedTabIds.values() : [entry.tabId]);
    const hasAliveTab = managedArr.some((id) => this.hasTab(id)) || this.hasTab(entry.tabId);
    const status: 'alive' | 'closed' = hasAliveTab && !entry.closedAt ? 'alive' : 'closed';

    return {
      tabId: entry.primaryTabId || entry.tabId,
      primaryTabId: entry.primaryTabId || entry.tabId,
      managedTabIds: managedArr,
      status,
      lastUrl: entry.lastUrl,
    };
  }

  public getTabTerminalSession(tabId: string): string | undefined {
    const tab = this.tabs.get(tabId);
    if (!tab) return undefined;

    const tm = TerminalManager.getInstance();
    const liveSessions = tm.listSessions();

    // 1. Check if the active terminal session has affinity to this tab (primary or managed)
    const activeSessionId = tm.getActiveSessionId();
    if (activeSessionId) {
      const activeGen = liveSessions.find((s) => s.id === activeSessionId)?.sessionGeneration;
      const affinity = this.getTerminalAgentAffinity(activeSessionId, activeGen);
      if (affinity && affinity.status === 'alive') {
        if (affinity.tabId === tabId || (affinity.managedTabIds && affinity.managedTabIds.includes(tabId))) {
          return activeSessionId;
        }
      }
    }

    // 2. Check if any other live terminal session has affinity to this tab
    for (const session of liveSessions) {
      const affinity = this.getTerminalAgentAffinity(session.id, session.sessionGeneration);
      if (affinity && affinity.status === 'alive') {
        if (affinity.tabId === tabId || (affinity.managedTabIds && affinity.managedTabIds.includes(tabId))) {
          return session.id;
        }
      }
    }

    // 3. Fallback to remembered tab.state.terminalSessionId
    if (!tab.state.terminalSessionId) return undefined;
    const sessionId = tab.state.terminalSessionId;
    if (sessionId === 'auto') return 'auto';
    const valid = liveSessions.some((s) => s.id === sessionId);
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

    return '';
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

  /**
   * Fail-closed workspace resolver for Tab Automation (e.g. file upload/drop security).
   * Only resolves the specific tab's bound terminal session or explicit tab URL mapping.
   * NEVER falls through to active capsule, active terminal, or global CWD.
   */
  public resolveTabStrictWorkspace(targetSessionId?: string, tabUrl?: string): string {
    const tm = TerminalManager.getInstance();
    if (targetSessionId && targetSessionId !== 'auto') {
      const session = tm.getSession(targetSessionId);
      if (session?.cwd && fs.existsSync(path.normalize(session.cwd))) {
        return path.normalize(session.cwd);
      }
    }
    if (tabUrl) {
      const urlWorkspace = resolveWorkspaceFromUrl(tabUrl, DEFAULT_WORKSPACE_ROOTS);
      if (urlWorkspace && fs.existsSync(path.normalize(urlWorkspace))) {
        return path.normalize(urlWorkspace);
      }
    }
    return '';
  }
  public findInPage(text: string, forward = true, findNext = false): void {
    this.getDevToolsHost().findInPage(text, forward, findNext);
  }

  public stopFindInPage(): void {
    this.getDevToolsHost().stopFindInPage();
  }

  public async captureScreenshot(rect?: Rectangle, tabId?: string, paneId?: SplitPaneId, options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }): Promise<string> {
    return this.getDevToolsHost().captureScreenshot(rect, tabId, paneId, options);
  }

  public async getDom(selector?: string, tabId?: string, paneId?: SplitPaneId): Promise<string> {
    return this.getDevToolsHost().getDom(selector, tabId, paneId);
  }

  public async evalJs(expression: string, tabId?: string, paneId?: SplitPaneId): Promise<unknown> {
    return this.getDevToolsHost().evalJs(expression, tabId, paneId);
  }

  public async uploadFileInput(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: SplitPaneId }): Promise<{ success: boolean; uploadedCount: number; reason?: string }> {
    return this.getAutomationHost().uploadFileInput(params.refOrSelector, params.filePaths, params.tabId, params.paneId);
  }

  public async dropFiles(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: SplitPaneId }): Promise<{ success: boolean; droppedCount: number; reason?: string }> {
    return this.getAutomationHost().dropFiles(params.refOrSelector, params.filePaths, params.tabId, params.paneId);
  }
  public async executeActionSequence(params: ActionSequenceParams): Promise<ActionSequenceResult> {
    return this.getAutomationHost().executeActionSequence(params);
  }

  private getTabsStoragePath(): string {
    const userData = app ? app.getPath('userData') : StorageLocations.getConfigDir();
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
            const activeCapsule = this.capsuleManager.getActive();
            const partition = deriveCapsulePartition(activeCapsule?.id);
            const targetSession = session.fromPartition(partition);
            ChromeProfileSyncManager.getInstance().syncProfile(data.activeChromeProfileId, targetSession).catch(() => {});
          }
          if (Array.isArray(data.bookmarks) && data.bookmarks.length > 0) {
            this.bookmarks = data.bookmarks;
          }
          if (Array.isArray(data.tabs) && data.tabs.length > 0) {
            let restoredActiveId = data.activeTabId;
            for (const rawTab of data.tabs) {
              const migrated = migratePersistedTab(rawTab);
              const safeUrl = cleanRestoredUrl(migrated.url || 'about:blank');
              const id = this.createTab(safeUrl, false, {
                capsuleId: migrated.capsuleId,
                userAgentMode: migrated.userAgentMode,
              });
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
    this.getDevToolsHost().injectAutoJsonViewer(wc);
  }

  public renderPageSourceSkeletonHtml(): string {
    return this.getDevToolsHost().renderPageSourceSkeletonHtml();
  }

  public async fetchAndLoadPageSource(
    wc: Electron.WebContents,
    targetUrl: string,
    tabState?: AntiFanTab,
    preloadedHtml?: string
  ): Promise<void> {
    return this.getDevToolsHost().fetchAndLoadPageSource(wc, targetUrl, tabState, preloadedHtml);
  }

  public async viewPageSource(tabId?: string): Promise<string> {
    return this.getDevToolsHost().viewPageSource(tabId);
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
      bookmarks: this.bookmarks,
      devicePresets: DEVICE_PRESETS,
      activeChromeProfile: ChromeProfileSyncManager.getInstance().getActiveProfile(),
      chromeProfiles: ChromeProfileSyncManager.getInstance().getAvailableProfiles(),
      themeQa: this.getThemeQaState(this.activeTabId),
    };
    safeSendWebContents(this.toolbarView?.webContents, TOOLBAR_CHANNELS.STATE_UPDATED, payload);
    this.schedulePersist();
  }

  public setControlPlane(cp: ControlPlaneRuntime): void {
    this.controlPlane = cp;
  }
  public getThemeQaState(tabId?: string): { status: 'idle' | 'running' | 'pass' | 'fail' | 'error'; issueCount: number; reportArtifactId?: string; report?: unknown; error?: string; updatedAt: number } {
    const id = tabId || this.activeTabId;
    return this.tabThemeQaStates?.get(id) || { status: 'idle', issueCount: 0, updatedAt: Date.now() };
  }

  private async runThemeQa(options?: { workspaceRoot?: string }): Promise<{ ok: boolean; report?: unknown; error?: string }> {
    if (!this.controlPlane) {
      const error = 'Control plane runtime is not initialized';
      this.tabThemeQaStates?.set(this.activeTabId, { status: 'error', issueCount: 0, error, updatedAt: Date.now() });
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
      this.tabThemeQaStates?.set(this.activeTabId, { status: 'error', issueCount: 0, error, updatedAt: Date.now() });
      this.broadcastState();
      return { ok: false, error };
    }
    const workspaceRoot = options?.workspaceRoot || this.capsuleManager.getActive()?.workspacePath || this.controlPlane.getWorkspaceRoot();
    const tabId = target.tabId;
    this.tabThemeQaStates?.set(tabId, { status: 'running', issueCount: 0, updatedAt: Date.now() });
    if (tabId === this.activeTabId) {
      this.broadcastState();
    }
    return new Promise((resolve) => {
      const gen = this.getDocumentGeneration(tabId);
      this.asyncQaQueue.enqueue(tabId, gen, async (signal: AbortSignal) => {
        try {
          const report = await this.controlPlane!.validateThemeQa(target, { workspaceRoot, signal });
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
          this.tabThemeQaStates?.set(tabId, { status, issueCount, reportArtifactId, report, updatedAt: Date.now() });
          if (tabId === this.activeTabId) {
            this.broadcastState();
          }
          resolve({ ok: true, report });
        } catch (error) {
          if (signal.aborted) {
            resolve({ ok: false, error: 'Theme QA was aborted by document navigation' });
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          this.tabThemeQaStates?.set(tabId, { status: 'error', issueCount: 0, error: message, updatedAt: Date.now() });
          if (tabId === this.activeTabId) {
            this.broadcastState();
          }
          resolve({ ok: false, error: message });
        }
      });
    });
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

  public async agentTrajectory(params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<Record<string, unknown>> {
    return this.getAutomationHost().agentTrajectory(params);
  }

  public async agentMove(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    return this.getAutomationHost().agentMove(args);
  }

  public async cancelActiveAgentAction(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    return this.getAutomationHost().agentClear(tabId, paneId);
  }

  public async agentSnapshot(tabId?: string, paneId?: SplitPaneId, selector?: string, viewportOnly?: boolean): Promise<string> {
    return this.getAutomationHost().agentSnapshot(tabId, paneId, selector, viewportOnly);
  }
  public async agentFind(params: { text?: string; regex?: string; tabId?: string; paneId?: SplitPaneId; maxMatches?: number }): Promise<unknown> {
    return this.getAutomationHost().agentFind(params);
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
        this.syncWithAgentInput(() => {
          tab.view.webContents.sendInputEvent(evt);
        });
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
    if (typeof target.runtimeId !== 'string' || target.runtimeId !== lease.runtimeId) return false;
    // Fast-path equality OR dynamic registry membership check
    let projectMatches = target.projectId === lease.projectId;
    if (!projectMatches) {
      try {
        projectMatches = Boolean(this.controlPlane.workspaces.get(target.workspaceId, target.projectId));
      } catch {
        projectMatches = false;
      }
    }
    if (!projectMatches) return false;

    if (lease.workspaceId && target.workspaceId !== lease.workspaceId) {
      try {
        const ws = this.controlPlane.workspaces.get(target.workspaceId, target.projectId);
        if (!ws) return false;
      } catch {
        return false;
      }
    }
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
    let standaloneHtml = path.join(__dirname, '..', '..', 'renderer', 'standalone.html');
    if (!fs.existsSync(standaloneHtml)) {
      standaloneHtml = path.join(process.cwd(), 'src', 'renderer', 'standalone.html');
    }

    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') {
        event.preventDefault();
        win.setFullScreen(!win.isFullScreen());
      }
    });

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
    this.flushAllSessions().catch(() => {});
    this.isDisposed = true;
    this.automationHost?.dispose();
    this.asyncQaQueue?.abortAll();
    this.semanticRefRegistry?.destroy();
    this.targetOperationQueues?.clear();
    this.semanticDocumentGenerations?.clear();
    this.sessionTabPools?.clear();
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
    if (this.sidebarView) {
      try {
        this.window.contentView.removeChildView(this.sidebarView);
      } catch {}
      try {
        if (!this.sidebarView.webContents.isDestroyed()) {
          (this.sidebarView.webContents as any).destroy?.();
        }
      } catch {}
      this.sidebarView = null;
    }
    if (this.devToolsHost) {
      this.devToolsHost.dispose();
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
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
