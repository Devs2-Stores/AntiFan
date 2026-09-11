/**
 * The lifecycle budget contract: counters are per attempt, the ceilings and the failure
 * signature carry, and a terminal lifecycle stays terminal.
 *
 * `test/unit/semantic-evidence-and-guardrails.test.ts` pins the per-attempt counter rule; this file
 * covers the paths that finish the loop, so a change that makes STALEMATE unreachable — or that lets
 * a terminal batch consume budget again — fails here.
 *
 * The defect this guards: the terminal fast-exit tested `FIXED_VERIFIED`, which is written to
 * `terminalOutcome`, not to `state`. The states `recordAttempt` actually assigns (`VERIFIED`,
 * `REFUSED_SCOPE`) were not tested, so a terminal batch re-entered budget accounting and consumed
 * budget — and rewrote — state that was already final.
 *
 * The second suite pins the signature production actually supplies: `verify_claim` derives it from
 * the failed proof obligations, so these cases are what keep the cross-attempt lever reachable from
 * a real caller rather than only from a test that hands `recordAttempt` an options object.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { VerificationCircuitBreaker, DEFAULT_MAX_REPAIRS } from '../../src/main/verification/circuit-breaker';
import { VerificationEvaluator } from '../../src/main/verification/verification-evaluator';

const breaker = VerificationCircuitBreaker.getInstance();

describe('VerificationCircuitBreaker lifecycle budget and terminal states', () => {
  it('keeps counters per attempt while the ceilings carry into the next attempt of the run', () => {
    const runId = 'test-run-per-attempt';
    const first = breaker.recordAttempt(
      { runId, attemptId: 'attempt-1', claimId: 'claim-1' },
      'REJECTED',
      undefined,
      undefined,
      'invocation-1',
      { maxRepairs: 5, maxResamples: 4 }
    );
    assert.strictEqual(first.lifecycle.repairAttempts, 1);

    const second = breaker.recordAttempt(
      { runId, attemptId: 'attempt-2', claimId: 'claim-2' },
      'REJECTED',
      undefined,
      first.lifecycle,
      'invocation-2',
      {}
    );
    assert.strictEqual(second.lifecycle.repairAttempts, 1, 'the counter restarts for a new attempt');
    assert.strictEqual(second.lifecycle.resampleAttempts, 0);
    assert.strictEqual(second.lifecycle.maxRepairs, 5, 'the ceiling carries');
    assert.strictEqual(second.lifecycle.maxResamples, 4);
    assert.strictEqual(second.remainingRepairs, 4);
  });

  it('trips STALEMATE when the repair budget exhausts inside one attempt', () => {
    const runId = 'test-run-repair-exhaustion';
    const key = { runId, attemptId: 'attempt-1', claimId: 'claim-1' };
    const first = breaker.recordAttempt(key, 'REJECTED', undefined, undefined, 'invocation-1', {
      maxRepairs: 2,
      failureSignature: 'SIG-A',
    });
    assert.notStrictEqual(first.lifecycle.state, 'STALEMATE');

    const second = breaker.recordAttempt(key, 'REJECTED', undefined, first.lifecycle, 'invocation-2', {
      maxRepairs: 2,
      failureSignature: 'SIG-B',
    });
    assert.strictEqual(second.lifecycle.repairAttempts, 2);
    assert.strictEqual(second.lifecycle.state, 'STALEMATE');
    assert.strictEqual(second.lifecycle.terminalOutcome, 'STALEMATE');
  });

  it('trips STALEMATE when the resample budget exhausts inside one attempt', () => {
    const runId = 'test-run-resample-exhaustion';
    const key = { runId, attemptId: 'attempt-1', claimId: 'claim-1' };
    const first = breaker.recordAttempt(key, 'INCONCLUSIVE', 'RESAMPLE', undefined, 'invocation-1', { maxResamples: 2 });
    assert.strictEqual(first.lifecycle.resampleAttempts, 1);

    const second = breaker.recordAttempt(key, 'INCONCLUSIVE', 'RESAMPLE', first.lifecycle, 'invocation-2', { maxResamples: 2 });
    assert.strictEqual(second.lifecycle.resampleAttempts, 2);
    assert.strictEqual(second.lifecycle.state, 'STALEMATE');
  });

  it('trips STALEMATE across attempts on a repeated failure signature', () => {
    const runId = 'test-run-repeat-signature';
    const first = breaker.recordAttempt(
      { runId, attemptId: 'attempt-1', claimId: 'claim-1' },
      'REJECTED',
      undefined,
      undefined,
      'invocation-1',
      { failureSignature: 'SAME-CAUSE' }
    );
    assert.notStrictEqual(first.lifecycle.state, 'STALEMATE');

    const second = breaker.recordAttempt(
      { runId, attemptId: 'attempt-2', claimId: 'claim-2' },
      'REJECTED',
      undefined,
      first.lifecycle,
      'invocation-2',
      { failureSignature: 'SAME-CAUSE' }
    );
    assert.strictEqual(second.lifecycle.state, 'STALEMATE');
    assert.strictEqual(second.lifecycle.terminalOutcome, 'STALEMATE');
    assert.strictEqual(second.lifecycle.lastFailureSignature, 'SAME-CAUSE');
  });

  it('does not consume budget again for a VERIFIED lifecycle', () => {
    const runId = 'test-run-terminal-verified';
    const verified = breaker.recordAttempt(
      { runId, attemptId: 'attempt-1', claimId: 'claim-1' },
      'VERIFIED',
      undefined,
      undefined,
      'invocation-1',
      {}
    );
    assert.strictEqual(verified.lifecycle.state, 'VERIFIED');
    assert.strictEqual(verified.lifecycle.terminalOutcome, 'FIXED_VERIFIED');

    const repeat = breaker.recordAttempt(
      { runId, attemptId: 'attempt-1', claimId: 'claim-1' },
      'INCONCLUSIVE',
      'RESAMPLE',
      verified.lifecycle,
      'invocation-2',
      { maxResamples: 5 }
    );
    assert.strictEqual(repeat.lifecycle.state, 'VERIFIED');
    assert.strictEqual(repeat.consumed, null);
    assert.strictEqual(repeat.lifecycle.resampleAttempts, verified.lifecycle.resampleAttempts);
  });

  it('does not consume budget again for a REFUSED_SCOPE lifecycle', () => {
    const runId = 'test-run-terminal-refused-scope';
    const refused = breaker.recordAttempt(
      { runId, attemptId: 'attempt-1', claimId: 'claim-1' },
      'REJECTED',
      undefined,
      undefined,
      'invocation-1',
      { maxRepairs: 5, auditDecision: 'REFUSED_TOUCHED_PATH' }
    );
    assert.strictEqual(refused.lifecycle.state, 'REFUSED_SCOPE');
    assert.strictEqual(refused.lifecycle.terminalOutcome, 'REFUSED_SCOPE');

    const repeat = breaker.recordAttempt(
      { runId, attemptId: 'attempt-1', claimId: 'claim-1' },
      'REJECTED',
      undefined,
      refused.lifecycle,
      'invocation-2',
      { maxRepairs: 5, auditDecision: 'REFUSED_TOUCHED_PATH' }
    );
    assert.strictEqual(repeat.lifecycle.state, 'REFUSED_SCOPE');
    assert.strictEqual(repeat.consumed, null);
    assert.strictEqual(repeat.lifecycle.repairAttempts, refused.lifecycle.repairAttempts);
  });

  it('starts a different run with a clean budget', () => {
    const previous = breaker.recordAttempt(
      { runId: 'test-run-repeat-signature', attemptId: 'attempt-3', claimId: 'claim-3' },
      'REJECTED',
      undefined,
      undefined,
      'invocation-3',
      { failureSignature: 'SIG-C' }
    );
    const fresh = breaker.recordAttempt(
      { runId: 'test-run-fresh', attemptId: 'attempt-1', claimId: 'claim-fresh' },
      'REJECTED',
      undefined,
      previous.lifecycle,
      'invocation-4',
      { maxRepairs: DEFAULT_MAX_REPAIRS, failureSignature: 'SIG-D' }
    );
    assert.strictEqual(fresh.lifecycle.repairAttempts, 1);
    assert.strictEqual(fresh.lifecycle.consecutiveRefusalCount, 1);
  });
});

describe('VerificationEvaluator.failureSignature (the signature production supplies)', () => {
  const PROFILE = {
    completeness: 'FULL' as const,
    freshness: 'FRESH' as const,
    source: 'deterministic' as const,
    evaluatedMetricsCount: 4,
    passedMetricsCount: 3,
    violations: [],
  };
  const rejectedPass = { verdict: 'REJECTED' as const, proofProfile: PROFILE, summary: 'rejected' };

  it('keys a rejection on the failed obligations, order-insensitively and without duplicates', () => {
    const first = VerificationEvaluator.failureSignature(rejectedPass, {
      documentGeneration: 1,
      captureTimestamp: 1,
      samples: [
        { metric: 'visual.geometry_within_tolerance', passed: false },
        { metric: 'visual.cardinality_match', passed: true },
        { metric: 'theme.source_mapping.file_identified', passed: false },
        { metric: 'visual.geometry_within_tolerance', passed: false },
      ],
    });
    const reordered = VerificationEvaluator.failureSignature(rejectedPass, {
      documentGeneration: 1,
      captureTimestamp: 1,
      samples: [
        { metric: 'theme.source_mapping.file_identified', passed: false },
        { metric: 'visual.geometry_within_tolerance', passed: false },
      ],
    });
    const differentCause = VerificationEvaluator.failureSignature(rejectedPass, {
      documentGeneration: 1,
      captureTimestamp: 1,
      samples: [{ metric: 'visual.cardinality_match', passed: false }],
    });

    assert.strictEqual(first, 'theme.source_mapping.file_identified+visual.geometry_within_tolerance');
    assert.strictEqual(reordered, first, 'the same failures in another order are the same cause');
    assert.notStrictEqual(differentCause, first, 'a different failure is a different cause');
  });

  it('carries no signature for a pass, a partial, or an inconclusive resample', () => {
    const failedSample = [{ metric: 'visual.geometry_within_tolerance', passed: false }];
    assert.strictEqual(
      VerificationEvaluator.failureSignature(
        { verdict: 'VERIFIED', proofProfile: PROFILE, summary: 'ok' },
        { documentGeneration: 1, captureTimestamp: 1, samples: failedSample }
      ),
      undefined
    );
    assert.strictEqual(
      VerificationEvaluator.failureSignature(
        { verdict: 'INCONCLUSIVE', proofProfile: PROFILE, inconclusiveReason: 'RESAMPLE', summary: 'resample' },
        { documentGeneration: 1, captureTimestamp: 1, samples: failedSample }
      ),
      undefined,
      'a resample must not advance the identical-failure counter'
    );
    assert.strictEqual(
      VerificationEvaluator.failureSignature(
        { verdict: 'PARTIAL', proofProfile: PROFILE, inconclusiveReason: 'NEED_INPUT', summary: 'partial' },
        { documentGeneration: 1, captureTimestamp: 1, samples: failedSample }
      ),
      undefined
    );
    assert.strictEqual(
      VerificationEvaluator.failureSignature(rejectedPass, {
        documentGeneration: 1,
        captureTimestamp: 1,
        samples: [{ metric: 'visual.cardinality_match', passed: true }],
      }),
      undefined,
      'a rejection with no failed obligation has no cause to carry'
    );
  });

  it('trips STALEMATE when the signature production derives repeats across attempts', () => {
    const runId = 'test-run-derived-signature';
    const signature = VerificationEvaluator.failureSignature(rejectedPass, {
      documentGeneration: 1,
      captureTimestamp: 1,
      samples: [
        { metric: 'visual.geometry_within_tolerance', passed: false },
        { metric: 'visual.cardinality_match', passed: false },
      ],
    });
    assert.ok(signature);

    const first = breaker.recordAttempt(
      { runId, attemptId: 'attempt-1', claimId: 'claim-1' },
      'REJECTED',
      undefined,
      undefined,
      'invocation-1',
      { failureSignature: signature }
    );
    const second = breaker.recordAttempt(
      { runId, attemptId: 'attempt-2', claimId: 'claim-2' },
      'REJECTED',
      undefined,
      first.lifecycle,
      'invocation-2',
      { failureSignature: signature }
    );
    assert.strictEqual(second.lifecycle.state, 'STALEMATE');
    assert.strictEqual(second.lifecycle.lastFailureSignature, signature);
  });
});
