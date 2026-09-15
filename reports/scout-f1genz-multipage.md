# Scout Report — F1GENZ Multipage (--ultra)

## 1. Project & Directory

- **Path:** `E:\Work\apps\F1GENZ Multipage`
- **Kind:** Haravan embedded app ("fxpage" landing-page builder). `.workspace-context.json`: `{kind: app, platform: haravan, branch: f1genz, verification: verified}`.
- **Repo shape:** umbrella repo with two git submodules — `client/` (github.com/F1GENZ/Haravan-Client--Multipage) and `server/` (github.com/F1GENZ/Haravan-Server--Multipage) — plus `demo/` theme assets, `scripts/`, `docs/`, `.agent/workflows/multipage-dev.md`.
- **Purpose:** merchant picks a Haravan `page` whose `template_suffix`/`key` contains `fxpage`, edits settings in a React sidebar, settings persist to a page metafield (`namespace=fxpage, key=settings, value_type=json`), and a standalone Liquid page template renders the landing page from `page.metafields.fxpage.settings.value`.

## 2. Architecture & Role

```
Browser (multipage.f1genz.com, Cloudflare Pages)
  React 19 SPA (Vite, antd 5, TanStack Query, Tailwind 4)
  ├─ Builder panel: schema-driven settings form
  └─ Preview: dual-iframe buffer, src=/api/shop/preview?... (same-origin)
        │
        ▼  Cloudflare Pages Function  client/functions/api/[[path]].js
        │  transparent proxy → BACKEND_URL (env), sets X-Forwarded-Host
        ▼
api-haravan-multipage.f1genz.dev (Cloudflare Tunnel → DO VPS, PM2)
  NestJS 11 (port 3333, global prefix /api)
  ├─ haravan/    OAuth login+install, HMAC verify, refresh, 12h cron
  ├─ metafield/  GET/PUT /api/pages/:id/settings, /template
  ├─ template/   GET /api/templates, /api/templates/:handle (schema from theme assets)
  ├─ shop/       GET /api/shop, GET /api/shop/preview (HTML proxy + script injection)
  ├─ resource/   GET /api/resources/blogs (only)
  ├─ diagnostics/GET /api/diagnostics (ShopAuthGuard + x-diagnostics-token)
  └─ redis/      ioredis, JSON values, keys haravan:multipage:*
```

**Data contract:** page metafield `fxpage.settings` (JSON, flat `fxpageNN_*` keys) + `fxpage.template` (string). Theme assets `assets/page.fxpage.{handle}.json` hold the builder schema; `templates/page.fxpage.{handle}.liquid` + `templates/search.fxpage.liquid` render storefront output.

## 3. Load-bearing Files & Inspected Contracts

|File|Contract|
|---|---|
|`server/src/shop/shop.controller.ts` (666 lines)|`GET /api/shop/preview`: SSRF domain allowlist → Redis cache (45s, key `haravan:multipage:preview_html:{orgid}:{url}`) → fetch storefront HTML → `stripPreviewTelemetryScripts` → `injectPreviewNetworkGuard` → `injectPreviewBridge` → `injectPreviewBaseHref` → strip `X-Frame-Options`, set `CSP frame-ancestors *`. `_cb`/`_ts` params bypass cache but are still forwarded upstream.|
|`server/src/common/fxpage-settings.util.ts`|`prepareSettingsForStorage/Builder`: recursive sanitize (sanitize-html, 15-tag allowlist, `SAFE_HREF_PATTERN`, `SAFE_COLOR_PATTERN`) + `normalizeTemplate01Aliases` (mirrors `fxpage01_*`↔`fxpage02_*` keys both directions) + `normalizeTemplate01Schema` (rewrites `fxpage02_` ids → `fxpage01_`).|
|`server/src/metafield/metafield.service.ts`|Save path: update existing metafield; on HTTP 422 `"value_type is not included in the list"` → **delete + recreate as `value_type: json`** (Haravan can't change value_type in place).|
|`server/src/haravan/haravan.service.ts` (848 lines)|OAuth install/login/refresh; `verifyHmac` tries **4 canonicalizations** (original/sorted × decoded/raw) × 3 secrets (`HRV_HMAC_SECRET`, `HARAVAN_APP_SECRET`, `HRV_CLIENT_SECRET`), `timingSafeEqual`, ±300s timestamp window, blocked-status rejection, orgid resolution via `haravan:multipage:shop_orgid:{domain}` index with `redis.keys` fallback scan.|
|`server/src/common/guards/shop-auth.guard.ts`|Session JWT (`type=haravan_app_session`, `APP_SESSION_SECRET` fallback `HRV_CLIENT_SECRET`, 12h TTL) → orgid match → Redis install → auto-refresh Haravan token when <30min to expiry.|
|`server/src/template/template.service.ts`|Active theme = `role==='main'`, cached 300s/orgid; templates discovered by scanning theme assets for `page.fxpage.*.json`; schema asset key `assets/page.fxpage.{handle}.json`.|
|`server/src/diagnostics/diagnostics.service.ts`|8-check health panel: redis install, app status, token expiry, shop API, main theme, fxpage assets (`templates/search.fxpage.liquid` + schema count), template-schema coverage vs pages, storefront `/search?view=fxpage` + `/collections.json` reachability+CORS, blogs API.|
|`client/src/pages/builder/index.jsx` (893 lines)|Dual-iframe buffer (A/B slots, z-index swap), content-fingerprint polling after save (DJB2 hash of sanitized `<body>`, 2s min / 60s max, 500→800ms intervals), scroll restore (direct `scrollTo` + postMessage, retries at rAF/300ms/800ms), nav guard inside iframe (block clicks/submits/`window.open`), Ctrl+S bridge, BroadcastChannel multi-tab conflict notice, beforeunload dirty guard.|
|`client/src/pages/builder/adapters/{index,template01,03,04}.js`|Per-template DOM patchers (7 primitives: setText/setHtml/setHref/setImage/setBackgroundImage/setVisible/setCssVar) + `SERVER_RENDERED_SETTINGS` sets flagging Liquid-bound fields that need Save.|
|`client/src/common/ApiService.js`|Storefront-direct fetchers: `/search?view=fxpage` (linklists/collections/products/articles/pages JSON), `/collections.json?limit=250`; promise-cache Map with TTLs (90s/5min/2min); `parseStorefrontJson` strips malformed `"id": ,` and BOM.|
|`client/src/common/richTextSanitizer.js`|DOMPurify + post-pass DOM walk: allowlist tags, href protocol check, color regex, `rel="noopener noreferrer"` forced.|
|`client/src/common/authStorage.js` + `config/AxiosConfig.js`|`orgid`/`auth_verified`/`auth_session_token` in local+session storage; axios injects `x-orgid`+`orgid` headers + `orgid` query param + Bearer; 401 → remember redirect → clear → `/install/login`.|
|`client/functions/api/[[path]].js`|Pages Function catch-all proxy; `BACKEND_URL` env with hardcoded fallback.|
|`demo/templates/*.liquid` + `demo/assets/page.fxpage.*.json`|Standalone `{% layout none %}` templates reading `page.metafields.fxpage.settings.value`; `search.fxpage.liquid` emits JSON (products/articles/pages when results, linklists/collections when empty).|
|`server/scripts/push-*.js`, `scripts/push-template02-flat.ps1`|Metafield seeding scripts (discover resources → build flat `fxpageNN_*` map → PUT metafield).|

## 4. Critical Edge Cases / Traps / Workarounds Found

1. **fxpage01↔fxpage02 alias hack.** `page.fxpage.template01.liquid` reads `config.fxpage02_*` keys while its schema `page.fxpage.template01.json` declares `fxpage01_*` ids. `normalizeTemplate01Aliases` writes BOTH prefixes into the metafield (payload doubles) and `normalizeTemplate01Schema` rewrites schema ids. Any consumer of `fxpage.settings` must tolerate dual keys. Root cause: template01.liquid is a fork of template02.liquid that kept `fxpage02` config keys.
2. **Dead SSRF code.** `shop.controller.ts` ~line 540: `const SAFE_SUFFIXES=[...]; const isSafeDomain = true;` — the suffix check is hardcoded true, making `isShopDomain` and the second 403 block dead code. The real protection is the earlier `getAllowedDomains` check (shop.domain/primary_domain/myharavan_domain/orgsub.myharavan.com). Leftover from refactor.
3. **Bridge script is template01-only.** `PREVIEW_BRIDGE_SCRIPT`'s `applyTemplate01Settings` hardcodes `.fxpage01-*` selectors — postMessage live-preview channel silently no-ops for template03/04 (only the same-origin direct-DOM adapters work). If the preview ever goes cross-origin again, 03/04 lose live preview entirely.
4. **postMessage origin asymmetry.** Bridge checks `event.origin !== window.location.origin` (works only because Pages proxy makes iframe same-origin); parent posts with `'*'`. Any origin drift silently kills the bridge channel.
5. **Session token in iframe URL query.** `buildPreviewSrc` appends `session_token` to the preview URL → JWT lands in server access logs and browser history (the cached Redis key uses the target URL, not the endpoint URL, so cache keys are clean — the leak is via logs/referrer).
6. **Haravan metafield value_type immutability.** Updating a metafield whose `value_type` isn't `json` → 422 `"value_type is not included in the list"` → workaround deletes and recreates. Any writer must implement this fallback or saves fail permanently.
7. **Haravan HMAC ≠ Shopify.** Message uses **original query order**, not sorted. Code tries 4 candidate canonicalizations × 3 secrets — a proven multi-candidate pattern worth codifying. Timestamp ±300s enforced.
8. **Storefront JSON endpoints are unofficial.** `/search?view=fxpage` (custom template emitting JSON via `{% layout none %}`) and `/collections.json` are fetched **directly from the browser** — works only because Haravan storefronts send permissive CORS. `docs/haravan-auth-flow-detail.md` §8 documents a `/api/resources/storefront` server proxy that **does not exist** in code (only `/api/resources/blogs`) — doc/code drift.
9. **Malformed storefront JSON.** Haravan emits `"id": ,` (empty value) and BOM; both client `parseStorefrontJson` and server diagnostics regex-strip before `JSON.parse`.
10. **Metafield propagation delay.** After PUT, storefront HTML lags — builder polls a content fingerprint (DJB2 hash of body minus scripts/styles/csrf/nonces/cache-busters) up to 60s before reloading the preview iframe. `_cb`/`_ts` cache-bust params bypass the 45s Redis HTML cache.
11. **Regex HTML rewriting limits.** `stripPreviewTelemetryScripts` (10 regexes) can over-strip any inline script mentioning `cdn-cgi/rum`; `injectPreviewBaseHref` sets `<base href="{origin}/">` which breaks relative links on pages not at root; mitigated by runtime network guard (fetch/XHR/sendBeacon/appendChild/insertBefore/MutationObserver monkey-patches) — defense-in-depth pattern: strip at proxy AND guard at runtime.
12. **Scroll restore needs 3 retries.** Haravan page JS re-scrolls to top after load; retries at rAF, +300ms, +800ms, plus `history.scrollRestoration='manual'` in the guard and sessionStorage snapshot keyed by target URL.
13. **Cron uses `redis.keys()`.** `haravan.cron.ts` scans `haravan:multipage:app_install:*` every 12h and refreshes serially with 500ms sleep; failed refresh marks `status='needs_reinstall'`. KEYS is an anti-pattern at scale.
14. **Deploy port mismatch.** `main.ts` listens on `PORT||3333`; deploy doc says PM2 port 3020 and `deploy.yml` passes `-- --port=3020` (an arg `main.ts` never reads). Actual port depends on env `PORT` — undocumented drift.
15. **Liquid tag corruption in template04.** `page.fxpage.template04.liquid` ~lines 185-198: `{ % if config.fxpage04_hero_bg % }` — tag delimiters split by whitespace/newline so Liquid renders them literally; both branches emit identical CSS so it's visually harmless but a real template bug a validator should catch (`/\{\s+%|%\s*\}/`).
16. **Auth storage dual-write.** orgid/token written to BOTH localStorage and sessionStorage; `syncAuthSession` reconciles — legacy sessions without `auth_session_token` are auto-cleared.
17. **Axios 401 handler returns `new Promise(()=>{})`** — a never-resolving promise after redirect to keep the app from continuing; deliberate but surprising.
18. **XHR block hack.** Network guard rewrites blocked XHR `open()` to `GET about:blank` — returns HTML instead of failing cleanly; scripts expecting JSON may throw downstream.
19. **Iframe nav guard is client-side only.** `installPreviewNavigationGuard` attaches click/submit/`window.open` blockers via `contentDocument` — requires same-origin; cross-origin fallback is only the bridge's weaker coverage.
20. **Schema `default` semantics.** `SettingsRenderer` uses `setting.default` when value undefined — meaning defaults are display-only and NOT persisted unless user touches the field; saved metafield can lack keys the Liquid relies on (templates must `| default:` everything — template04 does, template01 relies on alias+defaults inconsistently).

## 5. Concrete Improvements for Super Core

**New platform semantics (haravan):**
- `metafield.value_type` is immutable post-create; update with wrong type → 422 `value_type is not included in the list`; fix = delete+recreate (proven in `metafield.service.ts`).
- HMAC launch verification: original query order, NOT sorted; multi-secret + multi-canonicalization candidates; ±300s timestamp.
- `search?view={custom}` + `templates/search.{custom}.liquid` with `{% layout none %}` = free JSON endpoint (linklists/collections/search results); `/collections.json` native; both CORS-permissive but unofficial — prefer server proxy for production.
- Storefront JSON can be malformed (`"id": ,`, BOM) — sanitize before parse.
- Theme assets API: `GET /web/themes.json` (role `main`), `GET /web/themes/{id}/assets.json`, `GET .../assets.json?asset[key]={key}`; page metafields via `POST /com/metafields.json` with `owner_resource:'page', owner_id` in body (not nested URL).
- Metafield→storefront propagation is eventually consistent (seconds); poll a content fingerprint rather than fixed sleep.

**Anti-patterns:**
- `redis.keys()` in cron/request path (use SCAN).
- JWT/session token in URL query params (leaks to logs/history).
- Regex-only HTML sanitization without runtime guard.
- Hardcoded `isSafeDomain = true` beside a real allowlist — dead security code that looks live.
- Dual-prefix settings aliases doubling metafield payloads — version prefixes at schema-generation time instead.
- Doc'd endpoints that don't exist (`/api/resources/storefront`) — contract drift.

**Fix patterns:**
- Same-origin iframe preview: Cloudflare Pages Function `[[path]].js` catch-all proxy (Pages+Tunnel can't share a hostname — CNAME conflict).
- Dual-iframe double-buffer swap for flicker-free reload.
- Defense-in-depth preview sanitization: proxy-side strip + injected runtime network guard (fetch/XHR/beacon/DOM-insertion/MutationObserver).
- Scroll restore: snapshot via postMessage + sessionStorage + `history.scrollRestoration='manual'` + triple-retry apply.
- Post-save propagation wait: fingerprint poll (hash body minus volatile nodes) with min/max bounds.
- Multi-candidate HMAC verification (order × encoding × secret matrix, timingSafeEqual).
- Structured auth event logging (`[auth] event={json}`) with token redaction.

**Workarounds:**
- 422 value_type → delete+recreate metafield.
- `{% layout none %}` JSON templates for resource pickers.
- `parseStorefrontJson` regex repair for `"id": ,`/BOM.
- `xhrOpen` redirect to `about:blank` for blocked telemetry.

## 6. Concrete Improvements for Haravan Theme Core Output

1. **Emit a `server_rendered` flag in generated schema.** Multipage hand-maintains `SERVER_RENDERED_SETTINGS` per template (menu/collection/product/blog/article/limit/countdown/toast fields). ThemeCompiler/HaravanSchemaGenerator can derive this mechanically: a setting id referenced inside `{% for %}`, `{% assign %}`, `linklists[]`, `collections[]`, `blogs[]`, `articles[]`, `paginate`, or `all_products` Liquid expressions is server-rendered; everything else is DOM-patchable. Emit `server_rendered: true` in the schema JSON → builders mark "Cần lưu" automatically instead of hardcoded sets.
2. **Generate the DOM-binding contract, not just settings.** Multipage's adapters are hand-written selector→setting maps (duplicated 3×: bridge script + per-template adapters). A `bindings` array in the schema (`{id, selector, patch: text|html|href|src|bg|visible|cssvar|attr}`) would let ThemeCompiler generate live-preview adapters mechanically — the 7 primitives are already a closed set.
3. **Version setting-id prefixes at generation time.** The `fxpage01`/`fxpage02` alias hack exists because a forked template kept old keys. HaravanSchemaGenerator should own prefix allocation (`fxpageNN_`) and refuse collisions, eliminating dual-key metafields.
4. **Enforce `| default:` coverage.** Schema `default` is display-only in the builder; templates must default every `config.*` read. A ThemeCompiler lint rule: every `config.<id>` output without `| default` (or explicit `{% if %}` guard) → warn. template04 does this right; template01/02 are inconsistent.
5. **Liquid tag integrity check.** Catch split delimiters `{ % ... % }` (template04 bug) — regex `/\{\s+%|%\s*\}/` over generated templates.
6. **Ship the `search.fxpage.liquid` JSON endpoint as a first-class template artifact.** It's the load-bearing resource-discovery surface (linklists/collections/products/articles/pages) — ThemeCompiler should emit it alongside page templates, plus the `{% layout none %}` + JSON-escape discipline (`| escape`, manual separators, `paginate` guard).
7. **Settings contract: flat `fxpageNN_*` keys + `value_type: json` metafield + sanitize pipeline.** Port `fxpage-settings.util.ts` semantics (15-tag allowlist, href protocol regex, color regex, noopener transform) into the theme output's documented settings contract so app and theme agree on what HTML is legal.
8. **Template-suffix discovery convention.** Pages qualify via `key==='fxpage'` OR `template_suffix` containing `fxpage`; schema assets live at `assets/page.fxpage.{handle}.json`. ThemeCompiler should emit both the template and its schema asset under this exact naming to stay compatible with the installed builder base.

## 7. Concrete Improvements for AntiFan Core & Site Clone

**AntiFan Core (Desktop browser / CDP / sanitization / verification):**
- **Adopt the preview network-guard script as a reusable capture primitive.** `PREVIEW_NETWORK_GUARD_SCRIPT` (fetch/XHR/sendBeacon/appendChild/insertBefore/MutationObserver blocking + `history.scrollRestoration='manual'`) is a proven, self-contained IIFE for deterministic page capture — directly reusable for SnapDOM/clone determinism beyond Cloudflare beacons (parameterize the BLOCKED_SRC regex).
- **Content-fingerprint = verification-claim evidence.** `extractContentFingerprint` (body minus scripts/styles/csrf/nonce/cache-busters, DJB2 hash) is exactly the "did the storefront actually change" proof AntiFan's `verification.record_claim`/`verify_claim` could use as a receipt type for save-propagation claims.
- **Dual-channel iframe control.** postMessage bridge + same-origin direct DOM patch with graceful degradation — the same pattern AntiFan's tab automation should prefer (postMessage works cross-origin, DOM patch is instant same-origin).
- **Diagnostics panel → `theme.debug_bundle` parity.** Multipage's 8-check diagnostics (install, token, theme, assets, schema coverage, storefront endpoints, CORS, latency) is a proven checklist shape for storefront health bundles.
- **Nav-guard injection for preview tabs.** Blocking link clicks/submits/`window.open` inside a preview iframe (with user notice) is a small reusable interaction-lock pattern.

**Site Clone (@antifan/site-clone):**
- **IR model: schema JSON ≈ component contract.** `page.fxpage.{handle}.json` (sections → settings with type/id/label/default/options/min/max) is a working component-contract IR already deployed in production. Site Clone's IR should add what Multipage lacks: explicit `bindings` (selector+patch kind), `server_rendered` flags, and per-setting `default` semantics (display vs persisted).
- **Standalone offline mode precedent.** `page.fxpage.*.liquid` templates are fully self-contained (`{% layout none %}`, inline CSS/JS, zero theme dependencies, config from one metafield) — proof that single-file standalone pages work on Haravan; Site Clone's offline standalone mode can target the same shape.
- **Asset pipeline: image settings are raw URLs.** `image_picker` values are CDN URL strings (hstatic), not asset keys — clone pipeline must handle external-URL localization, and the `ImagePickerField` ≥3000px warning is a nice validation to copy.
- **DoD validator checks to adopt:** (a) every schema id has a DOM binding or is flagged server-rendered; (b) every `config.*` Liquid read has a default; (c) no split Liquid delimiters; (d) settings payload survives the sanitize allowlist; (e) JSON endpoints parse after `"id": ,`/BOM repair.
- **Reuse the proxy-strip+guard pair for clone capture.** `stripPreviewTelemetryScripts` + network guard + `<base href>` injection is a complete recipe for producing a clean, self-contained, iframe-safe HTML snapshot — directly maps to `theme.export_clean`/offline standalone generation.
- **Selector fragility lesson.** Multipage's adapters break silently when templates rename classes (`.fxpage01-*` hardcoded in 3 places). Site Clone's IR should generate bindings from the same source that emits the markup — single source of truth for selectors.
