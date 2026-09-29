/**
 * Run-state hook — user-scope OMP hook for manager run cards and capsule briefs.
 *
 * Maintains `<dataRoot>/runtime/runs/<terminalSessionId>.json`, watches
 * `<dataRoot>/runtime/runs/control/<ompSessionId>/` for Cancel and Steer controls,
 * and injects the pinned capsule brief on `before_agent_start`.
 *
 * Inert unless ANTIFAN_TERMINAL_SESSION_ID and ANTIFAN_DATA_ROOT are both set.
 * Handlers never throw into the OMP runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const OMP_ASK_TOOLS: ReadonlySet<string> = new Set([
  "ask",
  "ask_user",
  "askUser",
  "ask_user_question",
  "confirm",
  "input",
  "elicit",
  "elicitation",
]);

export const RUN_HEARTBEAT_MS = 15_000;
export const CONTROL_POLL_INTERVAL_MS = 1_000;

export interface TerminalRunStateFile {
  schema: 1;
  terminalSessionId: string;
  ompSessionId: string; // ctx.sessionManager.getSessionId()
  pid: number; // process.pid of the OMP runtime
  cwd: string; // session cwd; Main locates the guard log under its .antifan ancestor
  mode: "unset" | "core" | "direct" | "fast"; // mirrored from runtime/edit-mode/<ompSessionId>.json (S1)
  state: "idle" | "running" | "waiting_user" | "ended";
  runSeq: number; // increments per before_agent_start (prompt or steer batch)
  runStartedAt?: number; // ms epoch of current/last run start
  lastEventAt: number; // last OMP event observed
  lastTool?: string; // last toolName on tool_call/tool_result
  promptHead?: string; // first ≤120 chars of the normalized current prompt
  updatedAt: number; // heartbeat stamp, rewritten on every write
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || `pid-${process.pid}`;
}

function atomicWriteJson(targetPath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

function readRunStateFile(filePath: string): TerminalRunStateFile | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.schema === 1) {
      return parsed as TerminalRunStateFile;
    }
  } catch {}
  return null;
}

function readMode(dataRoot: string, ompSessionId: string): "unset" | "core" | "direct" | "fast" {
  try {
    const candidates = [
      path.join(dataRoot, "runtime", "edit-mode", `${ompSessionId}.json`),
      path.join(dataRoot, "runtime", "edit-mode", `${safeFileSegment(ompSessionId)}.json`),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, "utf8");
        const parsed = JSON.parse(raw);
        const m = parsed?.mode;
        if (m === "core" || m === "direct" || m === "fast" || m === "unset") {
          return m;
        }
      }
    }
  } catch {}
  return "unset";
}

function normalizePromptHead(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.slice(0, 120);
}

function readCapsuleBrief(
  dataRoot: string,
  terminalSessionId: string,
):
  | {
      message: {
        customType: string;
        display: boolean;
        attribution: string;
        details: { capsuleId?: string; briefSeq?: number };
        content: string;
      };
    }
  | undefined {
  try {
    const briefPath = path.join(dataRoot, "runtime", "runs", `${terminalSessionId}.brief.json`);
    if (!fs.existsSync(briefPath)) return undefined;
    const raw = fs.readFileSync(briefPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;

    let content: string | undefined;
    if (typeof parsed.content === "string" && parsed.content.trim().length > 0) {
      content = parsed.content.trim();
    } else {
      const b = parsed.brief && typeof parsed.brief === "object" ? parsed.brief : parsed;
      const parts: string[] = [];
      if (typeof b.storefrontUrl === "string" && b.storefrontUrl.trim().length > 0) {
        parts.push(`storefront=${b.storefrontUrl.trim()}`);
      }
      if (typeof b.siteName === "string" && b.siteName.trim().length > 0) {
        parts.push(`site=${b.siteName.trim()}`);
      }
      if (typeof b.themeId === "string" && b.themeId.trim().length > 0) {
        parts.push(`theme=${b.themeId.trim()}`);
      }
      if (Array.isArray(b.rules) && b.rules.length > 0) {
        const validRules = b.rules
          .filter((r: unknown) => typeof r === "string" && r.trim().length > 0)
          .map((r: string) => r.trim());
        if (validRules.length > 0) {
          parts.push(`rules: ${validRules.join(" · ")}`);
        }
      }
      if (parts.length > 0) {
        content = parts.join(" ");
      }
    }

    if (!content || content.length === 0) return undefined;
    const boundedContent = content.slice(0, 1024);

    const capsuleId = parsed.capsuleId ?? parsed.details?.capsuleId;
    const briefSeq = typeof parsed.briefSeq === "number" ? parsed.briefSeq : parsed.details?.briefSeq;

    return {
      message: {
        customType: "antifan-capsule-brief",
        display: false,
        attribution: "agent",
        details: {
          capsuleId: typeof capsuleId === "string" ? capsuleId : undefined,
          briefSeq: typeof briefSeq === "number" ? briefSeq : undefined,
        },
        content: boundedContent,
      },
    };
  } catch {
    return undefined;
  }
}

function isAskTool(toolName: string): boolean {
  if (!toolName) return false;
  const normalized = toolName.trim().toLowerCase();
  for (const item of OMP_ASK_TOOLS) {
    if (item.toLowerCase() === normalized) return true;
  }
  const extra = process.env.ANTIFAN_RUN_ASK_TOOLS;
  if (typeof extra === "string" && extra.trim().length > 0) {
    for (const part of extra.split(",")) {
      if (part.trim().toLowerCase() === normalized) return true;
    }
  }
  return false;
}

function sessionIdOf(ctx: unknown): string {
  const context = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>) : {};
  const manager = context.sessionManager as { getSessionId?: () => unknown } | undefined;
  try {
    const raw = manager?.getSessionId?.();
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  } catch {}
  return `pid-${process.pid}`;
}

function cwdOf(ctx: unknown): string {
  const context = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>) : {};
  const cwd = context.cwd;
  if (typeof cwd === "string" && cwd.trim().length > 0) return cwd.trim();
  try {
    return process.cwd();
  } catch {
    return "";
  }
}

function getEnv(): { terminalSessionId: string; dataRoot: string } | null {
  const tsid = process.env.ANTIFAN_TERMINAL_SESSION_ID?.trim();
  const root = process.env.ANTIFAN_DATA_ROOT?.trim();
  if (!tsid || !root) return null;
  return { terminalSessionId: tsid, dataRoot: root };
}
interface HookPi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  sendUserMessage?(text: string, options?: { deliverAs?: string }): void;
  [key: string]: unknown;
}

interface HookContext {
  cwd?: string;
  sessionManager?: {
    getSessionId?: () => unknown;
    [key: string]: unknown;
  };
  abort?: () => void;
  [key: string]: unknown;
}

interface ControlRequestPayload {
  schema?: number;
  op?: string;
  text?: string;
  runSeq?: number;
  requestedAt?: number;
  expiresAt?: number;
  [key: string]: unknown;
}

interface AgentEvent {
  prompt?: unknown;
  willContinue?: boolean;
  toolName?: string;
  name?: string;
  [key: string]: unknown;
}

export default function runStateHook(pi: HookPi): void {
  if (!pi || typeof pi.on !== "function") return;

  let terminalSessionId: string | null = null;
  let dataRoot: string | null = null;
  let runStateFilePath: string | null = null;
  let ompSessionId: string = "";
  let cwd: string = "";
  let state: "idle" | "running" | "waiting_user" | "ended" = "idle";
  let runSeq: number = 0;
  let runStartedAt: number | undefined = undefined;
  let lastEventAt: number = Date.now();
  let lastTool: string | undefined = undefined;
  let promptHead: string | undefined = undefined;
  let pendingAskTool: string | null = null;
  let latestCtx: HookContext | null = null;
  let controlWatcher: fs.FSWatcher | null = null;
  let controlPollTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let sessionInitialized = false;
  let draining = false;
  function writeState(): void {
    if (!runStateFilePath || !dataRoot || !terminalSessionId) return;
    const now = Date.now();
    const mode = readMode(dataRoot, ompSessionId);
    const payload: TerminalRunStateFile = {
      schema: 1,
      terminalSessionId,
      ompSessionId,
      pid: process.pid,
      cwd,
      mode,
      state,
      runSeq,
      ...(runStartedAt !== undefined ? { runStartedAt } : {}),
      lastEventAt,
      ...(lastTool !== undefined ? { lastTool } : {}),
      ...(promptHead !== undefined ? { promptHead } : {}),
      updatedAt: now,
    };
    try {
      atomicWriteJson(runStateFilePath, payload);
    } catch {
      /* never throw into runtime */
    }
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      try {
        if (state !== "ended") {
          writeState();
        }
      } catch {}
    }, RUN_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function drainControl(): void {
    if (draining || !dataRoot || !ompSessionId) return;
    draining = true;
    try {
      const controlDir = path.join(dataRoot, "runtime", "runs", "control", ompSessionId);
      if (!fs.existsSync(controlDir)) return;
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(controlDir);
      } catch {
        return;
      }

      const requestFiles = entries.filter(
        (name) => name.endsWith(".json") && !name.endsWith(".ack.json") && !name.includes(".tmp"),
      );

      for (const fileName of requestFiles) {
        const reqPath = path.join(controlDir, fileName);
        const nonce = fileName.slice(0, -5);
        const ackPath = path.join(controlDir, `${nonce}.ack.json`);

        let raw: string;
        try {
          raw = fs.readFileSync(reqPath, "utf8");
        } catch {
          continue;
        }

        let parsed: ControlRequestPayload | null = null;
        try {
          parsed = JSON.parse(raw) as ControlRequestPayload;
        } catch {
          // Corrupt request acked INVALID_CONTROL_PAYLOAD
          try {
            atomicWriteJson(ackPath, {
              schema: 1,
              ok: false,
              error: "INVALID_CONTROL_PAYLOAD",
              at: Date.now(),
            });
          } catch {}
          try {
            fs.rmSync(reqPath, { force: true });
          } catch {}
          continue;
        }

        const now = Date.now();
        if (typeof parsed?.expiresAt === "number" && now > parsed.expiresAt) {
          // drop silently (no ack) when expiresAt is past
          try {
            fs.rmSync(reqPath, { force: true });
          } catch {}
          continue;
        }

        if (
          !parsed ||
          typeof parsed !== "object" ||
          parsed.schema !== 1 ||
          (parsed.op !== "cancel" && parsed.op !== "steer")
        ) {
          try {
            atomicWriteJson(ackPath, {
              schema: 1,
              ok: false,
              error: "INVALID_CONTROL_PAYLOAD",
              at: Date.now(),
            });
          } catch {}
          try {
            fs.rmSync(reqPath, { force: true });
          } catch {}
          continue;
        }

        if (typeof parsed.runSeq === "number" && parsed.runSeq !== runSeq) {
          try {
            atomicWriteJson(ackPath, {
              schema: 1,
              ok: false,
              error: "STALE_RUN_SEQ",
              at: Date.now(),
            });
          } catch {}
          try {
            fs.rmSync(reqPath, { force: true });
          } catch {}
          continue;
        }

        if (state !== "running" && state !== "waiting_user") {
          try {
            atomicWriteJson(ackPath, {
              schema: 1,
              ok: false,
              error: "RUN_NOT_ACTIVE",
              at: Date.now(),
            });
          } catch {}
          try {
            fs.rmSync(reqPath, { force: true });
          } catch {}
          continue;
        }

        try {
          if (parsed.op === "cancel") {
            if (typeof latestCtx?.abort === "function") {
              latestCtx.abort();
            } else {
              throw new Error("ctx.abort unavailable");
            }
          } else if (parsed.op === "steer") {
            if (typeof pi.sendUserMessage === "function") {
              pi.sendUserMessage(parsed.text ?? "", { deliverAs: "steer" });
            } else {
              throw new Error("pi.sendUserMessage unavailable");
            }
          }
          atomicWriteJson(ackPath, { schema: 1, ok: true, at: Date.now() });
        } catch (err: unknown) {
          const message = (err instanceof Error ? err.message : String(err)).slice(0, 160);
          try {
            atomicWriteJson(ackPath, {
              schema: 1,
              ok: false,
              error: "ACTUATOR_FAILED",
              message,
              at: Date.now(),
            });
          } catch {}
        } finally {
          try {
            fs.rmSync(reqPath, { force: true });
          } catch {}
        }
      }
    } finally {
      draining = false;
    }
  }

  function startControlWatcher(controlDir: string): void {
    stopControlWatcher();
    try {
      fs.mkdirSync(controlDir, { recursive: true });
      controlWatcher = fs.watch(controlDir, () => {
        drainControl();
      });
      controlWatcher.unref?.();
    } catch {
      /* fallback poll will handle it */
    }
    const pollInterval = Number(process.env.ANTIFAN_RUN_CONTROL_POLL_MS) || CONTROL_POLL_INTERVAL_MS;
    controlPollTimer = setInterval(() => {
      drainControl();
    }, pollInterval);
    controlPollTimer.unref?.();
  }

  function stopControlWatcher(): void {
    if (controlWatcher) {
      try {
        controlWatcher.close();
      } catch {}
      controlWatcher = null;
    }
    if (controlPollTimer) {
      clearInterval(controlPollTimer);
      controlPollTimer = null;
    }
  }

  function dispose(): void {
    stopHeartbeat();
    stopControlWatcher();
  }

  if (typeof pi === "object" && pi !== null) {
    (pi as Record<string, unknown>)._drainControl = drainControl;
    (pi as Record<string, unknown>)._dispose = dispose;
  }

  pi.on("session_start", (_event: unknown, ctx: unknown) => {
    try {
      const env = getEnv();
      if (!env) return;
      if (ctx && typeof ctx === "object") latestCtx = ctx as HookContext;

      terminalSessionId = env.terminalSessionId;
      dataRoot = env.dataRoot;
      runStateFilePath = path.join(dataRoot, "runtime", "runs", `${terminalSessionId}.json`);

      const newOmpSessionId = sessionIdOf(ctx);
      cwd = cwdOf(ctx);

      // Carry-over rule: keep stored runSeq when ompSessionId matches, reset to 0 otherwise
      const existing = readRunStateFile(runStateFilePath);
      if (existing && existing.ompSessionId === newOmpSessionId) {
        runSeq = typeof existing.runSeq === "number" ? existing.runSeq : 0;
      } else {
        runSeq = 0;
      }

      ompSessionId = newOmpSessionId;
      state = "idle";
      pendingAskTool = null;
      lastEventAt = Date.now();
      sessionInitialized = true;

      writeState();
      startHeartbeat();

      const controlDir = path.join(dataRoot, "runtime", "runs", "control", ompSessionId);
      startControlWatcher(controlDir);
    } catch {
      /* never throw */
    }
  });

  pi.on("before_agent_start", (event: unknown, ctx: unknown) => {
    try {
      const env = getEnv();
      if (!env) return undefined;
      if (ctx && typeof ctx === "object") latestCtx = ctx as HookContext;

      if (!sessionInitialized) {
        terminalSessionId = env.terminalSessionId;
        dataRoot = env.dataRoot;
        runStateFilePath = path.join(dataRoot, "runtime", "runs", `${terminalSessionId}.json`);
        ompSessionId = sessionIdOf(ctx);
        cwd = cwdOf(ctx);
        sessionInitialized = true;
        startHeartbeat();
        const controlDir = path.join(dataRoot, "runtime", "runs", "control", ompSessionId);
        startControlWatcher(controlDir);
      }

      state = "running";
      runSeq += 1;
      const now = Date.now();
      runStartedAt = now;
      lastEventAt = now;
      const ev = (event && typeof event === "object" ? event : {}) as AgentEvent;
      promptHead = normalizePromptHead(ev.prompt);

      writeState();

      if (!dataRoot || !terminalSessionId) return undefined;
      return readCapsuleBrief(dataRoot, terminalSessionId);
    } catch {
      return undefined;
    }
  });

  pi.on("tool_call", (event: unknown, ctx: unknown) => {
    try {
      const env = getEnv();
      if (!env) return;
      if (ctx && typeof ctx === "object") latestCtx = ctx as HookContext;

      const ev = (event && typeof event === "object" ? event : {}) as AgentEvent;
      const toolName = String(ev.toolName ?? ev.name ?? "");
      if (toolName.length > 0) lastTool = toolName;
      lastEventAt = Date.now();
      if (isAskTool(toolName)) {
        state = "waiting_user";
        pendingAskTool = toolName;
      }

      writeState();
    } catch {
      /* never throw */
    }
  });

  pi.on("tool_result", (event: unknown, ctx: unknown) => {
    try {
      const env = getEnv();
      if (!env) return;
      if (ctx && typeof ctx === "object") latestCtx = ctx as HookContext;

      const ev = (event && typeof event === "object" ? event : {}) as AgentEvent;
      const toolName = String(ev.toolName ?? ev.name ?? "");
      if (toolName.length > 0) lastTool = toolName;
      lastEventAt = Date.now();
      if (state === "waiting_user") {
        const answersAsk =
          (pendingAskTool && pendingAskTool.trim().toLowerCase() === toolName.trim().toLowerCase()) ||
          isAskTool(toolName);
        if (answersAsk) {
          state = "running";
          pendingAskTool = null;
        }
      }

      writeState();
    } catch {
      /* never throw */
    }
  });

  pi.on("agent_end", (event: unknown, ctx: unknown) => {
    try {
      const env = getEnv();
      if (!env) return;
      if (ctx && typeof ctx === "object") latestCtx = ctx as HookContext;

      const ev = (event && typeof event === "object" ? event : {}) as AgentEvent;
      if (ev.willContinue) {
        return;
      }

      if (state === "idle") {
        // Re-entry tolerant: a second settling agent_end is a no-op
        return;
      }

      state = "idle";
      pendingAskTool = null;
      lastEventAt = Date.now();

      writeState();
    } catch {
      /* never throw */
    }
  });

  pi.on("turn_end", (_event: unknown, ctx: unknown) => {
    try {
      const env = getEnv();
      if (!env) return;
      if (ctx && typeof ctx === "object") latestCtx = ctx as HookContext;

      lastEventAt = Date.now();
      writeState();
    } catch {
      /* never throw */
    }
  });

  pi.on("session_shutdown", (_event: unknown, ctx: unknown) => {
    try {
      const env = getEnv();
      if (!env) return;
      if (ctx && typeof ctx === "object") latestCtx = ctx as HookContext;

      state = "ended";
      dispose();
      lastEventAt = Date.now();

      writeState();
    } catch {
      /* never throw */
    }
  });
}
