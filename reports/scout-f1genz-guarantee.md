# --ultra Scout Report: F1GENZ Guarantee (E:\Work\apps\F1GENZ Guarantee)

## 1. Project & Directory
Production multi-tenant Haravan embedded warranty-lookup app. Live at `https://guarantee.f1genz.dev` (Nginx → PM2 `f1genz-guarantee` fork :3018 → PostgreSQL `f1genz_guarantee` + Docker Redis prefix `f1g_guarantee:`). GitHub `F1GENZ/F1GENZ-Guarantee`, push-to-main CI deploy (rsync → npm ci → prisma db push → build → pm2 reload → /livez poll). Replaces the Vyantechnology Google Apps Script (`Code.gs`) warranty lookup; the only storefront change was ONE URL literal in `customizes/Vyantechnology/templates/page.warranty.liquid` (~line 189). Stack: NestJS 10.4 + Prisma 5.22/PostgreSQL + ioredis + React 18/AntD 5/Vite SPA + `@haravan/app-sdk` 1.5.x.

## 2. Architecture & Role
Three-surface monolith (`server/` NestJS, `client/` Vite SPA served statically by same process):
- **Public ingress** `GET /api/v1/p/warranty/{shopHandle}/lookup?serial=|s=` — unauthenticated, CORS `*`, `Cache-Control: no-store`, per-IP sliding-window rate limit (30/60s), Redis response cache (300s hit / 60s negative), HMAC-IP lookup logging. Tenant handle = non-secret routing key resolved against `publicHandle`/`haravanShop`/`orgId` + `isActive`, fail-closed 404.
- **Admin API** `/api/v1/admin/warranty/*` — ShopAuthGuard: unsafe-method origin policy → session token (internal HS256 JWT *or* Haravan App Bridge token signed with app secret) → orgid match → per-request `orgId→shop.id`. CRUD, dashboard, distributors, import preview/execute/job polling, export, template, config.
- **Lifecycle** `/api/oauth[/install]/*` (4 mount prefixes) — HMAC launch fast-path, OIDC install (`grant_service` scope), single-use state/nonce/handoff in Redis, AES-256-GCM token at rest, webhook subscribe + `app/uninstalled` teardown.

## 3. Load-bearing Files & Contracts
- `server/src/warranty/public-warranty.controller.ts` — response union `{success:true,data:{serial,sku,exportDate:'dd/MM/yyyy',warrantyMonths,tabYear:''}}` | `{success:false,message}`; HTTP 200 for empty/not-found serial (legacy GAS semantics), 404 unknown/inactive handle, 429 rate limit. `tabYear` hardcoded `''`; `npp`/`notes` never emitted (B2B air-gap). VOID→not-found; EXPIRED→success (storefront computes expiry client-side).
- `server/src/warranty/utils/date-normalizer.ts` — `cleanSerialString` = trim→lowercase→strip `[\s\-_.]` (unique key `@@unique(shopId,cleanSerial)`); Excel epoch 1899-12-30 serials; DD/MM/YYYY (2-digit year +2000); month-add clamps to last day of target month (Jan31+1m→Feb28/29).
- `server/src/warranty/excel-import.service.ts` — ExcelJS stream WorkbookReader + unzipper pre-pass (sheetNames/sharedStrings) defeating adversarial ZIP entry order via injected sharedStrings + defensive `model` getter patch (ExcelJS `_parseWorksheet` fires before `model` exists when worksheet entry precedes workbook.xml — proven by `adversarial-zip-order.test.ts`). `yearTab` = NPP column value (≤255 chars) else sheet name.
- `server/src/warranty/warranty.service.ts` — preview→`ImportJob(PREVIEWED)`→execute streaming batches of 1000 → raw multi-row `INSERT … ON CONFLICT (shopId,cleanSerial) DO UPDATE` (13 positional params, ~5,800 rows/s benchmarked); cache invalidation on every mutation incl. old+new cleanSerial on rename; `getDistinctDistributors` excludes `^[0-9]{4}$` via Postgres `!~`.
- `server/src/haravan/session.service.ts` — dual-signature HS256 JWT verify (APP_SESSION_SECRET internal + HARAVAN_API_SECRET App Bridge, 30s skew); single-use `hrv_handoff_[hex64]`/`hrv_oauth_[hex64]` via Redis `getDel`; cookie `SameSite=None;Secure` when cross-site (eTLD+1 siteHost compare).
- `server/src/haravan/hmac-verifier.service.ts` — launch HMAC hex sha256 over query minus `hmac`, ±300s timestamp, tries decoded AND raw message candidates; webhook body HMAC accepts hex or base64.
- `server/src/haravan/haravan.controller.ts` — `escapeIframeRedirect` emits window.top breakout HTML because `accounts.haravan.com` sends `X-Frame-Options: SAMEORIGIN` (iframe self-redirect = ERR_BLOCKED_BY_RESPONSE).
- `server/src/main.ts` — rawBody captured only for webhook path or `x-haravan-hmac[-sha256]` headers; CSP `frame-ancestors *.myharavan.com admin.haravan.com`; `/api/v1/p/*` open CORS.
- `server/prisma/schema.prisma` — Shop(orgId, haravanShop, publicHandle unique, encrypted accessToken, isActive), WarrantySerial, ImportJob(status machine, JSON-string sheetStats/rejectedRows), LookupLog(ipHash), WarrantyConfig.
- `client/src/lib/api-client.ts` — App Bridge SessionToken: RESPOND subscribe, 5s bounded timeout, 45s cache, per-shop in-flight dedup, generation guard on shop switch; 401→single retry w/ rotation; fail-closed embedded.
- `client/src/pages/import-page.tsx` — 3-step import; 1s job polling w/ isPolling guard, 30-poll stale timeout, sessionStorage `f1genz_active_import_job_id` rehydration across reload.
- Tests: `public-lookup.test.ts` (contract incl. tabYear:'' + npp/notes never leak), `adversarial-zip-order.test.ts`, `deep-chaos-and-reliability.test.ts` (poison XLSX, lock contention, GCM bit-flip, replay, 100k-op heap), `one-million-codes-benchmark.test.ts`.
- `WARRANTY_LOOKUP_APP_PLAN.md` (canonical contract) + `plans/260909-1801-customer-feedback-npp-notes-menu/plan.md` (in-progress: NPP column, notes, air-gap, VOID→'Đã thu hồi', 13-param upsert invariant, zero-data-loss ~50k serials).

## 4. Critical Edge Cases / Traps / Workarounds
1. **Cross-tenant ImportJob mutation (real bug)** — `executeImport` does `importJob.update({where:{id:jobId}})` with NO shopId check (unlike `getImportJob` which scopes id+shopId). Any tenant can flip another tenant's job status and overwrite rejectedRows/sheetStats.
2. **Dead code in stream-preview fallback** — `preview()` fallback computes `const slice = batch.slice(0,needed).map(...)` but never pushes into `previewRows` → fallback preview always returns empty rows (masked because previewFastBuffer usually wins).
3. **rawBody capture gap on alternate mounts** — `captureRawBody` gates on `/api/oauth/install/webhooks` path OR `x-haravan-hmac`/`x-haravan-hmac-sha256` headers, but controller reads `x-haravan-hmacsha256` (no second dash). On `oauth/install/webhooks` mount a delivery carrying only `x-haravan-hmacsha256` gets no rawBody → webhook rejected. Works only because registration uses the `/api` URL.
4. **Production secret fail-open** — `env.schema.ts` defaults SESSION_SECRET/IP_HMAC_SECRET/READINESS_TOKEN to dev literals, no production assertion → missing env = forgeable sessions. Contradicts plan's 'fail readiness' invariant.
5. **90-day log retention unenforced** — `purgeOldLogs(90)` exists, nothing schedules it.
6. **Status is import-time snapshot** — computed once at write; records never re-transition to EXPIRED (public API omits status so storefront stays correct; admin ACTIVE counts drift).
7. **updateSerial uniqueness** — renaming serial to existing cleanSerial throws raw Prisma P2002 (500) instead of 409 like createSerial.
8. **In-memory Redis fallback in production** — degrades to per-process memory for cache/rate-limit/locks; /readyz reports failure but app keeps serving (deviation from 'Redis required in prod'; survivable only because PM2 fork = 1 instance).
9. **`ping()` dev lie** — returns `NODE_ENV!=='production'` when no client → readyz green without Redis outside prod.
10. **Base64-over-JSON import** — file as base64 in JSON (150mb limit ⇒ ~112MB real cap; Nginx 150M aligned). executeImport re-sends whole file — job row holds no payload; reload without file can't resume (rehydration covers polling only).
11. **Header row assumption** — streamWorkbook always consumes row 1 as header; headerless sheet loses row 1 → positional fallback.
12. **Timezone sensitivity** — string dates use server-local `new Date(y,m,d)` while Excel serials are UTC-epoch; non-UTC TZ shifts dates (VPS is UTC, latent).
13. **Session token in URL** — post-auth redirect carries `?session=<jwt>` (history/referer exposure) alongside HttpOnly cookie.
14. **`collectDomains` over-matches** — normalizes ANY scalar under domain-ish keys (orgsub, emails→'b.com') into domain mappings.
15. **Domain→orgid cache no TTL** — stale mapping survives until overwrite/uninstall.
16. **No fetch timeouts** — token exchange/getShop/subscribeWebhooks bare `fetch`; `webhookRegistration` swallows all subscribe errors → uninstall webhook may silently never register (sibling haravan-reviews shows 401-restart loops from this exact call).
17. **Origin check bypass for non-browser clients** — `isTrustedUnsafeOrigin` returns `Boolean(req.headers.host)` when Origin/Referer absent.
18. **`prisma db push --accept-data-loss` in CI** — no migration files; destructive-capable schema drift every push.
19. **Soft auth gate client-side** — `isAuthenticated = sessionToken || orgId`; bare `?orgid=` renders portal (APIs still 401).
20. **Rate-limiter EXPIRE race** — INCR then EXPIRE only when count===1; failed EXPIRE = permanent key = permanent IP block.

## 5. Improvements for Super Core
- **Platform semantic**: App Bridge SessionToken = HS256 JWT w/ app secret; claims orgid/dest, ~60s exp → verify server-side timingSafeEqual + ~30s skew; client cache ≤45s, dedup in-flight per shop.
- **Platform semantic**: launch HMAC = hex sha256 over raw query minus `hmac`, ±300s timestamp; verify BOTH decoded and raw pair-serializations.
- **Platform semantic**: `accounts.haravan.com` XFO SAMEORIGIN → OAuth consent needs top-level nav; iframe-breakout HTML bridge (`window.top.location.href` + `target="_top"` button). Never self-redirect iframe.
- **Platform semantic**: webhook signature header `x-haravan-hmacsha256` (hex or base64) over RAW body; subscribe `POST https://webhook.haravan.com/api/subscribe {webhook_url, topics}`; GET challenge echoes `hub.challenge`.
- **Anti-pattern**: mutating resource by bare `id` without tenant scope → cross-tenant overwrite. Rule: every mutable lookup = `id + tenantKey`.
- **Anti-pattern**: dev-default secrets in env loaders without production assertion → silent fail-open.
- **Fix pattern**: ExcelJS WorkbookReader breaks on non-standard ZIP order (worksheet before workbook.xml) → unzipper pre-scan for sheet names + sharedStrings, inject sharedStrings, patch defensive `model` getter.
- **Fix pattern**: month arithmetic — setDate(1) → setMonth(+n) → clamp min(origDay, lastDayOfTargetMonth); Excel epoch 1899-12-30.
- **Fix pattern**: negative caching (60s) for not-found + positive (300s) + invalidate old AND new cleanSerial on rename.
- **Fix pattern**: single-use OAuth state/handoff via Redis GETDEL (atomic consume kills replay); isSafeRedirect validated raw+decoded+URL-parsed.
- **Workaround**: HMAC-SHA256 keyed IP hash for abuse analytics vs raw IP — but retention code without a scheduler is a no-op.
- **Anti-pattern**: `prisma db push --accept-data-loss` in CI; `fetch` w/o timeout to platform APIs; fire-and-forget webhook registration swallowing errors.
- **Pattern**: dual-signature session verifier (internal + platform bridge secret) lets one guard serve cookie sessions AND App Bridge tokens.
- **Pattern**: public-ingress air-gap — explicit response DTO whitelist, tenant handle in path (never Origin/Referer), 404 unknown handle vs 200-legacy-failure missing serial.
- **Pattern**: semantic column reuse (`yearTab` = year OR NPP) separated by Postgres `!~ '^[0-9]{4}$'` — migration-free schema evolution, caveat: couples filter logic to data shape.

## 6. Improvements for Haravan Theme Core Output
- **Endpoint-literal cutover contract**: entire migration = one URL literal in page.warranty.liquid. ThemeCompiler should model 'external service URL' as a first-class single-site constant/setting → backend swaps become one-line diffs with documented revert.
- **200-with-failure semantics**: GAS-style APIs return HTTP 200 + `{success:false,message}` — generated storefront fetch must branch on body semantics, not status; HaravanSchemaGenerator should encode this response union in contract IR.
- **Client-computed expiry**: storefront derives countdown/status from `exportDate`+`warrantyMonths` (`dd/MM/yyyy`); API deliberately omits status → theme must not expect a server status field nor reformat the date.
- **Air-gap rendering**: public payload strips npp/notes/tabYear; DOM sanitizer should assert supplier-identifying fields/labels (e.g. `(Năm XXXX)`) never reach storefront markup — explicit customer requirement.
- **Settings ownership drift**: WarrantyConfig (pageTitle/subtitle/countdown/sampleSerials/serviceCommitments) duplicates theme settings ownership — plan forbade a presentation model yet it shipped. Schema generator should flag app-config keys colliding with theme settings_schema.
- **Label contract**: status→VN label map (ACTIVE→Còn hạn, EXPIRED→Hết hạn, VOID→Đã thu hồi) duplicated across export Excel and theme — belongs in shared contract, not two literals.

## 7. Improvements for AntiFan Core & Site Clone
**AntiFan Core:**
- Verification claims for this app class must assert BODY semantics (`success:false` with HTTP 200), `Cache-Control: no-store`, CORS `*`, 429 — status-code-only checks miss the contract.
- `escapeIframeRedirect` bridge page is transient DOM — SnapDOM/screenshot flows must wait for top-level navigation, not assert on the bridge document; iframe assertions need `window.self!==window.top` awareness.
- Import progress is server-authoritative (polled ImportJob) — verify via API polling, not DOM progress bar; sessionStorage rehydration makes reload-resume a testable claim.
- Shop-switch invalidates sessionStorage tokens — multi-tenant browser sessions need per-shop context isolation in CDP telemetry.
- Repo already consumes antifan flow (`.antifan/annotations`, `.antifan/snapshots`, `.playwright-mcp`, `evidence/*.png`) — good dogfood source for claim/evidence receipts.

**Site Clone:**
- Warranty page is live-API-dependent: offline standalone mode must replay captured lookup responses (found/expired/not-found 3-state fixture set) or mark the fetch as external-runtime dependency in IR — static clone without stub silently breaks lookup.
- IR model should capture: endpoint literal, query params (`serial`/`s`), response union (`success/data` vs `success/message`), `dd/MM/yyyy` format, three render states as component contract.
- Asset pipeline: binary public assets (`client/public/File_Mau_Import_Bao_Hanh_F1GENZ.xlsx`) must clone byte-exact; theme-side .xlsx template downloads are part of the surface.
- DoD validator: assert zero credentials in cloned Liquid/JS (public lookup unauthenticated by design — introducing keys is a regression), assert no supplier fields (`npp`, `notes`, `(Năm XXXX)`) in output, assert endpoint literal is the production handle-routed URL.
- GAS-backed pages generally: cloning requires capturing the remote microservice contract (§3 above) since the backend never lives in the theme export.
