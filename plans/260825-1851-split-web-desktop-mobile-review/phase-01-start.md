---
title: "Phase 1: Start"
status: completed
---

# Phase 1: Start

## Overview

Lock the split-view contract and resolve the only implementation-order hazard: the pending NativeTabHost extraction plan also edits the host lifecycle file. This phase produces no source changes.

## Requirements

- [x] Confirm the implementation uses two live `WebContentsView`s in the existing tab/session, not snapshots, cloned SPA state, or separate sessions.
- [x] Establish serialized ownership with `plans/260822-refactor-native-tab-host-and-unify-capabilities/`; one plan must land or explicitly reserve the host integration boundary before implementation starts.
- [x] Verify Electron 43 type declarations cover the required `WebContentsView`, `WebPreferences.session`, `enableDeviceEmulation`, bounds, focus, and destruction APIs; any mismatch blocks implementation until the design is adjusted.

## Implementation Steps

1. Read the current NativeTabHost refactor result if it changes before implementation; remap phase files to the resulting helper boundaries without changing this product contract.
2. Keep the logical tab ID and BrowserTarget stable; define pane IDs as internal state only unless a later contract change is explicitly accepted.
3. Treat the main process as authoritative for split enabled state, pane presets, logical URL, navigation transaction/loop guard, and runtime-only focused pane; persistence is authoritative only for the durable split configuration and must not store focus.
4. Record the unresolved Electron runtime checks as smoke-test gates rather than silently assuming type declarations imply runtime parity.

## Todo

- [x] Lock host-file ownership and refactor-plan sequencing.
- [x] Record verified Electron API surface and runtime kill-tests:
  1. Gate 1 (Lifecycle): Paired `WebContentsView` instances attached via `contentView.addChildView` render simultaneously without session conflict.
  2. Gate 2 (Emulation): Independent `enableDeviceEmulation` on desktop and mobile viewports with fit-to-view bounds.
  3. Gate 3 (Navigation Loop Guard): Transaction coordinator suppresses mirror echo loops on `did-navigate` / `did-navigate-in-page`.
  4. Gate 4 (Session Sharing): Cookies/storage shared via common session without DOM/scroll/focus leakage.
  5. Gate 5 (Cleanup): Disable/close detaches and destroys mirror view cleanly without listener leak.

## Success Criteria

The implementation team has a single owner for `native-tab-host.ts`, a stable split state contract, and explicit runtime checks for every Electron API assumption. No source implementation begins while the host-file ownership is ambiguous.
