import {
  ArtifactRef,
  BrowserTarget,
  CapabilityError,
  CapabilityRequestContext,
  ClientInvocationIntent,
  RuntimeLease,
} from '../../shared/control-plane-contracts';
import { CapabilityCatalogue } from '../tools/capability-catalogue';
import { ArtifactStore } from '../tools/artifact-store';
import { CapabilityTransportAdapter, CapabilityTransportResponse } from '../tools/capability-transport';
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
  transport?: CapabilityTransportAdapter;
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
  dispatchChildIntent?: (stepId: string, attempt: number, intent: ClientInvocationIntent) => Promise<any>;
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

          const dispatchChild =
            dispatchChildIntent
              ? (intent: ClientInvocationIntent) => dispatchChildIntent(step.id, attempt, intent)
              : this.ports.transport && parentInvocationId
              ? (intent: ClientInvocationIntent) =>
                  this.ports.transport!.dispatchChildIntent(
                    parentInvocationId,
                    step.id,
                    attempt,
                    intent
                  )
              : undefined;

          const stepOutput = await this.executeStepWithTimeout(
            step,
            reqContext,
            step.timeoutMs,
            signal,
            dispatchChild
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
          // If error is security or lease mismatch, abort retries immediately
          if (
            err instanceof CapabilityError &&
            (err.code === 'PROJECT_MISMATCH' ||
              err.code === 'WORKSPACE_MISMATCH' ||
              err.code === 'RUNTIME_MISMATCH' ||
              err.code === 'UNAUTHENTICATED' ||
              err.code === 'POLICY_DENIED' ||
              err.code === 'TARGET_REQUIRED' ||
              err.code === 'AUTHENTICATION_DENIED')
          ) {
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
    signal?: AbortSignal,
    dispatchChild?: (intent: ClientInvocationIntent) => Promise<CapabilityTransportResponse>,
    attachmentContext?: { attachmentId: string; attachmentSecret: string; authorityRevision: string }
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
          stepAbortController.abort(timeoutErr);
          reject(timeoutErr);
        }, timeoutMs);
      }
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (stepAbortController.signal.aborted) {
        reject(stepAbortController.signal.reason || new Error('Workflow aborted'));
      } else {
        stepAbortController.signal.addEventListener(
          'abort',
          () => reject(stepAbortController.signal.reason || new Error('Workflow aborted')),
          { once: true }
        );
      }
    });

    try {
      return await Promise.race([
        this.dispatchStep(
          step,
          context,
          stepAbortController.signal,
          dispatchChild,
          attachmentContext
        ),
        timeoutPromise,
        abortPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  }

  private async dispatchStep(
    step: WorkflowStep,
    context: CapabilityRequestContext,
    signal: AbortSignal,
    dispatchChild?: (intent: ClientInvocationIntent) => Promise<CapabilityTransportResponse>,
    attachmentContext?: { attachmentId: string; attachmentSecret: string; authorityRevision: string }
  ): Promise<{ data?: unknown; artifacts?: ArtifactRef[]; updatedTarget?: BrowserTarget; replacementRevision?: string }> {
    const params = (step.params || {}) as Record<string, unknown>;
    const tabId = typeof params.tabId === 'string' ? params.tabId : undefined;

    const invokeCap = async (
      name: string,
      payload: Record<string, unknown>,
      ctx: CapabilityRequestContext = context
    ): Promise<{ data?: unknown; replacementRevision?: string }> => {
      if (dispatchChild) {
        const minimalIntent = {
          name,
          params: payload,
        } as unknown as ClientInvocationIntent;
        const resp = await dispatchChild(minimalIntent);
        if (!resp.ok) {
          const code = resp.error?.code || 'CAPABILITY_ERROR';
          const msg = resp.error?.message || 'Capability execution failed';
          throw new CapabilityError(code as any, msg);
        }
        return { data: resp.data, replacementRevision: resp.replacementAuthorityRevision };
      }
      const data = await this.ports.catalogue.dispatch(name, payload, { ...ctx, signal });
      return { data };
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
        const res = await invokeCap('browser.screenshot', { tabId }, { ...context, grant: 'read' });
        const artifacts: ArtifactRef[] = (typeof res.data === 'object' && res.data !== null && 'id' in res.data) ? [res.data as ArtifactRef] : [];
        return { data: { captured: true }, artifacts, replacementRevision: res.replacementRevision };
      }

      case 'browser.extract_dom': {
        const res = await invokeCap('browser.dom', { selector: params.selector, tabId }, { ...context, grant: 'read' });
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
        const pollIntervalMs = 100;
        const maxWaitMs = step.timeoutMs || 5000;
        const startPoll = Date.now();
        let found = false;

        while (Date.now() - startPoll < maxWaitMs) {
          if (signal?.aborted) {
            throw new Error('Workflow was aborted');
          }
          try {
            const domRes = await invokeCap('browser.dom', { selector, tabId }, { ...context, grant: 'read' });
            if (domRes.data) {
              found = true;
              break;
            }
          } catch (err) {
            if (signal?.aborted) {
              throw new Error('Workflow was aborted');
            }
            // keep polling
          }
          await this.delay(pollIntervalMs);
        }
        if (!found) {
          throw new Error(`Selector '${selector}' not found within ${maxWaitMs}ms`);
        }
        return { data: { found: true } };
      }

      case 'qa.check_console_errors': {
        const res = await invokeCap(
          'browser.diagnostics',
          { tabId: tabId || context.browserTarget?.tabId, level: 3 },
          { ...context, grant: 'read' }
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
          { tabId: tabId || context.browserTarget?.tabId },
          { ...context, grant: 'read' }
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
          { tabId: tabId || context.browserTarget?.tabId },
          { ...context, grant: 'read' }
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
        const res = await invokeCap('file.read', { path, maxBytes: params.maxBytes }, { ...context, grant: 'read' });
        return { data: res.data, replacementRevision: res.replacementRevision };
      }

      case 'file.write': {
        const path = params.path;
        const content = params.content;
        if (!path || typeof path !== 'string' || typeof content !== 'string') {
          throw new CapabilityError('INVALID_ARGUMENT', 'file.write requires path and content');
        }
        const res = await invokeCap('file.write', { path, content }, context);
        return { data: res.data, replacementRevision: res.replacementRevision };
      }

      case 'file.assert_not_contains': {
        const path = params.path;
        const pattern = params.pattern;
        if (!path || typeof path !== 'string' || !pattern || typeof pattern !== 'string') {
          throw new CapabilityError('INVALID_ARGUMENT', 'file.assert_not_contains requires path and pattern');
        }
        const res = await invokeCap('file.assert_not_contains', { path, pattern }, { ...context, grant: 'read' });
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
