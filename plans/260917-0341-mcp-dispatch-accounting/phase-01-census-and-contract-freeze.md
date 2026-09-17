---
phase: 1
title: "Census & Contract Freeze"
status: pending
priority: P0
effort: "6h"
dependencies: []
---

# Phase 1: Census & Contract Freeze

## Overview

Freeze the measurement contract before a single frame is parsed: what the population is, how one snapshot is identified, what every possible per-line outcome is named, how the reading pass is shaped and bounded, and what a payload may claim. This phase performs **no writes, no ledger interaction, and no data-root resolution** — it enumerates an injected directory, reads the bytes it censused, and names everything it could not admit.

This document is the post-red-team revision. It applies `plan.md` *Red Team Review* rows 4 (double synchronous pass on the main thread), 8 (nonexistent `storage-locations` path), 10 (missing structural-invalid class), 12 (`CENSUS_DRIFT` unreachable while the real swap was unguarded), 15 (CLI repo-relative fallback), 21 (non-derivable capability count) plus plan goals 5/7 and locked constraints A, B, D and G. The load-bearing change: the census is **no longer a separate preceding walk that hashes every file**. The retired recipe was `sha256(readFileSync(name))` in its own synchronous pass on top of the reader's read; two reviewers measured the read+parse pass alone at 7.9 s and 11.4 s (`plan.md:60`, `phase-02:29`), so the second hashing pass put one Hub refresh at 15–25 s of blocked Electron main thread — every IPC handler, the terminal PTY pump, tab lifecycle and the ledger's own append path stall behind it, with no yield point anywhere, while the ledger's boot replay deliberately yields every 25 files (`src/main/session/invocation-ledger.ts:131-135`).

The census is now a **by-product of the read**: one content read per file, `stat` → read exactly the censused byte length → `sha256` over the bytes actually read → split → parse/admit, executed **off the main thread** under a declared time budget and a declared input ceiling.

## Requirements

### Functional

**1. Population rule (locked, unchanged from the verified original).**
The population is every entry of the **injected** directory whose name **contains** `.jsonl`. This is deliberately **wider** than the writer's own filter `endsWith('.jsonl')` (`src/main/session/invocation-ledger.ts:126`, `:142`) because the extra shapes are exactly the ones a naive reader loses: `*.jsonl.quarantine-<ts>` (written by `quarantinePartition`, `:265`; 254 frames stranded in the reviewed snapshot, 247 of them checksum-valid) and `*.jsonl.tmp-<pid>-<ts>` (the compaction temp file, `:829`; 0 present in the reviewed snapshot, unlinked on failure at `:848-850` or renamed away at `:843-844`). The rule is wider **on purpose** and the divergence is named here so it stays auditable.

Every matched entry is classified into exactly one bucket by one function, so the counting invariant is a tautology of the classifier rather than an assertion:

| Bucket | Predicate | Reviewed snapshot |
|---|---|---|
| `jsonl` | name ends with `.jsonl` | 1,034 |
| `quarantine` | name contains `.jsonl.quarantine-` | 7 |
| `temp` | name contains `.jsonl.tmp-` | 0 |
| `other` | matched by `includes('.jsonl')`, none of the above (e.g. `a.jsonl.bak`) | 0 |

`fileCount === jsonlCount + quarantineCount + tempCount + otherCount` is therefore true by construction, and it agrees with `plan.md:135`, which now states the same four-term form (`files == jsonl + quarantine + temp + other`). The two-term `files == jsonl + quarantine` is the `tempCount === 0 ∧ otherCount === 0` case of this partition — true in the reviewed snapshot, false mid-compaction — so the reconciliation prints the four-term form.

`other`-bucket files are part of the population and are read: frame identity comes from `frame.attachmentId` (`invocation-ledger.ts:22`), never from a file name, so an unexpected name can contribute frames but can never define one. The writer's own name-derivation (`path.basename(file, '.jsonl')`, `:129`) is **not** a contract this reader may copy.

**2. Zero data-root resolution, and the CLI has no fallback (constraint A).**
The reader takes `dir` as a **parameter** and never calls `StorageLocations` — any `StorageLocations.getDataRoot()` is not a pure read: on a cold cache it runs `mkdirSync`, writes a probe file and `unlink`s it (`src/main/config/storage-locations.ts:52-55`; the module lives under `config/`, **not** `session/`). The Electron main process is safe because directories are initialized at `src/main/index.ts:164` before the ledger is wired at `:322`; a fresh CLI process is not.

- The main process passes `path.join(StorageLocations.getControlPlaneDir(), 'invocations')` — i.e. `<dataRoot>/control-plane-v2/invocations` (`src/main/config/storage-locations.ts:101-103`; the ledger's own `dataRoot` at `src/main/index.ts:322` is that control-plane dir, and `partitionsDir` is built from it at `invocation-ledger.ts:116`).
- The CLI harness accepts `--store <dir>` or `ANTIFAN_DATA_ROOT` **only**. When the env var is used it computes `path.join(root, 'control-plane-v2', 'invocations')` as a pure string join — matching `getControlPlaneDir`'s formula without executing any resolution logic — and it **never calls `StorageLocations`**.
- There is **no repo-relative fallback, no CWD guess, no `%APPDATA%` guess, and no list of plausible paths.** `E:\Work\apps\AntiFan\.antifan-data` does not exist on this machine while the live store is `E:\Work\.antifan-data` (`reports/redteam-failure-modes.md:116`), so a plausible-path ladder resolves to a directory that is absent and would silently report `NO_DATA` for a store that is present. Unresolvable ⇒ `UNMEASURED` + `reasonCode: 'NO_DATA_ROOT_RESOLVED'`, **no probe write**.

**3. Census shape and the `censusHash` recipe.**

```
interface CensusLimits {
  budgetMs: number; maxBytes: number; maxFiles: number;   // declared bounds (below)
  observedBytes: number; observedFiles: number;           // measured by the population sweep (ALL matched files)
  filesRead: number; filesSkipped: number;                // the read prefix vs what the ceiling excluded
  ceiling: 'MAX_CENSUS_BYTES' | 'MAX_CENSUS_FILES' | null; // which bound stopped the read, if any
  windowNewestMtimeMs: number | null;  // newest mtimeMs among the files READ (null when none were)
  windowOldestMtimeMs: number | null;  // oldest mtimeMs among the files READ (null when none were)
  elapsedMs: number;
  outcome: 'COMPLETE' | 'POPULATION_TRUNCATED';
}
interface Truncation {                 // frozen sub-shape Phase 3 renders verbatim as totals.truncation
  ceiling: 'MAX_CENSUS_BYTES' | 'MAX_CENSUS_FILES';
  filesRead: number;
  filesSkipped: number;
  order: 'mtimeMs-desc,name-asc';      // the selection order IS part of the disclosure
}
interface CensusEntry {
  name: string;
  bucket: 'jsonl' | 'quarantine' | 'temp' | 'other';
  size: number;        // bytes ACTUALLY READ by this pass (never a stale pre-read size)
  mtimeMs: number;     // post-read stat where the file still exists
  lineCount: number;   // non-blank segments in the bytes read
  sha256: string;      // sha256 over exactly the bytes read
  consistency: 'clean' | 'post-census-append' | 'post-census-truncate' | 'vanished' | 'rewritten-identical';
}
interface Census {
  asOf: string; files: CensusEntry[];   // NO directory field — see the note under this block
  fileCount: number; jsonlCount: number; quarantineCount: number; tempCount: number; otherCount: number;
  totalBytes: number; censusHash: string | null; limits: CensusLimits;
}

> **The census carries no directory, and that is deliberate.** An earlier revision of this phase declared `dir: string` on `Census` while also banning paths anywhere in the envelope, which left the module owner guessing whether to strip it. The delivered design removes the field entirely: the reader receives the directory as an argument (`FrameReadOptions.storeDir`, required) and `storeDisplayLabel(dir)` is the **only** spelling of "where" that crosses a boundary, via `storePath` and `affected[]`. Any consumer that referenced `Census['dir']` must read `FrameReadOptions.storeDir` instead. There is no key to project, so no projection rule is needed and no path can leak by omission — the safest shape is the one where the leak has nowhere to live.
>
> **`VANISHED` is a residue class, not an `UnmeasuredReason`, and the seven-member reason set stays closed.** A store whose only partition vanishes before it can be read yields `UNMEASURED` with `reasonCode: 'NO_DATA'` **and a non-null `census`** — the census *is* the answer, because it records what was there and that the bytes are gone — while `VANISHED` appears in the residue histogram. Adding a member would widen a frozen enum to say something the residue histogram already says precisely, and would break every consumer that enumerates the set. **The consequence Phase 4 must honour: an `UNMEASURED` envelope may carry a non-null `census`**, so `status === 'UNMEASURED'` must never be read as "empty store", and never as "`census === null`". `NO_DATA` publishes the census only when `limits.filesRead > 0`; a genuinely empty store still reports `census: null`.
interface FileRollup {                 // the frozen per-file roll-up the quarantine margin is built from
  file: string;            // the entry's name, verbatim
  quarantineLike: boolean; // name contains '.quarantine-'
  tempLike: boolean;       // name contains '.tmp-'
  frames: number;          // non-blank segments read from that file's bytes (== its CensusEntry.lineCount)
  admitted: number;
  namedInvalid: number;    // every non-ADMITTED named residue class for that file
}
```

`censusHash` = `sha256` over `name`-sorted entries of `"<name>\0<size>\0<sha256>\n"`. It is content-derived, so a same-size in-place rewrite is detectable, and — the F1/F4 fix — by construction **every byte it covers was consumed by this pass**. Its stated invariant: *a `censusHash` can never describe bytes the pass did not read.* `censusHash` is `null` only when nothing was read at all (the degenerate truncation case in §4) — never as a placeholder for a hash that could not be computed, and never as a census of a store it only partially covers.

The hash's **name** sort is applied to the published entry list, not to the read order: the read order is newest-first (§4) while `census.files` and `censusHash` are name-sorted, so a partial census is a *deterministic* hash of exactly the files it covers and `filesRead`/`limits.ceiling` say how much that is. `windowNewestMtimeMs`/`windowOldestMtimeMs` state the covered window so a partial answer reads as "recent activity, not all history" (`plan.md:80`); Phase 3 and Phase 4 render those two fields and must not re-derive the window from `census.files` — one source, both sides.

**Per-file roll-up identity (asserted, not assumed):** for every `FileRollup`, `frames === admitted + namedInvalid`. Each roll-up is produced by the same pass that produced the residue rows — never by a re-scan — and the roll-ups are the **only** input Phase 3 uses to build `totals.quarantineMargin = { label, files, framesPresent, framesAdmitted, framesNamedInvalid, reasons[] }`: `files` = count of `quarantineLike` roll-ups, `framesPresent` = Σ `frames`, `framesAdmitted` = Σ `admitted`, `framesNamedInvalid` = Σ `namedInvalid`, satisfying `plan.md:140`'s `quarantineFrames == admittedFromQuarantine + namedInvalid`; `reasons[]` = the distinct `reason`/`class` values carried by the residue rows of those same `quarantineLike` files within the same pass. Phase 3 must not open a file or re-derive any of these numbers. The roll-up belongs to the **read** (stage B), not to the stage-A sweep, which cannot know admission counts; it travels on the pass result as `fileRollups` (§9), ordered by the same newest-first read order as the pass (`census.files` itself stays name-sorted, per §3).

`mtimeMs` is deliberately **not** in `censusHash`: the hash answers "what content was measured", while the memo key answers "was anything touched" (`plan.md:60`, `phase-04:25` — memo key `sha256(sorted(name:size:mtimeMs))`, with `asOf` excluded). Two different questions, two different inputs.

`lineCount` (non-blank segments, the same predicate the ledger uses at `:177`) is recorded because the store both **grows and shrinks**: compaction coalesces superseded frames into one per `idempotencyKey` and replaces the partition (`:819-846`), `pruneDeadPartitions` unlinks (`:142-155`), quarantine renames (`:265-269`). Measured live: an identical file set (1,041 files) with lines falling 20,145 → 19,167 within minutes (`plan.md:165`, `:222`). Without a censused line count, a short read is indistinguishable from a smaller store.

**4. The pass: one content read per file, off the main thread, bounded (plan goal 5, constraint G).**

Two stages, and only the second one reads content:

- **Stage A — population sweep (metadata only, no file content).** `readdir` + one `stat` per matched name → bucket, `sizeA`, `mtimeMsA`, plus `observedFiles` / `observedBytes` over all matched files (the totals the read-time ceiling is evaluated against) and the memo key. This sweep is **not** the retired double pass: it reads no bytes and computes no hash. It is the same sweep the memo key requires (`plan.md:60`, `phase-04:25`), and it is O(1) metadata per file.
- **Stage B — the single content pass (per file, in the worker).** `stat` → **read exactly `sizeA` bytes** → `sha256` over the bytes actually read → split → classify → post-read `stat` consistency check (§5). No second content read of a file happens unless the post-read check demands a re-hash.

Execution rules, all frozen here because Phase 2 implements them:

- The pass runs in **`node:worker_threads`**, loaded from the compiled, electron-free module itself: the compiled CJS entry is handed to `new Worker(...)` — [INFERENCE] the loading idiom is not precedent-backed, `worker_threads` has **zero** matches in `src/` today (verified read-only), so the implementation must use the compiled module path and must not import `electron`; the module branches on `isMainThread` and only the worker branch runs the pass. `structuredClone`-safe plain data only on the message.
- **The Electron main process never runs the pass and never holds the admitted frame set.** The main process receives the projected envelope. Constraint G is enforced structurally: `readAdmittedFrames` has **exactly one call site** and it lives in the pass core; main-thread code cannot reach it.
- **Hard budget:** the pass checks the clock before each file and aborts between files, so the bound is `PASS_BUDGET_MS + one file read`. On expiry the payload is `status: 'UNMEASURED'`, `reasonCode: 'READ_BUDGET_EXCEEDED'`, `census: null`, `rows: []`, `totals: null`, and `affected` naming the mechanism as a symbolic token (`['budget-expired']`, plus the store's display label when a store was resolved — never the absolute path, §9); the worker is `terminate()`d and never awaited past the budget. The caller-side await is also bounded — never unbounded — so `McpDispatchService.getState()` returns within `PASS_BUDGET_MS + worker start + one file read` even if the worker hangs, and returns the same `READ_BUDGET_EXCEEDED` envelope in that case (`plan.md:141`).
- **In-process fallback** (worker construction/`online` failure, or an explicit CLI switch): the identical core, run on the calling thread, **yielding every 25 files** exactly as the ledger's boot replay does (`invocation-ledger.ts:131-135`), under the same budget and the same constants, and — because it is in-process — using the **incremental** frame sink so the whole `result`-bearing frame set is never materialised. `readAdmittedFrames(census)` is the materialising convenience wrapper over that sink; it is permitted only where the pass core owns the process (worker, CLI) and is **forbidden** in the Electron main thread.
- **Declared input ceiling — never read an unbounded input (constraint G, second half). Files are read newest-first: `mtimeMs` descending, `name` ascending as the tie-break.** The order is a frozen part of the disclosure, not an implementation detail, and the reason is stated here so no later refactor "tidies" it back: a name-sorted prefix would read only the partitions whose names sort first, zeroing out every tool whose partitions sort late — which renders on screen as "never called", a lie of omission (`plan.md:80`).
- **What the ceiling does** (the same class of incompleteness as a short read, so it is disclosed the same way): the pass stops as soon as adding the next file would push the cumulative read past `MAX_CENSUS_BYTES` or the read count past `MAX_CENSUS_FILES`; the files actually read are censused and admitted normally and **rows are rendered over them**, all marked `lowerBound: true` (Phase 3), with `limits.outcome: 'POPULATION_TRUNCATED'`, `limits.ceiling` naming the bound, `limits.filesRead` / `limits.filesSkipped`, `limits.windowNewestMtimeMs` / `windowOldestMtimeMs` for the covered window, `totals.truncation = { ceiling, filesRead, filesSkipped, order: 'mtimeMs-desc,name-asc' }`, and a label reading `partial: N of M files`. A partial **file set** is merely incomplete and countable, which is why it renders; a partial **fold** (the budget case above) is untrustworthy, which is why it does not (`plan.md:80`). `censusHash` covers the files read while `fileCount` is the **full** matched count, so two truncated runs stay distinguishable by snapshot identity.
- **What the ceiling does not do.** It never blanks the feature, and it never silently reads the whole store. The shortfall is named by count, ceiling and order (`filesSkipped`, `ceiling`, `order`, the `partial: N of M files` label) and is deliberately **not** enumerated by partition file name inside the shared envelope: a partition name is a session identity, and constraint D admits aggregate fields plus a display label only (`plan.md:74`). Enumerating the skipped set, if a surface wants it, is a CLI-stdout-only affordance — never a field of the shared envelope.
- **Degenerate case:** zero files read (the newest file alone exceeds the byte ceiling) ⇒ `limits.filesRead: 0`, `censusHash: null`, both window fields `null`, `status: 'UNMEASURED'`, `reasonCode: 'POPULATION_TRUNCATED'`, `affected: ['population-truncated', <store display label>]`, `rows: []`, `totals: null` — there is nothing to render. (Note the token: the ceiling is **not** an `affected` token, so this case names the truncation mechanism, exactly as §7 records; an earlier revision of this bullet said `'ceiling:MAX_CENSUS_BYTES'`, which no member of the frozen `AffectedToken` produces.)

The three bounds are **policy bounds declared here, not measurements**, and are exported as single named constants so nothing downstream can fork them:

| Constant | Value | Why this value (snapshot only justifies headroom) |
|---|---|---|
| `PASS_BUDGET_MS` | `20000` | ≈1.75× the slower of the two measured single passes (7.9 s / 11.4 s) over the same ~230–240 MB store |
| `MAX_CENSUS_BYTES` | `512 * 1024 * 1024` | ≈2.1–2.2× the measured 240.8 MB total (independent passes reported 229.7 MB and 240.8 MB — units as each pass reported them, not re-derived here); the largest single partition measured 143,203,927 B (136.6 MiB), so no one file approaches it |
| `MAX_CENSUS_FILES` | `4096` | ≈3.9× the measured 1,041 files |

The budget and ceiling are also what keeps the reader honest about a store that is **append-only by construction**: quarantine files are never replayed or pruned and live partitions are append-only (`:126`, `:142`, `:260-271`), so the input grows monotonically with normal product use and retention is explicitly out of scope (`plan.md:44`, `:215`). An unbounded pass would make the tab's cost a function of store lifetime rather than of the current snapshot.

**5. Snapshot-consistency checkpoints (the F4 fix).**

The hazard F4 proved is not a truncation at the census boundary: the ledger's compaction path writes a temp file and renames it over the partition (`:843-844`), and a boot replay compacts **every** partition holding a `claiming`/`in_progress` frame (222 such frames were live at review time; the trigger is `:241`/`:256` → `:819-846`). A partition can therefore be swapped between the census and the read, yielding a payload whose census hash describes bytes that were never read — with **zero** torn tails and **zero** checksum mismatches, so nothing else fires. Because the census hash now covers the bytes actually read, that specific defect is structurally impossible; the checkpoints below make the remaining population-level inconsistency explicit and classify it.

Per file, three observations: `(sizeA, mtimeA)` from stage A, the `n` bytes actually read in stage B with `h = sha256(bytes)`, and `(sizeC, mtimeC)` from the **post-read `stat`**:

| Post-read observation | Class | Effect |
|---|---|---|
| `ENOENT` | `VANISHED` | file gone (prune `:142-155`, quarantine rename `:265-269`); entry records `vanished`, rows become `lowerBound: true` |
| `sizeC < sizeA` | `POST_CENSUS_TRUNCATE` | the file yielded fewer bytes than its census entry; the entry's `size`/`sha256` describe the bytes read |
| `sizeC > sizeA` | `POST_CENSUS_APPEND` | bytes past the censused bound; the tail is **counted, never read** (`sizeC − sizeA`) — reading it would reintroduce a non-reproducible total |
| `sizeC === sizeA ∧ mtimeC === mtimeA` | clean | the file is provably unchanged across the whole window |
| `sizeC === sizeA ∧ mtimeC ≠ mtimeA` | **re-read and re-hash**: `h' !== h` ⇒ `CENSUS_DRIFT`; `h' === h` ⇒ `rewritten-identical` | `CENSUS_DRIFT` ⇒ **`UNMEASURED`, `reasonCode: 'CENSUS_DRIFT'`, `rows: []`** (fail closed — the aggregate would mix two store states); a content-preserving rewrite keeps the entry and is not drift |

The entry's published `size` is always the number of bytes actually read and `sha256` is always the hash of those bytes — a stale pre-read pair is never published. Stated limitation [INFERENCE]: an in-place content change that preserves **both** size and `mtimeMs` is not detected by this check; it is bounded by the hash invariant (no published hash can describe unread bytes) and disclosed by `asOf`, and it is the only residual hole in this checkpoint set.

**6. Residue taxonomy — CLOSED set of exactly nine members, frozen here.** Phases 2 and 3 switch on this exhaustively, so the member list below is the contract; the prose list and the checklist table agree member-for-member, and no phase may add one without editing this file:

```
1  ADMITTED
2  STRUCTURAL_INVALID    reason: 'missing-identity' | 'unsupported-format-version'   (evaluated BEFORE checksum)
3  CHECKSUM_MISMATCH     reason: 'writer-canonicalization-array-slot' | 'unexplained'
4  TORN_TAIL
5  UNPARSEABLE
6  RESIDUE_NO_CHECKSUM
7  POST_CENSUS_APPEND
8  POST_CENSUS_TRUNCATE
9  VANISHED
```

`STRUCTURAL_INVALID` closes the F6 gap: the ledger rejects frames **structurally** at `invocation-ledger.ts:188` — `!frame.id || !frame.idempotencyKey || !frame.attachmentId || frame.formatVersion !== 1` — and quarantines the whole partition on the first such frame (`:190-202`). The old closed enum had no class for this, so a checksum-valid `formatVersion: 2` frame would have been **ADMITTED and counted as a real dispatch**. Frozen sub-reasons:

- `reason: 'missing-identity'` — object-shaped line whose `id`, `idempotencyKey` or `attachmentId` is falsy, or a line that parses to a non-object (`null`, number, array, string; the ledger reaches the same verdict through its `catch` at `:246-249`, which quarantines the partition, so the reader must not throw).
- `reason: 'unsupported-format-version'` — `formatVersion !== 1` (including absent).

`CHECKSUM_MISMATCH`'s diagnostic `reason` is a closed two-member set: `'writer-canonicalization-array-slot'` when the `null→undefined` variant reproduces the recorded checksum, `'unexplained'` otherwise. It is a **sub-reason of an already-failed line**, never an admission.

**Classification order (frozen; Phase 2 implements it):**

```
0. byte-offset boundary test first: a segment at/after the censused bound  → POST_CENSUS_APPEND
1. JSON.parse throws: last non-empty segment of a file with no trailing '\n' → TORN_TAIL
                      otherwise                                              → UNPARSEABLE
2. STRUCTURAL_INVALID: missing-identity | unsupported-format-version        (mirrors :188)
3. no string `checksum`                                                     → RESIDUE_NO_CHECKSUM (:193)
4. strict sha256(canonicalJsonStringify(frame minus checksum)) !== checksum  → CHECKSUM_MISMATCH
                      (the null→undefined array-slot variant is a NAMED SUB-REASON of an
                       already-failed line, never a normalization applied before hashing)
5. otherwise                                                                → ADMITTED
```

Step 2 is evaluated **before** step 4 — that is the F6 ordering, and it mirrors the ledger exactly. Step 0 is first because it is otherwise unobservable from a bounded read (`plan.md:192`). Strict checksum alone decides admission (`plan.md:52`); `src/shared/control-plane-contracts.ts:508-511` is why the variant exists and is never an admission, and 5 live frames contain all-null arrays that pass strict while failing the variant — a reader that normalizes before hashing loses them (`phase-02:97`, `:131`).

**7. `UNMEASURED` reasons — closed enum, frozen here.**
`NO_DATA_ROOT_RESOLVED`, `NO_DATA`, `DIR_UNREADABLE`, `CENSUS_DRIFT`, `READ_BUDGET_EXCEEDED`, `POPULATION_TRUNCATED`, `SERVICE_FAILED`.

`READ_BUDGET_EXCEEDED` and `POPULATION_TRUNCATED` are the two new members required by plan goal 5 / constraint G. **Every `UNMEASURED` reason renders through one envelope shape**, which Phase 3 and Phase 4 share: `status: 'UNMEASURED'`, `rows: []`, `totals: null`, `reconciliation: null`, the reason in `reasonCode`, and the mechanism named in `affected` as a **symbolic token plus the store's display label** — never an absolute path (§9). **The canonical token set is the frozen `AffectedToken` const in `src/shared/mcp-dispatch-contracts.ts`, and every consumer must derive from it (`Object.values(AffectedToken)`) rather than restating the strings.** An earlier revision of this document listed `'unresolved-data-root'`, `'ceiling:MAX_CENSUS_BYTES'` and `'ceiling:MAX_CENSUS_FILES'`; the delivered enum contradicts all three — the first by name (**`no-data-root-resolved`**) and the last two by **existence**, because a ceiling is disclosed through `limits.ceiling` and `totals.truncation` and is deliberately not an `affected` token at all. That distinction is worth stating: a token nothing emits is a branch and a test that can never fire, which reads as coverage while covering nothing. The delivered members are `'no-data-root-resolved'`, `'dir-unreadable'`, `'budget-expired'`, `'population-truncated'`, `'census-drift'`, `'service-failed'`, and `'no-data'` (the delivery surface's own empty-population case, which the accounting pass does not publish because there the store label is already the mechanism). The two new members then differ in where they can appear:

- `READ_BUDGET_EXCEEDED` — a **time** expiry. The partial in-memory fold is discarded and nothing is published: `UNMEASURED`, no rows (constraint G).
- `POPULATION_TRUNCATED` — an **input** ceiling. It is normally a *disclosed* condition over the files actually read (rows present and rendered, every row `lowerBound: true`, `totals.truncation` set, covered window stated) and therefore `MEASURED`, **not** this enum; it appears in `UnmeasuredReason` only in the degenerate `filesRead === 0` case, where there is no prefix to render.

**8. Latency-provenance classification — frozen here.**
`owner-written` | `excluded-unknown-state` | `excluded-replay-provenance`. Phase 3 owns the union exclusion rule (`plan.md:72`); this phase only names the three labels so no surface invents a fourth.

**9. Envelope — frozen, key names verbatim** (Phases 3 and 4 render these unchanged; nothing in Phases 2–4 may add a top-level key without updating this file):

```
{ status: 'MEASURED' | 'UNMEASURED', reasonCode: string, affected: string[],
  evidenceRefs: string[], asOf: string, storePath: string | null,
  census: Census | null, fileRollups: FileRollup[], rows: Row[],
  totals: Totals | null, reconciliation: Reconciliation | null }
```

`fileRollups` is the one key added by this revision and it is a **frozen input contract for Phase 3** (the quarantine margin). It carries the per-file `{ file, quarantineLike, tempLike, frames, admitted, namedInvalid }` roll-up defined in §3, in the newest-first read order; it is `[]` only when nothing was read. Phase 3 builds `totals.quarantineMargin` by summing these roll-ups and `totals.truncation` from `census.limits` — it must not re-scan and must not open a file.

**The `affected` / `storePath` rule — this is a two-sided contract with Phase 4, which projects `affected[]` at the IPC boundary.** `affected` carries **no path**: every entry is either the **display label** (the same string as `storePath`, which is itself the display label — `plan.md:74` keeps the absolute path in the on-disk receipt and the CLI stdout, never in the renderer payload) or a symbolic mechanism token from the closed set frozen in §7 — whose canonical source is `AffectedToken` in `src/shared/mcp-dispatch-contracts.ts`, not a list repeated here (an earlier revision repeated a six-token list at this line and again at §7, and both copies drifted from the code; one list, one implementation). **No entry may contain `/`, `\` or a drive-letter prefix**, and the pass must never put the directory it was handed into `affected`. Because a display label is a label and not a path, the label format is intentionally not specified here beyond that hard rule — this phase only guarantees "no separator, no drive letter, derived from the injected input, never from a re-resolution". **The canonical implementation is the exported `storeDisplayLabel` (the final path segment, e.g. `invocations`), and every surface must call it rather than restate a literal**: an earlier revision of Phase 4 asked for "the final two path segments", which is unsatisfiable under the separator ban and produced two different labels for one store on two surfaces. `storePath` is `string | null`: it is the same display label when a store was resolved and **`null` when nothing resolved at all** (the `NO_DATA_ROOT_RESOLVED` case), never an invented placeholder string; the unresolved case is rendered by Phase 4's own copy, driven by `reasonCode`.

Three rules on the frozen envelope, all from constraint D:

- `census`, `fileRollups`, `limits` and `rows` carry counts, sizes and hashes only. No raw frame field, no `authoritySnapshot` (`invocation-ledger.ts:32`), no `runtimeLeaseToken`, no `requestId`, no `paramDigest`, no absolute path anywhere in the envelope — `storePath` included.
- `evidenceRefs` entries may match **only** `/^census:[0-9a-f]{8,}#L\d+$/` — synthetic identifiers, never a raw path or a frame field.
- Every `UNMEASURED` payload uses the single shape named in §7 (`rows: []`, `totals: null`, `reconciliation: null`, mechanism in `affected`), whatever the reason.

### Non-functional

- **Zero writes.** The module never creates a directory, never probes, never touches a partition, and never calls `StorageLocations`. It contains no `writeFile`, `writeFileSync`, `mkdir`, `mkdirSync`, `appendFile`, `appendFileSync`, `createWriteStream`, `unlink`, `rm`, `rename` or `truncate` call. The worker communicates through `postMessage`; it must not stage anything through a temp file. Read-only opens only.
- **`asOf` is injected**, never read from the clock inside the pass, so a frozen-copy run can pin it and two runs are comparable; the injected clock used for the budget is a separate seam (`clock?: () => number`, default `Date.now`) so budget expiry is testable without sleeping.
- **No `electron` import, no ledger value import.** The module's runtime dependency set is exactly `node:*` and `../../shared/control-plane-contracts` (for `canonicalJsonStringify`, exported at `:506`); the frame type comes in through `import type { InvocationRecord } from '../session/invocation-ledger'` (`:19-45`), which is **erased at runtime**, so the `InvocationLedger` class is never linked and `initialize()` is structurally unreachable — the same rule Phase 2 states for the reader (`phase-02:26`). It must be `require`-able from a plain Node process (the Phase 4 CLI depends on it). The byte-ceiling constant `DEFAULT_MAX_INVOCATION_FRAME_BYTES` is **not** value-imported from `invocation-ledger.ts:13`: per constraint B it moves into the Phase 2 seam module (`src/main/session/invocation-frame-checksum.ts`) and is re-exported by the ledger. Phase 1 therefore declares **no default and no literal** for it — `maxFrameBytes` is an injected option and the value is supplied by the Phase 2 seam at the call site, which keeps this phase and the seam extraction order-independent (`phase-02:159`) while leaving exactly one source of truth for the ceiling. The extraction's certification side effect is the seam change's, not this phase's: the compiled ledger is an input to `computeBuildIdentity()`, so re-certification must happen in the same change (`plan.md:70`).
- **`ENOENT` per file is tolerated**, at every `stat` and at the read. One vanished file never fails the pass: it is classified `VANISHED` and the pass continues. The ledger prunes partitions (`:139-157`) while the reader is running, so this is the normal case, not an error path.
- **Determinism:** two runs over one unchanged directory with the same injected `asOf` produce byte-identical censuses (name-sorted `census.files` and `censusHash`, `fileRollups` in the deterministic newest-first order, no clock reads except the injected budget clock, no map iteration order in the published shape). The selection order is total and reproducible: `mtimeMs` descending with a `name`-ascending tie-break, so two files sharing an `mtimeMs` never race.

## Measured scale — snapshots, re-derived at run time, never asserted as constants

Reviewed snapshot (2026-09-17, live store, independent passes agree unless noted): 1,041 entries = 1,034 `*.jsonl` + 7 `*.jsonl.quarantine-*` + 0 `*.jsonl.tmp-*`; 229.7–240.8 MB total across independent passes (units as each pass reported them); largest single partition 143,203,927 B (136.6 MiB); largest line 3.8 MB; 50 lines > 1 MB; 0 lines > 10 MB. The largest quarantine file measured 473 KB, far below `DEFAULT_MAX_INVOCATION_FRAME_BYTES` (64 MB, `invocation-ledger.ts:13`) — so **none of the 7 was quarantined for oversize**; all entered through the checksum/mismatch path (`:197-202`). Frame totals moved 19,096 / 19,164 / 19,215 admitted across passes, and an identical file set showed 20,145 → 19,167 lines within minutes.

```
Snapshot identity : (fileCount, censusHash, asOf)     ← what makes two runs comparable
Live-store caveat : the store is appended to concurrently and compacted by another process.
                    Acceptance runs on a FROZEN COPY and the payload always prints `asOf`.
```

**No number in this file may be hard-coded** — not in code, tests or assertions (`plan.md:135`). `plan.md` states no capability count and neither does this phase: 185 static register sites and 121 proxy definitions are not a capability count, and `capabilities.listAll()` cannot be enumerated read-only (`plan.md:202`). If a later phase needs the advertised-population size it must state the method it used, or omit the number.

## Related Code Files

- Create: `src/main/diagnostics/mcp-dispatch-accounting.ts` — contracts (enums, envelope, `Census`, limits), the population sweep, the pass core and its worker entry; Phases 2–4 extend this same module (one reader, one service)
- Create: `test/main/mcp-dispatch-accounting-reader.test.ts` — census/pass fixtures (Phase 2 extends it with the line-reader matrix)
- Read-only reference: `src/main/session/invocation-ledger.ts:116` (`partitionsDir`), `:126`/`:142` (the writer's narrow filter), `:131-135` (the yield precedent), `:177-178` (whole-file read + oversize), `:186-202` (`:188` structural reject, `:193` checksum presence, `:197-202` mismatch), `:246-249` (catch → quarantine), `:260-271` (quarantine rename), `:790-811` (append shape), `:819-846` (`:829` temp, `:841` trailing newline, `:843-844` rename, `:848-850` cleanup), `:13` (max frame bytes)
- Read-only reference: `src/main/config/storage-locations.ts:29-71` (data-root resolution and its write hazard; `:33-35` env early return, `:41-46` candidates, `:52-55` `mkdirSync` + `.probe-<pid>-<ts>` + `unlinkSync`), `:101-103` (`getControlPlaneDir`), `:116-136` (`ensureDirectories`); `src/main/index.ts:164` (directories before wiring), `:322` (`dataRoot: StorageLocations.getControlPlaneDir()`)
- Read-only reference: `src/shared/control-plane-contracts.ts:506-511` (`canonicalJsonStringify` exported; array branch)

## Implementation Steps

1. Define the enums (`ResidueClass` + `StructuralInvalidReason` + `ChecksumMismatchReason`, `UnmeasuredReason`, `LatencyProvenance`) and the `Census` / `CensusEntry` / `CensusLimits` / `McpDispatchAccount` types in `src/main/diagnostics/mcp-dispatch-accounting.ts`. Freeze the envelope keys verbatim (§9). Every enum is switched exhaustively at its consumer so a new outcome cannot be invented in a later phase without touching this file — and so a class the *ledger* can already produce (`STRUCTURAL_INVALID`, `:188`) is representable here.
2. Declare and export the three policy bounds and the yield interval as single named constants (`PASS_BUDGET_MS`, `MAX_CENSUS_BYTES`, `MAX_CENSUS_FILES`, `IN_PROCESS_YIELD_INTERVAL_FILES = 25`). No call site may inline a literal; the bounds are injectable (`limits`, `clock`) **only** so tests can drive the ceiling and the budget with small fixtures, and a test asserts the defaults are the exported constants. Document each value as a policy bound whose headroom is justified by the snapshot above, never as a measurement. `CensusLimits.ceiling` stores the constant **name** (`'MAX_CENSUS_BYTES'` / `'MAX_CENSUS_FILES'`), never a duplicated numeric literal.
3. Implement the **stage A population sweep**: `readdir` on the injected dir, one `stat` per matched name, bucket classification through one classifier function, `observedFiles`/`observedBytes` over **all** matched files (the inputs the ceiling is evaluated against during the read), and the memo key `sha256(sorted(name:size:mtimeMs))` for the caller. `ENOENT` at this point is `VANISHED`, not fatal. **This stage reads no file content.**
4. Implement the **stage B pass core** as the single content pass over the **newest-first file list** (`mtimeMs` descending, `name` ascending tie-break, taken from stage A's stats): per file `stat` → read exactly the censused `sizeA` bytes → `sha256` over the bytes actually read → split → classify in the frozen order of §6 → post-read `stat` and the §5 consistency table (including the re-read/re-hash on an equal-size `mtime` change) → emit that file's `FileRollup` from the same pass. Publish the entry's `size`/`sha256` from the bytes read, never from the pre-read pair. Stop before a file that would exceed `MAX_CENSUS_BYTES`/`MAX_CENSUS_FILES`, recording `limits.ceiling`/`filesRead`/`filesSkipped`/`windowNewestMtimeMs`/`windowOldestMtimeMs` and `limits.outcome: 'POPULATION_TRUNCATED'` (§4); sort `census.files` by name for publication (the hash recipe) while `fileRollups` keeps read order. Check the budget before each file; on expiry discard the partial fold and abort with `READ_BUDGET_EXCEEDED` (never publish a partial census).
5. Implement the worker entry and the fallback: branch on `isMainThread`; the worker branch runs stages A+B and posts the projected envelope; the main-thread API awaits it with a timer and `terminate()`s on expiry. Implement the in-process fallback over the same core, yielding every 25 files, used by the CLI and by a worker-construction failure. Expose the incremental frame sink and make `readAdmittedFrames` a wrapper over it.
6. Build the `censusHash` from the published entries exactly as specified (name-sorted, `\0`-separated, over the bytes-read hash). Document in the module comment that the hash's invariant is "covers only bytes this pass read" — the property that makes the retired torn-snapshot defect structurally impossible.
7. Document the forbidden API surface as a module-level comment block, with reasons and exact anchors: `InvocationLedger.initialize()` (`:121-137` — creates the dir, replays, re-quarantines, renames files, synthesizes terminal states), `pruneDeadPartitions()` (`:139-157` — unlinks partitions), `settleInFlightForShutdown()` (appends frames), `getStats()` (hot partitions only; its `quarantinedPartitionCount` comes from an in-memory set that is empty after a restart, `:105`, and a quarantined partition's counts are deleted from `persistedFrameCounts` at `:263` — see `plan.md` constraint F), `getRecord()`, `isQuarantined`/`isPoisoned` (`:159-165` — in-memory, empty after restart), and `StorageLocations.getDataRoot()` (`src/main/config/storage-locations.ts:52-55` — probe-writes on a cold cache).
8. Write the fixtures in `test/main/mcp-dispatch-accounting-reader.test.ts` against temp directories the test creates: nested `*.jsonl`, one `*.jsonl.quarantine-<ts>`, one `*.jsonl.tmp-<pid>-<ts>`, one `*.jsonl.bak`, one `e.txt`; plus missing-dir, empty-dir and over-ceiling cases. **Every fixture that asserts selection order sets its `mtimeMs` explicitly with `fs.utimesSync`**, so newest-first and the `name`-ascending tie-break are deterministic rather than filesystem-timing dependent. The ceiling and budget rows drive the **injected** `limits` and `clock`, so no test allocates a 512 MiB file and no test sleeps. The pass takes an optional test-only hook pair (`afterPopulationSweep(name)`, `afterRead(name)`), defaulting to a no-op, so the mid-pass mutation rows below are runnable without touching production paths.
9. Prove the invariants mechanically, in-source and on-disk:
   - tree-hash the temp tree before and after a full pass, assert equality;
   - assert the module source contains no `writeFile`/`writeFileSync`/`mkdir`/`mkdirSync`/`appendFile`/`appendFileSync`/`createWriteStream`/`unlink`/`rm`/`rename`/`truncate`;
   - assert no `electron` import and no import specifier matching `/storage-locations/`;
   - assert the cited module path `src/main/config/storage-locations.ts` **exists on disk**, so a future move of the hazard module fails the gate instead of silently invalidating this citation (the F2 mechanism, not just the F2 wording);
   - assert `readAdmittedFrames` has exactly one call site and that it is inside the pass core, never in main-thread code;
   - assert `node -e "require('./.compiled/src/main/diagnostics/mcp-dispatch-accounting.js')"` succeeds from a plain Node process.
10. Gate: `npm run typecheck && npm run compile && npm run test:file -- .compiled/test/main/mcp-dispatch-accounting-reader.test.js`. The pass/core assertions run in `test:main` once Phase 2 lands its matrix.

## Success Criteria

- [ ] Stage A reads no file content; the pass performs exactly **one content read per file** and `sha256` covers exactly the bytes that read returned (asserted by counting read bytes: `sum(files[*].size) === bytesReadByThePass`).
- [ ] `fileCount === jsonlCount + quarantineCount + tempCount + otherCount` on the fixtures and on a live-shaped fixture set; `*.jsonl.quarantine-*`, `*.jsonl.tmp-*` and `*.jsonl.bak` are all inside the population, `*.txt` is not, and no fixture label calls an included file "non-matching".
- [ ] `censusHash` is stable across runs on an unchanged directory, changes when any file's **content** changes at constant size, and is `null` only in the degenerate truncation case where nothing was read (never as a placeholder for a hash that could not be computed).
- [ ] Every file entry carries `lineCount`, and a file whose later read yields fewer lines is detectable as `POST_CENSUS_TRUNCATE` (Phase 2/3 behaviour) rather than silently reducing totals.
- [ ] The pass executes in a `node:worker_threads` worker by default; the Electron main process never calls `readAdmittedFrames` (single-call-site assertion) and never holds the admitted frame set.
- [ ] Budget expiry ⇒ `UNMEASURED` + `READ_BUDGET_EXCEEDED`, `census: null`, `rows: []`, `totals: null`, worker terminated, no partial census published; the in-process fallback yields every 25 files and produces a byte-identical envelope to the worker path on the same fixture directory and `asOf`.
- [ ] Ceiling reached ⇒ `MEASURED` with **rows rendered over the files actually read**, every row `lowerBound: true`, `limits.outcome === 'POPULATION_TRUNCATED'`, `limits.ceiling` naming the bound, `limits.filesRead + limits.filesSkipped === fileCount`, `limits.windowNewestMtimeMs`/`windowOldestMtimeMs` covering exactly the read set, and `totals.truncation = { ceiling, filesRead, filesSkipped, order: 'mtimeMs-desc,name-asc' }` with a `partial: N of M files` label; the degenerate `filesRead === 0` case ⇒ `UNMEASURED` + `POPULATION_TRUNCATED`, `censusHash: null`, both window fields `null`, `rows: []`, `totals: null`.
- [ ] Selection order is newest-first and provably not name-first: a fixture whose newest file has the alphabetically last name is read first, and equal `mtimeMs` values fall back to `name` ascending.
- [ ] Every `UNMEASURED` reason renders through the single §7 envelope shape (`rows: []`, `totals: null`, `reconciliation: null`, mechanism in `affected`); `POPULATION_TRUNCATED` appears there only in the degenerate case.
- [ ] `affected[]` carries **no path**: every entry is the display label or a §7 mechanism token, none contains `/`, `\` or a drive-letter prefix, and none equals the injected directory; `storePath` is the display label, or `null` exactly when no store resolved (never an invented placeholder).
- [ ] `fileRollups` has one entry per file actually read, in the newest-first read order, and every entry satisfies `frames === admitted + namedInvalid`; the quarantine margin derived from it satisfies `framesPresent === framesAdmitted + framesNamedInvalid` **without opening a file or re-scanning**.
- [ ] `CENSUS_DRIFT` (content differs at equal size after the read) ⇒ `UNMEASURED`, `rows: []`, fail closed; a change in size ⇒ `POST_CENSUS_TRUNCATE`/`POST_CENSUS_APPEND`; a vanished file ⇒ `VANISHED`; the pass still returns in all four cases.
- [ ] A checksum-valid frame with `formatVersion: 2`, and one whose `attachmentId` is absent, are both `STRUCTURAL_INVALID` and are **not** admitted; the class is evaluated before checksum.
- [ ] Missing directory ⇒ `UNMEASURED` with `NO_DATA_ROOT_RESOLVED`/`NO_DATA`, `affected: ['no-data-root-resolved']` and `storePath: null`; **no directory is created**, no exception thrown.
- [ ] Zero writes: tree-hash before/after identical; no write API in the module source; the CLI accepts `--store`/`ANTIFAN_DATA_ROOT` only and has no plausible-path fallback.
- [ ] Envelope key names frozen and documented; `evidenceRefs` entries and payload fields obey the constraint-D envelope rules above; Phases 3/4 consume the keys unchanged.
- [ ] `ResidueClass` is exactly the nine members of §6 — asserted by a test that enumerates the enum's keys and compares the count and the member set, so a silent addition or removal fails the gate — and every member is switched on; every `UnmeasuredReason` member is covered by the §7 envelope shape, and `StructuralInvalidReason` / `ChecksumMismatchReason` are closed two-member sets.

## Test Scenario Matrix

| # | Scenario | Fixture | Expected |
|---|---|---|---|
| E1 | Directory missing | temp path, not created | `UNMEASURED` + `affected: ['no-data-root-resolved']` + `storePath: null`; **no mkdir** (tree hash unchanged) |
| E2 | Directory empty | empty temp dir | `UNMEASURED`, not `0` |
| E3 | Directory unreadable | temp dir with restricted ACL (skip only if the platform refuses to make one) | `UNMEASURED` + `DIR_UNREADABLE`, no throw |
| E4 | Partition deleted between the sweep and the read | injected via `afterPopulationSweep(name)` → delete | per-file `VANISHED` recorded; pass returns |
| X1 | Population rule | `a.jsonl`, `b.jsonl.quarantine-1`, `c.jsonl.tmp-9-1`, `d.jsonl.bak`, `e.txt` | **4 files matched** (`a`, `b`, `c`, `d` — `d.jsonl.bak` IS in the population under the locked `includes('.jsonl')` rule, though the writer's `endsWith('.jsonl')` would drop it); `e.txt` excluded; `fileCount === 1 + 1 + 1 + 1` |
| X2 | Content-change detection | same size, one byte flipped, then re-run | `censusHash` differs |
| X3 | Determinism | same dir, same `asOf`, twice | identical `censusHash` and ordering |
| X4 | `asOf` injected | call twice with different `asOf`, same dir | identical file data, different `asOf` only |
| X5 | Line count recorded | dir with a 3-line and a 1-line file | `files[*].lineCount` = 3 and 1 |
| X6 | Shrink is detectable | pass, then truncate a file, then read | censused `lineCount` (3) > parsed (2) ⇒ `POST_CENSUS_TRUNCATE` in Phase 2 |
| X7 | Compaction swap between the sweep and the read (F4) | `afterPopulationSweep` → write a smaller coalesced file to a temp name and `rename` it over the partition (the writer's own shape, `:843-844`) | `POST_CENSUS_TRUNCATE`; the entry's `size`/`sha256` describe the bytes **actually read**; `censusHash` never covers the pre-swap bytes; rows remain but are `lowerBound: true` (Phase 3) |
| X8 | Truncate between the sweep and the read (F4) | `afterPopulationSweep` → truncate the file | `POST_CENSUS_TRUNCATE`; pass returns; no exception |
| X9 | Equal-size content change after the read (F4) | `afterRead` → rewrite the file in place with different bytes of the same length (mtime advances) | post-read re-hash differs ⇒ `CENSUS_DRIFT` ⇒ `status: 'UNMEASURED'`, `rows: []` |
| X10 | Content-preserving rewrite after the read | `afterRead` → rewrite the identical bytes (mtime advances) | `rewritten-identical`; no drift; entry retained |
| X11 | Append after the read | `afterRead` → append a frame | `POST_CENSUS_APPEND` with the byte delta counted, tail never read |
| X12 | Input ceiling reached (F7) | six small `*.jsonl` fixtures with explicitly assigned `mtimeMs` (`fs.utimesSync`), the **newest** one named so it sorts **last** alphabetically, plus an injected `maxBytes` below the cumulative size of the five newest | `status: 'MEASURED'`; rows rendered over exactly the five newest files; every row `lowerBound: true`; `limits.outcome === 'POPULATION_TRUNCATED'`; `limits.ceiling === 'MAX_CENSUS_BYTES'`; `limits.filesRead === 5`, `limits.filesSkipped === 1`; the skipped file is the **oldest**, not the alphabetically first (proves newest-first); `totals.truncation = { ceiling, filesRead, filesSkipped, order: 'mtimeMs-desc,name-asc' }` with `partial: 5 of 6 files`; the window equals the newest/oldest `mtimeMs` among the five read |
| X12b | Ceiling reached before any file (degenerate) | injected `maxBytes` below the newest file's size | `status: 'UNMEASURED'` + `POPULATION_TRUNCATED`, `censusHash: null`, `limits.filesRead === 0`, both window fields `null`, `rows: []`, `totals: null` |
| X12c | File-count ceiling | injected `maxFiles: 2` over five fixtures with distinct `mtimeMs` | `limits.ceiling === 'MAX_CENSUS_FILES'`, `filesRead === 2` (the two newest), `filesSkipped === 3`, `limits.windowOldestMtimeMs` = the second-newest fixture's `mtimeMs` |
| X12d | Selection tie-break | two fixtures with identical `mtimeMs`, injected `maxFiles: 1` | the one whose `name` sorts first is read; the other is counted in `filesSkipped` (deterministic, not filesystem-timing dependent) |
| X13 | Budget expiry | injected `clock` that jumps past `PASS_BUDGET_MS` after the first file | `UNMEASURED` + `READ_BUDGET_EXCEEDED`, `census: null`, `rows: []`, `totals: null`; the partial in-memory fold is discarded, never published |
| X14 | Worker / in-process equivalence | same fixture dir + same `asOf`, both modes | byte-identical envelopes; the in-process run's yield hook fires at file 25, 50, … |
| X15 | `STRUCTURAL_INVALID` is not admitted (F6) | two synthetic `*.jsonl` lines: one `formatVersion: 2` with a correct checksum, one missing `attachmentId` with a correct checksum | both `STRUCTURAL_INVALID` (`unsupported-format-version`, `missing-identity`); **0 admitted**; evaluated before checksum |
| X16 | Non-object line does not throw | a line containing `null` | `STRUCTURAL_INVALID: missing-identity`; no throw (mirrors the ledger's `catch` at `:246-249`) |
| X17 | Enum closure | `Object.keys(ResidueClass)` vs §6; `StructuralInvalidReason` / `ChecksumMismatchReason` key sets | exactly the nine members of §6, in every phase that switches on them; the two sub-reason enums are closed two-member sets |
| X18 | Per-file roll-up identity (frozen Phase 3 input) | one `*.jsonl.quarantine-1` holding 3 admitted + 1 checksum-bad line, one `*.jsonl` holding 2 admitted | `fileRollups` has exactly 2 entries in read order; `frames === admitted + namedInvalid` per entry; the quarantine-like roll-up sums to `framesPresent === framesAdmitted + framesNamedInvalid` and the margin is derivable with no file open |

## Function / Interface Checklist

| Symbol | Signature | Responsibility |
|---|---|---|
| `runCensusPass` | `({ dir, asOf, mode, clock?, limits?, hooks? }) => Promise<McpDispatchAccount>` | the whole bounded pass (stage A + stage B) in worker or in-process mode; `limits` defaults to the exported constants (injectable only so tests exercise the ceiling with small fixtures); the only entry the service and CLI call — Phase 3's `accountStore` wraps it and must run in the **same thread** as the pass (worker or CLI process), never in the Electron main process |
| `runPopulationSweep` | `(dir) => { entries: {name, size, mtimeMs}[], counts, observedBytes, observedFiles }` | stage A: metadata only, bucket counts, the inputs the read-time ceiling is evaluated against, memo key inputs |
| `readFramesIncremental` | `(census, sink) => Promise<{ residue, superseded, labels, fileRollups }>` | the streaming core Phase 2 implements: one content read per file, per-line classification, the per-file roll-up, never materialising the whole `result`-bearing set |
| `readAdmittedFrames` | `(census) => { admitted, residue, superseded, labels, fileRollups }` | materialising wrapper over the sink; permitted only inside the pass core (worker/CLI), forbidden in the Electron main thread |
| `Census` / `CensusEntry` / `CensusLimits` | types | the census shape of §3, including `censusHash: string \| null`, `limits.ceiling`, `limits.filesRead` / `filesSkipped`, `limits.windowNewestMtimeMs` / `windowOldestMtimeMs` and `limits.outcome` |
| `FileRollup` | type | the frozen per-file `{ file, quarantineLike, tempLike, frames, admitted, namedInvalid }` roll-up Phase 3 builds `totals.quarantineMargin` from, with `frames === admitted + namedInvalid`, ordered newest-first |
| `Truncation` | type | the frozen `{ ceiling, filesRead, filesSkipped, order }` sub-shape Phase 3 renders as `totals.truncation`, `order` being `'mtimeMs-desc,name-asc'` |
| `ChecksumMismatchReason` | enum | `writer-canonicalization-array-slot`, `unexplained` |
| `ResidueClass` | enum | **exactly the nine members of §6**, in that order: `ADMITTED`, `STRUCTURAL_INVALID`, `CHECKSUM_MISMATCH`, `TORN_TAIL`, `UNPARSEABLE`, `RESIDUE_NO_CHECKSUM`, `POST_CENSUS_APPEND`, `POST_CENSUS_TRUNCATE`, `VANISHED` |
| `StructuralInvalidReason` | enum | `missing-identity`, `unsupported-format-version` |
| `UnmeasuredReason` | enum | `NO_DATA_ROOT_RESOLVED`, `NO_DATA`, `DIR_UNREADABLE`, `CENSUS_DRIFT`, `READ_BUDGET_EXCEEDED`, `POPULATION_TRUNCATED`, `SERVICE_FAILED` |
| `LatencyProvenance` | enum | `owner-written`, `excluded-unknown-state`, `excluded-replay-provenance` |
| `McpDispatchAccount` | envelope type | the single payload every surface renders (§9) |

`censusStore(dir, asOf)` is **retired** by this revision: there is no separately computed census, so the name (and the "thin, synchronous, read-only function" contract it carried) no longer describes anything. `runCensusPass` is the pass entry point; `Census` keeps its name because Phases 2–4 consume that type.

## Dependency Map

```
Phase 1 (contracts + sweep + one-pass reader core + bounds)
        ├──►  Phase 2 (line-level reader; consumes the frozen classes, the Census type
        │              and the incremental sink; implements the classification order)
        │              └──►  Phase 3 aggregate  ──►  Phase 4 delivery surface
        └──►  Phase 4 CLI (in-process mode proves determinism without Electron)
```

Phase 1 has no dependency. Nothing in Phases 2–4 may add an envelope key, a residue class or an `UNMEASURED` reason without updating this file.

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|---|---|---|
| The census becomes a second hashing pass again | one Hub refresh blocks the main thread for tens of seconds while every IPC call and the ledger's append path queue behind it | one content read per file, hash over the bytes read, worker thread by default; the retired `sha256(readFileSync(name))` recipe appears nowhere; single-call-site assertion on `readAdmittedFrames` |
| The pass runs in-process on the main thread | IPC latency spike during a Hub refresh | worker is the default; the fallback yields every 25 files (mirroring `invocation-ledger.ts:131-135`) and the CLI reaches the same code path |
| The input grows without bound (quarantine is never replayed or pruned; live partitions are append-only, `:126`, `:142`, `:260-271`) | pass time and memory track store lifetime, not the current snapshot | declared ceilings stop the read at a counted limit and disclose it (`limits.ceiling`/`filesRead`/`filesSkipped`, `totals.truncation`, `lowerBound` rows, `partial: N of M files`); declared budget discards the partial fold into `READ_BUDGET_EXCEEDED`; neither path silently reads the whole store nor silently blanks the feature (`plan.md:80`) |
| The ceiling is implemented as a silent full-read, or as a blank panel | a large store renders either an unbounded cost or an empty tab | the two outcomes are typed apart: input ceiling ⇒ disclosed `MEASURED` rows over the files read (`lowerBound`, `totals.truncation`, window); time budget ⇒ `UNMEASURED`; matrix rows X12/X12b/X12c/X13 pin both |
| The truncation prefix silently hides tools | a tool reads as "never called" because its partitions sort late | selection is newest-first (`mtimeMs` desc, `name` asc), the order is published in `totals.truncation.order`, the shortfall is counted in `filesSkipped`, and the covered window is stated so the answer reads as "recent activity, not all history" (`plan.md:80`); matrix rows X12/X12d |
| The renderer payload leaks a path through `affected`/`storePath` | a boundary projection finds an absolute path where a mechanism label belongs | `affected` entries are the display label or a §7 token and may never contain `/`, `\` or a drive letter; `storePath` is the same label or `null`; the injected directory is never echoed (constraint D, `plan.md:74`/`:142`) |
| Phase 3 re-opens files or re-scans to build the quarantine margin | a second read pass appears in the aggregate, or its numbers disagree with the reader's | the per-file roll-up is a frozen envelope input with the asserted identity `frames === admitted + namedInvalid`; Phase 3 sums `fileRollups` only (matrix row X18) |
| The census resolves the data root itself and probe-writes | a `.probe-<pid>-<ts>` file appears at the data root | dir is injected; the module never imports `StorageLocations`; the CLI accepts `--store`/`ANTIFAN_DATA_ROOT` only with **no** fallback; tree-hash test asserts it |
| A plausible-path fallback creeps back in | the CLI reads a store the operator did not point it at (`<repo>\.antifan-data` is absent, the live store is `E:\Work\.antifan-data`) | stated as a P0 user-visible rule with the machine-specific evidence; C3-style test asserts `UNMEASURED` when neither input resolves |
| A compaction swap makes the census hash describe bytes never read (F4) | `MEASURED` payload whose hash cannot be reproduced from the bytes consumed, with 0 torn tails and 0 checksum mismatches | hash-what-you-read + post-read `stat` + re-hash on change; equal-size content change ⇒ `CENSUS_DRIFT` ⇒ `UNMEASURED`, no rows; size change ⇒ truncate/append; gone ⇒ `VANISHED` |
| A live store makes "the" count unstable | two runs disagree | `asOf` + `censusHash` are printed with every payload; acceptance runs on a frozen copy; no count is hard-coded anywhere |
| A checksum-valid frame with a future `formatVersion` becomes a real dispatch row | row count grows while the writer's own contract calls the frame unsupported | `STRUCTURAL_INVALID` is in the closed enum and is evaluated **before** checksum, mirroring `:188`; matrix row X15 |
| A compaction temp file is mistaken for a partition | file count grows with a name the ledger ignores | identity always comes from `frame.attachmentId`; a temp file contributes frames, never a second row set; the locked population rule includes it on purpose |
| Hosting the reader in a module that drags in `electron` | the Phase 4 CLI dies on `require('electron')` | the module stays electron-free (`node:*`, shared contracts, the Phase 2 seam as a type-only import); the worker is constructed from that same compiled module; Phase 2 re-verifies the import list |
| The cited hazard path is wrong again (F2) | an implementer reads a path that does not exist; a reviewer assumes the zero-write argument was grounded | every citation in this file points at `src/main/config/storage-locations.ts`; the structural guard asserts that file exists on disk and that no import specifier matches `/storage-locations/` |
| The `.jsonl.bak` decoy is described as both non-matching and included | a rule this wide stops being auditable | the rule is stated once (`includes('.jsonl')`, deliberately wider than the writer's `endsWith('.jsonl')`), the decoy is labelled **included**, and matrix row X1 agrees |
