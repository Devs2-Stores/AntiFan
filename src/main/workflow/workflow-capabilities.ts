import { CapabilityCatalogue } from '../tools/capability-catalogue';
import { WorkflowEngine } from './workflow-engine';
import { BrowserTarget, CapabilityError } from '../../shared/control-plane-contracts';
import { WorkflowDefinition, WorkflowEventListener } from './workflow-schema';
export function registerWorkflowCapabilities(catalogue: CapabilityCatalogue, engine: WorkflowEngine): void {
  catalogue.register({
    name: 'workflow.execute',
    description: 'Execute an automated multi-step browser, QA, and validation workflow',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: true,
      schedulerLane: 'viewport-gate',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 120_000,
      retentionPolicy: 'run-durable',
      cancellationBehavior: 'abort-immediate',
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'object' },
        workspaceRoot: { type: 'string' },
      },
      required: ['workflow', 'workspaceRoot'],
    },
    execute: async (params: Record<string, unknown>, context) => {
      if (!context.browserTarget) {
        throw new CapabilityError('TARGET_REQUIRED', 'workflow.execute requires a bound BrowserTarget');
      }
      const p = params as unknown as {
        workflow: WorkflowDefinition;
        workspaceRoot: string;
        signal?: AbortSignal;
        onEvent?: WorkflowEventListener;
        attachmentId?: string;
        attachmentSecret?: string;
        authorityRevision?: string;
        parentInvocationId?: string;
      };
      return engine.execute({
        workflow: p.workflow,
        target: context.browserTarget as BrowserTarget,
        lease: context.lease,
        leaseToken: context.leaseToken,
        runId: context.runId || 'run-workflow',
        attemptId: context.attemptId || 'attempt-1',
        workspaceRoot: p.workspaceRoot,
        grant: context.grant,
        signal: p.signal,
        onEvent: p.onEvent,
        attachmentId: p.attachmentId,
        attachmentSecret: p.attachmentSecret,
        authorityRevision: p.authorityRevision,
        parentInvocationId: p.parentInvocationId,
      });
    },
  });
}
