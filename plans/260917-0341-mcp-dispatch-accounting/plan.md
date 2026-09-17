---
title: "MCP Dispatch Accounting"
description: "Read-only accounting suite for the AntiFan MCP surface: per-dispatched-tool volume, terminal state mix, error-code histogram and latency, measured from the control-plane invocation ledger with line-level checksum admission, composite identity, honest UNMEASURED holes, and an off-main-thread reader."
status: pending
priority: P1
effort: "4-5d"
tags: [mcp, telemetry, ledger, observability, workflow-hub, evidence-integrity]
created: 2026-09-17
---

# MCP Dispatch Accounting

## Overview

The user asked, verbatim: *"Bổ sung bộ thống kê MCP để xem mức độ hiệu quả của từng MCP được gọi"* — add an MCP statistics suite showing how effective each MCP tool that gets called actually is.

AntiFan Browser Desktop exposes its browser-automation capabilities over MCP to external coding agents. Today the Hub window lists the registered capabilities with **no usage or outcome column**, so nobody can answer: which tools are actually called, what terminal state they reach, which error codes dominate, and how slow they are. The control-plane already persists the answer — the invocation ledger writes a frame per dispatch into `control-plane-v2/invocations/*.jsonl` — but nothing reads it for this purpose, and the naive readers that exist today silently lose data (see Design Decision 2).

This plan delivers **one read-only reader** feeding **three ledger populations plus one provenance-labelled proxy population**, rendered in **one panel** plus an explicitly labelled hole, backed by a CLI that proves the same reader works outside Electron.

What this plan is **not**: it is not a new ledger, not a hot-path instrument, not an agent-self-report metric, and not a tool-reliability leaderboard.

> **Revision note (2026-09-17):** this document is the post-red-team revision. Four review lenses filed 40 findings; the adjudication table is in *Red Team Review* below, and the phase renumbering it caused is recorded there too. Superseded text is not left standing anywhere in this plan.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Every MCP tool that was actually dispatched has a measured row: call count, terminal state mix, error-code histogram, latency | P1 |
| 2 | The reader names what it cannot admit instead of dropping files, and the frames carried by quarantined partitions are reported as a **labelled margin** (7 quarantined files hold 254 frames, 247 checksum-valid) | P1 |
| 3 | Identity is the composite `(attachmentId, idempotencyKey)`, never the bare `idempotencyKey` | P0 |
| 4 | Unknown/absent data renders as `UNMEASURED`/`NO_DATA` with the mechanism named — never as `0` | P0 |
| 5 | The reading pass never blocks the Electron main process, and says so with a budget when it cannot finish | P0 |
| 6 | The 51 `core.*` tools stop being invisible, via a separate proxy-side store that nothing sums into ledger rates and that has a named consumer | P2 |
| 7 | Zero new writes on the app's hot dispatch path; the reader never calls `InvocationLedger.initialize()` | P0 |

## Non-Goals

- **The agent self-report panel (former Phase 5) is deferred to its own follow-up plan** (user decision 2026-09-17). Its reader duplicated a resolver the app already injects, its mandated root rule provably could not reach the store it had to display, it double-counted records across rotation, and it rendered attacker-controlled MCP text into a privileged renderer. It is a real divergence signal and it is *not* cancelled — it is unfunded here. See *Follow-Ups Out of Scope*.
- Fixing the `canonicalJsonStringify` array-slot defect (out of scope; follow-up recorded — it is shared by policy/param digests, so the blast radius is repo-wide).
- Any success-rate percentage that mixes populations, any "reliability score", any ranking of tools by failure count.
- Backfilling `core.*` history (impossible: it was never recorded anywhere) or capturing the caller's typed alias (rewritten before Persist; see Design Decision 5).
- Changing the advertised MCP surface: **no new advertised MCP tool** may be added by this plan.
- Retention changes: the plan reports the retention caveat, it does not extend it.

## Design Decision — the locked shape

Origin: an `--ultra` best-of-5 problem-solving pass chose **"one reader, one population rule, four populations"** unchanged. The two-panel half of that shape was retired by the 2026-09-17 user decision (see DD8); the four populations survive intact.

**1. One reader, one population rule.** Population = every file under the control-plane `invocations/` directory whose name **contains** `.jsonl` — deliberately **wider** than the writer's `endsWith('.jsonl')` (`src/main/session/invocation-ledger.ts:126`, `:142`), because the extra shapes are exactly the ones a naive reader loses: `*.jsonl.quarantine-<ts>` (254 frames stranded today) and `*.jsonl.tmp-<pid>-<ts>` compaction temps (`:829`; 0 present today). The rule is wider on purpose and the divergence is named here so it is auditable; frame identity always comes from `frame.attachmentId`, never from the file name, because a temp file's name carries no authority.

**2. Admission is line-level, not file-level.** The store is **live**: independent passes during review read 1,041 files (1,034 `*.jsonl` + 7 `*.jsonl.quarantine-*` + 0 tmp) and 19,096 / 19,164 / 19,215 admitted frames. Every count in this plan is therefore a **snapshot re-derived at run time and never hard-coded**; the quarantined files hold **254 frames, 247 of which pass `computeFrameChecksum`** and 7 fail. Because the ledger quarantines the **whole partition** on the first bad frame (`:190-202` → `:260-271`), a file-level reader loses 247 valid frames. The 7 failures are **not corruption**: each of the 7 reproduces its recorded checksum iff `null`s inside arrays are treated as `undefined` (controller-verified 7/7, independently reproduced by two reviewers), because `canonicalJsonStringify`'s array branch renders `undefined` as an empty slot via `Array.prototype.join` (`src/shared/control-plane-contracts.ts:510-511` via `:508`) while the appended line emits `null` (`invocation-ledger.ts:802`). **Strict checksum is computed first and alone decides admission**; the `null→undefined` variant is a *diagnostic for a line that has already failed strict*, never a normalization applied before hashing — 5 frames in the live store contain all-null arrays and **pass** strict while **failing** the variant, so normalizing before hashing would lose 5 valid frames.

**3. Identity is composite, and it is validated before use.** `idempotencyKey` is a session-local counter, not a dispatch id. Measured: `idem-mcp-2` spans **92 partitions across 6 tool names**, `idem-mcp-3` **91 partitions / 18 names**, `idem-mcp-5` **82 / 27**; **216** keys span more than one partition; ~16,894 distinct keys vs ~18,878 distinct `(attachmentId, idempotencyKey)` pairs. Deduping on the bare key would collapse 92 distinct dispatches into one row. The composite is the identity; the bare key is a field. **A composite is only formed when both fields are present and non-empty** — naive string concatenation yields the truthy `"undefined\u0000undefined"`, which would collapse every identity-less frame into one row while reporting a clean reconciliation (red-team finding A8).

**4. Three ledger populations plus one proxy population, one panel.** (a) admitted ledger frames, (b) superseded uncompacted frames, (c) named residue (structural-invalid / checksum mismatch / torn tail / unparseable), (d) proxy attempts (`core.*`, separate store, separate unit). The Hub renders **one** panel over (a)-(c) plus an explicitly labelled hole for `core.*` until Phase 5 lands. A repo-native **payload gate** (`scripts/check-mcp-dispatch-payload.mjs`, wired into `npm run compile`) asserts — from source text and a committed fixture only — that the wire payload cannot carry a raw frame, a lease token, an authority snapshot or an absolute path. This replaces the retired panel-separation allowlist: with one panel there is nothing to separate, and the property that still needs a build-time guard is the payload's shape (user decision 2026-09-17; this repo has **no CI** (`.github/` does not exist), so "assertion" means a compile-chain gate, never a workflow file).

**5. Rows are keyed by the recorded dispatch name.** `src/main/mcp/mcp-server.ts:675` rewrites the caller's tool name through `aliasMap` (`:566`) before dispatch, and `invocation-ledger.ts:394` copies that rewritten name into the persisted frame's `name` field (declared `:25`). The caller's typed alias is therefore recorded nowhere — the payload must say so explicitly instead of implying alias-corrected accounting. The identity/`canonicalId` layer from the earlier composite is **cut**, but the row set is **not** alias-free: recorded names include alias-target forms beside their dominant siblings (`antifan_switch_tab` 2 vs `browser.switch-tab` 787; `antifan_set_automation_target` 2 vs `browser.set-automation-target` 771; `browser.eval` 1 vs `anti.browser.evaluate` 9,040) and separator variants exist (`browser.find` 13 / `browser_find` 5). The payload must therefore state that **one capability can occupy several rows** [same-capability grouping is INFERENCE from naming plus count asymmetry; the name list is measured]. No canonicalization layer is built.

**6. Warm path is a memo plus a single pass that hashes what it read.** The reader walks ~230-240 MB. Three independent measurements agree on the pass's order of magnitude: 7.9 s and 11.4 s from two reviewers, and 11.8 s from a real CLI pass over the live 1,044-file store (`filesSkipped 0`, `ceiling null`, `outcome COMPLETE`). Against `PASS_BUDGET_MS = 20_000` that is ~59% of the budget, so budget expiry must be tested with an injected clock or a lowered limit, never by racing machine speed; the earlier design then made it **worse** by hashing every file for the census in a *separate* synchronous pass. That design is retired. The reader now does **one pass per file**: `stat` → read exactly the censused byte length → `sha256` **those bytes** → split → parse → admit. The census is a by-product of the read, not a preceding walk, so `censusHash` describes bytes that were actually consumed, and the "double pass" cost disappears. The pass runs **off the main thread** (`node:worker_threads`, loaded from the compiled electron-free reader module) with a hard budget; on budget exhaustion the payload is `UNMEASURED` with `reasonCode: 'READ_BUDGET_EXCEEDED'` rather than a blocked UI. The main process memoizes the returned envelope on `sha256(sorted(name:size:mtimeMs))` — **`asOf` must not be in the key**: the plan requires two runs to agree "modulo `asOf` and `census.limits.elapsedMs`", so a run-varying key component would mean zero memo hits, leaving the only warm mechanism permanently cold. `asOf` travels in the envelope as the snapshot time of the pass that produced it. The memo mirrors `CoreHealthService.cliCache`/`cliInFlight` (`src/main/diagnostics/core-health.ts:273-274`) with an explicit `clearCache()` (`:370-372`) and a singleton accessor (`:791-795`). No TTL; no rollup file; no byte-offset cursor; no resident-RAM projection.

**7. `core.*` gets its own store, its own unit, and its own consumer.** A non-throwing, bounded emitter in the standalone stdio proxy, labelled by provenance (`omp-proxy`) and unit (`proxy-attempt`, not `logical-dispatch`), taking its target path **only** from the app-injected bootstrap environment; no path ⇒ write nothing and report `proxyTelemetryUnavailable`. `core.*` returns in-process before invocation identity is minted (`scripts/antifan-omp-mcp.cjs:1534-1535` before `:1561`), which is why the ledger has zero `core.*` frames. **A store nothing reads is not telemetry** (red-team finding B9), so the CLI gains a `core-attempts` section over the same store: an emitter with no reader is a write-only artifact, and this phase is cuttable only as a pair.

**8. Scope decisions taken by the user (2026-09-17).** Six decisions, recorded because each one removed or reshaped work: (a) `core.*` emitter is **in scope** as its own phase; (b) this plan is **independent** of `plans/260916-1037-antifan-defect-remediation-master`; (c) the `canonicalJsonStringify` defect is **out of scope** with a documented follow-up; (d) the **self-report panel is deferred** to a follow-up plan; (e) the build gate is **source/type-only** and must never read live stores or block launch; (f) byte-identical determinism is a **CLI property only**, not a Hub acceptance criterion. Decision (g): quarantine frames are a **labelled margin**, not a P1 recovery deliverable.

### Additional locked constraints

**A. The reader takes an injected directory; it never resolves the data root itself.** `StorageLocations.getDataRoot()` is not a pure read: on a cold cache it runs `mkdirSync`, writes a probe file and `unlink`s it (`src/main/config/storage-locations.ts:52-55` — the module lives under `config/`, **not** `session/`; five earlier citations of `src/main/session/storage-locations.ts` were wrong). The Electron main process is safe (directories are initialized at `src/main/index.ts:164` before the ledger is wired at `:322`), but a fresh CLI process is not. The CLI harness therefore accepts `--store` or `ANTIFAN_DATA_ROOT` **only**; it has **no repo-relative fallback** (an earlier revision inherited one from `scripts/lib/build-report.mjs:792-796`, which contradicts this constraint and is wrong on this machine — `E:\Work\apps\AntiFan\.antifan-data` does not exist while the live store is `E:\Work\.antifan-data`) and reports `UNMEASURED` instead of probing.

**B. Checksum reuse seam, and its certification side effect.** `computeFrameChecksum` is module-private (`invocation-ledger.ts:90`; call sites `:198`, `:429`, `:796`, `:834`) while `canonicalJsonStringify` is exported (`control-plane-contracts.ts:506`). The plan extracts the helper into `src/main/session/invocation-frame-checksum.ts` and imports it from both the ledger and the reader; **the byte-ceiling constant `DEFAULT_MAX_INVOCATION_FRAME_BYTES` moves into that seam module and is re-exported by the ledger**, so the reader never value-imports `invocation-ledger` (an earlier revision required both, which is impossible — red-team finding A4). No test breaks (all six ledger-touching test files import only `{ InvocationLedger }`). **Side effect that must be handled, not discovered:** `.compiled/src/main/session/invocation-ledger.js` is one of the eleven inputs to `computeBuildIdentity()` (`scripts/certify-core-freeze.cjs:38-56`, compared `:142`, written `:176`), so extracting the helper invalidates the current core-freeze certification and requires re-certification in the same change.

**C. Latency population.** Exclude `state === 'unknown'` **entirely** (fail-safe), and exclude any frame carrying replay provenance. **Keep** `state === 'interrupted'`: every interrupted frame measured is an owner-written `EXECUTION_TIMEOUT` sample with zero replay provenance. Measured headline p50 13 ms / p95 3,787-3,799 ms over ~18.8 k owner-written samples; the excluded replay population measures p50 262,957 ms / p95 2,427,228 ms and **must be published with its own p50/p95**, not just a count. The `unknown`-without-provenance count (23 of 61 in one independent pass) is **not** independently re-measured by the author and is cited as an order of magnitude, never as a constant.

**D. The wire payload is a projection, and the channel is gated.** The admitted set is the **full** `InvocationRecord[]`, and every frame carries a required `authoritySnapshot` (`invocation-ledger.ts:32`) including `runtimeLeaseToken`, `runtimePid`, `runId`, `attemptId`, `tabId`. **No raw frame crosses IPC.** The payload exposes aggregate fields only (`name`, counts, state mix, `error.code` histogram, latency, windows) plus a `storePath` **display label** — the absolute path stays in the on-disk receipt and the CLI stdout, never in the renderer payload. `evidenceRefs` may contain only synthetic identifiers of the form `census:<hash-prefix>#L<line>`. The IPC handler is gated with `isTrustedSessionVaultSender` (`src/main/browser/local-session-vault.ts:65-89`) and returns a well-formed `UNMEASURED` payload when the sender fails the gate, so the renderer never sees `null`. Rationale: the four "ungated read-only precedent" channels return a public catalogue or health counters; this one returns cross-session operational history, and the toolbar document is the exact origin that gate whitelists — one injected script would otherwise read the operator's entire dispatch history (red-team findings S4/S9). **Keys are strings too, and a key is published.** The projection therefore sanitises object **keys** as well as values, and a histogram key (the state mix, the `error.code` mix) is admitted only if it matches the frozen vocabulary grammar — everything else is bucketed as `UNRECOGNIZED` with its count preserved. The first revision sanitised values only, so a persisted `error.code` reading `C:\Users\Admin\secrets` reached the renderer as an object key while the build gate returned OK on it: the gate walked values and never looked at keys. The predicate that decides "is this string a location" has exactly one definition, `isLocationShaped` in `src/shared/mcp-dispatch-contracts.ts`, imported by both the reader and the projection — two copies of that predicate already diverged once (`storeDisplayLabel`).

**E. Untrusted strings are escaped at the render boundary.** Row fields are not all catalogue-controlled: `frame.name` and `frame.error.code` are persisted values. Every string rendered by the new tab passes `escapeHtml` (`src/renderer/toolbar.ts:1122`) or is assigned via `textContent`; the renderer test seeds markup into a fixture frame's `name`/`error.code` and asserts no element and no attribute is created. This is cheap, it is the house idiom at `:621-630`, and it removes a whole defect class rather than the one instance the reviewers found.

**F. The ledger's own gauge is not a history source.** `getStats()` iterates only `hotPartitions` (`invocation-ledger.ts:736`) and its `quarantinedPartitionCount` comes from an in-memory set (`:105`, `:750`) that is empty after a restart, while a quarantined partition's counts are deleted from `persistedFrameCounts` (`:263`). The suite must never present `getStats().frameCount` as the ledger's frame count.

**G. The pass is bounded in time and never runs on the main thread.** A worker-thread pass with a hard budget, `READ_BUDGET_EXCEEDED` on expiry, and a `POPULATION_TRUNCATED` outcome when the input exceeds a declared ceiling. The reader also yields every 25 files if it is ever run in-process, mirroring the ledger's own boot-replay yield (`invocation-ledger.ts:131-135`). `readAdmittedFrames` materialising the whole `result`-bearing set in the main process is explicitly forbidden. **The two budget outcomes differ on purpose:** a *time* budget expiry discards partial accumulators and renders `UNMEASURED`/`READ_BUDGET_EXCEEDED` (no rows at all — a partially folded in-memory aggregate cannot be trusted), whereas an *input* ceiling renders rows over the files actually read, every row marked `lowerBound: true`, with `totals.truncation = { ceiling, filesRead, filesSkipped, order }` and a label reading "partial: N of M files". Truncation is the same class of incompleteness as a short read, so it is disclosed the same way rather than by blanking the feature; silently reading part of the store, or blanking everything because the store is large, are both failures. **The selection order is part of the disclosure, not an implementation detail:** files are taken **newest-first** (`mtimeMs` descending, `name` ascending as the tie-break), because a name-sorted prefix would zero out every tool whose partitions sort late and would read as "never called". **The shortfall is named in the payload** by ceiling, `filesRead`/`filesSkipped`, the order, the `partial: N of M files` label, and the covered window (oldest and newest `mtimeMs` among files read), so a partial answer is legible as "recent activity, not all history". Enumerating the *individual skipped partition names* is deliberately **not** in the payload — a partition name is a session identity and constraint D admits aggregate fields plus one display label — so that enumeration is a CLI-stdout affordance only, where the absolute path is permitted. Degenerate case: zero files read ⇒ `UNMEASURED`/`POPULATION_TRUNCATED` (there is nothing to render).

## Architecture

```
control-plane-v2/invocations/*.jsonl*        scripts/antifan-omp-mcp.cjs (Phase 5)
        |                                          |
        |  ONE pass per file: stat -> read        |  bounded attempt record
        |  censused bytes -> sha256 -> parse      |  (provenance omp-proxy,
        |  census is a by-product, not a walk     |   unit proxy-attempt)
        v                                          v
  +--------------------------+              +---------------------+
  | worker_threads pass      |              | core-attempts store |
  | (electron-free module)   |              | read by the CLI's   |
  | ADMITTED / structural-   |              | core-attempts       |
  | invalid / CHECKSUM_      |              | section             |
  | MISMATCH / TORN_TAIL /   |              +---------------------+
  | UNPARSEABLE              |                        |
  +--------------------------+                        |
        |  memo: sha256(sorted(name:size:mtimeMs))    |
        v                                             |
  +--------------------------------------+            |
  | aggregate: validated composite       |            |
  | per recorded name: calls, states,    |            |
  | error.code histogram, latency,       |            |
  | firstSeen/lastSeen, lowerBound       |            |
  | TWO reconciliation invariants        |            |
  +--------------------------------------+            |
        |                                             |
        +---------------+-----------------------------+
                        v
        service (main process, envelope + memo)
             |                        \
   IPC handler (gated,          CLI harness (same reader,
   payload projection only)     --store only, proves
             |                   determinism byte-for-byte)
   Hub tab "MCP Dispatch"  (one panel + labelled core.* hole)
```

> **Anchor drift — read every `file:line` here as a position to re-verify, not as an immutable fact.** This plan was authored against the live working tree, which is **not clean**: `src/main/browser/native-tab-host.ts` (+156 lines) and `src/main/bridge/bridge-server.ts` (+20 lines) already carried uncommitted changes from earlier work on terminal-session ownership (`getOwnedTerminalSession`), unrelated to this plan. Those edits shift the cited anchors by a few lines — e.g. `antifan:workflow:get-state` now reads `:2061`, not `:2057`. The seam extraction of Phase 2 shifts the ledger's own anchors too (the compaction temp write is now near `:833` and the rename near `:848`, against the `:843-844` cited here). Every anchor was correct when measured; re-verify before editing, and never "correct" a neighbouring line because a number moved.

## Phases

Renumbered by the 2026-09-17 revision: the retired self-report panel was Phase 5, so the proxy emitter moved 6→5 and the gates moved 7→6. Review reports in `reports/` cite the pre-revision numbers; the mapping is `redteam phase-06 ≡ phase-05-core-proxy-emitter.md` and `redteam phase-07 ≡ phase-06-gates-docs-and-followup.md`.

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Census & Contract Freeze](./phase-01-census-and-contract-freeze.md) | Pending |
| 2 | [Phase 2: Line-Level Reader](./phase-02-line-level-reader.md) | Pending |
| 3 | [Phase 3: Per-Name Aggregate](./phase-03-per-name-aggregate.md) | Pending |
| 4 | [Phase 4: Delivery Surface](./phase-04-delivery-surface.md) | Pending |
| 5 | [Phase 5: core.* Proxy Emitter & Its Reader](./phase-05-core-proxy-emitter.md) | Pending |
| 6 | [Phase 6: Gates, Docs & Follow-Up](./phase-06-gates-docs-and-followup.md) | Pending |

## Success Criteria

- [ ] A Hub tab shows, per recorded dispatch name: call count, terminal state mix, `error.code` histogram, latency p50/p95 — every number traceable to an admitted ledger line.
- [ ] The census partitions the population at run time into four disjoint buckets — `files == jsonl + quarantine + temp + other` — and the per-file identity `frames == admitted + namedInvalid` holds for **every** `FileRollup`, so the quarantine margin is verified per file and not only in aggregate. The two-term form `files == jsonl + quarantine` is stated as its `temp === 0 ∧ other === 0` case and never as the invariant: a `*.jsonl.tmp-*` file being written by a mid-compaction is inside the population by DD1, which makes the two-term form false exactly when the store is busy. The store both grows and shrinks during a read, so **no file or frame count may be hard-coded anywhere** — not in code, tests, or assertions.
- [ ] Reconciliation invariants print and hold **separately**, in their **general** forms: key-level `classifiedKeys + unattributedKeys == compositeKeys`, and frame-level `frames == compositeKeys + superseded + keylessFrames`. A single invariant mixing frame counts with key counts is false by construction whenever `superseded > 0` (independent passes measured 19,096 / 19,164 / 19,215 admitted frames against 18,878 / 18,862 / 18,884 distinct composites). The exact-looking pair `classified + unattributed == compositeKeys` and `frames == composites + superseded` is only valid in the `keylessFrames === 0` case, so it is stated as that special case and never as the invariant; `keylessFrames` is expected to be 0 live and is printed anyway so a non-zero value cannot hide.
- [ ] Latency is computed only from non-excluded frames; the excluded population is reported with **its own p50/p95** (measured: excluded p50 262,957 ms / p95 2,427,228 ms vs headline p50 13 ms / p95 3,787-3,799 ms). `interrupted` frames are **kept**.
- [ ] Empty/unbound data root renders `UNMEASURED`/`NO_DATA` naming the mechanism — never `0`, never a fabricated row; the CLI has no repo-relative fallback. The **absolute** store path is printed by the CLI and recorded in the on-disk receipt; the Hub payload carries only a display label (constraint D), so "the resolved path" is disclosed where it is safe and nowhere else.
- [ ] Every row states its retained window (`firstSeen`/`lastSeen`) and the payload states the retention horizon; when any short-read occurred, rows are marked `lowerBound: true`, and a content change at equal size/mtime renders `UNMEASURED` with no rows (fail closed).
- [ ] A quarantine margin is reported as a **first-class labelled line** (frames present, frames admitted, frames named-invalid, why) — never folded into the admitted total and never presented as a recovery promise.
- [ ] `getState()` returns within its declared budget or returns `UNMEASURED`/`READ_BUDGET_EXCEEDED`; a main-thread pass is impossible by construction (worker thread) and the CLI proves the reader is electron-free.
- [ ] The IPC payload contains **no** raw frame and **no** `runtimeLeaseToken` / `authoritySnapshot` / `requestId` / `paramDigest` / absolute path — **in no value and in no object key**; every histogram key is a vocabulary token or `UNRECOGNIZED`; the handler is sender-gated and returns a well-formed `UNMEASURED` on refusal.
- [ ] Every string rendered by the new tab is escaped; a fixture frame whose `name` and `error.code` contain markup produces no element and no attribute.
- [ ] `scripts/check-mcp-dispatch-payload.mjs` reads **source and a committed fixture only** (never `invocations/`, never `.antifan/telemetry/`), fails on a seeded payload that carries a frame field, and cannot fail a launch for data reasons.
- [ ] `core.*` renders either as measured proxy attempts (Phase 5 landed, `omp-proxy` provenance, `proxy-attempt` unit — and the CLI's `core-attempts` section reads the same store) or as an explicit labelled hole naming the mechanism and every launch path that cannot carry the environment variable.
- [ ] The reader performs zero writes and never calls `InvocationLedger.initialize()`; `capability-transport.ts` settle path is untouched; the extraction's effect on `certify-core-freeze` is re-certified rather than ignored.
- [ ] No new advertised MCP tool exists; `npm run compile` gates stay green.
- [ ] The CLI alone proves determinism: two runs on one frozen copy are byte-identical over every store-derived value — i.e. modulo `asOf` and `census.limits.elapsedMs` (the pass's own wall-clock self-measurement, which can never be deterministic and must be **named**, never silently normalized away). The Hub makes no byte-identity promise.

## Cross-Plan Notes

- `plans/260916-1037-antifan-defect-remediation-master` (status: pending, P1) edits the **same two files** in **different regions**: `src/renderer/toolbar.ts` and `src/main/browser/native-tab-host.ts`. User decision: plans stay **independent**; each phase records the exact line regions it owns, and because this plan's renderer/HTML inserts shift every following line by up to +9, all new anchors are stated as **declaration strings and structural positions**, never as bare line numbers. Verified 2026-09-17: `antifan:workflow:get-state` (`native-tab-host.ts:2057-2070`) already reflects `capabilities.listAll()`, so the master plan's item there is already satisfied.
- `plans/260901-1736-tiered-playwright-parity-and-gap-telemetry-engine` (status: in-progress) owns `.antifan/telemetry/gaps.jsonl` bounding/rotation (10 MB cap, rename to `gaps-<ts>.jsonl`, no cap on rotated count, no pruning). **This plan no longer reads that store** (self-report panel deferred), so the dependency is now only a documented interface for the follow-up plan.
- Earlier MCP/telemetry plans (`260825-2321`, `260831-1800`, `260903-1830`) are `completed`; `260830-1530` is `superseded` — none constrain this plan.

## Advisory Log (kongming, `--advice`)

### Checkpoint 1 — after research & solution design, 2026-09-17
**Verdict: GO, conditional** ("write Phases 1/2/5/6/7; do not let Phase 3 stand as written").
**Routing disclosure:** this host cannot pin the advisory model to a higher tier, so counsel ran on the same model tier as the planner and its claims were verified against live state before being applied.

| # | Advisory finding | Verified? | Disposition | Applied to |
|---|---|---|---|---|
| 1 | Phase 3 keyed rows on `frame.intent.name` / `startedAt`, which the persisted record does not have | VERIFIED — `name` `:25`, `createdAt` `:42`; 0 of 19,215 frames carry either phantom field | Accept | phase-03 (rewritten), DD5 |
| 2 | No reason code for a **shrinking** store (compaction coalesces; prune unlinks; quarantine renames) | VERIFIED — identical file set, lines 20,145 → 19,167 | Accept | phase-01 (`lineCount`), phase-02 (`POST_CENSUS_TRUNCATE`/`VANISHED`) |
| 3 | The reconciliation invariant mixed frame counts with a key count ⇒ false whenever `superseded > 0` | VERIFIED — 19,096 vs 18,884 | Accept | phase-03 (two invariants) |
| 4 | The memo key contained `asOf` ⇒ zero memo hits | VERIFIED by inspection | Accept | phase-04, DD6 |
| 5 | "Canonicalization would change zero rows today" is overstated | VERIFIED — alias-target forms present in recorded names | Accept | DD5, phase-03 |
| 6 | A row's `calls` is a lower bound but is drawn as a count; `0` conflates "compacted away" with "never dispatched" | Accepted as a design gap | Accept | DD6, phase-03 (`lowerBound`, `firstSeen`/`lastSeen`) |
| 7 | The excluded latency population must publish its own p50/p95 | VERIFIED — excluded p95 2,427,228 ms vs headline 3,799 ms | Accept | DD-C, phase-03 |
| 8 | Cut Phase 6 (`core.*` emitter) | — | **Reject** — the user took an explicit scope decision to include it; the phase stays cuttable | phase-05 |
| 9 | `core.*` attempts include unknown-capability/abandoned calls; coverage is per-process ⇒ day-one 0 ≠ unused | Accepted | Accept | phase-05 (`attemptKind`, `instrumentedSince`) |

## Red Team Review

Four hostile lenses ran against this plan (security adversary + fact checker; failure-mode analyst + flow tracer; assumption destroyer + scope auditor; scope critic + contract verifier). They filed **40 findings**; the counts they cite are from independent re-derivation, and three of them reproduced every headline measurement in this plan exactly (254/247/7 quarantine split, the 5 strict-valid-variant-invalid frames, 51 `core.*`, 405/2 self-report records, `browser.dom` 189). Reports: `reports/redteam-security.md`, `reports/redteam-failure-modes.md`, `reports/redteam-assumptions.md`, `reports/redteam-scope-contracts.md`.

Adjudication rule applied: a finding needed a `file:line` I could re-read; claims that were scope *questions* rather than defects were escalated to the user, not silently cut.

| # | Finding (deduped; filing lenses) | Verified by author | Disposition | Applied to |
|---|---|---|---|---|
| 1 | Phase 3 read two fields no frame carries (`intent`, `startedAt`) ⇒ empty rows + NaN latency while reconciliation still passed (S·F·A) | VERIFIED — `:25`/`:42`; 0 of 19,215 | Accept | phase-03 rewritten |
| 2 | The reconciliation invariant was false by construction on the live store (F·A) | VERIFIED — 19,096 vs 18,884 | Accept | phase-03 (two invariants) |
| 3 | The `core.*` emitter recorded `outcome:'ok'` for every failure: `finally` fires before the un-awaited async `invokeCore` settles (S·F·A) | VERIFIED — `invokeCore` async `:522`, returned `:1535` | Accept | phase-05 (promise-aware emit + forced-rejection test) |
| 4 | The pass hashed ~230 MB twice, synchronously, on the Electron main thread, with no yield point; the memo could never hit (F·A) | VERIFIED — `readFileSync` in census + reader; ledger yields `:131-135` and the reader did not | Accept | DD6 + DD-G + constraints; phase-01/02/04 redesigned (single pass, worker thread, budget) |
| 5 | The compile-chain gate sat on the launch path, read live stores, and passed vacuously (`null === null`) on a clean machine (S·A) | VERIFIED — `main.cjs:42-53`, `check-mcp-budget-dominance.mjs` reads no runtime data | Accept | phase-06: source/type-only payload gate; live checks moved to acceptance |
| 6 | The build gate's ordering could leave fresh `toolbar.js` beside a stale `toolbar.html`, silently losing the new tab (F) | VERIFIED — gate sat before `copy-static` | Accept | phase-06 (ordering + source-only inputs make this unreachable) |
| 7 | Panel B: unrequested scope, XSS from MCP-written text into the trusted toolbar origin, root rule that cannot reach its own store, writer/CWD contradiction, rotation double-count (S·F·A·C) | VERIFIED — `sanitizeString` strips only newlines `:95-101`; `innerHTML` idiom `:621`; gate origin `:78-80`; resolver excludes `dataRoot` `:266`; writer default is `process.cwd()` `:122`/`:128` | Accept **by deferral** (user decision) | Non-Goals + Follow-Ups; phase-05(old) removed |
| 8 | `src/main/session/storage-locations.ts` does not exist — cited five times for the P0 zero-write invariant (S·F·A·C) | VERIFIED — only `src/main/config/storage-locations.ts` exists | Accept | constraint A, phase-01 |
| 9 | `docs/operations.md:143-145` was cited for a telemetry guarantee it does not make (Theme-QA reports only) (S·F) | VERIFIED | Accept | citation removed with Panel B |
| 10 | The reader's residue enum had no class for the ledger's own structural rejections ⇒ a checksum-valid `formatVersion: 2` frame counted as a real dispatch (A) | VERIFIED — ledger rejects at `:188` | Accept | phase-02 (`STRUCTURAL_INVALID`, evaluated **before** checksum) |
| 11 | `POST_CENSUS_APPEND` was classified after `ADMITTED` and is unobservable from a bounded read (F) | VERIFIED by inspection of the ordering | Accept | phase-02 (boundary test first, running byte offset) |
| 12 | `CENSUS_DRIFT` was unreachable while the real hazard — compaction's `writeFile`+`rename` swapping a partition mid-read — was unguarded (F) | VERIFIED — `:843-844`; 222 `in_progress` frames are live compaction triggers | Accept | phase-01/02/03 (hash-what-you-read; post-read `stat` re-check; drift test) |
| 13 | Composite identity was raw concatenation ⇒ `unattributed` could never fire (A) | VERIFIED — truthy `"undefined\u0000undefined"` | Accept | phase-02 (validated composite), phase-03 |
| 14 | `oversizeLine` needed a value import of `invocation-ledger` that the same phase forbade (A·F) | VERIFIED — constant exported only at `:13` | Accept | constraint B (constant moves into the seam module) |
| 15 | The CLI's repo-relative fallback contradicted the P0 rule and is wrong on this machine (A·F) | VERIFIED — `<repo>\.antifan-data` absent | Accept | constraint A, phase-04 |
| 16 | `openWorkflowHub()` was omitted from the edits (stale rows on reopen); the HTML anchor was off by one and would land the button outside `.hub-nav-strip`; the stated wrong-branch symptom was inverted (C·F) | VERIFIED — `:488-515`; `:503` is `</button>`, `:504` closes the strip | Accept | phase-04 (10th edit, structural anchor, corrected symptom, `try/catch` mirroring `:517-531`) |
| 17 | The e2e probe was misdescribed as a partial-bridge stub; it loads the real preload and registers 7 real handlers, is in no lane, and never clicks the new tab (C·F) | VERIFIED — `:41-138`, `:145`, `:250`/`:273`, `package.json:45` | Accept | phase-04 (risk restated; rejection hazard covered by the mandated `try/catch`) |
| 18 | The `plans/bottlenecks.json` row was not expressible in the registry's grammar, and `plans:check` only validates frontmatter (S·F) | VERIFIED — 10 predicate kinds, no behavioural one | Accept | phase-06 (`file-regex`/`manual`; `plans:check` restated) |
| 19 | Phase 5(proxy) wrote a store nothing read; no bound on record size; rotation capped bytes but not file count; `statSync` on the hot path; the "Codex is the only hole" claim was incomplete (F·A) | VERIFIED — no reader defined; `bin` `:12` and `npm run mcp` `:17` never receive the variable | Accept | phase-05 (CLI `core-attempts` section, size bound, retained-file ring, no sync stat, launch-path enumeration) |
| 20 | The frozen-copy determinism proof exercises none of the live-store races it was written for (F) | VERIFIED by construction | Accept | phase-04/06 (determinism demoted to CLI; live mid-read append + compaction become acceptance rows) |
| 21 | `242 registered capabilities` and `23 unknown-state frames without provenance` were not derivable read-only (S·A) | VERIFIED as unverifiable (185 static register sites / 121 proxy definitions) | Accept | both claims downgraded to method-named approximations |

Not accepted, with reasons: the reviewers' three "do not re-derive" refutations were themselves accepted (composite identity is sound; `superseded` is genuine transitions, not compaction pollution; `frame.attachmentId` agrees with `authoritySnapshot.attachmentId` on 100% of frames), and kongming's later recommendation to cut the `core.*` phase remains rejected on the standing user decision.

## Open Questions

None blocking. Seven scope decisions were taken by the user on 2026-09-17 (see Design Decision 8); the three questions the reviewers raised against the *requested* surface — determinism, the quarantine margin, and the gate's form — were put to the user and answered (CLI-only, labelled margin, source-only gate).

## Follow-Ups Out of Scope

1. **Agent self-report panel (deferred Phase 5).** Deliver it as its own plan with these corrections baked in, each of which was verified against the live tree: (a) the writer's effective root is `process.cwd()` when the resolver returns `''`, so candidate roots must be an **enumerated set** (registry `rootPath`; the env trio; the data root as the CWD-collapse candidate; the launching CWD) rather than a mirror of a resolver that excludes the very root that holds the 2-record store; (b) every rendered string passes `escapeHtml`/`textContent` — the records are written from MCP parameters and `sanitizeString` (`fallback-recorder.ts:95-101`) strips only newlines and length; (c) rotation must be deduped by an explicit ordering key (`fallback-recorder.ts:22`, `:143-149`); (d) the panel must not claim a PII guarantee — `docs/operations.md:143-145` scopes redaction to Theme QA reports, and the recorder's denylist is 10 exact query-key names, so `targetUrl` host-only projection is required before display.
2. **`canonicalJsonStringify` array-slot defect** — `src/shared/control-plane-contracts.ts:510-511` renders `undefined` array elements as empty slots while persistence emits `null`, which makes any frame containing such a value permanently unverifiable and causes whole-partition quarantine (`invocation-ledger.ts:190-202`). 7 frames today, 247 valid frames collateral. The same helper backs `canonicalDigest` (policy and param digests), so the fix needs its own plan and its own blast-radius analysis.
3. **Caller-facing alias capture** — recording the typed alias would require a change on the dispatch path (`ClientInvocationIntent` / frame schema) and would have no retroactive coverage.
4. **Retention ownership** — quarantine files are never replayed or pruned and live partitions are append-only, so the store grows monotonically (~230 MiB today, largest single partition 136 MiB). This plan reports the horizon and refuses to change retention; a plan that owns retention should bound the input the reader is allowed to see.

## Risks

| Risk | Signal it broke | Pre-decided response |
|------|-----------------|----------------------|
| The store is live and grows during a read | counts differ between two runs of the same command | `asOf` + the single-pass census hash make drift explicit; never claim a stable total |
| The store **shrinks** mid-read (compaction coalesces frames; prune unlinks; quarantine renames) | parsed bytes/lines < censused bytes/lines while named residue is 0 — measured live: identical file set, 20,145 → 19,167 lines | classify `POST_CENSUS_TRUNCATE` / `VANISHED`; mark rows `lowerBound: true` |
| Compaction replaces a partition between the read and the census report | census hash describes bytes never read; 0 torn tails, 0 mismatches | hash **what was read**; re-`stat` after the read and re-hash on change; `CENSUS_DRIFT` ⇒ `UNMEASURED`, no rows |
| A torn final line is misread as corruption | `TORN_TAIL` > 0 in a recently-written partition | classify separately from `CHECKSUM_MISMATCH`; never quarantine on read |
| A checksum-valid frame with a future `formatVersion` enters the row set | structural rejections present but the row set still grows | `STRUCTURAL_INVALID` is evaluated **before** checksum; unknown versions are named, never admitted |
| A new checksum-bad frame shape appears | named-residue count changes | classify by name; never assume the count or the shape |
| `canonicalJsonStringify` is "fixed" while this plan ships | admitted frames jump (247 → more) | acceptance values are re-derived at run time; no hard-coded frame counts |
| The 230 MiB pass blocks the main process | every IPC handler and the ledger append path stall during a Hub refresh | worker thread + hard budget + `READ_BUDGET_EXCEEDED`; in-process fallback yields every 25 files |
| Proxy emitter runs without the injected env, or its store is never read | `proxyTelemetryUnavailable`, or a populated directory with no surface | write nothing, no plausible-path fallback; the CLI `core-attempts` section is the reader, and the phase is cuttable only as a pair |
| A rogue MCP client floods the proxy store | sustained `core-attempts` growth with pathological record sizes | bound `method`/`requestedAs`/`errorCode`, refuse an over-budget record, retain a bounded ring of rotated files |
| Memo serves stale data | Hub counts lag a live call | memo key covers the whole file set's size/mtime; `asOf` is displayed and is the snapshot the payload describes |
| The reader imports `electron` | CLI harness dies on `require('electron')` | reader module stays electron-free; Phase 2 proves importability from plain Node before Phase 4 builds on it |
| The reader's extraction silently invalidates core-freeze certification | `certify:core-freeze` reports a build-identity mismatch | re-certify in the same change; the compiled ledger is a named identity input |

<!-- slug: mcp-dispatch-accounting -->
