---
title: "Phase 3: Native WebContentsView pair and layout"
status: completed
---

# Phase 3: Native WebContentsView pair and layout

## Overview

Create and own the two live native views, attach/detach them with the existing window and tab lifecycle, apply independent device emulation, and fit both rendered surfaces deterministically.

## Requirements

- [x] In split mode create exactly two `WebContentsView`s with the existing `getSecureWebPreferences()` and existing tab session semantics. Do not introduce a new partition or session unless runtime verification proves the current construction cannot share the session.
- [x] Load the current logical URL into both panes through the coordinator; guard initial-load events exactly like later mirror events.
- [x] Extend `updateLayout()` so toolbar, terminal, sidebar, and available content bounds remain correct. Split content must allocate two pane rectangles with a deterministic gap/padding policy, then scale and center each rendered viewport without changing its emulated CSS width/height.
- [x] Preserve the logical tab's existing zoom factor and apply it consistently to both panes. Keep Desktop and Mobile preset IDs independent; fit scale is per-pane rendering geometry only. Use the existing `DEVICE_PRESETS` data and `enableDeviceEmulation`; do not treat a rendered pixel width as the CSS viewport width.
- [x] On disable, detach and destroy only the mirror view, restore the original view's bounds/emulation/zoom, preserve the logical tab ID and session, and avoid duplicate navigation listeners. On tab close, detach/destroy both views and clear all split timers/listeners/transaction state.
- [x] Restore split views without activating intermediate tabs; after all records exist, switch once to the persisted active logical tab and run one authoritative layout/state broadcast.
- [x] Handle window resize, sidebar/terminal/bookmark-bar changes, view destruction, renderer crash, and failed load without orphaning a child view or leaving the toolbar state claiming split is live.

## Implementation Steps

1. Add a per-tab split view record with `desktopView`, `mobileView`, pane metadata, listener disposers, and lifecycle state; reuse existing tab map ownership.
2. Refactor view event wiring into a helper that receives pane identity and routes title/favicon/loading/URL/history/diagnostics/document-generation behavior to the logical tab without double-recording history.
3. Add pure geometry calculation: available content rectangle → two logical pane slots → each preset’s fit scale → centered rendered bounds. Handle narrow windows deterministically (minimum pane size or explicit overflow policy) and test zero/one/two-pane boundaries.
4. Update attach/remove paths in `createTab`, `switchTab`, `closeTab`, and layout. Ensure hidden tabs have no visible child panes and the active logical tab is the only tab represented.
5. Verify session sharing empirically with a local test page: cookie/localStorage mutation is visible across panes, while independent form value, scroll, and focus checks remain independent. Assert the same navigation/security guards as single-view tabs; shared session behavior is intentional, not an isolation guarantee.

## Todo

- [x] Implement paired view creation and listener disposal.
- [x] Implement split geometry, emulation, centering, and resize updates.
- [x] Implement enable/disable/close/crash cleanup and legacy single-view fallback.

## Success Criteria

Electron smoke evidence shows two live panes, correct CSS viewport dimensions, independent interaction/scroll/focus, shared session mutation, correct resizing, and no duplicate child views or leaked listeners after toggling and closing.
