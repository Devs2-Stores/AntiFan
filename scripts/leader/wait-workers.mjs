#!/usr/bin/env node
// wait-workers.mjs - wait for Leader workers outside the feedback job ledger.
//
//   node scripts/leader/wait-workers.mjs --w <terminal>,<writtenAtMs>,<minRunSeq>[,<reportPath>] ... [--all]
//        [--timeout-min N] [--stale-min N] [--poll-ms N] [--runs-dir DIR] [--sessions-dir DIR]
//
// A worker is settled when its run file shows idle / waiting_user / ended, lastEventAt is after the
// dispatch write, and runSeq >= minRunSeq. minRunSeq is required because a freshly started OMP
// writes `idle` with runSeq 0 before it reads the prompt; pass 1 for `omp "@prompt"` in a new
// session and <pre-write runSeq + 1> for a follow-up line.
// A worker is dead when it is not alive by the rules of worker-liveness.mjs: its run file is gone, its
// OMP pid no longer exists, or it has shown no sign of life (a run-file event or a session transcript
// write) for --stale-min minutes (default 90). A dead worker ends the wait like a settled one, because
// nothing will ever settle it; the Leader must resume or re-dispatch it.
// Default: return when ANY worker settles or dies; --all waits until every worker settled or died.
// One JSON line per worker on stdout. Exit 0 settled, 4 at least one worker dead, 2 usage, 3 timeout.
// Flags --runs-dir (LEADER_RUNS_DIR, default E:/Work/.antifan-data/runtime/runs) and --sessions-dir
// (OMP_SESSIONS_DIR, default ~/.omp/agent/sessions) override the two lookup roots.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultSessionsDir, judgeLiveness, pidAlive, sessionActivityAt, START_GRACE_MS } from "./worker-liveness.mjs";

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
    return { ...row, settled: false, dead: live.dead, why: live.why, reportFresh, status };
  }
  const settled =
    SETTLED_STATES.has(run.state) &&
    typeof run.lastEventAt === "number" &&
    run.lastEventAt > spec.writtenAt &&
    typeof run.runSeq === "number" &&
    run.runSeq >= spec.minRunSeq;
  const live = settled ? { dead: false, why: null } : judgeLiveness(run, spec.writtenAt, probe);
  return {
    ...row,
    state: run.state,
    runSeq: run.runSeq,
    lastTool: run.lastTool ?? null,
    settled,
    dead: live.dead,
    ...(live.dead ? { why: live.why } : {}),
    reportFresh,
    status,
  };
}

function readRow(runsDir, sessionsDir, spec, staleMs) {
  let run = null;
  try {
    run = JSON.parse(fs.readFileSync(path.join(runsDir, `${spec.terminal}.json`), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") return { terminal: spec.terminal, settled: false, dead: false, why: `run file unreadable: ${e.message}` };
    run = null;
  }
  let stat = null;
  let first = null;
  if (spec.report && fs.existsSync(spec.report)) {
    stat = fs.statSync(spec.report);
    first = fs.readFileSync(spec.report, "utf8").split(/\r?\n/, 1)[0];
  }
  return judgeWorker(spec, run, stat, first, {
    pidAlive: run ? pidAlive(run.pid) : null,
    now: Date.now(),
    staleMs,
    graceMs: START_GRACE_MS,
    activityAt: () => sessionActivityAt(sessionsDir, run),
  });
}

async function main(argv) {
  const specs = [];
  let all = false;
  let timeoutMin = 240;
  let staleMin = 90;
  let pollMs = 20_000;
  let runsDir = process.env.LEADER_RUNS_DIR || "E:/Work/.antifan-data/runtime/runs";
  let sessionsDir = defaultSessionsDir();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--w") specs.push(parseSpec(argv[++i]));
    else if (a === "--all") all = true;
    else if (a === "--timeout-min") timeoutMin = Number(argv[++i]);
    else if (a === "--stale-min") staleMin = Number(argv[++i]);
    else if (a === "--poll-ms") pollMs = Number(argv[++i]);
    else if (a === "--runs-dir") runsDir = argv[++i];
    else if (a === "--sessions-dir") sessionsDir = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!specs.length) throw new Error("pass at least one --w");
  if (!(staleMin > 0)) throw new Error(`--stale-min must be > 0: ${staleMin}`);
  const deadline = Date.now() + timeoutMin * 60_000;
  for (;;) {
    const rows = specs.map((s) => readRow(runsDir, sessionsDir, s, staleMin * 60_000));
    const ended = (r) => r.settled || r.dead;
    const done = all ? rows.every(ended) : rows.some(ended);
    if (done || Date.now() > deadline) {
      for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);
      if (!done) return 3;
      return rows.some((r) => r.dead) ? 4 : 0;
    }
    await new Promise((r) => setTimeout(r, pollMs));
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
