// Behavioral tests for the AntiFan theme-qa-gate hook.
//
// The hook's source lives IN the repo (src/omp-hooks/theme-qa-gate.ts) and is
// installed to user scope by scripts/install-omp-hooks.mjs. Every test stages a
// throwaway copy of the hook and its src/omp-hooks dependencies as .mts modules
// in a fresh temp dir, rewrites the extensionless relative specifiers to those
// copies, and loads it through the Node type stripper — so the tests exercise the
// shipped source, and each load is a FRESH module instance (pending map, throttle
// counter, churn warning set, mcp-first flag, edit-mode cache cannot leak between
// tests). Set THEME_QA_GATE_HOOK to point at another copy of the same source (the
// installed hook) and the same suite runs against it.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK_SRC_DIR = path.join(REPO, "src", "omp-hooks");
const HOOK_PATH = process.env.THEME_QA_GATE_HOOK ?? path.join(HOOK_SRC_DIR, "theme-qa-gate.ts");
/** src/omp-hooks modules the hook imports relatively; staged beside every load. */
const HOOK_DEPS = ["edit-mode.ts", "theme-paths.ts", "edit-guard-policy.ts"];

// The hook reads ANTIFAN_EDIT_MODE from the real process env: a developer shell
// that exported it must not change what these tests observe.
const PREV_EDIT_MODE = process.env.ANTIFAN_EDIT_MODE;
delete process.env.ANTIFAN_EDIT_MODE;
const PREV_DATA_ROOT = process.env.ANTIFAN_DATA_ROOT;
delete process.env.ANTIFAN_DATA_ROOT;
const PREV_CONFIG_DIR = process.env.ANTIFAN_CONFIG_DIR;
delete process.env.ANTIFAN_CONFIG_DIR;

const BYPASS_TOKENS = [
  "qaStatus: QA_UNAVAILABLE",
  "qaStatus:QA_UNAVAILABLE",
  "qaStatus: QA_INCONCLUSIVE",
  "qaStatus:QA_INCONCLUSIVE",
  "qaStatus: QA_PENDING_SYNC",
  "qaStatus:QA_PENDING_SYNC",
];
const MICRO_TOKEN = "qaStatus: QA_MICRO_STATIC";
const TTL_MS = 10 * 60_000;
const REMIND_EVERY = 4;
const GATE_REMINDER_SENTINEL = "QA GATE PENDING";
const CHURN_SENTINEL = "theme-qa-gate:churn";
const MCP_FIRST_SENTINEL = "theme-qa-gate:mcp-first";
const EDIT_GUARD_MARKER = "[edit-guard]";
const hookSource = fs.readFileSync(HOOK_PATH, "utf8");
const depSources = HOOK_DEPS.map((dep) => {
  const file = path.join(HOOK_SRC_DIR, dep);
  return { name: dep.replace(/\.ts$/, ".mts"), source: fs.readFileSync(file, "utf8") };
});

/**
 * Point the staged copy's relative imports at its staged neighbours: Node's ESM
 * resolver needs the real file name, while the source keeps the extensionless
 * specifiers `tsc` and esbuild resolve.
 */
function stagedSource(source) {
  let out = source;
  for (const dep of depSources) {
    out = out.split(`from "./${dep.name.replace(/\.mts$/, "")}"`).join(`from "./${dep.name}"`);
  }
  return out;
}

const scratchDirs = [];
let loadSeq = 0;

test.after(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (PREV_EDIT_MODE === undefined) delete process.env.ANTIFAN_EDIT_MODE;
  else process.env.ANTIFAN_EDIT_MODE = PREV_EDIT_MODE;
  if (PREV_DATA_ROOT === undefined) delete process.env.ANTIFAN_DATA_ROOT;
  else process.env.ANTIFAN_DATA_ROOT = PREV_DATA_ROOT;
  if (PREV_CONFIG_DIR === undefined) delete process.env.ANTIFAN_CONFIG_DIR;
  else process.env.ANTIFAN_CONFIG_DIR = PREV_CONFIG_DIR;
});

/** Stage-load a pristine copy of the hook and capture its registered handlers. */
function loadHook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-gate-hook-"));
  scratchDirs.push(dir);
  // Hermeticity floor: hook runs must never read the ambient data root's
  // config dir — a dead bridge-dev.json there cascades a suspension notice
  // into every observed tool result under aggregate runs. Deliberately an
  // EMPTY dir, not "unset": it preserves the no-bridge semantics a truly
  // absent config dir would produce (the dataRoot fallback reads a config
  // dir inside the scratch root, which is likewise empty).
  if (!process.env.ANTIFAN_CONFIG_DIR) {
    const emptyConfig = fs.mkdtempSync(path.join(os.tmpdir(), "qa-gate-config-"));
    scratchDirs.push(emptyConfig);
    process.env.ANTIFAN_CONFIG_DIR = emptyConfig;
  }
  for (const dep of depSources) {
    fs.writeFileSync(path.join(dir, dep.name), stagedSource(dep.source), "utf8");
  }
  const file = path.join(dir, `hook-${loadSeq++}.mts`);
  fs.writeFileSync(file, stagedSource(hookSource), "utf8");
  const mod = require(file);
  const factory = mod.default ?? mod;
  assert.equal(typeof factory, "function", "hook module must default-export a factory");
  const handlers = new Map();
  const sent = [];
  const entries = [];
  factory({
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: (message) => sent.push(message),
    appendEntry: (customType, data) => entries.push({ customType, data }),
  });
  for (const event of ["tool_call", "tool_result", "context", "turn_end", "session_start"]) {
    assert.equal(typeof handlers.get(event), "function", `hook must register a ${event} handler`);
  }
  return { handlers, sent, entries, mod };
}
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-gate-ws-"));
  scratchDirs.push(root);
  // The real annotation store shape AnnotationManager pre-creates; a bare
  // `.antifan/` no longer arms the binding (space.json/edit-guard roots are
  // not workspaces), so fixtures need a marker subdir.
  fs.mkdirSync(path.join(root, ".antifan", "annotations"), { recursive: true });
  fs.mkdirSync(path.join(root, ".antifan", "qa-receipts"), { recursive: true });
  for (const dir of ["sections", "reports", "plans", "docs", "scripts"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

function partText(part) {
  if (typeof part === "string") return part;
  if (part && typeof part === "object" && typeof part.text === "string") return part.text;
  return "";
}

function resText(res) {
  if (!res || res.content === undefined) return "";
  if (typeof res.content === "string") return res.content;
  if (Array.isArray(res.content)) return res.content.map(partText).join("\n");
  return "";
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function writeCall(handlers, ctx, target, toolName = "write") {
  return handlers.get("tool_call")({ toolName, input: { path: target } }, ctx);
}

function editCall(handlers, ctx, absPath, addedLines = ["color: red;"]) {
  const lines = Array.isArray(addedLines) ? addedLines : [addedLines];
  const plusBody = lines.map((l) => `+${l}`).join("\n");
  return handlers.get("tool_call")(
    { toolName: "edit", input: { input: `[${absPath}#TAG]\n@@\n${plusBody}` } },
    ctx
  );
}

function result(handlers, ctx, content, toolName = "write") {
  return handlers.get("tool_result")({ toolName, content }, ctx);
}

/** Fire n tool results and tally reminder / churn chunks in the returned content. */
function fire(handlers, ctx, n, contentFactory) {
  let reminders = 0;
  let churn = 0;
  for (let i = 0; i < n; i++) {
    const content = contentFactory ? contentFactory(i) : `tool output ${i}`;
    const text = resText(result(handlers, ctx, content));
    reminders += count(text, GATE_REMINDER_SENTINEL);
    churn += count(text, CHURN_SENTINEL);
  }
  return { reminders, churn };
}

function bigFileBody(lines = 260) {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");
}

test("non-theme directories never arm the gate (reports/, plans/, docs/, scripts/)", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "reports", "notes.md"));
  writeCall(handlers, ctx, path.join(root, "plans", "plan.js"));
  writeCall(handlers, ctx, path.join(root, "docs", "readme.md"));
  writeCall(handlers, ctx, path.join(root, "scripts", "run.sh"));
  writeCall(handlers, ctx, "reports/relative-notes.md"); // cwd-relative form
  writeCall(handlers, ctx, path.join(root, "sections", "..", "reports", "escape.md"));
  writeCall(handlers, ctx, path.join(root, "notes-at-root.md"));
  const { reminders } = fire(handlers, ctx, 2 * REMIND_EVERY);
  assert.equal(reminders, 0, "no reminder may be emitted for non-theme writes");
});

test("a real theme path arms the gate, the first unmarked result carries the reminder, then every Nth", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  const first = fire(handlers, ctx, 1);
  assert.equal(first.reminders, 1, "the first result after a theme write carries the reminder");
  const nextThree = fire(handlers, ctx, REMIND_EVERY - 1);
  assert.equal(nextThree.reminders, 0, "results 2..N-1 are silent");
  const nth = fire(handlers, ctx, 1);
  assert.equal(nth.reminders, 1, "the Nth pending result reminds again");
});

test("gate arming accepts cwd-relative paths and nested theme dirs", () => {
  const relative = loadHook();
  const rootA = makeWorkspace();
  writeCall(relative.handlers, { cwd: rootA }, path.join("sections", "hero.liquid"));
  assert.equal(fire(relative.handlers, { cwd: rootA }, REMIND_EVERY).reminders, 1);

  const nested = loadHook();
  const rootB = makeWorkspace();
  fs.mkdirSync(path.join(rootB, "theme", "snippets"), { recursive: true });
  writeCall(nested.handlers, { cwd: rootB }, path.join(rootB, "theme", "snippets", "card.liquid"));
  assert.equal(fire(nested.handlers, { cwd: rootB }, REMIND_EVERY).reminders, 1);
});

test("content shapes are preserved and a marked result is never double-appended", () => {
  const shaped = loadHook();
  const rootA = makeWorkspace();
  const ctxA = { cwd: rootA };
  writeCall(shaped.handlers, ctxA, path.join(rootA, "sections", "hero.liquid"));
  const arrayRes = result(shaped.handlers, ctxA, [{ type: "text", text: "ok" }]);
  assert.ok(Array.isArray(arrayRes.content), "array content stays an array");
  assert.equal(arrayRes.content.length, 2, "appended chunks land as one extra text part");
  assert.equal(count(resText(arrayRes), GATE_REMINDER_SENTINEL), 1);
  assert.equal(count(resText(arrayRes), MCP_FIRST_SENTINEL), 1, "first result also carries MCP-first");

  const objectShape = loadHook();
  const rootB = makeWorkspace();
  const ctxB = { cwd: rootB };
  writeCall(objectShape.handlers, ctxB, path.join(rootB, "sections", "hero.liquid"));
  const oddRes = result(objectShape.handlers, ctxB, { unexpected: true });
  assert.ok(Array.isArray(oddRes.content), "unknown content shapes are replaced, not crashed on");
  assert.equal(count(resText(oddRes), GATE_REMINDER_SENTINEL), 1);
});

test("an already-marked tool result is skipped for both string and array content", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  const first = result(handlers, ctx, "ok");
  assert.equal(count(resText(first), GATE_REMINDER_SENTINEL), 1, "drain MCP-first + first reminder");

  const markedString = result(handlers, ctx, "previous note\n[theme-qa-gate] QA GATE PENDING — stale copy");
  assert.equal(markedString, undefined, "string content already carrying the marker is untouched");

  const markedArray = result(handlers, ctx, [
    { type: "text", text: "ok" },
    { type: "text", text: "[theme-qa-gate] QA GATE PENDING — stale copy" },
  ]);
  assert.equal(markedArray, undefined, "array content already carrying the marker is untouched");

  const next = fire(handlers, ctx, REMIND_EVERY - 1);
  assert.equal(next.reminders, 0, "results between reminders stay silent");
  const nth = result(handlers, ctx, "nth output");
  assert.equal(
    count(resText(nth), GATE_REMINDER_SENTINEL),
    1,
    "an unmarked result on the reminder cadence still reminds"
  );
});

test("reminder text contains no bypass token and cannot clear the gate it describes", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  const reminder = resText(result(handlers, ctx, "ok"));
  assert.equal(count(reminder, GATE_REMINDER_SENTINEL), 1);

  for (const token of BYPASS_TOKENS) {
    assert.ok(!reminder.includes(token), `reminder must not contain ${JSON.stringify(token)}`);
  }
  assert.ok(
    !/qaStatus\s*:\s*QA_(UNAVAILABLE|INCONCLUSIVE|PENDING_SYNC|FAILED)/.test(reminder),
    "reminder must not reproduce the qaStatus declaration form"
  );
  assert.ok(reminder.includes("SELF_QA_DIRECTIVE"), "reminder must name the directive contract");
  assert.ok(!reminder.includes("annotation-prompt.ts"), "reminder must not cite a repo-relative path the consumer cwd cannot resolve");
  assert.ok(reminder.includes("QA_UNAVAILABLE") && reminder.includes("QA_INCONCLUSIVE"), "terminal names stay discoverable");
  assert.ok(reminder.includes("QA_PENDING_SYNC") && reminder.includes("QA_FAILED"), "sync-pending and failed statuses are discoverable");
  assert.ok(reminder.includes("CAPTURE_FRAME_STARVATION") && reminder.includes("TARGET_STALE"), "env codes the directive routes to INCONCLUSIVE are listed");

  // Regression for the self-clearing exploit: echoing the reminder into an
  // assistant message must not satisfy the bypass scan.
  handlers.get("context")({ messages: [{ role: "assistant", content: reminder }] }, ctx);
  const after = fire(handlers, ctx, REMIND_EVERY);
  assert.equal(after.reminders, 1, "the reminder text itself must not clear the gate");
});

test("bypass tokens clear the gate only from an assistant message", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  const token = BYPASS_TOKENS[0];

  handlers.get("context")(
    {
      messages: [
        { role: "tool", content: `declare ${token} to proceed` },
        { role: "tool_result", content: [{ type: "text", text: token }] },
        { role: 42, content: token },
        `raw string message ${token}`,
        null,
        undefined,
      ],
    },
    ctx
  );
  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "non-assistant token must not clear the gate");
  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "gate is still armed");

  handlers.get("context")({ messages: [{ role: "assistant", content: `QA done. ${token}` }] }, ctx);
  assert.equal(fire(handlers, ctx, 2 * REMIND_EVERY).reminders, 0, "assistant declaration clears the gate");
});

test("QA_PENDING_SYNC from an assistant clears the gate; QA_FAILED does not", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));

  handlers.get("context")({ messages: [{ role: "assistant", content: "qaStatus: QA_FAILED after two rounds" }] }, ctx);
  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "QA_FAILED declaration must keep the gate armed");

  handlers.get("context")({ messages: [{ role: "assistant", content: "Local edit done, awaiting user sync. qaStatus: QA_PENDING_SYNC" }] }, ctx);
  assert.equal(fire(handlers, ctx, 2 * REMIND_EVERY).reminders, 0, "pending-sync declaration clears the gate");
});

test("TTL: a pending entry older than PENDING_TTL_MS is pruned; just inside it is not", () => {
  // Bridge-health env must not leak in: a mocked Date.now makes any real
  // bridge record look stale and suspends the gate, hiding what TTL does.
  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  delete process.env.ANTIFAN_DATA_ROOT;
  delete process.env.ANTIFAN_CONFIG_DIR;
  try {
    const expired = loadHook();
    const rootA = makeWorkspace();
    const ctxA = { cwd: rootA };
    writeCall(expired.handlers, ctxA, path.join(rootA, "sections", "hero.liquid"));
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + TTL_MS + 1000;
      assert.equal(
        fire(expired.handlers, ctxA, 2 * REMIND_EVERY).reminders,
        0,
        "an expired pending entry must stop reminding (the production deadlock)"
      );
    } finally {
      Date.now = realNow;
    }

    const fresh = loadHook();
    const rootB = makeWorkspace();
    const ctxB = { cwd: rootB };
    writeCall(fresh.handlers, ctxB, path.join(rootB, "sections", "hero.liquid"));
    try {
      Date.now = () => realNow() + TTL_MS - 1000;
      assert.equal(fire(fresh.handlers, ctxB, REMIND_EVERY).reminders, 1, "inside the TTL the gate stays armed");
    } finally {
      Date.now = realNow;
    }
  } finally {
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    else delete process.env.ANTIFAN_DATA_ROOT;
    if (prevConfigDir !== undefined) process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
    else delete process.env.ANTIFAN_CONFIG_DIR;
  }
});

test("TTL pruning does not leave the re-armed gate silent", () => {
  // Same env isolation as the sibling TTL test: a mocked Date.now turns a real
  // bridge record stale and suspends the gate, masking what re-arming does.
  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  delete process.env.ANTIFAN_DATA_ROOT;
  delete process.env.ANTIFAN_CONFIG_DIR;
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + TTL_MS + 1000;
    assert.equal(fire(handlers, ctx, 2 * REMIND_EVERY).reminders, 0, "expired gate is silent");
    writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
    assert.equal(fire(handlers, ctx, 1).reminders, 1, "re-armed gate reminds on the next unmarked result");
  } finally {
    Date.now = realNow;
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    else delete process.env.ANTIFAN_DATA_ROOT;
    if (prevConfigDir !== undefined) process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
    else delete process.env.ANTIFAN_CONFIG_DIR;
  }
});

test("soft write-churn hint is one-time per file, never blocks, and ignores small files", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  const bigAbs = path.join(root, "reports", "big.md");
  fs.writeFileSync(bigAbs, bigFileBody(), "utf8");

  const callRes = writeCall(handlers, ctx, bigAbs);
  assert.equal(callRes, undefined, "write is never blocked");

  const first = fire(handlers, ctx, 2 * REMIND_EVERY);
  assert.equal(first.churn, 1, "warned exactly once");
  assert.equal(first.reminders, 0, "a reports/ write must not arm the QA gate");
  const second = fire(handlers, ctx, 2 * REMIND_EVERY);
  assert.equal(second.churn, 0, "never warned twice for the same file");

  const smallAbs = path.join(root, "reports", "small.md");
  fs.writeFileSync(smallAbs, bigFileBody(20), "utf8");
  writeCall(handlers, ctx, smallAbs);
  const third = fire(handlers, ctx, REMIND_EVERY);
  assert.equal(third.churn, 0, "small files get no churn hint");
});

test("churn hint and QA reminder compose into one tool_result", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  const bigAbs = path.join(root, "reports", "big.md");
  fs.writeFileSync(bigAbs, bigFileBody(), "utf8");

  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  writeCall(handlers, ctx, bigAbs);
  const text = resText(result(handlers, ctx, "ok"));
  assert.equal(count(text, GATE_REMINDER_SENTINEL), 1, "QA reminder present");
  assert.equal(count(text, CHURN_SENTINEL), 1, "churn hint present in the same result");
});

test("micro lane: qualifying single-file CSS edit clears on assistant declaration, not tool message", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const cssPath = path.join(root, "assets", "custom.css");

  editCall(handlers, ctx, cssPath, ["body { color: red; }"]);

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after qualifying micro edit");

  handlers.get("context")(
    {
      messages: [
        { role: "tool", content: `status: ${MICRO_TOKEN}` },
        { role: "user", content: MICRO_TOKEN },
      ],
    },
    ctx
  );
  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "non-assistant token message does not clear gate");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Micro CSS tweak applied. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 0, "assistant micro token clears the qualifying gate");
});

test("micro lane rejection: structural or Liquid file cannot be cleared by micro token", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  const liquidPath = path.join(root, "sections", "hero.liquid");

  editCall(handlers, ctx, liquidPath, ["<div class=\"hero\">{% render 'hero' %}</div>"]);

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after liquid edit");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Declared micro fix. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "micro token must not clear structural edit");
});

test("micro lane rejection: diff exceeding 10 added lines cannot be cleared by micro token", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const cssPath = path.join(root, "assets", "custom.css");

  const lines = Array.from({ length: 12 }, (_, i) => `.rule-${i} { color: red; }`);
  editCall(handlers, ctx, cssPath, lines);

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after 12-line edit");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Declared micro fix. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "micro token must not clear diff > 10 lines");
});

test("micro lane rejection: multi-file edits cannot be cleared by micro token", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const file1 = path.join(root, "assets", "custom.css");
  const file2 = path.join(root, "assets", "theme.css");

  editCall(handlers, ctx, file1, ["body { color: red; }"]);
  editCall(handlers, ctx, file2, ["h1 { font-size: 16px; }"]);

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after two-file edit");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Declared micro fix. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "micro token must not clear multi-file edits");
});

test("micro lane fail-closed: unobservable tool input shape (ast_edit) cannot be cleared by micro token", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const cssPath = path.join(root, "assets", "custom.css");

  handlers.get("tool_call")(
    {
      toolName: "ast_edit",
      input: { path: cssPath },
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after ast_edit call");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Declared micro fix. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "micro token must not clear unobservable shape");
});

test("token hidden in assistant tool arguments does not clear the gate", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const cssPath = path.join(root, "assets", "custom.css");

  editCall(handlers, ctx, cssPath, ["body { color: red; }"]);

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears while gate armed");

  handlers.get("context")(
    {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({ cmd: "grep qaStatus: QA_UNAVAILABLE" }),
              },
            },
          ],
        },
      ],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "token in tool arguments must not clear gate");
});

test("multi-file single call cannot be cleared by micro token", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, "sections"), { recursive: true });
  const cssPath = path.join(root, "assets", "custom.css");
  const liquidPath = path.join(root, "sections", "hero.liquid");

  handlers.get("tool_call")(
    {
      toolName: "edit",
      input: {
        input: `[${cssPath}#A]\n@@\n+body { color: red; }\n[${liquidPath}#B]\n@@\n+div { color: blue; }`,
      },
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after multi-file edit call");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Declared micro fix. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "micro token must not clear multi-file call");
});

test("bulk deletion cannot be cleared by micro token", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const cssPath = path.join(root, "assets", "custom.css");

  handlers.get("tool_call")(
    {
      toolName: "edit",
      input: {
        input: `[${cssPath}#TAG]\n@@\nCUT 1.=500:\n`,
      },
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after bulk deletion");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Declared micro fix. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "micro token must not clear bulk deletion");
});

test(".css.liquid file cannot be cleared by micro token", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const liquidCssPath = path.join(root, "assets", "theme.css.liquid");

  editCall(handlers, ctx, liquidCssPath, ["body { color: red; }"]);

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after theme.css.liquid edit");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Declared micro fix. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "micro token must not clear .css.liquid file");
});

test("session_start resets state and clears pending gate reminders", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const cssPath = path.join(root, "assets", "custom.css");

  editCall(handlers, ctx, cssPath, ["body { color: red; }"]);

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after arming gate");

  handlers.get("session_start")();

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 0, "zero reminders after session_start reset");
});

test("micro lane fail-closed: block-syntax and REM edits cannot be cleared by micro token", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const cssPath = path.join(root, "assets", "custom.css");

  // AST block ops carry unobservable spans; the plain `N` prefix in the regex
  // would otherwise count `CUT 10*` as a single changed line.
  handlers.get("tool_call")(
    { toolName: "edit", input: { input: `[${cssPath}#TAG]\nCUT 10*` } },
    ctx
  );
  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after block CUT");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Declared micro fix. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "micro token must not clear block CUT");

  handlers.get("session_start")();

  handlers.get("tool_call")(
    { toolName: "edit", input: { input: `[${cssPath}#TAG]\nREM` } },
    ctx
  );
  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "reminder appears after REM");

  handlers.get("context")(
    {
      messages: [{ role: "assistant", content: `Declared micro fix. ${MICRO_TOKEN}` }],
    },
    ctx
  );

  assert.equal(fire(handlers, ctx, REMIND_EVERY).reminders, 1, "micro token must not clear whole-file REM");
});

test("first tool_result in a theme cwd injects MCP-first once, even without a write", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  const first = resText(result(handlers, ctx, "glob output"));
  assert.equal(count(first, MCP_FIRST_SENTINEL), 1, "first result carries MCP-first");
  assert.ok(first.includes("anti.browser.tabs.list"), "names the bind tool");
  assert.ok(first.includes("anti.inspect.dom"), "names inspect");
  assert.ok(first.includes("anti.screenshot.viewport"), "names screenshot");
  assert.ok(first.includes("theme.qa_validate"), "names qa_validate");
  assert.equal(count(first, GATE_REMINDER_SENTINEL), 0, "no write => no QA reminder");

  const second = result(handlers, ctx, "another glob");
  assert.equal(second, undefined, "second result is not injected again");
});

test("session_start re-enables MCP-first injection", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  assert.equal(count(resText(result(handlers, ctx, "a")), MCP_FIRST_SENTINEL), 1);
  handlers.get("session_start")();
  assert.equal(count(resText(result(handlers, ctx, "b")), MCP_FIRST_SENTINEL), 1, "reset re-injects");
});

test("context injects one MCP-first message in a theme cwd", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  const original = [{ role: "user", content: "sua banner" }];
  const out = handlers.get("context")({ messages: original }, ctx);
  assert.ok(out && Array.isArray(out.messages), "context returns messages");
  assert.equal(out.messages.length, 2, "original plus one injected message");
  assert.equal(out.messages[0], original[0], "original messages are kept");
  assert.equal(out.messages[1].details.kind, "mcp-first");
  assert.ok(String(out.messages[1].content).includes(MCP_FIRST_SENTINEL));

  const again = handlers.get("context")({ messages: original }, ctx);
  assert.equal(again, undefined, "second context call does not re-inject");
});

test("a cwd without .antifan, templates/, or /customizes/ does not get MCP-first", () => {
  const { handlers } = loadHook();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-gate-nontheme-"));
  scratchDirs.push(root);
  const ctx = { cwd: root };
  const res = result(handlers, ctx, "glob output");
  assert.equal(res, undefined, "non-theme cwd is not injected");
  const out = handlers.get("context")({ messages: [{ role: "user", content: "hi" }] }, ctx);
  assert.equal(out, undefined, "non-theme context is untouched");
});

// ---------------------------------------------------------------------------
// Edit-mode scoping: Direct/Super-Fast sessions skip storefront QA
// ---------------------------------------------------------------------------

/** Context of a session whose mode the edit guard latched into `branch`. */
function sessionCtx(cwd, sessionId, branch) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
    },
  };
}

/** The `antifan.edit-mode` custom entry the edit guard appends on a mode change. */
function modeEntry(mode) {
  return {
    type: "custom",
    customType: "antifan.edit-mode",
    data: { mode, trigger: "annotation_tag", at: new Date().toISOString() },
  };
}

/** One audit row, shaped exactly as src/omp-hooks/edit-guard.ts writes it. */
function auditRow(runSeq, filePath, decision = "allow") {
  return {
    ts: new Date().toISOString(),
    runSeq,
    mode: "direct",
    tool: "edit",
    path: filePath,
    decision,
    code: decision === "block" ? "REFUSED_EDIT_SCOPE" : "ALLOWED",
    terminalSessionId: null,
    ompSessionId: "test-session",
  };
}

function writeEditGuardLog(root, sessionId, rows) {
  const dir = path.join(root, ".antifan", "edit-guard");
  fs.mkdirSync(dir, { recursive: true });
  const lines = rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row)));
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

/** Run `fn` with ANTIFAN_EDIT_MODE set to `mode` (undefined leaves it unset). */
function withEditMode(mode, fn) {
  const before = process.env.ANTIFAN_EDIT_MODE;
  if (mode === undefined) delete process.env.ANTIFAN_EDIT_MODE;
  else process.env.ANTIFAN_EDIT_MODE = mode;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.ANTIFAN_EDIT_MODE;
    else process.env.ANTIFAN_EDIT_MODE = before;
  }
}

test("scoped mode: six unmarked results stay silent, turn_end states the changed-file count", () => {
  const { handlers, sent } = loadHook();
  const root = makeWorkspace();
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const sessionId = "01a0scoped01";
  writeEditGuardLog(root, sessionId, [
    auditRow(1, "sections/old.liquid"), // an earlier run is not this run's count
    auditRow(2, "sections/hero.liquid"),
    auditRow(2, "sections/hero.liquid"), // the same file twice is one changed file
    auditRow(2, "assets/theme.css"),
    auditRow(2, "templates/index.liquid", "block"), // refused, so not a change
    "{ not json", // a torn line must not hide the run it sits in
  ]);
  const ctx = sessionCtx(root, sessionId, [modeEntry("direct")]);

  // This write would arm the gate in an unscoped session; a scoped one ignores it.
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  for (let i = 0; i < 6; i++) {
    assert.equal(
      result(handlers, ctx, `tool output ${i}`),
      undefined,
      "scoped mode appends no reminder, churn or MCP-first chunk"
    );
  }
  assert.equal(sent.length, 0, "tool results never message the session");

  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "turn_end sends exactly one line");
  assert.equal(
    sent[0].content,
    "[edit-guard] Direct-Edit: 2 file(s) changed — storefront QA skipped (send [🧠Core-Context] to run it)"
  );
  assert.equal(sent[0].customType, "theme-qa-gate");
  assert.equal(sent[0].display, true);
  assert.equal(sent[0].attribution, "agent");
  assert.deepEqual(sent[0].details, { kind: "edit-guard-skip", mode: "direct", changedFiles: 2 });
  // Calling turn_end again in the same run/turn without new activity stays silent (prevents ping-pong loop).
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "consecutive turn_end without activity does not re-emit");

  // Next run with a new runSeq emits its own skip line.
  writeCall(handlers, ctx, path.join(root, "snippets", "footer.liquid"));
  writeEditGuardLog(root, sessionId, [
    auditRow(2, "sections/hero.liquid"),
    auditRow(3, "snippets/footer.liquid"),
  ]);
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 2, "the next run gets its own single line");
  assert.equal(
    sent[1].content,
    "[edit-guard] Direct-Edit: 1 file(s) changed — storefront QA skipped (send [🧠Core-Context] to run it)"
  );
});

test("scoped mode: intervening context without tool_call does not trigger duplicate turn_end skip", () => {
  const { handlers, sent } = loadHook();
  const root = makeWorkspace();
  const branch = [modeEntry("fast")];
  const ctx = sessionCtx(root, "01a0scoped-pingpong", branch);

  // 1. Tool call runs in Super-Fast mode
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  // 2. First turn ends -> emits skip line
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "first turn_end emits skip line");

  // 3. Intervening context event (assistant preparing reply to custom_message)
  handlers.get("context")(
    { messages: [{ role: "assistant", content: "Đang chờ yêu cầu từ bạn" }] },
    ctx
  );

  // 4. Second turn ends (assistant finished reply without tool calls)
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "intervening context without tool activity stays silent (no ping-pong)");

  // 5. Another intervening context + turn_end cycle
  handlers.get("context")({ messages: [] }, ctx);
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "repeated context/turn_end cycles stay silent");

  // 6. When a new tool call happens, the next turn_end emits again
  writeCall(handlers, ctx, path.join(root, "sections", "banner.liquid"));
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 2, "turn_end emits again after genuine tool activity");
});

test("scoped mode: read-only tools stay silent at turn_end; write tools emit", () => {
  const { handlers, sent } = loadHook();
  const root = makeWorkspace();
  const sessionId = "01a0scoped-readonly-silent";
  const ctx = sessionCtx(root, sessionId, [modeEntry("direct")]);

  // Turn 1: Fresh session, read-only tool (bash ls)
  handlers.get("tool_call")({ toolName: "bash", input: { command: "ls" } }, ctx);
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 0, "fresh session read-only call produces zero turn_end notices");

  // Turn 2: Second read-only tool (grep)
  handlers.get("tool_call")({ toolName: "grep", input: { pattern: "announcement" } }, ctx);
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 0, "subsequent read-only call stays completely silent");

  // Turn 3: Third read-only tool (read)
  handlers.get("tool_call")({ toolName: "read", input: { path: "layout/theme.liquid" } }, ctx);
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 0, "third read-only call stays completely silent");

  // Turn 4: Write tool call
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "turn_end emits exactly once after write tool");

  // Turn 5: Read-only call after write tool
  handlers.get("tool_call")({ toolName: "grep", input: { pattern: "hero" } }, ctx);
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "read-only call after write does not re-emit");
});

test("scoped mode: device calls via write tool (xd://, mcp://) stay silent at turn_end", () => {
  const { handlers, sent } = loadHook();
  const root = makeWorkspace();
  const sessionId = "01a0scoped-device-tools";
  const ctx = sessionCtx(root, sessionId, [modeEntry("direct")]);

  // Turn 1: Device MCP call using write tool with xd:// URI
  handlers.get("tool_call")(
    { toolName: "write", input: { path: "xd://mcp__antifan_browser_anti_browser_tabs_list" } },
    ctx,
  );
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 0, "device tabs_list call produces zero turn_end notices");

  // Turn 2: Another device MCP call using write tool with mcp:// URI
  handlers.get("tool_call")(
    { toolName: "write", input: { path: "mcp://antifan_browser/anti.browser.evaluate" } },
    ctx,
  );
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 0, "device evaluate call produces zero turn_end notices");

  // Turn 3: Real theme file write tool call
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "real file write emits skip notice at turn_end");
});

test("scoped mode: consecutive 0-change runs emit once per runSeq, not suppressed by identical count", () => {
  const { handlers, sent } = loadHook();
  const root = makeWorkspace();
  const sessionId = "01a0scoped-zerochanges";
  const ctx = sessionCtx(root, sessionId, [modeEntry("direct")]);

  // Run 1: tool ran, but 0 allowed changes (e.g. refused or no writes)
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  writeEditGuardLog(root, sessionId, [
    auditRow(1, "sections/blocked.liquid", "block"),
  ]);
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "run 1 emits 0 file(s) changed");
  assert.equal(
    sent[0].content,
    "[edit-guard] Direct-Edit: 0 file(s) changed — storefront QA skipped (send [🧠Core-Context] to run it)"
  );

  // Calling turn_end again within run 1 stays silent
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "turn_end in run 1 without new activity is deduplicated");

  // Run 2: tool runs, audit log advances to runSeq 2, still 0 allowed changes
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  writeEditGuardLog(root, sessionId, [
    auditRow(1, "sections/blocked.liquid", "block"),
    auditRow(2, "sections/another-blocked.liquid", "block"),
  ]);
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 2, "run 2 emits its own skip line despite changedFiles count being identical (0 === 0)");
  assert.equal(
    sent[1].content,
    "[edit-guard] Direct-Edit: 0 file(s) changed — storefront QA skipped (send [🧠Core-Context] to run it)"
  );
});

test("scoped mode: the branch latch silences the gate until a Core entry reopens it", () => {
  const { handlers, sent } = loadHook();
  const root = makeWorkspace();
  const branch = [modeEntry("fast")];
  const ctx = sessionCtx(root, "01a0scoped02", branch);

  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  assert.equal(result(handlers, ctx, "first"), undefined, "Super-Fast keeps tool results clean");
  assert.equal(result(handlers, ctx, "second"), undefined, "and keeps them clean across calls");
  assert.equal(
    handlers.get("context")({ messages: [{ role: "user", content: "sua banner" }] }, ctx),
    undefined,
    "Super-Fast is not told to go use AntiFan MCP"
  );
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1);
  // Calling turn_end again without new tool/context activity stays silent:
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "does not re-emit when repeating turn_end without activity");

  // What a `[🧠Core-Context]` prompt makes the edit guard append.
  branch.push(modeEntry("core"));
  const reopened = resText(result(handlers, ctx, "after core"));
  assert.equal(count(reopened, GATE_REMINDER_SENTINEL), 1, "the gate asks for QA again");
  assert.equal(count(reopened, MCP_FIRST_SENTINEL), 1, "and MCP-first injection resumes");
  // The context handler reads messages again too: an assistant declaration clears
  // the pending edit, which the scoped early return would never have reached.
  handlers.get("context")({ messages: [{ role: "assistant", content: BYPASS_TOKENS[0] }] }, ctx);
  assert.equal(result(handlers, ctx, "after declaration"), undefined, "the gate cleared");
  handlers.get("turn_end")({ type: "turn_end" }, ctx);
  assert.equal(sent.length, 1, "an unscoped turn says nothing at turn_end");
});

test("scoped mode: without a readable audit trail the skip line carries no count", () => {
  const { handlers, sent } = loadHook();
  const root = makeWorkspace();
  withEditMode("fast", () => {
    // Logged-in session, but no audit file yet: nothing to count.
    handlers.get("turn_end")({ type: "turn_end" }, sessionCtx(root, "01a0scoped03", []));
    // Session the host gives no id for: the audit trail cannot be located at all.
    handlers.get("turn_end")({ type: "turn_end" }, { cwd: root });
  });
  assert.equal(sent.length, 2);
  assert.equal(
    sent[0].content,
    "[edit-guard] Super-Fast: edit finished — storefront QA skipped (send [🧠Core-Context] to run it)"
  );
  assert.equal(sent[1].content, sent[0].content, "a missing session id degrades the same way");
  assert.equal(sent[0].details.changedFiles, null);
});

test("unset and core modes keep today's reminder behaviour and stay quiet at turn_end", () => {
  for (const mode of [undefined, "core"]) {
    const label = mode ?? "unset";
    const { handlers, sent } = loadHook();
    const root = makeWorkspace();
    const ctx = { cwd: root };
    withEditMode(mode, () => {
      writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
      const first = resText(result(handlers, ctx, "output 1"));
      assert.equal(
        count(first, GATE_REMINDER_SENTINEL),
        1,
        `${label} reminds on an unmarked result`
      );
      assert.equal(count(first, MCP_FIRST_SENTINEL), 1, `${label} still injects MCP-first`);
      assert.equal(
        result(handlers, ctx, `output 2\n[theme-qa-gate] QA GATE PENDING — stale copy`),
        undefined,
        `${label} does not re-append to a marked result`
      );
      handlers.get("turn_end")({ type: "turn_end" }, ctx);
      assert.equal(sent.length, 0, `${label} sends no turn_end line`);
    });
  }
});

// ---------------------------------------------------------------------------
// Bridge health & QA-gate suspension (Component 6)
// ---------------------------------------------------------------------------

test("outage constants: hook exports match bridge-health.ts pins", () => {
  // Assert the loaded module's exported values, not source syntax — the same
  // invariant holds on the .ts source and the esbuild .js bundle (5e3).
  const { mod } = loadHook();
  const hookHb = Number(mod.BRIDGE_HEALTH_HEARTBEAT_MS);
  const hookMult = Number(mod.BRIDGE_HEALTH_STALE_MULTIPLIER);
  assert.equal(hookHb, 5000, "hook heartbeat constant is 5000");
  assert.equal(hookMult, 3, "hook stale multiplier is 3");

  const bridgeHealthPath = path.join(REPO, "src", "main", "bridge", "bridge-health.ts");
  if (fs.existsSync(bridgeHealthPath)) {
    const text = fs.readFileSync(bridgeHealthPath, "utf8");
    const srcHb = text.match(/BRIDGE_HEALTH_HEARTBEAT_MS\s*=\s*(\d+)/);
    const srcMult = text.match(/BRIDGE_HEALTH_STALE_MULTIPLIER\s*=\s*(\d+)/);
    if (srcHb) assert.equal(hookHb, Number(srcHb[1]), "hook heartbeat matches src/main/bridge/bridge-health.ts");
    if (srcMult) assert.equal(hookMult, Number(srcMult[1]), "hook multiplier matches src/main/bridge/bridge-health.ts");
  }
});

test("suspension: no env => no record probe and no suspension", () => {
  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  delete process.env.ANTIFAN_DATA_ROOT;
  delete process.env.ANTIFAN_CONFIG_DIR;

  try {
    const { handlers, entries } = loadHook();
    const ws = makeWorkspace();
    const ctx = { cwd: ws };
    writeCall(handlers, ctx, "sections/header.liquid");
    const res = result(handlers, ctx, "plain file content");
    const text = resText(res);
    assert.ok(!text.includes("[theme-qa-gate:bridge]"), "no bridge suspension notice without env");
    assert.ok(text.includes(GATE_REMINDER_SENTINEL), "pending edits reminder is still emitted");
    assert.equal(entries.filter((e) => e.customType.startsWith("antifan-bridge-")).length, 0, "no bridge entries appended");
  } finally {
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    if (prevConfigDir !== undefined) process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
  }
});

test("suspension: stale/dead bridge record => one suspension notice and no second on next tool_result", () => {
  const scratchDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antifan-data-"));
  const configDir = path.join(scratchDataRoot, "config");
  fs.mkdirSync(configDir, { recursive: true });
  scratchDirs.push(scratchDataRoot);

  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  process.env.ANTIFAN_DATA_ROOT = scratchDataRoot;
  process.env.ANTIFAN_CONFIG_DIR = configDir;

  try {
    // 1. Stale record test
    const staleTime = Date.now() - 30_000;
    fs.writeFileSync(
      path.join(configDir, "bridge.json"),
      JSON.stringify({ pid: process.pid, health: "listening", updatedAt: staleTime, heartbeatMs: 5000 }),
      "utf8"
    );

    const { handlers, entries } = loadHook();
    const ws = makeWorkspace();
    const ctx = { cwd: ws };
    writeCall(handlers, ctx, "sections/header.liquid");

    const res1 = result(handlers, ctx, "read result 1");
    const text1 = resText(res1);
    assert.ok(text1.includes("[theme-qa-gate:bridge] QA gate suspended: bridge down (HEALTH_STALE)"), "first result carries suspension notice");
    assert.ok(!text1.includes(GATE_REMINDER_SENTINEL), "pending edits reminder is suppressed while suspended");
    assert.equal(entries.length, 1, "exactly one bridge entry on down edge");
    assert.equal(entries[0].customType, "antifan-bridge-suspension");
    assert.equal(entries[0].data.code, "HEALTH_STALE");
    assert.equal(entries[0].data.key, `${process.pid}:HEALTH_STALE`);

    // Next 16 results (the Phukienmaymoc 17-tool_result scenario) must produce ZERO reminders and ZERO duplicate suspension notices
    let suspensionCount = 1;
    let reminderCount = 0;
    for (let i = 2; i <= 17; i++) {
      const resI = result(handlers, ctx, `read result ${i}`);
      const textI = resText(resI);
      if (textI.includes("[theme-qa-gate:bridge]")) suspensionCount++;
      if (textI.includes(GATE_REMINDER_SENTINEL)) reminderCount++;
    }
    assert.equal(suspensionCount, 1, "exactly one suspension notice across all 17 tool results");
    assert.equal(reminderCount, 0, "zero reminders across all 17 tool results during outage");
    assert.equal(entries.length, 1, "no duplicate entries on subsequent tool results");

    // 2. Dead pid test: session_start resets, dead pid record
    handlers.get("session_start")();
    writeCall(handlers, ctx, "sections/header.liquid");
    fs.writeFileSync(
      path.join(configDir, "bridge.json"),
      JSON.stringify({ pid: 99999999, health: "listening", updatedAt: Date.now(), heartbeatMs: 5000 }),
      "utf8"
    );
    const deadRes1 = result(handlers, ctx, "read 1");
    const deadText1 = resText(deadRes1);
    assert.ok(deadText1.includes("[theme-qa-gate:bridge] QA gate suspended: bridge down (HEALTH_PID_DEAD)"), "dead pid produces HEALTH_PID_DEAD suspension");
    const deadRes2 = result(handlers, ctx, "read 2");
    assert.equal(deadRes2, undefined, "second tool_result during dead pid outage is completely silent");
  } finally {
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    else delete process.env.ANTIFAN_DATA_ROOT;
    if (prevConfigDir !== undefined) process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
    else delete process.env.ANTIFAN_CONFIG_DIR;
  }
});

test("suspension: observed-marker lane suspends while record reads listening and with no record", () => {
  const scratchDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antifan-data-"));
  const configDir = path.join(scratchDataRoot, "config");
  fs.mkdirSync(configDir, { recursive: true });
  scratchDirs.push(scratchDataRoot);

  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  process.env.ANTIFAN_DATA_ROOT = scratchDataRoot;
  process.env.ANTIFAN_CONFIG_DIR = configDir;

  try {
    // Record is healthy and listening with live pid
    fs.writeFileSync(
      path.join(configDir, "bridge.json"),
      JSON.stringify({ pid: process.pid, health: "listening", updatedAt: Date.now(), heartbeatMs: 5000 }),
      "utf8"
    );

    const { handlers, entries } = loadHook();
    const ws = makeWorkspace();
    const ctx = { cwd: ws };
    writeCall(handlers, ctx, "sections/header.liquid");

    // Tool result from an AntiFan MCP tool carries launcher failure marker
    const res1 = result(handlers, ctx, "Error: MCP_BRIDGE_OFFLINE: connection refused to 127.0.0.1:20129", "mcp__antifan_browser_theme_qa_validate");
    const text1 = resText(res1);
    assert.ok(text1.includes("[theme-qa-gate:bridge] QA gate suspended: bridge down (MCP_BRIDGE_OFFLINE)"), "observed lane suspends even though record says listening");
    assert.ok(!text1.includes(GATE_REMINDER_SENTINEL), "reminder is suppressed");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].customType, "antifan-bridge-suspension");
    assert.equal(entries[0].data.code, "MCP_BRIDGE_OFFLINE");
    assert.equal(entries[0].data.key, "MCP_BRIDGE_OFFLINE");

    // Second result with same marker does not duplicate notice
    const res2 = result(handlers, ctx, "MCP_BRIDGE_OFFLINE repeated", "mcp__antifan_browser_theme_qa_validate");
    assert.equal(res2, undefined, "repeated failure marker is silent");
    assert.equal(entries.length, 1, "no duplicate entry appended");

    // Also verify with no record present at all
    fs.unlinkSync(path.join(configDir, "bridge.json"));
    handlers.get("session_start")();
    writeCall(handlers, ctx, "sections/header.liquid");
    const resNoRec = result(handlers, ctx, "Connection to bridge failed: BRIDGE_UNREACHABLE", "mcp__antifan_browser_anti_browser_navigate");
    const textNoRec = resText(resNoRec);
    assert.ok(textNoRec.includes("[theme-qa-gate:bridge] QA gate suspended: bridge down (BRIDGE_UNREACHABLE)"), "observed lane suspends with no record on disk");
  } finally {
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    else delete process.env.ANTIFAN_DATA_ROOT;
    if (prevConfigDir !== undefined) process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
    else delete process.env.ANTIFAN_CONFIG_DIR;
  }
});

test("suspension: marker text in a non-MCP tool result does not suspend (ping-pong regression)", () => {
  const scratchDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antifan-data-"));
  const configDir = path.join(scratchDataRoot, "config");
  fs.mkdirSync(configDir, { recursive: true });
  scratchDirs.push(scratchDataRoot);

  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  process.env.ANTIFAN_DATA_ROOT = scratchDataRoot;
  process.env.ANTIFAN_CONFIG_DIR = configDir;

  try {
    // Bridge is healthy and listening.
    fs.writeFileSync(
      path.join(configDir, "bridge.json"),
      JSON.stringify({ pid: process.pid, health: "listening", updatedAt: Date.now(), heartbeatMs: 5000 }),
      "utf8"
    );

    const { handlers, entries } = loadHook();
    const ws = makeWorkspace();
    const ctx = { cwd: ws };
    writeCall(handlers, ctx, "sections/header.liquid");

    // grep/read output that merely MENTIONS the marker — the production loop.
    const res1 = result(handlers, ctx, 'MCP_BRIDGE_OFFLINE\nCONNECTION_FAILED\nfound in scripts/antifan-omp-mcp.cjs:1929');
    const text1 = resText(res1);
    assert.ok(!text1.includes("[theme-qa-gate:bridge]"), "non-MCP result containing marker strings must not suspend");
    assert.equal(entries.filter((e) => e.customType.startsWith("antifan-bridge-")).length, 0, "no bridge entries");

    // And no suspend/resume alternation across subsequent results.
    for (let i = 0; i < 6; i++) {
      const resI = result(handlers, ctx, i % 2 === 0 ? "MCP_BRIDGE_OFFLINE in docs" : "clean output");
      const textI = resText(resI);
      assert.ok(!textI.includes("[theme-qa-gate:bridge]"), `result ${i} must not toggle bridge notices`);
    }
    assert.equal(entries.filter((e) => e.customType.startsWith("antifan-bridge-")).length, 0);
  } finally {
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    else delete process.env.ANTIFAN_DATA_ROOT;
    if (prevConfigDir !== undefined) process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
    else delete process.env.ANTIFAN_CONFIG_DIR;
  }
});

test("suspension: resume emits exactly one notice and restores pending-edits reminder", () => {
  const scratchDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antifan-data-"));
  const configDir = path.join(scratchDataRoot, "config");
  fs.mkdirSync(configDir, { recursive: true });
  scratchDirs.push(scratchDataRoot);

  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  process.env.ANTIFAN_DATA_ROOT = scratchDataRoot;
  process.env.ANTIFAN_CONFIG_DIR = configDir;

  try {
    // Start with bridge down (record down with failure code LISTEN_FAILED)
    fs.writeFileSync(
      path.join(configDir, "bridge.json"),
      JSON.stringify({
        pid: process.pid,
        health: "down",
        lastFailure: { code: "LISTEN_FAILED", message: "listen failed", at: Date.now() },
        updatedAt: Date.now(),
        heartbeatMs: 5000,
      }),
      "utf8"
     );

    const { handlers, entries } = loadHook();
    const ws = makeWorkspace();
    const ctx = { cwd: ws };
    writeCall(handlers, ctx, "sections/header.liquid");

    // 1. Outage edge
    const res1 = result(handlers, ctx, "read 1");
    assert.ok(resText(res1).includes("[theme-qa-gate:bridge] QA gate suspended: bridge down (LISTEN_FAILED)"));
    assert.ok(!resText(res1).includes(GATE_REMINDER_SENTINEL));

    // 2. Silence during outage
    const res2 = result(handlers, ctx, "read 2");
    assert.equal(res2, undefined, "silent while outage is unchanged");

    // 3. Bridge recovers: write healthy record
    fs.writeFileSync(
      path.join(configDir, "bridge.json"),
      JSON.stringify({ pid: process.pid, health: "listening", updatedAt: Date.now(), heartbeatMs: 5000 }),
      "utf8"
    );

    const res3 = result(handlers, ctx, "read 3");
    const text3 = resText(res3);
    assert.ok(text3.includes("[theme-qa-gate:bridge] bridge recovered (listening) — QA gate reminders resumed"), "recovery notice emitted");
    assert.ok(text3.includes(GATE_REMINDER_SENTINEL), "pending edits reminder restored on recovery");
    const resumeEntries = entries.filter((e) => e.customType === "antifan-bridge-resumed");
    assert.equal(resumeEntries.length, 1, "exactly one resumed entry");
    assert.equal(resumeEntries[0].data.code, "listening");
    assert.equal(resumeEntries[0].data.key, `${process.pid}:LISTEN_FAILED`);

    // 4. Next results: recovery notice must NOT repeat; the reminder returns on cadence
    const res4 = result(handlers, ctx, "read 4");
    const text4 = resText(res4);
    assert.ok(!text4.includes("bridge recovered"), "recovery notice does not repeat");
    fire(handlers, ctx, REMIND_EVERY - 2);
    const resN = result(handlers, ctx, "read nth");
    assert.ok(resText(resN).includes(GATE_REMINDER_SENTINEL), "pending reminder continues on subsequent results");
  } finally {
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    else delete process.env.ANTIFAN_DATA_ROOT;
    if (prevConfigDir !== undefined) process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
    else delete process.env.ANTIFAN_CONFIG_DIR;
  }
});

test("suspension: scoped (Direct/Super-Fast) session produces no bridge notices", () => {
  const scratchDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antifan-data-"));
  const configDir = path.join(scratchDataRoot, "config");
  fs.mkdirSync(configDir, { recursive: true });
  scratchDirs.push(scratchDataRoot);

  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  process.env.ANTIFAN_DATA_ROOT = scratchDataRoot;
  process.env.ANTIFAN_CONFIG_DIR = configDir;

  try {
    // Dead PID in bridge.json
    fs.writeFileSync(
      path.join(configDir, "bridge.json"),
      JSON.stringify({ pid: 99999999, health: "down", updatedAt: Date.now(), heartbeatMs: 5000 }),
      "utf8"
    );

    for (const mode of ["fast", "direct"]) {
      withEditMode(mode, () => {
        const { handlers, entries, sent } = loadHook();
        const ws = makeWorkspace();
        const ctx = sessionCtx(ws, `sess-${mode}`);
        writeCall(handlers, ctx, "sections/header.liquid");

        // Tool result with error marker while record is also dead
        const res = result(handlers, ctx, "Error: MCP_BRIDGE_OFFLINE");
        assert.equal(res, undefined, `scoped mode (${mode}) produces no tool_result text`);

        const ctxRes = handlers.get("context")({ messages: [{ role: "user", content: "edit file" }] }, ctx);
        assert.equal(ctxRes, undefined, `scoped mode (${mode}) produces no context messages`);

        assert.equal(entries.filter((e) => e.customType.startsWith("antifan-bridge-")).length, 0, `scoped mode (${mode}) appends no bridge entries`);

        handlers.get("turn_end")({ type: "turn_end" }, ctx);
        assert.equal(sent.length, 1, `scoped mode (${mode}) sends only the turn_end skip line`);
        assert.ok(String(sent[0].content).includes(EDIT_GUARD_MARKER), "skip line has EDIT_GUARD_MARKER");
      });
    }
  } finally {
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    else delete process.env.ANTIFAN_DATA_ROOT;
    if (prevConfigDir !== undefined) process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
    else delete process.env.ANTIFAN_CONFIG_DIR;
  }
});

test("bridge file selection: dev beside prod prefers the live pid's record", () => {
  const scratchDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antifan-data-"));
  const configDir = path.join(scratchDataRoot, "config");
  fs.mkdirSync(configDir, { recursive: true });
  scratchDirs.push(scratchDataRoot);

  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  process.env.ANTIFAN_DATA_ROOT = scratchDataRoot;
  process.env.ANTIFAN_CONFIG_DIR = configDir;

  try {
    // dev record has newer timestamp but dead PID
    fs.writeFileSync(
      path.join(configDir, "bridge-dev.json"),
      JSON.stringify({ pid: 99999999, health: "down", updatedAt: Date.now() + 5000, heartbeatMs: 5000 }),
      "utf8"
    );
    // prod record has older timestamp but alive PID
    fs.writeFileSync(
      path.join(configDir, "bridge.json"),
      JSON.stringify({ pid: process.pid, health: "listening", updatedAt: Date.now(), heartbeatMs: 5000 }),
      "utf8"
    );

    const { handlers, entries } = loadHook();
    const ws = makeWorkspace();
    const ctx = { cwd: ws };
    writeCall(handlers, ctx, "sections/header.liquid");

    const res = result(handlers, ctx, "read content");
    const text = resText(res);
    assert.ok(!text.includes("HEALTH_PID_DEAD"), "dead pid from dev was not chosen because prod has live pid");
    assert.ok(text.includes(GATE_REMINDER_SENTINEL), "healthy prod record allows reminder to be emitted");
    assert.equal(entries.filter((e) => e.customType === "antifan-bridge-suspension").length, 0, "not suspended");
  } finally {
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    else delete process.env.ANTIFAN_DATA_ROOT;
    if (prevConfigDir !== undefined) process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
    else delete process.env.ANTIFAN_CONFIG_DIR;
  }
});

// ---------------------------------------------------------------------------
// Workspace binding & receipt placement (bug D.1: bare .antifan/ ancestor must
// not arm the gate, and a nested project's receipts must clear an ancestor bind)
// ---------------------------------------------------------------------------

test("a bare ancestor .antifan/ (space.json + edit-guard only) never arms the binding", () => {
  const { handlers } = loadHook();
  const umbrella = fs.mkdtempSync(path.join(os.tmpdir(), "qa-gate-umbrella-"));
  scratchDirs.push(umbrella);
  // Exactly the E:/Work/.antifan/ shape that caused the production deadlock:
  // space.json plus an edit-guard log dir — no annotations/, no qa-receipts/.
  fs.mkdirSync(path.join(umbrella, ".antifan", "edit-guard"), { recursive: true });
  fs.writeFileSync(path.join(umbrella, ".antifan", "space.json"), "{}", "utf8");
  const project = path.join(umbrella, "customizes", "shop");
  fs.mkdirSync(path.join(project, "sections"), { recursive: true });
  const ctx = { cwd: project };

  writeCall(handlers, ctx, path.join(project, "sections", "hero.liquid"));
  const { reminders } = fire(handlers, ctx, 2 * REMIND_EVERY);
  assert.equal(reminders, 0, "a space.json/edit-guard-only .antifan/ ancestor must not arm the gate");
});

test("a receipt one level under the bound root clears the ancestor's pending edit", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  // The project's real annotation workspace sits one directory under the root
  // the gate bound to; theme.qa_validate confines its receipts there.
  const childReceipts = path.join(root, "shopproj", ".antifan", "qa-receipts");
  fs.mkdirSync(childReceipts, { recursive: true });
  const ctx = { cwd: root };

  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  fs.writeFileSync(
    path.join(childReceipts, "r1.json"),
    JSON.stringify({ createdAt: new Date().toISOString() }),
    "utf8"
  );

  // Reconcile runs on every result — even read-class — so the nested receipt clears it
  // (this first result also drains the one-shot MCP-first chunk, which is fine).
  const cleared = resText(result(handlers, ctx, "read output", "read"));
  assert.equal(
    count(cleared, GATE_REMINDER_SENTINEL),
    0,
    "reconciled pending edit: read result carries no reminder"
  );
  // …and stays cleared for the mutation results that carry reminders.
  assert.equal(fire(handlers, ctx, 2 * REMIND_EVERY).reminders, 0, "nested receipt cleared the ancestor-bound pending edit");
});

test("the reminder treats annotationId/expectedUrl as OPTIONAL and cites no repo path", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  const reminder = resText(result(handlers, ctx, "ok"));

  assert.equal(count(reminder, GATE_REMINDER_SENTINEL), 1);
  assert.ok(/annotationId[^.]{0,40}optional/i.test(reminder), "annotationId must be marked optional, not required");
  assert.ok(
    !reminder.includes('annotationId from the annotation "QA Binding" line'),
    "annotationId must not be demanded from a QA Binding line that may not exist"
  );
  assert.ok(reminder.includes("theme.qa_validate"), "the tool name stays discoverable without repo context");
});

test("pending edits remind on mutation results only — read/grep/glob/bash stay clean", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));

  for (const tool of ["read", "grep", "glob", "ls", "bash"]) {
    const res = result(handlers, ctx, `${tool} output`, tool);
    const text = resText(res);
    assert.equal(count(text, GATE_REMINDER_SENTINEL), 0, `${tool} result must not carry the QA reminder`);
  }

  const mutation = resText(result(handlers, ctx, "write ok", "write"));
  assert.equal(count(mutation, GATE_REMINDER_SENTINEL), 1, "a write-class result still carries the reminder");

  const edit = resText(result(handlers, ctx, "edit ok", "edit"));
  const editReminderCount = count(edit, GATE_REMINDER_SENTINEL);
  assert.ok(editReminderCount <= 1, "edit-class results stay on the reminder cadence");
});

function loadSettingsRatchet() {
  const compiledPath = path.join(REPO, ".compiled", "src", "main", "qa", "settings-ratchet.js");
  if (fs.existsSync(compiledPath)) {
    return require(compiledPath);
  }
  const srcPath = path.join(REPO, "src", "main", "qa", "settings-ratchet.ts");
  const tmp = path.join(os.tmpdir(), `settings-ratchet-${loadSeq++}.mts`);
  scratchDirs.push(tmp);
  fs.writeFileSync(tmp, fs.readFileSync(srcPath, "utf8"), "utf8");
  return require(tmp);
}

test("settings ratchet bootstrap creates baseline file with correct multiset counts", () => {
  const { loadOrBootstrapBaseline, evaluateSettingsRatchet, findingKey } = loadSettingsRatchet();
  const root = makeWorkspace();
  const findings = [
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "logo.png", file: "snippets/header.liquid", line: 12 },
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "favicon.png", file: "snippets/head.liquid", line: 5 },
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "logo.png", file: "snippets/header.liquid", line: 25 },
    { rule: "SETTING_UNDECLARED", id: "unknown_setting", file: "templates/index.liquid", line: 40 },
  ];

  const baseline = loadOrBootstrapBaseline(root, findings);
  const baselinePath = path.join(root, ".antifan", "settings-baseline.json");
  assert.ok(fs.existsSync(baselinePath), "baseline file must be written to disk");

  const onDisk = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  assert.equal(onDisk.reviewed, false, "bootstrapped baseline must start in AUDIT mode (reviewed: false)");
  assert.equal(onDisk.totalFindings, 4);

  const logoKey = findingKey(findings[0]);
  const favKey = findingKey(findings[1]);
  const undeclaredKey = findingKey(findings[3]);

  assert.equal(onDisk.counts[logoKey], 2, "duplicate bad reads in same file accumulate in multiset count");
  assert.equal(onDisk.counts[favKey], 1);
  assert.equal(onDisk.counts[undeclaredKey], 1);

  // Idempotence: re-bootstrapping on existing file preserves data
  const reloaded = loadOrBootstrapBaseline(root, []);
  assert.equal(reloaded.totalFindings, 4, "re-bootstrapping must return existing baseline without zeroing");
  assert.equal(reloaded.counts[logoKey], 2);

  // In AUDIT mode (reviewed: false), evaluateSettingsRatchet returns ok: true and auditOnly: true
  const evalResult = evaluateSettingsRatchet(baseline, findings, root);
  assert.equal(evalResult.ok, true, "audit-mode baseline must not block");
  assert.equal(evalResult.auditOnly, true);
  assert.equal(evalResult.newFailures.length, 0);
  assert.equal(evalResult.legacyDebt.length, 3);
});

test("settings ratchet ignores line movement when read count remains identical", () => {
  const { loadOrBootstrapBaseline, evaluateSettingsRatchet } = loadSettingsRatchet();
  const root = makeWorkspace();
  const f1 = [
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "hero_banner.png", file: "sections/hero.liquid", line: 10 },
  ];
  const baseline = loadOrBootstrapBaseline(root, f1);
  baseline.reviewed = true; // Human review completed

  // Line shifted from 10 to 75 due to code changes above it
  const f2 = [
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "hero_banner.png", file: "sections/hero.liquid", line: 75 },
  ];
  const result = evaluateSettingsRatchet(baseline, f2, root);
  assert.equal(result.ok, true, "line shift must not trigger new failure");
  assert.equal(result.newFailures.length, 0);
  assert.equal(result.legacyDebt.length, 1);
  assert.equal(result.legacyDebt[0].count, 1);
  assert.equal(result.legacyDebt[0].line, 75);
});

test("settings ratchet fails when a second duplicate bad read is added to an existing file", () => {
  const { loadOrBootstrapBaseline, evaluateSettingsRatchet } = loadSettingsRatchet();
  const root = makeWorkspace();
  const f1 = [
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "logo.png", file: "snippets/header.liquid", line: 10 },
  ];
  const baseline = loadOrBootstrapBaseline(root, f1);
  baseline.reviewed = true; // Human review completed

  // Added second bad read in same file
  const f2 = [
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "logo.png", file: "snippets/header.liquid", line: 10 },
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "logo.png", file: "snippets/header.liquid", line: 30 },
  ];
  const result = evaluateSettingsRatchet(baseline, f2, root);
  assert.equal(result.ok, false, "increasing count of bad read must fail evaluated ratchet");
  assert.equal(result.newFailures.length, 1);
  assert.equal(result.newFailures[0].count, 1);
  assert.equal(result.newFailures[0].id, "logo.png");
  assert.equal(result.newFailures[0].file, "snippets/header.liquid");
});

test("settings ratchet updates baseline downwards when legacy bad read is deleted", () => {
  const { loadOrBootstrapBaseline, evaluateSettingsRatchet, findingKey } = loadSettingsRatchet();
  const root = makeWorkspace();
  const f1 = [
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "logo.png", file: "snippets/header.liquid", line: 10 },
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "banner.png", file: "snippets/hero.liquid", line: 15 },
  ];
  const baseline = loadOrBootstrapBaseline(root, f1);
  assert.equal(baseline.totalFindings, 2);

  // Delete banner.png bad read (debt fixed)
  const f2 = [
    { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "logo.png", file: "snippets/header.liquid", line: 10 },
  ];
  const result1 = evaluateSettingsRatchet(baseline, f2, root);
  assert.equal(result1.ok, true);
  assert.equal(result1.baselineUpdated, true, "ratchet must update baseline when debt is fixed");
  assert.equal(baseline.totalFindings, 1);

  const disk1 = JSON.parse(fs.readFileSync(path.join(root, ".antifan", "settings-baseline.json"), "utf8"));
  assert.equal(disk1.totalFindings, 1, "persisted baseline must ratchet down total findings to 1");
  const bannerKey = findingKey({ rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "banner.png", file: "snippets/hero.liquid" });
  assert.equal(disk1.counts[bannerKey] ?? 0, 0, "fixed bad read must drop from baseline counts");

  // Delete logo.png bad read as well (all debt fixed)
  const f3 = [];
  const result2 = evaluateSettingsRatchet(baseline, f3, root);
  assert.equal(result2.ok, true);
  assert.equal(result2.baselineUpdated, true);
  assert.equal(baseline.totalFindings, 0);

  const disk2 = JSON.parse(fs.readFileSync(path.join(root, ".antifan", "settings-baseline.json"), "utf8"));
  assert.equal(disk2.totalFindings, 0);
});

test("settings ratchet: temporary file delete→restore converts restored debt into blocking regression (documented drift risk)", () => {
  const { loadOrBootstrapBaseline, evaluateSettingsRatchet } = loadSettingsRatchet();
  const root = makeWorkspace();
  const badRead = { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "banner.png", file: "snippets/hero.liquid", line: 15 };
  const baseline = loadOrBootstrapBaseline(root, [badRead]);
  baseline.reviewed = true;

  // Step 1 — file deleted: finding vanishes, baseline ratchets the key away.
  const delResult = evaluateSettingsRatchet(baseline, [], root);
  assert.equal(delResult.ok, true);
  assert.equal(delResult.baselineUpdated, true);

  // Step 2 — file restored with identical bad read: baseline no longer holds
  // the key, so the debt re-presents as a NEW failure (blocking). This is the
  // known drift hazard: transient deletes inside a reviewed baseline lose debt
  // history. Asserting current behavior makes the risk explicit and testable —
  // a future fix (e.g. snapshot retention / grace window) flips this assertion.
  const restoreResult = evaluateSettingsRatchet(baseline, [badRead], root);
  assert.equal(restoreResult.ok, false, "restored legacy debt is re-flagged as new failure after baseline ratchet-down");
  assert.equal(restoreResult.newFailures.length, 1);
  assert.equal(restoreResult.newFailures[0].id, "banner.png");

  // Step 3 — persist:false caller never mutates the baseline object or disk:
  const diskBefore = fs.readFileSync(path.join(root, ".antifan", "settings-baseline.json"), "utf8");
  const readOnlyBaseline = loadOrBootstrapBaseline(root, []);
  const readOnlyResult = evaluateSettingsRatchet(readOnlyBaseline, [], { workspaceRoot: root, persist: false });
  const diskAfter = fs.readFileSync(path.join(root, ".antifan", "settings-baseline.json"), "utf8");
  assert.equal(diskAfter, diskBefore, "persist:false must never write the baseline file");
  assert.equal(readOnlyResult.baselineUpdated, false, "post-restore baseline is already clean — no diff to report");
  assert.equal(readOnlyResult.ok, true);
});

test("theme-qa-gate keeps pendingEdits armed and formats reminder when receipt has settings regression", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };

  // Write a theme file to arm the gate
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));

  // Emitting a receipt with QA_FAILED and settingsRatchet regressions
  const receiptsDir = path.join(root, ".antifan", "qa-receipts");
  fs.writeFileSync(
    path.join(receiptsDir, "r-failed.json"),
    JSON.stringify({
      verdict: "QA_FAILED",
      createdAt: new Date().toISOString(),
      settingsRatchet: {
        ok: false,
        newFailures: 1,
        legacyDebt: 0,
        findings: [
          { rule: "HARAVAN_SETTINGS_UPLOAD_READ", id: "logo.png", file: "snippets/header.liquid", line: 15 },
        ],
      },
    }),
    "utf8"
  );

  // Reconcile runs on tool result, gate must REMAIN armed
  const writeRes = resText(result(handlers, ctx, "write ok", "write"));
  assert.equal(count(writeRes, GATE_REMINDER_SENTINEL), 1, "gate must remain armed on settings regression");
  assert.ok(
    writeRes.includes("Settings regression detected: HARAVAN_SETTINGS_UPLOAD_READ at snippets/header.liquid:15 (logo.png)"),
    "reminder must format settings regression rule, location and id"
  );
  assert.ok(
    writeRes.includes("Fix: replace with 'logo.png' | asset_url"),
    "reminder must provide specific asset_url fix guidance"
  );

  // Now emit a passing receipt
  fs.writeFileSync(
    path.join(receiptsDir, "r-passed.json"),
    JSON.stringify({
      verdict: "QA_PASSED",
      createdAt: new Date(Date.now() + 1000).toISOString(),
      settingsRatchet: {
        ok: true,
        newFailures: 0,
        legacyDebt: 0,
        findings: [],
      },
    }),
    "utf8"
  );

  // Next tool result reconciles and clears the gate — assert on a write-class
  // result since read-class results never emit the reminder even when armed.
  const clearedRes = resText(result(handlers, ctx, "write ok 2", "write"));
  assert.equal(count(clearedRes, GATE_REMINDER_SENTINEL), 0, "passing receipt clears the gate");
});

test("theme-qa-gate keeps gate armed when QA_FAILED receipt carries ratchet ok:true (visual-only failure)", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };

  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));

  const receiptsDir = path.join(root, ".antifan", "qa-receipts");
  fs.writeFileSync(
    path.join(receiptsDir, "r-failed-visual.json"),
    JSON.stringify({
      verdict: "QA_FAILED",
      createdAt: new Date().toISOString(),
      settingsRatchet: {
        ok: true,
        newFailures: 0,
        legacyDebt: 2,
        findings: [],
      },
    }),
    "utf8"
  );

  // Any QA_FAILED receipt keeps the gate armed — the failure is non-settings
  // but still unverified. Reminders emit only on write-class tool_results
  // (read-class results are intentionally silenced), so assert via a write.
  const armedRes = resText(result(handlers, ctx, "write ok", "write"));
  assert.equal(count(armedRes, GATE_REMINDER_SENTINEL), 1, "QA_FAILED keeps gate armed even when ratchet is ok");
  assert.ok(
    !armedRes.includes("Settings regression detected"),
    "ratchet-ok failure must not format a settings regression reminder"
  );
});

test("theme-qa-gate keeps gate armed when QA_FAILED receipt has no settingsRatchet (non-Haravan failure)", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };

  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));

  const receiptsDir = path.join(root, ".antifan", "qa-receipts");
  fs.writeFileSync(
    path.join(receiptsDir, "r-failed-generic.json"),
    JSON.stringify({
      verdict: "QA_FAILED",
      createdAt: new Date().toISOString(),
    }),
    "utf8"
  );

  const armedRes = resText(result(handlers, ctx, "write ok", "write"));
  assert.equal(count(armedRes, GATE_REMINDER_SENTINEL), 1, "QA_FAILED without settingsRatchet keeps gate armed");
  assert.ok(
    !armedRes.includes("Settings regression detected"),
    "no settingsRatchet means no settings reminder text"
  );
});
test("theme-qa-gate keeps gate armed when newest receipt is corrupt and older receipt passed", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };

  const receiptsDir = path.join(root, ".antifan", "qa-receipts");
  fs.mkdirSync(receiptsDir, { recursive: true });

  // Older valid QA_PASSED — deliberately backdated so the corrupt file is newest.
  fs.writeFileSync(
    path.join(receiptsDir, "a-pass.json"),
    JSON.stringify({ verdict: "QA_PASSED", createdAt: new Date(Date.now() - 60_000).toISOString() }),
    "utf8"
  );
  // Arm the gate AFTER the old pass exists.
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));

  // Newer corrupt receipt — future-dated so rec.time >= editTs deterministically;
  // must win selection and yield an empty receipt, keeping the gate armed.
  const corrupt = path.join(receiptsDir, "z-corrupt.json");
  fs.writeFileSync(corrupt, "{ not valid json", "utf8");
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(corrupt, future, future);

  const armedRes = resText(result(handlers, ctx, "write ok", "write"));
  assert.equal(count(armedRes, GATE_REMINDER_SENTINEL), 1, "corrupt newest receipt must not clear the gate");
});

test("theme-qa-gate keeps gate armed when corrupt receipt ties a valid pass at equal mtime", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };

  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));

  const receiptsDir = path.join(root, ".antifan", "qa-receipts");
  fs.mkdirSync(receiptsDir, { recursive: true });

  // Both receipts postdate the edit and share one millisecond — the corrupt
  // file must still win selection over the pass regardless of readdir order.
  const shared = new Date();
  const passFile = path.join(receiptsDir, "b-pass.json");
  fs.writeFileSync(
    passFile,
    JSON.stringify({ verdict: "QA_PASSED", createdAt: shared.toISOString() }),
    "utf8"
  );
  const corrupt = path.join(receiptsDir, "a-corrupt.json");
  fs.writeFileSync(corrupt, "{ broken", "utf8");
  fs.utimesSync(passFile, shared, shared);
  fs.utimesSync(corrupt, shared, shared);

  const armedRes = resText(result(handlers, ctx, "write ok", "write"));
  assert.equal(count(armedRes, GATE_REMINDER_SENTINEL), 1, "equal-mtime corrupt receipt must keep the gate armed");
});

test("theme-qa-gate keeps gate armed when newest receipt is valid JSON but not an object", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };

  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));

  const receiptsDir = path.join(root, ".antifan", "qa-receipts");
  fs.mkdirSync(receiptsDir, { recursive: true });

  // Pass receipt is older; a JSON array receipt is written last (newest mtime).
  // JSON.parse accepts it, but it is not a receipt object — verdict reads
  // undefined and must NOT reach the legacy clear branch.
  const passFile = path.join(receiptsDir, "a-pass.json");
  fs.writeFileSync(
    passFile,
    JSON.stringify({ verdict: "QA_PASSED", createdAt: new Date().toISOString() }),
    "utf8"
  );
  const older = new Date(Date.now() - 30_000);
  fs.utimesSync(passFile, older, older);

  const arrayReceipt = path.join(receiptsDir, "z-array.json");
  fs.writeFileSync(arrayReceipt, JSON.stringify(["QA_PASSED"]), "utf8");

  const armedRes = resText(result(handlers, ctx, "write ok", "write"));
  assert.equal(count(armedRes, GATE_REMINDER_SENTINEL), 1, "non-object JSON receipt must not clear the gate");

  // A future-pass receipt still clears afterward — the gate didn't pin.
  const realPass = path.join(receiptsDir, "z-realpass.json");
  fs.writeFileSync(realPass, JSON.stringify({ verdict: "QA_PASSED" }), "utf8");
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(realPass, future, future);
  const clearedRes = resText(result(handlers, ctx, "read", "read"));
  assert.equal(count(clearedRes, GATE_REMINDER_SENTINEL), 0, "newest valid pass clears after array receipt");
});



test("scoped mode: dirty turn with settings ratchet stats emits single-line count at turn_end", () => {
  const { handlers, sent } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };

  fs.writeFileSync(
    path.join(root, ".antifan", "settings-baseline.json"),
    JSON.stringify({
      reviewed: false,
      bootstrappedAt: new Date().toISOString(),
      counts: { "HARAVAN_SETTINGS_UPLOAD_READ::logo.png::snippets/header.liquid": 3 },
      totalFindings: 3,
    }),
    "utf8"
  );

  withEditMode("direct", () => {
    writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
    handlers.get("turn_end")({ type: "turn_end" }, ctx);

    assert.equal(sent.length, 1, "turn_end sends exactly one line in scoped mode");
    assert.equal(
       sent[0].content,
      "[theme-qa-gate:scoped] Settings check: 0 new finding(s), 3 legacy debt items. (Direct-Edit non-blocking)"
    );
    assert.equal(sent[0].customType, "theme-qa-gate");
    assert.deepEqual(sent[0].details, {
      kind: "settings-ratchet-scoped",
      mode: "direct",
      newCount: 0,
      debtCount: 3,
    });
  });
});

