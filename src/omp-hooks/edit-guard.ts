/**
 * Edit-guard hook — the user-scope enforcement half of the edit-mode contract.
 *
 * Arms a mode from the prompt (or inherits it), refuses writes that leave the
 * writable set, refuses the tools a scoped mode excludes, and leaves an
 * append-only audit trail the Manager and the QA gate both read:
 * `<workspaceRoot>/.antifan/edit-guard/<ompSessionId>.jsonl`.
 *
 * Nothing in here throws: a hook that throws turns a policy into an outage, so
 * every handler catches and every refusal is a returned value. A `tool_call` the
 * wiring could not classify is a refusal while the session is scoped — an
 * unclassified call has not been cleared, and clearing by failure is the one
 * outcome the guard exists to prevent.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  EDIT_MODE_ENV,
  MODE_LABELS,
  SCOPED_MODES,
  deriveEditMode,
  readEditModeEnv,
  readEditModeFromBranch,
  type EditMode,
  type EditModeTrigger,
} from "./edit-mode";
import { planToolCall, REFUSAL_CODES, WRITE_TOOLS } from "./edit-guard-policy";
import { resolveWorkspaceShape, type WorkspaceShape } from "./theme-paths";

export const GUARD_ENTRY_TYPE = "antifan.edit-mode";
export const LOG_DIR_PARTS = [".antifan", "edit-guard"];
const MIRROR_DIR_PARTS = ["runtime", "edit-mode"];
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

export interface AuditRow {
  ts: string;
  runSeq: number;
  mode: EditMode;
  tool: string;
  path: string;
  decision: "allow" | "block";
  code: string;
  terminalSessionId: string | null;
  ompSessionId: string;
}

interface GuardSession {
  sessionId: string;
  mode: EditMode;
  trigger: EditModeTrigger;
  runSeq: number;
  runChanged: string[];
  shape: WorkspaceShape;
  logPath: string;
  mirrorPath: string | null;
}

const sessions = new Map<string, GuardSession>();

function contextRecord(ctx: unknown): Record<string, unknown> {
  return ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>) : {};
}

function sessionIdOf(ctx: unknown): string {
  const context = contextRecord(ctx);
  const manager = context.sessionManager as { getSessionId?: () => unknown } | undefined;
  const raw = manager?.getSessionId?.();
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return `pid-${process.pid}`;
}

function cwdOf(ctx: unknown): string {
  const context = contextRecord(ctx);
  const cwd = context.cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : process.cwd();
}

function branchOf(ctx: unknown): unknown {
  const context = contextRecord(ctx);
  const manager = context.sessionManager as { getBranch?: () => unknown } | undefined;
  try {
    return manager?.getBranch?.();
  } catch {
    return null;
  }
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || `pid-${process.pid}`;
}

function mirrorPathFor(sessionId: string, env: Record<string, string | undefined>): string | null {
  const root = env.ANTIFAN_DATA_ROOT;
  if (typeof root !== "string" || root.trim().length === 0) return null;
  return path.join(root.trim(), ...MIRROR_DIR_PARTS, `${safeFileSegment(sessionId)}.json`);
}

/**
 * The run number a resumed session continues from: the highest `runSeq` in the
 * session's own audit log, or 0 when there is no readable one. Torn lines and
 * rows without a numeric `runSeq` are skipped, never fatal - a damaged log must
 * not cost the session its guard.
 *
 * Without this a resumed session (`omp -c`) restarts at 1 while its log already
 * holds higher numbers, so every reader that identifies "the current run" by the
 * log's maximum attributes the killed process's last run instead: the QA gate's
 * changed-file line and the Manager's per-run change review both read it that way
 * (`changedFilesThisRun`, src/omp-hooks/theme-qa-gate.ts). A rotation is the one
 * reset both sides see together - appendRows renames the log to `<name>.1.jsonl`
 * and starts fresh, so the maximum and the counter move to the new file as a pair.
 */
function lastRunSeqInLog(logPath: string): number {
  let text: string;
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
    return 0;
  }
  let max = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== "object" || !("runSeq" in row)) continue;
      const seq = row.runSeq;
      if (typeof seq === "number" && Number.isFinite(seq) && seq > max) max = seq;
    } catch {
      /* a torn line must not hide the rest of the log */
    }
  }
  return max;
}

/**
 * What the guard can still say about the scope of a call whose handler failed: the
 * session record if one exists, else the published env latch (the same channel a
 * subagent inherits). Null means nothing claims the session is scoped, and an
 * unscoped session has nothing to enforce.
 */
function scopeEvidence(ctx: unknown): EditMode | null {
  try {
    const known = sessions.get(sessionIdOf(ctx));
    if (known) return known.mode;
  } catch {
    /* an unreadable context is exactly the case this runs for */
  }
  try {
    return readEditModeEnv(process.env);
  } catch {
    return null;
  }
}

function isScopedMode(mode: EditMode | null): mode is "direct" | "fast" {
  return mode === "direct" || mode === "fast";
}

/** A logger that throws must not change a decision: it is a report, not an authority. */
function warnSafely(pi: GuardPi, message: string): void {
  try {
    pi.logger?.warn?.(message);
  } catch {
    /* reporting is best-effort */
  }
}

/**
 * The text of a thrown value, without letting the value decide whether the guard can
 * report. A null-prototype object, a throwing `message` getter or a hostile `toString`
 * all reach here from the same place the refusal is being built.
 */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error && typeof err.message === "string") return err.message;
  } catch {
    /* a throwing message getter falls through to the coercion below */
  }
  try {
    return String(err);
  } catch {
    try {
      return Object.prototype.toString.call(err);
    } catch {
      return "unprintable error";
    }
  }
}

function buildSession(ctx: unknown): GuardSession {
  const sessionId = sessionIdOf(ctx);
  const cwd = cwdOf(ctx);
  const env = process.env;
  const fromEnv = readEditModeEnv(env);
  const fromBranch = readEditModeFromBranch(branchOf(ctx));
  const mode: EditMode = fromEnv ?? fromBranch ?? "unset";
  const trigger: EditModeTrigger = fromEnv !== null ? "env_latch" : fromBranch !== null ? "inherited" : "none";
  const shape = resolveWorkspaceShape(cwd, env);
  const logPath = path.join(shape.workspaceRoot, ...LOG_DIR_PARTS, `${safeFileSegment(sessionId)}.jsonl`);
  return {
    sessionId,
    mode,
    trigger,
    runSeq: lastRunSeqInLog(logPath),
    runChanged: [],
    shape,
    logPath,
    mirrorPath: mirrorPathFor(sessionId, env),
  };
}

function ensureSession(ctx: unknown): GuardSession {
  const existing = sessions.get(sessionIdOf(ctx));
  if (existing) return existing;
  const created = buildSession(ctx);
  sessions.set(created.sessionId, created);
  return created;
}

function appendRows(session: GuardSession, rows: AuditRow[]): void {
  if (rows.length === 0) return;
  try {
    const dir = path.dirname(session.logPath);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(session.logPath) && fs.statSync(session.logPath).size > LOG_ROTATE_BYTES) {
      fs.renameSync(session.logPath, session.logPath.replace(/\.jsonl$/, ".1.jsonl"));
    }
    fs.appendFileSync(session.logPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  } catch {
    /* audit is best-effort: never break the session over a log write */
  }
}

function rowFor(
  session: GuardSession,
  tool: string,
  target: string,
  decision: "allow" | "block",
  code: string,
): AuditRow {
  const terminal = process.env.ANTIFAN_TERMINAL_SESSION_ID;
  return {
    ts: new Date().toISOString(),
    runSeq: session.runSeq,
    mode: session.mode,
    tool,
    path: target,
    decision,
    code,
    terminalSessionId: typeof terminal === "string" && terminal.trim().length > 0 ? terminal.trim() : null,
    ompSessionId: session.sessionId,
  };
}

function writeMirror(session: GuardSession): void {
  const target = session.mirrorPath;
  if (target === null) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const payload = {
      schema: 1,
      ompSessionId: session.sessionId,
      mode: session.mode,
      trigger: session.trigger,
      cwd: session.shape.cwd,
      terminalSessionId: process.env.ANTIFAN_TERMINAL_SESSION_ID ?? null,
      at: new Date().toISOString(),
    };
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
  } catch {
    /* mirror is observability, never authority */
  }
}

function applyEnvMirror(mode: EditMode): void {
  try {
    if (mode === "unset") delete process.env[EDIT_MODE_ENV];
    else process.env[EDIT_MODE_ENV] = mode;
  } catch {
    /* env is a best-effort inheritance channel */
  }
}

function clearEnvMirror(): void {
  try {
    delete process.env[EDIT_MODE_ENV];
  } catch {
    /* ignore */
  }
}

function dropMirror(session: GuardSession): void {
  if (session.mirrorPath === null) return;
  if (session.mode === "direct" || session.mode === "fast") return;
  try {
    fs.rmSync(session.mirrorPath, { force: true });
  } catch {
    /* ignore */
  }
}

interface GuardPi {
  on?: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => void;
  appendEntry?: (customType: string, data: unknown) => unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}

export default function editGuardHook(pi: GuardPi): void {
  if (!pi || typeof pi.on !== "function") return;

  pi.on("session_start", (_event, ctx) => {
    try {
      const session = ensureSession(ctx);
      applyEnvMirror(session.mode);
      writeMirror(session);
    } catch {
      /* never throw from a hook */
    }
    return undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    try {
      const session = ensureSession(ctx);
      const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
      const decision = deriveEditMode(typeof prompt === "string" ? prompt : undefined, session.mode);
      session.runSeq += 1;
      session.runChanged = [];
      if (decision.changed) {
        session.mode = decision.mode;
        session.trigger = decision.trigger;
        pi.appendEntry?.(GUARD_ENTRY_TYPE, {
          mode: session.mode,
          trigger: session.trigger,
          cwd: session.shape.cwd,
          at: new Date().toISOString(),
        });
        applyEnvMirror(session.mode);
        writeMirror(session);
      }
    } catch {
      /* never throw from a hook */
    }
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const session = ensureSession(ctx);
      if (!(SCOPED_MODES as readonly string[]).includes(session.mode)) return undefined;
      const record = contextRecord(event);
      const tool = String(record.toolName ?? record.name ?? "");
      const input = contextRecord(record.input);
      const plan = planToolCall({ mode: session.mode, tool, input, shape: session.shape });
      if (plan.decision === "block") {
        appendRows(session, [rowFor(session, tool, plan.targets[0] ?? plan.device ?? "", "block", plan.code)]);
        // The warning is a report, not the refusal: a logger that throws must not turn this
        // into a guard error (or into a pass-through).
        warnSafely(pi, plan.reason);
        return { block: true, reason: plan.reason };
      }
      if (WRITE_TOOLS[tool.trim().toLowerCase()] === true) {
        // Only file-changing calls become rows. A read that names a path is not a change,
        // and the row count is read back as "N file(s) changed" by `turn_end` and by the
        // Manager run card, so an inspection path must never enter it.
        appendRows(
          session,
          plan.targets.map((target) => rowFor(session, tool, target, "allow", "ALLOWED")),
        );
        for (const target of plan.targets) {
          if (!session.runChanged.includes(target)) session.runChanged.push(target);
        }
      }
    } catch (err) {
      // Never throw from a hook, but never clear a call either: if the wiring failed
      // before the policy ran, the call is unclassified, and in a scoped session an
      // unclassified call is refused. An unscoped session falls through, because there
      // is nothing to enforce there and a stuck write tool would be an outage.
      const mode = scopeEvidence(ctx);
      if (!isScopedMode(mode)) return undefined;
      const reason = `${REFUSAL_CODES.GUARD_ERROR}: the guard could not classify this call (${describeError(err)}), and ${MODE_LABELS[mode]} refuses what it cannot verify. Send [Core-Context] to run it unguarded.`;
      try {
        const session = sessions.get(sessionIdOf(ctx));
        if (session) {
          appendRows(session, [
            rowFor(session, String(contextRecord(event).toolName ?? ""), "", "block", REFUSAL_CODES.GUARD_ERROR),
          ]);
        }
      } catch {
        /* the audit row is best-effort even here */
      }
      // The refusal is returned whatever the reporting does: a logger that throws, or a
      // thrown value that cannot be turned into text, must not decide this call.
      warnSafely(pi, reason);
      return { block: true, reason };
    }
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      const session = sessions.get(sessionIdOf(ctx));
      if (session) {
        dropMirror(session);
        sessions.delete(session.sessionId);
      }
      clearEnvMirror();
    } catch {
      /* never throw from a hook */
    }
    return undefined;
  });
}
