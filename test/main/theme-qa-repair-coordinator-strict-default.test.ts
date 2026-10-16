import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { ThemeQaRepairCoordinator } from '../../src/main/qa/theme-qa-repair-coordinator';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { createCleanQaPorts, makeCleanTarget, type CleanPortsOptions } from '../support/clean-qa-ports';

// A plain ThemeQaWorkflow, not the audit-profile subclass the stop-criteria tests use: the coordinator
// passes no profile, so these cases run under the production build-strict default.
describe('ThemeQaRepairCoordinator under the default profile', () => {
  let root = '';
  const themeFile = () => path.join(root, 'layout', 'theme.liquid');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-repair-strict-'));
    fs.mkdirSync(path.join(root, 'layout'), { recursive: true });
    fs.writeFileSync(themeFile(), '<html><body>v1</body></html>');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const coordinatorFor = (options: CleanPortsOptions = {}) =>
    new ThemeQaRepairCoordinator(new ThemeQaWorkflow(createCleanQaPorts(options).ports));

  it('verifies a clean page after an edit without tripping the stop criteria', async () => {
    const coordinator = coordinatorFor();
    const target = makeCleanTarget();
    const begin = await coordinator.begin({ workspaceRoot: root, target, runId: 'run-strict-clean' });
    assert.strictEqual(begin.report.profile, 'build-strict');
    assert.deepStrictEqual(begin.report.findings?.evidenceGaps ?? [], []);

    fs.writeFileSync(themeFile(), '<html><body>v2</body></html>');
    const result = await coordinator.verify({ sessionId: begin.sessionId, target });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'verified');
    assert.strictEqual(result.stopReason, undefined);
    assert.strictEqual(result.rolledBack, false);
    assert.strictEqual(result.report.profile, 'build-strict');
    assert.strictEqual(result.summary.verdict, 'PASS');
  });

  it('surfaces a missing state-matrix capability as an evidence gap instead of passing', async () => {
    const coordinator = coordinatorFor({ stateMatrix: false });
    const target = makeCleanTarget();
    const begin = await coordinator.begin({ workspaceRoot: root, target, runId: 'run-strict-gap' });
    assert.ok(
      (begin.report.findings?.evidenceGaps ?? []).some((gap) => gap.startsWith('State matrix unsupported')),
      'the baseline report names the missing capability'
    );
    assert.notStrictEqual(begin.summary.verdict, 'PASS');

    fs.writeFileSync(themeFile(), '<html><body>v2</body></html>');
    await assert.rejects(
      coordinator.verify({ sessionId: begin.sessionId, target }),
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.code === 'SETTLE_INCOMPLETE' &&
        error.details?.disposition === 'INCONCLUSIVE' &&
        typeof error.details?.evidenceGaps === 'number' && error.details.evidenceGaps >= 1 &&
        !error.message.includes('STOP_CRITERIA_EXCEEDED')
    );
  });
});
