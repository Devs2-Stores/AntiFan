# Phase 3: Validate contracts, test suite & regression checks

## Context
Ensure all refactorings preserve every contract, invariant, and performance metric without regressions.

## Requirements
1. Run full typecheck and unit test suites: `npm run verify`.
2. Run vertical slice integration tests: `node --test .compiled/test/integration/*.test.js`.
3. Verify line counts and modular structure of `NativeTabHost`.
4. Ensure no unhandled exceptions or memory leaks in lifecycle.

## Verification
- 100% tests passing (≥ 59 unit tests, 1 vertical slice integration test).
- Zero TypeScript errors.
