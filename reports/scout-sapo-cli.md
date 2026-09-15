# Ultra Scout — Sapo CLI (E:\Work\apps\Sapo CLI)

## 1. Project & Directory
`@f1genz/sapo-cli` v1.0.0, bin `sapo`, Node >=18.18.0 (claimed), TypeScript ESM, Commander 11, Vitest (37 tests, all passing per reports/test-report-260907-sapo-cli.md). ~35 source files under src/{commands,helper,core,services,config,types}. Explicitly documented as inheriting Haravan CLI (`hrv`, v1.2.0) safety patterns, re-specialized for Sapo Web/Bizweb.

## 2. Architecture & Role
Theme-ops CLI only — no webhooks, no app backend. 4-layer ESM: index.ts (Commander + SapoCliError boundary) → commands/ (thin handlers, theme/index.ts switch-dispatcher) → helper/ (auth, sapo_api, files, remote-state, dialect linter, watcher, keychain, dotfile/conf singletons) → core/+config/ (ProjectContext canonical root, ServiceResult, frozen app-config). Integrations: Sapo Admin REST (`https://{store}.mysapo.net/admin`, header `X-Sapo-Access-Token`), OAuth authorize/token endpoints on same host, asset `public_url` CDN downloads. Commands: login/logout/select/whoiam/info/open, theme {list,info,fetch|pull,push,dev|watch,publish,rename,delete|remove,export,check|lint}, doctor, diff, backup, restore + top-level dev/fetch/pull/push/theme-check shortcuts.

## 3. Sapo CLI vs Haravan CLI — grounded differences
|Axis|Haravan CLI (hrv 1.2.0)|Sapo CLI (sapo 1.0.0)|
|---|---|---|
|Auth|OIDC PKCE via accounts.haravan.com (openid-client), refresh_token, org_id, offline_access|Private App Token OR Partner OAuth 2.0 code exchange WITHOUT PKCE; scope only read_themes/write_themes|
|API host|Central `apis.haravan.com`, `Authorization: Bearer` + `User-Agent: onapp_haravan-cli`|Per-store `{prefix}.mysapo.net/admin`, `X-Sapo-Access-Token`|
|Rate limit|(same retry table)|Dual header `x-sapo-shop-api-call-limit` / `x-bizweb-shop-api-call-limit`, bucket 40/leak 2rps, reactive sleep 85%/95%|
|Templates|`.liquid`|`.bwt` + `.liquid`; server-rendered set adds `.css.bwt/.scss.bwt/.js.bwt`|
|Dirs|Shopify-standard singular|+ plural aliases `layouts/`→`layout/`, `configs/`→`config/` remote keys|
|Lint|theme-check on settings.html|Dialect linter: `|slice` BAN, line_item.product.url, /postcontact|
|Push to LIVE|Preflight refuses role "main"|Warn + confirm prompt, proceeds on 'y'|
|Remote delete on push|Deletes remote files missing locally unless --nodelete|NEVER deletes on push; --nodelete is a dead flag; deletes only via watcher unlink / theme delete|
|Token store|dotfile ~/.haravan-cli.json|keytar→file fallback ~/.sapo-cli.json (keytar absent from deps → always file)|
|Extras|refresh-all, theme-console, theme-language-server, check_version, sharp|doctor (dialect+images+BOM+SEO), dev-lock, write-probe preflight, conflict poll|

## 4. Load-bearing Files & Contracts
- `src/helper/remote-state.ts` — optimistic lock: sha256Hex + CRLF→LF normalization, `.sapo-cli_remote.json` baseline, checkRemoteUnchanged (ok/conflict/new/skipped), auto-backup to `.sapo-cli_backup/<stamp>/`, pruneBackups(50). FAIL-OPEN: fetchRemoteAssetValue swallows all errors → null → 'new'.
- `src/helper/files.ts` — pushThemeFile/deleteThemeFile/processingPullThemes/pushAllThemeFiles; resolvePathWithinRoot traversal+symlink guard; 3MB push cap; binary base64+'\n' attachment with 3x verify-GET retry (normalizeBase64 strips whitespace); baseline set from PUT echo or re-GET. --nodelete accepted but never used; prune backups read binaries as utf8 (corrupts them).
- `src/helper/sapo_api.ts` — base `https://{prefix}.mysapo.net/admin`, `X-Sapo-Access-Token`, smartSapoRateLimit reactive sleep ≥85% (600ms)/≥95% (1500ms) on dual call-limit headers; env→context→dotfile→keychain token chain; returns null on any non-2xx.
- `src/helper/fetch_sapo.ts` — `dns.setDefaultResultOrder('ipv4first')` workaround; AbortController timeout→ECONNABORTED; retry decrementer honoring Retry-After (+0.5s) for 429; ECONNABORTED retried only for GET/PUT (idempotent-only).
- `src/helper/sapo-asset-patterns.ts` — extension whitelists, binary set, isLiquidRenderedAsset skip list (.css.bwt/.scss.bwt/.js.bwt/.css.liquid/.scss.liquid/.js.liquid), toPosixThemeKey plural→singular mapping, isSyncableThemeKey theme-folder gate.
- `src/helper/sapo-liquid-dialect.ts` — regex linter: ERROR sapo/no-slice-filter, WARN sapo/cart-item-product-url, WARN sapo/contact-form-action; scans only layout/snippets/templates/sections — misses assets/*.bwt.
- `src/helper/theme-dev-watcher.ts` — chokidar (awaitWriteFinish 100ms), serial promise push queue, force:true pushes (lock bypassed), BulkDeleteQueue ≥3 unlinks/3s → confirm; bulkDeleteConfirmed sticky whole session.
- `src/commands/theme/helpers.ts` — pickThemeInteractive, hasLocalThemeFiles, runDevPreflight (shop→theme→write-probe PUT), pollRemoteConflicts (top-level only, no toPosixThemeKey, cap 30, 8s abort), resolveRemoteConflicts, acquireDevLock/releaseDevLock PID lockfile.
- `src/commands/theme/theme-dev.ts` — dev lock → theme pick → auto-fetch if empty → preflight → conflict poll → preview `https://{domain}/?themeid={id}` → watcher → SIGINT cleanup + optional --backup zip + session summary.
- `src/commands/theme/theme-push.ts` — numeric arg=themeId else file; LIVE theme (role=main) → confirm prompt unless --force (weaker than hrv which refuses).
- `src/helper/auth.ts` — authorizeWithToken (validate /admin/shop.json, fallback /admin/themes.json for theme-scoped tokens) + authorizeWithOAuth (localhost:3300 /install/callback, state check, code+client_secret exchange — NO PKCE).
- `src/helper/keychain.ts` — keytar dynamic import (NOT in package.json → always falls back) → plaintext JSON ~/.sapo-cli.json chmod 600, per-store_prefix records.
- `src/helper/constants.ts` — THEME_FOLDERS (incl. plural layouts/configs + templates/customers), file names (.sapo-cli_remote.json, .sapo-sync-state.json [never written], .sapo-cli_local.json, .sapo-cli.json, .sapoignore [never read]), DEFAULT_SAPO_IGNORE_PATTERNS.
- `src/services/safe-ops-service.ts` — doctor (dialect + >1MB images + UTF-8 BOM + SEO title/canonical), diff (local vs baseline — binaries always 'added'), backup/restore via adm-zip extractAllTo overwrite.
- `src/core/project-context.ts` — absolute-root validation, realpathSync.native canonicalRoot, env-overridable paths (SAPO_CLI_AUTH_PATH/PROJECT_PATH/IGNORE_PATH); NO upward root discovery — commands must run at theme root.
- `src/helper/command-registry.ts` — CommandRegistry singleton; all commands + top-level shortcuts.
- `src/config/config.json` — retry table (429×20/2s, 500×5/3s, ECONNABORTED×3/2s), OAuth client_id+client_secret COMMITTED, scope read_themes+write_themes, callback localhost:3300/install/callback, leaky_bucket 40cap/2rps (declared, unused proactively).
- API contracts: `GET/PUT/DELETE /admin/themes/{id}/assets.json[?asset[key]=…]`; text=`asset.value`, binary=`asset.attachment` (base64+trailing `\n` quirk), download via `asset.public_url`. Theme role `main`=LIVE; publish=PUT `{theme:{id,role:"main"}}`. Preview param `?themeid=` (no underscore).
- State files: `.sapo-cli_local.json` (project link), `~/.sapo-cli.json` (tokens), `.sapo-cli_remote.json` (sha256 baselines), `.sapo-cli_backup/<yyyymmdd_hhmmss>/<key>` (pre-overwrite copies, keep 50), `.sapo-cli_dev.lock` (PID), `backups/*.zip`.

## 5. Critical Edge Cases / Traps / Workarounds
1. **Fail-open lock**: fetchRemoteAssetValue catches everything → null → status `new` → push proceeds. Any 401/500/timeout during lock check silently disables conflict protection (remote-state.ts:64-72, 120-127). SapoAPI.get null-on-non-2xx makes 'missing' indistinguishable from 'error'.
2. **Promise.withResolvers on Node 18 claim**: used in sapo_api.ts delayMs, files.ts binary retry/verify, theme-dev-watcher queue — API exists only Node ≥22 → TypeError on engines 18-21. First rate-limit sleep or first file delete crashes.
3. **Binary push verify-GET workaround** (real platform quirk): PUT attachment flaky/eventually-consistent → 3 attempts, on failure GET + compare normalizeBase64 (strips whitespace); payload appends `\n` to base64. Backoff 1.5s·2^(n-1) + 700ms·attempt verify delay (files.ts:60-87, 213-244).
4. **Baseline poisoning risk**: post-PUT baseline prefers `response.asset.value` (server echo may be transformed), falls back to re-GET then local content — transformed echo makes `sapo diff` show file modified forever (files.ts:247-262).
5. **plural→singular key mapping asymmetry**: `layouts/x`→`layout/x`, `configs/x`→`config/x` on push, but fetch writes remote `layout/x` to `layout/` — project using `layouts/` ends up with both dirs; both map to same remote key and `layouts/` wins push order (walks after `layout/` in THEME_FOLDERS).
6. **pollRemoteConflicts blind spots**: non-recursive top-level readdir only → `templates/customers/*` never polled; key built as `${folder}/${f}` without toPosixThemeKey → `layouts/*` polled under wrong key → baseline miss → silently skipped; cap 30 files/8s (helpers.ts:208-258).
7. **Sticky bulk-delete consent**: one 'yes' to a ≥3-file batch auto-confirms every later bulk delete for the session (bulkDeleteConfirmed never reset; theme-dev-watcher.ts:30-60).
8. **Dev watcher force-push**: `force:true` bypasses optimistic lock entirely; mid-session remote edits overwritten on next save — only the 30-file initial poll mitigates (theme-dev-watcher.ts:97).
9. **Dead surface**: `.sapoignore` resolved but never read (isIgnoredThemePath only gets DEFAULT patterns; no caller passes customPatterns); `.sapo-sync-state.json` declared+ignored but never written; `--nodelete` forwarded but push never deletes; `skipLock` option unused; `leaky_bucket` config unused proactively.
10. **Diff binary noise**: baselines only set for text assets → every binary shows `[ADDED]` in `sapo diff` permanently.
11. **Prune backup corrupts binaries**: `fetch --prune` reads local-only files as utf8 before backup → png/woff backups mangled (files.ts:389-395).
12. **Binary fetch gap**: binary asset lacking `public_url` and `value` silently skipped — no attachment decode fallback (files.ts:340-360).
13. **Lock skip list scope**: binary + rendered `.css/.scss/.js` `.bwt`/`.liquid` + `config/settings_data.json` skip checks — correct (remote holds rendered output/merchant state) but leaves admin-CSS-editor files and merchant settings with zero conflict protection.
14. **Dialect linter gaps**: scans only layout/snippets/templates/sections — `assets/*.bwt` (server-rendered JS/CSS where `| slice` also crashes) unscanned; `| slice %}` (no arg, tag close) not matched by the three regexes.
15. **Committed OAuth secret**: config.json ships client_secret (same sin as hrv); OAuth has no PKCE; fixed port 3300.
16. **Write-probe side effect**: dev preflight PUTs an existing file's content back — mutates remote updated_at and fires any theme webhooks (helpers.ts:130-160).
17. **ipv4first**: `dns.setDefaultResultOrder("ipv4first")` — workaround for Node≥18 verbatim DNS on broken IPv6 routes to mysapo.net (fetch_sapo.ts:5).
18. **Idempotent-only timeout retry**: ECONNABORTED retried only for GET/PUT — correct non-idempotent guard worth copying.
19. **No project-root discovery**: projectConfig resolves from process.cwd(); running `sapo` in a theme subdirectory creates a fresh `.sapo-cli_local.json` there and loses store/theme link → STORE_NOT_SELECTED. Conf(cwd) vs context(canonicalRoot) dual path systems can diverge under symlinks.
20. **Restore**: adm-zip extractAllTo overwrite, no post-restore baseline refresh (diff then shows everything modified — cosmetic), zip entries rely on adm-zip's own sanitization.
21. **Dead deps**: openid-client, liquidjs, glob, trash, ora, cli-table imported nowhere in src (liquidjs notable — dialect lint is regex, not real Liquid parse).
22. **`sapo theme export` is local-only** — zips local dirs via backup(); name implies remote export; empty if never fetched.

## 6. Concrete improvements for Super Core
- **platform_semantics (sapo)**: `| slice` → fatal .NET LINQ crash (ban, severity error); `line_item.url` → use `line_item.product.url`; contact forms → action `/postcontact`; preview param `?themeid=`; auth header `X-Sapo-Access-Token` on `{prefix}.mysapo.net/admin`; dual rate header `x-sapo-shop-api-call-limit`|`x-bizweb-shop-api-call-limit` bucket 40/2rps; theme role `main`=LIVE; asset API value/attachment/public_url triad; `.bwt` = DotLiquid template ext; server-rendered suffixes `.css.bwt/.scss.bwt/.js.bwt/.css.liquid/.scss.liquid/.js.liquid`; plural local dirs `layouts/`/`configs/` map to singular remote keys; theme-scoped tokens 403 on /shop.json → probe /themes.json instead.
- **workarounds**: binary PUT verify-GET with whitespace-normalized base64 + trailing-newline quirk; ipv4first DNS for mysapo.net; ECONNABORTED retry restricted to GET/PUT; CRLF→LF normalize before any cross-platform checksum.
- **anti_patterns**: fail-open lock check (null remote ⇒ 'new'); baseline from server-echoed PUT body; session-sticky destructive consent; dead flags/config (.sapoignore, --nodelete, SYNC_STATE_FILE) that users trust; engines>=18 with Node-22 APIs; committed OAuth client_secret; regex lint that misses a file class (assets/*.bwt); diff that can't baseline binaries → perpetual false 'added'.
- **fix_patterns**: optimistic-lock = sha256(LF-normalized remote) vs stored baseline, skip list {binary, server-rendered, settings_data.json}; auto-backup remote value into stamped dir + prune(50) before overwrite; serial push queue + bulk-delete threshold guard (≥3/3s) for watchers; PID lockfile with kill(pid,0) liveness for session exclusivity; write-probe preflight for scope verification.

## 7. Concrete improvements for Haravan Theme Core Output
- ThemeCompiler targeting Sapo must: emit `.bwt`, rewrite `| slice` (use `truncate`/loops — never emit it), rewrite `line_item.url`→`line_item.product.url`, contact forms→`/postcontact`, and place files under singular remote dirs (`layout/`, `config/`) regardless of local plural convention — the asymmetric mapping is a proven conversion trap.
- HaravanSchemaGenerator/settings contract: treat `config/settings_data.json` as merchant-live state — never overwrite on deploy (Sapo CLI skips its lock check; a stale local copy pushed overwrites merchant customizer work silently). Generate settings_schema.json defaults so first push doesn't clobber live data.
- DOM sanitizer: add the six server-rendered suffixes to the 'remote content ≠ source' class — rendered `.css.bwt` output must never be diffed against source or used as clone truth.
- Adopt Sapo CLI's LIVE-push confirm + write-probe preflight into the H→S deploy path; adopt its doctor checks (BOM, >1MB images, title/canonical) as pre-publish gates.

## 8. Concrete improvements for AntiFan Core & Site Clone
- **AntiFan Core**: Sapo preview navigation must use `?themeid={id}`; storefront/admin probing should respect the 40/2rps bucket and read both call-limit headers; verification claims can reuse the CLI's claim model (local sha256(LF-normalized) vs remote baseline) — and should record the fail-open caveat (null remote ≠ proof of absence). SnapDOM/DOM-sanitizer parity: `.bwt` rendered assets are the Sapo analogue of Livewire/SSR blobs — sanitize by suffix list. PID-liveness dev-lock and serial-queue watcher are reusable patterns for AntiFan session exclusivity.
- **Site Clone**: IR model — Sapo theme = flat posix key→asset map with three payload kinds (value text / attachment base64 / public_url binary); canonicalize plural→singular dirs at IR level; asset pipeline must download binaries via public_url (attachment decode fallback missing upstream), honor the 3MB push cap and extension whitelist, and preserve the base64 trailing-newline quirk when round-tripping. Offline standalone mode: `.sapo-cli_remote.json` + `.sapo-cli_backup/` are a ready-made local remote-state model — DoD validator can define 'clone complete' = every remote key materialized locally + baselines written; reuse doctor rules (no `| slice`, no BOM, image weight, SEO tags) as Sapo-target DoD gates; mirror `--prune` semantics = backup-before-delete, but fix the utf8-binary corruption before copying the pattern.

— UltraAppSapoCLI (read-only scout; no files modified)
