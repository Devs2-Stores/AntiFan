---
title: "Split Web Desktop Mobile Review"
description: "Add a live, same-session Desktop + Mobile WebContentsView review mode with independent interaction and synchronized navigation."
status: completed
priority: P1
effort: "2-4 days"
tags: [electron, browser, responsive, review]
created: 2026-08-25
branch: main
---

# Split Web Desktop Mobile Review

## Overview

Add a reversible split review mode to the existing Electron browser surface. One logical browser tab owns two live `WebContentsView` instances: Desktop and Mobile. They share the existing tab/session identity and URL, but retain independent renderer DOM, focus, form values, scroll position, and user interaction. Main-process state remains authoritative; toolbar controls and existing BrowserControlPort/MCP paths remain compatible.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Render one logical tab as two live native views using independent Desktop and Mobile presets. | P1 |
| 2 | Keep both views on the same committed URL and synchronize explicit navigation, back, forward, and reload without loops. | P1 |
| 3 | Preserve independent click, input, form, scroll, focus, DOM, screenshot, and inspect behavior per pane. | P1 |
| 4 | Fit both rendered panes inside the available content area while keeping each emulated viewport at its real preset dimensions. | P1 |
| 5 | Persist only durable split configuration and restore it without cloning transient page state. | P1 |

## Non-goals and scope boundary

- No snapshot-only or screenshot composition mode.
- No SPA-state cloning, replay, cross-pane scroll synchronization, or shared DOM.
- No new Electron session/partition; both views use the existing tab session and secure web preferences.
- No independent tab identity exposed to the existing tab strip or BrowserTarget contract.
- No broad redesign of MCP capabilities, capsule preview semantics, or the pending NativeTabHost helper extraction.
- No Haravan/HRV CLI or deployment work.

## Architecture decision

### Hypotheses considered

1. **Host-native pair (recommended):** extend `NativeTabHost` with a per-tab split state and two child `WebContentsView`s. Reuse the existing `createTab`, navigation event, `updateLayout`, device emulation, target resolution, screenshot, inspect, persistence, and close/switch paths. This has the fewest new ownership boundaries because those responsibilities already live in the host.
2. **Standalone split controller:** add a `SplitWebReviewController` that owns the pair and is called by `NativeTabHost`. This gives a smaller host eventually, but currently duplicates or cross-calls the host’s child-view lifecycle, navigation hooks, persistence, and active-target semantics. It is the safer follow-up only after `260822-refactor-native-tab-host-and-unify-capabilities` extracts stable seams.

The recommended option is host-native pair integration now, with pure geometry/synchronization helpers kept local or extracted only when they remove concrete complexity. The pending NativeTabHost refactor is a dependency boundary: do not run two agents editing `native-tab-host.ts`; if that refactor lands first, rebase the affected phase against its resulting helper APIs.

## Invariants ledger

- **Preserves:** existing tab IDs, tab strip behavior, secure preferences, existing session/cookies, capsule watcher ownership, BrowserTarget targeting, single-view mode, toolbar navigation contracts, and current persisted tab URLs.
- **Deliberately changes:** a tab in split mode has two visible renderer surfaces; device preset state becomes `{ desktopPresetId, mobilePresetId }` while legacy single preset data remains readable.
- **Risks:** two renderers can emit navigation events for one logical tab; a shared session can expose cookies/storage mutations across panes; Electron device emulation plus scaled bounds may differ by version; inspect/agent coordinates may target the wrong pane; persistence can accidentally encode transient page state.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Start](./phase-01-start.md) | Completed |
| 2 | [Phase 2: Split state and synchronization contract](./phase-02-split-state-and-synchronization-contract.md) | Completed |
| 3 | [Phase 3: Native WebContentsView pair and layout](./phase-03-native-webcontentsview-pair-and-layout.md) | Completed |
| 4 | [Phase 4: Toolbar controls and target semantics](./phase-04-toolbar-controls-and-target-semantics.md) | Completed |
| 5 | [Phase 5: Tests and Electron smoke verification](./phase-05-tests-and-electron-smoke-verification.md) | Completed |
## Dependencies

- Existing `NativeTabHost` remains the main-process authority.
- Existing `DEVICE_PRESETS`, `getSecureWebPreferences()`, toolbar IPC, `BrowserControlPort`, and `BrowserTarget` contracts are reused.
- Coordinate with `plans/260822-refactor-native-tab-host-and-unify-capabilities/`; shared host-file edits must be serialized.
- Electron API assumptions must be validated by compile plus a real Electron smoke run before implementation is considered complete.

## Success Criteria

- [x] Split mode creates exactly two live `WebContentsView`s for one logical tab, attaches them to the existing window, and disposes both on disable/close.
- [x] Desktop and Mobile presets are independently selectable and rendered side by side with a deterministic fit/scale/center algorithm; emulated CSS viewport dimensions remain the selected preset dimensions.
- [x] A user or toolbar navigation committed in either pane updates the logical URL and brings the other pane to the same URL exactly once; stale/duplicate events do not create navigation loops.
- [x] Back, forward, reload, and omnibox navigation have explicit pane authority and deterministic behavior documented in the contract; history buttons expose the logical tab’s state.
- [x] Click, type, form submission, scroll, focus, DOM snapshot, screenshot, inspect, and agent actions can target a pane without mutating the sibling pane’s renderer state; default target remains the focused/active pane.
- [x] Existing BrowserTarget/MCP calls remain valid; optional pane targeting is additive and stale target rejection remains intact.
- [x] Persisted data restores split enabled state and preset IDs only; no serialized DOM, cookies, storage, scroll, form, or SPA state is introduced.
- [x] Focused unit tests cover state transitions, loop guards, geometry, persistence compatibility, lifecycle cleanup, and target routing; Electron smoke verification exercises real paired views and navigation.
- [x] `npm run verify` and the split integration/smoke command pass; no TypeScript errors or unhandled lifecycle exceptions remain.
## Red Team Review

### Session — 2026-08-25
**Findings:** 5 (5 accepted; delegated reviewers unavailable because the runtime backend rejected its tool-schema extensions, so these findings were independently evidence-checked against the repository)
**Severity breakdown:** 1 Critical, 3 High, 1 Medium

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Persisted focus conflicts with transient-state boundary | High | Accept | Phase 2 |
| 2 | Per-pane zoom conflicts with the existing logical-tab zoom contract | High | Accept | Phase 3 |
| 3 | Per-pane document generations would invalidate existing BrowserTarget semantics | Critical | Accept | Phase 2, Phase 4, Phase 5 |
| 4 | Restore activation can make an intermediate tab authoritative | High | Accept | Phase 3, Phase 5 |
| 5 | Shared-session smoke coverage must not weaken navigation security | Medium | Accept | Phase 3, Phase 5 |

#### Evidence and applied decisions

1. `AntiFanTab` currently has one logical `zoomFactor` and one `devicePresetId` (`src/shared/contracts.ts:6-16`); split mode therefore keeps zoom logical-tab scoped while applying only fit scale per pane. Persisted `focusedPane` is removed because focus is interaction state, not durable configuration.
2. `BrowserTarget` has no pane field and requires one logical `tabId`, `browserEpoch`, and `documentGeneration` (`src/shared/control-plane-contracts.ts:94-105`); pane selection remains internal and document generation advances once per logical document, not once per mirror renderer.
3. `createTab()` activates by default and `restoreTabs()` currently calls it without disabling activation (`src/main/browser/native-tab-host.ts:1330-1331`, `src/main/browser/native-tab-host.ts:1538-1539`, `src/main/browser/native-tab-host.ts:2851-2857`); the plan now requires non-activating restore followed by one explicit final switch.
4. Existing navigation construction uses `getSecureWebPreferences()`, sanitizes/restores URLs, and denies non-allowed popups (`src/main/browser/native-tab-host.ts:1368-1370`, `src/main/browser/native-tab-host.ts:1363-1366`, `src/main/browser/native-tab-host.ts:1497-1502`); paired panes must reuse those guards, and shared cookies/storage are tested only as an intentional existing-session behavior.

### Whole-Plan Consistency Sweep

- Files reread: `plan.md`, `phase-01-start.md`, `phase-02-split-state-and-synchronization-contract.md`, `phase-03-native-webcontentsview-pair-and-layout.md`, `phase-04-toolbar-controls-and-target-semantics.md`, `phase-05-tests-and-electron-smoke-verification.md`
- Decision deltas checked: 5
- Reconciled stale references: 5
- Unresolved contradictions: 0

<!-- slug: split-web-desktop-mobile-review -->
