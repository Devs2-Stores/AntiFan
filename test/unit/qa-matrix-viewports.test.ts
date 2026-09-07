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

  it('marks unmeasured viewports explicitly when no baseline visual comparison is provided', () => {
    const matrix = ThemeQaWorkflow.computeQaMatrix(defaultSummary, defaultChecklist);

    assert.strictEqual(matrix.viewports.desktop.measured, false);
    assert.strictEqual(matrix.viewports.desktop.mismatchPercent, null);
    assert.strictEqual(matrix.viewports.desktop.passed, true);

    assert.strictEqual(matrix.viewports.tablet.measured, false);
    assert.strictEqual(matrix.viewports.tablet.mismatchPercent, null);

    assert.strictEqual(matrix.viewports.mobile.measured, false);
    assert.strictEqual(matrix.viewports.mobile.mismatchPercent, null);

    assert.ok(matrix.dimensions.visualFidelity.details.includes('Visual diff unmeasured'));
    assert.ok(matrix.dimensions.responsiveParity.details.includes('Responsive viewports unmeasured'));
    assert.strictEqual(matrix.passed, true);
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

    assert.strictEqual(matrix.viewports.tablet.measured, true);
    assert.strictEqual(matrix.viewports.tablet.mismatchPercent, 3.2);

    assert.strictEqual(matrix.viewports.mobile.measured, true);
    assert.strictEqual(matrix.viewports.mobile.mismatchPercent, 12.0);
    assert.strictEqual(matrix.viewports.mobile.passed, false);

    assert.strictEqual(matrix.passed, false, 'Overall passed must be false when mobile viewport failed');
    assert.strictEqual(matrix.dimensions.visualFidelity.details, 'Desktop diff: 1.5%, threshold < 10%');
    assert.strictEqual(matrix.dimensions.responsiveParity.details, 'Tablet diff: 3.2%, Mobile diff: 12%');
  });
});
