/**
 * AntiFan Core - Verification Circuit Breaker & Stalemate Protection
 *
 * Grounding Axiom:
 * Infinite repair loops (Livelock) burn agent context budget without converging.
 * When retry attempts exceed the RetryBudget, the circuit breaker MUST trip to
 * VERIFICATION_STALEMATE.
 *
 * Human Exemption Protocol:
 * A human user may grant an exemption (EXEMPTION_WAIVED) to unblock execution,
 * but the system MUST NOT forge or mutate historical verification evidence
 * into a fake VERIFIED status.
 */

import { IssueRegister } from '../session/issue-register';
import {
  InconclusiveReason,
  StalemateState,
  VerificationBatchLifecycle,
  VerificationVerdict,
} from './verification-contract';

export const DEFAULT_MAX_RESAMPLES = 3;
export const DEFAULT_MAX_REPAIRS = 3;

export interface VerificationBatchKey {
  runId: string;
  attemptId: string;
  claimId: string;
}

export interface VerificationTransitionResult {
  lifecycle: VerificationBatchLifecycle;
  consumed: 'resample' | 'repair' | null;
  remainingResamples: number;
  remainingRepairs: number;
  tripped: boolean;
  halted: boolean;
}

export class VerificationCircuitBreaker {
  private static instance: VerificationCircuitBreaker;

  private constructor() {}

  public static getInstance(): VerificationCircuitBreaker {
    if (!this.instance) this.instance = new VerificationCircuitBreaker();
    return this.instance;
  }

  public createLifecycle(key: VerificationBatchKey): VerificationBatchLifecycle {
    return {
      runId: key.runId,
      attemptId: key.attemptId,
      resampleAttempts: 0,
      repairAttempts: 0,
      maxResamples: DEFAULT_MAX_RESAMPLES,
      maxRepairs: DEFAULT_MAX_REPAIRS,
      state: 'ACTIVE',
    };
  }

  public recordAttempt(
    key: VerificationBatchKey,
    verdict: VerificationVerdict,
    inconclusiveReason?: InconclusiveReason,
    previous?: VerificationBatchLifecycle,
    invocationId?: string
  ): VerificationTransitionResult {
    const sameBatch = previous?.runId === key.runId && previous.attemptId === key.attemptId;
    const lifecycle: VerificationBatchLifecycle = sameBatch
      ? { ...previous, lastInvocationId: invocationId || previous.lastInvocationId }
      : { ...this.createLifecycle(key), lastInvocationId: invocationId };
    let consumed: VerificationTransitionResult['consumed'] = null;

    if (lifecycle.state === 'STALEMATE' || lifecycle.state === 'EXEMPTION_WAIVED') {
      return this.result(lifecycle, consumed);
    }

    if (verdict === 'VERIFIED') {
      lifecycle.state = 'VERIFIED';
      delete lifecycle.haltReason;
      return this.result(lifecycle, consumed);
    }

    if (inconclusiveReason === 'NEED_INPUT' || inconclusiveReason === 'UNOBSERVABLE' || inconclusiveReason === 'UNSUPPORTED') {
      lifecycle.state = 'HALTED';
      lifecycle.haltReason = inconclusiveReason;
      return this.result(lifecycle, consumed);
    }

    if (verdict === 'INCONCLUSIVE' && inconclusiveReason === 'RESAMPLE') {
      lifecycle.resampleAttempts++;
      consumed = 'resample';
      if (lifecycle.resampleAttempts >= lifecycle.maxResamples) lifecycle.state = 'STALEMATE';
      return this.result(lifecycle, consumed);
    }

    if (verdict === 'REJECTED' || verdict === 'PARTIAL') {
      lifecycle.repairAttempts++;
      consumed = 'repair';
      if (lifecycle.repairAttempts >= lifecycle.maxRepairs) lifecycle.state = 'STALEMATE';
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
    return {
      lifecycle,
      consumed,
      remainingResamples: Math.max(0, lifecycle.maxResamples - lifecycle.resampleAttempts),
      remainingRepairs: Math.max(0, lifecycle.maxRepairs - lifecycle.repairAttempts),
      tripped: lifecycle.state === 'STALEMATE',
      halted: lifecycle.state === 'HALTED',
    };
  }

  public reset(): void {
    // Stateless by design. Persisted lifecycle belongs to VerificationRecord.
  }
}
