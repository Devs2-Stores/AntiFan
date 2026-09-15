# WebhookGateway — Ultra Deep Scout Report

## 1. Project & Directory

`E:\Work\apps\WebhookGateway` — standalone repo `F1GENZ/WebhookGateway` (own `.git`, not part of `E:\Work` monorepo). Internal-only service ("Chỉ Devs2-Stores quản trị. Không public.") deployed to a DigitalOcean VPS via GitHub Actions + pm2. Stack: NestJS 10, Express 4, Prisma 5 + PostgreSQL, ioredis (optional, in-memory fallback), AES-256-GCM, commander CLI, tsx, node:test. `.workspace-context.json` marks it `role: gateway`, `platform: haravan`, `verification: pending`. ~30 source files under `server/src/`, 10 test files (~90 tests), 5 docs, 2 prisma migrations.

## 2. Architecture & Role

Single trust boundary between Haravan and all F1GENZ workspace apps. Responsibilities concentrated here (explicitly removed from child apps): HMAC verification, durable event storage, retry/replay, secret custody. Child apps never see Haravan secrets and never call Haravan for missed payloads (within the 24h window).

Two processes from one codebase: `main.ts` HTTP server (Express, rawBody capture, content-type guard, CORS allowlist) and `worker.ts` delivery loop (retention purge + push drain).

Pipeline: `POST /webhooks/haravan/:sourceKey` → content-type guard → rawBody capture → provider lookup → HMAC verify (per-sourceKey decrypted secret) → topic normalize → orgid→ShopBinding → idempotency dedupe → encrypted WebhookEvent (TTL) → ConsumerDelivery fan-out per active subscription → 200. Delivery: pull consumers `claim→ack|nack` with leaseToken fencing; worker pushes signed envelopes to push consumers. Broker: `GET /api/consumer/v1/haravan/orders[/:id]` allowlist-only upstream proxy with per-shop permission + scope check + Redis rate limit + locked token refresh.

Module map: config (fail-fast env schema), database (Prisma), crypto (AES-256-GCM single-key), registry (ProviderApp/ShopBinding/ConsumerApp/Subscription), webhook (HMAC verifier, topic normalizer, ingress), delivery (lease queue + retry policy), consumer (pull API + envelope builder), push (outbound signature + SSRF-checked fetch), broker (auth guard, permission, rate limit, token refresh, Orders client), maintenance (payload TTL purge), redis, health, common/url-policy (DEAD CODE — stronger SSRF guard used only by tests).

## 3. Load-bearing Files & Contracts

- `server/src/webhook/webhook-ingress.service.ts` — core ingress: provider lookup, HMAC verify, topic normalize, orgid→binding resolve, idempotencyKey, AES-GCM payload encrypt (swallows failures → null payload), event create + delivery fan-out (NOT transactional), P2002→duplicate. Line 81 hardcodes 24h TTL ignoring env.
- `server/src/webhook/webhook.controller.ts` — GET/POST `/webhooks/haravan` diagnostic echo (no auth, logs rawBody PII, returns rawBodyPreview); POST `:sourceKey` ALWAYS returns 200 incl. `{ok:false}` on HMAC/DB failure.
- `server/src/webhook/hmac-verifier.service.ts` — HMAC-SHA256 over rawBody, hex|base64 signature parse, timingSafeEqual; hub.challenge verify_token XOR compare.
- `server/src/webhook/topic-normalizer.service.ts` — ORDER_TOPICS allowlist (6 topics) + alias map (order/create→orders/create, canceled→cancelled). Non-order topics → ignored with NO persisted record; 'ignored'/'expired' event statuses are dead enum values.
- `server/src/delivery/delivery-queue.service.ts` — Postgres lease queue: claim() raw SQL CTE FOR UPDATE SKIP LOCKED joins WebhookEvent.payloadExpiresAt>now, sets processing+leaseOwner+attempt+1 (attempt burns on claim; no maxAttempts check on claim path → infinite poison reclaim); ack/nack/deadLetter/expireByIds/replay. nack accepts UNCLAMPED consumer retryAfterMs.
- `server/src/delivery/retry-policy.ts` — exp backoff: base 1s×2^(n-1), cap 300s, ±30% jitter, maxAttempts 8.
- `server/src/push/push-delivery.service.ts` — worker push drain: claim mode=push → buildEnvelopes → endpoint+secret → assertSafeTarget (WEAK duplicate SSRF check; throws → caught in drain → never dead-letters → infinite reclaim loop) → sign → fetch (redirect:error, timeout, Retry-After ≤60s) → 2xx ack / 408|429|5xx nack / other 4xx dead-letter.
- `server/src/push/outbound-signature.service.ts` — `X-Gateway-Signature = base64(HMAC-SHA256(timestamp + "." + rawBody, signingSecret))`; toleranceSeconds param accepted but UNUSED.
- `server/src/common/url-policy.ts` — validatePushUrl, the STRONGER SSRF guard (127/8, 169.254/16, IPv6 fc/fd/fe80, ::1) — dead code, referenced only by tests.
- `server/src/consumer/consumer-delivery.service.ts` — pull claim (clamped batch/lease, leaseToken=randomUUID) + buildEnvelopes (decrypt; null payload ambiguity; decrypt throw → 500 AFTER claim burned attempt + leaseToken lost).
- `server/src/consumer/consumer-auth.guard.ts` — X-Consumer-Key + X-Consumer-API-Key → sha256 + timingSafeEqual; requires mode==='pull' (broker guard does NOT check mode).
- `server/src/broker/broker-auth.guard.ts` — api key + sourceKey/orgid → active binding → orders_read permission → credential valid + com.read_orders|com.write_orders scope.
- `server/src/broker/haravan-http-client.ts` — allowlisted upstream GET: path must start '/', no '://'/'..', origin-locked to HARAVAN_API_BASE_URL; Redis rate limit; 3 attempts: 401→force refresh once, 429→Retry-After ≤30s, 408/5xx retryable, 403→SCOPE_MISSING; AbortController timeout; redirect:error.
- `server/src/broker/token-refresh.service.ts` — refresh window → Redis lock broker:refresh:{src}:{org} → double-check → POST accounts.haravan.com/connect/token → replaceTokensIfCurrent CAS on lifecycleGeneration → terminal errors mark credential invalid_grant.
- `server/src/broker/shop-credential.service.ts` — encrypted credential import/upsert, getDecrypted, revoke, CAS replaceTokensIfCurrent, markRefreshFailed(terminal→invalid_grant).
- `server/src/broker/rate-limiter.service.ts` — fixed-window INCR broker:rate:{src}:{org}:{epochSec}, 4rps; expire only when count==1 (crash → no-TTL key); in-memory fallback is per-process.
- `server/src/maintenance/payload-retention.service.ts` — BUG: purges where payloadExpiresAt <= now - PAYLOAD_RETENTION_HOURS while expiresAt was already receivedAt+24h → effective retention 48h; deliveries expire at expiresAt<=now → 24–48h zombie window.
- `server/src/crypto/token-encryption.service.ts` — AES-256-GCM, 12B IV, single DATA_ENCRYPTION_KEY; keyId stored but IGNORED on decrypt → no rotation overlap.
- `server/src/registry/consumer-app.service.ts` — apiKey=sha256 hash only, signing secret AES-GCM, rotateSigningSecret stores previousCipherJson (never used → no verify overlap), setPushEndpoint validates regex only (SSRF deferred to send time → registered poison URLs).
- `server/src/registry/subscription.service.ts` — TOPIC_REGEX free-text, does NOT normalize → 'order/create' subscription silently never matches normalized ingress lookup.
- `server/src/main.ts` — rawBody capture via json verify, /webhooks content-type guard + 256kb limit, CORS allowlist, Cache-Control:no-store for /webhooks + /v1 — MISSES /api/consumer/v1 (PII envelopes cacheable).
- `server/src/worker.ts` — retention every RETENTION_INTERVAL_MS + push drain serially per claim (≤5s timeout each, batch=CONSUMER_PULL_BATCH_SIZE → up to ~50s/tick; no concurrency).
- `server/scripts/manage-gateway.ts` — admin CLI. BUG: consumer:create + rotate-api-key + rotate-signing-secret print maskSecret() of one-time secrets → real values unrecoverable. Docs show -s secret flag; code reads GATEWAY_PROVIDER_CLIENT_SECRET env.
- `server/prisma/schema.prisma` — 10 models; WebhookEvent.idempotencyKey unique, ConsumerDelivery.dedupeKey unique, ShopCredential.lifecycleGeneration CAS.
- `server/src/config/env.schema.ts` — fail-fast env loader, production-required keys, placeholder detection, NODE_ENV required when DATABASE_URL non-local. WEBHOOK_RATE_LIMIT_* in .env.example but NEVER parsed.
- `server/docs/consumer-contract.md` — Envelope v1 `{schemaVersion:1, eventId, deliveryId, source, topic, orgid, receivedAt, attempt, payload}`; eventId stable across retry; push signature headers + status→action table.
- `server/docs/data-retention.md` — retention/encryption/SSRF/log-redaction policy — contradicted by diagnostic route + 48h effective TTL.
- `server/docs/operations-runbook.md` — alert thresholds; replay() exists in code but NO CLI/HTTP surface → dead-letters need raw DB access.
- `.github/workflows/deploy.yml` — rsync→VPS + npm ci + prisma migrate + pm2. BUG: deletes pm2 'webhook-gateway-*' but starts 'api-gateway*' → stale-name orphans.

## 4. Critical Edge Cases / Traps / Workarounds

### Severity-1 (data loss / security)

1. **Diagnostic routes leak PII + bypass verification** — `GET`/`POST /webhooks/haravan` (no sourceKey): echoes hub.challenge with NO verify_token check; POST logs rawBody (customer email/phone/address) at debug and returns rawBodyPreview(500 chars)+headers. Contradicts data-retention.md. Misconfiguration trap: callback registered without :sourceKey gets `200 {diagnostic:true}` — events "succeed" and vanish.
2. **Always-200 ingress → silent event loss** — handleIngress catches ALL errors (bad HMAC, missing orgid, unknown binding, DB down) → `200 {ok:false}`. Haravan treats 200 as delivered → no retry, no record, no metric. Transient DB outage permanently drops every event. Correct: 200 only for verified+persisted/intentionally-ignored; 5xx transient, 4xx auth.
3. **CLI masks the secrets it tells you to save** — consumer:create/rotate-api-key/rotate-signing-secret print maskSecret(value) while note says "Store now — not retrievable later". Only sha256 hash stored → consumer API keys unrecoverable; pull auth can never be configured; push consumers can never verify signatures. Showstopper.
4. **Retention double-counts TTL → payloads live 48h, not 24h** — ingress sets expiresAt=now+24h (hardcoded, ignores env); purge is expiresAt <= now - PAYLOAD_RETENTION_HOURS → deletion at +48h. Claim/nack/replay treat expiresAt<=now as dead → 24–48h zombie window: ciphertext exists but undeliverable/unreplayable.
5. **Poison-pill infinite reclaim loop** — pushOne throws on assertSafeTarget failure (and any unexpected error); drain catches → failed++ → delivery stays processing → lease expiry → reclaim → throw again. attempt increments per claim but claim SQL never checks maxAttempts → spins every poll tick until payload expiry. Terminal config errors must dead-letter.
6. **SSRF guard duplicated; the strong one is dead code** — common/url-policy.ts (127/8, 169.254/16, IPv6 fc/fd/fe80/::1) imported only by tests. Live assertSafeTarget misses entire 127.0.0.0/8 (only exact 127.0.0.1), all of 169.254.0.0/16 except metadata IP, ALL IPv6 (`https://[fd00::1]/` passes). Neither resolves DNS → public hostname → private IP bypass (DNS rebinding). setPushEndpoint validates regex only → poison URLs registerable.
7. **Event create + delivery fan-out not transactional** — crash between webhookEvent.create and consumerDelivery.create → event exists, zero deliveries; provider retry hits P2002 → returns duplicate:true without recreating deliveries → permanently undelivered. Needs $transaction or outbox.
8. **encryptPayload swallows crypto failure → hollow event** — catch→null → event stored status:received with null ciphertext → deliveries carrying payload:null (indistinguishable from empty payload). Should fail ingress → provider retry.

### Severity-2 (contract/operational traps)

9. **Idempotency key missing sourceKey on providerEventId path** — `provider:{topic}:{orgid}:{id}`: two provider apps emitting same webhook-id for same org+topic collide → second event dropped as duplicate. (Fallback hash path DOES include sourceKey.)
10. **Subscription topic stored raw, ingress queries normalized** — `subscription:create -t order/create` passes TOPIC_REGEX but never matches listActiveByBindingAndTopic(binding,'orders/create') → silent never-fire.
11. **No lifecycle/uninstall handling** — isOrderTopic gate drops everything else as ignored with NO persisted record (dead ignored/expired enums). app/uninstalled never reaches consumers and never revokes ShopCredential → broker serves tokens for uninstalled apps until refresh hits invalid_grant.
12. **Attempt burns on claim, not outcome** — crash-looping consumer (claim→die→lease-expiry) burns attempts without any nack; combined with #5 the only escapes are explicit nack or payload expiry.
13. **Consumer-supplied retryAfterMs unclamped** — nack accepts retryAfterMs=0 → instant reclaim hot-loop; huge values → dead-letter via expiry check. Clamp to policy bounds.
14. **buildEnvelopes runs after claim** — corrupt ciphertext → decrypt throws → 500 AFTER attempt burned and leaseToken lost → stuck till lease expiry; one bad row fails whole batch.
15. **Cache-Control: no-store misses /api/*** — consumer pull responses (PII envelopes) and broker responses cacheable by intermediaries.
16. **Dead config surface** — WEBHOOK_RATE_LIMIT_* documented, never parsed → no ingress rate limit (HMAC-fail storms hit DB: provider lookup + secret decrypt per request). CONSUMER_SIGNING_TOLERANCE_SECONDS parsed/required-in-prod/passed to signPushPayload which ignores it. previousCipherJson stored on rotation, never read → signing-secret rotation has zero overlap window.
17. **Replay has no surface** — replay() exists; runbook admits "replay qua Prisma (CLI command sắp có)" → dead-letters need raw DB access.
18. **Doc/CLI/deploy drift** — docs show `provider:create -s SECRET`/`provider:rotate -s NEW_SECRET`; code reads GATEWAY_PROVIDER_CLIENT_SECRET env (commander -s collides with -s status). deploy.yml pm2 delete 'webhook-gateway-*' then starts 'api-gateway*' → orphans.
19. **Redis incr TTL race + memory fallback semantics** — expire only when count==1; crash between INCR and EXPIRE → no-TTL key. No REDIS_HOST → per-process locks/rate-limits; redis.ping() returns true when unconfigured → readiness reports redis ok.
20. **rawBody fallback re-serializes JSON** — `rawBody ?? Buffer.from(JSON.stringify(req.body))`: if capture missed, HMAC over re-serialized body → false rejects. Wired correctly today; fragile to parser-order changes.
21. **Header redaction gaps** — SENSITIVE_HEADER_REGEX misses x-api-key, proxy-authorization, x-consumer-api-key; x-haravan-hmacsha256 stored on event (enables offline secret brute-force in theory).
22. **Minor**: broker guard doesn't check consumer.mode (pull guard does); waitFor refresh poll 2.5s max vs 15s refresh timeout → premature 503s; worker push drain fully serial (≤50s/tick); pushTimeoutMs unclamped; WebhookEventInput/DeliveryOutcomePayload dead types; verifyApiKey double DB read; events with 0 subscribers stored but unreachable (no backfill path).

### Proven-good patterns worth extracting

- SKIP LOCKED claim CTE with lease fencing (delivery-queue.service.ts:40-70).
- Token refresh: Redis lock + double-check + lifecycleGeneration CAS + terminal-vs-retryable classification.
- Retry-After honored with hard clamps (push ≤60s, broker ≤30s); redirect:'error' + AbortController timeout on every fetch.
- Env schema: aggregated fail-fast errors, production-only requirements, placeholder detection, NODE_ENV required when DATABASE_URL non-local.
- Secrets into CLI via env vars (no argv → no shell history); timingSafeEqual everywhere; upstream path allowlist + origin lock for broker (not a generic proxy).

## 5. Concrete Improvements for Super Core (@antifan/super-core)

**Platform semantics (haravan) to record:**
- Webhook HMAC headers: `x-haravan-hmacsha256` | `x-haravan-hmac-sha256` | `x-haravan-hmac`; signature hex OR base64; verify over RAW body bytes — re-serialized JSON breaks it.
- Topic header `x-haravan-topic`/`x-haravan-webhook-topic`; alias chaos: `order/create` vs `orders/create`, `canceled` vs `cancelled`, `_created` suffixes → normalization map required BEFORE routing/subscription matching.
- Webhook id: `x-haravan-webhook-id`/`x-haravan-id`; orgid in payload as `orgid`|`org_id`|`organization_id`.
- Challenge handshake: GET `hub.verify_token`+`hub.challenge` → echo challenge.
- OAuth: `accounts.haravan.com/connect/token`, form `grant_type=refresh_token`; API base `apis.haravan.com/com`; `com.write_orders` implies read; rate header `x-haravan-api-call-limit`.
- Haravan auto-deletes webhook subscriptions on repeated signature failures (runbook) → always-200 hides BOTH attacks and real outages.

**Anti-patterns (each with this repo as evidence):**
- "Diagnostic echo route shipped in production controller" → leaks rawBody to logs+response; gate by env or delete.
- "200-on-error ingress ack" → provider never retries; honest 4xx/5xx required.
- "Swallow crypto/serialize failure → store hollow record" → downstream gets payload:null ambiguity.
- "Duplicate security guard, stronger copy dead in tests" → single SSRF/policy module used at registration AND send time.
- "Env var documented but never parsed" / "param plumbed but unused" / "compat field stored but never read" → dead config trio (WEBHOOK_RATE_LIMIT_*, SIGNING_TOLERANCE, previousCipherJson).
- "Mask the one-time secret in CLI output" → unrecoverable credentials.
- "Attempt incremented at claim" + "no attempt ceiling on claim path" → poison-pill infinite loop.
- "TTL written at ingest AND re-subtracted at purge" → double retention.
- "Raw subscription key vs normalized lookup key" → silent never-match.

**Fix patterns:**
- Ingress honesty: {ok:false}-200 → persist-then-200 / 4xx auth / 5xx transient.
- Double TTL: expiresAt=now+TTL + purge expiresAt<=now (single source).
- Masked reveal: print once at create/rotate, mask only in list/logs.
- Terminal-vs-retryable push errors: config/SSRF/secret errors → dead-letter; network/5xx/429 → nack.
- Idempotency keys must include EVERY namespace dimension (sourceKey+topic+orgid+providerEventId).

**Workarounds to record:** Redis-lock+CAS token refresh; Retry-After clamping; SKIP-LOCKED queue; env-var secret injection for CLIs; in-memory Redis fallback flagged dev-only (breaks multi-process lock/rate-limit semantics).

## 6. Concrete Improvements for Haravan Theme Core Output

- **Version every emitted contract** — envelope schemaVersion:1 is the model: ThemeCompiler output, HaravanSchemaGenerator settings contract, and component IR should carry explicit schema versions so consumers can gate on them.
- **Single normalization map at the boundary** — topic alias map ↔ platform quirks (Haravan vs Sapo setting types, canceled→cancelled-style variants). Normalize at ingest, store normalized, match on normalized — the subscription-topic bug (#10) is exactly what happens when write-side and read-side disagree.
- **Deterministic content hashes for dedupe/cache** — payloadHash/dedupeKey pattern → theme asset pipeline: content-hash emitted assets for dedupe + cache-busting.
- **Fail-honest compile semantics** — the always-200 lesson maps to ThemeCompiler: never emit ok:true with silently dropped sections; distinguish hard errors (abort) from soft warnings (annotate), and persist an audit record of ignored/unsupported input (the dead `ignored` enum shows the cost of dropping silently).
- **Env-schema-style config validation** — aggregated fail-fast errors + placeholder detection + production-only requirements is directly reusable for theme compile/settings validation.
- **Redaction/allowlist single source of truth** — one canonical sensitive-attribute/protocol list for the DOM sanitizer; the diagnostic route proves a second hand-rolled copy always drifts.
- **Doc↔CLI drift test** — docs showed -s flags the CLI rejects; generate or test documented commands against the real CLI schema.

## 7. Concrete Improvements for AntiFan Core & Site Clone

**AntiFan Core (browser/CDP/SnapDOM/sanitization/verification):**
- **Never verify on 200 alone** — this gateway returns 200 for every failure mode; AntiFan verification claims must require DOM/state evidence, not HTTP status (mirrors anti.verification.* proof obligations).
- **Verify against raw bytes, not re-serialized DOM** — the HMAC-over-rawBody lesson: SnapDOM/sanitization decisions must capture pre-mutation state; re-serialization destroys signatures and evidence.
- **Lease fencing for concurrent actors** — leaseOwner/leaseToken fencing is the same pattern as set_automation_target CAS; any future multi-agent tab control needs the same fencing on action ack.
- **Terminal errors must kill the claim** — the poison-pill loop (#5) maps to dead tabs/0x0 surfaces: fail permanently, don't requeue (browser_evaluate's degraded-surface refusal is the right instinct — extend it to the retry layer).
- **One canonical strip-list** — livewire/SSR sanitization strip patterns = the header-redaction list problem; keep a single shared list, test it, never re-implement per route.
- **Diagnostic surfaces gated** — the leaking diagnostic route ↔ any debug/dump endpoint needs env gating + redaction by default.

**Site Clone (@antifan/site-clone):**
- **IR versioning + content-hash dedupe** — envelope schemaVersion + payloadHash/dedupeKey → component contract IR should carry schemaVersion and content-hash every asset for deterministic dedupe.
- **TTL-aware asset materialization** — payloadExpiresAt + replay-before-expiry → offline standalone mode must materialize ALL lazy/deferred subresources before the source becomes unavailable; the zombie-window bug (#4) shows TTL semantics must be single-sourced.
- **SSRF-grade fetch policy for the asset pipeline** — cloning user-specified URLs needs the strong url-policy (HTTPS, private ranges, IPv6, DNS resolution, allowlist) — adopt the dead url-policy.ts checklist, don't copy the weak inline one.
- **Namespace every dedupe key** — the missing-sourceKey collision (#9) → IR component/asset keys must include site/source namespace.
- **Atomic manifest writes** — event+deliveries non-transactional (#7) → IR + asset manifest must commit atomically (the dump_dom atomic-write approach is the model).
- **Record refusals, don't drop silently** — ignored events leave zero audit (#11) → DoD validator should log every skipped/sanitized node (aligns with antifan-dogfood-clone contract-refusal reporting).
- **Wire compat fields or delete them** — previousCipherJson stored-but-unused → if standalone mode keeps a previous-manifest slot, it must be consumed or removed.
