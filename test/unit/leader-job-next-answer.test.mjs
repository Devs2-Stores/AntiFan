// next --job and answer --job: the ledger says which command works now, and a NEEDS_INPUT round has one documented way back.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { cleanup, cli, dispatch, initJob, settle, verifiedJob, world, writeReport, writeRun } from "./leader-job-cli-helpers.mjs";

after(cleanup);

describe("next --job", () => {
  test("names the state, what blocks it and the command that works in every state", () => {
    const w = world();
    const j = initJob(w);
    const nextNow = () => {
      const r = cli(w, ["next", "--job", j.dir]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.last.cmd, "next");
      assert.equal(r.last.state, j.job().state);
      return r.last;
    };

    let n = nextNow();
    assert.equal(n.state, "open");
    assert.match(n.blocking, /no round dispatched/);
    assert.match(n.next[0], /dispatch --job .* --worker/);

    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    n = nextNow();
    assert.equal(n.state, "dispatched");
    assert.match(n.next.join("\n"), /wait --job/);

    assert.equal(settle(w, j, "terminal-7", 1).code, 0);
    n = nextNow();
    assert.equal(n.state, "settled");
    assert.match(n.next[0], /validate-report/);

    writeReport(j, 1);
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 0);
    n = nextNow();
    assert.equal(n.state, "reported");
    assert.match(n.next.join("\n"), /record --job .* --kind dashboard/);

    assert.equal(cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "dashboard", "--status", "PASS"]).code, 0);
    n = nextNow();
    assert.equal(n.state, "verified");
    assert.match(n.next.join("\n"), /approve --job/);

    assert.equal(cli(w, ["approve", "--job", j.dir]).code, 0);
    n = nextNow();
    assert.equal(n.state, "user-approved");
    assert.match(n.next.join("\n"), /--kind close/);
  });

  test("a state or flag refusal carries the same hint: next: on stderr and a next field", () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    const missingKind = cli(w, ["record", "--job", j.dir, "--round", "1"]);
    assert.equal(missingKind.code, 2);
    assert.match(missingKind.stderr, /next:/);
    assert.match(missingKind.last.next, /record --job DIR --round N --kind dashboard\|storefront\|sheet\|adhoc/);
    assert.match(missingKind.last.next, /wait --job/, "the state hint is appended too");

    const badKind = cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "nope", "--status", "PASS"]);
    assert.equal(badKind.code, 2);
    assert.match(badKind.last.next, /--kind dashboard\|storefront\|sheet\|adhoc/);

    const w2 = world();
    const verified = initJob(w2);
    verifiedJob(w2, verified);
    const earlyClose = cli(w2, ["dispatch", "--job", verified.dir, "--worker", "terminal-8", "--kind", "close"]);
    assert.equal(earlyClose.code, 4);
    assert.match(earlyClose.last.next, /approve --job/);
    assert.match(earlyClose.stderr, /next:/);
  });
});

describe("answer", () => {
  const asked = (w) => {
    const j = initJob(w, "asked");
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    assert.equal(settle(w, j, "terminal-7", 1).code, 0);
    writeReport(j, 1, { status: "NEEDS_INPUT", needsInput: { question: "Sửa kiểu nào?", options: ["Cách 1", "Cách 2"] } });
    const v = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(j.job().state, "needs_input");
    return j;
  };

  test("reopens the round, records the answer and hands the Leader one message", () => {
    const w = world();
    const j = asked(w);
    const next = cli(w, ["next", "--job", j.dir]);
    assert.equal(next.last.state, "needs_input");
    assert.match(next.last.next[0], /answer --job .* --text/);
    assert.deepEqual(next.last.needsInput.options, ["Cách 1", "Cách 2"]);

    const wrong = cli(w, ["answer", "--job", j.dir, "--text", "chọn bừa", "--choice", "Cách 9"]);
    assert.equal(wrong.code, 4);
    assert.match(wrong.stderr, /not one of the options/);
    assert.match(wrong.stderr, /"Cách 1", "Cách 2"/);
    assert.equal(j.job().state, "needs_input", "a refused answer changes nothing");

    const a = cli(w, ["answer", "--job", j.dir, "--text", "dùng cách 2 nhé", "--choice", "Cách 2"]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.last.state, "dispatched", "wait watches this round again");
    assert.match(a.last.message, /Cách 2/);
    assert.match(a.last.message, /dùng cách 2 nhé/);
    assert.match(a.last.message, new RegExp(`Làm tiếp vòng 1 của job ${j.job().job}`));
    const job = j.job();
    assert.equal(job.state, "dispatched");
    assert.equal(job.rounds[0].settledAt, undefined, "the round is open again");
    assert.equal(job.rounds[0].report, undefined, "a fresh report is required for the new turn");
    assert.equal(job.rounds[0].answer.choice, "Cách 2");
    assert.equal(job.answers.length, 1);
    assert.equal(job.answers[0].round, 1);

    // The worker's next turn counts as that round's turn, so wait settles it normally.
    writeRun(w, "terminal-7", { ompSessionId: "omp-new", state: "idle", runSeq: 2, lastEventAt: Date.now() + 6000 });
    const waited = cli(w, ["wait", "--job", j.dir, "--poll-ms", "20", "--timeout-min", "0.05"]);
    assert.equal(waited.code, 0, waited.stderr);
    assert.equal(j.job().state, "settled");
    writeReport(j, 1);
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 0);
    assert.equal(j.job().state, "reported");
  });

  test("refuses a round that is not waiting for the user", () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    const r = cli(w, ["answer", "--job", j.dir, "--text", "trả lời"]);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /state is dispatched/);
    assert.equal(cli(w, ["answer", "--job", j.dir]).code, 2, "--text is required");
  });
});
