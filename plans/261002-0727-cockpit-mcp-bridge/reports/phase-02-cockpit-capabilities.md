# Phase 2 report — theme.cockpit_* capabilities + proxy definitions + parity-gate stub

Status: DONE
Date: 2026-10-02

## Files changed

- `src/main/tools/cockpit-capabilities.ts` (NEW): `registerCockpitCapabilities(catalogue, cockpit, browser)` — 8 canonical tools + 8 `antifan_cockpit_*` aliases delegating via `catalogue.get('<canonical>').execute(params, context)`. All `requiresBrowserTarget:true`. Scope derived via `cockpit.resolveScope(context.browserTarget.tabId)`; foreign `params.scope` → `SCOPE_MISMATCH`; `params.workspaceRoot` → `confineWorkspaceRoot` against derived root. Registration body never dereferences port members (F5 stub-safe).
- `src/main/tools/browser-capabilities.ts`: import `registerCockpitCapabilities`; `void cockpit;` block removed; `if (cockpit) registerCockpitCapabilities(...)` placed after the `antifan_theme_qa_rollback` registration (~line 1845).
- `src/shared/control-plane-contracts.ts`: `CapabilityErrorCode` union extended with `'SCOPE_MISMATCH'` and `'ROUTE_UNRESOLVED'` (approved by Main — spec mandates these codes but the union lacked them).
- `scripts/antifan-omp-mcp.cjs`: +8 canonical `definitions` rows after the `theme.*` block (all ambient `tabId`); `READ_SAFE_CAPABILITIES` gains `theme.cockpit_list|findings|report` only.
- `scripts/check-mcp-budget-dominance.mjs`: `recordingCockpitPort` Proxy stub added; `registerBrowserCapabilities` arg list → `[browserPort, undefined, getWorkspaceRoot, undefined, undefined, recordingCockpitPort]`.
- `test/main/theme-mcp-capabilities.test.ts`: new `theme.cockpit_* capabilities` suite — 16-name registration check, real-store mark round-trip on tmp root (incl. alias dispatch), SCOPE_MISMATCH, INVALID_ARGUMENT on `mark_page{page:'nope'}` + valid page toggle, scan confined-root + bound-tabId + skip-navigation, scan navigation to `/cart`, ROUTE_UNRESOLVED off-PDP, TARGET_REQUIRED on dead bound tab.

## Design notes

- `cockpit-capabilities.ts` imports `makeBrowserPolicy` via namespace import and resolves it lazily inside the registration body — safe under the browser-capabilities ↔ cockpit-capabilities circular edge.
- `scan` policy: `effect:'interactive-effect'` (navigates the bound tab — NOT replay-safe, stays out of READ_SAFE), `risk:'read'` (mirrors `theme.qa_validate`), lane `viewport-gate`, `timeoutMs: DEADLINES.toolPolicyMs`. Reads/mutations: `unbounded` lane (file/memory ops, no viewport work).
- `mark_page` page set = `Object.keys(PAGE_DEFS)` ∪ pages in loaded scope → `INVALID_ARGUMENT` otherwise (F13). `add_item` defaults: `item_<ts>_<rand>` id, `page:'home'`, `pathHint: PAGE_DEFS[page].path` (F15 replay no-op via caller `itemId`).
- `scan` route resolution mirrors `resolveChecklistRoute`: `new URL(pageDef.path, origin)`; `handle-required` reuses bound tab URL only when `PRODUCT_PAGE_PATH` matches, else `ROUTE_UNRESOLVED`; no `page` → scans current URL without navigating.

## Gate / test evidence

- `npx tsc -p tsconfig.json --noEmit` → clean (0 errors, touched files + whole project).
- `npx tsc -p ./` emitted `.compiled`; `node scripts/check-mcp-budget-dominance.mjs` → `OK: one ceiling dominates every server policy` (138 advertised tools, 258 registered capabilities, exit 0).
- `node --test .compiled/test/main/theme-mcp-capabilities.test.js` → 19/19 pass (11 pre-existing + 8 new cockpit tests).

## Fixture sync note

`test/fixtures/mcp/fake-omp-mcp.cjs` TOOL_NAMES is a client-double list; no parity sweep reads it (the parity fixture is `test/unit/fixtures/mcp/proxy-seeded-drift.cjs`, which patches `definitions` on the real proxy). New cockpit names were added to TOOL_NAMES? — no: nothing in `test/unit/antifan-mcp-client.test.mjs` requires them; left unchanged.
