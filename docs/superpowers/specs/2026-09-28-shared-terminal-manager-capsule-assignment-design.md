# Shared Terminal Manager with capsule assignment — design

Status: decided with the user on 2026-09-28 and landing in the tree as this is written. This is the
target contract, not a release certificate: the route table, `windowSessionScope` and the sidebar's
context menu are the authority for what is wired. Code is cited by owning symbol and file rather than
by line, because this feature and those files were moving while it was written — search the symbol.

Date: 2026-09-28

Revised in place: the transfer currency is the canonical `projectId` Main resolves itself. The picker
posts the project the person chose and Main turns it into the destination (`resolveProjectAssignment`,
`src/main/index.ts`), so the capsule stamp a row ends up with is derived from that resolution rather
than named by the renderer — one validated claim stamps its capsule, a known project no capsule record
names clears the stamp, and an ambiguous claim is refused rather than guessed. The same cutover added
terminal-link routing: a link opens in the window that owns the session, never in the focused window
and never in the system browser (`TERMINAL_CHANNELS.OPEN_LINK`, `src/shared/contracts.ts`;
`openTerminalLinkInOwner`, `src/main/index.ts`). The live contract this design belongs to is the
**Scope Rules** section of `docs/ui-architecture.md`; the semantics decided here — ownership, the
manager's scope, agent rows read-only, no implicit adoption — are unchanged.

## Intent

One terminal window lists the terminals of *many* projects, where a project is a capsule/storefront
(Comnieusiba, Phukienmymoc, …) plus the Chromium partition its pages run in. Without it, finding a
shell means switching windows and remembering which storefront owns it, because a window's sidebar
shows only the sessions its own owner key minted (`windowSessionScope`,
`src/main/browser/native-tab-host.ts`, applied by `isSessionVisibleToWindow` in the same file).

The manager removes that search without giving up the reason the scope exists: a shell created in
project B must not become writable from project A by accident. A person may still file a row under
another project's window, deliberately, from that row's own tab context menu — the row takes that
project's capsule stamp exactly when Main resolves one for it.

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
person looking at the row, it names both endpoints (session and destination project, whose capsule
Main derives), and it types nothing into the shell — no `cwd` change, no PTY write, no restart
(`transferSessionOwner`,
`src/main/browser/terminal-manager.ts`). The capsule switch keeps its capsule-only rule
unchanged, and no implicit path gains the power to re-parent a session.

## Architecture

Four components, in the order one assignment travels.

### 1. Handover service (Main)

- **Channel and payload.** `TERMINAL_CHANNELS.ASSIGN_PROJECT = 'antifan:terminal:assign-project'`
  (`src/shared/contracts.ts`) with `{ sessionId, projectId }`. The preload call is
  `assignTerminalProject(sessionId, projectId)` (`src/preload/standalone-preload.ts`). The id is one
  Main itself offered through the project inventory, never a capsule the renderer picked out of
  history.
- **Route.** A chrome route on `NativeTabHost.CHROME_ROUTES` whose surface allowlist is
  `['sidebar', 'terminalPopout']`, the allowlist its sibling capsule routes declare
  (`antifan:capsule:switch`, `src/main/browser/native-tab-host.ts`); a terminal popout of
  the manager window is that window's own chrome (`ownsChromeSender`, the same file). The route
  declares no `sessionArgs`: both ids arrive in the payload, so the handler checks the row itself and
  a caller that cannot see the session is answered with `SESSION_NOT_VISIBLE` rather than a refusal
  the router makes on its behalf (`assertManagerMayOperate` and `isSessionVisibleToWindow`, the same
  file).
- **Typed answer, never a throw.** `TerminalProjectAssignResult`
  (`src/main/browser/native-tab-host.ts`) settles as
  `{ ok: true, sessionId, projectId, ownerKey, capsuleId? }` or `{ ok: false, reason, message }`, and
  the reasons are one vocabulary for Main and the renderer (`TerminalProjectAssignReason`, the same
  file): `INVALID_PAYLOAD`, `PROJECT_UNAVAILABLE` (a project no record resolves, or one whose capsule
  claims do not resolve to exactly one), `TARGET_WINDOW_ABSENT`, `SESSION_NOT_VISIBLE`,
  `UNKNOWN_SESSION`, `MANAGER_AGENT_SESSION_READ_ONLY`. The answer's `capsuleId` is the resolution
  echoed back, present only when Main found one; absent means the stamp was cleared, not that the
  move failed. The refusals are what the renderer shows verbatim (`assignRefusalText`,
  `src/renderer/standalone.js`).
- **Destination resolution is Main's, not the caller's.** The route asks the injected resolver for
  the project (`projectAssignmentFor` over `setProjectAssignmentResolver`,
  `src/main/browser/native-tab-host.ts`); Main installs `resolveProjectAssignment(projectId)`
  (`src/main/index.ts`) — exactly one capsule with a validated affiliation answers `{ capsuleId }`, a
  known project that no capsule record names answers `{}` so the transfer clears the workspace stamp,
  and two or more claims, or a claim whose affiliation does not validate, answer `undefined`, which
  the route refuses as `PROJECT_UNAVAILABLE`. A host with no resolver refuses the same way, so an
  unwired composition cannot guess a destination.
- **Sibling route: a terminal's link.** `TERMINAL_CHANNELS.OPEN_LINK = 'antifan:terminal:open-link'`
  (`src/shared/contracts.ts`) carries `{ sessionId, url }` from
  `openTerminalLink(sessionId, url)` (`src/preload/standalone-preload.ts`), on the same surface
  allowlist, and answers `TerminalProjectLinkResult` — `{ ok: true, sessionId, ownerKey }` or
  `{ ok: false, reason, message }` (`src/main/browser/native-tab-host.ts`), never a fallback
  instruction. Its own vocabulary (`TerminalProjectLinkReason`, the same file) is `INVALID_PAYLOAD`
  (a missing id, or a URL outside the set the host may navigate to), `MANAGER_AGENT_SESSION_READ_ONLY`,
  `SESSION_NOT_VISIBLE`, `UNKNOWN_SESSION`, `TERMINAL_OWNER_UNAVAILABLE` (the row belongs to an
  `agent:` key, so no project window can claim it) and `TARGET_WINDOW_ABSENT`. The handler resolves
  the session's owner key from the seam and calls the injected opener
  (`terminalLinkOpener` / `setTerminalLinkOpener`, the same file); Main installs
  `openTerminalLinkInOwner(ownerKey, url)` (`src/main/index.ts`), which opens the tab in the window
  that key names, ensuring that window exists when it can rather than borrowing the focused one. It is
  owner-keyed, never focused-window-keyed, and never falls back to the system browser: a host without
  an opener refuses rather than delegating. The renderer side is wired to that answer and to nothing
  else: a pane's link handler offers every clicked URL to this route with the pane's own session id
  (`attachWebLinksAddon` → `openTerminalLinkFromPane`, `src/renderer/standalone.js`) and reports the
  refusal — `message`, a malformed answer, a bridge rejection, or a preload that lacks the method —
  through the terminal notice. It never opens the tab itself, so a refusal cannot land in the focused
  window.
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
- **Manager seam.** `TerminalManager.transferSessionOwner(sessionId, ownerKey, capsuleId?): boolean`
  (`src/main/browser/terminal-manager.ts`) moves owner and capsule together; it refuses `false`
  for an unknown, disposed, closed, empty-keyed or empty-capsule call and never throws. An
  *omitted* `capsuleId` is the clearing move — the row is left with no workspace stamp, which is
  what a transfer into the workspace-less built-in project needs — while a present-but-empty one is
  still refused (`''` would attribute the row to nothing while looking like a stamp). The
  addressed id resolves to its tab's base (`direct.splitOf || sessionId`) and the whole family is
  re-stamped, written in one debounced pass and broadcast once — the shape `setCategory` already
  uses — because a pane carries its own key and would otherwise stay visible in the window its tab
  had just left.
- **Daemon path.** `HOST_METHOD.transferOwner = 'terminal.transferOwner'`
  (`src/main/terminal-daemon/protocol.ts`; `HostTransferOwnerParams` carries the three fields, `capsuleId`
  optional), dispatched by the daemon
  (`src/main/terminal-daemon/daemon-entry.ts`) onto its own `TerminalManager.transferSessionOwner`
  and exposed as `DaemonTerminalProxy.transferSessionOwner` (`src/main/terminal-daemon/daemon-client.ts`),
  a `Promise<boolean>` — the async/sync seam the proxy documents for every manager call, and the name
  the manager itself publishes, so a singleton installed as this proxy answers the route's call. The
  daemon stays the single writer of `terminal-sessions.json` (`statePath`,
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
  and streamed, never typed into, slept, killed or handed to another project's window.
- Nothing else widens. A project window keeps its own key, its legacy capsule tags and
  `acceptsUnclaimed`.

### 3. Renderer

- **Context-menu item.** `data-action="assign-capsule"` in the terminal tab context menu
  (`#tabContextMenu`, `src/renderer/standalone.html`), configured by `showContextMenu`
  (`src/renderer/standalone.js`) and served by the delegated click handler in the same file.
  The item is disabled — `is-disabled` plus `aria-disabled`, the same pattern the sleep and wake rows
  use — for an agent-held row, and its title says so (`isAgentOwnedSession`) instead of opening a
  picker whose every answer would come back refused. Every other row is offered, from the shared
  manager and from a project window alike: a window may hand over its own row, and it is Main that
  refuses the rows a window cannot see (`SESSION_NOT_VISIBLE`,
  `src/main/browser/native-tab-host.ts`), so the menu does not duplicate the scope rule.
- **Picker.** `showCapsulePicker` (`src/renderer/standalone.js`) filters a popover
  (`capsulePickerPopover`, `src/renderer/standalone.html`) over Main's project inventory — the same
  `listProjects()` the Open Project picker reads (`PROJECT_WINDOW_CHANNELS.PROJECT_LIST`,
  `src/preload/standalone-preload.ts`), never the historical capsule store. Each row carries the
  project it stands for and the canonical capsule Main resolved for it (`data-project-id` /
  `data-capsule-id`); the session's current owner is marked and refused as a destination, names are
  ordered for a Vietnamese reader, and a row Main reports unpickable is painted disabled with the hint
  `hồ sơ dự án không rõ ràng` and carries no click handler, instead of offering a move Main would
  refuse (`canAssignTerminal`, `ProjectOpenListCandidate`, `src/shared/contracts.ts`). The chosen row's
  `projectId` is what the flow sends (`capsuleProjectIdOf`, the same renderer file).
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

1. The user opens the row's context menu; `showContextMenu` (`src/renderer/standalone.js`) draws the
   `assign-capsule` row, disabled only for an agent-held row (`isAgentOwnedSession`).
2. The picker reads Main's project inventory (`api.listProjects()`,
   `PROJECT_WINDOW_CHANNELS.PROJECT_LIST`, `src/preload/standalone-preload.ts`) and answers with the
   destination `projectId` the user chose (`capsuleProjectIdOf`, `src/renderer/standalone.js`) — the
   project whose window has to exist. A row Main reports unpickable is painted blocked and stays
   unclickable.
3. Step one — open or focus: `api.openProject(projectId)` (`src/preload/standalone-preload.ts`) →
   `PROJECT_WINDOW_CHANNELS.PROJECT_OPEN` (`src/main/index.ts`) → `openProjectWindow`,
   which creates the shell or presents the live one (`ensureProjectWindow`, same file, over
   `ProjectWindowManager.ensureWindow`, `src/main/browser/project-window-manager.ts`).
4. Only `OPENED`/`FOCUSED` continues (`ProjectOpenResult`, `src/shared/contracts.ts`); a
   cancelled or failed open leaves the row where it is and says why
   (`src/renderer/standalone.js`).
5. Step two — move: `assignTerminalProject(baseId, projectId)`
   (`src/preload/standalone-preload.ts`) invokes `TERMINAL_CHANNELS.ASSIGN_PROJECT`
   (`src/shared/contracts.ts`), with the family's base id because a pane has no window of its own
   (`assignSessionToCapsule`, `src/renderer/standalone.js`).
6. The router resolves the sender to its live shell (`setChromeSenderResolver`,
   `src/main/browser/ipc-router.ts`, installed once at `src/main/index.ts`) and enforces the
   route's surface allowlist.
7. The handler asks the host's resolver what the project resolves to (`projectAssignmentFor`,
   `src/main/browser/native-tab-host.ts`, installed by Main as `resolveProjectAssignment`,
   `src/main/index.ts`), runs the manager write gate
   (`assertManagerMayOperate`, `src/main/browser/native-tab-host.ts`) and the visibility check, and
   admits the move as held work on the calling window's key (`admitThenRun`, the same file; the
   sibling shape in the capsule-switch route).
8. The project id becomes the destination owner key (`ownerKey({ kind: 'project', projectId })`,
   `src/main/browser/window-owner.ts`), and that window must exist (`ownerWindowPresenceFor`): a
   target window that is not open is refused `TARGET_WINDOW_ABSENT` — the same knownness rule
   `openProjectWindow` applies to a renderer-invented project (`src/main/index.ts`). Ambiguity never
   reaches this step: a project Main cannot resolve, or one whose capsule claims do not resolve to
   exactly one, was already refused `PROJECT_UNAVAILABLE`.
9. The move: `transferSessionOwner(sessionId, ownerKey, capsuleId)`
   (`src/main/browser/terminal-manager.ts`) re-stamps owner and capsule together, the capsule
   omitted when the resolution found none — which clears the old stamp rather than re-pointing it. No
   `cwd` change, no PTY write, no restart.
10. Persistence and one broadcast: the row is scheduled into the debounced writer, serialized with
    the owner key and the resolved capsule when there is one, and pushed by `emitSession`
    (`src/main/browser/terminal-manager.ts`). Each
    window re-derives its own view
    through `terminalStateForWindow` (`src/main/browser/native-tab-host.ts`), so the row leaves
    the manager's list and appears in the target window's sidebar from that single push.
11. In daemon mode the same call rides `terminal.transferOwner`
    (`src/main/terminal-daemon/protocol.ts`) to the daemon that holds the records
    (`src/main/terminal-daemon/daemon-entry.ts`), and `DaemonTerminalProxy.transferSessionOwner`
    (`src/main/terminal-daemon/daemon-client.ts`) answers the same boolean as a Promise.

## Error handling

| Condition | Behaviour |
|---|---|
| Payload names no session or no project | `INVALID_PAYLOAD` (`src/main/browser/native-tab-host.ts`); no window is touched. |
| Project unknown to Main, or its capsule claims do not resolve to exactly one | `PROJECT_UNAVAILABLE` (same vocabulary): Main resolves the destination itself and refuses rather than guessing. The picker paints that destination unpickable, so the ordinary path never reaches the route; a claim that appears between the paint and the call is refused and reported to the user. |
| Session unknown, disposed or closed | `UNKNOWN_SESSION`; the seam's `transferSessionOwner` would also answer `false` for the same case (`src/main/browser/terminal-manager.ts`). |
| The calling window cannot see the session | `SESSION_NOT_VISIBLE`: another project's row is not this window's to move. The route is not manager-exclusive — a window may still hand over its own row — but only the manager's scope reaches across projects. |
| Target window not open | `TARGET_WINDOW_ABSENT`: Main refuses rather than creating a window the renderer did not ask for. The renderer reaches this state only through a race it then reports. |
| A destination project with no capsule record | Not a failure: the resolution answers `{}`, the move omits `capsuleId`, and the row keeps no workspace stamp — the transfer into the workspace-less built-in project. |
| The open step fails or is cancelled | Reported as a failed/cancelled open, no move is requested, and the row keeps its window (`src/renderer/standalone.js`). |
| Window identity mismatch while creating the shell | Fails closed rather than presenting another project's record under this key (`src/main/browser/project-window-manager.ts`). |
| An `agent:*` row | Listed by the manager, refused for control: `assertManagerMayOperate` answers `MANAGER_AGENT_SESSION_READ_ONLY`, and no route that names the session reaches a manager call. |
| A link click on a row the caller may read but no project window owns | The link route's own refusals (`TerminalProjectLinkReason`, `src/main/browser/native-tab-host.ts`): `TERMINAL_OWNER_UNAVAILABLE` for an `agent:`-owned row, `TARGET_WINDOW_ABSENT` when the click cannot be delivered to an owner — no opener installed, an owner key no window can be derived for, an unknown project, a rejected opener or a tab that could not be created. The click is answered, never redirected to the focused window and never handed to the system browser (`openTerminalLinkInOwner`, `src/main/index.ts`). A row the caller cannot see, or an agent row in the manager, is refused `SESSION_NOT_VISIBLE` / `MANAGER_AGENT_SESSION_READ_ONLY` exactly as the handover refuses them. |
| A caller that is not the manager window's own chrome | Refused before the handler: a page is never a chrome surface, so no route resolves it to a shell, and the manager scope needs `isSharedTerminalManagerSender` on that window's key (`shellOwnerKeyForSender` reports the key, `src/main/browser/native-tab-host.ts`). MCP/bridge callers are refused for naming no window (`src/main/tools/terminal-capabilities.ts`). |
| Close or quit begins during the handover | The held admission (`admitThenRun`, `src/main/browser/native-tab-host.ts`) keeps the move visible as in-flight work; a route that gets there first answers `RUNTIME_DRAINING`/`TARGET_STALE`, which the renderer renders (`assignRefusalText`, `src/renderer/standalone.js`). |
| Daemon unavailable, or the call rejected in transit | The proxy rejects instead of answering and the renderer reports the failure; the daemon is the single writer, so the row keeps its old owner. A refusal, by contrast, resolves `false`/`{ ok: false }` — a refusal is not a transport failure (`src/main/terminal-daemon/daemon-entry.ts`). |
| A session row with no `buffer`/`bufferBytes` (a malformed or foreign record: a hand-written fixture, a partially written revive blob) | Must not fault the readers. `getStats` and the per-session summary derive the length defensively — `session.bufferBytes ?? Buffer.byteLength(session.buffer \|\| '', 'utf8')` (`src/main/browser/terminal-manager.ts`) — because `Buffer.byteLength(undefined)` throws, and one such row fails `getStats` for the whole map, which blanks the projection for every window rather than for that row alone. Rationale: a superset view reads rows the manager window did not create, so it must tolerate a row it did not write. |

## Testing strategy

Acceptance intent, not case names: each lane below is the place that answers for it.

- **Main lane, handover, resolution and scope.** One lane owns the seam, the manager's width, the
  agent-row gate, the assign route's refusals (a `projectId` in; `PROJECT_UNAVAILABLE` for a project
  that is unknown or whose claims are ambiguous; the capsule-less destination that clears the stamp
  instead of re-pointing it) and the link route with its owner-keyed opener:
  `test/main/terminal-assign-capsule.test.ts`. The neighbouring provenance lane is
  `test/main/terminal-daemon-provenance.test.ts`, and the older window-scope lanes
  are `test/main/native-tab-host-terminal-window-ownership.test.ts` and
  `test/main/per-tab-terminal-session.test.ts`.
- **Daemon lane.** `transferOwner` must answer the same boolean as the in-process call, refusal
  included, and a transport failure must stay a rejection rather than a `false`
  (`src/main/terminal-daemon/daemon-entry.ts`). `test/main/terminal-daemon-client.test.ts` is the
  facade lane.
- **Refusals.** A foreign window's sidebar sender, a page sender, and the agent plane
  (`src/main/tools/terminal-capabilities.ts`) are the three callers that must stay refused.
- **Pinned lists.** `test/main/chrome-ipc-routes.test.ts` pins the surface taxonomy, the route count
  and the renderer/preload file→surface map — read the current number from the test, not this
  document — and `test/main/ipc-audit.test.ts` pins the preload↔host parity for the link route's
  payload. Both terminal routes this design adds (`ASSIGN_PROJECT` and `OPEN_LINK`) keep the allowlist
  `['sidebar', 'terminalPopout']`.
- **Renderer.** `loadStandalone({ contextMenuActions: ['assign-capsule'] })`
  (`test/renderer/standalone-harness.ts`, which seeds the menu rows before the script runs) is how the
  item is driven, and `test/renderer/terminal-capsule-picker.test.ts` is the flow's own lane: the
  inventory the picker reads on every open, the destination row Main resolved, the unpickable
  destination (clicked and asserted to hand nothing over), the disabled state for an agent-held row,
  the tab-not-pane target, the capsule-cleared destination, the cancelled-open path and the unreadable
  inventory.
- **Renderer, links.** The pane link handler is driven in `test/renderer/terminal-split-behaviour.test.ts`:
  a click is handed to the route with the pane's own session id and opens nothing locally, a typed
  refusal is rendered verbatim, an answer that is not an explicit success and a rejected bridge are
  both reported, and a preload without the method names itself instead of opening the tab in the
  focused window.
- **Live smoke, two windows.** `test/e2e/terminal-capsule-assign.test.ts` runs the real app: the
  manager plus project windows, a row moved by `projectId` through
  `assignTerminalProject` across them, the destination rows read from the same inventory
  `listProjects()` serves with the ambiguous one unpickable, the row leaving one sidebar
  and appearing in the other with its PTY alive, a closed target window refused
  `TARGET_WINDOW_ABSENT` before the renderer's open-then-assign flow lands the row, a capsule-less
  destination whose row keeps no workspace stamp, and a window-less caller still refused. The
  renderer-only smoke shape stays in `test/e2e/terminal-renderer-smoke.cjs`.

## Rollback

Revert in this order: the renderer item and its preload calls, then the routes (their `CHROME_ROUTES`
entries), then `managerAll` with the manager write gate, then the seam and its daemon method. The
link route comes out with the renderer handler that calls it — the handler prefers the route and the
notice over any local tab surface, so a route-free renderer needs the handler reverted in the same
step rather than left refusing every click. Apart from that pairing each step stands alone: without
the assign route nothing calls the seam, and without `managerAll` the manager window is an ordinary
Unassigned window again.

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
| What a `projectId` resolves to, and when it refuses | `resolveProjectAssignment` over `isKnownProjectId`, `src/main/index.ts`, installed as the host's resolver (`setProjectAssignmentResolver`, `src/main/browser/native-tab-host.ts`) |
| Where a terminal's link opens | `openTerminalLinkInOwner`, `src/main/index.ts`, over the `OPEN_LINK` route and `setTerminalLinkOpener`, `src/main/browser/native-tab-host.ts` |
| What the agent plane may do to a terminal | `src/main/tools/terminal-capabilities.ts` |
| The daemon's half of the move | `src/main/terminal-daemon/protocol.ts`, `daemon-entry.ts`, `daemon-client.ts` |
