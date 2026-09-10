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
- **The current predicate is internally inconsistent and must be fixed first.** `settleAndMeasure` computes `settled` **without** `fontsSettled` (`.canary/tools/canary-settle.mjs:184`) and derives `timedOut: !settled` from it, while `requireDoubleSettledMetrics` recomputes `settled` **with** `fontsSettled` (`:241`). A page whose fonts never load therefore reports `settled` true and `timedOut` false while the gate that throws says otherwise, and the throw's history line prints only `sections`, `cards`, `docHeight` and `settled` — never which predicate failed. Align the two predicates and persist every component on failure; today a failed page writes `"stages": {}` for that reason.
- **Separate the diagnostic fact from the gate.** `domQuiet` (the raw `childList` churn count and its `domSettled` verdict) becomes recorded evidence that is persisted on every pass; `renderStateStable` becomes the gate that enters the composite: `settled = mediaFrozen && fontsSettled && imagesSettled && visualStable && renderStateStable`. One definition, one owner, no predicate that is both a reported fact and a hidden gate input.
- **`renderStateStable` must be content-sensitive and equality-based, over a fingerprint of the authoritative probes**, because the existing signals cannot see a swap: `SETTLE_VISUAL_EXPR` compares element rectangles only (`.canary/tools/canary-settle.mjs:75`), `requireDoubleSettledMetrics` compares only `sectionCount` and `productCardCount` (`:238-242`), and `viewport-run.mjs`'s rasterization gate compares capture heights only (`:420-451`). Equal-geometry image, text or carousel swaps pass all three unchanged. The fingerprint must therefore cover at least: section count, product-card count, document height, image count, the pending/broken image counts, and a hash over the image set with its identity and rendered rect — the image list `SETTLE_IMAGES_EXPR` already collects (`:106`), plus a text fingerprint over the body's visible text.
- **Raw churn may be non-decisive only behind that content check, and only when dynamic widgets are actually frozen.** `anti.media.freeze` is currently called with `normalizeSliders:false` (`.canary/tools/canary-settle.mjs:170`), so auto-rotating widgets keep changing content; where a widget cannot be frozen or its content cannot be shown to be stable, the case must be refused with a typed `DYNAMIC_CONTENT_UNCONTROLLED` instead of being admitted on a rectangle-only comparison. The freeze scope is Open Decision 1.
- **Instrument before changing the rule.** The 18 mutations must be identified by signature — target path, node type/class, added/removed counts, timestamps — and shown to be cosmetic (advertisement/analytics re-parenting, not content or layout) before `domQuiet` stops being decisive. Asserting that churn is cosmetic is not evidence that it is.
- A page with genuine instability must still fail. Both directions are pinned by tests: equal fingerprints with equal geometry settle; moving fingerprints, equal-shape content swaps, or unfrozen dynamic content do not.

### B2 — The 390 tier must run from a real mobile bundle

- `viewport-run.mjs:274-277` requires `clone/mobile/index.html`; nothing in the campaign produces it (`canary-run.mjs:359` does it for run3 only, over `reference/reference-mobile.html`).
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
- The run must assert both tab censuses before and after and must not create a tab it cannot close. Orphan clearance is an owner action for tab economy, not a run prerequisite; the alternatives are a manual close in the isolated instance's window or an approved reset of that instance's persisted state, and no privileged close parameter is to be hunted for.

## Related Code Files

- `.canary/tools/canary-settle.mjs` — `SETTLE_IMAGES_EXPR:35`, `SETTLE_DOM_EXPR:57-69`, `SETTLE_VISUAL_EXPR:69-78`, `METRICS_EXPR:92`, `settleAndMeasure:175-204` (predicate at `:184`), `requireDoubleSettledMetrics:231-253` (predicate at `:241`, count comparison at `:238-242`), freeze call `:170`
- `.canary/tools/fifteen-pages-run.mjs` — pre-dump settle call `:454`, floor probe `:485-517`, desktop reference dump `:475-479`
- `.canary/tools/viewport-run.mjs` — reference staging `:221-262`, mobile gate `:274-277`, rasterization gate `:420-451`, clone hydration `:325`
- `.canary/tools/canary-run.mjs:359` — the existing mobile-bundle producer to mirror
- `.canary/tools/canary-floors.mjs` — floor validation (`CANARY_FLOOR_DOC_HEIGHT` is never set by the campaign)
- `src/main/tools/browser-control-port.ts` — drain refusals `:1679`, `:1724`; quota `:2076`; viewport verification `:2485-2570`
- `src/main/verification/visual-capture.ts:700`, `:1094-1166`; `src/main/browser/tab-devtools-host.ts:1515-1519`
- `test/unit/canary-settle-contract.test.mjs` — new

## Implementation Steps

1. **Instrument the churn, changing nothing.** Capture the mutation signature (target path, node type/class, added/removed counts, timestamps) for the live brands page and persist it. Run it as an inline module (`node --input-type=module -e`, importing the existing `call` / `settleAndMeasure`) rather than adding a throwaway script, close the tab in a `finally` that survives a tab-id or viewport failure, and keep only the captured output.
2. **Align the predicates.** Make `settleAndMeasure` and `requireDoubleSettledMetrics` compute `settled` from the same components, including `fontsSettled`, and make the failure history name every component and its value per pass. Verify against a reproduced failure: the page that writes `"stages": {}` today must write the full record.
3. **Split the facts.** Introduce `domQuiet` as recorded evidence and `renderStateStable` as the gate, and state in one place which enters the composite.
4. **Make the gate content-sensitive.** Add the fingerprint (counts, document height, image set with rendered rects, visible-text fingerprint) and require equality across consecutive passes; keep the two-consecutive-pass rule.
5. **Test both directions.** `test/unit/canary-settle-contract.test.mjs`: equal fingerprints with equal geometry settle; a moving fingerprint fails; an equal-shape content swap fails; unfrozen dynamic content is refused with `DYNAMIC_CONTENT_UNCONTROLLED`.
6. **Prove it live.** Re-run the diagnostic against `https://hoplongtech.com/brands` on the pinned instance and require two consecutive passes with an equal fingerprint, the full predicate record persisted, and the churn count recorded.
7. **Mobile bundle.** At the 390 pass, dump the mobile reference (`reference/reference-mobile.html`) and build `clone/mobile/` **inside that page's attempt directory**, mirroring `canary-run.mjs:359`; wire the 390 case to it and give a missing bundle a typed declared exception. Record the measured geometry of both sides per case.
8. **Viewport-to-capture binding.** Record both sides' measured surface at capture time and refuse (typed) when the compare's receipt geometry disagrees with the requested viewport, instead of discovering it as a 100% placeholder.
9. **Ceiling and drains.** Apply the Open Decision 3 policy for >16384 px documents; measure and classify the 1440 drains on pages 13–15 and fix only a reproduced cause.
10. **Session hygiene.** Assert both tab censuses before and after a run, and document the session-renewal path for a stale attachment (restart the isolated instance, then re-mint) — distinct from orphan clearance, which no session can perform.

## Todo

- [ ] Capture the mutation signature and prove the churn cosmetic
- [ ] Align the two settle predicates and persist every component
- [ ] Split `domQuiet` (evidence) from `renderStateStable` (gate)
- [ ] Add the content-sensitive fingerprint to the gate
- [ ] Add and pass `test/unit/canary-settle-contract.test.mjs` (including the swap case)
- [ ] Prove a live storefront page reaches two matching settled passes
- [ ] Build the campaign's mobile bundle and give its absence a typed exception
- [ ] Bind viewport writes to capture-time geometry per side
- [ ] Apply the ceiling policy and classify the tall-page drains
- [ ] Assert the tab census before and after a run

## Verification

- `node --test test/unit/canary-settle-contract.test.mjs` → all cases pass, including the equal-shape swap case and the negative direction.
- The mutation signature for the live brands page is persisted and identifies the mutating node classes; the churn is cosmetic by that evidence, not by assumption.
- A live run on the pinned instance reaches two consecutive passes with an equal fingerprint; the persisted record contains every predicate component.
- A failing settle writes the full predicate record into that page's evidence (no `"stages": {}`).
- A 390 case either runs against `clone/mobile/index.html` or carries a typed exception; no 390 case is a fidelity FAIL for a missing bundle.
- A document over 16384 px produces a typed refusal carrying its measured CSS size.

## Success Criteria

- [ ] The reference tab reaches two consecutive matching settled passes on each campaign page, or the failure names the predicate and its measurement.
- [ ] No harness-side settle or capture defect is reported as a page verdict.
- [ ] The negative tests prove a moving fingerprint, an equal-shape content swap, and unfrozen dynamic content all still fail.
- [ ] No timeout was increased and no fidelity assertion was weakened.

## Rollback

All changes are confined to `.canary/tools/**` plus additive evidence fields. Reverting the settle predicate restores the previous contract without invalidating any previously persisted evidence, because diagnostics are additive.
