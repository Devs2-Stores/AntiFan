import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildUnstyledProbeScript, failureSeverity, runStateMatrix } from '../../src/main/qa/state-matrix';
import { dialogDeps } from '../support/state-matrix-fakes';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const cues = [
  { cue: 'font-family', selector: 'p.note', detail: 'renders in the serif browser default "times new roman" while the page body uses "arial"' },
  { cue: 'ua-link-colour', selector: 'a.policy', detail: 'link keeps the browser-default blue rgb(0, 0, 238)' },
];

describe('modal unstyled detection', () => {
  it('is critical for dialogs and a warning for menus', () => {
    assert.strictEqual(failureSeverity('MODAL_UNSTYLED', 'modal'), 'critical');
    assert.strictEqual(failureSeverity('MODAL_UNSTYLED', 'drawer'), 'critical');
    assert.strictEqual(failureSeverity('MODAL_UNSTYLED', 'dropdown'), 'warning');
    assert.strictEqual(failureSeverity('MODAL_UNSTYLED', 'megamenu'), 'warning');
  });

  it('fails a modal whose probe reports browser-default rendering and names the cues', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: true, unstyled: { unstyled: cues } });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    const trigger = res.triggers[0]!;
    const failure = trigger.failures.find((f) => f.code === 'MODAL_UNSTYLED');
    assert.ok(failure, `expected MODAL_UNSTYLED, got ${trigger.failures.map((f) => f.code).join(',')}`);
    assert.strictEqual(failure.severity, 'critical');
    assert.match(failure.message, /font-family/);
    assert.match(failure.message, /ua-link-colour/);
    assert.strictEqual(trigger.status, 'FAIL');
    assert.ok(res.summary.criticalCount >= 1);
  });

  it('only warns for a dropdown with the same cues', async () => {
    const { deps } = dialogDeps({ kind: 'dropdown', escapeCloses: true, unstyled: { unstyled: cues } });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    const failure = res.triggers[0]!.failures.find((f) => f.code === 'MODAL_UNSTYLED');
    assert.ok(failure);
    assert.strictEqual(failure.severity, 'warning');
    assert.strictEqual(res.triggers[0]!.status, 'WARN');
  });

  it('reports nothing when the probe finds no cue', async () => {
    const { deps } = dialogDeps({ kind: 'modal', escapeCloses: true, unstyled: { unstyled: [] } });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    assert.ok(!res.triggers[0]!.failures.some((f) => f.code === 'MODAL_UNSTYLED'));
    assert.strictEqual(res.triggers[0]!.status, 'PASS');
  });

  it('never lets a failing probe mask the lifecycle result', async () => {
    const { deps } = dialogDeps({
      kind: 'modal',
      escapeCloses: true,
      unstyled: () => {
        throw new Error('probe crashed');
      },
    });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    assert.ok(!res.triggers[0]!.failures.some((f) => f.code === 'MODAL_UNSTYLED'));
    assert.strictEqual(res.triggers[0]!.status, 'PASS');
  });

  it('measures every default-rendering cue against the panel it was given', () => {
    const script = buildUnstyledProbeScript(3);
    assert.ok(script.includes('data-antifan-sm-panel="3"'), 'the probe must read the tagged panel');
    for (const cue of ['font-family', 'ua-control-chrome', 'ua-link-colour', 'bare-table', 'list-padding', 'panel-padding']) {
      assert.ok(script.includes(`'${cue}'`), `missing cue ${cue}`);
    }
    assert.ok(script.includes('rgb(0, 0, 238)'));
    assert.ok(script.includes('rgb(239, 239, 239)'));
  });

  it('flags an unstyled dialog and passes a styled one in a real page (Electron probe)', (t) => {
    const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/state-matrix-fixtures-probe.cjs', '--only=modal-with-browser-default-styling'], {
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

    const styled = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/state-matrix-fixtures-probe.cjs', '--only=modal-styled-like-the-page'], {
      cwd: findRoot(),
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
    const styledOutput = `${styled.stdout || ''}${styled.stderr || ''}`;
    assert.strictEqual(styled.status, 0, styledOutput.slice(-1500));
    assert.match(styledOutput, /SUMMARY runs=2 pass=2 fail=0/);
  });
});
