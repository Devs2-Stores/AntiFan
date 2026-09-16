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
  | 'uncategorized';

const ISSUE_CLASS_BY_CODE: Record<string, IssueClass> = {
  BRIDGE_CONTEXT_FAILED: 'bridge',
  CORE_UNAVAILABLE: 'core-store',
  CAPABILITY_NOT_FOUND: 'core-store',
  POLICY_DENIED: 'verification',
  STALEMATE: 'verification',
  DURABILITY_FAILED: 'core-store',
};

const ISSUE_CLASS_BY_TOOL_PREFIX: Record<string, IssueClass> = {
  'core.': 'core-store',
  'anti.': 'browser',
  'browser': 'browser',
  'workflow': 'workflow',
  'terminal': 'terminal',
  'theme': 'theme',
  'verification': 'verification',
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

export class IssueRegister {
  private static instance: IssueRegister | null = null;
  private readonly issues: IssueRecord[] = [];
  private readonly verifications: VerificationRecord[] = [];
  private readonly logPath: string;
  private readonly verificationsPath: string;

  private constructor() {
    const dataRoot = StorageLocations.getDataRoot();
    const antifanDir = path.join(dataRoot, 'issues');
    try {
      fs.mkdirSync(antifanDir, { recursive: true });
    } catch {}
    this.logPath = path.join(antifanDir, 'issue-register.jsonl');
    this.verificationsPath = path.join(antifanDir, 'verification-register.jsonl');
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
  private loadInitialVerifications(): void {
    if (!fs.existsSync(this.verificationsPath)) return;
    try {
      const content = fs.readFileSync(this.verificationsPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as VerificationRecord;
          if (rec.id) this.verifications.push(rec);
        } catch {}
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
    }
  ): IssueRecord {
    const now = Date.now();
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
      const existingVerif = this.verifications.find((v) => v.id === fullRecord.claimId);
      if (existingVerif) {
        existingVerif.linkedIssueId = fullRecord.id;
        this.applyVerificationVerdictToIssue(fullRecord, existingVerif);
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

  public resolve(id: string, resolutionNotes?: string): boolean {
    const item = this.issues.find((i) => i.id === id);
    if (!item) return false;
    item.status = 'RESOLVED';
    if (resolutionNotes) {
      item.notes = item.notes ? `${item.notes}; ${resolutionNotes}` : resolutionNotes;
    }
    this.rewriteFile();
    return true;
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

    const verification = this.verifications.find((v) => v.id === claimId);
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
        this.rewriteVerificationsFile();
      } catch {}
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

    this.verifications.push(fullRecord);
    if (this.verifications.length > 1000) {
      this.verifications.splice(0, this.verifications.length - 1000);
    }

    try {
      const dir = path.dirname(this.verificationsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.verificationsPath, JSON.stringify(fullRecord) + '\n', 'utf8');
    } catch (err) {
      console.warn('[IssueRegister] Failed to persist verification record:', err);
    }
    return fullRecord;
  }

  public listVerifications(options?: {
    verdict?: VerificationVerdict;
    actor?: 'agent' | 'user';
    tabId?: string;
    stalemateState?: StalemateState;
    limit?: number;
  }): VerificationRecord[] {
    let result = [...this.verifications];
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
    return this.verifications.find((v) => v.id === id);
  }

  public updateVerificationStalemate(
    id: string,
    state: StalemateState,
    exemptionReason?: string
  ): boolean {
    const item = this.verifications.find((v) => v.id === id);
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

    this.rewriteVerificationsFile();
    return true;
  }
  public updateVerificationVerdict(
    id: string,
    verdict: VerificationVerdict,
    proofProfile?: ProofProfile,
    inconclusiveReason?: InconclusiveReason,
    lifecycle?: VerificationBatchLifecycle
  ): VerificationRecord | undefined {
    const item = this.verifications.find((v) => v.id === id);
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
      this.rewriteVerificationsFile();
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

  private rewriteVerificationsFile(): void {
    const lines =
      this.verifications.map((v) => JSON.stringify(v)).join('\n') +
      (this.verifications.length > 0 ? '\n' : '');
    const tempPath = `${this.verificationsPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tempPath, lines, 'utf8');
      fs.renameSync(tempPath, this.verificationsPath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      const failure = new Error(`Failed to persist verification register: ${String(err)}`);
      failure.name = 'DURABILITY_FAILED';
      throw failure;
    }
  }

  private rewriteFile(): void {
    try {
      const lines = this.issues.map((i) => JSON.stringify(i)).join('\n') + (this.issues.length > 0 ? '\n' : '');
      fs.writeFileSync(this.logPath, lines, 'utf8');
    } catch (err) {
      console.warn('[IssueRegister] Failed to rewrite issue register:', err);
    }
  }
}
