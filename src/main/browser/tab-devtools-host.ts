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
  private cdpListeners = new Map<number, { onDetach: () => void; onNavigate?: () => void }>();
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
    active.view.webContents.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
    this.ctx.broadcastState();
  }

  public stopFontFinder(): void {
    this.isFontFinderActive = false;
    const active = this.ctx.getTabRecord(this.ctx.getActiveTabId());
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
    params: Record<string, unknown> = {}
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
        this.isolatedContextIds.delete(wcId);
        const l = this.cdpListeners.get(wcId);
        if (l && l.onNavigate && typeof wc.removeListener === 'function') {
          try { wc.removeListener('did-navigate', l.onNavigate); } catch {}
        }
        this.cdpListeners.delete(wcId);
      };

      const onNavigate = () => {
        this.isolatedContextIds.delete(wcId);
      };

      wc.debugger.once('detach', onDetach);
      if (typeof wc.on === 'function') {
        wc.on('did-navigate', onNavigate);
      }
      this.cdpListeners.set(wcId, { onDetach, onNavigate });
    }
    const currentQueue = this.cdpQueues.get(wcId) || Promise.resolve();
    const nextPromise = currentQueue.then(async () => {
      if (wc.isDestroyed()) {
        throw new Error(`WebContents destroyed before executing CDP method ${method}`);
      }
      return wc.debugger.sendCommand(method, params);
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
  public async captureScreenshot(rect?: Rectangle, tabId?: string, paneId?: SplitPaneId, options?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<string> {
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
    const quality = typeof options?.quality === 'number' ? Math.max(1, Math.min(100, Math.round(options.quality))) : 85;

    return this.ctx.withTabAgentWorking(targetId, async () => {
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

        return '';
      };

      const isMobile = (paneId || target.focusedPane) === 'mobile';
      const targetPaneView = isMobile ? (target.mobileView || target.view) : target.view;
      if (this.ctx.runWithAttachedTabView && targetPaneView) {
        return this.ctx.runWithAttachedTabView(targetPaneView, captureAction, isMobile);
      }
      return captureAction();
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
          const result = await (0, eval)(${JSON.stringify(expression)});
          return serializeCircularSafe(result);
        } catch (err) {
          throw err;
        }
      })()`;
      return wc.executeJavaScript(wrapped, userGesture);
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
    this.isolatedContextIds.clear();
  }
}
