---
phase: "05"
title: "Release Verification & Smoke Suite"
status: pending
priority: P1
effort: "2h"
dependencies: ["01", "02", "03", "04"]
---

# Phase 05: Release Verification & Smoke Suite

## Overview
Perform end-to-end verification of the automated Theme QA gate against live packaged application fixtures, ensure zero regressions across the entire 228+ test suite, write an automated smoke test script (`smoke-theme-qa-gate.cjs`), and update architecture documentation.

## Requirements
- **Automated Smoke Test (`scripts/smoke-theme-qa-gate.cjs`)**:
  - Spin up local Haravan, Sapo, and Shopify theme preview mock servers.
  - Launch packaged AntiFan executable or dev harness.
  - Execute full QA validation via authenticated Bridge WebSocket / MCP.
  - Verify that:
    1. Liquid error text (`Liquid error: snippet missing`) is caught and reported.
    2. Horizontal overflow (`.oversized-banner` with `width: 2000px`) is detected on mobile 393px with exact bounding box.
    3. Broken image (`<img src="non-existent.jpg">`) is flagged.
    4. Valid clean storefront passes all gates with `passed: true`.
- **Full Test Suite & Typecheck**:
  - `npm run typecheck` passes with zero errors.
  - `npm test` passes 100% across all unit, contract, and integration suites ($\ge 235$ tests).
- **Documentation Updates**:
  - Update `AntiFan-Final-Focused-Report-278.md` with the finalized Theme QA architecture.
  - Update `docs/operations.md` with instructions for running Theme QA validation.

## Related Code Files
- Create:
  - `scripts/smoke-theme-qa-gate.cjs`
- Modify:
  - `AntiFan-Final-Focused-Report-278.md`
  - `docs/operations.md`
- Verify:
  - All test files in `test/main/` and `test/integration/`

## Implementation Steps
1. Create `scripts/smoke-theme-qa-gate.cjs` setting up mock e-commerce storefront fixtures with deliberate Liquid errors, broken images, and overflow elements.
2. Run the smoke test and verify structured report emission.
3. Run `npm run verify` (`typecheck` + `test`).
4. Update `AntiFan-Final-Focused-Report-278.md` and `docs/operations.md` to reflect the new capabilities.

## Success Criteria
- [ ] `node scripts/smoke-theme-qa-gate.cjs` passes end-to-end in $< 10\text{s}$.
- [ ] `npm test` passes all tests with zero failures.
- [ ] Documentation accurately describes the new verification capabilities.

## Risk Assessment
- **Risk:** Port collisions during mock preview server startup in CI/local runs.
- **Mitigation:** Bind mock servers to port `0` (ephemeral random free port assignment).
