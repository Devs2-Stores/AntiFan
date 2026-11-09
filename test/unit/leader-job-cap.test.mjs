// Round cap: MAX_ROUNDS_PER_JOB work/followup rounds and MAX_DEAD_ROUNDS dead rounds per job.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { MAX_DEAD_ROUNDS, MAX_ROUNDS_PER_JOB } from "../../scripts/leader/leader-job.mjs";
import { cleanup, cli, dispatch, initJob, world } from "./leader-job-cli-helpers.mjs";

after(cleanup);

describe("round cap", () => {
  test("constants", () => {
    assert.equal(MAX_ROUNDS_PER_JOB, 4);
    assert.equal(MAX_DEAD_ROUNDS, 3);
  });

  test("the 5th work round is refused; --allow-extra-round needs --reason and records it", () => {
    const w = world();
    const j = initJob(w);
    for (let n = 1; n <= 4; n += 1) {
      const d = dispatch(w, j, "terminal-7", n === 1 ? "work" : "followup");
      assert.equal(d.code, 0, d.stderr);
      assert.equal(d.last.roundsUsed, n);
      assert.equal(d.last.maxRounds, 4);
    }
    const refused = dispatch(w, j, "terminal-7", "work");
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /round cap/);
    assert.equal(j.job().rounds.length, 4, "a refused dispatch appends nothing");

    const noReason = dispatch(w, j, "terminal-7", "work", "", ["--allow-extra-round"]);
    assert.equal(noReason.code, 2);
    assert.match(noReason.stderr, /--reason/);

    const ok = dispatch(w, j, "terminal-7", "followup", "", ["--allow-extra-round", "--reason", "user asked for one more try"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(j.job().rounds[4].extraRoundReason, "user asked for one more try");
    assert.equal(ok.last.extraRoundReason, "user asked for one more try");
  });

  test("close and review rounds are neither counted nor blocked by the cap", () => {
    const w = world();
    const j = initJob(w);
    for (let n = 1; n <= 4; n += 1) assert.equal(dispatch(w, j, "terminal-7", n === 1 ? "work" : "followup").code, 0);
    const review = dispatch(w, j, "terminal-8", "review", "{{REVIEW_TARGETS}}");
    assert.equal(review.code, 0, review.stderr);
    assert.equal(review.last.roundsUsed, 4, "a review round is not counted");
    j.patch((job) => {
      job.state = "user-approved";
      job.approvedAt = Date.now();
    });
    const close = dispatch(w, j, "terminal-9", "close");
    assert.equal(close.code, 0, close.stderr);
  });

  test("dead rounds do not count as used rounds, but 3 dead rounds stop new work rounds", () => {
    const w = world();
    const j = initJob(w);
    for (let n = 1; n <= 3; n += 1) assert.equal(dispatch(w, j, `terminal-${n + 10}`, n === 1 ? "work" : "followup").code, 0);
    j.patch((job) => {
      for (const r of job.rounds) {
        r.deadAt = Date.now();
        r.deadWhy = "test";
      }
      job.state = "worker_dead";
    });
    const st = cli(w, ["status", "--job", j.dir]).lines.find((l) => l.job);
    assert.equal(st.roundsUsed, 0);
    assert.equal(st.maxRounds, 4);
    assert.equal(st.deadRounds, 3);
    assert.equal(st.maxDeadRounds, 3);
    const refused = dispatch(w, j, "terminal-20", "followup");
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /3 dead rounds/);
    const ok = dispatch(w, j, "terminal-20", "followup", "", ["--allow-extra-round", "--reason", "fresh worker, other repo state"]);
    assert.equal(ok.code, 0, ok.stderr);
  });
});

describe('dead rounds of other kinds', () => {
  test('dead review rounds do not count toward MAX_DEAD_ROUNDS', () => {
    const w = world();
    const j = initJob(w);
    assert.equal(dispatch(w, j, 'terminal-7', 'work').code, 0);
    for (let i = 0; i < 3; i += 1) assert.equal(dispatch(w, j, 'terminal-' + (20 + i), 'review', '{{REVIEW_TARGETS}}').code, 0);
    j.patch((job) => {
      for (const r of job.rounds) if (r.kind === 'review') r.deadAt = Date.now();
    });
    assert.equal(cli(w, ['status', '--job', j.dir]).lines.find((l) => l.job).deadRounds, 0);
    assert.equal(dispatch(w, j, 'terminal-7', 'followup').code, 0);
  });
});
