import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { inspect } from 'node:util';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
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
  ChildDispatchSpec,
  InvocationState,
} from '../../shared/control-plane-contracts';
import { CapabilityCatalogue } from './capability-catalogue';
import { AttachmentRegistry } from '../run/attachment-registry';
import { InvocationLedger } from '../session/invocation-ledger';
import { safeErrorText } from './browser-capabilities';

/**
 * Renders a thrown value into a human-readable relay message. Order:
 *   1. a string `.message` carried by the thrown value (typed errors, including
 *      plain-object throws that still name their failure);
 *   2. `Error.message` verbatim — an interpreter error raised by the agent's own
 *      expression must reach the caller unmodified;
 *   3. `String(err)` for primitives and objects with a meaningful toString;
 *   4. `util.inspect` when the string form is the content-free '[object Object]',
 *      so a plain-object throw still relays its shape instead of nothing.
 */
function relayErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = err.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  if (err instanceof Error) return typeof err.message === 'string' && err.message ? err.message : err.name;
  const text = safeErrorText(err);
  if (text === '[object Object]' || text === 'UNKNOWN_ERROR') {
    try {
      return inspect(err, { depth: 3, breakLength: 200 });
    } catch {
      return text;
    }
  }
  return text;
}

type EffectMarker = 'not-started' | 'effect-started' | 'effect-committed';
type EffectAcknowledgement = 'no-effect' | 'effect-possible' | 'effect-committed';

const CANONICAL_TAB_PATTERN = /^(tab-[a-zA-Z0-9_\-]+|[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)$/i;
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
  /** Terminal ledger state when known: 'completed' on success, classified state on failure, 'in_progress' for pending-cleanup. Lets callers (workflow retry gate) distinguish failed-clean from unknown/in-flight. */
  state?: InvocationState;
}

class ExecutionControlImpl implements CapabilityExecutionControl {
  private _effectStage: EffectMarker = 'not-started';
  private _cancellationAck?: EffectAcknowledgement;
  private readonly abortController = new AbortController();
  public readonly cancellationId: string;
  public cancellationSource?: 'owner' | 'subscriber' | 'timeout' | 'system';
  /**
   * Continuation token for this invocation. A pending-cleanup deadline
   * invalidates it so a late (stale) continuation cannot dispatch new child
   * work while owned resources are still held.
   */
  public continuationValid = true;

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
    this.abortController.abort(source);
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

/**
 * Optional trait on a capability definition to explicitly declare whether
 * dispatch requires fresh-inspection document generation tracking.
 */
export interface FreshInspectionTrait {
  freshInspection?: boolean;
}

/**
 * Canonical capabilities and aliases that perform fresh inspection of the DOM,
 * accessibility snapshot, or element search tree on the attached browser target.
 *
 * Invariant:
 * - Policy effect: 'read'
 * - Risk: non-eval (risk !== 'eval')
 * - Surface: DOM / snapshot / find surface on the browser target
 *
 * Calls matching this invariant capture the document generation before and after
 * execution. If generation is stable (pre === post) and strictly advances the
 * recorded attachment generation, attachment authority safely acknowledges the drift.
 */
export const FRESH_INSPECTION_CAPABILITIES: ReadonlySet<string> = new Set([
  // Canonical DOM inspection
  'browser.dom',
  'anti.inspect.dom',
  'antifan_get_dom',
  // Accessibility snapshot inspection
  'anti.inspect.snapshot',
  'browser.snapshot',
  'anti.browser.snapshot',
  'browser.agent-snapshot',
  'antifan_agent_snapshot',
  // Element search in snapshot / DOM
  'browser.find',
  'anti.inspect.find',
  'antifan_find',
]);

/**
 * Pattern matching inspection capability names that operate on the DOM,
 * accessibility snapshot, or element search surfaces.
 */
export const FRESH_INSPECTION_NAME_PATTERN = /^(?:browser\.(?:dom|snapshot|agent-snapshot|find)|anti\.inspect\..+|antifan_(?:get_dom|agent_snapshot|find)|anti\.browser\.snapshot)(?:[._-].*)?$/;

/**
 * Determines whether a capability dispatch should be treated as a fresh inspection.
 *
 * Decision precedence:
 * 1. Policy check: must have effect 'read' and risk other than 'eval' (fail-closed).
 * 2. Explicit definition opt-in / opt-out (`freshInspection?: boolean`).
 * 3. Exact match against canonical/alias set `FRESH_INSPECTION_CAPABILITIES`.
 * 4. Structural match against `FRESH_INSPECTION_NAME_PATTERN`.
 */
export function isFreshInspectionCapability(
  name: string,
  policy?: CapabilityEffectPolicy,
  definition?: FreshInspectionTrait
): boolean {
  if (policy?.effect !== 'read' || policy.risk === 'eval') return false;

  if (definition && typeof definition.freshInspection === 'boolean') {
    return definition.freshInspection;
  }

  return FRESH_INSPECTION_CAPABILITIES.has(name) || FRESH_INSPECTION_NAME_PATTERN.test(name);
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


  async dispatchIntent(
    intent: ClientInvocationIntent,
    runtimeOptions?: CapabilityDispatchRuntimeOptions
  ): Promise<CapabilityTransportResponse> {
    const benchEnabled = isBenchmarkEnabled();
    const benchStart = benchEnabled ? performance.now() : 0;
    const result = await this._dispatchIntentImpl(intent, runtimeOptions);
    if (benchEnabled) {
      recordBenchmark({
        surface: 'capability',
        name: 'dispatch',
        value: performance.now() - benchStart,
        extra: { capability: intent.name, ok: result.ok },
      });
    }
    return result;
  }

  private async _dispatchIntentImpl(
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
          code: typeof typed.code === 'string' && typed.code ? typed.code : 'AUTHENTICATION_DENIED',
          message: relayErrorMessage(err),
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
                state: rec.state,
                evidence: rec.evidence,
                replacementAuthorityRevision: rec.replacementAuthorityRevision,
              };
            }
            return {
              ok: rec.state === 'completed',
              requestId: intent.requestId,
              invocationId: rec.id,
              data: rec.result,
              state: rec.state,
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
                state: joinedRec.state,
                evidence: joinedRec.evidence,
                replacementAuthorityRevision: joinedRec.replacementAuthorityRevision,
              };
            }
            return {
              ok: joinedRec.state === 'completed',
              requestId: intent.requestId,
              invocationId: joinedRec.id,
              data: joinedRec.result,
              state: joinedRec.state,
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
            code: typeof typed.code === 'string' && typed.code ? typed.code : 'LEDGER_CLAIM_FAILED',
            message: relayErrorMessage(err),
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
          code: typeof typed.code === 'string' && typed.code ? typed.code : 'UNAUTHENTICATED',
          message: relayErrorMessage(err),
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
              state: rec.state,
              evidence: rec.evidence,
              replacementAuthorityRevision: rec.replacementAuthorityRevision,
            };
          }
          return {
            ok: rec.state === 'completed',
            requestId: intent.requestId,
            invocationId: rec.id,
            data: rec.result,
              state: rec.state,
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
              state: rec.state,
              evidence: rec.evidence,
              replacementAuthorityRevision: rec.replacementAuthorityRevision,
            };
          }
          return {
            ok: rec.state === 'completed',
            requestId: intent.requestId,
            invocationId: rec.id,
            data: rec.result,
              state: rec.state,
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
            code: typeof typed.code === 'string' && typed.code ? typed.code : 'LEDGER_CLAIM_FAILED',
            message: relayErrorMessage(err),
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
        state: 'interrupted',
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
            code: typeof typed.code === 'string' && typed.code ? typed.code : 'DURABILITY_FAILED',
            message: relayErrorMessage(err),
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
    const dispatchChildIntent = async (spec: ChildDispatchSpec) => {
      // Admission gate: reject when the parent is dead (deadline fired or caller
      // aborted) — not only when the continuation token was invalidated by
      // pending-cleanup. A dead parent must never mint new child work.
      if (execControl.signal.aborted) {
        throw new CapabilityError(
          'TRANSACTION_CONFLICT',
          `Parent invocation ${invocationId} was aborted (${execControl.cancellationSource ?? 'system'}); refusing to dispatch child for step '${spec.stepId}'`
        );
      }
      if (!execControl.continuationValid) {
        throw new CapabilityError(
          'TRANSACTION_CONFLICT',
          `Continuation token for invocation ${invocationId} is invalidated: the invocation exceeded its execution budget and is pending cleanup`
        );
      }
      childSeq++;
      const deterministicKey = `child:${invocationId}:${spec.stepId}:${spec.attempt}:${childSeq}`;
      const childWithLineage: ClientInvocationIntent = {
        ...spec.intent,
        requestId: `${intent.requestId}:child:${childSeq}`,
        idempotencyKey: deterministicKey,
        attachmentId: liveAuthority.attachmentId,
        attachmentSecret: intent.attachmentSecret,
        authorityRevision: liveAuthority.authorityRevision,
      };
      // Execution lineage: the child aborts when the caller aborts, when the
      // parent invocation's own deadline/control fires, or when the step-scoped
      // signal (step timeout) fires — whichever comes first.
      const childSignals = [runtimeOptions?.signal, execControl.signal, spec.signal].filter(
        (s): s is AbortSignal => s !== undefined
      );
      const childRuntimeOptions: CapabilityDispatchRuntimeOptions = {
        ...runtimeOptions,
        signal: childSignals.length > 1 ? AbortSignal.any(childSignals) : childSignals[0],
      };
      return await this.dispatchIntent(childWithLineage, childRuntimeOptions);
    };

    // Budget partition: policy.timeoutMs is one total response budget. The
    // execution deadline fires first and aborts the handler with source
    // 'timeout'; the reserved cancellationAckTimeoutMs grace is spent awaiting
    // the handler's own cleanup (lock/pool/tab/DOM release) before any terminal
    // receipt is written.
    const executionBudgetMs = Math.max(1, Math.trunc(policy?.timeoutMs ?? 30_000));
    const cancellationAckMs = Math.min(executionBudgetMs, Math.max(0, Math.trunc(policy?.cancellationAckTimeoutMs ?? 0)));
    const executionDeadlineMs = Math.max(0, executionBudgetMs - cancellationAckMs);
    let executionTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const clearBudgetTimers = () => {
      if (executionTimer) {
        clearTimeout(executionTimer);
        executionTimer = undefined;
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };
    if (executionDeadlineMs <= 0) {
      execControl.abort('timeout');
    } else {
      executionTimer = setTimeout(() => {
        execControl.abort('timeout');
      }, executionDeadlineMs);
    }

    const handlerPromise = (async (): Promise<CapabilityTransportResponse> => {
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
      // Local solo-dev self-heal: the attachment's bound tab can disappear — the user
      // closes it, or the session closes the tab it was working in. Rebind to a tab the
      // same session still owns so one closed tab does not strand every later call as
      // stale. Only a live replacement named by the host for this exact tab is accepted,
      // and the attachment is rotated below so the rebind is durable, not per-call.
      let healedBoundTabId: string | undefined;
      const isOpenTab = intent.name === 'browser.open-tab' || intent.name === 'antifan_open_tab' || intent.name === 'anti.browser.tabs.create';
      const staleBoundTabId = authContext.browserTarget?.tabId;
      if (staleBoundTabId && !this.catalogue.resolveTabId(staleBoundTabId)) {
        const replacement = this.catalogue.resolveFailoverTabId(staleBoundTabId);
        const liveDocGen = replacement ? this.catalogue.getDocumentGeneration(replacement) : undefined;
        if (
          replacement &&
          replacement !== staleBoundTabId &&
          this.catalogue.resolveTabId(replacement) &&
          typeof liveDocGen === 'number' &&
          liveDocGen > 0 &&
          authContext.browserTarget
        ) {
          authContext.browserTarget = {
            projectId: authContext.browserTarget.projectId,
            workspaceId: authContext.browserTarget.workspaceId,
            runtimeId: authContext.browserTarget.runtimeId,
            tabId: replacement,
            browserEpoch: authContext.browserTarget.browserEpoch,
            documentGeneration: liveDocGen,
          };
          healedBoundTabId = replacement;
        } else if (isOpenTab) {
          // Opening a tab is the one recovery that needs no live anchor: the tab it
          // returns becomes this session's target, and the dispatch result is rotated
          // onto the attachment below. Handing the dead id to the port would make it
          // refuse — that refusal is for a caller asking for a tab bound to the dead
          // one, not for the recovery from it (measured: a session whose tab the user
          // closed could not open a tab again, so `anti.browser.tabs.create` returned
          // success:false and the session stayed stranded).
          authContext.browserTarget = undefined;
        } else {
          // Bound tab is gone and the host named no replacement: capabilities that
          // require a browser target will fail on the dead tab, but management
          // tools (tabs.list, rebind-target) must still reach the host so the
          // agent can pick a live tab and rebind explicitly.
          console.warn(`[capability-transport] attachment ${authority.attachmentId} bound tab '${staleBoundTabId}' is gone and no failover target exists; dispatching '${intent.name}' against the stale target`);
        }
      }
      const attachedTabIdForInspection = authContext.browserTarget?.tabId || record.tabId;
      const isInspection = this.isFreshInspection(intent.name, policy);
      const preInspectionDocGen = isInspection && attachedTabIdForInspection
        ? (this.attachmentRegistry.getDocumentGeneration?.(attachedTabIdForInspection) ??
           this.catalogue.getDocumentGeneration?.(attachedTabIdForInspection))
        : undefined;
      const data = await this.catalogue.dispatchAuthenticated(
        intent.name,
        (intent.params as Record<string, unknown>) || {},
        authContext
      );
      const postInspectionDocGen = isInspection && attachedTabIdForInspection
        ? (this.attachmentRegistry.getDocumentGeneration?.(attachedTabIdForInspection) ??
           this.catalogue.getDocumentGeneration?.(attachedTabIdForInspection))
        : undefined;
      let replacementAuthorityRevision: string | undefined;
      if (healedBoundTabId) {
        const healedRev = await this.attachmentRegistry.updateAttachmentTab(authority.attachmentId, healedBoundTabId);
        if (healedRev) replacementAuthorityRevision = healedRev;
      }
      const p = intent.params as Record<string, unknown> | undefined;
      const isSetTarget = intent.name === 'browser.set-automation-target' || intent.name === 'antifan_set_automation_target';
      const isSwitchTab = intent.name === 'browser.switch-tab' || intent.name === 'antifan_switch_tab' || intent.name === 'anti.browser.tabs.activate';
      const isNavigate = intent.name === 'browser.navigate' || intent.name === 'antifan_navigate' || intent.name === 'anti.browser.navigate';
      const isReload = intent.name === 'browser.reload' || intent.name === 'antifan_reload' || intent.name === 'anti.browser.reload';
      const isCloseTab = intent.name === 'browser.close-tab' || intent.name === 'antifan_close_tab' || intent.name === 'anti.browser.tabs.close';
      const isRebind = intent.name === 'browser.rebind-target' || intent.name === 'antifan_rebind_target' || intent.name === 'anti.browser.rebind_target';
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
          if (newRev) {
            replacementAuthorityRevision = newRev;
          } else if (isOpenTab) {
            throw new CapabilityError(
              'TARGET_TRANSITION_UNCOMMITTED',
              `Tab '${newTabId}' was created but attachment authority failed to rotate (CAS conflict or missing record). Call browser.rebind-target with tabId '${newTabId}' to recover authority.`,
              {
                mutationCommitted: true,
                intendedTabId: newTabId,
                attachmentId: authority.attachmentId,
                recoveryAction: 'browser.rebind-target',
              }
            );
          } else {
            // The tool reported a new target but authority did not rotate: reporting
            // success would leave the session bound to the old tab while the client
            // believes it moved — fail loud so the caller can rebind explicitly.
            throw new CapabilityError(
              'ATTACHMENT_REBIND_FAILED',
              `Target changed to '${newTabId}' but attachment authority failed to rotate (CAS conflict or missing record). Retry or call browser.rebind-target.`,
              {
                mutationCommitted: false,
                intendedTabId: newTabId,
                attachmentId: authority.attachmentId,
                recoveryAction: 'browser.rebind-target',
              }
            );
          }
        }
      } else if (isSwitchTab) {
        if (data && typeof data === 'object') {
          const resObj = data as { switched?: unknown; tabId?: unknown };
          if (resObj.switched === true) {
            const switchTarget = typeof resObj.tabId === 'string' && CANONICAL_TAB_PATTERN.test(resObj.tabId.trim())
              ? resObj.tabId.trim()
              : undefined;
            if (!switchTarget) {
              throw new CapabilityError(
                'ATTACHMENT_REBIND_FAILED',
                'Tab switched but the response carried no canonical tabId; attachment binding was not rotated. Call browser.rebind-target with the target tabId.',
                {
                  mutationCommitted: false,
                  attachmentId: authority.attachmentId,
                  recoveryAction: 'browser.rebind-target',
                }
              );
            }
            const newRev = await this.attachmentRegistry.updateAttachmentTab(authority.attachmentId, switchTarget);
            if (newRev) {
              replacementAuthorityRevision = newRev;
            } else {
              throw new CapabilityError(
                'ATTACHMENT_REBIND_FAILED',
                `Tab switched to '${switchTarget}' but attachment authority failed to rotate (CAS conflict or missing record). Call browser.rebind-target to retry.`,
                {
                  mutationCommitted: false,
                  intendedTabId: switchTarget,
                  attachmentId: authority.attachmentId,
                  recoveryAction: 'browser.rebind-target',
                }
              );
            }
          }
        }
      } else if (isNavigate || isReload) {
        let targetTabId: string | undefined;
        let targetDocGen: number | undefined;
        if (data && typeof data === 'object') {
          if ('target' in data) {
            const targetObj = (data as { target?: { tabId?: string; documentGeneration?: number } }).target;
            targetTabId = targetObj?.tabId;
            targetDocGen = targetObj?.documentGeneration;
          } else if ('tabId' in data && typeof (data as Record<string, unknown>).tabId === 'string') {
            const record = data as Record<string, unknown>;
            targetTabId = record.tabId as string;
            targetDocGen = typeof record.documentGeneration === 'number'
              ? record.documentGeneration
              : undefined;
          }
        }
        if (targetTabId) {
          const newRev = await this.attachmentRegistry.updateAttachmentTab(
            authority.attachmentId,
            targetTabId,
            targetDocGen
          );
          if (newRev) {
            replacementAuthorityRevision = newRev;
          } else {
            // navigate/reload moved the live target but authority did not rotate:
            // the underlying mutation committed, but authority transition was uncommitted.
            throw new CapabilityError(
              'TARGET_TRANSITION_UNCOMMITTED',
              `${intent.name} committed mutation at '${targetTabId}' but attachment authority failed to rotate (CAS conflict or missing record). Call browser.rebind-target with tabId '${targetTabId}' to recover authority.`,
              {
                mutationCommitted: true,
                intendedTabId: targetTabId,
                attachmentId: authority.attachmentId,
                documentGeneration: targetDocGen,
                recoveryAction: 'browser.rebind-target',
              }
            );
          }
        }
      } else if (isRebind) {
        let targetTabId: string | undefined;
        let targetDocGen: number | undefined;
        if (data && typeof data === 'object') {
          if ('target' in data) {
            const targetObj = (data as { target?: { tabId?: string; documentGeneration?: number } }).target;
            targetTabId = targetObj?.tabId;
            targetDocGen = targetObj?.documentGeneration;
          } else if ('tabId' in data && typeof (data as Record<string, unknown>).tabId === 'string') {
            const record = data as Record<string, unknown>;
            targetTabId = record.tabId as string;
            targetDocGen = typeof record.documentGeneration === 'number'
              ? record.documentGeneration
              : undefined;
          }
        }
        if (targetTabId) {
          const newRev = await this.attachmentRegistry.updateAttachmentTab(
            authority.attachmentId,
            targetTabId,
            targetDocGen
          );
          if (newRev) {
            replacementAuthorityRevision = newRev;
          } else {
            throw new CapabilityError(
              'ATTACHMENT_REBIND_FAILED',
              `${intent.name} reached '${targetTabId}' but attachment authority failed to rotate (CAS conflict or missing record). Call browser.rebind-target to retry.`,
              {
                mutationCommitted: false,
                intendedTabId: targetTabId,
                attachmentId: authority.attachmentId,
                documentGeneration: targetDocGen,
                recoveryAction: 'browser.rebind-target',
              }
            );
          }
        }
      } else if (isCloseTab) {
        if (data && typeof data === 'object') {
          const resObj = data as { closed?: unknown; tabId?: unknown; failoverTabId?: unknown };
          const closedCanonicalId = typeof resObj.tabId === 'string' && resObj.tabId.trim().length > 0
            ? resObj.tabId.trim()
            : undefined;
          // The port nominates failoverTabId against the same post-heal target it
          // was dispatched with (authContext.browserTarget); the pre-heal authority
          // snapshot would veto a rotation the record already moved past.
          const boundTabId = authContext.browserTarget?.tabId;
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
            // CAS on the closed tab: a record that rotated elsewhere since this
            // dispatch resolved its target is left alone rather than hijacked.
            // The CAS path requires a generation, so measure the failover tab
            // live and fall back to the record's last known generation.
            const failoverDocGen = this.catalogue.getDocumentGeneration?.(failoverCandidate);
            const newRev = await this.attachmentRegistry.updateAttachmentTab(
              authority.attachmentId,
              failoverCandidate,
              typeof failoverDocGen === 'number' && Number.isFinite(failoverDocGen) && failoverDocGen > 0
                ? failoverDocGen
                : (authority.browserTarget?.documentGeneration ?? record.documentGeneration ?? 1),
              { expectedTabId: closedCanonicalId }
            );
            if (newRev) replacementAuthorityRevision = newRev;
          }
        }
      } else if (isInspection) {
        const attachedTabId = attachedTabIdForInspection;
        if (attachedTabId) {
          const requestedTabId = typeof p?.tabId === 'string' && p.tabId.trim().length > 0 ? p.tabId.trim() : undefined;
          const canonicalReqId = requestedTabId
            ? (this.catalogue.resolveTabId ? this.catalogue.resolveTabId(requestedTabId) : requestedTabId) ?? requestedTabId
            : undefined;

          // Only a same-target read whose generation is identical before and after
          // may acknowledge drift: a navigation during the read (pre !== post) or a
          // caller-supplied generation is never authority.
          const isSameAttachedTarget = !canonicalReqId || canonicalReqId === attachedTabId;
          if (isSameAttachedTarget) {
            if (
              typeof preInspectionDocGen === 'number' &&
              typeof postInspectionDocGen === 'number' &&
              Number.isFinite(preInspectionDocGen) &&
              preInspectionDocGen > 0 &&
              preInspectionDocGen === postInspectionDocGen
            ) {
              const observedDocGen = Math.floor(preInspectionDocGen);
              const currentAttachedDocGen = authority.browserTarget?.documentGeneration ?? record.documentGeneration ?? 1;

              // Advance only on strictly newer generation so stale or backward reads
              // cannot erase an effectful fence; CAS preserves a concurrent rebind.
              if (observedDocGen > currentAttachedDocGen) {
                const newRev = await this.attachmentRegistry.updateAttachmentTab(
                  authority.attachmentId,
                  attachedTabId,
                  observedDocGen,
                  {
                    expectedRevision: liveAuthority.authorityRevision,
                    expectedTabId: attachedTabId,
                  }
                );
                if (newRev) replacementAuthorityRevision = newRev;
              }
            }
          }
        }
      }
      // A completion that lands after the execution deadline is still a timeout:
      // the effect may have landed, so the receipt must be EXECUTION_TIMEOUT with
      // an indeterminate state rather than a clean completion. Bookkeeping for
      // effects already performed (tab/authority revision) stays applied above.
      if (execControl.cancellationSource === 'timeout') {
        const lateTimeoutErr = new Error(`Execution exceeded its ${executionDeadlineMs}ms execution budget`);
        (lateTimeoutErr as unknown as { code: string }).code = 'EXECUTION_TIMEOUT';
        throw lateTimeoutErr;
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
        state: 'completed',
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
        state: classified.state,
        error: errObj,
      };
    } finally {
      abortListenerCleanup?.();
    }
    })();
    // The handler always returns a classified response; observe the same promise
    // here so a background continuation can never surface as an unhandled rejection.
    handlerPromise.catch(() => {});

    const graceOutcome = await Promise.race([
      handlerPromise.then((response) => ({ settled: true as const, response })),
      new Promise<{ settled: false }>((resolve) => {
        graceTimer = setTimeout(() => resolve({ settled: false }), executionBudgetMs);
      }),
    ]);
    if (executionTimer) clearTimeout(executionTimer);
    if (graceTimer) clearTimeout(graceTimer);

    if (graceOutcome.settled) {
      return graceOutcome.response;
    }

    // The handler is still holding resources past the total response budget.
    // Return a bounded nonterminal pending-cleanup response: the ledger record
    // stays nonterminal and joinable by the original idempotencyKey, the
    // original handler promise writes the terminal receipt only after its owned
    // cleanup completes, and the stale continuation token is invalidated so no
    // late child work is admitted from this invocation.
    execControl.continuationValid = false;
    return {
      ok: false,
      requestId: intent.requestId,
      invocationId,
      state: 'in_progress',
      error: {
        code: 'EXECUTION_TIMEOUT_PENDING_CLEANUP',
        message: `Execution exceeded the ${executionBudgetMs}ms response budget (${executionDeadlineMs}ms execution + ${cancellationAckMs}ms cleanup grace) and is still releasing owned resources`,
        details: { invocationId, cleanupPending: true },
      },
    };
  }

  private classifySettlement(
    err: unknown,
    policy: CapabilityEffectPolicy | undefined,
    control: ExecutionControlImpl
  ): { state: 'failed' | 'interrupted' | 'unknown'; code: string; message: string; details?: unknown } {
    const typed = err as { code?: string; message?: string; name?: string; details?: unknown };
    const typedCode = typeof typed?.code === 'string' && typed.code ? typed.code : undefined;
    const typedMessage = typeof typed?.message === 'string' && typed.message ? typed.message : undefined;
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
      if (control.cancellationSource === 'timeout') {
        // Budget deadline: a terminal EXECUTION_TIMEOUT. `unknown` when effects
        // started (cleanup cannot prove the page/artifact state), `interrupted`
        // when nothing was committed.
        const effectsStarted = effectStage !== 'not-started' || ack === 'effect-possible';
        return {
          state: effectsStarted ? 'unknown' : 'interrupted',
          code: 'EXECUTION_TIMEOUT',
          message: typedMessage || 'Execution exceeded its policy execution budget and was aborted',
          details: typed?.details,
        };
      }
      if (ack === 'no-effect' || (isTransportAbort && effectStage === 'not-started') || (policy?.effect === 'read' && effectStage === 'not-started')) {
        return {
          state: 'interrupted',
          code: typedCode || 'ABORTED',
          message: typedMessage || 'Execution was aborted before effects were committed',
          details: typed?.details,
        };
      }
      if (!isTransportAbort && effectStage === 'not-started') {
        return {
          state: 'failed',
          code: typedCode || 'ABORTED',
          message: typedMessage || 'Execution failed with unrequested internal abort',
          details: typed?.details,
        };
      }
      return {
        state: 'unknown',
        code: typedCode || 'ABORTED',
        message: 'Execution was aborted with indeterminate effect state',
        details: typed?.details ?? (typedMessage ? { cause: typedMessage } : undefined),
      };
    }

    if (typed?.code === 'TIMEOUT' || typed?.code === 'EXECUTION_TIMEOUT') {
      // Handler-forged timeout with no transport abort (the transport budget
      // deadline is classified above via cancellationSource === 'timeout'): a
      // timeout that never started an effect is a failure, not an interruption.
      const effectsStarted = control.effectStage !== 'not-started' || control.cancellationAck === 'effect-possible';
      return {
        state: effectsStarted ? 'unknown' : 'failed',
        code: typedCode || 'EXECUTION_TIMEOUT',
        message: typedMessage || (effectsStarted ? 'Execution timed out with indeterminate effect state' : 'Execution timed out'),
        details: typed?.details,
      };
    }

    if (typed?.code === 'EXECUTION_UNKNOWN') {
      return {
        state: 'unknown',
        code: 'EXECUTION_UNKNOWN',
        message: typedMessage || 'Execution ended in unknown state',
        details: typed?.details,
      };
    }

    return {
      state: 'failed',
      code: typedCode || 'CAPABILITY_ERROR',
      message: relayErrorMessage(err),
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
  isFreshInspection(name: string, policy?: CapabilityEffectPolicy): boolean {
    const definition = this.catalogue?.get?.(name) as (FreshInspectionTrait & { policy?: CapabilityEffectPolicy }) | undefined;
    return isFreshInspectionCapability(name, policy, definition);
  }
}
