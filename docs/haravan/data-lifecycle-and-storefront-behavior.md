# Haravan Data Lifecycle, Storefront Rendering, and Runtime Behavior

**Document:** `docs/haravan/data-lifecycle-and-storefront-behavior.md`  
**Phase:** 08A — Knowledge Acquisition & Canonical Base Contract  
**Created:** 2026-09-12  
**Authority Hierarchy:** Official Haravan Docs > Real Store Admin > Real Haravan API > Real Haravan CLI > Theme Source Code > Live Storefront Behavior.

---

## 1. Shared Store Catalog & Data Reuse Contract

A foundational architectural reality of Haravan is that **all themes installed on a store query the identical, live production catalog database**.

```text
┌────────────────────────────────────────────────────────────────────────┐
│ PHUKIENMAYMOC.COM SHARED STORE CATALOG                                │
│ Products: 234 │ Custom Collections: 35 │ Smart Collections: 0         │
│ Pages: 6      │ Blogs: 1               │ Articles: 10                 │
└────────────────────────────────────────────────────────────────────────┘
                    ▲                               ▲
                    │                               │
        ┌───────────┴─────────────┐     ┌───────────┴─────────────┐
        │ LIVE THEME (1001510509) │     │ STAGING (1001512581)    │
        │ Role: "main"            │     │ Role: "unpublished"     │
        └─────────────────────────┘     └─────────────────────────┘
```

### The Data Reuse Mandate

To preserve live store integrity and prevent catalog pollution during theme development:

1. **Prioritize Existing Entities:** Themes must bind to existing catalog handles and IDs. In the reference store (`phukienmaymoc.com`), existing products (234 items) and collections (35 items) satisfy standard catalog browsing requirements.
2. **Minimal Semantic Fixture Creation:** New entities may ONLY be created when a specific semantic test state is completely missing from the existing catalog:
   - Product with multi-dimensional options (e.g. Size + Color).
   - Product with sold-out/unavailable variants (`available == false`).
   - Product with active promotion (`compare_at_price > price`).
   - Empty collection (0 products) to test empty-state rendering.
   - Zero-result search scenarios.
3. **Explicit Entity Ledger:** Every created entity must be logged with its exact ID, handle, creation timestamp, and owner in a persistent ledger.
4. **Absolute Prohibition on Wildcard Deletions:** Automated test teardowns must **NEVER** execute prefix-based deletions (e.g. deleting all products where `title` starts with `Test`). Such operations pose severe risk to merchant catalog records.

---

## 2. Storefront Rendering Lifecycle

The Haravan storefront rendering pipeline executes on Haravan servers before emitting HTML to the client browser:

```text
HTTP GET Request: https://phukienmaymoc.com/products/ao-thun?themeid=1001512581
  │
  ▼
[Theme Resolution Engine]
  │ Evaluates ?themeid= query or preview_theme_id cookie.
  │ Loads theme assets from unpublished theme 1001512581.
  ▼
[Root Layout Execution: layout/theme.liquid]
  │
  ├── 1. Evaluate <head>:
  │      Executes Liquid tags.
  │      Renders {{ content_for_header }} -> Injects Haravan tracking, analytics, app scripts.
  │
  ├── 2. Evaluate <body>:
  │      Matches URL route /products/ao-thun -> templates/product.liquid.
  │      Executes product template Liquid code.
  │      Resolves snippets via {% include 'header' %}, {% include 'footer' %}.
  │      Injects compiled template output into {{ content_for_layout }}.
  │
  └── 3. Server Emits Final HTML Document to Client Browser
```

### Critical Execution Invariants:
- `content_for_header`: Mandatory inside `<head>`. Haravan injects platform scripts, Google Analytics / Facebook Pixel bridges, app script tags, and verification metadata. Omitting this breaks core platform tracking and customer sessions.
- `content_for_layout`: Mandatory inside `<body>`. Represents the container where the route's active template is injected.

---

## 3. Client-Side Ajax Theme API Endpoints

Haravan provides lightweight, unauthenticated JSON endpoints specifically for theme storefront interactions (cart operations, live search, and customer status):

| Endpoint Path | HTTP Method | Request Payload | Return Object | Theme Use Case |
|---|---|---|---|---|
| `/cart.js` | `GET` | None | `Cart` JSON | Fetches current cart contents, total price, and item count for mini-cart drawers. |
| `/cart/add.js` | `POST` | `{ id: variantId, quantity: n, properties: {} }` | `LineItem` JSON | Adds a product variant to cart without full page reload. |
| `/cart/change.js` | `POST` | `{ line: index, quantity: n }` or `{ id: variantId, quantity: n }` | `Cart` JSON | Updates item quantity or removes item (when `quantity: 0`). |
| `/cart/update.js` | `POST` | `{ updates: { [variantId]: qty }, note: "..." }` | `Cart` JSON | Batch updates multiple cart line items and cart notes. |
| `/cart/clear.js` | `POST` | None | `Cart` JSON (empty) | Empties the entire shopping cart. |
| `/search` | `GET` | `?q={query}&view=json` | Custom JSON | Live predictive search dropdown (when `search.json.liquid` template is present). |

---

## 4. Platform Resource & Pagination Boundaries

Haravan enforces hard platform ceilings on Liquid collection and search loops:

### Collection Products Pagination (`collection.products`)
- **Hard Maximum:** **50 products per page.**
- **Syntax:** `{% paginate collection.products by 50 %}`.
- **Platform Enforcement:** Attempting to paginate by a number greater than 50 (e.g. `by 100` or `by 250`) is capped at 50 by the server runtime.
- **Infinite Scroll / "Load More":** Must be implemented using client-side Ajax pagination fetching `?page=2`, `?page=3` rather than a single massive server-side loop.

### Tag and Result Ceilings
- `collection.all_tags`: Capped at **1,000 tags**. Catalogs exceeding 1,000 tags will experience tag truncation in sidebar filters.
- `search.results`: Paginated up to **50 items per page**.

---

## 5. Client-Side Variant Selection Architecture

Because Haravan Liquid renders on the server, dynamic variant selection (e.g. clicking Color "Đỏ" and Size "XL") must be orchestrated client-side in theme JavaScript:

```text
Merchant Clicks Swatch / Selects Option
  │
  ▼
[Variant Change Event Listener]
  │ Reads selected option values (e.g. option1 = "Đỏ", option2 = "XL").
  │
  ▼
[Variant Lookup in product.variants JSON]
  │ Finds matching variant object where options match selections.
  │
  ├── 1. URL State Update:
  │      window.history.replaceState({}, '', '?variant=' + variant.id);
  │
  ├── 2. Pricing & Stock DOM Update:
  │      Updates .price -> variant.price (formatted with Haravan.formatMoney)
  │      Updates .compare-at-price -> variant.compare_at_price
  │      Updates .stock-status -> "Còn hàng" (if available) / "Hết hàng" (if unavailable)
  │
  ├── 3. Button State Update:
  │      If variant.available: enable Add-to-Cart button.
  │      If !variant.available: disable button, display "Hết hàng".
  │
  └── 4. Image Gallery Switch:
         If variant.featured_image: scroll gallery to matching image.
```

---

## 6. Staging Theme Isolation vs Shared Catalog Boundary

| Dimension | Unpublished / Staging Theme (`1001512581`) | Live Production Theme (`1001510509`) | Isolation Level |
|---|---|---|---|
| **Liquid Templates** (`templates/`) | Isolated to theme copy | Main production templates | **COMPLETE ISOLATION** |
| **Theme Assets** (`assets/`) | Isolated to theme copy | Main production assets | **COMPLETE ISOLATION** |
| **Settings** (`config/settings_data.json`)| Isolated to theme copy | Main production settings | **COMPLETE ISOLATION** |
| **Products & Variants** | **SHARED** (Global store catalog) | **SHARED** (Global store catalog) | **ZERO ISOLATION** |
| **Collections & Links** | **SHARED** (Global store catalog) | **SHARED** (Global store catalog) | **ZERO ISOLATION** |
| **Customer Accounts & Orders** | **SHARED** (Global store catalog) | **SHARED** (Global store catalog) | **ZERO ISOLATION** |

> **Key Takeaway:** You can completely redesign the storefront markup, stylesheets, and scripts in an unpublished theme with zero risk of visual bleed into the live theme. However, any modification to product titles, inventory counts, or collections will immediately alter what customers see on the live storefront.

---

## 7. Data Lifecycle and Storefront Claims Ledger

| Claim | Evidence Status | Source (Path or URL + Observed Date) | Contradiction | Next Probe |
|---|---|---|---|---|
| Unpublished themes share the identical catalog database with the live production theme. | `VERIFIED` | Haravan Platform Architecture Guide (2026-07-05); `reports/haravan-store-inventory.json`. | None. Core platform invariant. | None. |
| `collection.products` pagination limit is strictly capped at 50 products per page. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12); `customizes/*` (30/30 themes). | None. | None. |
| Cart Ajax API endpoints (`/cart.js`, `/cart/add.js`, `/cart/change.js`) operate unauthenticated. | `VERIFIED` | `https://docs.haravan.com/docs/tutorials/authentication/authentication-and-authorization/` (2026-09-12). | None. Theme client API standard. | None. |
| Dynamic variant changes update URL parameter `?variant={id}` via history replacement. | `VERIFIED` | `AntiFan/themes/phukienmaymoc-copy/assets/scripts.js.liquid:240–310` (2026-09-12). | None. Standard pattern. | None. |
| `content_for_header` injects required platform tracking and app scripts into `<head>`. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12); `customizes/*`. | None. | None. |
| `collection.all_tags` is bounded to a maximum of 1,000 tags. | `VERIFIED` | `https://themes.haravan.com/pages/cheat-sheet` (2026-09-12). | None. Platform ceiling. | None. |
| 21 of 30 corpus themes include `snippets/hrvproducttabs.liquid` for tabbed product descriptions. | `OBSERVED` | `E:/Work/customizes` theme inventory audit (2026-09-12). | None. Factual corpus pattern. | None. |
| Any staging theme regression test that modifies catalog inventory directly alters merchant live store availability. | `DERIVED` | Architectural deduction from shared catalog database invariant (2026-09-12). | None. | None. |
| Exact cache invalidation delay between a `POST /com/products.json` API update and its reflection in storefront Liquid `all_products` lookups. | `UNKNOWN` | None. Undocumented internal cache TTL. | None. | Measure cache latency by polling storefront after API mutation. |
| Client-side cart Ajax endpoints (`/cart.js`) share session cookie state across all themes viewed on the same domain. | `INFERRED` | Browser cookie domain scoping rules for `phukienmaymoc.com` (2026-09-12). | None. | Verify cart state retention when switching between `themeid` preview and live theme. |
