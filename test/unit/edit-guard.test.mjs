// edit-guard.test.mjs - behavioral tests for the Direct/Super-Fast edit-mode guard
//
// Verifies the four units that make up the guard:
// 1. edit-mode.ts    - tag vocabulary, latch semantics, branch replay
// 2. theme-paths.ts  - workspace shape resolution and the writable set
// 3. edit-guard-policy.ts - tool-call refusals (mode tools, devices, write scope)
// 4. edit-guard.ts   - hook wiring: latch, audit log, mode mirror, fail-closed writes

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(REPO, "src", "omp-hooks");

// The hook imports its siblings by extensionless relative specifier, which Node's
// ESM resolver rejects. Copy the whole unit into a temp tree as .mts with the
// specifiers rewritten - same trick as anti-direct-policy.test.mjs, extended to a
// multi-file module.
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "edit-guard-"));
for (const name of ["edit-mode", "theme-paths", "edit-guard-policy", "edit-guard"]) {
  const source = fs.readFileSync(path.join(SRC, `${name}.ts`), "utf8").replace(
    /from "\.\/(edit-mode|theme-paths|edit-guard-policy)"/g,
    'from "./$1.mts"',
  );
  fs.writeFileSync(path.join(TEMP, `${name}.mts`), source);
}

const load = (name) => import(pathToFileURL(path.join(TEMP, `${name}.mts`)).href);
const mode = await load("edit-mode");
const paths = await load("theme-paths");
const policy = await load("edit-guard-policy");
const { default: editGuardHook } = await load("edit-guard");

const {
  deriveEditMode,
  readEditModeEnv,
  readEditModeFromBranch,
  EDIT_MODE_ENV,
  SUPER_FAST_TAG_RE,
} = mode;

// The guard publishes the active mode through `ANTIFAN_EDIT_MODE` as the subagent
// inheritance channel, and only `session_shutdown` clears it. That is production
// behavior; a case must not inherit it from the case before it, so `makeHook` starts
// from a clean latch and this restores whatever the caller of the lane had.
const LATCH_AT_LOAD = process.env[EDIT_MODE_ENV];
after(() => {
  if (LATCH_AT_LOAD === undefined) delete process.env[EDIT_MODE_ENV];
  else process.env[EDIT_MODE_ENV] = LATCH_AT_LOAD;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Theme workspace: `<root>/.antifan/`, `<root>/templates/`, `<root>/assets/`. */
function makeThemeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "theme-ws-"));
  for (const dir of [
    ".antifan/qa-receipts",
    "layout",
    "templates",
    "sections",
    "snippets",
    "assets",
    "config",
    "locales",
    "docs",
    "node_modules/pkg",
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# workspace\n");
  fs.writeFileSync(path.join(root, "templates", "hero.liquid"), "<div></div>\n");
  return root;
}

function makePlainWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plain-ws-"));
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  return root;
}

function makeHook(options = {}) {
  // A scoped case arms the env latch and most cases never emit `session_shutdown`, so
  // without this the case that armed Direct would arm every case after it. The one case
  // that tests the latch itself sets it after construction.
  delete process.env[EDIT_MODE_ENV];
  const handlers = new Map();
  const entries = [];
  const warnings = [];
  const pi = {
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    appendEntry: (customType, data) => entries.push({ customType, data }),
    logger: {
      info: () => {},
      warn: (message) => {
        // A host logger that throws is a real failure mode: reporting must never decide a call.
        if (options.warnThrows) throw new Error("logger down");
        warnings.push(message);
      },
    },
  };
  const context = (cwd, sessionId, branch = []) => ({
    cwd,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
  });
  const emit = async (event, payload, ctx) => {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler({ type: event, ...payload }, ctx));
    }
    return results.filter((value) => value !== undefined);
  };
  return { pi, entries, warnings, context, emit };
}

async function withDataRoot(prefix, fn) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previous = process.env.ANTIFAN_DATA_ROOT;
  process.env.ANTIFAN_DATA_ROOT = dataRoot;
  try {
    return await fn(dataRoot);
  } finally {
    if (previous === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previous;
  }
}

// ---------------------------------------------------------------------------
// 1. Mode vocabulary
// ---------------------------------------------------------------------------

test("tag vocabulary covers emoji and plain spellings, case-insensitively", () => {
  assert.equal(deriveEditMode("[🚀Super-Fast] fix it").mode, "fast");
  assert.equal(deriveEditMode("[Super-Fast] fix it").mode, "fast");
  assert.equal(deriveEditMode("[super fast] fix it").mode, "fast");
  assert.equal(deriveEditMode("[⚡Direct-Edit] fix it").mode, "direct");
  assert.equal(deriveEditMode("[direct edit] fix it").mode, "direct");
  assert.equal(deriveEditMode("[🧠Core-Context] think").mode, "core");
  assert.equal(deriveEditMode("[Core-Pack] think").mode, "core");
  assert.equal(deriveEditMode("[🎨Theme-Fix] unrelated chip").mode, "unset");
  assert.equal(SUPER_FAST_TAG_RE.test("[🚀Super-Fast]"), true);
});

test("tags win over the latch; a tagless prompt disarms back to normal chat", () => {
  const latched = deriveEditMode("[⚡Direct-Edit] go", "unset");
  assert.deepEqual(latched, { mode: "direct", trigger: "annotation_tag", changed: true });

  // The mode is annotation-scoped: a prompt with no mode signal is normal chat,
  // not a continuation of the armed run.
  const reset = deriveEditMode("keep working on the hero section", "direct");
  assert.deepEqual(reset, { mode: "unset", trigger: "none", changed: true });

  const disarmed = deriveEditMode("[🧠Core-Context] now think", "fast");
  assert.deepEqual(disarmed, { mode: "core", trigger: "annotation_tag", changed: true });

  assert.equal(deriveEditMode("/skill:anti-direct", "unset").trigger, "skill_invocation");
  assert.equal(deriveEditMode("sửa trực tiếp đi", "unset").mode, "direct");
  assert.equal(deriveEditMode("bỏ qua core", "unset").trigger, "natural_language");
});

test("env is an initial latch only, never an override of what the person types", () => {
  assert.equal(readEditModeEnv({ [EDIT_MODE_ENV]: " fast " }), "fast");
  assert.equal(readEditModeEnv({ [EDIT_MODE_ENV]: "turbo" }), null);
  assert.equal(readEditModeEnv({}), null);
  // deriveEditMode has no env parameter: only the prompt's own signals decide.
  assert.equal(deriveEditMode("[🧠Core-Context]", "fast").mode, "core");
});

test("branch replay returns the last latched mode, or null", () => {
  const branch = [
    { type: "message", role: "user" },
    { type: "custom", customType: "antifan.edit-mode", data: { mode: "direct" } },
    { type: "message", role: "assistant" },
    { type: "custom", customType: "antifan.edit-mode", data: { mode: "fast" } },
  ];
  assert.equal(readEditModeFromBranch(branch), "fast");
  assert.equal(readEditModeFromBranch([{ type: "message" }]), null);
  assert.equal(readEditModeFromBranch(undefined), null);
  assert.equal(readEditModeFromBranch([{ type: "custom", customType: "antifan.edit-mode", data: {} }]), null);
});

// ---------------------------------------------------------------------------
// 2. Workspace shape and the writable set
// ---------------------------------------------------------------------------

test("resolveWorkspaceShape finds the theme root, the annotation root and the writable set", () => {
  const root = makeThemeWorkspace();
  const shape = paths.resolveWorkspaceShape(path.join(root, "templates"), {});
  assert.equal(shape.themeRoot, root);
  assert.equal(shape.annotationRoot, root);
  assert.equal(shape.workspaceRoot, root);
  assert.ok(shape.editableRoots.includes(path.join(root, "templates")));
  assert.ok(shape.editableRoots.includes(path.join(root, "assets")));
  assert.ok(shape.editableRoots.includes(path.join(root, ".antifan")));
  assert.ok(!shape.editableRoots.includes(path.join(root, "node_modules")));
});

test("classifyWritePath allows the theme, refuses escapes and unrelated trees", () => {
  const root = makeThemeWorkspace();
  const shape = paths.resolveWorkspaceShape(root, {});

  assert.equal(paths.classifyWritePath(shape, "assets/theme.scss").decision, "allow");
  assert.equal(paths.classifyWritePath(shape, "templates/hero.liquid").decision, "allow");
  assert.equal(paths.classifyWritePath(shape, "docs/plan.md").decision, "allow");
  assert.equal(paths.classifyWritePath(shape, "AGENTS.md").decision, "allow");

  const outside = paths.classifyWritePath(shape, "../outside/evil.liquid");
  assert.equal(outside.decision, "block");
  assert.equal(outside.code, "REFUSED_EDIT_SCOPE");

  const dependency = paths.classifyWritePath(shape, "node_modules/pkg/index.js");
  assert.equal(dependency.decision, "block");
  assert.equal(dependency.code, "REFUSED_EDIT_SCOPE");

  const inner = paths.classifyWritePath(shape, path.join(root, "assets", "nested", "x.scss"));
  assert.equal(inner.decision, "allow");
});

test("a workspace with no theme root refuses writes, fail closed", () => {
  const root = makePlainWorkspace();
  const shape = paths.resolveWorkspaceShape(path.join(root, "notes"), {});
  // This machine's home directory carries both `.antifan/` and a synced theme, so
  // the walk legitimately binds a throwing directory to it; what matters is that a
  // write outside the resolved writable set is refused.
  const verdict = paths.classifyWritePath(shape, path.join(root, "notes", "a.md"));
  assert.equal(verdict.decision, "block");
  assert.equal(verdict.code, "REFUSED_EDIT_SCOPE");

  // A drive root has no `.antifan/` and no theme directories above it at all.
  const unbound = paths.resolveWorkspaceShape("E:/", {});
  assert.equal(unbound.annotationRoot, null);
  assert.equal(unbound.themeRoot, null);
  const failClosed = paths.classifyWritePath(unbound, "E:/scratch/a.md");
  assert.equal(failClosed.decision, "block");
  assert.equal(failClosed.code, "REFUSED_THEME_ROOT_UNRESOLVED");
  assert.ok(failClosed.reason.includes("Core-Context"));
});

test("edit-guard.json widens the allow-list, a broken file never crashes resolution", () => {
  const root = makeThemeWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-ws-"));
  return withDataRoot("edit-guard-data-", async (dataRoot) => {
    fs.writeFileSync(
      path.join(dataRoot, "edit-guard.json"),
      JSON.stringify({ allowExtraPaths: [outside] }),
    );
    const shape = paths.resolveWorkspaceShape(root, process.env);
    assert.deepEqual(shape.allowExtraPaths, [path.resolve(outside)]);
    assert.equal(
      paths.classifyWritePath(shape, path.join(outside, "snippet.liquid")).decision,
      "allow",
    );

    fs.writeFileSync(path.join(dataRoot, "edit-guard.json"), "{ not json");
    const broken = paths.resolveWorkspaceShape(root, process.env);
    assert.equal(broken.allowExtraPaths.length, 0);
    assert.ok(typeof broken.configError === "string" && broken.configError.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Tool-call policy
// ---------------------------------------------------------------------------

function plan(modeName, tool, input, root) {
  const shape = paths.resolveWorkspaceShape(root ?? makeThemeWorkspace(), {});
  return policy.planToolCall({ mode: modeName, tool, input, shape });
}

test("unset and core modes are pass-through", () => {
  assert.equal(plan("unset", "bash", { command: "ls" }).decision, "allow");
  assert.equal(plan("core", "write", { path: "../elsewhere.liquid" }).decision, "allow");
});

test("Super-Fast refuses the shell, dispatch, the network and every device call", () => {
  for (const tool of ["bash", "eval", "task", "web_search"]) {
    const verdict = plan("fast", tool, { command: "ls" });
    assert.equal(verdict.decision, "block", `${tool} must be blocked`);
    assert.equal(verdict.code, "REFUSED_FAST_MODE_TOOL");
  }
  const mcp = plan("fast", "write", {
    path: "xd://mcp__antifan_browser_anti_browser_tabs_list",
    content: "{}",
  });
  assert.equal(mcp.decision, "block");
  assert.equal(mcp.code, "REFUSED_FAST_MODE_MCP");
  assert.equal(mcp.device, "xd://mcp__antifan_browser_anti_browser_tabs_list");
  assert.ok(mcp.reason.includes("Super-Fast"));

  assert.equal(plan("fast", "anti.browser.navigate", { url: "https://x" }).code, "REFUSED_FAST_MODE_MCP");
  assert.equal(plan("fast", "read", { path: "xd://lsp" }).code, "REFUSED_FAST_MODE_MCP");
});

test("Direct suppresses Core but refuses no tool — dispatch, eval, shell and devices all pass", () => {
  assert.equal(plan("direct", "task", {}).decision, "allow");
  assert.equal(plan("direct", "eval", {}).decision, "allow");
  assert.equal(plan("direct", "bash", { command: "ls" }).decision, "allow");
  const mcp = plan("direct", "write", { path: "xd://mcp__antifan_browser_anti_inspect_styles" });
  assert.equal(mcp.decision, "allow");
  assert.equal(plan("direct", "read", { path: "xd://lsp" }).decision, "allow");
});

test("write scope is enforced in Fast per target, and an unnamed target is refused", () => {
  const root = makeThemeWorkspace();
  assert.equal(plan("fast", "write", { path: "assets/a.scss" }, root).decision, "allow");
  const blocked = plan("fast", "edit", { path: "src/main/index.ts" }, root);
  assert.equal(blocked.decision, "block");
  assert.equal(blocked.code, "REFUSED_EDIT_SCOPE");
  // Direct does not scope writes: the same out-of-theme target is allowed.
  assert.equal(plan("direct", "edit", { path: "src/main/index.ts" }, root).decision, "allow");

  const patch = plan("fast", "edit", { input: "[node_modules/pkg/index.js#ABCD]\n-old\n+new" }, root);
  assert.equal(patch.decision, "block");
  assert.equal(patch.code, "REFUSED_EDIT_SCOPE");
  assert.deepEqual(patch.targets, [path.resolve(root, "node_modules/pkg/index.js")]);

  const unnamed = plan("fast", "write", { content: "orphan" }, root);
  assert.equal(unnamed.decision, "block");
  assert.equal(unnamed.code, "REFUSED_EDIT_SCOPE");
  assert.equal(plan("fast", "write", { path: 42, content: "x" }, root).decision, "block");
});

test("extractTargetPaths and deviceLabel follow the production path conventions", () => {
  assert.deepEqual(
    policy.extractTargetPaths({ path: "a.liquid", file: "b.liquid", filePath: "a.liquid" }),
    ["a.liquid", "b.liquid"],
  );
  assert.deepEqual(policy.extractTargetPaths({ input: "[sections/x.liquid#TAG]\n+x" }), [
    "sections/x.liquid",
  ]);
  assert.deepEqual(policy.extractTargetPaths(undefined), []);
  assert.equal(
    policy.deviceLabel("xd://mcp__antifan_browser_anti_browser_tabs_list"),
    "anti.browser.tabs.list",
  );
});

// ---------------------------------------------------------------------------
// 4. Hook wiring
// ---------------------------------------------------------------------------

test("arming Super-Fast latches, persists the branch entry, writes the mirror, sets the env", async () => {
  const root = makeThemeWorkspace();
  await withDataRoot("guard-mirror-", async (dataRoot) => {
    const hook = makeHook();
    editGuardHook(hook.pi);
    const ctx = hook.context(root, "sess-fast");
    await hook.emit("session_start", {}, ctx);
    await hook.emit("before_agent_start", { prompt: "[🚀Super-Fast] fix the hero" }, ctx);

    assert.equal(hook.entries.length, 1);
    assert.equal(hook.entries[0].customType, "antifan.edit-mode");
    assert.equal(hook.entries[0].data.mode, "fast");
    assert.equal(process.env[EDIT_MODE_ENV], "fast");

    const mirror = JSON.parse(
      fs.readFileSync(path.join(dataRoot, "runtime", "edit-mode", "sess-fast.json"), "utf8"),
    );
    assert.equal(mirror.mode, "fast");
    assert.equal(mirror.schema, 1);
    assert.equal(mirror.ompSessionId, "sess-fast");

    // A tagless follow-up prompt is normal chat: the mode resets to unset, a
    // second entry records the change, and the env latch is cleared.
    await hook.emit("before_agent_start", { prompt: "now the footer" }, ctx);
    assert.equal(hook.entries.length, 2);
    assert.equal(hook.entries[1].data.mode, "unset");
    assert.equal(process.env[EDIT_MODE_ENV], undefined);

    await hook.emit("session_shutdown", {}, ctx);
    assert.equal(process.env[EDIT_MODE_ENV], undefined);
    assert.equal(fs.existsSync(path.join(dataRoot, "runtime", "edit-mode", "sess-fast.json")), false);
  });
});

test("Core-Context disarms a latched Fast session and the mirror is dropped on shutdown", async () => {
  const root = makeThemeWorkspace();
  await withDataRoot("guard-disarm-", async (dataRoot) => {
    const hook = makeHook();
    editGuardHook(hook.pi);
    const ctx = hook.context(root, "sess-disarm");
    await hook.emit("session_start", {}, ctx);
    await hook.emit("before_agent_start", { prompt: "[🚀Super-Fast] go" }, ctx);
    await hook.emit("before_agent_start", { prompt: "[🧠Core-Context] analyse" }, ctx);
    assert.equal(process.env[EDIT_MODE_ENV], "core");
    const blocked = await hook.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx);
    assert.deepEqual(blocked, []);

    await hook.emit("session_shutdown", {}, ctx);
    assert.equal(fs.existsSync(path.join(dataRoot, "runtime", "edit-mode", "sess-disarm.json")), false);
  });
});

test("a resumed session rehydrates Fast from the branch; a plain prompt then ends it", async () => {
  const root = makeThemeWorkspace();
  const branch = [
    { type: "message", role: "user" },
    { type: "custom", customType: "antifan.edit-mode", data: { mode: "fast" } },
  ];
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-resume", branch);
  await hook.emit("session_start", {}, ctx);
  // Before the first prompt the latch still reads from the branch.
  const armedRefusal = await hook.emit(
    "tool_call",
    { toolName: "write", input: { path: "xd://mcp__antifan_browser_anti_browser_tabs_list" } },
    ctx,
  );
  assert.equal(armedRefusal.length, 1);
  assert.ok(armedRefusal[0].reason.includes("REFUSED_FAST_MODE_MCP"));
  // The resumed session's first real prompt carries no tag: normal chat resumes.
  await hook.emit("before_agent_start", { prompt: "continue" }, ctx);
  const afterReset = await hook.emit(
    "tool_call",
    { toolName: "write", input: { path: "xd://mcp__antifan_browser_anti_browser_tabs_list" } },
    ctx,
  );
  assert.deepEqual(afterReset, [], "a plain prompt unscopes a mode rehydrated from the branch");
});

test("refusals and audit rows in Fast: scope refusal, tool refusal, allow rows with runSeq", async () => {
  const root = makeThemeWorkspace();
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-audit");
  await hook.emit("session_start", {}, ctx);
  await hook.emit("before_agent_start", { prompt: "[🚀Super-Fast] fix hero" }, ctx);

  const scopeRefusal = await hook.emit(
    "tool_call",
    { toolName: "write", input: { path: "src/main/other.ts" } },
    ctx,
  );
  assert.equal(scopeRefusal.length, 1);
  assert.equal(scopeRefusal[0].block, true);
  assert.ok(scopeRefusal[0].reason.includes("REFUSED_EDIT_SCOPE"));
  assert.ok(hook.warnings.some((message) => message.includes("REFUSED_EDIT_SCOPE")));

  const dispatchRefusal = await hook.emit("tool_call", { toolName: "task", input: {} }, ctx);
  assert.equal(dispatchRefusal.length, 1);
  assert.ok(dispatchRefusal[0].reason.includes("REFUSED_FAST_MODE_TOOL"));

  const allowed = await hook.emit(
    "tool_call",
    { toolName: "write", input: { path: "sections/hero.liquid" } },
    ctx,
  );
  assert.deepEqual(allowed, []);

  const logPath = path.join(root, ".antifan", "edit-guard", "sess-audit.jsonl");
  const rows = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => [row.decision, row.code]),
    [
      ["block", "REFUSED_EDIT_SCOPE"],
      ["block", "REFUSED_FAST_MODE_TOOL"],
      ["allow", "ALLOWED"],
    ],
  );
  assert.equal(rows[0].runSeq, 1);
  assert.equal(rows[0].ompSessionId, "sess-audit");
  assert.equal(rows[2].path, path.resolve(root, "sections/hero.liquid"));
});

test("a resumed session continues the run number its log already holds", async () => {
  const root = makeThemeWorkspace();
  const logPath = path.join(root, ".antifan", "edit-guard", "sess-continue.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // What a session killed mid-run leaves behind, plus a torn line and a malformed
  // row: the counter must survive all three, because the QA gate's changed-file
  // count reads the log's maximum and a restart at 1 would attribute run 3's
  // writes to the new run.
  fs.writeFileSync(
    logPath,
    [
      JSON.stringify({ ts: "2026-09-28T10:00:00.000Z", runSeq: 2, mode: "fast", tool: "edit", path: "/x", decision: "allow", code: "ALLOWED" }),
      JSON.stringify({ ts: "2026-09-28T10:05:00.000Z", runSeq: 3, mode: "fast", tool: "edit", path: "/y", decision: "allow", code: "ALLOWED" }),
      '{"ts":"2026-09-28T10:06:00.000Z","runSeq":4,"mode":"fast"',
      '{"ts":"2026-09-28T10:07:00.000Z","mode":"fast"}',
      JSON.stringify({ ts: "2026-09-28T10:08:00.000Z", runSeq: "5", mode: "fast" }),
      "",
    ].join("\n"),
  );

  const before = fs.readFileSync(logPath, "utf8");
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-continue");
  await hook.emit("session_start", {}, ctx);
  await hook.emit("before_agent_start", { prompt: "[⚡Direct-Edit] continue" }, ctx);
  await hook.emit("tool_call", { toolName: "write", input: { path: "sections/hero.liquid" } }, ctx);

  // Only what this run appended: the planted rows are the history it must not
  // renumber, and one of them is deliberately unparsable.
  const appended = fs
    .readFileSync(logPath, "utf8")
    .slice(before.length)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(appended.length, 1);
  assert.equal(appended[0].decision, "allow");
  assert.equal(appended[0].runSeq, 4, "the run after resume continues past the log's highest readable run (3)");
});

test("a session with no readable log starts at run 1", async () => {
  const root = makeThemeWorkspace();
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-fresh-id");
  await hook.emit("session_start", {}, ctx);
  await hook.emit("before_agent_start", { prompt: "[⚡Direct-Edit] go" }, ctx);
  await hook.emit("tool_call", { toolName: "write", input: { path: "sections/hero.liquid" } }, ctx);

  const rows = fs
    .readFileSync(path.join(root, ".antifan", "edit-guard", "sess-fresh-id.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(rows[0].runSeq, 1);
});

test("only file-changing calls enter the audit log, so the changed-file count stays honest", async () => {
  const root = makeThemeWorkspace();
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-change-count");
  await hook.emit("session_start", {}, ctx);
  await hook.emit("before_agent_start", { prompt: "[🚀Super-Fast] fix hero" }, ctx);

  // A scoped session inspects constantly; none of that is a change, and the row
  // count is what `turn_end` and the Manager run card report as "files changed".
  await hook.emit("tool_call", { toolName: "read", input: { path: path.join(root, "templates", "hero.liquid") } }, ctx);
  await hook.emit("tool_call", { toolName: "grep", input: { path: root } }, ctx);
  await hook.emit("tool_call", { toolName: "edit", input: { path: path.join(root, "sections", "hero.liquid") } }, ctx);
  await hook.emit("tool_call", { toolName: "edit", input: { path: path.join(root, "sections", "hero.liquid") } }, ctx);
  await hook.emit("tool_call", { toolName: "write", input: { path: path.join(root, "assets", "x.scss") } }, ctx);

  const rows = fs
    .readFileSync(path.join(root, ".antifan", "edit-guard", "sess-change-count.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows.map((row) => [row.tool, row.decision, row.code]),
    [
      ["edit", "allow", "ALLOWED"],
      ["edit", "allow", "ALLOWED"],
      ["write", "allow", "ALLOWED"],
    ],
  );
});

test("scoped mode never throws on hostile input", async () => {
  const root = makeThemeWorkspace();
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-hostile");
  await hook.emit("session_start", {}, ctx);
  await hook.emit("before_agent_start", { prompt: "[🚀Super-Fast]" }, ctx);
  const long = "x".repeat(200_000);

  const cases = [
    { toolName: "write" },
    { toolName: "write", input: null },
    { toolName: "edit", input: { path: { nested: true } } },
    { toolName: "write", input: { path: `${long}.liquid` } },
    { input: { path: "assets/a.scss" } },
    {},
  ];
  for (const payload of cases) {
    const results = await hook.emit("tool_call", payload, ctx);
    for (const result of results) {
      if (result?.block) assert.ok(typeof result.reason === "string" && result.reason.length > 0);
    }
  }
  const noContext = await hook.emit("tool_call", { toolName: "bash", input: {} }, undefined);
  assert.equal(Array.isArray(noContext), true);
});

test("env latch alone arms a scoped session (subagent inheritance)", async () => {
  const root = makeThemeWorkspace();
  const hook = makeHook();
  // After `makeHook`: a subagent inherits a latch that is already set, it does not
  // install one before the guard exists.
  process.env[EDIT_MODE_ENV] = "fast";
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-inherited");
  await hook.emit("session_start", {}, ctx);
  const refusal = await hook.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx);
  assert.equal(refusal.length, 1);
  assert.ok(refusal[0].reason.includes("REFUSED_FAST_MODE_TOOL"));
});

test("a tagless session with no latch is pass-through, and a session killed before shutdown arms nothing else", async () => {
  const root = makeThemeWorkspace();

  // A session that armed and was killed before `session_shutdown`: the latch it published
  // is the state this case is about, and it is left set on the way out.
  const armed = makeHook();
  editGuardHook(armed.pi);
  const armedCtx = armed.context(root, "sess-killed-before-shutdown");
  await armed.emit("session_start", {}, armedCtx);
  await armed.emit("before_agent_start", { prompt: "[🚀Super-Fast] go" }, armedCtx);
  const armedRefusal = await armed.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, armedCtx);
  assert.equal(armedRefusal.length, 1, "the armed session refuses the shell");
  assert.equal(process.env[EDIT_MODE_ENV], "fast", "the armed session published the latch a subagent would inherit");

  // The next session: no tag, and a hook built from scratch. It must not have been armed.
  const next = makeHook();
  editGuardHook(next.pi);
  const nextCtx = next.context(root, "sess-after-a-killed-one");
  await next.emit("session_start", {}, nextCtx);
  await next.emit("before_agent_start", { prompt: "no tag here" }, nextCtx);
  const passThrough = await next.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, nextCtx);
  assert.deepEqual(passThrough, [], "a tagless session holding no latch passes the shell through");
});

test("a throwing logger or an unprintable thrown value cannot defeat the refusal", async () => {
  const root = makeThemeWorkspace();

  // (1) The ordinary refusal path, with a host logger that throws.
  const hostileLogger = makeHook({ warnThrows: true });
  editGuardHook(hostileLogger.pi);
  const fastCtx = hostileLogger.context(root, "sess-logger-down-fast");
  await hostileLogger.emit("session_start", {}, fastCtx);
  await hostileLogger.emit("before_agent_start", { prompt: "[🚀Super-Fast] go" }, fastCtx);
  const refused = await hostileLogger.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, fastCtx);
  assert.equal(refused.length, 1, "the refusal survives its own warning");
  assert.ok(refused[0].reason.includes("REFUSED_FAST_MODE_TOOL"), "and keeps the policy code, not a guard error");

  // (2) The fail-closed path, with the same logger and thrown values that cannot be
  // coerced to text: a null-prototype object (`String` throws, `Object.prototype.toString`
  // still answers) and a hostile proxy (both throw).
  const nullPrototype = Object.create(null);
  const hostileProxy = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error("no prototype");
      },
      get: () => {
        throw new Error("no properties");
      },
    },
  );
  const loggerDown = makeHook({ warnThrows: true });
  editGuardHook(loggerDown.pi);
  const scopedCtx = loggerDown.context(root, "sess-logger-down-guard-error");
  await loggerDown.emit("session_start", {}, scopedCtx);
  await loggerDown.emit("before_agent_start", { prompt: "[🚀Super-Fast] go" }, scopedCtx);
  const write = { toolName: "write", input: { path: "sections/hero.liquid" } };
  const throwingContext = (thrown) => ({
    cwd: root,
    sessionManager: {
      getSessionId: () => {
        throw thrown;
      },
      getBranch: () => [],
    },
  });

  const guardError = await loggerDown.emit("tool_call", write, throwingContext(nullPrototype));
  assert.equal(guardError.length, 1, "the refusal survives an unprintable throw");
  assert.ok(guardError[0].reason.includes("REFUSED_GUARD_ERROR"));
  assert.equal(typeof guardError[0].reason, "string");

  const proxyError = await loggerDown.emit("tool_call", write, throwingContext(hostileProxy));
  assert.equal(proxyError.length, 1, "the refusal survives a throw that cannot be described at all");
  assert.ok(proxyError[0].reason.includes("REFUSED_GUARD_ERROR"));
  assert.ok(proxyError[0].reason.includes("unprintable error"), "and names the value it could not print");
});

test("a call the guard cannot classify is refused while scoped and passed through when unscoped", async () => {
  const root = makeThemeWorkspace();
  // A context whose identity read throws. That is where the handler body starts, so a
  // throw here is the guard failing to classify the call at all.
  const unreadableContext = {
    cwd: root,
    sessionManager: {
      getSessionId: () => {
        throw new Error("identity read failed");
      },
      getBranch: () => [],
    },
  };
  const write = { toolName: "write", input: { path: "sections/hero.liquid" } };

  const scoped = makeHook();
  editGuardHook(scoped.pi);
  const scopedCtx = scoped.context(root, "sess-guard-error");
  await scoped.emit("session_start", {}, scopedCtx);
  await scoped.emit("before_agent_start", { prompt: "[🚀Super-Fast] go" }, scopedCtx);
  const scopedResult = await scoped.emit("tool_call", write, unreadableContext);
  assert.equal(scopedResult.length, 1, "a guard that cannot classify a call must not clear it");
  assert.ok(scopedResult[0].reason.includes("REFUSED_GUARD_ERROR"));
  assert.ok(scoped.warnings.some((message) => message.includes("REFUSED_GUARD_ERROR")));

  const unscoped = makeHook();
  editGuardHook(unscoped.pi);
  const unscopedCtx = unscoped.context(root, "sess-guard-error-unscoped");
  await unscoped.emit("session_start", {}, unscopedCtx);
  await unscoped.emit("before_agent_start", { prompt: "no tag here" }, unscopedCtx);
  const unscopedResult = await unscoped.emit("tool_call", write, unreadableContext);
  assert.deepEqual(unscopedResult, [], "an unscoped session has nothing to enforce, so a failure is not a refusal");
});

// ---------------------------------------------------------------------------
// config/settings_data.json: writable in every mode, after one scoped fetch per run
// ---------------------------------------------------------------------------

const { HRV_COMMAND_ENV } = await load("edit-guard");
const HRV_AT_LOAD = process.env[HRV_COMMAND_ENV];
after(() => {
  if (HRV_AT_LOAD === undefined) delete process.env[HRV_COMMAND_ENV];
  else process.env[HRV_COMMAND_ENV] = HRV_AT_LOAD;
});

/**
 * A stand-in `hrv` that records its argv and prints the CLI's real success or
 * failure line. The real CLI exits 0 either way, so the stub does too.
 */
function installHrvStub({ succeed }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrv-stub-"));
  const calls = path.join(dir, "calls.jsonl");
  const script = path.join(dir, "hrv.mjs");
  const line = succeed ? "✓ Tải về thành công 1 file." : "Fetch thất bại: Không tìm thấy file trên remote.";
  fs.writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
      `console.log(${JSON.stringify(line)});`,
    ].join("\n"),
  );
  process.env[HRV_COMMAND_ENV] = `"${process.execPath}" "${script}"`;
  const recorded = () =>
    fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").trim().split("\n").map((row) => JSON.parse(row))
      : [];
  return { recorded };
}

function bindShop(root) {
  fs.writeFileSync(
    path.join(root, ".haravan-cli_local.json"),
    JSON.stringify({ org_id: "200001", theme_id: "1001507144", theme_name: "Stub", theme_org_id: "200001" }),
  );
}

const SETTINGS_WRITE = { toolName: "write", input: { path: "config/settings_data.json", content: "{}" } };

function readLog(root, sessionId) {
  return fs
    .readFileSync(path.join(root, ".antifan", "edit-guard", `${sessionId}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

for (const [label, prompt] of [
  ["unset", "no tag here"],
  ["core", "[🧠Core-Context] think"],
  ["direct", "[⚡Direct-Edit] update config"],
  ["fast", "[🚀Super-Fast] update config"],
]) {
  test(`settings_data.json write in mode === '${label}' fetches once from the bound shop, then passes`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installHrvStub({ succeed: true });
    const hook = makeHook();
    editGuardHook(hook.pi);
    const ctx = hook.context(root, `sess-settings-${label}`);
    await hook.emit("session_start", {}, ctx);
    await hook.emit("before_agent_start", { prompt }, ctx);

    assert.deepEqual(await hook.emit("tool_call", SETTINGS_WRITE, ctx), [], "the write passes after a successful fetch");
    assert.deepEqual(await hook.emit("tool_call", SETTINGS_WRITE, ctx), [], "a second write in the same run passes");
    const calls = stub.recorded();
    assert.equal(calls.length, 1, "one fetch per run, not per write");
    assert.deepEqual(calls[0].argv, ["theme", "fetch", "1001507144", "--only", "config/settings_data.json"]);
    assert.equal(path.resolve(calls[0].cwd).toLowerCase(), path.resolve(root).toLowerCase(), "fetch runs in the theme root");
    assert.ok(hook.warnings.some((m) => m.includes("refreshed from shop org=200001 theme=1001507144")));

    await hook.emit("before_agent_start", { prompt }, ctx);
    await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.equal(stub.recorded().length, 2, "the next run fetches again");

    // Scoped modes also account the write itself; unscoped modes only record the fetch.
    const scoped = label === "direct" || label === "fast";
    assert.deepEqual(
      readLog(root, `sess-settings-${label}`).map((row) => `${row.tool}:${row.code}`),
      scoped
        ? [
            "hrv theme fetch:SETTINGS_DATA_FETCHED",
            "write:ALLOWED",
            "write:ALLOWED",
            "hrv theme fetch:SETTINGS_DATA_FETCHED",
            "write:ALLOWED",
          ]
        : ["hrv theme fetch:SETTINGS_DATA_FETCHED", "hrv theme fetch:SETTINGS_DATA_FETCHED"],
    );
  });
}

test("settings_data.json write is refused when the scoped fetch fails, and retried on the next call", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const stub = installHrvStub({ succeed: false });
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-settings-fetch-fail");
  await hook.emit("session_start", {}, ctx);
  await hook.emit("before_agent_start", { prompt: "no tag here" }, ctx);

  const first = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
  assert.equal(first.length, 1);
  assert.equal(first[0].block, true);
  assert.ok(first[0].reason.includes("REFUSED_SETTINGS_DATA_FETCH_FAILED"));
  assert.ok(first[0].reason.includes("Không tìm thấy file trên remote"), "the CLI's own failure line is surfaced");
  const second = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
  assert.equal(second.length, 1, "a failed fetch is not remembered as done");
  assert.equal(stub.recorded().length, 2);

  const rows = readLog(root, "sess-settings-fetch-fail");
  assert.deepEqual(
    rows.map((row) => `${row.decision}:${row.code}`),
    ["block:REFUSED_SETTINGS_DATA_FETCH_FAILED", "block:REFUSED_SETTINGS_DATA_FETCH_FAILED"],
  );

  const other = await hook.emit(
    "tool_call",
    { toolName: "write", input: { path: "snippets/header.liquid", content: "<p></p>" } },
    ctx,
  );
  assert.deepEqual(other, [], "only settings_data.json is gated on the fetch");
});

test("settings_data.json write in a workspace with no bound shop passes without a fetch", async () => {
  const root = makeThemeWorkspace();
  const stub = installHrvStub({ succeed: true });
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-settings-unbound");
  await hook.emit("session_start", {}, ctx);
  assert.deepEqual(await hook.emit("tool_call", SETTINGS_WRITE, ctx), []);
  assert.equal(stub.recorded().length, 0, "nothing to fetch from");
  assert.ok(hook.warnings.some((m) => m.includes("writing without a remote fetch")));
  assert.deepEqual(
    readLog(root, "sess-settings-unbound").map((row) => row.code),
    ["SETTINGS_DATA_UNBOUND"],
  );
});

test("hook allows normal edits like snippets/header.liquid in mode === 'unset'", async () => {
  const root = makeThemeWorkspace();
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-unset-header");
  await hook.emit("session_start", {}, ctx);
  const result = await hook.emit(
    "tool_call",
    { toolName: "write", input: { path: "snippets/header.liquid", content: "<p>header</p>" } },
    ctx,
  );
  assert.deepEqual(result, [], "normal theme edits must return undefined (allowed) in unset mode");
});
