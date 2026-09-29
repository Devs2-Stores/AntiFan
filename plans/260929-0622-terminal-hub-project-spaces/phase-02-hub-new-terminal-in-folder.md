---
phase: 2
title: "Hub new terminal in folder"
status: done
priority: P1
effort: "1d"
dependencies: [1]
---

# Phase 2: Hub new terminal in folder

## Overview

Add `+ Terminal trong thu muc...` to the hub. It mints a session bound to the chosen folder and
changes nothing else.

## Evidence

- Existing `antifan:capsule:pick-folder` (`native-tab-host.ts:3829-3888`) does realpath +
  `findCapsuleByRoot` (reusable), then `capsuleManager.switchTo` + `TerminalManager.setCapsule`
  (3881-3884). `setCapsule` re-points the process-global `currentCapsuleId/currentCwd` and types
  `Set-Location` into the selected live shell (`terminal-manager.ts:1138-1182`). Reusing it for the
  hub reproduces the "one project's agent ends up in another folder" bug.
- `antifan:terminal:new-session` (3102) → `resolveTerminalCreationTarget` (6400) → hub mints land in
  the process default (app cwd), which is why hub terminals end up `unassigned` at `AntiFan`.
- `TerminalManager.createSession(cwd, capsuleId, ownerKey)` (`terminal-manager.ts:2175`) already
  stamps a per-call capsule without touching window state; daemon proxy returns a Promise
  (`daemon-client.ts:453`) → MUST await.

## Requirements

- New channel `TERMINAL_CHANNELS.NEW_IN_FOLDER = 'antifan:terminal:new-in-folder'`
  (`src/shared/contracts.ts`), surface `sidebar`; handler admitted only from the shared manager
  sender (`isSharedTerminalManagerSender`, `native-tab-host.ts:6104`) or a project window for its own folder.
- Flow: dialog (phase-1 defaultPath) → `canonicalFolderKey` → `findCapsuleByRoot` ?? `capsuleManager.create`
  (NO `switchTo`) → `await tm.createSession(realPath, capsule.id, ownerKey)` where `ownerKey` =
  sender window's owner key (hub → `unassigned`, unchanged invariant) → return `{ sessionId, capsuleId }`.
- Admission: same `assertApplicationAdmitsHostWork` before and after the dialog, `admitThenRun`
  around the mint (copy pattern from 3855-3873).
- Optional arg `{ folder }` skips the dialog (used by phase 3 group header `+` and phase 5). It is
  canonicalised; from a project-window sender it MUST equal that window's
  `windowWorkspaceAffiliation.workspacePath` (canonicalised) or the call is refused
  `FOLDER_NOT_OWNED`. The hub may pass any existing directory; non-directories refused.

## Related Code Files

- Modify: `src/shared/contracts.ts` (channel const)
- Modify: `src/main/browser/native-tab-host.ts` (route table near 3829)
- Modify: `src/preload/standalone-preload.ts` (`newTerminalInFolder(folder?)`)
- Modify: `src/renderer/standalone.js` + `standalone.html` (hub header button; group header `+`)
- Test: `test/main/terminal-new-in-folder.test.ts` (create)

## Implementation Steps

1. Add channel + preload bridge.
2. Implement handler; share the capsule lookup with pick-folder by extracting
   `resolveCapsuleForFolder(host, realPath)` (lookup+create only). pick-folder keeps its switch step.
3. Hub button in header; per-group `+` passes the group's folder.
4. Test with fake capsule manager + fake TerminalManager (existing seams used by
   `native-tab-host-restore-terminal-target.test.ts`): asserts `switchTo`/`setCapsule` never
   called, existing capsule reused, `createSession` awaited (proxy returning Promise).

## Success Criteria

- [ ] New session `cwd` = realpath(folder), `capsuleId` = pre-existing capsule for folder
- [ ] `capsuleManager.getActive()` and every other session's cwd unchanged after call
- [ ] Works in daemon mode (Promise id) and in-process mode (string id)
- [ ] Quit during open dialog → refused, nothing minted

## Risk

- Capsule store has historical duplicates; `findCapsuleByRoot` prefers unaffiliated→active→newest;
  accepted — phase 3 groups by folder, so duplicates no longer split the view.
