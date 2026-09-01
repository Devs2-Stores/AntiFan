import {
  CapabilityDefinition,
  RegisteredCapability,
  CapabilityEffectPolicy,
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  RuntimeFeatureSwitch,
  assertExactBrowserTarget,
  assertRuntimeLease,
  RuntimeLease,
  WorkspaceRecord,
  computePolicyDigest,
} from '../../shared/control-plane-contracts';
import { WorkspaceRegistry } from '../project/workspace-registry';

export interface CapabilityCatalogueOptions {
  runtime: RuntimeFeatureSwitch;
  projectId: string;
  workspaceId: string;
  runtimeId: string;
  hostEpoch?: number;
  getActiveLease?: () => RuntimeLease;
  workspaceRegistry?: WorkspaceRegistry;
  allowEval?: boolean;
}

export class CapabilityCatalogue {
  private readonly definitions = new Map<string, RegisteredCapability>();
  private runtime: RuntimeFeatureSwitch;

  constructor(private readonly options: CapabilityCatalogueOptions) {
    this.runtime = { ...options.runtime };
  }

  register<TParams, TResult>(definition: CapabilityDefinition<TParams, TResult>): void {
    if (this.definitions.has(definition.name)) throw new Error(`Capability already registered: ${definition.name}`);
    if (!definition.policy) throw new Error(`Capability ${definition.name} missing required CapabilityEffectPolicy`);

    const p = definition.policy;
    if (definition.risk !== p.risk) {
      throw new Error(`Capability ${definition.name} definition risk '${definition.risk}' does not match policy risk '${p.risk}'`);
    }
    if (Boolean(definition.requiresBrowserTarget) !== Boolean(p.requiresBrowserTarget)) {
      throw new Error(`Capability ${definition.name} definition requiresBrowserTarget '${Boolean(definition.requiresBrowserTarget)}' does not match policy '${Boolean(p.requiresBrowserTarget)}'`);
    }
    if (!p.timeoutMs || p.timeoutMs <= 0) {
      throw new Error(`Capability ${definition.name} policy timeoutMs must be positive`);
    }
    if (!p.policyVersion || p.policyVersion <= 0) {
      throw new Error(`Capability ${definition.name} policy policyVersion must be positive`);
    }
    const validLanes = new Set(['short-passive', 'event-wait', 'viewport-gate', 'unbounded']);
    if (!p.schedulerLane || !validLanes.has(p.schedulerLane)) {
      throw new Error(`Capability ${definition.name} policy has invalid schedulerLane '${p.schedulerLane}'`);
    }
    const validDuplicateModes = new Set(['in-process-join', 'reject-concurrent']);
    if (!p.duplicateMode || !validDuplicateModes.has(p.duplicateMode)) {
      throw new Error(`Capability ${definition.name} policy has invalid duplicateMode '${p.duplicateMode}'`);
    }
    const validVisibilities = new Set(['public', 'tenant-scoped', 'run-scoped', 'redacted']);
    if (!p.recordedVisibility || !validVisibilities.has(p.recordedVisibility)) {
      throw new Error(`Capability ${definition.name} policy has invalid recordedVisibility '${p.recordedVisibility}'`);
    }
    const validReceiptPermissions = new Set(['read', 'write', 'execute', 'eval']);
    if (!p.receiptReadPermission || !validReceiptPermissions.has(p.receiptReadPermission)) {
      throw new Error(`Capability ${definition.name} policy has invalid receiptReadPermission '${p.receiptReadPermission}'`);
    }
    const validRetentions = new Set(['ephemeral', 'run-durable', 'permanent']);
    if (!p.retentionPolicy || !validRetentions.has(p.retentionPolicy)) {
      throw new Error(`Capability ${definition.name} policy has invalid retentionPolicy '${p.retentionPolicy}'`);
    }
    const validCancellations = new Set(['abort-immediate', 'drain-and-persist', 'ignore-disconnect']);
    if (!p.cancellationBehavior || !validCancellations.has(p.cancellationBehavior)) {
      throw new Error(`Capability ${definition.name} policy has invalid cancellationBehavior '${p.cancellationBehavior}'`);
    }
    if (p.effect === 'read' && (p.risk === 'write' || p.risk === 'execute' || p.risk === 'eval')) {
      throw new Error(`Capability ${definition.name} has read effect but write/execute/eval risk`);
    }
    if (p.effect === 'destructive-mutation' && (p.duplicateMode !== 'reject-concurrent' || p.cancellationBehavior === 'ignore-disconnect')) {
      throw new Error(`Capability ${definition.name} has destructive-mutation effect and must use reject-concurrent and abortable cancellation`);
    }
    if (p.schedulerLane === 'short-passive' && p.effect !== 'read') {
      throw new Error(`Capability ${definition.name} uses short-passive lane but has non-read effect`);
    }
    if (p.schedulerLane === 'viewport-gate' && !p.requiresBrowserTarget) {
      throw new Error(`Capability ${definition.name} uses viewport-gate lane but requiresBrowserTarget is false`);
    }
    const digest = computePolicyDigest(p);
    const frozenPolicy: CapabilityEffectPolicy = Object.freeze({
      ...p,
      policyDigest: digest,
    });

    this.definitions.set(definition.name, {
      ...definition,
      policy: frozenPolicy,
    } as RegisteredCapability);
  }

  getPolicy(name: string): CapabilityEffectPolicy | undefined {
    return this.definitions.get(name)?.policy;
  }

  get(name: string): RegisteredCapability | undefined { return this.definitions.get(name); }

  list(context?: Pick<CapabilityRequestContext, 'grant'>): Array<{ name: string; description: string; risk: string; inputSchema: Record<string, unknown> }> {
    return Array.from(this.definitions.values()).filter((definition) => this.isVisible(definition, context?.grant)).map((definition) => ({ name: definition.name, description: definition.description, risk: definition.risk, inputSchema: definition.inputSchema }));
  }

  listAll(): Array<{ name: string; description: string; risk: string; inputSchema: Record<string, unknown> }> {
    return Array.from(this.definitions.values()).map((definition) => ({ name: definition.name, description: definition.description, risk: definition.risk, inputSchema: definition.inputSchema }));
  }

  public resolveAuthoritativeWorkspace(projectId: string, workspaceId: string): WorkspaceRecord {
    if (this.options.workspaceRegistry) {
      try {
        const ws = this.options.workspaceRegistry.get(workspaceId, projectId);
        if (ws && ws.state === 'attached') {
          return ws;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Project')) {
          throw new CapabilityError('PROJECT_MISMATCH', `Workspace '${workspaceId}' does not belong to Project '${projectId}'`);
        }
        throw new CapabilityError('WORKSPACE_MISMATCH', `Workspace '${workspaceId}' is not attached to Project '${projectId}'`);
      }
      throw new CapabilityError('WORKSPACE_MISMATCH', `Workspace '${workspaceId}' is not attached`);
    }

    if (projectId !== this.options.projectId) throw new CapabilityError('PROJECT_MISMATCH', 'Capability request Project does not match runtime');
    if (workspaceId !== this.options.workspaceId) throw new CapabilityError('WORKSPACE_MISMATCH', 'Capability request Workspace does not match runtime');
    return { id: workspaceId, projectId, rootPath: '', state: 'attached', createdAt: 0, updatedAt: 0 };
  }

  async dispatchAuthenticated(name: string, params: Record<string, unknown>, context: AuthenticatedCapabilityContext): Promise<unknown> {
    if (this.runtime.lifecycle !== 'active') throw new CapabilityError('RUNTIME_DRAINING', 'Runtime is draining and accepts no new capability requests');

    const authoritativeWs = this.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);

    assertRuntimeLease(context.lease, {
      projectId: authoritativeWs.projectId,
      workspaceId: authoritativeWs.id,
      hostEpoch: this.options.hostEpoch,
      token: context.leaseToken
    });

    if (context.lease.runtimeId !== this.options.runtimeId) {
      throw new CapabilityError('RUNTIME_MISMATCH', 'Capability request Runtime does not match the active control plane');
    }

    const definition = this.definitions.get(name);
    if (!definition) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown capability: ${name}`);
    if (!this.isVisible(definition, context.grant)) throw new CapabilityError('POLICY_DENIED', `Capability ${name} is not enabled by the current policy`);

    if (definition.requiresBrowserTarget) {
      assertExactBrowserTarget(context.browserTarget, {
        projectId: authoritativeWs.projectId,
        workspaceId: authoritativeWs.id,
        runtimeId: this.options.runtimeId
      }, true);
      if (params && typeof params === 'object' && typeof (params as Record<string, unknown>).tabId === 'string') {
        const reqTabId = ((params as Record<string, unknown>).tabId as string).trim();
        if (reqTabId && context.browserTarget?.tabId && reqTabId !== context.browserTarget.tabId) {
          throw new CapabilityError('TARGET_MISMATCH', `Tab ID mismatch: expected ${context.browserTarget.tabId}, got ${reqTabId}`);
        }
      }
    }

    return definition.execute(params, context);
  }

  async dispatchTrusted(name: string, params: Record<string, unknown>, context: CapabilityRequestContext): Promise<unknown> {
    if (this.runtime.lifecycle !== 'active') throw new CapabilityError('RUNTIME_DRAINING', 'Runtime is draining and accepts no new capability requests');

    const authoritativeWs = this.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
    const isPrimaryWorkspace = context.projectId === this.options.projectId && context.workspaceId === this.options.workspaceId;
    const activeLease = isPrimaryWorkspace ? this.options.getActiveLease?.() : undefined;

    assertRuntimeLease(context.lease, {
      projectId: authoritativeWs.projectId,
      workspaceId: authoritativeWs.id,
      hostEpoch: this.options.hostEpoch,
      token: activeLease ? activeLease.token : context.leaseToken
    });

    if (activeLease && context.lease.runtimeId !== activeLease.runtimeId) {
      throw new CapabilityError('UNAUTHENTICATED', 'Runtime lease is not the active authoritative lease');
    }

    if (context.lease.runtimeId !== this.options.runtimeId) {
      throw new CapabilityError('RUNTIME_MISMATCH', 'Capability request Runtime does not match the active control plane');
    }

    const definition = this.definitions.get(name);
    if (!definition) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown capability: ${name}`);
    if (!this.isVisible(definition, context.grant)) throw new CapabilityError('POLICY_DENIED', `Capability ${name} is not enabled by the current policy`);

    if (definition.requiresBrowserTarget) {
      assertExactBrowserTarget(context.browserTarget, {
        projectId: authoritativeWs.projectId,
        workspaceId: authoritativeWs.id,
        runtimeId: this.options.runtimeId
      }, true);
    }

    return definition.execute(params, context);
  }
  async dispatch(name: string, params: Record<string, unknown>, context: CapabilityRequestContext | AuthenticatedCapabilityContext): Promise<unknown> {
    if (!context || typeof context !== 'object' || !context.projectId || !context.workspaceId) {
      throw new CapabilityError(
        'WORKSPACE_UNBOUND',
        'Capability dispatch rejected: Request lacks authoritative projectId/workspaceId context tenancy binding'
      );
    }
    if ('attachmentId' in context && context.attachmentId && 'backendId' in context && 'invocationId' in context) {
      return this.dispatchAuthenticated(name, params, context as AuthenticatedCapabilityContext);
    }
    return this.dispatchTrusted(name, params, context);
  }

  beginDrain(): void { this.runtime = { ...this.runtime, lifecycle: 'draining' }; }
  completeDrain(): void { this.runtime = { ...this.runtime, lifecycle: 'drained' }; }
  switchToLegacy(): void { this.runtime = { mode: 'legacy', lifecycle: 'legacy' }; }
  getLifecycle(): RuntimeFeatureSwitch { return { ...this.runtime }; }

  private isVisible(definition: CapabilityDefinition, grant?: CapabilityRequestContext['grant']): boolean {
    if (definition.risk === 'read') return true;
    if (this.runtime.mode !== 'standalone') return false;
    if (grant === 'write') return definition.risk === 'write';
    if (grant === 'execute') return definition.risk === 'execute';
    if (grant === 'eval') return this.options.allowEval === true && definition.risk === 'eval';
    return false;
  }
}
