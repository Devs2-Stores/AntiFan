import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { buildTreeWalkerSanitizerScript } from './adapters/tree-walker-sanitizer';
import {
  BrowserTarget,
  CapabilityError,
  ArtifactRef,
  assertExactBrowserTarget,
  digestText,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
} from '../../shared/control-plane-contracts';
import { computeSparseInteractionDelta } from '../verification/interaction-delta.js';
import { attributeMutations } from '../verification/mutation-attribution.js';
import { ActionBoundary, RawBehaviorScope, ObservationIntegrity } from '../verification/interaction-contract.js';
import {
  MaskLedger,
  MaskResolutionError,
  MultiKeyLock,
  NormalizationTransaction,
  TwoSourceCoherenceGuard,
  CaptureError,
  coherencePairReceipt,
  emptyMaskLedgerResult,
  emptyNormalizationReceipt,
  maskEntryReceipt,
  materializeRasterMasks,
  visualCaptureSpaceFromMeasured,
  VerificationCaptureEnvelope,
  checkRouteIdentity,
  type RouteAssertionResult,
  type RouteRefusalCode,
  VerificationCaptureReceipt,
  checkCaptureStateCompatibility,
  verificationCaptureReceipt,
  generateVisualMetricSamples,
  type EvidenceCaptureEnvelope,
  createVisualEvidenceReceipt,
  RENDER_SURFACE_PROBE_BOUND_MS,
  REFERENCE_MATERIALIZATION_BOUND_MS,
  buildReferenceMaterializationScript,
  classifyRenderSurfaceCause,
  type CaptureViewportTransaction,
  type RenderSurfaceSnapshot,
  type CaptureIdentitySnapshot,
  type CoherencePairCheck,
  type MaskResolutionEntry,
  type NormalizationReceipt,
  type VisualStructuralMetrics,
} from '../verification/visual-capture.js';
import { withZeroNetworkDenialTransaction, CdpDebuggerInterface } from '../browser/zero-network-interceptor.js';
import { classifyNetworkUrl } from '../browser/network-policy.js';
import {
  normalizeVisualRegions,
  computeStructuralMetrics,
  buildStructuralQueryScript,
  type RawElementSensoryData,
  type VisualRegionBundle,
} from '../verification/visual-region.js';
import {
  CaptureSettleGate,
  createBrowserSettlePredicates,
  type VisualSettleReceipt,
  type CaptureSettleOptions,
} from '../verification/capture-settle.js';
import {
  BaselineAuthority,
  readPngDimensions,
  type VisualBaselineRef,
} from '../verification/baseline-authority.js';
import type { NetworkTrackerOptions } from '../browser/first-party-network-tracker.js';
import type { AntiFanTab } from '../../shared/contracts';
import { injectedScriptStore } from '../browser/scripts/injected-script-store.js';

function isTabRecord(item: unknown): item is AntiFanTab {
  if (typeof item !== 'object' || item === null || !('id' in item)) return false;
  return typeof item.id === 'string';
}
export interface ResponsiveBreakpointOption {
  id: string;
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  deviceScaleFactor?: number;
}

interface ObservationIdentity {
  browserEpoch: number;
  documentGeneration: number;
  mutationRevision: number;
}

function sameObservationIdentity(left: ObservationIdentity, right: ObservationIdentity): boolean {
  return left.browserEpoch === right.browserEpoch
    && left.documentGeneration === right.documentGeneration
    && left.mutationRevision === right.mutationRevision;
}
export interface BrowserHostPort {

  hasTab?(tabId?: string | null): boolean;
  resolveTargetTabId?(tabIdOrIdentifier?: string | null): string | undefined;
  adoptChildTab?(primaryOrBoundTabId: string, childTabId: string, generation?: number | string, source?: 'agent_spawned' | 'native_window_open' | 'user_attached', parentTabId?: string): boolean;
  getManagedTabIds?(primaryOrBoundTabId: string): Set<string>;
  isTabAllowed?(primaryOrBoundTabId: string, requestedTabId: string): boolean;
  getFailoverTargetTab?(staleTabId: string): string | undefined;
  getTabList(): unknown[];
  getBrowserEpoch?(): number;
  getActiveTabId?(): string;
  getAutomationTabId?(): string | null;
  setAutomationTabId?(tabId?: string): void;
  isTabOffscreen?(tabId?: string): boolean;
  isTabEphemeral?(tabId?: string): boolean;
  createTab?(url?: string, activate?: boolean, options?: { capsuleId?: string; userAgentMode?: any; ephemeral?: boolean; offscreen?: boolean }): string;
  closeTab?(tabId: string): boolean;
  switchTab?(tabId: string): boolean;
  navigate(tabId: string, url: string): Promise<boolean> | boolean;
  navigateAndWait?(tabId: string, url: string, timeoutMs?: number): Promise<boolean>;
  getLastNavigationFailure?(tabId: string): { cause: string; message: string; timedOut: boolean } | undefined;
  getRedirectChain?(tabId: string): string[];
  getTabUrl?(tabId: string): string;
  getSemanticDocumentGeneration?(tabId: string, paneId?: 'desktop' | 'mobile'): number;
  reload(tabId: string): Promise<boolean> | boolean;
  reloadAndWait?(tabId: string, timeoutMs?: number): Promise<boolean>;
  getDom(selector?: string, tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<string>;
  captureScreenshot(rect?: unknown, tabId?: string, paneId?: 'desktop' | 'mobile', options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }): Promise<string>;
  captureVerificationScreenshot?(rect?: unknown, tabId?: string, paneId?: 'desktop' | 'mobile', options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; timeoutMs?: number }): Promise<VerificationCaptureEnvelope>;
  /** True when the host can attach the target tab in place for capture without switching active tabs. */
  canAttachForCapture?(tabId?: string, paneId?: 'desktop' | 'mobile'): boolean;
  supportsAttachInPlaceCapture?: boolean;
  /** Session-owned tab records, including agent-plane tabs the strip never shows. */
  getSessionTabList?(boundTabId: string): unknown[];
  /** True while the target holds a timed-out in-flight CDP command. */
  isTargetDraining?(tabId: string, paneId?: 'desktop' | 'mobile'): boolean;
  /** Bounded recovery: waits for the CDP queue tail, then performs a bounded reset. */
  drainTarget?(tabId: string, paneId?: 'desktop' | 'mobile', timeoutMs?: number): Promise<{ ok: boolean; drained: boolean; resetPerformed: boolean; elapsedMs: number }>;
  /** Bounded render-surface probe; rejects with NO_RENDER_SURFACE when unmeasurable. */
  readRenderSurface?(tabId?: string, paneId?: 'desktop' | 'mobile', timeoutMs?: number): Promise<RenderSurfaceSnapshot>;
  /** Post-drain geometry restore for a tab a capture moved (CDP is admissible again). */
  reapplyTabGeometry?(tabId: string, paneId: 'desktop' | 'mobile' | undefined, before: { width: number; height: number; scrollX: number; scrollY: number }): Promise<CaptureViewportTransaction>;
  evalJs(expression: string, tabId?: string, paneId?: 'desktop' | 'mobile', userGesture?: boolean, timeoutMs?: number): Promise<unknown>;
  getDiagnostics?(tabId?: string, level?: number | string): { console: unknown[]; failures: unknown[] };
  runResponsiveCheck?(params?: { tabId?: string; selector?: string; customBreakpoints?: ResponsiveBreakpointOption[] } | string): Promise<Record<string, unknown>>;
  agentTrajectory?(params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<Record<string, unknown>>;
  dispatchAgentAction?(action: 'click' | 'type' | 'move' | 'hover' | 'scroll' | 'highlight' | 'clear' | 'trajectory', params: Record<string, unknown>): Promise<{ success: boolean; data?: unknown; reason?: string }>;
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
  setViewportSize?(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string; reload?: boolean }): Promise<{ success: boolean; reloaded?: boolean } | boolean> | { success: boolean; reloaded?: boolean } | boolean;
  setDevicePreset?(tabId: string, presetId: string, options?: { reload?: boolean }): boolean;
  getDevicePresets?(): unknown[];
  setZoom?(tabId: string, zoomFactor: number): boolean;
  toggleInspect?(): boolean;
  isCurrentTarget?(target: BrowserTarget): boolean;
  clearAllAgentWorking?(): void;
  getDocumentGeneration?(tabId?: string): number;
  bumpDocumentGeneration?(tabId?: string): number;
  getMutationRevision?(tabId?: string): number;
  bumpMutationRevision?(tabId?: string): number;
  uploadFileInput?(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<{ success: boolean; uploadedCount: number; reason?: string }>;
  dropFiles?(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<{ success: boolean; droppedCount: number; reason?: string }>;
  executeActionSequence?(params: { actions: unknown[]; tabId?: string; paneId?: 'desktop' | 'mobile'; stopOnError?: boolean }): Promise<unknown>;
  inspectStyles?(params: { selector?: string; ref?: string; properties?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<Record<string, unknown>>;
  inspectRegion?(params: { x?: number; y?: number; width?: number; height?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<Record<string, unknown>>;
  inspectFont?(params: { selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<Record<string, unknown>>;
  getMatchedStylesForNode?(params: { nodeId?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<Record<string, unknown> | null>;
  getNetworkTracker?(): { isAttached: (tabId: string, paneId?: string) => boolean; awaitQuiescence: (tabId: string, paneId?: string, options?: NetworkTrackerOptions, signal?: AbortSignal) => Promise<{ settled: boolean; durationMs: number; timedOut: boolean }> };
  wait?(params: BrowserWaitParams, signal?: AbortSignal): Promise<BrowserWaitResult>;
  observe?(params: BrowserObserveParams): Promise<BrowserObserveResult>;
  getTabDebugger?(tabId: string): CdpDebuggerInterface | undefined;
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
    mutationRevision: number;
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

export interface BrowserArtifactStageInput {
  kind: ArtifactRef['kind'];
  mime: string;
  data: string | Buffer;
  runId: string;
  attemptId: string;
  projectId: string;
  workspaceId: string;
  maxBytes?: number;
  leaseToken?: string;
  overflowMode?: 'truncate' | 'reject';
}

export interface BrowserArtifactSink {
  stage(input: BrowserArtifactStageInput): Promise<ArtifactRef> | ArtifactRef;
  /** Preferred when implemented: stages without blocking the main thread on large buffers. */
  stageAsync?(input: BrowserArtifactStageInput): Promise<ArtifactRef>;
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
  // Phase 2 (step 9): poison state is scoped by target so an unacknowledged cancel on
  // one tab/session cannot poison unrelated tabs (the over-global cross-session
  // contamination invariant). Tabs listed here are rejected for new acquisitions;
  // the global flag below remains as a fallback for abstraction-less poisons.
  private poisonedTabs = new Set<string>();
  private preemptionEpoch = 1;
  private activeAbortController: AbortController | null = null;
  private activeTabId: string | null = null;
  private lastPreemptScopeTabId: string | null = null;
  private lastPreemptScoped = false;
  // Epoch of the preemption that actually targeted the active lock. Distinguishes
  // "no preemption" (ordinary lease timeout -> poison only the lock's own tab) from
  // an unscoped human preemption (-> global poison); both leave lastPreemptScoped=false.
  private lastPreemptEpoch = 0;
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

  public resetPoisonState(tabId?: string): void {
    if (tabId) {
      this.poisonedTabs.delete(tabId);
    } else {
      this.isPoisoned = false;
      this.poisonedTabs.clear();
    }
  }

  public poison(reason: string, tabId?: string): void {
    if (tabId) {
      this.poisonedTabs.add(tabId);
      // Only entries targeting this tab are poisoned; others keep their slot.
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const entry = this.queue[i];
        if (entry && entry.tabId === tabId) {
          this.queue.splice(i, 1);
          clearTimeout(entry.timer);
          entry.reject(new CapabilityError('TARGET_STALE', reason));
        }
      }
      return;
    }
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
      // Record the preemption scope so an unacknowledged cancel poisons only that tab
      // (per-target) when the preemption was scoped, or globally when it was a
      // user-intervention without a tab (existing global-drain semantics).
      this.lastPreemptScopeTabId = tabId || null;
      this.lastPreemptScoped = Boolean(tabId);
      this.lastPreemptEpoch = this.preemptionEpoch;
      this.activeAbortController.abort(new CapabilityError('PREEMPTED_BY_USER', reason));
    }
  }
  async withLock<T>(
    action: (signal: AbortSignal) => Promise<T>,
    options: ViewportLockOptions = {}
  ): Promise<T> {
    const lockTabId = options.tabId?.trim() || undefined;
    if (this.isPoisoned || (lockTabId !== undefined && this.poisonedTabs.has(lockTabId))) {
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
    const release = await this.acquire(lockTabId, timeoutMs, controller.signal);

    // 2. Recheck poison immediately after acquisition before executing action
    if (this.isPoisoned || (lockTabId !== undefined && this.poisonedTabs.has(lockTabId))) {
      release();
      throw new CapabilityError('TARGET_STALE', 'ViewportGate is poisoned due to unacknowledged action cancellation');
    }

    // 2b. This caller now owns the lock: capture the preemption epoch and clear any
    // scope recorded by an earlier action. Resetting before acquisition would let a
    // queued caller corrupt the active holder's cancellation classification.
    const preemptEpochAtStart = this.preemptionEpoch;
    this.lastPreemptScopeTabId = null;
    this.lastPreemptScoped = false;

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
        // A real preemption during this lock keeps its recorded scope (global when the
        // human input was not tab-attributed). An ordinary lease timeout with no
        // preemption fences only the lock's own tab instead of the whole gate.
        const poisonScope = this.lastPreemptEpoch > preemptEpochAtStart
          ? (this.lastPreemptScoped ? (this.lastPreemptScopeTabId || undefined) : undefined)
          : lockTabId;
        let ack = true;
        if (this.onCancelCallback && this.activeTabId) {
          try {
            ack = await this.onCancelCallback(this.activeTabId);
          } catch {
            ack = false;
          }
        }
        if (!ack) {
          this.poison('ViewportGate poisoned due to unacknowledged action cancellation', poisonScope);
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
            this.poison('ViewportGate poisoned: action failed to settle after cancellation acknowledgement', poisonScope);
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
      this.lastPreemptScoped = false;
      this.lastPreemptScopeTabId = null;
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
    // Phase 2 (step 9): drop per-target poison so a destroyed tab no longer rejects
    // new acquisitions for the same physical tabId after recreation.
    this.poisonedTabs.delete(tabId);
  }

  /** Phase 2 (step 9) contract alias: release per-target lock/poison state on tab destruction. */
  public releaseForTab(tabId: string): void {
    this.cleanupTab(tabId);
  }

  public isBusy(): boolean {
    return this.isLocked || this.queue.length > 0 || this.poisonedTabs.size > 0;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}
export type InteractionExecutionMode = 'trusted_cdp' | 'programmatic_dom' | 'unknown' | 'none';

/**
 * Resolves verified execution mode from host action result.
 * Derives execution tier from data.executionTier (cdp_trusted -> trusted_cdp, isolated_synthetic -> programmatic_dom).
 * Keeps direct agent* mocks or unconfirmed tiers classified honestly as 'unknown'.
 */
export function resolveInteractionMode(rawRes: unknown, fallbackMode: InteractionExecutionMode = 'unknown'): InteractionExecutionMode {
  if (rawRes && typeof rawRes === 'object' && !Array.isArray(rawRes)) {
    const obj = rawRes as Record<string, unknown>;
    const dataObj = obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data) ? (obj.data as Record<string, unknown>) : undefined;
    const tier = obj.executionTier || obj.tier || dataObj?.executionTier || dataObj?.tier;
    if (tier === 'cdp_trusted' || tier === 'trusted_cdp') {
      return 'trusted_cdp';
    }
    if (tier === 'isolated_synthetic' || tier === 'programmatic_dom') {
      return 'programmatic_dom';
    }
  }
  return fallbackMode;
}

/**
 * Strict fail-closed normalizer for agent interaction results.
 * Only boolean true or explicit { [actionKey]: true } is accepted as success.
 * Objects like {}, { [actionKey]: undefined/null/false }, primitives, null, and undefined are fail-closed (false).
 */
export const DEFAULT_STOREFRONT_WIDGETS: readonly string[] = Object.freeze([
  '#haravan-notification',
  '[id*="haravan-notification"]',
  '#preview-bar-iframe',
  'iframe[src*="admin/preview_bar"]',
  'iframe[src*="preview_bar"]',
  '.haravan-preview-bar',
  '#haravan-preview-bar',
  '.shopify-preview-bar',
  '#shopify-preview-bar',
  '#fake-order-popup',
  '[id*="fake-order"]',
  '#notice-cart',
  '[id*="notice-cart"]',
  '.zalo-chat-widget',
  '#fb-root',
  '#subiz',
  '#tawk-bubble-container',
  '[class*="zalo-chat"]',
  '.chat-widget',
  '[class*="chat-widget"]',
  '[id*="chat-widget"]',
  '.hotline-phone_ring',
  '.icon-contact',
  '.contact-box',
  '.phone-ring',
  '.call-mobile',
  '.quick-call-button',
  '.loomline_addthis_contact__icons',
  '.grecaptcha-badge',
  '#toast-container',
  // Auto-placed Ads & Third-party Fixed Banners (prevents >10% height drift)
  'ins.adsbygoogle',
  '.google-auto-placed',
  'iframe[src*="doubleclick"]',
  // Cookie-consent Banners
  '#onetrust-banner-sdk',
  '.cookie-notice',
  '.cookie-banner',
  '.cky-consent-container',
  '.cc-main',
  // FB Messenger Dialogs & Overlays
  'div[class*="fb_dialog"]',
]);

/**
 * Server-side budget partition for the compare transaction. The registered
 * policy timeout is `EXECUTION + CANCELLATION_ACK`: the transport aborts the
 * handler at the execution deadline and awaits owned-resource cleanup inside
 * the reserved grace. The port mirrors the same partition locally so direct
 * callers (no transport signal) are bounded identically.
 */
export const VISUAL_COMPARE_EXECUTION_BUDGET_MS = 150_000;
export const VISUAL_COMPARE_CANCELLATION_ACK_MS = 30_000;
/** Cleanup budget inside the reserved grace (leaves margin for receipt writes). */
export const VISUAL_COMPARE_CLEANUP_BUDGET_MS = 25_000;
export const FULL_PAGE_CAPTURE_EXECUTION_BUDGET_MS = 70_000;
export const FULL_PAGE_CAPTURE_CANCELLATION_ACK_MS = 20_000;
export const FULL_PAGE_CAPTURE_CLEANUP_BUDGET_MS = 15_000;
/**
 * Bound for proving a viewport write took effect: the tab must measure the
 * requested size within this window, or the write is reported as not applied
 * instead of being returned as success with unverified geometry.
 */
export const VIEWPORT_CONFIRM_BOUND_MS = 3_000;
/**
 * Viewport-capture budget. The host command bound must sit inside the policy
 * cancellation grace: a transport cancel that arrives while CDP still admits the
 * command orphans it and drains the target.
 */
export const VIEWPORT_CAPTURE_EXECUTION_BUDGET_MS = 25_000;
export const VIEWPORT_CAPTURE_CANCELLATION_ACK_MS = 5_000;
/**
 * Reference capture budget: the materialization walk, the settle barrier and two
 * artifact writes, all inside one response bound.
 */
export const REFERENCE_CAPTURE_EXECUTION_BUDGET_MS = 90_000;
export const REFERENCE_CAPTURE_CANCELLATION_ACK_MS = 20_000;

export function isStrictActionSuccess(rawRes: unknown, actionKey: string): boolean {
  if (rawRes === true) return true;
  if (rawRes && typeof rawRes === 'object' && !Array.isArray(rawRes)) {
    return (rawRes as Record<string, unknown>)[actionKey] === true;
  }
  return false;
}

interface VisualCompareParams {
  baselineScreenshotRef?: string;
  baselineRef?: string;
  comparisonTabId?: string;
  tolerance?: number;
  selector?: string;
  clipRect?: { x: number; y: number; width: number; height: number };
  maskSelectors?: string[];
  /** Additive: selectors that MAY match zero elements without failing the compare */
  maskOptionalSelectors?: string[];
  normalizeScroll?: boolean;
  tabId?: string;
  paneId?: 'desktop' | 'mobile';
  fullPage?: boolean;
  /**
   * Apply the implicit optional mask set (DEFAULT_STOREFRONT_WIDGETS plus the
   * broad `iframe[id]` selector). Default true. Final fidelity runs pass false
   * so generic selectors cannot hide first-party content behind a low pixel diff.
   */
  useDefaultWidgetMasks?: boolean;
  /** Evidence-run artifact lease token; required to stage while the run holds an exclusive lease. */
  leaseToken?: string;
  trackedSelectors?: string[];
  /** Maximum acceptable height delta ratio (0.0 to 1.0) before triggering STRUCTURAL_TRUNCATION_DETECTED. Default is 0.10 (10%). */
  heightTolerance?: number;
  /** When true, bypasses the hard STRUCTURAL_TRUNCATION failure gate and proceeds to section/pixel diff evaluation */
  allowHeightDrift?: boolean;
  maxGeometryDeltaPx?: number;
  maxGeometryDeltaXPx?: number;
  maxGeometryDeltaYPx?: number;
  expectedUrl?: string | null;
  expectedTargetUrl?: string | null;
  expectedBaselineUrl?: string | null;
}

/** Bounded visual-compare capture outcome: either settles with a result or asks for another attempt. */
type VisualCompareAttemptOutcome =
  | { settle: true; result: Record<string, unknown> }
  | { settle: false; resampleCount: number };

/** Per-side CSS geometry sampled inside the strict capture window. */
interface CssMetrics {
  vw: number;
  vh: number;
  dh: number;
  sx: number;
  sy: number;
}

/** Bounds for every resource-holding await inside the compare transaction. */
const FOREGROUND_BOUND_MS = 10_000;
const EVAL_BOUND_MS = 10_000;
const SETTLE_BOUND_MS = 25_000;
const MASK_BOUND_MS = 15_000;
const NORMALIZATION_BOUND_MS = 15_000;
const NORMALIZATION_RESTORE_BOUND_MS = 15_000;
const STAGE_BOUND_MS = 30_000;
const TARGET_RECOVERY_BUDGET_MS = 25_000;
const REVERSIBLE_DOM_TXN_GLOBAL = '__antifan_compare_txn__';

export type TargetRecoveryOutcome = 'command-settled' | 'drain-reset' | 'drain-failed' | 'unsupported';

/** Typed recovery receipt for a quarantined target. */
export interface TargetRecoveryReceipt {
  tabId: string;
  paneId: 'desktop' | 'mobile';
  outcome: TargetRecoveryOutcome;
  ok: boolean;
  drained: boolean;
  resetPerformed: boolean;
  elapsedMs: number;
  error?: string;
  recoveredAt: number;
  /**
   * Geometry outcome for a capture that moved the layout viewport. Present only
   * when the recovery was asked to restore one, and part of `ok`: a target whose
   * viewport could not be restored stays quarantined.
   */
  viewportTransaction?: CaptureViewportTransaction;
}

interface TargetQuarantineEntry {
  tabId: string;
  paneId: 'desktop' | 'mobile';
  pairKey: string;
  since: number;
  reason: string;
  recovery: TargetRecoveryReceipt | undefined;
  pending: Promise<void>;
}

/**
 * Per-invocation transaction state: ownership flags plus a unique token so
 * ordinary and forced cleanup can never release another invocation's resources
 * or let a stale continuation touch tab/CDP state.
 */
interface CompareTransaction {
  token: string;
  lockKeys: string[];
  tabId: string;
  compTabTarget: string | null;
  paneId: 'desktop' | 'mobile';
  budget: CompareBudget;
  domTransactions: Map<string, string>;
  /** Tabs where THIS transaction's normalizeScroll inject created the style. */
  normalizationOwned: Set<string>;
  leaseToken?: string;
  continuationValid: boolean;
  quarantined: boolean;
  acquiredPairLock?: boolean;
  originalActiveTabId?: string;
  stagedTarget?: ArtifactRef | string;
  stagedBaseline?: string;
}

function targetKey(tabId: string, paneId: 'desktop' | 'mobile'): string {
  return `${tabId}::${paneId}`;
}

function pairKeyOf(keys: string[]): string {
  return [...keys].sort().join('|');
}

function abortError(message: string): Error {
  const err = new Error(message);
  (err as { code?: string; name?: string }).code = 'ABORTED';
  (err as { code?: string; name?: string }).name = 'AbortError';
  return err;
}

function timeoutError(message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = 'EXECUTION_TIMEOUT';
  return err;
}

/**
 * True when a capture failure means the target may still hold an in-flight CDP
 * command (timeout after dispatch, or an already-draining target).
 */
function isTargetDrainFailure(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof CaptureError) return err.code === 'CAPTURE_TIMEOUT' || err.code === 'TARGET_BUSY_DRAINING';
  const typed = err as { code?: string; message?: string };
  if (typed.code === 'CAPTURE_TIMEOUT' || typed.code === 'TARGET_BUSY_DRAINING' || typed.code === 'EXECUTION_TIMEOUT') return true;
  const message = typed.message || (err instanceof Error ? err.message : String(err));
  return /TARGET_BUSY_DRAINING/.test(message) || /timed out after \d+ms/i.test(message);
}

/**
 * True when a capture failed because the tab's layout viewport could not be
 * returned to where the capture found it. That is a state hazard, not a busy
 * transport: it must not be folded into the drain/timeout classifier.
 */
function isViewportRestoreFailure(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof CaptureError) return err.code === 'CAPTURE_VIEWPORT_NOT_RESTORED';
  const typed = err as { code?: string; message?: string };
  if (typed.code === 'CAPTURE_VIEWPORT_NOT_RESTORED') return true;
  return /CAPTURE_VIEWPORT_NOT_RESTORED/.test(typed.message || (err instanceof Error ? err.message : ''));
}

/** Resolve `work` or the bounded fallback; late settlements stay observed. */
async function raceWithTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  work.catch(() => {});
  const gate = Promise.withResolvers<T>();
  const timer = setTimeout(() => gate.resolve(onTimeout()), Math.max(1, ms));
  work.then(
    (value) => {
      clearTimeout(timer);
      gate.resolve(value);
    },
    () => {
      clearTimeout(timer);
      gate.resolve(onTimeout());
    }
  );
  return gate.promise;
}

/**
 * Project a promoted baseline's capture-state mini into a full capture receipt.
 * The mini predates capture-mode metadata, so the mode is derived from the
 * raster/CSS geometry rather than assumed.
 */
function baselineCaptureReceipt(
  mini: {
    backend: string;
    dpr: number;
    zoom: number;
    cssViewport: { width: number; height: number };
    rasterSize?: { width: number; height: number };
  },
  promotedAt: number,
  bytes: Buffer
): VerificationCaptureReceipt {
  const dpr = Number(mini.dpr) || 1;
  const zoom = Number(mini.zoom) || 1;
  const scale = dpr * zoom;
  const rasterSize = mini.rasterSize || readPngDimensions(bytes) || {
    width: Math.round(mini.cssViewport.width * dpr),
    height: Math.round(mini.cssViewport.height * dpr),
  };
  const cssCaptureSize = scale > 0
    ? { width: Math.round(rasterSize.width / scale), height: Math.round(rasterSize.height / scale) }
    : { ...mini.cssViewport };
  const captureMode = cssCaptureSize.width !== mini.cssViewport.width || cssCaptureSize.height !== mini.cssViewport.height
    ? ('clip' as const)
    : ('viewport' as const);
  return {
    backend: mini.backend,
    dpr,
    zoom,
    cssViewport: mini.cssViewport,
    cssCaptureSize,
    captureMode,
    rasterSize,
    timestamp: promotedAt,
  };
}

/**
 * Execution/cleanup budget for one compare invocation. `run` races every
 * resource-holding await against the remaining execution budget and the caller
 * signal; `cleanup` spends only the reserved grace so owned resources are
 * always released before the invocation terminalizes.
 */
class CompareBudget {
  public readonly signal: AbortSignal | undefined;
  public readonly cleanupBudgetMs: number;
  private readonly executionBudgetMs: number;
  private readonly startedAt = Date.now();

  constructor(options: { signal?: AbortSignal; executionBudgetMs: number; cleanupBudgetMs: number }) {
    this.signal = options.signal;
    this.executionBudgetMs = Math.max(1, options.executionBudgetMs);
    this.cleanupBudgetMs = Math.max(1, options.cleanupBudgetMs);
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.executionBudgetMs - this.elapsedMs);
  }

  throwIfAborted(phase: string): void {
    if (this.signal?.aborted) throw abortError(`Visual compare was cancelled during ${phase}`);
    if (this.remainingMs <= 0) {
      throw timeoutError(`Visual compare exceeded its ${this.executionBudgetMs}ms execution budget during ${phase}`);
    }
  }

  async run<T>(phase: string, work: () => Promise<T>, boundMs?: number): Promise<T> {
    this.throwIfAborted(phase);
    const bound = Math.max(1, Math.min(boundMs ?? this.remainingMs, this.remainingMs));
    return this.raceBound(phase, work, bound, true);
  }

  async sleep(ms: number, phase: string): Promise<void> {
    this.throwIfAborted(phase);
    const bound = Math.max(1, ms);
    const gate = Promise.withResolvers<void>();
    const timer = setTimeout(() => gate.resolve(), bound);
    try {
      await this.raceBound(phase, async () => {
        await gate.promise;
      }, bound, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async cleanup<T>(phase: string, work: () => Promise<T>, boundMs: number): Promise<T | undefined> {
    try {
      const bound = Math.max(1, Math.min(boundMs, this.cleanupBudgetMs));
      return await this.raceBound(phase, work, bound, false);
    } catch {
      return undefined;
    }
  }

  private async raceBound<T>(phase: string, work: () => Promise<T>, boundMs: number, honorSignal: boolean): Promise<T> {
    let started: Promise<T>;
    try {
      started = work();
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    started.catch(() => {});
    const gate = Promise.withResolvers<T>();
    const timer = setTimeout(
      () => gate.reject(timeoutError(`Visual compare ${phase} exceeded its ${boundMs}ms bound`)),
      Math.max(1, boundMs)
    );
    let onAbort: (() => void) | undefined;
    if (honorSignal && this.signal) {
      const signal = this.signal;
      if (signal.aborted) {
        clearTimeout(timer);
        throw abortError(`Visual compare was cancelled during ${phase}`);
      }
      onAbort = () => gate.reject(abortError(`Visual compare was cancelled during ${phase}`));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    started.then(
      (value) => gate.resolve(value),
      (err) => gate.reject(err)
    );
    try {
      return await gate.promise;
    } finally {
      clearTimeout(timer);
      if (onAbort && this.signal) this.signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Reversible normalization: records the previous value of every attribute it
 * touches and never removes a page node or installs a permanent style setter.
 * Carousel tracks are neutralized with inline styles only, which the restore
 * script replays from the record.
 */
function buildReversibleNormalizationApplyScript(txnId: string): string {
  return `(async () => {
    const TXN = ${JSON.stringify(txnId)};
    const registry = (window.${REVERSIBLE_DOM_TXN_GLOBAL} = window.${REVERSIBLE_DOM_TXN_GLOBAL} || {});
    if (registry[TXN]) return { applied: true, alreadyApplied: true, recorded: registry[TXN].length };
    const records = [];
    const record = (el, attr) => {
      if (el && typeof el.getAttribute === 'function') records.push({ el, attr, prev: el.getAttribute(attr) });
    };
    try {
      // 1. Dismiss backdrop / modal / popups with inline display only.
      const popups = document.querySelectorAll('.modal, .modal-backdrop, .modal-coupon--backdrop, .fancybox-overlay, .popup-content, #fake-order-popup, #haravan-notification, .loomline-modal-backdrop, [class*="modal-backdrop"]');
      for (let i = 0; i < popups.length; i++) {
        const el = popups[i];
        record(el, 'style');
        try { el.style.setProperty('display', 'none', 'important'); } catch {}
      }
      // 2. Body/document scroll-lock classes and inline overrides.
      const roots = [document.body, document.documentElement];
      for (let i = 0; i < roots.length; i++) {
        const el = roots[i];
        if (!el) continue;
        record(el, 'class');
        record(el, 'style');
        try {
          el.classList.remove('modal-open', 'mainBody-modalshow', 'layoutProduct_scroll');
          el.style.removeProperty('overflow');
          el.style.removeProperty('position');
        } catch {}
      }
      // 3. Cascade scroll for lazy/Livewire hydration, then return to origin.
      try {
        const scrollH = Math.max(
          document.documentElement ? document.documentElement.scrollHeight : 0,
          document.body ? document.body.scrollHeight : 0
        );
        if (scrollH > window.innerHeight) {
          for (let y = 0; y <= scrollH; y += 800) {
            window.scrollTo({ top: y, left: 0, behavior: 'instant' });
            await new Promise((r) => setTimeout(r, 60));
          }
        }
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        if (document.documentElement) { document.documentElement.scrollTop = 0; document.documentElement.scrollLeft = 0; }
        if (document.body) { document.body.scrollTop = 0; document.body.scrollLeft = 0; }
      } catch {}
      // 4. Carousel/slider tracks: inline transform/transition only.
      const carouselClasses = ['s-content', 'swiper-wrapper', 'slick-track', 'owl-stage', 'flickity-slider', 'carousel-inner'];
      for (let c = 0; c < carouselClasses.length; c++) {
        const els = document.getElementsByClassName(carouselClasses[c]);
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          if (!el || !el.style) continue;
          record(el, 'style');
          try {
            el.style.setProperty('transform', 'matrix(1, 0, 0, 1, 0, 0)', 'important');
            el.style.setProperty('transition', 'none', 'important');
          } catch {}
        }
      }
      // 5. Pagination dots: active-state normalization (class/aria only).
      const dotClasses = ['slider-dots', 'nav-dots', 'slick-dots', 'swiper-pagination', 'carousel-indicators', 'dots'];
      for (let c = 0; c < dotClasses.length; c++) {
        const containers = document.getElementsByClassName(dotClasses[c]);
        for (let i = 0; i < containers.length; i++) {
          const dots = Array.from(containers[i].children || []);
          for (let d = 0; d < dots.length; d++) {
            const dot = dots[d];
            record(dot, 'class');
            record(dot, 'aria-selected');
            try {
              if (d === 0) {
                dot.classList.add('active');
                if (dot.getAttribute('aria-selected') !== null) dot.setAttribute('aria-selected', 'true');
              } else {
                dot.classList.remove('active');
                if (dot.getAttribute('aria-selected') !== null) dot.setAttribute('aria-selected', 'false');
              }
            } catch {}
          }
        }
      }
    } catch {}
    registry[TXN] = records;
    return { applied: true, recorded: records.length };
  })()`;
}

/** Replay this transaction's normalization records in reverse order. */
function buildReversibleNormalizationRestoreScript(txnId: string): string {
  return `(() => {
    const TXN = ${JSON.stringify(txnId)};
    const registry = window.${REVERSIBLE_DOM_TXN_GLOBAL};
    const records = registry ? registry[TXN] : undefined;
    if (!records) return { restored: true, alreadyRestored: true, failed: 0 };
    let failed = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      try {
        if (!r || !r.el || typeof r.el.setAttribute !== 'function') continue;
        if (r.prev === null || r.prev === undefined) r.el.removeAttribute(r.attr);
        else r.el.setAttribute(r.attr, r.prev);
      } catch { failed++; }
    }
    if (failed === 0) delete registry[TXN];
    return { restored: true, alreadyRestored: false, failed };
  })()`;
}

export class BrowserControlPort {
  public readonly passivePool = new PassiveExecutionPool();
  public readonly waitRegistry = new WaitRegistry();
  public readonly viewportGate = new ViewportGate();
  /** Joint mutual exclusion for visualCompare tab pairs (passivePool keeps capacity accounting) */
  private readonly comparePairLock = new MultiKeyLock();
  /** Targets holding a timed-out in-flight CDP command until their recovery receipt lands. */
  private readonly targetQuarantine = new Map<string, TargetQuarantineEntry>();
  /**
   * Last geometry this session verified per tab. The surface probe reads
   * innerWidth/innerHeight, so a zero reading means the tab's view lost its
   * bounds; the verified geometry is the only size a bounded re-apply may restore.
   */
  private readonly verifiedTabGeometry = new Map<string, { width: number; height: number; mobile?: boolean }>();
  public readonly baselineAuthority: BaselineAuthority;
  constructor(private readonly host: BrowserHostPort, public readonly artifacts?: BrowserArtifactSink) {
    this.baselineAuthority = new BaselineAuthority({ artifactStore: this.artifacts as any });
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
  /**
   * Stages through the sink's async path when it has one: capture buffers reach
   * several megabytes, and the synchronous store write blocks the main thread.
   */
  private async stageArtifact(input: BrowserArtifactStageInput): Promise<ArtifactRef> {
    if (!this.artifacts) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'artifact sink unavailable');
    return this.artifacts.stageAsync ? this.artifacts.stageAsync(input) : this.artifacts.stage(input);
  }
  listTabs(context: { target?: BrowserTarget }): unknown[] {
    if (context.target) assertTarget(context.target);
    const boundTabId = context.target?.tabId;
    if (!boundTabId) return this.host.getTabList() || [];
    // A session asks for what it owns, not for the user's tab strip: the strip
    // omits the offscreen/ephemeral tabs the agent plane itself created.
    const sessionRecords = this.host.getSessionTabList ? this.host.getSessionTabList(boundTabId) : undefined;
    const allowedIds = this.host.getManagedTabIds ? this.host.getManagedTabIds(boundTabId) : new Set([boundTabId]);
    const records: unknown[] = sessionRecords ?? (this.host.getTabList() || []).filter((tab) => isTabRecord(tab) && allowedIds.has(tab.id));
    // A session that owns nothing lists nothing: leaking the user's strip here would
    // invite operations this session is not allowed to perform. Callers that want
    // the whole window ask for it explicitly (browser.list-tabs with all: true).
    return records.filter(isTabRecord).map((tab) => ({
      ...tab,
      isBoundTab: tab.id === boundTabId,
      isPrimaryTab: tab.id === boundTabId,
    }));
  }

  async navigate(target: BrowserTarget, url: string, explicitTabId?: string): Promise<{ navigated: boolean; target: BrowserTarget }> {
    const tabId = this.resolveTargetTab(target, explicitTabId, 'read');
    if (!url || !/^https?:\/\//i.test(url)) throw new CapabilityError('INVALID_ARGUMENT', 'Navigation requires an http(s) URL');
    const navigated = typeof this.host.navigateAndWait === 'function'
      ? await this.host.navigateAndWait(tabId, url)
      : await this.host.navigate(tabId, url);
    if (!navigated) {
      const failure = typeof this.host.getLastNavigationFailure === 'function'
        ? this.host.getLastNavigationFailure(tabId)
        : undefined;
      const failureCause = failure?.cause || (failure?.timedOut ? 'NAVIGATION_TIMEOUT' : 'TARGET_STALE');
      const message = failure?.message || 'Navigation failed or timed out before a load-complete document was available';
      throw new CapabilityError('TARGET_STALE', `[${failureCause}] ${message}`);
    }
    const docGen = typeof this.host.getSemanticDocumentGeneration === 'function'
      ? this.host.getSemanticDocumentGeneration(tabId)
      : (this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : (target.documentGeneration || 1));
    return { navigated: true, target: { ...target, tabId, documentGeneration: docGen } };
  }

  private async getLiveTabUrl(tabId: string): Promise<string> {
    if (typeof this.host.getTabUrl === 'function') {
      const url = this.host.getTabUrl(tabId);
      if (url) return url;
    }
    try {
      const tabs = typeof this.host.getTabList === 'function' ? this.host.getTabList() : [];
      const match = Array.isArray(tabs) ? tabs.find((t: unknown) => t && typeof t === 'object' && (t as Record<string, unknown>).id === tabId) : undefined;
      if (match && typeof (match as Record<string, unknown>).url === 'string' && (match as Record<string, unknown>).url) {
        return (match as Record<string, unknown>).url as string;
      }
    } catch {}
    try {
      if (typeof this.host.evalJs === 'function') {
        const live = await this.host.evalJs('window.location.href', tabId);
        if (typeof live === 'string' && live) return live;
      }
    } catch {}
    return '';
  }

  private getTabRedirectChain(tabId: string): string[] {
    if (typeof this.host.getRedirectChain === 'function') {
      const chain = this.host.getRedirectChain(tabId);
      if (Array.isArray(chain)) return chain;
    }
    return [];
  }

  async reload(target: BrowserTarget, explicitTabId?: string): Promise<{ reloaded: boolean; target: BrowserTarget; urlBefore?: string; urlAfter?: string; redirected?: boolean }> {
    const tabId = this.resolveTargetTab(target, explicitTabId, 'read');
    let urlBefore: string | undefined;
    try {
      const tabs = typeof this.host.getTabList === 'function' ? this.host.getTabList() : [];
      const match = Array.isArray(tabs) ? tabs.find((t: any) => t && typeof t === 'object' && t.id === tabId) : undefined;
      if (match && typeof (match as any).url === 'string') {
        urlBefore = (match as any).url;
      } else if (typeof this.host.evalJs === 'function') {
        urlBefore = String(await this.host.evalJs('window.location.href', tabId) || '') || undefined;
      }
    } catch {}

    const reloaded = typeof this.host.reloadAndWait === 'function'
      ? await this.host.reloadAndWait(tabId)
      : await this.host.reload(tabId);
    if (!reloaded) throw new CapabilityError('TARGET_STALE', 'Reload failed or timed out before a load-complete document was available');

    let urlAfter: string | undefined;
    try {
      const tabs = typeof this.host.getTabList === 'function' ? this.host.getTabList() : [];
      const match = Array.isArray(tabs) ? tabs.find((t: any) => t && typeof t === 'object' && t.id === tabId) : undefined;
      if (match && typeof (match as any).url === 'string') {
        urlAfter = (match as any).url;
      } else if (typeof this.host.evalJs === 'function') {
        urlAfter = String(await this.host.evalJs('window.location.href', tabId) || '') || undefined;
      }
    } catch {}

    const docGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : (target.documentGeneration || 1);
    const redirected = (urlBefore && urlAfter && urlBefore !== urlAfter) ? true : false;
    return {
      reloaded: true,
      target: { ...target, tabId, documentGeneration: docGen },
      ...(urlBefore ? { urlBefore } : {}),
      ...(urlAfter ? { urlAfter } : {}),
      ...(urlBefore && urlAfter ? { redirected } : {}),
    };
  }

  /**
   * Explicit opt-in capability: reloads an isolated offline/local clone tab inside
   * a strict Zero-External-Network Denial transaction (CDP Fetch.requestPaused).
   * Does NOT affect generic remote storefront reload or normal theme.qa_validate.
   */
  async reloadZeroNetwork(
    target: BrowserTarget,
    explicitTabId?: string
  ): Promise<{
    reloaded: boolean;
    target: BrowserTarget;
    blockedUrls: string[];
    blockedCount: number;
    verifiedOffline: boolean;
  }> {
    const tabId = this.resolveTargetTab(target, explicitTabId, 'lifecycle');

    // Local-origin guard: verify current tab URL is an allowed local origin before executing zero-network reload
    let currentUrl: string | undefined;
    try {
      const tabs = typeof this.host.getTabList === 'function' ? this.host.getTabList() : [];
      const match = Array.isArray(tabs) ? tabs.find((t: any) => t && typeof t === 'object' && t.id === tabId) : undefined;
      if (match && typeof (match as any).url === 'string') {
        currentUrl = (match as any).url;
      } else if (typeof this.host.evalJs === 'function') {
        currentUrl = String(await this.host.evalJs('window.location.href', tabId) || '') || undefined;
      }
    } catch {}

    if (!currentUrl) {
      throw new CapabilityError('INVALID_ARGUMENT', `Unable to determine current URL for zero-network reload on tab "${tabId}"`);
    }

    const urlClassification = classifyNetworkUrl(currentUrl);
    if (urlClassification.action !== 'allow') {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        `Zero-network reload is restricted to verified local origins (localhost, 127.0.0.1, file). Target tab URL "${currentUrl}" is an external domain.`
      );
    }

    const dbg = typeof this.host.getTabDebugger === 'function' ? this.host.getTabDebugger(tabId) : undefined;
    if (!dbg) {
      throw new CapabilityError(
        'CAPABILITY_NOT_FOUND',
        `CDP Debugger interface is not available for zero-network reload on tab "${tabId}"`
      );
    }

    const { result, blockedUrls } = await withZeroNetworkDenialTransaction(dbg, async () => {
      const reloaded = typeof this.host.reloadAndWait === 'function'
        ? await this.host.reloadAndWait(tabId)
        : await this.host.reload(tabId);
      if (!reloaded) {
        throw new CapabilityError('TARGET_STALE', 'Zero-network reload failed before a load-complete document was available');
      }
      return reloaded;
    });

    const docGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : (target.documentGeneration || 1);

    return {
      reloaded: result,
      target: { ...target, tabId, documentGeneration: docGen },
      blockedUrls,
      blockedCount: blockedUrls.length,
      verifiedOffline: blockedUrls.length === 0,
    };
  }

  async dom(target: BrowserTarget, runId: string, attemptId: string, selector?: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile'): Promise<ArtifactRef | string> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    return this.passivePool.execute(tabId, async () => {
      const html = await this.host.getDom(selector, tabId, paneId);
      return this.artifacts ? await this.stageArtifact({ kind: 'dom', mime: 'text/html', data: html, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 }) : limit(html, 8 * 1024 * 1024);
    });
  }
  async dumpDom(
    target: BrowserTarget,
    outputPath: string,
    options?: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; clean?: boolean; stripLivewire?: boolean; materialize?: boolean }
  ): Promise<{ path: string; byteCount: number; nodeCount: number; tabId: string }> {
    const tabId = this.resolveTargetTab(target, options?.tabId);
    return this.passivePool.execute(tabId, async () => {
      if (options?.materialize !== false) {
        let materialization: unknown;
        try {
          materialization = await this.host.evalJs(buildReferenceMaterializationScript(), tabId, options?.paneId, false, REFERENCE_MATERIALIZATION_BOUND_MS);
        } catch (error) {
          throw new CapabilityError('REFERENCE_MATERIALIZATION_INCOMPLETE', `DOM export materialization failed on tab '${tabId}': ${error instanceof Error ? error.message : String(error)}`, { tabId, cause: 'eval-failed' });
        }
        if (!materialization || typeof materialization !== 'object' || !('materialized' in materialization) || materialization.materialized !== true) {
          throw new CapabilityError('REFERENCE_MATERIALIZATION_INCOMPLETE', `DOM export materialization did not complete on tab '${tabId}'; no file was written`, { tabId, cause: 'walk-empty' });
        }
      }
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

  /**
   * Canonical reference capture: bring a live page into the state a comparison
   * will actually rasterize (lazily-mounted content materialized, then settled),
   * then stage the settled DOM and, on request, a viewport screenshot. A DOM
   * staged before this call describes a page the comparator never sees.
   */
  async referenceCapture(
    target: BrowserTarget,
    runId: string,
    attemptId: string,
    params: { tabId?: string; paneId?: 'desktop' | 'mobile'; selector?: string; screenshot?: boolean; format?: 'png' | 'jpeg'; quality?: number } = {},
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const tabId = this.resolveTargetTab(target, params.tabId);
    const effectivePane = params.paneId || 'desktop';
    // One pool slot at a time: the pool counts concurrent operations per tab and
    // refuses above its ceiling, so a reference capture must not hold a slot
    // while calling primitives that take their own.
    const materializationProbe = await this.passivePool.execute(tabId, async () => {
      await this.assertRenderSurface(tabId, effectivePane, 'anti.reference.capture');
      // The walk declares its own budget, so the in-page execution guard has to
      // be told about it: a caller-side race alone would report a bound the
      // script was never allowed to reach.
      const probe = await raceWithTimeout(
        this.host.evalJs(buildReferenceMaterializationScript(), tabId, params.paneId, false, REFERENCE_MATERIALIZATION_BOUND_MS)
          .then((raw) => ({ walked: raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null, evalError: undefined as string | undefined }))
          .catch((err: unknown) => ({ walked: null, evalError: err instanceof Error ? err.message : String(err) })),
        REFERENCE_MATERIALIZATION_BOUND_MS,
        () => null
      );
      return probe;
    });
    if (!materializationProbe) {
      throw new CapabilityError('REFERENCE_MATERIALIZATION_INCOMPLETE', `Materialization walk did not complete on tab '${tabId}' within ${REFERENCE_MATERIALIZATION_BOUND_MS}ms; a DOM staged from this tab would describe an unmounted page`, {
        tabId,
        paneId: effectivePane,
        cause: 'walk-timeout',
      });
    }
    if (!materializationProbe.walked) {
      throw new CapabilityError('REFERENCE_MATERIALIZATION_INCOMPLETE', `Materialization walk on tab '${tabId}' returned no result${materializationProbe.evalError ? `: ${materializationProbe.evalError}` : ''}; a DOM staged from this tab would describe an unmounted page`, {
        tabId,
        paneId: effectivePane,
        cause: materializationProbe.evalError ? 'eval-failed' : 'walk-empty',
        ...(materializationProbe.evalError ? { evalError: materializationProbe.evalError } : {}),
      });
    }
    const materialization = materializationProbe.walked;
    const reportedHref = typeof materialization.href === 'string' && materialization.href.length > 0 ? materialization.href : undefined;
    if (!reportedHref) {
      // The page is the only authority on its own identity: the strip-only tab
      // list cannot see offscreen agent tabs, and a reference whose origin is
      // unknown cannot be compared against anything.
      throw new CapabilityError('REFERENCE_MATERIALIZATION_INCOMPLETE', `Materialization on tab '${tabId}' returned no document identity (location.href); refusing to stage a reference that cannot name its own source`, {
        tabId,
        paneId: effectivePane,
        cause: 'identity-unavailable',
      });
    }
    const settle = await this.settleCapture(tabId, effectivePane, undefined, { signal });
    if (settle.settleComplete !== true) {
      throw new CapabilityError('SETTLE_INCOMPLETE', `Reference settle barrier did not complete on tab '${tabId}' (gates: network=${settle.gates.network}, fonts=${settle.gates.fonts}, images=${settle.gates.images}, dom=${settle.gates.dom}); no reference was staged`, {
        tabId,
        paneId: effectivePane,
        gates: settle.gates,
      });
    }
    // The staged DOM is only meaningful if this tab still describes a laid-out
    // document at the moment the reference is handed back, so this runs before
    // anything is staged: a collapsed surface must not leave an artefact behind.
    const settledSurface = await this.passivePool.execute(tabId, () => this.assertRenderSurface(tabId, effectivePane, 'anti.reference.capture'));
    const domRef = await this.dom(target, runId, attemptId, params.selector, tabId, params.paneId);
    const screenshotEnvelope = params.screenshot === false
      ? null
      : await this.screenshot(target, runId, attemptId, tabId, params.paneId, { format: params.format || 'png', quality: params.quality });
    return {
      ok: true,
      tabId,
      paneId: effectivePane,
      url: reportedHref,
      surface: settledSurface ?? null,
      materialization,
      settleComplete: settle.settleComplete,
      settle,
      domRef,
      screenshotRef: screenshotEnvelope ? screenshotEnvelope.artifactRef : null,
      screenshotReceipt: screenshotEnvelope ? screenshotEnvelope.receipt : null,
    };
  }

  /**
   * Refuses to start bounded render work on a tab whose renderer has no laid-out
   * surface. Fail-closed by design: a 0x0 surface never completes a raster, so
   * the capability would consume its whole bound before the caller learned the
   * tab cannot render. Returns the measured surface so a caller can reuse it as
   * its pre-capture baseline.
   */
  private async assertRenderSurface(
    tabId: string,
    paneId: 'desktop' | 'mobile' | undefined,
    operation: string,
    allowDegraded = false
  ): Promise<RenderSurfaceSnapshot | undefined> {
    if (typeof this.host.readRenderSurface !== 'function') return undefined;
    let snapshot: RenderSurfaceSnapshot | undefined;
    try {
      snapshot = await this.host.readRenderSurface(tabId, paneId, RENDER_SURFACE_PROBE_BOUND_MS);
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : undefined;
      if (code === 'TARGET_BUSY_DRAINING') throw err;
      if (allowDegraded) return undefined;
      throw new CapabilityError(
        'NO_RENDER_SURFACE',
        `${operation} cannot run on tab '${tabId}': the render surface could not be measured (${err instanceof Error ? err.message : String(err)})`,
        { tabId, paneId, operation, cause: classifyRenderSurfaceCause(undefined) }
      );
    }
    if (snapshot && (!Number.isFinite(snapshot.vw) || !Number.isFinite(snapshot.vh) || snapshot.vw < 1 || snapshot.vh < 1)) {
      if (allowDegraded) return snapshot;
      const healed = await this.reapplyVerifiedGeometry(tabId, paneId, snapshot);
      if (healed) return healed;
      const known = this.verifiedTabGeometry.get(tabId);
      const offscreen = this.host.isTabOffscreen ? this.host.isTabOffscreen(tabId) : undefined;
      throw new CapabilityError(
        'NO_RENDER_SURFACE',
        `${operation} cannot run on tab '${tabId}' pane '${paneId ?? 'desktop'}': the tab reports no laid-out surface (${snapshot.vw}x${snapshot.vh} CSS px, readyState '${snapshot.readyState}', hidden ${snapshot.hidden}, cause ${classifyRenderSurfaceCause(snapshot)})` +
          (known ? `, and re-applying its verified ${known.width}x${known.height} geometry did not restore one` : '') +
          (offscreen === true ? '; this tab renders offscreen and is never laid out in the window' : '') +
          '. To inspect this tab, first read its live viewport with anti.browser.get_viewport on an attached tab. Note that anti.browser.set_viewport applies a persistent device-emulation override (use it only when a specific device size is genuinely required).',
        {
          tabId,
          paneId,
          operation,
          observedWidth: snapshot.vw,
          observedHeight: snapshot.vh,
          readyState: snapshot.readyState,
          documentHidden: snapshot.hidden,
          cause: classifyRenderSurfaceCause(snapshot),
          ...(offscreen !== undefined ? { offscreen } : {}),
          ...(known ? { verifiedGeometry: known } : {}),
          activationCandidates: this.activationCandidates(tabId),
        }
      );
    }
    return snapshot;
  }

  /**
   * Bounded geometry assertion for a tab whose surface measured zero. Re-applies
   * the geometry this session already verified for that tab, then re-probes once:
   * only a measured surface is returned, so a healed view is never assumed.
   */
  private async reapplyVerifiedGeometry(
    tabId: string,
    paneId: 'desktop' | 'mobile' | undefined,
    snapshot: RenderSurfaceSnapshot
  ): Promise<RenderSurfaceSnapshot | undefined> {
    const known = this.verifiedTabGeometry.get(tabId);
    if (!known || typeof this.host.setViewportSize !== 'function' || typeof this.host.readRenderSurface !== 'function') return undefined;

    // Gate re-application on the tab not having positively left custom mode: only a
    // reported preset that is not `custom-<w>x<h>` (e.g. the user picked a real device
    // preset or Responsive) invalidates the cached geometry. A host that reports no
    // preset id keeps the legacy heal instead of losing the recovery path.
    const sessionRecords = this.host.getSessionTabList ? this.host.getSessionTabList(tabId) : [];
    const records = sessionRecords.length > 0 ? sessionRecords : (this.host.getTabList ? this.host.getTabList() : []);
    const tab = (records || []).find((t: unknown) => isTabRecord(t) && t.id === tabId) as (AntiFanTab & { customViewport?: { width: number; height: number; mobile?: boolean }; attached?: boolean }) | undefined;
    const presetId = tab?.devicePresetId;
    const isCustom = typeof presetId !== 'string' || presetId.length === 0 || /^custom-\d+x\d+$/.test(presetId);
    if (!isCustom) {
      this.verifiedTabGeometry.delete(tabId);
      return undefined;
    }
    try {
      await this.host.setViewportSize({ width: known.width, height: known.height, mobile: known.mobile, tabId });
      const healed = await this.host.readRenderSurface(tabId, paneId, RENDER_SURFACE_PROBE_BOUND_MS);
      if (healed && Number.isFinite(healed.vw) && Number.isFinite(healed.vh) && healed.vw >= 1 && healed.vh >= 1) {
        console.warn(`[browser-port] Tab ${tabId} measured ${snapshot.vw}x${snapshot.vh}; re-applied verified ${known.width}x${known.height} geometry`);
        return healed;
      }
    } catch {
      // An unmeasurable tab stays unmeasurable: fall through to the refusal.
    }
    return undefined;
  }

  /**
   * Tabs this session may activate instead of the one that just failed. Prefers
   * the session's own records, which include the offscreen tabs the window strip
   * never renders, so the answer is never an unexplained empty list.
   */
  private activationCandidates(boundTabId: string): string[] {
    const sessionRecords = this.host.getSessionTabList ? this.host.getSessionTabList(boundTabId) : [];
    const records = sessionRecords.length > 0 ? sessionRecords : this.host.getTabList ? this.host.getTabList() : [];
    const ids = new Set<string>();
    for (const tab of records) {
      const id = (tab as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && id.length > 0 && id !== boundTabId) ids.add(id);
    }
    return [...ids];
  }

  /**
   * Activation is a claim about the window's active tab: a switch that did not
   * happen is a typed refusal naming why plus the tabs this session may activate
   * instead. A silent `switched: false` is what let a caller retry a tab that can
   * never activate — an offscreen agent-plane tab is never shown in the window.
   */
  private requireActivatedTab(targetId: string, boundTabId?: string): { switched: boolean; tabId: string } {
    if (this.host.switchTab && this.host.switchTab(targetId)) return { switched: true, tabId: targetId };
    const offscreen = this.host.isTabOffscreen ? this.host.isTabOffscreen(targetId) : undefined;
    const candidates = this.activationCandidates(boundTabId ?? targetId);
    throw new CapabilityError(
      'TARGET_NOT_ACTIVATABLE',
      `Tab '${targetId}' did not become the active tab${offscreen === true ? ': it renders offscreen and is never shown in the window' : ''}.` +
        (candidates.length > 0 ? ` Activate one of: ${candidates.join(', ')}.` : ' No other tab in this session can be activated.'),
      { tabId: targetId, ...(boundTabId ? { boundTabId } : {}), ...(offscreen !== undefined ? { offscreen } : {}), activationCandidates: candidates }
    );
  }

  /**
   * Canonical viewport/clip evidence capture. Uses the same verification capture
   * primitive as full-page evidence so every screenshot capability returns an
   * ArtifactRef plus a receipt that names the mode, backend, CSS/raster geometry,
   * DPR, and zoom. The host owns target activation and restore internally.
   */
  async screenshot(target: BrowserTarget, runId: string, attemptId: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile', options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }): Promise<EvidenceCaptureEnvelope> {
    if (options?.fullPage === true) {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        'browser.screenshot is viewport-only and rejects fullPage: true; use anti.screenshot.full_page for canonical full-page evidence'
      );
    }
    if (typeof this.host.captureVerificationScreenshot !== 'function') {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', "Host does not implement required 'captureVerificationScreenshot' canonical CDP interface");
    }
    const tabId = this.resolveTargetTab(target, explicitTabId);
    const format = options?.format === 'jpeg' ? 'jpeg' : 'png';
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return this.passivePool.execute(tabId, async () => {
      await this.assertRenderSurface(tabId, paneId, 'anti.screenshot.viewport');
      const envelope = await this.host.captureVerificationScreenshot!(undefined, tabId, paneId, {
        format,
        quality: options?.quality,
        fullPage: false,
        // Inside the policy cancellation grace, so a transport cancel can never
        // orphan a CDP command that is still allowed to run.
        timeoutMs: VIEWPORT_CAPTURE_EXECUTION_BUDGET_MS,
      });
      if (!envelope || typeof envelope.data !== 'string' || envelope.data.length === 0) {
        throw new CapabilityError('TARGET_STALE', `Failed to capture non-empty viewport screenshot on tab '${tabId}' (document may still be rendering or target unavailable)`);
      }
      const buffer = Buffer.from(envelope.data, 'base64');
      if (buffer.length === 0) {
        throw new CapabilityError('TARGET_STALE', `Failed to decode non-empty viewport screenshot buffer on tab '${tabId}'`);
      }
      const receipt = verificationCaptureReceipt(envelope);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const artifactRef = this.artifacts
        ? await this.stageArtifact({
            kind: 'screenshot',
            mime,
            data: buffer,
            runId,
            attemptId,
            projectId: target.projectId,
            workspaceId: target.workspaceId,
            maxBytes: 8 * 1024 * 1024,
            overflowMode: 'reject',
          })
        : limit(envelope.data, 8 * 1024 * 1024);
      return { ok: true, artifactRef, receipt, sha256, byteLength: buffer.length };
    });
  }
  /**
   * Canonical full-page evidence capture: one bounded CDP full-page screenshot
   * staged through the canonical artifact path, with the evidence lease token
   * echoed when the run is leased. Never a partial success.
   */
  async screenshotFullPage(
    target: BrowserTarget,
    runId: string,
    attemptId: string,
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile',
    options?: { leaseToken?: string; signal?: AbortSignal; timeoutMs?: number; expectedUrl?: string | null }
  ): Promise<Record<string, unknown>> {
    if (typeof this.host.captureVerificationScreenshot !== 'function') {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', "Host does not implement required 'captureVerificationScreenshot' canonical CDP interface");
    }
    const tabId = this.resolveTargetTab(target, explicitTabId);
    const effectivePane = paneId || 'desktop';
    // Preflight before the capture budget exists, and keep the measured surface as
    // the baseline the post-failure restore has to return the tab to.
    const surfaceBefore = await this.assertRenderSurface(tabId, effectivePane, 'anti.screenshot.full_page');
    const executionBudgetMs = options?.timeoutMs ?? FULL_PAGE_CAPTURE_EXECUTION_BUDGET_MS;
    const budget = new CompareBudget({
      signal: options?.signal,
      executionBudgetMs,
      cleanupBudgetMs: FULL_PAGE_CAPTURE_CLEANUP_BUDGET_MS,
    });
    return budget.run(
      'full-page capture',
      () =>
        this.passivePool.execute(tabId, async () => {
          try {
            return await this.captureFullPageEnvelope({ target, tabId, effectivePane, runId, attemptId, budget, leaseToken: options?.leaseToken, expectedUrl: options?.expectedUrl });
          } catch (err) {
            if (isViewportRestoreFailure(err)) {
              // The capture left the layout viewport where it could not prove it
              // restored it. Recovery gets the baseline so the target is released
              // only if a post-drain restore actually succeeds; the bytes are
              // never returned either way, because their geometry is unproven.
              const reason = err instanceof Error ? err.message : String(err);
              const details = err instanceof CaptureError ? err.details : undefined;
              const entry = this.quarantineTargetEntry({
                tabId,
                paneId: effectivePane,
                reason,
                restoreGeometry: surfaceBefore
                  ? { width: surfaceBefore.vw, height: surfaceBefore.vh, scrollX: surfaceBefore.scrollX, scrollY: surfaceBefore.scrollY }
                  : undefined,
              });
              const receipt = await this.awaitQuarantineReceipt(entry, Math.min(12_000, FULL_PAGE_CAPTURE_CLEANUP_BUDGET_MS));
              const settled = receipt ?? entry.recovery;
              throw new CapabilityError('CAPTURE_VIEWPORT_NOT_RESTORED', reason, {
                tabId,
                paneId: effectivePane,
                quarantined: settled?.ok !== true,
                ...(details ?? {}),
                recovery: settled,
              });
            }
            // A dispatched Page.captureScreenshot that never settles keeps the
            // target quarantined until a typed recovery receipt lands. The
            // recovery drains the transport and then proves the capture geometry
            // was restored, so a poisoned viewport cannot be handed back as usable.
            if (isTargetDrainFailure(err)) {
              const reason = `Page.captureScreenshot did not settle within its bound on full-page tab '${tabId}'`;
              const entry = this.quarantineTargetEntry({
                tabId,
                paneId: effectivePane,
                reason,
                restoreGeometry: surfaceBefore
                  ? { width: surfaceBefore.vw, height: surfaceBefore.vh, scrollX: surfaceBefore.scrollX, scrollY: surfaceBefore.scrollY }
                  : undefined,
              });
              const receipt = await this.awaitQuarantineReceipt(entry, Math.min(12_000, FULL_PAGE_CAPTURE_CLEANUP_BUDGET_MS));
              const transaction = receipt?.viewportTransaction ?? entry.recovery?.viewportTransaction;
              if (transaction && !transaction.restored) {
                const message = `Full-page capture on tab '${tabId}' left the layout viewport at ${transaction.after ? `${transaction.after.width}x${transaction.after.height}` : 'an unmeasurable size'} (expected ${surfaceBefore ? `${surfaceBefore.vw}x${surfaceBefore.vh}` : 'unknown'})`;
                throw new CapabilityError('CAPTURE_VIEWPORT_NOT_RESTORED', message, {
                  tabId,
                  paneId: effectivePane,
                  quarantined: true,
                  expectedWidth: surfaceBefore?.vw,
                  expectedHeight: surfaceBefore?.vh,
                  observedWidth: transaction.after?.width,
                  observedHeight: transaction.after?.height,
                  attempts: transaction.attempts,
                  causeCapture: { code: 'TARGET_BUSY_DRAINING', message: reason },
                  recovery: receipt ?? entry.recovery,
                });
              }
              throw new CapabilityError('TARGET_BUSY_DRAINING', reason, {
                tabId,
                paneId: effectivePane,
                quarantined: (receipt ?? entry.recovery)?.ok !== true,
                recovery: receipt ?? entry.recovery,
                ...(transaction ? { viewportTransaction: transaction } : {}),
              });
            }
            throw err;
          }
        }),
      executionBudgetMs
    ).catch(async (err: unknown) => {
      const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
      if (code !== 'EXECUTION_TIMEOUT') throw err;
      // The execution budget can abandon a capture whose CDP command is still in
      // flight, and the inner classification never runs when it does. The target
      // still needs the recovery a settled failure gets: without the drain, the
      // next probe on this tab meets a renderer that cannot answer.
      const reason = `Full-page capture on tab '${tabId}' did not settle inside its execution budget and was abandoned`;
      const entry = this.quarantineTargetEntry({
        tabId,
        paneId: effectivePane,
        reason,
        restoreGeometry: surfaceBefore
          ? { width: surfaceBefore.vw, height: surfaceBefore.vh, scrollX: surfaceBefore.scrollX, scrollY: surfaceBefore.scrollY }
          : undefined,
      });
      const receipt = await this.awaitQuarantineReceipt(entry, Math.min(12_000, FULL_PAGE_CAPTURE_CLEANUP_BUDGET_MS));
      const settled = receipt ?? entry.recovery;
      const transaction = settled?.viewportTransaction;
      if (transaction && !transaction.restored) {
        throw new CapabilityError('CAPTURE_VIEWPORT_NOT_RESTORED', `Full-page capture on tab '${tabId}' was abandoned by its budget and left the layout viewport at ${transaction.after ? `${transaction.after.width}x${transaction.after.height}` : 'an unmeasurable size'}`, {
          tabId,
          paneId: effectivePane,
          quarantined: true,
          expectedWidth: surfaceBefore?.vw,
          expectedHeight: surfaceBefore?.vh,
          observedWidth: transaction.after?.width,
          observedHeight: transaction.after?.height,
          attempts: transaction.attempts,
          causeCapture: { code: 'EXECUTION_TIMEOUT', message: err instanceof Error ? err.message : String(err) },
          recovery: settled,
        });
      }
      throw new CapabilityError('TARGET_BUSY_DRAINING', reason, {
        tabId,
        paneId: effectivePane,
        quarantined: settled?.ok !== true,
        causeCapture: { code: 'EXECUTION_TIMEOUT', message: err instanceof Error ? err.message : String(err) },
        recovery: settled,
      });
    });
  }

  /**
   * Geometry restore inside target recovery: run after the transport drain, the
   * only point where CDP commands are admissible again. Absent a host seam the
   * capture geometry is untracked, which is reported as not restored.
   */
  private async restoreGeometryForRecovery(
    tabId: string,
    paneId: 'desktop' | 'mobile',
    restoreGeometry: { width: number; height: number; scrollX: number; scrollY: number } | undefined
  ): Promise<CaptureViewportTransaction | undefined> {
    if (!restoreGeometry) return undefined;
    const before = { ...restoreGeometry };
    if (typeof this.host.reapplyTabGeometry !== 'function') {
      return { before, after: null, restored: false, attempts: 0 };
    }
    try {
      return await this.host.reapplyTabGeometry(tabId, paneId, restoreGeometry);
    } catch {
      return { before, after: null, restored: false, attempts: 1 };
    }
  }

  private async captureFullPageEnvelope(args: {
    target: BrowserTarget;
    tabId: string;
    effectivePane: 'desktop' | 'mobile';
    runId: string;
    attemptId: string;
    budget: CompareBudget;
    leaseToken?: string;
    expectedUrl?: string | null;
  }): Promise<Record<string, unknown>> {
    const { target, tabId, effectivePane, runId, attemptId, budget, leaseToken, expectedUrl } = args;
    const observedUrl = await this.getLiveTabUrl(tabId);
    const redirectChain = this.getTabRedirectChain(tabId);
    const routeCheck = checkRouteIdentity(expectedUrl, observedUrl, redirectChain);
    if (!routeCheck.ok) {
      throw new CapabilityError(
        routeCheck.status,
        `Route identity assertion failed for full-page capture on tab '${tabId}': ${routeCheck.reason || routeCheck.status} (requested: ${routeCheck.requestedUrl || 'none'}, observed: ${routeCheck.observedUrl}, redirects: ${redirectChain.join(' -> ') || 'none'})`
      );
    }
    const bound = Math.max(1, Math.min(budget.remainingMs, FULL_PAGE_CAPTURE_EXECUTION_BUDGET_MS, 60_000));
    const envelope = await budget.run(
      'Page.captureScreenshot(full-page)',
      () =>
        this.host.captureVerificationScreenshot!(undefined, tabId, effectivePane, {
          format: 'png',
          fullPage: true,
          timeoutMs: bound,
        }),
      bound + 3_000
    );
    if (envelope) {
      envelope.expectedUrl = expectedUrl ?? null;
      envelope.expectationMarker = routeCheck.status === 'URL_EXPECTATION_MISSING' ? 'URL_EXPECTATION_MISSING' : undefined;
      envelope.missingExpectation = routeCheck.status === 'URL_EXPECTATION_MISSING' ? true : undefined;
      envelope.routeAssertion = routeCheck;
    }
    // The capture moves the layout viewport and must put it back. An envelope
    // that admits it could not (or was not allowed to because the transport was
    // draining) is not evidence: the tab's geometry is unproven, so the capture
    // fails closed instead of returning bytes whose geometry nobody can vouch for.
    const transaction = envelope?.viewportTransaction;
    if (transaction && !transaction.restored) {
      const deferredNote = transaction.deferred === true ? ' (restore deferred: transport was draining)' : '';
      throw new CaptureError(
        'CAPTURE_VIEWPORT_NOT_RESTORED',
        `Full-page capture on tab '${tabId}' moved the layout viewport and did not restore it${deferredNote}`,
        {
          tabId,
          paneId: effectivePane,
          expectedWidth: transaction.before?.width,
          expectedHeight: transaction.before?.height,
          observedWidth: transaction.after?.width,
          observedHeight: transaction.after?.height,
          attempts: transaction.attempts,
          cause: 'capture-restore-unproven',
        }
      );
    }
    if (!envelope || !envelope.data || envelope.data.length === 0) {
      throw new CapabilityError('TARGET_STALE', `Failed to capture non-empty full-page verification screenshot on tab '${tabId}'`);
    }
    if (envelope.captureMode !== 'full-page') {
      throw new CapabilityError('INTEGRITY_COMPROMISED', `Full-page capture reported mode '${envelope.captureMode}' on tab '${tabId}'`);
    }
    const bytes = Buffer.from(envelope.data, 'base64');
    if (bytes.length === 0) {
      throw new CapabilityError('TARGET_STALE', `Failed to decode non-empty full-page screenshot buffer on tab '${tabId}'`);
    }
    const receipt = verificationCaptureReceipt(envelope);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const artifactRef = this.artifacts
      ? await budget.run(
          'stage full-page',
          async () =>
            this.artifacts!.stage({
              kind: 'screenshot',
              mime: 'image/png',
              data: bytes,
              runId,
              attemptId,
              projectId: target.projectId,
              workspaceId: target.workspaceId,
              maxBytes: 32 * 1024 * 1024,
              leaseToken,
              overflowMode: 'reject',
            }),
          STAGE_BOUND_MS
        )
      : limit(envelope.data, 32 * 1024 * 1024);
    return {
      ok: true,
      artifactRef,
      receipt,
      sha256,
      byteLength: bytes.length,
      routeAssertion: routeCheck,
      ...(expectedUrl !== undefined ? { expectedUrl } : {}),
      ...(routeCheck.status === 'URL_EXPECTATION_MISSING' ? { expectationMarker: 'URL_EXPECTATION_MISSING', missingExpectation: true } : {}),
      ...(leaseToken ? { leaseToken } : {}),
    };
  }
  async eval(target: BrowserTarget, expression: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile', options?: { requireRenderSurface?: boolean; allowDegradedSurface?: boolean }): Promise<unknown> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    if (!expression.trim()) throw new CapabilityError('INVALID_ARGUMENT', 'JavaScript expression is required');
    return this.passivePool.execute(tabId, async () => {
      if (options?.requireRenderSurface === true) {
        await this.assertRenderSurface(tabId, paneId, 'anti.browser.evaluate', options.allowDegradedSurface === true);
      }
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
      const readIdentity = (): ObservationIdentity => ({
        browserEpoch: this.host.getBrowserEpoch ? this.host.getBrowserEpoch() : target.browserEpoch,
        documentGeneration: this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : (target.documentGeneration || 1),
        mutationRevision: this.host.getMutationRevision ? this.host.getMutationRevision(tabId) : 1,
      });
      const initialIdentity = readIdentity();
      const assertCoherent = (): void => {
        const current = readIdentity();
        if (current.browserEpoch !== initialIdentity.browserEpoch || current.documentGeneration !== initialIdentity.documentGeneration) {
          throw new CapabilityError('TARGET_STALE', 'Browser or document identity changed during observation');
        }
        if (!sameObservationIdentity(current, initialIdentity)) {
          throw new CapabilityError('INTEGRITY_COMPROMISED', 'DOM mutation revision changed during observation');
        }
      };
      const startAll = Date.now();
      const perComponent: Record<string, { start: number; end: number }> = {};
      const sequence: number[] = [];
      const buffered: {
        dom?: string;
        screenshot?: Buffer;
        snapshot?: string;
        diagnostics?: { console: unknown[]; failures: unknown[] };
      } = {};

      for (let i = 0; i < requested.length; i++) {
        const comp = requested[i]!;
        sequence.push(i + 1);
        const compStart = Date.now();

        if (comp === 'dom') {
          buffered.dom = await this.host.getDom(params.selector, tabId, effectivePane);
        } else if (comp === 'screenshot') {
          const base64 = await this.host.captureScreenshot(undefined, tabId, effectivePane);
          if (!base64 || base64.length === 0) {
            throw new CapabilityError('TARGET_STALE', `Failed to capture non-empty screenshot component for observe on tab '${tabId}'`);
          }
          buffered.screenshot = Buffer.from(base64, 'base64');
          if (buffered.screenshot.length === 0) {
            throw new CapabilityError('TARGET_STALE', `Failed to decode screenshot component for observe on tab '${tabId}'`);
          }
        } else if (comp === 'snapshot') {
          const snapshotText = this.host.agentSnapshot ? await this.host.agentSnapshot(tabId, effectivePane) : '';
          buffered.snapshot = limit(snapshotText, 128 * 1024);
        } else if (comp === 'diagnostics') {
          buffered.diagnostics = this.host.getDiagnostics ? this.host.getDiagnostics(tabId) : { console: [], failures: [] };
        }

        perComponent[comp] = { start: compStart, end: Date.now() };
        assertCoherent();
      }

      assertCoherent();
      const resultComponents: BrowserObserveResult['components'] = {};
      if (buffered.dom !== undefined) {
        resultComponents.dom = this.artifacts
          ? await this.stageArtifact({ kind: 'dom', mime: 'text/html', data: buffered.dom, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 })
          : limit(buffered.dom, 512 * 1024);
      }
      if (buffered.screenshot !== undefined) {
        resultComponents.screenshot = this.artifacts
          ? await this.stageArtifact({ kind: 'screenshot', mime: 'image/png', data: buffered.screenshot, runId, attemptId, projectId: target.projectId, workspaceId: target.workspaceId, maxBytes: 8 * 1024 * 1024 })
          : limit(buffered.screenshot.toString('base64'), 512 * 1024);
      }
      if (buffered.snapshot !== undefined) resultComponents.snapshot = buffered.snapshot;
      if (buffered.diagnostics !== undefined) resultComponents.diagnostics = buffered.diagnostics;

      const endAll = Date.now();
      return {
        target: {
          tabId,
          paneId: effectivePane,
          browserEpoch: initialIdentity.browserEpoch,
          documentGeneration: initialIdentity.documentGeneration,
          mutationRevision: initialIdentity.mutationRevision,
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
  openTab(options: { url?: string; activate?: boolean; ephemeral?: boolean; offscreen?: boolean } = {}, context?: { target?: BrowserTarget }): { tabId: string } {
    if (!this.host.createTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'createTab is not supported by host');
    const boundTabId = context?.target?.tabId;
    if (boundTabId && this.host.getManagedTabIds) {
      const currentTabs = this.host.getManagedTabIds(boundTabId);
      if (currentTabs && currentTabs.size >= 10) {
        throw new CapabilityError('POLICY_DENIED', 'Terminal tab limit reached (maximum 10 tabs per session). Please close unused tabs.');
      }
    }
    // Phase 2 (step 11): forward the offscreen option so dedicated agent tabs keep
    // rendering without foregrounding the user's visible surface.
    const tabId = this.host.createTab(options.url || 'about:blank', options.activate ?? false, {
      ephemeral: options.ephemeral,
      offscreen: options.offscreen,
    });
    if (boundTabId && this.host.adoptChildTab) {
      // A tab this session cannot own is a tab it can never list, address or
      // close: close it and fail instead of handing back a leak.
      const adopted = this.host.adoptChildTab(boundTabId, tabId);
      if (adopted === false) {
        this.host.closeTab?.(tabId);
        throw new CapabilityError('POLICY_DENIED', `Tab '${tabId}' could not be adopted into session '${boundTabId}' (session tab quota reached); the tab was closed instead of leaking outside the session`, {
          tabId,
          boundTabId,
        });
      }
    }
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
  rebindTarget(options: { tabId?: string } = {}, target?: BrowserTarget): { success: boolean; tabId: string; documentGeneration: number; browserEpoch: number; url?: string; title?: string } {
    let effectiveTabId = options.tabId && typeof options.tabId === 'string' ? options.tabId.trim() : (target?.tabId ? target.tabId.trim() : '');
    if (this.host.getTabList) {
      const tabs = (this.host.getTabList() || []).filter(isTabRecord);
      if (!effectiveTabId && tabs.length > 0 && tabs[0]?.id) {
        effectiveTabId = tabs[0].id;
      }
      if (!effectiveTabId) {
        throw new CapabilityError('TARGET_REQUIRED', 'Browser target tabId is required to rebind');
      }
      const matched = tabs.find(t => t.id === effectiveTabId);
      if (!matched) {
        throw new CapabilityError('TARGET_STALE', `Target tab '${effectiveTabId}' no longer exists`, {
          tabId: effectiveTabId,
          canRebind: false,
        });
      }
      const rawLiveDocGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(effectiveTabId) : target?.documentGeneration;
      const liveDocGen = typeof rawLiveDocGen === 'number' && Number.isFinite(rawLiveDocGen) && rawLiveDocGen > 0
        ? Math.floor(rawLiveDocGen)
        : (typeof target?.documentGeneration === 'number' && target.documentGeneration > 0 ? target.documentGeneration : 1);
      const epoch = typeof target?.browserEpoch === 'number' && Number.isFinite(target.browserEpoch) && target.browserEpoch > 0
        ? Math.floor(target.browserEpoch)
        : 1;
      return {
        success: true,
        tabId: effectiveTabId,
        documentGeneration: liveDocGen,
        browserEpoch: epoch,
        url: matched.url,
        title: matched.title,
      };
    }
    if (!effectiveTabId) {
      throw new CapabilityError('TARGET_REQUIRED', 'Browser target tabId is required to rebind');
    }
    const rawLiveDocGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(effectiveTabId) : target?.documentGeneration;
    const liveDocGen = typeof rawLiveDocGen === 'number' && Number.isFinite(rawLiveDocGen) && rawLiveDocGen > 0
      ? Math.floor(rawLiveDocGen)
      : (typeof target?.documentGeneration === 'number' && target.documentGeneration > 0 ? target.documentGeneration : 1);
    const epoch = typeof target?.browserEpoch === 'number' && Number.isFinite(target.browserEpoch) && target.browserEpoch > 0
      ? Math.floor(target.browserEpoch)
      : 1;
    return {
      success: true,
      tabId: effectiveTabId,
      documentGeneration: liveDocGen,
      browserEpoch: epoch,
    };
  }
  closeTab(tabId: string, context?: { target?: BrowserTarget }): { closed: boolean; tabId: string; failoverTabId?: string } {
    if (!this.host.closeTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'closeTab is not supported by host');
    let targetId = tabId;
    if (typeof tabId === 'string' && (tabId.startsWith('#') || tabId.startsWith('@'))) {
      const list = (this.host.getTabList ? this.host.getTabList() : []).filter(isTabRecord);
      if (tabId.startsWith('#')) {
        const num = parseInt(tabId.slice(1), 10);
        const matchedTab = Number.isFinite(num) && num >= 1 && num <= list.length ? list[num - 1] : undefined;
        if (matchedTab?.id) {
          targetId = matchedTab.id;
        }
      } else {
        const lower = tabId.toLowerCase();
        const matched = list.find((t) => t.alias?.toLowerCase() === lower || `@${t.role?.toLowerCase()}` === lower);
        if (matched && matched.id) {
          targetId = matched.id;
        }
      }
    }
    const rawBoundId = context?.target?.tabId;
    let boundId = rawBoundId;
    if (rawBoundId && this.host.hasTab && !this.host.hasTab(rawBoundId) && this.host.getFailoverTargetTab) {
      const failover = this.host.getFailoverTargetTab(rawBoundId);
      if (failover && typeof failover === 'string' && failover.trim().length > 0) {
        boundId = failover.trim();
      }
    }

    if (boundId && targetId.trim() !== boundId.trim()) {
      const isAllowed = this.host.isTabAllowed ? this.host.isTabAllowed(boundId.trim(), targetId.trim()) : false;
      if (!isAllowed) {
        throw new CapabilityError('TARGET_MISMATCH', `Cannot close tab "${targetId}". This session is isolated to tab "${boundId}" and its managed tabs.`);
      }
    }
    const closed = Boolean(this.host.closeTab(targetId));
    if (closed) this.verifiedTabGeometry.delete(targetId);
    let failoverTabId: string | undefined;
    if (closed && rawBoundId && targetId.trim() === rawBoundId.trim() && this.host.getFailoverTargetTab) {
      const candidate = this.host.getFailoverTargetTab(targetId);
      if (
        candidate &&
        typeof candidate === 'string' &&
        candidate.trim().length > 0 &&
        (!this.host.hasTab || this.host.hasTab(candidate.trim()))
      ) {
        failoverTabId = candidate.trim();
      }
    }
    return { closed, tabId: targetId, failoverTabId };
  }

  switchTab(
    tabId: string,
    context: {
      target: BrowserTarget;
      attachmentId?: string;
      runId?: string;
      attemptId?: string;
      isAgent?: boolean;
      plane?: 'agent' | 'user' | string;
      [key: string]: unknown;
    }
  ): { switched: boolean; tabId: string } {
    if (!this.host.switchTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'switchTab is not supported by host');
    if (!context || !context.target) {
      throw new CapabilityError('TARGET_REQUIRED', 'Browser target is required to switch tab');
    }
    assertTarget(context.target);

    const targetRecord = typeof context.target === 'object' && context.target !== null ? (context.target as unknown as Record<string, unknown>) : undefined;
    const isAgentPlane = Boolean(
      context.attachmentId ||
      context.isAgent ||
      context.plane === 'agent' ||
      context['experimentId'] ||
      context['experiment'] ||
      (targetRecord && (
        targetRecord['isAgent'] ||
        targetRecord['plane'] === 'agent'
      ))
    );
    if (!tabId || typeof tabId !== 'string') {
      throw new CapabilityError('TARGET_MISMATCH', 'Cannot switch tab: tabId must be a non-empty string');
    }
    const rawId = tabId.trim();
    if (rawId.length === 0) {
      throw new CapabilityError('TARGET_MISMATCH', 'Cannot switch tab: tabId must be a non-empty string');
    }
    let targetId: string | undefined;
    if (this.host.resolveTargetTabId) {
      targetId = this.host.resolveTargetTabId(rawId);
    } else {
      if (typeof rawId === 'string' && (rawId.startsWith('#') || rawId.startsWith('@'))) {
        const list = (this.host.getTabList ? this.host.getTabList() : []).filter(isTabRecord);
        if (/^#\d+$/.test(rawId)) {
          const num = parseInt(rawId.slice(1), 10);
          const matchedTab = Number.isFinite(num) && num >= 1 && num <= list.length ? list[num - 1] : undefined;
          if (matchedTab?.id) {
            targetId = matchedTab.id;
          }
        } else if (rawId.startsWith('@')) {
          const lower = rawId.toLowerCase();
          const matched = list.find((t) => t.alias?.toLowerCase() === lower || `@${t.role?.toLowerCase()}` === lower);
          if (matched && matched.id) {
            targetId = matched.id;
          }
        }
      } else {
        const tabExists = this.host.hasTab
          ? this.host.hasTab(rawId)
          : Boolean(this.host.getTabList?.().some((tab: any) => tab?.id === rawId));
        if (tabExists) {
          targetId = rawId;
        }
      }
    }

    if (!targetId) {
      throw new CapabilityError('TARGET_MISMATCH', `Cannot switch to unknown tab '${tabId}'.`);
    }

    if (isAgentPlane) {
      // Owner decision (local single-user app): the agent plane may activate any
      // live, canonical tab this window has. No approval gate; the target already
      // resolved to a real tab id above and the transport rebinds the attachment
      // to it after the switch.
      return this.requireActivatedTab(targetId, context.target.tabId);
    }

    const boundId = context.target.tabId;
    if (targetId.trim() !== boundId.trim()) {
      const isAllowed = this.host.isTabAllowed ? this.host.isTabAllowed(boundId, targetId) : false;
      if (!isAllowed) {
        throw new CapabilityError(
          'TARGET_MISMATCH',
          `Cannot switch to tab '${tabId}'. This session is isolated to tab '${boundId}'.`
        );
      }
    }

    return this.requireActivatedTab(targetId, context.target.tabId);
  }

  diagnostics(tabId?: string, level?: number | string): { console: unknown[]; failures: unknown[] } {
    if (!this.host.getDiagnostics) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'getDiagnostics is not supported by host');
    return this.host.getDiagnostics(tabId, level);
  }

  async responsiveCheck(params?: { tabId?: string; selector?: string; customBreakpoints?: ResponsiveBreakpointOption[] } | string, target?: BrowserTarget): Promise<Record<string, unknown>> {
    if (!this.host.runResponsiveCheck) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'runResponsiveCheck is not supported by host');
    const opts = typeof params === 'string' ? { tabId: params } : (params || {});
    const effectiveTabId = this.resolveTargetTab(target, opts.tabId);
    return this.host.runResponsiveCheck({ ...opts, tabId: effectiveTabId });
  }

  async agentTrajectory(args: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.host.agentTrajectory) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentTrajectory is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return (await this.host.agentTrajectory!({ ...args, tabId })) as Record<string, unknown>;
    }, { tabId, signal });
  }

  async agentMove(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget, signal?: AbortSignal): Promise<{ moved: boolean }> {
    if (!this.host.agentMove) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentMove is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return { moved: await this.host.agentMove!({ ...args, tabId }) };
    }, { tabId, signal });
  }

  async agentClick(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget, signal?: AbortSignal): Promise<{ clicked: boolean }> {
    if (!this.host.agentClick) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentClick is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      const clicked = Boolean(await this.host.agentClick!({ ...args, tabId }));
      if (clicked) {
        this.bumpMutationRevision(tabId);
      }
      return { clicked };
    }, { tabId, signal });
  }

  async agentType(args: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget, signal?: AbortSignal): Promise<{ typed: boolean }> {
    if (!this.host.agentType) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentType is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      const typed = Boolean(await this.host.agentType!({ ...args, tabId }));
      if (typed) {
        this.bumpMutationRevision(tabId);
      }
      return { typed };
    }, { tabId, signal });
  }
  async keyboardPress(args: { key: string; modifiers?: string[]; tabId?: string }, target?: BrowserTarget, signal?: AbortSignal): Promise<{ success: boolean; key: string; modifiers: string[] }> {
    if (!this.host.sendKeyboardPress) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'sendKeyboardPress is not supported by host');
    if (!args || typeof args.key !== 'string' || args.key.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'key must be a non-empty string');
    }
    const effectiveTabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, effectiveTabId);
      try {
        const pressResult = await this.host.sendKeyboardPress!({ ...args, tabId: effectiveTabId });
        if (pressResult && pressResult.success) {
          this.bumpMutationRevision(effectiveTabId);
        }
        return pressResult;
      } catch (err: unknown) {
        if (err instanceof CapabilityError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Tab not found')) {
          throw new CapabilityError('CAPABILITY_NOT_FOUND', msg);
        }
        throw new CapabilityError('INVALID_ARGUMENT', msg);
      }
    }, { tabId: effectiveTabId, signal });
  }
  async agentScroll(args: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget, signal?: AbortSignal): Promise<{ scrolled: boolean }> {
    if (!this.host.agentScroll) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentScroll is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      const scrolled = await this.host.agentScroll!({ ...args, tabId });
      return { scrolled };
    }, { tabId, signal });
  }
  async agentHover(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget, signal?: AbortSignal): Promise<{ hovered: boolean }> {
    if (!this.host.agentHover) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentHover is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return { hovered: await this.host.agentHover!({ ...args, tabId }) };
    }, { tabId, signal });
  }

  async agentHighlight(args: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget, signal?: AbortSignal): Promise<{ highlighted: boolean }> {
    if (!this.host.agentHighlight) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentHighlight is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, tabId);
      return { highlighted: await this.host.agentHighlight!({ ...args, tabId }) };
    }, { tabId, signal });
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
  async sequence(args: { actions: Array<Record<string, unknown>>; tabId?: string; paneId?: 'desktop' | 'mobile'; stopOnError?: boolean }, target?: BrowserTarget, signal?: AbortSignal): Promise<unknown> {
    if (!this.host.executeActionSequence) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'executeActionSequence is not supported by host');
    if (!args || !Array.isArray(args.actions) || args.actions.length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'actions must be a non-empty array');
    }
    const effectiveTabId = this.resolveTargetTab(target, args.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, effectiveTabId);
      return await this.host.executeActionSequence!({ ...args, tabId: effectiveTabId });
    }, { tabId: effectiveTabId, signal });
  }

  async uploadFileInput(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget, signal?: AbortSignal): Promise<{ success: boolean; uploadedCount: number; reason?: string }> {
    if (!this.host.uploadFileInput) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'uploadFileInput is not supported by host');
    const effectiveTabId = this.resolveTargetTab(target, params.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, effectiveTabId);
      return this.host.uploadFileInput!({ ...params, tabId: effectiveTabId });
    }, { tabId: effectiveTabId, signal });
  }

  async dropFiles(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget, signal?: AbortSignal): Promise<{ success: boolean; droppedCount: number; reason?: string }> {
    if (!this.host.dropFiles) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'dropFiles is not supported by host');
    const effectiveTabId = this.resolveTargetTab(target, params.tabId, 'write');
    return this.viewportGate.withLock(async () => {
      this.revalidateTargetInsideLock(target, effectiveTabId);
      return this.host.dropFiles!({ ...params, tabId: effectiveTabId });
    }, { tabId: effectiveTabId, signal });
  }

  private revalidateTargetInsideLock(target?: BrowserTarget, tabId?: string): void {
    if (!target) return;
    if (tabId && this.host.getTabList) {
      const tabs = this.host.getTabList() || [];
      const exists = tabs.some((t: any) => t && typeof t === 'object' && t.id === tabId);
      if (!exists) {
        throw new CapabilityError('TARGET_STALE', `Target tab '${tabId}' no longer exists`, {
          tabId,
          canRebind: false,
        });
      }
    }
    const liveDocGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : target.documentGeneration;
    if (typeof target.documentGeneration === 'number' && typeof liveDocGen === 'number' && target.documentGeneration !== liveDocGen) {
      throw new CapabilityError(
        'TARGET_STALE',
        `Browser target document generation (${target.documentGeneration}) is stale compared to live document generation (${liveDocGen}) after acquiring viewport lock`,
        {
          tabId: tabId || target.tabId,
          targetDocumentGeneration: target.documentGeneration,
          liveDocumentGeneration: liveDocGen,
          canRebind: true,
        }
      );
    }
    const targetToCheck = target && tabId && target.tabId !== tabId ? { ...target, tabId } : target;
    if (this.host.isCurrentTarget && !this.host.isCurrentTarget(targetToCheck)) {
      throw new CapabilityError('TARGET_STALE', 'Browser target no longer matches current tab document after acquiring viewport lock', {
        tabId: targetToCheck.tabId,
        targetDocumentGeneration: target.documentGeneration,
        liveDocumentGeneration: liveDocGen,
        canRebind: true,
      });
    }
  }
  async setViewport(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string; reload?: boolean }, target?: BrowserTarget): Promise<{ success: boolean; width: number; height: number; mobile?: boolean; presetId: string; reloaded?: boolean; observedWidth?: number; observedHeight?: number; verified?: boolean }> {
    if (!this.host.setViewportSize) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'setViewportSize is not supported by host');
    if (typeof options.width !== 'number' || options.width <= 0 || typeof options.height !== 'number' || options.height <= 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'width and height must be positive numbers');
    }
    const effectiveTabId = this.resolveTargetTab(target, options.tabId);
    const hostResult = await this.host.setViewportSize({ ...options, tabId: effectiveTabId });
    const isStructured = typeof hostResult === 'object' && hostResult !== null;
    const ok = isStructured ? hostResult.success === true : Boolean(hostResult);
    if (!ok) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Failed to set viewport on tab ${effectiveTabId}`);
    let reloaded: boolean | undefined;
    if (options.reload) {
      if (isStructured) {
        if (hostResult.reloaded !== true) {
          throw new CapabilityError('CAPABILITY_NOT_FOUND', `Failed to reload tab ${effectiveTabId} after viewport resize`);
        }
        reloaded = true;
      } else {
        reloaded = true;
      }
    } else if (options.reload !== undefined) {
      reloaded = false;
    }
    // A viewport write is a claim about measured geometry: it is only reported as
    // applied once the tab measures the requested size, within the same bound.
    // Every probe is bounded by the remaining window, so the loop can never
    // outlive the confirmation budget. There is no unverified success path: a
    // host that cannot answer the geometry probe fails like any other tab.
    const deadline = Date.now() + VIEWPORT_CONFIRM_BOUND_MS;
    const mismatched = (m: { vw: number; vh: number }): boolean => Math.abs(m.vw - options.width) > 1 || Math.abs(m.vh - options.height) > 1;
    const probe = async (): Promise<{ vw: number; vh: number } | null> => {
      const remaining = Math.max(1, deadline - Date.now());
      return raceWithTimeout(
        (async (): Promise<{ vw: number; vh: number } | null> => {
          if (typeof this.host.readRenderSurface === 'function') {
            const surface = await this.host.readRenderSurface(effectiveTabId, undefined, remaining);
            if (surface && Number.isFinite(surface.vw) && Number.isFinite(surface.vh)) return { vw: surface.vw, vh: surface.vh };
          }
          if (typeof this.host.evalJs !== 'function') return null;
          const metrics = (await this.host.evalJs('({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })', effectiveTabId)) as { innerWidth?: number; innerHeight?: number } | null;
          if (!metrics || typeof metrics.innerWidth !== 'number' || typeof metrics.innerHeight !== 'number') return null;
          return { vw: metrics.innerWidth, vh: metrics.innerHeight };
        })().catch(() => null),
        remaining,
        () => null
      );
    };
    let observed: { vw: number; vh: number } | null = null;
    for (;;) {
      const attempt = await probe();
      if (attempt) observed = attempt;
      if (attempt && !mismatched(attempt)) break;
      if (Date.now() >= deadline) break;
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, Math.max(1, Math.min(100, deadline - Date.now())));
      await tick.promise;
    }
    if (!observed) {
      throw new CapabilityError('VIEWPORT_NOT_APPLIED', `Could not measure tab '${effectiveTabId}' after requesting ${options.width}x${options.height}`, {
        tabId: effectiveTabId,
        expectedWidth: options.width,
        expectedHeight: options.height,
        cause: 'unmeasurable',
      });
    }
    if (observed && mismatched(observed)) {
      throw new CapabilityError('VIEWPORT_NOT_APPLIED', `Tab '${effectiveTabId}' measures ${observed.vw}x${observed.vh} after requesting ${options.width}x${options.height}`, {
        tabId: effectiveTabId,
        expectedWidth: options.width,
        expectedHeight: options.height,
        observedWidth: observed.vw,
        observedHeight: observed.vh,
        cause: observed.vw < 1 || observed.vh < 1 ? 'zero-viewport' : 'geometry-mismatch',
      });
    }
    if (observed) this.verifiedTabGeometry.set(effectiveTabId, { width: observed.vw, height: observed.vh, mobile: options.mobile ?? (options.width < 768) });
    return {
      success: ok,
      width: options.width,
      height: options.height,
      mobile: options.mobile ?? (options.width < 768),
      presetId: `custom-${options.width}x${options.height}`,
      ...(options.reload !== undefined ? { reloaded } : {}),
      ...(observed ? { observedWidth: observed.vw, observedHeight: observed.vh } : {}),
      verified: Boolean(observed),
    };
  }
  async getViewport(
    options: { tabId?: string } = {},
    target?: BrowserTarget
  ): Promise<{
    tabId: string;
    presetId?: string;
    customViewport: { width: number; height: number; mobile?: boolean } | null;
    width: number;
    height: number;
    dpr: number;
    attached: boolean;
    active: boolean;
    cause?: string;
    detached?: boolean;
  }> {
    const effectiveTabId = this.resolveTargetTab(target, options.tabId);
    const sessionRecords = this.host.getSessionTabList ? this.host.getSessionTabList(effectiveTabId) : [];
    const records = sessionRecords.length > 0 ? sessionRecords : (this.host.getTabList ? this.host.getTabList() : []);
    const tab = (records || []).find((t: unknown) => isTabRecord(t) && t.id === effectiveTabId) as (AntiFanTab & { customViewport?: { width: number; height: number; mobile?: boolean }; attached?: boolean }) | undefined;
    const activeTabId = this.host.getActiveTabId ? this.host.getActiveTabId() : undefined;
    const isActive = Boolean(activeTabId && activeTabId === effectiveTabId);
    const isAttached = Boolean(tab?.attached ?? isActive);
    const presetId = tab?.devicePresetId ?? undefined;
    const customViewport = tab?.customViewport ?? null;

    let surface: RenderSurfaceSnapshot | undefined;
    if (typeof this.host.readRenderSurface === 'function') {
      try {
        surface = await this.host.readRenderSurface(effectiveTabId, undefined, RENDER_SURFACE_PROBE_BOUND_MS);
      } catch {}
    }

    if (surface && Number.isFinite(surface.vw) && Number.isFinite(surface.vh) && surface.vw >= 1 && surface.vh >= 1) {
      return {
        tabId: effectiveTabId,
        presetId,
        customViewport,
        width: surface.vw,
        height: surface.vh,
        dpr: surface.dpr || 1,
        attached: isAttached,
        active: isActive,
      };
    }

    const cause = classifyRenderSurfaceCause(surface);
    return {
      tabId: effectiveTabId,
      presetId,
      customViewport,
      width: 0,
      height: 0,
      dpr: surface?.dpr || 1,
      attached: isAttached,
      active: isActive,
      cause: cause || 'The tab has no attached laid-out surface',
      detached: !isAttached,
    };
  }

  setDevicePreset(options: { presetId: string; tabId?: string; reload?: boolean }, target?: BrowserTarget): { success: boolean; presetId: string } {
    if (!this.host.setDevicePreset) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'setDevicePreset is not supported by host');
    if (!options.presetId || typeof options.presetId !== 'string') {
      throw new CapabilityError('INVALID_ARGUMENT', 'presetId is required and must be a string');
    }
    const effectiveTabId = this.resolveTargetTab(target, options.tabId);
    const ok = this.host.setDevicePreset(effectiveTabId, options.presetId, { reload: options.reload });
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

  async inspectFont(
    target: BrowserTarget,
    params: { selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' } = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<Record<string, unknown>> {
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';

    if (!this.host.inspectFont) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'inspectFont is not supported by host');
    }

    return this.passivePool.execute(tabId, async () => {
      return this.host.inspectFont!({ ...params, tabId, paneId: effectivePane });
    });
  }

  async getMatchedStylesForNode(
    target: BrowserTarget,
    params: { nodeId?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' } = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<Record<string, unknown> | null> {
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';

    if (!this.host.getMatchedStylesForNode) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'getMatchedStylesForNode is not supported by host');
    }

    return this.passivePool.execute(tabId, async () => {
      return this.host.getMatchedStylesForNode!({ ...params, tabId, paneId: effectivePane });
    });
  }

  async inspectLayout(
    target: BrowserTarget,
    params: { selector?: string; selectors?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' } = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<Record<string, unknown>> {
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';

    const selectors = Array.from(new Set([
      ...(params.selectors && Array.isArray(params.selectors) ? params.selectors : []),
      ...(params.selector ? [params.selector] : [])
    ])).filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

    const script = `(() => {
      try {
        const parsePx = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n * 100) / 100; };
        const vp = {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY
        };
        const targets = ${JSON.stringify(selectors)};
        const results = {};

        for (const sel of targets) {
          const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 5);
          results[sel] = nodes.map((node) => {
            const cs = window.getComputedStyle(node);
            const r = node.getBoundingClientRect();
            return {
              tag: node.tagName.toLowerCase(),
              className: typeof node.className === 'string' ? node.className : '',
              textSnippet: (node.textContent || '').trim().slice(0, 80),
              rect: {
                top: Math.round(r.top * 100) / 100,
                left: Math.round(r.left * 100) / 100,
                bottom: Math.round(r.bottom * 100) / 100,
                right: Math.round(r.right * 100) / 100,
                width: Math.round(r.width * 100) / 100,
                height: Math.round(r.height * 100) / 100
              },
              boxModel: {
                padding: { top: parsePx(cs.paddingTop), right: parsePx(cs.paddingRight), bottom: parsePx(cs.paddingBottom), left: parsePx(cs.paddingLeft) },
                margin: { top: parsePx(cs.marginTop), right: parsePx(cs.marginRight), bottom: parsePx(cs.marginBottom), left: parsePx(cs.marginLeft) },
                border: { top: parsePx(cs.borderTopWidth), right: parsePx(cs.borderRightWidth), bottom: parsePx(cs.borderBottomWidth), left: parsePx(cs.borderLeftWidth) }
              },
              typography: {
                fontSize: cs.fontSize,
                fontWeight: cs.fontWeight,
                lineHeight: cs.lineHeight,
                fontFamily: cs.fontFamily,
                color: cs.color
              },
              layout: {
                display: cs.display,
                position: cs.position,
                zIndex: cs.zIndex,
                gap: cs.gap || undefined,
                overflow: cs.overflow
              }
            };
          });
        }
        return { ok: true, viewport: vp, selectors: results };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    })()`;

    return this.passivePool.execute(tabId, async () => {
      const res = await this.host.evalJs(script, tabId, effectivePane);
      return res as Record<string, unknown>;
    });
  }

  async styleOverride(
    target: BrowserTarget,
    params: { css?: string; scopeId?: string; action?: 'apply' | 'remove' | 'clear'; tabId?: string; paneId?: 'desktop' | 'mobile' } = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<Record<string, unknown>> {
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';
    const action = params.action || 'apply';
    const scopeId = (params.scopeId || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    const css = params.css || '';

    const script = `(() => {
      try {
        const action = ${JSON.stringify(action)};
        const scopeId = ${JSON.stringify(scopeId)};
        const css = ${JSON.stringify(css)};
        const ATTR = 'data-antifan-override';

        if (action === 'clear') {
          const all = document.querySelectorAll('style[' + ATTR + ']');
          all.forEach(el => el.remove());
          return { ok: true, action: 'clear', count: all.length };
        }

        if (action === 'remove') {
          const el = document.querySelector('style[' + ATTR + '="' + scopeId + '"]');
          const removed = !!el;
          if (el) el.remove();
          return { ok: true, action: 'remove', scopeId, removed };
        }

        let el = document.querySelector('style[' + ATTR + '="' + scopeId + '"]');
        if (!el) {
          el = document.createElement('style');
          el.setAttribute(ATTR, scopeId);
          document.head.appendChild(el);
        }
        el.textContent = css;
        const active = Array.from(document.querySelectorAll('style[' + ATTR + ']')).map(s => s.getAttribute(ATTR));
        return { ok: true, action: 'apply', scopeId, activeScopes: active };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    })()`;

    return this.passivePool.execute(tabId, async () => {
      const res = await this.host.evalJs(script, tabId, effectivePane);
      return res as Record<string, unknown>;
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
      clear?: boolean;
      deltaY?: number;
      settleMs?: number;
      tabId?: string;
      paneId?: 'desktop' | 'mobile';
      motionSpec?: {
        expectedDurationMs?: number;
        expectedEasing?: string;
        expectedProperties?: string[];
        expectedAmplitude?: { scaleDelta?: number; opacityDelta?: number };
      };
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
    await this.assertRenderSurface(tabId, effectivePane, 'anti.trace.interaction');

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

      // In-page V8 Micro-Observer (rAF loop):
      // Observes per-frame style mutations directly in the V8 runtime without IPC ping-pong.
      // Accurately tracks continuous CSS transitions, Web Animations, and JS/rAF animations.
      const observerScript = `(() => {
        try {
          const sel = ${JSON.stringify(params.selector || '')};
          const ref = ${JSON.stringify(params.ref || '')};
          let el = null;
          if (ref) el = document.querySelector('[data-antifan-ref="' + ref + '"]');
          if (!el && sel) el = document.querySelector(sel);
          if (!el) el = document.body;
          window.__antifanMotionSamples = [];
          window.__antifanMutations = [];
          window.__antifanMutationsTruncated = false;
          let active = true;
          let actionStartT = null;
          const armT = performance.now();
          window.__antifanMarkAction = () => {
            actionStartT = performance.now();
            return actionStartT;
          };

          const tick = () => {
            if (!active) return;
            const now = performance.now();
            const cs = window.getComputedStyle(el);
            const baseT = actionStartT !== null ? actionStartT : armT;
            window.__antifanMotionSamples.push({
              t: Math.max(0, Math.round(now - baseT)),
              transform: cs.transform || 'none',
              opacity: cs.opacity || '1',
              width: cs.width || '0px',
              height: cs.height || '0px',
            });
            if (now - armT < 2500) {
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);

          let mo = null;
          try {
            mo = new MutationObserver((records) => {
              const now = performance.now();
              for (const r of records) {
                if (window.__antifanMutations.length >= 100) {
                  window.__antifanMutationsTruncated = true;
                  break;
                }
                const tgt = r.target;
                const isInternalNode = (node) => {
                  if (!node || node.nodeType !== 1) return false;
                  if (node.id && node.id.startsWith('__antifan_')) return true;
                  if (node.closest && node.closest('#__antifan_agent_overlay__, #__antifan_agent_cursor__, #__antifan_agent_banner__, #__antifan_agent_highlight__, #__antifan_agent_style__')) return true;
                  return false;
                };
                const shouldSkipRecord = (rec) => {
                  const t = rec.target;
                  if (t && t.id && t.id.startsWith('__antifan_')) return true;
                  if (t && t.closest && t.closest('#__antifan_agent_overlay__, #__antifan_agent_cursor__, #__antifan_agent_banner__, #__antifan_agent_highlight__, #__antifan_agent_style__')) return true;
                  if (rec.type === 'childList') {
                    const added = rec.addedNodes ? Array.from(rec.addedNodes) : [];
                    const removed = rec.removedNodes ? Array.from(rec.removedNodes) : [];
                    const totalNodes = added.length + removed.length;
                    if (totalNodes > 0) {
                      const allInternal = added.every(isInternalNode) && removed.every(isInternalNode);
                      if (allInternal) return true;
                    }
                  }
                  return false;
                };
                if (shouldSkipRecord(r)) continue;

                window.__antifanMutations.push({
                  tPage: now,
                  type: r.type,
                  targetTag: tgt && tgt.nodeName ? tgt.nodeName.toLowerCase() : '',
                  targetId: tgt && tgt.id ? tgt.id : undefined,
                  targetClass: tgt && typeof tgt.className === 'string' ? tgt.className : undefined,
                  attributeName: r.attributeName || undefined,
                  addedCount: r.addedNodes ? r.addedNodes.length : 0,
                  removedCount: r.removedNodes ? r.removedNodes.length : 0,
                });
              }
            });
            mo.observe(document.documentElement || document.body, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
          } catch {
            mo = null;
          }
          window.__stopAntifanMotion = () => {
            active = false;
            if (mo) {
              try { mo.disconnect(); mo = null; } catch {}
            }
            const stopT = performance.now();
            const cs = window.getComputedStyle(el);
            let animEasing = '';
            let animProps = [];
            try {
              const anims = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
              for (const a of anims) {
                if (a.effect && typeof a.effect.getTiming === 'function') {
                  const t = a.effect.getTiming();
                  if (t && t.easing) animEasing = t.easing;
                }
                if (a.effect && typeof a.effect.getKeyframes === 'function') {
                  const kfs = a.effect.getKeyframes();
                  for (const kf of kfs) {
                    for (const k of Object.keys(kf)) {
                      if (k !== 'offset' && k !== 'computedOffset' && k !== 'easing' && !animProps.includes(k)) {
                        animProps.push(k);
                      }
                    }
                  }
                }
              }
            } catch {}
            const actionBaseT = typeof actionStartT === 'number' ? actionStartT : null;
            const normalizedMutations = (window.__antifanMutations || []).map((m) => {
              const itemPageT = typeof m.tPage === 'number' ? m.tPage : armT;
              return {
                ...m,
                t: actionBaseT !== null ? Math.round(itemPageT - actionBaseT) : Math.round(itemPageT - armT),
              };
            });
            const res = {
              samples: window.__antifanMotionSamples || [],
              mutations: normalizedMutations,
              wasTruncated: Boolean(window.__antifanMutationsTruncated),
              armT,
              actionStartT,
              markerConfirmed: typeof actionStartT === 'number',
              stopT,
              durationMs: typeof actionStartT === 'number' ? Math.max(0, Math.round(stopT - actionStartT)) : Math.max(0, Math.round(stopT - armT)),
              computedTimingFunction: cs.transitionTimingFunction || 'none',
              computedTransitionProperty: cs.transitionProperty || 'none',
              animEasing,
              animProps,
            };
            try {
              delete window.__stopAntifanMotion;
              delete window.__antifanMotionSamples;
              delete window.__antifanMutations;
              delete window.__antifanMutationsTruncated;
              delete window.__antifanMarkAction;
            } catch {}
            return res;
          };
          return {
            armed: Boolean(mo && window.__stopAntifanMotion),
            mutationObserver: Boolean(mo),
            motionObserver: true,
          };
        } catch {
          return { armed: false, mutationObserver: false, motionObserver: false };
        }
      })()`;
      let observerArmed = false;
      try {
        const armRes = (await this.host.evalJs(observerScript, tabId, effectivePane)) as any;
        observerArmed = armRes === true || (armRes && typeof armRes === 'object' && armRes.armed === true && armRes.mutationObserver === true);
      } catch {
        observerArmed = false;
      }

      let observerStopped = false;
      const stopObserver = async (): Promise<any | null> => {
        if (observerStopped) return null;
        observerStopped = true;
        if (!observerArmed) return null;
        try {
          return await this.host.evalJs('window.__stopAntifanMotion ? window.__stopAntifanMotion() : null', tabId, effectivePane);
        } catch {
          return null;
        }
      };

      let actionMarkerConfirmed = false;
      let pageActionStartT: number | null = null;
      if (observerArmed) {
        try {
          const markRes = (await this.host.evalJs(
            'window.__antifanMarkAction ? window.__antifanMarkAction() : null',
            tabId,
            effectivePane
          )) as any;
          if (typeof markRes === 'number' && Number.isFinite(markRes) && markRes >= 0) {
            actionMarkerConfirmed = true;
            pageActionStartT = markRes;
          }
        } catch {}
      }
      // Execute Action with Causality Tracking
      let actionExecuted = false;
      let actionError: string | undefined;
      let interactionMode: InteractionExecutionMode = 'none';

      if (params.action === 'click') {
        if (this.host.dispatchAgentAction) {
          try {
            const rawRes = await this.host.dispatchAgentAction('click', { selector: params.selector, ref: params.ref, trusted: true, tabId, paneId: effectivePane });
            actionExecuted = rawRes?.success === true;
            interactionMode = resolveInteractionMode(rawRes, 'unknown');
            if (!actionExecuted && rawRes && typeof rawRes === 'object' && typeof (rawRes as any).reason === 'string') {
              actionError = (rawRes as any).reason;
            }
          } catch (err: unknown) {
            actionExecuted = false;
            actionError = String(err);
            interactionMode = 'none';
          }
        } else if (this.host.agentClick) {
          try {
            const rawRes = (await this.host.agentClick({ selector: params.selector, ref: params.ref, trusted: true, tabId, paneId: effectivePane })) as any;
            actionExecuted = isStrictActionSuccess(rawRes, 'clicked');
            interactionMode = resolveInteractionMode(rawRes, 'unknown');
            if (!actionExecuted && rawRes && typeof rawRes === 'object' && typeof (rawRes as any).error === 'string') {
              actionError = (rawRes as any).error;
            }
          } catch (err: unknown) {
            actionExecuted = false;
            actionError = String(err);
            interactionMode = 'none';
          }
        } else {
          interactionMode = 'programmatic_dom';
          const sel = params.ref ? `[data-antifan-ref="${params.ref}"]` : (params.selector || 'body');
          try {
            const evalRes = (await this.host.evalJs(`(() => {
              const el = document.querySelector(${JSON.stringify(sel)});
              if (!el) return { clicked: false, error: 'Element not found' };
              el.click();
              return { clicked: true };
            })()`, tabId, effectivePane)) as any;
            actionExecuted = isStrictActionSuccess(evalRes, 'clicked');
            if (!actionExecuted && evalRes && typeof evalRes === 'object' && typeof (evalRes as any).error === 'string') {
              actionError = (evalRes as any).error;
            }
          } catch (err: unknown) {
            actionExecuted = false;
            actionError = String(err);
          }
        }
      } else if (params.action === 'hover') {
        if (this.host.dispatchAgentAction) {
          try {
            const rawRes = await this.host.dispatchAgentAction('hover', { selector: params.selector, ref: params.ref, tabId, paneId: effectivePane });
            actionExecuted = rawRes?.success === true;
            interactionMode = resolveInteractionMode(rawRes, 'unknown');
            if (!actionExecuted && rawRes && typeof rawRes === 'object' && typeof (rawRes as any).reason === 'string') {
              actionError = (rawRes as any).reason;
            }
          } catch (err: unknown) {
            actionExecuted = false;
            actionError = String(err);
            interactionMode = 'none';
          }
        } else if (this.host.agentHover) {
          try {
            const rawRes = (await this.host.agentHover({ selector: params.selector, ref: params.ref, tabId, paneId: effectivePane })) as any;
            actionExecuted = isStrictActionSuccess(rawRes, 'hovered');
            interactionMode = resolveInteractionMode(rawRes, 'unknown');
            if (!actionExecuted && rawRes && typeof rawRes === 'object' && typeof (rawRes as any).error === 'string') {
              actionError = (rawRes as any).error;
            }
          } catch (err: unknown) {
            actionExecuted = false;
            actionError = String(err);
            interactionMode = 'none';
          }
        } else {
          interactionMode = 'none';
          actionExecuted = false;
          actionError = 'agentHover is not supported by host';
        }
      } else if (params.action === 'focus') {
        interactionMode = 'programmatic_dom';
        const sel = params.ref ? `[data-antifan-ref="${params.ref}"]` : (params.selector || 'body');
        try {
          const evalRes = (await this.host.evalJs(`(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return { focused: false, error: 'Element not found' };
            el.focus();
            return { focused: true };
          })()`, tabId, effectivePane)) as any;
          actionExecuted = isStrictActionSuccess(evalRes, 'focused');
          if (!actionExecuted && evalRes && typeof evalRes === 'object' && typeof (evalRes as any).error === 'string') {
            actionError = (evalRes as any).error;
          }
        } catch (err: unknown) {
          actionExecuted = false;
          actionError = String(err);
        }
      } else if (params.action === 'type') {
        if (this.host.dispatchAgentAction) {
          try {
            const rawRes = await this.host.dispatchAgentAction('type', { selector: params.selector, ref: params.ref, text: params.text || '', clear: params.clear, trusted: true, tabId, paneId: effectivePane });
            actionExecuted = rawRes?.success === true;
            interactionMode = resolveInteractionMode(rawRes, 'unknown');
            if (!actionExecuted && rawRes && typeof rawRes === 'object' && typeof (rawRes as any).reason === 'string') {
              actionError = (rawRes as any).reason;
            }
          } catch (err: unknown) {
            actionExecuted = false;
            actionError = String(err);
            interactionMode = 'none';
          }
        } else if (this.host.agentType) {
          try {
            const rawRes = (await this.host.agentType({ selector: params.selector, ref: params.ref, text: params.text || '', trusted: true, tabId, paneId: effectivePane })) as any;
            actionExecuted = isStrictActionSuccess(rawRes, 'typed');
            interactionMode = resolveInteractionMode(rawRes, 'unknown');
            if (!actionExecuted && rawRes && typeof rawRes === 'object' && typeof (rawRes as any).error === 'string') {
              actionError = (rawRes as any).error;
            }
          } catch (err: unknown) {
            actionExecuted = false;
            actionError = String(err);
            interactionMode = 'none';
          }
        } else {
          interactionMode = 'none';
          actionExecuted = false;
          actionError = 'agentType is not supported by host';
        }
      } else if (params.action === 'scroll') {
        if (this.host.dispatchAgentAction) {
          try {
            const rawRes = await this.host.dispatchAgentAction('scroll', { selector: params.selector, ref: params.ref, deltaY: params.deltaY || 300, tabId, paneId: effectivePane });
            actionExecuted = rawRes?.success === true;
            interactionMode = resolveInteractionMode(rawRes, 'unknown');
            if (!actionExecuted && rawRes && typeof rawRes === 'object' && typeof (rawRes as any).reason === 'string') {
              actionError = (rawRes as any).reason;
            }
          } catch (err: unknown) {
            actionExecuted = false;
            actionError = String(err);
            interactionMode = 'none';
          }
        } else if (this.host.agentScroll) {
          try {
            const rawRes = (await this.host.agentScroll({ selector: params.selector, ref: params.ref, deltaY: params.deltaY || 300, tabId, paneId: effectivePane })) as any;
            actionExecuted = isStrictActionSuccess(rawRes, 'scrolled');
            interactionMode = resolveInteractionMode(rawRes, 'unknown');
            if (!actionExecuted && rawRes && typeof rawRes === 'object' && typeof (rawRes as any).error === 'string') {
              actionError = (rawRes as any).error;
            }
          } catch (err: unknown) {
            actionExecuted = false;
            actionError = String(err);
            interactionMode = 'none';
          }
        } else {
          interactionMode = 'none';
          actionExecuted = false;
          actionError = 'agentScroll is not supported by host';
        }
      }

      // If the base action failed to execute or dispatch, fail closed immediately.
      // Prevents ambient background mutations (e.g. carousel autoplay, clocks) from falsely certifying success.
      if (!actionExecuted) {
        await stopObserver();
        const durationMs = Date.now() - startTime;
        const isPrimaryTab = target?.tabId === tabId;
        return {
          tabId,
          isPrimaryTab,
          role: isPrimaryTab ? 'primary' : 'managed_child',
          action: params.action,
          interactionMode,
          actionSuccess: false,
          target: { selector: params.selector, ref: params.ref },
          durationMs,
          settled: true,
          verified: false,
          verdict: 'ACTION_FAILED',
          confidence: 0,
          evidence: {
            causalityViolation: true,
            error: actionError || `Underlying action '${params.action}' reported failure or target was not actionable. Ambient page mutations cannot be attributed to this interaction.`,
            observationIntegrity: {
              status: 'UNAVAILABLE',
              reason: observerArmed ? 'ACTION_ABORTED' : 'OBSERVER_SETUP_FAILED',
              details: 'Action failed before execution; observation was aborted without settle.',
              totalObserved: 0,
              bufferLimit: 100,
            },
          },
          beforeStyles,
          afterStyles: {},
          motion: undefined,
        };
      }
      this.bumpMutationRevision(tabId);
      const settleWait = Math.min(Math.max(params.settleMs || 100, 20), 2000);
      const { promise: settlePromise, resolve: settleResolve } = Promise.withResolvers<void>();
      setTimeout(settleResolve, settleWait);
      await settlePromise;

      let motionTrace: Record<string, unknown> | undefined;
      let rawMotion: any = null;
      try {
        rawMotion = await stopObserver();
        if (rawMotion && Array.isArray(rawMotion.samples) && rawMotion.samples.length > 0) {
          const samples = rawMotion.samples as Array<{ t: number; transform: string; opacity: string; width: string; height: string }>;
          let firstChangeIndex = -1;
          let lastChangeIndex = -1;
          const changedPropsSet = new Set<string>();

          for (let i = 1; i < samples.length; i++) {
            const prev = samples[i - 1];
            const cur = samples[i];
            if (!prev || !cur) continue;
            let stepDiff = false;
            if (cur.transform !== prev.transform) { stepDiff = true; changedPropsSet.add('transform'); }
            if (cur.opacity !== prev.opacity) { stepDiff = true; changedPropsSet.add('opacity'); }
            if (cur.width !== prev.width) { stepDiff = true; changedPropsSet.add('width'); }
            if (cur.height !== prev.height) { stepDiff = true; changedPropsSet.add('height'); }
            if (stepDiff) {
              if (firstChangeIndex === -1) firstChangeIndex = i;
              lastChangeIndex = i;
            }
          }

          const hasMotion = lastChangeIndex !== -1;
          const lastSample = lastChangeIndex !== -1 ? samples[lastChangeIndex] : undefined;
          const motionStartSample = firstChangeIndex > 0 ? samples[firstChangeIndex - 1] : samples[0];
          const observedDurationMs = hasMotion && lastSample && motionStartSample
            ? Math.max(0, lastSample.t - motionStartSample.t)
            : 0;

          const startSample = samples[0];
          const endSample = samples[samples.length - 1];
          const parseOpacity = (o?: string): number => {
            const n = parseFloat(o ?? '1');
            return Number.isFinite(n) ? n : 1;
          };
          const startOpacity = parseOpacity(startSample?.opacity);
          const endOpacity = parseOpacity(endSample?.opacity);
          const opacityDelta = Math.abs(endOpacity - startOpacity);

          const parseScale = (t?: string): number => {
            if (!t || t === 'none') return 1;
            const m = t.match(/matrix(?:3d)?\(([^,]+)/);
            if (m && m[1]) {
              const val = parseFloat(m[1]);
              return Number.isFinite(val) ? val : 1;
            }
            const s = t.match(/scale(?:3d)?\(([^,)]+)/);
            if (s && s[1]) {
              const val = parseFloat(s[1]);
              return Number.isFinite(val) ? val : 1;
            }
            return 1;
          };
          const startScale = parseScale(startSample?.transform);
          const endScale = parseScale(endSample?.transform);
          const scaleDelta = Math.abs(endScale - startScale);

          const observedEasing = rawMotion.animEasing || (rawMotion.computedTimingFunction !== 'none' ? rawMotion.computedTimingFunction : 'none');
          const allAnimatedProps = Array.from(new Set([...Array.from(changedPropsSet), ...(rawMotion.animProps || [])]));

          const spec = params.motionSpec;
          let overallVerdict: 'PASS' | 'WARN' | 'FAIL' | 'STATIC' = hasMotion ? 'PASS' : 'STATIC';

          // Vector 1: Temporal
          let temporalVerdict: 'PASS' | 'FAIL' = 'PASS';
          let temporalDelta = 0;
          if (spec && typeof spec.expectedDurationMs === 'number') {
            temporalDelta = Math.abs(observedDurationMs - spec.expectedDurationMs);
            temporalVerdict = temporalDelta <= 33 ? 'PASS' : 'FAIL';
            if (temporalVerdict === 'FAIL') overallVerdict = 'FAIL';
          }

          // Vector 2: Curve
          let curveVerdict: 'PASS' | 'FAIL' = 'PASS';
          if (spec && spec.expectedEasing) {
            const EASING_ALIASES: Record<string, string> = {
              'ease': 'cubic-bezier(0.25,0.1,0.25,1)',
              'linear': 'cubic-bezier(0,0,1,1)',
              'ease-in': 'cubic-bezier(0.42,0,1,1)',
              'ease-out': 'cubic-bezier(0,0,0.58,1)',
              'ease-in-out': 'cubic-bezier(0.42,0,0.58,1)',
            };
            const normalizeEasing = (e: string) => {
              const cleaned = e.replace(/\s+/g, '').toLowerCase();
              return EASING_ALIASES[cleaned] || cleaned;
            };
            curveVerdict = normalizeEasing(observedEasing) === normalizeEasing(spec.expectedEasing) ? 'PASS' : 'FAIL';
            if (curveVerdict === 'FAIL') overallVerdict = 'FAIL';
          }

          // Vector 3: Amplitude
          let amplitudeVerdict: 'PASS' | 'FAIL' = 'PASS';
          if (spec && spec.expectedAmplitude) {
            if (typeof spec.expectedAmplitude.scaleDelta === 'number') {
              const scaleErr = Math.abs(scaleDelta - spec.expectedAmplitude.scaleDelta);
              if (scaleErr > 0.05) amplitudeVerdict = 'FAIL';
            }
            if (typeof spec.expectedAmplitude.opacityDelta === 'number') {
              const opErr = Math.abs(opacityDelta - spec.expectedAmplitude.opacityDelta);
              if (opErr > 0.05) amplitudeVerdict = 'FAIL';
            }
            if (amplitudeVerdict === 'FAIL') overallVerdict = 'FAIL';
          }

          // Vector 4: Property
          let propertyVerdict: 'PASS' | 'FAIL' = 'PASS';
          if (spec && Array.isArray(spec.expectedProperties) && spec.expectedProperties.length > 0) {
            const missingProps = spec.expectedProperties.filter(p => !allAnimatedProps.includes(p));
            propertyVerdict = missingProps.length === 0 ? 'PASS' : 'FAIL';
            if (propertyVerdict === 'FAIL') overallVerdict = 'FAIL';
          }

          motionTrace = {
            verdict: overallVerdict,
            hasMotion,
            sampleCount: samples.length,
            observedDurationMs,
            observedEasing,
            animatedProperties: allAnimatedProps,
            observedAmplitude: { scaleDelta, opacityDelta },
            vectors: {
              temporal: {
                verdict: temporalVerdict,
                observedMs: observedDurationMs,
                expectedMs: spec?.expectedDurationMs,
                deadbandMs: 33,
                deltaMs: temporalDelta,
              },
              curve: {
                verdict: curveVerdict,
                observed: observedEasing,
                expected: spec?.expectedEasing,
              },
              amplitude: {
                verdict: amplitudeVerdict,
                observed: { scaleDelta, opacityDelta },
                expected: spec?.expectedAmplitude,
              },
              property: {
                verdict: propertyVerdict,
                observedProperties: allAnimatedProps,
                expectedProperties: spec?.expectedProperties,
              },
            },
          };
        }
      } catch {}

      let afterStyles: Record<string, unknown> = {};
      try {
        afterStyles = await this.inspectStyles(target, { selector: params.selector, ref: params.ref, tabId, paneId: effectivePane });
      } catch {}

      // Capture Dual-Scope After State
      const afterState = await this.captureBehaviorScope(tabId, effectivePane, params.selector, params.ref);

      const durationMs = Date.now() - startTime;

      // Synthesize Semantic Verdict and Evidence Delta
      const evaluation = this.evaluateBehaviorEvidence(beforeState, afterState, beforeStyles, afterStyles);

      // Compute Sparse Interaction Delta (Pure Domain Function)
      const sparseDelta = computeSparseInteractionDelta(beforeState as RawBehaviorScope, afterState as RawBehaviorScope);

      // Compute Mutation Attribution (Pure Domain Function)
      let mutationAttribution = undefined;
      let observationIntegrity: ObservationIntegrity;

      if (!observerArmed) {
        observationIntegrity = {
          status: 'UNAVAILABLE',
          reason: 'OBSERVER_SETUP_FAILED',
          details: 'In-page observer setup failed or was not armed',
          totalObserved: 0,
          bufferLimit: 100,
        };
      } else if (!actionMarkerConfirmed || typeof rawMotion?.actionStartT !== 'number') {
        observationIntegrity = {
          status: 'UNAVAILABLE',
          reason: 'ACTION_MARKER_FAILED',
          details: 'Action marker was not confirmed; cannot reliably align mutation lineage to action start',
          totalObserved: Array.isArray(rawMotion?.mutations) ? rawMotion.mutations.length : 0,
          bufferLimit: 100,
        };
      } else {
        const pageActionStart = rawMotion.actionStartT;
        const pageStop = rawMotion.stopT ?? pageActionStart;
        const policyWindowMs = Math.min(Math.max((params as any).attributionWindowMs || params.settleMs || 1000, 100), 5000);
        const actionBoundary: ActionBoundary = {
          armedAt: rawMotion.armT ?? pageActionStart,
          actionStartedAt: pageActionStart,
          settledAt: pageStop,
          attributionWindowMs: policyWindowMs,
          attributionDeadline: pageActionStart + policyWindowMs,
        };
        mutationAttribution = attributeMutations(
          rawMotion.mutations || [],
          actionBoundary,
          { selector: params.selector, ref: params.ref },
          { bufferLimit: 100, wasTruncated: Boolean(rawMotion.wasTruncated) }
        );
        observationIntegrity = mutationAttribution.integrity;
      }
      // Observation Integrity Gate:
      // If observation substrate is UNAVAILABLE (e.g. observer setup failed, action marker unconfirmed, target dropped),
      // legacy heuristic evaluations MUST NOT certify completion. Fail closed to INCONCLUSIVE.
      const isObservationValid = observationIntegrity.status !== 'UNAVAILABLE';
      const finalVerified = isObservationValid ? evaluation.verified : false;
      const finalVerdict = isObservationValid ? evaluation.verdict : 'INCONCLUSIVE';
      const finalConfidence = isObservationValid ? evaluation.confidence : 0;

      const isPrimaryTab = target?.tabId === tabId;
      return {
        tabId,
        isPrimaryTab,
        role: isPrimaryTab ? 'primary' : 'managed_child',
        action: params.action,
        interactionMode,
        actionSuccess: true,
        target: { selector: params.selector, ref: params.ref },
        durationMs,
        settled: true,
        verified: finalVerified,
        verdict: finalVerdict,
        confidence: finalConfidence,
        evidence: {
          ...evaluation.evidence,
          delta: sparseDelta,
          attribution: mutationAttribution,
          observationIntegrity,
        },
        beforeStyles,
        afterStyles,
        motion: motionTrace,
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
          '[role="dialog"], [role="menu"], [aria-modal="true"], dialog[open], .modal.show, .modal.active, .modal.is-open, .drawer.open, .drawer.active, .drawer.is-open, [data-overlay="open"], .submenu.open, .submenu.active, [class*="submenu"].active, [class*="dropdown"].active, [class*="__sub"].active, [class*="-sub"].active, [class*="menu"].active, [id*="submenu"].active, [id*="dropdown"].active, [id*="__sub"].active, [id*="-sub"].active, .active[id*="__sub"], .active[class*="__sub"], .dropdown-menu.show, .dropdown-menu.active'
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
      newOverlays.some((o: any) => /(?:^|[\s_-])(?:submenu|dropdown|menu|sub)(?:[\s_-]|$)/i.test(o.className) || /(?:^|[\s_-])(?:submenu|dropdown|menu|sub)(?:[\s_-]|$)/i.test(o.id || '') || o.role === 'menu')
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
  /**
   * Phase 4: Composed Settle Barrier (Audit v5 §14, V-16..V-18).
   * Unconditionally verifies first-party network quiescence, document fonts,
   * in-viewport image decode, and DOM quiet (double-rAF).
   *
   * Throws CapabilityError('RESOURCE_FAILURE') if broken images are detected.
   * Emits a full VisualSettleReceipt.
   */
  public async settleCapture(
    target: BrowserTarget | string,
    paneId: 'desktop' | 'mobile' = 'desktop',
    clipRect?: { x: number; y: number; width: number; height: number },
    options: CaptureSettleOptions & { signal?: AbortSignal; requireNetworkTracker?: boolean } = {}
  ): Promise<VisualSettleReceipt> {
    const tabId = typeof target === 'string' ? target : target.tabId;
    const networkTracker = typeof this.host.getNetworkTracker === 'function' ? this.host.getNetworkTracker() : undefined;
    const predicates = createBrowserSettlePredicates(this.host, tabId, paneId, {
      clipRect,
      networkTracker,
      requireNetworkTracker: options.requireNetworkTracker,
      signal: options.signal,
    });
    const receipt = await CaptureSettleGate.evaluate(predicates, options);
    CaptureSettleGate.assertResources(receipt);
    return receipt;
  }
  /**
   * Bounded, abort-aware visual compare transaction.
   *
   * Ordering under one pair lock: normalize both sides -> settle both sides ->
   * open the before-identity/mutation windows -> capture and stage both exact
   * raw PNGs -> post-capture identity checks for both -> only then structural
   * and pixel comparison of those exact staged buffers. A definitive or
   * INCONCLUSIVE result always carries both staged artifacts; a later diff
   * failure never drops them. No terminal state is emitted while this
   * invocation still owns pair locks, pool capacity, the active tab, DOM
   * mutations, or a quarantined target.
   */
  async visualCompare(
    target: BrowserTarget,
    runId: string,
    attemptId: string,
    params: VisualCompareParams = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile',
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const sourceCount = (params.baselineRef ? 1 : 0) + (params.baselineScreenshotRef ? 1 : 0) + (params.comparisonTabId ? 1 : 0);
    if (sourceCount === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Exactly one baseline source (baselineRef, baselineScreenshotRef, or comparisonTabId) is required for visual comparison');
    }
    if (sourceCount > 1) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Conflicting baseline sources: provide exactly one of baselineRef, baselineScreenshotRef, or comparisonTabId');
    }
    if (params.baselineRef && (!target || !target.workspaceId)) {
      throw new CapabilityError('WORKSPACE_UNBOUND', 'Explicit workspace context required to resolve visual baseline');
    }
    if (typeof this.host.captureVerificationScreenshot !== 'function') {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', "Host does not implement required 'captureVerificationScreenshot' canonical CDP interface");
    }
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';
    const compTabTarget = params.comparisonTabId
      ? this.resolveTargetTab(target, params.comparisonTabId)
      : null;
    // Both sides of a comparison are capture surfaces: a tab with no laid-out
    // surface would compare bytes that are not the storefront.
    await this.assertRenderSurface(tabId, effectivePane, 'anti.visual.compare');
    if (compTabTarget && compTabTarget !== tabId) {
      await this.assertRenderSurface(compTabTarget, effectivePane, 'anti.visual.compare');
    }
    const lockKeys = compTabTarget && compTabTarget !== tabId ? [tabId, compTabTarget] : [tabId];
    const txn: CompareTransaction = {
      token: `vc-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      lockKeys,
      tabId,
      compTabTarget,
      paneId: effectivePane,
      budget: new CompareBudget({
        signal,
        executionBudgetMs: VISUAL_COMPARE_EXECUTION_BUDGET_MS,
        cleanupBudgetMs: VISUAL_COMPARE_CLEANUP_BUDGET_MS,
      }),
      domTransactions: new Map<string, string>(),
      normalizationOwned: new Set<string>(),
      leaseToken: params.leaseToken,
      continuationValid: true,
      quarantined: false,
    };

    // Pool admission is itself a resource-holding await: bound it by the same
    // execution budget so a saturated pool cannot outlive the response budget.
    return txn.budget.run(
      'passive pool admission',
      () =>
        this.passivePool.execute(tabId, async () => {
          // A target holding a timed-out in-flight CDP command fails typed until
          // its recovery receipt lands; never dispatch new work into a draining target.
          this.assertTargetsUsable(txn);
          const admission = await this.acquirePairLock(txn);
          try {
            // Re-check under the pair lock: a sibling transaction may have
            // quarantined a target while this one was queued.
            this.assertTargetsUsable(txn);
            const rawRequired = Array.isArray(params.maskSelectors) ? params.maskSelectors : [];
            const userOptional = Array.isArray(params.maskOptionalSelectors) ? params.maskOptionalSelectors : [];
            // Auto-promote known dynamic third-party selectors to optional to prevent brittle test aborts
            const isDynamicWidget = (s: string) => /preview[-_]bar|chat|zalo|popup|notification|fb-|subiz|tawk|letschat/i.test(s);
            const requiredMasks = rawRequired.filter((s) => !isDynamicWidget(s));
            const autoPromotedOptional = rawRequired.filter((s) => isDynamicWidget(s));
            const hasUserMasks = rawRequired.length > 0 || userOptional.length > 0;
            // The implicit optional set (DEFAULT_STOREFRONT_WIDGETS plus the broad
            // `iframe[id]` selector) applies unless the caller disables it. Final
            // fidelity runs pass useDefaultWidgetMasks:false so generic selectors
            // cannot hide first-party content behind a low pixel diff.
            const defaultStorefrontWidgets = params.useDefaultWidgetMasks === false
              ? []
              : [...DEFAULT_STOREFRONT_WIDGETS, ...(hasUserMasks ? [] : ['iframe[id]'])];
            const optionalMasks = Array.from(new Set([...userOptional, ...autoPromotedOptional, ...defaultStorefrontWidgets]));
            // Record the active tab so a background comparison tab can be
            // foregrounded for capture and restored afterwards.
            txn.originalActiveTabId = this.host.getActiveTabId ? this.host.getActiveTabId() : tabId;
            try {
              const MAX_CAPTURE_ATTEMPTS = 2;
              let resampleCount = 0;
              for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
                const outcome = await this.executeVisualCompareAttempt({
                  target,
                  runId,
                  attemptId,
                  params,
                  txn,
                  requiredMasks,
                  optionalMasks,
                  attempt,
                  maxAttempts: MAX_CAPTURE_ATTEMPTS,
                  resampleCount,
                });
                if (outcome.settle) return outcome.result;
                resampleCount = outcome.resampleCount;
              }
              // Every terminal branch settles inside executeVisualCompareAttempt;
              // the resample-exhausted case settles INCONCLUSIVE there. Fail closed.
              throw new CapabilityError('INTEGRITY_COMPROMISED', 'Visual comparison attempts exhausted without a definitive verdict');
            } finally {
              await this.restoreActiveTab(txn);
            }
          } finally {
            // The transaction is torn down exactly once; any later continuation
            // (stale admission or abandoned attempt) must not dispatch work.
            txn.continuationValid = false;
            await admission.release();
          }
        }),
      VISUAL_COMPARE_EXECUTION_BUDGET_MS
    );
  }

  /**
   * Canonically capture the current tab (or specified tabId) via CDP, stage the screenshot artifact,
   * and promote it to an authoritative, immutable visual baseline reference (Phase 6, V-22).
   */
  async promoteBaseline(
    context: CapabilityRequestContext | AuthenticatedCapabilityContext,
    params: {
      tabId?: string;
      paneId?: 'desktop' | 'mobile';
      clipRect?: { x: number; y: number; width: number; height: number };
    } = {}
  ): Promise<VisualBaselineRef> {
    if (!context.browserTarget) {
      throw new CapabilityError('TARGET_REQUIRED', 'BrowserTarget is required for baseline promotion');
    }
    const target = context.browserTarget;
    const workspaceId = target.workspaceId || context.workspaceId;
    const projectId = target.projectId || context.projectId;
    if (!workspaceId) {
      throw new CapabilityError('WORKSPACE_UNBOUND', 'Explicit workspace context required to promote baseline');
    }
    if (!projectId) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Explicit project context required to promote baseline');
    }
    if (!context.runId || !context.attemptId) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Active runId and attemptId required to promote baseline');
    }
    if (typeof this.host.captureVerificationScreenshot !== 'function') {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', "Host does not implement required 'captureVerificationScreenshot' canonical CDP interface");
    }
    const tabId = this.resolveTargetTab(target, params.tabId);
    const effectivePane = params.paneId || 'desktop';

    const envelope = await this.host.captureVerificationScreenshot(params.clipRect, tabId, effectivePane);
    if (!envelope || !envelope.data || envelope.data.length === 0) {
      throw new CapabilityError('TARGET_STALE', `Failed to capture non-empty verification screenshot on tab '${tabId}' for baseline promotion`);
    }

    const receipt = verificationCaptureReceipt(envelope);
    const buf = Buffer.from(envelope.data, 'base64');
    if (!this.artifacts) {
      throw new CapabilityError('RESOURCE_FAILURE', 'Artifact store unavailable for staging promoted baseline');
    }

    const staged = await this.stageArtifact({
      kind: 'screenshot',
      mime: 'image/png',
      data: buf,
      runId: context.runId,
      attemptId: context.attemptId,
      projectId,
      workspaceId,
    });

    return this.baselineAuthority.promote(staged.id, context, {
      captureReceipt: receipt,
    });
  }

  /**
   * Admission for the compare pair lock. `MultiKeyLock.acquire` is not
   * signal-aware (T1-owned, frozen), so cancellation is handled at the consumer
   * without removing queue nodes: the abandoned admission is never dropped on
   * the floor — as soon as it is granted it releases itself in reverse queue
   * order, which is safe because it touched zero tab/CDP state and owns nothing
   * else. FIFO order for other waiters is preserved and the next waiter
   * succeeds immediately after the holder releases.
   */
  private async acquirePairLock(txn: CompareTransaction): Promise<{ release: () => Promise<void> }> {
    const signal = txn.budget.signal;
    const admission = this.comparePairLock.acquire(txn.lockKeys);
    let abandoned = false;
    admission.then(
      (release) => {
        if (abandoned) void Promise.resolve(release()).catch(() => {});
      },
      () => {}
    );
    if (!signal) {
      const release = await admission;
      txn.acquiredPairLock = true;
      return {
        release: async () => {
          txn.acquiredPairLock = false;
          await release();
        },
      };
    }
    if (signal.aborted) {
      abandoned = true;
      throw abortError('Visual compare was cancelled during pair-lock admission');
    }
    let granted = false;
    const admissionGate = Promise.withResolvers<() => Promise<void>>();
    const onAbort = () => {
      if (granted) return;
      abandoned = true;
      admissionGate.reject(abortError('Visual compare was cancelled during pair-lock admission'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    admission.then(
      (grantedRelease) => {
        granted = true;
        signal.removeEventListener('abort', onAbort);
        admissionGate.resolve(grantedRelease);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        admissionGate.reject(err);
      }
    );
    let release: () => Promise<void>;
    try {
      release = await admissionGate.promise;
    } catch (err) {
      if (abandoned) {
        // The queued admission may still be granted after this rejection; the
        // abandoned handler attached above releases it in reverse queue order.
        admission.catch(() => {});
      }
      throw err;
    }
    txn.acquiredPairLock = true;
    return {
      release: async () => {
        txn.acquiredPairLock = false;
        await release();
      },
    };
  }

  /**
   * Fail typed while a target in the transaction holds a timed-out in-flight
   * CDP command. The pair recovers only through the quarantine recovery receipt.
   */
  private assertTargetsUsable(txn: CompareTransaction): void {
    for (const candidate of [txn.tabId, txn.compTabTarget]) {
      if (!candidate) continue;
      const key = targetKey(candidate, txn.paneId);
      const entry = this.targetQuarantine.get(key);
      const draining = typeof this.host.isTargetDraining === 'function' ? this.host.isTargetDraining(candidate, txn.paneId) : false;
      if (entry) {
        if (!draining && entry.recovery && entry.recovery.ok) {
          // A successful recovery receipt exists and the host no longer reports the target
          // as draining: the quarantine has served its purpose.
          this.targetQuarantine.delete(key);
          continue;
        }
        throw new CapabilityError(
          'TARGET_BUSY_DRAINING',
          `Target '${candidate}' is quarantined: ${entry.reason}; recovery ${
            entry.recovery
              ? entry.recovery.ok
                ? 'complete'
                : `failed (${entry.recovery.error || entry.recovery.outcome})`
              : 'in progress'
          }. Retry after the recovery receipt.`,
          { tabId: candidate, paneId: txn.paneId, quarantineSince: entry.since, recovery: entry.recovery }
        );
      }
      if (draining) {
        throw new CapabilityError(
          'TARGET_BUSY_DRAINING',
          `Target '${candidate}' is draining an in-flight CDP command past its bound and cannot admit new work`,
          { tabId: candidate, paneId: txn.paneId }
        );
      }
    }
  }

  /**
   * Quarantine a target whose in-flight CDP command outlived its bound and start
   * bounded recovery. Same-pair/same-target operations fail typed until the
   * recovery receipt lands; the entry is cleared only after a successful receipt.
   */
  private quarantineTarget(txn: CompareTransaction, tabId: string, reason: string): TargetQuarantineEntry {
    txn.quarantined = true;
    return this.quarantineTargetEntry({ tabId, paneId: txn.paneId, pairKey: pairKeyOf(txn.lockKeys), reason });
  }

  private quarantineTargetEntry(args: {
    tabId: string;
    paneId: 'desktop' | 'mobile';
    pairKey?: string;
    reason: string;
    /** Geometry a failed capture must be returned to before the target is usable again. */
    restoreGeometry?: { width: number; height: number; scrollX: number; scrollY: number };
  }): TargetQuarantineEntry {
    const { tabId, paneId, reason } = args;
    const key = targetKey(tabId, paneId);
    const existing = this.targetQuarantine.get(key);
    if (existing) return existing;
    const entry: TargetQuarantineEntry = {
      tabId,
      paneId,
      pairKey: args.pairKey || targetKey(tabId, paneId),
      since: Date.now(),
      reason,
      recovery: undefined,
      pending: Promise.resolve(),
    };
    this.targetQuarantine.set(key, entry);
    entry.pending = (async () => {
      const receipt = await this.runTargetRecovery(tabId, paneId, args.restoreGeometry);
      entry.recovery = receipt;
      if (receipt.ok) this.targetQuarantine.delete(key);
    })();
    entry.pending.catch(() => {});
    return entry;
  }

  /** Bounded recovery for a quarantined target: the typed receipt is authoritative. */
  private async runTargetRecovery(
    tabId: string,
    paneId: 'desktop' | 'mobile',
    restoreGeometry?: { width: number; height: number; scrollX: number; scrollY: number }
  ): Promise<TargetRecoveryReceipt> {
    const startedAt = Date.now();
    const budgetMs = TARGET_RECOVERY_BUDGET_MS;
    if (typeof this.host.drainTarget !== 'function') {
      return {
        tabId,
        paneId,
        outcome: 'unsupported',
        ok: false,
        drained: false,
        resetPerformed: false,
        elapsedMs: Date.now() - startedAt,
        error: "Host does not implement 'drainTarget' target recovery",
        recoveredAt: Date.now(),
      };
    }
    try {
      const res = await raceWithTimeout(this.host.drainTarget(tabId, paneId, budgetMs), budgetMs + 2_000, () => null);
      if (!res) {
        return {
          tabId,
          paneId,
          outcome: 'drain-failed',
          ok: false,
          drained: false,
          resetPerformed: false,
          elapsedMs: Date.now() - startedAt,
          error: `drainTarget did not settle within ${budgetMs}ms`,
          recoveredAt: Date.now(),
        };
      }
      const outcome: TargetRecoveryOutcome = res.resetPerformed ? 'drain-reset' : res.drained ? 'command-settled' : 'drain-failed';
      let ok = res.ok || res.drained;
      // A capture that moved the layout viewport is only recovered once the
      // viewport is measurably back: otherwise the target stays quarantined and
      // refuses further work instead of poisoning later evidence.
      const viewportTransaction = ok ? await this.restoreGeometryForRecovery(tabId, paneId, restoreGeometry) : undefined;
      if (viewportTransaction && !viewportTransaction.restored) ok = false;
      return {
        tabId,
        paneId,
        outcome,
        ok,
        drained: res.drained,
        resetPerformed: res.resetPerformed,
        elapsedMs: res.elapsedMs,
        error: ok
          ? undefined
          : viewportTransaction && !viewportTransaction.restored
            ? `Capture geometry was not restored (viewport ${viewportTransaction.after ? `${viewportTransaction.after.width}x${viewportTransaction.after.height}` : 'unmeasurable'} after ${viewportTransaction.attempts} attempts)`
            : `drainTarget reported ok=${res.ok} drained=${res.drained}`,
        recoveredAt: Date.now(),
        ...(viewportTransaction ? { viewportTransaction } : {}),
      };
    } catch (err) {
      return {
        tabId,
        paneId,
        outcome: 'drain-failed',
        ok: false,
        drained: false,
        resetPerformed: false,
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        recoveredAt: Date.now(),
      };
    }
  }

  /** Await a quarantine entry's recovery receipt within the given bound. */
  private async awaitQuarantineReceipt(entry: TargetQuarantineEntry, timeoutMs: number): Promise<TargetRecoveryReceipt | undefined> {
    return raceWithTimeout(entry.pending.then(() => entry.recovery), Math.max(0, timeoutMs), () => entry.recovery);
  }

  /**
   * Restore the tab that was active before this transaction. Idempotent under
   * forced teardown (the recorded tab is consumed once) and bounded by the
   * reserved cleanup budget; only the tab this invocation recorded is restored.
   */
  private async restoreActiveTab(txn: CompareTransaction): Promise<void> {
    const original = txn.originalActiveTabId;
    txn.originalActiveTabId = undefined;
    if (!original || typeof this.host.switchTab !== 'function') return;
    await txn.budget.cleanup(
      'active tab restoration',
      async () => {
        const current = this.host.getActiveTabId ? this.host.getActiveTabId() : original;
        if (current !== original) this.host.switchTab!(original);
      },
      VISUAL_COMPARE_CLEANUP_BUDGET_MS
    );
  }

  /** Attach staged pair artifacts to any settled result that does not carry them yet. */
  private withStagedArtifacts(txn: CompareTransaction, body: Record<string, unknown>): Record<string, unknown> {
    if (txn.stagedTarget !== undefined && body.currentScreenshot === undefined) body.currentScreenshot = txn.stagedTarget;
    if (txn.stagedBaseline !== undefined && body.baselineScreenshot === undefined) body.baselineScreenshot = txn.stagedBaseline;
    return body;
  }

  /**
   * Reversible, owned DOM normalization. Records the previous value of every
   * attribute it touches and never removes a page node or installs a permanent
   * style setter; restoration replays the records in reverse order.
   */
  private async applyReversibleNormalization(txn: CompareTransaction, tabId: string): Promise<{ ok: boolean; recorded: number; error?: string }> {
    if (txn.domTransactions.has(tabId)) return { ok: true, recorded: 0 };
    const txnId = `${txn.token}:${tabId}`;
    try {
      const raw = await txn.budget.run(
        `normalization apply (${tabId})`,
        () => this.host.evalJs(buildReversibleNormalizationApplyScript(txnId), tabId, txn.paneId),
        NORMALIZATION_BOUND_MS
      );
      const recorded = raw && typeof raw === 'object' && typeof (raw as { recorded?: unknown }).recorded === 'number'
        ? (raw as { recorded: number }).recorded
        : 0;
      txn.domTransactions.set(tabId, txnId);
      return { ok: true, recorded };
    } catch (err) {
      return { ok: false, recorded: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Restore this transaction's owned normalization. Runs at most once per tab
   * and only touches records created by this invocation token.
   */
  private async restoreReversibleNormalization(txn: CompareTransaction, tabId: string): Promise<{ ok: boolean; error?: string }> {
    const txnId = txn.domTransactions.get(tabId);
    if (!txnId) return { ok: true };
    txn.domTransactions.delete(tabId);
    let result: { ok: boolean; error?: string } = { ok: false, error: 'restore did not run' };
    await txn.budget.cleanup(
      `normalization restore (${tabId})`,
      async () => {
        const raw = await this.host.evalJs(buildReversibleNormalizationRestoreScript(txnId), tabId, txn.paneId);
        const failed = raw && typeof raw === 'object' && typeof (raw as { failed?: unknown }).failed === 'number'
          ? (raw as { failed: number }).failed
          : 1;
        result = failed === 0 ? { ok: true } : { ok: false, error: `${failed} normalization records could not be restored` };
      },
      NORMALIZATION_RESTORE_BOUND_MS
    );
    return result;
  }

  /** Foreground the side, snapshot scroll, and normalize layout (reversible). */
  private async prepareCompareSide(
    txn: CompareTransaction,
    args: { tabId: string; params: VisualCompareParams; normalizeReceipt: NormalizationReceipt }
  ): Promise<{ ok: true; metrics: CssMetrics | null; scroll: { x: number; y: number } | null; settle: VisualSettleReceipt } | { ok: false; reason: string; settle?: VisualSettleReceipt }> {
    const { tabId, params, normalizeReceipt } = args;
    const budget = txn.budget;
    // Offscreen agent tabs render to an offscreen compositor surface; foregrounding
    // them would break the dual-plane model and is unnecessary for CDP capture.
    const isOffscreen = this.host.isTabOffscreen ? this.host.isTabOffscreen(tabId) : false;
    const canAttachInPlace = typeof this.host.canAttachForCapture === 'function'
      ? this.host.canAttachForCapture(tabId, txn.paneId)
      : (this.host.supportsAttachInPlaceCapture ?? (typeof this.host.captureVerificationScreenshot === 'function'));
    if (!canAttachInPlace && typeof this.host.switchTab === 'function' && !isOffscreen && this.host.getActiveTabId && this.host.getActiveTabId() !== tabId) {
      await budget.run(`foreground ${tabId}`, async () => {
        this.host.switchTab!(tabId);
        await budget.sleep(150, `foreground stabilization (${tabId})`);
      }, FOREGROUND_BOUND_MS);
    }
    let scroll: { x: number; y: number } | null = null;
    if (typeof this.host.evalJs === 'function') {
      const raw = await budget.run(
        `scroll snapshot (${tabId})`,
        () => this.host.evalJs(`({ x: window.scrollX || window.pageXOffset || 0, y: window.scrollY || window.pageYOffset || 0 })`, tabId, txn.paneId),
        EVAL_BOUND_MS
      ).catch(() => null);
      if (raw && typeof raw === 'object') {
        const s = raw as { x?: unknown; y?: unknown };
        scroll = { x: Number(s.x) || 0, y: Number(s.y) || 0 };
      }
    }
    const applied = await this.applyReversibleNormalization(txn, tabId);
    if (!applied.ok) return { ok: false, reason: `Reversible normalization could not be applied on tab '${tabId}': ${applied.error}` };
    if (params.normalizeScroll) {
      const outcome = await budget.run(
        `normalizeScroll inject (${tabId})`,
        () => NormalizationTransaction.inject(this.host, tabId, txn.paneId),
        NORMALIZATION_BOUND_MS
      );
      normalizeReceipt.injected = outcome.present === true;
      // A self-compare (target === comparison) injects once for the pair; the
      // second inject sees the element this same transaction created, so it
      // reports the truthful shared ownership instead of a false asymmetry.
      // A foreign pre-existing element with the reserved id is never claimed:
      // only an inject that this transaction performed is recorded.
      if (outcome.owned) txn.normalizationOwned.add(tabId);
      normalizeReceipt.owned = outcome.owned || txn.normalizationOwned.has(tabId);
      if (!outcome.ok && outcome.error) normalizeReceipt.injectError = outcome.error;
    }
    const settle = await budget.run(
      `settle (${tabId})`,
      () => this.settleCapture(tabId, txn.paneId, params.clipRect, { signal: budget.signal }),
      SETTLE_BOUND_MS
    );
    if (!settle.settleComplete) {
      return {
        ok: false,
        settle,
        reason: `Visual capture settle barrier incomplete on tab '${tabId}' (gates: network=${settle.gates.network}, fonts=${settle.gates.fonts}, images=${settle.gates.images}, dom=${settle.gates.dom})`,
      };
    }
    const metrics = await this.readSideMetrics(txn, tabId);
    return { ok: true, metrics, scroll, settle };
  }

  private async readSideMetrics(txn: CompareTransaction, tabId: string): Promise<CssMetrics | null> {
    try {
      const raw = await txn.budget.run(
        `css metrics (${tabId})`,
        () =>
          this.host.evalJs(
            `(() => ({
              vw: window.innerWidth || document.documentElement.clientWidth || 0,
              vh: window.innerHeight || document.documentElement.clientHeight || 0,
              dh: document.documentElement.scrollHeight || document.body.scrollHeight || 0,
              sx: window.scrollX || window.pageXOffset || 0,
              sy: window.scrollY || window.pageYOffset || 0,
            }))()`,
            tabId,
            txn.paneId
          ),
        EVAL_BOUND_MS
      );
      const o = raw as { vw?: unknown; vh?: unknown; dh?: unknown; sx?: unknown; sy?: unknown };
      if (typeof o.vw === 'number' && Number.isFinite(o.vw) && o.vw > 0) {
        return {
          vw: o.vw,
          vh: typeof o.vh === 'number' && Number.isFinite(o.vh) ? o.vh : 0,
          dh: typeof o.dh === 'number' && Number.isFinite(o.dh) && o.dh > 0 ? o.dh : 0,
          sx: typeof o.sx === 'number' && Number.isFinite(o.sx) ? o.sx : 0,
          sy: typeof o.sy === 'number' && Number.isFinite(o.sy) ? o.sy : 0,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Resolve the capture rectangle for one side (explicit clipRect or selector). */
  private async resolveSideRect(
    txn: CompareTransaction,
    tabId: string,
    params: VisualCompareParams
  ): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
    if (params.clipRect) {
      return {
        x: Math.round(params.clipRect.x),
        y: Math.round(params.clipRect.y),
        width: Math.round(params.clipRect.width),
        height: Math.round(params.clipRect.height),
      };
    }
    if (!params.selector || typeof this.host.evalJs !== 'function') return undefined;
    try {
      const rawRect = await txn.budget.run(
        `selector rect (${tabId})`,
        () =>
          this.host.evalJs(
            `(() => {
              const el = document.querySelector(${JSON.stringify(params.selector)});
              if (!el) return null;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return null;
              const sx = window.scrollX || window.pageXOffset || 0;
              const sy = window.scrollY || window.pageYOffset || 0;
              return { x: Math.max(0, Math.round(r.x + sx)), y: Math.max(0, Math.round(r.y + sy)), width: Math.round(r.width), height: Math.round(r.height) };
            })()`,
            tabId,
            txn.paneId
          ),
        EVAL_BOUND_MS
      );
      if (rawRect && typeof rawRect === 'object' && 'width' in rawRect && 'height' in rawRect) {
        const cast = rawRect as { x: number; y: number; width: number; height: number };
        if (cast.width > 0 && cast.height > 0) return cast;
      }
    } catch {}
    return undefined;
  }

  /**
   * Capture one side through the canonical CDP path and stage the exact raw
   * PNG. A capture that does not settle quarantines the target and returns a
   * typed failure carrying the recovery receipt; no metrics are fabricated.
   */
  private async captureStageSide(
    txn: CompareTransaction,
    args: {
      side: 'target' | 'baseline';
      tabId: string;
      runId: string;
      attemptId: string;
      target: BrowserTarget;
      rect?: { x: number; y: number; width: number; height: number };
      fullPage: boolean;
      expectedUrl?: string | null;
    }
  ): Promise<
    | {
        ok: true;
        envelope: VerificationCaptureEnvelope;
        buffer: Buffer;
        receipt: VerificationCaptureReceipt;
        artifact: ArtifactRef | string | undefined;
      }
    | { ok: false; reason: string; code: string; quarantine?: TargetRecoveryReceipt }
  > {
    const { side, tabId, runId, attemptId, target, rect, fullPage, expectedUrl } = args;
    const observedUrl = await this.getLiveTabUrl(tabId);
    const redirectChain = this.getTabRedirectChain(tabId);
    const routeCheck = checkRouteIdentity(expectedUrl, observedUrl, redirectChain);
    if (!routeCheck.ok) {
      return {
        ok: false,
        code: routeCheck.status,
        reason: `Route identity assertion failed for ${side} tab '${tabId}': ${routeCheck.reason || routeCheck.status} (requested: ${routeCheck.requestedUrl || 'none'}, observed: ${routeCheck.observedUrl}, redirects: ${redirectChain.join(' -> ') || 'none'})`,
      };
    }
    const budget = txn.budget;
    const captureBound = () => Math.max(1, Math.min(budget.remainingMs, fullPage ? 60_000 : 55_000));
    let envelope: VerificationCaptureEnvelope | undefined;
    let failure: unknown;
    for (let attempt = 1; attempt <= 2 && !envelope; attempt++) {
      try {
        const bound = captureBound();
        const captured = await budget.run(
          `capture ${side} (${tabId})`,
          () =>
            this.host.captureVerificationScreenshot!(rect, tabId, txn.paneId, {
              format: 'png',
              fullPage,
              timeoutMs: bound,
            }),
          bound + 3_000
        );
        if (captured && captured.data && captured.data.length > 0) {
          envelope = captured;
          break;
        }
        failure = new CapabilityError('TARGET_STALE', `Empty verification capture payload on ${side} tab '${tabId}'`);
      } catch (err) {
        failure = err;
      }
      if (isTargetDrainFailure(failure)) break;
      const code = (failure as { code?: string } | undefined)?.code;
      if (code !== 'CAPTURE_EMPTY_PAYLOAD' && code !== 'TARGET_STALE') break;
      if (attempt < 2) await budget.sleep(150, `capture retry (${side})`);
    }
    if (!envelope) {
      if (isTargetDrainFailure(failure)) {
        const reason = `Page.captureScreenshot did not settle within its bound on ${side} tab '${tabId}'`;
        const entry = this.quarantineTarget(txn, tabId, reason);
        // A fast recovery still yields a receipt on this result; a slow one
        // stays pending and the pair is released only by the receipt.
        const receipt = await this.awaitQuarantineReceipt(entry, Math.min(8_000, budget.cleanupBudgetMs));
        return { ok: false, code: 'TARGET_BUSY_DRAINING', reason, quarantine: receipt ?? entry.recovery };
      }
      throw failure instanceof Error
        ? failure
        : new CapabilityError('TARGET_STALE', `Failed to capture non-empty ${side} verification screenshot on tab '${tabId}'`);
    }
    envelope.expectedUrl = expectedUrl ?? null;
    envelope.expectationMarker = routeCheck.status === 'URL_EXPECTATION_MISSING' ? 'URL_EXPECTATION_MISSING' : undefined;
    envelope.missingExpectation = routeCheck.status === 'URL_EXPECTATION_MISSING' ? true : undefined;
    envelope.routeAssertion = routeCheck;
    const buffer = Buffer.from(envelope.data, 'base64');
    if (buffer.length === 0) {
      throw new CapabilityError('TARGET_STALE', `Failed to decode non-empty ${side} verification screenshot buffer on tab '${tabId}'`);
    }
    const receipt = verificationCaptureReceipt(envelope);
    let artifact: ArtifactRef | string | undefined;
    if (this.artifacts) {
      artifact = await budget.run(
        `stage ${side}`,
        async () =>
          this.artifacts!.stage({
            kind: 'screenshot',
            mime: 'image/png',
            data: buffer,
            runId,
            attemptId,
            projectId: target.projectId,
            workspaceId: target.workspaceId,
            maxBytes: 8 * 1024 * 1024,
            leaseToken: txn.leaseToken,
            overflowMode: 'reject',
          }),
        STAGE_BOUND_MS
      );
    } else {
      artifact = limit(envelope.data, 8 * 1024 * 1024);
    }
    return { ok: true, envelope, buffer, receipt, artifact };
  }

  /** Structural parity probe for one side, bounded by the remaining budget. */
  private async resolveStructuralMetrics(
    txn: CompareTransaction,
    args: { tabId: string; params: VisualCompareParams; metrics: CssMetrics | null }
  ): Promise<VisualRegionBundle | undefined> {
    const { tabId, params, metrics } = args;
    if (typeof this.host.evalJs !== 'function') return undefined;
    try {
      const rootSel = params.selector || 'body';
      const hasTracked = Array.isArray(params.trackedSelectors);
      const trackedList = hasTracked
        ? params.trackedSelectors!.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : undefined;
      const queryScript = buildStructuralQueryScript(rootSel, trackedList ?? []);
      const raw = await txn.budget.run(
        `structural probe (${tabId})`,
        () => this.host.evalJs(queryScript, tabId, txn.paneId),
        EVAL_BOUND_MS
      );
      if (!Array.isArray(raw) || (raw.length === 0 && !(trackedList && trackedList.length > 0))) return undefined;
      return normalizeVisualRegions(
        raw as RawElementSensoryData[],
        { width: metrics ? metrics.vw : 1200, height: metrics ? metrics.vh : 800 },
        1
      );
    } catch {
      return undefined;
    }
  }

  /**
   * One atomic capture attempt inside the pair transaction. Coherence gate
   * order per side: pre-inject identity (navigation span) -> reversible
   * normalization + settle -> openMutationWindow (strict DOM span) -> geometry,
   * masks, capture, stage -> post-capture check. DOM mutation in the strict span
   * returns {settle:false} (resample); navigation throws TARGET_STALE;
   * asymmetric normalization settles INCONCLUSIVE with no pixel diff.
   */
  private async executeVisualCompareAttempt(args: {
    target: BrowserTarget;
    runId: string;
    attemptId: string;
    params: VisualCompareParams;
    txn: CompareTransaction;
    requiredMasks: string[];
    optionalMasks: string[];
    attempt: number;
    maxAttempts: number;
    resampleCount: number;
  }): Promise<VisualCompareAttemptOutcome> {
    const { target, runId, attemptId, params, txn, requiredMasks, optionalMasks, attempt, maxAttempts, resampleCount } = args;
    const { tabId, compTabTarget, paneId: effectivePane } = txn;
    if (!txn.continuationValid) {
      throw new CapabilityError('TRANSACTION_CONFLICT', 'Visual compare transaction was torn down; stale continuations cannot dispatch further attempts');
    }
    // A resample re-captures the pair, so artifacts staged by the previous
    // attempt are superseded and must never be reported as this pair.
    txn.stagedTarget = undefined;
    txn.stagedBaseline = undefined;
    const settled = (body: Record<string, unknown>): VisualCompareAttemptOutcome => ({
      settle: true,
      result: this.withStagedArtifacts(txn, body),
    });

    const guard = new TwoSourceCoherenceGuard();
    const readIdentity = (t: string): CaptureIdentitySnapshot => ({
      browserEpoch: this.host.getBrowserEpoch ? this.host.getBrowserEpoch() : target.browserEpoch,
      documentGeneration: this.host.getDocumentGeneration ? this.host.getDocumentGeneration(t) : (target.documentGeneration || 1),
      mutationRevision: this.host.getMutationRevision ? this.host.getMutationRevision(t) : 1,
    });

    const targetNormalize: NormalizationReceipt = emptyNormalizationReceipt(Boolean(params.normalizeScroll));
    const compNormalize: NormalizationReceipt = emptyNormalizationReceipt(Boolean(params.normalizeScroll));
    const hasRequestedMasks = requiredMasks.length > 0 || optionalMasks.length > 0;
    let targetMasksResolved = !hasRequestedMasks;
    let compMasksResolved = !hasRequestedMasks;
    const currentMaskStatus = (): 'ok' | 'NOT_ATTEMPTED' => {
      if (!hasRequestedMasks) return 'ok';
      if (compTabTarget) return targetMasksResolved && compMasksResolved ? 'ok' : 'NOT_ATTEMPTED';
      return targetMasksResolved ? 'ok' : 'NOT_ATTEMPTED';
    };
    const scrolls = new Map<string, { x: number; y: number }>();
    let targetSettle: VisualSettleReceipt | undefined;
    let compSettle: VisualSettleReceipt | undefined;
    let targetCoh: CoherencePairCheck | undefined;
    let baselineCoh: CoherencePairCheck | null = null;
    let targetCapture: VerificationCaptureReceipt | undefined;
    let compCapture: VerificationCaptureReceipt | undefined;
    let captureStateCompatible = true;
    let targetMaskEntries: MaskResolutionEntry[] = [];
    let compMaskEntries: MaskResolutionEntry[] = [];

    const restoreScrolls = async (): Promise<void> => {
      for (const [scrollTabId, position] of Array.from(scrolls.entries())) {
        scrolls.delete(scrollTabId);
        await txn.budget.cleanup(
          `scroll restore (${scrollTabId})`,
          () =>
            this.host.evalJs(
              `window.scrollTo({ left: ${position.x}, top: ${position.y}, behavior: 'instant' })`,
              scrollTabId,
              txn.paneId
            ),
          EVAL_BOUND_MS
        );
      }
    };
    const restoreAllOwned = async (): Promise<{ ok: boolean; error?: string }> => {
      let ok = true;
      let error: string | undefined;
      const targetRestore = await this.restoreReversibleNormalization(txn, tabId);
      if (!targetRestore.ok) {
        ok = false;
        error = targetRestore.error;
      }
      if (compTabTarget) {
        const compRestore = await this.restoreReversibleNormalization(txn, compTabTarget);
        if (!compRestore.ok) {
          ok = false;
          error = error || compRestore.error;
        }
      }
      if (params.normalizeScroll) {
        if (targetNormalize.owned && !targetNormalize.restored) {
          await txn.budget.cleanup(
            `normalizeScroll restore (${tabId})`,
            async () => {
              const restored = await NormalizationTransaction.restore(this.host, tabId, txn.paneId, true);
              targetNormalize.restored = restored.ok;
              if (restored.error && !targetNormalize.restoreError) targetNormalize.restoreError = restored.error;
            },
            NORMALIZATION_RESTORE_BOUND_MS
          );
        }
        if (compTabTarget && compNormalize.owned && !compNormalize.restored) {
          await txn.budget.cleanup(
            `normalizeScroll restore (${compTabTarget})`,
            async () => {
              const restored = await NormalizationTransaction.restore(this.host, compTabTarget, txn.paneId, true);
              compNormalize.restored = restored.ok;
              if (restored.error && !compNormalize.restoreError) compNormalize.restoreError = restored.error;
            },
            NORMALIZATION_RESTORE_BOUND_MS
          );
        }
      }
      // Fail closed: an owned normalizeScroll style that is not verified as
      // restored is a leaked mutation, never a clean run.
      if (targetNormalize.owned && !targetNormalize.restored) {
        ok = false;
        error = error || targetNormalize.restoreError || `Owned normalizeScroll style on tab '${tabId}' could not be restored`;
      }
      if (compTabTarget && compNormalize.owned && !compNormalize.restored) {
        ok = false;
        error = error || compNormalize.restoreError || `Owned normalizeScroll style on tab '${compTabTarget}' could not be restored`;
      }
      await restoreScrolls();
      return { ok, error };
    };

    try {
      txn.budget.throwIfAborted('compare attempt');
      // Pre-inject identity BEFORE any normalization or tab switching: our own
      // style insertion legitimately moves mutationRevision, so the strict DOM
      // window opens after normalization instead.
      guard.recordPreInject('target', readIdentity(tabId));
      if (compTabTarget) guard.recordPreInject('baseline', readIdentity(compTabTarget));

      // ── Phase A: normalize + settle BOTH sides before any capture ──────────
      const targetPrep = await this.prepareCompareSide(txn, { tabId, params, normalizeReceipt: targetNormalize });
      if (!targetPrep.ok) {
        targetSettle = targetPrep.settle;
        const maskStatus = currentMaskStatus();
        const metricSamples = generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: maskStatus, settleComplete: false });
        return settled({
          ok: false,
          status: 'INCONCLUSIVE',
          reason: targetPrep.reason,
          match: false,
          mismatchPercentage: 100,
          totalPixels: 0,
          normalization: { target: targetNormalize, comparison: compTabTarget ? compNormalize : undefined },
          maskResolution: { status: maskStatus, maskedAreaRatio: 0, optionalUnmatched: [] },
          settle: { target: targetSettle },
          receipt: createVisualEvidenceReceipt({
            match: false,
            mismatchPercentage: 100,
            dimensionsMatch: false,
            captureStateCompatible: false,
            maskResolutionStatus: maskStatus,
            maskedAreaRatio: 0,
            settleComplete: false,
            metricSamples,
            notes: targetPrep.reason,
          }),
          metricSamples,
        });
      }
      targetSettle = targetPrep.settle;
      if (targetPrep.scroll) scrolls.set(tabId, targetPrep.scroll);
      if (compTabTarget) {
        const compPrep = await this.prepareCompareSide(txn, { tabId: compTabTarget, params, normalizeReceipt: compNormalize });
        if (!compPrep.ok) {
          compSettle = compPrep.settle;
          const maskStatus = currentMaskStatus();
          const metricSamples = generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: maskStatus, settleComplete: false });
          return settled({
            ok: false,
            status: 'INCONCLUSIVE',
            reason: compPrep.reason,
            match: false,
            mismatchPercentage: 100,
            totalPixels: 0,
            normalization: { target: targetNormalize, comparison: compNormalize },
            maskResolution: { status: maskStatus, maskedAreaRatio: 0, optionalUnmatched: [] },
            settle: { target: targetSettle, comparison: compSettle },
            receipt: createVisualEvidenceReceipt({
              match: false,
              mismatchPercentage: 100,
              dimensionsMatch: false,
              captureStateCompatible: false,
              maskResolutionStatus: maskStatus,
              maskedAreaRatio: 0,
              settleComplete: false,
              metricSamples,
              notes: compPrep.reason,
            }),
            metricSamples,
          });
        }
        compSettle = compPrep.settle;
        if (compPrep.scroll) scrolls.set(compTabTarget, compPrep.scroll);
      }

      // ── Phase B: open the strict capture windows for BOTH sides ────────────
      guard.openMutationWindow('target', readIdentity(tabId));
      if (compTabTarget) guard.openMutationWindow('baseline', readIdentity(compTabTarget));

      // ── Phase C: geometry, masks, capture, stage — target side ─────────────
      const targetMetrics = targetPrep.metrics;
      const targetRect = await this.resolveSideRect(txn, tabId, params);
      if (requiredMasks.length > 0 || optionalMasks.length > 0) {
        targetMaskEntries = await txn.budget.run(
          `mask ledger (${tabId})`,
          () => MaskLedger.resolve(this.host, tabId, effectivePane, requiredMasks, optionalMasks),
          MASK_BOUND_MS
        );
      }
      targetMasksResolved = true;
      const expectedTargetUrl = params.expectedTargetUrl ?? params.expectedUrl ?? null;
      const expectedBaselineUrl = params.expectedBaselineUrl ?? null;
      const targetStaged = await this.captureStageSide(txn, {
        side: 'target',
        tabId,
        runId,
        attemptId,
        target,
        rect: targetRect,
        fullPage: Boolean(params.fullPage),
        expectedUrl: expectedTargetUrl,
      });
      if (!targetStaged.ok) {
        const maskStatus = currentMaskStatus();
        return settled({
          ok: false,
          status: 'INCONCLUSIVE',
          reason: targetStaged.reason,
          code: targetStaged.code,
          match: false,
          mismatchPercentage: 100,
          totalPixels: 0,
          normalization: { target: targetNormalize, comparison: compTabTarget ? compNormalize : undefined },
          maskResolution: { status: maskStatus, maskedAreaRatio: 0, optionalUnmatched: [] },
          settle: { target: targetSettle, comparison: compSettle },
          quarantine: targetStaged.quarantine,
          metricSamples: generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: maskStatus, settleComplete: true }),
          receipt: createVisualEvidenceReceipt({
            match: false,
            mismatchPercentage: 100,
            dimensionsMatch: false,
            captureStateCompatible: false,
            maskResolutionStatus: maskStatus,
            maskedAreaRatio: 0,
            settleComplete: true,
            metricSamples: generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: maskStatus, settleComplete: true }),
            notes: targetStaged.reason,
          }),
        });
      }
      const curEnvelope = targetStaged.envelope;
      const curBuffer = targetStaged.buffer;
      targetCapture = targetStaged.receipt;
      txn.stagedTarget = targetStaged.artifact;
      const curArtifact = targetStaged.artifact;

      // ── Phase C: geometry, masks, capture, stage — comparison/baseline side ─
      let baselineBuffer: Buffer | null = null;
      let baselineArtifactRef = params.baselineRef || params.baselineScreenshotRef;
      let compMetrics: CssMetrics | null = null;
      let comparisonRect: { x: number; y: number; width: number; height: number } | undefined;
      if (compTabTarget) {
        compMetrics = (await this.readSideMetrics(txn, compTabTarget)) || compMetrics;
        comparisonRect = await this.resolveSideRect(txn, compTabTarget, params);
        if (requiredMasks.length > 0 || optionalMasks.length > 0) {
          compMaskEntries = await txn.budget.run(
            `mask ledger (${compTabTarget})`,
            () => MaskLedger.resolve(this.host, compTabTarget, effectivePane, requiredMasks, optionalMasks),
            MASK_BOUND_MS
          );
        }
        compMasksResolved = true;
        const compStaged = await this.captureStageSide(txn, {
          side: 'baseline',
          tabId: compTabTarget,
          runId,
          attemptId,
          target,
          rect: comparisonRect,
          fullPage: Boolean(params.fullPage),
          expectedUrl: expectedBaselineUrl,
        });
        if (!compStaged.ok) {
          const maskStatus = currentMaskStatus();
          return settled({
            ok: false,
            status: 'INCONCLUSIVE',
            reason: compStaged.reason,
            code: compStaged.code,
            match: false,
            mismatchPercentage: 100,
            totalPixels: 0,
            normalization: { target: targetNormalize, comparison: compNormalize },
            maskResolution: { status: maskStatus, maskedAreaRatio: 0, optionalUnmatched: [] },
            settle: { target: targetSettle, comparison: compSettle },
            quarantine: compStaged.quarantine,
            metricSamples: generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: maskStatus, settleComplete: true }),
            receipt: createVisualEvidenceReceipt({
              match: false,
              mismatchPercentage: 100,
              dimensionsMatch: false,
              captureStateCompatible: false,
              maskResolutionStatus: maskStatus,
              maskedAreaRatio: 0,
              settleComplete: true,
              metricSamples: generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: maskStatus, settleComplete: true }),
              notes: compStaged.reason,
            }),
          });
        }
        compCapture = compStaged.receipt;
        baselineBuffer = compStaged.buffer;
        txn.stagedBaseline = typeof compStaged.artifact === 'object' && compStaged.artifact && 'id' in compStaged.artifact
          ? (compStaged.artifact as ArtifactRef).id
          : typeof compStaged.artifact === 'string'
            ? compStaged.artifact
            : undefined;
        baselineArtifactRef = txn.stagedBaseline;
      }

      // ── Phase D: post-capture identity checks for BOTH sides ───────────────
      targetCoh = guard.check('target', readIdentity(tabId));
      if (compTabTarget) baselineCoh = guard.check('baseline', readIdentity(compTabTarget));
      if (targetCoh.identity !== 'COHERENT' || (baselineCoh && baselineCoh.identity !== 'COHERENT')) {
        throw new CapabilityError('TARGET_STALE', 'Browser or document identity changed during visual compare capture');
      }
      if (targetCoh.mutation === 'RESAMPLE' || (baselineCoh && baselineCoh.mutation === 'RESAMPLE')) {
        const nextCount = resampleCount + 1;
        if (attempt < maxAttempts) {
          return { settle: false, resampleCount: nextCount };
        }
        return settled({
          ok: false,
          status: 'INCONCLUSIVE',
          reason: `Capture transaction was never coherent across ${maxAttempts} attempts (resampleCount: ${nextCount})`,
          match: false,
          mismatchPercentage: 100,
          totalPixels: 0,
          normalization: { target: targetNormalize, comparison: compTabTarget ? compNormalize : undefined },
          maskResolution: { status: 'RESAMPLE_EXHAUSTED', maskedAreaRatio: 0, optionalUnmatched: [] },
          coherence: {
            identityCoherent: true,
            captureStateCompatible: false,
            resampleCount: nextCount,
            target: coherencePairReceipt(targetCoh),
            baseline: baselineCoh ? coherencePairReceipt(baselineCoh) : undefined,
          },
          metricSamples: generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: 'RESAMPLE_EXHAUSTED', settleComplete: true }),
          receipt: createVisualEvidenceReceipt({
            match: false,
            mismatchPercentage: 100,
            dimensionsMatch: false,
            captureStateCompatible: false,
            maskResolutionStatus: 'RESAMPLE_EXHAUSTED',
            maskedAreaRatio: 0,
            settleComplete: true,
            metricSamples: generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: 'RESAMPLE_EXHAUSTED', settleComplete: true }),
            notes: `Capture transaction was never coherent across ${maxAttempts} attempts (resampleCount: ${nextCount})`,
          }),
        });
      }
      // Asymmetric normalization cancels the pixel diff — never a numeric
      // verdict over differently normalized (incomparable) layouts.
      if (params.normalizeScroll && compTabTarget && !TwoSourceCoherenceGuard.normalizationSymmetric(targetNormalize, compNormalize)) {
        const metricSamples = generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: 'NORMALIZATION_ASYMMETRIC', settleComplete: true });
        return settled({
          ok: false,
          status: 'INCONCLUSIVE',
          reason: `Normalization is asymmetric across the pair (target owned=${targetNormalize.owned} injectError=${targetNormalize.injectError || 'none'}; comparison owned=${compNormalize.owned} injectError=${compNormalize.injectError || 'none'}) — pixel diff cancelled`,
          match: false,
          mismatchPercentage: 100,
          totalPixels: 0,
          normalization: { target: targetNormalize, comparison: compNormalize },
          maskResolution: { status: 'NORMALIZATION_ASYMMETRIC', maskedAreaRatio: 0, optionalUnmatched: [] },
          coherence: {
            identityCoherent: targetCoh.identity === 'COHERENT' && (!baselineCoh || baselineCoh.identity === 'COHERENT'),
            captureStateCompatible: false,
            resampleCount,
            normalizationSymmetric: false,
            target: coherencePairReceipt(targetCoh),
            baseline: baselineCoh ? coherencePairReceipt(baselineCoh) : undefined,
          },
          metricSamples,
          receipt: createVisualEvidenceReceipt({
            match: false,
            mismatchPercentage: 100,
            dimensionsMatch: false,
            captureStateCompatible: false,
            maskResolutionStatus: 'NORMALIZATION_ASYMMETRIC',
            maskedAreaRatio: 0,
            settleComplete: true,
            metricSamples,
            notes: 'Normalization is asymmetric across the pair — pixel diff cancelled',
          }),
        });
      }

      // ── Phase E: resolve the authoritative baseline buffer ─────────────────
      if (params.baselineRef) {
        if (!target.workspaceId) {
          throw new CapabilityError('WORKSPACE_UNBOUND', 'Explicit workspace context required to resolve baseline');
        }
        const { ref: baseRef, data: baseBytes } = this.baselineAuthority.resolve(params.baselineRef, {
          workspaceId: target.workspaceId,
          projectId: target.projectId,
        });
        const compat = this.baselineAuthority.verifyCaptureCompatibility(baseRef, targetCapture!);
        if (!compat.compatible) {
          if (compat.reason?.includes('Capture backend switched')) {
            throw new CapabilityError('CAPTURE_BACKEND_SWITCH', compat.reason);
          }
          captureStateCompatible = false;
          const maskStatus = currentMaskStatus();
          const metricSamples = generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: maskStatus, settleComplete: true });
          return settled({
            ok: false,
            status: 'INCONCLUSIVE',
            reason: `Promoted baseline capture state mismatch: ${compat.reason}`,
            match: false,
            mismatchPercentage: 100,
            totalPixels: 0,
            normalization: { target: targetNormalize },
            maskResolution: { status: maskStatus, maskedAreaRatio: 0, optionalUnmatched: [] },
            coherence: {
              identityCoherent: targetCoh.identity === 'COHERENT',
              captureStateCompatible: false,
              resampleCount,
              target: coherencePairReceipt(targetCoh),
            },
            captureStateCompatible: false,
            captureReceipts: {
              target: targetCapture!,
              baseline: baselineCaptureReceipt(baseRef.captureStateMini, baseRef.promotedAt, baseBytes),
            },
            receipt: createVisualEvidenceReceipt({
              match: false,
              mismatchPercentage: 100,
              dimensionsMatch: false,
              captureStateCompatible: false,
              maskResolutionStatus: maskStatus,
              maskedAreaRatio: 0,
              settleComplete: true,
              metricSamples,
              notes: `Promoted baseline capture state mismatch: ${compat.reason}`,
            }),
            metricSamples,
          });
        }
        baselineBuffer = baseBytes;
        baselineArtifactRef = baseRef.id;
        txn.stagedBaseline = baseRef.id;
        compCapture = baselineCaptureReceipt(baseRef.captureStateMini, baseRef.promotedAt, baseBytes);
      } else if (params.baselineScreenshotRef) {
        // Stored baselines lack authoritative verification receipts until Phase 6
        // baseline authority certification.
        captureStateCompatible = false;
        const metricSamples = generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: 'ok', settleComplete: true });
        return settled({
          ok: false,
          status: 'INCONCLUSIVE',
          reason: `Stored baseline comparison against '${params.baselineScreenshotRef}' is inconclusive: baseline capture state is unverified pending Phase 6 baseline authority certification`,
          match: false,
          mismatchPercentage: 100,
          totalPixels: 0,
          normalization: { target: targetNormalize },
          maskResolution: { status: 'ok', maskedAreaRatio: 0, optionalUnmatched: [] },
          coherence: {
            identityCoherent: targetCoh.identity === 'COHERENT',
            captureStateCompatible: false,
            resampleCount,
            target: coherencePairReceipt(targetCoh),
          },
          captureStateCompatible: false,
          captureReceipts: { target: targetCapture! },
          receipt: createVisualEvidenceReceipt({
            match: false,
            mismatchPercentage: 100,
            dimensionsMatch: false,
            captureStateCompatible: false,
            maskResolutionStatus: 'ok',
            maskedAreaRatio: 0,
            settleComplete: true,
            metricSamples,
            notes: `Stored baseline comparison against '${params.baselineScreenshotRef}' is inconclusive: baseline capture state is unverified pending Phase 6 baseline authority certification`,
          }),
          metricSamples,
        });
      }

      if (!baselineBuffer) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Failed to acquire baseline image buffer for comparison');
      }
      // Capture State Compatibility & Backend Switch Guard
      if (compCapture && compTabTarget) {
        if (curEnvelope.backend !== compCapture.backend) {
          throw new CapabilityError('CAPTURE_BACKEND_SWITCH', `Capture backend switched between target ('${curEnvelope.backend}') and baseline ('${compCapture.backend}')`);
        }
        const compat = checkCaptureStateCompatibility(targetCapture!, compCapture);
        if (!compat.compatible) {
          captureStateCompatible = false;
          const metricSamples = generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: 'ok', settleComplete: true });
          return settled({
            ok: false,
            status: 'INCONCLUSIVE',
            reason: `Capture state mismatch: ${compat.reason}`,
            match: false,
            mismatchPercentage: 100,
            totalPixels: 0,
            normalization: { target: targetNormalize, comparison: compNormalize },
            maskResolution: { status: 'ok', maskedAreaRatio: 0, optionalUnmatched: [] },
            coherence: {
              identityCoherent: targetCoh.identity === 'COHERENT' && (!baselineCoh || baselineCoh.identity === 'COHERENT'),
              captureStateCompatible: false,
              resampleCount,
              target: coherencePairReceipt(targetCoh),
              baseline: baselineCoh ? coherencePairReceipt(baselineCoh) : undefined,
            },
            captureStateCompatible: false,
            captureReceipts: { target: targetCapture!, baseline: compCapture },
            receipt: createVisualEvidenceReceipt({
              match: false,
              mismatchPercentage: 100,
              dimensionsMatch: false,
              captureStateCompatible: false,
              maskResolutionStatus: 'ok',
              maskedAreaRatio: 0,
              settleComplete: true,
              metricSamples,
              notes: `Capture state mismatch: ${compat.reason}`,
            }),
            metricSamples,
          });
        }
      }

      // ── Phase F: restore every owned mutation BEFORE any verdict ───────────
      const restoreOutcome = await restoreAllOwned();
      if (!restoreOutcome.ok) {
        const metricSamples = generateVisualMetricSamples({ captureStateCompatible: false, maskResolutionStatus: 'NORMALIZATION_RESTORE_FAILED', settleComplete: true });
        return settled({
          ok: false,
          status: 'NORMALIZATION_RESTORE_FAILED',
          reason: `Owned style restore could not be verified (target: ${targetNormalize.restoreError || restoreOutcome.error || 'unknown'}, comparison: ${compNormalize.restoreError || 'n/a'})`,
          match: false,
          mismatchPercentage: 100,
          totalPixels: 0,
          normalization: { target: targetNormalize, comparison: compTabTarget ? compNormalize : undefined },
          maskResolution: { status: 'NORMALIZATION_RESTORE_FAILED', maskedAreaRatio: 0, optionalUnmatched: [] },
          captureStateCompatible: Boolean(captureStateCompatible),
          captureReceipts: targetCapture ? { target: targetCapture, baseline: compCapture } : undefined,
          coherence: {
            identityCoherent: targetCoh.identity === 'COHERENT' && (!baselineCoh || baselineCoh.identity === 'COHERENT'),
            captureStateCompatible: true,
            resampleCount,
            target: coherencePairReceipt(targetCoh),
            baseline: baselineCoh ? coherencePairReceipt(baselineCoh) : undefined,
          },
          metricSamples,
          receipt: createVisualEvidenceReceipt({
            match: false,
            mismatchPercentage: 100,
            dimensionsMatch: false,
            captureStateCompatible: false,
            maskResolutionStatus: 'NORMALIZATION_RESTORE_FAILED',
            maskedAreaRatio: 0,
            settleComplete: true,
            metricSamples,
            notes: 'Owned reversible normalization could not be restored',
          }),
        });
      }

      // ── Phase G: structural + pixel comparison of the EXACT staged buffers ─
      const getPngDims = (buf: Buffer): { width: number; height: number } | null => {
        if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
          return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        return null;
      };
      const curDims = getPngDims(curBuffer);
      const baseDims = getPngDims(baselineBuffer);
      if (curDims && baseDims && baseDims.height > 0) {
        const heightDelta = Math.abs(curDims.height - baseDims.height) / baseDims.height;
        const effectiveHeightTolerance = typeof params.heightTolerance === 'number' && Number.isFinite(params.heightTolerance)
          ? Math.max(0.01, Math.min(1.0, params.heightTolerance))
          : 0.10;
        const allowHeightDrift = Boolean(params.allowHeightDrift);
        if (!allowHeightDrift && heightDelta > effectiveHeightTolerance) {
          const metricSamples = generateVisualMetricSamples({
            diffResult: { match: false, mismatchPercentage: 100, dimensionsMatch: false },
            captureStateCompatible: Boolean(captureStateCompatible),
            maskResolutionStatus: 'ok',
            settleComplete: true,
            structural: { geometryWithinTolerance: false, deltaGeometry: Math.abs(curDims.height - baseDims.height) },
          });
          return settled({
            match: false,
            mismatchPercentage: 100,
            verdict: 'STRUCTURAL_TRUNCATION_DETECTED',
            reason: `Structural height mismatch exceeds ${(effectiveHeightTolerance * 100).toFixed(0)}% tolerance (current: ${curDims.height}px, baseline: ${baseDims.height}px, delta: ${(heightDelta * 100).toFixed(1)}%). Potential DOM truncation or viewport-only capture detected. Pass allowHeightDrift: true or adjust heightTolerance to compare pages with differing article/product content counts.`,
            dimensions: {
              visual: { verdict: 'FAIL', mismatchPercentage: 100, heightRatio: curDims.height / baseDims.height },
              layout: { verdict: 'FAIL', currentHeight: curDims.height, baselineHeight: baseDims.height, deltaPx: Math.abs(curDims.height - baseDims.height) },
            },
            normalization: { target: targetNormalize, comparison: compTabTarget ? compNormalize : undefined },
            captureStateCompatible: Boolean(captureStateCompatible),
            captureReceipts: targetCapture ? { target: targetCapture, baseline: compCapture } : undefined,
            coherence: {
              identityCoherent: targetCoh.identity === 'COHERENT' && (!baselineCoh || baselineCoh.identity === 'COHERENT'),
              captureStateCompatible: Boolean(captureStateCompatible),
              resampleCount,
              target: coherencePairReceipt(targetCoh),
              baseline: baselineCoh ? coherencePairReceipt(baselineCoh) : undefined,
            },
            receipt: createVisualEvidenceReceipt({
              match: false,
              mismatchPercentage: 100,
              dimensionsMatch: false,
              captureStateCompatible: Boolean(captureStateCompatible),
              maskResolutionStatus: 'ok',
              maskedAreaRatio: 0,
              settleComplete: true,
              metricSamples,
              notes: `Structural height mismatch exceeds tolerance (current: ${curDims.height}px, baseline: ${baseDims.height}px, delta: ${(heightDelta * 100).toFixed(1)}%)`,
            }),
            metricSamples,
          });
        }
      }

      // Per-side measured spaces (captured-CSS-width denominator, per-axis scale)
      const targetVw = targetMetrics?.vw || curEnvelope.cssViewport?.width || curDims?.width || 1200;
      const targetVh = targetMetrics?.vh || curEnvelope.cssViewport?.height || curDims?.height || 800;
      const targetDh = targetMetrics?.dh || targetVh;
      const targetSpace = curDims
        ? visualCaptureSpaceFromMeasured({
            pngWidth: curDims.width,
            pngHeight: curDims.height,
            cssViewportWidth: targetVw,
            cssViewportHeight: targetVh,
            cssDocumentHeight: targetDh,
            scrollX: targetMetrics?.sx || 0,
            scrollY: targetMetrics?.sy || 0,
            fullPage: Boolean(params.fullPage),
            crop: Boolean(params.fullPage) ? undefined : targetRect,
          })
        : null;
      const targetMask = targetMaskEntries.length > 0
        ? materializeRasterMasks(targetMaskEntries, targetSpace, curDims ? curDims.width : 0, curDims ? curDims.height : 0)
        : emptyMaskLedgerResult();
      let compMask = emptyMaskLedgerResult();
      if (compTabTarget) {
        const compVw = compMetrics?.vw || compCapture?.cssViewport?.width || baseDims?.width || 1200;
        const compVh = compMetrics?.vh || compCapture?.cssViewport?.height || baseDims?.height || 800;
        const compDh = compMetrics?.dh || compVh;
        const compSpace = baseDims
          ? visualCaptureSpaceFromMeasured({
              pngWidth: baseDims.width,
              pngHeight: baseDims.height,
              cssViewportWidth: compVw,
              cssViewportHeight: compVh,
              cssDocumentHeight: compDh,
              scrollX: compMetrics?.sx || 0,
              scrollY: compMetrics?.sy || 0,
              fullPage: Boolean(params.fullPage),
              crop: Boolean(params.fullPage) ? undefined : comparisonRect,
            })
          : null;
        compMask = compMaskEntries.length > 0
          ? materializeRasterMasks(compMaskEntries, compSpace, baseDims ? baseDims.width : 0, baseDims ? baseDims.height : 0)
          : emptyMaskLedgerResult();
      }
      const maskBoxes = [...targetMask.maskBoxes, ...compMask.maskBoxes];
      const maskedAreaRatio = Math.max(targetMask.maskedAreaRatio, compMask.maskedAreaRatio);

      const tolerance = typeof params.tolerance === 'number' ? params.tolerance : 5.0;
      const diffResult = computePixelDiff(curBuffer, baselineBuffer, tolerance, maskBoxes);

      let structuralMetrics: VisualStructuralMetrics | undefined = undefined;
      const targetRegions = await this.resolveStructuralMetrics(txn, { tabId, params, metrics: targetMetrics });
      if (targetRegions && compTabTarget) {
        const compRegions = await this.resolveStructuralMetrics(txn, { tabId: compTabTarget, params, metrics: compMetrics });
        if (compRegions) {
          const hasTracked = Array.isArray(params.trackedSelectors);
          const trackedList = hasTracked
            ? params.trackedSelectors!.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            : undefined;
          const isMobileOrTablet = (compMetrics?.vw ?? targetMetrics?.vw ?? 1440) <= 1024;
          const effectiveMaxTolY = typeof params.maxGeometryDeltaYPx === 'number'
            ? params.maxGeometryDeltaYPx
            : typeof params.maxGeometryDeltaPx === 'number'
            ? params.maxGeometryDeltaPx
            : (isMobileOrTablet && diffResult.match ? 16 : undefined);
          const effectiveMaxTolX = typeof params.maxGeometryDeltaXPx === 'number'
            ? params.maxGeometryDeltaXPx
            : typeof params.maxGeometryDeltaPx === 'number'
            ? params.maxGeometryDeltaPx
            : undefined;
          const structRes = computeStructuralMetrics(targetRegions, compRegions, {
            trackedSelectors: trackedList,
            maxGeometryDeltaPx: params.maxGeometryDeltaPx,
            maxGeometryDeltaXPx: effectiveMaxTolX,
            maxGeometryDeltaYPx: effectiveMaxTolY,
          });
          structuralMetrics = {
            geometryWithinTolerance: structRes.geometryWithinTolerance,
            deltaGeometry: structRes.deltaGeometry,
            cardinalityMatch: structRes.cardinalityMatch,
            deltaCardinality: structRes.deltaCardinality,
            groups: structRes.groups,
          };
        }
      }
      const metricSamples = generateVisualMetricSamples({
        diffResult,
        captureStateCompatible: Boolean(captureStateCompatible),
        maskResolutionStatus: 'ok',
        settleComplete: Boolean(targetSettle?.settleComplete && (!compSettle || compSettle.settleComplete)),
        structural: structuralMetrics,
      });

      // Structural primacy: a cardinality/grid/geometry mismatch is authoritative
      // and cannot be masked away or hidden behind a low pixel diff.
      const structuralParityFailed = Boolean(
        structuralMetrics &&
          (structuralMetrics.cardinalityMatch === false || structuralMetrics.geometryWithinTolerance === false)
      );
      const structuralReason = structuralParityFailed && structuralMetrics
        ? `Structural parity mismatch (cardinalityMatch=${structuralMetrics.cardinalityMatch}, deltaCardinality=${structuralMetrics.deltaCardinality ?? 'n/a'}, geometryWithinTolerance=${structuralMetrics.geometryWithinTolerance}, deltaGeometry=${structuralMetrics.deltaGeometry ?? 'n/a'}px) — structural mismatch cannot pass through masks or a low pixel diff`
        : undefined;
      const verdictMatch = diffResult.match && !structuralParityFailed;
      const verdictNotes = structuralParityFailed
        ? structuralReason!
        : diffResult.match
          ? 'Visual comparison passed within tolerance'
          : `Visual discrepancies detected (${diffResult.mismatchPercentage}% mismatch exceeds ${tolerance}% tolerance)`;

      const missingTargetExpectation = targetCapture?.expectationMarker === 'URL_EXPECTATION_MISSING';
      const missingCompExpectation = compCapture?.expectationMarker === 'URL_EXPECTATION_MISSING';
      const hasMissingExpectation = missingTargetExpectation || missingCompExpectation;

      if (hasMissingExpectation) {
        return settled({
          ok: false,
          status: 'INCONCLUSIVE',
          code: 'URL_EXPECTATION_MISSING',
          reason: 'Cannot publish verdict: capture identity was not asserted against an expected route (URL_EXPECTATION_MISSING)',
          match: false,
          mismatchPercentage: 100,
          totalPixels: diffResult.totalPixels,
          dimensionsMatch: diffResult.dimensionsMatch,
          normalization: { target: targetNormalize, comparison: compTabTarget ? compNormalize : undefined },
          maskResolution: {
            status: 'ok',
            maskedAreaRatio,
            target: { maskedAreaRatio: targetMask.maskedAreaRatio },
            baseline: compTabTarget ? { maskedAreaRatio: compMask.maskedAreaRatio } : undefined,
          },
          captureStateCompatible: false,
          captureReceipts: targetCapture ? { target: targetCapture, baseline: compCapture } : undefined,
          routeAssertions: {
            target: targetCapture?.routeAssertion,
            baseline: compCapture?.routeAssertion,
          },
          settle: targetSettle ? { target: targetSettle, comparison: compSettle } : undefined,
          notes: 'URL_EXPECTATION_MISSING: capture identity was not asserted against an expected route',
          receipt: createVisualEvidenceReceipt({
            match: false,
            mismatchPercentage: 100,
            dimensionsMatch: diffResult.dimensionsMatch,
            captureStateCompatible: false,
            maskResolutionStatus: 'ok',
            maskedAreaRatio,
            settleComplete: Boolean(targetSettle?.settleComplete && (!compSettle || compSettle.settleComplete)),
            metricSamples,
            expectationMarker: 'URL_EXPECTATION_MISSING',
            missingExpectation: true,
            notes: 'URL_EXPECTATION_MISSING: capture identity was not asserted against an expected route',
          }),
          metricSamples,
        });
      }

      return settled({
        ok: verdictMatch,
        status: verdictMatch ? 'PASS' : 'FAIL',
        match: verdictMatch,
        mismatchPercentage: diffResult.mismatchPercentage,
        // The raw differing-pixel count is part of the published compare evidence: the report layer
        // cross-checks mismatchPercentage against diffPixels/totalPixels, and the canary evidence
        // writer records it per section. It is emitted only on a verdict-bearing result, never on a
        // settled non-verdict (INCONCLUSIVE), where no diff may be read as evidence.
        diffPixels: diffResult.diffPixels,
        totalPixels: diffResult.totalPixels,
        dimensionsMatch: diffResult.dimensionsMatch,
        normalization: { target: targetNormalize, comparison: compTabTarget ? compNormalize : undefined },
        maskResolution: {
          status: 'ok',
          maskedAreaRatio,
          optionalUnmatched: [...targetMask.optionalUnmatched, ...compMask.optionalUnmatched],
          target: {
            entries: targetMask.entries.map(maskEntryReceipt),
            maskedAreaRatio: targetMask.maskedAreaRatio,
          },
          baseline: compTabTarget
            ? {
                entries: compMask.entries.map(maskEntryReceipt),
                maskedAreaRatio: compMask.maskedAreaRatio,
              }
            : undefined,
        },
        captureStateCompatible: true,
        captureReceipts: targetCapture ? { target: targetCapture, baseline: compCapture } : undefined,
        routeAssertions: {
          target: targetCapture?.routeAssertion,
          baseline: compCapture?.routeAssertion,
        },
        coherence: {
          identityCoherent: true,
          captureStateCompatible: true,
          resampleCount,
          target: coherencePairReceipt(targetCoh),
          baseline: baselineCoh ? coherencePairReceipt(baselineCoh) : undefined,
        },
        settle: targetSettle ? { target: targetSettle, comparison: compSettle } : undefined,
        structural: structuralMetrics,
        notes: verdictNotes,
        receipt: createVisualEvidenceReceipt({
          match: verdictMatch,
          mismatchPercentage: diffResult.mismatchPercentage,
          dimensionsMatch: diffResult.dimensionsMatch,
          captureStateCompatible: Boolean(captureStateCompatible),
          maskResolutionStatus: 'ok',
          maskedAreaRatio,
          settleComplete: Boolean(targetSettle?.settleComplete && (!compSettle || compSettle.settleComplete)),
          metricSamples,
          routeAssertion: targetCapture?.routeAssertion,
          notes: verdictNotes,
        }),
        metricSamples,
      });
    } catch (err: unknown) {
      if (err instanceof MaskResolutionError) {
        const metricSamples = generateVisualMetricSamples({
          captureStateCompatible: false,
          maskResolutionStatus: err.status,
          settleComplete: true,
        });
        return settled({
          ok: false,
          status: err.status,
          reason: err.message,
          match: false,
          mismatchPercentage: 100,
          totalPixels: 0,
          normalization: { target: targetNormalize, comparison: compTabTarget ? compNormalize : undefined },
          maskResolution: { status: err.status, reason: err.message, maskedAreaRatio: err.maskedAreaRatio, entries: err.entries.map(maskEntryReceipt) },
          captureStateCompatible: Boolean(captureStateCompatible),
          captureReceipts: targetCapture ? { target: targetCapture, baseline: compCapture } : undefined,
          coherence: {
            identityCoherent: targetCoh ? targetCoh.identity === 'COHERENT' && (!baselineCoh || baselineCoh.identity === 'COHERENT') : false,
            captureStateCompatible: false,
            resampleCount,
            target: targetCoh ? coherencePairReceipt(targetCoh) : undefined,
            baseline: baselineCoh ? coherencePairReceipt(baselineCoh) : undefined,
          },
          receipt: createVisualEvidenceReceipt({
            match: false,
            mismatchPercentage: 100,
            dimensionsMatch: false,
            captureStateCompatible: false,
            maskResolutionStatus: err.status,
            maskedAreaRatio: err.maskedAreaRatio,
            settleComplete: true,
            metricSamples,
            notes: err.message,
          }),
          metricSamples,
        });
      }
      if (err instanceof CapabilityError) {
        const maskStatus = currentMaskStatus();
        const metricSamples = generateVisualMetricSamples({
          captureStateCompatible: false,
          maskResolutionStatus: maskStatus,
          settleComplete: err.code !== 'RESOURCE_FAILURE',
        });
        const receipt = createVisualEvidenceReceipt({
          match: false,
          mismatchPercentage: 100,
          dimensionsMatch: false,
          captureStateCompatible: false,
          maskResolutionStatus: maskStatus,
          maskedAreaRatio: 0,
          settleComplete: err.code !== 'RESOURCE_FAILURE',
          metricSamples,
          notes: err.message,
        });
        const enriched: { metricSamples?: unknown; receipt?: unknown; details?: Record<string, unknown> } = err;
        enriched.metricSamples = metricSamples;
        enriched.receipt = receipt;
        enriched.details = enriched.details
          ? { ...enriched.details, metricSamples, receipt }
          : { metricSamples, receipt };
      }
      throw err;
    } finally {
      // Restoration also runs when the attempt throws or resamples; the receipt
      // flags and consumed txn entries make every call idempotent, and only
      // resources acquired by this invocation token are touched.
      await restoreAllOwned();
    }
  }

  async freezeMedia(
    target: BrowserTarget,
    params: { freeze?: boolean; normalizeSliders?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' } = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<{ frozen: boolean; mediaCount: number; tabId: string }> {
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';
    const freeze = params.freeze !== false;
    await this.assertRenderSurface(tabId, effectivePane, 'anti.media.freeze');
    return this.passivePool.execute(tabId, async () => {
      const normalizeSliders = Boolean(params.normalizeSliders);
      const script = injectedScriptStore.getScript('media.freeze', { freeze, normalizeSliders });
      const res = (await this.host.evalJs(script, tabId, effectivePane)) as { frozen?: boolean; mediaCount?: number } | undefined;
      if (!res || typeof res !== 'object') {
        throw new CapabilityError('TARGET_STALE', `Failed to execute freezeMedia on tab ${tabId}`);
      }
      return {
        frozen: Boolean(res.frozen),
        mediaCount: Number(res.mediaCount || 0),
        tabId,
      };
    });
  }
  async pageInventory(
    target: BrowserTarget,
    params: { tabId?: string; paneId?: 'desktop' | 'mobile' } = {},
    explicitTabId?: string,
    paneId?: 'desktop' | 'mobile'
  ): Promise<{ scrollHeight: number; viewportHeight: number; sections: Array<{ index: number; id?: string; tag: string; selector: string; y: number; height: number; group: string; heading?: string }>; tabId: string }> {
    const tabId = this.resolveTargetTab(target, explicitTabId || params.tabId);
    const effectivePane = paneId || params.paneId || 'desktop';
    return this.passivePool.execute(tabId, async () => {
      const script = `(() => {
        const scrollHeight = Math.max(
          document.documentElement ? document.documentElement.scrollHeight : 0,
          document.body ? document.body.scrollHeight : 0,
          document.scrollingElement ? document.scrollingElement.scrollHeight : 0
        );
        const viewportHeight = window.innerHeight;
        const candidateElements = Array.from(
          document.querySelectorAll('header, [class*="header"], main > *, aside, [class*="newsletter"], footer, [class*="footer"], [id^="shopify-section-"], [data-autoplay], [data-dot], .swiper, .slick-slider, .owl-carousel, .s-wrap, [class*="slider"], [class*="carousel"]')
        );
        const seenRects = new Set();
        const rawSections = [];
        for (let i = 0; i < candidateElements.length; i++) {
          const el = candidateElements[i];
          let rect = el.getBoundingClientRect();
          // Handle display: contents where parent rect is 0 but children have geometry
          if ((rect.width === 0 || rect.height === 0) && el.children.length > 0) {
            let minTop = Infinity, maxBottom = -Infinity, maxW = 0;
            for (let c = 0; c < el.children.length; c++) {
              const cr = el.children[c].getBoundingClientRect();
              if (cr.width > 0 && cr.height > 0) {
                if (cr.top < minTop) minTop = cr.top;
                if (cr.bottom > maxBottom) maxBottom = cr.bottom;
                if (cr.width > maxW) maxW = cr.width;
              }
            }
            if (minTop !== Infinity && maxBottom !== -Infinity) {
              rect = { top: minTop, height: maxBottom - minTop, width: maxW };
            }
          }
          if (rect.width < 5 || rect.height < 5) continue;
          const absY = Math.round(rect.top + window.scrollY);
          const absH = Math.round(rect.height);
          if (absH < 20) continue;
          const key = absY + '_' + absH;
          if (seenRects.has(key)) continue;
          seenRects.add(key);
          let group = 'main-content';
          const elId = (el.id || '').toLowerCase();
          const elCls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
          if (el.closest('header') || elCls.includes('announcement') || elId.includes('header')) {
            group = 'header-group';
          } else if (el.closest('footer') || elId.includes('footer') || elCls.includes('newsletter') || elId.includes('newsletter')) {
            group = 'footer-group';
          } else if (el.hasAttribute('data-autoplay') || el.hasAttribute('data-dot') || elCls.includes('slider') || elCls.includes('carousel') || elCls.includes('swiper') || elCls.includes('slick') || elCls.includes('s-wrap')) {
            group = 'carousel-component';
          }
          let heading = undefined;
          const h = el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], [class*="heading"], [class*="title"], [data-heading]');
          if (h) {
            heading = (h.getAttribute('data-heading') || h.getAttribute('aria-label') || h.textContent || '').trim().slice(0, 80);
          } else if (el.getAttribute('aria-label')) {
            heading = el.getAttribute('aria-label').trim().slice(0, 80);
          }
          let selector = el.tagName.toLowerCase();
          if (el.id) {
            selector = '#' + el.id;
          } else if (elCls.trim()) {
            const firstClass = elCls.trim().split(/\\s+/)[0];
            if (firstClass) selector = el.tagName.toLowerCase() + '.' + firstClass;
          }
          rawSections.push({
            id: el.id || undefined,
            tag: el.tagName.toLowerCase(),
            selector,
            y: absY,
            height: absH,
            group,
            heading: heading || undefined,
          });
        }
        rawSections.sort((a, b) => a.y - b.y);
        const sections = rawSections.map((s, idx) => ({ index: idx, ...s }));
        return { scrollHeight, viewportHeight, sections };
      })()`;
      const res = (await this.host.evalJs(script, tabId, effectivePane)) as { scrollHeight?: number; viewportHeight?: number; sections?: Array<any> } | undefined;
      return {
        scrollHeight: res?.scrollHeight || 0,
        viewportHeight: res?.viewportHeight || 1006,
        sections: res?.sections || [],
        tabId,
      };
    });
  }
  async styleDiff(
    target: BrowserTarget,
    params: { selector: string; comparisonSelector?: string; tabId?: string; comparisonTabId?: string; properties?: string[] }
  ): Promise<{ selector: string; comparisonSelector: string; differences: Record<string, { tab1: string; tab2: string; status: 'MATCH' | 'MISMATCH' | 'MISSING' }>; match: boolean }> {
    if (!params.selector) throw new CapabilityError('INVALID_ARGUMENT', 'selector is required for styleDiff');
    const tab1Id = this.resolveTargetTab(target, params.tabId);
    const tab2Id = this.resolveTargetTab(target, params.comparisonTabId);
    const compSelector = params.comparisonSelector || params.selector;
    const props = Array.isArray(params.properties) && params.properties.length > 0
      ? params.properties
      : ['width', 'height', 'padding', 'margin', 'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border', 'border-radius', 'box-shadow', 'display', 'position'];
    const normalizeVal = (prop: string, val: string): string => {
      let clean = val.trim().toLowerCase();
      clean = clean.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*1(?:\.0)?\s*\)/g, 'rgb($1, $2, $3)');
      clean = clean.replace(/,\s*/g, ', ');
      if (prop === 'font-family') {
        clean = clean.replace(/['"]/g, '');
        // If primary font family matches, consider compatible
        const primary = clean.split(',')[0]?.trim();
        if (primary) return primary;
      }
      clean = clean.replace(/\b0px\b/g, '0');
      return clean;
    };
    const getStylesScript = (sel: string) => `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const comp = window.getComputedStyle(el);
      const props = ${JSON.stringify(props)};
      const out = {};
      for (const p of props) {
        out[p] = comp.getPropertyValue(p);
      }
      return out;
    })()`;
    const styles1 = (await this.host.evalJs(getStylesScript(params.selector), tab1Id)) as Record<string, string> | null;
    const styles2 = (await this.host.evalJs(getStylesScript(compSelector), tab2Id)) as Record<string, string> | null;
    const differences: Record<string, { tab1: string; tab2: string; status: 'MATCH' | 'MISMATCH' | 'MISSING' }> = {};
    let allMatch = true;
    for (const p of props) {
      const raw1 = styles1 ? (styles1[p] || '') : 'NOT_FOUND';
      const raw2 = styles2 ? (styles2[p] || '') : 'NOT_FOUND';
      let status: 'MATCH' | 'MISMATCH' | 'MISSING' = 'MATCH';
      if (!styles1 || !styles2 || raw1 === 'NOT_FOUND' || raw2 === 'NOT_FOUND') {
        status = 'MISSING';
        allMatch = false;
      } else {
        const n1 = normalizeVal(p, raw1);
        const n2 = normalizeVal(p, raw2);
        if (n1 !== n2) {
          status = 'MISMATCH';
          allMatch = false;
        }
      }
      differences[p] = { tab1: raw1, tab2: raw2, status };
    }
    return {
      selector: params.selector,
      comparisonSelector: compSelector,
      differences,
      match: allMatch,
    };
  }
  async validateSpecGate(
    target: BrowserTarget,
    params: { specTabId?: string; targetTabId?: string; tolerance?: number } = {},
    signal?: AbortSignal
  ): Promise<{ passed: boolean; score: number; criticalCount: number; checklist: Record<string, { status: 'PASS' | 'FAIL' | 'WARN'; message: string; details?: unknown }> }> {
    if (signal?.aborted) {
      throw new CapabilityError('WAIT_ABORTED', 'Validation gate was aborted by execution control signal');
    }
    const specTabId = this.resolveTargetTab(target, params.specTabId || '@spec');
    const targetTabId = this.resolveTargetTab(target, params.targetTabId || target?.tabId || '@storefront');
    const tolerance = typeof params.tolerance === 'number' ? params.tolerance : 5.0;
    const checklist: Record<string, { status: 'PASS' | 'FAIL' | 'WARN'; message: string; details?: unknown }> = {};
    let criticalCount = 0;
    const specInv = await this.pageInventory(target, { tabId: specTabId });
    const targetInv = await this.pageInventory(target, { tabId: targetTabId });
    if (targetInv.sections.length === 0 || specInv.sections.length === 0) {
      checklist.structuralSections = {
        status: 'FAIL',
        message: `Invalid section count: target has ${targetInv.sections.length} sections, spec has ${specInv.sections.length} sections`,
        details: { specCount: specInv.sections.length, targetCount: targetInv.sections.length },
      };
      criticalCount++;
    } else if (specInv.sections.length < targetInv.sections.length) {
      checklist.structuralSections = {
        status: 'FAIL',
        message: `Spec missing sections: spec has ${specInv.sections.length} sections vs target ${targetInv.sections.length}`,
        details: { specCount: specInv.sections.length, targetCount: targetInv.sections.length },
      };
      criticalCount++;
    } else {
      checklist.structuralSections = {
        status: 'PASS',
        message: `Section count parity passed: ${specInv.sections.length} sections`,
        details: { specCount: specInv.sections.length, targetCount: targetInv.sections.length },
      };
    }
    if (targetInv.scrollHeight <= 0 || specInv.scrollHeight <= 0) {
      checklist.heightParity = {
        status: 'FAIL',
        message: `Invalid height measurement: target height is ${targetInv.scrollHeight}px, spec height is ${specInv.scrollHeight}px`,
        details: { specHeight: specInv.scrollHeight, targetHeight: targetInv.scrollHeight, tolerance },
      };
      criticalCount++;
    } else {
      const maxDelta = (tolerance > 0 ? tolerance : 5.0) / 100;
      const heightDelta = Math.abs(specInv.scrollHeight - targetInv.scrollHeight) / targetInv.scrollHeight;
      const EPSILON = 1e-6;
      if (heightDelta - maxDelta > EPSILON) {
        checklist.heightParity = {
          status: 'FAIL',
          message: `Height mismatch delta ${(heightDelta * 100).toFixed(1)}% exceeds ${tolerance}% threshold (${specInv.scrollHeight}px vs ${targetInv.scrollHeight}px)`,
          details: { specHeight: specInv.scrollHeight, targetHeight: targetInv.scrollHeight, deltaPercent: Number((heightDelta * 100).toFixed(1)), tolerance },
        };
        criticalCount++;
      } else {
        checklist.heightParity = {
          status: 'PASS',
          message: `Height parity passed: delta ${(heightDelta * 100).toFixed(1)}% <= ${tolerance}% (${specInv.scrollHeight}px vs ${targetInv.scrollHeight}px)`,
          details: { specHeight: specInv.scrollHeight, targetHeight: targetInv.scrollHeight, deltaPercent: Number((heightDelta * 100).toFixed(1)), tolerance },
        };
      }
    }
    const diag = this.diagnostics(specTabId);
    const errors = (diag.console || []).filter((m: any) => m && (m.level === 3 || String(m.message).includes('Uncaught') || String(m.message).includes('SyntaxError')));
    if (errors.length > 0) {
      checklist.consoleErrors = {
        status: 'FAIL',
        message: `Spec runtime has ${errors.length} unhandled errors`,
        details: errors,
      };
      criticalCount++;
    } else {
      checklist.consoleErrors = {
        status: 'PASS',
        message: 'No runtime console or syntax errors detected',
      };
    }
    const score = Math.max(0, Math.min(100, Math.round(
      (checklist.structuralSections?.status === 'PASS' ? 40 : 0) +
      (checklist.heightParity?.status === 'PASS' ? 30 : 0) +
      (checklist.consoleErrors?.status === 'PASS' ? 30 : 0)
    )));
    return {
      passed: criticalCount === 0,
      score,
      criticalCount,
      checklist,
    };
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
      let candidate = explicitTabId.trim();
      const hostResolved = typeof this.host.resolveTargetTabId === 'function'
        ? this.host.resolveTargetTabId(candidate)
        : undefined;
      if (hostResolved) {
        candidate = hostResolved;
      } else if (candidate.startsWith('#') || candidate.startsWith('@')) {
        const list = (this.host.getTabList ? this.host.getTabList() : []).filter(isTabRecord);
        if (candidate.startsWith('#')) {
          const num = parseInt(candidate.slice(1), 10);
          const matchedTab = Number.isFinite(num) && num >= 1 && num <= list.length ? list[num - 1] : undefined;
          if (matchedTab?.id) {
            candidate = matchedTab.id;
          }
        } else if (candidate.startsWith('@')) {
          const lower = candidate.toLowerCase();
          let matched = list.find((t) => t.alias?.toLowerCase() === lower || `@${t.role?.toLowerCase()}` === lower);
          if (!matched) {
            const dataSynonyms = new Set(['@feedback', '@sheet', '@data', '@pricing', '@spec', '@doc', '@baogia']);
            if (dataSynonyms.has(lower)) {
              matched = list.find((t) => t.alias && dataSynonyms.has(t.alias.toLowerCase()));
            }
            const webSynonyms = new Set(['@storefront', '@web', '@store', '@live', '@target']);
            if (!matched && webSynonyms.has(lower)) {
              matched = list.find((t) => t.alias && webSynonyms.has(t.alias.toLowerCase()));
            }
          }
          if (matched && matched.id) {
            candidate = matched.id;
          } else {
            throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown tab alias: "${candidate}". No active tab matches this alias.`);
          }
        }
      }
      if (!tabExists(candidate)) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown tab ID: ${explicitTabId}`);
      }
      if ((operationType === 'write' || operationType === 'lifecycle') && target?.tabId && target.tabId.trim().length > 0 && candidate !== target.tabId.trim()) {
        const isAllowed = this.host.isTabAllowed ? this.host.isTabAllowed(target.tabId.trim(), candidate) : false;
        if (!isAllowed) {
          throw new CapabilityError('TARGET_MISMATCH', `Explicit tabId "${explicitTabId}" does not match target tabId "${target.tabId}". Note: In split review mode, use the bound tabId with paneId: "mobile" to target the mobile pane.`);
        }
      }
      resolved = candidate;
    } else if (target?.tabId && target.tabId.trim().length > 0) {
      if (!tabExists(target.tabId)) {
        const failoverTab = this.host.getFailoverTargetTab ? this.host.getFailoverTargetTab(target.tabId) : undefined;
        if (failoverTab && tabExists(failoverTab)) {
          resolved = failoverTab;
        } else {
          throw new CapabilityError('TARGET_STALE', `Target tab no longer exists: ${target.tabId}`);
        }
      } else {
        resolved = target.tabId;
      }
    } else {
      const currentAutoTab = this.host.getAutomationTabId ? this.host.getAutomationTabId() : undefined;
      if (tabExists(currentAutoTab)) {
        resolved = currentAutoTab;
      } else if (this.host.createTab) {
        // Dual-Plane Runtime Isolation: dedicated agent tab renders offscreen so
        // capture never requires foregrounding/swapping the user's visible view.
        // Phase 2 (step 4): the only reachable path here is a direct/legacy caller
        // (no attachment session) — or a session whose record still lacks a provisioned
        // tabId and will be reconciled by the authoritative rebind rotation in
        // capability-transport. Authority is NEVER read back from this global
        // (resolveDirectRpcTargetTab/validateAttachment/startSession all resolve
        // exclusively from the attachment record and fail closed). Recording the
        // provisioned id here is host-level tab bookkeeping only, so subsequent
        // direct reads reuse the same tab instead of leaking a new one per call.
        resolved = this.host.createTab('about:blank', false, { ephemeral: true, offscreen: true });
        if (resolved && typeof this.host.setAutomationTabId === 'function') {
          this.host.setAutomationTabId(resolved);
        }
        // A tab created on behalf of a session belongs to that session: without
        // adoption the listing stays empty and the session cannot even close the
        // tab it is working in.
        if (resolved && target?.tabId && this.host.adoptChildTab) {
          this.host.adoptChildTab(target.tabId, resolved);
        }
      } else {
        // Dual-Plane Runtime Isolation (fail-closed): NEVER fall back to the user's
        // active foreground tab. Ambient fallback to getActiveTabId() previously let
        // read-only capabilities (dom, screenshot, find, set-viewport) latch onto the
        // user's working tab and visually hijack it. Require a dedicated automation
        // tab (which the branch above auto-provisions) or an explicit target; otherwise
        // refuse so the user's browsing surface is never touched by agent operations.
        throw new CapabilityError('TARGET_REQUIRED', 'No dedicated automation tab is available and no explicit target tabId was provided. Refusing to target the user\'s active tab. Auto-provision an agent tab or pass an explicit tabId.');
      }
    }

    if (!resolved) {
      throw new CapabilityError('TARGET_REQUIRED', 'Browser target tabId is required');
    }
    if (target) {
      const liveDocGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(resolved) : target.documentGeneration;
      const isEffectful = operationType === 'write' || operationType === 'lifecycle';
      if (isEffectful && typeof target.documentGeneration === 'number' && typeof liveDocGen === 'number' && target.documentGeneration !== liveDocGen) {
        throw new CapabilityError(
          'TARGET_STALE',
          `Browser target document generation (${target.documentGeneration}) is stale compared to live document generation (${liveDocGen}). The DOM was modified or reloaded in the background. Please re-inspect DOM before interacting.`,
          {
            tabId: resolved,
            targetDocumentGeneration: target.documentGeneration,
            liveDocumentGeneration: liveDocGen,
            canRebind: true,
          }
        );
      }
      const currentTarget: BrowserTarget = {
        ...target,
        tabId: resolved,
        // Phase 2 (step 8) fencing semantics:
        // - EFFECTFUL write/lifecycle: the generation fence above (target.documentGeneration
        //   vs liveDocGen) already rejects stale before any side effect, and assertCurrent
        //   receives the EXPECTED generation so isCurrentTarget can still detect a
        //   genuinely repurposed/dead target.
        // - PASSIVE read: auto-syncs freshness — DOM reads/screenshots are safe to run on
        //   the live document and must NOT be rejected for generation drift (dual-plane
        //   background reads never hijack the user's surface). The caller's target contract
        //   is not rewritten; freshness is returned with the artifact.
        // assertCurrent runs for both so a host that reports the bound target as no longer
        // current (hard isCurrentTarget=false) rejects reads too.
        documentGeneration: operationType === 'read'
          ? (liveDocGen ?? target.documentGeneration)
          : target.documentGeneration,
      };
      this.assertCurrent(currentTarget);
    }
    return resolved;
  }

  getDocumentGeneration(tabId?: string): number {
    return this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : 1;
  }

  bumpDocumentGeneration(tabId?: string): number {
    return this.host.bumpDocumentGeneration ? this.host.bumpDocumentGeneration(tabId) : 1;
  }

  getMutationRevision(tabId?: string): number {
    return this.host.getMutationRevision ? this.host.getMutationRevision(tabId) : 1;
  }

  bumpMutationRevision(tabId?: string): number {
    return this.host.bumpMutationRevision ? this.host.bumpMutationRevision(tabId) : 1;
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
  const gridCounts = new Uint32Array(gridW * gridH);

  const isMasked = (x: number, y: number): boolean => {
    for (let i = 0; i < maskBoxes.length; i++) {
      const box = maskBoxes[i];
      if (box && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) {
        return true;
      }
    }
    return false;
  };

  const colorThreshold = Math.max(0.01, Math.min(0.5, tolerancePercent / 100));
  const w1 = size1.width;
  const w2 = size2.width;

  // Pre-composite both bitmaps onto standard white canvas (RGBA/BGRA layout: channels 0,1,2 blended, alpha 3 = 255)
  // This eliminates artificial delta spikes caused by offscreen surfaces with alpha = 0 or partial transparency,
  // bringing the comparison model into exact alignment with real screen pixel rendering.
  const compBitmap1 = Buffer.from(bitmap1);
  const compBitmap2 = Buffer.from(bitmap2);
  for (let i = 0; i < compBitmap1.length; i += 4) {
    const a = compBitmap1[i + 3]!;
    if (a === 0) {
      compBitmap1[i] = 255;
      compBitmap1[i + 1] = 255;
      compBitmap1[i + 2] = 255;
      compBitmap1[i + 3] = 255;
    } else if (a < 255) {
      const alpha = a / 255;
      compBitmap1[i] = Math.round(compBitmap1[i]! * alpha + 255 * (1 - alpha));
      compBitmap1[i + 1] = Math.round(compBitmap1[i + 1]! * alpha + 255 * (1 - alpha));
      compBitmap1[i + 2] = Math.round(compBitmap1[i + 2]! * alpha + 255 * (1 - alpha));
      compBitmap1[i + 3] = 255;
    }
  }

  for (let i = 0; i < compBitmap2.length; i += 4) {
    const a = compBitmap2[i + 3]!;
    if (a === 0) {
      compBitmap2[i] = 255;
      compBitmap2[i + 1] = 255;
      compBitmap2[i + 2] = 255;
      compBitmap2[i + 3] = 255;
    } else if (a < 255) {
      const alpha = a / 255;
      compBitmap2[i] = Math.round(compBitmap2[i]! * alpha + 255 * (1 - alpha));
      compBitmap2[i + 1] = Math.round(compBitmap2[i + 1]! * alpha + 255 * (1 - alpha));
      compBitmap2[i + 2] = Math.round(compBitmap2[i + 2]! * alpha + 255 * (1 - alpha));
      compBitmap2[i + 3] = 255;
    }
  }

  for (let y = 0; y < minH; y++) {
    for (let x = 0; x < minW; x++) {
      if (maskBoxes.length > 0 && isMasked(x, y)) {
        totalPixels = Math.max(0, totalPixels - 1);
        continue;
      }
      const idx1 = (y * w1 + x) * 4;
      const idx2 = (y * w2 + x) * 4;
      const r1 = compBitmap1[idx1]!;
      const g1 = compBitmap1[idx1 + 1]!;
      const b1 = compBitmap1[idx1 + 2]!;

      const r2 = compBitmap2[idx2]!;
      const g2 = compBitmap2[idx2 + 1]!;
      const b2 = compBitmap2[idx2 + 2]!;

      const rDiff = Math.abs(r1 - r2);
      const gDiff = Math.abs(g1 - g2);
      const bDiff = Math.abs(b1 - b2);
      const colorDelta = Math.sqrt(rDiff * rDiff + gDiff * gDiff + bDiff * bDiff) / 441.67;
      if (colorDelta > colorThreshold) {
        // Antialiased edge detection and subpixel font rendering jitter filter
        let isAntialiased = false;

        // 1. Check if an adjacent 1px neighbor in image1 matches image2 or vice versa within colorThreshold
        if (colorDelta <= Math.max(colorThreshold * 4.2, 0.45)) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && nx < minW && ny >= 0 && ny < minH) {
                const nIdx1 = (ny * w1 + nx) * 4;
                const nr1 = Math.abs(compBitmap1[nIdx1]! - compBitmap2[idx2]!);
                const ng1 = Math.abs(compBitmap1[nIdx1 + 1]! - compBitmap2[idx2 + 1]!);
                const nb1 = Math.abs(compBitmap1[nIdx1 + 2]! - compBitmap2[idx2 + 2]!);

                const nIdx2 = (ny * w2 + nx) * 4;
                const nr2 = Math.abs(compBitmap1[idx1]! - compBitmap2[nIdx2]!);
                const ng2 = Math.abs(compBitmap1[idx1 + 1]! - compBitmap2[nIdx2 + 1]!);
                const nb2 = Math.abs(compBitmap1[idx1 + 2]! - compBitmap2[nIdx2 + 2]!);

                if (
                  Math.sqrt(nr1 * nr1 + ng1 * ng1 + nb1 * nb1) / 441.67 <= colorThreshold ||
                  Math.sqrt(nr2 * nr2 + ng2 * ng2 + nb2 * nb2) / 441.67 <= colorThreshold
                ) {
                  isAntialiased = true;
                  break;
                }
              }
            }
            if (isAntialiased) break;
          }

          if (isAntialiased) {
            continue;
          }

          // 2. Luminance edge contrast filter for font rendering boundaries
          const l1 = (compBitmap1[idx1]! * 299 + compBitmap1[idx1 + 1]! * 587 + compBitmap1[idx1 + 2]! * 114) / 1000;
          const l2 = (compBitmap2[idx2]! * 299 + compBitmap2[idx2 + 1]! * 587 + compBitmap2[idx2 + 2]! * 114) / 1000;
          let isEdge = false;

          const offsets: Array<[number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, 1], [-1, 1], [1, -1]];
          for (let i = 0; i < offsets.length; i++) {
            const [dx, dy] = offsets[i]!;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < minW && ny >= 0 && ny < minH) {
              const n1 = (ny * w1 + nx) * 4;
              const n2 = (ny * w2 + nx) * 4;
              const nl1 = (compBitmap1[n1]! * 299 + compBitmap1[n1 + 1]! * 587 + compBitmap1[n1 + 2]! * 114) / 1000;
              const nl2 = (compBitmap2[n2]! * 299 + compBitmap2[n2 + 1]! * 587 + compBitmap2[n2 + 2]! * 114) / 1000;
              if (Math.abs(l1 - nl1) > 16 || Math.abs(l2 - nl2) > 16) {
                isEdge = true;
                break;
              }
            }
          }

          if (isEdge) {
            continue;
          }
        }

        diffPixels++;
        const gx = (x / blockSize) | 0;
        const gy = (y / blockSize) | 0;
        const gIdx = gy * gridW + gx;
        gridCounts[gIdx] = (gridCounts[gIdx] || 0) + 1;
      }
    }
  }

  const diffBoundingBoxes: Array<{ x: number; y: number; width: number; height: number; pixelCount: number }> = [];
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const count = gridCounts[gy * gridW + gx]!;
      if (count > 4) {
        diffBoundingBoxes.push({
          x: gx * blockSize,
          y: gy * blockSize,
          width: Math.min(blockSize, minW - gx * blockSize),
          height: Math.min(blockSize, minH - gy * blockSize),
          pixelCount: count,
        });
      }
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
