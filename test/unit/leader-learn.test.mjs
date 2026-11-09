import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildOutcome, ingestOutcome, listPending } from "../../scripts/leader/learn.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmps = [];
const mk = (p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${p}-`));
  tmps.push(d);
  return d;
};
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** packages/super-core/dist is build output (gitignored): use this checkout's, else the main checkout's of the same repo. */
function findDist() {
  const cands = [path.join(REPO, "packages", "super-core")];
  const g = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO, encoding: "utf8" });
  if (g.status === 0) cands.push(path.join(path.dirname(g.stdout.trim()), "packages", "super-core"));
  return cands.find((c) => fs.existsSync(path.join(c, "dist", "index.js"))) ?? null;
}

/** A private copy of the Core CLI + built package so the real code runs against a temp db only. */
function coreSandbox() {
  const pkg = findDist();
  if (!pkg) return null;
  const root = mk("learn-core");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts", "antifan-core.cjs"), path.join(root, "scripts", "antifan-core.cjs"));
  fs.cpSync(path.join(pkg, "dist"), path.join(root, "packages", "super-core", "dist"), { recursive: true });
  fs.copyFileSync(path.join(pkg, "package.json"), path.join(root, "packages", "super-core", "package.json"));
  return {
    root,
    coreScript: path.join(root, "scripts", "antifan-core.cjs"),
    env: { ...process.env, SUPER_CORE_DB: path.join(root, "core.db"), LEADER_LEARN: "on", NODE_NO_WARNINGS: "1" },
  };
}

function fixtureJob() {
  const dir = mk("learn-job");
  const report = path.join(dir, "fx.report.md");
  fs.writeFileSync(
    report,
    `STATUS: DONE\n\n\`\`\`json\n${JSON.stringify({ schema: "leader-report/1", status: "DONE", summary: "fixed header overflow", files: ["sections/header.liquid"], pushed: ["sections/header.liquid"], notChecked: [] })}\n\`\`\`\n`,
  );
  return {
    schema: "leader-job/1",
    job: "261109-1000-fx",
    createdAt: Date.UTC(2026, 10, 9, 3),
    closedAt: Date.UTC(2026, 10, 9, 9),
    state: "closed",
    subject: { kind: "feedback", issueId: "1234", shop: "demo-shop" },
    rounds: [
      { n: 1, kind: "work", deadAt: 1, deadWhy: "run file gone", reportPath: path.join(dir, "missing.md"), report: null },
      { n: 2, kind: "followup", reportPath: report, report: { valid: true, status: "DONE" } },
    ],
  };
}

describe("buildOutcome", () => {
  it("summarises subject, rounds, last valid report, dead rounds and dates it", () => {
    const job = fixtureJob();
    const o = buildOutcome(job);
    assert.match(o.task, /261109-1000-fx/);
    assert.match(o.task, /issue 1234 @ demo-shop/);
    assert.match(o.task, /closed 2026-11-09/);
    assert.match(o.outcome, /2 rounds/);
    assert.match(o.outcome, /final state closed/);
    assert.match(o.outcome, /round 2 \(followup\) status DONE/);
    assert.match(o.outcome, /files: sections\/header\.liquid/);
    assert.match(o.outcome, /pushed: sections\/header\.liquid/);
    assert.match(o.outcome, /dead rounds: r1: run file gone/);
    assert.equal(o.verificationRef, job.rounds[1].reportPath);
  });

  it("copes with a job without any valid report", () => {
    const o = buildOutcome({ job: "x", state: "open", rounds: [] });
    assert.equal(o.verificationRef, null);
    assert.match(o.outcome, /no valid report/);
  });
});

describe("ingestOutcome / listPending (real Core on a temp db)", () => {
  const sb = coreSandbox();
  const opts = { skip: sb ? false : "packages/super-core/dist not built anywhere" };

  it("one outcome creates exactly one PENDING candidate", opts, () => {
    const r = ingestOutcome(fixtureJob(), { coreScript: sb.coreScript, cwd: sb.root, env: sb.env });
    assert.equal(r.ok, true, r.error);
    assert.match(r.caseId, /^case-/);
    assert.match(r.candidateId, /^cand-/);
    const p = listPending({ coreScript: sb.coreScript, cwd: sb.root, env: sb.env });
    assert.equal(p.ok, true, p.error);
    assert.equal(p.candidates.length, 1);
    assert.equal(p.candidates[0].candidateId, r.candidateId);
    assert.equal(p.candidates[0].status, "PENDING");
    assert.ok(fs.existsSync(path.join(sb.root, "core.db")), "wrote the temp db");
  });
});

describe("fail-open behaviour", () => {
  it("LEADER_LEARN=off never spawns", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      throw new Error("must not run");
    };
    const env = { ...process.env, LEADER_LEARN: "off" };
    assert.deepEqual(
      (({ ok, error }) => ({ ok, error }))(ingestOutcome(fixtureJob(), { env, spawn })),
      { ok: false, error: "disabled" },
    );
    const p = listPending({ env, spawn });
    assert.equal(p.ok, false);
    assert.equal(p.error, "disabled");
    assert.equal(calls, 0);
  });

  it("a missing core script gives ok:false without throwing", () => {
    const env = { ...process.env, LEADER_LEARN: "on" };
    const r = ingestOutcome(fixtureJob(), { coreScript: path.join(os.tmpdir(), "no-such-core-xyz.cjs"), env });
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/);
    assert.equal(listPending({ coreScript: path.join(os.tmpdir(), "no-such-core-xyz.cjs"), env }).ok, false);
  });

  it("an invalid core script (non-zero exit, non-JSON output, spawn throw) gives ok:false", () => {
    const dir = mk("learn-bad");
    const env = { ...process.env, LEADER_LEARN: "on" };
    const exits = path.join(dir, "exit1.cjs");
    fs.writeFileSync(exits, "console.error('boom'); process.exit(1);\n");
    const junk = path.join(dir, "junk.cjs");
    fs.writeFileSync(junk, "console.log('not json');\n");
    const a = ingestOutcome(fixtureJob(), { coreScript: exits, env });
    assert.equal(a.ok, false);
    assert.match(a.error, /exit 1/);
    const b = ingestOutcome(fixtureJob(), { coreScript: junk, env });
    assert.equal(b.ok, false);
    assert.match(b.error, /not JSON/);
    const c = ingestOutcome(fixtureJob(), { coreScript: junk, env, spawn: () => { throw new Error("kaput"); } });
    assert.equal(c.ok, false);
    assert.match(c.error, /kaput/);
    assert.equal(listPending({ coreScript: exits, env }).ok, false);
  });

  it("a timeout is reported, not thrown", () => {
    const dir = mk("learn-slow");
    const slow = path.join(dir, "slow.cjs");
    fs.writeFileSync(slow, "setTimeout(() => {}, 20000);\n");
    const r = ingestOutcome(fixtureJob(), { coreScript: slow, env: { ...process.env, LEADER_LEARN: "on" }, timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });
});
