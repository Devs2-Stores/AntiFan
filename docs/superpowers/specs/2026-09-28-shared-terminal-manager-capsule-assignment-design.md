# Shared Terminal Manager with capsule assignment — design

Status: decided with the user on 2026-09-28 and landing in the tree as this is written. This is the
target contract, not a release certificate: the route table, `windowSessionScope` and the sidebar's
context menu are the authority for what is wired. Code is cited by owning symbol and file rather than
by line, because this feature and those files were moving while it was written — search the symbol.

Date: 2026-09-28

## Intent

One terminal window lists the terminals of *many* projects, where a project is a capsule/storefront
(Comnieusiba, Phukienmymoc, …) plus the Chromium partition its pages run in. Without it, finding a
shell means switching windows and remembering which storefront owns it, because a window's sidebar
shows only the sessions its own owner key minted (`windowSessionScope`,
`src/main/browser/native-tab-host.ts`, applied by `isSessionVisibleToWindow` in the same file).

The manager removes that search without giving up the reason the scope exists: a shell created in
project B must not become writable from project A by accident. A person may still file a row under
another capsule, deliberately, from that row's own tab context menu.

## Decisions

1. **A superset view, not a second owner.** Ownership stays window-derived: the owner key remains the
   authority for who may list, read or write a session (`ownerKey`, `src/main/browser/window-owner.ts`).
   The manager widens what one window is *shown*; it does not change what ownership means.
2. **Assignment opens, then moves.** The row's project window is opened or focused first, and the move
   is only requested once that open reported `OPENED`/`FOCUSED` (`src/renderer/standalone.js`).
   A row is never filed under a window that does not exist; Main refuses the move when the target
   window is absent rather than creating one behind the renderer's back
   (`TARGET_WINDOW_ABSENT`, `src/main/browser/native-tab-host.ts`; the reason vocabulary the route
   answers with).
3. **Full control over project and unassigned rows, view-only over `agent:*`.** An agent's session is
   worth watching from the manager and must not be driven from it: the manager reads those rows and
   nothing more (`assertManagerMayOperate`, `src/main/browser/native-tab-host.ts`).
4. **The manager scope is reachable only from the manager window's own chrome renderer.** MCP and
   bridge callers keep today's behaviour — a caller that names no window is refused
   (`resolveTerminalCallerScope`, `src/main/tools/terminal-capabilities.ts`), and the
   capability plane never reaches the host's chrome routes.

The **manager** is the window whose shell owner is the `unassigned` sentinel
(`UNASSIGNED_OWNER_KEY`, `src/main/browser/native-tab-host.ts`; `WindowOwner`,
`src/main/browser/window-owner.ts`). It is the one owner that is not a project, at most one live
shell exists per owner key (`ProjectWindowManager.ensureWindow`,
`src/main/browser/project-window-manager.ts`), and only that window's own chrome may act as it
(`isSharedTerminalManagerSender`, `src/main/browser/native-tab-host.ts`; a page is never a chrome
surface, and a sender-less call is Main asking for the window itself, not a third party).

## The invariant this design relaxes

An owner key is minted once and never reassigned. `createSessionRecord` stamps
`effectiveCreationOwnerKey` (`src/main/browser/terminal-manager.ts`);
`startTerminal`, `createSession`, `restart` and `createSplitSession` (split inheritance included) all
carry the creating window's key, and every restore path writes back the *saved* key rather than the
caller's, which is why a restart cannot re-parent a row.

What the per-owner model forbids is **implicit** adoption: a window, a focus change or a capsule
switch silently re-parenting a shell it did not create. That failure is documented in the code it
broke — `setCapsule` keeps a session's workspace identity because adopting a foreign session
re-parented a live shell into another project's workspace and typed `Set-Location` into it mid-command
(`src/main/browser/terminal-manager.ts`).

A user-authorised handover is the opposite on every axis that mattered there: it is ordered by the
person looking at the row, it names both endpoints (session and capsule), and it types nothing into
the shell — no `cwd` change, no PTY write, no restart (`transferSessionOwner`,
`src/main/browser/terminal-manager.ts`). The capsule switch keeps its capsule-only rule
unchanged, and no implicit path gains the power to re-parent a session.

## Architecture

Four components, in the order one assignment travels.

### 1. Handover service (Main)

- **Channel and payload.** `TERMINAL_CHANNELS.ASSIGN_CAPSULE = 'antifan:terminal:assign-capsule'`
  (`src/shared/contracts.ts`) with `{ sessionId, capsuleId }`. The preload call is
  `assignTerminalCapsule(sessionId, capsuleId)` (`src/preload/standalone-preload.ts`).
- **Route.** A chrome route on `NativeTabHost.CHROME_ROUTES` whose surface allowlist is
  `['sidebar', 'terminalPopout']`, the allowlist its sibling capsule routes declare
  (`antifan:capsule:switch`, `src/main/browser/native-tab-host.ts`); a terminal popout of
  the manager window is that window's own chrome (`ownsChromeSender`, the same file). The route
  declares no `sessionArgs`: both ids arrive in the payload, so the handler checks the row itself and
  a caller that cannot see the session is answered with `SESSION_NOT_VISIBLE` rather than a refusal
  the router makes on its behalf (`assertManagerMayOperate` and `isSessionVisibleToWindow`, the same
  file).
- **Typed answer, never a throw.** `TerminalCapsuleAssignResult`
  (`src/main/browser/native-tab-host.ts`) settles as
  `{ ok: true, sessionId, capsuleId, ownerKey }` or `{ ok: false, reason, message }`, and the reasons
  are one vocabulary for Main and the renderer (`TerminalCapsuleAssignReason`, the same file):
  `INVALID_PAYLOAD`, `UNKNOWN_CAPSULE`, `CAPSULE_WITHOUT_PROJECT`, `TARGET_WINDOW_ABSENT`,
  `SESSION_NOT_VISIBLE`, `UNKNOWN_SESSION`, `MANAGER_AGENT_SESSION_READ_ONLY`. The refusals are what
  the renderer shows verbatim (`assignRefusalText`, `src/renderer/standalone.js`).
- **Admission.** The move is admitted as held work on the calling window's owner key
  (`admitThenRun`, `src/main/browser/native-tab-host.ts`; attribution carries `ownerKey`),
  the shape `antifan:capsule:switch` already uses, so a close or quit that starts mid-move measures
  the handover instead of a row changing hands underneath it. The design's intent is that this work
  reads as user-ordered rather than agent-generated; the tree admits it with the window's owner key
  and no reason field, so treat that label as intent until the admission port carries one.
- **Opening is the renderer's step, through the existing project route.** `api.openProject(projectId)`
  (`src/preload/standalone-preload.ts`) rides `PROJECT_WINDOW_CHANNELS.PROJECT_OPEN`
  (`src/main/index.ts`) onto `openProjectWindow`, which opens the shell, focuses the
  one that already exists, or reports `CANCELLED`/`FAILED` (`ProjectOpenResult`,
  `src/shared/contracts.ts`). The handover route itself never opens a window: Main refuses
  with `TARGET_WINDOW_ABSENT` when the target window is not there, which is the race guard, and the
  renderer's ordering rule is that only a reported open reaches the move
  (`src/renderer/standalone.js`).
- **Manager seam.** `TerminalManager.transferSessionOwner(sessionId, ownerKey, capsuleId): boolean`
  (`src/main/browser/terminal-manager.ts`) moves owner and capsule together; it refuses `false`
  for an unknown, disposed, closed, empty-keyed or empty-capsule call and never throws. The
  addressed id resolves to its tab's base (`direct.splitOf || sessionId`) and the whole family is
  re-stamped, written in one debounced pass and broadcast once — the shape `setCategory` already
  uses — because a pane carries its own key and would otherwise stay visible in the window its tab
  had just left.
- **Daemon path.** `HOST_METHOD.transferOwner = 'terminal.transferOwner'`
  (`src/main/terminal-daemon/protocol.ts`; `TransferOwnerParams` carries the three fields), dispatched
  by the daemon
  (`src/main/terminal-daemon/daemon-entry.ts`) onto its own `TerminalManager.transferSessionOwner`
  and exposed as `DaemonTerminalProxy.transferOwner` (`src/main/terminal-daemon/daemon-client.ts`),
  a `Promise<boolean>` — the async/sync seam the proxy documents for every manager call. The daemon
  stays the single writer of `terminal-sessions.json` (`statePath`,
  `src/main/browser/terminal-manager.ts`; shutdown flush, `src/main/terminal-daemon/daemon-entry.ts`).

### 2. Manager scope

One flag, in one place, and the two answers it feeds.

- `windowSessionScope(senderId?)` (`src/main/browser/native-tab-host.ts`) gains `managerAll`, decided
  by `isSharedTerminalManagerSender(senderId)`: the shell's own key must be `UNASSIGNED_OWNER_KEY` and
  the caller must be that window's chrome (a page is never a chrome surface). Everything that reads a
  terminal row on behalf of a window asks here.
- `isSessionVisibleToWindow` reads it: with `managerAll` every row passes the owner test, including an
  `agent:*` row (`AGENT_OWNER_KEY_PREFIX`; minted by `agentTerminalOwnerKey`,
  `src/main/browser/terminal-manager.ts`). `terminalStateForWindow` filters through that same
  predicate, so the sidebar projection, the `LIST_SESSIONS` list and `visibleTerminalSessions` widen
  together, as does the live output gate on the pushed session id. All four live in
  `src/main/browser/native-tab-host.ts`. One funnel; there is no second projection to drift out of
  step.
- **Control is the other answer.** `admitsSessionForWindow` (`src/main/browser/native-tab-host.ts`) is
  what the chrome router asks for every session a route names (`assertSessionScope`,
  `src/main/browser/ipc-router.ts`), and the manager's write gate `assertManagerMayOperate` refuses an
  `agent:` row with `MANAGER_AGENT_SESSION_READ_ONLY` before any manager call, returning the refusal
  instead of throwing so each route answers in its own contract: a boolean route answers `false`, a
  fire-and-forget channel logs it (`reportManagerWriteRefusal`), and the assign route replies with the
  code itself. The typed shape is `ManagerWriteRefusal`, in the same file. The owner class comes from
  the seam (`sessionOwnerKey`, `src/main/browser/terminal-manager.ts`; daemon-side cache,
  `src/main/terminal-daemon/daemon-client.ts`), so "view-only" is a predicate, not a mode: listed
  and streamed, never typed into, slept, killed or handed to another capsule.
- Nothing else widens. A project window keeps its own key, its legacy capsule tags and
  `acceptsUnclaimed`.

### 3. Renderer

- **Context-menu item.** `data-action="assign-capsule"` in the terminal tab context menu
  (`#tabContextMenu`, `src/renderer/standalone.html`), configured by `showContextMenu`
  (`src/renderer/standalone.js`) and served by the delegated click handler in the same file.
  The item is disabled — `is-disabled` plus `aria-disabled`, the same pattern the sleep and wake rows
  use — unless this shell is the shared manager and the row is not agent-held
  (`isSharedManagerShell`, reading the owner kind Main sent; `isAgentOwnedSession`). A
  disabled item says which of the two applies instead of opening a picker whose every answer would
  come back refused.
- **Picker.** `showCapsulePicker` (`src/renderer/standalone.js`) filters a popover
  (`capsulePickerPopover`, `src/renderer/standalone.html`) over the capsule inventory the switcher
  already reads (`listCapsules()`, `src/preload/standalone-preload.ts`; route `antifan:capsule:list`,
  `src/main/browser/native-tab-host.ts`), marks the session's current capsule and refuses to
  re-pick it, orders names for a Vietnamese reader, and shows a capsule that cannot be opened with its
  reason (`capsuleProjectIdOf`, the same renderer file). A capsule whose own record claims no project
  still gets one: Main resolves the affiliation additively onto the list it serves
  (`resolvedProjectId`, `antifan:capsule:list`, `src/main/browser/native-tab-host.ts`, over
  `resolveUniqueAffiliationByRoot`, `src/main/project/workspace-capsule.ts`), and the picker treats a
  capsule with no resolvable project as not pickable rather than offering a move Main would refuse.
- **One move per family, one local repaint.** A pane has no window of its own, so the move targets the
  base tab (`findSession(targetId)?.splitOf || targetId`) and the family travels with it;
  in-flight rows are guarded per base id. On success the row is filed locally and the authoritative
  re-render comes from Main's `session` push (`moveSessionToCapsuleLocally`, the same file).
- **Grouping.** The manager's list groups rows by capsule, so a mixed list stays readable. The strip's
  existing grouping is the category axis (`terminalCategories` / `terminalCollapsedCategories`,
  `src/main/browser/native-tab-host.ts`) and is a different one; capsule grouping does not
  reuse the category list.

### 4. Persistence

- The record shape does not change. `capsuleId` and `ownerKey` are already persisted fields
  (`SavedSession`, `src/main/browser/terminal-manager.ts`), written by
  `serializeSessionFragment` and read back verbatim by every restore path.
- The fragment cache compares `ownerKey` and `capsuleId` by value, so a move on an otherwise clean
  session still re-serializes; `schedulePersist(sessionId)` is the same debounced writer the
  category and sleep mutations use, and `emitSession` pushes the projection the two windows
  re-derive independently.
- Legacy rows written before owner keys existed keep the capsule rule; assigning one is what puts a
  real key on it. That upgrade happens only by explicit user action, and no restore path invents a key
  for a row that has none (the restore stamps are `item.ownerKey`).
- No migration is required in either direction: the file's shape and meaning are unchanged, so an
  older build reads a file a newer build wrote, and the only trace is an owner key that build already
  understands.

## Data flow: one assignment

1. The user opens the row's context menu in the manager window's sidebar; `showContextMenu`
   (`src/renderer/standalone.js`) draws the `assign-capsule` row, disabled unless this shell is
   the manager and the row is not agent-held (`isSharedManagerShell`).
2. The picker lists capsules from `listCapsules()` (`src/preload/standalone-preload.ts`) and answers
   with one capsule and the project whose window has to exist (`capsuleProjectIdOf`,
   `src/renderer/standalone.js`).
3. Step one — open or focus: `api.openProject(projectId)` (`src/preload/standalone-preload.ts`) →
   `PROJECT_WINDOW_CHANNELS.PROJECT_OPEN` (`src/main/index.ts`) → `openProjectWindow`,
   which creates the shell or presents the live one (`ensureProjectWindow`, same file, over
   `ProjectWindowManager.ensureWindow`, `src/main/browser/project-window-manager.ts`).
4. Only `OPENED`/`FOCUSED` continues (`ProjectOpenResult`, `src/shared/contracts.ts`); a
   cancelled or failed open leaves the row where it is and says why
   (`src/renderer/standalone.js`).
5. Step two — move: `assignTerminalCapsule(sessionId, capsuleId)`
   (`src/preload/standalone-preload.ts`) invokes `TERMINAL_CHANNELS.ASSIGN_CAPSULE`
   (`src/shared/contracts.ts`), with the family's base id because a pane has no window of its own
   (`assignSessionToCapsule`, `src/renderer/standalone.js`).
6. The router resolves the sender to its live shell (`setChromeSenderResolver`,
   `src/main/browser/ipc-router.ts`, installed once at `src/main/index.ts`) and enforces the
   route's surface allowlist.
7. The handler reads the capsule from the registry (`capsuleManager.get`, built on the same directory
   `antifan:capsule:list` serves), runs the manager write gate
   (`assertManagerMayOperate`, `src/main/browser/native-tab-host.ts`) and the visibility check, and
   admits the move as held work on the calling window's key (`admitThenRun`, the same file; the
   sibling shape in the capsule-switch route).
8. The capsule is resolved to the project window that must own the row (`capsuleOwnerKey` →
   `project:<projectId>` over `ownerKey`, `src/main/browser/window-owner.ts`), and that window must
   exist (`ownerWindowPresenceFor`). A capsule that resolves to no project is refused
   (`CAPSULE_WITHOUT_PROJECT`), and so is a target window that is not open (`TARGET_WINDOW_ABSENT`) —
   the same knownness rule `openProjectWindow` applies to a renderer-invented project
   (`src/main/index.ts`).
9. The move: `transferSessionOwner(sessionId, ownerKey, capsuleId)`
   (`src/main/browser/terminal-manager.ts`) re-stamps owner and capsule together. No `cwd`
   change, no PTY write, no restart.
10. Persistence and one broadcast: the row is scheduled into the debounced writer, serialized
    with both fields, and pushed by `emitSession` (`src/main/browser/terminal-manager.ts`). Each
    window re-derives its own view
    through `terminalStateForWindow` (`src/main/browser/native-tab-host.ts`), so the row leaves
    the manager's list and appears in the target window's sidebar from that single push.
11. In daemon mode the same call rides `terminal.transferOwner`
    (`src/main/terminal-daemon/protocol.ts`) to the daemon that holds the records
    (`src/main/terminal-daemon/daemon-entry.ts`), and `DaemonTerminalProxy.transferOwner`
    (`src/main/terminal-daemon/daemon-client.ts`) answers the same boolean as a Promise.

## Error handling

| Condition | Behaviour |
|---|---|
| Payload names no session or no capsule | `INVALID_PAYLOAD` (`src/main/browser/native-tab-host.ts`); no window is touched. |
| Capsule id unknown, or known but attached to no project | `UNKNOWN_CAPSULE` / `CAPSULE_WITHOUT_PROJECT` (same vocabulary); the renderer says so instead of opening a window. |
| Session unknown, disposed or closed | `UNKNOWN_SESSION`; the seam's `transferSessionOwner` would also answer `false` for the same case (`src/main/browser/terminal-manager.ts`). |
| The calling window cannot see the session | `SESSION_NOT_VISIBLE`: another project's row is not this window's to move. The route is not manager-exclusive — a window may still hand over its own row — but only the manager's scope reaches across projects. |
| Target window not open | `TARGET_WINDOW_ABSENT`: Main refuses rather than creating a window the renderer did not ask for. The renderer reaches this state only through a race it then reports. |
| The open step fails or is cancelled | Reported as a failed/cancelled open, no move is requested, and the row keeps its window (`src/renderer/standalone.js`). |
| Window identity mismatch while creating the shell | Fails closed rather than presenting another project's record under this key (`src/main/browser/project-window-manager.ts`). |
| An `agent:*` row | Listed by the manager, refused for control: `assertManagerMayOperate` answers `MANAGER_AGENT_SESSION_READ_ONLY`, and no route that names the session reaches a manager call. |
| A caller that is not the manager window's own chrome | Refused before the handler: a page is never a chrome surface, so no route resolves it to a shell, and the manager scope needs `isSharedTerminalManagerSender` on that window's key (`shellOwnerKeyForSender` reports the key, `src/main/browser/native-tab-host.ts`). MCP/bridge callers are refused for naming no window (`src/main/tools/terminal-capabilities.ts`). |
| Close or quit begins during the handover | The held admission (`admitThenRun`, `src/main/browser/native-tab-host.ts`) keeps the move visible as in-flight work; a route that gets there first answers `RUNTIME_DRAINING`/`TARGET_STALE`, which the renderer renders (`assignRefusalText`, `src/renderer/standalone.js`). |
| Daemon unavailable, or the call rejected in transit | The proxy rejects instead of answering and the renderer reports the failure; the daemon is the single writer, so the row keeps its old owner. A refusal, by contrast, resolves `false`/`{ ok: false }` — a refusal is not a transport failure (`src/main/terminal-daemon/daemon-entry.ts`). |

## Testing strategy

Acceptance intent, not case names: each lane below is the place that answers for it.

- **Main lane, handover and scope.** One lane owns the seam, the manager's width, the agent-row gate
  and the route's refusals: `test/main/terminal-assign-capsule.test.ts`. The neighbouring
  provenance lane is `test/main/terminal-daemon-provenance.test.ts`, and the older window-scope lanes
  are `test/main/native-tab-host-terminal-window-ownership.test.ts` and
  `test/main/per-tab-terminal-session.test.ts`.
- **Daemon lane.** `transferOwner` must answer the same boolean as the in-process call, refusal
  included, and a transport failure must stay a rejection rather than a `false`
  (`src/main/terminal-daemon/daemon-entry.ts`). `test/main/terminal-daemon-client.test.ts` is the
  facade lane.
- **Refusals.** A foreign window's sidebar sender, a page sender, and the agent plane
  (`src/main/tools/terminal-capabilities.ts`) are the three callers that must stay refused.
- **Pinned lists.** `test/main/chrome-ipc-routes.test.ts` pins the surface taxonomy, the route count
  and the renderer/preload file→surface map, so the new route moves the count and must keep the
  allowlist `['sidebar', 'terminalPopout']` (read the current number from the test, not this
  document).
- **Renderer.** `loadStandalone({ contextMenuActions: ['assign-capsule'] })`
  (`test/renderer/standalone-harness.ts`, which seeds the menu rows before the script runs) is how the
  item is driven: the picker's search, the disabled state for an agent-held row, the cancelled-open
  path and the refusal text all read through that harness.
- **Live smoke, two windows.** `test/e2e/terminal-capsule-assign.test.ts` runs the real app: the
  manager plus one project window, a row assigned across them, the row leaving one sidebar and
  appearing in the other with its PTY alive, and a window-less caller still refused. The
  renderer-only smoke shape stays in `test/e2e/terminal-renderer-smoke.cjs`.

## Rollback

Revert in this order: the renderer item and its preload call, then the route (its `CHROME_ROUTES`
entry), then `managerAll` with the manager write gate, then the seam and its daemon method. Each step
stands alone: without the route nothing calls the seam, and without `managerAll` the manager window is
an ordinary Unassigned window again.

No migration is required in either direction, because the record shape and both persisted fields
predate this design and every restore path already reads them. Rows already moved stay moved: they are
ordinary owner-keyed rows, and no part of this design promises to put them back.

## Owning sources

| Question | Owner |
|---|---|
| Who may list, read or write a session? | `windowSessionScope` / `isSessionVisibleToWindow` / `admitsSessionForWindow`, `src/main/browser/native-tab-host.ts` |
| Who is the manager, and which row may it drive? | `isSharedTerminalManagerSender` / `assertManagerMayOperate`, `src/main/browser/native-tab-host.ts` |
| Who may move a row, and what a move changes | `TerminalManager.transferSessionOwner`, `src/main/browser/terminal-manager.ts` |
| What a session's owner is on disk | `SavedSession` + `serializeSessionFragment`, `src/main/browser/terminal-manager.ts` |
| Which surface may call which channel | `NativeTabHost.CHROME_ROUTES` + `src/main/browser/ipc-router.ts` |
| Which window a project opens | `openProjectWindow` / `ensureProjectWindow`, `src/main/index.ts` |
| What the agent plane may do to a terminal | `src/main/tools/terminal-capabilities.ts` |
| The daemon's half of the move | `src/main/terminal-daemon/protocol.ts`, `daemon-entry.ts`, `daemon-client.ts` |
