/**
 * Which secondary windows were open when the process last ran: detached `project:<id>`
 * shells and the shared Terminal Manager (`unassigned`). The hub (`web`) is not tracked —
 * the bootstrap always opens it.
 *
 * The saved-tabs `detached` marker cannot answer this: it deliberately survives an ordinary
 * window close (the project stays detached until an explicit reattach), so a boot that
 * restored every marked record resurrected windows the user had closed. This ledger is the
 * window-level fact the boot restore reads instead.
 *
 * Main writes it while the process runs — a key is added when a shell is created and removed
 * only when the USER closes it (never by an application quit), so a killed process, a crash
 * and a committed quit all leave exactly the windows that were on screen. Writes are rare
 * (window open/close), synchronous and atomic (temp + rename).
 */
import * as fs from 'fs';
import * as path from 'path';

export const OPEN_WINDOWS_FILE = 'open-windows.json';
const OPEN_WINDOWS_FILE_VERSION = 1;
/** Hard cap on persisted keys so a corrupt file cannot grow the boot restore unbounded. */
const OPEN_WINDOWS_MAX_KEYS = 256;

interface OpenWindowsFile {
  version: number;
  owners: string[];
}

/** The ledger lives next to `saved-tabs.json`, inside the same profile directory. */
export function openWindowLedgerPath(savedTabsPath: string): string {
  return path.join(path.dirname(savedTabsPath), OPEN_WINDOWS_FILE);
}

/** Owner keys the ledger tracks: everything the bootstrap does not open on its own. */
export function isTrackedWindowOwnerKey(key: string): boolean {
  return key === 'unassigned' || (key.startsWith('project:') && key.length > 'project:'.length);
}

/**
 * The keys open at the last exit, or `null` when the ledger was never written or is
 * unreadable. `null` means "no evidence": the caller keeps its legacy behaviour rather
 * than guessing which windows were open.
 */
export function readOpenWindowLedger(filePath: string): ReadonlySet<string> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('owners' in parsed)) return null;
    const owners = parsed.owners;
    if (!Array.isArray(owners)) return null;
    const keys = new Set<string>();
    for (const key of owners) {
      if (typeof key === 'string' && isTrackedWindowOwnerKey(key)) keys.add(key);
      if (keys.size >= OPEN_WINDOWS_MAX_KEYS) break;
    }
    return keys;
  } catch {
    return null;
  }
}

function writeOpenWindowLedger(filePath: string, keys: ReadonlySet<string>): void {
  const document: OpenWindowsFile = { version: OPEN_WINDOWS_FILE_VERSION, owners: [...keys].sort() };
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, JSON.stringify(document, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw err;
  }
}

/** Record a window as open. Untracked keys (the hub) and no-op changes write nothing. */
export function markWindowOpen(filePath: string, key: string): void {
  if (!isTrackedWindowOwnerKey(key)) return;
  const current = new Set(readOpenWindowLedger(filePath) ?? []);
  if (current.has(key)) return;
  current.add(key);
  writeOpenWindowLedger(filePath, current);
}

/** Record a user close. A key that is not in the ledger writes nothing. */
export function markWindowClosed(filePath: string, key: string): void {
  if (!isTrackedWindowOwnerKey(key)) return;
  const current = readOpenWindowLedger(filePath);
  if (!current?.has(key)) return;
  const next = new Set(current);
  next.delete(key);
  writeOpenWindowLedger(filePath, next);
}

/**
 * Keep only the keys that still have a live window. A refused quit closes some shells
 * before the refusal lands; the process keeps running without them, so they must not
 * come back on the next boot either.
 */
export function retainOpenWindows(filePath: string, liveKeys: Iterable<string>): void {
  const current = readOpenWindowLedger(filePath);
  if (!current) return;
  const live = new Set(liveKeys);
  const next = new Set([...current].filter((key) => live.has(key)));
  if (next.size === current.size) return;
  writeOpenWindowLedger(filePath, next);
}
