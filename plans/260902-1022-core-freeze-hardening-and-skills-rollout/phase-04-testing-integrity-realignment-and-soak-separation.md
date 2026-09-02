---
phase: 4
title: "Testing Integrity Realignment & Soak Gate Separation"
status: pending
priority: P1
effort: "45m"
dependencies: [3]
---

# Phase 4: Testing Integrity Realignment & Soak Gate Separation

## Overview
Reclassify test files to strictly separate fast Unit-level In-Memory Simulations from Authoritative Live OS Release Evidence Gates, eliminating any false-confidence artifacts.

## Requirements
- Clarify `test/e2e/soak-test.test.ts` as a mathematical unit simulation testing the linear regression memory slope formula ($\beta = \text{Cov}(t, \text{RAM}) / \text{Var}(t)$) and schema structure, rather than claiming live process telemetry.
- Formally document `scripts/benchmark-standalone-recovery.cjs` and `scripts/benchmark-real-soak-8h.cjs` as the sole Authoritative Release Evidence Gates for OS process tree tracking and Zero-Orphan verification.
- Update `package.json` test scripts if needed to ensure all relevant test runners are discovered.

## Architecture
```text
Test Harness Separation:
  ├─ Layer A: Unit / Fast CI (<1s)
  │    └─ test/e2e/soak-test.test.ts (Slope formula math & report schema unit test)
  │
  └─ Layer B: Authoritative Release Evidence Gates (Live OS Runtime)
       ├─ scripts/benchmark-standalone-recovery.cjs (30m Recovery & Zero-Orphan Gate)
       └─ scripts/benchmark-real-soak-8h.cjs (8h Production Endurance Gate)
```

## Related Code Files
- Modify/Document: `test/e2e/soak-test.test.ts`
- Inspect: `scripts/benchmark-standalone-recovery.cjs`
- Inspect: `package.json`

## Implementation Steps
1. Add explicit file header and test descriptions to `test/e2e/soak-test.test.ts` explaining its role as an in-memory mathematical simulation.
2. Ensure standalone runners are referenced in documentation as the release gates.
3. Run full test suite: `npm test`.

## Success Criteria
- [ ] Zero confusion between simulated unit tests and live multi-process telemetry.
- [ ] All unit and integration test suites pass with 100% green status.

## Risk Assessment
- Risk: CI pipelines expecting 8h soak in `npm test`.
- Mitigation: Long endurance runs are intentionally separate scripted benchmarks (`npm run benchmark:soak-8h`).
