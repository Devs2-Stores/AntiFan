---
title: "Canary recovery: Final verification, readiness floor derivation, and plan completion"
date: 2026-09-10
summary: "Completed visual fidelity canary plan with verified readiness floors, slider sanitization, and deterministic reporting"
---

# Canary recovery: Final verification, readiness floor derivation, and plan completion

## What happened
- Completed the recovery and implementation plan `plans/260909-1721-restore-visual-fidelity-canary`.
- Hardened reference capture and readiness floor derivation in `.canary/tools/canary-floors.mjs` and `.canary/tools/canary-run.mjs`:
  - Extracted production helper `loadCachedReadinessFloors` and `validateProbedFloor` to enforce strict SHA-256 matching between `reference.html` and `reference-floors.json`.
  - Added live reference probing across target viewports ensuring valid integer section and product card counts before writing floor caches.
- Sanitized transient slider transform styles during reference DOM dump in `.canary/tools/dump-ref.mjs` bounded strictly to verified carousel wrapper contexts.
- Updated `NativeTabHost.prototype.setViewportSize` and `BrowserControlPort.setViewport` to return structured reload status, eliminating redundant reloadWaitCalls and failing closed on reload failures.
- Fixed `build-report.mjs` nested dimension extraction (`refReceipt.cssCaptureSize`, `cloneReceipt.cssCaptureSize`) and dynamic Next Action section interpolation.
- Verified 256 tests passing across all unit and compiled test suites:
  - 22 unit tests (`build-report-embedded-drift`, `build-report-next-action`, `canary-readiness-floors`, `dump-ref-slider-sanitization`, `native-tab-host-viewport`).
  - 234 compiled tests across 9 core test suites in `.canary/tools/run-compiled-tests.mjs`.
- Passed independent code reviewer audit (`CodeReviewer-2`) with 0 findings and confidence 1.
- Updated all phase documents and `plan.md` to `status: completed`.

## Decisions
- Reject ungrounded mobile failure claims: when mobile viewport comparison is blocked by geometric/overflow incompatibility, do not adjudicate responsive defects until complete evidence exists under identical geometry.
- Enforce strict fail-closed contract on cached readiness floors: any SHA-256 mismatch or missing viewport floor aborts execution rather than falling back to arbitrary hardcoded numbers.

## Next steps
- Unblock Phase 4 in `plans/260908-1223-independent-html-clone-and-fidelity-pipeline/` using the verified `.canary/run3/REPORT.md`.
- Eliminate the 4–5 px full-page capture height delta on desktop viewports (1440 and 1024).
- Eliminate the 270 px horizontal root overflow on the mobile clone (390).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
