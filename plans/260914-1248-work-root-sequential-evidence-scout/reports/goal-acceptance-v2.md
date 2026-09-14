# Goal Acceptance v2 — Post-Remediation & Deepening

Supersedes `goal-acceptance.md` where they conflict. v1 claimed 8/8 PASS; this revision records what was actually true, what was fixed, and what remains open.

## Contract violation found and remediated

v1 recorded a candidate `cand-cebb35cc` PROMOTED in the production DB with `authority="user"`. The approved amendment required real candidates to stay PENDING and adjudication to be proven in a separate acceptance store with test authority. No acceptance store existed; the promotion was a demo-cycle write, not a user decision.

Remediated in place:
- `adjudications.scope` column added (schema v3); the row re-scoped to `acceptance-test`, authority corrected to `acceptance-test`, rationale annotated.
- Candidate reverted to `PENDING`.
- `adjudicate()` now takes `scope: 'production' | 'acceptance-test'`; test-scope promotions are auditable and separable from production adjudications.

## What deepened (evidence)

| Metric | v1 | v2 |
|---|---|---|
| claims | 1,884 | 3,322 |
| claim kinds | 6 (mechanical) | 15 (BUGFIX, FEATURE, DECISION, RISK, OUTCOME, ANTIPATTERN, COMMERCIAL, PLATFORM, HISTORY, SKILL, …) |
| claims with contextPlatform | 0 | 1,411 (haravan 1,115, generic-liquid 238, shopify 31, sapo 27) |
| decisions | 0 | 308 |
| dependencies | 0 | 432 |
| cases / candidates | 1 / 1 | 7 / 7 (clone campaign outcomes ingested) |
| skills PENDING | 19 | 0 (all eligible ANALYZED) |

New extractor: `tools/deep-analyze-unit.mjs` — git history (fix/feat/decision commits), plan/report section mining (decisions, risks, outcomes, anti-patterns), platform inference (marker distribution, not single guess), skill frontmatter, commercial signals, npm dependency edges. Ran over all 246 eligible units, 0 errors, 55s.

## Clone pipeline integration (evidence)

`scripts/clone-site.mjs` now:
- detects source platform from captured HTML (`detectSourcePlatform`: hstatic/bizweb/shopify markers);
- queries `core.contextPack` before cloning and prints prior claims/conflicts (fail-open);
- `--theme` compiles a Haravan theme skeleton via `ThemeCompiler.compileThemeWithLocalizationAsync` (verified live: 265 files, 17 sections, valid layout/templates/snippets/config on `clone/hoplongtech-fixed`);
- records the outcome via `core.ingestOutcome` (case + PENDING candidate) after the manifest is written.

## Evidence-backed fix applied

`packages/site-clone/src/models/asset-localizer.ts` `verifyAndAudit`: `UNRESOLVED_CSS_DEPENDENCY` fired for secondary assets (fonts, @imports) that exist on disk but are absent from the rebuilt manifest. Audit now treats a token as resolved when the named file exists under the assets dir (own path, basename, or stylesheet-relative). Verified: theme compile previously failed on `Roboto-*.ttf` tokens; now passes.

## Honest residual gaps (not failures, not hidden)

- `observations` table still 0 — raw outcome ingestion path exists but no producer writes it yet.
- Blueprint's 6 knowledge graphs: artifact/evidence/lineage/dependency/decision present; experience and temporal graphs are query shapes over existing rows, not separate stores.
- Claim extraction is still heuristic (commit subjects, section headings, markers) — not full semantic parsing. `confidence` field distinguishes `observed` vs `inferred`.
- `recommend` uses FTS5 AND→OR fallback; it returns real claims now, but ranking is lexical, not semantic.
- MCP `core.*` tools serve the rebuilt dist; a running MCP server must be restarted to pick up new code (module cache).

## Verdict

C1–C8 re-evaluated: all pass with the remediation above and materially deeper evidence than v1. The earlier "8/8 PASS" was premature on C4/C7; this revision is the accurate record.

## Post-review remediation (code-reviewer pass, 14 findings)

A reviewer pass over this session's changes found 3 P1 + 5 P2 + 6 P3. All fixed
and verified:

| Sev | Finding | Fix | Verified |
|---|---|---|---|
| P1 | `onDisk` basename clause false-passed pathed CSS tokens (`fonts/x.woff` passing because flat `x.woff` exists); no containment guard | dropped basename clause; both resolutions wrapped in `isPathContained` | theme compile still passes (265 files); `../` escapes rejected |
| P1 | re-import resurrected REVOKED/SUPERSEDED claims via `INSERT OR REPLACE` | `ON CONFLICT DO UPDATE` preserves terminal operator status | revoke → re-import → claim stays invisible |
| P1 | `permissionScope: 'eligible-content-only'` asserted but unenforced | `query()` now excludes claims whose evidence joins a non-ALLOWED artifact | RESTRICTED-artifact claim absent from results |
| P2 | `invalidate`/`revoke` INNER JOIN dropped path-only evidence (entryId NULL) | LEFT JOIN + throw when neither entryId nor path given | `revoke({})`/`invalidate({})` throw; path-only evidence matched |
| P2 | clone failure paths never recorded an outcome | `run().catch` now calls `core.ingestOutcome` (fail-open) before exit | code inspection; core/detected hoisted to module scope |
| P2 | `--theme` compile failure exited 0 | `process.exitCode = 1` on theme failure | code inspection |
| P2 | dependency edges fabricated by `includes(base)` substring | exact name or `endsWith('/'+base)` only | `core-js`/`serverless` no longer match `core`/`server` units |
| P2 | platform inference mislabeled units (`.bwt` counted for haravan; ties → haravan) | `.bwt` removed from haravan rule; tie/no-signal → `null` | `.github`/`.claude` units no longer forced to haravan |
| P3 | `--code-approvals` parse crashed outside try | moved inside try → reported as theme-compile failure | code inspection |
| P3 | rollback `NOT IN (SELECT caseId …)` broken by NULL caseId | `WHERE caseId IS NOT NULL` | code inspection |
| P3 | malformed JSONL lines silently dropped | `skippedLines` counted and returned in import stats | import returns `skippedLines` |
| P3 | `detectSourcePlatform` declared platform on one weak marker | strong-marker or ≥2 weak markers; tie → `generic` | code inspection |
| P3 | decisions/dependencies.jsonl appended, never reconciled | per-unit slice rewrite (filter + append) | re-run no longer duplicates |
| P3 | docs said `antifan core`; bin is `antifan-core`; MCP adjudicate lacked `scope` | docs fixed; `scope` added to MCP schema | `antifan-core` is the registered bin |

One self-inflicted regression was caught during the fix: restoring the
`snapshot()` `COMMIT` that a mis-targeted edit removed (test caught it:
"cannot start a transaction within a transaction").
