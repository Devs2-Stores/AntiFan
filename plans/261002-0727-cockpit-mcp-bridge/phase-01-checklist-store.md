---
phase: 1
title: "Main-owned checklist store + CockpitPort + IPC channels + runThemeQa rework"
status: pending
priority: P1
effort: 4.5h
dependencies: []
---

# Phase 1: Main-owned checklist store + CockpitPort + IPC channels + `runThemeQa` rework

## Overview

Stand up the main-process half of the bridge — hardened per red-team findings F1, F2, F4, F6, F7, F9 (contract flags), F10, F13, F14, F15:

- Pure checklist store at `<workspaceRoot>/.antifan/qa-checklist.json` with sync atomic writes, per-item ops + CAS saves, validation caps, and an in-memory provisional mode for `unknown-workspace` scopes.
- Shared `src/shared/theme-checklist.ts` so renderer and main derive byte-identical scopes.
- `NativeTabHost`: LOAD/SAVE routes, `broadcastChecklistUpdated`, **public `runThemeQa(tabId, options)`** resolving strictly via `this.tabs.get(tabId)`, real `THEME_QA_STATE` `{tabId,state}` pushes, and `confineWorkspaceRoot` inside `runThemeQa` itself.
- `CockpitPort` host-resolution seam built beside `BrowserControlPort`.

No MCP capabilities yet (P2); no renderer changes yet (P3).

## Requirements

- [ ] `src/shared/theme-checklist.ts` exports `ThemeChecklistItem` (+ `note?: string`), `ThemePageDef`, `PAGE_DEFS`, `DEFAULT_THEME_CHECKLIST` (44 items — verified count), `QA_GATE_DISCLAIMER`, `PRODUCT_PAGE_PATH`, `UNKNOWN_WORKSPACE_TAG`, `WORKSPACE_IDENTIFY_TIMEOUT_MS`, `workspaceTag()`, `checklistScope(origin, tag)`, `buildChecklistReport()` — moved verbatim from `toolbar.ts:377-412,414-466,468-528,540,579-587`.
- [ ] `src/main/qa/theme-checklist-store.ts`: synchronous pure functions — `checklistFilePath(root)`, `readChecklistFile`, `writeChecklistFileAtomic`, `getScope(root)`, `mutateScope(root, scope, op)` (per-item ops: `mark|add|remove|markPage`; re-read file, apply, write in ONE uninterrupted sync step — rationale precedent `native-tab-host.ts:13984-13996`), `setScopeCas(root, scope, items, baseUpdatedAt)` (CAS for toolbar whole-array saves; conflict → `{conflict:true, items}` + no broadcast [F6]). All reads fresh from disk; no shared in-memory cache for persisted scopes.
- [ ] Atomic write convention [F15]: temp `<target>.tmp-${pid}-${seq}-${Date.now()}` + `fs.renameSync`, direct-write fallback on EPERM/locked (precedent `terminal-manager.ts:1157-1168` — `writeSavedTabsDocumentSync` rethrows and is NOT the fallback model), temp cleanup on failure; `sweepTmpFiles(dir)` deletes `qa-checklist.json.tmp-*` debris on first open of a file.
- [ ] Validation caps at store boundary [F13]: strip unknown keys per item; string fields (`id`,`code`,`name`,`desc`,`qaPoint`,`pathHint`,`note`,`page`) coerced to string + truncated ~1KB each; `done` coerced boolean; max ~200 items per scope; `page` must be `^[a-z0-9-]{1,32}$`. Violations → throw `CapabilityError('INVALID_ARGUMENT')` (route layer converts to `false`).
- [ ] Unknown-workspace [F14]: scopes whose tag is `unknown-workspace` (or whose `workspaceRoot` is empty) are served from a per-host **in-memory provisional map**, never written to any file; `list/report` payloads carry `isProvisional:true`.
- [ ] Contract flags [F9/F10]: LOAD returns `{scope, workspaceRoot, items, updatedAt, existed, migrated}`; each scope record carries `legacyMigrated` once legacy data has been merged in.
- [ ] `workspaceRoot` in contract [F7]: LOAD/SAVE args and `THEME_CHECKLIST_UPDATED` payload all carry `{scope, workspaceRoot, …}`; routes verify `workspaceRoot` non-empty for persisted scopes (empty ⇒ provisional path).
- [ ] `runThemeQa` rework [F1]: `public async runThemeQa(tabId: string, options?: {workspaceRoot?: string})` at `native-tab-host.ts:14563` — resolve target via `this.tabs.get(tabId)` + lease fields (mirror construction at 14571-14574); **NO `getAutomationTarget()` fallback**; unknown/dead tab → `{ok:false,error:'TARGET_REQUIRED'}` + `tabThemeQaStates.set(tabId,…error)`. All error/state writes key the resolved `tabId`, never `activeTabId`.
- [ ] `THEME_QA_STATE` becomes a real channel [F2]: extract `setThemeQaState(tabId, state)` helper; every transition emits `safeSendWebContents(shell.toolbarView?.webContents, THEME_QA_STATE, {tabId, state})` unconditionally (first-ever sender; channel exists at `contracts.ts:319`, preload listener `toolbar-preload.ts:165-169`, renderer gate `toolbar.ts:4910`). `STATE_UPDATED`'s `themeQa` stays active-tab (`native-tab-host.ts:14475`) — toolbar ignores foreign rows by tabId.
- [ ] `confineWorkspaceRoot` inside `runThemeQa` [F4]: `workspaceRoot: confineWorkspaceRoot(options?.workspaceRoot, resolveTargetWorkspace(undefined, tab.state.url) || controlPlane.getWorkspaceRoot())` before `validateThemeQa` (`control-plane-runtime.ts:395-400` reads it raw — defense must live in the caller chain, plus P2 confines again in `cockpit_scan`).
- [ ] `THEME_QA_RUN` route hardened [F13]: at `native-tab-host.ts:2528` construct `{workspaceRoot: typeof a?.workspaceRoot==='string' ? a.workspaceRoot : undefined}` explicitly and call `host.runThemeQa(host.activeTabId, …)` — NEVER forward `args[0]` verbatim or a `tabId`.
- [ ] Three `TOOLBAR_CHANNELS` (`contracts.ts:~369`): `THEME_CHECKLIST_LOAD`, `THEME_CHECKLIST_SAVE`, `THEME_CHECKLIST_UPDATED` (`'antifan:toolbar:theme-checklist-*'`). Two `IpcRoute` rows after `WORKSPACE_IDENTIFY` (~`native-tab-host.ts:2530`), `surface:'toolbar'`, default `kind:'handle'` (`ipc-router.ts:46`): LOAD `{scope, workspaceRoot}` → `{scope, workspaceRoot, items, updatedAt, existed, migrated, isProvisional}`; SAVE `{scope, workspaceRoot, items, baseUpdatedAt}` → CAS write + push, returns `{ok, items, updatedAt, conflict?}`.
- [ ] Agent scope derivation [F7]: `CockpitPort`/`NativeTabHost` memoizes `{origin, workspaceRoot, scope}` per `tabId`, keyed on `tab.state.url` (invalidate on navigation); root comes from `resolveTargetWorkspace(undefined, tabUrl)` — the same source `WORKSPACE_IDENTIFY` serves the renderer.
- [ ] `CockpitPort` in `src/main/tools/cockpit-port.ts`, constructed in `src/main/index.ts` beside `new BrowserControlPort` (`index.ts:4101`) with the same `tabAuthorities`-style host resolution; forwarded via `controlPlane.registerBrowser` → `registerBrowserCapabilities` trailing param (`control-plane-runtime.ts:362-371`, signature `browser-capabilities.ts:259`).

## Architecture

```text
Store file (persisted scopes only):  {version:1, scopes:{[scope]:{items, updatedAt, legacyMigrated}}}
Provisional scopes (unknown-workspace):  per-host Map<scope, {items, updatedAt}> — never hit disk.

Mutation paths all terminate in one sync critical section:
  capability per-item op ─┐
  toolbar SAVE (CAS)      ├─► mutateScope/setScopeCas ─► writeChecklistFileAtomic ─► broadcastChecklistUpdated
  migration merge         ┘         (sync read→apply→rename; conflict ⇒ no write, return fresh)

Broadcast: safeSendWebContents(toolbarView, THEME_CHECKLIST_UPDATED, {scope, workspaceRoot, items, updatedAt})
           — immediate, NOT the throttled broadcastState (14414+).

QA state: setThemeQaState(tabId, state) { tabThemeQaStates.set(tabId, state);
          safeSendWebContents(toolbarView, THEME_QA_STATE, {tabId, state});
          if (tabId===activeTabId) broadcastState(); }
```

## Related Code Files

| File | Role | Anchors (re-verified this pass) |
|---|---|---|
| `src/shared/theme-checklist.ts` | NEW: shared types/constants/report builder | sources `toolbar.ts:377-412,414-466,468-528,540,579-587,708` |
| `src/main/qa/theme-checklist-store.ts` | NEW: file store | write precedent `terminal-manager.ts:1157-1168`; chain precedent `native-tab-host.ts:529-533` |
| `src/main/tools/cockpit-port.ts` | NEW: host-resolution port + per-tab scope memo | ctor pattern `index.ts:4101` |
| `src/shared/contracts.ts` | +3 channel constants | `TOOLBAR_CHANNELS` `contracts.ts:316-369` |
| `src/main/browser/native-tab-host.ts` | routes + store host methods + `runThemeQa`/`THEME_QA_STATE` rework | `CHROME_ROUTES` 2450+; `THEME_QA_RUN` 2528; `WORKSPACE_IDENTIFY` 2531-2536; `runThemeQa` 14563; `getThemeQaState` **public** 14558; `broadcastPhoneStatus` pattern 14548-14552; `navigateAndWait` 10459 |
| `src/main/browser/ipc-router.ts` | no change | `IpcRoute` 43-58; `dispatchChromeRoute` test seam 220-224 |
| `src/main/index.ts` | construct/inject `CockpitPort` | `new BrowserControlPort` 4101 |
| `src/main/control-plane/control-plane-runtime.ts` | accept + forward `cockpit?` | `registerBrowser` 362-371; `validateThemeQa` 395-400 |
| `src/main/qa/diagnostics-filter.ts` | reuse `confineWorkspaceRoot` | export at 296 |
| `src/preload/toolbar-preload.ts` | +3 channel names (local CHANNELS map 9-62), +3 api members (pattern 163-169) | bridge `contextBridge` 249 |
| `test/main/chrome-ipc-routes.test.ts` | push set + `THEME_CHECKLIST_UPDATED` | 243-263 |
| `test/main/theme-checklist-store.test.ts` | NEW unit tests | harness `test/support/chrome-route-harness.ts`; `dispatchChromeRoute` |

## Implementation Steps

1. **Pre-flight (this plan's anchors were verified at snapshot `native-tab-host.ts#2938`; re-grep before each edit — file drifts):** read full `runThemeQa` body (14563-14630) to find every `activeTabId` usage; confirm `setThemeQaState`-equivalent refactors cover all `tabThemeQaStates.set` sites (14566,14578,14585,14608,14619 area + `did-navigate` reset at 8156); locate the `controlPlane.registerBrowser(browserPortLocal)` call in `index.ts` near 4101-4330.
2. `src/shared/theme-checklist.ts` — verbatim move + `note?` field + `buildChecklistReport`.
3. `theme-checklist-store.ts` — file format, validation caps, sync ops, CAS, provisional map interface, tmp sweep.
4. `contracts.ts` + `toolbar-preload.ts` — channels + preload API (`getThemeChecklist`, `saveThemeChecklist`, `onThemeChecklistUpdated`).
5. `native-tab-host.ts` — store host methods, LOAD/SAVE routes (validate caps server-side too — renderer is not trusted, F3/F13), `broadcastChecklistUpdated`, `runThemeQa(tabId, options)` public + `TARGET_REQUIRED` + confine, `setThemeQaState` + `THEME_QA_STATE` pushes, `THEME_QA_RUN` route constructs `{workspaceRoot}` explicitly.
6. `cockpit-port.ts` + `index.ts`/`control-plane-runtime.ts` wiring.
7. `chrome-ipc-routes.test.ts` push set.
8. Tests: store unit tests — **incl. interleaved same-scope mutation** (CAS conflict returns fresh items; second write must re-base [F6 note]), caps rejection, provisional no-disk, union helpers, corrupt file → defaults, tmp sweep; route tests via `dispatchChromeRoute` (pattern `project-window-layout.test.ts:436`).

## Success Criteria

- [ ] `test/main` green on new + touched files; `chrome-ipc-routes` audit accepts the push channel.
- [ ] Unit test proves: SAVE(CAS stale baseUpdatedAt) → `conflict` + fresh items, no file change, no broadcast.
- [ ] `runThemeQa('dead-tab')` → `{ok:false,error:'TARGET_REQUIRED'}` and `tabThemeQaStates` keyed `'dead-tab'`, not `activeTabId`.
- [ ] `runThemeQa` with `workspaceRoot:'../../etc'` writes receipts only under the confined root (assert path in fake controlPlane call).
- [ ] Every QA transition emits `THEME_QA_STATE` `{tabId,state}` — harness captures the frame for a non-active tabId.
- [ ] unknown-workspace scope: after save+load round-trip, no `qa-checklist.json` exists in any dir.
- [ ] No renderer behavior change yet — cockpit still runs on localStorage.

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| `runThemeQa` body reads `activeTabId` beyond resolution sites | M×M | Step-1 full read; every `setThemeQaState` keys the resolved tabId |
| THEME_QA_STATE push fires while toolbar absent | L×L | `safeSendWebContents` no-ops on dead wc; LOAD returns file truth on reopen |
| Caps too strict for legitimate huge checklists | L×L | 200 items/scope is 4.5× current default count; error is explicit |
| CAS conflict UX deadlock (toolbar never learns fresh state) | L×M | SAVE response carries fresh `items`; P3 renderer re-syncs in-memory + repaints on conflict |
| Provisional scopes lose state on app quit | — | Accepted (F14): unresolved workspace = no durable identity to bind state to; flagged in report |
| Anchor drift mid-session | M×L | Every step re-greps; anchors cite snapshot `#2938` |
