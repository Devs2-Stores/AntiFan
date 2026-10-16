import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { createCleanQaPorts, makeCleanTarget, type CleanPortsOptions } from '../support/clean-qa-ports';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-viewport-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const run = (options: CleanPortsOptions) =>
  new ThemeQaWorkflow(createCleanQaPorts(options).ports).validate({
    runId: 'run-viewport',
    attemptId: 'att-viewport',
    workspaceRoot: root,
    target: makeCleanTarget(),
  });

describe('theme QA viewport honesty', () => {
  it('is INCONCLUSIVE when the emulated width the host asked for is not the width the page measured', async () => {
    const report = await run({ activeWidth: 1440, requestedWidth: 1440, observedWidth: 949 });
    const gaps = report.findings?.evidenceGaps ?? [];
    const gap = gaps.find((g) => g.startsWith('VIEWPORT_MISMATCH'));
    assert.ok(gap, `expected a VIEWPORT_MISMATCH gap, got: ${gaps.join(' | ')}`);
    assert.match(gap!, /requested 1440 observed 949/);
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.criticalCount, 0);
  });

  it('echoes requested and observed width on the summary and the report', async () => {
    const report = await run({ activeWidth: 1440, requestedWidth: 1440, observedWidth: 949 });
    assert.strictEqual(report.summary.viewport?.requestedWidth, 1440);
    assert.strictEqual(report.summary.viewport?.observedWidth, 949);
    assert.strictEqual(report.viewport?.requestedWidth, 1440);
    assert.strictEqual(report.viewport?.observedWidth, 949);
  });

  it('tolerates a sub-pixel difference between the requested and the measured width', async () => {
    const report = await run({ activeWidth: 1440, requestedWidth: 1440, observedWidth: 1438 });
    assert.ok(!(report.findings?.evidenceGaps ?? []).some((g) => g.startsWith('VIEWPORT_MISMATCH')));
  });

  it('adds no mismatch gap when the host reports no requested width (fluid tab)', async () => {
    const fluid = await run({ activeWidth: 1440, requestedWidth: null, observedWidth: 1440 });
    assert.ok(!(fluid.findings?.evidenceGaps ?? []).some((g) => g.startsWith('VIEWPORT_MISMATCH')));
    const silent = await run({ activeWidth: 1440 });
    assert.ok(!(silent.findings?.evidenceGaps ?? []).some((g) => g.startsWith('VIEWPORT_MISMATCH')));
    assert.strictEqual(silent.summary.verdict, 'PASS');
  });
});
