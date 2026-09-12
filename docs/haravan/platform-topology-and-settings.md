# Haravan Platform Topology and Settings Architecture

**Document:** `docs/haravan/platform-topology-and-settings.md`  
**Phase:** 08A — Knowledge Acquisition & Canonical Base Contract  
**Created:** 2026-09-12  
**Authority Hierarchy:** Official Haravan Docs > Real Store Admin > Real Haravan API > Real Haravan CLI > Theme Source Code > Live Storefront Behavior.

---

## 1. Platform Theme Topology

Haravan theme architecture strictly follows the Shopify 1.0 flat directory convention. It does not natively support Shopify Online Store 2.0 (OS 2.0) directory structures such as modular `sections/` or JSON-based route templates (`templates/*.json`).

### Canonical Directory Structure

```text
theme/
├── layout/
│   └── theme.liquid                  # Master HTML shell (contains content_for_header, content_for_layout)
├── templates/
│   ├── index.liquid                  # Homepage template
│   ├── product.liquid                # Product details template
│   ├── collection.liquid             # Collection / catalog listing template
│   ├── blog.liquid                   # Blog listing template
│   ├── article.liquid                # Blog post template
│   ├── page.liquid                   # Static page template
│   ├── cart.liquid                   # Cart template
│   ├── search.liquid                 # Search results template
│   ├── 404.liquid                    # Not found template
│   └── customers[*.liquid]           # Customer account, address, login, order templates
├── snippets/
│   ├── header.liquid                 # Modular site header
│   ├── footer.liquid                 # Modular site footer
│   ├── product-loop.liquid           # Reusable product card
│   └── ...                           # Reusable UI fragments (included via {% include %})
├── assets/
│   ├── styles.css.liquid             # Processed stylesheets
│   ├── scripts.js.liquid             # Theme JavaScript
│   └── ...                           # Fonts, static SVG/PNG graphics
├── config/
│   ├── settings.html                 # Legacy merchant settings admin form (pure HTML)
│   ├── settings_schema.json          # F1GENZ modern visual editor schema definition
│   └── settings_data.json            # Merchant-saved configuration state (key-value store)
└── locales/ (optional)
    ├── vi.json                       # Vietnamese language translations
    └── en.json                       # English language translations
```

### Topology Evidence & Invariant Ledger

| Claim | Evidence Status | Source (Path or URL + Observed Date) | Contradiction | Next Probe |
|---|---|---|---|---|
| Root layout directory is singular `layout/`; plural `layouts/` is invalid. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12); `customizes/*` (30/30 themes use `layout/`). | AntiFan architecture sketch (§28) incorrectly wrote `layouts/`. | None. Platform invariant. |
| Modern Shopify `sections/` directory is not supported by standard Haravan theme runtime. | `VERIFIED` | `customizes/*` (30/30 themes lack `sections/`; 0 hits for `{% schema %}`); `E:/Work/apps/Haravan CLI/src/helper/theme-asset-patterns.ts`. | AntiFan `roahtrip-haravan` theme mistakenly includes `sections/`. | Probe BQ-03: test if `hrv theme push` rejects or strips `sections/`. |
| Storefront route templates must be `.liquid` files; `templates/*.json` causes fatal syntax errors. | `VERIFIED` | `customizes/*` (30/30 themes use flat `.liquid` templates; 0/30 use `.json` templates); `https://themes.haravan.com/pages/cheat-sheet`. | AntiFan site-clone generator mistakenly generated `index.json`. | None. Platform invariant. |
| Customer account templates use bracket notation (e.g. `templates/customers[addresses].liquid`). | `VERIFIED` | `customizes/*` (30/30 themes); `Haravan CLI/src/helper/theme-asset-patterns.ts:45`. | None. Standard Haravan customer template naming convention. | None. |

---

## 2. Settings Architecture & Dual-Mode Conventions

Haravan themes utilize two distinct settings configuration mechanisms to power the Admin theme customizer: legacy `config/settings.html` and modern `config/settings_schema.json`. Both persist merchant values into a common storage file: `config/settings_data.json`.

### A. Legacy Merchant Settings (`config/settings.html`)

Legacy Haravan themes define their settings interface using a pure HTML document rendered in the Haravan Admin iframe.

**Invariants:**
1. **Pure HTML Only:** NO Liquid tags (`{{ }}`, `{% %}`) are permitted inside `settings.html`.
2. **Standard Grouping Structure:** Uses `<fieldset>` and `<legend>` tags to define sections.
3. **Special Dropdown Classes:** Haravan Admin dynamically injects store data into `<select>` tags based on specific class names:
   - `<select class="linklist" name="header_menu_handle"></select>` → Automatically populated with store navigation menus.
   - `<select class="collection" name="home_collection_1"></select>` → Automatically populated with active product collections.
   - `<select class="blog" name="home_blog_handle"></select>` → Automatically populated with active store blogs.
   - `<select class="page" name="footer_page_handle"></select>` → Automatically populated with active static pages.
4. **Image Upload Fields:** Form file inputs specify target assets directly via filename in `name` attribute: `<input type="file" name="logo.png" />`.
5. **Layout Wrapper:** Nested fieldsets must be wrapped in `<div class="ml-5">` because Haravan Admin CSS strips classes applied directly to `<fieldset>`.

### B. Modern F1GENZ Visual Editor (`config/settings_schema.json`)

F1GENZ themes and modern Haravan visual editor themes define their settings schema in structured JSON format.

```json
[
  {
    "name": "Trang chủ - Banner",
    "settings": [
      { "type": "header", "content": "Cấu hình Banner chính" },
      { "type": "checkbox", "id": "home_banner_enable", "label": "Hiển thị banner", "default": true },
      { "type": "text", "id": "home_banner_title", "label": "Tiêu đề banner", "default": "Khuyến mãi mùa hè" },
      { "type": "image_picker", "id": "home_banner_image", "label": "Ảnh banner (1920x600 px)" }
    ]
  }
]
```

**Supported Input Types:**
`header`, `paragraph`, `text`, `textarea`, `checkbox`, `color`, `image_picker`, `select` (with `options`), `radio`, `link_list`, `collection`, `blog`, `page`.

**Key Differences from Shopify OS 2.0 Schema:**
- Does NOT support `{% schema %}` embedded inside Liquid templates or sections.
- Does NOT support dynamic block definitions (`blocks`), presets, or app blocks.
- Top-level structure is an array of section/group objects containing a `settings` array.

---

## 3. F1GENZ Visual Editor Binding Contract

To enable live click-to-edit capabilities in Haravan Admin, rendered storefront HTML elements must declare explicit binding attributes matching the schema definition.

### The Mandatory Two-Attribute Rule

Every setting key declared in `config/settings_schema.json` that represents merchant-visible text or imagery **MUST** be bound in the rendered Liquid markup using **BOTH** attributes:
1. `setting-id="{setting_key}"`
2. `setting-type="{text|textarea|image}"`

Neither attribute is optional. Markup omitting either attribute breaks the Admin visual inspector.

### Binding Examples

#### Text Binding
```liquid
<h2 setting-id="home_banner_title" setting-type="text">
  {{ settings.home_banner_title | escape }}
</h2>
```

#### Textarea Binding
```liquid
<p setting-id="home_banner_description" setting-type="textarea">
  {{ settings.home_banner_description | escape }}
</p>
```

#### Image Binding (`image_picker` in schema maps to `image` in DOM attribute)
```liquid
{%- assign banner_src = settings.home_banner_image -%}
{%- if banner_src == blank -%}
  {%- assign banner_src = 'default-banner.jpg' | asset_url -%}
{%- endif -%}
<img src="{{ banner_src }}" setting-id="home_banner_image" setting-type="image" alt="Banner">
```

#### Dynamic Loop Binding
```liquid
{%- for i in (1..4) -%}
  {%- capture col_title_key -%}home_col_{{ i }}_title{%- endcapture -%}
  <h3 setting-id="{{ col_title_key }}" setting-type="text">
    {{ settings[col_title_key] | escape }}
  </h3>
{%- endfor -%}
```

### Visual Editor Isolation Constraints

The Haravan Admin visual editor injects its own control panel and UI elements directly into the storefront DOM. To prevent theme CSS styles from distorting editor panels, theme stylesheets must observe strict selector scoping:
- **PROHIBITED:** Global body-level form styling: `body input, body select, body textarea { ... }`.
- **REQUIRED:** Component-scoped form styling: `form.contact-form input, .az-theme .site-form select { ... }`.

---

## 4. Corpus Recurrence & Precedence Analysis

Audit of the 30 commercial customer themes under `E:/Work/customizes/`:

| Configuration Archetype | Theme Count | Percentage | Themes |
|---|---|---|---|
| **Dual Mode** (`settings.html` AND `settings_schema.json`) | 24 | 80.0% | `Apshop`, `Bagamuioto`, `CuddlePet`, `Dangvietmart`, `Eiddo`, `FarmerMarket`, `GixJewel`, `GomDatViet`, `Hapas`, `Luxvie`, `Mnbakery`, `Mulgati`, `OwlBrand`, `Phukienmaymoc`, `Reebaby`, `Remolacha`, `Rosemine`, `Seahorse2`, `Starsolution`, `StylekoreanVietNam`, `TestVyan`, `Thietbihoaphat`, `Vyantechnology`, `Zesta` |
| **Legacy Only** (`settings.html` only) | 6 | 20.0% | `Iamhome`, `Kome88`, `SittoVietnam`, `Sunriseplus`, `Toda`, `Tototuantu` |
| **Schema Only** (`settings_schema.json` only) | 0 | 0.0% | None in corpus |

> **Corpus Note:** The 80% coexistence of both files demonstrates that dual-configuration is standard commercial agency practice. However, this count is an observation of historical distribution, not proof that the Haravan Admin strictly requires both files.

### Rule for F1GENZ Themes (corrected 2026-09-12)

The F1GENZ framework declares merchant settings in `config/settings_schema.json` and binds
rendered values with `setting-id` / `setting-type` attributes on storefront markup
(428 corpus files carry `setting-id`, 4324 occurrences).

- **Do not add `settings.html` to an F1GENZ theme whose schema is live.** When
  `settings_schema.json` declares at least one control, that schema is the declaration
  surface and a duplicate legacy form is redundant.
- **A shipped `settings.html` is not by itself a violation.** All 7 themes under
  `themes/f1genz/Haravan/` ship `config/settings.html`, and 6 of them pair it with a
  degenerate schema (`[]` or `[{}]`) that declares nothing, which makes the form the
  operative declaration surface. The linter therefore refuses the form only when the
  paired schema is live (`HARAVAN_SETTINGS_HTML_FORBIDDEN`), and refuses the pair only
  when neither side declares a control (`HARAVAN_SETTINGS_DECLARATIONS_ABSENT`).
- **Presence is not liveness.** `customizes/Phukienmaymoc/config/settings.html` is a
  single HTML comment: 255 569 of its 256 092 bytes sit between `<!--` at line 7 and
  `-->` at line 5320, so none of its 961 control names declares anything. Declaration
  readers strip HTML comments before collecting names.

---

## 5. Settings Claims & Open Probes

| Claim | Evidence Status | Source (Path or URL + Observed Date) | Contradiction | Next Probe |
|---|---|---|---|---|
| `config/settings_data.json` is the sole persistence store for settings values. | `VERIFIED` | `customizes/*` (30/30 themes); `Haravan CLI/src/helper/theme-asset-patterns.ts`. | None. | None. |
| In dual-mode themes, Admin settings editor prioritizes `settings_schema.json` over `settings.html`. | `UNKNOWN` | None. Observed in 24 themes, but execution precedence is undocumented. | Some themes maintain identical keys in both files. | Probe BQ-02: deploy test theme with conflicting default values and inspect Admin editor. |
| Haravan Admin automatically populates `<select class="collection">` options in `settings.html`. | `VERIFIED` | `C:/Users/Admin/.claude/skills/haravan-theme/references/settings-html.md:118` (2026-07-05). | None. Documented admin feature. | None. |
| Liquid template rendering accesses settings values via `settings.{key}` or `settings['{key}']`. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12); `customizes/*`. | None. Core platform object. | None. |
| `settings.html` cannot parse or execute Liquid code. | `VERIFIED` | Haravan Admin Settings Editor Specification (2026-07-05). | None. | None. |
| 24 of 30 commercial customer themes in `customizes/` contain both `settings.html` and `settings_schema.json`. | `OBSERVED` | `E:/Work/customizes` corpus audit (2026-09-12). | None. Factual corpus census. | None. |
| Coexistence of dual settings files reflects agency migration from legacy Haravan admin to F1GENZ visual editor, not a mandatory platform dual-engine requirement. | `DERIVED` | Synthesis of corpus dates and F1GENZ framework architecture (2026-09-12). | None. | Validate against single-schema theme deployment. |
| Haravan Admin visual customizer may completely ignore `settings.html` controls when a valid `settings_schema.json` is parsed. | `INFERRED` | Visual editor UI behavior in F1GENZ themes (2026-09-12). | 24 themes keep both files intact. | Probe BQ-02: modify settings.html only and test if UI reflects changes. |
| AntiFan clone generator emitted Shopify OS 2.0 `templates/index.json` while Haravan platform cheat sheet specifies flat `templates/index.liquid`. | `CONFLICT` | `packages/site-clone/src/generators/` vs `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12). | Defect D5: generator emitted OS 2.0 files unsupported by Haravan. | Phase 05 compiler cutover to flat `.liquid` templates. |
| An F1GENZ theme must not ship `config/settings.html`. | `CORRECTED — FALSE AS STATED` | Glob `E:/Work/themes/f1genz/Haravan/*/config/settings.html` → 7/7 hits; `settings_schema.json` content `[]`/`[{}]` in 6 of them (2026-09-12). | The original rule treated file presence as the violation. Reality: the form is the operative declaration surface whenever the paired schema declares no control, so the refusal is scoped to a live schema. | Keep probing whether the Admin visual editor ignores the form once a live schema exists (BQ-02, unchanged). |
| A shipped `config/settings.html` declares the settings named by its controls. | `CORRECTED — ONLY WHEN LIVE` | `customizes/Phukienmaymoc/config/settings.html`: 256 092 bytes, one comment (line 7 → 5320), 961 `name=` occurrences all inside it, 0 outside (2026-09-12). | The theme's declarations come from its schema, not the inert form. | None. Declaration readers strip HTML comments. |
| `settings['header_logo.png']`-style bracket reads are a corpus idiom, not an edge case. | `OBSERVED` | 155 theme files across `customizes/`, `themes/`, `apps/AntiFan/themes/`, 933 distinct keys (2026-09-12). | The linter matched only `settings.<id>` and saw none of them. | None. The bracket pattern is matched by both settings rules. |
| 10 of the 39 shipped `settings_schema.json` files declare nothing (`[]` or `[{}]`). | `OBSERVED` | 4 under `themes/devs2/` (Healing Touch, Ivory Gem, Lumiere Beauty, NauAtelier) and 6 under `themes/f1genz/Haravan/` (Figure, Fresh, GenZ, Hera Jewelry, PC, Ăn Vặt), 2026-09-12. | Counting the file's presence as "declares settings" overstates schema coverage. | None. File presence and control presence are now reported separately. |
