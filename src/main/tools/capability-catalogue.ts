import {
  CapabilityDefinition,
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  RuntimeFeatureSwitch,
  assertExactBrowserTarget,
  assertRuntimeLease,
  RuntimeLease,
  WorkspaceRecord,
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
  private readonly definitions = new Map<string, CapabilityDefinition>();
  private runtime: RuntimeFeatureSwitch;

  constructor(private readonly options: CapabilityCatalogueOptions) {
    this.runtime = { ...options.runtime };
  }

  register<TParams, TResult>(definition: CapabilityDefinition<TParams, TResult>): void {
    if (this.definitions.has(definition.name)) throw new Error(`Capability already registered: ${definition.name}`);
    this.definitions.set(definition.name, definition as CapabilityDefinition);
  }

  get(name: string): CapabilityDefinition | undefined { return this.definitions.get(name); }

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
    if ('attachmentId' in context && context.attachmentId) {
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
    if (definition.risk === 'eval' && !this.options.allowEval) return false;
    return this.runtime.mode === 'standalone' && grant === definition.risk;
  }
}
