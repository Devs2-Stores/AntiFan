// Phase 6.0 hardening tests for the AntiFan theme-qa-gate hook.
//
// The hook lives OUTSIDE the repo (user-scope hook), so it is read from disk,
// transpiled in-memory with the repo's own TypeScript, written to a throwaway
// .cjs file and required. Each test loads a FRESH module instance (unique file
// name => fresh require cache entry) so module-level state (pending map,
// throttle counter, churn warning set) cannot leak between tests.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const HOOK_PATH =
  process.env.THEME_QA_GATE_HOOK ?? "C:\\Users\\Admin\\.omp\\agent\\hooks\\post\\theme-qa-gate.ts";

const BYPASS_TOKENS = [
  "qaStatus: QA_UNAVAILABLE",
  "qaStatus:QA_UNAVAILABLE",
  "qaStatus: QA_INCONCLUSIVE",
  "qaStatus:QA_INCONCLUSIVE",
];
const TTL_MS = 10 * 60_000;
const REMIND_EVERY = 8;
const GATE_REMINDER_SENTINEL = "QA GATE PENDING";
const CHURN_SENTINEL = "theme-qa-gate:churn";

const hookSource = fs.readFileSync(HOOK_PATH, "utf8");
const transpiled = ts.transpileModule(hookSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: false,
  },
  fileName: "theme-qa-gate.ts",
}).outputText;

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
});

/** Transpile-load a pristine copy of the hook and capture its registered handlers. */
function loadHook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-gate-hook-"));
  scratchDirs.push(dir);
  const file = path.join(dir, `hook-${loadSeq++}.cjs`);
  fs.writeFileSync(file, transpiled, "utf8");
  const mod = require(file);
  const factory = mod.default ?? mod;
  assert.equal(typeof factory, "function", "hook module must default-export a factory");
  const handlers = new Map();
  factory({ on: (event, handler) => handlers.set(event, handler) });
  for (const event of ["tool_call", "tool_result", "context"]) {
    assert.equal(typeof handlers.get(event), "function", `hook must register a ${event} handler`);
  }
  return { handlers };
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-gate-ws-"));
  scratchDirs.push(root);
  fs.mkdirSync(path.join(root, ".antifan"), { recursive: true });
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

function result(handlers, ctx, content) {
  return handlers.get("tool_result")({ toolName: "read", content }, ctx);
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

test("a real theme path arms the gate, and only 1 in 8 results carries the reminder", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  const firstSeven = fire(handlers, ctx, REMIND_EVERY - 1);
  assert.equal(firstSeven.reminders, 0, "the first 7 of 8 results stay silent");
  const eighth = fire(handlers, ctx, 1);
  assert.equal(eighth.reminders, 1, "the 8th result carries the reminder");
  const remainingEight = fire(handlers, ctx, REMIND_EVERY);
  assert.equal(remainingEight.reminders, 1, "the 16th result carries the reminder");
  assert.equal(eighth.reminders + remainingEight.reminders, 2, "exactly 2 reminders in 16 results");
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
  fire(shaped.handlers, ctxA, REMIND_EVERY - 1);
  const arrayRes = result(shaped.handlers, ctxA, [{ type: "text", text: "ok" }]);
  assert.ok(Array.isArray(arrayRes.content), "array content stays an array");
  assert.equal(arrayRes.content.length, 2, "reminder is appended as one extra text part");
  assert.equal(count(resText(arrayRes), GATE_REMINDER_SENTINEL), 1);

  const objectShape = loadHook();
  const rootB = makeWorkspace();
  const ctxB = { cwd: rootB };
  writeCall(objectShape.handlers, ctxB, path.join(rootB, "sections", "hero.liquid"));
  fire(objectShape.handlers, ctxB, REMIND_EVERY - 1);
  const oddRes = result(objectShape.handlers, ctxB, { unexpected: true });
  assert.ok(Array.isArray(oddRes.content), "unknown content shapes are replaced, not crashed on");
  assert.equal(count(resText(oddRes), GATE_REMINDER_SENTINEL), 1);
});

test("an already-marked tool result is skipped for both string and array content", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  fire(handlers, ctx, REMIND_EVERY - 1);

  const eighth = result(handlers, ctx, "previous note\n[theme-qa-gate] QA GATE PENDING — stale copy");
  assert.equal(eighth, undefined, "string content already carrying the marker is untouched");

  fire(handlers, ctx, REMIND_EVERY - 1);
  const sixteenth = result(handlers, ctx, [
    { type: "text", text: "ok" },
    { type: "text", text: "[theme-qa-gate] QA GATE PENDING — stale copy" },
  ]);
  assert.equal(sixteenth, undefined, "array content already carrying the marker is untouched");

  fire(handlers, ctx, REMIND_EVERY - 1);
  const twentyFourth = result(handlers, ctx, "plain output");
  assert.equal(
    count(resText(twentyFourth), GATE_REMINDER_SENTINEL),
    1,
    "the throttle schedule keeps running after a deduped result"
  );
});

test("reminder text contains no bypass token and cannot clear the gate it describes", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  fire(handlers, ctx, REMIND_EVERY - 1);
  const reminder = resText(result(handlers, ctx, "ok"));
  assert.equal(count(reminder, GATE_REMINDER_SENTINEL), 1);

  for (const token of BYPASS_TOKENS) {
    assert.ok(!reminder.includes(token), `reminder must not contain ${JSON.stringify(token)}`);
  }
  assert.ok(
    !/qaStatus\s*:\s*QA_(UNAVAILABLE|INCONCLUSIVE)/.test(reminder),
    "reminder must not reproduce the qaStatus declaration form"
  );
  assert.ok(reminder.includes("SELF_QA_DIRECTIVE"), "reminder must point at the authority");
  assert.ok(reminder.includes("annotation-prompt.ts"), "reminder must cite the directive location");
  assert.ok(reminder.includes("QA_UNAVAILABLE") && reminder.includes("QA_INCONCLUSIVE"), "terminal names stay discoverable");

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

test("TTL: a pending entry older than PENDING_TTL_MS is pruned; just inside it is not", () => {
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
});

test("TTL pruning does not reset the throttle into a burst when the gate re-arms", () => {
  const { handlers } = loadHook();
  const root = makeWorkspace();
  const ctx = { cwd: root };
  writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + TTL_MS + 1000;
    assert.equal(fire(handlers, ctx, 2 * REMIND_EVERY).reminders, 0, "expired gate is silent");
    writeCall(handlers, ctx, path.join(root, "sections", "hero.liquid"));
    const resumed = fire(handlers, ctx, REMIND_EVERY - 1);
    assert.equal(resumed.reminders, 0, "re-armed gate does not immediately spam");
    assert.equal(fire(handlers, ctx, 1).reminders, 1, "throttle schedule resumes at 1 in 8");
  } finally {
    Date.now = realNow;
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
  fire(handlers, ctx, REMIND_EVERY - 1);
  writeCall(handlers, ctx, bigAbs);
  const text = resText(result(handlers, ctx, "ok"));
  assert.equal(count(text, GATE_REMINDER_SENTINEL), 1, "QA reminder present");
  assert.equal(count(text, CHURN_SENTINEL), 1, "churn hint present in the same result");
});
