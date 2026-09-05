import { CapabilityCatalogue } from './capability-catalogue';
import {
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  canonicalizeWorkspaceRoot,
} from '../../shared/control-plane-contracts';
import { ThemeTransactionRegistry, RuntimeTenancyIdentity } from '../qa/theme-transaction-registry';
import { ThemeWorkspaceContext } from '../../shared/theme-task-context';

export function registerThemeTransactionCapabilities(
  catalogue: CapabilityCatalogue,
  transactionRegistry: ThemeTransactionRegistry,
  getAuthoritativeWorkspaceRoot?: () => string
): void {
  const resolveRoot = (
    providedRoot?: string,
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): string => {
    if (providedRoot && typeof providedRoot === 'string' && providedRoot.trim()) {
      return canonicalizeWorkspaceRoot(providedRoot);
    }
    if (getAuthoritativeWorkspaceRoot) {
      const root = getAuthoritativeWorkspaceRoot();
      if (root) return canonicalizeWorkspaceRoot(root);
    }
    if (context && context.projectId && context.workspaceId) {
      try {
        const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
        if (ws?.rootPath) return canonicalizeWorkspaceRoot(ws.rootPath);
      } catch {}
    }
    throw new CapabilityError(
      'WORKSPACE_UNBOUND',
      'Cannot resolve workspaceRoot for theme transaction capability. Provide workspaceRoot explicitly or bind workspace tenancy.'
    );
  };

  const extractTenancy = (
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): Partial<RuntimeTenancyIdentity> | undefined => {
    if (!context) return undefined;
    const runtimeId = 'lease' in context ? context.lease?.runtimeId : undefined;
    return {
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      runtimeId,
    };
  };

  catalogue.register({
    name: 'theme.transaction.begin',
    description: 'Begin an atomic ThemeMutationSession: creates immutable R0 snapshot and acquires exclusive workspace lock',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        context: {
          type: 'object',
          description: 'Theme workspace context',
          properties: {
            storeId: { type: 'string' },
            storeDomain: { type: 'string' },
            themeId: { type: 'string' },
            workspaceRoot: { type: 'string' },
            targetTabId: { type: 'string' },
            platform: { type: 'string', enum: ['haravan', 'sapo', 'shopify'] },
          },
          required: ['storeId', 'storeDomain', 'themeId', 'workspaceRoot', 'targetTabId', 'platform'],
        },
        policy: {
          type: 'string',
          enum: ['HARD_FAIL_ROLLBACK', 'EXPLORATORY_HOLD', 'PERMISSIVE'],
        },
        initialBrowserEpoch: { type: 'number' },
        initialDocGen: { type: 'number' },
      },
      required: ['context'],
    },
    execute: async (
      params: {
        context: ThemeWorkspaceContext;
        policy?: 'HARD_FAIL_ROLLBACK' | 'EXPLORATORY_HOLD' | 'PERMISSIVE';
        initialBrowserEpoch?: number;
        initialDocGen?: number;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params || !params.context) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Parameter "context" is required for theme.transaction.begin');
      }
      try {
        const callerTenancy = extractTenancy(context);
        return await transactionRegistry.begin(
          params.context,
          callerTenancy,
          {
            policy: params.policy,
            initialBrowserEpoch: params.initialBrowserEpoch,
            initialDocGen: params.initialDocGen,
          }
        );
      } catch (err) {
        if (err instanceof CapabilityError) throw err;
        throw new CapabilityError('INVALID_ARGUMENT', err instanceof Error ? err.message : String(err));
      }
    },
  });

  catalogue.register({
    name: 'theme.transaction.write_cas',
    description: 'Execute an atomic Compare-And-Swap (CAS) write within the active ThemeMutationSession',
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
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
        relativePath: { type: 'string', description: 'Relative file path within workspace' },
        content: { type: 'string', description: 'File content to write' },
        expectedSha256: { type: 'string', description: 'Expected sha256 hash of existing file' },
      },
      required: ['relativePath', 'content'],
    },
    execute: async (
      params: {
        workspaceRoot?: string;
        relativePath: string;
        content: string;
        expectedSha256?: string;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params || !params.relativePath || typeof params.content !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Parameters "relativePath" and "content" are required for theme.transaction.write_cas');
      }
      const root = resolveRoot(params.workspaceRoot, context);
      const callerTenancy = extractTenancy(context);
      return await transactionRegistry.writeCAS(
        root,
        {
          relativePath: params.relativePath,
          content: params.content,
          expectedSha256: params.expectedSha256,
        },
        callerTenancy
      );
    },
  });

  catalogue.register({
    name: 'theme.transaction.settle',
    description: 'Settle an active ThemeMutationSession with VERIFIED, REJECTED, or HELD verdict',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
        verdict: { type: 'string', enum: ['VERIFIED', 'REJECTED', 'HELD'] },
        details: { type: 'object', description: 'Settlement details' },
      },
      required: ['verdict'],
    },
    execute: async (
      params: {
        workspaceRoot?: string;
        verdict: 'VERIFIED' | 'REJECTED' | 'HELD';
        details?: Record<string, unknown>;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params || !params.verdict) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Parameter "verdict" is required for theme.transaction.settle');
      }
      const root = resolveRoot(params.workspaceRoot, context);
      const callerTenancy = extractTenancy(context);
      return await transactionRegistry.settle(root, params.verdict, params.details, callerTenancy);
    },
  });

  catalogue.register({
    name: 'theme.transaction.rollback',
    description: 'Roll back an active ThemeMutationSession to its R0 snapshot',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
        reason: { type: 'string', description: 'Reason for rollback' },
      },
    },
    execute: async (
      params: {
        workspaceRoot?: string;
        reason?: string;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const root = resolveRoot(params?.workspaceRoot, context);
      const callerTenancy = extractTenancy(context);
      return await transactionRegistry.rollback(root, params?.reason, callerTenancy);
    },
  });

  catalogue.register({
    name: 'theme.transaction.resolve_hold',
    description: 'Resolve a held quarantine ThemeMutationSession by rolling back to R0',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
        action: { type: 'string', enum: ['rollback'] },
        reason: { type: 'string', description: 'Reason for resolving hold' },
      },
      required: ['action'],
    },
    execute: async (
      params: {
        workspaceRoot?: string;
        action: 'rollback';
        reason?: string;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params || params.action !== 'rollback') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Parameter "action" must be "rollback" for theme.transaction.resolve_hold');
      }
      const root = resolveRoot(params.workspaceRoot, context);
      const callerTenancy = extractTenancy(context);
      return await transactionRegistry.resolveHold(root, params.action, params.reason, callerTenancy);
    },
  });
}
