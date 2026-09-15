# F1GENZ Wheel — Ultra Deep Scout Report

## 1. Project & Directory

`E:\Work\apps\F1GENZ Wheel` — Haravan spin-to-win (vòng quay may mắn) app, forked from `haravan-app-base`. Branch `f1genz`. Monorepo: `server/` (NestJS 11 + Express 5 + Prisma 6 + ioredis), `server/worker/` (bullmq 5), `client/` (React 19 + Vite 6 + Antd + TanStack Query + Cloudflare Pages proxy function), `scripts/` (verify-env, verify-build-output, scan-anti-patterns), `docs/` (8 docs incl. env-contract, e2e-checklist), `plans/reports/` (prior audit + Oni port brainstorm). `.pgdata/` = local Postgres data dir. `.workspace-context.json`: kind=app, platform=haravan, verification=`npm run verify`.

## 2. Architecture & Role

Merchant creates a Campaign (1 active per shop: partial unique index `Campaign(shopId) WHERE status='active'` + app check + P2002→409 mapping), adds PrizeSlots (kind coupon|loss, weight `odds`, optional `quantity`/`remaining`), imports a Coupon pool (dedupe [campaignId,code], max 5000/batch), installs ScriptTag `wheel.js?shopKey=…&key=…`. Storefront visitors get popup wheel + reminder bar; spins resolve server-side; winners receive a pooled coupon code.

Spin path: `POST /api/public/:shopKey/spin` → StorefrontAuthGuard (X-Wheel-Key sha256 hash-only, timingSafeEqual, 80/min/shopKey) → StorefrontCorsMiddleware ran first (120/min/IP pre-DB, per-shop-domain origin allowlist) → StorefrontService.spin → SpinsService.resolveSpin: campaign active + window + loginRequired checks → retry loop (8): pickWeighted over active slots with remaining>0 → tx{ SELECT Player FOR UPDATE → per-player/per-UTC-day limit counts → conditional `remaining>0` decrement → conditional coupon claim (available→issued, 3 retries) → Spin create } → SpinConflictError excludes slot, repicks → after 8 failures, unconditional loss Spin. Response `{spin, result:'win'|'loss', prize:{label,value,code}|null, remainingSpins}`.

Worker: two repeatable jobs — campaign-expiry (13 * * * *) ends overdue campaigns + disables empty slots in one tx; coupon-expiry (37 * * * *) expires `available` coupons past `expiresAt`. Requires real Redis (enableOfflineQueue:false + 15s ready race); loads `server/.env` via __dirname-relative path.

Auth stack (inherited from base, hardened): OIDC id_token via JWKS (alg allowlist RS256/384/512, iss/aud/nonce), AES-256-GCM token encryption, lifecycleGeneration CAS on refresh, one-time OAuth state + session handoff via atomic getDel, per-org session epoch revocation, deterministic webhook idempotency (`provider:` id or sha256 of topic:identity:payloadHash), lifecycle-topic exemption so uninstall works even when domain mapping is broken, redacted webhook headers, fail-closed production env (48 keys, TRUST_PROXY≠false, secret separation, 32-byte DATA_ENCRYPTION_KEY).

## 3. Load-bearing Files & Contracts

- `server/src/spins/spins.service.ts` — pickWeighted (Math.random), resolveSpin tx engine, claimCoupon, SPIN_RETRY=8, loss fallback.
- `server/public/wheel.js` — storefront widget IIFE; reads `data.result.prize`/`data.result.code` where `result` is a **string enum** (P0, confirmed + independently verified in plans/reports/brainstorm); `prize` object lacks `id` → label-match fallback for animation.
- `server/src/storefront/storefront.service.ts` — `getConfig` returns `{campaign:{id,title,loginRequired,spinLimitPerPlayer,startAt,endAt,config:{colors,buttonText,showRemaining},pages}, slots:[{id,label,kind,value}]}` — no `remaining`, no odds, no window check. upsertPlayer cookieId branch overwrites PII despite comment claiming fill-only.
- `server/src/storefront/storefront-auth.guard.ts` — hash-only key verify + 80/min/shopKey.
- `server/src/storefront/storefront-cors.middleware.ts` — ShopDomain.active → `https://domain` + `www` allowlist; 120/min/IP before DB.
- `server/src/campaigns/campaigns.service.ts` — 1-active-per-shop via app check + partial unique index backstop.
- `server/src/prizes/prizes.service.ts` — PATCH quantity under FOR UPDATE; `remaining = max(0, newQty - consumed)` — no over-issue reset.
- `server/src/coupons/coupons.service.ts` — import dedupe + createMany skipDuplicates in tx; expire only from `available`; `expiresAt` never written anywhere.
- `server/src/script-tags/script-tags.service.ts` — isOurs = origin+pathname match; install() early-returns existing tag.
- `server/src/haravan/*` — haravan.service (OAuth callbacks, token refresh CAS+lock+waitFor), webhook.service (raw-body HMAC, multi-source orgid resolution, deterministic idempotency), uninstall.service (best-effort tag removal via loose `src.includes('/wheel.js')`, shopKey rotation, session revoke, domain tombstone, campaign/player purge), session.service (HMAC token + epoch revocation + atomic handoff), oidc-verifier, hmac-verifier (decoded+raw query candidates, 300s window), oauth-state.service (isSafeRedirect triple-check; file contains literal control chars → reads as non-UTF8 binary).
- `server/src/redis/redis.service.ts` — in-memory fallback; atomic getDel (GETDEL/Lua), owner-checked releaseLock, INCR+EXPIRE Lua.
- `server/src/common/guards/shop-auth.guard.ts` — per-controller opt-in (NOT global): unsafe-method origin check, orgid regex, session verify, x-orgid↔session match.
- `server/src/config/env.schema.ts` — 48-key contract, production fail-closed.
- `server/src/main.ts` — bodyParser:false, raw-body capture, contentTypeGuard 415, admin CORS allowlist, `/wheel.js` static (maxAge 1h immutable), SPA fallback.
- `server/worker/src/{worker,jobs,env}.ts` — schedulers, jobs, env loader.
- `server/prisma/schema.prisma` + baseline migration — Shop/AppInstall/ShopDomain/WebhookEvent/Campaign/PrizeSlot/Coupon/Player/Spin; Spin.prizeSlotId/couponId are snapshot plain fields (no FK).
- `client/src/api/api-client.ts` — axios x-orgid injection, 401→`haravan-app-base:unauthorized` event (listener exists in app.tsx:64; skips oauth/session-exchange paths), single idempotent retry on 502/503/504.
- `client/src/components/{wheel-preview,prizes-editor,coupons-tab}.tsx`, `routes/settings-page.tsx`, `functions/api/[[path]].js` (BACKEND_URL required, no fallback).
- `scripts/scan-anti-patterns.mjs` — scanRoots = server/src, client/src, client/functions, scripts only.
- `package.json` (root) — verify chain; `verify:worker` = `npm --prefix worker` but worker is at `server/worker/`.
- `plans/reports/code-review-260801-1232-*.md` + `brainstorm-260912-2057-oni-luckygame-*.md` — prior audit (most findings verifiably fixed) and the Oni port contract.

## 4. Critical Edge Cases / Traps / Workarounds

**P0 — win renders as loss (release blocker).** `wheel.js` `renderResult` reads `result.prize`/`result.code` where `result` is the string 'win' → every win shows "Chưa may mắn lần này" and the coupon code never displays. `animateToResult` has a `data.prize` fallback so the wheel still lands on the right segment — self-contradictory UX (lands on prize, says loss). No test loads wheel.js.

**Broken verify chain.** Root `verify:worker` targets nonexistent `worker/` prefix → `verify:env` and `scan:anti-patterns` never execute (&& chain). README documents the same wrong path. `server/package.json` test script DOES include `*.spec.ts` (docs claiming specs unwired are stale).

**PII overwrite vs comment.** upsertPlayer cookieId branch overwrites email/phone/customerId when provided; comment + customerId branch implement fill-only. Anyone knowing a cookieId can poison PII.

**Decorative storefront wheel.** wheel.js builds the conic gradient from the color palette count (8 default), not slot count; no labels, no odds-proportional arcs; loss always lands on band 0. Admin `wheel-preview.tsx` renders real per-slot segments — admin sees a different wheel than customers.

**Dead coupon-expiry job.** `Coupon.expiresAt` is never written (no DTO field, no admin UI) → worker job always matches 0 rows.

**Key rotation no-op.** Settings "Tạo public key mới" calls install(), which early-returns when a tag exists → rotation unreachable without manual remove+install.

**Config serves out-of-window campaigns.** `getConfig` filters status=active only; future-dated or just-expired (pre-cron) campaigns still render the wheel; spin then 409s.

**Abuse economics.** Public key + client-generated cookieId ⇒ unlimited Player rows; only 80/min/shopKey bounds coupon-pool drain. `loginRequired` is the only real mitigation. Conversely 80/min shared across config+player+spin self-DoSes shops >~40 pageviews/min.

**Cross-app Redis collision.** Default `REDIS_KEY_PREFIX='haravan-app-base'` in server AND worker — forked apps sharing Redis collide on rate:/lock:/domain:/session-epoch keys.

**Loose uninstall tag match.** `removeWheelScriptTags` uses `src.includes('/wheel.js')` (no origin check) vs strict `isOurs` — could delete another app's tag.

**Scanner blind spot.** `server/public/wheel.js` and `server/worker/` are outside scanRoots — unguarded.

**Binary-flagged source.** `oauth-state.service.ts` has literal control chars in the CONTROL_CHARS regex → file reads as non-UTF8 binary; breaks naive text tooling.

**Stale-snapshot retry.** `campaign.prizeSlots` loaded once outside the retry loop; under contention retries re-pick stale slots → up to 8 wasted tx attempts → loss fallback (win converted to loss under load).

**Minor:** wheel.js cookie lacks `Secure`; popup z-index 2147483647/…46, no focus trap/ESC/aria-modal, no prefers-reduced-motion; `importCoupons` returns `errors:[]` always (dead field); `Math.random` RNG (acceptable, documented); in-memory rate-limit fallback multiplies limits per replica.

## 5. Improvements for Super Core

1. **Fix pattern — race-safe inventory grant (proven here):** player-row `SELECT … FOR UPDATE` for per-identity limits; conditional `updateMany WHERE remaining>0` decrement; conditional claim `WHERE status='available'`; retry loop excluding failed candidates; snapshot plain fields on the ledger row. Canonical "limited-resource grant" pattern.
2. **Anti-pattern — response-contract drift between API and a static JS client:** server returns `{result: string, prize}` while client reads `result.prize`. Rule: hand-rolled widgets consuming a JSON API need a contract test executing the widget against the real response shape (fail-first spec loading wheel.js with a DOM stub — already specified as A1 in the brainstorm contract).
3. **Anti-pattern — verify chain referencing moved component:** `npm --prefix worker` silently breaks all downstream gates. Rule: verify scripts must assert each prefix path exists (extend verify-build-output to inputs, not just outputs).
4. **Platform semantic — Haravan ScriptTag identity:** match by `new URL(src).origin === APP_PUBLIC_URL.origin && pathname === '/wheel.js'`; `src.includes()` is unsafe for cleanup paths.
5. **Platform semantic — public storefront keys:** key embedded in ScriptTag URL is public-by-design; security = hash-only storage (sha256+timingSafeEqual), per-key rate limit, per-shop-domain CORS allowlist, rotation on uninstall/reinstall. Never market as user authentication.
6. **Anti-pattern — comment/code divergence on PII merge:** "fill-only" upsert claims must be enforced by conditional writes in BOTH branches; review checklist item for PII-merge endpoints.
7. **Workaround — cron off-peak minutes:** `13 * * * *` / `37 * * * *` staggered off the hour (workspace convention worth recording).
8. **Rule — env prefix namespacing:** `REDIS_KEY_PREFIX` default must be per-app, never the base template name; forked apps sharing Redis otherwise cross-talk on locks/rate/session-epoch.
9. **Anti-pattern — dead scheduled job:** a worker job whose trigger column is never written (coupon.expiresAt) is dead code; require the write path or delete the job.
10. **Rule — guard opt-in risk:** non-global guards (ShopAuthGuard per controller) need a module-level test asserting every admin controller carries the guard.

## 6. Improvements for Haravan Theme Core Output

1. **Widget/theme contract surface:** the app instructs merchants to paste `window.F1GENZ_WHEEL_CUSTOMER_ID = '{{ customer.id }}'` into theme — ThemeCompiler/HaravanSchemaGenerator should treat "app-provided global JS hooks" as a first-class settings contract (documented snippet, idempotent, null-safe when customer absent).
2. **ScriptTag vs Liquid trade-off:** this app deliberately avoids Liquid (ScriptTag display_scope:'all'). Record that storefront features needing checkout/account pages still require theme edits — ScriptTag cannot reach checkout, which is exactly why the proposed redemption-ledger feature has no integration point.
3. **DOM sanitizer relevance:** wheel.js injects a fixed popup via `innerHTML` with only static markup — a DOM sanitizer auditing storefront widgets should whitelist idempotent `dataset.built` guards and flag missing `aria-modal`/focus management rather than innerHTML itself.
4. **Settings contract gap:** campaign `pages` (glob targeting) and `config.leadForm` exist server-side but have no admin UI — a schema generator should flag "config keys with no editor" as dead settings (same class as F1GENZ settings_schema dead settings).
5. **z-index/overlay conventions:** widget uses z-index 2147483647/2147483646 — theme output should reserve/document top-layer bands so app widgets and theme modals don't fight.

## 7. Improvements for AntiFan Core & Site Clone

**AntiFan Core:**
1. **Verification claim type — "widget contract":** the P0 here is exactly what live storefront evidence catches: spin → observe rendered text + network response would flag `result.prize===undefined` immediately. Add a claim template pairing network response shape with rendered DOM assertion.
2. **CDP telemetry for gamified widgets:** spin wheels need interaction tracing (click → 4s CSS transition → result render); `anti.trace.interaction` + `media.freeze` (freeze RAF/animations for deterministic compare) map directly to this app's verification needs.
3. **Rate-limit probing:** storefront guards (80/min key, 120/min IP) are observable — a verification claim "429 after N requests" is testable live.
4. **Cookie-identity testing:** player identity is a 30-day `f1genz_wheel_id` cookie — device/browser tests should cover cookie-clear → new player → quota reset (the documented abuse path).

**Site Clone:**
1. **IR must model third-party ScriptTag widgets:** cloned storefronts will capture this popup DOM; the IR/component contract needs a "dynamic app widget" node type (script-src keyed, not static DOM) or clones bake a dead wheel popup into static HTML.
2. **Sanitization rule:** strip `f1genz-wheel-popup`/`f1genz-wheel-bar` and the `?shopKey=&key=` script URL on clone — the key is shop-scoped and useless (minor leak) in a clone.
3. **DoD validator addition:** "no live third-party app credentials in cloned output" — scan for `key=`, `shopKey=` query params in script srcs.
4. **Asset pipeline:** `/wheel.js` is same-origin-served immutable static — clone should either localize it (dead without API) or drop it; decide via a per-asset "requires-backend" flag in the IR.
