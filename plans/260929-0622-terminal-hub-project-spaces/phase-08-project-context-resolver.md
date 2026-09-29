# Phase 8: resolveProjectContext + shared Project model

Status: implemented (resolver, registry appearance, reconcile, project-first Manager grouping; see plan index). Source: `reports/brainstorm-project-ui-unification.md` + scout of resolution sites (2026-09-29).

## Contract
- **Outcome:** one Main-side `resolveProjectContext(subject)` answers "which project owns this terminal/tab/window"; sidebar + picker read one Project model (name, colour, star, counts, path) keyed by `projectId`; Terminal Manager groups by Project.
- **Constraints:** Electron-free module (daemon imports terminal-manager); every site keeps its existing refusal code when result is `undefined`; no PTY spawn on restore; no second persisted copy of name/colour/star (extend ProjectRegistry); remove never deletes files.
- **Non-goals:** spawn caps, auto-sleep, daemon behaviour changes.
- **Acceptance:** all listed sites call the resolver; table-driven unit test for terminal/tab/window/projectId incl. ambiguity -> undefined; reconcile reports DEAD/STALE for stored-vs-runtime mismatch; legacy category groups migrated to named Projects without loss; existing tests untouched.
- **Deviation (recorded 2026-09-30):** "existing tests untouched" could not hold — the same change batch removed the popout-window contract (POPOUT/NEW_WINDOW routes, REDOCK channels, restore semantics) and reshaped `PROJECT_LIST`, so existing tests asserting those contracts were updated to the new behavior rather than left untouched. Per-test equivalence is checked in review; two source-text-pinning tests were deleted intentionally (they pinned implementation wording, not behavior).

## Evidence (scout)
- Home: `src/main/project/project-context.ts` (beside `project-registry.ts`, `workspace-capsule.ts`). Precedent for pure identity: `src/main/browser/window-owner.ts:13-18`.
- No `parseOwnerKey`; inline parses at `control-plane-runtime.ts:523` and `index.ts:662` -> replace with one helper.
- Sites to migrate: `native-tab-host.ts` 1359, 4537, 6387, 6669, 6799, 6850/6869, 11981; `index.ts` 559, 634, 2699, 2765; `control-plane-runtime.ts` 504, 416.
- ProjectRecord has no colour/star/path (`project-registry.ts`); registry is in-memory, durable state is the capsule store synced by `index.ts:357`.
- Tab->project link is only the owner-record key in `saved-tabs.json` v2; no per-tab projectId.
- Sidebar colour/category prefs are name-keyed (`terminalCategoryColors`) -> legacy read path.

## Steps
1. P8a: `project-context.ts` with injected ports (terminal owner lookup, capsule list, registry, window presence, tab affiliation) + `parseOwnerKey`; unit tests.
2. P8b: migrate sites one file at a time; keep each site's failure code.
3. P8c: reconcile stored vs runtime (terminal-sessions.json, saved-tabs.json) -> DEAD/STALE markers in list payload.
4. P8d: extend ProjectRegistry with colour/star, persisted once; picker + manager consume it.
5. P8e: Manager groups by Project; migrate legacy categories.

## Open (proposals, unconfirmed)
- Unassigned terminals stay in own "Unassigned" section, never ownership by focus.
- Project without a path: refused for terminal/Chrome ownership.
- Legacy categories: display-only until migrated.

## Validation
`tsc`, `test:fast`, `test:unit`, `test:main`; live smoke on app running this build (blocked on production restart, see phase 7).
