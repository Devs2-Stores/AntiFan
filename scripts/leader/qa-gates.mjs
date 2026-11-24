// qa-gates.mjs - pure checks behind the Leader-QA gates of leader-job.mjs (no ledger state, no terminal access).
//
// Why a module of its own: every gate here closes a hole measured on the real jobs epres-371 and zesta-369 (24/11/2026),
// where the Leader recorded PASS from its own say-so, approved a CLI command outside AGENTS.md section 8 and verified a
// sheet whose verify-sheet had FAILED. The gates make the ledger ask for the thing that proves the claim.
//
//   evidence    record --kind storefront|dashboard PASS|WARN needs files (exist, written after the round was dispatched);
//               a theme job that shipped files needs theme.qa_validate output with summary.certification CERTIFIED*;
//               a dashboard check needs the output of `probe --name dashboard-issue` that really read the comments
//   cli scan    a follow-up or an answer may name only the four forms of E:/Work/AGENTS.md section 8 (and the three
//               login forms); anything else needs the owner's own words as --owner-quote
//   backup      a pushed file needs its pre-change copy in the backup manifest (leader-backup/1)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNonEmptyStr = (v) => isStr(v) && v.trim() !== "";
const fwd = (p) => String(p).replace(/\\/g, "/");

export const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// ---------------------------------------------------------------- evidence files (record --evidence)

/** The JSON an evidence file holds: the whole file, else its last `{...}` line (a CLI may print a warning first); null when it is not JSON (a screenshot). */
export function readEvidenceJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (text.length > 20 * 1024 * 1024) return null;
  try {
    return JSON.parse(text);
  } catch {}
  for (const line of text.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.parse(t);
      } catch {}
    }
  }
  return null;
}

/** First value anywhere in `json` (objects and arrays, depth 10) for which `pick` returns non-undefined. */
export function findDeep(json, pick, depth = 10) {
  if (depth < 0 || json === null || typeof json !== "object") return undefined;
  const here = pick(json);
  if (here !== undefined) return here;
  for (const v of Array.isArray(json) ? json : Object.values(json)) {
    const r = findDeep(v, pick, depth - 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** `summary.certification` of a theme.qa_validate result wherever the transport wrapped it; undefined when there is none. */
export const certificationOf = (json) => findDeep(json, (o) => (isObj(o.summary) && isStr(o.summary.certification) ? o.summary.certification : undefined));

/** The dashboard-issue probe object in a result: found true plus the commentsSource the probe reported; undefined when the file holds no probe output. */
export const dashboardProbeOf = (json) => findDeep(json, (o) => (o.found === true && isStr(o.commentsSource) ? o : undefined));

/**
 * Check the files named by record --evidence. `dispatchedAt` is the round's dispatch time: a file written before it is
 * a leftover of an earlier round, not a measurement of this one. Returns {entries, errors} (entries: path, sha256, bytes, mtimeMs, json).
 */
export function loadEvidence(paths, dispatchedAt) {
  const entries = [];
  const errors = [];
  for (const raw of paths) {
    const file = path.resolve(String(raw));
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      errors.push(`evidence file does not exist: ${fwd(file)}`);
      continue;
    }
    if (!st.isFile()) {
      errors.push(`evidence is not a file: ${fwd(file)}`);
      continue;
    }
    if (typeof dispatchedAt === "number" && !(st.mtimeMs > dispatchedAt)) {
      errors.push(`evidence file ${fwd(file)} was written ${new Date(st.mtimeMs).toISOString()}, not after the round was dispatched (${new Date(dispatchedAt).toISOString()}): measure again and save the new output`);
      continue;
    }
    entries.push({ path: fwd(file), sha256: sha256File(file), bytes: st.size, mtimeMs: Math.round(st.mtimeMs), json: readEvidenceJson(file) });
  }
  return { entries, errors };
}

/** What a stored round.verification entry keeps of an evidence file (the parsed json stays out of job.json). */
export const evidenceRecord = (e) => ({ path: e.path, sha256: e.sha256, bytes: e.bytes });

/**
 * The refusal reasons for recording PASS|WARN of `kind` with these evidence entries ([] = allowed).
 * `themeShipped` is true for a feedback job with a theme whose round listed files or pushed.
 */
export function evidenceRefusals({ kind, status, entries, themeShipped }) {
  const out = [];
  if (!["PASS", "WARN"].includes(status)) return out;
  if (kind === "storefront" || kind === "dashboard") {
    if (!entries.length) {
      out.push(`record --kind ${kind} ${status} needs --evidence <file>: the saved output of your own measurement (${kind === "storefront" ? "theme.qa_validate / anti.inspect.responsive_matrix JSON" : "the output of probe --name dashboard-issue"}); a status typed without a file proves nothing`);
      return out;
    }
  }
  if (kind === "storefront" && status === "PASS" && themeShipped) {
    const certs = entries.map((e) => certificationOf(e.json)).filter(isStr);
    if (!certs.some((c) => /^CERTIFIED/.test(c))) {
      out.push(
        `a theme job that shipped files can be recorded storefront PASS only with an --evidence file holding theme.qa_validate output whose summary.certification is CERTIFIED* (${certs.length ? `found ${JSON.stringify(certs)}` : "none found"}); without that receipt the most you may record is WARN (E:/Work/AGENTS.md section 16.5: no receipt, not verified)`,
      );
    }
  }
  if (kind === "dashboard") {
    const probes = entries.map((e) => dashboardProbeOf(e.json)).filter(Boolean);
    if (!probes.length) {
      out.push("dashboard evidence must be the output of `probe --name dashboard-issue` (found:true plus commentsSource): the file holds none; record --status UNREADABLE when the dashboard could not be read");
    } else if (probes.every((p) => p.commentsSource === "none-found")) {
      out.push("the dashboard probe read NO comments (commentsSource none-found: commentCount null), so no comment check happened; fix the probe read or record --status UNREADABLE, not PASS|WARN");
    }
  }
  return out;
}

// ---------------------------------------------------------------- CLI commands named in a follow-up or an answer

/** Drop the blocks a Leader prompt carries but does not write: fenced untrusted text, and everything above the "# Việc" of a worker header. */
export function leaderAuthoredText(text) {
  let t = String(text ?? "").replace(/<<<UNTRUSTED-[^\n]*\n[\s\S]*?\nUNTRUSTED-[^\n]*>>>/g, "");
  const marker = t.indexOf("\n# Việc\n");
  if (/^Bạn là WORKER do Leader giao/m.test(t) && marker >= 0) t = t.slice(marker);
  return t;
}

const CLI_TOOLS = new Set(["hrv", "haravan", "sapo", "shopify"]);
const OTHER_CLI_VERBS = new Set(["theme", "app", "login", "logout", "auth", "store", "extension", "hydrogen", "org", "whoami", "whoiam", "config", "init", "deploy", "push", "pull", "publish"]);

/**
 * Classify one command mention. The allowed set is the four forms of E:/Work/AGENTS.md section 8 (hrv select, hrv theme
 * info, hrv theme fetch, hrv theme push), the three login forms (hrv whoiam, hrv refresh-all without --force,
 * hrv login --no-open) and `hrv theme dev`, which the worker header itself grants and the edit hook enforces.
 * @returns {string|null} why it is outside the set, or null when allowed
 */
export function cliMentionVerdict(tool, tokens) {
  const words = tokens.filter((x) => !x.startsWith("-"));
  const has = (f) => tokens.includes(f);
  if (tool !== "hrv") return OTHER_CLI_VERBS.has(words[0] ?? "") ? `\`${tool} ${words[0]}\` is outside the four forms of AGENTS.md section 8 (only hrv is approved)` : null;
  const verb = words[0];
  if (!verb) return null;
  switch (verb) {
    case "select":
    case "whoiam":
      return null;
    case "theme": {
      const sub = words[1];
      if (!sub) return null;
      if (sub === "info" || sub === "fetch" || sub === "dev") return null;
      if (sub === "push") return has("--force") || has("--prune") ? "`hrv theme push --force|--prune` is never approved" : null;
      return `\`hrv theme ${sub}\` is outside the four forms of AGENTS.md section 8`;
    }
    case "refresh-all":
      return has("--force") ? "`hrv refresh-all --force` is not one of the approved login forms" : null;
    case "login":
      return has("--no-open") ? null : "`hrv login` without --no-open is the owner's own command (credentials), not a worker's";
    default:
      return `\`hrv ${verb}\` is outside the four forms of AGENTS.md section 8 and the three login forms`;
  }
}

/** Every command line in `text` that names a CLI outside the approved set: [{line, command, why}]. */
export function scanCliApprovals(text) {
  const found = [];
  const re = /(?<![\w./-])(hrv|haravan|sapo|shopify)[ \t]+((?:--?[\w-]+[ \t]+)*[a-z][\w-]*(?:[ \t]+[^\s`"'()\];&|<>]+)*)/g;
  for (const rawLine of leaderAuthoredText(text).split(/\r?\n/)) {
    for (const m of rawLine.matchAll(re)) {
      const tool = m[1];
      const tokens = m[2].split(/[ \t]+/).filter(Boolean);
      const why = cliMentionVerdict(tool, tokens);
      if (why) found.push({ line: rawLine.trim().slice(0, 200), command: `${tool} ${tokens.join(" ")}`.slice(0, 120), why });
    }
  }
  return found;
}

/** One-line owner quote for --owner-quote: the owner's own words, 1-500 chars, no control characters. */
export function ownerQuoteProblem(quote) {
  const q = String(quote ?? "").trim();
  return q.length === 0 || q.length > 500 || /[\x00-\x1f]/.test(q) ? "--owner-quote must be the owner's own words on one line (1-500 characters)" : null;
}

// ---------------------------------------------------------------- backup manifest (handover.backup)

export const BACKUP_MANIFEST_SCHEMA = "leader-backup/1";
const BACKUP_SOURCES = ["remote-fetch", "local-before-edit"];
const normPath = (p) => fwd(p).replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();

/** The theme-relative files a report pushed: `--only a b` lists of its `pushed` entries; a push with no --only pushes every file of `files`. */
export function pushedFilesOf(json) {
  const files = Array.isArray(json?.files) ? json.files.filter(isStr) : [];
  const pushed = Array.isArray(json?.pushed) ? json.pushed.filter(isStr) : [];
  const set = new Set();
  let whole = false;
  for (const entry of pushed) {
    const only = /--only\s+(\S+(?:\s+(?!-)\S+)*)/.exec(entry);
    if (!only) {
      whole = true;
      continue;
    }
    for (const f of only[1].trim().split(/\s+/)) if (f && !f.startsWith("-")) set.add(f);
  }
  if (whole || (!set.size && pushed.length)) for (const f of files) set.add(f);
  return [...set];
}

/**
 * Check handover.backup against the files the report pushed. The backup is a directory holding manifest.json (or the path
 * of such a json file):
 *   {"schema":"leader-backup/1","files":[{"path":"snippets/x.liquid","backup":"r2/snippets/x.liquid","sha256":"<64 hex>","source":"remote-fetch|local-before-edit"}]}
 * `backup` is relative to the manifest's folder and its sha256 must match the bytes on disk. A pushed file named in
 * handover.newFiles (it did not exist before the change) needs no entry.
 * @returns {string[]} problems; [] when every pushed file has a verified pre-change copy
 */
export function backupManifestProblems(handover, pushedFiles) {
  const out = [];
  const spec = isObj(handover) && isNonEmptyStr(handover.backup) ? handover.backup.trim() : "";
  const newFiles = new Set((isObj(handover) && Array.isArray(handover.newFiles) ? handover.newFiles.filter(isStr) : []).map(normPath));
  const need = pushedFiles.filter((f) => !newFiles.has(normPath(f)));
  if (!need.length) return out;
  if (!spec) return [`handover.backup is missing: ${need.length} pushed file(s) have no pre-change copy (${need.slice(0, 3).join(", ")}${need.length > 3 ? ", ..." : ""}); back each up BEFORE the first edit and list it in <backup>/manifest.json`];
  const manifestFile = /\.json$/i.test(spec) ? spec : path.join(spec, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (e) {
    return [`handover.backup has no readable manifest (${fwd(manifestFile)}: ${e.code === "ENOENT" ? "missing" : e.message}): the pre-change copy of each pushed file must be listed there (schema ${BACKUP_MANIFEST_SCHEMA})`];
  }
  if (!isObj(manifest) || manifest.schema !== BACKUP_MANIFEST_SCHEMA || !Array.isArray(manifest.files)) return [`backup manifest ${fwd(manifestFile)} must be {"schema":"${BACKUP_MANIFEST_SCHEMA}","files":[{path, backup, sha256, source}]}`];
  const base = path.dirname(manifestFile);
  const byPath = new Map();
  for (const e of manifest.files) if (isObj(e) && isStr(e.path)) byPath.set(normPath(e.path), e);
  for (const f of need) {
    const e = byPath.get(normPath(f));
    if (!e) {
      out.push(`pushed file ${f} has no entry in the backup manifest: its pre-change copy was not taken (or not listed); a live theme file overwritten before its backup cannot be restored`);
      continue;
    }
    if (!isNonEmptyStr(e.backup) || !/^[0-9a-f]{64}$/i.test(String(e.sha256 ?? "")) || !BACKUP_SOURCES.includes(e.source)) {
      out.push(`backup manifest entry for ${f} must carry backup (relative path), sha256 (64 hex) and source (${BACKUP_SOURCES.join("|")})`);
      continue;
    }
    const copy = path.resolve(base, e.backup);
    if (!fwd(copy).toLowerCase().startsWith(`${fwd(base).toLowerCase().replace(/\/+$/, "")}/`)) {
      out.push(`backup manifest entry for ${f}: backup path ${e.backup} leaves the backup folder`);
      continue;
    }
    let actual;
    try {
      actual = sha256File(copy);
    } catch {
      out.push(`backup copy of ${f} is missing on disk: ${fwd(copy)}`);
      continue;
    }
    if (actual.toLowerCase() !== String(e.sha256).toLowerCase()) out.push(`backup copy of ${f} does not match the manifest sha256 (manifest ${String(e.sha256).slice(0, 12)}..., file ${actual.slice(0, 12)}...)`);
  }
  return out;
}
