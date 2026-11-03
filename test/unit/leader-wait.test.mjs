// Waiters end on a worker's settle or death, never on a wall clock unless --timeout-min is passed.
// Every run file lives in a temp dir; the real .antifan-data is never touched.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { nextRunChange } from "../../scripts/leader/event-wait.mjs";
import { judgeWorker } from "../../scripts/leader/wait-workers.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WAIT = path.join(REPO, "scripts", "leader", "wait-workers.mjs");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "leader-wait-"));
const children = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
  fs.rmSync(TEMP, { recursive: true, force: true });
});

let counter = 0;
function freshDir() {
  const dir = path.join(TEMP, `runs${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a run file atomically, the way the OMP run-state hook does (tmp + rename). */
function writeRun(runsDir, terminal, patch) {
  const data = {
    schema: 1,
    terminalSessionId: terminal,
    ompSessionId: `01a19d28-wait-${terminal}`,
    pid: process.pid,
    cwd: "E:\\Work\\themes\\devs2\\test",
    state: "running",
    runSeq: 1,
    lastEventAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  };
  const file = path.join(runsDir, `${terminal}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}

/** Start wait-workers; `exited` resolves with its exit code, stdout and the instant it exited. */
function startWaiter(args) {
  const child = spawn(process.execPath, [WAIT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, at: Date.now() })));
  return { child, exited };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("wait-workers wakes within seconds of the run going idle", { timeout: 60_000 }, async () => {
  const runs = freshDir();
  const terminal = "terminal-wake";
  writeRun(runs, terminal, { state: "running" });
  const dispatchedAt = Date.now() - 60_000;
  const { exited } = startWaiter(["--w", `${terminal},${dispatchedAt},1`, "--runs-dir", runs]);
  await sleep(500);
  writeRun(runs, terminal, { state: "idle" });
  const idleAt = Date.now();
  const { code, stdout, at } = await exited;
  assert.equal(code, 0, stdout);
  assert.ok(at - idleAt < 3_000, `woke ${at - idleAt} ms after the run went idle`);
});

test("wait-workers has no clock deadline: a running worker keeps it waiting", { timeout: 60_000 }, async () => {
  const runs = freshDir();
  const terminal = "terminal-long";
  writeRun(runs, terminal, { state: "running" });
  const { child, exited } = startWaiter(["--w", `${terminal},${Date.now() - 60_000},1`, "--runs-dir", runs, "--poll-ms", "200"]);
  await sleep(2_500);
  assert.equal(child.exitCode, null, "the waiter must still be waiting while the run is running");
  writeRun(runs, terminal, { state: "idle" });
  assert.equal((await exited).code, 0);
});

test("--timeout-min is an explicit opt-in: exit 3 when nothing settles in time", { timeout: 60_000 }, async () => {
  const runs = freshDir();
  const terminal = "terminal-cap";
  writeRun(runs, terminal, { state: "running" });
  const { exited } = startWaiter(["--w", `${terminal},${Date.now() - 60_000},1`, "--runs-dir", runs, "--timeout-min", "0.03", "--poll-ms", "200"]);
  const { code, stdout } = await exited;
  assert.equal(code, 3);
  assert.equal(JSON.parse(stdout.trim()).settled, false);
});

test("a worker whose OMP process is gone is dead at once, with no deadline to wait for", { timeout: 60_000 }, async () => {
  const runs = freshDir();
  const terminal = "terminal-gone";
  writeRun(runs, terminal, { state: "running", pid: spawnSync(process.execPath, ["-e", ""]).pid });
  const { exited } = startWaiter(["--w", `${terminal},${Date.now() - 60_000},1`, "--runs-dir", runs, "--poll-ms", "200"]);
  const { code, stdout } = await exited;
  assert.equal(code, 4, stdout);
  assert.match(JSON.parse(stdout.trim()).why, /no longer exists/);
});

test("a silent worker is judged dead by its heartbeat after --stale-min, not by a deadline", { timeout: 60_000 }, async () => {
  const runs = freshDir();
  const terminal = "terminal-silent";
  writeRun(runs, terminal, { state: "running", pid: process.pid });
  const started = Date.now();
  const { child, exited } = startWaiter(["--w", `${terminal},${started - 60_000},1`, "--runs-dir", runs, "--sessions-dir", freshDir(), "--stale-min", "0.05", "--poll-ms", "200"]);
  await sleep(1_000);
  assert.equal(child.exitCode, null, "inside the heartbeat window the worker must not be judged dead");
  const { code, stdout, at } = await exited;
  assert.equal(code, 4, stdout);
  assert.ok(at - started >= 2_500, `dead after ${at - started} ms; the window is 3 s`);
  assert.match(JSON.parse(stdout.trim()).why, /no event or session file write/);
});

test("an idle OMP that took no follow-up is undelivered (exit 7) even though lastEventAt moved after the write", { timeout: 60_000 }, async () => {
  // The run is idle at runSeq 1; lastEventAt moves after the write (the previous turn closing) but no run began.
  const runs = freshDir();
  const terminal = "terminal-undelivered";
  const writtenAt = Date.now();
  writeRun(runs, terminal, { state: "idle", runSeq: 1, pid: process.pid, lastEventAt: writtenAt + 2_500 });
  const { exited } = startWaiter(["--w", `${terminal},${writtenAt},2`, "--runs-dir", runs, "--poll-ms", "100", "--undelivered-sec", "0.5"]);
  const { code, stdout, at } = await exited;
  assert.equal(code, 7, stdout);
  const row = JSON.parse(stdout.trim());
  assert.equal(row.undelivered, true);
  assert.equal(row.dead, false);
  assert.equal(row.settled, false);
  assert.equal(row.ompAlive, true);
  assert.match(row.why, /never took the prompt/);
  assert.ok(at - writtenAt >= 500, `flagged after ${at - writtenAt} ms, before the 0.5 s window`);
});

test("the undelivered verdict waits out its window: a prompt that starts a run in time settles normally", { timeout: 60_000 }, async () => {
  const runs = freshDir();
  const terminal = "terminal-slow-start";
  const writtenAt = Date.now();
  writeRun(runs, terminal, { state: "idle", runSeq: 1, pid: process.pid, lastEventAt: writtenAt - 5_000 });
  const { child, exited } = startWaiter(["--w", `${terminal},${writtenAt},2`, "--runs-dir", runs, "--poll-ms", "100"]);
  await sleep(1_200);
  assert.equal(child.exitCode, null, "inside the default 90 s window an idle run is only pending");
  writeRun(runs, terminal, { state: "running", runSeq: 2, pid: process.pid });
  await sleep(300);
  assert.equal(child.exitCode, null);
  writeRun(runs, terminal, { state: "idle", runSeq: 2, pid: process.pid });
  assert.equal((await exited).code, 0);
});

test("judgeWorker: a run that starts 30 s after the write is settled, not undelivered; none started after 90 s is undelivered", () => {
  const writtenAt = 1_793_727_333_305;
  const spec = { terminal: "terminal-slow", writtenAt, minRunSeq: 2, report: null };
  const idleOld = { state: "idle", runSeq: 1, lastEventAt: writtenAt + 2_500, updatedAt: writtenAt + 29_000, pid: process.pid };
  const at = (ms) => ({ pidAlive: true, now: writtenAt + ms, staleMs: 90 * 60_000, undeliveredMs: 90_000, graceMs: 0, activityAt: () => null });
  // 30 s in, the old turn only just closed: nothing settled, nothing undelivered.
  const waiting = judgeWorker(spec, idleOld, null, null, at(30_000));
  assert.equal(waiting.settled, false);
  assert.equal(waiting.undelivered, false);
  // The run began at 30 s and had finished by 100 s: settled although the 90 s window has passed.
  const done = judgeWorker(spec, { ...idleOld, runSeq: 2, lastEventAt: writtenAt + 60_000, updatedAt: writtenAt + 99_000 }, null, null, at(100_000));
  assert.equal(done.settled, true);
  assert.equal(done.undelivered, false);
  // No run at all after 100 s: undelivered, with the reason.
  const lost = judgeWorker(spec, { ...idleOld, updatedAt: writtenAt + 99_000 }, null, null, at(100_000));
  assert.equal(lost.undelivered, true);
  assert.match(lost.why, /never took the prompt/);
});

test("a follow-up to an OMP whose pid is gone is dead at once, though the run file still says idle", { timeout: 60_000 }, async () => {
  const runs = freshDir();
  const terminal = "terminal-idle-gone";
  const writtenAt = Date.now();
  const gone = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(gone.status, 0);
  writeRun(runs, terminal, { state: "idle", runSeq: 1, pid: gone.pid, lastEventAt: writtenAt - 1_000 });
  const { exited } = startWaiter(["--w", `${terminal},${writtenAt},2`, "--runs-dir", runs, "--poll-ms", "100"]);
  const { code, stdout, at } = await exited;
  assert.equal(code, 4, stdout);
  const row = JSON.parse(stdout.trim());
  assert.equal(row.dead, true);
  assert.equal(row.ompAlive, false);
  assert.equal(row.effectiveState, "ended");
  assert.match(row.why, /no longer exists/);
  assert.ok(at - writtenAt < 5_000, `took ${at - writtenAt} ms: the 3 min start grace must not apply to a follow-up`);
});

test("an OMP session that ended before it took the follow-up is dead, with the reason", { timeout: 60_000 }, async () => {
  const runs = freshDir();
  const terminal = "terminal-ended";
  const writtenAt = Date.now();
  writeRun(runs, terminal, { state: "ended", runSeq: 1, pid: process.pid, lastEventAt: writtenAt - 1_000 });
  const { exited } = startWaiter(["--w", `${terminal},${writtenAt},2`, "--runs-dir", runs, "--poll-ms", "100"]);
  const { code, stdout } = await exited;
  assert.equal(code, 4, stdout);
  assert.match(JSON.parse(stdout.trim()).why, /OMP session ended .*went to the shell/);
});

test("an idle OMP that stopped heartbeating is dead, not idle", { timeout: 60_000 }, async () => {
  const runs = freshDir();
  const terminal = "terminal-frozen";
  const writtenAt = Date.now();
  writeRun(runs, terminal, { state: "idle", runSeq: 1, pid: process.pid, lastEventAt: writtenAt - 1_000, updatedAt: writtenAt - 120_000 });
  const { exited } = startWaiter(["--w", `${terminal},${writtenAt},2`, "--runs-dir", runs, "--poll-ms", "100"]);
  const { code, stdout } = await exited;
  assert.equal(code, 4, stdout);
  assert.match(JSON.parse(stdout.trim()).why, /heartbeat stale/);
});

test("nextRunChange resolves on a change in the directory, long before its tick", { timeout: 20_000 }, async () => {
  const dir = freshDir();
  const started = Date.now();
  const waiting = nextRunChange(dir, { fallbackMs: 15_000 });
  setTimeout(() => writeRun(dir, "terminal-x", { state: "idle" }), 200);
  await waiting;
  assert.ok(Date.now() - started < 3_000, `resolved after ${Date.now() - started} ms`);
});

test("nextRunChange falls back to its tick when nothing changes", async () => {
  const dir = freshDir();
  const started = Date.now();
  await nextRunChange(dir, { fallbackMs: 300 });
  const took = Date.now() - started;
  assert.ok(took >= 250 && took < 3_000, `tick took ${took} ms`);
});

test("nextRunChange ignores writes to files it was not asked to watch", async () => {
  const dir = freshDir();
  const started = Date.now();
  const waiting = nextRunChange(dir, { fallbackMs: 800, names: new Set(["terminal-mine.json"]) });
  setTimeout(() => writeRun(dir, "terminal-other", { state: "idle" }), 100);
  await waiting;
  assert.ok(Date.now() - started >= 700, "a foreign run file must not wake the waiter early");
});

test("nextRunChange falls back to its tick when the directory does not exist", async () => {
  await nextRunChange(path.join(TEMP, "missing-dir"), { fallbackMs: 200 });
});
