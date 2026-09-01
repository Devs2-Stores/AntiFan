import { CapabilityCatalogue } from '../tools/capability-catalogue';
import { WorkflowEngine } from './workflow-engine';
import { CapabilityError, BrowserTarget, AuthenticatedCapabilityContext } from '../../shared/control-plane-contracts';
import { WorkflowDefinition } from './workflow-schema';
export function registerWorkflowCapabilities(catalogue: CapabilityCatalogue, engine: WorkflowEngine): void {
  catalogue.register({
    name: 'workflow.execute',
    description: 'Execute an automated multi-step browser, QA, and validation workflow',
    risk: 'write',
    requiresBrowserTarget: false,
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 120_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 10_000,
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
    execute: async (params: Record<string, unknown>, rawContext) => {
      const context = rawContext as AuthenticatedCapabilityContext;
      if (!context.browserTarget) {
        throw new CapabilityError('TARGET_REQUIRED', 'workflow.execute requires a bound BrowserTarget');
      }
      const p = params as {
        workflow: WorkflowDefinition;
        workspaceRoot: string;
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
        signal: context.signal,
        progressSink: context.progressSink,
        authorityRevision: context.authorityRevision,
        parentInvocationId: context.invocationId,
        dispatchChildIntent: context.dispatchChildIntent,
      });
    },
  });
}
