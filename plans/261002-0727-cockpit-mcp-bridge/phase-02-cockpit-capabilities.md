---
phase: 2
title: "theme.cockpit_* capabilities + proxy definitions + parity-gate stub"
status: pending
priority: P1
effort: 3h
dependencies: [phase-01]
---

# Phase 2: `theme.cockpit_*` capabilities + proxy definitions + parity-gate stub

## Overview

Register **eight** canonical capabilities in a new `src/main/tools/cockpit-capabilities.ts` (keeps the 4k-line `browser-capabilities.ts` flat) plus eight `antifan_*` aliases, all `requiresBrowserTarget:true` — the auth fix for F8: `authorizeAndResolveEffectiveTarget` only runs when `requiresBrowserTarget` is set (`capability-catalogue.ts:458-459,534-536`), so every cockpit call must carry a bound target and derive scope strictly from the bound workspace. `scripts/antifan-omp-mcp.cjs` gets matching `definitions` rows, **and `scripts/check-mcp-budget-dominance.mjs` gets a recording-stub CockpitPort** — otherwise the gate builds the catalogue without the port and reports phantom divergence (F5, gate call args at `check-mcp-budget-dominance.mjs:164`).

## Requirements

All tools: `requiresBrowserTarget:true`; scope params are assertions only — the capability derives `{scope, workspaceRoot}` from `context.browserTarget.tabId` via `CockpitPort` (P1 memoized derivation), and an explicit `params.scope` that re-derives unequal throws `SCOPE_MISMATCH` (F8). `workspaceRoot` params are passed through `confineWorkspaceRoot` before use (F4).

| Tool | Params | Risk/lane | Semantics |
|---|---|---|---|
| `theme.cockpit_list` | `{scope?, tabId?}` | read, `unbounded` | `{scope, workspaceRoot, items, done, total, pages:[…], isProvisional, updatedAt}` |
| `theme.cockpit_mark` | `{itemId, done, note?, scope?, tabId?}` | idempotent-write | per-item op `mark`; `note` ≤1KB; returns `{item, updatedAt}` |
| `theme.cockpit_mark_page` | `{page, done, scope?, tabId?}` | idempotent-write | `page` validated against `Object.keys(PAGE_DEFS)` **∪ pages present in the loaded scope** → `INVALID_ARGUMENT` on unknown (F13); returns `{toggled}` (count actually flipped) |
| `theme.cockpit_add_item` | `{itemId?, code?, name, desc?, qaPoint?, page?, pathHint?, scope?, tabId?}` | idempotent-write | caller `itemId` enables replay-no-op (F15: previously claimed but not declared); default `item_<ts>_<rand>` (`toolbar.ts:3725-3726`); `page` default `'home'`, `pathHint` default `PAGE_DEFS[page].path` |
| `theme.cockpit_remove_item` | `{itemId, scope?, tabId?}` | idempotent-write | per-item op `remove`; returns `{removed}` |
| `theme.cockpit_scan` | `{page?, workspaceRoot?, tabId?}` | `viewport-gate`, `timeoutMs: DEADLINES.toolPolicyMs` | resolve route → `navigateAndWait` bound tab → `runThemeQa(tabId, {workspaceRoot: confined})` → `{ok, report}` |
| `theme.cockpit_findings` | `{tabId?}` | read, `unbounded` | `getThemeQaState(bound tabId)` row (`native-tab-host.ts:14558`, public) |
| `theme.cockpit_report` | `{scope?, tabId?}` | read, `unbounded` | `{markdown, scope, isProvisional}` via `buildChecklistReport` |

Aliases `antifan_cockpit_*` delegate via `catalogue.get('<canonical>')!.execute(params, context)` (`browser-capabilities.ts:1810` precedent).

- [ ] `cockpit_scan` route resolution mirrors `resolveChecklistRoute` (`toolbar.ts:734-749`): fixed `pageDef.path` → `new URL(path, boundTabOrigin)`; `routeKind:'handle-required'` (product) uses bound tab's current URL only if `PRODUCT_PAGE_PATH` matches (`toolbar.ts:708`), else `CapabilityError('ROUTE_UNRESOLVED')` — never fabricates `/products` (comment contract `toolbar.ts:393-398`). No `page` → scan current URL.
- [ ] `cockpit_scan` settle: `CockpitPort.navigateAndWait(tabId, url, timeout)` → `NativeTabHost.navigateAndWait` (`native-tab-host.ts:10459`, verified real lifecycle waiter — red-team non-finding). Skip navigation when bound tab already on route (`toolbar.ts:910-916` mirror). Then `runThemeQa(tabId, …)` — bound≠active now provably correct (P1 F1) and findings reach toolbar via `THEME_QA_STATE` (P1 F2).
- [ ] `cockpit_scan` confines `workspaceRoot` (`confineWorkspaceRoot`, `diagnostics-filter.ts:296`) against the bound tab's resolved root — belt under the P1 confine inside `runThemeQa`.
- [ ] Mutation results = whatever the store returned (`{item|items, updatedAt, conflict?}`); broadcast fired by port/host, never by capability code.
- [ ] Read trio (`list`, `findings`, `report`) join `READ_SAFE_CAPABILITIES` (`antifan-omp-mcp.cjs:1458-1520`). Writes do not.
- [ ] Proxy `definitions` (`antifan-omp-mcp.cjs:31+`): 8 canonical rows `[name, description, properties, required?, oneOf?, 'tabId']` — ambient field `tabId` on all rows (all are target-bound now); colocate near `theme.*` block (66-69). `CAPABILITY_MAP` untouched (identity mapping).
- [ ] `check-mcp-budget-dominance.mjs`: registrations entry `registerBrowserCapabilities: [browserPort, undefined, getWorkspaceRoot]` (line 164) gains a recording-stub cockpit arg — pattern `recordingCorePort` Proxy at 157-160; `registerCockpitCapabilities` MUST NOT dereference port members at registration time (stub-safe).
- [ ] `mcp-server.ts` unchanged — `buildMcpToolList` unions catalogue tools (listTools `mcp-server.ts:546-553`); unattached calls already fail closed `ATTACHMENT_REQUIRED` (692-696, red-team non-finding).

## Architecture

```text
Every capability:
  ctx.browserTarget.tabId ─► cockpit.resolveScope(tabId) ─► {origin, workspaceRoot, scope}
  params.scope? !== derived ⇒ CapabilityError('SCOPE_MISMATCH')
  params.workspaceRoot? ─► confineWorkspaceRoot(params.workspaceRoot, derived.workspaceRoot)
  read  → store.getScope / host.getThemeQaState(tabId)
  write → store.mutateScope / setScopeCas → host.broadcastChecklistUpdated → return
```

## Related Code Files

| File | Change | Anchors (re-verified) |
|---|---|---|
| `src/main/tools/cockpit-capabilities.ts` | NEW `registerCockpitCapabilities(catalogue, cockpit, browser)` | register pattern `browser-capabilities.ts:322+`; `makeBrowserPolicy` 161 |
| `src/main/tools/browser-capabilities.ts` | +1 trailing param `cockpit?`, single call after `antifan_theme_qa_rollback` (~1839) | signature 259 |
| `src/main/control-plane/control-plane-runtime.ts` | forward cockpit arg | `registerBrowser` 362-371 |
| `src/main/qa/diagnostics-filter.ts` | import `confineWorkspaceRoot` | 296 |
| `scripts/antifan-omp-mcp.cjs` | +8 `definitions` rows, +3 `READ_SAFE_CAPABILITIES` | defs 31+, theme rows 66-69, read-safe 1458-1520 |
| `scripts/check-mcp-budget-dominance.mjs` | +recording-stub cockpit arg | `registrations` 163-173, `recordingCorePort` 157-160 |
| `test/main/theme-mcp-capabilities.test.ts` | extend coverage | conventions 44-99, `makeBoundContext` ~97 |
| `test/fixtures/mcp/fake-omp-mcp.cjs` | sync rows if parity sweeps it | 33-37 — **verified path is `test/fixtures/mcp/`** (F15's suggested `test/unit/fixtures/mcp/` does not exist) |

## Implementation Steps

1. Pre-flight: confirm `buildMcpToolList` unions catalogue-only names (read the function feeding `listTools` `mcp-server.ts:548`); confirm `CapabilityError` import path (`shared/control-plane-contracts`, `bridge-server.ts:38`).
2. `cockpit-capabilities.ts`: 8 canonical + 8 aliases; policies per table (`DEADLINES.toolPolicyMs` on scan, precedent `browser-capabilities.ts:1596`; `idempotent-write` on mutations — set-valued ops and caller `itemId` make replays no-ops). Registration body must not touch `cockpit` members (stub tolerance, F5).
3. Wire trailing param through `registerBrowserCapabilities` (`browser-capabilities.ts:259`) + `control-plane-runtime.ts:371`.
4. Proxy rows + `READ_SAFE_CAPABILITIES`; add stub arg at `check-mcp-budget-dominance.mjs:164`.
5. Tests in `theme-mcp-capabilities.test.ts`: all names + aliases registered; `cockpit_mark` round-trip on tmp root; `SCOPE_MISMATCH` on foreign scope param; `INVALID_ARGUMENT` on `mark_page {page:'nope'}`; `cockpit_scan` → fake host `runThemeQa` receives bound `tabId` + confined root; `ROUTE_UNRESOLVED` for `product` off-PDP; `TARGET_REQUIRED` propagation for dead bound tab.
6. Run `node scripts/check-mcp-budget-dominance.mjs` — MUST pass with the stub.
7. Sync `test/fixtures/mcp/fake-omp-mcp.cjs` rows if the parity sweep reads it (`proxy-seeded-drift.cjs` patches `definitions`, `test/fixtures/mcp/proxy-seeded-drift.cjs:6-9`).

## Success Criteria

- [ ] `check-mcp-budget-dominance.mjs` exits clean — including the new stub-arg registration.
- [ ] `theme-mcp-capabilities.test.ts` green incl. new negative cases (SCOPE_MISMATCH, INVALID_ARGUMENT page, ROUTE_UNRESOLVED, TARGET_REQUIRED).
- [ ] `cockpit_scan` on `home` → `navigateAndWait` + `runThemeQa(tabId)` observed on the bound tab (fake host assertion), never `activeTabId` of the host.
- [ ] Read trio reachable as read-safe through the proxy; writes are not.

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| Parity gate phantom failure from unstubbed port | M×H | F5 fix in this same phase; gate run is a required step, not optional |
| Scan still QA's wrong tab | M×H | P1 F1 made `runThemeQa` take `tabId` with no automation fallback; test asserts bound tabId reaches fake host |
| `requiresBrowserTarget:true` breaks headless list/report callers | L×M | Accepted per F8: all sessions calling these tools are bound attachments (`ATTACHMENT_REQUIRED` already enforced); unattached list has no workspace to read anyway |
| `page` enum rejects legit custom pages in mark_page | L×L | Rule = PAGE_DEFS keys ∪ pages already in the scope — custom pages validate when they exist in state |
| Proxy/catalogue schema drift | M×H | Structural gate; specKey compares type/enum/items only (`check-mcp-budget-dominance.mjs:55-61`) |
