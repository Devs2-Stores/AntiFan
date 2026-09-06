import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  VerificationEvaluator,
} from '../../src/main/verification/verification-evaluator';
import {
  VerificationClaim,
  EvidenceSampleBundle,
} from '../../src/main/verification/verification-contract';
import { ProofTemplateRegistry } from '../../src/main/verification/proof-templates';
import {
  computeStructuralMetrics,
  normalizeVisualRegions,
  type RawElementSensoryData,
} from '../../src/main/verification/visual-region';
import {
  generateVisualMetricSamples,
  createVisualEvidenceReceipt,
} from '../../src/main/verification/visual-capture';
import { IssueRegister } from '../../src/main/session/issue-register';
import { StorageLocations } from '../../src/main/config/storage-locations';

const originalDataRoot = process.env.ANTIFAN_DATA_ROOT;
const issueRegisterDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-verification-evaluator-'));
process.env.ANTIFAN_DATA_ROOT = issueRegisterDataRoot;
StorageLocations.resetCache();

after(() => {
  (IssueRegister as unknown as { instance: IssueRegister | null }).instance = null;
  if (originalDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
  else process.env.ANTIFAN_DATA_ROOT = originalDataRoot;
  StorageLocations.resetCache();
  fs.rmSync(issueRegisterDataRoot, { recursive: true, force: true });
});

describe('Verification Evaluator & Contract Engine Suite (Phase 2)', () => {
  it('rejects stale evidence when documentGeneration is behind target generation', () => {
    const claim: VerificationClaim = {
      id: 'claim-1',
      claim: 'Header is loaded and rendered',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: 'header' },
      proofObligations: [{ id: 'obl-1', metric: 'header.present' }],
      targetGeneration: 3,
    };

    const staleBundle: EvidenceSampleBundle = {
      documentGeneration: 2,
      captureTimestamp: Date.now(),
      samples: [{ metric: 'header.present', actual: true, passed: true }],
    };

    const result = VerificationEvaluator.evaluate(claim, staleBundle);

    assert.strictEqual(result.verdict, 'INCONCLUSIVE');
    assert.strictEqual(result.inconclusiveReason, 'RESAMPLE');
    assert.strictEqual(result.proofProfile.freshness, 'STALE');
    assert.strictEqual(result.proofProfile.violations.length, 1);
  });

  it('rejects verification when a critical proof obligation fails', () => {
    const claim: VerificationClaim = {
      id: 'claim-2',
      claim: 'Checkout button is visible and active',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: '.checkout-btn' },
      proofObligations: [
        { id: 'obl-1', metric: 'button.exists', critical: true },
        { id: 'obl-2', metric: 'button.color', critical: false },
      ],
    };

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [
        { metric: 'button.exists', actual: false, passed: false, message: 'Element not found in DOM' },
        { metric: 'button.color', actual: '#ff0000', passed: true },
      ],
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);

    assert.strictEqual(result.verdict, 'REJECTED');
    assert.strictEqual(result.proofProfile.freshness, 'FRESH');
    assert.ok(result.proofProfile.violations.length >= 1);
    assert.strictEqual(result.proofProfile.violations[0]?.metric, 'button.exists');
  });

  it('downgrades to PARTIAL when obligations are missing from evidence', () => {
    const claim: VerificationClaim = {
      id: 'claim-3',
      claim: 'Product gallery rendered with thumbnail carousel',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [
        { id: 'obl-1', metric: 'main.image', critical: false },
        { id: 'obl-2', metric: 'thumbnails.count', critical: false },
      ],
    };

    const partialBundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [
        { metric: 'main.image', actual: true, passed: true },
      ],
    };

    const result = VerificationEvaluator.evaluate(claim, partialBundle);

    assert.strictEqual(result.verdict, 'PARTIAL');
    assert.strictEqual(result.inconclusiveReason, 'NEED_INPUT');
    assert.strictEqual(result.proofProfile.completeness, 'PARTIAL');
  });

  it('downgrades to PARTIAL when semantic witness reports unconfirmed visual artifacts despite mechanical pass', () => {
    const claim: VerificationClaim = {
      id: 'claim-4',
      claim: 'Responsive mobile drawer menu',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [
        { id: 'obl-1', metric: 'drawer.openClass', critical: false },
      ],
    };

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [
        { metric: 'drawer.openClass', actual: 'is-open', passed: true },
      ],
      semanticWitness: {
        modelConfirmed: false,
        observations: ['Drawer overlay is obstructed by floating promotion modal'],
      },
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);

    assert.strictEqual(result.verdict, 'PARTIAL');
    assert.strictEqual(result.inconclusiveReason, 'NEED_INPUT');
    assert.ok(result.summary.includes('Drawer overlay is obstructed'));
  });

  it('downgrades to PARTIAL when semantic witness is supplied without modelConfirmed: true', () => {
    const claim: VerificationClaim = {
      id: 'claim-4b',
      claim: 'Modal dialog with backdrop blur',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [
        { id: 'obl-1', metric: 'modal.backdrop', critical: false },
      ],
    };

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [
        { metric: 'modal.backdrop', actual: true, passed: true },
      ],
      semanticWitness: {
        // modelConfirmed omitted/undefined
        observations: ['Backdrop blur seems visually active'],
      },
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);

    assert.strictEqual(result.verdict, 'PARTIAL');
    assert.strictEqual(result.inconclusiveReason, 'NEED_INPUT');
    assert.ok(result.summary.includes('did not explicitly confirm'));
  });

  it('certifies VERIFIED when all mechanical obligations pass and witness confirms', () => {
    const claim: VerificationClaim = {
      id: 'claim-5',
      claim: 'Storefront navigation bar',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [
        { id: 'obl-1', metric: 'nav.linksCount', tolerance: 1, critical: true },
      ],
    };

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [
        { metric: 'nav.linksCount', actual: 5, expected: 5, delta: 0, passed: true },
      ],
      semanticWitness: {
        modelConfirmed: true,
        observations: ['Navigation links clearly rendered with proper contrast'],
      },
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);

    assert.strictEqual(result.verdict, 'VERIFIED');
    assert.strictEqual(result.proofProfile.completeness, 'FULL');
    assert.strictEqual(result.proofProfile.passedMetricsCount, 1);
    assert.strictEqual(result.proofProfile.violations.length, 0);
  });

  it('rejects verification when an expected style property mismatches actual computed style', () => {
    const claim: VerificationClaim = {
      id: 'claim-6',
      claim: 'CTA button color is red',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: '.cta' },
      proofObligations: [
        { id: 'obl-1', metric: 'style.color', expected: 'rgb(255, 0, 0)', critical: true },
      ],
    };

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [
        {
          metric: 'style.color',
          actual: 'rgb(0, 128, 0)',
          expected: 'rgb(255, 0, 0)',
          passed: false,
          message: "Style 'color' mismatch: expected 'rgb(255, 0, 0)', got 'rgb(0, 128, 0)'",
        },
      ],
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);

    assert.strictEqual(result.verdict, 'REJECTED');
    assert.strictEqual(result.proofProfile.violations.length, 1);
    assert.strictEqual(result.proofProfile.violations[0]?.metric, 'style.color');
    assert.ok(result.summary.includes('REJECTED'));
  });

  it('records claims in IssueRegister as UNVERIFIED and manages stalemate state transitions', () => {
    const register = IssueRegister.getInstance();

    const record = register.recordVerification({
      claim: 'Test claim for register',
      actor: 'agent',
      scope: { tabId: 'tab-99' },
      proofObligations: [{ id: 'obl-1', metric: 'test.metric' }],
      verdict: 'UNVERIFIED',
    });

    assert.ok(record.id.startsWith('VER-'));
    assert.strictEqual(record.verdict, 'UNVERIFIED');
    assert.strictEqual(record.stalemateState, 'ACTIVE');

    // Query list with filter
    const list = register.listVerifications({ tabId: 'tab-99' });
    assert.ok(list.some((item) => item.id === record.id));

    // Update stalemate state
    const stalemateSuccess = register.updateVerificationStalemate(record.id, 'STALEMATE');
    assert.strictEqual(stalemateSuccess, true);

    const updatedItem = register.getVerification(record.id);
    assert.strictEqual(updatedItem?.stalemateState, 'STALEMATE');

    // Update verdict
    register.updateVerificationVerdict(record.id, 'PARTIAL', undefined, 'NEED_INPUT');
    const verdictItem = register.getVerification(record.id);
    assert.strictEqual(verdictItem?.verdict, 'PARTIAL');
    assert.strictEqual(verdictItem?.inconclusiveReason, 'NEED_INPUT');
  });

  it('rejects zero-obligation claims as INCONCLUSIVE even when non-empty samples are present', () => {
    const claim: VerificationClaim = {
      id: 'claim-zero-obl',
      claim: 'Zero obligation claim attempting bypass',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [], // Empty obligations
    };

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [{ metric: 'dummy.metric', passed: true }],
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);
    assert.strictEqual(result.verdict, 'INCONCLUSIVE');
    assert.strictEqual(result.inconclusiveReason, 'UNOBSERVABLE');
    assert.strictEqual(result.proofProfile.completeness, 'EMPTY');
  });

  it('evaluates delta with tolerance: 0 strictly against non-zero deviations', () => {
    const claim: VerificationClaim = {
      id: 'claim-exact-zero',
      claim: 'Exact section count verification',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [
        { id: 'obl-exact', metric: 'section_count', tolerance: 0 },
      ],
    };

    // Sample with delta 0 passes
    const passBundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [{ metric: 'section_count', delta: 0 }],
    };
    const passResult = VerificationEvaluator.evaluate(claim, passBundle);
    assert.strictEqual(passResult.verdict, 'VERIFIED');

    // Sample with delta 1 fails threshold
    const failBundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [{ metric: 'section_count', delta: 1 }],
    };
    const failResult = VerificationEvaluator.evaluate(claim, failBundle);
    assert.strictEqual(failResult.verdict, 'REJECTED');
    assert.strictEqual(failResult.proofProfile.violations.length, 1);
  });

  it('fails closed when samples carry only metric names without passed, delta, or expected value', () => {
    const claim: VerificationClaim = {
      id: 'claim-vacuous',
      claim: 'Interaction state claim with vacuous telemetry',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [
        { id: 'obl-vacuous-1', metric: 'observable_mutation_effect', critical: true },
      ],
    };

    // Bundle carries metric name only, no passed, no delta, no expected
    const vacuousBundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [{ metric: 'observable_mutation_effect' }],
    };

    const result = VerificationEvaluator.evaluate(claim, vacuousBundle);
    assert.strictEqual(result.verdict, 'REJECTED');
    assert.strictEqual(result.proofProfile.violations.length, 1);
    assert.match(result.proofProfile.violations[0]?.message || '', /failed validation threshold/);
  });

  it('rejects tautological claims where all obligations are purely DOM presence checks (Anti-Gaming)', () => {
    const claim: VerificationClaim = {
      id: 'claim-tautology',
      claim: 'Tautological claim with universal presence obligations',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [
        { id: 'obl-1', metric: 'element_present:html' },
        { id: 'obl-2', metric: 'element_present:body' },
      ],
    };

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [
        { metric: 'element_present:html', actual: true, passed: true },
        { metric: 'element_present:body', actual: true, passed: true },
      ],
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);
    assert.strictEqual(result.verdict, 'REJECTED');
    assert.strictEqual(result.inconclusiveReason, 'UNOBSERVABLE');
    assert.strictEqual(result.proofProfile.completeness, 'EMPTY');
    assert.match(result.summary, /Tautological obligations detected/);
  });

  it('rejects evidence when mutationRevision is behind targetMutationRevision (Mutation Barrier)', () => {
    const claim: VerificationClaim = {
      id: 'claim-mutation',
      claim: 'Interaction state requires post-action mutation',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      targetGeneration: 1,
      targetMutationRevision: 5,
      proofObligations: [
        { id: 'obl-1', metric: 'observable_mutation_effect', critical: true },
      ],
    };

    // Case A: mutationRevision is stale (3 < 5)
    const staleBundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      mutationRevision: 3,
      captureTimestamp: Date.now(),
      samples: [{ metric: 'observable_mutation_effect', actual: true, passed: true }],
    };

    const staleResult = VerificationEvaluator.evaluate(claim, staleBundle);
    assert.strictEqual(staleResult.verdict, 'INCONCLUSIVE');
    assert.strictEqual(staleResult.inconclusiveReason, 'RESAMPLE');
    assert.strictEqual(staleResult.proofProfile.freshness, 'STALE');

    // Case B: mutationRevision is undefined (missing evidence for required barrier)
    const missingBundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: [{ metric: 'observable_mutation_effect', actual: true, passed: true }],
    };

    const missingResult = VerificationEvaluator.evaluate(claim, missingBundle);
    assert.strictEqual(missingResult.verdict, 'INCONCLUSIVE');
    assert.strictEqual(missingResult.inconclusiveReason, 'RESAMPLE');
    assert.strictEqual(missingResult.proofProfile.freshness, 'STALE');

    // Case C: mutationRevision is fresh (5 >= 5)
    const freshBundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      mutationRevision: 5,
      captureTimestamp: Date.now(),
      samples: [{ metric: 'observable_mutation_effect', actual: true, passed: true }],
    };

    const freshResult = VerificationEvaluator.evaluate(claim, freshBundle);
    assert.strictEqual(freshResult.verdict, 'VERIFIED');
    assert.strictEqual(freshResult.proofProfile.freshness, 'FRESH');
  });
});

describe('Visual Parity & Structural Primacy Suite (Phase 5 V-09, V-10)', () => {
  it('V-09: rejects with REJECTED when geometry fails (+100px) even though paint diff is 0% (mask hides child shift)', () => {
    // Claim requires canonical visual parity with structural primacy (Audit v5 §16, §25, Freeze #13/#14)
    const claim: VerificationClaim = {
      id: 'claim-v09',
      claim: 'Header layout maintains exact visual and structural parity with baseline',
      actor: 'agent',
      scope: { tabId: 'tab-target', selector: '.header-container' },
      proofObligations: ProofTemplateRegistry.getVisualTemplate({
        maxMismatchPct: 5.0,
        requireStructuralPrimacy: true,
      }),
      targetGeneration: 1,
    };

    // Child element shift was covered by a mask, so pixel diff is 0.0%
    // BUT the parent moved by +100px, so geometry delta is 100px (tolerance <= 2px)
    const samples = generateVisualMetricSamples({
      diffResult: { match: true, mismatchPercentage: 0.0, dimensionsMatch: true },
      captureStateCompatible: true,
      maskResolutionStatus: 'ok',
      settleComplete: true,
      structural: {
        geometryWithinTolerance: false,
        deltaGeometry: 100,
        cardinalityMatch: true,
        deltaCardinality: 0,
      },
    });

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples,
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);
    assert.strictEqual(result.verdict, 'REJECTED');
    assert.ok(result.summary.includes('violations including critical obligations'));
    const geomViolation = result.proofProfile.violations.find((v) => v.metric === 'visual.geometry_within_tolerance');
    assert.ok(geomViolation, 'Must record critical violation on visual.geometry_within_tolerance');
  });

  it('V-10: rejects with REJECTED when cardinality fails (4->3 items) even though paint diff is 0%', () => {
    const claim: VerificationClaim = {
      id: 'claim-v10',
      claim: 'Product card grid matches baseline visual and structural cardinality',
      actor: 'agent',
      scope: { tabId: 'tab-target', selector: '.product-grid' },
      proofObligations: ProofTemplateRegistry.getVisualTemplate({
        maxMismatchPct: 5.0,
        requireStructuralPrimacy: true,
      }),
      targetGeneration: 1,
    };

    // One item disappeared (4 items -> 3 items), but blank space resulted in 0% diff
    const samples = generateVisualMetricSamples({
      diffResult: { match: true, mismatchPercentage: 0.0, dimensionsMatch: true },
      captureStateCompatible: true,
      maskResolutionStatus: 'ok',
      settleComplete: true,
      structural: {
        geometryWithinTolerance: true,
        deltaGeometry: 0,
        cardinalityMatch: false,
        deltaCardinality: 1,
      },
    });

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples,
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);
    assert.strictEqual(result.verdict, 'REJECTED');
    const cardViolation = result.proofProfile.violations.find((v) => v.metric === 'visual.cardinality_match');
    assert.ok(cardViolation, 'Must record critical violation on visual.cardinality_match');
  });

  it('verifies visual parity when both paint and structural invariants match within tolerance', () => {
    const claim: VerificationClaim = {
      id: 'claim-v-ok',
      claim: 'Footer parity holds visually and structurally',
      actor: 'agent',
      scope: { tabId: 'tab-target', selector: 'footer' },
      proofObligations: ProofTemplateRegistry.getVisualTemplate({
        maxMismatchPct: 5.0,
        requireStructuralPrimacy: true,
      }),
      targetGeneration: 1,
    };

    const samples = generateVisualMetricSamples({
      diffResult: { match: true, mismatchPercentage: 1.5, dimensionsMatch: true },
      captureStateCompatible: true,
      maskResolutionStatus: 'ok',
      settleComplete: true,
      structural: {
        geometryWithinTolerance: true,
        deltaGeometry: 1,
        cardinalityMatch: true,
        deltaCardinality: 0,
      },
    });

    const bundle: EvidenceSampleBundle = {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples,
    };

    const result = VerificationEvaluator.evaluate(claim, bundle);
    assert.strictEqual(result.verdict, 'VERIFIED');
    assert.strictEqual(result.proofProfile.violations.length, 0);
  });

  it('evaluator enforces tolerance boundary on visual.pixel_mismatch_pct without producer passed flag', () => {
    const claim: VerificationClaim = {
      id: 'claim-tol',
      claim: 'Strict tolerance evaluation',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: ProofTemplateRegistry.getVisualTemplate({
        maxMismatchPct: 5.0,
        requireStructuralPrimacy: false,
      }),
      targetGeneration: 1,
    };

    // Sample with 4.8% mismatch (under 5.0% tolerance)
    const passingSamples = generateVisualMetricSamples({
      diffResult: { match: true, mismatchPercentage: 4.8, dimensionsMatch: true },
      captureStateCompatible: true,
      maskResolutionStatus: 'ok',
      settleComplete: true,
    });
    const passResult = VerificationEvaluator.evaluate(claim, {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: passingSamples,
    });
    assert.strictEqual(passResult.verdict, 'VERIFIED');

    // Sample with 5.2% mismatch (exceeds 5.0% tolerance)
    const failingSamples = generateVisualMetricSamples({
      diffResult: { match: false, mismatchPercentage: 5.2, dimensionsMatch: true },
      captureStateCompatible: true,
      maskResolutionStatus: 'ok',
      settleComplete: true,
    });
    const failResult = VerificationEvaluator.evaluate(claim, {
      documentGeneration: 1,
      captureTimestamp: Date.now(),
      samples: failingSamples,
    });
    assert.strictEqual(failResult.verdict, 'REJECTED');
  });

  it('computeStructuralMetrics computes exact geometry shifts and cardinality deltas from normalized regions', () => {
    const rawTarget: RawElementSensoryData[] = [
      {
        ref: 'e1',
        tag: 'div',
        selector: '.parent',
        rect: { x: 0, y: 100, width: 800, height: 200, top: 100, right: 800, bottom: 300, left: 0 },
        visible: true,
      },
      {
        ref: 'e2',
        tag: 'span',
        selector: '.child-1',
        rect: { x: 10, y: 110, width: 100, height: 50, top: 110, right: 110, bottom: 160, left: 10 },
        visible: true,
      },
      {
        ref: 'e3',
        tag: 'span',
        selector: '.child-2',
        rect: { x: 120, y: 110, width: 100, height: 50, top: 110, right: 220, bottom: 160, left: 120 },
        visible: true,
      },
    ];

    const rawBaseline: RawElementSensoryData[] = [
      {
        ref: 'b1',
        tag: 'div',
        selector: '.parent',
        rect: { x: 0, y: 0, width: 800, height: 200, top: 0, right: 800, bottom: 200, left: 0 },
        visible: true,
      },
      {
        ref: 'b2',
        tag: 'span',
        selector: '.child-1',
        rect: { x: 10, y: 10, width: 100, height: 50, top: 10, right: 110, bottom: 60, left: 10 },
        visible: true,
      },
      {
        ref: 'b3',
        tag: 'span',
        selector: '.child-2',
        rect: { x: 120, y: 10, width: 100, height: 50, top: 10, right: 220, bottom: 60, left: 120 },
        visible: true,
      },
      {
        ref: 'b4',
        tag: 'span',
        selector: '.child-3',
        rect: { x: 230, y: 10, width: 100, height: 50, top: 10, right: 330, bottom: 60, left: 230 },
        visible: true,
      },
    ];

    const targetBundle = normalizeVisualRegions(rawTarget, { width: 1200, height: 800 }, 1);
    const baselineBundle = normalizeVisualRegions(rawBaseline, { width: 1200, height: 800 }, 1);

    const metrics = computeStructuralMetrics(targetBundle, baselineBundle);
    assert.strictEqual(metrics.geometryWithinTolerance, false);
    assert.strictEqual(metrics.deltaGeometry, 100);
    assert.strictEqual(metrics.cardinalityMatch, false);
    assert.strictEqual(metrics.deltaCardinality, 1);
    assert.strictEqual(metrics.cardinality.target, 3);
    assert.strictEqual(metrics.cardinality.baseline, 4);
  });
});
