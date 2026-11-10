// close: an ended worker gets a moment for its run file to disappear, and a verified PENDING job closes with --without-done.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { CLI, cleanup, cli, dispatch, initJob, settle, verifiedJob, world, writeReport, writeRun } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const runFile = (w, terminal) => path.join(w.runs, `${terminal}.json`);

function approved(w, j) {
  verifiedJob(w, j);
  const a = cli(w, ["approve", "--job", j.dir]);
  assert.equal(a.code, 0, a.stderr);
}

describe("close", () => {
  test("waits for the run file of an ended worker to go away", async () => {
    const w = world();
    const j = initJob(w);
    approved(w, j);
    writeRun(w, "terminal-7", { state: "ended", runSeq: 1 });

    const child = spawn(process.execPath, [CLI, "close", "--job", j.dir, "--without-done", "--settle-ms", "5000"], { env: w.env });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    setTimeout(() => fs.rmSync(runFile(w, "terminal-7")), 400);
    const code = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(code, 0, err);
    assert.equal(j.job().state, "closed");
  });

  test("an ended worker whose terminal stays open is still refused after the settle time", () => {
    const w = world();
    const j = initJob(w);
    approved(w, j);
    writeRun(w, "terminal-7", { state: "ended", runSeq: 1 });

    const r = cli(w, ["close", "--job", j.dir, "--without-done", "--settle-ms", "300"]);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /still open: terminal-7/);
    assert.equal(j.job().state, "user-approved");
  });

  test("--without-done closes a verified job whose latest report is PENDING, not a verified DONE one", () => {
    const w = world();
    const done = initJob(w, "done", "1");
    verifiedJob(w, done);
    fs.rmSync(runFile(w, "terminal-7"));
    const refused = cli(w, ["close", "--job", done.dir, "--without-done"]);
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /user-approved/);

    const pending = initJob(w, "pending", "2");
    assert.equal(dispatch(w, pending, "terminal-8", "work").code, 0);
    settle(w, pending, "terminal-8", 1);
    writeReport(pending, 1, { status: "PENDING", dashboard: { commentsAdded: 1, stageBefore: "Feedback", stageAfter: "Pending" } });
    assert.equal(cli(w, ["validate-report", "--job", pending.dir]).code, 0);
    const rec = cli(w, ["record", "--job", pending.dir, "--round", "1", "--kind", "dashboard", "--status", "PASS"]);
    assert.equal(rec.last.state, "verified");
    fs.rmSync(runFile(w, "terminal-8"));

    const ok = cli(w, ["close", "--job", pending.dir, "--without-done"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(pending.job().state, "closed");
  });
});
