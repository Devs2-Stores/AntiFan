/**
 * Bounded teardown steps.
 *
 * The committed shutdown is awaited before `app.quit()` (and by the shutdown path
 * generally), so a cleanup step that never settles would mean the application never quits
 * and the user has to kill the process. These rows prove the two properties that make the
 * bound safe: a step that hangs is recorded and does not stop the steps after it, and a
 * step that finishes is awaited to completion rather than being cut short. Time is driven
 * by the runner's clock (`mock.timers`), so no row waits on the wall clock.
 */
import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { runBoundedShutdownStep } from '../../src/main/diagnostics/main-lifecycle-log';

type JournalRow = { event: string; fields?: Record<string, unknown> };

/** Collect journal rows, so a case asserts what the next boot would read. */
function recordingJournal(rows: JournalRow[]): (event: string, fields?: Record<string, unknown>) => void {
  return (event, fields) => {
    rows.push({ event, fields });
  };
}

describe('bounded shutdown steps', () => {
  it('records a finished step', async () => {
    const rows: JournalRow[] = [];
    const outcome = await runBoundedShutdownStep('cookies.flushStore', 1_000, () => undefined, recordingJournal(rows));
    assert.equal(outcome, 'done');
    assert.deepEqual(rows.map((row) => row.event), ['shutdown.step.begin', 'shutdown.step.done']);
    assert.equal(rows[0]?.fields?.step, 'cookies.flushStore');
  });

  it('records a failed step with its reason instead of throwing it at the sequence', async () => {
    const rows: JournalRow[] = [];
    const outcome = await runBoundedShutdownStep(
      'flushAllSessions',
      1_000,
      () => {
        throw new Error('profile store closed');
      },
      recordingJournal(rows)
    );
    assert.equal(outcome, 'failed');
    assert.deepEqual(rows.map((row) => row.event), ['shutdown.step.begin', 'shutdown.step.failed']);
    assert.match(String(rows[1]?.fields?.detail), /profile store closed/);
    assert.equal(rows[1]?.fields?.step, 'flushAllSessions');
  });

  it('gives up on a step that never settles, records it, and lets the next step run', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const rows: JournalRow[] = [];
      const journal = recordingJournal(rows);
      const hung = Promise.withResolvers<never>();

      const pending = runBoundedShutdownStep('cookies.flushStore', 40, () => hung.promise, journal);
      await yieldToLoop();
      mock.timers.tick(40);

      assert.equal(await pending, 'timeout');
      assert.deepEqual(rows.map((row) => row.event), ['shutdown.step.begin', 'shutdown.step.timeout']);
      assert.equal(rows[1]?.fields?.deadlineMs, 40);

      // The property that matters for a quit: the sequence continues, so the steps after a
      // hung one still run and `app.quit()` is still reached.
      assert.equal(await runBoundedShutdownStep('window.close', 1_000, () => undefined, journal), 'done');
    } finally {
      mock.timers.reset();
    }
  });

  it('waits for a step that is still running, and its deadline firing later changes nothing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const rows: JournalRow[] = [];
      const slow = Promise.withResolvers<void>();

      const pending = runBoundedShutdownStep('cookies.flushStore', 2_000, () => slow.promise, recordingJournal(rows));
      await yieldToLoop();
      slow.resolve();

      assert.equal(await pending, 'done', 'work that finishes is work, not a hang');
      mock.timers.tick(2_000);
      assert.deepEqual(rows.map((row) => row.event), ['shutdown.step.begin', 'shutdown.step.done'], 'the deadline is cleared with the step');
    } finally {
      mock.timers.reset();
    }
  });
});
