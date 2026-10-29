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
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(REPO, "src", "omp-hooks");

// The hook imports its siblings by extensionless relative specifier, which Node's
// ESM resolver rejects. Copy the whole unit into a temp tree as .mts with the
// specifiers rewritten - same trick as anti-direct-policy.test.mjs, extended to a
// multi-file module.
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "edit-guard-"));
for (const name of ["edit-mode", "theme-paths", "edit-guard-policy", "theme-push-policy", "theme-draft-probe", "edit-guard"]) {
  const source = fs.readFileSync(path.join(SRC, `${name}.ts`), "utf8").replace(
    /from "\.\/(edit-mode|theme-paths|edit-guard-policy|theme-push-policy|theme-draft-probe)"/g,
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
  assert.ok(failClosed.reason.includes("ask the user to re-send the request in Core mode"), "the refusal names the action an agent can take");
  assert.ok(failClosed.reason.includes("Core-Context"), "the Core tag is still named for the user");
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

const { HRV_COMMAND_ENV } = await load("theme-draft-probe");
const HRV_AT_LOAD = process.env[HRV_COMMAND_ENV];
after(() => {
  if (HRV_AT_LOAD === undefined) delete process.env[HRV_COMMAND_ENV];
  else process.env[HRV_COMMAND_ENV] = HRV_AT_LOAD;
});

/**
 * A stand-in `hrv` that records its argv and prints the CLI's real success or
 * failure line. The real CLI exits 0 either way, so the stub does too.
 */
function installHrvStub({ succeed, fetchedContent } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrv-stub-"));
  const calls = path.join(dir, "calls.jsonl");
  const script = path.join(dir, "hrv.mjs");
  const line = succeed ? "✓ Tải về thành công 1 file." : "Fetch thất bại: Không tìm thấy file trên remote.";
  const writeStep =
    typeof fetchedContent === "string"
      ? [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import * as path from "node:path";',
          'mkdirSync(path.join(process.cwd(), "config"), { recursive: true });',
          `writeFileSync(path.join(process.cwd(), "config", "settings_data.json"), ${JSON.stringify(fetchedContent)}, "utf8");`,
        ]
      : [];
  fs.writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      ...writeStep,
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
      `console.log(${JSON.stringify(line)});`,
    ].join("\n"),
  );
  process.env[HRV_COMMAND_ENV] = `"${process.execPath}" "${script}"`;
  const recorded = () =>
    fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").trim().split("\n").map((row) => JSON.parse(row))
      : [];
  return { dir, recorded };
}

function bindShop(root) {
  fs.writeFileSync(
    path.join(root, ".haravan-cli_local.json"),
    JSON.stringify({ org_id: "200001", theme_id: "1001507144", theme_name: "Stub", theme_org_id: "200001" }),
  );
}

const SETTINGS_WRITE = { toolName: "write", input: { path: "config/settings_data.json", content: "{}" } };
const SETTINGS_READ = { toolName: "read", input: { path: "config/settings_data.json" } };

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

test("settings_data.json write is blocked with REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP when pre-write fetch changes disk bytes, refuses retry without read, then passes after read", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const settingsPath = path.join(root, "config", "settings_data.json");
  const initialLocal = '{"current":{"color":"#000000"}}';
  fs.writeFileSync(settingsPath, initialLocal, "utf8");
  const merchantFetched = '{"current":{"color":"#ffffff","merchant_banner":true}}';
  const stub = installHrvStub({ succeed: true, fetchedContent: merchantFetched });
  try {
    const hook = makeHook();
    editGuardHook(hook.pi);
    const ctx = hook.context(root, "sess-settings-changed-on-shop");
    await hook.emit("session_start", {}, ctx);
    await hook.emit("before_agent_start", { prompt: "[⚡Direct-Edit] update config" }, ctx);

    const first = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.equal(first.length, 1, "first write must be blocked when fetch modified settings_data.json");
    assert.equal(first[0].block, true);
    assert.ok(first[0].reason.startsWith("REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP:"));
    assert.ok(first[0].reason.includes("org=200001 theme=1001507144"));
    assert.equal(fs.readFileSync(settingsPath, "utf8"), merchantFetched, "fetched merchant bytes remain on disk");

    const retryWithoutRead = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.equal(retryWithoutRead.length, 1, "retry without reading settings_data.json must be refused");
    assert.equal(retryWithoutRead[0].block, true);
    assert.ok(retryWithoutRead[0].reason.startsWith("REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP:"));
    assert.equal(stub.recorded().length, 1, "retry refusal does not run a second fetch");

    // Reading an unrelated file does not satisfy the re-read requirement.
    await hook.emit("tool_call", { toolName: "read", input: { path: "snippets/header.liquid" } }, ctx);
    const retryAfterOtherRead = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.equal(retryAfterOtherRead.length, 1, "reading an unrelated file must not clear the settings_data re-read gate");
    assert.equal(retryAfterOtherRead[0].block, true);

    // Reading config/settings_data.json clears the flag and allows the next write.
    assert.deepEqual(await hook.emit("tool_call", SETTINGS_READ, ctx), []);
    const afterRead = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.deepEqual(afterRead, [], "write passes after re-reading config/settings_data.json");
    assert.equal(stub.recorded().length, 1, "only one fetch ran across the run");

    const rows = readLog(root, "sess-settings-changed-on-shop");
    assert.deepEqual(
      rows.map((row) => `${row.tool}:${row.decision}:${row.code}`),
      [
        "hrv theme fetch:allow:SETTINGS_DATA_FETCHED",
        "write:block:REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP",
        "write:block:REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP",
        "write:block:REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP",
        "write:allow:ALLOWED",
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("settings_data.json pre-write fetch backs up pre-fetch bytes under .antifan/edit-guard and names the backup path in the refusal reason", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const settingsPath = path.join(root, "config", "settings_data.json");
  const unpushedLocalBytes = '{"current":{"color":"#123456","unpushed_local":true}}\n';
  fs.writeFileSync(settingsPath, unpushedLocalBytes, "utf8");
  const shopRemoteBytes = '{"current":{"color":"#ffffff","shop_saved":true}}\n';
  const stub = installHrvStub({ succeed: true, fetchedContent: shopRemoteBytes });
  try {
    const hook = makeHook();
    editGuardHook(hook.pi);
    const ctx = hook.context(root, "sess-settings-backup");
    await hook.emit("session_start", {}, ctx);
    await hook.emit("before_agent_start", { prompt: "[⚡Direct-Edit] update config" }, ctx);

    const refused = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].block, true);

    const guardDir = path.join(root, ".antifan", "edit-guard");
    const backups = fs.readdirSync(guardDir).filter((name) => name.startsWith("settings_data.") && name.endsWith(".bak.json"));
    assert.equal(backups.length, 1, "exactly one timestamped backup file is created when disk changed");
    const backupPath = path.join(guardDir, backups[0]);
    assert.ok(refused[0].reason.includes(backupPath), "refusal reason names the backup file path");
    assert.equal(fs.readFileSync(backupPath, "utf8"), unpushedLocalBytes, "backup preserves the exact pre-fetch local bytes");

    // Re-reading with an OMP line-range selector also clears the re-read flag.
    assert.deepEqual(
      await hook.emit("tool_call", { toolName: "read", input: { path: "config/settings_data.json:1-50" } }, ctx),
      [],
    );
    assert.deepEqual(await hook.emit("tool_call", SETTINGS_WRITE, ctx), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("settings_data.json write is not refused when pre-write fetch only changes BOM, CRLF line endings or JSON formatting", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const settingsPath = path.join(root, "config", "settings_data.json");
  const prettyCrlfBom = '\uFEFF{\r\n  "current": {\r\n    "color": "#000000",\r\n    "items": [\r\n      1,\r\n      2\r\n    ]\r\n  }\r\n}\r\n';
  fs.writeFileSync(settingsPath, prettyCrlfBom, "utf8");
  const compactLf = '{"current":{"color":"#000000","items":[1,2]}}\n';
  const stub = installHrvStub({ succeed: true, fetchedContent: compactLf });
  try {
    const hook = makeHook();
    editGuardHook(hook.pi);
    const ctx = hook.context(root, "sess-settings-crlf-format");
    await hook.emit("session_start", {}, ctx);
    await hook.emit("before_agent_start", { prompt: "[⚡Direct-Edit] update config" }, ctx);

    const result = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.deepEqual(result, [], "formatting, BOM and CRLF-only differences must not block the write");
    assert.equal(stub.recorded().length, 1);

    const guardDir = path.join(root, ".antifan", "edit-guard");
    const backups = fs.readdirSync(guardDir).filter((name) => name.endsWith(".bak.json"));
    assert.deepEqual(backups, [], "no backup file is written when normalized content did not change");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("settings_data.json write is blocked with REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP when file was absent locally and created by pre-write fetch", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const settingsPath = path.join(root, "config", "settings_data.json");
  assert.equal(fs.existsSync(settingsPath), false, "file is initially absent before fetch");
  const fetchedJson = '{"current":{"newly_created":true}}';
  const stub = installHrvStub({ succeed: true, fetchedContent: fetchedJson });
  try {
    const hook = makeHook();
    editGuardHook(hook.pi);
    const ctx = hook.context(root, "sess-settings-created-on-fetch");
    await hook.emit("session_start", {}, ctx);
    await hook.emit("before_agent_start", { prompt: "no tag here" }, ctx);

    const first = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.equal(first.length, 1, "blind write must be blocked when fetch created settings_data.json");
    assert.equal(first[0].block, true);
    assert.ok(first[0].reason.includes("REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP"));
    assert.equal(fs.readFileSync(settingsPath, "utf8"), fetchedJson);

    const retryWithoutRead = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.equal(retryWithoutRead.length, 1, "write remains blocked until the newly fetched file is read");
    assert.equal(retryWithoutRead[0].block, true);

    assert.deepEqual(await hook.emit("tool_call", SETTINGS_READ, ctx), []);
    const second = await hook.emit("tool_call", SETTINGS_WRITE, ctx);
    assert.deepEqual(second, [], "write in the same run passes after reading the fetched file");
    assert.equal(stub.recorded().length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("hook allows normal edits like snippets/header.liquid in mode === 'unset'", async () => {
  const root = makeThemeWorkspace();
  try {
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Leader worker: remote theme commands
// ---------------------------------------------------------------------------

/** A stand-in `hrv` answering `theme info -j` for `themeId` with `role` (null = CLI error text). */
function installInfoStub({ themeId = "1001507144", role }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrv-info-stub-"));
  const calls = path.join(dir, "calls.jsonl");
  const script = path.join(dir, "hrv.mjs");
  const body =
    role === null
      ? "Lỗi: refresh_token đã bị từ chối (invalid_grant)"
      : `- Đang lấy thông tin theme...\n${JSON.stringify({ theme_id: Number(themeId), name: "Stub", role, org_id: "200001" }, null, 2)}`;
  fs.writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
      `console.log(${JSON.stringify(body)});`,
    ].join("\n"),
  );
  process.env[HRV_COMMAND_ENV] = `"${process.execPath}" "${script}"`;
  const recorded = () =>
    fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").trim().split("\n").map((row) => JSON.parse(row))
      : [];
  return { dir, recorded };
}

/**
 * Runs `fn` as terminal `terminal-w` with a Leader config dir that `prepare(configDir)` fills
 * (or leaves empty): the registry file is whatever the case needs.
 */
async function asTerminalWithConfig(prepare, fn) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "leader-cfg-"));
  prepare(configDir);
  const previous = {
    id: process.env.ANTIFAN_TERMINAL_SESSION_ID,
    config: process.env.ANTIFAN_CONFIG_DIR,
  };
  process.env.ANTIFAN_TERMINAL_SESSION_ID = "terminal-w";
  process.env.ANTIFAN_CONFIG_DIR = configDir;
  try {
    return await fn();
  } finally {
    for (const [key, value] of [
      ["ANTIFAN_TERMINAL_SESSION_ID", previous.id],
      ["ANTIFAN_CONFIG_DIR", previous.config],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

/** Runs `fn` as terminal `terminal-w` whose Leader registry entry is `worker` (true = a Leader's worker). */
function asTerminal(worker, fn) {
  return asTerminalWithConfig((configDir) => {
    fs.writeFileSync(
      path.join(configDir, "leader-terminals.json"),
      JSON.stringify({
        schema: 1,
        leaders: ["terminal-lead"],
        workers: worker ? { "terminal-w": { leaderId: "terminal-lead", assignedAt: 1 } } : {},
      }),
    );
  }, fn);
}

async function runTool(root, sessionId, toolName, input) {
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, sessionId);
  await hook.emit("session_start", {}, ctx);
  await hook.emit("before_agent_start", { prompt: "làm việc Leader giao" }, ctx);
  const results = await hook.emit("tool_call", { toolName, input }, ctx);
  return results[0] ?? null;
}

function runBash(root, sessionId, command, extra = {}) {
  return runTool(root, sessionId, "bash", { command, ...extra });
}

for (const [label, role, expectedCode] of [
  ["a draft theme", "unpublished", null],
  ["the live theme", "main", "REFUSED_THEME_PUSH_LIVE"],
  ["an unreadable theme info", null, "REFUSED_THEME_PUSH_UNVERIFIED"],
]) {
  test(`a worker's scoped hrv theme push against ${label} is decided by hrv theme info`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role });
    try {
      await asTerminal(true, async () => {
        const result = await runBash(root, `sess-push-${role}`, "hrv theme push --only sections/hero.liquid");
        const calls = stub.recorded();
        assert.equal(calls.length, 1, "exactly one theme info probe");
        assert.deepEqual(calls[0].argv, ["theme", "info", "-j"]);
        assert.equal(path.resolve(calls[0].cwd).toLowerCase(), path.resolve(root).toLowerCase());
        if (expectedCode === null) {
          assert.equal(result, null, "a verified draft sync passes");
          assert.deepEqual(
            readLog(root, `sess-push-${role}`).map((row) => `${row.decision}:${row.code}:${row.path}`),
            ["allow:THEME_SYNC_DRAFT_VERIFIED:"],
            "the pass is audited without counting as a changed file",
          );
        } else {
          assert.equal(result?.block, true);
          assert.ok(result.reason.startsWith(`${expectedCode}:`), result.reason);
          assert.equal(readLog(root, `sess-push-${role}`).at(-1).code, expectedCode);
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

for (const [label, command, extra, expectedCode] of [
  ["a whole-theme push", "hrv theme push", {}, "REFUSED_THEME_PUSH_SCOPE"],
  ["a forced push", "hrv theme push -f --only a.liquid", {}, "REFUSED_THEME_PUSH_SCOPE"],
  ["a push with an inline --force value", "hrv theme push --only a.liquid --force=1", {}, "REFUSED_THEME_PUSH_SCOPE"],
  ["a publish", "hrv theme publish 1001507144", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Shopify push", "shopify theme push --only sections/a.liquid", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a push to another theme id", "hrv theme push 999 --only a.liquid", {}, "REFUSED_THEME_PUSH_FOREIGN_THEME"],
  ["a push after cd", "cd ../other && hrv theme push --only a.liquid", {}, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["a push from an unbound folder", "hrv theme dev", { cwd: os.tmpdir() }, "REFUSED_THEME_PUSH_UNVERIFIED"],
]) {
  test(`a worker's ${label} is refused without touching the shop`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role: "unpublished" });
    try {
      await asTerminal(true, async () => {
        const result = await runBash(root, `sess-refuse-${label.replace(/\W+/g, "-")}`, command, extra);
        assert.equal(result?.block, true, `${command} must be refused`);
        assert.ok(result.reason.startsWith(`${expectedCode}:`), result.reason);
        assert.equal(stub.recorded().length, 0, "no hrv call reaches the CLI");
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

test("theme reads in a worker and every theme command outside a worker pass without a probe", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const stub = installInfoStub({ role: "main" });
  try {
    await asTerminal(true, async () => {
      assert.equal(await runBash(root, "sess-read", "hrv theme info -j && hrv theme fetch --only config/settings_data.json"), null);
    });
    await asTerminal(false, async () => {
      assert.equal(await runBash(root, "sess-user", "hrv theme push"), null, "the user's own sessions are not gated");
    });
    assert.equal(stub.recorded().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("a worker's eval cell that runs the theme CLI is refused; other eval cells and non-workers pass", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const stub = installInfoStub({ role: "unpublished" });
  try {
    await asTerminal(true, async () => {
      for (const [language, code] of [
        ["py", 'import subprocess\nsubprocess.run(["hrv", "theme", "push"], cwd=r"E:/other")'],
        ["py", "import os\nos.chdir('E:/other')\nos.system('hrv theme push --only a.liquid')"],
        ["py", "!shopify theme publish 123"],
        ["js", "await Bun.$`C:/x/hrv.cmd theme info -j`"],
        ["js", "require('child_process').execSync('haravan\\n theme push')"],
      ]) {
        const result = await runTool(root, `sess-eval-${language}-${code.length}`, "eval", { language, code });
        assert.equal(result?.block, true, `${code} must be refused`);
        assert.ok(result.reason.startsWith("REFUSED_THEME_VIA_EVAL:"), result.reason);
      }
      for (const code of [
        "import json\nprint(json.load(open('.haravan-cli_local.json'))['theme_id'])",
        "print(open('E:/Work/scratch/hrv-stub/calls.log').read())",
        "fetch('https://admin.shopify.com/store/x/themes')",
      ]) {
        assert.equal(await runTool(root, `sess-eval-ok-${code.length}`, "eval", { language: "py", code }), null, code);
      }
    });
    await asTerminal(false, async () => {
      const code = 'import subprocess\nsubprocess.run(["hrv", "theme", "push"])';
      assert.equal(await runTool(root, "sess-eval-user", "eval", { language: "py", code }), null, "the user's own sessions are not gated");
    });
    assert.equal(stub.recorded().length, 0, "no hrv call reaches the CLI");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Leader worker: lines whose theme-CLI use cannot be read back
// ---------------------------------------------------------------------------

for (const [label, command] of [
  ["a parenthesised group", "(hrv theme push --only a.liquid)"],
  ["a command substitution", "echo $(hrv theme publish 1)"],
  ["bash -c", 'bash -c "cd x && hrv theme push --only a.liquid"'],
  ["cmd /c", "cmd /c hrv theme push --only a.liquid"],
  ["powershell -c", 'powershell -c "Push-Location x; hrv theme push --only a.liquid"'],
  ["a powershell call of a quoted path", 'powershell -Command "& C:\\tools\\hrv.cmd theme push"'],
  ["python -c", `python -c "subprocess.run(['hrv','theme','push'])"`],
  ["node -e", `node -e "spawnSync('hrv', ['theme', 'publish', '1'])"`],
  ["a global option before theme", "hrv --org 123 theme push --only a.liquid"],
  ["a backslash-newline continuation", "hrv \\\ntheme push --only a.liquid"],
  ["npx on the package name", "npx @f1genz/haravan-cli theme push --only a.liquid"],
  ["a quote-split CLI word", 'h""rv theme push --only a.liquid'],
  ["a write to the binding file", 'echo {"theme_id":"999"} > .haravan-cli_local.json && hrv theme push --only a.liquid'],
  ["a mention inside another command's text", 'git commit -m "fix hrv theme header"'],
]) {
  test(`a worker's ${label} is refused as REFUSED_THEME_COMPLEX before anything reaches the shop`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role: "unpublished" });
    const sessionId = `sess-complex-${label.replace(/\W+/g, "-")}`;
    try {
      await asTerminal(true, async () => {
        const result = await runBash(root, sessionId, command);
        assert.equal(result?.block, true, `${command} must be refused`);
        assert.ok(result.reason.startsWith("REFUSED_THEME_COMPLEX:"), result.reason);
        assert.equal(stub.recorded().length, 0, "no hrv call reaches the CLI");
        const row = readLog(root, sessionId).at(-1);
        assert.deepEqual(
          [row.decision, row.code, row.tool, row.path],
          ["block", "REFUSED_THEME_COMPLEX", "bash", command.trim().slice(0, 200)],
        );
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

test("plain theme commands a worker may run, and lines that only look close, are not refused as complex", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const stub = installInfoStub({ role: "unpublished" });
  try {
    await asTerminal(true, async () => {
      // `hrv` is also in the file name: a mention counter would refuse this.
      assert.equal(await runBash(root, "sess-plain-push", "hrv theme push --only sections/hrv.liquid"), null);
      assert.equal(stub.recorded().length, 1, "one theme info probe for the push");
      assert.equal(await runBash(root, "sess-plain-info", "hrv theme info"), null);
      assert.equal(await runBash(root, "sess-plain-dev", "hrv theme dev"), null);
      assert.equal(stub.recorded().length, 2, "dev is probed, info is a read");
      for (const command of ["git commit -F msg.txt", "ls", "rg hrv sections", "cat sections/hrv.liquid theme.json"]) {
        assert.equal(await runBash(root, `sess-plain-${command.length}`, command), null, command);
      }
      assert.equal(await runBash(root, "sess-plain-cd-info", "cd x && hrv theme info"), null, "a read after cd is still readable");
      assert.equal(stub.recorded().length, 2, "none of those reached the CLI");
      const afterCd = await runBash(root, "sess-plain-cd-push", "cd x && hrv theme push --only a.liquid");
      assert.ok(afterCd?.reason.startsWith("REFUSED_THEME_PUSH_UNVERIFIED:"), afterCd?.reason);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("a worker's eval cell naming haravan-cli or a quote-split CLI word is refused", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const stub = installInfoStub({ role: "unpublished" });
  try {
    await asTerminal(true, async () => {
      for (const [language, code] of [
        ["js", "await Bun.$`haravan-cli theme push --only a.liquid`"],
        ["py", "import os\nos.system('h\"\"rv theme push --only a.liquid')"],
        ["js", "await Bun.$`npx @f1genz/haravan-cli theme push --only a.liquid`"],
      ]) {
        const result = await runTool(root, `sess-eval-wide-${code.length}`, "eval", { language, code });
        assert.ok(result?.reason.startsWith("REFUSED_THEME_VIA_EVAL:"), `${code}: ${result?.reason}`);
      }
    });
    assert.equal(stub.recorded().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("audit rows name the bash tool; a verified sync carries no path, a refusal carries the capped command", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const stub = installInfoStub({ role: "unpublished" });
  try {
    await asTerminal(true, async () => {
      assert.equal(await runBash(root, "sess-audit-allow", "hrv theme push --only sections/hero.liquid"), null);
      const allow = readLog(root, "sess-audit-allow").at(-1);
      assert.deepEqual(
        [allow.decision, allow.code, allow.tool, allow.path],
        ["allow", "THEME_SYNC_DRAFT_VERIFIED", "bash", ""],
        "an empty path keeps the verified sync out of the changed-file count",
      );
      const long = `hrv theme publish 1 ${"x".repeat(400)}`;
      assert.equal((await runBash(root, "sess-audit-block", long))?.block, true);
      const block = readLog(root, "sess-audit-block").at(-1);
      assert.deepEqual([block.decision, block.code, block.tool], ["block", "REFUSED_THEME_REMOTE_OP", "bash"]);
      assert.equal(block.path.length, 200);
      assert.ok(block.path.startsWith("hrv theme publish 1 xxx"));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Leader worker: how the registry is read
// ---------------------------------------------------------------------------

for (const [label, prepare] of [
  ["no registry file", () => {}],
  ["a directory in place of the registry", (dir) => fs.mkdirSync(path.join(dir, "leader-terminals.json"))],
  ["a corrupt registry", (dir) => fs.writeFileSync(path.join(dir, "leader-terminals.json"), "{not json")],
]) {
  test(`${label} names no worker, so the user's own theme commands are not gated`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role: "main" });
    try {
      await asTerminalWithConfig(prepare, async () => {
        assert.equal(await runBash(root, `sess-registry-${label.replace(/\W+/g, "-")}`, "hrv theme publish 1"), null);
      });
      assert.equal(stub.recorded().length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

const nodeFs = createRequire(import.meta.url)("node:fs");

/** Makes the first `failures` reads of the registry throw `code`, as a Windows lock during the Manager's rename does. */
function failRegistryReads(failures, code) {
  const original = nodeFs.readFileSync;
  const state = { attempts: 0 };
  nodeFs.readFileSync = function patched(file, ...rest) {
    if (typeof file === "string" && path.basename(file) === "leader-terminals.json") {
      state.attempts += 1;
      if (state.attempts <= failures) throw Object.assign(new Error(`${code}: simulated`), { code });
    }
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  return {
    state,
    restore() {
      nodeFs.readFileSync = original;
      syncBuiltinESMExports();
    },
  };
}

for (const code of ["EBUSY", "EPERM", "EACCES", "EMFILE"]) {
  test(`a registry that stays locked (${code}) after two retries is treated as a worker`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role: "unpublished" });
    try {
      await asTerminal(false, async () => {
        const lock = failRegistryReads(Infinity, code);
        try {
          const result = await runBash(root, `sess-locked-${code}`, "hrv theme publish 1");
          assert.ok(result?.reason.startsWith("REFUSED_THEME_REMOTE_OP:"), result?.reason);
          assert.equal(lock.state.attempts, 3, "one read and two retries");
        } finally {
          lock.restore();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

test("a registry lock that clears within the retries is decided by the file; other read errors are not retried", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const stub = installInfoStub({ role: "unpublished" });
  try {
    await asTerminal(false, async () => {
      const lock = failRegistryReads(1, "EBUSY");
      try {
        assert.equal(await runBash(root, "sess-lock-clears", "hrv theme publish 1"), null, "the file says this is no worker");
        assert.equal(lock.state.attempts, 2);
      } finally {
        lock.restore();
      }
      const broken = failRegistryReads(Infinity, "EIO");
      try {
        assert.equal(await runBash(root, "sess-lock-eio", "hrv theme publish 1"), null, "EIO is not a lock error");
        assert.equal(broken.state.attempts, 1);
      } finally {
        broken.restore();
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A call the guard cannot read, in an AntiFan terminal
// ---------------------------------------------------------------------------

test("a call the guard cannot read is refused for a Leader worker that names the theme CLI, and only for a worker", async () => {
  const root = makeThemeWorkspace();
  const unreadableContext = {
    cwd: root,
    sessionManager: {
      getSessionId: () => {
        throw new Error("identity read failed");
      },
      getBranch: () => [],
    },
  };
  const unscopedHook = async (sessionId) => {
    const hook = makeHook();
    editGuardHook(hook.pi);
    const ctx = hook.context(root, sessionId);
    await hook.emit("session_start", {}, ctx);
    await hook.emit("before_agent_start", { prompt: "no tag here" }, ctx);
    return { hook, ctx };
  };
  const hostileInput = {
    toolName: "bash",
    input: {
      get command() {
        throw new Error("input unreadable");
      },
    },
  };
  const emitNamed = async (sessionId) =>
    (await unscopedHook(sessionId)).hook.emit(
      "tool_call",
      { toolName: "bash", input: { command: "hrv theme publish 1" } },
      unreadableContext,
    );
  try {
    await asTerminal(true, async () => {
      const { hook, ctx } = await unscopedHook("sess-unreadable-input");
      const hostile = await hook.emit("tool_call", hostileInput, ctx);
      assert.equal(hostile.length, 1, "an unreadable bash call in a worker is not cleared");
      assert.ok(hostile[0].reason.startsWith("REFUSED_GUARD_ERROR:"), hostile[0].reason);
      assert.ok(hostile[0].reason.includes("Leader worker"), hostile[0].reason);
      const row = readLog(root, "sess-unreadable-input").at(-1);
      assert.deepEqual([row.decision, row.code, row.tool], ["block", "REFUSED_GUARD_ERROR", "bash"]);

      const named = await emitNamed("sess-unreadable-ctx");
      assert.equal(named.length, 1, "a readable theme command on an unreadable session is refused");
      assert.ok(named[0].reason.startsWith("REFUSED_GUARD_ERROR:"), named[0].reason);

      const unrelated = await unscopedHook("sess-unreadable-ls").then(({ hook: h }) =>
        h.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, unreadableContext),
      );
      assert.deepEqual(unrelated, [], "a call that names no theme CLI is not caught by this rule");
    });

    // A terminal that is not a worker's (the user's own OMP, or a Leader) is never held to it.
    await asTerminal(false, async () => {
      const { hook, ctx } = await unscopedHook("sess-unreadable-user");
      assert.deepEqual(await hook.emit("tool_call", hostileInput, ctx), []);
      assert.deepEqual(await emitNamed("sess-unreadable-user-ctx"), []);
    });

    // Outside an AntiFan terminal there is nothing to enforce.
    const ambientTerminal = process.env.ANTIFAN_TERMINAL_SESSION_ID;
    delete process.env.ANTIFAN_TERMINAL_SESSION_ID;
    try {
      assert.deepEqual(await emitNamed("sess-unreadable-no-terminal"), []);
      const { hook: outsideHook, ctx: outsideCtx } = await unscopedHook("sess-unreadable-input-no-terminal");
      assert.deepEqual(await outsideHook.emit("tool_call", hostileInput, outsideCtx), []);
    } finally {
      if (ambientTerminal !== undefined) process.env.ANTIFAN_TERMINAL_SESSION_ID = ambientTerminal;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Wider classification: paths are not mentions, shop writes and indirection are
// ---------------------------------------------------------------------------

for (const command of [
  "rg -n haravan layout/theme.liquid",
  "Get-Content E:\\Work\\customizes\\Shopify\\Rebel\\layout\\theme.liquid",
  "ls shopify/theme",
  "grep -rn shopify theme/",
  "cat layout/theme.liquid sections/hrv.liquid",
  "hrv api get /web/themes.json",
]) {
  test(`a worker's benign line is passed untouched: ${command}`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role: "main" });
    try {
      await asTerminal(true, async () => {
        assert.equal(await runBash(root, `sess-benign-${command.length}`, command), null, command);
        for (const language of ["py", "js"]) {
          assert.equal(await runTool(root, `sess-benign-eval-${language}-${command.length}`, "eval", { language, code: command }), null);
        }
      });
      assert.equal(stub.recorded().length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

for (const [label, command, expectedCode] of [
  ["publishing through the raw API", `hrv api put /web/themes/1001507144.json --data '{"role":"main"}'`, "REFUSED_THEME_REMOTE_OP"],
  ["deleting a theme through the raw API", "hrv api delete /web/themes/1001507144.json --yes", "REFUSED_THEME_REMOTE_OP"],
  ["a raw API post with a leading option", "hrv --json api POST /web/themes.json --set name=x", "REFUSED_THEME_REMOTE_OP"],
  ["a raw API write by a quote-split CLI word", 'h""rv api put /web/themes/1.json --data @x.json', "REFUSED_THEME_REMOTE_OP"],
  ["a path-qualified raw API write", "C:\\tools\\hrv.cmd api patch /web/themes/1.json --data @x.json", "REFUSED_THEME_REMOTE_OP"],
  ["rollback-last-push", "hrv rollback-last-push -y", "REFUSED_THEME_REMOTE_OP"],
  ["an alias for the CLI", "Set-Alias h hrv", "REFUSED_THEME_COMPLEX"],
  ["a shell alias for the CLI", "alias h=haravan", "REFUSED_THEME_COMPLEX"],
  ["a variable holding the CLI", "$h = 'hrv'", "REFUSED_THEME_COMPLEX"],
  ["a cmd variable holding the CLI", "set H=hrv.cmd", "REFUSED_THEME_COMPLEX"],
  ["a function wrapping the CLI", "function h { hrv @args }", "REFUSED_THEME_COMPLEX"],
  ["the CLI with a variable as its next word", "hrv $c publish 1001507144", "REFUSED_THEME_COMPLEX"],
  ["the CLI with an expansion as its next word", "hrv %c% publish 1001507144", "REFUSED_THEME_COMPLEX"],
  ["a bundled short force flag", "hrv theme push -nf --only a.liquid", "REFUSED_THEME_PUSH_SCOPE"],
]) {
  test(`a worker's ${label} is refused (${expectedCode}) before anything reaches the shop`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role: "unpublished" });
    try {
      await asTerminal(true, async () => {
        const result = await runBash(root, `sess-wide-${label.replace(/\W+/g, "-")}`, command);
        assert.equal(result?.block, true, `${command} must be refused`);
        assert.ok(result.reason.startsWith(`${expectedCode}:`), result.reason);
        assert.equal(stub.recorded().length, 0, "no hrv call reaches the CLI");
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

test("a worker's eval cell that writes through the raw API or aliases the CLI is refused; the user's is not", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  try {
    await asTerminal(true, async () => {
      for (const [language, code] of [
        ["js", "await Bun.$`hrv api put /web/themes/1.json --data @x.json`"],
        ["py", "import os\nos.system('hrv rollback-last-push -y')"],
        ["py", "cli = 'hrv'\nimport subprocess\nsubprocess.run([cli, 'x'])"],
      ]) {
        const result = await runTool(root, `sess-eval-api-${code.length}`, "eval", { language, code });
        assert.ok(result?.reason.startsWith("REFUSED_THEME_VIA_EVAL:"), `${code}: ${result?.reason}`);
      }
    });
    await asTerminal(false, async () => {
      assert.equal(await runTool(root, "sess-eval-api-user", "eval", { language: "js", code: "await Bun.$`hrv api put /x.json`" }), null);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a theme probe that times out is stopped together with the process it started", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrv-slow-"));
  const pidFile = path.join(dir, "pid.txt");
  const script = path.join(dir, "slow.mjs");
  fs.writeFileSync(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  process.env[HRV_COMMAND_ENV] = `"${process.execPath}" "${script}"`;
  let pid = 0;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const run = await draftProbe.runHrv(os.tmpdir(), "theme info -j", 4_000);
    assert.equal(run.output, null);
    assert.match(run.failure, /timed out/);
    assert.ok(fs.existsSync(pidFile), "the probe's CLI had started before the timeout");
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    for (let waited = 0; alive() && waited < 5_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(alive(), false, "the CLI process behind the shell is gone, not left running");
  } finally {
    if (pid > 0 && alive()) process.kill(pid, "SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// ---------------------------------------------------------------------------
// theme-push-policy and theme-draft-probe, as the Manager consumes them
// ---------------------------------------------------------------------------

const themePolicy = await load("theme-push-policy");
const draftProbe = await load("theme-draft-probe");

test("startsDirChange sees every way a line moves the shell, and nothing else", () => {
  for (const line of [
    "cd x", "ls && cd ..", "pushd x", "popd", "Push-Location x", "Pop-Location", "Set-Location x", "cd..", "D:", "hrv theme info; sl x",
    "if ($x) { cd ..\\Other }", "& { Set-Location .. }", "try { cd x } catch {}", "iex 'cd ..'", ". .\\go.ps1", ".\\go.ps1",
    "for d in a b; do cd $d; done", "source env.sh", "setup.bat",
  ]) {
    assert.equal(themePolicy.startsDirChange(line), true, line);
  }
  for (const line of ["hrv theme info", "ls -la", "git commit -F msg.txt", "hrv theme push --only sections/hrv.liquid", ""]) {
    assert.equal(themePolicy.startsDirChange(line), false, line);
  }
});

test("classifyThemeLine: no mention is none, a plain command is read, assumeDirChanged marks every command", () => {
  assert.deepEqual(themePolicy.classifyThemeLine("ls"), { decision: "none" });
  const plain = themePolicy.classifyThemeLine("hrv theme push --only a.liquid");
  assert.equal(plain.decision, "commands");
  assert.equal(plain.commands[0].dirChanged, false);
  const moved = themePolicy.classifyThemeLine("hrv theme push --only a.liquid", { assumeDirChanged: true });
  assert.equal(moved.commands[0].dirChanged, true);
  assert.equal(themePolicy.classifyThemeLine("npx @f1genz/haravan-cli theme push").code, "REFUSED_THEME_COMPLEX");
  assert.equal(themePolicy.mentionsThemeCli('h""rv theme push'), true);
  assert.equal(themePolicy.mentionsThemeCli("cat sections/hrv.liquid theme.json"), false);
});

test("gateThemeLine decides one line: pass, probed allow, live refusal, unverifiable refusal", async () => {
  const root = makeThemeWorkspace();
  bindShop(root);
  const draft = installInfoStub({ role: "unpublished" });
  try {
    assert.deepEqual(await draftProbe.gateThemeLine({ text: "ls", cwd: root, timeoutMs: 20_000 }), { decision: "pass" });
    assert.deepEqual(
      await draftProbe.gateThemeLine({ text: "hrv theme info", cwd: root, timeoutMs: 20_000 }),
      { decision: "allow", verified: [] },
      "a read needs no probe",
    );
    assert.equal(draft.recorded().length, 0);
    assert.deepEqual(
      await draftProbe.gateThemeLine({ text: "hrv theme push --only a.liquid", cwd: path.join(root, "sections"), timeoutMs: 20_000 }),
      { decision: "allow", verified: ["hrv theme push --only a.liquid"] },
      "the binding is found from a sub-folder",
    );
    assert.equal(draft.recorded().length, 1);

    const moved = await draftProbe.gateThemeLine({
      text: "hrv theme push --only a.liquid",
      cwd: root,
      timeoutMs: 20_000,
      assumeDirChanged: true,
    });
    assert.equal(moved.code, "REFUSED_THEME_PUSH_UNVERIFIED");
    assert.equal(draft.recorded().length, 1, "no probe when the folder cannot be trusted");

    const tooSlow = await draftProbe.gateThemeLine({ text: "hrv theme dev", cwd: root, timeoutMs: 1 });
    assert.equal(tooSlow.code, "REFUSED_THEME_PUSH_UNVERIFIED", "a probe that cannot answer in time refuses");

    const live = installInfoStub({ role: "main" });
    const refused = await draftProbe.gateThemeLine({ text: "hrv theme push --only a.liquid", cwd: root, timeoutMs: 20_000 });
    assert.equal(refused.code, "REFUSED_THEME_PUSH_LIVE");
    assert.equal(refused.command, "hrv theme push --only a.liquid");
    fs.rmSync(live.dir, { recursive: true, force: true });
  } finally {
    // The probe the 1 ms budget cut off may still be exiting inside `root`, and Windows refuses to remove a folder a live process holds.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    fs.rmSync(draft.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
