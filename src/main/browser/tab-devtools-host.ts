/**
 * AntiFan Browser Desktop — Tab DevTools Host Sub-Controller
 * Encapsulates In-Page Developer Utilities: Font Finder, GPU Lens, Screen Ruler,
 * Element Inspector / Picker Polling, Auto JSON Viewer, Page Source Viewer, and DOM Utilities.
 */

import path from 'node:path';
import { net, clipboard, Rectangle } from 'electron';
import { AntiFanTab, SplitPaneId, AntiFanPickedElement } from '../../shared/contracts';
import { FONT_FINDER_SCRIPT } from './font-finder';
import { GPU_LENS_SCRIPT } from './gpu-lens';
import { RULER_SCRIPT } from './ruler';
import { ELEMENT_PICKER_SCRIPT } from './element-picker';
import { dispatchAnnotationToTerminal, stripDeliveryMode } from './annotation-dispatch';
import { AnnotationManager } from '../bridge/annotation-manager';
import { TerminalManager } from './terminal-manager';
import type { NativeTabRecord } from './native-tab-host';
import type { SemanticElementDescriptor } from './semantic-ref-types';

export interface TabDevToolsContext {
  getTabWebContents: (tabId?: string, paneId?: SplitPaneId) => Electron.WebContents | null;
  getTabRecord: (tabId: string) => NativeTabRecord | undefined;
  getActiveTabId: () => string;
  getAllTabs: () => IterableIterator<[string, NativeTabRecord]>;
  broadcastState: () => void;
  emitInspectToggled?: (active: boolean) => void;
  emitElementPicked?: (picked: AntiFanPickedElement) => void;
  sendToolbarElementPicked?: (picked: AntiFanPickedElement) => void;
  getTabTerminalSession: (tabId: string) => string | undefined;
  resolveTargetWorkspace: (targetSessionId?: string, tabUrl?: string) => string;
  resolveAnnotationWorkspace: (targetSessionId?: string, tabUrl?: string) => string;
  getDiagnostics?: (tabId: string, level?: string) => { console?: Array<{ message: string; source?: string; line?: number; level?: number }>; failures?: Array<{ validatedURL?: string; errorDescription?: string; errorCode?: number }> } | null;
  createTab: (url?: string, activate?: boolean) => string;
  withTabAgentWorking: <T>(tabId: string, action: () => Promise<T>) => Promise<T>;
  runWithAttachedTabView?: <T>(view: Electron.WebContentsView | null | undefined, action: () => Promise<T>, isMobile?: boolean) => Promise<T>;
}
export interface TabDevToolsStats {
  attachedWebContentsCount: number;
  hostOwnedAttachmentCount: number;
  listenerTargetCount: number;
  queuedTargetCount: number;
  stylesheetTargetCount: number;
  isolatedContextCount: number;
}

export class TabDevToolsHost {
  private readonly ctx: TabDevToolsContext;
  private isFontFinderActive: boolean = false;
  private isLensActive: boolean = false;
  private isRulerActive: boolean = false;
  private isInspecting: boolean = false;
  private isProcessingInspectPick: boolean = false;
  public inspectGeneration: number = 0;
  public inspectedTabId: string | null = null;
  private cdpQueues = new Map<number, Promise<unknown>>();
  private cdpAttachedWebContents = new Set<number>();
  private cdpAttachedByHost = new Set<number>();
  private cdpWebContentsRefs = new Map<number, Electron.WebContents>();
  private cdpListeners = new Map<number, { onDetach: () => void; onNavigate?: () => void; onMessage?: (_event: Electron.Event, method: string, params: Record<string, unknown>) => void }>();
  private stylesheetUrls = new Map<number, Map<string, string>>();
  private isolatedContextIds = new Map<number, number>();
  constructor(ctx: TabDevToolsContext) {
    this.ctx = ctx;
  }
  public getIsFontFinderActive(): boolean { return this.isFontFinderActive; }
  public setIsFontFinderActive(val: boolean): void { this.isFontFinderActive = val; }
  public getIsLensActive(): boolean { return this.isLensActive; }
  public setIsLensActive(val: boolean): void { this.isLensActive = val; }
  public getIsRulerActive(): boolean { return this.isRulerActive; }
  public setIsRulerActive(val: boolean): void { this.isRulerActive = val; }
  public getIsInspecting(): boolean { return this.isInspecting; }
  public setIsInspecting(val: boolean): void { this.isInspecting = val; }
  public getInspectedTabId(): string | null { return this.inspectedTabId; }
  public setInspectedTabId(val: string | null): void { this.inspectedTabId = val; }
  public getStats(): TabDevToolsStats {
    return {
      attachedWebContentsCount: this.cdpAttachedWebContents.size,
      hostOwnedAttachmentCount: this.cdpAttachedByHost.size,
      listenerTargetCount: this.cdpListeners.size,
      queuedTargetCount: this.cdpQueues.size,
      stylesheetTargetCount: this.stylesheetUrls.size,
      isolatedContextCount: this.isolatedContextIds.size,
    };
  }


  // ─── Font Finder ───
  public toggleFontFinder(): boolean {
    if (this.isFontFinderActive) {
      this.stopFontFinder();
    } else {
      this.startFontFinder();
    }
    return this.isFontFinderActive;
  }

  public startFontFinder(): void {
    const active = this.ctx.getTabRecord(this.ctx.getActiveTabId());
    if (!active) return;
    this.isFontFinderActive = true;
    const targetWcs: Electron.WebContents[] = [];
    if (active.view && !active.view.webContents.isDestroyed()) {
      targetWcs.push(active.view.webContents);
    }
    if (active.state.splitMode && active.mobileView && !active.mobileView.webContents.isDestroyed()) {
      targetWcs.push(active.mobileView.webContents);
    }
    for (const wc of targetWcs) {
      wc.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
    }
    this.ctx.broadcastState();
  }

  public stopFontFinder(): void {
    this.isFontFinderActive = false;
    const active = this.ctx.getTabRecord(this.ctx.getActiveTabId());
    if (active) {
      const cleanScript = `(() => {
        const bg = document.getElementById('antifan-font-badge');
        if (bg) bg.remove();
        const ov = document.getElementById('antifan-font-overlay');
        if (ov) ov.remove();
        if (typeof window.__antifanFontFinderCleanup === 'function') window.__antifanFontFinderCleanup();
        if (document.documentElement) document.documentElement.style.cursor = '';
        window.__antifanFontFinderActive = false;
      })()`;
      if (active.view && !active.view.webContents.isDestroyed()) {
        active.view.webContents.executeJavaScript(cleanScript).catch(() => {});
      }
      if (active.state.splitMode && active.mobileView && !active.mobileView.webContents.isDestroyed()) {
        active.mobileView.webContents.executeJavaScript(cleanScript).catch(() => {});
      }
    }
    this.ctx.broadcastState();
  }

  // ─── GPU Lens ───
  public toggleLens(): boolean {
    if (this.isLensActive) {
      this.stopLens();
    } else {
      this.startLens();
    }
    return this.isLensActive;
  }

  public async startLens(): Promise<void> {
    const active = this.ctx.getTabRecord(this.ctx.getActiveTabId());
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
      console.error('[tab-devtools-host] Failed to capture page for lens:', err);
    }
    active.view.webContents.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
    this.ctx.broadcastState();
  }

  public stopLens(): void {
    this.isLensActive = false;
    const active = this.ctx.getTabRecord(this.ctx.getActiveTabId());
    if (active) {
      active.view.webContents.executeJavaScript(`(() => {
        if (window.__antifanLensCleanup) window.__antifanLensCleanup();
        const lens = document.getElementById('antifan-gpu-lens');
        if (lens) lens.remove();
        window.__antifanLensActive = false;
      })()`).catch(() => {});
    }
    this.ctx.broadcastState();
  }

  // ─── Ruler ───
  public toggleRuler(): boolean {
    if (this.isRulerActive) {
      this.stopRuler();
    } else {
      this.startRuler();
    }
    return this.isRulerActive;
  }

  public startRuler(): void {
    const active = this.ctx.getTabRecord(this.ctx.getActiveTabId());
    if (!active) return;
    this.isRulerActive = true;
    active.view.webContents.executeJavaScript(RULER_SCRIPT).catch(() => {});
    this.ctx.broadcastState();
  }

  public stopRuler(): void {
    this.isRulerActive = false;
    for (const [, tab] of this.ctx.getAllTabs()) {
      tab.view.webContents.executeJavaScript(`(() => {
        if (window.__antifanRulerCleanup) window.__antifanRulerCleanup();
        const grid = document.getElementById('__antifan_ruler_grid');
        if (grid) grid.remove();
        window.__antifanRulerActive = false;
      })()`).catch(() => {});
    }
    this.ctx.broadcastState();
  }

  // ─── Element Inspector ───
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
    const activeTabId = this.ctx.getActiveTabId();
    if (this.isInspecting && this.inspectedTabId === activeTabId) {
      return;
    }
    const active = this.ctx.getTabRecord(activeTabId);
    if (!active) return;
    this.inspectedTabId = activeTabId;
    this.inspectGeneration++;
    const currentGeneration = this.inspectGeneration;
    const tm = TerminalManager.getInstance();
    const activeSessionId = tm.getActiveSessionId();
    const tabSessionId = this.ctx.getTabTerminalSession(activeTabId);
    const termContextData: Record<string, unknown> = {
      tabId: activeTabId,
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
    this.isProcessingInspectPick = false;

    const targetWcs: Array<{ wc: Electron.WebContents; paneId: SplitPaneId }> = [];
    if (active.view && !active.view.webContents.isDestroyed()) {
      targetWcs.push({ wc: active.view.webContents, paneId: 'desktop' });
    }
    if (active.state.splitMode && active.mobileView && !active.mobileView.webContents.isDestroyed()) {
      targetWcs.push({ wc: active.mobileView.webContents, paneId: 'mobile' });
    }
    for (const { wc, paneId } of targetWcs) {
      wc.executeJavaScript(`${termContextScript}\n${ELEMENT_PICKER_SCRIPT}`).catch(() => {});
      this.attachInspectPickListener(activeTabId, wc, paneId, currentGeneration);
    }
    this.ctx.broadcastState();
  }

  private async attachInspectPickListener(
    targetTabId: string,
    wc: Electron.WebContents,
    paneId: SplitPaneId,
    currentGeneration: number
  ): Promise<void> {
    try {
      const waitScript = `(() => {
        try {
          if (typeof window.__antifanPickWaiterCleanup === 'function') {
            window.__antifanPickWaiterCleanup();
          }
        } catch {}

        return new Promise((resolve) => {
          if (window.__antifanPick) {
            const r = window.__antifanPick;
            window.__antifanPick = null;
            resolve(r);
            return;
          }
          const cleanupWaiter = () => {
            window.removeEventListener('antifan-pick-event', onPick);
            try {
              delete window.__antifanPickWaiterCleanup;
            } catch {}
          };
          const onPick = (e) => {
            cleanupWaiter();
            const r = e.detail || window.__antifanPick || null;
            window.__antifanPick = null;
            resolve(r);
          };
          window.__antifanPickWaiterCleanup = () => {
            cleanupWaiter();
            resolve(null);
          };
          window.addEventListener('antifan-pick-event', onPick, { once: true });
        });
      })()`;
      const rawResult = await wc.executeJavaScript(waitScript).catch(() => null);
      if (this.inspectGeneration !== currentGeneration || !this.isInspecting) {
        return;
      }
      if (rawResult && !this.isProcessingInspectPick) {
        await this.handleInspectPickResult(targetTabId, wc, paneId, currentGeneration, rawResult);
      }
    } catch (err) {
      console.error('[tab-devtools-host] attachInspectPickListener error:', err);
    }
  }

  private async handleInspectPickResult(
    targetTabId: string,
    wc: Electron.WebContents,
    paneId: SplitPaneId,
    currentGeneration: number,
    rawResult: any
  ): Promise<void> {
    if (this.isProcessingInspectPick) return;
    this.isProcessingInspectPick = true;
    this.stopInspect(targetTabId, true);
    if (rawResult.canceled) {
      this.isProcessingInspectPick = false;
      return;
    }

    try {
      const targetTab = this.ctx.getTabRecord(targetTabId);
      if (!targetTab) return;
      const liveSessions = TerminalManager.getInstance().listSessions();

      if (targetTab.state.splitMode) {
        targetTab.focusedPane = paneId;
        targetTab.state.splitFocusedPane = paneId;
        this.ctx.broadcastState();
      }

      if (typeof rawResult.targetSessionId === 'string' && (rawResult.targetSessionId === 'auto' || liveSessions.some((s) => s.id === rawResult.targetSessionId))) {
        targetTab.state.terminalSessionId = rawResult.targetSessionId;
      }

      let targetImageBase64: string | undefined = rawResult.targetImageBase64 || rawResult.screenshotBase64;
      let viewportImageBase64: string | undefined = rawResult.viewportImageBase64;

      try {
        if (!wc.isDestroyed()) {
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
        }
      } catch (err) {
        console.error('[tab-devtools-host] capture and crop error:', err);
      }

      const tm = TerminalManager.getInstance();
      const tmActiveId = tm.getActiveSessionId();
      const targetSessionId = rawResult.targetSessionId || (tmActiveId !== 'auto' ? tmActiveId : undefined);
      const targetWorkspace = this.ctx.resolveTargetWorkspace(targetSessionId, targetTab?.state.url);
      const annotationWorkspace = this.ctx.resolveAnnotationWorkspace(targetSessionId, targetTab?.state.url);
      const tabDiag = (this.ctx.getDiagnostics && typeof this.ctx.getDiagnostics === 'function')
        ? this.ctx.getDiagnostics(targetTabId, 'error')
        : { console: [], failures: [] };
      const recentErrors = (tabDiag?.console || []).slice(-10).map((c) => ({
        message: c.message,
        source: c.source ? `${c.source}:${c.line}` : undefined,
        level: c.level === 3 ? 'error' : 'warning',
      }));
      const recentFailures = (tabDiag?.failures || []).slice(-10).map((f) => ({
        url: f.validatedURL,
        error: f.errorDescription,
        code: f.errorCode,
      }));

      const annotationResult = await AnnotationManager.getInstance().processAnnotationPayload({
        ...rawResult,
        url: targetTab.state.url,
        title: targetTab.state.title,
        targetImageBase64,
        viewportImageBase64,
        workspaceDir: annotationWorkspace,
        runtimeErrors: rawResult.runtimeErrors || (recentErrors.length > 0 ? recentErrors : undefined),
        resourceFailures: rawResult.resourceFailures || (recentFailures.length > 0 ? recentFailures : undefined),
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

      if (this.ctx.emitElementPicked) {
        this.ctx.emitElementPicked(pickedData);
      }
      if (this.ctx.sendToolbarElementPicked) {
        this.ctx.sendToolbarElementPicked(pickedData);
      }

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

      const rawComment = rawResult.userComment?.trim() || 'Inspect the attached browser annotation, report observed evidence, and ask for the intended outcome before editing.';
      const promptText = rawComment.replace(/^(\s*\/queue\b\s*)+/gi, '/queue ');
      let fullPrompt = promptText;
      if (annotationResult.markdownPath) {
        fullPrompt += ` @${formatPath(annotationResult.markdownPath)}`;
      }
      if (annotationResult.targetImagePath) {
        fullPrompt += ` @${formatPath(annotationResult.targetImagePath)}`;
      }

      dispatchAnnotationToTerminal(tm, targetSessionId, fullPrompt);

      try {
        clipboard.writeText(fullPrompt);
      } catch {}
    } finally {
      this.isProcessingInspectPick = false;
    }
  }

  public stopInspect(targetTabId?: string, preserveProcessingLock: boolean = false): void {
    this.inspectGeneration++;
    this.isInspecting = false;
    if (!preserveProcessingLock) {
      this.isProcessingInspectPick = false;
    }
    const tabIdToClean = targetTabId || this.inspectedTabId || this.ctx.getActiveTabId();
    this.inspectedTabId = null;
    const target = this.ctx.getTabRecord(tabIdToClean);
    if (target) {
      const cleanScript = `(() => {
        try { if (typeof window.__antifanPickerCleanup === 'function') window.__antifanPickerCleanup(); } catch {}
        try { if (typeof window.__antifanPickWaiterCleanup === 'function') window.__antifanPickWaiterCleanup(); } catch {}
        document.querySelectorAll('#antifan-inspect-overlay, #antifan-inspect-badge, #antifan-comment-modal, #antifan-multi-dock, .antifan-element-pin').forEach(el => {
          try { el.remove(); } catch {}
        });
        if (document.documentElement) document.documentElement.style.cursor = '';
        window.__antifanPickerActive = false;
      })()`;
      if (target.view?.webContents && !target.view.webContents.isDestroyed()) {
        target.view.webContents.executeJavaScript(cleanScript).catch(() => {});
      }
      if (target.state?.splitMode && target.mobileView?.webContents && !target.mobileView.webContents.isDestroyed()) {
        target.mobileView.webContents.executeJavaScript(cleanScript).catch(() => {});
      }
    }
    if (this.ctx.emitInspectToggled) {
      this.ctx.emitInspectToggled(false);
    }
    this.ctx.broadcastState();
  }

  // ─── Find in Page ───
  public findInPage(text: string, forward = true, findNext = false): void {
    const active = this.ctx.getTabRecord(this.ctx.getActiveTabId());
    if (!active || !text) return;
    active.view.webContents.findInPage(text, { forward, findNext });
  }

  public stopFindInPage(): void {
    const active = this.ctx.getTabRecord(this.ctx.getActiveTabId());
    if (active) {
      active.view.webContents.stopFindInPage('clearSelection');
    }
  }

  // ─── CDP Low-Level Command Queue & Transport ───
  public async sendCdpCommand<T = unknown>(
    wc: Electron.WebContents,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000
  ): Promise<T> {
    if (!wc || wc.isDestroyed()) {
      throw new Error(`WebContents is destroyed or unavailable for CDP method ${method}`);
    }
    const wcId = wc.id;
    if (!this.cdpAttachedWebContents.has(wcId)) {
      if (!wc.debugger.isAttached()) {
        try {
          wc.debugger.attach('1.3');
          this.cdpAttachedByHost.add(wcId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('Already attached')) {
            throw err;
          }
        }
      }
      this.cdpAttachedWebContents.add(wcId);
      this.cdpWebContentsRefs.set(wcId, wc);

      const onDetach = () => {
        this.cdpAttachedWebContents.delete(wcId);
        this.cdpAttachedByHost.delete(wcId);
        this.cdpWebContentsRefs.delete(wcId);
        this.cdpQueues.delete(wcId);
        this.stylesheetUrls.delete(wcId);
        this.isolatedContextIds.delete(wcId);
        const l = this.cdpListeners.get(wcId);
        if (l?.onNavigate && typeof wc.removeListener === 'function') {
          try { wc.removeListener('did-navigate', l.onNavigate); } catch {}
        }
        if (l?.onMessage && typeof wc.debugger.removeListener === 'function') {
          try { wc.debugger.removeListener('message', l.onMessage); } catch {}
        }
        this.cdpListeners.delete(wcId);
      };

      const onNavigate = () => {
        this.isolatedContextIds.delete(wcId);
        this.stylesheetUrls.delete(wcId);
      };

      const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
        if (method !== 'CSS.styleSheetAdded') return;
        const header = params?.header;
        if (!header || typeof header !== 'object') return;
        const typedHeader = header as { styleSheetId?: unknown; sourceURL?: unknown };
        if (typeof typedHeader.styleSheetId !== 'string' || typeof typedHeader.sourceURL !== 'string' || !typedHeader.sourceURL) return;
        const urls = this.stylesheetUrls.get(wcId) || new Map<string, string>();
        urls.set(typedHeader.styleSheetId, typedHeader.sourceURL);
        this.stylesheetUrls.set(wcId, urls);
      };

      wc.debugger.once('detach', onDetach);
      if (typeof wc.debugger.on === 'function') {
        wc.debugger.on('message', onMessage);
      }
      if (typeof wc.on === 'function') {
        wc.on('did-navigate', onNavigate);
      }
      this.cdpListeners.set(wcId, { onDetach, onNavigate, onMessage });
    }
    const currentQueue = this.cdpQueues.get(wcId) || Promise.resolve();
    const nextPromise = currentQueue.then(async () => {
      if (wc.isDestroyed()) {
        throw new Error(`WebContents destroyed before executing CDP method ${method}`);
      }
      const boundedTimeoutMs = Math.min(30_000, Math.max(1, timeoutMs));
      let timer: NodeJS.Timeout | undefined;
      const command = wc.debugger.sendCommand(method, params);
      command.catch(() => {});
      return Promise.race([
        command,
        (() => {
          const { promise, reject } = Promise.withResolvers<never>();
          timer = setTimeout(
            () => reject(new Error(`CDP command ${method} timed out after ${boundedTimeoutMs}ms`)),
            boundedTimeoutMs
          );
          return promise;
        })(),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    });

    this.cdpQueues.set(
      wcId,
      nextPromise.catch(() => {})
    );

    return nextPromise as Promise<T>;
  }

  public async describeNodeByObjectId(
    wc: Electron.WebContents,
    objectId: string
  ): Promise<number | undefined> {
    try {
      const res = await this.sendCdpCommand<{ node?: { backendNodeId?: number } }>(
        wc,
        'DOM.describeNode',
        { objectId }
      );
      return res?.node?.backendNodeId;
    } catch {
      return undefined;
    }
  }

  public async getPlatformFontsForNode(
    wc: Electron.WebContents,
    options: { selector?: string; objectId?: string } = {}
  ): Promise<Array<{ familyName: string; isCustomFont: boolean; glyphCount: number }>> {
    if (!wc || wc.isDestroyed()) return [];
    try {
      await this.sendCdpCommand(wc, 'DOM.enable');
      await this.sendCdpCommand(wc, 'CSS.enable');

      let targetNodeId: number | undefined;

      // 1. Try resolving via objectId if provided
      if (options.objectId) {
        try {
          const reqRes = await this.sendCdpCommand<{ nodeId?: number }>(wc, 'DOM.requestNode', {
            objectId: options.objectId,
          });
          targetNodeId = reqRes?.nodeId;
        } catch {}
      }

      // 2. Try resolving via window.__antifan_last_inspected_font_element if no targetNodeId yet
      if (!targetNodeId) {
        try {
          const evalRes = await this.sendCdpCommand<{ result?: { objectId?: string } }>(wc, 'Runtime.evaluate', {
            expression: 'window.__antifan_last_inspected_font_element',
            returnByValue: false,
          });
          if (evalRes?.result?.objectId) {
            const reqRes = await this.sendCdpCommand<{ nodeId?: number }>(wc, 'DOM.requestNode', {
              objectId: evalRes.result.objectId,
            });
            targetNodeId = reqRes?.nodeId;
          }
        } catch {}
      }

      // 3. Try resolving via querySelector from DOM document root
      if (!targetNodeId && options.selector) {
        try {
          const doc = await this.sendCdpCommand<{ root?: { nodeId?: number } }>(wc, 'DOM.getDocument', { depth: 0 });
          const rootId = doc?.root?.nodeId;
          if (rootId) {
            const query = await this.sendCdpCommand<{ nodeId?: number }>(wc, 'DOM.querySelector', {
              nodeId: rootId,
              selector: options.selector,
            });
            targetNodeId = query?.nodeId;
          }
        } catch {}
      }

      // Cleanup window.__antifan_last_inspected_font_element
      try {
        await this.sendCdpCommand(wc, 'Runtime.evaluate', {
          expression: 'delete window.__antifan_last_inspected_font_element',
          returnByValue: true,
        }).catch(() => {});
      } catch {}

      if (!targetNodeId) {
        return [];
      }

      const res = await this.sendCdpCommand<{
        fonts?: Array<{ familyName: string; isCustomFont: boolean; glyphCount: number }>;
      }>(wc, 'CSS.getPlatformFontsForNode', { nodeId: targetNodeId });

      if (Array.isArray(res?.fonts)) {
        return res.fonts.map((f) => ({
          familyName: String(f.familyName || ''),
          isCustomFont: Boolean(f.isCustomFont),
          glyphCount: Number(f.glyphCount || 0),
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  public async getMatchedStylesForNode(
    wc: Electron.WebContents,
    options: { nodeId?: number; selector?: string; objectId?: string; descriptor?: SemanticElementDescriptor } = {}
  ): Promise<Record<string, unknown> | null> {
    if (!wc || wc.isDestroyed()) return null;
    try {
      await this.sendCdpCommand(wc, 'DOM.enable');
      await this.sendCdpCommand(wc, 'CSS.enable');

      let targetNodeId = options.nodeId;

      if (!targetNodeId && options.objectId) {
        try {
          const reqRes = await this.sendCdpCommand<{ nodeId?: number }>(wc, 'DOM.requestNode', {
            objectId: options.objectId,
          });
          targetNodeId = reqRes?.nodeId;
        } catch {}
      }

      if (!targetNodeId && options.descriptor) {
        try {
          const contextId = await this.getOrCreateIsolatedWorldContext(wc);
          const descJson = JSON.stringify(options.descriptor);
          const evalExpr = `(() => {
            const desc = ${descJson};
            function matchesFingerprint(el, fp) {
              if (!el || !(el instanceof Element) || !fp || typeof fp !== 'object') return false;
              if (fp.tag && el.tagName.toLowerCase() !== String(fp.tag).toLowerCase()) return false;
              if (fp.id && el.id !== fp.id) return false;
              if (fp.role && el.getAttribute('role') !== fp.role) return false;
              if (fp.type && el.getAttribute('type') !== fp.type && el.type !== fp.type) return false;
              if (fp.name && el.getAttribute('name') !== fp.name) return false;
              if (fp.classHint) {
                const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
                if (!cls.includes(fp.classHint)) return false;
              }
              return true;
            }
            function resolveTraversalPath(path) {
              if (!Array.isArray(path) || path.length === 0) return null;
              let current = document;
              for (let i = 0; i < path.length; i++) {
                const step = path[i];
                if (!step || typeof step !== 'object') return null;
                if (step.kind === 'dom') {
                  const children = Array.from(current.children || []);
                  let candidate = children[step.index] || null;
                  if (!candidate && step.id) {
                    if (typeof current.getElementById === 'function') {
                      candidate = current.getElementById(step.id);
                    }
                  }
                  if (!candidate) return null;
                  current = candidate;
                } else if (step.kind === 'shadow') {
                  if (!current.shadowRoot) return null;
                  current = current.shadowRoot;
                } else if (step.kind === 'iframe') {
                  try {
                    if (!current.contentDocument) return null;
                    current = current.contentDocument;
                  } catch {
                    return null;
                  }
                } else {
                  return null;
                }
              }
              return current instanceof Element ? current : null;
            }
            let el = resolveTraversalPath(desc.path);
            if (!el && desc.id) el = document.getElementById(desc.id);
            if (!el && desc.fingerprint && desc.fingerprint.id) el = document.getElementById(desc.fingerprint.id);
            return (el && matchesFingerprint(el, desc.fingerprint)) ? el : null;
          })()`;

          const evalRes = await this.sendCdpCommand<{ result?: { objectId?: string; subtype?: string } }>(
            wc,
            'Runtime.evaluate',
            {
              expression: evalExpr,
              contextId,
              returnByValue: false,
            }
          );

          if (evalRes?.result?.objectId && evalRes.result.subtype !== 'null') {
            const reqRes = await this.sendCdpCommand<{ nodeId?: number }>(wc, 'DOM.requestNode', {
              objectId: evalRes.result.objectId,
            });
            targetNodeId = reqRes?.nodeId;
          }
        } catch {}
      }

      if (!targetNodeId && options.selector) {
        try {
          const doc = await this.sendCdpCommand<{ root?: { nodeId?: number } }>(wc, 'DOM.getDocument', { depth: 0 });
          const rootId = doc?.root?.nodeId;
          if (rootId) {
            const query = await this.sendCdpCommand<{ nodeId?: number }>(wc, 'DOM.querySelector', {
              nodeId: rootId,
              selector: options.selector,
            });
            targetNodeId = query?.nodeId;
          }
        } catch {}
      }

      if (!targetNodeId) {
        return null;
      }

      const res = await this.sendCdpCommand<Record<string, unknown>>(wc, 'CSS.getMatchedStylesForNode', {
        nodeId: targetNodeId,
      });
      if (!res) return null;

      const urls = this.stylesheetUrls.get(wc.id);
      if (!urls || urls.size === 0 || !Array.isArray(res.matchedCSSRules)) return res;
      return {
        ...res,
        matchedCSSRules: res.matchedCSSRules.map((item: unknown) => {
          if (!item || typeof item !== 'object') return item;
          const typedItem = item as { rule?: Record<string, unknown> };
          const rule = typedItem.rule;
          if (!rule || typeof rule !== 'object' || typeof rule.sourceUrl === 'string') return item;
          const style = rule.style && typeof rule.style === 'object' ? rule.style as Record<string, unknown> : undefined;
          const styleSheetId = typeof rule.styleSheetId === 'string'
            ? rule.styleSheetId
            : typeof style?.styleSheetId === 'string' ? style.styleSheetId : undefined;
          const sourceUrl = styleSheetId ? urls.get(styleSheetId) : undefined;
          return sourceUrl ? { ...typedItem, rule: { ...rule, sourceUrl } } : item;
        }),
      };
    } catch {
      return null;
    }
  }

  public async getOrCreateIsolatedWorldContext(wc: Electron.WebContents): Promise<number | undefined> {
    if (!wc || wc.isDestroyed()) return undefined;
    const wcId = wc.id;
    if (this.isolatedContextIds.has(wcId)) {
      return this.isolatedContextIds.get(wcId);
    }
    try {
      await this.sendCdpCommand(wc, 'Page.enable');
      const frameTree = await this.sendCdpCommand<{ frameTree?: { frame?: { id?: string } } }>(wc, 'Page.getFrameTree');
      const frameId = frameTree?.frameTree?.frame?.id;
      if (frameId) {
        const res = await this.sendCdpCommand<{ executionContextId?: number }>(wc, 'Page.createIsolatedWorld', {
          frameId,
          worldName: 'AntifanAgentWorld1004',
          grantUniveralAccess: true,
        });
        if (res?.executionContextId) {
          this.isolatedContextIds.set(wcId, res.executionContextId);
          return res.executionContextId;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  // ─── DOM / Screenshot / Eval Utilities ───
  public async withDeviceMetricsOverride<T>(
    tabId: string,
    metrics: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean },
    action: () => Promise<T>,
    paneId?: SplitPaneId
  ): Promise<T> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) throw new Error(`Tab not found: ${targetId}`);
    const wc = this.ctx.getTabWebContents(targetId, paneId || target.focusedPane);
    if (!wc || wc.isDestroyed()) throw new Error(`WebContents unavailable for tab: ${targetId}`);

    await this.sendCdpCommand(wc, 'Emulation.setDeviceMetricsOverride', {
      width: Math.max(1, Math.round(metrics.width)),
      height: Math.max(1, Math.round(metrics.height)),
      deviceScaleFactor: metrics.deviceScaleFactor || 1,
      mobile: Boolean(metrics.mobile),
    });

    try {
      return await action();
    } finally {
      if (!wc.isDestroyed()) {
        await this.sendCdpCommand(wc, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
    }
  }

  public async captureScreenshot(rect?: Rectangle, tabId?: string, paneId?: SplitPaneId, options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; maskSelectors?: string[] }): Promise<string> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) return '';
    const wc = this.ctx.getTabWebContents(targetId, paneId || target.focusedPane);
    if (!wc || wc.isDestroyed()) return '';
    if (target.view && typeof target.view.getBounds === 'function') {
      const bounds = target.view.getBounds();
      if (!bounds || bounds.width === 0 || bounds.height === 0) {
        const ctxAny = this.ctx as unknown as { getTabContentBounds?: (id: string, pane?: SplitPaneId) => { width: number; height: number } };
        const mainBounds = ctxAny.getTabContentBounds ? ctxAny.getTabContentBounds(targetId, paneId || target.focusedPane) : { width: 1200, height: 800 };
        target.view.setBounds({ x: 0, y: 0, width: mainBounds.width || 1200, height: mainBounds.height || 800 });
      }
    }
    const format = options?.format === 'jpeg' ? 'jpeg' : 'png';
    const rawQuality = typeof options?.quality === 'number' ? options.quality : 80;
    const quality = Math.max(1, Math.min(100, Math.round(rawQuality <= 1 && rawQuality > 0 ? rawQuality * 100 : rawQuality)));
    const isFullPage = Boolean(options?.fullPage);
    return this.ctx.withTabAgentWorking(targetId, async () => {
      let maskStyleInjected = false;
      const maskStyleId = '__antifan_screenshot_mask_style';
      if (options?.maskSelectors && Array.isArray(options.maskSelectors) && options.maskSelectors.length > 0) {
        try {
          const selectorList = options.maskSelectors.map((s: string) => String(s).replace(/'/g, "\\'")).join(', ');
          await this.evalJs(
            `(() => {
              let el = document.getElementById('${maskStyleId}');
              if (!el) {
                el = document.createElement('style');
                el.id = '${maskStyleId}';
                el.textContent = '${selectorList} { visibility: hidden !important; opacity: 0 !important; }';
                document.head.appendChild(el);
              }
            })()`,
            targetId,
            paneId
          );
          maskStyleInjected = true;
        } catch {}
      }

      try {
        const captureAction = async (): Promise<string> => {
          const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
            let timer: NodeJS.Timeout | undefined;
            const timeoutPromise = new Promise<T>((resolve) => {
              timer = setTimeout(() => resolve(fallback), ms);
            });
            p.catch(() => {});
            return Promise.race([p, timeoutPromise]).finally(() => {
              clearTimeout(timer);
            });
          };
        // Full-page CDP capture bypasses Tier 1 (wc.capturePage is strictly viewport-only)
        if (isFullPage) {
          try {
            const fullPageTask = async (): Promise<string | null> => {
              await this.sendCdpCommand(wc, 'Page.enable');
              const metrics = await this.sendCdpCommand<{
                contentSize?: { width: number; height: number };
                cssContentSize?: { width: number; height: number };
                visualViewport?: { clientWidth: number; clientHeight: number };
                layoutViewport?: { clientWidth: number; clientHeight: number };
              }>(wc, 'Page.getLayoutMetrics').catch(() => null);

              let contentWidth = metrics?.contentSize?.width || metrics?.cssContentSize?.width;
              let contentHeight = metrics?.contentSize?.height || metrics?.cssContentSize?.height;
              const vpWidth = metrics?.visualViewport?.clientWidth || metrics?.layoutViewport?.clientWidth || 1200;
              const vpHeight = metrics?.visualViewport?.clientHeight || metrics?.layoutViewport?.clientHeight || 800;

              // If content dimensions are missing or height appears truncated to viewport, query DOM scroll dimensions directly
              if (!contentHeight || contentHeight <= vpHeight || !contentWidth) {
                try {
                  const docDims = await this.sendCdpCommand<{ result?: { value?: { width?: number; height?: number } } }>(
                    wc,
                    'Runtime.evaluate',
                    {
                      expression: '({ width: Math.max(document.documentElement ? document.documentElement.scrollWidth : 0, document.body ? document.body.scrollWidth : 0, document.scrollingElement ? document.scrollingElement.scrollWidth : 0), height: Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0, document.scrollingElement ? document.scrollingElement.scrollHeight : 0) })',
                      returnByValue: true,
                    }
                  ).catch(() => null);
                  if (docDims?.result?.value?.height) {
                    contentHeight = Math.max(contentHeight || 0, docDims.result.value.height);
                  }
                  if (docDims?.result?.value?.width) {
                    contentWidth = Math.max(contentWidth || 0, docDims.result.value.width);
                  }
                } catch {}
              }

              const rawW = Math.round(contentWidth || vpWidth);
              const rawH = Math.round(contentHeight || vpHeight);
              let safeWidth = Number.isFinite(rawW) ? Math.max(1, Math.min(rawW, 16384)) : 1200;
              let safeHeight = Number.isFinite(rawH) ? Math.max(1, Math.min(rawH, 16384)) : 800;
              const maxPixels = 268435456;
              if (safeWidth * safeHeight > maxPixels) {
                safeHeight = Math.floor(maxPixels / safeWidth);
              }

              const cdpRes = await this.sendCdpCommand<{ data?: string }>(wc, 'Page.captureScreenshot', {
                format,
                quality: format === 'jpeg' ? quality : undefined,
                fromSurface: false,
                captureBeyondViewport: true,
                clip: { x: 0, y: 0, width: safeWidth, height: safeHeight, scale: 1 },
              });

              return (cdpRes && typeof cdpRes.data === 'string' && cdpRes.data.length > 0) ? cdpRes.data : null;
            };

            const fullPageResult = await withTimeout(fullPageTask(), 20000, null);
            if (fullPageResult && fullPageResult.length > 0) {
              return fullPageResult;
            }
            this.cdpQueues.delete(wc.id);
            throw new Error('FULLPAGE_CAPTURE_TIMEOUT: CDP full-page screenshot timed out after 20000ms. Consider freezing media or checking page complexity.');
          } catch (err: any) {
            console.error('[AntiFan DevTools] Full-page capture error:', err);
            throw err;
          }
        }
        // Tier 1: Fast webContents.capturePage() with 600ms race
        try {
          const img = await withTimeout(wc.capturePage(rect), 600, null);
          if (img && typeof img.isEmpty === 'function' && !img.isEmpty()) {
            if (format === 'jpeg' && typeof img.toJPEG === 'function') {
              return img.toJPEG(quality).toString('base64');
            }
            return img.toPNG().toString('base64');
          }
          if (img && typeof img.toPNG === 'function') {
            if (format === 'jpeg' && typeof img.toJPEG === 'function') {
              const jpegBuf = img.toJPEG(quality);
              if (jpegBuf.length > 0) return jpegBuf.toString('base64');
            }
            const pngBuf = img.toPNG();
            if (pngBuf.length > 0) {
              return pngBuf.toString('base64');
            }
          }
        } catch {}

        // Tier 2: CDP Page.captureScreenshot with surface sync & compositor wake kick (800ms race)
        try {
          const cdpTask = async (): Promise<string | null> => {
            await this.sendCdpCommand(wc, 'Page.enable');
            await this.sendCdpCommand(wc, 'DOM.getDocument', { depth: 1 }).catch(() => {});
            const cdpRes = await this.sendCdpCommand<{ data?: string }>(wc, 'Page.captureScreenshot', {
              format,
              quality: format === 'jpeg' ? quality : undefined,
              fromSurface: true,
              captureBeyondViewport: false,
              clip: rect
                ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
                : undefined,
            });
            return (cdpRes && typeof cdpRes.data === 'string' && cdpRes.data.length > 0) ? cdpRes.data : null;
          };
          const cdpResult = await withTimeout(cdpTask(), 800, null);
          if (cdpResult && cdpResult.length > 0) {
            return cdpResult;
          }
        } catch {}

        // Tier 3: Offscreen Native View Paint Fallback (1000ms race)
        try {
          const offscreenTask = async (): Promise<string | null> => {
            const cdpRes = await this.sendCdpCommand<{ data?: string }>(wc, 'Page.captureScreenshot', {
              format,
              quality: format === 'jpeg' ? quality : undefined,
              fromSurface: false,
              captureBeyondViewport: true,
              clip: rect
                ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
                : undefined,
            });
            return (cdpRes && typeof cdpRes.data === 'string' && cdpRes.data.length > 0) ? cdpRes.data : null;
          };
          const tier3Result = await withTimeout(offscreenTask(), 1000, null);
          if (tier3Result && tier3Result.length > 0) {
            return tier3Result;
          }
        } catch {}
        // If all 3 tiers yielded empty string, do a fast retry after 100ms
        try {
          await new Promise((r) => setTimeout(r, 100));
          const retryImg = await withTimeout(wc.capturePage(rect), 800, null);
          if (retryImg && typeof retryImg.isEmpty === 'function' && !retryImg.isEmpty()) {
            return format === 'jpeg' ? retryImg.toJPEG(quality).toString('base64') : retryImg.toPNG().toString('base64');
          }
        } catch {}

        return '';
      };

      const isMobile = (paneId || target.focusedPane) === 'mobile';
      const targetPaneView = isMobile ? (target.mobileView || target.view) : target.view;
      let result = '';
      if (this.ctx.runWithAttachedTabView && targetPaneView) {
        result = await this.ctx.runWithAttachedTabView(targetPaneView, captureAction, isMobile);
      } else {
        result = await captureAction();
      }
      return result;
    } finally {
      if (maskStyleInjected) {
        try {
          await this.evalJs(
            `(() => { const el = document.getElementById('${maskStyleId}'); if (el) el.remove(); })()`,
            targetId,
            paneId
          );
        } catch {}
      }
    }
  });
  }

  public async getDom(selector?: string, tabId?: string, paneId?: SplitPaneId): Promise<string> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) return '';
    const wc = this.ctx.getTabWebContents(targetId, paneId || target.focusedPane);
    if (!wc || wc.isDestroyed()) return '';
    return this.ctx.withTabAgentWorking(targetId, async () => {
      const script = selector
        ? `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            return el ? el.outerHTML : '';
          })()`
        : `(() => document.documentElement ? document.documentElement.outerHTML : '')()`;
      return wc.executeJavaScript(script);
    });
  }

  public async evalJs(
    expression: string,
    tabId?: string,
    paneId?: SplitPaneId,
    userGesture = false
  ): Promise<unknown> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) return undefined;
    const wc = this.ctx.getTabWebContents(targetId, paneId || target.focusedPane);
    if (!wc || wc.isDestroyed()) return undefined;
    return this.ctx.withTabAgentWorking(targetId, async () => {
      const wrapped = `(async () => {
        function serializeCircularSafe(val, seen = new WeakSet(), depth = 0) {
          if (val === null || typeof val !== 'object') {
            if (typeof val === 'bigint') return val.toString() + 'n';
            if (typeof val === 'function') return '[Function: ' + (val.name || 'anonymous') + ']';
            if (typeof val === 'symbol') return val.toString();
            return val;
          }
          if (depth > 10) return '[MaxDepth]';
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
          if (Array.isArray(val)) {
            return val.map(item => serializeCircularSafe(item, seen, depth + 1));
          }
          if (typeof Element !== 'undefined' && val instanceof Element) {
            return {
              tagName: val.tagName,
              id: val.id || undefined,
              className: val.className || undefined,
              outerHTML: val.outerHTML ? val.outerHTML.slice(0, 1000) : undefined,
            };
          }
          const out = {};
          for (const key of Object.keys(val)) {
            try {
              out[key] = serializeCircularSafe(val[key], seen, depth + 1);
            } catch {
              out[key] = '[Unserializable]';
            }
          }
          return out;
        }
        try {
          // Guard against background tab rAF freeze with 15s timeout
          const execPromise = (async () => (0, eval)(${JSON.stringify(expression)}))();
          let timer;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Evaluation timed out after 15000ms (note: requestAnimationFrame pauses in background tabs)')), 15000);
          });
          const result = await Promise.race([execPromise, timeoutPromise]).finally(() => clearTimeout(timer));
          return serializeCircularSafe(result);
        } catch (err) {
          throw err;
        }
      })()`;
      try {
        return await wc.executeJavaScript(wrapped, userGesture);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes('Trusted Type') ||
          msg.includes('CSP') ||
          msg.includes('Content Security Policy') ||
          msg.includes('violates this document')
        ) {
          const cdpRes = await this.sendCdpCommand<{
            result?: { value?: unknown };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
          }>(wc, 'Runtime.evaluate', {
            expression: `(${wrapped})`,
            returnByValue: true,
            awaitPromise: true,
            userGesture,
          });
          if (cdpRes?.exceptionDetails) {
            const detail = cdpRes.exceptionDetails.exception?.description || cdpRes.exceptionDetails.text || 'CDP evaluation exception';
            throw new Error(detail);
          }
          return cdpRes?.result?.value;
        }
        throw err;
      }
    });
  }
  // ─── Auto JSON Viewer & View Page Source ───
  public injectAutoJsonViewer(wc: Electron.WebContents): void {
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
    const t = e.target?.closest?.('.jv-toggle');
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
    :root {
      --bg-main: #0d1117;
      --bg-header: #161b22;
      --border-color: #30363d;
      --gutter-text: #6e7681;
      --gutter-border: #21262d;
      --text-main: #e6edf3;
      --tag-color: #7ee787;
      --attr-color: #79c0ff;
      --val-color: #a5d6ff;
      --punct-color: #8b949e;
      --comment-color: #8b949e;
      --doctype-color: #ff7b72;
      --link-color: #58a6ff;
      --line-hover: rgba(110, 118, 129, 0.1);
      --line-active: rgba(56, 189, 248, 0.18);
      --match-bg: #9e6a03;
      --match-active-bg: #d29922;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-main);
      color: var(--text-main);
      font-family: ui-monospace, "Cascadia Code", "Fira Code", Menlo, Consolas, monospace;
      font-size: 12.5px;
      line-height: 1.6;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .src-header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      background: var(--bg-header);
      border-bottom: 1px solid var(--border-color);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      z-index: 100;
    }
    .src-title-wrap { display: flex; align-items: center; gap: 10px; overflow: hidden; }
    .src-badge {
      background: #1f6feb;
      color: #ffffff;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 4px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .src-url {
      color: var(--link-color);
      font-weight: 600;
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 480px;
    }
    .src-url:hover { text-decoration: underline; }
    .src-meta { color: #8b949e; font-size: 11px; white-space: nowrap; }
    .src-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .src-search-box {
      display: flex;
      align-items: center;
      background: #0d1117;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 2px 6px;
      gap: 4px;
      transition: border-color 0.15s ease;
    }
    .src-search-box:focus-within {
      border-color: #58a6ff;
      box-shadow: 0 0 0 1px #58a6ff;
    }
    .src-search-box input {
      background: transparent;
      border: none;
      outline: none;
      color: #e6edf3;
      font-size: 11.5px;
      width: 140px;
      font-family: inherit;
    }
    .src-search-box input::placeholder { color: #6e7681; }
    .src-search-count { color: #8b949e; font-size: 10px; min-width: 32px; text-align: center; }
    .src-btn-icon {
      background: transparent;
      border: none;
      color: #8b949e;
      cursor: pointer;
      font-size: 10px;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .src-btn-icon:hover { background: #21262d; color: #ffffff; }
    .src-btn {
      background: #21262d;
      color: #c9d1d9;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 11.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      user-select: none;
      transition: all 0.15s ease;
    }
    .src-btn:hover { background: #30363d; color: #ffffff; border-color: #8b949e; }
    .src-btn.active { background: #1f6feb; color: #ffffff; border-color: #388bfd; font-weight: 600; }
    .src-container { flex: 1; overflow: auto; background: var(--bg-main); position: relative; }
    .src-table { width: 100%; border-collapse: collapse; font-family: inherit; font-size: 12px; line-height: 1.6; tab-size: 2; }
    .src-line { transition: background 0.08s ease; }
    .src-line:hover { background: var(--line-hover); }
    .src-line.active-target, .src-line:target { background: var(--line-active) !important; }
    .src-line.matched-active { background: rgba(210, 153, 34, 0.25) !important; }
    .src-gutter {
      width: 1%;
      white-space: nowrap;
      text-align: right;
      padding: 0 16px 0 12px;
      color: var(--gutter-text);
      user-select: none;
      border-right: 1px solid var(--gutter-border);
      vertical-align: top;
      font-size: 11.5px;
      background: var(--bg-main);
      position: sticky;
      left: 0;
      z-index: 1;
    }
    .src-gutter a { color: inherit; text-decoration: none; display: block; }
    .src-gutter a:hover { color: #c9d1d9; }
    .src-code { padding: 0 16px; white-space: pre; word-break: normal; vertical-align: top; color: var(--text-main); }
    body.src-wrap-active .src-code { white-space: pre-wrap !important; word-break: break-all !important; }
    .html-doctype { color: var(--doctype-color); font-weight: 600; }
    .html-comment { color: var(--comment-color); font-style: italic; }
    .html-tag { color: var(--tag-color); }
    .html-attr { color: var(--attr-color); }
    .html-punct { color: var(--punct-color); }
    .html-val { color: var(--val-color); }
    .html-link { color: inherit; text-decoration: none; }
    .html-link .html-val { text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
    .html-link:hover .html-val { color: #58a6ff; }
    .src-loading { padding: 40px; text-align: center; color: #8b949e; font-size: 14px; }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #238636;
      color: #ffffff;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      opacity: 0;
      transform: translateY(8px);
      transition: all 0.2s ease;
      pointer-events: none;
      z-index: 1000;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
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
      <div class="src-search-box" id="srcSearchBox">
        <input type="text" id="srcSearchInput" placeholder="Find in source (Ctrl+F)..." spellcheck="false" autocomplete="off" />
        <span class="src-search-count" id="srcSearchCount"></span>
        <button type="button" class="src-btn-icon" id="srcSearchPrev" title="Previous (Shift+Enter)">▲</button>
        <button type="button" class="src-btn-icon" id="srcSearchNext" title="Next (Enter)">▼</button>
        <button type="button" class="src-btn-icon" id="srcSearchClose" title="Clear (Escape)">✕</button>
      </div>
      <button type="button" class="src-btn active" id="btnFormat">✨ Formatted</button>
      <button type="button" class="src-btn" id="btnWrap">↩ Wrap</button>
      <button type="button" class="src-btn" id="btnCopy">📋 Copy</button>
      <button type="button" class="src-btn" id="btnDownload">💾 Save HTML</button>
    </div>
  </div>
  <div class="src-container" id="srcContainer">
    <table class="src-table" id="srcTable">
      <tbody id="srcTbody">
        <tr><td class="src-loading">⏳ Loading and formatting page source...</td></tr>
      </tbody>
    </table>
  </div>
  <div class="toast" id="toast">Copied to clipboard!</div>
  <script>
    let rawStore = '';
    let targetUrl = '';
    let isFormatted = true;
    let isWrapped = false;
    let cachedFormattedRows = '';
    let cachedRawRows = '';
    let formattedLinesCount = 0;
    let rawLinesCount = 0;
    let sizeKb = '0.0';

    let searchMatches = [];
    let currentMatchIndex = -1;

    const VOID_TAGS = new Set([
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype'
    ]);

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    function highlightTag(tagStr, base) {
      if (tagStr.startsWith('<!--')) return '<span class="html-comment">' + esc(tagStr) + '</span>';
      if (/^<!DOCTYPE/i.test(tagStr)) return '<span class="html-doctype">' + esc(tagStr) + '</span>';
      if (tagStr.startsWith('</')) {
        const m = tagStr.match(/^<\\/\\s*([a-zA-Z0-9:-]+)\\s*>$/);
        return '<span class="html-tag">&lt;/' + (m ? m[1] : esc(tagStr.slice(2, -1))) + '&gt;</span>';
      }
      const tagMatch = tagStr.match(/^<([a-zA-Z0-9:-]+)([\\s\\S]*?)(\\/?>)$/);
      if (!tagMatch) return esc(tagStr);
      const [, tagName, rawAttrs, closing] = tagMatch;
      let out = '<span class="html-tag">&lt;' + tagName + '</span>';
      if (rawAttrs) {
        const attrRegex = /([a-zA-Z0-9_:-]+)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+)))?/g;
        let aMatch;
        while ((aMatch = attrRegex.exec(rawAttrs)) !== null) {
          const name = aMatch[1];
          const val = aMatch[2] !== undefined ? aMatch[2] : (aMatch[3] !== undefined ? aMatch[3] : aMatch[4]);
          const quote = aMatch[2] !== undefined ? '"' : (aMatch[3] !== undefined ? "'" : '');
          out += ' ';
          out += '<span class="html-attr">' + esc(name) + '</span>';
          if (val !== undefined) {
            out += '<span class="html-punct">=</span>';
            const isLink = /^(href|src|action|poster|data-src)$/i.test(name) && val.trim().length > 0;
            let resolvedUrl = val;
            if (isLink && base) {
              try { resolvedUrl = new URL(val, base).href; } catch {}
            }
            if (isLink) {
              out += '<a class="html-link" href="' + esc(resolvedUrl) + '" target="_blank" rel="noopener noreferrer">' + quote + '<span class="html-val">' + esc(val) + '</span>' + quote + '</a>';
            } else {
              out += '<span class="html-val">' + quote + esc(val) + quote + '</span>';
            }
          }
        }
      }
      out += '<span class="html-tag">' + esc(closing) + '</span>';
      return out;
    }

    function tokenizeHtml(raw) {
      const tokens = [];
      let pos = 0;
      const len = raw.length;

      while (pos < len) {
        if (raw.startsWith('<!--', pos)) {
          const end = raw.indexOf('-->', pos + 4);
          const closeIdx = end === -1 ? len : end + 3;
          tokens.push({ type: 'comment', value: raw.slice(pos, closeIdx) });
          pos = closeIdx;
          continue;
        }

        if (raw.startsWith('<![CDATA[', pos)) {
          const end = raw.indexOf(']]>', pos + 9);
          const closeIdx = end === -1 ? len : end + 3;
          tokens.push({ type: 'cdata', value: raw.slice(pos, closeIdx) });
          pos = closeIdx;
          continue;
        }

        if (raw.slice(pos, pos + 9).toUpperCase() === '<!DOCTYPE') {
          const end = raw.indexOf('>', pos + 9);
          const closeIdx = end === -1 ? len : end + 1;
          tokens.push({ type: 'doctype', value: raw.slice(pos, closeIdx) });
          pos = closeIdx;
          continue;
        }

        const scriptMatch = raw.slice(pos).match(/^<script\\b([^>]*)>/i);
        if (scriptMatch) {
          const tagEnd = pos + scriptMatch[0].length;
          const closeMatch = raw.slice(tagEnd).match(/<\\/script\\s*>/i);
          if (closeMatch) {
            const body = raw.slice(tagEnd, tagEnd + closeMatch.index);
            tokens.push({ type: 'script_start', value: scriptMatch[0] });
            if (body) tokens.push({ type: 'script_body', value: body });
            tokens.push({ type: 'script_end', value: closeMatch[0] });
            pos = tagEnd + closeMatch.index + closeMatch[0].length;
            continue;
          }
        }

        const styleMatch = raw.slice(pos).match(/^<style\\b([^>]*)>/i);
        if (styleMatch) {
          const tagEnd = pos + styleMatch[0].length;
          const closeMatch = raw.slice(tagEnd).match(/<\\/style\\s*>/i);
          if (closeMatch) {
            const body = raw.slice(tagEnd, tagEnd + closeMatch.index);
            tokens.push({ type: 'style_start', value: styleMatch[0] });
            if (body) tokens.push({ type: 'style_body', value: body });
            tokens.push({ type: 'style_end', value: closeMatch[0] });
            pos = tagEnd + closeMatch.index + closeMatch[0].length;
            continue;
          }
        }

        if (raw[pos] === '<') {
          const end = raw.indexOf('>', pos + 1);
          const closeIdx = end === -1 ? len : end + 1;
          const tagStr = raw.slice(pos, closeIdx);
          if (tagStr.startsWith('</')) {
            tokens.push({ type: 'tag_close', value: tagStr });
          } else {
            tokens.push({ type: 'tag_open', value: tagStr });
          }
          pos = closeIdx;
          continue;
        }

        const nextTag = raw.indexOf('<', pos);
        const textEnd = nextTag === -1 ? len : nextTag;
        const text = raw.slice(pos, textEnd);
        if (text) {
          tokens.push({ type: 'text', value: text });
        }
        pos = textEnd;
      }
      return tokens;
    }

    function buildFormattedLines(raw, base) {
      const tokens = tokenizeHtml(raw);
      let indent = 0;
      const indentStr = '  ';
      const lines = [];
      let currentLine = '';

      function flushLine() {
        if (currentLine !== '') {
          lines.push(currentLine);
          currentLine = '';
        }
      }

      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'doctype') {
          flushLine();
          lines.push(highlightTag(t.value, base));
        } else if (t.type === 'comment') {
          flushLine();
          const commentLines = t.value.split('\\n');
          for (const cl of commentLines) {
            lines.push(indentStr.repeat(indent) + highlightTag(cl, base));
          }
        } else if (t.type === 'tag_open') {
          const tagNameMatch = t.value.match(/^<([a-zA-Z0-9:-]+)/);
          const tagName = tagNameMatch ? tagNameMatch[1].toLowerCase() : '';
          const isSelfClosing = t.value.endsWith('/>') || VOID_TAGS.has(tagName);

          flushLine();
          currentLine = indentStr.repeat(indent) + highlightTag(t.value, base);

          const next1 = tokens[i + 1];
          const next2 = tokens[i + 2];
          if (
            next1 && next1.type === 'text' && !next1.value.includes('\\n') && next1.value.trim().length < 80 &&
            next2 && next2.type === 'tag_close' && next2.value.toLowerCase() === ('</' + tagName + '>')
          ) {
            currentLine += esc(next1.value) + highlightTag(next2.value, base);
            flushLine();
            i += 2;
            continue;
          }

          flushLine();
          if (!isSelfClosing) {
            indent++;
          }
        } else if (t.type === 'tag_close') {
          indent = Math.max(0, indent - 1);
          flushLine();
          lines.push(indentStr.repeat(indent) + highlightTag(t.value, base));
        } else if (t.type === 'script_start' || t.type === 'style_start') {
          flushLine();
          lines.push(indentStr.repeat(indent) + highlightTag(t.value, base));
          indent++;
        } else if (t.type === 'script_end' || t.type === 'style_end') {
          indent = Math.max(0, indent - 1);
          flushLine();
          lines.push(indentStr.repeat(indent) + highlightTag(t.value, base));
        } else if (t.type === 'script_body' || t.type === 'style_body') {
          flushLine();
          const rawLines = t.value.trim().split('\\n');
          for (const rl of rawLines) {
            if (rl.trim()) {
              lines.push(indentStr.repeat(indent) + esc(rl));
            }
          }
        } else if (t.type === 'text') {
          const trimmed = t.value.trim();
          if (trimmed) {
            flushLine();
            lines.push(indentStr.repeat(indent) + esc(trimmed));
          }
        }
      }
      flushLine();
      return lines;
    }

    function buildRawLines(raw) {
      const lines = raw.split('\\n');
      return lines.map((l) => {
        return esc(l)
          .replace(/(&lt;!--[\\s\\S]*?--&gt;)/g, '<span class="html-comment">$1</span>')
          .replace(/(&lt;!DOCTYPE[\\s\\S]*?&gt;)/gi, '<span class="html-doctype">$1</span>')
          .replace(/(&lt;\\/?[a-zA-Z0-9:-]+(?:\\s+[^&]*?)?\\/?&gt;)/g, '<span class="html-tag">$1</span>');
      });
    }

    function renderLinesToTable(lines) {
      const rows = [];
      for (let idx = 0; idx < lines.length; idx++) {
        const lineNum = idx + 1;
        rows.push(
          '<tr class="src-line" id="L' + lineNum + '">' +
            '<td class="src-gutter"><a href="#L' + lineNum + '" data-line="' + lineNum + '">' + lineNum + '</a></td>' +
            '<td class="src-code">' + lines[idx] + '</td>' +
          '</tr>'
        );
      }
      return rows.join('');
    }

    function updateMeta() {
      const metaEl = document.getElementById('srcMeta');
      if (!metaEl) return;
      if (isFormatted) {
        metaEl.textContent = formattedLinesCount.toLocaleString() + ' lines (Formatted) · ' + sizeKb + ' KB';
      } else {
        metaEl.textContent = rawLinesCount.toLocaleString() + ' lines (Raw) · ' + sizeKb + ' KB';
      }
    }

    function checkHashTarget() {
      if (window.location.hash) {
        const targetId = window.location.hash.slice(1);
        const el = document.getElementById(targetId);
        if (el) {
          document.querySelectorAll('.src-line.active-target').forEach(e => e.classList.remove('active-target'));
          el.classList.add('active-target');
          el.scrollIntoView({ block: 'center' });
        }
      }
    }
    window.addEventListener('hashchange', checkHashTarget);

    function doSearch(query) {
      searchMatches = [];
      currentMatchIndex = -1;
      const countEl = document.getElementById('srcSearchCount');
      document.querySelectorAll('.src-line.matched-active').forEach(e => e.classList.remove('matched-active'));

      if (!query || query.trim() === '') {
        if (countEl) countEl.textContent = '';
        return;
      }

      const qLower = query.toLowerCase();
      const rows = document.querySelectorAll('#srcTbody .src-line');
      rows.forEach((row) => {
        const codeCell = row.querySelector('.src-code');
        if (!codeCell) return;
        const text = codeCell.textContent || '';
        if (text.toLowerCase().includes(qLower)) {
          searchMatches.push(row);
        }
      });

      if (searchMatches.length > 0) {
        currentMatchIndex = 0;
        updateActiveMatch();
      } else {
        if (countEl) countEl.textContent = '0/0';
      }
    }

    function updateActiveMatch() {
      const countEl = document.getElementById('srcSearchCount');
      if (searchMatches.length === 0) {
        if (countEl) countEl.textContent = '0/0';
        return;
      }
      if (countEl) {
        countEl.textContent = (currentMatchIndex + 1) + '/' + searchMatches.length;
      }
      document.querySelectorAll('.src-line.matched-active').forEach(e => e.classList.remove('matched-active'));
      const target = searchMatches[currentMatchIndex];
      if (target) {
        target.classList.add('matched-active');
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    function nextMatch() {
      if (searchMatches.length === 0) return;
      currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
      updateActiveMatch();
    }

    function prevMatch() {
      if (searchMatches.length === 0) return;
      currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
      updateActiveMatch();
    }

    function clearSearch() {
      const searchInput = document.getElementById('srcSearchInput');
      if (searchInput) searchInput.value = '';
      doSearch('');
    }

    window.__antifanRenderSource = (url, content) => {
      rawStore = content || '';
      targetUrl = url || '';
      document.title = 'view-source:' + targetUrl;

      const urlEl = document.getElementById('srcUrl');
      if (urlEl) {
        urlEl.textContent = targetUrl;
        urlEl.href = targetUrl;
        urlEl.title = targetUrl;
      }

      sizeKb = (new Blob([rawStore]).size / 1024).toFixed(1);
      rawLinesCount = rawStore.split('\\n').length;

      try {
        const fLines = buildFormattedLines(rawStore, targetUrl);
        formattedLinesCount = fLines.length;
        cachedFormattedRows = renderLinesToTable(fLines);
      } catch (err) {
        console.warn('[view-source] Format error, fallback to raw:', err);
        isFormatted = false;
      }

      try {
        const rLines = buildRawLines(rawStore);
        cachedRawRows = renderLinesToTable(rLines);
      } catch (err) {
        cachedRawRows = '<tr><td class="src-gutter">1</td><td class="src-code">' + esc(rawStore) + '</td></tr>';
      }

      const tbody = document.getElementById('srcTbody');
      if (tbody) {
        tbody.innerHTML = isFormatted && cachedFormattedRows ? cachedFormattedRows : cachedRawRows;
      }

      const btnFormat = document.getElementById('btnFormat');
      if (btnFormat) {
        btnFormat.classList.toggle('active', isFormatted);
      }

      updateMeta();
      checkHashTarget();
    };

    document.getElementById('btnFormat').onclick = () => {
      isFormatted = !isFormatted;
      const btn = document.getElementById('btnFormat');
      if (btn) btn.classList.toggle('active', isFormatted);

      const tbody = document.getElementById('srcTbody');
      if (tbody) {
        tbody.innerHTML = isFormatted ? cachedFormattedRows : cachedRawRows;
      }
      updateMeta();
      clearSearch();
      checkHashTarget();
    };

    document.getElementById('btnWrap').onclick = () => {
      isWrapped = !isWrapped;
      document.body.classList.toggle('src-wrap-active', isWrapped);
      const btn = document.getElementById('btnWrap');
      if (btn) btn.classList.toggle('active', isWrapped);
    };

    document.getElementById('btnCopy').onclick = () => {
      let copyText = rawStore;
      if (isFormatted) {
        const rows = document.querySelectorAll('#srcTbody .src-code');
        const textLines = [];
        rows.forEach(r => textLines.push(r.textContent || ''));
        copyText = textLines.join('\\n');
      }
      navigator.clipboard.writeText(copyText).then(() => {
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
      a.download = (targetUrl.replace(/[^a-zA-Z0-9]/g, '_') || 'page-source') + '.html';
      a.click();
    };

    let searchDebounce = null;
    const searchInput = document.getElementById('srcSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => doSearch(e.target.value), 150);
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) prevMatch(); else nextMatch();
        } else if (e.key === 'Escape') {
          clearSearch();
          searchInput.blur();
        }
      });
    }

    document.getElementById('srcSearchPrev').onclick = prevMatch;
    document.getElementById('srcSearchNext').onclick = nextMatch;
    document.getElementById('srcSearchClose').onclick = () => {
      clearSearch();
      const input = document.getElementById('srcSearchInput');
      if (input) input.focus();
    };

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const input = document.getElementById('srcSearchInput');
        if (input) {
          input.focus();
          input.select();
        }
      } else if (e.key === 'Escape') {
        clearSearch();
      } else if ((e.altKey && e.key.toLowerCase() === 'z') || ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'w')) {
        e.preventDefault();
        document.getElementById('btnWrap').click();
      }
    });
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
      for (const [, t] of this.ctx.getAllTabs()) {
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
      this.ctx.broadcastState();
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
      console.error('[tab-devtools-host] Failed to load source viewer:', err);
    }
  }

  public async viewPageSource(tabId?: string): Promise<string> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const targetTab = this.ctx.getTabRecord(targetId);
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

    const newTabId = this.ctx.createTab('about:blank');
    if (newTabId) {
      const newTab = this.ctx.getTabRecord(newTabId);
      if (newTab && !newTab.view.webContents.isDestroyed()) {
        newTab.state.url = `view-source:${sourceUrl}`;
        newTab.state.title = `view-source:${sourceUrl}`;
        newTab.state.isLoading = true;
        this.ctx.broadcastState();
        await this.fetchAndLoadPageSource(newTab.view.webContents, sourceUrl, newTab.state, initialHtml);
      }
    }
    return newTabId;
  }

  public dispose(): void {
    if (this.inspectedTabId) {
      this.stopInspect(this.inspectedTabId);
    }
    this.isProcessingInspectPick = false;
    this.isFontFinderActive = false;
    this.isLensActive = false;
    this.isRulerActive = false;

    // 1. Snapshot listeners and remove registered event listeners first
    const listenersSnapshot = Array.from(this.cdpListeners.entries());
    for (const [wcId, listeners] of listenersSnapshot) {
      const wc = this.cdpWebContentsRefs.get(wcId);
      if (wc && !wc.isDestroyed()) {
        try {
          if (listeners.onNavigate && typeof wc.removeListener === 'function') {
            wc.removeListener('did-navigate', listeners.onNavigate);
          }
          if (listeners.onDetach && wc.debugger && typeof wc.debugger.removeListener === 'function') {
            wc.debugger.removeListener('detach', listeners.onDetach);
          }
          if (listeners.onMessage && wc.debugger && typeof wc.debugger.removeListener === 'function') {
            wc.debugger.removeListener('message', listeners.onMessage);
          }
        } catch {}
      }
    }

    // 2. Snapshot attached IDs and detach only debugger sessions attached by this host instance
    const attachedByHostSnapshot = Array.from(this.cdpAttachedByHost);
    for (const wcId of attachedByHostSnapshot) {
      const wc = this.cdpWebContentsRefs.get(wcId);
      if (wc && !wc.isDestroyed() && wc.debugger && wc.debugger.isAttached()) {
        try {
          wc.debugger.detach();
        } catch {}
      }
    }

    this.cdpAttachedByHost.clear();
    this.cdpAttachedWebContents.clear();
    this.cdpWebContentsRefs.clear();
    this.cdpListeners.clear();
    this.cdpQueues.clear();
    this.stylesheetUrls.clear();
    this.isolatedContextIds.clear();
  }
}
