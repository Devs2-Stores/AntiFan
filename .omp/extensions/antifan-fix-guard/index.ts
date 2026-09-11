/**
 * AntiFan B-Lite v2 Fix-Guard Extension
 *
 * Loadable extension package enforcing fix-loop contracts, merge-gate invariants,
 * and capability surface boundaries. Sibling capability directories (rules/, prompts/,
 * skills/, hooks/) are discovered by the runtime via this loaded package.
 *
 * Dependency-free: uses only standard runtime primitives so the package loads in isolation.
 */
import {
  auditToolSurface,
  DECISIONS,
  DEFAULT_FORBIDDEN_TOOLS,
  DEFAULT_PERMITTED_TOOLS,
} from "../../../.canary/tools/fix-loop/audits.mjs";


// Typed decision enum (exact strings)
export const DECISION_CODES = DECISIONS;

export type DecisionCode = (typeof DECISION_CODES)[keyof typeof DECISION_CODES];

// Route-refusal codes (exact strings)
export const ROUTE_REFUSAL_CODES = {
  URL_HOST_MISMATCH: "URL_HOST_MISMATCH",
  URL_THEME_MISMATCH: "URL_THEME_MISMATCH",
  URL_PATH_MISMATCH: "URL_PATH_MISMATCH",
  URL_EXPECTATION_MISSING: "URL_EXPECTATION_MISSING",
} as const;

export type RouteRefusalCode = (typeof ROUTE_REFUSAL_CODES)[keyof typeof ROUTE_REFUSAL_CODES];

// Lifecycle states (exact strings)
export const LIFECYCLE_STATES = {
  FIXED_VERIFIED: "FIXED_VERIFIED",
  REFUSED_SCOPE: "REFUSED_SCOPE",
  STALEMATE: "STALEMATE",
  SCOPE_DISCOVERY: "SCOPE_DISCOVERY",
} as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[keyof typeof LIFECYCLE_STATES];

// Allowed fixer tools (exact surface)
export const ALLOWED_FIXER_TOOLS = [
  "file.read",
  "file.write",
] as const;

// Forbidden tool patterns (matcher forms with wildcards for Phase 2 name filter & Phase 4 hook probe)
export const FORBIDDEN_TOOL_PATTERNS = DEFAULT_FORBIDDEN_TOOLS;

export interface ExtensionLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface ExtensionUI {
  notify?(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ExtensionContext {
  cwd?: string;
  ui?: ExtensionUI;
}

export interface ToolCallEvent {
  toolName?: string;
  name?: string;
  risk?: string;
  input?: Record<string, unknown>;
}

export interface ToolCallBlockResult {
  block: boolean;
  reason: string;
}

export interface ExtensionAPI {
  logger?: ExtensionLogger;
  on?(
    event: "session_start",
    handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void
  ): void;
  on?(
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallBlockResult | undefined> | ToolCallBlockResult | undefined
  ): void;
  on?(event: string, handler: (...args: unknown[]) => unknown): void;
}

/**
 * Checks if a tool name matches any forbidden pattern.
 */
export function isForbiddenTool(toolName: string, toolRisk?: string): boolean {
  if (toolRisk === "eval") return true;
  const res = auditToolSurface([toolName], DEFAULT_FORBIDDEN_TOOLS, [toolName]);
  return res.decision === DECISION_CODES.REFUSED_TOOL_SURFACE;
}

/**
 * Extension entrypoint.
 * Emits observable load diagnostics and registers session_start side effect.
 */
export default function antifanFixGuardExtension(pi: ExtensionAPI): void {
  const LOAD_MARKER = "[antifan-fix-guard] extension loaded";

  // Observable load marker (written to loader diagnostics / console)
  if (pi?.logger?.info) {
    pi.logger.info(LOAD_MARKER);
  } else {
    console.log(LOAD_MARKER);
  }

  // Observable session_start hook side effect (used by Phase 4 probe precondition)
  if (typeof pi?.on === "function") {
    pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
      const START_MARKER = "[antifan-fix-guard] session_start verified";
      if (pi?.logger?.info) {
        pi.logger.info(START_MARKER);
      } else {
        console.log(START_MARKER);
      }
      if (ctx?.ui?.notify) {
        ctx.ui.notify(START_MARKER, "info");
      }
    });

    // Tool call interception (second-lever safety hook for child calls)
    pi.on("tool_call", async (event: ToolCallEvent) => {
      const toolName = event?.toolName ?? event?.name ?? "";
      const toolRisk = event?.risk ?? "";

      if (isForbiddenTool(toolName, toolRisk)) {
        const reason = `REFUSED_TOOL_SURFACE: Tool '${toolName}' is forbidden for fixer sessions. Permitted: file.read, file.write.`;
        if (pi?.logger?.warn) {
          pi.logger.warn(`[antifan-fix-guard] ${reason}`);
        }
        return {
          block: true,
          reason,
        };
      }

      return undefined;
    });
  }
}
