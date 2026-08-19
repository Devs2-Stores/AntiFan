# Antigravity Browser Desktop — UI Architecture

Authoritative visual hierarchy, layout, scope, state, and cutover decisions for
the Chromium-first Project UI. Companion to `test/fixtures/ui-parity-ledger.json`
(the implementation authority for feature coverage) and
`docs/security-model.md` (trust boundaries).

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

Layout authority: the renderer reports one typed `BrowserLayoutSnapshot`
(top/left/right/bottom reserved regions + exact browser rectangle, window
revision, device scale, app zoom). Main validates against window content
bounds and applies WebContentsView bounds; Main never applies renderer
invented offsets, renderer never resizes Chromium directly.

## Surface Hierarchy

1. **Project Home** (app-level window): recent Projects, create/open/focus,
   background states, no Chromium tabs.
2. **Project window**: one BrowserWindow per Project, one persistent Chromium
   partition, one ProjectRuntime.
   - Left: Project navigation (Workspaces, chats, runs, pinned, background
     indicators). Collapses at narrow widths.
   - Center: Chromium (tab strip, toolbar/omnibox, utilities, binding rail,
     browser-control banner).
   - Right: Harness dock (conversation + run/tool timeline). Overlay at narrow.
   - Bottom: Workspace panel (terminal tabs, tracked processes, dev servers).
   - Persistent **Project Binding Rail**: Project, Workspace, Chat/Run, active
     tab, document generation, browser-control status, stale/recovery state.

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

Renderer holds projections + UI preferences only (`ProjectUiStore`). Durable
truth stays Main-owned: Projects (catalog), Workspaces, chats, turns, runs,
terminals, processes, evidence, QA runs, checkpoints.

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

## Cutover Contract (Phase 11 shipped)

Single production path; no legacy listener tree exists to conflict:

- `project-active`: production loads `project-app.html` + generated
  `project-window.js` through the sandboxed composite preload
  (`src/preload/index.ts` — Project bridge + allowlisted app-shell bridge in
  one self-contained module). `data-agb-path="legacy"`, legacy script,
  singleton host, and parallel bridges are absent; the legacy renderer was
  deleted outright.
- The app-shell command channel is extracted to `src/main/app-shell-ipc.ts`
  (22-command catalogue injected against live runtime deps); the register
  site in `src/main/index.ts` only wires it.
- Project events deliver `{ eventName, scope, payload }` to the renderer;
  the preload forwards the payload with `scope` merged in, so per-window
  filters (`chatSessionId`/`runId`) gate live updates without a per-name
  allowlist at the send path.

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

`test/fixtures/ui-parity-ledger.json` maps every legacy surface to its new
owner, scope, IPC path, phase, E2E gate, and disposition. Unowned features are
cutover blockers; deletion stops until each row is owned.
