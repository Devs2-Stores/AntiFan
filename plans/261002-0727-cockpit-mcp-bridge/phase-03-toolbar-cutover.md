---
phase: 3
title: "Toolbar IPC cutover + escaping + generation guards + migration"
status: pending
priority: P1
effort: 3h
dependencies: [phase-01]
---

# Phase 3: Toolbar IPC cutover + escaping + generation guards + migration

## Overview

Re-plumb `src/renderer/toolbar.ts` so cockpit state flows through the P1 IPC surface, hardened per F3 (escape every interpolated field), F9 (scope-generation guard on all async continuations), F10 (flag-driven union migration + boot sweep), F11 (origin-keyed workspace pending), F12 (drop implicit save-on-switch). Renderer keeps every render function and UX; only the storage layer, constants imports, and async plumbing change.

## Requirements

- [ ] `toolbar.ts` imports `{ ThemeChecklistItem, ThemePageDef, PAGE_DEFS, DEFAULT_THEME_CHECKLIST, QA_GATE_DISCLAIMER, PRODUCT_PAGE_PATH, UNKNOWN_WORKSPACE_TAG, WORKSPACE_IDENTIFY_TIMEOUT_MS, workspaceTag, checklistScope, buildChecklistReport }` from `../shared/theme-checklist`; delete local copies (`toolbar.ts:377-412,414-466,468-528,540,579-587`, builder 3569-3592). Renderer-stateful helpers stay: `checklistOrigin` 554-566, `resolveChecklistWorkspace`, `resolveChecklistRoute` 734-749, `storefrontOrigin` 715-726, `navigatePreview` 751-777.
- [ ] **Async load/save with generation guard [F9]:** `let checklistScopeGen = 0` — incremented on every `applyChecklistScope`; every async continuation (`getThemeChecklist` result, migration, save-cleanup) captures `const gen = checklistScopeGen` + `const requestedScope = activeChecklistScope` and **bails when `gen !== checklistScopeGen || requestedScope !== activeChecklistScope`** (pattern: `getDocumentGeneration` fencing, `native-tab-host.ts` ~14579).
- [ ] **DROP implicit save-on-switch [F12]:** delete `saveThemeChecklist(themeChecklist, activeChecklistScope)` pre-switch flush at `applyChecklistScope` (`toolbar.ts:639`) — every mutation already saves; a stale in-memory array must not be re-persisted under a new scope.
- [ ] **Origin-keyed pending [F11]:** `checklistWorkspacePending` becomes `Map<origin, Promise>` (or `{origin, promise}` + equality re-check `checklistWorkspaceResolvedFor === origin` after await, `toolbar.ts:594-622`). Prevents origin B inheriting origin A's tag.
- [ ] `workspaceRoot` in the renderer contract [F7]: stash `checklistWorkspaceRoot` alongside the tag when `identifyWorkspace` resolves (it returns `{workspacePath}`, `native-tab-host.ts:2533`); LOAD/SAVE send `{scope, workspaceRoot, …}`; broadcast handler drops frames whose `workspaceRoot` mismatches the resolved one.
- [ ] Broadcast subscription beside `onThemeQaState` (`toolbar.ts:4910`): `onThemeChecklistUpdated(({scope, workspaceRoot, items}) => { if (scope !== activeChecklistScope || workspaceRoot !== checklistWorkspaceRoot) return; themeChecklist = items; renderThemeStudioChecklist(); })` — never triggers a save (echo dedupe: identical items + idempotent render).
- [ ] `THEME_QA_STATE` tabId gate [F2]: `onThemeQaState(({tabId, state}) => { if (tabId && tabId !== activeTabId) return; renderThemeQa(state); })` at `toolbar.ts:4910` — foreign-tab scans no longer repaint the badge.
- [ ] **Escape all agent-writable fields [F3]:** row builder `info.innerHTML` (`toolbar.ts:1025-1028`) interpolates `name`/`desc`/`qaPoint`/`note` through `escapeHtml` (`toolbar.ts:2765`, already used at e.g. 1596,1767) OR switch to `createElement`/`textContent` (precedent `toolbar.ts:~5522`). Applies to the report builder too (markdown fields already raw text — escape is a render concern only; keep report plaintext unchanged for output parity).
- [ ] Migration [F10]: after LOAD, branch on `{existed, migrated, legacyMigrated}` — not on "looks default": if `!legacyMigrated`, read BOTH `antifan_theme_checklist_state_v3:<scope>` and `antifan_theme_checklist_custom_items:<scope>` (`toolbar.ts:529,625`), union-merge `file ∪ legacy` (file wins id collisions), SAVE once, then `localStorage.removeItem` both keys **only after SAVE resolves**. **Boot sweep:** at hydration, enumerate `localStorage` for the `antifan_theme_checklist_` prefix and migrate every scope found, not just the active one — orphaned scopes of closed storefronts still migrate.
- [ ] Fallback: `getApi()?.getThemeChecklist` absent or invoke rejects → `console.warn` once → legacy local ops (degraded-boot usability only; mirroring `resolveChecklistWorkspace` failure posture `toolbar.ts:615-618`).
- [ ] CAS conflict handling [F6]: SAVE returning `{conflict:true, items}` → adopt returned items into `themeChecklist` + repaint + toast `Checklist vừa được agent cập nhật` — never silent overwrite.
- [ ] All mutation call sites go through async save + generation check: checkbox 1011-1016, toggle-all 948-960, delete 1069-1077, editor save ~3739, reset 3541-3551 (reset saves `DEFAULT_THEME_CHECKLIST` via SAVE — no more `localStorage.removeItem`), report 3554-3605 uses shared `buildChecklistReport`.
- [ ] Extend the `antifanToolbar` typing block (`toolbar.ts:141-152`) with the three new members so `getApi()` type-checks.

## Architecture

```text
Scope switch (async, generation-fenced):
  applyChecklistScope: gen++ → activeChecklistScope = next → await getThemeChecklist(next, root)
    → bail if gen/scope stale → themeChecklist = items → migrateLegacyIfNeeded → render

Mutations:
  local  → mutate themeChecklist → saveThemeChecklistIpc {scope, root, items, baseUpdatedAt}
           → conflict? adopt returned items → render
  agent  → THEME_CHECKLIST_UPDATED {scope, root, items} → scope+root match → adopt → render (no save)

QA state:
  THEME_QA_STATE {tabId,state} → tabId !== activeTabId ⇒ drop → renderThemeQa(state)
  STATE_UPDATED themeQa (active-tab only) unchanged
```

## Related Code Files

| File | Change | Anchors (re-verified) |
|---|---|---|
| `src/renderer/toolbar.ts` | imports, async plumbing, gen guard, escaping, migration, pending map, subscriptions | constants 377-528; scope/identity 534-623; storage 625-701; row render 999-1082; handlers 895-1077,3541-3780; hydrate 4873-4910; `escapeHtml` 2765; API typings 141-152 |
| `src/renderer/toolbar.html` | none (ids unchanged) | modal 449-580; badge 485 |
| `src/renderer/toolbar.css` | none expected; optional `.theme-item-note` only if layout needs it | cockpit block 2932 (`/* AntiFan Theme Studio & QA Cockpit Styling */` verified) |
| `src/preload/toolbar-preload.ts` | (P1) verify `antifanToolbar` surface | 163-169,249 |

## Implementation Steps

1. Pre-flight: re-grep `toolbar.ts` anchors (drift observed twice); confirm `escapeHtml` is module-scope (2765, confirmed); confirm no existing renderer tests pin the checklist (glob `test/renderer/*theme*`, `toolbar-tab-strip.test.ts`).
2. Shared imports + delete local constants; keep renderer-stateful helpers.
3. `workspaceTag`-pending map by origin + post-await re-check (F11); stash `checklistWorkspaceRoot` at the same site (`resolveChecklistWorkspace`, 594-623).
4. `checklistScopeGen` + async `applyChecklistScope`/`ensureChecklistScope` chain; remove implicit save (F12); thread `await` through all mutation call sites.
5. `onThemeChecklistUpdated` + `onThemeQaState` tabId gate subscriptions (~4910).
6. Escape `name`/`desc`/`qaPoint`/`note` in row render (F3); keep code/pathHint textContent-safe (they already render via `textContent` at 1020/1040-1043 — verify, then escape where interpolated).
7. Migration: flag-driven union merge + boot sweep over prefixed keys + post-SAVE key removal.
8. CAS conflict adopt-and-repaint path.
9. Smoke: standalone harness (`test/renderer/standalone-harness.ts`) faked `antifanToolbar` → render + push frame → checkbox flips; `<img onerror>` payload stays inert.

## Success Criteria

- [ ] Zero `localStorage` reads/writes under `antifan_theme_checklist_*` except migration probe/removal.
- [ ] Generation guard proven: switch scope mid-LOAD → stale continuation does not write `themeChecklist` or render (unit/harness test).
- [ ] Migration: file-scope with agent rows + legacy scope with ticks → union survives; `legacyMigrated` prevents re-merge; both local keys removed post-SAVE; boot sweep migrates a scope the user never opened.
- [ ] XSS probe: `add_item {name:'<img src=x onerror=alert(1)>'}` renders as text.
- [ ] CAS conflict → toolbar adopts store items + toast; no second SAVE echo.
- [ ] `THEME_QA_STATE` for foreign tabId → badge unchanged.
- [ ] Type-check on touched renderer file passes.

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| Async chain flashes default list before LOAD resolves | M×M | `verifyingWorkspace`/pending gate (`toolbar.ts:950,1012`) blocks render until invoke resolves |
| Broadcast echo → save loop | M×M | Handler never calls SAVE; identical-items repaint is idempotent |
| Union merge direction wrong | M×H | File wins id collisions — agent rows are never clobbered (F10 spec verbatim); harness fixture test |
| Origin-keyed pending leaves stale tags | M×M | Map keying + `checklistWorkspaceResolvedFor` re-check after await |
| `escapeHtml` misses a field in report markdown | L×L | Report is plaintext markdown — escaping belongs to HTML render only; report parity preserved |
| Anchor drift | M×L | Step-1 re-grep; snapshot `#44B0` |
