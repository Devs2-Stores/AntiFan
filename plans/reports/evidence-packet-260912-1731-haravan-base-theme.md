# EVIDENCE PACKET — Haravan Platform Knowledge → Universal Base Theme → AntiFan Core

**Packet ID:** `EP-260912-1731`
**Immutable.** Every candidate receives this exact content. Candidates MUST NOT write files,
MUST NOT read another candidate's output, MUST NOT mutate session/plan state.
**Rule:** a candidate may add findings; it may NOT contradict a Tier-1 fact below without
citing a file:line it actually read.

---

## 1. TASK (verbatim user directive, condensed)

1. `--ultra` — deep analysis of `E:\Download\AntiFan — Final Haravan Platform Knowledge + Universal Base Theme Report.md`
   (1376 lines, 44 sections + FINAL VERDICT).
2. `/skill:ak:scout --ultra` over `E:\Work\customizes`, `E:\Work\apps`, `E:\Work\test-theme`.
3. Spawn subagents freely; a single chat session; 100% accuracy required.

Attached master program (user-supplied) fixes these constraints:

- **Platform: Haravan only.** Shopify assumptions forbidden. Unknown → `UNKNOWN`; contradiction → `CONFLICT`.
- Standalone HTML clone must stay framework-free (HTML/CSS/JS, no Liquid/API dependency).
- Haravan platform truth precedence: official docs > real Admin > real API > real CLI > theme source > real storefront.
  An AntiFan README or a single theme implementation is NOT platform truth.
- Data: check existing Haravan data first → reuse; create minimum semantic demo data only if missing.
- Safety: writes only to dev store / theme copy / unpublished theme / safe preview. Never publish, never touch live theme.
- Evidence vocabulary for every finding: `OBSERVED | VERIFIED | DERIVED | INFERRED | UNKNOWN | CONFLICT`.
- Verification: full-page scroll, all breakpoints (390/768/1440), no top-viewport PASS standing in for the page.
- Report must end in `FINAL PASS` / `FAIL` / `INCONCLUSIVE`, never bare "report done".

## 2. ACCEPTANCE CRITERIA (report Phase 22 / 23)

Required gates, each independently PASS/FAIL/INCONCLUSIVE:
`Platform, Routes, Liquid, Schema, Settings, Assets, Data, Responsive, Visual, Full-page,
Interactions, Reference ID, Clean Code, Safety`.

Required outputs (report Phase 23): `haravan-wiki/` with `capability-matrix.md`, `route-map.md`,
`data-map.md`, `canonical-patterns.md`, `base-theme-contract.md`, `base-theme-readiness.md`,
`storefront-verification.md`, `antifan-core-improvement.md`, plus `evidence/source-01..30.md`.

## 3. TIER-1 FACTS (controller-verified this session, with provenance)

### 3.1 Haravan theme corpus — `E:\Work\customizes` (**30** real themes + 6 non-theme entries)

> **CORRECTION applied after candidate dispatch (identical to all five candidates).**
> The count is **30**, not 31. A report with 30 theme rows is CORRECT; do not invent a 31st row.
> Non-theme entries: `New folder`, `README.md`, `_backup_index_consolidate`, `_backup_poster`, `_done`, `_templates`.

Directory convention observed: `layout/` (singular), `templates/`, `snippets/`, `assets/`, `config/`.
Shopify's `layouts/` never appears. `sections/` appears only in `E:\Work\apps\AntiFan\themes\roahtrip-haravan`.

| Job | layout | templates | snippets | assets | config | locales |
|---|---|---|---|---|---|---|
| Apshop | 1 | 104 | 106 | 315 | 3 | – |
| Bagamuioto | 1 | 53 | 104 | 308 | 3 | – |
| CuddlePet | 1 | 50 | 77 | 221 | 3 | – |
| Dangvietmart | 1 | 47 | 77 | 258 | 3 | 1 |
| Eiddo | 1 | 47 | 97 | 39 | 3 | 1 |
| FarmerMarket | 1 | 46 | 75 | 304 | 3 | 1 |
| GixJewel | 1 | 44 | 47 | 99 | 3 | 1 |
| GomDatViet | 1 | 43 | 65 | 314 | 3 | 6 |
| Hapas | 1 | 60 | 72 | 215 | 3 | – |
| Iamhome | 1 | 46 | 118 | 367 | 3 | – |
| Kome88 | 1 | 45 | 109 | 313 | 2 | – |
| Luxvie | 1 | 47 | 98 | 104 | 3 | 1 |
| Mnbakery | 1 | 52 | 102 | 345 | 3 | – |
| Mulgati | 1 | 54 | 101 | 387 | 3 | 1 |
| OwlBrand | 1 | 84 | 176 | 310 | 3 | 1 |
| Phukienmaymoc | 1 | 57 | 121 | 338 | 3 | – |
| Reebaby | 1 | 49 | 76 | 211 | 3 | – |
| Remolacha | 1 | 41 | 38 | 81 | 3 | 2 |
| Rosemine | 1 | 42 | 77 | 185 | 3 | – |
| Seahorse2 | 1 | 55 | 52 | 160 | 4 | 1 |
| SittoVietnam | 2 | 106 | 129 | 497 | 2 | – |
| Starsolution | 1 | 47 | 111 | 107 | 3 | 1 |
| StylekoreanVietNam | 1 | 52 | 94 | 281 | 3 | – |
| Sunriseplus | 1 | 28 | 40 | 236 | 2 | 0 |
| TestVyan | 1 | 33 | 70 | 211 | 3 | – |
| Thietbihoaphat | 2 | 40 | 50 | 133 | 3 | 1 |
| Toda | 2 | 106 | 130 | 661 | 2 | – |
| Tototuantu | 4 | 75 | 140 | 252 | 2 | – |
| Vyantechnology | 1 | 33 | 70 | 248 | 3 | – |
| Zesta | 1 | 44 | 70 | 229 | 3 | – |

`.workspace-context.json` present in **26/30 themes** plus `_templates` (27 files total).
The 4 themes without one: `Bagamuioto`, `Reebaby`, `TestVyan`, `Thietbihoaphat`.
All present ones declare `platform: haravan`, `kind: theme`, `role: customize-intake`, `layout: flat`.
`verification: verified` in **24**; `needsVerification` in **2** (`Dangvietmart`, `GomDatViet`) — the
third `needsVerification` file belongs to `_templates`, not a theme. `Seahorse2` additionally declares `branch: f1genz`.

### 3.2 Haravan identity / store evidence

- `E:\Work\apps\AntiFan\.haravan-cli_local.json` → `{"org_id":"200001207485","theme_id":"","theme_name":""}`.
- `E:\Work\apps\AntiFan\reports\haravan-store-inventory.json` (read this session):
  store `phukienmaymoc.com`, `org_id 200001207485`, inventory date `2026-09-12`.
  - Safe target: theme `1001512581` — "Bản sao chép của clothing", role `unpublished`,
    described as "Hoplongtech clone staging theme copy (SAFE TO TEST & MODIFY)".
  - Protected: theme `1001510509` — "Phụ Kiện Máy Móc New Version", role `main`,
    `status: PROTECTED_NEVER_TOUCH`.
  - Counts: `products 234, custom_collections 35, smart_collections 0, pages 6, blogs 1,
    articles 10, menus 3, themes 2`.
  - Recorded API limitation: `REST endpoint /web/link_lists.json returned 404 (Omni API limitation)`.
- Theme copies on disk: `AntiFan/themes/phukienmaymoc-copy` (Haravan 1.0 shape — `config/settings.html`
  AND `config/settings_schema.json` both present; templates include `customers[order].liquid`,
  `customers[addresses].liquid`, `collection.index-tab-2.liquid`, `index.header-load-menu.liquid`,
  `cart.json.liquid`) and `AntiFan/themes/roahtrip-haravan` (only 6 templates, has `sections/`,
  `locales/`, `index.json`).

### 3.3 AntiFan Core verification defect — CONFIRMED at source level

`E:\Work\apps\AntiFan\src\main\qa\theme-qa-workflow.ts` — `computeQaMatrix()`:

- L727/L731/L735: an **unmeasured** viewport becomes `{ mismatchPercent: null, passed: true, measured: false }`.
- L737–739: unmeasured desktop ⇒ `visualScore = 100`.
- L741–745: unmeasured tablet+mobile ⇒ `responsiveScore = 100`.
- L749: `const haravanScore = checklist.liquidClean !== false ? 100 : 40;` — Haravan compliance derives
  from ONE boolean, not from route/Liquid/object/schema evidence.
- L763: hardcoded claim string — `haravanCompliance: { …, details: 'Haravan OS 2.0 sections, schema presets, and Liquid templates' }`.
  **This is factually wrong for Haravan** and contradicts the loaded Haravan baseline
  ("Never apply Shopify OS 2.0 patterns: no JSON templates, `{% schema %}`, blocks, presets, app blocks").
- L753/L762/L764/L772: `details` strings are static assertions ("Semantic tags and clean tree structure
  validated", "No render-blocking scripts, clean lazy loading") emitted regardless of measurement.
- L780–784: `overallScore` averages ONLY measured dimensions ⇒ unmeasured dimensions inflate the mean by exclusion.
- L788–792: `passed` gates only on measured viewports ⇒ `passed: true` is reachable with nothing measured.
- L700–706: the workflow WRITES `specs/qa-matrix.json` into the target workspace root.

**Provenance chain confirmed:** `E:\Work\test-theme\specs\qa-matrix.json` is exactly that artifact:
`overallScore: 98, passed: true`, `haravanCompliance.score: 100` with details
"Haravan OS 2.0 sections, schema presets, and Liquid templates", and all three viewports
`{mismatchPercent: null, passed: true, measured: false}`.
`visualFidelity.details` = "Visual diff unmeasured (no baseline comparison supplied)";
`responsiveParity.details` = "Responsive viewports unmeasured (no baseline comparison supplied)".

### 3.4 Reference-identity gate (report Phase 14) — NOT IMPLEMENTED

`grep -rn 'referenceHash|captureHash|reference_hash' --include=*.ts src` → **0 hits** in AntiFan Core.
No store/theme/route/viewport/reference-hash/capture-hash record exists to key a visual comparison.

### 3.5 Platform-leakage scan

- AntiFan: `OS 2.0` / `preview_theme_id` hits in `src/main/qa/theme-qa-workflow.ts` (above),
  `.canary/tools/theme-fidelity-run.mjs`, `.compiled/scripts/probes/sapo-boundary-probe.js`,
  `.cursor/rules/theme-rules.md`, `ANTIFAN_IMPROVEMENTS.md`.
- Corpus: Shopify/OS-2 leftovers found in only `Apshop` (3 files) and `Dangvietmart` (1 file) —
  i.e. the 31-theme corpus is substantially Haravan-native.

### 3.6 Haravan platform facts already verified by the loaded Haravan skill family

`C:\Users\Admin\.claude\skills\haravan-app\references\platform-facts.md` (captured 2026-07-05 from official docs):

- API surfaces: Haraweb `https://apis.haravan.com/web` (scope `web.*`) vs Commerce `https://apis.haravan.com/com`
  (scope `com.*`); Ajax API is an unauthenticated lightweight theme surface, NOT Omni API.
- App types: public OAuth (multi-store, App SDK, extensions) vs private Bearer (single store only, no SDK/extensions).
  Session tokens are 1-minute and cannot call Omni APIs.
- Rate limits: leaky bucket 80 / 4 req·s⁻¹, HTTP 429, `X-Haravan-Api-Call-Limit`, `Retry-After`.
- Webhooks: scope `wh_api`, HTTPS only, `X-Haravan-Hmacsha256` over raw body, 200 within 5 s,
  19 retries / 48 h then auto-delete; non-200 (incl. 3XX) counts as failure.
- Events API is delayed, not realtime. Inventory-adjustment batch size is a 100-vs-200 **source discrepancy**.
- Theme boundary: `collection.products` max 50/page (use paginate); `collection.all_tags` max 1,000;
  Haravan Liquid has no `reject`/`compact`/`where`/`concat`/`at_most`/`at_least`/`image_url`/`render`/`{% schema %}`.

`haravan-theme/references/liquid-cheatsheet.md` adds verified object details used for a route/data map:
`blog.articles_count` (NOT `blog.articles.size`) is the trustworthy total; `routes.*` usable with `default:`
fallbacks; `product.media` confirmed on some projects only; `img_url` preset ladder
`pico…2048x2048` (avoid `master`).

### 3.7 Skill-system state

Loaded this session: `haravan` (router), `haravan-theme`, `haravan-settings-schema`, `haravan-settings`,
`haravan-audit`, `haravan-performance`, `haravan-accessibility`, `haravan-app`, `haravan-demo-kit`,
`haravan-stitch-full-run`, `haravan-preview-screenshot`, `haravan-upload-file`,
`haravan-product-recommend`, `theme-qa-az`, `f1genz-review`, `f1genz-header-desktop-menu`,
`haravan-pages` (retired), `haravan-app-feasibility` (ghost), plus shared references
`haravan-baseline.md`, `haravan-theme-operating-contract-addendum.md`, `local-skill-routing.md`
and the deep `haravan-theme/references/*`, `haravan-app/references/platform-facts.md`,
`haravan-settings-schema/references/schema-and-editor-contract.md`.
`antifan-theme` has **no SKILL.md on disk** — it is runtime-injected only.

### 3.8 Credential-surface scan (safety clearance)

138 `.env*` / `.haravan-cli*` / `.hrv*` / `auth_authz` files scanned across the three roots.
`_local.json` holds only `org_id/theme_id/theme_name/theme_org_id`. `_remote.json` is a **file manifest**
(its keys are theme paths such as `templates/customers[reset_password].liquid`).
**No secret values found.** Candidates must still never print token-like values.

## 4. SCOUT TARGETS AND BOUNDARIES

| ID | Root | Scope | Required output |
|---|---|---|---|
| T1 | `E:\Work\customizes` | **30** themes, flat layout | Per-theme fingerprint: settings source (`settings.html` vs `settings_schema.json` vs both), template families present, recurrent section/snippet patterns, slider library, CSS/JS asset convention, platform-leak files. Then: which primitives recur across ≥5 themes (canonical candidates) and which are theme-specific. |
| T2 | `E:\Work\apps` | AntiFan, Haravan CLI, haravan-app-base, F1GENZ apps, docs | AntiFan: which Core modules already implement route/data/verification behavior. Haravan CLI: actual commands + theme lifecycle + safety guards (read `src/commands`, `src/services`, `package.json`). `haravan-app-base`: reusable app scaffold. `apps/docs/haravan-api.md`: API claims. |
| T3 | `E:\Work\test-theme` + `AntiFan/reports/*` | specs + evidence artifacts | Provenance and measurement honesty of every QA/verification artifact: does it record measurement, or does it assert PASS? Which artifacts are derivable to a real gate? |
| T4 | `E:\Work\apps\AntiFan\plans` | plan history | Which of the report's 24 phases are already covered by an existing plan/report, and which are genuinely new. |

**Non-goals for scouting:** no fixing, no file writes, no CLI/theme remote commands, no publish,
no data creation, no design judgement beyond what the corpus shows.

## 5. RUBRIC (verifier scores 1–20 per criterion)

1. **Coverage** — all four targets actually touched; per-theme/per-module rows present, not sampled.
2. **Evidence quality** — every claim carries a real path (and line where relevant); no invented paths.
3. **Signal density** — findings that change a decision (recurrence counts, contradictions, gaps), not file listings.
4. **Honesty about gaps** — explicit `UNKNOWN`/unread scope instead of plausible filler.
5. **Decision utility** — states which canonical primitives / Core gaps / artifacts the Base Theme program can act on.
