import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildEscapeArmScript, buildEscapeReadScript, buildMeasureOpenScript, failureSeverity, runStateMatrix, type StateMatrixResult } from '../../src/main/qa/state-matrix';
import { dialogDeps, openDialog } from '../support/state-matrix-fakes';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const codes = (res: StateMatrixResult) => res.triggers[0]!.failures.map((f) => f.code);

describe('state matrix Escape grading', () => {
  it('treats an unmeasured Escape as a warning, never a critical failure', () => {
    assert.strictEqual(failureSeverity('CLOSE_ESCAPE_UNMEASURED', 'modal'), 'warning');
    assert.strictEqual(failureSeverity('CLOSE_ESCAPE_UNMEASURED', 'drawer'), 'warning');
    assert.strictEqual(failureSeverity('CLOSE_ESCAPE_FAILED', 'modal'), 'critical');
  });

  it('reports UNMEASURED, not FAILED, when the page had no focus while Escape was sent', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: false, escapeRead: { seen: false, key: null, hasFocus: false } });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape', 'close-button'] });
    assert.ok(codes(res).includes('CLOSE_ESCAPE_UNMEASURED'), codes(res).join(','));
    assert.ok(!codes(res).includes('CLOSE_ESCAPE_FAILED'));
    const failure = res.triggers[0]!.failures.find((f) => f.code === 'CLOSE_ESCAPE_UNMEASURED')!;
    assert.strictEqual(failure.severity, 'warning');
    assert.match(failure.message, /did not have focus/);
    assert.strictEqual(res.triggers[0]!.status, 'WARN');
    assert.strictEqual(res.summary.criticalCount, 0);
  });

  it('reports UNMEASURED when the focused page never received a keydown at all', async () => {
    const { deps } = dialogDeps({ kind: 'drawer', escapeCloses: false, escapeRead: { seen: false, key: null, hasFocus: true } });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape', 'close-button'] });
    const failure = res.triggers[0]!.failures.find((f) => f.code === 'CLOSE_ESCAPE_UNMEASURED');
    assert.ok(failure, codes(res).join(','));
    assert.match(failure.message, /no keydown event reached the page/);
    assert.ok(!codes(res).includes('CLOSE_ESCAPE_FAILED'));
  });

  it('reports UNMEASURED when the key that arrived was not Escape', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: false, escapeRead: { seen: true, key: 'Unidentified', hasFocus: true } });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape', 'close-button'] });
    const failure = res.triggers[0]!.failures.find((f) => f.code === 'CLOSE_ESCAPE_UNMEASURED');
    assert.ok(failure, codes(res).join(','));
    assert.match(failure.message, /"Unidentified"/);
  });

  it('still fails a modal that received Escape with focus and stayed open', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: false, escapeRead: { seen: true, key: 'Escape', hasFocus: true } });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape', 'close-button'] });
    const failure = res.triggers[0]!.failures.find((f) => f.code === 'CLOSE_ESCAPE_FAILED');
    assert.ok(failure, codes(res).join(','));
    assert.strictEqual(failure.severity, 'critical');
    assert.ok(!codes(res).includes('CLOSE_ESCAPE_UNMEASURED'));
    assert.strictEqual(res.triggers[0]!.status, 'FAIL');
  });

  it('reports nothing when Escape closes the panel', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: true });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    assert.ok(!codes(res).some((code) => code.startsWith('CLOSE_ESCAPE')));
    assert.strictEqual(res.triggers[0]!.status, 'PASS');
  });

  it('waits for a close that finishes after the settle instead of failing the first sample', async () => {
    const { deps, steps, state } = dialogDeps({ kind: 'drawer', escapeCloses: true, closeAfterTurns: 3 });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape'] });
    assert.deepStrictEqual(codes(res), []);
    assert.strictEqual(res.triggers[0]!.status, 'PASS');
    assert.strictEqual(res.triggers[0]!.closes[0]!.closed, true);
    assert.strictEqual(steps.filter((s) => s.kind === 'key' && s.detail === 'Escape').length, 1, 'a late close is not an ignored Escape, so the key is not repeated');
    assert.ok(state.closedReads >= 4, `the closed state was re-read until it settled, got ${state.closedReads} reads`);
  });

  it('waits for a late close from the close control too', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: true, closeAfterTurns: 2 });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['close-button'] });
    assert.ok(!codes(res).includes('CLOSE_BUTTON_FAILED'), codes(res).join(','));
    assert.strictEqual(res.triggers[0]!.status, 'PASS');
  });

  it('warns CLOSE_ESCAPE_FLAKY when only the second Escape closes the panel', async () => {
    const { deps, steps } = dialogDeps({ kind: 'modal', escapeClosesOnPress: 2 });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape'] });
    const flaky = res.triggers[0]!.failures.find((f) => f.code === 'CLOSE_ESCAPE_FLAKY');
    assert.ok(flaky, codes(res).join(','));
    assert.strictEqual(flaky.severity, 'warning');
    assert.ok(!codes(res).includes('CLOSE_ESCAPE_FAILED'));
    assert.strictEqual(res.triggers[0]!.status, 'WARN');
    assert.strictEqual(res.summary.criticalCount, 0);
    assert.strictEqual(res.triggers[0]!.closes[0]!.closed, true);
    assert.strictEqual(steps.filter((s) => s.kind === 'key' && s.detail === 'Escape').length, 2);
  });

  it('keeps a menu that closes on the second Escape a warning too', async () => {
    const { deps } = dialogDeps({ kind: 'dropdown', escapeClosesOnPress: 2 });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    assert.ok(codes(res).includes('CLOSE_ESCAPE_FLAKY'), codes(res).join(','));
    assert.deepStrictEqual(res.triggers[0]!.closes.map((c) => c.method), ['escape']);
    assert.strictEqual(failureSeverity('CLOSE_ESCAPE_FLAKY', 'modal'), 'warning');
  });

  it('still fails a modal whose Escape never closes it, after the repeat', async () => {
    const { deps, steps } = dialogDeps({ kind: 'modal', escapeCloses: false });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape', 'close-button'] });
    assert.ok(codes(res).includes('CLOSE_ESCAPE_FAILED'), codes(res).join(','));
    assert.ok(!codes(res).includes('CLOSE_ESCAPE_FLAKY'));
    assert.strictEqual(steps.filter((s) => s.kind === 'key' && s.detail === 'Escape').length, 2, 'Escape is repeated once before it is graded');
  });

  it('reports UNMEASURED, not FAILED, when the Escape probe cannot be read back', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: false, escapeReadThrows: true });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape', 'close-button'] });
    const failure = res.triggers[0]!.failures.find((f) => f.code === 'CLOSE_ESCAPE_UNMEASURED');
    assert.ok(failure, codes(res).join(','));
    assert.match(failure.message, /could not be read back/);
    assert.ok(!codes(res).includes('CLOSE_ESCAPE_FAILED'));
    assert.strictEqual(res.summary.criticalCount, 0);
  });

  it('reports UNMEASURED when a keydown arrived but the key is unknown', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: false, escapeRead: { seen: true, key: null, hasFocus: true } });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape', 'close-button'] });
    assert.ok(codes(res).includes('CLOSE_ESCAPE_UNMEASURED'), codes(res).join(','));
    assert.ok(!codes(res).includes('CLOSE_ESCAPE_FAILED'));
  });

  it('stops re-reading the closed state once the run-wide poll budget is spent', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: false, closeAfterTurns: 1000 });
    let clock = 0;
    let closePolls = 0;
    deps.now = () => clock;
    deps.wait = async (ms: number) => {
      if (ms === 250) closePolls++;
      clock += 2000;
    };
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    assert.ok(codes(res).includes('STATE_STUCK_OPEN'), codes(res).join(','));
    assert.strictEqual(closePolls, 4, 'four 2 s turns spend the 8 s budget; later measurements are single samples');
  });

  it('arms a one-shot capture listener before the key and reads it back afterwards', async () => {
    const { deps, steps } = dialogDeps({ kind: 'modal', escapeCloses: true });
    await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape'] });
    const keyIndex = steps.findIndex((s) => s.kind === 'key' && s.detail === 'Escape');
    assert.ok(keyIndex > 0);
    const evalsBefore = steps.slice(0, keyIndex).filter((s) => s.kind === 'eval');
    const evalsAfter = steps.slice(keyIndex + 1).filter((s) => s.kind === 'eval');
    assert.ok(evalsBefore.some((s) => s.detail.includes('__antifanSmKey')), 'the listener is armed before Escape');
    assert.ok(evalsAfter.length > 0);
    assert.ok(buildEscapeArmScript().includes("addEventListener('keydown'") && buildEscapeArmScript().includes('capture: true'));
    assert.ok(buildEscapeReadScript().includes('document.hasFocus()'));
  });
});

describe('state matrix close-control choice', () => {
  it('skips the close-button method instead of clicking anything when the panel has no close control', async () => {
    const { deps, steps } = dialogDeps({ kind: 'modal', escapeCloses: true, measureOpen: { ...openDialog, closeControl: null } });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    const attempt = res.triggers[0]!.closes.find((c) => c.method === 'close-button');
    assert.strictEqual(attempt?.skipped, 'NO_CLOSE_CONTROL');
    assert.ok(codes(res).includes('CLOSE_CONTROL_MISSING'));
    assert.ok(!steps.some((s) => s.kind === 'click' && s.detail.includes('sm-close')), 'no close control means nothing to click');
  });

  it('excludes a full-viewport control from the candidates and keeps the backdrop for the backdrop method', () => {
    const script = buildMeasureOpenScript(0, 'modal', null);
    assert.match(script, /coversViewport/);
    assert.match(script, /b\.width >= vw \* 0\.9 && b\.height >= vh \* 0\.9/);
    assert.match(script, /BACKDROP_CLASS/);
  });

  it('does not take a full-screen scrim button as the close control in a real page (Electron probe)', (t) => {
    const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/state-matrix-fixtures-probe.cjs', '--only=full-screen-scrim-button'], {
      cwd: findRoot(),
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    if (run.error || !/SUMMARY runs=/.test(output)) {
      t.skip(`Electron could not start here: ${run.error ? run.error.message : output.slice(-300)}`);
      return;
    }
    assert.strictEqual(run.status, 0, output.slice(-1500));
    assert.match(output, /SUMMARY runs=2 pass=2 fail=0/);
  });
});
