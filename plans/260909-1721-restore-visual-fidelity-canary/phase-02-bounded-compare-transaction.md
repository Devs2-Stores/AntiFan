---
title: "Phase 2: Bounded Compare Transaction"
status: done
---

# Phase 2: Bounded Compare Transaction

## Outcome

`anti.visual.compare` terminates coherently, restores temporary mutations, and cannot poison pair locks or CDP target state.

## Files

- `src/main/tools/browser-control-port.ts`
- `src/main/verification/visual-capture.ts`
- `src/main/tools/browser-capabilities.ts`
- `src/main/tools/capability-transport.ts`
- `src/main/browser/tab-devtools-host.ts`
- `test/integration/execution-control-cancellation.test.ts`
- `test/unit/visual-capture.test.ts`
- `test/main/capability-catalogue.test.ts`
- `test/main/visual-compare-mask-ledger.test.ts`
- `test/main/runtime-fullpage-evidence.test.ts`

## Requirements

- [x] Both compare registrations define one total server response budget, reserve `cancellationAckTimeoutMs` for cleanup, and forward `context.signal` as an optional final `visualCompare` argument; direct callers remain source-compatible.
- [x] At the execution deadline (`policy.timeoutMs - cancellationAckTimeoutMs`), `CapabilityTransportAdapter` aborts `ExecutionControlImpl` with source `timeout`; every compare await is signal-aware or locally bounded by the remaining execution budget.
- [x] The adapter awaits dispatch completion and invocation-owned cleanup inside the reserved grace period. Cooperative cleanup yields a terminal `EXECUTION_TIMEOUT` only after resources are released/fenced; no bare `Promise.race` may settle the durable invocation while locks, pool slots, active-tab state, or DOM mutations remain owned.
- [x] If cleanup misses the client-response deadline, return typed `EXECUTION_TIMEOUT_PENDING_CLEANUP` with invocation ID, keep the ledger nonterminal/idempotency-joinable, invalidate the stale continuation token, and quarantine the affected transaction/target. Continue only the original cleanup; issue the terminal timeout receipt after cleanup or completed isolation teardown, never asynchronously terminalize while resources remain owned.
- [x] Lock-wait cancellation before transaction admission preserves FIFO and mutual exclusion, releases only partial acquisitions in reverse order, touches no tab/CDP state, and permits the next waiter after the holder releases.
- [x] A timeout after `Page.captureScreenshot` dispatch keeps the target and pair transaction quarantined until the command settles or a bounded debugger reset completes; release for reuse occurs only after the drain/reset receipt.
- [x] Active-tab restoration, DOM restoration, pool release, and pair-lock release run only for resources acquired by that invocation and are idempotent under forced teardown.
- [x] Normalization is reversible: do not remove DOM nodes or install permanent style setters; restore owned styles, attributes, classes, scroll positions, and temporary views.
- [x] Add `useDefaultWidgetMasks`; final fidelity runs set it to `false` so generic selectors cannot hide first-party content.
- [x] Under one pair lock, normalize both tabs, settle both, open before-identity/mutation windows for both, capture and stage both exact raw PNGs, then perform post-capture identity checks before structural/pixel comparison; return the authoritative pair and receipts on every later definitive or `INCONCLUSIVE` result.
- [x] Capture/settlement/draining/abort failures before a complete coherent pair return `INCONCLUSIVE` with typed reason and no fabricated pixel metrics; only coherence mutation may resample.

## Implementation Steps

1. Partition the registered policy into execution and cleanup budgets; propagate timeout cancellation through registration to `BrowserControlPort.visualCompare` and add invocation fencing/cleanup acknowledgement.
2. Make every resource-holding compare await bounded or signal-aware, including pair-lock admission, settlement, switching, eval, capture, staging, structural probes, restoration, and CDP recovery.
3. Make `MultiKeyLock.acquire` abort-aware without unsafe queue-node removal; pre-admission cancellation self-releases in queue order and never invokes target recovery.
4. Track acquisition/ownership flags and an invocation token so ordinary and forced cleanup cannot release another invocation's resource or permit stale continuation effects.
5. Expose bounded CDP drain/reset completion from `TabDevToolsHost`; post-dispatch timeout retains quarantine and pair exclusion through its recovery receipt.
6. Replace destructive normalization with an owned reversible transaction.
7. Reorder atomic compare to prepare and settle both tabs before either capture; stage each captured buffer immediately, complete both post-capture coherence checks, then diff those exact buffers and preserve their refs/receipts on all later failure paths.
8. Disable implicit masks when requested and keep unmasked structural metrics authoritative.

## Verification

- [x] Policy execution deadline reaches `context.signal`; cooperative cleanup completes inside the reserved grace and terminal timeout settles within `policy.timeoutMs` only after cleanup.
- [x] A deliberately uncooperative cleanup path returns bounded `EXECUTION_TIMEOUT_PENDING_CLEANUP`, keeps one nonterminal joinable invocation, admits no reusable target or successor, and creates a terminal receipt only after owned-resource cleanup or completed isolation teardown.
- [x] Cancellation while waiting for a held pair lock dispatches zero CDP commands, never overlaps or resets the holder, and the next waiter succeeds immediately after holder release.
- [x] Lock-admission timeout cannot switch the active tab or release another invocation's lock.
- [x] A dispatched screenshot timeout returns bounded `INCONCLUSIVE`, retains `TARGET_BUSY_DRAINING` quarantine, and cannot admit a same-pair compare until drain/reset completes; after the recovery receipt, the same pair succeeds.
- [x] Success, timeout, stale target, and cancellation restore DOM state, scroll, active tab, pool capacity, and owned pair locks without stale-continuation effects.
- [x] Authoritative compare output references the exact two staged buffers captured under one before/after coherence receipt; downstream diff failure preserves both.
- [x] Cardinality/grid/geometry mismatch cannot pass through masks or low pixel diff.
## Done When

Pre-dispatch cancellation recovers the lock queue without touching CDP; post-dispatch timeout yields bounded typed quarantine and recovery. A client response may precede cleanup only as an explicitly nonterminal, joinable pending state; no terminal receipt outlives resource ownership or permits stale continuation.
