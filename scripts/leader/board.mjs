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
  if (row.state === "worker_dead" || row.finishedUnseen) return 1;
  if (row.state === "verified" || row.state === "user-approved") return 2;
  if (row.stale) return 3;
  return 4;
}

/**
 * @param {{jobsRoot:string, runsDir?:string, leader?:string, now?:number, staleHours?:number, includeClosed?:boolean}} opts
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
    const needsMe = ["needs_input", "worker_dead", "verified", "user-approved"].includes(state) || finishedUnseen || stale;
    rows.push({
      job: job.job ?? name,
      state,
      ageHours,
      rounds: job.rounds.length,
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
    lines.push(`${flag} ${r.job} | ${r.state}${stale} | ${r.ageHours}h | r${r.rounds} | ${r.blocking}${dead}`.slice(0, 220));
  });
  if (rows.length > room) lines.push(`... ${rows.length - room} more not shown`);
  if (!rows.length) lines.push("(no open jobs)");
  return { at: now, rows: outRows, needsMe, text: lines.join("\n") };
}
