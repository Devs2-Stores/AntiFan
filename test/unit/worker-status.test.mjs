// worker-status.test.mjs - the Leader's read-only progress line must not call a dead OMP run "running".

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { status } from "../../scripts/leader/worker-status.mjs";
import { pidAlive } from "../../scripts/leader/worker-liveness.mjs";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "worker-status-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const STALE_MIN = 90;
const OMP_ID = "01a1a204-61ed-74d8-8cc4-818fcfdc0eaf";

/** A pid of a process that has already exited, checked to be dead before use. */
function exitedPid() {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  assert.equal(pidAlive(child.pid), false);
  return child.pid;
}

/** Options for status() over one run file, with an empty sessions dir (no OMP transcript). */
function fixture(run) {
  const runsDir = fs.mkdtempSync(path.join(TEMP, "runs-"));
  fs.writeFileSync(path.join(runsDir, "terminal-t.json"), JSON.stringify(run));
  const sessionsDir = fs.mkdtempSync(path.join(TEMP, "sessions-"));
  return { terminal: "terminal-t", runsDir, sessionsDir, tools: 5 };
}

describe("status liveness", () => {
  test("a running run whose OMP pid is gone reads ended and dead, though its run file still says running", () => {
    const opts = fixture({ state: "running", runSeq: 1, lastEventAt: NOW - MIN, pid: exitedPid(), ompSessionId: OMP_ID, cwd: "E:\\Work\\muse-studio" });
    const { code, out } = status(opts, NOW);
    assert.equal(code, 0);
    assert.equal(out.state, "ended");
    assert.equal(out.rawState, "running");
    assert.equal(out.ompAlive, false);
    assert.equal(out.dead, true);
    assert.match(out.why, /no longer exists/);
  });

  test("a running run with a live OMP pid and recent events is not dead", () => {
    const opts = fixture({ state: "running", runSeq: 2, lastEventAt: NOW - MIN, pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work" });
    assert.equal(status(opts, NOW).out.dead, false);
  });

  test("a running run silent past the stale limit with no transcript writes is dead", () => {
    const opts = fixture({ state: "running", runSeq: 1, lastEventAt: NOW - (STALE_MIN + 1) * MIN, pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work" });
    const { out } = status(opts, NOW);
    assert.equal(out.dead, true);
    assert.match(out.why, /no event or session file write/);
  });

  test("an idle run whose OMP pid is gone is ended and dead: the file never said so", () => {
    const opts = fixture({ state: "idle", runSeq: 1, lastEventAt: NOW - MIN, pid: exitedPid(), ompSessionId: OMP_ID, cwd: "E:\\Work" });
    const { out } = status(opts, NOW);
    assert.equal(out.state, "ended");
    assert.equal(out.rawState, "idle");
    assert.equal(out.ompAlive, false);
    assert.equal(out.dead, true);
  });

  test("an OMP that shut down cleanly (state ended in the file) is not alive but not dead", () => {
    const opts = fixture({ state: "ended", runSeq: 3, lastEventAt: NOW - MIN, pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work" });
    const { out } = status(opts, NOW);
    assert.equal(out.state, "ended");
    assert.equal(out.ompAlive, false);
    assert.equal(out.dead, false);
  });

  test("an idle run whose pid exists but stopped heartbeating stays idle and alive: the pid is checked first", () => {
    const opts = fixture({ state: "idle", runSeq: 1, lastEventAt: NOW - MIN, updatedAt: NOW - 2 * MIN, pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work" });
    const { out } = status(opts, NOW);
    assert.equal(out.state, "idle");
    assert.equal(out.ompAlive, true);
    assert.equal(out.dead, false);
    assert.equal(out.heartbeatAgeSec, 120);
  });

  test("the false dead of 23/11 reads pending: idle, a 45 s old heartbeat and a live pid", () => {
    const dispatchedAt = 1_795_407_477_686;
    const verdictAt = 1_795_407_516_148;
    const opts = {
      ...fixture({ state: "idle", runSeq: 1, lastEventAt: 1_795_407_352_231, updatedAt: verdictAt - 45_400, pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work" }),
      since: dispatchedAt,
      minRunSeq: 2,
    };
    const { code, out } = status(opts, verdictAt);
    assert.equal(code, 0);
    assert.equal(out.dead, false);
    assert.equal(out.why, null);
    assert.equal(out.delivery, "pending");
    assert.equal(out.deliveryWhy, null);
  });

  test("a settled run with a live pid and a fresh heartbeat is idle, alive and not dead", () => {
    const opts = fixture({ state: "idle", runSeq: 1, lastEventAt: NOW - MIN, updatedAt: NOW - 5_000, pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work" });
    const { out } = status(opts, NOW);
    assert.equal(out.state, "idle");
    assert.equal(out.ompAlive, true);
    assert.equal(out.dead, false);
  });
});

describe("status delivery check (--since / --min-run-seq)", () => {
  // An idle OMP that is alive and heartbeating: the previous turn closed after the write (lastEventAt moved) but no run began (runSeq stayed 1).
  const SINCE = 1793727333305;
  const wheel = (patch = {}) => ({ state: "idle", runSeq: 1, lastEventAt: 1793727335820, pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work", ...patch });
  const probe = (run, minRunSeq = 2) => ({ ...fixture(run), since: SINCE, minRunSeq, undeliveredMs: 90_000 });

  test("pending inside the window, not_started after it: lastEventAt moving never counts as progress", () => {
    assert.equal(status(probe(wheel({ updatedAt: SINCE + 10_000 })), SINCE + 30_000).out.delivery, "pending");
    const late = status(probe(wheel({ updatedAt: SINCE + 99_000 })), SINCE + 100_000).out;
    assert.equal(late.delivery, "not_started");
    assert.match(late.deliveryWhy, /never took the prompt/);
  });

  test("started once runSeq reaches the minimum, whatever the state", () => {
    assert.equal(status(probe(wheel({ runSeq: 2, state: "running", updatedAt: SINCE + 5_000 })), SINCE + 6_000).out.delivery, "started");
    assert.equal(status(probe(wheel({ runSeq: 2, updatedAt: SINCE + 199_000 })), SINCE + 200_000).out.delivery, "started");
  });

  test("a run that begins 30 s after the write is not undelivered: a slow worker (old turn closing, context loading) reads pending, then started", () => {
    // 30 s in, still the previous turn closing: runSeq has not moved, but the 90 s window is open.
    assert.equal(status(probe(wheel({ updatedAt: SINCE + 29_000 })), SINCE + 30_000).out.delivery, "pending");
    // The run starts at 30 s and is still running at 40 s.
    assert.equal(status(probe(wheel({ runSeq: 2, state: "running", lastEventAt: SINCE + 30_000, updatedAt: SINCE + 39_000 })), SINCE + 40_000).out.delivery, "started");
    // It finished by 100 s (past the window): still started, never not_started.
    assert.equal(status(probe(wheel({ runSeq: 2, lastEventAt: SINCE + 60_000, updatedAt: SINCE + 99_000 })), SINCE + 100_000).out.delivery, "started");
  });

  test("a prompt that started a run stays started when the OMP crashes later; dead reports the crash", () => {
    const out = status(probe(wheel({ runSeq: 2, state: "running", pid: exitedPid(), updatedAt: SINCE + 5_000 })), SINCE + 6_000).out;
    assert.equal(out.delivery, "started");
    assert.equal(out.dead, true);
    assert.match(out.why, /no longer exists/);
  });

  test("not_running when the OMP is gone", () => {
    const out = status(probe(wheel({ pid: exitedPid(), updatedAt: SINCE + 5_000 })), SINCE + 6_000).out;
    assert.equal(out.delivery, "not_running");
    assert.match(out.deliveryWhy, /no longer exists/);
  });

  test("no delivery field without --since", () => {
    assert.equal("delivery" in status(fixture(wheel({ updatedAt: SINCE })), SINCE + 1_000).out, false);
  });
});

/** A Leader registry that records `terminal` as assigned to a Leader at `assignedAt`. */
function registryDir(assignedAt, terminal = "terminal-t") {
  const dir = fs.mkdtempSync(path.join(TEMP, "config-"));
  const workers = { [terminal]: { leaderId: "terminal-1", title: "worker", assignedAt } };
  fs.writeFileSync(path.join(dir, "leader-terminals.json"), JSON.stringify({ schema: 1, leaders: ["terminal-1"], workers }));
  return dir;
}

/** Options for status() over an empty run directory, so the run file is absent. */
function noRunFile(patch = {}) {
  return {
    terminal: "terminal-t",
    runsDir: fs.mkdtempSync(path.join(TEMP, "empty-runs-")),
    sessionsDir: fs.mkdtempSync(path.join(TEMP, "no-sessions-")),
    configDir: null,
    tools: 5,
    ...patch,
  };
}

describe("status before the run file exists", () => {
  test("a worker the Leader assigned seconds ago answers starting with exit 0, not NO_RUN_FILE", () => {
    const { code, out } = status(noRunFile({ configDir: registryDir(NOW - 7_000) }), NOW);
    assert.equal(code, 0);
    assert.equal(out.ok, true);
    assert.equal(out.state, "starting");
    assert.equal(out.terminal, "terminal-t");
    assert.equal(out.assignedAt, NOW - 7_000);
    assert.equal(out.ageSec, 7);
  });

  test("the starting answer expires after 90 s: the reason is NO_RUN_FILE again", () => {
    const inside = status(noRunFile({ configDir: registryDir(NOW - 89_000) }), NOW);
    assert.equal(inside.code, 0);
    assert.equal(inside.out.state, "starting");
    const stale = status(noRunFile({ configDir: registryDir(NOW - 91_000) }), NOW);
    assert.equal(stale.code, 4);
    assert.equal(stale.out.reason, "NO_RUN_FILE");
    assert.equal("state" in stale.out, false);
  });

  test("a terminal no registry names keeps NO_RUN_FILE inside the window", () => {
    const { code, out } = status(noRunFile({ configDir: registryDir(NOW - 5_000, "terminal-other") }), NOW);
    assert.equal(code, 4);
    assert.equal(out.reason, "NO_RUN_FILE");
  });

  test("a run file that exists but cannot be parsed is never starting", () => {
    const runsDir = fs.mkdtempSync(path.join(TEMP, "corrupt-runs-"));
    fs.writeFileSync(path.join(runsDir, "terminal-t.json"), "{ not json");
    const { code, out } = status(noRunFile({ runsDir, configDir: registryDir(NOW - 5_000) }), NOW);
    assert.equal(code, 4);
    assert.equal(out.reason, "NO_RUN_FILE");
  });
});

describe("status model warnings", () => {
  const modelLine = (model) => JSON.stringify({ type: "model_change", timestamp: "2026-11-20T07:22:56.205Z", model });
  const running = () => ({ state: "running", runSeq: 1, lastEventAt: NOW - MIN, pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work\\customizes\\Levents" });

  /** A sessions dir holding one transcript for `OMP_ID`, body given line by line. */
  function sessionsWith(lines) {
    const dir = fs.mkdtempSync(path.join(TEMP, "sessions-"));
    const base = path.join(dir, "--E--Work-customizes-Levents--");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, `2026-11-20T07-22-54-460Z_${OMP_ID}.jsonl`), `${lines.join("\n")}\n`);
    return dir;
  }

  test("a 9router/cc model warns that its tool names carry an _ide suffix", () => {
    const opts = { ...fixture(running()), sessionsDir: sessionsWith([modelLine("9router/cc/claude-haiku-5-5")]) };
    const { out } = status(opts, NOW);
    assert.equal(out.model, "9router/cc/claude-haiku-5-5");
    assert.equal(out.warnings.length, 1);
    assert.equal(out.warnings[0].code, "IDE_TOOL_SUFFIX_MODEL");
    assert.match(out.warnings[0].note, /_ide suffix/);
  });

  test("a model outside that route carries no warnings", () => {
    const opts = { ...fixture(running()), sessionsDir: sessionsWith([modelLine("anthropic/claude-sonnet-5-5")]) };
    const { out } = status(opts, NOW);
    assert.equal(out.model, "anthropic/claude-sonnet-5-5");
    assert.equal("warnings" in out, false);
  });

  test("the newest model_change of a long transcript wins over the session header", () => {
    const filler = JSON.stringify({ type: "pad", text: "x".repeat(1_100_000) });
    const opts = { ...fixture(running()), sessionsDir: sessionsWith([modelLine("anthropic/claude-sonnet-5-5"), filler, modelLine("9router/cc/claude-haiku-5-5")]) };
    const { out } = status(opts, NOW);
    assert.equal(out.model, "9router/cc/claude-haiku-5-5");
    assert.equal(out.warnings[0].code, "IDE_TOOL_SUFFIX_MODEL");
  });
});
