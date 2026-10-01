# Phase 2 report - Detach lifecycle

Status: DONE — every phase-02 item implemented and evidenced; all 4 KmGate1
advisory conditions met with dedicated tests.

## What changed

### `src/main/browser/native-tab-host.ts`

- `foldDetachedOwnerRecord(filePath, ownerKey)` (~:727): the scoped single-key
  fold. Guards `project:*` shape, reads the document through the shared
  `enqueueSavedTabsWrite`/`readSavedTabsFile`/`normalizeSavedTabsDocument`
  pipeline, snapshots the record's rows/affinities, then calls the extracted
  `foldProjectOwnerRecordIntoWeb` body (~:666) shared with the legacy migration
  fold: `owners[key]` deleted, rows appended to `owners.web` deduped by `tabId`,
  `projectId` stamped on merged rows, marker leaves with the record. Fail-closed:
  absent file → `folded:false`; present-but-corrupt file → throws (same contract
  as the purge). Returns `{ folded, tabs, terminalAffinities }` — the snapshot is
  the live-ingest payload.
- `purgeSavedTabsFileForProject` (~:593): whole-record `project:<id>` arm added
  ahead of the web-rows filter — the detached record (marker, rows, affinities)
  drops whole on removal rather than folding. Count reports both arms.
- `ingestPersistedOwnerRows` (~:14114): host seam reusing `ingestTabRow` (the
  `restoreTabs` normalization path) — mints fresh ids, dedupes by persisted
  `tabId` against live tabs and `transferredSourceIds`, stamps the persisted
  `projectId` on each live tab, translates terminal affinities through the mint
  map, never touches `activeTabId`. Returns `{ minted, skipped }`.

### `src/main/index.ts`

- `reattachProject` (~:1960): the only fold caller.
  - ARM A (live shell): ensures the hub BEFORE the close (never after — a
    last-shell close would start a quit mid-await), then
    `closeDetachedShellForLifecycle` awaits the attempt's settle — post-dispose,
    post-final-`persistSync` by construction of `attemptClose`/`handle.settled`.
    `disposition !== 'closed'` → typed `CLOSE_REFUSED`, no fold, shell stays.
  - ARM B (marked, no shell): fold only.
  - After fold: `hubHost.ingestPersistedOwnerRows` → `hubHost.persistSync()` →
    file re-read asserting BOTH `owners['project:X']` absent AND every minted id
    present in `owners.web`; mismatch → `SETTLE_INCOMPLETE`. No await sits
    between the fold's write and the hub persist (the unbroken-unit invariant).
- `reattachInProgress` latch (~:1911): set before the close attempt, cleared in
  `finally` after fold/ingest/persist settle. Consulted by BOTH phase-01
  exclusivity gates: `openProjectWindow`'s hoist (:1685) skips detached-mode
  while latched; `ensureDetachedProjectShell` (:1766) throws
  `TRANSACTION_CONFLICT` on the creation arm only (a shell caught mid-close is
  still joinable/focusable above); `detachProject` (:1880) refuses with
  `REATTACH_IN_PROGRESS`.
- `removeProjectEntry` detached arm (~:2599): ordered BEFORE the purge — a live
  detached shell closes through `closeDetachedShellForLifecycle`, only
  `disposition === 'closed'` proceeds; `CLOSE_REFUSED` otherwise, record stays
  marked, nothing folds. Purge at :2667 drops the whole record.
- `setDetachedShellCloseDriverForTesting` (~:1922): test-only driver seam —
  `node --test` has no `projectWindows` close-surface directory, so the real
  coordinator cannot reach a testing shell; the driver stands in for
  `handle.settled`. Module-local, unreachable from IPC.
- IPC: `PROJECT_REATTACH` handler registered (~:3302) beside DETACH; authority
  surface `projectWindowAuthority.reattachProject` (~:4537).

### `src/main/browser/app-menu.ts`

- `reattachProject` dependency (~:163) + menu item "Reattach Project into Hub
  Window" (~:364): resolves the project from the CLICKED window's own owner key
  (`hostForClick(...).windowOwnerKey()` → `parseOwnerKey`) — a detached window's
  host presents no active project, so `activeProject()` could never scope it.
  The affordance stays enabled while the marked-live shell exists (the reattach
  is what retires that shell) — advisory condition 4.

### `src/shared/contracts.ts` / `src/preload/standalone-preload.ts`

- `PROJECT_REATTACH` channel (:410) + `ProjectReattachResult` type (:544):
  `REATTACHED | FAILED{reason}` with classed reasons `PROJECT_UNAVAILABLE`,
  `NOT_DETACHED`, `REATTACH_IN_PROGRESS`, `CLOSE_REFUSED`, `SETTLE_INCOMPLETE`.
- Preload `reattachProject({projectId})` invoke bridge (:76).

## Advisory conditions (KmGate1)

1. **Reattach latch** — `reattachInProgress` Set consulted by the phase-01
   exclusivity gates (`openProjectWindow` hoist :1685, `ensureDetachedProjectShell`
   :1766, `detachProject` :1880). Cleared in `finally` (covers fold, not just
   close — the whole span where the marker still says "detached"). Verified by
   two tests: a second reattach → `REATTACH_IN_PROGRESS`; a detach during the
   fold window (shell dead, marker live, fold gated) → `REATTACH_IN_PROGRESS`,
   proving only the latch prevents shell regrowth.
2. **Refused-detach reattach row** — test: hub-resident vetoed row + marked
   record → reattach folds the record, live row wins the tabId collision,
   `owners.web` ends with exactly the live + minted rows, all stamped, zero
   duplicates.
3. **Instrumented ordering** — the ARM A test wraps the dying host's
   `persistSync` inside the close driver (stand-in for `handle.settled`
   post-dispose) and the module-level `foldDetachedOwnerRecord` export;
   asserts `close < persistSync < fold` in the recorded sequence AND that the
   fold observes `detachedHost.isDisposed === true`. Production ground: the
   shell's `closed` listener ordering runs `handleShellClosed` → `dispose()` →
   synchronous `persistSync` before the attempt's settle resolves.
4. **Affordance while marked-live** — menu item enabled whenever
   `reattachProject` is injected, scoping purely from the clicked window's owner
   key; no shell-state gate.

## Tests

`test/main/detached-project-window.test.ts` extended (17 tests pass):
- `foldDetachedOwnerRecord` suite: merge/stamp/dedupe/marker-clear; web-record
  active-pointer + affinity merge; fail-closed rows (wrong key, absent record,
  absent file, corrupt file).
- `purgeSavedTabsFileForProject` `project:*` arm: whole-record + stamped web
  rows dropped in one write, count covers both arms.
- `ingestPersistedOwnerRows`: mints ids, dedupes by persisted tabId, never
  touches the presented tab.
- `ordinary close and quit never fold`: spied `foldDetachedOwnerRecord` gets 0
  calls across a real `dispose()`; the record stays marked in the file.

`test/main/detached-project-lifecycle.test.ts` (new, 9 tests pass):
- ARM A instrumented ordering (`close` < `persistSync` < `fold`, fold post-dispose).
- Vetoed close → `CLOSE_REFUSED`, no fold, marker survives.
- ARM B with live hub and without (file-state landing).
- `REATTACH_IN_PROGRESS` on second reattach; latch refuses detach mid-fold.
- Remove-detached: `['close','purge']` sequence, no fold, record gone.
- Remove-vetoed: `['close']` only, project survives, marker stays.
- Refused-detach reattach matrix row.

`test/main/web-hub-project-routing.test.ts` updated: the purge test pinned the
pre-phase-02 contract ("retired `project:` owner key survives the purge") — now
asserts the whole-record drop and the combined count (2 web rows + 1 dropped
record = 3), matching the detach-lifecycle contract.

Evidence: `npm run compile` clean; `node --test` green on all three files
(17 + 9 + 26 = 52 tests). `npm run test:main` (full suite, ~217s) surfaced the
stale purge-contract test — updated and re-verified green — plus one unrelated
timestamp flake in another file (no phase-02 code involved; not reproduced on
scoped re-run).

## Concerns / deferred

- The latch test gates inside the fold via the module-export seam — the closest
  observable join point in-process; production's real settle is the coordinator's
  `handle.settled`, which the driver mirrors.
- `PROJECT_REATTACH` has no renderer caller yet (menu + authority only); the
  sidebar affordance is phase-03/04 territory alongside boot-restore UX.
