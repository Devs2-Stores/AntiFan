// leader-dispatch-memory.test.mjs - a Leader's fresh dispatch starts another omp.exe, so it is
// refused while AntiFan reports Windows commit headroom under the floor. The reading comes from
// commit-pressure.json next to the runs dir; a missing, stale or unreadable reading never blocks.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "scripts", "leader", "leader-job.mjs");
const FIX = path.join(REPO, "test", "fixtures", "leader-job");
const GB = 1024 ** 3;

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "leader-dispatch-memory-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

let counter = 0;
function world() {
  const root = path.join(TEMP, `w${++counter}`);
  const runtime = path.join(root, "runtime");
  const runs = path.join(runtime, "runs");
  fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("ANTIFAN_") && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
  env.LEADER_JOBS_ROOT = path.join(root, "jobs");
  env.LEADER_RUNS_DIR = runs;
  env.ANTIFAN_TERMINAL_SESSION_ID = "terminal-1";
  return { root, runtime, runs, env };
}

function cli(w, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: w.env });
  const lines = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  return { code: r.status, last: lines.at(-1), stderr: r.stderr };
}

/** A job whose round-1 prompt is filled in, ready to dispatch. */
function readyJob(w) {
  const snap = path.join(w.root, "snapshot.csv");
  fs.copyFileSync(path.join(FIX, "whenever-before.csv"), snap);
  const init = cli(w, [
    "init", "--slug", "mem-job", "--issue-id", "9282", "--shop", "whenever.myshopify.com",
    "--sheet", "SHEETWHEN", "--gid", "0", "--snapshot-file", snap,
  ]);
  assert.equal(init.code, 0, init.stderr);
  const dir = init.last.jobDir;
  const prompt = path.join(dir, "mem-job.prompt.md");
  fs.writeFileSync(prompt, fs.readFileSync(prompt, "utf8").replace("{{TASK}}", "việc"));
  return { dir, prompt, rounds: () => JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")).rounds.length };
}

const writeReading = (w, patch) =>
  fs.writeFileSync(
    path.join(w.runtime, "commit-pressure.json"),
    JSON.stringify({ schema: 1, at: Date.now(), chargeBytes: 30 * GB, maxLimitBytes: 36 * GB, headroomBytes: 6 * GB, floorBytes: 8 * GB, alarmed: false, ...patch }),
  );

const writeRun = (w, terminal, patch) =>
  fs.writeFileSync(
    path.join(w.runs, `${terminal}.json`),
    JSON.stringify({ schema: 1, terminalSessionId: terminal, ompSessionId: "omp-old", state: "idle", runSeq: 1, lastEventAt: 1, updatedAt: 1, ...patch }),
  );

describe("dispatch under commit pressure", () => {
  test("a fresh worker is refused under the floor, leaves no round, and --allow-low-memory overrides", () => {
    const w = world();
    const j = readyJob(w);
    writeReading(w, { headroomBytes: 6 * GB });
    const refused = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt]);
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /memory is short: Windows commit headroom is 6\.0 GB, under the 8\.0 GB floor/);
    assert.equal(j.rounds(), 0, "a refused dispatch leaves no round");

    const forced = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt, "--allow-low-memory"]);
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.last.mode, "fresh");
  });

  test("an alarmed reading refuses even when headroom has crept back over the floor", () => {
    const w = world();
    const j = readyJob(w);
    writeReading(w, { headroomBytes: 9 * GB, alarmed: true });
    assert.equal(cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt]).code, 4);
  });

  test("a follow-up to a live session starts no process and is not gated", () => {
    const w = world();
    const j = readyJob(w);
    writeReading(w, { headroomBytes: 1 * GB, alarmed: true });
    writeRun(w, "terminal-7", { state: "idle", ompSessionId: "omp-live" });
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt]);
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.mode, "followup");
  });

  test("headroom at or over the floor, or no usable reading, lets a fresh worker start", () => {
    for (const [label, setup] of [
      ["at the floor", (w) => writeReading(w, { headroomBytes: 8 * GB })],
      ["no reading (AntiFan not running)", () => {}],
      ["stale reading (Main stopped sampling)", (w) => writeReading(w, { headroomBytes: 1 * GB, at: Date.now() - 5 * 60_000 })],
      ["unreadable reading", (w) => fs.writeFileSync(path.join(w.runtime, "commit-pressure.json"), "{not json")],
      ["unknown schema", (w) => writeReading(w, { schema: 2, headroomBytes: 1 * GB })],
    ]) {
      const w = world();
      const j = readyJob(w);
      setup(w);
      const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", j.prompt]);
      assert.equal(d.code, 0, `${label}: ${d.stderr}`);
    }
  });
});
