---
phase: 2
title: "Capture-Side Blockers"
status: pending
priority: P0
effort: "8h"
dependencies: ["phase-01-evidence-provenance-and-freshness-gate"]
---

# Phase 2: Capture-Side Blockers

## Overview

Every reason the campaign currently fails to measure is a capture-side or harness-side defect, not a fidelity difference. This phase removes them one at a time, each with a measured diagnosis first and a narrow, tested change second. The order is the order the run hits them: the settle contract (nothing past it can run), then the 390 tier, then the documents beyond the CDP ceiling, then the tall-page capture drains.

No fix may relax a fidelity assertion, inflate a timeout, or reintroduce a retry of an operation that may still be running.

## Requirements

### B1 — The settle contract must be diagnosable and satisfiable (blocker)

- Measured today: `mediaFrozen: true, fontsSettled: true, imagesSettled: true, visualStable: true, domSettled: false, structuralMutations: 18`, geometry signature stable, metrics identical across four passes.
- When the contract fails it must persist, in the page's evidence, every predicate it evaluated on every pass: `mediaFrozen`, `fontsSettled`, `imagesSettled`, `domSettled`, `visualStable`, the freeze error, `structuralMutations`, pending/broken image counts, font status and per-phase durations. Today a failed page persists `"stages": {}`.
- The settle proof must become the invariant the contract actually needs — the compared state is equal across passes — by promoting the *cross-pass equality of the structural metrics it already computes* (section count, card count, document height, plus the per-phase flags) to the deciding test, and demoting the raw `childList` count to recorded evidence. Formally: `settled = mediaFrozen && fontsSettled && imagesSettled && visualStable && metricsEqualAcrossPasses`, with `domSettled` and `structuralMutations` persisted in every pass so churn stays visible and adjudicable.
- This replaces a proxy with a direct measurement, and it keeps the failure mode it was guarding: a mid-transition frame is still caught by `visualStable` (geometry signature) and by `viewport-run.mjs`'s existing rasterization-stability gate, while a document whose metrics move between passes still fails.
- The geometry signature (`SETTLE_VISUAL_EXPR`) is corroboration, not the sole deciding test: it truncates to the first 4000 elements (`.canary/tools/canary-settle.mjs:75`) and samples roughly an 800 ms window, so it would miss lower sections of a 30 000 px page. Evaluating layout signatures inside a MutationObserver is rejected — it forces synchronous layout on every batch.
- A page with genuine instability must still fail. Both directions are pinned by tests: cosmetic churn with equal metrics settles; changing metrics do not.

### B2 — The 390 tier must run from a real mobile bundle

- `viewport-run.mjs:274-280` requires `clone/mobile/index.html`; nothing in the campaign produces it (`canary-run.mjs:359` does it for run3 only, over `reference/reference-mobile.html`).
- The mobile bundle needs a mobile *reference* first: the campaign dumps only the desktop reference (`fifteen-pages-run.mjs:475-479`) and merely resizes the tab for floor probes (`:500-520`). It must dump a mobile reference at 390 (`dump-ref.mjs` → `reference/reference-mobile.html`) and build the mobile bundle from that artifact; without it the mobile clone cannot be built at all.
- Absence must be a typed declared exception for that page × viewport, never a page FAIL indistinguishable from a fidelity failure.
- Bind the viewport write to capture receipts: `set-viewport` verifies ±1 px at write time but never verifies DPR/zoom, and nothing checks that the compare's later capture measured the same geometry. One saved 390 case measured the clone at `660x1429` while the reference measured `390x844`.

### B3 — Documents beyond the CDP ceiling

- `CAPTURE_MAX_DIMENSION = 16384` (`src/main/verification/visual-capture.ts:700`), refusal at `src/main/browser/tab-devtools-host.ts:1515-1519`; page-13 at 1024 measured `1200x30492`, page-15 `1200x32226`.
- The outcome must be a typed, declared refusal with the measured size, and the case must not read as a fidelity FAIL. The alternative evidence mode is Open Decision 3 — until it is ruled, the refusal alone is the deliverable, and no crop is ever produced.

### B4 — Tall-page capture drains at 1440

- Pages 13–15 at 1440 end in `TARGET_BUSY_DRAINING` (`src/main/tools/browser-control-port.ts:1679`, `:1724`). No offscreen/no-activate launch flag exists (`src/main/index.ts:256` shows the window unconditionally), so the compositor explanation does not apply; the cause must be measured (document mass, raster time, or a specific asset) before any change.
- Cause-aligned fix only: if the capture genuinely cannot complete within its budget, that is a typed refusal with the measured duration — not a longer timeout.

### B5 — Do not fix what the current code cannot produce

- The persisted `100% / CSS capture size mismatch` reasons cannot be produced by the current comparator for full-page pairs (`checkCaptureStateCompatibility`, `src/main/verification/visual-capture.ts:1094-1166`; drift gate `src/main/tools/browser-control-port.ts:5075-5130`). Re-measure before treating any saved cause as real; only reproduced causes may be fixed.

### B6 — Session and quota hygiene

- Observed: after a run that closed its tabs, a fresh session's first tab create was refused with `POLICY_DENIED … (session tab quota reached)` (`src/main/tools/browser-control-port.ts:2076`) while the session-scoped tab census was `[]`.
- Ten such orphans were measured on the instance plane (`anti.browser.tabs.list` → 10, `browser.list-tabs` → 0). They survive an instance stop/start and a fresh session mint, and no live session may close them (`TARGET_MISMATCH`, scoping rule `src/main/tools/browser-control-port.ts:2175-2181`). They did **not** block a fresh session's tab create after the restart/mint, so they are a tab-count hygiene defect rather than a run blocker (plan fact 13).
- The run must assert both tab censuses before and after. Orphan clearance is an owner action for tab economy, not a prerequisite gate (the orphans do not block a run); the alternatives are a manual close in the isolated instance's window or an approved reset of that instance's persisted state, and this phase must not weaken session scoping to make clearance convenient.

## Related Code Files

- `.canary/tools/canary-settle.mjs` — `SETTLE_IMAGES_EXPR:35`, `SETTLE_DOM_EXPR:57-69`, `SETTLE_VISUAL_EXPR:69`, `METRICS_EXPR:92`, `settleAndMeasure:142`, `requireDoubleSettledMetrics:231`, composite AND `:241`
- `.canary/tools/fifteen-pages-run.mjs` — pre-dump settle call `:454`, floor probe `:485-517`
- `.canary/tools/viewport-run.mjs` — reference staging `:221-262`, mobile gate `:274-280`, clone hydration `:325`
- `.canary/tools/canary-run.mjs:359` — the existing mobile-bundle producer to mirror
- `.canary/tools/canary-floors.mjs` — floor validation (`CANARY_FLOOR_DOC_HEIGHT` is never set by the campaign)
- `src/main/tools/browser-control-port.ts` — drain refusals `:1679`, `:1724`; quota `:2076`; viewport verification `:2485-2570`
- `src/main/verification/visual-capture.ts:700`, `:1094-1166`; `src/main/browser/tab-devtools-host.ts:1515-1519`
- `test/unit/canary-settle-contract.test.mjs` — new

## Implementation Steps

1. **Settle diagnostics first, before any predicate change.** Persist the full per-pass settle record from both call sites (`fifteen-pages-run.mjs` pre-dump, `viewport-run.mjs` reference/clone staging) so a failure writes `stages.reference.settle` instead of `{}`. Verify against a reproduced failure.
2. **Settle predicate.** Promote cross-pass metric equality to the deciding test, demote the raw `childList` count to recorded evidence, and keep the double-pass rule. Add `test/unit/canary-settle-contract.test.mjs` with both directions: cosmetic churn with equal metrics settles; moving metrics do not.
3. **Prove it live.** Re-run the diagnostic against `https://hoplongtech.com/brands` on the pinned instance and require two consecutive passes with an equal metric tuple and all other predicates true, with the churn count recorded in the evidence.
4. **Mobile bundle.** At the 390 pass, dump the mobile reference (`reference/reference-mobile.html`) and build `clone/mobile/` from it, mirroring `canary-run.mjs:359`; wire the 390 case to the mobile bundle and give a missing bundle a typed declared exception. Record the measured geometry of both sides per case.
5. **Viewport-to-capture binding.** Record both sides' measured surface at capture time and refuse (typed) when the compare's receipt geometry disagrees with the requested viewport, instead of discovering it as a 100% placeholder.
6. **Ceiling and drains.** Apply the Open Decision 3 policy for >16384 px documents; measure and classify the 1440 drains on pages 13–15 and fix only a reproduced cause.
7. **Session hygiene.** Assert both tab censuses before and after a run, and document the session-renewal path for a stale attachment (restart the isolated instance, then re-mint) — distinct from orphan clearance, which no session can perform.

## Todo

- [ ] Persist full per-pass settle diagnostics on success and failure
- [ ] Promote cross-pass metric equality to the deciding settle test, churn recorded
- [ ] Add and pass `test/unit/canary-settle-contract.test.mjs` (both directions)
- [ ] Prove a live storefront page reaches two matching settled passes
- [ ] Build the campaign's mobile bundle and give its absence a typed exception
- [ ] Bind viewport writes to capture-time geometry per side
- [ ] Apply the ceiling policy and classify the tall-page drains
- [ ] Assert tab census and stale-attachment reset

## Verification

- `node --test test/unit/canary-settle-contract.test.mjs` → all cases pass, including the negative direction.
- `node .canary/state/settle-diag.mjs` on the pinned instance → `doubleSettled.ok === true` for the live brands page, with the full predicate record and the metric tuple persisted. (Measured before the fix: `ok` false, `domSettled` false, `structuralMutations` 18, metrics identical.)
- A failing settle writes the full predicate record into that page's evidence (no `"stages": {}`).
- A 390 case either runs against `clone/mobile/index.html` or carries a typed exception; no 390 case is a fidelity FAIL for a missing bundle.
- A document over 16384 px produces a typed refusal carrying its measured CSS size.

## Success Criteria

- [ ] The reference tab reaches two consecutive matching settled passes on each campaign page, or the failure names the predicate and its measurement.
- [ ] No harness-side settle or capture defect is reported as a page verdict.
- [ ] The negative settle test proves a genuinely unstable page still fails.
- [ ] No timeout was increased and no fidelity assertion was weakened.

## Rollback

All changes are confined to `.canary/tools/**` plus one additive evidence field. Reverting the settle predicate restores the previous contract without invalidating any previously persisted evidence, because diagnostics are additive.
