// edit-guard.test.mjs - behavioral tests for the Direct/Super-Fast edit-mode guard
//
// Verifies the four units that make up the guard:
// 1. edit-mode.ts    - tag vocabulary, latch semantics, branch replay
// 2. theme-paths.ts  - workspace shape resolution and the writable set
// 3. edit-guard-policy.ts - tool-call refusals (mode tools, devices, write scope)
// 4. edit-guard.ts   - hook wiring: latch, audit log, mode mirror, fail-closed writes

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
for (const name of ["edit-mode", "theme-paths", "edit-guard-policy", "theme-push-policy", "theme-push-approval", "theme-draft-probe", "edit-guard"]) {
  const source = fs.readFileSync(path.join(SRC, `${name}.ts`), "utf8").replace(
    /from "\.\/(edit-mode|theme-paths|edit-guard-policy|theme-push-policy|theme-push-approval|theme-draft-probe)"/g,
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

/** Runs `fn` while `process.stderr.write` records what it is given instead of printing it. */
async function captureStderr(fn) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test("an unwritable audit log never blocks the call, and says so once", async () => {
  const root = makeThemeWorkspace();
  const logPath = path.join(root, ".antifan", "edit-guard", "sess-unwritable.jsonl");
  fs.mkdirSync(logPath, { recursive: true }); // a directory where the log file belongs
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-unwritable");
  await hook.emit("session_start", {}, ctx);
  await hook.emit("before_agent_start", { prompt: "[🚀Super-Fast] fix hero" }, ctx);
  const lines = await captureStderr(async () => {
    for (const file of ["sections/hero.liquid", "sections/footer.liquid"]) {
      const result = await hook.emit("tool_call", { toolName: "write", input: { path: file } }, ctx);
      assert.deepEqual(result, [], `${file} is still allowed`);
    }
  });
  const said = lines.filter((line) => line.includes("audit log write failed"));
  assert.equal(said.length, 1, `one report per session, got: ${JSON.stringify(lines)}`);
  assert.match(said[0], /^\[edit-guard\] audit log write failed \(\w+\): .*sess-unwritable\.jsonl\n$/);
});

test("the audit log rotates past the size limit and keeps every row after an external move", async () => {
  const root = makeThemeWorkspace();
  const logPath = path.join(root, ".antifan", "edit-guard", "sess-rotate.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${"x".repeat(2 * 1024 * 1024 + 16)}\n`);
  const hook = makeHook();
  editGuardHook(hook.pi);
  const ctx = hook.context(root, "sess-rotate");
  await hook.emit("session_start", {}, ctx);
  await hook.emit("before_agent_start", { prompt: "[🚀Super-Fast] fix hero" }, ctx);
  const write = (file) => hook.emit("tool_call", { toolName: "write", input: { path: file } }, ctx);
  await write("sections/hero.liquid");
  assert.ok(fs.existsSync(logPath.replace(/\.jsonl$/, ".1.jsonl")), "the oversized log was rotated");
  const rows = () => fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows().length, 1, "a fresh log holds the new row only");
  // Something else moves the live log away: the next row must still be written, not lost.
  fs.renameSync(logPath, `${logPath}.moved`);
  await write("sections/footer.liquid");
  assert.equal(rows().length, 1, "the row after an external move lands in a new log");
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

const { HRV_COMMAND_ENV, SHOPIFY_COMMAND_ENV } = await load("theme-draft-probe");
const HRV_AT_LOAD = process.env[HRV_COMMAND_ENV];
const SHOPIFY_AT_LOAD = process.env[SHOPIFY_COMMAND_ENV];
after(() => {
  if (HRV_AT_LOAD === undefined) delete process.env[HRV_COMMAND_ENV];
  else process.env[HRV_COMMAND_ENV] = HRV_AT_LOAD;
  if (SHOPIFY_AT_LOAD === undefined) delete process.env[SHOPIFY_COMMAND_ENV];
  else process.env[SHOPIFY_COMMAND_ENV] = SHOPIFY_AT_LOAD;
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
function installInfoStub({ themeId = "1001507144", role, exitCode = 0 }) {
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
      `process.exitCode = ${exitCode};`,
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
  ["the live theme", "main", null],
  ["an unreadable theme info", null, "REFUSED_THEME_PUSH_UNVERIFIED"],
]) {
  test(`a worker's scoped hrv theme push against ${label} is decided by hrv theme info`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role });
    try {
      await asTerminal(true, async () => {
        const result = await runBash(root, `sess-push-${role}`, "hrv theme push --only sections/hero.liquid --nodelete");
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
  ["a push without --nodelete", "hrv theme push --only a.liquid", {}, "REFUSED_THEME_PUSH_NODELETE"],
  ["a whole-theme push without --nodelete", "hrv theme push", {}, "REFUSED_THEME_PUSH_NODELETE"],
  ["a push whose -on is --only n, not -n", "hrv theme push -on a.liquid", {}, "REFUSED_THEME_PUSH_NODELETE"],
  ["a push with a value on --nodelete", "hrv theme push --only a.liquid --nodelete=false", {}, "REFUSED_THEME_PUSH_NODELETE"],
  ["a whole-theme push that does not exclude settings_data", "hrv theme push --nodelete", {}, "REFUSED_THEME_PUSH_SETTINGS_DATA"],
  ["a glob --only that reaches settings_data", "hrv theme push --only config/** --nodelete", {}, "REFUSED_THEME_PUSH_SETTINGS_DATA"],
  ["an --ignore of another file", "hrv theme push --nodelete --ignore sections/a.liquid", {}, "REFUSED_THEME_PUSH_SETTINGS_DATA"],
  ["a prune", "hrv theme push --prune --only a.liquid", {}, "REFUSED_THEME_PUSH_SCOPE"],
  ["a forced push", "hrv theme push -f --only a.liquid", {}, "REFUSED_THEME_PUSH_SCOPE"],
  ["a push with an inline --force value", "hrv theme push --only a.liquid --force=1", {}, "REFUSED_THEME_PUSH_SCOPE"],
  ["a publish", "hrv theme publish 1001507144", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Shopify push with no nodelete or target", "shopify theme push --only sections/a.liquid", {}, "REFUSED_THEME_PUSH_SCOPE"],
  ["a Shopify dev pointed at an existing theme", "shopify theme dev --theme 123", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Shopify dev with a short theme flag", "shopify theme dev -t live", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Shopify dev with an attached theme id", "shopify theme dev -t123", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Shopify dev with an inline short theme value", "shopify theme dev -t=123", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Shopify dev with an inline long theme value", "shopify theme dev --theme=123", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Shopify dev using a toml environment", "shopify theme dev -e production", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Shopify dev using a long environment flag", "shopify theme dev --environment production", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Sapo push with no --only", "sapo theme push", {}, "REFUSED_THEME_PUSH_SCOPE"],
  ["a Sapo dev watcher", "sapo theme dev", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Sapo publish", "sapo theme publish 1", {}, "REFUSED_THEME_REMOTE_OP"],
  ["a Sapo dev pointed at an existing theme", "sapo theme dev --theme 5", {}, "REFUSED_THEME_REMOTE_OP"],
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

for (const command of [
  "shopify theme dev",
  "shopify theme dev --store x.myshopify.com --theme-editor-sync",
  "sapo whoiam",
  "hrv theme push --help",
  "shopify theme dev -h",
]) {
  test(`a worker may run '${command}': it previews on a development theme and needs no probe`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role: "main" });
    try {
      await asTerminal(true, async () => {
        assert.equal(await runBash(root, `sess-shopify-dev-${command.length}`, command), null);
        assert.equal(stub.recorded().length, 0, "no hrv call is made for a Shopify dev preview");
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

/** A stand-in `shopify` answering `theme list --id .. --json` with `themes` (or the raw text `raw`), and exiting `exitCode`. */
function installShopifyStub({ themes, raw, exitCode = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shopify-stub-"));
  const calls = path.join(dir, "calls.jsonl");
  const script = path.join(dir, "shopify.mjs");
  const body = raw ?? `New version of Shopify CLI available\n${JSON.stringify(themes, null, 2)}`;
  fs.writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
      `console.log(${JSON.stringify(body)});`,
      `process.exitCode = ${exitCode};`,
    ].join("\n"),
  );
  process.env[SHOPIFY_COMMAND_ENV] = `"${process.execPath}" "${script}"`;
  const recorded = () =>
    fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").trim().split("\n").map((row) => JSON.parse(row))
      : [];
  return { dir, recorded };
}

const SHOPIFY_PUSH = "shopify theme push --theme 123456789 --store demo-shop --only sections/a.liquid --nodelete";
const DEMO = (role, id = 123456789) => ({ id, name: "Demo", role });

for (const [label, stubArgs, expectedCode] of [
  ["an unpublished theme", { themes: [DEMO("unpublished")] }, null],
  ["a development theme", { themes: [DEMO("development")] }, null],
  ["the live theme", { themes: [DEMO("live")] }, "REFUSED_THEME_PUSH_LIVE"],
  ["a theme the CLI calls main", { themes: [DEMO("main")] }, "REFUSED_THEME_PUSH_LIVE"],
  ["an unreadable list", { raw: "Error: not logged in to demo-shop" }, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["an unknown role", { themes: [DEMO("demo")] }, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["an empty list", { themes: [] }, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["a list without that id", { themes: [DEMO("unpublished", 5)] }, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["an ambiguous list", { themes: [DEMO("unpublished"), DEMO("live")] }, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["a failing CLI", { themes: [DEMO("unpublished")], exitCode: 1 }, "REFUSED_THEME_PUSH_UNVERIFIED"],
]) {
  test(`a worker's scoped shopify theme push to ${label} is decided by shopify theme list`, async () => {
    const root = makeThemeWorkspace();
    const stub = installShopifyStub(stubArgs);
    const sessionId = `sess-shopify-push-${label.replace(/\W+/g, "-")}`;
    try {
      await asTerminal(true, async () => {
        const result = await runBash(root, sessionId, SHOPIFY_PUSH);
        const calls = stub.recorded();
        assert.equal(calls.length, 1, "exactly one theme list probe");
        assert.deepEqual(calls[0].argv, ["theme", "list", "--id", "123456789", "--store", "demo-shop", "--json"]);
        assert.equal(path.resolve(calls[0].cwd).toLowerCase(), path.resolve(root).toLowerCase());
        if (expectedCode === null) {
          assert.equal(result, null, "a verified unpublished push passes");
          assert.deepEqual(
            readLog(root, sessionId).map((row) => `${row.decision}:${row.code}:${row.path}`),
            ["allow:THEME_SYNC_DRAFT_VERIFIED:"],
          );
        } else {
          assert.equal(result?.block, true);
          assert.ok(result.reason.startsWith(`${expectedCode}:`), result.reason);
          assert.equal(readLog(root, sessionId).at(-1).code, expectedCode);
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

for (const [command, store] of [
  ["shopify theme push -t 123456789 -s demo-shop -o sections/a.liquid templates/index.json -n", "demo-shop"],
  ["shopify theme push --theme=123456789 --store=demo-shop.myshopify.com --only=a.liquid --nodelete --json", "demo-shop.myshopify.com"],
  ["shopify theme push -t123456789 -sdemo-shop -oa.liquid -n", "demo-shop"],
  ["shopify theme push -t=123456789 -s=demo-shop -o=a.liquid -n -x config/settings_data.json --verbose --no-color", "demo-shop"],
  ["shopify theme push --only a.liquid --nodelete --store demo-shop --theme 123456789 --path .", "demo-shop"],
]) {
  test(`a worker's '${command}' is allowed after one probe naming the same theme and store`, async () => {
    const root = makeThemeWorkspace();
    const stub = installShopifyStub({ themes: [DEMO("unpublished")] });
    try {
      await asTerminal(true, async () => {
        assert.equal(await runBash(root, `sess-shopify-forms-${command.length}`, command), null);
        const calls = stub.recorded();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].argv, ["theme", "list", "--id", "123456789", "--store", store, "--json"]);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

for (const [label, command, expectedCode] of [
  ["no --store", "shopify theme push --theme 123456789 --only a.liquid --nodelete", "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["a store that is a URL", "shopify theme push --theme 123456789 --store https://demo-shop.myshopify.com --only a.liquid --nodelete", "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["no --only", "shopify theme push --theme 123456789 --store demo-shop --nodelete", "REFUSED_THEME_PUSH_SCOPE"],
  ["an --only without a file", "shopify theme push --theme 123456789 --store demo-shop --only --nodelete", "REFUSED_THEME_PUSH_SCOPE"],
  ["no --nodelete", "shopify theme push --theme 123456789 --store demo-shop --only a.liquid", "REFUSED_THEME_PUSH_SCOPE"],
  ["a theme named by its name", "shopify theme push --theme my-theme-name --store demo-shop --only a.liquid --nodelete", "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["a theme id with a leading zero", "shopify theme push --theme 0123 --store demo-shop --only a.liquid --nodelete", "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["no --theme", "shopify theme push --store demo-shop --only a.liquid --nodelete", "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["two themes", "shopify theme push --theme 1 --theme 2 --store demo-shop --only a.liquid --nodelete", "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["--live", `${SHOPIFY_PUSH} --live`, "REFUSED_THEME_PUSH_LIVE"],
  ["-l", `${SHOPIFY_PUSH} -l`, "REFUSED_THEME_PUSH_LIVE"],
  ["--allow-live", `${SHOPIFY_PUSH} --allow-live`, "REFUSED_THEME_PUSH_LIVE"],
  ["-a", `${SHOPIFY_PUSH} -a`, "REFUSED_THEME_PUSH_LIVE"],
  ["--unpublished", `${SHOPIFY_PUSH} --unpublished`, "REFUSED_THEME_REMOTE_OP"],
  ["-u", `${SHOPIFY_PUSH} -u`, "REFUSED_THEME_REMOTE_OP"],
  ["--development", `${SHOPIFY_PUSH} --development`, "REFUSED_THEME_REMOTE_OP"],
  ["--publish", `${SHOPIFY_PUSH} --publish`, "REFUSED_THEME_REMOTE_OP"],
  ["-p", `${SHOPIFY_PUSH} -p`, "REFUSED_THEME_REMOTE_OP"],
  ["--force", `${SHOPIFY_PUSH} --force`, "REFUSED_THEME_PUSH_SCOPE"],
  ["-f", `${SHOPIFY_PUSH} -f`, "REFUSED_THEME_PUSH_SCOPE"],
  ["--password", `${SHOPIFY_PUSH} --password shptka_x`, "REFUSED_THEME_REMOTE_OP"],
  ["--stable", `${SHOPIFY_PUSH} --stable`, "REFUSED_THEME_REMOTE_OP"],
  ["a toml environment", `${SHOPIFY_PUSH} -e production`, "REFUSED_THEME_REMOTE_OP"],
  ["an unknown flag", `${SHOPIFY_PUSH} --frobnicate`, "REFUSED_THEME_REMOTE_OP"],
  ["bundled short flags", "shopify theme push --theme 123456789 --store demo-shop --only a.liquid -nj", "REFUSED_THEME_REMOTE_OP"],
  ["a value on a boolean flag", "shopify theme push --theme 123456789 --store demo-shop --only a.liquid --nodelete=false", "REFUSED_THEME_REMOTE_OP"],
  ["a flag before push", "shopify theme --store demo-shop push --theme 123456789 --only a.liquid --nodelete", "REFUSED_THEME_REMOTE_OP"],
  ["a stray argument", `${SHOPIFY_PUSH} extra.liquid`, "REFUSED_THEME_PUSH_SCOPE"],
  ["a cd before it", `cd ../other && ${SHOPIFY_PUSH}`, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["a publish chained after it", `${SHOPIFY_PUSH} && shopify theme publish 123456789`, "REFUSED_THEME_REMOTE_OP"],
  ["a Sapo push with the same flags", "sapo theme push --theme 123456789 --store demo-shop --only a.liquid --nodelete", "REFUSED_THEME_REMOTE_OP"],
]) {
  test(`a worker's shopify theme push with ${label} is refused`, async () => {
    const root = makeThemeWorkspace();
    const stub = installShopifyStub({ themes: [DEMO("unpublished")] });
    try {
      await asTerminal(true, async () => {
        const result = await runBash(root, `sess-shopify-refuse-${label.replace(/\W+/g, "-")}`, command);
        assert.equal(result?.block, true, `${command} must be refused`);
        assert.ok(result.reason.startsWith(`${expectedCode}:`), result.reason);
        if (!command.includes("&&")) assert.equal(stub.recorded().length, 0, "no probe for a command that fails the flag rules");
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

test("a worker's scoped shopify push is refused while a flag-equivalent environment variable is set", async () => {
  const root = makeThemeWorkspace();
  const stub = installShopifyStub({ themes: [DEMO("unpublished")] });
  const saved = process.env.SHOPIFY_FLAG_LIVE;
  process.env.SHOPIFY_FLAG_LIVE = "1";
  try {
    await asTerminal(true, async () => {
      const result = await runBash(root, "sess-shopify-env", SHOPIFY_PUSH);
      assert.ok(result?.reason.startsWith("REFUSED_THEME_PUSH_UNVERIFIED:"), result?.reason);
      assert.match(result.reason, /SHOPIFY_FLAG_LIVE/);
      assert.equal(stub.recorded().length, 0);
    });
  } finally {
    if (saved === undefined) delete process.env.SHOPIFY_FLAG_LIVE;
    else process.env.SHOPIFY_FLAG_LIVE = saved;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("the user's own session and a worker's help or list calls need no Shopify probe", async () => {
  const root = makeThemeWorkspace();
  const stub = installShopifyStub({ themes: [DEMO("live")] });
  try {
    await asTerminal(true, async () => {
      assert.equal(await runBash(root, "sess-shopify-help", "shopify theme push --help"), null);
      assert.equal(await runBash(root, "sess-shopify-list", "shopify theme list --store demo-shop"), null);
    });
    await asTerminal(false, async () => {
      assert.equal(await runBash(root, "sess-shopify-user", "shopify theme push --live"), null);
    });
    assert.equal(stub.recorded().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

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

test("a benign eval cell by a worker is allowed without reading the Leader registry", async () => {
  const root = makeThemeWorkspace();
  try {
    await asTerminal(true, async () => {
      const counter = failRegistryReads(0, "EBUSY");
      try {
        const verdict = await runTool(root, "sess-eval-benign", "eval", { language: "py", code: "print(sum(range(10)))" });
        assert.equal(verdict, null);
        assert.equal(counter.state.attempts, 0, "a cell that starts no process needs no registry read");
        const refused = await runTool(root, "sess-eval-refused", "eval", { language: "py", code: 'import os\nos.system("hrv theme push")' });
        assert.equal(refused?.block, true, "a refusal still needs the registry, and still happens");
        assert.equal(counter.state.attempts, 1);
      } finally {
        counter.restore();
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// In an eval cell `process.execPath` is the `omp` binary, so spawning it starts a child agent
// that inherits the caller's terminal identity. The refusal applies to every session.
test("an eval cell that spawns process.execPath is refused for a worker and for any other session", async () => {
  const root = makeThemeWorkspace();
  try {
    for (const worker of [true, false]) {
      await asTerminal(worker, async () => {
        for (const code of [
          "const { execFileSync } = require('node:child_process');\nexecFileSync(process.execPath, ['scripts/antifan-core.cjs', 'adjudicate', payload]);",
          "Bun.spawn([process.execPath, 'scripts/x.cjs'])",
          "Bun.spawnSync({ cmd: [process.argv0, 'x.cjs'] })",
          "require('child_process').spawnSync(process.argv[0], ['x.cjs'])",
          "require('child_process').execSync(`\"${process.execPath}\" x.cjs`)",
          "await Bun.$`${process.execPath} x.cjs`",
          "const cp = require('child_process');\nconst bin = process.execPath;\ncp.fork('x.cjs', [], { execPath: bin })",
          // a string that only mentions the word still counts: the message names the fix
          "const note = 'never use process.execPath';\nrequire('child_process').execFileSync('node', ['x.cjs']);",
        ]) {
          const result = await runTool(root, `sess-self-spawn-${worker}-${code.length}`, "eval", { language: "js", code });
          assert.equal(result?.block, true, `${code} must be refused (worker=${worker})`);
          assert.ok(result.reason.startsWith("REFUSED_EVAL_SELF_SPAWN:"), result.reason);
          assert.ok(result.reason.includes("omp") && result.reason.includes("bash") && result.reason.includes('"node"'), "the refusal names the cause and the fix");
        }
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an eval cell that spawns node by name, only prints process.execPath, or is Python is not refused as a self-spawn", async () => {
  const root = makeThemeWorkspace();
  try {
    for (const worker of [true, false]) {
      await asTerminal(worker, async () => {
        for (const [language, code] of [
          ["js", "require('child_process').execFileSync('node', ['scripts/antifan-core.cjs', 'stats'])"],
          ["js", "Bun.spawn(['node', 'x.cjs'])"],
          ["js", "console.log(process.execPath, process.argv0, process.argv[0])"],
          ["py", "import subprocess\nsubprocess.run([sys.executable, 'x.py'])  # not process.execPath, process.argv[0]"],
          ["py", "import subprocess\nsubprocess.run(['x'])\nnote = 'process.execPath'"],
        ]) {
          assert.equal(await runTool(root, `sess-self-spawn-ok-${worker}-${code.length}`, "eval", { language, code }), null, code);
        }
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
      assert.equal(await runBash(root, "sess-plain-push", "hrv theme push --only sections/hrv.liquid --nodelete"), null);
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
      assert.equal(await runBash(root, "sess-audit-allow", "hrv theme push --only sections/hero.liquid --nodelete"), null);
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
  // Sampled from real worker calls the guard refused: a folder named after the CLI, and a
  // keyword that only sits inside a search pattern.
  'cd "E:/Work/themes/devs2/S2 Corporate/Haravan" && rg -n "sc_blog_careers" config/settings_schema.json',
  'cd "E:/Work/themes/devs2/S2 Rog Bike/Haravan" && echo "=== theme code ==="',
  'rg -n "function createService|const create\\b" src/haravan/haravan.service.spec.ts',
  'rg -n "eval|iex" E:/Work/themes/devs2/S2 Pet House/Haravan/layout/theme.liquid',
  'd="devs2/S2 Corporate"; f="$d/Haravan"; ls "$f/sections" | wc -l',
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

for (const [label, language, code] of [
  ["reads a file inside a Haravan theme folder", "js", "const fs = require('fs'); console.log(fs.readdirSync('E:/Work/themes/devs2/S2 Corporate/Haravan/sections'), 'theme folder')"],
  ["prints a note that mentions the CLI", "py", "print('hrv theme push is for the user to run')"],
]) {
  test(`a worker's eval cell that ${label} starts no process and passes`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role: "main" });
    try {
      await asTerminal(true, async () => {
        assert.equal(await runTool(root, `sess-eval-reads-${language}`, "eval", { language, code }), null);
      });
      assert.equal(stub.recorded().length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

for (const [label, language, code] of [
  ["runs a capitalised path-qualified CLI through subprocess", "py", 'import subprocess\nsubprocess.run(["C:/Users/Admin/AppData/Roaming/npm/HRV", "theme", "push", "--force"])'],
  ["runs the CLI through Bun.$", "js", "await Bun.$`hrv theme push --nodelete`"],
  ["starts a process for a raw API write", "js", "await Bun.$`C:/Users/Admin/AppData/Roaming/npm/HRV api put /web/themes/1.json`"],
  ["holds a capitalised CLI path in a variable", "py", 'cli = "C:/Users/Admin/AppData/Roaming/npm/HRV"\nimport subprocess\nsubprocess.run([cli, "theme", "push", "--force"])'],
  ["holds a raw-string CLI path in a variable", "py", 'cli = r"C:/Users/Admin/AppData/Roaming/npm/HRV"\nimport subprocess\nsubprocess.run([cli, "theme", "push", "--force"])'],
  ["builds the CLI path with pathlib", "py", 'import pathlib, subprocess\np = pathlib.Path("C:/Users/Admin/AppData/Roaming/npm/HRV")\nsubprocess.run([str(p), "theme", "push", "--force"])'],
  ["builds the CLI path with os.path.join", "py", 'import os, subprocess\nnpm = os.environ["APPDATA"]\nsubprocess.run([os.path.join(npm, "npm", "HRV"), "theme", "push"])'],
  ["runs the CLI through a zx template", "js", 'import { $ } from "zx";\nawait $`hrv theme push --force`'],
]) {
  test(`a worker's eval cell that ${label} is refused`, async () => {
    const root = makeThemeWorkspace();
    bindShop(root);
    const stub = installInfoStub({ role: "main" });
    try {
      await asTerminal(true, async () => {
        const result = await runTool(root, `sess-eval-refused-${label.replace(/\W+/g, "-")}`, "eval", { language, code });
        assert.ok(result?.reason.startsWith("REFUSED_THEME_VIA_EVAL:"), result?.reason);
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
  // Windows resolves the CLI whatever the case of its file name, so a capitalised path word that is
  // followed by `theme` in the same statement is the CLI, not a folder.
  ["a capitalised path-qualified CLI with --force", "C:/Users/Admin/AppData/Roaming/npm/HRV theme push --force", "REFUSED_THEME_PUSH_SCOPE"],
  ["a capitalised path-qualified raw API write", "C:/Users/Admin/AppData/Roaming/npm/HRV api put /web/themes/1.json", "REFUSED_THEME_REMOTE_OP"],
  ["an alias to a capitalised path", "Set-Alias h C:/tools/HRV", "REFUSED_THEME_COMPLEX"],
  ["a variable run as the CLI", "$h theme push --force", "REFUSED_THEME_COMPLEX"],
  ["a call operator on a variable", "& $h theme publish 1001507144", "REFUSED_THEME_COMPLEX"],
  ["a function wrapping a capitalised CLI path", "function h { C:/Users/Admin/AppData/Roaming/npm/HRV @args }; h theme push", "REFUSED_THEME_COMPLEX"],
  ["a quote-split variable run as the CLI", '"$h" "th""eme" push --force', "REFUSED_THEME_COMPLEX"],
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

test("hrv theme push: which lines send config/settings_data.json without naming it", () => {
  const verdict = (line) => themePolicy.planThemeCommand(themePolicy.parseThemeCommands(line)[0], "1001507144").decision;
  const SETTINGS = "REFUSED_THEME_PUSH_SETTINGS_DATA";
  const codeOf = (line) => {
    const plan = themePolicy.planThemeCommand(themePolicy.parseThemeCommands(line)[0], "1001507144");
    return plan.decision === "block" ? plan.code : plan.decision;
  };
  for (const line of [
    "hrv theme push --nodelete --ignore config/settings_data.json",
    "hrv theme push --nodelete -x config/settings_data.json",
    "hrv theme push -nx config/settings_data.json",
    "hrv theme push --nodelete --ignore=config/settings_data.json",
    "hrv theme push --nodelete --ignore sections/a.liquid config/settings_data.json",
    "hrv theme push --nodelete --ignore config/**",
    "hrv theme push --nodelete --ignore **/settings_data.json",
    "hrv theme push --only sections/a.liquid templates/b.json --nodelete",
    "hrv theme push --only sections/*.liquid --nodelete",
    "hrv theme push --only config/settings_data.json --nodelete",
    "hrv theme push -o config/settings_data.json -n",
    "hrv theme push sections/a.liquid,assets/b.css --nodelete",
  ]) {
    assert.equal(verdict(line), "verify-draft", line);
  }
  for (const line of [
    "hrv theme push --nodelete",
    "hrv theme push -n",
    "hrv theme push --nodelete --ignore sections/a.liquid",
    "hrv theme push --nodelete --ignore config/*.liquid",
    "hrv theme push --nodelete --ignore config/{settings_data,x}.json",
    "hrv theme push --only config/** --nodelete",
    "hrv theme push --only ** --nodelete",
    "hrv theme push --only config/settings_data.json ** --nodelete",
    "hrv theme push --only config/{a,settings_data}.json --nodelete",
    "hrv theme push --only --nodelete",
    "hrv theme push --nodelete --only",
  ]) {
    assert.equal(codeOf(line), SETTINGS, line);
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
      await draftProbe.gateThemeLine({ text: "hrv theme push --only a.liquid --nodelete", cwd: path.join(root, "sections"), timeoutMs: 20_000 }),
      { decision: "allow", verified: ["hrv theme push --only a.liquid --nodelete"] },
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
    const pushed = await draftProbe.gateThemeLine({ text: "hrv theme push --only a.liquid --nodelete", cwd: root, timeoutMs: 20_000 });
    assert.deepEqual(pushed, { decision: "allow", verified: ["hrv theme push --only a.liquid --nodelete"] }, "the live bound theme takes a push like any other");
    const bare = await draftProbe.gateThemeLine({ text: "hrv theme push --only a.liquid", cwd: root, timeoutMs: 20_000 });
    assert.equal(bare.code, "REFUSED_THEME_PUSH_NODELETE", "a push without --nodelete is refused with a code that names the fix");
    assert.match(bare.reason, /Add --nodelete/);
    const whole = await draftProbe.gateThemeLine({ text: "hrv theme push --nodelete", cwd: root, timeoutMs: 20_000 });
    assert.equal(whole.code, "REFUSED_THEME_PUSH_SETTINGS_DATA", "a whole-theme push must exclude settings_data");
    assert.match(whole.reason, /--ignore config\/settings_data\.json/);
    assert.match(whole.reason, /hrv theme fetch 1001507144 --only config\/settings_data\.json/);
    const ignoring = await draftProbe.gateThemeLine({ text: "hrv theme push --nodelete -x config/settings_data.json", cwd: root, timeoutMs: 20_000 });
    assert.equal(ignoring.decision, "allow", "the same push with settings_data excluded passes");
    const dev = await draftProbe.gateThemeLine({ text: "hrv theme dev", cwd: root, timeoutMs: 20_000 });
    assert.equal(dev.code, "REFUSED_THEME_PUSH_LIVE", "a watcher stays off the live theme");
    assert.equal(dev.command, "hrv theme dev");
    fs.rmSync(live.dir, { recursive: true, force: true });
  } finally {
    // The probe the 1 ms budget cut off may still be exiting inside `root`, and Windows refuses to remove a folder a live process holds.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    fs.rmSync(draft.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test("gateThemeLine (the terminal.write path) applies the same Shopify draft decision as the bash hook", async () => {
  const root = makeThemeWorkspace();
  const stub = installShopifyStub({ themes: [DEMO("unpublished")] });
  try {
    assert.deepEqual(
      await draftProbe.gateThemeLine({ text: SHOPIFY_PUSH, cwd: path.join(root, "sections"), timeoutMs: 20_000 }),
      { decision: "allow", verified: [SHOPIFY_PUSH] },
    );
    assert.deepEqual(stub.recorded().map((call) => call.argv), [["theme", "list", "--id", "123456789", "--store", "demo-shop", "--json"]]);

    const moved = await draftProbe.gateThemeLine({ text: SHOPIFY_PUSH, cwd: root, timeoutMs: 20_000, assumeDirChanged: true });
    assert.equal(moved.code, "REFUSED_THEME_PUSH_UNVERIFIED");
    assert.equal(stub.recorded().length, 1, "no probe when the folder cannot be trusted");

    const live = await draftProbe.gateThemeLine({ text: `${SHOPIFY_PUSH} --live`, cwd: root, timeoutMs: 20_000 });
    assert.equal(live.code, "REFUSED_THEME_PUSH_LIVE");
    assert.equal(stub.recorded().length, 1, "a live flag is refused before any probe");

    fs.rmSync(stub.dir, { recursive: true, force: true });
    const liveStub = installShopifyStub({ themes: [DEMO("live")] });
    const refused = await draftProbe.gateThemeLine({ text: SHOPIFY_PUSH, cwd: root, timeoutMs: 20_000 });
    assert.equal(refused.code, "REFUSED_THEME_PUSH_LIVE");
    assert.equal(refused.command, SHOPIFY_PUSH);
    fs.rmSync(liveStub.dir, { recursive: true, force: true });

    for (const line of ["shopify theme publish 123456789", "sapo theme push --theme 1 --store s --only a --nodelete"]) {
      const outcome = await draftProbe.gateThemeLine({ text: line, cwd: root, timeoutMs: 20_000 });
      assert.equal(outcome.code, "REFUSED_THEME_REMOTE_OP", line);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("parseShopifyThemeList reads the JSON array past a notice and rejects anything else", () => {
  assert.deepEqual(themePolicy.parseShopifyThemeList('Update available\n[\n  { "id": 5, "name": "A", "role": "Unpublished" }\n]\n'), [
    { id: "5", role: "unpublished" },
  ]);
  assert.deepEqual(themePolicy.parseShopifyThemeList("[]"), []);
  for (const output of ["", "no themes", "{}", "[1]", '[{ "id": 5 }]', "[ not json ]"]) {
    assert.equal(themePolicy.parseShopifyThemeList(output), null, output);
  }
});

// ---------------------------------------------------------------------------
// Leader worker: one-use approval of a push to the LIVE theme
// ---------------------------------------------------------------------------

const approval = await load("theme-push-approval");
const LEADER_JOB_CLI = path.join(REPO, "scripts", "leader", "leader-job.mjs");
const LIVE_PUSH = "hrv theme push --only assets/a.css sections/hero.liquid --nodelete";
const LIVE_PUSH_FILES = ["assets/a.css", "sections/hero.liquid"];
const approvalFiles = (dataRoot) => {
  const dir = approval.approvalsDirOf(dataRoot);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

/** A theme folder bound to `themeId`, holding the files the approvals below name. */
function makeLiveWorkspace(themeId = "1001507144") {
  const root = makeThemeWorkspace();
  fs.writeFileSync(
    path.join(root, ".haravan-cli_local.json"),
    JSON.stringify({ org_id: "200001", theme_id: themeId, theme_name: "Stub", theme_org_id: "200001" }),
  );
  for (const file of ["assets/a.css", "sections/hero.liquid", "sections/b.liquid", "config/settings.html"]) {
    fs.writeFileSync(path.join(root, file), "x\n");
  }
  return root;
}

/** What the Leader runs once the user said yes: the real CLI, as the Leader's own terminal unless `env` says otherwise. A later flag wins over an earlier one. */
function leaderApproves(dataRoot, root, files, extraArgs = [], env = {}) {
  const run = spawnSync(
    process.execPath,
    [LEADER_JOB_CLI, "approve-push", "--worker", "terminal-w", "--theme", "1001507144", "--cwd", root, "--files", files.join(" "), "--quote", "ok, push lên đi", ...extraArgs],
    { encoding: "utf8", env: { ...process.env, ANTIFAN_TERMINAL_SESSION_ID: "terminal-lead", ANTIFAN_DATA_ROOT: dataRoot, ...env } },
  );
  const line = run.stdout.split("\n").find((entry) => entry.startsWith("{"));
  return { code: run.status, out: line ? JSON.parse(line) : null, stderr: run.stderr };
}

function rewriteApproval(dataRoot, id, patch) {
  const file = path.join(approval.approvalsDirOf(dataRoot), `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...patch }));
}

/** One worker case: terminal-w under terminal-lead, an isolated data root, and a CLI that answers `theme info -j` with `role`. */
async function liveCase(fn, role = "main") {
  const root = makeLiveWorkspace();
  const stub = installInfoStub({ role });
  let dataRootUsed = null;
  try {
    await withDataRoot("push-approvals-", (dataRoot) => {
      dataRootUsed = dataRoot;
      return asTerminal(true, () => fn({ root, dataRoot, stub }));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
    if (dataRootUsed !== null) fs.rmSync(dataRootUsed, { recursive: true, force: true });
  }
}

test("a worker's push to its bound theme passes with no approval, live or copy alike, and spends none", async () => {
  await liveCase(async ({ root, dataRoot }) => {
    const given = leaderApproves(dataRoot, root, LIVE_PUSH_FILES);
    assert.equal(given.code, 0, given.stderr);
    for (const [index, line] of [
      LIVE_PUSH,
      "hrv theme push --nodelete -x config/settings_data.json",
      "hrv theme push --only config/settings_data.json --nodelete",
      "hrv theme push -n --only a.liquid",
      "hrv theme push --only a.liquid --nodelete",
      "hrv theme push --only a.liquid -jn",
    ].entries()) {
      const session = `sess-live-${index}`;
      assert.equal(await runBash(root, session, line), null, `${line} passes on the live bound theme`);
      assert.deepEqual(readLog(root, session).map((row) => `${row.decision}:${row.code}`), ["allow:THEME_SYNC_DRAFT_VERIFIED"]);
    }
    assert.deepEqual(approvalFiles(dataRoot), [`${given.out.id}.json`], "no push needs an approval, so a recorded one is never spent");
  });
});

test("a push to the bound live theme is still refused when it leaves the rule: force, prune, another theme, a chain, dev, publish, other CLIs", async () => {
  await liveCase(async ({ root }) => {
    const scope = "REFUSED_THEME_PUSH_SCOPE";
    const foreign = "REFUSED_THEME_PUSH_FOREIGN_THEME";
    const complex = "REFUSED_THEME_COMPLEX";
    for (const [label, line, code] of [
      ["--force", `${LIVE_PUSH} --force`, scope],
      ["-f", `${LIVE_PUSH} -f`, scope],
      ["a bundled -nf", "hrv theme push -nf --only a.liquid", scope],
      ["--prune", `${LIVE_PUSH} --prune`, scope],
      ["a push with no --nodelete", "hrv theme push --only a.liquid", "REFUSED_THEME_PUSH_NODELETE"],
      ["a whole-theme push with no --nodelete", "hrv theme push", "REFUSED_THEME_PUSH_NODELETE"],
      ["a whole-theme push that does not exclude settings_data", "hrv theme push --nodelete", "REFUSED_THEME_PUSH_SETTINGS_DATA"],
      ["a theme id argument that is not the bound one", "hrv theme push 999 --only assets/a.css --nodelete", foreign],
      ["another theme through --theme", "hrv theme push --theme 999", foreign],
      ["a chained command", `${LIVE_PUSH} && echo done`, complex],
      ["a command after a semicolon", `${LIVE_PUSH}; echo done`, complex],
      ["a piped command", `${LIVE_PUSH} | tee push.log`, complex],
      ["a command in front", `echo start && ${LIVE_PUSH}`, complex],
      ["a second push", `${LIVE_PUSH} && ${LIVE_PUSH}`, complex],
      ["a dev server on the live theme", "hrv theme dev", "REFUSED_THEME_PUSH_LIVE"],
      ["a publish", "hrv theme publish 1001507144", "REFUSED_THEME_REMOTE_OP"],
      ["a Sapo push with no --only", "sapo theme push", scope],
      ["a Shopify push with no flags", "shopify theme push", scope],
    ]) {
      const result = await runBash(root, "sess-live-b", line);
      assert.equal(result?.block, true, `${label} must be refused: ${line}`);
      assert.ok(result.reason.startsWith(`${code}:`), `${label}: ${result.reason}`);
    }
  });
});

test("a push is judged by what hrv theme info reports for the bound theme: failure and another id both refuse", async () => {
  await liveCase(async ({ root }) => {
    const result = await runBash(root, "sess-info-fails", LIVE_PUSH);
    assert.equal(result?.block, true);
    assert.ok(result.reason.startsWith("REFUSED_THEME_PUSH_UNVERIFIED:"), result.reason);
  }, null);

  const root = makeLiveWorkspace();
  const stub = installInfoStub({ themeId: "777", role: "unpublished" });
  try {
    await asTerminal(true, async () => {
      const result = await runBash(root, "sess-info-other", LIVE_PUSH);
      assert.equal(result?.block, true);
      assert.ok(result.reason.startsWith("REFUSED_THEME_PUSH_UNVERIFIED:"), result.reason);
      assert.match(result.reason, /it reported theme 777/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("a push is refused when hrv theme info exits non-zero, even if it printed the bound theme", async () => {
  const root = makeLiveWorkspace();
  const stub = installInfoStub({ role: "main", exitCode: 3 });
  try {
    await asTerminal(true, async () => {
      const result = await runBash(root, "sess-info-exit", LIVE_PUSH);
      assert.equal(result?.block, true);
      assert.ok(result.reason.startsWith("REFUSED_THEME_PUSH_UNVERIFIED:"), result.reason);
      assert.match(result.reason, /exit 3/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("an approval changes nothing on a draft theme and is not spent there", async () => {
  await liveCase(async ({ root, dataRoot }) => {
    const given = leaderApproves(dataRoot, root, LIVE_PUSH_FILES);
    assert.equal(given.code, 0, given.stderr);
    assert.equal(await runBash(root, "sess-approval-draft", LIVE_PUSH), null, "a verified draft sync passes as before");
    assert.deepEqual(readLog(root, "sess-approval-draft").map((row) => `${row.decision}:${row.code}`), ["allow:THEME_SYNC_DRAFT_VERIFIED"]);
    assert.deepEqual(approvalFiles(dataRoot), [`${given.out.id}.json`]);
  }, "unpublished");
});

test("a worker cannot record, change or delete an approval; a terminal that is not a worker can", async () => {
  await liveCase(async ({ root, dataRoot }) => {
    const store = path.join(approval.approvalsDirOf(dataRoot), "x.json").replace(/\\/g, "/");
    for (const [tool, input] of [
      ["bash", { command: "node scripts/leader/leader-job.mjs approve-push --worker terminal-w --theme 1 --cwd . --files a --quote q" }],
      ["bash", { command: `node "E:/Work/apps/AntiFan/scripts/leader/leader-job.mjs" approve-"push" --worker terminal-w` }],
      ["bash", { command: `echo {} > ${store}` }],
      ["bash", { command: "del %ANTIFAN_DATA_ROOT%\\runtime\\leader-push-approvals\\x.json" }],
      ["eval", { code: `require("node:fs").writeFileSync(${JSON.stringify(store)}, "{}")` }],
      ["write", { path: store, content: "{}" }],
      ["edit", { path: store, edits: [] }],
    ]) {
      const result = await runTool(root, `sess-self-${tool}`, tool, input);
      assert.equal(result?.block, true, `${tool} ${JSON.stringify(input)} must be refused`);
      assert.ok(result.reason.startsWith("REFUSED_THEME_APPROVAL_SELF:"), result.reason);
      assert.equal(readLog(root, `sess-self-${tool}`).at(-1).code, "REFUSED_THEME_APPROVAL_SELF");
    }
    assert.deepEqual(approvalFiles(dataRoot), [], "nothing was written");
    assert.equal(await runTool(root, "sess-self-read", "read", { path: path.dirname(store) }), null, "looking at the folder is not refused");
  });

  const root = makeThemeWorkspace();
  try {
    await asTerminal(false, async () => {
      assert.equal(await runBash(root, "sess-user-approve", "node scripts/leader/leader-job.mjs approve-push --help"), null);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Leader's CLI and the hook's reader agree on which file names an approval can carry", async () => {
  await liveCase(async ({ root, dataRoot }) => {
    for (const name of ["assets/lv-home-bp1.css.liquid", "sections/hero_v2@2x.liquid", "snippets/a+b.liquid", "config/settings_data.json", "a/b/c/d.liquid", "x.js", "_x"]) {
      assert.equal(approval.isPushFile(name), true, name);
      const target = path.join(root, ...name.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "x\n");
      const given = leaderApproves(dataRoot, root, [name]);
      assert.equal(given.code, 0, `${name}: ${given.stderr}`);
      assert.deepEqual(given.out.files, [name]);
    }
    for (const name of ["../a", "a/../b", "/etc/x", "C:/x", "a\\b", "a//b", "a/", ".hidden", "-x", "a*b", "a?b", "a;b", "a&b", "a|b", "a$b", "a`b", "a'b", 'a"b', "a(b)", "a,b", "é.liquid", "a".repeat(201)]) {
      assert.equal(approval.isPushFile(name), false, name);
      assert.equal(leaderApproves(dataRoot, root, [name]).code, 2, `${name} must be refused by the CLI as a usage error`);
    }
  });
});

test("the Leader's CLI records an approval only for the registered Leader of that worker, and only for what the theme folder holds", async () => {
  await liveCase(async ({ root, dataRoot }) => {
    const registryFile = path.join(process.env.ANTIFAN_CONFIG_DIR, "leader-terminals.json");
    const ownRegistry = fs.readFileSync(registryFile, "utf8");
    const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "leader-jobs-"));
    const makeJob = (name, patch = {}) => {
      const dir = path.join(jobs, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "job.json"),
        JSON.stringify({ schema: "leader-job/1", job: name, state: "dispatched", leader: { terminal: "terminal-lead" }, rounds: [{ n: 1, worker: { terminal: "terminal-w" } }], ...patch }),
      );
      return dir;
    };
    const recordOf = (id) => JSON.parse(fs.readFileSync(path.join(approval.approvalsDirOf(dataRoot), `${id}.json`), "utf8"));
    try {
      const mine = makeJob("mine");
      const control = leaderApproves(dataRoot, root, LIVE_PUSH_FILES, ["--job", mine]);
      assert.equal(control.code, 0, control.stderr);
      const kept = recordOf(control.out.id);
      assert.deepEqual(
        { leader: kept.leader, worker: kept.worker, job: kept.job, themeId: kept.themeId, files: kept.files },
        { leader: "terminal-lead", worker: "terminal-w", job: "mine", themeId: "1001507144", files: LIVE_PUSH_FILES },
      );
      assert.equal(kept.expiresAt - kept.approvedAt, 30 * 60_000, "thirty minutes unless the Leader asks for fewer");
      fs.rmSync(path.join(approval.approvalsDirOf(dataRoot), `${control.out.id}.json`));

      // Every case below differs from the control call above in exactly one thing.
      const otherLeader = JSON.stringify({
        schema: 1,
        leaders: ["terminal-lead", "terminal-lead2"],
        workers: { "terminal-w": { leaderId: "terminal-lead2", assignedAt: 2 } },
      });
      for (const [label, code, change] of [
        ["the worker itself", 4, { env: { ANTIFAN_TERMINAL_SESSION_ID: "terminal-w" } }],
        ["a terminal that is no Leader", 4, { env: { ANTIFAN_TERMINAL_SESSION_ID: "terminal-x" } }],
        ["no terminal id", 2, { env: { ANTIFAN_TERMINAL_SESSION_ID: "" } }],
        ["a worker nobody placed", 4, { args: ["--worker", "terminal-nobody"] }],
        ["a worker another Leader drives", 4, { registry: otherLeader }],
        ["a theme other than the folder's", 2, { args: ["--theme", "999"] }],
        ["a file the folder does not hold", 2, { files: ["assets/missing.css"] }],
        ["more than 30 minutes", 2, { args: ["--ttl-min", "31"] }],
        ["no minutes", 2, { args: ["--ttl-min", "0"] }],
        ["no words of the user", 2, { args: ["--quote", ""] }],
        ["a job of another Leader", 4, { args: ["--job", makeJob("other", { leader: { terminal: "terminal-lead2" } })] }],
        ["a job this worker is not in", 4, { args: ["--job", makeJob("alien", { rounds: [{ n: 1, worker: { terminal: "terminal-y" } }] })] }],
        ["a closed job", 4, { args: ["--job", makeJob("shut", { state: "closed" })] }],
      ]) {
        if (change.registry !== undefined) fs.writeFileSync(registryFile, change.registry);
        const result = leaderApproves(dataRoot, root, change.files ?? LIVE_PUSH_FILES, change.args ?? [], change.env ?? {});
        fs.writeFileSync(registryFile, ownRegistry);
        assert.equal(result.code, code, `${label}: ${result.stderr}`);
      }
      assert.deepEqual(approvalFiles(dataRoot), [], "none of them recorded anything");

      const short = leaderApproves(dataRoot, root, LIVE_PUSH_FILES, ["--job", mine, "--ttl-min", "5"]);
      assert.equal(short.code, 0, short.stderr);
      const shortRecord = recordOf(short.out.id);
      assert.equal(shortRecord.expiresAt - shortRecord.approvedAt, 5 * 60_000);
    } finally {
      fs.rmSync(jobs, { recursive: true, force: true });
    }
  });
});

test("the user's words can come from a file, so a quote that names the theme CLI is recorded unedited", async () => {
  await liveCase(async ({ root, dataRoot }) => {
    const quoteFile = path.join(dataRoot, "the-user-words.txt");
    const words = "ừ em duyệt, đẩy hrv theme push lên theme live đi";
    fs.writeFileSync(quoteFile, `${words}\n`);
    const given = leaderApproves(dataRoot, root, LIVE_PUSH_FILES, ["--quote-file", quoteFile]);
    assert.equal(given.code, 0, given.stderr);
    const record = JSON.parse(fs.readFileSync(path.join(approval.approvalsDirOf(dataRoot), `${given.out.id}.json`), "utf8"));
    assert.equal(record.quote, words, "the user's own words, unedited");

    assert.equal(leaderApproves(dataRoot, root, LIVE_PUSH_FILES, ["--quote-file", path.join(dataRoot, "missing.txt")]).code, 2, "a file that is not there");
    fs.writeFileSync(quoteFile, "dòng một\ndòng hai\n");
    assert.equal(leaderApproves(dataRoot, root, LIVE_PUSH_FILES, ["--quote-file", quoteFile]).code, 2, "two lines are not one line of the user's words");
    assert.deepEqual(approvalFiles(dataRoot), [`${given.out.id}.json`], "the refused calls recorded nothing");
  });
});

test("parseApprovedPush accepts only hrv theme push --only <files> --nodelete, as one plain line", () => {
  assert.deepEqual(approval.parseApprovedPush("hrv theme push --only assets/a.css --nodelete"), ["assets/a.css"]);
  assert.deepEqual(
    approval.parseApprovedPush("  hrv theme push --only sections/b.liquid  assets/a.css assets/a.css --nodelete  "),
    ["assets/a.css", "sections/b.liquid"],
    "sorted, without repeats",
  );
  for (const line of [
    "hrv theme push --only assets/a.css",
    "hrv theme push --only assets/a.css --nodelete --force",
    "hrv theme push --only assets/a.css --force --nodelete",
    "hrv theme push --nodelete --only assets/a.css",
    "hrv theme push --only --nodelete",
    "hrv theme push 123 --only assets/a.css --nodelete",
    "hrv theme push --only assets/a.css --nodelete && echo x",
    "hrv theme push --only assets/a.css --nodelete; echo x",
    "hrv theme push --only assets/a.css --nodelete | tee x",
    "hrv theme push --only assets/a.css --nodelete\nrm x",
    "echo x && hrv theme push --only assets/a.css --nodelete",
    "hrv theme push --only ../a.css --nodelete",
    "hrv theme push --only /a.css --nodelete",
    "hrv theme push --only C:/a.css --nodelete",
    "hrv theme push --only a\\b.css --nodelete",
    "hrv theme push --only 'a.css' --nodelete",
    "hrv theme push --only *.css --nodelete",
    "hrv theme push --only $env:X --nodelete",
    "hrv theme dev",
    "hrv theme publish 1",
    "shopify theme push --only assets/a.css --nodelete",
    "sapo theme push --only assets/a.css --nodelete",
    "",
    `hrv theme push --only ${Array.from({ length: 51 }, (_, index) => `f${index}.css`).join(" ")} --nodelete`,
  ]) {
    assert.equal(approval.parseApprovedPush(line), null, JSON.stringify(line));
  }
});

// ---- Sapo CLI: one worker lane parallel to hrv ----

const SAPO_BOUND = "1035075";
const { SAPO_COMMAND_ENV } = draftProbe;
const SAPO_AT_LOAD = process.env[SAPO_COMMAND_ENV];
after(() => {
  if (SAPO_AT_LOAD === undefined) delete process.env[SAPO_COMMAND_ENV];
  else process.env[SAPO_COMMAND_ENV] = SAPO_AT_LOAD;
});

/** Plan for one Sapo line with the theme id `.sapo-cli_local.json` holds (`null` = no binding). */
function planSapoLine(line, bound = SAPO_BOUND, opts = {}) {
  const parsed = themePolicy.classifyThemeLine(line, opts);
  if (parsed.decision === "block") return { decision: "block", code: parsed.code };
  assert.equal(parsed.decision, "commands", line);
  assert.equal(parsed.commands.length, 1, line);
  return themePolicy.planThemeCommand(parsed.commands[0], bound);
}

for (const [line, decision] of [
  ["sapo whoiam", "allow"],
  ["sapo info", "allow"],
  ["sapo info -j", "allow"],
  ["sapo theme list", "allow"],
  ["sapo theme info", "allow"],
  ["sapo theme info 1035075", "allow"],
  ["sapo theme check", "allow"],
  ["sapo diff", "allow"],
  ["sapo diff -j", "allow"],
  ["sapo backup", "allow"],
  ["sapo backup -n before-fix", "allow"],
  ["sapo theme fetch 1035075", "allow"],
  ["sapo theme fetch", "allow"],
  ["sapo fetch 1035075", "allow"],
  ["sapo select seafoods", "allow"],
  ["sapo login --oauth -s seafoods", "allow"],
  ["sapo theme push --only layout/theme.liquid", "verify-sapo-bound"],
  ["sapo push --only assets/a.css", "verify-sapo-bound"],
  ["sapo theme push 1035075 --only sections/a.liquid", "verify-sapo-bound"],
  ["sapo theme push --only config/settings_data.json", "verify-sapo-bound"],
  ["sapo theme push --only assets/** --ignore config/settings_data.json", "verify-sapo-bound"],
  ["sapo theme push --help", "allow"],
  ["sapo theme push --only layout/theme.liquid --yes", "verify-sapo-bound"],
  ["sapo push --only layout/theme.liquid -y", "verify-sapo-bound"],
]) {
  test(`a worker may run '${line}' (${decision})`, () => {
    assert.equal(planSapoLine(line).decision, decision);
  });
}

for (const [label, line, code, bound] of [
  ["--force", "sapo theme push --only a.liquid --force", "REFUSED_THEME_PUSH_SCOPE"],
  ["--yes with --force", "sapo theme push --only a.liquid --yes --force", "REFUSED_THEME_PUSH_SCOPE"],
  ["--yes on a read command", "sapo diff --yes", "REFUSED_THEME_REMOTE_OP"],
  ["-f", "sapo theme push -f --only a.liquid", "REFUSED_THEME_PUSH_SCOPE"],
  ["a bundled -nf", "sapo theme push -nf --only a.liquid", "REFUSED_THEME_PUSH_SCOPE"],
  ["--force on the top-level push", "sapo push --force", "REFUSED_THEME_PUSH_SCOPE"],
  ["--prune", "sapo theme fetch --prune", "REFUSED_THEME_PUSH_SCOPE"],
  ["-p on fetch", "sapo theme fetch -p", "REFUSED_THEME_PUSH_SCOPE"],
  ["a push without --only", "sapo theme push", "REFUSED_THEME_PUSH_SCOPE"],
  ["a top-level push without --only", "sapo push", "REFUSED_THEME_PUSH_SCOPE"],
  ["a file argument instead of --only", "sapo theme push layout/theme.liquid", "REFUSED_THEME_PUSH_SCOPE"],
  ["two --only", "sapo theme push --only a.liquid --only b.liquid", "REFUSED_THEME_PUSH_SCOPE"],
  ["a glob that reaches settings_data", "sapo theme push --only config/**", "REFUSED_THEME_PUSH_SETTINGS_DATA"],
  ["a **/*.json glob", "sapo theme push --only **/*.json", "REFUSED_THEME_PUSH_SETTINGS_DATA"],
  ["another theme id on push", "sapo theme push 999 --only a.liquid", "REFUSED_THEME_PUSH_FOREIGN_THEME"],
  ["another theme id on fetch", "sapo theme fetch 999", "REFUSED_THEME_PUSH_FOREIGN_THEME"],
  ["--theme", "sapo theme push --only a.liquid --theme 999", "REFUSED_THEME_REMOTE_OP"],
  ["--theme-id", "sapo theme push --only a.liquid --theme-id 999", "REFUSED_THEME_REMOTE_OP"],
  ["a publish", "sapo theme publish 1035075", "REFUSED_THEME_REMOTE_OP"],
  ["a delete", "sapo theme delete 1035075", "REFUSED_THEME_REMOTE_OP"],
  ["a rename", "sapo theme rename NewName", "REFUSED_THEME_REMOTE_OP"],
  ["an export", "sapo theme export", "REFUSED_THEME_REMOTE_OP"],
  ["a theme dev watcher", "sapo theme dev", "REFUSED_THEME_REMOTE_OP"],
  ["a top-level dev watcher", "sapo dev", "REFUSED_THEME_REMOTE_OP"],
  ["a restore", "sapo restore", "REFUSED_THEME_REMOTE_OP"],
  ["a logout", "sapo logout", "REFUSED_THEME_REMOTE_OP"],
  ["a login with a token", "sapo login -t abc123 -s seafoods", "REFUSED_THEME_REMOTE_OP"],
  ["a login without --oauth", "sapo login -s seafoods", "REFUSED_THEME_REMOTE_OP"],
  ["a select with no store", "sapo select", "REFUSED_THEME_REMOTE_OP"],
  ["an option in front of the command", "sapo -x restore", "REFUSED_THEME_REMOTE_OP"],
  ["the legacy bizweb CLI", "bizweb theme list", "REFUSED_THEME_REMOTE_OP"],
  ["a chained push", "sapo theme push --only a.liquid && echo done", "REFUSED_THEME_COMPLEX"],
  ["a piped read", "sapo diff | tee diff.txt", "REFUSED_THEME_COMPLEX"],
  ["a push in a folder with no binding", "sapo theme push --only a.liquid", "REFUSED_THEME_PUSH_UNVERIFIED", null],
  ["a fetch with no id in an unbound folder", "sapo theme fetch", "REFUSED_THEME_PUSH_UNVERIFIED", null],
]) {
  test(`a worker's sapo line with ${label} is refused`, () => {
    const plan = planSapoLine(line, bound === undefined ? SAPO_BOUND : bound);
    assert.equal(plan.decision, "block", line);
    assert.equal(plan.code, code, line);
    if (plan.reason !== undefined) {
      assert.ok(plan.reason.length > code.length + 20, "the refusal says what to do");
    }
  });
}

test("a Sapo push after a cd is unverifiable, and a refusal for an allowed command never says only the user can approve it", () => {
  const plan = planSapoLine("sapo theme push --only a.liquid", SAPO_BOUND, { assumeDirChanged: true });
  assert.equal(plan.code, "REFUSED_THEME_PUSH_UNVERIFIED");
  for (const line of ["sapo theme push", "sapo theme push --only config/**", "sapo theme push --only a.liquid --theme 9"]) {
    assert.ok(!planSapoLine(line).reason.includes("only the user can approve it"), line);
  }
});

test("the legacy and top-level Sapo shortcuts are seen even without the word 'theme'", () => {
  for (const line of ["sapo push --force", "sapo restore", "sapo logout", "sapo dev", "sapo -x restore"]) {
    assert.equal(themePolicy.mentionsThemeCli(line), true, line);
  }
  for (const line of ["rg -n sapo src", "cd E:/Work/apps/Sapo CLI && npm run build", "git log -- sapo/layout/theme.liquid"]) {
    assert.equal(themePolicy.classifyThemeLine(line).decision === "commands", false, line);
  }
});

/** A stand-in `sapo` answering `theme info --json` with the theme `themeId` of `role` (`ok: false` = the CLI's red not-found text, no JSON). */
function installSapoStub({ themeId = SAPO_BOUND, ok = true, exitCode = 0, role = "unpublished" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapo-info-stub-"));
  const calls = path.join(dir, "calls.jsonl");
  const script = path.join(dir, "sapo.mjs");
  const body = ok
    ? JSON.stringify({ id: Number(themeId), name: "Stub", role }, null, 2)
    : "✗ Không tìm thấy theme #1035075.";
  fs.writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
      `console.log(${JSON.stringify(body)});`,
      `process.exitCode = ${exitCode};`,
    ].join("\n"),
  );
  process.env[SAPO_COMMAND_ENV] = `"${process.execPath}" "${script}"`;
  const recorded = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map((row) => JSON.parse(row)) : []);
  return { dir, recorded };
}

function makeSapoWorkspace(withBinding = true) {
  const root = makeThemeWorkspace();
  if (withBinding) {
    fs.writeFileSync(path.join(root, ".sapo-cli_local.json"), JSON.stringify({ store_prefix: "seafoods", theme_id: Number(SAPO_BOUND), theme_name: "Stub" }));
  }
  return root;
}

for (const [label, stubOptions, withBinding, expectedCode] of [
  ["a draft theme", {}, true, null],
  ["the live theme", { role: "main" }, true, "REFUSED_THEME_PUSH_LIVE"],
  ["another id", { themeId: "777" }, true, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["an unconfigured project", { ok: false }, true, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["an expired login", { exitCode: 1, ok: false }, true, "REFUSED_THEME_PUSH_UNVERIFIED"],
  ["no binding in the folder", {}, false, "REFUSED_THEME_PUSH_UNVERIFIED"],
]) {
  test(`a Sapo push is cleared by sapo info -j in the bound folder: ${label}`, async () => {
    const root = makeSapoWorkspace(withBinding);
    const stub = installSapoStub(stubOptions);
    try {
      const outcome = await draftProbe.gateThemeLine({ text: "sapo theme push --only sections/hero.liquid", cwd: root, timeoutMs: 20_000 });
      if (expectedCode === null) {
        assert.equal(outcome.decision, "allow");
        const calls = stub.recorded();
        assert.equal(calls.length, 1, "exactly one info probe");
        assert.deepEqual(calls[0].argv, ["theme", "info", "--json"]);
        assert.equal(path.resolve(calls[0].cwd).toLowerCase(), path.resolve(root).toLowerCase());
      } else {
        assert.equal(outcome.decision, "block");
        assert.equal(outcome.code, expectedCode);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
}

test("a Sapo push to the LIVE bound theme needs --yes: without it the refusal says to add it, with it the push passes and the force flags stay refused", async () => {
  const root = makeSapoWorkspace();
  const stub = installSapoStub({ role: "main" });
  try {
    const gate = (text) => draftProbe.gateThemeLine({ text, cwd: root, timeoutMs: 20_000 });
    const bare = await gate("sapo theme push --only layout/theme.liquid");
    assert.equal(bare.code, "REFUSED_THEME_PUSH_LIVE");
    assert.ok(bare.reason.includes("Add --yes"), bare.reason);
    for (const text of ["sapo theme push --only layout/theme.liquid --yes", "sapo push --only layout/theme.liquid -y"]) {
      assert.equal((await gate(text)).decision, "allow", text);
    }
    assert.equal((await gate("sapo theme push --only layout/theme.liquid --yes --force")).code, "REFUSED_THEME_PUSH_SCOPE");
    assert.equal((await gate("sapo theme push --only layout/theme.liquid --yes=1")).code, "REFUSED_THEME_REMOTE_OP");
    assert.equal(stub.recorded().length, 3, "the three lines that reach the probe are the bare push and the two --yes pushes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("Sapo reads and fetch of the bound theme pass with no probe; a refused push never reaches the CLI", async () => {
  const root = makeSapoWorkspace();
  const stub = installSapoStub({});
  try {
    for (const text of ["sapo diff", "sapo theme list", `sapo theme fetch ${SAPO_BOUND}`, "sapo backup -n x"]) {
      assert.equal((await draftProbe.gateThemeLine({ text, cwd: root, timeoutMs: 20_000 })).decision, "allow", text);
    }
    for (const text of ["sapo theme push --only a.liquid --force", "sapo restore", "sapo diff\nsapo restore"]) {
      assert.equal((await draftProbe.gateThemeLine({ text, cwd: root, timeoutMs: 20_000 })).decision, "block", text);
    }
    assert.deepEqual(stub.recorded(), [], "no Sapo call is made by any of these");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("a worker's bash call runs the Sapo rules end to end", async () => {
  const root = makeSapoWorkspace();
  const stub = installSapoStub({});
  try {
    await asTerminal(true, async () => {
      assert.equal(await runBash(root, "sess-sapo-push", "sapo theme push --only sections/hero.liquid"), null);
      const forced = await runBash(root, "sess-sapo-force", "sapo theme push --only sections/hero.liquid --force");
      assert.equal(forced?.block, true);
      assert.ok(forced.reason.startsWith("REFUSED_THEME_PUSH_SCOPE:"), forced.reason);
      const publish = await runBash(root, "sess-sapo-publish", "sapo theme publish 1035075");
      assert.equal(publish?.block, true);
      assert.ok(publish.reason.startsWith("REFUSED_THEME_REMOTE_OP:"), publish.reason);
    });
    assert.equal(stub.recorded().length, 1, "only the cleared push is probed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

// ---- Haravan sign-in commands of a worker (hrv whoiam | refresh-all | select <org> | login --no-open) ----

/** `allow` or the refusal code for the first command of one `hrv` auth line, or a line-level refusal code. */
function planHrvAuthLine(line, opts = {}) {
  const parsed = themePolicy.classifyThemeLine(line, opts);
  if (parsed.decision === "block") return parsed.code;
  assert.equal(parsed.decision, "commands", line);
  const plans = parsed.commands.map((cmd) => themePolicy.planThemeCommand(cmd, "1001507144"));
  return plans.map((plan) => (plan.decision === "block" ? plan.code : plan.decision)).join(",");
}

for (const line of [
  "hrv whoiam",
  "haravan whoiam",
  "haravan-cli whoiam",
  "./node_modules/.bin/haravan whoiam",
  "hrv whoiam --help",
  "hrv whoiam -h",
  "hrv refresh-all",
  "hrv refresh-all --help",
  "hrv select 1000123456",
  "hrv login --no-open",
  "hrv login --help",
  "hrv logout --help",
]) {
  test(`a worker may run '${line}'`, () => {
    assert.equal(planHrvAuthLine(line), "allow");
  });
}

for (const [label, line, code] of [
  ["an unknown option", "hrv whoiam --json", "REFUSED_THEME_REMOTE_OP"],
  ["an argument", "hrv whoiam extra", "REFUSED_THEME_REMOTE_OP"],
  ["--force", "hrv refresh-all --force", "REFUSED_THEME_REMOTE_OP"],
  ["-f", "hrv refresh-all -f", "REFUSED_THEME_REMOTE_OP"],
  ["another option", "hrv refresh-all --foo", "REFUSED_THEME_REMOTE_OP"],
  ["select with no org (the interactive menu)", "hrv select", "REFUSED_THEME_REMOTE_OP"],
  ["select with a name", "hrv select abc", "REFUSED_THEME_REMOTE_OP"],
  ["select with two ids", "hrv select 1 2", "REFUSED_THEME_REMOTE_OP"],
  ["select with an option", "hrv select 12 --foo", "REFUSED_THEME_REMOTE_OP"],
  ["a bare login (opens a browser)", "hrv login", "REFUSED_THEME_REMOTE_OP"],
  ["login with --print-url", "hrv login --no-open --print-url", "REFUSED_THEME_REMOTE_OP"],
  ["login with --print-url alone", "hrv login --print-url", "REFUSED_THEME_REMOTE_OP"],
  ["login with -t", "hrv login -t abc", "REFUSED_THEME_REMOTE_OP"],
  ["login with --token", "hrv login --token abc", "REFUSED_THEME_REMOTE_OP"],
  ["login with a positional", "hrv login --no-open extra", "REFUSED_THEME_REMOTE_OP"],
  ["a logout", "hrv logout", "REFUSED_THEME_REMOTE_OP"],
  ["a logout of one org", "hrv logout 1000123", "REFUSED_THEME_REMOTE_OP"],
  ["an option in front of the command", "hrv -x whoiam", "REFUSED_THEME_REMOTE_OP"],
  ["an option with a value in front of the command", "hrv -t 5 login --no-open", "REFUSED_THEME_COMPLEX"],
  ["a command chained after another", "hrv whoiam && hrv theme info -j", "REFUSED_THEME_REMOTE_OP,allow"],
  ["a command chained before another", "ls && hrv login --no-open", "REFUSED_THEME_REMOTE_OP"],
  ["a pipe", "hrv whoiam | head", "REFUSED_THEME_REMOTE_OP"],
  ["a redirect to a file", "hrv whoiam > out.txt", "REFUSED_THEME_REMOTE_OP"],
  ["a 2>&1 redirect", "hrv whoiam 2>&1", "REFUSED_THEME_REMOTE_OP"],
  ["a cd before it", "cd ../other && hrv whoiam", "REFUSED_THEME_REMOTE_OP"],
  ["a logout on the next line", "hrv whoiam\nhrv logout", "REFUSED_THEME_REMOTE_OP,REFUSED_THEME_REMOTE_OP"],
  ["a bash -c wrapper", 'bash -c "hrv whoiam"', "REFUSED_THEME_COMPLEX"],
  ["a cmd /c wrapper", "cmd /c hrv whoiam", "REFUSED_THEME_COMPLEX"],
  ["npx", "npx hrv login --no-open", "REFUSED_THEME_COMPLEX"],
  ["a subshell", "(hrv whoiam)", "REFUSED_THEME_COMPLEX"],
  ["a command substitution", "$(hrv whoiam)", "REFUSED_THEME_COMPLEX"],
  ["a quote-split CLI word", 'h""rv whoiam', "REFUSED_THEME_COMPLEX"],
  ["a line continuation", "hrv login \\\n --no-open", "REFUSED_THEME_COMPLEX"],
]) {
  test(`a worker's Haravan sign-in line with ${label} is refused`, () => {
    assert.equal(planHrvAuthLine(line), code, line);
  });
}

test("a Haravan sign-in refusal names the Leader-approved rule, and a cd carried over from an earlier line refuses too", () => {
  const refused = themePolicy.planThemeCommand(themePolicy.parseThemeCommands("hrv logout")[0], null);
  assert.equal(refused.decision, "block");
  assert.match(refused.reason, /Đăng nhập Haravan do Leader duyệt/);
  assert.match(refused.reason, /AGENTS\.md §8/);
  assert.equal(planHrvAuthLine("hrv whoiam", { assumeDirChanged: true }), "REFUSED_THEME_REMOTE_OP");
});

test("Haravan sign-in words in a folder name, a search pattern or another command's argument are not the CLI", () => {
  for (const line of [
    "rg whoiam src/",
    "rg -n select src/",
    "cd E:/Work/themes/Haravan && ls select",
    "dir E:/Work/themes/Haravan login",
    "cat hrv-login.txt",
    "cat hrv.liquid whoiam",
    "git commit -F msg.txt",
    "hrv info",
    "hrv doctor",
  ]) {
    assert.equal(themePolicy.classifyThemeLine(line).decision, "none", line);
  }
});

test("the sign-in rules leave every theme, api and Sapo verdict as it was", () => {
  const BOUND = "1001507144";
  const verdictOf = (line) => {
    const parsed = themePolicy.classifyThemeLine(line);
    if (parsed.decision === "block") return parsed.code;
    const plan = themePolicy.planThemeCommand(parsed.commands[0], parsed.commands[0].cli === "sapo" ? "1035075" : BOUND);
    return plan.decision === "block" ? plan.code : plan.decision;
  };
  for (const [line, verdict] of [
    ["hrv theme push --only x --nodelete", "verify-draft"],
    ["hrv theme push --only x", "REFUSED_THEME_PUSH_NODELETE"],
    ["hrv theme dev", "verify-draft"],
    ["hrv theme info -j", "allow"],
    ["hrv theme list", "allow"],
    ["hrv theme publish 1", "REFUSED_THEME_REMOTE_OP"],
    ["sapo theme push --only x", "verify-sapo-bound"],
    ["sapo whoiam", "allow"],
    ["sapo logout", "REFUSED_THEME_REMOTE_OP"],
    ["hrv api put /web/themes/1.json", "REFUSED_THEME_REMOTE_OP"],
    ["hrv rollback-last-push", "REFUSED_THEME_REMOTE_OP"],
    ["bizweb theme list", "REFUSED_THEME_REMOTE_OP"],
    ["shopify theme publish 1", "REFUSED_THEME_REMOTE_OP"],
  ]) {
    assert.equal(verdictOf(line), verdict, line);
  }
});

test("the auth:false view (what a Leader's guard uses) does not see sign-in commands at all", () => {
  for (const line of ["hrv whoiam", "hrv logout", "hrv select", "hrv login -t x", "bash -c \"hrv login\""]) {
    assert.equal(themePolicy.mentionsThemeCli(line), true, line);
    assert.equal(themePolicy.mentionsThemeCli(line, { auth: false }), false, line);
    assert.deepEqual(themePolicy.classifyThemeLine(line, { auth: false }), { decision: "none" }, line);
  }
  assert.deepEqual(
    themePolicy.parseThemeCommands("hrv whoiam; hrv theme info -j", { auth: false }).map((cmd) => cmd.action),
    ["info"],
  );
});

test("a worker's bash and terminal.write paths gate Haravan sign-in with no CLI call", async () => {
  const root = makeThemeWorkspace();
  try {
    for (const text of ["hrv whoiam", "hrv refresh-all", "hrv select 1000123", "hrv login --no-open"]) {
      assert.deepEqual(await draftProbe.gateThemeLine({ text, cwd: root, timeoutMs: 20_000 }), { decision: "allow", verified: [] }, text);
    }
    const refused = await draftProbe.gateThemeLine({ text: "hrv logout", cwd: root, timeoutMs: 20_000 });
    assert.equal(refused.code, "REFUSED_THEME_REMOTE_OP");
    assert.equal(refused.command, "hrv logout");
    await asTerminal(true, async () => {
      assert.equal(await runBash(root, "sess-auth-ok", "hrv whoiam"), null);
      assert.equal(await runBash(root, "sess-auth-login", "hrv login --no-open"), null);
      const logout = await runBash(root, "sess-auth-logout", "hrv logout");
      assert.equal(logout?.block, true);
      assert.ok(logout.reason.startsWith("REFUSED_THEME_REMOTE_OP:"), logout.reason);
      const token = await runBash(root, "sess-auth-token", "hrv login -t abc");
      assert.equal(token?.block, true);
    });
    await asTerminal(false, async () => {
      assert.equal(await runBash(root, "sess-auth-user", "hrv logout"), null, "a session that is not a worker is not gated");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Shell escapes that make the analyzer read other words than the shell runs ----

for (const [label, line] of [
  ["a backslash before the action", "hrv \\logout"],
  ["a backslash inside the action", "hrv l\\ogout"],
  ["a backslash-newline inside the action", "hrv log\\\nout"],
  ["a backslash-newline before the action", "hrv \\\nlogout"],
  ["a trailing backslash", "hrv logout\\"],
  ["a backslash-newline after the action", "hrv theme publish\\\n 1"],
  ["a backslash-CRLF after the action", "hrv theme publish\\\r\n 1"],
  ["a backslash inside theme", "hrv th\\eme publish 1"],
  ["a backslash before theme", "hrv \\theme publish 1"],
  ["a backslash inside the CLI word", "h\\rv theme publish 1"],
  ["a backslash-newline before api put", "hrv api \\\nput x"],
  ["a backslash inside api put", "hrv api p\\ut x"],
  ["a backslash-newline before a flag", "hrv login --no-open \\\n--force"],
  ["a backslash before a flag", "hrv login --no-open \\--force"],
  ["a backslash before --force on a push", "hrv theme push --only a.liquid --nodelete \\--force"],
  ["a backslash-newline after whoiam", "hrv whoiam\\\n"],
  ["a backslash inside a push action", "hrv theme pu\\sh --only a.liquid"],
  ["a backslash before sapo logout", "sapo \\logout"],
  ["a backslash inside sapo login", "sapo l\\ogin --oauth -s x"],
  ["a backslash inside a sapo push", "sapo theme pu\\sh --only a.liquid"],
  ["a backslash inside shopify theme", "shopify th\\eme push --live"],
  ["a backslash-newline in a shopify push", "shopify theme push\\\n --live"],
  ["a quote inside the action", 'hrv lo""gout'],
  ["a quoted action", 'hrv "logout"'],
  ["a caret inside the action", "hrv lo^gout"],
]) {
  test(`a worker's line with ${label} is refused`, () => {
    const refusal = planHrvAuthLine(line);
    assert.match(refusal, /^REFUSED_THEME_(?:COMPLEX|REMOTE_OP|PUSH_\w+)(?:,.*)?$/, JSON.stringify(line));
  });
}

for (const [label, line] of [
  ["a backslash before the action", "hrv \\logout"],
  ["a backslash inside the action", "hrv l\\ogout"],
  ["a backslash-newline inside the action", "hrv log\\\nout"],
  ["a backslash inside theme", "hrv th\\eme publish 1"],
  ["a backslash-newline before api put", "hrv api \\\nput x"],
  ["a backslash before --force", "hrv theme push --only a.liquid --nodelete \\--force"],
  ["a backslash inside a sapo login", "sapo l\\ogin --oauth -s x"],
  ["a backslash inside shopify theme", "shopify th\\eme push --live"],
]) {
  test(`the escape rule refuses ${label} as a shape it cannot read`, () => {
    const parsed = themePolicy.classifyThemeLine(line);
    assert.equal(parsed.decision, "block", JSON.stringify(line));
    assert.equal(parsed.code, "REFUSED_THEME_COMPLEX", JSON.stringify(line));
    assert.equal(themePolicy.mentionsThemeCli(line), true, JSON.stringify(line));
  });
}

test("a backslash that only separates a path leaves the sign-in and theme verdicts alone", () => {
  assert.equal(planHrvAuthLine("C:\\Users\\Admin\\AppData\\Roaming\\npm\\hrv.cmd login --no-open"), "allow");
  assert.equal(planHrvAuthLine("C:\\Users\\Admin\\AppData\\Roaming\\npm\\hrv.cmd whoiam"), "allow");
  assert.equal(planHrvAuthLine("hrv theme push --only layout\\theme.liquid --nodelete"), "verify-draft");
  assert.equal(planHrvAuthLine("hrv theme fetch 1001 --only config\\settings_schema.json"), "allow");
  assert.equal(planHrvAuthLine("hrv theme info --json"), "allow");
  assert.equal(themePolicy.classifyThemeLine("cd E:\\Work\\themes\\Haravan && rg theme.liquid layout\\").decision, "none");
});

test("a worker's bash call is refused for an escaped sign-in or theme command", async () => {
  const root = makeThemeWorkspace();
  try {
    await asTerminal(true, async () => {
      for (const [id, command] of [
        ["esc-logout", "hrv l\\ogout"],
        ["esc-newline", "hrv \\\nlogout"],
        ["esc-publish", "hrv th\\eme publish 1"],
      ]) {
        const refused = await runBash(root, `sess-${id}`, command);
        assert.equal(refused?.block, true, command);
        assert.ok(refused.reason.startsWith("REFUSED_THEME_COMPLEX:"), refused.reason);
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Words the shell assembles from quotes, expansions, globs and braces ----

/** Forms the round-1 backslash rule let through: the shell runs a refused command, the raw text shows none. */
const ASSEMBLED_FORMS = [
  ["an empty command substitution inside the action", "hrv l$(:)ogout"],
  ["an empty backtick substitution inside the action", "hrv l`:`ogout"],
  ["an unset variable inside the action", "hrv l${z}ogout"],
  ["an empty default expansion inside the action", "hrv l${z:-}ogout"],
  ["an empty brace list inside the action", "hrv l{,}ogout"],
  ["a glob star after the action letters", "hrv lo*"],
  ["a glob question mark in the action", "hrv logou?"],
  ["a bracket class in the action", "hrv [l]ogout"],
  ["a home tilde before the action", "hrv ~/logout"],
  ["an empty substitution inside theme", "hrv th$(:)eme publish 1"],
  ["an empty substitution inside the CLI word", "h$(:)rv theme publish 1"],
  ["an empty substitution inside the CLI word of a logout", "h$(:)rv logout"],
  ["a default expansion as the CLI word", "${X:-hrv} logout"],
  ["$0 as the CLI word", "$0 logout"],
  ["a variable that holds part of the CLI word", "z=r; h${z}v logout"],
  ["a variable as the command after an assignment", "FOO=1 $X logout"],
  ["an ANSI-C quoted flag on a push", "hrv theme push --only a.liquid --nodelete --$'force'"],
  ["a variable flag on a push", "hrv theme push --only a.liquid --nodelete $F"],
  ["an ANSI-C quoted api verb", "hrv api $'put' x"],
  ["an ANSI-C quoted value of an api flag", "hrv api get x --method $'DELETE'"],
  ["a glob after an assignment prefix", "FOO=1 hrv l*"],
  ["$IFS as the blank", "hrv$IFS logout"],
  ["${IFS} as the blank", "hrv${IFS}logout"],
  ["$IFS$9 as the blank", "hrv$IFS$9logout"],
  ["a brace list as the whole command", "{hrv,logout}"],
  ["a glob in the command path", "/usr/bin/h?v logout"],
  ["a variable path with a glob command", "$HOME/bin/h?v logout"],
  ["xargs handed the bare CLI", "echo logout | xargs hrv"],
  ["the bare CLI as a pipe target", "printf logout | hrv"],
  ["an escaped CLI word inside a double-quoted sh -c", 'sh -c "h\\\\rv logout"'],
  ["an empty substitution inside a single-quoted bash -c", "bash -c 'h$(:)rv logout'"],
  ["$IFS inside a single-quoted sh -c", "sh -c 'hrv$IFS logout'"],
  ["an empty substitution inside the Sapo word", "s$(:)apo logout"],
  ["an empty substitution inside the Shopify word", "sho$(:)pify theme push --live"],
  ["an empty substitution inside the Sapo action", "sapo l$(:)ogout"],
];

/** Other spellings of the same refusals: already refused before the fold, kept so a later change cannot lose them. */
const ASSEMBLED_FORMS_REFUSED_BEFORE = [
  ["ANSI-C hex before the action", "hrv $'\\x6c'ogout"],
  ["ANSI-C hex inside the action", "hrv $'l\\x6fgout'"],
  ["a single-quoted first letter", "hrv 'l'ogout"],
  ["empty single quotes inside the action", "hrv l''ogout"],
  ["a double-quoted first letter", 'hrv "l"ogout'],
  ["empty double quotes inside the action", 'hrv l""ogout'],
  ["a $\"...\" action", 'hrv $"logout"'],
  ["a brace list as the action", "hrv {logout,x}"],
  ["a pu$(:)blish action", "hrv theme pu$(:)blish 1"],
  ["an ANSI-C quoted theme word", "hrv $'theme' publish 1"],
  ["$IFS after an api verb", "hrv api put$IFS x"],
  ["an ANSI-C quoted CLI word", "$'h'rv logout"],
  ["a double-quoted CLI prefix", '"hr"v logout'],
  ["an alias for the CLI", "alias h=hrv; h logout"],
  ["an ANSI-C quoted flag on a refresh", "hrv login --no-open --$'force'"],
  ["a command substitution inside a flag", "hrv refresh-all --for$(:)ce"],
  ["an ANSI-C quoted short flag", "hrv login -$'t' x"],
  ["a command substitution before --force", "hrv theme push --only a.liquid --nodelete $(:)--force"],
  ["a variable word", "x=logout; hrv $x"],
  ["a braced variable word", "hrv ${x}"],
  ["an eval of split quotes", 'eval "hrv lo""gout"'],
  ["a command substitution word", "hrv $(echo logout)"],
  ["a backtick word", "hrv `echo logout`"],
  ["bash -c", "bash -c 'hrv logout'"],
  ["env", "env hrv logout"],
  ["command", "command hrv logout"],
  ["exec", "exec hrv logout"],
  ["nohup", "nohup hrv logout"],
  ["time", "time hrv logout"],
  ["a subshell", "(hrv logout)"],
  ["a brace group", "{ hrv logout; }"],
  ["a background job", "hrv logout &"],
  ["a here-string", 'bash <<< "hrv logout"'],
  ["a heredoc", "bash <<EOF\nhrv logout\nEOF"],
  ["an escaped here-string", 'bash <<< "hrv l\\ogout"'],
  ["a PowerShell string", 'hrv ("log"+"out")'],
  ["a PowerShell array", "hrv @('logout')"],
  ["Start-Process", "Start-Process hrv -ArgumentList logout"],
  ["cmd.exe carets", "hrv ^l^o^g^o^u^t"],
  ["a trailing backtick", "hrv `logout"],
];

for (const [label, line] of ASSEMBLED_FORMS) {
  test(`a worker's line with ${label} is refused as a shape it cannot read`, () => {
    const parsed = themePolicy.classifyThemeLine(line);
    assert.equal(parsed.decision, "block", JSON.stringify(line));
    assert.equal(parsed.code, "REFUSED_THEME_COMPLEX", JSON.stringify(line));
    assert.equal(themePolicy.mentionsThemeCli(line), true, JSON.stringify(line));
  });
}

test("the Leader's own view (no sign-in rule) refuses an assembled theme command and still reads plain ones", () => {
  for (const line of ["hrv th$(:)eme publish 1", "h$(:)rv theme publish 1", "hrv theme push --only a.liquid --nodelete --$'force'", "hrv lo*"]) {
    assert.equal(themePolicy.classifyThemeLine(line, { auth: false }).code, "REFUSED_THEME_COMPLEX", line);
  }
  for (const line of ["hrv theme info --json", "hrv theme info -j", "sapo theme info --json", "shopify theme list --json", "hrv login --no-open", "hrv logout"]) {
    const plan = themePolicy.classifyThemeLine(line, { auth: false });
    assert.notEqual(plan.code, "REFUSED_THEME_COMPLEX", line);
  }
});

for (const [label, line] of ASSEMBLED_FORMS_REFUSED_BEFORE) {
  test(`a worker's line with ${label} stays refused`, () => {
    const refusal = planHrvAuthLine(line);
    assert.match(refusal, /^REFUSED_THEME_(?:COMPLEX|REMOTE_OP|PUSH_\w+)(?:,.*)?$/, JSON.stringify(line));
  });
}

test("the fold sees what the shell assembles and leaves path quoting, globs in values and plain reads alone", () => {
  const allowed = [
    "hrv theme info --json",
    "hrv theme info -j",
    "hrv theme --help",
    "hrv theme push --only layout/theme.liquid --nodelete",
    "hrv theme push --only layout\\theme.liquid --nodelete",
    "hrv theme push --only layout/*.liquid --nodelete",
    "hrv theme push --only=layout/*.liquid --nodelete",
    'hrv theme push --only "layout/theme.liquid" --nodelete',
    "hrv theme push --only='layout/theme.liquid' --nodelete",
    'hrv theme push --only "sections/a b.liquid" --nodelete',
    'hrv theme fetch 1001 --only "config/*.json"',
    "hrv theme push --only layout/*.liquid sections/*.liquid --nodelete",
    "hrv theme push --nodelete --ignore config/settings_data.json",
    "hrv theme fetch 1001 --only config/settings_data.json",
    "hrv theme fetch 1001 --only config\\settings_schema.json",
    "hrv theme dev",
    "hrv whoiam",
    "hrv refresh-all",
    "hrv select 200001229247",
    'hrv select "200001229247"',
    "hrv login --no-open",
    "hrv api get /web/themes.json",
    'hrv api get "/web/themes.json?limit=5"',
    "hrv --version",
    "C:\\Users\\Admin\\AppData\\Roaming\\npm\\hrv.cmd login --no-open",
    "C:\\Users\\Admin\\AppData\\Roaming\\npm\\hrv.cmd theme info --json",
    "./node_modules/.bin/haravan theme info -j",
    "sapo theme info --json",
    "sapo whoiam",
    "shopify theme list --json",
    "hrv theme info --json | jq .role",
    "hrv theme info --json && echo done",
  ];
  for (const line of allowed) {
    const parsed = themePolicy.classifyThemeLine(line);
    assert.equal(parsed.decision === "block" && /COMPLEX/.test(parsed.code), false, `${JSON.stringify(line)} must not become COMPLEX`);
  }
  for (const line of ["hrv theme info --json", "hrv whoiam", "hrv theme fetch 1001 --only config/settings_data.json", "hrv login --no-open"]) {
    assert.equal(planHrvAuthLine(line), "allow", line);
  }
  assert.equal(planHrvAuthLine("hrv theme push --only layout/*.liquid --nodelete"), "verify-draft");
  assert.equal(planHrvAuthLine('hrv theme push --only "layout/theme.liquid" --nodelete'), "verify-draft");
  assert.equal(planHrvAuthLine("hrv theme push --only='layout/theme.liquid' --nodelete"), "verify-draft");
});

test("lines that are not the theme CLI keep quotes, expansions, globs and backslashes", () => {
  for (const line of [
    "rg -n select src/",
    "rg -n logout src/ docs/",
    "rg -n 'select|logout' src/ --glob '*.ts'",
    "rg -n hrv src/",
    "git add layout\\theme.liquid",
    "git add layout/theme.liquid && git status",
    "git commit -F msg.txt",
    "git push origin main",
    "echo $HOME",
    'echo "$HOME/x"',
    'cd "E:/Work/customizes/Districtfour"',
    'cd "E:/Work/customizes/Districtfour" && rg -n price sections/',
    "cd E:\\Work\\themes\\Haravan && rg theme.liquid layout\\",
    "ls ~/",
    "cat 'a b.txt'",
    "node scripts/x.mjs --flag=$X",
    "npm run dev",
    '"$BUN" run dev',
    "$HOME/.bun/bin/bun test",
    "for f in layout/*.liquid; do echo $f; done",
    "echo ${HOME:-x} | rg x",
    "ls hrv.liquid",
    "cat docs/hrv-notes.md",
    "node --test test/unit/edit-guard.test.mjs",
    "sed -n '1,5p' layout/theme.liquid",
    "python -c \"print('hi')\"",
    "echo select",
    "echo logout > notes.txt",
    'grep -rn "theme" layout/',
  ]) {
    assert.equal(themePolicy.classifyThemeLine(line).decision, "none", line);
    assert.equal(themePolicy.mentionsThemeCli(line), false, line);
  }
});

/** Lines whose whole point is to be refused at every door: the bash hook, the Manager's terminal.write and an eval cell. */
const DOOR_FORMS = [
  "hrv l$(:)ogout",
  "hrv lo*",
  "hrv th$(:)eme publish 1",
  "h$(:)rv theme publish 1",
  "${X:-hrv} logout",
  "$0 logout",
  "hrv theme push --only a.liquid --nodelete --$'force'",
  "hrv${IFS}logout",
  "echo logout | xargs hrv",
  "printf logout | hrv",
  'sh -c "h\\\\rv logout"',
  "s$(:)apo logout",
];

test("a worker's bash call is refused for every assembled form", async () => {
  const root = makeThemeWorkspace();
  try {
    await asTerminal(true, async () => {
      let n = 0;
      for (const command of DOOR_FORMS) {
        n += 1;
        const refused = await runBash(root, `sess-asm-${n}`, command);
        assert.equal(refused?.block, true, command);
        assert.ok(refused.reason.startsWith("REFUSED_THEME_COMPLEX:"), `${command}: ${refused.reason}`);
      }
      for (const command of ["echo $HOME", "rg -n select src/", 'cd "E:/Work/customizes/Districtfour"', "git add layout\\theme.liquid"]) {
        n += 1;
        assert.equal(await runBash(root, `sess-asm-${n}`, command), null, command);
      }
    });
    await asTerminal(false, async () => {
      assert.equal(await runBash(root, "sess-asm-user", "hrv l$(:)ogout"), null, "a session that is not a worker is not gated");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the terminal.write gate refuses every assembled form and lets plain lines pass", async () => {
  const root = makeThemeWorkspace();
  try {
    for (const text of DOOR_FORMS) {
      const outcome = await draftProbe.gateThemeLine({ text, cwd: root, timeoutMs: 20_000 });
      assert.equal(outcome.decision, "block", text);
      assert.equal(outcome.code, "REFUSED_THEME_COMPLEX", text);
    }
    for (const text of ["echo $HOME", "rg -n select src/", 'cd "E:/Work/customizes/Districtfour"']) {
      assert.deepEqual(await draftProbe.gateThemeLine({ text, cwd: root, timeoutMs: 20_000 }), { decision: "pass" }, text);
    }
    assert.deepEqual(await draftProbe.gateThemeLine({ text: "hrv theme info --json", cwd: root, timeoutMs: 20_000 }), { decision: "allow", verified: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an eval cell that starts a process is refused when the shell string assembles the CLI word", () => {
  for (const shellLine of ["h$(:)rv theme publish 1", "h$(:)rv logout", "s$(:)apo logout", "sho$(:)pify theme push --live", "$'h'rv logout", "h${z}rv logout", "h$9rv logout", "h\\rv theme publish 1", "hrv l\\ogout"]) {
    for (const cell of [
      `import subprocess\nsubprocess.run("${shellLine}", shell=True)`,
      `import os\nos.system("${shellLine}")`,
    ]) {
      const plan = themePolicy.planEvalThemeCode(cell);
      assert.equal(plan.decision, "block", cell);
      assert.equal(plan.code, "REFUSED_THEME_VIA_EVAL", cell);
    }
  }
  for (const cell of [
    'import subprocess\nsubprocess.run("echo $HOME", shell=True)',
    'import os\nos.system("rg -n select src/")',
    'import subprocess\nsubprocess.run(["node", "scripts/x.mjs", "--flag=$X"])',
    'import subprocess\nsubprocess.run(["git", "push", "origin", "main"])',
    'import os\nos.system("$HOME/.bun/bin/bun test")',
  ]) {
    assert.equal(themePolicy.planEvalThemeCode(cell).decision, "allow", cell);
  }
});

test("an eval cell is refused for every assembled form however the string is wrapped (call, r-triple-quote, argument list)", () => {
  const forms = [
    "h\\rv theme publish 1",
    "hrv l\\ogout",
    "${X:-hrv} logout",
    "$0 logout",
    "h$(:)rv logout",
    "s$(:)apo logout",
    "z=r; h${z}v logout",
    "/usr/bin/h?v logout",
    "$HOME/bin/h?v logout",
    "FOO=1 $X logout",
    "hrv lo*",
  ];
  for (const form of forms) {
    for (const cell of [`import os\nos.system(r"""${form}""")`, `import os\nos.system('''${form}''')`, `import subprocess\nsubprocess.run(r'${form}', shell=True)`]) {
      const plan = themePolicy.planEvalThemeCode(cell);
      assert.equal(plan.decision, "block", cell);
      assert.equal(plan.code, "REFUSED_THEME_VIA_EVAL", cell);
    }
  }
  for (const argv of ['["h$(:)rv", "logout"]', '["hrv", "l*"]', '["$X", "logout"]']) {
    const plan = themePolicy.planEvalThemeCode(`import subprocess\nsubprocess.run(${argv})`);
    assert.equal(plan.decision, "block", argv);
  }
  for (const cell of [
    'import os\nos.system(r"""echo $HOME""")',
    "import os\nos.system('''rg -n select src/''')",
    'import subprocess\nsubprocess.run(["rg", "-n", "logout", "src/"])',
    'import subprocess\nsubprocess.run(["git", "add", "layout\\\\theme.liquid"])',
  ]) {
    assert.equal(themePolicy.planEvalThemeCode(cell).decision, "allow", cell);
  }
});

// KNOWN LIMITS: these lines run a refused command (or may) and the line-level rules still pass them,
// because the command is assembled outside the text the gate reads. The tests pin today's behaviour so
// the limit is visible; they are not a claim that the lines are safe.
test("KNOWN LIMIT: a command built outside the line (script file, symlink, string built in code) is not seen", () => {
  for (const line of [
    "./wrap.sh logout",
    "bash go.sh",
    "ln -s $(which hrv) /tmp/x; /tmp/x logout",
    "python -c \"import os; os.system('h'+'rv logout')\"",
    "node -e \"require('child_process').execSync(['h','rv'].join('') + ' logout')\"",
    "$X lo*",
  ]) {
    assert.equal(themePolicy.classifyThemeLine(line).decision, "none", `${line}: documented limit`);
  }
});

test("the fold evaluates quoting and empty expansions only: a value the line does not state stays an expansion", () => {
  // `$X` may hold anything, so an expansion in the CLI's own words is refused instead of guessed at.
  assert.equal(themePolicy.classifyThemeLine("x=logout; hrv $x").code, "REFUSED_THEME_COMPLEX");
  assert.equal(themePolicy.classifyThemeLine("hrv theme push --only layout/theme.liquid --nodelete $F").code, "REFUSED_THEME_COMPLEX");
  // an expansion in a plain argument of a command that is not the CLI is not the gate's business
  assert.equal(themePolicy.classifyThemeLine('git commit -m "$MSG"').decision, "none");
});

// ---------------------------------------------------------------------------
// Data-only arguments and the command position of an eval cell
// ---------------------------------------------------------------------------

const POLICY_FIXTURES = path.join(REPO, "test", "fixtures", "theme-policy");
const readCorpus = (name) => JSON.parse(fs.readFileSync(path.join(POLICY_FIXTURES, name), "utf8")).entries;
/** A shell line as an eval cell holds it: the text of a process-starting string. */
const wrapAsCell = (line) => `import os\nos.system(r"""\n${line}\n""")`;

/** The first refusal a line meets when it is classified and its commands are planned; `pass` when it names no theme CLI. */
function lineVerdict(text, opts = {}) {
  const plan = themePolicy.classifyThemeLine(text, opts);
  if (plan.decision === "none") return "pass";
  if (plan.decision === "block") return plan.code;
  return plan.commands.map((cmd) => themePolicy.planThemeCommand(cmd, "1001507144")).find((one) => one.decision === "block")?.code ?? "allow";
}

/** Judges one corpus entry at the doors the hooks use; returns a list of failures. */
async function judgeCorpusEntry(entry, root, n) {
  const failures = [];
  if (entry.kind === "cell") {
    const verdict = themePolicy.planEvalThemeCode(entry.text);
    const want = entry.expect === "allow" ? "allow" : "block";
    if (verdict.decision !== want) failures.push(`eval door: ${verdict.decision}, want ${want}`);
    return failures;
  }
  const opts = entry.auth === false ? { auth: false } : {};
  const want = entry.expect;
  const viaClassify = lineVerdict(entry.text, opts);
  if (viaClassify !== want) failures.push(`classifyThemeLine: ${viaClassify}, want ${want}`);
  if (entry.auth !== false) {
    // bash door: the worker's hook; terminal door: the input gate.
    await asTerminal(true, async () => {
      const refused = await runBash(root, `sess-corpus-${n}`, entry.text);
      if (want === "pass") {
        if (refused !== null) failures.push(`bash door refused: ${refused.reason.slice(0, 60)}`);
      } else if (refused?.block !== true || !refused.reason.startsWith(`${want}:`)) {
        failures.push(`bash door: ${refused?.reason?.slice(0, 60) ?? "passed"}, want ${want}`);
      }
    });
    const gate = await draftProbe.gateThemeLine({ text: entry.text, cwd: root, timeoutMs: 20_000 });
    if (want === "pass") {
      if (gate.decision !== "pass") failures.push(`terminal door: ${gate.decision}, want pass`);
    } else if (gate.decision !== "block" || gate.code !== want) {
      failures.push(`terminal door: ${gate.decision} ${gate.code ?? ""}, want ${want}`);
    }
  }
  const evalVerdict = themePolicy.planEvalThemeCode(wrapAsCell(entry.text));
  const wantEval = want === "pass" ? "allow" : "block";
  if (evalVerdict.decision !== wantEval) failures.push(`eval door: ${evalVerdict.decision}, want ${wantEval}`);
  return failures;
}

test("real refused shapes: data-only searches pass at every door, code and chained commands keep their refusal", async () => {
  const root = makeThemeWorkspace();
  try {
    const entries = readCorpus("refusal-shapes.json");
    assert.ok(entries.length >= 30, "the corpus keeps one entry per distinct shape");
    const failed = [];
    let n = 0;
    for (const entry of entries) {
      n += 1;
      const failures = await judgeCorpusEntry(entry, root, n);
      if (failures.length > 0) failed.push(`${entry.id}: ${failures.join("; ")}`);
    }
    assert.deepEqual(failed, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("adversarial look-alikes of a data-only segment or a harmless cell stay refused at every door", async () => {
  const root = makeThemeWorkspace();
  try {
    const entries = readCorpus("adversarial-shapes.json");
    const failed = [];
    let n = 1000;
    for (const entry of entries) {
      n += 1;
      const failures = await judgeCorpusEntry(entry.kind === "cell" ? { ...entry, expect: "block" } : entry, root, n);
      if (failures.length > 0) failed.push(`${entry.id}: ${failures.join("; ")}`);
    }
    assert.deepEqual(failed, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a data-only segment needs a listed program, only allow-listed flags and nothing that expands, groups or redirects", () => {
  const pass = [
    'rg -n "hrv theme" src/',
    'rg -uu -g "!node_modules" --hidden -F "hrv theme push" .',
    "rg --glob=*.ts -A3 -B 2 --max-count 5 -- 'hrv theme' src",
    'grep -rniE "sapo|theme" docs/ 2>/dev/null',
    'rg.exe -il "hrv theme" . >/dev/null 2>&1',
    'ls -la "C:/work/Haravan" | head -n 5',
    'tail -50 notes.txt | rg "hrv theme"',
    'rg "hrv theme" f | sort -u | uniq -c | wc -l | cut -d: -f1',
    'NO_COLOR=1 rg "hrv theme" f',
    'gh issue comment 5 --repo o/r --body "do not run hrv theme push" --label x',
    'gh pr view 5 --repo o/r --json title --limit 3',
    'rg "a (group) {x} < > ;" f',
  ];
  for (const line of pass) assert.equal(themePolicy.classifyThemeLine(line).decision, "none", line);
  const judgedInFull = [
    'rg -z "hrv theme" f',
    'rg --search-zip "hrv theme" f',
    'rg --pre-glob "*.x" "hrv theme" f',
    'rg --hostname-bin x "hrv theme" f',
    'rg -f pats "hrv theme" f',
    'rg --files-with-match-x "hrv theme" f',
    'grep -f pats "hrv theme" f',
    'rg "hrv theme" f > out.txt',
    'rg "hrv theme" f 2> err.txt',
    'rg "hrv theme" < in.txt',
    'rg "hrv theme" f $X',
    'rg "hrv theme" "$X"',
    'rg "hrv theme" (x)',
    'rg "hrv theme" {a,b}',
    'rg "hrv theme" f # note',
    'RIPGREP_CONFIG_PATH=c.conf rg "hrv theme" f',
    'PAGER=hrv rg "hrv theme" f',
    'time rg "hrv theme" f',
    'xargs rg "hrv theme"',
    'rg "hrv theme f',
    "sort -o out.txt \"hrv theme\"",
    'sort --compress-program hrv "hrv theme"',
    'gh issue transfer 5 o/r "hrv theme"',
    'gh issue create --web --title "hrv theme"',
    'gh issue create --title "hrv theme" -R o/r',
    'gh pr merge 5 --body "hrv theme"',
    'gh alias set x "hrv theme push"',
    'rg "hrv theme" f \\\n',
  ];
  for (const line of judgedInFull) assert.notEqual(themePolicy.classifyThemeLine(line).decision, "none", line);
});

test("an assignment of a directory named after the CLI is not an alias of it; an assignment of its binary is", () => {
  assert.equal(themePolicy.classifyThemeLine("RW=/var/www/haravan; ls $RW").decision, "none");
  assert.equal(themePolicy.classifyThemeLine("cd /var/www/haravan").decision, "none");
  for (const line of ["X=C:/Users/me/AppData/Roaming/npm/HRV", "X=/usr/local/bin/haravan", "X=hrv", "X=./node_modules/.bin/haravan"]) {
    assert.equal(themePolicy.classifyThemeLine(line).code, "REFUSED_THEME_COMPLEX", line);
  }
});

test("an eval cell is refused when a string of it runs the CLI in command position and passes when the CLI word is only text", () => {
  const blocked = [
    'import subprocess\nsubprocess.run(["hrv", "x"])',
    'import os\nos.system("hrv whoiam")',
    'import os\nos.system("cd /tmp && HRV x")',
    'import os\nos.system("FOO=1 hrv x")',
    'import os\nos.system("nohup hrv x &")',
    'import os\nos.system("xargs -n1 hrv")',
    'import subprocess\nsubprocess.run("cmd /c hrv x", shell=True)',
    'import subprocess\nsubprocess.run(["powershell", "-NoProfile", "-Command", "& C:/tools/hrv.cmd x"])',
    'import subprocess\nsubprocess.run(["ssh", "-p", "22", "root@203.0.113.10", "cd /srv && hrv x"])',
    'import subprocess\nsubprocess.run("ssh root@203.0.113.10 \\"cd /srv; haravan x\\"", shell=True)',
    'import subprocess\nsubprocess.run(["C:/Users/me/AppData/Roaming/npm/hrv", "x"])',
    'import subprocess\nsubprocess.run(["/usr/local/bin/haravan", "x"])',
    'import subprocess\nsubprocess.run(["./node_modules/.bin/shopify", "x"])',
    "const { execSync } = require('node:child_process');\nexecSync(`sapo whoiam`)",
    "!hrv whoiam",
    'import subprocess\ntask = "hrv x"\nsubprocess.run(task, shell=True)',
    'import subprocess\nsubprocess.run("rg --pre hrv x .", shell=True)',
    'import subprocess\nsubprocess.run("h\\"\\"rv x", shell=True)',
    'import subprocess\nsubprocess.run(["h$(:)rv", "x"])',
  ];
  for (const cell of blocked) {
    const plan = themePolicy.planEvalThemeCode(cell);
    assert.equal(plan.decision, "block", cell);
    assert.equal(plan.code, "REFUSED_THEME_VIA_EVAL", cell);
  }
  const allowed = [
    'import subprocess\nsubprocess.run(["git", "-C", "/var/www/haravan/Haravan-Wheel", "status"])',
    'import subprocess\nsubprocess.run(["ssh", "root@203.0.113.10", "cd /var/www/haravan && ls"])',
    'import subprocess\nsubprocess.run("ls /var/www/haravan/Sapo-Server", shell=True)',
    'import subprocess\nsubprocess.run(["curl", "-s", "https://demo.myharavan.com/x"])',
    'import subprocess\nsubprocess.run(["rg", "-n", "haravan:app:install", "dump.txt"])',
    'import subprocess\nsubprocess.run(["rg", "-n", "CF|TOKEN|HRV|SAPO", "dump.txt"])',
    'import subprocess\nsubprocess.run(["rg", "-n", "/haravan", "dump.txt"])',
    'import subprocess\nsubprocess.run(["node", "x.js"])\nprint("hrv theme push is for the user to run")',
    'import subprocess\nsubprocess.run(["node", "x.js"])\nrows.append("hrv theme push --only a.liquid")',
    "const { execSync } = require('node:child_process');\nexecSync('node x.js');\nconsole.log('run haravan theme push yourself');",
    'import subprocess\nsubprocess.run("echo started", shell=True)  # then hrv theme push by hand',
  ];
  for (const cell of allowed) assert.equal(themePolicy.planEvalThemeCode(cell).decision, "allow", cell);
  // a record or print that is also the call that starts the process is still read as a command
  assert.equal(themePolicy.planEvalThemeCode('import subprocess\nrows.append(subprocess.run("hrv theme info", shell=True))').decision, "block");
});

test("an eval cell is read as strings: a regex literal or a comment never opens a string, a URL never hides a command", () => {
  const allowed = [
    "const { execSync } = require('node:child_process');\nexecSync('node x.js');\nconst clean = out.replace(/^[ ']|[ ']$/g, '');",
    'import subprocess\nsubprocess.run(["node", "x.js"])  # don\'t run "hrv theme push" here',
    "import subprocess\nsubprocess.run('node x.js')\n# it's hrv theme push time",
  ];
  for (const cell of allowed) assert.equal(themePolicy.planEvalThemeCode(cell).decision, "allow", cell);
  const blocked = [
    'import os\nos.system("curl http://example.com/a; hrv x")',
    'import os\nos.system("echo a // b; hrv x")',
    "const { execSync } = require('node:child_process');\nexecSync(\"x\".replace(/a/, '') + 'hrv x'); execSync('hrv y')",
    'import os\nx = 1 # note\nos.system("hrv x")',
  ];
  for (const cell of blocked) assert.equal(themePolicy.planEvalThemeCode(cell).decision, "block", cell);
});

test("the test builtin `[` and `[[` is not a glob that could expand to the CLI", () => {
  assert.equal(themePolicy.classifyThemeLine('[ "$d" = "Haravan-Server--B" ] && echo hit').decision, "none");
  assert.equal(themePolicy.classifyThemeLine('[[ -d "$RW/$d" ]] || echo missing').decision, "none");
  // a glob or variable that really leads the command word is still refused
  for (const line of ['h?v theme push', '$X theme push', '[h]rv theme push']) {
    assert.equal(themePolicy.classifyThemeLine(line).code, "REFUSED_THEME_COMPLEX", line);
  }
});

test('the prelude shell engine and nested bash tool calls are process sinks judged like subprocess', () => {
  const blocked = [
    'sh("hrv theme publish 1")',
    'out = sh(command="hrv theme push --force")',
    'sh("cd theme && hrv theme publish 1", cwd="E:/x")',
    'await sh("hrv theme publish 1")',
    'await sh\`hrv theme publish 1\`',
    'await sh("hrv theme publish 1", { cwd: "E:/x" })',
    'await tool.bash({ command: "hrv theme publish 1" })',
    'await tool.bash({"command": "hrv theme publish 1"})',
    'const t = tool; await t.bash({ command: "hrv theme publish 1" })',
    'await tool["bash"]({ command: "hrv theme publish 1" })',
    'cmd = "hrv theme publish 1"\nsh(cmd)',
  ];
  for (const cell of blocked) assert.equal(themePolicy.planEvalThemeCode(cell).decision, 'block', cell);
  const allowed = [
    'sh("rg -n hrv src/")',
    'await sh("ls E:/Work/apps | rg -i sapo")',
    'await tool.read({ path: "E:/Work/apps/Haravan CLI/README.md" })',
    'await tool.grep({ pattern: "hrv theme push", path: "docs" })',
    'print("hrv theme publish 1")',
    'self.sh("x"); print("hrv theme push")',
  ];
  for (const cell of allowed) assert.equal(themePolicy.planEvalThemeCode(cell).decision, 'allow', cell);
});
