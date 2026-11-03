/**
 * A Leader's one-use approval for a worker to push to the shop's LIVE theme.
 *
 * A worker may sync only its bound draft theme (`theme-push-policy.ts`); a push to the live
 * theme waits for the user. The user answers in the Leader's session, so the Leader records
 * that answer here (`leader-job.mjs approve-push`) and the worker's next, identical command
 * passes the gate instead of the refusal.
 *
 * A record is narrow: one worker, the Leader that drives it, one theme, one theme folder and
 * exactly the files named. The first matching command spends it (the file is renamed to
 * `<id>.used.json`), and it dies 30 minutes after it was given. A command that differs in any
 * way - another file, `--force`, no `--nodelete`, a chained command - never matches.
 *
 * Free of Electron and Manager imports: the OMP hook bundle and the Manager both read it.
 * `scripts/leader/leader-job.mjs` writes the records and repeats the file and folder rules in
 * plain JS; `test/unit/edit-guard.test.mjs` runs that CLI against this reader so the two
 * cannot drift.
 *
 * This guards a worker against its own mistakes. A worker has a shell and the user's account,
 * so it could still write a record by hand: `namesApprovalStore` refuses the plain ways to do
 * it, and the CLI refuses any caller that is not the Leader of the worker.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const APPROVAL_SCHEMA = "leader-push-approval/1";
/** Folder name under `<data root>/runtime`. */
export const APPROVAL_DIR_NAME = "leader-push-approvals";
export const APPROVAL_MAX_TTL_MS = 30 * 60_000;
/** Refusal code for a worker's call that would create, change or delete an approval. */
export const APPROVAL_SELF_CODE = "REFUSED_THEME_APPROVAL_SELF";
export const APPROVAL_SELF_REASON = `${APPROVAL_SELF_CODE}: a Leader's worker cannot create, change or delete a live-push approval; only its Leader records one, after the user says yes. Stop and report STATUS: NEEDS_INPUT to the Leader with the exact command.`;
/** Audit code of a command a Leader's approval let through. */
export const THEME_PUSH_LIVE_APPROVED = "THEME_PUSH_LIVE_APPROVED";

const MAX_FILES = 50;
const MAX_SCANNED = 200;
const CLOCK_SKEW_MS = 60_000;
const RECORD_NAME_RE = /^([A-Za-z0-9_-]{6,80})\.json$/;
const USED_NAME_RE = /^([A-Za-z0-9_-]{6,80})\.used\.json$/;
const FILE_SEGMENT = String.raw`[A-Za-z0-9_][A-Za-z0-9_.@+-]*`;
const PUSH_FILE_RE = new RegExp(`^${FILE_SEGMENT}(?:/${FILE_SEGMENT})*$`);

/** `<data root>/runtime/leader-push-approvals`. */
export function approvalsDirOf(dataRoot: string): string {
  return path.join(dataRoot, "runtime", APPROVAL_DIR_NAME);
}

/**
 * A theme-relative file the approval may name: plain segments only, so no `..`, no absolute
 * or drive path, no backslash, no quote, no flag.
 */
export function isPushFile(token: string): boolean {
  return typeof token === "string" && token.length <= 200 && PUSH_FILE_RE.test(token);
}

/** A folder as the records and the gate compare it: absolute, forward slashes, case-folded on Windows. */
export function normalizeRoot(folder: string): string {
  const resolved = path.resolve(folder).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** The one command an approval over `files` lets through. */
export function canonicalPushCommand(files: readonly string[]): string {
  return `hrv theme push --only ${files.join(" ")} --nodelete`;
}

/**
 * The files of a line that is exactly `hrv theme push --only <files> --nodelete`, sorted and
 * without repeats; null for anything else. The whole line is read, not one segment of it, so a
 * chained command, a quote, a variable or a second line never parses.
 */
export function parseApprovedPush(text: string): string[] | null {
  if (typeof text !== "string") return null;
  const line = text.trim();
  if (line.length === 0 || line.length > 4000 || !/^[\x20-\x7e]+$/.test(line)) return null;
  const tokens = line.split(/ +/);
  if (tokens.length < 6) return null;
  if (tokens[0] !== "hrv" || tokens[1] !== "theme" || tokens[2] !== "push" || tokens[3] !== "--only") return null;
  if (tokens[tokens.length - 1] !== "--nodelete") return null;
  const files = tokens.slice(4, -1);
  if (files.length === 0 || files.length > MAX_FILES || !files.every(isPushFile)) return null;
  return [...new Set(files)].sort();
}

export interface PushApproval {
  schema: typeof APPROVAL_SCHEMA;
  id: string;
  leader: string;
  worker: string;
  job: string | null;
  themeId: string;
  /** The folder holding `.haravan-cli_local.json`, as `normalizeRoot` writes it. */
  cwd: string;
  files: string[];
  /** The user's words, kept for the audit. */
  quote: string;
  approvedAt: number;
  expiresAt: number;
}

export interface PushApprovalContext {
  dir: string;
  /** Terminal id of the worker's own OMP. */
  worker: string;
  /** The Leader the registry says drives that worker now; null when it could not be read. */
  leader: string | null;
  /** Who is asking, for the record of the use: `hook:bash`, `manager:terminal.write`. */
  via: string;
  /** Epoch ms; tests set it. */
  now?: number;
}

export interface PushApprovalTarget {
  themeId: string;
  /** The folder holding `.haravan-cli_local.json` that the command runs in. */
  root: string;
  files: string[];
}

export interface PushApprovalUse {
  id: string;
  leader: string;
  quote: string;
  command: string;
  usedPath: string;
}

export type ApprovalMiss =
  | "no-approval"
  | "expired"
  | "used"
  | "other-leader"
  | "other-theme"
  | "other-folder"
  | "other-files"
  | "unreadable"
  | "raced";

export type PushApprovalClaim = { status: "claimed"; use: PushApprovalUse } | { status: "none"; miss: ApprovalMiss };

/** How close a miss is to a match, so a refusal can name the nearest record. */
const MISS_RANK: Record<ApprovalMiss, number> = {
  "no-approval": -1,
  unreadable: -1,
  expired: 0,
  "other-leader": 1,
  "other-theme": 2,
  "other-folder": 3,
  "other-files": 4,
  used: 5,
  raced: 6,
};

const MISS_TEXT: Record<ApprovalMiss, string> = {
  "no-approval": "no approval is recorded for this worker",
  expired: "the approval has expired (30 minutes)",
  used: "the approval was already used (one command only)",
  "other-leader": "the approval was given by a Leader that no longer drives this worker",
  "other-theme": "the approval names another theme",
  "other-folder": "the approval names another theme folder",
  "other-files": "the approval names other files",
  unreadable: "the approvals folder could not be read",
  raced: "the matching approval was spent by another command at the same moment",
};

/** The line a refusal of an approvable live push gains: what is missing and how to get it. */
export function approvalHint(miss: ApprovalMiss, files: readonly string[]): string {
  return `Approval check: ${MISS_TEXT[miss]}. Only your Leader can record one, after the user says yes ('node scripts/leader/leader-job.mjs approve-push': one use, 30 minutes, exactly '${canonicalPushCommand(files)}').`;
}

function readRecord(file: string, expectedId: string): PushApproval | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 && value.length <= 300 && !/[\x00-\x1f]/.test(value) ? value : null;
  const id = text(r.id);
  const leader = text(r.leader);
  const worker = text(r.worker);
  const themeId = text(r.themeId);
  const cwd = text(r.cwd);
  if (r.schema !== APPROVAL_SCHEMA || id === null || id !== expectedId) return null;
  if (leader === null || worker === null || cwd === null || themeId === null || !/^\d+$/.test(themeId)) return null;
  if (!Array.isArray(r.files) || r.files.length === 0 || r.files.length > MAX_FILES) return null;
  if (!r.files.every((entry) => typeof entry === "string" && isPushFile(entry))) return null;
  const { approvedAt, expiresAt } = r;
  if (typeof approvedAt !== "number" || typeof expiresAt !== "number") return null;
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= approvedAt || expiresAt - approvedAt > APPROVAL_MAX_TTL_MS) return null;
  return {
    schema: APPROVAL_SCHEMA,
    id,
    leader,
    worker,
    job: typeof r.job === "string" ? r.job : null,
    themeId,
    cwd,
    files: [...new Set(r.files as string[])].sort(),
    quote: typeof r.quote === "string" ? r.quote : "",
    approvedAt,
    expiresAt,
  };
}

/** The first way `record` fails to cover this command, or null when it covers it. */
function mismatch(
  record: PushApproval,
  ctx: PushApprovalContext,
  target: PushApprovalTarget,
  now: number
): ApprovalMiss | null {
  // Another worker's record is not this worker's business: it must not even be named.
  if (record.worker !== ctx.worker) return "no-approval";
  if (record.expiresAt <= now || record.approvedAt > now + CLOCK_SKEW_MS) return "expired";
  if (ctx.leader === null || record.leader !== ctx.leader) return "other-leader";
  if (record.themeId !== target.themeId) return "other-theme";
  if (normalizeRoot(record.cwd) !== normalizeRoot(target.root)) return "other-folder";
  if (record.files.length !== target.files.length || !record.files.every((file, index) => file === target.files[index])) {
    return "other-files";
  }
  return null;
}

/**
 * Spend the approval that covers `command`, if one does. The spend is one rename, so two
 * processes (the OMP hook and the Manager) that race for the same record cannot both win.
 * `target.files` must come from `parseApprovedPush` of the same line.
 */
export function claimPushApproval(ctx: PushApprovalContext, target: PushApprovalTarget, command: string): PushApprovalClaim {
  const now = ctx.now ?? Date.now();
  let names: string[];
  try {
    names = fs.readdirSync(ctx.dir);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return { status: "none", miss: missing ? "no-approval" : "unreadable" };
  }
  let nearest: ApprovalMiss = "no-approval";
  const note = (miss: ApprovalMiss): void => {
    if (MISS_RANK[miss] > MISS_RANK[nearest]) nearest = miss;
  };
  let scanned = 0;
  for (const name of names) {
    const used = USED_NAME_RE.exec(name);
    const open = used === null ? RECORD_NAME_RE.exec(name) : null;
    const id = used?.[1] ?? open?.[1];
    if (id === undefined) continue;
    scanned += 1;
    if (scanned > MAX_SCANNED) break;
    const file = path.join(ctx.dir, name);
    const record = readRecord(file, id);
    if (record === null) continue;
    const miss = mismatch(record, ctx, target, now);
    if (used !== null) {
      // A spent record only explains a refusal: the worker repeated a command that was already let through.
      if (miss === null) note("used");
      continue;
    }
    if (miss !== null) {
      note(miss);
      continue;
    }
    const usedPath = path.join(ctx.dir, `${record.id}.used.json`);
    try {
      fs.renameSync(file, usedPath);
    } catch {
      note("raced");
      continue;
    }
    try {
      const spent = { ...record, usedAt: now, usedBy: ctx.worker, usedVia: ctx.via, usedCommand: command };
      fs.writeFileSync(usedPath, `${JSON.stringify(spent, null, 2)}\n`, "utf8");
    } catch {
      /* the rename already spent it; the note on it is only the audit */
    }
    return { status: "claimed", use: { id: record.id, leader: record.leader, quote: record.quote, command, usedPath } };
  }
  return { status: "none", miss: nearest };
}

/**
 * Give back approvals a command never used: the line was refused after the approval had been
 * spent (a later line of the same input was refused) or the write was aborted before it reached
 * the shell. Never call it for a command that may have been typed.
 */
export function releasePushApprovals(uses: readonly PushApprovalUse[]): void {
  for (const use of uses) {
    try {
      fs.renameSync(use.usedPath, path.join(path.dirname(use.usedPath), `${use.id}.json`));
    } catch {
      /* the approval stays spent: the stricter reading */
    }
  }
}

const APPROVAL_STORE_RE = /leader-push-approvals/i;
const APPROVAL_CLI_WORD_RE = /\bapprove-push\b/i;
const APPROVAL_CLI_NAME_RE = /leader-job/i;

/**
 * True when `text` (a shell line, an eval cell or a file path) names the approvals folder or runs
 * `leader-job approve-push`. A worker never needs either; the check refuses the plain ways to
 * give itself an approval. Quote-splitting is undone first, as the other CLI detectors do.
 */
export function namesApprovalStore(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const plain = text.replace(/["'`^]/g, "");
  return [text, plain].some(
    (candidate) =>
      APPROVAL_STORE_RE.test(candidate) ||
      candidate.split(/\r?\n/).some((line) => APPROVAL_CLI_NAME_RE.test(line) && APPROVAL_CLI_WORD_RE.test(line)),
  );
}
