import {
  CapabilityDefinition,
  CapabilityError,
  CapabilityRequestContext,
  RuntimeFeatureSwitch,
  assertExactBrowserTarget,
  assertRuntimeLease,
  RuntimeLease,
} from '../../shared/control-plane-contracts';

export interface CapabilityCatalogueOptions {
  runtime: RuntimeFeatureSwitch;
  projectId: string;
  workspaceId: string;
  runtimeId: string;
  hostEpoch?: number;
  getActiveLease?: () => RuntimeLease;
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

  async dispatch(name: string, params: Record<string, unknown>, context: CapabilityRequestContext): Promise<unknown> {
    if (this.runtime.lifecycle !== 'active') throw new CapabilityError('RUNTIME_DRAINING', 'Runtime is draining and accepts no new capability requests');
    const activeLease = this.options.getActiveLease?.();
    assertRuntimeLease(context.lease, { projectId: this.options.projectId, workspaceId: this.options.workspaceId, hostEpoch: this.options.hostEpoch, token: activeLease?.token || context.leaseToken });
    if (activeLease && (context.lease.runtimeId !== activeLease.runtimeId || context.lease.expiresAt !== activeLease.expiresAt)) throw new CapabilityError('UNAUTHENTICATED', 'Runtime lease is not the active authoritative lease');
    if (context.lease.runtimeId !== this.options.runtimeId) throw new CapabilityError('RUNTIME_MISMATCH', 'Capability request Runtime does not match the active control plane');
    if (context.projectId !== this.options.projectId) throw new CapabilityError('PROJECT_MISMATCH', 'Capability request Project does not match runtime');
    if (context.workspaceId !== this.options.workspaceId) throw new CapabilityError('WORKSPACE_MISMATCH', 'Capability request Workspace does not match runtime');
    const definition = this.definitions.get(name);
    if (!definition) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown capability: ${name}`);
    if (!this.isVisible(definition, context.grant)) throw new CapabilityError('POLICY_DENIED', `Capability ${name} is not enabled by the current policy`);
    if (definition.requiresBrowserTarget) assertExactBrowserTarget(context.browserTarget, { projectId: this.options.projectId, workspaceId: this.options.workspaceId, runtimeId: this.options.runtimeId }, true);
    return definition.execute(params, context);
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
