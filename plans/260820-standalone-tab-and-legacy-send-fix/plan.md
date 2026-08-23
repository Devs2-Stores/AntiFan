---
name: standalone-tab-and-legacy-send-fix
status: active
---

# Standalone Tab and Legacy Send Fix

## Outcome

Expose the existing standalone control-plane capability as a separate app tab while preserving the legacy Antigravity chat tab, and repair the legacy send failure path.

## Scope

- Add a renderer tab switcher and standalone view.
- Reuse existing control-plane/run/session contracts; do not duplicate backend state.
- Preserve legacy Antigravity UI and routing as a separate tab.
- Trace and fix the legacy send/receipt error path with exact user-visible errors.

## Non-goals

- No browser tab redesign.
- No store/theme data changes.
- No replacement of the existing Antigravity bridge.

## Phases

1. Add tab state and standalone renderer/preload IPC surface.
2. Render project/workspace/chat/run/receipt summary from existing backend state.
3. Fix legacy send failure mapping and retry-safe state updates.
4. Verify typecheck, desktop tests, build, and both tab paths.

## Acceptance criteria

- App exposes `Standalone` and `Antigravity` tabs.
- Switching tabs preserves each view's state.
- Standalone tab shows real project/workspace/run data, not placeholder fixtures.
- Legacy send no longer remains stuck with an opaque `Lỗi gửi`; it shows the bound error and receipt state.
- Existing browser and Antigravity contracts remain compatible.
