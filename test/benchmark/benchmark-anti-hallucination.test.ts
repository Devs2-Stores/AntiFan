import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { VerificationEvaluator } from '../../src/main/verification/verification-evaluator';
import { VerificationClaim, EvidenceSampleBundle } from '../../src/main/verification/verification-contract';
import { IssueRegister } from '../../src/main/session/issue-register';
import { VerificationCircuitBreaker } from '../../src/main/verification/circuit-breaker';

describe('Benchmark F: Anti-Hallucination Barrier & Authority Verification Suite', () => {
  it('Scenario 1: High confidence (0.99) with ZERO proof MUST yield UNVERIFIED or INCONCLUSIVE', () => {
    const claim: VerificationClaim = {
      id: 'claim-hallucination-1',
      claim: 'Mobile checkout button is 100% verified and accessible',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: '.checkout-btn', viewport: 'mobile' },
      proofObligations: [
        { id: 'obl-1', metric: 'element_present:.checkout-btn', expected: true, source: 'deterministic' },
        { id: 'obl-2', metric: 'button_accessible', expected: true, source: 'deterministic' },
      ],
      confidence: 0.99, // Extremely confident assertion by model
    };

    const emptyBundle: EvidenceSampleBundle = {
      claimId: claim.id,
      tabId: 'tab-1',
      documentGeneration: 1,
      samples: [], // Zero proof submitted
    };

    const evalResult = VerificationEvaluator.evaluate(claim, emptyBundle);

    // CRITICAL: Confidence 0.99 MUST NOT grant VERIFIED
    assert.notStrictEqual(evalResult.verdict, 'VERIFIED');
    assert.ok(evalResult.verdict === 'INCONCLUSIVE' || evalResult.verdict === 'UNVERIFIED' || evalResult.verdict === 'REJECTED');
    assert.strictEqual(evalResult.proofProfile.completeness, 'EMPTY');
  });

  it('Scenario 2: Model claims "Navigation menu fixed", but mechanical evidence detects broken transition', () => {
    const issueRegister = IssueRegister.getInstance();
    const issue = issueRegister.record({
      toolName: 'theme.qa',
      errorMessage: 'Mobile drawer menu fails to open on tap',
      errorCode: 'MENU_INOPERATIVE',
      severity: 'P0',
      status: 'OPEN',
    });

    const claim: VerificationClaim = {
      id: 'claim-hallucination-2',
      claim: 'Mobile drawer menu is completely fixed and verified across all devices',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: '.menu-toggle' },
      proofObligations: [
        { id: 'obl-target-exists', metric: 'element_present:.menu-toggle', expected: true, source: 'deterministic' },
        { id: 'obl-nav-effect', metric: 'observable_mutation_effect', expected: 'DRAWER_EXPANDED', critical: true, source: 'deterministic' },
        { id: 'obl-zero-bleed', metric: 'no_layout_overflow_bleed', expected: true, source: 'deterministic' },
      ],
      confidence: 0.98,
    };

    // Simulated failing telemetry from browser port
    const failingBundle: EvidenceSampleBundle = {
      claimId: claim.id,
      tabId: 'tab-1',
      documentGeneration: 2,
      samples: [
        { obligationId: 'obl-target-exists', metric: 'element_present:.menu-toggle', value: true, source: 'deterministic' },
        // Contradiction: Gesture produced zero effect
        { obligationId: 'obl-nav-effect', metric: 'observable_mutation_effect', value: 'NO_OBSERVABLE_EFFECT', source: 'deterministic' },
        // Contradiction: Overflow bleed occurred
        { obligationId: 'obl-zero-bleed', metric: 'no_layout_overflow_bleed', value: false, source: 'deterministic' },
      ],
    };

    const evalResult = VerificationEvaluator.evaluate(claim, failingBundle);

    // Assert Verifier rejects the false claim
    assert.strictEqual(evalResult.verdict, 'REJECTED');
    assert.ok(evalResult.proofProfile.violations.length >= 1);

    // Record verdict in IssueRegister
    const verifRecord = issueRegister.recordVerification({
      id: claim.id,
      claim: claim.claim,
      actor: claim.actor,
      scope: claim.scope,
      proofObligations: claim.proofObligations,
      proofProfile: evalResult.proofProfile,
      verdict: evalResult.verdict,
      linkedIssueId: issue.id,
    });

    assert.strictEqual(verifRecord.verdict, 'REJECTED');

    // Invariant: The linked issue MUST remain OPEN
    const liveIssue = issueRegister.getIssue(issue.id);
    assert.strictEqual(liveIssue?.status, 'OPEN');
    assert.notStrictEqual(liveIssue?.status, 'RESOLVED');
  });

  it('Scenario 3: Genuine proof with passing deterministic metrics transitions claim to VERIFIED', () => {
    const issueRegister = IssueRegister.getInstance();
    const issue = issueRegister.record({
      toolName: 'theme.qa',
      errorMessage: 'Cart modal styling mismatch',
      errorCode: 'STYLE_MISMATCH',
      severity: 'P1',
      status: 'OPEN',
    });

    const claim: VerificationClaim = {
      id: 'claim-truthful-3',
      claim: 'Cart modal background matches design token exactly',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: '.cart-modal' },
      proofObligations: [
        { id: 'obl-bg-color', metric: 'style_computed:backgroundColor', expected: 'rgb(24, 24, 27)', source: 'deterministic' },
        { id: 'obl-border-radius', metric: 'style_computed:borderRadius', expected: '8px', source: 'deterministic' },
      ],
      confidence: 0.85,
    };

    const truthfulBundle: EvidenceSampleBundle = {
      claimId: claim.id,
      tabId: 'tab-1',
      documentGeneration: 3,
      samples: [
        { obligationId: 'obl-bg-color', metric: 'style_computed:backgroundColor', value: 'rgb(24, 24, 27)', source: 'deterministic' },
        { obligationId: 'obl-border-radius', metric: 'style_computed:borderRadius', value: '8px', source: 'deterministic' },
      ],
    };

    const evalResult = VerificationEvaluator.evaluate(claim, truthfulBundle);

    assert.strictEqual(evalResult.verdict, 'VERIFIED');
    assert.strictEqual(evalResult.proofProfile.violations.length, 0);
    assert.strictEqual(evalResult.proofProfile.completeness, 'FULL');

    // Update IssueRegister
    const verifRecord = issueRegister.recordVerification({
      id: claim.id,
      claim: claim.claim,
      actor: claim.actor,
      scope: claim.scope,
      proofObligations: claim.proofObligations,
      proofProfile: evalResult.proofProfile,
      verdict: evalResult.verdict,
      linkedIssueId: issue.id,
    });

    assert.strictEqual(verifRecord.verdict, 'VERIFIED');

    // Issue can now be safely resolved
    issueRegister.resolve(issue.id, 'Verified by deterministic CSS metric check');
    const resolvedIssue = issueRegister.getIssue(issue.id);
    assert.strictEqual(resolvedIssue?.status, 'RESOLVED');
  });
});
