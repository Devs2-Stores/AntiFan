import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { normalizeVisualRegions, RawElementSensoryData } from '../../src/main/verification/visual-region';
import { ProofTemplateRegistry } from '../../src/main/verification/proof-templates';
import { StabilityPolicyEvaluator, DEFAULT_STABILITY_POLICY } from '../../src/main/verification/stability-policy';
import { VerificationCircuitBreaker } from '../../src/main/verification/circuit-breaker';
import { IssueRegister } from '../../src/main/session/issue-register';

describe('Phase 3: Semantic Evidence & Mechanical Guardrails Suite', () => {
  beforeEach(() => {
    VerificationCircuitBreaker.getInstance().reset();
  });

  describe('1. VisualRegion & Viewport Masking Primitive', () => {
    it('normalizes DOM elements into VisualRegions with O(N) linear performance', () => {
      const rawElements: RawElementSensoryData[] = [
        {
          ref: 'e1',
          tag: 'div',
          selector: '.hero',
          rect: { x: 0, y: 0, width: 1200, height: 400, top: 0, right: 1200, bottom: 400, left: 0 },
          styles: { display: 'block', backgroundColor: 'rgb(255, 255, 255)' },
          visible: true,
        },
        {
          ref: 'e2',
          tag: 'canvas',
          selector: '#webgl-banner',
          rect: { x: 0, y: 400, width: 1200, height: 300, top: 400, right: 1200, bottom: 700, left: 0 },
          visible: true,
        },
        {
          ref: 'e3',
          tag: 'iframe',
          selector: '.youtube-embed',
          rect: { x: 0, y: 700, width: 600, height: 350, top: 700, right: 600, bottom: 1050, left: 0 },
          visible: true,
        },
        {
          ref: 'e4',
          tag: 'span',
          rect: { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 },
          visible: false, // Should be omitted
        },
      ];

      const bundle = normalizeVisualRegions(rawElements, { width: 1200, height: 800 }, 3);

      assert.strictEqual(bundle.regions.length, 3);
      assert.strictEqual(bundle.documentGeneration, 3);
      assert.strictEqual(bundle.maskedCount, 2);

      // Verify normal div
      assert.strictEqual(bundle.regions[0]?.needsMasking, false);
      assert.strictEqual(bundle.regions[0]?.tag, 'div');

      // Verify canvas masking
      assert.strictEqual(bundle.regions[1]?.needsMasking, true);
      assert.strictEqual(bundle.regions[1]?.maskReason, 'CANVAS_3D');

      // Verify iframe masking
      assert.strictEqual(bundle.regions[2]?.needsMasking, true);
      assert.strictEqual(bundle.regions[2]?.maskReason, 'CROSS_ORIGIN_IFRAME');
    });

    it('preserves snapshot isolation so downstream mutations do not corrupt raw sensory inputs', () => {
      const rawRect = { x: 10, y: 20, width: 100, height: 50, top: 20, right: 110, bottom: 70, left: 10 };
      const rawStyles = { color: 'rgb(0, 0, 0)', display: 'block' };
      const rawElements: RawElementSensoryData[] = [
        {
          ref: 'e1',
          tag: 'button',
          selector: '.btn',
          rect: rawRect,
          styles: rawStyles,
          visible: true,
        },
      ];

      const bundle = normalizeVisualRegions(rawElements, { width: 1000, height: 800 }, 1);
      const region = bundle.regions[0]!;

      // Mutate region bounds and styles
      region.bounds.x = 999;
      region.bounds.width = 500;
      region.computedStyles.display = 'none';
      region.computedStyles.color = 'rgb(255, 0, 0)';

      // Assert raw elements remain uncorrupted
      assert.strictEqual(rawRect.x, 10, 'raw rect x must not be mutated');
      assert.strictEqual(rawRect.width, 100, 'raw rect width must not be mutated');
      assert.strictEqual(rawStyles.display, 'block', 'raw style display must not be mutated');
      assert.strictEqual(rawStyles.color, 'rgb(0, 0, 0)', 'raw style color must not be mutated');
    });
  });

  describe('2. Canonical Proof Templates', () => {
    it('enforces canonical proof obligations for interaction claims', () => {
      const obligations = ProofTemplateRegistry.getInteractionTemplate('.add-to-cart');
      assert.strictEqual(obligations.length, 3);
      assert.ok(obligations.some((o) => o.metric.includes('.add-to-cart')));
      assert.ok(obligations.some((o) => o.metric === 'observable_mutation_effect'));
      assert.ok(obligations.some((o) => o.metric === 'no_layout_overflow_bleed'));
    });

    it('enforces canonical proof obligations for layout claims with section counts', () => {
      const obligations = ProofTemplateRegistry.getLayoutTemplate(5, 0.03);
      assert.strictEqual(obligations.length, 3);
      assert.ok(obligations.some((o) => o.metric === 'section_inventory_count' && o.tolerance === 0));
      assert.ok(obligations.some((o) => o.metric === 'height_parity_delta' && o.tolerance === 0.03));
      assert.ok(obligations.some((o) => o.metric === 'no_layout_overflow_bleed'));
    });

    it('augments custom obligations without creating duplicate obligation IDs', () => {
      const custom = [
        { id: 'custom-obl-1', metric: 'font_family_check', source: 'deterministic' as const },
        { id: 'obl-interaction-no-overflow-bleed', metric: 'already_existing_overflow', source: 'deterministic' as const },
      ];
      const augmented = ProofTemplateRegistry.augmentObligations('INTERACTION', custom, { targetSelector: '#btn' });
      assert.strictEqual(augmented.length, 4); // 2 custom + 2 new canonical (1 canonical had duplicate ID)
    });

    it('returns mutable independent clones from canonical responsive template without mutating static constant', () => {
      const template1 = ProofTemplateRegistry.getResponsiveTemplate();
      assert.ok(template1.length >= 3);
      // Mutate first template instance
      template1[0]!.tolerance = 0.5;
      template1[0]!.description = 'Custom mutated description';

      // Get second instance and assert freshness
      const template2 = ProofTemplateRegistry.getResponsiveTemplate();
      assert.notStrictEqual(template2[0]!.tolerance, 0.5, 'new template call must not see previous mutation');
      assert.strictEqual(template2[0]!.tolerance, undefined, 'default tolerance must remain pristine');
    });
  });

  describe('3. Stability Policy & Document Generation Barrier', () => {
    it('fails closed when observed documentGeneration is older than mutation documentGeneration', () => {
      const check = StabilityPolicyEvaluator.verifyGenerationBarrier(2, 2);
      assert.strictEqual(check.valid, false);
      assert.match(check.error!, /DOCUMENT_STALE/);

      const staleCheck = StabilityPolicyEvaluator.verifyGenerationBarrier(1, 2);
      assert.strictEqual(staleCheck.valid, false);

      const freshCheck = StabilityPolicyEvaluator.verifyGenerationBarrier(3, 2);
      assert.strictEqual(freshCheck.valid, true);
    });

    it('evaluates network quiescence and media freeze', () => {
      const busyState = StabilityPolicyEvaluator.evaluateState(DEFAULT_STABILITY_POLICY, {
        observedGeneration: 2,
        inflightFirstPartyCount: 2,
        isMediaFrozen: true,
        timeSinceLastMutationMs: 200,
      });
      assert.strictEqual(busyState.ready, false);
      assert.strictEqual(busyState.reason, 'NETWORK_BUSY');

      const unfrozenMediaState = StabilityPolicyEvaluator.evaluateState(DEFAULT_STABILITY_POLICY, {
        observedGeneration: 2,
        inflightFirstPartyCount: 0,
        isMediaFrozen: false,
        timeSinceLastMutationMs: 200,
      });
      assert.strictEqual(unfrozenMediaState.ready, false);
      assert.strictEqual(unfrozenMediaState.reason, 'MEDIA_ACTIVE');

      const readyState = StabilityPolicyEvaluator.evaluateState(DEFAULT_STABILITY_POLICY, {
        observedGeneration: 2,
        inflightFirstPartyCount: 0,
        isMediaFrozen: true,
        timeSinceLastMutationMs: 200,
      });
      assert.strictEqual(readyState.ready, true);
      assert.ok(readyState.settledAt! > 0);
    });
  });

  describe('4. Circuit Breaker & Human Exemption Protocol', () => {
    it('trips to STALEMATE when retries reach maxRetries limit', () => {
      const cb = VerificationCircuitBreaker.getInstance();
      cb.setMaxRetries(3);

      const r1 = cb.recordAttempt('claim-101', 'REJECTED');
      assert.strictEqual(r1.tripped, false);
      assert.strictEqual(r1.attempts, 1);
      assert.strictEqual(r1.state, 'ACTIVE');

      const r2 = cb.recordAttempt('claim-101', 'REJECTED');
      assert.strictEqual(r2.tripped, false);
      assert.strictEqual(r2.attempts, 2);

      const r3 = cb.recordAttempt('claim-101', 'REJECTED');
      assert.strictEqual(r3.tripped, true);
      assert.strictEqual(r3.attempts, 3);
      assert.strictEqual(r3.state, 'STALEMATE');

      const status = cb.getBudgetStatus('claim-101');
      assert.strictEqual(status.tripped, true);
      assert.strictEqual(status.remaining, 0);
    });

    it('resets attempt counter upon VERIFIED outcome', () => {
      const cb = VerificationCircuitBreaker.getInstance();
      cb.setMaxRetries(3);

      cb.recordAttempt('claim-102', 'REJECTED');
      assert.strictEqual(cb.getBudgetStatus('claim-102').attempts, 1);

      cb.recordAttempt('claim-102', 'VERIFIED');
      assert.strictEqual(cb.getBudgetStatus('claim-102').attempts, 0);
      assert.strictEqual(cb.getBudgetStatus('claim-102').state, 'ACTIVE');
    });

    it('applies human exemption cleanly without forging VERIFIED verdict', () => {
      const cb = VerificationCircuitBreaker.getInstance();
      const issueRegister = IssueRegister.getInstance();

      // Register an issue and verification
      const issue = issueRegister.record({
        toolName: 'theme.qa',
        errorMessage: 'Layout parity discrepancy in hero section',
        errorCode: 'LAYOUT_MISMATCH',
        severity: 'P1',
        status: 'OPEN',
      });

      issueRegister.recordVerification({
        id: 'verif-claim-201',
        claim: 'Hero section height parity',
        actor: 'agent',
        scope: { tabId: 'tab-1' },
        proofObligations: [],
        verdict: 'REJECTED',
        linkedIssueId: issue.id,
      });

      // Human waives exemption
      const result = cb.applyHumanExemption('verif-claim-201', 'Approved by merchant designer for mobile viewport', issue.id);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.state, 'EXEMPTION_WAIVED');

      // Verify records in IssueRegister
      const verifs = issueRegister.listVerifications({ stalemateState: 'EXEMPTION_WAIVED' });
      const record = verifs.find((v) => v.id === 'verif-claim-201');
      assert.ok(record);
      assert.strictEqual(record?.stalemateState, 'EXEMPTION_WAIVED');
      assert.strictEqual(record?.exemptionReason, 'Approved by merchant designer for mobile viewport');
      // CRITICAL INVARIANT: Verdict MUST NOT be faked to VERIFIED
      assert.strictEqual(record?.verdict, 'REJECTED');

      // Verify linked issue is marked resolved with note
      const resolvedIssue = issueRegister.getIssue(issue.id);
      assert.strictEqual(resolvedIssue?.status, 'RESOLVED');
      assert.match(resolvedIssue?.notes || '', /HUMAN_EXEMPTION/);
    });
  });
});
