# Theme Harness Scout — `Storefront/` (Hrv Glasses, org 1000405253, theme 1001357480)

Read-only scout for a separate theme QA harness targeting `E:/Work/apps/AntiFan/Storefront/`, live at `https://hangquoctai.myharavan.com/`. Every claim cites file:line or observed output.

---

## 1. Existing instruments and what it takes to point them at the real theme

### 1.1 `scripts/smoke-theme-golden-live.cjs` (947 lines, Electron worker)

**What it actually does.** An Electron `BrowserWindow` worker that boots the real AntiFan stack in-process: `NativeTabHost` + `ControlPlaneRuntime` + `BrowserControlPort` + `BridgeServer`, then spawns `scripts/antifan-omp-mcp.cjs` as a stdio MCP child and drives it over JSON-RPC (`scripts/smoke-theme-golden-live.cjs:208-330`). Against that stack it exercises the real verification surface end-to-end:

- `anti.screenshot.viewport` with PNG signature check (`:371-375`)
- `anti.inspect.styles` / `anti.inspect.matched_styles` pre/post CSS mutation (`:378-440`)
- `anti.theme.resolve_element` mapping `.product-card` to `snippets/card-product.liquid` (`:397-405`)
- `file.write` + `anti.browser.reload` + document-generation advance (`:407-425`)
- `anti.inspect.responsive_matrix` across 320/375/768/1024/1440 (`:442-452`)
- `anti.verification.record_claim` then `verify_claim` then persisted receipt (`:454-480`)
- P0.4 rendered-mutation falsification: writes mutated HTML to `storefrontHtmlPath` (`workspaceRoot/storefront/index.html`), reloads, and asserts structural metrics detect height drift (mutation A), geometry preservation (B), and overflow clamping (C) (`:472-560`)
- Negative canaries: no-op claim REJECTED, ambiguous source REJECTED, stale authority revision denied with `AUTHENTICATION_DENIED` (`:820-870`)
- Full resource teardown accounting — every owner count must be 0 before staging (`:880-920`)

**Does it touch the theme?** No. It copies `test/fixtures/golden-workflow/{product-card,hamburger-drawer}/theme` into a temp `workspaceRoot` (`:165-175`) and serves **static fixture HTML** from `storefront/index.html` / `drawer.html` via a local `http.createServer` (`:177-205`). No Liquid is rendered anywhere; the theme tree is used only as (a) the source-mapping target for `resolve_element` and (b) the mutation target for `file.write`.

**To point it at the real theme:** set `workspaceRoot = Storefront/` (then `resolve_element` and `file.write` operate on real sources) and replace the fixture server with either a live-store URL or a rendered page. The served HTML is the hard part — the worker has no renderer, so option (a) live capture or (b) a Liquid engine must supply it. The verification pipeline itself is theme-agnostic and directly reusable.

### 1.2 `scripts/run-theme-golden-live-proof.cjs` (orchestrator)

Node parent that spawns the Electron worker with orchestrator-owned temp/staging env (`ANTIFAN_LIVE_PROOF_TEMP_ROOT`, `ANTIFAN_LIVE_PROOF_STAGING_PATH`, `:55-70`), enforces a 180 s ceiling with `killOwnedTree` (`taskkill /PID /T /F` on win32, `:33-40`, `:72-80`), validates the staged proof checksum and teardown fields (`:82-90`), then does post-exit temp cleanup and writes the final `PASSED` report (`:92-105`). **Does not touch the theme.** Reusable verbatim as the process-boundary/supervisor pattern for a harness runner.

### 1.3 `scripts/smoke-packaged-theme-developer.cjs` (359 lines)

Drives the **packaged** `antifan-browser-desktop.exe` over bridge WebSocket RPC: fixture HTTP server, launch exe, discover `bridge.json`, `antifan.cli.startSession`, `browser.open-tab`, `browser.dom` assert, `browser.screenshot` (`:50-300`). The "storefront" is a **hardcoded inline HTML string** (`:62-90`); no theme file is ever read. Line 1 carries `// TODO(phase4): requires token injection; no longer reads master token from bridge.json` — the auth path is stale. **Verdict: not a theme harness.** Only useful as a reference for the bridge-RPC session flow.

### 1.4 `scripts/smoke-theme-qa-gate.cjs` — the closest existing QA-harness shape

Plain Node smoke (no Electron) that instantiates the real QA engine classes from `.compiled/`: `PlatformDetector`, `LiquidErrorScanner`, `LayoutOverflowEngine`, `HsGateRules`, `ThemeQaWorkflow` (`:10-18`), serves a mock storefront HTML string (`:30-60`), and runs `workflow.validate()` against a mocked `BrowserControlPort` (`:100-160`), asserting checklist outcomes, tracker-isolation bookkeeping, and PII sanitization in the persisted report (`:170-230`). **Does not touch the theme** — input is a mock HTML string. To point at the real theme it needs a real bound tab (the running Electron app) navigated to the store, plus `workspaceRoot = Storefront/` for receipt confinement.

### 1.5 Other instruments found (not in the candidate list)

| Instrument | What it does | Theme contact |
|---|---|---|
| `scripts/theme-checks.mjs` + `scripts/lib/theme-checks.mjs` | Offline static gate: `scanRenderFailures`, `validateThemeSchemas`, `checkSettingsBinding`, `checkAssetReferences`, `checkHaravanLiquidContracts`; CLI `--theme <dir> --html <captured> --platform haravan` (`scripts/theme-checks.mjs:20-100`) | **Reads the theme tree directly — runnable against `Storefront/` today, no browser** |
| `scripts/lint-haravan-theme.mjs` | Haravan contract linter: no `{% schema %}`/`{% render %}`/`sections/`, include-target resolution, settings resolution vs `settings_data.json`/`settings.html` (`:1-30`) | Reads the theme tree directly |
| `scripts/fetch-haravan-theme-safe.mjs` | Pulls theme assets via `apis.haravan.com` with manifest/hash parity, binding-adoption scan, and `.hrv-sync-state.json` watched-dir refusal (`:10-16`, `:40-80`, `:190-200`) | Can mirror theme 1001357480 with `HARAVAN_ORG_ID=1000405253 HARAVAN_THEME_ID=1001357480` (defaults are org `200001207485` / theme `1001514194`, `:10-11`) |
| `scripts/lib/theme-target.mjs` | `resolveThemeId` refuses `PROTECTED_THEME_IDS = ['1001514194']`, default `1001514345` (`:8-30`) | Target `1001357480` is **not** in this list — but see section 4c: it is the live `main` theme, so push is refused by the CLI role gate regardless |
| `scripts/probe-theme-identity.mjs` | Cookie-less GET probe comparing `?themeid=` vs `?preview_theme_id=` response hashes; prints `IDENTITY_UNVERIFIED` by design (`:85-95`) | Live store, read-only |
| `.canary/tools/fifteen-pages-run.mjs` | 15-page x 3-viewport campaign orchestrator importing `campaign-verdicts`, `evidence-provenance`, `atomic-record`, `campaign-lock`, `theme-fidelity` (`:30-45`); `TARGET_PAGES` hardcodes `hoplongtech.com` (`:52-90`) | Wrong target — phase-07 documents this must be re-targeted to `hangquoctai.myharavan.com` (`plans/260915-1658-goal-p0-retrieval-bridge-completion/phase-07-measurement-layer.md`, R0) |
| `src/main/qa/theme-qa-workflow.ts` | The real QA engine: `ThemeQaReport` checklist `{layout,responsive,overflow,interactions,diagnostics,liquidClean,assetsValid,hsCompliant}` (`:20-30`), five scanners + HS rules (`:8-14`), tracker-isolation port (`:140-160`), `sanitizePii` (`:165-175`) | Runs against whatever the bound tab shows |
| `src/main/qa/haravan-sync-barrier.ts` | Deterministic remote-settle barrier: a mutation counts as synced only when the CLI watcher emits an upload ack after `baselineSeq` in the same `sessionGeneration`; fails closed (`:1-20`) | The existing machinery for the push-to-dev-theme option |
| `theme.qa_validate` capability | Registered at `src/main/tools/browser-capabilities.ts:1459-1560`: `expectedUrl` route gate throws `URL_HOST_MISMATCH`/`URL_THEME_MISMATCH`/`URL_PATH_MISMATCH`; `workspaceRoot` confined; QA receipt written to `.antifan/qa-receipts/` on **every** terminal branch | Live bound tab |
| `anti.theme.export_clean` | Alias of `browser.dump_dom` (`scripts/antifan-omp-mcp.cjs:80,431`): materialize + sanitize (Livewire/SSR blobs, unhydrated modals) + export page DOM to a workspace file | The capture primitive for offline snapshots |
| `anti.theme.resolve_element` | Maps rendered DOM to local theme source with 2-signal confidence (`browser-capabilities.ts:2342-2346`) | Needs `workspaceRoot` = theme dir; works with `Storefront/` |

## 2. Liquid renderer inventory

- **`package.json` dependencies/devDependencies contain no Liquid engine** (`package.json:88-105`: `@modelcontextprotocol/sdk`, xterm, `ws`, `zod`, electron, esbuild, typescript).
- `node_modules/liquidjs` and `node_modules/@shopify/liquid*` **do not exist** in this repo (glob miss on both).
- liquidjs **is** installed in the sibling repo: `E:/Work/apps/Haravan CLI/node_modules/liquidjs/package.json` exists; `docs/haravan/cli-operations-and-guards.md:14` records `liquidjs@10.27.0` as the CLI **syntax-validation** dependency (`hrv theme lint`, section 2 command matrix).
- A prior local-render harness exists at `plans/reports/_render-home.mjs`: it `require`s liquidjs from the sibling repo path (`:26-28`), **inline-expands `{% include %}` to emulate Haravan caller-scope semantics** (`:60-120`), builds an object model from `plans/reports/haravan-live-store-fixture.json` (`:130-220`), and registers ~30 Haravan filters (`:230-300`). Its own header states the limit: "LiquidJS is a Liquid-compatible engine, not Haravan's DotLiquid" (`:10-14`). Its default `themeDir` (`themes/phukienmaymoc-copy`, `:30`) **no longer exists** (glob miss) — the harness is stale but the pattern is proven.
- **Plan constraint (binding):** `phase-07-measurement-layer.md:73` — a self-built liquidjs + hand-made object model produces verdicts that are fake and **must not count as PASS**; `:76` — `haravan theme push*` is forbidden without explicit user approval.
- Haravan CLI has **no `serve`/`preview`** — `theme dev` is a chokidar watcher that *pushes each change to the remote theme* (`docs/haravan/cli-operations-and-guards.md` section 2; phase-07 R0).

## 3. What the theme needs to render

`Storefront/` layout: `layout/`, `templates/` (43 files), `snippets/` (~82), `config/`, `assets/` — **no `sections/`, no `locales/`** (directory listing). Legacy Haravan settings system: `config/settings_schema.json` is a 4-byte placeholder (`[{}]`); real declarations live in `config/settings.html` (119.9 KB legacy form, control `name=` = setting id, `:1-24`) and values in `config/settings_data.json` under `current` (239.6 KB, `:1-40`).

### Layout contract (`layout/theme.liquid`)

`page_title`, `current_tags`, `current_page`, `shop.name`, `canonical_url`, `settings.shop_meta_keywords`, `page_description`, `template contains 'search'` (`:11-16`), `content_for_header` captured then string-replaced to inject the f1genzPS guard (`:20-27`), `content_for_layout` (`:35`), ~20 `{% include %}` snippets (`:17,29-49`).

### Runtime objects observed (grep over `Storefront/`)

- **Globals:** `shop.{name,url,phone,currency,money_format}`, `settings.*` (dot, bracket, and **dynamic** `settings[var]` reads — `templates/index.liquid:3-5` includes `settings[sectionName]` for i in 1..10, so home section order is settings-driven), `template` (`contains`/`==`), `page_title`, `page_description`, `canonical_url`, `current_page`, `current_tags`, `content_for_header`, `content_for_layout`, `forloop.{index,last}`, `"now" | date`.
- **Global lookups:** `linklists[handle].links` nested 3 deep with `link.{url,title,active,type,object.handle,handle}` (`snippets/shop-menu.liquid:7-34`); `collections[handle].{products,products_count,url}` (`snippets/index-special-collection.liquid:111-131`, `snippets/product-snippet.liquid:256-257`); `blogs[handle].{articles,articles.size}` (`snippets/home-blog.liquid:16-26`); `pages[handle].content` (`snippets/footer_s1.liquid:63-64`, `snippets/product-snippet.liquid:211-236`). **No `all_products` usage found.**
- **product:** `variants[].{price,compare_at_price,sku,barcode,title,image.src}` incl. dynamic `variant[option]` (`snippets/swatch.liquid:9-25`), `options`, `images[].{src,alt}`, `featured_image.{src,alt}`, `first_available_variant`, `available`, `vendor`, `type`, `tags`, `collections.first.handle`, `handle`, `url`, `title`, `id`, `price`, `compare_at_price`, `product | json` (`snippets/variables.liquid:47`, `templates/search.quickview.liquid:3`).
- **collection:** `id`, `handle`, `title`, `description`, `image.src`, `products`, `products_count`, `default_sort_by` (`snippets/collection-snippet.liquid:1-40`, `snippets/variables.liquid:38`).
- **cart:** `item_count`, `total_price`, `note`, `items[].{variant_id,product.*,variant.*,price,line_price,quantity,image,url,title,id}` (`templates/cart.liquid:16-92`, `snippets/shop-cart-modal.liquid:18-28`).
- **search:** `performed`, `terms`, `results` (`templates/search.liquid:13-33`, `templates/search.filter.liquid:2-6`).
- **paginate:** `pages`, `previous`, `next`, `parts[].{is_link,url,title}`, `current_page` (`snippets/shop-pagination.liquid:2-22`); `{% paginate ... by settings.* %}` in `collection-snippet.liquid:40`, `blog.liquid:13`, `search.liquid:28`, `search.filter.liquid:2`.
- **blog/article:** `blog.{handle,articles,articles_count,moderated?}`, `article.{title,url,image.src,content,author,published_at,comments[].{id,author,content,created_at},comments.size}` (`templates/article.liquid:82-126`, `snippets/article-item.liquid:11-41`).
- **customer/order/address/form/comment:** `customer.{id,email,name,first_name,last_name,gender,phone,default_address.{phone,address1,ward,district,province},new_address}`, `order.name` (`snippets/shop-breadcrumb.liquid:81`), `form.{errors|default_errors,name,email,phone,body,id,last_name}`, `comment.created_at` — across `templates/customers[*].liquid`, `snippets/shop-modal-*.liquid`.
- **Tags:** `{% include %}` (incl. `with`/`key: val` params **and dynamic names**), `{% paginate %}`, `{% form '<type>' %}` (`contact`, `customer`, `customer_login`, `recover_customer_password`, `create_customer`, `activate_customer_password`, `reset_customer_password`, `customer_address`, `new_comment`), `{% layout none %}`, `{% capture %}`, `{% case/when %}`, `{% for ... limit: %}`, `{% unless %}`, `{% if/elsif/else %}`, `{% assign %}`. **No `{% schema %}`, no `{% render %}`, no `{% section %}`** (grep + dir listing).
- **Filters:** `asset_url`, `img_url`/`product_img_url`/`collection_img_url` (size args), `haravan_asset_url` (`snippets/master-include.liquid:156-157`), `money`, `money_without_currency`, `default`, `escape`, `strip_html`, `strip_newlines`, `truncatewords`, `replace`, `remove`, `split`, `join`, `first`, `last`, `size`, `contains`, `date`, `handleize`, `plus`, `minus`, `times`, `divided_by`, `round`, `append`, `newline_to_br`, `strip`, `json`, `default_errors`.
- **Haravan/DotLiquid quirks a local engine must survive:** `_blank` literal comparisons (`snippets/footer_s1.liquid:11`, `snippets/product-card.liquid:40`), dotless `x[y]z` access (`linklists[settings.x]links`, `blogs[h]articles`, `collections[h]products`), `{% include %}` caller-scope, `?view=` alternate templates (`cart.item`, `collection.{data,tab,pop_sale,article,vertical,horizontal,nofilter}`, `product.{style1-5,item_small,item_compare,article,viewed}`, `search.{filter,quickview,smart}`, `customers[account].orders`), `*.scss.liquid`/`*.js.liquid` assets compiled server-side and referenced as `*.scss.css`/`*.js` (`snippets/master-include.liquid:60-100`).
- **Server-side endpoints the rendered page calls:** `/cart.js`, `/cart/update.js`, `/cart/change`, `/collections/<h>?view=data`, `/search`, `/contact`, `/checkout` (`assets/cart.js.liquid:25-58`, `assets/main.js.liquid:121`, `assets/index.js.liquid:38`), plus third parties: `f1genz.com/ps.js` (`layout/theme.liquid:18`), `opensheet.elk.sh` (`snippets/home-store.liquid:1`), Mailchimp `settings.shop_mailChimp`, `ui-avatars.com`, `file/theme.hstatic.net`, `bizweb.dktcdn.net`, jsdelivr/cdnjs.

## 4. Harness options — what each proves and cannot prove

### (a) Serve/measure the live store URL

Bound tab to `https://hangquoctai.myharavan.com/` with `?themeid=1001357480` pinning (the CLI's own preview param, `docs/haravan/cli-operations-and-guards.md` section 5; phase-07 proved the platform honors it — 5 theme ids produced 4 distinct body hashes, and plain `/` is byte-identical to `?themeid=1001357480`). Run `theme.debug_bundle` / `theme.qa_validate` (route gate already fail-closed on URL/theme mismatch, `browser-capabilities.ts:1515-1525`) / `export_clean` snapshots / `visual.compare` baselines.

- **Proves:** the *published* theme renders clean — zero Liquid error, assets resolve, no overflow, HS rules, route identity, pixel/structural drift vs baseline. Real renderer, real data, real CDN.
- **Cannot prove:** anything about uncommitted `Storefront/` edits (the store serves remote bytes); include-level/template-logic correctness beyond what the DOM shows; that the served theme is 1001357480 without the `?themeid=` hash discipline (`probe-theme-identity.mjs:95` prints `IDENTITY_UNVERIFIED` by design).

### (b) Local Liquid render (liquidjs + fixture object model)

Pattern exists at `plans/reports/_render-home.mjs` (engine borrowed from the sibling CLI repo; include-inlining for caller scope; ~30 registered filters; fixture-driven context).

- **Proves:** template-logic/data-binding correctness — missing snippets, dead settings, broken control flow, dynamic-include resolution — as *labeled diagnostic evidence*.
- **Cannot prove (hard limits):** DotLiquid semantics (`_blank`, `x[y]z`, include scope are *emulated*, not executed); `{% form %}`/`{% paginate %}`/`content_for_header` runtime behavior; `*.scss.liquid` compilation; AJAX endpoints; real store data. **Plan-forbidden as a PASS source** (`phase-07-measurement-layer.md:73`). Also requires either adding liquidjs to `package.json` or depending on the sibling repo path — neither is currently wired.

### (c) Push to a dev theme and measure

The only path that proves the working tree under the real DotLiquid renderer.

- **Blockers:** theme 1001357480 is the live `main` theme — `hrv theme push` refuses `role === "main"` fail-closed (`docs/haravan/cli-operations-and-guards.md` section 3 gate 5), so a *separate unpublished* theme id is required; any push is a real remote mutation needing **explicit user approval** (`phase-07:76`); `hrv theme dev` is push-on-watch, not a local server.
- **Existing machinery:** `haravan-sync-barrier.ts` already provides deterministic upload-acknowledgment gating (`:1-20`); `fetch-haravan-theme-safe.mjs` refuses to write a watched dir (`:190-200`).
- **Cannot prove without:** an unpublished theme id + approval + a running watcher. Until then working-tree verdicts must be `BLOCKED`-named, never mocked.

## 5. Recommended harness shape and location

**Shape — three honest layers, verdicts labeled by evidence tier:**

1. **Layer 0 — offline source gate (runnable today, zero browser):** `node scripts/theme-checks.mjs --theme Storefront --platform haravan` + `node scripts/lint-haravan-theme.mjs --theme Storefront`. Proves declarations/bindings/assets/Haravan contracts; cannot prove rendering.
2. **Layer 1 — live-published measurement (read-only, no approval needed):** bound tab to `?themeid=1001357480` route set (home, collection, product, cart, search, blog, article + `?view=` AJAX endpoints); `theme.debug_bundle` per route; `export_clean` snapshots revision-bound (sha256 + themeid + timestamp); `theme.qa_validate` with `expectedUrl`; `visual.compare` baselines. Verdicts labeled `LIVE_PUBLISHED`.
3. **Layer 2 — working-tree truth (gated):** user-approved unpublished theme + `hrv theme dev` + `haravan-sync-barrier`, then the Layer-1 suite against `?themeid=<devId>`. Until approved: `BLOCKED` with the named prerequisite.
4. liquidjs local render allowed **only** as a labeled diagnostic — never a PASS input (plan rule, phase-07:73).

**Location (repo conventions):** modules under `scripts/theme-harness/` (mirrors the `scripts/goal/` subdir precedent; shared pure logic in `scripts/lib/` per `theme-checks.mjs`, `atomic-record.mjs`); a thin runner `scripts/run-theme-harness.mjs` + npm script (matches `run-theme-golden-live-proof.cjs` / `smoke:theme-golden-live`); tests `test/unit/theme-harness-*.test.mjs` (matches `test/unit/theme-*.test.mjs` convention); evidence under `.canary/theme-harness/` (canary-evidence convention) with human reports in `plans/<plan>/reports/`. Read `Storefront/.haravan-cli_local.json` for org/theme binding when present (it is `.gitignore`d — `Storefront/.gitignore:1-3` — so never hardcode or commit it; env override `HARAVAN_ORG_ID`/`HARAVAN_THEME_ID` matches `fetch-haravan-theme-safe.mjs:10-16`).

## 6. Explicitly NOT possible today

- **No real DotLiquid render of `Storefront/` on this machine** — no engine in deps, no CLI `serve`; the only local-render precedent borrows liquidjs from a sibling repo and is plan-classified as non-PASS evidence.
- **No proof of uncommitted working-tree edits** without a push path (user-approved unpublished theme) — the live store serves remote bytes only.
- **No theme-identity certification from HTTP alone** — `probe-theme-identity.mjs` refuses by design; only `?themeid=` hash comparison (phase-07 table) or the `theme.qa_validate` route gate attests the served theme.
- **`smoke-packaged-theme-developer.cjs` is not resumable as-is** — stale auth (`:1` TODO) and a hardcoded fixture; it never touched a theme.
