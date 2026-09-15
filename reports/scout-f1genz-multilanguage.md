# SCOUT REPORT — F1GENZ MultiLanguage (E:\Work\apps\F1GENZ MultiLanguage)

== 1. PROJECT & DIRECTORY ==
Haravan multi-language app: NestJS server + React admin + a live Haravan theme mutated in place.
- Haravan-Server--Multilanguage/ — NestJS + Prisma(Postgres) + BullMQ/Redis + @google/genai. PM2 runs TWO processes (ecosystem.config.cjs): `haravan-multilanguage` (dist/main.js, HTTP) and `haravan-multilanguage-worker` (dist/worker.js, BullMQ consumer).
- Haravan-Client--Multilanguage/ — Vite 6 + React 19 + antd 5 + TanStack Query 5 + Tailwind 4 admin SPA; public/ ships 3 storefront scripts (currency-converter.js, variant-translator.js, third-party-google-translate.js).
- storefront/ — real Haravan theme: layout/theme.liquid, ~370 snippets, ~90 templates, per-locale clones (*.en.liquid, en_*.liquid, theme_en.liquid). theme.css.liquid alone is 406KB.
- prisma/schema.prisma — Shop, ShopConfig, Resource, ResourceField, TranslationJob, TranslationJobItem, TranslationValue, TranslationMemory, GlossaryTerm, UsageLog, ShopQuotaLedger, WebhookEvent.

== 2. ARCHITECTURE & ROLE ==
Two-plane design:
(A) DATA plane — translates catalog content (products/collections/pages fields incl. HTML description, product tabs tabone..tabfive, variant_translations JSON) via Gemini (`gemini-3.5-flash-lite`), stores in TranslationValue, then PUBLISHES to Haravan as metafields in namespace `hrvmultilang_{lang}` (buildTargetNamespace, translation-job.service.ts:1164). Shop-level config metafields: languages, default_language, product_fields, collection_fields, currency_settings, variant_dictionary_{lang}.
(B) THEME plane — storefront-theme.service.ts (4225 lines) clones the ENTIRE theme per language: layout `theme_{prefix}.liquid`, snippets `{prefix}_*`, templates `*.{prefix}.liquid`; injects a `{% case lang %}` router into layout/theme.liquid; language state carried in `cart.attributes['x-haravan-lang']` (thelang.liquid). Injected system snippets: thelang (lang resolve), dangonngu (switcher, cart attribute writer), headen (header include), laco (flag assets + snippet).
Job pipeline: createJob → BullMQ translate queue → runJob (per-shop lock) → memory prefetch → variant items go LOCAL (dictionary, no LLM) → dedupe groups → chunks (24 items / 14k chars) → save → auto-enqueue publish queue → publishJob writes metafields (concurrency 2) → completed/completed_with_errors.
Webhooks: WebhookEvent dedupe @@unique(topic, orgid, resourceId, payloadHash); status machine received→processing→processed/failed/ignored; haravan.cron retries failed with DB-paused circuit breaker; delete topics → catalogMirror.markCatalogResourceDeleted.

== 3. LOAD-BEARING FILES & CONTRACTS ==
- src/translate/translation-job.service.ts (6603 lines) — job lifecycle, TM, publish, status SQL. Key contracts:
  • TranslationMemory lookup key = targetLanguage:fieldType:sourceHash:glossaryHash — glossary edits invalidate memory (correct, deliberate).
  • Dedupe: getTranslationItemDedupeKey groups identical source items; translate once, fan out to group.
  • Status machine per field: source_empty/missing/empty/failed/translated → resource status not_required/missing/partial/failed/translated; multi-language combined status (any failed→failed; all translated→translated; etc.).
  • getResourceTranslationStatusesFast: raw SQL CTE (latest_items DISTINCT ON, primary_status CASE, CROSS JOIN languages) with fallback to Prisma path.
  • Publish: createMetafields vs updateMetafields decided by TranslationValue.metafieldId; empty value → marked published WITHOUT metafield write; fatal auth error → all remaining items failed TOKEN_INVALID + markPublishTokenInvalid.
  • runWithShopLock('translate'|'publish', orgid) serializes jobs per shop.
- src/translate/storefront-theme.service.ts (4225 lines) — theme cloning. Contracts: prefixAssetKey, isSourceTemplateAsset vs isCustomerTemplateAsset (templates ending `.{prefix}.liquid` are clones), SYSTEM_SNIPPET_NAMES + LANGUAGE_SHARED_SNIPPET_NAMES never cloned, ensure* methods are idempotent (needsX guards), per-key rate-limit queue with 429 cooldown (STOREFRONT_THEME_HARAVAN_INTERVAL_MS), plan 'default'|'hand' gates automation depth. LANGUAGE_CURRENCY_BY_CODE maps 13 locales→currencies; LANGUAGE_DICTIONARY carries flag-asset search terms.
- src/translate/translate.service.ts — Gemini calls, Redis translation cache `haravan:multilanguage:translation_cache:` TTL 2h, quota ledger (quota_remaining).
- src/haravan/haravan.api.ts (1163 lines) — axios + withHaravanRetry; theme assets PUT /web/themes/{id}/assets.json {asset:{key,value}}, DELETE with `asset[key]` query param; metafields endpoint SWITCHES by type: shop→/com/metafields.json?owner_resource=shop, page→/web/pages/{id}/metafields.json, product/collection→/com/metafields.json?owner_id=; collections merge custom+smart with collection_type discriminator; pages use /web/pages.json (Haraweb scope web.read_contents).
- src/haravan/haravan.service.ts (3356 lines) — webhook snapshot sync, orgid resolution fallback chain (x-haravan-org-id → x-haravan-orgid → query.orgid → payload.org_id/orgid/organization_id/shop_id → shopPayload), retryFailedWebhookEvents.
- storefront/layout/theme.liquid + snippets/{thelang,dangonngu,theme_en}.liquid — the live router/switcher contract.
- Client: common/AdminConfigService.js (useAdminConfig, saveAdminConfig PUT /api/translation/config, hasBrokenLabelEncoding mojibake detector), common/DataServices.js, config/RouterConfig.jsx (StorefrontThemeGate dev-access), public/third-party-google-translate.js (748-line storefront fallback for dynamic app text).
- Tests exist and are substantial: haravan.service.spec.ts 58.7KB, storefront-theme.service.spec.ts 45.4KB, translation-job.service.spec.ts 26.4KB.

== 4. CRITICAL EDGE CASES / TRAPS / WORKAROUNDS ==
1. DEAD ROUTER BRANCH (live bug): theme.liquid contains `{% case lang %}{% when 'fsfsfs' %}{% include 'theme_en' %}{% else %}<VI master>{% endcase %}`. 'fsfsfs' is a keyboard-mash placeholder — the EN layout clone exists but is UNREACHABLE; every non-match falls to Vietnamese. Either a failed prefix substitution in ensureThemeLayoutRouter or an intentional-but-fragile disable. No validation asserts each configured language has a matching `{% when %}`.
2. Language state = cart attribute: switching language POSTs /cart.js attributes → mutates the shopper's cart, requires cart endpoint, and won't work in offline/static contexts. thelang.liquid defaults to 'vi' when attribute empty.
3. O(N×theme) duplication: every snippet/template cloned per language; any upstream theme change must re-run the whole clone+translate+router pipeline; nested `{% include %}` rewriting is regex-based (findHtmlOpeningTag, extractThemeLayoutMasterBody) — brittle against unusual Liquid formatting.
4. Variant translation is LOCAL, not LLM: HARAVAN_VARIANT_OPTION_ALIAS_GROUPS + NFD diacritic-strip normalization maps option names (Color/Colour/Màu sắc/Mau sac…) via alias dictionary; stored as JSON field variant_translations; synced to shop metafield variant_dictionary_{lang} consumed by variant-translator.js. Deterministic, free — but only covers known aliases.
5. Mojibake defense: AdminConfigService.hasBrokenLabelEncoding detects U+FFFD, Ã/â€ sequences, strict '?' — evidence of real UTF-8 corruption in Vietnamese labels flowing through config save.
6. Metafield publish edge: empty translated value short-circuits to status=published with metafieldId=null (no remote write) — a "published" status that means "intentionally blank", easy to misread in health UI.
7. Stuck-job sweeper deletes queued/running jobs >10min old ONLY when no BullMQ in-flight entry AND no recently-updated items — safe vs worker-down (queue entry persists → skipped) but will delete jobs whose queue entry was lost (Redis flush) rather than recover them.
8. Cancel is cooperative: isJobCanceled checked between every await/chunk — long chunks still finish before cancel lands.
9. Webhook orgid resolution has ~8 fallback paths — header/query/payload/shopPayload; any new webhook topic must be mapped in resolveWebhookResourceType or it's 'ignored' silently.
10. third-party-google-translate.js exists because server-side translation CANNOT reach JS-rendered app content (hrv-pmo, dlpm widgets, modals) — client-side Google Translate widget with TARGET_ATTR/LOCK_ATTR/notranslate markers is the acknowledged gap-filler.
11. TM glossary coupling: adding one glossary term flushes ALL memory hits for that language (hash changes) — correct but a cost spike after glossary edits.

== 5. IMPROVEMENTS FOR SUPER CORE ==
Record as platform semantics (Haravan):
- No native storefront i18n → the de-facto architecture is metafield-namespaced translations (hrvmultilang_{lang}) + cart-attribute locale + per-locale template clones. Any "translate a Haravan store" task should recommend this triad or explicitly refuse.
- Metafields API is endpoint-fragmented: shop=owner_resource=shop, page=/web/pages/{id}/metafields.json, product/collection=owner_id. Create-vs-update requires persisting metafieldId locally.
- Theme asset write = PUT assets.json {asset:{key,value}}; delete = DELETE with `asset[key]` QUERY param (not body) — easy to get wrong.
- include (not render) is the live Liquid composition tag on Haravan; `{% include %}` rewriting must recurse.
Anti-patterns to record:
- Placeholder `{% when %}` branches: router generators MUST validate every configured language resolves to a real branch + existing include asset. ('fsfsfs' is the canonical failure.)
- Per-locale full-theme duplication without a managed-block/idempotent-ensure layer → drift on every upstream theme edit.
- Using cart.attributes as locale storage couples language to cart mutations; document as workaround-with-cost, not a clean pattern.
Fix patterns:
- TM keyed by (lang, fieldType, sourceHash, glossaryHash) — glossary-aware cache invalidation.
- Webhook dedupe via unique(topic, orgid, resourceId, payloadHash) + status machine + cron retry with DB circuit breaker.
- Variant option translation via NFD-normalized alias dictionary BEFORE falling back to LLM — deterministic & free.
- Cooperative cancel: isJobCanceled check at every await boundary + terminal-status guards before delete (deleteJob refuses while in-flight).
- Fatal-error propagation: one auth failure during publish marks all remaining items failed with a single user-facing message instead of N raw errors.
Workarounds:
- hasBrokenLabelEncoding-style mojibake detection on any user-supplied Vietnamese label round-tripping through JSON config.
- Client-side translate widget scoped by app-marker selectors for JS-rendered third-party content the server can't reach.

== 6. IMPROVEMENTS FOR HARAVAN THEME CORE OUTPUT ==
For ThemeCompiler / HaravanSchemaGenerator / settings contract / DOM sanitizer:
- Router injection contract: `{% case lang %}` wrapping the layout body, one `{% when '{prefix}' %}{% include 'theme_{prefix}' %}` per language, `{% else %}` = default master. Compiler MUST post-validate: every language→branch→asset exists (would have caught 'fsfsfs').
- Clone naming contract: templates `*.{prefix}.liquid`, snippets `{prefix}_*`, layout `theme_{prefix}.liquid`; SYSTEM_SNIPPET_NAMES + LANGUAGE_SHARED_SNIPPET_NAMES are never cloned; isCustomerTemplateAsset vs isSourceTemplateAsset decides clone eligibility.
- Managed-block idempotency: every injected snippet/include has a needsX guard (needsThemeLayoutRouter checks for existing `{% case lang %}`) — ThemeCompiler should adopt ensure-not-overwrite semantics so re-runs are safe.
- Settings contract: shop metafields languages/default_language/product_fields/collection_fields/currency_settings/variant_dictionary_{lang} are the runtime config surface; settings.html + settings_data.json get per-language value translation via applySettingsHtml/applySettingsData — schema generator must treat setting VALUES as translatable fields, not just labels.
- Hardcoded-text translation inside Liquid (translateLiquidHardcodedText) is a distinct field type — needs HTML-aware extraction so tags/attrs aren't translated.
- DOM sanitizer: exported clean HTML of a translated theme carries injected artifacts (dangonngu switcher, thelang div, case-lang wrapper, f1genz-google-translate widget DOM, data-f1genz-google-translate-* attrs) — sanitizer needs a rule set to strip or preserve them deliberately.
- Rate-limit awareness: theme asset writes go through a per-key interval queue with 429 cooldown — bulk compilers must throttle identically or they'll trip Haravan limits.

== 7. IMPROVEMENTS FOR ANTIFAN CORE & SITE CLONE ==
AntiFan Core:
- Verification claims: 'fsfsfs' is exactly the bug class anti.verification should catch — a claim like "language X renders its own layout" must be proven by ACTUALLY switching (POST /cart.js attribute + reload) and inspecting rendered output, never by reading theme source. Add a claim template: locale-router reachability.
- anti.theme.export_clean / dump_dom: add awareness that Haravan pages may render under a non-default cart-attribute locale — capture should record the active `x-haravan-lang` and optionally enumerate locales; otherwise snapshots silently capture only 'vi'.
- SnapDOM/CDP telemetry: a language switch is cart-POST → full reload; interaction tracing must treat it as a navigation, not an in-place DOM mutation.
- theme.resolve_element: elements inside `{% when %}` branches map to cloned assets ({prefix}_*.liquid), not the master — resolver should map rendered DOM → the ACTIVE locale's asset.
Site Clone:
- IR model: multi-locale sites need per-locale IR — same URL, different content keyed by cart attribute. The IR must record locale dimension + the metafield namespace bindings (hrvmultilang_{lang}) so clones can rebind or strip.
- Asset pipeline: `*.{prefix}.liquid` and `{prefix}_*` are derived artifacts — DoD validator should either exclude them from parity diff or verify regeneration, never hand-compare clones to source.
- Offline standalone mode: cart-attribute switching requires /cart.js — standalone clones need a client-side switcher fallback or per-locale static HTML output; document this as a hard constraint.
- Component contract IR: record which strings came from metafields vs hardcoded Liquid vs settings — the three translation channels have different rebind strategies.

Key files for follow-up: src/translate/storefront-theme.service.ts (router/clone engine), src/translate/translation-job.service.ts (job+publish), src/haravan/haravan.api.ts (platform API quirks), storefront/layout/theme.liquid + snippets/{thelang,dangonngu,theme_en}.liquid (live contract), Haravan-Client--Multilanguage/public/third-party-google-translate.js (untranslatable-content fallback).
