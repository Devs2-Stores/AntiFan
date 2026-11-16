// leader-verify-adhoc.test.mjs - verify-adhoc runs only a narrow read-only allowlist (rg with a fixed flag set, node --check)
// and never starts a child for a refused command. The CLI path is driven through the real script.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { checkVerifyCommand, runVerifyEntry } from "../../scripts/leader/leader-job.mjs";
import { cleanup, cli, REPO, world } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const fwd = (p) => p.replace(/\\/g, "/");
const SELF = fwd(path.join(REPO, "scripts", "leader", "report.mjs")); // exists, under E:/Work/, contains "leader-report/1"
const MARK = "leader-report/1";

/** A spawn stub that records calls; a refused command must leave `calls` empty. */
const stub = (result = { status: 0, stdout: "" }) => {
  const calls = [];
  const spawn = (file, args, opts) => (calls.push({ file, args, opts }), result);
  return { calls, spawn };
};

function refused(cmd) {
  const s = stub();
  const r = runVerifyEntry({ cmd, expect: "" }, { spawn: s.spawn });
  assert.equal(r.verdict, "REFUSED", `${cmd} -> ${r.verdict} ${r.why ?? ""}`);
  assert.equal(s.calls.length, 0, `no child process for: ${cmd}`);
}

describe("allowlist", () => {
  test("rg flags that run programs or read config are refused without spawning", () => {
    for (const cmd of [
      `rg --pre node ${SELF}`,
      `rg --pre-glob * --pre node ${SELF}`,
      `rg --hostname-bin node ${SELF}`,
      `rg -z foo ${SELF}`,
      `rg --search-zip foo ${SELF}`,
      `rg --config E:/Work/x.toml foo ${SELF}`,
      `rg -ni foo ${SELF}`,
      `rg -- foo ${SELF}`,
      `rg -n foo`,
      `rg -n -e foo`,
      `rg -n foo E:/Work/definitely-missing-file.txt`,
      `rg -n foo C:/Windows/win.ini`,
      `rg -n foo E:/Work/../Windows`,
    ]) refused(cmd);
  });

  test("node is only allowed as `node --check <script under E:/Work/>`", () => {
    for (const cmd of [`node -e "1"`, `node -p 1`, `node --require x.js y.js`, `node --import x.mjs y.mjs`, `node --check C:/Windows/x.js`, `node --check ${SELF}.txt`, `node ${SELF}`, `node --check ${SELF} ${SELF}`]) refused(cmd);
  });

  test("other programs and shell metacharacters are refused", () => {
    for (const cmd of ["git status", "cat E:/Work/x", `rg -n foo ${SELF}; node -e 1`, `rg -n foo ${SELF} | node`, `rg -n foo ${SELF} > E:/Work/x`, `rg -n foo ${SELF} < x`, `rg -n foo ${SELF} && ls`, "rg -n `id` " + SELF, `rg -n $(id) ${SELF}`, ""]) refused(cmd);
  });

  test("a valid rg command is rewritten with --no-config first and runs without shell", () => {
    const c = checkVerifyCommand(`rg -n -i -e foo ${SELF}`);
    assert.deepEqual(c.argv, ["rg", "--no-config", "-n", "-i", "-e", "foo", SELF]);
    assert.deepEqual(checkVerifyCommand(`rg -F -e foo ${SELF}`).argv, ["rg", "--no-config", "-F", "-e", "foo", SELF]);
    assert.deepEqual(checkVerifyCommand(`rg -n -e "foo bar" ${SELF}`).argv.slice(-2), ["foo bar", SELF]);
    const s = stub({ status: 0, stdout: "x" });
    runVerifyEntry({ cmd: `rg -n -e foo ${SELF}`, expect: "x" }, { spawn: s.spawn });
    assert.equal(s.calls[0].opts.shell, false);
    assert.equal(s.calls[0].opts.timeout, 60_000);
    assert.deepEqual(s.calls[0].opts.stdio, ["ignore", "pipe", "pipe"]);
  });

  test("a bare pattern (no -e) and an unbalanced quote are refused", () => {
    refused(`rg -n foo ${SELF}`);
    refused(`rg -n -e "foo ${SELF}`);
  });
});

describe("running", () => {
  test("PASS when the command succeeds and expect is in stdout (real rg)", () => {
    const r = runVerifyEntry({ cmd: `rg -n -e ${MARK} ${SELF}`, expect: MARK });
    assert.equal(r.verdict, "PASS", JSON.stringify(r));
    assert.equal(r.exit, 0);
  });

  test("FAIL when expect does not match", () => {
    const r = runVerifyEntry({ cmd: `rg -n -e ${MARK} ${SELF}`, expect: "zzz-not-there-zzz" });
    assert.equal(r.verdict, "FAIL");
    assert.match(r.why, /expect not found/);
  });

  test("FAIL on a non-zero exit (rg finds nothing)", () => {
    const r = runVerifyEntry({ cmd: `rg -n -e qqq-no-such-text-qqq ${SELF}`, expect: "" });
    assert.equal(r.verdict, "FAIL");
    assert.equal(r.exit, 1);
  });

  test("node --check PASS on a real .mjs file, FAIL on a syntax error", () => {
    assert.equal(runVerifyEntry({ cmd: `node --check ${SELF}`, expect: "" }).verdict, "PASS");
    const bad = path.join(fs.mkdtempSync(path.join(REPO, "verify-adhoc-")), "bad.mjs");
    try {
      fs.writeFileSync(bad, "const = ;\n");
      assert.equal(runVerifyEntry({ cmd: `node --check ${fwd(bad)}`, expect: "" }).verdict, "FAIL");
    } finally {
      fs.rmSync(path.dirname(bad), { recursive: true, force: true });
    }
  });

  test("timeout is reported as FAIL", () => {
    const s = stub({ error: Object.assign(new Error("spawnSync rg ETIMEDOUT"), { code: "ETIMEDOUT" }), signal: "SIGTERM", stdout: "partial" });
    const r = runVerifyEntry({ cmd: `rg -n -e foo ${SELF}`, expect: "" }, { spawn: s.spawn, timeoutMs: 5 });
    assert.equal(r.verdict, "FAIL");
    assert.match(r.why, /timeout after 5 ms/);
    assert.equal(s.calls[0].opts.timeout, 5);
  });

  test("stdout is cut to 8 KB", () => {
    const s = stub({ status: 0, stdout: "a".repeat(20_000) });
    assert.equal(runVerifyEntry({ cmd: `rg -n -e foo ${SELF}`, expect: "" }, { spawn: s.spawn }).stdout.length, 8192);
  });
});

describe("config and NODE_OPTIONS are neutralised", () => {
  test("rg is on PATH (the PASS cases must really run)", () => {
    const r = spawnSync("rg", ["--version"], { encoding: "utf8" });
    assert.equal(r.status, 0, "rg must be on PATH for this suite");
  });

  test("a RIPGREP_CONFIG_PATH holding --pre=node is ignored: the pre command never runs", () => {
    const dir = fs.mkdtempSync(path.join(REPO, "verify-adhoc-pre-"));
    const marker = path.join(dir, "marker.txt");
    const target = path.join(dir, "target.js");
    const cfg = path.join(dir, "rgrc");
    fs.writeFileSync(target, `// ${MARK}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    fs.writeFileSync(cfg, "--pre=node\n");
    const saved = { rg: process.env.RIPGREP_CONFIG_PATH, node: process.env.NODE_OPTIONS };
    process.env.RIPGREP_CONFIG_PATH = cfg;
    process.env.NODE_OPTIONS = "--no-such-node-option-for-test";
    try {
      const s = stub();
      runVerifyEntry({ cmd: `rg -n -e foo ${SELF}`, expect: "" }, { spawn: s.spawn });
      assert.equal("RIPGREP_CONFIG_PATH" in s.calls[0].opts.env, false);
      assert.equal("NODE_OPTIONS" in s.calls[0].opts.env, false);
      assert.equal(s.calls[0].args[0], "--no-config");
      const r = runVerifyEntry({ cmd: `rg -n -e ${MARK} ${fwd(target)}`, expect: MARK });
      assert.equal(r.verdict, "PASS", JSON.stringify(r));
      assert.equal(fs.existsSync(marker), false, "the --pre from the config must not have run");
      assert.equal(runVerifyEntry({ cmd: `node --check ${SELF}`, expect: "" }).verdict, "PASS");
    } finally {
      if (saved.rg === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = saved.rg;
      if (saved.node === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved.node;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verify-adhoc command", () => {
  function jobWithReport(w, verify) {
    const r = cli(w, ["init", "--kind", "adhoc", "--slug", "va"]);
    assert.equal(r.code, 0, r.stderr);
    const dir = r.last.jobDir;
    const file = path.join(dir, "job.json");
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    const reportPath = fwd(path.join(dir, "va.report.md"));
    job.rounds = [{ n: 1, kind: "work", reportPath }];
    fs.writeFileSync(file, JSON.stringify(job));
    const json = { schema: "leader-report/1", status: "DONE", job: job.job, key: "va", round: 1, notChecked: [], verify };
    fs.writeFileSync(reportPath, `STATUS: DONE\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n`);
    return { dir, file, before: fs.readFileSync(file, "utf8") };
  }

  test("prints one line per command, exits 1 on any non-PASS, and records nothing", () => {
    const w = world();
    const j = jobWithReport(w, [
      { cmd: `rg -n -e ${MARK} ${SELF}`, expect: MARK },
      { cmd: `rg -n -e ${MARK} ${SELF}`, expect: "zzz-not-there-zzz" },
      { cmd: `rg --pre node ${SELF}`, expect: "" },
    ]);
    const r = cli(w, ["verify-adhoc", "--job", j.dir]);
    const lines = r.stdout.split("\n").filter((l) => /^(PASS|FAIL|REFUSED) /.test(l));
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^PASS exit=0 /);
    assert.match(lines[1], /^FAIL exit=0 /);
    assert.match(lines[2], /^REFUSED exit=- /);
    assert.deepEqual([r.last.pass, r.last.fail, r.last.refused], [1, 1, 1]);
    assert.equal(r.code, 1);
    assert.equal(fs.readFileSync(j.file, "utf8"), j.before, "job.json untouched");
  });

  test("exits 0 when every command passes", () => {
    const w = world();
    const j = jobWithReport(w, [{ cmd: `node --check ${SELF}`, expect: "" }]);
    assert.equal(cli(w, ["verify-adhoc", "--job", j.dir]).code, 0);
  });
});

describe("junctions out of E:/Work", () => {
  test("a path through a junction that leaves E:/Work is refused, a plain one passes", () => {
    fs.mkdirSync("E:/Work/scratch", { recursive: true });
    const dir = fs.mkdtempSync("E:/Work/scratch/verify-junction-");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "verify-outside-"));
    const link = path.join(dir, "link");
    const fw = (p) => p.replace(/\\/g, "/");
    try {
      fs.writeFileSync(path.join(outside, "x.txt"), "hello\n");
      fs.writeFileSync(path.join(dir, "plain.txt"), "hello\n");
      fs.writeFileSync(path.join(outside, "x.js"), "1;\n");
      assert.ok(!fw(fs.realpathSync.native(outside)).toLowerCase().startsWith("e:/work/"), "TEMP must be outside E:/Work");
      fs.symlinkSync(outside, link, "junction");
      const bad = checkVerifyCommand(`rg -n -e hello "${fw(link)}/x.txt"`);
      assert.match(bad.refused ?? "", /must be under E:\/Work/);
      const badDir = checkVerifyCommand(`rg -n -e hello "${fw(link)}"`);
      assert.match(badDir.refused ?? "", /must be under E:\/Work/);
      const badNode = checkVerifyCommand(`node --check "${fw(link)}/x.js"`);
      assert.match(badNode.refused ?? "", /must be under E:\/Work/);
      const ok = checkVerifyCommand(`rg -n -e hello "${fw(dir)}/plain.txt"`);
      assert.ok(ok.argv, JSON.stringify(ok));
    } finally {
      try { fs.rmSync(link, { force: true }); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
