import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildBoard } from "../../scripts/leader/board.mjs";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const H = 3600 * 1000;
const tmps = [];
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
  tmps.push(d);
  return d;
};
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function putJob(root, name, over = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const job = { schema: "leader-job/1", job: name, createdAt: NOW - 100 * H, updatedAt: NOW - H, leader: { terminal: "terminal-1" }, state: "open", rounds: [], ...over };
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job));
  return path.join(dir, "job.json");
}
const round = (n, extra = {}) => ({ n, kind: "work", worker: { terminal: "w-1" }, preRunSeq: 0, settledAt: null, ...extra });

function fixtureRoot() {
  const root = mk();
  putJob(root, "j-other", { state: "dispatched", rounds: [round(1)] });
  putJob(root, "j-stale", { state: "dispatched", updatedAt: NOW - 30 * H, rounds: [round(1)] });
  putJob(root, "j-verified", { state: "verified", rounds: [round(1, { settledAt: 1 })] });
  putJob(root, "j-dead", { state: "worker_dead", rounds: [round(1, { deadAt: 1, deadWhy: "run file gone" })] });
  putJob(root, "j-input", { state: "needs_input", rounds: [round(1)] });
  putJob(root, "j-closed", { state: "closed", closedAt: NOW - 2 * H, rounds: [round(1, { settledAt: 1 })] });
  return root;
}

describe("buildBoard", () => {
  it("orders needs_input, dead, waiting-for-user, stale, others; omits closed", () => {
    const b = buildBoard({ jobsRoot: fixtureRoot(), now: NOW });
    assert.deepEqual(b.rows.map((r) => r.job), ["j-input", "j-dead", "j-verified", "j-stale", "j-other"]);
    assert.deepEqual(b.needsMe, ["j-input", "j-dead", "j-verified", "j-stale"]);
    assert.equal(b.at, NOW);
    const dead = b.rows.find((r) => r.job === "j-dead");
    assert.equal(dead.deadWhy, "run file gone");
    assert.equal(dead.rounds, 1);
    assert.match(dead.blocking, /died in round 1/);
    assert.equal(b.text.split("\n")[0], "Leader board (5 jobs, 4 need you)");
    assert.ok(b.text.indexOf("j-input") < b.text.indexOf("j-dead"));
  });

  it("detects stale jobs with the injected clock and staleHours", () => {
    const root = fixtureRoot();
    const b = buildBoard({ jobsRoot: root, now: NOW });
    assert.deepEqual(b.rows.filter((r) => r.stale).map((r) => r.job), ["j-stale"]);
    assert.equal(b.rows.find((r) => r.job === "j-stale").ageHours, 30);
    const tight = buildBoard({ jobsRoot: root, now: NOW, staleHours: 0.5 });
    assert.ok(tight.rows.find((r) => r.job === "j-other").stale);
    const none = buildBoard({ jobsRoot: root, now: NOW, staleHours: 1000 });
    assert.equal(none.rows.filter((r) => r.stale).length, 0);
    assert.ok(!none.needsMe.includes("j-stale"));
  });

  it("includes closed jobs only on request and never flags them", () => {
    const root = fixtureRoot();
    assert.ok(!buildBoard({ jobsRoot: root, now: NOW }).rows.some((r) => r.job === "j-closed"));
    const b = buildBoard({ jobsRoot: root, now: NOW, includeClosed: true });
    const c = b.rows.find((r) => r.job === "j-closed");
    assert.ok(c);
    assert.equal(c.needsMe, false);
    assert.equal(c.stale, false);
  });

  it("filters by leader terminal", () => {
    const root = fixtureRoot();
    putJob(root, "j-foreign", { leader: { terminal: "terminal-9" }, state: "needs_input" });
    const mine = buildBoard({ jobsRoot: root, leader: "terminal-1", now: NOW });
    assert.ok(!mine.rows.some((r) => r.job === "j-foreign"));
    assert.deepEqual(buildBoard({ jobsRoot: root, leader: "terminal-9", now: NOW }).needsMe, ["j-foreign"]);
  });

  it("stays within one screen (<= 40 lines)", () => {
    const root = mk();
    for (let i = 0; i < 80; i++) putJob(root, `j-${String(i).padStart(3, "0")}`, { state: "needs_input" });
    const b = buildBoard({ jobsRoot: root, now: NOW });
    assert.equal(b.rows.length, 80);
    const lines = b.text.split("\n");
    assert.ok(lines.length <= 40, `got ${lines.length} lines`);
    assert.match(lines.at(-1), /more not shown/);
  });

  it("skips unreadable or foreign job.json and a missing root", () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, "j-broken"));
    fs.writeFileSync(path.join(root, "j-broken", "job.json"), "{ not json");
    fs.mkdirSync(path.join(root, "j-nofile"));
    putJob(root, "j-schema", { schema: "other/9" });
    const b = buildBoard({ jobsRoot: root, now: NOW });
    assert.equal(b.rows.length, 5);
    const empty = buildBoard({ jobsRoot: path.join(root, "nope"), now: NOW });
    assert.deepEqual(empty.rows, []);
    assert.match(empty.text, /no open jobs/);
  });

  it("flags a dispatched round whose worker already went idle (runsDir)", () => {
    const root = mk();
    const runs = mk();
    putJob(root, "j-fin", { state: "dispatched", rounds: [round(1, { preRunSeq: 2 })] });
    fs.writeFileSync(path.join(runs, "w-1.json"), JSON.stringify({ state: "idle", runSeq: 3 }));
    const b = buildBoard({ jobsRoot: root, runsDir: runs, now: NOW });
    assert.match(b.rows[0].blocking, /FINISHED round 1/);
    assert.deepEqual(b.needsMe, ["j-fin"]);
    fs.writeFileSync(path.join(runs, "w-1.json"), JSON.stringify({ state: "running", runSeq: 3 }));
    assert.deepEqual(buildBoard({ jobsRoot: root, runsDir: runs, now: NOW }).needsMe, []);
  });

  it("is read-only: file bytes and mtimes are unchanged and no file is added", () => {
    const root = fixtureRoot();
    const runs = mk();
    const snap = () =>
      fs
        .readdirSync(root, { recursive: true })
        .sort()
        .map((f) => {
          const p = path.join(root, f);
          const st = fs.statSync(p);
          return `${f}|${st.mtimeMs}|${st.isFile() ? fs.readFileSync(p, "utf8") : ""}`;
        });
    const before = snap();
    buildBoard({ jobsRoot: root, runsDir: runs, now: NOW, includeClosed: true });
    buildBoard({ jobsRoot: root, now: NOW });
    assert.deepEqual(snap(), before);
    assert.deepEqual(fs.readdirSync(runs), []);
  });
});
