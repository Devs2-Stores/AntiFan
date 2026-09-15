# F1GENZ Orders (CheckOrders) — --ultra Deep Scout Report

## 1. Project & Directory

`E:\Work\apps\F1GENZ Orders` — production Haravan public app "F1GENZ CheckOrders": storefront customers check order status by phone + order code without accounts. Monorepo of three deployables plus QC artifacts:

- `server/` — NestJS 11 + Express + Prisma(Postgres) + ioredis, PM2 on DigitalOcean behind Cloudflare Tunnel (`api-checkorders.f1genz.dev`, port 3333).
- `client/` — React 18 + Vite + Ant Design admin dashboard on Cloudflare Pages (`checkorders.f1genz.dev`) with `functions/api/[[path]].js` transparent proxy.
- `storefront/` — full Haravan theme export used as demo/test harness; `settings_schema.json` carries only the app's two settings; `index.liquid` injects `embed.js`.
- `server/src/order-lookup/widget/order-lookup.liquid` — 1926-line self-contained widget served by the backend (not the theme).
- `plan.md`, `output/qc_sheet.csv`, `runs/260715-*/` — sheet-driven QC remediation workflow artifacts (Google Sheet → manifest → prioritized fixes → contract spec).
- `haravan-auth-flow-detail-final.md` — 1106-line v6.0 auth reference cloned from F1GENZ MultiLanguage; the shared F1GENZ app skeleton.
- `deploy-digitalocean-pm2-cloudflare.md` + `server/.github/workflows/deploy.yml` — PM2/tunnel/Pages deploy contract with health-gated SSH workflow.

## 2. Architecture & Role

**Auth/install**: `GET /api/oauth/install/login` → Haravan authorize (login scope `openid profile email org userinfo`) → callback exchanges code → `verifyIdToken` (JWKS RS256/384/512, iss/aud/exp/nbf/iat/nonce, 60s skew) → if installed, issue custom HS256 session JWT delivered via URL hash fragment; else redirect to install flow (`com.read_orders com.read_shop grant_service offline_access`) → `installApp` stores RedisInstallData, subscribes webhooks, registers store. Haravan admin app-launch path: `verify-hmac` validates HMAC over the **original-order** raw query (dual candidates: decoded + raw pairs), optional 5-min timestamp check, shop↔orgid match → session token.

**Lookup pipeline** (`LookupService.lookup`): publicShop → domain index → `is_active` → origin validation (Origin or X-Store-Origin vs registered domains) → settings → input validation per `lookup_method` → 4-tier Redis rate limit (60/min IP, 200/min store, >120/h IP→Turnstile, >500/h IP→block) → `resolveAccessToken` (refresh-on-demand) → `HaravanOrderService.lookupOrders` → normalize (Vietnamese status maps, vi-VN price/date, tracking from fulfillments|shipping_lines) → mask (phone/email/address) → filterFields(visible_fields) → HMAC-hashed audit (Redis list 200-cap 7d + Postgres LookupEvent).

**Order fetch** (`HaravanOrderService`): Haravan `com/orders.json` has **no phone/order_number filter** → paginate `created_at_min` lookback 365d, limit=50, max 20 pages; 429 → Retry-After sleep, max 3 retries/page; 401 → `HARAVAN_TOKEN_INVALID`; in-app filter across 5 phone fields + name/order_number; if code ≥4 chars and no hit → deep fallback 3650d/80 pages; positive cache 180s, negative cache 45s, per-store telemetry key.

**Widget delivery**: `GET /api/order/widget/shop/:shop` reads the .liquid file, regex-replaces `{{ settings.f1g_order_api_url }}`/`{{ settings.f1g_order_shop }}` (tolerating `| default:` filters), injects `window.__f1gConfig` (settings + store_origins + turnstile_site_key), sets CSP `frame-ancestors 'self' + registered domains`. `embed.js` is generated per shop (300s public cache): creates fixed iframe (z-index 2147483647), handles trigger/popup/inline modes, `data-f1g-checkorders-open` theme-side trigger binding, postMessage bridge for popup state, height, and sequential `/cart/add.js` rebuy with requestId ack/done.

**Persistence split**: Redis = runtime truth (install session `haravan:checkorders:app_install:{orgid}`, store, settings, domain index, rate limits, caches, oauth_state hashed keys, refresh locks). Postgres = durable (encrypted tokens AES-256-GCM, ShopDomain unique index, SubscriptionSnapshot, LookupEvent HMAC hashes, WebhookEvent dedup `@@unique(topic,orgid,payloadHash)`). DB writes are fail-soft `logger.warn` EXCEPT `clearTokensForUninstall` which throws (fail-closed). `getInstallSession`/`getStoreByOrgId`/`getSettings` rehydrate Redis from DB on miss.

**Token lifecycle**: `resolveAccessToken` refreshes when expiring <30min or missing/suspicious expiry (`HARAVAN_ACCESS_TOKEN_MAX_EXPECTED_TTL_MS`, min 3y threshold); SET NX 30s lock + loser polls 10×500ms; `invalid_grant` → `haravan_token_status` + `needs_reinstall` (non-Pro); Pro apps (plan=pro | subscription active | status active/accepted/approved + valid expiry) get stale-token passthrough, no Redis TTL, never forced reinstall. Cron every 12h scans Redis + DB-only sessions, 500ms spacing.

**Webhooks** (`POST /api/oauth/install/webhooks`): raw-body HMAC-SHA256 vs `HRV_CLIENT_SECRET` OR `HRV_WEBHOOK_SECRET`, signature hex(64) or base64; topics: `app/uninstalled` → fail-closed token purge + domain index clear + deactivate (settings retained for reinstall); `shop/update` → additive domain re-index; `app_subscriptions/update` → status normalize (cancelled→canceled, inactive→unactive), active = status∈{active,accepted,approved} ∧ !canceled_at ∧ !expired, expiry keys incl. `billing_on` heuristic, Pro quota 500; unknown topics recorded as `ignored`. GET challenge endpoint supports `hub.verify_token`+`hub.challenge`. Auto-subscribe tries `webhook.haravan.com/api/subscribe` then legacy `com/webhooks.json` per-topic.

## 3. Load-bearing Files & Contracts

- `server/src/haravan/haravan.service.ts` (2203 lines) — OIDC login/install, JWKS id_token verify, HMAC launch verify, webhook handlers, token refresh w/ Redis lock, subscription sync, Pro/trial lifecycle.
- `server/src/order-lookup/services/lookup.service.ts` — Lookup orchestration: store → origin → settings → rate limit → Turnstile → token → fetch → normalize/mask/filter → audit.
- `server/src/order-lookup/services/haravan-order.service.ts` — com/orders.json paginator, in-app filter, deep fallback, pos/neg cache, telemetry.
- `server/src/order-lookup/services/store.service.ts` — Store registry + settings in Redis w/ Postgres fallback; domain→orgid index w/ stale cleanup; TRIAL_DAYS=15 (conflicts w/ 7d).
- `server/src/order-lookup/controllers/lookup.controller.ts` — POST lookup, widget HTML serve (regex liquid replace + __f1gConfig + CSP), per-shop embed.js generator + rebuy bridge.
- `server/src/order-lookup/controllers/admin.controller.ts` — Guarded settings GET/PUT, health, reconnect, widget-html preview.
- `server/src/order-lookup/widget/order-lookup.liquid` — Dual-use Liquid/standalone widget; postMessage protocol; Turnstile; /cart/add.js rebuy.
- `server/src/order-lookup/middleware/cors.middleware.ts` — Dynamic CORS: *.myharavan.com always, custom domains via Redis index, POST w/o Origin → 403.
- `server/src/common/guards/shop-auth.guard.ts` — Session-token auth (Bearer/cookie), orgid match, mutation origin check.
- `server/src/database/prisma.service.ts` — AES-256-GCM token crypto, upserts, fail-closed clearTokensForUninstall, HMAC audit, webhook dedup.
- `server/src/haravan/haravan.cron.ts` — 12h refresh cron, Redis+DB scan, needs_reinstall marking.
- `server/src/main.ts` — bodyParser:false + manual json w/ rawBody capture (webhook 256kb first), trust proxy, global CORS, prod env fail-fast.
- `server/prisma/schema.prisma` — Shop, AppInstall, ShopDomain, ShopSettings, SubscriptionSnapshot, LookupEvent, WebhookEvent.
- `server/src/order-lookup/order-lookup.contract.spec.ts` — Contract regression suite: phone norm, masking/filter privacy, embed.js generated-code asserts, liquid pattern asserts.
- `client/src/App.jsx`, `common/AuthStorage.js`, `config/AxiosConfig.js` — session_token via URL hash → triple-store; orgid+Bearer interceptor; 401→/install/login; idempotent retry.
- `client/functions/api/[[path]].js` — CF Pages transparent proxy → BACKEND_URL, X-Forwarded-Host/Proto/For.
- `storefront/` — Real Haravan export: settings_schema.json (2 app settings), index.liquid embed, 119KB settings.html + 239KB settings_data.json, plugin.js.liquid 188KB / plugin.css.liquid 169KB.

**Key contracts:**
- `RedisInstallData` (haravan.service.ts:44-67): tokens, token_expires_at, orgid/orgsub, 3 domain fields, status/plan/expires_at, quota_total/remaining, subscription_*, haravan_token_* error fields, reinstall_*.
- `StoreSettings`/`UpdateStoreSettingsDto`: widget_enabled, display_mode (inline|popup|trigger), trigger_action (modal|link), lookup_method (4 modes), visible_fields (9 options), max_orders 1-20, mask_*, theme colors hex6, widget_texts (23 whitelisted keys ≤180 chars), rebuy_enabled.
- `LookupRequestDto`: shop → bare hostname + regex; phone normalized (+84→0) `^\d{8,15}$`; order_code `^[A-Za-z0-9#-]{1,30}$` min 3.
- Session JWT: `{orgid, type:'haravan_app_session', iat, exp}` HS256 w/ APP_SESSION_SECRET (falls back to HRV_CLIENT_SECRET).
- postMessage protocol: `f1g_widget_popup_state`, `f1g_widget_trigger_open/close`, `f1g_widget_height`, `f1g_rebuy_add_to_cart`/`_ack`/`_done`, `f1g_preview_orders`/`f1g_preview_config` (preview only).
- WebhookEvent dedup `(topic, orgid, payloadHash)`; LookupEvent stores only HMAC hashes of ip/phone/orderCode.

## 4. Critical Edge Cases / Traps / Workarounds

1. **Haravan HMAC ≠ Shopify**: computed over original query order, not sorted — raw query preserved via `req.url.split('?')[1]`; dual message candidates (decoded + raw pairs) because Haravan's encoding is inconsistent.
2. **verifyHmac timestamp check passes when `timestamp` param is absent** (`if (timestampParam && ...)`) — replay window if Haravan omits it.
3. **Origin validation spoofable server-to-server**: `X-Forwarded-Host` and `X-Store-Origin` are client-controlled; non-browser clients can set Origin=store domain or spoof X-Forwarded-Host to satisfy both CORS middleware and `resolveValidationOrigin`. Residual protection = rate limits + Turnstile + needing victim's phone+order code. Browser Origin remains trustworthy.
4. **`trust proxy=1` + spoofable `X-Forwarded-For`** → `req.ip` takes leftmost value → IP rate-limit tiers bypassable by non-browser clients.
5. **refreshToken race**: cron and `resolveAccessToken` can refresh concurrently (lock only inside resolveAccessToken); Haravan rotates refresh tokens → loser writes stale token → next refresh gets `invalid_grant` → `needs_reinstall` cascade for non-Pro shops.
6. **Quota contract is dead**: `quota_total`/`quota_remaining` written on install/subscription but never decremented or enforced anywhere.
7. **filterFields always emits `customer_name` + `order_number`** regardless of `visible_fields` — PII-adjacent leak vs merchant's field config (order_number arguably required for rendering; customer_name is not).
8. **Trial length inconsistency**: `DEFAULT_TRIAL_MS` = 7d (haravan.service install) vs `TRIAL_DAYS` = 15 (store.service default expiry) vs admin fallback `addDaysIso(installed_at, 15)`.
9. **Pro escape hatches**: Pro sessions have no Redis TTL, return stale access_token on refresh failure, skip needs_reinstall — deliberate (paid apps must not lock out) but means a revoked Pro token keeps being served until Haravan 401s surface as `store_error`.
10. **Dual webhook HMAC secrets + dual encodings** — accepting `HRV_CLIENT_SECRET` widens forgery surface if it leaks (it's also the session-secret fallback).
11. **Widget .liquid dual-use**: same file is a Liquid template AND server-rendered via regex — regex must match `{{ settings.x | default: 'y' }}` variants; drift between the two regexes in lookup.controller vs admin.controller (admin's tolerates double quotes, widget's doesn't).
12. **`shop/update` domains are additive only** — removed domains stay indexed until uninstall.
13. **`embed.js` 300s public cache** — `widget_enabled=false` takes up to 5min to propagate; iframe already loaded keeps working (QC item #3 in csv).
14. **`pagesScanned` increments before empty-check; `orders.length < 50` break assumes page size** — if Haravan changes default limit the pagination math silently shifts.
15. **`publicShopIdentifier` strips `.myharavan.com`** — handle vs domain duality resolved by trying both candidates in `getStoreByPublicShop`.
16. **`consumeOAuthState` deletes before validating flow** — single-use even on failure (anti-brute-force, good).
17. **Session token transport**: URL hash fragment (never hits server/referer) → triple-store session+local+cookie (`SameSite=None; Secure` on https, `Domain=.hostname`) — cookie only reaches backend via Pages proxy, Bearer is the real mechanism.
18. **`recordWebhook` dedup is audit-level only** — handlers re-execute on redelivery before recording (uninstall is naturally idempotent; subscription sync is last-write-wins).
19. **`getInstallTtlSeconds`**: non-Pro Redis session TTL = app `expires_at` remaining (min 60s) else 30d — expired-app sessions self-evict.
20. **`upsertShop` ShopDomain.domain is globally unique** — domain reassignment silently moves a domain between shops (correct for domain moves, dangerous on data error).
21. **HARAVAN_TOKEN_INVALID detected by string compare** on Error.message — fragile contract.
22. **`f1g_widget_height` posts to `'*'`** — minor info leak (height only); other messages use strict origin.
23. **`OrderLookupCorsMiddleware` allows ALL `*.myharavan.com`** — any Haravan storefront can call lookup for any shop; the domain-match check inside `lookup()` is the real boundary (and see trap #3).
24. **`main.ts` global CORS allows `*.myharavan.com` + `*.f1genz.com` for ALL routes** — admin routes still require Bearer session token so impact is limited, but the allowlist is broader than needed.
25. **`sendWidget`/`getWidgetHtml` read .liquid from `__dirname/../widget` with `process.cwd()` fallback** — dev/prod path duality; nest-cli must copy the asset.
26. **`resolveWebhookOrgid` tries ~30 candidate fields** (headers, query, body.shop{}, body.resource{}, subscription{}) — Haravan webhook payload shapes are inconsistent across topics; defensive workaround worth encoding.
27. **`parseDateMs` treats numbers <1e12 as seconds** — mixed s/ms timestamp heuristic across Haravan payloads.
28. **`getSubscriptionExpiresAt` includes `billing_on`** — a future charge date treated as expiry; heuristic that can over/under-estimate.
29. **`incr` pipeline INCR+EXPIRE race** — EXPIRE may reset TTL on an already-TTL'd key → minor sliding-window drift.
30. **Client `App.jsx` strips session_token from hash after storing** — prevents referrer/history leak; `AuthStorage` triple-writes because embedded iframe contexts may block storage.

## 5. Concrete Improvements for Super Core (@antifan/super-core)

**Platform semantics (haravan) to record:**
- `com/orders.json` supports `created_at_min`, `limit`, `page` — NO phone/order_number/customer filters; in-app filtering + lookback pagination is the canonical workaround (365d/20p default, 3650d/80p deep fallback).
- App-launch HMAC = HMAC-SHA256(client_secret, original-order query minus hmac); webhook HMAC = HMAC-SHA256(secret, raw body) delivered hex or base64 in `x-haravan-hmacsha256|x-haravan-hmac`.
- OIDC: `accounts.haravan.com/connect/authorize|token`, RS256 JWKS, id_token carries `orgid`/`orgsub`; scopes `grant_service`, `offline_access`, `com.read_orders`, `com.read_shop`.
- Webhook subscribe: modern `webhook.haravan.com/api/subscribe {webhook_url, topics[]}` → legacy `com/webhooks.json` per-topic fallback; topics `app/uninstalled`, `shop/update`, `app_subscriptions/update`; challenge via `hub.verify_token`+`hub.challenge`.
- Identity fields: `orgid` (numeric string), `orgsub` (handle), `domain`/`primary_domain`/`myharavan_domain`; storefronts `*.myharavan.com` + custom domains; subscription status vocabulary {active, accepted, approved, cancelled→canceled, inactive→unactive, expired, declined}; expiry keys incl. `billing_on`; timestamps may be s or ms.
- `/cart/add.js` form-encoded POST + `X-Requested-With: XMLHttpRequest` for ajax cart (rebuy bridge pattern).

**Anti-patterns:** trusting orgid/shop from query/header without HMAC or session proof; sorting params before HMAC (Shopify habit); plaintext tokens at rest; forcing reinstall on refresh failure for paid plans; quota fields never decremented (dead contract); `KEYS` in production (use SCAN); timestamp freshness check that passes when param absent; trusting X-Forwarded-* without a pinned trusted-proxy list; regex-replacing Liquid placeholders as a rendering strategy without a shared compiler.

**Fix patterns (proven here):** `bodyParser:false` + per-route `express.json({verify:captureRawBody})` for webhook HMAC; dual-candidate HMAC messages; Redis `SET NX` refresh lock + loser poll; fail-closed uninstall purge in `$transaction` (throw on DB error) while all other DB writes are fail-soft; DB→Redis session rehydration; negative caching for not_found; domain index with stale-domain cleanup on re-register; HMAC-hashed PII in audit logs; webhook dedup via `@@unique(topic,orgid,payloadHash)`; contract spec asserting generated-JS bridge code + liquid source patterns.

**Workarounds:** ~30-field orgid resolution for inconsistent webhook payloads; dual webhook secrets during rotation; dual signature encodings; `billing_on` as expiry heuristic; suspicious-expiry guard (`HARAVAN_ACCESS_TOKEN_MAX_EXPECTED_TTL_MS`) for absurd token TTLs.

## 6. Concrete Improvements for Haravan Theme Core Output

- **App-settings schema group**: `settings_schema.json` pattern of exactly two text settings (`f1g_order_api_url`, `f1g_order_shop`) + paragraph — HaravanSchemaGenerator should support emitting app-integration groups and validate that templates guard on `!= blank` before injecting scripts (index.liquid pattern).
- **Conditional embed snippet**: `{%- if api != blank and shop != blank -%}<script src="{{ api }}/api/order/widget/shop/{{ shop | escape }}/embed.js" async>` — canonical minimal-footprint app embed; ThemeCompiler should emit this as a first-class embed node rather than raw script.
- **Dual-use Liquid contract**: the widget .liquid is both theme-include-able and server-rendered via regex — the settings contract should formalize `{{ settings.x | default: 'y' }}` output shapes so server-side replacement stays stable; flag drift risk (two divergent regexes already exist between lookup.controller and admin.controller).
- **`data-f1g-checkorders-open` trigger attribute**: theme-side contract for custom buttons; DOM sanitizer MUST preserve `data-*` attributes and must not strip `position:fixed`/`z-index:2147483647` iframe overlays injected by embed.js.
- **settings.html vs settings_schema.json duality**: storefront/config has BOTH (119KB legacy settings.html + schema json) — generator must detect which contract the target theme uses (F1GENZ = schema.json; legacy = settings.html) and never emit both.
- **CSP frame-ancestors from registered domains**: widget serving derives frame-ancestors from ShopDomain table — theme compiler's embed model should carry the multi-domain (myharavan + custom) storefront list.
- **postMessage bridge as component contract IR**: popup_state/trigger/height/rebuy messages between theme parent and app iframe — model as a typed message protocol in the component contract so clones keep the bridge intact.

## 7. Concrete Improvements for AntiFan Core & Site Clone

**AntiFan Core:**
- The `runs/` + `qc_sheet.csv` + `plan.md` + `order-lookup.contract.spec.ts` chain is a live example of the sheet→manifest→plan→contract-test remediation loop; model it as a first-class workflow (QC intake → prioritized fixes → contract assertions). `theme_qa_validate`/`theme_debug_bundle` map directly onto this app's QC items (widget hidden-state, timeline status, tracking visibility, field toggles, rebuy).
- Widget verification requires **cross-origin iframe tooling**: `evaluate_frame`, `inspect_snapshot` inside the widget iframe, plus nested third-party iframes (Turnstile). `frame-ancestors` CSP means test domains must be registered in ShopDomain or snapshots fail silently.
- `media.freeze` + `visual.compare` need the `f1g_widget_height` resize protocol — iframe height changes after render; capture must wait for height postMessage or measure scrollHeight inside frame.
- `verification.record_claim` fits the contract spec's assertions (generated-JS contains bridge code; liquid contains visibility gates) — persist these as claim types: `generated_source_contains`, `liquid_pattern_present`.
- `.antigravity/mcp-bridge` artifact shows this project already ran through the MCP bridge — keep bridge res.json artifacts as evidence receipts.

**Site Clone (@antifan/site-clone):**
- `storefront/` is a complete real Haravan export — ideal IR fixture: `layout/theme.liquid` (content_for_header/layout, {% include %} chains), `templates/product.style1-5.liquid` variant pattern, `snippets/shop-*` global modals/sidebars, `page.offline.liquid`/`offline.liquid.liquid`.
- Asset pipeline must handle **double extensions** (`.js.liquid`, `.css.liquid`, `.scss.liquid` — plugin.js.liquid is 188KB, plugin.css.liquid 169KB) and `{{ 'x' | asset_url }}` rewriting; `sw.js.liquid` service worker + `manifest.json` need special-casing in offline standalone mode (SW scope, manifest start_url).
- External scripts in theme.liquid (`f1genz.com/ps.js`, `client--currency-converter.pages.dev/*`, `<currency-converter>` custom element) — offline standalone must localize or stub third-party origins; DoD validator should flag unlocalized externals.
- **App-embed boundary decision**: clone must decide whether app-injected DOM (embed.js iframe, `[data-f1g-checkorders-open]` triggers) is part of the page IR or sanitized out — recommend modeling app iframes as explicit `external_embed` IR nodes with the postMessage contract attached, not as static DOM.
- `settings_data.json` (239KB) vs `settings_schema.json` (566B app-only) — IR should separate merchant data from schema; the demo theme's schema was replaced by the app's, which would lose original theme settings on clone — detect and warn on schema replacement.
- `templates/index.liquid` shows the app embed is opt-in via settings — clone DoD should verify embed absence/presence matches settings state, not just DOM shape.

## 8. Cross-cutting Observations

- `haravan-auth-flow-detail-final.md` (v6.0, cloned from MultiLanguage) proves all F1GENZ Haravan apps share one auth skeleton — Super Core should hold this as an archetype ("f1genz-haravan-app") with the 10 mandatory principles as rules.
- The codebase is unusually disciplined (raw-body HMAC, fail-closed uninstall, PII hashing, contract spec) — the genuine gaps are: unenforced quota, spoofable non-browser origin chain, absent-timestamp replay window, refresh race, customer_name leak, 7d-vs-15d trial drift.
