# Implementation Plan: Browser Native Keyboard Press Slice

**Status:** COMPLETED
**Goal:** Deliver a robust vertical slice for native browser keyboard press emulation via Electron's `webContents.sendInputEvent` with centralized key/modifier normalization, validation, capability registration, and test coverage.

## Summary of Completed Changes
1. **Centralized Normalizer (`src/main/browser/keyboard-normalizer.ts`)**:
   - `normalizeKey`: Supports all named keys (`Enter`, `Return`, `Escape`, `Esc`, `Tab`, `Backspace`, `Delete`, `Arrow*`, `Home`, `End`, `Page*`, `Space`, `F1-F12`) and alphanumeric/printable characters case-insensitively.
   - `normalizeModifiers`: Maps human aliases (`ctrl`, `cmd`, `win`, `opt`) to strict Electron modifiers (`control`, `shift`, `alt`, `meta`), deduplicates, and throws on unknown modifiers.
   - `buildKeyboardInputEvents`: Emits `keyDown` -> conditional `char` (only for printable characters without `ctrl`/`meta` shortcut modifiers) -> `keyUp`.
2. **NativeTabHost (`src/main/browser/native-tab-host.ts`)**:
   - Implemented `sendKeyboardPress({ key, modifiers, tabId })`.
   - Auto-switches and focuses target tab before dispatch.
   - Guaranteed cleanup via `finally` block: if `keyDown` succeeds and an error occurs before `keyUp` is sent, `keyUp` is automatically dispatched in the finally block to prevent stuck keys.
3. **BrowserControlPort & Capabilities (`src/main/tools/browser-control-port.ts`, `src/main/tools/browser-capabilities.ts`)**:
   - Implemented `keyboardPress` in `BrowserControlPort` with target resolution and error mapping.
   - Registered `browser.keyboard-press` (risk: `write`) and alias `antifan_keyboard_press`.
   - Wired in `src/main/index.ts` production binding.
4. **MCP Server (`src/main/mcp/mcp-server.ts`)**:
   - Registered `antifan_keyboard_press` tool in MCP `tools/list` schema.
   - Implemented tool call handler in `tools/call` routing to `tabHost.sendKeyboardPress`.
5. **Unit & Capability Catalogue Tests (`test/main/keyboard-press.test.ts`, `test/main/capability-catalogue.test.ts`)**:
   - 20 unit tests across key normalizer, modifier mapping, event generation, port validation, capability policy, and alias routing.
   - Focused slice verification: 20/20 passing in `test/main/keyboard-press.test.ts` and `test/main/capability-catalogue.test.ts`.
   - Typecheck: 0 compiler errors via `npm run typecheck`.
   - Broader-suite note: Repository-wide `npm test` was blocked by a pre-existing timeout in `terminal-switching-regression.test.js` (Windows ConPTY process teardown), unrelated to the keyboard-press implementation.
