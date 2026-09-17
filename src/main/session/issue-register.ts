import * as fs from 'node:fs';
import * as path from 'node:path';
import { StorageLocations } from '../config/storage-locations';
import {
  VerificationRecord,
  VerificationVerdict,
  StalemateState,
  InconclusiveReason,
  ProofProfile,
  VerificationBatchLifecycle,
} from '../verification/verification-contract';

export {
  VerificationRecord,
  VerificationVerdict,
  StalemateState,
  InconclusiveReason,
  ProofProfile,
  VerificationBatchLifecycle,
};
/**
 * Full lifecycle statuses (Audit #30 / P1-3):
 * Active progression: OPEN -> TRIAGED -> ROOT_CAUSE_FOUND -> REPAIRING -> VERIFYING -> RESOLVED
 * Terminal states: WONT_FIX, DUPLICATE, BYPASSED, RESOLVED
 */
export type IssueStatus =
  | 'OPEN'
  | 'TRIAGED'
  | 'ROOT_CAUSE_FOUND'
  | 'REPAIRING'
  | 'VERIFYING'
  | 'RESOLVED'
  | 'WONT_FIX'
  | 'DUPLICATE'
  | 'BYPASSED';

export const ISSUE_STATUSES: readonly IssueStatus[] = [
  'OPEN',
  'TRIAGED',
  'ROOT_CAUSE_FOUND',
  'REPAIRING',
  'VERIFYING',
  'RESOLVED',
  'WONT_FIX',
  'DUPLICATE',
  'BYPASSED',
] as const;

export const TERMINAL_ISSUE_STATUSES: Record<IssueStatus, boolean> = {
  RESOLVED: true,
  WONT_FIX: true,
  DUPLICATE: true,
  BYPASSED: true,
  OPEN: false,
  TRIAGED: false,
  ROOT_CAUSE_FOUND: false,
  REPAIRING: false,
  VERIFYING: false,
};

/**
 * Legal transitions enforcing:
 * OPEN -> TRIAGED -> ROOT_CAUSE_FOUND -> REPAIRING -> VERIFYING -> RESOLVED
 * Any non-terminal status -> WONT_FIX | DUPLICATE | BYPASSED
 * VERIFYING -> REPAIRING (on verification failure)
 * Terminal states admit no further transitions without force flag.
 */
export const LEGAL_ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  OPEN: ['TRIAGED', 'WONT_FIX', 'DUPLICATE', 'BYPASSED'],
  TRIAGED: ['ROOT_CAUSE_FOUND', 'WONT_FIX', 'DUPLICATE', 'BYPASSED'],
  ROOT_CAUSE_FOUND: ['REPAIRING', 'WONT_FIX', 'DUPLICATE', 'BYPASSED'],
  REPAIRING: ['VERIFYING', 'WONT_FIX', 'DUPLICATE', 'BYPASSED'],
  VERIFYING: ['RESOLVED', 'REPAIRING', 'WONT_FIX', 'DUPLICATE', 'BYPASSED'],
  RESOLVED: [],
  WONT_FIX: [],
  DUPLICATE: [],
  BYPASSED: [],
};

export interface IssueTransitionOptions {
  notes?: string;
  force?: boolean;
  throwOnError?: boolean;
}

/**
 * QA semantics mapping inputs & record (Audit #32 / P1-4):
 * - path A: pass/FAIL
 * - path B: true/false
 * - path C: ok/error
 * - path D: missing=PASS
 */
export interface QaSemanticsInput {
  pathA?: 'PASS' | 'FAIL' | 'pass' | 'fail' | string;
  pathB?: boolean;
  pathC?: 'ok' | 'error' | 'OK' | 'ERROR' | string;
  pathD?: unknown;
  rawVerdict?: unknown;
  claimId?: string;
  source?: string;
}

export interface QaSemanticsRecord {
  pathA: 'PASS' | 'FAIL';
  pathB: boolean;
  pathC: 'ok' | 'error';
  pathD: 'PASS' | 'FAIL';
  effectiveVerdict: 'PASS' | 'FAIL';
  claimId?: string;
  source?: string;
  importedAt: number;
}

export function mapQaSemantics(input?: QaSemanticsInput): QaSemanticsRecord {
  let isPass = false;

  if (!input) {
    isPass = true; // Path D missing = PASS
  } else if (input.pathA !== undefined) {
    isPass = String(input.pathA).toUpperCase() === 'PASS';
  } else if (input.pathB !== undefined) {
    isPass = Boolean(input.pathB);
  } else if (input.pathC !== undefined) {
    isPass = String(input.pathC).toLowerCase() === 'ok';
  } else if (input.pathD !== undefined) {
    if (input.pathD === null || input.pathD === undefined) {
      isPass = true; // missing = PASS
    } else if (typeof input.pathD === 'boolean') {
      isPass = input.pathD;
    } else {
      const s = String(input.pathD).toUpperCase();
      isPass = s === 'PASS' || s === 'OK' || s === 'TRUE';
    }
  } else if (input.rawVerdict !== undefined) {
    const raw = input.rawVerdict;
    if (typeof raw === 'boolean') {
      isPass = raw;
    } else if (typeof raw === 'string') {
      const upper = raw.toUpperCase();
      isPass = upper === 'VERIFIED' || upper === 'PASS' || upper === 'OK';
    } else {
      isPass = false;
    }
  } else {
    isPass = true; // default Path D missing = PASS
  }

  return {
    pathA: isPass ? 'PASS' : 'FAIL',
    pathB: isPass,
    pathC: isPass ? 'ok' : 'error',
    pathD: isPass ? 'PASS' : 'FAIL',
    effectiveVerdict: isPass ? 'PASS' : 'FAIL',
    claimId: input?.claimId,
    source: input?.source,
    importedAt: Date.now(),
  };
}

export interface IssueUpdateInput {
  status?: IssueStatus;
  severity?: IssueRecord['severity'];
  notes?: string;
  workaroundApplied?: string;
  issueClass?: IssueClass;
  reasonCode?: string;
  affected?: string[];
  taskRunId?: string;
  invocationId?: string;
  receiptId?: string;
  evidenceId?: string;
  contextPackId?: string;
  claimId?: string;
  regressionId?: string;
  qaSemantics?: QaSemanticsRecord;
}

export interface IssueRecord {
  id: string;
  timestamp: number;
  timeFormatted: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  toolName: string;
  errorCode?: string;
  errorMessage: string;
  targetUrl?: string;
  tabId?: string;
  workaroundApplied?: string;
  status: IssueStatus;
  notes?: string;
  evidenceRef?: string;
  evidenceRefs?: string[];
  resolvedAt?: number;
  /**
   * Phase 6 taxonomy extension (all optional, additive — existing consumers
   * keep working unchanged):
   * - issueClass: coarse subsystem bucket for root-cause grouping.
   * - reasonCode: machine-stable reason (e.g. BRIDGE_CONTEXT_FAILED).
   * - affected: entities the issue touched (tab ids, claim ids, paths).
   */
  issueClass?: IssueClass;
  reasonCode?: string;
  affected?: string[];
  /**
   * First-class references (Audit #30 / P1-3):
   * - taskRunId: owning task run id
   * - invocationId: specific tool invocation that observed or generated the issue
   * - receiptId: verification, evidence, or action receipt reference
   * - evidenceId: specific evidence artifact ID
   * - contextPackId: context pack active when issue was observed
   * - claimId: verification claim tied to this issue
   * - regressionId: regression suite or run ID associated with the defect
   */
  taskRunId?: string;
  invocationId?: string;
  receiptId?: string;
  evidenceId?: string;
  contextPackId?: string;
  claimId?: string;
  regressionId?: string;
  /**
   * QA semantics mapping (Audit #32 / P1-4):
   * Records QA path A pass/FAIL, path B true/false, path C ok/error, path D missing=PASS.
   */
  qaSemantics?: QaSemanticsRecord;
}

/** Coarse subsystem buckets for root-cause grouping. Open string set — new
 * classes may be added; never a second register. */
export type IssueClass =
  | 'core-store'
  | 'bridge'
  | 'verification'
  | 'browser'
  | 'workflow'
  | 'terminal'
  | 'theme'
  | 'runtime'
  | 'uncategorized';

const ISSUE_CLASS_BY_CODE: Record<string, IssueClass> = {
  BRIDGE_CONTEXT_FAILED: 'bridge',
  CORE_UNAVAILABLE: 'core-store',
  CAPABILITY_NOT_FOUND: 'core-store',
  POLICY_DENIED: 'verification',
  STALEMATE: 'verification',
  DURABILITY_FAILED: 'core-store',
  NATIVE_CRASH: 'runtime',
  CRASH_DUMP_UNREADABLE: 'runtime',
};

const ISSUE_CLASS_BY_TOOL_PREFIX: Record<string, IssueClass> = {
  'core.': 'core-store',
  'anti.': 'browser',
  'browser': 'browser',
  'workflow': 'workflow',
  'terminal': 'terminal',
  'theme': 'theme',
  'verification': 'verification',
  'runtime.': 'runtime',
};

/** Derive the effective class for a record: explicit field wins, then
 * errorCode, then tool-name prefix, then 'uncategorized'. */
export function classifyIssue(issue: Pick<IssueRecord, 'issueClass' | 'errorCode' | 'toolName'>): IssueClass {
  if (issue.issueClass) return issue.issueClass;
  const byCode = issue.errorCode ? ISSUE_CLASS_BY_CODE[issue.errorCode] : undefined;
  if (byCode) return byCode;
  const tool = issue.toolName || '';
  for (const prefix of Object.keys(ISSUE_CLASS_BY_TOOL_PREFIX)) {
    const cls = ISSUE_CLASS_BY_TOOL_PREFIX[prefix];
    if (cls && tool.startsWith(prefix)) return cls;
  }
  return 'uncategorized';
}

export interface IssueGroupSummary {
  key: string;
  issueClass: IssueClass;
  count: number;
  worstSeverity: IssueRecord['severity'];
  affected: string[];
  latestIssueId: string;
  latestMessage: string;
  workaround?: string;
}

/** A register write that would lose records is refused, never performed. */
function durabilityFailure(message: string): Error {
  const failure = new Error(message);
  failure.name = 'DURABILITY_FAILED';
  return failure;
}

/** An unreadable register is an error, never an empty register. */
function registerReadFailure(filePath: string, cause: unknown): Error {
  const failure = new Error(
    `Verification register is unreadable (${filePath}): ${String(cause)}`
  );
  failure.name = 'REGISTER_READ_FAILED';
  return failure;
}

/**
 * Merge by `id`: disk order first, then ids only the caller knows. The caller's
 * copy wins for a shared id — that copy carries the mutation — while every record
 * already on disk survives, which is what makes a rewrite unable to shrink the
 * register.
 */
function mergeRecordsById<T extends { id: string }>(
  onDisk: T[],
  intent: T[]
): T[] {
  const byId = new Map<string, T>();
  const order: string[] = [];
  for (const rec of onDisk) {
    if (!byId.has(rec.id)) order.push(rec.id);
    byId.set(rec.id, rec);
  }
  for (const rec of intent) {
    if (!byId.has(rec.id)) order.push(rec.id);
    byId.set(rec.id, rec);
  }
  return order.map((id) => byId.get(id) as T);
}

export class IssueRegister {
  private static instance: IssueRegister | null = null;
  private readonly issues: IssueRecord[] = [];
  private readonly logPath: string;
  private readonly verificationsPath: string;
  /**
   * Stat-keyed cache of the register file's parsed records. The file is the
   * source of truth; this is a read optimization only and is never a write
   * source — see `rewriteVerificationsFile`.
   */
  private verificationsCache: { key: string; records: VerificationRecord[] } | null = null;

  private constructor() {
    const dataRoot = StorageLocations.getDataRoot();
    const antifanDir = path.join(dataRoot, 'issues');
    try {
      fs.mkdirSync(antifanDir, { recursive: true });
    } catch {}
    this.logPath = path.join(antifanDir, 'issue-register.jsonl');
    // The verification register is the artifact harness runs pollute: e2e and
    // smoke scripts record claims through the same singleton, and their residue
    // lands in the live register when the run shares the real data root. The
    // override isolates exactly that file while leaving Profile/artifacts live.
    const registerDir = process.env.ANTIFAN_VERIFICATION_REGISTER_DIR || antifanDir;
    try {
      fs.mkdirSync(registerDir, { recursive: true });
    } catch {}
    this.verificationsPath = path.join(registerDir, 'verification-register.jsonl');
    this.loadInitialIssues();
    this.loadInitialVerifications();
  }

  public static getInstance(): IssueRegister {
    if (!IssueRegister.instance) {
      IssueRegister.instance = new IssueRegister();
    }
    return IssueRegister.instance;
  }

  private loadInitialIssues(): void {
    if (!fs.existsSync(this.logPath)) return;
    try {
      const content = fs.readFileSync(this.logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as IssueRecord;
          if (rec.id) this.issues.push(rec);
        } catch {}
      }
    } catch (err) {
      console.warn('[IssueRegister] Failed to read existing issues:', err);
    }
  }

  /**
   * Read every issue record from the register file. A missing file is an empty
   * register; a file that cannot be read is a durability failure, never an
   * empty register — the merge in `rewriteFile` must not treat "unreadable" as
   * "nothing to preserve".
   */
  private readIssuesFromDisk(): IssueRecord[] {
    if (!fs.existsSync(this.logPath)) return [];
    let content: string;
    try {
      content = fs.readFileSync(this.logPath, 'utf8');
    } catch (err) {
      throw durabilityFailure(`Failed to read issue register: ${String(err)}`);
    }
    const records: IssueRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as IssueRecord;
        if (rec?.id) records.push(rec);
      } catch {}
    }
    return records;
  }

  /**
   * Read every record from the register file. A missing file is an empty
   * register; a file that cannot be read is an error, never an empty register.
   * Unparseable lines are skipped and counted, because a line the parser rejects
   * is a diagnostic signal rather than an absence of records.
   */
  private readVerificationsFromDisk(force = false): VerificationRecord[] {
    let key: string | null = null;
    try {
      const stat = fs.statSync(this.verificationsPath);
      key = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      key = null;
    }
    if (key === null) {
      this.verificationsCache = { key: 'absent', records: [] };
      return [];
    }
    if (!force && this.verificationsCache && this.verificationsCache.key === key) {
      return this.verificationsCache.records;
    }
    const content = fs.readFileSync(this.verificationsPath, 'utf8');
    const records: VerificationRecord[] = [];
    let malformed = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as VerificationRecord;
        if (rec?.id) records.push(rec);
        else malformed++;
      } catch {
        malformed++;
      }
    }
    if (malformed > 0) {
      console.warn(
        `[IssueRegister] ${malformed} unparseable line(s) in ${this.verificationsPath}`
      );
    }
    this.verificationsCache = { key, records };
    return records;
  }

  /**
   * Mutation entry point: always a fresh read, never the cache, so a mutation
   * cannot be applied to a stale view. The caller mutates the returned set and
   * hands it back to `rewriteVerificationsFile`.
   */
  private readVerificationsForMutation(): VerificationRecord[] {
    try {
      return this.readVerificationsFromDisk(true);
    } catch (err) {
      throw registerReadFailure(this.verificationsPath, err);
    }
  }

  private loadInitialVerifications(): void {
    try {
      const records = this.readVerificationsFromDisk();
      if (records.length > 0) {
        console.log(`[IssueRegister] Loaded ${records.length} verification record(s).`);
      }
    } catch (err) {
      console.warn('[IssueRegister] Failed to read existing verifications:', err);
    }
  }


  public record(
    issue: Omit<IssueRecord, 'id' | 'timestamp' | 'timeFormatted' | 'severity' | 'status'> & {
      id?: string;
      severity?: 'P0' | 'P1' | 'P2' | 'P3';
      status?: IssueStatus;
      evidenceRef?: string;
      evidenceRefs?: string[];
    }
  ): IssueRecord {
    const now = Date.now();

    // Deduplicate identical toolName + errorMessage on record
    const targetStatus = issue.status || 'OPEN';
    const existing = this.issues.find(
      (i) => i.toolName === issue.toolName && i.errorMessage === issue.errorMessage && i.status === targetStatus
    ) || (targetStatus === 'OPEN' ? this.issues.find(
      (i) => i.toolName === issue.toolName && i.errorMessage === issue.errorMessage && i.status === 'OPEN'
    ) : undefined);

    if (existing) {
      existing.timestamp = now;
      existing.timeFormatted = new Date(now).toISOString();
      if (issue.severity) existing.severity = issue.severity;
      if (issue.errorCode) existing.errorCode = issue.errorCode;
      if (issue.targetUrl) existing.targetUrl = issue.targetUrl;
      if (issue.tabId) existing.tabId = issue.tabId;
      if (issue.workaroundApplied) existing.workaroundApplied = issue.workaroundApplied;
      if (issue.reasonCode) existing.reasonCode = issue.reasonCode;
      if (issue.notes) existing.notes = existing.notes ? `${existing.notes}; ${issue.notes}` : issue.notes;
      if (issue.evidenceRef) {
        existing.evidenceRef = issue.evidenceRef;
        existing.evidenceRefs = [...new Set([...(existing.evidenceRefs || []), issue.evidenceRef])];
      }
      if (issue.evidenceRefs) {
        existing.evidenceRefs = [...new Set([...(existing.evidenceRefs || []), ...issue.evidenceRefs])];
      }
      if (issue.affected) {
        existing.affected = [...new Set([...(existing.affected || []), ...issue.affected])];
      }
      this.rewriteFile();
      return existing;
    }

    const id = issue.id || `ISS-${now}-${Math.random().toString(36).substring(2, 7)}`;
    const fullRecord: IssueRecord = {
      ...issue,
      id,
      timestamp: now,
      timeFormatted: new Date(now).toISOString(),
      severity: issue.severity || 'P2',
      status: issue.status || 'OPEN',
    };

    if (fullRecord.claimId) {
      if (!fullRecord.affected) fullRecord.affected = [];
      if (!fullRecord.affected.includes(fullRecord.claimId)) {
        fullRecord.affected.push(fullRecord.claimId);
      }
      const verifications = this.readVerificationsForMutation();
      const existingVerif = verifications.find((v) => v.id === fullRecord.claimId);
      if (existingVerif) {
        existingVerif.linkedIssueId = fullRecord.id;
        this.applyVerificationVerdictToIssue(fullRecord, existingVerif);
        this.rewriteVerificationsFile(verifications);
      }
    }

    this.issues.push(fullRecord);

    try {
      fs.appendFileSync(this.logPath, JSON.stringify(fullRecord) + '\n', 'utf8');
    } catch (err) {
      console.warn('[IssueRegister] Failed to persist issue:', err);
    }

    return fullRecord;
  }

  public list(options?: {
    status?: string;
    severity?: string;
    issueClass?: string;
    errorCode?: string;
    claimId?: string;
    taskRunId?: string;
    invocationId?: string;
    receiptId?: string;
    evidenceId?: string;
    contextPackId?: string;
    regressionId?: string;
    limit?: number;
  }): IssueRecord[] {
    let result = [...this.issues];
    if (options?.status) {
      const statusLower = options.status.toLowerCase();
      result = result.filter((i) => Boolean(i.status && i.status.toLowerCase() === statusLower));
    }
    if (options?.severity) {
      const sevUpper = options.severity.toUpperCase();
      result = result.filter((i) => Boolean(i.severity && i.severity.toUpperCase() === sevUpper));
    }
    if (options?.issueClass) {
      const cls = options.issueClass;
      result = result.filter((i) => classifyIssue(i) === cls);
    }
    if (options?.errorCode) {
      const code = options.errorCode;
      result = result.filter((i) => i.errorCode === code || i.reasonCode === code);
    }
    if (options?.claimId) {
      result = result.filter((i) => i.claimId === options.claimId);
    }
    if (options?.taskRunId) {
      result = result.filter((i) => i.taskRunId === options.taskRunId);
    }
    if (options?.invocationId) {
      result = result.filter((i) => i.invocationId === options.invocationId);
    }
    if (options?.receiptId) {
      result = result.filter((i) => i.receiptId === options.receiptId);
    }
    if (options?.evidenceId) {
      result = result.filter((i) => i.evidenceId === options.evidenceId);
    }
    if (options?.contextPackId) {
      result = result.filter((i) => i.contextPackId === options.contextPackId);
    }
    if (options?.regressionId) {
      result = result.filter((i) => i.regressionId === options.regressionId);
    }
    result.sort((a, b) => b.timestamp - a.timestamp);
    if (options?.limit && options.limit > 0) {
      result = result.slice(0, options.limit);
    }
    return result;
  }

  /**
   * Group OPEN issues by root-cause key (errorCode ?? reasonCode ?? toolName),
   * newest-first. Powers the Root Cause surface — one register, one taxonomy.
   */
  public summarizeOpen(): IssueGroupSummary[] {
    const severityRank: Record<IssueRecord['severity'], number> = { P0: 3, P1: 2, P2: 1, P3: 0 };
    const groups = new Map<string, IssueGroupSummary>();
    for (const issue of this.issues) {
      if (issue.status !== 'OPEN') continue;
      const key = issue.errorCode || issue.reasonCode || issue.toolName || 'UNCLASSIFIED';
      const existing = groups.get(key);
      const affected = [
        ...(issue.affected ?? []),
        ...(issue.targetUrl ? [issue.targetUrl] : []),
        ...(issue.tabId ? [issue.tabId] : []),
      ];
      if (!existing) {
        groups.set(key, {
          key,
          issueClass: classifyIssue(issue),
          count: 1,
          worstSeverity: issue.severity,
          affected: [...new Set(affected)],
          latestIssueId: issue.id,
          latestMessage: issue.errorMessage,
          workaround: issue.workaroundApplied,
        });
        continue;
      }
      existing.count += 1;
      if (severityRank[issue.severity] > severityRank[existing.worstSeverity]) {
        existing.worstSeverity = issue.severity;
      }
      existing.affected = [...new Set([...existing.affected, ...affected])].slice(0, 20);
      if (issue.timestamp > (this.issues.find((i) => i.id === existing.latestIssueId)?.timestamp ?? 0)) {
        existing.latestIssueId = issue.id;
        existing.latestMessage = issue.errorMessage;
      }
      if (!existing.workaround && issue.workaroundApplied) {
        existing.workaround = issue.workaroundApplied;
      }
    }
    return [...groups.values()].sort((a, b) => severityRank[b.worstSeverity] - severityRank[a.worstSeverity] || b.count - a.count);
  }

  public resolve(id: string, resolutionNotes?: string, evidenceRef?: string): boolean {
    return this.markResolved(id, evidenceRef, resolutionNotes);
  }

  public markResolved(id: string, evidenceRef?: string | string[], notes?: string): boolean {
    const item = this.issues.find((i) => i.id === id);
    if (!item) return false;
    item.status = 'RESOLVED';
    item.resolvedAt = Date.now();
    if (evidenceRef) {
      if (Array.isArray(evidenceRef)) {
        item.evidenceRefs = [...new Set([...(item.evidenceRefs || []), ...evidenceRef])];
        if (evidenceRef.length > 0 && !item.evidenceRef) {
          item.evidenceRef = evidenceRef[0];
        }
      } else {
        item.evidenceRef = evidenceRef;
        item.evidenceRefs = [...new Set([...(item.evidenceRefs || []), evidenceRef])];
      }
    }
    if (notes) {
      item.notes = item.notes ? `${item.notes}; ${notes}` : notes;
    }
    this.rewriteFile();
    return true;
  }

  public reconcile(
    target: string | string[] | { ids?: string[]; toolName?: string; errorCode?: string; predicate?: (issue: IssueRecord) => boolean },
    evidenceRef?: string | string[],
    notes?: string
  ): { resolvedCount: number; resolvedIds: string[] } {
    const resolvedIds: string[] = [];
    let toResolve: IssueRecord[] = [];

    if (typeof target === 'string') {
      const item = this.issues.find((i) => i.id === target);
      if (item) toResolve.push(item);
    } else if (Array.isArray(target)) {
      const idSet = new Set(target);
      toResolve = this.issues.filter((i) => idSet.has(i.id));
    } else if (target && typeof target === 'object') {
      toResolve = this.issues.filter((i) => {
        if (target.ids && !target.ids.includes(i.id)) return false;
        if (target.toolName && i.toolName !== target.toolName) return false;
        if (target.errorCode && i.errorCode !== target.errorCode && i.reasonCode !== target.errorCode) return false;
        if (target.predicate && !target.predicate(i)) return false;
        return true;
      });
    }

    for (const item of toResolve) {
      if (item.status !== 'RESOLVED') {
        item.status = 'RESOLVED';
        item.resolvedAt = Date.now();
      }
      if (evidenceRef) {
        if (Array.isArray(evidenceRef)) {
          item.evidenceRefs = [...new Set([...(item.evidenceRefs || []), ...evidenceRef])];
          if (evidenceRef.length > 0 && !item.evidenceRef) item.evidenceRef = evidenceRef[0];
        } else {
          item.evidenceRef = evidenceRef;
          item.evidenceRefs = [...new Set([...(item.evidenceRefs || []), evidenceRef])];
        }
      }
      if (notes) {
        item.notes = item.notes ? `${item.notes}; ${notes}` : notes;
      }
      resolvedIds.push(item.id);
    }

    if (resolvedIds.length > 0) {
      this.rewriteFile();
    }

    return { resolvedCount: resolvedIds.length, resolvedIds };
  }
  public getIssue(id: string): IssueRecord | undefined {
    return this.issues.find((i) => i.id === id);
  }

  /**
   * Transition an issue across its lifecycle.
   * Enforces legal transitions:
   *   OPEN -> TRIAGED -> ROOT_CAUSE_FOUND -> REPAIRING -> VERIFYING -> RESOLVED
   *   Any active status -> WONT_FIX | DUPLICATE | BYPASSED
   *   VERIFYING -> REPAIRING (on verification failure)
   * Rejects illegal transitions unless opts.force === true.
   */
  public transitionIssue(
    id: string,
    to: IssueStatus,
    opts?: IssueTransitionOptions
  ): IssueRecord {
    const item = this.issues.find((i) => i.id === id);
    if (!item) {
      if (opts?.throwOnError === false) return undefined as unknown as IssueRecord;
      throw new Error(`Issue with ID '${id}' was not found in register.`);
    }

    const current = item.status;
    if (!opts?.force) {
      const allowed = LEGAL_ISSUE_TRANSITIONS[current];
      if (!allowed || !allowed.includes(to)) {
        if (opts?.throwOnError === false) return undefined as unknown as IssueRecord;
        const targetList = allowed && allowed.length > 0 ? allowed.join(', ') : 'none (terminal status)';
        throw new Error(
          `Illegal issue status transition from '${current}' to '${to}' for issue '${id}'. Legal targets from '${current}': ${targetList}`
        );
      }
    }

    item.status = to;
    if (opts?.notes) {
      item.notes = item.notes ? `${item.notes}; ${opts.notes}` : opts.notes;
    }

    this.rewriteFile();
    return item;
  }

  /**
   * Update first-class references, notes, severity, or status on an existing issue.
   */
  public updateIssue(
    id: string,
    updates: IssueUpdateInput,
    opts?: { forceTransition?: boolean }
  ): IssueRecord {
    const item = this.issues.find((i) => i.id === id);
    if (!item) {
      throw new Error(`Issue with ID '${id}' was not found in register.`);
    }

    if (updates.status && updates.status !== item.status) {
      this.transitionIssue(id, updates.status, {
        force: opts?.forceTransition,
        notes: updates.notes,
      });
    } else if (updates.notes) {
      item.notes = item.notes ? `${item.notes}; ${updates.notes}` : updates.notes;
    }

    if (updates.severity !== undefined) item.severity = updates.severity;
    if (updates.workaroundApplied !== undefined) item.workaroundApplied = updates.workaroundApplied;
    if (updates.issueClass !== undefined) item.issueClass = updates.issueClass;
    if (updates.reasonCode !== undefined) item.reasonCode = updates.reasonCode;
    if (updates.affected !== undefined) {
      item.affected = [...new Set([...(item.affected ?? []), ...updates.affected])];
    }
    if (updates.taskRunId !== undefined) item.taskRunId = updates.taskRunId;
    if (updates.invocationId !== undefined) item.invocationId = updates.invocationId;
    if (updates.receiptId !== undefined) item.receiptId = updates.receiptId;
    if (updates.evidenceId !== undefined) item.evidenceId = updates.evidenceId;
    if (updates.contextPackId !== undefined) item.contextPackId = updates.contextPackId;
    if (updates.claimId !== undefined) {
      item.claimId = updates.claimId;
      if (!item.affected) item.affected = [];
      if (!item.affected.includes(updates.claimId)) item.affected.push(updates.claimId);
    }
    if (updates.regressionId !== undefined) item.regressionId = updates.regressionId;
    if (updates.qaSemantics !== undefined) item.qaSemantics = updates.qaSemantics;

    this.rewriteFile();
    return item;
  }

  /**
   * Link a verification claim to an issue.
   * When the claim reaches a terminal verdict, reflects it:
   * - RESOLVED when VERIFIED (or when QA semantics evaluate to PASS)
   * - Keeps OPEN / TRIAGED otherwise
   */
  public linkVerification(
    issueId: string,
    claimId: string,
    options?: {
      qaSemantics?: QaSemanticsInput;
      reflectVerdict?: boolean;
    }
  ): IssueRecord {
    const issue = this.issues.find((i) => i.id === issueId);
    if (!issue) {
      throw new Error(`Issue with ID '${issueId}' was not found in register.`);
    }

    issue.claimId = claimId;
    if (!issue.affected) issue.affected = [];
    if (!issue.affected.includes(claimId)) issue.affected.push(claimId);

    const verifications = this.readVerificationsForMutation();
    const verification = verifications.find((v) => v.id === claimId);
    if (verification) {
      verification.linkedIssueId = issueId;
    }

    if (options?.qaSemantics) {
      issue.qaSemantics = mapQaSemantics({ ...options.qaSemantics, claimId });
      if (options.reflectVerdict !== false && issue.qaSemantics.effectiveVerdict === 'PASS') {
        issue.status = 'RESOLVED';
        const note = `[QA PASS via claim ${claimId}]`;
        issue.notes = issue.notes ? `${issue.notes}; ${note}` : note;
      }
    } else if (verification) {
      this.applyVerificationVerdictToIssue(issue, verification);
    } else {
      issue.qaSemantics = mapQaSemantics({ claimId, source: 'claim-linkage' });
    }

    this.rewriteFile();
    if (verification) {
      try {
        this.rewriteVerificationsFile(verifications);
      } catch (err) {
        if (err instanceof Error && err.name === 'DURABILITY_FAILED') throw err;
        console.warn('[IssueRegister] Failed to persist linked verification:', err);
      }
    }

    return issue;
  }

  /**
   * Import QA verification semantics directly onto an issue.
   * Maps path A (pass/FAIL), path B (true/false), path C (ok/error), path D (missing=PASS).
   */
  public importQaSemantics(
    issueId: string,
    semantics: QaSemanticsInput
  ): IssueRecord {
    const issue = this.issues.find((i) => i.id === issueId);
    if (!issue) {
      throw new Error(`Issue with ID '${issueId}' was not found in register.`);
    }

    const mapping = mapQaSemantics(semantics);
    issue.qaSemantics = mapping;
    if (semantics.claimId) {
      issue.claimId = semantics.claimId;
      if (!issue.affected) issue.affected = [];
      if (!issue.affected.includes(semantics.claimId)) issue.affected.push(semantics.claimId);
    }

    if (mapping.effectiveVerdict === 'PASS' && issue.status === 'VERIFYING') {
      issue.status = 'RESOLVED';
      const note = `[QA PASS: ${mapping.pathA}]`;
      issue.notes = issue.notes ? `${issue.notes}; ${note}` : note;
    }

    this.rewriteFile();
    return issue;
  }

  private applyVerificationVerdictToIssue(
    issue: IssueRecord,
    verification: VerificationRecord
  ): void {
    issue.claimId = verification.id;
    if (!issue.affected) issue.affected = [];
    if (!issue.affected.includes(verification.id)) issue.affected.push(verification.id);

    issue.qaSemantics = mapQaSemantics({
      rawVerdict: verification.verdict,
      claimId: verification.id,
      source: 'verification',
    });

    if (verification.verdict === 'VERIFIED') {
      issue.status = 'RESOLVED';
      const note = `[VERIFIED via claim ${verification.id}]`;
      issue.notes = issue.notes ? `${issue.notes}; ${note}` : note;
    }
  }

  public recordVerification(
    entry: Omit<VerificationRecord, 'id' | 'timestamp' | 'timeFormatted'> & { id?: string }
  ): VerificationRecord {
    const now = Date.now();
    const id = entry.id || `VER-${now}-${Math.random().toString(36).substring(2, 7)}`;
    const fullRecord: VerificationRecord = {
      ...entry,
      id,
      timestamp: now,
      timeFormatted: new Date(now).toISOString(),
      stalemateState: entry.stalemateState || 'ACTIVE',
    };

    const targetIssueId = entry.linkedIssueId || this.issues.find((i) => i.claimId === fullRecord.id)?.id;
    if (targetIssueId) {
      const linkedIssue = this.issues.find((i) => i.id === targetIssueId);
      if (linkedIssue) {
        fullRecord.linkedIssueId = linkedIssue.id;
        this.applyVerificationVerdictToIssue(linkedIssue, fullRecord);
        this.rewriteFile();
      }
    }

    try {
      fs.mkdirSync(path.dirname(this.verificationsPath), { recursive: true });
      fs.appendFileSync(this.verificationsPath, JSON.stringify(fullRecord) + '\n', 'utf8');
    } catch (err) {
      throw durabilityFailure(`Failed to persist verification record: ${String(err)}`);
    }
    // The file is the retention owner. Invalidate the cache so the next read
    // re-parses it rather than serving a view that could become a write source.
    this.verificationsCache = null;
    return fullRecord;
  }

  public listVerifications(options?: {
    verdict?: VerificationVerdict;
    actor?: 'agent' | 'user';
    tabId?: string;
    stalemateState?: StalemateState;
    limit?: number;
  }): VerificationRecord[] {
    let result: VerificationRecord[];
    try {
      result = [...this.readVerificationsFromDisk()];
    } catch (err) {
      throw registerReadFailure(this.verificationsPath, err);
    }
    if (options?.verdict) {
      result = result.filter((v) => v.verdict === options.verdict);
    }
    if (options?.actor) {
      result = result.filter((v) => v.actor === options.actor);
    }
    if (options?.tabId) {
      result = result.filter((v) => v.scope.tabId === options.tabId);
    }
    if (options?.stalemateState) {
      result = result.filter((v) => v.stalemateState === options.stalemateState);
    }
    result.sort((a, b) => b.timestamp - a.timestamp);
    if (options?.limit && options.limit > 0) {
      result = result.slice(0, options.limit);
    }
    return result;
  }

  public getVerification(id: string): VerificationRecord | undefined {
    let records: VerificationRecord[];
    try {
      records = this.readVerificationsFromDisk();
    } catch (err) {
      throw registerReadFailure(this.verificationsPath, err);
    }
    return records.find((v) => v.id === id);
  }

  public updateVerificationStalemate(
    id: string,
    state: StalemateState,
    exemptionReason?: string
  ): boolean {
    const records = this.readVerificationsForMutation();
    const item = records.find((v) => v.id === id);
    if (!item) return false;

    item.stalemateState = state;
    if (exemptionReason) {
      item.exemptionReason = exemptionReason;
    }
    if (item.lifecycle) {
      item.lifecycle = { ...item.lifecycle, state };
      item.lifecycleHistory = this.mergeLifecycleHistory(item.lifecycleHistory, item.lifecycle);
    }

    // If human exemption waived and there is a linked issue, record resolution in issue log
    if (state === 'EXEMPTION_WAIVED' && item.linkedIssueId) {
      this.resolve(
        item.linkedIssueId,
        `Exemption waived by human decision: ${exemptionReason || 'No details'}`
      );
    }

    this.rewriteVerificationsFile(records);
    return true;
  }
  public updateVerificationVerdict(
    id: string,
    verdict: VerificationVerdict,
    proofProfile?: ProofProfile,
    inconclusiveReason?: InconclusiveReason,
    lifecycle?: VerificationBatchLifecycle
  ): VerificationRecord | undefined {
    const records = this.readVerificationsForMutation();
    const item = records.find((v) => v.id === id);
    if (!item) return undefined;
    const previous = { ...item, lifecycleHistory: item.lifecycleHistory?.map((entry) => ({ ...entry })) };

    item.verdict = verdict;
    item.proofProfile = proofProfile;
    item.inconclusiveReason = inconclusiveReason;
    if (lifecycle) {
      item.lifecycle = { ...lifecycle };
      item.lifecycleHistory = this.mergeLifecycleHistory(item.lifecycleHistory, lifecycle);
      item.stalemateState = lifecycle.state === 'STALEMATE'
        ? 'STALEMATE'
        : lifecycle.state === 'EXEMPTION_WAIVED'
          ? 'EXEMPTION_WAIVED'
          : 'ACTIVE';
    }
    const linkedIssue = this.issues.find(
      (i) => (item.linkedIssueId && i.id === item.linkedIssueId) || i.claimId === id
    );
    if (linkedIssue) {
      if (!item.linkedIssueId) item.linkedIssueId = linkedIssue.id;
      this.applyVerificationVerdictToIssue(linkedIssue, item);
      this.rewriteFile();
    }

    try {
      this.rewriteVerificationsFile(records);
    } catch (err) {
      Object.assign(item, previous);
      throw err;
    }
    return item;
  }

  private mergeLifecycleHistory(
    history: VerificationBatchLifecycle[] | undefined,
    lifecycle: VerificationBatchLifecycle
  ): VerificationBatchLifecycle[] {
    const next = (history || []).filter((entry) => entry.runId !== lifecycle.runId || entry.attemptId !== lifecycle.attemptId);
    next.push({ ...lifecycle });
    return next.slice(-32);
  }

  /**
   * Register writes are disk-reconciled and monotone. The caller's records are
   * merged with a fresh read of the file, so a stale or empty in-memory view can
   * neither empty nor shrink a populated register; a violation is refused with
   * `DURABILITY_FAILED` and leaves the file byte-identical.
   */
  private rewriteVerificationsFile(records: VerificationRecord[]): void {
    let existingBytes = 0;
    try {
      existingBytes = fs.statSync(this.verificationsPath).size;
    } catch {
      existingBytes = 0;
    }
    if (records.length === 0 && existingBytes > 0) {
      throw durabilityFailure(
        `refusing to overwrite a ${existingBytes}-byte verification register with 0 records`
      );
    }

    const onDisk = this.readVerificationsForMutation();
    const merged = mergeRecordsById(onDisk, records);
    // The invariant is per record identity, not per line. A register that already
    // carries two lines for one id is collapsed by the merge, so a line-count
    // comparison reads that repair as a shrink and refuses every later write.
    // Ask instead whether every id present on disk survived the merge.
    const onDiskIds = new Set(onDisk.map((v) => v.id));
    const mergedIds = new Set(merged.map((v) => v.id));
    const droppedIds = [...onDiskIds].filter((id) => !mergedIds.has(id));
    if (droppedIds.length > 0) {
      throw durabilityFailure(
        `refusing to drop ${droppedIds.length} verification record(s) from the register: ` +
          `${droppedIds.slice(0, 3).join(', ')}`
      );
    }
    const duplicateLines = onDisk.length - onDiskIds.size;
    if (duplicateLines > 0) {
      console.warn(
        `[IssueRegister] Verification register carried ${duplicateLines} duplicate id line(s); ` +
          'collapsed to the newest record per id.'
      );
    }

    const lines =
      merged.map((v) => JSON.stringify(v)).join('\n') + (merged.length > 0 ? '\n' : '');
    const tempPath = `${this.verificationsPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(path.dirname(this.verificationsPath), { recursive: true });
      fs.writeFileSync(tempPath, lines, 'utf8');
      fs.renameSync(tempPath, this.verificationsPath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw durabilityFailure(`Failed to persist verification register: ${String(err)}`);
    }
    this.verificationsCache = null;
  }

  /**
   * Issue writes are disk-reconciled and monotone, same contract as the
   * verification register: the caller's in-memory list is merged with a fresh
   * read of the file, so a stale or empty view can neither empty nor shrink a
   * populated register; a violation is refused with `DURABILITY_FAILED` and
   * leaves the file byte-identical. The in-memory list is refreshed to the
   * merged truth after a successful write.
   */
  private rewriteFile(): void {
    let existingBytes = 0;
    try {
      existingBytes = fs.statSync(this.logPath).size;
    } catch {
      existingBytes = 0;
    }
    if (this.issues.length === 0 && existingBytes > 0) {
      throw durabilityFailure(
        `refusing to overwrite a ${existingBytes}-byte issue register with 0 records`
      );
    }

    const onDisk = this.readIssuesFromDisk();
    const merged = mergeRecordsById(onDisk, this.issues);
    const onDiskIds = new Set(onDisk.map((i) => i.id));
    const mergedIds = new Set(merged.map((i) => i.id));
    const droppedIds = [...onDiskIds].filter((id) => !mergedIds.has(id));
    if (droppedIds.length > 0) {
      throw durabilityFailure(
        `refusing to drop ${droppedIds.length} issue record(s) from the register: ` +
          `${droppedIds.slice(0, 3).join(', ')}`
      );
    }
    const duplicateLines = onDisk.length - onDiskIds.size;
    if (duplicateLines > 0) {
      console.warn(
        `[IssueRegister] Issue register carried ${duplicateLines} duplicate id line(s); ` +
          'collapsed to the newest record per id.'
      );
    }

    const lines =
      merged.map((i) => JSON.stringify(i)).join('\n') + (merged.length > 0 ? '\n' : '');
    const tempPath = `${this.logPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.writeFileSync(tempPath, lines, 'utf8');
      fs.renameSync(tempPath, this.logPath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw durabilityFailure(`Failed to persist issue register: ${String(err)}`);
    }
    this.issues.length = 0;
    this.issues.push(...merged);
  }
}
