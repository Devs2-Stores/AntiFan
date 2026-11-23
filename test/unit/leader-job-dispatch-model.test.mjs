// dispatch reads the worker's model before it spends a round: a 9router/cc route is refused (its tool names carry an
// _ide suffix the runtime rejects), an active credential block of the model's provider only warns, and an unknown model
// never blocks the round. worker-status answers from the same resolver, so the two can never disagree.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { providerBlock, readConfiguredDefaultModel, resolveWorkerModel } from "../../scripts/leader/worker-model.mjs";
import { status } from "../../scripts/leader/worker-status.mjs";
import { TEMP, cleanup, cli, dispatch, initJob, world, writeRun } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const OMP_ID = "01a1a204-61ed-74d8-8cc4-818fcfdc0eaf";
const HOUR = 60 * 60_000;
/** A credential payload that must never reach the output: the reader selects columns, never this blob. */
const SECRET = "sk-live-must-never-be-printed-7c1d";
let n = 0;

/** A temp OMP home: sessions dir, config.yml with modelRoles.default, and the auth DB beside it. */
function ompHome({ defaultModel = null, quoted = false, rows = null, db = "sqlite" } = {}) {
  const dir = path.join(TEMP, `omp-${++n}`);
  const sessions = path.join(dir, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const config = path.join(dir, "config.yml");
  const lines = ["shellPath: C:\\Program Files\\Git\\bin\\bash.exe", "modelRoles:"];
  if (defaultModel) lines.push(`  task: some/task-model:max`, `  default: ${quoted ? `"${defaultModel}"` : defaultModel}`);
  else lines.push("  task: some/task-model:max");
  lines.push("theme:", "  dark: titanium", "");
  fs.writeFileSync(config, lines.join("\n"));
  const dbFile = path.join(dir, "agent.db");
  if (db === "garbage") fs.writeFileSync(dbFile, "this is not a sqlite database");
  if (rows) agentDb(dbFile, rows);
  return { dir, sessions, config, dbFile, env: { OMP_SESSIONS_DIR: sessions, OMP_CONFIG_FILE: config } };
}

/** The two tables of the OMP auth DB the reader touches; `data` holds a secret the output must never repeat. */
function agentDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE auth_credentials (
             id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL,
             data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL);
           CREATE TABLE auth_credential_blocks (
             credential_id INTEGER NOT NULL, provider_key TEXT NOT NULL, block_scope TEXT NOT NULL DEFAULT '',
             blocked_until_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL,
             PRIMARY KEY (credential_id, provider_key, block_scope));`);
  for (const row of rows) {
    db.prepare("INSERT OR IGNORE INTO auth_credentials (id, provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?, ?)").run(
      row.credentialId,
      row.provider,
      "oauth",
      SECRET,
      row.disabledCause ?? null,
    );
    db.prepare("INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      row.credentialId,
      row.providerKey,
      row.scope ?? "",
      row.until,
      Date.now(),
    );
  }
  db.close();
}

/** Write one OMP transcript for `OMP_ID` under a project slug, body built from records. */
function transcript(sessions, records, { cwd = "E:\\Work\\x", id = OMP_ID } = {}) {
  const slug = `--${cwd.replace(/[\\/:]/g, "-")}--`;
  const base = path.join(sessions, slug);
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, `2026-11-20T07-22-54-460Z_${id}.jsonl`);
  fs.writeFileSync(file, `${records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`);
  return file;
}

const modelChange = (model) => ({ type: "model_change", timestamp: "2026-11-20T07:22:56.205Z", model });
const modelUsage = (model) => ({ type: "model_usage", timestamp: "2026-11-20T09:00:00.000Z", model });

describe("dispatch refuses a 9router/cc model", () => {
  test("a fresh pane whose configured default is on that route is refused before a round is recorded", () => {
    const home = ompHome({ defaultModel: "9router/cc/claude-haiku-5-5:max" });
    const w = world(home.env);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /9router\/cc\/claude-haiku-5-5/);
    assert.match(r.stderr, /_ide/);
    assert.match(r.stderr, /close-worker\.mjs terminal-7/);
    assert.match(r.last.next, /--allow-ide-suffix-model/);
    assert.equal(r.last.model, "9router/cc/claude-haiku-5-5");
    assert.equal(r.last.modelSource, "config");
    assert.equal(j.job().rounds.length, 0, "no round was recorded");
    assert.equal(j.job().state, "open");
  });

  test("--allow-ide-suffix-model lets the round through and records the model it ran on", () => {
    const home = ompHome({ defaultModel: "9router/cc/claude-haiku-5-5" });
    const w = world(home.env);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work", "", ["--allow-ide-suffix-model"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.model, "9router/cc/claude-haiku-5-5");
    const round = j.job().rounds[0];
    assert.equal(round.worker.model, "9router/cc/claude-haiku-5-5");
    assert.equal(round.worker.modelSource, "config");
  });

  test("a follow-up pane answers from its own transcript and names where the verdict came from", () => {
    const home = ompHome({ defaultModel: "anthropic/claude-sonnet-5-5" });
    const w = world(home.env);
    writeRun(w, "terminal-7", { ompSessionId: OMP_ID, runSeq: 1 });
    transcript(home.sessions, [modelChange("9router/cc/claude-sonnet-5-5"), modelUsage("deepseek-v4.1-flash")]);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /9router\/cc\/claude-sonnet-5-5/);
    assert.match(r.stderr, /its OMP transcript/);
    assert.equal(r.last.modelSource, "transcript");
    assert.equal(j.job().rounds.length, 0);
  });

  test("a usage row without a provider never hides the route of the model_change row above it", () => {
    const home = ompHome({ defaultModel: "anthropic/claude-sonnet-5-5" });
    const w = world(home.env);
    writeRun(w, "terminal-7", { ompSessionId: OMP_ID, runSeq: 1 });
    const filler = JSON.stringify({ type: "pad", text: "x".repeat(120_000) });
    transcript(home.sessions, [modelChange("9router/cc/claude-haiku-5-5"), filler, modelUsage("cc/claude-haiku-5-5")]);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /9router\/cc\/claude-haiku-5-5/);
  });
});

describe("dispatch warns about a blocked provider", () => {
  const blockRows = (until) => [{ credentialId: 20, provider: "anthropic", providerKey: "anthropic:oauth", until }];

  test("an active block warns with provider, reason and the time it lifts, and the round still goes out", () => {
    const until = Date.now() + 2 * HOUR;
    const home = ompHome({ defaultModel: "anthropic/claude-sonnet-5-5:high", rows: blockRows(until) });
    const w = world(home.env);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /anthropic is under an active credential block \(anthropic:oauth, provider-wide\)/);
    assert.match(r.stderr, /OMP recorded no reason/);
    assert.match(r.stderr, new RegExp(new Date(until).toISOString().slice(0, 19)));
    assert.equal(r.last.providerBlock.provider, "anthropic");
    assert.equal(r.last.providerBlock.until, new Date(until).toISOString());
    assert.equal(r.last.providerBlock.reason, "OMP recorded no reason");
    assert.equal(j.job().rounds[0].worker.model, "anthropic/claude-sonnet-5-5", "the thinking level is not part of the model");
    assert.equal(w.env.OMP_AUTH_DB, undefined, "the DB sits beside the config the test points at");
    assert.equal(JSON.stringify(r.lines).includes(SECRET), false, "credential data is never selected, so never printed");
    assert.equal(r.stderr.includes(SECRET), false);
  });

  test("a disabled credential is the stated reason when OMP recorded one", () => {
    const until = Date.now() + HOUR;
    const home = ompHome({ defaultModel: "anthropic/claude-sonnet-5-5", rows: [{ ...blockRows(until)[0], disabledCause: "deleted by user" }] });
    const w = world(home.env);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.providerBlock.reason, "its credential is disabled");
    assert.equal(/deleted by user/.test(r.stderr), false, "the stored cause is not echoed");
  });

  test("a block that already lifted is silent", () => {
    const home = ompHome({ defaultModel: "anthropic/claude-sonnet-5-5", rows: blockRows(Date.now() - HOUR) });
    const w = world(home.env);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(/credential block/.test(r.stderr), false);
    assert.equal(r.last.providerBlock, undefined);
  });

  test("a clean model is silent even when another provider is blocked", () => {
    const home = ompHome({ defaultModel: "opencode-go/deepseek-v4.1-flash:max", rows: blockRows(Date.now() + HOUR) });
    const w = world(home.env);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(/credential block/.test(r.stderr), false);
    assert.equal(r.last.providerBlock, undefined);
    assert.equal(r.last.model, "opencode-go/deepseek-v4.1-flash");
    assert.equal(j.job().rounds[0].worker.model, "opencode-go/deepseek-v4.1-flash");
  });

  test("an auth DB that cannot be read says nothing about quota and never blocks the round", () => {
    const home = ompHome({ defaultModel: "anthropic/claude-sonnet-5-5", db: "garbage" });
    const w = world(home.env);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(/quota|credential block/.test(r.stderr), false);
    assert.equal(r.last.providerBlock, undefined);
  });
});

describe("dispatch with an unknown model", () => {
  test("no transcript and no modelRoles.default continues as model unknown", () => {
    const home = ompHome();
    const w = world(home.env);
    const j = initJob(w);
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.model, "unknown");
    assert.equal(r.last.modelSource, null);
    assert.match(r.stderr, /model: unknown/);
    assert.equal(j.job().rounds.length, 1);
  });
});

describe("the shared resolver", () => {
  test("readConfiguredDefaultModel reads only modelRoles.default, ignoring nested keys and quotes", () => {
    const home = ompHome({ defaultModel: "opencode-go/deepseek-v4.1-flash:max", quoted: true });
    assert.deepEqual(readConfiguredDefaultModel(home.config), {
      model: "opencode-go/deepseek-v4.1-flash",
      role: "default",
      configured: "opencode-go/deepseek-v4.1-flash:max",
    });
    const bare = ompHome();
    assert.equal(readConfiguredDefaultModel(bare.config), null, "a task-only config names no worker model");
    assert.equal(readConfiguredDefaultModel(path.join(TEMP, "no-such-config.yml")), null);
    const commented = path.join(TEMP, `config-comment-${++n}.yml`);
    fs.writeFileSync(commented, "modelRoles:\n  default: 'opencode-go/deepseek-v4.1-flash:max' # chốt 23/11\n  vision: anthropic/claude-sonnet-5-5\n");
    assert.equal(readConfiguredDefaultModel(commented).model, "opencode-go/deepseek-v4.1-flash");
  });

  test("resolveWorkerModel prefers the transcript route over the configured default", () => {
    const home = ompHome({ defaultModel: "anthropic/claude-sonnet-5-5" });
    transcript(home.sessions, [modelChange("9router/cc/claude-haiku-5-5")]);
    const resolved = resolveWorkerModel({ run: { ompSessionId: OMP_ID, cwd: "E:\\Work\\x" }, sessionsDir: home.sessions, configFile: home.config });
    assert.equal(resolved.model, "9router/cc/claude-haiku-5-5");
    assert.equal(resolved.source, "transcript");
    assert.equal(resolved.evidence, "model_change");
  });

  test("providerBlock matches on the provider part of provider_key, and only while the block is active", () => {
    const home = ompHome({ rows: [{ credentialId: 20, provider: "anthropic", providerKey: "anthropic:oauth", until: 2_000_000, scope: "" }] });
    assert.equal(providerBlock(home.dbFile, "anthropic/claude-sonnet-5-5", 1_000_000).providerKey, "anthropic:oauth");
    assert.equal(providerBlock(home.dbFile, "anthropic/claude-sonnet-5-5", 3_000_000), null, "lifted");
    assert.equal(providerBlock(home.dbFile, "opencode-go/deepseek-v4.1-flash", 1_000_000), null, "another provider");
    assert.equal(providerBlock(home.dbFile, "claude-sonnet-5-5", 1_000_000), null, "a name without a provider cannot be matched");
    assert.equal(providerBlock(path.join(TEMP, "no-such-agent.db"), "anthropic/claude-sonnet-5-5", 1_000_000), null);
  });
});

describe("worker-status reads the same model", () => {
  test("a model_change above a later provider-less usage row still reports the full 9router route", () => {
    const dir = path.join(TEMP, `status-${++n}`);
    const runsDir = path.join(dir, "runs");
    const sessionsDir = path.join(dir, "sessions");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(
      path.join(runsDir, "terminal-t.json"),
      JSON.stringify({ state: "idle", runSeq: 1, lastEventAt: 1, updatedAt: Date.now(), pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work\\x" }),
    );
    transcript(sessionsDir, [modelChange("9router/cc/claude-haiku-5-5"), modelUsage("cc/claude-haiku-5-5")]);
    const { code, out } = status({ terminal: "terminal-t", runsDir, sessionsDir, tools: 1, configFile: path.join(dir, "no-config.yml") });
    assert.equal(code, 0);
    assert.equal(out.model, "9router/cc/claude-haiku-5-5");
    assert.equal(out.modelSource, "transcript");
    assert.equal(out.warnings[0].code, "IDE_TOOL_SUFFIX_MODEL");
  });

  test("a pane with no OMP transcript falls back to the configured default, tagged as such", () => {
    const dir = path.join(TEMP, `status-${++n}`);
    const runsDir = path.join(dir, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), "modelRoles:\n  default: anthropic/claude-sonnet-5-5\n");
    fs.writeFileSync(
      path.join(runsDir, "terminal-t.json"),
      JSON.stringify({ state: "idle", runSeq: 1, lastEventAt: 1, updatedAt: Date.now(), pid: process.pid, ompSessionId: OMP_ID, cwd: "E:\\Work\\x" }),
    );
    const { out } = status({ terminal: "terminal-t", runsDir, sessionsDir: path.join(dir, "sessions"), tools: 1, configFile: path.join(dir, "config.yml") });
    assert.equal(out.model, "anthropic/claude-sonnet-5-5");
    assert.equal(out.modelSource, "config");
    assert.equal("warnings" in out, false);
  });
});

test("the dispatch help documents the refusal, the override and the warning", () => {
  const w = world(ompHome().env);
  const r = cli(w, ["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--allow-ide-suffix-model/);
  assert.match(r.stdout, /round\.worker\.model/);
  assert.match(r.stdout, /providerBlock/);
});
