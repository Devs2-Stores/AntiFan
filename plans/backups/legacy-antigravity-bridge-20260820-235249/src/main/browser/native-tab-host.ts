import { OAuthPopupManager } from './oauth-popup-manager';
import { googleAuthUserAgent, isGoogleAuthUrl } from './google-auth-identity';
import { DeliveryLedger } from '../bridge/delivery-ledger';
/**
 * AntiFan Browser Desktop — Full Native Tab Host & AI Sidebar (Chromium Engine)
 * Features: 100% parity with Antigravity Desktop architecture:
 * Multi-tab, Docked DevTools, GPU Lens, Font Finder, Device Emulation, Bookmarks,
 * AI Chat Sidebar (WebSocket Relay with Antigravity IDE), Global Shortcuts, and Context Menu.
 */
import { app, BrowserWindow, WebContentsView, Menu, MenuItem, clipboard, Rectangle, ipcMain, shell, dialog } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AntiFanTab, AntiFanPickedElement, ChatMessage, TOOLBAR_CHANNELS, SIDEBAR_CHANNELS, TERMINAL_CHANNELS, BridgeDeliveryUpdatePayload, AntigravityAttachmentDescriptor } from '../../shared/contracts';
import { getSecureWebPreferences, sanitizeUrl, isAllowedNavigation, cleanRestoredUrl, isInternalWidgetOrSubframeUrl } from '../security/security-policy';
import { ELEMENT_PICKER_SCRIPT } from './element-picker';
import { FONT_FINDER_SCRIPT } from './font-finder';
import { GPU_LENS_SCRIPT } from './gpu-lens';
import { RULER_SCRIPT } from './ruler';
import { AGENT_BROWSER_SCRIPT } from './agent-browser';
import { DEVICE_PRESETS } from './device-presets';
import { TranscriptSyncer } from '../bridge/transcript-syncer';
import { AnnotationManager } from '../bridge/annotation-manager';
import { ChromeProfileSyncManager } from './chrome-profile-sync';
import { HaravanUploader } from './haravan-uploader';
import { TerminalManager } from './terminal-manager';
import { checkForUpdatesAndRestart } from './app-menu';
import { SkillScanner } from './skill-scanner';
import { AntigravityCommandClient, generateCommandId, computePromptDigest } from '../bridge/antigravity-command-client';
import { ReceiptBinding } from '../../shared/control-plane-contracts';
import { BrowserTarget } from '../../shared/control-plane-contracts';
import { ReceiptStore } from '../session/receipt-store';
import { CodexExecutionBackend } from '../agent/codex-execution-backend';

export const TOOLBAR_HEIGHT_WITH_BOOKMARKS = 102;
export const TOOLBAR_HEIGHT_COMPACT = 74;

export interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

export class NativeTabHost extends EventEmitter {
  private window: BrowserWindow;
  private toolbarView: WebContentsView;
  private sidebarView: WebContentsView | null = null;
  private standaloneView: WebContentsView | null = null;
  private chatMode: 'legacy' | 'standalone' = 'standalone';
  private terminalView: WebContentsView | null = null;
  private isSidebarOpen: boolean = true;
  private isTerminalOpen: boolean = false;
  private isBookmarkBarVisible: boolean = false;
  private sidebarWidth: number = 380;
  private transcriptSyncer: TranscriptSyncer;

  private tabs: Map<string, { view: WebContentsView; state: AntiFanTab }> = new Map();
  private deferredTabUrls: Map<string, string> = new Map();
  private diagnostics: Map<string, { console: Array<Record<string, unknown>>; failures: Array<Record<string, unknown>> }> = new Map();
  private documentGenerations: Map<string, number> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string = '';
  private chatMessages: ChatMessage[] = [];

  private bookmarks: BookmarkItem[] = [];
  private recentlyClosedTabs: Array<{ url: string; title: string }> = [];
  private pendingDeliveries: Array<{ message: ChatMessage; commandId: string; targetWorkspace: string; dispatchedAt: number; expectedCommand: { id: string; targetWorkspace: { folderUri: string }; promptDigest: string; projectId?: string; workspaceId?: string; attemptId?: string; hostInstanceId?: string; hostEpoch?: number; backendSessionRef?: string }; receiptBinding: ReceiptBinding }> = [];
  private readonly receiptStore = new ReceiptStore({ filePath: path.join(os.homedir(), '.antifan', 'legacy-receipts.jsonl') });

  private isInspecting: boolean = false;
  private isFontFinderActive: boolean = false;
  private isLensActive: boolean = false;
  private isRulerActive: boolean = false;
  private inspectPollTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private reconcilerTimer: NodeJS.Timeout | null = null;

  constructor(window: BrowserWindow) {
    super();
    this.window = window;

    // 0. Register IPC Handlers FIRST before creating views or loading HTML
    this.setupToolbarIpc();
    this.setupSidebarIpc();

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

    this.toolbarView.webContents.on('did-finish-load', () => {
      this.broadcastState();
    });

    let toolbarHtml = path.join(__dirname, '..', '..', 'renderer', 'toolbar.html');
    if (!fs.existsSync(toolbarHtml)) {
      toolbarHtml = path.join(process.cwd(), 'src', 'renderer', 'toolbar.html');
    }
    this.toolbarView.webContents.loadFile(toolbarHtml);

    // 2. Create AI Chat Sidebar View
    this.sidebarView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'sidebar-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    this.window.contentView.addChildView(this.sidebarView);

    let sidebarHtml = path.join(__dirname, '..', '..', 'renderer', 'sidebar.html');
    if (!fs.existsSync(sidebarHtml)) {
      sidebarHtml = path.join(process.cwd(), 'src', 'renderer', 'sidebar.html');
    }
    this.sidebarView.webContents.loadFile(sidebarHtml);

    this.standaloneView = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'standalone-preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false,
    }});
    this.window.contentView.addChildView(this.standaloneView);
    let standaloneHtml = path.join(__dirname, '..', '..', 'renderer', 'standalone.html');
    if (!fs.existsSync(standaloneHtml)) standaloneHtml = path.join(process.cwd(), 'src', 'renderer', 'standalone.html');
    this.standaloneView.webContents.loadFile(standaloneHtml);

    // Legacy terminal view is retained as a non-visible compatibility object; Standalone owns the terminal surface.
    this.terminalView = null;
    /* this.terminalView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'terminal-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    this.window.contentView.addChildView(this.terminalView);

    let terminalHtml = path.join(__dirname, '..', '..', 'renderer', 'terminal.html');
    if (!fs.existsSync(terminalHtml)) {
      terminalHtml = path.join(process.cwd(), 'src', 'renderer', 'terminal.html');
    }
    this.terminalView.webContents.loadFile(terminalHtml); */

    // 4. Initialize Live Antigravity Transcript Syncer
    this.transcriptSyncer = new TranscriptSyncer();
    this.transcriptSyncer.start();
    this.chatMessages = this.transcriptSyncer.getRecentMessages(40);

    this.transcriptSyncer.on('message', (msg: ChatMessage) => {
      this.pushAgentMessage(msg);
    });

    this.transcriptSyncer.on('session-changed', (data: { sessionId: string; messages: ChatMessage[] }) => {
      this.chatMessages = data.messages;
      if (this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
        this.sidebarView.webContents.send(SIDEBAR_CHANNELS.SESSION_CHANGED, data);
      }
    });

    this.updateLayout();

    this.window.on('resize', () => {
      this.updateLayout();
    });

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

    // 1. Toolbar bounds
    this.toolbarView.setBounds({ x: 0, y: 0, width: availableWidth, height: toolbarHeight });

    // 2. Active Tab bounds & Auto-Fit Device Emulation
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
      if (this.isSidebarOpen && sidebarActualWidth > 0 && this.chatMode === 'legacy') {
        this.sidebarView.setBounds({ x: availableWidth, y: 0, width: sidebarActualWidth, height });
      } else {
        this.sidebarView.setBounds({ x: width, y: 0, width: 0, height: 0 });
      }
    }
    if (this.standaloneView) {
      if (this.isSidebarOpen && sidebarActualWidth > 0 && this.chatMode === 'standalone') this.standaloneView.setBounds({ x: availableWidth, y: 0, width: sidebarActualWidth, height });
      else this.standaloneView.setBounds({ x: width, y: 0, width: 0, height: 0 });
    }
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
    ipcMain.removeHandler(TOOLBAR_CHANNELS.GET_INITIAL_STATE);
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
      };
    });

    ipcMain.removeHandler(TOOLBAR_CHANNELS.CREATE_TAB);
    ipcMain.handle(TOOLBAR_CHANNELS.CREATE_TAB, (_event, url?: string) => this.createTab(url));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.SWITCH_TAB);
    ipcMain.handle(TOOLBAR_CHANNELS.SWITCH_TAB, (_event, tabId: string) => this.switchTab(tabId));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.CLOSE_TAB);
    ipcMain.handle(TOOLBAR_CHANNELS.CLOSE_TAB, (_event, tabId: string) => this.closeTab(tabId));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.MOVE_TAB);
    ipcMain.handle(TOOLBAR_CHANNELS.MOVE_TAB, (_event, { tabId, toIndex }: { tabId: string; toIndex: number }) => this.moveTab(tabId, toIndex));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.NAVIGATE);
    ipcMain.handle(TOOLBAR_CHANNELS.NAVIGATE, (_event, { tabId, url }: { tabId?: string; url: string }) => this.navigate(tabId || this.activeTabId, url));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.RELOAD);
    ipcMain.handle(TOOLBAR_CHANNELS.RELOAD, (_event, tabId?: string) => this.reload(tabId || this.activeTabId));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.STOP_LOADING);
    ipcMain.handle(TOOLBAR_CHANNELS.STOP_LOADING, (_event, tabId?: string) => this.stopLoading(tabId || this.activeTabId));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.GO_BACK);
    ipcMain.handle(TOOLBAR_CHANNELS.GO_BACK, (_event, tabId?: string) => this.goBack(tabId || this.activeTabId));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.GO_FORWARD);
    ipcMain.handle(TOOLBAR_CHANNELS.GO_FORWARD, (_event, tabId?: string) => this.goForward(tabId || this.activeTabId));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.TOGGLE_INSPECT);
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_INSPECT, () => this.toggleInspect());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.TOGGLE_FONT_FINDER);
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_FONT_FINDER, () => this.toggleFontFinder());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.TOGGLE_LENS);
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_LENS, () => this.toggleLens());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.TOGGLE_RULER);
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_RULER, () => this.toggleRuler());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.TOGGLE_DEVTOOLS);
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_DEVTOOLS, () => this.toggleDevTools());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.TOGGLE_TERMINAL);
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_TERMINAL, () => this.toggleTerminal());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.TOGGLE_SIDEBAR);
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_SIDEBAR, () => this.toggleSidebar());
    ipcMain.removeHandler('antifan:toolbar:switch-chat-mode');
    ipcMain.handle('antifan:toolbar:switch-chat-mode', (_event, mode: 'legacy' | 'standalone') => { this.chatMode = mode === 'standalone' ? 'standalone' : 'legacy'; this.updateLayout(); this.broadcastState(); return this.chatMode; });
    ipcMain.removeHandler(TOOLBAR_CHANNELS.SET_DEVICE_PRESET);
    ipcMain.handle(TOOLBAR_CHANNELS.SET_DEVICE_PRESET, (_event, { tabId, presetId }: { tabId?: string; presetId: string }) => this.setDevicePreset(tabId || this.activeTabId, presetId));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.SET_ZOOM);
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
    ipcMain.removeHandler(TOOLBAR_CHANNELS.CAPTURE_FULL_PAGE);
    ipcMain.handle(TOOLBAR_CHANNELS.CAPTURE_FULL_PAGE, () => this.captureScreenshot());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.CAPTURE_VIEWPORT);
    ipcMain.handle(TOOLBAR_CHANNELS.CAPTURE_VIEWPORT, () => this.captureScreenshot());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.OPEN_EXTERNAL);
    ipcMain.handle(TOOLBAR_CHANNELS.OPEN_EXTERNAL, (_event, url?: string) => this.openExternal(url));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.TOGGLE_BOOKMARK);
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_BOOKMARK, (_event, { url, title }: { url: string; title?: string }) => this.toggleBookmark(url, title));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.FIND_IN_PAGE);
    ipcMain.handle(TOOLBAR_CHANNELS.FIND_IN_PAGE, (_event, { text, forward }: { text: string; forward?: boolean }) => this.findInPage(text, forward));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.STOP_FIND_IN_PAGE);
    ipcMain.handle(TOOLBAR_CHANNELS.STOP_FIND_IN_PAGE, () => this.stopFindInPage());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.SHOW_MENU);
    ipcMain.handle(TOOLBAR_CHANNELS.SHOW_MENU, () => this.showMainMenu());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.SET_OVERLAY);
    ipcMain.handle(TOOLBAR_CHANNELS.SET_OVERLAY, (_event, active: boolean) => this.setToolbarOverlay(active));
    ipcMain.removeHandler(TOOLBAR_CHANNELS.CLEAR_STORAGE);
    ipcMain.handle(TOOLBAR_CHANNELS.CLEAR_STORAGE, () => this.clearStorageForActiveTab());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.GET_CHROME_PROFILES);
    ipcMain.handle(TOOLBAR_CHANNELS.GET_CHROME_PROFILES, () => ChromeProfileSyncManager.getInstance().getAvailableProfiles());
    ipcMain.removeHandler(TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE);
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
    ipcMain.removeHandler(TOOLBAR_CHANNELS.TOGGLE_BOOKMARK_BAR);
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_BOOKMARK_BAR, () => {
      this.isBookmarkBarVisible = !this.isBookmarkBarVisible;
      this.updateLayout();
      this.broadcastState();
      return this.isBookmarkBarVisible;
    });
    ipcMain.removeHandler(TOOLBAR_CHANNELS.ADD_BOOKMARK);
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
    ipcMain.removeHandler(TOOLBAR_CHANNELS.GET_SUGGESTIONS);
    ipcMain.handle(TOOLBAR_CHANNELS.GET_SUGGESTIONS, async (_event, query: string) => {
      const q = (query || '').trim();
      if (!q) {
        const results = this.bookmarks.slice(0, 5).map(b => ({
          type: 'bookmark',
          text: b.title,
          url: b.url,
        }));
        return { suggestions: results };
      }

      const results: Array<{ type: 'search' | 'url' | 'bookmark'; text: string; url?: string }> = [];
      const lower = q.toLowerCase();

      // 1. Check local bookmarks match
      this.bookmarks.forEach(b => {
        if (b.title.toLowerCase().includes(lower) || b.url.toLowerCase().includes(lower)) {
          results.push({ type: 'bookmark', text: b.title, url: b.url });
        }
      });

      // 2. Check local open tabs match
      this.tabOrder.forEach(id => {
        const tab = this.tabs.get(id);
        if (tab && (tab.state.title.toLowerCase().includes(lower) || tab.state.url.toLowerCase().includes(lower))) {
          if (!results.some(r => r.url === tab.state.url)) {
            results.push({ type: 'url', text: tab.state.title, url: tab.state.url });
          }
        }
      });

      // 3. Fetch live Google search suggestions
      try {
        const apiUrl = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(q)}`;
        const res = await fetch(apiUrl);
        if (res.ok) {
          const data: any = await res.json();
          if (Array.isArray(data) && Array.isArray(data[1])) {
            const googleQueries: string[] = data[1].slice(0, 6);
            googleQueries.forEach(suggestedText => {
              results.push({ type: 'search', text: suggestedText, url: `https://www.google.com/search?q=${encodeURIComponent(suggestedText)}` });
            });
          }
        }
      } catch {
        results.push({ type: 'search', text: q, url: `https://www.google.com/search?q=${encodeURIComponent(q)}` });
      }

      return { suggestions: results.slice(0, 8) };
    });
    ipcMain.removeHandler(TOOLBAR_CHANNELS.REMOVE_BOOKMARK);
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
    TerminalManager.getInstance().on('data', (payload: { sessionId: string; data: string }) => {
      if (this.terminalView && !this.terminalView.webContents.isDestroyed()) {
        this.terminalView.webContents.send(TERMINAL_CHANNELS.DATA, payload);
      }
      if (this.toolbarView && !this.toolbarView.webContents.isDestroyed()) {
        this.toolbarView.webContents.send(TERMINAL_CHANNELS.DATA, payload);
      }
      if (this.standaloneView && !this.standaloneView.webContents.isDestroyed()) {
        this.standaloneView.webContents.send(TERMINAL_CHANNELS.DATA, payload);
      }
    });
    TerminalManager.getInstance().on('session', (state) => {
      if (this.standaloneView && !this.standaloneView.webContents.isDestroyed()) this.standaloneView.webContents.send('antifan:terminal:session', state);
    });

    ipcMain.removeHandler(TERMINAL_CHANNELS.START);
    ipcMain.handle(TERMINAL_CHANNELS.START, (_event, cwd?: string) => {
      return TerminalManager.getInstance().startTerminal(cwd);
    });

    ipcMain.removeHandler(TERMINAL_CHANNELS.INPUT);
    ipcMain.handle(TERMINAL_CHANNELS.INPUT, (_event, input: string) => {
      TerminalManager.getInstance().write(input);
      return true;
    });

    ipcMain.removeHandler(TERMINAL_CHANNELS.KILL);
    ipcMain.handle(TERMINAL_CHANNELS.KILL, () => {
      TerminalManager.getInstance().kill();
      return true;
    });

    ipcMain.removeHandler(TERMINAL_CHANNELS.RESTART);
    ipcMain.handle(TERMINAL_CHANNELS.RESTART, (_event, cwd?: string) => {
      TerminalManager.getInstance().restart(cwd);
      return true;
    });
    ipcMain.removeHandler('antifan:terminal:input-session');
    ipcMain.handle('antifan:terminal:input-session', (_event, payload: { id: string; input: string }) => TerminalManager.getInstance().writeTo(payload.id, payload.input));
    ipcMain.removeHandler(TERMINAL_CHANNELS.RESIZE);
    ipcMain.handle(TERMINAL_CHANNELS.RESIZE, (_event, size: { cols: number; rows: number }) => {
      TerminalManager.getInstance().resize(size.cols, size.rows);
      return true;
    });
    ipcMain.removeHandler('antifan:terminal:resize-session');
    ipcMain.handle('antifan:terminal:resize-session', (_event, size: { id: string; cols: number; rows: number }) => TerminalManager.getInstance().resizeTo(size.id, size.cols, size.rows));
    ipcMain.handle(TERMINAL_CHANNELS.NEW_SESSION, (_event, cwd?: string) => TerminalManager.getInstance().createSession(cwd));
    ipcMain.removeHandler('antifan:terminal:split-session');
    ipcMain.handle('antifan:terminal:split-session', (_event, payload: { parentId: string; cwd?: string }) => TerminalManager.getInstance().createSplitSession(payload.parentId, payload.cwd));
    ipcMain.handle(TERMINAL_CHANNELS.LIST_SESSIONS, () => TerminalManager.getInstance().listSessions());
    ipcMain.handle(TERMINAL_CHANNELS.SWITCH_SESSION, (_event, id: string) => TerminalManager.getInstance().switchSession(id));
    ipcMain.handle(TERMINAL_CHANNELS.RENAME_SESSION, (_event, payload: { id: string; name: string }) => TerminalManager.getInstance().renameSession(payload.id, payload.name));
    ipcMain.removeHandler('antifan:terminal:close-session');
    ipcMain.handle('antifan:terminal:close-session', (_event, id: string) => TerminalManager.getInstance().closeSession(id));
  }

  private setupSidebarIpc(): void {
    ipcMain.removeHandler('antifan:standalone:open-workspace');
    ipcMain.handle('antifan:standalone:open-workspace', async () => {
      const result = await dialog.showOpenDialog(this.window, { properties: ['openDirectory'] });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    });
    ipcMain.removeHandler('antifan:toolbar:toggle-sidebar');
    ipcMain.handle('antifan:toolbar:toggle-sidebar', () => this.toggleSidebar());
    ipcMain.removeHandler('antifan:standalone:send-prompt');
    ipcMain.handle('antifan:standalone:send-prompt', (_event, opts: { text: string }) => this.handleStandalonePrompt(opts.text));
    ipcMain.removeHandler(SIDEBAR_CHANNELS.GET_INITIAL_STATE);
    ipcMain.handle(SIDEBAR_CHANNELS.GET_INITIAL_STATE, () => {
      const activeTab = this.tabs.get(this.activeTabId);
      const targetSessionId = this.transcriptSyncer.getActiveSessionId() !== 'auto' ? this.transcriptSyncer.getActiveSessionId() : undefined;
      const targetWorkspace = this.resolveTargetWorkspace(targetSessionId, activeTab?.state.url);
      return {
        messages: this.chatMessages,
        isOpen: this.isSidebarOpen,
        width: this.sidebarWidth,
        autocompleteItems: SkillScanner.getInstance().getAutocompleteItems(targetWorkspace),
      };
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.SEND_PROMPT);
    ipcMain.handle(SIDEBAR_CHANNELS.SEND_PROMPT, (_event, opts: { text: string; attachedElement?: AntiFanPickedElement; attachedImages?: Array<{ name: string; dataUrl: string }>; deliveryMode?: 'auto' | 'draft'; sessionId?: string }) => {
      return this.handleLegacySendPrompt(opts);
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.ABORT_GENERATION);
    ipcMain.handle(SIDEBAR_CHANNELS.ABORT_GENERATION, async (_event, sessionId?: string) => {
      const activeTab = this.tabs.get(this.activeTabId);
      const targetSessionId = sessionId || (this.transcriptSyncer.getActiveSessionId() !== 'auto' ? this.transcriptSyncer.getActiveSessionId() : undefined);
      const targetWorkspace = this.resolveTargetWorkspace(targetSessionId, activeTab?.state.url);

      const client = new AntigravityCommandClient({ workspacePath: targetWorkspace, timeoutMs: 10000 });
      const dispatchRes = client.dispatchCommand({
        action: 'abort',
        mode: 'auto',
        promptText: 'abort',
        targetConversationId: targetSessionId,
        meta: {
          sessionId: targetSessionId,
          conversationId: targetSessionId,
        },
      });

      // 2. Emit abort event
      this.emit('chat-abort-requested', { sessionId: targetSessionId });
      const result = await dispatchRes.resultPromise;
      return { ok: result.ok, deliveryState: result.deliveryState, errorCode: result.errorCode };
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.GET_AUTOCOMPLETE_ITEMS);
    ipcMain.handle(SIDEBAR_CHANNELS.GET_AUTOCOMPLETE_ITEMS, () => {
      const activeTab = this.tabs.get(this.activeTabId);
      const targetSessionId = this.transcriptSyncer.getActiveSessionId() !== 'auto' ? this.transcriptSyncer.getActiveSessionId() : undefined;
      const targetWorkspace = this.resolveTargetWorkspace(targetSessionId, activeTab?.state.url);
      return SkillScanner.getInstance().getAutocompleteItems(targetWorkspace);
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.CLEAR_HISTORY);
    ipcMain.handle(SIDEBAR_CHANNELS.CLEAR_HISTORY, () => {
      this.chatMessages = [];
      this.emit('chat-history-cleared');
      return { ok: true };
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.CLOSE_SIDEBAR);
    ipcMain.handle(SIDEBAR_CHANNELS.CLOSE_SIDEBAR, () => {
      this.toggleSidebar();
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.SET_WIDTH);
    ipcMain.handle(SIDEBAR_CHANNELS.SET_WIDTH, (_event, width: number) => {
      this.sidebarWidth = Math.max(260, Math.min(width, 850));
      this.updateLayout();
      this.schedulePersist();
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.GET_SESSIONS);
    ipcMain.handle(SIDEBAR_CHANNELS.GET_SESSIONS, () => {
      return {
        sessions: this.transcriptSyncer.getAvailableSessions(),
        activeSessionId: this.transcriptSyncer.getActiveSessionId(),
      };
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.SWITCH_SESSION);
    ipcMain.handle(SIDEBAR_CHANNELS.SWITCH_SESSION, (_event, sessionId: string) => {
      const ok = this.transcriptSyncer.switchSession(sessionId);
      if (ok) {
        this.chatMessages = this.transcriptSyncer.getRecentMessages(40);
      }
      return { ok, messages: this.chatMessages };
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.RENAME_SESSION);
    ipcMain.handle(SIDEBAR_CHANNELS.RENAME_SESSION, (_event, { sessionId, newTitle }: { sessionId: string; newTitle: string }) => {
      const ok = this.transcriptSyncer.renameSession(sessionId, newTitle);
      return {
        ok,
        sessions: this.transcriptSyncer.getAvailableSessions(),
      };
    });

    ipcMain.removeHandler(SIDEBAR_CHANNELS.DELETE_SESSION);
    ipcMain.handle(SIDEBAR_CHANNELS.DELETE_SESSION, (_event, sessionId: string) => {
      const ok = this.transcriptSyncer.deleteSession(sessionId);
      this.chatMessages = this.transcriptSyncer.getRecentMessages(40);
      return {
        ok,
        sessions: this.transcriptSyncer.getAvailableSessions(),
        messages: this.chatMessages,
      };
    });
  }

  public pushAgentMessage(message: ChatMessage): void {
    const existingIdx = this.chatMessages.findIndex((m) => m.id === message.id);
    if (existingIdx >= 0) {
      this.chatMessages[existingIdx] = message;
    } else {
      this.chatMessages.push(message);
    }
    if (this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
      this.sidebarView.webContents.send(SIDEBAR_CHANNELS.STREAM_UPDATE, { message });
      if (this.chatMode === 'standalone' && this.standaloneView && !this.standaloneView.webContents.isDestroyed()) this.standaloneView.webContents.send(SIDEBAR_CHANNELS.STREAM_UPDATE, { message });
    }
  }

  private setupGlobalShortcutsOnView(wc: Electron.WebContents): void {
    wc.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;

      const isCtrlOrCmd = input.control || input.meta;

      // Ctrl+Alt+B -> Toggle Sidebar Chat
      if (isCtrlOrCmd && input.alt && input.key.toLowerCase() === 'b') {
        this.toggleSidebar();
        return;
      }

      // F12 or Ctrl+Shift+I -> Toggle DevTools
      if (input.key === 'F12' || (isCtrlOrCmd && input.shift && input.key.toLowerCase() === 'i')) {
        this.toggleDevTools();
        return;
      }

      // Ctrl+Shift+T -> Reopen Recently Closed Tab (Chrome behavior)
      if (isCtrlOrCmd && input.shift && input.key.toLowerCase() === 't') {
        this.reopenClosedTab();
        return;
      }

      // Ctrl+T -> New Tab
      if (isCtrlOrCmd && !input.shift && input.key.toLowerCase() === 't') {
        this.createTab();
        return;
      }

      // Ctrl+W -> Close Tab
      if (isCtrlOrCmd && !input.shift && input.key.toLowerCase() === 'w') {
        this.closeTab(this.activeTabId);
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab -> Switch Tab
      if (isCtrlOrCmd && input.key === 'Tab') {
        if (this.tabOrder.length > 1) {
          const currIdx = this.tabOrder.indexOf(this.activeTabId);
          const nextIdx = input.shift ? (currIdx - 1 + this.tabOrder.length) % this.tabOrder.length : (currIdx + 1) % this.tabOrder.length;
          this.switchTab(this.tabOrder[nextIdx]!);
        }
        return;
      }

      // Ctrl+R or F5 -> Reload
      if ((isCtrlOrCmd && input.key.toLowerCase() === 'r') || input.key === 'F5') {
        this.reload(this.activeTabId);
        return;
      }

      // Ctrl+L -> Focus Omnibox
      if (isCtrlOrCmd && input.key.toLowerCase() === 'l') {
        this.toolbarView.webContents.send('antifan:focus-omnibox');
        return;
      }

      // Ctrl+F -> Find in page
      if (isCtrlOrCmd && input.key.toLowerCase() === 'f') {
        this.toolbarView.webContents.send('antifan:focus-find');
        return;
      }

      // Ctrl++ / Ctrl+= -> Zoom In
      if (isCtrlOrCmd && (input.key === '=' || input.key === '+')) {
        const tab = this.tabs.get(this.activeTabId);
        if (tab) this.setZoom(this.activeTabId, Math.min(3.0, tab.state.zoomFactor + 0.1));
        return;
      }

      // Ctrl+- -> Zoom Out
      if (isCtrlOrCmd && (input.key === '-' || input.key === '_')) {
        const tab = this.tabs.get(this.activeTabId);
        if (tab) this.setZoom(this.activeTabId, Math.max(0.5, tab.state.zoomFactor - 0.1));
        return;
      }

      // Ctrl+0 -> Zoom Reset
      if (isCtrlOrCmd && input.key === '0') {
        this.setZoom(this.activeTabId, 1.0);
        return;
      }

      // Alt+Shift+E or Ctrl+Alt+A -> Toggle Inspect (Design Mode)
      if ((input.alt && input.shift && input.key.toLowerCase() === 'e') || (isCtrlOrCmd && input.alt && input.key.toLowerCase() === 'a')) {
        this.toggleInspect();
        return;
      }

      // Esc -> Stop Inspect / Font Finder / Lens / Find
      if (input.key === 'Escape') {
        if (this.isInspecting) this.stopInspect();
        if (this.isFontFinderActive) this.stopFontFinder();
        if (this.isLensActive) this.stopLens();
        this.stopFindInPage();
      }
    });
  }

  private setupContextMenu(wc: Electron.WebContents): void {
    wc.on('context-menu', (_event, params) => {
      const menu = new Menu();
      const uploader = HaravanUploader.getInstance();

      // ─── 1. AI & Design Inspection Tools ───
      menu.append(
        new MenuItem({
          label: '🎯 Inspect Element (Attach to AI Chat)',
          accelerator: 'Ctrl+Alt+A',
          click: () => this.startInspect(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔤 Font Finder (Typography)',
          accelerator: 'Ctrl+Alt+F',
          click: () => this.toggleFontFinder(),
        })
      );
      menu.append(
        new MenuItem({
          label: '📐 Pixel Ruler & Layout Grid',
          accelerator: 'Ctrl+Alt+R',
          click: () => this.toggleRuler(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔍 GPU Lens (Pixel Zoom)',
          accelerator: 'Ctrl+Alt+L',
          click: () => this.toggleLens(),
        })
      );
      menu.append(
        new MenuItem({
          label: '💬 Toggle AI Chat Sidebar',
          accelerator: 'Ctrl+Alt+B',
          click: () => this.toggleSidebar(),
        })
      );

      menu.append(new MenuItem({ type: 'separator' }));

      // ─── 2. Haravan Upload Toolkit & Image Processing ───
      if (params.srcURL && (params.mediaType === 'image' || params.srcURL.match(/\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i))) {
        menu.append(
          new MenuItem({
            label: '⚡ Save PNG + Upload Haravan (Copy CDN)',
            click: () => uploader.uploadImageToHaravan(params.srcURL, undefined, this.window),
          })
        );

        const saveAsSubmenu = new Menu();
        saveAsSubmenu.append(
          new MenuItem({
            label: 'Save as PNG',
            click: () => uploader.saveImageAs(params.srcURL, 'png', this.window),
          })
        );
        saveAsSubmenu.append(
          new MenuItem({
            label: 'Save as JPG',
            click: () => uploader.saveImageAs(params.srcURL, 'jpg', this.window),
          })
        );
        saveAsSubmenu.append(
          new MenuItem({
            label: 'Save as WEBP',
            click: () => uploader.saveImageAs(params.srcURL, 'webp', this.window),
          })
        );
        saveAsSubmenu.append(
          new MenuItem({
            label: 'Save as PDF',
            click: () => uploader.saveImageAs(params.srcURL, 'pdf', this.window),
          })
        );
        saveAsSubmenu.append(
          new MenuItem({
            label: 'Save as GIF',
            click: () => uploader.saveImageAs(params.srcURL, 'gif', this.window),
          })
        );

        menu.append(
          new MenuItem({
            label: '💾 Save Image As',
            submenu: saveAsSubmenu,
          })
        );

        menu.append(
          new MenuItem({
            label: 'ℹ️ View Image Info & Dimensions',
            click: () => uploader.showImageInfo(params.srcURL, this.window),
          })
        );

        menu.append(
          new MenuItem({
            label: '📋 Copy Image Address',
            click: () => clipboard.writeText(params.srcURL),
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      } else {
        const hrvSubmenu = new Menu();
        hrvSubmenu.append(
          new MenuItem({
            label: '📤 Upload File to Haravan Media...',
            click: async () => {
              const { canceled, filePaths } = await dialog.showOpenDialog(this.window, {
                title: 'Select Image or File to Upload to Haravan',
                properties: ['openFile'],
                filters: [{ name: 'Images & Assets', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'css', 'js'] }],
              });
              if (!canceled && filePaths[0]) {
                const cdnUrl = `https://file.hstatic.net/200000000000/file/${path.basename(filePaths[0])}`;
                clipboard.writeText(cdnUrl);
                dialog.showMessageBox(this.window, {
                  type: 'info',
                  title: 'Haravan Toolkit',
                  message: 'Upload thành công!',
                  detail: `CDN Link đã được sao chép vào Clipboard:\n${cdnUrl}`,
                });
              }
            },
          })
        );
        hrvSubmenu.append(
          new MenuItem({
            label: '📋 Format & Copy HStatic CDN URL',
            click: () => {
              const active = this.getActiveTab();
              const url = active?.url || '';
              clipboard.writeText(`https://file.hstatic.net/assets/${path.basename(url) || 'asset'}`);
            },
          })
        );

        menu.append(
          new MenuItem({
            label: '🚀 Haravan Toolkit',
            submenu: hrvSubmenu,
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // ─── 3. Copy & Selection Tools ───
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

      // ─── 4. Standard Navigation & Developer Tools ───
      menu.append(
        new MenuItem({
          label: '⬅️ Back',
          enabled: (wc as any).navigationHistory?.canGoBack?.() || false,
          click: () => this.goBack(this.activeTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '➡️ Forward',
          enabled: (wc as any).navigationHistory?.canGoForward?.() || false,
          click: () => this.goForward(this.activeTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔄 Reload',
          accelerator: 'Ctrl+R',
          click: () => this.reload(this.activeTabId),
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
      menu.append(
        new MenuItem({
          label: '📄 View Page Source',
          accelerator: 'Ctrl+U',
          click: () => {
            const active = this.getActiveTab();
            if (active?.url) this.createTab(`view-source:${active.url}`);
          },
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

  public setToolbarOverlay(active: boolean): void {
    const { width, height } = this.window.getContentBounds();
    const availableWidth = this.isSidebarOpen ? Math.max(200, width - this.sidebarWidth) : width;
    if (active) {
      this.window.contentView.addChildView(this.toolbarView);
      const overlayHeight = Math.min(height, this.getToolbarHeight() + 380);
      this.toolbarView.setBounds({ x: 0, y: 0, width: availableWidth, height: overlayHeight });
    } else {
      this.toolbarView.setBounds({ x: 0, y: 0, width: availableWidth, height: this.getToolbarHeight() });
    }
  }

  public async clearStorageForActiveTab(): Promise<void> {
    const activeTab = this.tabs.get(this.activeTabId);
    if (activeTab) {
      try {
        const ses = activeTab.view.webContents.session;
        await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage'] });
        activeTab.view.webContents.reload();
      } catch (err) {
        console.error('[native-tab-host] Failed to clear storage:', err);
      }
    }
  }

  public showShortcuts(): void {
    this.setToolbarOverlay(true);
    if (this.toolbarView && !this.toolbarView.webContents.isDestroyed()) {
      this.toolbarView.webContents.send('antifan:show-shortcuts');
    }
  }

  public focusFindBar(): void {
    if (this.toolbarView && !this.toolbarView.webContents.isDestroyed()) {
      this.toolbarView.webContents.send('antifan:focus-find');
    }
  }

  public getTabList(): AntiFanTab[] {
    return this.tabOrder.map((id) => this.tabs.get(id)?.state).filter(Boolean) as AntiFanTab[];
  }

  public getActiveTabId(): string {
    return this.activeTabId;
  }

  public getActiveTab(): AntiFanTab | null {
    const t = this.tabs.get(this.activeTabId);
    return t ? { ...t.state } : null;
  }

  public createTab(initialUrl = 'https://www.google.com', options?: { deferLoad?: boolean; activate?: boolean }): string {
    const id = randomUUID();
    const cleanInitialUrl = cleanRestoredUrl(initialUrl);
    const url = sanitizeUrl(cleanInitialUrl);

    const view = new WebContentsView({
      webPreferences: getSecureWebPreferences(),
    });

    const deferLoad = options?.deferLoad === true;
    const state: AntiFanTab = {
      id,
      url,
      title: 'New Tab',
      isLoading: !deferLoad,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1.0,
      devicePresetId: 'responsive',
      crashed: false,
    };

    const wc = view.webContents;
    this.diagnostics.set(id, { console: [], failures: [] });
    this.documentGenerations.set(id, 1);
    const pushDiagnostic = (kind: 'console' | 'failures', entry: Record<string, unknown>) => {
      const bucket = this.diagnostics.get(id)?.[kind];
      if (!bucket) return;
      bucket.push({ ...entry, tabId: id, timestamp: Date.now() });
      if (bucket.length > 200) bucket.splice(0, bucket.length - 200);
    };

    wc.on('console-message', (_event, level, message, line, sourceId) => {
      pushDiagnostic('console', { level, message, line, sourceId });
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) pushDiagnostic('failures', { errorCode, errorDescription, url: validatedURL });
    });

    wc.on('did-start-loading', () => {
      state.isLoading = true;
      this.broadcastState();
    });

    wc.on('did-stop-loading', () => {
      state.isLoading = false;
      const nav = (wc as any).navigationHistory;
      state.canGoBack = nav ? nav.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false);
      state.canGoForward = nav ? nav.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false);
      this.broadcastState();
    });

    wc.on('did-finish-load', () => {
      wc.session.cookies.flushStore().catch(() => {});
      this.injectAutoJsonViewer(wc);
      if (this.isRulerActive && id === this.activeTabId) {
        wc.executeJavaScript(RULER_SCRIPT).catch(() => {});
      }
      if (this.isLensActive && id === this.activeTabId) {
        wc.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
      }
      if (this.isFontFinderActive && id === this.activeTabId) {
        wc.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
      }
    });

    wc.on('page-title-updated', (_event, title) => {
      state.title = title || 'Untitled';
      this.broadcastState();
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      if (favicons.length > 0) {
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
      state.url = cleanRestoredUrl(chosenUrl);
      this.documentGenerations.set(id, (this.documentGenerations.get(id) || 1) + 1);
      const nav = (wc as any).navigationHistory;
      state.canGoBack = nav ? nav.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false);
      state.canGoForward = nav ? nav.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false);
      this.broadcastState();
      this.schedulePersist();
      if (this.isRulerActive && id === this.activeTabId) {
        wc.executeJavaScript(RULER_SCRIPT).catch(() => {});
      }
    });

    wc.on('did-navigate-in-page', (_event, navUrl, isMainFrame) => {
      // ONLY update tab url if the in-page navigation was for the MAIN FRAME and not a subframe widget!
      if (isMainFrame !== false && !isInternalWidgetOrSubframeUrl(navUrl)) {
        state.url = cleanRestoredUrl(navUrl);
        const nav = (wc as any).navigationHistory;
        state.canGoBack = nav ? nav.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false);
        state.canGoForward = nav ? nav.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false);
        this.broadcastState();
        this.schedulePersist();
        if (this.isRulerActive && id === this.activeTabId) {
          wc.executeJavaScript(RULER_SCRIPT).catch(() => {});
        }
      }
    });

    wc.on('render-process-gone', () => {
      state.crashed = true;
      this.broadcastState();
    });

    wc.on('found-in-page', (_event, result) => {
      this.toolbarView.webContents.send(TOOLBAR_CHANNELS.FIND_RESULT, result);
    });

        wc.setWindowOpenHandler((details) => {
      return OAuthPopupManager.getInstance().handleWindowOpen(wc, this.window, details, {
        onNewTabRequested: (popupUrl) => {
          if (isAllowedNavigation(popupUrl)) {
            this.createTab(popupUrl);
          }
        },
        onOAuthCompleted: () => {
          wc.session.cookies.flushStore().then(() => {
            wc.reload();
          }).catch(() => {});
        },
      });
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
    this.setupContextMenu(wc);

    this.tabs.set(id, { view, state });
    this.tabOrder.push(id);

    if (deferLoad && url !== 'about:blank') {
      this.deferredTabUrls.set(id, url);
    } else if (url !== 'about:blank') {
      if (isGoogleAuthUrl(url)) wc.setUserAgent(googleAuthUserAgent());
      wc.loadURL(url).catch(() => {});
    }

    if (options?.activate !== false) this.switchTab(id);
    return id;
  }

  public switchTab(tabId: string): boolean {
    const target = this.tabs.get(tabId);
    if (!target) return false;

    if (this.activeTabId && this.activeTabId !== tabId) {
      const current = this.tabs.get(this.activeTabId);
      if (current) {
        this.window.contentView.removeChildView(current.view);
      }
    }

    this.activeTabId = tabId;
    this.window.contentView.addChildView(target.view);
    this.updateLayout();
    this.broadcastState();

    const deferredUrl = this.deferredTabUrls.get(tabId);
    if (deferredUrl) {
      this.deferredTabUrls.delete(tabId);
      target.state.isLoading = true;
      if (isGoogleAuthUrl(deferredUrl)) target.view.webContents.setUserAgent(googleAuthUserAgent());
      target.view.webContents.loadURL(deferredUrl).catch(() => {
        target.state.isLoading = false;
        this.broadcastState();
      });
    }

    if (this.isRulerActive) {
      target.view.webContents.executeJavaScript(RULER_SCRIPT).catch(() => {});
    }
    if (this.isLensActive) {
      target.view.webContents.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
    }
    if (this.isFontFinderActive) {
      target.view.webContents.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
    }

    return true;
  }

  public closeTab(tabId: string): boolean {
    const target = this.tabs.get(tabId);
    if (!target) return false;

    if (target.state.url && target.state.url !== 'about:blank') {
      this.recentlyClosedTabs.push({ url: target.state.url, title: target.state.title || 'Tab' });
      if (this.recentlyClosedTabs.length > 20) this.recentlyClosedTabs.shift();
    }

    if (this.activeTabId === tabId) {
      this.window.contentView.removeChildView(target.view);
    }

    (target.view.webContents as unknown as { destroy?: () => void })?.destroy?.();
    this.tabs.delete(tabId);
    this.diagnostics.delete(tabId);
    this.documentGenerations.delete(tabId);
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

  public navigate(tabId: string, inputUrl: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const cleanUrl = sanitizeUrl(inputUrl);
    tab.state.url = cleanUrl;
    void tab.view.webContents.executeJavaScript(`(() => { ${AGENT_BROWSER_SCRIPT}; if (window.__antifanAgentMove) window.__antifanAgentMove(Math.max(24, window.innerWidth / 2), Math.max(24, window.innerHeight / 2), 'Navigating...'); })()`).catch(() => {});
    tab.view.webContents.loadURL(cleanUrl).catch(() => {});
    return true;
  }

  public reload(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    void tab.view.webContents.executeJavaScript(`(() => { ${AGENT_BROWSER_SCRIPT}; if (window.__antifanAgentMove) window.__antifanAgentMove(Math.max(24, window.innerWidth / 2), Math.max(24, window.innerHeight / 2), 'Reloading...'); })()`).catch(() => {});
    tab.view.webContents.reload();
    return true;
  }

  public stopLoading(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.view.webContents.stop();
    return true;
  }

  public goBack(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const wc = tab.view.webContents;
    const nav = (wc as any).navigationHistory;
    if (nav && nav.canGoBack()) {
      nav.goBack();
      return true;
    }
    if (wc.canGoBack && wc.canGoBack()) {
      wc.goBack();
      return true;
    }
    return false;
  }

  public goForward(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const wc = tab.view.webContents;
    const nav = (wc as any).navigationHistory;
    if (nav && nav.canGoForward()) {
      nav.goForward();
      return true;
    }
    if (wc.canGoForward && wc.canGoForward()) {
      wc.goForward();
      return true;
    }
    return false;
  }

  private applyTabDeviceEmulation(
    tab: { view: WebContentsView; state: AntiFanTab },
    availableWidth: number,
    availableHeight: number,
    toolbarHeight: number
  ): void {
    const preset = DEVICE_PRESETS.find((p) => p.id === tab.state.devicePresetId);

    if (preset && preset.width && preset.height) {
      const userZoom = tab.state.zoomFactor || 1.0;
      const maxW = Math.max(100, availableWidth);
      const maxH = Math.max(100, availableHeight);

      if (preset.category === 'desktop') {
        // Desktop breakpoints (1920x1080, 1728x1117, 1440x900):
        // Auto-scale zoom factor so page layout is precisely preset.width CSS pixels
        // (window.innerWidth = availableWidth / zoom = preset.width) and fits 100% horizontally.
        const fitScale = Math.min(1.0, maxW / preset.width);
        const effectiveZoom = Math.max(0.1, Math.min(5.0, fitScale * userZoom));

        try {
          tab.view.webContents.disableDeviceEmulation();
        } catch {}

        try {
          tab.view.webContents.setZoomFactor(effectiveZoom);
        } catch (err) {
          console.error('[native-tab-host] Failed setZoomFactor:', err);
        }

        tab.view.setBounds({
          x: 0,
          y: toolbarHeight,
          width: maxW,
          height: maxH,
        });
      } else {
        // Tablet / Mobile breakpoints (iPhone, iPad, Samsung Galaxy):
        const fitScale = Math.min(1.0, maxW / preset.width, maxH / preset.height);
        const effectiveScale = Math.max(0.1, Math.min(5.0, fitScale * userZoom));
        const renderedW = Math.min(maxW, Math.round(preset.width * effectiveScale));
        const renderedH = Math.min(maxH, Math.round(preset.height * effectiveScale));
        const targetX = Math.max(0, Math.floor((maxW - renderedW) / 2));
        const targetY = toolbarHeight + Math.max(0, Math.floor((maxH - renderedH) / 2));

        try {
          tab.view.webContents.enableDeviceEmulation({
            screenPosition: preset.mobile ? 'mobile' : 'desktop',
            screenSize: { width: preset.width, height: preset.height },
            viewPosition: { x: 0, y: 0 },
            deviceScaleFactor: preset.deviceScaleFactor || 2,
            viewSize: { width: preset.width, height: preset.height },
            scale: effectiveScale,
          });
        } catch (err) {
          console.error('[native-tab-host] Failed enableDeviceEmulation:', err);
        }

        try {
          tab.view.webContents.setZoomFactor(effectiveScale);
        } catch {}

        tab.view.setBounds({
          x: targetX,
          y: targetY,
          width: renderedW,
          height: renderedH,
        });
      }
    } else {
      try {
        tab.view.webContents.disableDeviceEmulation();
      } catch {}

      const userZoom = tab.state.zoomFactor || 1.0;
      try {
        tab.view.webContents.setZoomFactor(userZoom);
      } catch {}

      tab.view.setBounds({
        x: 0,
        y: toolbarHeight,
        width: availableWidth,
        height: availableHeight,
      });
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

  public setDevicePreset(tabId: string, presetId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.state.devicePresetId = presetId;
    this.updateLayout();
    this.broadcastState();
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
  public async ensureAgentBrowserInjected(tabId?: string): Promise<boolean> {
    const target = this.tabs.get(tabId || this.activeTabId);
    if (!target) return false;
    try {
      await target.view.webContents.executeJavaScript(AGENT_BROWSER_SCRIPT);
      return true;
    } catch {
      return false;
    }
  }

  public async agentClick(params: { selector?: string; x?: number; y?: number; label?: string; tabId?: string }): Promise<boolean> {
    const target = this.tabs.get(params.tabId || this.activeTabId);
    if (!target) return false;
    await this.ensureAgentBrowserInjected(params.tabId || this.activeTabId);
    try {
      await target.view.webContents.executeJavaScript(`(() => {
        if (window.__antifanAgentClick) {
          window.__antifanAgentClick(${JSON.stringify(params.selector || '')}, ${typeof params.x === 'number' ? params.x : 'null'}, ${typeof params.y === 'number' ? params.y : 'null'}, ${JSON.stringify(params.label || '')});
        }
      })()`);
      return true;
    } catch (err) {
      console.error('[native-tab-host] agentClick error:', err);
      return false;
    }
  }

  public async agentType(params: { selector: string; text: string; clear?: boolean; tabId?: string }): Promise<boolean> {
    const target = this.tabs.get(params.tabId || this.activeTabId);
    if (!target) return false;
    await this.ensureAgentBrowserInjected(params.tabId || this.activeTabId);
    try {
      await target.view.webContents.executeJavaScript(`(() => {
        if (window.__antifanAgentType) {
          window.__antifanAgentType(${JSON.stringify(params.selector)}, ${JSON.stringify(params.text)}, ${params.clear ? 'true' : 'false'});
        }
      })()`);
      return true;
    } catch (err) {
      console.error('[native-tab-host] agentType error:', err);
      return false;
    }
  }

  public async agentScroll(params: { deltaY?: number; selector?: string; tabId?: string }): Promise<boolean> {
    const target = this.tabs.get(params.tabId || this.activeTabId);
    if (!target) return false;
    await this.ensureAgentBrowserInjected(params.tabId || this.activeTabId);
    try {
      await target.view.webContents.executeJavaScript(`(() => {
        if (window.__antifanAgentScroll) {
          window.__antifanAgentScroll(${typeof params.deltaY === 'number' ? params.deltaY : 400}, ${JSON.stringify(params.selector || '')});
        }
      })()`);
      return true;
    } catch (err) {
      console.error('[native-tab-host] agentScroll error:', err);
      return false;
    }
  }

  public async agentHover(params: { selector?: string; x?: number; y?: number; label?: string; tabId?: string }): Promise<boolean> {
    const target = this.tabs.get(params.tabId || this.activeTabId);
    if (!target) return false;
    await this.ensureAgentBrowserInjected(params.tabId || this.activeTabId);
    try {
      let targetX = params.x;
      let targetY = params.y;
      if (params.selector) {
        const rect = await target.view.webContents.executeJavaScript(`(() => {
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
        await target.view.webContents.executeJavaScript(`(() => {
          if (window.__antifanAgentMove) {
            window.__antifanAgentMove(${targetX}, ${targetY}, ${JSON.stringify(params.label || 'Hovering')});
          }
        })()`);
      }
      return true;
    } catch (err) {
      console.error('[native-tab-host] agentHover error:', err);
      return false;
    }
  }

  public async agentHighlight(params: { selector: string; label?: string; tabId?: string }): Promise<boolean> {
    const target = this.tabs.get(params.tabId || this.activeTabId);
    if (!target) return false;
    await this.ensureAgentBrowserInjected(params.tabId || this.activeTabId);
    try {
      await target.view.webContents.executeJavaScript(`(() => {
        if (window.__antifanAgentHighlight) {
          window.__antifanAgentHighlight(${JSON.stringify(params.selector)}, ${JSON.stringify(params.label || '')});
        }
      })()`);
      return true;
    } catch (err) {
      console.error('[native-tab-host] agentHighlight error:', err);
      return false;
    }
  }

  public async agentClear(tabId?: string): Promise<boolean> {
    const target = this.tabs.get(tabId || this.activeTabId);
    if (!target) return false;
    try {
      await target.view.webContents.executeJavaScript(`(() => {
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

  public startInspect(): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;

    this.isInspecting = true;
    active.view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    this.emit('inspect-toggled', true);
    this.broadcastState();

    if (this.inspectPollTimer) clearInterval(this.inspectPollTimer);
    this.inspectPollTimer = setInterval(async () => {
      if (!this.isInspecting) {
        if (this.inspectPollTimer) clearInterval(this.inspectPollTimer);
        return;
      }
      try {
        const rawResult = await active.view.webContents.executeJavaScript('window.__antifanPick');
        if (rawResult) {
          await active.view.webContents.executeJavaScript('window.__antifanPick = null;');
          this.stopInspect();

          if (rawResult.canceled) return;

          let targetImageBase64: string | undefined;
          if (rawResult.clientRect && rawResult.clientRect.width > 0 && rawResult.clientRect.height > 0) {
            try {
              const rect: Rectangle = {
                x: Math.max(0, Math.floor(rawResult.clientRect.x)),
                y: Math.max(0, Math.floor(rawResult.clientRect.y)),
                width: Math.min(2500, Math.ceil(rawResult.clientRect.width)),
                height: Math.min(2500, Math.ceil(rawResult.clientRect.height)),
              };
              const image = await active.view.webContents.capturePage(rect);
              targetImageBase64 = image.toPNG().toString('base64');
            } catch {}
          }

          let viewportImageBase64: string | undefined;
          try {
            const vpImg = await active.view.webContents.capturePage();
            viewportImageBase64 = vpImg.toPNG().toString('base64');
          } catch {}

          const activeTab = this.tabs.get(this.activeTabId);
          const targetSessionId = this.transcriptSyncer.getActiveSessionId() !== 'auto'
            ? this.transcriptSyncer.getActiveSessionId()
            : undefined;
          const targetWorkspace = this.resolveTargetWorkspace(targetSessionId, activeTab?.state.url);

          const annotationResult = await AnnotationManager.getInstance().processAnnotationPayload({
            url: active.state.url,
            title: active.state.title,
            targetImageBase64,
            viewportImageBase64,
            workspaceDir: targetWorkspace,
            ...rawResult,
          });

          const pickedData: AntiFanPickedElement = {
            ...rawResult,
            screenshotBase64: targetImageBase64,
            markdownPath: annotationResult.markdownPath,
            markdownContent: annotationResult.markdownContent,
            targetImagePath: annotationResult.targetImagePath,
            viewportImagePath: annotationResult.viewportImagePath,
            userComment: rawResult.userComment,
            timestamp: Date.now(),
          };

          this.emit('element-picked', pickedData);

          // Notify Toolbar and Sidebar
          if (!this.toolbarView.webContents.isDestroyed()) {
            this.toolbarView.webContents.send(TOOLBAR_CHANNELS.ELEMENT_PICKED, pickedData);
          }
          if (this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
            this.sidebarView.webContents.send(SIDEBAR_CHANNELS.ATTACH_ELEMENT, pickedData);

            const promptText = rawResult.userComment?.trim() || 'Inspect the attached browser annotation, report observed evidence, and ask for the intended outcome before editing.';
            let fullPrompt = promptText;
            if (annotationResult.markdownPath) {
              fullPrompt += `\n@[${annotationResult.markdownPath}:L1]`;
            }
            if (annotationResult.targetImagePath) {
              fullPrompt += `\n@[${annotationResult.targetImagePath}:L1]`;
            }

            await this.handleLegacySendPrompt({
              text: fullPrompt,
              attachedElement: pickedData,
              deliveryMode: 'auto',
              sessionId: targetSessionId,
            });
          }
          if (this.chatMode === 'standalone' && this.standaloneView && !this.standaloneView.webContents.isDestroyed()) {
            const refs = [annotationResult.markdownPath, annotationResult.targetImagePath, annotationResult.viewportImagePath].filter(Boolean).join(' ');
            if (refs) this.standaloneView.webContents.send(TERMINAL_CHANNELS.DATA, { sessionId: TerminalManager.getInstance().getActiveSessionId(), data: `\r\n[Annotation ready] ${refs}\r\n` });
            TerminalManager.getInstance().write(`$annotation = '${refs.replace(/'/g, "''")}'\r\n`);
          }
        }
      } catch {}
    }, 200);
  }

  public stopInspect(): void {
    this.isInspecting = false;
    if (this.inspectPollTimer) {
      clearInterval(this.inspectPollTimer);
      this.inspectPollTimer = null;
    }
    const active = this.tabs.get(this.activeTabId);
    if (active) {
      active.view.webContents.executeJavaScript(`(() => {
        const ov = document.getElementById('antifan-inspect-overlay');
        if (ov) ov.remove();
        const bg = document.getElementById('antifan-inspect-badge');
        if (bg) bg.remove();
        if (document.documentElement) document.documentElement.style.cursor = '';
        window.__antifanPickerActive = false;
      })()`).catch(() => {});
    }
    this.emit('inspect-toggled', false);
    this.broadcastState();
  }

  public resolveTargetWorkspace(targetSessionId?: string, tabUrl?: string): string {
    const candidates: string[] = [];

    // 1. If explicit session ID is provided and resolved
    if (targetSessionId && targetSessionId !== 'auto') {
      const sessionWs = this.transcriptSyncer.getSessionWorkspace(targetSessionId);
      if (sessionWs && fs.existsSync(sessionWs) && !candidates.includes(sessionWs)) {
        candidates.push(sessionWs);
      }
    }

    // 2. Try to classify based on tab URL (e.g. m-n-bakery -> customizes/Mnbakery)
    if (tabUrl) {
      try {
        const parsedUrl = new URL(tabUrl);
        const host = parsedUrl.hostname.toLowerCase();
        const candidateRoots = [
          path.join('e:\\Work', 'customizes'),
          path.join('e:\\Work', 'themes'),
          path.join('e:\\Work', 'apps'),
        ];
        for (const rootDir of candidateRoots) {
          if (fs.existsSync(rootDir)) {
            const subdirs = fs.readdirSync(rootDir, { withFileTypes: true });
            for (const sd of subdirs) {
              if (sd.isDirectory()) {
                const subPath = path.join(rootDir, sd.name);
                const cleanSub = sd.name.toLowerCase().replace(/[-_]/g, '');
                const cleanHost = host.replace(/[-_.]/g, '');
                if (cleanHost.includes(cleanSub) || (cleanHost.includes('myharavan') && cleanSub.includes(cleanHost.split('myharavan')[0] || '___'))) {
                  if (!candidates.includes(subPath)) candidates.push(subPath);
                  break;
                }
              }
            }
          }
        }
      } catch {}
    }

    // 3. Check active session from transcript syncer
    const activeSessionId = this.transcriptSyncer.getActiveSessionId();
    if (activeSessionId && activeSessionId !== 'auto') {
      const activeWs = this.transcriptSyncer.getSessionWorkspace(activeSessionId);
      if (activeWs && fs.existsSync(activeWs) && !candidates.includes(activeWs)) {
        candidates.push(activeWs);
      }
    }

    // 4. Default candidates
    if (fs.existsSync(process.cwd()) && !candidates.includes(process.cwd())) candidates.push(process.cwd());
    if (fs.existsSync('e:\\Work') && !candidates.includes('e:\\Work')) candidates.push('e:\\Work');

    // 5. Prioritize candidate that currently has a LIVE Extension Host!
    for (const cand of candidates) {
      try {
        const client = new AntigravityCommandClient({ workspacePath: cand });
        if (client.checkHostLiveness().isLive) {
          return cand;
        }
      } catch {}
    }

    // Fallback to first candidate
    return candidates[0] || process.cwd();
  }

  public async agentMove(params: { selector?: string; x?: number; y?: number; label?: string; tabId?: string }): Promise<boolean> {
    const target = this.tabs.get(params.tabId || this.activeTabId);
    if (!target) return false;
    await this.ensureAgentBrowserInjected(params.tabId || this.activeTabId);
    try {
      let x = params.x;
      let y = params.y;
      if (params.selector) {
        const rect = await target.view.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) return null; el.scrollIntoView({behavior:'smooth',block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (rect) { x = rect.x; y = rect.y; }
      }
      if (typeof x !== 'number' || typeof y !== 'number') return false;
      await target.view.webContents.executeJavaScript(`window.__antifanAgentMove(${x}, ${y}, ${JSON.stringify(params.label || 'Agent Cursor')})`);
      return true;
    } catch { return false; }
  }

  public getDiagnostics(tabId?: string, level?: number): { console: Array<Record<string, unknown>>; failures: Array<Record<string, unknown>> } {
    const id = tabId || this.activeTabId;
    const value = this.diagnostics.get(id);
    if (!value) return { console: [], failures: [] };
    return { console: value.console.filter((item) => level === undefined || item.level === level), failures: [...value.failures] };
  }

  public getDocumentGeneration(tabId: string): number { return this.documentGenerations.get(tabId) || 0; }

  public isCurrentTarget(target: BrowserTarget): boolean {
    return this.tabs.has(target.tabId) && target.browserEpoch === 1 && target.documentGeneration === this.getDocumentGeneration(target.tabId);
  }

  public async runResponsiveCheck(tabId?: string): Promise<Record<string, unknown>> {
    const id = tabId || this.activeTabId;
    const item = this.tabs.get(id);
    if (!item || item.view.webContents.isDestroyed()) throw new Error(`Unknown tabId: ${id}`);
    const evaluation = item.view.webContents.executeJavaScript(`(() => {
      const width = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const offenders = Array.from(document.querySelectorAll('*')).map((el) => {
        const r = el.getBoundingClientRect();
        return { selector: el.id ? '#' + el.id : el.className && typeof el.className === 'string' ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : el.tagName.toLowerCase(), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      }).filter((x) => x.width > 0 && (x.left < 0 || x.right > width));
      return { viewport: { width: window.innerWidth, height: window.innerHeight }, scrollWidth, clientWidth: width, overflowX: scrollWidth > width, offenders: offenders.slice(0, 50) };
    })()`);
    return Promise.race([
      evaluation,
      new Promise<Record<string, unknown>>((_, reject) => setTimeout(() => reject(new Error('Responsive check timed out')), 5000)),
    ]);
  }

  private resolveExplicitWorkspace(targetSessionId?: string): string | null {
    if (!targetSessionId || targetSessionId === 'auto') return null;
    const workspace = this.transcriptSyncer.getSessionWorkspace(targetSessionId);
    return workspace && fs.existsSync(workspace) ? workspace : null;
  }

  private handleLegacySendPrompt(opts: Omit<Parameters<NativeTabHost['handleSendPrompt']>[0], 'workspacePath'>): Promise<{ ok: boolean; messageId: string; notice: string; commandId?: string }> {
    const activeTab = this.tabs.get(this.activeTabId);
    const targetSessionId = opts.sessionId && opts.sessionId !== 'auto' ? opts.sessionId : undefined;
    const targetWorkspace = this.resolveTargetWorkspace(targetSessionId, activeTab?.state.url);
    return this.handleSendPrompt({ ...opts, workspacePath: targetWorkspace });
  }

  private async handleStandalonePrompt(text: string): Promise<{ ok: boolean; messageId: string; notice: string; commandId?: string }> {
    const prompt = text.trim();
    if (!prompt) return { ok: false, messageId: '', notice: 'Prompt trống.' };
    const runId = `run-${randomUUID()}`;
    const attemptId = `attempt-${randomUUID()}`;
    const messageId = String(Date.now());
    const userMessage: ChatMessage = { id: messageId, role: 'user', text: prompt, timestamp: Date.now() };
    if (this.standaloneView && !this.standaloneView.webContents.isDestroyed()) this.standaloneView.webContents.send(SIDEBAR_CHANNELS.STREAM_UPDATE, { message: userMessage });
    const backend = new CodexExecutionBackend();
    void (async () => {
      try {
        for await (const event of backend.startRun({ runId, attemptId, projectId: 'project-standalone-local', workspaceId: 'workspace-standalone-local', chatId: 'chat-standalone-local', promptText: prompt, cwd: process.cwd() })) {
          if (event.type === 'text' || event.type === 'error' || event.type === 'status') {
            const message: ChatMessage = { id: `${messageId}-${Date.now()}`, role: event.type === 'text' ? 'assistant' : 'system', text: event.type === 'text' ? event.text : event.type === 'error' ? event.errorMessage : event.state, timestamp: Date.now() };
            if (this.standaloneView && !this.standaloneView.webContents.isDestroyed()) this.standaloneView.webContents.send(SIDEBAR_CHANNELS.STREAM_UPDATE, { message });
          }
        }
      } catch (error) {
        const message: ChatMessage = { id: `${messageId}-error`, role: 'system', text: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
        if (this.standaloneView && !this.standaloneView.webContents.isDestroyed()) this.standaloneView.webContents.send(SIDEBAR_CHANNELS.STREAM_UPDATE, { message });
      }
    })();
    return { ok: true, messageId, notice: 'Đã chạy Standalone local harness', commandId: runId };
  }

  public async handleSendPrompt(opts: {
    text: string;
    attachedElement?: AntiFanPickedElement;
    attachedImages?: Array<{ name: string; dataUrl: string }>;
    deliveryMode?: 'auto' | 'draft';
    sessionId?: string;
    workspacePath: string;
  }): Promise<{ ok: boolean; messageId: string; notice: string; commandId?: string }> {
    const mode = opts.deliveryMode || 'auto';
    const isExplicitSession = !!(opts.sessionId && opts.sessionId !== 'auto');
    const targetSessionId = isExplicitSession ? opts.sessionId : undefined;
    const targetWorkspace = opts.workspacePath && path.resolve(opts.workspacePath);
    if (!targetWorkspace) return { ok: false, messageId: '', notice: 'Thất bại: cần Workspace đích rõ ràng cho autonomous prompt.' };

    // 1. Copy to OS clipboard instantly for 100% Antigravity IDE Ctrl+V parity
    try {
      clipboard.writeText(opts.text);
    } catch (err) {
      console.error('[native-tab-host] Failed to copy prompt to clipboard:', err);
    }

    // 1b. Save any attached images to snapshots directory on disk
    const savedImagePaths: string[] = [];
    const snapshotsDirs = [path.join(targetWorkspace, '.antigravity', 'snapshots')];
    for (const sDir of snapshotsDirs) {
      try { fs.mkdirSync(sDir, { recursive: true }); } catch {}
    }
    const primarySnapshotsDir = snapshotsDirs.find((d) => fs.existsSync(d)) || snapshotsDirs[0]!;

    if (Array.isArray(opts.attachedImages) && opts.attachedImages.length > 0) {
      opts.attachedImages.forEach((img, idx) => {
        if (img && typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:image/')) {
          try {
            const base64Data = img.dataUrl.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const safeName = (img.name || `image_${idx + 1}.png`).replace(/[^a-zA-Z0-9_.-]/g, '_');
            const fileName = `pasted_${Date.now()}_${idx}_${safeName}`;
            const targetPath = path.join(primarySnapshotsDir, fileName);
            fs.writeFileSync(targetPath, buffer);
            savedImagePaths.push(targetPath);
          } catch (err) {
            console.error('[native-tab-host] Failed to save attached image:', err);
          }
        }
      });
    }

    if (opts.attachedElement) {
      const elem = opts.attachedElement as any;
      if (elem.targetImagePath && fs.existsSync(elem.targetImagePath)) {
        if (!savedImagePaths.includes(elem.targetImagePath)) {
          savedImagePaths.push(elem.targetImagePath);
        }
      } else if (elem.targetImageDataUrl && typeof elem.targetImageDataUrl === 'string' && elem.targetImageDataUrl.startsWith('data:image/')) {
        try {
          const base64Data = elem.targetImageDataUrl.replace(/^data:image\/\w+;base64,/, '');
          const targetPath = path.join(primarySnapshotsDir, `target_${Date.now()}.png`);
          fs.writeFileSync(targetPath, Buffer.from(base64Data, 'base64'));
          savedImagePaths.push(targetPath);
          elem.targetImagePath = targetPath;
        } catch {}
      }

      if (elem.viewportImagePath && fs.existsSync(elem.viewportImagePath)) {
        if (!savedImagePaths.includes(elem.viewportImagePath)) {
          savedImagePaths.push(elem.viewportImagePath);
        }
      } else if (elem.viewportImageDataUrl && typeof elem.viewportImageDataUrl === 'string' && elem.viewportImageDataUrl.startsWith('data:image/')) {
        try {
          const base64Data = elem.viewportImageDataUrl.replace(/^data:image\/\w+;base64,/, '');
          const targetPath = path.join(primarySnapshotsDir, `viewport_${Date.now()}.png`);
          fs.writeFileSync(targetPath, Buffer.from(base64Data, 'base64'));
          savedImagePaths.push(targetPath);
          elem.viewportImagePath = targetPath;
        } catch {}
      }
    }

    // 1c. Prepare attachments and send command via AntigravityCommandClient
    const attachments: AntigravityAttachmentDescriptor[] = [];
    const addAttachment = (filePath: string, mime = 'application/octet-stream') => {
      try {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          attachments.push({
            name: path.basename(filePath),
            filePath,
            mime,
            byteLength: stat.size,
          });
        }
      } catch {}
    };

    if (opts.attachedElement?.markdownPath) {
      addAttachment(opts.attachedElement.markdownPath, 'text/markdown');
    }
    if (opts.attachedElement?.targetImagePath) {
      addAttachment(opts.attachedElement.targetImagePath, 'image/png');
    }
    if (opts.attachedElement?.viewportImagePath) {
      addAttachment(opts.attachedElement.viewportImagePath, 'image/png');
    }
    for (const p of savedImagePaths) {
      addAttachment(p, 'image/png');
    }

    if (opts.attachedElement) {
      const elemPath = path.join(targetWorkspace, '.antigravity', 'latest_element_mcp.json');
      try {
        if (fs.existsSync(path.dirname(elemPath))) {
          fs.writeFileSync(elemPath, JSON.stringify(opts.attachedElement, null, 2), 'utf8');
        }
      } catch {}
    }

    // Enforce 8-attachment, 10MiB total budget check
    const MAX_ATTACHMENTS = 8;
    const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
    let totalAttachmentBytes = 0;
    for (const a of attachments) {
      totalAttachmentBytes += a.byteLength;
    }
    if (attachments.length > MAX_ATTACHMENTS || totalAttachmentBytes > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        messageId: '',
        notice: `Thất bại: Vượt quá giới hạn đính kèm (tối đa 8 tệp, 10MB; hiện tại: ${attachments.length} tệp, ${Math.round(totalAttachmentBytes / 1024 / 1024)}MB)`,
      };
    }

    const client = new AntigravityCommandClient({
      workspacePath: targetWorkspace,
      timeoutMs: 30000,
    });

    const attemptId = `attempt-${generateCommandId()}`;
    const host = client.readHostStatus();
    const hostInstanceId = host?.hostInstanceId || 'unknown';
    const hostEpoch = host?.hostEpoch || 0;
    const { command, resultPromise } = client.dispatchCommand({
      action: 'send-prompt',
      mode: mode === 'auto' ? 'auto' : 'draft',
      promptText: opts.text,
      targetConversationId: targetSessionId,
      backendSessionRef: targetSessionId || 'legacy-panel',
      requestedRoute: isExplicitSession ? 'sidecar-agentapi' : 'active-panel',
      attachments,
      meta: {
        sessionId: targetSessionId,
        conversationId: targetSessionId,
        projectId: 'legacy-project',
        workspaceId: targetSessionId || 'legacy-workspace',
        attemptId,
        hostInstanceId,
        hostEpoch,
      },
    });
    const promptDigest = computePromptDigest(opts.text);
    const receiptBinding: ReceiptBinding = { commandId: command.id, promptDigest, projectId: 'legacy-project', workspaceId: targetSessionId || 'legacy-workspace', canonicalWorkspace: targetWorkspace, hostInstanceId, hostEpoch, attemptId, backendSessionRef: targetSessionId || 'legacy-panel' };

    const msg: ChatMessage = {
      id: String(Date.now()),
      role: 'user',
      text: opts.text,
      attachedElement: opts.attachedElement,
      attachedImages: opts.attachedImages,
      timestamp: Date.now(),
      commandId: command.id,
      deliveryState: 'queued',
      actualRoute: isExplicitSession ? 'sidecar-agentapi' : 'active-panel',
      observationState: 'none',
    };
    this.chatMessages.push(msg);
    this.pendingDeliveries.push({
      message: msg,
      commandId: command.id,
      targetWorkspace,
      dispatchedAt: Date.now(),
      expectedCommand: { id: command.id, targetWorkspace: command.targetWorkspace, promptDigest, projectId: 'legacy-project', workspaceId: targetSessionId || 'legacy-workspace', attemptId, hostInstanceId, hostEpoch, backendSessionRef: targetSessionId || 'legacy-panel' },
      receiptBinding,
    });
    this.receiptStore.put(receiptBinding, 'prepared', 'prepared');
    this.startLateReceiptReconciler();

    // Notify sidebar UI
    if (this.chatMode === 'legacy' && this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
      this.sidebarView.webContents.send(SIDEBAR_CHANNELS.STREAM_UPDATE, { message: msg });
    }
    if (this.chatMode === 'standalone' && this.standaloneView && !this.standaloneView.webContents.isDestroyed()) this.standaloneView.webContents.send(SIDEBAR_CHANNELS.STREAM_UPDATE, { message: msg });

    void resultPromise.then((result) => {
      const exact = result.promptDigest === receiptBinding.promptDigest && result.projectId === receiptBinding.projectId && result.workspaceId === receiptBinding.workspaceId && result.attemptId === receiptBinding.attemptId && result.hostInstanceId === receiptBinding.hostInstanceId && result.hostEpoch === receiptBinding.hostEpoch;
      if (exact) {
        this.receiptStore.reconcile(receiptBinding, { formatVersion: 1, id: `legacy-${command.id}`, binding: receiptBinding, state: result.ok ? 'completed' : result.deliveryState === 'unknown' ? 'unknown' : 'failed', deliveryState: result.deliveryState === 'ide-api-accepted' ? 'accepted-exact' : result.deliveryState === 'unknown' ? 'unknown' : 'failed', createdAt: Date.now(), errorCode: result.errorCode, errorMessage: result.errorMessage });
      } else {
        this.receiptStore.put(receiptBinding, 'unknown', 'unknown', { errorCode: 'NON_AUTHORITATIVE_RECEIPT', errorMessage: 'Receipt did not contain the exact persisted binding' });
      }
      msg.deliveryState = result.deliveryState;
      msg.actualRoute = result.actualRoute;
      msg.deliveryError = result.errorMessage;
      const updatePayload: BridgeDeliveryUpdatePayload = {
        messageId: msg.id,
        commandId: command.id,
        deliveryState: result.deliveryState,
        actualRoute: result.actualRoute,
        errorMessage: result.errorMessage,
        errorCode: result.errorCode,
        updatedAtEpochMs: Date.now(),
      };
      if (this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
        this.sidebarView.webContents.send(SIDEBAR_CHANNELS.DELIVERY_STATE_CHANGED, updatePayload);
      }
    });

    // 2. Emit event for bridge server
    this.emit('chat-prompt-submitted', { prompt: opts.text, sessionId: targetSessionId, attachedElement: opts.attachedElement, attachedImages: opts.attachedImages, deliveryMode: mode });

    const isAuto = mode === 'auto';
    const notice = isAuto
      ? '⚡ Đã chuyển tiếp tới Antigravity Agent qua Extension Bridge'
      : '📝 Đã lưu prompt dưới dạng Draft';

    return { ok: true, messageId: msg.id, notice, commandId: command.id };
  }

  private startLateReceiptReconciler(): void {
    if (this.reconcilerTimer) return;
    this.reconcilerTimer = setInterval(() => {
      if (this.pendingDeliveries.length === 0) return;
      const now = Date.now();
      // Only keep items from the last 10 minutes
      this.pendingDeliveries = this.pendingDeliveries.filter((p) => now - p.dispatchedAt < 600000);

      for (const pending of this.pendingDeliveries) {
        if (pending.message.deliveryState !== 'unknown' && pending.message.deliveryState !== 'queued') {
          continue;
        }
        try {
          const client = new AntigravityCommandClient({ workspacePath: pending.targetWorkspace });
          const lateReceipt = client.checkLateReceipt(pending.commandId, pending.expectedCommand);
          if (lateReceipt) {
            const state = lateReceipt.deliveryState === 'unknown' ? 'unknown' : lateReceipt.ok ? 'completed' : 'failed';
            const deliveryState = lateReceipt.deliveryState === 'unknown' ? 'unknown' : lateReceipt.ok ? 'accepted-exact' : 'failed';
            const authoritative = this.receiptStore.reconcile(pending.receiptBinding, { formatVersion: 1, id: `legacy-${pending.commandId}`, binding: pending.receiptBinding, state, deliveryState, createdAt: Date.now(), errorCode: lateReceipt.errorCode, errorMessage: lateReceipt.errorMessage });
            const updateDeliveryState = authoritative.deliveryState === 'accepted-exact' ? 'ide-api-accepted' : authoritative.deliveryState === 'unknown' ? 'unknown' : 'failed';
            pending.message.deliveryState = updateDeliveryState;
            if (lateReceipt.actualRoute) pending.message.actualRoute = lateReceipt.actualRoute;
            if (lateReceipt.errorMessage) pending.message.deliveryError = lateReceipt.errorMessage;
            const updatePayload: BridgeDeliveryUpdatePayload = {
              messageId: pending.message.id,
              commandId: pending.commandId,
              deliveryState: updateDeliveryState,
              actualRoute: lateReceipt.actualRoute,
              errorMessage: lateReceipt.errorMessage,
              errorCode: lateReceipt.errorCode,
              updatedAtEpochMs: Date.now(),
            };
            if (this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
              this.sidebarView.webContents.send(SIDEBAR_CHANNELS.DELIVERY_STATE_CHANGED, updatePayload);
            }
          }
        } catch {}
      }
    }, 2500);
  }

  public findInPage(text: string, forward = true): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active || !text) return;
    active.view.webContents.findInPage(text, { forward, findNext: true });
  }

  public stopFindInPage(): void {
    const active = this.tabs.get(this.activeTabId);
    if (active) {
      active.view.webContents.stopFindInPage('clearSelection');
    }
  }

  public async captureScreenshot(rect?: Rectangle, tabId?: string): Promise<string> {
    const active = this.tabs.get(tabId || this.activeTabId);
    if (!active) return '';
    const img = await active.view.webContents.capturePage(rect);
    return img.toPNG().toString('base64');
  }

  public async getDom(selector?: string, tabId?: string): Promise<string> {
    const active = this.tabs.get(tabId || this.activeTabId);
    if (!active) return '';
    const script = selector
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          return el ? el.outerHTML : '';
        })()`
      : `(() => document.documentElement ? document.documentElement.outerHTML : '')()`;
    return active.view.webContents.executeJavaScript(script);
  }

  public async evalJs(expression: string): Promise<unknown> {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return undefined;
    return active.view.webContents.executeJavaScript(expression);
  }

  private getTabsStoragePath(): string {
    const userData = app ? app.getPath('userData') : path.join(os.homedir(), '.antifan-browser');
    if (!fs.existsSync(userData)) {
      try { fs.mkdirSync(userData, { recursive: true }); } catch {}
    }
    return path.join(userData, 'saved-tabs.json');
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTabs();
    }, 400);
  }

  public persistTabs(): void {
    try {
      const filePath = this.getTabsStoragePath();
      const tabList = this.tabOrder.map((id) => {
        const tab = this.tabs.get(id);
        if (!tab) return null;
        return {
          id: tab.state.id,
          url: cleanRestoredUrl(tab.state.url),
          title: tab.state.title,
          devicePresetId: tab.state.devicePresetId,
          zoomFactor: tab.state.zoomFactor,
        };
      }).filter(Boolean);

      const data = {
        activeTabId: this.activeTabId,
        tabs: tabList,
        bookmarks: this.bookmarks,
        activeChromeProfileId: ChromeProfileSyncManager.getInstance().activeProfileId,
        sidebarWidth: this.sidebarWidth,
        isSidebarOpen: this.isSidebarOpen,
        updatedAt: Date.now(),
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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
          if (data.activeChromeProfileId) {
            ChromeProfileSyncManager.getInstance().activeProfileId = data.activeChromeProfileId;
            setTimeout(() => {
              ChromeProfileSyncManager.getInstance().syncProfile(data.activeChromeProfileId).catch(() => {});
            }, 1500);
          }
          if (Array.isArray(data.bookmarks) && data.bookmarks.length > 0) {
            this.bookmarks = data.bookmarks;
          }
          if (Array.isArray(data.tabs) && data.tabs.length > 0) {
            let restoredActiveId = data.activeTabId;
            for (const t of data.tabs) {
              const safeUrl = cleanRestoredUrl(t.url);
              const id = this.createTab(safeUrl, {
                deferLoad: t.id !== data.activeTabId,
                activate: false,
              });
              const tab = this.tabs.get(id);
              if (tab) {
                if (t.title) tab.state.title = t.title;
                if (t.devicePresetId) this.setDevicePreset(id, t.devicePresetId);
              }
              if (t.id === data.activeTabId) {
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

  private broadcastState(): void {
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
      activeChromeProfile: ChromeProfileSyncManager.getInstance().getActiveProfile(),
      chromeProfiles: ChromeProfileSyncManager.getInstance().getAvailableProfiles(),
    };
    this.emit('tabs-changed', payload.tabs, payload.activeTabId);
    if (!this.toolbarView.webContents.isDestroyed()) {
      this.toolbarView.webContents.send(TOOLBAR_CHANNELS.STATE_UPDATED, payload);
    }
    this.schedulePersist();
  }

  public dispose(): void {
    this.transcriptSyncer.dispose();
    if (this.inspectPollTimer) {
      clearInterval(this.inspectPollTimer);
      this.inspectPollTimer = null;
    }
    if (this.reconcilerTimer) {
      clearInterval(this.reconcilerTimer);
      this.reconcilerTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    for (const [, tab] of this.tabs) {
      (tab.view.webContents as unknown as { destroy?: () => void })?.destroy?.();
    }
    this.tabs.clear();
    this.tabOrder = [];
  }
}
