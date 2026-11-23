// dispatch preflight: a bound Haravan theme folder is probed for a usable hrv session before a worker round is spent on it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { TEMP, cleanup, cli, initJob, world } from "./leader-job-cli-helpers.mjs";

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
  test("an expired token refuses the work dispatch, names hrv login and records no round", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    const refused = attempt(w, j, "terminal-7", ["--cwd", theme], { LEADER_TOKEN_PROBE: FAIL() });
    assert.equal(refused.code, 4, refused.stderr);
    assert.match(refused.stderr, /hrv token is not usable/);
    assert.match(refused.stderr, /Token hết hạn/);
    assert.match(refused.stderr, /hrv login/);
    assert.match(refused.last.next, /hrv login/);
    assert.match(refused.last.next, /dispatch --job/);
    assert.equal(j.job().state, "open");
    assert.equal(j.job().rounds.length, 0, "no round was recorded");
  });

  test("--skip-token-probe, an unaskable probe and a healthy one let the dispatch through and report the result", () => {
    const w = world();
    const j = initJob(w);
    const theme = themeFolder(w);
    const skipped = attempt(w, j, "terminal-7", ["--cwd", theme, "--skip-token-probe"], { LEADER_TOKEN_PROBE: FAIL() });
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
