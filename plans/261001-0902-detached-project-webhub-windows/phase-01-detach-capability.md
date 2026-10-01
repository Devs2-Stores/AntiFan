---
phase: 1
title: "Detach capability: entrypoint, exclusivity, fold marker"
status: done
priority: P1
effort: "2d"
dependencies: []
---

# Phase 1: Detach capability

## Overview

Make a `project:<id>` shell creatable on demand while keeping every hub/default
path untouched. Atomic pieces: (a) fold-marker schema + write + fold-skip, (b)
detach entrypoint bypassing the `project→web` normalization, (c) exclusivity —
all one commit-set: a detached shell without the marker or exclusivity is a
correctness bug on first persist.

**Decisions locked at validation:** detach is a NEW explicit action (menu item +
IPC route), never a flag on `openProject`; detaching a hub-presented project
**transfers its live tabs** to the detached shell; closing a detached window does
NOT reattach (phase-02 explicit Reattach action).

## Requirements

- Functional: `detachProject(projectId)` IPC+menu creates/joins a shell with
  `ownerKey` `project:<id>`; exclusivity XOR enforced main-side; live X tabs move
  from hub to detached shell on detach; hub affiliation cleared before scope null.
- Non-functional: zero behavior change when no detached shell exists; existing
  hub-model e2e guards pass unmodified; fail-closed refusals typed; detached host
  must NOT write app-wide document prefs (sidebar/bookmarks are hub's).

## Architecture

```
menu "Open in own window" → IPC 'antifan:project:detach' { projectId }
   └─ surface-constrained to sidebar/toolbar family (NOT terminalPopout)
   └─ index.ts: detachProject(projectId)
        ├─ assertApplicationAdmitsWork + isKnownProjectId gate
        ├─ hostForOwnerKey('project:'+id) live? → focus, return FOCUSED   [hoisted,
        │   BEFORE ensureProjectWindow — never ensure a web shell to refuse]
        ├─ hub live AND presenting X? → transferHubProjectTabs(X, detachedHost):
        │   move live X-stamped tabs to detached host (live ingest), THEN
        │   setWindowWorkspaceAffiliation(null) BEFORE setActiveProject(null) —
        │   order from removeProjectEntry (:2222-2228): affiliation-first else
        │   hub scope tags still match X sessions
        └─ ensureDetachedProjectShell:
             ├─ manager.ensureWindow({kind:'project',projectId})
             ├─ JOIN arm: if shell already live → focus; NEVER call
             │   activateWebHubProject (hub-only: mint caps, affiliation, scope)
             ├─ CREATE arm: per-owner wiring (baseline template ~1536-1556):
             │   resolveWindowRecord → setWindowWorkspaceAffiliation →
             │   ensureInitialWorkspace; NO activateWebHubProject
             └─ restoreTabs under owners['project:<id>']

Exclusivity (both directions, main-side) — checks consult BOTH live shells AND
   the persisted detached marker (liveness alone leaks: close detached X →
   marker persists → sidebar openProject(X) must NOT route X to the hub):
   ├─ activateWebHubProject(projectId) funnel guard (:1653): live shell OR
   │   marked-detached record → focus/recreate detached shell, typed refuse;
   │   covers :1610 join + :1664 delegate callers
   ├─ openProjectWindow(X): hoisted check ABOVE ensureProjectWindow (:1598):
   │   live → focus; marked-but-dead → recreate via ensureDetachedProjectShell
   │   (detach-as-mode: the project stays detached until explicit reattach);
   │   else a phantom hub window is created and presented only to refuse
   └─ detach of hub-presented X already covered by transfer leg
   Boot double-presentation guard: the hub never absorbs marked records (fold
   skips them, phase-01 marker) AND exclusivity refuses hub presentation of
   marked projects → no path where boot yields hub-X AND detached-X.

Session stamp: detached host has NO activeProjectId (hub-only :1691) —
   derive mintProjectId stamp from parseOwnerKey(windowOwnerKey()).projectId
   (native-tab-host.ts:8417-8427). Extend gate :8425 to owner.kind==='project'.

hubRowVisible (:4671-4676) — KEEP the documented hub exception for
   project/web/unassigned rows (:4665-4670), EXCEPT exempt `project:*` rows
   while a live detached shell owns that key:
   `rowKind==='project' ? !liveDetachedShellFor(rowProjectId) : in {unassigned,web}`

Document-prefs scoping: buildSavedTabsDocument (:13502-13526) writes
   document-level bookmarks/sidebar/prefs per host; detached owner must not
   clobber hub's — gate on WEB_OWNER_KEY like isTerminalOnlyWindow.

Fold marker (atomic with entrypoint):
   ├─ SavedTabsOwnerRecord gains `detached?: boolean`
   ├─ normalizeSavedTabsDocument (:448-468) whitelists the field
   ├─ ownerRecordFromPersistData (:13091-13107) writes detached:true for
   │   owner.kind==='project'
   └─ foldLegacyProjectOwnerRecords (:12985-13026) skips marked keys —
      legacy unmarked records still fold (migration compat)
```

## Related Code Files

- Modify: `src/main/index.ts` — `detachProject` entrypoint + IPC route
  (surface-constrained); `ensureDetachedProjectShell` with split join/create
  arms; exclusivity guards hoisted to `openProjectWindow` (:2709) AND inside
  `activateWebHubProject` (:1653); `transferHubProjectTabs` live-move;
  `projectWindowAuthority` probe seam (:4078) must route through
  `detachProject`, not bypass the entrypoint.
- Modify: `src/main/browser/native-tab-host.ts` — marker write :13091; fold skip
  :12985-13026; normalizer whitelist :448-468; stamp derivation :8417-8427;
  `hubRowVisible` exemption :4671-4676; doc-prefs owner gate :13502-13526;
  live-ingest helper for transferred rows.
- Modify: `src/main/browser/app-menu.ts` — detach menu item (project-scoped).
- Modify: `src/preload/` + renderer surface constraint — detach IPC admit-list.
- Test: `test/main/` new file (marker/fold/exclusivity/stamp/prefs rows);
  `test/e2e/project-windows.test.ts` — ADD detach rows only.

## Test scenario matrix

| Scenario | Input | Expected |
|----------|-------|----------|
| default open | `openProject(X)`, no detach | single hub, zero project shells (existing guard unmodified) |
| detach create | `detachProject(X)` via real entrypoint | snapshot `project:X`; chrome ready; mints stamp X |
| detach of hub-presented | hub shows X, detach X | live X tabs transfer; affiliation cleared THEN scope null |
| exclusivity A | hub flip to detached X | `activateWebHubProject` refuses/focuses detached; hoisted check never creates phantom hub |
| exclusivity B | `openProject(X)` w/ detached live | FOCUSED detached; browserShellCount unchanged |
| marked-dead open | X detached, window closed (marker persists), `openProject(X)` | hub does NOT present X; detached shell recreated + focused (detach-as-mode) |
| boot no-double-present | marked X + hub live at boot | detached restores; hub never holds X rows/presentation |
| join path | second `detachProject(X)` | joins existing shell; activateWebHubProject NOT called |
| marker roundtrip | detached persist → web-host recreate | `owners['project:X']` survives fold; rows intact |
| legacy fold | unmarked `project:*` on disk | folds into `owners.web` (migration compat) |
| live detached + stale disk rows | marked live shell + unmarked on-disk X rows | fold absorbs disk rows; live host rewrites marked — probe row |
| stamp | tab minted in detached X | `projectId:'X'`; `tabsForProject(X)` on detached > 0 |
| hubRowVisible | TM moves unassigned/web row from hub | allowed (regression pin); moves `project:X` row while detached X live → refused |
| doc prefs | detached host persists | hub's bookmarks/sidebar/prefs untouched |

## Implementation Steps

1. Marker schema + normalizer whitelist + writer + fold-skip (unit tests first —
   roundtrip + legacy compat rows).
2. Stamp derivation from owner key; detached `tabsForProject` assert.
3. `detachProject` entrypoint + `ensureDetachedProjectShell` split arms; remap
   gate keeps `project→web` for legacy callers (:1596).
4. `transferHubProjectTabs` + affiliation-clear ordering.
5. Exclusivity: hoisted check in `openProjectWindow` + funnel guard in
   `activateWebHubProject` + `hubRowVisible` live-detached exemption.
6. Doc-prefs owner gate; IPC surface constraint; menu affordance.
7. Probe seam routes through real entrypoint.

## Success Criteria

- [x] `detachProject(X)` → ownerKey `project:X`, shellCount 2, TM absent. — probe leg2; e2e lifecycle row
- [x] Detached chrome live; detached-minted tabs stamped X; `tabsForProject(X)>0`
      on the detached host. — probe legs 2/4; `mint stamp derivation` tests
- [x] Detaching hub-presented X transfers live tabs; hub affiliation cleared. — probe leg3b; `live tab transfer` tests
- [x] Exclusivity both directions; no phantom hub window ever created. — probe legs 3a/3b; e2e exclusivity row
- [x] Marker/fold roundtrip + legacy-compat rows green; hub e2e guards unmodified. — marker/fold suite 11/11 (phase-01 report)
- [x] `hubRowVisible`: unassigned/web moves still allowed; detached-owned rows refused. — predicate code-verified (`detachedShellOwns`); live exercise deferred → R3 in plan.md
- [x] Detached persist does not overwrite hub document prefs. — `detached document-prefs gate` test

## Risk Assessment

- Detached shell before marker lands → unmarked record eaten by next web-host
  restore (:13643). Mitigation: steps 1-3 are ONE commit-set; entrypoint is the
  only path to a `project:` host and lands after the marker writer.
- Mid-session hub recreation folds live detached records → marker is per-record,
  per-host timing safe; roundtrip test proves.
- Live tab transfer needs renderer-safe move: reuse capsule-reorder mechanics
  rather than hand-rolling tab moves.
- `switchSession` global-active debt (0945) unchanged — cosmetic.
