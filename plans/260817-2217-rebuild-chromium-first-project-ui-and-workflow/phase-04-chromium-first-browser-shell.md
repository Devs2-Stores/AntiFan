---
phase: 4
title: "Chromium First Browser Shell"
status: done
priority: P1
effort: "7d"
dependencies: [2, 3]
---

# Phase 4: Chromium First Browser Shell

## Overview

Port the proven legacy browser interactions into the production-quality
Project shell around the real Project-owned Chromium view. Reuse browser/Main
behavior; change only renderer composition, typed boundaries, exact ownership,
and the Project Binding Rail.

## Existing Capability Migration Contract

- Existing: tab strip, omnibox, navigation, bookmarks, zoom, capture, font
  finder, lens, image info, DevTools, shortcuts, and their current E2E coverage.
- Reuse: `NativeTabHost`, tab/browser services, utility implementations, tested
  keyboard semantics, and working edge-case behavior where ownership is safe.
- Required delta: React UI port, exact Project/tab/runtime/document targeting,
  typed IPC, responsive bounds, popup/crash state, and Binding Rail visibility.
- Do not clean-room rewrite a capability merely because its React component is new.
- Legacy removal condition: per-feature parity E2E plus exact-target ownership passes.

## Resume Checkpoint

- Paused after creating `src/shared/browser-contract.ts` and before mutating
  `NativeTabHost` owner-window, popup, crash, or layout behavior.
- The new file is a typed DTO/validation boundary (`new`); it does not replace
  existing tab, navigation, bookmark, zoom, capture, inspector, or utility logic.
- Resume by mapping each contract field and operation to the existing
  `NativeTabHost`, `TabManager`, renderer handler, preload route, and E2E owner.
- Reuse the current implementation when safe. Modify behavior only for exact
  Project ownership, stale-generation rejection, popup adoption, crash identity,
  or validated layout requirements recorded by this phase.
- Do not delete or bypass legacy browser behavior until its individual parity
  gate passes through the isolated Project renderer.

## Requirements

- Chromium is the largest visible region in every supported layout.
- Tab strip supports create, activate, close, reorder, title/loading/crash state,
  popup adoption, and overflow without leaking tabs across Projects.
- Omnibox supports URL/search, history suggestions, back/forward/reload/stop,
  bookmark toggle/list/search, and explicit external-open policy.
- Preserve app zoom, capture viewport/full page, font finder, lens zoom, image
  info, and browser DevTools affordances with Project/tab ownership.
- The Project Binding Rail shows Project, Workspace, Chat/Run, active tab,
  document generation, browser-control status, and stale/recovery state.
- Renderer sends one typed layout rectangle; Main applies exact browser bounds.
- Narrow windows collapse labels and move auxiliary panels to overlays; browser
  controls remain reachable by keyboard and overflow menu.
- Remote pages never receive app preload or renderer DOM access.

## Architecture

`BrowserShell` owns only UI chrome. `NativeTabHost` remains the WebContentsView
authority. A versioned `BrowserLayoutSnapshot` reports top/left/right/bottom
reserved regions and an exact browser rectangle. Main validates it against the
window content bounds before setting tab view bounds.

The Binding Rail is a read-only projection of Main snapshots. Any binding change
is an explicit operation; changing focus never mutates an existing run binding.

## User Flows And States

- New tab, navigate, reorder, duplicate close, crash and recover.
- Bookmark current page and open/search bookmark list.
- Toggle app zoom, page capture, full-page capture, font finder, lens, DevTools.
- Open a trusted popup as a managed Project tab.
- Resize wide to narrow with Harness and Terminal open.
- Active run bound to another tab; user changes visible tab without retargeting run.
- Stale tab/document binding after navigation.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/shared/protocol.ts` | Browser/tab/layout DTOs and state | Unit/IPC |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/project-preload.ts` | Browser layout, tabs, bookmarks, utilities op/event catalogue | Static parity |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/index.ts` | Self-contained browser client parity | Static/security |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/native-tab-host.ts` | Exact owner window, managed popup adoption, validated layout, utilities | Browser/E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/browser/tab-manager.ts` | UI tab state, crash/runtime identity, reorder | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/browser/tab-controller.ts` | Explicit tab actions and stale checks | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/projects/project-runtime.ts` | Browser snapshot/event exposure | Project isolation |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/index.ts` | Register typed browser/layout operations only | Static parity |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/shell/project-window-shell.tsx` | Main Project grid/docks/browser surface | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/browser/browser-tab-strip.tsx` | Project tab strip | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/browser/browser-toolbar.tsx` | Navigation/omnibox/actions | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/browser/project-binding-rail.tsx` | Persistent scope/target indicator | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/browser/browser-utilities-menu.tsx` | Bookmarks, capture, font, lens, DevTools | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/main/browser-layout-contract.test.ts` | Bounds validation and narrow layouts | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/e2e/toolbar-visibility.cjs` | New Project shell wide assertions | E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/e2e/toolbar-narrow-visibility.cjs` | Narrow overflow and browser minimum area | E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/e2e/tab-reorder-runner.cjs` | Project-owned tab fixture and reorder | E2E |

## Implementation Steps

1. Define browser tab, toolbar, utility, binding, and layout DTOs.
2. Make `NativeTabHost.launch()` return/retain the exact owning BrowserWindow;
   remove fallback discovery by global window order.
3. Route popups into managed Project tabs and model tab crash/replacement state.
4. Port BrowserShell, tab strip, omnibox, bookmarks, and utilities against typed
   Project operations while preserving characterized legacy behavior.
5. Implement the Binding Rail with mismatch and stale-generation states.
6. Report browser/dock rectangles through one layout operation; validate and
   clamp in Main before applying WebContentsView bounds.
7. Implement responsive collapse/overflow rules and keyboard shortcuts.
8. Run browser core, toolbar, tab reorder, popup, crash, and layout tests.

## Function And Interface Checklist

- [ ] `BrowserLayoutSnapshot` contains window revision and exact browser rect.
- [ ] `BrowserTabViewModel` includes tab/runtime/document identity and crash/loading state.
- [ ] `NativeTabHost.applyProjectLayout()` rejects stale/negative/out-of-window bounds.
- [ ] `ProjectBindingView` distinguishes visible tab from immutable run target.
- [ ] Popup handler creates/adopts a Project tab before page exposure.
- [ ] Utility actions require exact Project/tab sender ownership.

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | Layout rect overlaps Harness/Terminal | Main rejects or corrects; E2E reports mismatch |
| Critical | Trusted `_blank` popup | One managed Project tab; no unmanaged window |
| Critical | Visible tab changes during run | Binding Rail shows difference; run target unchanged |
| High | Renderer crash/replacement | Old binding stale; new runtime identity shown |
| High | 960x700 with Harness + Terminal | Chromium remains visible; one auxiliary pane overlays |
| Medium | Bookmark/zoom/capture utility | State persists only in owning Project/profile |

## Dependency Map

`Project window ownership -> browser DTOs -> exact layout -> shell components -> responsive/browser E2E`

## Success Criteria

- [ ] Browser shell matches Chrome-like expectations and Chromium stays primary.
- [ ] Every tab/utility action is Project-owned and exact-targeted.
- [ ] Binding Rail makes visible and run-bound targets unambiguous.
- [ ] Wide/narrow layouts pass minimum browser-area and overflow tests.
- [ ] Popups, crashes, reorder, bookmarks, zoom, capture, font, lens, and DevTools have explicit parity.

## Risk Assessment

Renderer-measured bounds can drift from Electron DIP bounds under app zoom or DPI
changes. Include device scale/app zoom/window revision in the contract and
re-report after every relevant transition. If measurements remain unstable,
Main owns deterministic dock dimensions from typed UI state. Never patch layout
with arbitrary offsets. Rollback keeps the new shell on the isolated entry.

## Evidence

- 423 unit/IPC tests pass (includes `test/main/browser-layout-contract.test.ts` — 8 tests: snapshot validation, reserved-region overlap rejection, stale/future window revisions, binding state machine, utility op guard, crash identity rotation).
- `test/e2e/project-shell-layout.cjs` → `PROJECT-SHELL-LAYOUT_OK` (41 checks, stable 5/5 runs): shell chrome DOM, typed bridge ops (list/create/activate/move/close/apply-layout/binding-view/utility), stale-layout-revision + overlap rejection, binding rail aligned/future states, focus, utilities menu, narrow one-overlay rule, Chromium-largest assertions at 1920x1080 (both docks) and 1280x800 (right dock).
- Screenshots (capture-as-evidence): `test/artifacts/phase-04/shell-{1920x1080,1280x800,960x700}.png`.
- IPC wiring extracted to `src/main/project-ipc-wiring.ts` — production (`index.ts`) and e2e harnesses register the SAME handler table; parity tests scan both.
- Production legacy path untouched (legacy-active); the Project shell renders only on the isolated entry via explicit test/internal routing.
