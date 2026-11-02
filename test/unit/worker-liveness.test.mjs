// worker-liveness.test.mjs - when a Leader worker that has not finished its turn counts as dead.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { judgeLiveness, pidAlive, sessionActivityAt, START_GRACE_MS } from "../../scripts/leader/worker-liveness.mjs";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "worker-liveness-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const MIN = 60_000;
const SINCE = 1_000_000;
const STALE = 90 * MIN;

describe("judgeLiveness", () => {
  test("a missing run file is starting inside the grace window and dead after it", () => {
    const starting = judgeLiveness(null, SINCE, { now: SINCE + MIN, graceMs: START_GRACE_MS });
    assert.deepEqual(starting, { dead: false, why: "run file not written yet" });
    const gone = judgeLiveness(null, SINCE, { now: SINCE + START_GRACE_MS + 1, graceMs: START_GRACE_MS });
    assert.equal(gone.dead, true);
    assert.match(gone.why, /run file gone/);
  });

  test("a gone pid is dead when the run file was written after the hand-over", () => {
    const run = { state: "running", lastEventAt: SINCE + 1000, pid: 7 };
    const res = judgeLiveness(run, SINCE, { pidAlive: false, now: SINCE + MIN, graceMs: START_GRACE_MS });
    assert.equal(res.dead, true);
    assert.match(res.why, /pid 7/);
  });

  test("a gone pid in a run file older than the hand-over is the previous OMP until the grace window ends", () => {
    const run = { state: "ended", lastEventAt: SINCE - 5000, pid: 7 };
    assert.equal(judgeLiveness(run, SINCE, { pidAlive: false, now: SINCE + MIN, graceMs: START_GRACE_MS }).dead, false);
    assert.equal(judgeLiveness(run, SINCE, { pidAlive: false, now: SINCE + START_GRACE_MS + 1, graceMs: START_GRACE_MS }).dead, true);
  });

  test("an unknown pid never makes a worker dead", () => {
    const run = { state: "running", lastEventAt: SINCE + 1000, pid: 7 };
    assert.equal(judgeLiveness(run, SINCE, { pidAlive: null, now: SINCE + MIN, staleMs: STALE }).dead, false);
  });

  test("a worker silent past the stale limit is dead, a recent one is not", () => {
    const run = { state: "running", lastEventAt: SINCE + 1000, pid: 7 };
    const late = judgeLiveness(run, SINCE, { pidAlive: true, now: SINCE + 1000 + STALE + MIN, staleMs: STALE });
    assert.equal(late.dead, true);
    assert.match(late.why, /no event or session file write for 91 min/);
    assert.equal(judgeLiveness(run, SINCE, { pidAlive: true, now: SINCE + 1000 + 30 * MIN, staleMs: STALE }).dead, false);
  });

  test("staleness counts from the hand-over when the run file is older than it", () => {
    const run = { state: "running", lastEventAt: SINCE - 10 * STALE, pid: 7 };
    assert.equal(judgeLiveness(run, SINCE, { pidAlive: true, now: SINCE + MIN, staleMs: STALE }).dead, false);
  });

  test("session writes keep a worker blocked on a subagent alive, old ones do not", () => {
    const run = { state: "running", lastEventAt: SINCE + 1000, pid: 7 };
    const now = SINCE + 1000 + STALE + MIN;
    assert.equal(judgeLiveness(run, SINCE, { pidAlive: true, now, staleMs: STALE, activityAt: () => now - MIN }).dead, false);
    assert.equal(judgeLiveness(run, SINCE, { pidAlive: true, now, staleMs: STALE, activityAt: () => SINCE + 2000 }).dead, true);
    assert.equal(judgeLiveness(run, SINCE, { pidAlive: true, now, staleMs: STALE, activityAt: () => null }).dead, true);
  });

  test("the session lookup is skipped while the run file alone is fresh", () => {
    const run = { state: "running", lastEventAt: SINCE + 1000, pid: 7 };
    let calls = 0;
    const probe = { pidAlive: true, now: SINCE + 2000, staleMs: STALE, activityAt: () => (calls++, null) };
    assert.equal(judgeLiveness(run, SINCE, probe).dead, false);
    assert.equal(calls, 0);
  });
});

describe("pidAlive", () => {
  test("sees this process and rejects a missing pid", () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(undefined), null);
  });
});

describe("sessionActivityAt", () => {
  const stamp = (p, sec) => fs.utimesSync(p, sec, sec);
  const run = { ompSessionId: "01abc-def", cwd: "E:\\Work\\apps\\My App" };

  function tree(slug) {
    const root = fs.mkdtempSync(path.join(TEMP, "sessions-"));
    const base = path.join(root, slug);
    const sub = path.join(base, "2026-11-02T17-02-38-718Z_01abc-def");
    fs.mkdirSync(path.join(sub, "nested"), { recursive: true });
    fs.writeFileSync(`${sub}.jsonl`, "{}\n");
    fs.writeFileSync(path.join(sub, "__advisor.jsonl"), "{}\n");
    fs.writeFileSync(path.join(sub, "nested", "Agent.jsonl"), "{}\n");
    for (const p of [`${sub}.jsonl`, path.join(sub, "__advisor.jsonl"), path.join(sub, "nested", "Agent.jsonl")]) stamp(p, 1000);
    for (const p of [sub, path.join(sub, "nested")]) stamp(p, 1000);
    return { root, sub };
  }

  test("returns the newest write across the transcript, subagent files and nested agents", () => {
    const { root, sub } = tree("--E--Work-apps-My App--");
    assert.equal(sessionActivityAt(root, run), 1_000_000);
    stamp(path.join(sub, "nested", "Agent.jsonl"), 5000);
    assert.equal(sessionActivityAt(root, run), 5_000_000);
  });

  test("finds the transcript when the cwd slug does not match, and ignores other sessions", () => {
    const { root } = tree("--other-cwd--");
    assert.equal(sessionActivityAt(root, run), 1_000_000);
    assert.equal(sessionActivityAt(root, { ...run, ompSessionId: "other-id" }), null);
  });

  test("returns null for a missing root, a missing id and an id that is not a plain token", () => {
    assert.equal(sessionActivityAt(path.join(TEMP, "nope"), run), null);
    assert.equal(sessionActivityAt(TEMP, {}), null);
    assert.equal(sessionActivityAt(TEMP, { ompSessionId: "../x" }), null);
  });
});
