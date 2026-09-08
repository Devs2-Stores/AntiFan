---
phase: 1
title: "Core Test Contract Hardening & Height Drift Assertion"
status: complete
priority: P1
effort: "2h"
dependencies: []
---

# Phase 1: Core Test Contract Hardening & Height Drift Assertion

## Overview
Re-lock the visualCompare test contract to guarantee exact ledger matching without brittleness, and add rigorous unit test coverage for `heightTolerance` and `allowHeightDrift` parameters.

## Requirements
- Functional:
  - Export `defaultStorefrontWidgets` from `src/main/tools/browser-control-port.ts` as the single authoritative source of truth.
  - Assert exact ledger count in test `V-11`: `entries.length === defaultStorefrontWidgets.length + 1`, with `.badge` resolved and all 30 storefront widgets marked `missing-optional`.
  - Assert that broad selector `iframe[id]` is NOT in the ledger when user masks are present.
  - Assert exact `deepEqual` on `optionalUnmatched`: `assert.deepEqual(unmatched, [...defaultStorefrontWidgets, ...userOptional])`.
  - Parameterize mock host PNG generator to allow custom height per tab so height truncation gates can be triggered deterministically in tests.
  - Add 3 dedicated unit tests:
    1. Default (no params): height delta > 10% returns `STRUCTURAL_TRUNCATION_DETECTED` with `match: false`.
    2. `heightTolerance: 0.5`: height delta 30% passes truncation gate.
    3. `allowHeightDrift: true`: bypasses truncation gate, proceeds to pixel diff, records layout metrics.
- Non-functional: Zero regressions across all 53 existing visual-compare tests.

## Related Code Files
- Modify: `src/main/tools/browser-control-port.ts`
- Modify: `test/main/visual-compare-mask-ledger.test.ts`

## Implementation Steps
1. Export `defaultStorefrontWidgets` from `browser-control-port.ts`.
2. Update `buildMockHost` in `test/main/visual-compare-mask-ledger.test.ts` with `pngDimensionsForTab?: (tabId: string) => { width: number; height: number }`.
3. Tighten `V-11` assertions to exact count and verify absence of `iframe[id]`.
4. Re-lock `optional zero-match records optionalUnmatched` to exact `deepEqual`.
5. Implement the 3 unit tests for height tolerance and drift in a new `describe('visualCompare structural height drift & truncation controls')` block.
6. Verify with `npx tsx --test test/main/visual-compare-mask-ledger.test.ts` and `npx tsc -p .`.

## Success Criteria
- [ ] `defaultStorefrontWidgets` is exported and consumed by tests.
- [ ] `V-11` asserts exact 31 entries, contains `.badge`, does NOT contain `iframe[id]`.
- [ ] `optional zero-match` asserts exact `deepEqual` against deterministic mock output.
- [ ] 3 new tests for `heightTolerance` and `allowHeightDrift` pass and prove gate behavior.
- [ ] 100% tests in `test/main/visual-compare-mask-ledger.test.ts` pass.

## Risk Assessment
- Risk: Mock host PNG dimension alteration breaks unrelated tests expecting 800x600.
- Mitigation: Default `pngDimensionsForTab` to `{ width: 800, height: 600 }` when unspecified.
