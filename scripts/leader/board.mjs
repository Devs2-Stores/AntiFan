// board.mjs - one-screen "what needs me" view over the Leader job ledger.
// Read-only: it only reads <jobsRoot>/*/job.json and (optionally) <runsDir>/<terminal>.json.
// Importable ESM, no side effects at load, no dependency on leader-job.mjs.

import fs from "node:fs";
import path from "node:path";

const JOB_SCHEMA = "leader-job/1";
const HOUR_MS = 3600 * 1000;
const MAX_LINES = 40;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readRun(runsDir, terminal) {
  if (!runsDir || typeof terminal !== "string" || !/^[A-Za-z0-9._-]+$/.test(terminal)) return null;
  return readJson(path.join(runsDir, `${terminal}.json`));
}

const REPORT_HEAD_BYTES = 512;

/** Line 1 of a report as `STATUS: <word>`: only the word, read from the first bytes, and only when the file is newer than the round's dispatch. */
function reportStatusOf(round) {
  if (typeof round?.reportPath !== "string") return null;
  let fd = null;
  try {
    fd = fs.openSync(round.reportPath, "r");
    if (typeof round.dispatchedAt === "number" && fs.fstatSync(fd).mtimeMs < round.dispatchedAt) return null;
    const buf = Buffer.alloc(REPORT_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, REPORT_HEAD_BYTES, 0);
    const first = buf.toString("utf8", 0, n).replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
    return /^STATUS:\s*([A-Za-z_]+)/.exec(first)?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * How far along a job is: its latest round, the worker's run file (silence, last tool) and the first line of the
 * round's report. Every field is null when its source is missing or half-written; it never throws.
 */
export function jobProgress(job, runsDir, now = Date.now()) {
  const rounds = Array.isArray(job?.rounds) ? job.rounds : [];
  const last = rounds.at(-1) ?? null;
  const terminal = typeof last?.worker?.terminal === "string" ? last.worker.terminal : null;
  const run = last ? readRun(runsDir, terminal) : null;
  const usable = run !== null && typeof run === "object" && !run.unreadable;
  return {
    round: typeof last?.n === "number" ? last.n : null,
    kind: typeof last?.kind === "string" ? last.kind : null,
    roundsUsed: rounds.filter((r) => (r?.kind === "work" || r?.kind === "followup") && !r.deadAt).length,
    worker: terminal,
    runState: usable && typeof run.state === "string" ? run.state : null,
    silentMin: usable && Number.isFinite(run.lastEventAt) ? Math.max(0, Math.floor((now - run.lastEventAt) / 60_000)) : null,
    lastTool: usable && typeof run.lastTool === "string" ? run.lastTool : null,
    workerAlive: usable ? run.state !== "ended" : null,
    reportStatus: last ? reportStatusOf(last) : null,
  };
}

function blockingText(job, last) {
  switch (job.state) {
    case "open":
      return "no round dispatched yet";
    case "dispatched":
      return `worker ${last?.worker?.terminal ?? "?"} running round ${last?.n ?? "?"}`;
    case "settled":
      return "worker idle: validate-report";
    case "reported":
      return "independent verification pending";
    case "worker_dead":
      return `worker ${last?.worker?.terminal ?? "?"} died in round ${last?.n ?? "?"}: dispatch a new round to a fresh worker`;
    case "needs_input":
      return "waiting for the user's answer";
    case "verified":
      return "verified; waiting for the user's approval";
    case "user-approved":
      return job.closeVerifiedAt ? "ready to close" : "dispatch the close round";
    case "closed":
      return "closed";
    default:
      return "";
  }
}

// Lower rank = listed first.
function rankOf(row) {
  if (row.state === "needs_input") return 0;
  if (row.reportStatus === "NEEDS_INPUT") return 1;
  if (row.state === "worker_dead" || row.finishedUnseen) return 1;
  if (row.state === "verified" || row.state === "user-approved") return 2;
  if (row.stale) return 3;
  return 4;
}

/**
 * @param {{jobsRoot:string, runsDir?:string, leader?:string|null, now?:number, staleHours?:number, includeClosed?:boolean}} opts
 * `leader` omitted or null lists every Leader's jobs in one pass (one listing, one job.json read each); each row then also
 * carries `leader`, its Leader terminal id (null when the job has none). Rows are sorted as for one Leader: needs-user first.
 * @returns {{at:number, rows:object[], needsMe:string[], text:string}}
 */
export function buildBoard({ jobsRoot, runsDir, leader, now = Date.now(), staleHours = 24, includeClosed = false } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(jobsRoot).sort();
  } catch {}
  const rows = [];
  for (const name of names) {
    const job = readJson(path.join(jobsRoot, name, "job.json"));
    if (!job || job.schema !== JOB_SCHEMA || !Array.isArray(job.rounds)) continue;
    if (leader && job.leader?.terminal !== leader) continue;
    const state = typeof job.state === "string" ? job.state : "open";
    if (state === "closed" && !includeClosed) continue;
    const last = job.rounds.at(-1);
    const touched = [job.updatedAt, job.createdAt].find((v) => typeof v === "number" && Number.isFinite(v)) ?? now;
    const ageHours = Math.max(0, Math.round(((now - touched) / HOUR_MS) * 10) / 10);
    const stale = state !== "closed" && now - touched >= staleHours * HOUR_MS;
    // A dispatched round whose worker already went idle: nothing has run wait-any since.
    let finishedUnseen = false;
    if (state === "dispatched" && last && !last.settledAt && !last.deadAt) {
      const run = readRun(runsDir, last.worker?.terminal);
      finishedUnseen = !!run && (run.state === "idle" || run.state === "ended") && typeof run.runSeq === "number" && run.runSeq > (last.preRunSeq ?? 0);
    }
    const deadRound = [...job.rounds].reverse().find((r) => r.deadAt || r.deadWhy);
    const deadWhy = deadRound?.deadWhy ?? null;
    const progress = jobProgress(job, runsDir, now);
    const needsMe = ["needs_input", "worker_dead", "verified", "user-approved"].includes(state) || finishedUnseen || stale || (state !== "closed" && progress.reportStatus === "NEEDS_INPUT");
    rows.push({
      job: job.job ?? name,
      ...(leader ? {} : { leader: typeof job.leader?.terminal === "string" ? job.leader.terminal : null }),
      state,
      ageHours,
      rounds: job.rounds.length,
      ...progress,
      blocking: finishedUnseen ? `worker ${last.worker?.terminal} FINISHED round ${last.n} (idle): run wait-any` : blockingText(job, last),
      needsMe,
      stale,
      deadWhy,
      finishedUnseen,
    });
  }
  rows.sort((a, b) => rankOf(a) - rankOf(b) || b.ageHours - a.ageHours || (a.job < b.job ? -1 : 1));
  const needsMe = rows.filter((r) => r.needsMe).map((r) => r.job);
  const outRows = rows.map(({ finishedUnseen, ...r }) => r);

  const lines = [`Leader board (${rows.length} job${rows.length === 1 ? "" : "s"}, ${needsMe.length} need you)`];
  const room = MAX_LINES - 2;
  rows.slice(0, room).forEach((r) => {
    const flag = r.needsMe ? "!" : " ";
    const dead = r.deadWhy && r.state === "worker_dead" ? ` [${r.deadWhy}]` : "";
    const stale = r.stale ? " STALE" : "";
    const where = r.round !== null ? `r${r.round}/${r.kind ?? "?"}` : `r${r.rounds}`;
    const silent = r.silentMin !== null ? ` | silent ${r.silentMin}m` : "";
    const rep = r.reportStatus ? ` | STATUS: ${r.reportStatus}` : "";
    lines.push(`${flag} ${r.job} | ${r.state}${stale} | ${r.ageHours}h | ${where}${silent}${rep} | ${r.blocking}${dead}`.slice(0, 220));
  });
  if (rows.length > room) lines.push(`... ${rows.length - room} more not shown`);
  if (!rows.length) lines.push("(no open jobs)");
  return { at: now, rows: outRows, needsMe, text: lines.join("\n") };
}
