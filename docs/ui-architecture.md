# AntiFan Browser Desktop — UI Architecture

Authoritative visual hierarchy, layout, scope, state, and cutover decisions for
the Chromium-first Project UI. Companion to the automated verification suites
(`test/main/`, `test/unit/`, `test/e2e/`) and `docs/security-model.md` (trust boundaries).
(Historical note: Early prototype plans referenced `test/fixtures/ui-parity-ledger.json`,
which was superseded by live test suites upon standalone transition).

## Product Thesis

Chromium is the primary surface of every Project window. The Harness is a
scoped development cockpit *around* Chromium: Project/Workspace navigation,
conversations, run/tool timeline, terminals, browser evidence, and post-fix QA.
No chat, run, terminal, annotation, or QA view replaces or retargets the
browser; changing what is *visible* in Chromium never changes what a run is
*bound* to.

## Visual Direction

- Desktop developer tool: density 6/10, variance 3/10, motion 2/10.
- Dark graphite Chrome-like shell; bundled Geist Sans + JetBrains Mono.
- No gradients, no generic SaaS cards, no purple AI styling, no excessive
  rounding. Teal = action, amber = binding, semantic colors for status.
- No `prefers-reduced-motion` branches anywhere (project rule).

## Window And Layout Model

| Constraint | Value |
|---|---|
| Supported minimum | 960x640 DIP |
| Wide layout | ≥1180 DIP: left nav, Chromium center, right Harness dock, bottom Terminal |
| Wide browser minimum | ≥60% content width and ≥55% content area with both docks open |
| Narrow layout | <1180 DIP: nav collapses; Harness becomes overlay; one auxiliary pane at a time |
| Narrow terminal | capped at 40% content height |
| Chromium visibility | never fully occluded at any supported size |

Layout authority: Main-process `NativeTabHost` (`src/main/browser/native-tab-host.ts`)
computes exact DIP rectangles for `toolbarView`, `frameBackdropView`, `sidebarView`,
and tab renderers (with dual-view coordinate computation via `calculateSplitLayout` in
`src/main/browser/split-review-coordinator.ts`). Main validates against window content
bounds and applies `WebContentsView` bounds directly; the renderer never resizes Chromium
views directly.
## Surface Hierarchy

1. **Main Window** (`BrowserWindow` created in `src/main/index.ts`): hosts `NativeTabHost`
   with a persistent profile partition (`persist:profile-${safeProfileKey}`).
   - Top: `toolbarView` (`src/renderer/toolbar.html` with `src/preload/toolbar-preload.ts` ->
     `antifanToolbar`), providing tab strip, omnibox, device preset selectors, phone status button,
     split-view controls, and Haravan quick-links.
   - Center/Canvas: Chromium `WebContentsView` instances for active tabs (single view or Desktop +
     Mobile split panes managed by `SplitNavigationCoordinator`).
   - Backdrop: `frameBackdropView` (`src/renderer/frame-backdrop.html` with
     `src/preload/frame-backdrop-preload.ts` -> `antifanFrameBackdropApi`).
   - Right/Bottom: Embedded `sidebarView` (`src/renderer/standalone.html` with
     `src/preload/standalone-preload.ts` -> `antifanStandalone`), providing terminal tabs (`xterm.js`),
     process tracking, and run timeline.
   - Popout Windows: Independent `BrowserWindow` instances loading `standalone.html` for detached
     terminal workspaces.
### Split Review Surface (Desktop + Mobile Review)
- **Dual Live WebContentsViews**: Single logical tab owns two live renderers (Desktop & Mobile) side-by-side.
- **Preserved Scope & Session**: Both panes share the logical tab identity, cookies, localStorage, and capsule subscriptions.
- **Authority & Loop-Guarded Sync**: Navigation events route through `SplitNavigationCoordinator` to maintain URL parity without echo loops.
- **Toolbar Controls & Targeting**: Independent preset selectors for Desktop (`laptop-macbook13`, etc.) and Mobile (`phone-iphone15pro`, etc.), with focused pane tracking for MCP/BrowserControlPort DOM inspection, screenshots, and agent actions.

## Scope Rules

- Every visible item carries immutable scope: Project/Workspace/Chat/Run/Tab.
- Selecting a Workspace/chat changes UI projection only; existing chats, runs,
  terminals, annotations, and QA targets never retarget.
- Runs bind exact immutable targets (tab/runtime/document generation,
  workspace revision); no active-tab or focus-derived fallback.
- Terminal/process bindings are created per explicit Workspace and never
  follow the selected Workspace.
- Composer attachments are immutable artifact refs; raw bytes never live in
  renderer state.

## State Model

Renderer holds projections + UI preferences only. Durable truth stays Main-owned:
Projects (`src/main/project/project-registry.ts`), Workspaces (`src/main/project/workspace-registry.ts`),
Capsules (`src/main/project/workspace-capsule.ts`), session stores (`invocation-ledger.ts`,
`event-store.ts`, `receipt-store.ts` in `src/main/session/`), terminals (`src/main/browser/terminal-manager.ts`),
and verification state.
| Window | Binding | Run |
|---|---|---|
| cold-launch, home, project-open, background-active, background-warm, suspended, recovering, profile-delete-pending, closed | valid, stale-generation, future-generation, missing-workspace, needs-binding, stale-tab, stale-document, run-target-differs-from-visible | queued, running, awaiting-model, awaiting-tool, awaiting-user, completed, failed, cancelled, interrupted, unknown-mutation, stale-browser, reconcile-required |

Stale AND future generations fail closed (exact-generation equality). A
binding that cannot be proven disables the mutating control and shows recovery
UI — never a global-focus fallback.

## Keyboard And Focus

- Command palette (project-scoped, catalog-driven) covers Project/Workspace/
  chat, panes, browser utilities, terminal, annotation, QA, settings.
- Dock close returns focus to the browser; modal/dialog Escape returns focus
  to the invoker.
- Every control reachable keyboard-only; tab order documented per surface in
  phase files.

## Cutover Contract (Shipped Architecture)

Single production path; no legacy listener tree exists to conflict:

- Main boots via `src/main/index.ts` and initializes `NativeTabHost`.
- Production views load their dedicated HTML and preload modules:
  - `toolbarView` loads `src/renderer/toolbar.html` through `src/preload/toolbar-preload.ts`
    (exposing `antifanToolbar`).
  - `frameBackdropView` loads `src/renderer/frame-backdrop.html` through
    `src/preload/frame-backdrop-preload.ts` (exposing `antifanFrameBackdropApi`).
  - `sidebarView` loads `src/renderer/standalone.html` through `src/preload/standalone-preload.ts`
    (exposing `antifanStandalone`).
  - Storefront web tabs run with `src/preload/tab-preload.ts` in isolated worlds.
- IPC channels are modularized:
  - Toolbar commands wire through `NativeTabHost.setupToolbarIpc` in
    `src/main/browser/native-tab-host.ts` using `TOOLBAR_CHANNELS` (`src/shared/contracts.ts`).
  - Terminal stream and lifecycle channels wire through `TERMINAL_CHANNELS` in `src/shared/contracts.ts`
    handled by `NativeTabHost`.
  - Control plane capability invocations wire through `src/main/tools/capability-catalogue.ts` and
    `src/main/tools/capability-transport.ts`.
- *Historical note:* Early prototype plans drafting `project-app.html`, `project-window.js`,
  `src/preload/index.ts`, and `src/main/app-shell-ipc.ts` were superseded by this native
  multi-view `WebContentsView` architecture.

Rollback is by previous package artifact, never by running both UI paths.

## Screenshot Matrix

Captured as test artifacts (not pixel-copy targets):

| Viewport | States |
|---|---|
| 1920x1080 | browser+harness+terminal, home, settings, QA |
| 1280x800 | browser+harness, browser+terminal |
| 960x700 | narrow overlay, annotation, terminal cap |
| 960x640 | minimum supported, loading/error/recovery |

## Parity

Feature coverage and regression prevention are enforced by the automated test pipeline
(`npm run verify`, `npm run test:main`, `npm run smoke:split`, `npm run smoke:theme-qa`,
`npm run smoke:device`). Unowned features or contract regressions block release verification.
