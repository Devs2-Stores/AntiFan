# Haravan Liquid Objects, Filters, and Tags Graph

**Document:** `docs/haravan/liquid-objects-filters-tags.md`  
**Phase:** 08A — Knowledge Acquisition & Canonical Base Contract  
**Created:** 2026-09-12  
**Authority Hierarchy:** Official Haravan Docs > Real Store Admin > Real Haravan API > Real Haravan CLI > Theme Source Code > Live Storefront Behavior.

---

## 1. Verified Liquid Runtime Overview

Haravan runs an execution engine based on DotLiquid / Shopify Liquid 1.0 specifications. While syntax and basic constructs (`for`, `if`, `assign`, `capture`, `include`) mirror Shopify, Haravan does **NOT** support modern Shopify Online Store 2.0 tags (`render`, `schema`, `sections`) or modern Liquid filters (`image_url`, `where`, `reject`, `concat`).

---

## 2. Global and Resource Object Graph

```text
Liquid Runtime Root
├── shop                          # Store metadata: name, domain, email, currency, money_format
├── cart                          # Shopping cart: item_count, total_price, items, note
│   └── line_item                 # Official cart item object (NOT "cart_item")
├── product                       # Product details: title, handle, variants, media, images
│   ├── variant                   # Product SKU/variant: id, title, price, available, options
│   └── media / image             # Product media asset: src, preview_image, media_type
├── collection                    # Category listing: title, handle, products (paginated max 50)
├── blog                          # Blog container: title, handle, articles_count, all_tags
│   └── article                   # Blog post: title, handle, content, excerpt, author, tags
├── page                          # Static page: title, handle, content
├── customer                      # Authenticated customer: id, email, first_name, orders, addresses
├── linklists                     # Store navigation menus: accessed by handle
├── search                        # Search query state: terms, performed, results, results_count
├── settings                      # Theme configuration key-value pairs (from settings_data.json)
├── template                      # Current route template name (e.g. 'index', 'product')
├── page_title                    # Computed document title string
├── page_description              # Computed document meta-description string
├── canonical_url                 # Canonical URL for SEO
├── content_for_header            # Mandatory platform-injected head assets and tracking scripts
└── content_for_layout            # Mandatory platform-injected route template markup
```

### Product & Variant Resolution

Haravan resolves product options and availability through the `product` and `variant` objects.

```liquid
{%- assign current_variant = product.selected_or_first_available_variant | default: product.variants.first -%}
```

**Variant Resolution Invariants:**
- `product.selected_or_first_available_variant`: Resolves the variant matching the active `?variant={id}` query parameter. If no variant parameter is present or valid, it falls back to the first available variant.
- `product.first_available_variant`: Resolves the first variant with `available == true`, **completely ignoring** the `?variant=` query parameter. Direct use of `first_available_variant` breaks direct variant linking.
- `product.media` vs `product.images`: Haravan officially documents `product.media` (supporting `media.media_type`, `media.preview_image.src`, external videos). However, legacy Haravan stores only populate `product.images`. The Universal Base Theme must use `product.media` when available, but preserve a mandatory fallback to `product.images` and `product.featured_image`.

### Blog & Article Count Invariant

- `blog.articles_count`: **Trustworthy total.** Returns the total number of published, visible articles in the blog across all pages.
- `blog.articles.size`: **Context-dependent slice.** Returns only the number of articles present in the current pagination window or memory slice. Using `.size` for total counts produces incorrect pagination.

### Line Item Object Naming

- Official Object Name: **`line_item`** (e.g. `cart.items` returns an array of `line_item` objects).
- Prohibited Names: `cart_item`, `item_cart` (platform-documented). The linter
  (`PROHIBITED_CART_ITEM_NAMES` in `scripts/lib/theme-checks.mjs`) additionally refuses
  `cart_line_item`, the cart-prefixed invention of the same shape. Corpus occurrence of all
  three across 8252 files: 0.
- Loop Variable: free. `for item in cart.items` (215 corpus occurrences) is as valid as
  `for line_item in cart.items` (7); the rule governs the object name, not the author's variable.

---

## 3. Filter Compatibility & Platform Support

### Supported Filters (Standard Haravan Liquid)

| Filter Category | Supported Filters | Syntax Example |
|---|---|---|
| **String Filters** | `append`, `prepend`, `capitalize`, `downcase`, `upcase`, `escape`, `handleize`, `md5`, `newline_to_br`, `pluralize`, `remove`, `remove_first`, `replace`, `replace_first`, `size`, `slice`, `split`, `strip`, `lstrip`, `strip_html`, `strip_newlines`, `truncate`, `truncatewords`, `url_escape`, `url_param_escape` | `{{ product.title \| escape }}`<br>`{{ 'ao-thun' \| handleize }}` |
| **Math Filters** | `plus`, `minus`, `times`, `divided_by`, `modulo`, `round`, `ceil`, `floor` | `{{ product.price \| divided_by: 100 }}` |
| **Array Filters** | `first`, `last`, `join`, `map`, `size`, `sort`, `uniq` | `{{ product.tags \| join: ', ' }}` |
| **Money Filters** | `money`, `money_with_currency`, `money_without_currency` | `{{ product.price \| money }}` |
| **Asset & URL Filters** | `asset_url`, `global_asset_url`, `haravan_asset_url`, `file_url`, `img_url`, `product_img_url` | `{{ 'styles.css' \| asset_url }}`<br>`{{ image \| img_url: 'large' }}` |
| **HTML Tag Filters** | `img_tag`, `script_tag`, `stylesheet_tag` | `{{ 'theme.js' \| asset_url \| script_tag }}` |
| **Link Filters** | `link_to`, `link_to_vendor`, `link_to_type`, `link_to_tag`, `sort_by`, `within` | `{{ product.url \| within: collection }}` |
| **Utility Filters** | `date`, `default`, `default_errors`, `json`, `weight_with_unit` | `{{ current_variant \| json }}` |

### Image Size Ladder (`img_url` and `product_img_url`)

Haravan uses fixed named dimension presets. Arbitrary dimension strings (e.g. `| image_url: width: 500`) are **NOT supported**.

| Preset Name | Dimensions | Recommended Use Case |
|---|---|---|
| `pico` | 16 × 16 px | Favicons, tiny swatch indicators |
| `icon` | 32 × 32 px | Small icons, badge thumbnails |
| `thumb` | 50 × 50 px | Mini-cart thumbnails, comment avatars |
| `small` | 100 × 100 px | Cart item previews, search dropdown results |
| `compact` | 160 × 160 px | Compact product cards, mobile grids |
| `medium` | 240 × 240 px | Standard mobile product cards |
| `large` | 480 × 480 px | Standard desktop product cards (default) |
| `grande` | 600 × 600 px | Featured collections, secondary gallery zoom |
| `1024x1024` | 1024 × 1024 px | Primary product detail view, banners |
| `2048x2048` | 2048 × 2048 px | High-resolution hero banners, full zoom |
| `master` | Original uploaded size | ⚠️ **PROHIBITED in theme code:** unconstrained bandwidth load; use `2048x2048` instead. |

> **Critical Distinction:** `'compact'` is a valid **image dimension preset** (`img_url: 'compact'`), but is completely **unsupported as an array filter** (`array | compact`).

---

## 4. Unsupported Shopify Features and Mandatory Haravan Equivalents

The following modern Shopify Liquid filters and tags are **FATAL SYNTAX ERRORS** or **SILENT FAILURES** on Haravan:

| Unsupported Shopify Feature | Failure Mode on Haravan | Required Haravan Native Equivalent |
|---|---|---|
| `image_url` filter | Runtime support **UNKNOWN** — never exercised on a Haravan storefront. One shipped theme uses it (`customizes/Iamhome/snippets/ih-projects-article-card.liquid:48`, `image_url: width: 900`), so it is not a corpus-wide absence. | Use `img_url: 'preset'` or `product_img_url: 'preset'`. |
| `{% render 'snippet' %}` tag | Fatal template compilation error (tag unrecognized). | Use `{% include 'snippet' %}`. |
| `{% schema %}` tag | Fatal template compilation error. | Define settings in `config/settings_schema.json` or `settings.html`. |
| `where` filter | Silent failure / empty output. | Manual loop: `{% for item in list %}{% if item.type == target %}...{% endif %}{% endfor %}`. |
| `reject` filter | Fatal filter error. | Manual loop using `unless` condition. |
| `compact` array filter | Fatal filter error. | Manual loop checking `unless item == blank`. |
| `concat` filter | Fatal filter error. | Manual array construction using `split` and `append`. |
| `at_most` / `at_least` filters | Fatal filter error. | Manual comparison: `{% if val > max %}{% assign val = max %}{% endif %}`. |

---

## 5. Tri-Platform Capability Matrix

Comparison of Haravan Liquid runtime against Shopify OS 2.0 and Sapo Bizweb:

| Feature / Capability | Haravan | Shopify OS 2.0 | Sapo (Bizweb) |
|---|---|---|---|
| Runtime Engine | DotLiquid / Liquid 1.0 | Shopify Liquid 2.0 | DotLiquid (.bwt) |
| Template File Format | `.liquid` (flat) | `.json` and `.liquid` | `.bwt` / `.liquid` |
| Section System | No (`snippets/` only) | Yes (`sections/*.liquid`) | Yes (`sections/*.bwt`) |
| Snippet Include Tag | `{% include 'name' %}` | `{% render 'name' %}` | `{% include 'name' %}` |
| Embedded Template Schema | No | Yes (`{% schema %}`) | Yes (`{% schema %}`) |
| Dynamic Block Layouts | No | Yes (`blocks`, `presets`) | Limited |
| Media Object (`product.media`) | Yes (documented) | Yes | Limited |
| URL Filter for Images | `img_url` | `image_url` | `img_url` |
| Max Products per Collection Page | 50 | 50 | 50 |
| Cart API Object Name | `line_item` | `line_item` | `line_item` |

---

## 6. Liquid Object and Filter Claims Ledger

| Claim | Evidence Status | Source (Path or URL + Observed Date) | Contradiction | Next Probe |
|---|---|---|---|---|
| Cart items are officially named `line_item` in Haravan Liquid. | `VERIFIED` | `https://docs.haravan.com/docs/themes/objects/line_item/` (2026-09-12). | Some internal reports colloquialized this as "cart_item". | None. Official name confirmed. |
| The loop variable that iterates `cart.items` must be named `line_item`. | `CORRECTED — FALSE` | Corpus count over 8252 files: `for item in cart.items` 215 occurrences, `for line_item in cart.items` 7 (2026-09-12); `line_item` is the `order.line_items` loop variable (72 occurrences). | The object is named `line_item`; the loop variable is author-chosen. A rule mandating it refused 8 of 8 cart loops in `themes/phukienmaymoc-copy`. | None. The linter refuses only the documented aliases (`cart_item`, `item_cart`, `cart_line_item`). |
| A `product.media` gallery must reach `product.images` or `product.featured_image` in the same file. | `DERIVED` | `https://docs.haravan.com/docs/themes/objects/product/` (official media support, 2026-09-12) plus the legacy-store gap recorded in §2. | The linter previously refused `product.media` outright, which fails the construct in 9 of 45 corpus theme directories. | Confirm on a store whose products carry video media that `product.media` is populated and `product.images` still resolves. |
| `blog.articles_count` represents total published articles, while `blog.articles.size` is page-local. | `VERIFIED` | `https://docs.haravan.com/docs/themes/objects/blog/` (2026-09-12); `customizes/Phukienmaymoc/templates/article.liquid:205`. | None. | None. |
| `product.selected_or_first_available_variant` respects `?variant=` query parameter. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12); `customizes/Apshop/snippets/lp-special.liquid`. | Initial report suggested `first_available_variant`. | None. |
| `product.media` is officially supported with `media.media_type` and `media.preview_image.src`. | `VERIFIED` | `https://docs.haravan.com/docs/themes/objects/product/` (2026-09-12). | Local skill was overly conservative, labeling it as uncertain. | Ensure Base Theme retains `product.images` fallback. |
| Shopify filters `image_url`, `where`, `reject`, `concat`, `at_most`, `at_least` do not exist in Haravan Liquid. | `PARTIAL — 1/45 THEMES USES image_url` | Corpus scan of 8252 Liquid/HTML files across 45 Haravan themes (2026-09-12): `where`/`reject`/`concat`/`at_most`/`at_least` 0 hits; `image_url` 1 hit (`customizes/Iamhome/snippets/ih-projects-article-card.liquid:48`). | The earlier `VERIFIED` row rested on "0 hits"; the single shipped usage was missed, and its runtime fatality was never tested. | Load the Iamhome article card against a Haravan storefront and read the rendered output. |
| `{% render %}` is completely unsupported on Haravan; themes must use `{% include %}`. | `VERIFIED` | Corpus grep across 30 themes (0 hits for `{% render %}`, 100% `{% include %}`); Cheat Sheet tag list. | AntiFan source mapper allowed `render` in shared code. | None. Platform invariant. |
| `content_for_header` is required in `layout/theme.liquid` `<head>`. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12); `customizes/*` (30/30 themes). | None. | None. |
| `content_for_layout` is required in `layout/theme.liquid` `<body>`. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12); `customizes/*` (30/30 themes). | None. | None. |
| 30 of 30 themes in corpus use `{% include %}` exclusively and 0 use `{% render %}`. | `OBSERVED` | `E:/Work/customizes` grep across all 30 themes (2026-09-12). | None. Factual corpus pattern. | None. |
| Array filtering operations on Haravan must be implemented via procedural `for` loops due to absence of `where` and `reject` filters. | `DERIVED` | Synthesis of supported Liquid filters and cheat sheet specifications (2026-09-12). | None. | None. |
| DotLiquid engine on Haravan may evaluate parenthesized conditional logic differently than Shopify Ruby Liquid in deeply nested expressions. | `INFERRED` | DotLiquid .NET parser specification vs Ruby parser behavior (2026-07-05). | Simple parentheses are confirmed supported locally. | Probe complex nested logical expressions on live storefront. |
| Maximum stack depth and execution timeout for deeply nested `{% include %}` chains on Haravan storefront servers. | `UNKNOWN` | None. Undocumented server infrastructure limit. | None. | Benchmark nested include execution limits on staging theme. |
