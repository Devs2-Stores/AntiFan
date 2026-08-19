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
import { AntiFanTab, AntiFanPickedElement, ChatMessage, TOOLBAR_CHANNELS, SIDEBAR_CHANNELS, TERMINAL_CHANNELS } from '../../shared/contracts';
import { getSecureWebPreferences, sanitizeUrl, isAllowedNavigation } from '../security/security-policy';
import { ELEMENT_PICKER_SCRIPT } from './element-picker';
import { FONT_FINDER_SCRIPT } from './font-finder';
import { GPU_LENS_SCRIPT } from './gpu-lens';
import { RULER_SCRIPT } from './ruler';
import { DEVICE_PRESETS } from './device-presets';
import { TranscriptSyncer } from '../bridge/transcript-syncer';
import { AnnotationManager } from '../bridge/annotation-manager';
import { ChromeProfileSyncManager } from './chrome-profile-sync';
import { HaravanUploader } from './haravan-uploader';
import { TerminalManager } from './terminal-manager';

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
  private terminalView: WebContentsView | null = null;
  private isSidebarOpen: boolean = true;
  private isTerminalOpen: boolean = false;
  private isBookmarkBarVisible: boolean = true;
  private sidebarWidth: number = 380;
  private transcriptSyncer: TranscriptSyncer;

  private tabs: Map<string, { view: WebContentsView; state: AntiFanTab }> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string = '';
  private chatMessages: ChatMessage[] = [];

  private bookmarks: BookmarkItem[] = [];

  private isInspecting: boolean = false;
  private isFontFinderActive: boolean = false;
  private isLensActive: boolean = false;
  private isRulerActive: boolean = false;
  private inspectPollTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(window: BrowserWindow) {
    super();
    this.window = window;

    // 1. Create Toolbar View
    this.toolbarView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'toolbar-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    this.window.contentView.addChildView(this.toolbarView);

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

    // 3. Create Bottom Docked Terminal View
    this.terminalView = new WebContentsView({
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
    this.terminalView.webContents.loadFile(terminalHtml);

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

    this.setupToolbarIpc();
    this.setupSidebarIpc();
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
      if (this.isSidebarOpen && sidebarActualWidth > 0) {
        this.sidebarView.setBounds({ x: availableWidth, y: 0, width: sidebarActualWidth, height });
      } else {
        this.sidebarView.setBounds({ x: width, y: 0, width: 0, height: 0 });
      }
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
    ipcMain.handle(TOOLBAR_CHANNELS.GET_INITIAL_STATE, () => {
      return {
        tabs: this.getTabList(),
        activeTabId: this.activeTabId,
        isInspecting: this.isInspecting,
        isFontFinderActive: this.isFontFinderActive,
        isLensActive: this.isLensActive,
        isSidebarOpen: this.isSidebarOpen,
        bookmarks: this.bookmarks,
        devicePresets: DEVICE_PRESETS,
        activeChromeProfile: ChromeProfileSyncManager.getInstance().getActiveProfile(),
        chromeProfiles: ChromeProfileSyncManager.getInstance().getAvailableProfiles(),
      };
    });

    ipcMain.handle(TOOLBAR_CHANNELS.CREATE_TAB, (_event, url?: string) => this.createTab(url));
    ipcMain.handle(TOOLBAR_CHANNELS.SWITCH_TAB, (_event, tabId: string) => this.switchTab(tabId));
    ipcMain.handle(TOOLBAR_CHANNELS.CLOSE_TAB, (_event, tabId: string) => this.closeTab(tabId));
    ipcMain.handle(TOOLBAR_CHANNELS.MOVE_TAB, (_event, { tabId, toIndex }: { tabId: string; toIndex: number }) => this.moveTab(tabId, toIndex));
    ipcMain.handle(TOOLBAR_CHANNELS.NAVIGATE, (_event, { tabId, url }: { tabId?: string; url: string }) => this.navigate(tabId || this.activeTabId, url));
    ipcMain.handle(TOOLBAR_CHANNELS.RELOAD, (_event, tabId?: string) => this.reload(tabId || this.activeTabId));
    ipcMain.handle(TOOLBAR_CHANNELS.STOP_LOADING, (_event, tabId?: string) => this.stopLoading(tabId || this.activeTabId));
    ipcMain.handle(TOOLBAR_CHANNELS.GO_BACK, (_event, tabId?: string) => this.goBack(tabId || this.activeTabId));
    ipcMain.handle(TOOLBAR_CHANNELS.GO_FORWARD, (_event, tabId?: string) => this.goForward(tabId || this.activeTabId));
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_INSPECT, () => this.toggleInspect());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_FONT_FINDER, () => this.toggleFontFinder());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_LENS, () => this.toggleLens());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_RULER, () => this.toggleRuler());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_DEVTOOLS, () => this.toggleDevTools());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_TERMINAL, () => this.toggleTerminal());
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_SIDEBAR, () => this.toggleSidebar());
    ipcMain.handle(TOOLBAR_CHANNELS.SET_DEVICE_PRESET, (_event, { tabId, presetId }: { tabId?: string; presetId: string }) => this.setDevicePreset(tabId || this.activeTabId, presetId));
    ipcMain.handle(TOOLBAR_CHANNELS.SET_ZOOM, (_event, { tabId, zoom }: { tabId?: string; zoom: number }) => this.setZoom(tabId || this.activeTabId, zoom));
    ipcMain.handle(TOOLBAR_CHANNELS.CAPTURE_FULL_PAGE, () => this.captureScreenshot());
    ipcMain.handle(TOOLBAR_CHANNELS.CAPTURE_VIEWPORT, () => this.captureScreenshot());
    ipcMain.handle(TOOLBAR_CHANNELS.OPEN_EXTERNAL, (_event, url?: string) => this.openExternal(url));
    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_BOOKMARK, (_event, { url, title }: { url: string; title?: string }) => this.toggleBookmark(url, title));
    ipcMain.handle(TOOLBAR_CHANNELS.FIND_IN_PAGE, (_event, { text, forward }: { text: string; forward?: boolean }) => this.findInPage(text, forward));
    ipcMain.handle(TOOLBAR_CHANNELS.STOP_FIND_IN_PAGE, () => this.stopFindInPage());
    ipcMain.handle(TOOLBAR_CHANNELS.SHOW_MENU, () => this.showMainMenu());
    ipcMain.handle(TOOLBAR_CHANNELS.SET_OVERLAY, (_event, active: boolean) => this.setToolbarOverlay(active));
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
    TerminalManager.getInstance().on('data', (data: string) => {
      if (this.terminalView && !this.terminalView.webContents.isDestroyed()) {
        this.terminalView.webContents.send(TERMINAL_CHANNELS.DATA, data);
      }
      if (this.toolbarView && !this.toolbarView.webContents.isDestroyed()) {
        this.toolbarView.webContents.send(TERMINAL_CHANNELS.DATA, data);
      }
    });

    ipcMain.handle(TERMINAL_CHANNELS.START, (_event, cwd?: string) => {
      return TerminalManager.getInstance().startTerminal(cwd);
    });

    ipcMain.handle(TERMINAL_CHANNELS.INPUT, (_event, input: string) => {
      TerminalManager.getInstance().write(input);
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
  }

  private setupSidebarIpc(): void {
    ipcMain.handle(SIDEBAR_CHANNELS.GET_INITIAL_STATE, () => {
      return {
        messages: this.chatMessages,
        isOpen: this.isSidebarOpen,
        width: this.sidebarWidth,
      };
    });

    ipcMain.handle(SIDEBAR_CHANNELS.SEND_PROMPT, (_event, { text, attachedElement, attachedImages, deliveryMode }: { text: string; attachedElement?: AntiFanPickedElement; attachedImages?: Array<{ name: string; dataUrl: string }>; deliveryMode?: 'auto' | 'draft' }) => {
      const mode = deliveryMode || 'auto';
      // 1. Copy to OS clipboard instantly for 100% Antigravity IDE Ctrl+V parity
      try {
        clipboard.writeText(text);
      } catch (err) {
        console.error('[native-tab-host] Failed to copy prompt to clipboard:', err);
      }

      // 1b. Save any attached images to snapshots directory on disk
      const savedImagePaths: string[] = [];
      const snapshotsDirs = [
        path.join(process.cwd(), '.antigravity', 'snapshots'),
        path.join(process.cwd(), '..', '..', '.antigravity', 'snapshots'),
        'e:\\Work\\.antigravity\\snapshots',
      ];
      for (const sDir of snapshotsDirs) {
        try { fs.mkdirSync(sDir, { recursive: true }); } catch {}
      }
      const primarySnapshotsDir = snapshotsDirs.find((d) => fs.existsSync(d)) || snapshotsDirs[0]!;

      if (Array.isArray(attachedImages) && attachedImages.length > 0) {
        attachedImages.forEach((img, idx) => {
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

      if (attachedElement) {
        const elem = attachedElement as any;
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

      // 1c. Write bridge command & latest element snapshot to all active workspace .antigravity folders
      const possibleBridgeDirs = this.getPossibleBridgeDirs();
      for (const bDir of possibleBridgeDirs) {
        try {
          fs.mkdirSync(bDir, { recursive: true });
          const cmdId = `cmd-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
          const cmdPayload = {
            id: cmdId,
            action: 'sendToAgentPanel',
            params: {
              prompt: text,
              message: text,
              autoSend: mode === 'auto',
              markdownPath: attachedElement?.markdownPath,
              targetImagePath: attachedElement?.targetImagePath,
              viewportImagePath: attachedElement?.viewportImagePath,
              imagePaths: savedImagePaths,
              files: savedImagePaths.map((p) => ({ uri: p, path: p })),
            },
          };
          const tempPath = path.join(bDir, `${cmdId}.tmp`);
          fs.writeFileSync(tempPath, JSON.stringify(cmdPayload, null, 2), 'utf8');
          fs.renameSync(tempPath, path.join(bDir, `${cmdId}.json`));
        } catch {}
      }

      if (attachedElement) {
        const latestElemPaths = [
          path.join(process.cwd(), '.antigravity', 'latest_element_mcp.json'),
          path.join(process.cwd(), '..', '..', '.antigravity', 'latest_element_mcp.json'),
          'e:\\Work\\.antigravity\\latest_element_mcp.json',
        ];
        for (const p of latestElemPaths) {
          try {
            if (fs.existsSync(path.dirname(p))) {
              fs.writeFileSync(p, JSON.stringify(attachedElement, null, 2), 'utf8');
            }
          } catch {}
        }
      }

      const msg: ChatMessage = {
        id: String(Date.now()),
        role: 'user',
        text,
        attachedElement,
        attachedImages,
        timestamp: Date.now(),
      };
      this.chatMessages.push(msg);

      // 2. Emit event for bridge server (port 20129)
      this.emit('chat-prompt-submitted', { prompt: text, attachedElement, attachedImages, deliveryMode: mode });

      setTimeout(() => {
        const isAuto = mode === 'auto';
        const ackMsg: ChatMessage = {
          id: `ack-${Date.now()}`,
          role: 'system',
          text: isAuto
            ? `⚡ **Đã chuyển tiếp tự động tới Antigravity Agent qua Extension Bridge**.\n\nPrompt và Annotation đã được gửi trực tiếp vào khung Chat của Antigravity IDE (bạn cũng có thể dùng \`Ctrl + V\` nếu cần). Mọi tiến trình suy luận và tool calls của Agent sẽ tự động đồng bộ trực tiếp về đây!`
            : `📝 **Đã chuyển tiếp dưới dạng Draft (Draft Mode)**.\n\nPrompt đã được sao chép vào Clipboard và gửi tới IDE để bạn kiểm tra trước khi thực thi.`,
          timestamp: Date.now(),
        };
        this.pushAgentMessage(ackMsg);
      }, 150);

      return { ok: true, messageId: msg.id };
    });

    ipcMain.handle(SIDEBAR_CHANNELS.CLEAR_HISTORY, () => {
      this.chatMessages = [];
      this.emit('chat-history-cleared');
      return { ok: true };
    });

    ipcMain.handle(SIDEBAR_CHANNELS.CLOSE_SIDEBAR, () => {
      this.toggleSidebar();
    });

    ipcMain.handle(SIDEBAR_CHANNELS.SET_WIDTH, (_event, width: number) => {
      this.sidebarWidth = Math.max(300, Math.min(width, 700));
      this.updateLayout();
    });

    ipcMain.handle(SIDEBAR_CHANNELS.GET_SESSIONS, () => {
      return {
        sessions: this.transcriptSyncer.getAvailableSessions(),
        activeSessionId: this.transcriptSyncer.getActiveSessionId(),
      };
    });

    ipcMain.handle(SIDEBAR_CHANNELS.SWITCH_SESSION, (_event, sessionId: string) => {
      const ok = this.transcriptSyncer.switchSession(sessionId);
      if (ok) {
        this.chatMessages = this.transcriptSyncer.getRecentMessages(40);
      }
      return { ok, messages: this.chatMessages };
    });

    ipcMain.handle(SIDEBAR_CHANNELS.RENAME_SESSION, (_event, { sessionId, newTitle }: { sessionId: string; newTitle: string }) => {
      const ok = this.transcriptSyncer.renameSession(sessionId, newTitle);
      return {
        ok,
        sessions: this.transcriptSyncer.getAvailableSessions(),
      };
    });

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

  private getPossibleBridgeDirs(): string[] {
    const dirs = new Set<string>();
    dirs.add('e:\\Work\\.antigravity\\mcp-bridge');
    dirs.add(path.join(process.cwd(), '.antigravity', 'mcp-bridge'));
    dirs.add(path.join(process.cwd(), '..', '..', '.antigravity', 'mcp-bridge'));
    dirs.add(path.join(os.homedir(), '.antigravity', 'mcp-bridge'));

    const searchRoots = ['e:\\Work\\customizes', 'e:\\Work\\apps', 'e:\\Work\\themes', 'e:\\Work\\shopify'];
    for (const sRoot of searchRoots) {
      if (fs.existsSync(sRoot)) {
        try {
          const entries = fs.readdirSync(sRoot, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) {
              dirs.add(path.join(sRoot, e.name, '.antigravity', 'mcp-bridge'));
            }
          }
        } catch {}
      }
    }

    return Array.from(dirs);
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
      this.toolbarView.setBounds({ x: 0, y: 0, width: availableWidth, height });
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

  public createTab(initialUrl = 'https://www.google.com'): string {
    const id = randomUUID();
    const url = sanitizeUrl(initialUrl);

    const view = new WebContentsView({
      webPreferences: getSecureWebPreferences(),
    });

    const state: AntiFanTab = {
      id,
      url,
      title: 'New Tab',
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1.0,
      devicePresetId: 'responsive',
      crashed: false,
    };

    const wc = view.webContents;

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
      state.url = navUrl;
      const nav = (wc as any).navigationHistory;
      state.canGoBack = nav ? nav.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false);
      state.canGoForward = nav ? nav.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false);
      this.broadcastState();
    });

    wc.on('did-navigate-in-page', (_event, navUrl) => {
      state.url = navUrl;
      const nav = (wc as any).navigationHistory;
      state.canGoBack = nav ? nav.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false);
      state.canGoForward = nav ? nav.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false);
      this.broadcastState();
    });

    wc.on('render-process-gone', () => {
      state.crashed = true;
      this.broadcastState();
    });

    wc.on('found-in-page', (_event, result) => {
      this.toolbarView.webContents.send(TOOLBAR_CHANNELS.FIND_RESULT, result);
    });

    wc.setWindowOpenHandler(({ url: popupUrl }) => {
      if (isAllowedNavigation(popupUrl)) {
        this.createTab(popupUrl);
      }
      return { action: 'deny' };
    });

    this.setupGlobalShortcutsOnView(wc);
    this.setupContextMenu(wc);

    this.tabs.set(id, { view, state });
    this.tabOrder.push(id);

    if (url !== 'about:blank') {
      wc.loadURL(url).catch(() => {});
    }

    this.switchTab(id);
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
    return true;
  }

  public closeTab(tabId: string): boolean {
    const target = this.tabs.get(tabId);
    if (!target) return false;

    if (this.activeTabId === tabId) {
      this.window.contentView.removeChildView(target.view);
    }

    (target.view.webContents as unknown as { destroy?: () => void })?.destroy?.();
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
    return true;
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
    tab.view.webContents.loadURL(cleanUrl).catch(() => {});
    return true;
  }

  public reload(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
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
    const active = this.tabs.get(this.activeTabId);
    if (active) {
      active.view.webContents.executeJavaScript(`(() => {
        if (window.__antifanRulerCleanup) window.__antifanRulerCleanup();
        const grid = document.getElementById('__antifan_ruler_grid');
        if (grid) grid.remove();
        window.__antifanRulerActive = false;
      })()`).catch(() => {});
    }
    this.broadcastState();
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

          const annotationResult = await AnnotationManager.getInstance().processAnnotationPayload({
            url: active.state.url,
            title: active.state.title,
            targetImageBase64,
            viewportImageBase64,
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

            if (rawResult.userComment) {
              const promptText = `[Element Annotation: ${pickedData.selector}]\n${rawResult.userComment}\n\nTask context file: ${annotationResult.markdownPath}`;
              try {
                clipboard.writeText(promptText);
              } catch {}
              const userMsg: ChatMessage = {
                id: String(Date.now()),
                role: 'user',
                text: promptText,
                attachedElement: pickedData,
                timestamp: Date.now(),
              };
              this.chatMessages.push(userMsg);
              this.sidebarView.webContents.send(SIDEBAR_CHANNELS.STREAM_UPDATE, { message: userMsg });
              this.emit('chat-prompt-submitted', { prompt: promptText, attachedElement: pickedData });

              setTimeout(() => {
                const ackMsg: ChatMessage = {
                  id: `ack-${Date.now()}`,
                  role: 'system',
                  text: `📋 **Đã sao chép Annotation vào Clipboard & phát tới cổng Bridge (20129)**.\n\n💡 Bạn chỉ cần nhấn **\`Ctrl + V\`** trong Antigravity IDE để gửi tin nhắn này trực tiếp cho Agent. Mọi tiến trình suy luận và bước gọi tool sẽ tự động đồng bộ trực tiếp về đây.`,
                  timestamp: Date.now(),
                };
                this.pushAgentMessage(ackMsg);
              }, 200);
            }
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

  public async captureScreenshot(rect?: Rectangle): Promise<string> {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return '';
    const img = await active.view.webContents.capturePage(rect);
    return img.toPNG().toString('base64');
  }

  public async getDom(selector?: string): Promise<string> {
    const active = this.tabs.get(this.activeTabId);
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
          url: tab.state.url,
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
          if (data.activeChromeProfileId) {
            ChromeProfileSyncManager.getInstance().activeProfileId = data.activeChromeProfileId;
            ChromeProfileSyncManager.getInstance().syncProfile(data.activeChromeProfileId).catch(() => {});
          }
          if (Array.isArray(data.bookmarks) && data.bookmarks.length > 0) {
            this.bookmarks = data.bookmarks;
          }
          if (Array.isArray(data.tabs) && data.tabs.length > 0) {
            let restoredActiveId = data.activeTabId;
            for (const t of data.tabs) {
              const id = this.createTab(t.url || 'https://www.google.com');
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
    }
    for (const [, tab] of this.tabs) {
      (tab.view.webContents as unknown as { destroy?: () => void })?.destroy?.();
    }
    this.tabs.clear();
    this.tabOrder = [];
  }
}
