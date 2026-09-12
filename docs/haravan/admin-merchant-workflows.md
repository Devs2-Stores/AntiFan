# Haravan Admin Merchant Workflows & Operational Lifecycle

**Document:** `docs/haravan/admin-merchant-workflows.md`  
**Phase:** 08A — Knowledge Acquisition & Canonical Base Contract  
**Created:** 2026-09-12  
**Authority Hierarchy:** Official Haravan Docs > Real Store Admin > Real Haravan API > Real Haravan CLI > Theme Source Code > Live Storefront Behavior.

---

## 1. Haravan Admin Interface Architecture

The Haravan Admin portal (`https://{shop_domain}/admin`) manages commerce operations, catalog data, and online store presentation.

```text
Admin Portal Root (/admin)
├── Orders (/admin/orders)
├── Products (/admin/products)
│   ├── All Products (/admin/products)
│   ├── Collections (/admin/collections)
│   └── Inventory (/admin/inventory)
├── Customers (/admin/customers)
├── Website / Online Store (/admin/sale_channels/online_store)
│   ├── Themes (/admin/sale_channels/online_store/themes)
│   │   └── Theme Settings (/admin/sale_channels/online_store/themes/{themeId}/setting)
│   ├── Blog Posts (/admin/blogs)
│   ├── Pages (/admin/pages)
│   └── Navigation (/admin/menus)
└── Settings (/admin/settings)
```

---

## 2. Theme Management Lifecycle & Merchant Workflows

Merchant theme operations follow structured workflows within the Haravan Admin:

### A. Theme Import / Upload
- **Format:** Requires a standard `.zip` archive containing the canonical directory structure (`layout/`, `templates/`, `snippets/`, `assets/`, `config/`).
- **Validation:** Haravan Admin verifies that `layout/theme.liquid` and core templates exist. Archives with non-standard folder structures or corrupted archives are rejected with an upload error.
- **Quota:** Haravan stores permit up to 20 installed themes simultaneously.

### B. Theme Export / Download
- **Trigger:** Merchant navigates to **Online Store > Themes > Actions > Download theme file**.
- **Delivery Mechanism:** Unlike systems that initiate an immediate HTTP download stream, **Haravan generates the ZIP package asynchronously and emails the download link to the store owner's registered account email address**.
- **Security Implication:** Automated CI/CD tools cannot download theme archives directly through browser automation without email inbox access.

### C. Theme Preview
- **Action:** Clicking "Preview" opens the storefront targeting the theme using the URL query parameter:
  `https://{store_domain}?themeid={theme_id}`
- **Persistence:** The server sets an HTTP cookie named `preview_theme_id={theme_id}`. A bottom preview dock appears on the storefront displaying:
  *"Đang xem trước giao diện: {theme_name} | Chia sẻ bản xem trước | Đóng"*
- **Shareable Preview:** Haravan Admin generates 14-day temporary preview links for external stakeholders.

### D. Theme Publication (Publish)
- **Role Transition:** Publishing transitions the theme's API `role` attribute from `"unpublished"` to `"main"`.
- **Immediate Effect:** The published theme immediately serves all root traffic (`/`) across all configured store domains.
- **Safety Boundary:** In automated development and testing environments, publishing is strictly prohibited (`PROTECTED_NEVER_TOUCH` invariant).

### E. Theme Customizer (Visual Editor)
- **Interface:** Loads the storefront in a sandboxed iframe with a left-hand settings sidebar driven by `config/settings_schema.json` and `config/settings.html`.
- **Persistence:** Every merchant adjustment saved in the editor writes directly to `config/settings_data.json`.
- **Live Preview:** As settings are altered, the visual editor updates preview DOM elements or triggers an iframe reload.

---

## 3. Catalog Management Workflows

### Products and Variants
- **Options:** Up to 3 option dimensions per product (e.g. Size, Color, Material).
- **Variants:** Maximum 100 variants per product.
- **Media:** Supports images and external videos (YouTube/Vimeo). Older catalogs populate only image records.
- **Pricing:** Separate `price` (current selling price) and `compare_at_price` (original reference price for discounts).

### Collections (Custom vs Smart)
- **Custom Collections:** Manual groupings where products are explicitly added or removed by merchants or via `POST /com/collects.json`.
- **Smart Collections:** Automated groupings driven by rule sets (e.g. product vendor, tag matching, price ranges). Products dynamically appear based on criteria.
- **API Boundary:** Attempting to manually link a product to a Smart Collection via API returns `403 Forbidden`.

### Navigation (Link Lists / Menus) — Critical Platform Limitation
- **Merchant Workflow:** Configured under **Online Store > Navigation** to create hierarchical navigation menus (L1, L2, L3).
- **Liquid Access:** Exposed in templates via the global `linklists` dictionary (`linklists['main-menu'].links`).
- **Omni REST API Gap:** There is **NO REST API** endpoint for menus in Haravan. Probing `/web/link_lists.json` returns `HTTP 404 Not Found`. Menu structures must be manually configured in Haravan Admin or seeded via theme defaults.

### Blogs, Articles, and Pages
- **Blogs:** Categorized articles with comment moderation settings.
- **Pages:** Static content pages. Merchants can select alternate template suffixes (`page.contact`, `page.about`) if defined in the active theme's `templates/` directory.

---

## 4. Shared Catalog Architecture & Data Boundary

```text
┌────────────────────────────────────────────────────────────────────────┐
│ STORE-GLOBAL SHARED CATALOG (phukienmaymoc.com)                         │
│ Products (234) │ Collections (35) │ Blogs (1) │ Pages (6) │ Orders     │
└────────────────────────────────────────────────────────────────────────┘
          ▲                                            ▲
          │                                            │
┌─────────┴───────────────────────┐          ┌─────────┴─────────────────┐
│ MAIN THEME (1001510509)         │          │ STAGING THEME (1001512581)│
│ Role: "main" (LIVE PRODUCTION)  │          │ Role: "unpublished"       │
│ Renders shared store catalog    │          │ Renders shared catalog    │
└─────────────────────────────────┘          └───────────────────────────┘
```

### The Universal Data Invariant

In Haravan, **all themes installed on a store share the identical, live production catalog database**:
- There is no catalog isolation between `main` and `unpublished` themes.
- An unpublished theme renders against live products, collections, inventory counts, and customer accounts.
- **Any mutation (create, update, delete) performed on a product, collection, or page immediately impacts the live production store**, regardless of which theme was active during the edit.

### Safe Development Rules:
1. **Reuse Existing Data First:** Inspect existing products and collections before attempting to create new entries.
2. **Strict Non-Destructive Policy:** Never execute bulk deletions or wildcard cleanups on shared store catalogs.
3. **No Test Purchases:** Never complete test checkouts or generate dummy orders on a live merchant store.

---

## 5. Admin Merchant Workflow Claims Ledger

| Claim | Evidence Status | Source (Path or URL + Observed Date) | Contradiction | Next Probe |
|---|---|---|---|---|
| Theme export sends download link via email to store owner rather than direct stream. | `VERIFIED` | `https://docs.haravan.com/docs/get-started/build-theme/` (2026-09-12); Admin UI audit. | None. Standard Haravan security workflow. | None. |
| Navigation menus have no Omni REST API endpoint (`/web/link_lists.json` returns 404). | `VERIFIED` | `reports/haravan-store-inventory.json` (2026-09-12); Haravan Developers Documentation. | AntiFan report §8 omitted this restriction. | Probe BQ-04: test undocumented paths. |
| Unpublished themes share the identical catalog database with the live production theme. | `VERIFIED` | Haravan Platform Architecture Guide (2026-07-05); Store Inventory execution. | Some external users assume themes have isolated test catalogs. | None. Platform invariant. |
| Publishing a theme changes its role from `unpublished` to `main`. | `VERIFIED` | `Haravan CLI/src/commands/theme/theme-publish.ts:35` (2026-09-12); Haravan API docs. | None. | None. |
| Manually linking a product to a Smart Collection via API returns 403 Forbidden. | `VERIFIED` | `https://docs.haravan.com/docs/omni-apis/collects/` (2026-09-12). | None. | None. |
| Custom page templates are selectable in Haravan Admin page editor. | `VERIFIED` | Haravan Admin User Guide (2026-07-05); `customizes/*` (30/30 themes). | None. | None. |
| Reference store `phukienmaymoc.com` contains 2 installed themes (1 main, 1 unpublished copy) and 3 active menus. | `OBSERVED` | `reports/haravan-store-inventory.json` (2026-09-12). | None. Live store audit. | None. |
| Automated CI/CD pipelines cannot autonomously download exported theme archives due to email verification barrier. | `DERIVED` | Synthesis of theme export delivery mechanism and headless automation constraints (2026-09-12). | None. | None. |
| Maximum ZIP file size accepted by Haravan Admin manual theme upload dialog. | `UNKNOWN` | None. Undocumented file size ceiling. | None. | Test upload of synthetic 50MB and 100MB theme archives. |
| Haravan Admin theme duplicate operation executes server-side asset duplication without consuming API rate limits. | `INFERRED` | Admin duplication UI speed and lack of API telemetry (2026-09-12). | None. | Inspect network requests during Admin theme copy. |
