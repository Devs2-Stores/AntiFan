---
phase: 3
title: "Project windows, search and durable placement"
status: pending
priority: P1
effort: ""
dependencies: [1, 2]
---

# Phase 3: Project windows, search and durable placement

## Overview

Expose explicit Open Project, stable project titles, local tab strips, Unassigned and cross-project tab search. Preserve single-writer tab persistence and independent native layout.

## Requirements

- Two projects can remain visible on different monitors, including independent desktop/mobile split panes.
- Empty project shows an empty state; no automatic hidden about:blank page.
- User project opening/search may focus a window; agent creation must not.
- Restore bounds/maximized state per project and recover disconnected displays in DIP.

## Architecture

Dependency map: renderer explicit intent → sender-validated Main manager → existing project shell or nonactivating creation. Every shell projects its own tab strip; the search endpoint separately returns user-visible inventory across shells with project/path labels. User search activation revalidates exact ID and restores/focuses its current owner. Escape returns focus to the invoking control.

NativeTabHost is the sole saved-tabs.json writer: versioned tab records carry verified affiliation and local active-tab IDs keyed by serialized WindowOwner. WindowStateManager alone writes normal bounds/maximized intent in window-state.json keyed by the same owner; geometry is never duplicated in saved-tabs.json. Use discriminated owner keys to avoid project/Unassigned collisions. Preserve prior data until successful write/readback; migrate unresolved records to Unassigned without cookie migration. Cold launch opens the existing project-opening surface, not all historical windows. URL restoration does not recover JavaScript/form state.

## Related Code Files

Paths relative to `E:/Work/apps/AntiFan`.

| Action | File | Change |
|---|---|---|
| Modify | src/main/browser/project-window-manager.ts; src/main/browser/project-window-shell.ts | Open/focus, local active state, display events |
| Modify | src/main/browser/window-state.ts | Keyed normal bounds/maximized state and visible-titlebar clamping |
| Modify | src/main/browser/native-tab-host.ts | Scoped broadcast and single-writer saved tabs/search inventory |
| Modify | src/renderer/toolbar.ts; src/renderer/toolbar.html; src/renderer/toolbar.css | Project title, tab-search control, result list, empty and error states |
| Modify | src/renderer/standalone.js | Scoped workspace/terminal projection, project-opening intention |
| Modify | src/preload/toolbar-preload.ts; src/shared/contracts.ts | Typed search/open/activate projections |
| Modify | src/preload/standalone-preload.ts | Typed project-opening intention on existing standalone bridge |
| Modify | test/main/window-state.test.ts | Missing displays, changed work areas and maximize restoration |
| Create | test/unit/browser/project-window-layout.test.ts | Behavioral per-shell split/native bounds isolation |
| Create | test/renderer/project-tab-search.test.ts | Search keyboard/stale-result behavior |
| Create | test/main/project-window-persistence.test.ts | Restart migration, no cross-project overwrite |

One existing direct regression file and three new behavioral suites. Existing tab-layout-invariants.test.ts checks stylesheet text, not native split behavior; it is not evidence for this contract.

## Implementation Steps

1. Bind project-opening controls to the manager's serialized open method. Main derives title/path from validated registry records, never renderer-supplied names as authority.
2. Add Unassigned entry to the same opening surface when unresolved pages exist. Cold launch with no known project leaves a visible home/Unassigned shell with an explicit Open Project action.
3. Add dedicated tab search available in every shell. Literal case-insensitive title/URL matching, stable inventory order for empty query, explicit no-results state, project/path labels, keyboard arrows/Enter/Escape and accessible status announcements. Exclude offscreen/ephemeral automation tabs.
4. Revalidate exact tab liveness and current owner before any restore/focus/select side effect. On stale result report unavailable with no focus change. After valid lookup, select that exact tab and present its owner in the same synchronous Main action; do not await between validation and selection. Never change attachments or substitute a tab by index.
5. Persist normal bounds separately from maximize state. Validate against display.workArea, not display.bounds; clamp titlebar y into the usable area. Repair saved normal bounds even for maximized windows. React independently to display removal and work-area/scale changes; keep valid negative DIP coordinates and never multiply them by scaleFactor.
6. Route each shell's split-review/device changes only to its active logical tab. Keep capture-host ownership and background readiness truthful.
7. Migrate legacy saved-tabs once and transactionally at the file level; retain source on failure. Test closing/reopening one project does not overwrite another's saved state. No automatic opening of all historical projects.
8. Agent-only initialization uses `show: false` and never calls show/showInactive/restore/focus/maximize. Preserve saved maximized intent until explicit user presentation; maximize can show a hidden window. Preserve passive capture with exact contents identity, laid-out bounds and frame readiness checks rather than displaying a project to capture it. Test an agent-created missing window whose stored state is maximized while typing in another window.

## Function and Interface Checklist

- [ ] WindowStateManager load/save/validation receives stable project key.
- [ ] broadcastState/updateLayout/split coordination resolve explicit owner.
- [ ] Search listing and explicit foreign activation have distinct IPC contracts.
- [ ] Standalone project/terminal selections never mutate another window's scope.

## Test Scenario Matrix

| Scenario | Expected |
|---|---|
| Duplicate project names and page titles | Path labels distinguish exact destination |
| Result closes during search | Unavailable, no foreign fallback |
| A resize/split preset | B bounds, active page and capture unchanged |
| Monitor unplug/DPI change | All titlebars recoverable, independent maximize preserved |
| Interrupted legacy write | Source survives and retry does not duplicate tabs |
| B created by agent while A typing | No raise/unminimize/focus or active-tab switch |
| Maximized on removed monitor then unmaximize | Repair saved normal bounds as well as current placement; titlebar reachable |
| Negative monitor coordinates or small work area | Retain valid negative DIP positions; reachable controls without claiming a 960x640 window fits a smaller work area |

## Success Criteria

- [ ] Search/placement/persistence tests pass; all controls reachable at 960x640 DIP.
- [ ] Live two-monitor interaction and split capture demonstrate independent surfaces.
- [ ] Search focuses foreign owner only on explicit user action.

## Risk Assessment

Native view bounds and display topology cannot be certified by jsdom. If Electron background creation raises a window or capture moves another visible view, block release and adjust the shell integration rather than loosening focus acceptance. Data migration changes only metadata; no source deletion or live partition reassignment.

Electron API constraints: [showInactive/maximize](https://www.electronjs.org/docs/latest/api/base-window#winshowinactive), [capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts). Non-focusing does not establish no-raise behavior; live evidence remains mandatory.
