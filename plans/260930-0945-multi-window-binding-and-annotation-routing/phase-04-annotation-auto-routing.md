---
title: "Phase 4: Annotation auto-routing"
status: done
---

# Phase 4: Annotation auto-routing

## Overview
`dispatchAnnotationToTerminal` (annotation-dispatch.ts:25-33) resolves `'auto'`/absent
targets via process-global `TerminalManager.getActiveSessionId()` → an annotation picked
in project window A is typed into whichever window's terminal switched last
(`switchSession`/:2852 + `writeTo`/:1936 are global; `resolveWritableSession`/:1950 can
wake/mint a PTY in a foreign workspace). Sole caller: `handleInspectPickResult`
(tab-devtools-host.ts:731-732). `visibleTerminalSessions` and `terminalStateForWindow`
outputs are already wired through ctx (native-tab-host.ts:1549); the only missing member
is `windowActiveSessionId` (:7049).

      (arm 2 of `resolveTargetWorkspace` at native-tab-host.ts:12620-12624 also leaks:
      it hands the ACTIVE capsule's workspace to `formatPath`/artifact writes before the
      active-session arm — on the skip path artifact resolution must use URL
      classification only, never activeCapsuleId/active-session arms; unclassifiable
      URLs write to a neutral/runtime dir.)

Secondary leaks: `:618` validates `targetSessionId` against the UNSCOPED
`tm.listSessions()`; `:650-652` substitutes process-global active when the payload omits
a target; `resolveTargetWorkspace`'s 3rd arm uses global active-session cwd
(:12635-12641); `startInspect` :509 pushes the global id into `__antifanTerminalContext`.

## Requirements

- [ ] `TabDevToolsContext` += optional `windowActiveSessionId?: () => string`
      (wire `() => this.windowActiveSessionId()` in native-tab-host.ts:~1547; optional to
      avoid touching ≥5 typed ctx literals in tests).
- [ ] `dispatchAnnotationToTerminal(tm, resolvedSessionId, fullPrompt)` — write ONLY when
      `resolvedSessionId` is a non-empty, non-'auto' id (`switchSession` + `writeTo`);
      otherwise return without touching the manager. Drop the `getActiveSessionId` and
      bare `write` arms entirely.
- [ ] `handleInspectPickResult` ordering: resolve scope first —
      `scope = selectAnnotationTargets(this.ctx.visibleTerminalSessions())` (window-owned,
      running, non-split — same rows the picker offered). Validate `rawResult.targetSessionId`
      membership in `scope` for CONCRETE ids only — preserve the persist arm shape:
      `'auto'` always persists (per-tab memory, Flow 26 locks it); a concrete id
      persists only when it is a member of scope — explicit foreign-window ids are
      refused at validation AND at dispatch.
- [ ] 'auto'/absent resolution: `ws = ctx.resolveAnnotationWorkspace(undefined, tabUrl)`;
      match `scope` entries by `canonicalFolderKey(s.folderPath) === canonicalFolderKey(ws)`
      (`../project/workspace-capsule` :129; `folderPath` is already the canonical realpath).
      Ambiguity rule (kongming): within the matched set `ctx.windowActiveSessionId?.()` wins;
      zero matches or multi-match without window-active → skip + journal.
- [ ] No fallback outside the match domain: when 'auto' yields zero workspace matches
      or an ambiguous multi-match without window-active, resolution is TERMINAL —
      skip + journal; never fall back to `windowActiveSessionId` (a window-active
      session in a different workspace folder would reintroduce the cross-project
      write). Window-active wins ONLY inside the workspace-matched set.
- [ ] Compute workspaces AFTER resolving the session; pass the resolved id so
      `formatPath` (:714-727) and `resolveAnnotationWorkspace`'s session arm agree.
- [ ] Fail-closed skip is NOT silent (kongming): report the skip through the existing
      picker payload channel (`sessions`/`selectedSessionId` fields at :508) plus a
      `console.warn`/`recordLifecycleEvent`; annotation markdown + screenshots still
      write to the URL-resolved workspace, `element-picked` still emits, `fullPrompt`
      still lands on clipboard (order :681 before :731 — artifact precedes dispatch).
- [ ] `startInspect` :509 → push the window-scoped active id into
      `__antifanTerminalContext` instead of the global one.
- [ ] Name the behavior change: a workspace-mismatched terminal previously received
      writes; now it never does.
- [ ] Narrow `TerminalDispatchPort` to `{switchSession, writeTo}` (annotation-dispatch
      :11-16) so the dropped `getActiveSessionId`/`write` arms can't be reintroduced
      through the type; update test fakes (phase-01-core-safety.test.ts:183-189,
      agent-browser-script fakes).

## Related Code Files

- Modify: `src/main/browser/annotation-dispatch.ts` (:14-33 — drop global arms)
- Modify: `src/main/browser/tab-devtools-host.ts` (handleInspectPickResult :599-748,
  startInspect :505-510, ctx interface)
- Modify: `src/main/browser/native-tab-host.ts` (:1537-1560 ctx literal)
- Read-only reuse: `src/main/browser/workspace-resolver.ts` (:59-84),
  `src/main/browser/terminal-manager.ts` (:504-577 SessionSummary, :588-590
  selectAnnotationTargets), `element-picker.ts` (:34-80, :1490-1499 — unchanged)

## Test Coverage

- Rewrite `test/main/agent-browser-script.test.ts:388-418` cases 2-4 (currently lock the
  bug): concrete id → `switch:`+`writeTo:`; unresolved 'auto'/empty → ZERO terminal calls.
- Add: 'auto' resolves inside window scope when global active is foreign; URL→folderKey
  match picks the workspace session; explicit foreign-window id refused at validation.
- Add: window-active session whose folder differs from the URL workspace is NOT
  selected on 'auto' (regression for the removed fallback).
- Keep unchanged: chromium-terminal-comprehensive :822-858 (per-tab 'auto' memory,
  explicit routing), element-picker-targets tests, phase-01-core-safety :186-189.
- Typed ctx literals stay untouched if the new member is optional (tab-devtools-host.test
  :131, eval-ceiling-bound.test.ts:130, phase-02:530/588, render-surface:506,
  split-view:164).

## Success Criteria

Pick in window A with project-B terminal globally active → annotation writes only to a
window-A session; zero-match 'auto' produces artifact+clipboard and a reported skip,
never a foreign write.

## Risks / Rollback

- `switchSession` still mutates the single global active id — other windows' sidebar
  active recomputes; pre-existing design debt, flagged (writing without switching would
  avoid re-pointing but hides the receiving session in its own window).
- Revert = restore dispatch arms; no persisted state.
