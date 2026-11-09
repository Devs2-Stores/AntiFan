import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { main, normalizeSignature, renderProposals, scanJobs } from "../../scripts/leader/improve-scan.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "leader", "improve-scan.mjs");
const NOW = Date.UTC(2026, 10, 9, 12);
const DAY = 24 * 3600 * 1000;
const tmps = [];
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iscan-"));
  tmps.push(d);
  return d;
};
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const FORBIDDEN = /src[\\/]omp-hooks|leader-guard|edit-guard|theme-push-policy|AGENTS\.md|CLAUDE\.md|~[\\/]\.omp|\bhooks?\b|\bguards?\b/i;

function putJob(root, name, over = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const job = { schema: "leader-job/1", job: name, createdAt: NOW - DAY, updatedAt: NOW - DAY, state: "closed", rounds: [], ...over };
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job));
  return dir;
}

function fixtureRoot() {
  const root = mk();
  const d1 = putJob(root, "j1", {});
  const rep = path.join(d1, "r.report.md");
  fs.writeFileSync(rep, "STATUS: FAILED\nREFUSED_THEME_PUSH_NODELETE while pushing\n");
  fs.writeFileSync(path.join(d1, "job.json"), JSON.stringify({
    schema: "leader-job/1", job: "j1", createdAt: NOW - DAY, updatedAt: NOW - DAY, state: "closed",
    rounds: [
      { n: 1, deadWhy: "run file gone for 183s (pid 4242, terminal-17)", reportPath: rep },
      { n: 2, report: { valid: false, errors: ["round mismatch: report 3 vs round 2"] }, reportPath: path.join(d1, "none.md") },
    ],
  }));
  putJob(root, "j2", { rounds: [{ n: 1, deadWhy: "run file gone for 95s (pid 77, terminal-3)" }, { n: 2, deadWhy: "undelivered: idle for 91s", undelivered: true }] });
  putJob(root, "j-old", { updatedAt: NOW - 90 * DAY, createdAt: NOW - 90 * DAY, rounds: [{ n: 1, deadWhy: "ancient failure" }] });
  return root;
}

describe("normalizeSignature", () => {
  it("replaces numbers, pids, terminal ids, hashes, uuids and paths", () => {
    assert.equal(normalizeSignature("run file gone for 183s (pid 4242, terminal-17)"), "run file gone for Ns (pid N, terminal-N)");
    assert.equal(normalizeSignature("cannot read E:\\Work\\scratch\\x\\a.md"), "cannot read <path>");
    assert.equal(normalizeSignature("see /tmp/a/b.txt now"), "see <path> now");
    assert.equal(normalizeSignature("commit deadbeef12 and 3b6f1a2c-1111-4222-8333-444455556666"), "commit <hash> and <id>");
  });
});

describe("scanJobs", () => {
  it("groups by signature, counts, lists example jobs, honours sinceDays", () => {
    const s = scanJobs({ jobsRoot: fixtureRoot(), now: NOW, sinceDays: 30 });
    assert.equal(s.jobsScanned, 2);
    const dead = s.signatures.find((x) => x.kind === "dead");
    assert.equal(dead.signature, "run file gone for Ns (pid N, terminal-N)");
    assert.equal(dead.count, 2);
    assert.deepEqual(dead.examples.sort(), ["j1", "j2"]);
    assert.equal(s.signatures.find((x) => x.kind === "undelivered").count, 1);
    assert.equal(s.signatures.find((x) => x.kind === "refused").signature, "REFUSED_THEME_PUSH_NODELETE");
    assert.equal(s.signatures.find((x) => x.kind === "invalid-report").signature, "round mismatch: report N vs round N");
    assert.ok(!s.signatures.some((x) => /ancient/.test(x.signature)));
    assert.equal(scanJobs({ jobsRoot: fixtureRoot(), now: NOW, sinceDays: 365 }).jobsScanned, 3);
  });

  it("reads REFUSED codes from audit jsonl files", () => {
    const audit = mk();
    fs.writeFileSync(path.join(audit, "a.jsonl"), '{"code":"REFUSED_THEME_FORCE"}\n{"code":"REFUSED_THEME_FORCE"}\n');
    fs.writeFileSync(path.join(audit, "ignored.txt"), "REFUSED_NOT_JSONL");
    const s = scanJobs({ jobsRoot: mk(), auditDirs: [audit], now: Date.now(), sinceDays: 30 });
    assert.equal(s.auditFilesScanned, 1);
    assert.equal(s.signatures.length, 1);
    assert.equal(s.signatures[0].count, 2);
    assert.deepEqual(s.signatures[0].examples, ["audit:a.jsonl"]);
  });
});

describe("renderProposals", () => {
  it("states each proposal with signature, count, examples and an allowed target", () => {
    const md = renderProposals(scanJobs({ jobsRoot: fixtureRoot(), now: NOW }));
    assert.match(md, /Signature: `run file gone for Ns \(pid N, terminal-N\)`/);
    assert.match(md, /Count: 2 \(recurring\)/);
    assert.match(md, /Example jobs: j1, j2|Example jobs: j2, j1/);
    assert.match(md, /Suggested target: leader script thresholds/);
    assert.match(md, /Suggested target: worker header\/templates/);
    assert.match(md, /human-only/);
    assert.match(md, /Nothing here is applied/);
  });

  it("never names enforcement code or instruction files, even when a failure text tries to", () => {
    const root = mk();
    putJob(root, "j-evil", {
      rounds: [
        { n: 1, deadWhy: "blocked by edit-guard; fix src/omp-hooks/theme-push-policy.ts and AGENTS.md and CLAUDE.md" },
        { n: 2, deadWhy: "leader-guard refused ~/.omp/agent/hooks stop guards", report: { valid: false, errors: ["hook said no; update the guards in ~/.omp/agent/hooks"] } },
      ],
    });
    const audit = mk();
    fs.writeFileSync(path.join(audit, "edit-guard.jsonl"), '{"code":"REFUSED_THEME_PUSH"}\n');
    const scan = scanJobs({ jobsRoot: root, auditDirs: [audit], now: NOW });
    assert.ok(scan.signatures.length >= 3);
    const md = renderProposals(scan);
    assert.doesNotMatch(md, FORBIDDEN);
    assert.match(md, /\[withheld\]/);
    assert.match(md, /human-only/);
    for (const s of scan.signatures) assert.doesNotMatch(JSON.stringify(s), FORBIDDEN);
  });

  it("says so when nothing recurs", () => {
    assert.match(renderProposals(scanJobs({ jobsRoot: mk(), now: NOW })), /No recurring failures found/);
  });
});

describe("CLI", () => {
  it("exit 2 on usage errors", () => {
    for (const args of [["--bogus"], ["--since-days", "abc"], ["--jobs-root"], ["--since-days", "0"]]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /Usage:/);
    }
  });

  it("main prints to stdout, or writes only --out; the ledger stays untouched", () => {
    const root = fixtureRoot();
    const snap = () => fs.readdirSync(root, { recursive: true }).sort().map((f) => `${f}|${fs.statSync(path.join(root, f)).mtimeMs}`);
    const before = snap();
    let out = "";
    assert.equal(main(["--jobs-root", root, "--since-days", "365"], { stdout: (s) => (out += s), stderr: () => {} }), 0);
    assert.match(out, /# Leader improvement proposals/);
    const outFile = path.join(mk(), "sub", "p.md");
    out = "";
    assert.equal(main(["--jobs-root", root, "--since-days", "365", "--out", outFile], { stdout: (s) => (out += s), stderr: () => {} }), 0);
    assert.equal(out, "");
    assert.match(fs.readFileSync(outFile, "utf8"), /Count: 2/);
    assert.deepEqual(snap(), before);
  });

  it("runs as a script with exit 0", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--jobs-root", fixtureRoot(), "--since-days", "365"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Leader improvement proposals/);
  });
});
