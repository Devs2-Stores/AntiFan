# Red Team Findings — cockpit-mcp-bridge (2026-10-02)

3 reviewers (Security Adversary / Failure Mode Analyst / Assumption Destroyer), Standard tier.
26 raw findings → deduplicated to 15 unique. All carry verified `file:line` evidence.
**Disposition: user approved applying all 15.**

## Critical

### F1 — runThemeQa cannot take tabId as specified
- `private` at `native-tab-host.ts:14563`; target resolved via `getAutomationTarget() || {tabId: this.activeTabId}` (14570-14576); error/broadcast keyed to `activeTabId` (14566, 14578, 14585).
- Scan on bound tab B while active tab A → silently QA's wrong tab, returns ok:true.
- **Fix:** make `runThemeQa` public; signature `runThemeQa(tabId, options)`; resolve target via `this.tabs.get(tabId)`/`resolveTargetTabId(tabId)` — NO `getAutomationTarget()` fallback for agent-initiated scans (unset target → `TARGET_REQUIRED`); error-path `tabThemeQaStates.set` uses resolved id. Keep old behavior for toolbar route by passing the toolbar's resolved tab explicitly.

### F2 — findings-update chain dead for bound≠active
- `broadcastState()` gated `tabId === activeTabId` (14585-14587, 14608-14609, 14619-14620); `flushBroadcastState` ships `getThemeQaState(this.activeTabId)` (14451-14474). `TOOLBAR_CHANNELS.THEME_QA_STATE` declared (contracts.ts:319), subscribed (toolbar-preload.ts:167-171, toolbar.ts:4917) but **zero senders in src/main** — dead channel.
- **Fix:** give scanned-tab pushes a real `THEME_QA_STATE` frame `{tabId, state}` sent unconditionally (first real sender), plus toolbar-side tabId-aware render gate; or widen STATE_UPDATED payload to `themeQa: {tabId, state}` and teach `renderThemeQa` to ignore foreign-tab rows. Plan must pick one and name it.

## High

### F3 — Stored XSS via unescaped item fields
- `item.name`/`desc`/`qaPoint` (agent-writable via `cockpit_add_item`, `cockpit_mark.note`) interpolate raw into `info.innerHTML` (toolbar.ts:1025-1028). `escapeHtml` exists (toolbar.ts:2765) unused in row. Toolbar holds full `antifanToolbar` bridge → privilege escalation.
- **Fix:** escape ALL interpolated item fields (escapeHtml or createElement/textContent like toolbar.ts:5522-5525); coerce/truncate string fields at SAVE route + capability boundary.

### F4 — cockpit_scan.workspaceRoot bypasses confineWorkspaceRoot
- `runThemeQa`/`validateThemeQa` read `options.workspaceRoot` raw (native-tab-host.ts:14582; control-plane-runtime.ts:400); `mkdirSync` at theme-qa-workflow.ts:1198-1207. `confineWorkspaceRoot` (diagnostics-filter.ts:296) applied only in `theme.qa_validate` (browser-capabilities.ts:1637).
- **Fix:** apply `confineWorkspaceRoot` inside cockpit_scan AND inside runThemeQa itself (toolbar route inherits).

### F5 — parity gate fails on its own stub args
- `check-mcp-budget-dominance.mjs:165-182` invokes `registerBrowserCapabilities` with `[browserPort, undefined, getWorkspaceRoot]` — no CockpitPort → `catalogue.has('theme.cockpit_*')` false → phantom divergence.
- **Fix:** add gate script to P2 touched files; recording-stub CockpitPort (pattern `recordingCorePort` :152-159); `registerCockpitCapabilities` must tolerate stub without deref.

### F6 — lost-update: whole-array replace, no serialization
- `setScopeItems(scope, items)` replaces entire array; toolbar writes stale in-memory `themeChecklist` (checkbox toolbar.ts:1011-1016, editor 3719-3737); MCP dispatch async (capability-transport.ts:790). Precedent: `enqueueSavedTabsWrite` per-file chain (529-533) + sync read-merge-rename rationale (13985-13996).
- **Fix:** store mutations = per-item ops (mark/add/remove) or CAS on `baseUpdatedAt`/`revision`; all store writes synchronous end-to-end or funneled through a per-file chain; unit test interleaved same-scope mutation.

### F7 — scope routing ambient + non-invertible
- `workspaceTag` = one-way 31-bit hash (toolbar.ts:579-587); `resolveTargetWorkspace` capsule/terminal-first, URL-classify last (native-tab-host.ts:13149-13185) → same scope routes to different files by focus; renderer caches tag per-origin (594-622) while agent re-resolves → scope diverge → broadcast `payload.scope === activeChecklistScope` drops updates.
- **Fix:** routing key in contract (`{scope, workspaceRoot}` echoed), or single fixed-location file, or scope→root index; agent scope derivation must consume the host's cached identify result per tab (invalidate on URL change) or be URL-classify-only.

### F8 — auth gap: requiresBrowserTarget false on reads/mutations
- `authorizeAndResolveEffectiveTarget` runs only when `requiresBrowserTarget` (capability-catalogue.ts:458-459, 534-536). `cockpit_findings {tabId}` → cross-window info disclosure; list/mark/report fall to `defaultHost` (ambient host) → wrong window's store/toolbar.
- **Fix:** `requiresBrowserTarget:true` on findings; list/mark/report derive scope strictly from attachment's bound workspace; reject explicit `scope` that doesn't re-derive.

### F9 — stale LOAD poisons scope slot
- `applyChecklistScope` currently sync (toolbar.ts:636-643); post-cutover `flip scope → await LOAD → themeChecklist = items` races tab switch / `ensureChecklistScope` re-entry (652-666) → foreign items rendered + SAVE'd under wrong scope (durable corruption).
- **Fix:** monotonic scope-generation counter; every continuation (load/migrate/save-cleanup) bails when `requestedScope !== activeChecklistScope` (pattern: `getDocumentGeneration(tabId)` 14588).

## Medium

### F10 — migration probe unobservable + wrong merge direction
- LOAD returns items only; `getScopeItems` synthesizes defaults → absent vs all-default indistinguishable. Agent writes before cockpit open → scope non-default → probe skips → legacy ticks invisible forever. Or migration overwrite wipes agent rows.
- **Fix:** LOAD response carries `existed`/`migrated` flags; per-scope `legacyMigrated` marker; merge = file-items ∪ legacy (file wins id collisions), not gated on default-ness; boot sweep migrates all prefixed localStorage keys.

### F11 — checklistWorkspacePending not origin-keyed
- Single-flight guard unconditioned (toolbar.ts:597): origin B inherits origin A's tag → B's items written under A's scope → durable cross-project contamination.
- **Fix:** key in-flight map by origin; re-check `checklistWorkspaceResolvedFor === origin` after await.

### F12 — implicit save-on-switch writes stale array
- `applyChecklistScope` pre-switch flush (toolbar.ts:640) writes in-memory array stale when broadcasts dropped (F7) or other-window stale (F6). 
- **Fix:** drop implicit save (every mutation already saves) or CAS on revision.

### F13 — missing validation caps at trust boundaries
- SAVE route accepts arbitrary items (unbounded growth, poison persistence); `page` free-string → `PAGE_DEFS[page]` TypeError / mark_page toggles 0 and reports success; `THEME_QA_RUN` route forwards `args[0]` verbatim — once signature widens, renderer gains tabId authority grant.
- **Fix:** item shape/length (~1KB/field)/count (~200) caps + unknown-key strip at route+store; `page` validated against `Object.keys(PAGE_DEFS)` → CapabilityError; THEME_QA_RUN constructs `{workspaceRoot}` explicitly, never forwards tabId.

### F14 — unknown-workspace fallback is a global, env-split file
- One file `getRuntimeDir()/qa-checklist.json` (storage-locations.ts:119) shared by all unresolved workspaces; honors `ANTIFAN_RUNTIME_DIR` (dev/prod split-brain, host-runner.ts:11-29 precedent); same-port projects share rows (violates toolbar.ts:591-594 comment).
- **Fix:** do not persist unknown-workspace scopes to disk (in-memory provisional) or mark `isProvisional` in list/report.

### F15 — spec inconsistencies + stale anchors
- "7 capabilities" vs 8-row table; `add_item` replay-no-op claim lacks `itemId` param; wrong paths `src/main/browser/project-preferences.ts` (actual `src/main/project/`), `test/fixtures/mcp/proxy-seeded-drift.cjs` (actual `test/unit/fixtures/mcp/`); anchors drifted (`runThemeQa` 14563 not 14553, THEME_QA_RUN 2526-2528 not 2516-2519, `broadcastState` 14424 not 14469, `getThemeQaState` 14558); atomic-write fallback precedent only `terminal-manager.ts:1157-1168` (writeSavedTabsDocumentSync rethrows); temp name needs `.tmp-${pid}-${seq}-${Date.now()}` + boot sweep for `qa-checklist.json.tmp-*`.
- **Fix:** correct counts, add `itemId?` to add_item schema, fix paths, re-grep all anchors in one pass, fix precedent citations, add tmp-sweep requirement.

## Verified non-findings (rejected by reviewers themselves)
- IPC sender auth via `surface:'toolbar'` + `chromeSurfaceFor` + top-frame check is sound.
- READ_SAFE_CAPABILITIES membership for read trio appropriate (only exempts EXECUTION_UNCERTAIN replay).
- Unattached invocations fail closed (ATTACHMENT_REQUIRED mcp-server.ts:695).
- Scope cannot escape to path (JSON key only; root from resolver).
- `navigateAndWait` (native-tab-host.ts:10459) is a real lifecycle waiter — scan post-nav settle is fine.
