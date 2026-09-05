import { CapabilityCatalogue } from './capability-catalogue';
import { WorkspaceFilePort } from './workspace-file-port';
import { CapabilityError, CapabilityRequestContext, AuthenticatedCapabilityContext, canonicalizeWorkspaceRoot } from '../../shared/control-plane-contracts';
import { ThemeTransactionRegistry } from '../qa/theme-transaction-registry';

export function registerFileCapabilities(
  catalogue: CapabilityCatalogue,
  files: WorkspaceFilePort,
  getAuthoritativeWorkspaceRoot?: () => string,
  transactionRegistry?: ThemeTransactionRegistry
): void {
  const resolveRoot = (context?: CapabilityRequestContext | AuthenticatedCapabilityContext): string => {
    if (!context || !context.projectId || !context.workspaceId) {
      throw new CapabilityError(
        'WORKSPACE_UNBOUND',
        'Operation rejected: Request lacks authoritative projectId/workspaceId context tenancy binding.'
      );
    }
    try {
      const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
      if (ws?.rootPath) return ws.rootPath;
    } catch (err) {
      throw new CapabilityError(
        'WORKSPACE_UNBOUND',
        `Authoritative workspace ${context.workspaceId} could not be resolved: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (getAuthoritativeWorkspaceRoot) {
      const root = getAuthoritativeWorkspaceRoot();
      if (root) return root;
    }
    throw new CapabilityError('WORKSPACE_UNBOUND', `Authoritative workspace ${context.workspaceId} has no resolved root path`);
  };
  catalogue.register({
    name: 'file.read',
    description: 'Read a file relative to authoritative workspace root with boundary enforcement',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the workspace' },
        maxBytes: { type: 'number', description: 'Maximum bytes to read' },
      },
      required: ['path'],
    },
    execute: (params: { path: string; maxBytes?: number }, context?: CapabilityRequestContext | AuthenticatedCapabilityContext) => {
      const root = resolveRoot(context);
      if (!root) throw new CapabilityError('WORKSPACE_MISMATCH', 'No authoritative workspace attached');
      if (!params.path || typeof params.path !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Relative file path is required');
      }
      return files.read(root, params.path, params.maxBytes);
    },
  });

  catalogue.register({
    name: 'file.write',
    description: 'Write a file relative to authoritative workspace root with boundary enforcement',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the workspace' },
        content: { type: 'string', description: 'File content to write' },
        expectedSha256: { type: 'string', description: 'Optional expected SHA256 of existing file for Compare-And-Swap (CAS)' },
      },
      required: ['path', 'content'],
    },
    execute: (params: { path: string; content: string; expectedSha256?: string }, context?: CapabilityRequestContext | AuthenticatedCapabilityContext) => {
      const root = resolveRoot(context);
      if (!root) throw new CapabilityError('WORKSPACE_MISMATCH', 'No authoritative workspace attached');
      if (!params.path || typeof params.path !== 'string' || typeof params.content !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Relative file path and content are required');
      }
      if (transactionRegistry) {
        const canonical = canonicalizeWorkspaceRoot(root);
        if (transactionRegistry.isLocked(canonical)) {
          const active = transactionRegistry.getActiveSession(canonical);
          throw new CapabilityError(
            'TRANSACTION_CONFLICT',
            `Workspace "${canonical}" is locked by active ThemeMutationSession "${active?.sessionId || 'in-flight'}". Direct file.write calls are rejected while a transaction is active. Mutations must be executed through theme transaction capabilities.`,
            { workspaceRoot: canonical, activeSessionId: active?.sessionId }
          );
        }
      }
      if (typeof params.expectedSha256 === 'string') {
        return files.writeCAS(root, params.path, params.content, params.expectedSha256);
      }
      return files.write(root, params.path, params.content);
    },
  });
  catalogue.register({
    name: 'file.assert_not_contains',
    description: 'Assert that a workspace file does not contain a forbidden pattern',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the workspace' },
        pattern: { type: 'string', description: 'Pattern that must not be present' },
      },
      required: ['path', 'pattern'],
    },
    execute: (params: { path: string; pattern: string }, context?: CapabilityRequestContext | AuthenticatedCapabilityContext) => {
      const root = resolveRoot(context);
      if (!root) throw new CapabilityError('WORKSPACE_MISMATCH', 'No authoritative workspace attached');
      if (!params.path || typeof params.path !== 'string' || !params.pattern || typeof params.pattern !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Relative file path and pattern are required');
      }
      const res = files.read(root, params.path);
      if (res.content.includes(params.pattern)) {
        throw new Error(`File '${params.path}' contains forbidden pattern: '${params.pattern}'`);
      }
      return { ok: true };
    },
  });
}
