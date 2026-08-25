---
title: "Phase 4: Toolbar controls and target semantics"
status: completed
---

# Phase 4: Toolbar controls and target semantics

## Overview

Expose split mode through the existing toolbar without destabilizing the tab strip, and make pane focus/target behavior explicit for humans, inspection, screenshots, and BrowserControlPort/MCP actions.

## Requirements

- [x] Add a compact split toggle plus independent Desktop/Mobile preset controls using existing toolbar HTML/CSS/renderer patterns. The controls must show disabled/failed/loading states and remain usable at narrow toolbar widths.
- [x] Preserve existing omnibox, back, forward, reload, stop, zoom, bookmark, terminal, sidebar, and tab behavior. Toolbar navigation addresses the logical tab and uses the contract’s authority pane; it must not silently navigate only whichever renderer last emitted an event.
- [x] Track the focused pane from real view focus/click semantics and expose a deterministic fallback when focus is unavailable. A pane click/focus updates the active target for inspect/screenshot/agent actions but does not switch the logical tab or synchronize DOM state.
- [x] Route screenshot, DOM, inspect, element picker, keyboard, agent, and eval actions to the focused pane internally. Existing `BrowserTarget.tabId`, `browserEpoch`, and one logical `documentGeneration` remain valid; unspecified pane target resolves to focused pane, then authority pane. Do not add a public pane field unless an external capability requires it.
- [x] Inspect and agent coordinate actions must convert from window/rendered bounds to the selected pane's emulated coordinate space; DOM selector/type/scroll operations must execute only in the selected pane's renderer.
- [x] Update initial state/state-updated payloads and preload declarations only where required. Keep IPC channel names stable where possible; additive channels must have typed payloads and sender validation consistent with existing code.

## Implementation Steps

1. Add toolbar DOM controls and styles beside the existing device/zoom group; avoid duplicating preset data in renderer code.
2. Extend `toolbar-preload.ts`, renderer API declarations, and main IPC handlers with typed split operations and pane selection/status.
3. Extend `BrowserHostPort`/`BrowserControlPort` only if an external tool truly needs explicit pane selection; otherwise keep pane selection internal to the active target and preserve the public contract.
4. Audit `src/main/tools/browser-capabilities.ts` and aliases for schema parity if `paneId` becomes public; update tests for explicit and omitted pane behavior, stale targets, and malformed pane IDs.
5. Verify target switching by clicking each pane, then run screenshot/DOM/agent/inspect actions and prove sibling state is untouched.

## Todo

- [x] Add split toolbar state/control IPC and renderer wiring.
- [x] Implement focused-pane target resolution and coordinate conversion.
- [x] Define and test tool artifact semantics for one pane versus split mode.

## Success Criteria

Toolbar users can enable/disable split, select Desktop and Mobile presets independently, navigate/reload through the logical tab, and interact with either live pane. Existing MCP/BrowserTarget calls continue to pass contract validation and target the focused pane deterministically.
