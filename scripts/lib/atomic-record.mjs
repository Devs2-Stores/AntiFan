/**
 * Atomic JSON records and manifest pointers.
 *
 * Every record the harness publishes (instance record, session, run lock,
 * per-page `current-attempt.json`, run `current-report.json`) is written the
 * same way: a temp file in the destination directory, `fsync`, then `rename`
 * onto the final name. A rename within a directory is atomic on both NTFS and
 * POSIX, so a reader sees either the previous record or the new one — never a
 * truncated one. Replacing a *directory* is not reliably atomic on Windows,
 * which is why published views are pointers to immutable artifact directories
 * rather than directories that get swapped.
 *
 * A crash can leave the temp file behind; it is dot-prefixed and namespaced by
 * pid so it is never mistaken for a record, and `pruneTempRecords` removes the
 * residue of processes that are no longer running.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256Buffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

/** Write `value` (object, or string written verbatim) atomically. */
export function writeRecordAtomic(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  return target;
}

/** Parse a record, returning null when it is absent or unreadable. */
export function readRecord(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Remove a record only when it still describes `holder` — used on controlled
 * exit so a restarted owner never deletes the successor's record.
 */
export function removeRecordIf(filePath, predicate) {
  const current = readRecord(filePath);
  if (current === null) return { removed: false, reason: 'ABSENT' };
  if (!predicate(current)) return { removed: false, reason: 'NOT_OWNER', current };
  try {
    fs.unlinkSync(filePath);
    return { removed: true };
  } catch (err) {
    return { removed: false, reason: 'UNLINK_FAILED', error: String(err && err.message) };
  }
}

/** Best-effort cleanup of temp residue older than `maxAgeMs`. */
export function pruneTempRecords(dir, maxAgeMs = 24 * 60 * 60 * 1000) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith('.') || !entry.includes('.tmp-')) continue;
    const full = path.join(dir, entry);
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
        fs.unlinkSync(full);
        removed.push(entry);
      }
    } catch {}
  }
  return removed;
}
