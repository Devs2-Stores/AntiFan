// wait-any: a job dispatched AFTER the waiter started must still wake it (11/11/2026: a close round
// dispatched while wait-any ran was never reported until the user asked).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { CLI, cleanup, dispatch, initJob, world, writeRun } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const runWaitAny = (w) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "wait-any", "--poll-ms", "200", "--timeout-min", "0.5"], { env: w.env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, lines: out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) }));
  });

describe("wait-any rescan", () => {
  test("a job dispatched after the waiter started wakes it when it settles", async () => {
    const w = world();
    const a = initJob(w, "slow");
    const b = initJob(w, "late");
    assert.equal(dispatch(w, a, "terminal-7").code, 0);
    writeRun(w, "terminal-7", { ompSessionId: "omp-new", state: "running", runSeq: 1, lastEventAt: Date.now() + 5000 });
    const waiter = runWaitAny(w);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(dispatch(w, b, "terminal-8").code, 0);
    writeRun(w, "terminal-8", { ompSessionId: "omp-new", state: "idle", runSeq: 1, lastEventAt: Date.now() + 60_000 });
    const r = await waiter;
    assert.equal(r.code, 0);
    const first = r.lines.find((l) => l.cmd === "wait-any");
    assert.equal(first.event, "first");
    assert.equal(first.job, path.basename(b.dir));
    assert.equal(first.stillWatching, 1);
  });
});
