#!/usr/bin/env node
// leader-job.mjs - ledger CLI for AntiFan Leader jobs (feedback kind).
// One job = one directory <LEADER_JOBS_ROOT>/<yymmdd-hhmm>-<slug>/ holding job.json
// (schema "leader-job/1", written only by this CLI), snapshot-before.csv, prompts and reports.
// Plain Node ESM, no dependencies. Run with --help for commands and exit codes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCsv } from "./csv.mjs";
import { normKey, outstandingDevRows, parseSheet, verifySheet } from "./sheet-diff.mjs";
import { claimedCells, validateReportText } from "./report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_JOBS_ROOT = "E:/Work/scratch/leader";
const DEFAULT_DATA_ROOT = "E:/Work/.antifan-data";
const JOB_SCHEMA = "leader-job/1";
const HOST = "Taiz";
const BOOL_FLAGS = new Set(["help", "allow-busy", "force", "all", "allow-outstanding", "without-done", "no-sheet"]);
const VERIFY_KINDS = ["sheet", "dashboard", "storefront"];
const VERIFY_STATUSES = ["PASS", "WARN", "FAIL", "UNREADABLE"];
const PROBES = { themeId: "themeId.js", overflow: "overflow.js", "element-rect": "element-rect.js", "dashboard-issue": "dashboard-issue.js" };

export const EXIT = { OK: 0, CHECK_FAILED: 1, USAGE: 2, TIMEOUT: 3, REFUSED: 4, NEEDS_INPUT: 5 };

const HELP = `leader-job.mjs - Leader job ledger (feedback jobs for host ${HOST})

Usage: node scripts/leader/leader-job.mjs <command> [flags]

Commands
  init --slug S --issue-id ID --shop SHOP (--sheet SHEETID [--gid GID] | --no-sheet) [--leader TERMINAL]
       [--cols-work H --cols-owner H --cols-note H --cols-done H] [--keys "a|b"]
       [--profile haravan|sheet-only] [--snapshot-file CSV]
       Create the job dir, fetch snapshot-before.csv, write job.json (state open) and <slug>.prompt.md.
       Without --gid the sheet's first tab is exported (plain /export?format=csv). --no-sheet is for an
       issue that has no Google Sheet: a header-only stub snapshot is written, verify-sheet reports N/A
       (never PASS) and the sheet is not a required verification.
  dispatch --job DIR --worker TERMINAL [--prompt FILE] [--kind work|followup|close]
       [--mode auto|fresh|followup] [--allow-busy]
       Stamp dispatchedAt/preRunSeq, append a round, state=dispatched, print {input} for terminal.write.
  wait --job DIR [--timeout-min N] [--poll-ms 5000]
       Poll worker run files until every round is settled (state=settled) or a worker waits for the user.
  validate-report --job DIR [--round N]
       Check the round's report file; state=reported (needs_input for a NEEDS_INPUT report).
  verify-sheet --job DIR [--round N] [--current-file CSV]
       Diff the live sheet against snapshot-before.csv, keyed by task text, against the report's claims.
  record --job DIR --round N --kind dashboard|storefront|sheet --status PASS|WARN|FAIL|UNREADABLE [--note T]...
       Store the Leader's own measurement; state=verified once all required kinds pass.
  probe --name themeId|overflow|element-rect|dashboard-issue [--selector CSS] [--id ID] [--limit N]
       Print the read-only expression to pass to anti.browser.evaluate.
  status [--leader TERMINAL] [--job DIR] [--all]    List open jobs and what blocks each.
  approve --job DIR [--allow-outstanding] [--force]  User said yes: state=user-approved.
  close --job DIR [--without-done] [--force]         state=closed (needs approval and a verified close round).

Environment: LEADER_JOBS_ROOT (default ${DEFAULT_JOBS_ROOT}), LEADER_RUNS_DIR or ANTIFAN_DATA_ROOT
(run files <dir>/<terminal>.json, default ${DEFAULT_DATA_ROOT}/runtime/runs), ANTIFAN_TERMINAL_SESSION_ID
(the Leader's terminal). Flag --runs-dir overrides LEADER_RUNS_DIR.

Output: one JSON object per line on stdout; human-readable errors on stderr.
Exit codes: 0 ok | 1 check failed (invalid report, sheet FAIL/UNREADABLE) | 2 usage or I/O error
            3 wait timed out | 4 refused by policy (busy worker, unfilled prompt, no approval...)
            5 worker is waiting for the user (wait)
`;

class CliError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- args / io

export function parseArgv(argv) {
  const flags = new Map();
  let cmd = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      flags.set("help", [true]);
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      let v = eq < 0 ? undefined : a.slice(eq + 1);
      if (BOOL_FLAGS.has(name)) v = v === undefined ? true : v !== "false";
      else if (v === undefined) {
        v = argv[++i];
        if (v === undefined) throw new CliError(EXIT.USAGE, `--${name} needs a value`);
      }
      flags.set(name, [...(flags.get(name) ?? []), v]);
    } else if (cmd === null) {
      cmd = a;
    } else {
      throw new CliError(EXIT.USAGE, `unexpected argument ${JSON.stringify(a)}`);
    }
  }
  return { cmd, flags };
}

const one = (flags, name) => flags.get(name)?.at(-1);
const many = (flags, name) => flags.get(name) ?? [];
const req = (flags, name) => {
  const v = one(flags, name);
  if (v === undefined || v === "") throw new CliError(EXIT.USAGE, `missing required --${name}`);
  return v;
};

const fwd = (p) => p.replace(/\\/g, "/");
const jobsRoot = () => process.env.LEADER_JOBS_ROOT || DEFAULT_JOBS_ROOT;
const runsDirOf = (flags) =>
  one(flags, "runs-dir") ||
  process.env.LEADER_RUNS_DIR ||
  path.join(process.env.ANTIFAN_DATA_ROOT || DEFAULT_DATA_ROOT, "runtime", "runs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {}
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

function validTerminalId(id, what) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new CliError(EXIT.USAGE, `${what} ${JSON.stringify(id)} is not a valid terminal session id`);
  return id;
}

function readRun(runsDir, terminal) {
  const p = path.join(runsDir, `${validTerminalId(terminal, "terminal")}.json`);
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && typeof j === "object" ? j : { unreadable: true };
  } catch (e) {
    if (e.code === "ENOENT") return null;
    return { unreadable: true };
  }
}

function resolveJobDir(arg) {
  const dir = path.isAbsolute(arg) ? arg : path.join(jobsRoot(), arg);
  if (!fs.existsSync(path.join(dir, "job.json"))) throw new CliError(EXIT.USAGE, `no job.json in ${fwd(dir)}`);
  return dir;
}

function loadJob(flags) {
  const dir = resolveJobDir(req(flags, "job"));
  let job;
  try {
    job = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
  } catch (e) {
    throw new CliError(EXIT.USAGE, `job.json is not valid JSON: ${e.message}`);
  }
  if (job.schema !== JOB_SCHEMA) throw new CliError(EXIT.USAGE, `job.json schema is ${JSON.stringify(job.schema)}, expected ${JOB_SCHEMA}`);
  return { dir, job };
}

function saveJob(dir, job) {
  job.updatedAt = Date.now();
  writeJsonAtomic(path.join(dir, "job.json"), job);
}

function pickRound(job, flags) {
  if (!job.rounds.length) throw new CliError(EXIT.USAGE, "job has no rounds yet (run dispatch first)");
  const n = one(flags, "round") === undefined ? job.rounds.length : Number(one(flags, "round"));
  const round = job.rounds.find((r) => r.n === n);
  if (!round) throw new CliError(EXIT.USAGE, `round ${one(flags, "round")} does not exist (have ${job.rounds.map((r) => r.n).join(",")})`);
  return round;
}

// ---------------------------------------------------------------- templates

function render(tpl, vars) {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function readTemplate(name) {
  return fs.readFileSync(path.join(HERE, "templates", name), "utf8");
}

/** Keep the blocks of the active flavours: the profile and `sheet` / `nosheet`. */
function applyProfile(tpl, profile, hasSheet = true) {
  const active = new Set([profile, hasSheet ? "sheet" : "nosheet"]);
  return tpl.replace(/<!-- if:(\w+) -->\r?\n([\s\S]*?)<!-- endif -->\r?\n/g, (_, p, body) => (active.has(p) ? body : ""));
}

const NO_SHEET_STUB_CSV = "Stage,Mô tả,Dev note kết quả\n";
const GID_FIRST_TAB = "tab đầu tiên (không chỉ định gid)";

function jobVars(job, n, reportPath) {
  const c = job.subject.cols;
  return {
    JOB: job.job,
    KEY: job.slug,
    ROUND: n,
    ISSUE_ID: job.subject.issueId,
    HOST: job.subject.host,
    SHOP: job.subject.shop,
    SHEET_ID: job.subject.sheetId,
    GID: job.subject.gid ?? GID_FIRST_TAB,
    COL_WORK: c.work,
    COL_NOTE: c.note,
    COL_DONE: c.done ?? "(không có cột này)",
    REPORT_PATH: reportPath,
  };
}

const reportPathFor = (dir, job, n) => fwd(path.join(dir, n === 1 ? `${job.slug}.report.md` : `${job.slug}.r${n}.report.md`));
const promptPathFor = (dir, job, n) => fwd(path.join(dir, n === 1 ? `${job.slug}.prompt.md` : `${job.slug}.r${n}.prompt.md`));

// ---------------------------------------------------------------- sheet io

/** Plain `/export?format=csv` serves the first tab; a gid is added only when the caller knows one. */
export function sheetExportUrl(sheet, gid, stamp = Date.now()) {
  const gidParam = gid === null || gid === undefined || gid === "" ? "" : `&gid=${encodeURIComponent(gid)}`;
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheet)}/export?format=csv${gidParam}&t=${stamp}`;
}

async function fetchSheetCsv(sheet, gid) {
  const url = sheetExportUrl(sheet, gid);
  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`cannot reach Google Sheets: ${e.message}`);
  }
  if (!res.ok) throw new Error(`sheet export returned HTTP ${res.status} (private sheet or wrong id/gid?)`);
  return res.text();
}

const HEADER_CANDIDATES = {
  work: ["Công việc", "Mô tả"],
  note: ["Ghi chú", "Dev note kết quả", "Dev note"],
  owner: ["Đầu mối"],
  done: ["Xong", "Stage"],
};

function detectCols(csvText, given) {
  let rows;
  try {
    rows = parseCsv(csvText);
  } catch (e) {
    throw new CliError(EXIT.USAGE, `snapshot is not valid CSV: ${e.message}`);
  }
  const cols = { ...given };
  for (const row of rows) {
    const set = new Set(row.map((c) => c.trim()));
    const has = (k) => HEADER_CANDIDATES[k].find((h) => set.has(h));
    if (has("work") && has("note")) {
      for (const k of ["work", "note", "owner", "done"]) if (!cols[k]) cols[k] = has(k) ?? null;
      break;
    }
  }
  return cols;
}

// ---------------------------------------------------------------- commands

async function cmdInit(flags) {
  const slug = req(flags, "slug");
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/i.test(slug)) throw new CliError(EXIT.USAGE, "--slug must be letters, digits and dashes (max 41 chars)");
  const issueId = req(flags, "issue-id");
  const shop = req(flags, "shop");
  const noSheet = one(flags, "no-sheet") === true;
  if (noSheet && (one(flags, "sheet") !== undefined || one(flags, "gid") !== undefined || one(flags, "snapshot-file") !== undefined)) {
    throw new CliError(EXIT.USAGE, "--no-sheet cannot be combined with --sheet, --gid or --snapshot-file");
  }
  const sheetId = noSheet ? "" : req(flags, "sheet");
  const gid = noSheet || one(flags, "gid") === undefined || one(flags, "gid") === "" ? null : String(one(flags, "gid"));
  const leaderArg = one(flags, "leader") || process.env.ANTIFAN_TERMINAL_SESSION_ID;
  if (!leaderArg) throw new CliError(EXIT.USAGE, "missing the Leader terminal: pass --leader or set ANTIFAN_TERMINAL_SESSION_ID");
  const leaderTerminal = validTerminalId(leaderArg, "leader");
  const profile = one(flags, "profile") || "haravan";
  if (!["haravan", "sheet-only"].includes(profile)) throw new CliError(EXIT.USAGE, "--profile must be haravan or sheet-only");

  let csv;
  const snapFile = one(flags, "snapshot-file");
  try {
    csv = noSheet ? NO_SHEET_STUB_CSV : snapFile ? fs.readFileSync(snapFile, "utf8") : await fetchSheetCsv(sheetId, gid);
  } catch (e) {
    throw new CliError(EXIT.USAGE, `cannot obtain the sheet snapshot: ${e.message}`);
  }
  const cols = detectCols(csv, {
    work: one(flags, "cols-work") || null,
    owner: one(flags, "cols-owner") || null,
    note: one(flags, "cols-note") || null,
    done: one(flags, "cols-done") || null,
  });
  if (!cols.work || !cols.note) {
    throw new CliError(EXIT.USAGE, "cannot detect the task/note columns; pass --cols-work and --cols-note with the exact header texts");
  }
  const analysis = parseSheet(csv, cols);
  if (!analysis.ok) throw new CliError(EXIT.USAGE, `snapshot does not match the column headers: ${analysis.error}`);

  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const name = `${stamp}-${slug}`;
  const dir = path.join(jobsRoot(), name);
  if (fs.existsSync(dir)) throw new CliError(EXIT.USAGE, `job dir already exists: ${fwd(dir)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "snapshot-before.csv"), csv);

  const leaderRun = readRun(runsDirOf(flags), leaderTerminal);
  const keys = one(flags, "keys");
  const job = {
    schema: JOB_SCHEMA,
    job: name,
    slug,
    createdAt: Date.now(),
    leader: { terminal: leaderTerminal, ompSessionId: leaderRun && !leaderRun.unreadable ? (leaderRun.ompSessionId ?? null) : null },
    subject: {
      kind: "feedback",
      issueId: String(issueId),
      host: HOST,
      shop,
      sheetId,
      gid,
      ...(noSheet ? { noSheet: true } : {}),
      cols: { work: cols.work, owner: cols.owner ?? null, note: cols.note, done: cols.done ?? null },
    },
    scope: { keys: keys ? keys.split("|").map(normKey).filter(Boolean) : null },
    snapshotBefore: "snapshot-before.csv",
    profile,
    state: "open",
    rounds: [],
  };
  const reportPath = reportPathFor(dir, job, 1);
  const promptPath = promptPathFor(dir, job, 1);
  const skeleton = `${render(applyProfile(readTemplate("worker-header.md"), profile, !noSheet), jobVars(job, 1, reportPath))}\n# Việc\n{{TASK}}\n`;
  fs.writeFileSync(promptPath, skeleton);
  saveJob(dir, job);
  emit({
    cmd: "init",
    ok: true,
    jobDir: fwd(dir),
    job: name,
    state: job.state,
    cols: job.subject.cols,
    gid: job.subject.gid,
    noSheet,
    dataRows: analysis.rows.filter((r) => r.data).length,
    outstandingDevRows: outstandingDevRows(analysis).length,
    promptPath,
    nextReportPath: reportPath,
    note: "replace the {{TASK}} line in the prompt, then run dispatch",
  });
  return EXIT.OK;
}

async function cmdDispatch(flags) {
  const { dir, job } = loadJob(flags);
  if (job.state === "closed") throw new CliError(EXIT.REFUSED, "job is closed");
  const worker = validTerminalId(req(flags, "worker"), "worker");
  const n = job.rounds.length + 1;
  const kind = one(flags, "kind") || (n === 1 ? "work" : "followup");
  if (!["work", "followup", "close"].includes(kind)) throw new CliError(EXIT.USAGE, "--kind must be work, followup or close");
  if (kind === "close" && !(job.state === "user-approved" && job.approvedAt)) {
    throw new CliError(EXIT.REFUSED, `close round needs state user-approved (run approve after the user's yes); state is ${job.state}`);
  }
  const reportPath = reportPathFor(dir, job, n);
  let promptPath = one(flags, "prompt") ? fwd(path.resolve(one(flags, "prompt"))) : null;
  if (!promptPath) {
    if (kind !== "close") throw new CliError(EXIT.USAGE, "missing required --prompt");
    promptPath = promptPathFor(dir, job, n);
    fs.writeFileSync(promptPath, readTemplate("close-followup.md"));
  }
  let text;
  try {
    text = fs.readFileSync(promptPath, "utf8");
  } catch (e) {
    throw new CliError(EXIT.USAGE, `cannot read prompt ${promptPath}: ${e.message}`);
  }
  const rendered = render(text, jobVars(job, n, reportPath));
  const left = [...new Set(rendered.match(/\{\{[A-Z_]+\}\}/g) ?? [])];
  if (left.length) {
    throw new CliError(
      EXIT.REFUSED,
      left.includes("{{TASK}}")
        ? "prompt still contains the {{TASK}} marker: write the task text into the skeleton first"
        : `prompt contains unresolved placeholders: ${left.join(", ")}`,
    );
  }
  if (!rendered.includes(reportPath)) throw new CliError(EXIT.REFUSED, `prompt does not tell the worker where to write the report (${reportPath})`);

  const runsDir = runsDirOf(flags);
  const run = readRun(runsDir, worker);
  if (run?.unreadable) throw new CliError(EXIT.USAGE, `run file of ${worker} exists but is unreadable`);
  if (run && (run.state === "running" || run.state === "waiting_user") && !one(flags, "allow-busy")) {
    throw new CliError(EXIT.REFUSED, `worker ${worker} is ${run.state} (runSeq ${run.runSeq}); wait for idle or pass --allow-busy`, { worker, runState: run.state });
  }
  let mode = one(flags, "mode") || "auto";
  if (!["auto", "fresh", "followup"].includes(mode)) throw new CliError(EXIT.USAGE, "--mode must be auto, fresh or followup");
  if (mode === "auto") mode = run && run.ompSessionId && run.state !== "ended" ? "followup" : "fresh";
  if (mode === "fresh") {
    const s = job.subject;
    const missing = [["issueId", String(s.issueId)], ["host", s.host], ["shop", s.shop], ["sheetId", s.sheetId]].filter(([, v]) => !rendered.includes(v)).map(([k]) => k);
    if (missing.length) throw new CliError(EXIT.REFUSED, `fresh worker prompt lacks the guard values: ${missing.join(", ")}`);
  }
  if (rendered !== text) fs.writeFileSync(promptPath, rendered);

  const input =
    mode === "fresh"
      ? `omp "@${promptPath}"\r`
      : `Đọc ${promptPath} rồi làm theo đúng hướng dẫn trong đó (ghi report vào ${reportPath}).\r`;
  const preOmp = run?.ompSessionId ?? null;
  const round = {
    n,
    kind,
    mode,
    worker: { terminal: worker, ompSessionId: preOmp },
    preOmpSessionId: preOmp,
    promptPath,
    reportPath,
    dispatchedAt: Date.now(),
    preRunSeq: typeof run?.runSeq === "number" ? run.runSeq : 0,
    settledAt: null,
    report: null,
    verification: {},
  };
  job.rounds.push(round);
  job.state = "dispatched";
  saveJob(dir, job);
  emit({ cmd: "dispatch", ok: true, job: job.job, round: n, kind, mode, worker, state: job.state, input, promptPath, reportPath, dispatchedAt: round.dispatchedAt, preRunSeq: round.preRunSeq });
  return EXIT.OK;
}

/** Decide whether a round's worker run has finished the dispatched turn. */
export function judgeRound(round, run) {
  if (!run) return { kind: "pending", why: "no run file" };
  if (run.unreadable) return { kind: "pending", why: "run file unreadable" };
  if (!(run.lastEventAt > round.dispatchedAt)) return { kind: "pending", why: "no OMP event since dispatch" };
  const need = run.ompSessionId !== round.preOmpSessionId ? 1 : round.preRunSeq + 1;
  if (!(run.runSeq >= need)) return { kind: "pending", why: `runSeq ${run.runSeq} < ${need}` };
  if (run.state === "waiting_user") return { kind: "waiting_user", why: "worker waits for the user" };
  if (run.state === "idle" || run.state === "ended") return { kind: "settled", why: run.state };
  return { kind: "pending", why: `state ${run.state}` };
}

async function cmdWait(flags) {
  const { dir } = loadJob(flags);
  const runsDir = runsDirOf(flags);
  const pollMs = Math.max(10, Number(one(flags, "poll-ms") || 5000));
  const timeoutMs = one(flags, "timeout-min") !== undefined ? Number(one(flags, "timeout-min")) * 60000 : Infinity;
  if (Number.isNaN(timeoutMs)) throw new CliError(EXIT.USAGE, "--timeout-min must be a number");
  const started = Date.now();
  for (;;) {
    const { job } = loadJob(flags);
    const open = job.rounds.filter((r) => !r.settledAt);
    if (!open.length) {
      emit({ cmd: "wait", event: "all-settled", job: job.job, state: job.state });
      return EXIT.OK;
    }
    let changed = false;
    for (const r of open) {
      const run = readRun(runsDir, r.worker.terminal);
      const verdict = judgeRound(r, run);
      if (verdict.kind === "waiting_user") {
        job.state = "needs_input";
        saveJob(dir, job);
        emit({ cmd: "wait", event: "needs-input", job: job.job, round: r.n, worker: r.worker.terminal, lastTool: run?.lastTool ?? null, reason: verdict.why });
        return EXIT.NEEDS_INPUT;
      }
      if (verdict.kind === "settled") {
        r.settledAt = Date.now();
        r.worker.ompSessionId = run.ompSessionId ?? r.worker.ompSessionId;
        r.settleRun = { state: run.state, runSeq: run.runSeq, lastEventAt: run.lastEventAt };
        changed = true;
        emit({ cmd: "wait", event: "round-settled", job: job.job, round: r.n, worker: r.worker.terminal, runState: run.state, runSeq: run.runSeq, settledAt: r.settledAt });
      }
    }
    if (changed) {
      if (job.rounds.every((r) => r.settledAt)) job.state = "settled";
      saveJob(dir, job);
      if (job.state === "settled") {
        emit({ cmd: "wait", event: "all-settled", job: job.job, state: job.state });
        return EXIT.OK;
      }
    }
    if (Date.now() - started >= timeoutMs) {
      emit({ cmd: "wait", event: "timeout", job: job.job, pending: open.filter((r) => !r.settledAt).map((r) => ({ round: r.n, worker: r.worker.terminal })) });
      return EXIT.TIMEOUT;
    }
    await sleep(pollMs);
  }
}

function requiredKindsFor(round, json, job) {
  if (round.kind === "close") return ["dashboard"];
  // A job without a sheet still needs an independent check of the dashboard row: with nothing required,
  // a report that carries only a summary would reach "verified" without anyone having looked at anything.
  const req = job?.subject?.noSheet ? ["dashboard"] : ["sheet"];
  if (json?.dashboard && !req.includes("dashboard")) req.push("dashboard");
  if (json?.storefront || (Array.isArray(json?.files) && json.files.length)) req.push("storefront");
  return req;
}

function cmdValidateReport(flags) {
  const { dir, job } = loadJob(flags);
  const round = pickRound(job, flags);
  const errors = [];
  let text = null;
  try {
    const st = fs.statSync(round.reportPath);
    text = fs.readFileSync(round.reportPath, "utf8");
    if (st.mtimeMs < round.dispatchedAt) {
      errors.push(`report mtime ${new Date(st.mtimeMs).toISOString()} is older than dispatchedAt ${new Date(round.dispatchedAt).toISOString()} (stale report from an earlier round?)`);
    }
  } catch (e) {
    errors.push(e.code === "ENOENT" ? `report file missing: ${round.reportPath}` : `cannot read report: ${e.message}`);
  }
  if (!round.settledAt) errors.push(`round ${round.n} is not settled yet (run wait first)`);
  let status = null;
  let json = null;
  if (text !== null) {
    const v = validateReportText(text, job, round.n);
    status = v.status;
    json = v.json;
    errors.push(...v.errors);
    if (job.subject.noSheet && Array.isArray(json?.sheet?.cells) && json.sheet.cells.length) {
      errors.push("report claims sheet cells but this job has no sheet (init --no-sheet)");
    }
  }
  const valid = errors.length === 0;
  round.report = { status, valid, errors, checkedAt: Date.now(), ...(valid ? { required: requiredKindsFor(round, json, job) } : {}) };
  if (valid) {
    if (round.n === job.rounds.length) job.state = status === "NEEDS_INPUT" ? "needs_input" : "reported";
  }
  saveJob(dir, job);
  for (const e of errors) process.stderr.write(`report round ${round.n}: ${e}\n`);
  emit({ cmd: "validate-report", ok: valid, job: job.job, round: round.n, status, valid, errors, state: job.state });
  return valid ? EXIT.OK : EXIT.CHECK_FAILED;
}

function applyVerification(job, round) {
  const rep = round.report;
  const latest = round.n === job.rounds.length;
  const missing = [];
  if (!rep?.valid) return { missing: ["valid report"] };
  const reportOk = round.kind === "close" ? rep.status === "DONE" : rep.status === "DONE" || rep.status === "PENDING";
  if (!reportOk) return { missing: [`report status ${rep.status} cannot be verified`] };
  const required = rep.required ?? [];
  if (required.length === 0) return { missing: ["at least one independent check"] };
  for (const k of required) {
    const v = round.verification[k]?.status;
    if (v !== "PASS" && v !== "WARN") missing.push(k);
  }
  if (!missing.length && latest) {
    if (round.kind === "close") {
      job.state = "user-approved";
      job.closeVerifiedAt = Date.now();
    } else {
      job.state = "verified";
    }
  }
  return { missing };
}

async function cmdVerifySheet(flags) {
  const { dir, job } = loadJob(flags);
  const round = pickRound(job, flags);
  if (!round.report?.valid) throw new CliError(EXIT.REFUSED, `round ${round.n} has no valid report yet (run validate-report first)`);
  if (job.subject.noSheet) {
    // Nothing exists to compare against: the honest verdict is "not applicable", which
    // is deliberately not a passing status for a job that does require a sheet check.
    round.verification.sheet = { status: "N/A", changedCells: [], foreign: [], added: [], removed: [], notes: ["no sheet for this issue"], at: Date.now() };
    const res = applyVerification(job, round);
    saveJob(dir, job);
    emit({ cmd: "verify-sheet", ok: true, job: job.job, round: round.n, status: "N/A", applicable: false, notes: round.verification.sheet.notes, state: job.state, missing: res.missing });
    return EXIT.OK;
  }
  const rep = JSON.parse(extractJson(fs.readFileSync(round.reportPath, "utf8")));
  const before = fs.readFileSync(path.join(dir, job.snapshotBefore), "utf8");
  let afterText = null;
  let readError;
  try {
    afterText = one(flags, "current-file") ? fs.readFileSync(one(flags, "current-file"), "utf8") : await fetchSheetCsv(job.subject.sheetId, job.subject.gid);
  } catch (e) {
    readError = e.message;
  }
  if (afterText !== null) fs.writeFileSync(path.join(dir, `sheet-after.r${round.n}.csv`), afterText);
  const v = verifySheet({ beforeText: before, afterText, cols: job.subject.cols, claimed: claimedCells(rep), readError });
  round.verification.sheet = { ...v, at: Date.now() };
  const res = applyVerification(job, round);
  saveJob(dir, job);
  for (const n of v.notes) process.stderr.write(`sheet round ${round.n}: ${n}\n`);
  emit({
    cmd: "verify-sheet",
    ok: v.status === "PASS" || v.status === "WARN",
    job: job.job,
    round: round.n,
    status: v.status,
    changedCells: v.changedCells.length,
    claimed: v.claimedCount,
    foreign: v.foreign.length,
    added: v.added.length,
    removed: v.removed.length,
    outstandingDevRows: v.outstandingDevRows,
    notes: v.notes,
    state: job.state,
    missing: res.missing,
  });
  return v.status === "PASS" || v.status === "WARN" ? EXIT.OK : EXIT.CHECK_FAILED;
}

function extractJson(text) {
  const m = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m.exec(text);
  return m ? m[1] : "{}";
}

function cmdRecord(flags) {
  const { dir, job } = loadJob(flags);
  const round = pickRound(job, flags);
  const kind = req(flags, "kind");
  const status = req(flags, "status");
  if (!VERIFY_KINDS.includes(kind)) throw new CliError(EXIT.USAGE, `--kind must be one of ${VERIFY_KINDS.join(", ")}`);
  if (!VERIFY_STATUSES.includes(status)) throw new CliError(EXIT.USAGE, `--status must be one of ${VERIFY_STATUSES.join(", ")}`);
  round.verification[kind] = { status, notes: many(flags, "note"), at: Date.now() };
  const res = applyVerification(job, round);
  saveJob(dir, job);
  emit({ cmd: "record", ok: status === "PASS" || status === "WARN", job: job.job, round: round.n, kind, status, state: job.state, missing: res.missing });
  return status === "PASS" || status === "WARN" ? EXIT.OK : EXIT.CHECK_FAILED;
}

function cmdProbe(flags) {
  const name = req(flags, "name");
  const file = PROBES[name];
  if (!file) throw new CliError(EXIT.USAGE, `--name must be one of ${Object.keys(PROBES).join(", ")}`);
  const src = fs.readFileSync(path.join(HERE, "probes", file), "utf8");
  const expr = src.replace(/^(?:\s*\/\/[^\n]*\n)+/, "").trim();
  const sets = [];
  if (one(flags, "selector") !== undefined) sets.push(`window.__PROBE_SELECTOR=${JSON.stringify(one(flags, "selector"))};`);
  if (one(flags, "id") !== undefined) sets.push(`window.__PROBE_ID=${JSON.stringify(String(one(flags, "id")))};`);
  if (one(flags, "limit") !== undefined) sets.push(`window.__PROBE_LIMIT=${Number(one(flags, "limit"))};`);
  if (name === "element-rect" && one(flags, "selector") === undefined) throw new CliError(EXIT.USAGE, "element-rect needs --selector");
  if (name === "dashboard-issue" && one(flags, "id") === undefined) throw new CliError(EXIT.USAGE, "dashboard-issue needs --id (stable issue id)");
  emit({ cmd: "probe", ok: true, name, expression: `(async()=>{${sets.join("")}return await (${expr});})()` });
  return EXIT.OK;
}

function blockingText(job) {
  const last = job.rounds.at(-1);
  switch (job.state) {
    case "open":
      return "no round dispatched yet";
    case "dispatched":
      return `worker ${last?.worker.terminal} running round ${last?.n} (wait)`;
    case "settled":
      return "worker idle: validate-report";
    case "reported": {
      const miss = (last?.report?.required ?? []).filter((k) => !["PASS", "WARN"].includes(last.verification[k]?.status));
      return `independent verification pending: ${miss.join(", ") || "none"}`;
    }
    case "needs_input":
      return "waiting for the user's answer";
    case "verified":
      return "verified; waiting for the user's approval";
    case "user-approved":
      return job.closeVerifiedAt ? "ready to close" : "dispatch --kind close, wait, validate-report, record dashboard PASS";
    default:
      return "";
  }
}

function cmdStatus(flags) {
  const jobs = [];
  if (one(flags, "job")) {
    const { dir, job } = loadJob(flags);
    jobs.push({ dir, job });
  } else {
    const leader = one(flags, "leader") || process.env.ANTIFAN_TERMINAL_SESSION_ID;
    if (!leader) throw new CliError(EXIT.USAGE, "pass --leader TERMINAL or --job DIR (ANTIFAN_TERMINAL_SESSION_ID is not set)");
    const root = jobsRoot();
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {}
    for (const name of names) {
      const dir = path.join(root, name);
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
        if (job.schema === JOB_SCHEMA && job.leader?.terminal === leader && (one(flags, "all") || job.state !== "closed")) jobs.push({ dir, job });
      } catch {}
    }
  }
  for (const { dir, job } of jobs) {
    const last = job.rounds.at(-1);
    emit({
      cmd: "status",
      job: job.job,
      jobDir: fwd(dir),
      state: job.state,
      issueId: job.subject.issueId,
      shop: job.subject.shop,
      rounds: job.rounds.length,
      lastSettledAt: [...job.rounds].reverse().find((r) => r.settledAt)?.settledAt ?? null,
      lastWorker: last?.worker.terminal ?? null,
      blocking: blockingText(job),
      nextReportPath: reportPathFor(dir, job, job.rounds.length + 1),
      outstandingDevRows: latestSheet(job)?.outstandingDevRows?.length ?? null,
    });
  }
  emit({ cmd: "status", ok: true, jobs: jobs.length });
  return EXIT.OK;
}

const latestSheet = (job) => [...job.rounds].reverse().find((r) => r.verification?.sheet)?.verification.sheet;

function cmdApprove(flags) {
  const { dir, job } = loadJob(flags);
  const force = one(flags, "force") === true;
  if (!force) {
    if (job.state !== "verified") throw new CliError(EXIT.REFUSED, `approve needs state verified, state is ${job.state}`);
    const last = job.rounds.at(-1);
    if (last?.report?.status !== "DONE") throw new CliError(EXIT.REFUSED, `latest report status is ${last?.report?.status}, only DONE can be approved`);
    const out = latestSheet(job)?.outstandingDevRows ?? [];
    if (out.length && one(flags, "allow-outstanding") !== true) {
      throw new CliError(EXIT.REFUSED, `${out.length} Dev rows are still outstanding in the sheet (pass --allow-outstanding if the user accepts that)`, { outstandingDevRows: out });
    }
  }
  job.state = "user-approved";
  job.approvedAt = Date.now();
  saveJob(dir, job);
  emit({ cmd: "approve", ok: true, job: job.job, state: job.state });
  return EXIT.OK;
}

function cmdClose(flags) {
  const { dir, job } = loadJob(flags);
  const force = one(flags, "force") === true;
  if (!force) {
    if (job.state !== "user-approved") throw new CliError(EXIT.REFUSED, `close needs state user-approved, state is ${job.state}`);
    if (!job.closeVerifiedAt && one(flags, "without-done") !== true) {
      throw new CliError(EXIT.REFUSED, "no verified close round (dispatch --kind close and verify the dashboard Stage), or pass --without-done");
    }
  }
  job.state = "closed";
  job.closedAt = Date.now();
  saveJob(dir, job);
  emit({ cmd: "close", ok: true, job: job.job, state: job.state });
  return EXIT.OK;
}

// ---------------------------------------------------------------- main

const COMMANDS = {
  init: cmdInit,
  dispatch: cmdDispatch,
  wait: cmdWait,
  "validate-report": cmdValidateReport,
  "verify-sheet": cmdVerifySheet,
  record: cmdRecord,
  probe: cmdProbe,
  status: cmdStatus,
  approve: cmdApprove,
  close: cmdClose,
};

export async function main(argv) {
  let cmd = null;
  try {
    const parsed = parseArgv(argv);
    cmd = parsed.cmd;
    if (parsed.flags.has("help") || !cmd) {
      process.stdout.write(HELP);
      return cmd || parsed.flags.has("help") ? EXIT.OK : EXIT.USAGE;
    }
    const fn = COMMANDS[cmd];
    if (!fn) throw new CliError(EXIT.USAGE, `unknown command ${JSON.stringify(cmd)} (see --help)`);
    return await fn(parsed.flags);
  } catch (e) {
    const code = e instanceof CliError ? e.code : EXIT.USAGE;
    process.stderr.write(`error: ${e.message}\n`);
    emit({ cmd, ok: false, code, error: e.message, ...(e instanceof CliError ? e.extra : {}) });
    return code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
