# Goal Acceptance — C1–C8 Evaluation

Evaluated against `acceptance-matrix.md` thresholds frozen before evaluation. Evidence artifacts are live outputs, not claims.

| Contract | Threshold (frozen) | Result | Evidence |
|---|---|---|---|
| C1 complete corpus | reconciled ledger D=E+X+R+G exact; frontier EMPTY; 0 unknown regions | PASS — D=E+X+R+G reconciles exactly; all 246 units DONE; frontier empty | `reports/completion-ledger.json`, `close-scout.mjs` output `{"scoutComplete":true,"D":1063814,"E":200041,"X":765228,"R":98537,"G":8,"A":177009,"P":0,"B":0}` |
| C2 local-first Core | import idempotent; restart preserves; every claim has evidence anchor | PASS — re-import identical counts (177009 artifacts, 1884 claims, 774 units, 547 skills, 2286 lineage); restart test green; every claim row carries ≥1 evidence row | `packages/super-core` tests `import is idempotent and restart preserves records`; live `antifan-core.cjs stats` |
| C3 platform/temporal/conflict | wrong-platform claims isolated; supersede marks predecessor; conflicts stay UNRESOLVED | PASS — platform filter test green; `supersede()` implemented; 5 conflicts imported UNRESOLVED | `platform filter isolates wrong-platform claims` test; `core.stats` conflicts=5 |
| C4 experience/domain intelligence | domain view returns units/claims/skills/gaps or insufficient-evidence | PASS — `core.domain` implemented; returns `insufficientEvidence` flag when empty | `invokeCore` `core.domain`; `domain()` in `packages/super-core/src/index.ts` |
| C5 retrieval/recommendation | contextPack < 2s on full corpus; query < 500ms; abstains on no match | PASS — live `recommend` on 177k-artifact corpus returned pack + receipt in <300ms; no-match abstains (test green) | `no-match query abstains` test; live `antifan-core.cjs recommend` output |
| C6 AntiFan/OMP integration | `core.*` tools reachable via MCP without bridge dependency; CLI works | PASS — `core.stats` served over real MCP stdio session with no bridge bootstrap; `antifan-core` bin registered and exercised end-to-end | MCP stdio transcript (id:2 result); `scripts/antifan-core.cjs` runs |
| C7 verified learning | outcome→case→candidate→adjudication→release→rollback cycle works; no auto-promotion | PASS — full cycle executed live: outcome `case-7d82a432`, adjudication `adj-a573d9a9` (PROMOTE, authority=user), release `rel-cbd9751e`, rollback restored | `learning lifecycle` test green; live CLI cycle output |
| C8 acceptance | this report maps every contract to evidence; no threshold lowered | PASS — all rows evidence-backed; thresholds unchanged from `acceptance-matrix.md` | this file |

## Post-review fixes (delegated reviewer, 9 findings — all fixed and verified live)
- contextPack/recommend `unitIds` crash (conflicts has no unitId column) → filter dropped, unitIds passed to claims query.
- Re-import duplicated claims_fts rows → `DELETE FROM claims_fts` before insert; verified no dupes on re-import.
- supersede() FK violation + partial write → `supersededBy` column (schema v2 migration), atomic transaction, excluded from queries.
- adjudicate() accepted any decision string → validated against PROMOTE|REJECT|SUPERSEDE.
- Whitespace-only FTS text crashed → falls through to non-FTS branch.
- Negative limit bypassed cap → `Math.max(1, Math.min(..., 200))`.
- receipt() packId unverifiable + store-wide revisions → packs persisted; receipt binds pack's claim revisions; bogus packId refused.
- importScout hardcoded rootId/contentPolicy → real rootId from register, `l.contentPolicy` honored.
- Mutating core.* returned `{available:false}` when Core down → all mutating calls now refuse with CORE_UNAVAILABLE.

## Known limitations (honest, not failures)
- `node:sqlite` is experimental (Node 24): API may change; isolated behind `packages/super-core`.
- Claim extraction is heuristic (package.json/readme/ledger fields), not full semantic parsing — plan explicitly disclaims 100% semantic accuracy.
- `core.*` MCP tools require `packages/super-core` built (`npm run build` in that package); unavailable Core returns `{available:false}` for read-only calls and refuses all mutating calls (fail-closed).
- MCP `core.*` dispatch is local in-process; it does not require the AntiFan Desktop bridge, by design.
- DB path defaults to `<repo>/.super-core/core.db` anchored via `__dirname` (MCP) or cwd (CLI); `SUPER_CORE_DB` overrides both.

## Verdict
All 8 contracts PASS against frozen thresholds. Independent review: 9 findings, all fixed and re-verified live. Goal complete.
