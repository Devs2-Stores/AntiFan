# Project Windows for solo local development

Status: design accepted for deep implementation planning by the user's --deep --advice request. No product implementation approval or runtime certification.
Date: 2026-09-27

## Outcome and decision

A solo developer working across 3–5 projects and 10–20 Chromium tabs can keep project A and project B visible simultaneously on different monitors, identify which project owns each window and tab, and let agents work without stealing focus or changing another session's target.

The user confirmed three monitors, normally maximized windows, and a need to see different projects simultaneously. The approved direction is one browser window per project, sharing the application runtime. A project selector filtering one browser window cannot satisfy simultaneous visibility; an accordion does not supply independent monitor surfaces.

This supersedes [the single-window design](2026-09-27-project-focused-browser-design.md). It also supersedes recommendations and numeric confidence scores in `../../../plans/reports/260927-0916-tab-management-research.md`. The five-candidate ultra review rejected all candidates; it did not certify this choice. The subsequent user confirmation supplied the missing simultaneous-visibility requirement. No monitor allocation to IDE, terminal or browser is assumed.

## Current evidence and design boundary

Planning-time observations, recorded before implementation. They are the design's starting point,
not a claim about the current tree; where implementation superseded one, that is said so here
rather than left to read as present tense.

- The global `mainWindow`/`tabHost` pair and a `NativeTabHost` constructed against one window were
  the boundary this design had to cross. **Superseded by implementation:** there is no `mainWindow`
  in `src/main/index.ts` any more. Project presentation is one `ProjectWindowShell` plus its own
  `NativeTabHost` per owner, created by `ensureProjectWindow`; chrome IPC is registered once for
  the process (`src/main/browser/ipc-router.ts`) and resolved per sender, because registering it
  per host made the second window re-register every channel.
- The benchmark keep-alive guard (see `refusesWindowClose` in `src/main/index.ts`) is a benchmark
  protection, not evidence of the agent-aware close protection this design proposes.
- `docs/ui-architecture.md` §Scope Rules separates visual selection from bound execution and keeps
  durable state in Main. At planning time its surface hierarchy described one main browser window
  plus terminal popouts; popouts never proved browser multi-window support, and the hierarchy has
  since been reconciled with the shipped per-owner windows.
- `docs/ui-architecture.md` §Window And Layout Model defines the 960x640 DIP supported minimum and
  Main-owned native bounds, including split-review layout.
- Earlier source inspection identified capsule fallback, optional `isolateSession` partitioning,
  and terminal mutation during capsule switching. These remain planning investigation inputs, not
  proof that every creation path was defective; the plan traced the actual adapters and callers
  before proposing changes.

Requirements below describe the intended behavior, not existing verified capabilities. The
implementation plan must reconcile the owning architecture documentation with the completed
implementation; this design does not rewrite current-runtime documentation prematurely.

## UX contract

### Opening and identifying projects

An explicit Open Project action opens that project's window. If it is already open, restore and activate the existing window instead of creating another. Main serializes concurrent opens for the same stable project identity so double-clicks and concurrent requests cannot create duplicates.

Each title bar identifies its project. Duplicate names are disambiguated with a workspace-path label. A window shows only that project's visible browser tabs and its scoped tool projections. An empty project shows an empty browser state and an explicit new-tab action, never another project's page or an automatically created hidden page.

There is no project-filter/All mode for the main tab strip and no accordion-first navigation. Reuse the existing project-opening surface, not a second project registry. A cross-project tab search control is available from every project window and Unassigned window. It searches the Main-owned user-visible tab inventory by literal case-insensitive title or URL, labels results by project/path, and excludes hidden automation surfaces. Keyboard arrows select results, Enter activates, and Escape dismisses and returns focus. Selecting a foreign project's result explicitly restores and focuses the owning window and activates that exact live tab; selecting an Unassigned result focuses Unassigned. Revalidate at activation; a stale result reports unavailable without activating a different tab. This explicit user action may focus another window; agent actions may not.

### Placement and restoration

Persist normal window bounds and maximized state per stable project identity. Explicitly reopening a project restores that placement when the display is available. When a display is removed, restore or move affected windows into a remaining display's usable work area with reachable controls. Handle differing display scale factors in DIP; never restore an unreachable title bar.

Each project window has independent active-tab, native bounds and split-review presentation state. Minimize, resize or move of A must not change B's layout. On reopening, use existing saved browser metadata and restore rules; reopening a URL is not recovery of unsaved form state. Do not add automatic launch of every historical project.

### Agent and background behavior

Agent-created tabs and navigation use trusted caller/binding context, not the foreground window. Work for B remains in B while the user types in A. Agent work does not activate a window, unminimize it, raise it or change the user's active tab.

If an authoritative request needs a project window that is not open, creation may initialize that window without activation. A missing or stale target still receives existing target errors; creating a replacement window is not permission to silently recreate or retarget a lost page.

Activity labels are derived from authoritative attachment/run state. Unknown is shown when evidence is insufficient. Transport disconnect is not task completion and does not close user-visible tabs. Project affiliation never broadens session control rights.

### Unassigned pages

Unresolved historical or genuinely unassigned user-visible pages remain reachable in one clearly labeled Unassigned browser window, created only when needed. It is not a project and grants no authority. Do not guess affiliation from URL, title or foreground state. Conflicting trusted identities fail creation rather than silently falling back to Unassigned or the active project. Missing required authority retains existing failure semantics.

## Architecture and data flow

Keep four concepts separate:

1. Project identity and tab affiliation: Main resolves existing project/workspace/capsule relationships. These identifiers are not assumed interchangeable.
2. Window presentation: one live window per project, with window-local active page and layout state.
3. Execution authority: existing session ownership, attachments, target revisions and generation checks.
4. Shared services: application-level MCP/bridge, control plane and terminal management remain shared; opening a window does not start another server or duplicate singleton service registrations.

Main maintains project-to-window and tab-to-owning-window routing. Reuse existing registries and stable tab identities. Separate shared service ownership from per-window native presentation and disposal. The plan determines exact classes after tracing NativeTabHost responsibilities; this document does not prescribe constructing multiple current hosts without verifying their global listeners and disposal effects.

Every renderer IPC intention is validated against its sender and owning window. A renderer cannot select a foreign tab merely by supplying its ID. MCP operations route through the authorized exact tab and its owner, never mainWindow, focused window or globally active capsule as a fallback. User visual activation does not rotate agent attachment authority.

Affiliation is resolved before creating a page or choosing its storage partition. User new-tab requests use the sender's validated project; native window-open children inherit the source page's verified affiliation. Agent creation follows authenticated caller/bound context through adapters and adoption. Terminal working directories, workspace bindings and existing runs do not follow window focus. Do not use a capsule-switch operation that mutates terminal scope as a visual window switch.

Keep existing cookie/storage policy: project windows do not imply isolated sessions. Honor existing isolateSession behavior without migrating cookies or changing partitions of live pages.

## Closing and shutdown

Closing a project window is a request to close its user-visible pages and shell, not a synonym for hiding the window or terminating its agents. Minimize remains the way to retain its visible pages while moving it out of the way.

Main snapshots that window's visible tabs and checks all authoritative live-use owners, not terminal existence alone. If any page is busy or its use cannot be established, cancel the destructive close and show the affected pages with a reason. The user can finish or explicitly stop the relevant work through existing controls and retry. This design does not add a force-kill button to the window-close dialog.

For eligible pages, honor page unload vetoes. Revalidate identity, membership and busy status immediately before each close; close authorization and new bindings must be coordinated so a page cannot gain a binding after the final check and then be destroyed silently. New arrivals are outside the snapshot and keep the window open. Offscreen automation surfaces are not included.

A veto, new busy state or error keeps the remaining shell/pages available and reports the outcome. Earlier successfully closed pages cannot be guaranteed recoverable; do not promise transactional rollback or Undo. Destroy the window only once its eligible visible pages are gone and no new page arrived. Never retarget attachments to surviving pages.

Closing A does not dispose B, shared services or terminals. No tray/windowless engine mode is introduced. If shared work remains or is unknown, refuse final-browser-window destruction with a visible explanation and retain the shell. Explicit application Quit uses the same active-work and unload gate before orderly shutdown; no busy-work override is added. When all work is idle and unload allows closing, final-window close invokes orderly application quit on Windows, including disposal of remaining idle auxiliary windows. Forced OS termination/crash is outside this graceful-close guarantee.

## Errors and recovery

- A failed window initialization produces an explicit error and clears the incomplete project-window mapping; later explicit opening can retry. Do not fall back into another project's window.
- A closed/crashed tab or window preserves existing stale-target failure semantics. Recovery requires explicit valid targets, not matching URLs.
- A failed bounds restore uses an available display's usable area; no claimed restoration of unavailable hardware.
- Permission and ownership failures stay visible and fail closed. Unknown activity is not treated as idle for destructive operations.

## Owning surfaces for implementation planning

Trace current definitions, references and tests before choosing exact edits:

- `src/main/index.ts`: window construction, shared service startup, adapters, last-window handling and shutdown.
- `src/main/browser/native-tab-host.ts`: tab ownership, native views, IPC sender scope, capsule coupling, listeners and disposal.
- `src/main/tools/browser-control-port.ts`: bound creation, tab resolution and session checks.
- `src/main/project/workspace-capsule.ts`: identity relationships, saved tabs and partition policy.
- `src/renderer/toolbar.ts`, `src/renderer/toolbar.html`, `src/renderer/toolbar.css`: project identity, local tab actions and close feedback.
- `src/preload/toolbar-preload.ts`, `src/shared/contracts.ts`: minimal validated window-scoped projections and intentions.
- Existing project/workspace registries, window-state owner, split-review coordinators, attachment/run owners and terminal projections: locate exact references during planning; do not invent replacement owners.

## Non-goals

No arbitrary duplicate windows per project; no cross-project tab dragging; no new project registry; no new enterprise scheduler; no per-window MCP servers; no automatic tab eviction on inactivity or disconnect; no cookie migration; no same-project permission widening; no claim of RAM savings; no terminal redesign; no parallel implementation of accordion and single-window alternatives.

## Acceptance criteria

Exercise the real Electron application with five projects and twenty user-visible tabs, duplicate project/page names, two simultaneously visible project windows and background agents:

1. A and B remain visible on separate monitors and independently interactive. Opening A again activates its existing window; concurrent opens cannot duplicate it.
2. While typing in A, an agent bound to B creates and navigates a B tab without changing focus, active tab or A's terminal/workspace bindings.
3. Exact authorized MCP targets remain correct across window activation, minimize and restore. Cross-session target mismatches remain refused, including within one project.
4. User-created tabs and native children inherit the correct affiliation before page construction. Conflicting authority fails; unresolved historical tabs are reachable in Unassigned without guessed ownership.
5. Resize and desktop/mobile split review in A do not alter B's geometry. Background automation and screenshot/capture still work with truthful surface readiness.
6. Per-project bounds/maximized state survive reopen. Removing a monitor and changing display scale leave all windows recoverable on an available display.
7. Closing idle A leaves B, its targets, terminals and shared services intact. Unload veto leaves remaining pages accessible and reports any partial close.
8. Busy or unknown-use pages block destructive close. A new binding at the close boundary, or a new tab during confirmation, cannot be silently destroyed.
9. Final-window close and explicit Quit cannot silently terminate active shared work. With no active work and no unload veto, normal shutdown completes without duplicate servers or owned orphan processes.
10. Disconnect preserves user-visible pages and input state. Window/page failure returns stale-target errors rather than routing to another project.
11. Existing storage isolation settings remain unchanged; opening separate windows does not manufacture cookie isolation.
12. At 960x640 DIP and wide maximized sizes, project labels, controls and keyboard navigation remain usable without obscuring native browser bounds.

Permanent tests should cover duplicate-open serialization, sender scope, affiliation precedence, per-window disposal, close/binding races and placement recovery. Live smoke must demonstrate simultaneous windows, focus preservation, split capture, protected closing and orderly shutdown. No performance latency, UX success percentage or memory reduction is claimed without measurement.

## Acceptance receipts

An instrument, not a verdict: each criterion names what decides it, and `observed` names the run
artifact that exists for that instrument at the time of writing. `NONE` means no artifact exists
yet, for one of two reasons — the proof needs physical hardware or a human observer, or the named
instrument has not been run. Neither case is a pass, and no criterion is satisfied by a fixture or
a simulation standing in for hardware.

The two `observed` probes carry a timestamp and no source revision, and the close coordinator, the
window shell and the tab host were edited after they ran. A receipt therefore speaks for the
revision it ran against, never for whatever is on disk now: re-run the instrument once the tree
stops moving, and treat a receipt older than its subject as evidence of what worked, not as a
current certificate.

The phase-5 acceptance matrix (`scripts/probe-project-windows-matrix.cjs`) is the primary
instrument. Its rows are declared up front with the criterion each decides, a row is PASS only
with the values it observed, and a row whose judge never ran is emitted `BLOCKED` rather than
omitted. Its receipt path is
`plans/260927-0315-project-windows/reports/project-windows-matrix.json` (not yet produced at the
time of writing), and it runs in two phases because the post-exit orphan verdict (`R9E`) is a fact
that exists only after the process is gone.

| # | Proving instrument | Observed |
|---|---|---|
| 1 | matrix `R1`, `R0`; `test/e2e/project-windows.test.ts` (`window.duplicate-open-joins-existing-window`, `window.second-project-opens-with-own-authority`); `test/main/project-window-manager.test.ts` (concurrent open collapses to one window) | `reports/project-windows-probe.json` (join, per-window authority, sibling survival) |
| 1 — two physical monitors legible and interactive at once | matrix `R1-HW`, a declared hardware row | `NONE` |
| 2 | matrix `R2`; `test/main/close-live-use.test.ts` (an agent action on a page is visible as that page's work); `test/e2e/project-windows.test.ts` (`window.agent-intent-window-stays-unpresented`) | `reports/project-windows-probe.json` (agent window created with no presentation call) |
| 2 — a human typing in A under real OS foreground lockout | matrix `R2-HW`, a declared hardware row | `NONE` |
| 3 | matrix `R3a`, `R3b`, `R3c`; `test/integration/mcp-multi-tab-e2e.test.ts`; `test/main/browser-owner-target-revalidation.test.ts`; `test/e2e/project-windows.test.ts` (`window.minimize-restore-keeps-target-authority`, `window.same-project-sessions-cannot-cross-invoke`) | `NONE` |
| 4 | matrix `R4a`–`R4g`; `test/main/project-window-manager.test.ts` (Unassigned listed with its own key and label; a shell returned for a different owner fails closed); `test/main/project-window-persistence.test.ts` (`keeps the Unassigned window separate from project records`, `does not write an automation surface into the saved strip`); `test/main/window-state.test.ts` (legacy file migrates into the Unassigned record); `test/unit/native-tab-capsule-affiliation.test.ts` (a new page's capsule: measured → own window → process-wide, blanks never shadow) | `reports/project-windows-matrix.json` (`R4a2`/`R4b`: a tab created in a window whose capsule is not the active one carries its own window's capsule, and a `window.open` child carries its opener's; the pre-fix pair `reports/project-windows-matrix-before-capsule-fix.json` records both rows failing with the other window's capsule) |
| 5 | matrix `R5a`, `R5b`; `test/unit/browser/project-window-layout.test.ts`; `test/main/project-window-manager.test.ts` (capture readiness for an attached view without presenting the window); `test/e2e/project-windows.test.ts` (`window.split-layout-independent`, `window.background-surface-and-capture-ready`) | `NONE` |
| 6 | matrix `R6a`; `test/main/window-state.test.ts` (work-area repair, display removal, scale change, per-owner records); `test/main/project-window-persistence.test.ts` | `NONE` |
| 6 — unplugging a physical monitor and changing the OS scale | matrix `R6-HW`, a declared hardware row; the state repair itself is unit-proven | `NONE` |
| 7 | matrix `R7`, `R8a`; `test/main/project-close-coordinator.test.ts`; `test/e2e/project-windows.test.ts` (`window.close-keeps-sibling-and-tabs`, `window.survivor-toolbar-and-accelerator-after-sibling-close`) | `reports/quit-coordination-probe.json` (closing one window disposes only it; a veto retains the shell with an honest partial report) |
| 8 | matrix `R8b`, `R8c`; `test/main/close-admission-seam.test.ts`; `test/main/close-live-use.test.ts`; `test/main/native-tab-host-close-disposal.test.ts`; `test/main/project-close-coordinator.test.ts` | `reports/quit-coordination-probe.json` (a binding attempted during unload is refused; a tab arriving during the close survives) |
| 9 | matrix `R9a`, `R9b`, `R9c`, `R9d`, `R9E`; `test/main/project-close-coordinator.test.ts` (quit refused while runs are queued or awaiting; orderly commit for an idle final shell) | `reports/quit-coordination-probe.json` (refused queued quit with services still answering; the last shell drives the same gate to an orderly exit; ordered teardown ran once) — detached-daemon identity (`R9c`) and post-exit orphans (`R9E`) still need the matrix run |
| 10 | matrix `R10a`, `R10b`; `test/main/browser-owner-target-revalidation.test.ts`; `test/main/attachment-runtime-scoping.test.ts` | `NONE` |
| 11 | matrix `R11`; `test/e2e/project-windows.test.ts` (`window.native-popup-inherits-window-affiliation`, asserting the `persist:` partition and that a popup never inherits another window's capsule, with the process-wide active capsule rotated to the other window's for the duration of the row) | `reports/project-windows-e2e.json` (the popup's capsule, its opener's and its window's are the same, while the active capsule during the popup is the other window's) |
| 12 | matrix `R12a`, `R12b`; `test/main/window-state.test.ts` (titlebar controls reachable in a work area smaller than the window) | `NONE` |
| 12 — visual and physical-keyboard reachability at 960x640 | `test/e2e/project-windows.test.ts` declares this as a deferred row rather than simulating it | `NONE` |
| Search supplement | matrix `S1`, `S2`, `S3`; `test/renderer/project-tab-search.test.ts`; `test/main/project-window-persistence.test.ts` (search inventory and activation, stale result refused); `test/e2e/project-windows.test.ts` (`window.search-*`) | `reports/project-windows-probe.json` (inventory lists every window's tabs; activation presents the exact foreign tab; stale result refused with no substitute) |

The permanent-test areas this design names are owned by the close/admission lane
(`test/main/project-close-coordinator.test.ts`, `close-admission-seam.test.ts`,
`close-live-use.test.ts`, `auxiliary-window-close.test.ts`,
`native-tab-host-close-disposal.test.ts`, `project-window-shell-disposal.test.ts`),
the window lane (`project-window-manager.test.ts`, `tab-authority-directory.test.ts`,
`project-window-persistence.test.ts`, `window-state.test.ts`), and the live lane
(`test/e2e/project-windows.test.ts`, `scripts/probe-project-windows.cjs`,
`scripts/probe-quit-coordination.cjs`, `scripts/probe-project-windows-matrix.cjs`). The
close/quit probes are run directly through `scripts/run-electron.cjs`; they are deliberately not
package-script lanes, and an unrun probe proves nothing.

## Risks and review gate

The principal implementation risk is global ownership currently embedded in mainWindow/NativeTabHost, including IPC listeners, active capsule, adapters and shutdown. A project window must not become a second execution authority. Plan these boundaries together; do not patch only the visible tab strip.

Independent windows retain Chromium memory costs. Three monitors prove available display space, not hardware capacity or universal UX superiority. Native unload may produce partial closure, and restoring URLs cannot recover unsaved forms. Terminal popouts are not validation of browser multi-window behavior.

The user requested deep advisory planning after reviewing the revised specification. The implementation plan requires its own review and execution-method selection before product edits. No further product choice is required to prepare that plan; unresolved technical details above must be traced and verified there.
