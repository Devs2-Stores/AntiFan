---
title: "Phase 1: Register & Durability Truth"
status: todo
---

# Phase 1: Register & Durability Truth

## Overview

Make `verification-register.jsonl` the single source of truth and make its write
path fail-closed.

Measured today (`T1`, reproduced twice): `anti.verification.list()` returns
`{"totalCount":0,"verifications":[]}` while
`E:\Work\.antifan-data\issues\verification-register.jsonl` holds 1,000 valid
records / 1,831,100 B. Both the read and the write go through one in-process
array (`issue-register.ts:291`) loaded **once** in the constructor
(`:329-343`). The writer (`:945-958`) rewrites that array **wholesale** through
temp + `renameSync` with no empty guard, so the next
`record_claim` / `verify_claim` / `update_verdict` call from a process holding an
empty array replaces 1,000 verdicts with an empty file, atomically.

This phase is first in the plan because it is **irreversible × a precondition**:
every other phase is accepted through this subsystem.

### Root cause of the live `totalCount: 0` (2026-09-18, measured after the
### durability work landed — corrects this phase's opening diagnosis)

The zero is **not** produced by this subsystem. Live on app pid 43168 (bridge
`127.0.0.1:20130`, runtime in the ledger's authority snapshot):

| Call | Result |
|---|---|
| `anti.verification.list {}` | `{"totalCount":0,"verifications":[]}` |
| `anti.verification.list {"tabId":"tab-e2e-1"}` | real register records |
| records in `scope.tabId = tab-e2e-1` (on disk) | 324 |
| records in `scope.tabId = <live bound tab 9c5d2bd9-…>` | **0** |

In-process, the same compiled module reads `E:\Work\.antifan-data` and
`listVerifications({})` returns **1001** records, so the file-backed read is
healthy. The surface fabricates the filter: `scripts/antifan-omp-mcp.cjs`
`invoke()` injects an ambient `tabId` into every call that omits one
(`resolveBoundTabId` at `:171-179`, injection at `:2243`), and for
`anti.verification.list` `tabId` is a **record filter**
(`issue-register.ts:1014-1027`, `v.scope.tabId === options.tabId`). An unscoped
list therefore arrives pre-filtered to a tab with no records and answers an
empty page — R2 is satisfied by the subsystem and defeated by the transport.

Fix ownership: **phase 6** (surface/args transport), requirement R6 below.
Acceptance for this phase's `anti.verification.list` probe must be re-run
**after** the surface fix, from a fresh proxy process (the running OMP session
holds the old injection code).

## Requirements

- **R1** Reads answer from the file, not from a per-process array. A missing file
  is an empty register; a file that cannot be read is an **error**, never an
  empty register. Unparseable lines are skipped, counted, and warned — never
  silently dropped.
- **R2** `listVerifications()` returns every record on disk (filters and `limit`
  unchanged), so `totalCount` equals the parsed on-disk record count.
- **R3** `getVerification()` finds records the file knows, not only records this
  process wrote.
- **R4** Every mutation (`updateVerificationStalemate`, `updateVerificationVerdict`,
  the `claimId` link in `record`, `linkVerification`) mutates a **fresh** disk
  read and persists the full set, so a mutation can never be applied to, or
  written from, a stale view.
- **R5** Every rewrite **reconciles with a fresh disk read, merging by `id`**.
  The write is monotone: a record already on disk cannot be dropped.
- **R6** A rewrite is **refused** with the typed `DURABILITY_FAILED` error when
  the caller's set is empty while the file is non-empty, or when the merged set
  would shrink the register. On refusal the file is byte-identical.
- **R7** A failed append must not be reported as success: `recordVerification`
  throws `DURABILITY_FAILED` instead of warning and returning a record that was
  never persisted.
- **R8** The silent 1,000-record RAM cap stops being a write source. The file is
  the retention owner; the in-memory set is a stat-keyed cache only.
- **R9** Proof runs on a **temp fixture only**. The live register is never used as
  a test subject, and no probe that writes a record may run before R4–R6 land.

## Design decisions

1. **File-authoritative with a stat-keyed cache, not "reload on mtime" alone.**
   A pure mtime reload still answers from RAM, so a read that happens before any
   reload can still lie; and the writer would still have a RAM-derived input. The
   cache is `{ size, mtimeMs } → parsed records` and is only ever a read
   optimization — it is cleared on every write and never passed to the writer.
2. **Merge by `id` inside the writer, not in each caller.** The reconciliation is
   the invariant; putting it in one place makes "cannot shrink the register"
   structural instead of a discipline every call site must remember.
3. **Refuse rather than repair a caller-passed empty set.** Merging would silently
   rescue the empty-array case, which hides the defect. Fail-closed surfaces it as
   a typed error and leaves the bytes untouched.
4. **Disk order first, caller's copy wins per id.** The caller's copy carries the
   mutation; everything else in the file survives. Output order stays stable
   across rewrites, so a rewrite of an unchanged set is byte-identical.
5. **The 1,000-record splice is deleted, not relocated.** It bounded memory, but
   with a disk-authoritative writer any RAM cap becomes a future loss vector the
   moment the file passes 1,000 records (it is at exactly 1,000 today). Retention
   is the file's business and no retention policy is invented here.
6. **`recordVerification` throws on a failed append.** It previously warned and
   returned the record, so a caller could believe an unpersisted claim existed.

## Related code files

- Modify: `src/main/session/issue-register.ts` — field `:291`; loader `:329-343`;
  `record()` claim link `:404`; `linkVerification` `:700-740`; `recordVerification`
  `:819-832`; `listVerifications` `:843`; `getVerification` `:863-865`;
  `updateVerificationStalemate` `:872`; `updateVerificationVerdict` `:902`;
  `rewriteVerificationsFile` `:945-958`. Line numbers are navigation aids only —
  every edit is anchored on a declaration string.
- Create: `test/unit/verification-register-durability.test.ts`.
- Not touched: `src/main/tools/browser-capabilities.ts` (only call sites change
  behavior), `src/main/verification/circuit-breaker.ts`.
- Region ownership: this plan owns `issue-register.ts` until phase 1 is verified;
  `plans/260916-1037-antifan-defect-remediation-master` phase 4 also edits this
  file and is blocked on this phase for exactly that reason.

## Implementation steps

1. Replace the array field with the stat-keyed cache; add
   `verificationsFileKey()`, `verificationsFileBytes()`,
   `readVerificationsFromDisk(force)`, and `readVerificationsForMutation()`.
2. Rewrite `loadInitialVerifications()` to warm the cache through
   `readVerificationsFromDisk()` and to keep working (with a warning) when the
   file is unreadable at boot.
3. Add module helpers `durabilityFailure()`, `registerReadFailure()`,
   `mergeVerificationsById()`.
4. Point `listVerifications()` and `getVerification()` at the file.
5. Point the two in-place claim-link mutations (`record()` at the `claimId`
   branch, `linkVerification()`) at a fresh read and persist the result; keep
   `linkVerification`'s non-fatal persistence by logging instead of swallowing.
6. Point `updateVerificationStalemate()` and `updateVerificationVerdict()` at a
   fresh read and pass that set to the writer.
7. Rewrite `rewriteVerificationsFile(records)` with the empty guard, the merge,
   the shrink assertion, `mkdir -p`, and the typed `DURABILITY_FAILED` throw.
8. Remove the 1,000-record splice; throw on append failure.
9. Write `test/unit/verification-register-durability.test.ts` (temp
   `ANTIFAN_DATA_ROOT`, existing suite convention) proving: disk count ==
   `listVerifications().length` after a simulated second process appends;
   an empty in-memory set is refused and leaves the file byte-identical; a shrink
   attempt is refused; a mutation survives a re-read from a fresh singleton; an
   unreadable file raises instead of returning zero.
10. Live acceptance on the real register, in this order: (a) `anti.verification.list`
    → `totalCount ≥ 1000` equal to the parsed on-disk count; (b) record the file's
    byte length before/after the call and require it unchanged; (c) only then
    restart the app (user decision C) and repeat (a).

## Todo

- [ ] Stat-keyed disk reader + cache, no write source
- [ ] `listVerifications` / `getVerification` read from the file
- [ ] Four mutation paths read fresh and persist the full set
- [ ] Writer merges by `id` and asserts monotonicity
- [ ] Empty-overwrite refused with `DURABILITY_FAILED`, bytes untouched
- [ ] Append failure raises instead of warning
- [ ] 1,000-record splice removed
- [ ] Durability unit test on temp fixture
- [ ] Live `totalCount ≥ 1000` + byte length unchanged
- [ ] App restart, then re-probe `totalCount`

## Success criteria

- [ ] `anti.verification.list()` returns `totalCount` **equal to the parsed
      on-disk record count** (≥ 1000), with `limit` still honored.
- [ ] The register file's byte length is **unchanged** by a `list` call and never
      shrinks across the phase's probes.
- [ ] Empty-set overwrite of a non-empty register throws `DURABILITY_FAILED` and
      leaves the file byte-identical (proven on a temp fixture).
- [ ] A mutation applied by one process is visible to a fresh `listVerifications`
      from another process/singleton.
- [ ] `npm run typecheck` and the existing unit suite pass with **no test widened**.
- [ ] After the restart, `anti.verification.list()` still reports the full count
      (the restart is what proves the read path is file-backed, not a
      coincidence of one process's memory).

## Risks / rollback

| Risk | Mitigation |
|---|---|
| A disk-authoritative read turns a previously silent empty answer into a tool error. | That is the intent: an unreadable register must not be reported as "0 records". The error names the path. |
| Tests that relied on in-memory-only behavior now fail. | Failures are the finding, not the obstacle: fix the call path, never the assertion. |
| `recordVerification` throwing on append failure changes caller behavior. | Callers are MCP tools; an error surfaces instead of a false `recorded` claim. |
| Rollback | Revert the single file. The backup `verification-register.jsonl.bak-260918-guard-pending` (1,831,100 B / 1,000 lines, byte-identical) is the safety net for the live store. |
