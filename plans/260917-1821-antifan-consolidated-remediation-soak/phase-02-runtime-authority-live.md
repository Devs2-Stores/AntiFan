---
title: "Phase 2: Runtime Authority & Session Lifecycle"
status: todo
---

# Phase 2: Runtime Authority & Session Lifecycle

## Overview

Make an attachment's authority **runtime-scoped**, so an attachment minted by a
process that no longer exists is honestly dead instead of permanently and
silently wedged.

Measured live (2026-09-18, `attachments-v1.jsonl`):

| Observation | Value |
|---|---|
| Persisted frames | 2,585 |
| `state: 'active'` | 2,562 |
| …of those, carrying a runtimeId ≠ the running process's `binding-ba0b1ab0-092f-4cc8-8dcf-85dac5953137` | **2,444** |
| Latest active expiry | 2027-11-28 (slid forward by renewals that never check identity) |
| `RUNTIME_MISMATCH` frames in the invocation ledger | **2,444** |
| `RUNTIME_MISMATCH` in the four app logs | 0 |

Mechanism (grounded in code, confirmed by probe):

1. The runtime id is minted **per process** — `issueRuntimeLease`
   (`control-plane-runtime.ts:166`) → `binding-<uuid>` — and dispatch compares it
   against the lease in the request context (`capability-catalogue.ts:380` and
   `:462`), throwing `RUNTIME_MISMATCH`.
2. `AttachmentRegistry.initialize()` replays every persisted frame **without any
   runtime-identity check** (`attachment-registry.ts:112-215`), so a record
   carrying a previous process's runtimeId is restored as `active`.
3. `renewAttachment()` (`attachment-registry.ts:937`) verifies the secret, the
   host epoch, the attempt state and the backend lineage — **never the runtime
   id** — and slides `expiresAt` forward. A dead attachment is therefore
   renewable forever and its file frame is never pruned (`compactAttachmentsUnlocked`
   only drops records that are not `active`).

Net effect: the client holds an attachment that authenticates, renews, and rejects
every dispatch with `RUNTIME_MISMATCH`; its own repair path (`tryReuseLiveAttachment`
→ `antifan.cli.renewSession`, `antifan-omp-mcp.cjs:1683-1733`) succeeds, so it never
re-pairs. That is the live state of every MCP session on this host.

**Probe that separates "dead control plane" from "dead attachment" (run, passed):**
a fresh pairing (`/api/pairing/challenge` → `/api/pairing/exchange`, `clientClass: 'mcp'`)
dispatches `anti.browser.tabs.list` and `anti.verification.list` successfully
(`totalCount: 1000`, equal to the 1,000 on-disk records). The control plane is
serving; only restored attachments are wedged.

**Second defect, proven by the same probe:** on that *fresh* attachment,
`antifan.cli.renewSession` answers
`{"success":false,"error":"Backend mismatch: expected mcp, got none"}`.
`getBackendId(attemptId)` returns `undefined` for the run/attempt pair the bridge
mints at pairing time without registering it in `RunService`
(`bridge-server.ts:1003-1016`), and `renewAttachment` reads that as a lineage
violation — while the `getAttemptState` check fifteen lines above it explicitly
documents `undefined` as "this registry does not track that attempt, not that the
attempt is dead", for exactly these attachments. So the only liveness proof a
client has for reusing a live attachment always fails, and every recovery burns a
pairing code (the pairing-queue depletion the transport comments describe).

Restart interaction: a restart mints a new runtimeId, so **every** prior
attachment becomes foreign at once. Today that widens the wedge to the whole
fleet; after this phase those records are dropped at replay and clients re-pair
through the already-implemented 4001 path
(`the bridge closes 4001 for an attachment that is not active and unexpired`,
`antifan-omp-mcp.cjs:1679-1680`).

**Second half — session-lifecycle hooks (handoff step 8, currently unimplemented).**
The same wedge has a client-side boundary. The running OMP bridge hook binds five
events today — `session_start`, `before_agent_start`, `context`,
`session.compacting`, `tool_call` (`.omp/hooks/pre/antifan-core-bridge.ts`) — and
leaves `agent_end` / `turn_end` / `session_shutdown` unbound, so a session's end
never releases or re-pairs the attachment it minted: the next session inherits
whatever the previous one left. The binding must go into the existing, running
hook — the handoff forbids building a second bridge (it already does task-hash
dedupe and spawns the Core CLI), and `CLAUDE-PARITY.md:11` records that a
spawn-per-event hook was removed once for 30-second timeouts; do not reintroduce a
process per event.

## Requirements

- **R1** Replay is runtime-scoped: `initialize(currentRuntimeId?)` restores a
  record only when its lease carries no runtimeId (legacy frame) or the current
  one. A record bound to a foreign runtime is **not** restored, because no
  dispatch against it can ever succeed.
- **R2** `renewAttachment()` treats an unknown backend lineage the way it already
  treats an unknown attempt state: `undefined` from `getBackendId` means "not
  tracked by this registry", not "the backend changed". A *reported* mismatch
  still throws `LINEAGE_MISMATCH`.
- **R3** No authority is weakened: the dispatch-time lease check stays exactly as
  it is, and `RUNTIME_MISMATCH` must still be logged truthfully for any bad id
  that reaches it. This phase removes the *silently immortal* attachments, not
  the check that refuses them.
- **R4** The registry file self-heals through existing machinery: dropping frames
  at replay makes `records.size` smaller than the line count, which trips the
  existing compaction trigger (`initialize()` tail) and rewrites the file from
  live records only. No new retention policy is invented.
- **R5** Backward compatible: `initialize()` without an argument keeps today's
  behavior, so existing tests and any embedded caller are unaffected.
- **R6** A fresh pair-minted attachment renews successfully on the live app
  (currently fails), and a stale attachment connects the client to the re-pair
  path instead of `RUNTIME_MISMATCH`.
- **R7** Bind exactly `agent_end`, `turn_end`, `session_shutdown` in the
  **existing, running** hook `.omp/hooks/pre/antifan-core-bridge.ts` (it already
  binds `session_start`, `before_agent_start`, `context`, `session.compacting`,
  `tool_call`). No second hook file, no new bridge.
- **R8** The binding reuses the hook's existing machinery (task-hash dedupe + one
  `scripts/antifan-core.cjs` spawn per event payload): no process per event, and
  no emission on a re-entered or already-seen turn — `CLAUDE-PARITY.md:11` records
  a spawn-per-event hook removed after 30-second timeouts; do not reintroduce it.
- **R9** Evidence and fail-open: after one completed turn,
  `.canary/core-bridge/events.jsonl` gains exactly **one** row per newly bound
  event and **zero** duplicates on re-entry; a Core failure still fails open (the
  session continues, exactly one `BRIDGE_CONTEXT_FAILED` per session).

## Design decisions

1. **Scope at replay, not at every read.** Replay is the only door a foreign
   runtimeId can enter memory through (minting always stamps the current runtime —
   `issueAttachment` forces `lease.runtimeId = this.leaseState.runtimeId` for
   every workspace, `control-plane-runtime.ts:476-484`). One check at the single
   entry point keeps the invariant structural instead of repeating it at renew,
   dispatch, and authenticate.
2. **Drop, do not mark expired.** A non-`active` record with an expiry in 2027 is
   still retained by `compactAttachmentsUnlocked` (24h past `expiresAt`), so
   marking would keep 2,444 dead frames in the file. Dropping lets the existing
   compaction trigger remove them, which is also the only measurable file-size
   improvement available without a new policy.
3. **Pass the runtime id in, do not add a delegate getter.** `initialize()` is
   called once from `ControlPlaneRuntime.initialize()`, which owns `leaseState`;
   a parameter is smaller than a new optional delegate member plus `RunService`
   constructor churn (that constructor already takes ten positional arguments).
4. **Tolerate `undefined` lineage exactly where the sibling check already does.**
   The `getBackendId` fix mirrors the reasoning written above `getAttemptState`
   in the same function; the strict validation path used by run-owned attachments
   is left untouched.

## Related code files

- Modify: `src/main/run/attachment-registry.ts` — `initialize()` `:112-215`
  (replay loop), `renewAttachment()` `:937-1046` (the `getBackendId` branch
  `:990-995`).
- Modify: `src/main/control-plane/control-plane-runtime.ts` — `initialize()`
  `:226-231` (`await this.runs.attachments.initialize()`).
- Create: `test/main/attachment-runtime-scoping.test.ts`.
- Modify: `.omp/hooks/pre/antifan-core-bridge.ts` — event surface
  (`session_start` `:656`, `before_agent_start` `:669`, `context` `:751`,
  `session.compacting` `:779`, `tool_call` `:800`); add `agent_end`, `turn_end`,
  `session_shutdown`.
- Evidence: `.canary/core-bridge/events.jsonl` (one row per bridge event; override
  `ANTIFAN_CORE_BRIDGE_LOG`, `off` disables the file channel).
- Not touched: `capability-catalogue.ts` (its lease check is the authority this
  phase makes unreachable-but-truthful), `bridge-server.ts` (pairing already
  stamps the current lease).
- Region ownership: this plan owns both files until phase 2 is verified.

## Implementation steps

1. `initialize(currentRuntimeId?: string)`: inside the replay loop, before
   `this.records.set(rec.id, rec)`, skip a record whose
   `rec.lease?.runtimeId` is set and differs from `currentRuntimeId`; count them
   and emit one warning line naming the count and both ids.
2. `ControlPlaneRuntime.initialize()`: pass `this.leaseState.runtimeId`.
3. `renewAttachment()`: replace `if (!backendId || backendId !== record.backendId)`
   with `if (backendId !== undefined && backendId !== record.backendId)`, with the
   reasoning in a comment; keep the thrown code.
4. Test on a temp data root: a registry that persists a same-runtime and a
   foreign-runtime attachment, then re-initializes with the current runtime id,
   keeps exactly one and refuses the other; re-initializing without an argument
   keeps both (R5). A pair-minted attachment (`backendId: 'mcp'`, attempt unknown
   to the delegate) renews and its `expiresAt` advances; an attachment whose
   backend is *reported* as different still throws `LINEAGE_MISMATCH`.
5. Live acceptance: the fresh-pairing probe's `renewSession` returns `success:true`;
   the restart (user decision C) then re-probes `anti.verification.list`
   (`totalCount` equal to the on-disk count), the replayed registry contains only
   current-runtime records, and the next session logs **0** `RUNTIME_MISMATCH`
   frames.
6. Hook binding: add the three lifecycle handlers to the existing
   `.omp/hooks/pre/antifan-core-bridge.ts` event surface, reusing the file's
   existing dedupe + spawn path and appending the same evidence row shape it
   already writes (`pi.appendEntry('antifan-core-bridge', …)` + one JSONL line).
7. Hook probe: after one completed turn, `.canary/core-bridge/events.jsonl` gained
   exactly one row per newly bound event, and a re-entered turn added **zero**
   duplicates; a Core-unavailable run still emits one `BRIDGE_CONTEXT_FAILED` and
   the session continues.

## Todo

- [ ] Replay skips foreign-runtime records and reports the count
- [ ] `ControlPlaneRuntime.initialize()` passes its runtime id
- [ ] `renewAttachment` tolerates unknown backend lineage
- [ ] Unit test: replay scoping, legacy no-argument behavior, renew lineage
- [ ] Live: `renewSession` succeeds on a fresh pair-minted attachment
- [ ] Live after restart: registry holds only current-runtime records; file compacted; 0 `RUNTIME_MISMATCH`

## Success criteria

- [ ] A record restored by `initialize(currentRuntimeId)` always carries the
      current runtime id; foreign-runtime frames are absent from `records` and are
      physically removed by the existing compaction trigger.
- [ ] `renewAttachment` succeeds for a pair-minted attachment and still throws
      `LINEAGE_MISMATCH` when the delegate reports a different backend.
- [ ] `initialize()` with no argument behaves exactly as before.
- [ ] `npm run compile` and the unit suite pass with **no test widened**.
- [ ] On the next live session, `RUNTIME_MISMATCH` frames are **0** while the
      catalogue's lease check remains in place.

## Risks / rollback

| Risk | Mitigation |
|---|---|
| Dropping frames at replay removes records some caller still authenticates with. | The only callers are live clients, and a foreign-runtimeId attachment cannot dispatch at all — it is already dead; the drop converts a silent wedge into the 4001 re-pair path the client already implements. |
| `initialize()` without the new argument is used in production. | It is not: the sole production call site is updated in the same change; the default keeps tests and embedded callers green. |
| Tolerating an unknown backend lineage lets a removed backend keep renewing. | The tolerance covers only `undefined` (registry does not track the attempt). A backend that differs from the recorded one still throws, and the run-owned validation path is unchanged. |
| Rollback | Revert the two files. Frames dropped by a boot are still present in the previous file copy only until compaction; the registry is authority state, not an audit log, and the invocation ledger retains the execution history. |
