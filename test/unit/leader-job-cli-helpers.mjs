// Shared helpers for the leader-job-*.test.mjs files: a hermetic world (temp jobs root + runs dir) and a
// no-sheet job driven through the real CLI. Not a test file itself.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = path.join(REPO, "scripts", "leader", "leader-job.mjs");

export const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "leader-job-x-"));
export const cleanup = () => fs.rmSync(TEMP, { recursive: true, force: true });

let counter = 0;
/** Fresh isolated world. Learning is off unless a test turns it on. */
export function world(extraEnv = {}) {
  const root = path.join(TEMP, `w${++counter}`);
  const jobs = path.join(root, "jobs");
  const runs = path.join(root, "runs");
  const config = path.join(root, "config");
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("ANTIFAN_") && k !== "ELECTRON_RUN_AS_NODE" && k !== "SUPER_CORE_DB") env[k] = v;
  // ANTIFAN_CONFIG_DIR keeps dispatch off the real Leader registry (the default is the live data root).
  Object.assign(env, { LEADER_JOBS_ROOT: jobs, LEADER_RUNS_DIR: runs, ANTIFAN_CONFIG_DIR: config, ANTIFAN_TERMINAL_SESSION_ID: "terminal-1", LEADER_LEARN: "off", ...extraEnv });
  return { root, jobs, runs, config, env };
}

export function cli(w, args, envOverride = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...w.env, ...envOverride } });
  const lines = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  return { code: r.status, lines, last: lines.at(-1), stderr: r.stderr, stdout: r.stdout };
}

export const writeRun = (w, terminal, patch) =>
  fs.writeFileSync(
    path.join(w.runs, `${terminal}.json`),
    JSON.stringify({ schema: 1, terminalSessionId: terminal, ompSessionId: "omp-old", state: "idle", runSeq: 0, lastEventAt: 1, updatedAt: Date.now(), ...patch }),
  );

/** A job without a sheet (required verification: dashboard only). */
export function initJob(w, slug = "job", issueId = "1") {
  const r = cli(w, ["init", "--slug", slug, "--issue-id", issueId, "--shop", "s.example", "--no-sheet"]);
  if (r.code !== 0) throw new Error(`init failed: ${r.stderr}`);
  const dir = r.last.jobDir;
  return { dir, job: () => JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")), patch: (fn) => {
    const file = path.join(dir, "job.json");
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    fn(job);
    fs.writeFileSync(file, JSON.stringify(job, null, 2));
  } };
}

/** Dispatch a round with a hand-made prompt that names the report path and the guard values. */
export function dispatch(w, j, worker, kind, body = "", extra = []) {
  const n = j.job().rounds.length + 1;
  const file = path.join(w.root, `prompt-${path.basename(j.dir)}-${n}.md`);
  fs.writeFileSync(file, `Việc của vòng ${n}. issue ${j.job().subject.issueId} host Taiz shop s.example.\n${body}\nGhi report vào {{REPORT_PATH}}\n`);
  return cli(w, ["dispatch", "--job", j.dir, "--worker", worker, "--prompt", file, ...(kind ? ["--kind", kind] : []), ...extra]);
}

/** Make the worker's n-th turn finish, then let `wait` settle the round. */
export function settle(w, j, worker, runSeq) {
  writeRun(w, worker, { ompSessionId: "omp-new", state: "idle", runSeq, lastEventAt: Date.now() + 60_000 });
  return cli(w, ["wait", "--job", j.dir, "--poll-ms", "20", "--timeout-min", "0.05"]);
}

export function reportText(job, round, over = {}) {
  const json = {
    schema: "leader-report/1",
    status: "DONE",
    job: job.job,
    key: job.slug,
    round,
    guard: { issueId: job.subject.issueId, host: job.subject.host, shop: job.subject.shop, sheetId: job.subject.sheetId },
    summary: "ok",
    dashboard: { commentsAdded: 1, stageBefore: "Feedback", stageAfter: "Feedback" },
    notChecked: ["nothing else"],
    ...over,
  };
  return `STATUS: ${json.status}\n\nprose\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

export const writeReport = (j, round, over) => {
  const job = j.job();
  fs.writeFileSync(job.rounds[round - 1].reportPath, reportText(job, round, over));
};

/** Round 1 worked, validated and verified by the Leader: job state verified. */
export function verifiedJob(w, j, worker = "terminal-7") {
  const d = dispatch(w, j, worker, "work");
  if (d.code !== 0) throw new Error(`dispatch failed: ${d.stderr}`);
  settle(w, j, worker, 1);
  writeReport(j, 1);
  const v = cli(w, ["validate-report", "--job", j.dir]);
  if (v.code !== 0) throw new Error(`validate failed: ${v.stderr}`);
  const r = cli(w, ["record", "--job", j.dir, "--round", "1", "--kind", "dashboard", "--status", "PASS"]);
  if (r.last.state !== "verified") throw new Error(`not verified: ${JSON.stringify(r.last)}`);
}
