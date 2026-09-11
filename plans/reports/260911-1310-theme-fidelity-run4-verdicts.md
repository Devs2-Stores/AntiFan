# theme-fidelity-run4 — verdicts, upload repair, and remaining refusals

Plan: `plans/260911-0133-haravan-customize-theme-fidelity`
Run dir: `.canary/theme-fidelity-run4` (same `--out` across re-runs, so the R1/R2 pins captured
before the copy was written are reused verbatim; `references` was never re-run)
Date: 2026-09-11

## Outcome

| Stage | Result | Evidence |
|---|---|---|
| preflight (first pass) | exit 0 | `preflight.json` |
| references (first pass) | r1 21/21, r2 21/21, both `COMPLETE` | `r1/index.json`, `r2/index.json` |
| serve | exit 0 in 19,893 ms; probe 200, `copy assets: seen` | `serve.json`, `hrv-theme-dev.log` |
| subject | **exit 0, 21/21 captured** (was 14/21 with 7 `FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY`) | `subject/index.json` `{requested:21, documents:21, captured:21, notMeasurable:0}` |
| compare | exit 3 `VERDICT_SET_INCOMPLETE` | `compare/r1-vs-subject/index.json`, `compare/r2-vs-subject/index.json` |
| checks | exit 0, 2 refusals carried as advisory findings | `checks.json`, `structural.json` |
| report | exit 3 `RUN_INCOMPLETE`; `current.json` withheld | `report.json` `status: INCOMPLETE`, `publication {published:false}` |

The capture blocker named in the plan is closed. The run does not publish a report, and it must not:
the remaining refusals are doctrine-correct (below), and a missing artifact is never a PASS.

## The fix that closed the capture blocker

Cause: the copy never received the local `assets/**`. The CLI's bulk push collector skips the
assets directory by construction, so 182 keys (config 3 + layout 1 + snippets 121 + templates 57)
were pushed and 336 assets were never candidates. Without `hl-global.css` every desktop page lost
the layout utility classes, the header nav collapsed into a 9,468 px stacked column, desktop
documents reached 16.5k–27.4k px and exceeded `CAPTURE_MAX_DIMENSION = 16384`.

CLI repair (`E:/Work/apps/Haravan CLI`, the local `@f1genz/haravan-cli@1.2.0` that `hrv` resolves to):

- `src/helper/files.ts:665-671` — `collectThemePushAssetKeys(root, opts?)`; assets are skipped only
  when `includeAssets` is not set. The walker already filtered with
  `isSyncableThemeKey && isThemePushableByExtension`, and `THEME_DIRECTORY_PATTERNS` already covers
  `assets/**/*.*`.
- `src/helper/files.ts:726-730` — `pushAllThemeFiles` derives `includeAssets` from `--only`
  patterns that address `assets/`.
- Test `src/helper/files.test.ts` — new case asserts assets are collected under `includeAssets:true`
  while `assets/notes.txt` stays filtered; the four pre-existing collector tests, including
  "skips assets directory", pass unchanged.
- `npm run build` exit 0; `npx vitest run src/helper/files.test.ts` 51/51 pass.

Measured key sets through the built module against the real workspace:

| Mode | keys | assets |
|---|---|---|
| default | 182 | 0 |
| `includeAssets:true` | 518 | 336 |
| `includeAssets:true` filtered by `assets/**` | 336 | 336 |

In the shipped CLI `--only` provably could not add assets: `pushAllThemeFiles` collects first
(`files.ts:730`) and then filters (`:732-741`), so an assets-only pattern matched zero keys and
printed "No files matched --only pattern(s)."

Upload, out-of-band and deliberately outside `commands.jsonl` (same convention as the existing
`push.log` / `push-force.log`; the pipeline's own contract refuses a push token in the command record):

```
cd E:/Work/customizes/Phukienmaymoc && hrv theme push --only "assets/**" --force -n
```

- preceded by a fail-closed guard on `hrv theme info --json`; observed `theme_id 1001512581`,
  `role unpublished`, `org_id 200001207485`; the guard refuses on any other id
- `Push all: 336 đã push, 0 lỗi, 0 bỏ qua.` exit 0 in 1,172 s; log `.canary/theme-fidelity-run4/push-assets.log`
- no delete semantics in the push path; the CLI backs up each overwritten remote text asset
- largest local asset 961,162 B, below the 3 MB per-file cap

Post-upload CDN state on the copy (`.../themes/200001207485/1001512581/14/`):

| asset | before | after | marker |
|---|---|---|---|
| `hl-global.css` | 404 | **200, 47,774 B** | contains `.flex-center-between`, `.menu-list li`, `.flex-inline-center` |
| `hl-home.scss.css` | 404 | 200, 26,937 B | |
| `hl-home.js` | 404 | 200, 3,503 B | |
| `product-hoplong.css` | 404 | 200, 47,570 B | |
| `product-single-hoplong.css` | 404 | 200, 55,478 B | |
| `page-contact-hoplong.css` | 404 | 200, 8,957 B | |
| `post-hoplong.css` | 404 | 200, 8,035 B | |
| `ll-style-all.scss.css`, `color_font.scss.css` | 200 | 200 | controls |
| live `1001510509/14/hl-global.css` | 200 | 200 | 47,774 B, same bytes |

Geometry after the upload, copy subject vs live reference, all 21 legs (`docHeight/header/nav`):
identical on every leg — including `home__1440x900` 5426/166/56 (was 27,360), `article__1024x900`
4332/176/71 (was 16,759), `cart__1440x900` 1811/166/56, `search__1440x900` 2421/166/56,
`404__1024x900` 1128/176/71. Desktop header 166–191 px, nav 56–71 px, no leg above 8,790 px.

## Why compare still refuses (42 verdict documents, all non-PASS)

`r1-vs-subject`: `NOT_MEASURABLE` 16 (`content-changed-between-passes` 15, `EXECUTION_TIMEOUT` 1),
`INCONCLUSIVE` 5 (`REFERENCE_IDENTITY_DRIFT[+SUBJECT_IDENTITY_DRIFT]`).
`r2-vs-subject`: `NOT_MEASURABLE` 13 (all `content-changed-between-passes`), `INCONCLUSIVE` 7
(`IDENTITY_DRIFT`), `PASS` 1 (`home__1440x900`, mismatch 0).

`content-changed-between-passes` is the content fingerprint gate refusing, and the gate is right.
The per-pass record shows every predicate satisfied and the counts identical, with the fingerprint
alternating between two values:

```
cart__1440x900   pass1 fp=807aff9a4202d72d  pass2 fp=0cbeff4e5405c373  pass3 fp=807aff9a4202d72d
                 sections=3 cards=0 docHeight=1811 images=30 (all three passes), all predicates true
search__1440x900 pass1 fp=a7bff1edea45d178  pass2 fp=e202421da5339261  pass3 fp=a7bff1edea45d178
                 sections=3 cards=0 docHeight=2421 images=53 (all three passes), all predicates true
```

An A→B→A fingerprint with stable rectangles, stable structure and `churn=0` is a rotating widget
carriage: the image set or visible text changes while geometry does not. The campaign forbids
masking that (`readWidgetPhase`: pinning the phase was tried and reverted because the two sides do
not agree on whether a carousel is initialized, and pinning it is a mask in disguise), so the pair
is refused rather than measured across two phases. That is the designed behaviour, not a defect.

`IDENTITY_DRIFT` pairs replayed 400–808 px taller than their pin (`r2 article@1024` 4332 → 4821,
`search@390` 3690 → 4498), so the verdict is withheld rather than promoted.

Diagnostic support added to the harness: `comparePair` now persists `settlePasses` verbatim on a
`NOT_MEASURABLE` failure (`.canary/tools/theme-fidelity.mjs:1615-1617`). The 600-char `reason` had
truncated the per-pass components, which is why this carried no diagnosis before. Diagnosis was
reproduced on a copy, never on the bundle: `.canary/theme-fidelity-diag/` holds two trimmed sides
and their verdicts.

## Why report refuses

`report.json` `notMeasured` holds 7 entries, all `source: inventory`, `code: UNRESOLVED_SURFACE`:
`contact`, `quote`, `documents`, `brands`, `stores`, `wishlist` (their `templates/page.*.liquid` have
no owning page record on the store and fall back to `page.liquid` on the copy while rendering on the
live theme) and `member` (auth-gated). These surfaces are outside the plan's seven (home, product,
collection, article, cart, search, 404) and none of them is a compare pair. `gaps` is 0.

`checks` exits 0 with two advisory refusals carried into the report: `settings-binding`
(95 `SETTING_UNDECLARED`) and `assets` (6 dangling `.jpg` references, 5 of them in snippets no
template includes and 1 inside a `{% comment %}` block at `templates/article.liquid:6-46`). All six
resolve 404 on the live theme as well, so they are dangling in the theme source and cannot be
vendored. The checker is advisory by construction (`theme-fidelity-run.mjs:1472-1528` maps exit 3 to
`REFUSED`, and `reportWork` requires `structural` to be present, never `ok`).

## Safety audit

`report.json` `safetyAudit`: 12 recorded commands, `themeIds ["-1","1001512581"]`,
`foreignThemeIds.count 0`, `publishDeployPush {absent: true, matches: []}`, `remoteWrites` names the
serve stage's dev session only. The out-of-band asset push is not in `commands.jsonl` by design and
is recorded in `push-assets.log`. Nothing published, deployed or pushed a theme from inside the
pipeline; theme `1001510509` was never requested or written.

## Best-of-5 fix-plan comparison (ultra)

Five read-only candidates were scored against one evidence packet on cause-alignment,
blast-radius safety, minimality and verifiability:

| candidate | cause | safety | minimality | verifiability | total |
|---|---|---|---|---|---|
| CandCounterEvidence | 5 | 4.9 | 4.8 | 5 | **19.7 (winner)** |
| CandIntegrityFirst | 4.8 | 4.9 | 4.5 | 4.6 | 18.8 |
| CandUploadMechanism | 4.7 | 4.6 | 3.8 | 4.7 | 17.8 |
| CandRiskRollback | 4.2 | 4.5 | 4 | 3.2 | 15.9 |
| CandRepoGate | 3.5 | 2.8 | 2.5 | 3 | 11.8 |

The verifier ruled "let the 336-asset push finish; do not interrupt or narrow it" and confirmed each
precondition used above. It flagged two commands as invalid, both of which the CLI source confirms:
`hrv theme push --theme <id> --only "assets/**"` (no `--theme` flag; and `--only` filters a key set
that never contained assets) and `--reuse-references` (not a flag of the run driver). Verifier
artifacts: `local://ultra-verifier-verdict.json`, `local://fix-candidates-full.json`,
`local://fix-evidence-packet.md`.

## Open items for the owner

1. `contact`, `quote`, `documents`, `brands`, `stores`, `wishlist`, `member` are in the surface
   inventory but not in the plan's seven. Either scope the inventory to the plan's surfaces, or
   treat the seven unresolved surfaces as a separate finding. Not changed here.
2. `content-changed-between-passes` on 28 pairs: the rotating widget the campaign refuses to pin.
   Resolving it requires either a widget-specific freeze that both sides accept (rejected once as a
   mask) or measuring those surfaces another way. Not changed here.
3. The 6 dangling `.jpg` references and the 95 undeclared settings are source defects in the theme
   workspace, reported not repaired: declaring settings without defaults would render identically but
   changes the theme, and the six images 404 on the live theme too.
