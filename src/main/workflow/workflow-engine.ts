import {
  ArtifactRef,
  BrowserTarget,
  CapabilityError,
  CapabilityErrorCode,
  CapabilityRequestContext,
  ClientInvocationIntent,
  ChildDispatchSpec,
  InternalChildCapabilityResponse,
  RuntimeLease,
} from '../../shared/control-plane-contracts';
import { findDevicePreset } from '../browser/device-presets';
import { CapabilityCatalogue } from '../tools/capability-catalogue';
import { ArtifactStore } from '../tools/artifact-store';
import {
  WorkflowDefinition,
  WorkflowDefinitionSchema,
  WorkflowExecutionResult,
  WorkflowStep,
  WorkflowStepResult,
  WorkflowEventListener,
} from './workflow-schema';

export interface WorkflowEnginePorts {
  catalogue: CapabilityCatalogue;
  artifacts: ArtifactStore;
}

export interface WorkflowExecutionOptions {
  workflow: WorkflowDefinition;
  target: BrowserTarget;
  lease: RuntimeLease;
  leaseToken?: string;
  runId: string;
  attemptId: string;
  workspaceRoot?: string;
  grant?: 'read' | 'write' | 'execute' | 'eval';
  signal?: AbortSignal;
  onEvent?: WorkflowEventListener;
  progressSink?: { onProgress: (event: unknown) => void };
  authorityRevision?: string;
  parentInvocationId?: string;
  /** Single child-execution channel: the transport-owned dispatchChildIntent closure. Required — there is no ledger-less fallback path. */
  dispatchChildIntent: (spec: ChildDispatchSpec) => Promise<InternalChildCapabilityResponse>;
}

/**
 * Device-preset ids that older persisted workflow definitions still carry. They are lowered to
 * the current preset id before validation, so a stored workflow keeps emulating the device it
 * was written for instead of silently degrading to a desktop viewport.
 */
const DEVICE_PRESET_ALIASES: Readonly<Record<string, string>> = {
  'mobile-iphone-14-pro': 'phone-iphone14pro',
  'mobile-iphone-15': 'phone-iphone15pro',
  'mobile-iphone15': 'phone-iphone15pro',
  'mobile-iphone-se': 'phone-iphonese',
  'mobile-pixel': 'phone-pixel7',
  'desktop-laptop': 'laptop-1440',
  'tablet-portrait': 'tablet-768',
  'tablet-desktop': 'tablet-landscape-1024',
};

/**
 * Lowering pass that normalizes a step's params into the shape its capability actually declares,
 * before capability dispatch. Two legacy shapes are accepted:
 *
 * - `browser.set_device_preset`: a legacy `presetId` alias is resolved first, then the id is
 *   validated against the device-preset table. An id that resolves to nothing is a hard
 *   `INVALID_ARGUMENT` — a workflow must never silently measure a desktop layout while claiming
 *   it emulated a phone.
 * - `file.assert_not_contains`: `forbiddenPatterns: string[]` is kept as an enumerated list of
 *   literal substrings. The capability matches `pattern` with a literal `String.includes`, so an
 *   alternation string would never match; dispatch issues one assertion per alternative instead.
 */
export function normalizeStepParams(step: { type: string; params?: Record<string, unknown> }): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(step.params ?? {}) };

  if (step.type === 'browser.set_device_preset') {
    const raw = params.presetId;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const trimmed = raw.trim();
      const aliased = DEVICE_PRESET_ALIASES[trimmed.toLowerCase()] ?? trimmed;
      if (!findDevicePreset(aliased)) {
        throw new CapabilityError(
          'INVALID_ARGUMENT',
          `Unknown device preset '${raw}'. Valid presets are listed by the browser.list-device-presets capability.`
        );
      }
      params.presetId = aliased;
    }
  }

  if (step.type === 'file.assert_not_contains') {
    const forbidden = params.forbiddenPatterns;
    const hasPattern = typeof params.pattern === 'string' && params.pattern.length > 0;
    if (!hasPattern && Array.isArray(forbidden)) {
      const lowered = forbidden.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
      if (lowered.length === 0) {
        throw new CapabilityError(
          'INVALID_ARGUMENT',
          'file.assert_not_contains requires a non-empty pattern or forbiddenPatterns'
        );
      }
      // The capability matches `pattern` as a literal substring, so it cannot evaluate alternation.
      // The enumerated list IS the contract: dispatch asserts each alternative literally, one
      // capability call per entry. No synthetic regex is fabricated here.
      params.forbiddenPatterns = lowered;
    }
  }

  return params;
}

/**
 * Bounded jittered exponential backoff: `200 * 2^attempt + jitter`, capped at 2s. The cap keeps a
 * retried step inside the workflow's own timeout envelope while still de-correlating concurrent runs.
 */
function retryBackoffMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(2000, 200 * Math.pow(2, attempt) + jitter);
}

interface OverflowReading {
  hasHorizontalScrollbar?: unknown;
  hasHorizontalOverflow?: unknown;
  scrollWidth?: unknown;
  clientWidth?: unknown;
  breakpoints?: unknown;
}

function collectOverflowHits(data: unknown, prefix = 'root'): Array<{ id: string; scrollWidth?: number; clientWidth?: number }> {
  if (!data || typeof data !== 'object') return [];
  const rec = data as OverflowReading;
  const hits: Array<{ id: string; scrollWidth?: number; clientWidth?: number }> = [];
  if (rec.breakpoints && typeof rec.breakpoints === 'object') {
    for (const [id, bp] of Object.entries(rec.breakpoints as Record<string, unknown>)) {
      hits.push(...collectOverflowHits(bp, id));
    }
  }
  const overflowed = rec.hasHorizontalOverflow === true || rec.hasHorizontalScrollbar === true;
  if (overflowed) {
    hits.push({
      id: prefix,
      scrollWidth: typeof rec.scrollWidth === 'number' ? rec.scrollWidth : undefined,
      clientWidth: typeof rec.clientWidth === 'number' ? rec.clientWidth : undefined,
    });
  }
  return hits;
}

function formatWorkflowReport(
  payload: Record<string, unknown>,
  format: 'markdown' | 'json'
): { mime: string; data: string } {
  if (format !== 'markdown') {
    return { mime: 'application/json', data: JSON.stringify(payload, null, 2) };
  }
  const steps = Array.isArray(payload.steps) ? payload.steps as WorkflowStepResult[] : [];
  const title = String(payload.title || payload.name || 'Workflow Report');
  const lines = [
    `# ${title}`,
    '',
    `- Generated: ${new Date(Number(payload.timestamp) || Date.now()).toISOString()}`,
    `- Target: ${JSON.stringify(payload.target ?? {})}`,
    '',
    '## Steps',
    ...steps.map((step, index) => {
      const err = step.error ? ` — ${step.error}` : '';
      return `${index + 1}. ${step.stepName} (\`${step.type}\`): **${step.status}**${err} (${step.durationMs}ms)`;
    }),
  ];
  return { mime: 'text/markdown', data: lines.join('\n') };
}

export class WorkflowEngine {
  constructor(private readonly ports: WorkflowEnginePorts) {}

  async execute(options: WorkflowExecutionOptions): Promise<WorkflowExecutionResult> {
    const {
      workflow,
      target,
      lease,
      leaseToken,
      runId,
      attemptId,
      grant,
      signal,
      onEvent,
      progressSink,
      authorityRevision,
      parentInvocationId,
      dispatchChildIntent,
    } = options;

    // Single execution authority: every step capability must flow through the
    // transport-issued child channel (ledger, authority, cancellation). There is
    // no ledger-less fallback — fail fast when the channel is absent.
    if (typeof dispatchChildIntent !== 'function') {
      throw new CapabilityError('UNAUTHENTICATED', 'WorkflowEngine.execute requires dispatchChildIntent — the transport-issued child dispatch channel');
    }

    const emitEvent = (ev: Parameters<WorkflowEventListener>[0]) => {
      try {
        onEvent?.(ev);
      } catch {}
      try {
        progressSink?.onProgress(ev);
      } catch {}
    };

    // 1. Validate workflow schema
    const parsed = WorkflowDefinitionSchema.safeParse(workflow);
    if (!parsed.success) {
      throw new CapabilityError('INVALID_ARGUMENT', `Workflow definition validation failed: ${parsed.error.message}`);
    }
    const def = parsed.data;

    // 2. Validate browser target
    this.assertTarget(target);

    let currentTarget: BrowserTarget = { ...target };
    let currentRevision: string | undefined = options.authorityRevision;
    const stepResults: WorkflowStepResult[] = [];
    const allArtifacts: ArtifactRef[] = [];
    const startTime = Date.now();

    emitEvent({ type: 'workflow:start' });

    let aborted = false;
    let fatalFailure = false;
    let continueOnErrorFailure = false;

    /**
     * Closes out every step from `fromIndex` onward as `skipped`. A step that never ran must still
     * publish a terminal `step:end`, otherwise the Hub keeps rendering it as pending forever.
     */
    const skipRemaining = (fromIndex: number, errorMessage: string) => {
      for (let j = fromIndex; j < def.steps.length; j++) {
        const remaining = def.steps[j];
        if (!remaining) continue;
        stepResults.push({
          stepId: remaining.id,
          stepName: remaining.name,
          type: remaining.type,
          status: 'skipped',
          durationMs: 0,
          error: errorMessage,
        });
        emitEvent({
          type: 'step:end',
          stepId: remaining.id,
          stepName: remaining.name,
          status: 'skipped',
          error: errorMessage,
        });
      }
    };

    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i];
      if (!step) continue;

      // Check abort signal before starting step
      if (signal?.aborted) {
        aborted = true;
        skipRemaining(i, 'Workflow was aborted by caller');
        break;
      }

      emitEvent({ type: 'step:start', stepId: step.id, stepName: step.name });
      const stepStartTime = Date.now();
      let stepResult: WorkflowStepResult | null = null;
      let lastError: Error | null = null;

      const maxAttempts = 1 + (step.retryCount || 0);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) {
          lastError = new Error('Workflow was aborted');
          break;
        }

        try {
          const reqContext: CapabilityRequestContext = {
            lease,
            leaseToken: leaseToken || lease.token,
            projectId: currentTarget.projectId,
            workspaceId: currentTarget.workspaceId,
            runId,
            attemptId,
            browserTarget: currentTarget,
            grant: grant ?? 'write',
          };

          // dispatchChild is built per attempt so it can carry the step-scoped
          // abort signal created inside executeStepWithTimeout — the signal that
          // makes a step timeout actually cancel the in-flight child instead of
          // racing away while the child keeps running.
          const makeDispatchChild = (stepSignal: AbortSignal) =>
            (intent: ClientInvocationIntent) =>
              dispatchChildIntent({ stepId: step.id, attempt, intent, signal: stepSignal });

          const stepOutput = await this.executeStepWithTimeout(
            step,
            reqContext,
            step.timeoutMs,
            signal,
            makeDispatchChild,
            stepResults
          );

          if (stepOutput.updatedTarget) {
            currentTarget = { ...currentTarget, ...stepOutput.updatedTarget };
          }

          if (stepOutput.replacementRevision) {
            currentRevision = stepOutput.replacementRevision;
          }

          if (stepOutput.artifacts) {
            for (const art of stepOutput.artifacts) {
              allArtifacts.push(art);
            }
          }

          stepResult = {
            stepId: step.id,
            stepName: step.name,
            type: step.type,
            status: 'passed',
            durationMs: Date.now() - stepStartTime,
            data: stepOutput.data,
            artifacts: stepOutput.artifacts,
          };
          break;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // Settlement-aware retry gate: a child that timed out, aborted, or
          // settled 'unknown' may have landed effects; minting a new attempt
          // would double-mutate. invokeCap annotates retryable on the thrown
          // error; anything not explicitly retryable stops the loop.
          const retryable = (lastError as { retryable?: boolean }).retryable === true;
          if (!retryable) {
            break;
          }

          const isLastAttempt = attempt + 1 >= maxAttempts;
          if (isLastAttempt || signal?.aborted) continue;

          const delayMs = retryBackoffMs(attempt);
          emitEvent({
            type: 'step:retry',
            stepId: step.id,
            stepName: step.name,
            attempt: attempt + 1,
            delayMs,
            error: lastError.message,
          });
          await this.delay(delayMs);
        }
      }

      let isAborted = Boolean(signal?.aborted);
      if (!stepResult) {
        const errorMsg = lastError?.message || 'Unknown step execution failure';
        if (signal?.aborted || errorMsg.includes('aborted')) {
          isAborted = true;
        }
        stepResult = {
          stepId: step.id,
          stepName: step.name,
          type: step.type,
          status: 'failed',
          durationMs: Date.now() - stepStartTime,
          error: errorMsg,
        };
      }

      stepResults.push(stepResult);
      emitEvent({
        type: 'step:end',
        stepId: step.id,
        stepName: step.name,
        status: stepResult.status,
        error: stepResult.error,
      });

      if (stepResult.status === 'failed') {
        if (isAborted) {
          // Abort always terminates the run, even for a step that opted into continueOnError.
          aborted = true;
          skipRemaining(i + 1, 'Workflow was aborted by caller');
          break;
        }
        if (step.continueOnError) {
          // Handled catch: the failure is recorded but the run keeps going, so the run is not
          // reported as failed — it completed with errors.
          continueOnErrorFailure = true;
          continue;
        }
        fatalFailure = true;
        skipRemaining(i + 1, `Skipped because step '${step.id}' failed`);
        break;
      }
    }

    const status: WorkflowExecutionResult['status'] = aborted
      ? 'interrupted'
      : fatalFailure
      ? 'failed'
      : continueOnErrorFailure
      ? 'completed_with_errors'
      : 'passed';

    const totalDurationMs = Date.now() - startTime;
    const passedSteps = stepResults.filter((s) => s.status === 'passed').length;
    const failedSteps = stepResults.filter((s) => s.status === 'failed').length;
    const skippedSteps = stepResults.filter((s) => s.status === 'skipped').length;

    // Stage final workflow report artifact
    const finalReport = {
      workflowName: def.name,
      runId,
      attemptId,
      status,
      totalDurationMs,
      passedSteps,
      failedSteps,
      skippedSteps,
      target: currentTarget,
      stepResults,
      createdAt: Date.now(),
    };

    const reportArtifact = this.ports.artifacts.stage({
      kind: 'report',
      mime: 'application/json',
      data: JSON.stringify(finalReport, null, 2),
      runId,
      attemptId,
      projectId: currentTarget.projectId,
      workspaceId: currentTarget.workspaceId,
      maxBytes: 128 * 1024,
      // Same lifetime as the workflow.execute capability that produced it.
      retentionPolicy: 'run-durable',
    });
    allArtifacts.push(reportArtifact);

    const executionResult: WorkflowExecutionResult = {
      workflowName: def.name,
      runId,
      attemptId,
      target: currentTarget,
      status,
      totalDurationMs,
      passedSteps,
      failedSteps,
      skippedSteps,
      stepResults,
      artifacts: allArtifacts,
    };

    emitEvent({ type: 'workflow:end', result: executionResult });

    return executionResult;
  }

  private async executeStepWithTimeout(
    step: WorkflowStep,
    context: CapabilityRequestContext,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    makeDispatchChild: (stepSignal: AbortSignal) => (intent: ClientInvocationIntent) => Promise<InternalChildCapabilityResponse>,
    priorStepResults: WorkflowStepResult[]
  ): Promise<{ data?: unknown; artifacts?: ArtifactRef[]; updatedTarget?: BrowserTarget; replacementRevision?: string }> {
    const stepAbortController = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    const onCallerAbort = () => {
      stepAbortController.abort(signal?.reason || new Error('Workflow aborted'));
    };

    if (signal) {
      if (signal.aborted) {
        stepAbortController.abort(signal.reason || new Error('Workflow aborted'));
      } else {
        signal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const timeoutErr = new Error(`Step '${step.name}' timed out after ${timeoutMs}ms`);
          (timeoutErr as { retryable?: boolean }).retryable = false;
          stepAbortController.abort(timeoutErr);
          reject(timeoutErr);
        }, timeoutMs);
      }
    });

    const abortPromise = new Promise<never>((_, reject) => {
      const rejectWithReason = () => {
        const reason = stepAbortController.signal.reason || new Error('Workflow aborted');
        if (reason instanceof Error) (reason as { retryable?: boolean }).retryable = false;
        reject(reason);
      };
      if (stepAbortController.signal.aborted) {
        rejectWithReason();
      } else {
        stepAbortController.signal.addEventListener('abort', rejectWithReason, { once: true });
      }
    });

    try {
      return await Promise.race([
        this.dispatchStep(
          step,
          context,
          makeDispatchChild(stepAbortController.signal),
          priorStepResults
        ),
        timeoutPromise,
        abortPromise,
      ]);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  }

  private async dispatchStep(
    step: WorkflowStep,
    context: CapabilityRequestContext,
    dispatchChild: (intent: ClientInvocationIntent) => Promise<InternalChildCapabilityResponse>,
    priorStepResults: WorkflowStepResult[] = []
  ): Promise<{ data?: unknown; artifacts?: ArtifactRef[]; updatedTarget?: BrowserTarget; replacementRevision?: string }> {
    // Lowering pass: legacy param shapes are normalized to what each capability declares before any
    // dispatch, so a persisted workflow cannot fail on a contract that has since been tightened.
    const params = normalizeStepParams(step);
    const tabId = typeof params.tabId === 'string' ? params.tabId : undefined;

    const invokeCap = async (
      name: string,
      payload: Record<string, unknown>
    ): Promise<{ data?: unknown; replacementRevision?: string }> => {
      const minimalIntent = {
        name,
        params: payload,
      } as unknown as ClientInvocationIntent;
      const resp = await dispatchChild(minimalIntent);
      if (!resp.ok) {
        const code = resp.error?.code || 'CAPABILITY_ERROR';
        const msg = resp.error?.message || 'Capability execution failed';
        const err = new CapabilityError(code as CapabilityErrorCode, msg);
        // Retry classification: the engine owns the retry DECISION, the
        // catalogue owns the effect CLASSIFICATION, the transport supplies the
        // settlement STATE. A read can never double-mutate; an idempotent-write
        // may retry only on a provably terminal failed/interrupted receipt;
        // everything else (mutation, unknown, in-flight, timeout, abort) is
        // denied — the original may still hold effects.
        const effect = this.ports.catalogue.getPolicy(name)?.effect;
        const state = resp.state;
        const retryable =
          effect === 'read'
            ? code !== 'EXECUTION_TIMEOUT_PENDING_CLEANUP'
            : effect === 'idempotent-write' &&
              (state === 'failed' || state === 'interrupted') &&
              !['EXECUTION_TIMEOUT', 'EXECUTION_TIMEOUT_PENDING_CLEANUP', 'ABORTED', 'CANCELLED', 'TRANSACTION_CONFLICT', 'EXECUTION_UNKNOWN'].includes(code);
        (err as unknown as { retryable?: boolean }).retryable = retryable;
        throw err;
      }
      return { data: resp.data, replacementRevision: resp.replacementAuthorityRevision };
    };



    switch (step.type) {
      case 'browser.navigate': {
        const url = params.url;
        if (!url || typeof url !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'browser.navigate requires url');
        const res = (await invokeCap('browser.navigate', { url, tabId })) as { data: { navigated: boolean; target: BrowserTarget }; replacementRevision?: string };
        const data = res.data;
        return { data, updatedTarget: data?.target, replacementRevision: res.replacementRevision };
      }

      case 'browser.click': {
        const res = await invokeCap(
          'browser.agent-click',
          { selector: params.selector, ref: params.ref, x: params.x, y: params.y, label: params.label, tabId }
        );
        return { data: { success: Boolean(res.data) }, replacementRevision: res.replacementRevision };
      }

      case 'browser.type': {
        const text = params.text;
        if (typeof text !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'browser.agent-type requires text');
        const res = await invokeCap(
          'browser.agent-type',
          { selector: params.selector, text, clear: params.clear, tabId }
        );
        return { data: { success: Boolean(res.data) }, replacementRevision: res.replacementRevision };
      }

      case 'browser.scroll': {
        const deltaY = typeof params.deltaY === 'number' ? params.deltaY : params.y;
        const res = await invokeCap(
          'browser.agent-scroll',
          { deltaY, selector: params.selector, tabId }
        );
        return { data: { success: Boolean(res.data) }, replacementRevision: res.replacementRevision };
      }

      case 'browser.hover': {
        const res = await invokeCap(
          'browser.agent-hover',
          { selector: params.selector, x: params.x, y: params.y, label: params.label, tabId }
        );
        return { data: { success: Boolean(res.data) }, replacementRevision: res.replacementRevision };
      }

      case 'browser.highlight': {
        if (!params.selector || typeof params.selector !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'browser.agent-highlight requires selector');
        const res = await invokeCap(
          'browser.agent-highlight',
          { selector: params.selector, label: params.label, color: params.color, tabId }
        );
        return { data: { success: Boolean(res.data) }, replacementRevision: res.replacementRevision };
      }

      case 'browser.screenshot': {
        const format = params.format === 'png' || params.format === 'jpeg' ? params.format : undefined;
        const res = await invokeCap('browser.screenshot', { tabId, format });
        const artifacts: ArtifactRef[] = (typeof res.data === 'object' && res.data !== null && 'id' in res.data) ? [res.data as ArtifactRef] : [];
        return { data: { captured: true }, artifacts, replacementRevision: res.replacementRevision };
      }

      case 'browser.extract_dom': {
        const res = await invokeCap('browser.dom', { selector: params.selector, tabId });
        const artifacts: ArtifactRef[] = (typeof res.data === 'object' && res.data !== null && 'id' in res.data) ? [res.data as ArtifactRef] : [];
        return { data: { extracted: true }, artifacts, replacementRevision: res.replacementRevision };
      }

      case 'browser.set_viewport': {
        const width = Number(params.width);
        const height = Number(params.height);
        if (!width || !height) throw new CapabilityError('INVALID_ARGUMENT', 'browser.set-viewport requires width and height');
        const res = await invokeCap(
          'browser.set-viewport',
          { width, height, mobile: params.mobile, deviceScaleFactor: params.deviceScaleFactor, tabId }
        );
        return { data: res.data, replacementRevision: res.replacementRevision };
      }

      case 'browser.set_device_preset': {
        const presetId = params.presetId;
        if (!presetId || typeof presetId !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'browser.set-device-preset requires presetId');
        const res = await invokeCap('browser.set-device-preset', { presetId, tabId });
        return { data: res.data, replacementRevision: res.replacementRevision };
      }

      case 'browser.set_zoom': {
        const zoomFactor = Number(params.zoomFactor);
        if (!zoomFactor) throw new CapabilityError('INVALID_ARGUMENT', 'browser.set-zoom requires zoomFactor');
        const res = await invokeCap('browser.set-zoom', { zoomFactor, tabId });
        return { data: res.data, replacementRevision: res.replacementRevision };
      }

      case 'browser.wait_for_selector': {
        const selector = params.selector;
        if (!selector || typeof selector !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'wait_for_selector requires selector');
        // Delegate to the canonical browser.wait capability: one ledgered child
        // invocation, cancellable through the step-scoped signal, instead of a
        // 100ms browser.dom poll loop that mints ~80 uncancellable children.
        const maxWaitMs = step.timeoutMs || 5000;
        const res = await invokeCap('browser.wait', {
          condition: 'selector',
          selector,
          state: 'attached',
          timeoutMs: maxWaitMs,
          tabId,
        });
        return { data: { found: true, wait: res.data }, replacementRevision: res.replacementRevision };
      }

      case 'qa.check_console_errors': {
        const res = await invokeCap(
          'browser.diagnostics',
          { tabId: tabId || context.browserTarget?.tabId, level: 3 }
        );
        const diag = res.data as { console?: any[]; failures?: any[] };
        const errors = diag?.console || [];
        if (errors.length > 0) {
          throw new Error(`Found ${errors.length} critical console error(s): ${errors.map((e: any) => e.text || e).join('; ')}`);
        }
        return { data: { errors: 0, passed: true }, replacementRevision: res.replacementRevision };
      }

      case 'qa.check_broken_images': {
        const res = await invokeCap(
          'browser.diagnostics',
          { tabId: tabId || context.browserTarget?.tabId }
        );
        const diag = res.data as { console?: any[]; failures?: any[] };
        const failures = diag?.failures || [];
        const imageFailures = failures.filter((f: any) => typeof f.url === 'string' && /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(f.url));
        if (imageFailures.length > 0) {
          throw new Error(`Found ${imageFailures.length} broken image(s): ${imageFailures.map((f: any) => f.url).join('; ')}`);
        }
        return { data: { brokenImages: 0, passed: true }, replacementRevision: res.replacementRevision };
      }

      case 'qa.check_overflow': {
        const res = await invokeCap(
          'browser.responsive-check',
          { tabId: tabId || context.browserTarget?.tabId }
        );
        const hits = collectOverflowHits(res.data);
        if (hits.length > 0) {
          const detail = hits
            .map((hit) => {
              const dims = hit.scrollWidth !== undefined && hit.clientWidth !== undefined
                ? ` scrollWidth (${hit.scrollWidth}) > clientWidth (${hit.clientWidth})`
                : '';
              return `${hit.id}${dims}`;
            })
            .join('; ');
          throw new Error(`Horizontal overflow detected: ${detail}`);
        }
        return { data: res.data, replacementRevision: res.replacementRevision };
      }

      case 'file.read': {
        const path = params.path;
        if (!path || typeof path !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'file.read requires path');
        const res = await invokeCap('file.read', { path, maxBytes: params.maxBytes });
        return { data: res.data, replacementRevision: res.replacementRevision };
      }

      case 'file.write': {
        const path = params.path;
        const content = params.content;
        if (!path || typeof path !== 'string' || typeof content !== 'string') {
          throw new CapabilityError('INVALID_ARGUMENT', 'file.write requires path and content');
        }
        const res = await invokeCap('file.write', { path, content });
        return { data: res.data, replacementRevision: res.replacementRevision };
      }

      case 'file.assert_not_contains': {
        const path = params.path;
        // `forbiddenPatterns` was already lowered to `pattern` by normalizeStepParams; the
        // capability's inputSchema only knows `{ path, pattern }`.
        const pattern = params.pattern;
        if (!path || typeof path !== 'string') {
          throw new CapabilityError('INVALID_ARGUMENT', 'file.assert_not_contains requires path');
        }
        const enumerated = Array.isArray(params.forbiddenPatterns)
          ? params.forbiddenPatterns.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          : [];
        const alternatives = enumerated.length > 0 ? enumerated : typeof pattern === 'string' && pattern.length > 0 ? [pattern] : [];
        if (alternatives.length === 0) {
          throw new CapabilityError('INVALID_ARGUMENT', 'file.assert_not_contains requires path and pattern');
        }
        let lastData: unknown;
        for (const alternative of alternatives) {
          const res = await invokeCap(
            'file.assert_not_contains',
            { path, pattern: alternative }
          );
          lastData = res.data;
          // The capability reports a missing file as a satisfied assertion; nothing left to scan.
          if ((res.data as { missing?: boolean } | null)?.missing === true) {
            return { data: res.data, replacementRevision: res.replacementRevision };
          }
        }
        return { data: lastData };
      }

      case 'report.generate': {
        if (!context.runId || !context.attemptId) {
          throw new CapabilityError('INVALID_ARGUMENT', 'runId and attemptId are required for report generation');
        }
        const format = params.format === 'markdown' ? 'markdown' : 'json';
        const payload: Record<string, unknown> = {
          name: step.name,
          title: params.title,
          params,
          target: context.browserTarget,
          timestamp: Date.now(),
          steps: priorStepResults,
        };
        const rendered = formatWorkflowReport(payload, format);
        const art = this.ports.artifacts.stage({
          kind: 'report',
          mime: rendered.mime,
          data: rendered.data,
          runId: context.runId,
          attemptId: context.attemptId,
          projectId: context.projectId,
          workspaceId: context.workspaceId,
          maxBytes: 64 * 1024,
          // Mirrors the report.generate capability: this step is that capability inside a workflow.
          retentionPolicy: 'permanent',
        });
        return { data: { generated: true, format, mime: rendered.mime }, artifacts: [art] };
      }

      default: {
        // The discriminated union covers every step type; this branch only runs for an
        // unregistered type surviving legacy load. Cast restores the runtime value for the message.
        const unsupported = step as { type?: unknown };
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unsupported workflow step type: ${String(unsupported.type)}`);
      }
    }
  }

  private assertTarget(target: BrowserTarget): void {
    if (!target.projectId || !target.workspaceId || !target.runtimeId || !target.tabId) {
      throw new CapabilityError('TARGET_REQUIRED', 'Workflow execution requires an explicit BrowserTarget with projectId, workspaceId, runtimeId, and tabId');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

}
