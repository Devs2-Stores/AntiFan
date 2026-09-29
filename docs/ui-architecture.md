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

AntiFan's place in the toolchain is narrower than its cockpit suggests: Orca orchestrates the
development of AntiFan itself, while AntiFan is the cockpit for live client themes. The run cards
in the shared Terminal Manager observe and steer agent runs that work on merchant storefronts —
they are not a surface for driving this repository's own build or test agents, and they bind to a
terminal session and a capsule, never to a focused tab. A pinned capsule brief carries storefront
context (URL, site name, theme id, standing rules) into every prompt a terminal-bound agent run
receives, keeping client-work state where client work lives.

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

960x640 is the smallest size the UI must stay usable at; it is a design contract, not the
native window minimum enforced by Electron. The enforced minimum is set where the production shell
is constructed (the manager's `createShell` callback in `src/main/index.ts`).

Layout authority: each window's Main-process `NativeTabHost`
(`src/main/browser/native-tab-host.ts`) computes that window's exact DIP rectangles for
`toolbarView`, `frameBackdropView`, `sidebarView`, and tab renderers (with dual-view
coordinate computation via `calculateSplitLayout` in
`src/main/browser/split-review-coordinator.ts`). Main validates against window content
bounds and applies `WebContentsView` bounds directly; the renderer never resizes Chromium
views directly. The shell is the only writer of chrome bounds: a toolbar overlay request
(`NativeTabHost.setToolbarOverlay`) records the overlay flags and re-runs the canonical
`updateLayout()` pass, so the toolbar's own message can never desync its viewport from
the bounds the tab views just took. Post-disposal readers fail closed:
`ProjectWindowShell.disposeChrome()` records every chrome content it destroys into
`disposedChrome` before nulling the view fields, so the close audit answers for surfaces
disposal already forgot instead of reporting only the views still attached. Geometry is
shell-local: resizing, maximizing or moving one window changes
only that window's layout and its tabs' presented bounds.

## Surface Hierarchy

There is no single main window. Presentation is **one browser window per owner**
(one per project, plus an `Unassigned` window when an unmapped page needs one), while
tab identity, queues, sessions and automation stay in one shared authority. The
`Unassigned` window is also where the shared Terminal Manager lives (§Scope Rules).

- `ProjectWindowManager` (`src/main/browser/project-window-manager.ts`) is the window
  directory: at most one live shell per owner key, the close-surface directory, and the
  browser-shell count. It is not a window census — capture hosts and terminal popouts are
  never admitted to it.
- `ProjectWindowShell` (`src/main/browser/project-window-shell.ts`) owns one window's
  native presentation: its `BrowserWindow`, its chrome views, its placement/display
  state. It owns no tab map, selection or attachment, and construction never presents.
- `ensureProjectWindow` in `src/main/index.ts` is the only production path that creates
  a shell. It gives that shell its own `NativeTabHost` and registers it in the
  tab-authority directory (`src/main/browser/tab-authority-directory.ts`), which is what
  makes the window's tabs routable and its IPC sender-resolvable. A duplicate open, or a
  second caller racing the same owner, joins the live shell instead of building a host.
  A creation with **user** intent is presented from here, on its first paint
  (`presentShellOnFirstPaint`: ready-to-show, with a bounded fallback, at that owner's own
  saved placement), because a shell never shows itself: without it a window a user asked
  for would exist, answer its chrome and stay invisible. Agent intent is never presented,
  and the bootstrap's `firstVisible` marker is armed by that same presentation instead of
  a second presenter racing it for the same window.

Each window's shell presents:

- Top: `toolbarView` (`src/renderer/toolbar.html` with `src/preload/toolbar-preload.ts` ->
  `antifanToolbar`), providing tab strip, omnibox, device preset selectors, phone status button,
  split-view controls, Haravan quick-links, and the refusal notice a blocked close or quit is
  displayed in (`antifan:close:refused`, `CLOSE_REFUSED` in `src/shared/contracts.ts`): Main's
  summary and per-reason details as text, the refused work's existing stop/release controls named
  as guidance rather than offered as buttons, and dismissal. It never carries a force override,
  and it is hidden entirely until a refusal arrives.
- Center/Canvas: Chromium `WebContentsView` instances for that window's active tabs
  (single view or Desktop + Mobile split panes managed by `SplitNavigationCoordinator`).
- Backdrop: `frameBackdropView` (`src/renderer/frame-backdrop.html` with
  `src/preload/frame-backdrop-preload.ts` -> `antifanFrameBackdropApi`).
- Right/Bottom: Embedded `sidebarView` (`src/renderer/standalone.html` with
  `src/preload/standalone-preload.ts` -> `antifanStandalone`), providing terminal tabs (`xterm.js`),
  process tracking, and run timeline.

Auxiliary windows are not browser shells and never count as project windows: terminal
workbench/popout `BrowserWindow`s load `standalone.html` from the owning host, and the
offscreen capture host is a non-closable window the host raises for raster capture;
a capture lift is a bounded, serialized per-window lease — an in-window lift caps at
IN_WINDOW_CAPTURE_LIFT_MAX_MS and buries on real user input.
Tab pages run in the host's persistent profile partition
(`NativeTabHost.getSharedProfilePartition`, `src/main/browser/native-tab-host.ts`), and a
separate window does not manufacture a separate jar: affiliation, not window count,
decides the partition.

A tab's capsule is resolved before its page exists, in this order
(`resolveNewTabCapsuleId`, a module-level function in `src/main/browser/native-tab-host.ts`): an explicitly
measured capsule (a routed or agent tab verified against its anchor, a restored tab, or a
`window.open` child inheriting the tab that opened it) wins over the window's own verified
workspace, which in turn wins over the process-wide active capsule. The last step only applies to
a window with no verified workspace, because there is exactly one active capsule but many
windows: trusting it first files a tab opened in window B under window A's capsule whenever A
happens to be active, and every later reader (routed creation, terminal scope, capture) inherits
that mistake.

That last parenthetical is a full inheritance, not just the capsule. Because Chromium answers a
page's `window.open` synchronously, the popup tab is created one turn later, and the handler reads
the opener's identity *before* deferring: the child is built with the opener's capsule, its
partition and its user agent mode, so a popup reads the same cookie jar and presents the same
browser as the page that opened it. Two boundaries come with the deferral: an opener closed before
that turn creates no child at all, and a child the adoption refuses is closed again, so a popup
whose parent is gone leaves no orphan tab behind.

### Split Review Surface (Desktop + Mobile Review)
- **Dual Live WebContentsViews**: Single logical tab owns two live renderers (Desktop & Mobile) side-by-side.
- **Preserved Scope & Session**: Both panes share the logical tab identity, cookies, localStorage, and capsule subscriptions.
- **Authority & Loop-Guarded Sync**: Navigation events route through `SplitNavigationCoordinator` to maintain URL parity without echo loops.
- **Toolbar Controls & Targeting**: Independent preset selectors for Desktop (`laptop-macbook13`, etc.) and Mobile (`phone-iphone15pro`, etc.), with focused pane tracking for MCP/BrowserControlPort DOM inspection, screenshots, and agent actions.
- **Non-Destructive Mirroring**: a sibling pane that already presents the mirror URL is
  never reloaded — a same-URL load still wipes the live DOM (form values, scroll,
  focus). Enabling split review seeds the mobile mount as a desktop-authority
  transaction, so the pane's own initial commit settles as the expected echo instead
  of driving a correction against the live desktop document.

## Scope Rules

- Every visible item carries immutable scope: Project/Workspace/Chat/Run/Tab.
- Selecting a Workspace/chat changes UI projection only; existing chats, runs,
  terminals, annotations, and QA targets never retarget.
- Runs bind exact immutable targets (tab/runtime/document generation,
  workspace revision); no active-tab or focus-derived fallback.
- A session's **edit mode** scopes what it may write, and it is a property of the
  session rather than of the window: `[⚡Direct-Edit]`, `[🚀Super-Fast]` and
  `[🧠Core-Context]` (the Element Picker's mode chips, `ElementPicker` in
  `src/main/browser/element-picker.ts`) latch per session, and an explicit tag
  always wins — including `[🧠Core-Context]` as the way out of a latched scoped
  mode, so no channel can trap a session in a mode the person is leaving. In a
  scoped mode the writable set is the resolved theme root's content directories
  plus the workspace's own bookkeeping, resolved from the session `cwd` by the
  same `.antifan/` walk the QA gate uses (`resolveWorkspaceShape`,
  `src/omp-hooks/theme-paths.ts`); a write outside it is refused, not silently
  allowed, and an unresolvable workspace refuses everything. Super-Fast
  additionally drops the shell, dispatch, the network and every live-browser
  device call, while Direct keeps read-only storefront inspection. The mode
  travels to spawned subagents through `ANTIFAN_EDIT_MODE`, survives resume as an
  `antifan.edit-mode` session entry, mirrors to
  `%ANTIFAN_DATA_ROOT%/runtime/edit-mode/<ompSessionId>.json`, and audits every
  decision to `<workspaceRoot>/.antifan/edit-guard/<ompSessionId>.jsonl`. While a
  scoped mode is latched the storefront QA gate stops demanding receipts and
  states once per turn what changed. Enforcement lives in the user-scope hooks
  installed from repo source (`src/omp-hooks/`, `scripts/install-omp-hooks.mjs`),
  so a customer workspace behaves the same as an AntiFan one. Design:
  [edit-mode guard](superpowers/specs/2026-09-28-edit-mode-guard-design.md).
- Terminal/process bindings are created per explicit Workspace and never
  follow the selected Workspace. A session created without an explicit `cwd`
  is rooted in its own window's verified workspace (`resolveTerminalCreationTarget`),
  never the process-wide `TerminalManager.currentCwd` another window's switch
  may have rewritten; the session is tagged with that workspace's `capsuleId`
  as creation provenance, which never re-parents an existing session.
- A terminal session also records the **window owner key** that minted it
  (`project:<id>` or the `unassigned` sentinel, `src/main/browser/window-owner.ts`).
  That key alone decides which window's sidebar may list, read or write the
  session, so two windows working the same folder stay separate even though they
  share a capsule; an agent's session carries `agent:<tab>` and belongs to no
  window. Rows written before owner keys existed keep the capsule rule
  (`windowSessionScope` in `src/main/browser/native-tab-host.ts`), and a restart
  never re-parents the session it replaces.
- The window owned by the `unassigned` sentinel is the **shared Terminal Manager**:
  it is the one window whose terminal list reaches every project, while every
  project window keeps showing only its own. Its reach is a view plus control
  over project and unassigned rows — an `agent:<tab>` row stays view-only, listed
  and streamed but never typed into. The Terminal menu's `Cửa sổ Terminal chung
  (Shared Terminal Manager)` (`CmdOrCtrl+Shift+M`) is the one launch path that opens or
  reveals it (`openSharedTerminalManagerWindow` in `src/main/index.ts`, through the same
  `ensureProjectWindow` factory every window uses), and no chrome route reaches
  that window kind, so MCP and bridge callers keep their refusal for naming no
  window. Assigning a row to a project from either its owning project window's
  tab context menu or the shared manager ensures the target project's window exists
  and then re-stamps the row's owner key — and, when the target resolves to one
  canonical capsule, its workspace stamp with it: the one user-ordered
  reassignment of a minted owner key. Project windows cannot move another owner's
  rows, and agent-owned rows remain read-only. The shell process and working
  directory are preserved during the transfer.
  Both pickers read `PROJECT_LIST`: one row per project, and the transfer names that
  `projectId` — never a capsule the renderer inferred. Main resolves the destination
  itself (`resolveProjectAssignment` in `src/main/index.ts`): exactly one capsule with
  a validated affiliation stamps its `capsuleId`, a known project with no capsule
  record at all moves the row with the stamp cleared, and two or more claims resolve
  to nothing — such a row stays visible but cannot receive a terminal
  (`canAssignTerminal: false`, hint `hồ sơ dự án không rõ ràng`). Historical duplicate
  capsules are not additional projects and are never offered as separate transfer
  destinations. Nothing implicit — window focus, tab activation, capsule switch —
  gains that power, and `setCapsule` keeps its capsule-only rule. The reach lives in
  `windowSessionScope` / `isSessionVisibleToWindow` / `admitsSessionForWindow` and the
  `antifan:terminal:assign-project` route
  (`src/main/browser/native-tab-host.ts`), with the record-level seam in
  `TerminalManager.transferSessionOwner` (`src/main/browser/terminal-manager.ts`).
  A terminal's URL follows the same scope: a link click in a row posts
  `antifan:terminal:open-link`, and Main opens it in the window that owns that exact
  session (`openTerminalLinkInOwner`) — never in whichever window has focus, and
  never in the system browser.
  Design and the seams it orders:
  [shared Terminal Manager](superpowers/specs/2026-09-28-shared-terminal-manager-capsule-assignment-design.md).
  This paragraph is the contract; the tree answers for how much of it is wired, and
  each half names its own owner — the route table (`NativeTabHost.CHROME_ROUTES`),
  `windowSessionScope` with its manager gate, and the sidebar's tab context menu.
- Composer attachments are immutable artifact refs; raw bytes never live in
  renderer state.

## State Model

Renderer holds projections + UI preferences only. Durable truth stays Main-owned:
Projects (`src/main/project/project-registry.ts`), Workspaces (`src/main/project/workspace-registry.ts`),
Capsules (`src/main/project/workspace-capsule.ts`), session stores (`invocation-ledger.ts`,
`event-store.ts`, `receipt-store.ts` in `src/main/session/`), terminals (`src/main/browser/terminal-manager.ts`),
and verification state.

Run files are the one projection an agent process writes:
`%ANTIFAN_DATA_ROOT%/runtime/runs/<terminalSessionId>.json` (plus the
`<sid>.brief.json` mirror of a capsule's pinned brief and the `control/` request
directory) is written by the OMP run-state hook and owned, swept and pruned by
Main (`RunStateService`, `src/main/run/run-state-service.ts`). It is evidence
*about* a terminal session, never a second authority over it: a stale or dead row
is projected as ended, and the capsule's own record stays the only truth about a
brief.

Project identity has one runtime authority: the single `ProjectRegistry` instance
exported from `src/main/index.ts` is shared by the capsule layer
(`WorkspaceCapsuleManager`'s `affiliationAuthority`) and the control plane
(`ControlPlaneRuntime`'s `projects`), so the two can never disagree about what is a
known project. `synchronizeCapsulesWithRegistry` is the single writer that projects
every capsule carrying an explicit `projectId`/`workspaceId` affiliation into it
(open project + attached workspace); it runs at boot before the first window, before
every `ensureWindow`, and once in `whenReady`. The projection is idempotent, a newer
root wins over an older one, and an absent or ambiguous affiliation registers nothing
rather than guessing. `isKnownProjectId` accepts the boot identity, a registry-open
project, a capsule-claimed explicit project, or a window already open for it;
`resolveWindowRecord`'s root fallback order is registry workspace root →
affiliated capsule `workspacePath` → no workspace at all (the window keeps its
stable id as its title and claims no path; it never presents the process
directory as the project's, and a capsule whose affiliation does not validate is
the same as no capsule).

The built-in project (`project-00000000-0000-4000-8000-000000000001`) is labelled
**Tổng hợp** instead of its generated ID label: it is the destination that needs no
workspace, so a terminal or tab can be handed to it and have the old workspace stamp
cleared. Its owner key, saved tabs, terminal associations and workspace remain
unchanged; an explicit capsule or registry project name takes precedence. This label
is resolved by Main, so an already running process needs an application restart to
pick up the change.

Opening a project has one Main-owned surface, reached from both entrypoints — the
File menu's `Mở dự án…` (`CmdOrCtrl+Shift+O`) and the sidebar header chip. Neither
entrypoint names a project: `openProjectWindow` with no id builds its inventory from
Main's own records (`collectProjectOpenCandidates`/`projectOpenDialogSpec` in
`src/main/project/project-open-picker.ts`), offering open registry projects plus the
boot and live-window identities, and then validates the answer through the same path
an explicit request takes. A renderer that sent its own window's id would turn "open
another project" into "focus the one already open", which is why the sidebar request
carries none — and the chip, not the menu, is what makes the action reachable from a
window that already exists. The Unassigned shell is no longer unreachable — the
Terminal menu's shared-manager entry is its one launch path — but it exists for the
cross-project terminal list, never as a second way to open a project.

That dialog also offers `Chọn thư mục…`, the one path by which a project comes into
existence on a user's request: `resolveProjectFromFolder` (`src/main/index.ts`) resolves
the chosen directory through the filesystem — a workspace is an anchor for PTY cwd and
preview containment, so it must be the directory itself, never a symlink — adopts it when
it is already the attached workspace root of exactly one project (a second project for one
directory would give two windows one working directory and two close gates), refuses
`AMBIGUOUS_PROJECT_FOLDER` when two attached workspaces claim that root, and otherwise
mints a project and an attached workspace and records the pair as a capsule affiliation.
The affiliation is the whole durability story: `workspace-capsules.json` is what the next
boot's `synchronizeCapsulesWithRegistry` re-registers the project from, so a folder open
with no capsule manager refuses before any record moves rather than creating a project that
would vanish at the next launch. The resolved id then enters the same validation and window
factory as an explicit request, so a folder open and an id open cannot drift apart.

Terminal provenance crosses the daemon boundary unchanged: a session's `capsuleId`
tags the workspace it was created in, and it is carried on the wire by
`DaemonTerminalProxy.startTerminal`/`createSession` (`src/main/terminal-daemon/`),
typed in `protocol.ts` and threaded into the daemon's `TerminalManager`. The tag
travels back too: every `SessionSummary` carries the capsule it belongs to, which is
what lets the daemon-backed facade answer a window's scope question (`getSessionStateForCapsule`,
`sessionCapsuleId`) from the summaries it already caches, instead of holding a second
registry of its own. The seam is
asymmetric: in-process `TerminalManager.createSession`/`startTerminal` stay synchronous,
while the proxy answers over WebSocket and returns Promises, so every caller holding
the process-wide singleton must `await` creation (the seam contract is written at
`daemon-client.ts` and `terminal-capabilities.ts`; a synchronous read in daemon mode
yields a `Promise`, never a session id).


The status vocabularies the UI renders are owned by types, not restated here: runs by
`RunState` and attachments by `AttachmentState` (`src/shared/control-plane-contracts.ts`),
window close/quit attempts by `ProjectCloseCoordinator`
(`src/main/browser/project-close-coordinator.ts`).

A binding that cannot be proven disables the mutating control and shows recovery UI — never a
global-focus fallback. Exact document generation is revalidated inside the operation's lock, so a
target whose generation advanced while the operation was queued fails with `TARGET_STALE`
instead of acting on a page the caller did not name
(`test/main/browser-owner-target-revalidation.test.ts`).

## Keyboard And Focus

- Command palette (project-scoped, catalog-driven) covers Project/Workspace/
  chat, panes, browser utilities, terminal, annotation, QA, settings.
- Dock close returns focus to the browser; modal/dialog Escape returns focus
  to the invoker.
- Agent-plane work never moves real DOM focus — it uses focus emulation — and
  agent-plane tab activation defers to ACTIVATION_DEFERRED_USER_INPUT while
  recent user input (<2000ms) is in the window.
- Every control reachable keyboard-only; tab order documented per surface in
  phase files.

## Cutover Contract (Shipped Architecture)

Single production path; no legacy listener tree exists to conflict:

- Main boots via `src/main/index.ts`, installs the chrome IPC table once, and creates
  one shell + `NativeTabHost` per owner through `ensureProjectWindow`.
- Production views load their dedicated HTML and preload modules:
  - `toolbarView` loads `src/renderer/toolbar.html` through `src/preload/toolbar-preload.ts`
    (exposing `antifanToolbar`).
  - `frameBackdropView` loads `src/renderer/frame-backdrop.html` through
    `src/preload/frame-backdrop-preload.ts` (exposing `antifanFrameBackdropApi`).
  - `sidebarView` loads `src/renderer/standalone.html` through `src/preload/standalone-preload.ts`
    (exposing `antifanStandalone`).
  - Storefront web tabs run with `src/preload/tab-preload.ts` in isolated worlds.
- Chrome IPC is registered exactly once per process and dispatched per sender:
  - Channel names are declared in `src/shared/contracts.ts` (`TOOLBAR_CHANNELS`,
    `SIDEBAR_CHANNELS`, `TERMINAL_CHANNELS`, `FRAME_BACKDROP_CHANNELS`); the route table and its
    handlers live on `NativeTabHost` (`src/main/browser/native-tab-host.ts`), and the
    project-window channels are `PROJECT_WINDOW_ROUTES` (`src/main/index.ts`).
  - `installChromeIpcOnce` (`src/main/browser/ipc-router.ts`) installs them once per process and is
    idempotent: `index.ts` installs the full table (host routes + `PROJECT_WINDOW_ROUTES`) before
    any host exists, and a host's own call site is a no-op after that. Registering per host
    unconditionally is what made the second window re-register every channel and throw.
  - Each message is resolved to the host that owns its sending webContents, and the route's
    surface is enforced, so a renderer cannot reach another window's tabs or drive a surface it
    does not present. An unknown sender and a foreign surface are refused, not redirected.
  - Control plane capability invocations wire through `src/main/tools/capability-catalogue.ts` and
    `src/main/tools/capability-transport.ts`.
- *Historical note:* Early prototype plans drafting `project-app.html`, `project-window.js`,
  `src/preload/index.ts`, and `src/main/app-shell-ipc.ts` were superseded by this native
  multi-view `WebContentsView` architecture.

Rollback is by previous package artifact, never by running both UI paths.

## Close, Quit And Admission

Owner: `ProjectCloseCoordinator` (`src/main/browser/project-close-coordinator.ts`) decides
every destructive close. The native half is `ProjectWindowShell.closeSelf` and
`NativeTabHost.closePage`; application lifecycle wiring is in `src/main/index.ts`
(`attachShellLifecycle`, `requestApplicationQuit`, `before-quit` / `window-all-closed` /
`will-quit`). A refusal is never a silent no-op: it is a report the user surface can show.

**Outcome vocabulary.** A page close ends `closed` only on the destroyed fact, `vetoed` when the
page refused to unload, and `unknown` when no terminal signal could be established. A shell
close adds `failed` for a native call that threw. An attempt is `closed` or `retained`, and an
application quit is `committed` or `not-committed`. `unknown` refuses: the shell is retained and
reported, never destroyed on a guess. `closed` is settled only after the shell has audited that
the chrome contents it owned are actually gone.

**No closure is decided on a timer.** Three bounds cover silence, each on a different surface, and
none of them can decide a closure:

- `INJECTED_OUTCOME_DEADLINE_MS` (`src/main/browser/project-close-coordinator.ts`) bounds every
  answer the coordinator awaits through its injected seams — a live-use read, a page close, a
  shell close. Silence becomes `unknown`, which refuses and retains the shell.
- `PAGE_CLOSE_OUTCOME_DEADLINE_MS` (`src/main/browser/native-tab-host.ts`) bounds the platform's
  own answer inside the host's page close, where `close({ waitForBeforeUnload: true })` can go
  unanswered entirely. It never decides a closure — `closed` still comes only from a destroyed
  instance — and its job is to stop one swallowed answer from holding that tab's reservation and
  handing the same never-settling promise to every later attempt.
- `SHELL_CLOSE_OUTCOME_DEADLINE_MS` (`src/main/browser/project-window-shell.ts`) bounds the
  shell's own close attempt: `closed` only when the window proves destroyed, otherwise `unknown`,
  with either verdict owing the same disposal audit.

One more bound sits past all closure decisions: `armForceExitWatchdog` (`src/main/index.ts`) ends
the process two seconds after a committed quit, because a platform that never delivers the quit
would strand it with no window left to report through. It is an exit bound, not a closure
decision, and a delivered `will-quit` disarms it: the platform asked, so a listener that vetoed
the quit is a decision to stay alive, and killing it there would discard the state the veto
protected and journal a force exit for a teardown that was in fact graceful.

Measured on this platform, a close issued while a previous refusal is still being processed is
answered with no event at all, so a gate that trusted the answer alone would never settle and
application admission stayed held; the bounds are what turn that silence into a retryable refusal
instead of an unquittable application. `test/main/close-outcome-deadline.test.ts` pins each row:
`unknown` rather than a wait, the released reservation that lets a later attempt ask again, and
`closed` from the fact alone.

**Busy evidence is authoritative, and it is never guessed.** Live-use reads cover attachment
authority, run states, in-flight admitted operations and verified agent affinities. An
unreadable, malformed or silent answer is `unknown`, never idle; an idle window process is not
evidence of agent activity, and a terminal whose state cannot be read is unknown rather than
idle. The same rule governs membership: pages are read from the hosting tab authority, and an
attempt that cannot establish which pages a shell presents fails rather than proceeding on an
empty list. Before each measurement, bindings whose owner process is provably gone are released,
so a dead client cannot hold a window shut.

**Admission order.** One process-wide table (`PageCloseReservations`) serves every path that can
admit work onto a page. A close attempt reserves its member pages before it awaits anything, and
the application-wide reservation is consulted **before** the per-page reservation at every such
seam: attachment mint/rebind/adoption (`src/main/run/attachment-registry.ts`), capability
dispatch (`src/main/tools/capability-transport.ts`), the browser-control port's pool, wait and
viewport gates (`PassiveExecutionPool`, `WaitRegistry`, `ViewportGate` in
`src/main/tools/browser-control-port.ts`), and the host's agent-action entry points
(`NativeTabHost`'s shared `admitAgentAction` guard in `src/main/browser/native-tab-host.ts`). A
reserved page therefore refuses new bindings and new work instead of being bound and then
destroyed, and the operations that were admitted are what the busy snapshot counts. Refusals are
typed for the caller: `RUNTIME_DRAINING` while a quit holds application admission, `TARGET_STALE`
for a page reserved for close — and an admission state that cannot be read refuses the same way
instead of being taken as permission. An admitted agent action is registered against the page it
actually reaches, so the close that measures it counts real work rather than a process-wide
guess.

**Recovery.** Every refusal names the existing stop/release controls for the work that blocks it.
There is no force override and no force-close button; the user finishes or stops the named work
and retries, and a refused attempt releases its reservations so the retry is real. One refusal is
deliberately not an error: clearing the agent cursor refuses by returning a negative result
instead of throwing, because it doubles as a cancellation reached from teardown paths that must
not abort their ordered steps (`NativeTabHost.agentClear`). Closing one project window never
disposes another window, the shared services or the detached terminal daemon.

**One gate for the process.** An explicit Quit, the last browser shell going away and
`window-all-closed` all run the same attempt, and duplicates coalesce into the one in flight.
Services are torn down only after every native closure succeeded; a late veto keeps them and
reopens admission. The native close is prevented synchronously before any await, and a native
close is authorized only by the single-use authorization minted for the attempt that decided it,
so an unrelated event can never push a close through.

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
