---
phase: 2
title: "Renderer Platform And Design System"
status: done
priority: P1
effort: "5d"
dependencies: [1]
---

# Phase 2: Renderer Platform And Design System

## Overview

Create a componentized React/Vite renderer, typed Project bridge adapter, and
desktop design system behind a non-production entry. Do not activate it in the
shipping window yet.

## Requirements

- Use React for composable desktop surfaces and Vite for the renderer only;
  Electron Main/preload/tests remain strict TypeScript/CommonJS-compatible.
- Keep production on legacy during this phase. The new `project-app.html` entry
  is loaded only by tests/internal routing.
- Bundle Geist Sans and JetBrains Mono locally; no network font dependency.
- Ship a restrictive local Content Security Policy; no remote code, inline script,
  `eval`, Node globals, or unsafe renderer fallback.
- Define CSS variables for graphite surfaces, borders, text, teal action, amber
  binding, semantic status colors, spacing, radii, type, and z-index.
- Avoid gradients, generic cards, excessive rounding, decorative AI effects,
  global bare-element branding, `!important`, and reduced-motion branches.
- Centralize Project UI state without turning renderer state into durable truth.
- Every bridge subscription returns cleanup; StrictMode remounts must not double
  events or commands.

## Architecture

`project-window-entry.tsx` selects Project Home or Project Window from a
Main-provided bootstrap envelope. `project-bridge-client.ts` is the only renderer
IPC adapter. `project-ui-store.ts` stores projections and UI preferences only;
durable Projects, chats, runs, terminals, evidence, and QA remain Main-owned.

Vite emits a deterministic `project-window.js` bundle and `project-app.html`.
The production `NativeTabHost` keeps loading legacy `index.html` until Phase 11.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Modify | `E:/Work/apps/antigravity-browser-desktop/package.json` | React/Vite/font/test dependencies and renderer scripts | Compile/test/package |
| Modify | `E:/Work/apps/antigravity-browser-desktop/package-lock.json` | Lock dependency graph | Audit/package |
| Create | `E:/Work/apps/antigravity-browser-desktop/vite.config.ts` | Deterministic renderer build and asset paths | Build smoke |
| Create | `E:/Work/apps/antigravity-browser-desktop/tsconfig.renderer.json` | DOM/JSX renderer typecheck | Typecheck |
| Modify | `E:/Work/apps/antigravity-browser-desktop/tsconfig.json` | Separate Main/test ownership from JSX build | Typecheck |
| Modify | `E:/Work/apps/antigravity-browser-desktop/scripts/dev.mjs` | Watch renderer bundle without duplicate Electron processes | Dev smoke |
| Modify | `E:/Work/apps/antigravity-browser-desktop/scripts/copy-static.mjs` | Stop copying renderer JS/UMD assets owned by Vite | Build/package |
| Modify | `E:/Work/apps/antigravity-browser-desktop/forge.config.ts` | Include final Vite renderer output | Package smoke |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app.html` | Isolated test/internal renderer entry | Electron E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-window-entry.tsx` | Bootstrap and root mount | Renderer tests |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/project-app.tsx` | Top-level Home/Project routing | Renderer tests |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/project-bridge-client.ts` | Typed command/subscription adapter | Unit/static parity |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/project-ui-store.ts` | Main snapshot projection and UI preferences | Unit tests |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/styles/tokens.css` | Product tokens | Visual tests |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/styles/global.css` | Reset, typography, focus, overlays | Visual/a11y tests |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/styles/layout.css` | Dock/grid/responsive invariants | Layout E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/renderer/project-bridge-client.test.ts` | Command/subscription lifecycle | Unit |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/renderer/project-ui-store.test.ts` | Snapshot/replay/stale-state behavior | Unit |

## Implementation Steps

1. Split Main/test and renderer compilation without changing output paths used by Electron packaging.
2. Add the isolated Vite entry and deterministic generated entry filename.
3. Implement bootstrap schema validation before React mount.
4. Implement one Project bridge client with typed success/error envelopes,
   request IDs, scoped subscriptions, replay cursors, and teardown.
5. Implement a reducer/external-store projection for snapshots, events, selected
   UI pane, dock sizes, and focus return targets.
6. Build primitive components: button, icon button, tooltip, menu, dialog,
   splitter, tabs, status badge, empty state, error boundary, toast, and shortcut.
7. Implement tokens and wide/narrow layout primitives.
8. Add StrictMode, subscription, keyboard, focus, and build/package tests.
9. Verify the built HTML CSP, offline fonts/assets, and packaged chunk paths.

## Function And Interface Checklist

- [x] `RendererBootstrap` distinguishes `project-home` and `project-window`.
- [x] `ProjectBridgeClient.invoke()` validates versioned envelopes and bounded errors.
- [x] `ProjectBridgeClient.subscribe()` deduplicates and always unsubscribes.
- [x] `ProjectUiStore.applySnapshot()` replaces projection at a replay cursor.
- [x] `ProjectUiStore.applyEvent()` rejects stale/out-of-order events.
- [x] `LayoutState` reports left/right/bottom dock sizes and browser rectangle.
- [x] Error boundary exposes recovery without silently switching to legacy.
- [x] Built host CSP permits only required local assets and typed IPC-driven data.

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | React StrictMode mounts twice | One effective subscription and command path |
| Critical | Protocol version mismatch | Full-screen compatibility error; no commands sent |
| High | Out-of-order run event | Store ignores/replays from Main cursor |
| High | Renderer build opened from packaged path | All JS/CSS/fonts load offline |
| High | 960px window with two docks requested | One auxiliary overlay; Chromium remains visible |
| Medium | Dialog/menu closes by Escape | Focus returns to invoker |

## Dependency Map

`Phase 1 contracts -> Vite entry -> bridge client + UI store -> primitives/tokens -> feature screens`

## Success Criteria

- [x] New renderer builds, typechecks, mounts, and packages from an isolated entry.
- [x] Production still loads only legacy during this phase.
- [x] One typed bridge adapter owns all Project renderer IPC.
- [x] Design tokens and responsive layout primitives pass visual/focus tests.
- [x] No network fonts, reduced-motion branches, or duplicate subscriptions exist.

## Risk Assessment

Build-tool migration can break packaged paths or dev restart behavior. Prove
compile, offline load, and package smoke before feature work. If Vite cannot
preserve Electron output/security constraints, replan the renderer build rather
than falling back to additional classic scripts. Rollback removes only the
isolated entry and build additions; production remains legacy.
