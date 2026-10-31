// leader-job.test.mjs - behavioural tests for the Leader job ledger CLI (scripts/leader/*).
//
// Real CSV fixtures (test/fixtures/leader-job/) come from two real feedback jobs:
//   whenever-*  : checkbox-style sheet (Xong / Công việc / Đầu mối / Ghi chú), round 1 of #282
//   seahorse-*  : stage-style sheet (Stage / Mô tả / Dev note kết quả), #289
// Every test runs in a temp dir; the real scratch/leader and .antifan-data are never touched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseCsv, stringifyCsv } from "../../scripts/leader/csv.mjs";
import { judgeRound, parseArgv } from "../../scripts/leader/leader-job.mjs";
import { parseReport, validateReportText } from "../../scripts/leader/report.mjs";
import { analyzeSheet, diffSheets, outstandingDevRows, parseSheet, verifySheet } from "../../scripts/leader/sheet-diff.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "scripts", "leader", "leader-job.mjs");
const FIX = path.join(REPO, "test", "fixtures", "leader-job");
const fixture = (name) => fs.readFileSync(path.join(FIX, name), "utf8");

const WHENEVER_COLS = { work: "Công việc", owner: "Đầu mối", note: "Ghi chú", done: "Xong" };
const SEAHORSE_COLS = { work: "Mô tả", owner: null, note: "Dev note kết quả", done: "Stage" };

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "leader-job-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

let counter = 0;
/** Fresh isolated world: jobs root, runs dir, env for the CLI. */
function world() {
  const root = path.join(TEMP, `w${++counter}`);
  const jobs = path.join(root, "jobs");
  const runs = path.join(root, "runs");
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("ANTIFAN_") && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
  env.LEADER_JOBS_ROOT = jobs;
  env.LEADER_RUNS_DIR = runs;
  env.ANTIFAN_TERMINAL_SESSION_ID = "terminal-1";
  return { root, jobs, runs, env };
}

/** Run the CLI; returns exit code, parsed stdout JSON lines, stderr. */
function cli(w, args, envOverride = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...w.env, ...envOverride } });
  const lines = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  return { code: r.status, lines, last: lines.at(-1), stderr: r.stderr, stdout: r.stdout };
}

const writeRun = (w, terminal, patch) =>
  fs.writeFileSync(
    path.join(w.runs, `${terminal}.json`),
    JSON.stringify({ schema: 1, terminalSessionId: terminal, ompSessionId: "omp-old", state: "idle", runSeq: 0, lastEventAt: 1, updatedAt: 1, ...patch }),
  );

function initJob(w, which, extra = []) {
  const wh = which === "whenever";
  const snap = path.join(w.root, `${which}-snapshot.csv`);
  fs.writeFileSync(snap, fixture(`${which}-before.csv`));
  const r = cli(w, [
    "init", "--slug", `${which}-job`, "--issue-id", wh ? "9282" : "9289", "--shop", wh ? "whenever.myshopify.com" : "seahorse-2.myharavan.com",
    "--sheet", wh ? "SHEETWHEN" : "SHEETSEA", "--gid", wh ? "0" : "957883403", "--snapshot-file", snap, ...extra,
  ]);
  assert.equal(r.code, 0, r.stderr);
  const dir = r.last.jobDir;
  return { dir, init: r.last, job: () => JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")) };
}

/** Fill the {{TASK}} marker, dispatch to `worker`, return the dispatch result. */
function dispatch(w, j, worker, extra = []) {
  const job = j.job();
  const p = path.join(j.dir, `${job.slug}.prompt.md`);
  if (fs.existsSync(p)) {
    const t = fs.readFileSync(p, "utf8");
    if (t.includes("{{TASK}}")) fs.writeFileSync(p, t.replace("{{TASK}}", "Ghi note vào sheet cho các dòng được giao."));
  }
  const n = job.rounds.length + 1;
  const prompt = n === 1 ? ["--prompt", p] : [];
  return cli(w, ["dispatch", "--job", j.dir, "--worker", worker, ...prompt, ...extra]);
}

function settle(w, j, worker, patch = {}) {
  writeRun(w, worker, { ompSessionId: "omp-new", state: "idle", runSeq: 1, lastEventAt: Date.now() + 5000, ...patch });
  return cli(w, ["wait", "--job", j.dir, "--poll-ms", "20", "--timeout-min", "0.05"]);
}

function reportText(job, round, over = {}, statusLine) {
  const json = {
    schema: "leader-report/1",
    status: "DONE",
    job: job.job,
    key: job.slug,
    round,
    guard: { issueId: job.subject.issueId, host: job.subject.host, shop: job.subject.shop, sheetId: job.subject.sheetId },
    summary: "ok",
    files: [],
    sheet: { cells: [] },
    dashboard: { commentsAdded: 1, stageBefore: "Feedback", stageAfter: "Feedback" },
    notChecked: ["viewport 375 not measured"],
    ...over,
  };
  return `${statusLine ?? `STATUS: ${json.status}`}\n\nsummary text\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

function claimsFromDiff(beforeText, afterText, cols) {
  return diffSheets(parseSheet(beforeText, cols), parseSheet(afterText, cols)).changed.map((c) => ({
    keyText: c.key,
    col: c.col,
    expect: c.after,
    ...(c.occ > 1 ? { occurrence: c.occ } : {}),
  }));
}

const syntheticJob = (over = {}) => ({
  job: "261030-0000-x",
  slug: "x",
  subject: { kind: "feedback", issueId: "42", host: "Taiz", shop: "shop.example", sheetId: "SHEET", gid: "0", cols: WHENEVER_COLS },
  scope: { keys: null },
  ...over,
});

// ---------------------------------------------------------------------------

describe("csv", () => {
  test("quoted fields, escaped quotes, embedded newlines and CRLF round-trip", () => {
    const rows = [["a", 'b "q" c', "line1\nline2", ""], ["", "x,y", "z", "\\literal\\"]];
    assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
    assert.deepEqual(parseCsv('a,"b\r\nc"\r\nd,e\r\n'), [["a", "b\r\nc"], ["d", "e"]]);
  });
  test("a truncated export (open quote) is an error, not silent data loss", () => {
    assert.throws(() => parseCsv('a,"never closed'), /quoted field/);
  });
  test("the real fixtures parse into 9-column rows", () => {
    const rows = parseCsv(fixture("whenever-before.csv"));
    assert.ok(rows.length > 55);
    assert.ok(rows.every((r) => r.length === 9));
  });
});

describe("init", () => {
  test("detects the Whenever layout, writes job.json and a guarded prompt skeleton", () => {
    const w = world();
    const j = initJob(w, "whenever", ["--keys", "Rà theme: xác định section và chức năng tận dụng được, phần cần bổ sung"]);
    const job = j.job();
    assert.equal(job.schema, "leader-job/1");
    assert.equal(job.state, "open");
    assert.equal(job.leader.terminal, "terminal-1");
    assert.equal(job.subject.host, "Taiz");
    assert.deepEqual(job.subject.cols, { work: "Công việc", owner: "Đầu mối", note: "Ghi chú", done: "Xong" });
    assert.deepEqual(job.scope.keys, ["Rà theme: xác định section và chức năng tận dụng được, phần cần bổ sung"]);
    assert.equal(job.snapshotBefore, "snapshot-before.csv");
    assert.equal(fs.readFileSync(path.join(j.dir, "snapshot-before.csv"), "utf8"), fixture("whenever-before.csv"));
    assert.match(job.job, /^\d{6}-\d{4}-whenever-job$/);
    const prompt = fs.readFileSync(path.join(j.dir, "whenever-job.prompt.md"), "utf8");
    assert.ok(prompt.includes("String(r.id)==='9282'"), "guard resolves by stable id");
    assert.ok(prompt.includes("x.host==='Taiz'") && prompt.includes("SHEETWHEN") && prompt.includes("whenever.myshopify.com"));
    assert.ok(prompt.includes(path.join(j.dir, "whenever-job.report.md").replace(/\\/g, "/")));
    assert.match(prompt, /KHÔNG chạy quickUpdate\(\.\.\.,'Done'\)/, "first pass never sets Done");
    assert.ok(prompt.includes("{{TASK}}"), "task marker left for the Leader");
    assert.ok(prompt.includes("hrv theme"), "haravan profile keeps the theme steps");
    assert.deepEqual([...new Set(prompt.match(/\{\{[A-Z_]+\}\}/g))], ["{{TASK}}"]);
    assert.ok(!/rowNumber===\d/.test(prompt), "no bare row number guard");
  });

  test("detects the Seahorse stage layout without an owner column; sheet-only profile drops theme steps", () => {
    const w = world();
    const j = initJob(w, "seahorse", ["--profile", "sheet-only"]);
    assert.deepEqual(j.job().subject.cols, { work: "Mô tả", owner: null, note: "Dev note kết quả", done: "Stage" });
    const prompt = fs.readFileSync(path.join(j.dir, "seahorse-job.prompt.md"), "utf8");
    assert.ok(!prompt.includes("hrv theme"));
  });

  test("refuses wrong headers, a missing Leader terminal and a duplicate job dir", () => {
    const w = world();
    const snap = path.join(w.root, "s.csv");
    fs.writeFileSync(snap, fixture("whenever-before.csv"));
    const base = ["init", "--slug", "a", "--issue-id", "1", "--shop", "s", "--sheet", "X", "--gid", "0", "--snapshot-file", snap];
    const bad = cli(w, [...base, "--cols-work", "Không có cột này", "--cols-note", "Ghi chú"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /header row not found/);
    const noLeader = cli(w, base, { ANTIFAN_TERMINAL_SESSION_ID: "" });
    assert.equal(noLeader.code, 2);
    assert.match(noLeader.stderr, /Leader terminal/);
    assert.equal(cli(w, base).code, 0);
    assert.equal(cli(w, base).code, 2, "same minute + slug must not overwrite a job");
  });
});

describe("sheet verification keyed by text", () => {
  test("Whenever round 1: claimed cells PASS-match exactly 17 changed cells", () => {
    const before = fixture("whenever-before.csv");
    const after = fixture("whenever-after.csv");
    const claimed = claimsFromDiff(before, after, WHENEVER_COLS).map((c) => ({ key: c.keyText, col: c.col, expect: c.expect, occurrence: c.occurrence }));
    assert.equal(claimed.length, 17);
    const v = verifySheet({ beforeText: before, afterText: after, cols: WHENEVER_COLS, claimed });
    assert.equal(v.status, "PASS", v.notes.join("\n"));
    assert.equal(v.changedCells.length, 17);
    assert.deepEqual(v.foreign, []);
    assert.ok(v.changedCells.every((c) => c.col === "Ghi chú"), "only the note column changed");
    assert.equal(v.doneKind, "checkbox");
    // Computed from the fixture itself: Dev rows (owner contains Dev) not ticked and with an empty note.
    assert.deepEqual(v.outstandingDevRows.map((r) => r.row), [6, 7, 46, 54]);
    assert.equal(outstandingDevRows(parseSheet(before, WHENEVER_COLS)).length, 20, "snapshot-before had 20 Dev rows still owed");
  });

  test("Seahorse: the prompt said rows 70/71/72, the sheet truth is 69/70/71, matching is by text", () => {
    const before = fixture("seahorse-before.csv");
    const after = fixture("seahorse-after.csv");
    const claimed = claimsFromDiff(before, after, SEAHORSE_COLS).map((c) => ({ key: c.keyText, col: c.col, expect: c.expect }));
    assert.equal(claimed.length, 6, "Stage + Dev note for three rows");
    const v = verifySheet({ beforeText: before, afterText: after, cols: SEAHORSE_COLS, claimed });
    assert.equal(v.status, "PASS", v.notes.join("\n"));
    assert.deepEqual([...new Set(v.changedCells.map((c) => c.rowAfter))], [69, 70, 71]);
    assert.ok(v.changedCells.every((c) => ![72].includes(c.rowAfter)));
    assert.ok(claimed.some((c) => c.key.startsWith("Chỗ đối tác thêm 20 logo")));
    // Rows keep the same text even if a human inserts rows above: shift everything down by two.
    const shiftedRows = parseCsv(after);
    shiftedRows.splice(1, 0, ["", "", "", "a human row", "", "", "", ""], ["", "", "", "another human row", "", "", "", ""]);
    const shifted = verifySheet({ beforeText: before, afterText: stringifyCsv(shiftedRows), cols: SEAHORSE_COLS, claimed });
    assert.deepEqual([...new Set(shifted.changedCells.map((c) => c.rowAfter))], [71, 72, 73]);
    assert.equal(shifted.added.length, 2);
    assert.equal(shifted.status, "WARN", "appended human rows only warn");
    assert.equal(shifted.notes.filter((n) => n.startsWith("FAIL")).length, 0);
    assert.deepEqual(v.outstandingDevRows.map((r) => r.row), [33, 36, 39, 50], "stage-based: rows whose Stage is not Fixed/Done");
  });

  test("a foreign edit and an appended row are WARN, not FAIL", () => {
    const before = fixture("whenever-before.csv");
    const rows = parseCsv(before);
    const tickIdx = rows.findIndex((r) => r[4]?.startsWith("Rà theme"));
    rows[tickIdx][0] = "TRUE"; // a human ticks Xong mid-job
    rows.push(["FALSE", "99", "Vòng 9", "Mới", "Một dòng khách thêm", "WA", "", "", ""]);
    const v = verifySheet({ beforeText: before, afterText: stringifyCsv(rows), cols: WHENEVER_COLS, claimed: [] });
    assert.equal(v.status, "WARN");
    assert.equal(v.foreign.length, 1);
    assert.equal(v.foreign[0].col, "Xong");
    assert.equal(v.added.length, 1);
    assert.ok(v.notes.some((n) => n.startsWith("WARN foreign edit")));
    assert.ok(v.notes.some((n) => n.startsWith("WARN row appended")));
  });

  test("a claimed cell that did not change is FAIL; a wrong expect and a missing row are FAIL", () => {
    const before = fixture("whenever-before.csv");
    const task = "Rà theme: xác định section và chức năng tận dụng được, phần cần bổ sung";
    const unchanged = verifySheet({ beforeText: before, afterText: before, cols: WHENEVER_COLS, claimed: [{ key: task, col: "Ghi chú", expect: "Em đã làm ạ" }] });
    assert.equal(unchanged.status, "FAIL");
    assert.match(unchanged.notes.join("\n"), /claimed but unchanged/);

    const rows = parseCsv(before);
    rows[rows.findIndex((r) => r[4]?.startsWith("Rà theme"))][7] = "Em đã làm";
    const after = stringifyCsv(rows);
    const wrong = verifySheet({ beforeText: before, afterText: after, cols: WHENEVER_COLS, claimed: [{ key: task, col: "Ghi chú", expect: "Em đã làm xong" }] });
    assert.equal(wrong.status, "FAIL");
    assert.match(wrong.notes.join("\n"), /differs from expect/);
    const missing = verifySheet({ beforeText: before, afterText: after, cols: WHENEVER_COLS, claimed: [{ key: "dòng không tồn tại", col: "Ghi chú", expect: "x" }] });
    assert.equal(missing.status, "FAIL");
    assert.match(missing.notes.join("\n"), /row not found by text/);
    const ok = verifySheet({ beforeText: before, afterText: after, cols: WHENEVER_COLS, claimed: [{ key: `  ${task}  `, col: "Ghi chú", expect: "Em đã làm" }] });
    assert.equal(ok.status, "PASS");
  });

  test("duplicate task text is told apart by occurrence index", () => {
    const head = ["Xong", "Công việc", "Đầu mối", "Ghi chú"];
    const before = stringifyCsv([head, ["FALSE", "Sửa logo", "Dev", ""], ["FALSE", "Sửa logo", "Dev", ""]]);
    const after = stringifyCsv([head, ["FALSE", "Sửa logo", "Dev", ""], ["FALSE", "Sửa logo", "Dev", "đã sửa"]]);
    const base = { beforeText: before, afterText: after, cols: WHENEVER_COLS };
    const ambiguous = verifySheet({ ...base, claimed: [{ key: "Sửa logo", col: "Ghi chú", expect: "đã sửa" }] });
    assert.equal(ambiguous.status, "FAIL");
    assert.match(ambiguous.notes.join("\n"), /ambiguous/);
    const second = verifySheet({ ...base, claimed: [{ key: "Sửa logo", col: "Ghi chú", expect: "đã sửa", occurrence: 2 }] });
    assert.equal(second.status, "PASS", second.notes.join("\n"));
    const first = verifySheet({ ...base, claimed: [{ key: "Sửa logo", col: "Ghi chú", expect: "đã sửa", occurrence: 1 }] });
    assert.equal(first.status, "FAIL");
  });

  test("an unreadable, HTML or headerless sheet is UNREADABLE, never PASS", () => {
    const before = fixture("whenever-before.csv");
    const base = { beforeText: before, cols: WHENEVER_COLS, claimed: [] };
    const none = verifySheet({ ...base, afterText: null, readError: "HTTP 403" });
    assert.equal(none.status, "UNREADABLE");
    assert.match(none.notes[0], /HTTP 403/);
    const html = verifySheet({ ...base, afterText: "<!DOCTYPE html><html><body>Sign in</body></html>" });
    assert.equal(html.status, "UNREADABLE");
    assert.match(html.notes[0], /HTML\/login page/);
    const wrongLayout = verifySheet({ ...base, afterText: "a,b\n1,2\n" });
    assert.equal(wrongLayout.status, "UNREADABLE");
    assert.match(wrongLayout.notes[0], /header row not found/);
    const empty = verifySheet({ ...base, afterText: "" });
    assert.equal(empty.status, "UNREADABLE");
  });

  test("layout: header row, key fallback for the Zalo section, structural rows", () => {
    const a = analyzeSheet(parseCsv(fixture("whenever-before.csv")), WHENEVER_COLS);
    assert.ok(a.ok);
    assert.equal(a.headerRow, 4);
    assert.ok(a.rows.find((r) => r.key === "Bỏ nút quay lại đầu trang ạ" && r.data), "Zalo rows keyed by the text that sits in the Vòng column");
    assert.ok(a.rows.find((r) => r.key === "~Tiến độ" && !r.data), "progress row is structural");
  });
});

describe("report validation", () => {
  const job = syntheticJob({ scope: { keys: ["Task A"] } });
  const good = (over = {}, line) => reportText(job, 1, over, line);

  test("a well-formed DONE report passes", () => {
    const r = validateReportText(good({ sheet: { cells: [{ keyText: "Task A", col: "Ghi chú", expect: "x" }] } }), job, 1);
    assert.deepEqual(r.errors, []);
    assert.equal(r.status, "DONE");
  });

  test("first line must be a STATUS line", () => {
    const r = validateReportText(good({}, "Done, mọi thứ ổn"), job, 1);
    assert.match(r.errors[0], /first line must be "STATUS: /);
    assert.match(r.errors[0], /Done, mọi thứ ổn/);
    assert.ok(validateReportText(good({}, "STATUS: MAYBE"), job, 1).errors.length > 0);
  });

  test("malformed JSON reports the exact parse error; missing block and two blocks are rejected", () => {
    const broken = "STATUS: DONE\n\n```json\n{ \"schema\": \"leader-report/1\", \n```\n";
    const r = validateReportText(broken, job, 1);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^fenced json block does not parse: .*JSON/);
    assert.match(validateReportText("STATUS: DONE\nno block\n", job, 1).errors[0], /no fenced ```json block/);
    const two = good() + "\n```json\n{}\n```\n";
    assert.match(parseReport(two).errors[0], /found 2 fenced json blocks/);
  });

  test("schema, job, round and key mismatches", () => {
    const e = validateReportText(good({ schema: "leader-report/2", job: "other", round: 3, key: "nope" }), job, 1).errors;
    assert.ok(e.some((x) => x.startsWith('schema must be "leader-report/1"')));
    assert.ok(e.some((x) => x.startsWith("job mismatch")));
    assert.ok(e.some((x) => x.startsWith("round mismatch")));
    assert.ok(e.some((x) => x.startsWith("key mismatch")));
  });

  test("guard mismatch names the field, the report value and the job value", () => {
    const e = validateReportText(good({ guard: { issueId: "43", host: "Lâm", shop: "shop.example", sheetId: "SHEET" } }), job, 1).errors;
    assert.deepEqual(e, ['guard.issueId mismatch: report "43" vs job "42"', 'guard.host mismatch: report "Lâm" vs job "Taiz"']);
    assert.match(validateReportText(good({ guard: undefined }), job, 1).errors[0], /guard object missing/);
  });

  test("a sheet claim outside scope.keys is rejected, in cells and in skipped", () => {
    const e = validateReportText(
      good({ sheet: { cells: [{ keyText: "Task B", col: "Ghi chú", expect: "x" }], skipped: [{ keyText: "Task C", reason: "đã có note" }] } }),
      job,
      1,
    ).errors;
    assert.deepEqual(e, ['sheet.cells[0].keyText "Task B" is outside scope.keys', 'sheet.skipped[0].keyText "Task C" is outside scope.keys']);
    const noScope = syntheticJob();
    assert.deepEqual(validateReportText(reportText(noScope, 1, { sheet: { cells: [{ keyText: "Anything", col: "Ghi chú", expect: "x" }] } }), noScope, 1).errors, []);
  });

  test("DONE without notChecked and NEEDS_INPUT without a proper needsInput are rejected", () => {
    const noNot = validateReportText(good({ notChecked: undefined }), job, 1).errors;
    assert.deepEqual(noNot, ["DONE report must carry a notChecked array (what was NOT verified)"]);
    const ni = (needsInput) => validateReportText(good({ status: "NEEDS_INPUT", notChecked: undefined, needsInput }), job, 1).errors;
    assert.match(ni(undefined)[0], /must carry needsInput/);
    assert.match(ni({ question: "?", options: ["một"] })[0], /2 or 3 non-empty strings/);
    assert.match(ni({ question: "", options: ["a", "b"] })[0], /question must be/);
    assert.deepEqual(ni({ question: "Dùng menu nào?", options: ["footer", "header"] }), []);
  });
});

describe("dispatch / wait / validate-report through the CLI", () => {
  test("dispatch refuses an unfilled skeleton, a prompt without the report path and a busy worker", () => {
    const w = world();
    const j = initJob(w, "whenever");
    const prompt = path.join(j.dir, "whenever-job.prompt.md");
    const marker = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", prompt]);
    assert.equal(marker.code, 4);
    assert.match(marker.stderr, /\{\{TASK\}\}/);

    const noPath = path.join(w.root, "bare.md");
    fs.writeFileSync(noPath, "Làm gì đó cho issue 9282 Taiz whenever.myshopify.com SHEETWHEN");
    const missingPath = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", noPath]);
    assert.equal(missingPath.code, 4);
    assert.match(missingPath.stderr, /where to write the report/);

    fs.writeFileSync(prompt, fs.readFileSync(prompt, "utf8").replace("{{TASK}}", "việc"));
    writeRun(w, "terminal-7", { state: "running", runSeq: 3, lastEventAt: Date.now() });
    const busy = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", prompt]);
    assert.equal(busy.code, 4);
    assert.match(busy.stderr, /terminal-7 is running/);
    assert.equal(j.job().rounds.length, 0, "a refused dispatch leaves no round");
    assert.equal(j.job().state, "open");
    writeRun(w, "terminal-7", { state: "waiting_user", runSeq: 3, lastEventAt: Date.now() });
    assert.equal(cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", prompt]).code, 4);
    const forced = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", prompt, "--allow-busy"]);
    assert.equal(forced.code, 0, forced.stderr);
  });

  test("a fresh dispatch stamps the round and prints the exact terminal.write input", () => {
    const w = world();
    const j = initJob(w, "whenever");
    writeRun(w, "terminal-7", { state: "ended", runSeq: 6, ompSessionId: "omp-old" });
    const before = Date.now();
    const d = dispatch(w, j, "terminal-7");
    assert.equal(d.code, 0, d.stderr);
    const job = j.job();
    const round = job.rounds[0];
    assert.equal(job.state, "dispatched");
    assert.equal(round.n, 1);
    assert.equal(round.mode, "fresh");
    assert.equal(round.preRunSeq, 6);
    assert.equal(round.preOmpSessionId, "omp-old");
    assert.ok(round.dispatchedAt >= before && round.dispatchedAt <= Date.now());
    assert.equal(round.settledAt, null);
    assert.equal(d.last.input, `omp "@${round.promptPath}"\r`);
    assert.equal(round.reportPath, path.join(j.dir, "whenever-job.report.md").replace(/\\/g, "/"));
    assert.ok(!fs.readFileSync(round.promptPath, "utf8").includes("{{REPORT_PATH}}"));
  });

  test("an idle OMP session gets a one-line follow-up; refused for a closed job", () => {
    const w = world();
    const j = initJob(w, "whenever");
    writeRun(w, "terminal-7", { state: "idle", runSeq: 2 });
    const d = dispatch(w, j, "terminal-7");
    assert.equal(d.last.mode, "followup");
    assert.ok(d.last.input.endsWith("\r") && !d.last.input.slice(0, -1).includes("\n"));
    assert.ok(d.last.input.includes(d.last.reportPath));
    const bad = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "close"]);
    assert.equal(bad.code, 4, "a close round needs approval first");
  });

  test("wait settles only when lastEventAt > dispatchedAt AND runSeq advanced", () => {
    const w = world();
    const j = initJob(w, "whenever");
    writeRun(w, "terminal-7", { state: "idle", runSeq: 6, ompSessionId: "omp-old" });
    assert.equal(dispatch(w, j, "terminal-7", ["--mode", "followup"]).code, 0);
    const waitArgs = ["wait", "--job", j.dir, "--poll-ms", "20", "--timeout-min", "0.02"];

    // idle, same session, runSeq unchanged, events older than dispatch: not settled
    assert.equal(cli(w, waitArgs).code, 3);
    // newer event but runSeq did not advance (a non-turn event): still not settled
    writeRun(w, "terminal-7", { state: "idle", runSeq: 6, ompSessionId: "omp-old", lastEventAt: Date.now() + 5000 });
    assert.equal(cli(w, waitArgs).code, 3);
    // runSeq advanced but lastEventAt is older than the dispatch: not settled
    writeRun(w, "terminal-7", { state: "idle", runSeq: 7, ompSessionId: "omp-old", lastEventAt: j.job().rounds[0].dispatchedAt - 1000 });
    assert.equal(cli(w, waitArgs).code, 3);
    // still running: not settled
    writeRun(w, "terminal-7", { state: "running", runSeq: 7, ompSessionId: "omp-old", lastEventAt: Date.now() + 5000 });
    assert.equal(cli(w, waitArgs).code, 3);
    assert.equal(j.job().state, "dispatched");
    assert.equal(j.job().rounds[0].settledAt, null);

    writeRun(w, "terminal-7", { state: "idle", runSeq: 7, ompSessionId: "omp-old", lastEventAt: Date.now() + 5000 });
    const ok = cli(w, waitArgs);
    assert.equal(ok.code, 0);
    assert.ok(ok.lines.some((l) => l.event === "round-settled" && l.round === 1));
    assert.equal(ok.last.event, "all-settled");
    assert.equal(j.job().state, "settled");
    assert.ok(j.job().rounds[0].settledAt > 0);
  });

  test("a fresh OMP session restarts runSeq: settles at runSeq 1 even when the old file had runSeq 6", () => {
    const round = { dispatchedAt: 1000, preRunSeq: 6, preOmpSessionId: "omp-old" };
    const run = (o) => ({ state: "idle", runSeq: 1, ompSessionId: "omp-new", lastEventAt: 2000, ...o });
    assert.equal(judgeRound(round, run()).kind, "settled");
    assert.equal(judgeRound(round, run({ runSeq: 0 })).kind, "pending", "new session that has not started a turn");
    assert.equal(judgeRound(round, run({ ompSessionId: "omp-old", runSeq: 6 })).kind, "pending", "same session needs preRunSeq + 1");
    assert.equal(judgeRound(round, run({ ompSessionId: "omp-old", runSeq: 7 })).kind, "settled");
    assert.equal(judgeRound(round, run({ state: "ended" })).kind, "settled");
    assert.equal(judgeRound(round, run({ state: "waiting_user" })).kind, "waiting_user");
    assert.equal(judgeRound(round, run({ lastEventAt: 1000 })).kind, "pending", "event must be strictly after dispatch");
    assert.equal(judgeRound(round, null).kind, "pending");
  });

  test("wait exits 5 and marks needs_input when the worker waits for the user", () => {
    const w = world();
    const j = initJob(w, "whenever");
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    const r = settle(w, j, "terminal-7", { state: "waiting_user", lastTool: "ask" });
    assert.equal(r.code, 5);
    assert.equal(r.last.event, "needs-input");
    assert.equal(r.last.lastTool, "ask");
    assert.equal(j.job().state, "needs_input");
  });

  test("validate-report rejects a report older than dispatchedAt, then accepts a fresh one", () => {
    const w = world();
    const j = initJob(w, "whenever");
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    assert.equal(settle(w, j, "terminal-7").code, 0);
    const job = j.job();
    const rp = job.rounds[0].reportPath;

    fs.writeFileSync(rp, reportText(job, 1));
    const old = (job.rounds[0].dispatchedAt - 60000) / 1000;
    fs.utimesSync(rp, old, old);
    const stale = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(stale.code, 1);
    assert.equal(stale.last.valid, false);
    assert.match(stale.last.errors[0], /report mtime .* is older than dispatchedAt/);
    assert.equal(j.job().rounds[0].report.valid, false);
    assert.equal(j.job().state, "settled", "an invalid report does not advance the state");

    const fresh = Date.now() / 1000 + 1;
    fs.utimesSync(rp, fresh, fresh);
    const ok = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.last.state, "reported");
    assert.deepEqual(j.job().rounds[0].report.required, ["sheet", "dashboard"]);
  });

  test("validate-report: missing file, malformed JSON, guard mismatch and unsettled round each give a precise error", () => {
    const w = world();
    const j = initJob(w, "whenever", ["--keys", "Rà theme: xác định section và chức năng tận dụng được, phần cần bổ sung"]);
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    const job = j.job();
    const rp = job.rounds[0].reportPath;
    const unsettled = cli(w, ["validate-report", "--job", j.dir]);
    assert.match(unsettled.last.errors.join("|"), /report file missing/);
    assert.match(unsettled.last.errors.join("|"), /not settled yet/);

    assert.equal(settle(w, j, "terminal-7").code, 0);
    fs.writeFileSync(rp, "STATUS: DONE\n\n```json\n{ nope }\n```\n");
    const broken = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(broken.code, 1);
    assert.match(broken.last.errors[0], /fenced json block does not parse: /);

    fs.writeFileSync(rp, reportText(job, 1, { guard: { issueId: "1", host: "Taiz", shop: "x", sheetId: "SHEETWHEN" } }));
    const guard = cli(w, ["validate-report", "--job", j.dir]);
    assert.deepEqual(guard.last.errors, ['guard.issueId mismatch: report "1" vs job "9282"', 'guard.shop mismatch: report "x" vs job "whenever.myshopify.com"']);

    fs.writeFileSync(rp, reportText(job, 1, { sheet: { cells: [{ keyText: "Việc ngoài phạm vi", col: "Ghi chú", expect: "x" }] } }));
    const scope = cli(w, ["validate-report", "--job", j.dir]);
    assert.match(scope.last.errors[0], /outside scope\.keys/);
  });

  test("the report example in the rendered worker prompt is accepted by validate-report (template cannot drift from the validator)", () => {
    const w = world();
    const j = initJob(w, "whenever");
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    assert.equal(settle(w, j, "terminal-7").code, 0);
    const job = j.job();
    const rendered = fs.readFileSync(job.rounds[0].promptPath, "utf8");
    const m = /^([ \t]*)```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/m.exec(rendered);
    assert.ok(m, "prompt carries one json example block");
    const indent = m[1];
    const body = m[2].split("\n").map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
    const example = JSON.parse(body);
    // dispatch filled the per-round values, so the worker copies them verbatim
    assert.equal(example.job, job.job);
    assert.equal(example.key, job.slug);
    assert.equal(example.round, 1);
    assert.deepEqual(example.guard, { issueId: "9282", host: "Taiz", shop: "whenever.myshopify.com", sheetId: "SHEETWHEN" });
    // a worker only swaps the "..." / "<...>" placeholders for real content
    const task = "Rà theme: xác định section và chức năng tận dụng được, phần cần bổ sung";
    example.sheet.cells[0].keyText = task;
    example.sheet.cells[0].expect = "Em đã làm";
    example.sheet.skipped[0].keyText = "Bảo toàn dữ liệu sản phẩm, biến thể, tồn kho, giá, luồng thanh toán và các URL đang dùng";
    assert.equal(example.sheet.cells[0].col, "Ghi chú");
    fs.writeFileSync(job.rounds[0].reportPath, `STATUS: ${example.status}\n\ntóm tắt\n\n\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\`\n`);
    const r = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(r.code, 0, `${r.stderr}\n${JSON.stringify(r.last?.errors)}`);
    assert.equal(r.last.valid, true);
    assert.deepEqual(r.last.errors, []);
    // a stale name from the old example would be rejected as a missing claim field
    const stale = JSON.parse(JSON.stringify(example));
    stale.sheet.cells[0].key = stale.sheet.cells[0].keyText;
    delete stale.sheet.cells[0].keyText;
    fs.writeFileSync(job.rounds[0].reportPath, `STATUS: DONE\n\n\`\`\`json\n${JSON.stringify(stale, null, 2)}\n\`\`\`\n`);
    assert.match(cli(w, ["validate-report", "--job", j.dir]).last.errors.join("|"), /keyText must be the task text/);
  });

  test("validate-report accepts a json fence indented by up to 3 spaces (the template example is indented) and rejects 4", () => {
    const w = world();
    const j = initJob(w, "whenever");
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    assert.equal(settle(w, j, "terminal-7").code, 0);
    const job = j.job();
    const indentBy = (text, pad) => text.replace(/```json\r?\n([\s\S]*?)\r?\n```/, (_, body) => `${pad}\`\`\`json\n${body.split("\n").map((l) => pad + l).join("\n")}\n${pad}\`\`\``);
    const plain = reportText(job, 1);
    const three = indentBy(plain, "   ");
    assert.notEqual(three, plain);
    fs.writeFileSync(job.rounds[0].reportPath, three);
    const ok = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(ok.code, 0, `${ok.stderr}\n${JSON.stringify(ok.last?.errors)}`);
    assert.equal(ok.last.valid, true);
    fs.writeFileSync(job.rounds[0].reportPath, indentBy(plain, "    "));
    const four = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(four.code, 1);
    assert.match(four.last.errors.join("|"), /no fenced ```json block found/);
  });

  test("no template mentions the retired report field names", () => {
    for (const f of ["worker-header.md", "close-followup.md"]) {
      const t = fs.readFileSync(path.join(REPO, "scripts", "leader", "templates", f), "utf8");
      for (const stale of ["filesChanged", "commentPosted", "stageSet", '"key": "<']) assert.ok(!t.includes(stale), `${f} still contains ${stale}`);
    }
  });

  test("a NEEDS_INPUT report moves the job to needs_input", () => {
    const w = world();
    const j = initJob(w, "whenever");
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    assert.equal(settle(w, j, "terminal-7").code, 0);
    const job = j.job();
    fs.writeFileSync(job.rounds[0].reportPath, reportText(job, 1, { status: "NEEDS_INPUT", notChecked: undefined, needsInput: { question: "Theme live, push?", options: ["Có", "Không"] } }));
    const r = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.state, "needs_input");
  });
});

describe("full lifecycle: verify, approve, close round, close", () => {
  test("Whenever round 1 end to end through the CLI", () => {
    const w = world();
    const j = initJob(w, "whenever");
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    assert.equal(settle(w, j, "terminal-7").code, 0);
    let job = j.job();

    const claimed = claimsFromDiff(fixture("whenever-before.csv"), fixture("whenever-after.csv"), WHENEVER_COLS);
    fs.writeFileSync(job.rounds[0].reportPath, reportText(job, 1, { sheet: { cells: claimed } }));
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 0);

    const current = path.join(w.root, "current.csv");
    fs.writeFileSync(current, fixture("whenever-after.csv"));
    const vs = cli(w, ["verify-sheet", "--job", j.dir, "--round", "1", "--current-file", current]);
    assert.equal(vs.code, 0, vs.stderr);
    assert.equal(vs.last.status, "PASS");
    assert.equal(vs.last.changedCells, 17);
    assert.equal(vs.last.claimed, 17);
    assert.equal(vs.last.outstandingDevRows.length, 4);
    assert.deepEqual(vs.last.missing, ["dashboard"]);
    assert.equal(j.job().state, "reported", "dashboard still unverified");

    // approve and close are refused before verification completes
    assert.equal(cli(w, ["approve", "--job", j.dir]).code, 4);
    assert.equal(cli(w, ["close", "--job", j.dir]).code, 4, "close refuses without approval");

    const rec = cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "dashboard", "--status", "PASS", "--note", "1 comment, Stage Feedback"]);
    assert.equal(rec.code, 0);
    assert.equal(rec.last.state, "verified");
    assert.equal(j.job().rounds[0].verification.dashboard.notes[0], "1 comment, Stage Feedback");

    // outstanding Dev rows block approval unless the user accepts them
    const refused = cli(w, ["approve", "--job", j.dir]);
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /4 Dev rows are still outstanding/);
    assert.equal(j.job().state, "verified");
    assert.equal(cli(w, ["approve", "--job", j.dir, "--allow-outstanding"]).code, 0);
    assert.equal(j.job().state, "user-approved");
    assert.equal(cli(w, ["close", "--job", j.dir]).code, 4, "approved but no verified close round");

    // close round: prompt is generated, worker marks Done, Leader verifies the dashboard
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "close"]);
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.round, 2);
    assert.equal(d.last.mode, "followup");
    assert.equal(j.job().state, "dispatched");
    const closePrompt = fs.readFileSync(d.last.promptPath, "utf8");
    assert.ok(closePrompt.includes("User đã duyệt đóng issue 9282") && closePrompt.includes("quickUpdate(<rowNumber>,'Done')"));
    assert.ok(closePrompt.includes(d.last.reportPath));
    assert.equal(settle(w, j, "terminal-7", { runSeq: 2, ompSessionId: "omp-new", lastEventAt: Date.now() + 6000 }).code, 0);
    job = j.job();
    fs.writeFileSync(job.rounds[1].reportPath, reportText(job, 2, { sheet: undefined, dashboard: { commentsAdded: 0, stageBefore: "Feedback", stageAfter: "Done" } }));
    const vr = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(vr.code, 0, vr.stderr);
    assert.deepEqual(j.job().rounds[1].report.required, ["dashboard"]);
    const rec2 = cli(w, ["record", "--job", j.dir, "--round", "2", "--kind", "dashboard", "--status", "PASS", "--note", "Stage Done by id"]);
    assert.equal(rec2.last.state, "user-approved");
    assert.ok(j.job().closeVerifiedAt > 0);
    const closed = cli(w, ["close", "--job", j.dir]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(j.job().state, "closed");
    assert.equal(cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "followup", "--prompt", "x"]).code, 4, "closed jobs take no more rounds");
  });

  test("a FAIL sheet verification keeps the job in reported; UNREADABLE via a missing file", () => {
    const w = world();
    const j = initJob(w, "whenever");
    assert.equal(dispatch(w, j, "terminal-7").code, 0);
    assert.equal(settle(w, j, "terminal-7").code, 0);
    const job = j.job();
    const task = "Rà theme: xác định section và chức năng tận dụng được, phần cần bổ sung";
    fs.writeFileSync(job.rounds[0].reportPath, reportText(job, 1, { sheet: { cells: [{ keyText: task, col: "Ghi chú", expect: "Em đã làm" }] } }));
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 0);

    const same = path.join(w.root, "same.csv");
    fs.writeFileSync(same, fixture("whenever-before.csv"));
    const fail = cli(w, ["verify-sheet", "--job", j.dir, "--current-file", same]);
    assert.equal(fail.code, 1);
    assert.equal(fail.last.status, "FAIL");
    assert.match(fail.last.notes[0], /claimed but unchanged/);

    const unreadable = cli(w, ["verify-sheet", "--job", j.dir, "--current-file", path.join(w.root, "nope.csv")]);
    assert.equal(unreadable.code, 1);
    assert.equal(unreadable.last.status, "UNREADABLE");
    assert.notEqual(j.job().state, "verified");
    assert.equal(cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "dashboard", "--status", "PASS"]).last.state, "reported");
  });

  test("status lists only this Leader's open jobs and says what blocks them", () => {
    const w = world();
    const a = initJob(w, "whenever");
    initJob(w, "seahorse", ["--leader", "terminal-2"]);
    assert.equal(dispatch(w, a, "terminal-7").code, 0);
    const s = cli(w, ["status"]);
    assert.equal(s.code, 0);
    const rows = s.lines.filter((l) => l.job);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "dispatched");
    assert.equal(rows[0].rounds, 1);
    assert.match(rows[0].blocking, /worker terminal-7 running round 1/);
    assert.equal(s.last.jobs, 1);
    const other = cli(w, ["status", "--leader", "terminal-2"]).lines.filter((l) => l.job);
    assert.equal(other.length, 1);
    assert.equal(other[0].state, "open");
    assert.equal(cli(w, ["close", "--job", a.dir, "--force"]).code, 0);
    assert.equal(cli(w, ["status"]).lines.filter((l) => l.job).length, 0, "closed jobs are hidden");
    assert.equal(cli(w, ["status", "--all"]).lines.filter((l) => l.job).length, 1);
  });
});

describe("probes and cli surface", () => {
  test("every probe compiles as one expression, with injected globals and no leading comments", () => {
    const w = world();
    for (const [name, extra] of [
      ["themeId", []],
      ["overflow", []],
      ["element-rect", ["--selector", ".card img", "--limit", "3"]],
      ["dashboard-issue", ["--id", "42"]],
    ]) {
      const r = cli(w, ["probe", "--name", name, ...extra]);
      assert.equal(r.code, 0, `${name}: ${r.stderr}`);
      const expr = r.last.expression;
      assert.ok(!expr.includes("// "), `${name} comment stripped`);
      assert.doesNotThrow(() => new vm.Script(expr), name);
    }
    assert.equal(cli(w, ["probe", "--name", "element-rect"]).code, 2);
    assert.equal(cli(w, ["probe", "--name", "dashboard-issue"]).code, 2);
    assert.equal(cli(w, ["probe", "--name", "nope"]).code, 2);
  });

  test("dashboard-issue finds by stable id, not by row number", async () => {
    const w = world();
    const expr = cli(w, ["probe", "--name", "dashboard-issue", "--id", "77"]).last.expression;
    const originalFeedback = [
      { id: 12, rowNumber: 77, host: "Quốc", shop: "other.shop", stage: "Feedback" },
      { id: 77, rowNumber: 289, host: "Taiz", shop: "seahorse-2.myharavan.com", stage: "Done", deadline: "2026-10-31", tags: "haravan", comments: [{ text: "Em đã fix ạ" }, { text: "Cập nhật lần hai: đã gỡ nút" }] },
    ];
    const ctx = vm.createContext({ window: {}, originalFeedback, setTimeout });
    const out = await vm.runInContext(expr, ctx);
    assert.equal(out.found, true);
    assert.equal(out.host, "Taiz");
    assert.equal(out.rowNumber, 289);
    assert.equal(out.stage, "Done");
    assert.equal(out.commentCount, 2);
    assert.equal(out.lastCommentHead, "Cập nhật lần hai: đã gỡ nút");
    const miss = await vm.runInContext(cli(w, ["probe", "--name", "dashboard-issue", "--id", "5"]).last.expression, ctx);
    assert.deepEqual({ found: miss.found, total: miss.total }, { found: false, total: 2 });
  });

  test("overflow and themeId probes run against a minimal DOM stub", () => {
    const w = world();
    const doc = {
      documentElement: { clientWidth: 375, scrollWidth: 420 },
      body: { scrollWidth: 420 },
      querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 500, height: 10, right: 520 }), tagName: "DIV", id: "wide", className: "x" }],
    };
    const ctx = vm.createContext({ document: doc, innerWidth: 375, getComputedStyle: () => ({ position: "static", visibility: "visible", display: "block" }) });
    const o = vm.runInContext(cli(w, ["probe", "--name", "overflow"]).last.expression, ctx);
    return Promise.resolve(o).then((r) => {
      assert.equal(r.hasHorizontalOverflow, true);
      assert.equal(r.overflowPx, 45);
      assert.equal(r.offenders[0].id, "wide");
      const tctx = vm.createContext({ location: { href: "https://x.test/?themeid=5", search: "?themeid=5" }, Shopify: { theme: { id: 5, name: "Dev", role: "unpublished" } }, URLSearchParams });
      return Promise.resolve(vm.runInContext(cli(w, ["probe", "--name", "themeId"]).last.expression, tctx)).then((t) => {
        assert.equal(t.platform, "shopify");
        assert.equal(t.theme.id, 5);
        assert.equal(t.requested, "5");
      });
    });
  });

  test("--help documents exit codes; unknown commands and missing flags exit 2", () => {
    const w = world();
    const h = cli(w, ["--help"]);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /Exit codes: 0 ok \| 1 check failed/);
    assert.match(h.stdout, /5 worker is waiting for the user/);
    const unk = cli(w, ["frobnicate"]);
    assert.equal(unk.code, 2);
    assert.match(unk.stderr, /unknown command/);
    assert.equal(cli(w, ["wait"]).code, 2);
    assert.equal(cli(w, ["wait", "--job", path.join(w.root, "missing")]).code, 2);
    assert.deepEqual([...parseArgv(["dispatch", "--job=a", "--allow-busy", "--note", "x", "--note", "y"]).flags.entries()], [["job", ["a"]], ["allow-busy", [true]], ["note", ["x", "y"]]]);
  });
});
