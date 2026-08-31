---
phase: 5
title: "Integrate, Race-Test, Soak, and Document the Authority"
status: pending
priority: P1
effort: "1-2d"
dependencies: [4]
---

# Phase 5: Integrate, Race-Test, Soak, and Document the Authority

## Overview

Prove the cutover on real integration surfaces and low-spec constraints: navigation races, split panes, dynamic replacement, DevTools coexistence, resource bounds, and all public transports. Then update the smallest durable docs.

## Requirements

- Use behavioral tests and Electron smoke where WebContents behavior matters.
- Cover MCP/capability, legacy WebSocket, Action Registry, IPC, typed-versus-legacy errors, exact-target operation ordering, isolated-world spoof/failure behavior, trajectories, split review, Theme QA, and lifecycle.
- Measure registry/queue counts, bytes, and heap trend; do not invent a fixed RAM claim.
- Test DevTools open/close without debugger ownership.
- Compile immediately before every smoke that consumes `.compiled` artifacts.
- Keep fast deterministic integration tests under `test/integration`; put 1,000+ cycle soak only in `scripts/smoke-real-soak.cjs`.
- Update existing `README.md` and `docs/operations.md`; do not create imaginary docs.
- Remove obsolete renderer-ref scaffolding after smoke succeeds.

## Architecture

Deterministic tests cover exact errors, collection↔ref-action FIFO ordering, failure invalidation, successor-safe tail cleanup, isolated `undefined` results, nonce/injection ordering, main-world/preload spoofing, and no-side-effect boundaries. Electron smoke covers actual world `1004`, frames/shadows/views. Existing soak records operation count, active records, queue tails, high-water, heap, failures, and cleanup; thresholds prohibit tombstone/tail/listener growth.

## Related Code Files

| Action | File | Purpose |
|---|---|---|
| Create | `test/integration/semantic-ref-integration.test.ts` | Fast snapshot/action/caller parity/stale rejection |
| Modify | `test/main/native-tab-host-agent-lifecycle.test.ts` | Pane generations, crash identity, injection race |
| Modify | `test/main/bridge-attachment-dispatch.test.ts` | Fresh attachment vs stale ref |
| Modify | `test/main/theme-qa-parity.test.ts` | Metadata/QA parity |
| Modify | `scripts/smoke-split-review.cjs` | Real pane isolation and mobile trajectory |
| Modify | `scripts/smoke-real-soak.cjs` | 1,000+ cycle bounds/race scenario |
| Modify | `package.json` | Compile-before-split-smoke; no soak in default test glob |
| Modify | `README.md` | Main-owned authority behavior |
| Modify | `docs/operations.md` | Verification/stale-ref recovery |

## Function and Interface Checklist

- [ ] Combined diagnostics expose registry counts/bytes/high-water plus host queue-tail count, not descriptors/page content/nonces.
- [ ] Race hooks pause collection before/after nonce installation, ref action before/after executor, and predecessor `finally` after successor enqueue.
- [ ] Fixture covers isolated undefined, collection throw/cancel, full/in-page/subframe navigation—including identical-layout iframe replacement—synchronous dispose with unsettled work, action↔collection ordering, main/preload spoofing, hostile DOM/CSS overlay removal, identical-layout routes, and replacement during movement.
- [ ] DevTools probe repeats snapshot/action after open/close in world `1004`.
- [ ] Cleanup proves zero registry records, nonce state, generations, timers, processes, and queue tails immediately after synchronous dispose and after late settlement.
- [ ] Search/command gate confirms old authority symbols and invalid verification commands absent.

## Implementation Steps

1. Add fast cross-route tests for target/ref/envelope and typed-versus-legacy errors.
2. Add deterministic FIFO races: action→collection, collection→action, failure→action, predecessor-finally→successor; assert exact ordering and cleanup.
3. Add collection failures: isolated undefined/malformed, throw, cancel, full/in-page/subframe navigation, crash, and synchronous teardown; prior snapshot stays invalid, no refs allocate, late completion cannot resurrect state.
4. Add security/alias tests: world `1004`; main/preload cannot spoof state; repeated collection, identical-layout full/SPA/hash/history/iframe replacement, omitted pane/tab target changes.
5. Test independent pane generations, pane-wide subframe invalidation, cross-target concurrency, mobile trajectory, DevTools, crash recovery, and permanent close.
6. Extend existing soak with mixed collections/ref actions/failures/navigation/crashes; record active/queue/high-water/cleanup bounds.
7. Add compile to `smoke:split`; run focused tests, full verify, split smoke, soak. Never weaken tests.
8. Search/remove old ref globals/tags/main-world authority/fallbacks/bypasses; mechanically reject nonexistent npm scripts and raw TypeScript test commands.
9. Update README/operations with world `1004`, FIFO/failure semantics, explicit pane recommendation, trajectory boundary, and stale-ref recovery.

## Test Scenario Matrix

| Surface/failure | Evidence |
|---|---|
| MCP/control-plane | Typed errors; valid ref keeps existing success envelope |
| Legacy/action registry | Boolean failure compatibility; no rejection/bypass |
| World allocation/spoof | Exactly `1004`; main and preload worlds cannot read/replace state; hostile overlay DOM removal self-heals without breaking action execution |
| Action then collection | Action completes with old nonce; collection invalidates afterward |
| Collection then action | Action sees new snapshot or absence after failure |
| Collection undefined/malformed/throw/cancel | Old snapshot invalid, no ref allocation, tail released |
| Synchronous dispose with unsettled operation | State/tails zero immediately; late settlement cannot publish or recreate tail |
| Concurrent desktop/mobile | No global serialization; exact targets independent |
| Full navigation during operation | Pane generation/context/nonce invalidation and rechecks stop action |
| In-page SPA/hash/history navigation | Pane generation, exact URL, and isolated nonce invalidation stop action |
| Subframe navigation, including identical-layout iframe replacement | Entire pane snapshot/generation/nonce invalidates; sibling pane remains valid |
| Identical-layout main-frame navigation | Old URL/generation/nonce rejects despite matching path/fingerprint |
| Crash and recover same tab | High-water survives; old ref never aliases |
| Shadow/nested-frame | Metadata, top-level coordinates, action parity |
| Cross-origin/closed shadow | Safe omission |
| Node replacement before/during execution | Validation blocks irreversible event |
| 1,000+ mixed operations | Caps hold; no tombstone/tail/listener growth |
| Cleanup | Zero records/nonce/queue/orphans |

## Success Criteria

- [ ] Focused suites and `npm run verify` pass from fresh compilation; long soak absent from default test glob.
- [ ] Freshly compiled split smoke and DevTools probe pass using world `1004`.
- [ ] FIFO ordering, failure invalidation, successor-safe cleanup, isolated undefined, spoof, full/in-page/subframe navigation—including identical-layout iframe replacement—replacement, crash, pane/focus/tab-switch tests pass at specified boundaries.
- [ ] Count/byte/queue caps hold; soak shows no tombstone/tail/unbounded retained growth.
- [ ] Old authority/bypasses/main-world dispatchers/customer-visible nonce and invalid verification commands are absent.
- [ ] Existing docs match tested behavior.

## Verification

```powershell
npm run compile
node --test .compiled/test/main/semantic-ref-contract-characterization.test.js .compiled/test/main/semantic-ref-registry.test.js .compiled/test/main/guarded-action-dispatch.test.js .compiled/test/main/zero-mutation-walker.test.js .compiled/test/main/native-tab-host-agent-lifecycle.test.js
node --test .compiled/test/integration/semantic-ref-integration.test.js
npm run verify
npm run smoke:split
npm run smoke:soak
```

## Risk Assessment

- **Animation flake:** assert completion/state, not sleeps.
- **Heap noise:** combine post-cleanup samples with exact registry/listener counts and absence of tombstones.
- **Test contamination:** default `npm test` runs only fast deterministic integration; long soak stays in the smoke script.
- **Overclaiming AX parity:** document same-origin/open-shadow limits exactly.
- **Rollback:** do not release if any gate fails; revert Phase 4, never add a dual-authority flag.
