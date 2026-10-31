// leader-guard.test.mjs - behavioral tests for the Leader terminal guard hook.
//
// A Leader may not end its turn while a dispatched job is open (session_stop) and may not do
// worker work (tool_call): edit a theme, run a write-class theme CLI command, write the sheet,
// or run a page-writing script. Everything runs against temp dirs; the real data root, the real
// registry and the real ~/.omp are never touched.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(REPO, "src", "omp-hooks");

// The hook imports its siblings by extensionless relative specifier, which Node's ESM
// resolver rejects: copy the unit into a temp tree as .mts with the specifiers rewritten.
const UNIT = ["edit-mode", "theme-paths", "edit-guard-policy", "theme-push-policy", "leader-guard"];
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "leader-guard-"));
const SPECIFIER_RE = new RegExp(`from "\\./(${UNIT.join("|")})"`, "g");
for (const name of UNIT) {
  const source = fs.readFileSync(path.join(SRC, `${name}.ts`), "utf8").replace(SPECIFIER_RE, 'from "./$1.mts"');
  fs.writeFileSync(path.join(TEMP, `${name}.mts`), source);
}
const { default: leaderGuardHook, findOpenJobs, canonicalTool } = await import(
  pathToFileURL(path.join(TEMP, "leader-guard.mts")).href
);

const LEADER = "terminal-7";
const OTHER_LEADER = "terminal-9";
const ENV_KEYS = ["ANTIFAN_TERMINAL_SESSION_ID", "ANTIFAN_CONFIG_DIR", "ANTIFAN_DATA_ROOT", "LEADER_JOBS_ROOT"];
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
let configDir;
let themeRoot;
let plainDir;

/** Arms the process env as the terminal `terminal` of a world whose registry lists `leaders`. */
function arm({ terminal = LEADER, leaders = [LEADER] } = {}) {
  process.env.ANTIFAN_TERMINAL_SESSION_ID = terminal;
  process.env.ANTIFAN_CONFIG_DIR = configDir;
  process.env.LEADER_JOBS_ROOT = jobsRoot;
  fs.writeFileSync(path.join(configDir, "leader-terminals.json"), JSON.stringify({ schema: 1, leaders, workers: {} }));
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  jobsRoot = tempDir("leader-jobs-");
  configDir = tempDir("leader-config-");
  themeRoot = tempDir("leader-theme-");
  for (const dir of ["layout", "templates", "sections", "snippets", "assets", "config"]) {
    fs.mkdirSync(path.join(themeRoot, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(themeRoot, "sections", "hero.liquid"), "<div></div>\n");
  plainDir = tempDir("leader-plain-");
  arm();
});

function makeHook() {
  const handlers = new Map();
  const warnings = [];
  const pi = {
    on: (event, fn) => handlers.set(event, fn),
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
  };
  leaderGuardHook(pi);
  const ctx = { cwd: plainDir, sessionManager: { getSessionId: () => "omp-session" } };
  return {
    warnings,
    stop: () => handlers.get("session_stop")({ type: "session_stop", messages: [], stop_hook_active: false }, ctx),
    call: (toolName, input, cwd = plainDir) =>
      handlers.get("tool_call")({ type: "tool_call", toolName, input }, { ...ctx, cwd }),
  };
}

function writeJob(name, { terminal = LEADER, state = "dispatched", rounds = [{ n: 1 }] } = {}) {
  const dir = path.join(jobsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({ schema: "leader-job/1", job: name, leader: { terminal, ompSessionId: "s" }, state, rounds }),
  );
  return dir.replace(/\\/g, "/");
}

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

test("page-mutating AntiFan tools are refused on every route", async () => {
  const hook = makeHook();
  for (const name of ["anti_agent_cursor_click", "anti_agent_cursor_type", "anti_agent_sequence", "anti_agent_file_upload", "anti_agent_drop", "anti_agent_drag", "anti_agent_set_control"]) {
    assertRefused(await hook.call(`mcp__antifan_browser_${name}`, { selector: "#x" }), "REFUSED_LEADER_PAGE_ACTION");
  }
  assertRefused(
    await hook.call("write", { path: "xd://mcp__antifan_browser_anti_agent_cursor_click", content: '{"selector":"#save"}' }),
    "REFUSED_LEADER_PAGE_ACTION",
  );
  assertRefused(
    await hook.call("eval", { code: "await tool.mcp__antifan_browser_anti_agent_sequence({steps: []})" }),
    "REFUSED_LEADER_PAGE_ACTION",
  );
  assertRefused(await hook.call("mcp__playwright_browser_click", { ref: "e1" }), "REFUSED_LEADER_PAGE_ACTION");
});

test("an evaluate script with a write is refused through the native name, write xd:// and eval", async () => {
  const hook = makeHook();
  const write = "quickUpdate(288, 'Done')";
  assertRefused(await hook.call("mcp__antifan_browser_anti_browser_evaluate", { expression: write }), "REFUSED_LEADER_PAGE_WRITE_SCRIPT");
  assertRefused(
    await hook.call("write", { path: "xd://mcp__antifan_browser_anti_browser_evaluate", content: JSON.stringify({ expression: write }) }),
    "REFUSED_LEADER_PAGE_WRITE_SCRIPT",
  );
  assertRefused(
    await hook.call("eval", { code: `await tool.mcp__antifan_browser_anti_browser_evaluate({expression: "${write}"})` }),
    "REFUSED_LEADER_PAGE_WRITE_SCRIPT",
  );
});

test("every write pattern is refused in an evaluate expression", async () => {
  const hook = makeHook();
  for (const expression of [
    "addNewComment(12, 'ok')",
    "fetch('/cart/add.js', {body: 'id=1'})",
    "fetch('/cart/update.js')",
    "fetch('/cart/clear.js')",
    "fetch(u, { method: 'POST' })",
    'fetch(u, {method:"delete"})',
    "x.open('PUT', u)",
  ]) {
    assertRefused(await hook.call("mcp__antifan_browser_anti_browser_evaluate", { expression }), "REFUSED_LEADER_PAGE_WRITE_SCRIPT");
  }
});

test("an evaluate expressionFile is scanned; an unreadable one is refused", async () => {
  const hook = makeHook();
  const bad = path.join(plainDir, "bad.js");
  fs.writeFileSync(bad, "const r = await fetch('/x', { method: 'PATCH' }); r.ok");
  const good = path.join(plainDir, "good.js");
  fs.writeFileSync(good, "originalFeedback.filter((f) => f.id === '288').length");
  assertRefused(await hook.call("mcp__antifan_browser_anti_browser_evaluate", { expressionFile: "bad.js" }), "REFUSED_LEADER_PAGE_WRITE_SCRIPT");
  assert.equal(await hook.call("mcp__antifan_browser_anti_browser_evaluate", { expressionFile: "good.js" }), undefined);
  assertRefused(await hook.call("mcp__antifan_browser_anti_browser_evaluate", { expressionFile: "missing.js" }), "REFUSED_LEADER_UNREADABLE");
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
