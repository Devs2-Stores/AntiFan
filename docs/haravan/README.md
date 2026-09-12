# Haravan Platform Knowledge Base & Evidence Ledger

**Directory:** `docs/haravan/`  
**Phase:** 08A — Knowledge Acquisition & Canonical Base Contract  
**Created:** 2026-09-12  
**Authority Hierarchy:** Official Haravan Docs > Real Store Admin > Real Haravan API > Real Haravan CLI > Theme Source Code > Live Storefront Behavior.  
**Corpus Precaution:** Corpus statistics from 30 customer themes under `E:/Work/customizes` represent **observed common practice**, NOT platform prohibition or universal capability boundaries.

---

## 1. Epistemic Hierarchy & Status Vocabulary

Every claim across this knowledge base is stamped with one of six immutable epistemic status labels. Confidence is never upgraded without explicit, newly observed evidence:

| Status Label | Formal Definition | Permissible Usage |
|---|---|---|
| `VERIFIED` | Confirmed by official documentation, executed API probe, or verified CLI source with exact citation and date. | Platform invariant, official API scope, documented Liquid tag/filter, verified CLI guard. |
| `OBSERVED` | Directly inspected on live disk state, real theme files, or active HTTP responses, but not guaranteed to be platform law. | Corpus file counts, recurrence percentages, local AntiFan Core implementation details. |
| `DERIVED` | Deductively deduced by combining two or more `VERIFIED` or `OBSERVED` facts through rigorous logical reasoning. | Naming discrepancies, architectural synthesis, architectural boundaries. |
| `INFERRED` | Plausible hypothesis based on partial telemetry or industry conventions; not yet proven against primary Haravan sources. | Assumptions regarding undocumented Admin behavior or internal platform mechanisms. |
| `UNKNOWN` | Explicitly probed or identified capability where empirical data is missing or inaccessible. | Unresolved precedence between configuration files, unauthenticated preview behaviors. |
| `CONFLICT` | Contradictory evidence between official documentation sources, or between documentation and live platform behavior. | Inconsistent batch limits in official docs, contradictory API responses. |

### Claim Table Contract

Every domain page in this directory structures its factual assertions using the standard 5-column contract:
`Claim | Evidence Status | Source (Path or URL + Observed Date) | Contradiction | Next Probe`

---

## 2. Document Index & Domain Navigation

| Document | Scope & Ownership | Key Epistemic Anchors |
|---|---|---|
| [`platform-topology-and-settings.md`](platform-topology-and-settings.md) | Haravan theme directory layout (`layout/`, `templates/`, `snippets/`, `assets/`, `config/`), legacy `config/settings.html`, modern `config/settings_schema.json`, visual editor binding rules, and configuration file precedence. | Flat Liquid templates; `sections/` and OS 2.0 JSON templates absent; F1GENZ binding contract (`setting-id` + `setting-type`). |
| [`liquid-objects-filters-tags.md`](liquid-objects-filters-tags.md) | Verified Liquid runtime: global and resource objects (`line_item`, `product`, `collection`, `blog`), variant resolution, supported vs unsupported filters and tags, and platform comparison. | Official `line_item` naming; `blog.articles_count`; unsupported `image_url`, `where`, `render`, `schema`. |
| [`routes-and-handles.md`](routes-and-handles.md) | Storefront URL routing, canonical template dispatch, handle mechanics as platform primitives, and preview targeting query parameters. | Canonical 8 templates; handle immutability; `?themeid=` preview parameter vs inert `?preview_theme_id=`. |
| [`admin-merchant-workflows.md`](admin-merchant-workflows.md) | Merchant administrative workflows: theme import/export/publish, visual editor customization, and shared catalog implications. | Shared store database; unpublished themes share live catalog; Admin theme packaging rules. |
| [`api-capabilities-and-scopes.md`](api-capabilities-and-scopes.md) | Haraweb (`web.*`) vs Commerce (`com.*`) REST APIs, OAuth/Private Bearer auth, token lifecycles, leaky-bucket rate limits, webhooks, and documented API gaps. | Bundled scopes (`web.read_contents`, `com.read_products`); missing link_lists API (404); inventory batch conflict. |
| [`cli-operations-and-guards.md`](cli-operations-and-guards.md) | `@f1genz/haravan-cli` command inventory, watcher synchronization, local state tracking, and fail-closed security guards. | Fail-closed `role === "main"` block; project context binding; automated backups; correct `?themeid=` preview. |
| [`data-lifecycle-and-storefront-behavior.md`](data-lifecycle-and-storefront-behavior.md) | Shared catalog lifecycle, data reuse contract, semantic fixture creation, Ajax theme endpoints, pagination limits, and rendering lifecycle. | Entity reuse priority; non-destructive catalog policy; 50-item pagination; client-side Ajax cart contracts. |

---

## 3. Evidence Ledger & Provenance Summary

The facts compiled in this wiki are anchored in Tier-1 evidence gathered during Phase 08A research and historical repository audits:

1. **Official Documentation:**
   - Haravan Developers Portal (`https://docs.haravan.com/`) — Captured 2026-07-05 & 2026-09-12.
   - Haravan Theme Cheat Sheet (`https://themes.haravan.com/pages/cheat-sheet`) — Captured 2026-09-12.
   - Haravan GitHub Help (`https://haravan.github.io/help/cheat-sheet/`) — Captured 2026-09-12.
   - Reference Theme Twenty (`https://github.com/Haravan/haravan_theme_twenty`) — Inspected 2026-09-12.
2. **Authoritative Codebases:**
   - Haravan CLI Source (`E:/Work/apps/Haravan CLI/src/`) — Inspected 2026-09-12.
   - Haravan App Base (`E:/Work/apps/haravan-app-base/`) — Inspected 2026-09-12.
   - AntiFan Core Engine (`E:/Work/apps/AntiFan/src/`) — Inspected 2026-09-12.
3. **Corpus of 30 Customer Themes (`E:/Work/customizes/`):**
   - 30 distinct commercial customer themes audited across directory structures, template families, snippet includes, slider libraries, and settings architecture.
4. **Live Store & Execution Receipts:**
   - Store Inventory (`reports/haravan-store-inventory.json`, 2026-09-12): Store `phukienmaymoc.com`, Org `200001207485`.
   - Adjudication & Forensics (`plans/reports/scout-union-260912-1731-haravan-base-theme.md`, `evidence-addendum-04-260912-1731-measurement-identity.md`).

---

## 4. Phase 08A Unresolved Blocking Questions & Dependent Outputs

The following questions cannot be closed without live staging probes or explicit administrative action. In accordance with the project contract, these remain open with their dependent outputs identified:

| ID | Unresolved Question | Current Status | Dependent Output / Blocked Component | Required Resolution Probe |
|---|---|---|---|---|
| **BQ-01** | Does unauthenticated storefront GET request honour `?themeid=` preview parameter, or does it require an active authenticated Haravan Admin session cookie? | `UNKNOWN` | Phase 03/07 Live Capture Verifier & Storefront Visual Testing | Execute two HTTP GET requests to `phukienmaymoc.com` with `?themeid=1001512581` (one with admin session cookie, one clean) and diff served HTML against live theme `1001510509`. |
| **BQ-02** | In dual-mode themes containing both `config/settings.html` and `config/settings_schema.json` (24/30 themes in corpus), which configuration source takes precedence when setting IDs collide in Admin vs Storefront? | `UNKNOWN` | Phase 05 Compiler Cutover & Phase 06 Base Theme Assembly | Deploy a test theme with identical key `test_banner_title` set to different values in `settings.html` vs `settings_schema.json`, edit via Admin visual editor, and observe which value writes to `config/settings_data.json` and renders in Liquid. |
| **BQ-03** | How does Haravan remote theme sync/packaging handle unexpected directories like `sections/*.liquid` or `templates/*.json`? Does it reject the upload, strip the files, or silently ignore them? | `UNKNOWN` | Phase 04 Platform Policy & Phase 05 Compiler Cutover | Push `themes/roahtrip-haravan` to safe staging theme `1001512581` using `hrv theme push` and read remote file inventory via `GET /web/themes/1001512581/assets.json`. |
| **BQ-04** | Can navigation menus (`linklists`) be seeded or modified programmatically via any undocumented API endpoint, given that `/web/link_lists.json` returns HTTP 404? | `UNKNOWN` | Phase 08B Project Theme Setup & Semantic Fixture Automation | Probe alternate API paths (`/web/menus.json`, `/com/link_lists.json`) or declare manual Admin menu creation as a mandatory prerequisite. |
| **BQ-05** | Does Haravan CLI watcher synchronization pattern (`DEFAULT_SYNC_PATTERN`) fail when running in non-English Windows terminal locales? | `UNKNOWN` | AntiFan Core Synchronization Barrier (`haravan-sync-barrier.ts`) | Run `hrv theme dev` in a Vietnamese locale Windows shell (`chcp 65001` vs default codepage) and capture the exact terminal stdout emission on file sync. |
