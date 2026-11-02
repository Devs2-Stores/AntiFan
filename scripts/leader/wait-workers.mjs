#!/usr/bin/env node
// wait-workers.mjs - wait for Leader workers outside the feedback job ledger.
//
//   node scripts/leader/wait-workers.mjs --w <terminal>,<writtenAtMs>,<minRunSeq>[,<reportPath>] ... [--all]
//        [--timeout-min N] [--stale-min N] [--poll-ms N] [--runs-dir DIR]
//
// A worker is settled when its run file shows idle / waiting_user / ended, lastEventAt is after the
// dispatch write, and runSeq >= minRunSeq. minRunSeq is required because a freshly started OMP
// writes `idle` with runSeq 0 before it reads the prompt; pass 1 for `omp "@prompt"` in a new
// session and <pre-write runSeq + 1> for a follow-up line.
// A worker is dead when its run file is gone (terminal closed; not counted in the first 3 min after
// the dispatch write, while a new OMP may not have written it yet), its OMP pid no longer exists, or it
// has had no sign of life for --stale-min minutes (default 90). Signs of life are a run-file event or a
// write to the OMP session transcript or its subagent transcripts: a worker blocked on a long subagent
// emits no run-file event but keeps writing those files. A dead worker ends the wait like a settled
// one, because nothing will ever settle it; the Leader must resume or re-dispatch it.
// Default: return when ANY worker settles or dies; --all waits until every worker settled or died.
// One JSON line per worker on stdout. Exit 0 settled, 4 at least one worker dead, 2 usage, 3 timeout.
// Flags --runs-dir (LEADER_RUNS_DIR, default E:/Work/.antifan-data/runtime/runs) and --sessions-dir
// (OMP_SESSIONS_DIR, default ~/.omp/agent/sessions) override the two lookup roots.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SETTLED_STATES = new Set(["idle", "waiting_user", "ended"]);
const START_GRACE_MS = 3 * 60_000;
const SESSION_SCAN_DEPTH = 3;

function newestMtime(p, depth) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  let latest = st.mtimeMs;
  if (st.isDirectory() && depth > 0) {
    let names = [];
    try {
      names = fs.readdirSync(p);
    } catch {
      return latest;
    }
    for (const n of names) latest = Math.max(latest, newestMtime(path.join(p, n), depth - 1));
  }
  return latest;
}

/** Newest write time (ms) under the OMP session transcript of `run`, or null when it cannot be found. */
export function sessionActivityAt(sessionsRoot, run) {
  const id = run && run.ompSessionId;
  if (typeof id !== "string" || !/^[\w-]+$/.test(id)) return null;
  let dirs;
  try {
    dirs = fs.readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  const slug = typeof run.cwd === "string" ? `--${run.cwd.replace(/[\\/:]/g, "-")}--` : null;
  if (slug && dirs.includes(slug)) dirs = [slug, ...dirs.filter((d) => d !== slug)];
  const suffix = `_${id}.jsonl`;
  for (const d of dirs) {
    const base = path.join(sessionsRoot, d);
    let names;
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    const hit = names.find((n) => n.endsWith(suffix));
    if (!hit) continue;
    const latest = Math.max(newestMtime(path.join(base, hit), 0), newestMtime(path.join(base, hit.slice(0, -".jsonl".length)), SESSION_SCAN_DEPTH));
    return latest || null;
  }
  return null;
}

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

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function judgeWorker(spec, run, reportStat, reportFirstLine, probe = {}) {
  const row = { terminal: spec.terminal };
  const reportFresh = Boolean(reportStat && reportStat.mtimeMs > spec.writtenAt);
  const status = reportFresh ? reportFirstLine : null;
  if (!run) {
    const young = probe.now && probe.graceMs && probe.now - spec.writtenAt < probe.graceMs;
    if (young) return { ...row, settled: false, dead: false, why: "run file not written yet", reportFresh, status };
    return { ...row, settled: false, dead: true, why: "run file gone (terminal closed)", reportFresh, status };
  }
  const settled =
    SETTLED_STATES.has(run.state) &&
    typeof run.lastEventAt === "number" &&
    run.lastEventAt > spec.writtenAt &&
    typeof run.runSeq === "number" &&
    run.runSeq >= spec.minRunSeq;
  let why = null;
  if (!settled) {
    const last = Math.max(run.lastEventAt, spec.writtenAt, probe.activityAt ?? 0);
    if (probe.pidAlive === false) why = `omp pid ${run.pid} no longer exists`;
    else if (probe.now && probe.staleMs && typeof run.lastEventAt === "number" && probe.now - last > probe.staleMs) {
      why = `no event or session file write for ${Math.round((probe.now - last) / 60_000)} min`;
    }
  }
  return {
    ...row,
    state: run.state,
    runSeq: run.runSeq,
    lastTool: run.lastTool ?? null,
    settled,
    dead: Boolean(why),
    ...(why ? { why } : {}),
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
  const settledNow = run && SETTLED_STATES.has(run.state);
  const activityAt = run && !settledNow ? sessionActivityAt(sessionsDir, run) : null;
  return judgeWorker(spec, run, stat, first, { pidAlive: run ? pidAlive(run.pid) : null, now: Date.now(), staleMs, graceMs: START_GRACE_MS, activityAt });
}

async function main(argv) {
  const specs = [];
  let all = false;
  let timeoutMin = 240;
  let staleMin = 90;
  let pollMs = 20_000;
  let runsDir = process.env.LEADER_RUNS_DIR || "E:/Work/.antifan-data/runtime/runs";
  let sessionsDir = process.env.OMP_SESSIONS_DIR || path.join(os.homedir(), ".omp", "agent", "sessions");
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