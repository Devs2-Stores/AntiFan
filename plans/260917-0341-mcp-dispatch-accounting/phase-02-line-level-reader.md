---
phase: 2
title: "Line-Level Reader & Checksum Seam"
status: pending
priority: P0
effort: "1d"
dependencies: [1]
---

# Phase 2: Line-Level Reader & Checksum Seam

## Overview

Admit frames **per line** instead of per file: extract the persisted-format definition so the reader and the writer cannot diverge, then classify every line into the taxonomy so that a quarantined file's intact frames are counted while its unverifiable frames are named. This phase is where the plan's central honesty claim is earned.

Division of ownership (post-revision): **Phase 1** owns the population rule, the census shape (`{ name, size, mtimeMs, lineCount, sha256 }` per file), the `ResidueClass` / `UnmeasuredReason` enums, the envelope and the census entry point (`runCensusPass`, renamed from `censusStore`). **This phase** owns the classification **order**, the per-line classes' **semantics**, the reader's **parse contract**, the composite identity and the per-file roll-up. **Phase 3** owns rows and reconciliation and consumes this phase's output — the `fileRollups` and the streamed frames — verbatim; it is **forbidden to re-scan** the store or re-derive per-file attribution.

Frozen order this phase implements (Phase 1 §6, adopted verbatim): **boundary → parse → structural → checksum-presence → strict checksum → ADMITTED**.

## Requirements

- **Functional:**
  - `readAdmittedFrames(census, sink)` walks **the census's file list verbatim** (it applies no name filter of its own), reads each file bounded at its censused byte length, and returns `{ admittedTotal, residue, fileRollups, labels, distinctComposites, superseded, drift }`. **It returns no frame array**: every admitted frame is handed to `sink.emit({ frame, key, file })` exactly once, in file order.
  - **Incremental sink (mandatory).** `sink` is caller-supplied and must be a streaming consumer (Phase 3 aggregates per recorded name as it goes; Phase 4's worker forwards into the envelope). The in-process path must never materialise the `result`-bearing set: the pass itself holds only counters, the composite-key `Set`, the bounded residue and the roll-ups. A caller that wants a frame array builds its own array-backed sink; the service path must not — `plan.md` constraint G explicitly forbids `readAdmittedFrames` materialising that set in the main process.
  - **The census is not enumerated here.** Phase 1 owns the entry point (renamed from `censusStore` to **`runCensusPass`**); this phase's `readAdmittedFrames` receives the census entries that stage A created and never enumerates, stats or filters a directory itself. **The call chain is fixed and one-directional, so `runCensusPass` and `readAdmittedFrames` are not two names for one entry point and neither may be collapsed into the other:** Phase 4's service spawns the worker → the worker calls Phase 3's `accountStore({ storeDir, asOf, memo })` → which wraps `runCensusPass(dir, asOf, opts)`, the **outer** entry (stage-A `readdir`+`stat` sweep, creating the census entries) → which calls **this phase's `readAdmittedFrames(census, sink)` as its stage-B core — exactly one call site** (reading each file bounded by its censused size, filling that entry's `sha256`/`lineCount`/`outcome` as it goes, and emitting every admitted frame to the sink) → then finalizes the census and returns `{ census, fileRollups, residue, counters }`. `runCensusPass` returns the census plus the roll-ups; `readAdmittedFrames` is the per-file core it drives.
  - `fileRollups` — the frozen per-file roll-up Phase 1 chose over per-entry attribution, keyed by the census `name`: `FileRollup = { file, quarantineLike, tempLike, frames, admitted, namedInvalid }`. `frames` = the non-blank window spans this pass classified for that file, and the frozen identity **`frames === admitted + namedInvalid` is asserted per file** — every span is admitted or named-invalid, never both and never neither, which is exactly the bug class the old ordering produced. `POST_CENSUS_APPEND` is not a frame of this snapshot and is excluded from both buckets. Phase 3 consumes `fileRollups` and may not re-scan.
  - Short reads are **not** a broken roll-up: the censused count is compared against the pass (`census.files[i].lineCount > fileRollup.frames`, or `sizeAfter < size`) and reported as `POST_CENSUS_TRUNCATE` with `lowerBound: true`. The frozen identity above still holds for every roll-up, including quarantined and truncated files; the short read is recorded in the residue and the roll-up's census comparison, never by making the identity false.
  - Admission order is fixed: the **byte-boundary test is step 1** (before parsing, so a segment can never be both appended and admitted), then the ledger's own evaluation order — parse (`:187`) → structural (`:188`) → checksum presence (`:193`) → checksum compare (`:197-202`). `STRUCTURAL_INVALID` is therefore evaluated **before** the checksum step, and a checksum-valid `formatVersion: 2` frame is named, never admitted.
  - Admission is decided by **strict checksum alone**. The `null→undefined` variant is evaluated **only** for a line that already failed strict, and its result is a **named sub-reason**, never an admission.
  - Per-line classes: `ADMITTED`, `STRUCTURAL_INVALID` (`reason: 'missing-identity' | 'unsupported-format-version'`), `CHECKSUM_MISMATCH` (`reason: 'writer-canonicalization-array-slot' | 'unexplained'`), `TORN_TAIL`, `UNPARSEABLE`, `RESIDUE_NO_CHECKSUM`, `POST_CENSUS_APPEND`; per-file outcomes `POST_CENSUS_TRUNCATE`, `VANISHED`; whole-read outcome `CENSUS_DRIFT`. Both `reason` fields are **closed two-member sets**; no consumer may invent a third member.
  - `STRUCTURAL_INVALID` mirrors `invocation-ledger.ts:188` **exactly** — `!id || !idempotencyKey || !attachmentId || formatVersion !== 1` — plus the case the ledger handles by throwing: `:188` dereferences `frame.id` unguarded inside the `:186` `try`, so a line whose JSON parses to a **non-object** (`null`, number, string, boolean) throws there and is quarantined by the `:246` catch. The reader must reach the same verdict (`STRUCTURAL_INVALID / missing-identity`) **without throwing**, because a throw would abort the file and lose every frame after it. Arrays need no special case (`[].id` is simply `undefined`) but are covered by the same non-object guard.
  - `POST_CENSUS_APPEND` is defined by **byte offset, not by ordering**: it is the segment whose START offset is `>= census.files[i].size`. It is tested at step 1, before parsing, so it can never also satisfy `ADMITTED`.
  - Per-file labels (independent of the ledger's reasons): `trailingNewline`, `parseFailures`, `checksumFailures`, `structuralInvalid`, `noChecksum`, `oversizeLine` (`Buffer.byteLength(span.text,'utf8') + 1 > DEFAULT_MAX_INVOCATION_FRAME_BYTES`, with the constant **imported from the seam module**, never from `invocation-ledger`), `quarantineLike` (name matches `*.quarantine-*`), `tempLike` (name matches `*.tmp-*`). Labels are labels: `quarantineLike`/`tempLike` never change what is read.
  - **Population rule (stated once).** The population is every census entry whose name **contains** `.jsonl` — deliberately **wider** than the writer's `endsWith('.jsonl')` (`invocation-ledger.ts:126`, `:142`), because the extra shapes are exactly the ones a naive reader loses: `*.jsonl.quarantine-<ts>` (the ledger renames whole partitions there, `:265`) and `*.jsonl.tmp-<pid>-<ts>` (compaction temp, `:829`; 0 present today). A name is never evidence about content: quarantined and temp files are read line-by-line like any other, and any duplication they carry is absorbed by the composite into `superseded`, never into `calls`.
  - Identity per line is a **validated composite** over `frame.attachmentId` and `frame.idempotencyKey`, and **never** derived from the file name (the ledger's `path.basename(file, '.jsonl')` at `:129`/`:144` is not a contract the reader may copy, and it is wrong for `*.quarantine-*` / `*.tmp-*`). A composite is formed **only when both fields are present and non-empty**; otherwise the line is admitted but **keyless** (`key: null`), never assigned the truthy string `"undefined\u0000undefined"`.
  - `superseded` = admitted lines − distinct non-null composites; `distinctComposites` is exposed for Phase 3's frame-level invariant.
  - Residue is accumulated **per file, per class**, as `{ class, reason?, fields?, observedFormatVersion?, count, firstByteOffset }` — bounded by `files × classes`, so it cannot grow with store size. No absolute path appears in any returned structure: a file is identified by its census `name`, and any reference uses the synthetic form `census:<hash-prefix>#L<line>`.
- **Non-functional:**
  - **Zero writes, zero ledger calls.** The reader takes an injected directory (via the census) and never resolves a data root. Its only value import is the seam module: it imports the frame type and every constant from there, and imports **nothing at all** from `./invocation-ledger`, so the `InvocationLedger` class is not linked and `initialize()` is structurally unreachable — not merely unreached.
  - No `electron` import; the module stays `require`-able from a plain Node process (Phase 4's CLI and worker depend on it).
  - Tolerate a file that vanishes between census and read (`ENOENT` per file); never fail the whole read.
  - Cost sanity: a full independent pass over the live store was measured by two reviewers at **7.9 s** and **11.4 s** (read + parse + identity maps). Both are snapshots; the bounded read must not be materially worse, and no timing constant is asserted.

## Architecture

### The seam (extraction, not re-implementation)

`computeFrameChecksum` is module-private (`src/main/session/invocation-ledger.ts:90`; call sites `:198`, `:429`, `:796`, `:834`) while `canonicalJsonStringify` is exported (`src/shared/control-plane-contracts.ts:506`). The function is the **definition of the persisted format**; a second copy would be a second source of truth deciding every admission, and any drift silently flips frames between `ADMITTED` and `CHECKSUM_MISMATCH` — exactly the failure this plan exists to remove.

The seam module owns the **whole persisted-format contract**: the hash, the byte ceiling and the line boundary. That is why the byte-ceiling constant **moves** here rather than being imported from the ledger (constraint B of `plan.md`).

```
CREATE src/main/session/invocation-frame-checksum.ts
        import * as crypto from 'node:crypto';
        import { canonicalJsonStringify } from '../../shared/control-plane-contracts';
        import type { InvocationRecord } from './invocation-ledger';   // type-only: erased, no runtime cycle
        export type { InvocationRecord };                              // re-exported so the reader imports one module

        export const DEFAULT_MAX_INVOCATION_FRAME_BYTES = 64 * 1024 * 1024;   // MOVED from :13
        export function computeFrameChecksum(frame: Omit<InvocationRecord,'checksum'>): string { … }   // moved verbatim from :90-93
        export function computeFrameChecksumNullArrayVariant(frame: …): string { … }   // diagnostic only; same hash + same canonicalizer
        export interface FrameLineSpan { start: number; end: number; text: string; terminated: boolean }
        export function frameLineSpans(raw: Buffer): FrameLineSpan[] { … }   // the ONE definition of a line boundary
        export function splitFrameLines(raw: string): string[] { … }         // frameLineSpans(utf8) → non-blank texts

MODIFY src/main/session/invocation-ledger.ts
        delete :90-93   (the helper)
        delete :13      (the constant)  → and replace with a re-export line so :118 keeps resolving
        delete import :3   (crypto — used only at :92)
        delete the canonicalJsonStringify entry at :10   (used only at :91; canonicalDigest stays needed at :308, :373)
        add    import { DEFAULT_MAX_INVOCATION_FRAME_BYTES, computeFrameChecksum, splitFrameLines } from './invocation-frame-checksum';
        add    export { DEFAULT_MAX_INVOCATION_FRAME_BYTES };   (see the note below — `export … from` does NOT work here)
        route  :177 and :418 through splitFrameLines   (both are the same expression today)
```

**The re-export cannot be an `export … from`.** A pure `export { X } from './mod'` creates **no local binding**, so the ledger's own `maxFrameBytes` constructor default at `:118` would stop resolving. Implemented and confirmed by the compiler: the `export … from` form fails with `error TS2304: Cannot find name 'DEFAULT_MAX_INVOCATION_FRAME_BYTES'` at `invocation-ledger.ts(116,51)`. The working form is one import carrying all three names plus a **local** `export { DEFAULT_MAX_INVOCATION_FRAME_BYTES };` — which satisfies both the constructor default and the two script consumers. Phase 6's re-certification must expect the emit to expose the constant as a `defineProperty` getter rather than a copied value binding.

Note the constant's re-export is **load-bearing, not cosmetic**: two script consumers destructure it from the *compiled ledger* — `scripts/certify-core-freeze.cjs:60` (asserted against the freeze ceiling at `:62-64`) and `scripts/smoke-real-soak.cjs:25` (asserted at `:199`). Dropping the re-export breaks both.

**Certification side effect — a dependency, not a discovery.** `.compiled/src/main/session/invocation-ledger.js` is one of the eleven inputs to `computeBuildIdentity()` (`scripts/certify-core-freeze.cjs:38-50`; hashed `:51-55`, compared `:142`, written `:176`), so this extraction changes that file's bytes and **invalidates the current core-freeze certification**. Phase 6 owns re-certification (its step 6 / row G14). Two things it must decide there, recorded here so they are not rediscovered: (a) the seam's own emit (`.compiled/src/main/session/invocation-frame-checksum.js`) is a **new** file that the eleven-input list does not currently include; (b) the identity changes regardless, because the ledger's bytes change. This phase does not edit the certification script.

**Which byte ceiling comparison the reader uses — stated, not inherited.** All three ledger sites bound the same quantity: the serialized frame plus its single `'\n'` terminator. `:178` and `:836` spell it `Buffer.byteLength(payload,'utf8') + 1 > maxFrameBytes`; `:803` spells it `Buffer.byteLength(line,'utf8') > maxFrameBytes` where `line` already ends in `'\n'` (`:802`) [INFERENCE: arithmetic identity — one byte for the terminator; read from the three sites]. The reader therefore compares `Buffer.byteLength(span.text,'utf8') + 1 > DEFAULT_MAX_INVOCATION_FRAME_BYTES`, which is literally `:178`'s expression. It does **not** compare the raw span length `span.end − span.start` (one byte looser for LF, two for CRLF) and it does not re-declare the number. **CRLF caveat, corrected:** the span excludes **both** `\r` and `\n`, so for CRLF input `byteLength(span.text) + 1` is one byte **short** of `:803`'s `line` length rather than equal to it. That is harmless for the thing being bounded — it is one byte *stricter*, never looser — and the writer emits only `'\n'` (`:802`, `:841`), so this is fixture-only: a live probe over the whole store measured **0 CRLF files**, and blank spans measured 0 as well. The unit test pins the asymmetry so nobody later "fixes" the `\r` exclusion, which is mandatory for `/\r?\n/` behaviour.
    
**Known cost, accepted deliberately.** `splitFrameLines(raw: string)` re-encodes through `Buffer.from(raw,'utf8')`, because the seam defines ONE line-boundary function over a Buffer. At the ledger's two call sites that is a transient second copy of the partition text during boot replay — the largest live partition is 143,203,927 B, so about 143 MB extra transient for that file. A string-based second boundary definition would remove the copy and re-create the divergence this seam exists to prevent, so the copy stays; it is recorded here as a cost, not as a bug awaiting a fix.

This is a **move**: function body, canonicalizer and hash algorithm are unchanged, so byte behaviour is identical. Gate it with `npm run test:main` before any reader code exists. Verified blast radius: every ledger-touching test imports only `{ InvocationLedger }` (`test/main/invocation-ledger.test.ts:6`, `capability-catalogue.test.ts:6`, `historical-authority-replay.test.ts:6`, `nested-cancellation.test.ts:8`, `target-transition.test.ts:8`, `workflow-engine.test.ts:28` — six files, re-read 2026-09-17), and repo-wide `computeFrameChecksum` appears in exactly one source file. Compile gates are structural and need no edit (`scripts/check-emit-integrity.mjs:54-78` derives emit paths from the source tree; `scripts/prune-orphan-emit.mjs:41` keeps `.compiled/**` when the mirrored `.ts` exists).

### Line splitting (one definition, three call sites, no alternative)

The ledger splits with `raw.split(/\r?\n/).filter(line => line.trim().length > 0)` at `:177` and again at `:418`. A third copy in the reader would make three definitions of "what a line is", and a divergence silently reclassifies lines between `UNPARSEABLE` and blank. `splitFrameLines` is exported from the seam and used at **all three** sites; the earlier "accept the duplication and pin it with matrix rows" fallback is **deleted** — in a plan whose thesis is that a second copy is a second source of truth, duplication cannot be an accepted outcome, and the seam module exists in this phase regardless.

To make the reader's byte accounting exact without a second definition, `splitFrameLines` is expressed **in terms of** `frameLineSpans`, which is the only place a boundary is decided:

- scan the buffer for `0x0A`; a span ends there, and a single `0x0D` immediately preceding it is excluded from `text` — exactly the `\r?\n` semantics, including a final unterminated span that keeps its bytes verbatim;
- `text = buf.toString('utf8', start, end)`, `start`/`end` are **byte** offsets, so a boundary that falls inside a multi-byte sequence cannot shift subsequent offsets;
- `terminated` is true iff the span ended at a `0x0A`.

Both expressions are then provably one rule rather than two (matrix row C6 asserts equality on LF and CRLF input).

### Classification order (per file, then per line)

```
For each census entry (verbatim; no name filter):
  A. stat/open              ENOENT                            → VANISHED (file-level; read continues)
  B. ONE read of size+1 bytes → buf      (size = census.files[i].size)
       window = buf[0 .. size)           ← the admissible window; exactly the censused length
       probe  = buf[size]                ← boundary probe byte: never hashed, never admitted
  C. stage B WRITES sha256(window) into census.files[i].sha256 (hash what you read)
       NO compare against that same field here: on a memo hit the pass never runs and no census
       exists, and on a memo miss readAdmittedFrames is runCensusPass's only caller, so no census
       can arrive carrying a stage-B hash. Within-pass drift is detected at step E, not here.
  D. split window+probe on 0x0A with a running byte offset; for each span IN THIS ORDER:
       1. span.start >= size                     → POST_CENSUS_APPEND   (not parsed, not hashed, not a call)
       2. JSON.parse throws:
            span is the last window span AND window[size-1] !== 0x0A  → TORN_TAIL
            otherwise                                                  → UNPARSEABLE
       3. parsed is not a non-null object (null/number/string/boolean) → STRUCTURAL_INVALID / missing-identity
            (`:188` throws on this line and is caught at `:246`; the reader names it instead of aborting the file)
          !frame.id || !frame.attachmentId || !frame.idempotencyKey   → STRUCTURAL_INVALID / missing-identity
          frame.formatVersion !== 1                                    → STRUCTURAL_INVALID / unsupported-format-version
       4. !frame.checksum                                             → RESIDUE_NO_CHECKSUM
       5. strict sha256(canonicalJsonStringify(frame minus checksum)) === checksum
            passes                                            → ADMITTED (composite validated → key | null)
            fails; null→undefined variant reproduces           → CHECKSUM_MISMATCH / writer-canonicalization-array-slot
            fails; variant fails too                           → CHECKSUM_MISMATCH / unexplained
  E. post-read stat: sizeAfter / mtimeMsAfter
       sizeAfter === size and mtimeMs unchanged                 → clean (the normal path: ONE read per file)
       sizeAfter < size  OR  window spans < census.lineCount    → POST_CENSUS_TRUNCATE (file-level; rows lowerBound)
       sizeAfter > size and the re-read of the same window matches C's hash
                                                                → POST_CENSUS_APPEND  (file-level; bytes = sizeAfter − size)
       size or mtimeMs changed AND the re-read of the same window hashes differently from C
                                                                → CENSUS_DRIFT (UNMEASURED, rows: [], fail closed)
       (the re-read happens ONLY on a changed size/mtimeMs, so the normal path stays a single read per file)
```

Why the boundary test is step 1 and what it costs: the old order placed it after admission, so a segment could satisfy both and the class was unobservable from a bounded read. Defining it by **start offset** and testing it first makes it reachable and mutually exclusive with `ADMITTED`. Two deliberate consequences:

- The **`size+1` probe byte is never content.** It exists only to observe "a byte exists at the censused boundary". Because step 1 runs before parsing and before the torn-tail rule, a probe byte of `{` cannot manufacture a spurious `TORN_TAIL` — that was the trap in the earlier design, where the read buffer's own last segment was used as the torn-tail test. The torn-tail test reads **`window[size-1] !== 0x0A`** (the censused window's final byte), never the read buffer's final byte.
- **The window, not the buffer, is what is hashed and counted.** `sha256` covers exactly `size` bytes, so `censusHash` still describes only bytes that were actually consumed, and each `FileRollup` closes on the window: `frames === admitted + namedInvalid`, where `namedInvalid` counts **window** spans only and excludes `POST_CENSUS_APPEND` (which is not a frame of this snapshot at all). A line count beyond the probe byte is not enumerated; the fact and size of the append come from the post-read `stat` (`sizeAfter − size`), which is recorded rather than guessed.

Append vs drift, and why both exist: a **growth whose window re-read still matches** is a benign concurrent append (`POST_CENSUS_APPEND`, rows `lowerBound: true`); a **changed `size`/`mtimeMs` whose window re-read hashes differently** is `CENSUS_DRIFT`, which fails closed with `UNMEASURED` and `rows: []`. That is the difference between "the store grew" and "the snapshot is mixed"; the second must never render. Honest hole, stated once: a rewrite that preserves **both** `size` and `mtimeMs` is invisible *inside* this pass, because no re-read is triggered — triggering one on an unchanged `stat` would double every read and void the single-pass claim. It is caught **between** runs by the content-derived `censusHash` over the stage-B hashes (Phase 1's field, compared by Phase 4's memo key), not here [INFERENCE: the cross-run comparison is Phase 1/4's mechanism; this phase contributes only the per-file hash it writes].

Boundary rules derived from the write shape (`appendFrameUnlocked` `:790-811`: `JSON.stringify(frameWithChecksum) + '\n'` appended; compaction rewrite ends with `\n` at `:841`):

- Only the **last** censused span can be a torn tail (appends are strictly sequential at the end, and compaction always terminates its rows).
- "Torn" is detected by the **missing trailing newline of the censused window**, not by parse failure: a torn tail can coincidentally parse, and a probe byte is not a newline.
- A torn prefix can never satisfy a checksum over the whole frame, so a strict pass is conclusive at any position.
- Honest holes, documented rather than hidden: a torn tail whose remainder is whitespace-only is invisible (the blank-line filter drops it); a genuinely corrupt final line in a file that still ends with `\n` is indistinguishable from a torn one and lands in `CHECKSUM_MISMATCH`; and an appended line is neither counted nor enumerated (only its byte size is known).

### Parse contract for `InvocationRecord`

Declared `invocation-ledger.ts:19-45`, written as `JSON.stringify({...rest, checksum})` (`:795-802`). Re-read 2026-09-17; the field list is exactly:

- **Required:** `formatVersion` (`:20`; the ledger rejects anything but `1` at `:188`), `id` (`:21`), `attachmentId` (`:22`), `requestId` (`:23`), `idempotencyKey` (`:24`), `name` (`:25` — the **recorded, post-alias** dispatch name), `paramDigest` (`:26`), `policyDigest` (`:27`), `policyVersion` (`:28`), `recordedVisibility` (`:29`), `state` (`:30`), `authoritySnapshot` (`:32`), `createdAt` (`:42` — the frame's **only** timestamp; the dispatch name is the top-level `name`).
- **Optional (absent, never null):** `dispatchStage` (`:31`), `result` (`:33`), `error` (`:34-38`; `error.code` is the histogram key and `error.details` is itself absent, never null), `evidence` (`:39`), `replacementAuthorityRevision` (`:40`), `artifactIds` (`:41`), `settledAt` (`:43`), `checksum` (`:44`). `JSON.stringify` drops `undefined` object values, so every optional field is *possibly-absent*.

**That list is the complete frame.** A field not in it does not exist on the persisted record; the reader and Phase 3 must consume only these names and must never probe for a nested object or a second time field.

Measured enforcement of the contract (two independent read-only scans of the live store, 2026-09-17, minutes apart — the first read 1,043 matching entries (1,036 `*.jsonl` + 7 `*.jsonl.quarantine-*` + 0 `*.jsonl.tmp-*`), 240,935,588 bytes and 19,176 non-blank lines; the second read 19,226 frames, 50 more, which is itself the point that every count here is a **snapshot re-derived at run time and never asserted**): **0** unparseable lines, **0** lacking `id` / `attachmentId` / `idempotencyKey` / `name` / `checksum`, **0** frames carrying a key outside the list above (19 distinct keys observed; the optional `evidence` and `artifactIds` simply never occur in this store), **all** `formatVersion === 1`. Presence law for `settledAt`: **18,954 of 18,954** terminal frames carry it and **0 of 222** non-terminal frames do. `RESIDUE_NO_CHECKSUM` and `STRUCTURAL_INVALID` therefore have **0 live instances**; they exist because the ledger quarantines on exactly those predicates (`:193`, `:188`) and must be synthesized as fixtures. Note that `name` is *not* one of `:188`'s guards, so an admitted frame with a blank/absent `name` is reachable in principle (0 live instances) — that is the reachable half of `unattributedFrames` (§ Composite identity).

### Composite identity (validated, not concatenated)

```ts
compositeIdentity(frame): { ok: true; key: string } | { ok: false; reason: 'MISSING_IDENTITY_FIELD' }
```

- The guard mirrors the ledger's own structural predicate (`:188`): a field counts as present only if it is a **non-empty string**, and it is deliberately **not trimmed**, so the reader cannot disagree with the writer about which frames are identity-bearing.
- Raw concatenation is forbidden precisely because it fails open: `attachmentId + '\u0000' + idempotencyKey` yields the **truthy** `"undefined\u0000undefined"` when a field is absent, which would collapse every identity-less frame into one composite, deflate `calls`, inflate `superseded`, and leave `unattributedFrames` at 0 while reconciliation still reports success. Measured today: **0** frames lack either field, which is exactly why only a driven fixture can catch it.
- This guard is **defence in depth, and its reach is stated honestly**: after step 3, an admitted line has already passed the same three field checks the ledger performs at `:188`, so `MISSING_IDENTITY_FIELD` cannot fire for a line the reader admits today. It is the fail-closed belt for a future writer that admits a frame the ledger would reject; it is pinned by a forced-failure row and by the pipeline row below, which exercises the reachable path — an admitted, checksum-valid frame with a valid composite but a blank/absent `name` must arrive in Phase 3 as `unattributedFrames === 1`, not silently merged under `undefined`.
- The composite is defined **once, here**, and Phase 3 consumes the key the pass already put on each streamed frame (`sink.emit({ frame, key, file })`) instead of re-deriving it. Residual, recorded rather than hidden: the `'\u0000'`-delimited form is injective unless a field itself contains U+0000, which is unobserved in the live store [INFERENCE: no such frame in the scan above] — a frame that did would be mis-keyed, so the delimiter is a documented hazard rather than a proven invariant.

## Related Code Files

- Create: `src/main/session/invocation-frame-checksum.ts` (the seam: hash, byte ceiling, line boundary, type re-export)
- Modify: `src/main/session/invocation-ledger.ts` (delete `:13` and `:90-93`; drop imports `:3`, `:10`; add one import + one re-export; route `:177`/`:418` through `splitFrameLines`)
- Modify: `src/main/diagnostics/mcp-dispatch-accounting.ts` — **created by Phase 1** (verified absent 2026-09-17); this phase adds `readAdmittedFrames`, `classifyLine`, `compositeIdentity`, `fileRollups` and per-file labels. It is the **stage-B core that Phase 1's `runCensusPass` calls** (exactly one call site), filling each census entry's `sha256`/`lineCount`/`outcome` from the bytes it read
- Modify: `test/main/mcp-dispatch-accounting-reader.test.ts` — **created by Phase 1** (verified absent 2026-09-17); this phase extends it with the matrix below
- Read-only reference: `src/main/session/invocation-ledger.ts:188-202`, `:246-249`, `:260-271`, `:790-811`, `:829-844`; `src/shared/control-plane-contracts.ts:506-517` (the canonicalizer whose array branch `:510-511` is the diagnostic's subject)
- Delete: none

## Implementation Steps

1. Create the seam module (hash + variant + constant + line spans) and make the ledger import from it; run `npm run typecheck && npm run compile && npm run test:main`. **Do not start the reader until this is green** — the extraction must be provably behaviour-identical, including `splitFrameLines` at `:177`/`:418`.
2. Implement `readAdmittedFrames(census, sink)` with the one-read bounded window: read `size + 1` bytes once, hash exactly the first `size`, and keep the probe byte out of every line, count and hash. The pass returns counters, roll-ups and bounded residue only — never a frame array.
3. Implement the classifier in the frozen order (`boundary → parse → structural → checksum-presence → strict checksum → ADMITTED`). The `null→undefined` variant is a **diagnostic on an already-failed line**; write a comment stating the counterexample that makes this mandatory (5 live frames contain all-null arrays and pass strict while failing the variant, e.g. `attachment-2a196818-c582-449b`:122, `attachment-db7a365f-96af-4176`:153). A reader that normalizes before hashing loses those 5.
4. Add `STRUCTURAL_INVALID` — evaluated **before** the checksum step, mapping `:188`'s predicate: a non-object parse result, or a missing `id`/`attachmentId`/`idempotencyKey` ⇒ `missing-identity`; `formatVersion !== 1` ⇒ `unsupported-format-version`, with the observed version recorded in the residue entry. The non-object guard exists so a line containing `null` cannot throw the file's remaining frames away.
5. Implement `compositeIdentity` and drive the pass through the sink: `sink.emit({ frame, key: string | null, file })` once per admitted frame, while the pass itself keeps only `admittedTotal` (a counter), `distinctComposites` (a `Set` of non-null keys), `superseded = admittedTotal − distinctComposites`, and `drift`.
6. Build `fileRollups` as you go (no second scan) and assert the frozen identity `frames === admitted + namedInvalid` per file before returning; a roll-up that does not close is a **defect to fix in the classifier**, never a `false` to report (unlike Phase 3's reconciliation booleans, which are honest measurements).
7. Compute per-file labels independently of the ledger's own reasons. The reader must never assert "quarantined ⇒ checksum-bad": the ledger quarantines a whole partition on oversize (`:178`), parse failure (`:246`), missing `checksum` (`:193`), checksum mismatch (`:199`), missing identity fields or `formatVersion !== 1` (`:188`).
8. Write the fixtures for the matrix below. Every synthetic case is constructed in the test file; the live-specimen rows (N1-N3) pin the real counterexamples and the real field law — N2 is the row that **must fail** if anyone reintroduces pre-hash normalization. Checksum-valid fixtures are built by calling the seam's own `computeFrameChecksum`, never by pasting a hash from the store.
9. Add the structural guards: (a) tree-hash the temp fixture dir before/after a full read and assert equality; (b) assert the reader module's source imports **nothing** from `./invocation-ledger` and contains no `writeFileSync`/`mkdirSync`/`appendFile`/`unlink`; (c) assert the compiled emits of both the reader module and the seam contain no `require` of `invocation-ledger`, `control-plane-runtime`, `capability-transport` or `electron` — the mechanical form of "`initialize()` is structurally unreachable"; (d) assert the pass's return value carries no frame-bearing array (row S1).
10. Gate: `npm run compile && npm run test:main && npm run test:file -- .compiled/test/main/mcp-dispatch-accounting-reader.test.js`.

## Success Criteria

- [ ] Seam extraction is behaviour-identical: `npm run typecheck`, `npm run compile`, `npm run test:main` green after step 1 and unchanged at the end of the phase; both script consumers of the re-exported ceiling still resolve it.
- [ ] On the quarantined files: each `FileRollup` closes (`frames === admitted + namedInvalid`), with the admitted/named split **re-derived at run time** (never asserted as constants; the plan's own passes recorded 247/7 and a file-level reader's 0 is demonstrably wrong).
- [ ] `fileRollups` carry the frozen shape `{ file, quarantineLike, tempLike, frames, admitted, namedInvalid }` and close for **every** file, including quarantined and truncated ones; a short read shows up as `census.lineCount > frames` plus `POST_CENSUS_TRUNCATE`, never as a broken identity.
- [ ] The pass materialises no frame array: it returns counters, roll-ups and bounded residue only, and every admitted frame reaches the caller-supplied sink exactly once (Σ`fileRollups[*].admitted` equals the sink's emission count).
- [ ] Phase 3 consumes `fileRollups` and the streamed keys without re-scanning the store or re-deriving identity (the key is already on each emitted frame).
- [ ] A line whose JSON parses to a non-object (`null`) is `STRUCTURAL_INVALID` / `missing-identity` and does **not** throw, so the frames after it are still classified (the ledger reaches the same verdict via the `:188` throw caught at `:246`).
- [ ] `STRUCTURAL_INVALID.reason` and `CHECKSUM_MISMATCH.reason` are closed two-member sets.
- [ ] A checksum-valid `formatVersion: 2` frame is `STRUCTURAL_INVALID` / `unsupported-format-version` and is **not** admitted and **not** counted as a call (this is the row that was unreachable before the order was fixed).
- [ ] `STRUCTURAL_INVALID` is evaluated before the checksum step, mirroring `:188` → `:193` → `:197`.
- [ ] A line with all-`null` arrays that passes strict is `ADMITTED` (N2) — pre-hash normalization is a defect, not a fix.
- [ ] The strict-failures that the diagnostic reproduces are named `writer-canonicalization-array-slot` and are **not** admitted.
- [ ] `TORN_TAIL` is reserved for a truncated final span of the **censused window** (its last byte is not `0x0A`); a mid-file parse failure is `UNPARSEABLE` (T3), and a `size+1` probe byte never produces `TORN_TAIL` (T13).
- [ ] `POST_CENSUS_APPEND` is tested by start offset **before** parsing: a mid-read append is named, the appended frame is not in the admitted set, and its name contributes no call to this run (T11).
- [ ] Zero writes: fixture tree hash identical before/after; no ledger class linked; the compiled emits carry no ledger `require`.
- [ ] Identity comes from the frame's validated composite even when the file name's stem disagrees (T8), and no code path can construct `"undefined\u0000undefined"` (I3).
- [ ] `unattributedFrames` can be non-zero through the real pipeline: a checksum-valid admitted frame with a valid composite but no `name` yields exactly 1 and the key invariant still holds (I4).
- [ ] The reader applies no name filter: a census entry named `*.jsonl.bak` is read, and `quarantineLike`/`tempLike` change labels only (P1/P2).
- [ ] A compaction leftover `*.jsonl.tmp-*` yields superseded frames and no double-counted calls (T7).
- [ ] The extraction's effect on core-freeze certification is recorded as a Phase 6 dependency (row C7), not discovered later.

## Test Scenario Matrix

| # | Scenario | Fixture | Expected |
|---|---|---|---|
| T1 | Torn tail: final line truncated mid-JSON, file lacks trailing `\n` | synthesized | `TORN_TAIL`; `ADMITTED` unchanged |
| T2 | Torn remainder is whitespace only | synthesized | no residue emitted — the documented hole, not a silent count |
| T3 | Middle line unparseable, file ends with `\n` | synthesized | `UNPARSEABLE`, **not** `TORN_TAIL` |
| T4 | Line parses, `checksum` absent | synthesized | `RESIDUE_NO_CHECKSUM`, named (0 live instances; the ledger quarantines on this at `:193`) |
| T5 | **Checksum-valid** `formatVersion: 2` (checksum computed by the seam) | synthesized | `STRUCTURAL_INVALID` / `unsupported-format-version`; not admitted; 0 calls |
| T5b | **Checksum-valid** frame with `attachmentId: ''` | synthesized | `STRUCTURAL_INVALID` / `missing-identity`, `fields: ['attachmentId']` |
| T6 | Middle line checksum mismatch, no nulls in arrays | synthesized | `CHECKSUM_MISMATCH` / `unexplained` |
| T7 | Compaction leftover `*.jsonl.tmp-<pid>-<ts>` duplicating rows | synthesized | both admitted; composite dedupe ⇒ `superseded += N`, `calls` unchanged |
| T8 | File-name stem disagrees with `frame.attachmentId` | synthesized | identity follows the frame field |
| T9 | Compaction shrinks a file between census and read | census 5 lines, truncate to 3 before the read | 3 counted + `POST_CENSUS_TRUNCATE`; rows `lowerBound: true` |
| T10 | File vanishes between census and read (also covers the old E4 row — same scenario, folded) | delete after census | `VANISHED`; the read still completes |
| T11 | **Mid-read append**: a full frame lands after the census `stat` | synthesized: write frame, census, append a second real frame, read | `POST_CENSUS_APPEND` named with `bytes = sizeAfter − size`; the appended frame is **not** admitted; rows `lowerBound: true` |
| T12 | **Truncated multi-byte tail**: the census boundary fell inside a multi-byte UTF-8 character (an append was mid-flight) | synthesized: write a frame whose payload contains a multi-byte char, census mid-append, finish the append | last window span is `TORN_TAIL` (window's last byte ≠ `0x0A`); the probe bytes are `POST_CENSUS_APPEND`; no `UNPARSEABLE`/`CHECKSUM_MISMATCH` invented; byte offsets stay exact |
| T13 | Boundary sits exactly on `\n`, one byte appended | synthesized | probe byte is `POST_CENSUS_APPEND`; **no** `TORN_TAIL` (pin against the `size+1` trap) |
| T14 | Line parses to a non-object (`null`, then a bare number) between two valid frames | synthesized | `STRUCTURAL_INVALID` / `missing-identity`; no throw; both surrounding frames still classified. The **ledger** still throws at `:188` and catches at `:246` (quarantining the whole partition); the reader's non-throwing verdict is deliberately a **different mechanism reaching the same classification**, so a future editor must not "simplify" it by importing the ledger's behaviour |
| R1 | Roll-up closes per file | fixture dir: one clean `*.jsonl`, one `*.jsonl.quarantine-<ts>`, one `*.jsonl.tmp-<pid>-<ts>`, one truncated file | `frames === admitted + namedInvalid` for each entry; `quarantineLike` true only for the quarantine file, `tempLike` only for the tmp file, and the roll-up flags equal the `labels` flags; the truncated file also yields `POST_CENSUS_TRUNCATE` with `census.lineCount > frames` |
| S1 | Incremental sink | an array-free sink that counts emissions | emission count equals Σ`fileRollups[*].admitted`; the returned object contains no frame-bearing array |
| N1 | Live specimen: strict-invalid, variant reproduces | one of the quarantined frames | `CHECKSUM_MISMATCH` + `writer-canonicalization-array-slot`; **not** admitted |
| N2 | Live specimen: strict-VALID frame containing all-`null` arrays | e.g. `attachment-2a196818-c582-449b`:122 | `ADMITTED`; a normalizing reader fails this row |
| N3 | Live specimen: the writer's field law | live store (acceptance) | every frame's key set ⊆ the declared list; `settledAt` on all terminal and no non-terminal frames; re-derived, never asserted |
| Q1 | Quarantined file admitted line-by-line | the quarantined files | `admitted + namedInvalid == lineCount` per file (re-derived) |
| Q2 | Line-level beats file-level | same files | file-level admission loses the admitted count (the plan's passes recorded 247) |
| I1 | One `idempotencyKey` across many partitions (live `idem-mcp-2` spans 92) | synthesized or live | one row per composite; not collapsed |
| I2 | One composite, several transitions | synthesized | `superseded` = admitted − distinct composites |
| I3 | Composite guard, forced failure | `{ attachmentId: '', idempotencyKey: 'k' }` | `{ ok: false, reason: 'MISSING_IDENTITY_FIELD' }`; `"undefined\u0000undefined"` is never produced |
| I4 | `unattributedFrames` through the **real pipeline** | hand-built checksum-valid line with a valid composite but no `name`, driven through census → read → reconcile | `unattributedFrames === 1`; `classifiedKeys + unattributedFrames === compositeKeys` holds; the frame is not folded under `undefined` |
| P1 | Population comes from the census, verbatim | census entry named `decoy.jsonl.bak` | it is read; a reader that re-filtered with `endsWith('.jsonl')` fails this row |
| P2 | Name-derived labels are labels | one file, flip `quarantineLike`/`tempLike` naming | labels change; the admitted set and counts do not |
| C3 | Reader performs zero writes | temp fixture tree | tree hash identical; no `initialize`/`pruneDeadPartitions`/`settle` reachable |
| C4 | Reader count vs `getStats().frameCount` | live store | the reader's number exceeds the gauge by the quarantine frames (a resource gauge is not a history source) |
| C5 | No ledger link in the compiled emits | `.compiled/**` after `compile` | neither the reader emit nor the seam emit `require`s `invocation-ledger`, `control-plane-runtime`, `capability-transport` or `electron` |
| C6 | One definition of a line | LF and CRLF inputs | `splitFrameLines(raw)` equals `raw.split(/\r?\n/)` projected to non-blank lines, and `frameLineSpans` decodes to the same texts with byte-exact offsets |
| C7 | Core-freeze identity changes | run `computeBuildIdentity()` before/after the extraction (acceptance; Phase 6 owns the re-certification) | the identity differs because `.compiled/src/main/session/invocation-ledger.js` changed; recorded, not ignored |

## Function / Interface Checklist

| Symbol | Signature | Responsibility |
|---|---|---|
| `computeFrameChecksum` | `(frame: Omit<InvocationRecord,'checksum'>) => string` | moved verbatim; single definition shared by writer and reader |
| `computeFrameChecksumNullArrayVariant` | `(frame) => string` | diagnostic only; same hash, same canonicalizer, array `null`s mapped to `undefined` — never an admission path |
| `DEFAULT_MAX_INVOCATION_FRAME_BYTES` | `number` | moved into the seam; re-exported by the ledger for its own sites and for the two script consumers |
| `frameLineSpans` | `(raw: Buffer) => FrameLineSpan[]` | the one definition of a line boundary, with byte-exact offsets and terminator flag |
| `splitFrameLines` | `(raw: string) => string[]` | `frameLineSpans` projected to non-blank texts; used at `:177` and `:418` and by the reader |
| `readAdmittedFrames` | `(census: Census, sink: FrameSink) => Promise<PassResult>` | the **stage-B core** of `runCensusPass` (exactly one call site): bounded one-read window per file, per-line classification, identity, roll-ups; emits each admitted frame to the sink, returns no frame array, and fills the entry's `sha256`/`lineCount`/`outcome` |
| `FrameSink` | `{ emit(entry: { frame, key: string \| null, file: string }): void }` | the mandatory incremental sink; Phase 3 aggregates through it, Phase 4's worker forwards through it |
| `PassResult` | type | `{ admittedTotal, residue, fileRollups, labels, distinctComposites, superseded, drift }` |
| `FileRollup` | `{ file, quarantineLike, tempLike, frames, admitted, namedInvalid }` | frozen per-file roll-up; `frames === admitted + namedInvalid` asserted per file; the only per-file attribution Phase 3 may consume |
| `runCensusPass` | `(dir: string, asOf: string, opts) => { census, fileRollups, residue, counters }` — **Phase 1's symbol**, renamed from `censusStore` | the **outer entry point of the whole pass**: stage-A `readdir`+`stat` sweep creating the census entries, then calls this phase's `readAdmittedFrames` as its stage-B core, then finalizes the census; read-only |
| `classifyLine` | `(span, isLastWindowSpan, windowEndsWithNL, checksumOf) => Classified` | the frozen classification order, boundary test first |
| `compositeIdentity` | `(frame) => { ok: true, key } \| { ok: false, reason: 'MISSING_IDENTITY_FIELD' }` | validated composite; the only place identity is defined |
| `FileLabels` | type | `trailingNewline`, `parseFailures`, `checksumFailures`, `structuralInvalid`, `noChecksum`, `oversizeLine`, `quarantineLike`, `tempLike` (the extended per-file diagnostics; the two name-derived flags also appear in `FileRollup` because Phase 1 froze them there, and a row asserts the two agree) |

**Must not import** (structural, not stylistic): `invocation-ledger` (not even for a type — the seam re-exports `InvocationRecord`), `control-plane-runtime.ts` (owns `initialize()` `:229` and `pruneDeadPartitions` `:233`), `capability-transport.ts` (owns every `settle`/`advanceStage`/`claimOwner` call — the write path this plan must not touch), `src/main/index.ts` (composition root, caller of `settleInFlightForShutdown`), `mcp-server.ts` (the recorded name is already in the frame; importing risks a catalogue cycle), the `InvocationLedger` class as a value, and `StorageLocations` for auto-resolution.

## Dependency Map

```
C1 seam extraction  ──┬──► Phase 6 (G14): core-freeze re-certification
                      │
C2/C3 runCensusPass ──┴──► C4 readAdmittedFrames ──(sink)──► Phase 3 aggregate ──► Phase 4 worker/CLI/Hub
      (Ph.1, outer              (this phase, stage-B             + fileRollups
       entry: stage A)            core it calls)
```

C1 and Phase 1 are independent and may land in either order; C4 requires both. C1's gate (`test:main`) must be green before C4 starts. `runCensusPass` is the outer entry and **calls** `readAdmittedFrames` exactly once; Phase 3 consumes the stream and the roll-ups and must not re-scan. Phase 6 consumes C1's side effect (row C7). Note for the parent plan: `phase-06-gates-docs-and-followup.md` lists `dependencies: [4, 5]` in its frontmatter while its own step 6 and dependency map consume this phase's extraction — a documentary gap in that file, not a runtime one [INFERENCE].

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|---|---|---|
| The strict-invalid frames are treated as corruption, or silently admitted | named residue loses its `reason`, or every frame is admitted | strict first; the variant is a named sub-reason only; never fold into `ADMITTED`; never hard-code the split |
| A checksum-valid future-version or identity-less frame is admitted as a real dispatch | rows grow while `STRUCTURAL_INVALID` stays 0 | `STRUCTURAL_INVALID` is evaluated before the checksum step, mapping `:188`'s predicate; T5/T5b |
| A reader normalizes before hashing | currently-valid frames flip to `CHECKSUM_MISMATCH` | N2 pins the counterexample; normalization is a defect |
| Identity is concatenated raw | one `"undefined\u0000undefined"` row absorbs every identity-less frame and `unattributedFrames` stays 0 | validated composite returning `MISSING_IDENTITY_FIELD`; I3/I4 |
| A checksum-valid frame with no `name` is silently merged | calls land on an `undefined` row | I4 drives the real pipeline and asserts `unattributedFrames === 1` |
| A line whose JSON parses to a non-object throws in the reader | the read aborts and every later frame in that file is lost — the exact loss this plan exists to remove | the structural step guards the dereference before reading any field: non-object ⇒ `STRUCTURAL_INVALID` / `missing-identity` (`:188` achieves the same verdict by throwing into the `:246` catch); T14 |
| The in-process path materialises the result-bearing frame set | memory spike and a main-process stall on the 240 MB store, and the P0 off-main-thread claim becomes false | the pass streams every admitted frame to the caller's sink and returns counters, roll-ups and bounded residue only; S1 |
| The boundary test sits after admission, or the probe byte is treated as content | a segment is both appended and admitted; a probe `{` reads as `TORN_TAIL` | boundary by start offset at step 1; torn-tail test reads the **window's** last byte; T11-T13 |
| A compaction temp file double-counts | calls inflate against the `getStats()` gauge | identity from the frame's composite; duplicates become superseded (T7) |
| The reader re-filters by name and drops a shape the census kept | quarantine/tmp/decoy entries contribute nothing | population is the census's, verbatim; `quarantineLike`/`tempLike` are labels; P1/P2 |
| `pruneDeadPartitions` deletes a partition mid-read | file set shrinks between runs | tolerate `ENOENT` per file (T10); never fail the read on one vanished file |
| Quarantine rename collision | one attachment has both a live and a quarantine file with the same stem | never treat name stems as unique; dedupe on the composite (T8); `quarantinePartition` swallows a rename failure at `:270` |
| A quarantine reason is misattributed as checksum failure | an oversize-quarantined file is reported as checksum-bad | labels are computed independently; the largest quarantined file is far below the 64 MB ceiling, so no quarantined file is oversize |
| The seam extraction changes byte behaviour | any `test:main` case fails | it is a move: body, canonicalizer, algorithm and (via `frameLineSpans`) the line-boundary semantics are unchanged; gate on `test:main` first |
| A single enormous partition saturates memory | memory spike on the largest single file (143 MB today) | one file at a time, bounded by the censused `size`, which is known **before** the read; the cross-file ceiling belongs to Phase 4's worker budget (`POPULATION_TRUNCATED`) and no constant is invented here |
| The extraction invalidates core-freeze certification silently | `certify:core-freeze` reports a build-identity mismatch | it is a declared dependency (C7) with Phase 6's re-certification row G14; the seam's own emit is not in the eleven-input list and Phase 6 decides whether it joins |
