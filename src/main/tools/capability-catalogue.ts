import {
  CapabilityDefinition,
  RegisteredCapability,
  CapabilityEffectPolicy,
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  RuntimeFeatureSwitch,
  assertExactBrowserTarget,
  assertExactDeviceTarget,
  assertRuntimeLease,
  RuntimeLease,
  WorkspaceRecord,
  computePolicyDigest,
  DeviceBinding,
  DeviceTarget,
} from '../../shared/control-plane-contracts';
import { WorkspaceRegistry } from '../project/workspace-registry';
import { DEVICE_ERROR_REMEDIATION } from '../../shared/device-control-contracts';

export interface SessionCapabilityFilter {
  allowedCapabilityNames?: string[];
  forbiddenCapabilityNames?: string[];
}

export function matchCapabilityPattern(name: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === '*' || trimmed === name) return true;
  if (!trimmed.includes('*') && !trimmed.includes('?')) return name === trimmed;
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Device counterpart to `CapabilityCatalogue.authorizeAndResolveEffectiveTarget`.
 *
 * Authority model: the LIVE BINDING is the authority, because it comes from the adapter's own
 * enumeration. A caller-supplied `deviceTarget` is never trusted — when one is present it must match
 * the live binding exactly (attachment epoch, session generation, ownership) or the call fails closed.
 * That is what makes a target captured before a re-plug or a WebDriverAgent restart refuse to run.
 *
 * A host-bound target is not required to act: the capability then runs against the live binding the
 * host itself observed, which is strictly more trustworthy than anything a caller could send.
 */
function authorizeAndResolveEffectiveDeviceTarget(
  context: CapabilityRequestContext,
  liveBinding: (DeviceBinding & { sessionId?: string }) | undefined,
  allowMissingSession: boolean,
  surfaceRegistered: boolean
): void {
  if (!surfaceRegistered) {
    // A runtime that never registered a device adapter is a configuration fact, not a caller error:
    // say so plainly instead of reporting a missing device.
    throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Device capability rejected: this runtime has no device surface registered');
  }
  if (!liveBinding) {
    // The adapter is registered but nothing is attached or selected. Failing open here is what would
    // let an operation run against a device identity the host never observed.
    throw new CapabilityError('DEVICE_NOT_CONNECTED', 'Device capability rejected: no device is currently attached or selected', {
      remediation: DEVICE_ERROR_REMEDIATION.DEVICE_NOT_CONNECTED,
      canRebind: true,
    });
  }
  if (context.deviceTarget) {
    assertExactDeviceTarget(context.deviceTarget, liveBinding, { allowMissingSession });
  }
  if (!allowMissingSession && !liveBinding.sessionId) {
    throw new CapabilityError('TARGET_REQUIRED', 'Device has no automation session; call device.open_safari first', {
      remediation: DEVICE_ERROR_REMEDIATION.DEVICE_SESSION_FAILED,
      canRebind: true,
    });
  }
  // Publish the authoritative identity for the capability body and the receipt.
  context.deviceOperation = {
    projectId: liveBinding.projectId,
    workspaceId: liveBinding.workspaceId,
    runtimeId: liveBinding.runtimeId,
    deviceId: liveBinding.deviceId,
    deviceEpoch: liveBinding.deviceEpoch,
    sessionId: liveBinding.sessionId,
    sessionGeneration: liveBinding.sessionGeneration,
  };
}

export function isCapabilityNamePermitted(name: string, filter?: SessionCapabilityFilter): boolean {
  if (!filter) return true;
  const { allowedCapabilityNames, forbiddenCapabilityNames } = filter;
  if (!allowedCapabilityNames && !forbiddenCapabilityNames) return true;

  if (forbiddenCapabilityNames && forbiddenCapabilityNames.length > 0) {
    for (const pat of forbiddenCapabilityNames) {
      if (matchCapabilityPattern(name, pat)) {
        return false;
      }
    }
  }

  if (allowedCapabilityNames && allowedCapabilityNames.length > 0) {
    let hasPositiveRule = false;
    let allowedByPositiveRule = false;

    for (const rawPat of allowedCapabilityNames) {
      const pat = rawPat.trim();
      if (!pat) continue;
      if (pat.startsWith('!')) {
        if (matchCapabilityPattern(name, pat.slice(1))) {
          return false;
        }
      } else {
        hasPositiveRule = true;
        if (matchCapabilityPattern(name, pat)) {
          allowedByPositiveRule = true;
        }
      }
    }

    if (hasPositiveRule && !allowedByPositiveRule) {
      return false;
    }
  }

  return true;
}

export interface CapabilityCatalogueOptions {
  runtime: RuntimeFeatureSwitch;
  projectId: string;
  workspaceId: string;
  runtimeId: string;
  hostEpoch?: number;
  getActiveLease?: () => RuntimeLease;
  workspaceRegistry?: WorkspaceRegistry;
  allowEval?: boolean;
  isTabAllowed?: (primaryTabId: string, requestedTabId: string) => boolean;
  resolveTabId?: (tabIdOrIdentifier: string) => string | undefined;
  resolveFailoverTabId?: (staleTabId: string) => string | undefined;
  getDocumentGeneration?: (tabId?: string) => number;
  /**
   * Live device attachment/session binding, written by the registered device adapter. Absent when no
   * device surface is registered, in which case device capabilities fail closed (`TARGET_REQUIRED`)
   * rather than trusting a caller-supplied device identity.
   */
  getDeviceBinding?: () => (DeviceBinding & { sessionId?: string }) | undefined;
}

export class CapabilityCatalogue {
  private readonly definitions = new Map<string, RegisteredCapability>();
  private readonly sessionFilters = new Map<string, SessionCapabilityFilter>();
  private runtime: RuntimeFeatureSwitch;
  private revisionCounter = 1;

  constructor(private readonly options: CapabilityCatalogueOptions) {
    this.runtime = { ...options.runtime };
  }

  getDocumentGeneration(tabId?: string): number | undefined {
    if (this.options.getDocumentGeneration) {
      try {
        const liveGen = this.options.getDocumentGeneration(tabId);
        if (typeof liveGen === 'number' && Number.isFinite(liveGen) && liveGen > 0) {
          return Math.floor(liveGen);
        }
      } catch {}
    }
    return undefined;
  }

  resolveTabId(tabIdOrIdentifier: string): string | undefined {
    if (this.options.resolveTabId) {
      try {
        return this.options.resolveTabId(tabIdOrIdentifier);
      } catch {}
    }
    return undefined;
  }

  /**
   * Names a live replacement tab for a bound tab that no longer exists, so a session
   * whose tab was closed keeps working instead of failing every later call as stale.
   * Only the host may answer this: it owns tab liveness and session ownership.
   */
  resolveFailoverTabId(staleTabId: string): string | undefined {
    if (this.options.resolveFailoverTabId) {
      try {
        const replacement = this.options.resolveFailoverTabId(staleTabId);
        if (typeof replacement === 'string' && replacement.trim().length > 0) return replacement.trim();
      } catch {}
    }
    return undefined;
  }
  hasWorkspaceRegistry(): boolean {
    return Boolean(this.options.workspaceRegistry);
  }

  private validateAndFreezePolicy<TParams, TResult>(definition: CapabilityDefinition<TParams, TResult>): CapabilityEffectPolicy {
    if (!definition.policy) throw new Error(`Capability ${definition.name} missing required CapabilityEffectPolicy`);

    // `requiresDeviceTarget` is optional on input (policies authored before the device surface never
    // mention it) but always present on the frozen policy, so the mirror check and the digest below
    // compare one concrete value instead of treating `undefined` and `false` as different policies.
    const p = { ...definition.policy, requiresDeviceTarget: Boolean(definition.policy.requiresDeviceTarget) };
    if (definition.risk !== p.risk) {
      throw new Error(`Capability ${definition.name} definition risk '${definition.risk}' does not match policy risk '${p.risk}'`);
    }
    if (Boolean(definition.requiresBrowserTarget) !== Boolean(p.requiresBrowserTarget)) {
      throw new Error(`Capability ${definition.name} definition requiresBrowserTarget '${Boolean(definition.requiresBrowserTarget)}' does not match policy '${Boolean(p.requiresBrowserTarget)}'`);
    }
    if (Boolean(definition.requiresDeviceTarget) !== Boolean(p.requiresDeviceTarget)) {
      throw new Error(`Capability ${definition.name} definition requiresDeviceTarget '${Boolean(definition.requiresDeviceTarget)}' does not match policy '${Boolean(p.requiresDeviceTarget)}'`);
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
    const validOwnerCancellations = new Set(['abort-immediate', 'drain-and-persist']);
    if (!p.ownerCancellationBehavior || !validOwnerCancellations.has(p.ownerCancellationBehavior)) {
      throw new Error(`Capability ${definition.name} policy has invalid ownerCancellationBehavior '${p.ownerCancellationBehavior}'`);
    }
    const validSubscriberDisconnects = new Set(['abort-when-unobserved', 'detach-and-continue']);
    if (!p.subscriberDisconnectBehavior || !validSubscriberDisconnects.has(p.subscriberDisconnectBehavior)) {
      throw new Error(`Capability ${definition.name} policy has invalid subscriberDisconnectBehavior '${p.subscriberDisconnectBehavior}'`);
    }
    if (!p.cancellationAckTimeoutMs || p.cancellationAckTimeoutMs <= 0 || p.cancellationAckTimeoutMs > p.timeoutMs) {
      throw new Error(`Capability ${definition.name} policy cancellationAckTimeoutMs must be positive and <= timeoutMs`);
    }
    if (p.subscriberDisconnectBehavior === 'abort-when-unobserved' && p.ownerCancellationBehavior !== 'abort-immediate') {
      throw new Error(`Capability ${definition.name} policy cannot use abort-when-unobserved with drain-and-persist`);
    }
    if (p.ownerCancellationBehavior === 'drain-and-persist' && p.subscriberDisconnectBehavior !== 'detach-and-continue') {
      throw new Error(`Capability ${definition.name} policy with drain-and-persist requires detach-and-continue`);
    }
    if (p.effect === 'read' && (p.risk === 'write' || p.risk === 'execute' || p.risk === 'eval')) {
      throw new Error(`Capability ${definition.name} has read effect but write/execute/eval risk`);
    }
    if (p.effect === 'destructive-mutation' && (p.duplicateMode !== 'reject-concurrent' || p.ownerCancellationBehavior !== 'abort-immediate')) {
      throw new Error(`Capability ${definition.name} has destructive-mutation effect and must use reject-concurrent and abortable cancellation`);
    }
    if (p.schedulerLane === 'short-passive' && p.effect !== 'read') {
      throw new Error(`Capability ${definition.name} uses short-passive lane but has non-read effect`);
    }
    // A viewport-gate operation mutates a rendering surface, and either surface qualifies: a Chromium
    // tab (browser target) or a physical device panel (device target). Requiring a browser target
    // unconditionally would make the device surface impossible to register at all.
    if (p.schedulerLane === 'viewport-gate' && !p.requiresBrowserTarget && !p.requiresDeviceTarget) {
      throw new Error(`Capability ${definition.name} uses viewport-gate lane but requires neither a browser nor a device target`);
    }
    const digest = computePolicyDigest(p);
    return Object.freeze({
      ...p,
      policyDigest: digest,
    });
  }

  register<TParams, TResult>(definition: CapabilityDefinition<TParams, TResult>): void {
    if (this.definitions.has(definition.name)) throw new Error(`Capability already registered: ${definition.name}`);
    const frozenPolicy = this.validateAndFreezePolicy(definition);

    this.definitions.set(definition.name, {
      ...definition,
      policy: frozenPolicy,
    } as RegisteredCapability);
  }

  /**
   * Hot-swap or update an existing capability definition in place without restarting the application.
   * Validates policy invariants before swapping to ensure fail-closed safety.
   */
  swapCapability<TParams, TResult>(definition: CapabilityDefinition<TParams, TResult>): { swapped: boolean; revision: number } {
    const frozenPolicy = this.validateAndFreezePolicy(definition);
    const existing = this.definitions.get(definition.name);
    this.revisionCounter++;

    this.definitions.set(definition.name, {
      ...definition,
      policy: frozenPolicy,
    } as RegisteredCapability);

    return {
      swapped: Boolean(existing),
      revision: this.revisionCounter,
    };
  }

  public getRevision(): number {
    return this.revisionCounter;
  }

  public has(name: string): boolean {
    return this.definitions.has(name);
  }

  getPolicy(name: string): CapabilityEffectPolicy | undefined {
    return this.definitions.get(name)?.policy;
  }

  get(name: string): RegisteredCapability | undefined { return this.definitions.get(name); }

  list(context?: (Pick<CapabilityRequestContext, 'grant'> & {
    attachmentId?: string;
    runId?: string;
    attemptId?: string;
    allowedCapabilityNames?: string[];
    forbiddenCapabilityNames?: string[];
  })): Array<{ name: string; description: string; risk: string; inputSchema: Record<string, unknown> }> {
    const sessionFilter = this.resolveSessionFilter(context);
    return Array.from(this.definitions.values())
      .filter((definition) => this.isVisible(definition, context?.grant, sessionFilter))
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        risk: definition.risk,
        inputSchema: definition.inputSchema
      }));
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

    const sessionFilter = this.resolveSessionFilter(context);
    if (sessionFilter && !isCapabilityNamePermitted(name, sessionFilter)) {
      throw new CapabilityError('REFUSED_TOOL_SURFACE', `Capability '${name}' is forbidden by session tool surface policy`);
    }

    const definition = this.definitions.get(name);
    if (!definition) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown capability: ${name}`);
    if (!this.isVisible(definition, context.grant, sessionFilter)) {
      if (sessionFilter && !isCapabilityNamePermitted(name, sessionFilter)) {
        throw new CapabilityError('REFUSED_TOOL_SURFACE', `Capability '${name}' is forbidden by session tool surface policy`);
      }
      throw new CapabilityError('POLICY_DENIED', `Capability ${name} is not enabled by the current policy`);
    }

    if (definition.requiresBrowserTarget) {
      this.authorizeAndResolveEffectiveTarget(params, context, authoritativeWs, definition.name);
    }
    if (definition.requiresDeviceTarget || context.deviceTarget) {
      // Nothing in this codebase populates `context.deviceTarget` (it is not part of any caller-supplied
      // request context), so this branch is entered by device capabilities only. The strict form is kept
      // on purpose: were a foreign target ever supplied, it must fail closed rather than be ignored.
      authorizeAndResolveEffectiveDeviceTarget(
        context,
        this.options.getDeviceBinding?.(),
        definition.allowMissingDeviceSession === true,
        typeof this.options.getDeviceBinding === 'function'
      );
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

    const sessionFilter = this.resolveSessionFilter(context);
    if (sessionFilter && !isCapabilityNamePermitted(name, sessionFilter)) {
      throw new CapabilityError('REFUSED_TOOL_SURFACE', `Capability '${name}' is forbidden by session tool surface policy`);
    }

    const definition = this.definitions.get(name);
    if (!definition) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown capability: ${name}`);
    if (!this.isVisible(definition, context.grant, sessionFilter)) {
      if (sessionFilter && !isCapabilityNamePermitted(name, sessionFilter)) {
        throw new CapabilityError('REFUSED_TOOL_SURFACE', `Capability '${name}' is forbidden by session tool surface policy`);
      }
      throw new CapabilityError('POLICY_DENIED', `Capability ${name} is not enabled by the current policy`);
    }

    if (definition.requiresBrowserTarget) {
      this.authorizeAndResolveEffectiveTarget(params, context, authoritativeWs, definition.name);
    }
    if (definition.requiresDeviceTarget || context.deviceTarget) {
      // Same strict contract as the authenticated path (see the note there).
      authorizeAndResolveEffectiveDeviceTarget(
        context,
        this.options.getDeviceBinding?.(),
        definition.allowMissingDeviceSession === true,
        typeof this.options.getDeviceBinding === 'function'
      );
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

  public isVisible(
    definition: CapabilityDefinition,
    grant?: CapabilityRequestContext['grant'],
    filter?: SessionCapabilityFilter
  ): boolean {
    if (filter && !isCapabilityNamePermitted(definition.name, filter)) return false;
    if (definition.risk === 'read') return true;
    if (this.runtime.mode !== 'standalone') return false;
    if (grant === 'write') return definition.risk === 'write';
    if (grant === 'execute') return definition.risk === 'execute';
    if (grant === 'eval') return this.options.allowEval === true && (definition.risk === 'eval' || definition.risk === 'write');
    return false;
  }

  public setSessionFilter(sessionIdOrAttachmentId: string, filter: SessionCapabilityFilter): void {
    this.sessionFilters.set(sessionIdOrAttachmentId, filter);
  }

  public removeSessionFilter(sessionIdOrAttachmentId: string): void {
    this.sessionFilters.delete(sessionIdOrAttachmentId);
  }

  public getSessionFilter(sessionIdOrAttachmentId: string): SessionCapabilityFilter | undefined {
    return this.sessionFilters.get(sessionIdOrAttachmentId);
  }

  public resolveSessionFilter(
    context?: unknown
  ): SessionCapabilityFilter | undefined {
    if (!context || typeof context !== 'object') return undefined;
    const ctx = context as Record<string, unknown>;
    if (Array.isArray(ctx.allowedCapabilityNames) || Array.isArray(ctx.forbiddenCapabilityNames)) {
      return {
        allowedCapabilityNames: Array.isArray(ctx.allowedCapabilityNames) ? ctx.allowedCapabilityNames.map(String) : undefined,
        forbiddenCapabilityNames: Array.isArray(ctx.forbiddenCapabilityNames) ? ctx.forbiddenCapabilityNames.map(String) : undefined,
      };
    }
    if (typeof ctx.attachmentId === 'string' && ctx.attachmentId) {
      const filter = this.sessionFilters.get(ctx.attachmentId);
      if (filter) return filter;
    }
    if (typeof ctx.runId === 'string' && ctx.runId) {
      const filter = this.sessionFilters.get(ctx.runId);
      if (filter) return filter;
    }
    if (typeof ctx.attemptId === 'string' && ctx.attemptId) {
      const filter = this.sessionFilters.get(ctx.attemptId);
      if (filter) return filter;
    }
    return undefined;
  }

  private authorizeAndResolveEffectiveTarget(
    params: Record<string, unknown>,
    context: CapabilityRequestContext,
    authoritativeWs: WorkspaceRecord,
    capabilityName: string
  ): void {
    assertExactBrowserTarget(context.browserTarget, {
      projectId: authoritativeWs.projectId,
      workspaceId: authoritativeWs.id,
      runtimeId: this.options.runtimeId
    }, true);

    if (params && typeof params === 'object' && typeof (params as Record<string, unknown>).tabId === 'string') {
      const reqTabId = ((params as Record<string, unknown>).tabId as string).trim();
      if (!reqTabId) return;

      if (!context.browserTarget?.tabId) {
        throw new CapabilityError('TARGET_MISMATCH', 'Cannot target tab: context has no bound browser target.');
      }

      // Short-circuit exact bound-ID equality: caller explicitly passed the currently bound tabId
      if (reqTabId === context.browserTarget.tabId) {
        return;
      }

      const canonicalTargetId = this.options.resolveTabId ? this.options.resolveTabId(reqTabId) : reqTabId;

      if (!canonicalTargetId || typeof canonicalTargetId !== 'string' || canonicalTargetId.trim().length === 0) {
        throw new CapabilityError('TARGET_MISMATCH', `Unknown browser target: ${reqTabId}`);
      }
      const canonicalId = canonicalTargetId.trim();

      if (canonicalId !== context.browserTarget.tabId) {
        // Owner decision (local single-user app): an agent session may activate any
        // live tab in this window. Switch/activate is the lease-rebinding operation,
        // so the session allowlist does not gate it; the id must still canonicalize
        // and be live (checked below), and every other capability keeps the gate.
        const agentTabSwitch =
          Boolean((context as Partial<AuthenticatedCapabilityContext>).attachmentId) &&
          (capabilityName === 'browser.switch-tab' ||
            capabilityName === 'antifan_switch_tab' ||
            capabilityName === 'anti.browser.tabs.activate');
        if (!agentTabSwitch) {
          const isAllowed = this.options.isTabAllowed
            ? this.options.isTabAllowed(context.browserTarget.tabId, canonicalId) === true
            : false;

          if (!isAllowed) {
            // Check if tab is allowed for terminal session or if canonicalId exists in live tabs
            const isResolvedAllowed = this.options.isTabAllowed
              ? this.options.isTabAllowed(canonicalId, context.browserTarget.tabId) === true
              : false;
            if (!isResolvedAllowed) {
              throw new CapabilityError(
                'TARGET_MISMATCH',
                `Tab ID mismatch: expected ${context.browserTarget.tabId}, got ${reqTabId}. Note: In split review mode, use the bound tabId with paneId: "mobile" to target the mobile pane.`
              );
            }
          }
        }

        const liveDocGen = this.options.getDocumentGeneration
          ? this.options.getDocumentGeneration(canonicalId)
          : context.browserTarget.documentGeneration;
        if (typeof liveDocGen !== 'number' || liveDocGen < 1) {
          throw new CapabilityError('TARGET_STALE', `Cannot target tab '${reqTabId}': live document generation is unavailable.`);
        }

        context.browserTarget = {
          projectId: context.browserTarget.projectId,
          workspaceId: context.browserTarget.workspaceId,
          runtimeId: context.browserTarget.runtimeId,
          tabId: canonicalId,
          browserEpoch: context.browserTarget.browserEpoch,
          documentGeneration: liveDocGen,
        };
      }
    }
  }
}
