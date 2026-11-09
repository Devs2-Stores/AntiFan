// learn.mjs - turn a closed Leader job into a PENDING Super Core candidate (never auto-promoted).
// Importable ESM, no side effects at load, no dependency on leader-job.mjs.
// ingestOutcome is fail-open: it never throws, so a close can never be blocked by the learning loop.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORE_SCRIPT = path.join(HERE, "..", "antifan-core.cjs");
const MAX_LIST = 8;
const MAX_TEXT = 300;

const clip = (s, n = MAX_TEXT) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ymd = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);

/** First ```json block of a leader report, parsed; null when unreadable. */
function readReportJson(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = /^[ \t]{0,3}```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]{0,3}```[ \t]*$/m.exec(text);
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Pure summary of a job.json object (reads only the report file of the last valid round).
 * @returns {{task:string, outcome:string, verificationRef:string|null}}
 */
export function buildOutcome(job) {
  const rounds = Array.isArray(job?.rounds) ? job.rounds : [];
  const subject = job?.subject ?? {};
  const label = [subject.issueId ? `issue ${subject.issueId}` : null, subject.shop ?? null].filter(Boolean).join(" @ ");
  const day = ymd(job?.closedAt) ?? ymd(job?.createdAt);
  const task = clip(`Leader job ${job?.job ?? "?"}${label ? ` (${label})` : ""}${day ? ` closed ${day}` : ""}`);

  const validRound = [...rounds].reverse().find((r) => r?.report?.valid && r.reportPath);
  const rep = validRound ? readReportJson(validRound.reportPath) : null;
  const parts = [];
  parts.push(`${rounds.length} round${rounds.length === 1 ? "" : "s"}`);
  parts.push(`final state ${job?.state ?? "unknown"}`);
  if (validRound) parts.push(`last valid report: round ${validRound.n} (${validRound.kind ?? "work"}) status ${validRound.report.status ?? "?"}`);
  else parts.push("no valid report");
  const files = strs(rep?.files);
  const pushed = strs(rep?.pushed);
  if (files.length) parts.push(`files: ${files.slice(0, MAX_LIST).map((f) => clip(f, 80)).join(", ")}${files.length > MAX_LIST ? ` (+${files.length - MAX_LIST})` : ""}`);
  if (pushed.length) parts.push(`pushed: ${pushed.slice(0, MAX_LIST).map((f) => clip(f, 80)).join(", ")}${pushed.length > MAX_LIST ? ` (+${pushed.length - MAX_LIST})` : ""}`);
  if (typeof rep?.summary === "string" && rep.summary.trim()) parts.push(`summary: ${clip(rep.summary, 200)}`);
  const dead = rounds.filter((r) => r?.deadWhy).map((r) => `r${r.n}: ${clip(r.deadWhy, 100)}`);
  if (dead.length) parts.push(`dead rounds: ${dead.join("; ")}`);
  const extra = rounds.filter((r) => r?.extraRoundReason).map((r) => `r${r.n}: ${clip(r.extraRoundReason, 100)}`);
  if (extra.length) parts.push(`extra rounds: ${extra.join("; ")}`);
  const review = rounds.filter((r) => r?.kind === "review").length;
  if (review) parts.push(`${review} review round${review === 1 ? "" : "s"}`);
  return { task, outcome: parts.join(". "), verificationRef: validRound ? String(validRound.reportPath) : null };
}

function runCore({ coreScript, cwd, env, timeoutMs, spawn }, args) {
  if ((env ?? process.env).LEADER_LEARN === "off") return { ok: false, error: "disabled" };
  const script = coreScript ?? DEFAULT_CORE_SCRIPT;
  try {
    if (!fs.existsSync(script)) return { ok: false, error: `core script not found: ${script}` };
    const run = spawn ?? spawnSync;
    const r = run(process.execPath, [script, ...args], {
      cwd: cwd ?? path.join(HERE, "..", ".."),
      env: env ?? process.env,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (!r) return { ok: false, error: "no spawn result" };
    if (r.error) return { ok: false, error: `spawn failed: ${r.error.message ?? r.error}` };
    if (r.status !== 0) return { ok: false, error: clip(`core exit ${r.status}: ${String(r.stderr || r.stdout || "").trim()}`, 400) };
    let json;
    try {
      json = JSON.parse(String(r.stdout ?? "").trim());
    } catch (e) {
      return { ok: false, error: `core output is not JSON: ${clip(e.message, 120)}` };
    }
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: clip(e?.message ?? String(e), 300) };
  }
}

/**
 * Record the job as one PENDING Core candidate. Never throws; LEADER_LEARN=off returns {ok:false,error:"disabled"} without spawning.
 * @returns {{ok:boolean, caseId?:string|null, candidateId?:string|null, error?:string|null}}
 */
export function ingestOutcome(job, { coreScript, cwd, env, timeoutMs = 15000, spawn } = {}) {
  try {
    if ((env ?? process.env).LEADER_LEARN === "off") return { ok: false, caseId: null, candidateId: null, error: "disabled" };
    const payload = JSON.stringify(buildOutcome(job));
    const r = runCore({ coreScript, cwd, env, timeoutMs, spawn }, ["outcome", payload]);
    if (!r.ok) return { ok: false, caseId: null, candidateId: null, error: r.error };
    const caseId = r.json?.caseId ?? null;
    const candidateId = r.json?.candidateId ?? null;
    if (!candidateId) return { ok: false, caseId, candidateId, error: `core returned no candidateId: ${clip(JSON.stringify(r.json), 200)}` };
    return { ok: true, caseId, candidateId, error: null };
  } catch (e) {
    return { ok: false, caseId: null, candidateId: null, error: clip(e?.message ?? String(e), 300) };
  }
}

/** @returns {{ok:boolean, candidates:object[], error?:string|null}} */
export function listPending({ coreScript, cwd, env, timeoutMs = 15000, spawn } = {}) {
  try {
    const r = runCore({ coreScript, cwd, env, timeoutMs, spawn }, ["candidates", JSON.stringify({ status: "PENDING" })]);
    if (!r.ok) return { ok: false, candidates: [], error: r.error };
    if (!Array.isArray(r.json)) return { ok: false, candidates: [], error: "core did not return a list" };
    return { ok: true, candidates: r.json, error: null };
  } catch (e) {
    return { ok: false, candidates: [], error: clip(e?.message ?? String(e), 300) };
  }
}
