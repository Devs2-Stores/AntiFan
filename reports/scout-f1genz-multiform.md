# Scout Report — F1GENZ Multiform (E:\Work\apps\F1GENZ Multiform)

## 1. Project & Directory

**F1GENZ Multiform** — production Haravan embedded app ("headless form ingress + lead CRM"). Merchants embed Liquid snippets (or keep native Haravan contact/customer forms); a storefront JS interceptor normalizes arbitrary field names and POSTs JSON to a public ingress API; submissions land in PostgreSQL and are worked in an embedded React CRM (table + Kanban + CSV export). Live at https://multiform.f1genz.dev (VPS + PM2 + Cloudflare Tunnel, Supabase Postgres, Redis Cloud).

```
server/            NestJS + Prisma + Redis API (port 3025, PM2 fork)
  src/haravan/     OAuth/OIDC, HMAC, webhooks, script tags, uninstall, subscriptions
  src/forms/       public-ingress.controller, admin-forms.controller,
                   admin-submissions.controller, honeypot.interceptor,
                   public-form-origin.service, csv-export.service
  src/entitlements/ entitlement + usage (quota reserve/commit)
  src/jobs/        Postgres outbox worker (separate PM2 process)
  prisma/schema.prisma  Shop, AppInstall, ShopDomain, Form, FormSubmission,
                        ShopEntitlement, UsageCounter/Reservation, OutboxEvent…
client/            React + Vite + AntD embedded admin SPA
  src/routes/      forms-page (48KB), inbox-crm-page, dashboard, settings…
  src/components/crm/  crm-payload-heuristics.ts, safe-value-renderer.tsx
  functions/api/[[path]].js  Cloudflare Pages → BACKEND_URL proxy
storefront/        Distributable theme kit
  assets/f1genz-multiform.js  390-line vanilla interceptor (v1.2.0)
  assets/f1genz-multiform.css tokenized via --f1genz-form-* vars
  snippets/        6 Liquid presets: contact, customer, quote, consultation, survey, booking
scripts/           verify-env.mjs, scan-anti-patterns.mjs (custom static gate)
docs/              architecture-contracts.md (frozen V1 contract), deploy.md, env-contract.md
plans/             4 completed ultra plans incl. universal-form-inputs-normalization
recipes/           docs-only modules (R2 uploader, queue-worker, metafields…)
```

**No Google Sheets/Forms integration exists.** Roadmap Phase 4 lists "webhook outgoing integrations (Google Sheets, Lark Base, KiotViet)" as future work. The only spreadsheet-adjacent surface is `CsvExportService` (formula-injection-safe streaming CSV).

## 2. Architecture & Role

Storefront form → f1genz-multiform.js interceptor/normalizer → POST /api/v1/p/forms/:id/submissions → HoneypotInterceptor (sanitize + spam flag) → PublicFormOriginService (origin→domain→shop) → Prisma tx (entitlement assert + usage reserve + insert) → FormSubmission. Admin SPA (ShopAuthGuard cookie) → AdminForms/Submissions CRUD + CSV. OAuth install → ScriptTagRegistrationService injects the JS + WebhookRegistrationService subscribes app/uninstalled, shop/update, app_subscriptions/update. Optional dual-sync re-POSTs to native /contact or /account/register.

- **Multi-form model**: `Form` has `publicFormId` (cuid, globally unique) + `formKey` (unique per shop, regex `^[a-z0-9-_]{2,64}$`). Reserved keys `contact`/`customer` auto-detected by storefront JS; any other key is **auto-bootstrapped** on first submission if Origin/Referer host maps to an active ShopDomain.
- **Submission contract**: POST JSON or urlencoded, ≤32KB, optional `Idempotency-Key` header (≤128 chars). Response `{ok, data:{submissionId, status, duplicate?}}` or neutral Vietnamese HTML success page when `Accept: text/html` (native POST fallback).
- **Payload contract**: free-form JSON, normalized identically on client+server: strip system keys (`utf8`, `authenticity_token`, `form_type`, `g-recaptcha-*`, `_f1genz*`, honeypot fields), unwrap bracket namespaces (`contact[x]`, `customer[a][b]`→`a.b`, `x[]`→array), `contact[body]`→`message`, synthesize `name` from `last_name+first_name` / `ho+ten_dem+ten` / aliases (`ho_ten`, `hoten`, `fullName`, `customer_name`), dedupe `body`/`fullName`.
- **CRM contract**: statuses `new|contacted|in_progress|won|lost|spam`; `assignedTo` ≤120, `internalNotes` ≤2000; client `categorizePayload` re-derives name/email/phone/subject/message via EN+VI key dictionaries — server stores raw payload, UI does semantic mapping.
- **Quota**: `UsageService.reserve→commit` in same tx; metrics `active_forms`, `submissions`, `storage_bytes`; spam skips reservation. `ShopEntitlement` + `lifecycleGeneration` fence is sole authority.

## 3. Load-bearing Files & Contracts

- `server/src/forms/public-ingress.controller.ts` — ingress endpoint; formKey auto-bootstrap (~lines 95-140); idempotency pre-check + P2002 race recovery; dual JSON/HTML response.
- `server/src/forms/guards/honeypot.interceptor.ts` — `HONEYPOT_FIELDS`, `IGNORED_SYSTEM_FIELDS`, `isDangerousKey`, `unwrapServerKey`, `sanitizePayload` (3 passes), `checkIsHoneypot`: canonical server normalizer.
- `server/src/forms/services/public-form-origin.service.ts` — Origin→ShopDomain resolution; Redis/memory cache (300s allow / 60s deny); permits auto-bootstrap when shop active.
- `server/src/forms/services/csv-export.service.ts` — `escapeCsvCell` (formula chars `= + - @ \t \r` → `'` prefix), BOM `\uFEFF`, cursor batch 250.
- `server/src/main.ts` — middleware order: public-form CORS/preflight → admin CORS → 32KB ingress parsers → webhook parser → global parsers; CSP `frame-ancestors *.myharavan.com *.haravan.com`; serves storefront JS/CSS at `/assets/` + `/storefront/assets/`.
- `storefront/assets/f1genz-multiform.js` — `resolveActionUrl` 6-tier endpoint resolution; `extractFormData` mirrors server sanitizer; `data-f1genz-bound` double-bind guard; MutationObserver re-scan; `f1genz:form:submit/success/error` CustomEvents; `F1GenzMultiformConfig` global; dual-sync.
- `server/src/haravan/script-tag-registration.service.ts` — `apis.haravan.com/web/script_tags.json` GET/POST; match by `src.includes('f1genz-multiform.js')`; records id in `AppInstall.metadata.scriptTag`.
- `server/src/haravan/webhook-topic-normalizer.ts` — 7 uninstall aliases + 5 shop/update aliases → 3 canonical topics.
- `server/prisma/schema.prisma` — `Form @@unique([shopId,formKey])`; `FormSubmission @@unique([formId,idempotencyKey])` (nullable ⇒ dedupe only when key sent).
- `client/src/components/crm/crm-payload-heuristics.ts` — `normalizeFieldKey`, EN+VI dictionaries, `humanizeFieldKey`, `extractLeadPreview`.
- `client/src/components/crm/safe-value-renderer.tsx` — XSS-safe render; mailto/tel/link detect; VN phone regex `^(\+?84|0)[1-9]\d{7,10}$`.
- `scripts/scan-anti-patterns.mjs` — 10 regex gates + 3 file-conditional gates (jwt.decode, Redis KEYS, localStorage tokens, non-atomic consume, random webhook idempotency, non-owner lock release, Liquid `| default:` ban, `.container` compound-class ban).
- `docs/architecture-contracts.md` — frozen V1 contract: module responsibilities, Redis namespaces, API shapes, security invariants.

## 4. Critical Edge Cases / Traps / Workarounds

1. **formKey auto-bootstrap is a silent form factory** — any POST to `/p/forms/{anything}/submissions` from a registered domain creates an active Form (name humanized from key). Typo in `data-f1genz-public-id` mints junk forms; no per-key allowlist beyond domain check.
2. **Origin check is advisory** — `isOriginAllowedForForm` only runs when an Origin header exists; curl/native posts without Origin skip it. Real gate is domain resolution inside controller (formKey path needs Origin/Referer; direct publicFormId path needs nothing).
3. **Nullable idempotencyKey unique index** — `@@unique([formId, idempotencyKey])` with `String?`: rows without key never dedupe; retries without header double-insert AND double-reserve quota (fallback usage key embeds Date.now+random).
4. **Dual-sync double-posts** — `data-f1genz-dual-sync="true"` (customer snippet) re-POSTs FormData to native action after F1GENZ success → Haravan creates its own record too. Stripping the attribute silently changes behavior.
5. **`public_form_id` hidden input leaks into payload** — JS accepts `input[name="public_form_id"]`/`data-f1genz-public-id` as endpoint source but neither strip-list covers it → stored in FormSubmission.payload.
6. **`| default:` ban vs customer snippet** — scanner rule `no-storefront-default-fallback` forbids `| default:` yet `f1genz-form-customer.liquid` uses ~20 of them. Live contract conflict (scan failing or file exempt).
7. **Hardcoded prod fallback** — `F1GenzMultiformConfig.apiBaseUrl || 'https://multiform.f1genz.dev'`: cloned/staging storefront silently posts to production.
8. **CORS preflight echoes any Origin** without validation; enforcement only on actual POST; preflight cached 24h (`Access-Control-Max-Age: 86400`).
9. **Honeypot returns HTTP 200 `status:'spam'`**, skips quota reservation — correct stealth design; spam still writes a row; no per-field size cap beyond 32KB request limit.
10. **Bracket unwrap is single-namespace only** — `customer[address][city]`→`address.city` works, but `foo[bar]` (namespace outside whitelist `contact|customer|properties|attributes|fields|account|order|form`) stays literal; `a[][b]` unhandled.
11. **Name synthesis is Vietnamese-first** (`last_name + first_name`) — wrong order for English-form conventions; accepted trade-off baked into BOTH client and server (must stay in sync).
12. **CSV formula defense gap** — `escapeCsvCell` checks `str[0]` but doesn't trim first; leading-space-then-`=` bypasses (mostly mitigated since ingress trims values).
13. **ScriptTag match is substring-based** — stale tag from old domain counts as "already_registered", never updated to new URL.
14. **Webhook topic aliases are load-bearing** — Haravan emits `app_uninstall_webhook`, `app_uninstalled`, `apps/uninstall` variants; the 7-alias normalizer is the difference between catching and missing uninstalls.
15. **Embedded CSP** — `frame-ancestors *.myharavan.com *.haravan.com`, deliberately NO `X-Frame-Options`. App URL must be `/install/login` — SPA router strips query on `/`→`/dashboard`, losing HMAC.
16. **Rate limit** — 20 req/60s per `formId:IP`; first `x-forwarded-for` entry trusted, requires `TRUST_PROXY=1` behind Cloudflare Tunnel.

## 5. Improvements for Super Core

**Platform semantics (haravan):**
- `haravan.form_field_namespaces`: `contact[...]`, `customer[...]` native conventions; `contact[body]`→message rename rule.
- `haravan.script_tags_api`: `apis.haravan.com/web/script_tags.json` GET/POST/DELETE, Bearer; `script_tag.id` may be missing on 2xx (assert it).
- `haravan.webhook_topic_variants`: ≥7 uninstall spellings, ≥5 shop/update — normalize before switching.
- `haravan.embedded_csp`: `frame-ancestors *.myharavan.com *.haravan.com`, never `X-Frame-Options: SAMEORIGIN`.
- `haravan.app_url_query_preservation`: launch URL must preserve query params (HMAC) — `/install/login`, not SPA root.

**Anti-pattern candidates:**
- `auto-bootstrap-on-ingress`: DB rows created for unregistered public keys from header-derived tenant → quota exhaustion + junk forms. Fix: pre-register keys or `X-Form-Token`.
- `nullable-idempotency-unique`: unique on nullable column gives false confidence. Fix: default `''` or generated key.
- `substring-script-tag-match`: `src.includes()` treats foreign-domain tags as satisfied. Fix: exact match + update on drift.
- `liquid-default-filter-in-distributable-snippets`: hardcoded `| default:` fights merchant settings — repo's own scanner bans it while a snippet violates it.
- `hidden-marker-input-leak`: endpoint-resolution inputs must be in strip-list on BOTH client and server or they pollute stored payloads.

**Fix patterns:**
- `p2002-idempotent-retry`: catch unique-violation → re-fetch → return `duplicate:true`.
- `honeypot-200-stealth`: classify spam server-side, respond 200, skip quota, keep row.
- `csv-formula-escape`: prefix `= + - @ \t \r` with `'`, BOM `\uFEFF`, cursor-batch streaming.
- `dual-layer-normalization`: identical sanitize logic in storefront JS + server interceptor — drift is the risk; extract shared spec/test vectors.

**Workarounds:**
- `trust-proxy-behind-cloudflare-tunnel`: `TRUST_PROXY=1` + first x-forwarded-for entry.
- `supabase-pgbouncer`: DATABASE_URL pooler:6543 `pgbouncer=true`; DIRECT_URL pooler:5432 for migrations.

## 6. Improvements for Haravan Theme Core Output

1. **Snippet contract template**: 6 presets show canonical embeddable-app Liquid — `{{ var | escape }}` on every interpolation, BEM `f1genz-form__*` classes, honeypot input `tabindex="-1" autocomplete="off" aria-hidden="true" hidden`, `data-*` JS hooks (`data-f1genz-form`, `data-f1genz-submit`, `data-f1genz-success/error`). ThemeCompiler should emit this shape for form-capable sections.
2. **Settings→CSS-var bridge**: README §5 maps 16 `settings.f1genz_color_*` into `:root{--f1genz-form-*}` — precedent for "settings contract generates CSS custom properties in theme.liquid". HaravanSchemaGenerator should support this idiom natively.
3. **Resolve `| default:` contradiction**: allow `| default:` ONLY for i18n label/placeholder text, forbid for endpoints/IDs — encode as linter rule with setting-type allowlist.
4. **`.container` standalone-class invariant**: never concatenate `container` with other classes in emitted markup.
5. **DOM sanitizer must preserve**: `data-f1genz-*` attributes, hidden honeypot inputs (`_gotcha`), `form[action]` containing `/api/v1/p/forms/`, `input[name="f1genz_form_id"]` markers — stripping any silently breaks submission routing. Add as "app-integration attributes" allowlist.
6. **ScriptTag vs snippet duality**: app injects JS via ScriptTag API AND ships manual snippets; theme output must not double-load `f1genz-multiform.js` (check `src.includes` before emitting `asset_url | script_tag`).

## 7. Improvements for AntiFan Core & Site Clone

**AntiFan Core:**
1. **Form-interception awareness**: interceptor binds via submit listener + `data-f1genz-bound` guard + MutationObserver. SnapDOM/exported DOM contains `data-f1genz-bound="true"` — runtime mutation artifact the DOM sanitizer should strip (re-binds on load anyway).
2. **Verification claims**: ready-made claim types — "form posts reach /api/v1/p/forms/*/submissions", "honeypot input present and empty", "success alert unhidden after submit". Model storefront form wiring as first-class claims.
3. **Livewire/SSR sanitization parallel**: `sanitizePayload`'s system-field strip list (`utf8`, `authenticity_token`, `form_type`, `g-recaptcha-*`) is the same class of framework cruft AntiFan's sanitizer removes — reuse as shared constant.
4. **CDP telemetry**: dual-sync fires a second background fetch to native action — network telemetry must expect 2 POSTs per submit or flag phantom requests.
5. **Origin-policy testing pitfall**: allow/deny cached 300s/60s — tests flipping domains must bust cache or wait.

**Site Clone:**
1. **Component IR for app-forms**: clone is "done" only with full contract — endpoint source (one of: `data-f1genz-endpoint`, action containing `/api/v1/p/forms/`, `data-f1genz-public-id`, hidden `f1genz_form_id` input, config route map, `data-f1genz-form="contact|customer"`), honeypot input, submit/success/error hooks. Model as `FormComponent` IR node with required-prop DoD validation.
2. **External-script dependency**: `f1genz-multiform.js` served from app domain (`/assets/`, 1h cache, CORS `*`). Offline standalone must inline it (dependency-free vanilla, safe) or rewrite ScriptTag src — asset-pipeline decision point; cloning without it yields dead forms.
3. **API-base override**: capture `window.F1GenzMultiformConfig` as config node so clones retarget/neutralize endpoint (offline → stub success or local capture); beware hardcoded prod fallback.
4. **CSS tokens**: `--f1genz-form-*` vars come from theme settings, not the stylesheet — clone must emit the `:root` block or forms render unstyled. DoD check: all vars referenced by f1genz-multiform.css are defined.
5. **CustomEvent surface**: `f1genz:form:submit|success|error` + `window.F1GenzMultiform.{init,extractData,version}` is the public JS API — preserve in clone or document as intentionally dropped.
