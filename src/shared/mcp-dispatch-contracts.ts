/**
 * AntiFan Browser Desktop — MCP dispatch accounting: the frozen measurement contract.
 *
 * This module is the **single declaration** of every closed set, every published shape and the one
 * evidence-reference grammar that the MCP dispatch accounting reader
 * (`src/main/diagnostics/mcp-dispatch-accounting.ts`), the delivery surface
 * (`src/main/diagnostics/mcp-dispatch-service.ts`), the renderer
 * (`src/renderer/toolbar.ts`), the CLI (`scripts/antifan-mcp-dispatch-account.cjs`) and the payload
 * gate (`scripts/check-mcp-dispatch-payload.mjs`) agree on. It is part of the plan
 * `plans/260917-0341-mcp-dispatch-accounting/` (`phase-01:56-193`, `phase-03:17-70`).
 *
 * It has **no imports at all** — not even `node:*` — so a renderer, a worker, a CLI process and a
 * `node --test` process can all import it. The runtime half of the contract (the pass, the fold, the
 * reconciliation) lives in the diagnostics module and re-exports these names.
 *
 * ## Repo convention: closed sets are `const` objects, never TS `enum`s
 *
 * This repo has zero `enum` declarations (`src/shared/contracts.ts:294-299` is the precedent), so
 * each closed set below is an `as const` object plus a union type of its values. `Object.keys()` of
 * such an object preserves declaration order, which is what lets a test assert the *enum closure* of
 * the residue and reason sets (plan `phase-01` X17) without restating them.
 *
 * ## The two-sided `affected` / `storePath` contract
 *
 * `affected[]` carries **tokens and a display label only — never a path** (`phase-01:203`). A member
 * is either a member of {@link AffectedToken} or the separator-free store display label
 * ({@link storeDisplayLabel} in the diagnostics module returns the final path segment for exactly
 * this reason; the delivery surface substitutes its own two-segment label on the wire). No member may
 * contain `/`, `\`, a drive letter or a URL: the payload gate rejects those shapes, and a path in
 * `affected` would publish the operator's machine layout into the renderer.
 */

// ---------------------------------------------------------------------------------------------
// §6 — the closed residue classification. Nine members, and the order is the classification order:
// ADMITTED first, then the named residue, then the three post-census classes.
// ---------------------------------------------------------------------------------------------

/** Every class a censused line — or a whole censused file — can land in (`phase-01:152-163`). */
export const ResidueClass = {
  ADMITTED: 'ADMITTED',
  STRUCTURAL_INVALID: 'STRUCTURAL_INVALID',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  TORN_TAIL: 'TORN_TAIL',
  UNPARSEABLE: 'UNPARSEABLE',
  RESIDUE_NO_CHECKSUM: 'RESIDUE_NO_CHECKSUM',
  POST_CENSUS_APPEND: 'POST_CENSUS_APPEND',
  POST_CENSUS_TRUNCATE: 'POST_CENSUS_TRUNCATE',
  VANISHED: 'VANISHED',
} as const;
export type ResidueClass = (typeof ResidueClass)[keyof typeof ResidueClass];

/**
 * The eight non-ADMITTED classes, in declaration order.
 *
 * This is the key set of `totals.residue`: the histogram is a `Record` over exactly these keys, so
 * `Object.keys(totals.residue)` is stable and never omits a class that happens to have counted zero
 * (`phase-01:186`, `phase-03:59`). Deriving it from {@link ResidueClass} keeps "the histogram has one
 * key per class" true by construction instead of by restatement.
 */
export type NamedResidueClass = Exclude<ResidueClass, 'ADMITTED'>;

/** The eight non-ADMITTED classes, in `ResidueClass` insertion order. */
export const NAMED_RESIDUE_CLASSES: readonly NamedResidueClass[] = (
  Object.keys(ResidueClass) as ResidueClass[]
).filter((name): name is NamedResidueClass => name !== ResidueClass.ADMITTED);

/**
 * The two named categories of `totals.residue` (`phase-03:59-61`):
 *
 * - **named-invalid** — a line that failed *while it tried to be a dispatch frame*
 *   (`STRUCTURAL_INVALID`, `CHECKSUM_MISMATCH`, `TORN_TAIL`, `UNPARSEABLE`,
 *   `RESIDUE_NO_CHECKSUM`). Note the absence of `ADMITTED`: a histogram of "named invalid" that
 *   contains an admitted count is a category error, and Phase 3 must never build one.
 * - **short-read** — a whole file that was **not fully measured** (`POST_CENSUS_APPEND`,
 *   `POST_CENSUS_TRUNCATE`, `VANISHED`). These counters are the ceiling-independent disclosure: a
 *   store with no input ceiling is still never fully measured while it is being written to
 *   (`phase-03:59`, `:130`), so the three classes are published even when
 *   `totals.truncation === null`.
 */
export const NAMED_INVALID_RESIDUE_CLASSES: readonly NamedResidueClass[] = [
  ResidueClass.STRUCTURAL_INVALID,
  ResidueClass.CHECKSUM_MISMATCH,
  ResidueClass.TORN_TAIL,
  ResidueClass.UNPARSEABLE,
  ResidueClass.RESIDUE_NO_CHECKSUM,
];
export const SHORT_READ_RESIDUE_CLASSES: readonly NamedResidueClass[] = [
  ResidueClass.POST_CENSUS_APPEND,
  ResidueClass.POST_CENSUS_TRUNCATE,
  ResidueClass.VANISHED,
];

/** Closed sub-reasons of `STRUCTURAL_INVALID` (`phase-01:160-161`). */
export const StructuralInvalidReason = {
  MISSING_IDENTITY: 'missing-identity',
  UNSUPPORTED_FORMAT_VERSION: 'unsupported-format-version',
} as const;
export type StructuralInvalidReason =
  (typeof StructuralInvalidReason)[keyof typeof StructuralInvalidReason];

/**
 * Closed sub-reasons of `CHECKSUM_MISMATCH` (`phase-01:163`).
 *
 * `WRITER_CANONICALIZATION_ARRAY_SLOT` is a diagnostic for an **already-failed** line: the writer
 * hashes the in-memory record while `JSON.stringify` writes `null` where an array slot held
 * `undefined` (`src/main/session/invocation-frame-checksum.ts:64-88`). It is never a normalization
 * applied before hashing and never an admission.
 */
export const ChecksumMismatchReason = {
  WRITER_CANONICALIZATION_ARRAY_SLOT: 'writer-canonicalization-array-slot',
  UNEXPLAINED: 'unexplained',
} as const;
export type ChecksumMismatchReason = (typeof ChecksumMismatchReason)[keyof typeof ChecksumMismatchReason];

/**
 * The one thing an `UNPARSEABLE` line is allowed to say about itself (`phase-02:246`).
 *
 * `RESIDUE_NO_CHECKSUM` and `TORN_TAIL` carry no reason at all: the first is fully described by its
 * class, and the second is a position fact the classifier already established. `UNPARSEABLE` carries
 * this literal so a reader can tell "the JSON did not parse" apart from a future class that also
 * names lines without being a JSON failure.
 */
export const UNPARSEABLE_REASON = 'json-parse-failed';

/**
 * Every reason a {@link ResidueEntry} may carry.
 *
 * A residue reason is always a **closed token**, never a message: `totals.quarantineMargin.reasons[]`
 * publishes these tokens verbatim, so a free-text reason would put an `Error.message` — and with it
 * an absolute path — on the wire.
 */
export type ResidueReason =
  | StructuralInvalidReason
  | ChecksumMismatchReason
  | typeof UNPARSEABLE_REASON;

// ---------------------------------------------------------------------------------------------
// §7 — the closed UNMEASURED reason set. Seven members; every UNMEASURED envelope carries exactly one
// of these in `reasonCode`, and the mechanism (never the reason) goes into `affected`.
// ---------------------------------------------------------------------------------------------

/**
 * Why a payload is UNMEASURED (`phase-01:169-179`).
 *
 * The set is closed so that a surface can render *why nothing was measured* without inventing a
 * reason. `POPULATION_TRUNCATED` covers the degenerate input-ceiling case (nothing was read at all);
 * a **non**-degenerate ceiling is MEASURED with `totals.truncation` set and every row `lowerBound`.
 */
export const UnmeasuredReason = {
  NO_DATA_ROOT_RESOLVED: 'NO_DATA_ROOT_RESOLVED',
  DIR_UNREADABLE: 'DIR_UNREADABLE',
  READ_BUDGET_EXCEEDED: 'READ_BUDGET_EXCEEDED',
  POPULATION_TRUNCATED: 'POPULATION_TRUNCATED',
  CENSUS_DRIFT: 'CENSUS_DRIFT',
  NO_DATA: 'NO_DATA',
  SERVICE_FAILED: 'SERVICE_FAILED',
} as const;
export type UnmeasuredReason = (typeof UnmeasuredReason)[keyof typeof UnmeasuredReason];

/** The two envelope statuses. There is no third: a partial answer is MEASURED plus a disclosure. */
export type McpDispatchStatus = 'MEASURED' | 'UNMEASURED';

/**
 * The `reasonCode` of a MEASURED envelope. A successful measurement is not a failure, so its reason
 * code is not a member of {@link UnmeasuredReason}: it is this one literal.
 */
export const MEASURED_REASON_CODE = 'OK';

// ---------------------------------------------------------------------------------------------
// §8 — the closed latency-provenance set. This phase only names the three labels so that no surface
// invents a fourth; the fold is the only consumer.
// ---------------------------------------------------------------------------------------------

/**
 * Which population a frame's latency sample belongs to (`phase-01:181-186`).
 *
 * `OWNER_WRITTEN` frames contribute to `latency`; the two excluded populations contribute to
 * `excludedLatency` instead, and are never silently dropped — a payload with zero non-excluded
 * samples renders `latency` as `null`, never as `0`.
 */
export const LatencyProvenance = {
  OWNER_WRITTEN: 'owner-written',
  EXCLUDED_UNKNOWN_STATE: 'excluded-unknown-state',
  EXCLUDED_REPLAY_PROVENANCE: 'excluded-replay-provenance',
} as const;
export type LatencyProvenance = (typeof LatencyProvenance)[keyof typeof LatencyProvenance];

// ---------------------------------------------------------------------------------------------
// §3 — census shapes
// ---------------------------------------------------------------------------------------------

/** How a directory entry was bucketed by the population sweep (`phase-01:65-70`). */
export const CensusBucket = {
  JSONL: 'jsonl',
  QUARANTINE: 'quarantine',
  TEMP: 'temp',
  OTHER: 'other',
} as const;
export type CensusBucket = (typeof CensusBucket)[keyof typeof CensusBucket];

/** The closed truncation ceilings. A ceiling is a bound on the *input*, never on the answer. */
export type CensusCeiling = 'MAX_CENSUS_BYTES' | 'MAX_CENSUS_FILES';

/** The frozen read order of a truncated population: newest first, name ascending as the tie-break. */
export type TruncationOrder = 'mtimeMs-desc,name-asc';
export const TRUNCATION_ORDER: TruncationOrder = 'mtimeMs-desc,name-asc';

/** Every census outcome is either complete or explicitly partial. */
export type CensusOutcome = 'COMPLETE' | 'POPULATION_TRUNCATED';

/**
 * The five consistency verdicts the stage-B checkpoint can reach for one file (`phase-02:118-139`).
 *
 * - `clean` — the censused window is still the whole file and its bytes are unchanged.
 * - `post-census-append` — the file grew after the sweep; the appended bytes are *named residue*,
 *   never content, never hashed and never admitted.
 * - `post-census-truncate` — the file shrank after the sweep (compaction replaces a partition).
 * - `vanished` — the file is gone; its census entry says so and contributes no frames.
 * - `rewritten-identical` — the file was rewritten in place with **byte-identical** content inside
 *   the window. The measurement is unaffected, so this is recorded rather than treated as drift.
 */
export type CensusConsistency =
  | 'clean'
  | 'post-census-append'
  | 'post-census-truncate'
  | 'vanished'
  | 'rewritten-identical';

/** The injectable, frozen bounds and the observed/covering facts of the census (`phase-01:73-78`). */
export interface CensusLimits {
  /** Frozen pass budget: `PASS_BUDGET_MS`. */
  budgetMs: number;
  /** Frozen input ceiling in bytes: `MAX_CENSUS_BYTES`. */
  maxBytes: number;
  /** Frozen input ceiling in files: `MAX_CENSUS_FILES`. */
  maxFiles: number;
  /** Bytes the sweep observed across **every** matched entry, read or not. */
  observedBytes: number;
  /** Files the sweep matched, read or not. */
  observedFiles: number;
  /** Files this pass actually selected and attempted to read. */
  filesRead: number;
  /** `observedFiles - filesRead`. Non-zero only under a ceiling. */
  filesSkipped: number;
  /** Which ceiling stopped the read, or `null` when it read the whole population. */
  ceiling: CensusCeiling | null;
  /**
   * Newest `mtimeMs` covered by this pass, or `null` when nothing was read.
   *
   * Phase 3 and Phase 4 render these two fields and must not re-derive the window from
   * `census.files` — one source, both sides (`phase-01:92`). `null` is the degenerate ceiling case.
   */
  windowNewestMtimeMs: number | null;
  /** Oldest `mtimeMs` covered by this pass, or `null` when nothing was read. */
  windowOldestMtimeMs: number | null;
  /** Wall time the pass spent inside `runCensusPass`. */
  elapsedMs: number;
  /** `COMPLETE`, or `POPULATION_TRUNCATED` once a ceiling stopped the read. */
  outcome: CensusOutcome;
}

/**
 * The published truncation disclosure (`phase-01:117`).
 *
 * `order` is published rather than implied because a truncated answer is only interpretable together
 * with the order that selected it: newest-first is what makes the answer "recent activity", while a
 * name-sorted prefix would read as "never dispatched" for every late-sorting partition
 * (`phase-03:129`).
 */
export interface Truncation {
  ceiling: CensusCeiling;
  filesRead: number;
  filesSkipped: number;
  order: TruncationOrder;
}

/**
 * `Truncation` plus the one printable line both the CLI and the Hub print verbatim.
 *
 * The delivery surface builds the label from the payload's own integers
 * (`partial: ${filesRead} of ${filesRead + filesSkipped} files`), the payload gate re-derives it and
 * rejects any payload whose label disagrees with its integers
 * (`scripts/check-mcp-dispatch-payload.mjs:273-276`), and the renderer falls back to the same
 * derivation when the label is absent (`src/renderer/toolbar.ts:1010-1025`). One fact, one arithmetic
 * spelling.
 */
export interface TruncationDisclosure extends Truncation {
  label: string;
}

/**
 * One censused file (`phase-01:53-56`, called `CensusEntry` there and `CensusFile` in the phase-01
 * task brief; both names refer to this shape and both are exported).
 */
export interface CensusEntry {
  /** The directory entry's name, verbatim — never a path. */
  name: string;
  bucket: CensusBucket;
  /**
   * The bytes this pass **actually read**, never a stale pre-read size.
   *
   * For a file that shrank after the sweep this is the smaller post-read length; for a file that
   * vanished before it could be read it is `0`, and the accompanying residue says `VANISHED`.
   */
  size: number;
  /** Post-read `mtimeMs` when the file was still there to stat, else the sweep's observation. */
  mtimeMs: number;
  /** Non-blank segments in the censused window, the predicate the ledger uses at `:177`. */
  lineCount: number;
  /**
   * `sha256` of exactly the `size` bytes above.
   *
   * A vanished, never-read file carries the digest of the empty string, so the field is always a
   * digest of the bytes this entry accounts for.
   */
  sha256: string;
  consistency: CensusConsistency;
}

/** Alias for {@link CensusEntry}, the name the phase-01 brief uses. */
export type CensusFile = CensusEntry;

/**
 * The census the reader is handed (`phase-01:57-79`).
 *
 * `files` is the **read set** — one entry per file this pass selected, name-sorted for publication —
 * while the counting fields describe the **full matched population** the sweep observed. The two are
 * deliberately different facts: a truncated pass must still be able to say how much of the store it
 * did not cover (`phase-01:114`, `:90`). `censusHash` covers exactly the files in `files`, so a
 * partial census is a deterministic hash of precisely what it measured and never of bytes it only
 * listed.
 *
 * ## Why there is no directory field here
 *
 * Phase 1's field list names a `dir`, and this shape deliberately carries none. A census is a wire
 * shape: it travels through the worker's `postMessage` and into the renderer's payload, and constraint
 * D says a payload exposes aggregate fields plus **one** display label (`storePath`). A resolved
 * absolute path on this object would announce the operator's machine layout the first time anything
 * serialized it, which is the exact shape the payload gate rejects (`phase-01:203`,
 * `scripts/check-mcp-dispatch-payload.mjs:109`). The reader is therefore handed the directory as an
 * argument (`FrameReadOptions.storeDir`, injected by the CLI or the service — the only places that may
 * resolve a root at all, `phase-01:43`), and `storePath` names the store for humans.
 */
export interface Census {
  asOf: string;
  /** The read set, name-sorted. Read *order* is recoverable from `limits`/`fileRollups`. */
  files: CensusEntry[];
  /** Full matched file count — equal to `limits.observedFiles`, never the read-set length. */
  fileCount: number;
  jsonlCount: number;
  quarantineCount: number;
  tempCount: number;
  otherCount: number;
  /** Full matched byte count — equal to `limits.observedBytes`, read or not. */
  totalBytes: number;
  /**
   * `sha256` over the name-sorted read set of `"<name>\0<size>\0<sha256>\n"`.
   *
   * `null` **only** when nothing was read at all — never as a placeholder for a hash that could not
   * be computed, and never as a census of a store it only partially covers (`phase-01:90`).
   */
  censusHash: string | null;
  limits: CensusLimits;
}

// ---------------------------------------------------------------------------------------------
// §3 / §9 — per-file roll-up and the published residue
// ---------------------------------------------------------------------------------------------

/**
 * The frozen per-file roll-up the quarantine margin is built from (`phase-01:80-87`).
 *
 * Produced by the same pass that produced the residue rows — never by a re-scan — and asserted to
 * close: `frames === admitted + namedInvalid`. A roll-up carries one entry per file **actually
 * read**, so a file skipped by the input ceiling contributes nothing to the margin
 * (`phase-03:51`, `:128`).
 */
export interface FileRollup {
  /** The entry's name, verbatim. */
  file: string;
  /** Name contains `.quarantine-`. A name-derived label, never an inference about admission. */
  quarantineLike: boolean;
  /** Name contains `.tmp-`. */
  tempLike: boolean;
  /** Non-blank segments read from that file's bytes (equal to its `CensusEntry.lineCount`). */
  frames: number;
  admitted: number;
  /** Every non-ADMITTED *named-invalid* class for that file; short-read classes are not counted. */
  namedInvalid: number;
}

/**
 * One aggregated residue fact.
 *
 * Entries are aggregated by `(file, class, reason, fields, observedFormatVersion)` so that a file
 * with 300 checksum mismatches publishes one row with `count: 300` and the first occurrence's
 * location — bounded residue, not one record per line (`phase-02:69-73`).
 */
export interface ResidueEntry {
  /** The entry's name, verbatim. */
  file: string;
  class: ResidueClass;
  /** Present for the three classes that have closed sub-reasons; never free text. */
  reason?: ResidueReason;
  /** `STRUCTURAL_INVALID` / `missing-identity` only: the identity fields that were absent. */
  fields?: string[];
  /** `STRUCTURAL_INVALID` / `unsupported-format-version` only: the version actually observed. */
  observedFormatVersion?: number;
  count: number;
  /**
   * The 0-based line index of the **first** occurrence in the file's window.
   *
   * This is what makes `census:<hash>#L<n>` a real evidence pointer rather than a decorative one:
   * the reference names the first line the claim rests on (`EVIDENCE_REF_PATTERN`,
   * `mcp-dispatch-service.ts:169`).
   */
  firstLine: number;
  /** The byte offset of that first occurrence within the window. */
  firstByteOffset: number;
  /** `POST_CENSUS_APPEND` only: the bytes appended after the sweep's observation. */
  bytes?: number;
}

// ---------------------------------------------------------------------------------------------
// §9 — the published envelope
// ---------------------------------------------------------------------------------------------

/** A nearest-rank latency sample. `count === 0` is never published; the sample is `null` instead. */
export interface LatencySample {
  count: number;
  p50Ms: number;
  p95Ms: number;
}

/**
 * One row per recorded `frame.name` (`phase-03:17-27`, `:120-126`).
 *
 * The key set is frozen and is also the payload gate's `ROW_ALLOWLIST`
 * (`scripts/check-mcp-dispatch-payload.mjs:59`).
 */
export interface AggregateRow {
  /** The recorded, **post-alias** dispatch name, verbatim. */
  name: string;
  /** Distinct validated composite keys attributed to this name. */
  calls: number;
  /** Raw admitted frame count for this name. */
  frames: number;
  /** `frames - calls`: transitions the store retained for one composite. */
  superseded: number;
  /** Histogram over observed `state` values; the state list is never hard-coded. */
  states: Record<string, number>;
  /** Histogram over `error.code`; unknown codes are counted as-is, not folded into a bucket. */
  errors: Record<string, number>;
  /** Nearest-rank p50/p95 over non-excluded frames, or `null` when the sample is empty. */
  latency: LatencySample | null;
  /** The same triple over the union-excluded population, so the exclusion is never silent. */
  excludedLatency: LatencySample | null;
  /** Min `createdAt` in the group, as an ISO-8601 instant, or `null` for an empty group. */
  firstSeen: string | null;
  /** Max `createdAt` in the group, as an ISO-8601 instant, or `null` for an empty group. */
  lastSeen: string | null;
  /**
   * True when any short read, post-census append or input ceiling was seen by this pass.
   *
   * Every row-level count is a floor — rows describe retained frames only, and a short read makes
   * even that understated — so a MEASURED payload with `lowerBound: true` must be rendered `≥ N` and
   * never as an exact count (`phase-03:52`).
   */
  lowerBound: boolean;
}

/** The `totals.residue` histogram: one key per non-ADMITTED class, always all eight present. */
export type ResidueHistogram = Record<NamedResidueClass, number>;

/**
 * The quarantine margin (`phase-03:44-51`).
 *
 * `framesAdmitted` is a **split of** the admitted set, not an addition to it: every file behind this
 * margin was read, so its admitted frames are already inside `reconciliation.frames` — no surface may
 * add `framesAdmitted` to anything. The quarantine rename is a recovery mechanism that was already in
 * pain at 21/22 recovered frames in the plan's own measurement, and nothing in this suite repairs a
 * single frame, which is exactly what `label` says.
 */
export interface QuarantineMargin {
  /** The printable line the CLI and the Hub print verbatim. */
  label: string;
  /** Count of `quarantineLike` roll-ups. */
  files: number;
  /** Σ `frames` over those roll-ups. */
  framesPresent: number;
  /** Σ `admitted` over those roll-ups. */
  framesAdmitted: number;
  /** Σ `namedInvalid` over those roll-ups. */
  framesNamedInvalid: number;
  /** The distinct `(class, reason)` values the same pass's residue rows carried for those files. */
  reasons: Array<{ class: NamedResidueClass; reason?: string; count: number }>;
}

/**
 * `totals.retention` (`phase-03:53`).
 *
 * `0` is never presented as "never dispatched": the note states that an absent name means no frame is
 * retained in this store, not that the tool was never called.
 */
export interface Retention {
  firstSeen: string | null;
  lastSeen: string | null;
  note: string;
}

/** The two closed reasons a frame can be admitted but not attributed to a row (`phase-03:127`). */
export interface UnattributedByReason {
  /** Frames whose composite was absent/blank — never keyed, keyed as `undefined\u0000undefined`. */
  MISSING_IDENTITY_FIELD: number;
  /** Distinct valid composite keys whose row key (the recorded `name`) was absent or blank. */
  MISSING_ROW_KEY: number;
}

/**
 * The measured totals (`phase-03:35-59`).
 *
 * `totals` never restates a count `reconciliation` already owns, so there is exactly one number per
 * fact: residue, margin, retention, the excluded-latency population, the unattributed breakdown and
 * the truncation disclosure live here; the identity invariants live in `reconciliation`.
 */
export interface Totals {
  /** Named-invalid and short-read counters. `POST_CENSUS_*`/`VANISHED` appear here, not elsewhere. */
  residue: ResidueHistogram;
  quarantineMargin: QuarantineMargin;
  retention: Retention;
  excludedLatency: LatencySample | null;
  unattributedByReason: UnattributedByReason;
  /** `null` unless the input ceiling truncated the read. */
  truncation: TruncationDisclosure | null;
}

/**
 * The reconciliation block: four independently accumulated terms, two printed invariants, three
 * honest booleans (`phase-03:28-34`, `:128`).
 *
 * The terms are accumulated separately on purpose. A reconciliation that cannot disagree with itself
 * is not a measurement, so `holds*` are computed from independent accumulations and may be `false`
 * without throwing.
 */
export interface Reconciliation {
  /** Σ distinct validated internal keys over the rows. */
  classifiedKeys: number;
  /** Distinct validated keys that landed on **no** row (absent/blank `name`). */
  unattributedKeys: number;
  /** `unattributedKeys + keylessFrames`. */
  unattributedFrames: number;
  unattributedByReason: UnattributedByReason;
  /** Admitted frames with no usable composite at all. */
  keylessFrames: number;
  /** Distinct validated composite keys the fold saw, counted independently of the rows. */
  compositeKeys: number;
  /** Admitted frames the fold counted. */
  frames: number;
  /** Admission attempts whose composite was already seen — counted, never added to `calls`. */
  superseded: number;
  /** `classifiedKeys + unattributedKeys === compositeKeys`. */
  holdsKeys: boolean;
  /** `frames === compositeKeys + superseded + keylessFrames`. */
  holdsFrames: boolean;
  /** `framesPresent === framesAdmitted + framesNamedInvalid` over the margin's roll-ups. */
  holdsMargin: boolean;
  /** The two printed invariant lines, built from the numbers above at call time. */
  lines: string[];
}

/**
 * The published envelope (`phase-01:188-193`, `phase-04:19`).
 *
 * Every consumer — the service, the CLI, the renderer — reads this one shape. A status is data: an
 * UNMEASURED envelope is a **valid** payload that names why nothing was measured, not an error.
 */
export interface McpDispatchAccount {
  status: McpDispatchStatus;
  reasonCode: string;
  /**
   * The mechanism, as symbolic tokens plus the separator-free store display label — never a path.
   *
   * Members are {@link AffectedToken} values or the store's display label. MEASURED payloads carry
   * `[]`: the mechanism of a complete measurement is the closure of its reconciliation, not a list.
   */
  affected: string[];
  /** `census:<censusHash[0..8]>#L<line>` pointers into the censused bytes; `[]` when nothing named. */
  evidenceRefs: string[];
  asOf: string;
  /** The store's display label, or `null` when no root was resolved at all. */
  storePath: string | null;
  census: Census | null;
  fileRollups: FileRollup[];
  rows: AggregateRow[];
  totals: Totals | null;
  reconciliation: Reconciliation | null;
}

/**
 * The symbolic members `affected[]` may carry (`phase-01:203`, `phase-04:19`).
 *
 * The first six are the mechanisms of the corresponding {@link UnmeasuredReason}; `no-data` names the
 * empty population, which has no failure mechanism to disclose. Nothing here is a path, and nothing
 * here is a count.
 */
export const AffectedToken = {
  NO_DATA_ROOT_RESOLVED: 'no-data-root-resolved',
  DIR_UNREADABLE: 'dir-unreadable',
  BUDGET_EXPIRED: 'budget-expired',
  POPULATION_TRUNCATED: 'population-truncated',
  CENSUS_DRIFT: 'census-drift',
  SERVICE_FAILED: 'service-failed',
  /**
   * Forced by the empty population: `NO_DATA` has no mechanism to name, so it says so.
   *
   * The delivery surface's own `NO_DATA` path publishes this token; the accounting pass publishes the
   * store label alone for `NO_DATA`, because there the store *is* the mechanism and a second token
   * would name the same fact twice.
   */
  NO_DATA: 'no-data',
} as const;
export type AffectedToken = (typeof AffectedToken)[keyof typeof AffectedToken];

/**
 * The frozen evidence-reference grammar (`phase-01:193`, `phase-02:75-76`).
 *
 * `census:<hash-prefix>#L<line>` — the hash prefix is at least 8 hex digits of the `censusHash` the
 * claim rests on, and the line is 1-based. It is deliberately **not** a free-form string: the
 * delivery surface rejects a reference that does not match this pattern, so an evidence reference is
 * always resolvable to censused bytes or it is not published at all.
 *
 * The pattern carries no `g`/`y` flag on purpose, so `RegExp.prototype.test` is stateless and the one
 * shared instance cannot leak `lastIndex` between two callers.
 */
export const EVIDENCE_REF_PATTERN = /^census:[0-9a-f]{8,}#L\d+$/;

/**
 * `totals.retention.note`, verbatim.
 *
 * The sentence is the contract, not decoration: a name missing from the row set means *no frame is
 * retained in this store*, and a surface that renders an absent name as "never dispatched" is lying
 * about a compaction that already happened (`phase-03:53`).
 */
export const RETENTION_NOTE =
  'rows describe retained frames only; a name absent from this set means no frame is retained in '
  + 'this store, never that the tool was never dispatched';

// ---------------------------------------------------------------------------------------------
// §11 — the published vocabulary. Every string that crosses a process boundary as a *key* is either a
// closed token or it is renamed here; these two rules are what make that true.
// ---------------------------------------------------------------------------------------------

/**
 * Is this string shaped like a filesystem location? (`phase-01:203`, constraint D.)
 *
 * One predicate for the whole delivery layer: the accounting module applies it to a row key, and the
 * service applies it to every string it projects, so a single rule decides what a payload may carry
 * instead of two copies that can drift. It is **shape**-based — it never touches the filesystem — and it
 * errs towards `true`, because a false negative publishes the operator's directory layout while a false
 * positive only costs a label.
 *
 * `true` for a drive-absolute path (`C:\Users\…`), a drive-relative one (`C:x`, which contains no
 * separator at all), a UNC path (`\\host\share`), a POSIX absolute path (`/var/lib/…`), a `file:` URL,
 * and any string containing a separator. `false` for an ISO instant, an evidence reference, a symbolic
 * token, and a colon-bearing token that is not a drive (`1:2`, `a b:c`) — the last two are why a bare
 * `includes(':')` test would be wrong.
 */
export function isLocationShaped(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (/^[a-zA-Z]:/.test(value)) return true;
  if (/^\\\\/.test(value)) return true;
  if (/^\//.test(value)) return true;
  if (/^file:/i.test(value)) return true;
  return /[\\/]/.test(value);
}

/**
 * The bounded grammar a histogram key must satisfy, and the one literal everything else collapses to.
 *
 * `rows[].states` and `rows[].errors` are histograms over **persisted** strings: `frame.state` and
 * `frame.error.code` are written by the ledger and nothing validates them on the way in. Publishing one
 * verbatim would let a single crafted frame put an absolute path into the payload as a JSON **key**,
 * where a value-only sanitiser never looks. So a key is admitted only if it is a short identifier-like
 * token, and every other key is renamed to {@link UNRECOGNIZED_HISTOGRAM_KEY} **with its count
 * preserved** — counts sum on collision, because dropping one would stop the row's own totals from
 * reconciling.
 *
 * The pattern refuses every location shape in one place: the `(?![A-Za-z]:)` lookahead rejects the
 * drive-relative form (`C:x`) that a separator check misses, and the character class carries no `/`,
 * `\` or whitespace. The length bound keeps a pathological key from becoming a payload-sized string.
 * No `g`/`y` flag, so the one shared instance cannot leak `lastIndex` between callers.
 */
export const HISTOGRAM_TOKEN_PATTERN = /^(?![A-Za-z]:)[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** What a histogram key that is not a bounded token is published as, counts intact. */
export const UNRECOGNIZED_HISTOGRAM_KEY = 'UNRECOGNIZED';
