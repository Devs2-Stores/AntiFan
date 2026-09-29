---
phase: 4
title: "Picker folder groups"
status: done
priority: P2
effort: "0.5d"
dependencies: [1, 3]
---

# Phase 4: Picker folder groups

## Overview

"Gui toi" in the element picker lists terminals under `<optgroup>` per folder, with the phase-3
labels, and stops reading a hidden cross-tab `localStorage` choice.

## Evidence

- `element-picker.ts:828-831` reads `localStorage['antifan_annotation_session_id']`; writes at 857
  and 1410. Shared by every tab of the same origin → a storefront tab silently re-targets another
  project's terminal.
- Label is the capsule folder at creation, not current cwd (`element-picker.ts:845-847`).
- Sessions come from `selectAnnotationTargets(this.visibleTerminalSessions())`
  (`native-tab-host.ts:7065`); per-tab choice already held as `annotationSessionId` (7071-7077).
- Second cross-tab channel: `native-tab-host.ts:7072` falls back to the process-global
  `TabDevToolsHost.lastAnnotationSessionId` (set at `tab-devtools-host.ts:721`) when the tab has no
  choice → a new storefront tab inherits another project's target.

## Requirements

- Session payload passes `folderKey/folderLabel/displayLabel` (phase 3 projection).
- Picker renders `Tu dong` first, then `<optgroup label=folderLabel>` per folder.
- Remove all three `localStorage` reads/writes and the `lastAnnotationSessionId` fallback; a tab
  with no choice gets `auto` (or the only session in its own folder group). Selection persists only
  via the tab's own `annotationSessionId` (main-held).

## Related Code Files

- Modify: `src/main/browser/element-picker.ts` (800-870, 1405-1412)
- Modify: `src/main/browser/native-tab-host.ts` (7062-7079 payload + fallback)
- Modify: `src/main/browser/tab-devtools-host.ts` (:721 static; delete if no other reader — check with LSP references)
- Test: extend picker test if present, else `test/unit/element-picker-targets.test.ts` (create) on the
  pure option-building function (extract it)

## Success Criteria

- [ ] No `antifan_annotation_session_id` in `src/`
- [ ] Two tabs of same origin keep independent choices
- [ ] Options grouped by folder, labels match hub

## Risk

- Users lose last-remembered target once; acceptable — main-held per-tab value remains.
