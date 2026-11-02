/**
 * Leader-guard hook - keeps a Leader terminal a coordinator.
 *
 * A Leader (a terminal marked in the Manager's `leader-terminals.json`) hands work to worker
 * OMP sessions and then monitors and independently verifies it. It never edits a theme,
 * pushes one, writes the customer's sheet, comments on the dashboard or sets a Stage, and it does
 * not look into the work itself (it reads the LIST of work items, a worker reads their content);
 * only a worker does that. Three guards enforce the rule, and all apply to a Leader terminal only:
 *
 * - `session_stop`: blocks the Leader from ending its turn while a job it dispatched is still
 *   open (`state` dispatched | settled | reported in `<jobs root>/<job>/job.json`, written by
 *   `scripts/leader/leader-job.mjs`). The block is a continuation with the exact next command.
 *   It fails OPEN: an unreadable job file, a missing root or any error allows the stop, and
 *   OMP's own cap on session_stop continuations is a second fuse. Nothing here can trap a session.
 * - `tool_call`, write boundary: refuses (`REFUSED_LEADER_*`) the calls that would do worker work:
 *   theme-file writes (edit/write/ast_edit and best-effort shell writes into a theme workspace),
 *   write-class theme CLI commands, the AntiFan tools that mutate a page or the sheet, and an
 *   in-page evaluate whose script writes (quickUpdate, addNewComment, cart writes, POST/PUT/
 *   PATCH/DELETE fetches). The three ways to reach an MCP tool are covered: the native tool name,
 *   `write xd://<tool>`, and an `eval` / `bash` text that names the tool.
 * - `tool_call`, investigation budget: counts the calls that dig into the work - read/grep/glob/lsp/
 *   ast_edit on a path outside `LEADER_READ_ALLOW_ROOTS` (internal URIs are free), a shell or eval
 *   line that runs git (inspection subcommands), rg, grep, cat, ls, find and the like on such a path,
 *   eval that calls `archive.*` or reads `~/.omp/agent/sessions`, and web_search - and refuses the
 *   call after the `LEADER_INVESTIGATE_LIMIT`th with `REFUSED_LEADER_INVESTIGATE`. The count starts
 *   again at the Leader's next successful `terminal.create` / `terminal.write` (read from
 *   `tool_result`, so a failed or unconfirmed dispatch resets nothing). What a Leader does for a
 *   living never counts: `terminal.*`, `core.*`, todo, task, wait, ask, `leader-job.mjs`,
 *   `wait-workers.mjs`, read-only evaluate, anything in its job folder, merging a worker's branch.
 *   Only a session with a UI is budgeted: a subagent the Leader spawns (no UI, same env) is not,
 *   though the write boundary above still applies to it.
 *
 * This is a guardrail for a cooperative Leader, not a sandbox. Known limits: a `.click()` on a
 * submit/buy element inside an evaluate script is not scanned; shell writes into a theme folder are
 * recognised by verb/redirect and path only, so a script that writes the files (`node x.js`,
 * `python -c`) is not seen; `anti.browser.navigate` to a state-changing GET is not seen. The budget
 * judges a shell or eval line by its verbs and path literals, so a script that reads files
 * (`node x.js`, `python -c`), a dispatch made from inside an eval, a path held in a variable and a
 * `task` subagent that does the looking-into are not seen; the count lives in the memory of the OMP
 * session that loaded the hook, so a restart starts again at zero. There is no override switch. A
 * guard failure never blocks a call (the gate fails open), because a stuck Leader is an outage and
 * the guard is advisory.
 *
 * Nothing in here throws: every handler catches.
 */

import * as fs from "node:fs";
import * as os from "node:os";
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
  INVESTIGATE: "REFUSED_LEADER_INVESTIGATE",
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

const SHEET_WRITERS = ["anti_sheet_write_cell", "anti_sheet_write_range"];
/** Tools that click, type, drop, upload or otherwise act on a page or the theme through a session. */
const PAGE_ACTORS = [
  "anti_agent_cursor_click",
  "anti_agent_cursor_type",
  "anti_agent_sequence",
  "anti_agent_file_upload",
  "anti_agent_drop",
  "anti_agent_drag",
  "anti_agent_set_control",
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
// tool_call: investigation budget
// ---------------------------------------------------------------------------

/** Investigation calls a Leader may make between two worker dispatches; the next one is refused. */
export const LEADER_INVESTIGATE_LIMIT = 4;

/**
 * Where a Leader reads freely: its job ledger, the AntiFan data root, OMP config and skills, and the
 * Leader's own skill text and scripts. The job ledger and the data root also follow `LEADER_JOBS_ROOT`
 * and `ANTIFAN_DATA_ROOT`. Past OMP sessions (`<.omp>/agent/sessions`) are carved out of `.omp`: mining
 * them is investigating.
 */
export const LEADER_READ_ALLOW_ROOTS = [
  "E:/Work/scratch/leader",
  "E:/Work/.antifan-data",
  "C:/Users/Admin/.omp",
  "E:/Work/apps/AntiFan/skills",
  "E:/Work/apps/AntiFan/scripts/leader",
] as const;

/** Internal URIs are free to read; any other URL (`https://`, `pr://`, `ssh://` ...) is not a local path and is not. */
const FREE_URI_RE = /^(?:skill|xd|memory|local|out|agent|proc|history|artifact):\/\//i;
const ANY_URI_RE = /^[a-z][a-z0-9+.-]+:\/\//i;

const INVESTIGATE_HAND_OFF =
  'Bạn là Leader (điều phối). Đừng tự điều tra/làm việc: viết "Bước 0: điều tra và báo cáo" vào prompt rồi `terminal.create` một worker. Các tool điều phối vẫn dùng bình thường.';

const INVESTIGATE_PATH_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, lsp: true, ast_edit: true };

/** Programs that list or search files. A Leader's own commands (`node scripts/leader/...`) never start with one. */
const FILE_READ_VERBS: Record<string, true> = {
  rg: true,
  grep: true,
  egrep: true,
  fgrep: true,
  findstr: true,
  "select-string": true,
  sls: true,
  cat: true,
  type: true,
  head: true,
  tail: true,
  more: true,
  less: true,
  bat: true,
  wc: true,
  "get-content": true,
  gc: true,
  ls: true,
  dir: true,
  tree: true,
  find: true,
  fd: true,
  "get-childitem": true,
  gci: true,
};
/** For these the first operand is the pattern, not a path. */
const PATTERN_FIRST_VERBS: Record<string, true> = { rg: true, grep: true, egrep: true, fgrep: true, findstr: true, "select-string": true, sls: true, fd: true };
const CD_VERBS: Record<string, true> = { cd: true, chdir: true, pushd: true, "set-location": true, sl: true };
const NESTED_SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, pwsh: true, powershell: true, cmd: true };
const NESTED_SHELL_FLAG_RE = /^(?:-[a-z]*c|-command|\/[ck])$/i;
const SHELL_PREFIXES: Record<string, true> = { env: true, time: true, nohup: true, command: true, exec: true, sudo: true };
const PATH_LIKE_RE = /[\\/]|^~|^\.{1,2}$|^[A-Za-z]:|\.[A-Za-z0-9]+$/;

/** Inspecting git subcommands. Merging, worktree add/remove, commit, push ... are the Leader's integration steps, not investigating. */
const GIT_INSPECT_SUBCOMMANDS: Record<string, true> = {
  log: true,
  status: true,
  diff: true,
  show: true,
  blame: true,
  grep: true,
  "ls-files": true,
  "ls-tree": true,
  "rev-parse": true,
  "rev-list": true,
  shortlog: true,
  reflog: true,
  "cat-file": true,
  describe: true,
  "show-ref": true,
  "for-each-ref": true,
  "diff-tree": true,
  whatchanged: true,
};
const GIT_OPTIONS_WITH_VALUE: Record<string, true> = { "-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--namespace": true, "--exec-path": true };
const GIT_BRANCH_WRITE_FLAG_RE = /^-(?:[dDmMcCuf]|-(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))/;

const EVAL_ARCHIVE_RE = /(?<![\w.$\\/-])archive\s*\.\s*[A-Za-z_]\w*\s*\(/;
const SESSIONS_PATH_RE = /\.omp[\\/]+agent[\\/]+sessions/i;
const EVAL_WEB_RE = /\btool\s*\.\s*web_search\s*\(/;
const EVAL_READ_CALL_RE =
  /\b(?:open|read|read_text|read_bytes|readlines|readFile|readFileSync|readdir|readdirSync|listdir|scandir|walk|glob|rglob|iterdir)\s*\(|\bBun\s*\.\s*(?:file|Glob)\b|\bfs\s*\.|\btool\s*\.\s*(?:read|grep|glob|lsp|ast_edit)\s*\(/;
const ABSOLUTE_PATH_RE = /(?<!\w)(?:[A-Za-z]:[\\/]|~[\\/])[^\s"'`<>|?*)\]}]+/g;
const EVAL_SHELL_VERB_RE = /(?:^|\s)(git|rg|grep|egrep|fgrep|cat|ls|find|fd|head|tail|findstr|get-content|get-childitem|select-string)(?=\s|$)/gi;

function readRoots(env: Env): { allow: string[]; deny: string[] } {
  const allow: string[] = [...LEADER_READ_ALLOW_ROOTS, leaderJobsRoot(env), path.join(os.homedir(), ".omp")];
  const data = env.ANTIFAN_DATA_ROOT?.trim();
  if (data) allow.push(data);
  const deny = allow.filter((root) => path.basename(root) === ".omp").map((root) => path.join(root, "agent", "sessions"));
  return { allow, deny };
}

function expandHome(target: string): string {
  return /^~(?:[\\/]|$)/.test(target) ? path.join(os.homedir(), target.slice(1)) : target;
}

/** True when a Leader may read `target` (a path, a glob or a URL as a tool names it) without it counting. */
function readFree(target: string, cwd: string, env: Env): boolean {
  if (FREE_URI_RE.test(target)) return true;
  if (ANY_URI_RE.test(target)) return false;
  const base = expandHome(target.replace(/[*?[{].*$/, ""));
  const abs = path.resolve(cwd, base.length > 0 ? base : ".");
  const roots = readRoots(env);
  if (roots.deny.some((root) => isInside(root, abs))) return false;
  return roots.allow.some((root) => isInside(root, abs));
}

function pathEntries(value: unknown): string[] {
  return typeof value === "string" ? value.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0 && !entry.startsWith("!")) : [];
}

/** The files or folders an investigation tool looks into; the session cwd stands in where the tool defaults to it. */
function investigateTargets(tool: string, input: Record<string, unknown>, cwd: string): string[] {
  if (tool === "read") return extractTargetPaths(input);
  if (tool === "grep" || tool === "glob") {
    const entries = pathEntries(input.path);
    return entries.length > 0 ? entries : [cwd];
  }
  if (tool === "lsp") {
    const file = typeof input.file === "string" ? input.file.trim() : "";
    return file === "*" ? [cwd] : file.length > 0 ? [file] : [];
  }
  return Array.isArray(input.paths)
    ? input.paths.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

interface ShellStatement {
  words: string[];
  /** The stage filters the previous stage's output (it follows a `|`) instead of reading a file of its own. */
  piped: boolean;
}

/** Splits a shell line into statements (`;` `&&` `||` `&` newline) and pipeline stages (`|`) outside quotes. */
function shellStatements(line: string): ShellStatement[] {
  const statements: ShellStatement[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  let piped = false;
  const endWord = (): void => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endStatement = (nextPiped: boolean): void => {
    endWord();
    if (words.length > 0) statements.push({ words, piped });
    words = [];
    piped = nextPiped;
  };
  for (let i = 0; i < line.length && statements.length < SHELL_TOKEN_LIMIT; i += 1) {
    const ch = line.charAt(i);
    if (quote.length > 0) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === "\n" || ch === "\r" || ch === ";") {
      endStatement(false);
    } else if (ch === "|") {
      const double = line.charAt(i + 1) === "|";
      if (double) i += 1;
      endStatement(!double);
    } else if (ch === "&") {
      const prev = line.charAt(i - 1);
      const next = line.charAt(i + 1);
      if (next === "&") {
        i += 1;
        endStatement(false);
      } else if (prev === ">" || prev === "<" || next === ">") {
        word += ch;
        started = true;
      } else if (words.length > 0 || started) {
        endStatement(false);
      }
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      started = true;
    }
  }
  endStatement(false);
  return statements;
}

function verbOf(word: string): string {
  const base = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|com)$/, "");
}

/** The command of a statement: past `NAME=value` assignments and wrappers such as `env`, `time`, `sudo`. */
function leadingCommand(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i] as string;
    if (/^[A-Za-z_]\w*=/.test(word) || SHELL_PREFIXES[verbOf(word)] === true) i += 1;
    else break;
  }
  return words.slice(i);
}

/** Drops redirections (`> file`, `>file`, `2>&1`, `<<EOF`) so their targets are not mistaken for operands. */
function withoutRedirects(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    const redirect = /^(?:\d*[<>]{1,2}&?\d*|&>>?)(.*)$/.exec(word);
    if (redirect === null) {
      out.push(word);
    } else if ((redirect[1] as string).length === 0 && !/&\d*$/.test(word)) {
      i += 1;
    }
  }
  return out;
}

function gitInvestigation(args: string[]): string | null {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (GIT_OPTIONS_WITH_VALUE[arg] === true) i += 2;
    else if (arg.startsWith("-")) i += 1;
    else break;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  const rest = args.slice(i + 1);
  const inspects =
    GIT_INSPECT_SUBCOMMANDS[sub] === true ||
    (sub === "worktree" && rest[0] === "list") ||
    (sub === "stash" && (rest[0] === "list" || rest[0] === "show")) ||
    (sub === "branch" && !rest.some((arg) => !arg.startsWith("-") || GIT_BRANCH_WRITE_FLAG_RE.test(arg)));
  return inspects ? `git ${sub}` : null;
}

function fileReadInvestigation(verb: string, args: string[], cwd: string, env: Env): string | null {
  if (FILE_READ_VERBS[verb] !== true) return null;
  const words = withoutRedirects(args);
  let operands: string[];
  if (verb === "find") {
    const end = words.findIndex((word) => word.startsWith("-") || word === "(" || word === "\\(" || word === "!");
    operands = end < 0 ? words : words.slice(0, end);
  } else {
    operands = words.filter((word) => !word.startsWith("-"));
    if (PATTERN_FIRST_VERBS[verb] === true && operands.length > 1) operands = operands.slice(1);
  }
  const targets = operands.filter((word) => PATH_LIKE_RE.test(word));
  for (const target of targets.length > 0 ? targets : ["."]) {
    if (!readFree(target, cwd, env)) return `${verb} ${target}`.slice(0, 160);
  }
  return null;
}

/**
 * The investigation a shell line performs, or null. Only the first stage of a pipeline reads (a
 * `| rg ok` filters another command's output), `cd` moves the directory later statements run in, and
 * `bash -c` / `powershell -Command` bodies are read too.
 */
function shellInvestigation(line: string, cwd: string, env: Env, depth = 0): string | null {
  let here = cwd;
  for (const statement of shellStatements(line)) {
    if (statement.piped) continue;
    const words = leadingCommand(statement.words);
    const head = words[0];
    if (head === undefined) continue;
    const verb = verbOf(head);
    const args = words.slice(1);
    if (CD_VERBS[verb] === true) {
      const dest = args.find((arg) => !arg.startsWith("-") && arg.toLowerCase() !== "/d");
      if (dest !== undefined) here = path.resolve(here, expandHome(dest));
      continue;
    }
    if (NESTED_SHELLS[verb] === true) {
      const flag = args.findIndex((arg) => NESTED_SHELL_FLAG_RE.test(arg));
      if (flag >= 0 && depth < 2) {
        const hit = shellInvestigation(args.slice(flag + 1).join(" "), here, env, depth + 1);
        if (hit !== null) return hit;
      }
      continue;
    }
    const hit = verb === "git" ? gitInvestigation(args) : fileReadInvestigation(verb, args, here, env);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * The investigation an eval cell performs, or null: `archive.*`, past OMP sessions, a web search, a
 * subprocess that runs a file-reading program, or a file read on a path literal outside the allow-list.
 */
function evalInvestigation(code: string, cwd: string, env: Env): string | null {
  if (EVAL_ARCHIVE_RE.test(code)) return "eval archive.*";
  if (SESSIONS_PATH_RE.test(code)) return "eval ~/.omp/agent/sessions";
  if (EVAL_WEB_RE.test(code)) return "eval web_search";
  if (SUBPROCESS_RE.test(code)) {
    // Put every quote, bracket and comma between words, so ["git", "-C", p, "log"] and "git -C p log" read alike.
    const flat = code.replace(/\b[rbfu]{1,2}(?=["'])/gi, "").replace(/[[\](){}'"`,!%]/g, " ");
    for (const match of flat.matchAll(EVAL_SHELL_VERB_RE)) {
      const start = (match.index ?? 0) + match[0].length - (match[1] as string).length;
      const hit = shellInvestigation(flat.slice(start).split(/\r?\n/, 1)[0] ?? "", cwd, env);
      if (hit !== null) return `eval ${hit}`;
    }
  }
  if (EVAL_READ_CALL_RE.test(code)) {
    for (const literal of code.match(ABSOLUTE_PATH_RE) ?? []) {
      if (!readFree(literal, cwd, env)) return `eval reads ${literal}`.slice(0, 160);
    }
  }
  return null;
}

/**
 * What a call investigates, or null when it is not investigating: a native read-class tool (or its
 * `write xd://` spelling) on a path outside `LEADER_READ_ALLOW_ROOTS`, a shell or eval line that looks
 * into files or history, or a web search. Pure over the call plus the filesystem-free path rules.
 */
export function investigationLabel(
  params: { toolName: string; input: Record<string, unknown>; cwd: string },
  env: Env = process.env,
): string | null {
  const { tool, input } = resolveCall(params.toolName, record(params.input));
  if (tool === "web_search") return "web_search";
  if (INVESTIGATE_PATH_TOOLS[tool] === true) {
    for (const target of investigateTargets(tool, input, params.cwd)) {
      if (!readFree(target, params.cwd, env)) return `${tool} ${target}`.slice(0, 160);
    }
    return null;
  }
  if (tool === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0 ? path.resolve(params.cwd, input.cwd.trim()) : params.cwd;
    return shellInvestigation(command, cwd, env);
  }
  if (tool === "eval") return evalInvestigation(typeof input.code === "string" ? input.code : "", params.cwd, env);
  return null;
}

function investigateRefusal(label: string, limit: number): LeaderRefusal {
  return {
    code: LEADER_GUARD_CODES.INVESTIGATE,
    reason: `${LEADER_GUARD_CODES.INVESTIGATE}: ${INVESTIGATE_HAND_OFF} (${limit} lệnh điều tra đã dùng từ lần terminal.create/terminal.write gần nhất; lệnh bị chặn: ${label})`,
  };
}

function createInvestigateBudget(limit: number = LEADER_INVESTIGATE_LIMIT): { spend(label: string | null): LeaderRefusal | null; reset(): void } {
  let used = 0;
  return {
    spend(label) {
      if (label === null) return null;
      if (used >= limit) return investigateRefusal(label, limit);
      used += 1;
      return null;
    },
    reset() {
      used = 0;
    },
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : String(record(part).text ?? ""))).join("\n");
}

/**
 * A `tool_result` that shows the Leader handed work to a worker: a `terminal.create` or `terminal.write`
 * that did not fail and, for a write, that the host confirmed (`written:false` means no shell took it).
 */
function isWorkerDispatch(event: Record<string, unknown>): boolean {
  if (event.isError === true) return false;
  const tool = resolveCall(String(event.toolName ?? ""), record(event.input)).tool;
  if (tool !== "terminal_create" && tool !== "terminal_write") return false;
  try {
    return record(JSON.parse(contentText(event.content))).written !== false;
  } catch {
    return true;
  }
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
  const budget = createInvestigateBudget();

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
      const params = { toolName, input: record(call.input), cwd: cwdOf(ctx) };
      // The write boundary first: a call refused there spends nothing and keeps its own code; the budget
      // check and its count run in one synchronous step, so parallel calls cannot overdraw it. Only a
      // session that reports a UI is the Leader's own; an unclassifiable context fails open.
      const ownSession = record(ctx).hasUI === true;
      const refusal = planLeaderToolCall(params) ?? (ownSession ? budget.spend(investigationLabel(params)) : null);
      if (refusal === null) return undefined;
      warnSafely(pi, refusal.reason);
      return { block: true, reason: refusal.reason };
    } catch (err) {
      // A guard failure is not a verdict: the gate is advisory and a stuck Leader is an outage.
      warnSafely(pi, `[leader-guard] tool_call check failed, call allowed: ${(err as Error)?.message ?? String(err)}`);
      return undefined;
    }
  });

  pi.on("tool_result", (event) => {
    try {
      if (isWorkerDispatch(record(event))) budget.reset();
    } catch {
      /* a result that cannot be read leaves the count as it is */
    }
    return undefined;
  });
}
