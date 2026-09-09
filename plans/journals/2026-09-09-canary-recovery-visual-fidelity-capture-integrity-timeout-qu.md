---
title: "Canary recovery: Visual fidelity capture integrity, timeout quarantine, and live Chromium Hoplongtech canary run 3"
date: 2026-09-09
---

# Canary recovery: Visual fidelity capture integrity, timeout quarantine, and live Chromium Hoplongtech canary run 3

## Context
The visual fidelity pipeline previously stalled with false PASS and false failure classifications, broken full-page lineage fallbacks to `capturePage`, non-atomic compare pairs, and unquarantined CDP timeouts. This work executed the implementation plan `plans/260909-1721-restore-visual-fidelity-canary` to restore evidence integrity, enforce strict two-stage server timeouts, and run a live production canary against `https://hoplongtech.com/`.

## Changes
1. **Capture & Artifact Integrity (Phase 1):**
   - Removed lossy offscreen and fallback full-page branches; full-page mode strictly routes through canonical CDP document screenshots (`fromSurface: false`, `captureBeyondViewport: true`).
   - Hardened `artifact.preflight` to atomically acquire an exclusive lease for the evidence `runId`, enforcing per-artifact and aggregate run limits.
   - Enforced PNG header/IEND validation and complete dimension checking before issuing capture receipts.
2. **Bounded Compare Transaction (Phase 2):**
   - Implemented two-stage timeout in `CapabilityTransportAdapter`: execution deadline (`policy.timeoutMs - cancellationAckTimeoutMs`) with reserved cleanup time.
   - Guarded against pair-lock queue poisoning with abort-aware `MultiKeyLock` and CDP target quarantine until typed drain/reset recovery.
   - Enforced single pair lock over both reference and clone tabs, capturing both under before/after coherence windows.
3. **Transport & Canary Harness (Phase 3):**
   - Updated MCP transport client budgets to exceed server budgets, preventing duplicate dispatches on operation timeout.
   - Implemented request/idempotency ID persistence across transport retries.
   - Hardened local clone preview server against directory traversal and unauthorized origins.
4. **Focused Verification & Smoke (Phase 4):**
   - Recompiled and executed 26 targeted integration/unit test files covering 192 focused tests.
   - Executed live Chromium smoke (`reports/phase-04-chromium-recovery-smoke.md`) proving full-page capture, pre-dispatch cancellation, and post-dispatch target recovery.
5. **Live Hoplongtech Canary (Phase 5):**
   - Ran live production clone generation and multi-viewport runner against `https://hoplongtech.com/` at 1440×900, 1024×900, and 390×844 under lease `run-15bef6d0-a36a-49fa-93a0-2db9b4632c37`.
   - Persisted immutable raw PNGs, structural receipts, and asset audits under `.canary/run3/evidence/`.
6. **Report & Fidelity Gate (Phase 6):**
   - Implemented `.canary/tools/build-report.mjs` generating the 16-section `.canary/run3/REPORT.md`.
   - Fact extraction correctly surfaces real evidence (118 localized assets, 14 matched sections, zero remote subresources).
   - Gate accurately determined `INCONCLUSIVE` due to capture state size mismatch (4–8 px full-page CSS capture-height mismatch: target vs baseline) without speculative failures or false claims.

## Verification
- `npm run typecheck`: clean (0 errors).
- `node .canary/tools/build-report.mjs .canary/run3`: clean deterministic output generating `.canary/run3/REPORT.md`.
- Subagent `CodeReviewer`: confidence 1, overall_correctness "correct", zero regressions detected.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
