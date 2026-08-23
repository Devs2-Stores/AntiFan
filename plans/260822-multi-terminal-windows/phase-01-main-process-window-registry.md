# Phase 1: Main Process Window Registry

## Context
Currently, `NativeTabHost` in `src/main/browser/native-tab-host.ts` holds a single `private terminalWindow: BrowserWindow | null = null`. Calling `openTerminalPopoutWindow()` checks if that single window exists and focuses it, preventing users from opening additional terminal windows.

## Requirements
1. Replace single `terminalWindow` with a multi-window registry:
   - `private terminalWindows = new Map<string, { window: BrowserWindow; windowState: WindowStateManager }>()`.
2. Support `openTerminalPopoutWindow(targetSessionId?: string): { windowId: string; window: BrowserWindow }` to create new or focus existing windows.
3. Manage per-window state file paths dynamically (e.g. `terminal-window-state-${index}.json` or structured multi-window state manifest) with `WindowStateManager`.
4. Ensure global shortcut handlers (`setupGlobalShortcutsOnView`) and window lifecycle events (`close`, `closed`) correctly clean up the specific entry from `this.terminalWindows` and re-dock/re-evaluate `isSidebarOpen` only when all popout windows are closed.
5. Provide helper methods: `getTerminalWindows()`, `getTerminalWindowCount()`, `isAnyTerminalPopoutOpen()`.

## Files to Modify
- `src/main/browser/native-tab-host.ts`
- `src/main/browser/window-state.ts` (if needed for multi-window index resolution)

## Verification
- Can spawn 2+ distinct `BrowserWindow` instances.
- Closing one window removes only its registry entry.
