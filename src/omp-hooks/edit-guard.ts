/**
 * Edit-guard hook - the user-scope enforcement half of the edit-mode contract.
 *
 * Arms a mode from the prompt (or inherits it), and enforces per mode: `direct`
 * refuses nothing locally - its contract is Core suppression and lives in the
 * bridge hook; `fast` refuses the shell, dispatch, eval, search and every
 * device call, and confines writes to the theme's writable set. Both modes
 * leave an append-only audit trail the Manager and the QA gate both read:
 * `<workspaceRoot>/.antifan/edit-guard/<ompSessionId>.jsonl`.
 *
 * `config/settings_data.json` is writable in every mode, but the shop editor is a
 * second writer of that file, so the first write per agent run first refreshes it
 * with `hrv theme fetch <themeId> --only config/settings_data.json` (theme id from
 * `.haravan-cli_local.json`). A failed fetch refuses the write; a workspace with no
 * bound shop has no remote copy and writes without one.
 *
 * In a Leader's worker terminal (its id is under `workers` in the Manager's
 * `leader-terminals.json`), a shell call that would change a theme on the shop is
 * gated in every mode: only `hrv theme push --only ...` / `hrv theme dev` against
 * the bound theme pass, and only after `hrv theme info -j` reports that theme is not
 * the live (`main`) one. Publish, delete, Shopify writes, `--force` and whole-theme
 * pushes are refused, and so is any line that names the theme CLI in a shape the rules
 * cannot read (wrapper, subshell, quoted CLI word; `REFUSED_THEME_COMPLEX`). The decision
 * is `gateThemeLine` in `theme-draft-probe.ts`, shared with the Manager's `terminal.write`.
 *
 * Nothing in here throws: a hook that throws turns a policy into an outage, so
 * every handler catches and every refusal is a returned value. A `tool_call` the
 * wiring could not classify is a refusal while the session is scoped - an
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
import {
  DEVICE_PATH_RE,
  extractTargetPaths,
  planToolCall,
  READ_TOOLS,
  REFUSAL_CODES,
  WRITE_TOOLS,
} from "./edit-guard-policy";
import { resolveShopIdentity, resolveWorkspaceShape, type WorkspaceShape } from "./theme-paths";
import { describeError, gateThemeLine, lastOutputLine, runHrv } from "./theme-draft-probe";
import { mentionsThemeCli, planEvalThemeCode } from "./theme-push-policy";

export const GUARD_ENTRY_TYPE = "antifan.edit-mode";
export const LOG_DIR_PARTS = [".antifan", "edit-guard"];
const MIRROR_DIR_PARTS = ["runtime", "edit-mode"];
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
const SETTINGS_DATA_RE = /(^|[/\\])config[/\\]settings_data\.json$/i;
const SETTINGS_DATA_FETCH_TIMEOUT_MS = 90_000;
const THEME_INFO_TIMEOUT_MS = 30_000;
/** Audit code of a worker push/dev the guard let through after `hrv theme info` proved a draft. */
const THEME_DRAFT_VERIFIED = "THEME_SYNC_DRAFT_VERIFIED";
/** The Manager's Leader registry under the config dir (`src/main/leader/leader-registry.ts`). */
const LEADER_REGISTRY_FILE = "leader-terminals.json";

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
  /** The run whose first settings_data write already fetched; -1 = never (run 0 is real). */
  settingsDataFetchedRunSeq: number;
  /** Set when a pre-write fetch changed `config/settings_data.json`; cleared once a read tool inspects that path. */
  settingsDataRereadRequired: boolean;
  /** Latest backup path saved when a pre-write fetch overwrote local `config/settings_data.json`, if any. */
  settingsDataBackupPath: string | null;
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

function isScopedMode(mode: EditMode | null): mode is "fast" {
  // Only fast has refusals to protect; a classification failure in direct must
  // not invent the one block its contract (Core suppression only) does not own.
  return mode === "fast";
}

/** A logger that throws must not change a decision: it is a report, not an authority. */
function warnSafely(pi: GuardPi, message: string): void {
  try {
    pi.logger?.warn?.(message);
  } catch {
    /* reporting is best-effort */
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
    settingsDataFetchedRunSeq: -1,
    settingsDataRereadRequired: false,
    settingsDataBackupPath: null,
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

interface FetchOutcome {
  ok: boolean;
  detail: string;
}

/**
 * `hrv theme fetch <themeId> --only config/settings_data.json` in the theme root.
 * The CLI prints its failures and exits 0, so the job message is the only verdict:
 * success is literally "Tải về thành công 1 file." (live-ops-service.ts).
 */
async function runSettingsDataFetch(themeRoot: string, themeId: string): Promise<FetchOutcome> {
  if (!/^\d+$/.test(themeId)) {
    return { ok: false, detail: `theme_id '${themeId}' in .haravan-cli_local.json is not numeric` };
  }
  const run = await runHrv(themeRoot, `theme fetch ${themeId} --only config/settings_data.json`, SETTINGS_DATA_FETCH_TIMEOUT_MS);
  if (run.output === null) return { ok: false, detail: run.failure };
  if (/Tải về thành công 1 file\./.test(run.output)) return { ok: true, detail: "Tải về thành công 1 file." };
  return { ok: false, detail: `${lastOutputLine(run.output)} (exit ${run.exitCode ?? "null"})` };
}

/** Registry read errors that mean "the file is locked right now", not "there is no registry". */
const TRANSIENT_READ_CODES: Record<string, true> = { EBUSY: true, EPERM: true, EACCES: true, EMFILE: true };
const REGISTRY_READ_RETRIES = 2;
const REGISTRY_RETRY_DELAY_MS = 50;

/**
 * True when the terminal this OMP runs in is a Leader's worker. Read fresh per call:
 * the Leader can take a worker on or hand it over at any time, and the registry the
 * Manager writes is the only record of it.
 *
 * The Manager replaces the file atomically (temp file + rename), and on Windows a reader
 * can hit EBUSY/EPERM/EACCES/EMFILE during that swap. Those lock errors are retried, and
 * if the file still cannot be read the answer is "worker": a wrong "worker" only costs a
 * refused theme remote operation, while a wrong "not a worker" lets a push through. A
 * missing file, a directory in its place or unparsable JSON are not lock errors: there is
 * no record that could name this terminal, so it is not a worker.
 */
async function isLeaderWorker(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const terminalId = env.ANTIFAN_TERMINAL_SESSION_ID?.trim();
  if (!terminalId) return false;
  const dataRoot = env.ANTIFAN_DATA_ROOT?.trim();
  const configDir = env.ANTIFAN_CONFIG_DIR?.trim() || (dataRoot ? path.join(dataRoot, "config") : "");
  if (!configDir) return false;
  const registryPath = path.join(configDir, LEADER_REGISTRY_FILE);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const file = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
        workers?: Record<string, { leaderId?: unknown } | undefined>;
      };
      const record = file?.workers?.[terminalId];
      return typeof record?.leaderId === "string" && record.leaderId.length > 0;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (typeof code !== "string" || TRANSIENT_READ_CODES[code] !== true) return false;
      if (attempt >= REGISTRY_READ_RETRIES) return true;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, REGISTRY_RETRY_DELAY_MS);
      await promise;
    }
  }
}

/** Longest command text an audit row keeps in its `path` column. */
const AUDIT_COMMAND_MAX = 200;

/**
 * The refusal for a worker's shell call that would change a theme on the shop, or
 * null when the call may run. Calls that name no theme CLI pass untouched, without
 * touching the registry; so do non-worker sessions, without a probe. A worker may
 * only sync its own bound draft theme, as one plain command (see `theme-draft-probe.ts`).
 */
async function gateThemeCommand(session: GuardSession, input: Record<string, unknown>): Promise<string | null> {
  const text = typeof input.command === "string" ? input.command : "";
  if (!mentionsThemeCli(text) || !(await isLeaderWorker())) return null;
  const cwd =
    typeof input.cwd === "string" && input.cwd.trim().length > 0
      ? path.resolve(session.shape.cwd, input.cwd.trim())
      : session.shape.cwd;
  const outcome = await gateThemeLine({ text, cwd, timeoutMs: THEME_INFO_TIMEOUT_MS });
  if (outcome.decision === "pass") return null;
  if (outcome.decision === "block") {
    appendRows(session, [rowFor(session, "bash", outcome.command.slice(0, AUDIT_COMMAND_MAX), "block", outcome.code)]);
    return outcome.reason;
  }
  // The path stays empty on purpose: the Manager counts every allow row with a path as a
  // changed file, and a verified sync is not one.
  appendRows(session, outcome.verified.map(() => rowFor(session, "bash", "", "allow", THEME_DRAFT_VERIFIED)));
  return null;
}

/**
 * Whether a `bash` / `eval` call the guard failed to classify names the theme CLI inside an
 * AntiFan terminal (every terminal carries `ANTIFAN_TERMINAL_SESSION_ID`); the caller then
 * refuses it only for a Leader's worker. A failure while reading the call itself counts as a
 * mention: the call is unclassified, and an unclassified call that might change the shop is
 * not cleared.
 */
function failedCallNamesThemeCli(event: unknown): boolean {
  const terminal = process.env.ANTIFAN_TERMINAL_SESSION_ID;
  if (typeof terminal !== "string" || terminal.trim().length === 0) return false;
  try {
    const record = contextRecord(event);
    const tool = String(record.toolName ?? record.name ?? "").trim().toLowerCase();
    if (tool !== "bash" && tool !== "eval") return false;
    const input = contextRecord(record.input);
    const text = tool === "bash" ? input.command : input.code;
    return typeof text === "string" && mentionsThemeCli(text);
  } catch {
    return true;
  }
}

function isSettingsDataPath(rawPath: string, cwd: string): boolean {
  if (DEVICE_PATH_RE.test(rawPath)) return false;
  const cleaned = rawPath.replace(/:(?:raw(?::[\d,+\-]+)?|[\d,+\-]+(?::raw)?)$/i, "");
  return SETTINGS_DATA_RE.test(cleaned) || SETTINGS_DATA_RE.test(path.resolve(cwd, cleaned));
}

function hasSettingsDataChanged(beforeBytes: Buffer | null, afterBytes: Buffer | null): boolean {
  if (beforeBytes === null && afterBytes === null) return false;
  if (beforeBytes === null || afterBytes === null) return true;
  const beforeText = beforeBytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const afterText = afterBytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (beforeText === afterText) return false;
  try {
    const beforeJson = JSON.stringify(JSON.parse(beforeText));
    const afterJson = JSON.stringify(JSON.parse(afterText));
    return beforeJson !== afterJson;
  } catch {
    return true;
  }
}

function saveSettingsDataBackup(root: string, beforeBytes: Buffer): string | null {
  try {
    const dir = path.join(root, ...LOG_DIR_PARTS);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dir, `settings_data.${stamp}.bak.json`);
    fs.writeFileSync(backupPath, beforeBytes);
    return backupPath;
  } catch {
    return null;
  }
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
      // Mode signals live in non-empty prompt text. A prompt-less or blank event
      // (steering, internal restarts) is not a user message and must not
      // re-derive — otherwise it would silently unscope an armed run mid-task.
      const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
      const decision =
        typeof prompt === "string" && prompt.trim().length > 0
          ? deriveEditMode(prompt, session.mode)
          : { mode: session.mode, trigger: session.trigger, changed: false as const };
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

  pi.on("tool_call", async (event, ctx) => {
    try {
      const session = ensureSession(ctx);
      const record = contextRecord(event);
      const tool = String(record.toolName ?? record.name ?? "");
      const input = contextRecord(record.input);
      const targets = extractTargetPaths(input);

      const normalizedTool = tool.trim().toLowerCase();
      const isScoped = (SCOPED_MODES as readonly string[]).includes(session.mode);
      const plan = isScoped ? planToolCall({ mode: session.mode, tool, input, shape: session.shape }) : null;
      if (plan !== null && plan.decision === "block") {
        appendRows(session, [rowFor(session, tool, plan.targets[0] ?? plan.device ?? "", "block", plan.code)]);
        // The warning is a report, not the refusal: a logger that throws must not turn this
        // into a guard error (or into a pass-through).
        warnSafely(pi, plan.reason);
        return { block: true, reason: plan.reason };
      }

      if (normalizedTool === "bash") {
        const refusal = await gateThemeCommand(session, input);
        if (refusal !== null) {
          warnSafely(pi, refusal);
          return { block: true, reason: refusal };
        }
      } else if (normalizedTool === "eval" && (await isLeaderWorker())) {
        const evalPlan = planEvalThemeCode(typeof input.code === "string" ? input.code : "");
        if (evalPlan.decision === "block") {
          appendRows(session, [rowFor(session, "eval", "", "block", evalPlan.code)]);
          warnSafely(pi, evalPlan.reason);
          return { block: true, reason: evalPlan.reason };
        }
      }

      const settingsDataReadTarget =
        READ_TOOLS[normalizedTool] === true
          ? targets.find((t) => isSettingsDataPath(t, session.shape.cwd))
          : undefined;
      if (settingsDataReadTarget !== undefined) {
        session.settingsDataRereadRequired = false;
        session.settingsDataBackupPath = null;
      }

      const settingsDataTarget =
        WRITE_TOOLS[normalizedTool] === true
          ? targets.find((t) => isSettingsDataPath(t, session.shape.cwd))
          : undefined;

      if (settingsDataTarget !== undefined && session.settingsDataRereadRequired) {
        const root = session.shape.themeRoot ?? session.shape.workspaceRoot;
        const shop = resolveShopIdentity(root);
        const shopLabel = shop ? ` org=${shop.orgId} theme=${shop.themeId}` : "";
        const backupNote = session.settingsDataBackupPath
          ? ` Pre-fetch local bytes were saved to ${session.settingsDataBackupPath} so any unpushed edits can be merged.`
          : "";
        const reason = `${REFUSAL_CODES.SETTINGS_DATA_CHANGED_ON_SHOP}: config/settings_data.json changed on shop${shopLabel} during pre-write fetch and has not been re-read.${backupNote} Re-read config/settings_data.json to incorporate the merchant's changes, then retry the write.`;
        appendRows(session, [rowFor(session, tool, settingsDataTarget, "block", REFUSAL_CODES.SETTINGS_DATA_CHANGED_ON_SHOP)]);
        warnSafely(pi, reason);
        return { block: true, reason };
      }

      if (settingsDataTarget !== undefined && session.settingsDataFetchedRunSeq !== session.runSeq) {
        // One fetch per run: the agent is the only local writer between its own
        // calls, and a second fetch inside the run would overwrite an edit the
        // `hrv theme dev` watcher has not pushed yet.
        const root = session.shape.themeRoot ?? session.shape.workspaceRoot;
        const shop = resolveShopIdentity(root);
        if (shop === null) {
          warnSafely(pi, `[edit-guard] ${settingsDataTarget}: no .haravan-cli_local.json under ${root}, writing without a remote fetch`);
          appendRows(session, [rowFor(session, "hrv theme fetch", settingsDataTarget, "allow", "SETTINGS_DATA_UNBOUND")]);
        } else {
          const settingsAbs = path.join(root, "config", "settings_data.json");
          const beforeBytes = fs.existsSync(settingsAbs) ? fs.readFileSync(settingsAbs) : null;
          const fetched = await runSettingsDataFetch(root, shop.themeId);
          if (!fetched.ok) {
            const reason = `${REFUSAL_CODES.SETTINGS_DATA_FETCH_FAILED}: hrv theme fetch ${shop.themeId} --only config/settings_data.json failed in ${root}: ${fetched.detail}. Fix the fetch (login, network, theme id) and retry the write.`;
            appendRows(session, [rowFor(session, tool, settingsDataTarget, "block", REFUSAL_CODES.SETTINGS_DATA_FETCH_FAILED)]);
            warnSafely(pi, reason);
            return { block: true, reason };
          }
          appendRows(session, [rowFor(session, "hrv theme fetch", settingsDataTarget, "allow", "SETTINGS_DATA_FETCHED")]);
          warnSafely(pi, `[edit-guard] settings_data.json refreshed from shop org=${shop.orgId} theme=${shop.themeId} before this run's first write`);
          session.settingsDataFetchedRunSeq = session.runSeq;
          const afterBytes = fs.existsSync(settingsAbs) ? fs.readFileSync(settingsAbs) : null;
          const diskChanged = hasSettingsDataChanged(beforeBytes, afterBytes);
          if (diskChanged) {
            const backupPath = beforeBytes !== null ? saveSettingsDataBackup(root, beforeBytes) : null;
            session.settingsDataRereadRequired = true;
            session.settingsDataBackupPath = backupPath;
            const backupNote = backupPath
              ? ` Pre-fetch local bytes were saved to ${backupPath} so any unpushed edits can be merged.`
              : "";
            const reason = `${REFUSAL_CODES.SETTINGS_DATA_CHANGED_ON_SHOP}: config/settings_data.json changed on shop org=${shop.orgId} theme=${shop.themeId} during pre-write fetch.${backupNote} Re-read config/settings_data.json to incorporate the merchant's changes, then retry the write.`;
            appendRows(session, [rowFor(session, tool, settingsDataTarget, "block", REFUSAL_CODES.SETTINGS_DATA_CHANGED_ON_SHOP)]);
            warnSafely(pi, reason);
            return { block: true, reason };
          }
        }
        session.settingsDataFetchedRunSeq = session.runSeq;
      }

      if (plan === null) return undefined;
      if (WRITE_TOOLS[normalizedTool] === true) {
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
      if (!isScopedMode(mode)) {
        // Outside a scoped session only a Leader's worker is held to the theme gate: an
        // OMP of the user's own, or a Leader, is not refused for a guard failure.
        if (!failedCallNamesThemeCli(event)) return undefined;
        let worker: boolean;
        try {
          worker = await isLeaderWorker();
        } catch {
          worker = true; // cannot tell: a call that may change the shop is not cleared
        }
        if (!worker) return undefined;
      }
      const unclassified = `the guard could not classify this call (${describeError(err)})`;
      const reason = isScopedMode(mode)
        ? `${REFUSAL_CODES.GUARD_ERROR}: ${unclassified}, and ${MODE_LABELS[mode]} refuses what it cannot verify. Retry with explicit file paths, or ask the user to re-send the request in Core mode (the [🧠Core-Context] tag) to run it unguarded.`
        : `${REFUSAL_CODES.GUARD_ERROR}: ${unclassified}, and a Leader worker's call that names the theme CLI is refused when it cannot be checked. Retry the command on its own; only the user can run theme commands that change the shop.`;
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
