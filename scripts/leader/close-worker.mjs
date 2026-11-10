#!/usr/bin/env node
// close-worker.mjs - close worker terminals of THIS Leader and prove they are gone.
//
//   node scripts/leader/close-worker.mjs <terminalId>... [--leader T] [--keep-project] [--retries 3] [--settle-sec 15]
//        [--config-dir DIR] [--runs-dir DIR] [--events-file FILE]
//
// Why it exists (04/11/2026): `terminal.close` on terminal-181 answered EXECUTION_UNCERTAIN, the Leader never read
// `terminal.list` back and told the user it was closed; the terminal stayed open (idle) for 5 more minutes.
// This program calls `terminal.close { sessionId, removeMintedProject: true }`, then reads `terminal.list` until the
// id is gone (the call's own answer is never trusted), retries up to --retries times (default 3) when the call
// failed or the terminal is still listed, and prints `closed` or `still-open` per id.
// Only workers the Manager registry names under --leader (default: env ANTIFAN_TERMINAL_SESSION_ID) are closed:
// another Leader's worker, a split nobody registered and the Leader's own terminal are `refused` and no call is made.
// It talks to AntiFan through the same stdio MCP proxy OMP uses (scripts/antifan-agent.cjs mcp), as the Leader's
// terminal, so it MUST run from the Leader's own bash tool: it exits 2 unless env ANTIFAN_TERMINAL_SESSION_ID is a
// marked Leader and equals --leader (the proxy acts as the env terminal whatever --leader says; from a worker's scope
// terminal.list is empty and would read as "closed"). "Gone" needs terminal.list, the registry AND the run file
// <runs dir>/<terminal>.json (the Manager removes it a moment after the close answers) to agree.
//
// stdout: one JSON line per id `{type:"close", terminal, result: closed|run-file-lingering|still-open|refused|already-gone,
// attempts, projectRemoval?, error?, note?}` and a final `{type:"summary", exit, closed, lingering, stillOpen, refused}`.
// `run-file-lingering`: terminal.list and the registry no longer show the terminal but its run file is still there after
// --settle-sec; `leader-job.mjs status` counts that worker as open until the Manager removes the file.
// `projectRemoval.status` is the host's own word, printed unchanged: REMOVED (the project the worker's placement minted),
// REMOVED_CAPSULE (a capsule the placement minted that no project ever claimed; the folder is untouched), NO_PROJECT,
// REFUSED (`reason` is a code; the record stays, so closing the last worker in that folder asks again), FAILED, SKIPPED.
// Exit: 0 every id closed (or already gone), 1 at least one still open or lingering, 4 at least one refused, 2 usage.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendEvents, defaultDirs, incarnationOf, ledgerFileOf, readRegistry } from "./fleet-watch.mjs";

const TERMINAL_ID = /^[A-Za-z0-9_-]+$/;
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = path.resolve(SCRIPTS_DIR, "..", "antifan-agent.cjs");
const CALL_TIMEOUT_MS = 90_000;

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** `node`, even when this module runs inside OMP's own runtime, whose execPath is omp(.exe) and would start a full OMP. */
export function nodeBinary(execPath = process.execPath) {
  return /^node(\.exe)?$/i.test(path.basename(execPath)) ? execPath : "node";
}
/** Codes of a refusal a retry cannot change (a retry is for EXECUTION_UNCERTAIN, timeouts and a terminal that stays listed). */
const NON_RETRYABLE = /^(TERMINAL_FORBIDDEN|INVALID_ARGUMENT|POLICY_DENIED|REFUSED_\w+)$/;

/**
 * Close `ids`. deps: { registry() -> object|null, closeCall(id, { removeMintedProject }) -> Promise<result>,
 * isOpen(id) -> Promise<boolean> (true = still listed), runFileExists?(id) -> boolean (the run file is still there; omitted =
 * not checked), recordGone(id, incarnation), sleep(ms), now() }.
 * opts: { leader, retries = 3, settleMs = 15000, pollMs = 500, removeMintedProject = true }.
 * Returns { results: [...], code }.
 */
export async function closeWorkers(ids, deps, opts) {
  const retries = opts.retries ?? 3;
  const settleMs = opts.settleMs ?? 15_000;
  const pollMs = opts.pollMs ?? 500;
  const sleep = deps.sleep ?? sleepMs;
  const results = [];
  const registry = deps.registry();
  for (const id of ids) {
    const record = registry?.workers?.[id];
    if (!registry) {
      results.push({ type: "close", terminal: id, result: "refused", attempts: 0, note: "cannot read the Leader registry (leader-terminals.json): cannot confirm this is your worker" });
      continue;
    }
    if (id === opts.leader || (Array.isArray(registry.leaders) && registry.leaders.includes(id))) {
      results.push({ type: "close", terminal: id, result: "refused", attempts: 0, note: "a Leader terminal is never closed by close-worker" });
      continue;
    }
    if (!record) {
      // Not registered: already closed (the Manager forgets a closed terminal) or never a worker of anybody.
      const open = await deps.isOpen(id);
      results.push(
        open
          ? { type: "close", terminal: id, result: "refused", attempts: 0, note: "the terminal is open but the registry names no worker of that id: not provably yours, nothing called" }
          : { type: "close", terminal: id, result: "already-gone", attempts: 0 },
      );
      continue;
    }
    if (record.leaderId !== opts.leader) {
      results.push({ type: "close", terminal: id, result: "refused", attempts: 0, note: `registered under ${record.leaderId}, not under ${opts.leader}` });
      continue;
    }
    const incarnation = incarnationOf({ terminal: id, assignedAt: typeof record.assignedAt === "number" ? record.assignedAt : 0 });
    let attempts = 0;
    let lastError = null;
    let projectRemoval = null;
    let gone = false;
    let lingering = false;
    let nonRetryable = false;
    while (attempts < retries && !gone) {
      attempts++;
      try {
        const res = await deps.closeCall(id, { removeMintedProject: opts.removeMintedProject !== false });
        lastError = null;
        if (res && res.projectRemoval) projectRemoval = res.projectRemoval;
      } catch (e) {
        lastError = { code: e.code ?? "ERROR", message: String(e.message ?? e).slice(0, 300) };
        if (NON_RETRYABLE.test(lastError.code)) nonRetryable = true;
      }
      // The call's answer (also EXECUTION_UNCERTAIN) proves nothing: read the terminal list until the id is gone and
      // its run file with it. A terminal that is no longer listed but whose run file stays after the window is not
      // closed again (another call cannot remove the file): it is reported as lingering. The Manager said no for a
      // reason a retry cannot change (nonRetryable): look once while the terminal is listed, do not spend the retries.
      const deadline = deps.now() + settleMs;
      let listed = true;
      for (;;) {
        listed = await deps.isOpen(id);
        const runFile = !listed && deps.runFileExists ? deps.runFileExists(id) : false;
        if (!listed && !runFile) {
          gone = true;
          break;
        }
        if (deps.now() >= deadline || (nonRetryable && listed)) break;
        await sleep(pollMs);
      }
      if (!gone && !listed) {
        lingering = true;
        break;
      }
      if (nonRetryable) break;
    }
    if (gone || lingering) deps.recordGone?.(id, incarnation);
    if (lingering) {
      results.push({ type: "close", terminal: id, result: "run-file-lingering", attempts, ...(projectRemoval ? { projectRemoval } : {}), note: `terminal.list and the registry no longer show it but its run file is still there after ${Math.round(settleMs / 1000)} s: the Manager has not removed it yet (leader-job status counts the worker as open until then); read status again in a few seconds` });
    } else if (gone) {
      results.push({ type: "close", terminal: id, result: "closed", attempts, ...(projectRemoval ? { projectRemoval } : {}), ...(lastError ? { lastError } : {}) });
    } else {
      results.push({ type: "close", terminal: id, result: "still-open", attempts, ...(lastError ? { error: lastError } : {}), note: "terminal.list still shows it after every attempt: close it again or report it" });
    }
  }
  const refused = results.filter((r) => r.result === "refused").length;
  const stillOpen = results.filter((r) => r.result === "still-open" || r.result === "run-file-lingering").length;
  return { results, code: refused ? 4 : stillOpen ? 1 : 0 };
}

// -------------------------------------------------------------------------------------- stdio MCP client

/** Minimal newline-delimited JSON-RPC client over `antifan-agent.cjs mcp` (the proxy OMP itself uses). */
export class McpStdio {
  constructor(spawnImpl = spawn) {
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.buf = "";
    this.pending = new Map();
    this.nextId = 0;
  }

  async start() {
    this.child = this.spawnImpl(nodeBinary(), [AGENT_SCRIPT, "mcp"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.child.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = msg.id != null ? this.pending.get(msg.id) : null;
        if (waiter) {
          this.pending.delete(msg.id);
          waiter(msg);
        }
      }
    });
    this.child.on("exit", () => {
      for (const waiter of this.pending.values()) waiter({ error: { message: "MCP proxy exited" } });
      this.pending.clear();
    });
    await this.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "close-worker", version: "1" } }, 60_000);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  rpc(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out after ${timeoutMs} ms`), { code: "EXECUTION_UNCERTAIN" }));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Call one tool; returns its parsed JSON text (or the raw text), throws with `.code` when the tool reports an error. */
  async call(name, args) {
    const msg = await this.rpc("tools/call", { name, arguments: args });
    if (msg.error) throw Object.assign(new Error(msg.error.message ?? "MCP error"), { code: msg.error.code ? String(msg.error.code) : "ERROR" });
    const text = (msg.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // plain text
    }
    if (msg.result?.isError) {
      const code = (typeof parsed === "object" && parsed && (parsed.code || parsed.error?.code)) || /\b[A-Z][A-Z_]{5,}\b/.exec(text)?.[0] || "ERROR";
      throw Object.assign(new Error(text.slice(0, 300)), { code: String(code) });
    }
    return parsed;
  }

  stop() {
    try {
      this.child?.kill();
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------------------------- CLI

export function parseArgs(argv, env = process.env) {
  const dirs = defaultDirs(env);
  const opts = { ids: [], leader: env.ANTIFAN_TERMINAL_SESSION_ID || null, removeMintedProject: true, retries: 3, settleMs: 15_000, configDir: dirs.configDir, runsDir: dirs.runsDir, eventsFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--leader") opts.leader = value();
    else if (a === "--keep-project") opts.removeMintedProject = false;
    else if (a === "--retries") opts.retries = Number(value());
    else if (a === "--settle-sec") opts.settleMs = Number(value()) * 1000;
    else if (a === "--config-dir") opts.configDir = value();
    else if (a === "--runs-dir") opts.runsDir = value();
    else if (a === "--events-file") opts.eventsFile = value();
    else if (a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    else if (TERMINAL_ID.test(a)) opts.ids.push(a);
    else throw new Error(`bad terminal id: ${a}`);
  }
  if (!opts.ids.length) throw new Error("pass at least one terminal id");
  if (!opts.leader || !TERMINAL_ID.test(opts.leader)) throw new Error("--leader <terminalId> is required (env ANTIFAN_TERMINAL_SESSION_ID is not set)");
  if (!Number.isInteger(opts.retries) || opts.retries < 1) throw new Error("--retries must be an integer >= 1");
  if (!(opts.settleMs > 0)) throw new Error("--settle-sec must be > 0");
  if (!opts.eventsFile) opts.eventsFile = ledgerFileOf(dirs, opts.leader);
  return opts;
}

/**
 * The MCP proxy this script spawns acts as the terminal named in env ANTIFAN_TERMINAL_SESSION_ID, whatever --leader
 * says. Only a Leader's own terminal may close other terminals, so anything else would run `terminal.close` and
 * `terminal.list` in a worker's scope (refusals, or an empty list that reads as "closed"). Returns the reason, or null.
 */
export function scopeProblem(opts, env, registry) {
  const own = env.ANTIFAN_TERMINAL_SESSION_ID || null;
  if (own !== opts.leader) {
    return `--leader ${opts.leader} differs from this terminal (${own ?? "ANTIFAN_TERMINAL_SESSION_ID unset"}): the close would run in the wrong scope. Run it from the Leader's own bash tool and drop --leader`;
  }
  if (!registry) return "cannot read the Leader registry (leader-terminals.json): cannot confirm this terminal is a Leader";
  if (!Array.isArray(registry.leaders) || !registry.leaders.includes(own)) {
    return `${own} is not a marked Leader terminal: its terminal.close/terminal.list would run with a worker's rights`;
  }
  return null;
}

export async function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const problem = scopeProblem(opts, env, readRegistry(opts.configDir));
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return 2;
  }
  const mcp = new McpStdio();
  try {
    await mcp.start();
  } catch (e) {
    mcp.stop();
    process.stderr.write(`cannot start the AntiFan MCP proxy: ${e.message}\n`);
    return 2;
  }
  const registry = () => readRegistry(opts.configDir);
  const deps = {
    registry,
    now: Date.now,
    sleep: sleepMs,
    closeCall: (id, extra) => mcp.call("terminal.close", { sessionId: id, ...extra }),
    // Two witnesses, both must say gone: terminal.list (an empty or out-of-scope list proves nothing) and the registry
    // (the Manager forgets a closed terminal's worker record as soon as it is closed).
    isOpen: async (id) => {
      let listed = false;
      try {
        const answer = await mcp.call("terminal.list", { includeBuffer: false });
        listed = Array.isArray(answer?.sessions) && answer.sessions.some((r) => r && r.id === id);
      } catch {
        // the registry alone decides
      }
      return listed || Boolean(registry()?.workers?.[id]);
    },
    runFileExists: (id) => fs.existsSync(path.join(opts.runsDir, `${id}.json`)),
    recordGone: (id, incarnation) => {
      try {
        appendEvents(opts.eventsFile, [{ key: `gone:${incarnation}`, kind: "worker-gone", terminal: id, incarnation, by: "close-worker" }], Date.now());
      } catch {
        // the ledger is a convenience; the close already happened
      }
    },
  };
  let outcome;
  try {
    outcome = await closeWorkers(opts.ids, deps, opts);
  } finally {
    mcp.stop();
  }
  const lines = outcome.results.map((r) => JSON.stringify(r));
  lines.push(
    JSON.stringify({
      type: "summary",
      exit: outcome.code,
      closed: outcome.results.filter((r) => r.result === "closed" || r.result === "already-gone").length,
      lingering: outcome.results.filter((r) => r.result === "run-file-lingering").map((r) => r.terminal),
      stillOpen: outcome.results.filter((r) => r.result === "still-open").map((r) => r.terminal),
      refused: outcome.results.filter((r) => r.result === "refused").map((r) => r.terminal),
    }),
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return outcome.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e.stack || e.message}\n`);
      process.exit(2);
    },
  );
}
