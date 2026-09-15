# --ultra Deep Scout: F1GENZ Collection Tab

## 1. Project & Directory
`E:\Work\apps\F1GENZ Collection Tab` — Haravan embedded app "Collection Tabs by F1GENZ" (`.workspace-context.json`: kind=app, platform=haravan, verification=verified). Two nested git repos (`.git-nested/`): `Server--Collection-Tabs` (NestJS 10 + Express + Redis, deploys to Bizfly VPS via pm2) and `Client-Collection-Tabs` (React 18 + Vite 6 + AntD 5 + TanStack Query + TinyMCE 7, deploys to Cloudflare Pages as collection-tabs.f1genz.com; API at api.collection-tabs.f1genz.com). Root also holds `haravan-auth-flow-detail-final.md` (880-line canonical F1GENZ Haravan auth spec this app implements), `plans/260901-visual-delimiter-form-builder/` (4-phase visual form builder plan), `plans/reports/` (the /web value_type 422 debug report), `.playwright-mcp/` evidence captures, `.antigravity/mcp-bridge/` artifact.

## 2. Architecture & Role
The app lets merchants define up to 11 titled content tabs per resource (product, collection, blog, article, page) plus per-resource default tab labels at shop level. It is a **pure metafield app**: zero storefront injection (no ScriptTag/asset/theme mutation anywhere — grep confirms). Storefront rendering is entirely delegated to theme Liquid reading `*.metafields.f1genztabs.tabN.value`.

Data plane: Client → `PUT/POST /api/metafields` (ShopAuthGuard) → `HaravanAPI.create/updateMetafields` → `apis.haravan.com` nested metafield endpoints. Auth plane: Haravan OIDC (login scope `openid profile email userinfo`; install scope adds `org web.write_contents web.read_contents com.write_products com.read_products grant_service offline_access`) → access/refresh tokens in Redis `haravan:collection_tabs:app_install:{orgid}` → internal 12h JWT (`type:'haravan_app_session'`) → Bearer on every API call. Billing: `app_subscriptions/update` webhook → snapshot → Pro/Free plan fields on appData.

## 3. Load-bearing Files & Contracts

### Metafield data contract (the product)
- **Namespaces**: `f1genztabs` (object tabs, keys `tab1`..`tab11`, MAX_TABS=11 in tabsConfig.js:1) and `f1genztabs.config` (shop-level, key `shop`).
- **Shop config value**: `{shop:{active,orgid,orgsub:'https://{sub}.myharavan.com'}, collectionTabs:{tab1:'label',...}, productTabs:{...}, blogTabs, articleTabs, pageTabs}` — written by `generateShopMetafield` (haravan.util.ts:148-162) at install; label maps edited via SettingsPage → PUT /api/metafields.
- **Tab value (dual-storage)**: `{key,active,title,handle,contentType,items[],content}` — `items` = structured array for modern Liquid `{% for item in tab.items %}`; `content` = canonical pseudo-BBCode for legacy `split: '[title]'` themes (Toda B2B). Grammar: `[title]x[/title][content]y[/content]` (specs), `[badge][title][content][image][/badge]`, `[pair][title][material][title][code][image][/material]×2[spec]…[/spec][/pair]`, `[book][title][image][link][pdf][/book]`, plus `[kicker]/[desc]` pair prefixes and legacy `[mat1_name]/[mat1_code]/[mat1_img]`, `[iconN_img]/[badgeN_title]`, `[spec_size]` variants.
- **Endpoint matrix** (haravan.util.ts:104-118): products→`/com/products/{id}/metafields.json`, collections→`/com/collections/{id}/metafields.json`, blogs→`/web/blogs/{id}`, pages→`/web/pages/{id}`, articles→`/web/blogs/{blog_id}/articles/{id}` (or `/com/metafields.json?metafield[owner_id]&metafield[owner_resource]=article` when blog_id absent), default→`/com/metafields.json?metafield[owner_id]={id}` **without owner_resource** (cross-resource ID-collision risk).
- **value_type matrix** (haravan.util.ts:121-135): `/web/*` resources MUST send `value_type:'string'` (json → 422 'value_type is not included in the list', HAR-proven in plans/reports/debug-260715-0054); `/com/*` + shop send `'json'`. Value is a JSON-serialized string in both cases.
- **Create quirk** (haravan.util.ts:253-258): metafield `key` is extracted via `JSON.parse(values).key` — the client embeds its own key inside the value JSON; unguarded parse → 500 on malformed input.
- **Update path**: `PUT /com/metafields/{metafieldID}.json` globally (works for web-created metafields too).
- **Size ceiling**: ~64KB per metafield value → client-side `checkByteBudget` (TextEncoder UTF-8, MAX 64000 / WARN 50000, TabSerializer.js:14-15, 428-448) + minifyPayload.

### Auth/token contract (reference-grade)
- `verifyHmacLaunch` (haravan.service.ts:113-150): rebuilds HMAC message from **raw query order** (NOT Shopify-style sorted params — auth doc §7), strips `hmac` pair, sha256 hex vs client_secret, timingSafeEqual, ±5min timestamp window, resolves orgid from shop_domain mapping when absent.
- Launch without HMAC requires `shop+orgid` both matching installed appData (`issueInstalledSession` :455-481) — orgid alone never trusted.
- `ensureAccessToken` (:505-556): 30-min refresh buffer → per-org NX lock `refresh_token:org:{orgid}` EX:30 → losers poll `waitForFreshToken` (12×250ms) → winner re-reads latest appData (rotation-clobber guard) → refresh; `invalid_grant`/401 → `markNeedsReinstall`; transient failure returns null WITHOUT marking reinstall, and still-usable access token is returned if not actually expired.
- `refreshToken` (:301-330): re-reads latest appData before write (rotation race fix), preserves `refresh_token || latest || old`.
- Webhooks (haravan.controller.ts:105-119 + service :356-392, :743-770): GET challenge via `hub.verify_token`==HRV_WEBHOOK_SECRET; POST requires rawBody (bodyParser:false + captureRawBody in main.ts:19-21,60-62), base64 HMAC-SHA256 vs HRV_CLIENT_SECRET timingSafeEqual; only `app_subscriptions/update` processed → snapshot to `app_subscriptions:{orgid}` + apply to appData (status/plan/expires_at); orgid extracted header→query→body cascade. **No app/uninstalled topic handling** — uninstalls never clean up tokens or shop_domain mappings.
- Redis keys: `haravan:collection_tabs:app_install:{orgid}` (NO TTL — deliberate; comment cites evict→'App not installed' incident; legacy `haravan:app_install:` migrated on read), `:shop_domain:{domain}`, `:app_subscriptions:{orgid}`, `:refresh_token:org:{orgid}`, `:refresh_token:lock` (cron).
- Client session: `authStorage` dual-writes local+session storage (+memory fallback); App.jsx consumes `?session_token`, strips it from URL; AxiosConfig injects `x-orgid`+Bearer; 401 → post_auth_redirect → /install/login. Login page dedups OAuth `code` via sessionStorage (single-use code double-exchange guard) and retries exchange-failure once.

### Client rendering contract
- `MetafieldsPage` merges shop default labels under object titles (`objectTitle || defaultTitle || 'Tab trống'`), renders 11 `MetafieldsForm` tabs.
- `MetafieldsForm.hydrateFormData`: explicit `contentType` wins, else `detectType` heuristic; structured fields prefer `fieldValue.{specs|badges|pairs|books}` → `items` → BBCode re-parse.
- `MetafieldsService`: `HARAVAN_WRITE_SETTLE_MS=1200` post-mutation wait + `HARAVAN_REVALIDATE_DELAY_MS=2500` delayed invalidation — explicit Haravan write→read replication-lag workaround; optimistic cache upsert; `HARAVAN_TOKEN_INVALID` (server maps 401→409) → no retry, reinstall CTA.
- TinyMCE: self-hosted `/tinymce/`, `entity_encoding:'raw'` (UTF-8 byte budget + Vietnamese diacritics), `paste_data_images:false` + `<img>` stripped on paste (byte guard), explicit `editor.destroy()` on unmount.

## 4. Critical Edge Cases / Traps / Workarounds Found

1. **SILENT DATA LOSS — legacy pairs**: `detectType` returns 'pairs' for `[mat1_name]` (TabSerializer.js:108) but `parsePairs` only iterates `[pair]` blocks (:256) → items=[] → on save `generateCanonicalBBCode([])` returns '' → `content` overwritten empty. Any pre-visual-builder legacy pair data is destroyed on first save. Same class of risk for any unrecognized BBCode dialect: detected type ≠ parseable type.
2. **Committed secrets**: `Server--Collection-Tabs/.env` contains live HRV_CLIENT_SECRET, ENCRYPTION_KEY, REDIS_PASSWORD; `redis.util.ts:5-7` hardcodes the same Redis password+host as code fallbacks — credential exposure survives env deletion.
3. **/web vs /com value_type split** (422) — fixed, but the Liquid-side consequence is flagged unverified in the debug report: for `value_type:'string'` resources, `metafields.f1genztabs.tabN.value` may render as raw JSON string, so `tab.items`/`tab.content` property access may not work in Liquid for pages/blogs/articles — theme contract only proven for /com resources.
4. **Articles without blog_id**: POST falls back to `/com/metafields.json?metafield[owner_id]…` — owner params in query string on a POST body endpoint is suspect (likely creates orphaned metafield); GET fallback omits `owner_resource` → cross-resource ID collisions.
5. **Cron lock expires mid-job**: `haravan.cron.ts:21` EX:60 while the job iterates all orgs at ≥500ms each — >120 shops guarantees overlapping runs. Also `getOrgids()` uses blocking `KEYS` (redis.util.ts:45-46) on a shared Redis Cloud instance.
6. **detectType false-positives**: any rich text containing literal `[title]…[content]…` or `[badge]` substrings is reclassified as structured → content regenerated, original HTML lost. `cleanHtmlNoise` only strips p/span/br/&nbsp; — other HTML (tables, divs) survives into BBCode parse and pollutes items.
7. **Replication lag**: Haravan metafield writes are not immediately readable → 1200ms settle + 2500ms revalidate timers; storefront cache visibility is even slower (phase-04 acknowledges).
8. **429 handling**: every HaravanAPI call recurses on 429 honoring `retry-after` — unbounded recursion (no max attempts); a persistent 429 = infinite retry loop holding the request.
9. **Dead/legacy code**: unrouted `pages/{product,collection}/{metafields,settings}` (superseded by shared pages) including a live `debugger;` at collection/metafields/index.jsx:45; `CollectionService.install()` posts to nonexistent `POST /api/oauth/install/grandservice`; `HaravanRepository` unused; `useUpdateField` vs `useUpdateFieldv2` differ only by orgid query param.
10. **Broken test harness**: `TabSerializer.test.js` imports `vitest` — not a dependency, no test script → the serializer's only safety net cannot execute.
11. **Session token in localStorage** (XSS-exfiltratable, 12h TTL) — accepted trade-off per auth doc §5, but `APP_SESSION_SECRET` falls back to `HRV_CLIENT_SECRET` (haravan.service.ts:51) — session forgery == client-secret compromise.
12. **HMAC edge cases**: `verifyHmacLaunch` splits raw query on `&`/`=` — a value containing encoded `=` in the key position could corrupt the message; future timestamps accepted within 5min. `cleanRedirect` rejects `/install*` and non-relative URLs (open-redirect guard) — correct but means absolute frontend URLs in `state` are silently dropped.
13. **getShopConfigMetafield fallback** (tabsConfig.js:77-79): `find(key==='shop') || metafields[0]` — if other `f1genztabs.config` keys ever exist, wrong metafield is edited and its value clobbered by SettingsPage's merge-write.
14. **Books link/pdf collapse**: `parseBooks` sets `link = link || pdf` and `pdf = pdf || link` (:331-336) — a book with only `[pdf]` re-serializes with both `[link]` and `[pdf]` (pdf≠link check fails) → semantic drift on roundtrip.
15. **QueryClient config drift**: `staleTime:Infinity` + `refetchOnWindowFocus:true` with a comment claiming refetch is disabled — stale metafield data can refocus-refetch unexpectedly after Haravan lag.
16. **SettingsPage silent no-op**: `handleSubmit` returns early when `shopConfig?.id` missing — no user feedback; also `getShopConfigMetafield` fallback means it may write to the wrong metafield id.
17. **Non-atomic lock release**: `releaseOrgLock` GET-then-DEL (check-and-delete race) — a second holder's lock can be deleted if the first expired naturally; use Lua compare-and-del.
18. **Deploy pipeline**: `git reset --hard` + `rm -rf dist node_modules` on every push; pm2 `--watch` on dist — any stray file change in dist triggers restart; `.env` is VPS-only (not in CI) — drift between committed .env and live env is invisible.

## 5. Concrete Improvements for Super Core

**Platform semantics (record as `platform_semantics` for haravan):**
- `/web/{pages,blogs,articles}` metafield endpoints reject `value_type:'json'` with 422; `/com/*` and shop accept it. Always send `string` for web resources, `json` for commerce; value stays a JSON string either way. (Evidence: haravan.util.ts:121-135 + HAR report.)
- Haravan metafield value ceiling ≈64KB UTF-8 → pre-flight `TextEncoder` byte guard at 64000 with 50000 warning is the proven pattern.
- Haravan metafield writes have ~1–2.5s read-after-write lag → settle ≥1200ms before trusting mutation response; revalidate ≥2500ms.
- Haravan HMAC ≠ Shopify: launch HMAC uses raw query order (no param sorting), hex digest, ±5min timestamp; webhook HMAC is base64 digest over raw body — requires `bodyParser:false` + verify-callback rawBody capture.
- Haravan refresh tokens rotate on every refresh → must re-read stored token before write-back and lock per-org (NX EX:30) or tokens get clobbered; `invalid_grant`/400+401 = revoked → needs_reinstall; all other failures are transient — never mark reinstall on transient errors.
- Haravan app_install keys must be TTL-less (PERSIST); Redis eviction of install keys presents as 'App not installed' — rescue via SCAN+PERSIST script, never KEYS in cron paths.
- OIDC login scope must exclude `grant_service`, `wh_api`, `com.*`, `web.*` (login fails otherwise); install scope includes them. `getLoginScope` filter (:598-612) is the reference.
- `app_subscriptions/update` is the billing source of truth; snapshot before install so install can apply Pro immediately.

**Anti-patterns to record:**
- Detected-type≠parseable-type regeneration (silent content wipe) — gate regeneration on `items.length>0 || contentType explicitly set`, else preserve raw content.
- `JSON.parse` on client-controlled value server-side without try/catch (haravan.util.ts:255).
- Cron distributed lock TTL < worst-case job duration.
- Hardcoded credential fallbacks in source (redis.util.ts:5-7) and committed .env.
- `debugger;` in shipped client code; dead duplicate page trees after shared-component refactor.
- Test file importing a runner that isn't a dependency (vitest import, no vitest dep).
- Unbounded 429 retry recursion without attempt cap.
- `metafields[0]` positional fallback for config lookup.

**Fix patterns:**
- Dual-storage payload (structured `items` + canonical string `content`) for metafield-driven features needing both modern object access and legacy split-parsing themes.
- sessionStorage OAuth-code dedup + single retry on exchange failure (Login/index.jsx) — prevents double-exchange 400s on React strict-mode/double-mount.
- Re-read-before-write on token refresh (rotation clobber guard) — verbatim pattern at haravan.service.ts:284-297 and markNeedsReinstall:640-653.
- Response-envelope `{success,data,status,errorCode,errorMessage}` + 401→409 HARAVAN_TOKEN_INVALID mapping so clients can distinguish reinstall-required from generic errors.

**Workarounds:**
- 429 → sleep `retry-after` then retry (add attempt cap ≥3).
- Legacy Redis prefix migration on read (getToken fallback write-through).
- `needs_reinstall` recovery script: refresh-token probe → write-back rotated token → clear status (recover-needs-reinstall.mjs) — most 'revoked' shops are recoverable without merchant action.

## 6. Concrete Improvements for Haravan Theme Core Output

1. **Metafield contract registry**: ThemeCompiler/HaravanSchemaGenerator should model this app's contract as a first-class entity — `f1genztabs.tabN` (N≤11) dual-storage `{active,title,handle,contentType,items,content}` + `f1genztabs.config.shop` label maps — so generated themes can emit both the modern `tab.items` loop and the legacy `split:'[title]'` fallback from one IR node. The Home page's MODERN/LEGACY snippets are the exact two emission modes to template.
2. **BBCode/delimiter grammar as a serializable component contract**: the `[tag]…[/tag]` grammar (specs/badges/pairs/books + legacy mat1_/iconN_/spec_size variants) is a real production wire format between app and theme. Theme Core Output should ship a shared grammar spec (tag inventory, nesting rules, case tolerance, unclosed-tag behavior) so generated themes and the app serializer never drift — currently the grammar lives only inside TabSerializer.js + Toda liquid splits.
3. **value_type-aware settings contract**: when generating theme features that read app metafields, emit different access patterns per resource family — `/com` resources can rely on `value_type:'json'` object access; `/web` resources store `string` → generated Liquid must either split `content` or parse the JSON string (verify which DotLiquid behavior applies; the debug report explicitly leaves this unverified).
4. **Byte-budget-aware schema**: metafield-backed settings need maxLength/byte telemetry in the generated admin UI contract (the app's 64KB guard + 50KB warning + live KB meter is the UX reference).
5. **DOM sanitizer parity**: `cleanHtmlNoise` (strip p/span/br/&nbsp; only, preserve BBCode tokens + UTF-8 diacritics) is the minimal-noise-strip precedent — a DOM sanitizer that strips more (or strips `[tag]` tokens) breaks the contract. Conversely, theme output MUST never leak raw `[tag]` tokens to storefront DOM (phase-04 acceptance) — add a 'no raw delimiter tokens in rendered output' assertion to generated theme QA.
6. **Vietnamese-aware slug + entity_encoding:'raw'**: `HelpService.toSlug` diacritic map and raw entity encoding are required for handle generation and byte-accurate storage in vi-VN content.
7. **Admin deep-link convention**: `{orgsub}/admin/products/collections/{id}` style links built from the shop config metafield — generated app UIs should deep-link back to the owning admin resource page.

## 7. Concrete Improvements for AntiFan Core & Site Clone

**AntiFan Core:**
- **Verification claims for metafield-driven features**: 'tab renders on storefront' cannot be verified by app state — needs DOM claims: (a) no literal `[tag]`/`[/tag]` tokens in rendered text nodes, (b) expected structure (.spec-matrix-col, .feature-circle-item, pair cards, bookshelf) present, (c) no Liquid error text. The phase-04 verification matrix is a ready-made claim set.
- **Post-mutation settle telemetry**: adopt the 1200ms write-settle / 2500ms revalidate constants as CDP telemetry defaults for Haravan-backed mutations; `anti.trace.interaction` on a metafield save should wait ≥2.5s before asserting storefront state.
- **DOM sanitizer rules**: `anti.theme.export_clean` must preserve merchant HTML inside metafield-rendered regions while stripping SSR blobs — and must NOT strip `[tag]` delimiters when dumping raw metafield values for inspection (they are data, not markup noise).
- **Auth-flow verification**: the HMAC-launch/session-issuance flow (verify-hmac → sessionToken → guarded API) is a reusable AntiFan test surface: claims like 'app opens from Haravan Apps launch without re-login', 'expired session redirects to /install/login with post_auth_redirect', '401 → reinstall CTA'.
- **Desktop browser evidence**: `.playwright-mcp/` page-*.yml snapshots show the team already captures a11y-tree evidence manually — formalize via `anti.inspect.snapshot` + `anti.verification.record_claim`.
- **Dead-code/debugger detection**: `debugger;` in shipped code and unrouted legacy page trees are detectable via DOM/console telemetry + source scan — candidate anti-pattern check.

**Site Clone (@antifan/site-clone):**
- **Metafield-driven content is a hidden dependency**: a cloned storefront page's tabs exist only because `product.metafields.f1genztabs.*` exists — the IR model must capture metafield-sourced regions (namespace, key, contentType) or the offline clone silently loses entire content sections. Model as `ir.component.source = {kind:'metafield', namespace, key, owner_resource, owner_id}`.
- **Component contract IR ↔ BBCode grammar**: the dual-storage payload is a live example of one logical component with two serializations (structured items + delimiter string). Site Clone's component contract IR should treat `items` as canonical and `content` as a derived serialization — mirroring exactly what TabSerializer does — and the DoD validator should check roundtrip parity (items→content→items stable).
- **Asset pipeline**: tab content embeds absolute CDN URLs (hstatic badge icons hardcoded in BadgesRepeater presets, swatch images, PDF links, flipbook links) — asset pipeline must crawl URLs inside metafield JSON values, not just DOM/src attributes; external flipbook/PDF links classify as non-localizable external assets.
- **Offline standalone mode**: for `value_type:'string'` web resources the metafield value is a JSON string — the cloner must double-decode (JSON.parse the string, then read .content/.items) when baking content offline.
- **DoD validator additions**: (a) zero `[tag]` tokens in output DOM, (b) all 11 tab slots accounted for (active ones rendered, inactive absent), (c) shop-config default labels resolved (object title > shop defaultTabsKey > 'Tab trống' precedence), (d) byte-size of baked tab payloads reported.
- **Nested-repo awareness**: `.git-nested/` directories mark embedded repos — clone/worktree tooling must not treat them as the parent repo's objects.
