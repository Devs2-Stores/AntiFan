---
phase: 5
title: "Preserve Desktop Delivery State and Immutable Ownership"
status: completed
priority: P0
effort: "1-1.5 days"
dependencies: [2, 4]
---

# Phase 5: Preserve Desktop Delivery State and Immutable Ownership

## Context Links

- [Plan](./plan.md)
- Review findings H6-H9 in
  [deep review](../reports/260820-0851-antifan-antigravity-deep-code-review.md)

## Overview

Make Desktop own durable delivery overlays, immutable queue targets, exact
workspace binding, and copied-byte attachment evidence. Transcript refresh may
update observed chat content but cannot erase or invent delivery truth.

## Requirements

- Store authoritative conversation mapping from Phase 3; never assign
  transcript session ID directly unless the proven mapping says they are equal.
- Require an explicit existing target workspace for every mutating command and
  artifact. Remove `E:\Work` and `process.cwd()` mutation fallbacks.
- Freeze workspace, conversation, requested route, prompt digest, attachment-set
  digest, and issued/deadline timestamps at enqueue time.
- On restart, do not dispatch a queue item until host liveness, target mapping,
  busy state, remaining deadline, and attachment integrity are revalidated.
- Stage attachments per command under the exact target workspace or owned user
  staging root; use copied-byte hashes, no-follow/reparse checks, and atomic set
  publication.
- Enforce 8 files and 10 MiB total before publication. One invalid attachment
  blocks the whole set; evidence is never silently dropped.
- Persist delivery overlay separately from transcript messages.
- Preserve raw transcript timestamps/source/step metadata and correlate using
  stable markers/digests with bounded false-positive rules.
- Keep `observationState` separate and never use it to retry or promote
  delivery.
- Exact abort remains rejected unless Phase 3 proved scoped support.

## Architecture

Desktop maintains two projections:

```text
transcriptMessages: observed user/assistant/tool content
deliveryLedger: command/route/receipt/error/observation metadata
```

Renderer joins them by stable correlation without replacing either authority.
UI examples:

```text
Exact accepted
Active-panel Draft prepared
Receipt unknown
Response observed - receipt still unknown
Exact unavailable - open Draft
```

## Related Code Files

- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/main/bridge/antigravity-command-client.ts`
- Modify: `src/main/bridge/transcript-syncer.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/renderer/sidebar.ts`
- Modify: `src/preload/sidebar-preload.ts`
- Modify/Create: durable ledger/state storage under the existing app data owner
- Modify: `test/main/antigravity-command-client.test.ts`
- Modify: `test/main/transcript-correlation.test.ts`
- Create/Modify: queue restart, workspace ownership, attachment integrity,
  delivery overlay, late receipt, and exact-abort tests

## Implementation Steps

1. Introduce an authoritative session-to-conversation mapping record containing
   Antigravity fingerprint, source, verification time, and expiry/invalidation.
2. Make workspace resolution return a typed error when no exact existing owner
   is known. Discovery heuristics may suggest a workspace but cannot mutate it.
3. Persist queue items with immutable target and command identity. Migrate or
   quarantine old queue records lacking these fields; never dispatch them by
   current active session.
4. Restore busy/liveness state before queue watchdog dispatch. Require explicit
   user action for expired or invalidated queue items.
5. Stage each attachment set into a command-scoped directory. Copy with
   no-follow semantics, compute hash and byte length from copied bytes, verify
   MIME, then atomically publish the complete manifest.
6. Re-verify the full manifest at Extension and Sidecar consumption boundaries.
   Reject changed, missing, unsupported, oversized, or escaping files.
7. Add a durable Desktop delivery ledger keyed by command ID. Store requested
   and actual route, receipt digest, errors, timestamps, and observation state.
8. Change transcript refresh from full replacement to content merge. Preserve
   source `created_at` and stable record metadata.
9. Correlate transcript prompts/responses to ledger records without modifying
   delivery state. Expose ambiguous/no-match diagnostics rather than guessing.
10. Render distinct delivery and observation badges. Offer explicit Draft only
    before exact publication or after fail-closed preflight rejection.
11. Await abort receipts and reject any abort whose scope cannot be proven.
12. Ensure BridgeServer and renderer projections include the same immutable
    delivery metadata without leaking prompt bodies to logs.

## Todo

- [ ] Persist verified conversation mapping and fingerprint.
- [ ] Remove mutation workspace fallbacks.
- [ ] Freeze and migrate/quarantine queue targets.
- [ ] Restore host busy state before queue dispatch.
- [ ] Implement command-scoped all-or-nothing attachment staging.
- [ ] Enforce 8-file / 10 MiB copied-byte budget.
- [ ] Add durable delivery ledger and late receipt updates.
- [ ] Merge transcript content without replacing overlays.
- [ ] Preserve raw source timestamps and stable correlation metadata.
- [ ] Render separate delivery/observation states and explicit Draft action.
- [ ] Reject or receipt-bind abort operations.

## Validation Matrix

| Case | Expected result |
|---|---|
| Queue A, restart, active B | Item remains bound to A or is blocked; never sent to B |
| No exact workspace | Typed preflight failure; no bridge/artifact write |
| One of five images missing/changed | Entire command blocked before publication |
| Nine images or >10 MiB | Budget failure, no partial stage |
| Symlink/reparse escape | Rejected |
| Transcript refresh after accepted receipt | Delivery badge/command ID preserved |
| Response appears after unknown | Observation becomes response-observed; delivery stays unknown |
| Late verified receipt after restart | Delivery refines to accepted; no resend |

## Success Criteria

- [ ] No queued prompt can change conversation/workspace after enqueue.
- [ ] No mutation occurs in `E:\Work` or CWD fallback.
- [ ] Attachment claims match bytes consumed by Extension/Sidecar.
- [ ] Transcript refresh cannot erase delivery metadata.
- [ ] Observation and delivery states remain mechanically separate.
- [ ] Desktop verify and focused restart/integrity tests pass.

## Risks and Rollback

Old queue and message state may lack required identity. Quarantine it with a
visible manual-copy option instead of guessing. Rollback keeps ledgers and
staged evidence read-only and disables exact Auto.
