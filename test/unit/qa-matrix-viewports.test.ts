import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';

describe('ThemeQaWorkflow.computeQaMatrix Viewports Contract', () => {
  const defaultSummary = { passed: true, totalIssues: 0, criticalCount: 0 };
  const defaultChecklist = {
    layout: true,
    responsive: true,
    overflow: true,
    interactions: true,
    diagnostics: true,
    liquidClean: true,
    assetsValid: true,
    hsCompliant: true,
  };

  it('marks unmeasured viewports explicitly as inconclusive with passed:false when no baseline visual comparison is provided', () => {
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, defaultChecklist);

    assert.strictEqual(matrix.viewports.desktop.measured, false);
    assert.strictEqual(matrix.viewports.desktop.mismatchPercent, null);
    assert.strictEqual(matrix.viewports.desktop.passed, false);
    assert.strictEqual(matrix.viewports.desktop.verdict, 'INCONCLUSIVE');

    assert.strictEqual(matrix.viewports.tablet.measured, false);
    assert.strictEqual(matrix.viewports.tablet.mismatchPercent, null);
    assert.strictEqual(matrix.viewports.tablet.passed, false);
    assert.strictEqual(matrix.viewports.tablet.verdict, 'INCONCLUSIVE');

    assert.strictEqual(matrix.viewports.mobile.measured, false);
    assert.strictEqual(matrix.viewports.mobile.mismatchPercent, null);
    assert.strictEqual(matrix.viewports.mobile.passed, false);
    assert.strictEqual(matrix.viewports.mobile.verdict, 'INCONCLUSIVE');

    assert.strictEqual(matrix.dimensions.visualFidelity.score, null);
    assert.strictEqual(matrix.dimensions.responsiveParity.score, null);
    assert.ok(matrix.dimensions.visualFidelity.details.includes('Visual diff unmeasured'));
    assert.ok(matrix.dimensions.responsiveParity.details.includes('Responsive viewports unmeasured'));
    assert.strictEqual(matrix.passed, false, 'Unmeasured viewports must fail closed (INCONCLUSIVE)');
    assert.strictEqual(matrix.verdict, 'INCONCLUSIVE');
  });

  it('uses real measured viewports when provided and computes fidelity scores accordingly', () => {
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, defaultChecklist, undefined, {
      desktop: { mismatchPercent: 1.5, passed: true },
      tablet: { mismatchPercent: 3.2, passed: true },
      mobile: { mismatchPercent: 12.0, passed: false },
    });

    assert.strictEqual(matrix.viewports.desktop.measured, true);
    assert.strictEqual(matrix.viewports.desktop.mismatchPercent, 1.5);
    assert.strictEqual(matrix.viewports.desktop.passed, true);
    assert.strictEqual(matrix.viewports.desktop.verdict, 'PASS');

    assert.strictEqual(matrix.viewports.tablet.measured, true);
    assert.strictEqual(matrix.viewports.tablet.mismatchPercent, 3.2);
    assert.strictEqual(matrix.viewports.tablet.passed, true);
    assert.strictEqual(matrix.viewports.tablet.verdict, 'PASS');

    assert.strictEqual(matrix.viewports.mobile.measured, true);
    assert.strictEqual(matrix.viewports.mobile.mismatchPercent, 12.0);
    assert.strictEqual(matrix.viewports.mobile.passed, false);
    assert.strictEqual(matrix.viewports.mobile.verdict, 'FAIL');

    assert.strictEqual(matrix.passed, false, 'Overall passed must be false when mobile viewport failed');
    assert.strictEqual(matrix.verdict, 'FAIL');
    assert.strictEqual(matrix.dimensions.visualFidelity.details, 'Desktop diff: 1.5%, threshold < 10%');
    assert.strictEqual(matrix.dimensions.responsiveParity.details, 'Tablet diff: 3.2%, Mobile diff: 12%');
  });

  it('rejects invalid mismatchPercent values (null, NaN, infinite, out-of-range) and prevents caller passed:true overrides', () => {
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, defaultChecklist, undefined, {
      desktop: { mismatchPercent: NaN, passed: true },
      tablet: { mismatchPercent: Infinity, passed: true },
      mobile: { mismatchPercent: -5, passed: true },
    });

    assert.strictEqual(matrix.viewports.desktop.measured, false);
    assert.strictEqual(matrix.viewports.desktop.mismatchPercent, null);
    assert.strictEqual(matrix.viewports.desktop.passed, false);
    assert.strictEqual(matrix.viewports.desktop.verdict, 'INCONCLUSIVE');

    assert.strictEqual(matrix.viewports.tablet.measured, false);
    assert.strictEqual(matrix.viewports.tablet.mismatchPercent, null);
    assert.strictEqual(matrix.viewports.tablet.passed, false);
    assert.strictEqual(matrix.viewports.tablet.verdict, 'INCONCLUSIVE');

    assert.strictEqual(matrix.viewports.mobile.measured, false);
    assert.strictEqual(matrix.viewports.mobile.mismatchPercent, null);
    assert.strictEqual(matrix.viewports.mobile.passed, false);
    assert.strictEqual(matrix.viewports.mobile.verdict, 'INCONCLUSIVE');

    assert.strictEqual(matrix.passed, false, 'Caller passed:true must not override invalid measurements');
    assert.strictEqual(matrix.verdict, 'INCONCLUSIVE');
  });

  it('handles partial coverage: single measured viewport cannot pass matrix (inconclusive)', () => {
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, defaultChecklist, undefined, {
      desktop: { mismatchPercent: 1.5, passed: true },
    });

    assert.strictEqual(matrix.viewports.desktop.measured, true);
    assert.strictEqual(matrix.viewports.desktop.passed, true);
    assert.strictEqual(matrix.viewports.tablet.measured, false);
    assert.strictEqual(matrix.viewports.mobile.measured, false);

    assert.strictEqual(matrix.dimensions.visualFidelity.score, 85);
    assert.strictEqual(matrix.dimensions.responsiveParity.score, null);
    assert.strictEqual(matrix.coverage?.measuredViewports, 1);
    assert.strictEqual(matrix.coverage?.totalViewports, 3);
    assert.strictEqual(matrix.passed, false);
    assert.strictEqual(matrix.verdict, 'INCONCLUSIVE');
  });

  it('certifies genuine all-case pass when all viewports and summary pass', () => {
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, defaultChecklist, undefined, {
      desktop: { mismatchPercent: 1.5, passed: true },
      tablet: { mismatchPercent: 2.0, passed: true },
      mobile: { mismatchPercent: 3.0, passed: true },
    });

    assert.strictEqual(matrix.viewports.desktop.passed, true);
    assert.strictEqual(matrix.viewports.tablet.passed, true);
    assert.strictEqual(matrix.viewports.mobile.passed, true);
    assert.strictEqual(matrix.passed, true);
    assert.strictEqual(matrix.verdict, 'PASS');
    assert.strictEqual(typeof matrix.overallScore, 'number');
    assert.strictEqual(matrix.coverage?.measuredViewports, 3);
  });

  it('downgrades a caller PASS above the threshold and preserves a caller FAIL below it', () => {
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, defaultChecklist, undefined, {
      desktop: { mismatchPercent: 45, passed: true },
      tablet: { mismatchPercent: 4, passed: false },
      mobile: { mismatchPercent: 12, passed: true },
    });

    assert.strictEqual(matrix.viewports.desktop.passed, false, 'an over-threshold diff cannot be certified by a caller PASS');
    assert.strictEqual(matrix.viewports.desktop.verdict, 'FAIL');
    assert.strictEqual(
      matrix.viewports.tablet.passed,
      false,
      'a caller FAIL under the threshold is a structural parity failure the pixel diff cannot see'
    );
    assert.strictEqual(matrix.viewports.mobile.passed, false);
    assert.strictEqual(matrix.passed, false);
    assert.strictEqual(
      matrix.dimensions.visualFidelity.details,
      'Desktop diff: 45%, threshold < 10%'
    );
  });

  it('sets haravanCompliance score to null and reports unmeasured when liquidClean is absent, never claiming OS 2.0', () => {
    const { liquidClean: _, ...checklistWithoutLiquid } = defaultChecklist;
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, checklistWithoutLiquid);

    assert.strictEqual(matrix.dimensions.haravanCompliance.score, null);
    assert.ok(matrix.dimensions.haravanCompliance.details.includes('unmeasured or unknown'));
    assert.ok(!matrix.dimensions.haravanCompliance.details.includes('Haravan OS 2.0'));
  });

  it('all measured viewports with absent compliance scan must not PASS (yields INCONCLUSIVE)', () => {
    const { liquidClean: _, ...checklistWithoutLiquid } = defaultChecklist;
    const matrix = ThemeQaWorkflow.computeQaMatrix(
      defaultSummary,
      checklistWithoutLiquid as unknown as Parameters<typeof ThemeQaWorkflow.computeQaMatrix>[1],
      undefined,
      {
        desktop: { mismatchPercent: 1.0, passed: true },
        tablet: { mismatchPercent: 2.0, passed: true },
        mobile: { mismatchPercent: 3.0, passed: true },
      }
    );

    assert.strictEqual(matrix.passed, false, 'Must not pass when compliance scan is absent');
    assert.strictEqual(matrix.verdict, 'INCONCLUSIVE');
    assert.strictEqual(matrix.dimensions.haravanCompliance.score, null);
  });

  it('sets haravanCompliance score to 100 when liquidClean is true with scoped scanner certification details', () => {
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, { ...defaultChecklist, liquidClean: true });

    assert.strictEqual(matrix.dimensions.haravanCompliance.score, 100);
    assert.ok(matrix.dimensions.haravanCompliance.details.includes('scanner static/browser checks'));
    assert.ok(matrix.dimensions.haravanCompliance.details.includes('does not certify full Haravan OS 2.0'));
  });

  it('keeps performanceCWV score null without false certification', () => {
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, defaultChecklist);

    assert.strictEqual(matrix.dimensions.performanceCWV.score, null);
    assert.ok(matrix.dimensions.performanceCWV.details.includes('unmeasured'));
    assert.ok(!matrix.dimensions.performanceCWV.details.includes('No render-blocking scripts'));
  });

  it('returns null overallScore when no dimensions are measured', () => {
    const emptyChecklist = {
      layout: undefined as unknown as boolean,
      responsive: undefined as unknown as boolean,
      overflow: undefined as unknown as boolean,
      interactions: undefined as unknown as boolean,
      diagnostics: undefined as unknown as boolean,
    };
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, emptyChecklist);

    assert.strictEqual(matrix.overallScore, null);
    assert.strictEqual(matrix.coverage?.measuredDimensions, 0);
  });
});
