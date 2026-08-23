# Phase 2: Window-Scoped Session & IPC Architecture

## Context
In `NativeTabHost`, `TerminalManager.getInstance().on('data')` and `on('session')` broadcast events to renderer views.
`standalone.js` currently expects `state.activeSessionId` from global broadcasts to define its local `activeId`. If two windows are open, when Window 1 switches sessions, a global broadcast would cause Window 2 to switch sessions as well. Furthermore, xterm instances in both windows could simultaneously trigger `resizeTo`, thrashing the PTY columns and rows if the windows have different dimensions.

## Requirements
1. **Multi-Window Data Broadcast**:
   - Broadcast PTY data `{ sessionId, data }` to all active terminal windows in `this.terminalWindows`.
2. **Sender-Aware / Scoped IPC Handlers**:
   - `antifan:terminal:resize-session`: ensure resize requests only update PTY dimensions when triggered from the focused window or when explicitly allowed, with debounced bounds checks.
   - `antifan:terminal:new-window`: IPC endpoint callable from renderer to request creating a new popout window.
   - `antifan:terminal:close-window`: IPC endpoint to close a specific popout window.
3. **Session List Synchronization vs Active Session Isolation**:
   - Session metadata (creation, rename, close, reorder) is synchronized across all windows.
   - Local active/split session selection is managed locally within each window's renderer instance so Window 1 and Window 2 can view different tabs simultaneously.

## Files to Modify
- `src/main/browser/native-tab-host.ts`
- `src/main/browser/terminal-manager.ts` (if needed for sender-aware session queries)
- `src/shared/contracts.ts` (add multi-window IPC channel constants)

## Verification
- Unit test and IPC contract tests confirming multi-window broadcast and sender-aware resize handling.
