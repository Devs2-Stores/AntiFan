// worker_dead recovery: a dead round with a valid report is accepted, a dead close round can be dispatched again,
// and an ad-hoc job in worker_dead has a stated way to close.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { cleanup, cli, dispatch, initJob, verifiedJob, world, writeReport } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const ageRound = (j, index, ms = 10 * 60_000) => {
  const job = j.job();
  job.rounds[index].dispatchedAt = Date.now() - ms;
  fs.writeFileSync(path.join(j.dir, "job.json"), JSON.stringify(job));
};
const rmRun = (w, terminal) => fs.rmSync(path.join(w.runs, `${terminal}.json`), { force: true });
const waitNow = (w, j) => cli(w, ["wait", "--job", j.dir, "--poll-ms", "20", "--timeout-min", "0.05"]);

describe("a dead round whose report is valid", () => {
  test("validate-report accepts the report, settles the round and the job moves on", () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    rmRun(w, "terminal-7");
    ageRound(j, 0);
    const waited = waitNow(w, j);
    assert.equal(waited.code, 6, waited.stderr);
    assert.equal(j.job().state, "worker_dead");

    writeReport(j, 1);
    const v = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(v.code, 0, v.stderr);
    assert.ok(v.last.recoveredFromDead, "the report says it was recovered");
    assert.match(v.last.recoveredFromDead.why, /run file gone/);
    const job = j.job();
    assert.equal(job.state, "reported");
    assert.ok(job.rounds[0].settledAt > 0);
    assert.equal(job.rounds[0].deadAt, undefined, "the round is no longer dead");
    assert.ok(job.rounds[0].deadRecoveredFrom, "the old verdict stays in the ledger");

    const rec = cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "dashboard", "--status", "PASS"]);
    assert.equal(rec.last.state, "verified", "the normal verification path still runs");
  });

  test("a dead round whose report does not pass the checks keeps the dead verdict", () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    rmRun(w, "terminal-7");
    ageRound(j, 0);
    assert.equal(waitNow(w, j).code, 6);
    const job = j.job();
    fs.writeFileSync(job.rounds[0].reportPath, "STATUS: DONE\n\nno json block\n");
    const v = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(v.code, 1);
    assert.match(v.last.errors.join("\n"), /no usable report: its worker died/);
    assert.equal(v.last.recoveredFromDead, undefined);
    assert.equal(j.job().state, "worker_dead");
  });
});

describe("a dead close round", () => {
  test("returns the job to user-approved and the close can be dispatched again to a fresh worker", () => {
    const w = world();
    const j = initJob(w);
    verifiedJob(w, j);
    assert.equal(cli(w, ["approve", "--job", j.dir]).code, 0);
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "close"]);
    assert.equal(d.code, 0, d.stderr);
    rmRun(w, "terminal-7");
    ageRound(j, 1);
    const waited = waitNow(w, j);
    assert.equal(waited.code, 6, waited.stderr);
    assert.equal(waited.last.kind, "close");
    assert.equal(j.job().state, "user-approved", "a dead close round keeps the approval it was dispatched from");
    assert.equal(j.job().approval.tokenUsedAt, null, "a dead round never spends the close token");

    const status = cli(w, ["status", "--job", j.dir]);
    assert.match(status.lines[0].blocking, /close round 2 died/);
    const next = cli(w, ["next", "--job", j.dir]);
    assert.match(next.last.next.join("\n"), /--kind close/);

    const again = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-8", "--kind", "close"]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.last.round, 3);
    assert.equal(j.job().state, "dispatched");
  });
});

describe("an ad-hoc job in worker_dead", () => {
  test("names the way out and close --force is that way", () => {
    const w = world();
    const init = cli(w, ["init", "--kind", "adhoc", "--slug", "cleanup"]);
    assert.equal(init.code, 0, init.stderr);
    const dir = init.last.jobDir;
    const prompt = path.join(w.root, "adhoc.md");
    fs.writeFileSync(prompt, `Dọn file tạm của job ${path.basename(dir)}.\nGhi report vào {{REPORT_PATH}}\n`);
    const d = cli(w, ["dispatch", "--job", dir, "--worker", "terminal-7", "--prompt", prompt]);
    assert.equal(d.code, 0, d.stderr);
    const j = { dir, job: () => JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")) };
    rmRun(w, "terminal-7");
    ageRound(j, 0);
    assert.equal(waitNow(w, j).code, 6);
    assert.equal(j.job().state, "worker_dead");

    const next = cli(w, ["next", "--job", dir]);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(next.last.state, "worker_dead");
    assert.match(next.last.blocking, /close --force/);
    assert.match(next.last.next.join("\n"), /close --job .* --force/);

    const noForce = cli(w, ["close", "--job", dir]);
    assert.equal(noForce.code, 4);
    assert.match(noForce.stderr, /worker_dead/);
    assert.match(noForce.stderr, /--force/);

    const forced = cli(w, ["close", "--job", dir, "--force"]);
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(j.job().state, "closed");
  });
});
