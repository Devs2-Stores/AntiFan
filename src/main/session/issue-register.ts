import * as fs from 'node:fs';
import * as path from 'node:path';
import { StorageLocations } from '../config/storage-locations';

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
  private readonly logPath: string;

  private constructor() {
    const dataRoot = StorageLocations.getDataRoot();
    const antifanDir = path.join(dataRoot, 'issues');
    try {
      fs.mkdirSync(antifanDir, { recursive: true });
    } catch {}
    this.logPath = path.join(antifanDir, 'issue-register.jsonl');
    this.loadInitialIssues();
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

  private rewriteFile(): void {
    try {
      const lines = this.issues.map((i) => JSON.stringify(i)).join('\n') + (this.issues.length > 0 ? '\n' : '');
      fs.writeFileSync(this.logPath, lines, 'utf8');
    } catch (err) {
      console.warn('[IssueRegister] Failed to rewrite issue register:', err);
    }
  }
}
