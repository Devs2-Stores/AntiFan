#!/usr/bin/env node
// fleet-watch.mjs - one waiter for EVERY worker a Leader drives, including workers created while it waits.
//
//   node scripts/leader/fleet-watch.mjs [--leader <terminalId>] [--timeout-min N] [--stale-min N] [--grace-sec N]
//        [--report <terminal>=<path>]... [--once] [--peek] [--table] [--poll-ms N]
//        [--config-dir DIR] [--runs-dir DIR] [--sessions-dir DIR] [--events-file FILE]
//   node scripts/leader/wait-workers.mjs --mine ...     (same program; the command the Leader types)
//
// Why it exists (04/11/2026): `wait-workers.mjs --w ...` takes a FIXED worker list and exits when ONE worker
// settles. The Leader re-launched it with only the workers it remembered and forgot terminal-213, which had
// finished 5 minutes earlier; a `terminal.close` answered EXECUTION_UNCERTAIN, nobody read the list back, and
// the worker stayed open. This program takes no list: every scan reads the Manager's Leader registry
// (<config>/leader-terminals.json, `workers[<id>].leaderId`) and the run files, so a worker made after the
// script started is picked up, and a worker the Leader forgot about is still in the table.
//
// A scan returns when something HAPPENED to any worker and was not reported before:
//   new-worker      a terminal appeared under this Leader            worker-gone    a known terminal is gone
//   worker-idle     a run finished (runSeq N is done; once per run)    needs-input    an `ask` dialog is open
//   worker-dead     OMP pid gone / heartbeat lost                      worker-stale   silent for --stale-min
//   worker-ended    OMP exited cleanly                                 worker-undelivered  idle at runSeq 0 past --grace-sec
//   worker-no-omp   registered terminal with no run file past --grace-sec
//   report          the worker's report file appeared or its first line (`STATUS: ...`) changed
// Reported events are appended to <data>/leader/<leader>-events.jsonl; each is reported once. `--peek` reads
// that ledger but never writes it (a read-only look that must not use up the real Leader's events).
// Whatever the exit reason, stdout ends with EVERY open worker, and `openUnclosed`: workers that are idle,
// ended or dead and still open. That list is printed every call, reported before or not (the terminal-181 bug).
//
// Worker -> Leader, no new channel: a worker rewrites line 1 of its report to `STATUS: NEEDS_INPUT` (or any
// STATUS) at any moment; the waiter wakes on the next 2 s tick and reports it.
//
// Report file of a worker: --report <terminal>=<path>, else derived from the prompt file in its `promptHead`
// (`<file name="...x.prompt.md">` or a path in a follow-up line): `x.prompt.md` -> `x.report.md`, `x.md` ->
// `x.report.md`, plus `x.rN.report.md`; only files newer than the worker's assignment count.
//
// stdout: JSON lines `summary`, `event`, `worker` (or a text table with --table). Exit: 0 events, 3 timeout with
// nothing new, 4 a worker is dead / stale / has no OMP, 5 a worker needs input (and none dead), 7 a worker never
// started its run (and none of the above), 2 usage or unreadable registry.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { pendingAskOf } from "./ask-dialog.mjs";
import { FALLBACK_TICK_MS, nextRunChange } from "./event-wait.mjs";
import { defaultSessionsDir, effectiveRunState, pidAlive, START_GRACE_MS } from "./worker-liveness.mjs";
import { liveness } from "./worker-status.mjs";

const DEFAULT_DATA_ROOT = "E:/Work/.antifan-data";
const TERMINAL_ID = /^[A-Za-z0-9_-]+$/;
/** Phases whose terminal is still open although its work is over: the Leader owes a close. */
const UNCLOSED_PHASES = new Set(["idle", "ended", "dead", "stale", "no-run-started"]);

export function defaultDirs(env = process.env) {
  const dataRoot = env.ANTIFAN_DATA_ROOT || DEFAULT_DATA_ROOT;
  return {
    dataRoot,
    configDir: env.ANTIFAN_CONFIG_DIR || path.join(dataRoot, "config"),
    runsDir: env.LEADER_RUNS_DIR || path.join(dataRoot, "runtime", "runs"),
    ledgerDir: path.join(dataRoot, "leader"),
  };
}

export function ledgerFileOf(dirs, leader) {
  return path.join(dirs.ledgerDir, `${leader}-events.jsonl`);
}

/** The Manager's Leader registry; null when it cannot be read (a lock error is retried twice). */
export function readRegistry(configDir) {
  const file = path.join(configDir, "leader-terminals.json");
  for (let attempt = 0; ; attempt++) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      if (attempt >= 2 || !["EBUSY", "EPERM", "EACCES"].includes(e.code)) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

const numberOf = (id) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);

/** The terminals this Leader drives, from the registry: [{ terminal, title, assignedAt }], by terminal number. */
export function workersOf(registry, leader) {
  const workers = registry && typeof registry.workers === "object" && registry.workers ? registry.workers : {};
  return Object.entries(workers)
    .filter(([id, rec]) => TERMINAL_ID.test(id) && rec && rec.leaderId === leader)
    .map(([terminal, rec]) => ({
      terminal,
      title: typeof rec.title === "string" ? rec.title : "",
      assignedAt: typeof rec.assignedAt === "number" ? rec.assignedAt : 0,
    }))
    .sort((a, b) => numberOf(a.terminal) - numberOf(b.terminal));
}

export const incarnationOf = (w) => `${w.terminal}@${w.assignedAt}`;

// ---------------------------------------------------------------------------------------------- ledger

export function emptyLedger() {
  return { reported: new Set(), known: new Set(), gone: new Set(), prompts: new Map() };
}

/** Parse the events ledger (JSON lines; a damaged line is skipped). Missing file = empty ledger. */
export function loadLedger(file) {
  const ledger = emptyLedger();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return ledger;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev.key !== "string") continue;
    ledger.reported.add(ev.key);
    if (ev.kind === "new-worker" && ev.incarnation) ledger.known.add(ev.incarnation);
    if (ev.kind === "worker-gone" && ev.incarnation) ledger.gone.add(ev.incarnation);
    if (typeof ev.prompt === "string" && ev.prompt && ev.terminal) {
      const list = ledger.prompts.get(ev.terminal) ?? [];
      if (!list.includes(ev.prompt)) list.push(ev.prompt);
      ledger.prompts.set(ev.terminal, list);
    }
  }
  return ledger;
}

export function appendEvents(file, events, now) {
  if (!events.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = events.map((ev) =>
    JSON.stringify({ at: now, key: ev.key, kind: ev.kind, terminal: ev.terminal, incarnation: ev.incarnation, ...(ev.prompt ? { prompt: ev.prompt } : {}), ...(ev.by ? { by: ev.by } : {}) }),
  );
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

// ----------------------------------------------------------------------------------------- report files

const FILE_TAG = /<file name="([^"]+?\.md)"/;
const MD_PATH = /([A-Za-z]:[\\/][^\s"'<>|*?]+?\.md)(?![A-Za-z0-9])/;

/** The prompt file a run was started from, read from the head of its prompt; null when the head names none. */
export function promptPathOf(head) {
  if (typeof head !== "string") return null;
  const m = FILE_TAG.exec(head) || MD_PATH.exec(head);
  return m ? m[1].replace(/\\/g, "/") : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const NAMED_REPORT = /[A-Za-z]:[\\/][^\s"'`<>|*?]+?\.report\.md(?![A-Za-z0-9])/g;
const MAX_PROMPT_BYTES = 300_000;

/**
 * Report paths the prompt file itself names as THE worker's report: a line with a `.report.md` path that also says
 * `STATUS` or `report vào` (inputs such as another job's plan.report.md sit on other lines and are not taken).
 */
export function reportsNamedIn(promptPath) {
  let text;
  try {
    if (fs.statSync(promptPath).size > MAX_PROMPT_BYTES) return [];
    text = fs.readFileSync(promptPath, "utf8");
  } catch {
    return [];
  }
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!/STATUS|report vào/i.test(line)) continue;
    for (const m of line.matchAll(NAMED_REPORT)) out.add(m[0].replace(/\\/g, "/"));
  }
  return [...out];
}

/**
 * Where the report of a prompt file is, or will be: { expected, found }. `expected` is every path it can be written to
 * (named in the prompt, x.prompt.md / x.md -> x.report.md); an empty list means UNKNOWN, which is not the same as
 * "not written yet". `found` are those that exist now, plus x.rN.report.md follow-up rounds.
 */
export function reportCandidates(promptPath) {
  const dir = path.dirname(promptPath);
  const name = path.basename(promptPath);
  const base = name.replace(/\.prompt\.md$/i, "").replace(/\.md$/i, "");
  const root = base.replace(/\.r\d+$/, "");
  const expected = [...reportsNamedIn(promptPath), ...new Set([base, root]).values()].map((b) => (b.endsWith(".report.md") ? b : path.join(dir, `${b}.report.md`).replace(/\\/g, "/")));
  const found = new Set(expected.filter((f) => fs.existsSync(f)));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // no folder, no reports
  }
  const rounds = new RegExp(`^${escapeRe(root)}\\.r\\d+\\.report\\.md$`);
  for (const n of names) if (rounds.test(n)) found.add(path.join(dir, n));
  return { expected: [...new Set(expected)], found: [...found] };
}

/** The newest report among `files` written after `since`: { path, mtime, firstLine, status } or null. */
export function pickReport(files, since) {
  let best = null;
  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || !(st.mtimeMs > since)) continue;
    if (!best || st.mtimeMs > best.mtime) best = { path: file.replace(/\\/g, "/"), mtime: st.mtimeMs };
  }
  if (!best) return null;
  let firstLine = "";
  try {
    firstLine = fs.readFileSync(best.path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trim();
  } catch {
    // unreadable: report the file without a status
  }
  const m = /^STATUS:\s*([A-Za-z_]+)/.exec(firstLine);
  return { ...best, firstLine, status: m ? m[1].toUpperCase() : null };
}

// ------------------------------------------------------------------------------------------- one worker

/**
 * Judge one worker. `run` is its parsed run file or null. ctx: { now, staleMs, graceMs, sessionsDir,
 * pidOf(run) (default pidAlive), reportOverride (path | undefined), ledgerPrompts (paths) }.
 * phase: running | idle | waiting_user | starting | no-run-started | no-omp | ended | dead | stale.
 */
export function inspectWorker(worker, run, ctx) {
  const { now } = ctx;
  const age = worker.assignedAt ? now - worker.assignedAt : Infinity;
  const row = {
    terminal: worker.terminal,
    incarnation: incarnationOf(worker),
    title: worker.title,
    assignedAt: worker.assignedAt,
    phase: null,
    state: null,
    rawState: run?.state ?? null,
    ompAlive: null,
    runSeq: run?.runSeq ?? null,
    idleSec: null,
    lastTool: run?.lastTool ?? null,
    why: null,
    prompt: null,
    report: null,
    reportExpected: null,
  };
  const head = promptPathOf(run?.promptHead);
  const prompts = [...new Set([...(ctx.ledgerPrompts ?? []), ...(head ? [head] : [])])];
  row.prompt = head ?? prompts[0] ?? null;
  const info = ctx.reportOverride
    ? { expected: [ctx.reportOverride], found: [ctx.reportOverride] }
    : { expected: [...new Set(prompts.flatMap((p) => reportCandidates(p).expected))], found: [...new Set(prompts.flatMap((p) => reportCandidates(p).found))] };
  row.reportExpected = info.expected[0] ?? null;
  row.report = pickReport(info.found, worker.assignedAt);

  if (!run) {
    row.phase = age < ctx.graceMs ? "starting" : "no-omp";
    row.state = null;
    row.ompAlive = false;
    row.why = row.phase === "no-omp" ? "no run file: the terminal has no OMP (a shell or a split, or OMP never started)" : null;
    return row;
  }
  const eff = effectiveRunState(run, { now, pidAlive: (ctx.pidOf ?? ((r) => pidAlive(r.pid)))(run) });
  const live = liveness(run, eff, ctx.sessionsDir, now, ctx.staleMs);
  row.state = eff.state;
  row.ompAlive = eff.ompAlive;
  row.lastEventAt = typeof run.lastEventAt === "number" ? run.lastEventAt : null;
  row.idleSec = typeof run.lastEventAt === "number" ? Math.max(0, Math.round((now - run.lastEventAt) / 1000)) : null;
  if (live.dead) {
    row.phase = /no event or session file write/.test(live.why ?? "") ? "stale" : "dead";
    row.why = live.why;
  } else if (run.state === "ended" || eff.state === "ended") {
    row.phase = "ended";
    row.why = eff.why ?? "OMP session ended";
  } else if (eff.state === "waiting_user") {
    row.phase = "waiting_user";
    try {
      row.ask = pendingAskOf(ctx.sessionsDir, run);
    } catch {
      row.ask = null;
    }
  } else if (eff.state === "idle") {
    if ((run.runSeq ?? 0) >= 1) row.phase = "idle";
    else {
      row.phase = age < ctx.graceMs ? "starting" : "no-run-started";
      if (row.phase === "no-run-started") row.why = `OMP is alive and idle but started no run ${Math.round(age / 1000)} s after the worker was assigned: it never took a prompt`;
    }
  } else {
    row.phase = "running";
  }
  return row;
}

// --------------------------------------------------------------------------------------------- events

const KIND_OF_PHASE = {
  idle: "worker-idle",
  waiting_user: "needs-input",
  dead: "worker-dead",
  stale: "worker-stale",
  ended: "worker-ended",
  "no-run-started": "worker-undelivered",
  "no-omp": "worker-no-omp",
};

function describe(kind, row) {
  const who = `${row.terminal}${row.title ? ` (${row.title})` : ""}`;
  switch (kind) {
    case "new-worker":
      return `${who}: worker mới dưới Leader này`;
    case "worker-gone":
      return `${who}: terminal đã biến mất (đã đóng)`;
    case "worker-idle":
      return `${who}: xong lượt ${row.runSeq} (idle), terminal CHƯA đóng`;
    case "needs-input":
      return `${who}: đang chờ trả lời hộp thoại ask`;
    case "worker-dead":
      return `${who}: chết: ${row.why}`;
    case "worker-stale":
      return `${who}: im lặng: ${row.why}`;
    case "worker-ended":
      return `${who}: OMP đã thoát, terminal CHƯA đóng`;
    case "worker-undelivered":
      return `${who}: ${row.why}`;
    case "worker-no-omp":
      return `${who}: ${row.why}`;
    case "report":
      return `${who}: báo cáo ${path.basename(row.report.path)} dòng đầu "${row.report.firstLine}"`;
    default:
      return who;
  }
}

/**
 * Every event the current scan implies, reported before or not. `rows` are the workers now registered;
 * `ledger` what earlier calls recorded. Unreported ones are picked by the caller with `unreported`.
 */
export function computeEvents(rows, ledger) {
  const events = [];
  const push = (kind, row, key, extra = {}) =>
    events.push({ key, kind, terminal: row.terminal, incarnation: row.incarnation, title: row.title, message: describe(kind, row), ...extra });
  const present = new Set(rows.map((r) => r.incarnation));
  for (const row of rows) {
    if (!ledger.known.has(row.incarnation)) push("new-worker", row, `new:${row.incarnation}`, { prompt: row.prompt ?? undefined });
    const kind = KIND_OF_PHASE[row.phase];
    if (kind) {
      const key = row.phase === "waiting_user" ? `ask:${row.terminal}:${row.runSeq}:${row.lastEventAt ?? ""}` : `${row.phase}:${row.terminal}:${row.runSeq}`;
      push(kind, row, key, row.phase === "waiting_user" ? { ask: row.ask ?? null } : row.why ? { why: row.why } : {});
    }
    if (row.report) {
      push("report", row, `report:${row.terminal}:${row.report.firstLine}`, {
        status: row.report.status,
        needsInput: row.report.status === "NEEDS_INPUT",
        report: row.report.path,
      });
    }
  }
  for (const inc of ledger.known) {
    if (present.has(inc) || ledger.gone.has(inc)) continue;
    const terminal = inc.slice(0, inc.lastIndexOf("@"));
    const row = { terminal, incarnation: inc, title: "" };
    push("worker-gone", row, `gone:${inc}`);
  }
  return events;
}

export const unreported = (events, ledger) => events.filter((e) => !ledger.reported.has(e.key));

/** 4 dead / stale / no OMP, 5 needs input, 7 never started, else 0. */
export function exitCodeFor(events) {
  const has = (pred) => events.some(pred);
  if (has((e) => e.kind === "worker-dead" || e.kind === "worker-stale" || e.kind === "worker-no-omp")) return 4;
  if (has((e) => e.kind === "needs-input" || e.needsInput)) return 5;
  if (has((e) => e.kind === "worker-undelivered")) return 7;
  return 0;
}

/** Workers whose terminal is still open although their work is over: the Leader owes a `close-worker`. */
export function openUnclosed(rows) {
  return rows
    .filter((r) => UNCLOSED_PHASES.has(r.phase))
    .map((r) => ({
      terminal: r.terminal,
      title: r.title,
      phase: r.phase,
      idleSec: r.idleSec,
      report: r.report ? { path: r.report.path, status: r.report.status } : null,
    }));
}

// ------------------------------------------------------------------------------------------------ scan

export function scanFleet(opts, now = Date.now()) {
  const registry = readRegistry(opts.configDir);
  if (!registry) return { error: `cannot read the Leader registry ${path.join(opts.configDir, "leader-terminals.json")}` };
  const workers = workersOf(registry, opts.leader);
  const isLeader = Array.isArray(registry.leaders) && registry.leaders.includes(opts.leader);
  if (!isLeader && workers.length === 0) {
    return { error: `${opts.leader} is not a marked Leader terminal and drives no worker (pass --leader <terminalId> or run from the Leader's own terminal)` };
  }
  const ledger = loadLedger(opts.eventsFile);
  const rows = workers.map((w) => {
    let run = null;
    try {
      run = JSON.parse(fs.readFileSync(path.join(opts.runsDir, `${w.terminal}.json`), "utf8"));
    } catch {
      run = null;
    }
    return inspectWorker(w, run, {
      now,
      staleMs: opts.staleMin * 60_000,
      graceMs: opts.graceSec * 1000,
      sessionsDir: opts.sessionsDir,
      pidOf: opts.pidOf,
      reportOverride: opts.reports?.get(w.terminal),
      ledgerPrompts: ledger.prompts.get(w.terminal),
    });
  });
  const all = computeEvents(rows, ledger);
  return { rows, ledger, events: unreported(all, ledger), registry };
}

/** Scan until something unreported happens; returns { code, rows, events, timedOut, note }. */
export async function watchFleet(opts) {
  const deadline = opts.timeoutMin == null ? Infinity : Date.now() + opts.timeoutMin * 60_000;
  for (;;) {
    const now = Date.now();
    const scan = scanFleet(opts, now);
    if (scan.error) return { code: 2, error: scan.error, rows: [], events: [] };
    if (scan.events.length) {
      if (!opts.peek) appendEvents(opts.eventsFile, scan.events, now);
      return { code: exitCodeFor(scan.events), rows: scan.rows, events: scan.events, timedOut: false };
    }
    if (opts.once) return { code: 0, rows: scan.rows, events: [], timedOut: false, note: scan.rows.length === 0 ? "EMPTY FLEET: this Leader drives no worker (nothing new happened)" : "no new event" };
    // An empty fleet keeps waiting: the documented flow starts the waiter first, then terminal.create; `new-worker` or the timeout ends it.
    if (Date.now() > deadline) return { code: 3, rows: scan.rows, events: [], timedOut: true, note: scan.rows.length === 0 ? "timeout: EMPTY FLEET, no worker ever appeared" : "timeout: nothing new happened" };
    await nextRunChange(opts.runsDir, { fallbackMs: opts.pollMs });
  }
}

// ----------------------------------------------------------------------------------------------- output

function ago(sec) {
  if (sec === null || sec === undefined) return "-";
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

export function renderTable(result, opts) {
  const lines = [];
  const head = result.error ? `LỖI: ${result.error}` : `Leader ${opts.leader}: ${result.rows.length} worker đang mở, ${result.events.length} sự kiện mới${result.timedOut ? " (hết thời gian chờ)" : ""}`;
  lines.push(head);
  for (const ev of result.events ?? []) lines.push(`  * [${ev.kind}] ${ev.message}`);
  if (result.rows?.length) {
    lines.push("", "terminal      phase            run  idle   report                    tên");
    for (const r of result.rows) {
      lines.push(
        `${r.terminal.padEnd(13)} ${String(r.phase).padEnd(16)} ${String(r.runSeq ?? "-").padEnd(4)} ${ago(r.idleSec).padEnd(6)} ${(r.report ? r.report.status ?? "?" : r.reportExpected ? "(chưa có)" : "? báo cáo không rõ").padEnd(25)} ${r.title}`,
      );
    }
  }
  const open = result.rows ? openUnclosed(result.rows) : [];
  if (open.length) lines.push("", `CÒN MỞ CHƯA ĐÓNG (${open.length}): ${open.map((o) => `${o.terminal}[${o.phase}]`).join(", ")}  -> node scripts/leader/close-worker.mjs <id>...`);
  return `${lines.join("\n")}\n`;
}

export function renderJson(result, opts, now = Date.now()) {
  const rows = result.rows ?? [];
  const open = openUnclosed(rows);
  const out = [
    {
      type: "summary",
      leader: opts.leader,
      at: now,
      exit: result.code,
      ...(result.error ? { error: result.error } : {}),
      timedOut: Boolean(result.timedOut),
      events: result.events?.length ?? 0,
      workers: rows.length,
      openUnclosed: open,
      ...(result.note ? { note: result.note } : {}),
    },
  ];
  for (const ev of result.events ?? []) out.push({ type: "event", ...ev });
  for (const r of rows) {
    out.push({
      type: "worker",
      terminal: r.terminal,
      title: r.title,
      phase: r.phase,
      state: r.state,
      ompAlive: r.ompAlive,
      runSeq: r.runSeq,
      idleSec: r.idleSec,
      lastTool: r.lastTool,
      ...(r.why ? { why: r.why } : {}),
      ...(r.ask ? { ask: r.ask } : {}),
      prompt: r.prompt,
      report: r.report ? { path: r.report.path, status: r.report.status, firstLine: r.report.firstLine, mtime: r.report.mtime } : null,
      reportExpected: r.reportExpected,
      ...(r.reportExpected ? {} : { reportUnknown: "no prompt path or named report found for this worker: pass --report <terminal>=<path>" }),
    });
  }
  return out.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

// ------------------------------------------------------------------------------------------------- CLI

export function parseArgs(argv, env = process.env) {
  const dirs = defaultDirs(env);
  const opts = {
    leader: env.ANTIFAN_TERMINAL_SESSION_ID || null,
    timeoutMin: null,
    staleMin: 90,
    graceSec: START_GRACE_MS / 1000,
    pollMs: FALLBACK_TICK_MS,
    configDir: dirs.configDir,
    runsDir: dirs.runsDir,
    sessionsDir: defaultSessionsDir(),
    eventsFile: null,
    reports: new Map(),
    once: false,
    peek: false,
    table: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--mine") continue;
    else if (a === "--leader") opts.leader = value();
    else if (a === "--timeout-min") opts.timeoutMin = Number(value());
    else if (a === "--stale-min") opts.staleMin = Number(value());
    else if (a === "--grace-sec") opts.graceSec = Number(value());
    else if (a === "--poll-ms") opts.pollMs = Number(value());
    else if (a === "--config-dir") opts.configDir = value();
    else if (a === "--runs-dir") opts.runsDir = value();
    else if (a === "--sessions-dir") opts.sessionsDir = value();
    else if (a === "--events-file") opts.eventsFile = value();
    else if (a === "--report") {
      const spec = value();
      const eq = spec.indexOf("=");
      if (eq < 1 || !TERMINAL_ID.test(spec.slice(0, eq)) || eq === spec.length - 1) throw new Error(`--report needs <terminal>=<path>: ${spec}`);
      opts.reports.set(spec.slice(0, eq), spec.slice(eq + 1));
    } else if (a === "--once") opts.once = true;
    else if (a === "--peek") opts.peek = true;
    else if (a === "--table") opts.table = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.leader || !TERMINAL_ID.test(opts.leader)) throw new Error("--leader <terminalId> is required (env ANTIFAN_TERMINAL_SESSION_ID is not set)");
  if (opts.timeoutMin !== null && !(opts.timeoutMin > 0)) throw new Error(`--timeout-min must be > 0: ${opts.timeoutMin}`);
  if (!(opts.staleMin > 0)) throw new Error(`--stale-min must be > 0: ${opts.staleMin}`);
  if (!(opts.graceSec > 0)) throw new Error(`--grace-sec must be > 0: ${opts.graceSec}`);
  if (!(opts.pollMs > 0)) throw new Error(`--poll-ms must be > 0: ${opts.pollMs}`);
  if (!opts.eventsFile) opts.eventsFile = ledgerFileOf(dirs, opts.leader);
  return opts;
}

export async function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const result = await watchFleet(opts);
  process.stdout.write(opts.table ? renderTable(result, opts) : renderJson(result, opts));
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e.stack || e.message}\n`);
      process.exit(2);
    },
  );
}
