import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ThemeQaWorkflow, type ThemeQaValidateInput, type ThemeQaReport } from '../../src/main/qa/theme-qa-workflow';
import { CaptureError } from '../../src/main/verification/visual-capture';
import { LiquidErrorScanner } from '../../src/main/qa/scanners/liquid-error-scanner';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';
import { createCleanQaPorts, makeCleanTarget } from '../support/clean-qa-ports';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-provenance-workflow-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const RAW_PASS = {
  desktop: { mismatchPercent: 0.4, passed: true },
  tablet: { mismatchPercent: 0.6, passed: true },
  mobile: { mismatchPercent: 0.8, passed: true },
};
const ALL_RECEIPTS = { desktop: 'compare-receipt', tablet: 'compare-receipt', mobile: 'compare-receipt' } as const;

const liquidFinding = { type: 'runtime_error', message: 'Liquid error: internal', selector: 'footer.site-footer' };
const overlapCritical = { kind: 'overlap', severity: 'critical', selector: 'header .nav', details: 'Navigation overlaps the search box' };

interface RunOptions {
  input?: Partial<ThemeQaValidateInput>;
  /** Make the screenshot fail the way a tab the compositor stopped painting does. */
  starve?: boolean;
  liquid?: boolean;
  /** Critical layout finding the active-width integrity scan reports. */
  integrityCritical?: boolean;
  /** Reading the live page returns for the scope containment script; null models a selector the page lacks. */
  containment?: Record<string, boolean> | null;
  /** Critical layout finding reported by the header-band sweep at this width. */
  denseCriticalAt?: number;
}

const run = async (options: RunOptions = {}): Promise<{ report: ThemeQaReport; denseCalls: number }> => {
  const record = createCleanQaPorts({ activeWidth: 1440 });
  const browser = record.ports.browser as unknown as Record<string, unknown>;
  const liquidScript = LiquidErrorScanner.getBrowserScanScript();
  const integrityScript = LayoutIntegrityEngine.getBrowserScanScript('active');
  const baseEval = browser.eval as (target: unknown, script: string) => Promise<unknown>;
  browser.eval = async (target: unknown, script: string) => {
    if (options.liquid && script === liquidScript) return { hasErrors: true, errors: [liquidFinding], scannedElementsCount: 20 };
    if (options.integrityCritical && script === integrityScript) {
      return { measured: true, viewport: { name: 'active', width: 1440, height: 900 }, findings: [overlapCritical], stats: { elements: 10, textRuns: 4, controls: 2, sweepSteps: 1, truncated: false, truncatedReasons: [], failedDetectors: [], durationMs: 3, cls: 0 } };
    }
    if (options.containment !== undefined && script.includes('let target = null;')) return options.containment;
    return baseEval(target, script);
  };
  if (options.starve) {
    browser.screenshot = async () => {
      throw new CaptureError('CAPTURE_FRAME_STARVATION', 'No frame was produced for the tab');
    };
  }
  if (options.denseCriticalAt !== undefined) {
    const baseSweep = browser.responsiveCheck as (params: { customBreakpoints?: unknown[] }) => Promise<{ ok: boolean; breakpoints: Record<string, { width: number; integrity: { findings: unknown[] } }> }>;
    browser.responsiveCheck = async (params: { customBreakpoints?: unknown[] }) => {
      const result = await baseSweep(params);
      const entry = Array.isArray(params?.customBreakpoints) ? result.breakpoints[`w${options.denseCriticalAt}`] : undefined;
      if (entry) entry.integrity.findings = [overlapCritical];
      return result;
    };
  }
  const report = await new ThemeQaWorkflow(record.ports).validate({
    runId: 'run-provenance',
    attemptId: 'att-provenance',
    workspaceRoot: root,
    target: makeCleanTarget(),
    ...options.input,
  });
  return { report, denseCalls: record.denseSweepScripts.length };
};

describe('theme QA baseline provenance', () => {
  it('does not certify numbers the caller typed: STRUCTURAL with BASELINE_NO_PROVENANCE and a remedy', async () => {
    const { report } = await run({ input: { viewports: RAW_PASS } });
    assert.strictEqual(report.summary.certification, 'STRUCTURAL');
    assert.strictEqual(report.summary.certificationBasis, undefined);
    assert.deepStrictEqual(report.summary.baselineProvenance, { desktop: 'caller-asserted', tablet: 'caller-asserted', mobile: 'caller-asserted' });
    const reasons = (report.summary.certificationReasons ?? []).filter((reason) => reason.includes('BASELINE_NO_PROVENANCE'));
    assert.strictEqual(reasons.length, 3, (report.summary.certificationReasons ?? []).join(' | '));
    assert.ok((report.summary.certificationRemedies ?? []).some((remedy) => remedy.tool === 'anti.visual.compare' && remedy.reason.includes('BASELINE_NO_PROVENANCE')));
    assert.strictEqual(report.summary.matrixVerdict, 'PASS', 'the numbers still grade; only the certification is withheld');
  });

  it('certifies a run whose three viewports were read from the compare ledger', async () => {
    const { report } = await run({ input: { viewports: RAW_PASS, viewportProvenance: { ...ALL_RECEIPTS } } });
    assert.strictEqual(report.summary.certification, 'CERTIFIED', (report.summary.certificationReasons ?? []).join(' | '));
    assert.strictEqual(report.summary.certificationBasis, 'baseline');
    assert.strictEqual(report.summary.certificationScope, 'page');
    assert.deepStrictEqual(report.summary.baselineProvenance, ALL_RECEIPTS);
  });

  it('does not certify when only some viewports are receipt-backed', async () => {
    const { report } = await run({ input: { viewports: RAW_PASS, viewportProvenance: { desktop: 'compare-receipt', tablet: 'compare-receipt', mobile: 'caller-asserted' } } });
    assert.strictEqual(report.summary.certification, 'STRUCTURAL');
    const reasons = report.summary.certificationReasons ?? [];
    assert.strictEqual(reasons.filter((reason) => reason.includes('BASELINE_NO_PROVENANCE')).length, 1);
    assert.ok(reasons.some((reason) => reason.includes('mobile baseline numbers are caller-asserted')));
  });

  it('treats a viewport without a provenance entry as caller-asserted', async () => {
    const { report } = await run({ input: { viewports: RAW_PASS, viewportProvenance: { desktop: 'compare-receipt' } } });
    assert.strictEqual(report.summary.certification, 'STRUCTURAL');
    assert.strictEqual(report.summary.baselineProvenance?.tablet, 'caller-asserted');
  });

  it('names every compare receipt the capability layer refused', async () => {
    const { report } = await run({
      input: {
        viewports: { desktop: RAW_PASS.desktop, mobile: RAW_PASS.mobile },
        viewportProvenance: { desktop: 'compare-receipt', mobile: 'compare-receipt' },
        viewportRejections: [{ viewport: 'tablet', code: 'RECEIPT_STALE', detail: 'compare vcmp_1 is 3000 minutes old' }],
      },
    });
    assert.strictEqual(report.summary.certification, 'STRUCTURAL');
    const reasons = report.summary.certificationReasons ?? [];
    assert.ok(reasons.some((reason) => reason.includes('rejected at tablet (RECEIPT_STALE)')), reasons.join(' | '));
    assert.ok(reasons.some((reason) => reason.includes('visual baseline missing at tablet')), reasons.join(' | '));
  });

  it('keeps greenfield certification independent of provenance', async () => {
    const { report } = await run({ input: { greenfield: { reason: 'new theme, no baseline promoted yet' } } });
    assert.strictEqual(report.summary.certification, 'CERTIFIED', (report.summary.certificationReasons ?? []).join(' | '));
    assert.strictEqual(report.summary.certificationBasis, 'greenfield');
    assert.strictEqual(report.summary.baselineProvenance, undefined);
  });
});

describe('theme QA starved capture environment', () => {
  it('reports INCONCLUSIVE with the environment when starvation is the only context for geometry findings', async () => {
    const { report } = await run({ starve: true, integrityCritical: true });
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE', JSON.stringify(report.summary.environment));
    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.environment?.degraded, true);
    assert.strictEqual(report.summary.environment?.code, 'CAPTURE_FRAME_STARVATION');
    assert.ok((report.summary.environment?.suspectCriticalCount ?? 0) >= 1);
    assert.ok(report.summary.criticalCount >= 1, 'the findings stay counted and listed; only the verdict is withheld');
    assert.ok((report.summary.certificationReasons ?? []).some((reason) => reason.includes('environment degraded (CAPTURE_FRAME_STARVATION)')));
    assert.notStrictEqual(report.summary.certification, 'CERTIFIED');
  });

  it('keeps FAIL when a failure that does not depend on rendering is also present', async () => {
    const { report } = await run({ starve: true, integrityCritical: true, liquid: true });
    assert.strictEqual(report.summary.verdict, 'FAIL');
    assert.strictEqual(report.summary.environment, undefined);
  });

  it('keeps FAIL for a liquid error under starvation even without geometry findings', async () => {
    const { report } = await run({ starve: true, liquid: true });
    assert.strictEqual(report.summary.verdict, 'FAIL');
    assert.strictEqual(report.summary.environment, undefined);
  });

  it('does not invent an environment for a failing run on a healthy tab', async () => {
    const { report } = await run({ integrityCritical: true });
    assert.strictEqual(report.summary.verdict, 'FAIL');
    assert.strictEqual(report.summary.environment, undefined);
  });
});

describe('theme QA attribution without a baseline', () => {
  it('lists non-diagnostic findings as unclassified instead of introduced regressions', async () => {
    const { report } = await run({ liquid: true });
    const differential = report.findings?.differential;
    assert.strictEqual(differential?.baselineSupplied, false);
    assert.ok(differential?.unclassifiedFindings?.some((item) => item.category === 'liquid'), JSON.stringify(differential));
    assert.strictEqual(differential?.introducedRegressions.some((item) => item.category === 'liquid'), false);
    assert.strictEqual(differential?.hasRegressions, null);
    assert.ok(report.summary.criticalCount >= 1, 'the finding still counts toward criticalCount');
  });

  it('classifies against a supplied baseline as before', async () => {
    const { report } = await run({ liquid: true, input: { baselineFindings: [] } });
    const differential = report.findings?.differential;
    assert.strictEqual(differential?.baselineSupplied, true);
    assert.ok(differential?.introducedRegressions.some((item) => item.category === 'liquid'));
    assert.strictEqual(differential?.unclassifiedFindings, undefined);
    assert.strictEqual(differential?.hasRegressions, true);
  });

  it('reports a clean run without a baseline as unclassified-free with hasRegressions null', async () => {
    const { report } = await run();
    assert.strictEqual(report.findings?.differential?.hasRegressions, null);
    assert.strictEqual(report.findings?.differential?.unclassifiedFindings, undefined);
  });
});

describe('theme QA declared scope', () => {
  const scoped = { viewports: RAW_PASS, viewportProvenance: { ...ALL_RECEIPTS } };

  it('earns CERTIFIED_SCOPED when everything inside the declared selectors is clean and the page failure is elsewhere', async () => {
    const { report } = await run({ liquid: true, containment: { 'footer.site-footer': false }, input: { ...scoped, scope: { selectors: ['main.product-main'], files: ['sections/product.liquid'] } } });
    assert.strictEqual(report.summary.verdict, 'FAIL');
    assert.strictEqual(report.summary.certification, 'CERTIFIED_SCOPED', (report.summary.certificationReasons ?? []).join(' | '));
    assert.strictEqual(report.summary.certificationScope, 'scoped');
    assert.strictEqual(report.summary.scopedCriticalCount, 0);
    assert.strictEqual(report.summary.pageCriticalCount, 1);
    assert.strictEqual(report.summary.criticalCount, 1, 'the page count is never reduced by a scope');
    assert.ok((report.summary.certificationReasons ?? []).some((reason) => reason.includes('scoped to main.product-main')));
  });

  it('does not scope-certify when a critical finding lies inside the declared selectors', async () => {
    const { report } = await run({ liquid: true, containment: { 'footer.site-footer': true }, input: { ...scoped, scope: { selectors: ['footer.site-footer'] } } });
    assert.strictEqual(report.summary.certification, 'STRUCTURAL');
    assert.strictEqual(report.summary.certificationScope, 'page');
    assert.strictEqual(report.summary.scopedCriticalCount, 1);
  });

  it('does not scope-certify when the page does not contain the declared selector', async () => {
    const { report } = await run({ liquid: true, containment: null, input: { ...scoped, scope: { selectors: ['main.product-main'] } } });
    assert.strictEqual(report.summary.certification, 'STRUCTURAL');
    assert.strictEqual(report.summary.scopedCriticalCount, null);
    assert.ok((report.summary.certificationReasons ?? []).some((reason) => reason.includes('scope selector not found on the live page: main.product-main')));
  });

  it('never scope-certifies on caller-asserted baseline numbers', async () => {
    const { report } = await run({ liquid: true, containment: { 'footer.site-footer': false }, input: { viewports: RAW_PASS, scope: { selectors: ['main.product-main'] } } });
    assert.strictEqual(report.summary.certification, 'STRUCTURAL');
    assert.strictEqual(report.summary.certificationScope, 'page');
  });

  it('never scope-certifies a degraded run', async () => {
    const { report } = await run({ starve: true, liquid: true, containment: { 'footer.site-footer': false }, input: { ...scoped, scope: { selectors: ['main.product-main'] } } });
    assert.notStrictEqual(report.summary.certification, 'CERTIFIED_SCOPED');
  });

  it('ignores page-level selectors as a scope and says so', async () => {
    const { report } = await run({ liquid: true, input: { ...scoped, scope: { selectors: ['body', 'html'] } } });
    assert.strictEqual(report.summary.certification, 'STRUCTURAL');
    assert.strictEqual(report.summary.scopedCriticalCount, undefined);
    assert.ok((report.summary.certificationReasons ?? []).some((reason) => reason.includes('scope.selectors ignored')));
  });

  it('leaves a passing page CERTIFIED for the whole page, not scoped', async () => {
    const { report } = await run({ input: { ...scoped, scope: { selectors: ['main.product-main'] } } });
    assert.strictEqual(report.summary.certification, 'CERTIFIED');
    assert.strictEqual(report.summary.certificationScope, 'page');
  });
});

describe('theme QA dense header sweep', () => {
  it('runs one extra header-band pass under build-strict by default', async () => {
    const { denseCalls } = await run();
    assert.strictEqual(denseCalls, 1);
  });

  it('is off under the audit profile unless asked for', async () => {
    assert.strictEqual((await run({ input: { profile: 'audit' } })).denseCalls, 0);
    assert.strictEqual((await run({ input: { profile: 'audit', denseHeaderSweep: true } })).denseCalls, 1);
  });

  it('can be switched off under build-strict', async () => {
    assert.strictEqual((await run({ input: { denseHeaderSweep: false } })).denseCalls, 0);
  });

  it('fails the page for a critical header collision measured between the standard widths', async () => {
    const { report } = await run({ denseCriticalAt: 900 });
    assert.strictEqual(report.summary.verdict, 'FAIL');
    assert.ok(Object.keys(report.summary.byRule ?? {}).some((rule) => rule.startsWith('layout_integrity@900:')), JSON.stringify(report.summary.byRule));
    assert.ok(report.findings?.responsive?.['900'], 'the band width is listed with the other per-width readings');
  });
});
