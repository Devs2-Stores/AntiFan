---
phase: 2
title: "Detach lifecycle: reattach, removeProject, purge"
status: done
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 2: Detach lifecycle

## Overview

**Decision locked:** closing a detached window keeps the project detached —
`detached:true` persists, no fold, phase-03 boot restores it (window open or
closed at quit is indistinguishable → identical restore). `fold` exists ONLY via
the explicit **Reattach** action: close the shell through the coordinator, let
its final `persistSync` complete, THEN scoped-fold the record into `owners.web`
and live-ingest the rows into the hub.

Two distinct operations, stated precisely:

- **Ordinary close** (user closes window / app quit): shell destroyed via normal
  `notifyShellGone` → dispose → `persistSync`. Record stays marked. NO fold runs.
  Boot restores the shell (phase-03). Fold MUST NOT hook `notifyShellGone`,
  `onCloseRequest`, or `closed` — none carry close intent and all precede or
  race the dying host's final synchronous write (:13594-13603 enqueue lacks
  isDisposed check; :13617-13633 persistSync is unchained and runs inside
  dispose :14586-14592).
- **Reattach** (`reattachProject(projectId)` — explicit action): close shell via
  `requestShellClose`/coordinator with `disposition==='closed'` confirmed; AFTER
  `onShellDisposed`/final `persistSync` completes, run scoped fold (delete
  `owners['project:<id>']`, merge rows into `owners.web`, marker cleared) — then
  live-ingest merged rows into the running hub so tabs appear WITHOUT restart.

removeProject on a detached project folds via close-coordinator then purges BOTH
`owners['project:<id>']` and web-stamped rows — explicit ordered calls, not
hook races.

## Requirements

- Functional: Reattach action (menu + IPC) restores project's tabs into the live
  hub; removeProject tears down detached shell through the coordinator (veto
  respected) and purges both records; ordinary close/quit never folds.
- Non-functional: fold ordering explicit and synchronous post-dispose; no
  reliance on enqueue-serialization against `persistSync` (it bypasses the
  queue — :13594-13599 comment admits it); purged projects never resurrect.

## Architecture

```
reattachProject(projectId)   [explicit action only — TWO arms]
   ├─ ARM A (shell live): requestShellClose(shell,'user') → await
   │   report.disposition==='closed' → await onShellDisposed settle — host's
   │   final persistSync COMPLETE (fold awaits the WRITE, not just dispose)
   ├─ ARM B (marked-but-not-live, C2): marker present, no shell → skip close
   │   legs; fold directly (fold + ingest only)
   ├─ foldDetachedOwnerRecord('project:'+id): scoped single-key fold
   │   (extracted from foldLegacyProjectOwnerRecords :12985-13026):
   │   delete owners[key]; merge rows into owners.web (dedupe by tabId);
   │   stamp rows with projectId=X (:13005-13008 semantics); clear marker
   ├─ post-fold coherence (C3) — ORDER MATTERS:
   │   a) fold writes canonical doc (sync read-modify-write)
   │   b) IF hub live → ingest folded rows INTO the hub's in-memory
   │      record BEFORE any hub persist — else the hub's next persistSync
   │      rewrites owners.web wholesale from stale memory
   │      (buildSavedTabsDocument replaces owners[WEB_OWNER_KEY]
   │      :13133-13135) and erases the just-folded rows
   │   c) THEN force hub persist + file re-read — assert BOTH
   │      owners['project:X'] absent AND every transferred tabId present
   │      (absence alone can pass while silently losing the tabs)
   └─ hub live? → hubHost.ingestPersistedOwnerRows('project:'+id) — NEW host
       seam: normalizes persisted rows through the same path restoreTabs
       uses (:13637-13662); appends to tabs/tabOrder deduped by tabId
       (under exclusivity hub holds no live X rows — folded rows win any
       collision); does NOT touch activeTabId. restoreTabs reads the doc
       only at construction :13643 → live hub never sees file merges;
       ingest is required, not optional. Hub closed → file state suffices.

ordinary detached close (window X close, app quit)
   └─ normal destroy path only — NO fold hook anywhere. Marker persists.

removeProjectEntry(X)   (index.ts:2194-2260)
   ├─ detached shell live → requestShellClose → await closed+disposed
   │   (veto → removal reports refused; NO force)
   ├─ explicit ordered: purgeSavedTabsFileForProject drops owners['project:X']
   │   record AND web-stamped rows (:582-617 extension) — called AFTER close
   │   settles so dying persistSync can't re-add the record
   └─ NO fold on removal — purge owns the record directly
```

## Related Code Files

- Modify: `src/main/index.ts` — `reattachProject` entrypoint (post-dispose fold
  ordering via coordinator report seam, index.ts:1456-1462); `removeProjectEntry`
  detached arm (:2194-2260) with explicit close→purge ordering; detach menu adds
  Reattach counterpart.
- Modify: `src/main/browser/native-tab-host.ts` — `foldDetachedOwnerRecord`
  scoped fold helper (single-key extraction of :12985-13026, clears marker,
  stamps projectId on merged rows); `ingestPersistedOwnerRows` live-host seam;
  `purgeSavedTabsFileForProject` (:582-617) drops `owners['project:'+id]` whole.
- Modify: `src/main/browser/project-close-coordinator.ts` — if needed, surface
  the settled disposition report so reattach can await post-dispose.
- Test: `test/main/` — fold ordering, purge completeness, veto path, ordinary
  close leaves marker (spy on fold helper: must not be called on close/quit).

## Test scenario matrix

| Scenario | Input | Expected |
|----------|-------|----------|
| ordinary close | user closes `project:X` window | marker intact; no fold; record survives |
| quit | Cmd+Q with detached A+B | markers intact both; fold helper never invoked |
| reattach | `reattachProject(X)` | shell closes; post-dispose fold; hub live-ingests rows; marker cleared |
| reattach marked-dead | `reattachProject(X)` with marker, no live shell | ARM B: fold + ingest, no close leg; marker cleared |
| post-fold coherence | hub persist after fold | file re-read: `owners['project:X']` absent AND every transferred tabId present in `owners.web` (absence alone can pass while losing tabs) |
| reattach veto | close vetoed | fold NOT run; record intact; typed refuse |
| reattach ordering | fold runs after persistSync | owners['project:X'] absent; no zombie record |
| remove detached | `removeProject(X)` | close→settle→purge ordered; zero `project:*` + web residue |
| remove vetoed | veto on close | removal reports refused; record stays |
| purge scope | detached record present | whole record dropped, not just stamped rows |
| live ingest | hub live during reattach | X tabs visible in hub immediately, stamped |
| ingest w/o hub | hub closed at reattach | fold lands in file; next hub construction restores |

## Implementation Steps

1. Extract `foldDetachedOwnerRecord` (scoped, marker-clearing, stamping) + unit
   tests vs legacy fold.
2. `ingestPersistedOwnerRows` host seam + live-hub wiring.
3. `reattachProject`: coordinator close → await disposition+dispose → fold →
   ingest. Unit test spy proves fold skipped when disposition ≠ 'closed'.
4. `removeProjectEntry` detached arm: close-coordinator path + ordered purge
   (purge AFTER close settles — comment the invariant in code).
5. `purgeSavedTabsFileForProject` `project:*` arm.
6. Regression row: fold helper NOT called on ordinary close or quit.
7. Amend phase-1: drop its "close=reattach" trace if any; marker write stays.

## Success Criteria

- [x] Ordinary close/quit: `owners['project:X']` keeps `detached:true`; fold spy
      count 0; tabs persist under the project record. — `ordinary close and quit never fold` test; probe leg7
- [x] Reattach: hub shows X tabs live (no restart); record unmarked/absent;
      no duplicate rows in `owners.web`. — ARM A/B tests; probe leg7; e2e reattach row
- [x] Reattach ordering: fold executes strictly post-`persistSync` (assert via
      instrumented sequence in test). — `close < persistSync < fold` instrumented ordering test
- [x] removeProject leaves zero residue for detached projects; veto propagates. — `['close','purge']` ordering + veto tests; purge `project:*` arm tests
- [x] `node --test` compiled main-suite green incl. new rows. — 52 new-file tests green; `test:main` 2229/1 (unrelated history-manager mtime flake)

## Risk Assessment

- Fold-after-dispose needs a settle signal post-`persistSync`: if the
  coordinator's report settles before `onShellDisposed`, chain on the dispose
  promise (`forgetShell` settle), not the close report. Verified at impl.
- Live-ingest into a running hub touches tab/tabOrder mutation paths — reuse
  restore-row normalization (:13637-13662), not bespoke logic.
- If ingest is skipped when hub is closed, file state alone suffices — next
  construction restores (:13643). Probe covers both hub-live and hub-closed.
