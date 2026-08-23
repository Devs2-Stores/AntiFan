# Phase 4: Verification & Test Suite

## Context
Validate that multi-terminal windows work end-to-end, pass TypeScript typechecking, pass all existing tests, and add dedicated unit/contract tests for multi-window registry and IPC routing.

## Requirements
1. **TypeScript Typecheck**:
   - `npm run typecheck` (`tsc -p ./ --noEmit`) passes with 0 errors.
2. **Unit & Contract Test Additions**:
   - Add unit tests verifying multi-window registration, broadcast to multiple window targets, and window bounds retrieval.
3. **Full Test Suite**:
   - `npm test` passes all test suites.
4. **Advisory Final Review**:
   - Spawn KongMing advisory subagent to review the full implementation diff, architectural invariants, and report outcomes.

## Files to Modify/Add
- `test/main/multi-terminal-window.test.ts` (new)
- `test/main/*.test.ts` (existing tests)

## Acceptance
- 100% green tests across all suites.
- Verified safe window lifecycle and bounds persistence across multiple monitors.
