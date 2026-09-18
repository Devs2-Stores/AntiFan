import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRecord, writeRecordAtomic } from '../../scripts/lib/atomic-record.mjs';
import { checkpointPath } from '../../scripts/goal/checkpoint.mjs';
import { runGoal, runSummaryPath, worklogPath } from '../../scripts/goal/runner.mjs';
import { pruneRunArtifacts } from '../../scripts/goal/prune.mjs';
import { supervisorVerdictPath } from '../../scripts/goal/supervisor.mjs';
import { heartbeatAgeMs, heartbeatPath, readRunnerMutex } from '../../scripts/goal/watchdog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RUNNER = path.join(REPO, 'scripts', 'goal', 'runner.mjs');
const SUPERVISOR = path.join(REPO, 'scripts', 'goal', 'supervisor.mjs');
const LADDER_FIXTURE = path.join(HERE, 'fixtures', 'goal-ladder.mjs');
const DEADLOCK_FIXTURE = path.join(HERE, 'fixtures', 'goal-deadlock.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test dirs live on the repo drive, not os.tmpdir(): the runner's disk-headroom
// probe is real, and C: sits under the free-fraction floor (the plan's own
// preflight measured 92% used). A tmpdir on C: would abort every run for the
// wrong reason.
function makeDir(prefix) {
  return fs.mkdtempSync(path.join(REPO, `.goal-test-${prefix}-`));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Two kinds of wait, because they time different things. `waitFor` bounds an
// OS-level state change (a process dying, a record appearing) that the host's
// scheduling decides, so it takes a calendar budget. `waitForProgress` bounds a
// runner's *stall*: it watches the worklog, so a loaded host only moves the wall
// clock while a runner that stops advancing still fails - and the failure names
// the last event instead of the elapsed time. The kill/resume case used to
// measure the machine: a 15s budget timed out twice (15.03s, 15.08s) against an
// idle 3.4s run, 60s timed out again at 60.08s with one unit verdicted, and the
// case passes in 3.7-4.2s in between. The budget was never the invariant.
async function waitFor(cond, { timeoutMs = 60_000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return false;
}

// The stall budget is 40x the fixture's 400ms unit, so it cannot fire on a
// loaded host; the hard budget backstops a runner that keeps logging progress
// without ever satisfying the condition.
//
// A stall only fast-fails when the runner behind it is GONE: no worklog entry for
// 16s from a dead runner is a broken runner, and naming the last event beats a
// wall-clock timeout. A stall from a LIVE runner is the host, not the run — the
// lane runs its suites in parallel, and four Electron lanes on one box pushed this
// case past the 16s window (17.1s, `no worklog entry for 16021ms … runnerAlive=
// true`) while the same case runs in 4s when the box is idle. Failing that as if
// the runner had wedged would re-introduce exactly the machine measurement this
// helper exists to remove, so a live runner spends the hard budget instead.
async function waitForProgress(dir, cond, { stallMs = 16_000, hardMs = 120_000, stepMs = 50 } = {}) {
  const deadline = Date.now() + hardMs;
  let entries = readWorklog(dir).length;
  let advancedAt = Date.now();
  let stalledMs = 0;
  while (Date.now() < deadline) {
    if (cond()) return { ok: true };
    const now = readWorklog(dir).length;
    if (now !== entries) {
      entries = now;
      advancedAt = Date.now();
    } else if (Date.now() - advancedAt > stallMs) {
      stalledMs = Date.now() - advancedAt;
      const lock = readRunnerMutex(dir);
      const alive = lock?.pid ? isAlive(lock.pid) : null;
      if (alive === false) return { ok: false, stalled: true, stalledMs };
    }
    await sleep(stepMs);
  }
  return { ok: false, stalled: stalledMs > 0, stalledMs };
}

// What a failed wait needs to explain itself: where the run stopped, whether its
// pulse was still landing, and whether the process was even alive.
function describeRun(dir) {
  const log = readWorklog(dir);
  const last = log
    .slice(-3)
    .map(
      (e) =>
        `${e.type}${e.itemId ? `:${e.itemId}` : ''}${e.verdict ? `=${e.verdict}` : ''}${e.reason ? `(${e.reason})` : ''}@${e.at}`,
    )
    .join(' ');
  const lock = readRunnerMutex(dir);
  const verdicts = readRecord(checkpointPath(dir))?.ladder?.map((u) => u.verdict ?? 'pending') ?? null;
  return `entries=${log.length} verdicts=${JSON.stringify(verdicts)} heartbeatAgeMs=${heartbeatAgeMs(dir) ?? 'none'} runnerAlive=${lock?.pid ? isAlive(lock.pid) : 'no-lock'} last=[${last}]`;
}

function spawnNode(args, env = {}) {
  return spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
}

// Kill and WAIT. A fire-and-forget taskkill resolves its pid when the child
// actually runs, so a pid that died and was recycled onto a later fixture would
// be killed by the previous test's cleanup. Blocking closes that window, and
// matches every other taskkill call site in this repo.
function killTree(pid) {
  if (typeof pid !== 'number') return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

function readWorklog(dir) {
  try {
    return fs
      .readFileSync(worklogPath(dir), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const noopKeepAwake = () => () => {};

describe('goal runner kill/resume', () => {
  it('loses at most one unit of work when killed mid-phase', async () => {
    const dir = makeDir('antifan-goal-kill-');
    let child = null;
    try {
      child = spawnNode([RUNNER, dir, '--ladder', LADDER_FIXTURE, '--heartbeat-ms', '30000'], {
        GOAL_FIXTURE_UNITS: '6',
        GOAL_FIXTURE_UNIT_MS: '400',
      });
      child.stderr.on('data', () => {});

      // Wait until two units have actually completed, then hard-kill mid-run.
      const twoDone = await waitForProgress(dir, () => {
        const cp = readRecord(checkpointPath(dir));
        return cp && cp.ladder.filter((u) => u.verdict === 'PASS').length >= 2;
      });
      assert.ok(
        twoDone.ok,
        `runner never completed two units (${
          twoDone.stalled ? `stalled ${twoDone.stalledMs}ms and exhausted the hard budget` : 'hard budget exhausted'
        }): ${describeRun(dir)}`,
      );

      // Hard-kill the whole tree — the same thing the supervisor does, so the
      // keep-awake child is not orphaned by the test.
      killTree(child.pid);
      await waitFor(() => !isAlive(child.pid));

      const preKill = readRecord(checkpointPath(dir));
      const passedBeforeKill = preKill.ladder.filter((u) => u.verdict === 'PASS').map((u) => u.itemId);
      assert.ok(passedBeforeKill.length >= 2, 'checkpoint lost the completed units');

      // Resume: a new runner process over the same dir.
      const child2 = spawnNode([RUNNER, dir, '--ladder', LADDER_FIXTURE, '--heartbeat-ms', '30000'], {
        GOAL_FIXTURE_UNITS: '6',
        GOAL_FIXTURE_UNIT_MS: '400',
      });
      child2.stderr.on('data', () => {});
      // Bounded: an unbounded `once('exit')` would hang the whole lane if the
      // resumed runner wedged, and a hang names nothing.
      const exited = await waitFor(() => child2.exitCode !== null || child2.signalCode !== null, { timeoutMs: 120_000 });
      assert.ok(exited, `resumed runner never exited: ${describeRun(dir)}`);
      assert.strictEqual(
        child2.exitCode,
        0,
        `resumed runner did not exit cleanly (code=${child2.exitCode} signal=${child2.signalCode})`,
      );

      const worklog = readWorklog(dir);
      const starts = worklog.filter((e) => e.type === 'unit-start');
      const startCount = new Map();
      for (const s of starts) startCount.set(s.itemId, (startCount.get(s.itemId) ?? 0) + 1);

      // No unit judged PASS before the kill may ever start again.
      for (const id of passedBeforeKill) {
        assert.strictEqual(startCount.get(id), 1, `unit ${id} was re-run after PASS`);
      }
      // At most one unit — the one in flight at the kill — may have started twice.
      assert.ok(starts.length <= 7, `expected <=7 unit starts for 6 units, got ${starts.length}`);

      const final = readRecord(checkpointPath(dir));
      assert.strictEqual(final.ladder.length, 6);
      for (const u of final.ladder) {
        assert.strictEqual(u.verdict, 'PASS', `${u.itemId} did not reach PASS`);
        assert.strictEqual(u.attempt, 1, `${u.itemId} has attempt ${u.attempt} — judged work was redone`);
      }
      const summary = readRecord(runSummaryPath(dir));
      assert.strictEqual(summary.status, 'completed');
    } finally {
      if (child && isAlive(child.pid)) killTree(child.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('external supervisor', () => {
  it('kills a deadlocked runner and its whole process tree on heartbeat staleness', async () => {
    const dir = makeDir('antifan-sup-stall-');
    let runner = null;
    let sup = null;
    try {
      runner = spawnNode([DEADLOCK_FIXTURE], { GOAL_DIR: dir, GOAL_MODE: 'stall' });
      runner.stderr.on('data', () => {});
      const hbSeen = await waitFor(() => readRecord(heartbeatPath(dir)) !== null);
      assert.ok(hbSeen, 'deadlocked runner never wrote a heartbeat');
      const grandchildPid = Number(fs.readFileSync(path.join(dir, 'grandchild.pid'), 'utf8'));
      assert.ok(isAlive(grandchildPid), 'grandchild did not start');

      // The supervisor is a separate OS process — the arrangement the contract
      // requires, not a function inside the runner.
      sup = spawnNode([SUPERVISOR, dir, '--pid', String(runner.pid), '--poll-ms', '100', '--stale-ms', '800', '--bootstrap-ms', '60000', '--grace-ms', '300']);
      sup.stderr.on('data', () => {});

      const killed = await waitFor(() => !isAlive(runner.pid), { timeoutMs: 20_000 });
      assert.ok(killed, 'supervisor did not kill the stalled runner');
      const treeKilled = await waitFor(() => !isAlive(grandchildPid), { timeoutMs: 10_000 });
      assert.ok(treeKilled, 'supervisor killed the leader but left the process tree alive');

      const verdictSeen = await waitFor(() => readRecord(supervisorVerdictPath(dir)) !== null, { timeoutMs: 10_000 });
      assert.ok(verdictSeen, 'supervisor never wrote its verdict record');
      const verdict = readRecord(supervisorVerdictPath(dir));
      assert.strictEqual(verdict.outcome, 'killed');
      assert.strictEqual(verdict.reason, 'HEARTBEAT_STALE');
      assert.strictEqual(verdict.pid, runner.pid);
    } finally {
      if (runner && isAlive(runner.pid)) killTree(runner.pid);
      if (sup && isAlive(sup.pid)) killTree(sup.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces the bootstrap ceiling while heartbeats stay fresh but the watchdog never arms', async () => {
    const dir = makeDir('antifan-sup-boot-');
    let runner = null;
    let sup = null;
    try {
      runner = spawnNode([DEADLOCK_FIXTURE], { GOAL_DIR: dir, GOAL_MODE: 'heartbeat', GOAL_HB_MS: '150' });
      runner.stderr.on('data', () => {});
      const hbSeen = await waitFor(() => readRecord(heartbeatPath(dir)) !== null);
      assert.ok(hbSeen, 'runner never wrote a heartbeat');

      sup = spawnNode([SUPERVISOR, dir, '--pid', String(runner.pid), '--poll-ms', '100', '--stale-ms', '60000', '--bootstrap-ms', '1200', '--grace-ms', '300']);
      sup.stderr.on('data', () => {});

      const killed = await waitFor(() => !isAlive(runner.pid), { timeoutMs: 20_000 });
      assert.ok(killed, 'supervisor did not enforce the bootstrap ceiling');
      const verdictSeen = await waitFor(() => readRecord(supervisorVerdictPath(dir)) !== null, { timeoutMs: 10_000 });
      assert.ok(verdictSeen, 'supervisor never wrote its verdict record');
      const verdict = readRecord(supervisorVerdictPath(dir));
      assert.strictEqual(verdict.outcome, 'killed');
      assert.strictEqual(verdict.reason, 'BOOTSTRAP_CEILING');
    } finally {
      if (runner && isAlive(runner.pid)) killTree(runner.pid);
      if (sup && isAlive(sup.pid)) killTree(sup.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits without killing when the runner reports done', async () => {
    const dir = makeDir('antifan-sup-done-');
    try {
      writeRecordAtomic(heartbeatPath(dir), { pid: process.pid, atMs: Date.now(), done: true });
      const sup = spawnNode([SUPERVISOR, dir, '--pid', String(process.pid), '--poll-ms', '100']);
      sup.stderr.on('data', () => {});
      const exited = await waitFor(() => !isAlive(sup.pid), { timeoutMs: 10_000 });
      assert.ok(exited, 'supervisor did not exit on a done heartbeat');
      const verdict = readRecord(supervisorVerdictPath(dir));
      assert.strictEqual(verdict.outcome, 'done');
      assert.ok(isAlive(process.pid), 'supervisor killed a process it should not have');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A heartbeat and a lock both outlive the run that wrote them. Discovering the
  // target from those files (no --pid) must therefore attribute them to a run: an
  // unattributed `done:true` left by a previous run would otherwise end
  // supervision of the new run in its first poll, leaving it unguarded.
  it('does not treat a previous run’s done heartbeat as this run finishing', async () => {
    const dir = makeDir('antifan-sup-leftover-');
    try {
      // Previous run's leftovers only: no lock, so nothing names a process for
      // this supervisor to adopt or kill.
      writeRecordAtomic(heartbeatPath(dir), {
        // A pid that is not this test process, so a regression in attribution
        // cannot make the supervisor signal the test runner.
        pid: 999999,
        atMs: Date.now(),
        runId: 'run-previous',
        done: true,
      });

      const sup = spawnNode([SUPERVISOR, dir, '--poll-ms', '100', '--bootstrap-ms', '800', '--grace-ms', '200']);
      sup.stderr.on('data', () => {});
      const exited = await waitFor(() => !isAlive(sup.pid), { timeoutMs: 15_000 });
      assert.ok(exited, 'supervisor never reached a verdict');

      const verdict = readRecord(supervisorVerdictPath(dir));
      assert.notStrictEqual(verdict.outcome, 'done', 'a stale done heartbeat ended supervision');
      assert.strictEqual(verdict.reason, 'BOOTSTRAP_CEILING');
      assert.strictEqual(verdict.outcome, 'no-runner', 'nothing was adopted from the stale heartbeat');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours a done heartbeat attributed to the run it supervises', async () => {
    const dir = makeDir('antifan-sup-attributed-');
    // A real process stands in for the run, so this test can never signal itself.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeRecordAtomic(path.join(dir, 'goal-runner.lock'), { pid: holder.pid, runId: 'run-abc', atMs: Date.now() });
      writeRecordAtomic(heartbeatPath(dir), { pid: holder.pid, atMs: Date.now(), runId: 'run-abc', done: true });
      const sup = spawnNode([SUPERVISOR, dir, '--poll-ms', '100']);
      sup.stderr.on('data', () => {});
      const exited = await waitFor(() => !isAlive(sup.pid), { timeoutMs: 10_000 });
      assert.ok(exited, 'supervisor did not exit on an attributed done heartbeat');
      assert.strictEqual(readRecord(supervisorVerdictPath(dir)).outcome, 'done');
      assert.ok(isAlive(holder.pid), 'supervisor killed the run it was told had finished');
    } finally {
      if (holder && isAlive(holder.pid)) killTree(holder.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runner mutex', () => {
  it('refuses to start while a live external PID holds the lock', async () => {
    const dir = makeDir('antifan-mutex-e2e-');
    let holder = null;
    try {
      holder = spawnNode([DEADLOCK_FIXTURE], { GOAL_DIR: dir, GOAL_MODE: 'heartbeat', GOAL_HB_MS: '500' });
      holder.stderr.on('data', () => {});
      const locked = await waitFor(() => {
        const lock = readRecord(path.join(dir, 'goal-runner.lock'));
        return lock && lock.pid === holder.pid;
      });
      assert.ok(locked, 'fixture did not take the mutex');

      const result = await runGoal({
        dir,
        spec: { phases: [{ phaseId: 'p1', items: [{ itemId: 'u1', run: async () => ({ verdict: 'PASS' }) }] }] },
        keepAwake: noopKeepAwake,
      });
      assert.strictEqual(result.status, 'refused');
      assert.strictEqual(result.reason, 'MUTEX_HELD');
      assert.strictEqual(result.holderPid, holder.pid);
    } finally {
      if (holder && isAlive(holder.pid)) killTree(holder.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A lock can be reclaimed by a later runner that judged this one stale. Once
  // that happens the run must stop: two runners advancing one checkpoint would
  // each believe they own the ladder.
  it('aborts when the lock is taken over mid-run', async () => {
    const dir = makeDir('antifan-mutex-lost-');
    try {
      const spec = {
        phases: [
          {
            phaseId: 'p1',
            items: Array.from({ length: 8 }, (_, i) => ({
              itemId: `u${i + 1}`,
              run: async () => {
                await sleep(60);
                return { verdict: 'PASS' };
              },
            })),
          },
        ],
      };
      const running = runGoal({ dir, spec, keepAwake: noopKeepAwake, heartbeatIntervalMs: 40 });
      const lock = path.join(dir, 'goal-runner.lock');
      assert.ok(await waitFor(() => fs.existsSync(lock)), 'the runner never took the lock');
      // Take the lock over the way a reclaiming runner would.
      writeRecordAtomic(lock, { pid: 999999, runId: 'thief', atMs: Date.now() });

      const result = await running;
      assert.strictEqual(result.status, 'aborted');
      assert.strictEqual(result.reason, 'MUTEX_LOST');
      assert.strictEqual(readRecord(lock).runId, 'thief', 'the loser left the new holder its lock');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runner abort gates', () => {
  const passSpec = (n, prefix = 'u') => ({
    phases: [{ phaseId: 'p1', items: Array.from({ length: n }, (_, i) => ({ itemId: `${prefix}${i + 1}`, run: async () => ({ verdict: 'PASS' }) })) }],
  });

  // The artifact directory is recursively deleted on PASS, and both path
  // segments come from the spec, so an id that walks upward must be refused
  // before anything is created.
  it('refuses a spec whose item id resolves outside the run artifacts root', async () => {
    const dir = makeDir('antifan-artifact-escape-');
    try {
      const spec = {
        phases: [{ phaseId: 'p1', items: [{ itemId: path.join('..', '..', 'escaped'), run: async () => ({ verdict: 'PASS' }) }] }],
      };
      const result = await runGoal({ dir, spec, keepAwake: noopKeepAwake });
      assert.strictEqual(result.status, 'aborted');
      assert.strictEqual(result.reason, 'ARTIFACT_DIR_ESCAPES_RUN');
      assert.strictEqual(fs.existsSync(path.join(dir, 'escaped')), false, 'nothing was created outside artifacts/');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prune refuses an entry outside the run artifacts root', () => {
    const root = makeDir('antifan-prune-root-');
    const outside = makeDir('antifan-prune-outside-');
    try {
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'irreplaceable');
      const report = pruneRunArtifacts(
        [{ dir: outside, verdict: 'PASS', summary: { verdict: 'PASS' } }],
        { root: path.join(root, 'artifacts') },
      );
      assert.strictEqual(report.entries[0].action, 'refused-outside-root');
      assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'irreplaceable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('aborts with CONSECUTIVE_VERIFY_FAILURES and stops starting units', async () => {
    const dir = makeDir('antifan-abort-fail-');
    try {
      const spec = {
        phases: [
          {
            phaseId: 'p1',
            items: [
              { itemId: 'f1', run: async () => ({ verdict: 'FAIL' }) },
              { itemId: 'f2', run: async () => ({ verdict: 'FAIL' }) },
              { itemId: 'f3', run: async () => ({ verdict: 'FAIL' }) },
              { itemId: 'never', run: async () => ({ verdict: 'PASS' }) },
            ],
          },
        ],
      };
      const result = await runGoal({ dir, spec, keepAwake: noopKeepAwake });
      assert.strictEqual(result.status, 'aborted');
      assert.strictEqual(result.reason, 'CONSECUTIVE_VERIFY_FAILURES');
      const cp = readRecord(checkpointPath(dir));
      assert.strictEqual(cp.ladder.find((u) => u.itemId === 'never').verdict, null, 'a unit ran after the abort gate fired');
      const summary = readRecord(runSummaryPath(dir));
      assert.strictEqual(summary.status, 'aborted');
      assert.strictEqual(summary.reason, 'CONSECUTIVE_VERIFY_FAILURES');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts with HEARTBEAT_STALE when the heartbeat file is aged externally', async () => {
    const dir = makeDir('antifan-abort-hb-');
    try {
      const spec = {
        phases: [
          {
            phaseId: 'p1',
            items: [
              {
                itemId: 'u1',
                run: async () => {
                  // Age the heartbeat file while the unit runs — the next gate
                  // must see the staleness before the runner refreshes it.
                  const hb = readRecord(heartbeatPath(dir));
                  hb.atMs = Date.now() - 10 * 60_000;
                  writeRecordAtomic(heartbeatPath(dir), hb);
                  return { verdict: 'PASS' };
                },
              },
              { itemId: 'u2', run: async () => ({ verdict: 'PASS' }) },
            ],
          },
        ],
      };
      const result = await runGoal({ dir, spec, keepAwake: noopKeepAwake, heartbeatIntervalMs: 60_000 });
      assert.strictEqual(result.status, 'aborted');
      assert.strictEqual(result.reason, 'HEARTBEAT_STALE');
      const cp = readRecord(checkpointPath(dir));
      assert.strictEqual(cp.ladder.find((u) => u.itemId === 'u2').verdict, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts with CRITERIA_DRIFT when a resumed run is handed weakened criteria', async () => {
    const dir = makeDir('antifan-abort-drift-');
    try {
      // First run: abort mid-ladder via three FAILs so units remain pending.
      const failing = {
        phases: [
          {
            phaseId: 'p1',
            items: [
              { itemId: 'f1', run: async () => ({ verdict: 'FAIL' }) },
              { itemId: 'f2', run: async () => ({ verdict: 'FAIL' }) },
              { itemId: 'f3', run: async () => ({ verdict: 'FAIL' }) },
              { itemId: 'pending', run: async () => ({ verdict: 'PASS' }) },
            ],
          },
        ],
      };
      const strong = '- coverage must be >= 80\n- must verify receipts';
      const first = await runGoal({ dir, spec: failing, criteria: strong, keepAwake: noopKeepAwake });
      assert.strictEqual(first.status, 'aborted');
      assert.strictEqual(first.reason, 'CONSECUTIVE_VERIFY_FAILURES');

      // Resume with a weakened criterion: the drift gate must fire before the
      // pending unit is allowed to start.
      const weakened = '- coverage must be >= 40\n- must verify receipts';
      const second = await runGoal({ dir, spec: passSpec(1, 'new'), criteria: weakened, keepAwake: noopKeepAwake });
      assert.strictEqual(second.status, 'aborted');
      assert.strictEqual(second.reason, 'CRITERIA_DRIFT');
      const worklog = readWorklog(dir);
      assert.ok(!worklog.some((e) => e.type === 'unit-start' && e.itemId === 'new1'), 'a unit started after criteria drift was detected');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Omitting --criteria on a resume would otherwise skip the drift detector
  // entirely, which is the exact move that bypasses the weakened-criteria abort.
  it('refuses a resume that omits the criteria the checkpoint was taken under', async () => {
    const dir = makeDir('antifan-criteria-missing-');
    try {
      const failing = {
        phases: [
          {
            phaseId: 'p1',
            items: [
              { itemId: 'f1', run: async () => ({ verdict: 'FAIL' }) },
              { itemId: 'f2', run: async () => ({ verdict: 'FAIL' }) },
              { itemId: 'f3', run: async () => ({ verdict: 'FAIL' }) },
              { itemId: 'pending', run: async () => ({ verdict: 'PASS' }) },
            ],
          },
        ],
      };
      const first = await runGoal({ dir, spec: failing, criteria: '- coverage must be >= 80', keepAwake: noopKeepAwake });
      assert.strictEqual(first.status, 'aborted');
      assert.strictEqual(first.reason, 'CONSECUTIVE_VERIFY_FAILURES');

      // No criteria supplied: refused, and no unit is started.
      const second = await runGoal({ dir, spec: passSpec(1, 'new'), keepAwake: noopKeepAwake });
      assert.strictEqual(second.status, 'refused');
      assert.strictEqual(second.reason, 'CRITERIA_MISSING');
      const worklog = readWorklog(dir);
      assert.ok(!worklog.some((e) => e.type === 'unit-start' && e.itemId === 'new1'), 'no unit may start while the criteria are unverified');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to resume a checkpoint written under different bounds', async () => {
    const dir = makeDir('antifan-refuse-digest-');
    try {
      const first = await runGoal({ dir, spec: passSpec(1), keepAwake: noopKeepAwake });
      assert.strictEqual(first.status, 'completed');
      const cp = readRecord(checkpointPath(dir));
      cp.thresholdDigest = 'deadbeef';
      writeRecordAtomic(checkpointPath(dir), cp);
      const second = await runGoal({ dir, spec: passSpec(1), keepAwake: noopKeepAwake });
      assert.strictEqual(second.status, 'refused');
      assert.strictEqual(second.reason, 'CHECKPOINT_REFUSED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
