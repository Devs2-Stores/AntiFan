# Scout Ultra — Evidence Packet (immutable) — Haravan corpus + Admin + Storefront + Skills

Packet id: `scout-ultra-260912-haravan-corpus`
Mission: raise **AntiFan's Haravan platform knowledge** to corpus-verified truth using ~45 real
Haravan projects, the live storefront, the live Admin/CLI surface, and the installed Haravan skill
family. Candidates produce a **complete scout report** from this packet; one verifier then merges the
validated union.

## 0. Hard rules for candidates (non-negotiable)

1. **READ-ONLY.** Never create, edit, delete, move or rename any file. No command that writes:
   no `hrv select|login|logout|init|push|pull|fetch|export|backup|restore|rollback|delete|publish|rename`,
   no git writes, no npm/theme write operations of any kind.
2. **Never touch** `E:/Work/customizes/**` or `E:/Work/themes/**` with anything but reads. The user
   stated explicitly: read only, do not damage these reference projects.
3. Use `read`, `grep`, `glob`. Narrow every `grep` `path` (unscoped grep times out). Read-only `bash`
   counting that prints to stdout is allowed **only if it writes nothing**; if a needed tool is
   unavailable, say so in `unresolved` — never invent numbers.
4. Evidence vocabulary: `OBSERVED` (seen via a tool this session), `VERIFIED` (independently
   re-derived), `DERIVED`, `INFERRED`, `UNKNOWN`, `CONFLICT`. Never upgrade confidence. Cite
   `path`, `file:line`/pattern, and how observed.
5. AntiFan's own prior conclusions are **not** platform truth. If the seed numbers below and your own
   sampling disagree, report `CONFLICT` with both numbers.
6. Haravan only. `themes/f1genz/Sapo/GENZ` is Sapo — cross-platform contrast only, never a Haravan rule.

## 1. Scope (immutable)

Roots: `E:/Work/customizes`, `E:/Work/themes`. 47 dirs hold a theme root (`layout/`, `layouts/`, or
`config/settings.html`); **45 are Haravan**. Excluded: `themes/f1genz/Sapo/GENZ` (`NON_HARAVAN_SAPO`),
`themes/_archive/desktop-extract-2026-07-18/f1genz-themes/F1 Hera Jewelry` (`ARCHIVED_DUPLICATE`).
Families: `customizes/*` 30, `themes/devs2/*` 7, `themes/f1genz/Haravan/*` 7, `themes/ref/Dressly_final_new` 1.
25 176 files total across the 45; 8 102 Liquid/HTML files were regex-scanned.

Machine-readable seed data (read these; audit the regexes in the generator before trusting counts):
- `plans/reports/_corpus-atlas-raw-45.json` — per-theme dir counts, markers, file counts
- `plans/reports/_corpus-prevalence-raw.json` — per probe total + themes-that-use-it + `perTheme`
- `plans/reports/_corpus-prevalence.mjs` — the generator (regex definitions)

### 1a. Non-theme knowledge sources that must also be scouted

- `E:/Work/themes/docs/**` — `haravan.md`, `decisions.md`, `deploy.md`, `shared-update.md`,
  `base-sources.md`, `rules/{css-formatting-rules,haravan-content-page-rules,haravan-liquid-rules,html-attribute-rules,image-size-rules,README}.md`
- `E:/Work/themes/bugs/{chung.md (16 KB),f1genz.md (8 KB),devs2.md}` — field bug knowledge bases
- `E:/Work/themes/prompts/{audit-bugs.md,audit-workspace.md}`
- `E:/Work/themes/_archive/desktop-extract-2026-07-18/**` — `restyle/HARAVAN_THEME_RESTYLE_WORKFLOW.desktop-full.md`
  (36 KB), `devs2-workflow-core/*`, `f1genz-demo/HARAVAN_DEMO_WORKFLOW.md`, `EXTRACT.md`
- `E:/Work/customizes/_backup_index_consolidate/index-section-{1,2,3,4,6,7,8,9}.liquid`,
  `_templates/**`, `_done/README.md`
- Un-extracted archives readable via the `read` archive selector (e.g. `foo.zip:config/settings.html`):
  `E:/Work/themes/f1genz/Haravan/Aqua/*.zip` (5 archives), `.../Hera Jewelry/Hera Jewelry-27_05_2026.zip`,
  plus static demos `.../{Figure,Fresh}/*.{html,css,js}` and `.../Ăn Vặt/*.png|txt|json`

### 1b. AntiFan artifacts the findings must be mapped onto

- `docs/haravan/*.md` (9-file wiki incl. `api-capabilities-and-scopes.md`)
- `specs/base-theme-contract.json` (canonical base-theme contract)
- `scripts/lib/theme-checks.mjs`, `scripts/lint-haravan-theme.mjs` (theme linter)
- `themes/universal-haravan-base/**`, `themes/phukienmaymoc-copy/**` (bound to theme `1001512581`)
- `packages/site-clone/src/generators/**`
- `E:/Work/apps/Haravan CLI/src/**` (`live-ops-service.ts` write gate, `theme-console.ts` filter set)
- Skill family `C:/Users/Admin/.claude/skills/haravan*/**` (15 skills, listed in §2e)

## 2. Seed evidence (OBSERVED by the controller; verify by sampling)

### 2a. Architecture markers, 45 Haravan themes

| marker | value |
| --- | --- |
| `config/settings.html` | 45 / 45 |
| `config/settings_schema.json` | 39 / 45 |
| `config/settings_data.json` | 45 / 45 |
| `sections/` dir | **0 / 45** |
| JSON templates `templates/*.json` | **0 / 45** |
| `layout/` dir | 45 / 45 (`layouts/` 0 / 45) |
| `layout/` with >1 file | 4 / 45 |
| `locales/` dir | 12 / 45 |
| `templates/` files | 28–106 (avg ≈49) |
| `snippets/` files | 38–176 (avg ≈76) |

`settings_schema.json` absent: `customizes/{Iamhome,Kome88,SittoVietnam,Sunriseplus,Toda,Tototuantu}`.
Largest: `customizes/Mnbakery` 3804 files, `customizes/Toda` 1204, `themes/devs2/NauAtelier` 1037,
`customizes/Kome88` 1020, `customizes/Iamhome` 1000.

### 2b. Prevalence (themes-with-≥1-usage / total occurrences)

Tags: `assign` 45/32030, `capture` 45/10423, `include` 45/8783, `layout` 45/1017, `form` 45/847,
`paginate` 45/647, `comment` 44/2896, `cycle` 32/93, `raw` 8/81.
**Zero in all 45:** `render`, `section`, `schema`, `tablerow`, `liquid`, `increment`, `echo`.

Filters: `escape` 45/13994, `asset_url` 45/9159, `split` 45/3722, `append` 45/3675,
`strip_html` 45/3323, `money` 45/3028, `img_url` 45/1577, `json` 45/1066, `date` 45/1026,
`handleize` 45/717, `default_errors` 45/398, `join` 45/341, `product_img_url` 44/2876,
`truncate` 40/164, `link_to` 34/214, `t` 32/3393, `script_tag` 28/252, `uniq` 26/71,
`newline_to_br` 25/366, `stylesheet_tag` 24/231, `link_to_vendor` 24/163, `sort` 22/38,
`slice` 17/67, `prepend` 14/49, `map` 11/25, `link_to_type` 7/14, `default_pagination` 4/10,
`money_with_currency` 2/4, `file_url` 2/2. Nearly absent: `image_url` 1/1, `reject` 1/1.
**Zero:** `where`, `concat`, `reverse`, `url_escape`, `weight_with_unit`, `highlight`, `placeholder_svg_tag`.

Objects: `settings.*` 45/51162, `product.variants` 45/6488, `shop.*` 45/5667, `form.*` 45/5022,
`product.images` 45/3521, `forloop.*` 45/3255, `images.*` 45/2738, `customer.*` 45/2457,
`product.featured_image` 45/2247, `product.available` 45/1600, `paginate.*` 45/1533,
`line_item.*` 45/1343, `product.description` 45/1333, `product.price` 45/901,
`collection.products` 45/791, `current_page` 45/762, `current_tags` 45/563, `collections.*` 45/532,
`cart.total_price` 45/532, `canonical_url` 45/381, `cart.items` 45/329, `blog.articles` 45/287,
`content_for_header` 45/106, `product.vendor` 41/603, `first_available_variant` 40/698,
`articles.*` 40/142, `product.tags` 37/693, `article.excerpt` 37/150, `template.*` 34/261,
`product.compare_at_price` 33/396, `selected_or_first_available_variant` 28/481, `discount.*` 28/266,
`checkout.*` 28/79, `blogs.*` 27/117, `product.media` 22/350, `linklists.*` 10/19, `routes.*` 8/43,
`pages.*` 4/45, `all_products` 2/18, `content_for_index` 1/1.
**Zero:** `collection.all_products`, `localization.*`.

CDN hosts: `hstatic.net` 45/4932, `file.hstatic.net` 45/1628, `theme.hstatic.net` 44/1252,
`haravan.com` 37/1169, `product.hstatic.net` 36/304.

### 2c. Storefront (live, read-only, 2026-09-12)

- Store `phukienmaymoc.com`, org `200001207485`. Themes: `1001512581` `unpublished` (only writable
  target), `1001510509` `main` (protected).
- Deployed home measured with headless Chrome/CDP at 390/768/1440 on
  `https://phukienmaymoc.com/?themeid=1001512581`: horizontal overflow **none**; document heights
  4700 / 7244 / 9012; 111 `<img>`, 106–107 loaded, 0 broken; 12 `<section>` in order
  `slide, category-list, banner-category, block-category ×5, home-form, accessory, news, partner`.
- Deployed `news` renders nearly empty (height 125/128/128, text 46 chars, **0 images**, 1 link).
- Harness `plans/reports/_capture-local-render.mjs`; raw `plans/reports/home-render/live-summary.json`;
  prior addenda `plans/reports/evidence-addon-1{0,1,2,3}-*`, `haravan-project-route-manifest.json`.

### 2d. Admin surface (live, read-only)

- Haravan CLI (`E:/Work/apps/Haravan CLI`) is **theme-scoped only**: `info, whoiam, open, login,
  logout, select, refresh, backup, restore, rollback, diff, doctor, assets, theme {list,info,fetch,
  pull,export,push,lint,console,dev,delete,publish,rename,retry}`. No product/order/collection/
  customer command exists anywhere in `src/commands`.
- `hrv whoiam` lists **17 orgs** (multi-store keychain) incl. target `200001207485 Phukienmaymoc`.
  Only the target org enumerated: `theme list --json` → the 2 themes above. The other 16 orgs each
  returned `Lỗi xảy ra. Vui lòng thử lại!` (cause UNKNOWN — credentials or entitlement suspected).
- `hrv select <org_id>` writes project-local state; no candidate may run it.
- Recorded API facts (`docs/haravan/api-capabilities-and-scopes.md`): no menu/link_list resource
  (`/web/link_lists.json` → 404). CLI filter/context reference for local rendering:
  `E:/Work/apps/Haravan CLI/src/commands/theme-console.ts`.

### 2e. Installed Haravan skill family (15 dirs under `C:/Users/Admin/.claude/skills/`)

`haravan` (evals + SKILL.md), `haravan-accessibility`, `haravan-app`, `haravan-app-feasibility`,
`haravan-audit` (+`scripts/haravan_preflight.py`), `haravan-demo-kit`, `haravan-pages`,
`haravan-performance`, `haravan-preview-screenshot` (+3 scripts), `haravan-product-recommend`,
`haravan-settings`, `haravan-settings-schema` (+`scripts/audit-settings-schema.mjs`),
`haravan-stitch-full-run` (17 files), `haravan-theme` (+4 references), `haravan-upload-file` (+script).

## 3. Targets — every candidate answers ALL five axes

**T1 — Corpus architecture laws.** From §2a/§2b plus your own sampling: what architecture does a real
Haravan theme have (dirs, declaration files, template inventory, page-type coverage), what is
structurally impossible in the corpus (OS 2.0 `sections/`, JSON templates, `{% render %}`), and how
the 4 families (`customizes`, `devs2`, `f1genz/Haravan`, `ref/Dressly`) differ. Name the exact files
proving each law. Sample ≥6 themes spanning ≥3 families and re-derive at least one number yourself.

**T2 — Platform idioms with `path:line` evidence.** For each family below give ≥2 concrete examples
(prefer 3, spanning families) plus corpus prevalence: card markup via `{% include %}`; `paginate` +
`paginate.*`; `| product_img_url` / `| img_url` size arguments; CDN host construction
(`file.hstatic.net`, `theme.hstatic.net`, `product.hstatic.net`); `| t` translation idiom;
`default_errors` form-error idiom; `{% cycle %}`; `{% layout %}` variants; `content_for_header`;
`settings.*` key families; `{% raw %}`; cart `line_item` + `{% form %}` idioms. Prefer idioms a
linter or base theme could enforce, and say exactly how you would detect each one.

**T3 — Admin truth.** What the Admin/CLI surface really supports for theme work: file taxonomy,
settings model (`settings.html` + `settings_schema.json` + `settings_data.json`), roles
`main`/`unpublished`, previewability, org/keychain model, and what fails how. Reconcile against
`E:/Work/apps/Haravan CLI/src/**` and `docs/haravan/api-capabilities-and-scopes.md`. Mark every
endpoint/command you did not actually observe as `INFERRED`/`UNKNOWN`.

**T4 — Storefront truth.** From §2c and the addenda: deployed-revision section inventory, per-section
geometry at 390/768/1440, the broken `news` section, CDN/asset pipeline observed in network terms,
`?themeid=` preview mechanics, route/sitemap inventory, 404 behavior, lazy-loading behavior. Keep
**deployed-revision facts strictly separate from local-revision facts**; state which revision each
measurement describes.

**T5 — AntiFan gap list (the deliverable that matters).** For every artifact in §1b, state what the
corpus / Admin / Storefront evidence says is **wrong, missing, or over-restrictive**, with:
`artifactPath`, `gap`, `evidence` (paths + numbers), `proposedChange` (concrete, minimal),
`risk`, `confidence`. Include `skillContradictions`: claims in the 15 Haravan skills that the corpus
or live surfaces contradict (quote the skill line + the counter-evidence). Also mine
`E:/Work/themes/bugs/*.md` and `E:/Work/themes/docs/rules/*.md` for rules that AntiFan's linter does
**not** yet enforce, and for rules that contradict the corpus.

## 4. Rubric (the verifier scores candidates on exactly this)

1. **Coverage** — all five axes answered; ≥6 themes sampled across ≥3 families for T1/T2.
2. **Evidence quality** — every claim carries `path` + `file:line`/pattern + observed-vs-derived;
   numbers re-derived where feasible; no unverifiable assertions.
3. **Signal density** — findings a change could act on; no restatement of this packet, no filler.
4. **Honesty** — `UNKNOWN`/`CONFLICT` declared; no invented file paths, counts, or lines; seed
   discrepancies surfaced rather than smoothed over.

## 5. Output contract (return ONLY this JSON object)

```json
{
  "candidate": "<self-assigned id>",
  "coverage": { "T1": "complete|partial|missing", "T2": "...", "T3": "...", "T4": "...", "T5": "..." },
  "findings": [
    { "id": "F1", "axis": "T1", "claim": "...", "evidence": [{ "path": "...", "locator": "file:line|pattern", "note": "..." }],
      "confidence": "OBSERVED|VERIFIED|DERIVED|INFERRED|UNKNOWN|CONFLICT" }
  ],
  "familyClusters": [{ "family": "...", "signature": "...", "members": ["..."], "evidence": ["..."] }],
  "idioms": [{ "idiom": "...", "prevalence": "n/45", "examples": ["path:line"], "detector": "regex or check idea" }],
  "adminFacts": [{ "fact": "...", "evidence": ["..."], "confidence": "..." }],
  "storefrontFacts": [{ "fact": "...", "revision": "deployed|local", "evidence": ["..."], "confidence": "..." }],
  "antiFanGaps": [{ "artifactPath": "...", "gap": "...", "evidence": ["..."], "proposedChange": "...", "risk": "...", "confidence": "..." }],
  "skillContradictions": [{ "skillPath": "...", "claim": "...", "reality": "...", "evidence": ["..."] }],
  "unresolved": ["..."]
}
```

Keep totals bounded: ≤40 findings, ≤30 gaps, ≤15 contradictions. Prefer fewer, harder claims.

Packet ends here. Candidate id: assign yourself `cand-1` … `cand-5` as instructed by the dispatcher.
