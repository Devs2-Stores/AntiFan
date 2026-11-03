// worker-liveness.mjs - is a Leader worker that has not finished its turn still alive?
//
// Shared by wait-workers.mjs and the ledger's `leader-job.mjs wait`. A worker is dead when its run file
// is gone (terminal closed; not counted in the first START_GRACE_MS after the hand-over, while a new OMP
// may not have written it yet), its OMP pid no longer exists, or it has shown no sign of life for staleMs.
// Signs of life are a run-file event or a write to the OMP session transcript or its subagent
// transcripts: a worker blocked on a long subagent emits no run-file event but keeps writing those files.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const START_GRACE_MS = 3 * 60_000;
/** An idle OMP rewrites its run file every 15 s (RUN_HEARTBEAT_MS in the run-state hook); the Manager calls a run stale after 45 s (RUN_STALE_MS). */
export const HEARTBEAT_STALE_MS = 45_000;
/** A prompt typed into an idle OMP can take 15 to 55 s to start a run (the old turn closes, context loads, files are read; measured 04/11/2026); an idle run that has not progressed this long after the write never took it. */
export const UNDELIVERED_AFTER_MS = 90_000;
const SESSION_SCAN_DEPTH = 3;

export function defaultSessionsDir() {
  return process.env.OMP_SESSIONS_DIR || path.join(os.homedir(), ".omp", "agent", "sessions");
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

/** The OMP session transcript of `run`: `<sessions>/<cwd slug>/<time>_<ompSessionId>.jsonl`, or null when it cannot be found. */
export function findSessionFile(sessionsRoot, run) {
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
    if (hit) return path.join(base, hit);
  }
  return null;
}

/** Newest write time (ms) under the OMP session transcript of `run`, or null when it cannot be found. */
export function sessionActivityAt(sessionsRoot, run) {
  const file = findSessionFile(sessionsRoot, run);
  if (!file) return null;
  const latest = Math.max(newestMtime(file, 0), newestMtime(file.slice(0, -".jsonl".length), SESSION_SCAN_DEPTH));
  return latest || null;
}

/**
 * Judge a turn that is not finished. `run` is the parsed run file or null when it does not exist, `since`
 * the ms timestamp at which the work was handed over. probe: { now, staleMs, graceMs, pidAlive (true | false
 * | null when unknown), activityAt (function returning the newest session write in ms or null, called only
 * when the run file alone already looks stale) }. Returns { dead, why }; `why` is set when dead, and also
 * for the "run file not written yet" start-up case.
 *
 * Dead means nothing will ever settle the turn: the run file is gone, the OMP pid is gone, the OMP session
 * ended (`ended`: OMP exited, so what was typed went to a shell), an idle run stopped heartbeating (frozen
 * or gone), or no sign of life for staleMs. A file that predates the hand-over is judged only once the new
 * OMP wrote it or the grace window has passed.
 */
export function judgeLiveness(run, since, probe = {}) {
  const inGrace = Boolean(probe.now && probe.graceMs && probe.now - since < probe.graceMs);
  if (!run) {
    return inGrace ? { dead: false, why: "run file not written yet" } : { dead: true, why: "run file gone (terminal closed)" };
  }
  // A run file that predates the hand-over may still belong to the previous OMP of a reused terminal; its
  // pid is meaningless until the new OMP has written the file or the grace window has passed.
  const writtenSince = typeof run.lastEventAt === "number" && run.lastEventAt > since;
  const judgeable = writtenSince || !inGrace;
  if (probe.pidAlive === false && judgeable) return { dead: true, why: `omp pid ${run.pid} no longer exists` };
  if (run.state === "ended" && judgeable) {
    return { dead: true, why: `OMP session ended (runSeq ${run.runSeq ?? "?"}) before it took the input: the text went to the shell` };
  }
  if (run.state === "idle" && probe.now && typeof run.updatedAt === "number" && judgeable && probe.now - run.updatedAt > HEARTBEAT_STALE_MS) {
    return { dead: true, why: `omp heartbeat stale for ${Math.round((probe.now - run.updatedAt) / 1000)} s on an idle run (process frozen or gone)` };
  }
  if (probe.now && probe.staleMs && typeof run.lastEventAt === "number") {
    const quietSince = (extra) => probe.now - Math.max(run.lastEventAt, since, extra ?? 0);
    if (quietSince(0) > probe.staleMs) {
      const quiet = quietSince(typeof probe.activityAt === "function" ? probe.activityAt() : 0);
      if (quiet > probe.staleMs) return { dead: true, why: `no event or session file write for ${Math.round(quiet / 60_000)} min` };
    }
  }
  return { dead: false, why: null };
}

/**
 * The run state the Manager shows: a run that has not ended turns `ended` when its OMP pid is gone or an
 * idle run stopped heartbeating. `ompAlive` is true / false / null (pid unknown).
 */
export function effectiveRunState(run, probe = {}) {
  if (!run) return { state: null, ompAlive: false, why: "no run file" };
  if (run.state === "ended") return { state: "ended", ompAlive: false, why: "OMP session ended" };
  if (probe.pidAlive === false) return { state: "ended", ompAlive: false, why: `omp pid ${run.pid} no longer exists` };
  if (run.state === "idle" && probe.now && typeof run.updatedAt === "number" && probe.now - run.updatedAt > HEARTBEAT_STALE_MS) {
    return { state: "ended", ompAlive: false, why: `omp heartbeat stale for ${Math.round((probe.now - run.updatedAt) / 1000)} s` };
  }
  return { state: run.state ?? null, ompAlive: probe.pidAlive ?? null, why: null };
}

/**
 * An OMP that is alive and idle yet never took the input typed at `since`: its run did not progress
 * (`progressed` false) within afterMs of the write. Returns the reason, or null while the input may still be on its way
 * (the run is not idle, it progressed, or the wait is not over).
 */
export function undeliveredWhy(runState, progressed, since, now, afterMs = UNDELIVERED_AFTER_MS) {
  if (runState !== "idle" || progressed || !(now - since > afterMs)) return null;
  return `OMP is alive and idle but started no run in ${Math.round((now - since) / 1000)} s after the input: it never took the prompt`;
}
