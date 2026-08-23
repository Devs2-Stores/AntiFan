# Phase 03: Tests and Verification

## Context
- Files to create/update:
  - `test/main/terminal-process-tree-and-links.test.ts` (new test suite)
  - `test/main/terminal-switching-regression.test.ts`

## Requirements
1. Unit test `killProcessTree` and `safelyKillSession` in `TerminalManager`:
   - Verify non-throwing execution with valid and invalid PIDs.
   - Verify session disposal flags and session map cleanup.
2. Contract test for `standalone.html`, `standalone.js`, and `standalone-preload.ts`:
   - Verify `standalone.html` includes `@xterm/addon-web-links`.
   - Verify `standalone.js` attaches `WebLinksAddon` and hooks up link opening handler.
   - Verify `standalone-preload.ts` exports `createTab` and `openExternal`.
3. Run full verification:
   - `npm run typecheck`
   - `npm test`
