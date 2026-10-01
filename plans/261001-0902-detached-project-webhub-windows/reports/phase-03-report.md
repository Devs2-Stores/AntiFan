# Phase 3 report — Boot restore + placement

Status: DONE — every phase-03 item implemented and evidenced; the four KmGate2
advisory resolutions applied verbatim, plus two boot-path holes found and fixed
while tracing (detailed below).

## The hub double-presentation question — answered: YES, the hub would have double-presented; suppression now added.

The advisory asked whether hub `restoreTabs` presents `projectId:X`-stamped rows
while a marked `project:X` record restores a detached shell. Traced proof:

- `restoreTabs` reads the owner's record and iterates **every** row under
  `owners.web` with no `projectId` filtering — `native-tab-host.ts` (pre-change
  `for (const rawTab of record.tabs)` at ~:13931; now `restorableTabs` at
  :13985). `ingestTabRow` then *re-stamps* `tab.projectId` from the row
  (`native-tab-host.ts:14073-14078`), proving stamps persist on web rows and
  were restored verbatim — a `projectId:X`-stamped `owners.web` row (the
  refuse-detach leftover `transferHubProjectTabs` deliberately leaves live) was
  presented by the hub while the detached shell restored the same tabs.
- Second hole found in the same pass: the persisted-hub-scope arm
  (`record.activeProjectId`, `native-tab-host.ts:13912`) routed a detached
  project through `foreignProjectActivatedHandler` → `activateWebHubProject`,
  which fires `ensureDetachedProjectShell(projectId, 'user')` **focused**
  (`index.ts:1688-1690`) mid-restore, then throws. On a boot that takes this
  path, the detached shell would be recreated focused — spending the ≤1 focus
  budget on the wrong window before the boot leg's unfocused restore ran.
- Third hole (index side): `createWindow`'s own `activateWebHubProject` call
  for the boot project (pre-change `index.ts:~1640`, now guarded at
  :1639-1656). If the **boot project itself** was marked detached, that call
  threw `TRANSACTION_CONFLICT` — a fatal `createWindow` failure: the next boot
  would have died instead of restoring.

Fixes (all verified by tests):
- `native-tab-host.ts:13958-13972` — the web host's restore filters out rows
  stamped `projectId` for a project whose record is still `detached:true`.
  Read-filter only: nothing is deleted, so a reattach's fold (which removes
  the record) makes the next hub restore read the rows again — refuse-detach
  coexistence at quit → next boot presents X's tabs exactly once, in the
  detached shell.
- `native-tab-host.ts:13921-13923` — `persistedDetached` suppresses routing a
  detached persisted scope into the activation funnel entirely.
- `index.ts:1639-1656` — `ensureProjectWindow`'s creation arm skips
  `activateWebHubProject` for a detached-mode project (same predicate the
  funnel uses: live shell OR marker, minus the reattach latch) and journals
  `boot.hub-activation-skipped-detached`; the boot leg owns the restore.

## What changed

### `src/main/browser/native-tab-host.ts`
- `listDetachedProjectOwnerRecords(filePath)` (:669): the read-only enumeration
  seam — the same `readSavedTabsFile` + `normalizeSavedTabsDocument` pipeline
  `loadSavedTabsDocument` runs, minus the web-owner fold, so enumeration never
  mutates the document. `project:`-shaped keys only; absent/corrupt file → `[]`
  (fail-closed, same contract as `savedTabsOwnerIsDetached`).
- `restoreTabs` (:13944-13985): `restorableTabs` — the detached-stamp
  suppression filter above; `targetActiveOldId`/`firstValid` now resolve
  against the filtered list, so a suppressed persisted active id can never
  stub-out every restored row under `safeStart`.
- `restoreTabs` persisted-scope arm (:13921): detached-marker suppression for
  `record.activeProjectId`.

### `src/main/browser/project-window-manager.ts`
- `OpenIntent` (:30): `'user' | 'agent' | 'restore'` — documented semantics.
- `ProjectWindowManagerOptions.presentShellInactive` (:43): the third present
  mode — surfaces an existing shell via `showInactive`, never focused. Called
  only for `restore` intent.
- `ensureWindow` (:85-88, :100-105): an existing shell joined with `restore`
  is presented through `presentShellInactive`; a `restore` intent joining an
  in-flight creation surfaces the winner unfocused once it settles. `createShell`
  still builds `show:false` for every intent — creation presentation stays in
  `index.ts`'s `presentShellOnFirstPaint`, so the three modes are: join-present
  (`present`/`presentInactive`), in-flight join, and create-paint presentation.

### `src/main/index.ts`
- `presentShellOnFirstPaint` (:2260-2297): `presentation: 'focused' |
  'unfocused'` param — unfocused path applies saved placement, calls
  `showInactive()`, never `focus()`.
- `presentShellUnfocused` (:2305): shared unfocused presenter — placement
  restore (maximize/center per owner key), `restore()` a minimized window,
  `showInactive()`. Wired as the manager's `presentShellInactive` (:3572) and
  used by `ensureDetachedProjectShell`'s join arm (:1780).
- `ensureDetachedProjectShell` (:1777-1809): `restore` join arm surfaces the
  live shell unfocused; creation arm runs
  `synchronizeCapsulesWithRegistry(capsuleManager, projectRegistry, …)`
  (:1798-1801) before minting the shell — the same sync the hub's
  `ensureProjectWindow` runs, reused not duplicated — then `restoreTabs` reads
  the `project:<id>` owner record and `windowStateManager.manage` (:1836)
  binds placement per owner key.
- `detachedRestoreAdmitsProject` (:1859): the admission predicate —
  `projectRegistry.getProject(id).state === 'open'` OR
  `uniqueValidatedClaim(capsuleManager?.list() ?? [], id)`. Deliberately
  narrower than `isKnownProjectId` (whose boot-id arm answers true
  unconditionally, :683) and `isListedProjectId` (closed records stay listed).
- `restoreDetachedProjectShells` (:1893): the boot leg — enumerate → per-record
  reattach-latch check → marker re-read (`marker-cleared` skip — the enumerate→
  ensure snapshot can never authorize a window alone) → predicate →
  `ensureDetachedProjectShell(id, 'restore')`. Sequential, per-record try/catch
  with `detached-restore.failed` journaling, refused records left untouched for
  purge, per-shell `durationMs` + `overBudget` (>500ms warns + journals),
  `detached-restore.done` summary. Enumeration itself fail-closed.
- `createWindow` call site (:3851): after `attachSharedServices(bootstrapHost)`
  — i.e. after the hub's own restore+fold write (`loadSavedTabsDocument`'s
  synchronous write inside `restoreTabs`) and control-plane init; awaited, so
  restored hosts exist before the browser-port re-attach pass and get its
  viewport gate through `attachSharedServices`' `hosts()` sweep.
- Test seams (:1957-1972): `setDetachedShellHostFactoryForTesting`,
  `setProjectWindowManagerForTesting`, `setWindowStateManagerForTesting`,
  `setCapsuleManagerForTesting`, `setBootProjectIdForTesting` — module-local,
  IPC-unreachable, same precedent as `setDetachedShellCloseDriverForTesting`.

### `test/main/detached-project-restore.test.ts` (new, 17 tests)
Enumeration (whitelist shape, read-only, fail-closed) · predicate truth table
(open / never-held / closed-record / boot-id-slot loophole / unique-validated
capsule / ambiguous claim) · `restore` intent presents unfocused on join and
in-flight join · boot leg (ordered restore after hub fold, dead/closed records
refused + left for purge, per-record failure isolation, live-shell join
unfocused-not-recreated, mid-loop marker-clear skip) · hub suppression
(row-level + persisted-scope) · detached-owner record restore landing under
`project:<id>`.

### `test/main/application-menu-project-open.test.ts`
- One stale pin re-aimed: the File menu legitimately gained the phase-01/02
  "Detach Project into Own Window" / "Reattach Project into Hub Window" entries
  (always-rendered, disabled without injected callbacks — `app-menu.ts:338,364`
  precedent). The pin now asserts the six-label head explicitly; the
  "undisturbed" claim (tab commands after the separator) is preserved.

## Advisory matrix rows → evidence

| Advisory row | Evidence |
|---|---|
| (a) closed-state record must not restore | `detachedRestoreAdmitsProject` requires `state === 'open'`; tests: `refuses a project whose registry record is closed`, `a marked record whose registry record is closed never resurrects` — record left on disk for purge |
| (b) hub double-presentation | YES, confirmed (proof above); suppression at `native-tab-host.ts:13958-13972` + :13921 + `index.ts:1639`; tests: `hub restore suppression` suite + ordering row in `restores valid marked shells…` |
| (c) refuse-detach coexistence at quit | suppression is a read filter — stamped web rows restore verbatim once the record is gone (test asserts both halves) |
| OpenIntent 'restore' + minimal seam | `presentShellInactive` option, `:85-105`; no intent threading through `createShell` |
| Predicate = open OR uniqueValidatedClaim | `detachedRestoreAdmitsProject` :1859; boot-id slot excluded; capsule-claim test seeds the store file directly (`setAffiliation` needs a registry project, so the claim is persisted as the store writes it) |
| Boot leg after hub restore+fold | `createWindow` :3851 — after `ensureProjectWindow(owner,'user')` (whose `restoreTabs` writes the folded doc synchronously) and control-plane init |
| Re-check marker+latch at ensure | loop re-reads `savedTabsOwnerIsDetached` + `reattachInProgress` per record; `marker-cleared` test spies the re-check |
| Per-record try/catch + journaled skip | `detached-restore.failed` + outcomes array; failure-isolation test |
| Per-shell latency ≤500ms | `durationMs`/`overBudget` instrumented on every ensured record; budget breaches warn+journal |

## Success criteria mapping

- Cold restart reproduces detached shells + strips: `restoreDetachedProjectShells`
  + `ensureDetachedProjectShell`'s `restoreTabs(project:<id> record)` — host-level
  test proves the record's rows mint under the detached owner.
- ≤1 focus steal, none invisible: `restore` presents every shell via
  `showInactive` — zero steals from this leg; the hub's own first-paint
  presentation (unchanged, 'user') remains the boot's single focus. Documented
  choice: no restored shell gets 'user' — the boot-focus criterion is already
  consumed by the hub, so all restore-unfocused was chosen over first-shell-
  'user' (deterministic, no record-order dependence).
- Dead/boot-id-orphan/closed records never resurrect: predicate tests + boot-leg
  tests; refused records untouched.
- Boot latency <500ms/shell: instrumented (`durationMs`), breach is
  warn+journal — measurable, not assumed.
- Placement per ownerKey: `windowStateManager.manage(shell.window, key)` asserted
  (`managedKeys` includes `project:<id>`), and both presenters consult
  `getValidBounds(ownerKey)`.

## Test output

```
node --test .compiled/test/main/detached-project-restore.test.js   → 17/17 pass
node --test (detached-project-window, detached-project-lifecycle,
  project-window-manager, project-window-persistence,
  web-hub-project-routing, application-menu-project-open)          → green
npm run compile                                                  → clean
npm run test:main (two full runs)                                → 2206-2207 pass / 1 skip;
  one flake each run, neither in phase-03 code: (1) the stale File-menu pin
  now re-aimed; (2) the timing-sensitive shell-disposal audit (50ms survivor
  window under full-suite load) — green on standalone re-run both times,
  consistent with phase-02's reported flake profile.
```

## Concerns / deferred

- The `hasRestoredTabs` timing contract (`setActiveProject` defers repoint until
  restore ends) is untouched; a detached host carries no `activeProjectId`, so
  no flip semantics apply.
- `restoreDetachedProjectShells` awaited at boot is sequential by design (≤500ms
  each; two marked shells ≈ ≤1s added tail). Cold-restart live proof stays
  phase-05 probe territory.
- `presentShellOnFirstPaint`'s unfocused arm is exercised through the
  `ready-to-show` event in tests (fake windows paint synchronously); the 300ms
  fallback path is inherited unchanged.
