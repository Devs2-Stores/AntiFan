#!/usr/bin/env node
// wait-workers.mjs - wait for Leader workers outside the feedback job ledger.
//   node scripts/leader/wait-workers.mjs --mine [--leader T] [--timeout-min N] [--peek] [--table]   <- the way to wait (see fleet-watch.mjs)
//
// --mine: the Leader's WHOLE fleet from the Manager registry (new workers included, none to list by hand). The fixed
// --w list below stays for a Leader that must pin one worker to a dispatch time; it can silently drop workers.
//
//   node scripts/leader/wait-workers.mjs --w <terminal>,<writtenAtMs>,<minRunSeq>[,<reportPath>] ... [--all]
//        [--timeout-min N] [--stale-min N] [--undelivered-sec N] [--poll-ms N] [--runs-dir DIR] [--sessions-dir DIR]
//
// A worker is settled when its run file shows idle / waiting_user / ended, lastEventAt is after the
// dispatch write, and runSeq >= minRunSeq. minRunSeq is required because a freshly started OMP
// writes `idle` with runSeq 0 before it reads the prompt; pass 1 for `omp "@prompt"` in a new
// session and <pre-write runSeq + 1> for a follow-up line.
// A worker is dead when it is not alive by the rules of worker-liveness.mjs: its run file is gone, its
// OMP pid no longer exists, its OMP session ended (`ended`) before taking the input, an idle run stopped
// heartbeating, or it has shown no sign of life (a run-file event or a session transcript write) for
// --stale-min minutes (default 90). A worker is UNDELIVERED when its OMP is alive and idle but its run did
// not progress (runSeq < minRunSeq, or no event after the write) within --undelivered-sec seconds (default 90)
// of the write: the prompt never reached it. Both end the wait like a settled worker, because nothing will
// ever settle them; the Leader must recycle the worker (new terminal, continuation prompt). Rows carry
// `ompAlive`, `effectiveState` and, when dead or undelivered, `why`.
// Default: return when ANY worker settles, dies or is undelivered; --all waits until every worker is one of those.
// No clock deadline unless --timeout-min is passed; then exit 3 when it passes with nothing settled.
// One JSON line per worker on stdout. Exit 0 settled, 4 at least one worker dead, 7 at least one undelivered
// (and none dead), 2 usage, 3 timeout (--timeout-min only).
// Flags --runs-dir (LEADER_RUNS_DIR, default E:/Work/.antifan-data/runtime/runs) and --sessions-dir
// (OMP_SESSIONS_DIR, default ~/.omp/agent/sessions) override the two lookup roots.
// A worker waiting for the user (`waiting_user`) also carries `ask`: the open `ask` dialog read from its transcript
// (questions, options, recommended, and `answerKeys` per option to send with terminal.write { keys }).

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultSessionsDir, effectiveRunState, judgeLiveness, pidAlive, sessionActivityAt, START_GRACE_MS, UNDELIVERED_AFTER_MS, undeliveredWhy } from "./worker-liveness.mjs";
import { FALLBACK_TICK_MS, nextRunChange } from "./event-wait.mjs";
import { pendingAskOf } from "./ask-dialog.mjs";

const SETTLED_STATES = new Set(["idle", "waiting_user", "ended"]);

export function parseSpec(text) {
  const parts = String(text).split(",");
  if (parts.length < 3) throw new Error(`--w needs <terminal>,<writtenAtMs>,<minRunSeq>[,<reportPath>]: ${text}`);
  const [terminal, at, seq, ...rest] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(terminal)) throw new Error(`bad terminal id: ${terminal}`);
  const writtenAt = Number(at);
  const minRunSeq = Number(seq);
  if (!Number.isFinite(writtenAt) || writtenAt <= 0) throw new Error(`bad writtenAt: ${at}`);
  if (!Number.isInteger(minRunSeq) || minRunSeq < 1) throw new Error(`minRunSeq must be an integer >= 1: ${seq}`);
  return { terminal, writtenAt, minRunSeq, report: rest.length ? rest.join(",") : null };
}

export function judgeWorker(spec, run, reportStat, reportFirstLine, probe = {}) {
  const row = { terminal: spec.terminal };
  const reportFresh = Boolean(reportStat && reportStat.mtimeMs > spec.writtenAt);
  const status = reportFresh ? reportFirstLine : null;
  if (!run) {
    const live = judgeLiveness(null, spec.writtenAt, probe);
    return { ...row, settled: false, dead: live.dead, undelivered: false, ompAlive: false, why: live.why, reportFresh, status };
  }
  const settled =
    SETTLED_STATES.has(run.state) &&
    typeof run.lastEventAt === "number" &&
    run.lastEventAt > spec.writtenAt &&
    typeof run.runSeq === "number" &&
    run.runSeq >= spec.minRunSeq;
  const live = settled ? { dead: false, why: null } : judgeLiveness(run, spec.writtenAt, probe);
  const eff = effectiveRunState(run, probe);
  // An idle OMP that is alive and heartbeating but whose run never progressed took nothing: the prompt went
  // nowhere (a modal, a hung input loop, a shell instead of OMP). Not dead, not settled: the Leader must recycle it.
  const why = !settled && !live.dead && probe.now ? undeliveredWhy(eff.state, false, spec.writtenAt, probe.now, probe.undeliveredMs) : null;
  return {
    ...row,
    state: run.state,
    effectiveState: eff.state,
    ompAlive: eff.ompAlive,
    runSeq: run.runSeq,
    lastTool: run.lastTool ?? null,
    settled,
    dead: live.dead,
    undelivered: why !== null,
    ...(live.dead ? { why: live.why } : why !== null ? { why } : {}),
    reportFresh,
    status,
  };
}

function readRow(runsDir, sessionsDir, spec, staleMs, undeliveredMs) {
  let run = null;
  try {
    run = JSON.parse(fs.readFileSync(path.join(runsDir, `${spec.terminal}.json`), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") return { terminal: spec.terminal, settled: false, dead: false, undelivered: false, why: `run file unreadable: ${e.message}` };
    run = null;
  }
  let stat = null;
  let first = null;
  if (spec.report && fs.existsSync(spec.report)) {
    stat = fs.statSync(spec.report);
    first = fs.readFileSync(spec.report, "utf8").split(/\r?\n/, 1)[0];
  }
  const row = judgeWorker(spec, run, stat, first, {
    pidAlive: run ? pidAlive(run.pid) : null,
    now: Date.now(),
    staleMs,
    undeliveredMs,
    // A follow-up (minRunSeq > 1) goes to an OMP that already ran: no new OMP is starting, so a dead pid is dead at once.
    graceMs: spec.minRunSeq > 1 ? 0 : START_GRACE_MS,
    activityAt: () => sessionActivityAt(sessionsDir, run),
  });
  // A worker waiting for the user: say what it asks, so nobody digs through the transcript.
  return run?.state === "waiting_user" ? { ...row, ask: pendingAskOf(sessionsDir, run) } : row;
}

async function main(argv) {
  // --mine: no fixed list; every worker the Leader registry names, new ones included (fleet-watch.mjs).
  if (argv.includes("--mine")) return (await import("./fleet-watch.mjs")).main(argv);
  const specs = [];
  let all = false;
  let timeoutMin = null;
  let staleMin = 90;
  let undeliveredSec = UNDELIVERED_AFTER_MS / 1000;
  let pollMs = FALLBACK_TICK_MS;
  let runsDir = process.env.LEADER_RUNS_DIR || "E:/Work/.antifan-data/runtime/runs";
  let sessionsDir = defaultSessionsDir();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--w") specs.push(parseSpec(argv[++i]));
    else if (a === "--all") all = true;
    else if (a === "--timeout-min") timeoutMin = Number(argv[++i]);
    else if (a === "--stale-min") staleMin = Number(argv[++i]);
    else if (a === "--undelivered-sec") undeliveredSec = Number(argv[++i]);
    else if (a === "--poll-ms") pollMs = Number(argv[++i]);
    else if (a === "--runs-dir") runsDir = argv[++i];
    else if (a === "--sessions-dir") sessionsDir = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!specs.length) throw new Error("pass at least one --w");
  if (!(staleMin > 0)) throw new Error(`--stale-min must be > 0: ${staleMin}`);
  if (!(undeliveredSec > 0)) throw new Error(`--undelivered-sec must be > 0: ${undeliveredSec}`);
  if (timeoutMin !== null && !(timeoutMin > 0)) throw new Error(`--timeout-min must be > 0: ${timeoutMin}`);
  const names = new Set(specs.map((s) => `${s.terminal}.json`));
  const deadline = timeoutMin === null ? Infinity : Date.now() + timeoutMin * 60_000;
  for (;;) {
    const rows = specs.map((s) => readRow(runsDir, sessionsDir, s, staleMin * 60_000, undeliveredSec * 1000));
    const ended = (r) => r.settled || r.dead || r.undelivered;
    const done = all ? rows.every(ended) : rows.some(ended);
    if (done || Date.now() > deadline) {
      for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);
      if (!done) return 3;
      if (rows.some((r) => r.dead)) return 4;
      return rows.some((r) => r.undelivered) ? 7 : 0;
    }
    await nextRunChange(runsDir, { fallbackMs: pollMs, names });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    },
  );
}
