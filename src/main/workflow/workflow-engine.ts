import {
  ArtifactRef,
  BrowserTarget,
  CapabilityError,
  CapabilityRequestContext,
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
}

export class WorkflowEngine {
  constructor(private readonly ports: WorkflowEnginePorts) {}

  async execute(options: WorkflowExecutionOptions): Promise<WorkflowExecutionResult> {
    const { workflow, target, lease, leaseToken, runId, attemptId, grant, signal, onEvent } = options;

    // 1. Validate workflow schema
    const parsed = WorkflowDefinitionSchema.safeParse(workflow);
    if (!parsed.success) {
      throw new CapabilityError('INVALID_ARGUMENT', `Workflow definition validation failed: ${parsed.error.message}`);
    }
    const def = parsed.data;

    // 2. Validate browser target
    this.assertTarget(target);

    let currentTarget: BrowserTarget = { ...target };
    const stepResults: WorkflowStepResult[] = [];
    const allArtifacts: ArtifactRef[] = [];
    const startTime = Date.now();

    onEvent?.({ type: 'workflow:start' });

    let status: 'passed' | 'failed' | 'interrupted' = 'passed';

    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i];
      if (!step) continue;

      // Check abort signal before starting step
      if (signal?.aborted) {
        status = 'interrupted';
        onEvent?.({ type: 'step:start', stepId: step.id, stepName: step.name });
        const stepResult: WorkflowStepResult = {
          stepId: step.id,
          stepName: step.name,
          type: step.type,
          status: 'skipped',
          durationMs: 0,
          error: 'Workflow was aborted by caller',
        };
        stepResults.push(stepResult);
        onEvent?.({ type: 'step:end', stepId: step.id, stepName: step.name, status: 'skipped', error: stepResult.error });
        break;
      }

      onEvent?.({ type: 'step:start', stepId: step.id, stepName: step.name });
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

          const stepOutput = await this.executeStepWithTimeout(
            step,
            reqContext,
            step.timeoutMs,
            signal
          );

          if (stepOutput.updatedTarget) {
            currentTarget = stepOutput.updatedTarget;
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
          if (err instanceof CapabilityError && (
            err.code === 'PROJECT_MISMATCH' ||
            err.code === 'WORKSPACE_MISMATCH' ||
            err.code === 'RUNTIME_MISMATCH' ||
            err.code === 'UNAUTHENTICATED' ||
            err.code === 'POLICY_DENIED' ||
            err.code === 'TARGET_REQUIRED'
          )) {
            break;
          }
        }
      }

      if (!stepResult) {
        const errorMsg = lastError?.message || 'Unknown step execution failure';
        const isAborted = signal?.aborted || errorMsg.includes('aborted');
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
      onEvent?.({
        type: 'step:end',
        stepId: step.id,
        stepName: step.name,
        status: stepResult.status,
        durationMs: stepResult.durationMs,
        error: stepResult.error,
      });

      if (status !== 'passed' && !step.continueOnError) {
        // Skip remaining steps
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

    onEvent?.({ type: 'workflow:end', result: executionResult });

    return executionResult;
  }

  private async executeStepWithTimeout(
    step: WorkflowStep,
    context: CapabilityRequestContext,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ data?: unknown; artifacts?: ArtifactRef[]; updatedTarget?: BrowserTarget }> {
    let timer: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Step '${step.name}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(new Error('Workflow aborted'));
      } else if (signal) {
        signal.addEventListener('abort', () => reject(new Error('Workflow aborted')), { once: true });
      }
    });

    try {
      return await Promise.race([
        this.dispatchStep(step, context),
        timeoutPromise,
        abortPromise,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async dispatchStep(
    step: WorkflowStep,
    context: CapabilityRequestContext
  ): Promise<{ data?: unknown; artifacts?: ArtifactRef[]; updatedTarget?: BrowserTarget }> {
    const params = step.params as Record<string, unknown>;
    const tabId = typeof params.tabId === 'string' ? params.tabId : undefined;

    switch (step.type) {
      case 'browser.navigate': {
        const url = params.url;
        if (!url || typeof url !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'browser.navigate requires url');
        const res = (await this.ports.catalogue.dispatch('browser.navigate', { url, tabId }, context)) as { navigated: boolean; target: BrowserTarget };
        return { data: res, updatedTarget: res.target };
      }

      case 'browser.click': {
        const ok = await this.ports.catalogue.dispatch(
          'browser.agent-click',
          { selector: params.selector, ref: params.ref, x: params.x, y: params.y, label: params.label, tabId },
          context
        );
        return { data: { success: ok } };
      }

      case 'browser.type': {
        const text = params.text;
        if (typeof text !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'browser.agent-type requires text');
        const ok = await this.ports.catalogue.dispatch(
          'browser.agent-type',
          { selector: params.selector, text, clear: params.clear, tabId },
          context
        );
        return { data: { success: ok } };
      }

      case 'browser.scroll': {
        const ok = await this.ports.catalogue.dispatch(
          'browser.agent-scroll',
          { deltaY: params.deltaY, selector: params.selector, tabId },
          context
        );
        return { data: { success: ok } };
      }

      case 'browser.hover': {
        const ok = await this.ports.catalogue.dispatch(
          'browser.agent-hover',
          { selector: params.selector, x: params.x, y: params.y, label: params.label, tabId },
          context
        );
        return { data: { success: ok } };
      }

      case 'browser.highlight': {
        if (!params.selector || typeof params.selector !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'browser.agent-highlight requires selector');
        const ok = await this.ports.catalogue.dispatch(
          'browser.agent-highlight',
          { selector: params.selector, label: params.label, tabId },
          context
        );
        return { data: { success: ok } };
      }

      case 'browser.screenshot': {
        const res = await this.ports.catalogue.dispatch('browser.screenshot', { tabId }, { ...context, grant: 'read' });
        const artifacts: ArtifactRef[] = (typeof res === 'object' && res !== null && 'id' in res) ? [res as ArtifactRef] : [];
        return { data: { captured: true }, artifacts };
      }

      case 'browser.extract_dom': {
        const res = await this.ports.catalogue.dispatch('browser.dom', { selector: params.selector, tabId }, { ...context, grant: 'read' });
        const artifacts: ArtifactRef[] = (typeof res === 'object' && res !== null && 'id' in res) ? [res as ArtifactRef] : [];
        return { data: { extracted: true }, artifacts };
      }

      case 'browser.set_viewport': {
        const width = Number(params.width);
        const height = Number(params.height);
        if (!width || !height) throw new CapabilityError('INVALID_ARGUMENT', 'browser.set-viewport requires width and height');
        const res = await this.ports.catalogue.dispatch(
          'browser.set-viewport',
          { width, height, mobile: params.mobile, deviceScaleFactor: params.deviceScaleFactor, tabId },
          context
        );
        return { data: res };
      }

      case 'browser.set_device_preset': {
        const presetId = params.presetId;
        if (!presetId || typeof presetId !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'browser.set-device-preset requires presetId');
        const res = await this.ports.catalogue.dispatch(
          'browser.set-device-preset',
          { presetId, tabId },
          context
        );
        return { data: res };
      }

      case 'browser.set_zoom': {
        const zoomFactor = Number(params.zoomFactor);
        if (!zoomFactor) throw new CapabilityError('INVALID_ARGUMENT', 'browser.set-zoom requires zoomFactor');
        const res = await this.ports.catalogue.dispatch(
          'browser.set-zoom',
          { zoomFactor, tabId },
          context
        );
        return { data: res };
      }

      case 'browser.wait_for_selector': {
        const selector = params.selector;
        if (!selector || typeof selector !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'wait_for_selector requires selector');
        const pollIntervalMs = 100;
        const maxWaitMs = step.timeoutMs || 5000;
        const startPoll = Date.now();
        let found = false;

        while (Date.now() - startPoll < maxWaitMs) {
          try {
            const dom = await this.ports.catalogue.dispatch('browser.dom', { selector, tabId }, { ...context, grant: 'read' });
            if (dom) {
              found = true;
              break;
            }
          } catch {
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
        const diag = (await this.ports.catalogue.dispatch(
          'browser.diagnostics',
          { tabId: tabId || context.browserTarget?.tabId, level: 3 },
          { ...context, grant: 'read' }
        )) as { console?: any[]; failures?: any[] };
        const errors = diag?.console || [];
        if (errors.length > 0) {
          throw new Error(`Found ${errors.length} critical console error(s): ${errors.map((e: any) => e.text || e).join('; ')}`);
        }
        return { data: { errors: 0, passed: true } };
      }

      case 'qa.check_broken_images': {
        const diag = (await this.ports.catalogue.dispatch(
          'browser.diagnostics',
          { tabId: tabId || context.browserTarget?.tabId },
          { ...context, grant: 'read' }
        )) as { console?: any[]; failures?: any[] };
        const failures = diag?.failures || [];
        const imageFailures = failures.filter((f: any) => typeof f.url === 'string' && /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(f.url));
        if (imageFailures.length > 0) {
          throw new Error(`Found ${imageFailures.length} broken image(s): ${imageFailures.map((f: any) => f.url).join('; ')}`);
        }
        return { data: { brokenImages: 0, passed: true } };
      }

      case 'qa.check_overflow': {
        const res = (await this.ports.catalogue.dispatch(
          'browser.responsive-check',
          { tabId: tabId || context.browserTarget?.tabId },
          { ...context, grant: 'read' }
        )) as { hasHorizontalScrollbar?: boolean; scrollWidth?: number; clientWidth?: number };
        if (res?.hasHorizontalScrollbar) {
          throw new Error(`Horizontal overflow detected: scrollWidth (${res.scrollWidth}) > clientWidth (${res.clientWidth})`);
        }
        return { data: res };
      }

      case 'file.read': {
        const path = params.path;
        if (!path || typeof path !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'file.read requires path');
        const res = await this.ports.catalogue.dispatch('file.read', { path, maxBytes: params.maxBytes }, { ...context, grant: 'read' });
        return { data: res };
      }

      case 'file.write': {
        const path = params.path;
        const content = params.content;
        if (!path || typeof path !== 'string' || typeof content !== 'string') {
          throw new CapabilityError('INVALID_ARGUMENT', 'file.write requires path and content');
        }
        const res = await this.ports.catalogue.dispatch('file.write', { path, content }, context);
        return { data: res };
      }

      case 'file.assert_not_contains': {
        const path = params.path;
        const pattern = params.pattern;
        if (!path || typeof path !== 'string' || !pattern || typeof pattern !== 'string') {
          throw new CapabilityError('INVALID_ARGUMENT', 'file.assert_not_contains requires path and pattern');
        }
        const res = await this.ports.catalogue.dispatch('file.assert_not_contains', { path, pattern }, { ...context, grant: 'read' });
        return { data: res };
      }

      case 'report.generate': {
        const reportData = JSON.stringify({ name: step.name, params, target: context.browserTarget, timestamp: Date.now() }, null, 2);
        const art = this.ports.artifacts.stage({
          kind: 'report',
          mime: 'application/json',
          data: reportData,
          runId: context.runId || 'run-workflow',
          attemptId: context.attemptId || 'attempt-1',
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
