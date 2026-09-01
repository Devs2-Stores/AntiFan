import { BrowserTarget, CapabilityError, ArtifactRef, assertExactBrowserTarget, digestText } from '../../shared/control-plane-contracts';

export interface BrowserHostPort {
  getTabList(): unknown[];
  getActiveTabId?(): string;
  getAutomationTabId?(): string | null;
  setAutomationTabId?(tabId?: string): void;
  createTab?(url?: string, activate?: boolean): string;
  closeTab?(tabId: string): boolean;
  switchTab?(tabId: string): boolean;
  navigate(tabId: string, url: string): Promise<boolean> | boolean;
  reload(tabId: string): Promise<boolean> | boolean;
  getDom(selector?: string, tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<string>;
  captureScreenshot(rect?: unknown, tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<string>;
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
  agentSnapshot?(tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<string>;
  sendKeyboardPress?(params: { key: string; modifiers?: string[]; tabId?: string }): Promise<{ success: boolean; key: string; modifiers: string[] }>;
  setViewportSize?(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string }): boolean;
  setDevicePreset?(tabId: string, presetId: string): boolean;
  getDevicePresets?(): unknown[];
  setZoom?(tabId: string, zoomFactor: number): boolean;
  toggleInspect?(): boolean;
  isCurrentTarget?(target: BrowserTarget): boolean;
  clearAllAgentWorking?(): void;
  getDocumentGeneration?(tabId?: string): number;
}

export interface BrowserArtifactSink {
  stage(input: { kind: ArtifactRef['kind']; mime: string; data: string | Buffer; runId: string; attemptId: string; projectId: string; workspaceId: string; maxBytes?: number }): Promise<ArtifactRef> | ArtifactRef;
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

export class ViewportGate {
  private isLocked = false;
  private isPoisoned = false;
  private activeAbortController: AbortController | null = null;
  private activeTabId: string | null = null;
  private onCancelCallback: ((tabId?: string) => Promise<boolean>) | null = null;
  private queue: Array<{
    tabId?: string;
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
      return Promise.resolve(() => this.releaseNext());
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
      next.resolve(() => this.releaseNext());
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
  public readonly viewportGate = new ViewportGate();

  constructor(private readonly host: BrowserHostPort, private readonly artifacts?: BrowserArtifactSink) {
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
    return this.host.getTabList();
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
      return this.artifacts ? this.artifacts.stage({ kind: 'dom', mime: 'text/html', data: html, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 512 * 1024 }) : limit(html, 512 * 1024);
    });
  }

  async screenshot(target: BrowserTarget, runId: string, attemptId: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile'): Promise<ArtifactRef | string> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    return this.passivePool.execute(tabId, async () => {
      const base64 = await this.host.captureScreenshot(undefined, tabId, paneId);
      const buffer = Buffer.from(base64, 'base64');
      return this.artifacts ? this.artifacts.stage({ kind: 'screenshot', mime: 'image/png', data: buffer, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 }) : limit(base64, 8 * 1024 * 1024);
    });
  }

  async eval(target: BrowserTarget, expression: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile'): Promise<unknown> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    if (!expression.trim()) throw new CapabilityError('INVALID_ARGUMENT', 'JavaScript expression is required');
    return this.passivePool.execute(tabId, async () => {
      return this.host.evalJs(expression, tabId, paneId);
    });
  }
  openTab(options: { url?: string; activate?: boolean } = {}): { tabId: string } {
    if (!this.host.createTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'createTab is not supported by host');
    const tabId = this.host.createTab(options.url || 'about:blank', options.activate ?? false);
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
  closeTab(tabId: string): { closed: boolean } {
    if (!this.host.closeTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'closeTab is not supported by host');
    return { closed: this.host.closeTab(tabId) };
  }

  switchTab(tabId: string): { switched: boolean } {
    if (!this.host.switchTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'switchTab is not supported by host');
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
      return (await this.host.agentTrajectory!({ ...args, tabId })) as Record<string, unknown>;
    }, { tabId });
  }

  async agentMove(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ moved: boolean }> {
    if (!this.host.agentMove) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentMove is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      return { moved: await this.host.agentMove!({ ...args, tabId }) };
    }, { tabId });
  }

  async agentClick(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ clicked: boolean }> {
    if (!this.host.agentClick) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentClick is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      return { clicked: await this.host.agentClick!({ ...args, tabId }) };
    }, { tabId });
  }

  async agentType(args: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ typed: boolean }> {
    if (!this.host.agentType) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentType is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
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
      return { scrolled: await this.host.agentScroll!({ ...args, tabId }) };
    }, { tabId });
  }

  async agentHover(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ hovered: boolean }> {
    if (!this.host.agentHover) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentHover is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      return { hovered: await this.host.agentHover!({ ...args, tabId }) };
    }, { tabId });
  }

  async agentHighlight(args: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ highlighted: boolean }> {
    if (!this.host.agentHighlight) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentHighlight is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
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

  async agentSnapshot(options?: { tabId?: string; paneId?: 'desktop' | 'mobile' } | string, target?: BrowserTarget): Promise<{ snapshot: string }> {
    if (!this.host.agentSnapshot) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentSnapshot is not supported by host');
    const tabId = typeof options === 'string' ? options : options?.tabId;
    const paneId = typeof options === 'object' ? options?.paneId : undefined;
    const effectiveTabId = this.resolveTargetTab(target, tabId);
    return { snapshot: await this.host.agentSnapshot(effectiveTabId, paneId) };
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
  private resolveTargetTab(target?: BrowserTarget, explicitTabId?: string, operationType: 'read' | 'lifecycle' | 'write' = 'read'): string {
    if (target) {
      assertTarget(target, true);
    }
    const tabExists = (id?: string | null): id is string => {
      if (!id) return false;
      const list = this.host.getTabList();
      return Boolean(list && list.some((tab: unknown) => Boolean(tab && typeof tab === 'object' && 'id' in tab && (tab as { id?: unknown }).id === id)));
    };
    let resolved: string | undefined;

    if (explicitTabId && explicitTabId.trim().length > 0) {
      if (!tabExists(explicitTabId)) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown tab ID: ${explicitTabId}`);
      }
      resolved = explicitTabId;
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
        resolved = this.host.createTab('about:blank', false);
        if (this.host.setAutomationTabId) {
          this.host.setAutomationTabId(resolved);
        }
      } else {
        const activeTabId = this.host.getActiveTabId ? this.host.getActiveTabId() : undefined;
        if (tabExists(activeTabId)) {
          resolved = activeTabId;
        } else {
          const fallbackList = this.host.getTabList();
          if (fallbackList.length > 0 && typeof (fallbackList[0] as { id?: unknown })?.id === 'string') {
            resolved = (fallbackList[0] as { id: string }).id;
          }
        }
      }
    }

    if (!resolved) {
      throw new CapabilityError('TARGET_REQUIRED', 'Browser target tabId is required');
    }
    if (!tabExists(resolved)) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown tab ID: ${resolved}`);
    }
    if (target) {
      const liveDocGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(resolved) : target.documentGeneration;
      // Differential Generation Fencing (RT-03):
      // For passive reads and lifecycle reloads/navigates, auto-sync documentGeneration with liveDocGen to eliminate TARGET_STALE on background HMR.
      // For interactive writes, enforce strict preflight check: fail-close with HMR_DRIFT error code if the DOM changed under the agent.
      const isPassiveOrLifecycle = operationType === 'read' || operationType === 'lifecycle';
      const docGenToAssert = isPassiveOrLifecycle
        ? (liveDocGen ?? target.documentGeneration)
        : (target.tabId === resolved && target.documentGeneration !== undefined ? target.documentGeneration : liveDocGen);

      const currentTarget: BrowserTarget = {
        ...target,
        tabId: resolved,
        documentGeneration: docGenToAssert,
      };
      assertTarget(currentTarget, false);
      if (operationType === 'write' && typeof target.documentGeneration === 'number' && typeof liveDocGen === 'number' && target.documentGeneration !== liveDocGen) {
        throw new CapabilityError(
          'HMR_DRIFT',
          `Browser target document generation (${target.documentGeneration}) is stale compared to live document generation (${liveDocGen}). The DOM was modified or reloaded in the background (HMR_DRIFT). Please re-inspect DOM before interacting.`
        );
      }
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
