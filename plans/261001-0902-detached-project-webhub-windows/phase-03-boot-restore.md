---
phase: 3
title: "Boot restore + placement"
status: done
priority: P2
effort: "0.5d"
dependencies: [1, 2]
---

# Phase 3: Boot restore + placement

## Overview

Detached shells survive restart: boot enumerates `detached:true` `project:*`
records and recreates each via `ensureDetachedProjectShell`. Because ordinary
close no longer folds (phase-02 decision), a marker means "restore this shell" —
closed-at-quit and open-at-quit restore identically.

## Requirements

- Functional: cold boot restores every marked record whose project is still
  valid, presenting the window once (intent handled — see below), tabs under
  `project:<id>`, bounds per ownerKey via `windowStateManager.manage` (:1634).
- Non-functional: hub restores FIRST (owns the fold); detached shells restore
  sequentially after; ≤1 focus-steal (only the first restored shell may present
  focused); dead-project records never resurrect.

## Architecture

```
boot (createWindow :2900+)
   ├─ hub shell ({kind:'web'}) + restoreTabs — UNCHANGED
   └─ NEW leg, after hub restore completes:
        for each owner key 'project:<id>' with record.detached===true:
          ├─ validate: isKnownProjectId(id) — BUT bootProjectIdValue returns
          │   true unconditionally (index.ts:680-681) → ALSO require the
          │   project exist in the registry, not merely "be the boot id";
          │   dead boot project → skip + journal, record left for purge
          └─ ensureDetachedProjectShell(id) with intent selection:
               OpenIntent admits only 'user'|'agent' (project-window-manager.ts:23)
               → 'agent' = live invisible window (probe sees it, user doesn't);
                 'user' per shell = focus storm.
               Resolve: present FIRST restored shell 'user', subsequent 'agent';
               OR extend OpenIntent with 'restore' intent → presents unfocused.
               Default: add 'restore' intent (cleaner than intent abuse).
```

## Related Code Files

- Modify: `src/main/index.ts` — boot leg after hub restore (:3185-3190 region);
  registry-membership validation in addition to `isKnownProjectId`.
- Modify: `src/main/browser/project-window-manager.ts` — `OpenIntent` gains
  `'restore'` (presents window without focus steal) OR controller uses
  first-shell-'user'-then-'agent' sequencing — pick at impl after checking how
  `presentShellOnFirstPaint` (:1619) treats intents.
- Modify: `src/main/browser/native-tab-host.ts` — read-only enumeration seam for
  marked owner keys (from `loadSavedTabsDocument`).
- Test: cold-restart legs live in phase-05 probe.

## Test scenario matrix

| Scenario | Input | Expected |
|----------|-------|----------|
| restart w/ detached | X detached (open or closed at quit), relaunch | `project:X` shell restored, tabs intact |
| restart multi | A+B detached | both restore; ≤1 focus steal |
| dead project | marked record for removed project | no shell, journaled skip, record untouched |
| bootProjectId loophole | marked record for removed project still in boot id slot | registry check refuses — `isKnownProjectId` alone insufficient (:680-681) |
| fold isolation | hub restore + marked records | hub folds only unmarked legacy records |
| placement | detached was on monitor 2 | bounds per `project:<id>` |

## Implementation Steps

1. Marked-owner enumeration seam (read-only).
2. `OpenIntent` decision: `'restore'` vs sequencing — verify
   `presentShellOnFirstPaint` first, then implement.
3. Boot leg: enumerate → registry-validate → `ensureDetachedProjectShell` per
   record, sequential + journaled.
4. Assert placement restore per ownerKey in probe (don't assume).

## Success Criteria

- [x] Cold restart reproduces detached shells + strips (open or closed at quit). — restart probe 5/0; `detached-project-restore` 17/17
- [x] At most one focus steal across all restored shells; none invisible forever. — `restore` intent presents via `showInactive`; zero steals from this leg
- [x] Dead/boot-id-orphan records never resurrect shells. — `detachedRestoreAdmitsProject` predicate tests (open OR uniqueValidatedClaim)
- [x] Boot latency delta <500ms per detached shell. — `durationMs`/`overBudget` instrumented + journaled per ensured record

## Risk Assessment

- Double-restore impossible post phase-01 (fold skips marked) — matrix row proves.
- 'restore' intent vs intent-sequencing: check `describeShellForProbe` — an
  'agent'-intent shell is live-but-invisible; if 'restore' isn't added, tests
  must assert actual visibility, not just shell existence.
- Boot enumeration races capsule registry sync — `synchronizeCapsulesWithRegistry`
  (:1598-1599) runs inside ensure path, reused not duplicated.
