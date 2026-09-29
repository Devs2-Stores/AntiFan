---
phase: 1
title: "Dialog path + canonical folder key"
status: done
priority: P1
effort: "0.5d"
dependencies: []
---

# Phase 1: Dialog path + canonical folder key

## Overview

Fix the folder dialog that ignores `E:\Work`, and add one shared canonical-folder function every
later phase groups by.

## Evidence

- `native-tab-host.ts:3835-3843`: `fs.existsSync('E:/Work')` is true on Windows, so the first branch
  wins and `defaultPath: 'E:/Work'` reaches the dialog.
- Electron `shell/browser/ui/file_dialog_win.cc` `SetDefaultFolder` passes the path to
  `SHCreateItemFromParsingName` and silently skips `SetFolder` on failure. Win32 probe:
  `'E:/Work'` → `E_INVALIDARG`, `'E:\Work'` → `S_OK`.
- `index.ts:2196` `resolveProjectFromFolder` also opens a chooser — check its `defaultPath` too.
- `findCapsuleByRoot` (`workspace-capsule.ts:191`) already resolves + lowercases + realpath-falls-back;
  its normalisation is the one to reuse, not re-invent.

## Requirements

- Every `dialog.showOpenDialog` `defaultPath` in `src/main` is `path.win32.normalize`d on win32.
- Export `canonicalFolderKey(p: string): string` from `src/main/project/workspace-capsule.ts`:
  `realpathSync` (fallback: `path.resolve`), then lowercase on win32. `findCapsuleByRoot` uses it
  (single definition).

## Related Code Files

- Modify: `src/main/browser/native-tab-host.ts` (3835-3843: collapse the 4-branch probe to
  `path.normalize` of the first existing candidate)
- Modify: `src/main/index.ts` (`resolveProjectFromFolder` defaultPath, if forward-slash)
- Modify: `src/main/project/workspace-capsule.ts` (extract `canonicalFolderKey`)
- Test: `test/unit/workspace-capsule-canonical-key.test.ts` (create) — case, trailing slash,
  forward slash, nonexistent path fallback

## Implementation Steps

1. `grep` `showOpenDialog` in `src/main`; list every `defaultPath` source.
2. Replace the probe chain with `const defaultDir = ['E:\\Work'].find(fs.existsSync) ?? process.cwd();`
   then `path.normalize(defaultDir)`.
3. Extract `canonicalFolderKey`; refactor `findCapsuleByRoot` to call it; keep its preference order.
4. Unit test the key; run existing `findCapsuleByRoot` tests (ProjectRegistryScout listed
   `test/main/*capsule*` suites) unchanged.

## Success Criteria

- [ ] No forward-slash `defaultPath` reaches `showOpenDialog` (grep + unit)
- [ ] `canonicalFolderKey('E:/Work/x/')=== canonicalFolderKey('e:\\work\\x')`
- [ ] Existing capsule tests pass unchanged
- [ ] Manual: dialog opens at `E:\Work` on the installed build (the one fact source code cannot prove)

## Risk

- Electron packaged version may already normalise → fix is harmless either way.
- realpath on a network/offline drive can throw → fallback to `path.resolve`, never throw.
