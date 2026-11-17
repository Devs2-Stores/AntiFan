// Hard round ceilings (the 13-round runaway) and dispatch --cap / --forbid side-effect caps with the report echo check.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, test } from "node:test";

import { MAX_REVIEW_ROUNDS, MAX_TOTAL_ROUNDS, parseCaps } from "../../scripts/leader/leader-job.mjs";
import { validateCapsEcho } from "../../scripts/leader/report.mjs";
import { cleanup, cli, dispatch, initJob, settle, world, writeReport } from "./leader-job-cli-helpers.mjs";

after(cleanup);

describe("hard round ceilings", () => {
  test("--allow-extra-round cannot pass MAX_TOTAL_ROUNDS", () => {
    const w = world();
    const j = initJob(w);
    const extra = ["--allow-extra-round", "--reason", "one more"];
    for (let n = 1; n <= MAX_TOTAL_ROUNDS; n += 1) {
      const d = dispatch(w, j, "terminal-7", n === 1 ? "work" : "followup", "", n > 4 ? extra : []);
      assert.equal(d.code, 0, `round ${n}: ${d.stderr}`);
    }
    const refused = dispatch(w, j, "terminal-7", "followup", "", extra);
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /total round cap reached/);
    assert.equal(j.job().rounds.length, MAX_TOTAL_ROUNDS, "a refused dispatch appends nothing");
  });

  test("review rounds are capped at MAX_REVIEW_ROUNDS and count toward the total", () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    for (let n = 1; n <= MAX_REVIEW_ROUNDS; n += 1) {
      const r = dispatch(w, j, "terminal-8", "review", "{{REVIEW_TARGETS}}");
      assert.equal(r.code, 0, r.stderr);
    }
    const refused = dispatch(w, j, "terminal-8", "review", "{{REVIEW_TARGETS}}");
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /review cap reached/);
  });

  test("a close round is never blocked by the total ceiling", () => {
    const w = world();
    const j = initJob(w);
    for (let n = 1; n <= 4; n += 1) assert.equal(dispatch(w, j, "terminal-7", n === 1 ? "work" : "followup").code, 0);
    j.patch((job) => {
      for (let n = 5; n <= MAX_TOTAL_ROUNDS; n += 1) job.rounds.push({ ...job.rounds[0], n, kind: "review", settledAt: 1 });
      job.state = "user-approved";
      job.approvedAt = Date.now();
    });
    assert.equal(dispatch(w, j, "terminal-9", "close").code, 0);
  });
});

describe("parseCaps", () => {
  test("names, numbers and forbids", () => {
    assert.deepEqual(parseCaps(["spend=30000", "joins=8"], ["caption-edit", "caption-edit"]), { limits: { spend: 30000, joins: 8 }, forbid: ["caption-edit"] });
    assert.equal(parseCaps([], []), null);
  });
  test("malformed values are refused", () => {
    for (const bad of ["spend", "spend=", "Spend=1", "spend=-1", "spend=1e3", "=3"]) assert.throws(() => parseCaps([bad], []), /--cap must be/);
    assert.throws(() => parseCaps(["a=1", "a=2"], []), /given twice/);
    assert.throws(() => parseCaps([], [" "]), /--forbid/);
    assert.throws(() => parseCaps([], ["x\ny"]), /--forbid/);
  });
});

describe("validateCapsEcho", () => {
  const caps = { limits: { spend: 100, joins: 8 }, forbid: ["caption-edit"] };
  test("within caps and nothing forbidden passes", () => {
    assert.deepEqual(validateCapsEcho({ used: { spend: 100, joins: 0 }, forbiddenDone: [] }, caps, "DONE"), []);
  });
  test("over a cap, missing counter, forbidden action and missing echo are errors", () => {
    assert.match(validateCapsEcho({ used: { spend: 101, joins: 1 }, forbiddenDone: [] }, caps, "DONE").join("|"), /cap exceeded: spend used 101, cap 100/);
    assert.match(validateCapsEcho({ used: { spend: 1 }, forbiddenDone: [] }, caps, "DONE").join("|"), /caps\.used\.joins/);
    assert.match(validateCapsEcho({ used: { spend: 1, joins: 1 }, forbiddenDone: ["caption-edit"] }, caps, "DONE").join("|"), /forbidden action reported done: caption-edit/);
    assert.match(validateCapsEcho({ used: { spend: 1, joins: 1 } }, caps, "DONE").join("|"), /forbiddenDone/);
    assert.match(validateCapsEcho(undefined, caps, "DONE").join("|"), /must carry caps/);
  });
  test("a NEEDS_INPUT report may omit the echo, but a present one is still checked", () => {
    assert.deepEqual(validateCapsEcho(undefined, caps, "NEEDS_INPUT"), []);
    assert.match(validateCapsEcho({ used: { spend: 500, joins: 1 }, forbiddenDone: [] }, caps, "NEEDS_INPUT").join("|"), /cap exceeded/);
  });
});

describe("dispatch --cap / --forbid end to end", () => {
  const dispatchCaps = (w, j) => dispatch(w, j, "terminal-7", "work", "", ["--cap", "spend=100", "--cap", "joins=8", "--forbid", "caption-edit"]);

  test("stored on the round, rendered into the prompt, ttb-dash runcaps line included", () => {
    const w = world();
    const j = initJob(w);
    const d = dispatchCaps(w, j);
    assert.equal(d.code, 0, d.stderr);
    assert.deepEqual(j.job().rounds[0].caps, { limits: { spend: 100, joins: 8 }, forbid: ["caption-edit"] });
    const text = fs.readFileSync(j.job().rounds[0].promptPath, "utf8");
    assert.match(text, /GIỚI HẠN HÀNH ĐỘNG/);
    assert.match(text, /`spend` = 100/);
    assert.match(text, /CẤM: caption-edit/);
    assert.match(text, /ttbdash\.runcaps init .*--spend 100 --joins 8 --forbid "caption-edit"/);
    assert.match(text, /TTB_RUN_CAPS=/);
  });

  test("validate-report rejects a report without the echo, over a cap or with a forbidden action, and accepts a clean one", () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatchCaps(w, j).code, 0);
    settle(w, j, "terminal-7", 1);
    const run = () => cli(w, ["validate-report", "--job", j.dir]);

    writeReport(j, 1, {});
    let v = run();
    assert.notEqual(v.code, 0);
    assert.match(v.stdout + v.stderr, /side-effect caps/);

    writeReport(j, 1, { caps: { used: { spend: 150, joins: 2 }, forbiddenDone: [] } });
    v = run();
    assert.notEqual(v.code, 0);
    assert.match(v.stdout + v.stderr, /cap exceeded: spend/);

    writeReport(j, 1, { caps: { used: { spend: 10, joins: 2 }, forbiddenDone: ["caption-edit"] } });
    v = run();
    assert.notEqual(v.code, 0);
    assert.match(v.stdout + v.stderr, /forbidden action reported done/);

    writeReport(j, 1, { caps: { used: { spend: 10, joins: 2 }, forbiddenDone: [] } });
    v = run();
    assert.equal(v.code, 0, v.stdout + v.stderr);
  });

  test("a round without caps needs no echo", () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    settle(w, j, "terminal-7", 1);
    writeReport(j, 1, {});
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 0);
  });
});
