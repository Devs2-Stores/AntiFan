/**
 * AntiFan wait-alert - makes "OMP is blocked on you" unmissable on Windows.
 *
 * The harness already signals a wait through subtle channels (terminal title run
 * state, BEL when `ask.notify` is on, the Orca tab badge), and Orca suppresses its
 * own notifications while its window is focused, so a pending ask prompt is easy
 * to misread as a running turn.
 *
 * This extension fires a sound, flashes the Orca taskbar button until Orca is
 * focused, and shows an always-on-top panel carrying the pending question -
 * repeating the sound+flash on a bounded timer until the wait resolves. The panel
 * is killed the moment the user answers.
 *
 * Dependency-free: standard runtime primitives plus the sibling alert.ps1 helper.
 * Off Windows it degrades to a BEL byte plus a UI notification.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export interface WaitAlertLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface WaitAlertUI {
  notify?(message: string, level?: "info" | "warning" | "error"): void;
}

export interface WaitAlertContext {
  cwd?: string;
  ui?: WaitAlertUI;
  setTimeout?(handler: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface WaitAlertEvent {
  toolName?: string;
  name?: string;
  args?: unknown;
  reason?: string;
  approvalMode?: string;
}

export interface WaitAlertAPI {
  logger?: WaitAlertLogger;
  on?(event: string, handler: (event: WaitAlertEvent, ctx: WaitAlertContext) => unknown): void;
}

/** Tool whose execution blocks the turn on a user answer. */
const ASK_TOOL = "ask";
/** Max characters of question text that reach the panel. */
const BODY_LIMIT = 180;

interface WaitAlertSettings {
  enabled: boolean;
  panel: boolean;
  sound: "system" | "off";
  soundFile: string;
  repeatMs: number;
  maxRepeats: number;
  lifetimeMs: number;
  logPath: string;
  psLogPath: string;
  scriptPath: string;
}

interface ActiveWait {
  reason: string;
  detail: string;
  repeats: number;
  timer: unknown;
  panelChild: { kill(): boolean } | null;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveScriptPath(): string {
  const override = process.env.ANTIFAN_WAIT_ALERT_SCRIPT;
  if (override) return override;
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "alert.ps1");
  } catch {
    return join(process.cwd(), ".omp", "extensions", "wait-alert", "alert.ps1");
  }
}

function readSettings(): WaitAlertSettings {
  const logPath = process.env.ANTIFAN_WAIT_ALERT_LOG ?? join(tmpdir(), "antifan-wait-alert.log");
  return {
    enabled: (process.env.ANTIFAN_WAIT_ALERT ?? "on").toLowerCase() !== "off",
    panel: (process.env.ANTIFAN_WAIT_ALERT_PANEL ?? "on").toLowerCase() !== "off",
    sound: (process.env.ANTIFAN_WAIT_ALERT_SOUND ?? "system").toLowerCase() === "off" ? "off" : "system",
    soundFile: process.env.ANTIFAN_WAIT_ALERT_SOUND_FILE ?? "",
    repeatMs: readInt("ANTIFAN_WAIT_ALERT_REPEAT_MS", 30_000),
    maxRepeats: readInt("ANTIFAN_WAIT_ALERT_MAX_REPEATS", 3),
    lifetimeMs: readInt("ANTIFAN_WAIT_ALERT_LIFETIME_MS", 60_000),
    logPath,
    psLogPath: `${logPath}.ps`,
    scriptPath: resolveScriptPath(),
  };
}

/** Strips control characters and quoting hazards before the text reaches a command line. */
function sanitize(text: string, limit: number): string {
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function describeAsk(args: unknown): string {
  const questions = (args as { questions?: unknown } | null | undefined)?.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const first = questions[0] as { question?: unknown; id?: unknown } | null;
    const extra = questions.length > 1 ? ` (+${questions.length - 1} câu nữa)` : "";
    const text = typeof first?.question === "string" ? first.question.trim() : "";
    if (text) return `${text}${extra}`;
    return `Câu hỏi #${String(first?.id ?? "1")}${extra}`;
  }
  try {
    const raw = JSON.stringify(args ?? "");
    if (raw && raw !== '""') return raw;
  } catch {
    // Circular or unserializable args fall through to the generic label.
  }
  return "Harness đang chờ bạn trả lời.";
}

function describeApproval(event: WaitAlertEvent): string {
  const tool = event.toolName ?? event.name ?? "tool";
  const reason = typeof event.reason === "string" && event.reason.trim() ? ` - ${event.reason.trim()}` : "";
  const mode = event.approvalMode ? ` [${event.approvalMode}]` : "";
  return `Cần phê duyệt: ${tool}${mode}${reason}`;
}

export default function antifanWaitAlertExtension(pi: WaitAlertAPI): void {
  const settings = readSettings();

  const log = (entry: Record<string, unknown>): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry });
    try {
      appendFileSync(settings.logPath, `${line}\n`);
    } catch {
      // Logging is diagnostic only; a blocked temp dir must not stop the alert.
    }
    pi?.logger?.info?.(`[antifan-wait-alert] ${line}`);
  };

  const spawnPowershell = (shell: string, reason: string, body: string, withPanel: boolean): { kill(): boolean } | null => {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      settings.scriptPath,
      "-Title",
      reason,
      "-Body",
      body,
      "-Sound",
      settings.sound,
      "-LifetimeMs",
      String(settings.lifetimeMs),
      "-ErrorLog",
      settings.psLogPath,
    ];
    if (settings.soundFile) args.push("-SoundFile", settings.soundFile);
    if (!withPanel) args.push("-NoPanel");

    try {
      const child = spawn(shell, args, {
        // detached:true on Windows makes the child exit early (observed: the
        // panel process died within ~1s). unref() alone lets the parent exit
        // while the alert keeps running; windowsHide suppresses the console.
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      child.unref();
      return child;
    } catch (error) {
      log({ event: "alert-failed", shell, error: String(error) });
      return null;
    }
  };

  const runAlert = (reason: string, detail: string, withPanel: boolean): { kill(): boolean } | null => {
    if (!settings.enabled) return null;

    if (!isWindows()) {
      // No native popup channel: a BEL byte still reaches the terminal emulator.
      try {
        process.stdout.write("\u0007");
      } catch {
        // A closed stdout must not throw inside the event handler.
      }
      log({ event: "alert", channel: "bell", reason, detail });
      return null;
    }

    const title = sanitize(reason, 120);
    const body = sanitize(detail, BODY_LIMIT);
    const child = spawnPowershell(process.env.ANTIFAN_WAIT_ALERT_SHELL ?? "powershell.exe", title, body, withPanel && settings.panel);
    log({ event: "alert", channel: "powershell", reason, title, body, panel: withPanel && settings.panel });
    return child;
  };

  const schedule = (ctx: WaitAlertContext, fn: () => void, ms: number): unknown => {
    if (typeof ctx?.setTimeout === "function") {
      try {
        return ctx.setTimeout(fn, ms);
      } catch {
        // Fall through to the global timer.
      }
    }
    return setTimeout(fn, ms);
  };

  const cancel = (ctx: WaitAlertContext, handle: unknown): void => {
    if (handle === null || handle === undefined) return;
    if (typeof ctx?.clearTimer === "function") {
      try {
        ctx.clearTimer(handle);
        return;
      } catch {
        // Fall through to the global timer.
      }
    }
    // The ambient timer APIs accept whatever their own setTimeout returned; the
    // handle stays opaque to this module.
    (clearTimeout as (handle: unknown) => void)(handle);
  };

  let active: ActiveWait | null = null;

  const scheduleRepeat = (ctx: WaitAlertContext): void => {
    if (!active || settings.repeatMs <= 0 || active.repeats >= settings.maxRepeats) return;
    active.timer = schedule(
      ctx,
      () => {
        if (!active) return;
        active.repeats += 1;
        active.timer = null;
        // Repeats re-alert with sound+flash only: panels never stack.
        runAlert(active.reason, active.detail, false);
        scheduleRepeat(ctx);
      },
      settings.repeatMs,
    );
  };

  const clearWait = (ctx: WaitAlertContext, resolvedBy: string): void => {
    if (!active) return;
    cancel(ctx, active.timer);
    if (active.panelChild) {
      try {
        active.panelChild.kill();
      } catch {
        // The panel may have already exited on its own lifetime.
      }
    }
    log({ event: "wait-cleared", resolvedBy, reason: active.reason, repeats: active.repeats });
    active = null;
  };

  const beginWait = (ctx: WaitAlertContext, reason: string, detail: string): void => {
    if (!settings.enabled) return;
    if (active) {
      cancel(ctx, active.timer);
      if (active.panelChild) {
        try {
          active.panelChild.kill();
        } catch {
          // Already exited.
        }
      }
      log({ event: "wait-superseded", previousReason: active.reason, reason });
    }
    active = { reason, detail, repeats: 0, timer: null, panelChild: null };
    active.panelChild = runAlert(reason, detail, true);
    scheduleRepeat(ctx);
  };

  if (typeof pi?.on !== "function") {
    pi?.logger?.warn?.("[antifan-wait-alert] runtime exposes no event API; alerts disabled");
    return;
  }

  log({
    event: "loaded",
    enabled: settings.enabled,
    platform: process.platform,
    panel: settings.panel,
    repeatMs: settings.repeatMs,
    maxRepeats: settings.maxRepeats,
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const toolName = event?.toolName ?? event?.name ?? "";
    if (toolName !== ASK_TOOL) return;
    beginWait(ctx, "AntiFan · OMP đang chờ bạn trả lời", describeAsk(event?.args));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const toolName = event?.toolName ?? event?.name ?? "";
    if (toolName !== ASK_TOOL) return;
    clearWait(ctx, "ask-answered");
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    beginWait(ctx, "AntiFan · OMP cần bạn phê duyệt", describeApproval(event));
  });

  pi.on("tool_approval_resolved", (_event, ctx) => {
    clearWait(ctx, "approval-resolved");
  });

  // Defensive clears: a wait must never outlive the turn that spawned it, even
  // when its own resolution event is missed.
  pi.on("agent_end", (_event, ctx) => {
    clearWait(ctx, "agent-end");
  });

  pi.on("turn_end", (_event, ctx) => {
    clearWait(ctx, "turn-end");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearWait(ctx, "session-shutdown");
  });
}
