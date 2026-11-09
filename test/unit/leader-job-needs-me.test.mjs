// needs-me: read-only board of the Leader's jobs.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { cleanup, cli, initJob, world } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const snapshotOf = (w) =>
  fs
    .readdirSync(w.jobs)
    .map((n) => fs.readFileSync(path.join(w.jobs, n, "job.json"), "utf8"))
    .join("\n");

describe("needs-me", () => {
  test("orders needs_input, worker_dead, verified, stale, others; never changes a job", () => {
    const w = world();
    const make = (slug, state, patch = () => {}) => {
      const j = initJob(w, slug);
      j.patch((job) => {
        job.state = state;
        patch(job);
      });
      return j;
    };
    const old = Date.now() - 3 * 24 * 3600 * 1000;
    const fresh = make("fresh-open", "open");
    const stale = make("stale-open", "open", (job) => {
      job.updatedAt = old;
      job.createdAt = old;
    });
    const verified = make("verified-one", "verified");
    const dead = make("dead-one", "worker_dead", (job) => {
      job.rounds.push({ n: 1, kind: "work", worker: { terminal: "terminal-7" }, deadAt: Date.now(), deadWhy: "pid gone", report: null, verification: {} });
    });
    const asking = make("asking", "needs_input");
    const closed = make("closed-one", "closed");
    // a job of another Leader is not listed
    const other = initJob(world(), "foreign");
    assert.ok(other.dir);

    const before = snapshotOf(w);
    const r = cli(w, ["needs-me"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.cmd, "needs-me");
    const names = r.last.rows.map((x) => x.job);
    const pos = (j) => names.indexOf(path.basename(j.dir));
    assert.ok(pos(asking) < pos(dead) && pos(dead) < pos(verified) && pos(verified) < pos(stale) && pos(stale) < pos(fresh), names.join(","));
    assert.equal(pos(closed), -1, "closed jobs are omitted");
    assert.equal(r.last.rows.length, 5);
    const row = (j) => r.last.rows.find((x) => x.job === path.basename(j.dir));
    assert.equal(row(stale).stale, true);
    assert.equal(row(fresh).stale, false);
    assert.equal(row(dead).deadWhy, "pid gone");
    assert.deepEqual(r.last.needsMe.slice(0, 3), [asking, dead, verified].map((j) => path.basename(j.dir)));
    assert.ok(!r.last.needsMe.includes(path.basename(fresh.dir)));
    assert.ok(r.last.text.split("\n").length <= 40);
    assert.equal(snapshotOf(w), before, "read-only");

    const withClosed = cli(w, ["needs-me", "--all"]);
    assert.equal(withClosed.last.rows.length, 6);

    const hours = cli(w, ["needs-me", "--stale-hours", "100000"]);
    assert.equal(hours.last.rows.find((x) => x.job === path.basename(stale.dir)).stale, false);
  });

  test("--text prints only the one-screen text", () => {
    const w = world();
    initJob(w, "one");
    const r = cli(w, ["needs-me", "--text"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.lines.length, 0, "no JSON on stdout");
    assert.match(r.stdout, /Leader board/);
    assert.match(r.stdout, /one/);
  });

  test("needs a Leader terminal", () => {
    const w = world();
    const r = cli(w, ["needs-me"], { ANTIFAN_TERMINAL_SESSION_ID: "" });
    assert.equal(r.code, 2);
  });
});
