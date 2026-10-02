---
phase: 4
title: "End-to-end verification (hardened invariants)"
status: pending
priority: P1
effort: 1.5h
dependencies: [phase-01, phase-02, phase-03]
---

# Phase 4: End-to-end verification (hardened invariants)

## Overview

Prove acceptance criteria against a running build **plus every invariant the red-team findings introduced**: bound≠active scan correctness, no lost updates, stale-LOAD bail, union-merge migration, XSS-safe render, provisional unknown-workspace, fail-closed scan targets, and the parity gate with its new stub.

## Requirements

- [ ] Live E2E: `theme.cockpit_mark` flips a visible checkbox in the open cockpit modal.
- [ ] Live E2E [F1/F2]: `theme.cockpit_scan` targets the **bound** tab while a different tab is active — that tab navigates + QA runs; cockpit findings update via `THEME_QA_STATE {tabId,state}`; active tab untouched.
- [ ] Fail-closed scans [F1]: `cockpit_scan` on a closed/bogus bound `tabId` → `TARGET_REQUIRED`; `page:'product'` on non-PDP URL → `ROUTE_UNRESOLVED`, no navigation.
- [ ] Concurrency [F6]: while toolbar has unsaved in-memory state, `cockpit_mark` + toolbar SAVE interleave — CAS conflict path observed (conflict flag → toolbar adopts store state, no lost item).
- [ ] Stale LOAD bail [F9]: trigger scope switch while a LOAD is in flight → stale response dropped, foreign items never rendered/saved.
- [ ] Migration [F10]: agent writes items to a scope BEFORE cockpit ever opens; then legacy localStorage data for the same scope → union survives, `legacyMigrated` set, agent rows intact; boot sweep migrates an unopened scope.
- [ ] XSS [F3]: `cockpit_add_item` with markup in `name`/`desc`/`qaPoint`/`note` renders as text; no `onerror` fires.
- [ ] Provisional [F14]: mark items under `unknown-workspace` scope → state works in-session; NO `qa-checklist.json` created anywhere; `isProvisional` present in list/report.
- [ ] Auth [F8]: unattached MCP session → `ATTACHMENT_REQUIRED` (already enforced `mcp-server.ts:692-696` — regression-check only); `scope` param mismatch → `SCOPE_MISMATCH`.
- [ ] Validation caps [F13]: `add_item` with 2KB field → truncated/INVALID_ARGUMENT; `mark_page` unknown page → `INVALID_ARGUMENT`; 201st item → rejected.
- [ ] Reload survival + toolbar-absent mutation + UX parity (badge `0/44`, report markdown byte-shape) as originally specified.
- [ ] Gates green: `check-mcp-budget-dominance.mjs` (with recording stub), `test/main` touched files, `theme-mcp-capabilities.test.ts`, `chrome-ipc-routes.test.ts`.

## Architecture

```text
Layer 1 automated: unit tests (store CAS/provisional/caps/sweep), capability dispatch tests,
                   route auth (dispatchChromeRoute), parity gate, chrome-ipc-routes audit.
Layer 2 live:      launch app → pair omp MCP → cockpit open → exercise tools
                   → screenshot pairs as evidence (anti.screenshot.viewport) or QA_UNAVAILABLE
                   if bridge is down — never DOM-read substitutes for visual claims.
```

## Related Code Files

| File | Role | Anchors |
|---|---|---|
| Live app + `scripts/antifan-omp-mcp.cjs` | external agent surface | `definitions` 31+, dispatch 2693 |
| `test/main/theme-checklist-store.test.ts` | store unit proof (P1) | incl. interleaved-mutation test (F6) |
| `test/main/theme-mcp-capabilities.test.ts` | capability dispatch proof (P2) | 44-99 pattern |
| `test/main/chrome-ipc-routes.test.ts` | channel audit | push set 243-263 |
| `scripts/check-mcp-budget-dominance.mjs` | parity gate + stub | 157-173 |
| `test/fixtures/mcp/fake-omp-mcp.cjs` | fixture parity | 33-37 |

## Implementation Steps

1. Automated pass: new/touched `test/main` files, `node scripts/check-mcp-budget-dominance.mjs`, renderer harness assertions from P3 (gen guard, escaping, migration union).
2. Launch app; bind storefront tab B; keep another tab A active; open cockpit.
3. Tool exercise: `list` (scope==cockpit's reported scope, `isProvisional` absent for resolved ws) → `mark hom-01 done + note` (checkbox flips — screenshot pair) → `mark_page home` (`{toggled}` count honest) → `add_item`/`remove_item` round-trip → `report` diff vs 📋 Báo Cáo clipboard.
4. **Bound≠active scan** [F1/F2]: `cockpit_scan {page:'home'}` with A active — assert B navigated (tab strip URL), QA badge progress via `THEME_QA_STATE`, findings populated; A never navigated.
5. **Concurrency probe** [F6]: via MCP, `cockpit_mark` while renderer checkbox toggles — assert either CAS conflict adopted or serialized result; final store = union of intents.
6. **Stale LOAD** [F9]: switch tabs during identify timeout window (`WORKSPACE_IDENTIFY_TIMEOUT_MS` 1500ms, `toolbar.ts:542`) — foreign items never render.
7. **Migration** [F10]: pre-create agent rows via MCP on a fresh scope → seed legacy localStorage → reload → union present, `legacyMigrated` persisted; confirm scope not opened still migrated by boot sweep.
8. **XSS** [F3]: markup payloads via `add_item`; confirm inert text.
9. **Provisional** [F14]: detach workspace resolution → `unknown-workspace` scope → ticks live for session → assert no file written; restart → provisional state gone (expected, documented).
10. **Auth/caps** [F8/F13]: `SCOPE_MISMATCH`, `INVALID_ARGUMENT`, caps rejection, unattached `ATTACHMENT_REQUIRED`.
11. Reload survival: marks persist across restart for resolved-workspace scopes; UX regression sweep (pills, search, reset → 44 defaults, clipboard report).
12. Update `plan.md` status → `completed` only when every box in plan §Success Criteria carries evidence.

## Success Criteria

- [ ] Each plan.md §Success Criteria row has an attached artifact: screenshot pair (mark), bound-tab navigation + findings observation (scan), file diff (migration/persistence), transcript (report parity), error codes (TARGET_REQUIRED/ROUTE_UNRESOLVED/SCOPE_MISMATCH/INVALID_ARGUMENT/ATTACHMENT_REQUIRED).
- [ ] `check-mcp-budget-dominance.mjs` passes locally with the stub registration.
- [ ] Toolbar devtools console clean through the exercise (no listener accumulation across modal open/close).
- [ ] QA-bridge-down → claims recorded `QA_UNAVAILABLE`, never pass-by-inspection.

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| No real storefront for live scan | M×M | `unknown-workspace` exercises mark/list/report/findings-gate; scan needs any real storefront page — note coverage if only partial |
| Legacy localStorage can't be seeded pre-launch | M×L | Run once on the OLD build to create real keys (step 7), else document skip |
| Timing races hard to force (F6/F9) | M×M | Unit tests at P1/P3 carry the invariant proof; live step is a best-effort confirmation — say so |
| Visual proof blocked by bridge health | M×H | QA_UNAVAILABLE protocol; do not substitute inspection |
