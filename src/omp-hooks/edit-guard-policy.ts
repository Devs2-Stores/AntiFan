/**
 * Tool-call policy for scoped edit modes.
 *
 * Pure decision logic: given a mode, a tool call and the workspace shape, return
 * allow or a named refusal. Kept free of fs/env so the whole policy is testable
 * as a table, and so the guard hook stays wiring.
 *
 * Path conventions mirror the two hooks already in production: the path keys
 * `["path","file","filePath","target","filename"]` and the `[file#TAG]` headers of
 * an `edit` patch, exactly as `theme-qa-gate` reads them; device targets are
 * `xd://…` / `mcp://…`, as `antifan-core-bridge` reads them.
 */

import * as path from "node:path";

import {
  MODE_LABELS,
  SCOPED_MODES,
  type EditMode,
} from "./edit-mode";
import { classifyWritePath, type WorkspaceShape } from "./theme-paths";

export const REFUSAL_CODES = {
  EDIT_SCOPE: "REFUSED_EDIT_SCOPE",
  THEME_ROOT_UNRESOLVED: "REFUSED_THEME_ROOT_UNRESOLVED",
  FAST_MODE_TOOL: "REFUSED_FAST_MODE_TOOL",
  FAST_MODE_MCP: "REFUSED_FAST_MODE_MCP",
  /**
   * `config/settings_data.json` is writable in every mode, but only after a scoped
   * `hrv theme fetch --only config/settings_data.json` refreshed it from the shop.
   * The fetch runs in `edit-guard.ts`; this is the code it refuses with on failure.
   */
  SETTINGS_DATA_FETCH_FAILED: "REFUSED_SETTINGS_DATA_FETCH_FAILED",
  SETTINGS_DATA_CHANGED_ON_SHOP: "REFUSED_SETTINGS_DATA_CHANGED_ON_SHOP",
  /** The wiring failed before the policy could classify the call. See `edit-guard.ts`. */
  GUARD_ERROR: "REFUSED_GUARD_ERROR",
  /**
   * An `eval` JS cell starts a process from `process.execPath` (or `argv0` / `argv[0]`). In the eval
   * kernel that path is the `omp` binary, so the call opens a child agent session. See `planEvalSelfSpawn`.
   */
  EVAL_SELF_SPAWN: "REFUSED_EVAL_SELF_SPAWN",
  /** A Leader's worker names the otp-inbox key file, reads an `ANTIFAN_SECRET_*` variable or dumps the environment. See `planSecretExposure`. */
  SECRET_EXPOSURE: "REFUSED_SECRET_EXPOSURE",
} as const;

/** Calls that start a process: node's `child_process` family, `Bun.spawn*`, `Bun.$`, a tagged `$` or `sh` template. */
const EVAL_SPAWN_API_RE =
  /\b(?:execFile|execFileSync|exec|execSync|spawn|spawnSync|fork)\s*\(|\bBun\s*\.\s*(?:spawn(?:Sync)?\b|\$)|\$`|(?<![\w.$])sh\s*(?:\(|`)/;

/** The running binary: in the eval kernel this is `omp`, not node. */
const EVAL_SELF_PATH_RE = /\bexecPath\b|\bargv0\b|\b(?:process|Bun)\s*\.\s*argv\s*\[\s*0\s*\]/;

export interface EvalSelfSpawnPlan {
  decision: "allow" | "block";
  code: string;
  reason: string;
}

/**
 * Refuses an eval JS cell that both starts a process and takes the program from `process.execPath`,
 * `process.argv0` or `process.argv[0]`. Inside the eval kernel that program is the `omp` binary: the
 * spawn opens a child agent session, each argument becomes a user message, and the child inherits the
 * caller's terminal identity and acts on its own. Applies to every session, not only a Leader's worker.
 *
 * The cell is read as plain text: a comment or string that only names `process.execPath` next to a
 * process-starting call is refused as well (the message names the fix). A cell that only prints the
 * path, and any non-JS cell (Python's `sys.executable` is the real interpreter), is allowed.
 */
export function planEvalSelfSpawn(language: unknown, code: unknown): EvalSelfSpawnPlan {
  const allow: EvalSelfSpawnPlan = { decision: "allow", code: "", reason: "" };
  if (typeof code !== "string") return allow;
  const lang = typeof language === "string" ? language.trim().toLowerCase() : "";
  if (lang === "py" || lang === "python") return allow;
  if (!EVAL_SELF_PATH_RE.test(code) || !EVAL_SPAWN_API_RE.test(code)) return allow;
  return {
    decision: "block",
    code: REFUSAL_CODES.EVAL_SELF_SPAWN,
    reason: `${REFUSAL_CODES.EVAL_SELF_SPAWN}: trong ô eval, process.execPath (và process.argv0, process.argv[0]) là binary của omp, không phải node; lệnh này sẽ mở một phiên agent con mang quyền terminal của bạn, mỗi argv thành một tin nhắn user, và ô eval treo tới khi bị kill. Hãy chạy chương trình node bằng tool bash ("node <file>"), hoặc spawn chuỗi "node" thay cho process.execPath.`,
  };
}

export interface SecretExposurePlan {
  decision: "allow" | "block";
  code: string;
  reason: string;
}

/** The otp-inbox read-key file (`%USERPROFILE%/.antifan/otp-inbox*.env`, outside every repo) or anything under a `.antifan/otp-inbox` folder. */
const OTP_ENV_FILE_RE = /otp-inbox[\w.-]*\.env\b|[\\/]\.antifan[\\/]+otp-inbox/i;

/** An expansion or API read of an `ANTIFAN_SECRET_*` variable (the otp-inbox read key lives in one). A plain mention in a search is not a read. */
const SECRET_VAR_READ_RE =
  /(?:\$\{?|%|\benv:|process\s*\.\s*env\s*(?:\.|\[\s*["'`])|os\s*\.\s*environ\s*(?:\.get)?\s*[[(]\s*["']|os\s*\.\s*getenv\s*\(\s*["']|\bprintenv\s+(?:-\S+\s+)*|GetEnvironmentVariable\s*\(\s*["']|(?<![\w.$])env\s*\(\s*["'`])ANTIFAN_SECRET_/i;

/** Listing the whole environment drive in PowerShell: `Get-ChildItem env:`, `gci env:`, `dir env:`, `Get-Item env:*`. */
const ENV_DRIVE_LISTING_RE = /(?<![\w-])(?:Get-ChildItem|Get-Item|gci|gi|dir|ls)\s+(?:-\w+\s+)*(?:-Path\s+)?["']?env:/i;

/** A bare command whose output is the whole environment (the segment is what sits between `;`, `&`, `|` and newlines). */
const ENV_DUMP_SEGMENT_RE = /^(?:env(?:\s+-[0a-z]+)*|printenv|set|export\s+-p|declare\s+-[px]+|typeset\s+-x|cmd(?:\.exe)?\s+\/c\s+set)\s*(?:\d?>>?\s*\S+)?\s*$/i;

/** An eval cell handing a bare environment dump to a shell sink: `sh("printenv")`, `os.system("env")`, `subprocess.run(["set"])`. */
const EVAL_ENV_DUMP_SINK_RE = /\b(?:sh|exec|execSync|system|popen|run|call|check_output|Popen|spawnSync|spawn)\s*\(\s*\[?\s*(?:command\s*[:=]\s*)?["'`]\s*(?:env|printenv|set)\s*["'`]/;

/** A program printing or copying the whole environment: `console.log(process.env)`, `Object.entries(os.environ)`, `{...process.env}` into output. */
const ENV_DUMP_CALL_RE =
  /\b(?:console\s*\.\s*(?:log|dir|info|error)|JSON\s*\.\s*stringify|Object\s*\.\s*(?:keys|entries|values|assign)|util\s*\.\s*inspect|print|pprint|json\s*\.\s*dumps|dict|list)\s*\(\s*(?:\{\s*\}\s*,\s*)?(?:process\s*\.\s*env|os\s*\.\s*environ)\s*[,)]|\bin\s+os\s*\.\s*environ\b/;

const SECRET_EXPOSURE_REASON = `${REFUSAL_CODES.SECRET_EXPOSURE}: the otp-inbox read key lives in %USERPROFILE%/.antifan/otp-inbox*.env and in the ANTIFAN_SECRET_* variables, and every tool result is copied verbatim into the session log. Only scripts/leader/otp-fetch.mjs reads them: run \`node E:/Work/apps/AntiFan/scripts/leader/otp-fetch.mjs ...\` (it prints {found,len,ageSec} only) and never print, read, copy or list that file, those variables or the whole environment.`;

/**
 * Refuses a call that would put the otp-inbox read key in front of a model: a tool target (read, grep, edit, ...) or a shell/eval text
 * that names the key file, a read of an `ANTIFAN_SECRET_*` variable, or a dump of the whole environment (`env`, `printenv`,
 * `Get-ChildItem env:`, `console.log(process.env)`, `env()` in an eval cell). `otp-fetch.mjs` itself is no exception to make: it reads the file
 * as a child process, and the command that runs it names neither the file nor a variable. A rail against slips, not a seal: a program built to
 * hide the path still gets through. Applied to a Leader's worker only (see `edit-guard.ts`).
 */
export function planSecretExposure(tool: unknown, input: Record<string, unknown> | undefined, targets: readonly string[] = []): SecretExposurePlan {
  const allow: SecretExposurePlan = { decision: "allow", code: "", reason: "" };
  const block: SecretExposurePlan = { decision: "block", code: REFUSAL_CODES.SECRET_EXPOSURE, reason: SECRET_EXPOSURE_REASON };
  const name = typeof tool === "string" ? tool.trim().toLowerCase() : "";
  if (targets.some((target) => OTP_ENV_FILE_RE.test(target))) return block;
  const text = name === "bash" ? input?.command : name === "eval" ? input?.code : undefined;
  if (typeof text !== "string" || text.length === 0) return allow;
  if (OTP_ENV_FILE_RE.test(text) || SECRET_VAR_READ_RE.test(text) || ENV_DRIVE_LISTING_RE.test(text) || ENV_DUMP_CALL_RE.test(text)) return block;
  if (name === "eval" && (/(?<![\w.$])env\s*\(\s*\)/.test(text) || EVAL_ENV_DUMP_SINK_RE.test(text))) return block;
  if (text.split(/[;&|\r\n]+/).some((segment) => ENV_DUMP_SEGMENT_RE.test(segment.trim()))) return block;
  return allow;
}

export const PATH_INPUT_KEYS = ["path", "file", "filePath", "target", "filename"];

/** Tools whose target is a file on disk. */
export const WRITE_TOOLS: Record<string, true> = {
  write: true,
  edit: true,
  multi_edit: true,
  patch: true,
  ast_edit: true,
  create_file: true,
  delete_file: true,
  append: true,
};

/** Tools whose target is a file on disk and that read without mutating. */
export const READ_TOOLS: Record<string, true> = {
  read: true,
  read_file: true,
  "file.read": true,
  view: true,
};

/** Super-Fast is file-only: no dispatch, no eval, no shell, no network. */
export const FAST_BLOCKED_TOOLS: Record<string, true> = {
  task: true,
  eval: true,
  bash: true,
  web_search: true,
};

export const DEVICE_PATH_RE = /^(?:xd|mcp):\/\//i;
const MCP_DEVICE_RE = /^(?:xd:\/\/mcp__|mcp:\/\/)/i;
const MCP_TOOL_NAME_RE = /^(?:anti|theme|browser)\.|mcp__antifan_browser_/i;

export interface ToolCallPlan {
  decision: "allow" | "block";
  code: string;
  reason: string;
  /** File targets the call names, absolute paths when they resolve. */
  targets: string[];
  /** Device URI when the call drives an MCP/device surface instead of a file. */
  device: string | null;
}

/** Path fields of a tool input, in the order both production hooks read them. */
export function extractTargetPaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const targets: string[] = [];
  for (const key of PATH_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) targets.push(value.trim());
  }
  const raw = input.input;
  if (typeof raw === "string") {
    const headerRe = /\[([^#\]]+)#[^\]]*\]/g;
    let match: RegExpExecArray | null;
    while ((match = headerRe.exec(raw)) !== null) {
      const target = match[1]?.trim();
      if (target) targets.push(target);
    }
  }
  return Array.from(new Set(targets));
}

/** `xd://mcp__antifan_browser_anti_browser_tabs_list` → `anti.browser.tabs.list`. */
export function deviceLabel(device: string): string {
  const trimmed = device.replace(DEVICE_PATH_RE, "");
  const stripped = trimmed.replace(/^mcp__antifan_browser_/, "").replace(/^mcp__/, "");
  const dotted = stripped.replace(/^(anti|theme|browser)_/, (_all, head: string) => `${head}.`);
  return dotted.replace(/_/g, ".");
}

export function planToolCall(params: {
  mode: EditMode;
  tool: string;
  input: Record<string, unknown> | undefined;
  shape: WorkspaceShape;
}): ToolCallPlan {
  const { mode, input, shape } = params;
  const tool = (params.tool ?? "").trim().toLowerCase();
  const rawTargets = extractTargetPaths(input);
  const device = rawTargets.find((target) => DEVICE_PATH_RE.test(target)) ?? null;
  const fileTargets = rawTargets
    .filter((target) => !DEVICE_PATH_RE.test(target))
    .map((target) => path.resolve(shape.cwd, target));
  const isMcp = device !== null ? MCP_DEVICE_RE.test(device) : MCP_TOOL_NAME_RE.test(tool);
  if (!(SCOPED_MODES as readonly string[]).includes(mode)) {
    return { decision: "allow", code: "MODE_UNSET", reason: "", targets: fileTargets, device };
  }
  // Direct-Edit is a Core-suppression contract, not a tool policy: the bridge
  // hook owns the no-Core rule (pack skipped, retrieval refused); everything
  // else — dispatch, eval, shell, devices, out-of-scope writes — runs exactly
  // as an unscoped session. Only writes are still accounted so the run summary
  // and audit log keep an honest changed-file list.
  if (mode === "direct") {
    return { decision: "allow", code: "ALLOWED", reason: "", targets: fileTargets, device };
  }

  const label = MODE_LABELS[mode];
  if (FAST_BLOCKED_TOOLS[tool] === true) {
    return {
      decision: "block",
      code: REFUSAL_CODES.FAST_MODE_TOOL,
      reason: `${REFUSAL_CODES.FAST_MODE_TOOL}: '${tool}' is disabled in Super-Fast (${label} edits files directly; no shell, no dispatch). Use the file edit tools instead, or ask the user to re-send the request in Core mode (the [🧠Core-Context] tag) to run it.`,
      targets: fileTargets,
      device,
    };
  }
  if (isMcp || device !== null) {
    return {
      decision: "block",
      code: REFUSAL_CODES.FAST_MODE_MCP,
      reason: `${REFUSAL_CODES.FAST_MODE_MCP}: ${device ? deviceLabel(device) : tool} is a live-browser/device call and is disabled in Super-Fast. Ask the user to re-send the request in Core mode (the [🧠Core-Context] tag) to use it.`,
      targets: fileTargets,
      device,
    };
  }

  if (WRITE_TOOLS[tool] === true) {
    if (isMcp && fileTargets.length === 0) {
      return { decision: "allow", code: "MCP_DEVICE_WRITE", reason: "", targets: [], device };
    }
    if (fileTargets.length === 0) {
      return {
        decision: "block",
        code: REFUSAL_CODES.EDIT_SCOPE,
        reason: `${REFUSAL_CODES.EDIT_SCOPE}: '${tool}' names no target path, so the writable set cannot be checked. Scoped modes refuse what they cannot verify.`,
        targets: [],
        device,
      };
    }
    for (const target of fileTargets) {
      const verdict = classifyWritePath(shape, target);
      if (verdict.decision === "block") {
        return {
          decision: "block",
          code: verdict.code,
          reason: `${verdict.code}: ${verdict.absPath || target} — ${verdict.reason}`,
          targets: fileTargets,
          device,
        };
      }
    }
  }

  return { decision: "allow", code: "ALLOWED", reason: "", targets: fileTargets, device };
}
