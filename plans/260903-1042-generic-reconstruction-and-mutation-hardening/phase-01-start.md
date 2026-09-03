---
phase: 1
title: "Integrity Fixes & Mutation QA Safety Harness"
status: pending
priority: P1
effort: "0.5d"
dependencies: []
---

# Phase 1: Integrity Fixes & Mutation QA Safety Harness

## Overview
Fix the critical logic defect in `CleanTabProtocol.withReversibleState` where `restored: true` was reported prematurely before `finally` executed and `restoreState` result was discarded. Implement the `MutationQAHarness` test suite covering 3 mutation stress scenarios (200-character Text Stretch, Cardinality Shift to 1 and 11 items, and Image Ratio Distortion 1:3 vs 3:1) to establish an unbreakable safety net before modifying IR and code generation logic.

## Requirements
- Functional:
  - Fix `CleanTabProtocol` in `packages/site-clone/src/qa/clean-tab-protocol.ts`:
    - **Truthful Status Tracking**: Track `success` and `restored` as mutable status flags. Execute `action()` in `try`, capture error in `catch`, and in `finally` execute `restored = await this.restoreState(evaluator, snapshot).catch(() => false)`.
    - **Deterministic Probe Inversion**: Retain `CleanTabProtocol` strictly for probe lifecycle management (injected elements `[data-antifan-probe]`, temporary stylesheet tags, and window scroll offsets) where guaranteed, non-destructive inverse operations (`node.remove()`, `window.scrollTo()`) exist.
    - **Prohibition of innerHTML Reversion**: Forbid in-place DOM rollback via `innerHTML` / string assignment, which destroys event listeners, breaks JS framework state, and fails on duplicate or deleted selectors.
  - Update `packages/site-clone/src/qa/clean-tab-protocol.test.ts`:
    - Add explicit assertions `assert.strictEqual(res.restored, true)` when restore succeeds.
    - Add unit test verifying that when `restoreState` fails or evaluator rejects during cleanup, `res.restored` evaluates to `false`.
    - Add unit test verifying probe node cleanup and scroll restoration without persistent document pollution.
  - Implement `packages/site-clone/src/qa/mutation-qa-harness.ts`:
    - **Authoritative Execution Boundary**: Static AST fixtures (`DomTreeParser`) are used exclusively for payload generation, structural AST mutation, and serialization. All authoritative layout assertions (overflow, bounding box collision, intrinsic scaling) MUST execute in real Chromium via the CDP browser evaluator across the 3 required viewports (1440px Desktop, 768px Tablet, 390px Mobile).
    - **Restoration-Failure Injection**: Explicitly tests cleanup resilience by injecting evaluator exceptions during probe removal, asserting that `withReversibleState` truthfully reports `restored: false` and logs diagnostic leak references.
    - **Scenario 1 (Text Stretch)**: Injects 200-character string containing continuous unspaced tokens and Vietnamese diacritics into product cards and headers in live browser. Asserts zero horizontal page overflow ($\text{scrollWidth} - \text{clientWidth} \le 2\text{px}$) and zero overlapping bounding boxes.
    - **Scenario 2 (Cardinality Shift)**: Mutates grid/carousel items to 1 item (asserts single card does not blowout $> 480\text{px}$, navigation controls gracefully hide) and to 11 items (asserts row alignment and flex-wrap stability).
    - **Scenario 3 (Image Ratio Mismatch)**: Mutates product image sources to 1:3 ultra-tall and 3:1 ultra-wide SVGs. Asserts aspect ratio distortion $D \le 0.05$ or computed `object-fit: cover | contain` and container height $> 0$.
    - **Hard Blocker Rules**: Horizontal scrollbar leak ($> 2\text{px}$), `NaN` prices, overlapping text/CTA boxes, and unrendered Liquid markers (`{{` or `{%`) immediately fail the mutation test run.
  - Implement live Chromium runner `scripts/smoke-mutation-qa.cjs`:
    - **Disposable Preview Tab Isolation**: Executes each destructive mutation scenario in a dedicated, disposable preview tab.
    - Spins up a local HTTP server serving baseline and mutant HTML fixtures.
    - Uses AntiFan's established Electron harness via `BrowserControlPort` and `CapabilityCatalogue` directly inside the Electron main process.
    - Applies CDP viewport overrides across all 3 viewports: Desktop (1440x900), Tablet (768x1024), and Mobile (390x844).
    - Executes `MutationQAHarness` via the native tab automation host, capturing real layout overflow (`scrollWidth - clientWidth`), bounding box collisions, and aspect ratio distortion.
    - In `finally`, cleanly closes or reloads the mutated preview tab and verifies against a fresh baseline tab, ensuring zero DOM pollution across runs.
    - Injects restoration failure in `CleanTabProtocol` to assert that `withReversibleState` truthfully reports `restored: false`.
    - Guarantees server shutdown, tab closure, and temporary file cleanup in `finally`.
  - Create unit test suite `packages/site-clone/test/mutation-qa-harness.test.ts` verifying static fixture serialization.
- Non-functional:
  - Zero dependencies added to external NPM libraries.
  - All probe injections must use `CleanTabProtocol.withReversibleState` with guaranteed `[data-antifan-probe]` cleanup.
## Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                   CleanTabProtocol (Fixed)                  │
│  - captureState() -> snapshot (scrollX, scrollY, probes)    │
│  - action() executed inside try                             │
│  - finally: restored = await restoreState() -> truthful bool│
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     MutationQAHarness                       │
│  ├── Scenario 1: Text Stretch (200 chars, break-word check) │
│  ├── Scenario 2: Cardinality Shift (1 item & 11 items)      │
│  └── Scenario 3: Image Ratio Distortion (1:3 & 3:1 SVG)     │
│                                                             │
│  [Hard Blocker Gate Evaluator]                              │
│    • deltaX <= 2px (zero horizontal scrollbar leak)         │
│    • overlapArea == 0px² (zero text/button collision)       │
│    • heightRatio in [0.5, 2.5] (zero blowout or collapse)   │
│    • liquidLeak == 0 (zero {{ or {% visible in text nodes)  │
└─────────────────────────────────────────────────────────────┘
```

## Related Code Files
- Create: `scripts/smoke-mutation-qa.cjs` (Authoritative live Chromium smoke/integration runner)
- Modify: `packages/site-clone/src/qa/clean-tab-protocol.ts` (Fix premature `restored: true` in `withReversibleState` & add journal)
- Modify: `packages/site-clone/src/qa/clean-tab-protocol.test.ts` (Add test coverage for truthful `restored` flag & rollback)
- Create: `packages/site-clone/src/qa/mutation-qa-harness.ts` (Core Mutation QA Harness implementation)
- Create: `packages/site-clone/src/qa/mutation-qa-harness.test.ts` (Unit test for serialization & AST fixtures)
- Modify: `packages/site-clone/src/index.ts` (Export `MutationQAHarness` from package index)

## Implementation Steps
1. In `packages/site-clone/src/qa/clean-tab-protocol.ts`, refactor `withReversibleState` to assign `restored = await this.restoreState(...)` in `finally` and return the finalized state object.
2. In `packages/site-clone/src/qa/clean-tab-protocol.test.ts`, assert `res.restored === true` in existing tests and add a test where `restoreState` throws to verify `res.restored === false`.
3. Implement `packages/site-clone/src/qa/mutation-qa-harness.ts` defining `MutationScenario`, `MutationResult`, and the 3 runner functions (`runTextStretchTest`, `runCardinalityShiftTest`, `runImageRatioTest`).
4. Implement the Hard Blocker evaluation logic verifying horizontal scrollbar delta $\le 2\text{px}$, container height bounding ratios, and zero unparsed Liquid expressions.
6. Export `MutationQAHarness` from `packages/site-clone/src/index.ts`.
7. Implement `scripts/smoke-mutation-qa.cjs` using `BrowserControlPort` inside the Electron runtime, running the 3 mutation scenarios and failure injection across 1440px, 768px, and 390px viewports with guaranteed cleanup in `finally`.
8. Run unit test suite: `npm run test:site-clone` (using workspace root canonical script).
9. Run authoritative live Chromium mutation runner: `npm run compile && node scripts/run-electron.cjs scripts/smoke-mutation-qa.cjs`.

## Success Criteria
- [ ] `CleanTabProtocol.withReversibleState` evaluates `restored` strictly in `finally` and passes all failure-injection unit tests.
- [ ] `MutationQAHarness` successfully executes all 3 mutation scenarios with deterministic pass/fail verdicts.
- [ ] `npm run compile && node scripts/run-electron.cjs scripts/smoke-mutation-qa.cjs` executes in real Chromium across Desktop (1440px), Tablet (768px), and Mobile (390px), asserting $\le 2\text{px}$ overflow and passes with exit code 0.
- [ ] Any horizontal scroll overflow $> 2\text{px}$ or unrendered Liquid syntax triggers a Hard Blocker error.
- [ ] All existing 26 tests + new mutation tests pass cleanly via `npm run test:site-clone`.

## Risk Assessment
- **Risk**: Static AST parsing and CSS approximations cannot compute CSS cascade, web font metrics, flex/grid track sizes, or viewport scrollbar leakage.
  - *Observable Signal*: Static tests pass while the generated theme visibly breaks with horizontal scrollbars or clipped text in real browsers.
  - *Mitigation*: Strictly prohibit static approximations from acting as the pass/fail gate. All layout and reflow verdicts are authoritatively determined by real Chromium CDP evaluation at 1440px, 768px, and 390px viewports.
