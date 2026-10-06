/**
 * theme-qa-gate.ts — AntiFan annotation QA enforcement hook (repo source).
 *
 * Installed to user scope as `~/.omp/agent/hooks/post/antifan-theme-qa-gate.js`
 * by `scripts/install-omp-hooks.mjs`: that file is generated, so edit here.
 *
 * Contract: when a write/edit-class tool touches a REAL THEME FILE (layout/,
 * templates/, sections/, snippets/, assets/, config/) inside a workspace that
 * carries `.antifan/` (i.e. annotation-driven theme work), the consuming agent
 * must produce a fresh QA receipt at `<workspace>/.antifan/qa-receipts/*.json`
 * (emitted by the `theme.qa_validate` AntiFan MCP capability) OR declare the
 * matching terminal QA status in an ASSISTANT message, exactly as defined by
 * `SELF_QA_DIRECTIVE` steps 5-6 in `src/shared/annotation-prompt.ts`.
 *
 * Authority split (per advisory): AntiFan produces evidence (receipt file);
 * this runtime enforces the gate on OBSERVED edits, never on declared intent.
 *
 * Chat sessions in theme workspaces never receive SELF_QA_DIRECTIVE (that
 * string only lands in annotation-built prompts). Measured 2026-09-21 on
 * Seahorse2 `01a0c1aa`: the agent grepped/edited Liquid first; MCP inspect
 * tool_result in a theme cwd therefore carries an MCP-first directive, and a
 * pending edit reminds on each unmarked MUTATION result — read/grep/glob/bash
 * results stay clean (a pending reminder on every result spammed ~50 outputs
 * per armed turn without adding evidence).
 * Other deadlock hardening:
 *  - the pending flag carries a TTL, so a workspace without a receipt dir can
 *    never pin the gate forever;
 *  - the reminder is deduped against a result that already carries the marker;
 *  - only real theme paths arm the gate (reports/, plans/, docs/, scripts/ do not);
 *  - `reminderText()` never echoes a bypass token, and bypass detection reads
 *    assistant messages only, so the reminder can no longer self-clear the gate;
 *  - the micro lane (storefront decoupling P0): a CSS-leaf-only edit (single
 *    assets/ `*.css`/`*.scss` file, <=10 added lines, no Liquid) may close the
 *    gate via the SELF_QA_DIRECTIVE step-9 micro static token — validated
 *    against the OBSERVED edit, so a declaration can never launder a
 *    structural change into a static pass.
 *
 * Edit-mode scoping (`[⚡Direct-Edit]` / `[🚀Super-Fast]`): while the session's
 * mode is scoped the gate is silent — no reminder, no receipt demand, no churn
 * or MCP-first advisory, and no tool result counted toward the reminder cadence.
 * One `turn_end` line states what the run changed and that storefront QA was
 * skipped. The mode is read from the `antifan.edit-mode` entry the edit guard
 * latches into the session branch (see `./edit-mode`), with `ANTIFAN_EDIT_MODE`
 * as the fallback for a session that never latched one, so the guard and the
 * gate can never disagree about what the session is doing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  MODE_LABELS,
  SCOPED_MODES,
  readEditModeEnv,
  readEditModeFromBranch,
  type EditMode,
} from "./edit-mode";
import { resolveWorkspaceShape } from "./theme-paths";
import { DEVICE_PATH_RE } from "./edit-guard-policy";

interface ExtensionContext {
  cwd?: string;
  sessionId?: string;
  agentId?: string;
  /** Session manager of the running session: how a hook reads its own branch. */
  sessionManager?: {
    getSessionId?(): unknown;
    getBranch?(): unknown;
  };
  ui?: { notify?(message: string, level?: "info" | "warning" | "error"): void };
}

interface ToolCallEvent {
  toolName?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ToolResultEvent {
  toolName?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  isError?: boolean;
}

interface ContextEvent {
  messages?: unknown[];
}

/** Message a hook may inject into the session (see `pi.sendMessage`). */
interface CustomMessage {
  customType: string;
  content: string;
  display?: boolean;
  details?: Record<string, unknown>;
  attribution?: "user" | "agent";
}

interface HookAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContext) => void): void;
  on(
    event: "tool_result",
    handler: (event: ToolResultEvent, ctx: ExtensionContext) => { content?: unknown } | undefined
  ): void;
  on(event: "context", handler: (event: ContextEvent, ctx: ExtensionContext) => { messages?: unknown[] } | undefined): void;
  on(event: "turn_end", handler: (event: unknown, ctx: ExtensionContext) => void): void;
  on(event: "session_start", handler: () => void): void;
  /** Inject a custom message into the session (delivered + shown once per call). */
  sendMessage?(message: CustomMessage): void;
  /** Append a durable custom entry to the session branch. */
  appendEntry?(customType: string, data: unknown): void;
}

export const BRIDGE_HEALTH_HEARTBEAT_MS = 5000;
export const BRIDGE_HEALTH_STALE_MULTIPLIER = 3;
const BRIDGE_MARKER = "[theme-qa-gate:bridge]";
const OBSERVED_FAILURE_MARKERS = [
  "MCP_BRIDGE_OFFLINE",
  "BRIDGE_UNREACHABLE",
  "CONNECTION_FAILED",
  "PAIRING_UNAVAILABLE",
] as const;
/**
 * Observed-marker suspension only trusts results from AntiFan MCP tools.
 * Any other tool result that merely *mentions* a marker string — grep hits on
 * this source, changelog reads, pasted errors — must not suspend the gate:
 * that was the suspend/resume ping-pong loop observed in production.
 */
const ANTIFAN_TOOL_RE = /antifan_browser|antifan-omp|mcp__antifan/i;

const WRITE_TOOLS = new Set(["write", "edit", "ast_edit", "ast.edit", "patch", "append", "file.write"]);
const BYPASS_TOKENS = ["qaStatus: QA_UNAVAILABLE", "qaStatus:QA_UNAVAILABLE", "qaStatus: QA_INCONCLUSIVE", "qaStatus:QA_INCONCLUSIVE"];
const RECEIPT_DIR = path.join(".antifan", "qa-receipts");

/** A pending edit expires after 10 minutes: no receipt dir must never mean "forever". */
const PENDING_TTL_MS = 10 * 60_000;
/** A pending edit reminds on the first unmarked tool_result, then every Nth —
 * the gate must stay visible without spamming every result in the turn. */
const REMIND_EVERY = 4;
/** Marker of the appended QA reminder, used to dedupe against re-appends. */
const GATE_MARKER = "[theme-qa-gate]";
/** Marker of the one-shot write-churn advisory, used to count hints in tests. */
const CHURN_MARKER = "[theme-qa-gate:churn]";
/** Marker of the one-shot MCP-first directive injected on the first tool_result
 * in a theme cwd — chat has no annotation prompt, so this is the only injection. */
const MCP_FIRST_MARKER = "[theme-qa-gate:mcp-first]";
/** Marker of the one `turn_end` line that stands in for QA while a scoped mode is on. */
const EDIT_GUARD_MARKER = "[edit-guard]";
/** Edit-guard audit trail, per session: <workspaceRoot>/.antifan/edit-guard/<id>.jsonl. */
const EDIT_GUARD_LOG_PARTS = [".antifan", "edit-guard"];
const MCP_FIRST_TEXT =
  `\n\n${MCP_FIRST_MARKER} Live theme workspace. Visual claims need AntiFan MCP this turn — do not wait to be asked.\n` +
  `1. anti.browser.tabs.list. Bind the storefront tab (anti.browser.rebind_target on TARGET_MISMATCH). Navigate to the page in the user's screenshot or URL.\n` +
  `2. anti.inspect.dom on the named selector, then anti.screenshot.viewport. Do not read xd:// docs first; write JSON to the xd://mcp__antifan_browser_* path.\n` +
  `3. After a theme file edit: inspect + screenshot again, then theme.qa_validate with that tabId. Never call theme.qa_validate against Google or a blank tab (a 60s timeout is not a check).\n` +
  `Liquid/grep is not proof the storefront changed.`;

/** Soft churn advisory threshold: a full rewrite of an already-large file. */
const CHURN_LINE_THRESHOLD = 200;
/** Do not read pathologically large files just to count lines. */
const CHURN_MAX_BYTES = 4 * 1024 * 1024;
/** How many trailing messages the bypass scan inspects. */
const BYPASS_SCAN_WINDOW = 8;
/** Only real theme directories arm the QA gate. */
const THEME_PATH_RE = /(^|\/)(layout|templates|sections|snippets|assets|config)\//;

// --- Micro lane (storefront decoupling P0) ---------------------------------

/**
 * A single-file CSS-leaf edit with a tiny diff may close the gate statically:
 * no browser round-trip for `display:none` or a color change. The declaration
 * is only trusted AFTER the hook validates it against the edit it observed.
 */
const MICRO_TOKENS = ["qaStatus: QA_MICRO_STATIC", "qaStatus:QA_MICRO_STATIC"];
/** Max changed lines (additions + deletions + replaced spans) a micro declaration may cover. */
const MICRO_MAX_CHANGED_LINES = 10;
/** Only plain CSS leaves inside assets/ qualify — never Liquid, JS, or config. */
const MICRO_PATH_RE = /(^|\/)assets\/[^/]+\.(css|scss)$/i;
/** Any Liquid tag in the added text disqualifies the micro lane. */
const LIQUID_TAG_RE = /\{\{|\{%/;

/** workspaceRoot -> timestamp of the earliest still-unverified edit. */
const pendingEdits = new Map<string, number>();
interface HookSettingsFinding {
  rule: string;
  id?: string;
  file: string;
  line?: number;
  message?: string;
  detail?: string;
}
/** workspaceRoot -> settings regression findings from the latest receipt. */
const pendingSettingsFindings = new Map<string, HookSettingsFinding[]>();
/** Bypass / micro declarations, kept for auditability. */
const bypassLog: Array<{
  at: string;
  token: string;
  code?: string;
  micro?: { root?: string; accepted?: boolean; path?: string; changedLines?: number; reason?: string };
}> = [];
/** Micro-edit lane record: what the hook OBSERVED for the edit that armed the gate. */
interface MicroEditRecord {
  /** Root-relative POSIX paths edited since the gate armed. */
  paths: Set<string>;
  /** Total changed lines across observed edits (Infinity when any shape was unobservable). */
  changedLines: number;
  /** Liquid tag seen in any added text (true when unobservable). */
  hasLiquid: boolean;
}
/** workspaceRoot -> observed micro-edit record, drained with pendingEdits. */
const microEdits = new Map<string, MicroEditRecord>();
/** Absolute paths already warned about this session. */
const churnWarnedPaths = new Set<string>();
const pendingChurnHints = new Map<string, string>();
let toolResultCounter = 0;
/** One-shot MCP-first injection per session, reset on session_start. */
let mcpFirstInjected = false;
let bridgeOutageKey: string | null = null;

function isPidAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
      if (err.code === "ESRCH") return false;
      if (err.code === "EPERM") return true;
    }
    return false;
  }
}

interface BridgeFileResult {
  exists: boolean;
  corrupt: boolean;
  record: Record<string, unknown> | null;
}

function readBridgeFile(filePath: string): BridgeFileResult {
  try {
    if (!fs.existsSync(filePath)) {
      return { exists: false, corrupt: false, record: null };
    }
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { exists: true, corrupt: false, record: parsed as Record<string, unknown> };
    }
    return { exists: true, corrupt: true, record: null };
  } catch {
    return { exists: true, corrupt: true, record: null };
  }
}

export interface OutageEvidence {
  down: boolean;
  code: string;
  key: string;
}

export function bridgeOutageEvidence(content?: unknown, now = Date.now(), trustedMarkers = false): OutageEvidence {
  const text = trustedMarkers ? contentText(content) : "";
  if (text) {
    for (const marker of OBSERVED_FAILURE_MARKERS) {
      if (text.includes(marker)) {
        return { down: true, code: marker, key: marker };
      }
    }
  }

  const dataRoot = process.env.ANTIFAN_DATA_ROOT;
  if (!dataRoot) {
    return { down: false, code: "", key: "" };
  }

  const configDir = process.env.ANTIFAN_CONFIG_DIR || path.join(dataRoot, "config");
  const devFile = path.join(configDir, "bridge-dev.json");
  const prodFile = path.join(configDir, "bridge.json");

  const devResult = readBridgeFile(devFile);
  const prodResult = readBridgeFile(prodFile);

  if (!devResult.exists && !prodResult.exists) {
    return { down: false, code: "", key: "" };
  }

  type Candidate = {
    fileResult: BridgeFileResult;
    pid: number | null;
    pidAlive: boolean;
    updatedAt: number;
  };

  const candidates: Candidate[] = [];
  for (const res of [devResult, prodResult]) {
    if (!res.exists) continue;
    if (res.corrupt || !res.record) {
      candidates.push({ fileResult: res, pid: null, pidAlive: false, updatedAt: 0 });
    } else {
      const pid = typeof res.record.pid === "number" ? res.record.pid : null;
      const pidAlive = pid !== null ? isPidAlive(pid) : false;
      const updatedAt =
        typeof res.record.updatedAt === "number"
          ? res.record.updatedAt
          : typeof res.record.startedAt === "number"
            ? res.record.startedAt
            : 0;
      candidates.push({ fileResult: res, pid, pidAlive, updatedAt });
    }
  }

  let chosen: Candidate | null = null;
  const aliveCandidates = candidates.filter((c) => !c.fileResult.corrupt && c.pidAlive);
  if (aliveCandidates.length > 0) {
    aliveCandidates.sort((a, b) => b.updatedAt - a.updatedAt);
    chosen = aliveCandidates[0] ?? null;
  } else {
    const validCandidates = candidates.filter((c) => !c.fileResult.corrupt);
    if (validCandidates.length > 0) {
      validCandidates.sort((a, b) => b.updatedAt - a.updatedAt);
      chosen = validCandidates[0] ?? null;
    } else if (candidates.length > 0) {
      chosen = candidates[0] ?? null;
    }
  }

  if (!chosen) {
    return { down: false, code: "", key: "" };
  }

  if (chosen.fileResult.corrupt || !chosen.fileResult.record) {
    return { down: true, code: "HEALTH_RECORD_CORRUPT", key: "corrupt:HEALTH_RECORD_CORRUPT" };
  }

  const record = chosen.fileResult.record;
  const pid = typeof record.pid === "number" ? record.pid : 0;
  if (!isPidAlive(pid)) {
    return { down: true, code: "HEALTH_PID_DEAD", key: `${pid}:HEALTH_PID_DEAD` };
  }

  const heartbeatMs =
    typeof record.heartbeatMs === "number" && record.heartbeatMs > 0
      ? record.heartbeatMs
      : BRIDGE_HEALTH_HEARTBEAT_MS;
  const staleThreshold = BRIDGE_HEALTH_STALE_MULTIPLIER * heartbeatMs;
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : null;
  if (updatedAt !== null && now - updatedAt > staleThreshold) {
    return { down: true, code: "HEALTH_STALE", key: `${pid}:HEALTH_STALE` };
  }

  if (record.health === "down") {
    let failureCode = "HEALTH_DOWN";
    const failure = record.lastFailure;
    if (failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string") {
      failureCode = failure.code;
    }
    return { down: true, code: failureCode, key: `${pid}:${failureCode}` };
  }

  if (record.health === undefined && record.updatedAt === undefined) {
    return { down: false, code: "HEALTH_RECORD_LEGACY", key: `${pid}:HEALTH_RECORD_LEGACY` };
  }

  const healthStr = typeof record.health === "string" ? record.health : "listening";
  return { down: false, code: healthStr, key: `${pid}:${healthStr}` };
}
function extractTargetPaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const targets: string[] = [];
  for (const key of ["path", "file", "filePath", "target", "filename"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) targets.push(v.trim());
  }
  // edit tool: path(s) embedded in `[file#TAG]` headers of the patch input
  const raw = input.input;
  if (typeof raw === "string") {
    const headerRe = /\[([^#\]]+)#[^\]]*\]/g;
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(raw)) !== null) {
      const p = m[1]?.trim();
      if (p) targets.push(p);
    }
  }
  return Array.from(new Set(targets));
}

/** extractTargetPaths() may return absolute or cwd-relative paths — normalise to absolute. */
function toAbsolutePath(target: string, cwd: string): string {
  try {
    return path.normalize(path.isAbsolute(target) ? target : path.resolve(cwd, target));
  } catch {
    return target;
  }
}

/** POSIX path relative to `root`, or null when the path escapes / equals the root. */
function toRootRelative(root: string, absPath: string): string | null {
  try {
    const rel = path.relative(root, absPath);
    if (!rel) return null;
    if (path.isAbsolute(rel)) return null;
    const posix = rel.split(path.sep).join("/");
    if (posix === ".." || posix.startsWith("../")) return null;
    return posix;
  } catch {
    return null;
  }
}

/** Theme chat cwd: `.antifan/`, a `templates/` dir, or a path under `/customizes/`. */
function isThemeCwd(cwd: string | undefined): boolean {
  if (!cwd) return false;
  try {
    if (fs.existsSync(path.join(cwd, ".antifan"))) return true;
    if (fs.existsSync(path.join(cwd, "templates"))) return true;
  } catch {
    /* ignore */
  }
  return /\/customizes\//i.test(cwd.replace(/\\/g, "/"));
}

function mcpFirstMessage(): Record<string, unknown> {
  return {
    role: "custom",
    customType: "theme-qa-gate",
    content: MCP_FIRST_TEXT.replace(/^\n+/, ""),
    display: true,
    attribution: "agent",
    details: { kind: "mcp-first" },
  };
}

/**
 * A real annotation workspace: AnnotationManager.getStorageDirectories
 * pre-creates `.antifan/annotations/` + `.antifan/qa-receipts/` under a bound
 * project root. A bare `.antifan/` is NOT enough — shared roots like
 * `E:/Work/.antifan/` hold only `space.json` and `edit-guard/` logs, and
 * binding there pins the gate on a root whose receipt dir the project's
 * `theme.qa_validate` never writes (the permanent PENDING deadlock).
 */
function isAnnotationWorkspace(dir: string): boolean {
  try {
    for (const sub of ["annotations", "qa-receipts"]) {
      try {
        if (fs.statSync(path.join(dir, ".antifan", sub)).isDirectory()) return true;
      } catch {
        /* marker subdir absent */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Walk up from a file path; a workspace is annotation-bound iff it carries a real annotation store. */
function findAnnotationWorkspace(filePath: string, cwd: string): string | null {
  let dir = path.dirname(path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath));
  for (let i = 0; i < 12; i++) {
    if (isAnnotationWorkspace(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// --- Edit-mode scoping (the QA half of the Direct/Super-Fast contract) -------

/** Session id of the running session, or "" when the host exposes none. */
function sessionIdOf(ctx: ExtensionContext | undefined): string {
  try {
    const raw = ctx?.sessionManager?.getSessionId?.();
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "";
  } catch {
    return "";
  }
}

interface ModeCacheEntry {
  mode: EditMode;
  /** Branch length the entry was derived from, with its tail entry by reference. */
  branchLength: number;
  branchTail: unknown;
}

/** ompSessionId -> last resolved mode, dropped as soon as the session branch moves. */
const sessionModes = new Map<string, ModeCacheEntry>();

/**
 * Mode that applies to this session: the `antifan.edit-mode` entry the edit
 * guard latched into the session branch (survives resume), else
 * `ANTIFAN_EDIT_MODE` (a session that never latched one), else `unset`.
 *
 * Derived at most once per session per branch state — a new branch entry is what
 * a mode change looks like, so appending one always invalidates the cache and a
 * `[🧠Core-Context]` prompt reopens the gate in the same session. Resolution
 * failures resolve to `unset`: the gate then keeps asking for QA, which is the
 * safe direction, and no error may escape a handler.
 */
function sessionMode(ctx: ExtensionContext | undefined): EditMode {
  try {
    // A throwing getBranch() leaves `branch` null, which reads as "no mode
    // latched": the gate then falls back to the env and to today's behaviour.
    let branch: unknown = null;
    try {
      branch = ctx?.sessionManager?.getBranch?.() ?? null;
    } catch {
      branch = null;
    }
    const branchLength = Array.isArray(branch) ? branch.length : -1;
    const branchTail = Array.isArray(branch) && branch.length > 0 ? branch[branch.length - 1] : null;
    const sessionId = sessionIdOf(ctx);
    if (sessionId) {
      const cached = sessionModes.get(sessionId);
      if (cached && cached.branchLength === branchLength && cached.branchTail === branchTail) {
        return cached.mode;
      }
    }
    const mode = readEditModeFromBranch(branch) ?? readEditModeEnv() ?? "unset";
    if (sessionId) sessionModes.set(sessionId, { mode, branchLength, branchTail });
    return mode;
  } catch {
    return "unset";
  }
}

interface AuditRunSummary {
  changedFiles: number | null;
  maxSeq: number | null;
}

/**
 * Distinct files the current run actually changed, read from the edit-guard audit
 * trail. A "run" is one `before_agent_start` and `runSeq` is the same counter the
 * Manager run card reads. Null when the trail is missing or unreadable — the
 * caller then states the skip without inventing a count.
 */
function auditRunSummary(workspaceRoot: string, sessionId: string): AuditRunSummary {
  if (!sessionId) return { changedFiles: null, maxSeq: null };
  try {
    // The guard sanitises the session id into the file name; a plain id (the
    // normal case) is unaffected, an exotic one still resolves to its log.
    const segment = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
    const logPath = path.join(workspaceRoot, ...EDIT_GUARD_LOG_PARTS, `${segment}.jsonl`);
    const rows: Array<Record<string, unknown>> = [];
    for (const line of fs.readFileSync(logPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row: unknown = JSON.parse(line);
        if (row && typeof row === "object") rows.push(row as Record<string, unknown>);
      } catch {
        /* a torn line must not hide the rest of the run */
      }
    }
    let maxSeq: number | null = null;
    for (const row of rows) {
      const seq = row.runSeq;
      if (typeof seq !== "number" || !Number.isFinite(seq)) continue;
      if (maxSeq === null || seq > maxSeq) maxSeq = seq;
    }
    if (maxSeq === null) return { changedFiles: 0, maxSeq: null };
    const changed = new Set<string>();
    for (const row of rows) {
      if (row.runSeq !== maxSeq || row.decision !== "allow") continue;
      if (typeof row.path === "string" && row.path.length > 0) changed.add(row.path);
    }
    return { changedFiles: changed.size, maxSeq };
  } catch {
    return { changedFiles: null, maxSeq: null };
  }
}

function changedFilesThisRun(workspaceRoot: string, sessionId: string): number | null {
  return auditRunSummary(workspaceRoot, sessionId).changedFiles;
}

/**
 * The one line a scoped turn ends with. With a readable audit trail it names the
 * files this run changed; without one it states the skip alone, because a count
 * nobody can ground is worse than no count.
 */
function scopedSkipText(mode: EditMode, changedFiles: number | null): string {
  const label = MODE_LABELS[mode];
  const head =
    changedFiles === null
      ? `${EDIT_GUARD_MARKER} ${label}: edit finished`
      : `${EDIT_GUARD_MARKER} ${label}: ${changedFiles} file(s) changed`;
  return `${head} — storefront QA skipped (send [🧠Core-Context] to run it)`;
}


interface ScopedSessionState {
  lastEmittedSeq: number | null;
  dirty: boolean;
}
const scopedSessionStates = new Map<string, ScopedSessionState>();
/** Newest receipt timestamp in one qa-receipts dir (0 when absent/empty/unreadable). */
interface ReceiptRecord {
  time: number;
  receipt: Record<string, unknown>;
}

/** Newest receipt record in one qa-receipts dir (null when absent/empty/unreadable).
 * Single-clock ordering: the .json file with the newest filesystem mtime is the
 * newest run. If that winner is unparseable (in-flight write, truncation), the
 * returned receipt body is {} so the gate stays armed rather than inheriting an
 * older QA_PASSED. createdAt is never used for ordering — a stale or skewed
 * timestamp could otherwise mask a newer corrupt receipt.
 */
function latestReceiptRecordInDir(dir: string): ReceiptRecord | null {
  let newestMtime = 0;
  let newestPaths: string[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestPaths = [fullPath];
        } else if (stat.mtimeMs === newestMtime && newestMtime > 0) {
          newestPaths.push(fullPath);
        }
      } catch {
        /* vanished between readdir and stat */
      }
    }
  } catch {
    return null;
  }
  if (newestPaths.length === 0 || newestMtime === 0) return null;
  // Corrupt wins ties deterministically: scan the winner set; a parse failure
  // returns a receipt stamped QA_UNREADABLE so the gate stays armed regardless
  // of readdir order. Valid JSON lacking a verdict keeps legacy semantics
  // (clears) — only unreadable or explicitly-failed receipts block clearing.
  let firstParsed: Record<string, unknown> | null = null;
  let sawCorrupt = false;
  for (const p of newestPaths) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
      // JSON.parse also accepts null/arrays/primitives — none is a receipt.
      // Only a non-null object can carry a verdict; anything else is unreadable.
      if (raw && typeof raw === "object" && !Array.isArray(raw) && !firstParsed) {
        firstParsed = raw as Record<string, unknown>;
      } else if (!(raw && typeof raw === "object" && !Array.isArray(raw))) {
        sawCorrupt = true;
      }
    } catch {
      sawCorrupt = true;
    }
  }
  if (sawCorrupt || !firstParsed) return { time: newestMtime, receipt: { verdict: "QA_UNREADABLE" } };
  return { time: newestMtime, receipt: firstParsed };
}

/** Newest receipt record for a workspaceRoot (probing direct and 1 level down). */
function latestReceiptRecord(workspaceRoot: string): ReceiptRecord | null {
  try {
    const direct = latestReceiptRecordInDir(path.join(workspaceRoot, RECEIPT_DIR));
    if (direct && direct.time > 0) return direct;
    let nestedLatest: ReceiptRecord | null = null;
    for (const child of fs.readdirSync(workspaceRoot)) {
      try {
        const childDir = path.join(workspaceRoot, child);
        if (!fs.statSync(childDir).isDirectory()) continue;
        const rec = latestReceiptRecordInDir(path.join(childDir, RECEIPT_DIR));
        if (rec && (!nestedLatest || rec.time > nestedLatest.time)) {
          nestedLatest = rec;
        }
      } catch {
        /* unreadable child */
      }
    }
    return nestedLatest;
  } catch {
    return null;
  }
}

/** Newest receipt timestamp in one qa-receipts dir (0 when absent/empty/unreadable). */
function latestReceiptInDir(dir: string): number {
  return latestReceiptRecordInDir(dir)?.time ?? 0;
}

/**
 * Newest receipt for a bound root. When the root's own dir yields nothing,
 * also probe exactly one level down — `<root>/<project>/.antifan/qa-receipts/` —
 * because `theme.qa_validate` confines receipts to the project workspaceRoot,
 * which can sit one directory under the ancestor the gate bound to (a bare
 * `.antifan/` ancestor may still hold the pending key while a real annotation
 * workspace below it receives the receipts).
 */
function latestReceiptTime(workspaceRoot: string): number {
  return latestReceiptRecord(workspaceRoot)?.time ?? 0;
}

/** Drop pending entries that a fresh receipt now covers, preserving armed status on settings regressions. */
function reconcileReceipts(): void {
  for (const [root, editTs] of pendingEdits) {
    const rec = latestReceiptRecord(root);
    if (rec && rec.time >= editTs) {
      const receipt = rec.receipt;
      const settingsRatchet = receipt.settingsRatchet as {
        ok?: boolean;
        findings?: HookSettingsFinding[];
        newFailures?: number;
      } | undefined;

      if (receipt.verdict === "QA_FAILED") {
        // DO NOT clear pendingEdits.delete(root). Keep gate armed for ANY failed
        // receipt — including non-Haravan and visual-only failures that carry no
        // settingsRatchet at all.
        // Settings findings are cached for reminder formatting only when the
        // ratchet itself reported new failures.
        if (settingsRatchet && settingsRatchet.ok === false) {
          const findings = Array.isArray(settingsRatchet.findings) ? settingsRatchet.findings : [];
          pendingSettingsFindings.set(root, findings);
        } else {
          // Ratchet clean or absent: drop stale settings findings left over from
          // an earlier regression so reminders never resurrect resolved data.
          pendingSettingsFindings.delete(root);
        }
      } else if (receipt.verdict === "QA_UNREADABLE") {
        // Corrupt/in-flight receipt selected as newest: keep the gate armed —
        // fail closed rather than trusting an unreadable verdict.
      } else {
        // QA_PASSED, absent verdict (legacy receipts), or any other value: clear.
        // An unreadable newest receipt never reaches this branch (QA_UNREADABLE).
        clearPending(root);
      }
    }
  }
}

/** Drop pending entries older than the TTL so a missing receipt dir cannot pin the gate forever. */
function pruneExpired(): void {
  try {
    const now = Date.now();
    for (const [root, editTs] of pendingEdits) {
      if (!Number.isFinite(editTs) || now - editTs > PENDING_TTL_MS) clearPending(root);
    }
  } catch {
    /* never throw out of a handler */
  }
}

/** Text carried by one content part of an unknown-shaped tool result. */
function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (part && typeof part === "object") {
    const rec = part as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.content === "string") return rec.content;
  }
  return "";
}

/** Flat text of a tool result content value, without crashing on unknown shapes. */
function contentText(content: unknown): string {
  try {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(partText).join("\n");
    return "";
  } catch {
    return "";
  }
}

function contentHasMarker(content: unknown, marker: string): boolean {
  return contentText(content).includes(marker);
}

/**
 * Append reminder/hint chunks to a tool result, preserving every content shape
 * the host may hand us (array of parts, plain string, anything else).
 */
function appendChunks(content: unknown, chunks: string[]): { content?: unknown } {
  const text = chunks.join("");
  if (Array.isArray(content)) {
    return { content: [...content, { type: "text", text }] };
  }
  if (typeof content === "string") {
    return { content: content + text };
  }
  return { content: [{ type: "text", text }] };
}

/**
 * Phase 6.1 soft write-churn advisory: a `write` that fully rewrites an already
 * large file should usually have been a targeted `edit` (measured: one session
 * ran 95 `write` against 8 `edit`). Advisory only — the write is never blocked,
 * and each file is warned about at most once per session.
 */
function maybeQueueChurnHint(absPath: string): void {
  try {
    if (churnWarnedPaths.has(absPath)) return;
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > CHURN_MAX_BYTES) return;
    let lines = 0;
    try {
      const text = fs.readFileSync(absPath, "utf8");
      lines = text.length === 0 ? 0 : text.split("\n").length;
    } catch {
      return;
    }
    if (lines <= CHURN_LINE_THRESHOLD) return;
    churnWarnedPaths.add(absPath);
    pendingChurnHints.set(
      absPath,
      `\n\n${CHURN_MARKER} ${absPath} already has ${lines} lines and was just fully rewritten by \`write\`. ` +
        `Prefer a targeted \`edit\` (anchored diff) for the remaining changes to this file — full-file rewrites of large files hide review diffs and risk silent truncation. ` +
        `Advisory only: the write was not blocked.`
    );
  } catch {
    /* missing/unreadable file: no advisory */
  }
}

/** Drain one-time churn hints queued by intervening tool_call events. */
function drainChurnHints(): string[] {
  if (pendingChurnHints.size === 0) return [];
  const hints: string[] = [];
  try {
    for (const [key, hint] of pendingChurnHints) {
      hints.push(hint);
      pendingChurnHints.delete(key);
    }
  } catch {
    /* never throw out of a handler */
  }
  return hints;
}

/**
 * Extract ONLY assistant-authored text content from an assistant message.
 * Tool-call arguments, function calls, or tool result metadata must never
 * be scanned, as an agent grepping or discussing a token string would otherwise
 * clear the gate illegitimately.
 */
function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (part && typeof part === "object") {
        const p = part as { type?: unknown; text?: unknown };
        if (p.type === "text" && typeof p.text === "string") {
          parts.push(p.text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Token scan anchored to ASSISTANT messages only. Scanning the whole tail
 * (including tool results) is what let the reminder text itself clear the
 * gate, so non-objects are skipped and `role` is read only when it is a string.
 * Shared by the audited bypass tokens and the micro-lane token: both are
 * declarations the agent must make in its own voice.
 */
function findTokenInMessages(messages: unknown[], tokens: readonly string[]): string | null {
  try {
    const window = messages.slice(-BYPASS_SCAN_WINDOW);
    for (const message of window) {
      if (!message || typeof message !== "object") continue;
      const role = (message as { role?: unknown }).role;
      if (typeof role !== "string" || role !== "assistant") continue;
      const text = assistantText(message);
      if (!text) continue;
      for (const token of tokens) {
        if (text.includes(token)) return token;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function findBypassToken(messages: unknown[]): string | null {
  return findTokenInMessages(messages, BYPASS_TOKENS);
}

// ---------------------------------------------------------------------------
// Micro lane (storefront decoupling P0)
// ---------------------------------------------------------------------------

interface ObservedEdit {
  changedLines: number;
  addedText: string;
}

/**
 * Count total changed lines in an edit patch including deletions and replacements.
 * Rules:
 *  - skip `+++`/`---` unified diff header lines;
 *  - count `+`-prefixed and `-`-prefixed lines as 1 each;
 *  - for `CUT a.=b:` / `PUT a.=b:` headers add `b - a + 1`;
 *  - `PUT >N:` / `PUT <N:` pure inserts add 0 (content lines are `+`-prefixed);
 *  - for `CUT|PUT N:` single-line forms add 1;
 *  - return that count (never 0 for a non-empty patch: if computed count is 0, use 1).
 */
function editChangedLines(patch: string): number {
  if (!patch || !patch.trim()) return 0;
  let count = 0;
  const lines = patch.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    // AST block ops (`CUT N*`, `PUT N*:`) and whole-file removal (`REM`) carry
    // spans the hook cannot observe from the patch text: fail closed.
    if (/\b(?:CUT|PUT)\s+[><]?\d+\*/i.test(line) || /^REM\b/i.test(line)) {
      return Number.POSITIVE_INFINITY;
    }
    if (rawLine.startsWith("+") || rawLine.startsWith("-")) {
      count += 1;
      continue;
    }
    const rangeMatch = line.match(/^(?:CUT|PUT)\s+(\d+)\.=(\d+)/i);
    if (rangeMatch) {
      // Both groups are mandatory in the pattern above; the fallback of "0"
      // keeps the count total (one changed line) rather than NaN if it loosens.
      const a = parseInt(rangeMatch[1] ?? "0", 10);
      const b = parseInt(rangeMatch[2] ?? "0", 10);
      count += Math.max(0, b - a + 1);
      continue;
    }
    if (/^PUT\s+[><]\d+/i.test(line)) {
      continue;
    }
    const singleMatch = line.match(/^(?:CUT|PUT)\s+\d+/i);
    if (singleMatch) {
      count += 1;
      continue;
    }
  }
  return count === 0 ? 1 : count;
}

/**
 * Added text and changed line count of a write/edit tool input; null when the shape
 * is unobservable (ast_edit/patch/append, or a malformed payload). Null fails closed:
 * the micro token never validates against an edit the hook could not inspect.
 */
function addedTextOf(toolName: string, input: Record<string, unknown> | undefined): ObservedEdit | null {
  try {
    if (toolName === "write") {
      if (typeof input?.content !== "string") return null;
      const lines = input.content.split("\n").length;
      return { changedLines: lines, addedText: input.content };
    }
    if (toolName === "edit") {
      if (typeof input?.input !== "string") return null;
      const changedLines = editChangedLines(input.input);
      const addedText = input.input
        .split("\n")
        .filter((line) => line.startsWith("+"))
        .map((line) => line.slice(1))
        .join("\n");
      return { changedLines, addedText };
    }
    return null;
  } catch {
    return null;
  }
}

/** Track what the hook OBSERVED for the edit that armed the gate. */
function recordMicroEdit(root: string, rel: string, added: ObservedEdit | null): void {
  const rec = microEdits.get(root) ?? { paths: new Set<string>(), changedLines: 0, hasLiquid: false };
  rec.paths.add(rel);
  if (added === null) {
    rec.changedLines = Number.POSITIVE_INFINITY;
    rec.hasLiquid = true;
  } else {
    // Totals accumulate across edits to the same root: the micro lane covers
    // the WHOLE observed change, not just the most recent hunk.
    rec.changedLines = Number.isFinite(rec.changedLines) ? rec.changedLines + added.changedLines : Number.POSITIVE_INFINITY;
    rec.hasLiquid = rec.hasLiquid || LIQUID_TAG_RE.test(added.addedText);
  }
  microEdits.set(root, rec);
}

/** A micro declaration only clears the gate when the observed edit qualifies. */
function microRecordQualifies(rec: MicroEditRecord | undefined): rec is MicroEditRecord {
  if (!rec) return false;
  if (rec.paths.size !== 1) return false;
  const rel = [...rec.paths][0];
  if (!rel || !MICRO_PATH_RE.test(rel)) return false;
  if (rec.changedLines > MICRO_MAX_CHANGED_LINES) return false;
  if (rec.hasLiquid) return false;
  return true;
}

/** Clear the pending edit AND its micro record AND cached settings findings for one root. */
function clearPending(root: string): void {
  pendingEdits.delete(root);
  microEdits.delete(root);
  pendingSettingsFindings.delete(root);
}

/**
 * The reminder deliberately never contains a BYPASS_TOKENS string (in either
 * spelling): it points at the authority instead, naming the terminal statuses
 * without reproducing the exact declaration the gate matches on. It also never
 * cites a repo-relative source path — the consuming session's cwd is the theme
 * workspace, where `src/shared/annotation-prompt.ts` does not resolve — so the
 * SELF_QA_DIRECTIVE contract steps are inlined here instead.
 */
function reminderText(): string {
  const allFindings: HookSettingsFinding[] = [];
  for (const root of pendingEdits.keys()) {
    const list = pendingSettingsFindings.get(root);
    if (list && list.length > 0) {
      allFindings.push(...list);
    }
  }

  if (allFindings.length > 0) {
    const formatted = allFindings
      .map((f) => {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        const idPart = f.id ? ` (${f.id})` : "";
        const idVal = f.id ?? "";
        return `${GATE_MARKER} QA GATE PENDING — Settings regression detected: ${f.rule} at ${loc}${idPart}. Fix: replace with '${idVal}' | asset_url.`;
      })
      .join("\n");
    return `\n\n${formatted}\nRun theme.qa_validate with tabId + workspaceRoot once resolved.`;
  }

  const roots = [...pendingEdits.keys()].join(", ");
  return (
    `\n\n${GATE_MARKER} QA GATE PENDING — theme file(s) under ${roots} were edited without a fresh AntiFan QA receipt. ` +
    `Before reporting done: run theme.qa_validate with tabId + workspaceRoot + expectedUrl (expectedUrl and annotationId are OPTIONAL per the tool schema; when no annotation "QA Binding" line exists, tabId + workspaceRoot alone is enough) so a receipt lands in .antifan/qa-receipts/. ` +
    `If a receipt is genuinely impossible, declare the matching SELF_QA_DIRECTIVE terminal status in your OWN assistant message — ` +
    `the QA_UNAVAILABLE terminal status when the capability is missing (re-probe once on CAPABILITY_NOT_FOUND, it may have registered after a restart) or auth fails (ATTACHMENT_REQUIRED / ATTACHMENT_INVALID / MCP_CONTEXT_REQUIRED / UNAUTHENTICATED); ` +
    `the QA_INCONCLUSIVE terminal status for environment failures (SETTLE_INCOMPLETE, CAPTURE_NOT_READY) after one reload/re-probe retry — each with the original error code. ` +
    `For a pure CSS micro edit (single plain assets/ *.css|*.scss file, <=10 changed lines total, no Liquid), declare the micro static terminal status with the file, selector and changed-line count in your own message — the gate validates it against the edit IT observed. ` +
    `Declaring QA_PASSED without a receipt is a contract violation. ` +
    `The gate clears on a fresh receipt or on that assistant-side declaration; nothing else clears it.`
  );
}

export default function themeQaGate(pi: HookAPI): void {
  pi.on("session_start", () => {
    try {
      pendingEdits.clear();
      microEdits.clear();
      pendingSettingsFindings.clear();
      churnWarnedPaths.clear();
      pendingChurnHints.clear();
      sessionModes.clear();
      toolResultCounter = 0;
      mcpFirstInjected = false;
      bridgeOutageKey = null;
      scopedSessionStates.clear();
    } catch {
      /* never throw out of a handler */
    }
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const toolName = String(event.toolName ?? event.name ?? "").toLowerCase();
      const targets = extractTargetPaths(event.input);
      const isDeviceOnly = targets.length > 0 && targets.every((t) => DEVICE_PATH_RE.test(t));
      const isWrite = WRITE_TOOLS.has(toolName) && !isDeviceOnly;
      const sessionKey = sessionIdOf(ctx) || (ctx?.cwd ?? process.cwd());
      const st = scopedSessionStates.get(sessionKey);
      if (st) {
        if (isWrite) st.dirty = true;
      } else {
        scopedSessionStates.set(sessionKey, { lastEmittedSeq: null, dirty: isWrite });
      }
      if (!isWrite) return;
      if (targets.length === 0) return;
      const cwd = ctx.cwd ?? process.cwd();
      const absTargets = Array.from(new Set(targets.map((t) => toAbsolutePath(t, cwd))));
      const isMulti = targets.length > 1 || absTargets.length > 1;
      const added = isMulti ? null : addedTextOf(toolName, event.input);
      const firstTarget = absTargets[0];
      if (toolName === "write" && firstTarget !== undefined) {
        maybeQueueChurnHint(firstTarget);
      }
      for (const target of targets) {
        const absTarget = toAbsolutePath(target, cwd);
        const root = findAnnotationWorkspace(absTarget, cwd);
        if (!root) continue;
        const rel = toRootRelative(root, absTarget);
        if (!rel || !THEME_PATH_RE.test(rel)) continue;
        if (!pendingEdits.has(root)) {
          const wasEmpty = pendingEdits.size === 0;
          pendingEdits.set(root, Date.now());
          // Re-arming after a cleared/expired gate must remind on the next
          // result, not wait out the previous cadence window.
          if (wasEmpty) toolResultCounter = 0;
        }
        recordMicroEdit(root, rel, added);
      }
    } catch {
      /* never throw out of a handler */
    }
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      if (SCOPED_MODES.includes(sessionMode(ctx))) {
        // Edit-mode scoping: the session's QA gate is off, so this result is not
        // counted toward the reminder cadence and carries no reminder, no churn
        // advisory and no MCP-first directive. Queued churn advisories belong to
        // the gate this mode silences, so they are dropped rather than replayed
        // once the mode is disarmed; `turn_end` states the skip instead.
        pendingChurnHints.clear();
        return undefined;
      }
      pruneExpired();
      const chunks: string[] = drainChurnHints();
      const evidence = bridgeOutageEvidence(
        event.content,
        Date.now(),
        ANTIFAN_TOOL_RE.test(String(event.toolName ?? event.name ?? ""))
      );
      if (evidence.down) {
        if (bridgeOutageKey !== evidence.key) {
          bridgeOutageKey = evidence.key;
          bypassLog.push({ at: new Date().toISOString(), token: "QA_GATE_SUSPENDED", code: evidence.code });
          pi.appendEntry?.("antifan-bridge-suspension", { key: evidence.key, code: evidence.code, at: Date.now() });
          chunks.push(
            `\n\n${BRIDGE_MARKER} QA gate suspended: bridge down (${evidence.code}) — declare the QA_UNAVAILABLE status explicitly when closing work; reminders resume when bridge health recovers.`
          );
        }
        if (chunks.length === 0) return undefined;
        return appendChunks(event.content, chunks);
      }

      if (bridgeOutageKey !== null) {
        const prevKey = bridgeOutageKey;
        bridgeOutageKey = null;
        const resumeCode = evidence.code || "listening";
        pi.appendEntry?.("antifan-bridge-resumed", { key: prevKey, code: resumeCode, at: Date.now() });
        chunks.push(`\n\n${BRIDGE_MARKER} bridge recovered (${resumeCode}) — QA gate reminders resumed`);
      }

      if (!mcpFirstInjected && isThemeCwd(ctx?.cwd) && !contentHasMarker(event.content, MCP_FIRST_MARKER)) {
        mcpFirstInjected = true;
        chunks.push(MCP_FIRST_TEXT);
      }
      if (pendingEdits.size > 0) {
        // Reconcile on EVERY result: a receipt written by theme.qa_validate (not
        // itself a write-class tool) must clear the gate promptly.
        reconcileReceipts();
        // …but the reminder only lands on a mutation-class result. A reminder on
        // every pending read/grep/bash output spammed ~50 results per turn once
        // armed; the reminder belongs on the result of a write/edit, right where
        // the unverified surface grows.
        const resultTool = String(event.toolName ?? event.name ?? "").toLowerCase();
        if (pendingEdits.size > 0 && WRITE_TOOLS.has(resultTool) && !contentHasMarker(event.content, GATE_MARKER)) {
          toolResultCounter += 1;
          if ((toolResultCounter - 1) % REMIND_EVERY === 0) {
            chunks.push(reminderText());
          }
        }
      }
      if (chunks.length === 0) return undefined;
      return appendChunks(event.content, chunks);
    } catch {
      return undefined;
    }
  });

interface RatchetStats {
  newCount: number;
  debtCount: number;
}

function readLatestRatchetStats(workspaceRoot: string): RatchetStats | null {
  try {
    const rec = latestReceiptRecord(workspaceRoot);
    if (rec?.receipt?.settingsRatchet && typeof rec.receipt.settingsRatchet === "object") {
      const sr = rec.receipt.settingsRatchet as { newFailures?: number; legacyDebt?: number };
      return {
        newCount: typeof sr.newFailures === "number" ? sr.newFailures : 0,
        debtCount: typeof sr.legacyDebt === "number" ? sr.legacyDebt : 0,
      };
    }

    const baselinePath = path.join(workspaceRoot, ".antifan", "settings-baseline.json");
    if (fs.existsSync(baselinePath)) {
      const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as {
        totalFindings?: number;
        counts?: Record<string, number>;
      };
      const debt = typeof parsed.totalFindings === "number"
        ? parsed.totalFindings
        : Object.values(parsed.counts || {}).reduce((s, c) => s + (typeof c === "number" ? c : 0), 0);
      return {
        newCount: 0,
        debtCount: debt,
      };
    }
  } catch {
    /* unreadable */
  }
  return null;
}

  /**
   * A scoped turn says one thing at its end: what this run changed and that
   * storefront QA was skipped. One line per turn is what replaces
   * `REMIND_EVERY = 1`'s reminder on every unmarked tool result.
   */
  pi.on("turn_end", (_event, ctx) => {
    try {
      const mode = sessionMode(ctx);
      if (!SCOPED_MODES.includes(mode)) return;
      const shape = resolveWorkspaceShape(ctx?.cwd ?? process.cwd());
      const sid = sessionIdOf(ctx);
      const sessionKey = sid || shape.workspaceRoot;
      const summary = auditRunSummary(shape.workspaceRoot, sid);
      const st = scopedSessionStates.get(sessionKey);
      const wasDirty = Boolean(st && st.dirty);

      // Deduplication guard against ping-pong infinite loop:
      // 1) If this runSeq has already been emitted for this session, skip:
      if (summary.maxSeq !== null && st && st.lastEmittedSeq === summary.maxSeq) {
        return;
      }
      // 2) If no audit sequence exists yet and the turn was not dirty (e.g. conversational
      // response triggered by the previous custom message), skip:
      if (summary.maxSeq === null && st && !st.dirty) {
        return;
      }

      scopedSessionStates.set(sessionKey, {
        lastEmittedSeq: summary.maxSeq,
        dirty: false,
      });
      if (wasDirty) {
        const stats = readLatestRatchetStats(shape.workspaceRoot);
        if (stats) {
          pi.sendMessage?.({
            customType: "theme-qa-gate",
            content: `[theme-qa-gate:scoped] Settings check: ${stats.newCount} new finding(s), ${stats.debtCount} legacy debt items. (Direct-Edit non-blocking)`,
            display: true,
            attribution: "agent",
            details: { kind: "settings-ratchet-scoped", mode, newCount: stats.newCount, debtCount: stats.debtCount },
          });
          return;
        }
      }

      pi.sendMessage?.({
        customType: "theme-qa-gate",
        content: scopedSkipText(mode, summary.changedFiles),
        display: true,
        attribution: "agent",
        details: { kind: "edit-guard-skip", mode, changedFiles: summary.changedFiles },
      });
    } catch {
      /* never throw out of a handler */
    }
  });

  pi.on("context", (event, ctx) => {
    try {
      if (SCOPED_MODES.includes(sessionMode(ctx))) {
        return undefined;
      }

      pruneExpired();
      const evidence = bridgeOutageEvidence();
      let outMessages: unknown[] | undefined;
      if (!evidence.down && bridgeOutageKey === null && !mcpFirstInjected && isThemeCwd(ctx?.cwd)) {
        mcpFirstInjected = true;
        const existing = Array.isArray(event.messages) ? event.messages : [];
        outMessages = [...existing, mcpFirstMessage()];
      }
      if (pendingEdits.size === 0) {
        return outMessages ? { messages: outMessages } : undefined;
      }
      const messages = event.messages;
      if (Array.isArray(messages)) {
        const token = findBypassToken(messages);
        if (token) {
          bypassLog.push({ at: new Date().toISOString(), token });
          pendingEdits.clear();
          microEdits.clear();
          return outMessages ? { messages: outMessages } : undefined;
        }
        const microToken = findTokenInMessages(messages, MICRO_TOKENS);
        if (microToken) {
          for (const root of [...pendingEdits.keys()]) {
            const rec = microEdits.get(root);
            if (microRecordQualifies(rec)) {
              bypassLog.push({
                at: new Date().toISOString(),
                token: microToken,
                micro: { root, accepted: true, path: [...rec.paths][0], changedLines: rec.changedLines },
              });
              clearPending(root);
            }
          }
          if (pendingEdits.size > 0) {
            bypassLog.push({
              at: new Date().toISOString(),
              token: microToken,
              micro: { accepted: false, reason: "no qualifying single-file CSS/SCSS micro edit (<=10 changed lines, no Liquid)" },
            });
          }
          return outMessages ? { messages: outMessages } : undefined;
        }
      }
      reconcileReceipts();
      return outMessages ? { messages: outMessages } : undefined;
    } catch {
      return undefined;
    }
  });
}

export { bypassLog };
