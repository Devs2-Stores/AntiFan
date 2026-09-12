# Scout Union — Ultra Wave 2 (45-theme corpus + Admin + Storefront + Haravan skill family)

Generated `2026-09-12`. Method: one immutable packet
(`plans/reports/scout-ultra-packet-260912-haravan-corpus.md`), five read-only candidates dispatched in a
single parallel wave, one read-only verifier scoring them against the packet rubric and re-deriving
load-bearing claims. Candidates and verifier ran on the same model tier: this is **best-of-5 with a
same-tier adjudicator**, not cross-tier validation.

- Candidates: `UltraCand1` (T1 architecture), `UltraCand2` (T2 idioms), `UltraCand3` (T3 Admin/declarations),
  `UltraCand4` (T4 storefront), `UltraCand5` (T5 field docs → rules). Full reports at `agent://UltraCand1`…`5`.
- Verifier: `UltraVerifier` — full payload `agent://UltraVerifier`, transcript `history://UltraVerifier`.
- **Winner: `UltraCand4`, 20/25 rubric points** (coverage 5, evidence 5, density 5, honesty 5). Runners-up:
  cand-2 (19), cand-3 (18), cand-1 (17), cand-5 (4/… partial). Winner's distinguishing evidence: it is the
  only candidate that tied every number to a named artifact, timestamp and revision label, and the only one
  whose findings can invalidate an existing release claim.
- Read-only discipline held: no candidate wrote anywhere, none ran `hrv select`, none built or tested.

## 1. What the controller re-verified first-hand this turn

Every item below was re-measured by the controller; candidates' uncorroborated claims are marked
`[CANDIDATE-ONLY]` and were not merged into the corrections.

| Claim | Measurement |
|---|---|
| Cart loop variable is free; the object is `line_item` | 8252 files scanned: `for item in cart.items` 215, `for line_item in cart.items` 7; `line_item` over `order.line_items` 72. Documented aliases `cart_item`/`item_cart`/`cart_line_item`: **0 occurrences**. |
| `themes/phukienmaymoc-copy` has 8 cart loops, all named `item` | Node scan of the theme: 8 loops, vars `item×8`. |
| Bracket setting reads are a real idiom | 155 theme files across `customizes/`, `themes/`, `apps/AntiFan/themes/` use `settings['<id>']`, **933 distinct keys**. |
| `customizes/Phukienmaymoc/config/settings.html` is inert | 256 092 bytes; one HTML comment; 255 569 bytes inside it (99.8 %); 961 `name=` occurrences, **all inside the comment, 0 outside**. |
| 7/7 `themes/f1genz/Haravan` themes ship `settings.html`; 6 pair it with a degenerate schema | File-per-theme check plus `[]`/`[{}]` content check. |
| `HARAVAN_SETTINGS_HTML_FORBIDDEN` (f1genz) refused those 7 themes | Rule read at `scripts/lib/theme-checks.mjs`; corpus shape contradicts it. |
| `config/settings.html` `setting-id`/`setting-type` attributes: 0/46 | 46 settings.html files, 41 use `name=`, 0 use `setting-id=`/`setting-type=`. |
| `setting-id`/`setting-type` in storefront markup is real | 428 Liquid/HTML files, 4324 `setting-id=` occurrences, 419 with `setting-type=` → the binding contract targets rendered markup, not the settings form. The packet claim was never wrong; my first count scoped it to the wrong file. |
| `image_url` is not a corpus-wide absence | 8252 files: exactly 1 usage — `customizes/Iamhome/snippets/ih-projects-article-card.liquid:48`. |
| The 45-case verification artifact is invalid | `reports/chromium-verification/chromium-45-cases-results.json`: 45/45 `VERIFIED_PASS`, every URL `?preview_theme_id=1001512581` (45), 0 with `themeid=`; `metrics.docWidth` **1905 for all 45** despite declared 1440/1024/390; `hasFooter:false` on all 45. |
| The CLI has no structural delete guard | Layers for a watcher `unlink`: watcher key filter (`theme-dev-watcher.ts:273,282-283`) → `BulkDeleteQueue` confirm, which fires **only for flushed batches ≥ 3** (`:85`) and is always denied on the shipped path (`theme-dev.ts:75` → `LiveOpsService.startDev`, handler at `live-ops-service.ts:576-585` returns `false` unconditionally; the inquirer fallback is unreachable) → `checkFilePush(path, true)`, which under `notDelete=true` skips the existence and 3 MB checks and leaves `isThemePushableByExtension` against a 19-extension allowlist → `processingDeleteFile`, which has no check of its own. A 1–2 file batch is gated by extension alone. |
| `-n`/`--nodelete` is a no-op | The option is registered (`helper/command-registry.ts:117`) and `noDelete` appears in `src/` only in destructuring, type fields and pass-through (`index.ts:36,97`, `theme-push.ts:60,179`, `files.ts:714`, `live-ops-service.ts:246`); never in a condition. |
| Mega-menu dead links, measured against the full catalog | 79 distinct `/collections/…` hrefs in the rendered home, 14 resolve against the store's 37-collection catalog → **65 dead** (unchanged from the fixture-derived count; no flagged handle is live). |
| Viewport application, per breakpoint | `_capture-local-render.mjs` now records `innerWidth`/`visualViewport.width`/`devicePixelRatio`/`viewportApplied`: 1440→1440, 768→768, 390→390, dpr 1, `scrollWidth` equal to width, 0 broken images, 0 page errors. |

## 2. Corrections applied this turn

### Linter (`scripts/lib/theme-checks.mjs`, `scripts/lint-haravan-theme.mjs`)

1. **Cart naming.** `HARAVAN_CART_LINE_ITEM_LOOP` mandated the loop variable `line_item` and refused the
   corpus-correct form; it fired 8 times on `themes/phukienmaymoc-copy` alone. Replaced by
   `HARAVAN_CART_ITEM_NAMING`, which refuses only the documented prohibited aliases
   (`cart_item`, `item_cart`, `cart_line_item`). The verifier recommended inverting the predicate so
   `line_item` fails: **not adopted** — the corpus uses `item` 215:7 and never uses the aliases, and a
   `line_item` refusal would fail AntiFan's own base theme (`snippets/cart-table.liquid:11`).
2. **Bracket reads.** `SETTINGS_BRACKET_READ_PATTERN` (with the same `(?<![\w.$])` lookbehind) now feeds both
   `checkSettingsBinding` and `HARAVAN_SETTING_UNRESOLVED` through one `matchSettingReadIds` helper.
3. **Declaration sources.** `collectDeclaredSettingIds` unions the schema with `config/settings.html` control
   names, and strips HTML comments before collecting them. Effect on shipped themes: `customizes/Toda`
   undeclared 903 → 145, `SittoVietnam` 943 → 90, `Iamhome` 413 → 82, `devs2/NauAtelier` 241 → 0,
   `f1genz/Haravan/GenZ` 385 → 7.
4. **Removed a second, comment-blind name extractor** that fed `knownSettings` and would have re-declared
   Phukienmaymoc's 961 commented-out names, nullifying (3).
5. **Product media.** The blanket refusal (`HARAVAN_PROVEN_PRODUCT_IMAGES`) is replaced by
   `HARAVAN_MEDIA_NO_FALLBACK` (a `product.media` gallery must reach `product.images`/`product.featured_image`
   in the same file) plus `HARAVAN_MEDIA_TAG_FORBIDDEN` (`media_tag`, 0 corpus hits). The wiki already
   documented `product.media` as officially supported with a mandatory fallback; the linter contradicted it.
6. **Settings-mode liveness.** `HARAVAN_SETTINGS_HTML_FORBIDDEN` now fires only when the paired schema is
   live; new `HARAVAN_SETTINGS_DECLARATIONS_ABSENT` fires when the schema declares no control **and** the form
   is inert, i.e. nothing declares settings. Degenerate schemas (`[]`, `[{}]`) are no longer read as coverage.
7. Rule inventory comments in both files updated to the corrected contracts.
8. **Blog article counts.** `HARAVAN_BLOG_ARTICLES_COUNT` flagged every `articles.size` on the line,
   including emptiness tests. It now skips a size comparison against `0` or `1` (`{% if blog.articles.size > 0 %}`)
   and still refuses a displayed or non-trivial use of the page-local slice as a total. This removed the last
   2 false positives in `themes/phukienmaymoc-copy` and lowered the corpus counts (`customizes/Toda`
   145 → 102, `Iamhome` 82 → 34).

### Verification harness and artifacts

8. **`packages/site-clone/src/qa/dod-validator.ts`** — `auditHaravanPreview` accepted `theme_id=` and
   `preview_theme_id=`, which is how the 45-case artifact could certify a theme it never addressed. It now
   requires a numeric `[?&]themeid=<digits>` and reports the id in its evidence.
9. **`reports/chromium-verification/README.md`** added: the 45-case artifact is marked `INVALID — NOT
   REVISION-BOUND` with the four measured disqualifiers and what a replacement must carry. The artifact is
   not deleted (audit trail).
10. **`plans/reports/_render-home.mjs`** — live handle resolution reads the store's full cached catalog
    (37 collections) instead of the 14-collection fixture, for both dead-link checks and the title check.
11. **`plans/reports/_capture-local-render.mjs`** — persists `innerWidth`, `visualViewport.width`,
    `devicePixelRatio` and `viewportApplied` per breakpoint, so a breakpoint verdict cannot rest on an
    unapplied viewport.

### Documentation (AntiFan wiki)

12. `docs/haravan/cli-operations-and-guards.md` §4: the "Deletion Protection & Risky Asset Guards" heading and
    its two bullets were false. Corrected: `-n`/`--nodelete` is a no-op (the real option spelling, replacing
    the nonexistent `--no-delete` also listed in the §2 command table); deletion protection is a **batch-size
    confirm only** — `BulkDeleteQueue` (`theme-dev-watcher.ts:12-14,85,105-114`) confirms when a flushed batch
    reaches 3 files, and the handler that ships always denies: `hrv theme dev` → `LiveOpsService.startDev`
    (`theme-dev.ts:75`, handler `live-ops-service.ts:576-585`) emits a prompt then `return false`
    unconditionally, so ≥ 3 in one batch is cancelled outright while the `@inquirer/prompts` fallback is
    unreachable (`runThemeDevSession` has no callers). A batch of 1–2 unlinks is gated by the 19-extension
    allowlist alone (`checkFilePush(path, true)` → `isThemePushableByExtension`), and `processingDeleteFile`
    (`files.ts:836-863`) has no check of its own.
    `getRiskyAssetKeyReason` is a size-suffix naming warning called from asset listing and doctor reports only;
    `compareFileAndRemove` trashes local files rather than deleting remotely. Ledger row downgraded from
    `VERIFIED` to `CORRECTED — FALSE` with the corrected anchors (including the earlier mis-anchored
    "gated only by `checkFilePush`" claim); the preview-parameter row records the resolution.
13. `docs/haravan/platform-topology-and-settings.md`: the F1GENZ "NEVER generate `settings.html`" rule
    replaced with the corrected, evidence-backed rule (live schema vs degenerate schema; presence ≠ liveness),
    plus four new ledger rows (7/7 f1genz forms, inert form, bracket idiom, 10/39 degenerate schemas).
14. `docs/haravan/liquid-objects-filters-tags.md`: `image_url` row corrected from "FATAL / 0 hits VERIFIED" to
    "runtime UNKNOWN, 1/45 observed"; new rows for the cart object-vs-loop-variable distinction and the media
    fallback rule.

### Tests

15. New fixtures `test/fixtures/theme-checks/theme-haravan-upload/` (upload control name `header_logo.png`,
    `item` cart loop, `cart_item` alias, media with and without fallback, `media_tag`) and
    `theme-haravan-inert/` (controls inside an HTML comment). Four tests pin the corrected contracts.
16. `dod-validator.test.ts` preview cases updated in place plus two new cases (non-numeric `themeid`, Shopify
    spellings refused; `themeid` accepted alongside other query parameters).

## 3. Verification log

| Command | Result |
|---|---|
| `node --test test/unit/theme-checks.test.mjs test/unit/lint-haravan-theme.test.mjs` | **40/40** (33 in `theme-checks`, 7 in `lint-haravan-theme`) |
| `npx tsc --noEmit -p ./` (packages/site-clone) | clean |
| `npm test` (packages/site-clone) | **361/361** (was 359; +2 new preview cases) |
| `node scripts/lint-haravan-theme.mjs --theme themes/phukienmaymoc-copy` | 27 → 19 → 7 → **5** violations, all `HARAVAN_INCLUDE_TARGET_MISSING` (`product-loop`, `product-loop-no`, `product-loop-loadding` referenced by two dead snippet files). No false positives remain. |
| `node scripts/lint-haravan-theme.mjs --theme themes/universal-haravan-base` | clean (0) |
| `themes/devs2/S2Bed`, `themes/f1genz/Haravan/GenZ` | clean (0) after the media, settings-mode and blog-count fixes (previously refused) |
| `E:/Work/customizes/{Toda,Iamhome,Phukienmaymoc}` | 102 / 34 / 23 violations (were 145 / 82 / 23 before the blog-count fix) — undeclared-setting noise on legacy themes, not law |
| `node plans/reports/_render-home.mjs themes/phukienmaymoc-copy …` | `RENDER_CONTRACT_SATISFIED`, 0 failures, 26 checks pass, 167 924 bytes; mega-menu dead handles 65 of 79 distinct collection hrefs against the live 37-collection catalog |
| `node plans/reports/_capture-local-render.mjs` | `viewportApplied: true` at 1440/768/390; 0 broken images; 0 page errors |

Rule histogram of the project theme, before/after, on the same source:
`HARAVAN_CART_LINE_ITEM_LOOP` 8 → 0, `HARAVAN_PROVEN_PRODUCT_IMAGES` 12 → 0,
`HARAVAN_BLOG_ARTICLES_COUNT` 2 → 0, keepers unchanged.

Product-side completeness check for the fixture: the 14 cached `collection-products-*.json` files hold
159 distinct handles, exactly equal to `fixture.allProducts` (159) with 0 handles outside it, so the
fixture's product set is the store's full fetched catalog and `product_hrefs_resolve = 0` is not an artifact
of a truncated set.

## 4. Merged findings (evidence-validated union)

### 4a. Architecture and families (`OBSERVED`, corrected roster)
47 theme roots = 45 Haravan + 1 Sapo (`themes/f1genz/Sapo/GENZ`) + 1 archived duplicate
(`themes/_archive/…/F1 Hera Jewelry`). Haravan roots: `layout/` 45/45 (4 themes ship 2–4 layout files),
`sections/` 0/45, JSON templates 0/45, `settings.html` 45/45, `settings_schema.json` 39/45 of which **10
declare nothing**, `settings_data.json` 45/45, `locales/` 13 directories of which 12 non-empty. Every
prevalence number must name its predicate; the earlier "30 themes" scope under-counted by 15 roots.

### 4b. Idioms (`OBSERVED`, corpus law only as practice)
`{% include %}` 8783, `{% assign %}` 32 030, `{% capture %}` 10 423, `{% form %}` 847, `{% paginate %}` 647;
`render`/`section`/`schema`/`tablerow`/`liquid`/`echo`/`increment` 0/45. Filters: `asset_url` 45/45,
`img_url` 45/45, `product_img_url` 44/45, `default_errors` 45/45, `t` 32/45, `image_url` 0/45 as a
corpus-wide absence (1 usage exists). Access forms: dot **and** bracket, with bracket carrying 933 distinct
keys.

### 4c. Admin / CLI (`OBSERVED`, read-only)
`hrv whoiam` lists 17 authenticated orgs; only `200001207485 Phukienmaymoc` enumerates
(`theme list --json` → `1001512581` unpublished, `1001510509` main), the other 16 return
`Lỗi xảy ra. Vui lòng thử lại!` after the org switch — cause UNKNOWN, recorded as a limitation, not pursued.
CLI command surface is theme-scoped only (no catalog CRUD). `hrv select` writes a project-local binding file,
so the sweep stayed in `E:/Work/.tmp-haravan-orgsweep`. Project bindings
(`E:/Work/apps/AntiFan/.haravan-cli_local.json` and `themes/phukienmaymoc-copy/.haravan-cli_local.json`) still
pin `{org_id 200001207485, theme_id 1001512581}`.

### 4d. Storefront and verification (`VERIFIED`)
Theme `1001512581` is `unpublished` — the org's public theme is `1001510509`. Any measurement addressed with
`?themeid=1001512581` must be labelled **live staging**, and the public storefront remains unmeasured
(UNKNOWN). The only 45/45 `VERIFIED_PASS` artifact in the repository measured the Shopify-inert parameter at
one unapplied width; it is now demoted and its acceptance path is closed in code.

### 4e. Skill family (`VERIFIED` contradictions, not yet edited)
1. `haravan-settings-schema/SKILL.md:8` — "Do not create or maintain `config/settings.html` in this branch"
   contradicts 7/7 f1genz themes.
2. `haravan-preview-screenshot/SKILL.md:23` names `?preview` / `theme_id` and lists Shopify's preview-bar
   selectors, while `haravan/SKILL.md:24` and `haravan-stitch-full-run` ban exactly that form.
3. `haravan-theme/references/settings-html.md` (file inputs carry the extension in the name) vs
   `themes/docs/rules/image-size-rules.md:17` (claims bracket notation does not exist). The extension **is**
   the key, so bracket notation is the required access form; 155 files use it. The rule file is inside the
   read-only reference corpus, so only the wiki and the skill are correctable.
4. `haravan-theme/references/liquid-cheatsheet.md` (product.media "confirmed usable") vs AntiFan's former
   blanket ban — resolved in code by the fallback rule; the skill row needs the same wording.
5. `haravan-settings-schema` type list (`radio`, `blog`, `page`) is unverified in any sampled schema; the
   observed vocabulary is `header, paragraph, text, textarea, checkbox, color, image_picker, select,
   collection, link_list`. `class="font"` exists on the base-font select in ≥4 themes and is missing from the
   documented class list.
6. Role vocabulary is not `main | unpublished`: `demo` appears in the CLI's own test fixtures, and the push
   gate refuses every value except `unpublished` — the safe rule is "unpublished only", never "not main".

### 4f. Base theme and generator gaps (`DERIVED` from corpus)
`list-collections.liquid` ships in 41/45 themes and is absent from the contract and base theme; 4/45 ship
alternate layouts; `{% layout none %}` fragment endpoints (`collection.pagesize`, `cart.reload`,
`product.quickview`) and the platform-asset bootstrap (`haravan_asset_url`, `option_selection_js`) are absent;
`setting-id`/`setting-type` bindings are mandatory for visual-editor editability and are unenforced; the
generator refuses the settings shape that 24/30 `customizes` themes and 7/7 f1genz themes use.

## 5. Conflicts resolved

1. `locales/` 12 vs 13 — both correct: 13 directories, 12 non-empty (`Sunriseplus/locales` is empty). Publish
   the predicate.
2. `settings_schema.json` 39/45 vs "10 stubs" — both correct; 39 is presence, 10 of those declare nothing.
3. Phukienmaymoc "operative legacy form" vs "inert form" — inert wins (measured: one comment, 961 names
   inside). Family signature must be stated as a dialect, not as "the form is operative".
4. Cart loop — the loop variable is free; the object name is documented. The linter was wrong, not the docs.
5. Deployed `news` section broken vs reachable `blogs['news']` — different objects; the local revision renders
   news at 436/479/479 px with 4 images, the deployed revision at 125/128/128 px with none.
6. Carousel overflow 12 elements vs none — harness semantics (an `isClipped` ancestor-overflowX filter), not a
   page change. Keep both numbers with the predicate attached.
7. `compact` — legal as an `img_url` preset, illegal as an array filter. The two namespaces were conflated.
8. `image_url` — the ledger's "0 hits VERIFIED" is wrong; 1 usage exists and runtime fatality was never tested.

## 6. Ranked remaining changes (controller verdicts)

Accepted, not yet implemented — ordered by consequence:

| # | Change | Verdict |
|---|---|---|
| 1 | Add the theme-identity watermark (`<meta name="haravan-theme-identity" content="org/theme/revision">`) and assert it in the capture path before any screenshot; make missing identity a lint failure for stored verification artifacts | ACCEPT — this is the only way a future campaign can bind a revision, and `specs/base-theme-contract.json` already carries it as `UNRESOLVED_03` |
| 2 | Make single-viewport or failed-sweep verification degrade to `INCONCLUSIVE` (push an `evidenceGap` in `src/main/qa/theme-qa-workflow.ts:447-475`) | ACCEPT — matches the plan's own rule that a top-viewport pass never stands for the page |
| 3 | Delete `specs/qa-matrix.json` as hand-written state; regenerate through the QA workflow; remove OS 2.0 wording from the compliance detail string | ACCEPT — 0/45 sections, 0/45 JSON templates |
| 4 | Base theme surfaces in one pass: `list-collections.liquid`, `{% layout none %}` fragments, platform-asset bootstrap, `default_errors` in every form, `setting-id`/`setting-type` annotations from a generated id→type map | ACCEPT — corpus-backed, and editability is currently unenforced |
| 5 | `dual` settings mode (or an explicit refusal) in `haravan-target-contract.ts` with id/default parity across both declaration files | ACCEPT — the corpus norm is unrepresentable today |
| 6 | Extend the Liquid scan to `assets/*.js.liquid|css.liquid|scss.liquid` (warning tier) and drop `static/` from asset resolution | ACCEPT — `hl-home.js.liquid` (~441 lines) sits outside every gate today |
| 7 | Settings markup hygiene rules: nested-comment detector, duplicate `id=`, self-closed `<select>`, name-scoped `class` checks, stray `config/*.bak*` | AMEND — add the detector, keep the tier advisory, and derive the class list from the corpus (`class="font"` exists; `blog`/`page` unverified) |
| 8 | `HARAVAN_DEV_LEFTOVER` (localhost WebSocket / `hrv-hot-reload`) and `master` img_url preset as errors | ACCEPT — both observed in shipped corpus themes |
| 9 | Corpus tooling: skip `scratch|_backup|sapo-package|_archive` subtrees with a recorded reason, exclude `config/settings.html` from Liquid probes, add a `store.*` probe with an explicit unprobed note | ACCEPT — every published prevalence number inherits the current contamination |
| 10 | `safe-ops-service.ts:86` role coercion `themeInfo.theme.role \|\| 'unpublished'` | ACCEPT as a finding, implement only with approval (separate app) |
| 11 | `.antifan` capture provenance (org/theme/revision in front-matter, refuse mismatched binding) | ACCEPT — 17 `customizes` themes carry captures whose cited org/theme do not match the directory |

Rejected or amended:
- "Invert the cart rule so `line_item` fails" — REJECTED (corpus 215:7 against; would fail the base theme).
- "`product.media` must be banned" — REJECTED; superseded by the fallback rule.
- "settings.html must be absent in f1genz" — REJECTED as stated; scoped to a live schema.
- "`--no-delete` protects deletions" — REJECTED as stated: the real flag is `-n`/`--nodelete` and it is never
  read in a condition. The surviving protection is the `BulkDeleteQueue` batch confirm (≥ 3 files per flush),
  which does not cover a single-file unlink.

## 7. Open items requiring a decision

1. **Remote push** remains unauthorized (`plans/260912-1731-haravan-az-implementation-plan/plan.md:11`), so no
   storefront render of this session's revision exists. Verification stays local + read-only-deployed.
2. **Third-party reference imagery** copied into `themes/phukienmaymoc-copy/assets/` (96 files) — provenance
   recorded, licensing decision is the user's.
3. **Two tracked dead snippets** (`snippets/homepage-collection.liquid`, `snippets/home-collection-tabs.liquid`)
   with 5 broken `{% include %}` targets: keep-and-document or delete.
4. **Hero mega-menu IA**: 79 distinct collection hrefs, 65 of which resolve to nothing in the store's
   37-collection catalog. Left as-is with the count recorded.
5. **Vision quota** exhausted at capture time: screenshot review is user-side; the harness compensates with
   DOM/computed-style/section assertions and `viewportApplied` proof.
6. **Haravan skill family edits** (5 items in §4e) — the user asked for the skill family to be included; the
   edits are ready but touch `C:/Users/Admin/.claude/skills/**`, outside this repository.
