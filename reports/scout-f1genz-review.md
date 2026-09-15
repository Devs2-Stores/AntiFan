# Scout Report — F1GENZ_Review (E:\Work\apps\F1GENZ_Review)

## 1. Project & Directory

`E:\Work\apps\F1GENZ_Review` — production Haravan review/Q&A app ("F1GENZ Review"). Monorepo, no workspaces; root `package.json` orchestrates `verify` (client build+budget+smoke → server build+lint+jest → worker test) and `push:f1genz`.

Sub-projects:
- `client/` — embedded admin SPA (Cloudflare Pages): React 19, Vite 6, antd 5, TanStack Query, Tailwind 4.
- `server/` — public/admin API + queue workers: NestJS 11, Express 5, BullMQ+ioredis, pg (Supabase/Postgres), axios.
- `worker/` — R2 upload proxy `f1genz-r2-upload`: CF Worker, R2 binding `f1genz-images`, CDN `images.f1genz.dev`.
- `server/storefront/snippets/` — storefront runtime served at `/storefront/*`: `f1genz-storefront.js` (139 KB, 3288 lines), `f1genz-storefront.css` (34 KB), `f1genz-product-schema.liquid`.
- `docs/` — Mintlify docs, `router-guide.md`, auth-flow detail, ops runbooks.
- `plans/` — `260912-1230-f1genz-super-heavy-tiers` (3-tier gating), `260909-1400-internal-api-security-hardening`, `260827-1400-google-review-schema-architecture`, `260707-1318-haravan-to-sapo-migration`.

## 2. Architecture & Role

Shopper browser → `<f1genz-*>` custom elements → apiUrl from `shop.metafields.f1genz.config` (published by server on install) → `/storefront/f1genz-storefront.{js,css}` (Cache-Control max-age=300 swr=300) + `/api/public/reviews|qna|media/*` (anonymous, orgid header, dual-bucket throttle) → NestJS → Postgres + Redis + Haravan REST (`apis.haravan.com/com`) + CF Worker → R2.

BullMQ queues: `webhook` (inbound), `review-metafield-sync`, `qna-metafield-sync`, `catalog-sync`, `review-import`, `ai-generation`, `outbound-webhook`.

**Postgres is source of truth; metafields are an async projection.** Every review/QnA mutation writes DB rows + durable `review_metafield_pending` marker in the same transaction, then enqueues a sync job (6 attempts, exp 10 s). A shop-level job pages product ids (500/page) and drains the pending table — repair path for lost enqueues.

**Tier model** (`plan-tiers.ts`): `free|super|super_heavy`. Features: `core_widgets, video_lightbox, qna, seo_schema, curated_slider, ai_highlights, smart_reply, ai_seeds, outbound_webhooks`; only `super_heavy` unlocks the last five. `free` ⇒ `watermark:true`. Trial (status `trial`, tier `free`, in-window or unreadable `expires_at` ⇒ fallback `installed_at+14d`) resolves as `super`. `resolveTierFromSubscription`: plan-id list → name contains "heavy" → price ≥250000 → default `super` (warn log).

**PROCESS_ROLE split**: `api` vs `worker`; `shouldStartQueueWorkers()` gates every BullMQ Worker; 12 h cron sweep (token refresh + subscription sync + auto-sync) runs only on `api`/unset.

## 3. Load-bearing Files & Contracts

### Metafield contract — `server/src/review/review-metafield.service.ts` (666 lines)
- Namespace `reviews` product metafields: `summary` (json, admin: counts all non-hidden incl. pending); `public_summary` (json, approved only — badge SSR reads `product.metafields.reviews.public_summary.value.{avg,count}`); `chunk_N` (string, public approved-only, `status` stripped); `data_chunk_N` (string, all statuses). Read prefers `data_chunk_*`, falls back to `chunk_*` treating missing `status` as `approved`.
- Namespace `f1genz_reviews` (dual-write, warn-only on failure): `summary` = `{count,avg,updated_at}` for SSR Liquid schema; `slider_data` = `{v:1,updated_at,items:[{id,r,a,t?,c,m?,v,d}]}` — written only when `sliderEligible` defined; `true` ⇒ top-15 shrunk to ≤8000 B (c:220→160→120, drop `t`, pop items); `false` ⇒ empty purge on downgrade.
- `CHUNK_SIZE_LIMIT=60000` (headroom under ~80 KB cap). `writeChunkSet` creates/updates `prefix+N` and **deletes excess old chunks**. Read cache `cache:reviews:data:{sha1(token)[:16]}:{productId}` TTL 120 s — token-derived key self-invalidates on rotation. `writeStorefrontMetafields` throws when `sliderEligible===undefined` → job retries.
- `qna-metafield.service.ts`: same pattern, namespace `qna`, `summary={total,answered,unanswered}`.

### Haravan API — `server/src/haravan/haravan.api.ts`
- `getProductMetafields` paginates 250×20, **filters namespace client-side — "Haravan may ignore namespace filter"** (~line 426). `assertNumericId` on all path ids. `value_type:'json'` ⇒ stringified value.
- Throttling: foreground 3 concurrent, background 1 concurrent + 1200 ms spacing via `AsyncLocalStorage` (`runBackground`); 429 → `retry-after`, ≤5 retries, separate global/background cooldowns.
- `subscribeConnectWebhook` → `https://webhook.haravan.com/api/subscribe` (connect-webhook endpoint, not REST).

### Storefront runtime — `server/storefront/snippets/f1genz-storefront.js`
- Custom elements, **light DOM via innerHTML (no shadow DOM)**: `f1genz-reviews` (tabs/stack wrapper), `f1genz-reviews-panel`, `f1genz-qna-panel`, `f1genz-rating-badge`, `f1genz-product-schema`, `f1genz-curated-slider`.
- apiUrl resolution: `window.__F1GENZ_STOREFRONT_CONFIG|F1GENZ_STOREFRONT_CONFIG|f1genzStorefrontConfig.apiUrl` → `data-api-url`/script-src origin → `https://api-haravan-reviews.f1genz.dev` legacy fallback (warns once). orgid from element attribute; GET `?orgid=`, POST `x-orgid` header.
- Summary batching: 25 ms debounce, ≤250 productIds per `GET /api/public/reviews/summaries` — built for collection pages.
- Badge SSR contract: `avg-rating`/`review-count` attrs render instantly (zero-CLS), then revalidate via summaries API with version-counter race guard.
- `f1genz-product-schema`: fetches reviews, recomputes summary, emits JSON-LD `@id=canonical#product`, `aggregateRating` only when count>0 && avg>0, `review[]` ≤ `max-reviews` (default 20, max 50). Auto-mount skipped if SSR ld+json already has Product+aggregateRating, element exists, or `config.autoProductSchema===false`.
- Quickview: `QUICKVIEW_SELECTOR` incl. `#pro-qv-wanda`; product-id sniffed from `[data-product-id]`, `[id^=product-select-]`, `product_quick_js*` globals, `window.product`; badge injected into `.haravan-product-reviews-badge` or after `.product-title/.product-price`, stamped `data-f1genz-runtime-owned`. MutationObserver re-scans; `isF1genzOwnedNode` prevents loops. `window.F1GENZStorefront.{scan,mountQuickview}` exposed.
- Customer session: `window.customer|Customer|Haravan.customer|__st.customer`; else GET `/account?f1g_auth_check=ts`, login detected via `/account/(login|register|activate|forgot)` URL or `customer[password]` HTML; identity regexed from account HTML.
- Media: canvas compression (edge ≤1920, q 0.82→0.45, ≤8 tries, target ≤1.5 MB; hard 5 MB img / 2 MB mp4) → `POST /api/public/media/ticket` → `POST /api/public/media/upload?productId&ticket`.
- `formatSafeRichText`: escape HTML → re-link `[t](url)` + bare URLs `rel="noopener noreferrer nofollow"`.
- CSS scale isolation: `--f1genzapp-review-font-size`/`--f1genzapp-review-scale` on element root; `em` not `rem`; badge `font-size:inherit`; media/avatars px. Critical style hides native file input; upgrades `rel="stylesheet preload"` links to `stylesheet`.

### SSR schema — `f1genz-product-schema.liquid`
Fallback chain `f1genz_reviews.summary → reviews.summary → haravan_reviews.summary → bwt_reviews.summary`; `aggregateRating` gated count>0 && avg>0; price `divided_by: 100`; `@id = shop.url+product.url (query stripped)+'#product'`; `gtin` from `variant.barcode`.

### Public API — `public-review.controller.ts` (707 lines)
- `GET config/widget` → config + `features` + `watermark` merged server-side. `GET summaries?productIds=` ≤250 deduped numeric ids. `GET :productId` → approved reviews, PII-masked (`maskEmail` local≥2+`***@domain`, `maskPhone` `091***78`), `source_raw_json` deleted, display mode from config (`hidden|mask|full`). `GET :productId/slider` → entitlement `curated_slider` + config gate, scan ≤200, same ≤8000 B shrink. `GET :productId/summary` → public summary + `ai_highlights` from `ai_generations` when entitled. `POST :productId/purchase-eligibility` → `{eligible,reason}` with collapsed reasons (`not_purchased` for missing/invalid identity — no email/phone oracle). `POST :productId` → validates against normalized form modes (hidden|optional|required), `requirePurchaseToReview` ⇒ `customer_purchases` hash lookup + `verified:true`; media allowlist `https://{R2_PUBLIC_DOMAIN}/reviews/{orgid}/**`, ≤5 items, type vs `allowImage/allowVideo`; spam detection always runs.
- Throttles dual-bucket: reads 900/min address + 600/min shop; eligibility 120/20; submit 60/5; media ticket 60/20; upload 30/6.
- `public-qna.controller.ts`: fail-closed — `isQnaPublicDisabled` ⇒ `data:[]` when config `known:false`; new questions always `pending`.
- `public-media.controller.ts`: HMAC ticket (orgid|productId|filename|contentType|fileSize|expiresAt|nonce, 2 min TTL, single-use nonce in Redis) → upload (magic-byte sniff must match declared type; worker PUT `X-Upload-Token`, key `reviews/<orgid>/<productId>/<uid>/<filename>`).
- `worker/src/index.js`: PUT-only, timing-safe secret compare, `REVIEW_KEY_RE` (rejects `..`,`%`), type allowlist, declared+streamed size caps, fail-closed CORS, `X-Worker-Version` header.

### Webhooks
- Inbound (`haravan.service.ts`): `verifyWebhookChallenge` (hub.verify_token/challenge) + `verifyWebhookHmac` — `x-haravan-hmacsha256` base64 over **raw body**, tried against clientSecret and webhookSecret, `timingSafeEqual`. Topic aliases normalized (`app_uninstall_webhook`, `shop_update`, …). Durable `webhook_events` row → BullMQ (8 attempts, exp 30 s) → `app_subscriptions/update` (tier sync, guarded vs statusless payloads), `app/uninstalled` (data preserved), `shop/update`, `products/delete` (soft-delete), `products/create|update` (catalog upsert), orders → `customer_purchases` (sha256 email/phone hashes only). Org resolution falls back to shop-domain→orgid map.
- Outbound (`outbound-webhook.*`): events `review.created` (approved submissions only), `review.approved` (pending→approved), `qna.created`, `ping`. **Durability precedes emission**: delivery row committed before enqueue; `jobId=deliveryId`; paused endpoints still get `skipped` delivery rows. Send-time entitlement re-check: indeterminate ⇒ throw/retry; non-super_heavy ⇒ endpoint `paused`+`last_error='downgraded'`, delivery `skipped`, never deleted. SSRF: https-only, `resolveAndValidate` → IP-pinned `https.Agent`, `maxRedirects:0`, `proxy:false`, 10 s timeout; blocked deliveries never increment `fail_count`. Signing `X-F1GENZ-Signature: t={ts},v1={hmac_sha256(secret,"{t}.{rawBody}")}` + `X-F1GENZ-Delivery-Id`; pre-rotation deliveries sign with `previous_secret`. Auto-pause at `fail_count≥20` via atomic SQL.

### DB schema (`database.service.ts`, advisory-locked boot DDL)
`review_products` PK `(shop_id,review_id)`: `number_star, review_title, review_content, review_video, review_status(APPROVED|PENDING|HIDDEN|SPAM), review_type='REVIEW', publish, product_{title,handle,name,image,url}, participant_{id,name,email,phone}, verified, pinned, reply, replied_at, review_images jsonb, review_answers jsonb, source_raw_json jsonb, source, created_by, last_modified_by, created_at, updated_at`. `qna_questions` mirrors. `customer_purchases` stores `email_hash`/`phone_hash` only. `widget_config_revisions` = config audit trail. `review_metafield_pending(orgid,product_id,created_at)` = durable sync markers.

### Widget config durability chain
`resolveWidgetConfigInternal`: Redis `widget_config:{orgid}` (authoritative) → shop metafield `reviews.widget_config` → in-process last-known-good Map (60 s, ≤500) → defaults `known:false`. Public adds `widget_config_cache:{orgid}` (600 s). `known` distinguishes resolved vs defaulted — QnA/gates fail closed on `!known`. Saves also write `widget_config_revisions` + shop metafield.

## 4. Critical Edge Cases / Traps / Workarounds

1. Metafield write amplification: one review write = summary + public_summary + f1genz summary + slider + N chunk updates + M deletes across 2 namespaces — dozens of Haravan calls; must stay async (queue + durable marker + background lane 1 req/1.2 s). Never on request path.
2. Dual chunk sets: `chunk_*` public (status stripped) vs `data_chunk_*` all statuses; legacy `chunk_*` without `status` ⇒ `approved`; public chunks must never carry pending/hidden/spam.
3. Haravan namespace filter advisory — client-side re-filter mandatory.
4. ~80 KB metafield cap → 60 KB chunking; shrinking chunk count must delete excess keys or stale reviews leak.
5. Slider ≤8000 B shrink ladder (c 220→160→120 → drop title → pop items), duplicated in `/slider` endpoint.
6. Entitlement indeterminacy ≠ free: `readable:false` ⇒ retry, never mutate (pause/purge) on unreadable.
7. Shop-bucket throttle must include address (`shop:address`); unauthenticated orgid alone lets callers mint buckets.
8. CORS tiers: admin allowlist ⇒ credentials; `*.myharavan.com`/`*.haravan.com`+`STOREFRONT_ALLOWED_ORIGINS` ⇒ credentials on public paths; other https ⇒ echo without credentials/expose; non-https ⇒ none.
9. TRUST_PROXY unset in prod ⇒ all clients share socket address ⇒ one throttle bucket (boot warns).
10. PII: masked email/phone, `source_raw_json` dropped, purchases as sha256 hashes, eligibility reasons collapsed.
11. Media allowlist requires `R2_PUBLIC_DOMAIN` — empty ⇒ all submitted media silently dropped.
12. Upload ticket single-use (nonce `setNx`) — replay would allow many objects under shop prefix.
13. Spam order: ≥maxUrls → repeated chars(10+) → same-author dup → ≥maxReviewsPerAuthor → blocked words → `<minContentLength` ⇒ pending → autoApprove?approved:pending. Public submit never trusts caller status; admin import may pass `dto.status`.
14. `sanitizeText` strips `&entities;` — literal `&amp;` eaten; storefront re-escapes anyway.
15. Webhook HMAC needs raw body — `bodyParser:false` + `applyRequestBodyLimits` captures raw bytes only on Haravan routes; secrets tried [clientSecret, webhookSecret].
16. Outbound `maxRedirects:0`+`proxy:false`+IP-pinned agent — redirect-to-internal is SSRF; blocked ≠ failed for the 20-failure auto-pause.
17. Asset cache `max-age=300,swr=300` (router-guide still says 14400/86400 — stale doc); widget changes lag ~5 min at edge.
18. Badge SSR→API drift: Liquid attrs may be stale; runtime always revalidates via summaries batch; attribute changes retrigger reload guarded by version counter.
19. Quickview product-id sniffing relies on theme globals (`product_quick_js_desk`, `#pro-qv-wanda`) — fragile; runtime-owned marker prevents observer loops.
20. Auto schema dedup: runtime skips mount when SSR ld+json has Product+aggregateRating — never double-emit.
21. QnA fail-closed: unknown config ⇒ `data:[]`.
22. `review.created` only fires for auto-approved submissions; pending→approved emits `review.approved` — consumers must subscribe to both.
23. Liquid traps: `product.featured_image | json` ⇒ ThemeSyntaxError; `| json` on empty `variant.sku` ⇒ "json not allowed"; `aggregateRating` with 0 reviews ⇒ GSC "Missing field ratingCount"; price `divided_by: 100`; `shop.metafields.f1genz.config.value | json` verbatim.
24. Windows/Chromium `.f1genzapp-review-section-tabs` `overflow-x:auto` ⇒ vertical scrollbar — needs `overflow-y:hidden`+scrollbar suppression.
25. Worker unversioned — manual `wrangler deploy`, identified by `WORKER_VERSION`/`X-Worker-Version`; key regex must stay in lockstep with backend key layout.
26. Cron single-owner: only `PROCESS_ROLE=api`/unset runs the 12 h sweep.
27. E2E harness aborts on prod-looking env (`pooler.supabase.com`, `redis-14194`); boots real Nest on ports 4199/59997/59998.
28. `hasInstalledAppSession` = access_token + not uninstalled-status + (paid/active OR not inactive-status) — public reads gate on this, not token validity.
29. AI highlights enqueue after 5 approved-review events/product (Redis counter, 24 h TTL); `input_hash` of review ids+updated_at keys regeneration; merged into public summary only when entitled.
30. Import path: CSV/JSON with wide field aliases, Google Drive URL→direct-link rewrite, `source_raw_json` preserved, `append|replace` modes, BullMQ import queue with progress rows.

## 5. Improvements for Super Core

**Platform semantics:**
- Haravan metafield namespace filter advisory — client-side re-filter mandatory.
- Metafield value cap ~80 KB → chunked `prefix_N` JSON arrays + excess-key deletion.
- `value_type:'json'` requires stringified value; `| json` unsafe on `featured_image` and empty `variant.sku`.
- Haravan product price in minor units (÷100 for schema `price`).
- `shop.metafields.f1genz.config.value.{apiUrl,orgid}` = app→theme config channel; `window.__F1GENZ_STOREFRONT_CONFIG = {{ ... | json }}` verbatim.
- Haravan webhook HMAC = base64 `x-haravan-hmacsha256` over raw body; topic alias drift (`app_uninstall_webhook`/`app/uninstalled`/`shop_update`/`shop/update`); subscription via `webhook.haravan.com/api/subscribe`, not REST.
- `/products/{handle}.js` returns product JSON on Haravan storefronts.

**Fix patterns:**
- DB-write + durable pending-marker in same transaction → async queue → projection store + periodic drain = correct "eventual projection"; never project on request path.
- Entitlement reads return `{value,readable}`; mutating actions require `readable:true`, else retry.
- Webhook delivery: row-before-enqueue, `jobId=deliveryId`, paused-endpoint deliveries recorded `skipped` (audit honesty), blocked ≠ failed for counters, `previous_secret` window after rotation.
- SSRF-safe outbound HTTP: DNS-resolve at send time, pin IP via custom agent, `maxRedirects:0`, `proxy:false`, scheme allowlist.
- Dual-bucket rate limiting: unauthenticated tenant id may only narrow the key (`tenant:address`), never replace address dimension.
- Public payload sanitization: mask PII, delete raw-source fields, collapse eligibility reasons to prevent oracle probing.
- Upload ticket: HMAC payload + single-use nonce + magic-byte sniff + server-side re-validation + key-regex at storage edge.

**Anti-patterns:**
- Synchronous metafield writes on request path (write amplification → 429 storms).
- Treating unreadable config/entitlement as resolved default (fail-open QnA, silent downgrade).
- Trusting caller `status`/`media.url` on anonymous endpoints.
- Random `jobId` per retry (breaks receiver idempotency).
- Deleting paused/downgraded endpoints or skipping delivery rows (audit gap).
- `rem` inside embeddable widget CSS (inherits merchant theme root font-size).

**Workarounds:**
- Token-hash cache keys (`sha1(token)[:16]`) self-invalidate on rotation.
- `AsyncLocalStorage` background lane: 1 concurrent + 1200 ms spacing vs 3 concurrent foreground.
- Legacy `chunk_*` without `status` ⇒ `approved` (migration compat).
- `data-f1genz-runtime-owned` marker so MutationObserver never re-processes runtime-injected nodes.
- Critical inline style hiding native file input (themes ship `rel="stylesheet preload"` that never applies).

## 6. Improvements for Haravan Theme Core Output

1. Metafield contract awareness: `f1genz_reviews → reviews → haravan_reviews → bwt_reviews` as canonical fallback-chain pattern; `summary` vs `public_summary` (admin vs approved-only) as dual-audience aggregate convention.
2. JSON-LD generator rules: `aggregateRating` only when count>0 && avg>0; `@id=canonical#product` graph linking; `price=variant.price/100` as string; `image` via `product_img_url` never `| json` on image objects; `gtin` from `variant.barcode` (8/12/13/14 digits); `sku` guarded `default: product.id`; `priceValidUntil` end of next year; strip query/hash from canonical.
3. DOM sanitizer allowlist: preserve custom elements `f1genz-*` (generally `[a-z]+-[a-z]+` tags), `script[type="application/ld+json"]`, inline config scripts (`window.__F1GENZ_STOREFRONT_CONFIG`), `data-*` attrs, `defer`/`crossorigin`; never drop `rel="stylesheet preload"` links — upgrade `rel` to `stylesheet` and remove `as`.
4. Badge SSR contract: `avg-rating`/`review-count` attrs for zero-CLS first paint + runtime revalidation — generate this pattern for any metafield-backed badge.
5. Product-card rule: badge-only inside loops bound to the loop iterator (never `product.id`); full widget only on product detail — encode as lint rule.
6. Legacy-app dedup: convert incumbent review blocks (`product_review`, `bigpen_review`) into `elsif` fallbacks behind `{% if shop.metafields.f1genz.config != blank %}` — never render two review blocks.
7. Fake-rating replacement: detect `product-visual-rating`/hardcoded `4,9`/`&#9733;` → replace with badge element.
8. noPS immunity: SSR Liquid schema tier works with zero JS; runtime loader can be gated behind `window.noPS`; sanitizers must not strip the `{% if shop.metafields.f1genz.config != blank %}` gate.
9. Windows scrollbar quirk: `.f1genzapp-review-section-tabs{overflow-y:hidden;scrollbar-width:none}` — catalog as known theme-CSS patch.
10. Lazy tab mounts: `reviewQnaDisplayMode=tabs` mounts QnA panel only on first open — theme QA must not flag the empty panel as missing content.

## 7. Improvements for AntiFan Core & Site Clone

**AntiFan Core (browser/CDP/verification):**
- Custom elements render light DOM via `innerHTML` — SnapDOM/DOM-diff must treat element children as runtime-owned; `data-f1genz-runtime-owned` is the explicit ownership marker.
- Widget verification must wait for `connectedCallback` + config fetch + region render (`[data-f1genzapp-review-region]`), not tag presence; badge has two-phase render (SSR attrs → API revalidate) — assertions must tolerate a second render.
- Summary calls debounced/batched (25 ms, ≤250 ids) — telemetry should group badge fetches per page, not per element.
- `isF1genzOwnedNode` guard means injected test nodes inside widget subtrees are ignored by its MutationObserver — probes must inject outside.
- Schema dedup check: assert exactly one `ld+json` with `"Product"`+`"aggregateRating"` across SSR + runtime paths.
- Review content autolinks URLs post-hydration (`formatSafeRichText`) — text-node diffs vs SSR are expected, not drift.
- `window.F1GENZStorefront.scan/mountQuickview` is the supported re-scan hook after AJAX/quickview swaps — use it instead of synthetic DOM events.
- Customer-session detection fetches `/account` — record as expected same-origin traffic, not a leak.

**Site Clone (`@antifan/site-clone`):**
- IR model: custom elements as first-class nodes (tag + attributes verbatim, children marked `runtime-owned`); `f1genz-rating-badge` `avg-rating`/`review-count` are SSR data — preserve them.
- Asset pipeline: `/storefront/f1genz-storefront.{js,css}` are cross-origin app assets — offline standalone mode must either vendor them locally AND rewrite apiUrl resolution (`__F1GENZ_STOREFRONT_CONFIG` stub), or mark widget degraded-live. The legacy fallback host means a missing config still phones home — offline mode must neutralize `LEGACY_FALLBACK_API_URL`.
- Metafield reads in Liquid (`shop.metafields.f1genz.config`, `product.metafields.reviews.public_summary`) are external-data references — model with fallback-chain semantics (`default:` filters) so cloned output keeps the same guards.
- DoD validator checks: single review block (no duplicate legacy app), badge present in product cards with numeric `product-id`, JSON-LD Product exactly once, `orgid` attribute non-empty, no hardcoded admin-domain apiUrl.
- Quickview/AJAX: cloned pages with quickview modals need the runtime's own rescan (MutationObserver) — do not freeze DOM post-capture in a way that strips late-mounted badges.
