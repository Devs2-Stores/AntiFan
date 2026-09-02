---
phase: 4
title: "Multi-Dimensional QA Engine & Clean Tab Protocol"
status: pending
priority: P1
effort: "1d"
dependencies: ["3"]
---

# Phase 4: Multi-Dimensional QA Engine & Clean Tab Protocol

## Overview
Implement the Multi-Dimensional QA Verification Engine in `packages/site-clone/src/qa/`, replacing raw single-metric pixel diffing with an 8-Dimension Verification Scorecard. Test and harden existing Core canvas-level pixel diff masking (`maskSelectors` in `src/main/tools/browser-control-port.ts`), and mandate clean tab reloads (`anti.browser.reload`) before interactive probe execution.

## Requirements
- Functional:
  - Implement 8-Dimension QA scoring in `packages/site-clone/src/qa/multi-dimensional-qa-engine.ts`:
    1. Visual Fidelity: `anti.visual.compare` across Desktop (1440px), Tablet (768px), and Mobile (390px) (Benchmark Criterion < 10%; High-bar Target < 2.5%).
    2. Responsive Reflow: 0px horizontal scrollbar leakage across 5 viewports (375, 768, 1024, 1440, 1920px).
    3. Structural Integrity: W3C HTML5 landmark and heading tree audit.
    4. Interactive Fidelity: Active interaction verification on clean tabs (Hover zoom, Slider click-through, Modal open/close).
    5. Asset Health: 0 broken 404 images, 0 font CORS errors, full Vietnamese glyph support.
    6. Semantic Accessibility: WCAG 2.2 AA contrast, 100% image alt coverage, ARIA state bindings.
    7. Code Cleanliness: Anti-slop audit (zero fake canvas, zero screenshot backgrounds, zero `!important` on structural layout).
    8. Haravan OS Readiness: Valid Liquid syntax and `settings_schema.json` verification.
  - Test and harden existing Core masking in `src/main/tools/browser-control-port.ts` to ensure `maskSelectors` correctly extracts bounding boxes and excludes pixels without leaking state across evaluations.
  - Enforce Clean Tab Protocol: After visual compare, reload the tab cleanly (`anti.browser.reload`) to ensure pristine JS runtime state before executing interactive behavioral probes.
  - Output structured, machine-readable `specs/qa-matrix.json` reports.
- Non-functional:
  - Core remains zero-clone-logic; 8-dimension scoring policy lives in `packages/site-clone/src/qa/`.
  - Differential regression rollback triggered if any Hard Blocker dimension degrades during iterative repair.

## Architecture
```
[Theme Preview Tab]
       │
       ▼
[Stage 1: Non-Destructive Visual Compare (Two-Phase Settle + Existing Core Canvas Masking)]
  ├── Desktop (1440px), Tablet (768px), Mobile (390px)
  └── Diff Mismatch Gate: < 10% Required (< 2.5% Target)
       │
       ▼
[Stage 2: Clean Tab Protocol (anti.browser.reload)]
  └── Resets all timers, Swiper instances, and event listeners to pristine state
       │
       ▼
[Stage 3: Interactive Behavioral Probes (packages/site-clone/src/qa/)]
  ├── Hover: Image zoom & button transition
  ├── Click: Category tabs & next/prev slider
  └── Modal: Video popup & branch locator
       │
       ▼
[Stage 4: Structural & Haravan OS 2.0 Audit]
       │
       ▼
[Report Output: `specs/qa-matrix.json` & Certification Verdict]
```

## Related Code Files
- Modify: `src/main/tools/browser-control-port.ts` (Test & harden existing `maskSelectors` bounding box extraction & cleanup)
- Create: `packages/site-clone/src/qa/multi-dimensional-qa-engine.ts` (Scorecard evaluator & weights in package)
- Create: `packages/site-clone/src/qa/clean-tab-probe.ts` (Reload and interactive behavior test runner)
- Create: `packages/site-clone/schemas/qa-matrix.schema.json` (Formal output JSON schema)
- Create: `packages/site-clone/test/qa-matrix.test.ts` (Unit test for 8-dimension scorecard calculation)

## Implementation Steps
1. Define `packages/site-clone/schemas/qa-matrix.schema.json` formalizing the 8 evaluation dimensions and pass/fail thresholds.
2. Test and harden `src/main/tools/browser-control-port.ts` `maskSelectors` resolution against complex selectors, hidden elements, and scroll offsets.
3. Implement `packages/site-clone/src/qa/clean-tab-probe.ts` executing clean reloads (`anti.browser.reload`) and running synthetic user interactions (`anti.agent.sequence`) across hovers, sliders, and modals.
4. Implement `packages/site-clone/src/qa/multi-dimensional-qa-engine.ts` computing weighted scores and enforcing hard blockers (Responsive overflow, Liquid syntax errors, Broken interactions).
5. Add automated emission of `specs/qa-matrix.json` and iteration logging to `reports/clone-benchmark.json`.
6. Add unit tests in `packages/site-clone/test/qa-matrix.test.ts` checking weighting logic and blocker detection.

## Success Criteria
- [ ] 8-Dimension QA scoring executes end-to-end and outputs valid `specs/qa-matrix.json`.
- [ ] Core `maskSelectors` bounding box exclusion verified without altering live DOM node styles.
- [ ] Clean Tab Protocol verified: all hover effects, sliders, and modals operate smoothly on the reloaded storefront tab.
- [ ] Overall benchmark pass condition satisfied: Visual Diff < 10% across all 3 viewports with zero hard blockers.
- [ ] Package build and test suite pass with zero errors.

## Risk Assessment
- **Risk**: Intentional horizontal scrollable containers (e.g. mobile product card carousels) falsely flagged as overflow bugs.
  - *Observable Signal*: Responsive Reflow dimension fails on valid touch-scrollable lists.
  - *Mitigation*: Distinguish between root body overflow (`document.documentElement.scrollWidth > clientWidth`) and scoped component scroll containers (`overflow-x: auto`).
