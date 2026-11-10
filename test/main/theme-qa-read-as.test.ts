import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ThemeQaWorkflow, type ThemeQaValidateInput, type ThemeQaReport } from '../../src/main/qa/theme-qa-workflow';
import { boundQaReportResponse } from '../../src/main/qa/qa-response-bounds';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';
import { createCleanQaPorts, makeCleanTarget } from '../support/clean-qa-ports';
import { CaptureError } from '../../src/main/verification/visual-capture';
import { LiquidErrorScanner } from '../../src/main/qa/scanners/liquid-error-scanner';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-read-as-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const RAW_PASS = {
  desktop: { mismatchPercent: 0.4, passed: true },
  tablet: { mismatchPercent: 0.6, passed: true },
  mobile: { mismatchPercent: 0.8, passed: true },
};

const siblingWarning = (selector: string) => ({
  kind: 'overlap', ruleId: 'sibling-content-overlap', severity: 'warning', selector, details: `Sibling content overlaps 60x40px: .a and ${selector}`,
});
const overlapCritical = { kind: 'overlap', severity: 'critical', selector: 'header .nav', details: 'Navigation overlaps the search box' };

interface RunOptions {
  /** Make the screenshot fail the way a tab the compositor stopped painting does. */
  starve?: boolean;
  /** Settle ends with DOM mutations still running. */
  unstable?: boolean;
  liquid?: boolean;
  /** What the scope containment script returns; null models a selector the page lacks. */
  containment?: Record<string, boolean> | null;
}

/** Runs the workflow; `integrity` is what the active-width layout scan reports. */
const run = async (input: Partial<ThemeQaValidateInput>, integrity?: unknown[], options: RunOptions = {}): Promise<ThemeQaReport> => {
  const record = createCleanQaPorts({ activeWidth: 1440 });
  const browser = record.ports.browser as unknown as Record<string, unknown>;
  const integrityScript = LayoutIntegrityEngine.getBrowserScanScript('active');
  const liquidScript = LiquidErrorScanner.getBrowserScanScript();
  const baseEval = browser.eval as (target: unknown, script: string) => Promise<unknown>;
  browser.eval = async (target: unknown, script: string) => {
    if (integrity && script === integrityScript) {
      return { measured: true, viewport: { name: 'active', width: 1440, height: 900 }, findings: integrity, stats: { elements: 10, textRuns: 4, controls: 2, sweepSteps: 1, truncated: false, truncatedReasons: [], failedDetectors: [], durationMs: 3, cls: 0 } };
    }
    if (options.liquid && script === liquidScript) return { hasErrors: true, errors: [liquidFinding], scannedElementsCount: 20 };
    if (options.containment !== undefined && script.includes('let target = null;')) return options.containment;
    return baseEval(target, script);
  };
  if (options.starve) {
    browser.screenshot = async () => {
      throw new CaptureError('CAPTURE_FRAME_STARVATION', 'No frame was produced for the tab');
    };
  }
  if (options.unstable) {
    browser.settleCapture = async () => ({
      settleComplete: false,
      gates: { network: true, fonts: true, images: true, dom: false },
      timingsMs: { network: 5, fonts: 100, images: 5, dom: 5000, total: 5110 },
      brokenImages: [],
      layoutStable: true,
    });
  }
  return new ThemeQaWorkflow(record.ports).validate({
    runId: 'run-read-as',
    attemptId: 'att-read-as',
    workspaceRoot: root,
    target: makeCleanTarget(),
    ...input,
  });
};

describe('theme QA summary.readAs', () => {
  it('says a structural-only PASS is not a visual approval, with the counts, and leaves the verdict alone', async () => {
    const report = await run({ viewports: RAW_PASS }, [siblingWarning('.b'), siblingWarning('.d')]);
    const { summary } = report;
    assert.strictEqual(summary.verdict, 'PASS');
    assert.strictEqual(summary.passed, true);
    assert.strictEqual(summary.certification, 'STRUCTURAL');
    const reasons = summary.certificationReasons ?? [];
    const warnings = report.findings?.visualAmbiguities ?? [];
    const readAs = summary.readAs ?? '';
    assert.ok(warnings.length >= 2, 'the sibling warnings reach findings.visualAmbiguities');
    assert.ok(warnings.some((w) => w.includes('Sibling content overlaps')));
    assert.ok(readAs.startsWith('NOT a visual approval:'), readAs);
    assert.ok(readAs.includes(`${reasons.length} reason(s) in certificationReasons`), readAs);
    assert.ok(readAs.includes(`${warnings.length} warning(s) in findings.visualAmbiguities`), readAs);
  });

  it('gives a certified run its own sentence naming the scope', async () => {
    const report = await run({ greenfield: { reason: 'new theme, no baseline promoted yet' } });
    assert.strictEqual(report.summary.certification, 'CERTIFIED', (report.summary.certificationReasons ?? []).join(' | '));
    const readAs = report.summary.readAs ?? '';
    assert.ok(readAs.startsWith('Certified for the whole page'), readAs);
    assert.ok(readAs.includes('certificationScope: page'));
  });

  it('points a failing run at its failing findings', async () => {
    const report = await run({ viewports: RAW_PASS }, [overlapCritical]);
    assert.strictEqual(report.summary.verdict, 'FAIL');
    const readAs = report.summary.readAs ?? '';
    assert.ok(readAs.startsWith('Failed:'), readAs);
    assert.ok(readAs.includes('summary.byRule'));
  });

  it('survives response bounding even when every list is cut', async () => {
    const report = await run({ viewports: RAW_PASS });
    const heavy = { runId: 'r', summary: report.summary, filler: Array.from({ length: 4000 }, (_, i) => ({ i, text: 'x'.repeat(60) })) };
    const bounded = boundQaReportResponse(heavy, 4096);
    assert.ok('responseBound' in bounded);
    const kept = JSON.parse(JSON.stringify(bounded)).summary;
    assert.strictEqual(kept.readAs, report.summary.readAs);
    assert.ok(String(kept.readAs).startsWith('NOT a visual approval:'));
  });
});

const ALL_RECEIPTS = { desktop: 'compare-receipt', tablet: 'compare-receipt', mobile: 'compare-receipt' } as const;
const liquidFinding = { type: 'runtime_error', message: 'Liquid error: internal', selector: 'footer.site-footer' };

/**
 * Every verdict and certification pair the workflow can produce, each with the sentence a reader must get.
 * CERTIFIED with a FAIL or INCONCLUSIVE verdict cannot occur: the matrix that grants CERTIFIED is
 * itself demoted by a failing or inconclusive summary, so a certified sentence implies a PASS.
 */
describe('theme QA summary.readAs per verdict and certification', () => {
  const rows: Array<{ name: string; verdict: string; certification: string; prefix: string; go: () => Promise<ThemeQaReport> }> = [
    { name: 'PASS + STRUCTURAL', verdict: 'PASS', certification: 'STRUCTURAL', prefix: 'NOT a visual approval:', go: () => run({ viewports: RAW_PASS }) },
    { name: 'PASS + CERTIFIED', verdict: 'PASS', certification: 'CERTIFIED', prefix: 'Certified for the whole page', go: () => run({ greenfield: { reason: 'new theme, no baseline promoted yet' } }) },
    { name: 'FAIL + STRUCTURAL', verdict: 'FAIL', certification: 'STRUCTURAL', prefix: 'Failed:', go: () => run({ viewports: RAW_PASS }, [overlapCritical]) },
    { name: 'FAIL + STRUCTURAL (greenfield)', verdict: 'FAIL', certification: 'STRUCTURAL', prefix: 'Failed:', go: () => run({ greenfield: { reason: 'new theme, no baseline promoted yet' } }, [overlapCritical]) },
    {
      name: 'FAIL + CERTIFIED_SCOPED', verdict: 'FAIL', certification: 'CERTIFIED_SCOPED', prefix: 'Certified for the declared scope only',
      go: () => run({ viewports: RAW_PASS, viewportProvenance: { ...ALL_RECEIPTS }, scope: { selectors: ['main.product-main'], files: ['sections/product.liquid'] } }, undefined, { liquid: true, containment: { 'footer.site-footer': false } }),
    },
    { name: 'INCONCLUSIVE + STRUCTURAL', verdict: 'INCONCLUSIVE', certification: 'STRUCTURAL', prefix: 'Inconclusive:', go: () => run({ viewports: RAW_PASS }, [overlapCritical], { starve: true }) },
    { name: 'INCONCLUSIVE + STRUCTURAL (unstable DOM, greenfield)', verdict: 'INCONCLUSIVE', certification: 'STRUCTURAL', prefix: 'Inconclusive:', go: () => run({ greenfield: { reason: 'new theme, no baseline promoted yet' } }, undefined, { unstable: true }) },
  ];
  for (const row of rows) {
    it(`${row.name}: the sentence matches what the run is`, async () => {
      const { summary } = await row.go();
      assert.strictEqual(summary.verdict, row.verdict, JSON.stringify(summary.certificationReasons));
      assert.strictEqual(summary.certification, row.certification, (summary.certificationReasons ?? []).join(' | '));
      const readAs = summary.readAs ?? '';
      assert.ok(readAs.startsWith(row.prefix), readAs);
      if (row.verdict !== 'PASS') assert.ok(!readAs.startsWith('Certified for the whole page'), 'a certified sentence is reserved for a PASS');
      if (row.verdict === 'INCONCLUSIVE') assert.ok(readAs.includes('not a pass and not a fail'), readAs);
    });
  }
});
