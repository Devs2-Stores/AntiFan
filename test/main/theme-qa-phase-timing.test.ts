import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { createCleanQaPorts, makeCleanTarget } from '../support/clean-qa-ports';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-phase-ms-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('theme QA summary.phaseMs', () => {
  it('names the run phases, and their sum never exceeds total', async () => {
    const record = createCleanQaPorts({ activeWidth: 1440 });
    const report = await new ThemeQaWorkflow(record.ports).validate({
      runId: 'run-phase-ms',
      attemptId: 'att-phase-ms',
      workspaceRoot: root,
      target: makeCleanTarget(),
    });
    const phaseMs = report.summary.phaseMs;
    assert.ok(phaseMs, 'summary.phaseMs is present');
    for (const key of ['prepare', 'reload', 'settle', 'evidence', 'layoutScans', 'responsive', 'responsiveTail', 'scanners', 'stateMatrix', 'finalize', 'total']) {
      const value: number | undefined = phaseMs[key];
      assert.strictEqual(typeof value, 'number', `phaseMs.${key} is a number`);
      assert.ok(Number.isInteger(value) && (value ?? -1) >= 0, `phaseMs.${key} is a non-negative integer`);
    }
    const { total = -1, ...phases } = phaseMs;
    const sum = Object.values(phases).reduce((a, b) => a + b, 0);
    assert.ok(sum <= total, `phases sum ${sum} must not exceed total ${total}`);
  });
});
