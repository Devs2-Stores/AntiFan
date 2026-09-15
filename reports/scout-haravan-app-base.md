# Scout Report: haravan-app-base (--ultra)

## 1. Project & Directory

`E:\Work\apps\haravan-app-base` — the hardened, reusable **lifecycle starter for all Haravan apps** (`.workspace-context.json`: `platform: haravan`, `role: base`, `verification: verified`). It is a deliberate re-implementation of the auth/lifecycle spines of F1GENZ Orders, Review, MultiLanguage, Multipage, Collection Tab, and Lucky Code — `docs/source-extraction-map.md` is a source-backed extraction ledger classifying every ported pattern as `copy-adapt` / `reimplement` / `recipe-only` / `document-only` / `avoid`, with file:line evidence from the source apps.

Shape: `server/` (NestJS 11 + Express 5 + Prisma/Postgres + ioredis, CommonJS, `tsx` dev), `client/` (React 18 + Vite 6 + antd 5 + react-query, ESM), `recipes/` (8 docs-only modules; only cloudflare-pages-proxy and pm2-deploy are "stable"), `docs/` (10 contract docs), `scripts/` (verify-env, verify-build-output, scan-anti-patterns), `server/test/lifecycle.test.ts` (697-line node:test suite run via tsx, no external deps — in-memory Redis fallback + fake Prisma).

## 2. Architecture & Role

**Role:** canonical OAuth/OIDC install+login, session, webhook, subscription, and uninstall foundation that every Haravan app is generated from. `docs/future-claude-workflow-brief.md` defines the generator contract: copy base → rename → add `server/src/<feature>/` + `client/src/features/<feature>/` → `npm run verify`.

**OAuth flow (dual login/install):**
- `GET /api/oauth/install/login` → `HaravanService.startLogin` → Redis state+nonce (`oauth-state:{sha256(state)}`, 10min TTL, `hrv_oauth_`+64hex) → authorize URL (`accounts.haravan.com/connect/authorize`, `response_mode=query`).
- Admin launch → `GET .../verify-hmac`: reads `req.originalUrl` raw query (NOT parsed `req.query`), requires `hmac`+`timestamp` (±300s), tries TWO message candidates (decoded pairs, raw pairs) against `HRV_CLIENT_SECRET`, timing-safe hex compare. Missing hmac → SSO start; present-but-invalid → fail-closed 401 (never downgrades). Success → `createHandoff(orgid, '/dashboard')` — note: does NOT check install status.
- `GET|POST /api/oauth/install/login/callback` and `GET|POST /api/oauth/install/grandservice` (install) — both verbs supported because `HRV_RESPONSE_MODE` may be `form_post`. `processLoginCallback`: consume state (atomic GETDEL/Lua) → exchange code → verify id_token (JWKS, RS256/384/512 allowlist, iss/aud/exp/nbf/iat ±60s, nonce match) → orgid from verified claims only → if no install or BLOCKED status (`canceled|expired|needs_reinstall|declined|uninstalled`) → chain into install flow → else `resolveAccessToken` → handoff.
- `processInstallCallback`: same + persists `Shop`/`AppInstall` (AES-256-GCM encrypted tokens, `lifecycleGeneration`/`tokenVersion` increments), tombstones prior domain owners + upserts `ShopDomain` (`{orgid}:{domain}` id, partial unique index `UNIQUE(domain) WHERE active`), applies best `SubscriptionSnapshot`, registers webhooks, all under `lock:lifecycle:{orgid}` (30s owner-token lock). Stale-callback guard: rejects if `oauthState.createdAt < existingInstall.uninstalledAt`.

**Session:** one-time handoff (`hrv_handoff_`+64hex, Redis `session-handoff:{sha256}`, 120s TTL, atomic GETDEL) → `POST /api/auth/session/exchange` (origin-checked) → HttpOnly cookie `haravan_app_session` = hand-rolled HS256 JWT (`{orgid,type:'haravan_app_session',iat,exp}`, 12h TTL). SameSite computed by `siteHost()` eTLD+1 comparison with a hardcoded `MULTI_PART_PUBLIC_SUFFIXES` list — Lax same-site, None+Secure cross-site. `ShopAuthGuard`: origin check (unsafe methods) → orgid regex `^[a-zA-Z0-9_-]{1,128}$` → session verify → requested-orgid (x-orgid/orgid header/query/body) must equal session orgid → `resolveAccessToken` inline (30min refresh window, `lock:refresh:{orgid}` owner lock, bounded waitFor, CAS write `where:{orgid,lifecycleGeneration,status}`).

**Webhooks:** `GET /api/oauth/install/webhooks` = hub.challenge verify (separate `HRV_WEBHOOK_VERIFY_TOKEN`); `POST` = raw-body HMAC (`HRV_WEBHOOK_SECRET`, hex or base64 sig, headers `x-haravan-hmacsha256|x-haravan-hmac-sha256|x-haravan-hmac`) → topic normalize (alias sets → `app_subscriptions/update|app/uninstalled|shop/update|unknown`) → identity resolution (payload orgid + domain→orgid mapping, cross-checked against header/query compat orgid) → idempotent `WebhookEvent` insert (`provider:{topic}:{identity}:{providerEventId}` else `sha256(topic:identity:payloadHash)`) → inline reducer → status processed/failed/ignored + `nextRetryAt`. Registration: `POST https://webhook.haravan.com/api/subscribe` `{webhook_url, topics}` Bearer token, gated by `HRV_WEBHOOK_AUTO_SUBSCRIBE` + `wh_api` scope; status persisted (`not_configured|registered|degraded`), surfaced via `/readyz` (Bearer `READINESS_TOKEN`) and session probe. Shop API: `GET https://apis.haravan.com/com/shop.json`.

**Client:** `/install/login` (HMAC verify OR code-callback OR SSO start; rejects code+hmac ambiguity), `/install/grandservice`, `/dashboard` (AuthGate → `/api/app/session` probe). Axios `withCredentials`, `x-orgid` context header (sessionStorage only, never auth proof), OAuth paths excluded from orgid header + transient retry (1 retry, idempotent methods, 502/503/504/network). `stripSensitiveUrlParams` removes code/state/hmac/handoff/tokens from URL+hash. `client/functions/api/[[path]].js` = Cloudflare Pages same-origin proxy requiring `BACKEND_URL` (no hardcoded fallback — an extracted anti-pattern fix).

## 3. Load-bearing Files & Contracts

- `server/src/haravan/haravan.service.ts` (314 lines) — orchestrator: authorize URL builder, login/install callbacks, `resolveAccessToken` refresh+generation CAS, session probe.
- `server/src/haravan/haravan.controller.ts` — dual-mode endpoints: `wantsBrowserRedirect` (Accept: text/html → 302 + direct cookie set) vs JSON for XHR.
- `server/src/haravan/oauth-state.service.ts` — atomic state consume + `isSafeRedirect` (blocks `//`, backslashes, control chars, `/install*|/oauth*|/api/oauth*` pre/post-decode and post-URL-normalization).
- `server/src/haravan/oidc-verifier.service.ts` — JWKS verify, 10min cache + force-refresh on unknown kid, single-signing-key fallback.
- `server/src/haravan/hmac-verifier.service.ts` — dual-candidate raw-query HMAC; webhook body HMAC hex/base64.
- `server/src/haravan/session.service.ts` — handoff + cookie + `siteHost`/public-suffix SameSite logic + `clearOrgHandoffs` (index keys `session-handoff-org:{orgid}:{digest}`).
- `server/src/haravan/webhook.service.ts` — challenge, identity cross-check, idempotency, inline reducers, header redaction (`SENSITIVE_HEADER_REGEX`).
- `server/src/haravan/subscription.service.ts` — snapshot build/correlation keys (`orgid|domain|subscription|payload`), Redis+Prisma dual store, `applySnapshotToInstall` (`status != uninstalled` guard).
- `server/src/haravan/uninstall.service.ts` — lifecycle lock, clears handoffs/domain/subscription/install Redis keys, nulls all token columns, `lifecycleGeneration`+`tokenVersion` increment, domain tombstone, `dataPreserved=true`.
- `server/src/haravan/shop-domain.service.ts` — `normalizeShopDomain` (protocol-prefix + URL hostname + www-strip), `collectDomains` recursive key walker (depth 3), Redis `domain:{d}`→orgid + DB fallback.
- `server/src/haravan/webhook-topic-normalizer.ts` — canonical topics + alias sets + `WEBHOOK_SUBSCRIBE_TOPICS`.
- `server/src/haravan/token-encryption.service.ts` — AES-256-GCM, 12B IV, key from hex/base64 `DATA_ENCRYPTION_KEY` (must decode to 32B).
- `server/src/haravan/lifecycle-lock.service.ts` + `redis/redis.service.ts` — owner-token locks (Lua compare-del), `getDel` (GETDEL or Lua fallback), `setNx`, `scanKeys` (SCAN not KEYS), `incr`+expire, in-memory fallback when `REDIS_HOST` unset.
- `server/src/config/env.schema.ts` (456 lines) — fail-closed production validation: HTTPS URLs, placeholder detection, `grant_service`/`wh_api` scope requirements, secret separation (session≠client, verify-token≠webhook-secret), `TRUST_PROXY` rejects bare `true`, 32B key checks.
- `server/src/main.ts` — `bodyParser:false`, path-scoped webhook content-type guard + 256kb raw-body capture, manual CORS allowlist, `Cache-Control: no-store` on /api.
- `server/prisma/schema.prisma` — `Shop`, `AppInstall` (encrypted token cols, generation/version, webhook reg status), `ShopDomain` (active/tombstone), `SubscriptionSnapshot` (correlationKey unique), `WebhookEvent` (idempotencyKey unique, attempts/nextRetryAt).
- `client/src/lib/auth-flow.ts` + `api/api-client.ts` + `routes/*` — SPA auth shell.
- `docs/lifecycle.md`, `docs/architecture-contracts.md`, `docs/env-contract.md`, `docs/source-extraction-map.md`, `docs/anti-patterns.md`, `docs/security-checklist.md` — the frozen contracts.
- `scripts/scan-anti-patterns.mjs` — static scanner enforcing 8 anti-pattern rules + 3 file-scoped structural checks.
- `server/test/lifecycle.test.ts` — 12 tests: atomic consume races, SameSite matrix, redirect bypasses, HMAC tamper, OIDC full-claim matrix, orgid mismatch, pre-install snapshot, uninstall tombstone, refresh generation guard, orgid-alone rejection, XFF spoof rate-limit, prod env fail-closed.

## 4. Critical Edge Cases / Traps / Workarounds

**Bugs / liveness gaps:**
1. **`shop/update` reducer never maps NEW domains** (`webhook.service.ts` ~line 230): `if (resolved === identity.orgid) await saveMapping(...)` — a domain not yet mapped resolves null → skipped. Merchant adds a custom domain → future webhooks from it fail identity resolution forever. Should map when `!resolved || resolved === orgid` (still hijack-safe).
2. **Stuck `processing` events are never retried**: crash between `status:'processing'` update and reducer completion leaves the event `processing` permanently; every redelivery returns `{inProgress:true}` → dead event. Needs a processing lease/timeout (e.g. stale `processing` → `received` after N minutes) or the deferred sweeper.
3. **`inFlightAuthFlows` never cleared** (`client/src/lib/auth-flow.ts`): module-level Set keyed by full URL. Navigating back to the identical `/install/login?...` URL in the same SPA session → `beginAuthFlowOnce` returns false → effect returns early → permanent spinner (e.g. dashboard "Start secure login" → back → same URL).
4. **`collectDomains` treats `orgsub` as a domain** (`shop-domain.service.ts` key list includes `'orgsub'`): bare subdomain prefix ("demo") gets normalized into a "domain" and persisted/mapped. Also `normalizeShopDomain` fallback returns arbitrary non-URL strings → garbage rows in `ShopDomain` + bogus `domain:demo`→orgid Redis mappings. Needs hostname-shape validation.
5. **Doc/code drift**: `docs/lifecycle.md` maps `inactive|unactive` → `needs_reinstall`, but `subscription.service.ts normalizeStatus` maps them → `canceled`. One of them is wrong.
6. **`webhookRegistrationStatus` enum `pending`/`failed` never written** — service only writes `not_configured|registered|degraded`; dashboard renders `pending`/`failed` states that can't occur.
7. **Dead contracts**: `install:{orgid}` Redis key deleted on uninstall but never written anywhere; `haravan-app-base:unauthorized` CustomEvent dispatched by api-client but no listener exists.
8. **Stale `dist/src/` tree** inside `server/dist/` (old rootDir build). `verify-build-output.mjs` checks existence of `dist/main.js` only — won't catch stale/wrong-layout output.
9. **CF Pages proxy missing `duplex:'half'`** (`client/functions/api/[[path]].js`): streams `context.request.body` into fetch init — required by undici/Node runtimes; works on workerd but is a portability trap.
10. **`verifyChallenge` uses `!==` string compare** for `hub.verify_token` — timing-unsafe (low severity, but inconsistent with the timing-safe discipline everywhere else).
11. **Idempotency hash uses `JSON.stringify(parsed body)`** — provider redelivery with reordered JSON keys produces a different `payloadHash` → different idempotency key → reducer reruns. Hash the raw body bytes instead (already captured).
12. **No outbound fetch timeouts** (`haravan-api.service.ts` exchangeCode/refreshToken/getShop/subscribeWebhooks, `oidc-verifier` JWKS/discovery): a hung Haravan endpoint holds the 30s lifecycle lock past TTL expiry → lock auto-expires mid-operation → concurrent lifecycle op can interleave (generation CAS still protects token writes, but mutual exclusion is silently lost).
13. **`resolveAccessToken` doesn't re-read install inside the refresh lock** — a just-completed refresh by the lock predecessor forces this caller to refresh again with a possibly-rotated refresh_token → spurious `invalid_grant`.
14. **Refresh failure never recorded**: schema has `tokenRefreshFailedAt`/`tokenRefreshErrorCode`, nothing writes them; `invalid_grant` → `needs_reinstall` policy from `docs/lifecycle.md` is unimplemented.
15. **Subscription Redis snapshots have no TTL** (`redis.set` without ttlSeconds) — stale snapshot can outlive DB truth; mitigated only by explicit `deleteSnapshotLookups` on uninstall.
16. **`MULTI_PART_PUBLIC_SUFFIXES` lacks `.com.vn`/`.co.vn`/`.edu.vn`** — `app.shop.vn` + `api.shop.vn` misclassified cross-site → `SameSite=None` where `Lax` intended (Vietnamese deployments are the primary market).
17. **`Vary: Origin` only set when origin allowed** (`main.ts`) — disallowed-origin responses lack `Vary`, cache-poisoning edge.
18. **`verify-hmac` handoff skips install-status check** — creates a session for uninstalled orgs; downstream guard 401s, but session issuance itself is inconsistent with login-callback behavior.
19. **Browser-mode handoff leak**: `finishAuthFlow` sets cookie directly for `Accept: text/html` but the created handoff code stays in Redis unconsumed until TTL (harmless, wasteful).
20. **Unauthenticated query params feed identity**: `?shop=`/`?shop_domain=` (outside HMAC-signed body) participate in domain→orgid resolution — can only cause rejection/misattribution, not spoofing, but it contradicts the "signed payload only" contract wording.
21. **`domains[0]` snapshot lookup is nondeterministic** — `collectDomains` returns Set order; which domain is used for `findBestSnapshot` depends on insertion order.
22. **`isPaid` heuristic regex** (`/pro|paid|premium|business|monthly|annual|yearly/` on plan name) — plan naming is app-specific; misclassifies custom plan names → wrong `plan`/`status`. Needs per-app override hook.
23. **Rate-limit fingerprint trusts `req.ip`** — correct only because `TRUST_PROXY` is validated; any deployment setting a hop count makes XFF spoofing rotate the bucket (documented trade-off).
24. **`Kind` enum underused**: all non-`*.myharavan.com` domains stored as `alias`; `primary`/`custom` kinds never assigned.

**Workarounds worth codifying (good traps):**
- Raw-query HMAC needs TWO candidates (decoded vs raw pairs) because Haravan's signing encoding is ambiguous — and `req.originalUrl` must be used, never `req.query` (Express re-encodes).
- `bodyParser:false` + path-scoped `express.json({verify})` is the only safe way to get rawBody for webhook HMAC while keeping JSON parsing elsewhere.
- `getDel` needs a Lua fallback for Redis <6.2.
- `session-handoff-org:{orgid}:{digest}` index keys exist solely so uninstall can clear outstanding handoffs without SCANning values.
- In-memory Redis fallback makes the whole lifecycle testable with zero infra — but silently degrades multi-instance prod if `REDIS_HOST` is ever empty (env schema prevents this in prod only).
- `haravan.service.ts`/`webhook.service.ts`/`uninstall.service.ts` cast `prisma as any` — deliberate seam so tests inject fake Prisma without generated client.

## 5. Concrete Improvements for Super Core

Record these as **platform semantics** (`haravan` platform):
- OIDC endpoints: `accounts.haravan.com/connect/{authorize,token}`, discovery `/.well-known/openid-configuration`, JWKS `/.well-known/openid-configuration/jwks`; Commerce API `apis.haravan.com/com/shop.json`; webhook subscribe `webhook.haravan.com/api/subscribe` {webhook_url, topics[]} Bearer — **endpoint shape unverified across app types** (source apps disagree connect-vs-legacy; flag as UNCERTAINTY).
- Scopes: `grant_service` = install/token grant capability; `wh_api` = webhook subscription capability; `org`/`orgsub` claims carry org identity; `orgsub` → `{orgsub}.myharavan.com`.
- Webhook topics arrive as inconsistent aliases (`app_uninstall_webhook`, `apps/uninstalled`, `shop_update_webhook`…) → canonical normalization table required.
- Webhook HMAC headers: `x-haravan-hmacsha256` (hex OR base64); challenge = `hub.verify_token`+`hub.challenge` GET; two separate secrets (verify-token ≠ HMAC secret).
- Launch HMAC signs raw query minus `hmac`, includes `timestamp` (±300s freshness); encoding ambiguity requires dual-candidate verification.

Record these as **anti-patterns** (all source-evidenced): `jwt.decode()` identity trust; non-atomic `get`→`del` state/handoff consume; static/global nonce; direct no-HMAC session from `shop+orgid`; session token in URL/localStorage/sessionStorage; Redis `KEYS`/`getKeys` in prod paths; non-owner lock release (`setNx('1')`+unconditional `del`); random webhook idempotency fallback; header/query orgid trusted without payload/domain cross-check; parsed-body (not raw-body) webhook HMAC; hardcoded proxy `BACKEND_URL` fallback; `pm2 --watch`/`npm install` in prod deploys; `TRUST_PROXY=true`.

Record these as **fix patterns**: atomic GETDEL/Lua consume; one-time handoff code → HttpOnly cookie exchange; lifecycleGeneration CAS guard for uninstall-vs-refresh race; domain tombstone + partial-unique `UNIQUE(domain) WHERE active`; deterministic idempotency `sha256(topic:identity:payloadHash)`; subscription snapshot correlation keys (orgid→domain→subId→payloadHash) stored BEFORE install exists; degraded-not-silent webhook registration status surfaced in protected readiness; dual-candidate raw-query HMAC; env fail-closed validation incl. placeholder detection + secret-separation rules; `isSafeRedirect` triple-check (raw, decoded, URL-normalized) with auth-route prefix blocklist.

New pitfalls from THIS codebase worth recording: stuck-`processing` webhook events need a lease/timeout; `orgsub`-as-domain pollution; JSON-key-order-sensitive payload hashing; missing `duplex:'half'` on streamed Pages Function bodies; never-cleared single-flight Sets in SPA auth flows; doc-vs-code status-alias drift.

## 6. Concrete Improvements for Haravan Theme Core Output

- **Adopt the contract-freeze doc pattern**: `lifecycle.md`/`architecture-contracts.md` style "must not do" tables per module map directly onto ThemeCompiler/HaravanSchemaGenerator — freeze the settings contract (setting-id/setting-type attrs, schema↔data parity) the same way before codegen.
- **Port `verify-env.mjs` parity checking** → a `verify-settings.mjs`: every `settings_schema.json` id must appear in `settings_data.json` defaults and vice-versa; placeholder detection for image/asset defaults; fail on real merchant domains in committed config (same "placeholder-only .env.example" rule → "placeholder-only settings_data").
- **Port `scan-anti-patterns.mjs`** → theme scanner: `jwt.decode`-equivalents for themes = unescaped `{{ }}` output of settings, `include` of missing snippets, hardcoded shop domains, `slice` LINQ-dump patterns (HS gates), noPS violations — codified as regex+file-scoped rules with a "rewrite code, don't weaken scan" policy.
- **Deterministic idempotency key** → DOM sanitizer node identity: `sha256(tag:path:contentHash)` not random/positional ids, so sanitized DOM diffs are stable across runs.
- **Alias normalization** (`webhook-topic-normalizer`) → setting-type/component-type normalizer: accept `font-size`/`font_size`/`fontStyle` legacy variants → canonical type, exactly like topic aliases.
- **Snapshot-correlation pattern** → theme compile inputs: resolve section/schema/asset by priority chain (explicit id → path → hash) with the same `lookupKeys` fallback ordering.
- **Tombstone pattern** → settings/asset removal: never hard-delete a setting id that may be referenced by published templates; tombstone + active-flag, mirroring `ShopDomain`.
- **Fail-closed validation**: env.schema's "production refuses placeholders" → ThemeCompiler refuses to emit when required schema fields are placeholder/empty, rather than emitting dead settings.
- **Beware the `isSafeRedirect` duplication trap**: identical logic in server+client already risks drift — ThemeCompiler's sanitizer and the DOM sanitizer must share ONE implementation or a generated contract test, not two copies.

## 7. Concrete Improvements for AntiFan Core & Site Clone

**AntiFan Core (Desktop browser/CDP/verification):**
- **Raw-body-before-parse discipline** → `theme.export_clean`/`dump_dom`: hash and persist the RAW captured DOM bytes before any sanitization; run sanitizer as a separate, replayable stage (mirrors rawBody→HMAC→reducer ordering: "no mutation before verification").
- **`WebhookEvent` state machine** → verification claims: `received→processing→processed|failed|ignored` + `attempts`/`nextRetryAt`/`lastError` + unique idempotency key per claim — and add the **processing-lease fix this codebase lacks** (stale `processing` → requeue) to AntiFan's claim pipeline from day one.
- **Header redaction** (`SENSITIVE_HEADER_REGEX`) → CDP telemetry/network capture: strip `authorization|cookie|set-cookie|x-forwarded-*|cf-*` before persisting HAR-like data.
- **Owner-token lock + generation CAS** → CDP navigation/tab operations: `lock:nav:{tabId}` owner compare-release + generation guard so a detached/rebound tab can't apply stale navigation results (direct analog of uninstall-vs-refresh).
- **Ingress rate limiter + origin policy** → any new HTTP surface (artifact read, spec validate gate): bucket+fingerprint+window, `isTrustedUnsafeOrigin` for unsafe methods.
- **`wantsBrowserRedirect` dual-mode** → tools that serve both GUI (302/HTML) and agent (JSON) callers from one endpoint.
- **Env fail-closed loader** → AntiFan config: placeholder detection, HTTPS-in-prod, secret-separation, `TRUST_PROXY`-style "no bare true" rules.
- **`getDel`/`setNx`/Lua helpers + in-memory fallback** → artifact leases and one-time capture tokens; the in-memory mode is also the test seam.

**Site Clone (@antifan/site-clone):**
- **`source-extraction-map.md` IS the IR classification model**: its `copy-adapt|reimplement|recipe-only|document-only|avoid` taxonomy + per-domain evidence rows = exactly what the component contract IR needs (per-node: classification, source evidence ref, target destination, preserve-list, risk-list). Adopt the table shape wholesale.
- **Contract-freeze docs** → IR contract: freeze component contract fields (props, slots, assets, variants) in a `*-contract.md` before codegen, "change only when proven wrong by source evidence".
- **Correlation-key lookup chain** → IR node identity: `explicit-id → normalized-path → content-hash` fallback ordering, same as subscription `lookupKeys`.
- **Deterministic idempotency** → asset pipeline dedup: `sha256(canonical-url:bytes)`; and **hash raw bytes, not re-serialized forms** (lesson #11 above applies to asset hashing too).
- **Tombstone + partial-unique** → asset registry: `UNIQUE(url) WHERE active` so re-clones don't collide with tombstoned assets.
- **Alias normalizer** → component-type canonicalization (e.g. `hero-banner|hero_banner|heroBanner` → `hero`).
- **Anti-pattern scanner** → DoD validator: ship a `scan-clone-anti-patterns` (external links remaining in offline mode, unlocalized subresources, Livewire/SSR blobs, unhydrated modals) with the same "rewrite code over weakening scan" rule.
- **Offline standalone = fail-closed**: mirror env.schema — clone output refuses "done" status while any external reference remains unresolved (placeholder detection → external-URL detection).
- **Domain-collection caution → asset-URL collection**: `collectDomains` shows recursive key-walkers ingest garbage without shape validation — Site Clone's asset collector MUST validate URL/host shape before enqueueing downloads or it will persist junk entries.
- **Atomic consume** → clone job claims: `getDel` semantics for one-time job/lease tokens in the pipeline.
- **Build-output verification depth**: `verify-build-output.mjs` only checks existence — Site Clone's DoD validator must check freshness/completeness (file count, no stale artifacts, all referenced assets present), not just presence of an entrypoint.

**Cross-cutting note for all four targets:** this repo's single most reusable asset is `docs/source-extraction-map.md` — a proven method for turning N messy production codebases into one hardened contract: classify every pattern (copy-adapt/reimplement/recipe-only/document-only/avoid) with file:line evidence, freeze contracts in docs BEFORE code, then enforce with a static anti-pattern scanner + a zero-infra lifecycle test suite. That pipeline is directly applicable to Super Core ingestion, theme-output contracts, AntiFan verification claims, and Site Clone's IR.
