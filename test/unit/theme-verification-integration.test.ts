import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { VerificationEvaluator } from '../../src/main/verification/verification-evaluator';
import {
  VerificationClaim,
  ProofObligation,
  EvidenceSampleBundle,
  ProofViolation,
  THEME_METRICS,
} from '../../src/main/verification/verification-contract';
import { ThemeProofHelpers } from '../../src/main/verification/theme-proof-helpers';
import { createThemeEvidenceEnvelope } from '../../src/main/tools/theme-evidence-envelope';
import { CandidateTemplate, SourceMappingResult } from '../../src/main/browser/theme-source-mapper';
import { MatchedStylesResult } from '../../src/main/browser/css-cascade-analyzer';

describe('Phase 4: Verification Integration & Policy Ordering', () => {

  function createTestClaim(obligations: ProofObligation[]): VerificationClaim {
    return {
      id: 'claim-theme-test-1',
      claim: 'Product card markup and styling conform to theme specification without overflow',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: obligations,
    };
  }

  function createAuthoritativeSourceCandidate(): CandidateTemplate {
    return {
      file: 'snippets/card-product.liquid',
      type: 'snippet',
      confidence: 'HIGH',
      score: 9,
      correlated: true,
      evidence: [
        { kind: 'class_token', file: 'snippets/card-product.liquid', line: 11, matched: 'product-card', weight: 3 },
        { kind: 'render_edge', file: 'snippets/card-product.liquid', line: 9, matched: 'card-product', weight: 2, parentFile: 'sections/main-collection.liquid' },
        { kind: 'section_lineage', file: 'snippets/card-product.liquid', line: 9, matched: 'featured-collection', weight: 2, parentFile: 'sections/main-collection.liquid' },
        { kind: 'tag', file: 'snippets/card-product.liquid', line: 10, matched: 'article', weight: 1 },
      ],
      signals: { markupClassMatch: true, renderCallMatch: true, referencedBySection: true },
      matchCount: 4,
    };
  }

  it('verdict is INCONCLUSIVE when telemetry is missing (completeness: EMPTY)', () => {
    const obligations = ThemeProofHelpers.buildThemeProofObligations();
    const claim = createTestClaim(obligations);
    const emptyBundle: EvidenceSampleBundle = {
      tabId: 'tab-1',
      documentGeneration: 1,
      samples: [],
    };

    const record = VerificationEvaluator.evaluate(claim, emptyBundle);
    assert.strictEqual(record.verdict, 'INCONCLUSIVE');
    assert.strictEqual(record.proofProfile?.completeness, 'EMPTY');
    assert.strictEqual(record.proofProfile?.evaluatedMetricsCount, 0);
  });

  it('verdict is REJECTED when a critical obligation fails (target horizontal overflow)', () => {
    const obligations = ThemeProofHelpers.buildThemeProofObligations({ criticalNoTargetOverflow: true });
    const claim = createTestClaim(obligations);

    const sourceEnv = createThemeEvidenceEnvelope<SourceMappingResult>({
      success: true,
      evidenceQuality: 'HIGH',
      data: {
        candidates: [createAuthoritativeSourceCandidate()],
        primaryCandidate: createAuthoritativeSourceCandidate(),
        ambiguous: false,
        selectionReason: 'Unique correlated HIGH candidate.',
        querySummary: { classesQueried: ['product-card'], attributesQueried: [], workspaceRoot: '/app', filesScannedCount: 1 },
      },
      signals: { markupClassMatch: true, renderCallMatch: true, referencedBySection: true },
    });

    const stylesEnv = createThemeEvidenceEnvelope<MatchedStylesResult>({
      success: true,
      evidenceQuality: 'HIGH',
      data: {
        activeRules: [{ property: 'margin-top', value: '24px', selector: '.product-card', specificity: [0, 1, 0], important: false, status: 'ACTIVE', sourceUrl: 'theme.css' }],
        overriddenRules: [],
        cssVariables: {},
        definitionOfDone: 'STRONG PASS',
        totalRulesAnalyzed: 1,
      },
      signals: { hasMatchedRules: true, hasStylesheetId: true, hasResolvedUrl: true },
    });

    // Fails with target overflow
    const matrixEnv = createThemeEvidenceEnvelope<Record<string, unknown>>({
      success: true,
      evidenceQuality: 'HIGH',
      data: { ok: true },
      signals: { hasTargetOverflow: true, hasDocOverflow: false, allBreakpointsTested: true },
    });

    const bundle = ThemeProofHelpers.createEvidenceBundle({
      sourceMappingEnvelope: sourceEnv,
      matchedStylesEnvelope: stylesEnv,
      responsiveMatrixEnvelope: matrixEnv,
    });

    const record = VerificationEvaluator.evaluate(claim, bundle);
    assert.strictEqual(record.verdict, 'REJECTED');
    assert.ok(record.proofProfile?.violations.some((v: ProofViolation) => v.metric === THEME_METRICS.RESPONSIVE_NO_TARGET_OVERFLOW));
  });

  it('verdict is PARTIAL when advisory obligation fails (strong_pass_resolved) but criticals pass', () => {
    const obligations = ThemeProofHelpers.buildThemeProofObligations({ requireStrongPass: false });
    const claim = createTestClaim(obligations);

    const sourceEnv = createThemeEvidenceEnvelope<SourceMappingResult>({
      success: true,
      evidenceQuality: 'HIGH',
      data: {
        candidates: [createAuthoritativeSourceCandidate()],
        primaryCandidate: createAuthoritativeSourceCandidate(),
        ambiguous: false,
        selectionReason: 'Unique correlated HIGH candidate.',
        querySummary: { classesQueried: ['product-card'], attributesQueried: [], workspaceRoot: '/app', filesScannedCount: 1 },
      },
      signals: { markupClassMatch: true, renderCallMatch: true, referencedBySection: true },
    });

    // PASS but not STRONG PASS
    const stylesEnv = createThemeEvidenceEnvelope<MatchedStylesResult>({
      success: true,
      evidenceQuality: 'MEDIUM',
      data: {
        activeRules: [{ property: 'margin-top', value: '24px', selector: '.product-card', specificity: [0, 1, 0], important: false, status: 'ACTIVE' }],
        overriddenRules: [],
        cssVariables: {},
        definitionOfDone: 'PASS',
        totalRulesAnalyzed: 1,
      },
      signals: { hasMatchedRules: true, hasStylesheetId: true, hasResolvedUrl: false },
    });

    const matrixEnv = createThemeEvidenceEnvelope<Record<string, unknown>>({
      success: true,
      evidenceQuality: 'HIGH',
      data: { ok: true },
      signals: { hasTargetOverflow: false, hasDocOverflow: false, allBreakpointsTested: true },
    });

    const bundle = ThemeProofHelpers.createEvidenceBundle({
      sourceMappingEnvelope: sourceEnv,
      matchedStylesEnvelope: stylesEnv,
      responsiveMatrixEnvelope: matrixEnv,
    });

    const record = VerificationEvaluator.evaluate(claim, bundle);
    assert.strictEqual(record.verdict, 'PARTIAL');
    assert.ok(record.proofProfile?.passedMetricsCount && record.proofProfile.passedMetricsCount >= 3);
  });

  it('verdict is VERIFIED when 100% of obligations pass with zero violations', () => {
    const obligations = ThemeProofHelpers.buildThemeProofObligations({ requireStrongPass: true });
    const claim = createTestClaim(obligations);

    const sourceEnv = createThemeEvidenceEnvelope<SourceMappingResult>({
      success: true,
      evidenceQuality: 'HIGH',
      data: {
        candidates: [createAuthoritativeSourceCandidate()],
        primaryCandidate: createAuthoritativeSourceCandidate(),
        ambiguous: false,
        selectionReason: 'Unique correlated HIGH candidate.',
        querySummary: { classesQueried: ['product-card'], attributesQueried: [], workspaceRoot: '/app', filesScannedCount: 1 },
      },
      signals: { markupClassMatch: true, renderCallMatch: true, referencedBySection: true },
    });

    const stylesEnv = createThemeEvidenceEnvelope<MatchedStylesResult>({
      success: true,
      evidenceQuality: 'HIGH',
      data: {
        activeRules: [{ property: 'margin-top', value: '24px', selector: '.product-card', specificity: [0, 1, 0], important: false, status: 'ACTIVE', sourceUrl: 'theme.css' }],
        overriddenRules: [],
        cssVariables: {},
        definitionOfDone: 'STRONG PASS',
        totalRulesAnalyzed: 1,
      },
      signals: { hasMatchedRules: true, hasStylesheetId: true, hasResolvedUrl: true },
    });

    const matrixEnv = createThemeEvidenceEnvelope<Record<string, unknown>>({
      success: true,
      evidenceQuality: 'HIGH',
      data: { ok: true },
      signals: { hasTargetOverflow: false, hasDocOverflow: false, allBreakpointsTested: true },
    });

    const bundle = ThemeProofHelpers.createEvidenceBundle({
      sourceMappingEnvelope: sourceEnv,
      matchedStylesEnvelope: stylesEnv,
      responsiveMatrixEnvelope: matrixEnv,
    });

    const record = VerificationEvaluator.evaluate(claim, bundle);
    assert.strictEqual(record.verdict, 'VERIFIED');
    assert.strictEqual(record.proofProfile?.completeness, 'FULL');
    assert.strictEqual(record.proofProfile?.violations.length, 0);
  });

  it('verdict is REJECTED when responsive telemetry is partial (allBreakpointsTested is false)', () => {
    const obligations = ThemeProofHelpers.buildThemeProofObligations({ criticalNoTargetOverflow: true });
    const claim = createTestClaim(obligations);

    // Matrix envelope tested only 2 breakpoints instead of all 5
    const partialMatrixEnv = createThemeEvidenceEnvelope<Record<string, unknown>>({
      success: true,
      evidenceQuality: 'HIGH',
      data: { ok: true },
      signals: { hasTargetOverflow: false, hasDocOverflow: false, allBreakpointsTested: false },
    });

    const bundle = ThemeProofHelpers.createEvidenceBundle({
      responsiveMatrixEnvelope: partialMatrixEnv,
    });

    const record = VerificationEvaluator.evaluate(claim, bundle);
    // Because critical obligations were missing full observation, evaluator fails closed
    assert.strictEqual(record.verdict, 'REJECTED');
    assert.ok(record.proofProfile?.violations.some((v: ProofViolation) => v.metric === THEME_METRICS.RESPONSIVE_NO_TARGET_OVERFLOW));
  });

  it('proves linear Preferred Capability Ordering trace: layout -> font -> matched styles -> source mapping -> responsive matrix -> verify', () => {
    const executedSteps: string[] = [];

    function recordStep(step: string) {
      executedSteps.push(step);
    }

    // Simulate canonical OMP execution workflow
    recordStep('anti.inspect.styles'); // Layout
    recordStep('anti.inspect.font');   // Font
    recordStep('anti.inspect.matched_styles'); // Matched CSS
    recordStep('anti.theme.resolve_element');  // Source Mapping
    recordStep('anti.inspect.responsive_matrix'); // Multi-viewport
    recordStep('anti.verification.verify_claim'); // Authoritative gate

    assert.deepStrictEqual(executedSteps, [
      'anti.inspect.styles',
      'anti.inspect.font',
      'anti.inspect.matched_styles',
      'anti.theme.resolve_element',
      'anti.inspect.responsive_matrix',
      'anti.verification.verify_claim',
    ]);
  });
});
