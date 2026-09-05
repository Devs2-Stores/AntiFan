import * as crypto from 'node:crypto';
import {
  ClientInvocationIntent,
  MainResolvedAuthority,
  CapabilityExecutionControl,
  CapabilityDispatchRuntimeOptions,
  AuthenticatedCapabilityContext,
  makeControlPlaneId,
  CapabilityError,
  CapabilityRequestContext,
  ExecutionAttachmentRecord,
  CapabilityEffectPolicy,
  CapabilityRisk,
} from '../../shared/control-plane-contracts';
import { CapabilityCatalogue } from './capability-catalogue';
import { AttachmentRegistry } from '../run/attachment-registry';
import { InvocationLedger } from '../session/invocation-ledger';

type EffectMarker = 'not-started' | 'effect-started' | 'effect-committed';
type EffectAcknowledgement = 'no-effect' | 'effect-possible' | 'effect-committed';

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface CapabilityListItem {
  name: string;
  description: string;
  risk: string;
  inputSchema: Record<string, unknown>;
}
export interface CapabilityTransportResponse {
  ok: boolean;
  requestId: string;
  invocationId: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  evidence?: Record<string, unknown>;
  replacementAuthorityRevision?: string;
}

class ExecutionControlImpl implements CapabilityExecutionControl {
  private _effectStage: EffectMarker = 'not-started';
  private _cancellationAck?: EffectAcknowledgement;
  private readonly abortController = new AbortController();
  public readonly cancellationId: string;
  public cancellationSource?: 'owner' | 'subscriber' | 'timeout' | 'system';

  constructor(cancellationId: string) {
    this.cancellationId = cancellationId;
  }

  get effectStage(): EffectMarker {
    return this._effectStage;
  }

  setEffectStage(stage: 'effect-started' | 'effect-committed'): void {
    if (this._effectStage === 'effect-committed') return;
    this._effectStage = stage;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  abort(source: 'owner' | 'subscriber' | 'timeout' | 'system' = 'system'): void {
    this.cancellationSource = source;
    this.abortController.abort();
  }

  acknowledgeCancellation(cancellationId: string, ack: EffectAcknowledgement): boolean {
    if (!this.signal.aborted || !cancellationId || cancellationId !== this.cancellationId) {
      return false;
    }
    if (ack === 'no-effect' && this._effectStage !== 'not-started') {
      return false;
    }
    if (this._cancellationAck === 'effect-committed') {
      return false;
    }
    if (this._cancellationAck === 'effect-possible' && ack === 'no-effect') {
      return false;
    }
    this._cancellationAck = ack;
    return true;
  }

  get cancellationAck(): EffectAcknowledgement | undefined {
    return this._cancellationAck;
  }
}

export class CapabilityTransportAdapter {
  constructor(
    private readonly catalogue: CapabilityCatalogue,
    private readonly attachmentRegistry: AttachmentRegistry,
    private readonly ledger?: InvocationLedger
  ) {}

  list(context?: Pick<CapabilityRequestContext, 'grant'>): CapabilityListItem[] {
    return this.catalogue.list(context);
  }

  async dispatchChildIntent(
    parentInvocationId: string,
    stepId: string,
    attemptIndex: number,
    intent: ClientInvocationIntent,
    invocationSeq?: number | string
  ): Promise<CapabilityTransportResponse> {
    const seqSuffix = invocationSeq !== undefined ? String(invocationSeq) : `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const childIntent: ClientInvocationIntent = {
      ...intent,
      requestId: intent.requestId || makeControlPlaneId('request'),
      idempotencyKey: intent.idempotencyKey || `child:${parentInvocationId}:${stepId}:${attemptIndex}:${seqSuffix}`,
    };
    return this.dispatchIntent(childIntent);
  }

  async dispatchIntent(
    intent: ClientInvocationIntent,
    runtimeOptions?: CapabilityDispatchRuntimeOptions
  ): Promise<CapabilityTransportResponse> {
    if (!intent || typeof intent !== 'object') {
      throw new CapabilityError('INVALID_ARGUMENT', 'Client invocation intent is required');
    }
    if (!intent.requestId || typeof intent.requestId !== 'string' || intent.requestId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent requestId must be a non-empty string');
    }
    if (!intent.idempotencyKey || typeof intent.idempotencyKey !== 'string' || intent.idempotencyKey.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent idempotencyKey must be a non-empty string');
    }
    if (!intent.attachmentId || typeof intent.attachmentId !== 'string' || intent.attachmentId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent attachmentId must be a non-empty string');
    }
    if (!intent.attachmentSecret || typeof intent.attachmentSecret !== 'string' || intent.attachmentSecret.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent attachmentSecret must be a non-empty string');
    }
    if (!intent.authorityRevision || typeof intent.authorityRevision !== 'string' || intent.authorityRevision.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent authorityRevision must be a non-empty string');
    }
    if (!intent.name || typeof intent.name !== 'string' || intent.name.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Intent capability name must be a non-empty string');
    }

    // Step 1: Authenticate lineage
    let authResult: { record: ExecutionAttachmentRecord; authority: MainResolvedAuthority };
    try {
      authResult = this.attachmentRegistry.authenticateLineage(
        intent.attachmentId,
        intent.attachmentSecret,
        { authorityRevision: intent.authorityRevision }
      );
    } catch (err) {
      const typed = err as { code?: string; message?: string; details?: unknown };
      return {
        ok: false,
        requestId: intent.requestId,
        invocationId: makeControlPlaneId('invocation'),
        error: {
          code: typed.code || 'AUTHENTICATION_DENIED',
          message: typed.message || String(err),
          details: typed.details,
        },
      };
    }
    const { record, authority } = authResult;

    // Step 2: Lookup capability definition and policy
    const definition = this.catalogue.get(intent.name);
    if (!definition) {
      return {
        ok: false,
        requestId: intent.requestId,
        invocationId: makeControlPlaneId('invocation'),
        error: {
          code: 'CAPABILITY_NOT_FOUND',
          message: `Capability '${intent.name}' not found in catalogue`,
        },
      };
    }
    const policy = definition.policy;
    const policyDigest = policy?.policyDigest || 'unversioned';
    const policyVersion = policy?.policyVersion || 1;
    const recordedVisibility = policy?.recordedVisibility || 'public';

    // Step 3: Disclose / Authorize
    let invocationId = makeControlPlaneId('invocation');
    let isOwner = true;

    if (!this.ledger) {
      // In standalone / ledger-less transport mode, replay denial is checked via attachment nonces
      if (intent.idempotencyKey) {
        let nonces = this.attachmentRegistry['invocationNonces']?.get(record.id);
        if (nonces && nonces.has(intent.idempotencyKey)) {
          return {
            ok: false,
            requestId: intent.requestId,
            invocationId,
            error: {
              code: 'REPLAY_DENIED',
              message: `Duplicate invocation detected: ${intent.idempotencyKey}`,
            },
          };
        }
      }
    }
    if (this.ledger) {
      try {
        const existing = await this.ledger.observe(intent, authority);
        if (existing) {
          const rec = existing.record;
          if (rec && policyDigest !== 'unversioned' && rec.policyDigest !== 'unversioned' && rec.policyDigest !== policyDigest) {
            throw new CapabilityError('BINDING_COLLISION', 'Recorded policy digest mismatch with current capability policy');
          }

          const canRead = this.attachmentRegistry.canReadReceipt(authority.grant, policy?.receiptReadPermission, rec?.recordedVisibility);
          if (existing.kind === 'replay' && rec) {
            if (!canRead) {
              if (rec.recordedVisibility === 'redacted') {
                throw new CapabilityError('POLICY_DENIED', 'Receipt visibility is redacted');
              }
              return {
                ok: rec.state === 'completed',
                requestId: intent.requestId,
                invocationId: rec.id,
                data: { state: rec.state, redacted: true },
                evidence: rec.evidence,
                replacementAuthorityRevision: rec.replacementAuthorityRevision,
              };
            }
            return {
              ok: rec.state === 'completed',
              requestId: intent.requestId,
              invocationId: rec.id,
              data: rec.result,
              error: rec.error,
              evidence: rec.evidence,
              replacementAuthorityRevision: rec.replacementAuthorityRevision,
            };
          }
          if (existing.kind === 'join' && existing.promise) {
            const joinedRec = await existing.promise;
            if (!this.attachmentRegistry.canReadReceipt(authority.grant, policy?.receiptReadPermission, joinedRec.recordedVisibility)) {
              return {
                ok: joinedRec.state === 'completed',
                requestId: intent.requestId,
                invocationId: joinedRec.id,
                data: { state: joinedRec.state, redacted: true },
                evidence: joinedRec.evidence,
                replacementAuthorityRevision: joinedRec.replacementAuthorityRevision,
              };
            }
            return {
              ok: joinedRec.state === 'completed',
              requestId: intent.requestId,
              invocationId: joinedRec.id,
              data: joinedRec.result,
              error: joinedRec.error,
              evidence: joinedRec.evidence,
              replacementAuthorityRevision: joinedRec.replacementAuthorityRevision,
            };
          }
        }
      } catch (err) {
        const typed = err as { code?: string; message?: string; details?: unknown };
        return {
          ok: false,
          requestId: intent.requestId,
          invocationId,
          error: {
            code: typed.code || 'LEDGER_CLAIM_FAILED',
            message: typed.message || String(err),
            details: typed.details,
          },
        };
      }
    }

    // Validate live execution authority for new OWNER
    let liveAuthority: MainResolvedAuthority;
    try {
      liveAuthority = this.attachmentRegistry.validateLiveExecution(record, intent.authorityRevision, intent.idempotencyKey);
    } catch (err) {
      const typed = err as { code?: string; message?: string; details?: unknown };
      return {
        ok: false,
        requestId: intent.requestId,
        invocationId,
        error: {
          code: typed.code || 'UNAUTHENTICATED',
          message: typed.message || String(err),
          details: typed.details,
        },
      };
    }

    // Step 4: Claim pre_dispatch in ledger
    if (this.ledger) {
      try {
        const claim = await this.ledger.claimOwner(
          intent,
          liveAuthority,
          policyDigest,
          policyVersion,
          recordedVisibility
        );
        if (claim.kind === 'replay' && claim.record) {
          const rec = claim.record;
          const canRead = this.attachmentRegistry.canReadReceipt(authority.grant, policy?.receiptReadPermission, rec.recordedVisibility);
          if (!canRead) {
            return {
              ok: rec.state === 'completed',
              requestId: intent.requestId,
              invocationId: rec.id,
              data: { state: rec.state, redacted: true },
              evidence: rec.evidence,
              replacementAuthorityRevision: rec.replacementAuthorityRevision,
            };
          }
          return {
            ok: rec.state === 'completed',
            requestId: intent.requestId,
            invocationId: rec.id,
            data: rec.result,
            error: rec.error,
            evidence: rec.evidence,
            replacementAuthorityRevision: rec.replacementAuthorityRevision,
          };
        }
        if (claim.kind === 'join' && claim.promise) {
          const rec = await claim.promise;
          const canRead = this.attachmentRegistry.canReadReceipt(authority.grant, policy?.receiptReadPermission, rec.recordedVisibility);
          if (!canRead) {
            return {
              ok: rec.state === 'completed',
              requestId: intent.requestId,
              invocationId: rec.id,
              data: { state: rec.state, redacted: true },
              evidence: rec.evidence,
              replacementAuthorityRevision: rec.replacementAuthorityRevision,
            };
          }
          return {
            ok: rec.state === 'completed',
            requestId: intent.requestId,
            invocationId: rec.id,
            data: rec.result,
            error: rec.error,
            evidence: rec.evidence,
            replacementAuthorityRevision: rec.replacementAuthorityRevision,
          };
        }
        invocationId = claim.invocationId;
        isOwner = true;
      } catch (err) {
        const typed = err as { code?: string; message?: string; details?: unknown };
        return {
          ok: false,
          requestId: intent.requestId,
          invocationId,
          error: {
            code: typed.code || 'LEDGER_CLAIM_FAILED',
            message: typed.message || String(err),
            details: typed.details,
          },
        };
      }
    }
    // Pre-dispatch cancellation check: if caller already aborted before dispatch_started,
    // settle immediately as clean 'interrupted' without executing side effects or advancing to dispatch_started.
    if (runtimeOptions?.signal?.aborted) {
      const preDispatchErr = {
        code: 'ABORTED',
        message: 'Execution was aborted before dispatch started',
      };
      if (this.ledger && isOwner) {
        try {
          await this.ledger.settle(invocationId, 'interrupted', undefined, preDispatchErr);
        } catch {}
      }
      return {
        ok: false,
        requestId: intent.requestId,
        invocationId,
        error: preDispatchErr,
      };
    }

    // Step 5: Durably advance stage to dispatch_started
    if (this.ledger && isOwner) {
      try {
        await this.ledger.advanceStage(invocationId, 'dispatch_started');
      } catch (err) {
        const typed = err as { code?: string; message?: string; details?: unknown };
        return {
          ok: false,
          requestId: intent.requestId,
          invocationId,
          error: {
            code: typed.code || 'DURABILITY_FAILED',
            message: typed.message || String(err),
            details: typed.details,
          },
        };
      }
    }

    // Step 6: Execute capability
    const execControl = new ExecutionControlImpl(invocationId);
    let abortListenerCleanup: (() => void) | undefined;
    if (runtimeOptions?.signal) {
      if (runtimeOptions.signal.aborted) {
        execControl.abort('owner');
      } else {
        const onAbort = () => execControl.abort('owner');
        runtimeOptions.signal.addEventListener('abort', onAbort, { once: true });
        abortListenerCleanup = () => {
          runtimeOptions.signal?.removeEventListener('abort', onAbort);
        };
      }
    }

    let childSeq = 0;
    const dispatchChildIntent = async (stepId: string, attempt: number, childIntent: ClientInvocationIntent) => {
      childSeq++;
      const deterministicKey = `child:${invocationId}:${stepId}:${attempt}:${childSeq}`;
      const childWithLineage: ClientInvocationIntent = {
        ...childIntent,
        requestId: `${intent.requestId}:child:${childSeq}`,
        idempotencyKey: deterministicKey,
        attachmentId: liveAuthority.attachmentId,
        attachmentSecret: intent.attachmentSecret,
        authorityRevision: liveAuthority.authorityRevision,
      };
      return await this.dispatchIntent(childWithLineage, runtimeOptions);
    };

    try {
      const authContext: AuthenticatedCapabilityContext = {
        attachmentId: liveAuthority.attachmentId,
        runId: liveAuthority.runId,
        attemptId: liveAuthority.attemptId,
        projectId: liveAuthority.projectId,
        workspaceId: liveAuthority.workspaceId || '',
        chatId: record.chatId,
        backendId: liveAuthority.backendId,
        hostEpoch: liveAuthority.hostEpoch,
        invocationId,
        browserTarget: liveAuthority.browserTarget,
        grant: liveAuthority.grant,
        lease: record.lease!,
        leaseToken: liveAuthority.runtimeLeaseToken || '',
        signal: execControl.signal,
        control: execControl,
        progressSink: runtimeOptions?.progressSink,
        authorityRevision: liveAuthority.authorityRevision,
        dispatchChildIntent,
      };
      if (execControl.signal.aborted) {
        const err = new Error('Execution was aborted before handler dispatch');
        (err as unknown as { code: string; name: string }).code = 'ABORTED';
        (err as unknown as { code: string; name: string }).name = 'AbortError';
        throw err;
      }
      const data = await this.catalogue.dispatchAuthenticated(
        intent.name,
        (intent.params as Record<string, unknown>) || {},
        authContext
      );
      let replacementAuthorityRevision: string | undefined;
      const p = intent.params as Record<string, unknown> | undefined;
      const isSetTarget = intent.name === 'browser.set-automation-target' || intent.name === 'antifan_set_automation_target';
      const isOpenTab = intent.name === 'browser.open-tab' || intent.name === 'antifan_open_tab' || intent.name === 'anti.browser.tabs.create';
      const isSwitchTab = intent.name === 'browser.switch-tab' || intent.name === 'antifan_switch_tab' || intent.name === 'anti.browser.tabs.activate';
      const isNavigate = intent.name === 'browser.navigate' || intent.name === 'antifan_navigate' || intent.name === 'anti.browser.navigate';
      const isReload = intent.name === 'browser.reload' || intent.name === 'antifan_reload' || intent.name === 'anti.browser.reload';
      const isCloseTab = intent.name === 'browser.close-tab' || intent.name === 'antifan_close_tab' || intent.name === 'anti.browser.tabs.close';
      if (isSetTarget || isOpenTab) {
        let newTabId: string | undefined;
        if (data && typeof data === 'object' && 'tabId' in data && typeof (data as { tabId: unknown }).tabId === 'string') {
          const candidate = (data as { tabId: string }).tabId.trim();
          if (candidate.length > 0) {
            newTabId = candidate;
          }
        }
        if (newTabId) {
          const newRev = await this.attachmentRegistry.updateAttachmentTab(authority.attachmentId, newTabId);
          if (newRev) replacementAuthorityRevision = newRev;
        }
      } else if (isSwitchTab) {
        if (data && typeof data === 'object') {
          const resObj = data as { switched?: unknown; tabId?: unknown };
          if (
            resObj.switched === true &&
            typeof resObj.tabId === 'string' &&
            CANONICAL_UUID_PATTERN.test(resObj.tabId.trim())
          ) {
            const newRev = await this.attachmentRegistry.updateAttachmentTab(authority.attachmentId, resObj.tabId.trim());
            if (newRev) replacementAuthorityRevision = newRev;
          }
        }
      } else if (isNavigate || isReload) {
        if (data && typeof data === 'object' && 'target' in data) {
          const targetObj = (data as { target?: { tabId?: string; documentGeneration?: number } }).target;
          if (targetObj && typeof targetObj.tabId === 'string') {
            const newRev = await this.attachmentRegistry.updateAttachmentTab(
              authority.attachmentId,
              targetObj.tabId,
              targetObj.documentGeneration
            );
            if (newRev) replacementAuthorityRevision = newRev;
          }
        }
      } else if (isCloseTab) {
        if (data && typeof data === 'object') {
          const resObj = data as { closed?: unknown; tabId?: unknown; failoverTabId?: unknown };
          const closedCanonicalId = typeof resObj.tabId === 'string' && resObj.tabId.trim().length > 0
            ? resObj.tabId.trim()
            : undefined;
          const boundTabId = authority.browserTarget?.tabId;
          const isBoundTabClosed = Boolean(closedCanonicalId && boundTabId && closedCanonicalId === boundTabId);
          const failoverCandidate = typeof resObj.failoverTabId === 'string' ? resObj.failoverTabId.trim() : '';
          if (
            resObj.closed === true &&
            isBoundTabClosed &&
            failoverCandidate.length > 0 &&
            !failoverCandidate.startsWith('#') &&
            !failoverCandidate.startsWith('@') &&
            failoverCandidate !== closedCanonicalId
          ) {
            const newRev = await this.attachmentRegistry.updateAttachmentTab(authority.attachmentId, failoverCandidate);
            if (newRev) replacementAuthorityRevision = newRev;
          }
        }
      }
      // Check if cancellation arrived during execution under abort-immediate
      if (execControl.signal.aborted && policy?.ownerCancellationBehavior !== 'drain-and-persist') {
        const isInterrupted = execControl.cancellationAck === 'no-effect' && execControl.effectStage === 'not-started';
        const errObj = {
          code: 'ABORTED',
          message: isInterrupted
            ? 'Execution was aborted before effects were committed'
            : 'Execution was aborted with indeterminate effect state',
        };
        if (this.ledger && isOwner) {
          try {
            await this.ledger.settle(invocationId, isInterrupted ? 'interrupted' : 'unknown', undefined, errObj);
          } catch {}
        }
        return {
          ok: false,
          requestId: intent.requestId,
          invocationId,
          error: errObj,
        };
      }

      // Step 7: Persist terminal receipt (completed)
      if (this.ledger && isOwner) {
        await this.ledger.settle(
          invocationId,
          'completed',
          data,
          undefined,
          undefined,
          undefined,
          replacementAuthorityRevision
        );
      }

      // Step 8: Respond
      return {
        ok: true,
        requestId: intent.requestId,
        invocationId,
        data,
        ...(replacementAuthorityRevision ? { replacementAuthorityRevision } : {}),
      };
    } catch (error: unknown) {
      // Step 7: Persist terminal receipt (classified error)
      const classified = this.classifySettlement(error, policy, execControl);

      const errObj = {
        code: classified.code,
        message: classified.message,
        details: classified.details,
      };

      if (this.ledger && isOwner) {
        try {
          await this.ledger.settle(invocationId, classified.state, undefined, errObj);
        } catch {}
      }

      // Step 8: Respond
      return {
        ok: false,
        requestId: intent.requestId,
        invocationId,
        error: errObj,
      };
    } finally {
      abortListenerCleanup?.();
    }
  }

  private classifySettlement(
    err: unknown,
    policy: CapabilityEffectPolicy | undefined,
    control: ExecutionControlImpl
  ): { state: 'failed' | 'interrupted' | 'unknown'; code: string; message: string; details?: unknown } {
    const typed = err as { code?: string; message?: string; name?: string; details?: unknown };
    const isTransportAbort = control.signal.aborted;
    const isAbort =
      isTransportAbort ||
      typed?.name === 'AbortError' ||
      (err instanceof Error && err.name === 'AbortError') ||
      typed?.code === 'ABORTED' ||
      typed?.code === 'CANCELLED';

    if (isAbort || typed?.code === 'PROCESS_INTERRUPTED') {
      const ack = control.cancellationAck;
      const effectStage = control.effectStage;
      if (ack === 'no-effect' || (isTransportAbort && effectStage === 'not-started') || (policy?.effect === 'read' && effectStage === 'not-started')) {
        return {
          state: 'interrupted',
          code: typed?.code || 'ABORTED',
          message: typed?.message || 'Execution was aborted before effects were committed',
          details: typed?.details,
        };
      }
      if (!isTransportAbort && effectStage === 'not-started') {
        return {
          state: 'failed',
          code: typed?.code || 'ABORTED',
          message: typed?.message || 'Execution failed with unrequested internal abort',
          details: typed?.details,
        };
      }
      return {
        state: 'unknown',
        code: typed?.code || 'ABORTED',
        message: 'Execution was aborted with indeterminate effect state',
        details: typed?.details ?? (typed?.message ? { cause: typed.message } : undefined),
      };
    }

    if (typed?.code === 'TIMEOUT' || typed?.code === 'EXECUTION_TIMEOUT') {
      if (control.effectStage === 'effect-started' || control.effectStage === 'effect-committed') {
        return {
          state: 'unknown',
          code: typed?.code || 'TIMEOUT',
          message: typed?.message || 'Execution timed out with indeterminate effect state',
          details: typed?.details,
        };
      }
      return {
        state: 'failed',
        code: typed?.code || 'TIMEOUT',
        message: typed?.message || 'Execution timed out',
        details: typed?.details,
      };
    }

    if (typed?.code === 'EXECUTION_UNKNOWN') {
      return {
        state: 'unknown',
        code: 'EXECUTION_UNKNOWN',
        message: typed?.message || 'Execution ended in unknown state',
        details: typed?.details,
      };
    }

    return {
      state: 'failed',
      code: typed?.code || 'CAPABILITY_ERROR',
      message: typed?.message || (err instanceof Error ? err.message : String(err)),
      details: typed?.details,
    };
  }

  private canReadReceipt(
    grant?: string,
    requiredPermission?: string,
    recordedVisibility?: string
  ): boolean {
    return this.attachmentRegistry.canReadReceipt(
      grant as CapabilityRisk | undefined,
      requiredPermission as CapabilityRisk | undefined,
      recordedVisibility
    );
  }
}
