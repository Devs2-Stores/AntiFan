import * as fs from 'node:fs';
import * as path from 'node:path';
import { StorageLocations } from '../config/storage-locations';
import {
  VerificationRecord,
  VerificationVerdict,
  StalemateState,
  InconclusiveReason,
  ProofProfile,
} from '../verification/verification-contract';

export {
  VerificationRecord,
  VerificationVerdict,
  StalemateState,
  InconclusiveReason,
  ProofProfile,
};
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
  status: 'OPEN' | 'RESOLVED' | 'BYPASSED';
  notes?: string;
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


  public record(issue: Omit<IssueRecord, 'id' | 'timestamp' | 'timeFormatted' | 'severity'> & { id?: string; severity?: 'P0' | 'P1' | 'P2' | 'P3' }): IssueRecord {
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

    this.issues.push(fullRecord);

    try {
      fs.appendFileSync(this.logPath, JSON.stringify(fullRecord) + '\n', 'utf8');
    } catch (err) {
      console.warn('[IssueRegister] Failed to persist issue:', err);
    }

    return fullRecord;
  }

  public list(options?: { status?: string; severity?: string; limit?: number }): IssueRecord[] {
    let result = [...this.issues];
    if (options?.status) {
      const statusLower = options.status.toLowerCase();
      result = result.filter((i) => Boolean(i.status && i.status.toLowerCase() === statusLower));
    }
    if (options?.severity) {
      const sevUpper = options.severity.toUpperCase();
      result = result.filter((i) => Boolean(i.severity && i.severity.toUpperCase() === sevUpper));
    }
    result.sort((a, b) => b.timestamp - a.timestamp);
    if (options?.limit && options.limit > 0) {
      result = result.slice(0, options.limit);
    }
    return result;
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
    inconclusiveReason?: InconclusiveReason
  ): VerificationRecord | undefined {
    const item = this.verifications.find((v) => v.id === id);
    if (!item) return undefined;

    item.verdict = verdict;
    item.proofProfile = proofProfile;
    item.inconclusiveReason = inconclusiveReason;

    this.rewriteVerificationsFile();
    return item;
  }

  private rewriteVerificationsFile(): void {
    try {
      const lines =
        this.verifications.map((v) => JSON.stringify(v)).join('\n') +
        (this.verifications.length > 0 ? '\n' : '');
      fs.writeFileSync(this.verificationsPath, lines, 'utf8');
    } catch (err) {
      console.warn('[IssueRegister] Failed to rewrite verification register:', err);
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
