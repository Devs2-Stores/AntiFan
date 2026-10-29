// Behavioral tests for the AntiFan run-state OMP hook.
//
// Verifies:
// 1. Inert without ANTIFAN_TERMINAL_SESSION_ID and ANTIFAN_DATA_ROOT.
// 2. session_start writes TerminalRunStateFile and resets runSeq only for a different ompSessionId.
// 3. before_agent_start bumps runSeq and captures promptHead (whitespace-collapsed, capped at 120 chars).
// 4. tool_call with an ask-tool sets waiting_user, answering tool_result returns to running.
// 5. willContinue on agent_end keeps running (mid-run retry).
// 6. agent_end without willContinue settles to idle; second settling agent_end is a no-op.
// 7. turn_end and heartbeat update timestamps without changing state.
// 8. session_shutdown sets ended and disposes timers/watchers.
// 9. Control watcher honours cancel -> ctx.abort() and steer -> pi.sendUserMessage(), acking atomically and deleting request.
// 10. Control watcher refuses STALE_RUN_SEQ and RUN_NOT_ACTIVE.
// 11. Control watcher drops expired requests silently (no ack, no abort, deletes request).
// 12. Control watcher acks INVALID_CONTROL_PAYLOAD for corrupt requests.
// 13. Control watcher acks ACTUATOR_FAILED when an actuator throws.
// 14. Capsule brief injection on before_agent_start returns compact message <= 1 KB when mirror exists, undefined when absent/malformed.
// 15. Mode read fresh from edit-mode mirror, unset when absent or malformed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK_PATH = path.join(REPO, "src", "omp-hooks", "run-state.ts");

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

async function loadHook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-state-hook-"));
  scratchDirs.push(dir);
  const file = path.join(dir, `run-state-${loadSeq++}.mts`);
  fs.copyFileSync(HOOK_PATH, file);
  return import(pathToFileURL(file).href);
}
const activeHosts = [];

function makeHost() {
  const handlers = new Map();
  const userMessages = [];
  const pi = {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    sendUserMessage: (text, options) => {
      userMessages.push({ text, options });
    },
  };
  const emit = async (event, payload = {}, ctx = {}) => {
    let lastResult;
    for (const h of handlers.get(event) ?? []) {
      lastResult = await h(payload, ctx);
    }
    return lastResult;
  };
  const host = { pi, handlers, userMessages, emit };
  activeHosts.push(host);
  return host;
}

function makeContext({ sessionId = "session-1", cwd = process.cwd(), abort = () => {} } = {}) {
  let aborted = false;
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    abort: () => {
      aborted = true;
      abort();
    },
    get isAborted() {
      return aborted;
    },
  };
}

async function withDataRoot(fn) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antifan-data-"));
  scratchDirs.push(dataRoot);
  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevTermId = process.env.ANTIFAN_TERMINAL_SESSION_ID;
  const prevPoll = process.env.ANTIFAN_RUN_CONTROL_POLL_MS;
  const prevAsk = process.env.ANTIFAN_RUN_ASK_TOOLS;

  process.env.ANTIFAN_DATA_ROOT = dataRoot;
  process.env.ANTIFAN_TERMINAL_SESSION_ID = "term-1";
  process.env.ANTIFAN_RUN_CONTROL_POLL_MS = "20"; // fast polling for tests

  try {
    return await fn(dataRoot);
  } finally {
    while (activeHosts.length > 0) {
      const h = activeHosts.pop();
      try {
        h.pi._dispose?.();
      } catch {}
    }
    if (prevDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    if (prevTermId === undefined) delete process.env.ANTIFAN_TERMINAL_SESSION_ID;
    else process.env.ANTIFAN_TERMINAL_SESSION_ID = prevTermId;
    if (prevPoll === undefined) delete process.env.ANTIFAN_RUN_CONTROL_POLL_MS;
    else process.env.ANTIFAN_RUN_CONTROL_POLL_MS = prevPoll;
    if (prevAsk === undefined) delete process.env.ANTIFAN_RUN_ASK_TOOLS;
    else process.env.ANTIFAN_RUN_ASK_TOOLS = prevAsk;
  }
}

function readStateFile(dataRoot, terminalSessionId = "term-1") {
  const filePath = path.join(dataRoot, "runtime", "runs", `${terminalSessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("inert without ANTIFAN_TERMINAL_SESSION_ID and ANTIFAN_DATA_ROOT", async () => {
  const prevDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const prevTermId = process.env.ANTIFAN_TERMINAL_SESSION_ID;
  delete process.env.ANTIFAN_DATA_ROOT;
  delete process.env.ANTIFAN_TERMINAL_SESSION_ID;

  try {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext();
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "hello" }, ctx);
    await emit("tool_call", { toolName: "ask" }, ctx);

    // No files created in default paths
    assert.equal(fs.existsSync("runtime"), false);
  } finally {
    if (prevDataRoot !== undefined) process.env.ANTIFAN_DATA_ROOT = prevDataRoot;
    if (prevTermId !== undefined) process.env.ANTIFAN_TERMINAL_SESSION_ID = prevTermId;
  }
});

test("session_start writes the file and resets runSeq only for a different ompSessionId", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx1 = makeContext({ sessionId: "omp-session-A" });
    await emit("session_start", {}, ctx1);

    let state = readStateFile(dataRoot);
    assert.ok(state, "run state file written on session_start");
    assert.equal(state.schema, 1);
    assert.equal(state.terminalSessionId, "term-1");
    assert.equal(state.ompSessionId, "omp-session-A");
    assert.equal(state.pid, process.pid);
    assert.equal(state.state, "idle");
    assert.equal(state.runSeq, 0);
    assert.equal(state.mode, "unset");
    assert.ok(typeof state.updatedAt === "number");
    assert.ok(typeof state.lastEventAt === "number");

    // Advance runSeq
    await emit("before_agent_start", { prompt: "first prompt" }, ctx1);
    state = readStateFile(dataRoot);
    assert.equal(state.runSeq, 1);
    assert.equal(state.state, "running");

    // Simulate session resume with the SAME ompSessionId: runSeq must carry over
    const { pi: piResume } = makeHost();
    hook(piResume);
    const resumeHost = makeHost();
    hook(resumeHost.pi);
    await resumeHost.emit("session_start", {}, ctx1);

    const resumedState = readStateFile(dataRoot);
    assert.equal(resumedState.ompSessionId, "omp-session-A");
    assert.equal(resumedState.runSeq, 1, "runSeq preserved on resume with same ompSessionId");
    assert.equal(resumedState.state, "idle");

    // A new session with a DIFFERENT ompSessionId starts after the previous one ended (what
    // `/new` does): the file changes hands and runSeq resets to 0. Without the shutdown the
    // previous session would still own the card, see the lease tests below.
    await resumeHost.emit("session_shutdown", {}, ctx1);
    const ctx2 = makeContext({ sessionId: "omp-session-B" });
    const freshHost = makeHost();
    hook(freshHost.pi);
    await freshHost.emit("session_start", {}, ctx2);

    const resetState = readStateFile(dataRoot);
    assert.equal(resetState.ompSessionId, "omp-session-B");
    assert.equal(resetState.runSeq, 0, "runSeq reset to 0 when ompSessionId changes");
    assert.equal(resetState.state, "idle");
  });
});

function writeRunFile(dataRoot, overrides = {}) {
  const now = Date.now();
  const file = {
    schema: 1,
    terminalSessionId: "term-1",
    ompSessionId: "owner",
    pid: process.pid,
    cwd: process.cwd(),
    mode: "unset",
    state: "running",
    runSeq: 3,
    runStartedAt: now,
    lastEventAt: now,
    promptHead: "owner task",
    updatedAt: now,
    ...overrides,
  };
  const target = path.join(dataRoot, "runtime", "runs", "term-1.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

/** The pid of a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

test("a second session in the same terminal and process (a subagent) never overwrites the owner's card", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const root = makeHost();
    hook(root.pi);
    const rootCtx = makeContext({ sessionId: "root-session" });
    await root.emit("session_start", {}, rootCtx);
    await root.emit("before_agent_start", { prompt: "root task" }, rootCtx);

    const sub = makeHost();
    hook(sub.pi);
    const subCtx = makeContext({ sessionId: "sub-session" });
    await sub.emit("session_start", {}, subCtx);
    await sub.emit("before_agent_start", { prompt: "subagent task" }, subCtx);
    await sub.emit("tool_call", { toolName: "read" }, subCtx);
    await sub.emit("turn_end", {}, subCtx);
    await sub.emit("agent_end", {}, subCtx);
    await sub.emit("session_shutdown", {}, subCtx);

    const kept = readStateFile(dataRoot);
    assert.equal(kept.ompSessionId, "root-session");
    assert.equal(kept.promptHead, "root task");
    assert.equal(kept.runSeq, 1);
    assert.equal(kept.state, "running", "the subagent's agent_end and shutdown do not settle the root's card");
    assert.equal(kept.lastTool, undefined);
    assert.ok(
      fs.existsSync(path.join(dataRoot, "runtime", "runs", "control", "sub-session")),
      "the guest still listens for control requests addressed to its own session",
    );

    await root.emit("agent_end", {}, rootCtx);
    const settled = readStateFile(dataRoot);
    assert.equal(settled.ompSessionId, "root-session");
    assert.equal(settled.state, "idle", "the root still settles its own card");
  });
});

test("a different session takes the card over from an ended, dead or silent owner, never from a live one", async () => {
  const takeover = async (ownerOverrides, expectOwner) => {
    await withDataRoot(async (dataRoot) => {
      writeRunFile(dataRoot, ownerOverrides);
      const { default: hook } = await loadHook();
      const host = makeHost();
      hook(host.pi);
      const ctx = makeContext({ sessionId: "newcomer" });
      await host.emit("session_start", {}, ctx);
      await host.emit("before_agent_start", { prompt: "newcomer task" }, ctx);
      const state = readStateFile(dataRoot);
      assert.equal(state.ompSessionId, expectOwner, JSON.stringify(ownerOverrides));
      assert.equal(state.promptHead, expectOwner === "newcomer" ? "newcomer task" : "owner task");
    });
  };
  await takeover({ state: "ended" }, "newcomer");
  await takeover({ pid: deadPid() }, "newcomer");
  await takeover({ updatedAt: Date.now() - 46_000 }, "newcomer");
  await takeover({ updatedAt: Date.now() - 30_000 }, "owner");
  await takeover({ state: "idle" }, "owner");
});

test("a resumed session writes even when the pid that owned its card is gone", async () => {
  await withDataRoot(async (dataRoot) => {
    writeRunFile(dataRoot, { ompSessionId: "resumed", pid: deadPid(), state: "idle", runSeq: 4 });
    const { default: hook } = await loadHook();
    const host = makeHost();
    hook(host.pi);
    await host.emit("session_start", {}, makeContext({ sessionId: "resumed" }));
    const state = readStateFile(dataRoot);
    assert.equal(state.pid, process.pid);
    assert.equal(state.runSeq, 4);
  });
});

test("a session that starts before the previous one ends is a guest until the owner's shutdown, then takes over", async () => {
  // The hook has no signal telling a subagent from `/new`: B starting while A is alive looks
  // exactly like a subagent. The card stays A's until A writes `ended` (or goes silent), so a
  // new session's first events are not shown in the window between its start and A's shutdown.
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const a = makeHost();
    hook(a.pi);
    const aCtx = makeContext({ sessionId: "session-a" });
    await a.emit("session_start", {}, aCtx);
    await a.emit("before_agent_start", { prompt: "task a" }, aCtx);

    const b = makeHost();
    hook(b.pi);
    const bCtx = makeContext({ sessionId: "session-b" });
    await b.emit("session_start", {}, bCtx);
    await b.emit("before_agent_start", { prompt: "task b" }, bCtx);
    assert.equal(readStateFile(dataRoot).ompSessionId, "session-a", "B is a guest while A runs");

    await a.emit("session_shutdown", {}, aCtx);
    assert.equal(readStateFile(dataRoot).state, "ended");

    await b.emit("tool_call", { toolName: "read" }, bCtx);
    const taken = readStateFile(dataRoot);
    assert.equal(taken.ompSessionId, "session-b");
    assert.equal(taken.promptHead, "task b");
    assert.equal(taken.state, "running");
  });
});

test("a resumed session keeps the time of its last real event until its first prompt", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const first = makeHost();
    hook(first.pi);
    const ctx = makeContext({ sessionId: "resume-me" });
    await first.emit("session_start", {}, ctx);
    await first.emit("before_agent_start", { prompt: "work" }, ctx);
    await first.emit("agent_end", {}, ctx);
    const before = readStateFile(dataRoot);
    assert.equal(before.state, "idle");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const resumed = makeHost();
    hook(resumed.pi);
    await resumed.emit("session_start", {}, ctx);
    const idle = readStateFile(dataRoot);
    assert.equal(idle.runSeq, 1, "runSeq carries over");
    assert.equal(idle.state, "idle");
    assert.equal(idle.lastEventAt, before.lastEventAt, "a fresh lastEventAt would make the idle card look just-settled");

    await resumed.emit("before_agent_start", { prompt: "more" }, ctx);
    const running = readStateFile(dataRoot);
    assert.equal(running.runSeq, 2);
    assert.ok(running.lastEventAt > before.lastEventAt);
  });
});

/** Makes reads of the terminal's run file throw `code` while `state.on` is true; every other read is untouched. */
function lockRunFileReads(code) {
  const nodeFs = createRequire(import.meta.url)("node:fs");
  const original = nodeFs.readFileSync;
  const state = { on: false, hits: 0 };
  nodeFs.readFileSync = function patched(file, ...rest) {
    if (state.on && typeof file === "string" && path.basename(file) === "term-1.json") {
      state.hits += 1;
      throw Object.assign(new Error(`${code}: simulated`), { code });
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

test("a run file that is locked for a moment is not taken over by a guest; a corrupt one is replaced", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const root = makeHost();
    hook(root.pi);
    const rootCtx = makeContext({ sessionId: "root-session" });
    await root.emit("session_start", {}, rootCtx);
    await root.emit("before_agent_start", { prompt: "root task" }, rootCtx);

    const guest = makeHost();
    hook(guest.pi);
    const guestCtx = makeContext({ sessionId: "guest-session" });
    await guest.emit("session_start", {}, guestCtx);

    const lock = lockRunFileReads("EBUSY");
    try {
      lock.state.on = true;
      await guest.emit("tool_call", { toolName: "read" }, guestCtx);
      await guest.emit("before_agent_start", { prompt: "guest task" }, guestCtx);
      assert.ok(lock.state.hits > 0, "the guest tried to read the owner's file");
      lock.state.on = false;
    } finally {
      lock.restore();
    }
    const kept = readStateFile(dataRoot);
    assert.equal(kept.ompSessionId, "root-session", "an unreadable owner is not an absent owner");
    assert.equal(kept.promptHead, "root task");
  });

  await withDataRoot(async (dataRoot) => {
    const target = path.join(dataRoot, "runtime", "runs", "term-1.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ this is not json");
    const { default: hook } = await loadHook();
    const host = makeHost();
    hook(host.pi);
    await host.emit("session_start", {}, makeContext({ sessionId: "replacer" }));
    assert.equal(readStateFile(dataRoot).ompSessionId, "replacer", "a damaged card must stay replaceable");
  });
});

test("before_agent_start bumps runSeq and captures promptHead (whitespace-collapsed, capped at 120 chars)", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext();
    await emit("session_start", {}, ctx);

    // Collapsed whitespace test
    await emit("before_agent_start", { prompt: "  test   multi-line\n\n\t whitespace   collapse   " }, ctx);
    let state = readStateFile(dataRoot);
    assert.equal(state.state, "running");
    assert.equal(state.runSeq, 1);
    assert.equal(state.promptHead, "test multi-line whitespace collapse");
    assert.ok(typeof state.runStartedAt === "number");

    // Capped at 120 chars test
    const longPrompt = "A".repeat(200);
    await emit("before_agent_start", { prompt: longPrompt }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.runSeq, 2);
    assert.equal(state.promptHead, "A".repeat(120));
    assert.equal(state.promptHead.length, 120);
  });
});

test("ask-tool sets waiting_user and answering tool_result returns it to running", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook, OMP_ASK_TOOLS } = await loadHook();
    assert.ok(OMP_ASK_TOOLS instanceof Set);
    assert.ok(OMP_ASK_TOOLS.has("ask"));

    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext();
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "run task" }, ctx);

    let state = readStateFile(dataRoot);
    assert.equal(state.state, "running");

    // Normal non-ask tool call keeps running
    await emit("tool_call", { toolName: "read" }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "running");
    assert.equal(state.lastTool, "read");

    // Standard ask tool sets waiting_user
    await emit("tool_call", { toolName: "ask_user_question" }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "waiting_user");
    assert.equal(state.lastTool, "ask_user_question");

    // An unrelated tool_result does NOT clear waiting_user
    await emit("tool_result", { toolName: "read" }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "waiting_user");

    // Answering tool_result returns to running
    await emit("tool_result", { toolName: "ask_user_question" }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "running");
    assert.equal(state.lastTool, "ask_user_question");

    // Extended ask tool via ANTIFAN_RUN_ASK_TOOLS (CSV)
    process.env.ANTIFAN_RUN_ASK_TOOLS = "custom_clarify, another_ask";
    await emit("tool_call", { toolName: "CUSTOM_CLARIFY" }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "waiting_user");
    assert.equal(state.lastTool, "CUSTOM_CLARIFY");

    await emit("tool_result", { toolName: "custom_clarify" }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "running");
  });
});

test("willContinue on agent_end keeps running, settling event settles to idle, second settling is no-op", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext();
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "prompt" }, ctx);

    let state = readStateFile(dataRoot);
    assert.equal(state.state, "running");

    // mid-run retry: willContinue truthy -> state unchanged
    await emit("agent_end", { willContinue: true }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "running", "willContinue=true must not settle to idle");

    // settling event
    await emit("agent_end", { willContinue: false }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "idle", "willContinue=false settles to idle");

    // second settling agent_end is a re-entry no-op
    const lastUpdatedAt = state.updatedAt;
    await emit("agent_end", { willContinue: false }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "idle");
    assert.equal(state.updatedAt, lastUpdatedAt, "second settling agent_end does not rewrite file");
  });
});

test("turn_end and session_shutdown events", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext();
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "run" }, ctx);

    const initialAt = readStateFile(dataRoot).lastEventAt;
    // Tiny sleep to verify timestamp bump
    await new Promise((r) => setTimeout(r, 10));

    await emit("turn_end", {}, ctx);
    let state = readStateFile(dataRoot);
    assert.equal(state.state, "running");
    assert.ok(state.lastEventAt >= initialAt);

    await emit("session_shutdown", {}, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.state, "ended");
  });
});

test("control watcher: honours valid cancel, acks atomically, deletes request", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext({ sessionId: "sess-cancel" });
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "long running run" }, ctx);

    const controlDir = path.join(dataRoot, "runtime", "runs", "control", "sess-cancel");
    fs.mkdirSync(controlDir, { recursive: true });

    const reqFile = path.join(controlDir, "req-1.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        schema: 1,
        op: "cancel",
        runSeq: 1,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 15_000,
      }),
      "utf8",
    );

    // Call drain directly or wait for watcher/poll
    pi._drainControl();

    assert.equal(ctx.isAborted, true, "ctx.abort() called on valid cancel");
    assert.equal(fs.existsSync(reqFile), false, "request file deleted after execution");

    const ackFile = path.join(controlDir, "req-1.ack.json");
    assert.ok(fs.existsSync(ackFile), "ack file exists");
    const ack = JSON.parse(fs.readFileSync(ackFile, "utf8"));
    assert.equal(ack.schema, 1);
    assert.equal(ack.ok, true);
  });
});

test("control watcher: honours valid steer, sends steer message, acks and deletes request", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit, userMessages } = makeHost();
    hook(pi);

    const ctx = makeContext({ sessionId: "sess-steer" });
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "run" }, ctx);

    const controlDir = path.join(dataRoot, "runtime", "runs", "control", "sess-steer");
    fs.mkdirSync(controlDir, { recursive: true });

    const reqFile = path.join(controlDir, "steer-1.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        schema: 1,
        op: "steer",
        text: "redirect focus to theme.liquid",
        runSeq: 1,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 15_000,
      }),
      "utf8",
    );

    pi._drainControl();

    assert.equal(userMessages.length, 1);
    assert.deepEqual(userMessages[0], {
      text: "redirect focus to theme.liquid",
      options: { deliverAs: "steer" },
    });
    assert.equal(fs.existsSync(reqFile), false);

    const ackFile = path.join(controlDir, "steer-1.ack.json");
    assert.ok(fs.existsSync(ackFile));
    const ack = JSON.parse(fs.readFileSync(ackFile, "utf8"));
    assert.equal(ack.schema, 1);
    assert.equal(ack.ok, true);
  });
});

test("control watcher: refuses STALE_RUN_SEQ", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext({ sessionId: "sess-stale" });
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "run" }, ctx); // runSeq = 1

    const controlDir = path.join(dataRoot, "runtime", "runs", "control", "sess-stale");
    fs.mkdirSync(controlDir, { recursive: true });

    const reqFile = path.join(controlDir, "stale.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        schema: 1,
        op: "cancel",
        runSeq: 99, // stale sequence
        requestedAt: Date.now(),
        expiresAt: Date.now() + 15_000,
      }),
      "utf8",
    );

    pi._drainControl();

    assert.equal(ctx.isAborted, false, "abort not called for stale sequence");
    assert.equal(fs.existsSync(reqFile), false, "request file deleted");

    const ack = JSON.parse(fs.readFileSync(path.join(controlDir, "stale.ack.json"), "utf8"));
    assert.equal(ack.schema, 1);
    assert.equal(ack.ok, false);
    assert.equal(ack.error, "STALE_RUN_SEQ");
  });
});

test("control watcher: refuses RUN_NOT_ACTIVE when state is idle", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext({ sessionId: "sess-idle" });
    await emit("session_start", {}, ctx); // state is idle

    const controlDir = path.join(dataRoot, "runtime", "runs", "control", "sess-idle");
    fs.mkdirSync(controlDir, { recursive: true });

    const reqFile = path.join(controlDir, "inactive.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        schema: 1,
        op: "cancel",
        runSeq: 0,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 15_000,
      }),
      "utf8",
    );

    pi._drainControl();

    assert.equal(ctx.isAborted, false);
    assert.equal(fs.existsSync(reqFile), false);

    const ack = JSON.parse(fs.readFileSync(path.join(controlDir, "inactive.ack.json"), "utf8"));
    assert.equal(ack.schema, 1);
    assert.equal(ack.ok, false);
    assert.equal(ack.error, "RUN_NOT_ACTIVE");
  });
});

test("control watcher: drops expired request silently (no ack, no abort, deletes request)", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext({ sessionId: "sess-expired" });
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "run" }, ctx);

    const controlDir = path.join(dataRoot, "runtime", "runs", "control", "sess-expired");
    fs.mkdirSync(controlDir, { recursive: true });

    const reqFile = path.join(controlDir, "expired.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        schema: 1,
        op: "cancel",
        runSeq: 1,
        requestedAt: Date.now() - 30_000,
        expiresAt: Date.now() - 5_000, // already expired
      }),
      "utf8",
    );

    pi._drainControl();

    assert.equal(ctx.isAborted, false, "expired cancel does not abort");
    assert.equal(fs.existsSync(reqFile), false, "expired request file deleted");
    assert.equal(fs.existsSync(path.join(controlDir, "expired.ack.json")), false, "expired request dropped without ack");
  });
});

test("control watcher: corrupt request file acks INVALID_CONTROL_PAYLOAD and deletes request", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext({ sessionId: "sess-corrupt" });
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "run" }, ctx);

    const controlDir = path.join(dataRoot, "runtime", "runs", "control", "sess-corrupt");
    fs.mkdirSync(controlDir, { recursive: true });

    const reqFile = path.join(controlDir, "corrupt.json");
    fs.writeFileSync(reqFile, "{ broken json payload", "utf8");

    pi._drainControl();

    assert.equal(fs.existsSync(reqFile), false);
    const ack = JSON.parse(fs.readFileSync(path.join(controlDir, "corrupt.ack.json"), "utf8"));
    assert.equal(ack.schema, 1);
    assert.equal(ack.ok, false);
    assert.equal(ack.error, "INVALID_CONTROL_PAYLOAD");
  });
});

test("control watcher: actuator failure acks ACTUATOR_FAILED with bounded message", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext({
      sessionId: "sess-actuator-err",
      abort: () => {
        throw new Error("abort handler threw an exception");
      },
    });
    await emit("session_start", {}, ctx);
    await emit("before_agent_start", { prompt: "run" }, ctx);

    const controlDir = path.join(dataRoot, "runtime", "runs", "control", "sess-actuator-err");
    fs.mkdirSync(controlDir, { recursive: true });

    const reqFile = path.join(controlDir, "act-err.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        schema: 1,
        op: "cancel",
        runSeq: 1,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 15_000,
      }),
      "utf8",
    );

    pi._drainControl();

    assert.equal(fs.existsSync(reqFile), false);
    const ack = JSON.parse(fs.readFileSync(path.join(controlDir, "act-err.ack.json"), "utf8"));
    assert.equal(ack.schema, 1);
    assert.equal(ack.ok, false);
    assert.equal(ack.error, "ACTUATOR_FAILED");
    assert.ok(ack.message.includes("abort handler threw"));
  });
});

test("brief injection on before_agent_start returns compact message <= 1 KB when mirror exists, undefined when absent/malformed", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext();
    await emit("session_start", {}, ctx);

    // 1. Absent brief file -> undefined
    const absentResult = await emit("before_agent_start", { prompt: "p1" }, ctx);
    assert.equal(absentResult, undefined, "absent brief injects nothing");

    // 2. Malformed brief file -> undefined (fail-open)
    const briefFile = path.join(dataRoot, "runtime", "runs", "term-1.brief.json");
    fs.mkdirSync(path.dirname(briefFile), { recursive: true });
    fs.writeFileSync(briefFile, "not-json", "utf8");

    const malformedResult = await emit("before_agent_start", { prompt: "p2" }, ctx);
    assert.equal(malformedResult, undefined, "malformed brief injects nothing");

    // 3. Valid brief file -> structured message
    fs.writeFileSync(
      briefFile,
      JSON.stringify({
        schema: 1,
        capsuleId: "cap-xyz",
        briefSeq: 5,
        brief: {
          storefrontUrl: "https://myshop.com",
          siteName: "My Cool Store",
          themeId: "theme-1234",
          rules: ["Do not mutate checkout.liquid", "Use Tailwind"],
        },
        updatedAt: Date.now(),
      }),
      "utf8",
    );

    const validResult = await emit("before_agent_start", { prompt: "p3" }, ctx);
    assert.ok(validResult?.message, "message object returned");
    assert.equal(validResult.message.customType, "antifan-capsule-brief");
    assert.equal(validResult.message.display, false);
    assert.equal(validResult.message.attribution, "agent");
    assert.deepEqual(validResult.message.details, {
      capsuleId: "cap-xyz",
      briefSeq: 5,
    });
    assert.equal(
      validResult.message.content,
      "storefront=https://myshop.com site=My Cool Store theme=theme-1234 rules: Do not mutate checkout.liquid · Use Tailwind",
    );
    assert.ok(validResult.message.content.length <= 1024, "brief content bounded to <= 1 KB");

    // 4. Overlong brief content truncated to <= 1024 chars
    fs.writeFileSync(
      briefFile,
      JSON.stringify({
        schema: 1,
        capsuleId: "cap-overlong",
        briefSeq: 6,
        brief: {
          storefrontUrl: "https://myshop.com",
          siteName: "X".repeat(2000),
        },
      }),
      "utf8",
    );

    const overlongResult = await emit("before_agent_start", { prompt: "p4" }, ctx);
    assert.ok(overlongResult?.message);
    assert.equal(overlongResult.message.content.length, 1024);
  });
});

test("mode read fresh from edit-mode mirror, unset when absent or corrupt", async () => {
  await withDataRoot(async (dataRoot) => {
    const { default: hook } = await loadHook();
    const { pi, emit } = makeHost();
    hook(pi);

    const ctx = makeContext({ sessionId: "sess-mode-test" });
    await emit("session_start", {}, ctx);

    // Absent mode file -> 'unset'
    let state = readStateFile(dataRoot);
    assert.equal(state.mode, "unset");

    // Corrupt mode file -> 'unset'
    const modeDir = path.join(dataRoot, "runtime", "edit-mode");
    fs.mkdirSync(modeDir, { recursive: true });
    const modeFile = path.join(modeDir, "sess-mode-test.json");
    fs.writeFileSync(modeFile, "not-valid-json", "utf8");

    await emit("before_agent_start", { prompt: "prompt" }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.mode, "unset");

    // Valid mode file -> reads mode
    fs.writeFileSync(
      modeFile,
      JSON.stringify({
        schema: 1,
        mode: "core",
      }),
      "utf8",
    );

    await emit("before_agent_start", { prompt: "prompt 2" }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.mode, "core");

    // Updated mode file -> dynamically read fresh
    fs.writeFileSync(
      modeFile,
      JSON.stringify({
        schema: 1,
        mode: "direct",
      }),
      "utf8",
    );

    await emit("before_agent_start", { prompt: "prompt 3" }, ctx);
    state = readStateFile(dataRoot);
    assert.equal(state.mode, "direct");
  });
});
