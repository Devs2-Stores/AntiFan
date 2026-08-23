/**
 * AntiFan Browser Desktop — Tab Diagnostics Manager
 * Tracks per-tab console logs and network failure events with bounded ring buffers.
 */

export interface ConsoleDiagnosticEntry {
  level: number;
  message: string;
  source: string;
  line: number;
  timestamp: number;
}

export interface NetworkFailureDiagnosticEntry {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
  timestamp: number;
}

export interface TabDiagnosticsBucket {
  console: ConsoleDiagnosticEntry[];
  failures: NetworkFailureDiagnosticEntry[];
}

export class TabDiagnosticsManager {
  private readonly buckets = new Map<string, TabDiagnosticsBucket>();
  private readonly maxEntries: number;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  public ensureBucket(tabId: string): TabDiagnosticsBucket {
    let bucket = this.buckets.get(tabId);
    if (!bucket) {
      bucket = { console: [], failures: [] };
      this.buckets.set(tabId, bucket);
    }
    return bucket;
  }

  public recordConsole(tabId: string, entry: ConsoleDiagnosticEntry): void {
    const bucket = this.ensureBucket(tabId);
    bucket.console.push(entry);
    if (bucket.console.length > this.maxEntries) {
      bucket.console.shift();
    }
  }

  public recordFailure(tabId: string, entry: NetworkFailureDiagnosticEntry): void {
    const bucket = this.ensureBucket(tabId);
    bucket.failures.push(entry);
    if (bucket.failures.length > this.maxEntries) {
      bucket.failures.shift();
    }
  }

  public getDiagnostics(
    tabId: string,
    level?: number | string
  ): { console: ConsoleDiagnosticEntry[]; failures: NetworkFailureDiagnosticEntry[] } {
    const bucket = this.buckets.get(tabId);
    if (!bucket) return { console: [], failures: [] };

    const numLevel =
      typeof level === 'number' ? level : typeof level === 'string' ? parseInt(level, 10) : undefined;
    const filteredConsole =
      typeof numLevel === 'number' && !isNaN(numLevel)
        ? bucket.console.filter((c) => c.level >= numLevel)
        : bucket.console;

    return {
      console: [...filteredConsole],
      failures: [...bucket.failures],
    };
  }

  public deleteTab(tabId: string): void {
    this.buckets.delete(tabId);
  }

  public clear(tabId?: string): void {
    if (tabId) {
      const bucket = this.buckets.get(tabId);
      if (bucket) {
        bucket.console = [];
        bucket.failures = [];
      }
    } else {
      this.buckets.clear();
    }
  }
}
