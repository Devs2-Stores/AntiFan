#!/usr/bin/env node
// improve-scan.mjs - weekly, read-only scan of the Leader job ledger that proposes improvements as Markdown.
// Usage: node scripts/leader/improve-scan.mjs [--jobs-root DIR] [--since-days N] [--audit-dir DIR]... [--out FILE]
// Reads job.json files, the round report files they point to and optional audit *.jsonl files; groups failures by a
// normalized signature; prints proposals. It never applies anything and writes only --out.
// A proposal may only target worker header/templates, skill docs or leader script thresholds. Enforcement code is
// human-only: its names are scrubbed from every line this tool prints.
// Exit codes: 0 ok | 2 usage or I/O error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_JOBS_ROOT = "E:/Work/scratch/leader";
const DAY_MS = 24 * 3600 * 1000;
const JOB_SCHEMA = "leader-job/1";

// Anything that decides what a worker may run, or the project/agent instruction files: never a proposal target.
const FORBIDDEN = /src[\\/]omp-hooks|leader-guard|edit-guard|theme-push-policy|AGENTS\.md|CLAUDE\.md|~[\\/]\.omp|\.omp\b|\bhooks?\b|\bguards?\b/gi;
export const WITHHELD = "[withheld]";

export const scrub = (s) => String(s).replace(FORBIDDEN, WITHHELD);

export function normalizeSignature(text) {
  return scrub(
    String(text ?? "")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
      .replace(/[A-Za-z]:[\\/][^\s"'`)\]]*/g, "<path>")
      .replace(/~[\\/][^\s"'`)\]]*/g, "<path>")
      .replace(/(?<![\w.])\/(?:[\w.-]+\/)+[\w.-]*/g, "<path>")
      .replace(/\b[0-9a-f]{7,}\b/gi, "<hash>")
      .replace(/\bterminal-\d+\b/gi, "terminal-N")
      .replace(/\bpid[\s=:]*\d+/gi, "pid N")
      .replace(/\d+(?:\.\d+)?/g, "N")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, 160);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function add(map, kind, raw, example) {
  const signature = kind === "refused" ? raw : normalizeSignature(raw);
  if (!signature) return;
  const key = `${kind}\u0000${signature}`;
  let e = map.get(key);
  if (!e) {
    e = { kind, signature, count: 0, examples: [] };
    map.set(key, e);
  }
  e.count += 1;
  const ex = scrub(example);
  if (!e.examples.includes(ex)) e.examples.push(ex);
}

/**
 * @param {{jobsRoot:string, sinceDays?:number, auditDirs?:string[], now?:number}} opts
 * @returns {{jobsScanned:number, auditFilesScanned:number, sinceDays:number|null, signatures:{kind:string,signature:string,count:number,examples:string[]}[]}}
 */
export function scanJobs({ jobsRoot, sinceDays = 30, auditDirs = [], now = Date.now() } = {}) {
  const since = typeof sinceDays === "number" && sinceDays > 0 ? now - sinceDays * DAY_MS : null;
  const map = new Map();
  let jobsScanned = 0;
  let names = [];
  try {
    names = fs.readdirSync(jobsRoot).sort();
  } catch {}
  for (const name of names) {
    const job = readJson(path.join(jobsRoot, name, "job.json"));
    if (!job || job.schema !== JOB_SCHEMA || !Array.isArray(job.rounds)) continue;
    const ts = [job.updatedAt, job.createdAt].find((v) => typeof v === "number") ?? now;
    if (since !== null && ts < since) continue;
    jobsScanned += 1;
    const jobName = job.job ?? name;
    for (const r of job.rounds) {
      if (r?.deadWhy) add(map, r.undelivered || /^undelivered:/.test(r.deadWhy) ? "undelivered" : "dead", String(r.deadWhy).replace(/^undelivered:\s*/, ""), jobName);
      if (r?.report && r.report.valid === false && Array.isArray(r.report.errors)) {
        for (const e of r.report.errors) add(map, "invalid-report", e, jobName);
      }
      if (typeof r?.reportPath === "string") {
        let text = "";
        try {
          text = fs.readFileSync(r.reportPath, "utf8");
        } catch {}
        for (const m of text.matchAll(/REFUSED_[A-Z_]+/g)) add(map, "refused", m[0], jobName);
      }
    }
    if (job.rounds.length > 4) add(map, "many-rounds", `job needed more than N rounds`, jobName);
  }
  let auditFilesScanned = 0;
  for (const dir of auditDirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {}
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        if (since !== null && fs.statSync(full).mtimeMs < since) continue;
        const text = fs.readFileSync(full, "utf8");
        auditFilesScanned += 1;
        for (const m of text.matchAll(/REFUSED_[A-Z_]+/g)) add(map, "refused", m[0], `audit:${f}`);
      } catch {}
    }
  }
  const signatures = [...map.values()].sort((a, b) => b.count - a.count || (a.signature < b.signature ? -1 : 1));
  return { jobsScanned, auditFilesScanned, sinceDays: since === null ? null : sinceDays, signatures };
}

const TARGETS = {
  header: "worker header/templates (scripts/leader/templates/)",
  skill: "skill docs (the antifan-leader skill and its references)",
  thresholds: "leader script thresholds (scripts/leader/worker-liveness.mjs, wait/wait-any flags)",
};

function fixFor(sig) {
  switch (sig.kind) {
    case "dead":
      return { target: TARGETS.thresholds, change: "Check whether the stale/start-grace limits fit this failure; if the reason points at a worker habit (no heartbeat, silent stop), add one rule to the worker header instead." };
    case "undelivered":
      return { target: TARGETS.thresholds, change: "Review the undelivered-seconds limit and the dispatch input wording; if prompts are being dropped, shorten the first-line instruction in the dispatch template." };
    case "invalid-report":
      return { target: TARGETS.header, change: "Restate the violated report-contract rule more prominently in the worker header, with a one-line example of the correct field." };
    case "refused":
      return { target: TARGETS.header, change: `Add an explicit "do not attempt" line for the command class behind ${sig.signature} to the worker header, and mention it in the skill docs. The refusal itself stays as it is.` };
    case "many-rounds":
      return { target: TARGETS.skill, change: "Add guidance on splitting or ending long jobs earlier, and consider lowering the round cap threshold." };
    default:
      return { target: TARGETS.skill, change: "Document the pattern and the preferred Leader response." };
  }
}

/** Markdown proposals. Every printed line is scrubbed of forbidden target names. */
export function renderProposals(scan, { minCount = 1 } = {}) {
  const rows = scan.signatures.filter((s) => s.count >= minCount);
  const out = [];
  out.push("# Leader improvement proposals");
  out.push("");
  out.push(`Scanned ${scan.jobsScanned} job(s) and ${scan.auditFilesScanned} audit file(s)${scan.sinceDays ? ` from the last ${scan.sinceDays} day(s)` : ""}.`);
  out.push("");
  out.push("Nothing here is applied. Proposals may only change worker header/templates, skill docs or leader script thresholds. Changes to enforcement code (what blocks or allows a command) and to project instruction files are human-only and are never proposed by this scan.");
  out.push("");
  if (!rows.length) {
    out.push("No recurring failures found.");
    return scrub(`${out.join("\n")}\n`);
  }
  rows.forEach((s, i) => {
    const fix = fixFor(s);
    out.push(`## ${i + 1}. ${s.kind}: ${s.signature}`);
    out.push("");
    out.push(`- Signature: \`${s.signature}\``);
    out.push(`- Count: ${s.count}${s.count >= 2 ? " (recurring)" : ""}`);
    out.push(`- Example jobs: ${s.examples.slice(0, 3).join(", ")}`);
    out.push(`- Suggested target: ${fix.target}`);
    out.push(`- Suggested change: ${fix.change}`);
    out.push("");
  });
  return scrub(`${out.join("\n")}\n`);
}

function parseArgs(argv) {
  const o = { jobsRoot: process.env.LEADER_JOBS_ROOT || DEFAULT_JOBS_ROOT, sinceDays: 30, auditDirs: [], out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--jobs-root") o.jobsRoot = val();
    else if (a === "--since-days") {
      const n = Number(val());
      if (!Number.isFinite(n) || n <= 0) throw new Error("--since-days must be a positive number");
      o.sinceDays = n;
    } else if (a === "--audit-dir") o.auditDirs.push(val());
    else if (a === "--out") o.out = val();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export function main(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    io.stderr(`improve-scan: ${e.message}\nUsage: node scripts/leader/improve-scan.mjs [--jobs-root DIR] [--since-days N] [--audit-dir DIR]... [--out FILE]\n`);
    return 2;
  }
  const md = renderProposals(scanJobs({ jobsRoot: opts.jobsRoot, sinceDays: opts.sinceDays, auditDirs: opts.auditDirs }));
  if (opts.out) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      fs.writeFileSync(opts.out, md);
    } catch (e) {
      io.stderr(`improve-scan: cannot write ${opts.out}: ${e.message}\n`);
      return 2;
    }
  } else io.stdout(md);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
