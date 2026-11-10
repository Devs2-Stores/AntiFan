// fleet-watch.test.mjs - the Leader's whole-fleet waiter and the verified close.
// Cases come from the 04/11/2026 misses: a worker forgotten from a hand-typed list, and a close that answered
// EXECUTION_UNCERTAIN and was never read back.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { closeWorkers, nodeBinary, scopeProblem } from "../../scripts/leader/close-worker.mjs";
import { parseArgs, promptPathOf, renderJson, watchFleet } from "../../scripts/leader/fleet-watch.mjs";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-watch-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const LEADER = "terminal-1";
const OTHER_LEADER = "terminal-2";

/** A fleet on disk: registry + run files + empty sessions dir + a ledger path that does not exist yet. */
function makeFleet({ workers = {}, runs = {}, leaders = [LEADER, OTHER_LEADER] } = {}) {
  const root = fs.mkdtempSync(path.join(TEMP, "fleet-"));
  const fleet = {
    root,
    configDir: path.join(root, "config"),
    runsDir: path.join(root, "runs"),
    sessionsDir: path.join(root, "sessions"),
    eventsFile: path.join(root, "leader", `${LEADER}-events.jsonl`),
    jobs: path.join(root, "jobs"),
  };
  for (const d of [fleet.configDir, fleet.runsDir, fleet.sessionsDir, fleet.jobs]) fs.mkdirSync(d, { recursive: true });
  fleet.writeRegistry = (w, l = leaders) => fs.writeFileSync(path.join(fleet.configDir, "leader-terminals.json"), JSON.stringify({ schema: 1, leaders: l, workers: w }));
  fleet.writeRun = (id, run) => fs.writeFileSync(path.join(fleet.runsDir, `${id}.json`), JSON.stringify({ schema: 1, terminalSessionId: id, pid: process.pid, cwd: "E:\\x", ...run }));
  fleet.writeRegistry(workers);
  for (const [id, run] of Object.entries(runs)) fleet.writeRun(id, run);
  fleet.opts = (extra = {}) => ({
    leader: LEADER,
    timeoutMin: null,
    staleMin: 90,
    graceSec: 180,
    pollMs: 30,
    configDir: fleet.configDir,
    runsDir: fleet.runsDir,
    sessionsDir: fleet.sessionsDir,
    eventsFile: fleet.eventsFile,
    reports: new Map(),
    once: false,
    peek: false,
    table: false,
    pidOf: () => true,
    ...extra,
  });
  return fleet;
}

const NOW = () => Date.now();
/** One base time per file, so reg() called twice names the same incarnation (terminal + assignedAt). */
const BASE = NOW();
const reg = (leaderId = LEADER, title = "w", age = 600_000) => ({ leaderId, title, assignedAt: BASE - age });
const idleRun = (runSeq = 1, extra = {}) => ({ state: "idle", runSeq, lastEventAt: NOW() - 30_000, updatedAt: NOW(), promptHead: "", ...extra });
const runningRun = (runSeq = 1, extra = {}) => ({ state: "running", runSeq, lastEventAt: NOW() - 5_000, updatedAt: NOW(), promptHead: "", ...extra });

const kinds = (result) => result.events.map((e) => `${e.kind}:${e.terminal}`).sort();

describe("registry-driven discovery", () => {
  test("a worker created while the waiter runs is reported without being named", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": runningRun() } });
    // terminal-10 is already known to an earlier call, so only a change can wake the waiter.
    const first = await watchFleet(f.opts({ once: true }));
    assert.deepEqual(kinds(first), ["new-worker:terminal-10"]);
    const waiting = watchFleet(f.opts());
    await new Promise((r) => setTimeout(r, 150));
    f.writeRegistry({ "terminal-10": reg(), "terminal-11": reg(LEADER, "late") });
    f.writeRun("terminal-11", runningRun());
    const woke = await waiting;
    assert.deepEqual(kinds(woke), ["new-worker:terminal-11"]);
    assert.equal(woke.rows.length, 2, "the table lists every open worker, not only the one that woke the waiter");
  });

  test("workers of another Leader are not watched", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg(), "terminal-20": reg(OTHER_LEADER) }, runs: { "terminal-10": runningRun(), "terminal-20": idleRun() } });
    const result = await watchFleet(f.opts({ once: true }));
    assert.deepEqual(result.rows.map((r) => r.terminal), ["terminal-10"]);
    assert.ok(!result.events.some((e) => e.terminal === "terminal-20"));
  });

  test("a terminal that vanished from the registry is reported gone once", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg(), "terminal-11": reg() }, runs: { "terminal-10": runningRun(), "terminal-11": runningRun() } });
    await watchFleet(f.opts({ once: true }));
    f.writeRegistry({ "terminal-10": reg() });
    const gone = await watchFleet(f.opts({ once: true }));
    assert.deepEqual(kinds(gone), ["worker-gone:terminal-11"]);
    const again = await watchFleet(f.opts({ once: true }));
    assert.deepEqual(again.events, []);
  });

  test("not a Leader and no workers is a usage error, not an endless wait", async () => {
    const f = makeFleet({ workers: {}, leaders: [OTHER_LEADER] });
    const result = await watchFleet(f.opts());
    assert.equal(result.code, 2);
    assert.match(result.error, /not a marked Leader/);
  });
});

describe("reported once, open-but-idle listed every call", () => {
  test("an idle worker wakes the waiter once; later calls list it as still open without waking", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": idleRun(3) } });
    const first = await watchFleet(f.opts({ once: true }));
    assert.ok(kinds(first).includes("worker-idle:terminal-10"));
    for (let i = 0; i < 2; i++) {
      const next = await watchFleet(f.opts({ once: true }));
      assert.deepEqual(next.events, [], "an event already reported does not wake the waiter");
      assert.equal(next.rows.find((r) => r.terminal === "terminal-10").phase, "idle");
    }
    // the next call's summary line must still name it among the open, unclosed workers
    const result = await watchFleet(f.opts({ once: true }));
    const summary = JSON.parse(renderJson(result, { leader: LEADER }).split("\n")[0]);
    assert.deepEqual(summary.openUnclosed.map((o) => o.terminal), ["terminal-10"]);
  });

  test("a follow-up that ends a new run is a new event for the same worker", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": idleRun(1) } });
    await watchFleet(f.opts({ once: true }));
    f.writeRun("terminal-10", idleRun(2));
    const next = await watchFleet(f.opts({ once: true }));
    assert.deepEqual(kinds(next), ["worker-idle:terminal-10"]);
  });

  test("--peek reads the ledger but never writes it", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": idleRun() } });
    const result = await watchFleet(f.opts({ once: true, peek: true }));
    assert.ok(result.events.length > 0);
    assert.equal(fs.existsSync(f.eventsFile), false);
  });

  test("a running worker alone times out with exit 3 and a full table", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": runningRun() } });
    await watchFleet(f.opts({ once: true }));
    const result = await watchFleet(f.opts({ timeoutMin: 0.002 }));
    assert.equal(result.code, 3);
    assert.equal(result.timedOut, true);
    assert.equal(result.rows.length, 1);
  });
});

describe("events and exit codes", () => {
  test("a worker whose OMP pid is gone is dead: exit 4", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": runningRun() } });
    await watchFleet(f.opts({ once: true }));
    const result = await watchFleet(f.opts({ once: true, pidOf: () => false }));
    assert.deepEqual(kinds(result), ["worker-dead:terminal-10"]);
    assert.equal(result.code, 4);
  });

  test("an open ask dialog is needs-input: exit 5", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": { state: "waiting_user", runSeq: 2, lastEventAt: NOW() - 3000, updatedAt: NOW(), promptHead: "" } } });
    await watchFleet(f.opts({ once: true }));
    f.writeRun("terminal-10", { state: "waiting_user", runSeq: 2, lastEventAt: NOW() - 2000, updatedAt: NOW(), promptHead: "" });
    const result = await watchFleet(f.opts({ once: true }));
    assert.deepEqual(kinds(result), ["needs-input:terminal-10"]);
    assert.equal(result.code, 5);
  });

  test("an idle OMP that never started a run past the grace window is undelivered: exit 7", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg(LEADER, "w", 600_000) }, runs: { "terminal-10": idleRun(0) } });
    const result = await watchFleet(f.opts({ once: true }));
    assert.ok(kinds(result).includes("worker-undelivered:terminal-10"));
    assert.equal(result.code, 7);
  });

  test("a fresh worker inside the grace window is starting, not undelivered", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg(LEADER, "w", 20_000) }, runs: { "terminal-10": idleRun(0) } });
    const result = await watchFleet(f.opts({ once: true }));
    assert.equal(result.rows[0].phase, "starting");
    assert.ok(!kinds(result).some((k) => k.startsWith("worker-undelivered")));
  });

  test("a registered terminal with no run file past the grace window is no-omp: exit 4", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg(LEADER, "dev split", 600_000) } });
    const result = await watchFleet(f.opts({ once: true }));
    assert.ok(kinds(result).includes("worker-no-omp:terminal-10"));
    assert.equal(result.code, 4);
  });
});

describe("reports: worker to Leader without a new channel", () => {
  function reportFleet() {
    const prompt = path.join(TEMP, "jobs-x", "job.prompt.md").replace(/\\/g, "/");
    fs.mkdirSync(path.dirname(prompt), { recursive: true });
    fs.writeFileSync(prompt, "do it");
    const f = makeFleet({
      workers: { "terminal-10": { leaderId: LEADER, title: "w", assignedAt: NOW() - 600_000 } },
      runs: { "terminal-10": runningRun(1, { promptHead: `<file name="${prompt.replace(/\//g, "\\")}"> # Worker` }) },
    });
    const report = prompt.replace(/\.prompt\.md$/, ".report.md");
    fs.rmSync(report, { force: true });
    return { f, report, write: (line) => fs.writeFileSync(report, `${line}\nbody\n`) };
  }

  test("the prompt path is read from a <file> tag and from a path in a follow-up line", () => {
    assert.equal(promptPathOf('<file name="E:\\Work\\scratch\\leader\\j\\a.prompt.md"> # x'), "E:/Work/scratch/leader/j/a.prompt.md");
    assert.equal(promptPathOf("Trả lời: dùng menu. Đọc tiếp E:/Work/scratch/leader/j/followup-1.md rồi làm"), "E:/Work/scratch/leader/j/followup-1.md");
    assert.equal(promptPathOf("no path here"), null);
  });

  test("a STATUS line written mid-run wakes the waiter; a new first line wakes it again", async () => {
    const { f, write } = reportFleet();
    await watchFleet(f.opts({ once: true }));
    assert.deepEqual((await watchFleet(f.opts({ once: true }))).events, []);
    write("STATUS: NEEDS_INPUT");
    const first = await watchFleet(f.opts({ once: true }));
    assert.deepEqual(kinds(first), ["report:terminal-10"]);
    assert.equal(first.events[0].needsInput, true);
    assert.equal(first.code, 5);
    assert.deepEqual((await watchFleet(f.opts({ once: true }))).events, []);
    write("STATUS: DONE");
    const second = await watchFleet(f.opts({ once: true }));
    assert.deepEqual(kinds(second), ["report:terminal-10"]);
    assert.equal(second.events[0].status, "DONE");
  });

  test("a report older than the worker's assignment is ignored", async () => {
    const { f, report, write } = reportFleet();
    write("STATUS: DONE");
    const old = new Date(NOW() - 3_600_000);
    fs.utimesSync(report, old, old);
    const result = await watchFleet(f.opts({ once: true }));
    assert.ok(!kinds(result).some((k) => k.startsWith("report:")));
  });

  test("--report overrides the derived path", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": runningRun() } });
    const custom = path.join(f.root, "custom.md");
    fs.writeFileSync(custom, "STATUS: PENDING\n");
    const opts = parseArgs(["--leader", LEADER, "--report", `terminal-10=${custom}`], {});
    assert.equal(opts.reports.get("terminal-10"), custom);
    const result = await watchFleet(f.opts({ once: true, reports: opts.reports }));
    assert.equal(result.events.find((e) => e.kind === "report").status, "PENDING");
  });
});

describe("close-worker verifies instead of trusting the call", () => {
  /** A clock the fake sleep advances, so the settle window costs no real time. */
  function harness({ open, registry, closeCall, runFile }) {
    let clock = 0;
    const calls = [];
    const gone = [];
    return {
      calls,
      gone,
      clock: () => clock,
      deps: {
        registry: () => registry,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        closeCall: async (id, extra) => {
          calls.push({ id, extra });
          return closeCall(calls.length, id);
        },
        isOpen: async (id) => open(id, calls.length),
        ...(runFile ? { runFileExists: (id) => runFile(id, clock) } : {}),
        recordGone: (id, inc) => gone.push([id, inc]),
      },
    };
  }
  const registry = { leaders: [LEADER, OTHER_LEADER], workers: { "terminal-10": { leaderId: LEADER, assignedAt: 5 }, "terminal-20": { leaderId: OTHER_LEADER, assignedAt: 6 } } };
  const opts = { leader: LEADER, retries: 3, settleMs: 2000, pollMs: 500 };

  test("EXECUTION_UNCERTAIN with the terminal gone afterwards is closed (the call's answer is not the proof)", async () => {
    const h = harness({
      registry,
      open: (_id, calls) => calls < 1,
      closeCall: () => {
        throw Object.assign(new Error("uncertain"), { code: "EXECUTION_UNCERTAIN" });
      },
    });
    const { results, code } = await closeWorkers(["terminal-10"], h.deps, opts);
    assert.equal(results[0].result, "closed");
    assert.equal(results[0].attempts, 1);
    assert.equal(code, 0);
    assert.deepEqual(h.gone, [["terminal-10", "terminal-10@5"]]);
  });

  test("a close that reports success while the terminal stays listed is retried, then reported still-open", async () => {
    const h = harness({ registry, open: () => true, closeCall: () => ({ closed: true }) });
    const { results, code } = await closeWorkers(["terminal-10"], h.deps, opts);
    assert.equal(results[0].result, "still-open");
    assert.equal(results[0].attempts, 3);
    assert.equal(h.calls.length, 3);
    assert.equal(code, 1);
    assert.deepEqual(h.gone, []);
  });

  test("a failed first call that the second call fixes ends closed after 2 attempts", async () => {
    const h = harness({
      registry,
      open: (_id, calls) => calls < 2,
      closeCall: (n) => {
        if (n === 1) throw Object.assign(new Error("uncertain"), { code: "EXECUTION_UNCERTAIN" });
        return { closed: true, projectRemoval: { status: "REMOVED" } };
      },
    });
    const { results } = await closeWorkers(["terminal-10"], h.deps, opts);
    assert.equal(results[0].result, "closed");
    assert.equal(results[0].attempts, 2);
    assert.deepEqual(results[0].projectRemoval, { status: "REMOVED" });
  });

  test("another Leader's worker, a Leader terminal and an open unregistered terminal are refused with no call made", async () => {
    const h = harness({ registry, open: () => true, closeCall: () => ({ closed: true }) });
    const { results, code } = await closeWorkers(["terminal-20", LEADER, OTHER_LEADER, "terminal-99"], h.deps, opts);
    assert.deepEqual(results.map((r) => r.result), ["refused", "refused", "refused", "refused"]);
    assert.equal(h.calls.length, 0, "no terminal.close is issued for a terminal that is not provably this Leader's worker");
    assert.equal(code, 4);
  });

  test("an unregistered terminal that is not listed is already gone", async () => {
    const h = harness({ registry, open: () => false, closeCall: () => ({ closed: true }) });
    const { results, code } = await closeWorkers(["terminal-99"], h.deps, opts);
    assert.equal(results[0].result, "already-gone");
    assert.equal(code, 0);
    assert.equal(h.calls.length, 0);
  });

  test("a terminal that is no longer listed is closed only once its run file is gone", async () => {
    const h = harness({ registry, open: (_id, calls) => calls < 1, closeCall: () => ({ closed: true }), runFile: (_id, clock) => clock < 1500 });
    const { results, code } = await closeWorkers(["terminal-10"], h.deps, opts);
    assert.equal(results[0].result, "closed");
    assert.equal(code, 0);
    assert.ok(h.clock() >= 1500, "the answer waited for the run file instead of reporting closed on the terminal list alone");
    assert.equal(h.calls.length, 1);
  });

  test("a run file that outlives the settle window is reported as lingering, not closed, and the close is not repeated", async () => {
    const h = harness({ registry, open: (_id, calls) => calls < 1, closeCall: () => ({ closed: true }), runFile: () => true });
    const { results, code } = await closeWorkers(["terminal-10"], h.deps, opts);
    assert.equal(results[0].result, "run-file-lingering");
    assert.match(results[0].note, /run file is still there/);
    assert.equal(code, 1);
    assert.equal(h.calls.length, 1, "another terminal.close cannot remove the file");
    assert.deepEqual(h.gone, [["terminal-10", "terminal-10@5"]], "the terminal itself is gone");
  });

  test("a refusal a retry cannot change, on a terminal already unlisted, still waits for the run file", async () => {
    const h = harness({
      registry,
      open: () => false,
      closeCall: () => {
        throw Object.assign(new Error("forbidden"), { code: "TERMINAL_FORBIDDEN" });
      },
      runFile: (_id, clock) => clock < 1000,
    });
    const { results, code } = await closeWorkers(["terminal-10"], h.deps, opts);
    assert.equal(results[0].result, "closed");
    assert.equal(results[0].attempts, 1);
    assert.equal(code, 0);
  });

  test("a refusal a retry cannot change (TERMINAL_FORBIDDEN) is looked at once, not retried", async () => {
    const h = harness({
      registry,
      open: () => true,
      closeCall: () => {
        throw Object.assign(new Error("forbidden"), { code: "TERMINAL_FORBIDDEN" });
      },
    });
    const { results, code } = await closeWorkers(["terminal-10"], h.deps, opts);
    assert.equal(results[0].result, "still-open");
    assert.equal(results[0].attempts, 1);
    assert.equal(results[0].error.code, "TERMINAL_FORBIDDEN");
    assert.equal(code, 1);
  });

  test("an unreadable registry refuses everything", async () => {
    const h = harness({ registry: null, open: () => true, closeCall: () => ({ closed: true }) });
    const { results, code } = await closeWorkers(["terminal-10"], h.deps, opts);
    assert.equal(results[0].result, "refused");
    assert.equal(code, 4);
    assert.equal(h.calls.length, 0);
  });
});

describe("empty fleet, short --stale-min, report resolution, close scope", () => {
  test("a waiter started before the first worker exists keeps waiting and wakes on the worker created later", async () => {
    const f = makeFleet({ workers: {} });
    const waiting = watchFleet(f.opts());
    await new Promise((r) => setTimeout(r, 150));
    f.writeRegistry({ "terminal-10": reg(LEADER, "late") });
    f.writeRun("terminal-10", runningRun());
    const woke = await waiting;
    assert.deepEqual(kinds(woke), ["new-worker:terminal-10"]);
  });

  test("an empty fleet with --once says EMPTY FLEET (not a bare 0), and with a timeout ends with exit 3", async () => {
    const f = makeFleet({ workers: {} });
    const once = await watchFleet(f.opts({ once: true }));
    assert.match(once.note, /EMPTY FLEET/);
    const timed = await watchFleet(f.opts({ timeoutMin: 0.002 }));
    assert.equal(timed.code, 3);
    assert.match(timed.note, /EMPTY FLEET/);
  });

  test("--stale-min is honoured: a run silent for 5 s is stale at a 600 ms limit and not at 90 min", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": runningRun() } });
    const long = await watchFleet(f.opts({ once: true }));
    assert.equal(long.rows[0].phase, "running");
    const short = await watchFleet(f.opts({ once: true, staleMin: 0.01 }));
    assert.equal(short.rows[0].phase, "stale");
    assert.ok(kinds(short).includes("worker-stale:terminal-10"));
    assert.equal(short.code, 4);
  });

  test("a prompt that is not x.prompt.md names its report on the STATUS line; input reports on other lines are not taken", async () => {
    const dir = fs.mkdtempSync(path.join(TEMP, "named-"));
    const prompt = path.join(dir, "produce.X3.md");
    const report = path.join(dir, "X3.report.md").replace(/\\/g, "/");
    fs.writeFileSync(prompt, `Inputs: ${path.join(dir, "plan.report.md")} (read only)\n## Báo cáo\n\`${report}\`: dòng đầu \`STATUS: DONE | PENDING\`\n`);
    fs.writeFileSync(path.join(dir, "plan.report.md"), "STATUS: DONE\n");
    const f = makeFleet({
      workers: { "terminal-10": { leaderId: LEADER, title: "w", assignedAt: BASE - 600_000 } },
      runs: { "terminal-10": runningRun(1, { promptHead: `<file name="${prompt.replace(/\//g, "\\")}"> # Worker` }) },
    });
    const before = await watchFleet(f.opts({ once: true }));
    assert.equal(before.rows[0].reportExpected, report);
    assert.equal(before.rows[0].report, null);
    fs.writeFileSync(report, "STATUS: PENDING\n");
    const after = await watchFleet(f.opts({ once: true }));
    assert.equal(after.events.find((e) => e.kind === "report").status, "PENDING");
    assert.equal(after.events.filter((e) => e.kind === "report").length, 1, "plan.report.md is an input, not this worker's report");
  });

  test("a worker whose head names no path has an UNKNOWN report, flagged in the output", async () => {
    const f = makeFleet({ workers: { "terminal-10": reg() }, runs: { "terminal-10": runningRun(2, { promptHead: "Đọc tiếp followup" }) } });
    const result = await watchFleet(f.opts({ once: true }));
    assert.equal(result.rows[0].reportExpected, null);
    const worker = renderJson(result, { leader: LEADER }).split("\n").map((l) => l && JSON.parse(l)).find((o) => o && o.type === "worker");
    assert.match(worker.reportUnknown, /--report/);
  });

  test("close-worker refuses to run outside the Leader's own scope and never spawns omp as node", () => {
    const registry = { leaders: [LEADER], workers: {} };
    assert.equal(scopeProblem({ leader: LEADER }, { ANTIFAN_TERMINAL_SESSION_ID: LEADER }, registry), null);
    assert.match(scopeProblem({ leader: LEADER }, { ANTIFAN_TERMINAL_SESSION_ID: "terminal-223" }, registry), /wrong scope/);
    assert.match(scopeProblem({ leader: LEADER }, {}, registry), /unset/);
    assert.match(scopeProblem({ leader: "terminal-223" }, { ANTIFAN_TERMINAL_SESSION_ID: "terminal-223" }, registry), /not a marked Leader/);
    assert.match(scopeProblem({ leader: LEADER }, { ANTIFAN_TERMINAL_SESSION_ID: LEADER }, null), /cannot read/);
    assert.equal(nodeBinary("C:\\Users\\x\\AppData\\Local\\omp\\omp.exe"), "node");
    assert.equal(nodeBinary("C:\\Program Files\\nodejs\\node.exe"), "C:\\Program Files\\nodejs\\node.exe");
  });
});
