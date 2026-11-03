// leader-guard.test.mjs - behavioral tests for the Leader terminal guard hook.
//
// A Leader may not end its turn while a dispatched job is open (session_stop) and may not do
// worker work (tool_call): edit a theme, run a write-class theme CLI command, write the sheet,
// run a page-writing script, or investigate the work itself past a small budget of reads between
// two worker dispatches. Everything runs against temp dirs; the real data root, the real
// registry and the real ~/.omp are never touched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(REPO, "src", "omp-hooks");
const CLI = path.join(REPO, "scripts", "leader", "leader-job.mjs");

// The hook imports its siblings by extensionless relative specifier, which Node's ESM
// resolver rejects: copy the unit into a temp tree as .mts with the specifiers rewritten.
const UNIT = ["edit-mode", "theme-paths", "edit-guard-policy", "theme-push-policy", "leader-guard"];
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "leader-guard-"));
const SPECIFIER_RE = new RegExp(`from "\\./(${UNIT.join("|")})"`, "g");
for (const name of UNIT) {
  const source = fs.readFileSync(path.join(SRC, `${name}.ts`), "utf8").replace(SPECIFIER_RE, 'from "./$1.mts"');
  fs.writeFileSync(path.join(TEMP, `${name}.mts`), source);
}
const guard = await import(pathToFileURL(path.join(TEMP, "leader-guard.mts")).href);
const { default: leaderGuardHook, findOpenJobs, findLeakedWorkers, canonicalTool, investigationLabel, LEADER_READ_ALLOW_ROOTS } = guard;

const LEADER = "terminal-7";
const OTHER_LEADER = "terminal-9";
const ENV_KEYS = ["ANTIFAN_TERMINAL_SESSION_ID", "ANTIFAN_CONFIG_DIR", "ANTIFAN_DATA_ROOT", "LEADER_JOBS_ROOT", "LEADER_RUNS_DIR"];
const ENV_AT_LOAD = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const made = [];

after(() => {
  for (const key of ENV_KEYS) {
    if (ENV_AT_LOAD[key] === undefined) delete process.env[key];
    else process.env[key] = ENV_AT_LOAD[key];
  }
  for (const dir of [TEMP, ...made]) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

let jobsRoot;
let runsDir;
let configDir;
let themeRoot;
let plainDir;

/** Arms the process env as the terminal `terminal` of a world whose registry lists `leaders`. */
function arm({ terminal = LEADER, leaders = [LEADER] } = {}) {
  process.env.ANTIFAN_TERMINAL_SESSION_ID = terminal;
  process.env.ANTIFAN_CONFIG_DIR = configDir;
  process.env.LEADER_JOBS_ROOT = jobsRoot;
  process.env.LEADER_RUNS_DIR = runsDir;
  fs.writeFileSync(path.join(configDir, "leader-terminals.json"), JSON.stringify({ schema: 1, leaders, workers: {} }));
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  jobsRoot = tempDir("leader-jobs-");
  runsDir = tempDir("leader-runs-");
  configDir = tempDir("leader-config-");
  themeRoot = tempDir("leader-theme-");
  for (const dir of ["layout", "templates", "sections", "snippets", "assets", "config"]) {
    fs.mkdirSync(path.join(themeRoot, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(themeRoot, "sections", "hero.liquid"), "<div></div>\n");
  plainDir = tempDir("leader-plain-");
  arm();
});

function makeHook({ hasUI = true } = {}) {
  const handlers = new Map();
  const warnings = [];
  const pi = {
    on: (event, fn) => handlers.set(event, fn),
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
  };
  leaderGuardHook(pi);
  const ctx = { cwd: plainDir, sessionManager: { getSessionId: () => "omp-session" }, hasUI };
  return {
    warnings,
    stop: () => handlers.get("session_stop")({ type: "session_stop", messages: [], stop_hook_active: false }, ctx),
    call: (toolName, input, cwd = plainDir) =>
      handlers.get("tool_call")({ type: "tool_call", toolName, input }, { ...ctx, cwd }),
    through: (extraCtx) => ({
      call: (toolName, input, cwd = plainDir) =>
        handlers.get("tool_call")({ type: "tool_call", toolName, input }, { ...ctx, cwd, ...extraCtx }),
    }),
    /** The host's `tool_result` event for a finished tool call; `content` is serialised like an MCP reply. */
    result: (toolName, content, { isError = false, input = {} } = {}) =>
      handlers.get("tool_result")(
        { type: "tool_result", toolName, toolCallId: "call-1", input, content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }], isError },
        ctx,
      ),
    emit: (eventName, event) => handlers.get(eventName)(event, ctx),
  };
}

function writeJob(name, { terminal = LEADER, state = "dispatched", rounds = [{ n: 1 }], ...extra } = {}) {
  const dir = path.join(jobsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({
      schema: "leader-job/1",
      job: name,
      leader: { terminal, ompSessionId: "s" },
      subject: { kind: "feedback", issueId: "1", host: "Taiz", shop: "shop.example", sheetId: "S" },
      state,
      rounds,
      ...extra,
    }),
  );
  return dir.replace(/\\/g, "/");
}

/** One round per terminal, in order: the last one is the worker the job still talks to. */
const workerRounds = (...terminals) => terminals.map((worker, index) => ({ n: index + 1, worker: { terminal: worker } }));

/** The Manager keeps a run file for every open terminal and removes it when the terminal closes. */
const openTerminal = (terminal, state = "idle") =>
  fs.writeFileSync(path.join(runsDir, `${terminal}.json`), JSON.stringify({ schema: 1, terminalSessionId: terminal, state, runSeq: 1 }));

function assertRefused(result, code) {
  assert.ok(result, `expected a refusal ${code}, got ${JSON.stringify(result)}`);
  assert.equal(result.block, true);
  assert.ok(result.reason.startsWith(`${code}:`), `reason ${result.reason}`);
  assert.match(result.reason, /hand this to a worker/);
}

// ---------------------------------------------------------------------------
// session_stop
// ---------------------------------------------------------------------------

test("stop is blocked while a job of this Leader is dispatched, with the exact next command", async () => {
  const dir = writeJob("261030-1340-whenever282", { state: "dispatched" });
  const result = await makeHook().stop();
  assert.equal(result.decision, "block");
  assert.ok(result.reason.includes(dir));
  assert.match(result.reason, /\[dispatched\]/);
  assert.ok(result.reason.includes(`node scripts/leader/leader-job.mjs wait --job ${dir}`));
  assert.match(result.reason, /async:true, timeout:0/);
});

test("stop is blocked for settled and reported jobs and names the round to validate and verify", async () => {
  const settled = writeJob("job-settled", { state: "settled", rounds: [{ n: 1 }, { n: 2 }] });
  const reported = writeJob("job-reported", { state: "reported", rounds: [{ n: 1 }] });
  const result = await makeHook().stop();
  assert.equal(result.decision, "block");
  assert.ok(result.reason.includes(`validate-report --job ${settled} --round 2`));
  assert.ok(result.reason.includes(`verify-sheet --job ${settled} --round 2`));
  assert.ok(result.reason.includes(`verify-sheet --job ${reported} --round 1`));
});

test("stop is blocked while a worker is dead and says to resume on a NEW terminal, not to wait again", async () => {
  const dir = writeJob("job-dead", { state: "worker_dead", rounds: [{ n: 1 }] });
  const result = await makeHook().stop();
  assert.equal(result.decision, "block");
  assert.ok(result.reason.includes(dir));
  assert.match(result.reason, /NEW terminal/);
  assert.ok(!result.reason.includes(`leader-job.mjs wait --job ${dir}`));
});

test("stop is allowed for needs_input, verified, user-approved, closed and open jobs", async () => {
  for (const state of ["needs_input", "verified", "user-approved", "closed", "open"]) {
    writeJob(`job-${state}`, { state });
  }
  assert.equal(await makeHook().stop(), undefined);
});

test("stop is allowed when the open job belongs to another Leader", async () => {
  writeJob("job-other", { terminal: OTHER_LEADER, state: "dispatched" });
  assert.equal(await makeHook().stop(), undefined);
});

test("stop is allowed for a terminal that is not a Leader, even with an open job under its id", async () => {
  writeJob("job-mine", { state: "dispatched" });
  arm({ leaders: [OTHER_LEADER] });
  assert.equal(await makeHook().stop(), undefined);
  delete process.env.ANTIFAN_TERMINAL_SESSION_ID;
  assert.equal(await makeHook().stop(), undefined);
});

test("stop fails open on a corrupt job.json, a missing jobs root and a missing registry", async () => {
  const dir = path.join(jobsRoot, "job-corrupt");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "job.json"), '{"leader": {"terminal": "terminal-7"}, "state": "dispat');
  assert.equal(await makeHook().stop(), undefined);

  process.env.LEADER_JOBS_ROOT = path.join(jobsRoot, "absent");
  assert.equal(await makeHook().stop(), undefined);

  process.env.LEADER_JOBS_ROOT = jobsRoot;
  fs.rmSync(path.join(configDir, "leader-terminals.json"));
  writeJob("job-live", { state: "dispatched" });
  assert.equal(await makeHook().stop(), undefined);
});

test("a corrupt job file does not hide another open job of the same Leader", async () => {
  const dir = path.join(jobsRoot, "job-corrupt");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "job.json"), "not json");
  const live = writeJob("job-live", { state: "dispatched" });
  const result = await makeHook().stop();
  assert.equal(result.decision, "block");
  assert.ok(result.reason.includes(live));
  assert.deepEqual(findOpenJobs(LEADER, process.env).map((job) => job.state), ["dispatched"]);
});

test("stop is blocked while a worker terminal of a closed job is still open, naming the terminal and the close call", async () => {
  writeJob("job-closed", { state: "closed", rounds: workerRounds("terminal-85") });
  openTerminal("terminal-85");
  const result = await makeHook().stop();
  assert.equal(result.decision, "block");
  assert.match(result.reason, /terminal-85: its job is closed, OMP idle/);
  assert.match(result.reason, /terminal\.close \{sessionId, removeMintedProject:true\}/);
  assert.deepEqual(findLeakedWorkers(LEADER, process.env).map((worker) => worker.terminal), ["terminal-85"]);
});

test("stop is blocked for a worker a later round replaced, never for the worker the job still talks to", async () => {
  writeJob("job-replaced", { state: "needs_input", rounds: workerRounds("terminal-82", "terminal-103") });
  openTerminal("terminal-82");
  openTerminal("terminal-103");
  const result = await makeHook().stop();
  assert.equal(result.decision, "block");
  assert.match(result.reason, /terminal-82: a later round replaced it/);
  assert.ok(!result.reason.includes("terminal-103"), "the current worker is still needed");
});

test("a replaced worker that is still running is told to settle first", async () => {
  writeJob("job-replaced", { state: "needs_input", rounds: workerRounds("terminal-82", "terminal-103") });
  openTerminal("terminal-82", "running");
  const result = await makeHook().stop();
  assert.equal(result.decision, "block");
  assert.match(result.reason, /terminal-82: .*still running: wait for it to settle first/);
});

test("stop is allowed once the replaced worker's terminal is closed, and only the current one is open", async () => {
  writeJob("job-replaced", { state: "needs_input", rounds: workerRounds("terminal-82", "terminal-103") });
  openTerminal("terminal-103");
  assert.equal(await makeHook().stop(), undefined);
});

test("a terminal another unfinished job of the same Leader still uses is not a leak", async () => {
  writeJob("job-a", { state: "needs_input", rounds: workerRounds("terminal-82", "terminal-103") });
  writeJob("job-b", { state: "needs_input", rounds: workerRounds("terminal-82") });
  openTerminal("terminal-82");
  openTerminal("terminal-103");
  assert.equal(await makeHook().stop(), undefined);
});

test("a worker kept on purpose (workersKept) and another Leader's workers are not this Leader's leak", async () => {
  writeJob("job-kept", { state: "closed", workersKept: true, rounds: workerRounds("terminal-85") });
  writeJob("job-other", { terminal: OTHER_LEADER, state: "closed", rounds: workerRounds("terminal-86") });
  openTerminal("terminal-85");
  openTerminal("terminal-86");
  assert.equal(await makeHook().stop(), undefined);
});

test("an open job and a leaked worker are reported together in one block", async () => {
  const live = writeJob("job-live", { state: "dispatched", rounds: workerRounds("terminal-90") });
  writeJob("job-closed", { state: "closed", rounds: workerRounds("terminal-85") });
  openTerminal("terminal-85");
  const result = await makeHook().stop();
  assert.equal(result.decision, "block");
  assert.ok(result.reason.includes(`leader-job.mjs wait --job ${live}`));
  assert.match(result.reason, /terminal-85: its job is closed/);
});

test("a missing run file directory is no leak: the stop guard fails open", async () => {
  writeJob("job-closed", { state: "closed", rounds: workerRounds("terminal-85") });
  process.env.LEADER_RUNS_DIR = path.join(runsDir, "absent");
  assert.equal(await makeHook().stop(), undefined);
});

test("the hook and `leader-job.mjs status` name the same leaked workers", () => {
  writeJob("job-closed", { state: "closed", rounds: workerRounds("terminal-85", "terminal-86") });
  writeJob("job-closed-gone", { state: "closed", rounds: workerRounds("terminal-87") });
  writeJob("job-replaced", { state: "needs_input", rounds: workerRounds("terminal-82", "terminal-103") });
  writeJob("job-shared-a", { state: "verified", rounds: workerRounds("terminal-60", "terminal-61") });
  writeJob("job-shared-b", { state: "needs_input", rounds: workerRounds("terminal-60") });
  writeJob("job-kept", { state: "closed", workersKept: true, rounds: workerRounds("terminal-95") });
  writeJob("job-other", { terminal: OTHER_LEADER, state: "closed", rounds: workerRounds("terminal-96") });
  for (const terminal of ["terminal-85", "terminal-86", "terminal-82", "terminal-103", "terminal-60", "terminal-61", "terminal-95", "terminal-96"]) {
    openTerminal(terminal);
  }
  const hook = findLeakedWorkers(LEADER, process.env).map((worker) => worker.terminal).sort();
  const run = spawnSync(process.execPath, [CLI, "status", "--leader", LEADER, "--all"], { encoding: "utf8", env: { ...process.env } });
  assert.equal(run.status, 0, run.stderr);
  const cli = run.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((row) => row.job)
    .flatMap((row) => row.leakedWorkers);
  assert.deepEqual([...new Set(cli)].sort(), hook);
  assert.deepEqual(hook, ["terminal-82", "terminal-85", "terminal-86"]);
});

// ---------------------------------------------------------------------------
// tool_call: Leader terminal
// ---------------------------------------------------------------------------

test("canonicalTool maps every spelling of an MCP tool to one name", () => {
  for (const name of [
    "mcp__antifan_browser_anti_sheet_write_cell",
    "anti.sheet.write_cell",
    "xd://mcp__antifan_browser_anti_sheet_write_cell",
    "mcp__antifan-browser__anti.sheet.write_cell",
  ]) {
    assert.equal(canonicalTool(name), "anti_sheet_write_cell", name);
  }
});

test("theme file writes are refused through edit, write and ast_edit", async () => {
  const hook = makeHook();
  const hero = path.join(themeRoot, "sections", "hero.liquid");
  assertRefused(await hook.call("write", { path: hero, content: "x" }), "REFUSED_LEADER_THEME_EDIT");
  assertRefused(
    await hook.call("write", { path: path.join(themeRoot, "snippets", "new-file.liquid"), content: "x" }),
    "REFUSED_LEADER_THEME_EDIT",
  );
  assertRefused(await hook.call("edit", { input: `[${hero}#ABCD]\nPUT 1:\n+x` }), "REFUSED_LEADER_THEME_EDIT");
  assertRefused(
    await hook.call("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: [`${themeRoot.replace(/\\/g, "/")}/sections/**/*.liquid`] }),
    "REFUSED_LEADER_THEME_EDIT",
  );
  // A relative path resolves against the session cwd.
  assertRefused(await hook.call("write", { path: "sections/hero.liquid", content: "x" }, themeRoot), "REFUSED_LEADER_THEME_EDIT");
});

test("writes outside a theme workspace pass: job ledger, AntiFan repo, plain folders", async () => {
  const hook = makeHook();
  assert.equal(await hook.call("write", { path: path.join(jobsRoot, "job-a", "prompt.md"), content: "x" }), undefined);
  assert.equal(await hook.call("edit", { input: `[${path.join(REPO, "scripts", "leader", "leader-job.mjs")}#ABCD]\nPUT 1:\n+x` }), undefined);
  assert.equal(await hook.call("write", { path: path.join(REPO, "src", "omp-hooks", "leader-guard.ts"), content: "x" }), undefined);
  assert.equal(await hook.call("write", { path: path.join(plainDir, "notes.md"), content: "x" }), undefined);
  assert.equal(await hook.call("read", { path: path.join(themeRoot, "sections", "hero.liquid") }), undefined);
});

test("a job folder nested under a theme-shaped path is still allowed", async () => {
  // The ledger root wins over theme detection (a snapshot may carry theme-like folders).
  for (const dir of ["layout", "templates", "sections"]) fs.mkdirSync(path.join(jobsRoot, dir), { recursive: true });
  const hook = makeHook();
  assert.equal(await hook.call("write", { path: path.join(jobsRoot, "sections", "x.liquid"), content: "x" }), undefined);
});

test("write-class theme CLI commands are refused, read-only ones pass", async () => {
  const hook = makeHook();
  for (const command of [
    "hrv theme push --only sections/hero.liquid",
    "hrv theme publish 123",
    "haravan theme delete 5",
    "shopify theme push --theme 5",
    "shopify theme dev",
    "sapo theme push",
    "hrv api put /web/themes/1.json",
  ]) {
    assertRefused(await hook.call("bash", { command }), "REFUSED_LEADER_THEME_CLI");
  }
  for (const command of ["hrv theme info -j", "hrv theme list", "shopify theme list", "hrv theme push --help", "git status", "node scripts/leader/leader-job.mjs status"]) {
    assert.equal(await hook.call("bash", { command }), undefined, command);
  }
});

test("a Leader is refused a fully scoped shopify theme push that a worker may run after verification", async () => {
  const hook = makeHook();
  assertRefused(
    await hook.call("bash", { command: "shopify theme push --theme 123456789 --store demo-shop --only sections/a.liquid --nodelete" }),
    "REFUSED_LEADER_THEME_CLI",
  );
});

test("an eval cell that starts the theme CLI is refused, one that only mentions it is not", async () => {
  const hook = makeHook();
  assertRefused(
    await hook.call("eval", { code: "import subprocess\nsubprocess.run(['hrv','theme','push','--only','a'])" }),
    "REFUSED_LEADER_THEME_CLI",
  );
  assert.equal(await hook.call("eval", { code: "text = open('report.md').read()\nprint('hrv theme push' in text)" }), undefined);
});

test("shell writes into a theme folder are refused (best effort), into the ledger are not", async () => {
  const hook = makeHook();
  const hero = path.join(themeRoot, "sections", "hero.liquid").replace(/\\/g, "/");
  assertRefused(await hook.call("bash", { command: `echo x > ${hero}` }), "REFUSED_LEADER_THEME_EDIT");
  assertRefused(await hook.call("bash", { command: `Set-Content -Path "${hero}" -Value x` }), "REFUSED_LEADER_THEME_EDIT");
  assertRefused(await hook.call("bash", { command: "rm hero.liquid", cwd: path.join(themeRoot, "sections") }), "REFUSED_LEADER_THEME_EDIT");
  const note = path.join(jobsRoot, "job-a", "note.md").replace(/\\/g, "/");
  assert.equal(await hook.call("bash", { command: `echo x > ${note}` }), undefined);
  assert.equal(await hook.call("bash", { command: `type ${hero}` }), undefined);
});

test("the sheet write tool is refused through the native name, write xd:// and eval", async () => {
  const hook = makeHook();
  const args = { cell: "F12", value: "Done" };
  assertRefused(await hook.call("mcp__antifan_browser_anti_sheet_write_cell", args), "REFUSED_LEADER_SHEET_WRITE");
  assertRefused(
    await hook.call("mcp__antifan_browser_anti_sheet_write_range", { startCell: "F12", values: [["Done"]] }),
    "REFUSED_LEADER_SHEET_WRITE",
  );
  assertRefused(
    await hook.call("eval", { code: "await tool.mcp__antifan_browser_anti_sheet_write_range({startCell: 'F12', values: [['Done']]})" }),
    "REFUSED_LEADER_SHEET_WRITE",
  );
  assertRefused(await hook.call("anti.sheet.write_cell", args), "REFUSED_LEADER_SHEET_WRITE");
  assertRefused(
    await hook.call("write", { path: "xd://mcp__antifan_browser_anti_sheet_write_cell", content: JSON.stringify(args) }),
    "REFUSED_LEADER_SHEET_WRITE",
  );
  assertRefused(
    await hook.call("eval", { code: "await tool.mcp__antifan_browser_anti_sheet_write_cell({cell: 'F12', value: 'Done'})" }),
    "REFUSED_LEADER_SHEET_WRITE",
  );
});

// The user (03/11/2026) lets a Leader operate a page itself: clicks, typing, uploads and in-page
// scripts that write all pass, on the native name, write xd://, eval and Playwright alike. Theme
// files, the theme CLI and the sheet writers stay refused (tests above).
test("a Leader may operate a page: page tools pass on every route", async () => {
  const hook = makeHook();
  for (const name of ["anti_agent_cursor_click", "anti_agent_cursor_type", "anti_agent_sequence", "anti_agent_file_upload", "anti_agent_drop", "anti_agent_drag", "anti_agent_set_control"]) {
    assert.equal(await hook.call(`mcp__antifan_browser_${name}`, { selector: "#x" }), undefined, name);
  }
  assert.equal(await hook.call("write", { path: "xd://mcp__antifan_browser_anti_agent_cursor_click", content: '{"selector":"#save"}' }), undefined);
  assert.equal(await hook.call("eval", { code: "await tool.mcp__antifan_browser_anti_agent_sequence({steps: []})" }), undefined);
  assert.equal(await hook.call("mcp__playwright_browser_click", { ref: "e1" }), undefined);
});

test("a Leader may run an in-page script that writes, inline or from a file, on every route", async () => {
  const hook = makeHook();
  for (const expression of [
    "quickUpdate(288, 'Done')",
    "addNewComment(12, 'ok')",
    "fetch('/cart/add.js', {body: 'id=1'})",
    "fetch(u, { method: 'POST' })",
    "x.open('PUT', u)",
  ]) {
    assert.equal(await hook.call("mcp__antifan_browser_anti_browser_evaluate", { expression }), undefined, expression);
  }
  const write = "quickUpdate(288, 'Done')";
  assert.equal(
    await hook.call("write", { path: "xd://mcp__antifan_browser_anti_browser_evaluate", content: JSON.stringify({ expression: write }) }),
    undefined,
  );
  assert.equal(await hook.call("eval", { code: `await tool.mcp__antifan_browser_anti_browser_evaluate({expression: "${write}"})` }), undefined);
  const file = path.join(plainDir, "write.js");
  fs.writeFileSync(file, "const r = await fetch('/x', { method: 'PATCH' }); r.ok");
  assert.equal(await hook.call("mcp__antifan_browser_anti_browser_evaluate", { expressionFile: "write.js" }), undefined);
});

test("read-only evaluate and screenshots pass on every route", async () => {
  const hook = makeHook();
  const read = "originalFeedback.filter((f) => f.shop === 'whenever').map((f) => f.id)";
  assert.equal(await hook.call("mcp__antifan_browser_anti_browser_evaluate", { expression: read }), undefined);
  assert.equal(
    await hook.call("write", { path: "xd://mcp__antifan_browser_anti_browser_evaluate", content: JSON.stringify({ expression: read }) }),
    undefined,
  );
  assert.equal(await hook.call("eval", { code: `await tool.mcp__antifan_browser_anti_browser_evaluate({expression: "${read}"})` }), undefined);
  assert.equal(await hook.call("mcp__antifan_browser_anti_screenshot_viewport", {}), undefined);
  assert.equal(await hook.call("mcp__antifan_browser_anti_inspect_dom", { selector: "body" }), undefined);
  assert.equal(await hook.call("mcp__antifan_browser_terminal_write", { text: "hello" }), undefined);
});

test("a refusal is reported to the host logger", async () => {
  const hook = makeHook();
  await hook.call("mcp__antifan_browser_anti_sheet_write_cell", { cell: "A1", value: "x" });
  assert.equal(hook.warnings.length, 1);
  assert.match(hook.warnings[0], /^REFUSED_LEADER_SHEET_WRITE/);
});

// ---------------------------------------------------------------------------
// tool_call: terminals that are not a Leader
// ---------------------------------------------------------------------------

test("a terminal that is not a Leader is never gated", async () => {
  const hero = path.join(themeRoot, "sections", "hero.liquid");
  for (const setup of [() => arm({ leaders: [OTHER_LEADER] }), () => delete process.env.ANTIFAN_TERMINAL_SESSION_ID]) {
    arm();
    setup();
    const hook = makeHook();
    assert.equal(await hook.call("write", { path: hero, content: "x" }), undefined);
    assert.equal(await hook.call("bash", { command: "hrv theme push --only a" }), undefined);
    assert.equal(await hook.call("mcp__antifan_browser_anti_sheet_write_cell", { cell: "A1", value: "x" }), undefined);
  }
});

test("a worker terminal (registered under workers, not leaders) is not gated by the Leader guard", async () => {
  fs.writeFileSync(
    path.join(configDir, "leader-terminals.json"),
    JSON.stringify({ schema: 1, leaders: [OTHER_LEADER], workers: { [LEADER]: { leaderId: OTHER_LEADER, assignedAt: 1 } } }),
  );
  const hook = makeHook();
  assert.equal(await hook.call("write", { path: path.join(themeRoot, "sections", "hero.liquid"), content: "x" }), undefined);
  assert.equal(await hook.stop(), undefined);
});

test("a malformed event or empty tool name never throws and never blocks", async () => {
  const hook = makeHook();
  assert.equal(await hook.call("", {}), undefined);
  assert.equal(await hook.call("write", undefined), undefined);
  assert.equal(await hook.call("bash", { command: 42 }), undefined);
});

// ---------------------------------------------------------------------------
// tool_call: investigation budget
// ---------------------------------------------------------------------------

const INVESTIGATE = "REFUSED_LEADER_INVESTIGATE";
const slash = (target) => target.replace(/\\/g, "/");

function assertInvestigateRefused(result) {
  assert.ok(result, `expected a refusal ${INVESTIGATE}, got ${JSON.stringify(result)}`);
  assert.equal(result.block, true);
  assert.ok(result.reason.startsWith(`${INVESTIGATE}:`), `reason ${result.reason}`);
  assert.match(result.reason, /Bạn là Leader \(điều phối\)/);
  assert.match(result.reason, /Bước 0: điều tra và báo cáo/);
  assert.match(result.reason, /`terminal\.create`/);
}

/** One investigation call per route (native tools, shell, eval, web), all outside the read allow-list. */
function investigations() {
  return [
    ["read", { path: path.join(themeRoot, "sections", "hero.liquid") }],
    ["grep", { pattern: "hero", path: themeRoot }],
    ["glob", { path: `${slash(themeRoot)}/sections/*.liquid` }],
    ["bash", { command: "git log --oneline -5" }],
    ["eval", { code: "archive.recent_projects()" }],
    ["web_search", { query: "liquid section schema" }],
  ];
}

async function spendBudget(hook) {
  for (const [tool, input] of investigations().slice(0, 4)) {
    assert.equal(await hook.call(tool, input), undefined, `${tool} is within the budget`);
  }
}

test("a Leader's fifth investigation call is refused with REFUSED_LEADER_INVESTIGATE and stays refused", async () => {
  const hook = makeHook();
  const calls = investigations();
  await spendBudget(hook);
  assertInvestigateRefused(await hook.call(...calls[4]));
  assertInvestigateRefused(await hook.call(...calls[5]));
  assertInvestigateRefused(await hook.call(...calls[0]));
  assert.match(hook.warnings.at(-1), new RegExp(`^${INVESTIGATE}:`));
});

test("every route counts toward one budget: lsp, ast_edit, write xd://, eval subprocess, shell", async () => {
  const hook = makeHook();
  const hero = path.join(themeRoot, "sections", "hero.liquid");
  assert.equal(await hook.call("lsp", { action: "diagnostics", file: hero }), undefined);
  assert.equal(await hook.call("ast_edit", { ops: [{ pat: "a", out: "a" }], paths: [plainDir] }), undefined);
  assert.equal(await hook.call("write", { path: "xd://lsp", content: JSON.stringify({ action: "symbols", file: hero }) }), undefined);
  assert.equal(await hook.call("eval", { code: `import subprocess\nsubprocess.run(["git", "-C", r"${themeRoot}", "log"])` }), undefined);
  assertInvestigateRefused(await hook.call("bash", { command: `rg -n hero ${slash(themeRoot)}` }));
});

test("a successful terminal.create or terminal.write resets the budget", async () => {
  const created = { sessionId: "terminal-12", cwd: "E:/Work/scratch/leader/x", workerOf: LEADER };
  const written = { written: true, woke: false, writtenAt: 1 };
  const refusedCall = investigations()[4];
  for (const dispatch of [
    (hook) => hook.result("mcp__antifan_browser_terminal_create", created),
    (hook) => hook.result("terminal.create", created),
    (hook) => hook.result("mcp__antifan_browser_terminal_write", written),
    (hook) => hook.result("write", written, { input: { path: "xd://mcp__antifan_browser_terminal_write", content: "{}" } }),
  ]) {
    const hook = makeHook();
    await spendBudget(hook);
    assertInvestigateRefused(await hook.call(...refusedCall));
    await dispatch(hook);
    await spendBudget(hook);
    assertInvestigateRefused(await hook.call(...refusedCall));
  }
});

test("only a successful dispatch resets: a request, an error, an unconfirmed write or another tool does not", async () => {
  const hook = makeHook();
  await spendBudget(hook);
  assert.equal(await hook.call("mcp__antifan_browser_terminal_create", { cwd: slash(plainDir) }), undefined);
  assert.equal(await hook.call("mcp__antifan_browser_terminal_write", { sessionId: "terminal-12", input: "x" }), undefined);
  await hook.result("mcp__antifan_browser_terminal_create", "TERMINAL_FORBIDDEN: not a Leader", { isError: true });
  await hook.result("mcp__antifan_browser_terminal_write", "POLICY_DENIED: refused", { isError: true });
  await hook.result("mcp__antifan_browser_terminal_write", { written: false, woke: false });
  for (const name of ["terminal_list", "terminal_wait", "terminal_close", "terminal_resize", "anti_browser_evaluate"]) {
    await hook.result(`mcp__antifan_browser_${name}`, { written: true, closed: true });
  }
  assertInvestigateRefused(await hook.call(...investigations()[4]));
});

test("allow-listed reads and the Leader's own coordination calls never use the budget", async () => {
  const hook = makeHook();
  const job = path.join(jobsRoot, "261102-1017-demo");
  fs.mkdirSync(job, { recursive: true });
  const report = path.join(job, "dev.report.md");
  fs.writeFileSync(report, "STATUS: DONE\n");
  const free = [];
  for (const root of LEADER_READ_ALLOW_ROOTS) {
    free.push(["read", { path: path.join(root, "agent", "x.md") }]);
    free.push(["grep", { pattern: "x", path: `${slash(root)}/**/*.md` }]);
    free.push(["glob", { path: `${slash(root)}/*.json` }]);
    free.push(["bash", { command: `cat ${slash(root)}/notes.md` }]);
  }
  free.push(
    ["read", { path: report }],
    ["read", { path: `${slash(report)}:1-40` }],
    ["read", { path: slash(job) }],
    ["grep", { pattern: "STATUS", path: slash(jobsRoot) }],
    ["bash", { command: `cat ${slash(report)}` }],
    ["bash", { command: `ls ${slash(jobsRoot)}` }],
    ["bash", { command: `rg -n STATUS ${slash(jobsRoot)}` }],
    ["bash", { command: `cd ${slash(job)} && ls` }],
    ["bash", { command: `node scripts/leader/leader-job.mjs status --job ${slash(job)}` }],
    ["bash", { command: "node E:/Work/apps/AntiFan/scripts/leader/wait-workers.mjs --w terminal-12,1700000000000,1 --all" }],
    ["bash", { command: `node scripts/leader/leader-job.mjs verify-sheet --job ${slash(job)} --round 1 | rg -c ok` }],
    ["bash", { command: "git merge leader-guard-investigate-budget" }],
    ["bash", { command: "git worktree remove ../wt/x" }],
    ["eval", { code: `print(open(r"${report}").read())` }],
  );
  for (const uri of [
    "skill://antifan-leader",
    "skill://antifan-leader/references/leader-discipline.md:1-30",
    "memory://root",
    "local://notes.md",
    "out://",
    "agent://0-Scout",
    "proc://",
    "history://1",
    "artifact://8:34-64",
    "xd://lsp",
  ]) {
    free.push(["read", { path: uri }]);
  }
  free.push(["glob", { path: "local://*.md" }]);
  for (const name of [
    "mcp__antifan_browser_terminal_list",
    "mcp__antifan_browser_terminal_wait",
    "mcp__antifan_browser_terminal_close",
    "mcp__antifan_browser_terminal_create",
    "mcp__antifan_browser_terminal_write",
    "mcp__antifan_browser_core_query",
    "mcp__antifan_browser_core_context_pack_v2",
    "mcp__antifan_browser_anti_browser_evaluate",
    "mcp__antifan_browser_anti_screenshot_viewport",
    "todo",
    "task",
    "wait",
    "ask",
  ]) {
    free.push([name, { expression: "document.title", sessionId: "terminal-12", cwd: slash(job) }]);
  }
  free.push(
    ["write", { path: path.join(job, "dev.prompt.md"), content: "# prompt" }],
    ["edit", { input: `[${slash(path.join(job, "dev.prompt.md"))}#ABCD]\nPUT 1:\n+x` }],
  );
  for (const [tool, input] of free) {
    assert.equal(await hook.call(tool, input), undefined, `${tool} ${JSON.stringify(input)} must not count`);
  }
  await spendBudget(hook);
  assertInvestigateRefused(await hook.call(...investigations()[4]));
});

test("classification: what counts as an investigation call and what does not", () => {
  const label = (toolName, input) => investigationLabel({ toolName, input, cwd: plainDir });
  const hero = path.join(themeRoot, "sections", "hero.liquid");
  const sessions = path.join(os.homedir(), ".omp", "agent", "sessions", "proj", "a.jsonl");
  const counted = [
    ["read", { path: hero }],
    ["read", { path: sessions }],
    ["read", { path: "~/.omp/agent/sessions/x.jsonl" }],
    ["read", { path: "https://example.com/docs" }],
    ["read", { path: "pr://12" }],
    ["grep", { pattern: "x", path: `${slash(jobsRoot)};${slash(themeRoot)}` }],
    ["grep", { pattern: "x" }],
    ["glob", { path: "**/*.liquid" }],
    ["lsp", { action: "diagnostics", file: "*" }],
    ["lsp", { action: "references", file: hero, symbol: "x" }],
    ["ast_edit", { ops: [], paths: [plainDir] }],
    ["web_search", { query: "x" }],
    ["bash", { command: "git status" }],
    ["bash", { command: "git -C E:/x log -3" }],
    ["bash", { command: "git --no-pager diff HEAD~1" }],
    ["bash", { command: "git worktree list" }],
    ["bash", { command: "git branch -a" }],
    ["bash", { command: `rg -n hero ${hero}` }],
    ["bash", { command: "grep -rn hero ." }],
    ["bash", { command: `cat ${hero}` }],
    ["bash", { command: "ls" }],
    ["bash", { command: `ls ${themeRoot}` }],
    ["bash", { command: "find . -name '*.liquid'" }],
    ["bash", { command: `Get-Content ${hero}` }],
    ["bash", { command: `type ${hero}` }],
    ["bash", { command: `powershell -NoProfile -Command "Get-ChildItem ${themeRoot}"` }],
    ["bash", { command: `cd ${slash(themeRoot)} && rg hero` }],
    ["bash", { command: "echo start; git log -1" }],
    ["bash", { command: "ls", cwd: themeRoot }],
    ["eval", { code: "archive.recent_projects()" }],
    ["eval", { code: "await archive.search('x')" }],
    ["eval", { code: `glob.glob(r"${sessions}")` }],
    ["eval", { code: 'subprocess.run(["git", "log"])' }],
    ["eval", { code: "!git log -3" }],
    ["eval", { code: `print(open(r"${hero}").read())` }],
    ["eval", { code: `await tool.grep({pattern: "x", path: "${slash(themeRoot)}"})` }],
    ["eval", { code: 'await tool.web_search({query: "x"})' }],
    ["write", { path: "xd://lsp", content: JSON.stringify({ action: "symbols", file: hero }) }],
  ];
  for (const [tool, input] of counted) assert.ok(label(tool, input), `${tool} ${JSON.stringify(input)} should count`);
  const free = [
    ["bash", { command: "git merge x" }],
    ["bash", { command: "git commit -m x" }],
    ["bash", { command: "git worktree add -b b ../wt/b" }],
    ["bash", { command: "git branch -D old" }],
    ["bash", { command: "git push origin x" }],
    ["bash", { command: "node scripts/leader/leader-job.mjs status --job x" }],
    ["bash", { command: "node scripts/leader/leader-job.mjs status --job x | rg ok | head -3" }],
    ["bash", { command: "echo hello" }],
    ["mcp__antifan_browser_anti_browser_evaluate", { expression: "document.title" }],
    ["eval", { code: "print(1 + 1)" }],
    ["eval", { code: "cat = 3\nprint(cat)" }],
    ["eval", { code: "items.find(x => x.id === 3)" }],
    ["read", {}],
    ["read", { path: 42 }],
    ["lsp", { action: "status" }],
    ["ast_edit", { ops: [] }],
    ["terminal.list", {}],
  ];
  for (const [tool, input] of free) assert.equal(label(tool, input), null, `${tool} ${JSON.stringify(input)} must not count`);
});

test("a call refused for another reason keeps its own code, spends nothing, and wins over an empty budget", async () => {
  const hook = makeHook();
  const hero = path.join(themeRoot, "sections", "hero.liquid");
  for (let i = 0; i < 6; i += 1) {
    assertRefused(await hook.call("write", { path: hero, content: "x" }), "REFUSED_LEADER_THEME_EDIT");
  }
  await spendBudget(hook);
  assertRefused(await hook.call("write", { path: hero, content: "x" }), "REFUSED_LEADER_THEME_EDIT");
  assertRefused(await hook.call("bash", { command: "git log; hrv theme push --only a" }), "REFUSED_LEADER_THEME_CLI");
  assertInvestigateRefused(await hook.call(...investigations()[4]));
});

test("a terminal that is not a Leader never uses the budget", async () => {
  for (const setup of [
    () => arm({ leaders: [OTHER_LEADER] }),
    () => delete process.env.ANTIFAN_TERMINAL_SESSION_ID,
    () => fs.writeFileSync(path.join(configDir, "leader-terminals.json"), "{not json"),
    () =>
      fs.writeFileSync(
        path.join(configDir, "leader-terminals.json"),
        JSON.stringify({ schema: 1, leaders: [OTHER_LEADER], workers: { [LEADER]: { leaderId: OTHER_LEADER, assignedAt: 1 } } }),
      ),
  ]) {
    arm();
    setup();
    const hook = makeHook();
    for (let round = 0; round < 3; round += 1) {
      for (const [tool, input] of investigations()) assert.equal(await hook.call(tool, input), undefined, `${tool} on a non-Leader`);
    }
  }
});

test("a call whose context has no UI, or does not say, is neither refused nor counted, and the write boundary still applies to it", async () => {
  const hook = makeHook();
  for (const hasUI of [false, undefined]) {
    const headless = hook.through({ hasUI });
    for (let round = 0; round < 3; round += 1) {
      for (const [tool, input] of investigations()) assert.equal(await headless.call(tool, input), undefined, `${tool} with hasUI=${hasUI}`);
    }
    assertRefused(await headless.call("write", { path: path.join(themeRoot, "sections", "hero.liquid"), content: "x" }), "REFUSED_LEADER_THEME_EDIT");
    assertRefused(await headless.call("bash", { command: "hrv theme push --only a" }), "REFUSED_LEADER_THEME_CLI");
  }
  await spendBudget(hook);
  assertInvestigateRefused(await hook.call(...investigations()[4]));
});

test("a guard failure or a malformed event never blocks, never throws and never spends the budget", async () => {
  const hook = makeHook();
  const exploding = {};
  Object.defineProperty(exploding, "path", {
    enumerable: true,
    get() {
      throw new Error("state exploded");
    },
  });
  assert.equal(await hook.call("read", exploding), undefined);
  assert.match(hook.warnings.at(-1), /tool_call check failed, call allowed: state exploded/);
  await spendBudget(hook);
  assertInvestigateRefused(await hook.call(...investigations()[4]));

  for (const [tool, input] of [
    ["read", { path: 42 }],
    ["read", undefined],
    ["grep", { path: ["a"] }],
    ["glob", { path: 7 }],
    ["lsp", { file: {} }],
    ["ast_edit", { paths: "x" }],
    ["bash", { command: 42 }],
    ["bash", { command: "\u0000'\"|&&;;|" }],
    ["eval", { code: null }],
  ]) {
    assert.equal(await makeHook().call(tool, input), undefined, `${tool} ${JSON.stringify(input)}`);
  }
  for (const event of [
    undefined,
    null,
    {},
    { toolName: 42 },
    { toolName: "mcp__antifan_browser_terminal_create", content: 7 },
    { toolName: "mcp__antifan_browser_terminal_write", content: [{ type: "text", text: "{not json" }, null] },
    { toolName: "write", input: { path: 5 }, content: [] },
  ]) {
    assert.equal(await hook.emit("tool_result", event), undefined);
  }
});
