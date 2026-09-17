/**
 * AntiFan — MCP Dispatch Accounting: MAIN-PROCESS DELIVERY SERVICE
 *
 * Plan: `plans/260917-0341-mcp-dispatch-accounting/phase-04-delivery-surface.md` (this file's phase),
 * `plan.md` Design Decision 6 + locked constraint D (payload projection on a gated channel) and
 * locked constraint G (the pass is bounded in time and never runs on the Electron main thread).
 *
 * What this module is allowed to do
 * ---------------------------------
 *   1. run Phase 1's **stage-A population sweep** for the memo key — the accounting module's own
 *      `runPopulationSweep` (`readdir` + one `stat` per entry, no file content), called from the main
 *      thread exactly as that module documents its delivery-surface caller;
 *   2. spawn a `node:worker_threads` worker over the compiled, electron-free accounting module
 *      (`src/main/diagnostics/mcp-dispatch-accounting.ts` → `.compiled/.../mcp-dispatch-accounting.js`)
 *      and await exactly one message from it under a hard budget;
 *   3. memoize the finished, **projected** envelope (one entry, no TTL, evicted on key change);
 *   4. return that envelope from `getState()`.
 *
 * What this module must NEVER do (constraint G, `phase-01:110`, `phase-04:23`, `phase-04:157`)
 * ---------------------------------------------------------------------------------------------
 *   - It never runs the pass on the main thread and never calls `runCensusPass`, `accountStore`,
 *     `readAdmittedFrames` or `readFramesIncremental`. Those names appear here **only** as string
 *     literals inside comments, so the single-call-site assertion remains true.
 *   - It never holds the admitted frame set. It holds at most one finished projected envelope.
 *   - It declares **no** budget constant of its own: `PASS_BUDGET_MS`, `MAX_CENSUS_BYTES`,
 *     `MAX_CENSUS_FILES` and `IN_PROCESS_YIELD_INTERVAL_FILES` are the accounting module's exports
 *     (`phase-01:118-126`, step 2). `WORKER_START_ALLOWANCE_MS` / `FILE_READ_ALLOWANCE_MS` below are
 *     not pass bounds — they are the *caller-side* await slack constraint G describes as
 *     `PASS_BUDGET_MS + worker start + one file read`.
 *   - It never re-derives the covered window or any margin number. `limits.windowNewestMtimeMs` /
 *     `windowOldestMtimeMs` and `totals.quarantineMargin` are Phase 1/Phase 3 fields and pass through
 *     the projection untouched (`phase-04:33`).
 *   - It defines **none** of the module-owned symbols. `McpDispatchAccount`, `Census`, `AggregateRow`,
 *     `FileRollup`, `AffectedToken`, `unmeasuredEnvelope`, `storeDisplayLabel`, `runPopulationSweep`,
 *     `computePopulationMemoKey` and `PASS_BUDGET_MS` are imported from `./mcp-dispatch-accounting`,
 *     which re-exports the whole shared contract surface (`mcp-dispatch-accounting.ts:104`), so there
 *     is one definition in the tree and one import path.
 *
 * Worker message contract (frozen shape consumed here; `phase-01:109-111`, `phase-04:21-23`)
 * --------------------------------------------------------------------------------------------
 *   main → worker : `workerData` only — `{ storeDir, asOf, mode }`. No `postMessage` is ever sent
 *                   in this direction and no shared state exists.
 *   worker → main : **exactly one** message, then exit — the projected envelope (`MEASURED` or
 *                   `UNMEASURED`), never a fault object and never a raw frame set.
 *
 * Why this file still owns a projection and a boundary reducer
 * -----------------------------------------------------------
 *   The accounting module publishes the envelope and its `unmeasuredEnvelope` is the single
 *   definition of the UNMEASURED *shape*. What it deliberately does not do is police the crossing
 *   point: `unmeasuredEnvelope(reasonCode, affected, storePath)` copies `affected` verbatim
 *   (`mcp-dispatch-accounting.ts:1801`), so a caller that hands it `String(err)` would publish an
 *   absolute path. Constraint D is enforced here, at the IPC edge, by two local layers that are not
 *   redefinitions of anything upstream:
 *     - {@link projectEnvelope} — the allowlist projection applied to every envelope the worker posts
 *       and to every envelope this service synthesizes;
 *     - {@link unmeasuredBoundaryEnvelope} — the module's builder plus the `affected[]` reduction, so
 *       no path can reach the wire even on the failure paths.
 */
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { StorageLocations } from '../config/storage-locations';
import {
  AffectedToken,
  HISTOGRAM_TOKEN_PATTERN,
  MEASURED_REASON_CODE,
  PASS_BUDGET_MS,
  UNRECOGNIZED_HISTOGRAM_KEY,
  UnmeasuredReason,
  isLocationShaped,
  runPopulationSweep,
  storeDisplayLabel,
  unmeasuredEnvelope,
  type Census,
  type McpDispatchAccount,
} from './mcp-dispatch-accounting';

// The one import path for the contract surface: the accounting module re-exports it
// (`mcp-dispatch-accounting.ts:104`), so a second `shared/` import would be a second path to the
// same names.
export type { McpDispatchAccount } from './mcp-dispatch-accounting';

/**
 * Caller-side slack added to `PASS_BUDGET_MS` for the bounded await: worker construction/online
 * handshake plus one file read. Not a pass bound and not a second budget (constraint G's bound is
 * `PASS_BUDGET_MS + worker start + one file read`; `phase-04:23`, `phase-04:157`).
 */
const WORKER_START_ALLOWANCE_MS = 1_000;
/** One file read at the largest measured line/partition scale; see `plan.md`'s measured-scale note. */
const FILE_READ_ALLOWANCE_MS = 1_000;

/**
 * The declared bound on the caller-side await — `PASS_BUDGET_MS + worker start + one file read`
 * (`phase-04:23`, `phase-04:157`). A single imported constant governs the bound; this only adds the
 * transport slack, and it is a function so a read-only surface consumer can ask for the number
 * without a worker ever being constructed.
 */
export function passAwaitBudgetMs(): number {
  return PASS_BUDGET_MS + WORKER_START_ALLOWANCE_MS + FILE_READ_ALLOWANCE_MS;
}

/**
 * The **closed** set of symbolic `affected[]` tokens (`phase-01:203`, `phase-04:19`): every member of
 * the module's `AffectedToken`, plus the one token Phase 4 adds for this channel's own sender-gate
 * refusal (`phase-04:108`). Nothing else is passed through — a token that is not here is treated as a
 * value that could carry a location and is reduced to the display label.
 *
 * Reading the members off the module's own constant (rather than re-listing them) is what keeps this
 * set closed: a member added upstream arrives here automatically, and a free-form string never does.
 */
const MECHANISM_TOKENS: readonly string[] = [
  ...Object.values(AffectedToken),
  'ipc-sender-not-trusted',
];

/**
 * The label used when a location-shaped value must be reduced and no store resolved. It is a single
 * separator-free word by construction, so it can never satisfy the "no path" rule by accident.
 */
const UNRESOLVED_STORE_LABEL = 'unresolved-store';

/**
 * The display label of the store this channel serves, derived from the **same** resolved directory
 * the pass reads (`storeDisplayLabel` returns the final path segment, never a two-segment label and
 * never a drive letter: `mcp-dispatch-accounting.ts:205-217`). `null` in ⇒ `null` out: an unresolved
 * store is rendered from `reasonCode`, never as the text "null" and never as an invented path.
 *
 * ## Why this is a function and not a module-level constant
 *
 * It used to be `export const MCP_DISPATCH_STORE_LABEL = storeDisplayLabel(...)`, evaluated at import
 * time. That made the module perform real filesystem I/O on import — `StorageLocations.getDataRoot()`
 * probes the data root (`existsSync`, `mkdirSync`, a probe `writeFileSync`, `unlinkSync`) and caches a
 * process-wide data root — so `native-tab-host.ts:56` merely importing this module created
 * directories. A read-only surface must not mutate the filesystem by being linked.
 *
 * The value is memoized on first use, so the answer is stable for the process and the cost is paid
 * once, by a caller that actually asked for a label.
 */
let canonicalStoreLabelCache: string | null | undefined;
export function mcpDispatchStoreLabel(): string | null {
  if (canonicalStoreLabelCache === undefined) {
    canonicalStoreLabelCache = storeDisplayLabel(
      path.join(StorageLocations.getControlPlaneDir(), 'invocations'),
    );
  }
  return canonicalStoreLabelCache;
}

/** Test seam: forget the memoized label so a re-resolution can be observed. */
export function resetMcpDispatchStoreLabelForTest(): void {
  canonicalStoreLabelCache = undefined;
}

// ---------------------------------------------------------------------------------------------
// Pure projection helpers (exported for the dedicated surface test).
// ---------------------------------------------------------------------------------------------

// `isLocationShaped` is NOT defined here. It is the shared predicate from
// `../../shared/mcp-dispatch-contracts` (re-exported by `./mcp-dispatch-accounting`, `:104`), so the
// service and the accounting reader apply one rule instead of two copies that can drift. It errs
// towards `true`: a false negative publishes the operator's directory layout, while a false positive
// only costs a label.

/**
 * Reduce one `affected[]` entry (constraint D, `phase-04:34`): a closed-set mechanism token passes
 * through verbatim, anything else becomes the display label. The free-form `String(err)` form is the
 * case this exists for — an ENOENT message carries an absolute path
 * (`mcp-dispatch-accounting.ts:2070-2073` names the same hazard).
 */
export function labeliseAffectedEntry(entry: unknown, storeLabel: string | null): string {
  if (typeof entry === 'string' && MECHANISM_TOKENS.includes(entry)) return entry;
  if (typeof entry === 'string'
    && entry.length > 0
    && !entry.includes(' ')
    && !isLocationShaped(entry)) {
    // A short, separator-free, colon-free, non-location string is already a label. It is kept so a
    // future token does not silently collapse to `unresolved-store`.
    return entry;
  }
  return storeLabel ?? UNRESOLVED_STORE_LABEL;
}

/** Reduce the whole `affected[]` list, dropping empties and de-duplicating in first-seen order. */
export function labeliseAffected(entries: unknown, storeLabel: string | null): string[] {
  if (!Array.isArray(entries)) return storeLabel ? [storeLabel] : [];
  const out: string[] = [];
  for (const entry of entries) {
    const label = labeliseAffectedEntry(entry, storeLabel);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * The fixed bucket name a location-shaped **key** is rewritten to — the shared
 * {@link UNRECOGNIZED_HISTOGRAM_KEY}, not a local spelling of it, so the reader-side rename and this
 * boundary rename cannot drift apart.
 *
 * A histogram key is a vocabulary entry (`rows[].states`, `rows[].errors`), not a place, so it must
 * not be replaced with the store label: labelling a bucket `invocations` would be a lie about what
 * the count means.
 */
const UNRECOGNIZED_KEY = UNRECOGNIZED_HISTOGRAM_KEY;

/**
 * Sanitize an object key. Returns `null` for a key that must be dropped entirely.
 *
 * This runs on **every** key of every projected object, not just on values: `sortedHistogram`
 * (`mcp-dispatch-accounting.ts:285-291`) builds `rows[].states` / `rows[].errors` keys straight from
 * persisted `frame.state` / `frame.error.code`, and structural admission validates only
 * `id`/`idempotencyKey`/`attachmentId`/`formatVersion`/`checksum` — so a frame with
 * `error.code = "C:\\Users\\Admin\\secrets"` really does reach this projection as an object key. A
 * key-blind projection publishes that path; that was the High defect this replaces.
 *
 * A **forbidden** key is dropped, not renamed: `runtimeLeaseToken` may carry a secret as its value,
 * and `UNRECOGNIZED` is a bucket, not a bin — a rename would preserve the value under a harmless
 * name. Everything else that fails the shared bounded-token grammar becomes the shared bucket.
 */
function sanitizeProjectedKey(key: string): string | null {
  if (isForbiddenKey(key)) return null;
  if (HISTOGRAM_TOKEN_PATTERN.test(key)) return key;
  return isLocationShaped(key) ? UNRECOGNIZED_KEY : key;
}

/**
 * Recursively drop every forbidden key, rewrite every location-shaped key to
 * {@link UNRECOGNIZED_KEY}, and reduce every location-shaped string value (`census`, `totals`,
 * `reconciliation`, `fileRollups`, histogram objects).
 *
 * This is the structural half of constraint D: the allowlist bounds the *shape*, this bounds the
 * *content* — values **and** keys.
 *
 * Colliding integer counts are **summed**, never dropped, so a row's total still reconciles after
 * two hostile keys (or a hostile and a clean one) collapse onto the same bucket. Non-numeric
 * collisions keep the first value and leave the dropped one visible in the
 * `totals.reconciliation` closure.
 */
export function sanitizeProjectedValue(value: unknown, storeLabel: string | null, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof value === 'string') {
    return isLocationShaped(value) && !MECHANISM_TOKENS.includes(value)
      ? (storeLabel ?? UNRESOLVED_STORE_LABEL)
      : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'undefined') return null;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProjectedValue(item, storeLabel, depth + 1));
  }
  if (typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const safeKey = sanitizeProjectedKey(key);
    if (safeKey === null) continue;
    const projected = sanitizeProjectedValue(source[key], storeLabel, depth + 1);
    if (!Object.prototype.hasOwnProperty.call(target, safeKey)) {
      target[safeKey] = projected;
      continue;
    }
    const existing = target[safeKey];
    if (typeof existing === 'number' && typeof projected === 'number') {
      target[safeKey] = existing + projected;
    }
    // Otherwise the first value wins; the count is still carried by the row's own `frames`.
  }
  return target;
}

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * The envelope's key set. `satisfies` makes the one copy of this list checked against the contract
 * interface: a key added to (or removed from) `McpDispatchAccount` fails the build here instead of
 * drifting silently, and `assertProjectedKeys` keeps the runtime record honest.
 */
const ENVELOPE_KEYS = [
  'status',
  'reasonCode',
  'affected',
  'evidenceRefs',
  'asOf',
  'storePath',
  'census',
  'fileRollups',
  'rows',
  'totals',
  'reconciliation',
] as const satisfies readonly (keyof McpDispatchAccount)[];

/**
 * The frozen per-row key list (`phase-04:31`, the gate's `ROW_ALLOWLIST`). Only these keys are ever
 * emitted for a row; a key the contract gains is published only once it is listed here, which is the
 * point — publication is a decision, not an inheritance.
 */
const ROW_KEYS = [
  'name',
  'calls',
  'frames',
  'superseded',
  'states',
  'errors',
  'latency',
  'excludedLatency',
  'firstSeen',
  'lastSeen',
  'lowerBound',
] as const;

/**
 * The frozen per-file roll-up key set (`phase-01:80-87`, the gate's `FILE_ROLLUP_ALLOWLIST`).
 *
 * **Exact**, not a superset. The previous 24-key union silently published any `FileRollup` key an
 * upstream addition produced, and the gate — which allows these six — then rejected our own payload.
 * A key set is a contract between the producer and the gate; emitting exactly what the gate allows is
 * what keeps a future `FileRollup` addition a test failure instead of a shipped rejection.
 */
const FILE_ROLLUP_KEYS = [
  'file',
  'quarantineLike',
  'tempLike',
  'frames',
  'admitted',
  'namedInvalid',
] as const;

/**
 * The census entry's key set (`CensusEntry`). Emitted by subset filtering: the census is a disclosure
 * section, so a key that is not listed is dropped rather than published.
 */
const CENSUS_ENTRY_KEYS = [
  'name',
  'bucket',
  'size',
  'mtimeMs',
  'lineCount',
  'sha256',
  'consistency',
] as const;

/**
 * The census container's key set (`Census`). Note the absence of a directory field: `Census` has no
 * `dir` member at all (`shared/mcp-dispatch-contracts.ts:344-364`), so the census cannot spell where
 * the store is — the only "where" that crosses the boundary is `storePath`.
 */
const CENSUS_KEYS = [
  'asOf',
  'files',
  'fileCount',
  'jsonlCount',
  'quarantineCount',
  'tempCount',
  'otherCount',
  'totalBytes',
  'censusHash',
  'limits',
] as const;

/**
 * Names that must never appear **anywhere** in the serialized payload (constraint D + the
 * `phase-04:162` success criterion). The set is matched case-insensitively as a substring of any
 * object key, because a naive pass-through leaks exactly these: an `authoritySnapshot` carrying a
 * `runtimeLeaseToken` and a `runtimePid`, per-frame identity fields, and free-form `evidence`.
 */
const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  'runtimeleasetoken',
  'authoritysnapshot',
  'runtimepid',
  'requestid',
  'paramdigest',
  'policydigest',
  'attachmentid',
  'idempotencykey',
  'evidence', // matches `evidenceRefs` too — reassembled from the validated list after sanitizing.
];

/** `evidenceRefs` entries are synthetic identifiers only (`phase-01:193`, `phase-04:35`). */
const EVIDENCE_REF_PATTERN = /^census:[0-9a-f]{8,}#L\d+$/;

/**
 * The service's published key sets, exported so a test can pair them against the shipped gate's lists.
 *
 * One place per surface holds the key sets — here — and the consumers are: `projectEnvelope` (which
 * emits them), `assertProjectedKeys` (which asserts the envelope against the contract interface), and
 * the parity test (which asserts them against `scripts/check-mcp-dispatch-payload.mjs`). Drift between
 * any two of those is a test failure rather than a payload the gate rejects.
 */
export const MCP_DISPATCH_KEY_SETS = {
  envelope: ENVELOPE_KEYS,
  row: ROW_KEYS,
  fileRollup: FILE_ROLLUP_KEYS,
  census: CENSUS_KEYS,
  censusEntry: CENSUS_ENTRY_KEYS,
} as const;

/** Keep exactly the listed keys of an object, then sanitize each value. */
function projectWithKeys(
  value: unknown,
  keys: readonly string[],
  storeLabel: string | null,
): Record<string, unknown> {
  const source = (value && typeof value === 'object' && !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : {};
  const target: Record<string, unknown> = {};
  for (const key of keys) {
    if (isForbiddenKey(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    target[key] = sanitizeProjectedValue(source[key], storeLabel);
  }
  return target;
}

function projectRowArray(value: unknown, storeLabel: string | null): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    rows.push(projectWithKeys(entry, ROW_KEYS, storeLabel));
  }
  return rows;
}

/**
 * Project the census disclosure. `files[]` entries are filtered through {@link CENSUS_ENTRY_KEYS} and
 * the container through {@link CENSUS_KEYS}, so a hostile or newly-added key is dropped rather than
 * published.
 */
function projectCensus(value: unknown, storeLabel: string | null): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const census = projectWithKeys(value, CENSUS_KEYS, storeLabel);
  const files = (value as Record<string, unknown>).files;
  census.files = Array.isArray(files)
    ? files
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => projectWithKeys(entry, CENSUS_ENTRY_KEYS, storeLabel))
    : [];
  return census;
}

/**
 * `evidenceRefs` are rebuilt from scratch: only synthetic `census:<hash>#L<line>` identifiers survive
 * (`phase-04:35`). A path, a frame field or a free-form reference is dropped, never rewritten.
 */
export function projectEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if (!EVIDENCE_REF_PATTERN.test(entry)) continue;
    if (!refs.includes(entry)) refs.push(entry);
  }
  return refs;
}

/**
 * Admit a `reasonCode` only if it is a member of the imported {@link UnmeasuredReason} closed set or
 * the MEASURED literal. It was previously copied verbatim, so
 * `{status:'MEASURED', reasonCode:'C:\\leak\\reason'}` published the path: a reason code is an enum
 * member, never free text.
 */
export function sanitiseReasonCode(value: unknown): string {
  if (typeof value === 'string') {
    if ((Object.values(UnmeasuredReason) as readonly string[]).includes(value)) return value;
    if (value === MEASURED_REASON_CODE) return value;
  }
  return UnmeasuredReason.SERVICE_FAILED;
}

/**
 * The projection at the IPC boundary (constraint D). `raw` is whatever the worker posted; only the
 * allowlisted aggregate fields survive, `storePath` becomes the display label (or stays `null`), and
 * the result is a complete {@link McpDispatchAccount} in every case — never `null`, never a fault
 * object. The casts are sound because the projection only removes keys and replaces location-shaped
 * strings and keys; every surviving key is one the contract already declares.
 *
 * @param raw        the worker's posted envelope (untrusted shape at this boundary).
 * @param storeLabel the display label of the store this service swept, or `null` when unresolved.
 */
export function projectEnvelope(raw: unknown, storeLabel: string | null): McpDispatchAccount {
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  const status: McpDispatchAccount['status'] = source.status === 'MEASURED' ? 'MEASURED' : 'UNMEASURED';
  const label = storeLabel ?? storeDisplayLabel(typeof source.storePath === 'string' ? source.storePath : null);
  // `null` is a first-class state: only an explicit non-null label resolves a store.
  const storePath = typeof source.storePath === 'string' || source.storePath === null
    ? (source.storePath === null ? null : label)
    : label;

  const projected: Record<string, unknown> = {
    status,
    reasonCode: sanitiseReasonCode(source.reasonCode),
    affected: labeliseAffected(source.affected, label),
    evidenceRefs: projectEvidenceRefs(source.evidenceRefs),
    asOf: typeof source.asOf === 'string' ? source.asOf : '',
    storePath,
    census: projectCensus(source.census, label),
    fileRollups: Array.isArray(source.fileRollups)
      ? source.fileRollups
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => projectWithKeys(entry, FILE_ROLLUP_KEYS, label))
      : [],
    rows: projectRowArray(source.rows, label),
    totals: source.totals && typeof source.totals === 'object'
      ? sanitizeProjectedValue(source.totals, label)
      : null,
    reconciliation: source.reconciliation && typeof source.reconciliation === 'object'
      ? sanitizeProjectedValue(source.reconciliation, label)
      : null,
  };

  // The envelope is `McpDispatchAccount` with every key of the frozen contract present. The key set
  // is asserted here so a contract key added upstream cannot be silently dropped: an unknown key in
  // `projected` is a build-time error below, not a runtime surprise.
  assertProjectedKeys(projected);
  return projected as unknown as McpDispatchAccount;
}

/**
 * Guard for the projection's completeness: every key the contract declares must be present in the
 * projected record, and `ENVELOPE_KEYS` must cover the contract exactly. `ENVELOPE_KEYS` is declared
 * `satisfies readonly (keyof McpDispatchAccount)[]`, so a key that is not a contract member is
 * already a build error; this catches the other direction — a contract key nobody publishes.
 */
function assertProjectedKeys(projected: Record<string, unknown>): void {
  const contractKeys: Array<keyof McpDispatchAccount> = [
    'status', 'reasonCode', 'affected', 'evidenceRefs', 'asOf', 'storePath',
    'census', 'fileRollups', 'rows', 'totals', 'reconciliation',
  ];
  if (contractKeys.length !== ENVELOPE_KEYS.length) {
    throw new Error('mcp-dispatch projection: contract and key-set lengths differ');
  }
  for (const key of contractKeys) {
    if (!ENVELOPE_KEYS.includes(key)) {
      throw new Error(`mcp-dispatch projection: contract key ${key} is not in the published key set`);
    }
    if (!Object.prototype.hasOwnProperty.call(projected, key)) {
      throw new Error(`mcp-dispatch projection: contract key ${key} missing from the projected envelope`);
    }
  }
}

/**
 * The single well-formed `UNMEASURED` payload this service publishes: the accounting module's frozen
 * builder, with `affected[]` reduced at this boundary so no path can cross even on the failure paths
 * (constraint D).
 *
 * `census` is left to the builder's default (`null`) **because this call site has no census to
 * offer** — it is the pre-pass refusal/failure path. It is deliberately not a rule about the status:
 * an `UNMEASURED` envelope from the pass may legitimately carry a non-null `census` (census drift, a
 * degenerate ceiling with `limits.filesRead === 0`, a vanished store), and this module passes such a
 * census through untouched rather than scrubbing it as an inconsistency.
 *
 * @param reasonCode a member of the module's closed `UnmeasuredReason` enum.
 * @param affected   mechanism tokens (`phase-01:203`); anything location-shaped is reduced.
 * @param storePath  the separator-free display label, or `null` when nothing resolved.
 */
export function unmeasuredBoundaryEnvelope(
  reasonCode: UnmeasuredReason,
  affected: readonly string[],
  storePath: string | null,
): McpDispatchAccount {
  const reduced = labeliseAffected([...affected], storePath);
  return unmeasuredEnvelope(reasonCode, reduced, storePath);
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export interface McpDispatchServiceOptions {
  /**
   * Resolve the injected store directory. Defaults to Phase 1's sanctioned main-process source —
   * `<dataRoot>/control-plane-v2/invocations` via `StorageLocations.getControlPlaneDir()`
   * (`src/main/config/storage-locations.ts:101-103`, `phase-01:43`). The reader itself never resolves
   * a root (constraint A); this main-process caller may, because `src/main/index.ts:164` initializes
   * the directories before the control plane is wired at `:322`.
   */
  resolveStoreDir?: () => string;
  /**
   * Test seam mirroring `CoreHealthServiceOptions.runCli` (`src/main/diagnostics/core-health.ts:271`,
   * `:282`): replaces the worker spawn with an in-process envelope producer so the memo, the
   * projection and the failure paths are testable without a real pass. Production never sets it.
   */
  runPass?: (options: { storeDir: string; asOf: string; memo: boolean }) => Promise<unknown>;
}

export interface McpDispatchServiceDiagnostics {
  hasMemoEntry: boolean;
  memoKey: string | null;
  storeLabel: string | null;
  lastOutcome: 'memo-hit' | 'pass' | 'pass-failed' | 'none';
}

/** The main-process API of the delivery surface (`phase-04:19`, `phase-04:157`). */
export class McpDispatchService {
  private memoKey: string | null = null;
  private memoValue: McpDispatchAccount | null = null;
  private lastOutcome: McpDispatchServiceDiagnostics['lastOutcome'] = 'none';
  private readonly resolveStoreDir: () => string;
  private readonly runPassOverride?: (options: { storeDir: string; asOf: string; memo: boolean }) => Promise<unknown>;

  constructor(options: McpDispatchServiceOptions = {}) {
    this.resolveStoreDir = options.resolveStoreDir
      ?? (() => path.join(StorageLocations.getControlPlaneDir(), 'invocations'));
    this.runPassOverride = options.runPass;
  }

  /**
   * The separator-free display label of the directory this service would read, or `null`.
   *
   * ## One fact, two labels, on purpose (and stated so nobody has to guess)
   *
   * Both labels on this channel come from the one helper `storeDisplayLabel`. They can still name
   * different directories, and that is deliberate:
   *   - this method labels **the directory this instance was injected with** — the store the next
   *     `getState()` will actually read. In production the injection default is
   *     {@link mcpDispatchStoreLabel}'s directory, so the two coincide;
   *   - the sender-gate refusal in `native-tab-host.ts` labels {@link mcpDispatchStoreLabel} — the
   *     app's canonical store — because a refusal happens before any service instance exists and
   *     therefore has no injected directory to name. It must not imply a store was read.
   *
   * A reader comparing the two must read them as "which store this answer is about" (per-call) and
   * "which store this channel serves" (the refusal). They are never both on the wire at once.
   */
  public getStoreLabel(): string | null {
    return storeDisplayLabel(this.resolveStoreDir());
  }

  /** The projected envelope. Returns within `PASS_BUDGET_MS + worker start + one file read`. */
  public async getState(): Promise<McpDispatchAccount> {
    const storeDir = this.resolveStoreDir();
    const storeLabel = storeDisplayLabel(storeDir);
    const asOf = new Date().toISOString();

    // Stage A: metadata only. Derives the memo key (and nothing else) on the main thread.
    const memoKey = readMemoKey(storeDir);

    if (memoKey !== null && memoKey === this.memoKey && this.memoValue) {
      this.lastOutcome = 'memo-hit';
      // A memo hit returns the original pass's `asOf`; `asOf` is NOT part of the key (DD6).
      return this.memoValue;
    }

    let raw: unknown;
    try {
      raw = this.runPassOverride
        ? await this.runPassOverride({ storeDir, asOf, memo: false })
        : await runWorkerPass(storeDir, asOf);
    } catch (err) {
      this.lastOutcome = 'pass-failed';
      // The worker died or the caller-side await expired. A hung worker is the case the caller-side
      // bound exists for: the SAME outcome is returned either way (constraint G).
      const expired = err instanceof PassBudgetExpiredError;
      return this.checkpoint(
        memoKey,
        expired
          ? unmeasuredBoundaryEnvelope('READ_BUDGET_EXCEEDED', ['budget-expired'], storeLabel)
          : unmeasuredBoundaryEnvelope('SERVICE_FAILED', ['service-failed'], storeLabel),
      );
    }

    if (!hasEnvelopeShape(raw)) {
      this.lastOutcome = 'pass-failed';
      return this.checkpoint(
        memoKey,
        unmeasuredBoundaryEnvelope('SERVICE_FAILED', ['service-failed'], storeLabel),
      );
    }
    this.lastOutcome = 'pass';
    return this.checkpoint(memoKey, projectEnvelope(raw, storeLabel));
  }

  /**
   * Drop the memoized envelope so the next `getState()` runs a fresh pass — mirrors
   * `CoreHealthService.clearCache()` (`core-health.ts:370-372`). The memo has no TTL; this is the
   * explicit escape (`phase-04:29`).
   */
  public clearCache(): void {
    this.memoKey = null;
    this.memoValue = null;
    this.lastOutcome = 'none';
  }

  /** Memo state for tests and diagnostics. Read-only; not part of the wire payload. */
  public getDiagnostics(): McpDispatchServiceDiagnostics {
    return {
      hasMemoEntry: this.memoValue !== null,
      memoKey: this.memoKey,
      storeLabel: this.getStoreLabel(),
      lastOutcome: this.lastOutcome,
    };
  }

  /** Store the finished envelope as the single memo entry, evicted on key change (one entry, no TTL). */
  private checkpoint(memoKey: string | null, value: McpDispatchAccount): McpDispatchAccount {
    if (memoKey !== null) {
      this.memoKey = memoKey;
      this.memoValue = value;
    }
    return value;
  }
}

/** Thrown by the caller-side bounded await; never escapes `getState()`. */
class PassBudgetExpiredError extends Error {
  constructor() {
    super('mcp-dispatch worker pass exceeded the caller-side budget');
    this.name = 'PassBudgetExpiredError';
  }
}

/**
 * Stage A over the injected directory: the accounting module's {@link runPopulationSweep}
 * (`readdirSync` + `statSync` only, no file content — `phase-01:104`), called for its `memoKey`.
 *
 * Calling it here is the sanctioned design, not a main-thread pass: the module documents this exact
 * caller ("the delivery surface computes the same key independently on the main thread before
 * deciding whether to spawn the worker; if the two ever disagreed, the only consequence is a memo
 * miss", `mcp-dispatch-accounting.ts:703-705`). It reads no bytes, folds no frame and never touches
 * the admitted set — that work stays in the worker (constraint G).
 *
 * Returns `null` only when the directory cannot be enumerated at all. The pass then runs and owns
 * `NO_DATA_ROOT_RESOLVED`/`DIR_UNREADABLE`; the memo cannot silently serve an envelope from a store
 * that has since become unreadable.
 */
function readMemoKey(storeDir: string): string | null {
  try {
    return runPopulationSweep(storeDir).memoKey;
  } catch {
    return null;
  }
}

/** Structural shape check: did the worker post an envelope at all? */
function hasEnvelopeShape(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const source = raw as Record<string, unknown>;
  if (source.status !== 'MEASURED' && source.status !== 'UNMEASURED') return false;
  return (
    Object.prototype.hasOwnProperty.call(source, 'rows')
    || Object.prototype.hasOwnProperty.call(source, 'census')
    || Object.prototype.hasOwnProperty.call(source, 'totals')
  );
}

/**
 * Spawn the worker over the compiled, electron-free accounting module and await **exactly one**
 * message. The module owns the worker entry (its `isMainThread` branch), the pass and the in-pass
 * budget check; this function owns the caller-side bound and the termination that keeps `getState()`
 * inside constraint G even when the worker hangs (`phase-01:111`, `phase-04:23`).
 */
function runWorkerPass(storeDir: string, asOf: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const workerPath = path.join(__dirname, 'mcp-dispatch-accounting.js');
    const worker = new Worker(workerPath, {
      workerData: { storeDir, asOf, mode: 'worker' },
    });
    let settled = false;
    let messageSeen = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      fn();
      // Never leave a live thread behind (the module's terminate()-on-expiry, caller side).
      void worker.terminate().catch(() => undefined);
    };

    const timer = setTimeout(() => {
      finish(() => reject(new PassBudgetExpiredError()));
    }, passAwaitBudgetMs());

    worker.once('message', (message: unknown) => {
      messageSeen = true;
      // Exactly one message: anything further is a protocol violation and is ignored.
      worker.removeAllListeners('message');
      finish(() => resolve(message));
    });
    worker.once('error', (err: Error) => {
      finish(() => reject(err));
    });
    worker.once('exit', (code: number) => {
      if (messageSeen) return;
      finish(() => reject(new Error(`mcp-dispatch worker exited with code ${code} without posting a result`)));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Singleton (mirrors `core-health.ts:791-795`)
// ---------------------------------------------------------------------------------------------

let singleton: McpDispatchService | null = null;

export function getMcpDispatchService(): McpDispatchService {
  if (!singleton) singleton = new McpDispatchService();
  return singleton;
}

/** Test seam: replace the singleton's pass producer, or reset it. Never called in production code. */
export function setMcpDispatchServiceForTest(service: McpDispatchService | null): void {
  singleton = service;
}
