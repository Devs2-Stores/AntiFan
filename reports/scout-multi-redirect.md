# --ultra Scout Report: Multi Redirect (E:\Work\apps\Multi Redirect)

## 1. Project & Directory

`E:\Work\apps\Multi Redirect` is a **registered-but-empty app shell**. Total contents (verified by full recursive glob incl. hidden/gitignore-off):

- `.workspace-context.json` (145B): `{kind: "app", platform: "haravan", branch: "f1genz", verification: "needsVerification", reason: "empty-or-missing-source"}`
- `.antigravity/mcp-bridge/cmd-1787146796482-3535.res.json`: `{"ok":true,"submitted":true}` — a bridge command receipt only.

**There is zero source code, zero docs, zero package.json.** Per `apps/CLAUDE.md` rule 4, `needsVerification` means "HỎI, không đoán" — but for a read-only scout the honest verdict is: the app was scaffolded/registered ~1mo ago and never implemented. No sibling app implements redirects either (`redirects.json` grep across Multipage/Multiform/app-base/Orders/Notify Everything = 0 hits). Super Core has zero redirect claims/anti-patterns/workarounds (SQL queries on `.super-core/core.db` returned no rows).

## 2. Architecture & Role [INFERENCE — grounded in workspace conventions]

"Multi Redirect" = a Haravan app for **bulk URL redirect management** (the Redirect resource is the only Haravan primitive matching the name). Expected shape per `apps/CLAUDE.md` runtime table + `haravan-app-base` (verified `role: "base"`):

- `server/` NestJS (`nestjs-api`) — OAuth login→install, webhook HMAC, Prisma/Postgres, Redis
- `client/` React SPA (`react-spa`) — redirect CRUD UI, likely CSV import/export (Multiform already ships `csv-export.service.ts` with formula-injection escaping + BOM + cursor pagination — the reuse pattern)
- Domain module: `redirects/` proxying Haraweb `/web/redirects.json` behind `ShopAuthGuard` (pattern: `F1GENZ Multipage/server/src/resource/resource.controller.ts` — thin guard+token pass-through)

## 3. Load-bearing Files & Inspected Contracts

**Haravan Redirect API** (verified against docs.haravan.com/docs/omni-apis/redirects/):
- `GET /web/redirects.json` (list), `GET /web/redirects/count.json`, `GET /web/redirects/{id}.json`, `POST /web/redirects.json`, `PUT /web/redirects/{id}.json`, `DELETE /web/redirects/{id}.json`
- Resource shape: `{id, path, target}` — `path` = source path, **unique per shop**; `target` = relative path OR absolute external URL
- Scope: `web.read_contents`/`web.write_contents` (`apps/.claude/skills/haravan-app/references/platform-facts.md:37` lists Redirect under Contents). **Doc ambiguity:** the docs page text says `com.write_contents` while the endpoint lives under `/web/` — flag for sandbox verification before implementation.
- **No bulk endpoint, no status-code field (301/302 not selectable), no wildcard/regex matching** — every rule is one API call.

**Workspace contracts the app must inherit:**
- `haravan-app-base/server/src/haravan/oauth-state.service.ts` — `isSafeRedirect()`: exactly one leading `/`, no `//`, no backslashes/control chars raw-or-decoded, no `/install*|/oauth*|/api/oauth*` targets even after dot-segment normalization; invalid → `/dashboard`
- `haravan-app-base/server/src/haravan/haravan-api.service.ts` — token exchange/refresh/shop/webhook-subscribe via fetch; `webhook.service.ts` — HMAC via `X-Haravan-Hmacsha256` = base64 HMAC-SHA256(raw body, **Client Secret**) (BUG-APP-001 in `apps/bugs/registry.md`: never `HRV_WEBHOOK_SECRET`), orgid/domain identity resolution, idempotency keys
- `platform-facts.md:119-122` — webhook must return 200 within 5s; **any 3xx = failure, Haravan does not follow redirects**; 19 retries/48h then auto-delete
- Rate limits: bucket 80, leak 4 rps, `X-Haravan-Api-Call-Limit`, `Retry-After` (platform-facts.md §Rate Limits)

## 4. Critical Edge Cases / Traps / Workarounds

1. **No bulk API** → a "multi" import of N redirects = N sequential POSTs at 4 rps. Needs queue + `Retry-After` backoff + per-row idempotency; a 500-row CSV ≈ 2min minimum.
2. **Path uniqueness per shop** → import must upsert: GET list → match `path` → PUT `{id}` instead of blind POST (else 422/duplicate errors).
3. **No redirect-chain protection** → app must self-detect `A→B` where `B` is also a redirect `path` (loop/chain lint), Haravan won't.
4. **Path normalization traps**: trailing slashes, percent-encoding, Unicode (Vietnamese slugs), query strings in `path` — must normalize before dedupe or duplicates slip through.
5. **CSV formula injection** on export — reuse Multiform `escapeCsvCell` (`=`,`+`,`-`,`@`,tab,CR prefix-quoting) verbatim; do not reinvent.
6. **Webhook endpoint can never 3xx** — a redirect app must not put its webhook receiver behind any redirecting proxy/ingress.
7. **Uninstall leaves redirects live on the shop** — they're store data, not app data; document/decide cleanup policy (delete-on-uninstall is destructive; default should be leave + report).
8. **`target` accepts external URLs** → open-redirect abuse vector if the app ever exposes a public/unauthenticated write path; keep all writes behind `ShopAuthGuard` + origin checks (app-base lifecycle.md §Session Handoff rules 5-6).
9. **Scope ambiguity** (`web.` vs `com.write_contents` in docs) → verify on sandbox before locking env/scope contract.

## 5. Concrete Improvements for Super Core

Record as new entries (all currently absent — verified by SQL):

- **platform_semantics (haravan)**: "Redirect resource = `{id, path, target}` at `/web/redirects.json`; path unique per shop; no bulk endpoint; no status-code/wildcard support; target may be external absolute URL."
- **anti_patterns**: (a) "Blind POST per CSV row without list-then-upsert → duplicate-path failures"; (b) "Following redirects on Haravan webhook endpoint — any 3xx = delivery failure, 19 strikes = auto-delete"; (c) "CSV export without formula-trigger escaping"; (d) "Assuming Shopify-style `redirects` bulk/import endpoints exist on Haravan."
- **workarounds**: "Bulk redirect import = chunked sequential POST at ≤4 rps with Retry-After honor + idempotent path-upsert (GET→match→PUT)."
- **fix_patterns**: BUG-APP-001 already covers HMAC secret; add "empty registered app shell (`empty-or-missing-source`) must be reported as unimplemented, not scouted as if code exists."
- **hidden_requirements**: "Redirect apps need chain/loop detection and uninstall-data policy — platform provides neither."

## 6. Concrete Improvements for Haravan Theme Core Output

- **ThemeCompiler emits a Redirect Plan artifact.** `route-resolver.ts` `normalizePathname` (line ~390) strips `.html`/`.htm` suffixes and collapses slashes — every stripped/renamed source path is a **silent 404 on the target store** unless a Redirect row is created. The compiler should emit `redirects.json` (path→canonical target pairs) alongside theme files so an app like Multi Redirect (or a CLI step) can apply them.
- **Settings contract**: a `redirects` manifest belongs in `ThemeBundleIR`/`page-manifest.json` (currently only surfaces/assets/settings/fixtures — `page-manifest.ts:44-58`), not in `settings_schema.json`.
- **DOM sanitizer**: navigation `<a href>` values are deliberately not rewritten (`asset-localizer.ts:~2210` — correct), but the compiler should record *internal* hrefs that resolve to non-canonical source paths so the redirect plan covers in-content links, not just routes.

## 7. Concrete Improvements for AntiFan Core & Site Clone

**Site Clone:**
- `ComponentContractIR` (`clone-ir.ts`) has **no `redirects` field** — add `redirects?: Array<{path, target, reason: 'renamed-route'|'html-suffix'|'alias'|'manual'}>` and extend `clone-ir.schema.json`.
- `RouteResolver.mapToHaravanRoute` `custom` fallback (route-resolver.ts:~310) maps unknown paths to `page.liquid` — those source paths need redirect rows, not just template mapping.
- `EntityType` (`entity-resolver.ts:21`) = `'product'|'collection'|'article'|'page'` — add `'redirect'` so redirect creation participates in fixture/cleanup tracking like other entities.
- `HaravanApiTransport` (`haravan-adapter.ts:~50`) lacks `getRedirects/createRedirect/deleteRedirect` — add to the transport contract so clone pipelines can apply + canary-delete redirect fixtures.
- `dod-validator.ts` `routeVerification` (§63.18, line ~1580) only checks route *mapping* — add a criterion (or extend it) requiring `unmappedRoutes→redirects` coverage: every source URL that doesn't map canonically must have a redirect row or an explicit waiver.

**AntiFan Core (browser/verification):**
- Add a **redirect-aware navigation probe**: `browser.navigate` + CDP should record the redirect chain (301/302 hops, final URL) so verification claims can assert "legacy path X → 301 → canonical Y" on the live store.
- `anti.verification.*` claim types should include `REDIRECT_APPLIED` with proof = observed 3xx + Location header, not just DOM state.
- `theme_debug_bundle`/QA workflow: flag storefront links that 404 — each is a redirect-plan candidate feeding back into Site Clone's `redirects` IR.

**Bottom line:** Multi Redirect has no code to scout — the deliverable is the contract map above. The highest-value cross-project insight: Site Clone currently produces zero redirect output, so every cloned/migrated store silently loses its legacy URL equity; the Redirect API contract (`{path,target}`, unique-path, no-bulk, 4rps) is small, verified, and ready to encode into Super Core + the clone IR today.
