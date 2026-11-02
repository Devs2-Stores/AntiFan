// wait-workers.test.mjs - settle rules of the generic Leader worker waiter.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { judgeWorker, parseSpec, pidAlive, sessionActivityAt } from "../../scripts/leader/wait-workers.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "leader", "wait-workers.mjs");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "wait-workers-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const spec = { terminal: "terminal-9", writtenAt: 1000, minRunSeq: 1, report: null };

describe("judgeWorker", () => {
  test("a fresh OMP that is idle at runSeq 0 has not read the prompt yet", () => {
    const row = judgeWorker(spec, { state: "idle", runSeq: 0, lastEventAt: 2000 }, null, null);
    assert.equal(row.settled, false);
  });

  test("idle with an event older than the write is an earlier turn", () => {
    const row = judgeWorker(spec, { state: "idle", runSeq: 1, lastEventAt: 900 }, null, null);
    assert.equal(row.settled, false);
  });

  test("a running turn is never settled", () => {
    assert.equal(judgeWorker(spec, { state: "running", runSeq: 1, lastEventAt: 2000 }, null, null).settled, false);
  });

  test("idle after the write with runSeq reached settles, waiting_user too", () => {
    assert.equal(judgeWorker(spec, { state: "idle", runSeq: 1, lastEventAt: 2000 }, null, null).settled, true);
    assert.equal(judgeWorker(spec, { state: "waiting_user", runSeq: 3, lastEventAt: 2000 }, null, null).settled, true);
  });

  test("a report older than the write is not reported as this round's status", () => {
    const old = judgeWorker(spec, { state: "idle", runSeq: 1, lastEventAt: 2000 }, { mtimeMs: 500 }, "STATUS: DONE");
    assert.equal(old.reportFresh, false);
    assert.equal(old.status, null);
    const fresh = judgeWorker(spec, { state: "idle", runSeq: 1, lastEventAt: 2000 }, { mtimeMs: 1500 }, "STATUS: DONE");
    assert.equal(fresh.status, "STATUS: DONE");
  });

  test("a running worker whose terminal was closed is dead, not pending", () => {
    const row = judgeWorker(spec, null, null, null);
    assert.equal(row.settled, false);
    assert.equal(row.dead, true);
  });

  test("a running worker whose omp pid is gone is dead", () => {
    const row = judgeWorker(spec, { state: "running", runSeq: 1, lastEventAt: 2000, pid: 7 }, null, null, { pidAlive: false });
    assert.equal(row.dead, true);
    assert.match(row.why, /pid 7/);
  });

  test("a running worker silent past the stale limit is dead, a recent one is not", () => {
    const run = { state: "running", runSeq: 1, lastEventAt: 2000, pid: 7 };
    assert.equal(judgeWorker(spec, run, null, null, { pidAlive: true, now: 2000 + 91 * 60_000, staleMs: 90 * 60_000 }).dead, true);
    assert.equal(judgeWorker(spec, run, null, null, { pidAlive: true, now: 2000 + 30 * 60_000, staleMs: 90 * 60_000 }).dead, false);
  });

  test("session file writes keep a worker blocked on a subagent alive, old ones do not", () => {
    const run = { state: "running", runSeq: 1, lastEventAt: 2000, pid: 7 };
    const probe = { pidAlive: true, now: 2000 + 91 * 60_000, staleMs: 90 * 60_000 };
    assert.equal(judgeWorker(spec, run, null, null, { ...probe, activityAt: probe.now - 60_000 }).dead, false);
    const old = judgeWorker(spec, run, null, null, { ...probe, activityAt: 2500 });
    assert.equal(old.dead, true);
    assert.match(old.why, /session file write/);
  });

  test("a settled worker is never reported dead after its omp exits", () => {
    const row = judgeWorker(spec, { state: "idle", runSeq: 1, lastEventAt: 2000, pid: 7 }, null, null, { pidAlive: false });
    assert.equal(row.settled, true);
    assert.equal(row.dead, false);
  });

  test("pidAlive sees this process and rejects a missing pid", () => {
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

describe("parseSpec", () => {
  test("rejects minRunSeq 0 and a missing field", () => {
    assert.throws(() => parseSpec("terminal-1,1000,0"), /minRunSeq/);
    assert.throws(() => parseSpec("terminal-1,1000"), /--w needs/);
  });

  test("keeps a report path that contains commas", () => {
    assert.equal(parseSpec("terminal-1,1000,1,E:/a,b/r.md").report, "E:/a,b/r.md");
  });
});

describe("cli", () => {
  const run = (args) => spawnSync(process.execPath, [CLI, "--runs-dir", TEMP, "--poll-ms", "50", ...args], { encoding: "utf8" });

  test("--all waits for the slow worker, any returns on the fast one, timeout exits 3", () => {
    fs.writeFileSync(path.join(TEMP, "terminal-1.json"), JSON.stringify({ state: "idle", runSeq: 1, lastEventAt: 5000 }));
    fs.writeFileSync(path.join(TEMP, "terminal-2.json"), JSON.stringify({ state: "running", runSeq: 1, lastEventAt: Date.now(), pid: process.pid }));
    const any = run(["--w", "terminal-1,1000,1", "--w", "terminal-2,1000,1", "--timeout-min", "1"]);
    assert.equal(any.status, 0);
    const all = run(["--w", "terminal-1,1000,1", "--w", "terminal-2,1000,1", "--all", "--timeout-min", "0.005"]);
    assert.equal(all.status, 3);
    assert.equal(all.stdout.trim().split("\n").length, 2);
  });

  test("a vanished terminal ends the wait with exit 4 instead of waiting for the timeout", () => {
    fs.writeFileSync(path.join(TEMP, "terminal-3.json"), JSON.stringify({ state: "running", runSeq: 1, lastEventAt: Date.now() }));
    const started = Date.now();
    const res = run(["--w", "terminal-3,1000,1", "--w", "terminal-404,1000,1", "--timeout-min", "10"]);
    assert.equal(res.status, 4);
    assert.ok(Date.now() - started < 30_000);
    const dead = res.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.terminal === "terminal-404");
    assert.equal(dead.dead, true);
  });

  test("a half-written run file is retried, not reported dead", () => {
    fs.writeFileSync(path.join(TEMP, "terminal-5.json"), "{\"state\":");
    const res = run(["--w", "terminal-5,1000,1", "--timeout-min", "0.005"]);
    assert.equal(res.status, 3);
    assert.equal(JSON.parse(res.stdout.trim()).dead, false);
  });

  test("right after dispatch a missing run file is still starting, not dead", () => {
    const res = run(["--w", `terminal-405,${Date.now()},1`, "--timeout-min", "0.005"]);
    assert.equal(res.status, 3);
    const row = JSON.parse(res.stdout.trim());
    assert.equal(row.dead, false);
  });

  test("a worker silent in its run file but writing its session transcript is not dead", () => {
    const sessions = fs.mkdtempSync(path.join(TEMP, "cli-sessions-"));
    const base = path.join(sessions, "--E--Work-apps-Demo--");
    const sub = path.join(base, "2026-11-02T17-02-38-718Z_sess-1");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(`${sub}.jsonl`, "{}\n");
    fs.writeFileSync(path.join(sub, "Agent.jsonl"), "{}\n");
    const longAgo = Date.now() - 3 * 60 * 60_000;
    fs.writeFileSync(path.join(TEMP, "terminal-6.json"), JSON.stringify({ state: "running", runSeq: 1, lastEventAt: longAgo, pid: process.pid, ompSessionId: "sess-1", cwd: "E:\\Work\\apps\\Demo" }));
    const args = ["--w", `terminal-6,${longAgo - 1000},1`, "--timeout-min", "0.005", "--stale-min", "30", "--sessions-dir", sessions];
    const alive = run(args);
    assert.equal(alive.status, 3);
    assert.equal(JSON.parse(alive.stdout.trim()).dead, false);
    const old = new Date(longAgo);
    for (const p of [`${sub}.jsonl`, path.join(sub, "Agent.jsonl"), sub]) fs.utimesSync(p, old, old);
    const dead = run(args);
    assert.equal(dead.status, 4);
    assert.match(JSON.parse(dead.stdout.trim()).why, /session file write/);
  });
});
