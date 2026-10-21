import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ThemeQaWorkflow, type ThemeQaValidateInput } from '../../src/main/qa/theme-qa-workflow';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { createCleanQaPorts, makeCleanTarget } from '../support/clean-qa-ports';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-greenfield-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

interface RunOptions {
  greenfield?: ThemeQaValidateInput['greenfield'];
  /** Width whose sweep reading reports a horizontal overflow. */
  overflowAtWidth?: number;
}

const run = (options: RunOptions = {}) => {
  const record = createCleanQaPorts({ activeWidth: 1440 });
  if (options.overflowAtWidth !== undefined) {
    const browser = record.ports.browser as unknown as {
      responsiveCheck: (params: unknown) => Promise<{ ok: boolean; breakpoints: Record<string, Record<string, unknown>> }>;
    };
    const clean = browser.responsiveCheck.bind(browser);
    browser.responsiveCheck = async (params: unknown) => {
      const result = await clean(params);
      const entry = result.breakpoints[`w${options.overflowAtWidth}`];
      if (entry) entry.hasHorizontalOverflow = true;
      return result;
    };
  }
  return new ThemeQaWorkflow(record.ports).validate({
    runId: 'run-greenfield',
    attemptId: 'att-greenfield',
    workspaceRoot: root,
    target: makeCleanTarget(),
    ...(options.greenfield !== undefined ? { greenfield: options.greenfield } : {}),
  });
};

describe('theme QA greenfield run', () => {
  it('certifies a declared greenfield run whose three widths pass the absolute gates', async () => {
    const report = await run({ greenfield: { reason: 'new theme, no baseline promoted yet' } });
    assert.strictEqual(report.summary.certification, 'CERTIFIED', (report.summary.certificationReasons ?? []).join(' | '));
    assert.strictEqual(report.summary.certificationBasis, 'greenfield');
    assert.strictEqual(report.summary.matrixVerdict, 'PASS');
    const sources = (report.viewportsTested ?? []).filter((item) => item.source === 'absolute').map((item) => item.width);
    assert.deepStrictEqual(sources.sort((a, b) => a - b), [320, 768, 1440]);
    assert.ok((report.summary.certificationReasons ?? []).some((reason) => reason.includes('new theme, no baseline promoted yet')));
  });

  it('does not certify a greenfield run when a representative width overflows', async () => {
    const report = await run({ greenfield: { reason: 'new theme, no baseline promoted yet' }, overflowAtWidth: 768 });
    assert.notStrictEqual(report.summary.certification, 'CERTIFIED');
    assert.strictEqual(report.summary.certificationBasis, undefined);
    assert.ok(
      (report.summary.certificationReasons ?? []).some((reason) => reason.includes('tablet') && reason.includes('768')),
      (report.summary.certificationReasons ?? []).join(' | ')
    );
  });

  it('refuses a greenfield declaration with an empty reason as INVALID_ARGUMENT', async () => {
    for (const reason of ['', '   ']) {
      await assert.rejects(
        () => run({ greenfield: { reason } }),
        (error: unknown) => error instanceof CapabilityError && error.code === 'INVALID_ARGUMENT'
      );
    }
  });

  it('refuses a greenfield run when a baseline already exists', async () => {
    await assert.rejects(
      () => run({ greenfield: { reason: 'new theme', baselineExists: true } }),
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.code === 'GREENFIELD_BASELINE_EXISTS' &&
        typeof error.details?.recovery === 'string'
    );
  });

  it('leaves a run without greenfield STRUCTURAL and says how to certify it', async () => {
    const report = await run();
    assert.strictEqual(report.summary.certification, 'STRUCTURAL');
    assert.strictEqual(report.summary.certificationBasis, undefined);
    const remedies = report.summary.certificationRemedies ?? [];
    assert.ok(remedies.some((remedy) => remedy.tool === 'theme.qa_validate'), JSON.stringify(remedies));
    assert.ok((report.viewportsTested ?? []).length >= 3, 'the sweep widths are reported as tested');
    assert.ok(report.summary.attribution, 'attribution is reported');
  });
});
