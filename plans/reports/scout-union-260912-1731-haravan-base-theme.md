# Scout Union — Ultra Mode: 5 independent candidates + 1 verifier

Generated `260912-1731`. Read-only phase complete. **Controller owns this write**; the five candidates were
read-only and the verifier was read-only by instruction.

- **Candidates** (one parallel wave, identical packet + identical correction steering, all on the same model tier):
  `ScoutAlpha`, `ScoutBravo`, `ScoutCharlie`, `ScoutDelta`, `ScoutEcho`.
- **Verifier:** `ScoutVerifier` — same model tier as the candidates. This is best-of-5 with a same-tier adjudicator,
  **not** an LLM-as-a-Verifier framework and not cross-tier validation.
- **Winner: ScoutBravo, 92/100.**
- Deliverable-integrity note: the verifier's output arrived complete for PART 1 (scores) and PART 2 (union) but was
  truncated before a separate PART 3/PART 4 heading. Its per-candidate strengths/weaknesses and its §7 refuted-claims
  table carry the same content; the ranking appendix below is assembled from those and marked as such.

---

## 1. Ranking appendix

| Rank | Candidate | Score | What it got right that others did not | What it got wrong / could not carry |
|---|---|---|---|---|
| 1 | **ScoutBravo** | **92** | Strict 30-theme census; quoted the exact `DEFAULT_SYNC_PATTERN` regex from `haravan-sync-barrier.ts`; cited Haravan CLI Chokidar sync-state files and `dod-validator.ts` Criterion 17; complete 24-phase T4 mapping. | Omitted `platform-detector.ts` (D4); omitted the campaign report from its T3 table. |
| 2 | **ScoutEcho** | 85 | Found Shopify OS 2.0 assumptions inside `theme-source-mapper.ts` (D8) and the `docWidth: 1905` overflow in `chromium-45-cases-results.json` — the first thread that led to D9/D10. | No slider-recurrence distribution; omitted the campaign report from T3. |
| 3 | **ScoutCharlie** | 80 | Traced `element-picker.ts` / `annotation-manager.ts` extracting live-DOM `liquidContext` (`sectionId`, `sectionType`). | Missed D4; did not confront the 16/45 failures; included `_templates` as a theme row (corrected mid-flight). |
| 4 | **ScoutAlpha** | 78 | Found `snippets/hrvproducttabs.liquid` recurring in exactly 21 themes; first to flag the headline PASS contradiction. | Truncated T4 to 11 phases; misread `Dangvietmart` leak. |
| 5 | **ScoutDelta** | 75 | Found 30 LadiPage export templates in `Tototuantu`; audited 10 QA artifacts. | **Accepted the `45/45 PASS` claim as measured** — the single most consequential error any candidate made; missed D4. |

Refuted claims (verifier §7, independently confirmed by the controller where noted):
- **REFUTED** — Alpha: `Dangvietmart/assets/customer-scripts.js.liquid:99–103` is a platform leak. `coupon.image_url`
  is a client-side JSON property on an Ajax response, not a Liquid filter. The real 1-file leak is
  `Dangvietmart/INTAKE.md:3` (`"Platform: haravan | sapo | shopify"`).
- **REFUTED** — Delta: the campaign report is a verified PASS gate. Contradicted by its own case data.

---

## 2. T1 — Corpus (30 real themes, `E:\Work\customizes`)

Ground truth (controller Tier-1): exactly **30** customer themes. Excluded non-themes: `New folder`, `README.md`,
`_backup_index_consolidate`, `_backup_poster`, `_done`, `_templates`.
`.workspace-context.json` in 26/30 (missing `Bagamuioto`, `Reebaby`, `TestVyan`, `Thietbihoaphat`); verified 24,
needsVerification 2 (`Dangvietmart`, `GomDatViet`).

| Theme | Settings source | Slider library | CSS/JS convention | Leak |
|---|---|---|---|---|
| Apshop | both | Swiper + Slick fonts | `.css.liquid`, `.js.liquid` | 3 files (FontAwesome/Shopify CDN comments) |
| Bagamuioto | both | Slick | LeapLogic modular `ll-*`/`style-*` SCSS | none |
| CuddlePet | both | Slick | `style-themes.scss.liquid` | none |
| Dangvietmart | both | Slick | LeapLogic SCSS, `render-library.css.liquid` | 1 (`INTAKE.md:3`) |
| Eiddo | both | Slick (bundled), Plyr | Wanda `render-style*.css` | none |
| FarmerMarket | both | Slick | `cus.scss.liquid`, `style-themes.scss.liquid` | none |
| GixJewel | both | Flickity | `styles.css.liquid`, `bootstrap.min.css` | none |
| GomDatViet | both | Owl Carousel + Slick | Suplo `suplo-style.scss.css` | none |
| Hapas | both | Slick (jsdelivr) | `cusnew.scss.liquid`, `collection.scss.liquid` | none |
| Iamhome | `settings.html` only | Swiper | F1GENZ `collection.css.liquid`, `f1_*.liquid` | none |
| Kome88 | `settings.html` only | Swiper v14 (CDN) | `bootstrap-4-3-min.css`, `lazy.js` | none |
| Luxvie | both | Swiper | `swiper.scss.liquid` | none |
| Mnbakery | both | Slick | MN design tokens | none |
| Mulgati | both | Flickity + Owl | monolithic SCSS | none |
| OwlBrand | both | Slick + Owl (inlined) | EGA `ega.js` | none |
| Phukienmaymoc | both | Slick | Hoplong/LeapLogic `hl-*`/`ll-*` | content copy only |
| Reebaby | both | Slick | `style-themes.scss.liquid`, `style-ldpage-01.scss.liquid` | none |
| Remolacha | both | Flickity | `plugins-css.liquid`, `plugins-scripts.liquid` | none |
| Rosemine | both | Swiper v8.4.4 + Slick | `rosemine_custom.css/js` | none |
| Seahorse2 | both (+ service backup) | Swiper + Flickity | F1GENZ `seahorse-design-system.css` | none |
| SittoVietnam | `settings.html` only | Swiper | dual layout `theme.liquid` + `theme.en.liquid` | none |
| Starsolution | both | Swiper 11 | AJAX tabs, JSON search | none |
| StylekoreanVietNam | both | Slick | `product-loop--options.liquid` | none |
| Sunriseplus | `settings.html` only | Flickity + Owl (inlined) | `plugins-css.liquid`, `plugins-jquery.liquid` | none |
| TestVyan | both | Slick | Evo `evo-main.scss` | none |
| Thietbihoaphat | both | Owl | Suplo/Timber, dual layout | none |
| Toda | `settings.html` only | Swiper | `toda-core.css`, `toda-megamenu.js`, dual layout | none |
| Tototuantu | `settings.html` only | Slick + Owl | EGA, 4 layouts, 30 LadiPage templates | none |
| Vyantechnology | both | Slick | Evo `evo-main.scss` | none |
| Zesta | both | Slick | `zesta.js`, product-loop snippets | none |

### Recurrence — Base Theme candidates (≥5 themes)

| Primitive | Count | % | Class |
|---|---|---|---|
| `layout/theme.liquid` | 30/30 | 100 | universal root layout |
| `templates/index.liquid` (+ `product, collection, cart, search, 404, blog, article, page`) | 30/30 | 100 | universal flat templates |
| `templates/customers[*.liquid]` | 30/30 | 100 | universal customer templates |
| `config/settings.html` | 30/30 | 100 | universal admin config form |
| `config/settings_data.json` | 30/30 | 100 | universal config storage |
| `snippets/header.liquid`, `footer.liquid`, `swatch.liquid` | 30/30 | 100 | universal includes |
| `snippets/breadcrumb.liquid` | 29/30 | 96.7 | universal nav trail |
| `snippets/fb-open-graph-tags.liquid` / `social-meta-tags.liquid` | 28/30 | 93.3 | universal social metadata |
| `snippets/footer-scripts.liquid` | 26/30 | 86.7 | script boundary |
| `snippets/pagination-default.liquid` | 26/30 | 86.7 | paginator |
| `config/settings_schema.json` | 24/30 | 80.0 | editor schema |
| `snippets/quickview.liquid` | 24/30 | 80.0 | quickview modal |
| `snippets/product-loop.liquid` | 22/30 | 73.3 | product card |
| `snippets/hrvproducttabs.liquid` | 21/30 | 70.0 | app snippet |
| `snippets/mini-cart.liquid` / `header-mini-cart.liquid` | 20/30 | 66.7 | cart drawer |
| `snippets/master-include.liquid` | 20/30 | 66.7 | asset inclusion |
| `snippets/menu.liquid` | 19/30 | 63.3 | desktop navigation |
| `snippets/seo_head.liquid` | 19/30 | 63.3 | SEO |
| `snippets/addthis-sharing.liquid` | 19/30 | 63.3 | social sharing |
| `snippets/swatch-quickview.liquid` | 17/30 | 56.7 | quickview swatch |
| `snippets/menu-mobile.liquid` | 17/30 | 56.7 | mobile menu |
| `snippets/plugins-script-head.liquid` | 16/30 | 53.3 | head tracking |
| `snippets/swatch-sb.liquid` | 14/30 | 46.7 | sidebar swatch |
| `snippets/template-product-script.liquid` | 13/30 | 43.3 | product script |
| `snippets/header-search.liquid` | 12/30 | 40.0 | header search |
| `snippets/modal-coupon.liquid` | 8/30 | 26.7 | coupon modal |
| `snippets/product-grid-item.liquid` | 7/30 | 23.3 | card name variant |
| `snippets/product-item.liquid` | 5/30 | 16.7 | card name variant |

**Carousel engine split (no universal winner):** Slick 19/30 (63.3 %), Swiper 9/30 (30 %), Owl 6/30 (20 %),
Flickity 5/30 (16.7 %). Multiple themes ship two engines. → the Base Theme must not adopt a vendor carousel as
"the Haravan way"; it is theme-specific.

**Theme-specific (exclude from core, <5 themes):** LeapLogic SCSS (4), multi-layout shells (4), bilingual
`*.en.liquid` pairs (3), Suplo/Timber (2), Evo (2), EGA (2), LadiPage exports (1 theme / 30 files),
MN tokens (1), F1GENZ design system (1), Seahorse2 AMP (1).

---

## 3. T2 — AntiFan Core + Haravan CLI

**Core modules that already implement real behavior (assets, not defects):**

| Module | Responsibility | Anchor |
|---|---|---|
| `server/preview-url-codec.ts` | `antifan-preview://` codec; rejects UNC, drive letters, `%2E%2E`, null bytes | `:1–120` |
| `server/preview-protocol-handler.ts`, `preview-watcher-pool.ts` | serves modified Liquid/assets via Chokidar | `:35–80` |
| `qa/haravan-sync-barrier.ts` | fail-closed upload attestation: `DURABILITY_FAILED` on timeout, `STALE_LINEAGE` unless `documentGeneration` advances | `:25–154` |
| `qa/theme-mutation-session.ts` | composes sync+reload; refuses `VERIFIED` if generation did not advance | `:166–247` |
| `qa/theme-transaction-registry.ts` | constructs barrier, exposes `awaitSyncAndReload` | `:95–150` |
| `verification/capture-settle.ts` | pre-raster quiescence predicates (documentGeneration, viewport, fonts, images, imageIdentity, layout) | `:421–626` |
| `browser/semantic-ref-registry.ts` | throws `REF_STALE` on generation mismatch | `:337–392` |
| `browser/element-picker.ts`, `annotation-manager.ts` | live-DOM `liquidContext` (`sectionId`, `sectionType`, `productId`) | `:354–381`, `:1164–1172` |
| `server/…` + `scripts/lib/atomic-record.mjs` | atomic record writes; `sha256File`, `HASH_CONTRACT.LF_NORMALIZED`, `textDigest` | — |

**Contaminated Core modules (see defect register):** `theme-qa-workflow.ts` (D1, D2),
`scanners/platform-detector.ts` (D4), `browser/theme-source-mapper.ts` (D8).

**Haravan CLI** — `@f1genz/haravan-cli` v1.2.0, bin `hrv`, deps `chokidar@4.0.3`, `liquidjs@10.27.0`,
`openid-client@5.4.3`, `adm-zip@0.5.17`, `@inquirer/prompts@7.2.1`.
Lifecycle: `theme dev` (Chokidar watcher, serial-queue, `.hrv-sync-state.json`), `theme push`
(`PUT/POST /web/themes/{id}/assets.json`), `theme fetch`, `theme publish` (`PUT /web/themes/{id}.json {role:"main"}`),
`theme lint` (LiquidJS), plus `list/info/delete/rename/export/console/retry`; top-level
`login/logout/whoiam/select/refresh/backup/restore/rollback/diff/doctor/assets/open/theme-language-server`.
**Real safety guards (assets):** `theme-push.ts:36–58` queries `GET /web/themes/{id}.json` and halts on
`role === "main"` with `⚠ CẢNH BÁO: Bạn đang sửa file trên theme LIVE (đang chạy ngoài store)!`, interactive
confirm defaulting to `false`, non-interactive fail-closed without `--force`; `:60–75` overwrite warning +
`--no-delete`; `safe-ops-service.ts:40–95` project binding via `.haravan-cli_local.json`, timestamped zip backups,
`isThemeBinaryAttachment()`, `getRiskyAssetKeyReason()`.
**Preview param (Tier-1, correct):** `theme-dev.ts:70` and `open-service.ts:80` build `?themeid=<id>`.

---

## 4. T3 — Measurement honesty (regraded by the controller; the verifier's grades were too lenient)

| Artifact | Claims | Honesty verdict | Derivable to a gate? |
|---|---|---|---|
| `test-theme/specs/qa-matrix.json` | 98, `passed: true`, `haravanCompliance: 100` | **UNMEASURED** — 3 viewports `measured:false`; static OS 2.0 strings | No — invert to fail-closed on `measured:false` |
| `chromium-verification/chromium-45-cases-results.json` | 45/45 `VERIFIED_PASS`, `passRate 100.0%`, `targetThemeId 1001512581` | **INVALID** — Shopify `preview_theme_id` (D9: measured the live theme), viewport never applied (D10: `docWidth 1905` at 390), `hasFooter:false` 45/45 passed | No |
| `HARAVAN-STOREFRONT-FINAL-CAMPAIGN-REPORT.md` | 45/45 PASS | **UNSUPPORTED / CONFLICT** — own case data records 16/45 non-PASS | No — audit trail only |
| `visual-compare-45-cases.json` + `VISUAL-COMPARE-15-PAGES-VERIFICATION.md` | 29 PASS / 16 REVIEW, 0.01–57.61 % | **MEASURED BUT UNBOUND** — real pixel diffs; no run/theme/reference identity; producer has D6/D7 | Yes, only after identity binding + removing min-select |
| `reports/fidelity-campaign-matrix.json` | 8 pass / 17 fail / 20 inconclusive (17.78 %) | **MEASURED, honest** — correct `themeid=` addressing, reports failure | Yes — best existing baseline |
| `reports/15-page-template-audit.json` | 256 leaks, 1040 Blade markers, 233 wire directives, 69 missing assets, 95 undeclared settings | **MEASURED (static)** | Yes — static cleanliness lint |
| `reports/15-page-data-mapping.json` | 4 EXISTING / 4 REUSED / 7 FIXTURE_NEEDED | **MEASURED**, but its `haravan_url` fields use the wrong param | Partially |
| `reports/haravan-store-inventory.json` | 234 products, 35 collections, 1 blog, 10 articles, 6 pages, 2 themes; `/web/link_lists.json` 404 | **MEASURED (live API)** | Yes — safety gate |
| `reports/dual-plane-qa-report.md` | Chromium/renderer IPC isolation | **PARTIAL** | Yes (security) |
| `260904-bao-cao-tham-dinh-…-mcp.md` | architectural critique | **ADVISORY** | No |

---

## 5. T4 — Report phases vs existing plans

| Phase | Coverage |
|---|---|
| 1 Verdict/direction | COVERED (`plans/reports/260911-ultra-brainstorm-…`) |
| 2 Base Theme definition | PARTIAL (`plans/260905-0012-core-pre-freeze-hardening-and-live-proof/`) |
| 3 Three-artifact separation | COVERED (`plans/260908-1223-independent-html-clone-and-fidelity-pipeline/`) |
| 4 Anti-entropy risk | COVERED (`plans/reports/brainstorm-260906-…-clone-failure-…`) |
| 5 20–30 theme corpus | **NEW this session** |
| 6 Five-pillar research matrix | **NEW this session** |
| 7 Source inventory / flat layout | COVERED (`plans/260911-0133-haravan-customize-theme-fidelity/surface-inventory.json`) |
| 8 Admin + visual editor | PARTIAL — input-ID precedence unresolved |
| 9 API capabilities | COVERED (`apps/docs/haravan-api.md`, `haravan-app-base`) |
| 10 API ≠ theme runtime | COVERED |
| 11 Liquid object graph | NEW AS REPO SPEC (skills only) |
| 12 Route map | COVERED **but leaks** Shopify param |
| 13 Handle primitive | COVERED (`packages/site-clone/src/platform/haravan/route-resolver.ts`) |
| 14 Data reuse + reference identity | **NEW / UNIMPLEMENTED** — no identity tuple in Core |
| 15 Semantic data creation | PARTIAL (`entity-resolver.ts` `FixtureRegistry`) |
| 16 Collections architecture | COVERED (35 custom collections; 50-product pagination) |
| 17 Canonical primitives | **NEW this session** |
| 18 Anti-UI-monster boundary | IN DOCTRINE, **VIOLATED IN CODE** (D5) |
| 19 CSS foundation | NEW FOR BASE THEME |
| 20 JS foundation | NEW FOR BASE THEME (4 competing carousel engines) |
| 21 Accessibility baseline | UNMEASURED ASSERTION |
| 22 Acceptance gates | COVERED BY DEFECTIVE CODE (D1/D2) |
| 23 Wiki deliverables | **NEW** — `haravan-wiki/` does not exist |
| 24 Full-page multi-breakpoint verification | COVERED EMPIRICALLY, BYPASSED IN CORE |

---

## 6. Defect register (authoritative — see addendum-04 §6)

D1 unmeasured⇒PASS · D2 hardcoded OS 2.0 string · D3 unsupported 45/45 headline · D4 `sections/` scores Haravan ·
D5 `site-clone` emits Shopify OS 2.0 shape · **D6 `min(fresh, recorded)` mismatch selection** ·
**D7 `null < 2.0` counts as pass** · **D8 source mapper `sections/` lineage weight 2** ·
**D9 wrong preview parameter ⇒ measured the live theme** · **D10 viewport never applied** ·
**D11 canary whitelists `themeid=-1`**.
All eleven are Tier-1 `VERIFIED` with file:line or executed output.

---

## 7. Open questions that change the contract

1. **Does `theme push` of a theme containing `sections/*.liquid` + `templates/index.json` fail, get stripped, or
   silently ignore?** Resolves whether contaminated output must be sanitized. Probe: push `themes/roahtrip-haravan`
   to `1001512581` and read the CLI response, or inspect Admin upload validation.
2. **Does Haravan honour `?themeid=` without an authenticated preview session, and does it also accept
   `?preview_theme_id=` as an alias?** Probe: capture `?themeid=1001512581` and `?preview_theme_id=1001512581`
   on the same route and diff the served HTML for a staging-only marker. **Highest priority — the entire fidelity
   program depends on this answer.**
3. **In the 24 themes with both config files, which wins when setting IDs collide?** Determines hybrid vs
   `settings.html`-only generation.
4. **Can navigation menus be seeded programmatically at all, given `/web/link_lists.json` 404?** Determines whether
   menu fixtures must be pre-configured.
5. **Is `haravan-sync-barrier`'s `DEFAULT_SYNC_PATTERN` locale-safe?** Probe: run the CLI watcher under a
   Vietnamese-locale Windows shell and capture the actual completion line.
