// playwright-gate.test.mjs - Playwright MCP is the fallback surface: refused until the session has
// seen AntiFan fail with a code AGENTS.md section 3.1 allows (or report itself not connected).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-gate-"));
fs.copyFileSync(path.join(REPO, "src", "omp-hooks", "playwright-gate.ts"), path.join(TEMP, "playwright-gate.mts"));
const { default: playwrightGate, FALLBACK_CODES } = await import(pathToFileURL(path.join(TEMP, "playwright-gate.mts")).href);

let previousTerminal;
beforeEach(() => {
  previousTerminal = process.env.ANTIFAN_TERMINAL_SESSION_ID;
  process.env.ANTIFAN_TERMINAL_SESSION_ID = "terminal-7";
});
afterEach(() => {
  if (previousTerminal === undefined) delete process.env.ANTIFAN_TERMINAL_SESSION_ID;
  else process.env.ANTIFAN_TERMINAL_SESSION_ID = previousTerminal;
});

function makeHook() {
  const handlers = new Map();
  playwrightGate({ on: (event, fn) => handlers.set(event, fn) });
  const ctx = (sessionId) => ({ sessionManager: { getSessionId: () => sessionId } });
  return {
    ctx,
    call: (toolName, input, sessionId = "s1") => handlers.get("tool_call")({ toolName, input }, ctx(sessionId)),
    result: (toolName, input, content, isError, sessionId = "s1") =>
      handlers.get("tool_result")({ toolName, input, content: [{ type: "text", text: content }], isError }, ctx(sessionId)),
    shutdown: (sessionId = "s1") => handlers.get("session_shutdown")({}, ctx(sessionId)),
  };
}

const PLAYWRIGHT_CALLS = [
  ["a direct tool call", "mcp__playwright_browser_navigate", { url: "https://x.test" }],
  ["a write to the device path", "write", { path: "xd://mcp__playwright_browser_take_screenshot", content: "{}" }],
  ["an eval cell calling the tool", "eval", { language: "js", code: "await tool.mcp__playwright_browser_evaluate({function: '() => 1'})" }],
];

for (const [label, toolName, input] of PLAYWRIGHT_CALLS) {
  test(`${label} to Playwright is refused with a code and the AntiFan tool to use`, () => {
    const hook = makeHook();
    const refusal = hook.call(toolName, input);
    assert.equal(refusal?.block, true);
    assert.match(refusal.reason, /^REFUSED_PLAYWRIGHT_ANTIFAN_FIRST: /);
    assert.match(refusal.reason, /anti\./);
  });
}

test("the refusal names the AntiFan tool that matches the Playwright one", () => {
  const hook = makeHook();
  assert.match(hook.call("mcp__playwright_browser_navigate", {}).reason, /anti\.browser\.navigate/);
  assert.match(hook.call("mcp__playwright_browser_take_screenshot", {}).reason, /anti\.screenshot\.viewport/);
  assert.match(hook.call("mcp__playwright_browser_console_messages", {}).reason, /anti\.inspect\.console/);
});

test("AntiFan tools, other tools and a session outside an AntiFan terminal are not gated", () => {
  const hook = makeHook();
  assert.equal(hook.call("mcp__antifan_browser_anti_browser_navigate", { url: "https://x.test" }), undefined);
  assert.equal(hook.call("write", { path: "xd://mcp__antifan_browser_anti_browser_navigate", content: "{}" }), undefined);
  assert.equal(hook.call("bash", { command: "npx playwright --version" }), undefined);
  delete process.env.ANTIFAN_TERMINAL_SESSION_ID;
  assert.equal(hook.call("mcp__playwright_browser_navigate", {}), undefined);
});

for (const code of FALLBACK_CODES) {
  test(`an AntiFan call that fails with ${code} unlocks Playwright for that session only`, () => {
    const hook = makeHook();
    hook.result("write", { path: "xd://mcp__antifan_browser_anti_browser_navigate", content: "{}" }, `Error: {"code":"${code}","message":"x","retryable":true}`, true);
    assert.equal(hook.call("mcp__playwright_browser_navigate", {}, "s1"), undefined);
    assert.equal(hook.call("mcp__playwright_browser_navigate", {}, "subagent")?.block, true, "a subagent has not met an outage itself");
  });
}

test("a code inside an eval-embedded AntiFan error unlocks, flagged or not", () => {
  const hook = makeHook();
  hook.result("eval", { language: "js", code: "await tool.mcp__antifan_browser_anti_browser_evaluate({expression: '1'})" }, 'Error: {"code":"TARGET_STALE","message":"x"}', false);
  assert.equal(hook.call("mcp__playwright_browser_navigate", {}), undefined);
});

test("the AntiFan MCP reporting itself not connected unlocks Playwright", () => {
  const hook = makeHook();
  hook.result("write", { path: "xd://mcp__antifan_browser_anti_browser_tabs_list", content: "{}" }, "MCP failure server: antifan-browser tool: anti.browser.tabs.list transport: unknown stage: connect failure: connect retryable: yes message: MCP server not connected", true);
  assert.equal(hook.call("mcp__playwright_browser_navigate", {}), undefined);
});

test("an error result saying the AntiFan tool does not exist unlocks Playwright, but the same words in a successful result do not", () => {
  const missing = makeHook();
  missing.result("mcp__antifan_browser_anti_browser_navigate", {}, "Tool mcp__antifan_browser_anti_browser_navigate not found", true);
  assert.equal(missing.call("mcp__playwright_browser_navigate", {}), undefined);
  const page = makeHook();
  page.result("mcp__antifan_browser_anti_inspect_dom", {}, "Heading: tool not found", false);
  assert.equal(page.call("mcp__playwright_browser_navigate", {})?.block, true);
});

test("evidence that does not come from a failed AntiFan call does not unlock", () => {
  const hook = makeHook();
  // A code on a call that is not AntiFan's.
  hook.result("read", { path: "notes.md" }, "TARGET_STALE is listed in AGENTS.md", true);
  hook.result("bash", { command: "rg TARGET_STALE src" }, 'src/x.ts: "code":"TARGET_STALE"', false);
  // A code word in an AntiFan result that is neither an error nor an error's own code.
  hook.result("write", { path: "xd://mcp__antifan_browser_anti_inspect_dom", content: "{}" }, "page text mentions TARGET_STALE in a paragraph", false);
  // An AntiFan error with a code outside section 3.1.
  hook.result("write", { path: "xd://mcp__antifan_browser_anti_browser_navigate", content: "{}" }, 'Error: {"code":"NAVIGATION_TIMEOUT","message":"x"}', true);
  assert.equal(hook.call("mcp__playwright_browser_navigate", {})?.block, true);
});

test("ending the session clears its unlock", () => {
  const hook = makeHook();
  hook.result("write", { path: "xd://mcp__antifan_browser_anti_browser_navigate", content: "{}" }, '{"code":"MCP_BRIDGE_OFFLINE"}', true);
  assert.equal(hook.call("mcp__playwright_browser_navigate", {}), undefined);
  hook.shutdown();
  assert.equal(hook.call("mcp__playwright_browser_navigate", {})?.block, true);
});

test("a malformed event never throws and never blocks", () => {
  const hook = makeHook();
  assert.equal(hook.call(undefined, undefined), undefined);
  assert.doesNotThrow(() => hook.result(undefined, null, undefined, undefined));
  assert.equal(hook.call("eval", { code: 42 }), undefined);
});
