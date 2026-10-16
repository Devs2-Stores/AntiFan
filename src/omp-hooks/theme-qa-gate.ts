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
 *
 * QA debt: a scoped session that edited theme files without a later passing
 * receipt leaves `<workspaceRoot>/.antifan/qa-debt.json` ({ root, since, files[] },
 * the format `RESTYLE_MASTER_KIT/lib/receipt-audit.js` reads). It is written at
 * scoped `turn_end`, carried into the next session by `session_start`, named in
 * the reminder, and deleted when a complete passing receipt newer (file mtime)
 * than `since` exists. Only that receipt clears it; a declared status does not.
 */

import * as fs from "node:fs";
import * as os from "node:os";
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
  args?: Record<string, unknown>;
  details?: Record<string, unknown>;
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

export interface HookAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContext) => void): void;
  on(
    event: "tool_result",
    handler: (event: ToolResultEvent, ctx: ExtensionContext) => { content?: unknown } | undefined
  ): void;
  on(event: "context", handler: (event: ContextEvent, ctx: ExtensionContext) => { messages?: unknown[] } | undefined): void;
  on(event: "turn_end", handler: (event: unknown, ctx: ExtensionContext) => void): void;
  on(event: "session_start", handler: (event?: unknown, ctx?: ExtensionContext) => void): void;
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
const BYPASS_TOKENS = [
  "qaStatus: QA_UNAVAILABLE",
  "qaStatus:QA_UNAVAILABLE",
  "qaStatus: QA_INCONCLUSIVE",
  "qaStatus:QA_INCONCLUSIVE",
  // Local edit done, live verification waits on a theme sync only the user may run
  // (agents never push). An honest non-pass declaration, same standing as INCONCLUSIVE.
  "qaStatus: QA_PENDING_SYNC",
  "qaStatus:QA_PENDING_SYNC",
];
const RECEIPT_DIR = path.join(".antifan", "qa-receipts");
/** Open QA debt record read by the kit gate (`qa_gate.js`): { root, since (epoch ms), files[] }. */
const DEBT_FILE = path.join(".antifan", "qa-debt.json");

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
/**
 * workspaceRoot -> annotation files (absolute path -> mtime) present when the edit armed the gate.
 * Only these can scope a failing receipt: an annotation written or rewritten after the edit could
 * point the scope at any element.
 */
const annotationsAtArm = new Map<string, Map<string, number>>();

/** Annotation markdown files under the root and one level down (where receipts may also land). */
function snapshotAnnotations(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const scan = (dir: string): void => {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const full = path.join(dir, name);
        try {
          out.set(full, fs.statSync(full).mtimeMs);
        } catch {
          /* vanished between readdir and stat */
        }
      }
    } catch {
      /* no annotations here */
    }
  };
  scan(path.join(root, ".antifan", "annotations"));
  try {
    for (const child of fs.readdirSync(root)) {
      if (child.startsWith(".")) continue;
      scan(path.join(root, child, ".antifan", "annotations"));
    }
  } catch {
    /* unreadable root */
  }
  return out;
}

/** Whether the receipt's annotation was on disk, unchanged, before the edit that armed the gate. */
function annotationPredatesEdit(root: string, annotationId: unknown): boolean {
  if (typeof annotationId !== "string" || !annotationId.trim()) return false;
  const id = annotationId.trim();
  const digits = id.startsWith("annotation_") ? id.slice("annotation_".length) : null;
  for (const [file, mtimeAtArm] of annotationsAtArm.get(root) ?? []) {
    const name = path.basename(file);
    let names = name === `${id}.md` || (digits !== null && name === `element_${digits}.md`);
    try {
      if (fs.statSync(file).mtimeMs !== mtimeAtArm) continue;
      if (!names) names = fs.readFileSync(file, "utf8").includes(id);
    } catch {
      continue;
    }
    if (names) return true;
  }
  return false;
}
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
/** One open QA debt: theme files edited with no passing receipt newer than `since`. */
interface QaDebt {
  since: number;
  files: Set<string>;
}
/** workspaceRoot -> debt opened by a scoped (Direct-Edit/Super-Fast) edit or carried from disk. */
const openDebts = new Map<string, QaDebt>();
/** Roots whose in-memory debt has changes not yet persisted (flushed at scoped turn end). */
const dirtyDebtRoots = new Set<string>();
/** Session cwds whose debt file was already looked up. */
const debtAdoptedFrom = new Set<string>();
/** `${root}|${code}` of debt write failures already surfaced to the session. */
const reportedDebtWriteFailures = new Set<string>();
/** One-shot MCP-first injection per session, reset on session_start. */
let mcpFirstInjected = false;
let bridgeOutageKey: string | null = null;
let bridgeRecoveredCode: string | null = null;

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

function expandHome(target: string): string {
  const trimmed = target.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** extractTargetPaths() may return absolute, tilde, or cwd-relative paths — normalise to absolute. */
function toAbsolutePath(target: string, cwd: string): string {
  try {
    const expanded = expandHome(target);
    return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded));
  } catch {
    return target;
  }
}

function extractResultTargetPaths(event: ToolResultEvent): string[] {
  const fromInput = extractTargetPaths(event.input ?? event.args);
  if (fromInput.length > 0) return fromInput;
  const targets: string[] = [];
  if (event.details && typeof event.details === "object") {
    for (const key of ["resolvedPath", "path", "file", "filePath"]) {
      const v = event.details[key];
      if (typeof v === "string" && v.trim()) targets.push(v.trim());
    }
  }
  const text = contentText(event.content);
  if (text) {
    const headerRe = /^\[([^#\r\n\]]+)#[0-9A-Za-z]{3,8}\]/gm;
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(text)) !== null) {
      const p = m[1]?.trim();
      if (p && !p.startsWith("theme-qa-gate")) targets.push(p);
    }
  }
  return Array.from(new Set(targets));
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

const ANTIFAN_PKG_NAME = "antifan-browser-desktop";

/**
 * The AntiFan Desktop repo carries `.antifan/` dev artifacts and a `src/main/config/`
 * tree, so it looks like a theme workspace to every heuristic below. It is not one.
 */
function isAntiFanRepo(dir: string): boolean {
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === ANTIFAN_PKG_NAME) return true;
    } catch {
      /* no or unreadable package.json at this level */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** Theme chat cwd: `.antifan/`, a `templates/` dir, or a path under `/customizes/`. */
export function isThemeCwd(cwd: string | undefined): boolean {
  if (!cwd) return false;
  if (isAntiFanRepo(cwd)) return false;
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

const NON_THEME_SEGMENT_RE =
  /(^|\/)(?:\.claude|\.omp|\.agents)\/(?:agent\/)?(?:managed-)?skills(\/|$)|(^|\/)skills\/[^/]+\/(?:scripts|references|test|tests|fixtures)(\/|$)|(^|\/)(?:scripts\/)?(?:test|tests|__tests__)\/fixtures(\/|$)|(^|\/)fixtures\/(?:good|bad|mock-theme[^/]*)(\/|$)/i;
const TOP_THEME_REL_RE = /^(layout|templates|sections|snippets|assets|config)\//;
const NESTED_SUBTHEME_REL_RE =
  /^(?:(?!(?:scripts|test|tests|__tests__|fixtures|deliverables|plans|reports|docs|scratch|node_modules|\.[^/]+)\/)[^/]+\/)?(layout|templates|sections|snippets|assets|config)\//i;

function hasThemeRootLayout(dir: string): boolean {
  try {
    const hasLayoutLiquid =
      fs.existsSync(path.join(dir, "layout", "theme.liquid")) ||
      fs.existsSync(path.join(dir, "layout", "theme.bwt"));
    if (!hasLayoutLiquid) return false;
    return fs.statSync(path.join(dir, "config")).isDirectory();
  } catch {
    return false;
  }
}

function findNearestThemeRoot(absFilePath: string): string | null {
  let dir = path.dirname(absFilePath);
  for (let i = 0; i < 12; i++) {
    if (NON_THEME_SEGMENT_RE.test(dir.replace(/\\/g, "/"))) return null;
    if (hasThemeRootLayout(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Walk up from a file path; a workspace is annotation-bound iff it carries a real annotation store. */
function findAnnotationWorkspace(filePath: string, cwd: string): string | null {
  const abs = toAbsolutePath(filePath, cwd);
  if (NON_THEME_SEGMENT_RE.test(abs.replace(/\\/g, "/"))) return null;
  let dir = path.dirname(abs);
  for (let i = 0; i < 12; i++) {
    if (NON_THEME_SEGMENT_RE.test(dir.replace(/\\/g, "/"))) return null;
    if (isAnnotationWorkspace(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function resolveThemeTarget(
  target: string,
  cwd: string
): { absTarget: string; root: string; rel: string } | null {
  if (!target || DEVICE_PATH_RE.test(target) || target.toLowerCase().startsWith("xd://")) {
    return null;
  }
  const absTarget = toAbsolutePath(target, cwd);
  const normTarget = absTarget.replace(/\\/g, "/");
  if (NON_THEME_SEGMENT_RE.test(normTarget)) return null;
  const root = findAnnotationWorkspace(absTarget, cwd);
  if (!root || isAntiFanRepo(root)) return null;
  const rel = toRootRelative(root, absTarget);
  if (!rel || !THEME_PATH_RE.test(rel)) return null;
  const concreteThemeRoot = findNearestThemeRoot(absTarget);
  if (concreteThemeRoot) {
    const themeRelToRoot = toRootRelative(root, concreteThemeRoot);
    if (concreteThemeRoot !== path.normalize(root) && themeRelToRoot === null) {
      return null;
    }
    const relToTheme = toRootRelative(concreteThemeRoot, absTarget);
    if (!relToTheme || !TOP_THEME_REL_RE.test(relToTheme)) return null;
    return { absTarget, root, rel };
  }
  if (hasThemeRootLayout(root)) {
    if (!TOP_THEME_REL_RE.test(rel)) return null;
    return { absTarget, root, rel };
  }
  const normCwd = path.normalize(cwd);
  if (hasThemeRootLayout(normCwd) && toRootRelative(normCwd, absTarget) === null) {
    return null;
  }
  if (!NESTED_SUBTHEME_REL_RE.test(rel)) return null;
  return { absTarget, root, rel };
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
  editTs: number;
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

/** Same normalization as the kit receipt audit, so both sides agree on root identity. */
function normalizeRootKey(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** A receipt that can clear debt: a completed, passing run for exactly this root (kit `isComplete`). */
function isCompletePassReceipt(receipt: Record<string, unknown>, root: string): boolean {
  if (receipt.verdict !== "QA_PASSED" || receipt.passed !== true) return false;
  if (receipt.execution !== "COMPLETED" || receipt.errorCode !== null) return false;
  if (receipt.workspaceRootRedirected === true) return false;
  if (normalizeRootKey(receipt.workspaceRoot) !== normalizeRootKey(root)) return false;
  const coverage = receipt.coverage as { measured?: unknown; expected?: unknown } | undefined;
  if (
    coverage &&
    typeof coverage.measured === "number" &&
    typeof coverage.expected === "number" &&
    coverage.expected > 0 &&
    coverage.measured < coverage.expected
  ) {
    return false;
  }
  return true;
}

/** Whether a complete passing receipt is strictly newer (file mtime) than `since`. */
function passingReceiptAfter(root: string, since: number): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(root, RECEIPT_DIR));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(root, RECEIPT_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs <= since) continue;
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw) && isCompletePassReceipt(raw as Record<string, unknown>, root)) {
        return true;
      }
    } catch {
      /* an unreadable or in-flight receipt is not a pass */
    }
  }
  return false;
}

function readDebtFile(root: string): QaDebt | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, DEBT_FILE), "utf8")) as {
      root?: unknown;
      since?: unknown;
      files?: unknown;
    };
    if (normalizeRootKey(parsed.root) !== normalizeRootKey(root)) return null;
    const since = typeof parsed.since === "number" ? parsed.since : Date.parse(String(parsed.since));
    const files = Array.isArray(parsed.files) ? parsed.files.filter((f): f is string => typeof f === "string") : [];
    if (!Number.isFinite(since) || files.length === 0) return null;
    return { since, files: new Set(files) };
  } catch {
    return null;
  }
}

function writeDebtFile(root: string, debt: QaDebt): { ok: true } | { ok: false; code: string } {
  const file = path.join(root, DEBT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = { root: root.replace(/\\/g, "/"), since: debt.since, files: [...debt.files].sort() };
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort tmp cleanup */
    }
    const code = err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "WRITE_FAILED";
    return { ok: false, code };
  }
}

/** Drop every debt a newer complete passing receipt covers, deleting its file. */
function settleDebts(): void {
  for (const [root, debt] of [...openDebts]) {
    if (!passingReceiptAfter(root, debt.since)) continue;
    try {
      fs.rmSync(path.join(root, DEBT_FILE), { force: true });
    } catch {
      continue;
    }
    openDebts.delete(root);
    dirtyDebtRoots.delete(root);
  }
}

/** Carry a debt left by an earlier session into this one (nearest `.antifan/qa-debt.json` at or above cwd). */
function adoptDebt(cwd: string | undefined): void {
  if (!cwd || debtAdoptedFrom.has(cwd)) return;
  debtAdoptedFrom.add(cwd);
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, DEBT_FILE))) {
      if (!openDebts.has(dir)) {
        const debt = readDebtFile(dir);
        if (debt) openDebts.set(dir, debt);
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  settleDebts();
}

function noteScopedEdit(root: string, rel: string): void {
  settleDebts();
  const debt = openDebts.get(root);
  if (debt) debt.files.add(rel);
  else openDebts.set(root, { since: Date.now(), files: new Set([rel]) });
  dirtyDebtRoots.add(root);
}

/** Persist scoped-edit debt; a write failure is reported to the session once, never swallowed. */
function flushDebts(pi: HookAPI): void {
  settleDebts();
  for (const root of [...dirtyDebtRoots]) {
    const debt = openDebts.get(root);
    dirtyDebtRoots.delete(root);
    if (!debt) continue;
    const onDisk = readDebtFile(root);
    if (onDisk) {
      for (const file of onDisk.files) debt.files.add(file);
      debt.since = Math.min(debt.since, onDisk.since);
    }
    const written = writeDebtFile(root, debt);
    if (written.ok) continue;
    dirtyDebtRoots.add(root);
    const key = `${root}|${written.code}`;
    if (reportedDebtWriteFailures.has(key)) continue;
    reportedDebtWriteFailures.add(key);
    pi.sendMessage?.({
      customType: "theme-qa-gate",
      content: `[theme-qa-gate:debt] QA_DEBT_WRITE_FAILED (${written.code}): .antifan/qa-debt.json not written under ${root}; the kit gate cannot see the unverified edit.`,
      display: true,
      attribution: "agent",
      details: { kind: "qa-debt-write-failed", code: written.code, root },
    });
  }
}

function debtReminder(): string {
  if (openDebts.size === 0) return "";
  const parts = [...openDebts].map(([root, debt]) => {
    const files = [...debt.files];
    const shown = files.slice(0, 3).join(", ");
    return `${root}: ${files.length} file(s) since ${new Date(debt.since).toISOString()} (${shown}${files.length > 3 ? ", ..." : ""})`;
  });
  return ` Open QA debt (.antifan/qa-debt.json) until a passing receipt lands: ${parts.join("; ")}.`;
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
      const verdict = receipt.verdict;
      const hasAnnotationId = typeof receipt.annotationId === "string" && receipt.annotationId.trim().length > 0;
      const scopedCriticalCount =
        typeof receipt.scopedCriticalCount === "number" && Number.isFinite(receipt.scopedCriticalCount)
          ? receipt.scopedCriticalCount
          : null;
      const hasSettingsRegression = Boolean(settingsRatchet && settingsRatchet.ok === false);
      // The flag is authoritative; the findings scan covers receipts written before it existed.
      const hasAuthRedirectFinding =
        receipt.authRedirect === true ||
        Array.isArray(receipt.findings) &&
        receipt.findings.some(
          (f) =>
            Boolean(
              f &&
                typeof f === "object" &&
                typeof (f as Record<string, unknown>).message === "string" &&
                ((f as Record<string, unknown>).message as string).includes("AUTH_REDIRECT")
            )
        );
      const isFailVerdict = verdict === "QA_FAILED" || verdict === "FAIL";
      const isInconclusiveVerdict = verdict === "QA_INCONCLUSIVE" || verdict === "INCONCLUSIVE";
      const isPassVerdict =
        verdict === "QA_PASSED" ||
        verdict === "PASS" ||
        (verdict === undefined && receipt.passed !== false);
      // A scoped count is only evidence when the run completed: a DEGRADED execution means
      // some scanner did not report, so "0 scoped criticals" may just be missing findings.
      const executionCompleted = receipt.execution === "COMPLETED";
      const scopedGatePassed =
        isFailVerdict &&
        !hasAuthRedirectFinding &&
        hasAnnotationId &&
        annotationPredatesEdit(root, receipt.annotationId) &&
        scopedCriticalCount === 0 &&
        executionCompleted &&
        !hasSettingsRegression;

      if (verdict === "QA_UNREADABLE" || isInconclusiveVerdict) {
        // Corrupt/in-flight receipt or inconclusive/evidence-gap receipt
        // (AUTH_REDIRECT, unmeasured surface, capture timeout, etc.): keep the
        // gate armed — never clear through automatic receipt reconciliation.
        if (hasSettingsRegression && settingsRatchet) {
          const findings = Array.isArray(settingsRatchet.findings) ? settingsRatchet.findings : [];
          pendingSettingsFindings.set(root, findings);
        }
      } else if ((isFailVerdict && !scopedGatePassed) || (!isPassVerdict && !scopedGatePassed)) {
        // DO NOT clear pendingEdits.delete(root). Keep gate armed for ANY failed
        // receipt — including non-Haravan and visual-only failures that carry no
        // settingsRatchet at all — unless an annotation-scoped FAIL check proved 0
        // scoped critical defects (including 0 page-level/selector-less criticals).
        if (hasSettingsRegression && settingsRatchet) {
          const findings = Array.isArray(settingsRatchet.findings) ? settingsRatchet.findings : [];
          pendingSettingsFindings.set(root, findings);
        } else {
          pendingSettingsFindings.delete(root);
        }
      } else if (hasSettingsRegression && settingsRatchet) {
        const findings = Array.isArray(settingsRatchet.findings) ? settingsRatchet.findings : [];
        pendingSettingsFindings.set(root, findings);
      } else {
        // QA_PASSED, legacy pass receipt (verdict undefined), or scoped annotation
        // pass on a QA_FAILED verdict (scopedCriticalCount === 0, no settings regression): clear.
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

/** Whether a tool result is structured data a caller will parse: appended text would corrupt it. */
function parsesAsJson(content: unknown): boolean {
  const text = (Array.isArray(content) ? contentText(content) : partText(content)).trim();
  if (!/^[[{]/.test(text) || !/[\]}]$/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
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

/** `qaStatus: QA_X` declaration form; the single space is optional (both spellings are valid tokens). */
const STATUS_DECLARATION_RE = /qaStatus: ?(QA_[A-Z_]+)/g;

/** Fingerprints of timestamp-less declarations that already cleared a gate. */
const consumedDeclarations = new Set<string>();
const CONSUMED_DECLARATIONS_MAX = 64;

interface DeclarationHit {
  token: string;
  /** Set only for messages without a usable timestamp: lets the caller retire the declaration. */
  stamp: string | null;
}

function consumeDeclaration(hit: DeclarationHit): void {
  if (!hit.stamp) return;
  if (consumedDeclarations.size >= CONSUMED_DECLARATIONS_MAX) consumedDeclarations.clear();
  consumedDeclarations.add(hit.stamp);
}

/** Newest pending-edit time: a declaration only counts if the assistant made it after that edit. */
function latestPendingEditAt(): number {
  let latest = 0;
  for (const editTs of pendingEdits.values()) {
    if (Number.isFinite(editTs) && editTs > latest) latest = editTs;
  }
  return latest;
}

/**
 * Declaration scan anchored to ASSISTANT messages only. Scanning the whole tail
 * (including tool results) is what let the reminder text itself clear the
 * gate, so non-objects are skipped and `role` is read only when it is a string.
 * Shared by the audited bypass tokens and the micro-lane token: both are
 * declarations the agent must make in its own voice.
 *
 * Three rules keep a stale or superseded declaration from clearing a newer gate:
 * - newest assistant declaration wins: a later `qaStatus: QA_FAILED` (or any other
 *   status that is not in `tokens`) supersedes an older bypass token in the window;
 * - within one message the LAST declaration wins, so a status merely quoted before
 *   the real one is ignored;
 * - the message must postdate the newest pending edit (`notBefore`). Messages without
 *   a finite `timestamp` cannot be dated, so each is honoured once per fingerprint.
 */
function findDeclaration(messages: unknown[], tokens: readonly string[], notBefore: number): DeclarationHit | null {
  try {
    const window = messages.slice(-BYPASS_SCAN_WINDOW);
    for (let i = window.length - 1; i >= 0; i--) {
      const message = window[i];
      if (!message || typeof message !== "object") continue;
      const role = (message as { role?: unknown }).role;
      if (typeof role !== "string" || role !== "assistant") continue;
      const timestamp = (message as { timestamp?: unknown }).timestamp;
      const dated = typeof timestamp === "number" && Number.isFinite(timestamp);
      // Timestamps are monotonic: once a message predates the edit, every older one does too.
      if (dated && timestamp < notBefore) return null;
      const text = assistantText(message);
      if (!text) continue;
      let last: string | null = null;
      for (const match of text.matchAll(STATUS_DECLARATION_RE)) last = match[0];
      if (last === null) continue;
      if (!tokens.includes(last)) return null;
      const stamp = dated ? null : text;
      if (stamp !== null && consumedDeclarations.has(stamp)) return null;
      return { token: last, stamp };
    }
    return null;
  } catch {
    return null;
  }
}

function findBypassDeclaration(messages: unknown[]): DeclarationHit | null {
  return findDeclaration(messages, BYPASS_TOKENS, latestPendingEditAt());
}

function findMicroDeclaration(messages: unknown[]): DeclarationHit | null {
  return findDeclaration(messages, MICRO_TOKENS, latestPendingEditAt());
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
  annotationsAtArm.delete(root);
  microEdits.delete(root);
  pendingSettingsFindings.delete(root);
}

/**
 * The reminder deliberately never contains a BYPASS_TOKENS string (in either
 * spelling): it names the terminal statuses without reproducing the exact
 * declaration the gate matches on. It also never cites a repo-relative source
 * path — the consuming session's cwd is the theme workspace, where
 * `src/shared/annotation-prompt.ts` does not resolve. It is kept short on
 * purpose: it lands on every Nth edit result, and the full SELF_QA_DIRECTIVE
 * contract already lives in the annotation prompt.
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
    const shown = allFindings.slice(0, 5);
    const formatted = shown
      .map((f) => {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        const idPart = f.id ? ` (${f.id})` : "";
        const idVal = f.id ?? "";
        const fixHint =
          f.rule === "HARAVAN_SETTINGS_UPLOAD_READ"
            ? `Fix: replace with '${idVal}' | asset_url.`
            : f.message
              ? `Detail: ${f.message}`
              : "Fix: declare or resolve the setting in config/settings_schema.json or config/settings.html.";
        return `${GATE_MARKER} QA GATE PENDING — Settings regression detected: ${f.rule} at ${loc}${idPart}. ${fixHint}`;
      })
      .join("\n");
    return `\n\n${formatted}\n(${allFindings.length} new finding(s); showing ${shown.length}.) Run theme.qa_validate with tabId + workspaceRoot once resolved.${debtReminder()}`;
  }

  const roots = [...pendingEdits.keys()].join(", ");
  return (
    `\n\n${GATE_MARKER} QA GATE PENDING — theme file(s) under ${roots} edited without a fresh AntiFan QA receipt. ` +
    `Run theme.qa_validate (tabId + workspaceRoot; expectedUrl and annotationId optional) so a receipt lands in .antifan/qa-receipts/. ` +
    `If impossible, declare one SELF_QA_DIRECTIVE terminal status in your own message, with the original error code: ` +
    `QA_UNAVAILABLE (capability missing or auth failed), ` +
    `QA_INCONCLUSIVE (environment failure such as CAPTURE_FRAME_STARVATION or TARGET_STALE, after one retry), ` +
    `QA_PENDING_SYNC (user must sync the theme; list the edited files), ` +
    `QA_MICRO_STATIC (single plain assets/ CSS file, <=10 changed lines, no Liquid; name file, selector, line count). ` +
    `QA_FAILED does not clear the gate. QA_PASSED without a receipt is a contract violation.` +
    debtReminder()
  );
}

export default function themeQaGate(pi: HookAPI): void {
  pi.on("session_start", (_event, ctx) => {
    try {
      pendingEdits.clear();
      annotationsAtArm.clear();
      consumedDeclarations.clear();
      microEdits.clear();
      pendingSettingsFindings.clear();
      churnWarnedPaths.clear();
      pendingChurnHints.clear();
      sessionModes.clear();
      toolResultCounter = 0;
      mcpFirstInjected = false;
      bridgeOutageKey = null;
      bridgeRecoveredCode = null;
      scopedSessionStates.clear();
      openDebts.clear();
      dirtyDebtRoots.clear();
      debtAdoptedFrom.clear();
      reportedDebtWriteFailures.clear();
      adoptDebt(ctx?.cwd);
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
      const cwd = ctx?.cwd ?? process.cwd();
      adoptDebt(cwd);
      const themeTargets: Array<{ absTarget: string; root: string; rel: string }> = [];
      if (isWrite) {
        for (const target of targets) {
          const resolved = resolveThemeTarget(target, cwd);
          if (!resolved) continue;
          themeTargets.push(resolved);
        }
      }
      const isThemeWrite = themeTargets.length > 0;
      const sessionKey = sessionIdOf(ctx) || cwd;
      const st = scopedSessionStates.get(sessionKey);
      const now = Date.now();
      if (st) {
        if (isThemeWrite) {
          st.dirty = true;
          st.editTs = now;
        }
      } else {
        scopedSessionStates.set(sessionKey, { lastEmittedSeq: null, dirty: isThemeWrite, editTs: isThemeWrite ? now : 0 });
      }
      if (!isWrite) return;
      if (targets.length === 0) return;
      const absTargets = Array.from(new Set(targets.map((t) => toAbsolutePath(t, cwd))));
      const isMulti = targets.length > 1 || absTargets.length > 1;
      const added = isMulti ? null : addedTextOf(toolName, event.input);
      const firstTarget = absTargets[0];
      if (toolName === "write" && firstTarget !== undefined) {
        maybeQueueChurnHint(firstTarget);
      }
      const scopedEdit = SCOPED_MODES.includes(sessionMode(ctx));
      for (const { root, rel } of themeTargets) {
        if (!pendingEdits.has(root)) {
          const wasEmpty = pendingEdits.size === 0;
          pendingEdits.set(root, Date.now());
          annotationsAtArm.set(root, snapshotAnnotations(root));
          // Re-arming after a cleared/expired gate must remind on the next
          // result, not wait out the previous cadence window.
          if (wasEmpty) toolResultCounter = 0;
        }
        recordMicroEdit(root, rel, added);
        if (scopedEdit) noteScopedEdit(root, rel);
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
      adoptDebt(ctx?.cwd ?? process.cwd());

      const resultTool = String(event.toolName ?? event.name ?? "").toLowerCase();
      const isAntifanTool = ANTIFAN_TOOL_RE.test(resultTool);
      const evidence = bridgeOutageEvidence(
        event.content,
        Date.now(),
        isAntifanTool
      );
      if (evidence.down) {
        if (bridgeOutageKey !== evidence.key) {
          bridgeOutageKey = evidence.key;
          bypassLog.push({ at: new Date().toISOString(), token: "QA_GATE_SUSPENDED", code: evidence.code });
          pi.appendEntry?.("antifan-bridge-suspension", { key: evidence.key, code: evidence.code, at: Date.now() });
        }
        return undefined;
      }

      if (bridgeOutageKey !== null) {
        const prevKey = bridgeOutageKey;
        bridgeOutageKey = null;
        const resumeCode = evidence.code || "listening";
        bridgeRecoveredCode = resumeCode;
        pi.appendEntry?.("antifan-bridge-resumed", { key: prevKey, code: resumeCode, at: Date.now() });
      }

      // Reconcile on EVERY result, structured ones included: the receipt written
      // by theme.qa_validate arrives on an MCP result and must clear the gate promptly.
      if (pendingEdits.size > 0) reconcileReceipts();

      // Structured results stay byte-identical: AntiFan MCP calls (tool name, or a
      // write/read whose target is an `xd://` device path) and any result whose text
      // parses as JSON. Callers parse these (eval `tool.write` joins the parts), so an
      // appended notice turns valid JSON into "Extra data". Gate notices travel through
      // the `context` handler instead.
      const targets = extractResultTargetPaths(event);
      const hasXdTarget = targets.some((t) => t.toLowerCase().startsWith("xd://") || DEVICE_PATH_RE.test(t));
      if (openDebts.size > 0 && (isAntifanTool || hasXdTarget)) settleDebts();
      if (isAntifanTool || hasXdTarget || parsesAsJson(event.content)) {
        return undefined;
      }

      const chunks: string[] = drainChurnHints();

      // The reminder only lands on a mutation-class result. A reminder on every
      // pending read/grep/glob/bash output spammed ~50 results per turn once armed; it
      // belongs on the result of a write/edit, right where the unverified surface grows.
      const cwd = ctx?.cwd ?? process.cwd();
      const isThemeResultTarget =
        targets.length === 0 ||
        targets.some((target) => resolveThemeTarget(target, cwd) !== null);
      if (
        pendingEdits.size > 0 &&
        WRITE_TOOLS.has(resultTool) &&
        isThemeResultTarget &&
        !contentHasMarker(event.content, GATE_MARKER)
      ) {
        toolResultCounter += 1;
        if ((toolResultCounter - 1) % REMIND_EVERY === 0) {
          chunks.push(reminderText());
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
  findings?: HookSettingsFinding[];
}

function readLatestRatchetStats(workspaceRoot: string, minReceiptTime = 0): RatchetStats | null {
  try {
    const rec = latestReceiptRecord(workspaceRoot);
    if (
      rec &&
      rec.time >= minReceiptTime &&
      rec.receipt?.settingsRatchet &&
      typeof rec.receipt.settingsRatchet === "object"
    ) {
      const sr = rec.receipt.settingsRatchet as {
        newFailures?: number;
        legacyDebt?: number;
        findings?: HookSettingsFinding[];
      };
      const newCount = typeof sr.newFailures === "number" ? sr.newFailures : 0;
      const debtCount = typeof sr.legacyDebt === "number" ? sr.legacyDebt : 0;
      const findings = newCount > 0 && Array.isArray(sr.findings) ? sr.findings.slice(0, 5) : [];
      return {
        newCount,
        debtCount,
        ...(findings.length > 0 ? { findings } : {}),
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
      flushDebts(pi);
      const shape = resolveWorkspaceShape(ctx?.cwd ?? process.cwd());
      const sid = sessionIdOf(ctx);
      const sessionKey = sid || shape.workspaceRoot;
      const summary = auditRunSummary(shape.workspaceRoot, sid);
      const st = scopedSessionStates.get(sessionKey);
      const wasDirty = Boolean(st && st.dirty);
      const lastEditTs = st?.editTs ?? 0;

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
        editTs: lastEditTs,
      });
      if (wasDirty) {
        const stats = readLatestRatchetStats(shape.workspaceRoot, lastEditTs);
        if (stats) {
          const modeLabel = MODE_LABELS[mode];
          const hasFindings = stats.newCount > 0 && Array.isArray(stats.findings) && stats.findings.length > 0;
          const findingSuffix = hasFindings
            ? `: ${stats.findings!.map((f) => `${f.rule} at ${f.line ? `${f.file}:${f.line}` : f.file}${f.id ? ` (${f.id})` : ""}`).join("; ")}`
            : "";
          pi.sendMessage?.({
            customType: "theme-qa-gate",
            content: `[theme-qa-gate:scoped] Settings check: ${stats.newCount} new finding(s), ${stats.debtCount} legacy debt items. (${modeLabel} non-blocking)${findingSuffix}`,
            display: true,
            attribution: "agent",
            details: {
              kind: "settings-ratchet-scoped",
              mode,
              newCount: stats.newCount,
              debtCount: stats.debtCount,
              ...(hasFindings ? { findings: stats.findings } : {}),
            },
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
      adoptDebt(ctx?.cwd ?? process.cwd());
      settleDebts();
      // An outage observed on an AntiFan MCP result (marker lane) happened while the
      // record may still read listening, so the record alone cannot clear it here.
      const recordEvidence = bridgeOutageEvidence();
      const heldMarker =
        bridgeOutageKey !== null && (OBSERVED_FAILURE_MARKERS as readonly string[]).includes(bridgeOutageKey)
          ? bridgeOutageKey
          : null;
      const evidence: OutageEvidence =
        !recordEvidence.down && heldMarker !== null ? { down: true, code: heldMarker, key: heldMarker } : recordEvidence;

      if (evidence.down) {
        if (bridgeOutageKey !== evidence.key) {
          bridgeOutageKey = evidence.key;
          bypassLog.push({ at: new Date().toISOString(), token: "QA_GATE_SUSPENDED", code: evidence.code });
          pi.appendEntry?.("antifan-bridge-suspension", { key: evidence.key, code: evidence.code, at: Date.now() });
        }
      } else if (bridgeOutageKey !== null) {
        const prevKey = bridgeOutageKey;
        bridgeOutageKey = null;
        const resumeCode = evidence.code || "listening";
        bridgeRecoveredCode = resumeCode;
        pi.appendEntry?.("antifan-bridge-resumed", { key: prevKey, code: resumeCode, at: Date.now() });
      }

      let outMessages: unknown[] | undefined;
      const existing = Array.isArray(event.messages) ? event.messages : [];

      if (evidence.down) {
        const hasSuspendedNotice = existing.some(
          (m) =>
            m &&
            typeof m === "object" &&
            (m as Record<string, unknown>).customType === "theme-qa-gate" &&
            ((m as Record<string, unknown>).details as Record<string, unknown> | undefined)?.kind === "bridge-suspended"
        );
        if (!hasSuspendedNotice) {
          outMessages = [
            ...existing,
            {
              role: "custom",
              customType: "theme-qa-gate",
              content: `${BRIDGE_MARKER} QA gate suspended: bridge down (${evidence.code}) — declare the QA_UNAVAILABLE status explicitly when closing work; reminders resume when bridge health recovers.`,
              display: true,
              attribution: "agent",
              details: { kind: "bridge-suspended", code: evidence.code },
            },
          ];
        }
      } else {
        if (bridgeRecoveredCode !== null) {
          outMessages = [
            ...existing,
            {
              role: "custom",
              customType: "theme-qa-gate",
              content: `${BRIDGE_MARKER} bridge recovered (${bridgeRecoveredCode}) — QA gate reminders resumed`,
              display: true,
              attribution: "agent",
              details: { kind: "bridge-recovered", code: bridgeRecoveredCode },
            },
          ];
          bridgeRecoveredCode = null;
        }
        if (bridgeOutageKey === null && !mcpFirstInjected && isThemeCwd(ctx?.cwd)) {
          mcpFirstInjected = true;
          outMessages = [...(outMessages ?? existing), mcpFirstMessage()];
        }
      }

      if (pendingEdits.size === 0) {
        return outMessages ? { messages: outMessages } : undefined;
      }
      const messages = event.messages;
      if (Array.isArray(messages)) {
        const bypass = findBypassDeclaration(messages);
        if (bypass) {
          bypassLog.push({ at: new Date().toISOString(), token: bypass.token });
          consumeDeclaration(bypass);
          pendingEdits.clear();
          annotationsAtArm.clear();
          microEdits.clear();
          pendingSettingsFindings.clear();
          return outMessages ? { messages: outMessages } : undefined;
        }
        const micro = findMicroDeclaration(messages);
        if (micro) {
          const microToken = micro.token;
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
          } else {
            consumeDeclaration(micro);
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
