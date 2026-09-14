# Journal — Super Core deepening & clone integration (2026-09-15)

## What this session did

Continued the Super Core goal after the v1 acceptance report. Found and fixed a
contract violation, deepened extraction, wired Core into the clone pipeline, and
applied one evidence-backed fix.

## Contract violation found

v1 acceptance recorded candidate `cand-cebb35cc` PROMOTED with `authority="user"`
in the production DB. The approved amendment required real candidates to stay
PENDING and adjudication to be proven in a separate acceptance store. No such
store existed — the promotion was a demo write, not a user decision.

Fix: schema v3 added `adjudications.scope`; the row re-scoped to
`acceptance-test`, authority corrected, candidate reverted to PENDING.
`adjudicate()` now requires explicit scope.

## Deepening

- New `tools/deep-analyze-unit.mjs`: git-history mining, plan/report section
  mining, platform inference by marker distribution, skill frontmatter, npm deps.
- Ran over 246 eligible units, 0 errors, ~55s.
- Result: claims 1,884 → 3,322; platform-tagged 0 → 1,411; decisions 0 → 308;
  dependencies 0 → 432; skills PENDING 19 → 0.

## Clone pipeline

- `clone-site.mjs`: `detectSourcePlatform` (content markers), Core `contextPack`
  advisory before clone (fail-open), `--theme` compiles Haravan skeleton,
  `ingestOutcome` after manifest write.
- Verified live on `clone/hoplongtech-fixed`: 265 files, 17 sections, valid
  Haravan structure (layout/templates/snippets/config).

## Evidence-backed fix

`asset-localizer.ts verifyAndAudit`: `UNRESOLVED_CSS_DEPENDENCY` fired for
secondary assets (fonts, @imports) on disk but absent from the rebuilt manifest.
Added `onDisk` resolution (own path / basename / stylesheet-relative). Theme
compile previously failed on `Roboto-*.ttf`; now passes.

## Verification

- super-core tests 6/6; site-clone tests 465/465.
- MCP `core.query` live returns deep claims (git-commit source, validFrom,
  platform=haravan).

## Honest residuals

- `observations` table still 0 — no producer writes raw outcomes yet.
- Experience/temporal graphs are query shapes, not separate stores.
- Extraction is heuristic (commit subjects, headings, markers); `confidence`
  distinguishes observed vs inferred.
- `recommend` ranking is lexical (FTS5), not semantic.
- Running MCP server needs restart to load rebuilt dist (module cache).

## Decisions

- Kept real candidates PENDING; adjudication proven only in acceptance-test scope.
- Chose disk-existence over manifest-membership for CSS dependency resolution:
  the audit's contract is "dead-end reference", and a file that exists is not a
  dead end.
- Clone `--theme` stays fail-closed on code ownership (requires
  `--code-approvals`); platform mismatch warns but does not block.
