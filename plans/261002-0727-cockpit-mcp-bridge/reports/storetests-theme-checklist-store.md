# StoreTests — theme-checklist-store.test.ts

**Status: DONE** — `test/main/theme-checklist-store.test.ts` created (store + shared module untouched, as required).

## Result
- 17 tests / 9 suites, all pass: `node --test .compiled/test/main/theme-checklist-store.test.js` → `pass 17, fail 0` (test file transpiled into `.compiled` via `ts.transpileModule`; existing compiled store tree used — no `npm run compile` run).
- `npx tsc -p tsconfig.json --noEmit` → 0 errors project-wide (file is tsc-clean; no pre-existing errors found to report).

## Coverage map (phase-01 criteria)
1. **Round-trip**: `getScope` on empty root → 44 items, `existed:false`, `updatedAt:0`, no file created; `mutateScope(mark, note)` persists → `readChecklistFile` `existed:true`; untouched rows keep defaults; seeded snapshot mutations don't leak across reads.
2. **CAS conflict**: seeded `updatedAt=T0` (fixed past value → deterministic); `setScopeCas(stale=T0-112)` → `conflict:true`, items = live record, file bytes unchanged; correct-base save lands (`migrated:true`), replayed base conflicts, no-base save always lands.
3. **Interleaved F6**: toolbar view at T0 → agent `mutateScope(mark hom-01)` → stale whole-array save → `conflict:true` with fresh items (agent mark preserved, stale hom-02 tick not written) → re-based save lands both updates. No lost update.
4. **Validation caps**: fields truncated to 1024 chars; `done` coerced (`1`/`'yes'` → false); unknown keys stripped; bad page keys (`INVALID PAGE!!`, 33 chars, `under_score`) → INVALID_ARGUMENT; empty page → 'home'; 201-item array + duplicate ids + non-array → INVALID_ARGUMENT; 201st `add` via mutateScope throws without writing (updatedAt unchanged).
5. **Provisional**: `isProvisionalChecklistScope` true for `x@unknown-workspace` and empty/whitespace roots, false for resolved scopes; predicate is pure (no fs side effects). Documented the real seam: the store module itself does NOT gate provisional scopes — calling it with a provisional scope persists (per module docstring, gating is the owning host's job). Test pins this boundary.
6. **Corrupt file**: `not json {`, `[]`, `42` → `existed:false` + empty data + `getScope` defaults; valid container with malformed rows → `existed:true`, bad scope keys (empty/over-long) dropped, malformed items dropped, `updatedAt` non-numeric → 0, bad page → 'pages'.
7. **sweepTmpFiles**: removes `qa-checklist.json.tmp-*` debris, keeps the real file/`.bak`/unrelated tmp files, idempotent, safe on missing dir; `readChecklistFile` sweeps on first read.
8. **Deep-copy**: `defaultChecklistItems()` fresh objects — mutating returned items/array never touches `DEFAULT_THEME_CHECKLIST` (length, fields, next call unaffected).

## Notes
- Determinism: all CAS/no-write proofs use fixed past `updatedAt` seeds, never `Date.now()` comparisons — no millisecond-collision flakiness.
- Each test uses a fresh `mkdtempSync` root (sweepTmpFiles sweeps each dir only once per process); all roots cleaned in `after()`.
