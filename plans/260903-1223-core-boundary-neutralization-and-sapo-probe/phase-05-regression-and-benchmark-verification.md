---
phase: 5
title: "Regression & Benchmark Verification"
status: completed
priority: P1
effort: "45m"
dependencies: [1, 2, 3, 4]
---

# Phase 5: Regression & Benchmark Verification

## Overview
Perform comprehensive verification across all layers of the AntiFan repository: TypeScript static type analysis, all 72 unit tests across root and `packages/site-clone`, execution of the Sapo Canary Probe, and the live Chromium Electron Mutation QA runner across Desktop, Tablet, and Mobile viewports to verify zero regressions.

## Requirements
- **Functional:**
  - TypeScript Typecheck: `tsc -p packages/site-clone --noEmit` and `npm run typecheck` (or `tsc -p . --noEmit`) must exit `0` with 0 errors.
  - Package Unit Tests: `npm run test:site-clone` must pass all 39 test suites with 0 failures.
  - Root Unit Tests: `npm run test:unit` must pass all 33 test suites with 0 failures.
  - Architectural Probe: `npx tsx scripts/probes/sapo-boundary-probe.ts` must report 5/5 PASSED.
  - Live Browser Mutation QA: `npx electron scripts/smoke-mutation-qa.cjs` must report:
    - Desktop (1440x900): 5/5 scenarios PASS, 0px overflow leak.
    - Tablet (768x1024): 5/5 scenarios PASS, 0px overflow leak.
    - Mobile (390x844): 5/5 scenarios PASS, 0px overflow leak.
    - CleanTabProtocol: 0 residual DOM leaks, clean memory state.
- **Non-functional:**
  - Zero unhandled rejections, zero orphaned background worker processes.

## Architecture
```text
Verification Pyramid:
  Level 1: Static Typecheck (TypeScript Compiler)
  Level 2: Unit Test Suite (72 Unit Tests: Root + Site-Clone)
  Level 3: Architectural Boundary Probe (Sapo 5-Case Stress Test)
  Level 4: Live Chromium Runtime Telemetry (Electron Smoke Mutation QA)
```

## Related Code Files
- Verify: `src/main/tools/browser-capabilities.ts`
- Verify: `packages/site-clone/src/models/clone-ir.ts`
- Verify: `packages/site-clone/src/models/state-synthesizer.ts`
- Verify: `scripts/probes/sapo-boundary-probe.ts`
- Verify: `scripts/smoke-mutation-qa.cjs`

## Implementation Steps
1. Run static type analysis:
   ```bash
   tsc -p packages/site-clone --noEmit
   tsc -p . --noEmit
   ```
2. Run unit test suite:
   ```bash
   npm run test:site-clone
   npm run test:unit
   ```
3. Run the Sapo Canary boundary probe:
   ```bash
   npx tsx scripts/probes/sapo-boundary-probe.ts
   ```
4. Run live Electron smoke mutation QA:
   ```bash
   npx electron scripts/smoke-mutation-qa.cjs
   ```
5. Inspect `git status` to ensure all staged and unstaged files are clean and intentional.

## Success Criteria
- [x] 0 TypeScript errors across the entire monorepo.
- [x] 72/72 unit tests pass (39 in site-clone, 33 in core).
- [x] 5/5 Sapo Canary probe scenarios pass.
- [x] 15/15 live Electron mutation QA scenarios pass with 0px overflow leak.
- [x] CleanTabProtocol confirms 0 residual DOM modifications.

## Risk Assessment
- **Risk:** Electron runner might encounter display server issues on low-spec or headless sessions.
  - **Observable Signal:** `Electron failed to initialize window` or timeout after 30s.
  - **Mitigation:** Use existing headless fallback flags (`ELECTRON_RUN_AS_NODE=0`, software rendering fallback) proven in earlier test runs.
