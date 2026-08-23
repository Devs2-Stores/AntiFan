import { CapabilityCatalogue } from '../tools/capability-catalogue';
import { WorkflowEngine } from './workflow-engine';
import { BrowserTarget, CapabilityError } from '../../shared/control-plane-contracts';
import { WorkflowDefinition } from './workflow-schema';

export function registerWorkflowCapabilities(catalogue: CapabilityCatalogue, engine: WorkflowEngine): void {
  catalogue.register({
    name: 'workflow.execute',
    description: 'Execute an automated multi-step browser, QA, and validation workflow',
    risk: 'write',
    requiresBrowserTarget: true,
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'object' },
        workspaceRoot: { type: 'string' },
      },
      required: ['workflow', 'workspaceRoot'],
    },
    execute: async (params: { workflow: WorkflowDefinition; workspaceRoot: string }, context) => {
      if (!context.browserTarget) {
        throw new CapabilityError('TARGET_REQUIRED', 'workflow.execute requires a bound BrowserTarget');
      }
      return engine.execute({
        workflow: params.workflow,
        target: context.browserTarget as BrowserTarget,
        lease: context.lease,
        leaseToken: context.leaseToken,
        runId: context.runId || 'run-workflow',
        attemptId: context.attemptId || 'attempt-1',
        workspaceRoot: params.workspaceRoot,
        grant: context.grant,
      });
    },
  });
}
