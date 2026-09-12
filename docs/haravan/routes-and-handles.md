# Haravan Storefront Routes, Handles, and Preview Targeting

**Document:** `docs/haravan/routes-and-handles.md`  
**Phase:** 08A — Knowledge Acquisition & Canonical Base Contract  
**Created:** 2026-09-12  
**Authority Hierarchy:** Official Haravan Docs > Real Store Admin > Real Haravan API > Real Haravan CLI > Theme Source Code > Live Storefront Behavior.

---

## 1. Canonical Route Map & Template Dispatch

The Haravan storefront router matches URL request paths directly to flat `.liquid` templates located in the `templates/` directory.

| Storefront Route Pattern | Canonical Template | Contextual Objects Available | Special Query Parameters |
|---|---|---|---|
| `/` | `templates/index.liquid` | `shop`, `content_for_layout` | — |
| `/products/{product_handle}` | `templates/product.liquid` | `product`, `collection` (if navigated via collection) | `?variant={variant_id}` (resolves `selected_or_first_available_variant`) |
| `/collections/{collection_handle}` | `templates/collection.liquid` | `collection`, `collection.products` | `?page={n}`, `?sort_by={sort_key}`, `?filter={tag}` |
| `/collections/all` | `templates/collection.liquid` | `collection` (representing all catalog products) | `?page={n}`, `?sort_by={sort_key}` |
| `/blogs/{blog_handle}` | `templates/blog.liquid` | `blog`, `blog.articles`, `blog.articles_count` | `?page={n}` |
| `/blogs/{blog_handle}/{article_handle}` | `templates/article.liquid` | `article`, `blog`, `article.comments` | — |
| `/pages/{page_handle}` | `templates/page.liquid` | `page` | — |
| `/cart` | `templates/cart.liquid` | `cart`, `cart.items` (`line_item`) | — |
| `/search` | `templates/search.liquid` | `search`, `search.results`, `search.terms` | `?q={query_terms}`, `?type=product,article,page` |
| `/account` | `templates/customers[account].liquid` | `customer`, `customer.orders` | Requires authenticated customer session |
| `/account/login` | `templates/customers[login].liquid` | `form` (`customer_login`) | `?checkout_url={return_to}` |
| `/account/register` | `templates/customers[register].liquid` | `form` (`create_customer`) | — |
| `/account/addresses` | `templates/customers[addresses].liquid` | `customer.addresses` | Customer address management |
| `/account/orders/{order_id}` | `templates/customers[order].liquid` | `order`, `order.line_items` | Customer order receipt view |
| `/account/reset/{token}` | `templates/customers[reset_password].liquid` | `form` (`reset_customer_password`) | Password reset flow |
| `/account/activate/{token}` | `templates/customers[activate_account].liquid` | `form` (`activate_customer_password`) | Account activation flow |
| Unmatched URL (404) | `templates/404.liquid` | `shop`, `content_for_layout` | HTTP 404 response status |

---

## 2. Alternate Templates and View Parameter Mechanics

Haravan supports alternate template layouts for products, collections, pages, and carts using the `?view={suffix}` query parameter.

When the router encounters a URL with `?view={suffix}`, it searches for a template named `{canonical_name}.{suffix}.liquid`:
- `/products/ao-thun-basic?view=quickview` → Dispatches to `templates/product.quickview.liquid`.
- `/collections/sale-mua-he?view=tab2` → Dispatches to `templates/collection.tab2.liquid`.
- `/cart?view=json` → Dispatches to `templates/cart.json.liquid` (frequently used in older themes for custom JSON endpoints).

**Corpus Observation:**
In the 30-theme corpus under `E:/Work/customizes/`, alternate templates are prevalent:
- 24/30 themes contain at least one alternate product or collection template.
- `AntiFan/themes/phukienmaymoc-copy` contains `collection.index-tab-2.liquid`, `index.header-load-menu.liquid`, and `cart.json.liquid`.

---

## 3. Handle Mechanics as a Platform Primitive

In Haravan, the **handle** is the immutable URL identifier and canonical reference key for products, collections, blogs, articles, and pages.

### Handle Invariants
1. **Slug Format:** Alphanumeric lowercase characters separated by hyphens (e.g. `thiet-bi-dien-tu`). Automatically generated from titles using the `handleize` filter.
2. **URL Identity:** Modifying an entity title in Haravan Admin does not necessarily change its handle. If a merchant manually changes the handle, Haravan creates an internal redirect, but direct Liquid lookups break immediately.
3. **Liquid Dictionary Lookups:** Themes reference global store entities directly through dictionary indexing:
   - `collections['khuyen-mai-hot']`
   - `all_products['may-khoan-cam-tay']`
   - `linklists['main-menu']`
   - `blogs['tin-tuc-cong-nghe']`
   - `pages['chinh-sach-doi-tra']`
4. **Failure Mode on Missing Handle:** If a handle is modified or does not exist, Liquid returns `nil`/`empty`. Without defensive fallbacks (`{% if collections['handle'] != blank %}`), theme sections silently collapse or render broken markup.

---

## 4. Preview Targeting & Defect 9 Analysis

Targeting a specific unpublished or staging theme on a live Haravan storefront requires the correct query parameter.

### Haravan vs Shopify Preview Parameter

```text
┌────────────────────────────────────────────────────────────────────────┐
│ PREVIEW PARAMETER COMPARISON                                           │
├────────────────────────────────────────────────────────────────────────┤
│ Haravan Platform Parameter:   ?themeid={theme_id}                      │
│ - Sets cookie:                preview_theme_id={theme_id}              │
│ - Status:                     OFFICIAL, ACTIVE                         │
│                                                                        │
│ Shopify Platform Parameter:   ?preview_theme_id={theme_id}             │
│ - Status on Haravan:          INERT / UNRECOGNIZED                     │
│ - Behavior on Haravan:        Serves live production theme (main)      │
└────────────────────────────────────────────────────────────────────────┘
```

### Forensic Analysis of Defect 9

In historical testing runs within this repository, visual comparison tests were executed using URLs such as:
`https://phukienmaymoc.com/...?preview_theme_id=1001512581`

**Empirical Result:**
Because `preview_theme_id` is a Shopify parameter that Haravan ignores, the Haravan storefront served the **live production theme** (`1001510509`, role `main`), completely bypassing the staging copy (`1001512581`). Consequently:
- The historical test suite stamped `VERIFIED_PASS` on all 45 cases while inspecting the live store rather than the intended staging theme.
- Leak detection reported `hoplongLeaksCount: 0` because it inspected the polished live store rather than the staging artifact.

### Authoritative CLI Confirmation

The official Haravan CLI codebase confirms that `?themeid=` is the platform standard:
- `Haravan CLI/src/commands/theme/theme-dev.ts:70`:
  ```typescript
  console.log(`   ${COLORS.FgGreen}Preview:${COLORS.Reset}    ${base}?themeid=${themeId}`);
  ```
- `Haravan CLI/src/services/open-service.ts:80`:
  ```typescript
  return `${base}?themeid=${themeId}`;
  ```
- `Haravan CLI/src/commands/open.test.ts:51,58`:
  Asserts generated preview URL matches `https://my-store.myharavan.com?themeid=123`.

---

## 5. Route and Handle Claims Ledger

| Claim | Evidence Status | Source (Path or URL + Observed Date) | Contradiction | Next Probe |
|---|---|---|---|---|
| Standard storefront routes map to 8 canonical flat `.liquid` templates. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12); `customizes/*` (30/30 themes). | None. Core architecture. | None. |
| The Haravan theme preview query parameter is `?themeid=`, not `?preview_theme_id=`. | `VERIFIED` | `Haravan CLI/src/commands/theme/theme-dev.ts:70` (2026-09-12); `Haravan CLI/src/services/open-service.ts:80`. | AntiFan verification scripts used `preview_theme_id`. | Probe BQ-01: verify cookie set behavior on unauthenticated GET. |
| Customer account templates use brackets (e.g. `templates/customers[account].liquid`). | `VERIFIED` | `Haravan CLI/src/helper/theme-asset-patterns.ts:45` (2026-09-12); `customizes/*` (30/30 themes). | None. Platform invariant. | None. |
| `?view={suffix}` dispatches to `{template}.{suffix}.liquid`. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12); `customizes/*` (24/30 themes). | None. Standard feature. | None. |
| Renaming an entity title does not automatically update its URL handle. | `VERIFIED` | Haravan Admin Product & Collection Guide (2026-07-05). | None. | None. |
| `all_products[handle]` and `collections[handle]` return `nil` if handle is invalid. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12). | None. | None. |
| 24 of 30 corpus themes utilize at least one alternate template suffix via `?view=`. | `OBSERVED` | `E:/Work/customizes` theme inventory audit (2026-09-12). | None. Factual corpus pattern. | None. |
| Passing `?preview_theme_id=` on unauthenticated GET serves the live theme because Haravan routing middleware only parses `?themeid=`. | `DERIVED` | Defect 9 forensic execution and Haravan CLI source analysis (2026-09-12). | Prior test suites assumed `preview_theme_id` worked. | Probe BQ-01: confirm unauthenticated cookie drop on `?themeid=`. |
| Whether Haravan CDN edge caches HTML responses differently when `?themeid=` is appended by unauthenticated callers. | `UNKNOWN` | None. Undocumented edge routing policy. | None. | Inspect cache-control headers on staging preview GETs. |
| Haravan internal redirect table for renamed entity handles is maintained at store database level rather than theme router level. | `INFERRED` | Haravan Admin redirect management behavior (2026-07-05). | None. | None. |
