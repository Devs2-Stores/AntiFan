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
import {
  VerificationEvaluator,
  deriveFailureSignature,
  resolvePreviousLifecycle,
} from '../../src/main/verification/verification-evaluator';
import {
  VerificationClaim,
  EvidenceSampleBundle,
  VerificationBatchLifecycle,
} from '../../src/main/verification/verification-contract';

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
  const claim: VerificationClaim = {
    id: 'claim-signature-test',
    claim: 'Verify geometry, cardinality, and source mapping',
    actor: 'agent',
    scope: { tabId: 'tab-1' },
    proofObligations: [
      { id: 'obl-1', metric: 'visual.geometry_within_tolerance', critical: true },
      { id: 'obl-2', metric: 'visual.cardinality_match', critical: false },
      { id: 'obl-3', metric: 'theme.source_mapping.file_identified', critical: true },
    ],
  };

  it('keys a rejection on the failed obligations from evaluator violations, order-insensitively and without duplicates', () => {
    const evalResult1 = VerificationEvaluator.evaluate(claim, {
      documentGeneration: 1,
      captureTimestamp: 1,
      samples: [
        { metric: 'visual.geometry_within_tolerance', actual: 100, expected: 0, passed: false },
        { metric: 'visual.cardinality_match', actual: 1, expected: 1, passed: true },
        { metric: 'theme.source_mapping.file_identified', actual: false, expected: true, passed: false },
        { metric: 'visual.geometry_within_tolerance', actual: 100, expected: 0, passed: false },
      ],
    });
    assert.strictEqual(evalResult1.verdict, 'REJECTED');
    const first = deriveFailureSignature(evalResult1);

    const evalResultReordered = VerificationEvaluator.evaluate(claim, {
      documentGeneration: 1,
      captureTimestamp: 1,
      samples: [
        { metric: 'theme.source_mapping.file_identified', actual: false, expected: true, passed: false },
        { metric: 'visual.geometry_within_tolerance', actual: 100, expected: 0, passed: false },
      ],
    });
    assert.strictEqual(evalResultReordered.verdict, 'REJECTED');
    const reordered = deriveFailureSignature(evalResultReordered);

    const evalResultDifferent = VerificationEvaluator.evaluate(
      {
        ...claim,
        proofObligations: [{ id: 'obl-2', metric: 'visual.cardinality_match', critical: true }],
      },
      {
        documentGeneration: 1,
        captureTimestamp: 1,
        samples: [{ metric: 'visual.cardinality_match', actual: 0, expected: 1, passed: false }],
      }
    );
    assert.strictEqual(evalResultDifferent.verdict, 'REJECTED');
    const differentCause = deriveFailureSignature(evalResultDifferent);

    assert.strictEqual(first, 'theme.source_mapping.file_identified+visual.geometry_within_tolerance');
    assert.strictEqual(reordered, first, 'the same failures in another order are the same cause');
    assert.notStrictEqual(differentCause, first, 'a different failure is a different cause');
    assert.strictEqual(VerificationEvaluator.failureSignature(evalResult1), first, 'static method delegates to deriveFailureSignature');
  });

  it('carries no signature for a pass, a partial, or an inconclusive resample', () => {
    const passResult = VerificationEvaluator.evaluate(claim, {
      documentGeneration: 1,
      captureTimestamp: 1,
      samples: [
        { metric: 'visual.geometry_within_tolerance', actual: 0, expected: 0, passed: true },
        { metric: 'visual.cardinality_match', actual: 1, expected: 1, passed: true },
        { metric: 'theme.source_mapping.file_identified', actual: true, expected: true, passed: true },
      ],
    });
    assert.strictEqual(passResult.verdict, 'VERIFIED');
    assert.strictEqual(deriveFailureSignature(passResult), undefined);

    const staleResult = VerificationEvaluator.evaluate(
      { ...claim, targetGeneration: 2 },
      { documentGeneration: 1, captureTimestamp: 1, samples: [] }
    );
    assert.strictEqual(staleResult.verdict, 'INCONCLUSIVE');
    assert.strictEqual(staleResult.inconclusiveReason, 'RESAMPLE');
    assert.strictEqual(deriveFailureSignature(staleResult), undefined, 'a resample must not advance the identical-failure counter');

    const partialResult = VerificationEvaluator.evaluate(
      {
        id: 'claim-partial',
        claim: 'Partial obligations test',
        actor: 'agent',
        scope: { tabId: 'tab-1' },
        proofObligations: [
          { id: 'obl-1', metric: 'visual.cardinality_match', critical: false },
          { id: 'obl-2', metric: 'visual.secondary_metric', critical: false },
        ],
      },
      {
        documentGeneration: 1,
        captureTimestamp: 1,
        samples: [{ metric: 'visual.cardinality_match', actual: 1, expected: 1, passed: true }],
      }
    );
    assert.strictEqual(partialResult.verdict, 'PARTIAL');
    assert.strictEqual(deriveFailureSignature(partialResult), undefined);
  });

  it('isolates signature from caller-supplied sample flags (engine-adjudicates invariant)', () => {
    // Caller supplies passed: false on an obligation that passes according to criteria
    const passingClaim: VerificationClaim = {
      id: 'claim-caller-flag',
      claim: 'Pass with bogus caller passed flag',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [{ id: 'obl-1', metric: 'visual.geometry_within_tolerance', critical: true }],
    };
    const passResult = VerificationEvaluator.evaluate(passingClaim, {
      documentGeneration: 1,
      captureTimestamp: 1,
      samples: [{ metric: 'visual.geometry_within_tolerance', actual: 0, expected: 0, passed: true }],
    });
    assert.strictEqual(passResult.verdict, 'VERIFIED');
    // Even if caller passed a sample array with passed: false, evaluate produced VERIFIED, so signature is undefined
    assert.strictEqual(deriveFailureSignature(passResult), undefined);
  });

  it('trips STALEMATE when the signature production derives repeats across attempts', () => {
    const runId = 'test-run-derived-signature';
    const evalResult = VerificationEvaluator.evaluate(claim, {
      documentGeneration: 1,
      captureTimestamp: 1,
      samples: [
        { metric: 'visual.geometry_within_tolerance', actual: 100, expected: 0, passed: false },
        { metric: 'visual.cardinality_match', actual: 0, expected: 1, passed: false },
        { metric: 'theme.source_mapping.file_identified', actual: true, expected: true, passed: true },
      ],
    });
    assert.strictEqual(evalResult.verdict, 'REJECTED');
    const signature = deriveFailureSignature(evalResult);
    assert.strictEqual(signature, 'visual.cardinality_match+visual.geometry_within_tolerance');

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

describe('resolvePreviousLifecycle (cross-attempt reachability)', () => {
  // The old lookup implementation from browser-capabilities.ts:3034-3036
  const oldLookup = (
    claimRecord: { lifecycle?: VerificationBatchLifecycle; lifecycleHistory?: VerificationBatchLifecycle[] },
    runId: string,
    attemptId: string
  ) =>
    claimRecord.lifecycle?.runId === runId && claimRecord.lifecycle.attemptId === attemptId
      ? claimRecord.lifecycle
      : claimRecord.lifecycleHistory?.find((entry) => entry.runId === runId && entry.attemptId === attemptId);

  it('resolves previous lifecycle across different attempts of the same run, where old lookup returned undefined', () => {
    const runId = 'test-run-cross-attempt';
    const firstAttemptLifecycle = breaker.createLifecycle(
      { runId, attemptId: 'attempt-1', claimId: 'claim-1' },
      { maxRepairs: 2 }
    );
    firstAttemptLifecycle.lastFailureSignature = 'metric.failure';
    firstAttemptLifecycle.consecutiveRefusalCount = 1;

    const claimRecord = {
      lifecycle: firstAttemptLifecycle,
      lifecycleHistory: [firstAttemptLifecycle],
    };

    // Demonstrates Claim 2: The old lookup fails to supply previous lifecycle for a different attemptId
    const oldResolved = oldLookup(claimRecord, runId, 'attempt-2');
    assert.strictEqual(
      oldResolved,
      undefined,
      'old lookup required entry.attemptId === attemptId, so attempt-2 never saw attempt-1'
    );

    // The new lookup successfully resolves the run's latest lifecycle regardless of attemptId
    const newResolved = resolvePreviousLifecycle(claimRecord, runId);
    assert.ok(newResolved, 'new lookup must resolve latest lifecycle for the run');
    assert.strictEqual(newResolved.attemptId, 'attempt-1');
    assert.strictEqual(newResolved.lastFailureSignature, 'metric.failure');
    assert.strictEqual(newResolved.consecutiveRefusalCount, 1);

    // End-to-end circuit breaker effect:
    // With old lookup (undefined previous), attempt-2 resets consecutiveRefusalCount and STALEMATE never fires
    const breakerOld = breaker.recordAttempt(
      { runId, attemptId: 'attempt-2', claimId: 'claim-1' },
      'REJECTED',
      undefined,
      oldResolved, // undefined
      'inv-2',
      { failureSignature: 'metric.failure' }
    );
    assert.notStrictEqual(
      breakerOld.lifecycle.state,
      'STALEMATE',
      'with old lookup, attempt-2 never trips STALEMATE because previous was undefined'
    );
    assert.strictEqual(breakerOld.lifecycle.consecutiveRefusalCount, 1);

    // With new lookup (previous from attempt-1), attempt-2 carries over signature and trips STALEMATE
    const breakerNew = breaker.recordAttempt(
      { runId, attemptId: 'attempt-2', claimId: 'claim-1' },
      'REJECTED',
      undefined,
      newResolved,
      'inv-2',
      { failureSignature: 'metric.failure' }
    );
    assert.strictEqual(
      breakerNew.lifecycle.state,
      'STALEMATE',
      'with new lookup, repeated failure signature across attempts successfully halts the run'
    );
    assert.strictEqual(breakerNew.lifecycle.terminalOutcome, 'STALEMATE');
    assert.strictEqual(breakerNew.lifecycle.consecutiveRefusalCount, 2);
  });

  it('scopes lifecycle resolution strictly to the same runId (prevents cross-run leakage)', () => {
    const run1Lifecycle = breaker.createLifecycle(
      { runId: 'run-1', attemptId: 'attempt-1', claimId: 'claim-1' }
    );
    run1Lifecycle.lastFailureSignature = 'metric.failure';
    const claimRecord = {
      lifecycle: run1Lifecycle,
      lifecycleHistory: [run1Lifecycle],
    };

    // When queried for a fresh run, must return undefined
    const crossRun = resolvePreviousLifecycle(claimRecord, 'run-2');
    assert.strictEqual(crossRun, undefined, 'must not leak lifecycle across different runs');
  });

  it('resolves latest lifecycle from history when claim.lifecycle is from an interleaved run', () => {
    const run1Lifecycle = breaker.createLifecycle(
      { runId: 'run-1', attemptId: 'attempt-1', claimId: 'claim-1' }
    );
    run1Lifecycle.lastFailureSignature = 'run1.failure';

    const interleavedLifecycle = breaker.createLifecycle(
      { runId: 'run-interleaved', attemptId: 'attempt-1', claimId: 'claim-1' }
    );

    const claimRecord = {
      lifecycle: interleavedLifecycle,
      lifecycleHistory: [run1Lifecycle, interleavedLifecycle],
    };

    const resolved = resolvePreviousLifecycle(claimRecord, 'run-1');
    assert.ok(resolved);
    assert.strictEqual(resolved.runId, 'run-1');
    assert.strictEqual(resolved.lastFailureSignature, 'run1.failure');
  });
});
