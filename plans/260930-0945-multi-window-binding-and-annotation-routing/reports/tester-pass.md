# Tester pass — multi-window binding & annotation routing

Date: 2026-09-30. Scope: `plans/260930-0945-multi-window-binding-and-annotation-routing` diff in `E:/Work/apps/AntiFan`.

## Test Results Overview

| Suite | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| 25 specified suites (assigned blast radius) | 408 | 408 | 0 | 0 |
| `test:main` (broad, `.compiled/test/main/**/*.test.js`) | 2149 | 2136 | 12 | 1 |

Compile state confirmed fresh: every implicated `.compiled` emitter is newer than its `.ts` source. The failing tests run against code that mirrors current `src`.

## Changed files exercised green

`tab-devtools-host`, `native-tab-host` (close-disposal, agent-tab-reap, offscreen-surface, viewport, capsule-affiliation, presented-view, tab-closed-telemetry), `annotation`/`element-picker` (`element-picker-resolution`, `element-picker-targets`), `bridge` (`bridge-terminal-affinity`, `phase-01`, `phase-02`), `browser-control-port`/`app-menu`/`action-registry` (`render-surface-and-viewport-gates`, `capability-catalogue`, `control-plane-terminal-scope`, `agent-browser-script`), `tab-hibernation`, `tab-reaping`, `split-review`, `split-view-fixes-regression` — all green.

## Failures — all reproduce deterministically; all inside the working-tree diff

### Owned by the multi-window diff (assigned files)

**`chrome-ipc-routes.test.js` (2 fails)** — `native-tab-host.ts`
- Test 1: `Route table must contain exactly 122 routes` → actual 120. `git show HEAD` proves the diff removed the `antifan:tab:set-alias` + `antifan:tab:get-alias` routes and the whole alias subsystem (`setTabAlias`, `resolveAliasToTabId`, `inferTabSemanticRole`, `SPACE_OPEN` `spec.alias` write). Contract test unchanged. **Gap:** either restore the routes or drop the count to 120.
- Test 5: `on('antifan:project:inventory-changed')` — `standalone-preload.ts` (diff) added `onProjectInventoryChanged` but `pushChannels` allowlist in the (unchanged) test was not extended with `PROJECT_WINDOW_CHANNELS.PROJECT_INVENTORY_CHANGED`. Diff-owned; one-line test fix or the channel belongs in the allowlist by design.

**`ipc-audit.test.js` (1 fail)** — `native-tab-host.ts`, phase-5 telemetry
- `closeTab(id)` regex no longer matches: call is now `closeTab(id, 'view-close')` (planned `closeTab(tabId, source)` signature, phase-05 plan §21-51). Test pins old call wording; incidentally-worded assertion, needs regex update — behavior still closes the tab.

**`playwright-parity-kernel.test.js` (1 fail)** — `tab-devtools-host.ts`, phase-3
- Test 6 expects empty `capturePage` on an offscreen tab to fall back to CDP `Page.captureScreenshot`. Diff added an intentional fail-fast `CaptureError('NO_RENDER_SURFACE')` for offscreen targets (`tab-devtools-host.ts` +1881 hunk; phase-03 plan line 74: "OSR capture empty → typed error, no CDP fallback"). The new contract is verified by `tab-devtools-host.test.js` (passed). The parity test pins the *removed* behavior — stale test contract, not an impl bug. Needs rewrite to assert the typed error.

**`terminal-new-in-folder.test.js` (2 fails)** — `native-tab-host.ts`
- Both return `ok:false`. Reproduced in isolation: `{"ok":false,"reason":"CREATE_FAILED","message":"this.capsuleManager.uniqueAffiliationByRoot is not a function"}`. New `managerFolderMintOwnerKey` (native-tab-host.ts:1463) → `capsuleAffiliation` (:1455) calls `capsuleManager.uniqueAffiliationByRoot`, which the test's `RecordingCapsuleManager` fake (file unmodified, identical at HEAD) never implements. TypeError escapes the mint → `CREATE_FAILED`. **Diff-owned regression against a previously-green test**: add `uniqueAffiliationByRoot` to the fake (and `projectId`/`workspaceId` fields or an `affiliationAuthority`), or make the impl tolerate doubles missing it. Note: the manager path is exercised here because the fixture owner is `unassigned`.

### Owned by the adjacent force-close workstream (NOT the assigned file set)

`project-close-coordinator.ts` + `project-close-coordinator.test.ts` are modified in the tree (new `forceClose`/`forceRequests`, `closeSelf(force)`, `closePage(tabId, force)`) but are **not** among the assigned changed files — the force-close plumbing surfaces via `index.ts` (`forceCloseWindowForSender`/`FORCE_CLOSE_WINDOW`). All 6 failures live in that feature's own test file:

- `reserves the owner for the whole attempt` (:349), `reserves the owner across a close for a shell with no member pages` (:382), `commits an orderly quit…` (:722), `keeps services usable when an auxiliary vetoes` (:780): `FakeSurface.closeSelf` refactor **dropped `this.onCloseSelf?.()`**, so `shell:*` events and `isOwnerReserved` samples never fire. Test-harness bug in the diff — the hook must still run before the outcome.
- `keeps a refused normal close safe; force destroys only after explicit request` (:932): `forced.disposition` is `'retained'` (haltedBy `unload-veto`) — harness `closePage` records `force` but still returns scripted `'vetoed'`; either the fake must let `force` bypass scripted outcomes or the impl must not propagate the veto on a forced page close. Under-specified contract between impl and double.
- `never lets a renderer-supplied owner retarget the authorization contract` (:983): `forceClose('  ')` **throws synchronously** while `assert.rejects` awaits a rejection — `forceClose` is `public forceClose(...): Promise<CloseReport>` with a sync `throw` before the first await (native-tab-host.js twin shows same). Impl bug: make it async so the guard rejects.

## Recommendations

1. `chrome-ipc-routes` count → update to 120 **or** restore alias routes; decide per plan intent (alias removal is unplanned — no phase file mentions it).
2. Add `PROJECT_WINDOW_CHANNELS.PROJECT_INVENTORY_CHANGED` to the audit's `pushChannels` set (it is a genuine Main→renderer push; channel was already declared in contracts).
3. Update `ipc-audit` close regex to `closeTab\(id,` (or drop the wording pin entirely — it tests incidental spelling, not the close contract).
4. Rewrite `playwright-parity-kernel` test 6 to assert `CaptureError NO_RENDER_SURFACE` for offscreen targets; the CDP-fallback branch still needs a *non-offscreen* test to keep its coverage.
5. `terminal-new-in-folder`: extend `RecordingCapsuleManager` with `uniqueAffiliationByRoot` (return `undefined`) — the fake must mirror the new collaborator surface.
6. Force-close workstream (out of scope for this plan's files): restore `onCloseSelf` invocation in `FakeSurface.closeSelf`; decide `force` vs scripted `pageOutcomes` precedence; make `forceClose` reject asynchronously.

## Coverage notes

- The diff *added* positive coverage for the new behavior (`tab-devtools-host` typed-error case, `native-tab-host-presented-view`, `capsule-affiliation`, `tab-closed-telemetry`, `phase-02-agent-plane-authority`) — all green.
- Blast-radius suites for shared contracts (`attachment-connection-release`, `multi-tenant-lease-and-router`, `terminal-canonical-ownership`, `bridge-server`, `ipc-router`, `mcp-dispatch-ipc-surface`, `tab-authority-directory`, `multi-workspace-target-settle`) all pass — the multi-window diff broke nothing outside the six points above.

## Unresolved questions

- Was removing the `tab:set-alias`/`tab:get-alias` routes + alias system deliberate? No plan phase mentions it; CHANGELOG does not record it.
- Does the force-close workstream belong to this plan or a concurrent uncommitted feature? Failures are new-in-diff either way, but ownership for fixes differs.

Status: DONE_WITH_CONCERNS
