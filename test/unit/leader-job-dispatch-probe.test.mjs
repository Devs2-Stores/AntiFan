// dispatch preflight: a bound Haravan theme folder is probed for a usable hrv session before a worker round is spent on it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { pathToFileURL } from "node:url";

import { REPO, TEMP, cleanup, cli, initJob, settle, world, writeReport } from "./leader-job-cli-helpers.mjs";

after(cleanup);

let n = 0;
/** One fake hrv-token-probe: the real one prints one JSON line and exits 0 ok / 1 read failed / 2 cannot ask. */
function probe(exitCode, body) {
  const file = path.join(TEMP, `probe-${++n}.mjs`);
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(JSON.stringify(body))});\nprocess.exit(${exitCode});\n`);
  return file;
}
const FAIL = () => probe(1, { ok: false, themeId: "5", orgId: "9", error: "Token hết hạn và không refresh được" });
const UNASKABLE = () => probe(2, { ok: false, themeId: "5", orgId: "9", error: "cannot load the Haravan CLI helper" });
const OK = () => probe(0, { ok: true, themeId: "5", orgId: "9", role: "main" });

function themeFolder(w) {
  const dir = path.join(w.root, `theme-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".haravan-cli_local.json"), JSON.stringify({ org_id: 9, theme_id: 5 }));
  return dir;
}

/** Dispatch a feedback job with a hand-made prompt (the shared helper cannot carry per-call env). */
function attempt(w, j, worker, extra = [], env = {}) {
  const round = j.job().rounds.length + 1;
  const file = path.join(w.root, `prompt-${++n}.md`);
  fs.writeFileSync(file, `Việc của vòng ${round}. issue ${j.job().subject.issueId} host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n`);
  return cli(w, ["dispatch", "--job", j.dir, "--worker", worker, "--prompt", file, ...extra], env);
}

describe("hrv token preflight", () => {
  test("an expired token no longer refuses: the prompt gets a # LOGIN block, the round records login and dispatch prints the owner notice", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    const before = Date.now();
    const r = attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.round, 1);
    assert.equal(j.job().state, "dispatched");
    assert.equal(j.job().rounds.length, 1, "the round is recorded");
    const login = j.job().rounds[0].login;
    assert.equal(login.orgId, "9", "the org comes from the folder's binding");
    assert.equal(login.email, "services@f1genz.com");
    assert.match(login.reason, /Token hết hạn/);
    assert.ok(login.at >= before, "at is the dispatch time (informational: the OTP t0 is taken by the worker right before it clicks send)");
    assert.equal(login.since, undefined, "no dispatch-time t0 is recorded: one t0 convention only");
    assert.match(r.last.ownerNotice, /services@f1genz\.com/);
    assert.match(r.last.ownerNotice, /9/);
    assert.ok(!r.last.ownerNotice.includes("\n"), "one line");
    assert.deepEqual(r.last.login, login);
    const prompt = fs.readFileSync(j.job().rounds[0].promptPath, "utf8");
    assert.match(prompt, /^# LOGIN/m);
    for (const line of ["`hrv whoiam`", "`hrv refresh-all`", "`hrv login --no-open`", "`hrv select 9`", "`hrv theme info --json`"]) assert.ok(prompt.includes(line), line);
    assert.ok(!/--since \d{10,}/.test(prompt), "the block carries no pre-computed --since: the worker takes t0 itself");
    assert.match(prompt, /otp-fetch\.mjs --now/);
    assert.match(prompt, /otp-fetch\.mjs --since <t0> --wait 120/);
    assert.match(prompt, /NGAY TRƯỚC khi bấm/);
    assert.match(prompt, /otp-fetch\.mjs --clear/);
    assert.match(prompt, /Telegram/);
    assert.match(prompt, /KHÔNG push/);
    assert.ok(!/owner must run|The owner must/.test(prompt));
    assert.ok(!prompt.includes("# CHỈ ĐỌC"), "the LOGIN round is not the skipped-probe read-only round");
    assert.equal(j.job().tokenProbeFatal.orgId, "9", "the dead token stays remembered for a later --skip-token-probe");
  });

  test("a binding with no org_id is still refused, naming the missing field", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    fs.writeFileSync(path.join(theme, ".haravan-cli_local.json"), JSON.stringify({ theme_id: 5 }));
    const refused = attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(refused.code, 4, refused.stderr);
    assert.match(refused.stderr, /org_id/);
    assert.match(refused.stderr, /\.haravan-cli_local\.json/);
    assert.equal(j.job().rounds.length, 0, "no round was recorded");
  });

  test("one login per job: a second dead-token dispatch after a LOGIN round is refused", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    assert.equal(attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() }).code, 0);
    const again = attempt(w, j, "terminal-7", ["--cwd", theme, "--allow-busy", "--allow-extra-round", "--reason", "retry"], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(again.code, 4, again.stderr);
    assert.match(again.stderr, /one login per job|already tried a login/);
    assert.match(again.last.next, /--skip-token-probe/);
    assert.ok(!/owner to sign in|sign in first/i.test(again.last.next + again.stderr), "the owner is never told to sign in");
    assert.match(again.last.next, /NEEDS_INPUT/);
    assert.match(again.last.next, /not in the services@f1genz\.com account/);
    assert.equal(j.job().rounds.length, 1);
  });

  test("a LOGIN round whose worker died still spent the job's one login", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    assert.equal(attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() }).code, 0);
    j.patch((job) => {
      job.rounds[0].deadAt = Date.now();
      job.rounds[0].deadWhy = "run file gone";
      job.state = "worker_dead";
    });
    const again = attempt(w, j, "terminal-8", ["--cwd", theme, "--allow-extra-round", "--reason", "retry"], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(again.code, 4, again.stderr);
    assert.match(again.stderr, /one login per job|already tried a login/);
    assert.match(again.last.next, /its worker died/);
    assert.equal(j.job().rounds.length, 1, "no second login round was recorded");
  });

  test("the LOGIN block says what to do when OrgSelect of services@ lacks the org: no other org, no hrv select of another org, NEEDS_INPUT", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    assert.equal(attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() }).code, 0);
    const prompt = fs.readFileSync(j.job().rounds[0].promptPath, "utf8");
    const step = prompt.split(/\r?\n/).find((l) => /^7\. Trang OrgSelect/.test(l));
    assert.ok(step, "an OrgSelect step exists");
    assert.match(step, /OrgSelect của `services@f1genz\.com` KHÔNG có org 9/);
    assert.match(step, /KHÔNG chọn org khác/);
    assert.match(step, /KHÔNG `hrv select` org khác/);
    assert.match(step, /STATUS: NEEDS_INPUT/);
    assert.match(step, /tên các shop thấy được/);
  });

  test("the LOGIN block takes the machine-wide login lock first and releases it after the clipboard is cleared", () => {
    const w = world();
    const j = initJob(w, "lockjob");
    const theme = themeFolder(w);
    assert.equal(attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() }).code, 0);
    const lines = fs.readFileSync(j.job().rounds[0].promptPath, "utf8").split(/\r?\n/);
    const jobName = j.job().job;
    const at = (re) => lines.findIndex((l) => re.test(l));
    const lock = at(new RegExp(`otp-fetch\\.mjs --lock --job ${jobName}`));
    const login = at(/hrv login --no-open/);
    const unlock = at(new RegExp(`otp-fetch\\.mjs --unlock --job ${jobName}`));
    assert.ok(lock >= 0 && login > lock, "lock comes before login");
    assert.ok(unlock > login, "unlock comes after");
    assert.match(lines[lock], /\{locked:true,holder\}/);
  });

  test("validate-report: a LOGIN round's report may only name `hrv select` of the org it was approved for", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    assert.equal(attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() }).code, 0);
    settle(w, j, "terminal-7", 1);

    writeReport(j, 1, { evidence: ["hrv login --no-open: Đăng nhập thành công", "hrv select 200000878093 -> ok"] });
    const bad = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(bad.code, 1, bad.stderr);
    assert.match(bad.last.errors.join("\n"), /names `hrv select 200000878093`/);
    assert.match(bad.last.errors.join("\n"), /org 9 only/);

    writeReport(j, 1, { summary: "đã chạy hrv select 4242 rồi", needsInput: undefined });
    assert.match(cli(w, ["validate-report", "--job", j.dir]).last.errors.join("\n"), /hrv select 4242/, "the summary is scanned too");

    writeReport(j, 1, { evidence: ["hrv select 9 -> ok", "hrv theme info --json -> bound_id 5", "không chạy hrv select org khác vì org 9 vắng"] });
    const good = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(good.code, 0, good.stderr);
  });

  test("validate-report: a round without a LOGIN block is not subject to the select check", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    assert.equal(attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: OK() }).code, 0);
    settle(w, j, "terminal-7", 1);
    writeReport(j, 1, { evidence: ["hrv select 777 -> ok (approved by the Leader)"] });
    const v = cli(w, ["validate-report", "--job", j.dir]);
    assert.equal(v.code, 0, v.stderr);
  });

  test("the close round (the one that pushes to live) also gets the LOGIN block on a dead token; status lists the login round", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    j.patch((job) => {
      job.state = "user-approved";
      job.approvedAt = Date.now();
      job.approval = { at: Date.now(), closeToken: "TOK-1", tokenUsedAt: null };
    });
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "close", "--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.kind, "close");
    assert.equal(d.last.login.orgId, "9");
    assert.match(d.last.ownerNotice, /services@f1genz\.com/);
    assert.match(fs.readFileSync(d.last.promptPath, "utf8"), /^# LOGIN/m);
    assert.equal(j.job().rounds[0].login.orgId, "9");
    const status = cli(w, ["status", "--job", j.dir]);
    assert.equal(status.lines[0].loginRounds[0].round, 1);
    assert.equal(status.lines[0].loginRounds[0].email, "services@f1genz.com");
  });

  test("a close round whose binding has no org_id only warns (it was never refused for a dead token)", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    fs.writeFileSync(path.join(theme, ".haravan-cli_local.json"), JSON.stringify({ theme_id: 5 }));
    j.patch((job) => {
      job.state = "user-approved";
      job.approvedAt = Date.now();
      job.approval = { at: Date.now(), closeToken: "TOK-1", tokenUsedAt: null };
    });
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "close", "--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.login, undefined);
    assert.ok(!fs.readFileSync(d.last.promptPath, "utf8").includes("# LOGIN"));
  });

  test("G6: the LOGIN block passes the CLI-approval scan, and a follow-up carrying it needs no owner quote", async () => {
    const { scanCliApprovals } = await import(pathToFileURL(path.join(REPO, "scripts", "leader", "qa-gates.mjs")).href);
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    assert.equal(attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() }).code, 0);
    const withBlock = fs.readFileSync(j.job().rounds[0].promptPath, "utf8");
    assert.match(withBlock, /^# LOGIN/m);
    assert.deepEqual(scanCliApprovals(withBlock), [], "the four login lines are inside AGENTS.md section 8");
    for (const line of ["hrv whoiam", "hrv refresh-all", "hrv login --no-open", "hrv select 9"]) assert.deepEqual(scanCliApprovals(`chạy \`${line}\` một lần`), [], line);
    // the same text as a follow-up: no --owner-quote, no refusal
    const file = path.join(w.root, `followup-${++n}.md`);
    fs.writeFileSync(file, `${withBlock}\nGhi report vào {{REPORT_PATH}}\n`);
    const followup = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "followup", "--prompt", file, "--cwd", theme, "--allow-busy", "--allow-extra-round", "--reason", "G6"], { LEADER_TOKEN_PROBE: OK() });
    assert.equal(followup.code, 0, followup.stderr);
    assert.equal(followup.last.ownerApproval, undefined);
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.match(/^# LOGIN/gm).length, 1, "the block is not added twice");
  });

  test("--skip-token-probe, an unaskable probe and a healthy one let the dispatch through and report the result", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    const skipped = attempt(w, j, "terminal-7", ["--cwd", theme, "--skip-token-probe", "--reason", "token vừa được owner login, probe chậm"], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.equal(skipped.last.tokenProbe, undefined);
    assert.equal(skipped.last.round, 1);
    assert.equal(j.job().cwd, theme.replace(/\\/g, "/"), "the folder is remembered on the job");

    const w2 = world();
    const j2 = initJob(w2);
    const unaskable = attempt(w2, j2, "terminal-8", ["--cwd", themeFolder(w2)], { LEADER_TOKEN_PROBE: UNASKABLE() });
    assert.equal(unaskable.code, 0, unaskable.stderr);
    assert.equal(unaskable.last.tokenProbe.ok, false);
    assert.equal(unaskable.last.tokenProbe.fatal, false);

    const w3 = world();
    const j3 = initJob(w3);
    const ok = attempt(w3, j3, "terminal-9", ["--cwd", themeFolder(w3)], { LEADER_TOKEN_PROBE: OK() });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.last.tokenProbe.ok, true);
    assert.equal(ok.last.tokenProbe.role, "main");
  });

  test("an ad-hoc job and a folder with no binding are never refused by the probe", () => {
    const w = world();
    const init = cli(w, ["init", "--kind", "adhoc", "--slug", "cleanup"]);
    assert.equal(init.code, 0, init.stderr);
    const dir = init.last.jobDir;
    const prompt = path.join(w.root, "adhoc.md");
    fs.writeFileSync(prompt, `Dọn file của job ${path.basename(dir)}.\nGhi report vào {{REPORT_PATH}}\n`);
    const adhoc = cli(w, ["dispatch", "--job", dir, "--worker", "terminal-7", "--prompt", prompt, "--cwd", themeFolder(w)], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(adhoc.code, 0, adhoc.stderr);
    assert.equal(adhoc.last.tokenProbe, undefined);

    const j = initJob(w);
    const plain = path.join(w.root, "plain-folder");
    fs.mkdirSync(plain, { recursive: true });
    const noBinding = attempt(w, j, "terminal-8", ["--cwd", plain], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(noBinding.code, 0, noBinding.stderr);
    assert.equal(noBinding.last.tokenProbe, undefined);
    // A --cwd that does not exist is a flag error, not a probe question.
    const missing = attempt(w, j, "terminal-9", ["--cwd", path.join(w.root, "nope")], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /is not a directory/);
  });
});
