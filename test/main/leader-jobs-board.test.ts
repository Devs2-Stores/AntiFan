/**
 * Main's read of the Leader job ledger for the Worker board: rows per Leader terminal, derived by
 * `scripts/leader/board.mjs` from a jobs root and a runs dir given by the same environment overrides the
 * scripts use. It never throws and never lists a closed or broken job.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';

installElectronStub();

import { readLeaderJobsBoard } from '../../src/main/leader/leader-jobs-board';

const LEADER = 'terminal-1';
const WORKER = 'terminal-2';

let root = '';
let jobsRoot = '';
let runsDir = '';
let env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-jobs-board-'));
  jobsRoot = path.join(root, 'jobs');
  runsDir = path.join(root, 'runs');
  fs.mkdirSync(jobsRoot, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  env = { LEADER_JOBS_ROOT: jobsRoot, LEADER_RUNS_DIR: runsDir };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJob(name: string, fields: Record<string, unknown>): string {
  const dir = path.join(jobsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, 'round-1.report.md');
  fs.writeFileSync(
    path.join(dir, 'job.json'),
    JSON.stringify({
      schema: 'leader-job/1',
      job: name,
      state: 'dispatched',
      leader: { terminal: LEADER },
      createdAt: Date.now() - 600_000,
      updatedAt: Date.now() - 60_000,
      rounds: [{ n: 1, kind: 'work', worker: { terminal: WORKER }, reportPath, dispatchedAt: Date.now() - 300_000 }],
      ...fields,
    }),
  );
  return reportPath;
}

function writeRun(terminal: string, run: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runsDir, `${terminal}.json`), JSON.stringify(run));
}

describe('readLeaderJobsBoard', () => {
  it('returns the job with its round, state and worker silence', async () => {
    const now = Date.now();
    writeJob('fix-header', {});
    writeRun(WORKER, { state: 'running', lastEventAt: now - 12 * 60_000, lastTool: 'bash', runSeq: 1 });

    const board = await readLeaderJobsBoard({ leaders: [LEADER], now, env });
    const rows = board[LEADER] ?? [];
    assert.strictEqual(rows.length, 1);
    const row = rows[0]!;
    assert.strictEqual(row.job, 'fix-header');
    assert.strictEqual(row.state, 'dispatched');
    assert.strictEqual(row.round, 1);
    assert.strictEqual(row.kind, 'work');
    assert.strictEqual(row.worker, WORKER);
    assert.strictEqual(row.silentMin, 12);
    assert.strictEqual(row.lastTool, 'bash');
    assert.strictEqual(row.reportStatus, null);
    assert.strictEqual(row.needsMe, false);
  });

  it('marks needsMe when a report newer than the dispatch starts with STATUS: NEEDS_INPUT', async () => {
    const report = writeJob('asks', {});
    writeRun(WORKER, { state: 'running', lastEventAt: Date.now(), runSeq: 1 });
    fs.writeFileSync(report, 'STATUS: NEEDS_INPUT\nwhich theme?\n');

    const rows = (await readLeaderJobsBoard({ leaders: [LEADER], env }))[LEADER] ?? [];
    assert.strictEqual(rows[0]?.reportStatus, 'NEEDS_INPUT');
    assert.strictEqual(rows[0]?.needsMe, true);
    assert.strictEqual(rows[0]?.state, 'dispatched');
  });

  it('ignores a report older than the dispatch', async () => {
    const report = writeJob('stale-report', {});
    fs.writeFileSync(report, 'STATUS: NEEDS_INPUT\n');
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(report, old, old);

    const rows = (await readLeaderJobsBoard({ leaders: [LEADER], env }))[LEADER] ?? [];
    assert.strictEqual(rows[0]?.reportStatus, null);
    assert.strictEqual(rows[0]?.needsMe, false);
  });

  it('skips a closed job, a malformed job.json and another Leader\'s job without throwing', async () => {
    writeJob('closed-job', { state: 'closed' });
    writeJob('other-leader', { leader: { terminal: 'terminal-9' } });
    writeJob('live', {});
    fs.mkdirSync(path.join(jobsRoot, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(jobsRoot, 'broken', 'job.json'), '{"schema":"leader-job/1", "rounds": [');

    const rows = (await readLeaderJobsBoard({ leaders: [LEADER], env }))[LEADER] ?? [];
    assert.deepStrictEqual(rows.map((r) => r.job), ['live']);
  });

  it('answers an empty list for a missing jobs root', async () => {
    const board = await readLeaderJobsBoard({ leaders: [LEADER], env: { ...env, LEADER_JOBS_ROOT: path.join(root, 'absent') } });
    assert.deepStrictEqual(board, { [LEADER]: [] });
  });

  it('rejects a Leader id that is not a plain terminal id', async () => {
    writeJob('live', {});
    const board = await readLeaderJobsBoard({ leaders: ['../escape', 'a b', '', LEADER], env });
    assert.deepStrictEqual(Object.keys(board), [LEADER]);
  });

  it('groups one ledger read by Leader and survives a job that names a prototype key as its Leader', async () => {
    writeJob('mine', {});
    writeJob('theirs', { leader: { terminal: 'terminal-9' } });
    writeJob('hostile', { leader: { terminal: 'constructor' } });

    const board = await readLeaderJobsBoard({ leaders: [LEADER, 'terminal-9'], env });
    assert.deepStrictEqual(Object.keys(board).sort(), [LEADER, 'terminal-9'].sort());
    assert.deepStrictEqual(board[LEADER]?.map((r) => r.job), ['mine']);
    assert.deepStrictEqual(board['terminal-9']?.map((r) => r.job), ['theirs']);
  });
});
