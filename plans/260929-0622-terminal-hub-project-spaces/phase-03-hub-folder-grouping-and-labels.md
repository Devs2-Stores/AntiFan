---
phase: 3
title: "Hub folder grouping, labels, triage"
status: done
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 3: Hub folder grouping, labels, triage

## Overview

Hub sections become one per real folder, rows read `<folder> · <n>` with agent state, and
unassigned rows get a one-click assign.

## Evidence

- `standalone.js:1082-1085` `rowGroupKeyOf`: manager groups by `'capsule:'+capsuleId`; else by
  user `category`. Capsule ids duplicate per folder → same folder can render as several sections.
- `isCapsuleGroupKey` (999) guards keep capsule keys out of persisted `terminalCategories`
  (HubSessionScout: 5866-5873, 6010) — the new folder key must keep the same guard.
- Session `cwd` is as-spawned (junction/8.3 aliases possible); `SessionSummary` has no canonical folder.
- Names: `Terminal ${id}` (`terminal-manager.ts:277`, 1363).
- Run cards (`runtime/runs/<terminalSessionId>.json`, `RunCardLifecycle` idle|running|waiting_user|ended,
  `contracts.ts:710`) already reach the manager (`native-tab-host.ts:4377`, managerAll).
- Assign route `TERMINAL_CHANNELS.ASSIGN_PROJECT` (~4222) refuses `TARGET_WINDOW_ABSENT` when the
  project window is closed; renderer must `openProject` first (comment at 4243).
- Persisted state 2026-09-29: 13 sessions, 7 `unassigned`, 4 filed under catch-all `project-00000000-...0001` ("Tong hop").

## Requirements

- Main adds `folderKey` + `folderLabel` (basename of canonical path) to each `SessionSummary`
  projection, computed from the session's capsule `workspacePath` ?? `cwd` via `canonicalFolderKey`,
  cached per path (no fs call per broadcast).
- Renderer: in manager shell, `rowGroupKeyOf` → `'folder:'+folderKey`; `isCapsuleGroupKey` guard
  extended to `folder:` keys; header shows folder label + full path tooltip + agent-state counts.
- Row label (display only): `<folderLabel> · <n>` where `n` = 1-based order within the folder,
  stable by session creation order. Persisted `name` untouched; user-renamed sessions keep their name.
- Row badge from run card: running / waiting_user (highlight) / idle / none.
- "Chua gan du an" section at top of hub: each unassigned row has `Gan vao...` → existing projects
  list → `openProjectWindow({ projectId })` (`index.ts:2311`; with a projectId it opens no dialog)
  if the window is absent → existing ASSIGN_PROJECT. Extra item `Du an moi tu thu muc nay` →
  `openProjectWindow({ folder })` → extracted `projectIdForResolvedFolder` (`index.ts:2218-2279`
  post-dialog half of `resolveProjectFromFolder`: adopt or create, no dialog) → assign. No cwd auto-suggest.
- Non-manager windows keep category grouping unchanged.

## Related Code Files

- Modify: `src/main/browser/native-tab-host.ts` (`terminalStateForWindow` 6172 projection enrich)
- Modify: `src/main/browser/terminal-manager.ts` (`SessionSummary` :463 optional `folderKey`, `folderLabel`)
- Modify: `src/main/index.ts` (extract `projectIdForResolvedFolder`; PROJECT_OPEN accepts `{ folder }`)
- Modify: `src/renderer/standalone.js` (rowGroupKeyOf, buildGroupForKey, isCapsuleGroupKey, row label, triage section)
- Test: `test/renderer/terminal-hub-folder-groups.test.ts` (create); rerun
  `test/renderer/terminal-capsule-picker.test.ts`, `terminal-tab-categories-sleep.test.ts`,
  `standalone-project-chip.test.ts`

## Implementation Steps

1. Projection enrich + cache keyed by raw path.
2. Renderer grouping swap behind `isSharedManagerShell()`.
3. Labels + badges.
4. Triage section wired to existing assign + openProject.
5. Manual one-time cleanup is the user's action through this UI (no script mutating
   `terminal-sessions.json`); the 4 "Tong hop" rows are shown with their real folder group so the
   user sees them.

## Success Criteria

- [ ] Two sessions at `E:\Work\x` and `e:/work/X/` render in one group
- [ ] Folder keys never written to `terminalCategories` (test)
- [ ] `terminal-sessions.json` byte-identical names after labels render
- [ ] Assign from triage on a closed project opens the window then assigns; agent-owned rows still refused

## Risk

- Main broadcast frequency: enrichment must be O(1) per row via cache; add cache invalidation on
  capsule rename/affiliation change.
