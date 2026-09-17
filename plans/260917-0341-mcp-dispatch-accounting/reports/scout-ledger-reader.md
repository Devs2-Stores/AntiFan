---
title: "Scout Report — Ledger Reader Seam (Phases 1-2)"
status: reference
asOf: 2026-09-17T03:47:41Z
scope: "Phase 1 (census & contract freeze) + Phase 2 (line-level reader)"
---

# Scout Report — Ledger Reader Seam (Phases 1-2)

Read-only scout. No file was created, modified, or deleted except this report. No command in this
scout wrote to the repo, the data root, or the ledger.

Legend: **OBSERVED** = read in this session (file:line cited). **DERIVED** = inferred from OBSERVED
with the inference stated. **ASSUMED** = not verifiable here.

Store measured: `E:\Work\.antifan-data\control-plane-v2\invocations`. It is **live during the read**
(§0.3). Three independent snapshots disagree by tens of frames; every number below is stamped with
the snapshot it came from. **Nothing here may be hard-coded as an acceptance value.**

---

## 0. Live-store measurements (OBSERVED, three snapshots)

### 0.1 File census by suffix

| Snapshot | `*.jsonl` | `*.jsonl.quarantine-<ts>` | `*.jsonl.tmp-<pid>-<ts>` | other | total |
|---|---|---|---|---|---|
| M1 (03:43Z) | 1034 | 7 | 0 | 0 | 1041 |
| M4 (03:47:41Z) | 1034 | 7 | 0 | 0 | 1041 |

- The locked population rule `*.jsonl*` is **strictly wider** than the ledger's own filter
  `endsWith('.jsonl')` (`src/main/session/invocation-ledger.ts:126`, `:142`): it additionally
  matches `*.jsonl.quarantine-<ts>` (`:265`) and, in principle, `*.jsonl.tmp-<pid>-<ts>`
  (compaction temp file, `:829`). Measured `.tmp-` count today: **0**.
- `plan.md:49` states `1,040 = 1,033 + 7`. **OBSERVED today: 1,041 = 1,034 + 7.** The store grew by
  one live partition between the plan's measurement and this scout. The `1033 + 7 == 1040`
  success criterion (`plan.md:115`) is already stale — re-derive, never hard-code.

### 0.2 Quarantine frames — independently reproduced

| Metric | plan.md:49 claim | OBSERVED (scout) |
|---|---|---|
| quarantine files | 7 | 7 |
| frames in them | 254 | 254 |
| pass `computeFrameChecksum` (strict) | 247 | **247** |
| fail strict | 7 | **7** |
| of the 7, reproduce recorded checksum iff `null` inside arrays → `undefined` | 7/7 | **7/7** |
| unparseable | (not stated) | 0 |
| missing `checksum` field | (not stated) | 0 |

Per-file: 12/203/6/6/6/12/9 lines → pass 11/202/5/5/5/11/8, fail 1 each. Every failing frame is
`name = "anti.browser.evaluate"`, `state = "completed"`. Six carry `result` as an all-`null` array
(len 20, nulls 20); the seventh (`attachment-1a83d419-…`, line 55) carries `result.hookStates[N]`
nulls inside an object. All 254 lines are terminated with `\n` (`raw.endsWith('\n') === true` for
all 7 files).

**New, load-bearing: `null` inside an array is NOT evidence of the defect.** OBSERVED: 5 frames in
the live store contain arrays of genuine `null` **and still pass the strict checksum**, e.g.
`attachment-2a196818-c582-449b` line 122 (`result.fileNamesSample`, len 6 / 6 nulls, both strict-OK)
and `attachment-db7a365f-96af-4176` line 153 (`result.itemInlineStyles`, len 6 / 6 nulls,
strict-OK). All 5 **fail** the null→undefined variant. So the two variants are not
interchangeable: a reader that normalizes before hashing loses these 5 valid frames; a reader that
admits on the variant without first requiring strict failure would mis-admit. Correct rule:
**strict first; the variant is only a diagnostic for a frame that already failed strict.**

### 0.3 Drift / liveness (OBSERVED, direct)

| Metric | M1 | M3 | M4 |
|---|---|---|---|
| total lines | 19,077 | 19,114 | 19,119 (frame count) |
| total bytes | 240,693,408 | 240,772,304 | 240,780,128 |

The newest partition was modified at `03:47:39.274Z` — **2.1 s before** M4's `asOf`, with a last
frame `anti.screenshot.viewport` / `state=in_progress` created at `03:47:39.272Z`. The ledger is
being appended to concurrently with the read. Risk "store grows during a read" (`plan.md:145`) is
demonstrated, not hypothetical.

### 0.4 Census-hash recipe (demonstration only)

`censusHash = sha256(concat over name-sorted files of "name\0size\0sha256(file)\n")`

| asOf | files | bytes | frames | censusHash |
|---|---|---|---|---|
| 2026-09-17T03:47:41.364Z | 1041 | 240,780,128 | 19,119 | `abe0301fb632910f02b77ff1392837ab1ed26ebb71793c176735407365e087f6` |

This value is **already dead** (the store moved 2 s later). Use it only to prove the recipe
executes; the snapshot contract must be evaluated on a frozen copy.

### 0.5 Scale facts the reader must survive (OBSERVED, M3)

- 19,114–19,119 frames; 240.8 MB total; largest single partition **143,203,927 B (143 MB)**
  (`attachment-e9c4df19-af1a-48e9-bc5b-7e01e55fdad7.jsonl`).
- 50 lines > 1 MB; **0 lines > 10 MB**; largest line **3.8 MB**.
- Full independent pass (read every file, `JSON.parse` every line, build identity maps): **7.9 s**
  wall, single process. Consistent with the plan's 2.9–13.7 s (`plan.md:57`).
- Largest quarantine file: 473,226 B. No quarantine file is anywhere near
  `DEFAULT_MAX_INVOCATION_FRAME_BYTES` (64 MB, `:13`), so **none of the 7 was quarantined for
  oversize** — all 7 match the checksum-mismatch reason (`:197-202`).

### 0.6 Identity (OBSERVED, M1)

| Metric | scout | plan.md:51 |
|---|---|---|
| distinct `idempotencyKey` | 16,847 | 16,803 |
| distinct `(attachmentId, idempotencyKey)` | 18,831 | 18,784 |
| keys spanning >1 partition | 216 | 216 |
| keys spanning >1 recorded name | 165 | (not stated) |

Top spans: `idem-mcp-2` → 92 partitions; `idem-mcp-3` → 91; `idem-mcp-4` → 82; `idem-mcp-5` → 82;
`idem-mcp-6`/`idem-mcp-7` → 57. All OBSERVED. Composite identity is confirmed.

### 0.7 Quarantine/live disjointness (OBSERVED)

The 7 quarantined attachmentIds are **disjoint** from the 1,034 live partitions, and no attachment
has two quarantine files. So today the composite key cannot collide across a quarantine and a live
file — but the reader must not depend on it: `quarantinePartition()` renames the live file away
(`:265-269`) and the in-memory quarantine set is lost on restart, so a post-restart claim recreates
`<attachmentId>.jsonl` beside the old quarantine file.

---

## 1. Seam analysis — checksum reuse

### 1.1 Facts

- `computeFrameChecksum` is **module-private**, not exported: `src/main/session/invocation-ledger.ts:90`
  (`function computeFrameChecksum(...)`, no `export` keyword; the only `export` in that region is
  `:13 DEFAULT_MAX_INVOCATION_FRAME_BYTES`). OBSERVED.
- Body (`:90-93`): `crypto.createHash('sha256').update(canonicalJsonStringify(frame),'utf8').digest('hex')`.
- `canonicalJsonStringify` **is exported**: `src/shared/control-plane-contracts.ts:506` (array branch
  `:510-511`, object branch `:513-516`). `canonicalDigest` also exported at `:518`. OBSERVED.
- In `invocation-ledger.ts`, `canonicalJsonStringify` is used **only** at `:91` and `crypto` **only**
  at `:92` (OBSERVED by grep over the whole file). `canonicalDigest` stays needed at `:308`, `:373`.
- Four in-class call sites: `:198` (replay verification), `:429` (append-failure reconciliation),
  `:796` (append), `:834` (compaction).
- `canonicalJsonStringify`'s array branch renders an element that is `undefined` as an **empty slot**
  (`Array.prototype.join`), while the persisted line is produced by `JSON.stringify(frameWithChecksum)`
  (`:802`) which renders `undefined` array elements as `null`. That is the writer-side artifact behind
  the 7 frames. The defect is `src/shared/control-plane-contracts.ts:510-511` + `:802`. Not fixed here.

### 1.2 Options

**Option A — `export` in place (`invocation-ledger.ts:90` → `export function computeFrameChecksum`).**
- Exact change: one keyword at `:90`. Nothing else.
- Reader then does `import { computeFrameChecksum } from '../session/invocation-ledger'` — a **value**
  import, so the reader's runtime module graph includes the `InvocationLedger` class if it also wants
  `InvocationRecord` non-type-only.
- Duplication: zero. Blast radius: smallest diff; largest conceptual risk (the reader can now also
  import `InvocationLedger` and somebody later calls `initialize()` from it — the invariant this plan
  most needs to hold is enforced only by convention).
- Does importing `invocation-ledger.ts` execute anything? OBSERVED: its imports are `node:fs`,
  `node:path`, `node:crypto` (`:1-3`) and `../../shared/control-plane-contracts` (`:4-12`); the module
  body is one `const` (`:13`), two types, and the class. `control-plane-contracts.ts` top level is
  imports + `const`/`type`/`function` only (`:1-18`). No side effect at import. Safe for a CLI harness.

**Option B — extract to its own module (RECOMMENDED).**
- CREATE `src/main/session/invocation-frame-checksum.ts`: `import * as crypto from 'node:crypto';`
  `import { canonicalJsonStringify } from '../../shared/control-plane-contracts';`
  `import type { InvocationRecord } from './invocation-ledger';` then the same 4-line function
  (`import type` is erased, so no runtime cycle; a type-only cycle is legal).
- MODIFY `invocation-ledger.ts`: delete `:90-93`; delete import line `:3` (`crypto`, now unused) and
  the `canonicalJsonStringify,` entry at `:10`; add
  `import { computeFrameChecksum } from './invocation-frame-checksum';`.
- Reader imports the function from the new module and `InvocationRecord` with **`import type`** from
  the ledger → the reader never links the ledger class at runtime.
- Duplication: zero (single definition). Blast radius: 1 new file + 1 import + 2 deletions.
- Variant B': put the new file in `src/shared/` instead. Equally safe today (OBSERVED: nothing under
  `src/renderer/` or `src/preload/` imports `control-plane-contracts`), but `src/shared/` is the
  renderer-facing surface by convention while this is a main-process persistence-format function;
  B is narrower.

**Option C — re-implement inside the reader.** Rejected. The function is the *definition* of the
persisted format; a second copy is a second source of truth for a contract that decides every
admission. Any drift silently flips frames between ADMITTED and CHECKSUM_MISMATCH, which is exactly
the failure mode this plan exists to avoid.

### 1.3 Tests that break

**None, for A, B, or C.** OBSERVED: every test that touches the ledger imports only
`{ InvocationLedger }` (plus shared contracts) — `test/main/invocation-ledger.test.ts:6`,
`test/main/capability-catalogue.test.ts:6`, `test/main/historical-authority-replay.test.ts:6`,
`test/main/nested-cancellation.test.ts:8`, `test/main/target-transition.test.ts:8`,
`test/main/workflow-engine.test.ts:28`. Repo-wide, `computeFrameChecksum` appears in exactly one
file (`invocation-ledger.ts`). No test asserts the module's export surface.

Compile gates, checked (OBSERVED):
- `scripts/check-emit-integrity.mjs:54-78` derives the expected emit path **structurally** from the
  source tree (`src/main/session/invocation-frame-checksum.ts` →
  `.compiled/src/main/session/invocation-frame-checksum.js`); no manifest exists to update. A
  brand-new source is `freshMissing` (source mtime > `:110` build-info mtime) → build info preserved
  → tsc emits it. No edit needed.
- `scripts/prune-orphan-emit.mjs:41` keeps `.compiled/**` whenever `<stem>.ts` exists in the mirrored
  source dir — structural, no edit needed.
- `scripts/check-mcp-budget-dominance.mjs` builds the real catalogue from `.compiled/src` (`:40`,
  `:177`, `:262`) and compares it to the proxy's advertised surface. It is affected only if the
  reader is imported by the catalogue or the proxy. Keep the reader out of both (see §7).

---

## 2. Ledger file/dir API surface to reuse

| Fact | Evidence |
|---|---|
| Partitions dir = `path.join(dataRoot, 'invocations')` | `invocation-ledger.ts:116` |
| Constructor takes `{ dataRoot, maxHotRecordsPerPartition?, maxFrameBytes? }` | `:54-58`, `:115-119` |
| `getPartitionPath(attachmentId)` = `<dir>/<attachmentId>.jsonl` (private) | `:167-169` |
| Runtime constructs it with `options.dataRoot` | `control-plane-runtime.ts:163` |
| Production `dataRoot` = `StorageLocations.getControlPlaneDir()` | `src/main/index.ts:322` |
| `getControlPlaneDir()` = `<getDataRoot(customRoot)>/control-plane-v2` | `storage-locations.ts:101-103` |
| `getDataRoot()` order: `customRoot` → `process.env.ANTIFAN_DATA_ROOT` → cached → probe candidates `E:\Work\.antifan-data`, `E:\Work\.antifan-data`, `E:\.antifan-data`, `D:\Work\.antifan-data` → `%APPDATA%\AntiFan\data` | `:29-71` |
| Resolved dir today | `E:\Work\.antifan-data\control-plane-v2\invocations` |
| Also read by the ledger's own filter only: `endsWith('.jsonl')` | `:126`, `:142` |

**Can a reader obtain the dir without constructing the ledger? Yes — but not by calling
`StorageLocations.getDataRoot()` on a cold cache.** OBSERVED: `getDataRoot()`'s no-cache path
**writes**: `fs.mkdirSync(candidate,{recursive:true})`, `fs.writeFileSync(<candidate>/.probe-<pid>-<ts>,'ok')`,
`fs.unlinkSync(...)` (`:52-55`). In the main process the cache is already warm because
`StorageLocations.ensureDirectories()` runs first (`src/main/index.ts:164` before `:319`), so
`getControlPlaneDir()` at `:322` is a pure `path.join`. In a **fresh CLI-harness process** it is not:
without `ANTIFAN_DATA_ROOT` it would probe-write into the data root. Measured probe-file leakage
today: 0 (they are unlinked immediately), which does not make the write acceptable under this plan's
zero-write invariant.

**Recommendation (DERIVED):** the reader's public API takes an **injected** `invocationsDir: string`
(or `dataRoot`) — never resolves it internally. The main process passes
`path.join(StorageLocations.getControlPlaneDir(), 'invocations')`. A CLI harness resolves
`ANTIFAN_DATA_ROOT` (or an explicit `--dir`) itself and, when neither is present, reports
`UNMEASURED` with no probing and no write. Do **not** export or reuse `getPartitionPath` (private,
`:167`) and do **not** copy `path.basename(file, '.jsonl')` (`:129`, `:144`) as the attachmentId
derivation — it is wrong for `*.quarantine-*` / `*.tmp-*` names. Identity comes from
`frame.attachmentId` (always present; the ledger itself rejects a frame without it, `:188`).

---

## 3. `InvocationRecord` — persisted field inventory

Declared at `invocation-ledger.ts:19-45`; written by `appendFrameUnlocked` (`:790-811`) as
`JSON.stringify({...rest, checksum})` where `rest` is the record minus `checksum` (`:795-802`).
Optional fields are absent from the JSON when `undefined` (`JSON.stringify` drops `undefined`
object values) — **the reader must treat every optional field as possibly-absent, not nullable.**

| Field | Type | Optional | Line | Notes for the parse contract |
|---|---|---|---|---|
| `formatVersion` | `number` | no | `:20` | ledger rejects `!== 1` on replay (`:188`) |
| `id` | `string` | no | `:21` | `invocation-<uuid>`; ledger rejects missing (`:188`) |
| `attachmentId` | `string` | no | `:22` | **the identity's partition half**; use this, not the filename |
| `requestId` | `string` | no | `:23` | |
| `idempotencyKey` | `string` | no | `:24` | identity's key half; NOT an identity alone (§0.6) |
| `name` | `string` | no | `:25` | the **recorded (post-alias)** dispatch name (`mcp-server.ts:675` `const name = aliasMap[toolName] \|\| toolName;` → `:751` `name,` → `:394` persists `intent.name`) |
| `paramDigest` | `string` | no | `:26` | |
| `policyDigest` | `string` | no | `:27` | |
| `policyVersion` | `number` | no | `:28` | |
| `recordedVisibility` | `string` | no | `:29` | |
| `state` | `InvocationState` = `'claiming'\|'in_progress'\|'completed'\|'failed'\|'interrupted'\|'unknown'` | no | `:16`, `:30` | terminal set = last four |
| `dispatchStage` | `InvocationDispatchStage` = `'pre_dispatch'\|'dispatch_started'` | yes | `:31`, `control-plane-contracts.ts:302` | written on claim (`:400`) and by `advanceStage` (`:551-554`) |
| `authoritySnapshot` | `MainResolvedAuthority` | no | `:32` | object, see below |
| `result` | `unknown` | yes | `:33` | the field carrying the 7 null-array artifacts (§0.2) |
| `error` | `{ code: string; message: string; details?: unknown }` | yes | `:34-38` | `code` is the error-code histogram key; `details` may be absent (measured: the 16.88 h frame has none) |
| `evidence` | `Record<string, unknown>` | yes | `:39` | |
| `replacementAuthorityRevision` | `string` | yes | `:40` | |
| `artifactIds` | `string[]` | yes | `:41` | |
| `createdAt` | `number` | no | `:42` | epoch ms |
| `settledAt` | `number` | yes | `:43` | OBSERVED: present on **all** terminal frames (0 terminal frames lack it) and on **no** non-terminal frame (0 `in_progress`/`claiming` frames carry it) |
| `checksum` | `string` | yes in the type, always written by the writer, and required by the reader-integrity path | `:44`, `:193`, `:799` | sha256 hex of `canonicalJsonStringify(frame minus checksum)` |

`MainResolvedAuthority` (`control-plane-contracts.ts:330-346`): `attachmentId`, `authorityRevision`
(`AuthorityRevisionHandle`), `revisionNumber`, `projectId`, `workspaceId?`, `runId`, `attemptId`,
`backendId`, `grant` (`CapabilityRisk`), `hostEpoch`, `runtimePid`, `runtimeLeaseToken?`,
`leaseExpiresAt`, `browserTarget?`, `issuedAt`. Of these, only `runtimePid` and `leaseExpiresAt` are
consumed by the ledger (`:214-223`) — the reader needs none.

Field-presence measured over the whole store (M1): 0 frames missing `checksum`, 0 unparseable lines,
0 lines without a valid record shape. So the residue classes are populated in production only by the
7 null-array strict failures today.

---

## 4. Torn-tail detection

### 4.1 What a write is

`appendFrameUnlocked` (`:790-811`):
```
const line = JSON.stringify(frameWithChecksum) + '\n';      // :802
await fs.promises.appendFile(filePath, line, 'utf8');        // :806
```
Compaction rewrites the file wholesale: `rows.join('\n') + (rows.length ? '\n' : '')` into
`<file>.tmp-<pid>-<ts>` then `rename` (`:829-844`).

### 4.2 Existing partial-line handling: **none**

- `replayPartition` does `raw.split(/\r?\n/).filter(line => line.trim().length > 0)` (`:177`) then
  quarantines the **whole partition** on any parse failure (`:246-249`), any missing
  `checksum` (`:193-196`), any checksum mismatch (`:197-202`), any missing
  `id`/`idempotencyKey`/`attachmentId`, or `formatVersion !== 1` (`:188-192`).
- The append-failure reconciliation in `claimOwner` repeats the same shape (`:418-441`) and treats a
  parse blow-up as `hasInvalidFrame` → `poisonPartition` (`:453`).
- There is **no** notion of a torn tail, no trailing-newline check, and no per-line residue anywhere
  in the ledger.
- Measured today: **0 torn tails, 0 files lacking a trailing `\n`** across all 1,041 files. The class
  is real but currently unpopulated — a test fixture is required to exercise it.

### 4.3 What a reader can and cannot distinguish

**Can** (sound rules, DERIVED from the write shape):
1. Only the **last** non-empty line of a file can be a torn tail: appends are strictly
   sequential at the end, and compaction always terminates the file with `\n` (`:841`).
2. A file whose last byte is not `\n` had its final append interrupted → the final segment is
   truncated → `TORN_TAIL` (whether or not it happens to parse).
3. A non-final line that fails to parse is `UNPARSEABLE`, not `TORN_TAIL`.
4. A line that parses and passes the strict checksum is complete regardless of position; a torn
   prefix can never satisfy a checksum over the whole frame.

**Cannot:**
1. Distinguish a torn tail from a *genuinely corrupt* final line when the file still ends with `\n`
   (e.g. a filesystem that committed the newline but not the payload, or a partial overwrite).
   Both classify as `CHECKSUM_MISMATCH` under rule 2.
2. Distinguish the writer-canonicalization artifact (the 7) from real corruption without evaluating
   the null→undefined variant. And even then: 5 strict-valid frames prove the variant is a
   **diagnostic**, not a truth (§0.2).
3. See a torn tail whose truncated remainder is whitespace-only: `:177`'s blank-line filter drops it,
   so the file appears clean. Document this as an accounting hole rather than pretending to count it.
4. Recover anything from a `.jsonl.tmp-*` file's provenance: it is either an abandoned compaction
   (rows also present in the live file) or a crash-window artifact. Identity must come from the
   frame's own `attachmentId` + `idempotencyKey`, so a duplicate is deduped as *superseded*, never
   double-counted.

### 4.4 Recommended classification rule (DERIVED)

Per **line**, in this order:
1. `JSON.parse` throws → if it is the last non-empty segment **and** the file does not end with `\n`
   → `TORN_TAIL`; else `UNPARSEABLE`.
2. parsed but no `checksum` string → `RESIDUE_NO_CHECKSUM` (name it; do not silently drop).
3. strict checksum fails → try the null→undefined variant. Variant passes → `CHECKSUM_MISMATCH`
   with `reason: 'writer-canonicalization-array-slot'` (disclose the count; **do not** fold these
   into ADMITTED). Variant also fails → `CHECKSUM_MISMATCH`, `reason: 'unexplained'`.
4. strict checksum passes → `ADMITTED`. (Never normalize first — the 5 strict-only frames.)
Per **file**: also emit the ledger's own rejection reasons as *labels*, computed independently
(oversize line vs. structural vs. checksum) so "quarantined" is never asserted as "checksum-bad".
Superseded count = admitted lines − distinct `(attachmentId, idempotencyKey)` (M1: 19,070 − 18,831 =
**239**).

---

## 5. File inventory for Phases 1-2

| Action | Path | Purpose (one line) |
|---|---|---|
| CREATE | `src/main/session/invocation-frame-checksum.ts` | Extracted seam: the single definition of `computeFrameChecksum`, imported by writer and reader (Option B, §1.2). |
| MODIFY | `src/main/session/invocation-ledger.ts` | Delete `:90-93`; drop import `:3` (`crypto`) and `:10` (`canonicalJsonStringify`); add `import { computeFrameChecksum } from './invocation-frame-checksum';`. Behaviour-identical. |
| CREATE | `src/main/diagnostics/mcp-dispatch-accounting-contracts.ts` | Phase-1 contract freeze: residue taxonomy, census snapshot, `UNMEASURED`/`NO_DATA` reasons, latency-provenance enum. |
| CREATE | `src/main/diagnostics/invocation-ledger-census.ts` | Phase 1: enumerate `*.jsonl*` under an **injected** dir; per-file size/sha256/frame count; deterministic census hash + `asOf`. |
| CREATE | `src/main/diagnostics/invocation-ledger-line-reader.ts` | Phase 2: line-level admission, residue classification (§4.4), superseded count, composite identity. |
| CREATE | `test/main/invocation-ledger-line-reader.test.ts` | Fixture-driven scenario matrix (see below). |
| DELETE | — | **None.** Phases 1-2 delete no file. |

Optional consolidation: `census` + `line-reader` may be one module (`plan.md:47` "one reader"); the
directory `src/main/diagnostics/` is chosen because a read-only, memoized, IPC-surface service
already lives there (`core-health.ts:265`, handler at `native-tab-host.ts:2226`). `src/main/telemetry/`
holds only `fallback-recorder.ts` (agent self-report, Panel B territory).
The CLI harness that proves byte-identity belongs to Phase 4, not here — but its existence is why the
reader's dir must be injected (§2).

### Existing tests covering the ledger / shared contracts

| Test file | cases | Coverage relevant to the seam |
|---|---|---|
| `test/main/invocation-ledger.test.ts` | 15 `it` (1 `describe`) | quarantine on bad checksum (`:197` test 6), crash-recovery states (tests 4, 12), compaction (7, 10), shutdown settlement (14, 15) |
| `test/main/control-plane-contracts.test.ts` | 4 `it` | leases, workspace containment, launch path, browser-target assertion — no `canonicalJsonStringify` case |
| `test/main/capability-catalogue.test.ts` | 21 `it` | one case constructs `InvocationLedger` (`:1262`) |
| `test/main/historical-authority-replay.test.ts` | 10 `it` | ledger restart/replay |
| `test/main/nested-cancellation.test.ts` | 2 `it` | ledger settle under cancellation |
| `test/main/target-transition.test.ts` | 4 `it` | stage advancement |
| `test/main/workflow-engine.test.ts` | 17 `it` | one case constructs `InvocationLedger` (`:777`) |

Note: **no test exists for `canonicalJsonStringify`'s array branch** (`control-plane-contracts.test.ts`
has no case for it) — which is why the artifact survived. Phase 2's fixture is the first executable
statement of that behaviour; per this plan it must pin the *current* behaviour (and the follow-up
defect) without fixing it.

### npm scripts

| Script | Command | Evidence |
|---|---|---|
| `test:main` | `node --test --test-force-exit ".compiled/test/main/**/*.test.js"` | `package.json` scripts |
| `test:file` | `node --test --test-force-exit <path>` — run as `npm run test:file -- .compiled/test/main/invocation-ledger-line-reader.test.js` | `package.json` scripts |
| `compile` | `build:shim → check-emit-integrity → tsc → check-mcp-budget-dominance → prune-orphan-emit → copy-static → build:extension` (compile required before any `test:*` lane) | `package.json`; `run-test-pipeline.mjs:23,25` |
| `typecheck` | `tsc -p ./ --noEmit --tsBuildInfoFile .compiled/.tsbuildinfo.typecheck` | `package.json` |
| `test` / `verify` | pipeline lanes `compile, test:canary, test:fast, test:site-clone, test:integration, test:main, test:e2e` (+ `audit, plans:check` under `--verify`) | `run-test-pipeline.mjs:22-24` |
| `plans:check` | registry gate — reads only files named `plan.md` (`check-plans.mjs:53`), so this report under `reports/` is not scanned | `check-plans.mjs:39-60` |

Scout did **not** execute any test lane (that would write temp files and require a build); the
statements above are static OBSERVED facts, not run results.

---

## 6. Function / interface checklist

| Symbol | Where | Reader relationship |
|---|---|---|
| `computeFrameChecksum` | `invocation-ledger.ts:90`; call sites `:198`, `:429`, `:796`, `:834` | **Reuse via extraction** (§1.2 B). Never re-implement. All four call sites must keep identical behaviour — the extraction is a move, not a rewrite. |
| `getRecord(invocationId)` | public, `:722-731` | **Zero call sites in the repo** (OBSERVED: only `attachment-registry.getRecord` is called, `bridge-server.ts:1418` etc.). It reads only in-memory hot partitions, so it cannot see the 254 quarantine frames. Do not build on it. |
| `getStats()` | public, `:732-753`; consumed at `control-plane-runtime.ts:241`, surfaced at `native-tab-host.ts:743` | The "naive reader" the plan refers to: `frameCount` comes from `persistedFrameCounts` (`:738`), which is **deleted** for a quarantined partition (`:263`) → the 254 quarantine frames are invisible; `persistedBytes` sums `statSync` over hot partitions only (`:740`) → quarantine bytes are invisible. Reader must not present `getStats().frameCount` as the ledger's frame count. |
| `isQuarantined` / `isPoisoned` | `:159-165` | In-memory only, empty after a restart (`initialize()` never replays a quarantine file). Unusable as accounting input. |
| `initialize()` | `:121-137` | **Forbidden** to the reader: creates the dir (`:123`), replays and **re-quarantines** (`:190-202`), renames files (`:265`), synthesizes terminal states (`:212-242`), and can trigger compaction writes (`:255-257`). |
| `pruneDeadPartitions()` | `:139-157` | **Forbidden**: `unlink`s partitions (`:148`). |
| `settleInFlightForShutdown` | `:673-720` | **Forbidden**: calls `settle()` (`:701`) → appends frames. |
| `DEFAULT_MAX_INVOCATION_FRAME_BYTES` | exported `:13` | Reuse for the oversize label if the reader reports the ledger's own reason. |
| Line-splitting rule `split(/\r?\n/).filter(l => l.trim().length > 0)` | `:177`, `:418` | Duplicated today twice inside the ledger. A third copy in the reader makes it three. Recommend exporting one `splitFrameLines(raw)` (either in the extracted module or as a static on the ledger) and using it in all three places — **or** accepting the duplication explicitly in the plan and pinning it with the fixture (matrix rows T1/T3). |

**Duplication the plan would otherwise introduce (DERIVED):** (a) the checksum — removed by Option B;
(b) the line-splitting / blank-line rule — three copies; (c) the `attachmentId`-from-filename rule —
must **not** be copied (§2); (d) the four quarantine reasons of `replayPartition` (`:178`, `:188`,
`:193`, `:197`, `:246`) — the reader re-derives labels for the same conditions and should state them
as *its own* independent classification, not as a claim about why the ledger quarantined the file.

---

## 7. Dependency map and forbidden imports

Order (each step must land green before the next):

1. **C1 — seam extraction** (`invocation-frame-checksum.ts` + ledger edit). Gate: `npm run typecheck`,
   `npm run compile`, `npm run test:main` (all 15 + 4 ledger/contracts cases, plus the 5 consumer files).
2. **C2 — Phase-1 contract freeze** (contracts module: residue taxonomy, census shape, `UNMEASURED`
   reasons, latency-provenance enum). Gate: typecheck + the new contract unit fixtures. No I/O yet.
3. **C3 — census** (dir enumeration + sha256 + counts at `asOf`), on top of C2.
4. **C4 — line-level reader**, on top of C1 + C3 (needs the checksum and the file set).
5. **C5 — fixture test matrix** (below), then the byte-identity acceptance run on a **frozen copy**.

C2 and C1 are independent and can land in either order; C4 strictly requires both C1 and C3.

**Must NOT import** (DERIVED from §1.1 and the forbidden-method list in §6):

| Module | Why |
|---|---|
| `src/main/control-plane/control-plane-runtime.ts` | Owns `ledger.initialize()` (`:229`) and `pruneDeadPartitions` (`:233`). Importing it drags the whole composition surface into the reader; constructing it is not needed for a file read. |
| `src/main/tools/capability-transport.ts` | Owns every `settle`/`advanceStage`/`claimOwner` call (`:294`, `:389`, `:471`, `:486`, `:910`, `:923`, `:955`) — i.e. the write path this plan must not touch. |
| `src/main/index.ts` | Composition root; also the only caller of `settleInFlightForShutdown` (`:706`). |
| `src/main/mcp/mcp-server.ts` | Importing it into the reader creates a cycle risk with the catalogue and is unnecessary: the recorded name is already in the frame (`:25`). |
| The `InvocationLedger` class as a **value** | Use `import type { InvocationRecord }` only; the reader must be structurally unable to call `initialize()`. |
| `StorageLocations` for auto-resolution | `getDataRoot()` may probe-write on a cold cache (`storage-locations.ts:52-55`). Take the dir as a parameter. |

Also: do not register a capability and do not touch the advertised MCP surface —
`check-mcp-budget-dominance.mjs` (`:177`, `:262`) will fail the compile if the catalogue/proxy
surfaces diverge.

---

## 8. Risks — signal and pre-decided response

| # | Risk | Observable signal | Pre-decided response |
|---|---|---|---|
| R1 | Store mutates during the read | totals differ between runs (OBSERVED: 19,077 → 19,114 → 19,119 lines within ~5 min; a frame landed 2.1 s before `asOf`) | Stamp every payload with `asOf` + census hash; never present a total as stable; acceptance runs only on a frozen copy. |
| R2 | The 7 null-array frames are mistaken for corruption (or silently admitted) | named-residue count changes; ADMITTED count jumps to 254 | Strict checksum first; the null→undefined variant is a **named sub-reason only**; never fold into ADMITTED; never hard-code 7. |
| R3 | A reader normalizes `null`→`undefined` before hashing | 5 currently-valid frames (e.g. `attachment-2a196818-c582-449b`:122, `attachment-db7a365f-96af-4176`:153) flip to CHECKSUM_MISMATCH | Fixture row N2 pins this counterexample. Any normalization is a defect, not a fix. |
| R4 | Latency contaminated by replay-synthesized `settledAt` | a row's p95/max jumps by hours | Exclude frames whose `error.details.reconciledByPid` is present (measured **38**); disclose the excluded count. |
| R5 | Latency contaminated by owner-written give-up frames — **the plan's stated mechanism does not cover them** | `state=unknown`, `code=EXECUTION_UNKNOWN`, **no** `error.details`: 23 frames incl. 16.88 h / 16.87 h / 16.86 h (`anti.screenshot.full_page`, `theme.qa_validate`, `anti.screenshot.viewport`) | Exclude `state === 'unknown'` **entirely** (61 frames), not just the 38 with provenance — OBSERVED: no current code path emits `unknown` without `details` (`invocation-ledger.ts:227-239` always writes provenance; `capability-transport.ts:1074-1081` is the only other producer), so the details-less ones are legacy/replay artifacts. Disclose the reason class. |
| R6 | The locked rule "exclude states `unknown`/`interrupted`" silently discards 82 real measurements | row counts drop by 82; `interrupted` p95 collapses | OBSERVED: **all** `interrupted` frames are `EXECUTION_TIMEOUT` with `delta ≤ 0.06 h` (max 3.6 min) and **none** carries replay provenance (0 of 80–82). Keep them in the latency population, or report both numbers side by side (`with-interrupted` / `without`) and state which one the plan chose. |
| R7 | A `.jsonl.tmp-<pid>-<ts>` compaction leftover enters the population | file count grows with a name the ledger ignores; frames counted twice | Derive identity from `frame.attachmentId` + `idempotencyKey` (never the filename); duplicates become superseded. Live count today: 0 — so the fixture must synthesize one. |
| R8 | A CLI harness probe-writes into the data root | a `.probe-<pid>-<ts>` file appears at `E:\Work\.antifan-data` | Dir is injected; the harness reads `ANTIFAN_DATA_ROOT`/`--dir` only; unresolvable → `UNMEASURED` with the attempted path, no write. |
| R9 | Missing/empty dir rendered as `0` | a tool row shows 0 calls against a live store | `NO_DATA` + resolved path; a `0` is only legal when the frame population is non-empty for that key. |
| R10 | `pruneDeadPartitions` deletes partitions mid-read | file set shrinks between two runs | Tolerate `ENOENT` per file; report per-file read result; never fail the whole census on one vanished file. |
| R11 | Quarantine rename collision / silent failure | an attachment keeps a live file **and** a quarantine file with the same name stem | Do not treat name stems as unique; dedupe on the frame's composite identity. (`quarantinePartition` swallows a `renameSync` failure at `:270`.) |
| R12 | Oversize-frame quarantine reason misattributed | a quarantine file with a >64 MB line appears | Label reasons independently (`:178` vs `:188` vs `:193` vs `:197` vs `:246`); no quarantine file today is oversize (max 473 KB). |
| R13 | Live-store total used as an acceptance constant | counts drift, acceptance fails spuriously | Every acceptance value is re-derived at run time; `plan.md:115`'s `1033 + 7 == 1040` is already stale (today 1034 + 7 = 1041). |
| R14 | Extraction of `computeFrameChecksum` changes byte behaviour | any ledger test fails | It is a move (§1.2 B): function body, `canonicalJsonStringify`, and hash algorithm unchanged; gate is `test:main` before any reader work. |

---

## Test-scenario matrix (Phase 2 fixture)

| ID | Scenario | Fixture | Expected class / assertion |
|---|---|---|---|
| T1 | Torn tail, last line truncated mid-JSON, no trailing `\n` | synthesized | `TORN_TAIL`; ADMITTED unchanged |
| T2 | Torn tail whose remainder is whitespace only | synthesized | no residue emitted; the hole is documented, not counted |
| T3 | Middle line unparseable, file ends with `\n` | synthesized | `UNPARSEABLE`, **not** `TORN_TAIL` |
| T4 | Line parses, `checksum` absent | synthesized | named residue (not silently dropped, not ADMITTED) |
| T5 | `formatVersion: 2` | synthesized | named residue; the ledger's own rule is `:188` |
| T6 | Middle line checksum mismatch, no nulls in arrays | synthesized | `CHECKSUM_MISMATCH` / `unexplained` |
| N1 | Live specimen: strict-invalid, null→undefined reproduces | `attachment-16d228f6-…quarantine-1788792400191:9` (or any of the 7) | `CHECKSUM_MISMATCH` + `reason` = writer-canonicalization; **not** ADMITTED |
| N2 | Live specimen: strict-VALID frame containing all-`null` arrays | `attachment-2a196818-c582-449b:122`, `attachment-db7a365f-96af-4176:153`, `…:108`, `attachment-1a83d419-…:54`, `attachment-49594f72-…:23` (5 total) | ADMITTED; a null-normalizing reader must fail this row |
| Q1 | Quarantined file admitted line-by-line | the 7 live quarantine files | 247 admitted + 7 named = 254 (re-derived, never hard-coded) |
| Q2 | Line-level admission beats file-level | same files | a file-level reader is asserted to lose 247 |
| T7 | Compaction leftover `*.jsonl.tmp-<pid>-<ts>` containing rows that also exist in the live file | synthesized | both admitted; composite identity dedupes → superseded `+N`, calls unchanged |
| T8 | Filename stem disagrees with `frame.attachmentId` | synthesized | identity follows the frame field |
| I1 | Same `idempotencyKey`, many partitions (live: `idem-mcp-2`, 92) | live or synthesized | one row per **composite**, not per key |
| I2 | Same composite, 2+ non-terminal→terminal frames | synthesized | superseded count = lines − distinct composites |
| S1 | Latest frame `in_progress` (live: 246) | live or synthesized | terminal mix shows non-terminal; latency `UNMEASURED` |
| L1 | Terminal frame with `error.details.reconciledByPid` (live: 38) | live or synthesized | latency-excluded + disclosed |
| L2 | Terminal frame `state=unknown`, no `details` (live: 23, incl. 16.88 h) | live or synthesized | latency-excluded + disclosed (see R5) |
| L3 | `interrupted` + `EXECUTION_TIMEOUT`, owner-written (live: 80–82) | live or synthesized | included (delta ≤ 0.06 h) unless the plan chooses the literal state-name rule — then the row must print both numbers (R6) |
| L4 | Terminal frame with no `settledAt` | synthesized | `UNMEASURED`, not `0` |
| E1 | Dir missing | temp root | `NO_DATA` + resolved path, no throw, **no mkdir** |
| E2 | Dir empty | temp root | `NO_DATA`, not `0` |
| E3 | Dir unreadable (EACCES) | temp root | `UNMEASURED` + reason; no throw |
| E4 | Partition deleted between enumeration and read | temp root | per-file `ENOENT` tolerated (R10) |
| C1 | Two runs on one frozen copy | frozen temp copy | payloads byte-identical modulo `asOf` |
| C2 | Two runs on the live store | live dir | census hashes differ; both `asOf` values present (R1) |
| C3 | Reader performs zero writes | temp root hashed before/after | identical tree hash; also assert `initialize`/`pruneDeadPartitions`/`settle` are never called (no import of the class as a value) |
| C4 | `getStats().frameCount` ≠ census frame count | live store | the reader's number exceeds `getStats()` by exactly the quarantine frames |

---

## Appendix — reproduction recipe

All measurements above came from inline read-only `node -e` scripts over
`E:/Work/.antifan-data/control-plane-v2/invocations` (no file written). The algorithm, in order:

1. `names = readdirSync(dir).filter(n => n.includes('.jsonl'))` (this is the locked `*.jsonl*` rule).
2. For each file: `buf = readFileSync(path)`; `endsWithNL = buf.toString('utf8').endsWith('\n')`;
   `lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)` — the ledger's own rule (`:177`).
3. Per line: `JSON.parse` → if it throws, classify by position+`endsWithNL`; else destructure
   `{checksum, ...rest}`, compute `strict = sha256(cjs(rest)) === checksum`, and, when strict fails,
   `variant = sha256(cjs(nullToUndefined(rest))) === checksum`, where `cjs` is a copy of
   `control-plane-contracts.ts:506-517` and `nullToUndefined` maps `null`→`undefined` inside arrays.
4. Identity: `frame.attachmentId + '|' + frame.idempotencyKey`. Latency provenance:
   `frame.error?.details?.reconciledByPid !== undefined`.
5. Census hash: step (0.4) recipe.

Snapshots: M1/M2 ≈ 03:43Z, M3 ≈ 03:46Z, M4 = 03:47:41Z, 2026-09-17. Values differ between snapshots
**by construction** (live store); do not treat any single snapshot as the truth.
