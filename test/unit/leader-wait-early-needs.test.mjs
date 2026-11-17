// `leader-job wait`: a worker that rewrites line 1 of its report to STATUS: NEEDS_INPUT while it is still running wakes the waiter once per rewrite.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, test } from "node:test";

import { cleanup, cli, dispatch, initJob, world, writeRun } from "./leader-job-cli-helpers.mjs";

after(cleanup);

describe("wait: early NEEDS_INPUT in the report of a running worker", () => {
  test("wakes once, keeps the job dispatched, and fires again only after a rewrite", () => {
    const w = world();
    const j = initJob(w, "early");
    writeRun(w, "terminal-7", { state: "idle", runSeq: 0, lastEventAt: 1 });
    const d = dispatch(w, j, "terminal-7");
    assert.equal(d.code, 0, d.stderr);
    const reportPath = d.last.reportPath;
    writeRun(w, "terminal-7", { state: "running", runSeq: 1, ompSessionId: "omp-new", pid: process.pid, lastEventAt: Date.now() + 5000 });
    const wait = () => cli(w, ["wait", "--job", j.dir, "--poll-ms", "20", "--timeout-min", "0.02"]);

    assert.equal(wait().last.event, "timeout", "no report yet: keeps waiting");

    fs.writeFileSync(reportPath, "STATUS: NEEDS_INPUT\ncần mật khẩu\n");
    const first = wait();
    assert.equal(first.code, 5, first.stderr);
    assert.equal(first.last.event, "needs-input");
    assert.equal(first.last.early, true);
    assert.equal(j.job().state, "dispatched");

    assert.equal(wait().last.event, "timeout", "same report line: no second wake");

    const later = new Date(Date.now() + 3000);
    fs.writeFileSync(reportPath, "STATUS: NEEDS_INPUT\nvẫn cần\n");
    fs.utimesSync(reportPath, later, later);
    assert.equal(wait().last.event, "needs-input");
  });

  test("a report that is not NEEDS_INPUT does not wake a running round", () => {
    const w = world();
    const j = initJob(w, "plain");
    writeRun(w, "terminal-7", { state: "idle", runSeq: 0, lastEventAt: 1 });
    const d = dispatch(w, j, "terminal-7");
    writeRun(w, "terminal-7", { state: "running", runSeq: 1, ompSessionId: "omp-new", pid: process.pid, lastEventAt: Date.now() + 5000 });
    fs.writeFileSync(d.last.reportPath, "STATUS: DONE\n");
    assert.equal(cli(w, ["wait", "--job", j.dir, "--poll-ms", "20", "--timeout-min", "0.02"]).last.event, "timeout");
  });
});
