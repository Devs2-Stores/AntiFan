# Phase 1 report — Detach capability

Status: DONE_WITH_CONCERNS (one deferred decision documented below; every
implemented surface compiles and its unit rows are green).

## What changed

### `src/shared/contracts.ts`
- `PROJECT_WINDOW_CHANNELS.PROJECT_DETACH: 'antifan:project:detach'` added beside
  `PROJECT_REMOVE` (~line 408).
- `ProjectDetachResult` (already present from planning): `DETACHED | FOCUSED |
  FAILED{reason}` — used verbatim; no parallel codes invented.

### `src/main/browser/native-tab-host.ts`
- `SavedTabsOwnerRecord.detached?: boolean` (field ~259): the persisted half of
  exclusivity; survives an ordinary window close.
- Normalizer whitelist (~475): `'detached' in value && === true` carried into
  the record, so a marked record survives `normalizeSavedTabsDocument` verbatim.
- `ownerRecordFromPersistData` (~13228): `record.detached = true` when
  `this.shell?.owner?.kind === 'project'` — the marker is written only by the
  owner itself, never by foreign records.
- `foldLegacyProjectOwnerRecords` (~13116): `if (legacy.detached === true)
  continue;` — marked `project:*` records are never absorbed into `owners.web`;
  unmarked legacy records still fold (migration compat).
- `savedTabsOwnerIsDetached(filePath, projectId)` exported (~630): reads +
  normalizes the document, answers `owners['project:<id>'].detached === true`;
  fails closed (`false`) on missing file, unreadable JSON, blank id, foreign id.
- `hubRowVisible` (~4713): `project:` rows are exempted from the hub exception
  while `host.detachedShellOwns(rowOwner.projectId)` answers live — a live
  detached shell's rows can no longer be silently re-homed by a hub-side
  `assign-project`. Unassigned/web rows keep the shipped exception.
- `detachedShellProbe` field + `setDetachedShellProbe`/`detachedShellOwns`
  (~1247, ~6776): Main's live-shell answer injected; absent probe = "no detached
  shells" (exactly the pre-detach world), probe exceptions fail closed.
- `stampProjectIdForMint(requested, isAgentSurface)` (~6874) + mint-gate rewire
  (~8449): explicit request wins (`null` mints shared on purpose); else the
  'web' hub's `activeProjectId`; else `parseOwnerKey(windowOwnerKey()).projectId`
  for `owner.kind === 'project'`; agent surfaces never stamp.
- `serializeProjectTabsForTransfer(projectId)` (~6893): persisted-shape rows via
  `sanitizeTabForPersistence` + `row.projectId` stamp, strip order preserved;
  `terminalAffinities` restricted to entries whose managed set moves whole;
  `activeSourceTabId` names the source's presented tab.
- `ingestTabRow` (~13914): the restore loop's per-row normalization extracted —
  `migratePersistedTab`, agent-surface skip, id remap, stamp/URL/title/preset/
  zoom/split/capsule re-application. `restoreTabs` now delegates to it.
- `ingestTransferredTabRows(rows, {terminalAffinities, activeSourceTabId})`
  (~13979): re-homes live rows without a disk round-trip; mints new ids;
  dedupes re-deliveries via `transferredSourceIds`; rebuilds affinities through
  the same `bindTerminalAgentAffinity`/`adoptChildTab` primitives; presents the
  source's active tab.
- `buildSavedTabsDocument` (~13258): `project:` owners merge `owners` and return
  early — document-level keys (bookmarks/sidebar/terminal prefs) stay exactly as
  the previous document carried them. Extends the `isTerminalOnlyWindow`
  precedent.

### `src/main/index.ts`
- `savedTabsOwnerIsDetached`, `savedTabsFilePath` imported (~47);
  `ProjectDetachResult` type imported (~116).
- `host.setDetachedShellProbe(...)` installed in `ensureProjectWindow` creation
  arm (~1628) and in `ensureDetachedProjectShell`.
- `activateWebHubProject` funnel guard (~1672): live detached shell OR marked
  record → `ensureDetachedProjectShell` (focus/recreate, fire-and-forget) +
  `CapabilityError('TRANSACTION_CONFLICT')` thrown — every project-presentation
  funnel (join arm, boot activation, `foreignProjectActivatedHandler`,
  `openProjectWindow`) fails closed.
- `focusShellWindow` (~1721): restore-if-minimized + show + focus.
- `ensureDetachedProjectShell(projectId, intent)` (~1730): join arm returns the
  live shell without re-wiring or `activateWebHubProject`; create arm runs the
  per-owner wiring template (`resolveWindowRecord` →
  `setWindowWorkspaceAffiliation` with refused-set clear →
  `ensureInitialWorkspace` → `windowStateManager.manage` → `attachShellLifecycle`
  → `restoreTabs` reading the `project:<id>` owner record →
  `attachSharedServices`); `assertApplicationAdmitsWork` guard retained.
- `transferHubProjectTabs` (~1798): serialize → null hub workspace affiliation →
  null hub presented scope (only when it presents this project) →
  `closeTabsForProject` → ingest arrived rows into the detached host.
  Affiliation is cleared BEFORE scope (ordering invariant), and both clears run
  before the close so a veto never leaves the hub presenting a project under a
  foreign affiliation; vetoed rows remain live in the hub.
- `detachProject(payload, parent)` (~1846): validates/known-checks the id
  (`isListedProjectId`), focuses a live detached shell instead of creating a
  second window (exclusivity), creates via `ensureDetachedProjectShell`, runs
  the hub transfer, answers `DETACHED | FOCUSED | FAILED` per the contract —
  `FAILED/DETACH_REFUSED` on tab-close veto, `FAILED/PROJECT_UNAVAILABLE` on
  unknown id, `FAILED/CAPABILITY_FAILED` on error.
- `openProjectWindow` (~2895): hoisted detached check above
  `ensureProjectWindow({kind:'web'})` — live shell focused / marked-but-dead
  recreated through `ensureDetachedProjectShell`; detached projects can never
  re-present on the hub, and no phantom hub window is created.
- Route row `PROJECT_DETACH` in `PROJECT_WINDOW_ROUTES` (~3058): `kind:
  'handle'`, `surface: ['toolbar','sidebar']` (deliberately not
  `PROJECT_OPEN_ROUTE_SURFACES` — `terminalPopout` can never drive a detach),
  `run` → `detachProject(args[0], senderWindowFor(event))`.
- `installApplicationMenu` (~1900): `detachProject` option wired — the menu
  click is project-scoped by the focused window's host.
- Probe authority surface (~4286): `detachProject(projectId)` added beside
  `ensureProjectWindow`, routing through the real entrypoint — never a bypass.

### `src/main/browser/app-menu.ts`
- `ApplicationMenuOptions.detachProject?: (projectId, window) => void` (~155).
- "Detach Project into Own Window" item (~338): enabled iff the callback is
  injected; click reads `hostForClick(focusedWindow)?.activeProject()` — a
  window presenting no project (unscoped hub, detached window, Terminal
  Manager) silently declines rather than sending a malformed request.

### `src/preload/standalone-preload.ts`
- `ProjectDetachResult` type import; `detachProject({projectId})` method
  invoking `PROJECT_WINDOW_CHANNELS.PROJECT_DETACH` (~67).

### `test/main/detached-project-window.test.ts` (new)
11 tests across 5 suites, `node:test` + scratch dirs + Electron stub +
env-before-require, matching the persistence lane's harness conventions.

## Test output

```
node --test .compiled/test/main/detached-project-window.test.js
▶ detached marker                4/4 ✔
▶ legacy project-record fold     1/1 ✔
▶ detached document-prefs gate   1/1 ✔
▶ mint stamp derivation          2/2 ✔
▶ live tab transfer              3/3 ✔
tests 11, pass 11, fail 0
```

### Regression lane

`npm run test:main` — green except one environmental flake:
`pairing-grant-authority.test.js` hit `PAIRING_TIMEOUT` (8 s challenge timeout
against a live local bridge) in the aggregate run; standalone rerun: 18/18
pass. That suite exercises the bridge pairing handshake, untouched by this
phase. Two stale pins were updated to the intentionally-changed behavior:
`web-hub-project-routing`'s "no stamp off the web shell" now asserts a detached
`project:` owner stamps its own id (`proj-legacy` in that fixture), and the two
`project-window-persistence` shared-pref fixtures moved from `project:` owners
to `web`/`unassigned` owners — the owners that still write document-level prefs
post-gate.

## Matrix row → evidence

| Spec row | Evidence |
|---|---|
| marker roundtrip | `detached marker` tests 1, 3; `legacy project-record fold` test |
| legacy fold compat | `legacy project-record fold` test (unmarked → owners.web, marked survives + written to disk) |
| fold-skip-marked | same test — `owners['project:proj-a']` survives verbatim with `detached:true` |
| exclusivity refuse shapes | `savedTabsOwnerIsDetached` fail-closed test (no file/corrupt/blank/foreign → false); funnel refuse is a thrown `CapabilityError('TRANSACTION_CONFLICT')`; veto → `FAILED/DETACH_REFUSED` — full-shape rows deferred to probe/e2e (phase-02/05) |
| stamp derivation | `mint stamp derivation` both tests — detached owner stamps, hub stamps active, explicit request wins, null/agent surfaces don't stamp |
| doc-prefs isolation | `detached document-prefs gate` test — hub bookmarks untouched, sibling records verbatim |
| live transfer | `live tab transfer` tests — row serialization, active-tab naming, whole-affinity restriction, ingest minting/dedup/present, agent-surface refusal |
| detach create/join/exclusivity live-shell arms | code in place (`ensureDetachedProjectShell`, `detachProject`, `openProjectWindow` hoist); runtime proof deferred to probe (authority method added) + phase-05 e2e |

## Concerns / deferred

- Veto semantics: on tab-close veto the hub's affiliation+scope are already
  cleared (ordering invariant kept) while vetoed tabs stay live-but-unscoped in
  the strip. `detachProject` answers `FAILED/DETACH_REFUSED` and the detached
  shell remains open with the moved tabs. Reattach/rollback is phase-02 scope.
- `openSpaceWindow` also funnels through `openProjectWindow`, so a detached
  folder's Space opens inside the detached shell — consistent with the
  detach-as-mode decision; probe/e2e coverage deferred.
- `stampProjectIdForMint` derives from the owner key — a `project:` shell's
  tabs are stamped even without an active scope, which is exactly the
  "tabsForProject(X)>0 on the detached host" criterion.
