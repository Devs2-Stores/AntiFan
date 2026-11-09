#!/usr/bin/env node
// Read-only: safe to run while the worker is busy.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { pendingAskOf } from "./ask-dialog.mjs";
import { defaultSessionsDir, effectiveRunState, findSessionFile, judgeLiveness, pidAlive, sessionActivityAt, START_GRACE_MS, UNDELIVERED_AFTER_MS, undeliveredWhy } from "./worker-liveness.mjs";

const DEFAULT_RUNS_DIR = "E:/Work/.antifan-data/runtime/runs";
const TAIL_BYTES = 1_000_000;
const TOOL_EVENT = "tool_execution_start";
// Same stale default as leader-job wait and wait-workers (--stale-min 90).
const STALE_MS = 90 * 60_000;
const SETTLED_STATES = new Set(["idle", "waiting_user", "ended"]);

/** The newest `limit` tool calls in transcript `text`, oldest first. The first line of a tail read may be cut. */
export function recentToolCalls(text, limit) {
  const calls = [];
  for (const line of text.split("\n")) {
    if (!line.includes(TOOL_EVENT)) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.customType !== TOOL_EVENT || !ev.data) continue;
    calls.push({
      at: ev.data.startedAt ?? ev.timestamp ?? null,
      tool: ev.data.toolName ?? null,
      intent: ev.data.intent ?? ev.data.args?.intent ?? null,
    });
  }
  return calls.slice(-limit);
}

function readTail(file, bytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString("utf8");
}

export function parseArgs(argv) {
  const out = {
    terminal: null,
    tools: 5,
    runsDir: process.env.LEADER_RUNS_DIR || DEFAULT_RUNS_DIR,
    sessionsDir: defaultSessionsDir(),
    since: null,
    minRunSeq: null,
    undeliveredMs: UNDELIVERED_AFTER_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--terminal") out.terminal = argv[++i];
    else if (a === "--tools") out.tools = Number(argv[++i]);
    else if (a === "--runs-dir") out.runsDir = argv[++i];
    else if (a === "--sessions-dir") out.sessionsDir = argv[++i];
    else if (a === "--since") out.since = Number(argv[++i]);
    else if (a === "--min-run-seq") out.minRunSeq = Number(argv[++i]);
    else if (a === "--undelivered-sec") out.undeliveredMs = Number(argv[++i]) * 1000;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.terminal || !/^[A-Za-z0-9_-]+$/.test(out.terminal)) throw new Error("--terminal <id> is required");
  if (!Number.isInteger(out.tools) || out.tools < 1) throw new Error("--tools must be an integer >= 1");
  if ((out.since === null) !== (out.minRunSeq === null)) throw new Error("--since <writtenAtMs> and --min-run-seq <N> go together");
  if (out.since !== null && !(Number.isFinite(out.since) && out.since > 0)) throw new Error("--since must be the writtenAt epoch ms of the terminal.write");
  if (out.minRunSeq !== null && !(Number.isInteger(out.minRunSeq) && out.minRunSeq >= 1)) throw new Error("--min-run-seq must be an integer >= 1 (pre-write runSeq + 1)");
  if (!(out.undeliveredMs > 0)) throw new Error("--undelivered-sec must be > 0");
  return out;
}

/**
 * Is the OMP in this run alive, and is a run that has not settled still moving? `effective` is the run state
 * the Manager shows (`ended` once the OMP pid is gone or an idle run stopped heartbeating). A crashed or frozen
 * OMP is dead whatever its file still says; one that shut down cleanly (`ended` in the file) is not alive but
 * not dead either. A run that is not settled is also dead after STALE_MS of silence with no transcript write.
 * No hand-over time applies here, so `since` is 0.
 */
export function liveness(run, effective, sessionsDir, now, staleMs = STALE_MS) {
  if (effective.ompAlive === false) return { dead: run.state !== "ended", why: effective.why };
  if (SETTLED_STATES.has(run.state)) return { dead: false, why: null };
  return judgeLiveness(run, 0, {
    now,
    staleMs,
    graceMs: START_GRACE_MS,
    pidAlive: true,
    activityAt: () => sessionActivityAt(sessionsDir, run),
  });
}

/**
 * Did the input typed at `since` start a run? Only the run counter says so (lastEventAt also moves when the previous
 * turn closes). A run that started stays `started` even if the OMP died later: `dead` / `why` report the crash.
 */
function deliveryOf(run, effective, opts, now) {
  if (opts.since == null) return null;
  if (typeof run.runSeq === "number" && run.runSeq >= opts.minRunSeq) return { delivery: "started", deliveryWhy: null };
  if (effective.ompAlive === false) return { delivery: "not_running", deliveryWhy: effective.why };
  const why = undeliveredWhy(effective.state, false, opts.since, now, opts.undeliveredMs);
  return why ? { delivery: "not_started", deliveryWhy: why } : { delivery: "pending", deliveryWhy: null };
}

export function status(opts, now = Date.now()) {
  let run;
  try {
    run = JSON.parse(fs.readFileSync(path.join(opts.runsDir, `${opts.terminal}.json`), "utf8"));
  } catch {
    return { code: 4, out: { ok: false, reason: "NO_RUN_FILE", terminal: opts.terminal } };
  }
  const file = findSessionFile(opts.sessionsDir, run);
  const effective = effectiveRunState(run, { now, pidAlive: pidAlive(run.pid) });
  const live = liveness(run, effective, opts.sessionsDir, now);
  return {
    code: 0,
    out: {
      terminal: opts.terminal,
      state: effective.state ?? null,
      rawState: run.state ?? null,
      ompAlive: effective.ompAlive,
      dead: live.dead,
      why: live.why,
      runSeq: run.runSeq ?? null,
      lastEventAt: run.lastEventAt ?? null,
      idleSec: typeof run.lastEventAt === "number" ? Math.max(0, Math.round((now - run.lastEventAt) / 1000)) : null,
      heartbeatAgeSec: typeof run.updatedAt === "number" ? Math.max(0, Math.round((now - run.updatedAt) / 1000)) : null,
      lastTool: run.lastTool ?? null,
      promptHead: run.promptHead ?? null,
      transcript: file ? path.basename(file) : null,
      ...(deliveryOf(run, effective, opts, now) ?? {}),
      ...(effective.state === "waiting_user" ? { ask: pendingAskOf(opts.sessionsDir, run) } : {}),
      toolCalls: file ? recentToolCalls(readTail(file, TAIL_BYTES), opts.tools) : [],
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let opts = null;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "USAGE", message: e.message })}\n`);
    process.exitCode = 2;
  }
  if (opts) {
    const { code, out } = status(opts);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = code;
  }
}
