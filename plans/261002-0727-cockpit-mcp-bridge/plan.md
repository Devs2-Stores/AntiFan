---
title: "QA Cockpit ↔ MCP Bridge (main-owned checklist store)"
description: "Move the Theme Studio checklist out of toolbar localStorage into a main-owned JSON store and expose it to external agents as theme.cockpit_* MCP capabilities with live toolbar repaint."
status: pending
priority: P1
effort: 12h
branch: wip/260930-0945-multi-window
tags: [mcp, theme-qa, cockpit, ipc, toolbar, capability-catalogue]
created: 2026-10-02
---

# cockpit-mcp-bridge

## Overview

External agents driving AntiFan through `mcp__antifan_browser_*` tools cannot see or drive the in-app **Theme Studio & QA Cockpit** (`src/renderer/toolbar.html:449-580`) because checklist state lives only in the toolbar renderer's `localStorage` under `antifan_theme_checklist_state_v3:<scope>` / `antifan_theme_checklist_custom_items:<scope>` (`src/renderer/toolbar.ts:529,625`). The QA engine (`theme.qa_validate`, `src/main/tools/browser-capabilities.ts:1591`) already runs in main and writes receipts to `<workspaceRoot>/.antifan/qa-receipts/` (`browser-capabilities.ts:1714`), but nothing in main owns the checklist.

**User-decided architecture (Option A):** checklist state moves into a main-owned store persisted at `<workspaceRoot>/.antifan/qa-checklist.json`, keyed by the existing scope `origin@workspaceTag` (`toolbar.ts:568-571`). The toolbar reads/writes through new IPC invoke channels on the existing `IpcRoute` surface; eight new `theme.cockpit_*` capabilities mutate the same store through a `CockpitPort`; every mutation pushes a dedicated `TOOLBAR_CHANNELS.THEME_CHECKLIST_UPDATED` frame to the owning window's `toolbarView` (same delivery pattern as `PHONE_STATUS`, `native-tab-host.ts:14548-14552`).

Red-team corrections now baked into the design (all findings applied):
- **`runThemeQa` is `private` and resolves its target via `getAutomationTarget() || {activeTabId}`** (`native-tab-host.ts:14563-14574`) — as-is it would silently QA the wrong tab. It becomes `public runThemeQa(tabId, options)`, resolving strictly via `this.tabs.get(tabId)`; an unset/unknown tab fails `TARGET_REQUIRED`, never falls back.
- **`TOOLBAR_CHANNELS.THEME_QA_STATE` is declared but has zero senders** (`contracts.ts:319`; pushes only via `STATE_UPDATED`'s active-tab field at `native-tab-host.ts:14475`). This plan makes it real: an unconditional `{tabId, state}` frame on every QA state transition, with a renderer tabId-aware gate — otherwise `cockpit_scan` on a bound≠active tab leaves the cockpit blind.
- **Lost-update safety:** whole-array saves are CAS-guarded on `baseUpdatedAt`; agent mutations use per-item ops; all store writes are synchronous read-merge-rename in one uninterrupted step (rationale at `native-tab-host.ts:13984-13996`) or funneled through a per-file chain (`enqueueSavedTabsWrite`, `native-tab-host.ts:529-533`).
- **`workspaceRoot` travels in the contract** (`{scope, workspaceRoot}` on LOAD/SAVE/push) so a scope routes to exactly one file — `workspaceTag` is a one-way hash and must never be re-resolved backwards.
- **unknown-workspace scopes are in-memory provisional** — no disk persistence (a shared runtime-dir file would mix unrelated unresolved workspaces).

**Non-goals:** no auto-fix inside the cockpit (fix = agent edits theme files, cockpit tracks); no changes to `ThemeQaWorkflow.validate` (`src/main/qa/theme-qa-workflow.ts:346`); no gating on ticking (free tick + optional note, user decision).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Main-owned, scope-keyed checklist store: atomic sync persistence, CAS/per-item mutation contract, legacy migration flags, unknown-workspace provisional mode | P1 |
| 2 | Eight `theme.cockpit_*` capabilities + `antifan_*` aliases reachable via the omp MCP proxy and in-proc MCP server, all `requiresBrowserTarget:true` with bound-workspace scope derivation | P1 |
| 3 | Toolbar cockpit renders identical UX but sources state through IPC, repaints on broadcast, escapes all agent-writable fields, and is generation-guarded against stale async continuations | P1 |
| 4 | End-to-end proof: `cockpit.mark` flips a live checkbox; `cockpit.scan` navigates the **bound** tab + runs the real `runThemeQa` path + updates findings even when bound≠active; state survives app reload | P1 |

## Architecture

```mermaid
flowchart LR
  subgraph External["External agent (omp stdio MCP)"]
    A[theme.cockpit_* tool]
  end
  A -->|antifan.capability.dispatch| B[bridge-server.ts:2470-2533]
  B --> C[capability-transport.ts:790 dispatchAuthenticated]
  C --> D[theme.cockpit_* capabilities<br/>src/main/tools/cockpit-capabilities.ts]
  D -->|per-item ops / CAS| E[CockpitPort → owning NativeTabHost]
  E --> F[theme-checklist-store.ts<br/>{workspaceRoot}/.antifan/qa-checklist.json]
  E -->|scan| G[host.runThemeQa(tabId, opts)<br/>native-tab-host.ts:14563 → public]
  G -->|THEME_QA_STATE {tabId,state}| H[toolbarView webContents]
  E -->|THEME_CHECKLIST_UPDATED {scope,workspaceRoot,items,updatedAt}| H
  I[toolbar.ts renderer] -->|invoke LOAD/SAVE {scope,workspaceRoot}| J[CHROME_ROUTES<br/>native-tab-host.ts:2450+]
  J --> F
```

**Scope identity contract (unchanged):** `scope = <origin>@<workspaceTag>` — origin from the active/bound tab URL (`checklistOrigin`, `toolbar.ts:554-566`), tag from `workspaceTag(workspacePath)` (`toolbar.ts:579-587`), path from `resolveTargetWorkspace` (`native-tab-host.ts:13148`, served via `WORKSPACE_IDENTIFY` at `native-tab-host.ts:2531-2536`). The hash function and all checklist constants move verbatim into `src/shared/theme-checklist.ts`. Because the tag is a one-way hash, **`workspaceRoot` is carried alongside `scope`** in every IPC frame and push — a scope routes to exactly one file by construction, never by re-resolving the hash.

**Agent-side scope derivation:** `CockpitPort` derives `{origin, workspaceRoot, scope}` from the bound `browserTarget.tabId` — live tab URL for origin, `resolveTargetWorkspace(undefined, tab.state.url)` for root, memoized per `tabId+url` (invalidated on navigation). An explicit `params.scope` is accepted only when it re-derives equal — a mismatch is `SCOPE_MISMATCH`, never silent adoption of another window's scope.

**Parity gate constraint:** `scripts/check-mcp-budget-dominance.mjs` fails the build when catalogue capabilities and the proxy `definitions` array (`scripts/antifan-omp-mcp.cjs:31`) diverge — catalogue registration, proxy rows, AND the gate's recording-stub args (`check-mcp-budget-dominance.mjs:164`) MUST land together.

## Phases

| # | Phase | Status | Effort |
|---|-------|--------|--------|
| 1 | [Main-owned checklist store + CockpitPort + IPC channels + runThemeQa(tabId) rework](./phase-01-checklist-store.md) | Pending | 4.5h |
| 2 | [Eight `theme.cockpit_*` capabilities + proxy definitions + parity-gate stub](./phase-02-cockpit-capabilities.md) | Pending | 3h |
| 3 | [Toolbar IPC cutover + live repaint + escaping + generation guards + migration](./phase-03-toolbar-cutover.md) | Pending | 3h |
| 4 | [End-to-end verification](./phase-04-verification.md) | Pending | 1.5h |

Dependencies are strictly sequential: P2 needs the P1 store + port + `runThemeQa(tabId)`; P3 needs the P1 channels/routes; P4 exercises P1–P3.

## Success Criteria

- [ ] `theme.cockpit_mark` on an item flips the checkbox live in the open cockpit modal (broadcast-driven repaint, no reload).
- [ ] `theme.cockpit_scan` (with `page`) resolves the page route, navigates the **bound** storefront tab (not the active one), runs `runThemeQa(tabId)`, and findings update via the new real `THEME_QA_STATE` frame even when bound≠active.
- [ ] `theme.cockpit_list` / `cockpit_findings` / `cockpit_report` return scope-keyed state derived strictly from the bound workspace; report output is the same markdown the 📋 Báo Cáo button produces (`toolbar.ts:3554-3605`) via a shared builder.
- [ ] No lost updates: concurrent `cockpit_mark` + toolbar save cannot clobber each other (per-item ops / CAS on `baseUpdatedAt`, proven by an interleaved-mutation unit test).
- [ ] Existing ticks survive cutover: union merge (file items ∪ legacy, file wins id collisions), gated by `existed`/`migrated`/`legacyMigrated` flags — agent writes made before the cockpit ever opens are never overwritten by migration.
- [ ] unknown-workspace scopes never touch disk (in-memory provisional, flagged in list/report output).
- [ ] Agent-supplied fields render escaped (no XSS through `cockpit_add_item.name`/`desc`/`qaPoint`/`note` into `info.innerHTML`, `toolbar.ts:1025-1028`).
- [ ] `check-mcp-budget-dominance.mjs` passes with a recording-stub CockpitPort — catalogue ↔ proxy parity is real, not phantom.
- [ ] `test/main/chrome-ipc-routes.test.ts` push-channel audit accepts `THEME_CHECKLIST_UPDATED` (set at `chrome-ipc-routes.test.ts:243-263`).
- [ ] `THEME_QA_RUN` toolbar route cannot be widened into a tabId grant — it constructs `{workspaceRoot}` explicitly (F13).
- [ ] No cockpit UX regression: same modal, same buttons, same report text.

## Cross-Plan Notes

- **Persistence format:** `{ "version": 1, "scopes": { "<scope>": { "items": ThemeChecklistItem[], "updatedAt": <ms>, "legacyMigrated": <bool> } } }` — one version field only (KISS). Custom items and `done` flags live on items (collapses today's two localStorage keys into one record); `legacyMigrated` is the durable migration marker (F10).
- **`note` field:** `cockpit_mark` accepts `note?: string`; stored as optional `note` on `ThemeChecklistItem`. Renderer shows it appended to the QA line when present — additive only, all fields HTML-escaped.
- **Windows atomic write:** temp `<target>.tmp-${pid}-${seq}-${Date.now()}` + `fs.renameSync`, direct-write fallback on EPERM (precedent `terminal-manager.ts:1157-1168` — NOT `writeSavedTabsDocumentSync`, which rethrows); temp cleanup on failure; boot/lazy sweep deletes `qa-checklist.json.tmp-*` debris.
- **Concurrency contract:** every save is sync read-merge-write under one scope; CAS compares `baseUpdatedAt`; capability mutations are per-item ops that never replace the whole array. Two windows mutating the same file cannot clobber sibling scopes.
- **Toolbar-absent safety:** store is main-owned; MCP mutations work with the modal closed. Broadcast is `safeSendWebContents` — dead/loading webContents is a no-op; next LOAD returns file truth.
- **Multi-window:** `CockpitPort` resolves the owning host per bound `tabId` through the same `tabAuthorities` callbacks that build `BrowserControlPort` (`src/main/index.ts:4101`). Broadcast goes only to that host's toolbar; `workspaceRoot` in the payload lets a wrong-window toolbar drop the frame anyway (defense in depth).
- **Rollback:** additive channels/capabilities; reverting restores localStorage reads. `.antifan/qa-checklist.json` left on disk is harmless — no data-loss path.

## Red Team Review

### Session — 2026-10-02
**Findings:** 15 unique (26 raw, deduplicated) — **all 15 accepted** and applied (user-approved).
**Severity breakdown:** 2 Critical, 7 High, 6 Medium
**Full record:** [reports/red-team-findings.md](./reports/red-team-findings.md)

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | runThemeQa private / activeTabId-anchored — cockpit_scan would QA wrong tab | Critical | Accept | Phase 1, plan.md Overview |
| 2 | THEME_QA_STATE dead channel + broadcast gated on activeTabId | Critical | Accept | Phase 1 (real {tabId,state} push), Phase 3 (renderer gate) |
| 3 | Stored XSS — agent-writable item fields raw into innerHTML | Critical→High | Accept | Phase 3 (escape all fields), Phase 1 (caps) |
| 4 | cockpit_scan workspaceRoot bypasses confineWorkspaceRoot | High | Accept | Phase 1 (confine inside runThemeQa), Phase 2 (confine in scan) |
| 5 | Parity gate fails without CockpitPort stub | High | Accept | Phase 2 (gate script touched + stub) |
| 6 | Lost-update: whole-array replace, no serialization | High | Accept | Phase 1 (per-item ops + CAS), Phase 3 (conflict adopt) |
| 7 | Scope routing ambient + non-invertible (hash, focus-dependent) | High | Accept | Phase 1 ({scope,workspaceRoot} contract + per-tab memo) |
| 8 | requiresBrowserTarget:false → cross-window read/write | High | Accept | Phase 2 (all tools true + SCOPE_MISMATCH) |
| 9 | Stale LOAD poisons scope slot | High | Accept | Phase 3 (checklistScopeGen guard) |
| 10 | Migration probe unobservable + wrong merge direction | Medium | Accept | Phase 1 (flags), Phase 3 (union merge + boot sweep) |
| 11 | checklistWorkspacePending not origin-keyed | Medium | Accept | Phase 3 (Map by origin + re-check) |
| 12 | Implicit save-on-switch writes stale array | Medium | Accept | Phase 3 (dropped) |
| 13 | Missing validation caps / page enum / THEME_QA_RUN tabId leak | Medium | Accept | Phase 1 (caps + route hardening), Phase 2 (page enum) |
| 14 | unknown-workspace global env-split file | Medium | Accept | Phase 1 (in-memory provisional, no disk) |
| 15 | Spec inconsistencies + stale anchors + wrong paths | Medium | Accept | All files re-anchored; F15's own fixture-path suggestion corrected to `test/fixtures/mcp/` |

**Key risks addressed:** wrong-tab QA execution, dead findings propagation, stored XSS into chrome-privileged renderer, arbitrary-path file writes, silent lost updates across toolbar/agent writers, scope misrouting across windows, durable cross-project contamination.

**Reviewer's verified non-findings:** IPC sender auth (`surface:'toolbar'` + top-frame check) sound; READ_SAFE_CAPABILITIES membership appropriate; unattached invocations fail closed (`ATTACHMENT_REQUIRED`); scope key cannot escape to a path.

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01-checklist-store.md, phase-02-cockpit-capabilities.md, phase-03-toolbar-cutover.md, phase-04-verification.md
- Decision deltas checked: runThemeQa signature/visibility; THEME_QA_STATE real channel + tabId gate; {scope,workspaceRoot} contract; CAS/per-item ops; 8 canonical capabilities; provisional unknown-workspace; capability counts; corrected file paths; anchor corrections
- Reconciled stale references: 2 (`src/main/browser/project-preferences.ts` path, `test/unit/fixtures/mcp/` path — both fixed to actual)
- Unresolved contradictions: 0

## Validation Log

### Session 1 — 2026-10-02
**Trigger:** post-red-team validation (`/ak:plan validate` via user choice)
**Questions asked:** 4

#### Questions & Answers

1. **[Architecture]** cockpit_scan với page:X — nếu bound tab đã đang ở đúng route, có nên bỏ qua navigate?
   - Options: Skip navigate nếu đúng route | Luôn navigate lại
   - **Answer:** Skip navigate nếu đúng route
   - **Rationale:** mirrors nút Quét QA hiện tại (toolbar.ts:910-916); tránh reload phá state đang test. Already encoded in phase-02 requirement (scan settle step).

2. **[Architecture]** Boot sweep migrate localStorage legacy keys — thời điểm chạy?
   - Options: Lazy khi toolbar hydrate | Ngay khi main khởi động
   - **Answer:** Lazy khi toolbar hydrate
   - **Rationale:** main không đọc được renderer localStorage mà không qua executeJavaScript; renderer enumerate keys là path rẻ nhất. Matches phase-03 "at hydration" spec.

3. **[Scope]** Cockpit có nên hiển thị indicator khi mutation đến từ agent?
   - Options: Không, giữ UX y nguyên | Thêm badge 'agent'
   - **Answer:** Không, giữ UX y nguyên
   - **Rationale:** ngoài scope yêu cầu; broadcast repaint đủ. Matches "No cockpit UX regression" criterion.

4. **[Architecture]** Alias naming cho 8 canonical tools?
   - Options: antifan_cockpit_* | Không cần alias
   - **Answer:** antifan_cockpit_*
   - **Rationale:** nhất quán convention antifan_* hiện có. Matches phase-02 alias spec.

#### Confirmed Decisions
- Scan skip-navigation on correct route: confirmed (phase-02, no change needed)
- Migration sweep timing: lazy at toolbar hydration (phase-03, no change needed)
- No agent-origin indicator in UI: confirmed non-goal (plan.md, no change needed)
- Alias set: `antifan_cockpit_*` ×8 (phase-02, no change needed)

#### Action Items
- None — all answers confirm existing plan decisions.

#### Impact on Phases
- None — zero propagation required.

#### Verification Results
- Tier: Standard — **skipped per Step 2.5 guard** (Red Team Review already carries verification evidence; all three reviewers ran evidence-filtered checks)
- [UNVERIFIED]/[INFERENCE] tags: 1 found (toolbar.css:2932 anchor) → resolved VERIFIED (`/* AntiFan Theme Studio & QA Cockpit Styling */` exists at toolbar.css:2932) and tag removed from phase-03
- Remaining unverified claims: 0

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01..04 (already reread post-red-team at sweep time)
- Decision deltas checked: 4 validation answers — all confirmatory, no deltas introduced
- Reconciled stale references: 0
- Unresolved contradictions: 0
