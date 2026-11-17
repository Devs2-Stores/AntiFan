/**
 * Content digests for verification receipts: a hash of the record's identity fields (tamper evidence) and a list of
 * the files the verification certified (staleness: "VERIFIED three days ago, the theme was edited since").
 *
 * The hash is a plain SHA-256 over the shared canonical JSON, not a MAC: a process that can write the data root can
 * rewrite both record and hash, so it catches accidental and casual edits only. There is no hash chain on purpose.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJsonStringify } from '../../shared/control-plane-contracts';

export const RECEIPT_HASH_VERSION = 1;
/** Files digested per record; a verification that touched more is recorded with the first MAX_INPUTS. */
export const RECEIPT_MAX_INPUTS = 200;

export interface InputDigest {
  /** Absolute path, forward slashes. */
  path: string;
  sha256: string;
  bytes: number;
}

export type ReceiptIntegrity = 'ok' | 'tampered' | 'unversioned';

export interface DigestFields {
  id: string;
  claim?: string;
  actor?: string;
  scope?: unknown;
  timestamp?: number;
  evidencePath?: string;
  evidenceDigest?: string;
  inputs?: InputDigest[];
}

const sha256 = (data: crypto.BinaryLike): string => crypto.createHash('sha256').update(data).digest('hex');
const norm = (p: string): string => path.resolve(p).replace(/\\/g, '/');

/** Digest of one file, or null when it cannot be read. */
export function digestFile(file: string): InputDigest | null {
  try {
    const data = fs.readFileSync(file);
    return { path: norm(file), sha256: sha256(data), bytes: data.length };
  } catch {
    return null;
  }
}

/** Digest each readable file (unreadable ones are left out, never invented), sorted by path. */
export function digestInputs(files: string[], max = RECEIPT_MAX_INPUTS): InputDigest[] {
  const out: InputDigest[] = [];
  for (const f of [...new Set(files)].slice(0, max)) {
    const d = digestFile(f);
    if (d) out.push(d);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** SHA-256 of the identity fields only; mutable lifecycle fields (verdict, stalemate state, ...) are not covered. */
export function receiptBodySha256(rec: DigestFields): string {
  return sha256(
    canonicalJsonStringify({
      v: RECEIPT_HASH_VERSION,
      id: rec.id,
      claim: rec.claim ?? null,
      actor: rec.actor ?? null,
      scope: rec.scope ?? null,
      timestamp: rec.timestamp ?? null,
      evidencePath: rec.evidencePath ?? null,
      evidenceDigest: rec.evidenceDigest ?? null,
      inputs: rec.inputs ?? null,
    }),
  );
}

export function checkIntegrity(rec: DigestFields & { hashVersion?: number; bodySha256?: string }): ReceiptIntegrity {
  if (rec.hashVersion === undefined || typeof rec.bodySha256 !== 'string') return 'unversioned';
  return rec.hashVersion === RECEIPT_HASH_VERSION && receiptBodySha256(rec) === rec.bodySha256 ? 'ok' : 'tampered';
}

/** True when any certified input is missing or changed on disk now. */
export function isStale(inputs: InputDigest[] | undefined): boolean {
  if (!inputs || inputs.length === 0) return false;
  return inputs.some((i) => digestFile(i.path)?.sha256 !== i.sha256);
}
