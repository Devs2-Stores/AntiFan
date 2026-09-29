---
title: "Terminal Hub + Project Spaces"
description: "Shared Terminal Manager becomes the one hub for every terminal, grouped by real workspace folder; per-folder Space manifest opens terminals + web tabs; watcher terminals never auto-sleep; duplicate theme sync warns."
status: in-progress
priority: P1
effort: "~6-8d"
tags: [terminal, project-windows, haravan, sapo, shopify, ui]
created: 2026-09-29
related: [260928-1654-smooth-multi-project-terminal]
---

# Terminal Hub + Project Spaces

## Overview

Solo dev runs many omp agents across Haravan/Sapo/Shopify theme folders. Today terminals
"spawn everywhere": 13 persisted sessions, 7 with `ownerKey: unassigned`, labels `Terminal N`,
"Gui toi" picker labels wrong, folder dialog ignores `E:\Work`. The Shared Terminal Manager
(`Ctrl+Shift+M`) is the hub; it is missing folder identity, not features.

Research: `plans/reports/research-260929-terminal-hub-multi-agent-workspaces.md`.
Scout evidence: `agent://ProjectRegistryScout`, `agent://HubSessionScout`,
`agent://RunStateSyncScout`, `agent://PlanOverlapScout` (session-scoped; key facts copied into phases).

## Contract

- **Outcome:** one hub window lists every terminal grouped by canonical workspace folder, labelled
  `<folder> · <n>` with agent state (running / waiting / idle); `+ Terminal trong thu muc...` opens
  at `E:\Work` and mints a session bound to that folder without touching any other window; the
  "Gui toi" picker groups by folder; a folder's `.antifan/space.json` opens its terminals + web tabs
  in one click; watcher terminals are never auto-slept; two terminals syncing the same store+theme warn.
- **Constraints:** AGENTS.md Level 0; no theme push; no deleting project files or capsule records;
  terminal ownership (`ownerKey`) invariants unchanged — project assignment stays optional;
  `TerminalManager` stays the process singleton; daemon mode `createSession` MUST be awaited
  (`daemon-client.ts:437-453`).
- **Non-goals:** git worktrees (theme conflict is remote, not local); auto-sleep/idle reaping;
  hard spawn caps; per-project terminal managers; renaming persisted session names; cwd-inferred
  project auto-assignment; replacing Shared Manager with a new window.
- **Acceptance:** see Success Criteria.

## Decisions (user delegated: "cu lam nhung gi ban cho la toi uu nhat")

| Question | Decision | Why |
|---|---|---|
| Group axis | canonical folder (`realpathSync`, lowercased on win32) | capsule ids duplicate per folder (`workspace-capsule.ts:176-182`); cwd drifts |
| Manifest location | `<folder>/.antifan/space.json` | travels with folder; `.antifan/` already the workspace marker (`theme-paths.ts` resolveWorkspaceShape). URLs may be private → phase 5 adds `.antifan/` gitignore check warning |
| Duplicate store+theme sync | warn + explicit confirm, not block | identity only derivable for Haravan (`.haravan-cli_local.json`); a hard block on partial identity would give false confidence |
| Hub `+` route | new `antifan:terminal:new-in-folder` | `antifan:capsule:pick-folder` calls `switchTo` + `setCapsule` (`native-tab-host.ts:3881-3884`), mutating process-global state and typing `Set-Location` into live shells |
| Label | display-only `<folder> · <n>` | persisted `name` untouched; no migration |

## Phases

| # | Phase | Status | Depends |
|---|-------|--------|---------|
| 1 | [Dialog path + canonical folder key](./phase-01-dialog-path-and-folder-key.md) | Done | — |
| 2 | [Hub new terminal in folder](./phase-02-hub-new-terminal-in-folder.md) | Done | 1 |
| 3 | [Hub folder grouping, labels, triage](./phase-03-hub-folder-grouping-and-labels.md) | Done | 1 |
| 4 | [Picker folder groups](./phase-04-picker-folder-groups.md) | Done | 1, 3 |
| 5 | [Space manifest](./phase-05-space-manifest.md) | Done | 2, 3 |
| 6 | [Watcher guard + sync conflict warning](./phase-06-watcher-guard-and-sync-conflict.md) | Done | 5 |
| 7 | [Verification](./phase-07-verification.md) | In progress — see phase report | 1-6 |

## Cross-plan

`260928-1654-smooth-multi-project-terminal` edits the same files (`native-tab-host.ts`,
`standalone.js`, `terminal-manager.ts`) and has 2 failing suites (batcher adaptive window bug in
`output-batcher.ts`, stale router test `terminal-output-router.test.ts:220`). Not a hard block:
no shared contract. Rule: do not run both plans' phases concurrently on the same file; phase 7
runs its suites and reports their state without claiming them fixed.

## Success Criteria

- [ ] Folder dialog opens at `E:\Work` (manual smoke on the installed Electron build)
- [ ] Hub `+` in folder X mints a session whose `cwd` = realpath(X), `capsuleId` = existing capsule for X (no new capsule when one exists), and no other window's capsule/cwd changes
- [ ] Hub groups rows by canonical folder; two spellings of one folder (junction/8.3/case) form one group
- [ ] Row labels `<folder> · <n>`; persisted `terminal-sessions.json` names unchanged
- [ ] Unassigned rows show one-click assign (existing project or new project from folder, no dialog); existing `assertManagerMayOperate` refusals unchanged
- [ ] Picker uses `<optgroup>` per folder; neither `localStorage['antifan_annotation_session_id']` nor global `lastAnnotationSessionId` re-targets a tab
- [ ] `Mo Space` on a folder with valid `space.json` opens declared terminals (awaited in daemon mode) + tabs with role/alias (local files via `antifan-preview://`); commands confirmed per content hash; invalid manifest shows field-level errors, opens nothing; concurrent opens idempotent
- [ ] `idlePolicy: "never"` (manifest or `Danh dau la sync`) refuses sleep with a stated reason in-process and daemon mode
- [ ] Starting a second sync terminal for the same Haravan `org_id+theme_id` shows a warning requiring confirm
- [ ] Tests added per phase pass; `tsc` clean; existing suites not weakened

## Red-team (kongming, 2026-09-29) applied

GO-WITH-CHANGES → applied: `file:` blocked → `path` tabs via `antifan-preview://` (P5); space:open
channel/admission/sender gate, single-read hash, per-folder lock (P5); `ensureProjectForFolder` for
dialog-free project open (P3, reused P5); corrected sleep entry points + result shape end-to-end (P6);
daemon passthrough + `serializeSessionFragment` fields (P5); `{folder}` scoped to sender's folder (P2);
global `lastAnnotationSessionId` fallback removed (P4); `Danh dau la sync` route (P6); anchor fixes.

<!-- slug: terminal-hub-project-spaces -->
