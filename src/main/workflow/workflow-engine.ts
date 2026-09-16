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

    let status: 'passed' | 'failed' | 'interrupted' = 'passed';

    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i];
      if (!step) continue;

      // Check abort signal before starting step
      if (signal?.aborted) {
        status = 'interrupted';
        emitEvent({ type: 'step:start', stepId: step.id, stepName: step.name });
        const stepResult: WorkflowStepResult = {
          stepId: step.id,
          stepName: step.name,
          type: step.type,
          status: 'skipped',
          durationMs: 0,
          error: 'Workflow was aborted by caller',
        };
        stepResults.push(stepResult);
        emitEvent({ type: 'step:end', stepId: step.id, stepName: step.name, status: 'skipped', error: stepResult.error });
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
            makeDispatchChild
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

        if (isAborted) {
          status = 'interrupted';
        } else if (!step.continueOnError) {
          status = 'failed';
        }
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
        if (!isAborted) {
          status = 'failed';
        }
        if (!step.continueOnError || isAborted) {
          for (let j = i + 1; j < def.steps.length; j++) {
            const remainingStep = def.steps[j];
            if (!remainingStep) continue;
            stepResults.push({
              stepId: remainingStep.id,
              stepName: remainingStep.name,
              type: remainingStep.type,
              status: 'skipped',
              durationMs: 0,
            });
          }
          break;
        }
      }
    }

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
    makeDispatchChild: (stepSignal: AbortSignal) => (intent: ClientInvocationIntent) => Promise<InternalChildCapabilityResponse>
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
          makeDispatchChild(stepAbortController.signal)
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
    dispatchChild: (intent: ClientInvocationIntent) => Promise<InternalChildCapabilityResponse>
  ): Promise<{ data?: unknown; artifacts?: ArtifactRef[]; updatedTarget?: BrowserTarget; replacementRevision?: string }> {
    const params = (step.params || {}) as Record<string, unknown>;
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
        const res = await invokeCap(
          'browser.agent-scroll',
          { deltaY: params.deltaY, selector: params.selector, tabId }
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
          { selector: params.selector, label: params.label, tabId }
        );
        return { data: { success: Boolean(res.data) }, replacementRevision: res.replacementRevision };
      }

      case 'browser.screenshot': {
        const res = await invokeCap('browser.screenshot', { tabId });
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
        const data = res.data as { hasHorizontalScrollbar?: boolean; scrollWidth?: number; clientWidth?: number };
        if (data?.hasHorizontalScrollbar) {
          throw new Error(`Horizontal overflow detected: scrollWidth (${data.scrollWidth}) > clientWidth (${data.clientWidth})`);
        }
        return { data, replacementRevision: res.replacementRevision };
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
        const pattern = params.pattern;
        if (!path || typeof path !== 'string' || !pattern || typeof pattern !== 'string') {
          throw new CapabilityError('INVALID_ARGUMENT', 'file.assert_not_contains requires path and pattern');
        }
        const res = await invokeCap('file.assert_not_contains', { path, pattern });
        return { data: res.data, replacementRevision: res.replacementRevision };
      }

      case 'report.generate': {
        if (!context.runId || !context.attemptId) {
          throw new CapabilityError('INVALID_ARGUMENT', 'runId and attemptId are required for report generation');
        }
        const reportData = JSON.stringify({ name: step.name, params, target: context.browserTarget, timestamp: Date.now() }, null, 2);
        const art = this.ports.artifacts.stage({
          kind: 'report',
          mime: 'application/json',
          data: reportData,
          runId: context.runId,
          attemptId: context.attemptId,
          projectId: context.projectId,
          workspaceId: context.workspaceId,
          maxBytes: 64 * 1024,
          // Mirrors the report.generate capability: this step is that capability inside a workflow.
          retentionPolicy: 'permanent',
        });
        return { data: { generated: true }, artifacts: [art] };
      }

      default:
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unsupported workflow step type: ${step.type}`);
    }
  }

  private assertTarget(target: BrowserTarget): void {
    if (!target.projectId || !target.workspaceId || !target.runtimeId || !target.tabId) {
      throw new CapabilityError('TARGET_REQUIRED', 'Workflow execution requires an explicit BrowserTarget with projectId, workspaceId, runtimeId, and tabId');
    }
  }

}
