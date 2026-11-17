// evidence-xcheck.mjs - cross-check a Leader report's claims against the worker's own OMP transcript.
//
// A report is prose written by the worker. The transcript (JSONL, one entry per line) records what the
// worker actually did: `assistant` messages carry `toolCall` parts {id,name,arguments}, `toolResult` messages
// carry {toolCallId,toolName,isError}. This module only READS; it never blocks a close by itself.
// Parse trouble yields "unknown", never "contradicted".
//
//   node scripts/leader/evidence-xcheck.mjs --scan <jobsRoot> --runs <runsDir> [--sessions <dir>]
// is the dry-run that measures the uncorroborated rate over historical rounds.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultSessionsDir, findSessionFile } from "./worker-liveness.mjs";
import { parseReport } from "./report.mjs";

// Tools that only record intent or ask; a DONE round made of nothing else did no work.
const BOOKKEEPING = new Set(["todo_write", "todowrite", "ask", "askuserquestion"]);
const WRITE_TOOLS = new Set(["write", "edit", "bash", "ast_edit", "notebook"]);
const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase();

/**
 * @param {string} text transcript JSONL
 * @param {number} [sinceMs] only calls at/after this epoch-ms count (entry.timestamp)
 * @returns {{calls: Array<{id:string,name:string,args:string,ok:boolean|null,at:number|null}>, parsed:number, unparsed:number}}
 */
export function indexTranscript(text, sinceMs = 0) {
  const calls = new Map();
  let parsed = 0;
  let unparsed = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      unparsed += 1;
      continue;
    }
    parsed += 1;
    const message = entry?.message;
    if (!message) continue;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : typeof entry.timestamp === "number" ? entry.timestamp : null;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall" || !part.id) continue;
        if (sinceMs && at !== null && at < sinceMs) continue;
        let args = "";
        try {
          args = norm(JSON.stringify(part.arguments ?? {}));
        } catch {
          args = "";
        }
        calls.set(part.id, { id: part.id, name: String(part.name ?? ""), args, ok: null, at });
      }
    } else if (message.role === "toolResult" && calls.has(message.toolCallId)) {
      calls.get(message.toolCallId).ok = message.isError !== true;
    }
  }
  return { calls: [...calls.values()], parsed, unparsed };
}

const meaningful = (c) => !BOOKKEEPING.has(c.name.toLowerCase());

/** A claimed path is corroborated by a write-capable call whose arguments contain the path, or its basename (>= 5 chars). */
function touches(calls, claimed) {
  const full = norm(claimed).replace(/^\.?\//, "");
  const base = full.split("/").pop() ?? full;
  return calls.some((c) => WRITE_TOOLS.has(c.name.toLowerCase()) && c.ok !== false && (c.args.includes(full) || (base.length >= 5 && c.args.includes(base))));
}

/**
 * @param {object} json parsed report json
 * @param {{calls:Array, parsed:number}} index
 * @param {{status?:string, kind?:string, adhoc?:boolean}} [ctx]
 */
export function crossCheck(json, index, ctx = {}) {
  const out = { corroborated: [], uncorroborated: [], contradicted: [], unknown: [] };
  if (!json || typeof json !== "object") return out;
  if (index.parsed === 0) {
    out.unknown.push("transcript unreadable or empty");
    return out;
  }
  const files = Array.isArray(json.files) ? json.files.filter((f) => typeof f === "string") : [];
  const pushed = Array.isArray(json.pushed) ? json.pushed.filter((f) => typeof f === "string") : [];
  const work = index.calls.filter(meaningful);
  const exempt = ctx.kind === "review" || (ctx.adhoc && files.length === 0);
  if (ctx.status === "DONE" && work.length === 0 && !exempt) out.contradicted.push("DONE report but the transcript has no non-bookkeeping tool call this round");
  for (const f of files) (touches(index.calls, f) ? out.corroborated : out.uncorroborated).push(`files: ${f}`);
  const shell = index.calls.filter((c) => c.name.toLowerCase() === "bash" && c.ok !== false);
  for (const p of pushed) {
    const hit = shell.some((c) => /\bhrv\b.*\btheme\b.*\bpush\b/.test(c.args) || c.args.includes(norm(p)));
    (hit ? out.corroborated : out.uncorroborated).push(`pushed: ${p}`);
  }
  return out;
}

/** Cross-check one round of a job. Never throws. @returns {object|null} null when the transcript cannot be located. */
export function crossCheckRound({ round, run, sessionsDir = defaultSessionsDir(), jobKind }) {
  try {
    const file = findSessionFile(sessionsDir, run);
    if (!file || !round?.reportPath) return null;
    const rep = parseReport(fs.readFileSync(round.reportPath, "utf8"));
    if (!rep.json) return null;
    const index = indexTranscript(fs.readFileSync(file, "utf8"), round.dispatchedAt ?? 0);
    return crossCheck(rep.json, index, { status: rep.status, kind: round.kind, adhoc: jobKind === "adhoc" });
  } catch {
    return null;
  }
}

function scan(jobsRoot, runsDir, sessionsDir) {
  const total = { rounds: 0, noTranscript: 0, corroborated: 0, uncorroborated: 0, contradicted: 0 };
  for (const name of fs.readdirSync(jobsRoot)) {
    let job;
    try {
      job = JSON.parse(fs.readFileSync(path.join(jobsRoot, name, "job.json"), "utf8"));
    } catch {
      continue;
    }
    for (const round of job.rounds ?? []) {
      if (!round.reportPath || !round.worker?.terminal) continue;
      total.rounds += 1;
      let run = null;
      try {
        run = JSON.parse(fs.readFileSync(path.join(runsDir, `${round.worker.terminal}.json`), "utf8"));
      } catch {}
      const x = crossCheckRound({ round, run, sessionsDir, jobKind: job.subject?.kind });
      if (!x) {
        total.noTranscript += 1;
        continue;
      }
      total.corroborated += x.corroborated.length;
      total.uncorroborated += x.uncorroborated.length;
      total.contradicted += x.contradicted.length;
    }
  }
  return total;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const get = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const root = get("--scan");
  if (!root) {
    process.stderr.write("usage: evidence-xcheck.mjs --scan <jobsRoot> --runs <runsDir> [--sessions <dir>]\n");
    process.exit(2);
  }
  const t = scan(root, get("--runs") ?? path.join(root, "..", "runs"), get("--sessions") ?? defaultSessionsDir());
  const claims = t.corroborated + t.uncorroborated;
  process.stdout.write(`${JSON.stringify({ ...t, uncorroboratedRate: claims ? Number((t.uncorroborated / claims).toFixed(3)) : null })}\n`);
}
