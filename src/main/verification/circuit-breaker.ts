/**
 * AntiFan Core - Verification Circuit Breaker & Stalemate Protection
 *
 * Grounding Axiom:
 * Infinite repair loops (Livelock) burn agent context budget without converging.
 * When retry attempts exceed the RetryBudget, or when repeated identical failure signatures
 * are detected, the circuit breaker MUST trip to STALEMATE.
 *
 * ============================================================================
 * AntiFan B-Lite v2 Loop Lifecycle & Ownership Split Contract
 * ============================================================================
 *
 * Epistemic & Architectural Boundary:
 * 1. Verification Engine Ownership:
 *    - The AntiFan verification engine owns evidence, artifact, and lifecycle state ONLY.
 *    - Adjudicates verdicts against deterministic & semantic evidence.
 *    - Has NO SOURCE-FILE ROLLBACK PATH inside the verification engine.
 *
 * 2. Workspace Mutation & Recovery Ownership (Main):
 *    - The ONLY writer to the real workspace is Main's merge gate (after staging & audit).
 *    - Workspace recovery is strictly Main's path-scoped restore (restoring pre-merge bytes
 *      of named files from real disk snapshots).
 *    - Repo-wide destructive git commands (git checkout -- ., git clean -fd, git reset --hard)
 *      are forbidden by invariant.
 *
 * 3. Pre-existing Capability Exception:
 *    - `theme.qa_repair.begin` and `theme.qa_repair.verify` are pre-existing write-class
 *      capabilities in AntiFan that snapshot and can roll back the workspace to R0.
 *    - EXCEPTION STATUS: These capabilities are OUTSIDE the fixer allowlist (which admits
 *      only file.read and file.write in the staged workspace) and are NEVER invoked by
 *      this B-Lite v2 fix loop. Recorded here explicitly so this legacy capability does
 *      not silently contradict the strict ownership split.
 *
 * 4. SCOPE_DISCOVERY Contract:
 *    - SCOPE_DISCOVERY is a returned class (a fix that cannot proceed inside `allowedFiles`),
 *      consumed by Main to evaluate and issue a new FixRequest.
 *    - It must NEVER expand scope in place within the staged or real workspace.
 * ============================================================================
 *
 * Human Exemption Protocol:
 * A human user may grant an exemption (EXEMPTION_WAIVED) to unblock execution,
 * but the system MUST NOT forge or mutate historical verification evidence
 * into a fake VERIFIED status.
 */

import { IssueRegister } from '../session/issue-register';
import type {
  FixDecision,
  FixLifecycleState,
  InconclusiveReason,
  RepairBudget,
  ScopeDiscoveryInfo,
  StalemateState,
  VerificationBatchLifecycle,
  VerificationVerdict,
} from './verification-contract';

export const DEFAULT_MAX_RESAMPLES = 3;
export const DEFAULT_MAX_REPAIRS = 3;
/**
 * Default threshold for repeated identical failure signatures or audit refusal causes
 * before tripping to STALEMATE (e.g. refused twice for the same cause).
 */
export const DEFAULT_MAX_IDENTICAL_FAILURES = 2;

export interface VerificationBatchKey {
  runId: string;
  attemptId: string;
  claimId: string;
}

/**
 * Optional configuration passed when recording an attempt to enforce B-Lite v2
 * budgets, refusal causes, failure signatures, and scope discovery.
 */
export interface RecordAttemptOptions {
  /** Explicit failure signature for circuit-breaker duplicate tracking */
  failureSignature?: string;
  /** Audit refusal cause code (e.g. from FixDecision: REFUSED_TOUCHED_PATH, REFUSED_DIFF_BUDGET, etc.) */
  refusalCauseCode?: string;
  /** Path to evidence artifacts explaining failure or refusal */
  evidencePath?: string;
  /** Audit decision if this attempt corresponds to an audit pass/refusal */
  auditDecision?: FixDecision;
  /** Discovered scope if the fixer discovered necessary files outside allowedFiles */
  scopeDiscovery?: ScopeDiscoveryInfo;
  /** Maximum allowed repairs (overrides default) */
  maxRepairs?: number;
  /** Maximum allowed resamples (overrides default) */
  maxResamples?: number;
  /** Maximum consecutive identical failures before tripping to STALEMATE (default: 2) */
  maxIdenticalFailures?: number;
  /** Optional initial or carried-over repair budget configuration */
  repairBudget?: Partial<RepairBudget>;
}

export interface VerificationTransitionResult {
  lifecycle: VerificationBatchLifecycle;
  consumed: 'resample' | 'repair' | null;
  remainingResamples: number;
  remainingRepairs: number;
  tripped: boolean;
  halted: boolean;
  /** Typed terminal outcome from the shared contract: FIXED_VERIFIED, REFUSED_SCOPE, STALEMATE, SCOPE_DISCOVERY */
  terminalOutcome?: FixLifecycleState;
  /** Scope discovery payload when lifecycle terminates in SCOPE_DISCOVERY */
  scopeDiscovery?: ScopeDiscoveryInfo;
}
export class VerificationCircuitBreaker {
  private static instance: VerificationCircuitBreaker;

  private constructor() {}

  public static getInstance(): VerificationCircuitBreaker {
    if (!this.instance) this.instance = new VerificationCircuitBreaker();
    return this.instance;
  }

  public createLifecycle(
    key: VerificationBatchKey,
    options?: { maxRepairs?: number; maxResamples?: number; repairAttempts?: number }
  ): VerificationBatchLifecycle {
    const maxRepairs = options?.maxRepairs ?? DEFAULT_MAX_REPAIRS;
    const repairAttempts = options?.repairAttempts ?? 0;
    const maxResamples = options?.maxResamples ?? DEFAULT_MAX_RESAMPLES;
    return {
      runId: key.runId,
      attemptId: key.attemptId,
      resampleAttempts: 0,
      repairAttempts,
      maxResamples,
      maxRepairs,
      state: 'ACTIVE',
      repairBudget: {
        repairAttempts,
        maxRepairs,
        remainingRepairs: Math.max(0, maxRepairs - repairAttempts),
      },
      consecutiveRefusalCount: 0,
    };
  }

  public recordAttempt(
    key: VerificationBatchKey,
    verdict: VerificationVerdict,
    inconclusiveReason?: InconclusiveReason,
    previous?: VerificationBatchLifecycle,
    invocationId?: string,
    options?: RecordAttemptOptions
  ): VerificationTransitionResult {
    const sameBatch = previous?.runId === key.runId && previous.attemptId === key.attemptId;
    const lifecycle: VerificationBatchLifecycle = sameBatch
      ? { ...previous, lastInvocationId: invocationId || previous.lastInvocationId }
      : {
          // Counters are per attempt by contract (test/unit/semantic-evidence-and-guardrails.test.ts);
          // only the ceilings carry into a later attempt of the same run. Cross-attempt STALEMATE is
          // reached through the carried failure signature, not by accumulating counters.
          ...this.createLifecycle(key, {
            maxRepairs: options?.maxRepairs ?? (previous?.runId === key.runId ? previous.maxRepairs : DEFAULT_MAX_REPAIRS),
            maxResamples: options?.maxResamples ?? (previous?.runId === key.runId ? previous.maxResamples : DEFAULT_MAX_RESAMPLES),
            repairAttempts: options?.repairBudget?.repairAttempts ?? 0,
          }),
          lastInvocationId: invocationId,
        };

    // If new attempt in the same run, carry over consecutive failure tracking and evidence
    if (!sameBatch && previous?.runId === key.runId) {
      if (lifecycle.consecutiveRefusalCount === 0 && previous.consecutiveRefusalCount) {
        lifecycle.consecutiveRefusalCount = previous.consecutiveRefusalCount;
      }
      if (!lifecycle.lastFailureSignature && previous.lastFailureSignature) {
        lifecycle.lastFailureSignature = previous.lastFailureSignature;
      }
      if (!lifecycle.evidencePath && previous.evidencePath) {
        lifecycle.evidencePath = previous.evidencePath;
      }
    }

    let consumed: VerificationTransitionResult['consumed'] = null;

    // Fast-exit if already terminal. VERIFIED and REFUSED_SCOPE are the states recordAttempt
    // actually assigns; FIXED_VERIFIED is the terminal outcome recorded alongside VERIFIED and is
    // kept here defensively for a lifecycle handed back with that state.
    if (
      lifecycle.state === 'STALEMATE' ||
      lifecycle.state === 'EXEMPTION_WAIVED' ||
      lifecycle.state === 'SCOPE_DISCOVERY' ||
      lifecycle.state === 'VERIFIED' ||
      lifecycle.state === 'REFUSED_SCOPE' ||
      lifecycle.state === 'FIXED_VERIFIED'
    ) {
      return this.result(lifecycle, consumed);
    }

    // 1. SCOPE_DISCOVERY handler (fix cannot proceed inside allowedFiles)
    // Consumed by Main to issue a new FixRequest; never expands scope in place.
    if (options?.scopeDiscovery) {
      lifecycle.state = 'SCOPE_DISCOVERY';
      lifecycle.terminalOutcome = 'SCOPE_DISCOVERY';
      lifecycle.scopeDiscovery = options.scopeDiscovery;
      if (options.evidencePath) {
        lifecycle.evidencePath = options.evidencePath;
      }
      return this.result(lifecycle, consumed);
    }

    // 2. VERIFIED handler
    if (verdict === 'VERIFIED') {
      lifecycle.state = 'VERIFIED';
      lifecycle.terminalOutcome = 'FIXED_VERIFIED';
      delete lifecycle.haltReason;
      lifecycle.consecutiveRefusalCount = 0;
      if (options?.evidencePath) {
        lifecycle.evidencePath = options.evidencePath;
      }
      return this.result(lifecycle, consumed);
    }

    // 3. Non-retryable inconclusive outcomes -> HALTED
    if (inconclusiveReason === 'NEED_INPUT' || inconclusiveReason === 'UNOBSERVABLE' || inconclusiveReason === 'UNSUPPORTED') {
      lifecycle.state = 'HALTED';
      lifecycle.haltReason = inconclusiveReason;
      if (options?.evidencePath) {
        lifecycle.evidencePath = options.evidencePath;
      }
      return this.result(lifecycle, consumed);
    }

    // 4. Repeated identical signature circuit breaker:
    // A fix whose audit is refused twice for the same cause, or an identical failure signature N times
    // (default: 2) transitions to STALEMATE with the last failure signature and evidence path.
    const maxIdenticalFailures = options?.maxIdenticalFailures ?? DEFAULT_MAX_IDENTICAL_FAILURES;
    const currentSignature =
      options?.failureSignature ||
      options?.refusalCauseCode ||
      (options?.auditDecision ? String(options.auditDecision) : undefined);

    if (currentSignature) {
      const isIdentical = lifecycle.lastFailureSignature === currentSignature;
      lifecycle.consecutiveRefusalCount = isIdentical
        ? (lifecycle.consecutiveRefusalCount ?? 0) + 1
        : 1;
      lifecycle.lastFailureSignature = currentSignature;
    }

    // 5. Inconclusive resample budget
    if (verdict === 'INCONCLUSIVE' && inconclusiveReason === 'RESAMPLE') {
      lifecycle.resampleAttempts++;
      consumed = 'resample';
      if (lifecycle.resampleAttempts >= lifecycle.maxResamples) {
        lifecycle.state = 'STALEMATE';
        lifecycle.terminalOutcome = 'STALEMATE';
        lifecycle.lastFailureSignature = currentSignature || 'RESAMPLE_EXHAUSTED';
        if (options?.evidencePath) {
          lifecycle.evidencePath = options.evidencePath;
        }
      }
      return this.result(lifecycle, consumed);
    }

    // 6. Repair budget accounting
    if (verdict === 'REJECTED' || verdict === 'PARTIAL') {
      lifecycle.repairAttempts++;
      consumed = 'repair';

      // Check if breaker tripped due to repeated identical failure signature / audit refusal cause
      if (currentSignature && (lifecycle.consecutiveRefusalCount ?? 0) >= maxIdenticalFailures) {
        lifecycle.state = 'STALEMATE';
        lifecycle.terminalOutcome = 'STALEMATE';
        lifecycle.lastFailureSignature = currentSignature;
        if (options?.evidencePath) {
          lifecycle.evidencePath = options.evidencePath;
        }
        return this.result(lifecycle, consumed);
      }

      // Check if breaker tripped due to exhausted repair budget
      if (lifecycle.repairAttempts >= lifecycle.maxRepairs) {
        lifecycle.state = 'STALEMATE';
        lifecycle.terminalOutcome = 'STALEMATE';
        lifecycle.lastFailureSignature = currentSignature || 'REPAIR_BUDGET_EXHAUSTED';
        if (options?.evidencePath) {
          lifecycle.evidencePath = options.evidencePath;
        }
      } else if (
        options?.auditDecision === 'REFUSED_SCOPE_EXPANSION' ||
        options?.auditDecision === 'REFUSED_TOUCHED_PATH' ||
        options?.refusalCauseCode === 'REFUSED_SCOPE_EXPANSION' ||
        options?.refusalCauseCode === 'REFUSED_TOUCHED_PATH'
      ) {
        // Single refusal on scope marks outcome as REFUSED_SCOPE
        lifecycle.state = 'REFUSED_SCOPE';
        lifecycle.terminalOutcome = 'REFUSED_SCOPE';
        if (options.evidencePath) {
          lifecycle.evidencePath = options.evidencePath;
        }
      }
    }

    return this.result(lifecycle, consumed);
  }

  public applyHumanExemption(
    claimId: string,
    reason: string,
    linkedIssueId?: string
  ): { success: boolean; claimId: string; state: StalemateState; exemptionReason: string } {
    if (!reason || reason.trim().length === 0) {
      throw new Error('Exemption reason is mandatory for human waiver');
    }
    const issueRegister = IssueRegister.getInstance();
    issueRegister.updateVerificationStalemate(claimId, 'EXEMPTION_WAIVED', reason);
    if (linkedIssueId) issueRegister.resolve(linkedIssueId, `[HUMAN_EXEMPTION]: ${reason}`);
    return { success: true, claimId, state: 'EXEMPTION_WAIVED', exemptionReason: reason };
  }

  private result(
    lifecycle: VerificationBatchLifecycle,
    consumed: VerificationTransitionResult['consumed']
  ): VerificationTransitionResult {
    const remainingRepairs = Math.max(0, lifecycle.maxRepairs - lifecycle.repairAttempts);
    lifecycle.repairBudget = {
      repairAttempts: lifecycle.repairAttempts,
      maxRepairs: lifecycle.maxRepairs,
      remainingRepairs,
    };

    return {
      lifecycle,
      consumed,
      remainingResamples: Math.max(0, lifecycle.maxResamples - lifecycle.resampleAttempts),
      remainingRepairs,
      tripped: lifecycle.state === 'STALEMATE',
      halted: lifecycle.state === 'HALTED',
      terminalOutcome: lifecycle.terminalOutcome,
      scopeDiscovery: lifecycle.scopeDiscovery,
    };
  }

  /**
   * Records an audit refusal (e.g. REFUSED_TOUCHED_PATH, REFUSED_DIFF_BUDGET, REFUSED_DRIFT).
   * A fix whose audit is refused twice for the same cause transitions to STALEMATE with
   * the failure signature and evidence path.
   */
  public recordAuditRefusal(
    key: VerificationBatchKey,
    causeCode: string,
    options?: {
      evidencePath?: string;
      auditDecision?: FixDecision;
      invocationId?: string;
      maxIdenticalFailures?: number;
    },
    previous?: VerificationBatchLifecycle
  ): VerificationTransitionResult {
    const isDecision = (
      causeCode === 'OK' ||
      causeCode === 'REFUSED_TOUCHED_PATH' ||
      causeCode === 'REFUSED_DIFF_BUDGET' ||
      causeCode === 'REFUSED_SCOPE_EXPANSION' ||
      causeCode === 'REFUSED_DRIFT' ||
      causeCode === 'REFUSED_TOOL_SURFACE' ||
      causeCode === 'REFUSED_SELF_VERIFICATION'
    );
    return this.recordAttempt(
      key,
      'REJECTED',
      undefined,
      previous,
      options?.invocationId,
      {
        refusalCauseCode: causeCode,
        failureSignature: causeCode,
        auditDecision: options?.auditDecision ?? (isDecision ? (causeCode as FixDecision) : undefined),
        evidencePath: options?.evidencePath,
        maxIdenticalFailures: options?.maxIdenticalFailures ?? DEFAULT_MAX_IDENTICAL_FAILURES,
      }
    );
  }

  /**
   * Records a SCOPE_DISCOVERY outcome when the fixer discovers a fix cannot proceed
   * inside allowedFiles. Transitions the batch to SCOPE_DISCOVERY and attaches the
   * missingPaths/requestedTargets without expanding scope in place.
   */
  public recordScopeDiscovery(
    key: VerificationBatchKey,
    discovery: ScopeDiscoveryInfo,
    options?: {
      evidencePath?: string;
      invocationId?: string;
    },
    previous?: VerificationBatchLifecycle
  ): VerificationTransitionResult {
    return this.recordAttempt(
      key,
      'INCONCLUSIVE',
      'NEED_INPUT',
      previous,
      options?.invocationId,
      {
        scopeDiscovery: discovery,
        evidencePath: options?.evidencePath,
      }
    );
  }

  /**
   * Records a failure signature for circuit-breaker duplicate tracking.
   * If the identical signature occurs N times (default: 2), trips to STALEMATE.
   */
  public recordFailureSignature(
    key: VerificationBatchKey,
    signature: string,
    options?: {
      evidencePath?: string;
      invocationId?: string;
      maxIdenticalFailures?: number;
    },
    previous?: VerificationBatchLifecycle
  ): VerificationTransitionResult {
    return this.recordAttempt(
      key,
      'REJECTED',
      undefined,
      previous,
      options?.invocationId,
      {
        failureSignature: signature,
        evidencePath: options?.evidencePath,
        maxIdenticalFailures: options?.maxIdenticalFailures ?? DEFAULT_MAX_IDENTICAL_FAILURES,
      }
    );
  }

  public reset(): void {
    // Stateless by design. Persisted lifecycle belongs to VerificationRecord.
  }
}
