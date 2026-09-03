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
import { StalemateState, VerificationVerdict } from './verification-contract';

export interface CircuitBreakerConfig {
  maxRetries: number;
  perClaimBudget?: Map<string, number>;
}

export interface RetryBudgetStatus {
  claimId: string;
  attempts: number;
  maxRetries: number;
  remaining: number;
  tripped: boolean;
  state: StalemateState;
}

export class VerificationCircuitBreaker {
  private static instance: VerificationCircuitBreaker;
  private readonly attemptsByClaim = new Map<string, number>();
  private readonly stateByClaim = new Map<string, StalemateState>();
  private defaultMaxRetries = 3;
  private static readonly MAX_TRACKED_CLAIMS = 2000;

  private constructor() {}

  private pruneStaleEntries(): void {
    const maxSize = VerificationCircuitBreaker.MAX_TRACKED_CLAIMS;
    if (this.attemptsByClaim.size > maxSize || this.stateByClaim.size > maxSize) {
      let count = 0;
      for (const k of this.attemptsByClaim.keys()) {
        this.attemptsByClaim.delete(k);
        this.stateByClaim.delete(k);
        count++;
        if (count >= 500) break;
      }
      if (this.stateByClaim.size > maxSize) {
        let scount = 0;
        for (const k of this.stateByClaim.keys()) {
          this.stateByClaim.delete(k);
          scount++;
          if (scount >= 500) break;
        }
      }
    }
  }

  public static getInstance(): VerificationCircuitBreaker {
    if (!this.instance) {
      this.instance = new VerificationCircuitBreaker();
    }
    return this.instance;
  }

  public setMaxRetries(max: number): void {
    if (max > 0) {
      this.defaultMaxRetries = max;
    }
  }

  /**
   * Records a verification attempt and checks if the circuit breaker trips.
   * If verdict is REJECTED and retries are exhausted, trips to STALEMATE.
   */
  public recordAttempt(
    claimId: string,
    verdict: VerificationVerdict,
    linkedIssueId?: string
  ): { tripped: boolean; attempts: number; state: StalemateState } {
    this.pruneStaleEntries();
    if (verdict === 'VERIFIED') {
      // Success resets retry counter
      this.attemptsByClaim.set(claimId, 0);
      this.stateByClaim.set(claimId, 'ACTIVE');
      return { tripped: false, attempts: 0, state: 'ACTIVE' };
    }

    const currentAttempts = (this.attemptsByClaim.get(claimId) || 0) + 1;
    this.attemptsByClaim.set(claimId, currentAttempts);

    if (currentAttempts >= this.defaultMaxRetries) {
      this.stateByClaim.set(claimId, 'STALEMATE');
      // Update IssueRegister singleton
      try {
        IssueRegister.getInstance().updateVerificationStalemate(claimId, 'STALEMATE');
      } catch {}

      return { tripped: true, attempts: currentAttempts, state: 'STALEMATE' };
    }

    return { tripped: false, attempts: currentAttempts, state: 'ACTIVE' };
  }

  /**
   * Returns current budget status for a given claim.
   */
  public getBudgetStatus(claimId: string): RetryBudgetStatus {
    const attempts = this.attemptsByClaim.get(claimId) || 0;
    const state = this.stateByClaim.get(claimId) || 'ACTIVE';
    const remaining = Math.max(0, this.defaultMaxRetries - attempts);

    return {
      claimId,
      attempts,
      maxRetries: this.defaultMaxRetries,
      remaining,
      tripped: state === 'STALEMATE',
      state,
    };
  }

  /**
   * Applies a human exemption to unblock workflow without faking evidence.
   *
   * Invariant:
   * VerificationRecord.stalemateState -> 'EXEMPTION_WAIVED'
   * VerificationRecord.verdict stays truthful (NEVER converted to VERIFIED).
   * Linked IssueRecord (if any) can be marked RESOLVED with audit note.
   */
  public applyHumanExemption(
    claimId: string,
    reason: string,
    linkedIssueId?: string
  ): { success: boolean; claimId: string; state: StalemateState; exemptionReason: string } {
    if (!reason || reason.trim().length === 0) {
      throw new Error('Exemption reason is mandatory for human waiver');
    }
    this.pruneStaleEntries();
    this.stateByClaim.set(claimId, 'EXEMPTION_WAIVED');
    const issueRegister = IssueRegister.getInstance();

    // Update IssueRegister verification record
    issueRegister.updateVerificationStalemate(claimId, 'EXEMPTION_WAIVED', reason);

    // If there is a linked issue, resolve it and persist to disk via issueRegister.resolve
    if (linkedIssueId) {
      issueRegister.resolve(linkedIssueId, `[HUMAN_EXEMPTION]: ${reason}`);
    }

    return {
      success: true,
      claimId,
      state: 'EXEMPTION_WAIVED',
      exemptionReason: reason,
    };
  }

  /**
   * Resets circuit breaker state (useful for tests).
   */
  public reset(): void {
    this.attemptsByClaim.clear();
    this.stateByClaim.clear();
  }
}
