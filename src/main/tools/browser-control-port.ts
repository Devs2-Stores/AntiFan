import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { buildTreeWalkerSanitizerScript } from './adapters/tree-walker-sanitizer';
import { BrowserTarget, CapabilityError, ArtifactRef, assertExactBrowserTarget, digestText } from '../../shared/control-plane-contracts';
export interface BrowserHostPort {
  hasTab?(tabId?: string | null): boolean;
  getTabList(): unknown[];
  getActiveTabId?(): string;
  getAutomationTabId?(): string | null;
  setAutomationTabId?(tabId?: string): void;
  createTab?(url?: string, activate?: boolean, options?: { capsuleId?: string; userAgentMode?: any; ephemeral?: boolean }): string;
  closeTab?(tabId: string): boolean;
  switchTab?(tabId: string): boolean;
  navigate(tabId: string, url: string): Promise<boolean> | boolean;
  reload(tabId: string): Promise<boolean> | boolean;
  getDom(selector?: string, tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<string>;
  captureScreenshot(rect?: unknown, tabId?: string, paneId?: 'desktop' | 'mobile', options?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<string>;
  evalJs(expression: string, tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<unknown>;
  getDiagnostics?(tabId?: string, level?: number | string): { console: unknown[]; failures: unknown[] };
  runResponsiveCheck?(tabId: string): Promise<Record<string, unknown>>;
  agentTrajectory?(params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<Record<string, unknown>>;
  agentMove?(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentClick?(params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentType?(params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentScroll?(params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentHover?(params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentHighlight?(params: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentClear?(tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<boolean>;
  agentSnapshot?(tabId?: string, paneId?: 'desktop' | 'mobile', selector?: string, viewportOnly?: boolean): Promise<string>;
  agentFind?(params: { text?: string; regex?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; maxMatches?: number }): Promise<unknown>;
  sendKeyboardPress?(params: { key: string; modifiers?: string[]; tabId?: string }): Promise<{ success: boolean; key: string; modifiers: string[] }>;
  setViewportSize?(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string }): boolean;
  setDevicePreset?(tabId: string, presetId: string): boolean;
  getDevicePresets?(): unknown[];
  setZoom?(tabId: string, zoomFactor: number): boolean;
  toggleInspect?(): boolean;
  isCurrentTarget?(target: BrowserTarget): boolean;
  clearAllAgentWorking?(): void;
  getDocumentGeneration?(tabId?: string): number;
  uploadFileInput?(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<{ success: boolean; uploadedCount: number; reason?: string }>;
  dropFiles?(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<{ success: boolean; droppedCount: number; reason?: string }>;
  executeActionSequence?(params: { actions: unknown[]; tabId?: string; paneId?: 'desktop' | 'mobile'; stopOnError?: boolean }): Promise<unknown>;
  inspectStyles?(params: { selector?: string; ref?: string; properties?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<Record<string, unknown>>;
  inspectRegion?(params: { x?: number; y?: number; width?: number; height?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<Record<string, unknown>>;
  getNetworkTracker?(): { isAttached: (tabId: string, paneId?: string) => boolean; awaitQuiescence: (tabId: string, paneId?: string, options?: unknown, signal?: AbortSignal) => Promise<{ settled: boolean; durationMs: number; timedOut: boolean }> };
  wait?(params: BrowserWaitParams, signal?: AbortSignal): Promise<BrowserWaitResult>;
  observe?(params: BrowserObserveParams): Promise<BrowserObserveResult>;
}

export interface BrowserObserveParams {
  components?: Array<'dom' | 'screenshot' | 'snapshot' | 'diagnostics'>;
  selector?: string;
  tabId?: string;
  paneId?: 'desktop' | 'mobile';
}

export interface BrowserObserveResult {
  target: {
    tabId: string;
    paneId: 'desktop' | 'mobile';
    browserEpoch: number;
    documentGeneration: number;
    documentUrl?: string;
  };
  components: {
    dom?: ArtifactRef | string;
    screenshot?: ArtifactRef | string;
    snapshot?: string;
    diagnostics?: { console: unknown[]; failures: unknown[] };
  };
  metadata: {
    timestamps: {
      start: number;
      end: number;
      perComponent: Record<string, { start: number; end: number }>;
    };
    driftMs: number;
    sequence: number[];
  };
}

export interface BrowserWaitParams {
  condition: 'selector' | 'ref' | 'document_loaded' | 'url_match' | 'network_idle' | 'dom_stable';
  selector?: string;
  ref?: string;
  urlPattern?: string;
  state?: 'attached' | 'visible' | 'actionable' | 'detached' | 'hidden';
  timeoutMs?: number;
  idleWindowMs?: number;
  tabId?: string;
  paneId?: 'desktop' | 'mobile';
}

export interface BrowserWaitResult {
  satisfied: boolean;
  condition: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export interface BrowserArtifactSink {
  stage(input: { kind: ArtifactRef['kind']; mime: string; data: string | Buffer; runId: string; attemptId: string; projectId: string; workspaceId: string; maxBytes?: number }): Promise<ArtifactRef> | ArtifactRef;
  readBytesById?(artifactId: string, context?: { runId?: string; attemptId?: string; projectId?: string; workspaceId?: string }): { ref: ArtifactRef; data: Buffer };
}

export interface ViewportLockOptions {
  tabId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class PassiveExecutionPool {
  private tabActiveCounts = new Map<string, number>();
  private globalActiveCount = 0;
  private readonly MAX_PER_TAB = 4;
  private readonly MAX_GLOBAL = 16;

  async execute<T>(tabId: string, action: () => Promise<T>): Promise<T> {
    const tabCount = this.tabActiveCounts.get(tabId) || 0;
    if (tabCount >= this.MAX_PER_TAB || this.globalActiveCount >= this.MAX_GLOBAL) {
      throw new CapabilityError('CAPABILITY_OVERLOADED', `Concurrency limit exceeded for background operations on tab ${tabId}`);
    }

    this.tabActiveCounts.set(tabId, tabCount + 1);
    this.globalActiveCount++;
    try {
      return await action();
    } finally {
      const updated = (this.tabActiveCounts.get(tabId) || 1) - 1;
      if (updated <= 0) this.tabActiveCounts.delete(tabId);
      else this.tabActiveCounts.set(tabId, updated);
      this.globalActiveCount = Math.max(0, this.globalActiveCount - 1);
    }
  }

  getActiveTabCount(tabId: string): number {
    return this.tabActiveCounts.get(tabId) || 0;
  }

  getGlobalActiveCount(): number {
    return this.globalActiveCount;
  }

  clear(): void {
    this.tabActiveCounts.clear();
    this.globalActiveCount = 0;
  }
}
export class WaitRegistry {
  private tabWaitCounts = new Map<string, number>();
  private globalWaitCount = 0;
  private readonly MAX_PER_TAB = 4;
  private readonly MAX_GLOBAL = 16;
  private readonly DEFAULT_TIMEOUT_MS = 5_000;
  private readonly MAX_TIMEOUT_MS = 30_000;

  async execute<T>(
    tabId: string,
    action: (signal: AbortSignal) => Promise<T>,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<T> {
    const tabCount = this.tabWaitCounts.get(tabId) || 0;
    if (tabCount >= this.MAX_PER_TAB || this.globalWaitCount >= this.MAX_GLOBAL) {
      throw new CapabilityError('CAPABILITY_OVERLOADED', `Wait registry concurrency limit exceeded on tab ${tabId}`);
    }

    this.tabWaitCounts.set(tabId, tabCount + 1);
    this.globalWaitCount++;

    const timeoutMs = Math.min(this.MAX_TIMEOUT_MS, Math.max(100, options?.timeoutMs ?? this.DEFAULT_TIMEOUT_MS));
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let onParentAbort: (() => void) | null = null;

    try {
      if (options?.signal?.aborted) {
        throw (options.signal.reason || new CapabilityError('WAIT_ABORTED', 'Wait was aborted before starting'));
      }
      onParentAbort = () => controller.abort(options?.signal?.reason);
      if (options?.signal) {
        options.signal.addEventListener('abort', onParentAbort, { once: true });
      }

      timer = setTimeout(() => {
        controller.abort(new CapabilityError('LEASE_EXPIRED', `Wait execution exceeded ${timeoutMs}ms deadline`));
      }, timeoutMs);

      return await action(controller.signal);
    } finally {
      if (timer) clearTimeout(timer);
      if (options?.signal && onParentAbort) {
        options.signal.removeEventListener('abort', onParentAbort);
      }
      const updated = (this.tabWaitCounts.get(tabId) || 1) - 1;
      if (updated <= 0) this.tabWaitCounts.delete(tabId);
      else this.tabWaitCounts.set(tabId, updated);
      this.globalWaitCount = Math.max(0, this.globalWaitCount - 1);
    }
  }

  getActiveTabCount(tabId: string): number {
    return this.tabWaitCounts.get(tabId) || 0;
  }

  getGlobalActiveCount(): number {
    return this.globalWaitCount;
  }

  clear(): void {
    this.tabWaitCounts.clear();
    this.globalWaitCount = 0;
  }
}

export class ViewportGate {
  private isLocked = false;
  private isPoisoned = false;
  private preemptionEpoch = 1;
  private activeAbortController: AbortController | null = null;
  private activeTabId: string | null = null;
  private onCancelCallback: ((tabId?: string) => Promise<boolean>) | null = null;
  private queue: Array<{
    tabId?: string;
    epoch: number;
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  public setCancellationHandler(callback: (tabId?: string) => Promise<boolean>): void {
    this.onCancelCallback = callback;
  }

  public resetPoisonState(): void {
    this.isPoisoned = false;
  }

  public poison(reason: string): void {
    this.isPoisoned = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      clearTimeout(entry.timer);
      entry.reject(new CapabilityError('TARGET_STALE', reason));
    }
  }

  public preemptActiveAgent(reason = 'Physical human user input preempted agent action', tabId?: string): void {
    this.preemptionEpoch++;
    if (this.activeAbortController) {
      if (tabId && this.activeTabId && tabId !== this.activeTabId) {
        return; // User input on a different tab does not preempt this tab's active agent
      }
      this.activeAbortController.abort(new CapabilityError('PREEMPTED_BY_USER', reason));
    }
  }
  async withLock<T>(
    action: (signal: AbortSignal) => Promise<T>,
    options: ViewportLockOptions = {}
  ): Promise<T> {
    if (this.isPoisoned) {
      throw new CapabilityError('TARGET_STALE', 'ViewportGate is poisoned due to unacknowledged action cancellation');
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    const controller = new AbortController();

    if (options.signal?.aborted) {
      controller.abort(options.signal.reason);
    }

    const onParentAbort = () => controller.abort(options.signal?.reason);
    if (options.signal && !options.signal.aborted) {
      options.signal.addEventListener('abort', onParentAbort, { once: true });
    }

    // 1. Acquire Lock (Queued FIFO)
    const release = await this.acquire(options.tabId, timeoutMs, controller.signal);

    // 2. Recheck poison immediately after acquisition before executing action
    if (this.isPoisoned) {
      release();
      throw new CapabilityError('TARGET_STALE', 'ViewportGate is poisoned due to unacknowledged action cancellation');
    }

    // 3. Assign activeAbortController and activeTabId ONLY AFTER lock is acquired!
    this.activeAbortController = controller;
    this.activeTabId = options.tabId ?? null;

    let executionTimer: NodeJS.Timeout | null = null;
    let cancelHandled = false;
    let actionPromise: Promise<T> | null = null;
    const cancelExecutionHolder: { promise: Promise<unknown> | null } = { promise: null };

    const cancelPromise = new Promise<never>((_, reject) => {
      const triggerCancel = async (err: Error) => {
        if (cancelHandled) return;
        cancelHandled = true;
        let ack = true;
        if (this.onCancelCallback && this.activeTabId) {
          try {
            ack = await this.onCancelCallback(this.activeTabId);
          } catch {
            ack = false;
          }
        }
        if (!ack) {
          this.poison('ViewportGate poisoned due to unacknowledged action cancellation');
          reject(err);
          return;
        }
        if (actionPromise) {
          let settled = false;
          const waitAction = actionPromise.then(() => { settled = true; }, () => { settled = true; });
          await Promise.race([
            waitAction,
            new Promise((r) => setTimeout(r, 500))
          ]);
          if (!settled) {
            this.poison('ViewportGate poisoned: action failed to settle after cancellation acknowledgement');
          }
        }
        reject(err);
      };

      const startCancel = (err: Error) => {
        cancelExecutionHolder.promise = triggerCancel(err);
      };

      if (controller.signal.aborted) {
        startCancel(controller.signal.reason || new CapabilityError('PREEMPTED_BY_USER', 'Preempted by user'));
      } else {
        controller.signal.addEventListener('abort', () => {
          startCancel(controller.signal.reason || new CapabilityError('PREEMPTED_BY_USER', 'Preempted by user'));
        }, { once: true });
      }

      executionTimer = setTimeout(() => {
        controller.abort(new CapabilityError('LEASE_EXPIRED', `Viewport action execution exceeded ${timeoutMs}ms deadline`));
      }, timeoutMs);
    });

    try {
      actionPromise = action(controller.signal);
      const result = await Promise.race([
        actionPromise,
        cancelPromise
      ]);
      if (controller.signal.aborted) {
        throw (controller.signal.reason || new CapabilityError('PREEMPTED_BY_USER', 'Preempted by user'));
      }
      return result;
    } finally {
      if (cancelExecutionHolder.promise) {
        await cancelExecutionHolder.promise.catch(() => {});
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onParentAbort);
      }
      if (executionTimer) clearTimeout(executionTimer);
      this.activeAbortController = null;
      this.activeTabId = null;
      release();
    }
  }

  private acquire(tabId: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new CapabilityError('TARGET_STALE', 'Viewport action aborted before lock acquisition'));
    }

    if (!this.isLocked) {
      this.isLocked = true;
      let releaseCalled = false;
      const safeRelease = () => {
        if (releaseCalled) return;
        releaseCalled = true;
        this.releaseNext();
      };
      return Promise.resolve(safeRelease);
    }

    return new Promise<() => void>((resolve, reject) => {
      let timer: NodeJS.Timeout;

      const onAbort = () => {
        clearTimeout(timer);
        this.removeFromQueue(entry);
        reject(new CapabilityError('TARGET_STALE', 'Viewport lock acquisition aborted'));
      };

      const onTimeout = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        this.removeFromQueue(entry);
        reject(new CapabilityError('LEASE_EXPIRED', `Viewport lock acquisition timeout after ${timeoutMs}ms`));
      };

      timer = setTimeout(onTimeout, timeoutMs);

      const entry = {
        tabId,
        epoch: this.preemptionEpoch,
        resolve: (releaseFn: () => void) => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(releaseFn);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        },
        timer
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private releaseNext(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      let releaseCalled = false;
      const safeRelease = () => {
        if (releaseCalled) return;
        releaseCalled = true;
        this.releaseNext();
      };
      next.resolve(safeRelease);
    } else {
      this.isLocked = false;
    }
  }


  private removeFromQueue(entry: typeof this.queue[number]): void {
    const index = this.queue.indexOf(entry);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  public cleanupTab(tabId: string): void {
    if (this.activeTabId === tabId && this.activeAbortController) {
      this.activeAbortController.abort(new CapabilityError('TARGET_STALE', `Target tab '${tabId}' was closed during active viewport lock`));
    }
    const toCancel = this.queue.filter(item => item.tabId === tabId);
    for (const entry of toCancel) {
      this.removeFromQueue(entry);
      entry.reject(new CapabilityError('TARGET_STALE', `Target tab '${tabId}' was closed while awaiting viewport lock`));
    }
  }

  public isBusy(): boolean {
    return this.isLocked || this.queue.length > 0;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}

export class BrowserControlPort {
  public readonly passivePool = new PassiveExecutionPool();
  public readonly waitRegistry = new WaitRegistry();
  public readonly viewportGate = new ViewportGate();
  constructor(private readonly host: BrowserHostPort, public readonly artifacts?: BrowserArtifactSink) {
    this.viewportGate.setCancellationHandler(async (tabId) => {
      if (this.host.agentClear) {
        try {
          return await this.host.agentClear(tabId);
        } catch {
          return false;
        }
      }
      return true;
    });
  }
  listTabs(context: { target?: BrowserTarget }): unknown[] {
    if (context.target) assertTarget(context.target);
    const list = this.host.getTabList() || [];
    const boundTabId = context.target?.tabId;
    if (boundTabId) {
      const boundTab = list.find((tab: any) => tab && typeof tab === 'object' && tab.id === boundTabId);
      if (boundTab) {
        return [{
          ...boundTab,
          isBoundTab: true,
        }];
      }
      return [];
    }
    return list;
  }

  async navigate(target: BrowserTarget, url: string, explicitTabId?: string): Promise<{ navigated: boolean; target: BrowserTarget }> {
    const tabId = this.resolveTargetTab(target, explicitTabId, 'lifecycle');
    if (!url || !/^https?:\/\//i.test(url)) throw new CapabilityError('INVALID_ARGUMENT', 'Navigation requires an http(s) URL');
    const navigated = await this.host.navigate(tabId, url);
    if (!navigated) throw new CapabilityError('TARGET_STALE', 'Navigation failed or timed out before starting');
    const docGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : (target.documentGeneration || 1);
    return { navigated: true, target: { ...target, tabId, documentGeneration: docGen } };
  }

  async reload(target: BrowserTarget, explicitTabId?: string): Promise<{ reloaded: boolean; target: BrowserTarget }> {
    const tabId = this.resolveTargetTab(target, explicitTabId, 'lifecycle');
    const reloaded = await this.host.reload(tabId);
    if (!reloaded) throw new CapabilityError('TARGET_STALE', 'Reload failed or timed out before a load-complete document was available');
    const docGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : (target.documentGeneration || 1);
    return { reloaded: true, target: { ...target, tabId, documentGeneration: docGen } };
  }

  async dom(target: BrowserTarget, runId: string, attemptId: string, selector?: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile'): Promise<ArtifactRef | string> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    return this.passivePool.execute(tabId, async () => {
      const html = await this.host.getDom(selector, tabId, paneId);
      return this.artifacts ? await this.artifacts.stage({ kind: 'dom', mime: 'text/html', data: html, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 }) : limit(html, 8 * 1024 * 1024);
    });
  }
  async dumpDom(
    target: BrowserTarget,
    outputPath: string,
    options?: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; clean?: boolean; stripLivewire?: boolean }
  ): Promise<{ path: string; byteCount: number; nodeCount: number; tabId: string }> {
    const tabId = this.resolveTargetTab(target, options?.tabId);
    return this.passivePool.execute(tabId, async () => {
      const shouldClean = options?.clean !== false || options?.stripLivewire === true;
      let rawResult: unknown;
      if (shouldClean) {
        const script = buildTreeWalkerSanitizerScript({
          selector: options?.selector,
          stripLivewire: options?.stripLivewire !== false,
        });
        rawResult = await this.host.evalJs(script, tabId, options?.paneId);
      } else {
        rawResult = await this.host.getDom(options?.selector, tabId, options?.paneId);
      }

      if (rawResult && typeof rawResult === 'object' && '__error' in rawResult) {
        const errorObj = rawResult;
        const errMsg = 'message' in errorObj && typeof errorObj.message === 'string' ? errorObj.message : 'Evaluation error';
        throw new CapabilityError(
          'INVALID_ARGUMENT',
          `DOM dump script execution failed: ${errMsg}`
        );
      }
      const html = typeof rawResult === 'string' ? rawResult : '';
      const absolutePath = path.isAbsolute(outputPath)
        ? outputPath
        : path.resolve(outputPath);

      const targetDir = path.dirname(absolutePath);
      await fs.mkdir(targetDir, { recursive: true });

      const tempPath = path.join(targetDir, `.antifan-${crypto.randomUUID()}.tmp`);
      const buffer = Buffer.from(html, 'utf8');
      await fs.writeFile(tempPath, buffer);

      try {
        let renamed = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await fs.rename(tempPath, absolutePath);
            renamed = true;
            break;
          } catch (err: unknown) {
            const isLocked = err && typeof err === 'object' && 'code' in err && (err.code === 'EPERM' || err.code === 'EBUSY');
            if (attempt === 2 || !isLocked) {
              break;
            }
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          }
        }

        if (!renamed) {
          await fs.writeFile(absolutePath, buffer);
        }
      } finally {
        await fs.unlink(tempPath).catch(() => {});
      }

      const nodeCount = (html.match(/<[a-zA-Z0-9-]+/g) || []).length;
      return {
        path: outputPath,
        byteCount: buffer.length,
        nodeCount,
        tabId,
      };
    });
  }

  async screenshot(target: BrowserTarget, runId: string, attemptId: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile', options?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<ArtifactRef | string> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    return this.passivePool.execute(tabId, async () => {
      const format = options?.format === 'jpeg' ? 'jpeg' : 'png';
      const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const base64 = await this.host.captureScreenshot(undefined, tabId, paneId, options);
      const buffer = Buffer.from(base64, 'base64');
      return this.artifacts ? await this.artifacts.stage({ kind: 'screenshot', mime, data: buffer, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 }) : limit(base64, 8 * 1024 * 1024);
    });
  }
  async eval(target: BrowserTarget, expression: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile'): Promise<unknown> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    if (!expression.trim()) throw new CapabilityError('INVALID_ARGUMENT', 'JavaScript expression is required');
    return this.passivePool.execute(tabId, async () => {
      return this.host.evalJs(expression, tabId, paneId);
    });
  }

  async observe(
    target: BrowserTarget,
    runId: string,
    attemptId: string,
    params: BrowserObserveParams = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<BrowserObserveResult> {
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';

    const requested = params.components && params.components.length > 0
      ? params.components
      : ['snapshot'];

    if (requested.length > 4) {
      throw new CapabilityError('INVALID_ARGUMENT', 'At most 4 observation components can be requested');
    }

    return this.passivePool.execute(tabId, async () => {
      const initialDocGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : (target.documentGeneration || 1);
      const initialEpoch = target.browserEpoch;
      const startAll = Date.now();
      const perComponent: Record<string, { start: number; end: number }> = {};
      const sequence: number[] = [];
      const resultComponents: BrowserObserveResult['components'] = {};

      for (let i = 0; i < requested.length; i++) {
        const comp = requested[i]!;
        sequence.push(i + 1);
        const compStart = Date.now();

        if (comp === 'dom') {
          const html = await this.host.getDom(params.selector, tabId, effectivePane);
          resultComponents.dom = this.artifacts
            ? await this.artifacts.stage({ kind: 'dom', mime: 'text/html', data: html, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 })
            : limit(html, 512 * 1024);
        } else if (comp === 'screenshot') {
          const base64 = await this.host.captureScreenshot(undefined, tabId, effectivePane);
          const buffer = Buffer.from(base64, 'base64');
          resultComponents.screenshot = this.artifacts
            ? await this.artifacts.stage({ kind: 'screenshot', mime: 'image/png', data: buffer, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 })
            : limit(base64, 512 * 1024);
        } else if (comp === 'snapshot') {
          const snapshotText = this.host.agentSnapshot ? await this.host.agentSnapshot(tabId, effectivePane) : '';
          resultComponents.snapshot = limit(snapshotText, 128 * 1024);
        } else if (comp === 'diagnostics') {
          resultComponents.diagnostics = this.host.getDiagnostics ? this.host.getDiagnostics(tabId) : { console: [], failures: [] };
        }

        const compEnd = Date.now();
        perComponent[comp] = { start: compStart, end: compEnd };

        // Revalidate document generation across components
        const currentDocGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : initialDocGen;
        if (currentDocGen !== initialDocGen) {
          throw new CapabilityError('TARGET_STALE', 'Document navigated or reloaded during observation; observation crossed document identity');
        }
      }

      const endAll = Date.now();
      return {
        target: {
          tabId,
          paneId: effectivePane,
          browserEpoch: initialEpoch,
          documentGeneration: initialDocGen,
        },
        components: resultComponents,
        metadata: {
          timestamps: { start: startAll, end: endAll, perComponent },
          driftMs: endAll - startAll,
          sequence,
        },
      };
    });
  }

  async wait(
    target: BrowserTarget,
    params: BrowserWaitParams,
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile',
    signal?: AbortSignal
  ): Promise<BrowserWaitResult> {
    if (!params || !params.condition) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Wait condition is required');
    }
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';

    return this.waitRegistry.execute(tabId, async (waitSignal) => {
      if (waitSignal.aborted) {
        throw (waitSignal.reason || new CapabilityError('WAIT_ABORTED', 'Wait was aborted'));
      }
      const startTime = Date.now();

      if (params.condition === 'network_idle') {
        if (this.host.getNetworkTracker) {
          const tracker = this.host.getNetworkTracker();
          if (tracker && typeof tracker.isAttached === 'function' && !tracker.isAttached(tabId, effectivePane)) {
            throw new CapabilityError('TARGET_STALE', `FirstPartyNetworkTracker is not attached for target "${tabId}:${effectivePane}"`);
          }
          if (tracker && typeof tracker.awaitQuiescence === 'function') {
            const res = await tracker.awaitQuiescence(
              tabId,
              effectivePane,
              { idleWindowMs: params.idleWindowMs ?? 500, maxCeilingMs: params.timeoutMs ?? 5000, requireAttached: true },
              waitSignal
            );
            return {
              satisfied: res.settled && !res.timedOut,
              condition: 'network_idle',
              durationMs: res.durationMs,
              details: { timedOut: res.timedOut },
            };
          }
        }
      }
      if (this.host.wait) {
        return await this.host.wait({ ...params, tabId, paneId: effectivePane }, waitSignal);
      }

      if (params.condition === 'document_loaded') {
        const docGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : (target.documentGeneration || 1);
        return {
          satisfied: true,
          condition: 'document_loaded',
          durationMs: Date.now() - startTime,
          details: { documentGeneration: docGen },
        };
      }

      if (params.condition === 'selector' && params.selector) {
        const sel = params.selector;
        const dom = await this.host.getDom(sel, tabId, effectivePane);
        return {
          satisfied: Boolean(dom && dom.length > 0),
          condition: 'selector',
          durationMs: Date.now() - startTime,
          details: { selector: sel },
        };
      }

      return {
        satisfied: true,
        condition: params.condition,
        durationMs: Date.now() - startTime,
      };
    }, { timeoutMs: params.timeoutMs, signal });
  }
  openTab(options: { url?: string; activate?: boolean; ephemeral?: boolean } = {}): { tabId: string } {
    if (!this.host.createTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'createTab is not supported by host');
    const tabId = this.host.createTab(options.url || 'about:blank', options.activate ?? false, { ephemeral: options.ephemeral });
    return { tabId };
  }

  setAutomationTarget(tabId: string): { success: boolean; tabId: string } {
    const cleanId = tabId && typeof tabId === 'string' ? tabId.trim() : '';
    if (!cleanId) throw new CapabilityError('INVALID_ARGUMENT', 'tabId is required');
    if (!this.host.setAutomationTabId || !this.host.getTabList) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'setAutomationTabId is not supported by host');
    }
    const tabs = this.host.getTabList() || [];
    const exists = tabs.some(t => Boolean(t && typeof t === 'object' && 'id' in t && (t as { id: unknown }).id === cleanId));
    if (!exists) {
      throw new CapabilityError('INVALID_ARGUMENT', `Tab with id '${cleanId}' not found`);
    }
    this.host.setAutomationTabId(cleanId);
    return { success: true, tabId: cleanId };
  }
  closeTab(tabId: string, context?: { target?: BrowserTarget }): { closed: boolean } {
    if (!this.host.closeTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'closeTab is not supported by host');
    const boundId = context?.target?.tabId;
    if (boundId && tabId.trim() !== boundId.trim()) {
      throw new CapabilityError('TARGET_MISMATCH', `Cannot close tab "${tabId}". This session is isolated to tab "${boundId}".`);
    }
    return { closed: this.host.closeTab(tabId) };
  }

  switchTab(tabId: string, context?: { target?: BrowserTarget }): { switched: boolean } {
    if (!this.host.switchTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'switchTab is not supported by host');
    const boundId = context?.target?.tabId;
    if (boundId && tabId.trim() !== boundId.trim()) {
      throw new CapabilityError('TARGET_MISMATCH', `Cannot activate tab "${tabId}". This session is isolated to tab "${boundId}".`);
    }
    return { switched: this.host.switchTab(tabId) };
  }

  diagnostics(tabId?: string, level?: number | string): { console: unknown[]; failures: unknown[] } {
    if (!this.host.getDiagnostics) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'getDiagnostics is not supported by host');
    return this.host.getDiagnostics(tabId, level);
  }

  async responsiveCheck(tabId: string): Promise<Record<string, unknown>> {
    if (!this.host.runResponsiveCheck) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'runResponsiveCheck is not supported by host');
    return this.host.runResponsiveCheck(tabId);
  }

  async agentTrajectory(args: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<Record<string, unknown>> {
    if (!this.host.agentTrajectory) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentTrajectory is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return (await this.host.agentTrajectory!({ ...args, tabId })) as Record<string, unknown>;
    }, { tabId });
  }

  async agentMove(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ moved: boolean }> {
    if (!this.host.agentMove) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentMove is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return { moved: await this.host.agentMove!({ ...args, tabId }) };
    }, { tabId });
  }

  async agentClick(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ clicked: boolean }> {
    if (!this.host.agentClick) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentClick is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return { clicked: await this.host.agentClick!({ ...args, tabId }) };
    }, { tabId });
  }

  async agentType(args: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ typed: boolean }> {
    if (!this.host.agentType) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentType is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return { typed: await this.host.agentType!({ ...args, tabId }) };
    }, { tabId });
  }
  async keyboardPress(args: { key: string; modifiers?: string[]; tabId?: string }, target?: BrowserTarget): Promise<{ success: boolean; key: string; modifiers: string[] }> {
    if (!this.host.sendKeyboardPress) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'sendKeyboardPress is not supported by host');
    if (!args || typeof args.key !== 'string' || args.key.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'key must be a non-empty string');
    }
    const effectiveTabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, effectiveTabId);
      try {
        return await this.host.sendKeyboardPress!({ ...args, tabId: effectiveTabId });
      } catch (err: unknown) {
        if (err instanceof CapabilityError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Tab not found')) {
          throw new CapabilityError('CAPABILITY_NOT_FOUND', msg);
        }
        throw new CapabilityError('INVALID_ARGUMENT', msg);
      }
    }, { tabId: effectiveTabId });
  }
  async agentScroll(args: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ scrolled: boolean }> {
    if (!this.host.agentScroll) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentScroll is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return { scrolled: await this.host.agentScroll!({ ...args, tabId }) };
    }, { tabId });
  }

  async agentHover(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ hovered: boolean }> {
    if (!this.host.agentHover) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentHover is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return { hovered: await this.host.agentHover!({ ...args, tabId }) };
    }, { tabId });
  }

  async agentHighlight(args: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ highlighted: boolean }> {
    if (!this.host.agentHighlight) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentHighlight is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return { highlighted: await this.host.agentHighlight!({ ...args, tabId }) };
    }, { tabId });
  }
  async agentClear(options?: { tabId?: string; paneId?: 'desktop' | 'mobile' } | string, target?: BrowserTarget): Promise<{ cleared: boolean }> {
    if (!this.host.agentClear) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentClear is not supported by host');
    const tabId = typeof options === 'string' ? options : options?.tabId;
    const paneId = typeof options === 'object' ? options?.paneId : undefined;
    const effectiveTabId = this.resolveTargetTab(target, tabId);
    return { cleared: await this.host.agentClear(effectiveTabId, paneId) };
  }

  async agentSnapshot(options?: { tabId?: string; paneId?: 'desktop' | 'mobile'; selector?: string; viewportOnly?: boolean } | string, target?: BrowserTarget): Promise<{ snapshot: string }> {
    if (!this.host.agentSnapshot) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentSnapshot is not supported by host');
    const tabId = typeof options === 'string' ? options : options?.tabId;
    const paneId = typeof options === 'object' ? options?.paneId : undefined;
    const selector = typeof options === 'object' ? options?.selector : undefined;
    const viewportOnly = typeof options === 'object' ? options?.viewportOnly : undefined;
    const effectiveTabId = this.resolveTargetTab(target, tabId);
    return { snapshot: await this.host.agentSnapshot(effectiveTabId, paneId, selector, viewportOnly) };
  }
  async agentFind(params: { text?: string; regex?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; maxMatches?: number }, target?: BrowserTarget): Promise<unknown> {
    if (!this.host.agentFind) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentFind is not supported by host');
    const effectiveTabId = this.resolveTargetTab(target, params.tabId);
    return await this.host.agentFind({ ...params, tabId: effectiveTabId });
  }
  async sequence(args: { actions: Array<Record<string, unknown>>; tabId?: string; paneId?: 'desktop' | 'mobile'; stopOnError?: boolean }, target?: BrowserTarget): Promise<unknown> {
    if (!this.host.executeActionSequence) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'executeActionSequence is not supported by host');
    if (!args || !Array.isArray(args.actions) || args.actions.length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'actions must be a non-empty array');
    }
    const effectiveTabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, effectiveTabId);
      return await this.host.executeActionSequence!({ ...args, tabId: effectiveTabId });
    }, { tabId: effectiveTabId });
  }


  async uploadFileInput(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ success: boolean; uploadedCount: number; reason?: string }> {
    if (!this.host.uploadFileInput) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'uploadFileInput is not supported by host');
    const effectiveTabId = this.resolveTargetTab(target, params.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, effectiveTabId);
      return this.host.uploadFileInput!({ ...params, tabId: effectiveTabId });
    }, { tabId: effectiveTabId });
  }

  async dropFiles(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ success: boolean; droppedCount: number; reason?: string }> {
    if (!this.host.dropFiles) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'dropFiles is not supported by host');
    const effectiveTabId = this.resolveTargetTab(target, params.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, effectiveTabId);
      return this.host.dropFiles!({ ...params, tabId: effectiveTabId });
    }, { tabId: effectiveTabId });
  }

  private revalidateTargetInsideLock(target?: BrowserTarget, tabId?: string): void {
    if (!target) return;
    if (tabId && this.host.getTabList) {
      const tabs = this.host.getTabList() || [];
      const exists = tabs.some((t: any) => t && typeof t === 'object' && t.id === tabId);
      if (!exists) {
        throw new CapabilityError('TARGET_STALE', `Target tab '${tabId}' no longer exists`);
      }
    }
    const liveDocGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : target.documentGeneration;
    if (typeof target.documentGeneration === 'number' && typeof liveDocGen === 'number' && target.documentGeneration !== liveDocGen) {
      throw new CapabilityError(
        'TARGET_STALE',
        `Browser target document generation (${target.documentGeneration}) is stale compared to live document generation (${liveDocGen}) after acquiring viewport lock`
      );
    }
    if (this.host.isCurrentTarget && !this.host.isCurrentTarget(target)) {
      throw new CapabilityError('TARGET_STALE', 'Browser target no longer matches current tab document after acquiring viewport lock');
    }
  }
  setViewport(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string }, target?: BrowserTarget): { success: boolean; width: number; height: number; mobile?: boolean; presetId: string } {
    if (!this.host.setViewportSize) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'setViewportSize is not supported by host');
    if (typeof options.width !== 'number' || options.width <= 0 || typeof options.height !== 'number' || options.height <= 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'width and height must be positive numbers');
    }
    const effectiveTabId = this.resolveTargetTab(target, options.tabId);
    const ok = this.host.setViewportSize({ ...options, tabId: effectiveTabId });
    if (!ok) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Failed to set viewport on tab ${effectiveTabId}`);
    return {
      success: ok,
      width: options.width,
      height: options.height,
      mobile: options.mobile ?? (options.width < 600),
      presetId: `custom-${options.width}x${options.height}`,
    };
  }

  setDevicePreset(options: { presetId: string; tabId?: string }, target?: BrowserTarget): { success: boolean; presetId: string } {
    if (!this.host.setDevicePreset) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'setDevicePreset is not supported by host');
    if (!options.presetId || typeof options.presetId !== 'string') {
      throw new CapabilityError('INVALID_ARGUMENT', 'presetId is required and must be a string');
    }
    const effectiveTabId = this.resolveTargetTab(target, options.tabId);
    const ok = this.host.setDevicePreset(effectiveTabId, options.presetId);
    if (!ok) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Failed to set device preset ${options.presetId} on tab ${effectiveTabId}`);
    return { success: ok, presetId: options.presetId };
  }

  listDevicePresets(): unknown[] {
    if (!this.host.getDevicePresets) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'getDevicePresets is not supported by host');
    return this.host.getDevicePresets();
  }

  setZoom(options: { zoomFactor: number; tabId?: string }, target?: BrowserTarget): { success: boolean; zoomFactor: number } {
    if (!this.host.setZoom) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'setZoom is not supported by host');
    if (typeof options.zoomFactor !== 'number' || !Number.isFinite(options.zoomFactor) || options.zoomFactor < 0.25 || options.zoomFactor > 5.0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'zoomFactor must be a number between 0.25 and 5.0');
    }
    const effectiveTabId = this.resolveTargetTab(target, options.tabId);
    const ok = this.host.setZoom(effectiveTabId, options.zoomFactor);
    if (!ok) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Failed to set zoom on tab ${effectiveTabId}`);
    return { success: ok, zoomFactor: options.zoomFactor };
  }

  toggleInspect(): { inspecting: boolean } {
    if (!this.host.toggleInspect) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'toggleInspect is not supported by host');
    return { inspecting: this.host.toggleInspect() };
  }
  clearAllAgentWorking(): { cleared: boolean } {
    if (this.host.clearAllAgentWorking) this.host.clearAllAgentWorking();
    return { cleared: true };
  }
  async inspectStyles(
    target: BrowserTarget,
    params: { selector?: string; ref?: string; properties?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' } = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<Record<string, unknown>> {
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';

    if (!this.host.inspectStyles) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'inspectStyles is not supported by host');
    }

    return this.passivePool.execute(tabId, async () => {
      return this.host.inspectStyles!({ ...params, tabId, paneId: effectivePane });
    });
  }

  async inspectRegion(
    target: BrowserTarget,
    params: { x?: number; y?: number; width?: number; height?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' } = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<Record<string, unknown>> {
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';

    if (!this.host.inspectRegion) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'inspectRegion is not supported by host');
    }

    return this.passivePool.execute(tabId, async () => {
      return this.host.inspectRegion!({ ...params, tabId, paneId: effectivePane });
    });
  }

  async traceInteraction(
    target: BrowserTarget,
    runId: string,
    attemptId: string,
    params: {
      action: 'click' | 'hover' | 'focus' | 'type' | 'scroll';
      selector?: string;
      ref?: string;
      text?: string;
      deltaY?: number;
      settleMs?: number;
      tabId?: string;
      paneId?: 'desktop' | 'mobile';
    },
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile',
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (!params || !params.action) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Trace interaction action is required');
    }
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId, 'write');
    const effectivePane = paneId || params.paneId || 'desktop';

    return this.viewportGate.withLock(async (lockSignal) => {
      if (lockSignal.aborted) {
        throw (lockSignal.reason || new CapabilityError('WAIT_ABORTED', 'Trace interaction was aborted'));
      }
      this.revalidateTargetInsideLock(target, tabId);

      const startTime = Date.now();
      let beforeStyles: Record<string, unknown> = {};
      try {
        beforeStyles = await this.inspectStyles(target, { selector: params.selector, ref: params.ref, tabId, paneId: effectivePane });
      } catch {}

      // Capture Dual-Scope Before State
      const beforeState = await this.captureBehaviorScope(tabId, effectivePane, params.selector, params.ref);

      // Execute Action
      if (params.action === 'click') {
        if (this.host.agentClick) {
          await this.host.agentClick({ selector: params.selector, ref: params.ref, trusted: true, tabId, paneId: effectivePane });
        } else {
          const sel = params.ref ? `[data-antifan-ref="${params.ref}"]` : (params.selector || 'body');
          await this.host.evalJs(`document.querySelector(${JSON.stringify(sel)})?.click()`, tabId, effectivePane);
        }
      } else if (params.action === 'hover') {
        if (this.host.agentHover) {
          await this.host.agentHover({ selector: params.selector, ref: params.ref, tabId, paneId: effectivePane });
        }
      } else if (params.action === 'focus') {
        const sel = params.ref ? `[data-antifan-ref="${params.ref}"]` : (params.selector || 'body');
        try {
          await this.host.evalJs(`document.querySelector(${JSON.stringify(sel)})?.focus()`, tabId, effectivePane);
        } catch {}
      } else if (params.action === 'type') {
        if (this.host.agentType) {
          await this.host.agentType({ selector: params.selector, ref: params.ref, text: params.text || '', trusted: true, tabId, paneId: effectivePane });
        }
      } else if (params.action === 'scroll') {
        if (this.host.agentScroll) {
          await this.host.agentScroll({ selector: params.selector, ref: params.ref, deltaY: params.deltaY || 300, tabId, paneId: effectivePane });
        }
      }

      const settleWait = Math.min(Math.max(params.settleMs || 100, 20), 2000);
      const { promise: settlePromise, resolve: settleResolve } = Promise.withResolvers<void>();
      setTimeout(settleResolve, settleWait);
      await settlePromise;
      let afterStyles: Record<string, unknown> = {};
      try {
        afterStyles = await this.inspectStyles(target, { selector: params.selector, ref: params.ref, tabId, paneId: effectivePane });
      } catch {}

      // Capture Dual-Scope After State
      const afterState = await this.captureBehaviorScope(tabId, effectivePane, params.selector, params.ref);

      const durationMs = Date.now() - startTime;

      // Synthesize Semantic Verdict and Evidence Delta
      const evaluation = this.evaluateBehaviorEvidence(beforeState, afterState, beforeStyles, afterStyles);

      return {
        action: params.action,
        target: { selector: params.selector, ref: params.ref },
        durationMs,
        settled: true,
        verified: evaluation.verified,
        verdict: evaluation.verdict,
        confidence: evaluation.confidence,
        evidence: evaluation.evidence,
        beforeStyles,
        afterStyles,
      };
    }, { tabId, timeoutMs: 15_000, signal });
  }

  private async captureBehaviorScope(
    tabId: string,
    effectivePane: 'desktop' | 'mobile',
    selector?: string,
    ref?: string
  ): Promise<any | null> {
    const script = `(() => {
      try {
        const sel = ${JSON.stringify(selector || '')};
        const ref = ${JSON.stringify(ref || '')};
        let el = null;
        if (ref) {
          el = document.querySelector('[data-antifan-ref="' + ref + '"]');
        }
        if (!el && sel) {
          el = document.querySelector(sel);
        }
        let targetInfo = undefined;
        if (el) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          targetInfo = {
            found: true,
            tagName: el.tagName ? el.tagName.toLowerCase() : '',
            classes: Array.from(el.classList || []),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            ariaExpanded: el.getAttribute('aria-expanded'),
            ariaHidden: el.getAttribute('aria-hidden'),
            ariaSelected: el.getAttribute('aria-selected'),
            ariaModal: el.getAttribute('aria-modal'),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            transform: style.transform,
          };
        }

        const bodyStyle = window.getComputedStyle(document.body);
        const bodyOverflowY = bodyStyle.overflowY || '';
        const bodyOverflowX = bodyStyle.overflowX || '';
        const bodyLocked = bodyOverflowY === 'hidden' || bodyOverflowY === 'clip' || bodyStyle.position === 'fixed';

        const overlayCandidates = Array.from(document.querySelectorAll(
          '[role="dialog"], [role="menu"], [aria-modal="true"], dialog[open], .modal.show, .modal.active, .modal.is-open, .drawer.open, .drawer.active, .drawer.is-open, [data-overlay="open"], .submenu.open, .submenu.active'
        ));
        const activeOverlays = overlayCandidates.filter(node => {
          const s = window.getComputedStyle(node);
          const r = node.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.05 && (r.width > 0 || r.height > 0);
        }).map(node => ({
          tagName: node.tagName ? node.tagName.toLowerCase() : '',
          id: node.id || undefined,
          className: typeof node.className === 'string' ? node.className : '',
          rect: { width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height) },
          role: node.getAttribute('role') || undefined,
        }));

        const scrollWidth = document.documentElement.scrollWidth;
        const viewportWidth = window.innerWidth;
        const hasHorizontalOverflow = scrollWidth > (viewportWidth + 2);

        return {
          url: window.location.href,
          title: document.title,
          bodyClasses: Array.from(document.body.classList || []),
          bodyOverflowLocked: bodyLocked,
          bodyOverflowY,
          bodyOverflowX,
          target: targetInfo,
          activeOverlays,
          hasHorizontalOverflow,
          scrollWidth,
          viewportWidth,
        };
      } catch (e) {
        return null;
      }
    })()`;

    try {
      const res = await this.host.evalJs(script, tabId, effectivePane);
      if (res && typeof res === 'object') {
        return res;
      }
    } catch {
      // Host may not support evalJs or page is in transition
    }
    return null;
  }

  private evaluateBehaviorEvidence(
    before: any,
    after: any,
    beforeStyles: Record<string, unknown>,
    afterStyles: Record<string, unknown>
  ): {
    verified: boolean;
    verdict: string;
    confidence: number;
    evidence: Record<string, unknown>;
  } {
    let verdict = 'NO_OBSERVABLE_EFFECT';
    let confidence = 1.0;
    let verified = false;

    const navigated = Boolean(before?.url && after?.url && before.url !== after.url);
    const addedBodyClasses = (after?.bodyClasses || []).filter((c: string) => !(before?.bodyClasses || []).includes(c));
    const removedBodyClasses = (before?.bodyClasses || []).filter((c: string) => !(after?.bodyClasses || []).includes(c));
    const bodyOverflowLocked = Boolean(!before?.bodyOverflowLocked && after?.bodyOverflowLocked);

    // Check newly appeared or expanded overlays
    const beforeOverlayIds = new Set((before?.activeOverlays || []).map((o: any) => `${o.tagName}:${o.id || o.className}`));
    const newOverlays = (after?.activeOverlays || []).filter((o: any) => !beforeOverlayIds.has(`${o.tagName}:${o.id || o.className}`));

    // Target ARIA and geometry deltas
    const targetAriaExpandedChanged = before?.target && after?.target && before.target.ariaExpanded !== after.target.ariaExpanded;
    const targetAriaSelectedChanged = before?.target && after?.target && before.target.ariaSelected !== after.target.ariaSelected;
    const targetAriaExpanded = after?.target?.ariaExpanded === 'true';
    const targetWidthDelta = (after?.target?.rect?.width || 0) - (before?.target?.rect?.width || 0);
    const targetHeightDelta = (after?.target?.rect?.height || 0) - (before?.target?.rect?.height || 0);
    const targetGrewSignificantly = targetHeightDelta > 40 || targetWidthDelta > 40;

    const styleChanged = JSON.stringify(beforeStyles) !== JSON.stringify(afterStyles);

    if (navigated) {
      verdict = 'PAGE_NAVIGATION';
      confidence = 1.0;
      verified = true;
    } else if (
      newOverlays.some((o: any) => /drawer|sidebar|offcanvas/i.test(o.className)) ||
      addedBodyClasses.some((c: string) => /drawer|nav-open|menu-open/i.test(c))
    ) {
      verdict = 'DRAWER_EXPANDED';
      confidence = 0.95;
      verified = true;
    } else if (
      newOverlays.some((o: any) => o.role === 'dialog' || /modal|popup/i.test(o.className)) ||
      addedBodyClasses.some((c: string) => /modal/i.test(c)) ||
      (bodyOverflowLocked && newOverlays.length > 0)
    ) {
      verdict = 'MODAL_OPENED';
      confidence = 0.95;
      verified = true;
    } else if (
      (targetAriaExpandedChanged && targetAriaExpanded) ||
      newOverlays.some((o: any) => /submenu|dropdown|menu/i.test(o.className) || o.role === 'menu')
    ) {
      verdict = 'SUBMENU_EXPANDED';
      confidence = 0.92;
      verified = true;
    } else if (targetAriaSelectedChanged) {
      verdict = 'TAB_SWITCHED';
      confidence = 0.92;
      verified = true;
    } else if ((targetAriaExpandedChanged && !targetAriaExpanded) || targetGrewSignificantly) {
      verdict = 'COLLAPSIBLE_TOGGLED';
      confidence = 0.90;
      verified = true;
    } else if (
      addedBodyClasses.length > 0 ||
      removedBodyClasses.length > 0 ||
      styleChanged ||
      newOverlays.length > 0
    ) {
      verdict = 'IN_PAGE_MUTATION';
      confidence = 0.85;
      verified = true;
    } else {
      verdict = 'NO_OBSERVABLE_EFFECT';
      confidence = 1.0;
      verified = false;
    }

    return {
      verified,
      verdict,
      confidence,
      evidence: {
        navigated,
        urlBefore: before?.url,
        urlAfter: after?.url,
        bodyDelta: {
          classesAdded: addedBodyClasses,
          classesRemoved: removedBodyClasses,
          overflowLocked: bodyOverflowLocked,
          overflowY: after?.bodyOverflowY,
        },
        targetDelta: {
          found: after?.target?.found ?? false,
          rectDelta: { widthDelta: targetWidthDelta, heightDelta: targetHeightDelta },
          ariaExpanded: { before: before?.target?.ariaExpanded, after: after?.target?.ariaExpanded },
          ariaSelected: { before: before?.target?.ariaSelected, after: after?.target?.ariaSelected },
        },
        overlays: {
          openedCount: newOverlays.length,
          items: newOverlays,
        },
        overflowBleed: {
          detected: Boolean(after?.hasHorizontalOverflow),
          scrollWidth: after?.scrollWidth,
          viewportWidth: after?.viewportWidth,
        },
      },
    };
  }
  async visualCompare(
    target: BrowserTarget,
    runId: string,
    attemptId: string,
    params: {
      baselineScreenshotRef?: string;
      comparisonTabId?: string;
      tolerance?: number;
      selector?: string;
      clipRect?: { x: number; y: number; width: number; height: number };
      maskSelectors?: string[];
      normalizeScroll?: boolean;
      tabId?: string;
      paneId?: 'desktop' | 'mobile';
    } = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<Record<string, unknown>> {
    if (!params.baselineScreenshotRef && !params.comparisonTabId) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Either baselineScreenshotRef or comparisonTabId is required for visual comparison');
    }
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';

    return this.passivePool.execute(tabId, async () => {
      if (params.normalizeScroll) {
        try {
          await this.host.evalJs(`(() => {
            const style = document.createElement('style');
            style.id = '__antifan_normalize_scroll';
            style.textContent = 'html { overflow-y: scroll !important; scrollbar-gutter: stable !important; }';
            if (!document.getElementById('__antifan_normalize_scroll')) document.head.appendChild(style);
          })()`, tabId, effectivePane);
        } catch {
          // Non-blocking normalization
        }
      }

      // Extract mask bounding boxes if maskSelectors provided
      let maskBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
      if (Array.isArray(params.maskSelectors) && params.maskSelectors.length > 0) {
        try {
          const rawBoxes = await this.host.evalJs(`(() => {
            const selectors = ${JSON.stringify(params.maskSelectors)};
            const boxes = [];
            selectors.forEach(sel => {
              document.querySelectorAll(sel).forEach(el => {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height });
                }
              });
            });
            return boxes;
          })()`, tabId, effectivePane);
          if (Array.isArray(rawBoxes)) {
            maskBoxes = rawBoxes as Array<{ x: number; y: number; width: number; height: number }>;
          }
        } catch {
          // Non-blocking mask resolution
        }
      }

      let curBase64 = await this.host.captureScreenshot(undefined, tabId, effectivePane);
      if (!curBase64 || curBase64.length === 0) {
        await new Promise((r) => setTimeout(r, 150));
        curBase64 = await this.host.captureScreenshot(undefined, tabId, effectivePane);
      }
      if (!curBase64 || curBase64.length === 0) {
        throw new CapabilityError('TARGET_STALE', `Failed to capture non-empty viewport screenshot on tab '${tabId}' (document may still be rendering)`);
      }
      const curBuffer = Buffer.from(curBase64, 'base64');
      const curArtifact = this.artifacts
        ? await this.artifacts.stage({ kind: 'screenshot', mime: 'image/png', data: curBuffer, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 })
        : limit(curBase64, 8 * 1024 * 1024);

      let baselineBuffer: Buffer | null = null;
      let baselineArtifactRef = params.baselineScreenshotRef;
      if (params.baselineScreenshotRef) {
        if (!this.artifacts || typeof this.artifacts.readBytesById !== 'function') {
          throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Artifact store is not available to load baseline screenshot');
        }
        try {
          const loaded = this.artifacts.readBytesById(params.baselineScreenshotRef, {
            runId,
            attemptId,
            projectId: target.projectId,
            workspaceId: target.workspaceId,
          });
          if (loaded.ref.truncated) {
            throw new CapabilityError('INVALID_ARGUMENT', `Baseline screenshot artifact '${params.baselineScreenshotRef}' is marked as truncated`);
          }
          if (typeof loaded.ref.mime === 'string' && !loaded.ref.mime.startsWith('image/')) {
            throw new CapabilityError('INVALID_ARGUMENT', `Baseline artifact '${params.baselineScreenshotRef}' is not an image (mime: ${loaded.ref.mime})`);
          }
          baselineBuffer = loaded.data;
        } catch (err: unknown) {
          if (err instanceof CapabilityError) throw err;
          throw new CapabilityError('INVALID_ARGUMENT', `Baseline screenshot artifact '${params.baselineScreenshotRef}' not found: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (params.comparisonTabId) {
        const compTabId = this.resolveTargetTab(target, params.comparisonTabId);
        if (params.normalizeScroll) {
          try {
            await this.host.evalJs(`(() => {
              const style = document.createElement('style');
              style.id = '__antifan_normalize_scroll';
              style.textContent = 'html { overflow-y: scroll !important; scrollbar-gutter: stable !important; }';
              if (!document.getElementById('__antifan_normalize_scroll')) document.head.appendChild(style);
            })()`, compTabId, effectivePane);
          } catch {
            // Non-blocking normalization
          }
        }
        let compBase64 = await this.host.captureScreenshot(undefined, compTabId, effectivePane);
        if (!compBase64 || compBase64.length === 0) {
          await new Promise((r) => setTimeout(r, 150));
          compBase64 = await this.host.captureScreenshot(undefined, compTabId, effectivePane);
        }
        if (!compBase64 || compBase64.length === 0) {
          throw new CapabilityError('TARGET_STALE', `Failed to capture non-empty baseline screenshot on comparison tab '${compTabId}'`);
        }
        baselineBuffer = Buffer.from(compBase64, 'base64');
        const compArtifact = this.artifacts
          ? await this.artifacts.stage({ kind: 'screenshot', mime: 'image/png', data: baselineBuffer, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 })
          : limit(compBase64, 8 * 1024 * 1024);
        baselineArtifactRef = typeof compArtifact === 'object' && compArtifact && 'id' in compArtifact ? (compArtifact as { id: string }).id : (typeof compArtifact === 'string' ? compArtifact : undefined);
      }

      if (!baselineBuffer) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Failed to acquire baseline image buffer for comparison');
      }

      const tolerance = typeof params.tolerance === 'number' ? params.tolerance : 5.0;
      const diffResult = computePixelDiff(curBuffer, baselineBuffer, tolerance, maskBoxes);

      return {
        match: diffResult.match,
        mismatchPercentage: diffResult.mismatchPercentage,
        diffPixels: diffResult.diffPixels,
        totalPixels: diffResult.totalPixels,
        dimensionsMatch: diffResult.dimensionsMatch,
        tolerance,
        diffBoundingBoxes: diffResult.diffBoundingBoxes,
        currentScreenshot: curArtifact,
        baselineScreenshot: baselineArtifactRef,
        notes: diffResult.match ? 'Visual comparison passed within tolerance' : `Visual discrepancies detected (${diffResult.mismatchPercentage}% mismatch exceeds ${tolerance}% tolerance)`,
      };
    });
  }
  private resolveTargetTab(target?: BrowserTarget, explicitTabId?: string, operationType: 'read' | 'lifecycle' | 'write' = 'read'): string {
    if (target) {
      assertTarget(target, true);
    }
    const tabExists = (id?: string | null): id is string => {
      if (!id) return false;
      if (typeof this.host.hasTab === 'function') {
        return this.host.hasTab(id);
      }
      const list = this.host.getTabList();
      return Boolean(list && list.some((tab: unknown) => Boolean(tab && typeof tab === 'object' && 'id' in tab && tab.id === id)));
    };
    let resolved: string | undefined;

    if (explicitTabId && explicitTabId.trim().length > 0) {
      if (!tabExists(explicitTabId.trim())) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown tab ID: ${explicitTabId}`);
      }
      if (operationType === 'write' && target?.tabId && target.tabId.trim().length > 0 && explicitTabId.trim() !== target.tabId.trim()) {
        throw new CapabilityError('TARGET_MISMATCH', `Explicit tabId "${explicitTabId}" does not match target tabId "${target.tabId}"`);
      }
      resolved = explicitTabId.trim();
    } else if (target?.tabId && target.tabId.trim().length > 0) {
      if (!tabExists(target.tabId)) {
        throw new CapabilityError('TARGET_STALE', `Target tab no longer exists: ${target.tabId}`);
      }
      resolved = target.tabId;
    } else {
      const currentAutoTab = this.host.getAutomationTabId ? this.host.getAutomationTabId() : undefined;
      if (tabExists(currentAutoTab)) {
        resolved = currentAutoTab;
      } else if (this.host.createTab) {
        resolved = this.host.createTab('about:blank', false, { ephemeral: operationType === 'write' });
        if (this.host.setAutomationTabId) {
          this.host.setAutomationTabId(resolved);
        }
      } else if (operationType !== 'write') {
        const activeTabId = this.host.getActiveTabId ? this.host.getActiveTabId() : undefined;
        if (tabExists(activeTabId)) {
          resolved = activeTabId;
        } else {
          const fallbackList = this.host.getTabList();
          if (fallbackList.length > 0 && typeof (fallbackList[0] as { id?: unknown })?.id === 'string') {
            resolved = (fallbackList[0] as { id: string }).id;
          }
        }
      } else {
        throw new CapabilityError('TARGET_REQUIRED', 'Behavioral mutation requires an explicit target tabId or dedicated automation tab');
      }
    }

    if (!resolved) {
      throw new CapabilityError('TARGET_REQUIRED', 'Browser target tabId is required');
    }

    if (target) {
      const liveDocGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(resolved) : target.documentGeneration;
      if (!explicitTabId && operationType === 'write' && typeof target.documentGeneration === 'number' && typeof liveDocGen === 'number' && target.documentGeneration !== liveDocGen) {
        throw new CapabilityError(
          'TARGET_STALE',
          `Browser target document generation (${target.documentGeneration}) is stale compared to live document generation (${liveDocGen}). The DOM was modified or reloaded in the background. Please re-inspect DOM before interacting.`
        );
      }

      const effectiveDocGen = (operationType === 'read' || operationType === 'lifecycle' || Boolean(explicitTabId))
        ? (liveDocGen ?? target.documentGeneration)
        : target.documentGeneration;
      const currentTarget: BrowserTarget = {
        ...target,
        tabId: resolved,
        documentGeneration: effectiveDocGen,
      };
      this.assertCurrent(currentTarget);
    }
    return resolved;
  }

  getDocumentGeneration(tabId?: string): number {
    return this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : 1;
  }

  private assertCurrent(target: BrowserTarget): void {
    if (this.host.isCurrentTarget && !this.host.isCurrentTarget(target)) throw new CapabilityError('TARGET_STALE', 'Browser target no longer matches the current tab document');
  }
}

function assertTarget(target: BrowserTarget, allowMissingTab = false): void {
  if (!target || typeof target !== 'object') {
    throw new CapabilityError('TARGET_REQUIRED', 'Browser target is required');
  }
  if (!target.projectId || !target.workspaceId || !target.runtimeId) {
    throw new CapabilityError('TARGET_REQUIRED', 'Browser target projectId, workspaceId, and runtimeId are required');
  }
  if (!allowMissingTab && !target.tabId) {
    throw new CapabilityError('TARGET_REQUIRED', 'Browser target tabId is required');
  }
  if (!Number.isInteger(target.browserEpoch) || target.browserEpoch < 1 || !Number.isInteger(target.documentGeneration) || target.documentGeneration < 1) {
    throw new CapabilityError('TARGET_STALE', 'Browser target epoch and document generation are required');
  }
}

function limit(value: string, max: number): string { return value.length > max ? `${value.slice(0, max)}...[truncated:${digestText(value).slice(0, 12)}]` : value; }
export function computePixelDiff(
  img1Buffer: Buffer,
  img2Buffer: Buffer,
  tolerancePercent = 5.0,
  maskBoxes: Array<{ x: number; y: number; width: number; height: number }> = []
): {
  match: boolean;
  mismatchPercentage: number;
  diffPixels: number;
  totalPixels: number;
  dimensionsMatch: boolean;
  diffBoundingBoxes: Array<{ x: number; y: number; width: number; height: number; pixelCount: number }>;
} {
  if (typeof tolerancePercent !== 'number' || !Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > 100) {
    throw new CapabilityError('INVALID_ARGUMENT', 'Tolerance must be a finite number between 0 and 100');
  }

  let size1 = { width: 0, height: 0 };
  let size2 = { width: 0, height: 0 };
  let bitmap1: Buffer | null = null;
  let bitmap2: Buffer | null = null;

  try {
    const { nativeImage } = require('electron');
    if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') {
      throw new Error('Electron nativeImage is unavailable');
    }
    const nImg1 = nativeImage.createFromBuffer(img1Buffer);
    const nImg2 = nativeImage.createFromBuffer(img2Buffer);
    size1 = nImg1.getSize();
    size2 = nImg2.getSize();
    if (!nImg1.isEmpty()) bitmap1 = nImg1.getBitmap();
    if (!nImg2.isEmpty()) bitmap2 = nImg2.getBitmap();
  } catch (err: unknown) {
    throw new CapabilityError('CAPABILITY_NOT_FOUND', `Electron nativeImage decoder unavailable for visual diff: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!bitmap1 || !bitmap2 || size1.width <= 0 || size1.height <= 0 || size2.width <= 0 || size2.height <= 0) {
    throw new CapabilityError('INVALID_ARGUMENT', 'Failed to decode one or both PNG images into raw pixel bitmaps');
  }

  const area1 = size1.width * size1.height;
  const area2 = size2.width * size2.height;
  const minW = Math.min(size1.width, size2.width);
  const minH = Math.min(size1.height, size2.height);
  const overlapArea = minW * minH;
  let totalPixels = area1 + area2 - overlapArea;
  let diffPixels = 0;
  const dimensionsMatch = size1.width === size2.width && size1.height === size2.height;
  if (!dimensionsMatch) {
    diffPixels += (area1 + area2 - 2 * overlapArea);
  }

  // Grid clustering for diff bounding boxes (32x32 blocks)
  const blockSize = 32;
  const gridW = Math.ceil(minW / blockSize);
  const gridH = Math.ceil(minH / blockSize);
  const gridCounts = new Map<string, number>();

  const isMasked = (x: number, y: number): boolean => {
    for (let i = 0; i < maskBoxes.length; i++) {
      const box = maskBoxes[i];
      if (box && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
        return true;
      }
    }
    return false;
  };

  for (let y = 0; y < minH; y++) {
    for (let x = 0; x < minW; x++) {
      if (maskBoxes.length > 0 && isMasked(x, y)) {
        totalPixels = Math.max(0, totalPixels - 1);
        continue;
      }
      const idx1 = (y * size1.width + x) * 4;
      const idx2 = (y * size2.width + x) * 4;
      const rDiff = Math.abs(bitmap1[idx1]! - bitmap2[idx2]!);
      const gDiff = Math.abs(bitmap1[idx1 + 1]! - bitmap2[idx2 + 1]!);
      const bDiff = Math.abs(bitmap1[idx1 + 2]! - bitmap2[idx2 + 2]!);
      const aDiff = Math.abs(bitmap1[idx1 + 3]! - bitmap2[idx2 + 3]!);
      const colorDelta = Math.sqrt(rDiff * rDiff + gDiff * gDiff + bDiff * bDiff + aDiff * aDiff) / 510;
      if (colorDelta > 0.05) {
        diffPixels++;
        const gx = Math.floor(x / blockSize);
        const gy = Math.floor(y / blockSize);
        const key = `${gx},${gy}`;
        gridCounts.set(key, (gridCounts.get(key) || 0) + 1);
      }
    }
  }

  const diffBoundingBoxes: Array<{ x: number; y: number; width: number; height: number; pixelCount: number }> = [];
  for (const [key, count] of gridCounts.entries()) {
    if (count > 4) {
      const [gxStr, gyStr] = key.split(',');
      const gx = parseInt(gxStr || '0', 10);
      const gy = parseInt(gyStr || '0', 10);
      diffBoundingBoxes.push({
        x: gx * blockSize,
        y: gy * blockSize,
        width: Math.min(blockSize, minW - gx * blockSize),
        height: Math.min(blockSize, minH - gy * blockSize),
        pixelCount: count,
      });
    }
  }

  const mismatchPct = totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0;
  const roundedMismatch = Math.round(mismatchPct * 100) / 100;
  return {
    match: mismatchPct <= tolerancePercent,
    mismatchPercentage: roundedMismatch,
    diffPixels,
    totalPixels,
    dimensionsMatch,
    diffBoundingBoxes: diffBoundingBoxes.slice(0, 50),
  };
}
