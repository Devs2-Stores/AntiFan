# Phase 3 — Toolbar IPC cutover: status report

Status: DONE_WITH_CONCERNS (one runtime-environment caveat, see below)

## Files owned/touched
- `src/renderer/toolbar.ts` — full cutover
- `src/renderer/toolbar.css` — added `.theme-item-note` styling (spec-allowed)
- `scripts/copy-static.mjs` — injected `theme-checklist.js` prelude into `toolbar.js` emit (see Deviation)

## Behaviors implemented
- Shared-module consumption: toolbar.ts uses `import type` for `ThemeChecklistItem`/`ThemePageDef` + a `themeShared()` accessor that reads `window.ThemeChecklistShared` (injected by copy-static). All `PAGE_DEFS`, `DEFAULT_THEME_CHECKLIST`, `PRODUCT_PAGE_PATH`, `UNKNOWN_WORKSPACE_TAG`, `WORKSPACE_IDENTIFY_TIMEOUT_MS`, `workspaceTag`, `checklistScope`, `buildChecklistReport` call sites rewired. Local copies deleted.
- `checklistScopeGen` generation guard incremented on every `applyChecklistScope`; LOAD/SAVE/migration continuations capture `gen`+scope and bail when stale (F9).
- F12: implicit save-on-switch deleted; `persistThemeChecklist` is the only writer, serialized through `checklistSaveChain` so a second mutation CASes on the first's `updatedAt`.
- F11: `checklistWorkspacePending` is a `Map<origin, Promise>`; post-await `origin !== checklistOrigin()` drop; `checklistWorkspaceRoot` stashed on resolve; LOAD/SAVE send `{scope, workspaceRoot}`.
- Broadcast `onThemeChecklistUpdated` wired beside `onThemeQaState`: scope+workspaceRoot match -> adopt+repaint; never SAVEs.
- `onThemeQaState` gated on `frame.tabId !== activeTabId` (F2).
- F3: row builder escapes name/desc/qaPoint/note through `escapeHtml`; note rendered in `.theme-item-note`.
- F10: LOAD branches on `migrated`/`legacyMigrated`; `!migrated` probes both legacy keys, applies the done-map by id to the merged union (file wins id collisions, per pre-cutover loader semantics), SAVEs once, removes keys only after SAVE resolves. Boot sweep enumerates `antifan_theme_checklist_*`, migrates same-tag + unknown-tag scopes, skips foreign tags, and skips `activeChecklistScope`/`currentChecklistScope()` (live LOAD migrates them — fixed a double-LOAD race found by smoke).
- F6: SAVE `{conflict:true}` adopts store items, repaints, toasts "Checklist vừa được agent cập nhật".
- Degraded fallback: missing/rejecting IPC -> `checklistIpcUnavailable` + warn-once + legacy localStorage ops.
- All mutation sites (checkbox, toggle-all, delete, editor save, reset=SAVE defaults, report=shared builder) route through `persistThemeChecklist` + repaint.

## Verification (smoke, jsdom)
Real `toolbar.html` DOM + emitted `toolbar.js` (with copy-static prelude) in jsdom, stubbed `antifanToolbar`:
- identify once; LOAD once per scope with `{scope, workspaceRoot}`; foreign-tag scope never loaded.
- F10 union: legacy-only row absorbed, done-map applied to file row, both keys removed post-SAVE; sweep migrated same-workspace other-origin scope, left foreign one alone.
- Toggle -> exactly one SAVE; broadcast -> repaint, zero SAVEs, wrong-scope/wrong-root frames ignored.
- F3: `<img onerror>` in name/note stayed text.
- F6: injected CAS conflict adopted store rows + toast.
- `npx tsc -p tsconfig.json --noEmit` — zero errors on toolbar.ts.
- Standalone emit inspected: no `require(` in toolbar.js; prelude binds `window.ThemeChecklistShared`.
- `node scripts/copy-static.mjs` completes.

## Deviation from spec (one)
The spec says `toolbar.ts` `import`s values from `../shared/theme-checklist`. That is impossible: toolbar.html loads `toolbar.js` as a classic script with `contextIsolation:true`, `nodeIntegration:false`, `sandbox:false`, and `exports-shim.js` provides `exports`/`module` but never `require` — a value import compiles to a `require()` that crashes at boot. Resolution without touching `toolbar.html` (frozen surface): `import type` for types + `copy-static.mjs` inlines the compiled shared module as a `window.ThemeChecklistShared` prelude before the exports guard. Same pattern the script already uses for `terminal-write-dispatcher.js`/`session-activity.js` into standalone.html. If Main prefers a literal `import`, the alternative is bundling or a `contextBridge` exposure — both larger changes; flagging for orchestrator awareness.

## Concern / known limit
- `checklistIpcUnavailable` is sticky per page load (warn once, then legacy ops) — matches spec's "degraded only" wording.
- The `.tsbuildinfo.typecheck` file I used for the type-check lands in `.compiled/` (gitignored build dir).
