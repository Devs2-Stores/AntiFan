# Phase 3: Renderer Multi-Window UI

## Context
`src/renderer/standalone.html` and `src/renderer/standalone.js` render the terminal, tabs, AI chat, and controls.
`standalone.js` needs to support window-scoped session selection, the "New Window" action, and focus-aware fitting.

## Requirements
1. **Window-Scoped Active Session State**:
   - `standalone.js` tracks its local `activeId` without forcefully overriding it when another window switches its active session.
   - When a session is closed/deleted globally, if it was the local `activeId`, gracefully fallback to the nearest available session in that window.
2. **New Window UI Control & Shortcut**:
   - Add a "New Window" button (e.g. `btnNewTerminalWindow` in `standalone.html` header and tab bar).
   - Add shortcut `Ctrl + Shift + N` / `Cmd + Shift + N` to spawn a new floating terminal window.
3. **Focus-Aware Resizing**:
   - On `window.on('focus')` or `resize`, fit the local active terminal and issue `api.resizeSession(activeId, cols, rows)`.
4. **Preload API Expansion**:
   - Update `src/preload/standalone-preload.ts` to expose `openNewWindow: () => Promise<boolean>` and `closeCurrentWindow: () => Promise<boolean>`.

## Files to Modify
- `src/renderer/standalone.html`
- `src/renderer/standalone.js`
- `src/preload/standalone-preload.ts`
- `src/preload/toolbar-preload.ts` (if toolbar exposes popout menu)

## Verification
- UI buttons and shortcuts render cleanly and trigger window creation.
- Two windows show independent active session selections without cross-interference.
