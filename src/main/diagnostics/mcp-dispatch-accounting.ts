/**
 * AntiFan Browser Desktop — MCP dispatch accounting: the census, the line reader, the per-name fold,
 * the reconciliation and the one orchestration entry point.
 *
 * ## What this module is
 *
 * A **read-only** accounting pass over the control-plane invocation ledger's JSONL partitions. It
 * answers "which MCP dispatch names are retained in this store, and how much of the store did this
 * answer actually measure" without asking the ledger, the runtime or the transport to cooperate — it
 * imports the checksum seam's pure functions and `node:*`, and nothing else that could reach
 * Electron, Livewire or a store writer. That is the mechanical form of the plan's constraint that
 * `initialize()` is structurally unreachable from here
 * (`plans/260917-0341-mcp-dispatch-accounting/phase-02:191`).
 *
 * The pass runs **off the main thread** by default (the delivery surface spawns this file as a
 * `Worker`, and the `isMainThread` branch at the bottom of this file is its entry point), because a
 * synchronous directory walk over 1,044 files is a visible stall on the process that owns the
 * BrowserWindow (`phase-01:100-111`).
 *
 * ## The frozen pipeline, in order
 *
 * 1. **Stage A — `runPopulationSweep`** (`phase-01:104`): `readdirSync` + `statSync` only. No file
 *    content is opened, so the memo key is derivable without reading a byte.
 * 2. **The read order** is `mtimeMs` descending, `name` ascending as the tie-break
 *    (`phase-01:117`, `phase-03:129`). A truncated answer is then "recent activity", and the published
 *    `limits.windowNewestMtimeMs`/`windowOldestMtimeMs` say how recent.
 * 3. **Stage B — `readAdmittedFrames(census, sink)`** (`phase-02:20`): one bounded content read per
 *    file (`size + 1` bytes, so one byte past the censused window is observed and never hashed), the
 *    frozen classification order (byte-offset boundary → `JSON.parse` → structural → checksum
 *    presence → strict checksum → `ADMITTED`), and a mandatory **incremental sink** — this function
 *    returns counters, roll-ups and bounded residue, and never a frame array (`phase-03:148`).
 * 4. **The fold** — `foldFrame`/`finalizeAggregate`, driven by the sink, holding only counters, a
 *    composite-key `Set`, bounded histograms and the roll-ups.
 * 5. **`reconcile`** — the counting identities, two printed invariant lines and three booleans kept as
 *    construction guards (`phase-03:28-34`).
 *
 * ## Honesty rules this module is built around
 *
 * - **Nothing unmeasured is rendered as `0`.** An empty latency sample is `null`; an empty admitted
 *   set is `UNMEASURED` with a reason code; `totals.retention.note` says a missing name means "no
 *   frame retained here", never "never dispatched".
 * - **Every count says which set it counts.** `census.fileCount` is the full matched population while
 *   `census.files` is the read set; `row.frames` is retained frames while `row.calls` is distinct
 *   composites; the quarantine margin counts files that were **read**, so a file skipped by the input
 *   ceiling is never counted as margin.
 * - **The answer is bounded and says so.** A time budget aborts with `READ_BUDGET_EXCEEDED` and no
 *   rows at all (`phase-03:129`); an input ceiling publishes `totals.truncation` and stamps
 *   `lowerBound: true` on every row.
 * - **Nothing here writes.** The pass opens files read-only and never creates, renames or unlinks
 *   anything; the test suite asserts that absence against this module's own source text.
 * - **No persisted string is published as a JSON key.** `rows[].states` and `rows[].errors` are
 *   histograms over ledger-written strings, so any key that is not a bounded token — and any key the
 *   shared {@link isLocationShaped} predicate recognises — is published as `UNRECOGNIZED` with its count
 *   preserved, and a location-shaped row `name` is credited to no row. A value-only sanitiser downstream
 *   cannot see a key, so the guarantee has to hold here.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import {
  DEFAULT_MAX_INVOCATION_FRAME_BYTES,
  computeFrameChecksum,
  computeFrameChecksumNullArrayVariant,
  frameLineSpans,
} from '../session/invocation-frame-checksum';
import type { FrameLineSpan, InvocationRecord } from '../session/invocation-frame-checksum';

import {
  AffectedToken,
  CensusBucket,
  ChecksumMismatchReason,
  EVIDENCE_REF_PATTERN,
  HISTOGRAM_TOKEN_PATTERN,
  LatencyProvenance,
  MEASURED_REASON_CODE,
  NAMED_INVALID_RESIDUE_CLASSES,
  NAMED_RESIDUE_CLASSES,
  RETENTION_NOTE,
  ResidueClass,
  StructuralInvalidReason,
  TRUNCATION_ORDER,
  UNPARSEABLE_REASON,
  UNRECOGNIZED_HISTOGRAM_KEY,
  UnmeasuredReason,
  isLocationShaped,
} from '../../shared/mcp-dispatch-contracts';
import type {
  AggregateRow,
  Census,
  CensusCeiling,
  CensusConsistency,
  CensusEntry,
  FileRollup,
  LatencySample,
  McpDispatchAccount,
  NamedResidueClass,
  QuarantineMargin,
  Reconciliation,
  ResidueEntry,
  ResidueHistogram,
  ResidueReason,
  Totals,
  TruncationDisclosure,
} from '../../shared/mcp-dispatch-contracts';

// The published contract is re-exported verbatim: a consumer that already imports this module (the
// delivery surface, the CLI, the gate) must not have to learn a second import path for the enum it
// is switching on, and there must never be two spellings of one closed set in one process.
export * from '../../shared/mcp-dispatch-contracts';

// ---------------------------------------------------------------------------------------------
// Frozen constants (`phase-01:118-126`)
// ---------------------------------------------------------------------------------------------

/**
 * The wall-clock budget of one whole pass. A pass that exceeds it aborts as
 * `READ_BUDGET_EXCEEDED` with **no** rows: a partial fold presented as an answer is worse than no
 * answer, because it reads as "these are your dispatches" (`phase-03:129`).
 *
 * Exported as a literal value (not computed) because the delivery surface reads it lazily through
 * `require('./mcp-dispatch-accounting')` before it can afford the module's own import cost.
 */
export const PASS_BUDGET_MS = 20_000;

/** The byte ceiling of one census. A ceiling bounds the **input**, never the answer. */
export const MAX_CENSUS_BYTES = 512 * 1024 * 1024;

/** The file ceiling of one census. A store with more partitions is read newest-first, not in part. */
export const MAX_CENSUS_FILES = 4096;

/**
 * How often the **in-process** pass hands the event loop back.
 *
 * In worker mode this pacing is pointless (nothing interactive shares the thread) and the pass runs
 * flat out, so the yield counter is the only difference between the two modes — and it is not part of
 * any published payload, which is what makes the two modes byte-identical (`phase-01` X14).
 */
export const IN_PROCESS_YIELD_INTERVAL_FILES = 25;

/** The three frozen bounds, as one injectable object. */
export interface PassLimits {
  budgetMs: number;
  maxBytes: number;
  maxFiles: number;
}

/** The production bounds. Tests inject smaller ones; production never changes these. */
export const PASS_LIMITS: PassLimits = {
  budgetMs: PASS_BUDGET_MS,
  maxBytes: MAX_CENSUS_BYTES,
  maxFiles: MAX_CENSUS_FILES,
};

/**
 * The population predicate (`phase-01:65`).
 *
 * It is `includes`, not `endsWith`, on purpose: the store's own quarantine rename
 * (`<partition>.jsonl.quarantine-<stamp>`, `invocation-ledger.ts:265-269`) and its temp writes
 * (`<partition>.jsonl.tmp-…`) must both be censused. A reader that re-filtered with `endsWith`
 * would silently drop every quarantined partition — and quarantined partitions are exactly where
 * the frames that need naming live (`phase-02`: row P1).
 */
export const JSONL_NAME_MARKER = '.jsonl';

/** Quarantine-rename marker; a name-derived label, never an inference about admission. */
export const QUARANTINE_NAME_MARKER = '.jsonl.quarantine-';

/** Temp-write marker. */
export const TEMP_NAME_MARKER = '.jsonl.tmp-';

/** The identity fields a persisted frame must carry, in the order the ledger's guard names them. */
export const REQUIRED_IDENTITY_FIELDS = ['id', 'idempotencyKey', 'attachmentId'] as const;

/** The `formatVersion` this reader understands. A future version is named residue, never admitted. */
export const SUPPORTED_FORMAT_VERSION = 1;

/**
 * The composite identity's internal separator.
 *
 * `\u0000` cannot occur in a JSON string value, so the concatenation is injective: two distinct
 * `(attachmentId, idempotencyKey)` pairs can never collide into one key. It is also the byte a
 * `JSON.stringify` of a valid pair can never contain, which is why a key is always safe to use as a
 * `Set` member and never needs escaping.
 */
export const COMPOSITE_KEY_SEPARATOR = '\u0000';

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** True when a filesystem error is "the entry is not there" rather than "the store is unusable". */
function isMissingEntryError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** `sha256` of a buffer, hex. */
function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * The **separator-free** display label of a store directory.
 *
 * Returns the final path segment only, and `null` when there is no path at all. This is the shape
 * `affected[]` is allowed to carry: it names the store without publishing the operator's machine
 * layout, and it contains no `/`, `\` or drive letter, which is exactly what the payload gate rejects
 * (`phase-01:203`). Together with the census having no directory field at all, this is the only
 * spelling of "where the store is" that ever crosses a process boundary.
 */
export function storeDisplayLabel(dir: string | null | undefined): string | null {
  if (typeof dir !== 'string' || dir.trim().length === 0) return null;
  const trimmed = dir.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return null;
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1];
  if (typeof last !== 'string' || last.length === 0) return null;
  // A drive root is the one final segment that *is* a drive letter (`C:\`, `C:/`). It names no store,
  // and the payload rule bans a drive letter exactly as it bans a separator, so the label is absent
  // rather than `C:`. A trailing separator never reaches here with an empty segment, because it is
  // stripped above — `split('/').pop()` on `'…/invocations/'` would have returned `''`.
  return /^[A-Za-z]:$/.test(last) ? null : last;
}

/**
 * The bucket a directory entry name belongs to (`phase-01:27-36`).
 *
 * The population predicate is the *wide* one — a name merely containing `.jsonl` — and the buckets
 * partition that population, so `fileCount === jsonl + quarantine + temp + other` is a tautology of
 * this function rather than an assertion. `other` is the residual: a name inside the population that
 * is neither a partition (`endsWith('.jsonl')`) nor one of the writer's two artifact shapes
 * (`a.jsonl.bak`, `phase-01:34`), and it is read like any other file because frame identity comes from
 * `frame.attachmentId`, never from a file name (`phase-01:38`).
 *
 * The two artifact markers are tested first. A hypothetical name carrying both a marker and the
 * `.jsonl` suffix (`.jsonl.quarantine-x.jsonl`) is therefore a quarantine artifact rather than a
 * partition: the tautology holds under either precedence, and naming the artifact is the reading that
 * keeps {@link quarantineMargin} from silently excluding a quarantined file.
 */
export function classifyBucket(name: string): CensusBucket {
  if (name.includes(QUARANTINE_NAME_MARKER)) return CensusBucket.QUARANTINE;
  if (name.includes(TEMP_NAME_MARKER)) return CensusBucket.TEMP;
  if (name.endsWith(JSONL_NAME_MARKER)) return CensusBucket.JSONL;
  return CensusBucket.OTHER;
}

/** Serialises an instant as an ISO string, or `null` when it is not a usable instant. */
function isoOrNull(ms: number | null): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Parses an instant to epoch milliseconds, or `null` when the value is not a usable instant. */
function parseInstantMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Nearest-rank percentile over an already-sorted ascending sample (`phase-03:123`).
 *
 * `p` is a percentage; rank `ceil(p/100 * n)`, clamped into `[1, n]`, then read as a 1-based index.
 * A sample of one returns that one value for both p50 and p95: an honest answer for a single
 * observation, and the reason `count` is published beside the percentiles.
 */
function nearestRank(sortedAscending: readonly number[], p: number): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
  const value = sortedAscending[rank - 1];
  return typeof value === 'number' ? value : null;
}

/**
 * A latency sample, or `null` when there is nothing to sample.
 *
 * `count === 0` never becomes `{count: 0, p50Ms: 0, p95Ms: 0}`: zero milliseconds is a measurement a
 * reader would believe, and "no measurement" is not that (`phase-03:123`, `:141`).
 */
export function buildLatencySample(values: readonly number[]): LatencySample | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const p50 = nearestRank(sorted, 50);
  const p95 = nearestRank(sorted, 95);
  if (p50 === null || p95 === null) return null;
  return { count: sorted.length, p50Ms: p50, p95Ms: p95 };
}

/**
 * A histogram object whose keys are sorted, so two equal folds serialise byte-identically.
 *
 * This is the **publication boundary**, and it is where a persisted string stops being a key. A `state`
 * or an `error.code` that does not match {@link HISTOGRAM_TOKEN_PATTERN}, **or** that the shared
 * {@link isLocationShaped} predicate recognises — a `file:` URL is a token by the grammar and a location
 * by the predicate — is published as {@link UNRECOGNIZED_HISTOGRAM_KEY} instead, with its count added
 * to whatever is already under that key: no count and no total moves, and no key can carry a path. Both
 * rules are applied here rather than only at insertion, because this is the one function every
 * published histogram passes through — including the callers that fold hand-built frames.
 */
function sortedHistogram(counts: ReadonlyMap<string, number>): Record<string, number> {
  const collapsed = new Map<string, number>();
  for (const [rawKey, count] of counts) {
    const key = HISTOGRAM_TOKEN_PATTERN.test(rawKey) && !isLocationShaped(rawKey)
      ? rawKey
      : UNRECOGNIZED_HISTOGRAM_KEY;
    collapsed.set(key, (collapsed.get(key) ?? 0) + count);
  }
  const out: Record<string, number> = {};
  for (const key of Array.from(collapsed.keys()).sort()) {
    out[key] = collapsed.get(key) ?? 0;
  }
  return out;
}

/** The frozen read order: newest first, name ascending as the tie-break (`phase-01:117`). */
function byNewestFirst(a: CensusEntry, b: CensusEntry): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The publication order: name ascending, which is the order `censusHash` is computed over. */
function byNameAscending(a: CensusEntry, b: CensusEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Types of the pass
// ---------------------------------------------------------------------------------------------

/** Which thread the pass is running on. It changes pacing and nothing else. */
export type PassMode = 'worker' | 'in-process';

/**
 * Per-file diagnostics the reader computes **independently of the ledger's own reasons**
 * (`phase-02:189`).
 *
 * The ledger quarantines a whole partition for five different reasons, so "quarantined" and
 * "checksum-bad" are different facts and this type keeps them apart. This record is not published: it
 * travels on the pass result so a caller and a test can see what the classifier actually observed.
 */
export interface FileLabels {
  /** The censused window's last byte is `0x0A`, i.e. the file does not end mid-line. */
  trailingNewline: boolean;
  /** `JSON.parse` failures, including a torn tail. */
  parseFailures: number;
  /** Strict checksum mismatches. */
  checksumFailures: number;
  /** Lines failing the structural guard. */
  structuralInvalid: number;
  /** Lines with no usable `checksum` string. */
  noChecksum: number;
  /** Lines whose byte width (`byteLength(text) + 1`) exceeds the frame ceiling. */
  oversizeLine: number;
  /** The file's name marks it as a quarantined partition. */
  quarantineLike: boolean;
  /** The file's name marks it as an in-flight temp write. */
  tempLike: boolean;
}

/** The mandatory incremental sink: one call per admitted frame, in read order (`phase-02:20`). */
export interface FrameSink {
  emit(entry: { frame: InvocationRecord; key: string | null; file: string }): void;
}

/**
 * Test-only injection points. Production passes none of them.
 *
 * They exist because the interception cases — append, truncate, rewrite, vanish — are races that
 * cannot be produced from outside a running pass without racing the pass itself. Every hook is
 * synchronous-ordered with respect to the pass (the reader awaits them, so an async hook is a
 * deterministic suspension point, not a race).
 */
export interface PassHooks {
  /** After the population sweep observed `name`, before its content is read. */
  afterPopulationSweep?(name: string): void | Promise<void>;
  /** After `name`'s content was read, before its post-read stat. */
  afterRead?(name: string): void | Promise<void>;
  /** After `name` was read and its consistency was decided. */
  onFileSettled?(entry: CensusEntry): void;
  /** Every `IN_PROCESS_YIELD_INTERVAL_FILES` files in in-process mode. */
  onYield?(fileIndex: number, name: string): void;
}

/**
 * Options of one stage-B read.
 *
 * `storeDir` is required and is the **only** place the reader learns where the bytes are. The census
 * carries no resolved directory (`phase-01:43`, constraint A: the reader resolves no data root), so
 * there is no field on the published shape that could announce the operator's machine layout — a
 * census that carried one would leak it the moment it was serialized.
 */
export interface FrameReadOptions {
  /** The store directory, injected by the caller. Never stored on the census, never published. */
  storeDir: string;
  /** Monotonic-ish clock in milliseconds. Defaults to `Date.now`. */
  clock?: () => number;
  /** Bounds. Defaults to {@link PASS_LIMITS} and overrides `census.limits`' own values. */
  limits?: Partial<PassLimits>;
  /** Frame byte ceiling. Defaults to the seam's `DEFAULT_MAX_INVOCATION_FRAME_BYTES`. */
  maxFrameBytes?: number;
  /** Pacing mode. Defaults to `in-process`. */
  mode?: PassMode;
  /** Test-only interception points. */
  hooks?: PassHooks;
}

/** What stage B returns: counters, roll-ups and bounded residue — never a frame array. */
export interface PassResult {
  /** Admitted frames, counted. */
  admittedTotal: number;
  /** Bounded residue, aggregated by `(file, class, reason, fields, observedFormatVersion)`. */
  residue: ResidueEntry[];
  /** One entry per file **actually read**, in read order. */
  fileRollups: FileRollup[];
  /** Per-file labels, keyed by the file's name. */
  labels: Record<string, FileLabels>;
  /** Distinct validated composite keys among the admitted frames. */
  distinctComposites: number;
  /** `admittedTotal - distinctComposites`, reported and never added to an admitted count. */
  superseded: number;
  /** Non-`null` when a rewrite was detected inside the window; the payload becomes UNMEASURED. */
  drift: string | null;
}

/** How the pass ended, before the ceiling and drift are folded into a reason code. */
export type PassOutcome =
  | 'COMPLETE'
  | 'NO_DATA_ROOT_RESOLVED'
  | 'DIR_UNREADABLE'
  | 'NO_DATA'
  | 'READ_BUDGET_EXCEEDED'
  | 'CENSUS_DRIFT';

/** The counters of one pass. Every one of them is a measurement, not a constant. */
export interface CensusPassCounters {
  outcome: PassOutcome;
  admittedTotal: number;
  distinctComposites: number;
  superseded: number;
  /** Admitted frames with no usable composite; the fold counts them a second time, independently. */
  keylessFrames: number;
  /** Bytes of file content read. Equal to `Σ census.files[*].size` by construction. */
  bytesRead: number;
  /** Non-blank segments read. Equal to `Σ fileRollups[*].frames`. */
  linesRead: number;
  /** Files selected and attempted. */
  filesRead: number;
  /** `observedFiles - filesRead`, i.e. what a ceiling left unread. */
  filesSkipped: number;
  ceiling: CensusCeiling | null;
  drift: string | null;
  /** In-process yields actually taken; the only difference between the two modes. */
  yields: number;
  labels: Record<string, FileLabels>;
}

/** The full result of {@link runCensusPass}. `census` is `null` for every aborted pass. */
export interface CensusPassResult {
  census: Census | null;
  fileRollups: FileRollup[];
  residue: ResidueEntry[];
  counters: CensusPassCounters;
}

/** One observed directory entry, before anything is read. */
export interface PopulationEntry {
  name: string;
  bucket: CensusBucket;
  size: number;
  mtimeMs: number;
}

/** The four-term counting tautology of the sweep (`phase-01:65-70`). */
export interface CensusBucketCounts {
  files: number;
  jsonl: number;
  quarantine: number;
  temp: number;
  other: number;
}

/** Stage A's result: names, sizes and mtimes, and the memo key derived from exactly those. */
export interface PopulationSweep {
  dir: string;
  /** Matched entries, name-sorted (the read order is applied later, by the reader). */
  entries: PopulationEntry[];
  counts: CensusBucketCounts;
  observedBytes: number;
  observedFiles: number;
  /** `sha256` over `name:size:mtimeMs` lines: "was anything touched", never "what was measured". */
  memoKey: string;
}

/** The composite identity verdict. `key` is never `"undefined\u0000undefined"` (`phase-02`: row I3). */
export type CompositeIdentity =
  | { ok: true; key: string }
  | { ok: false; reason: 'MISSING_IDENTITY_FIELD'; field: 'attachmentId' | 'idempotencyKey' };

/** The classification of one censused line. */
export interface ClassifiedLine {
  class: ResidueClass;
  reason?: ResidueReason;
  /** `STRUCTURAL_INVALID` / `missing-identity` only. */
  fields?: string[];
  /** `STRUCTURAL_INVALID` / `unsupported-format-version` only. */
  observedFormatVersion?: number;
  /** Present on `ADMITTED` only. */
  frame?: InvocationRecord;
  /** Present on `ADMITTED` only; the composite was validated as part of the structural guard. */
  key?: string;
}

/** Context a caller may supply to {@link classifyLine}; every member has a correct default. */
export interface ClassifyLineOptions {
  /**
   * Called only **after** the strict comparison failed. Returns true when the recorded checksum is
   * reproduced by the writer's historical array-slot canonicalization; it selects the diagnostic
   * sub-reason and can never change an admission (`invocation-frame-checksum.ts:68-88`).
   */
  variantMatches?(frame: Omit<InvocationRecord, 'checksum'>): boolean;
  /** True when this line is the last non-blank span of the censused window. */
  lastWindowSpan?: boolean;
  /** True when the censused window's last byte is `0x0A`, i.e. the window does not end mid-line. */
  windowTerminated?: boolean;
}

/** A file's per-name group inside the fold. */
interface NameGroup {
  name: string;
  keys: Set<string>;
  frames: number;
  states: Map<string, number>;
  errors: Map<string, number>;
  latency: number[];
  excludedLatency: number[];
  firstSeenMs: number | null;
  lastSeenMs: number | null;
}

/**
 * The fold's state: counters, bounded sets and bounded histograms.
 *
 * No frame is retained here and no frame array is built. These counters and `groups` are maintained by
 * the same `foldFrame` body, so the identities {@link reconcile} prints hold **by construction**: a
 * wrong number in that body moves both sides of the comparison and the check still passes. They are
 * kept as regression guards — a refactor that stops incrementing a counter, or stops adding a key to
 * its group, fails immediately — and each boolean's falsifiability is asserted against a deliberately
 * inconsistent accumulator in the matrix, never claimed here as independent evidence.
 */
export interface AggregateAccumulator {
  /** Admitted frames folded, superseded repeats included. */
  frames: number;
  /** Every validated composite key the fold saw, including ones that landed on no row. */
  compositeKeys: Set<string>;
  /**
   * Frames whose composite had already been seen. Counted at the frame level, never added to `calls`,
   * and never removed from the row's measurements: the repeat is a second observation of one call, so
   * it still contributes its state, error, window and latency (`phase-02:245`, the sibling fixture's
   * `calls: 2, frames: 3, superseded: 1` row carries three state observations).
   */
  superseded: number;
  /** Frames with no usable composite at all. */
  keylessFrames: number;
  /** Distinct keys that landed on no row (absent/blank `name`). */
  unattributedKeys: number;
  unattributedByReason: { MISSING_IDENTITY_FIELD: number; MISSING_ROW_KEY: number };
  /** The authoritative "this answer is a floor" flag; monotone, only ever set to true. */
  lowerBound: boolean;
  firstSeenMs: number | null;
  lastSeenMs: number | null;
  /** Every excluded latency delta, for the global excluded sample. */
  excludedLatencyAll: number[];
  groups: Map<string, NameGroup>;
}

/** The fold's output. `rows` is sorted by `calls` desc then `name` asc (`phase-03:126`). */
export interface AggregateResult {
  rows: AggregateRow[];
  lowerBound: boolean;
  excludedLatency: LatencySample | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

/** Options of {@link accountStore}. */
export interface AccountStoreOptions {
  /** The store directory itself — resolved by the caller, never by this module (`phase-01:43`). */
  storeDir: string;
  /** The instant the payload describes. Never part of the memo key. */
  asOf: string;
  /**
   * Permit reuse of the in-process memo for a byte-identical population.
   *
   * Both production callers pass `false`: the delivery surface owns the cross-call memo keyed by the
   * same stage-A sweep, and the CLI states a cold read explicitly. The in-process path exists so an
   * in-process caller that does want it does not have to reimplement stage A.
   */
  memo?: boolean;
  mode?: PassMode;
  limits?: Partial<PassLimits>;
  clock?: () => number;
  hooks?: PassHooks;
  maxFrameBytes?: number;
}

/** The one-message protocol the delivery surface's worker spawn speaks (`mcp-dispatch-service.ts:663`). */
export interface McpDispatchWorkerRequest {
  storeDir: string;
  asOf: string;
  mode?: string;
}

// ---------------------------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------------------------

/**
 * The store directory could not be enumerated.
 *
 * Two different facts share this error because the closed UNMEASURED reason set has one I/O member:
 * `NO_DATA_ROOT_RESOLVED` when the path does not exist (`ENOENT`) — the resolved root is simply not
 * there — and `DIR_UNREADABLE` for every other failure, including an unreadable individual file
 * (`EACCES`, `EPERM`, `ENOTDIR`, `EIO`, …). A per-file reason would need a new closed member, and
 * this phase adds none: an I/O failure that is not "the file is gone" fails **closed**, because a
 * measurement that silently skips a file it could not open is a lie about the population.
 */
export class CensusDirectoryUnreadableError extends Error {
  readonly reasonCode: UnmeasuredReason;
  readonly target: string;
  readonly errnoCode: string | null;

  constructor(reasonCode: UnmeasuredReason, target: string, cause: unknown) {
    const errnoCode = typeof cause === 'object' && cause !== null
      ? ((cause as { code?: unknown }).code as string | undefined) ?? null
      : null;
    super(
      reasonCode === UnmeasuredReason.NO_DATA_ROOT_RESOLVED
        ? 'the store directory does not exist'
        : `the store could not be read${errnoCode === null ? '' : ` (${errnoCode})`}`,
    );
    this.name = 'CensusDirectoryUnreadableError';
    this.reasonCode = reasonCode;
    this.target = target;
    this.errnoCode = errnoCode;
  }
}

/**
 * The pass exceeded {@link PASS_BUDGET_MS}.
 *
 * Thrown rather than returned so that an aborted pass cannot be mistaken for a short one: the caller
 * gets no census at all and must publish `READ_BUDGET_EXCEEDED` with `census: null` and no rows
 * (`phase-01:111`, `phase-03:129`).
 */
export class CensusBudgetExpiredError extends Error {
  readonly elapsedMs: number;

  constructor(elapsedMs: number) {
    super(`census exceeded its ${PASS_BUDGET_MS}ms budget after ${elapsedMs}ms`);
    this.name = 'CensusBudgetExpiredError';
    this.elapsedMs = elapsedMs;
  }
}

// ---------------------------------------------------------------------------------------------
// Stage A — the population sweep
// ---------------------------------------------------------------------------------------------

/**
 * Stage A: one `readdir` and one `stat` per entry, and **no content read** (`phase-01:104`).
 *
 * Entries are returned name-sorted so the sweep is deterministic; the reader applies the frozen
 * `mtimeMs`-descending read order itself, because that order is a property of the read and not of the
 * observation.
 *
 * Throws {@link CensusDirectoryUnreadableError} when the directory cannot be enumerated.
 */
export function runPopulationSweep(dir: string): PopulationSweep {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    throw new CensusDirectoryUnreadableError(
      isMissingEntryError(err) ? UnmeasuredReason.NO_DATA_ROOT_RESOLVED : UnmeasuredReason.DIR_UNREADABLE,
      dir,
      err,
    );
  }

  const entries: PopulationEntry[] = [];
  const counts: CensusBucketCounts = { files: 0, jsonl: 0, quarantine: 0, temp: 0, other: 0 };
  let observedBytes = 0;

  for (const name of names.slice().sort()) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch (err) {
      if (isMissingEntryError(err)) continue;
      throw new CensusDirectoryUnreadableError(UnmeasuredReason.DIR_UNREADABLE, full, err);
    }
    if (!stat.isFile()) continue;
    if (!name.includes(JSONL_NAME_MARKER)) continue;

    const bucket = classifyBucket(name);
    entries.push({ name, bucket, size: stat.size, mtimeMs: stat.mtimeMs });
    counts.files += 1;
    observedBytes += stat.size;
    if (bucket === CensusBucket.JSONL) counts.jsonl += 1;
    else if (bucket === CensusBucket.QUARANTINE) counts.quarantine += 1;
    else if (bucket === CensusBucket.TEMP) counts.temp += 1;
    else counts.other += 1;
  }

  return {
    dir,
    entries,
    counts,
    observedBytes,
    observedFiles: entries.length,
    memoKey: computePopulationMemoKey(entries),
  };
}

/**
 * The memo key of a population: `sha256` over `name:size:mtimeMs` lines.
 *
 * It answers "was anything touched", which is a different question from `censusHash`'s "what content
 * was measured" — so `mtimeMs` is in this key and deliberately not in that hash (`phase-01:96`). The
 * delivery surface computes the same key independently on the main thread before deciding whether to
 * spawn the worker; if the two ever disagreed, the only consequence is a memo miss.
 */
export function computePopulationMemoKey(entries: readonly PopulationEntry[]): string {
  const lines = entries.map((entry) => `${entry.name}:${entry.size}:${entry.mtimeMs}`);
  lines.sort();
  return sha256Hex(Buffer.from(lines.join('\n'), 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// The composite identity (`phase-02`: the guard)
// ---------------------------------------------------------------------------------------------

/**
 * The composite identity of an admitted frame: `(attachmentId, idempotencyKey)`.
 *
 * ## Why the raw values are used and the guard is a non-blank test
 *
 * The key is built from the **untrimmed** values, so it is exactly the pair the ledger wrote, and the
 * guard rejects only a value that carries no information at all — a non-string, an empty string, or
 * whitespace. The two are not in tension: the guard is not a normalization (nothing is trimmed,
 * lowercased or reordered before keying), it is the line between "this field identifies something"
 * and "this field is blank", and `"   "` is blank (`phase-02`: row U7).
 *
 * `frame.id` is never consulted: a frame's row identity is the composite, not the record id
 * (`phase-03:138`), because compaction rewrites `id` while preserving `(attachmentId,
 * idempotencyKey)`.
 */
export function compositeIdentity(frame: {
  attachmentId?: unknown;
  idempotencyKey?: unknown;
}): CompositeIdentity {
  const attachmentId = frame.attachmentId;
  const idempotencyKey = frame.idempotencyKey;
  if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
    return { ok: false, reason: 'MISSING_IDENTITY_FIELD', field: 'attachmentId' };
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    return { ok: false, reason: 'MISSING_IDENTITY_FIELD', field: 'idempotencyKey' };
  }
  return { ok: true, key: `${attachmentId}${COMPOSITE_KEY_SEPARATOR}${idempotencyKey}` };
}

// ---------------------------------------------------------------------------------------------
// Stage B — the line classifier
// ---------------------------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classify **one** censused line, in the frozen order (`phase-01:165`):
 *
 * byte-offset boundary → `JSON.parse` → structural → checksum presence → strict checksum → `ADMITTED`.
 *
 * The byte-offset step has already happened by the time a line reaches here: the caller clips the
 * window at the censused bound and hands over the classification of what remains (the clipped segment
 * is `TORN_TAIL`, the bytes past the bound are named `POST_CENSUS_APPEND` and are never parsed,
 * hashed or admitted).
 *
 * Two orderings in here are load-bearing rather than stylistic:
 *
 * - **Structural before checksum.** A `formatVersion: 2` line whose checksum is perfectly valid must
 *   not be admitted and counted as a real dispatch (`phase-01:158`).
 * - **Strict before the variant.** The null-array variant is a *sub-reason of an already-failed
 *   line*. Frames whose arrays genuinely contain `null` pass strict and fail the variant; normalizing
 *   before hashing would flip those valid frames to `CHECKSUM_MISMATCH`
 *   (`invocation-frame-checksum.ts:78-83`).
 */
export function classifyLine(text: string, options: ClassifyLineOptions = {}): ClassifiedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A parse failure is only a *torn tail* when the window itself ends mid-line at the last
    // non-blank span: the bytes are a prefix of a frame, not a malformed one.
    if (options.lastWindowSpan === true && options.windowTerminated !== true) {
      return { class: ResidueClass.TORN_TAIL };
    }
    return { class: ResidueClass.UNPARSEABLE, reason: UNPARSEABLE_REASON };
  }

  if (!isPlainRecord(parsed)) {
    // `null`, a number, an array or a bare string: named residue, so the frames after it are still
    // classified. The ledger throws on this line and quarantines the whole partition
    // (`invocation-ledger.ts:246-249`); the reader must not.
    return {
      class: ResidueClass.STRUCTURAL_INVALID,
      reason: StructuralInvalidReason.MISSING_IDENTITY,
      fields: [...REQUIRED_IDENTITY_FIELDS],
    };
  }

  const missingFields = REQUIRED_IDENTITY_FIELDS.filter((field) => {
    const value = parsed[field];
    return typeof value !== 'string' || value.length === 0;
  });
  if (missingFields.length > 0) {
    return {
      class: ResidueClass.STRUCTURAL_INVALID,
      reason: StructuralInvalidReason.MISSING_IDENTITY,
      fields: missingFields,
    };
  }

  if (parsed.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    const observed = parsed.formatVersion;
    // An absent version is named `unsupported` with **no** observed value rather than with a
    // fabricated number: `NaN` serialises to `null` and would read as a version that does not exist.
    if (typeof observed === 'number' && Number.isFinite(observed)) {
      return {
        class: ResidueClass.STRUCTURAL_INVALID,
        reason: StructuralInvalidReason.UNSUPPORTED_FORMAT_VERSION,
        observedFormatVersion: observed,
      };
    }
    return {
      class: ResidueClass.STRUCTURAL_INVALID,
      reason: StructuralInvalidReason.UNSUPPORTED_FORMAT_VERSION,
    };
  }

  const checksum = parsed.checksum;
  if (typeof checksum !== 'string' || checksum.length === 0) {
    return { class: ResidueClass.RESIDUE_NO_CHECKSUM };
  }

  const frame = parsed as unknown as InvocationRecord;
  const body = { ...(parsed as Record<string, unknown>) } as Omit<InvocationRecord, 'checksum'>;
  delete (body as Record<string, unknown>).checksum;

  if (computeFrameChecksum(body) === checksum) {
    const identity = compositeIdentity(parsed);
    // The structural guard above already required both identity fields to be non-blank strings, so
    // this is an invariant of the classifier rather than a possibility. It is still checked, because
    // a key is only ever attached to an admitted frame and `undefined\u0000undefined` must be
    // unconstructible (row I3).
    if (!identity.ok) {
      return {
        class: ResidueClass.STRUCTURAL_INVALID,
        reason: StructuralInvalidReason.MISSING_IDENTITY,
        fields: [identity.field],
      };
    }
    return { class: ResidueClass.ADMITTED, frame, key: identity.key };
  }

  const variantMatches = options.variantMatches
    ?? ((candidate: Omit<InvocationRecord, 'checksum'>) => computeFrameChecksumNullArrayVariant(candidate) === checksum);
  return {
    class: ResidueClass.CHECKSUM_MISMATCH,
    reason: variantMatches(body)
      ? ChecksumMismatchReason.WRITER_CANONICALIZATION_ARRAY_SLOT
      : ChecksumMismatchReason.UNEXPLAINED,
  };
}

// ---------------------------------------------------------------------------------------------
// Stage B — the reader
// ---------------------------------------------------------------------------------------------

/** A non-blank, window-clipped line span. */
interface WindowSpan {
  start: number;
  /** Exclusive byte offset, never past the censused bound. */
  end: number;
  text: string;
  /** True when the span ended at a `0x0A` **inside** the window. */
  terminated: boolean;
}

/**
 * The non-blank spans of the censused window.
 *
 * `frameLineSpans` decides every boundary (one definition of "what a line is" for the ledger, the
 * splitter and this reader). Two adjustments are applied here and nowhere else:
 *
 * - the window is clipped at the censused bound, so a span that the `size + 1` probe byte completed is
 *   *unterminated* and its text stops before the bound — the probe byte is observed and never content;
 * - a `0x0D` that sits immediately before the censused bound (or at the end of an unterminated window)
 *   is removed, because it can only be the first half of a CRLF pair whose `0x0A` was not read, and no
 *   frame's JSON text ever ends in a bare CR.
 */
function windowSpansOf(readBuffer: Buffer, censusedSize: number): WindowSpan[] {
  const spans: FrameLineSpan[] = frameLineSpans(readBuffer);
  const windowSpans: WindowSpan[] = [];

  for (const span of spans) {
    if (span.start >= censusedSize) break;
    const clipped = span.end > censusedSize;
    const end = clipped ? censusedSize : span.end;
    const text = clipped ? readBuffer.toString('utf8', span.start, end) : span.text;
    windowSpans.push({ start: span.start, end, text, terminated: clipped ? false : span.terminated });
  }

  const last = windowSpans[windowSpans.length - 1];
  if (last && last.text.endsWith('\r')) {
    last.text = last.text.slice(0, -1);
    last.end -= 1;
  }

  return windowSpans.filter((span) => span.text.trim().length > 0);
}

function emptyFileLabels(quarantineLike: boolean, tempLike: boolean): FileLabels {
  return {
    trailingNewline: false,
    parseFailures: 0,
    checksumFailures: 0,
    structuralInvalid: 0,
    noChecksum: 0,
    oversizeLine: 0,
    quarantineLike,
    tempLike,
  };
}

/** Bounded residue accumulation: one row per `(file, class, reason, fields, observedVersion)`. */
class ResidueAccumulator {
  private readonly index = new Map<string, ResidueEntry>();
  public readonly entries: ResidueEntry[] = [];

  public add(entry: ResidueEntry): void {
    const key = [
      entry.file,
      entry.class,
      entry.reason ?? '',
      entry.fields === undefined ? '' : entry.fields.join(','),
      entry.observedFormatVersion === undefined ? '' : String(entry.observedFormatVersion),
    ].join('\u0000');
    const existing = this.index.get(key);
    if (existing) {
      existing.count += entry.count;
      return;
    }
    this.index.set(key, entry);
    this.entries.push(entry);
  }
}

/**
 * Stage B: read every file the census selected, classify every line, and stream every admitted frame
 * to `sink` exactly once (`phase-02:20`, `:187`, `:199`).
 *
 * The reader owns:
 *
 * - the frozen read order (`mtimeMs` desc, `name` asc);
 * - the budget check **before** the ceiling checks (`phase-03:129`: a budget expiry discards the
 *   partial fold, an input ceiling keeps it);
 * - the `size + 1` window and its boundary rule;
 * - the post-read checkpoint and its five consistency verdicts;
 * - `fileRollups`, asserted to close (`frames === admitted + namedInvalid`) before returning, because
 *   a roll-up that does not close is a classifier defect and never a `false` to report;
 * - `drift`, which the caller turns into `UNMEASURED` / `CENSUS_DRIFT`.
 *
 * It mutates the census it is handed: `files` becomes the read set (the skipped tail is dropped), and
 * each entry's `size`/`sha256`/`lineCount`/`mtimeMs`/`consistency` become what this pass measured.
 * That mutation is the point — a census entry that still carried its pre-read size would be a second,
 * stale answer to a question this pass has already answered.
 *
 * Throws {@link CensusBudgetExpiredError} on budget expiry and
 * {@link CensusDirectoryUnreadableError} on an I/O failure that is not a vanished file.
 */
export async function readAdmittedFrames(
  census: Census,
  sink: FrameSink,
  options: FrameReadOptions,
): Promise<PassResult> {
  const clock = options.clock ?? (() => Date.now());
  const limits: PassLimits = {
    budgetMs: options.limits?.budgetMs ?? census.limits.budgetMs,
    maxBytes: options.limits?.maxBytes ?? census.limits.maxBytes,
    maxFiles: options.limits?.maxFiles ?? census.limits.maxFiles,
  };
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_INVOCATION_FRAME_BYTES;
  const mode: PassMode = options.mode ?? 'in-process';
  const hooks = options.hooks ?? {};
  const startedAt = clock();

  const ordered = census.files.slice().sort(byNewestFirst);
  const selected: CensusEntry[] = [];
  const rollups: FileRollup[] = [];
  const labels: Record<string, FileLabels> = {};
  const residue = new ResidueAccumulator();
  const distinctComposites = new Set<string>();

  let admittedTotal = 0;
  let bytesRead = 0;
  let linesRead = 0;
  let filesRead = 0;
  let yields = 0;
  let ceiling: CensusCeiling | null = null;
  let drift: string | null = null;

  for (const entry of ordered) {
    // Budget first: an expired budget aborts the whole pass, so no partial fold may be published.
    const elapsedMs = clock() - startedAt;
    if (elapsedMs > limits.budgetMs) {
      throw new CensusBudgetExpiredError(elapsedMs);
    }
    if (filesRead >= limits.maxFiles) {
      ceiling = 'MAX_CENSUS_FILES';
      break;
    }
    if (bytesRead + entry.size > limits.maxBytes) {
      ceiling = 'MAX_CENSUS_BYTES';
      break;
    }

    if (hooks.afterPopulationSweep) await hooks.afterPopulationSweep(entry.name);

    const censusedSize = entry.size;
    const censusedMtimeMs = entry.mtimeMs;
    const quarantineLike = entry.bucket === CensusBucket.QUARANTINE;
    const tempLike = entry.bucket === CensusBucket.TEMP;
    const label = emptyFileLabels(quarantineLike, tempLike);
    const rollup: FileRollup = {
      file: entry.name,
      quarantineLike,
      tempLike,
      frames: 0,
      admitted: 0,
      namedInvalid: 0,
    };
    const filePath = path.join(options.storeDir, entry.name);

    let readBuffer: Buffer | null = null;
    let bytesReadHere = 0;
    try {
      const handle = await fs.promises.open(filePath, 'r');
      try {
        // `size + 1`: one byte past the censused window, so "the file grew" is observable without
        // re-reading it. The probe byte is never parsed, never hashed and never admitted.
        readBuffer = Buffer.allocUnsafe(censusedSize + 1);
        const read = await handle.read(readBuffer, 0, censusedSize + 1, 0);
        bytesReadHere = read.bytesRead;
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (!isMissingEntryError(err)) {
        throw new CensusDirectoryUnreadableError(UnmeasuredReason.DIR_UNREADABLE, filePath, err);
      }
    }

    if (hooks.afterRead) await hooks.afterRead(entry.name);

    if (readBuffer === null) {
      // The file was selected and is gone before a single byte was read: the loss is the file itself,
      // so the entry accounts for zero bytes and the pass says `VANISHED` instead of inventing a
      // measurement or silently shrinking the population.
      entry.size = 0;
      entry.sha256 = sha256Hex(Buffer.alloc(0));
      entry.lineCount = 0;
      entry.consistency = 'vanished';
      residue.add({
        file: entry.name,
        class: ResidueClass.VANISHED,
        count: 1,
        firstLine: 0,
        firstByteOffset: 0,
      });
      selected.push(entry);
      filesRead += 1;
      labels[entry.name] = label;
      hooks.onFileSettled?.(entry);
      continue;
    }

    const windowLength = Math.min(bytesReadHere, censusedSize);
    const window = readBuffer.subarray(0, windowLength);
    const sha256 = sha256Hex(window);
    const spans = windowSpansOf(readBuffer, windowLength);
    const windowTerminated = windowLength > 0 && readBuffer[windowLength - 1] === 0x0a;
    label.trailingNewline = windowTerminated;

    entry.size = windowLength;
    entry.sha256 = sha256;
    entry.lineCount = spans.length;
    bytesRead += windowLength;
    linesRead += spans.length;
    filesRead += 1;

    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index];
      if (span === undefined) continue;
      const isLast = index === spans.length - 1;
      if (Buffer.byteLength(span.text, 'utf8') + 1 > maxFrameBytes) {
        label.oversizeLine += 1;
      }
      const classified = classifyLine(span.text, {
        lastWindowSpan: isLast,
        windowTerminated,
      });
      rollup.frames += 1;

      if (classified.class === ResidueClass.ADMITTED && classified.frame !== undefined) {
        rollup.admitted += 1;
        admittedTotal += 1;
        const key = classified.key ?? null;
        if (key !== null) distinctComposites.add(key);
        sink.emit({ frame: classified.frame, key, file: entry.name });
        continue;
      }

      // `frames === admitted + namedInvalid` can only close if every non-admitted line falls in one of
      // the five *named-invalid* classes. The three short-read classes are file-level facts and never
      // line verdicts, so the assertion below the loop doubles as the proof that a line never reached
      // one of them.
      if (NAMED_INVALID_RESIDUE_CLASSES.some((namedClass) => namedClass === classified.class)) {
        rollup.namedInvalid += 1;
      }
      if (classified.class === ResidueClass.UNPARSEABLE || classified.class === ResidueClass.TORN_TAIL) {
        label.parseFailures += 1;
      } else if (classified.class === ResidueClass.CHECKSUM_MISMATCH) {
        label.checksumFailures += 1;
      } else if (classified.class === ResidueClass.STRUCTURAL_INVALID) {
        label.structuralInvalid += 1;
      } else if (classified.class === ResidueClass.RESIDUE_NO_CHECKSUM) {
        label.noChecksum += 1;
      }
      residue.add({
        file: entry.name,
        class: classified.class,
        reason: classified.reason,
        fields: classified.fields,
        observedFormatVersion: classified.observedFormatVersion,
        count: 1,
        firstLine: index,
        firstByteOffset: span.start,
      });
    }

    // The post-read checkpoint (`phase-02:118-139`). A file that shrank is a short read; a file that
    // grew is a post-census append; a file rewritten in place is re-read **once** and only drift if its
    // bytes actually differ.
    let consistency: CensusConsistency;
    try {
      const after = await fs.promises.stat(filePath);
      // The published `mtimeMs` is the **post-read** observation: the window this entry describes is
      // the file as it stands now, and the sweep's earlier stamp would be a stale second answer.
      entry.mtimeMs = after.mtimeMs;
      if (after.size > censusedSize) {
        consistency = 'post-census-append';
        residue.add({
          file: entry.name,
          class: ResidueClass.POST_CENSUS_APPEND,
          count: 1,
          firstLine: spans.length,
          firstByteOffset: censusedSize,
          bytes: after.size - censusedSize,
        });
      } else if (after.size < censusedSize) {
        consistency = 'post-census-truncate';
        residue.add({
          file: entry.name,
          class: ResidueClass.POST_CENSUS_TRUNCATE,
          count: 1,
          firstLine: spans.length,
          firstByteOffset: windowLength,
        });
      } else if (after.mtimeMs !== censusedMtimeMs) {
        const reread = await rereadWindow(filePath, windowLength);
        if (reread === null) {
          consistency = 'clean';
          drift = `${entry.name}: the censused window could not be re-read at its recorded length`;
        } else if (reread !== sha256) {
          consistency = 'clean';
          drift = `${entry.name}: censused ${sha256.slice(0, 12)} != re-read ${reread.slice(0, 12)}`;
        } else {
          consistency = 'rewritten-identical';
        }
      } else {
        consistency = 'clean';
      }
    } catch (err) {
      if (!isMissingEntryError(err)) {
        throw new CensusDirectoryUnreadableError(UnmeasuredReason.DIR_UNREADABLE, filePath, err);
      }
      // The bytes were read and verified before the file disappeared: they stay measured, and the
      // disappearance is disclosed rather than retracted.
      consistency = 'vanished';
      residue.add({
        file: entry.name,
        class: ResidueClass.VANISHED,
        count: 1,
        firstLine: 0,
        firstByteOffset: 0,
      });
    }

    entry.consistency = consistency;
    if (rollup.frames !== rollup.admitted + rollup.namedInvalid) {
      throw new Error(
        `mcp-dispatch accounting: file roll-up for '${entry.name}' does not close `
        + `(frames ${rollup.frames} != admitted ${rollup.admitted} + named-invalid ${rollup.namedInvalid})`,
      );
    }
    rollups.push(rollup);
    selected.push(entry);
    labels[entry.name] = label;
    hooks.onFileSettled?.(entry);

    if (mode === 'in-process' && filesRead % IN_PROCESS_YIELD_INTERVAL_FILES === 0) {
      yields += 1;
      hooks.onYield?.(filesRead, entry.name);
      // A real suspension point: the reader is async, so the event loop drains here and an
      // interactive main thread is never held for the whole pass.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  census.files = selected;
  census.limits.filesRead = filesRead;
  census.limits.filesSkipped = Math.max(0, census.limits.observedFiles - filesRead);
  census.limits.ceiling = ceiling;

  return {
    admittedTotal,
    residue: residue.entries,
    fileRollups: rollups,
    labels,
    distinctComposites: distinctComposites.size,
    superseded: admittedTotal - distinctComposites.size,
    drift,
  };
}

/** Re-read exactly the censused window, for the change-detection branch of the checkpoint. */
async function rereadWindow(filePath: string, windowLength: number): Promise<string | null> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(windowLength);
    const read = await handle.read(buf, 0, windowLength, 0);
    if (read.bytesRead !== windowLength) return null;
    return sha256Hex(buf.subarray(0, read.bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * The stage-B core under the name `phase-01`'s checklist uses for it.
 *
 * One function, two names: the checklist asserts that `readAdmittedFrames(` appears at exactly one
 * call site outside the pass core, and a second spelling would make that assertion meaningless.
 */
export const readFramesIncremental = readAdmittedFrames;

// ---------------------------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------------------------

/**
 * The whole two-stage pass over one store directory (`phase-01:294`).
 *
 * Returns the finalized census plus what stage B measured. `census` is `null` for exactly three
 * situations, all of them "there is no census to publish": the directory could not be enumerated, the
 * budget expired, or the population had nothing to read. A truncated but non-degenerate read returns a
 * real census whose `limits` say precisely how much of the population it covers.
 */
export async function runCensusPass(
  dir: string,
  asOf: string,
  options: {
    sink?: FrameSink;
    mode?: PassMode;
    clock?: () => number;
    limits?: Partial<PassLimits>;
    hooks?: PassHooks;
    maxFrameBytes?: number;
  } = {},
): Promise<CensusPassResult> {
  const clock = options.clock ?? (() => Date.now());
  const startedAt = clock();
  const sink = options.sink ?? { emit: () => undefined };
  const limits: PassLimits = {
    budgetMs: options.limits?.budgetMs ?? PASS_BUDGET_MS,
    maxBytes: options.limits?.maxBytes ?? MAX_CENSUS_BYTES,
    maxFiles: options.limits?.maxFiles ?? MAX_CENSUS_FILES,
  };
  const baseCounters = (): CensusPassCounters => ({
    outcome: 'COMPLETE',
    admittedTotal: 0,
    distinctComposites: 0,
    superseded: 0,
    keylessFrames: 0,
    bytesRead: 0,
    linesRead: 0,
    filesRead: 0,
    filesSkipped: 0,
    ceiling: null,
    drift: null,
    yields: 0,
    labels: {},
  });

  let sweep: PopulationSweep;
  try {
    sweep = runPopulationSweep(dir);
  } catch (err) {
    if (err instanceof CensusDirectoryUnreadableError) {
      const counters = baseCounters();
      counters.outcome = err.reasonCode === UnmeasuredReason.NO_DATA_ROOT_RESOLVED
        ? 'NO_DATA_ROOT_RESOLVED'
        : 'DIR_UNREADABLE';
      return { census: null, fileRollups: [], residue: [], counters };
    }
    throw err;
  }

  if (sweep.observedFiles === 0) {
    const census = buildEmptyCensus(sweep, asOf, limits);
    const counters = baseCounters();
    counters.outcome = 'NO_DATA';
    return { census, fileRollups: [], residue: [], counters };
  }

  const census: Census = {
    asOf,
    // Entries enter stage B carrying the sweep's observation; the reader replaces every field it
    // measured and drops the ones a ceiling left unread (`phase-01:53-56`). Field order matches the
    // published fixture so a serialized census is comparable key-for-key.
    files: sweep.entries.map((entry) => ({
      name: entry.name,
      bucket: entry.bucket,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      lineCount: 0,
      sha256: '',
      consistency: 'clean' as CensusConsistency,
    })),
    fileCount: sweep.counts.files,
    jsonlCount: sweep.counts.jsonl,
    quarantineCount: sweep.counts.quarantine,
    tempCount: sweep.counts.temp,
    otherCount: sweep.counts.other,
    totalBytes: sweep.observedBytes,
    censusHash: null,
    limits: {
      budgetMs: limits.budgetMs,
      maxBytes: limits.maxBytes,
      maxFiles: limits.maxFiles,
      observedBytes: sweep.observedBytes,
      observedFiles: sweep.observedFiles,
      filesRead: 0,
      filesSkipped: 0,
      ceiling: null,
      windowNewestMtimeMs: null,
      windowOldestMtimeMs: null,
      elapsedMs: 0,
      outcome: 'COMPLETE',
    },
  };

  // The two counters the frozen seven-member pass result does not carry are measured here, from the
  // sink and the hooks the reader actually called — never recomputed from a formula after the fact.
  let keylessFrames = 0;
  let yields = 0;
  const countingSink: FrameSink = {
    emit: (entry) => {
      if (entry.key === null) keylessFrames += 1;
      sink.emit(entry);
    },
  };
  const callerHooks = options.hooks;
  const countingHooks: PassHooks = {
    afterPopulationSweep: callerHooks?.afterPopulationSweep,
    afterRead: callerHooks?.afterRead,
    onFileSettled: callerHooks?.onFileSettled,
    onYield: (fileIndex, name) => {
      yields += 1;
      callerHooks?.onYield?.(fileIndex, name);
    },
  };

  let pass: PassResult;
  try {
    pass = await readAdmittedFrames(census, countingSink, {
      storeDir: dir,
      clock,
      limits,
      mode: options.mode,
      hooks: countingHooks,
      maxFrameBytes: options.maxFrameBytes,
    });
  } catch (err) {
    if (err instanceof CensusBudgetExpiredError) {
      const counters = baseCounters();
      counters.outcome = 'READ_BUDGET_EXCEEDED';
      // The partial fold is discarded with the census: no rows, no totals, no half answer.
      return { census: null, fileRollups: [], residue: [], counters };
    }
    throw err;
  }

  // Window, hash and elapsed time belong to the pass as a whole, so they are settled here, after the
  // read set is final: the census is name-sorted for publication and hashed over exactly what it read.
  let newest: number | null = null;
  let oldest: number | null = null;
  for (const entry of census.files) {
    if (newest === null || entry.mtimeMs > newest) newest = entry.mtimeMs;
    if (oldest === null || entry.mtimeMs < oldest) oldest = entry.mtimeMs;
  }
  census.files = census.files.slice().sort(byNameAscending);
  census.censusHash = census.files.length === 0
    ? null
    : sha256Hex(Buffer.from(
      census.files.map((entry) => `${entry.name}\u0000${entry.size}\u0000${entry.sha256}\n`).join(''),
      'utf8',
    ));
  census.limits.windowNewestMtimeMs = census.files.length === 0 ? null : newest;
  census.limits.windowOldestMtimeMs = census.files.length === 0 ? null : oldest;
  census.limits.elapsedMs = clock() - startedAt;
  census.limits.outcome = census.limits.ceiling === null ? 'COMPLETE' : 'POPULATION_TRUNCATED';

  const counters = baseCounters();
  counters.outcome = pass.drift === null ? 'COMPLETE' : 'CENSUS_DRIFT';
  counters.admittedTotal = pass.admittedTotal;
  counters.distinctComposites = pass.distinctComposites;
  counters.superseded = pass.superseded;
  counters.keylessFrames = keylessFrames;
  counters.bytesRead = census.files.reduce((sum, entry) => sum + entry.size, 0);
  counters.linesRead = pass.fileRollups.reduce((sum, rollup) => sum + rollup.frames, 0);
  counters.filesRead = census.limits.filesRead;
  counters.filesSkipped = census.limits.filesSkipped;
  counters.ceiling = census.limits.ceiling;
  counters.drift = pass.drift;
  counters.yields = yields;
  counters.labels = pass.labels;

  return { census, fileRollups: pass.fileRollups, residue: pass.residue, counters };
}

/** A census of a readable but empty population: measured nothing, and says so (`phase-01:116`). */
function buildEmptyCensus(sweep: PopulationSweep, asOf: string, limits: PassLimits): Census {
  return {
    asOf,
    files: [],
    fileCount: 0,
    jsonlCount: sweep.counts.jsonl,
    quarantineCount: sweep.counts.quarantine,
    tempCount: sweep.counts.temp,
    otherCount: sweep.counts.other,
    totalBytes: 0,
    censusHash: null,
    limits: {
      budgetMs: limits.budgetMs,
      maxBytes: limits.maxBytes,
      maxFiles: limits.maxFiles,
      observedBytes: 0,
      observedFiles: 0,
      filesRead: 0,
      filesSkipped: 0,
      ceiling: null,
      windowNewestMtimeMs: null,
      windowOldestMtimeMs: null,
      elapsedMs: 0,
      outcome: 'COMPLETE',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------------------------

/** A fresh accumulator. The production sink closes over one of these for the whole pass. */
export function emptyAccumulator(): AggregateAccumulator {
  return {
    frames: 0,
    compositeKeys: new Set<string>(),
    superseded: 0,
    keylessFrames: 0,
    unattributedKeys: 0,
    unattributedByReason: { MISSING_IDENTITY_FIELD: 0, MISSING_ROW_KEY: 0 },
    lowerBound: false,
    firstSeenMs: null,
    lastSeenMs: null,
    excludedLatencyAll: [],
    groups: new Map<string, NameGroup>(),
  };
}

/**
 * The latency provenance of a frame (`phase-01:181-186`, `phase-02:48-51`).
 *
 * `unknown` is not an owner-written state: the ledger uses it for a frame whose owner never settled it,
 * so its latency is not a dispatch duration. The exception is a frame the runtime already reconciled —
 * `error.details.reconciledByPid` — which is replay provenance rather than an unsettled owner, and is
 * named as its own population instead of being folded into the same bucket.
 */
export function latencyProvenance(frame: Pick<InvocationRecord, 'state' | 'error'>): LatencyProvenance {
  if (frame.state !== 'unknown') return LatencyProvenance.OWNER_WRITTEN;
  const error = frame.error;
  if (typeof error === 'object' && error !== null) {
    const details = (error as { details?: unknown }).details;
    if (typeof details === 'object' && details !== null
      && (details as { reconciledByPid?: unknown }).reconciledByPid !== undefined) {
      return LatencyProvenance.EXCLUDED_REPLAY_PROVENANCE;
    }
  }
  return LatencyProvenance.EXCLUDED_UNKNOWN_STATE;
}

function groupFor(acc: AggregateAccumulator, name: string): NameGroup {
  const existing = acc.groups.get(name);
  if (existing) return existing;
  const created: NameGroup = {
    name,
    keys: new Set<string>(),
    frames: 0,
    states: new Map<string, number>(),
    errors: new Map<string, number>(),
    latency: [],
    excludedLatency: [],
    firstSeenMs: null,
    lastSeenMs: null,
  };
  acc.groups.set(name, created);
  return created;
}

/** `createdAt`/`settledAt` are persisted as ISO strings; anything unparseable measures nothing. */
function frameLatencyMs(frame: Pick<InvocationRecord, 'createdAt' | 'settledAt'>): number | null {
  const created = parseInstantMs(frame.createdAt);
  const settled = parseInstantMs(frame.settledAt);
  if (created === null || settled === null) return null;
  return settled - created;
}

/**
 * Fold **one** admitted frame. Returns the accumulator, so it is usable as a `reduce` callback.
 *
 * The third argument is compared with `=== true` rather than used as a truthy flag: `Array.prototype
 * .reduce` passes the element index there, and an index of `1` must not silently mean "lower bound".
 *
 * Attribution follows `phase-03:127`: a valid composite whose group has an absent or blank name is
 * **credited to no row** — never folded under `undefined` — and is counted as an unattributed key, so
 * the inflation it would cause is visible in `reconciliation` instead of being attributed to a tool
 * that was never called.
 */
export function foldFrame(
  acc: AggregateAccumulator,
  frame: InvocationRecord,
  lowerBound?: unknown,
): AggregateAccumulator {
  if (lowerBound === true) acc.lowerBound = true;
  acc.frames += 1;

  const identity = compositeIdentity(frame);
  if (!identity.ok) {
    // Admitted, counted, and credited to no composite at all — which is exactly why the frame-level
    // identity carries an explicit keyless term rather than assuming `compositeKeys` covers every
    // frame (`phase-03:34-38`).
    acc.keylessFrames += 1;
    acc.unattributedByReason.MISSING_IDENTITY_FIELD += 1;
    return acc;
  }

  const firstSighting = !acc.compositeKeys.has(identity.key);
  acc.compositeKeys.add(identity.key);
  if (!firstSighting) acc.superseded += 1;

  // A row key is a tool name, and it becomes a JSON **key** in the published payload — the one place a
  // persisted string cannot be sanitised by value. A blank name is already credited nowhere; a
  // location-shaped one is treated identically rather than published as a key, so the leak never
  // reaches `rows[].name` and the anomaly shows up honestly as an uncredited composite.
  const rawName = typeof frame.name === 'string' ? frame.name : '';
  const name = rawName.trim().length > 0 && !isLocationShaped(rawName) ? rawName : null;
  if (name === null) {
    // Admitted and identified, with no row to measure it against: counted once per composite, like
    // `compositeKeys`, so `Σ unattributedByReason === unattributedFrames` stays exact.
    if (firstSighting) {
      acc.unattributedKeys += 1;
      acc.unattributedByReason.MISSING_ROW_KEY += 1;
    }
    return acc;
  }

  const group = groupFor(acc, name);
  group.keys.add(identity.key);
  group.frames += 1;

  const state = typeof frame.state === 'string' ? frame.state : String(frame.state);
  group.states.set(state, (group.states.get(state) ?? 0) + 1);

  const error = frame.error;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    const key = typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN_ERROR';
    group.errors.set(key, (group.errors.get(key) ?? 0) + 1);
  }

  const created = parseInstantMs(frame.createdAt);
  if (created !== null) {
    if (group.firstSeenMs === null || created < group.firstSeenMs) group.firstSeenMs = created;
    if (group.lastSeenMs === null || created > group.lastSeenMs) group.lastSeenMs = created;
    if (acc.firstSeenMs === null || created < acc.firstSeenMs) acc.firstSeenMs = created;
    if (acc.lastSeenMs === null || created > acc.lastSeenMs) acc.lastSeenMs = created;
  }

  const latency = frameLatencyMs(frame);
  if (latency !== null) {
    if (latencyProvenance(frame) === LatencyProvenance.OWNER_WRITTEN) group.latency.push(latency);
    else {
      group.excludedLatency.push(latency);
      acc.excludedLatencyAll.push(latency);
    }
  }

  return acc;
}

/**
 * Turn the accumulator into published rows.
 *
 * Every row carries the accumulator's **authoritative** bound, not the running hint the sink passed
 * per frame: the bound is a property of the pass, and a row that disagreed with `totals.truncation`
 * would be a second, weaker answer to the same question (`phase-03:52`).
 */
export function finalizeAggregate(acc: AggregateAccumulator): AggregateResult {
  const rows: AggregateRow[] = [];
  for (const group of acc.groups.values()) {
    rows.push({
      name: group.name,
      calls: group.keys.size,
      frames: group.frames,
      superseded: group.frames - group.keys.size,
      states: sortedHistogram(group.states),
      errors: sortedHistogram(group.errors),
      latency: buildLatencySample(group.latency),
      excludedLatency: buildLatencySample(group.excludedLatency),
      firstSeen: isoOrNull(group.firstSeenMs),
      lastSeen: isoOrNull(group.lastSeenMs),
      lowerBound: acc.lowerBound,
    });
  }
  rows.sort((a, b) => (b.calls - a.calls) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    rows,
    lowerBound: acc.lowerBound,
    excludedLatency: buildLatencySample(acc.excludedLatencyAll),
    firstSeen: isoOrNull(acc.firstSeenMs),
    lastSeen: isoOrNull(acc.lastSeenMs),
  };
}

/**
 * The test-only convenience form: `finalizeAggregate(frames.reduce(foldFrame, emptyAccumulator()))`.
 *
 * It exists for hand-built frames in a test and has **no call site in `src/`**; the production path
 * folds from the sink and never builds a frame array (`phase-03:148`).
 */
export function aggregateByName(frames: readonly InvocationRecord[], lowerBound = false): AggregateResult {
  const acc = emptyAccumulator();
  if (lowerBound) acc.lowerBound = true;
  for (const frame of frames) foldFrame(acc, frame, lowerBound);
  return finalizeAggregate(acc);
}

// ---------------------------------------------------------------------------------------------
// The quarantine margin and the reconciliation
// ---------------------------------------------------------------------------------------------

/**
 * The mass balance of every quarantined partition that was **read** (`phase-03:44-51`).
 *
 * Derived by summing `fileRollups` and nothing else: no file is opened, no name is re-scanned, and a
 * partition skipped by the input ceiling contributes nothing — so the margin can never claim a frame
 * the pass did not look at. `reasons[]` comes from the same pass's residue rows for those same files
 * and carries closed-enum tokens only.
 */
export function quarantineMargin(
  fileRollups: readonly FileRollup[],
  residue: readonly ResidueEntry[],
): QuarantineMargin {
  const quarantineFiles = new Set<string>();
  let framesPresent = 0;
  let framesAdmitted = 0;
  let framesNamedInvalid = 0;
  for (const rollup of fileRollups) {
    if (!rollup.quarantineLike) continue;
    quarantineFiles.add(rollup.file);
    framesPresent += rollup.frames;
    framesAdmitted += rollup.admitted;
    framesNamedInvalid += rollup.namedInvalid;
  }

  const reasonCounts = new Map<string, { class: NamedResidueClass; reason?: string; count: number }>();
  for (const entry of residue) {
    if (!quarantineFiles.has(entry.file)) continue;
    if (entry.class === ResidueClass.ADMITTED) continue;
    if (!NAMED_INVALID_RESIDUE_CLASSES.includes(entry.class)) continue;
    const key = `${entry.class}\u0000${entry.reason ?? ''}`;
    const existing = reasonCounts.get(key);
    if (existing) {
      existing.count += entry.count;
      continue;
    }
    reasonCounts.set(key, { class: entry.class, reason: entry.reason, count: entry.count });
  }

  const reasons = Array.from(reasonCounts.values()).sort((a, b) => {
    if (a.class !== b.class) return a.class < b.class ? -1 : 1;
    const ar = a.reason ?? '';
    const br = b.reason ?? '';
    return ar < br ? -1 : ar > br ? 1 : 0;
  });

  const breakdown = reasons.map((r) => `${r.class}${r.reason === undefined ? '' : ` ${r.reason}`} ${r.count}`).join(', ');
  const label = `quarantine margin: present ${framesPresent} = admitted ${framesAdmitted} + named-invalid `
    + `${framesNamedInvalid}${breakdown.length === 0 ? '' : ` (${breakdown})`} \u2014 a margin, not a recovery promise`;

  return {
    label,
    files: quarantineFiles.size,
    framesPresent,
    framesAdmitted,
    framesNamedInvalid,
    reasons,
  };
}

/**
 * The reconciliation: one line per counting identity, and three booleans that are cheap regression
 * guards (`phase-03:28-34`, `:128`).
 *
 * What these identities actually are, stated plainly, because the honest answer is weaker than
 * "independent evidence". `holdsKeys` and `holdsFrames` compare terms the same `foldFrame` body
 * maintains, so they hold **by construction** — a wrong number in that body moves both sides and the
 * check still passes. Their value is that a future refactor breaking the construction (a counter that
 * stops being incremented, a key that stops being added to its group) fails immediately. `holdsKeys`
 * additionally goes false on a real store anomaly: one composite observed under two different `name`s
 * lands in two groups, so `Σ rows[*].calls` exceeds the fold's key set and the key-level line prints a
 * genuine imbalance. `holdsMargin` is only reachable with caller-supplied roll-ups, because the reader
 * throws before it can publish an unbalanced one.
 *
 * `unattributedByReason` and `unattributedKeys` are passed through **verbatim** from the fold:
 * `MISSING_IDENTITY_FIELD` counts keyless frames as they are folded and `MISSING_ROW_KEY` counts
 * uncredited composites once per composite. `reconcile` renames nothing and re-buckets nothing, so the
 * published split is a partition of `unattributedFrames` (`unattributedKeys + keylessFrames`) rather
 * than a second opinion about it.
 */
export function reconcile(
  acc: AggregateAccumulator,
  residue: readonly ResidueEntry[],
  fileRollups: readonly FileRollup[],
): Reconciliation {
  let classifiedKeys = 0;
  for (const group of acc.groups.values()) classifiedKeys += group.keys.size;

  const margin = quarantineMargin(fileRollups, residue);
  const keylessFrames = acc.keylessFrames;
  const unattributedFrames = acc.unattributedKeys + keylessFrames;
  const holdsKeys = classifiedKeys + acc.unattributedKeys === acc.compositeKeys.size;
  const holdsFrames = acc.frames === acc.compositeKeys.size + acc.superseded + keylessFrames;
  const holdsMargin = margin.framesPresent === margin.framesAdmitted + margin.framesNamedInvalid;

  const lines = [
    'classifiedKeys + unattributedKeys == compositeKeys'
    + `  (${classifiedKeys} + ${acc.unattributedKeys} == ${acc.compositeKeys.size})`,
    'frames == compositeKeys + superseded + keylessFrames'
    + `  (${acc.frames} == ${acc.compositeKeys.size} + ${acc.superseded} + ${keylessFrames})`,
  ];

  return {
    classifiedKeys,
    unattributedKeys: acc.unattributedKeys,
    unattributedFrames,
    unattributedByReason: acc.unattributedByReason,
    keylessFrames,
    compositeKeys: acc.compositeKeys.size,
    frames: acc.frames,
    superseded: acc.superseded,
    holdsKeys,
    holdsFrames,
    holdsMargin,
    lines,
  };
}

// ---------------------------------------------------------------------------------------------
// The published envelope
// ---------------------------------------------------------------------------------------------

/**
 * The frozen UNMEASURED envelope (`phase-01`, §7).
 *
 * Pure and electron-free: the delivery surface and the CLI both import this rather than restating the
 * shape, so a status that is data can never be mistaken for an error and the two envelopes cannot
 * drift in key order. `census` is `null` unless a caller supplies one — a pass that detected drift or
 * hit a degenerate ceiling still has a census worth publishing, and one that never enumerated the
 * directory has nothing to publish.
 */
export function unmeasuredEnvelope(
  reasonCode: UnmeasuredReason | string,
  affected: readonly string[],
  storePath: string | null,
  extra: { asOf?: string; census?: Census | null; evidenceRefs?: readonly string[] } = {},
): McpDispatchAccount {
  return {
    status: 'UNMEASURED',
    reasonCode,
    affected: affected.slice(),
    evidenceRefs: extra.evidenceRefs === undefined ? [] : extra.evidenceRefs.slice(),
    asOf: extra.asOf ?? new Date().toISOString(),
    storePath,
    census: extra.census ?? null,
    fileRollups: [],
    rows: [],
    totals: null,
    reconciliation: null,
  };
}

/** The eight-key residue histogram, every class present even at zero (`phase-03:59`). */
export function residueHistogram(residue: readonly ResidueEntry[]): ResidueHistogram {
  const histogram = {} as ResidueHistogram;
  for (const residueClass of NAMED_RESIDUE_CLASSES) histogram[residueClass] = 0;
  for (const entry of residue) {
    if (entry.class === ResidueClass.ADMITTED) continue;
    histogram[entry.class] += entry.count;
  }
  return histogram;
}

/**
 * Evidence references, one per residue entry that has a censused line to point at.
 *
 * The grammar is frozen (`census:<censusHash[0..8]>#L<line>`), so a reference either resolves into the
 * bytes this census read or is not published. A `VANISHED` file contributes no reference: the loss is
 * the file's absence, and there is no censused line for it to name. Duplicates are collapsed, because
 * two residue rows in one file can share a first line.
 */
export function evidenceRefsFor(census: Census | null, residue: readonly ResidueEntry[]): string[] {
  if (census === null || census.censusHash === null) return [];
  const prefix = census.censusHash.slice(0, 8);
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const entry of residue) {
    if (entry.class === ResidueClass.VANISHED) continue;
    const ref = `census:${prefix}#L${entry.firstLine + 1}`;
    if (!EVIDENCE_REF_PATTERN.test(ref)) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

/** The affected tokens of a reason, plus the separator-free store label when there is one. */
function affectedFor(token: AffectedToken | null, label: string | null): string[] {
  if (token === null) return label === null ? [] : [label];
  return label === null ? [token] : [token, label];
}

// ---------------------------------------------------------------------------------------------
// The orchestration entry point
// ---------------------------------------------------------------------------------------------

/**
 * One in-process memo entry.
 *
 * The delivery surface owns the cross-call memo and keys it by the same stage-A sweep; this module's
 * copy exists only for an in-process caller that asks for it with `memo: true`. Both callers in this
 * repository pass `false`, so the cache stays cold in production — and when it is asked for, a hit can
 * only ever return an envelope whose key matched, which means the population it describes is
 * byte-for-byte the one on disk now.
 */
let accountMemo: { key: string; envelope: McpDispatchAccount } | null = null;

/** Test seam: forget the in-process memo. Never called in production code. */
export function clearAccountMemo(): void {
  accountMemo = null;
}

/**
 * The single orchestration entry point (`phase-03:129`).
 *
 * It wraps {@link runCensusPass} and runs **on the same thread as that pass** — the worker, or the
 * CLI's in-process mode — because aggregation is the finalize stage over the incremental sink plus the
 * roll-ups, never a second walk on the process that owns the window. No consumer re-implements a step;
 * the service, the CLI and the worker all call this one function.
 *
 * The three outcomes are deliberately different shapes:
 *
 * - a **time budget** expiry aborts with `UNMEASURED`/`READ_BUDGET_EXCEEDED` and the partial fold is
 *   discarded — no rows at all, because a partial row set reads as a complete one;
 * - an **input ceiling** is the opposite case: rows render over the files actually read, every row is
 *   `lowerBound: true`, and `totals.truncation` discloses the ceiling, the counts and the order;
 * - a **degenerate** ceiling (`filesRead === 0`) is `UNMEASURED`/`POPULATION_TRUNCATED` with the census
 *   still published, because `limits.filesRead === 0` and the null window are the answer.
 */
export async function accountStore(options: AccountStoreOptions): Promise<McpDispatchAccount> {
  const dir = options.storeDir;
  const asOf = options.asOf;
  const label = storeDisplayLabel(dir);

  if (options.memo === true) {
    try {
      const key = runPopulationSweep(dir).memoKey;
      if (accountMemo !== null && accountMemo.key === key) return accountMemo.envelope;
    } catch {
      // The memo is an optimization: a directory that cannot be swept is reported by the pass itself.
    }
  }

  const acc = emptyAccumulator();
  const progress = { lowerBound: false };
  const callerHooks = options.hooks;
  const hooks: PassHooks = {
    afterPopulationSweep: callerHooks?.afterPopulationSweep,
    afterRead: callerHooks?.afterRead,
    onYield: callerHooks?.onYield,
    onFileSettled: (entry) => {
      // `rewritten-identical` is not a shortfall: the bytes inside the window are the same bytes, so
      // nothing about the answer is a floor.
      if (entry.consistency !== 'clean' && entry.consistency !== 'rewritten-identical') {
        progress.lowerBound = true;
      }
      callerHooks?.onFileSettled?.(entry);
    },
  };

  const sink: FrameSink = {
    // The hint is the running flag; the authoritative bound is applied by `finalizeAggregate` from the
    // accumulator, so a file that turns out to be short never leaves its own frames unbounded.
    emit: ({ frame }) => {
      foldFrame(acc, frame, progress.lowerBound);
    },
  };

  const pass = await runCensusPass(dir, asOf, {
    sink,
    mode: options.mode,
    clock: options.clock,
    limits: options.limits,
    hooks,
    maxFrameBytes: options.maxFrameBytes,
  });
  const { census, counters, residue, fileRollups } = pass;

  const finish = (envelope: McpDispatchAccount): McpDispatchAccount => {
    if (options.memo === true) {
      try {
        accountMemo = { key: runPopulationSweep(dir).memoKey, envelope };
      } catch {
        accountMemo = null;
      }
    }
    return envelope;
  };

  /**
   * The empty-population envelope.
   *
   * `affected` names the store itself, because the mechanism of "nothing here" is the store rather than
   * a failure mode — and the census is published **only** when this pass actually read something. A
   * store whose only partition vanished mid-pass is then not described as empty, while a genuinely
   * empty store has nothing to publish and says `census: null`.
   */
  const noData = (): McpDispatchAccount => finish(unmeasuredEnvelope(
    UnmeasuredReason.NO_DATA,
    affectedFor(null, label),
    label,
    { asOf, census: census !== null && census.limits.filesRead > 0 ? census : null },
  ));

  switch (counters.outcome) {
    case 'NO_DATA_ROOT_RESOLVED':
      return finish(unmeasuredEnvelope(
        UnmeasuredReason.NO_DATA_ROOT_RESOLVED,
        affectedFor(AffectedToken.NO_DATA_ROOT_RESOLVED, label),
        label,
        { asOf },
      ));
    case 'DIR_UNREADABLE':
      return finish(unmeasuredEnvelope(
        UnmeasuredReason.DIR_UNREADABLE,
        affectedFor(AffectedToken.DIR_UNREADABLE, label),
        label,
        { asOf },
      ));
    case 'READ_BUDGET_EXCEEDED':
      return finish(unmeasuredEnvelope(
        UnmeasuredReason.READ_BUDGET_EXCEEDED,
        affectedFor(AffectedToken.BUDGET_EXPIRED, label),
        label,
        { asOf },
      ));
    case 'CENSUS_DRIFT':
      // The census that detected the drift is still published: it is the evidence for the verdict.
      return finish(unmeasuredEnvelope(
        UnmeasuredReason.CENSUS_DRIFT,
        affectedFor(AffectedToken.CENSUS_DRIFT, label),
        label,
        { asOf, census },
      ));
    case 'NO_DATA':
      return noData();
    default:
      break;
  }

  const degenerateCeiling = counters.ceiling !== null && counters.filesRead === 0;
  if (degenerateCeiling) {
    return finish(unmeasuredEnvelope(
      UnmeasuredReason.POPULATION_TRUNCATED,
      affectedFor(AffectedToken.POPULATION_TRUNCATED, label),
      label,
      { asOf, census },
    ));
  }

  if (counters.admittedTotal === 0 && counters.ceiling === null) {
    return noData();
  }

  acc.lowerBound = acc.lowerBound || progress.lowerBound || counters.ceiling !== null;
  const aggregate = finalizeAggregate(acc);
  const reconciliation = reconcile(acc, residue, fileRollups);
  const margin = quarantineMargin(fileRollups, residue);
  const truncation: TruncationDisclosure | null = counters.ceiling === null
    ? null
    : {
      ceiling: counters.ceiling,
      filesRead: counters.filesRead,
      filesSkipped: counters.filesSkipped,
      order: TRUNCATION_ORDER,
      label: `partial: ${counters.filesRead} of ${counters.filesRead + counters.filesSkipped} files`,
    };

  const totals: Totals = {
    residue: residueHistogram(residue),
    quarantineMargin: margin,
    retention: {
      firstSeen: aggregate.firstSeen,
      lastSeen: aggregate.lastSeen,
      note: RETENTION_NOTE,
    },
    excludedLatency: aggregate.excludedLatency,
    // The same object the reconciliation publishes: one number per fact, shared by reference so the
    // two surfaces cannot disagree about the unattributed breakdown.
    unattributedByReason: reconciliation.unattributedByReason,
    truncation,
  };

  const envelope: McpDispatchAccount = {
    status: 'MEASURED',
    reasonCode: MEASURED_REASON_CODE,
    // A complete measurement has no mechanism to disclose: the closure of its reconciliation is the
    // disclosure. The tokens are for the payloads that measured nothing.
    affected: [],
    evidenceRefs: evidenceRefsFor(census, residue),
    asOf,
    storePath: label,
    census,
    fileRollups,
    rows: aggregate.rows,
    totals,
    reconciliation,
  };
  return finish(envelope);
}

// ---------------------------------------------------------------------------------------------
// Worker entry (`phase-01:111`, `phase-04:20-23`)
// ---------------------------------------------------------------------------------------------

/**
 * Run one worker request: **one** message, then the thread is free to exit.
 *
 * The message is always a well-formed envelope — never a thrown error — because the delivery surface
 * awaits exactly one message and treats its absence as `SERVICE_FAILED`. The failure token is a closed
 * token and never `String(err)`: an ENOENT message carries an absolute path, and the whole point of
 * `affected[]` is that it does not.
 */
async function runWorkerRequest(request: McpDispatchWorkerRequest): Promise<void> {
  const label = storeDisplayLabel(request.storeDir);
  let message: McpDispatchAccount;
  try {
    message = await accountStore({
      storeDir: request.storeDir,
      asOf: request.asOf,
      memo: false,
      mode: 'worker',
    });
  } catch {
    message = unmeasuredEnvelope(
      UnmeasuredReason.SERVICE_FAILED,
      affectedFor(AffectedToken.SERVICE_FAILED, label),
      label,
      { asOf: request.asOf },
    );
  }
  parentPort?.postMessage(message);
}

/**
 * The worker entry point.
 *
 * `workerData` is the only input channel (`{ storeDir, asOf, mode }`), exactly one `postMessage`
 * follows, and nothing here runs on the main thread — where this module is imported for its pure
 * functions and its constants by the delivery surface, the CLI's in-process caller and the tests.
 */
const workerRequest = isMainThread ? null : (workerData as McpDispatchWorkerRequest | null);
if (workerRequest !== null && workerRequest !== undefined
  && typeof workerRequest.storeDir === 'string' && typeof workerRequest.asOf === 'string') {
  void runWorkerRequest(workerRequest);
}
