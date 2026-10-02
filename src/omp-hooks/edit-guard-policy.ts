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
  /** The wiring failed before the policy could classify the call. See `edit-guard.ts`. */
  GUARD_ERROR: "REFUSED_GUARD_ERROR",
} as const;

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

/** Super-Fast is file-only: no dispatch, no eval, no shell, no network. */
export const FAST_BLOCKED_TOOLS: Record<string, true> = {
  task: true,
  eval: true,
  bash: true,
  web_search: true,
};

const DEVICE_PATH_RE = /^(?:xd|mcp):\/\//i;
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
      reason: `${REFUSAL_CODES.FAST_MODE_TOOL}: '${tool}' is disabled in Super-Fast (${label} edits files directly; no shell, no dispatch). Send [Core-Context] to run it.`,
      targets: fileTargets,
      device,
    };
  }
  if (isMcp || device !== null) {
    return {
      decision: "block",
      code: REFUSAL_CODES.FAST_MODE_MCP,
      reason: `${REFUSAL_CODES.FAST_MODE_MCP}: ${device ? deviceLabel(device) : tool} is a live-browser/device call and is disabled in Super-Fast. Send [Core-Context] to use it.`,
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
