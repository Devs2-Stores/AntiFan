/**
 * tool-guard.ts — AntiFan Fix-Guard Hook Probe Implementation
 * Sibling pre-tool hook under .omp/extensions/antifan-fix-guard/hooks/pre/
 * Intercepts tool calls, checks write targets and tool surfaces using audits.mjs,
 * and records empirical proof via JSONL logging and session_start file writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  auditTouchedPaths,
  auditToolSurface,
  DECISIONS,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_FORBIDDEN_TOOLS,
} from "../../../../../.canary/tools/fix-loop/audits.mjs";

interface ExtensionContext {
  cwd?: string;
  sessionId?: string;
  agentId?: string;
  ui?: {
    notify?(message: string, level?: "info" | "warning" | "error"): void;
  };
}

interface ToolCallEvent {
  toolName?: string;
  name?: string;
  toolCallId?: string;
  agentId?: string;
  input?: Record<string, unknown>;
  risk?: string;
}

interface ToolCallBlockResult {
  block: boolean;
  reason: string;
}

interface HookAPI {
  on(
    event: "session_start",
    handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void
  ): void;
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: ExtensionContext
    ) => Promise<ToolCallBlockResult | undefined> | ToolCallBlockResult | undefined
  ): void;
  registerTool?(tool: {
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
    execute(id?: string, params?: unknown): Promise<unknown>;
  }): void;
  zod?: {
    object(shape: Record<string, unknown>): unknown;
    string(): { optional(): unknown };
  };
}

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

// Allowed tools for the probe session environment (includes standard built-ins + fixer tools)
const SESSION_PERMITTED_TOOLS = [
  "file.read",
  "file.write",
  "read",
  "write",
  "edit",
  "task",
  "todo",
  "glob",
  "grep",
  "bash",
  "hub",
  "yield",
];

function getLogFilePath(): string {
  const envPath = process.env.ANTIFAN_HOOK_LOG_FILE;
  if (envPath && envPath.trim().length > 0) {
    return path.isAbsolute(envPath) ? envPath : path.join(REPO_ROOT, envPath);
  }
  return path.join(REPO_ROOT, ".canary/hook-probe/default-hook.jsonl");
}

function getSessionStartFilePath(): string {
  const envPath = process.env.ANTIFAN_HOOK_SESSION_START_FILE;
  if (envPath && envPath.trim().length > 0) {
    return path.isAbsolute(envPath) ? envPath : path.join(REPO_ROOT, envPath);
  }
  return path.join(REPO_ROOT, ".canary/hook-probe/session-start.json");
}

function appendLog(entry: Record<string, unknown>): void {
  try {
    const logPath = getLogFilePath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error("[tool-guard] Failed to write log entry:", err);
  }
}

function resolveAllowedFiles(): string[] {
  const envAllowed = process.env.ANTIFAN_HOOK_ALLOWED_FILES;
  if (envAllowed && envAllowed.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(envAllowed);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      return envAllowed
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }

  const reqPathEnv = process.env.ANTIFAN_HOOK_REQUEST_PATH;
  if (reqPathEnv && reqPathEnv.trim().length > 0) {
    try {
      const reqPath = path.isAbsolute(reqPathEnv)
        ? reqPathEnv
        : path.join(REPO_ROOT, reqPathEnv);
      if (fs.existsSync(reqPath)) {
        const reqData = JSON.parse(fs.readFileSync(reqPath, "utf8")) as {
          allowedFiles?: unknown;
        };
        if (Array.isArray(reqData.allowedFiles)) {
          return reqData.allowedFiles.filter((item): item is string => typeof item === "string");
        }
      }
    } catch {}
  }

  return [];
}

function extractTargetPath(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  if (typeof input.path === "string" && input.path.trim().length > 0) {
    return input.path.trim();
  }
  if (typeof input.filePath === "string" && input.filePath.trim().length > 0) {
    return input.filePath.trim();
  }
  if (typeof input.targetPath === "string" && input.targetPath.trim().length > 0) {
    return input.targetPath.trim();
  }
  if (typeof input.target === "string" && input.target.trim().length > 0) {
    return input.target.trim();
  }

  if (toolName === "edit" && typeof input.input === "string") {
    const match = input.input.match(/\[([^#\]]+)#[^\]]*\]/);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function isWriteClassTool(toolName: string): boolean {
  const norm = toolName.toLowerCase().replace(/_/g, ".");
  return (
    norm === "write" ||
    norm === "file.write" ||
    norm === "edit" ||
    norm === "ast.edit" ||
    norm === "ast_edit" ||
    norm === "patch" ||
    norm === "append"
  );
}

export default function antifanFixGuardHook(pi: HookAPI): void {
  const isBlocking = process.env.ANTIFAN_HOOK_BLOCKING !== "false";

  // 1. Session start evidence (File Write Channel)
  if (typeof pi?.on === "function") {
    pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
      const startFile = getSessionStartFilePath();
      const startReceipt = {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        event: "session_start",
        cwd: process.cwd(),
        sessionId: ctx?.sessionId ?? null,
        agentId: ctx?.agentId ?? null,
        loaderSource: ".omp/extensions/antifan-fix-guard/hooks/pre/tool-guard.ts",
      };
      try {
        fs.mkdirSync(path.dirname(startFile), { recursive: true });
        fs.writeFileSync(startFile, JSON.stringify(startReceipt, null, 2), "utf8");
      } catch (err) {
        console.error("[tool-guard] Failed to write session-start receipt:", err);
      }
    });

    // 2. Pre-execution Tool Call Interception
    pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
      const timestamp = new Date().toISOString();
      const toolName = event?.toolName ?? event?.name ?? "";
      const input = event?.input ?? {};
      const agentId = ctx?.agentId ?? event?.agentId ?? null;
      const sessionId = ctx?.sessionId ?? null;

      const targetPath = extractTargetPath(toolName, input);
      const isWrite = isWriteClassTool(toolName);

      let argsDigest = "";
      try {
        if (targetPath) {
          argsDigest = `path:${targetPath}`;
        } else if (input.command && typeof input.command === "string") {
          argsDigest = `cmd:${input.command.slice(0, 80)}`;
        } else {
          argsDigest = JSON.stringify(input).slice(0, 100);
        }
      } catch {
        argsDigest = "[unserializable]";
      }

      // 2A. Check tool surface boundaries against forbidden tools and session permitted tools
      const surfaceAudit = auditToolSurface(
        [toolName],
        DEFAULT_FORBIDDEN_TOOLS,
        SESSION_PERMITTED_TOOLS
      );
      if (surfaceAudit.decision === DECISIONS.REFUSED_TOOL_SURFACE) {
        const reason =
          surfaceAudit.reason ??
          `REFUSED_TOOL_SURFACE: Tool '${toolName}' is forbidden for fixer sessions.`;
        appendLog({
          timestamp,
          sessionId,
          agentId,
          toolName,
          argsDigest,
          targetPath,
          decision: DECISIONS.REFUSED_TOOL_SURFACE,
          blocked: isBlocking,
          reason,
        });

        if (isBlocking) {
          return {
            block: true,
            reason,
          };
        }
        return undefined;
      }

      // 2B. Check write path boundaries if write-class tool and targetPath detected
      if (isWrite && targetPath) {
        const allowedFiles = resolveAllowedFiles();
        if (allowedFiles.length > 0) {
          const pathAudit = auditTouchedPaths(
            [targetPath],
            allowedFiles,
            DEFAULT_FORBIDDEN_PATHS
          );
          if (pathAudit.decision === DECISIONS.REFUSED_TOUCHED_PATH) {
            const reason =
              pathAudit.reason ??
              `REFUSED_TOUCHED_PATH: Touched path '${targetPath}' is outside allowedFiles.`;
            appendLog({
              timestamp,
              sessionId,
              agentId,
              toolName,
              argsDigest,
              targetPath,
              decision: DECISIONS.REFUSED_TOUCHED_PATH,
              blocked: isBlocking,
              reason,
            });

            if (isBlocking) {
              return {
                block: true,
                reason,
              };
            }
            return undefined;
          }
        }
      }

      // 2C. Default OK
      appendLog({
        timestamp,
        sessionId,
        agentId,
        toolName,
        argsDigest,
        targetPath,
        decision: DECISIONS.OK,
        blocked: false,
        reason: "OK",
      });

      return undefined;
    });
  }

  // 3. Register dummy forbidden tool so child/parent can attempt calling it
  if (typeof pi?.registerTool === "function") {
    try {
      pi.registerTool({
        name: "anti.theme.style_override",
        label: "AntiFan Theme Style Override (Probe Dummy)",
        description: "Probe dummy tool for testing fixer tool-surface boundary",
        parameters: pi.zod ? pi.zod.object({ css: pi.zod.string().optional() }) : {},
        async execute() {
          throw new Error(
            "UNREACHABLE_PROBE_EXECUTION: anti.theme.style_override executed without hook interception!"
          );
        },
      });
    } catch {
      // Ignored if registration fails or duplicate
    }
  }
}
