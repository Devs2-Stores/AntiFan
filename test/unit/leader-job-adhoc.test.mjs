// leader-job-adhoc.test.mjs - jobs that are not feedback issues get a ledger too (init --kind adhoc), a dispatch is
// refused while the disk is short, and a follow-up carries a chat message. Driven through the real CLI.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { cleanup, cli, initJob, settle, verifiedJob, world, writeRun } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const GB = 1024 ** 3;
const PROMPT = "Việc. issue 1 host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n";

function adhocJob(w, slug = "cleanup", extra = []) {
  const r = cli(w, ["init", "--kind", "adhoc", "--slug", slug, ...extra]);
  if (r.code !== 0) throw new Error(`init failed: ${r.stderr}`);
  const dir = r.last.jobDir;
  const file = path.join(dir, "job.json");
  const job = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const prompt = r.last.promptPath;
  fs.writeFileSync(prompt, fs.readFileSync(prompt, "utf8").replace("{{TASK}}", "Dọn thư mục tạm."));
  return { dir, job, prompt, init: r };
}

const adhocReport = (job, round, over = {}) => {
  const json = { schema: "leader-report/1", status: "DONE", job: job.job, key: job.slug, round, summary: "xong", notChecked: ["không"], ...over };
  return `STATUS: ${json.status}\n\nprose\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
};

describe("init --kind adhoc", () => {
  test("writes job.json with an ad-hoc subject, no snapshot and a prompt without the GUARD block", () => {
    const w = world();
    const j = adhocJob(w, "deploy-x", ["--title", "Deploy worker X"]);
    const job = j.job();
    assert.equal(job.subject.kind, "adhoc");
    assert.equal(job.subject.title, "Deploy worker X");
    assert.equal(job.subject.issueId, undefined);
    assert.equal(job.snapshotBefore, null);
    assert.equal(fs.existsSync(path.join(j.dir, "snapshot-before.csv")), false);
    const text = fs.readFileSync(j.prompt, "utf8");
    assert.ok(text.includes(job.job), "prompt names the job");
    assert.ok(text.includes(j.init.last.nextReportPath), "prompt names the report path");
    assert.ok(text.includes("Deploy worker X"));
    assert.ok(!text.includes("GUARD"), "no feedback guard block");
    assert.ok(!/\{\{(?!TASK)[A-Z_]+\}\}/.test(text), "every placeholder but the task is filled");
  });

  test("rejects feedback-only flags and an unknown kind", () => {
    const w = world();
    const r = cli(w, ["init", "--kind", "adhoc", "--slug", "a", "--issue-id", "7"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--issue-id/);
    assert.equal(cli(w, ["init", "--kind", "bogus", "--slug", "a"]).code, 2);
  });

  test("a feedback init keeps its output keys and job shape", () => {
    const w = world();
    const r = cli(w, ["init", "--slug", "fb", "--issue-id", "9", "--shop", "s.example", "--no-sheet"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.keys(r.last), ["cmd", "ok", "jobDir", "job", "state", "cols", "gid", "noSheet", "dataRows", "outstandingDevRows", "promptPath", "nextReportPath", "note"]);
    const job = JSON.parse(fs.readFileSync(path.join(r.last.jobDir, "job.json"), "utf8"));
    assert.equal(job.subject.kind, "feedback");
    assert.equal(job.subject.issueId, "9");
    assert.ok(fs.existsSync(path.join(r.last.jobDir, "snapshot-before.csv")));
  });
});

describe("an ad-hoc job through the whole ledger", () => {
  test("dispatch, report without guard, validate, record adhoc PASS: verified, then close", () => {
    const w = world();
    const j = adhocJob(w);
    writeRun(w, "terminal-7", { runSeq: 0, state: "idle" });
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt]);
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.round, 1);
    assert.equal(j.job().state, "dispatched");
    settle(w, { dir: j.dir }, "terminal-7", 1);
    fs.writeFileSync(j.job().rounds[0].reportPath, adhocReport(j.job(), 1));
    const v = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.last.state, "reported");
    assert.deepEqual(j.job().rounds[0].report.required, []);
    const s = cli(w, ["status", "--job", j.dir]);
    assert.equal(s.lines[0].subject, "adhoc");
    assert.match(s.lines[0].blocking, /record --kind adhoc/);
    const rec = cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "adhoc", "--status", "PASS", "--note", "đã kiểm"]);
    assert.equal(rec.code, 0, rec.stderr);
    assert.equal(rec.last.state, "verified");
    fs.rmSync(path.join(w.runs, "terminal-7.json"));
    const c = cli(w, ["close", "--job", j.dir]);
    assert.equal(c.code, 0, c.stderr);
    assert.equal(c.last.state, "closed");
  });

  test("dispatch without --prompt uses the prompt init wrote, and a later round with no prompt file is refused", () => {
    const w = world();
    const j = adhocJob(w);
    writeRun(w, "terminal-7", { runSeq: 0, state: "idle" });
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7"]);
    assert.equal(d.code, 0, d.stderr);
    assert.equal(path.resolve(d.last.promptPath), path.resolve(j.prompt));
    assert.match(d.last.input, /cleanup\.prompt\.md/);
    settle(w, { dir: j.dir }, "terminal-7", 1);
    const next = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7"]);
    assert.equal(next.code, 2);
    assert.match(next.last.error, /missing required --prompt \(round 2 has no cleanup\.r2\.prompt\.md/);
    assert.equal(j.job().rounds.length, 1, "a refused dispatch leaves no round");
  });

  test("a summary-only report does not reach verified without a recorded PASS", () => {
    const w = world();
    const j = adhocJob(w);
    cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt]);
    settle(w, { dir: j.dir }, "terminal-7", 1);
    fs.writeFileSync(j.job().rounds[0].reportPath, adhocReport(j.job(), 1));
    assert.equal(cli(w, ["validate-report", "--job", j.dir]).code, 0);
    assert.equal(j.job().state, "reported");
    const fail = cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "adhoc", "--status", "FAIL"]);
    assert.equal(fail.code, 1);
    assert.equal(j.job().state, "reported");
    assert.deepEqual(fail.last.missing, ["adhoc"]);
    const refused = cli(w, ["close", "--job", j.dir]);
    assert.equal(refused.code, 4);
    assert.equal(j.job().state, "reported");
  });

  test("a report that claims feedback guard fields or sheet cells is invalid", () => {
    const w = world();
    const j = adhocJob(w);
    cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt]);
    settle(w, { dir: j.dir }, "terminal-7", 1);
    const file = j.job().rounds[0].reportPath;
    fs.writeFileSync(file, adhocReport(j.job(), 1, { guard: { issueId: "5", host: "", shop: "", sheetId: "" } }));
    const bad = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(bad.code, 1);
    assert.match(bad.last.errors.join("\n"), /guard\.issueId/);
    fs.writeFileSync(file, adhocReport(j.job(), 1, { guard: {}, sheet: { cells: [{ keyText: "a", col: "b", expect: "c" }] } }));
    const cells = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(cells.code, 1);
    assert.match(cells.last.errors.join("\n"), /sheet cells/);
  });

  test("verify-sheet, a close round and a review round are refused", () => {
    const w = world();
    const j = adhocJob(w);
    assert.equal(cli(w, ["verify-sheet", "--job", j.dir]).code, 4);
    assert.equal(cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt, "--kind", "close"]).code, 4);
    assert.equal(j.job().rounds.length, 0);
  });

  test("needs-me lists it and the board row shows round and kind", () => {
    const w = world();
    const j = adhocJob(w);
    cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt]);
    const r = cli(w, ["needs-me"]);
    assert.equal(r.last.rows[0].round, 1);
    assert.equal(r.last.rows[0].kind, "work");
  });
});

describe("dispatch under disk pressure", () => {
  const writeDisk = (w, patch) =>
    fs.writeFileSync(
      path.join(path.dirname(w.runs), "disk-pressure.json"),
      JSON.stringify({ schema: 1, at: Date.now(), alarmed: false, volumes: [{ path: "E:\\", freeBytes: 2 * GB, floorBytes: 5 * GB, alarmed: false }], ...patch }),
    );

  function ready(w, slug) {
    const j = initJob(w, slug);
    const file = path.join(w.root, `${slug}.md`);
    fs.writeFileSync(file, `Việc. issue 1 host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n`);
    return { j, file };
  }

  test("a short volume refuses a fresh and a follow-up dispatch and --allow-low-disk overrides", () => {
    const w = world();
    writeDisk(w, {});
    const { j, file } = ready(w, "fresh");
    const fresh = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file]);
    assert.equal(fresh.code, 4);
    assert.match(fresh.last.error, /^disk is short: E:\\ has 2\.0 GB free, under the 5\.0 GB floor/);
    assert.equal(j.job().rounds.length, 0, "a refused dispatch leaves no round");

    writeRun(w, "terminal-8", { runSeq: 1, state: "idle" });
    const follow = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-8", "--prompt", file]);
    assert.equal(follow.code, 4);
    assert.match(follow.last.error, /^disk is short:/);

    const ok = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-8", "--prompt", file, "--allow-low-disk"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.last.mode, "followup");
  });

  test("an alarmed reading refuses even when the volumes look fine; stale, malformed or healthy readings do not", () => {
    const w = world();
    const { j, file } = ready(w, "gate");
    const dispatchOnce = () => (fs.writeFileSync(file, PROMPT), cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file, "--allow-extra-round", "--reason", "test"]));
    writeDisk(w, { alarmed: true, volumes: [{ path: "E:\\", freeBytes: 6 * GB, floorBytes: 5 * GB, alarmed: true }] });
    assert.equal(dispatchOnce().code, 4);
    writeDisk(w, { at: Date.now() - 120_000 });
    assert.equal(dispatchOnce().code, 0, "a stale reading blocks nothing");
    fs.writeFileSync(path.join(path.dirname(w.runs), "disk-pressure.json"), "{half");
    assert.equal(dispatchOnce().code, 0, "a malformed reading blocks nothing");
    writeDisk(w, { volumes: [{ path: "E:\\", freeBytes: 20 * GB, floorBytes: 5 * GB, alarmed: false }] });
    assert.equal(dispatchOnce().code, 0);
  });
});

describe("follow-up message", () => {
  test("a follow-up round carries message without the carriage return; a fresh round carries none", () => {
    const w = world();
    const j = initJob(w, "msg");
    const file = path.join(w.root, "msg.md");
    fs.writeFileSync(file, `Việc. issue 1 host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n`);
    const fresh = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file]);
    assert.equal(fresh.last.mode, "fresh");
    assert.equal(fresh.last.message, undefined);
    assert.match(fresh.last.input, /\r$/);
    writeRun(w, "terminal-7", { runSeq: 1, state: "idle", lastEventAt: Date.now() + 60_000 });
    settle(w, j, "terminal-7", 1);
    fs.writeFileSync(file, PROMPT);
    const follow = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file]);
    assert.equal(follow.code, 0, follow.stderr);
    assert.equal(follow.last.mode, "followup");
    assert.equal(follow.last.input, `${follow.last.message}\r`);
    assert.ok(!/[\r\n]/.test(follow.last.message));
    assert.match(follow.last.note, /pass message \(not input\)/);
  });
});

describe('ad-hoc verification is not outvoted', () => {
  function reportedAdhoc(w) {
    const j = adhocJob(w);
    cli(w, ['dispatch', '--job', j.dir, '--worker', 'terminal-7', '--prompt', j.prompt]);
    settle(w, { dir: j.dir }, 'terminal-7', 1);
    fs.writeFileSync(j.job().rounds[0].reportPath, adhocReport(j.job(), 1));
    assert.equal(cli(w, ['validate-report', '--job', j.dir]).code, 0);
    return j;
  }
  const rec = (w, j, kind, status) => cli(w, ['record', '--job', j.dir, '--round', '1', '--kind', kind, '--status', status]);

  test('a failed adhoc check is not covered by a PASS of another kind; a failed other kind blocks a passed adhoc check', () => {
    const w = world();
    const j = reportedAdhoc(w);
    rec(w, j, 'adhoc', 'FAIL');
    assert.equal(rec(w, j, 'storefront', 'PASS').last.state, 'reported');
    const ok = rec(w, j, 'adhoc', 'PASS');
    assert.equal(ok.last.state, 'verified');
    const bad = rec(w, j, 'storefront', 'FAIL');
    assert.equal(bad.code, 1);
    assert.deepEqual(bad.last.missing, ['storefront FAIL']);
    assert.equal(j.job().state, 'verified', 'a verified job stays verified until the Leader re-decides; close re-checks');
    fs.rmSync(path.join(w.runs, 'terminal-7.json'));
    const c = cli(w, ['close', '--job', j.dir]);
    assert.equal(c.code, 4);
    assert.match(c.last.error, /storefront FAIL/);
    assert.equal(rec(w, j, 'storefront', 'PASS').code, 0);
    assert.equal(cli(w, ['close', '--job', j.dir]).code, 0);
  });

  test('approve --force cannot close an unchecked ad-hoc job', () => {
    const w = world();
    const j = reportedAdhoc(w);
    assert.equal(cli(w, ['approve', '--job', j.dir, '--force']).last.state, 'user-approved');
    fs.rmSync(path.join(w.runs, 'terminal-7.json'));
    const c = cli(w, ['close', '--job', j.dir]);
    assert.equal(c.code, 4);
    assert.match(c.last.error, /missing adhoc/);
    assert.equal(j.job().state, 'user-approved');
    assert.equal(rec(w, j, 'adhoc', 'PASS').code, 0);
    assert.equal(cli(w, ['close', '--job', j.dir]).code, 0);
  });
});

describe('disk gate details', () => {
  const diskFile = (w) => path.join(path.dirname(w.runs), 'disk-pressure.json');

  test('a volume latched in the alarm above its floor says so', () => {
    const w = world();
    fs.writeFileSync(diskFile(w), JSON.stringify({ schema: 1, at: Date.now(), alarmed: true, volumes: [{ path: 'E:\\', freeBytes: 7 * GB, floorBytes: 5 * GB, clearBytes: 10 * GB, alarmed: true }] }));
    const j = initJob(w, 'latched');
    const file = path.join(w.root, 'l.md');
    fs.writeFileSync(file, PROMPT);
    const r = cli(w, ['dispatch', '--job', j.dir, '--worker', 'terminal-7', '--prompt', file]);
    assert.equal(r.code, 4);
    assert.ok(r.last.error.startsWith("disk is short: E:\\ is still in a low-disk alarm (7.0 GB free; the alarm clears at 10.0 GB)"), r.last.error);
    assert.doesNotMatch(r.last.error, /under the/);
  });

  test('a close round is not gated', () => {
    const w = world();
    const j = initJob(w, 'closegate');
    verifiedJob(w, j);
    assert.equal(cli(w, ['approve', '--job', j.dir]).code, 0);
    fs.writeFileSync(diskFile(w), JSON.stringify({ schema: 1, at: Date.now(), alarmed: true, volumes: [{ path: 'E:\\', freeBytes: 1 * GB, floorBytes: 5 * GB, alarmed: true }] }));
    const r = cli(w, ['dispatch', '--job', j.dir, '--worker', 'terminal-7', '--kind', 'close']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.kind, 'close');
  });
});
