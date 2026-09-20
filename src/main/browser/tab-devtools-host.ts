/**
 * AntiFan Browser Desktop — Tab DevTools Host Sub-Controller
 * Encapsulates In-Page Developer Utilities: Font Finder, GPU Lens, Screen Ruler,
 * Element Inspector / Picker Polling, Auto JSON Viewer, Page Source Viewer, and DOM Utilities.
 */

import path from 'node:path';
import { net, clipboard, Rectangle } from 'electron';
import { AntiFanTab, SplitPaneId, AntiFanPickedElement } from '../../shared/contracts';
import { CapabilityError } from '../../shared/control-plane-contracts';
import { FONT_FINDER_SCRIPT } from './font-finder';
import { GPU_LENS_SCRIPT } from './gpu-lens';
import { RULER_SCRIPT } from './ruler';
import { ELEMENT_PICKER_SCRIPT } from './element-picker';
import { dispatchAnnotationToTerminal, stripDeliveryMode } from './annotation-dispatch';
import { AnnotationManager } from '../bridge/annotation-manager';
import { TerminalManager, selectAnnotationTargets } from './terminal-manager';
import type { NativeTabRecord } from './native-tab-host';
import type { SemanticElementDescriptor } from './semantic-ref-types';
import {
  CAPTURE_MAX_DIMENSION,
  CaptureError,
  RENDER_SURFACE_PROBE_BOUND_MS,
  RENDER_SURFACE_PROBE_EXPRESSION,
  classifyRenderSurfaceCause,
  rasterMatchesCss,
  resolveCaptureMode,
  validateJpegBuffer,
  validatePngBuffer,
  type CaptureMode,
  type CaptureViewportTransaction,
  type RenderSurfaceSnapshot,
  type VerificationCaptureEnvelope,
} from '../verification/visual-capture';
import { buildStaircasePrewarmScript, normalizeScrollPrewarmResult } from '../verification/scroll-prewarm';
import type { ScrollPrewarmReceipt } from '../verification/scroll-prewarm';
import { evaluatePreCaptureQuiescence, type PreCaptureQuiescenceResult } from '../verification/capture-settle';
import { buildTrackerStubScript, buildTrackerStubTeardownScript, TRACKER_BLOCK_PATTERNS } from './tracker-isolation';
import type { TrackerIsolationReceipt } from './tracker-isolation';

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * Execution budget for the full-page pre-warm walk. The walk itself is bounded
 * to ~12 steps x 40ms plus a bounded image decode, so this ceiling only has to
 * absorb a slow renderer, never an unbounded lazy-loading loop.
 */
const PREWARM_EXEC_BUDGET_MS = 15_000;

/**
 * Bound for the native viewport raster. A view whose surface can answer at all
 * answers in tens of milliseconds (measured 27-47ms on an attached
 * viewport-sized view), so this ceiling only has to absorb a surface that has
 * to be rebuilt first (measured 1.1-2.4s for the first raster of a hidden
 * window). A view that never answers falls through to the CDP path instead of
 * stalling the capture at the caller's bound.
 */
const NATIVE_VIEWPORT_RASTER_BOUND_MS = 4_000;

/**
 * A viewport capture whose native tier handed back no frame has no compositor
 * surface to copy: the viewport raster is the view's own composited image, so an
 * empty native answer means the window is not presenting the view. The CDP tier
 * then has nothing to rasterize and waits out its whole bound instead of failing,
 * which also leaves the target's CDP transport draining for every later command.
 * The fallback therefore gets this short probe bound and reports the missing
 * surface by name when it cannot answer.
 */
const NO_SURFACE_CAPTURE_PROBE_BOUND_MS = 8_000;

/**
 * A render surface is measured only when the probe found a viewport: a view with no
 * compositor surface lays its document out against a zero-width box and reports 0x0,
 * which is the absence of a measurement, never a geometry of 0x0. Every decision that
 * consumes a surface — a capture's geometry, a restore baseline, a restore reading —
 * must refuse on one instead of treating it as a real size.
 */
function hasMeasuredSurface(snapshot: RenderSurfaceSnapshot | undefined): snapshot is RenderSurfaceSnapshot {
  if (!snapshot) return false;
  return Number.isFinite(snapshot.vw) && Number.isFinite(snapshot.vh) && snapshot.vw >= 1 && snapshot.vh >= 1;
}

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
  getTabContentBounds?: (tabId: string, paneId?: SplitPaneId) => { width: number; height: number } | undefined;
  switchTab?: (tabId: string) => boolean;
  getSemanticDocumentGeneration?: (tabId: string, paneId?: SplitPaneId) => number;
  getLegacyDocumentGeneration?: (tabId: string) => number;
  getMutationRevision?: (tabId: string) => number;
  getTabUrl?: (tabId: string) => string;
  getRedirectChain?: (tabId: string) => string[];
  getLastNavigationFailure?: (tabId: string) => { cause: string; message: string; timedOut: boolean } | undefined;
  updateLayout?: () => void;
  applyTabDeviceEmulation?: (tabId: string) => void;
  isTabViewAttached?: (view: Electron.WebContentsView | null | undefined) => boolean;
  /** True while the host window is on screen (visible, not minimized, not destroyed). */
  isWindowRenderable?: () => boolean;
  /**
   * Re-asserts the invariant that the presented tab's view sits inside the
   * window's contentView. A capture calls this instead of waiting on a surface
   * that a view outside the window can never produce.
   */
  reassertPresentedView?: () => void;
}
export interface TabDevToolsStats {
  attachedWebContentsCount: number;
  hostOwnedAttachmentCount: number;
  listenerTargetCount: number;
  queuedTargetCount: number;
  drainingTargetCount: number;
  stylesheetTargetCount: number;
  isolatedContextCount: number;
  trackerIsolationTargetCount: number;
}

/**
 * In-page execution guard for `evalJs`. Chrome pauses requestAnimationFrame in
 * background tabs, so a script that waits on a frame can hang forever; this is
 * the default ceiling. Callers whose script declares a longer budget (the
 * reference materialization walk) pass their own through `timeoutMs`.
 */
const EVAL_JS_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Source of the circular-safe value serializer injected into every evaluated
 * expression. One definition, so the page-context and frame-context paths cannot
 * drift in how they marshal a result back across the Electron boundary.
 */
const SERIALIZE_CIRCULAR_SAFE_SOURCE = `function serializeCircularSafe(val, seen = new WeakSet(), depth = 0) {
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
    return val.map((item) => serializeCircularSafe(item, seen, depth + 1));
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
}`;

/**
 * Resolve the child frame of `wc` whose URL contains `frameUrl`.
 *
 * Identity comes from `WebFrameMain.framesInSubtree`, deliberately not from
 * `Page.getFrameTree`: the CDP frame tree reports a cross-origin child without its
 * committed URL, so URL matching there can never resolve an embedded app frame.
 * The tab's own top frame is never a candidate — running a caller's script in the
 * top frame when it asked for a child frame would execute it in the wrong context.
 */
function findChildFrameByUrl(wc: Electron.WebContents, frameUrl: string, tabId: string): Electron.WebFrameMain {
  const needle = String(frameUrl || '').toLowerCase();
  const root = wc.mainFrame;
  let frames: Electron.WebFrameMain[] = [];
  try {
    frames = root ? root.framesInSubtree : [];
  } catch {
    frames = [];
  }
  const match = frames.find((frame) => frame !== root && String(frame.url || '').toLowerCase().includes(needle));
  if (match) return match;
  const census = frames
    .map((frame) => `${frame === root ? 'top' : 'child'}@${frame.frameTreeNodeId}=${String(frame.url || '').slice(0, 160) || '(no url)'}`)
    .join(' | ');
  throw new CapabilityError('SELECTOR_NOT_FOUND', `No child frame in tab ${tabId} matches "${frameUrl}". Frames: ${census || '(none)'}`);
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
  private cdpDrainingTargets = new Map<number, { method: string; token: symbol; startedAt?: number }>();
  private cdpAttachedWebContents = new Set<number>();
  private cdpAttachedByHost = new Set<number>();
  private cdpWebContentsRefs = new Map<number, Electron.WebContents>();
  private cdpListeners = new Map<number, { onDetach: () => void; onNavigate?: () => void; onMessage?: (_event: Electron.Event, method: string, params: Record<string, unknown>) => void }>();
  private stylesheetUrls = new Map<number, Map<string, string>>();
  private isolatedContextIds = new Map<number, number>();
  /**
   * One in-flight native viewport raster per WebContents. A raster that never
   * answers leaves its promise pending forever; without sharing, every later
   * capture would stack another capturePage on the same wedged compositor.
   */
  private nativeRasterInFlight = new Map<number, Promise<Electron.NativeImage | null>>();
  /**
   * Per-target tracker-isolation state, keyed by WebContents id. Presence means
   * the target may still have a pre-document stub script registered and/or a
   * `Network.setBlockedURLs` blocklist applied, so `endTrackerIsolation` knows
   * exactly what to undo.
   *
   * `releasePending` records that a release was attempted and came back
   * incomplete. The two halves fail independently, so neither the identifier
   * being null nor being set can express "this entry is a release that stopped
   * halfway" — the flag is what keeps a later `beginTrackerIsolation` from
   * reporting a half-undone window as installed.
   */
  private trackerIsolation = new Map<number, { stubIdentifier: string | null; blockedPatterns: string[]; stubsInstalled: string[]; releasePending: boolean }>();
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
      drainingTargetCount: this.cdpDrainingTargets.size,
      stylesheetTargetCount: this.stylesheetUrls.size,
      isolatedContextCount: this.isolatedContextIds.size,
      trackerIsolationTargetCount: this.trackerIsolation.size,
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
      sessions: selectAnnotationTargets(tm.listSessions()),
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
        tabId: targetTabId,
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
        tabId: targetTabId,
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

    const draining = this.cdpDrainingTargets.get(wcId);
    if (draining) {
      const drainingDuration = Date.now() - (draining.startedAt || 0);
      if (drainingDuration > 5000) {
        try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
        this.cdpDrainingTargets.delete(wcId);
        this.cdpQueues.delete(wcId);
      } else {
        throw new CaptureError('TARGET_BUSY_DRAINING', `TARGET_BUSY_DRAINING: Cannot admit CDP command ${method}; target ${wcId} is draining timed-out command ${draining.method}`);
      }
    }

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
        this.cleanupCdpTarget(wcId);
      };

      const onNavigate = () => {
        // Liveness gate only: CDP events carry their own target, so `wc` is not a
        // precondition here (a frame-less or pre-commit WebContents still needs its
        // per-tab provenance cleared on navigation).
        if (!wc || wc.isDestroyed()) return;
        this.isolatedContextIds.delete(wcId);
        this.stylesheetUrls.delete(wcId);
      };

      const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
        if (!wc || wc.isDestroyed()) return;
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
    const maxCap = method === 'Page.captureScreenshot' ? 60_000 : 30_000;
    const boundedTimeoutMs = Math.min(maxCap, Math.max(1, timeoutMs));
    let isCallerTimedOut = false;
    let isCommandDispatched = false;
    let isCommandSettled = false;
    const commandToken = Symbol(method);

    const { promise: timeoutPromise, reject: rejectTimeout } = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      isCallerTimedOut = true;
      if (isCommandDispatched && !isCommandSettled) {
        this.cdpDrainingTargets.set(wcId, { method, token: commandToken, startedAt: Date.now() });
      }
      rejectTimeout(new Error(`CDP command ${method} timed out after ${boundedTimeoutMs}ms`));
    }, boundedTimeoutMs);
    const currentQueue = this.cdpQueues.get(wcId) || Promise.resolve();
    const { promise: queueDrainPromise, resolve: resolveQueueDrain } = Promise.withResolvers<void>();

    queueDrainPromise.finally(() => {
      if (this.cdpQueues.get(wcId) === queueDrainPromise) {
        this.cdpQueues.delete(wcId);
      }
    });

    this.cdpQueues.set(wcId, queueDrainPromise);

    const nextPromise = currentQueue.catch(() => {}).then(async () => {
      if (isCallerTimedOut || wc.isDestroyed()) {
        resolveQueueDrain();
        if (wc.isDestroyed()) {
          throw new Error(`WebContents destroyed before executing CDP method ${method}`);
        }
        return;
      }

      let command: Promise<unknown>;
      try {
        isCommandDispatched = true;
        command = wc.debugger.sendCommand(method, params);
      } catch (err) {
        resolveQueueDrain();
        throw err;
      }
      command.finally(() => {
        isCommandSettled = true;
        if (this.cdpDrainingTargets.get(wcId)?.token === commandToken) {
          this.cdpDrainingTargets.delete(wcId);
        }
        resolveQueueDrain();
      }).catch(() => {});
      return command;
    });

    return Promise.race([
      nextPromise,
      timeoutPromise,
    ]).finally(() => {
      clearTimeout(timer);
    }) as Promise<T>;
  }

  /**
   * Drops every per-WebContents transport registration: attachment bookkeeping,
   * CDP queue/draining state, cached stylesheet + isolated-world maps, and the
   * debugger/did-navigate listeners. Idempotent; the next sendCdpCommand
   * re-attaches lazily.
   */
  private cleanupCdpTarget(wcId: number): void {
    const wc = this.cdpWebContentsRefs.get(wcId);
    this.cdpAttachedWebContents.delete(wcId);
    this.cdpAttachedByHost.delete(wcId);
    this.cdpWebContentsRefs.delete(wcId);
    this.cdpQueues.delete(wcId);
    this.cdpDrainingTargets.delete(wcId);
    this.stylesheetUrls.delete(wcId);
    this.isolatedContextIds.delete(wcId);
    // The stub registration and URL blocklist live in the CDP session, so a
    // detached target loses them with the session; keeping the bookkeeping would
    // make a later isolation look active while nothing is applied.
    this.trackerIsolation.delete(wcId);
    const listeners = this.cdpListeners.get(wcId);
    if (listeners && wc && !wc.isDestroyed()) {
      if (listeners.onNavigate && typeof wc.removeListener === 'function') {
        try { wc.removeListener('did-navigate', listeners.onNavigate); } catch {}
      }
      if (listeners.onMessage && wc.debugger && typeof wc.debugger.removeListener === 'function') {
        try { wc.debugger.removeListener('message', listeners.onMessage); } catch {}
      }
    }
    this.cdpListeners.delete(wcId);
  }

  /**
   * Apply ephemeral tracker isolation to a target: install the vendor stubs so
   * a blocked script does not leave a `ReferenceError` behind, register the same
   * stubs for every future document in this target, and block third-party
   * measurement endpoints.
   *
   * The stub script is registered BEFORE navigation on purpose. Registering it
   * after the document loads only helps the next page, and the page currently
   * throwing `fbq is not defined` is the one under test.
   *
   * Everything here is per-target state with an explicit teardown; nothing is
   * applied browser-wide, because blocking these origins breaks Google OAuth,
   * Cloudflare Turnstile and the platform admin bar for every other tab.
   */
  public async beginTrackerIsolation(
    tabId?: string,
    paneId?: SplitPaneId
  ): Promise<TrackerIsolationReceipt> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    const wc = this.ctx.getTabWebContents(targetId, paneId || target?.focusedPane);
    if (!wc || wc.isDestroyed()) {
      return {
        active: false,
        stubsInstalled: [],
        blockedPatterns: [],
        preDocumentScriptIdentifier: null,
        degradedReason: `WebContents unavailable for tab '${targetId}'`,
      };
    }

    const wcId = wc.id;
    const existing = this.trackerIsolation.get(wcId);
    if (existing && existing.stubIdentifier && !existing.releasePending) {
      return {
        active: true,
        stubsInstalled: [...existing.stubsInstalled],
        blockedPatterns: [...existing.blockedPatterns],
        preDocumentScriptIdentifier: existing.stubIdentifier,
      };
    }
    if (existing) {
      // Either half of the previous release may be outstanding: no registration
      // (the stub half came off, the blocklist did not) or a registration with
      // the blocklist already lifted. Both are entry states that must not be
      // reported as an installed window — the first would send QA into a reload
      // that blocks vendor tags with no stub, the second would claim blocking
      // that is no longer applied — so the outstanding half is retried here and
      // a failure refuses to build a window on top of it.
      const retry = await this.rollbackTrackerIsolation(wc, existing.stubIdentifier);
      if (retry.stubRemoved) existing.stubIdentifier = null;
      if (retry.reason) {
        existing.releasePending = true;
        return {
          active: false,
          stubsInstalled: [...existing.stubsInstalled],
          blockedPatterns: [...existing.blockedPatterns],
          preDocumentScriptIdentifier: existing.stubIdentifier,
          degradedReason: `Previous window was not fully released (${retry.reason}); refusing to report it as installed`,
        };
      }
      this.trackerIsolation.delete(wcId);
    }

    const receipt: TrackerIsolationReceipt = {
      active: false,
      stubsInstalled: [],
      blockedPatterns: [...TRACKER_BLOCK_PATTERNS],
      preDocumentScriptIdentifier: null,
    };

    try {
      await this.sendCdpCommand(wc, 'Page.enable', {});
      await this.sendCdpCommand(wc, 'Network.enable', {});
    } catch (err: unknown) {
      receipt.degradedReason = `CDP domain enable failed: ${err instanceof Error ? err.message : String(err)}`;
      return receipt;
    }

    try {
      const registered = await this.sendCdpCommand<{ identifier?: string }>(wc, 'Page.addScriptToEvaluateOnNewDocument', {
        source: buildTrackerStubScript(),
      });
      receipt.preDocumentScriptIdentifier = typeof registered?.identifier === 'string' && registered.identifier.length > 0
        ? registered.identifier
        : null;
    } catch (err: unknown) {
      receipt.degradedReason = `Pre-document stub registration failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!receipt.preDocumentScriptIdentifier) {
      // Fail closed. The live-document injection below covers only the page that
      // is already loaded, so blocking vendor origins without a pre-document
      // registration would leave the *next* document — the reload QA is about to
      // perform — with blocked tag scripts and no stubs, turning a benign
      // `fbq()` no-op into a ReferenceError on the page under test. That is
      // strictly worse than the condition isolation exists to relieve, so
      // nothing is blocked unless both halves can be installed.
      await wc.executeJavaScript(buildTrackerStubTeardownScript()).catch(() => undefined);
      receipt.degradedReason = receipt.degradedReason || 'Pre-document stub registration returned no identifier';
      return receipt;
    }

    // Existing document: the pre-document script cannot reach a page that is
    // already loaded, and that is exactly the document a QA probe inspects.
    try {
      const installed: unknown = await wc.executeJavaScript(buildTrackerStubScript());
      if (installed && typeof installed === 'object' && 'installed' in installed && Array.isArray(installed.installed)) {
        const names: unknown[] = installed.installed;
        receipt.stubsInstalled = names.filter((name): name is string => typeof name === 'string');
      }
    } catch (err: unknown) {
      receipt.degradedReason = receipt.degradedReason
        ? `${receipt.degradedReason}; live-document stub injection failed: ${err instanceof Error ? err.message : String(err)}`
        : `Live-document stub injection failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      await this.sendCdpCommand(wc, 'Network.setBlockedURLs', { urls: [...TRACKER_BLOCK_PATTERNS] });
    } catch (err: unknown) {
      // Nothing was recorded in the map yet, so this rollback is the only undo
      // that will ever run for the registration installed above.
      await this.rollbackTrackerIsolation(wc, receipt.preDocumentScriptIdentifier);
      receipt.preDocumentScriptIdentifier = null;
      receipt.blockedPatterns = [];
      receipt.degradedReason = `Network.setBlockedURLs failed: ${err instanceof Error ? err.message : String(err)}`;
      return receipt;
    }

    this.trackerIsolation.set(wcId, {
      stubIdentifier: receipt.preDocumentScriptIdentifier,
      blockedPatterns: [...TRACKER_BLOCK_PATTERNS],
      stubsInstalled: [...receipt.stubsInstalled],
      releasePending: false,
    });
    receipt.active = true;
    return receipt;
  }

  /**
   * Release tracker isolation: remove the pre-document stub registration and
   * lift the URL blocklist so the next navigation loads the real vendors.
   *
   * The stubs already installed in a live document are deliberately left in
   * place. That document loaded while its vendor script was blocked, so those
   * stubs are the only implementations of `fbq`/`gtag` it will ever see —
   * deleting them would turn the benign no-op into the very `ReferenceError`
   * this feature exists to prevent, at the moment QA ends. Dropping the
   * registration is what stops the stubs reaching any later document.
   */
  public async endTrackerIsolation(tabId?: string, paneId?: SplitPaneId): Promise<{ released: boolean; reason?: string }> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    const wc = this.ctx.getTabWebContents(targetId, paneId || target?.focusedPane);
    if (!wc || wc.isDestroyed()) {
      return { released: false, reason: `WebContents unavailable for tab '${targetId}'` };
    }

    const state = this.trackerIsolation.get(wc.id);
    if (!state) {
      return { released: false, reason: `Tracker isolation was not active for tab '${targetId}'` };
    }

    const outcome = await this.rollbackTrackerIsolation(wc, state.stubIdentifier);
    if (outcome.stubRemoved) {
      // The registration is gone; a retry must not try to remove it again, or
      // Chromium's "Script not found" would make the release permanently
      // unreleasable over an id that no longer exists.
      state.stubIdentifier = null;
    }
    if (outcome.reason) {
      // The entry is the only record of what still needs undoing. Dropping it on
      // a failed rollback would leave the blocklist applied to the user's tab
      // with no way to retry, detect or even describe the leak, so it survives
      // until the release actually succeeds — flagged, because the halves fail
      // independently and the surviving fields alone cannot say that a release
      // is outstanding.
      state.releasePending = true;
      return { released: false, reason: outcome.reason };
    }
    this.trackerIsolation.delete(wc.id);
    return { released: true };
  }

  /** True while the target still has a stub registration or URL block applied. */
  public isTrackerIsolationActive(tabId?: string, paneId?: SplitPaneId): boolean {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    const wc = this.ctx.getTabWebContents(targetId, paneId || target?.focusedPane);
    if (!wc || wc.isDestroyed()) return false;
    return this.trackerIsolation.has(wc.id);
  }

  /**
   * Undo what the window applied, and report which half completed.
   *
   * The two halves fail independently, so the caller has to know which one is
   * already done: re-removing a registration that is already gone fails with
   * "Script not found" in Chromium, which would leave a retried release stuck
   * forever on an error that describes no real leak. `stubRemoved` is what lets
   * the retained entry describe only the work that is still outstanding.
   */
  private async rollbackTrackerIsolation(
    wc: Electron.WebContents,
    stubIdentifier: string | null
  ): Promise<{ stubRemoved: boolean; reason?: string }> {
    const failures: string[] = [];
    let stubRemoved = false;
    if (stubIdentifier) {
      try {
        await this.sendCdpCommand(wc, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: stubIdentifier });
        stubRemoved = true;
      } catch (err: unknown) {
        failures.push(`removeScriptToEvaluateOnNewDocument failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await this.sendCdpCommand(wc, 'Network.setBlockedURLs', { urls: [] });
    } catch (err: unknown) {
      failures.push(`clearing Network.setBlockedURLs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return failures.length > 0 ? { stubRemoved, reason: failures.join('; ') } : { stubRemoved };
  }

  private isWebContentsDraining(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || wc.isDestroyed()) return false;
    return this.cdpDrainingTargets.has(wc.id);
  }

  /** True while the target holds a timed-out in-flight CDP command. */
  public isTargetDraining(tabId: string, paneId?: SplitPaneId): boolean {
    const target = this.ctx.getTabRecord(tabId);
    const wc = this.ctx.getTabWebContents(tabId, paneId || target?.focusedPane);
    return this.isWebContentsDraining(wc);
  }

  private async raceWithDeadline(p: Promise<unknown>, deadlineMs: number): Promise<void> {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return;
    const { promise: expired, resolve: resolveExpired } = Promise.withResolvers<void>();
    const timer = setTimeout(resolveExpired, remainingMs);
    const settled = p.then(() => undefined, () => undefined);
    try {
      await Promise.race([settled, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Bounded recovery for a target whose CDP queue is blocked. Waits for the
   * per-WebContents queue tail to settle; if it is still pending at the bound,
   * performs a bounded debugger detach (which settles the in-flight command)
   * and clears the transport state so the next command re-attaches lazily.
   * Draining state is cleared only after the tail settles or the reset completes.
   */
  public async drainTarget(
    tabId: string,
    paneId?: SplitPaneId,
    timeoutMs = 5_000
  ): Promise<{ ok: boolean; drained: boolean; resetPerformed: boolean; elapsedMs: number }> {
    const startedAt = Date.now();
    const target = this.ctx.getTabRecord(tabId);
    const wc = this.ctx.getTabWebContents(tabId, paneId || target?.focusedPane);
    if (!wc || wc.isDestroyed()) {
      return { ok: true, drained: true, resetPerformed: false, elapsedMs: Date.now() - startedAt };
    }
    const wcId = wc.id;
    const deadline = startedAt + Math.min(60_000, Math.max(1, timeoutMs));

    const tail = this.cdpQueues.get(wcId);
    if (tail) {
      await this.raceWithDeadline(tail.catch(() => {}), deadline);
    }
    while (this.cdpDrainingTargets.has(wcId) && Date.now() < deadline) {
      await delay(25);
    }
    if (!this.cdpQueues.has(wcId) && !this.cdpDrainingTargets.has(wcId)) {
      return { ok: true, drained: true, resetPerformed: false, elapsedMs: Date.now() - startedAt };
    }

    let resetPerformed = false;
    try {
      if (wc.debugger.isAttached()) {
        wc.debugger.detach();
        resetPerformed = true;
      }
    } catch {
      resetPerformed = false;
    }
    if (!resetPerformed) {
      return { ok: false, drained: false, resetPerformed: false, elapsedMs: Date.now() - startedAt };
    }

    const pendingTail = this.cdpQueues.get(wcId);
    if (pendingTail) {
      await this.raceWithDeadline(pendingTail.catch(() => {}), Date.now() + 250);
    }
    this.cleanupCdpTarget(wcId);
    const drained = !this.cdpQueues.has(wcId) && !this.cdpDrainingTargets.has(wcId);
    return { ok: true, drained, resetPerformed: true, elapsedMs: Date.now() - startedAt };
  }

  private toCaptureError(err: unknown, context: string): Error {
    if (err instanceof CaptureError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('TARGET_BUSY_DRAINING')) {
      return new CaptureError('TARGET_BUSY_DRAINING', `${context}: ${message}`);
    }
    if (/timed out after \d+ms/i.test(message)) {
      return new CaptureError('CAPTURE_TIMEOUT', `${context}: ${message}`);
    }
    return err instanceof Error ? err : new Error(`${context}: ${message}`);
  }

  /**
   * A capture rasterizes the pane view it runs through, so a view with no size is a
   * surface the tab never had: give it the box the window gives that pane. A host that
   * cannot name real geometry leaves the view untouched — the capture path then reports
   * the unmeasurable surface instead of rasterizing an invented one.
   */
  private ensurePaneViewBounds(view: Electron.WebContentsView | null | undefined, tabId: string, paneId?: SplitPaneId): void {
    if (!view || typeof view.getBounds !== 'function' || typeof view.setBounds !== 'function') return;
    const bounds = view.getBounds();
    if (bounds && bounds.width > 0 && bounds.height > 0) return;
    const content = this.ctx.getTabContentBounds ? this.ctx.getTabContentBounds(tabId, paneId) : undefined;
    if (!content || content.width < 1 || content.height < 1) return;
    view.setBounds({ x: 0, y: 0, width: content.width, height: content.height });
  }

  /**
   * Document scroll height in CSS pixels for full-page capture. Fails closed:
   * an unavailable height must never degrade into a viewport-only capture
   * mislabeled as full-page evidence.
   */
  private async readDocumentScrollHeight(wc: Electron.WebContents): Promise<number> {
    const res = await this.sendCdpCommand<{ result?: { value?: unknown } }>(wc, 'Runtime.evaluate', {
      expression: 'Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0, document.scrollingElement ? document.scrollingElement.scrollHeight : 0)',
      returnByValue: true,
    });
    const height = Number(res?.result?.value);
    if (!Number.isFinite(height) || height < 1) {
      throw new CaptureError(
        'FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY',
        `Document scroll height is unavailable (${String(res?.result?.value)}); full-page capture cannot be bounded`
      );
    }
    return height;
  }

  /**
   * Bounded render-surface probe: one CDP round-trip that reads the tab's live
   * viewport, scroll offset and readiness. Read-only — it never writes geometry and
   * never clamps a degenerate surface into a usable one, so a caller can refuse
   * before starting bounded render work.
   *
   * A target that is not the active tab and not an agent-plane tab has no compositor
   * surface while it sits in the background, and a view with no widget lays its
   * document out against a zero-width box. Such a tab is measured inside a temporary
   * in-place attach (below the active tab's view, released as soon as the reading is
   * taken) so the reading describes the surface the tab really has, instead of
   * refusing work the tab can do or trusting a widget-sized number.
   */
  public async readRenderSurface(
    tabId?: string,
    paneId?: SplitPaneId,
    timeoutMs = RENDER_SURFACE_PROBE_BOUND_MS
  ): Promise<RenderSurfaceSnapshot> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) {
      throw new Error(`Target tab '${targetId}' not found for render-surface probe`);
    }
    const effectivePane = paneId || target.focusedPane;
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) {
      throw new Error(`WebContents not available for tab '${targetId}'`);
    }
    const measure = (): Promise<RenderSurfaceSnapshot> => this.probeRenderSurface(wc, timeoutMs);
    const paneView = effectivePane === 'mobile' ? (target.mobileView || target.view) : target.view;
    const isActiveTarget = targetId === this.ctx.getActiveTabId();
    const isOffscreenTarget = target.state?.offscreen === true;
    if (!isActiveTarget && !isOffscreenTarget && paneView && this.ctx.runWithAttachedTabView) {
      const isMobilePane = effectivePane === 'mobile' && Boolean(target.mobileView);
      return await this.ctx.runWithAttachedTabView(paneView, measure, isMobilePane);
    }
    return await measure();
  }

  /**
   * Raw surface metrics; no fallback geometry is invented.
   *
   * `vw`/`vh` are the CSS viewport a capture rasterizes, read from the tab's own
   * renderer: `window.innerWidth/innerHeight` include the scrollbar gutter, which the
   * capture raster covers (measured on one tab: innerWidth 1440 / clientWidth 1425 with
   * a 1440-wide raster), while the document element's client box is the
   * scrollbar-excluded content box and stays a diagnostic. The content box is also the
   * degenerate signal: a view with no compositor surface lays out against a
   * zero-width box, so a zero content box reports 0 rather than promoting whatever
   * widget size the tab happens to have.
   */
  private async probeRenderSurface(wc: Electron.WebContents, timeoutMs: number): Promise<RenderSurfaceSnapshot> {
    const bound = Math.max(1, Math.round(timeoutMs));
    const res = await this.sendCdpCommand<{ result?: { value?: Partial<RenderSurfaceSnapshot> } }>(
      wc,
      'Runtime.evaluate',
      { expression: RENDER_SURFACE_PROBE_EXPRESSION, returnByValue: true },
      bound
    );
    const value = res?.result?.value;
    if (!value || typeof value !== 'object') {
      throw new CaptureError(
        'NO_RENDER_SURFACE',
        `Render-surface probe returned no geometry (${String(value)}); the tab's layout surface cannot be measured`
      );
    }
    const renderer = value as Partial<RenderSurfaceSnapshot> & { windowWidth?: number; windowHeight?: number };
    const finite = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
    return {
      vw: Math.max(0, finite(renderer.vw)),
      vh: Math.max(0, finite(renderer.vh)),
      ...(renderer.layoutWidth !== undefined ? { layoutWidth: Math.max(0, finite(renderer.layoutWidth)) } : {}),
      ...(renderer.layoutHeight !== undefined ? { layoutHeight: Math.max(0, finite(renderer.layoutHeight)) } : {}),
      dpr: Number(renderer.dpr) || 1,
      scrollX: Number(renderer.scrollX) || 0,
      scrollY: Number(renderer.scrollY) || 0,
      docH: Number(renderer.docH) || 0,
      readyState: typeof renderer.readyState === 'string' ? renderer.readyState : 'unknown',
      hidden: renderer.hidden === true,
    };
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
        try {
          this.ctx.applyTabDeviceEmulation?.(targetId);
        } catch {}
      }
    }
  }

  /**
   * Legacy viewport screenshot helper (native capturePage + CDP viewport tiers).
   * It can never produce full-page bytes: `fullPage` delegates to the canonical
   * verification capture, so a caller can never receive viewport pixels labeled
   * as full-page evidence.
   */
  public async captureScreenshot(rect?: Rectangle, tabId?: string, paneId?: SplitPaneId, options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; maskSelectors?: string[] }): Promise<string> {
    if (options?.fullPage) {
      const envelope = await this.captureVerificationScreenshot(rect, tabId, paneId, {
        format: options.format,
        quality: options.quality,
        fullPage: true,
      });
      return envelope.data;
    }
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) return '';
    const effectivePane = paneId || target.focusedPane;
    const isMobile = effectivePane === 'mobile';
    const targetPaneView = isMobile ? (target.mobileView || target.view) : target.view;
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) return '';
    if (target.customViewport && target.customViewport.width > 0 && target.customViewport.height > 0) {
      if (targetPaneView && typeof targetPaneView.setBounds === 'function') {
        targetPaneView.setBounds({ x: 0, y: 0, width: target.customViewport.width, height: target.customViewport.height });
      }
    } else {
      this.ensurePaneViewBounds(targetPaneView, targetId, effectivePane);
    }
    const format = options?.format === 'jpeg' ? 'jpeg' : 'png';
    const rawQuality = typeof options?.quality === 'number' ? options.quality : 80;
    const quality = Math.max(1, Math.min(100, Math.round(rawQuality <= 1 && rawQuality > 0 ? rawQuality * 100 : rawQuality)));
    // A capture never foregrounds the target: the visible tab belongs to the user.
    // Detached WebContentsViews have no composited offscreen surface on Windows, so a
    // background target is attached in place for the raster (below) and the user's
    // active view stays on top; offscreen agent tabs already composite offscreen
    // (Dual-Plane) and are captured directly. No path here switches the visible tab.
    const isOffscreenTarget = target.state?.offscreen === true;
    const isForeground = targetId === this.ctx.getActiveTabId();
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
            effectivePane
          );
          maskStyleInjected = true;
        } catch {}
      }

      // Screenshot Guard: Temporarily suppress agent overlay & visual cursor during capture
      try {
        await this.evalJs(
          `(() => {
            const ov = document.getElementById('__antifan_agent_overlay__');
            if (ov) ov.classList.add('suppressed');
          })()`,
          targetId,
          effectivePane
        );
      } catch {}
      try {
        const captureAction = async (): Promise<string> => {
          this.assertCaptureSurfacePresent(targetId, effectivePane, targetPaneView, rect ? 'clip' : 'viewport', isOffscreenTarget);
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
        // Full-page requests are delegated to captureVerificationScreenshot above;
        // this helper is strictly viewport/clip.
        if (isForeground || isOffscreenTarget) {
          // Tier 1: Fast webContents.capturePage() with 600ms race.
          // Foreground tabs only to avoid compositor surface bleed; offscreen agent
          // tabs (Dual-Plane) also use capturePage because their offscreen-rendered
          // WebContents has no attached compositor surface for CDP fromSurface.
          const capturePageTier = async (): Promise<string> => {
            const img = await withTimeout(wc.capturePage(rect), 600, null);
            if (!img) return '';
            if (typeof img.isEmpty === 'function' && !img.isEmpty()) {
              if (format === 'jpeg' && typeof img.toJPEG === 'function') {
                return img.toJPEG(quality).toString('base64');
              }
              return img.toPNG().toString('base64');
            }
            if (typeof img.toPNG === 'function') {
              if (format === 'jpeg' && typeof img.toJPEG === 'function') {
                const jpegBuf = img.toJPEG(quality);
                if (jpegBuf.length > 0) return jpegBuf.toString('base64');
              }
              const pngBuf = img.toPNG();
              if (pngBuf.length > 0) {
                return pngBuf.toString('base64');
              }
            }
            return '';
          };
          const tier1Result = await capturePageTier();
          if (tier1Result && tier1Result.length > 0) {
            return tier1Result;
          }
        }

        // Tier 2: CDP Page.captureScreenshot with surface sync & compositor wake kick (4000ms race).
        // `fromSurface` is always true here, and must stay that way: Chromium's native-window
        // snapshot path (fromSurface:false) dereferences the target's native window, which an
        // offscreen (OSR) agent tab does not have, and that dereference kills the browser
        // process (measured: exception 0xC0000005 at address 0x0, dumps stop in
        // WindowSnapshotReachedScreen -> GrabNativeWindowSnapshot) instead of failing the call.
        try {
          const cdpTask = async (): Promise<string | null> => {
            await this.sendCdpCommand(wc, 'Page.enable');
            await this.sendCdpCommand(wc, 'DOM.enable').catch(() => {});
            await this.sendCdpCommand(wc, 'DOM.getDocument', { depth: 1 }).catch(() => {});
            const cdpRes = await this.sendCdpCommand<{ data?: string }>(wc, 'Page.captureScreenshot', {
              format,
              quality: format === 'jpeg' ? quality : undefined,
              fromSurface: true,
              captureBeyondViewport: !isForeground,
              clip: rect
                ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
                : undefined,
            });
            return (cdpRes && typeof cdpRes.data === 'string' && cdpRes.data.length > 0) ? cdpRes.data : null;
          };
          const cdpResult = await withTimeout(cdpTask(), 4000, null);
          if (cdpResult && cdpResult.length > 0) {
            return cdpResult;
          }
        } catch {}

        // There is deliberately no native-view fallback tier here. Chromium's
        // `fromSurface:false` snapshot dereferences the target's native window, and an
        // offscreen (OSR) agent tab has none, so the browser process dies with an access
        // violation (measured: exception 0xC0000005 at address 0x0; production dumps stop
        // at WindowSnapshotReachedScreen -> GrabNativeWindowSnapshot). A target without a
        // compositor surface must fail as an empty capture, never as a process crash.

        // If all tiers yielded empty string, do a fast retry after 150ms
        try {
          await new Promise((r) => setTimeout(r, 150));
          const retryImg = await withTimeout(wc.capturePage(rect), 1500, null);
          if (retryImg && typeof retryImg.isEmpty === 'function' && !retryImg.isEmpty()) {
            return format === 'jpeg' ? retryImg.toJPEG(quality).toString('base64') : retryImg.toPNG().toString('base64');
          }
        } catch {}

        return '';
      };

      if (!isForeground && !isOffscreenTarget && this.ctx.runWithAttachedTabView && targetPaneView) {
        return await this.ctx.runWithAttachedTabView(
          targetPaneView,
          async () => {
            if (target.customViewport && target.customViewport.width > 0 && target.customViewport.height > 0) {
              if (targetPaneView && typeof targetPaneView.setBounds === 'function') {
                targetPaneView.setBounds({ x: 0, y: 0, width: target.customViewport.width, height: target.customViewport.height });
              }
            }
            try {
              await this.evalJs('new Promise(r => { const t = setTimeout(r, 60); if (typeof requestAnimationFrame === "function") { requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); } })', targetId, effectivePane);
              await delay(120);
            } catch {}
            return await captureAction();
          },
          isMobile
        );
      }
      return await captureAction();
    } finally {
      try {
        await this.evalJs(
          `(() => {
            const ov = document.getElementById('__antifan_agent_overlay__');
            if (ov) ov.classList.remove('suppressed');
          })()`,
          targetId,
          effectivePane
        );
      } catch {}
      if (maskStyleInjected) {
        try {
          await this.evalJs(
            `(() => { const el = document.getElementById('${maskStyleId}'); if (el) el.remove(); })()`,
            targetId,
            effectivePane
          );
        } catch {}
      }
    }
  });
  }

  /**
   * Assert the surface a capture copies actually exists before any compositor wait.
   *
   * A capture copies the compositor surface of the window's own contentView child.
   * A view outside `contentView` receives no BeginFrame, so it has no surface to
   * copy: `capturePage()` never settles and `Page.captureScreenshot` waits out its
   * bound — measured as the 4s native-raster bound plus the 8s no-surface CDP probe,
   * surfacing as a CAPTURE_TIMEOUT that names the wrong cause while the pane paints
   * nothing. Attachment is local ground truth, so it is read here instead of being
   * inferred from the active-tab bookkeeping: `getActiveTabId()` says which tab the
   * window should present, not which view is inside it. The active tab's view belongs
   * in the window, so a missing one is re-asserted once through the host's own repair
   * before the capture refuses.
   */
  private assertCaptureSurfacePresent(
    targetId: string,
    effectivePane: SplitPaneId | undefined,
    targetPaneView: Electron.WebContentsView | null | undefined,
    mode: CaptureMode,
    isOffscreenTarget: boolean
  ): void {
    // An offscreen (OSR) target composites without a contentView child, so attachment
    // says nothing about its surface. A host that cannot answer attachment is not
    // evidence of a missing view either: both fall through to the compositor tiers.
    if (isOffscreenTarget) return;
    if (!targetPaneView || !this.ctx.isTabViewAttached) return;
    if (this.ctx.isTabViewAttached(targetPaneView)) return;
    if (targetId === this.ctx.getActiveTabId()) {
      this.ctx.reassertPresentedView?.();
      if (this.ctx.isTabViewAttached(targetPaneView)) return;
    }
    throw new CaptureError(
      'NO_RENDER_SURFACE',
      `Tab '${targetId}' pane '${effectivePane}' cannot rasterize a ${mode} capture: its view is outside the window's contentView, so no compositor surface exists to copy (a view nobody presents receives no frames). Present the tab before capturing, or capture a target the window can show.`
    );
  }

  /**
   * Raster of the view's own composited surface, bounded so a view that cannot
   * produce one falls through to the CDP path instead of stalling the capture at
   * the caller's bound. Returns the encoded bytes plus whether the raster
   * outlived the bound: a timeout is a hung compositor (CAPTURE_TIMEOUT class),
   * not a missing surface, and the caller must not relabel it NO_RENDER_SURFACE.
   *
   * The underlying capturePage promise is shared per WebContents: a raster that
   * never answers leaves its promise pending forever, and issuing a fresh
   * capturePage per request would stack unbounded pending captures on the same
   * wedged compositor. A later call therefore waits on the same in-flight
   * raster under its own bound instead of starting another one.
   *
   * Only ever used for a viewport raster: the native surface holds nothing
   * beyond the visible region, so a clip or a document snapshot has to come from
   * the CDP path that can rasterize past the viewport.
   */
  private async captureNativeViewportRaster(
    wc: Electron.WebContents,
    format: 'png' | 'jpeg',
    quality?: number,
    boundMs: number = NATIVE_VIEWPORT_RASTER_BOUND_MS
  ): Promise<{ bytes: Buffer | null; timedOut: boolean }> {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return { bytes: null, timedOut: false };
    if (typeof wc.capturePage !== 'function') return { bytes: null, timedOut: false };
    const wcId = typeof wc.id === 'number' ? wc.id : undefined;
    let pending = wcId !== undefined ? this.nativeRasterInFlight.get(wcId) : undefined;
    if (!pending) {
      // The capture starts before the race, so the bound never cancels the
      // raster itself — only this call's wait for it.
      pending = wc.capturePage().catch(() => null);
      if (wcId !== undefined) {
        this.nativeRasterInFlight.set(wcId, pending);
        const tracked = pending;
        tracked.then(() => {
          if (this.nativeRasterInFlight.get(wcId) === tracked) {
            this.nativeRasterInFlight.delete(wcId);
          }
        }).catch(() => {});
      }
    }
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      const bound = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, Math.max(1, Math.round(boundMs)));
      });
      const image = await Promise.race([pending, bound]);
      if (!image) return { bytes: null, timedOut };
      if (typeof image.isEmpty === 'function' && image.isEmpty()) return { bytes: null, timedOut: false };
      if (format === 'jpeg' && typeof image.toJPEG === 'function') {
        const jpeg = image.toJPEG(Math.max(1, Math.min(100, Math.round(quality ?? 85))));
        if (jpeg.length > 0) return { bytes: jpeg, timedOut: false };
      }
      const png = typeof image.toPNG === 'function' ? image.toPNG() : Buffer.alloc(0);
      return { bytes: png.length > 0 ? png : null, timedOut: false };
    } catch {
      return { bytes: null, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }
  public async captureVerificationScreenshot(
    rect?: Rectangle,
    tabId?: string,
    paneId?: SplitPaneId,
    options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; timeoutMs?: number; skipQuiescence?: boolean }
  ): Promise<VerificationCaptureEnvelope> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) {
      throw new Error(`Target tab '${targetId}' not found for verification capture`);
    }
    const effectivePane = paneId || target.focusedPane;
    const isMobile = effectivePane === 'mobile';
    const targetPaneView = isMobile ? (target.mobileView || target.view) : target.view;
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) {
      throw new Error(`WebContents not available for tab '${targetId}'`);
    }
    const mode = resolveCaptureMode(rect, options?.fullPage);
    const imageFormat: 'png' | 'jpeg' = options?.format === 'jpeg' ? 'jpeg' : 'png';
    if (mode === 'full-page' && imageFormat === 'jpeg') {
      throw new CaptureError(
        'FULLPAGE_CAPTURE_UNSUPPORTED_FORMAT',
        `Full-page verification capture produces PNG evidence only; jpeg was requested for tab '${targetId}'`
      );
    }
    const isOffscreenTarget = target.state?.offscreen === true;
    if (mode === 'full-page' && isOffscreenTarget) {
      throw new CaptureError(
        'FULLPAGE_CAPTURE_UNSUPPORTED_ON_OFFSCREEN',
        `Full-page verification capture is unsupported on offscreen target '${targetId}'; use viewport/clip capture or a foreground tab`
      );
    }
    if (this.isWebContentsDraining(wc)) {
      throw new CaptureError(
        'TARGET_BUSY_DRAINING',
        `Target '${targetId}' is draining a timed-out CDP command; drain the target before capturing`
      );
    }
    const boundMs = Math.min(60_000, Math.max(1, options?.timeoutMs ?? 60_000));
    // Baseline for the geometry transaction below: a capture that rasterizes beyond
    // the viewport moves the tab's layout viewport, and the caller is entitled to find
    // the tab where it left it. It is the capture's own pre-raster reading, taken
    // inside the temporary attach for a background target because a reading taken
    // while the view is detached reports 0x0 there — and a 0x0 baseline both restores
    // into a fabricated 1x1 viewport and certifies a restore against any later
    // unmeasured reading.
    let surfaceBefore: RenderSurfaceSnapshot | undefined;
    const geometryTouched = mode !== 'viewport';
    if (target.customViewport && target.customViewport.width > 0 && target.customViewport.height > 0) {
      if (targetPaneView && typeof targetPaneView.setBounds === 'function') {
        targetPaneView.setBounds({ x: 0, y: 0, width: target.customViewport.width, height: target.customViewport.height });
      }
    } else {
      this.ensurePaneViewBounds(targetPaneView, targetId, effectivePane);
    }

    // A verification capture never foregrounds the target: the visible tab belongs to
    // the user. A background target is attached in place for the raster (below) so the
    // user's active view stays on top, and offscreen agent tabs render to an offscreen
    // compositor surface and are captured CDP-directly (full-page on an offscreen target
    // is rejected above, never degraded to capturePage) — no path switches the visible
    // tab, so nothing has to be restored afterwards.
    const isForeground = targetId === this.ctx.getActiveTabId();

    let captureEnvelope: VerificationCaptureEnvelope | undefined;
    let captureError: Error | undefined;
    let viewportTransaction: CaptureViewportTransaction | undefined;
    let lastPrewarmReceipt: ScrollPrewarmReceipt | undefined;
    let prewarmFailure: string | undefined;
    let lastQuiescence: PreCaptureQuiescenceResult | undefined;
    try {
      captureEnvelope = await this.ctx.withTabAgentWorking(targetId, async () => {
        // Screenshot Guard: Temporarily suppress agent overlay & visual cursor during capture
        try {
          await this.evalJs(
            `(() => {
              const ov = document.getElementById('__antifan_agent_overlay__');
              if (ov) ov.classList.add('suppressed');
            })()`,
            targetId,
            effectivePane
          );
        } catch {}
        const captureAction = async (): Promise<VerificationCaptureEnvelope> => {
          this.assertCaptureSurfacePresent(targetId, effectivePane, targetPaneView, mode, isOffscreenTarget);
          // Derive zoom and DPR directly from browser/CDP state inside agent working block (atomic with capture, non-nesting)
          const zoom = typeof wc.getZoomFactor === 'function' ? wc.getZoomFactor() : 1.0;
          // The tab's live surface is the only source of capture geometry. A
          // fabricated viewport would rasterize a surface that does not exist and
          // then consume the whole bound instead of reporting why it cannot run.
          let surface: RenderSurfaceSnapshot;
          try {
            surface = await this.probeRenderSurface(wc, RENDER_SURFACE_PROBE_BOUND_MS);
          } catch (err) {
            if (err instanceof CaptureError && err.code === 'NO_RENDER_SURFACE') throw err;
            throw new CaptureError(
              'NO_RENDER_SURFACE',
              `Render-surface probe on tab '${targetId}' pane '${effectivePane}' failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          // Kept as an explicit comparison rather than the shared predicate: a type
          // predicate narrows the degenerate branch to `never`, and the refusal needs
          // the measured values to name why the surface cannot be captured.
          if (!Number.isFinite(surface.vw) || !Number.isFinite(surface.vh) || surface.vw < 1 || surface.vh < 1) {
            throw new CaptureError(
              'NO_RENDER_SURFACE',
              `Tab '${targetId}' pane '${effectivePane}' has no renderable surface: it reports ${surface.vw}x${surface.vh} CSS px (readyState '${surface.readyState}', hidden ${surface.hidden}, cause ${classifyRenderSurfaceCause(surface)}). Size the tab with anti.browser.set_viewport or navigate it to a real page before capturing.`
            );
          }
          // The geometry baseline is this reading: it is the surface the capture is
          // about to rasterize, measured where the view is presented, so the restore
          // compares against a viewport that really existed.
          surfaceBefore = surface;
          // A window that is not on screen keeps a measurable layout viewport but
          // its compositor never produces a beyond-viewport raster:
          // Page.captureScreenshot with captureBeyondViewport then waits out the
          // whole bound instead of failing (measured: 60s CAPTURE_TIMEOUT after
          // win.hide(), both GPU modes). document.hidden does NOT observe
          // win.hide() here — the renderer still reports visible — so the owning
          // window's presented state is the authoritative signal, with the
          // renderer's own hidden flag kept as a second witness. Viewport capture
          // still rasterizes the existing surface, so the refusal is scoped to
          // clip/full-page. Offscreen targets keep their own path — they
          // rasterize an offscreen surface regardless of window visibility, and
          // full-page on them is already refused above.
          if (mode !== 'viewport' && !isOffscreenTarget) {
            const windowPresented = this.ctx.isWindowRenderable ? this.ctx.isWindowRenderable() : true;
            if (!windowPresented || surface.hidden === true) {
              const cause = surface.hidden === true ? classifyRenderSurfaceCause(surface) : 'window-not-presented';
              throw new CaptureError(
                'NO_RENDER_SURFACE',
                `Tab '${targetId}' pane '${effectivePane}' cannot rasterize a ${mode} capture: the window is hidden or minimized, so the compositor produces no beyond-viewport surface (${surface.vw}x${surface.vh} CSS px, readyState '${surface.readyState}', cause ${cause}). Show the window or use a viewport capture.`
              );
            }
          }
          const dpr = surface.dpr;
          const cssViewport = { width: surface.vw, height: surface.vh };
          // Refuse an impossible full-page request before spending the walk and the
          // settle gate on it. The document is measured again after the walk — lazily
          // mounted content can push a legal page past the ceiling, and that later
          // check stays authoritative — but a page that is already over the ceiling
          // cannot become legal by walking it, so the walk would only add ~2 s of
          // staircase scrolling before the same refusal.
          if (mode === 'full-page') {
            const preflightHeight = await this.readDocumentScrollHeight(wc);
            if (
              !Number.isFinite(preflightHeight) ||
              preflightHeight < 1 ||
              preflightHeight > CAPTURE_MAX_DIMENSION ||
              cssViewport.width > CAPTURE_MAX_DIMENSION
            ) {
              throw new CaptureError(
                'FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY',
                `Requested ${mode} capture region ${cssViewport.width}x${preflightHeight} CSS px is outside the supported 1..${CAPTURE_MAX_DIMENSION} range on tab '${targetId}'`
              );
            }
          }
          // A full-page raster is one compositor snapshot, so lazily mounted
          // content must already be in the document. Walk the page once before
          // the quiescence gate measures it, otherwise the gate certifies a
          // document that then grows during the raster and the capture either
          // misses the tail or allocates a buffer the GPU cannot honour.
          if (mode === 'full-page' && !options?.skipQuiescence) {
            try {
              const prewarmRaw = await this.evalJs(
                buildStaircasePrewarmScript(),
                targetId,
                effectivePane,
                false,
                PREWARM_EXEC_BUDGET_MS
              );
              lastPrewarmReceipt = normalizeScrollPrewarmResult(prewarmRaw);
            } catch (err: unknown) {
              lastPrewarmReceipt = undefined;
              prewarmFailure = err instanceof Error ? err.message : String(err);
            }
          }

          if (!options?.skipQuiescence) {
            const quiescence = await evaluatePreCaptureQuiescence(
              {
                evalJs: (script: string, tId?: string, pId?: 'desktop' | 'mobile') =>
                  this.evalJs(script, tId || targetId, pId || effectivePane),
              },
              targetId,
              effectivePane,
              { fullPage: mode === 'full-page' }
            );
            lastQuiescence = quiescence;
            if (!quiescence.ready) {
              // `evaluatePreCaptureQuiescence` reports the failing predicate as one of
              // 'documentGenerationSettled' | 'viewportStable' | 'fontsSettled' | 'imagesSettled' |
              // 'imageIdentityStable' | 'layoutStable'; map the two with dedicated capture codes so
              // they stay distinguishable from a generic readiness failure.
              const code = quiescence.failingPredicate === 'imageIdentityStable'
                ? 'IMAGE_IDENTITY_UNSTABLE'
                : quiescence.failingPredicate === 'documentGenerationSettled'
                ? 'DOCUMENT_GENERATION_UNSETTLED'
                : 'CAPTURE_NOT_READY';
              throw new CaptureError(
                code,
                `Pre-capture quiescence predicate '${quiescence.failingPredicate}' failed on tab '${targetId}' pane '${effectivePane}': ${quiescence.reason || 'quiescence not reached'}`
              );
            }
          }

          await this.sendCdpCommand(wc, 'Page.enable');
          await this.sendCdpCommand(wc, 'Emulation.setDefaultBackgroundColorOverride', {
            color: { r: 255, g: 255, b: 255, a: 1 },
          }).catch(() => {});

          // cssCaptureSize describes the region Chromium is asked to rasterize:
          // viewport (no clip), clip rect (rect wins over fullPage), or document.
          let cssCaptureSize: { width: number; height: number };
          let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
          if (mode === 'clip' && rect) {
            cssCaptureSize = { width: rect.width, height: rect.height };
            clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
          } else if (mode === 'full-page') {
            const documentScrollHeight = await this.readDocumentScrollHeight(wc);
            cssCaptureSize = { width: cssViewport.width, height: documentScrollHeight };
            clip = { x: 0, y: 0, width: cssViewport.width, height: documentScrollHeight, scale: 1 };
          } else if (mode === 'clip') {
            throw new CaptureError('FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY', `Clip capture requires a rectangle on tab '${targetId}'`);
          } else {
            cssCaptureSize = { width: cssViewport.width, height: cssViewport.height };
          }

          // Reject unsupported geometry instead of clamping: a clamped capture
          // would silently misrepresent the document region it claims to show.
          if (mode !== 'viewport') {
            const { width, height } = cssCaptureSize;
            if (
              !Number.isFinite(width) || !Number.isFinite(height) ||
              width < 1 || height < 1 ||
              width > CAPTURE_MAX_DIMENSION || height > CAPTURE_MAX_DIMENSION
            ) {
              throw new CaptureError(
                'FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY',
                `Requested ${mode} capture region ${width}x${height} CSS px is outside the supported 1..${CAPTURE_MAX_DIMENSION} range on tab '${targetId}'`
              );
            }
          }

          // A viewport raster is exactly what the native view already composites,
          // so ask the view for it before reaching for a fresh copy of the
          // compositor surface. A background target is attached in place for the
          // raster — the window is not presenting it — and Page.captureScreenshot
          // on a surface nobody presents can wait out the whole bound instead of
          // failing; that same hang leaves the target's CDP transport draining,
          // which blocks every later command on it. The native raster is
          // geometry-checked against the measured render surface, so a view that
          // answers with a different size (emulated viewport, scaled pane) falls
          // through to CDP instead of returning mislabeled evidence.
          //
          // ONE bounded Page.captureScreenshot below. No retry tier: a second
          // attempt on a poisoned CDP queue is what wedged the target before.
          //
          // clip/full-page must rasterize from the compositor surface: with
          // fromSurface:false Chromium captures the renderer view, which is
          // bounded by the widget height, so a clip taller than the viewport
          // comes back silently truncated to the viewport (measured: clip
          // 1440x2200 -> raster 1440x900) while the receipt still declares the
          // requested CSS size. The target is activated (or attached via
          // runWithAttachedTabView) before this call, so the surface belongs to
          // the requested tab.
          //
          // `fromSurface` is true for every mode, not only clip/full-page. It is the
          // compositor-surface flag, so it is the same flag that keeps an offscreen
          // (OSR) agent tab from being snapshot through a native window it does not
          // have — the renderer-view path dereferences that window and kills the
          // browser process (measured: exception 0xC0000005 at address 0x0) instead of
          // returning an error. A target without a surface yields a typed capture
          // error rather than a crash.
          // Re-check right before the dispatch: the refusal above runs before the
          // walk + settle gate (seconds of work), so a window hidden mid-capture
          // would otherwise still reach captureBeyondViewport and wait out the
          // bound — the same 60s hang this guard exists to prevent.
          let nativeRasterAnswered = false;
          let nativeRasterTimedOut = false;
          if (mode === 'viewport' && !isOffscreenTarget) {
            const nativeRaster = await this.captureNativeViewportRaster(wc, imageFormat, options?.quality, Math.min(boundMs, NATIVE_VIEWPORT_RASTER_BOUND_MS));
            nativeRasterTimedOut = nativeRaster.timedOut;
            const nativeBytes = nativeRaster.bytes;
            if (nativeBytes) {
              const nativeImage = imageFormat === 'jpeg' ? validateJpegBuffer(nativeBytes) : validatePngBuffer(nativeBytes);
              const nativeSize = nativeImage.ok ? { width: nativeImage.width, height: nativeImage.height } : null;
              if (nativeImage.ok && nativeSize) nativeRasterAnswered = true;
              if (nativeImage.ok && nativeSize && rasterMatchesCss(nativeSize, cssCaptureSize, dpr, zoom)) {
                return {
                  data: nativeBytes.toString('base64'),
                  backend: 'capturePage',
                  dpr,
                  zoom,
                  cssViewport,
                  cssCaptureSize,
                  rasterSize: nativeSize,
                  captureMode: mode,
                  timestamp: Date.now(),
                  settle: lastQuiescence?.warnings,
                };
              }
            }
          }

          // A surface that no window presents never answers the capture: measured
          // against a detached WebContentsView (never added to a window's contentView),
          // Page.captureScreenshot times out for viewport and beyond-viewport alike and
          // capturePage() never settles, while the same view attached to the window
          // answers in ~130ms. Occlusion is irrelevant (a covered view captures in
          // ~150ms). Failing closed keeps a missing surface a typed error instead of a
          // bound-long hang that also poisons the target's CDP queue.
          if (!isForeground && !isOffscreenTarget && this.ctx.isTabViewAttached && targetPaneView && !this.ctx.isTabViewAttached(targetPaneView)) {
            throw new CaptureError(
              'NO_RENDER_SURFACE',
              `Tab '${targetId}' pane '${effectivePane}' cannot rasterize a ${mode} capture: its view is not attached to a window, so the compositor produces no surface. Present the view (attach-for-capture) before capturing.`
            );
          }

          if (mode !== 'viewport' && !isOffscreenTarget && this.ctx.isWindowRenderable && !this.ctx.isWindowRenderable()) {
            throw new CaptureError(
              'NO_RENDER_SURFACE',
              `Tab '${targetId}' pane '${effectivePane}' cannot rasterize a ${mode} capture: the window was hidden or minimized during capture setup, so the compositor produces no beyond-viewport surface. Show the window or use a viewport capture.`
            );
          }
          // A viewport raster the native tier answered empty has no compositor
          // frame to copy: the fallback would wait out its whole bound and leave
          // the target's CDP transport draining. Give it a short probe bound
          // instead, and name the missing surface when it cannot answer (below).
          // A native raster that TIMED OUT is a different class: the compositor
          // hung, so a probe failure must report the measured timeout, never
          // the NO_RENDER_SURFACE label reserved for an absent surface.
          const captureHasNoSurface = mode === 'viewport' && !isOffscreenTarget && !nativeRasterAnswered;
          const cdpBoundMs = captureHasNoSurface ? Math.min(boundMs, NO_SURFACE_CAPTURE_PROBE_BOUND_MS) : boundMs;
          let captureRes: { data?: string } | undefined;
          try {
            captureRes = await this.sendCdpCommand<{ data?: string }>(
              wc,
              'Page.captureScreenshot',
              {
                format: imageFormat,
                quality: imageFormat === 'jpeg' ? Math.max(1, Math.min(100, Math.round(options?.quality ?? 85))) : undefined,
                fromSurface: true,
                captureBeyondViewport: mode !== 'viewport',
                clip,
              },
              cdpBoundMs
            );
          } catch (err) {
            if (captureHasNoSurface && !nativeRasterTimedOut) {
              throw new CaptureError(
                'NO_RENDER_SURFACE',
                `Tab '${targetId}' pane '${effectivePane}' produced no ${mode} raster: the native view handed back no frame and the CDP fallback found no compositor surface to copy, so the window is not presenting this view (a hidden, minimised or Chromium-occluded window, or a tab the window is not showing). Bring the AntiFan window to the foreground, or capture an offscreen agent-plane tab.`
              );
            }
            throw this.toCaptureError(err, `Page.captureScreenshot (${mode}) on tab '${targetId}'`);
          }

          if (!captureRes || typeof captureRes.data !== 'string' || captureRes.data.length === 0) {
            throw new CaptureError('CAPTURE_EMPTY_PAYLOAD', `CDP Page.captureScreenshot returned an empty payload on tab '${targetId}'`);
          }
          const bytes = Buffer.from(captureRes.data, 'base64');
          const image = imageFormat === 'jpeg' ? validateJpegBuffer(bytes) : validatePngBuffer(bytes);
          if (!image.ok) {
            const fallback = imageFormat === 'jpeg' ? 'CAPTURE_JPEG_UNDECODABLE' : 'CAPTURE_PNG_UNDECODABLE';
            throw new CaptureError(
              image.code ?? fallback,
              `CDP Page.captureScreenshot payload on tab '${targetId}' failed ${imageFormat.toUpperCase()} validation (${image.code ?? fallback}, ${bytes.length} bytes)`
            );
          }
          const rasterSize = { width: image.width, height: image.height };
          if (!rasterMatchesCss(rasterSize, cssCaptureSize, dpr, zoom)) {
            throw new CaptureError(
              'CAPTURE_SCALE_MISMATCH',
              `Raster ${rasterSize.width}x${rasterSize.height} does not match CSS capture ${cssCaptureSize.width}x${cssCaptureSize.height} at dpr ${dpr} x zoom ${zoom} on tab '${targetId}'`
            );
          }

          return {
            data: captureRes.data,
            backend: 'cdp',
            dpr,
            zoom,
            cssViewport,
            cssCaptureSize,
            rasterSize,
            captureMode: mode,
            timestamp: Date.now(),
            // The walk's receipt travels with the evidence: a caller reading a
            // full-page capture needs to know whether the document was fully
            // materialized or whether a growth ceiling stopped the walk early.
            prewarm: lastPrewarmReceipt,
            prewarmError: prewarmFailure,
            // What the settle gate had to tolerate: a page with a rotating banner, a
            // permanently broken ad image, or a late-settling layout is capturable, but
            // the receipt has to say so rather than report a clean document.
            settle: lastQuiescence?.warnings,
          };
        };

        if (!isForeground && !isOffscreenTarget && this.ctx.runWithAttachedTabView && targetPaneView) {
          return await this.ctx.runWithAttachedTabView(
            targetPaneView,
            async () => {
              if (target.customViewport && target.customViewport.width > 0 && target.customViewport.height > 0) {
                if (targetPaneView && typeof targetPaneView.setBounds === 'function') {
                  targetPaneView.setBounds({ x: 0, y: 0, width: target.customViewport.width, height: target.customViewport.height });
                }
              }
              try {
                await this.evalJs('new Promise(r => { const t = setTimeout(r, 60); if (typeof requestAnimationFrame === "function") { requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); } })', targetId, effectivePane);
                await delay(120);
              } catch {}
              try {
                return await captureAction();
              } finally {
                // The pane presents a measurable surface only while it is attached
                // (`layOutDetachedView` sized it above), so the restore runs — and
                // proves itself by re-measuring — on the same presented surface the
                // baseline was read from. After the release the reading would be a
                // detached view's 0x0, which proves nothing about the restore.
                if (geometryTouched) viewportTransaction = await this.restoreCapturedGeometry(wc, targetId, effectivePane, surfaceBefore);
              }
            },
            isMobile
          );
        }
        return await captureAction();
      });
    } catch (err) {
      captureError = this.toCaptureError(err, `Verification capture on tab '${targetId}'`);
    } finally {
      try {
        await this.evalJs(
          `(() => {
            const ov = document.getElementById('__antifan_agent_overlay__');
            if (ov) ov.classList.remove('suppressed');
          })()`,
          targetId,
          effectivePane
        );
      } catch {}
      // Guaranteed white background override clear with drain bypass
      try {
        const sendDirectBgClear = async () => {
          if (!wc.isDestroyed() && wc.debugger && wc.debugger.isAttached()) {
            await wc.debugger.sendCommand('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => {});
          }
        };
        if (this.isWebContentsDraining(wc)) {
          await sendDirectBgClear();
        } else {
          await this.sendCdpCommand(wc, 'Emulation.setDefaultBackgroundColorOverride').catch(async () => {
            await sendDirectBgClear();
          });
        }
      } catch {}
      // Unconditionally restore real layout for the active tab view
      try {
        this.ctx.updateLayout?.();
      } catch (err) {
        console.warn('[tab-devtools-host] Layout restore failed in captureVerificationScreenshot finally:', err);
      }
    }
    // The restore and its verification run where the surface is real: inside the
    // temporary attach for a background target (above), directly for a foreground
    // or offscreen one. A geometry-touching capture that measured no baseline has
    // nothing to restore against, so it reports no transaction at all instead of
    // clamping an invented 1x1 viewport or certifying two unmeasured readings as
    // restored.
    if (geometryTouched && !viewportTransaction) {
      viewportTransaction = await this.restoreCapturedGeometry(wc, targetId, effectivePane, surfaceBefore);
    }
    if (viewportTransaction && !viewportTransaction.restored && !viewportTransaction.deferred) {
      // A moved layout viewport is a state hazard, so it outranks the original
      // capture outcome: evidence captured on a surface we could not restore
      // must never be receipted as usable geometry.
      throw new CaptureError(
        'CAPTURE_VIEWPORT_NOT_RESTORED',
        `Capture on tab '${targetId}' left the layout viewport at ${viewportTransaction.after ? `${viewportTransaction.after.width}x${viewportTransaction.after.height}` : 'an unmeasurable size'} after ${viewportTransaction.attempts} restore attempts (expected ${viewportTransaction.before ? `${viewportTransaction.before.width}x${viewportTransaction.before.height}` : 'unknown'})`,
        {
          tabId: targetId,
          paneId: effectivePane,
          expectedWidth: viewportTransaction.before?.width,
          expectedHeight: viewportTransaction.before?.height,
          observedWidth: viewportTransaction.after?.width,
          observedHeight: viewportTransaction.after?.height,
          attempts: viewportTransaction.attempts,
          causeCapture: captureError
            ? { code: captureError instanceof CaptureError ? captureError.code : undefined, message: captureError.message }
            : undefined,
        }
      );
    }
    if (captureError) throw captureError;
    if (!captureEnvelope) {
      throw new Error(`Verification capture on tab '${targetId}' produced no envelope and no error`);
    }
    if (viewportTransaction) captureEnvelope.viewportTransaction = viewportTransaction;
    return captureEnvelope;
  }

  /**
   * Restores a tab's layout viewport and scroll offset after the target has been
   * drained. The transport rejects CDP commands while a timed-out command is
   * still draining, so the post-capture restore runs here — on the fresh
   * attachment — instead of inside the capture that timed out.
   */
  public async reapplyTabGeometry(
    tabId: string,
    paneId: SplitPaneId | undefined,
    before: { width: number; height: number; scrollX: number; scrollY: number }
  ): Promise<CaptureViewportTransaction> {
    const target = this.ctx.getTabRecord(tabId);
    if (!target) {
      throw new Error(`Target tab '${tabId}' not found for geometry restore`);
    }
    const effectivePane = paneId || target.focusedPane;
    const wc = this.ctx.getTabWebContents(tabId, effectivePane);
    if (!wc || wc.isDestroyed()) {
      throw new Error(`WebContents not available for tab '${tabId}'`);
    }
    const targetPaneView = effectivePane === 'mobile' ? target.mobileView || target.view : target.view;
    return this.applyGeometryRestore({
      wc,
      targetId: tabId,
      effectivePane,
      targetPaneView,
      customViewport: target.customViewport,
      before: { vw: before.width, vh: before.height, dpr: 1, scrollX: before.scrollX, scrollY: before.scrollY, docH: 0, readyState: 'complete', hidden: false },
    });
  }

  /**
   * Restores the layout geometry a clip/full-page capture moved, on the surface that
   * capture measured its baseline on: the caller runs this while that surface is
   * presented (inside the temporary attach for a background target), so the
   * re-measure that proves the restore reads the same surface the baseline described.
   *
   * A capture that never measured a baseline has nothing to restore against, so the
   * restore is skipped deliberately and no transaction is reported — the alternative
   * would be restoring to an invented 1x1 viewport. `undefined` therefore means "no
   * transaction to report", never "restored".
   *
   * A draining transport cannot carry the restore commands, so the transaction is
   * reported as deferred for the caller to reapply after the drain.
   */
  private async restoreCapturedGeometry(
    wc: Electron.WebContents,
    tabId: string,
    pane: SplitPaneId | undefined,
    before: RenderSurfaceSnapshot | undefined
  ): Promise<CaptureViewportTransaction | undefined> {
    if (!hasMeasuredSurface(before)) return undefined;
    if (this.isWebContentsDraining(wc)) {
      return {
        before: { width: before.vw, height: before.vh, scrollX: before.scrollX, scrollY: before.scrollY },
        after: null,
        restored: false,
        attempts: 0,
        deferred: true,
      };
    }
    const target = this.ctx.getTabRecord(tabId);
    if (!target) return undefined;
    return await this.applyGeometryRestore({
      wc,
      targetId: tabId,
      effectivePane: pane,
      targetPaneView: pane === 'mobile' ? target.mobileView || target.view : target.view,
      customViewport: target.customViewport,
      before,
    });
  }

  /**
   * Puts the tab's layout viewport and scroll offset back where the capture found
   * them, then proves it by re-measuring. Two bounded attempts: the first restores
   * the tab's own emulation state, the second forces the measured geometry back.
   * A failed verification is reported, never assumed away.
   */
  private async applyGeometryRestore(args: {
    wc: Electron.WebContents;
    targetId: string;
    effectivePane: SplitPaneId | undefined;
    targetPaneView: Electron.WebContentsView | null | undefined;
    customViewport: { width: number; height: number } | undefined;
    before: RenderSurfaceSnapshot;
  }): Promise<CaptureViewportTransaction> {
    // A baseline that was never measured cannot be restored to: the forced second
    // attempt would clamp it into a fabricated 1x1 override, and the comparison would
    // then pass against any degenerate reading. Refuse instead, claiming no
    // expectation and no restoration, so the caller treats the geometry as unproven
    // rather than restored.
    if (!hasMeasuredSurface(args.before)) {
      return { before: null, after: null, restored: false, attempts: 0 };
    }
    const before = {
      width: args.before.vw,
      height: args.before.vh,
      scrollX: args.before.scrollX,
      scrollY: args.before.scrollY,
    };
    const bound = RENDER_SURFACE_PROBE_BOUND_MS;
    let after: RenderSurfaceSnapshot | undefined;
    let attempts = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      attempts = attempt;
      try {
        if (attempt === 1) {
          if (args.customViewport && args.customViewport.width > 0 && args.customViewport.height > 0) {
            await this.sendCdpCommand(args.wc, 'Emulation.setDeviceMetricsOverride', {
              width: Math.max(1, Math.round(args.customViewport.width)),
              height: Math.max(1, Math.round(args.customViewport.height)),
              deviceScaleFactor: args.before.dpr || 1,
              mobile: false,
            });
          } else {
            await this.sendCdpCommand(args.wc, 'Emulation.clearDeviceMetricsOverride');
          }
        } else {
          await this.sendCdpCommand(args.wc, 'Emulation.setDeviceMetricsOverride', {
            width: Math.max(1, Math.round(before.width)),
            height: Math.max(1, Math.round(before.height)),
            deviceScaleFactor: args.before.dpr || 1,
            mobile: false,
          });
        }
        const isAttached = (this.ctx.isTabViewAttached && this.ctx.isTabViewAttached(args.targetPaneView)) || args.targetId === this.ctx.getActiveTabId();
        if (args.customViewport && args.customViewport.width > 0 && args.customViewport.height > 0) {
          if (isAttached) {
            if (args.targetId === this.ctx.getActiveTabId()) {
              this.ctx.updateLayout?.();
            } else {
              this.ctx.applyTabDeviceEmulation?.(args.targetId);
            }
          }
        } else if (isAttached) {
          this.ctx.updateLayout?.();
        }
        await this.sendCdpCommand(
          args.wc,
          'Runtime.evaluate',
          {
            expression: `window.scrollTo({ left: ${before.scrollX}, top: ${before.scrollY}, behavior: 'instant' })`,
            returnByValue: true,
          },
          bound
        ).catch(() => {});
        const reading = await this.probeRenderSurface(args.wc, bound);
        // Only a reading taken on a presented surface describes the viewport: a
        // detached view reports 0x0, which is no measurement at all and can neither
        // prove nor disprove the restore, so it is never compared. `after` keeps the
        // last reading that was actually taken.
        if (hasMeasuredSurface(reading)) {
          after = reading;
          if (Math.abs(reading.vw - before.width) <= 1 && Math.abs(reading.vh - before.height) <= 1) {
            return {
              before,
              after: { width: reading.vw, height: reading.vh, scrollX: reading.scrollX, scrollY: reading.scrollY },
              restored: true,
              attempts,
            };
          }
        }
      } catch {
        // A failed restore attempt is retried once with the measured geometry;
        // the verification below decides the outcome.
      }
    }
    return {
      before,
      after: after ? { width: after.vw, height: after.vh, scrollX: after.scrollX, scrollY: after.scrollY } : null,
      restored: false,
      attempts,
    };
  }

  public async getDom(selector?: string, tabId?: string, paneId?: SplitPaneId): Promise<string> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) throw new CapabilityError('TARGET_STALE', `No such tab: ${targetId}`);
    const effectivePane = paneId || target.focusedPane;
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) {
      throw new CapabilityError('TARGET_STALE', `Tab ${targetId} has no live web contents in pane ${effectivePane}`);
    }
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
    userGesture = false,
    timeoutMs = EVAL_JS_DEFAULT_TIMEOUT_MS
  ): Promise<unknown> {
    const softBudgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : EVAL_JS_DEFAULT_TIMEOUT_MS;
    const hardBudgetMs = Math.max(softBudgetMs + 3000, Math.round(softBudgetMs * 2.5));
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) throw new CapabilityError('TARGET_STALE', `No such tab: ${targetId}`);
    const effectivePane = paneId || target.focusedPane;
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) {
      throw new CapabilityError('TARGET_STALE', `Tab ${targetId} has no live web contents in pane ${effectivePane}`);
    }
    return this.ctx.withTabAgentWorking(targetId, async () => {
      const execute = async (): Promise<unknown> => {
        const wrapped = `(async () => {
        ${SERIALIZE_CIRCULAR_SAFE_SOURCE}
        try {
          // In-page execution budget guard
          const execBudgetMs = ${JSON.stringify(softBudgetMs)};
          const execPromise = (async () => (0, eval)(${JSON.stringify(expression)}))();
          let timer;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Evaluation timed out after ' + execBudgetMs + 'ms (note: requestAnimationFrame pauses in background tabs)')), execBudgetMs);
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
      };

      // Out-of-Band 2-Tier Watchdog Timers (Node.js level)
      const softTimer = setTimeout(() => {
        console.warn(`[evalJs:SoftWarning] Script evaluation on tab ${targetId} reached soft budget ${softBudgetMs}ms (running on laptop CPU). Awaiting hard ceiling ${hardBudgetMs}ms...`);
      }, softBudgetMs);

      const { promise: hardWatchdogPromise, reject: hardReject } = Promise.withResolvers<never>();
      const hardTimer = setTimeout(async () => {
        try {
          if (wc && !wc.isDestroyed()) {
            await this.sendCdpCommand(wc, 'Runtime.terminateExecution', {}).catch(() => {});
          }
        } catch {}
        hardReject(new CapabilityError('EVAL_HARD_TIMEOUT', `Script execution hung and exceeded hard ceiling of ${hardBudgetMs}ms`));
      }, hardBudgetMs);
      try {
        const runner = async (): Promise<unknown> => {
          const paneView = effectivePane === 'mobile' ? (target.mobileView || target.view) : target.view;
          const isActiveTarget = targetId === this.ctx.getActiveTabId();
          const isOffscreenTarget = target.state?.offscreen === true;
          if (!isActiveTarget && !isOffscreenTarget && paneView && this.ctx.runWithAttachedTabView) {
            const isMobilePane = effectivePane === 'mobile' && Boolean(target.mobileView);
            return await this.ctx.runWithAttachedTabView(paneView, execute, isMobilePane);
          }
          return await execute();
        };

        return await Promise.race([runner(), hardWatchdogPromise]);
      } finally {
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
      }
    });
  }

  /**
   * Evaluate an expression inside a child frame (cross-origin iframe) selected by
   * URL substring.
   *
   * Frame identity comes from `WebFrameMain.framesInSubtree`, deliberately not from
   * `Page.getFrameTree`: the CDP frame tree reports a cross-origin child without its
   * committed URL, so URL matching there can never resolve an embedded app frame.
   * The expression is embedded in the wrapper rather than passed through `eval`, so a
   * page CSP that forbids `unsafe-eval` cannot reject the injected frame's own script.
   * A miss is a typed `SELECTOR_NOT_FOUND` carrying the real frame census, never a
   * silent `undefined`.
   */
  public async evalJsInFrame(
    expression: string,
    frameUrl: string,
    tabId?: string,
    paneId?: SplitPaneId,
    userGesture = false,
    timeoutMs = EVAL_JS_DEFAULT_TIMEOUT_MS
  ): Promise<unknown> {
    const softBudgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : EVAL_JS_DEFAULT_TIMEOUT_MS;
    const hardBudgetMs = Math.max(softBudgetMs + 3000, Math.round(softBudgetMs * 2.5));
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) throw new CapabilityError('TARGET_STALE', `No such tab: ${targetId}`);
    const effectivePane = paneId || target.focusedPane;
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) {
      throw new CapabilityError('TARGET_STALE', `Tab ${targetId} has no live web contents in pane ${effectivePane}`);
    }
    const frame = findChildFrameByUrl(wc, frameUrl, targetId);

    return this.ctx.withTabAgentWorking(targetId, async () => {
      const execute = async (): Promise<unknown> => {
        const wrapped = `(async () => {
  ${SERIALIZE_CIRCULAR_SAFE_SOURCE}
  const execBudgetMs = ${JSON.stringify(softBudgetMs)};
  const execPromise = (async () => (
${expression}
))();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Evaluation timed out after ' + execBudgetMs + 'ms (note: requestAnimationFrame pauses in background tabs)')), execBudgetMs);
  });
  const result = await Promise.race([execPromise, timeoutPromise]).finally(() => clearTimeout(timer));
  return serializeCircularSafe(result);
})()`;
        try {
          return await frame.executeJavaScript(wrapped, userGesture);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new CapabilityError('EXECUTION_ERROR', `Frame ${frame.frameTreeNodeId} (${frame.url || 'no url'}) evaluation failed: ${msg}`);
        }
      };

      const { promise: hardWatchdogPromise, reject: hardReject } = Promise.withResolvers<never>();
      const hardTimer = setTimeout(() => {
        hardReject(new CapabilityError('EVAL_HARD_TIMEOUT', `Frame evaluation on tab ${targetId} exceeded hard ceiling of ${hardBudgetMs}ms`));
      }, hardBudgetMs);
      try {
        return await Promise.race([execute(), hardWatchdogPromise]);
      } finally {
        clearTimeout(hardTimer);
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
    this.cdpDrainingTargets.clear();
    this.stylesheetUrls.clear();
    this.isolatedContextIds.clear();
    this.trackerIsolation.clear();
  }
}
