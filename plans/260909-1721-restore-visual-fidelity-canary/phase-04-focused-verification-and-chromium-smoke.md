---
title: "Phase 4: Focused Verification and Chromium Recovery Smoke"
status: done
---

# Phase 4: Focused Verification and Chromium Recovery Smoke

## Outcome

Compiled tests and a controlled real-Chromium experiment disprove truncation, timeout, cleanup, and lock-poisoning failures before the live target run.

## Files

- `.canary/tools/chromium-recovery-smoke.mjs`
- `.canary/tools/serve-static.mjs`
- `test/main/artifact-capabilities.test.ts`
- `test/integration/execution-control-cancellation.test.ts`

## Verification Sequence

1. Run `npm run typecheck`.
2. Run `npm run compile`.
3. Run compiled focused suites owning the changed contracts:
   - `.compiled/test/unit/visual-capture.test.js`
   - `.compiled/test/main/tab-devtools-host.test.js`
   - `.compiled/test/main/capability-catalogue.test.js`
   - `.compiled/test/main/visual-compare-mask-ledger.test.js`
   - `.compiled/test/main/runtime-fullpage-evidence.test.js`
   - `.compiled/test/main/baseline-authority-integration.test.js`
   - `.compiled/test/unit/theme-evidence-capabilities.test.js`
   - `.compiled/test/main/artifact-capabilities.test.js`
   - `.compiled/test/integration/execution-control-cancellation.test.js`
   - `.compiled/test/main/mcp-persistent-transport.test.js`
4. Launch or reuse one project-owned AntiFan Desktop process through the managed process surface; never kill user-owned Electron/Node processes.
5. Serve two deterministic tall local pages with known below-fold regions.
6. Exercise canonical production capabilities through the bridge, not a browser mock.

## Required Proof

- [x] Viewport, clip, and full-page receipts report correct mode, backend, CSS/raster geometry, DPR, and zoom.
- [x] Full-page raster exceeds viewport height and includes a known below-fold marker.
- [x] Offscreen full-page request cannot silently produce viewport geometry.
- [x] Complete screenshot above 8 MiB round-trips byte-for-byte with matching SHA256 and valid decode.
- [x] Over-policy screenshot fails before an artifact reference is issued.
- [x] Self-compare is deterministic with zero implicit masks.
- [x] Cancellation before CDP dispatch recovers pair-lock admission without touching the active holder; the next waiter succeeds after holder release.
- [x] Forced post-dispatch compare or standalone-capture timeout returns bounded `INCONCLUSIVE`/pending-cleanup state, keeps the target quarantined through CDP drain/reset, restores owned state, and releases transaction resources only with a typed recovery receipt.
- [x] A same-pair or same-target operation attempted during quarantine fails typed; the operation after recovery receipt succeeds.
- [x] Operation timeout creates no second server invocation or authority revision. Cooperative cleanup terminalizes inside policy budget; uncooperative cleanup returns nonterminal pending state and terminalizes only after recovery.

## Failure Rule

Any failure blocks the Hoplongtech run. Fix the demonstrated source defect and repeat this entire phase; never increase timeouts or weaken assertions to compensate.

## Done When

Focused suites pass and the owned real-Chromium smoke runner proves full-page integrity, pre-dispatch lock recovery, and post-dispatch target quarantine/recovery on the same tab pair.
