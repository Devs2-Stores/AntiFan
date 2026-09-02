---
phase: 1
title: "Test Suite Segmentation & Fast CI Gates"
status: ready
priority: P0
effort: "30m"
dependencies: []
---

# Phase 1: Test Suite Segmentation & Fast CI Gates

## 1. Overview
The monolithic `npm test` script currently bundles fast in-memory unit tests, integration contracts, and multi-process live Electron Chromium E2E benchmarks into a single command. On local Windows 11 development machines, spawning multiple full Chromium instances concurrently hits the 300-second execution threshold, blocking deterministic CI validation.

This phase segments the test harness into 3 tiered execution lanes:
1. `npm run test:fast`: Pure in-memory unit tests (<15s).
2. `npm run test:integration`: Control plane, transport, ledger, and security contract tests (<45s).
3. `npm run test:e2e`: Dedicated live Electron Chromium E2E tests with independent per-test timeouts.

## 2. Requirements
- Modify `package.json` scripts to declare `test:fast`, `test:integration`, `test:e2e`, and update `test` to run layered execution.
- Ensure all non-E2E tests pass 100% deterministically in under 60 seconds total.
- Verify `npm run typecheck` remains exit code 0.

## 3. Architecture & Segmentation Mapping
```text
npm run test
  ├─ Layer 1: npm run test:fast (<15s)
  │    ├─ .compiled/test/unit/**/*.test.js
  │    ├─ .compiled/test/e2e/soak-test.test.js (Slope math unit test)
  │    └─ .compiled/test/main/semantic-ref-contract-characterization.test.js
  │
  ├─ Layer 2: npm run test:integration (<45s)
  │    ├─ .compiled/test/main/capability-catalogue.test.js
  │    ├─ .compiled/test/main/security-policy.test.js
  │    ├─ .compiled/test/main/workflow-engine.test.js
  │    └─ .compiled/test/integration/*.test.js
  │
  └─ Layer 3: npm run test:e2e (Dedicated runner)
       ├─ .compiled/test/e2e/mcp-industrial-overhaul.test.js
       └─ .compiled/test/e2e/playwright-parity.test.js
```

## 4. Related Code Files
- Modify: `package.json`
- Inspect: `test/main/*.test.ts`
- Inspect: `test/unit/**/*.test.ts`

## 5. Implementation Steps
1. Inspect `package.json` test scripts.
2. Add granular test scripts targeting specific compiled test patterns.
3. Execute `npm run test:fast` and verify all unit tests pass with zero timeout.
4. Execute `npm run test:integration` and confirm control plane contracts pass cleanly.

## 6. Success Criteria & Verification
- [ ] `package.json` contains segmented scripts: `test:fast`, `test:integration`, `test:e2e`.
- [ ] `npm run test:fast` executes in $<15\text{s}$ with 100% pass.
- [ ] `npm run test:integration` executes in $<45\text{s}$ with 100% pass.
- [ ] Total fast verification time $<60\text{s}$.
