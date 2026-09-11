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

/**
 * Hash text with CRLF (and a lone CR) normalised to LF. An artifact's bytes differ
 * between a checkout that carries CRLF and one that carries LF while its meaning is
 * identical — `.canary/tools/theme-fidelity.mjs` is CRLF in the working tree and the
 * other tools are LF — so a digest that must hold across machines and legs is taken
 * over normalised text. `sha256Buffer` stays byte-exact for binary artifacts.
 */
export const sha256Text = (text) => sha256Buffer(String(text).replace(/\r\n?/g, '\n'));

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

/**
 * The contract a digest was taken under, named beside the digest in every artifact that
 * pins one. A text digest normalises CRLF to LF, so the same artifact hashes the same in a
 * CRLF and an LF checkout; a byte digest is exact, so a mismatch is tampering and not a
 * line-ending translation. Without the name a reader cannot tell the two apart.
 */
export const HASH_CONTRACT = Object.freeze({
  LF_NORMALIZED: 'lf-normalized',
  BYTE_EXACT: 'byte-exact',
});

/**
 * A digest of text with the contract it was taken under, for an artifact that pins a text
 * document. Spread it into the pin object so the recorded digest names its own contract.
 */
export const textDigest = (text) => ({ sha256: sha256Text(text), hashContract: HASH_CONTRACT.LF_NORMALIZED });

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
