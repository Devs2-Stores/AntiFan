---
title: "Phase 1: Capture and Artifact Integrity"
status: done
---

# Phase 1: Capture and Artifact Integrity

## Outcome

Full-page, clip, and viewport screenshots have explicit lineage, complete PNG bytes, and geometry proving what Chromium captured.

## Files

- `src/main/browser/tab-devtools-host.ts`
- `src/main/tools/browser-capabilities.ts`
- `src/main/verification/visual-capture.ts`
- `src/main/verification/baseline-authority.ts`
- `src/main/tools/artifact-store.ts`
- `src/main/tools/artifact-capabilities.ts`
- `src/main/control-plane/control-plane-runtime.ts`
- `src/main/index.ts`
- `src/main/tools/browser-control-port.ts`
- `test/main/tab-devtools-host.test.ts`
- `test/main/artifact-capabilities.test.ts`
- `test/main/runtime-fullpage-evidence.test.ts`
- `test/main/visual-compare-mask-ledger.test.ts`
- `test/main/baseline-authority-integration.test.ts`
- `test/unit/theme-evidence-capabilities.test.ts`
- `scripts/smoke-visual-compare.cjs`

## Requirements

- [x] Resolve mode deterministically: `clipRect` wins over `fullPage`; the combination is `clip` mode with `captureBeyondViewport: true`.
- [x] Route offscreen full-page capture through canonical CDP document capture or fail with `FULLPAGE_CAPTURE_UNSUPPORTED_ON_OFFSCREEN`; never use viewport-bound `capturePage`.
- [x] Use one bounded `Page.captureScreenshot` call for full-page capture with document clip, `fromSurface: false`, and `captureBeyondViewport: true`.
- [x] Reject unsupported document geometry instead of clamping or truncating it.
- [x] Validate PNG signature, IHDR dimensions, terminal IEND, and real decode before issuing a receipt.
- [x] Add required `captureMode` and `cssCaptureSize` fields to capture envelopes and receipts; migrate every literal and compatibility projection.
- [x] Keep ordinary artifact limits unchanged. Add optional `artifactStoreOptions` to `ControlPlaneRuntimeOptions`, populated only by explicit canary startup configuration, for bounded verification-screenshot and verification-run limits.
- [x] `artifact.preflight` atomically acquires an exclusive staging lease for the dedicated evidence `runId`, reports configured limits and committed bytes, and rejects insufficient declared per-artifact or aggregate budget. All staging for that leased `runId` requires the lease owner/token; concurrent or foreign staging is rejected until explicit/finally release.
- [x] Immediately before every large artifact write, while holding the exclusive run lease, re-read authoritative committed bytes and recheck both per-artifact and remaining aggregate capacity; reject before writing on drift or overflow. Preflight acceptance alone is never treated as a reservation of bytes.
- [x] Expose canonical standalone verification capture through `anti.screenshot.full_page`. `browser.screenshot` and `anti.screenshot.viewport` remain viewport-only and reject `fullPage: true`, eliminating a short-budget alternate full-page path.
- [x] Give `anti.screenshot.full_page` a total server policy budget greater than the inner CDP 60-second maximum with reserved cleanup time; forward `context.signal` through `BrowserControlPort.screenshot`, passive-pool ownership, capture, staging, restoration, and target drain/reset.
- [x] Validate complete bytes and geometry, stage with reject-on-overflow semantics, and return both `ArtifactRef` and capture receipt. A dispatched timeout follows typed target quarantine; a nonterminal pending-cleanup response never masquerades as a completed receipt.
- [x] Require backend, capture mode, CSS viewport, CSS capture size, raster geometry, DPR, and zoom compatibility before pixel comparison.

## Implementation Steps

1. Refactor `captureVerificationScreenshot` into explicit viewport, clip, and full-page paths with the precedence above.
2. Remove both native full-page fallbacks, including the offscreen branch that bypasses `captureAction`.
3. Return typed failures for timeout, unsupported geometry, empty bytes, corrupt PNG, and raster/CSS scale disagreement.
4. Thread optional artifact limits through runtime construction while leaving production defaults unchanged; make `artifact.preflight` acquire a dedicated-run exclusive staging lease, enforce its owner/token at every stage, and release it in canary cleanup.
5. Re-read persisted/authoritative committed bytes under that lease immediately before each large write; verify declared artifact size and remaining aggregate capacity before any bytes are written.
6. Upgrade `anti.screenshot.full_page` to the canonical verification envelope and complete-artifact staging path; make viewport screenshot capabilities reject full-page mode.
7. Assign standalone full-page server execution/cleanup budgets around the inner CDP bound, propagate cancellation through all owned resources, and preserve target quarantine until typed recovery.
8. Stage verification PNGs using reject-on-overflow semantics and migrate every caller that constructs envelope literals.

## Verification

- [x] Full-page timeout rejects within its bound and calls `capturePage` zero times.
- [x] Offscreen full-page capture cannot return viewport-only bytes.
- [x] `fullPage + clipRect` captures an out-of-viewport rectangle and reports `captureMode: clip`.
- [x] Taller-document/viewport-raster, clamped geometry, missing IEND, undecodable PNG, and scale mismatch fail closed.
- [x] Valid tall PNG reports accurate CSS/raster dimensions and full-page lineage.
- [x] Complete PNG above 8 MiB round-trips byte-for-byte within the screenshot ceiling; above-ceiling PNG produces no artifact.
- [x] `artifact.preflight` grants only one owner for the dedicated evidence `runId`; a second owner/stage is rejected, every large stage rechecks committed capacity under the lease, and insufficient capacity fails before bytes or references are created. Release makes the run available again; ordinary runtime defaults remain unchanged.
- [x] Standalone full-page capability returns a complete artifact plus verified mode/geometry/decode/SHA256 receipt on success; timeout/cancel releases pool and tab state or returns typed nonterminal cleanup state with target quarantine and no terminal receipt.
- [x] Viewport screenshot capabilities reject `fullPage: true`; canonical full-page client/server budgets exceed the inner CDP bound and never replay an ambiguous invocation.

## Done When

No path can label viewport-only, truncated, corrupt, or geometrically incompatible bytes as full-page evidence.
