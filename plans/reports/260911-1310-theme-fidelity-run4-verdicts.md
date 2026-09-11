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

The raw per-pass sample names the volatile component. Only `textHash` and `textLength` move;
`sectionCount`, `productCardCount`, `docHeight`, `scrollWidth`, `imageCount`, `pendingImages`,
`brokenImages`, `imageSetHash` and `imageSetSize` are identical. For `cart__1440x900`: pass1
`textHash 955db9da / textLength 1978`, pass2 `textHash 1643a1e2 / textLength 1889`, pass3
`textHash 0fe33812 / textLength 1978`. Visible text swaps in place — an 89-character block appears
and disappears — with no layout or image change, which is why every predicate is true and `churn` is
0 while the fingerprint never repeats consecutively. Page scripts do execute in the replay, so this
is page-side, not a replay artefact. The campaign forbids masking that (`readWidgetPhase`: pinning
the phase was tried and reverted because the two sides do not agree on whether a carousel is
initialized, and pinning it is a mask in disguise), so the pair is refused rather than measured
across two phases. That is the designed behaviour, not a defect. The diagnostic run surfaced one
further mechanism: `SESSION_RENEWAL_FAILED` on `search__1440x900`, an instance-plane failure rather
than a page-state one.

`IDENTITY_DRIFT` pairs replayed 400–808 px taller than their pin (`r2 article@1024` 4332 → 4821,
`search@390` 3690 → 4498), so the verdict is withheld rather than promoted.

Diagnostic support added to the harness: `comparePair` now persists `settlePasses` verbatim on a
`NOT_MEASURABLE` failure (`.canary/tools/theme-fidelity.mjs:1615-1617`). The 600-char `reason` had
truncated the per-pass components, which is why this carried no diagnosis before. Diagnosis was
reproduced on a copy, never on the bundle: `.canary/theme-fidelity-diag/` holds two trimmed sides
and their verdicts.

## Why report refuses

The publication predicate (`theme-fidelity-run.mjs:1933-1944`) requires both compare set indexes
`COMPLETE` with `missing === 0`, all three capture indexes `COMPLETE`, `checks` not `FAILED`,
`structural` present, and no checks-side gaps. Capture is `COMPLETE`, so the compare measurability
class is the single gate on publication.

`report.json` also records 7 `notMeasured` entries, all `source: inventory`, `code: UNRESOLVED_SURFACE`
(`contact`, `quote`, `documents`, `brands`, `stores`, `wishlist`, `member`). They are informational:
they do not enter the `complete` predicate, `gaps` is 0, and none of them is a compare pair. The
inventory is not to be pruned to change the outcome.

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
pipeline. The live theme `1001510509` was **read** — `themeid=-1` resolves to it and is the live
reference capture, its `livePreviewReads` are recorded in the same audit block, and the CDN probes
above fetched its `hl-global.css` — and it was **never written**: no command in the run addressed it
for a write.

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

## Handover — fixes, measurements, and what still gates publication

Read together with `plans/260911-0652-antifan-b-lite-v2-subagent-workflow/phase-01-gate-p0-hash-key-integrity.md`;
that plan declares itself the blocker of this one and states that this campaign's verdicts may only
be published after its Phase 1 closes. The campaign is stopped here, at a clean boundary.

### Landed and measured (all pushed)

| Fix | Anchor | Measured effect |
|---|---|---|
| Scroll anchored to a fixed offset before the settle read block | `.canary/tools/canary-settle.mjs` `SETTLE_SCROLL_ANCHOR_EXPR` | diag `search__1440x900`: `NOT_MEASURABLE` to `PASS/MATCH` |
| Session rotation ends the superseded session (read before the mint rewrites the file, released after the mint) | `.canary/tools/theme-fidelity.mjs` `renewSession`, `readSupersededSession` | improved, **not sufficient**: a 2-pair diag is clean (exit 0, both legs measured, secret never recorded), but a 4-pair run already refuses pairs 3 and 4, and the post-anchor full run lost 6 of its 21 legs to `SESSION_RENEWAL_FAILED` — each one a `read ECONNRESET` on the renewal mint before any measurement. The remaining work is a retry/isolate strategy for that reset |
| lazysizes contract applied in hydration (`data-src`/`data-srcset`/`data-sizes` to `src`/`srcset`/`sizes`, loader class dropped) | `.canary/tools/theme-fidelity.mjs` `IMAGE_HYDRATION_EXPR` | 4-pair fast fixture: `product__1440x900` `content-changed-between-passes` to `PASS/MATCH`; `article__1024x900` `docHeight` 6217/6736/7511 became constant 4821 and `scrollWidth` 1009/1419 constant 1024 |
| Image identity and document geometry are part of the settle condition, with `imagePanel`/`imageChanges` recorded as evidence | `.canary/tools/canary-settle.mjs` `SETTLE_IMAGES_EXPR` | a page whose images are complete but still swapping can no longer report settled; nothing was dropped from the fingerprint and `decideSettle` is unchanged |

Persisted compare evidence in `.canary/theme-fidelity-run4/compare/`: `r1-vs-subject/index.json` (21 pairs:
0 pass, 21 inconclusive, 16 notMeasurable) and `r2-vs-subject/index.json` (21 pairs: 1 pass, 20 inconclusive,
13 notMeasurable); 126/126 sha256 verified across r1/r2/subject. Two later in-session runs exercised the
settle and session fixes and an aborted run overwrote their artifacts, so those intermediate verdicts are not
retained — the fixes rest on the diag and the 4-pair fixture above, and the campaign is re-run once
`260911-0652` Phase 1 lands.

### Route fidelity, measured, before asserting anything

All 21 legs were served their own requested route and their own requested theme: `/cart?themeid=1001512581`,
`/products/ong-han-laser?themeid=-1`, `/khong-ton-tai-404-probe-xyz?themeid=…` and the rest, per side
(`targets[].dom.observedUrl` in each side's `index.json`). No `?openLogin=1`-style substitution occurs in
this campaign. The property held because upstream held it, not because the harness asserted it, so the
`260911-0652` Phase 1 assertion belongs in this harness as well as in `fifteen-pages-run.mjs`.

### Still blocking publication (typed)

The post-anchor full run (`startedAt 06:01:05Z`, `finishedAt 06:23:42Z`, `run.mintedAt 05:59:27Z`) is the
measurement this section rests on; its verdict files were later overwritten by an aborted run, so the
decomposition is recorded here rather than on disk: `totals {pass 0, fail 0, inconclusive 21, notMeasurable 14}`
= **8 `content-changed-between-passes` + 6 `SESSION_RENEWAL_FAILED`** (404@390, collection@1024, product@1024,
product@390, search@1440, search@390), the other 7 legs on `REFERENCE_IDENTITY_DRIFT`(±`SUBJECT_IDENTITY_DRIFT`).
A settle-only fix cannot reach exit 0: the renewal class alone keeps both sets `INCOMPLETE`.

1. **Session renewal — transport, not pool.** A 4-pair run refuses pairs 3 and 4, the fast fixture failed 2 of
   its 4 legs (`cart__1440x900`, `home__1440x900`), and the same class was already 11 of 42 legs *before* the
   release existed. The class is **not eliminated**. The failure is a `read ECONNRESET` inside
   `canary-session.mjs`'s own pairing/lifecycle calls, not a `POLICY_DENIED` quota refusal: the port's limit is
   **per bound session** (`src/main/tools/browser-control-port.ts:2071-2079`, `getManagedTabIds(boundTabId).size
   >= 10`), so a superseded session holding bindings cannot block a *fresh* session's mint — the earlier "the
   pool exhausts" reading is not supported by the source. Type it as an unproven bridge/transport defect
   correlated with session teardown; do not build a pool fix against it. Judge the release by its own record,
   never by a later mint succeeding: `doc.sessionRelease.released === true` is the only evidence it took effect
   (`readSupersededSession` does forward `secret`, the field the bridge names as required, and diag pair 2
   recorded `released: true`). Two levers were tried in order. **The reorder alone did not clear the class** — the
   failure moved legs: before it `cart__1440x900` and `home__1440x900` refused while `article__1024x900` measured;
   after it `cart__1440x900` measured with `released: true` while `article__1024x900` refused. **The bounded
   transport-only mint retry does clear it at fixture scale.** `renewSession` now re-runs the mint up to 3 times
   with a 3 s gap — the interval the ordering probe measured as sufficient for a teardown to settle — re-running
   the mint and never a measurement, recording every attempt as `sessionRenewal` and keeping the typed refusal
   unchanged when all attempts fail. Measured on the 4-pair fixture: **0 of 4 legs refused
   `SESSION_RENEWAL_FAILED`, with `released: true` on all four, against 2 of 4 in every earlier fixture run and
   6 of 21 in the post-anchor full run. Two independent post-retry runs needed the retry on two legs each —
   `sessionRenewal.attempts` recorded article 1, cart 3, home 1, product 2 — so those two legs refuse without
   it: the retry is what stands between them and `SESSION_RENEWAL_FAILED`. Campaign scale is 21 legs, so the
   class is closed at fixture scale only. The residual is an extrapolation, not a rate, and it is stated with its
   caveats: those twelve leg-runs are four fixture legs repeated three times rather than twenty-one independent
   campaign legs, and the hazard is not constant — first attempts failed 5/12 (`p = 0.417`), of the five that
   reached attempt 2 exactly one failed, and the single attempt 3 succeeded. A constant-hazard row is therefore an
   **upper bound**, about 1.5 of 21 legs, with the conditional rates (0.2, then 0) putting any point estimate
   below it on a sample far too small to carry one. `MINT_ATTEMPTS` stays at 3: raising it would rest on a
   memoryless model the data refutes and would silently mix a second variable into the next campaign run, and a
   bound change needs its own measurement — the re-run measures the residual first, the bound follows that
   measurement.
   The reorder is kept for its failure handling — a failed mint no longer strands the run's tab — and not as a
   demonstrated remedy; `git revert 874060e` is the cheap exit if it proves inert beyond that. One lever remains
   untried: a settle gap between mint completion and the tab close. **Publication is now gated by the other two
   classes rather than by renewal**: the same run refused `article__1024x900` and `home__1440x900` on
   `content-changed-between-passes` and `cart__1440x900` on `REFERENCE_IDENTITY_DRIFT+SUBJECT_IDENTITY_DRIFT`.
2. **Image identity churn — two mechanisms, hash mover still unnamed.** After hydration, `article__1024x900`
   and `home__1440x900` hold every other recorded field constant across passes — `imageCount` 37/115,
   `imageSetSize`, `sectionCount`, `productCardCount`, `docHeight` 4821/5426, `scrollWidth` 1024/1425,
   `textHash`, `textLength`, `pendingImages` 0, `brokenImages` 0, `chromeProbe` region hashes — while
   `imageSetHash` takes three distinct values. Widening `imagePanel` from its first 12 images to all of them,
   and recording the within-pass identity diff, named two positional movers against that constant document: the
   second `logo-hlt-2024.png` instance shifts `y` 30 to 52 (article) and 30 to 55 (home), and an image whose
   truncated basename is `%3E` (300x150) moves `y` 795 to 4675 (article) and 795 to 5321 (home). The move is not
   scroll — `chromeProbe.scrollY` is 0 and `SETTLE_SCROLL_ANCHOR_EXPR` asserts it, so every pass is `anchored:
   true` with the page at the top — and it is not image loading either: `pendingImages` 0, `brokenImages` 0 and
   every count and the document itself are constant. It is also **two mechanisms, not one**. The positional move
   happens once, between pass 1 and pass 2, and `y` then holds through pass 3 while `imageSetHash` keeps
   changing; a one-off layout or paint change after the read block — an ancestor transform or a carousel that
   resumed when `releaseCompareBlockers` ran — fits it as well as a re-render, and a rect alone cannot tell them
   apart, so neither is asserted here. The repeating mechanism is the hash, and the panel does not see it:
   `panel` and `identityCounts` both key on `split('/').pop()` while `imageSetHash` uses the full `currentSrc`
   plus natural size, so a URL-level change on a positionally stable image is invisible to that diff. **The hash
   mover is therefore still unnamed**, and the next evidence field is the full rendered rect plus `complete` and
   the DOM index — not another mover class. The one-shot loader-state *normalisation* was
   tested and rejected as the mover; the loader's own later pass remains the leading candidate for the repeat
   mechanism, as the paragraph below locates. `IMAGE_HYDRATION_EXPR` gained `lazyloaded` on promotion (keeping the drop
   of `lazyload`/`lazyloading`, so no stale loader class survives), the 4-pair fixture reproduced the same four
   verdicts and the same mechanisms — `article__1024x900` and `home__1440x900` `content-changed-between-passes`,
   `cart__1440x900` `REFERENCE_IDENTITY_DRIFT+SUBJECT_IDENTITY_DRIFT`, `product__1440x900` `PASS/MATCH` — and
   the edit was **reverted**: the promotion itself is the measured-good part and stays. Why it changed nothing is
   now located: `IMAGE_HYDRATION_EXPR` runs once per tab (`theme-fidelity.mjs:1583`), right after
   `waitForReadyState` and **before** `settle.hydrateToCapturedState`, while the replay serves the dump as
   written (`replayFile`, `:1544-1550`) and so executes the page's own inline lazysizes — a promotion applied
   before that loader's later, scroll-driven pass is re-swapped by it. The served input for `article__1024x900`
   confirms the loader is really in the page: it carries `lazySizes`/`lazysizes`, 7
   `class="lazyload"` beside 7 `lazyloaded` — the mixed state, in one page — 13 `data-src=`, 8 base64
   `src="data:image` placeholders and 10 inline scripts, while `data-srcset=` is absent there. The HTML is scratch
   and stays untracked; the committed verdict pins it as
   `replay.reference = { sha256: d16cc256ade5b438c294553fc4a5b13e1980c4c5230fa9704ed37dbd82477293, bytes: 958467 }`,
   so those counts are reproducible from a tracked artifact rather than from a kept dump. The absence of
   `data-srcset` there is not evidence about the hash mover, though — `imageSetHash` is not a source hash:
   `SETTLE_STATE_EXPR` builds it per image, in DOM order, as `currentSrc|naturalWxH|rect(x, y+scrollY, w, h)|complete`
   and hashes the joined parts (`canary-settle.mjs:155-162`, hash at `:173`), so the rendered rect, the `complete`
   flag and the image order all move it with no source change at all. Measured against that: an index-aligned diff
   of the panel between **pass 2 and pass 3** — the interval where `y` holds — finds **0** differences in `src`,
   natural size and `y`, with the DOM order identical, so the repeating move is in `x`, the **rendered** `w`/`h`
   (the panel records natural size, not the rect) or `complete`. The earlier reading of it as a `src` assignment is
   withdrawn, and so is any ordering claim: the same diff rules node re-ordering out on both intervals. The
   loader's own attribute set is separately ruled out as the leak — across all eight served dumps there are **0**
   `data-srcset=`, **0** `data-bg=`, **0** `<source>` and **0** `img[srcset]`, while `img[data-src]` (56) and
   `img.lazyload` (38) are exactly what the promotion covers and the 104 `data-original` hits sit on non-`img`
   elements — which says the promotion's coverage is complete for what the served page declares, not that the
   promotion is the mover. The next evidence step is therefore, per pass and per image, the full rendered rect
   plus `complete` and the DOM index (or the hashed `parts` exposed for diffing), and a count of elements still
   matching the loader's selectors after hydration and scroll. The lever that follows is to re-apply the promotion
   immediately before each measurement read from one shared page function — and only a nonzero selector count
   needs wider selectors.
   What remains on these two legs is a typed refusal that is currently the correct verdict: a surface that changes
   between two passes of one URL cannot be published as a comparison until the mechanism is either covered by the
   freeze or accepted as a permanent refusal — the owner decision recorded in the plan.
   The evidence additions stay: a full `imagePanel` and an `imageIdentityChanges` list are recorded, never gate
   inputs, so the next session can name a mover without re-deriving it.
3. **Settlement honesty floor.** The strict path requires four consecutive samples with an unchanged image +
   geometry signature and `pendingImages === 0`. The 9 s deadline path returns
   `imagesSettled: pendingImages === 0 && stableSamples >= 2` — about 200 ms of stability — so read
   `imagesSettled: true` from a deadline-path result as a floor, never as proof that the set stopped moving.
4. **Geometry growth — closed on the two churn legs, open on mobile.** `pendingImages: 0` with
   `imageCount`/`sections`/`cards`/`text` constant while `docHeight`/`scrollWidth` grew did not fit plain image
   loading, and the post-promotion fixture resolved it for `article__1024x900` and `home__1440x900`: all three
   passes hold `docHeight` 4821 and `scrollWidth` 1024, with the residual move being the positional-and-hash
   pair of item 2 rather than the document. The pin-layer lever is therefore not indicated for those legs; it remains untested where
   growth still appears, which after promotion is the `390x844` legs (the clone mobile defect, 4543–4545 px
   against a 9843 px dump). If the pin count rises with the document there, the fix is an idempotent or
   restored pin layer, not another wait.
5. **Route assertion** (`260911-0652` Phase 1). `checkObservedUrl` (`theme-fidelity.mjs:1118-1140`) asserts only
   host and `themeid`; pathname and query are recorded at `targets[].dom.observedUrl` and never compared, which
   is the same unasserted class that plan fixes in `fifteen-pages-run.mjs`. Sibling fix point, and this
   harness's publication gate is what waits on it. As of this handover the fix is in flight but uncommitted in
   the working tree — `expectedUrl` on the `anti.screenshot.full_page` call plus pathname normalisation in
   `checkObservedUrl` — so verify and finish it, do not author a second version.
6. **Reference asymmetry r1 vs r2 — inspect before tuning.** The same subject scored 0 PASS against r1 and 5
   against r2, and r1's extra failures are reference-side (7 legs `REFERENCE_IDENTITY_DRIFT`, including 404@1024
   and 404@1440, with r1 home@1440 recording `referenceHeight` 7532 where r2 records 5426), so part of r1's
   reference side needs re-capture rather than settle work. In r2 every PASS is desktop while all seven
   `390x844` legs refuse — a pattern no image-stability change addresses.
7. **Evidence recovery.** The compare driver rebuilds its set directory at stage start, so cancelling a compare
   mid-set wipes the working copies (the aborted run removed 19 verdict files under `r1-vs-subject/`). The
   committed copies under `.canary/theme-fidelity-run4/compare/` are the recovery source: restore path-scoped
   (`git restore --source=<commit> -- <path>`), never repo-wide.

### Assets for whoever resumes

- Fast validation loop, measured at 4 pairs in 197 s against a 50-minute campaign run: builder script at
  `C:/Users/Admin/.omp/agent/sessions/--E--Work-apps-AntiFan--/2026-09-09T11-31-20-180Z_01a085ef-cbf4-765d-9a4f-ecf6ff8f7c77/local/build-fast-fixture.mjs`,
  then `node .canary/tools/theme-fidelity.mjs compare --reference .canary/theme-fidelity-fast/r2mini --subject .canary/theme-fidelity-fast/subjectmini --out <dir>`.
  `.canary/theme-fidelity-fast/` is scratch, untracked.
- Costly constraints: never put a backtick inside a page-side template literal (`IMAGE_HYDRATION_EXPR`,
  `SETTLE_*_EXPR`); one variable per run, so never edit `.canary/tools/**` while a run is in flight;
  `git add -f` for every `.canary/**` path; never signal-kill the Electron plane — `hub restart antifan-canary`
  is the lifecycle lever. The plane is now shared with the session that took over `260911-0652`, so confirm it
  is idle before any run: `hub ps` lists hub-managed processes only, and a peer session's in-flight compare
  would not appear there — check `hub list` for peers in this project too, because two concurrent
  browser-plane runs corrupt both sets of verdicts. Those two probes are also blind to a peer's uncommitted
  edits to `.canary/tools/**`: an in-flight `260911-0652` edit to `theme-fidelity.mjs` (`expectedUrl` on the
  capture call, pathname identity in `checkObservedUrl`) was in the tree during this session's last fixture
  run, so that run's route-identity behaviour belongs to that edit and not to this session's changes. Commit
  `.canary/tools/**` path-scoped, name every path explicitly, and verify the staged set with
  `git diff --cached --name-only` before committing. The peer run was live during this session's last two
  fixture runs (`loader-out` and the widened-panel diagnosis) — `.canary/theme-fidelity-run4/compare/**` was
  being rewritten while they ran — so treat their legs as not singly-attributed even though both reproduced the
  earlier isolated fixture verdicts exactly, mechanism for mechanism.
- The ultra wave's five candidates were scored, all five refuted on their named cause, and the applied shape
  confirmed best: `C:/Users/Admin/.omp/agent/sessions/--E--Work-apps-AntiFan--/2026-09-09T11-31-20-180Z_01a085ef-cbf4-765d-9a4f-ecf6ff8f7c77/local/ultra-verifier-verdict-round2.json`.
