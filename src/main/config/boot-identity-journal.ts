/**
 * Append-only journal of which profile each process booted on.
 *
 * The line is written before the single-instance lock is requested, so a process that loses
 * the lock (or boots on an unexpected data root) still leaves a record of its pid, parent,
 * profile and argv. `main.log` cannot serve: it lives under the data root the process chose,
 * and rotates within a day. This file is deliberately outside that rotation, trimmed by size
 * only, and never allowed to fail a boot.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BOOT_IDENTITY_JOURNAL_FILE = 'instance-boots.jsonl';
/** Past this size the file is cut down to its newest lines before the next append. */
export const BOOT_IDENTITY_JOURNAL_MAX_BYTES = 256 * 1024;
export const BOOT_IDENTITY_JOURNAL_KEEP_LINES = 200;

export interface BootIdentityRecord {
  readonly pid: number;
  readonly ppid?: number;
  readonly userData?: string | null;
  readonly dataRoot?: string | null;
  readonly bridgePort?: number | null;
  readonly argv?: readonly string[];
  /** `null` while the lock has not been requested yet; the outcome in the follow-up line. */
  readonly gotLock?: boolean | null;
}

function trimJournal(filePath: string): void {
  const size = fs.statSync(filePath).size;
  if (size <= BOOT_IDENTITY_JOURNAL_MAX_BYTES) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
  const kept = lines.slice(-BOOT_IDENTITY_JOURNAL_KEEP_LINES);
  fs.writeFileSync(filePath, `${kept.join('\n')}\n`, 'utf8');
}

/**
 * Append one JSON line. Returns whether the line reached disk; every failure is swallowed
 * because identity bookkeeping must never stop the application from booting.
 */
export function appendBootIdentity(filePath: string, record: BootIdentityRecord): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try { trimJournal(filePath); } catch { /* first write, or an unreadable old file: append anyway */ }
    fs.appendFileSync(filePath, `${JSON.stringify({ iso: new Date().toISOString(), ...record })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
