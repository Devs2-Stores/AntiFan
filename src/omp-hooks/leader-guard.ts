/**
 * Leader-guard hook - keeps a Leader terminal a coordinator.
 *
 * A Leader (a terminal marked in the Manager's `leader-terminals.json`) hands work to worker
 * OMP sessions and then monitors and independently verifies it. It never edits a theme,
 * pushes one, writes the customer's sheet, comments on the dashboard or sets a Stage; only a
 * worker does that. Two guards enforce the rule, and both apply to a Leader terminal only:
 *
 * - `session_stop`: blocks the Leader from ending its turn while a job it dispatched is still
 *   open (`state` dispatched | settled | reported in `<jobs root>/<job>/job.json`, written by
 *   `scripts/leader/leader-job.mjs`). The block is a continuation with the exact next command.
 *   It fails OPEN: an unreadable job file, a missing root or any error allows the stop, and
 *   OMP's own cap on session_stop continuations is a second fuse. Nothing here can trap a session.
 * - `tool_call`: refuses (`REFUSED_LEADER_*`) the calls that would do worker work:
 *   theme-file writes (edit/write/ast_edit and best-effort shell writes into a theme workspace),
 *   write-class theme CLI commands, the AntiFan tools that mutate a page or the sheet, and an
 *   in-page evaluate whose script writes (quickUpdate, addNewComment, cart writes, POST/PUT/
 *   PATCH/DELETE fetches). The three ways to reach an MCP tool are covered: the native tool name,
 *   `write xd://<tool>`, and an `eval` / `bash` text that names the tool.
 *
 * This is a guardrail for a cooperative Leader, not a sandbox. Known limits: a `.click()` on a
 * submit/buy element inside an evaluate script is not scanned; shell writes into a theme folder are
 * recognised by verb/redirect and path only, so a script that writes the files (`node x.js`,
 * `python -c`) is not seen; `anti.browser.navigate` to a state-changing GET is not seen. There is no
 * override switch. A guard failure never blocks a call (the gate fails open), because a stuck
 * Leader is an outage and the guard is advisory.
 *
 * Nothing in here throws: every handler catches.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { DEVICE_PATH_RE, WRITE_TOOLS, extractTargetPaths } from "./edit-guard-policy";
import { isInside, resolveWorkspaceShape } from "./theme-paths";
import { classifyThemeLine, mentionsThemeCli, planThemeCommand } from "./theme-push-policy";

export const LEADER_GUARD_CODES = {
  THEME_EDIT: "REFUSED_LEADER_THEME_EDIT",
  THEME_CLI: "REFUSED_LEADER_THEME_CLI",
  SHEET_WRITE: "REFUSED_LEADER_SHEET_WRITE",
  PAGE_ACTION: "REFUSED_LEADER_PAGE_ACTION",
  PAGE_WRITE_SCRIPT: "REFUSED_LEADER_PAGE_WRITE_SCRIPT",
  UNREADABLE: "REFUSED_LEADER_UNREADABLE",
} as const;

/** The Manager's Leader registry under the config dir (`src/main/leader/leader-registry.ts`). */
const LEADER_REGISTRY_FILE = "leader-terminals.json";
const DEFAULT_JOBS_ROOT = "E:/Work/scratch/leader";
const JOB_FILE = "job.json";
/** Job states in which the Leader still owes work: it must not end its turn. */
const OPEN_JOB_STATES: Record<string, true> = { dispatched: true, settled: true, reported: true };
const EXPRESSION_FILE_MAX_BYTES = 2 * 1024 * 1024;
const SHELL_TOKEN_LIMIT = 60;

const TRANSIENT_READ_CODES: Record<string, true> = { EBUSY: true, EPERM: true, EACCES: true, EMFILE: true };
const REGISTRY_READ_RETRIES = 2;
const REGISTRY_RETRY_DELAY_MS = 50;

type Env = Record<string, string | undefined>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cwdOf(ctx: unknown): string {
  const cwd = record(ctx).cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : process.cwd();
}

/** The directory the job ledgers live in; `LEADER_JOBS_ROOT` is the test seam. */
export function leaderJobsRoot(env: Env = process.env): string {
  const override = env.LEADER_JOBS_ROOT?.trim();
  return path.resolve(override && override.length > 0 ? override : DEFAULT_JOBS_ROOT);
}

/**
 * True when the terminal this OMP runs in is a Leader: its id is under `leaders` in the Manager's
 * registry. Read fresh per call (the user can mark or unmark a Leader at any time). The Manager
 * replaces the file atomically, and on Windows a reader can hit a lock error during that swap; those
 * are retried, and a registry still unreadable then counts as "not a Leader": wrongly treating the
 * user's own terminal as a Leader would refuse real work, while wrongly treating a Leader as ordinary
 * only drops a guardrail. No terminal id, no config dir, a missing or unparsable file: not a Leader.
 */
export async function isLeaderTerminal(env: Env = process.env): Promise<boolean> {
  const terminalId = env.ANTIFAN_TERMINAL_SESSION_ID?.trim();
  if (!terminalId) return false;
  const dataRoot = env.ANTIFAN_DATA_ROOT?.trim();
  const configDir = env.ANTIFAN_CONFIG_DIR?.trim() || (dataRoot ? path.join(dataRoot, "config") : "");
  if (!configDir) return false;
  const registryPath = path.join(configDir, LEADER_REGISTRY_FILE);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const file = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { leaders?: unknown };
      return Array.isArray(file?.leaders) && file.leaders.includes(terminalId);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (typeof code !== "string" || TRANSIENT_READ_CODES[code] !== true) return false;
      if (attempt >= REGISTRY_READ_RETRIES) return false;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, REGISTRY_RETRY_DELAY_MS);
      await promise;
    }
  }
}

// ---------------------------------------------------------------------------
// session_stop: open jobs
// ---------------------------------------------------------------------------

export interface OpenJob {
  dir: string;
  state: string;
  lastRound: number;
}

/**
 * The jobs of `terminalId` whose state says the Leader still owes work. A job file that cannot be read
 * or parsed is skipped, never reported: the stop guard fails open.
 */
export function findOpenJobs(terminalId: string, env: Env = process.env): OpenJob[] {
  const root = leaderJobsRoot(env);
  let names: string[];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const open: OpenJob[] = [];
  for (const name of names.sort()) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(root, name, JOB_FILE), "utf8")) as {
        leader?: { terminal?: unknown };
        state?: unknown;
        rounds?: Array<{ n?: unknown }>;
      };
      if (job?.leader?.terminal !== terminalId) continue;
      const state = job.state;
      if (typeof state !== "string" || OPEN_JOB_STATES[state] !== true) continue;
      const rounds = Array.isArray(job.rounds) ? job.rounds : [];
      const lastN = rounds.length > 0 ? Number(rounds[rounds.length - 1]?.n) : NaN;
      open.push({ dir: path.join(root, name).replace(/\\/g, "/"), state, lastRound: Number.isFinite(lastN) && lastN > 0 ? lastN : 1 });
    } catch {
      /* unreadable or corrupt job.json: fail open */
    }
  }
  return open;
}

const CLI = "node scripts/leader/leader-job.mjs";

function nextStep(job: OpenJob): string {
  if (job.state === "dispatched") {
    return `worker still running -> bash {async:true, timeout:0}: ${CLI} wait --job ${job.dir}  (its result wakes this session)`;
  }
  if (job.state === "settled") {
    return `worker settled -> ${CLI} validate-report --job ${job.dir} --round ${job.lastRound}, then ${CLI} verify-sheet --job ${job.dir} --round ${job.lastRound}, then verify the storefront yourself`;
  }
  return `report received -> ${CLI} verify-sheet --job ${job.dir} --round ${job.lastRound} and verify the storefront; the job ends as verified or needs_input`;
}

export function buildStopReason(open: OpenJob[]): string {
  const lines = open.map((job) => `- ${job.dir} [${job.state}]: ${nextStep(job)}`);
  return [
    "Do not end the turn: you still have open Leader jobs. Run these from E:/Work/apps/AntiFan:",
    ...lines,
    "Stopping is allowed once each job is needs_input, verified, user-approved or closed.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// tool_call: Leader work boundary
// ---------------------------------------------------------------------------

export interface LeaderRefusal {
  code: string;
  reason: string;
}

const HAND_OFF = "The Leader only coordinates and verifies: hand this to a worker (put it in the worker prompt and send it with the job's dispatch).";

function refuse(code: string, what: string): LeaderRefusal {
  return { code, reason: `${code}: ${what}. ${HAND_OFF}` };
}

/** `mcp__antifan_browser_anti_sheet_write_cell` | `anti.sheet.write_cell` | `xd://...` -> `anti_sheet_write_cell`. */
export function canonicalTool(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^(?:xd|mcp):\/\//, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^mcp_antifan_browser_/, "")
    .replace(/^mcp_/, "");
}

const SHEET_WRITERS = ["anti_sheet_write_cell"];
/** Tools that click, type, drop, upload or otherwise act on a page or the theme through a session. */
const PAGE_ACTORS = [
  "anti_agent_cursor_click",
  "anti_agent_cursor_type",
  "anti_agent_sequence",
  "anti_agent_file_upload",
  "anti_agent_drop",
  "anti_agent_drag",
  "theme_transaction_write_cas",
  "playwright_browser_click",
  "playwright_browser_type",
  "playwright_browser_fill_form",
  "playwright_browser_select_option",
  "playwright_browser_file_upload",
  "playwright_browser_press_key",
  "playwright_browser_drag",
  "playwright_browser_drop",
  "playwright_browser_run_code_unsafe",
];
const EVALUATORS = ["anti_browser_evaluate", "anti_browser_evaluate_frame", "playwright_browser_evaluate"];

function toolsRegex(names: string[]): RegExp {
  const body = names.map((name) => name.split("_").join("[._]")).join("|");
  return new RegExp(`(?<![a-z0-9])(?:${body})(?![a-z0-9])`, "i");
}
const SHEET_WRITER_TEXT_RE = toolsRegex(SHEET_WRITERS);
const PAGE_ACTOR_TEXT_RE = toolsRegex(PAGE_ACTORS);
const EVALUATOR_TEXT_RE = toolsRegex(EVALUATORS);

/**
 * Write patterns in an evaluate script. A `\\*` before a quote tolerates the script arriving as an
 * escaped JSON string. `.click()` on a submit/buy element is deliberately not scanned.
 */
const PAGE_WRITE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bquickUpdate\s*\(/, label: "quickUpdate(" },
  { re: /\baddNewComment\s*\(/, label: "addNewComment(" },
  { re: /\/cart\/(?:add|change|update|clear)/i, label: "/cart/(add|change|update|clear)" },
  { re: /method\s*:\s*\\*['"`](?:POST|PUT|PATCH|DELETE)\b/i, label: "method: POST|PUT|PATCH|DELETE" },
  { re: /\.open\(\s*\\*['"`](?:POST|PUT|PATCH|DELETE)\b/i, label: "XMLHttpRequest.open(POST|PUT|PATCH|DELETE)" },
];

function pageWriteLabel(text: string): string | null {
  for (const pattern of PAGE_WRITE_PATTERNS) if (pattern.re.test(text)) return pattern.label;
  return null;
}

interface ResolvedCall {
  tool: string;
  input: Record<string, unknown>;
  /** The raw JSON body of a `write xd://<tool>` call; empty otherwise. */
  rawBody: string;
}

/** A `write xd://<tool>` call is that tool: its name is in the path and its arguments are the JSON content. */
function resolveCall(toolName: string, input: Record<string, unknown>): ResolvedCall {
  const tool = canonicalTool(toolName);
  if (tool === "write") {
    const target = typeof input.path === "string" ? input.path.trim() : "";
    if (DEVICE_PATH_RE.test(target)) {
      const body = typeof input.content === "string" ? input.content : "";
      let parsed: Record<string, unknown> = {};
      try {
        parsed = record(JSON.parse(body));
      } catch {
        /* a body that is not JSON is scanned as raw text */
      }
      return { tool: canonicalTool(target), input: parsed, rawBody: body };
    }
  }
  return { tool, input, rawBody: "" };
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when `abs` lies in a theme workspace (Shopify or Haravan) and not in the job ledgers. The root
 * `resolveWorkspaceShape` finds must also hold the real theme shape: `templates/` next to one of
 * `layout/`, `sections/`, `snippets/`. A lone `.hrv-sync-state.json` or a stray `templates/` (both sit
 * in the user's home folder) would otherwise turn a whole drive subtree into "a theme".
 */
function isThemePath(abs: string, jobsRoot: string, env: Env): boolean {
  if (isInside(jobsRoot, abs)) return false;
  const start = isDirectory(abs) ? abs : path.dirname(abs);
  const themeRoot = resolveWorkspaceShape(start, env).themeRoot;
  if (themeRoot === null || !isDirectory(path.join(themeRoot, "templates"))) return false;
  return ["layout", "sections", "snippets"].some((sub) => isDirectory(path.join(themeRoot, sub)));
}

const FILE_WRITERS: Record<string, true> = { ...WRITE_TOOLS, file_write: true };

/** File targets a write-class tool names: the path keys, `[path#TAG]` headers and `ast_edit` `paths` (glob prefix). */
function fileTargetsOf(input: Record<string, unknown>): string[] {
  const targets = extractTargetPaths(input).filter((target) => !DEVICE_PATH_RE.test(target));
  if (Array.isArray(input.paths)) {
    for (const entry of input.paths) {
      if (typeof entry !== "string" || entry.trim().length === 0) continue;
      const fixed = entry.trim().replace(/[*?[{].*$/, "");
      targets.push(fixed.length > 0 ? fixed : ".");
    }
  }
  return targets;
}

const SHELL_WRITE_RE =
  /(?:^|[\s;&|(])(?:\d?>>?(?!&)|set-content|add-content|out-file|tee|cp|copy|copy-item|mv|move|move-item|rm|del|erase|remove-item|ren|rename-item|new-item|touch|mkdir|md)(?![\w-])/i;

/** Best-effort: a shell line with a write verb or redirect that names (or runs in) a theme workspace. */
function shellWritesTheme(command: string, cwd: string, jobsRoot: string, env: Env): string | null {
  if (!SHELL_WRITE_RE.test(command)) return null;
  if (isThemePath(cwd, jobsRoot, env)) return cwd;
  const tokens = command
    .replace(/["'`]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^\d?>>?/, ""))
    .filter((token) => token.length > 0 && !token.startsWith("-") && /[\\/.]/.test(token))
    .slice(0, SHELL_TOKEN_LIMIT);
  for (const token of tokens) {
    if (isThemePath(path.resolve(cwd, token), jobsRoot, env)) return token;
  }
  return null;
}

const SUBPROCESS_RE = /subprocess|os\.(?:system|popen|exec|spawn)|child_process|Bun\.(?:\$|spawn)|\bspawn\w*\s*\(|\bexec\w*\s*\(|(?:^|\n)\s*[!%]/;

/** The refusal for a shell line or eval cell that runs the theme CLI with a write-class action. */
function themeCliRefusal(text: string, kind: "bash" | "eval"): LeaderRefusal | null {
  if (!mentionsThemeCli(text)) return null;
  if (kind === "eval") {
    if (!SUBPROCESS_RE.test(text)) return null;
    return refuse(LEADER_GUARD_CODES.THEME_CLI, "this eval cell runs the theme CLI (hrv/haravan/shopify/sapo ... theme); run read-only theme commands through the bash tool instead");
  }
  const plan = classifyThemeLine(text);
  if (plan.decision === "none") return null;
  if (plan.decision === "block") {
    return refuse(
      LEADER_GUARD_CODES.THEME_CLI,
      `'${plan.command}' names the theme CLI in a shape that cannot be read as a plain read-only command (${plan.code}). Use one plain command per call, e.g. hrv theme info -j`,
    );
  }
  for (const cmd of plan.commands) {
    const helpOnly = cmd.flags.some((flag) => flag === "--help" || flag === "-h");
    const syncs = (cmd.action === "dev" || cmd.action === "push") && !helpOnly;
    if (syncs || planThemeCommand(cmd, null).decision !== "allow") {
      return refuse(LEADER_GUARD_CODES.THEME_CLI, `'${cmd.text.slice(0, 160)}' changes or syncs a theme; a Leader may only run read-only theme commands (list, info, help ...)`);
    }
  }
  return null;
}

/** Names a mutating AntiFan tool, or an evaluate tool together with a write pattern, inside a bash/eval text. */
function toolNameInTextRefusal(text: string): LeaderRefusal | null {
  if (SHEET_WRITER_TEXT_RE.test(text)) {
    return refuse(LEADER_GUARD_CODES.SHEET_WRITE, "this call writes a Google Sheet cell (anti.sheet.write_cell)");
  }
  const actor = PAGE_ACTOR_TEXT_RE.exec(text);
  if (actor) {
    return refuse(LEADER_GUARD_CODES.PAGE_ACTION, `this call uses '${actor[0]}', which clicks, types or writes through a page or the theme`);
  }
  if (EVALUATOR_TEXT_RE.test(text)) {
    const label = pageWriteLabel(text);
    if (label !== null) {
      return refuse(LEADER_GUARD_CODES.PAGE_WRITE_SCRIPT, `this in-page script contains a write (${label})`);
    }
  }
  return null;
}

function expressionOf(call: ResolvedCall, cwd: string): { text: string } | { unreadable: string } {
  const parts: string[] = [];
  if (call.rawBody.length > 0) parts.push(call.rawBody);
  if (typeof call.input.expression === "string") parts.push(call.input.expression);
  const file = call.input.expressionFile;
  if (typeof file === "string" && file.trim().length > 0) {
    const abs = path.resolve(cwd, file.trim());
    try {
      const size = fs.statSync(abs).size;
      if (size > EXPRESSION_FILE_MAX_BYTES) return { unreadable: `${abs} is larger than ${EXPRESSION_FILE_MAX_BYTES} bytes` };
      parts.push(fs.readFileSync(abs, "utf8"));
    } catch (err) {
      return { unreadable: `${abs} (${(err as Error)?.message ?? "unreadable"})` };
    }
  }
  return { text: parts.join("\n") };
}

/**
 * The refusal for one tool call of a Leader terminal, or null when it may run. Pure over the call plus
 * the filesystem (workspace shape, `expressionFile`); the caller decides that the terminal is a Leader.
 */
export function planLeaderToolCall(
  params: { toolName: string; input: Record<string, unknown>; cwd: string },
  env: Env = process.env,
): LeaderRefusal | null {
  const jobsRoot = leaderJobsRoot(env);
  const call = resolveCall(params.toolName, params.input);
  const { tool, input } = call;

  if (FILE_WRITERS[tool] === true) {
    for (const target of fileTargetsOf(input)) {
      const abs = path.resolve(params.cwd, target);
      if (isThemePath(abs, jobsRoot, env)) {
        return refuse(LEADER_GUARD_CODES.THEME_EDIT, `'${target}' is inside a theme workspace and a Leader never edits theme files`);
      }
    }
    return null;
  }

  if (SHEET_WRITERS.includes(tool)) {
    return refuse(LEADER_GUARD_CODES.SHEET_WRITE, "anti.sheet.write_cell writes a cell of the customer's sheet; only a worker writes it (read it back with the leader-job verify-sheet command)");
  }
  if (PAGE_ACTORS.includes(tool)) {
    return refuse(LEADER_GUARD_CODES.PAGE_ACTION, `'${tool}' acts on a page or the theme; read with anti.browser.evaluate (read-only expressions) and screenshots instead`);
  }
  if (EVALUATORS.includes(tool)) {
    const expression = expressionOf(call, params.cwd);
    if ("unreadable" in expression) {
      return refuse(LEADER_GUARD_CODES.UNREADABLE, `the evaluate script could not be read to check it for writes: ${expression.unreadable}`);
    }
    const label = pageWriteLabel(expression.text);
    if (label !== null) {
      return refuse(LEADER_GUARD_CODES.PAGE_WRITE_SCRIPT, `this in-page script contains a write (${label})`);
    }
    return null;
  }

  if (tool === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0 ? path.resolve(params.cwd, input.cwd.trim()) : params.cwd;
    const cli = themeCliRefusal(command, "bash");
    if (cli !== null) return cli;
    const named = toolNameInTextRefusal(command);
    if (named !== null) return named;
    const hit = shellWritesTheme(command, cwd, jobsRoot, env);
    if (hit !== null) return refuse(LEADER_GUARD_CODES.THEME_EDIT, `this shell line writes into a theme workspace ('${hit}')`);
    return null;
  }
  if (tool === "eval") {
    const code = typeof input.code === "string" ? input.code : "";
    return themeCliRefusal(code, "eval") ?? toolNameInTextRefusal(code);
  }
  return null;
}

// ---------------------------------------------------------------------------
// hook wiring
// ---------------------------------------------------------------------------

interface GuardPi {
  on?: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => void;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}

function warnSafely(pi: GuardPi, message: string): void {
  try {
    pi.logger?.warn?.(message);
  } catch {
    /* a logger that throws must not change a decision */
  }
}

export default function leaderGuardHook(pi: GuardPi): void {
  if (!pi || typeof pi.on !== "function") return;

  pi.on("session_stop", async () => {
    try {
      const terminalId = process.env.ANTIFAN_TERMINAL_SESSION_ID?.trim();
      if (!terminalId || !(await isLeaderTerminal())) return undefined;
      const open = findOpenJobs(terminalId);
      if (open.length === 0) return undefined;
      const reason = buildStopReason(open);
      warnSafely(pi, `[leader-guard] session_stop blocked: ${open.length} open job(s)`);
      return { decision: "block", reason };
    } catch {
      return undefined; // fail open: never trap the session
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!process.env.ANTIFAN_TERMINAL_SESSION_ID?.trim()) return undefined;
      const call = record(event);
      const toolName = String(call.toolName ?? call.name ?? "");
      if (toolName.trim().length === 0) return undefined;
      if (!(await isLeaderTerminal())) return undefined;
      const refusal = planLeaderToolCall({ toolName, input: record(call.input), cwd: cwdOf(ctx) });
      if (refusal === null) return undefined;
      warnSafely(pi, refusal.reason);
      return { block: true, reason: refusal.reason };
    } catch (err) {
      // A guard failure is not a verdict: the gate is advisory and a stuck Leader is an outage.
      warnSafely(pi, `[leader-guard] tool_call check failed, call allowed: ${(err as Error)?.message ?? String(err)}`);
      return undefined;
    }
  });
}
