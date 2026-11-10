// leader-board-progress.test.mjs - the board answers "how far along is each job": round, kind, worker silence,
// last tool and line 1 of the round's report, read from files and tolerant of half-written ones.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { buildBoard } from "../../scripts/leader/board.mjs";
import { cleanup, cli, initJob, world, writeRun } from "./leader-job-cli-helpers.mjs";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "leader-board-progress-"));
after(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
  cleanup();
});

const NOW = 1_800_000_000_000;
let n = 0;

/** A jobs root + runs dir with one dispatched job (round 2, kind followup) whose report file is `reportText`. */
function fixture({ reportText, reportMtime, run, jobText }) {
  const root = path.join(TEMP, `f${++n}`);
  const jobs = path.join(root, "jobs");
  const runs = path.join(root, "runs");
  const dir = path.join(jobs, "260101-0000-j");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  const reportPath = path.join(dir, "j.r2.report.md");
  const dispatchedAt = NOW - 20 * 60_000;
  const job = {
    schema: "leader-job/1",
    job: "260101-0000-j",
    slug: "j",
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    leader: { terminal: "terminal-1" },
    subject: { kind: "adhoc", title: "t" },
    state: "dispatched",
    rounds: [
      { n: 1, kind: "work", worker: { terminal: "terminal-7" }, reportPath: path.join(dir, "j.report.md"), dispatchedAt: NOW - 90 * 60_000, settledAt: NOW - 60 * 60_000, preRunSeq: 0 },
      { n: 2, kind: "followup", worker: { terminal: "terminal-7" }, reportPath, dispatchedAt, settledAt: null, preRunSeq: 1 },
    ],
  };
  fs.writeFileSync(path.join(dir, "job.json"), jobText ?? JSON.stringify(job));
  if (reportText !== undefined) {
    fs.writeFileSync(reportPath, reportText);
    const t = new Date(reportMtime ?? dispatchedAt + 60_000);
    fs.utimesSync(reportPath, t, t);
  }
  if (run) fs.writeFileSync(path.join(runs, "terminal-7.json"), typeof run === "string" ? run : JSON.stringify(run));
  return { jobs, runs };
}

const row = (f) => buildBoard({ jobsRoot: f.jobs, runsDir: f.runs, leader: "terminal-1", now: NOW }).rows[0];

describe("board progress keys", () => {
  test("round, kind, worker, silence, last tool and report status come from the files", () => {
    const f = fixture({ reportText: "STATUS: DONE\nrest\n", run: { schema: 1, state: "running", runSeq: 2, lastEventAt: NOW - 12 * 60_000, lastTool: "bash" } });
    const r = row(f);
    assert.equal(r.round, 2);
    assert.equal(r.kind, "followup");
    assert.equal(r.roundsUsed, 2);
    assert.equal(r.worker, "terminal-7");
    assert.equal(r.runState, "running");
    assert.equal(r.silentMin, 12);
    assert.equal(r.lastTool, "bash");
    assert.equal(r.workerAlive, true);
    assert.equal(r.reportStatus, "DONE");
    assert.equal(r.needsMe, false);
    const text = buildBoard({ jobsRoot: f.jobs, runsDir: f.runs, leader: "terminal-1", now: NOW }).text;
    assert.match(text, /r2\/followup \| silent 12m \| STATUS: DONE/);
  });

  test("a live NEEDS_INPUT first line makes the job need the user while its state is still dispatched", () => {
    const f = fixture({ reportText: "STATUS: NEEDS_INPUT\nblocked\n", run: { schema: 1, state: "running", runSeq: 2, lastEventAt: NOW - 1000 } });
    const r = row(f);
    assert.equal(r.state, "dispatched");
    assert.equal(r.reportStatus, "NEEDS_INPUT");
    assert.equal(r.needsMe, true);
  });

  test("a report older than the round's dispatch gives no status", () => {
    const f = fixture({ reportText: "STATUS: DONE\n", reportMtime: NOW - 3 * 3_600_000, run: { schema: 1, state: "running", runSeq: 2, lastEventAt: NOW } });
    assert.equal(row(f).reportStatus, null);
  });

  test("a missing or half-written run file and a half-written report give nulls and never throw", () => {
    const missing = row(fixture({}));
    assert.equal(missing.round, 2);
    assert.equal(missing.silentMin, null);
    assert.equal(missing.lastTool, null);
    assert.equal(missing.runState, null);
    assert.equal(missing.workerAlive, null);
    assert.equal(missing.reportStatus, null);
    const half = row(fixture({ run: '{"state":"run', reportText: "" }));
    assert.equal(half.runState, null);
    assert.equal(half.reportStatus, null);
    const noJob = buildBoard({ jobsRoot: fixture({ jobText: '{"schema":"leader-job/1","rou' }).jobs, runsDir: "x", now: NOW });
    assert.deepEqual(noJob.rows, []);
  });
});

describe("needs-me and status through the CLI", () => {
  test("--text shows round/kind, silence and report status; status carries the same keys", () => {
    const w = world();
    const j = initJob(w, "prog");
    const prompt = path.join(w.root, "p.md");
    fs.writeFileSync(prompt, `Việc. issue 1 host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n`);
    writeRun(w, "terminal-7", { runSeq: 0, state: "idle", lastEventAt: Date.now() - 5 * 60_000, lastTool: "read" });
    assert.equal(cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", prompt]).code, 0);
    writeRun(w, "terminal-7", { runSeq: 0, state: "running", lastEventAt: Date.now() - 5 * 60_000, lastTool: "read" });
    fs.writeFileSync(j.job().rounds[0].reportPath, "STATUS: NEEDS_INPUT\nneed help\n");
    const t = cli(w, ["needs-me", "--text"]);
    assert.match(t.stdout, /! \S+ \| dispatched \| [\d.]+h \| r1\/work \| silent [45]m \| STATUS: NEEDS_INPUT/);
    const s = cli(w, ["status", "--job", j.dir]).lines[0];
    assert.equal(s.round, 1);
    assert.equal(s.kind, "work");
    assert.equal(s.lastTool, "read");
    assert.equal(s.reportStatus, "NEEDS_INPUT");
    assert.ok(s.silentMin === 4 || s.silentMin === 5);
    assert.equal(s.workerAlive, true);
  });
});

describe('all-Leaders board', () => {
  test('an omitted leader lists every Leader once, each row carries its Leader, order is the per-Leader order', () => {
    const f = fixture({ reportText: 'STATUS: DONE\n', run: { schema: 1, state: 'running', runSeq: 2, lastEventAt: NOW } });
    const dir2 = path.join(f.jobs, '260101-0001-k');
    fs.mkdirSync(dir2);
    const job2 = JSON.parse(fs.readFileSync(path.join(f.jobs, '260101-0000-j', 'job.json'), 'utf8'));
    Object.assign(job2, { job: '260101-0001-k', slug: 'k', leader: { terminal: 'terminal-2' }, state: 'needs_input', rounds: [] });
    fs.writeFileSync(path.join(dir2, 'job.json'), JSON.stringify(job2));
    const all = buildBoard({ jobsRoot: f.jobs, runsDir: f.runs, now: NOW });
    assert.deepEqual(all.rows.map((r) => [r.job, r.leader]), [['260101-0001-k', 'terminal-2'], ['260101-0000-j', 'terminal-1']]);
    assert.deepEqual(buildBoard({ jobsRoot: f.jobs, runsDir: f.runs, leader: null, now: NOW }).rows, all.rows);
    const one = buildBoard({ jobsRoot: f.jobs, runsDir: f.runs, leader: 'terminal-1', now: NOW });
    assert.deepEqual(one.rows.map((r) => r.job), ['260101-0000-j']);
    assert.equal('leader' in one.rows[0], false, 'per-Leader rows keep their old shape');
  });
});
