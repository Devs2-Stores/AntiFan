// The gaps of the "Worker only works, Leader QAs" model that the Leader listed on 24/11/2026 (owner: "Kaizen toàn bộ các sơ hở").
// Each describe is one gap, G1-G12, driven through the real CLI or the validators, on the data of the real jobs
// epres-371 (sheet before / after round 1 / after round 2, fixtures/leader-qa-gaps) and zesta-369.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { validateReportText } from "../../scripts/leader/report.mjs";
import { scanCliApprovals, certificationOf, dashboardProbeOf, pushedFilesOf } from "../../scripts/leader/qa-gates.mjs";
import { index as shopFolderIndex } from "../../scripts/leader/shop-folder-index.mjs";
import { claimedCells } from "../../scripts/leader/report.mjs";
import { matchClaimRows, parseSheet, verifySheet } from "../../scripts/leader/sheet-diff.mjs";
import { TEMP, cleanup, cliRaw, dispatch, initJob, reportText, settle, world, writeReport } from "./leader-job-cli-helpers.mjs";
import * as vm from "node:vm";

after(cleanup);

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "leader-qa-gaps");
const fixture = (name) => fs.readFileSync(path.join(FIX, name), "utf8");
const COLS = { work: "Mô tả", owner: null, note: "Dev note kết quả", done: "Stage" };
const NOTE = "Dev note kết quả";
const isoAt = (min) => `2026-11-24T10:${String(min).padStart(2, "0")}:00Z`;

let seq = 0;
const tmp = (name) => path.join(TEMP, `${++seq}-${name}`);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** The data rows of a sheet fixture, with each row's raw "Mô tả" text. */
const rowsOf = (csv) => parseSheet(csv, COLS).rows.filter((r) => r.data);

// ---------------------------------------------------------------- a sheet job on the epres data (profile sheet-only: no theme, strict Leader-QA model)

function epresJob(w) {
  const snap = tmp("epres-before.csv");
  fs.writeFileSync(snap, fixture("epres-before.csv"));
  const r = cliRaw(w, ["init", "--slug", "epres-371", "--issue-id", "1795425566160", "--shop", "epres.myharavan.com", "--sheet", "SHEETEPRES", "--snapshot-file", snap, "--profile", "sheet-only"]);
  assert.equal(r.code, 0, r.stderr);
  const dir = r.last.jobDir;
  return { dir, job: () => JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")) };
}

/** Dispatch the next round of an epres job: round 1 is a work round, later ones follow up. */
function epresRound(w, j, worker = "terminal-7") {
  const n = j.job().rounds.length + 1;
  const file = tmp(`epres-prompt-${n}.md`);
  fs.writeFileSync(file, `Việc của vòng ${n}. issue 1795425566160 host Taiz shop epres.myharavan.com sheet SHEETEPRES.\nGhi report vào {{REPORT_PATH}}\n`);
  const d = cliRaw(w, ["dispatch", "--job", j.dir, "--worker", worker, "--prompt", file, "--kind", n === 1 ? "work" : "followup"]);
  assert.equal(d.code, 0, d.stderr);
  assert.equal(settle(w, j, worker, n).code, 0);
}

const claim = (row, col, keyText = row.cells["Mô tả"]) => ({ keyText, col, expect: row.cells[col] });
/** The report's sheet.cells in the shape verify-sheet takes ({key, col, expect}). */
const keyed = (cells) => claimedCells({ sheet: { cells } });

/** The round-1 claims of the real report: the whole cell, a mid-cell fragment and a prefix (what the worker really wrote). */
function r1Claims(after) {
  const [rm, , story, usage] = rowsOf(after);
  return [
    claim(rm, "Stage"),
    claim(rm, NOTE),
    claim(story, "Stage", "chuyển cả trang"),
    claim(story, NOTE, "chuyển cả trang"),
    claim(usage, "Stage", "anh đẩy mục cách sử dụng của tất cả sp lên vị trí 1"),
    claim(usage, NOTE, "anh đẩy mục cách sử dụng của tất cả sp lên vị trí 1"),
  ];
}

const sheetReport = (j, n, cells, over = {}) => {
  const job = j.job();
  return reportText(job, n, {
    dashboard: undefined,
    guard: { issueId: job.subject.issueId, host: job.subject.host, shop: job.subject.shop, sheetId: job.subject.sheetId, checkedAt: isoAt(1) },
    sheet: { writtenAt: isoAt(5), cells },
    ...over,
  });
};

function writeSheetReport(j, n, cells, over) {
  fs.writeFileSync(j.job().rounds[n - 1].reportPath, sheetReport(j, n, cells, over));
}

const validate = (w, j, n) => cliRaw(w, ["validate-report", "--job", j.dir, "--round", String(n)]);
const verifyWith = (w, j, n, csvName) => {
  const file = tmp(csvName);
  fs.writeFileSync(file, fixture(csvName));
  return cliRaw(w, ["verify-sheet", "--job", j.dir, "--round", String(n), "--current-file", file]);
};

// ================================================================ G3 verify-sheet

describe("G3 verify-sheet: keyText matching, carried cells, and the verified gate", () => {
  test("keyText matches the whole cell, then a prefix, then ONE unique substring; several rows are ambiguous", () => {
    const rows = parseSheet(fixture("epres-before.csv"), COLS).rows;
    assert.equal(matchClaimRows(rows, rowsOf(fixture("epres-before.csv"))[0].cells["Mô tả"]).tier, "exact");
    assert.equal(matchClaimRows(rows, "anh đẩy mục cách sử dụng của tất cả sp lên vị trí 1").tier, "prefix");
    const mid = matchClaimRows(rows, "chuyển cả trang");
    assert.deepEqual([mid.tier, mid.rows.length], ["substring", 1]);
    assert.equal(matchClaimRows(rows, "chuyển cả trang").rows[0].key.startsWith("https://epres.myharavan.com/pages/our-story"), true);
    // "https://epres.myharavan.com/pages/our-" starts two different rows (our-innovation, our-story)
    const shared = matchClaimRows(rows, "https://epres.myharavan.com/pages/our-");
    assert.equal(shared.rows.length, 2);
    const v = verifySheet({ beforeText: fixture("epres-before.csv"), afterText: fixture("epres-after-r1.csv"), cols: COLS, claimed: [{ key: "https://epres.myharavan.com/pages/our-", col: "Stage", expect: "Fixed" }] });
    assert.equal(v.status, "FAIL");
    assert.match(v.notes.join("\n"), /ambiguous \(prefix match of 2 different rows/);
    // whitespace and line breaks are normalised: the raw cell with "\n\n" and a trailing space is the same key
    const raw = rowsOf(fixture("epres-before.csv"))[1].cells["Mô tả"];
    assert.ok(raw.includes("\n\n"));
    assert.equal(matchClaimRows(rows, raw).tier, "exact");
  });

  test("round 1 of epres-371: claims by fragment and prefix pass (they FAILED on the whole-cell rule)", () => {
    const after = fixture("epres-after-r1.csv");
    const v = verifySheet({ beforeText: fixture("epres-before.csv"), afterText: after, cols: COLS, claimed: keyed(r1Claims(after)) });
    assert.equal(v.status, "PASS", v.notes.join("\n"));
    assert.equal(v.foreign.length, 0);
    assert.equal(v.claimedCount, 6);
  });

  test("round 2 of epres-371: the cells round 1 wrote are carried, not 'claimed but unchanged'", () => {
    const after2 = fixture("epres-after-r2.csv");
    const claims = rowsOf(after2).flatMap((r) => [claim(r, "Stage"), claim(r, NOTE)]);
    assert.equal(claims.length, 8);
    const common = { beforeText: fixture("epres-after-r1.csv"), afterText: after2, cols: COLS, claimed: keyed(claims) };
    // without the original snapshot the old verdict stands: six cells look unchanged
    const old = verifySheet(common);
    assert.equal(old.status, "FAIL");
    assert.equal(old.notes.filter((n) => /claimed but unchanged/.test(n)).length, 6);
    const v = verifySheet({ ...common, originalText: fixture("epres-before.csv") });
    assert.equal(v.status, "PASS", v.notes.join("\n"));
    assert.equal(v.carriedCount, 6);
    assert.equal(v.changedCells.length, 2, "only row 3 changed in round 2");
  });

  test("a carried claim whose text is not what the sheet holds still fails, and a cell never written by anyone is 'unchanged'", () => {
    const after2 = fixture("epres-after-r2.csv");
    const [first] = rowsOf(after2);
    const wrong = verifySheet({ beforeText: fixture("epres-after-r1.csv"), afterText: after2, cols: COLS, originalText: fixture("epres-before.csv"), claimed: keyed([{ ...claim(first, NOTE), expect: "Em đã fix ạ: bản khác" }]) });
    assert.equal(wrong.status, "FAIL");
    // the same claim against round 1 -> round 2 without any earlier write: nothing changed, so the claim is false
    const none = verifySheet({ beforeText: fixture("epres-before.csv"), afterText: fixture("epres-before.csv"), cols: COLS, originalText: fixture("epres-before.csv"), claimed: keyed([claim(rowsOf(fixture("epres-before.csv"))[0], "Stage")]) });
    assert.equal(none.status, "FAIL");
  });

  test("CLI: round 1 then round 2 verify, and a FAIL cannot be recorded PASS without --override-reason", () => {
    const w = world();
    const j = epresJob(w);
    epresRound(w, j);
    writeSheetReport(j, 1, r1Claims(fixture("epres-after-r1.csv")));
    assert.equal(validate(w, j, 1).code, 0);
    const v1 = verifyWith(w, j, 1, "epres-after-r1.csv");
    assert.equal(v1.code, 0, v1.stderr);
    assert.equal(v1.last.status, "PASS");
    assert.equal(v1.last.state, "verified", "verify-sheet is the check a sheet-only job needs");

    epresRound(w, j);
    const after2 = fixture("epres-after-r2.csv");
    writeSheetReport(j, 2, rowsOf(after2).flatMap((r) => [claim(r, "Stage"), claim(r, NOTE)]));
    assert.equal(validate(w, j, 2).code, 0, "valid report");
    const v2 = verifyWith(w, j, 2, "epres-after-r2.csv");
    assert.equal(v2.code, 0, v2.stderr);
    assert.equal(v2.last.status, "PASS");
    assert.equal(v2.last.carried, 6);
  });

  test("a FAIL verify-sheet blocks 'verified'; record --kind sheet PASS needs the override reason, which is stored and printed", () => {
    const w = world();
    const j = epresJob(w);
    epresRound(w, j);
    const claims = r1Claims(fixture("epres-after-r1.csv"));
    claims[1] = { ...claims[1], expect: "Em đã fix ạ: nội dung khác với ô thật" };
    writeSheetReport(j, 1, claims);
    assert.equal(validate(w, j, 1).code, 0);
    const bad = verifyWith(w, j, 1, "epres-after-r1.csv");
    assert.equal(bad.code, 1);
    assert.equal(bad.last.status, "FAIL");
    assert.notEqual(j.job().state, "verified");

    const typed = cliRaw(w, ["record", "--job", j.dir, "--round", "1", "--kind", "sheet", "--status", "PASS", "--note", "đọc tay thấy đúng"]);
    assert.equal(typed.code, 4);
    assert.match(typed.stderr, /latest verify-sheet of round 1 is FAIL/);
    assert.match(typed.stderr, /--override-reason/);
    assert.notEqual(j.job().state, "verified");

    const forced = cliRaw(w, ["record", "--job", j.dir, "--round", "1", "--kind", "sheet", "--status", "WARN", "--override-reason", "ô dev note đã đọc tay đúng; lệch chỉ do keyText"]);
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.last.override.verifySheetStatus, "FAIL");
    assert.equal(j.job().state, "verified");
    assert.match(j.job().rounds[0].verification.sheet.override.reason, /đọc tay đúng/);

    const status = cliRaw(w, ["status", "--job", j.dir]);
    assert.equal(status.lines[0].overrides[0].kind, "sheet");
    assert.match(status.lines[0].blocking, /OVERRIDE sheet r1: ô dev note/);
    const needs = cliRaw(w, ["needs-me", "--text"]);
    assert.match(needs.stdout, /OVERRIDE sheet r1/);
  });

  test("record --kind sheet without any verify-sheet is refused; after a passing verify-sheet it keeps verify-sheet's own verdict", () => {
    const w = world();
    const j = epresJob(w);
    epresRound(w, j);
    writeSheetReport(j, 1, r1Claims(fixture("epres-after-r1.csv")));
    assert.equal(validate(w, j, 1).code, 0);
    const early = cliRaw(w, ["record", "--job", j.dir, "--round", "1", "--kind", "sheet", "--status", "PASS"]);
    assert.equal(early.code, 4);
    assert.match(early.stderr, /verify-sheet has not run for round 1/);
    assert.equal(verifyWith(w, j, 1, "epres-after-r1.csv").code, 0);
    const again = cliRaw(w, ["record", "--job", j.dir, "--round", "1", "--kind", "sheet", "--status", "PASS"]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.last.override, undefined);
    assert.equal(j.job().rounds[0].verification.sheet.from, "verify-sheet");
  });
});

// ================================================================ G1 + G2 evidence

describe("G1/G2 record needs evidence; the dashboard probe really reads comments", () => {
  /** A no-sheet job whose round shipped files, validated and ready for the Leader's own checks. */
  function shipped(w) {
    const j = initJob(w, "ship");
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    assert.equal(settle(w, j, "terminal-7", 1).code, 0);
    writeReport(j, 1, { files: ["snippets/a.liquid"], dashboard: { commentsAdded: 0, stageBefore: "Feedback", stageAfter: "Feedback" } });
    const v = validate(w, j, 1);
    assert.equal(v.code, 0, v.stderr);
    return j;
  }
  const evidence = (name, body, ageMs = 0) => {
    const f = tmp(name);
    fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
    if (ageMs) fs.utimesSync(f, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
    return f;
  };
  const rec = (w, j, kind, status, files = [], extra = []) => cliRaw(w, ["record", "--job", j.dir, "--round", "1", "--kind", kind, "--status", status, ...files.flatMap((f) => ["--evidence", f]), ...extra]);
  const PROBE_OK = { ok: true, value: { found: true, id: "1", commentsSource: "getComments", commentCount: 1, stage: "Feedback" } };
  const PROBE_NONE = { ok: true, value: { found: true, id: "1", commentCount: null, commentsSource: "none-found" } };
  const QA = (cert) => ({ ok: true, summary: { verdict: "PASS", certification: cert } });

  test("G1: PASS|WARN of storefront and dashboard without --evidence is refused (exit 4)", () => {
    const w = world();
    const j = shipped(w);
    for (const [kind, status] of [["storefront", "PASS"], ["storefront", "WARN"], ["dashboard", "PASS"], ["dashboard", "WARN"]]) {
      const r = rec(w, j, kind, status);
      assert.equal(r.code, 4, `${kind} ${status}`);
      assert.match(r.stderr, /needs --evidence/);
    }
    assert.notEqual(j.job().state, "verified");
    // FAIL and UNREADABLE are never self-flattering, so they need no file
    assert.equal(rec(w, j, "storefront", "FAIL").code, 1);
    assert.equal(rec(w, j, "dashboard", "UNREADABLE").code, 1);
  });

  test("G1: evidence must exist and be written AFTER the round was dispatched; path and sha256 are stored", () => {
    const w = world();
    const j = shipped(w);
    const missing = rec(w, j, "storefront", "WARN", [path.join(TEMP, "does-not-exist.json")]);
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /does not exist/);
    const stale = rec(w, j, "storefront", "WARN", [evidence("stale.json", QA("CERTIFIED"), 3_600_000)]);
    assert.equal(stale.code, 4);
    assert.match(stale.stderr, /not after the round was dispatched/);
    const file = evidence("fresh.json", QA("STRUCTURAL"));
    const ok = rec(w, j, "storefront", "WARN", [file]);
    assert.equal(ok.code, 0, ok.stderr);
    const stored = j.job().rounds[0].verification.storefront.evidence[0];
    assert.equal(stored.sha256, sha(fs.readFileSync(file)));
    assert.equal(stored.path, file.replace(/\\/g, "/"));
  });

  test("G1: a theme job that shipped files records storefront PASS only with a CERTIFIED qa_validate receipt", () => {
    const w = world();
    const j = shipped(w);
    const structural = evidence("structural.json", QA("STRUCTURAL"));
    const noReceipt = evidence("responsive.json", { ok: true, value: { overflow: false } });
    for (const f of [structural, noReceipt]) {
      const r = rec(w, j, "storefront", "PASS", [f]);
      assert.equal(r.code, 4);
      assert.match(r.stderr, /CERTIFIED\*/);
      assert.match(r.stderr, /most you may record is WARN/);
    }
    const certified = rec(w, j, "storefront", "PASS", [evidence("certified.json", { ok: true, value: QA("CERTIFIED_WITH_NOTES") })]);
    assert.equal(certified.code, 0, certified.stderr);
    assert.equal(certified.last.status, "PASS");
  });

  test("G2: a dashboard probe that read no comments (commentsSource none-found) cannot back PASS or WARN", () => {
    const w = world();
    const j = shipped(w);
    const none = evidence("probe-none.json", PROBE_NONE);
    for (const status of ["PASS", "WARN"]) {
      const r = rec(w, j, "dashboard", status, [none]);
      assert.equal(r.code, 4, status);
      assert.match(r.stderr, /read NO comments/);
    }
    const notAProbe = rec(w, j, "dashboard", "PASS", [evidence("other.json", { ok: true, value: { stage: "Feedback" } })]);
    assert.equal(notAProbe.code, 4);
    assert.match(notAProbe.stderr, /output of `probe --name dashboard-issue`/);
    assert.equal(rec(w, j, "dashboard", "UNREADABLE", [none]).code, 1, "UNREADABLE is the honest status");
    const good = rec(w, j, "dashboard", "PASS", [evidence("probe-ok.json", PROBE_OK)]);
    assert.equal(good.code, 0, good.stderr);
  });

  test("G2: the probe reads comments through the dashboard's own getComments call (list rows carry none)", async () => {
    const w = world();
    const expr = cliRaw(w, ["probe", "--name", "dashboard-issue", "--id", "1795425566160"]).last.expression;
    const originalFeedback = [{ id: "1795425566160", rowNumber: 371, host: "Taiz", shop: "epres.myharavan.com", stage: "Feedback", devNote: "" }];
    const calls = [];
    const apiPost = async (action, data) => {
      calls.push([action, data]);
      return { success: true, comments: [{ text: "Em đã fix ạ", time: "t1", author: "a" }, { text: "Cập nhật lần hai", time: "t2", author: "b" }] };
    };
    const out = await vm.runInContext(expr, vm.createContext({ window: {}, originalFeedback, apiPost, setTimeout }));
    assert.equal(JSON.stringify(calls), JSON.stringify([["getComments", { rowNumber: 371 }]]));
    assert.equal(out.commentsSource, "getComments");
    assert.equal(out.commentCount, 2);
    assert.equal(out.lastCommentHead, "Cập nhật lần hai");
    assert.equal(out.lastCommentAuthor, "b");
    // an API that fails leaves "none-found", which record refuses
    const failing = await vm.runInContext(expr, vm.createContext({ window: {}, originalFeedback, apiPost: async () => ({ success: false }), setTimeout }));
    assert.equal(failing.commentsSource, "none-found");
    assert.equal(failing.commentCount, null);
    const thrown = await vm.runInContext(expr, vm.createContext({ window: {}, originalFeedback, apiPost: async () => { throw new Error("401"); }, setTimeout }));
    assert.equal(thrown.commentsSource, "none-found");
    // the helpers record uses see the same shapes
    assert.equal(dashboardProbeOf({ ok: true, value: out }).commentsSource, "getComments");
    assert.equal(certificationOf({ value: { summary: { certification: "CERTIFIED" } } }), "CERTIFIED");
  });
});

// ================================================================ G4 + G5 + G9 + G12 report validators

describe("G4/G5/G9/G12 report checks", () => {
  const JOB = { job: "j-1", slug: "j", leaderQa: 1, shipGates: 1, profile: "haravan", subject: { kind: "feedback", issueId: "1", host: "Taiz", shop: "epres.myharavan.com", sheetId: "S" } };
  const guard = (over = {}) => ({ issueId: "1", host: "Taiz", shop: "epres.myharavan.com", sheetId: "S", ...over });
  const handover = (over = {}) => ({ checks: [{ url: "https://epres.myharavan.com/?themeid=1", viewport: "375x812", selector: ".x", expect: "ok" }], risks: [], ...over });
  const smoke = { probe: "smoke", url: "u", viewport: "375x812", selector: ".x", value: "HTTP 200" };
  const run = (over, ctx = {}, job = JOB) => validateReportText(reportText({ ...job, subject: job.subject }, 1, { dashboard: { commentsAdded: 0, stageBefore: "Feedback", stageAfter: "Feedback" }, guard: guard(), ...over }), job, 1, { kind: "work", ...ctx });

  /** A backup folder with a manifest listing `entries`, each {path, content, sha?}. */
  function backupDir(entries, manifestOver = {}) {
    const dir = tmp("backup");
    fs.mkdirSync(dir, { recursive: true });
    const files = entries.map((e) => {
      const rel = `r1/${e.path}`;
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), e.content);
      return { path: e.path, backup: rel, sha256: e.sha ?? sha(e.content), source: "remote-fetch" };
    });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schema: "leader-backup/1", files, ...manifestOver }));
    return dir;
  }

  const R2 = {
    files: ["snippets/ep-inn-chem.liquid", "assets/ep-innovation.css"],
    pushed: ["theme 1001522351: hrv theme push --only snippets/ep-inn-chem.liquid assets/ep-innovation.css --nodelete", "theme 1001522351: hrv theme push --only assets/ep-innovation.css --nodelete"],
  };

  test("G4: pushed files are read from `--only` lists, a whole-theme push means every listed file", () => {
    assert.deepEqual(pushedFilesOf(R2).sort(), ["assets/ep-innovation.css", "snippets/ep-inn-chem.liquid"]);
    assert.deepEqual(pushedFilesOf({ files: ["a.liquid", "b.css"], pushed: ["hrv theme push --nodelete --ignore config/settings_data.json"] }).sort(), ["a.liquid", "b.css"]);
    assert.deepEqual(pushedFilesOf({ files: [], pushed: [] }), []);
  });

  test("G4: DONE with a push is refused unless every pushed file has a verified pre-change copy (epres r2 had none)", () => {
    const smokes = { storefront: { measurements: [smoke, smoke] } };
    // the real r2 report named a backup folder with no manifest
    const none = tmp("empty-backup");
    fs.mkdirSync(none);
    const noManifest = run({ ...R2, ...smokes, handover: handover({ backup: none }) });
    assert.match(noManifest.errors.join("\n"), /no readable manifest/);
    const absent = run({ ...R2, ...smokes, handover: handover() });
    assert.match(absent.errors.join("\n"), /handover\.backup is missing: 2 pushed file/);

    const css = "body{}";
    const liquid = "<div></div>";
    const good = backupDir([{ path: "assets/ep-innovation.css", content: css }, { path: "snippets/ep-inn-chem.liquid", content: liquid }]);
    const ok = run({ ...R2, ...smokes, handover: handover({ backup: good }) });
    assert.deepEqual(ok.errors, []);

    const partial = backupDir([{ path: "assets/ep-innovation.css", content: css }]);
    assert.match(run({ ...R2, ...smokes, handover: handover({ backup: partial }) }).errors.join("\n"), /pushed file snippets\/ep-inn-chem\.liquid has no entry in the backup manifest/);

    const forged = backupDir([{ path: "assets/ep-innovation.css", content: css }, { path: "snippets/ep-inn-chem.liquid", content: liquid, sha: "0".repeat(64) }]);
    assert.match(run({ ...R2, ...smokes, handover: handover({ backup: forged }) }).errors.join("\n"), /does not match the manifest sha256/);

    // a file that did not exist before the change is declared, not backed up
    const created = run({ files: ["snippets/new.liquid"], pushed: ["hrv theme push --only snippets/new.liquid --nodelete"], ...smokes, handover: handover({ backup: none, newFiles: ["snippets/new.liquid"] }) });
    assert.deepEqual(created.errors, []);
  });

  test("G4: a job started before the Leader-QA model only gets a warning", () => {
    const old = { ...JOB, shipGates: undefined };
    const r = run({ ...R2, handover: handover() }, {}, old);
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings.join("\n"), /handover\.backup is missing/);
  });

  test("G5: on a live theme every push needs its own smoke and the report must say whether a rollback ran", () => {
    const backup = backupDir([{ path: "assets/ep-innovation.css", content: "x" }, { path: "snippets/ep-inn-chem.liquid", content: "y" }]);
    const base = { ...R2, handover: handover({ backup }) };
    const live = { liveTheme: true };
    const one = run({ ...base, storefront: { measurements: [smoke] }, rollback: { ran: false } }, live);
    assert.match(one.errors.join("\n"), /2 push command\(s\) listed but only 1 storefront\.measurements/);
    const silent = run({ ...base, storefront: { measurements: [smoke, smoke] } }, live);
    assert.match(silent.errors.join("\n"), /whether a rollback ran/);
    const ok = run({ ...base, storefront: { measurements: [smoke, smoke] }, rollback: { ran: false, note: "mọi smoke sạch" } }, live);
    assert.deepEqual(ok.errors, []);
    // the same report on a non-live theme owes neither
    assert.deepEqual(run({ ...base, storefront: { measurements: [smoke] } }, { liveTheme: false }).errors, []);
    assert.match(run({ ...base, storefront: { measurements: [smoke, smoke] }, rollback: { ran: "no" } }, live).errors.join("\n"), /rollback must be/);
  });

  test("G9: a task that mentions a sample image warns when handover.reference is empty; a listed reference silences it", () => {
    const refPath = tmp("sample.png");
    fs.writeFileSync(refPath, "png");
    const need = { referenceNeeded: true };
    const missing = run({ handover: handover() }, need);
    assert.match(missing.warnings.join("\n"), /handover\.reference is empty/);
    assert.deepEqual(missing.errors, [], "a warning, never a refusal");
    const listed = run({ handover: handover({ reference: [{ sheetKey: "https://epres.myharavan.com/pages/our-innovation", path: refPath, url: "https://docs.google.com/x", selector: ".ep-inn-chem" }] }) }, need);
    assert.deepEqual([listed.errors, listed.warnings.filter((w) => /reference/.test(w))], [[], []]);
    assert.match(run({ handover: handover({ reference: [{ path: refPath }] }) }, need).errors.join("\n"), /handover\.reference\[0\] must be/);
    assert.deepEqual(run({ handover: handover() }, {}).warnings.filter((w) => /reference/.test(w)), []);
  });

  test("G9: lint-report --job warns on the epres job because its sheet row says 'ảnh mẫu'", () => {
    const w = world();
    const j = epresJob(w);
    epresRound(w, j);
    const cells = r1Claims(fixture("epres-after-r1.csv"));
    const report = tmp("lint.report.md");
    // sheet-only has no handover, so make the job a theme job for this lint
    const jobFile = path.join(j.dir, "job.json");
    const job = j.job();
    job.profile = "haravan";
    fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
    fs.writeFileSync(report, sheetReport(j, 1, cells, { handover: handover() }));
    const r = cliRaw(w, ["lint-report", "--file", report, "--job", j.dir, "--round", "1"]);
    assert.match((r.last.warnings ?? []).join("\n"), /handover\.reference is empty/);
  });

  test("G12: the dashboard guard must be checked BEFORE the sheet is written, and both times must be reported", () => {
    const cells = [{ keyText: "k", col: NOTE, expect: "x" }];
    const withTimes = (checkedAt, writtenAt) => run({ guard: guard(checkedAt ? { checkedAt } : {}), sheet: { cells, ...(writtenAt ? { writtenAt } : {}) }, handover: handover({ backup: "x" }) }, {}, { ...JOB, profile: "sheet-only" });
    assert.deepEqual(withTimes(isoAt(1), isoAt(5)).errors, []);
    assert.match(withTimes(isoAt(9), isoAt(5)).errors.join("\n"), /guard\.checkedAt .* is later than sheet\.writtenAt/);
    assert.match(withTimes(undefined, isoAt(5)).errors.join("\n"), /guard\.checkedAt .* is missing/);
    assert.match(withTimes(isoAt(1), undefined).errors.join("\n"), /sheet\.writtenAt .* is missing/);
    assert.match(withTimes("yesterday", isoAt(5)).errors.join("\n"), /guard\.checkedAt must be an ISO time/);
    const old = run({ guard: guard(), sheet: { cells }, handover: handover() }, {}, { ...JOB, shipGates: undefined, profile: "sheet-only" });
    assert.deepEqual(old.errors, []);
    assert.match(old.warnings.join("\n"), /guard\.checkedAt .* is missing/);
    // zesta-369 round 1 wrote the sheet first and ran the guard after
    assert.match(withTimes("2026-11-24T10:20:00Z", "2026-11-24T10:04:00Z").errors.join("\n"), /BEFORE the dashboard guard ran/);
  });

  test("G12: an unpublished theme without devSplit (or a reason) is warned about; the role comes from the report or the dispatch probe", () => {
    const backup = backupDir([{ path: "a.liquid", content: "a" }]);
    const base = { files: ["a.liquid"], pushed: ["hrv theme push --only a.liquid --nodelete"], storefront: { measurements: [smoke] }, handover: handover({ backup }) };
    assert.match(run({ ...base, themeRole: "unpublished" }).warnings.join("\n"), /theme role is unpublished.*devSplit/);
    assert.match(run(base, { themeRole: "unpublished" }).warnings.join("\n"), /devSplit/, "role known from the dispatch probe");
    assert.deepEqual(run({ ...base, themeRole: "unpublished", devSplit: { opened: true } }).warnings.filter((x) => /devSplit/.test(x)), []);
    assert.deepEqual(run({ ...base, themeRole: "unpublished", devSplit: { opened: false, reason: "dev không sync sau 30s" } }).warnings.filter((x) => /devSplit/.test(x)), []);
    assert.match(run({ ...base, themeRole: "unpublished", devSplit: { opened: false } }).warnings.join("\n"), /devSplit/);
    assert.deepEqual(run({ ...base, themeRole: "main" }).warnings.filter((x) => /devSplit/.test(x)), []);
  });
});

// ================================================================ G6 CLI commands in follow-ups and answers

describe("G6 a Leader may not approve a CLI command outside AGENTS.md section 8", () => {
  const ZESTA_ANSWER = [
    "Trả lời của user Tài: chọn phương án login. user xác nhận ĐÃ chạy xong `hrv login`.",
    "1. cwd E:/Work/customizes/Zesta: `hrv theme info --json` phải thành công với 1001507674.",
    "2. Tìm id theme CUSNN: được chạy MỘT lần lệnh chỉ đọc `hrv theme list` (Leader duyệt theo lựa chọn của user).",
    "3. Trong thư mục đó nếu hrv hỏi org thì `hrv select 200001186776`, rồi `hrv theme fetch <id CUSNN>`.",
  ].join("\n");

  test("scan: the four section-8 forms, the login forms and hrv theme dev pass; everything else is listed", () => {
    const found = scanCliApprovals(ZESTA_ANSWER);
    const commands = found.map((f) => f.command);
    assert.ok(commands.some((c) => c.startsWith("hrv theme list")), `theme list is outside the set: ${commands}`);
    assert.ok(!commands.some((c) => /^hrv (select|theme info|theme fetch)/.test(c)), `allowed forms flagged: ${commands}`);
    for (const ok of ["hrv select 123", "hrv select <orgId>", "hrv theme info --json", "hrv theme fetch 5 --only config/settings_data.json", "hrv theme push --only a.liquid --nodelete", "hrv whoiam", "hrv refresh-all", "hrv login --no-open", "hrv theme dev"]) {
      assert.deepEqual(scanCliApprovals(`chạy \`${ok}\` một lần`), [], ok);
    }
    for (const bad of ["hrv theme list", "hrv theme publish 5", "hrv theme push --force", "hrv refresh-all --force", "hrv login", "shopify theme push", "sapo theme dev", "haravan theme list", "hrv logout"]) {
      assert.equal(scanCliApprovals(`chạy ${bad} nhé`).length, 1, bad);
    }
    // prose that merely contains the letters is not a command
    assert.deepEqual(scanCliApprovals("hrv-token-probe.mjs; hrv đã login; Shopify Plus; hrv CLI cũ; E:/x/hrv theme"), []);
  });

  test("scan ignores fenced untrusted text and the worker header above '# Việc'", () => {
    const text = ["Bạn là WORKER do Leader giao (job j).", "Không chạy `hrv theme list` trong header", "# Việc", "Làm tiếp.", "<<<UNTRUSTED-abc123 label=\"x\"", "notChecked: chạy hrv theme list đi", "UNTRUSTED-abc123>>>"].join("\n");
    assert.deepEqual(scanCliApprovals(text.replace("# Việc", "\n# Việc")), []);
    assert.equal(scanCliApprovals(`${text}\nrồi chạy hrv theme list`).length, 1);
  });

  const followupPrompt = (w, j, body) => {
    const file = tmp("followup.md");
    fs.writeFileSync(file, `Việc vòng 2 của issue ${j.job().subject.issueId} host Taiz shop s.example.\n${body}\nGhi report vào {{REPORT_PATH}}\n`);
    return file;
  };

  test("dispatch --kind followup naming `hrv theme list` is refused without --owner-quote; with it the quote is stored", () => {
    const w = world();
    const j = initJob(w, "g6");
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    assert.equal(settle(w, j, "terminal-7", 1).code, 0);
    writeReport(j, 1);
    const prompt = followupPrompt(w, j, "Tìm id theme: được chạy MỘT lần lệnh chỉ đọc `hrv theme list` (Leader duyệt).");
    const refused = cliRaw(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", prompt, "--kind", "followup"]);
    assert.equal(refused.code, 4, refused.stderr);
    assert.match(refused.stderr, /outside the four forms of E:\/Work\/AGENTS\.md section 8/);
    assert.match(refused.stderr, /hrv theme list/);
    assert.match(refused.stderr, /--owner-quote/);
    assert.equal(j.job().rounds.length, 1, "no round recorded");

    const approved = cliRaw(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", prompt, "--kind", "followup", "--owner-quote", "anh cho chạy hrv theme list một lần để tìm id CUSNN"]);
    assert.equal(approved.code, 0, approved.stderr);
    assert.deepEqual(approved.last.ownerApproval.commands, ["hrv theme list"]);
    const stored = j.job().approvals[0];
    assert.equal(stored.quote, "anh cho chạy hrv theme list một lần để tìm id CUSNN");
    assert.equal(stored.via, "dispatch");
    assert.equal(stored.round, 2);
    assert.equal(cliRaw(w, ["status", "--job", j.dir]).lines[0].ownerApprovals[0].quote, stored.quote);
  });

  test("a followup that names only approved forms goes through without a quote", () => {
    const w = world();
    const j = initJob(w, "g6ok");
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    assert.equal(settle(w, j, "terminal-7", 1).code, 0);
    writeReport(j, 1);
    const prompt = followupPrompt(w, j, "Chạy lại `hrv theme info --json` rồi push `hrv theme push --only a.liquid --nodelete`.");
    assert.equal(cliRaw(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", prompt, "--kind", "followup"]).code, 0);
    assert.equal(j.job().approvals, undefined);
  });

  test("answer: the same scan on --text, refused without --owner-quote, stored with it", () => {
    const w = world();
    const j = initJob(w, "g6a");
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    assert.equal(settle(w, j, "terminal-7", 1).code, 0);
    writeReport(j, 1, { status: "NEEDS_INPUT", needsInput: { question: "Tìm theme thế nào?", options: ["Cách 1", "Cách 2"] } });
    assert.equal(validate(w, j, 1).code, 0);
    const refused = cliRaw(w, ["answer", "--job", j.dir, "--text", "cứ chạy `hrv theme list` để tìm"]);
    assert.equal(refused.code, 4, refused.stderr);
    assert.match(refused.stderr, /the answer names a CLI command outside/);
    assert.equal(j.job().state, "needs_input", "nothing changed");
    const ok = cliRaw(w, ["answer", "--job", j.dir, "--text", "cứ chạy `hrv theme list` để tìm", "--owner-quote", "Tài: được chạy hrv theme list"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(j.job().approvals[0].via, "answer");
    assert.equal(cliRaw(w, ["answer", "--job", j.dir, "--text", "x"]).code, 4, "state is dispatched now");
  });

  test("answer: --choice is the worker's own option text and is not scanned (only --text is the Leader's words)", () => {
    const w = world();
    const j = initJob(w, "g6b");
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    assert.equal(settle(w, j, "terminal-7", 1).code, 0);
    const option = "User hrv login org 200001186776 và cho biết id theme CUSNN";
    writeReport(j, 1, { status: "NEEDS_INPUT", needsInput: { question: "Tìm theme thế nào?", options: [option, "Cách 2"] } });
    assert.equal(validate(w, j, 1).code, 0);
    const r = cliRaw(w, ["answer", "--job", j.dir, "--text", "chọn phương án 1", "--choice", option]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(j.job().approvals, undefined);
  });

  test("scan: Vietnamese prose that starts with 'hrv' (hrv sau khi, hrv cli ghi nhận) is not a command", () => {
    assert.deepEqual(scanCliApprovals("Làm theo hrv sau khi login. hrv cli ghi nhận themeid nào thì push đúng id đó."), []);
    assert.equal(scanCliApprovals("chạy `hrv theme list` đi").length, 1);
  });
});

// ================================================================ G7 token probe skip

describe("G7 --skip-token-probe needs a reason and cannot hide a dead token", () => {
  let n = 0;
  const probe = (exitCode, body) => {
    const file = tmp(`probe-${++n}.mjs`);
    fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(JSON.stringify(body))});\nprocess.exit(${exitCode});\n`);
    return file;
  };
  const DEAD = () => probe(1, { ok: false, themeId: "5", orgId: "9", error: "Token hết hạn" });
  const themeFolder = (w) => {
    const dir = path.join(w.root, `theme-${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".haravan-cli_local.json"), JSON.stringify({ org_id: 9, theme_id: 5 }));
    return dir;
  };
  const attempt = (w, j, extra, env) => {
    const round = j.job().rounds.length + 1;
    const file = tmp("probe-prompt.md");
    fs.writeFileSync(file, `Việc của vòng ${round}. issue ${j.job().subject.issueId} host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n`);
    return cliRaw(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file, ...extra], env);
  };

  test("--skip-token-probe without --reason is a usage error and records no round", () => {
    const w = world();
    const j = initJob(w, "g7");
    const r = attempt(w, j, ["--cwd", themeFolder(w), "--skip-token-probe"], { LEADER_TOKEN_PROBE: DEAD() });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--skip-token-probe needs --reason/);
    assert.equal(j.job().rounds.length, 0);
  });

  test("the reason is stored on the round and printed by status; no seen-dead token, so no read-only block", () => {
    const w = world();
    const j = initJob(w, "g7b");
    const r = attempt(w, j, ["--cwd", themeFolder(w), "--skip-token-probe", "--reason", "owner vừa login"], { LEADER_TOKEN_PROBE: DEAD() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.skipTokenProbe.reason, "owner vừa login");
    assert.equal(j.job().rounds[0].skipTokenProbe.reason, "owner vừa login");
    assert.ok(!fs.readFileSync(j.job().rounds[0].promptPath, "utf8").includes("CHỈ ĐỌC"));
    assert.equal(cliRaw(w, ["status", "--job", j.dir]).lines[0].tokenProbeSkips[0].reason, "owner vừa login");
  });

  test("after a probe that SAW the token dead, a skipped round's prompt gets the READ-ONLY block that still allows the four login lines", () => {
    const w = world();
    const j = initJob(w, "g7c");
    const theme = themeFolder(w);
    const dead = attempt(w, j, ["--cwd", theme], { LEADER_TOKEN_PROBE: DEAD() });
    assert.equal(dead.code, 0, dead.stderr);
    assert.match(j.job().tokenProbeFatal.error, /Token hết hạn/);
    const skipped = attempt(w, j, ["--skip-token-probe", "--reason", "cần đọc trang trước khi owner login"], { LEADER_TOKEN_PROBE: DEAD() });
    assert.equal(skipped.code, 0, skipped.stderr);
    const prompt = fs.readFileSync(j.job().rounds[1].promptPath, "utf8");
    assert.match(prompt, /# CHỈ ĐỌC cho tới khi `hrv theme info --json` trả đúng bound_id/);
    assert.match(prompt, /KHÔNG sửa file theme, KHÔNG push/);
    assert.ok(!/KHÔNG chạy lệnh hrv nào/.test(prompt), "the blanket ban on hrv is gone");
    for (const line of ["hrv whoiam", "hrv refresh-all", "hrv login --no-open", "hrv select <orgId>"]) assert.ok(prompt.includes(line), `the read-only block names ${line}`);
    assert.equal(skipped.last.skipTokenProbe.afterFatalProbe, true);
  });

  test("a later healthy probe clears the remembered dead token", () => {
    const w = world();
    const j = initJob(w, "g7d");
    const theme = themeFolder(w);
    assert.equal(attempt(w, j, ["--cwd", theme], { LEADER_TOKEN_PROBE: DEAD() }).code, 0);
    assert.ok(j.job().tokenProbeFatal);
    const ok = attempt(w, j, ["--cwd", theme], { LEADER_TOKEN_PROBE: probe(0, { ok: true, themeId: "5", orgId: "9", role: "unpublished" }) });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(j.job().tokenProbeFatal, undefined);
  });
});

// ================================================================ G5 live theme announcement

describe("G5 dispatch announces a live theme", () => {
  const probe = (role) => {
    const file = tmp("role-probe.mjs");
    fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, themeId: "5", orgId: "9", role }))});\n`);
    return file;
  };
  const folder = (w) => {
    const dir = path.join(w.root, `live-${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".haravan-cli_local.json"), JSON.stringify({ org_id: 9, theme_id: 5 }));
    return dir;
  };
  const go = (w, j, role) => {
    const file = tmp("live-prompt.md");
    fs.writeFileSync(file, `Việc. issue ${j.job().subject.issueId} host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n`);
    return cliRaw(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file, "--cwd", folder(w)], { LEADER_TOKEN_PROBE: probe(role) });
  };

  test("role main -> liveTheme:true, a warning naming the QA-after-push exposure, and the round remembers it", () => {
    const w = world();
    const j = initJob(w, "g5a");
    const d = go(w, j, "main");
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.liveTheme, true);
    assert.match(d.last.liveThemeWarning, /LIVE \(role main\).*QA happens AFTER the push/);
    assert.match(d.stderr, /warning: liveTheme/);
    const round = j.job().rounds[0];
    assert.deepEqual([round.liveTheme, round.themeRole], [true, "main"]);
  });

  test("an unpublished theme is not announced as live, and a later round with no probe inherits the role", () => {
    const w = world();
    const j = initJob(w, "g5b");
    const d = go(w, j, "unpublished");
    assert.equal(d.last.liveTheme, undefined);
    assert.equal(j.job().rounds[0].liveTheme, false);
    assert.equal(settle(w, j, "terminal-7", 1).code, 0);
    writeReport(j, 1);
    const file = tmp("again.md");
    fs.writeFileSync(file, `Việc. issue ${j.job().subject.issueId} host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n`);
    const again = cliRaw(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file, "--kind", "followup", "--skip-token-probe", "--reason", "kiểm tra kế thừa role"]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual([j.job().rounds[1].liveTheme, j.job().rounds[1].roleFromRound], [false, 1]);
  });
});

// ================================================================ G8 shop folders

describe("G8 every folder bound to the shop is listed", () => {
  function workTree(w) {
    const bind = (name, theme, themeName, org = "200001186776") => {
      const dir = path.join(w.root, "work", "customizes", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".haravan-cli_local.json"), JSON.stringify({ org_id: org, theme_id: theme, theme_name: themeName }));
      return dir.replace(/\\/g, "/");
    };
    return { zesta: bind("Zesta", "1001507674", "Zesta Main"), cusnn: bind("Zesta-CUSNN", "1001530488", "CUSNN"), sameOrg: bind("Cua-Hang-2", "1001600000", "Khác tên", "200001186776"), other: bind("Epres", "1001522351", "Epres", "200001223685") };
  }

  test("shop-folder-index also returns folders bound to the same org whose name does not carry the shop", () => {
    const w = world();
    const dirs = workTree(w);
    const r = shopFolderIndex("zesta.myharavan.com", { root: path.join(w.root, "work") });
    assert.deepEqual(r.customizes.map((x) => x.path).sort(), [dirs.cusnn, dirs.sameOrg, dirs.zesta].sort());
    assert.equal(r.customizes.find((x) => x.path === dirs.sameOrg).via, "org_id");
    assert.equal(r.customizes.find((x) => x.path === dirs.cusnn).binding.theme_name, "CUSNN");
  });

  test("init lists them with theme id and name and warns; dispatch --cwd warns again and names the chosen folder", () => {
    const w = world();
    const dirs = workTree(w);
    const snap = tmp("g8.csv");
    fs.writeFileSync(snap, fixture("epres-before.csv"));
    const init = cliRaw(w, ["init", "--slug", "zesta-369", "--issue-id", "1795425566161", "--shop", "zesta.myharavan.com", "--sheet", "S", "--snapshot-file", snap]);
    assert.equal(init.code, 0, init.stderr);
    assert.equal(init.last.shopFolders.length, 3);
    assert.deepEqual(init.last.shopFolders.map((f) => f.themeId).sort(), ["1001507674", "1001530488", "1001600000"]);
    assert.match(init.last.shopFolderWarning, /3 theme folders bound to different themes/);
    assert.match(init.last.shopFolderWarning, /theme 1001530488 "CUSNN"/);
    const dir = init.last.jobDir;
    const prompt = tmp("g8-prompt.md");
    fs.writeFileSync(prompt, "Việc. issue 1795425566161 host Taiz shop zesta.myharavan.com sheet S.\nGhi report vào {{REPORT_PATH}}\n");
    const d = cliRaw(w, ["dispatch", "--job", dir, "--worker", "terminal-7", "--prompt", prompt, "--cwd", dirs.zesta]);
    assert.equal(d.code, 0, d.stderr);
    assert.match(d.last.shopFolderWarning, new RegExp(`This round's cwd is ${dirs.zesta.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(d.stderr, /warning: shop zesta\.myharavan\.com has 3 theme folders/);
    // a shop with a single folder gets no warning
    const solo = cliRaw(w, ["init", "--slug", "epres-solo", "--issue-id", "7", "--shop", "epres.myharavan.com", "--sheet", "S", "--snapshot-file", snap]);
    assert.equal(solo.last.shopFolderWarning, undefined);
    assert.equal(solo.last.shopFolders.length, 1);
  });
});

// ================================================================ G10 follow-up note

describe("G10 the follow-up prompt tells the worker that carried cells pass", () => {
  test("after a round that claimed sheet cells, the prefill block states the carried rule", () => {
    const w = world();
    const j = epresJob(w);
    epresRound(w, j);
    writeSheetReport(j, 1, r1Claims(fixture("epres-after-r1.csv")), { notChecked: [] });
    assert.equal(validate(w, j, 1).code, 0);
    const file = tmp("g10-prompt.md");
    fs.writeFileSync(file, "Việc vòng 2. issue 1795425566160 host Taiz shop epres.myharavan.com sheet SHEETEPRES.\nGhi report vào {{REPORT_PATH}}\n");
    const d = cliRaw(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file, "--kind", "followup"]);
    assert.equal(d.code, 0, d.stderr);
    const text = fs.readFileSync(j.job().rounds[1].promptPath, "utf8");
    assert.match(text, /Điền sẵn từ vòng trước/);
    assert.match(text, /ô đã đổi ở vòng trước và vẫn bằng `expect` \(verify-sheet gọi là carried\): cả hai đều qua/);
  });
});
