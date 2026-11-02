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

/**
 * Judge a turn that is not finished. `run` is the parsed run file or null when it does not exist, `since`
 * the ms timestamp at which the work was handed over. probe: { now, staleMs, graceMs, pidAlive (true | false
 * | null when unknown), activityAt (function returning the newest session write in ms or null, called only
 * when the run file alone already looks stale) }. Returns { dead, why }; `why` is set when dead, and also
 * for the "run file not written yet" start-up case.
 */
export function judgeLiveness(run, since, probe = {}) {
  const inGrace = Boolean(probe.now && probe.graceMs && probe.now - since < probe.graceMs);
  if (!run) {
    return inGrace ? { dead: false, why: "run file not written yet" } : { dead: true, why: "run file gone (terminal closed)" };
  }
  // A run file that predates the hand-over may still belong to the previous OMP of a reused terminal; its
  // pid is meaningless until the new OMP has written the file or the grace window has passed.
  const writtenSince = typeof run.lastEventAt === "number" && run.lastEventAt > since;
  if (probe.pidAlive === false && (writtenSince || !inGrace)) return { dead: true, why: `omp pid ${run.pid} no longer exists` };
  if (probe.now && probe.staleMs && typeof run.lastEventAt === "number") {
    const quietSince = (extra) => probe.now - Math.max(run.lastEventAt, since, extra ?? 0);
    if (quietSince(0) > probe.staleMs) {
      const quiet = quietSince(typeof probe.activityAt === "function" ? probe.activityAt() : 0);
      if (quiet > probe.staleMs) return { dead: true, why: `no event or session file write for ${Math.round(quiet / 60_000)} min` };
    }
  }
  return { dead: false, why: null };
}
