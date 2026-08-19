---
phase: 1
title: "Characterize UI And Lock Cutover Contracts"
status: done
priority: P1
effort: "3d"
dependencies: ["260817-1931-rebuild-chromium-first-native-harness"]
---

# Phase 1: Characterize UI And Lock Cutover Contracts

## Overview

Turn the current legacy UI and the accepted Harness architecture into an
executable parity/cutover contract before replacing any visible renderer.

## Context Links

- `E:/Work/apps/antigravity-browser-desktop/src/renderer/index.html`
- `E:/Work/apps/antigravity-browser-desktop/src/renderer/app.ts`
- `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-window.ts`
- `E:/Work/apps/antigravity-browser-desktop/test/main/renderer-ipc-contract.test.ts`
- `E:/Work/apps/antigravity-browser-desktop/plans/260817-1931-rebuild-chromium-first-native-harness/architecture.md`
- `E:/Work/docs/superpowers/specs/2026-08-10-copilot-codex-browser-annotation-analysis.md`

## Requirements

- Record every active legacy surface and assign it to a later phase; nothing is
  silently lost because it lived in the monolith.
- Lock the visual thesis: Chromium primary, Project-scoped Harness secondary,
  Terminal bottom, persistent Project Binding Rail.
- Define supported wide and narrow window states, focus order, shortcuts, empty,
  loading, error, stale-binding, background, and recovery states.
- Lock 960x640 DIP as the supported minimum; define the 1280+ browser area and
  sub-1180 overlay thresholds used by automated layout checks.
- Add characterization tests before changing renderer build/load routing.
- Replace the obsolete test expectation that the Project renderer must remain
  dormant with a staged cutover contract: dormant during Phases 1-10, mandatory
  and exclusive in Phase 11.
- Capture current screenshots as evidence, not as a target to pixel-copy.

## Architecture

The parity ledger is the implementation authority for UI coverage. Each row
maps a current feature to its legacy owner, reusable logic, required delta, new
owner, Project/Workspace scope, IPC owner, migration disposition, phase, and E2E
gate. `reimplement` is forbidden as a blanket default. Cutover tests have two
explicit modes:

1. `legacy-active`: production still loads `app.js`; Project entry is test-only.
2. `project-active`: production loads the generated `project-window.js`; legacy
   marker, script, singleton host, and bridges must be absent.

No intermediate mode may load both listener trees in one BrowserWindow.

## User Flows And States

- Cold launch with no Project.
- Reopen last explicit Project.
- Browser-only work at 1920x1080 and 1280x800.
- Browser + Harness; browser + Terminal; browser + Harness + Terminal.
- Add Element, Multi Annotate, browser-controlled run, QA result.
- Two open Projects with one background-active.
- Renderer reload, stale tab binding, interrupted run, provider unavailable.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Create | `E:/Work/apps/antigravity-browser-desktop/docs/ui-architecture.md` | Durable visual hierarchy, layout, scope, state, and cutover decisions | Referenced by UI/E2E review |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/e2e/ui-characterization.cjs` | Capture legacy and staged Project-entry states | New Electron E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/fixtures/ui-parity-ledger.json` | Machine-readable feature ownership and phase map | Static parity assertion |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/renderer-ipc-contract.test.ts` | Add staged cutover-mode assertions and retain duplicate-listener/message parity checks | Existing unit/static suite |
| Modify | `E:/Work/apps/antigravity-browser-desktop/package.json` | Add a focused UI characterization script only | Script smoke |

## Implementation Steps

1. Inventory tabs, omnibox, bookmarks, zoom, capture, font finder, lens,
   component extraction, chat/session/model/skill chooser, terminal, providers,
   plugins, logs, update/changelog/license, mobile remote, annotations, and QA.
2. Map each feature to its existing owner, reusable behavior, required delta,
   Project/Workspace/Chat/Run/Tab scope, owning phase, and one explicit migration
   disposition: `reuse`, `port-ui`, `rebind-and-harden`, `extend`, `new`, or `remove`.
3. Define wide/narrow layout invariants and exact screenshot viewports.
4. Define keyboard map and focus-return rules for docks, dialogs, command palette,
   element selection, and terminal.
5. Add staged cutover tests that read the active Main load path, compiled HTML,
   preload exposure, listener registrations, and production host construction.
6. Capture current screenshots and state dumps under test artifacts.
7. Review the parity ledger against current DOM IDs, renderer handlers, Main
   handlers, preload bridges, and E2E scripts.

## Function And Interface Checklist

- [x] `UiParityEntry` covers feature, legacy owner, reuse target, required delta,
  scope, new owner, phase, test, removal gate, and disposition.
- [x] `RendererCutoverMode` admits only `legacy-active` or `project-active`.
- [x] Cutover scanner traces Main load path to one HTML and one renderer entry.
- [x] Message scanner compares renderer calls, preload allowlists, and Main handlers.
- [x] Duplicate listener scanner covers static IDs and subscription cleanup.
- [x] Layout snapshot reports browser bounds plus all visible dock bounds.

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | Both `app.js` and `project-window.js` load | Static test fails |
| Critical | Active renderer message has no Main handler | Static test fails with command name |
| Critical | Legacy marker remains in `project-active` | Cutover test fails |
| High | Chromium area collapses with both docks open | Layout E2E fails minimum-area invariant |
| High | Two Projects display same scope identity | Isolation E2E fails |
| Medium | Modal closes and focus is lost | Keyboard E2E fails focus-return assertion |

## Dependency Map

`Harness plan contracts -> parity ledger -> renderer platform -> all feature phases -> atomic cutover`

## Success Criteria

- [x] Every current visible feature has one new owner, phase, and validation gate.
- [x] No current feature uses a blanket `reimplement` disposition.
- [x] Design and responsive states are documented without unresolved hierarchy decisions.
- [x] Static tests prove one renderer/preload/listener path per BrowserWindow.
- [x] Characterization screenshots exist for all required wide/narrow states.
- [x] Current dormant Project path and singleton production path are explicitly identified as cutover blockers.

## Risk Assessment

The monolith contains implicit features not obvious from markup. If parity scans
find an unowned handler or modal, stop deletion and assign it before Phase 11.
Rollback is test-only: remove new characterization artifacts without changing
production behavior.
