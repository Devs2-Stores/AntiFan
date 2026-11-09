// Review rounds: read-only advisory round that never alters the verification of the latest WORK round.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { REPO, cleanup, cli, dispatch, initJob, settle, verifiedJob, world, writeReport, writeRun } from "./leader-job-cli-helpers.mjs";

after(cleanup);

describe("review round", () => {
  test("refused when there is no work round to review", () => {
    const w = world();
    const j = initJob(w);
    const d = dispatch(w, j, "terminal-8", "review", "{{REVIEW_TARGETS}}");
    assert.equal(d.code, 4);
    assert.match(d.stderr, /nothing to review/);
  });

  test("REVIEW_TARGETS lists the report paths of the earlier non-review rounds", () => {
    const w = world();
    const j = initJob(w);
    verifiedJob(w, j);
    const d = dispatch(w, j, "terminal-8", "review", "TARGETS:\n{{REVIEW_TARGETS}}\nEND");
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.kind, "review");
    const prompt = fs.readFileSync(d.last.promptPath, "utf8");
    assert.ok(prompt.includes(`TARGETS:\n${j.job().rounds[0].reportPath}\nEND`), prompt);
    assert.equal(j.job().rounds[1].stateBefore, "verified");
  });

  test("a valid review needs a verdict; it returns the job to its state and never verifies or un-verifies the work round", () => {
    const w = world();
    const j = initJob(w);
    verifiedJob(w, j);
    assert.equal(dispatch(w, j, "terminal-8", "review", "{{REVIEW_TARGETS}}").code, 0);
    assert.equal(j.job().state, "dispatched");
    assert.equal(settle(w, j, "terminal-8", 1).code, 0);

    writeReport(j, 2, {});
    const noVerdict = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(noVerdict.code, 1);
    assert.match(noVerdict.stderr, /review/);

    writeReport(j, 2, { review: { verdict: "MAYBE", findings: [] } });
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 1);

    writeReport(j, 2, { review: { verdict: "FAIL", findings: ["no storefront proof"] } });
    const ok = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(ok.last.review, { verdict: "FAIL", findings: ["no storefront proof"] });
    let job = j.job();
    assert.equal(job.state, "verified", "state is back where the work round left it");
    assert.equal(job.rounds[1].report.required, undefined);
    assert.equal(job.rounds[0].verification.dashboard.status, "PASS");

    // recording on the review round verifies nothing and changes nothing
    const rec = cli(w, ["record", "--job", j.dir, "--round", "2", "--kind", "dashboard", "--status", "PASS"]);
    assert.equal(rec.last.state, "verified");
    assert.equal(rec.last.missing.length, 1);
    // approve still judges the WORK round, not the review
    const st = cli(w, ["status", "--job", j.dir]).lines.find((l) => l.job);
    assert.deepEqual(st.latestReview, { round: 2, verdict: "FAIL" });
    assert.equal(st.roundsUsed, 1);
    assert.equal(cli(w, ["approve", "--job", j.dir]).code, 0);
    job = j.job();
    assert.equal(job.state, "user-approved");
  });

  test("a review round never makes the job verified by itself", () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    assert.equal(settle(w, j, "terminal-7", 1).code, 0);
    writeReport(j, 1);
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 0);
    assert.equal(j.job().state, "reported");
    assert.equal(dispatch(w, j, "terminal-8", "review", "{{REVIEW_TARGETS}}").code, 0);
    assert.equal(settle(w, j, "terminal-8", 1).code, 0);
    writeReport(j, 2, { review: { verdict: "PASS", findings: [] } });
    assert.equal(cli(w, ["validate-report", "--job", j.dir, "--round", "2"]).code, 0);
    assert.equal(j.job().state, "reported");
    cli(w, ["record", "--job", j.dir, "--round", "2", "--kind", "dashboard", "--status", "PASS"]);
    assert.equal(j.job().state, "reported");
    assert.equal(cli(w, ["approve", "--job", j.dir]).code, 4);
    // verifying the work round (not the latest ROUND, but the latest WORK round) still gets the job verified
    assert.equal(cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "dashboard", "--status", "PASS"]).last.state, "verified");
  });

  test("the default prompt is templates/review-followup.md", { skip: !fs.existsSync(path.join(REPO, "scripts", "leader", "templates", "review-followup.md")) }, () => {
    const w = world();
    const j = initJob(w);
    verifiedJob(w, j);
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-8", "--kind", "review"]);
    assert.equal(d.code, 0, d.stderr);
    assert.ok(fs.readFileSync(d.last.promptPath, "utf8").includes(j.job().rounds[0].reportPath));
  });
});

describe('review rounds never move the job', () => {
  test('an invalid review report leaves a verified job verified', () => {
    const w = world();
    const j = initJob(w);
    verifiedJob(w, j);
    assert.equal(dispatch(w, j, 'terminal-8', 'review', '{{REVIEW_TARGETS}}').code, 0);
    assert.equal(settle(w, j, 'terminal-8', 1).code, 0);
    assert.equal(j.job().state, 'verified', 'wait restores the state');
    writeReport(j, 2, {});
    assert.equal(cli(w, ['validate-report', '--job', j.dir]).code, 1);
    assert.equal(j.job().state, 'verified');
  });

  test('a review that waits for the user does not make the job needs_input', () => {
    const w = world();
    const j = initJob(w);
    verifiedJob(w, j);
    assert.equal(dispatch(w, j, 'terminal-8', 'review', '{{REVIEW_TARGETS}}').code, 0);
    writeRun(w, 'terminal-8', { ompSessionId: 'omp-new', state: 'waiting_user', runSeq: 1, lastEventAt: Date.now() + 60_000 });
    const r = cli(w, ['wait', '--job', j.dir, '--poll-ms', '20', '--timeout-min', '0.05']);
    assert.equal(r.code, 5);
    assert.equal(j.job().state, 'verified');
  });

  test('a review dispatched while a work round is still running keeps the job dispatched, then settled', () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatch(w, j, 'terminal-7', 'work').code, 0);
    assert.equal(dispatch(w, j, 'terminal-8', 'review', '{{REVIEW_TARGETS}}').code, 0);
    assert.equal(j.job().rounds[1].stateBefore, 'dispatched');
    writeRun(w, 'terminal-8', { ompSessionId: 'omp-r', state: 'idle', runSeq: 1, lastEventAt: Date.now() + 60_000 });
    cli(w, ['wait', '--job', j.dir, '--poll-ms', '20', '--timeout-min', '0.03']);
    assert.equal(j.job().state, 'dispatched', 'the work round is still open');
    writeRun(w, 'terminal-7', { ompSessionId: 'omp-w', state: 'idle', runSeq: 1, lastEventAt: Date.now() + 60_000 });
    assert.equal(cli(w, ['wait', '--job', j.dir, '--poll-ms', '20', '--timeout-min', '0.05']).code, 0);
    assert.equal(j.job().state, 'settled');
  });
});
