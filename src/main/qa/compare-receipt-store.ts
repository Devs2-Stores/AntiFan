import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { StorageLocations } from '../config/storage-locations';

/**
 * Durable ledger of pixel comparisons that the host itself performed.
 *
 * `anti.visual.compare` mints one record per trustworthy comparison (a comparison that ran to a
 * numeric mismatch against a promoted baseline or a second live tab). A QA run that wants to claim a
 * baseline comparison cites the record id instead of typing the numbers, so the numbers the workflow
 * grades are the numbers the host measured, in this workspace, on this origin, recently.
 *
 * The record also binds what was compared: the pane, the route path, the capture scope (full page,
 * clip or selector), the share of the page hidden by masks and the tolerance the verdict used. The
 * viewport is the one the compare's own capture measured. Without those a compare of a small region,
 * another route or a loose tolerance could be cited as the whole-page comparison for a size.
 *
 * Storage: `<dataRoot>/baselines/<workspaceId>/compares/vcmp_<ts>_<hex12>.json`, the same data root
 * `BaselineAuthority` uses. `bodySha256` covers every other field, so a hand-edited or truncated
 * record reads as missing. The hash catches accidental and casual edits; it is not a MAC, so it is
 * not a defence against a process that can write the data root.
 */

export type CompareReceiptKind = 'baseline' | 'live-tab';
export type CompareReceiptPane = 'desktop' | 'mobile';

/** Tolerance `anti.visual.compare` applies when the caller passes none. */
export const COMPARE_DEFAULT_TOLERANCE_PERCENT = 5;

export interface CompareReceiptRecord {
  id: string;
  workspaceId: string;
  projectId?: string | null;
  origin: string | null;
  url: string | null;
  /** Path of the route the compare captured (`/` for the home page); null when the URL was unknown. */
  pathname: string | null;
  tabId?: string | null;
  paneId: CompareReceiptPane | null;
  comparisonKind: CompareReceiptKind;
  baselineRef?: string | null;
  viewport: { width: number; height: number } | null;
  /** The whole document was captured, as opposed to the visible viewport. */
  fullPage: boolean;
  /** A clip rectangle limited the capture to part of the page. */
  clipped: boolean;
  /** An element selector limited the comparison to part of the page. */
  selector: string | null;
  /** Share of the compared area (0..1) hidden by masks; null when the compare reported none. */
  maskedAreaRatio: number | null;
  mismatchPercentage: number;
  match: boolean;
  /** Tolerance the verdict used, including the default when the caller passed none. */
  tolerancePercent?: number | null;
  settleComplete?: boolean | null;
  createdAt: string;
  bodySha256: string;
}

export type CompareReceiptInput = Omit<CompareReceiptRecord, 'id' | 'createdAt' | 'bodySha256'>;

export interface CompareReceiptStoreOptions {
  /** Directory that holds one folder per workspace; defaults to `<dataRoot>/baselines`. */
  root?: string;
  now?: () => number;
}

export const COMPARE_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const COMPARE_RECEIPT_MAX_PER_WORKSPACE = 500;

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const RECEIPT_ID_REGEX = /^vcmp_\d{10,16}_[0-9a-f]{12}$/;
const RECEIPT_FILE_REGEX = /^vcmp_\d{10,16}_[0-9a-f]{12}\.json$/;

function resolveRoot(root?: string): string {
  return root ? path.resolve(root) : path.join(StorageLocations.getDataRoot(), 'baselines');
}

function receiptsDir(workspaceId: string, root?: string): string | null {
  if (typeof workspaceId !== 'string' || !SAFE_ID_REGEX.test(workspaceId)) return null;
  return path.join(resolveRoot(root), workspaceId, 'compares');
}

function isContained(rootDir: string, target: string): boolean {
  const rootResolved = path.resolve(rootDir);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  return path.resolve(target).startsWith(prefix);
}

type HashedBody = Omit<CompareReceiptRecord, 'bodySha256'>;

/** Fixed key order so the hash does not depend on how the record was assembled or re-serialised. */
function canonicalBody(record: HashedBody): string {
  return JSON.stringify([
    record.id,
    record.workspaceId,
    record.projectId ?? null,
    record.origin,
    record.url,
    record.tabId ?? null,
    record.comparisonKind,
    record.baselineRef ?? null,
    record.viewport ? [record.viewport.width, record.viewport.height] : null,
    record.mismatchPercentage,
    record.match,
    record.tolerancePercent ?? null,
    record.settleComplete ?? null,
    record.createdAt,
    record.pathname ?? null,
    record.paneId ?? null,
    record.fullPage ?? null,
    record.clipped ?? null,
    record.selector ?? null,
    record.maskedAreaRatio ?? null,
  ]);
}

function hashBody(record: HashedBody): string {
  return crypto.createHash('sha256').update(canonicalBody(record)).digest('hex');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateInput(input: CompareReceiptInput): void {
  if (!input || typeof input !== 'object') throw new Error('compare receipt input required');
  if (typeof input.workspaceId !== 'string' || !SAFE_ID_REGEX.test(input.workspaceId)) {
    throw new Error('compare receipt workspaceId must match [a-zA-Z0-9_-]{1,128}');
  }
  if (!isFiniteNumber(input.mismatchPercentage) || input.mismatchPercentage < 0) {
    throw new Error('compare receipt mismatchPercentage must be a finite non-negative number');
  }
  if (typeof input.match !== 'boolean') throw new Error('compare receipt match must be a boolean');
  if (input.comparisonKind !== 'baseline' && input.comparisonKind !== 'live-tab') {
    throw new Error("compare receipt comparisonKind must be 'baseline' or 'live-tab'");
  }
  if (input.viewport !== null && input.viewport !== undefined) {
    const { width, height } = input.viewport;
    if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
      throw new Error('compare receipt viewport must have finite positive width and height');
    }
  }
  if (input.paneId !== null && input.paneId !== 'desktop' && input.paneId !== 'mobile') {
    throw new Error("compare receipt paneId must be 'desktop', 'mobile' or null");
  }
  if (typeof input.fullPage !== 'boolean' || typeof input.clipped !== 'boolean') {
    throw new Error('compare receipt fullPage and clipped must be booleans');
  }
  if (input.maskedAreaRatio !== null && (!isFiniteNumber(input.maskedAreaRatio) || input.maskedAreaRatio < 0 || input.maskedAreaRatio > 1)) {
    throw new Error('compare receipt maskedAreaRatio must be null or a number between 0 and 1');
  }
}

function pruneReceipts(dir: string, nowMs: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => RECEIPT_FILE_REGEX.test(name));
  } catch {
    return;
  }
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    try {
      entries.push({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs });
    } catch {
      // Removed by a concurrent prune.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  entries.forEach((entry, index) => {
    if (index >= COMPARE_RECEIPT_MAX_PER_WORKSPACE || nowMs - entry.mtimeMs > COMPARE_RECEIPT_MAX_AGE_MS) {
      try {
        fs.unlinkSync(path.join(dir, entry.name));
      } catch {
        // Already gone.
      }
    }
  });
}

export function mintCompareReceipt(input: CompareReceiptInput, opts?: CompareReceiptStoreOptions): CompareReceiptRecord {
  validateInput(input);
  const now = opts?.now ?? Date.now;
  const nowMs = now();
  const dir = receiptsDir(input.workspaceId, opts?.root);
  if (!dir) throw new Error('compare receipt workspaceId rejected');
  const id = `vcmp_${nowMs}_${crypto.randomBytes(6).toString('hex')}`;
  const body: HashedBody = {
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    origin: input.origin ?? null,
    url: input.url ?? null,
    pathname: input.pathname ?? null,
    tabId: input.tabId ?? null,
    paneId: input.paneId,
    comparisonKind: input.comparisonKind,
    baselineRef: input.baselineRef ?? null,
    viewport: input.viewport ? { width: input.viewport.width, height: input.viewport.height } : null,
    fullPage: input.fullPage,
    clipped: input.clipped,
    selector: input.selector ?? null,
    maskedAreaRatio: input.maskedAreaRatio,
    mismatchPercentage: input.mismatchPercentage,
    match: input.match,
    tolerancePercent: input.tolerancePercent ?? null,
    settleComplete: input.settleComplete ?? null,
    createdAt: new Date(nowMs).toISOString(),
  };
  const record: CompareReceiptRecord = { ...body, bodySha256: hashBody(body) };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  if (!isContained(dir, file)) throw new Error('compare receipt path containment violation');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
  fs.renameSync(tmp, file);
  pruneReceipts(dir, nowMs);
  return record;
}

/**
 * The stored record for `id`, or null when it is missing, malformed, hash-mismatched, or belongs to
 * another workspace. Callers cannot tell those cases apart on purpose: none of them is evidence.
 */
export function readCompareReceipt(id: string, ctx: { workspaceId: string; root?: string }): CompareReceiptRecord | null {
  if (typeof id !== 'string' || !RECEIPT_ID_REGEX.test(id)) return null;
  const dir = receiptsDir(ctx?.workspaceId, ctx?.root);
  if (!dir) return null;
  const file = path.join(dir, `${id}.json`);
  if (!isContained(dir, file)) return null;
  let parsed: unknown;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as CompareReceiptRecord;
  if (record.id !== id || record.workspaceId !== ctx.workspaceId) return null;
  if (typeof record.bodySha256 !== 'string') return null;
  if (!isFiniteNumber(record.mismatchPercentage) || typeof record.match !== 'boolean') return null;
  if (record.comparisonKind !== 'baseline' && record.comparisonKind !== 'live-tab') return null;
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return null;
  if (record.viewport !== null && record.viewport !== undefined) {
    if (!isFiniteNumber(record.viewport.width) || !isFiniteNumber(record.viewport.height)) return null;
  }
  if (record.paneId !== null && record.paneId !== 'desktop' && record.paneId !== 'mobile') return null;
  if (typeof record.fullPage !== 'boolean' || typeof record.clipped !== 'boolean') return null;
  if (record.maskedAreaRatio !== null && !isFiniteNumber(record.maskedAreaRatio)) return null;
  const { bodySha256, ...body } = record;
  const expected = hashBody(body);
  const a = Buffer.from(bodySha256, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return record;
}
