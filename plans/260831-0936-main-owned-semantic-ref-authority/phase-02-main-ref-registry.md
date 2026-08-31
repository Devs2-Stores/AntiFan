---
phase: 2
title: "Build the Bounded Main-Owned Semantic Ref Registry"
status: pending
priority: P1
effort: "2d"
dependencies: [1]
---

# Phase 2: Build the Bounded Main-Owned Semantic Ref Registry

## Overview

Add the sole `@ref` authority in Electron Main. Register descriptors, assign non-reused refs, format text, and invalidate synchronously on browser lifecycle changes.

## Requirements

- Key records by `tabId`, concrete `paneId`, `browserEpoch`, pane-local `documentGeneration`, exact `documentUrl`, `snapshotId`, collection sequence, and nonce.
- One host-wide counter allocates refs monotonically across every tab and pane for the full `NativeTabHost` lifetime. No lifecycle event except final host teardown makes a ref reusable.
- Resolve against the exact target tuple; distinguish stale target/URL/nonce from absent or evicted ref.
- Retain one active semantic snapshot per exact target. `NativeTabHost` serializes collection and semantic-ref actions through one FIFO exact-target operation tail; different targets remain concurrent. Bound descriptor count, serialized bytes, path depth, age, and process total. No timer and no per-ref tombstones.
- Beginning collection synchronously invalidates that exact target's active registry record before nonce installation. Failed, malformed, cancelled, or stale collection leaves no active record and allocates no refs.
- Every `did-start-navigation` observed for a pane—full main-frame, `isInPlace=true`, or subframe—increments that pane's semantic generation and invalidates its record. This is separate from existing diagnostics/QA authority clearing.
- Every navigation also requests world-`1004` nonce invalidation outside the FIFO; full main-frame navigation additionally destroys the isolated context. Executor URL/nonce rechecks remain mandatory because the invalidation call is asynchronous.
- Preserve `tabId` across unexpected desktop renderer failure and recover by replacing its WebContents. Intentional `closeTab()` destroys identity; crash/mobile recreation never reset host high-water.
- Generic attachment auto-refresh remains independent from semantic ref generation/URL/nonce pinning.

## Architecture

`SemanticRefRegistry` is a pure Main state module storing plain descriptors—not DOM nodes, WebContents, CDP IDs, `RemoteObjectId`s, page functions, promises, or queues. It owns host `nextRefIndex` plus per-target sequence/nonce state keyed with exact generation and collected URL. `beginCollection(target)` invalidates the active record and returns sequence/nonce; `publishSnapshot(...)` succeeds only for the current tuple/URL/sequence/nonce after complete validation. `NativeTabHost` owns `Map<ExactTargetKey, Promise<void>>` FIFO tails and live WebContents/epoch/generation/URL checks. Its wrapper installs its own tail before awaiting and deletes only when `map.get(key) === ownTail`. Navigation invalidates outside the queue. Initial bounds: 150 descriptors/snapshot, one active snapshot/exact target, 32 process-wide targets, 90s TTL, serialized-byte ceiling.

## Related Code Files

| Action | File | Symbols |
|---|---|---|
| Create | `src/main/browser/semantic-ref-registry.ts` | Pure begin/invalidate/publish/resolve/bounds logic |
| Modify | `src/main/browser/native-tab-host.ts` | Exact-target collection/ref-action FIFO, live checks, lifecycle invalidation |
| Create | `test/main/semantic-ref-registry.test.ts` | Pure contract tests |
| Modify | `test/main/native-tab-host-agent-lifecycle.test.ts` | Queue/failure cleanup/publication/invalidation wiring |
| Modify | `test/main/split-review-tabhost.test.ts` | Pane isolation and cross-target concurrency |

## Function and Interface Checklist

- [ ] `beginCollection(targetWithUrl)` invalidates the active record and returns next sequence/nonce without allocating refs.
- [ ] `publishSnapshot(targetWithUrl, sequence, nonce, rawDescriptors)` compare-and-publishes atomically or rejects stale URL/completion with no allocation.
- [ ] `NativeTabHost.runTargetOperation()` serializes collection and semantic-ref actions for one exact target; other targets are not blocked.
- [ ] Queue `finally` removes only its own current tail; throw, cancellation, navigation, and tab close leave no stranded/successor-deleting entry.
- [ ] Every navigation start bumps exact-pane semantic generation, including full main-frame, in-place, and subframe navigation.
- [ ] Every navigation invalidates Main synchronously and isolated nonce asynchronously; live URL and nonce are checked at every executor checkpoint.
- [ ] Synchronous `dispose()` marks disposed, destroys registry, and clears queue/generation state; late settlements cannot publish/recreate tails.
- [ ] Registry stats expose counts/bytes/high-water only; host diagnostics add queue count. Neither exposes descriptors/nonces.
- [ ] `nextRefIndex` never decrements; no tombstone collection grows with historical refs.

## Implementation Steps

1. Implement pure registry `beginCollection`/`publishSnapshot` with injected clock/limits and target generation/URL/sequence/nonce validation; invalidation precedes nonce rotation.
2. Validate count, bytes, geometry, paths, text, target, URL, sequence, nonce, and isolated envelope before allocation.
3. Implement exact-target FIFO for collection/ref actions with successor-safe cleanup and logical cancellation.
4. Collection enters queue, captures/rechecks WebContents/epoch/generation/URL, begins collection, invokes isolated scan, rejects undefined/malformed output, rechecks identity, then publishes. Every failure leaves no active snapshot.
5. Error precedence: malformed → `INVALID_ARGUMENT`; wrong epoch/generation/URL/target/nonce/sequence or disposed host → `REF_STALE`/`TARGET_STALE`; valid target but absent/evicted → `REF_NOT_FOUND`.
6. Replace tab-wide generation with exact-pane semantic generations. Increment on every `did-start-navigation`, including full main-frame, in-place, and subframe; keep diagnostics/QA clearing behavior separate.
7. On every navigation, synchronously invalidate Main and issue isolated nonce invalidation without waiting on FIFO. Full main-frame navigation relies additionally on context destruction.
8. Keep `dispose()` synchronous and distinguish intentional close from crash recovery; prove cleanup, cross-target concurrency, and non-aliasing.

## Test Scenario Matrix

| Scenario | Expected result |
|---|---|
| Desktop snapshot then mobile snapshot | Different target queues run concurrently; refs remain globally unique |
| Tab A snapshot then Tab B snapshot | Different target queues run concurrently; Tab B cannot reuse Tab A refs |
| Snapshot A replaced on same target | A invalidated before scan; new nonce publishes only on success |
| Collection queued behind ref action | Action finishes against old nonce before collection invalidates it |
| Ref action queued behind collection | Sees newly published snapshot or no snapshot after collection failure |
| Collection throws/undefined/cancels/navigates | No active snapshot, no allocated refs, queue tail released safely |
| Successor queued before predecessor finally | Predecessor cannot delete successor tail |
| Full main-frame navigation | Navigating pane invalidates; new context cannot reuse old nonce |
| In-page hash/history/SPA navigation | Navigating pane generation/record invalidate; URL/nonce checkpoints stop old action |
| Subframe navigation, including identical-layout iframe replacement | Entire pane snapshot and nonce invalidate; sibling pane remains valid |
| Renderer crash and WebContents replacement | Old pane refs fail; tab identity/high-water survive |

## Success Criteria

- [ ] Main owns every ref, descriptor, snapshot, sequence, active nonce, and exact-target operation ordering decision.
- [ ] Old refs cannot alias after collection start/failure, target/focus change, eviction, navigation, tab close/create, epoch change, pane recreation, or renderer recovery.
- [ ] Crash recovery preserves tab identity; intentional close destroys it.
- [ ] Count/byte/TTL bounds hold with O(active targets) registry state plus O(queued targets) host tails; cleanup reaches zero.

## Verification

```powershell
npm run compile
node --test .compiled/test/main/semantic-ref-registry.test.js .compiled/test/main/native-tab-host-agent-lifecycle.test.js .compiled/test/main/split-review-tabhost.test.js
npm run typecheck
```

## Risk Assessment

- **Wrong-pane invalidation:** pane-local generation adapters; test each pane navigation does not clear its sibling.
- **Crash/close ambiguity:** track intentional close and teardown state explicitly; tests cover event ordering without double destruction.
- **Heap retention:** one active snapshot/exact target, range-based stale recognition, host-owned queues, and coordinated host/registry teardown before adding complexity.
- **Rollback:** registry is not production action authority until Phase 3; remove hooks/module atomically if tests regress.
