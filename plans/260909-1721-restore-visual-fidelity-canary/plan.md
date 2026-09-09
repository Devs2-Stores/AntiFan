---
title: "AntiFan Real Independent HTML Fidelity Canary Recovery"
description: "Repair full-page evidence integrity and complete the live Hoplongtech three-viewport fidelity canary without false PASS conditions."
status: in-progress
priority: P1
effort: "XL"
tags: [visual-fidelity, chromium, independent-html, canary, reliability]
created: 2026-09-09
---

# AntiFan Real Independent HTML Fidelity Canary Recovery

## Outcome Contract

Restore `anti.visual.compare`, prove its timeout/recovery behavior in real Chromium, then execute the actual production clone pipeline against `https://hoplongtech.com/` at exactly `1440×900`, `1024×900`, and `390×844`. The final deliverable is `.canary/run3/REPORT.md` with immutable raw screenshots, pixel and structural evidence, asset/runtime audits, and exactly one verdict: `PASS`, `FAIL`, or `INCONCLUSIVE`.

## Constraints

- Reference is the live Hoplongtech storefront at capture time; no synthetic substitute or screenshot editing.
- Full-page evidence never falls back to viewport-only `webContents.capturePage` and never stores truncated/corrupt PNG bytes.
- Timeout cannot autoheal, rebind, or replay an operation that may still be running.
- Header, navigation, hero, product grids, article content, footer, and whole-page geometry remain unmasked and structurally measurable.
- Reference and candidate use identical CSS viewport, DPR, zoom, capture mode, and Chromium runtime.
- `.canary/run1/` and `.canary/run2/` remain immutable; all new evidence belongs under `.canary/run3/`.
- No clone-architecture change unless fresh live evidence proves that architecture is the failure owner.

## Non-Goals

- Do not tune known minor layout deltas before recovered pixel evidence ranks them.
- Do not use unit tests, DOM similarity, Playwright, mock screenshots, or sectional crops as substitutes for full-page live Chromium proof.
- Do not relax the `2%` engineering target, subtract reference drift, increase timeouts to conceal hangs, or weaken structural gates to obtain PASS.

## Phases

| # | Phase | Status | Dependency |
| --- | --- | --- | --- |
| 1 | [Capture and Artifact Integrity](./phase-01-capture-and-artifact-integrity.md) | Complete | None |
| 2 | [Bounded Compare Transaction](./phase-02-bounded-compare-transaction.md) | Complete | Phase 1 |
| 3 | [Transport and Canary Harness](./phase-03-transport-and-canary-harness.md) | Complete | Phase 2 contracts |
| 4 | [Focused Verification and Chromium Recovery Smoke](./phase-04-focused-verification-and-chromium-smoke.md) | Complete | Phases 1–3 |
| 5 | [Live Hoplongtech Canary](./phase-05-live-hoplongtech-canary.md) | Partial | Phase 4 green |
| 6 | [Report and Fidelity Gate](./phase-06-report-and-fidelity-gate.md) | Partial | Phase 5 evidence |

## Success Criteria

- [x] Capture receipts prove mode/backend/CSS/raster geometry, DPR, zoom, complete PNG decode, and immutable SHA256 lineage.
- [x] Server policy timeout is a bounded client-response budget with reserved cleanup time; terminal timeout receipt settles only after owned resources are released or a completed isolation teardown fences them from reuse. Pending cleanup remains nonterminal and joinable by invocation identity.
- [x] Pre-dispatch lock cancellation leaves CDP untouched and permits the next waiter; post-dispatch screenshot timeout quarantines the target until a typed drain/reset recovery receipt permits reuse.
- [x] Verification-specific screenshot and aggregate run quotas are capacity-preflighted under an exclusive evidence-run lease; committed bytes are rechecked before every large write without raising ordinary runtime limits.
- [x] Real production discovery/localization/generation executes; clone runtime makes zero reference-origin visual requests.
- [x] Real Chromium captures raw reference/candidate pairs and structural evidence at all three exact viewports.
- [x] `.canary/run3/REPORT.md` follows all sixteen required sections and distinguishes unit, runtime, visual, structural, and asset proof.
- [x] Final gate emits `PASS`, `FAIL`, or `INCONCLUSIVE` strictly from complete persisted evidence. (Emitted `INCONCLUSIVE`).

## Red-Team Adjudication

Three completed hostile reviews tested failure modes, assumptions, contracts, and security boundaries; a fourth review was canceled under the repository circuit breaker after repeated non-advancing waits and produced no findings. Accepted corrections include offscreen full-page bypass, `clipRect + fullPage` precedence, complete artifact storage, exclusive evidence-run capacity preflight, a canonical standalone verification-capture capability, atomic compare pair capture/staging, a two-stage server deadline with reserved cleanup and nonterminal pending-cleanup state, reversible normalization, separate pre-dispatch lock cancellation and post-dispatch CDP quarantine, guarded active-tab cleanup, stable retry identity, direct-RPC parity, strict height, disabled implicit masks, and hardened loopback serving.

Rejected as unnecessary or policy-breaking:

- Replacing the Promise-tail lock with a doubly-linked queue: cancellation can preserve FIFO by self-releasing only after predecessor completion; no queue rewrite is required.
- Subtracting or calibrating against reference self-drift: excessive drift makes evidence `INCONCLUSIVE`; it cannot improve the candidate score.
- Increasing timeouts as the fix: budgets are only valid after bounded operations, cancellation propagation, cleanup, and target recovery exist.

## Dependency and Rollback Boundary

This plan unblocks the visual-fidelity phase of `plans/260908-1223-independent-html-clone-and-fidelity-pipeline/`; it is not blocked by that plan's already-completed clone-generation phases. Capture/transport changes remain isolated from clone synthesis. If controlled Chromium proof regresses, revert only recovery implementation changes; never modify prior canary evidence.

<!-- slug: restore-visual-fidelity-canary -->