/**
 * Playwright MCP is the fallback surface, not the first one (AGENTS.md section 3.1): a call to a
 * `mcp__playwright_*` tool is refused until the same session has seen an AntiFan call fail with a code
 * that section lets an agent fall back on, or the AntiFan MCP report that it is not connected.
 *
 * The session's own tool results are what the hook reads: `tool_result` carries the tool name, the
 * input and the content, so an AntiFan call is recognised whether it is a direct `mcp__antifan_*`
 * tool call, a `write xd://mcp__antifan_*`, or an `eval` cell that calls `tool.mcp__antifan_*`. The
 * record is kept per session id (a subagent has its own), so a parent's outage does not unlock a
 * subagent that has not met one.
 *
 * It only applies inside an AntiFan terminal (every one carries `ANTIFAN_TERMINAL_SESSION_ID`): a
 * session with no AntiFan around has nothing to fall back from. A hook failure never blocks a call.
 */

/** Codes AGENTS.md section 3.1 names as a reason to use Playwright, plus NO_RENDER_SURFACE from the 02/11/2026 Reaudit outage. */
export const FALLBACK_CODES = [
  "MCP_BRIDGE_OFFLINE",
  "PAIRING_UNAVAILABLE",
  "BRIDGE_UNREACHABLE",
  "CAPABILITY_NOT_FOUND",
  "TERMINAL_TAB_CLOSED",
  "TARGET_STALE",
  "TARGET_REQUIRED",
  "NO_RENDER_SURFACE",
] as const;

export const PLAYWRIGHT_GATE_CODES = {
  ANTIFAN_FIRST: "REFUSED_PLAYWRIGHT_ANTIFAN_FIRST",
} as const;

/**
 * The AntiFan MCP itself is down or does not exist for this session: no result code exists, the host
 * reports the server as not connected (strings read from real 02-03/11/2026 tool results) or the tool
 * as absent. Only an error result of an AntiFan call counts.
 */
const MCP_NOT_CONNECTED_RE =
  /MCP server not connected|MCP failure server: antifan|MCP subprocess closed stdout|server ["']?antifan[\w-]*["']? (?:is )?not (?:connected|running|available)|(?:unknown|no such) tool|tool [^\n]{0,80} not found/i;
const PLAYWRIGHT_RE = /mcp__playwright_/i;
const ANTIFAN_RE = /mcp__antifan_browser/i;

/** The AntiFan tool that does what a Playwright tool does, named in the refusal. */
const ANTIFAN_EQUIVALENT: Array<[RegExp, string]> = [
  [/navigate_back|navigate/, "anti.browser.navigate"],
  [/snapshot|find/, "anti.inspect.snapshot / anti.inspect.dom"],
  [/take_screenshot/, "anti.screenshot.viewport / anti.screenshot.full_page"],
  [/click/, "anti.agent.cursor.click"],
  [/type|fill_form|press_key/, "anti.agent.cursor.type / anti.agent.sequence"],
  [/hover/, "anti.agent.cursor.hover"],
  [/select_option/, "anti.agent.set_control / anti.agent.cursor.click"],
  [/file_upload/, "anti.agent.file_upload"],
  [/drag|drop/, "anti.agent.drag / anti.agent.drop"],
  [/resize|emulate_media/, "anti.browser.set_viewport / browser.set_device_preset"],
  [/console_messages/, "anti.inspect.console"],
  [/network_request/, "anti.inspect.network"],
  [/wait_for/, "anti.browser.wait"],
  [/tabs|close/, "anti.browser.tabs.*"],
  [/handle_dialog/, "anti.browser.dialog"],
  [/evaluate|run_code/, "anti.browser.evaluate"],
];

interface HookEvent {
  toolName?: unknown;
  name?: unknown;
  input?: unknown;
  args?: unknown;
  details?: unknown;
  content?: unknown;
  isError?: unknown;
}

interface GatePi {
  on(event: "tool_call", handler: (event: HookEvent, ctx: unknown) => { block: true; reason: string } | undefined): void;
  on(event: "tool_result", handler: (event: HookEvent, ctx: unknown) => undefined): void;
  on(event: "session_shutdown", handler: (event: unknown, ctx: unknown) => undefined): void;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function sessionIdOf(ctx: unknown): string {
  try {
    const manager = recordOf(ctx).sessionManager as { getSessionId?: () => unknown } | undefined;
    const raw = manager?.getSessionId?.();
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : String(recordOf(part).text ?? ""))).join("\n");
}

/** Status events recorded by OMP's `eval` tool (`details.statusEvents` and `details.cells[].statusEvents`). */
function evalStatusEvents(details: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (Array.isArray(details.statusEvents)) {
    for (const se of details.statusEvents) out.push(recordOf(se));
  }
  if (Array.isArray(details.cells)) {
    for (const cell of details.cells) {
      const cellRec = recordOf(cell);
      if (Array.isArray(cellRec.statusEvents)) {
        for (const se of cellRec.statusEvents) out.push(recordOf(se));
      }
    }
  }
  return out;
}

/** What a tool call addresses, as one string: the tool name, a `write` target path/xdev tool, or an `eval` cell/statusEvent. */
function callSurface(event: HookEvent): string {
  const tool = String(event.toolName ?? event.name ?? "").trim().toLowerCase();
  const input = recordOf(event.input ?? event.args);
  const details = recordOf(event.details);
  if (tool === "write") {
    const xdevTool = String(recordOf(details.xdev).tool ?? "");
    return xdevTool ? `${String(input.path ?? "")}\n${xdevTool}` : String(input.path ?? "");
  }
  if (tool === "eval") {
    const parts = [String(input.code ?? "")];
    if (Array.isArray(details.cells)) {
      for (const cell of details.cells) parts.push(String(recordOf(cell).code ?? ""));
    }
    for (const se of evalStatusEvents(details)) {
      parts.push(String(se.op ?? ""));
    }
    return parts.join("\n");
  }
  return tool;
}

function matchCodeInText(text: string, isError: boolean): string | null {
  if (text.length === 0) return null;
  for (const code of FALLBACK_CODES) {
    if (!text.includes(code)) continue;
    // A code only counts as a failure of the call: flagged as an error (or statusEvents.hasError), or carried as the error's own `code`.
    if (isError || new RegExp(String.raw`["']?code["']?\s*[:=]\s*["']?${code}\b`).test(text)) {
      return code;
    }
  }
  return isError && MCP_NOT_CONNECTED_RE.test(text) ? "MCP_NOT_CONNECTED" : null;
}

/** The first fallback code a failed AntiFan call reports, `MCP_NOT_CONNECTED` for a down server, else null. */
function fallbackEvidence(event: HookEvent): string | null {
  if (!ANTIFAN_RE.test(callSurface(event))) return null;
  const fromContent = matchCodeInText(textOf(event.content), event.isError === true);
  if (fromContent !== null) return fromContent;
  for (const se of evalStatusEvents(recordOf(event.details))) {
    if (!ANTIFAN_RE.test(String(se.op ?? ""))) continue;
    const fromEvent = matchCodeInText(String(se.error ?? ""), se.hasError === true);
    if (fromEvent !== null) return fromEvent;
  }
  return null;
}

function antifanEquivalent(surface: string): string {
  const name = surface.toLowerCase();
  for (const [pattern, tool] of ANTIFAN_EQUIVALENT) {
    if (pattern.test(name)) return tool;
  }
  return "the matching anti.* tool";
}

function playwrightRefusal(surface: string): string {
  const name = /mcp__playwright_\w+/i.exec(surface)?.[0] ?? "mcp__playwright_*";
  return (
    `${PLAYWRIGHT_GATE_CODES.ANTIFAN_FIRST}: ${name} is the fallback surface (AGENTS.md section 3.1) and this session has not seen AntiFan fail. ` +
    `Use ${antifanEquivalent(name)} through the antifan-browser MCP first. Playwright is allowed once an AntiFan call fails with ${FALLBACK_CODES.join(", ")}, or the AntiFan MCP reports it is not connected; ` +
    `then record the reason with anti.telemetry.record_fallback.`
  );
}

export default function playwrightGate(pi: GatePi): void {
  /** Session id -> the code of the first AntiFan failure that unlocked Playwright for it. */
  const unlocked = new Map<string, string>();

  pi.on("tool_result", (event, ctx) => {
    try {
      const code = fallbackEvidence(event);
      const id = sessionIdOf(ctx);
      if (code !== null && !unlocked.has(id)) unlocked.set(id, code);
    } catch {
      /* never throw from a hook */
    }
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const terminal = process.env.ANTIFAN_TERMINAL_SESSION_ID;
      if (typeof terminal !== "string" || terminal.trim().length === 0) return undefined;
      const surface = callSurface(event);
      if (!PLAYWRIGHT_RE.test(surface) || unlocked.has(sessionIdOf(ctx))) return undefined;
      return { block: true, reason: playwrightRefusal(surface) };
    } catch {
      return undefined;
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      unlocked.delete(sessionIdOf(ctx));
    } catch {
      /* never throw from a hook */
    }
    return undefined;
  });
}
