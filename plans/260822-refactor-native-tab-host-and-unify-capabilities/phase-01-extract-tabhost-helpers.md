# Phase 1: Extract helper modules from NativeTabHost

## Context
`NativeTabHost` currently stands at 3,062 lines, combining window layout, tab lifecycle, context menus, diagnostics, zoom, and bookmark handling.

## Requirements
1. Create `src/main/browser/tab-diagnostics.ts`:
   - Store and retrieve console logs and network failure records per tab.
   - Support level filtering and memory bounding (max 200 items per ring buffer).
2. Create `src/main/browser/tab-zoom-controller.ts`:
   - Handle tab zoom levels, app zoom levels, bounds calculation with zoom offsets.
3. Create `src/main/browser/tab-context-menu.ts`:
   - Construct tab and page context menus with standard Electron `Menu`/`MenuItem` templates.
4. Create `src/main/browser/tab-bookmarks-manager.ts`:
   - Manage bookmarks loading, persistence to `bookmarks.json`, adding, editing, and deleting.
5. Integrate these helper classes into `NativeTabHost`, keeping all existing methods (`getDiagnostics`, `setZoomFactor`, `showContextMenu`, `addBookmark`, etc.) as thin delegations.

## Verification
- `npm run typecheck` passes.
- `npm test` passes (specifically `action-registry.test.ts`, `contracts.test.ts`, `terminal-switching-regression.test.ts`).
