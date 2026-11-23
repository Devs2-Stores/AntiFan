// Leader-QA model (user, 23/11/2026): the worker only fixes and hands over, the Leader QAs and records the storefront.
// Jobs started before it (no job.leaderQa) must keep validating.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { validateReportText } from "../../scripts/leader/report.mjs";
import { REPO, cleanup, cli, dispatch, initJob, reportText, settle, world, writeReport } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const HANDOVER = { checks: [{ url: "https://s.example/products/a?themeid=1", viewport: "375x812|1440x900", selector: ".buy", expect: "visible, 44px high" }], backup: "E:/x/backup", risks: ["menu on tablet"] };
const QUIET = { commentsAdded: 0, stageBefore: "Feedback", stageAfter: "Feedback" };

const baseJob = (over = {}) => ({ job: "j", slug: "s", subject: { kind: "feedback", issueId: "1", host: "Taiz", shop: "s", sheetId: "" }, ...over });
const check = (job, over, ctx = { kind: "work" }) => validateReportText(reportText(job, 1, { dashboard: QUIET, ...over }), job, 1, ctx);
const has = (list, re) => list.some((e) => re.test(e));

describe("handover validation", () => {
  test("a leaderQa work report needs handover, no dashboard write and an unchanged Stage", () => {
    const job = baseJob({ leaderQa: 1 });
    assert.deepEqual(check(job, { handover: HANDOVER }).errors, []);
    assert.ok(has(check(job, {}).errors, /no handover/));
    assert.ok(has(check(job, { handover: HANDOVER, dashboard: { ...QUIET, commentsAdded: 1 } }).errors, /no dashboard comment/));
    assert.ok(has(check(job, { handover: HANDOVER, dashboard: { ...QUIET, commentsRemoved: 1, removedTexts: ["x"] } }).errors, /no dashboard comment/));
    assert.ok(has(check(job, { handover: HANDOVER, dashboard: { ...QUIET, stageAfter: "Pending" } }).errors, /never changes the Stage/));
    assert.ok(has(check(job, {}, { kind: "followup" }).errors, /no handover/));
  });

  test("handover shape: checks need url, selector, expect and WxH viewports; shipped files need at least one check", () => {
    const job = baseJob({ leaderQa: 1 });
    const bad = (h, over = {}) => check(job, { handover: h, ...over }).errors;
    assert.ok(has(bad({ backup: "x" }), /handover\.checks must be an array/));
    assert.ok(has(bad({ checks: [{ url: "u", viewport: "phone", selector: ".a", expect: "x" }] }), /viewport must be WIDTHxHEIGHT/));
    assert.ok(has(bad({ checks: [{ url: "u", viewport: "375x812", selector: "", expect: "x" }] }), /non-empty url, selector and expect/));
    assert.ok(has(bad({ checks: [], risks: [1] }), /risks must be an array of strings/));
    assert.ok(has(bad({ checks: [] }, { files: ["a.liquid"] }), /handover\.checks is empty/));
    assert.deepEqual(bad({ checks: [], risks: [] }), [], "nothing shipped: an empty checks list is fine");
  });

  test("jobs started before the model get warnings, not refusals, but a malformed handover is still an error", () => {
    const job = baseJob();
    const r = check(job, { dashboard: { commentsAdded: 1, stageBefore: "Feedback", stageAfter: "Pending" } });
    assert.deepEqual(r.errors, []);
    assert.ok(has(r.warnings, /no handover/));
    assert.deepEqual(check(job, { handover: HANDOVER }).warnings, []);
    assert.ok(has(check(job, { handover: { checks: "x" } }).errors, /handover\.checks must be an array/));
    assert.ok(has(check(job, { handover: { checks: [] }, files: ["a"] }).warnings, /handover\.checks is empty/));
  });

  test("a close round and an adhoc job are exempt; PENDING in a leaderQa work round warns", () => {
    const job = baseJob({ leaderQa: 1 });
    assert.deepEqual(check(job, { dashboard: { commentsAdded: 1, commentText: "Em đã fix ạ:", stageBefore: "Feedback", stageAfter: "Done" }, closeToken: "t" }, { kind: "close", closeToken: "t" }).errors, []);
    const adhoc = { job: "j", slug: "s", leaderQa: 1, subject: { kind: "adhoc", title: "t" } };
    assert.deepEqual(validateReportText(reportText({ ...adhoc, subject: { ...adhoc.subject, issueId: "", host: "", shop: "", sheetId: "" } }, 1, { guard: undefined, dashboard: undefined }), adhoc, 1, { kind: "work" }).errors, []);
    const pending = check(job, { status: "PENDING", handover: HANDOVER });
    assert.deepEqual(pending.errors, []);
    assert.ok(has(pending.warnings, /NEEDS_INPUT/));
  });
});

describe("Leader-QA ledger", () => {
  test("init marks the job and the worker prompt hands over instead of QA-ing and commenting", () => {
    const w = world();
    const j = initJob(w, "qa", "1", { leaderQa: true });
    assert.equal(j.job().leaderQa, 1);
    const prompt = fs.readFileSync(path.join(j.dir, "qa.prompt.md"), "utf8");
    assert.match(prompt, /KHÔNG tự QA 2 vòng/);
    assert.match(prompt, /KHÔNG comment dashboard, KHÔNG chạy quickUpdate\(\.\.\.,'Done'\) và KHÔNG chạy quickUpdate\(\.\.\.,'Pending'\)/);
    assert.match(prompt, /handover/);
    assert.match(prompt, /ưu tiên hơn[^\n]*QA 2 vòng/);
    assert.doesNotMatch(prompt, /verify 2 vòng bằng AntiFan/);
    assert.doesNotMatch(prompt, /đăng MỘT comment kết quả/);
  });

  test("a job is verified only after the Leader records storefront; the worker report alone never is", () => {
    const w = world();
    const j = initJob(w, "qa", "1", { leaderQa: true });
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    settle(w, j, "terminal-7", 1);
    writeReport(j, 1, { dashboard: QUIET, handover: HANDOVER, storefront: { measurements: [{ probe: "smoke", url: "u", viewport: "375x812", selector: ".x", value: "HTTP 200" }] } });
    const v = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.last.state, "reported");
    assert.match(v.last.next, /Leader QA/);
    assert.deepEqual(j.job().rounds[0].report.required, ["dashboard", "storefront"]);
    const dash = cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "dashboard", "--status", "PASS"]);
    assert.equal(dash.last.state, "reported");
    assert.deepEqual(dash.last.missing, ["storefront"]);
    const front = cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "storefront", "--status", "PASS", "--note", "375 and 1440 measured by the Leader"]);
    assert.equal(front.last.state, "verified");
    assert.deepEqual(front.last.missing, []);
  });

  test("a handover alone (no storefront block, no files) still requires the Leader's storefront record", () => {
    const w = world();
    const j = initJob(w, "qa", "1", { leaderQa: true });
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    settle(w, j, "terminal-7", 1);
    writeReport(j, 1, { dashboard: QUIET, handover: HANDOVER });
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 0);
    assert.deepEqual(j.job().rounds[0].report.required, ["dashboard", "storefront"]);
  });

  test("a leaderQa DONE report without handover is refused by validate-report; a pre-model job's is accepted with a warning", () => {
    const w = world();
    const j = initJob(w, "qa", "1", { leaderQa: true });
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    settle(w, j, "terminal-7", 1);
    writeReport(j, 1, { dashboard: QUIET });
    const v = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(v.code, 1);
    assert.match(v.stderr, /no handover/);

    const old = initJob(w, "old", "2");
    assert.equal(old.job().leaderQa, undefined);
    assert.equal(dispatch(w, old, "terminal-8", "work").code, 0);
    settle(w, old, "terminal-8", 1);
    writeReport(old, 1, { dashboard: { commentsAdded: 1, stageBefore: "Feedback", stageAfter: "Feedback" } });
    const ov = cli(w, ["validate-report", "--job", old.dir]);
    assert.equal(ov.code, 0, ov.stderr);
    assert.ok(has(ov.last.warnings, /no handover/));
    assert.deepEqual(old.job().rounds[0].report.required, ["dashboard"]);
  });

  test("a sheet-only leaderQa job has no theme: no handover needed, none of it asks for a storefront record, dashboard stays untouched", () => {
    const w = world();
    const j = initJob(w, "so", "1", { leaderQa: true, profile: "sheet-only" });
    assert.equal(j.job().leaderQa, 1);
    assert.equal(j.job().profile, "sheet-only");
    const prompt = fs.readFileSync(path.join(j.dir, "so.prompt.md"), "utf8");
    assert.doesNotMatch(prompt, /"handover"|"storefront"|`handover` \(BẮT BUỘC/, "the sheet-only header does not ask for a theme hand-over or storefront smoke numbers");
    assert.match(prompt, /KHÔNG comment dashboard/);
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    settle(w, j, "terminal-7", 1);
    writeReport(j, 1, { dashboard: QUIET });
    const v = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(v.code, 0, v.stderr);
    assert.deepEqual(j.job().rounds[0].report.required, ["dashboard"]);
    // a handover a sheet-only worker volunteers is accepted but never demands a storefront record
    writeReport(j, 1, { dashboard: QUIET, handover: { checks: [], risks: [] }, storefront: { measurements: [{ probe: "smoke", url: "u", viewport: "375x812", selector: ".x", value: "ok" }] } });
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 0);
    assert.deepEqual(j.job().rounds[0].report.required, ["dashboard"]);
    const rec = cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "dashboard", "--status", "PASS"]);
    assert.equal(rec.last.state, "verified");
    // a comment is still refused on a sheet-only job
    writeReport(j, 1, { dashboard: { ...QUIET, commentsAdded: 1 } });
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 1);
  });

  test("the close prompt makes the close round post the result note, delete the replaced dev note and set Done", () => {
    const text = fs.readFileSync(path.join(REPO, "scripts", "leader", "templates", "close-followup.md"), "utf8");
    assert.match(text, /Em đã fix ạ:/);
    assert.match(text, /quickUpdate\(<rowNumber>,'Done'\)/);
    assert.match(text, /nguyên văn trùng khớp hoàn toàn với một `dashboard\.commentText`/);
    assert.match(text, /KHÔNG đăng note thứ hai/);
  });
});
