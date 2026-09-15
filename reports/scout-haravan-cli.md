# Ultra Scout Report — Haravan CLI (@f1genz/haravan-cli v1.2.0)

## 1. Project & Directory
`E:\Work\apps\Haravan CLI` — TypeScript ESM CLI (`hrv`, Commander 11, Node ≥18.18, Vitest). Custom Haravan theme-ops CLI: OAuth login, theme fetch/push with optimistic lock, dev file-watcher, backup/restore/rollback, diff, doctor, Liquid REPL, mini-LSP, image optimizer. ~40 source files under `src/` (commands/, helper/, services/, core/, config/).

## 2. Architecture & Role
Four layers:
- **Entry** `src/index.ts` — Commander program, `registry.applyTo(program)`, hardcoded help table, `checkVersion()` (10% random npm-registry probe per invocation), top-level error handler.
- **Commands** `src/commands/` — thin handlers; `commands/theme/index.ts` is a `switch(action)` dispatcher for 14 sub-actions.
- **Services** `src/services/` — `LiveOpsService` (all writes: push/fetch/dev/retry/rollback, job-based async), `SafeOpsService` (reads: info/diff/doctor/backup/restore/assets), `JobManager` (per-project lock + event bus), `SessionRegistry` (dev sessions), `OpenService`.
- **Helpers** `src/helper/` — `auth.ts` (OAuth), `haravan_api.ts` (REST client + rate limiter), `fetch_hrv.ts` (fetch wrapper w/ retry + 401 refresh), `files.ts` (946 LoC push/pull engine), `remote-state.ts` (optimistic lock), `theme-dev-watcher.ts` (chokidar pipeline), `theme-asset-patterns.ts` (key classification), `sync-state.ts` (failed-item journal), `keychain.ts` (keytar→file token store), `conf.ts`/`dotfile.ts` (legacy path/dotfile singletons), `theme-check.ts` (settings.html lint), `image-optimizer.ts` (sharp).
- **Core** `src/core/` — `project-context.ts` (canonical root via `realpathSync.native`), `context-paths.ts` (env-overridable dotfile paths), `context-dotfile.ts`, `service-result.ts` (typed result union), `events.ts`. `ambient-guardrails.test.ts` enforces: no helper-singleton imports and no `process.cwd()` inside `src/core` — a deliberate decoupling boundary so services run outside CLI cwd (AntiFan embedding).

State files: `~/.haravan-cli.json` (tokens, chmod 600), `<root>/.haravan-cli_local.json` (org_id/theme_id), `.haravan-cli_remote.json` (SHA256 baseline), `.haravan-cli_backup/<stamp>/` (pre-overwrite remote snapshots, keep 50), `.hrv-sync-state.json` (failed items + lastPushBatch), `.haravanignore`, `~/.haravan-cli_stale.json` (refresh failure counter).

## 3. Load-bearing Files & Contracts

**Auth (`helper/auth.ts`, `fetch_hrv.ts`, `keychain.ts`, `refresh.ts`)**
- authorization_code + client_secret flow; **PKCE must NOT be sent** — Haravan returns `invalid_request`/`Invalid client_id` when `code_challenge` present (probed, comment in auth.ts). client_secret is hardcoded in `src/config/config.json` and shipped to npm (env override `HARAVAN_CLIENT_ID/SECRET`).
- Localhost callback on port **9999** (`/api/oauth/install/login/callback`); short-link `/login` 302→full authorize URL exists specifically because **Electron browsers (AntiFan) convert pasted-URL newlines to spaces and percent-encode them, corrupting redirect_uri/client_id**.
- State (CSRF): verified only when present — Haravan does NOT echo `state` back for this client (observed 2×). Mismatched state → 400 + 30s grace timer waiting for the valid callback (stale-tab protection). 5-min absolute TTL, `server-destroy`, SIGINT→exit 130.
- `nonce` MUST be passed to `client.callback()` checks or openid-client fails claim validation.
- Token store: keytar if installed else `~/.haravan-cli.json` whole-object map keyed by org_id. 401 → single refresh-token retry per process (`didRefresh401`), persists rotated refresh_token, `invalidateAuthCache()`. `refresh-all` deletes revoked tokens (invalid_grant/401/403), tracks consecutive failures in `~/.haravan-cli_stale.json` (threshold 3 → suggest logout).
- `dns.setDefaultResultOrder("ipv4first")` in fetch_hrv.ts — Windows/Node IPv6-first fix.

**HTTP (`haravan_api.ts`, `fetch_hrv.ts`)**
- Retry table from config.json: 429→20×, 500→5×, ECONNABORTED→3×; `delay` field ×300ms (not seconds). Timeout retry only for GET/PUT (PUT asset is idempotent).
- `smartRateLimit` reads `x-haravan-api-call-limit: cur/total` — sleep 2s at ≥95%, 1s at ≥88%.
- `formatHaravanApiError` extracts `TraceId:` from Haravan's HTML 5xx error pages.
- Auth cache keyed by project-config path; `buildAuthOptions` returns null→GET throws, POST/PUT/DELETE log-and-return-null (inconsistent contract).
- `putUrlEncoded` exists but is dead code.

**Sync engine (`files.ts`, `remote-state.ts`, `theme-asset-patterns.ts`, `sync-state.ts`)**
- `THEME_FOLDERS = [assets, config, layout, snippets, templates, locales, sections]` but `THEME_DIRECTORY_PATTERNS` omits `sections` → `isSyncableThemeKey("sections/x.liquid")` = false.
- Optimistic lock: baseline SHA256 (CRLF→LF normalized) in `.haravan-cli_remote.json`; `checkRemoteUnchanged` → ok/conflict/new. Excluded: binary ext, `config/settings_data.json` (admin-mutated → perpetual false conflicts), `*.css.liquid|*.scss.liquid|*.js.liquid` (server-rendered → remote value ≠ local). Corrupted baseline → conflict for explicit-context callers, fail-open for legacy.
- Push: pre-write `backupRemoteValue` into `.haravan-cli_backup/<stamp>/`; single `backupStamp` per batch; `recordLastPushBatch` enables `rollback-last-push` (restore snapshots + delete remotely-created files). Binary push: base64 + trailing `\n`, 3-retry loop, **Haravan returns HTTP 500 even when it accepted the file** → verify via `remoteBinaryMatches` (GET asset.attachment, whitespace-normalized compare). PUT timeout → verify-GET hash compare before declaring failure.
- Bulk push: sequential, 300ms inter-file delay, SIGINT graceful-stop (double-Ctrl+C force), `--only`/`--ignore` globs + `.haravanignore`; `assets/` excluded from bulk unless `--only assets/...` given. 3MB cap on binary only; images >500KB/>2048px auto-compressed in place (sharp: mozjpeg q82, png effort7, webp q82 e6).
- Pull: `assets.json` list → `public_url` assets streamed to disk (query stripped; `.liquid` public_urls skipped — server-rendered), others via per-key GET `asset[key]` (encodeURIComponent, `%2F`→`/` restored), batch 5, retry [300,900]ms on 5xx/non-4xx. Dedup by key (keeps LAST — comment claims this matches disk overwrite order). Tmp dir `.hrv_tmp_pull-<pid>-<ts>-<rand>` → `copyThemeToFolder` overwrite merge; `--prune` mirrors (local-only → trash). Auto-appends `.haravan-cli_*` entries to `.gitignore`. `seedRemoteStateFromDisk` re-baselines post-fetch. Pre-fetch auto-backup when local theme files exist.
- `.hrv-sync-state.json`: failed items {key, operation, source, attempts, reason} → `hrv theme retry`; `lastPushBatch` → rollback.

**Dev watcher (`theme-dev-watcher.ts`, `live-ops-service.ts`)**
- chokidar: `usePolling` on win32, interval 100/binaryInterval 500, `awaitWriteFinish {100,50}`, `ignoreInitial`, DEFAULT_THEME_IGNORE_PATTERNS. 50ms debounce per `key:event`; serialized `_pushChain` (one PUT at a time). Checksum map seeded from disk; failed push → checksum rollback so next save retries.
- Silent mode (dev) skips optimistic lock AND remote backup — Haravan eventual consistency makes GET-after-PUT return stale → false conflicts.
- `BulkDeleteQueue`: ≥3 unlinks in 3s window (10s hard cap) → confirm batch. In LiveOps path the confirm emits a `prompt` event and returns false → **bulk deletes always auto-cancelled in CLI** (no responder wired).
- Initial remote-drift poll: ≤100 text files, batch 5, 30s timeout → interactive menu (fetch_changed/push_changed/fetch_all/ignore/exit); non-TTY auto-ignores.
- Preflight (`runWatcherPreflight`): token check via `/web/shop.json`, theme fetch, `assertWritableTarget` gate, then a **write-probe that PUTs a real asset back with identical content** (well-known keys first, ≤8 candidates).
- `assertWritableTarget` (fail-closed gate shared by push/dev/retry/rollback): theme_id present → remote theme fetch → id string-match → role must be `unpublished` **or `main`**.

**Lint/doctor (`theme-check.ts`, `safe-ops-service.ts`, `assets.ts`)**
- settings.html lint: Liquid tag stack matching, `{%`/`%}` balance, fieldset/table/legend + div/tr/td/label balance, duplicate `name=` attrs, **non-void self-closing tags** (auto-fixable via `fixSelfCloseInFile` — expands `<x/>`→`<x></x>`).
- doctor: lint + missing-image refs (src/url()/asset_url patterns), >1MB images, risky names (`_icon|_pico|_thumb|_small|_compact|_medium|_large|_grande` suffix collision with Haravan image-size parsing), mojibake markers (UTF-8-as-Latin1 Vietnamese), basic SEO (title/meta/viewport/img-alt/h1).
- `assets scan/rename`: reference extraction (`'x.png' | asset_url`, `url(...)`), rename rewrites text refs but **skips settings_data.json**.
- diff: local SHA256 (no CRLF normalization) vs remote `checksum` field, fallback size compare.
- `theme console`: LiquidJS REPL with hardcoded Haravan-like context + ~25 custom filters (money→vi-VN ₫, img_url size-suffix, etc.) — LiquidJS ≠ DotLiquid, semantics drift.
- `theme-language-server`: minimal stdio JSON-RPC — diagnostics only for settings.html + static tag/filter/object completions.

## 4. Critical Edge Cases / Traps / Bugs

1. **`sections/` never syncs.** `THEME_FOLDERS` includes it (fetch/backup/watch-paths cover it) but `THEME_DIRECTORY_PATTERNS` lacks `sections/**/*` → bulk push silently skips sections, dev watcher logs validation error on every section save. Single-file `hrv theme push sections/x.liquid` bypasses key validation and DOES push — inconsistent. Fatal for OS2.0-style themes.
2. **`--nodelete` is a dead flag.** Plumbed dispatcher→pushTheme→LiveOpsService→pushAllThemeFiles but no remote-delete code exists. ARCHITECTURE.md claims push deletes remote files missing locally — not implemented (or removed). Remote orphans accumulate silently.
3. **Live-theme push allowed despite docs.** README says push refuses `role:main` "vô điều kiện"; `assertWritableTarget` accepts `main` (comment even claims "can never be reached"). pushTheme prints only a yellow warning; dev watcher warns but proceeds. Documented safety invariant ≠ enforced invariant.
4. **`hrv theme publish` has zero confirmation** — instantly flips a theme live (contrast: `theme delete` prompts).
5. **Filename sanitizer regex bug** in `processCompressZipFile`: `/[^a-zA-Z0-9_\--￿]/g` parses `\--￿` as range U+002D–U+FFFF → allows `:` `?` `<` `>` `|` → zip write fails on Windows. backup() uses correct `\u0080-\uffff`.
6. **`fetch --only` documented as glob, implemented as literal comma-separated file list** (dispatcher joins onlyPatterns with ","; fetch validates each via `isSyncableThemeKey` → globs rejected).
7. **`getOAuthSettings` single-account fallback ignores org_id** — with exactly one stored org, any project's org_id resolves to that token → cross-org writes possible.
8. **`logout <org_id>` deletes the project dotfile unconditionally** — even when other orgs remain or the logged-out org wasn't the selected one.
9. **Single-file push sends the raw arg as asset key** — no posix normalization (Windows `templates\product.liquid` pushed verbatim), no theme-dir validation (`hrv theme push package.json` attempts to push a root file).
10. **Dev-mode bulk delete is unreachable** — `onBulkDeleteConfirm` emits a prompt event nothing answers → always resolves false. Deleting ≥3 files in dev never propagates.
11. **`theme/index.ts` swallows all non-ENOENT dispatch errors silently** — `catch` only handles ENOENT; other exceptions vanish with no output.
12. **diff is unreliable for text**: local hash isn't CRLF-normalized and remote `checksum` algorithm is unknown → text files likely always report "modified" (size fallback saves only identical-length cases).
13. **settings_data.json pushes with no lock and no warning** — overwrites admin-panel edits silently (excluded from lock by design, but no drift check before overwrite).
14. **Eventual-consistency false conflicts** — the reason silent mode skips the lock; any future lock-on-save design must tolerate GET-after-PUT staleness.
15. Minor: `downloadStreamFile` leaks the write stream when fetch rejects; `open` on win32 uses `cmd /c start` (URL `&` would break, currently single-param so safe); `whoiam` typo is the shipped command name; `SerialQueue`, `putUrlEncoded`, `runThemeDevSession`, `getRemoteConflicts` are dead code; session-registry entry leaks if `startThemeDevWatcher` throws after register; `seedChecksumsFromDisk`'s "skip non-utf8" comment is wrong (readFile utf8 never throws — binary gets FFFD-hashed, harmless); text files have no size cap (only binary 3MB).

## 5. Concrete Improvements for Super Core

Record these as platform semantics / anti-patterns / fix patterns / workarounds:

- **platform-semantic**: Haravan OAuth client rejects PKCE (`code_challenge` → invalid_request). Workaround: authorization_code + client_secret, state optional-tolerant (server doesn't echo state for this client).
- **platform-semantic**: Haravan Asset API eventual consistency — GET immediately after PUT can return stale content. Anti-pattern: hash-verify right after write. Fix pattern: verify-GET with retry/backoff (CLI uses 700ms×attempt, 3 tries).
- **platform-semantic**: binary asset PUT returns HTTP 500 even on success. Workaround: `remoteBinaryMatches` — GET `asset.attachment`, whitespace-normalized base64 compare.
- **platform-semantic**: `config/settings_data.json` is server-mutated by the admin panel → exclude from optimistic lock, conflict scans, asset-rename reference rewriting, and never treat local copy as authoritative.
- **platform-semantic**: `*.css.liquid|*.scss.liquid|*.js.liquid` are server-rendered → remote value ≠ local → exclude from all hash comparisons (lock, diff, drift poll).
- **platform-semantic**: asset filename suffixes `_icon,_pico,_thumb,_small,_compact,_medium,_large,_grande` collide with Haravan image-size parsing → risky-name rule.
- **platform-semantic**: rate limit via `x-haravan-api-call-limit` header (cur/total); 429 retry budget ~20; HTML 5xx pages carry `TraceId:` worth extracting for support.
- **anti-pattern**: theme-dir whitelist (`THEME_DIRECTORY_PATTERNS`) drifting from folder list (`THEME_FOLDERS`) → silent sync gaps. Generalize: "two source-of-truth lists for the same domain set will drift; generate one from the other or assert parity in a test."
- **anti-pattern**: documented safety invariant ("never push to live") implemented as warning-only. Record as `practice_parity` case: declared vs enforced.
- **fix-pattern**: pre-overwrite remote snapshot + batch stamp + lastPushBatch journal = invertible push (rollback = restore snapshot + delete created keys).
- **fix-pattern**: fail-closed write gate (`assertWritableTarget`) shared by every write entry point — push, dev, retry, rollback — so no sibling path bypasses the check.
- **workaround**: Electron-browser URL paste corrupts long OAuth URLs (newline→space→percent-encode) → serve short local `/login` redirect instead of printing the full URL.
- **workaround**: `dns.setDefaultResultOrder("ipv4first")` for Node≥17 on Windows networks.
- **hidden-requirement**: dev watchers need serialized push chains (parallel PUTs race bandwidth → mass timeouts) and checksum-rollback-on-failure (else failed saves never retry).
- **tool-intel**: chokidar on win32 needs `usePolling` + `awaitWriteFinish` for reliable theme watching.

## 6. Concrete Improvements for Haravan Theme Core Output

- **Compile-time equivalents of the settings.html lint rules** — the CLI's entire lint exists because these break the Haravan editor at runtime: non-void self-closing tags, unbalanced fieldset/table/legend, duplicate `name=` attrs, unbalanced `{%`/`%}`. ThemeCompiler should emit these as diagnostics; the DOM sanitizer should auto-expand `<nonvoid/>` → `<nonvoid></nonvoid>` (port `VOID_ELEMENTS` + `fixSelfCloseInFile` verbatim).
- **settings contract**: three distinct artifacts — `config/settings.html` (legacy editor form), `config/settings_schema.json` (F1GENZ schema), `config/settings_data.json` (server-mutated values). HaravanSchemaGenerator must never diff/lock/overwrite settings_data blindly; treat it as remote-truth.
- **Asset pipeline contract** (mirror for ThemeCompiler output validation): allowed push extensions set, binary-vs-text classification, 3MB binary cap, >500KB/>2048px auto-compress (mozjpeg q82 / png e7 / webp q82 e6), base64+`\n` attachment encoding, `asset[key]` encoding = encodeURIComponent with `%2F`→`/`.
- **Theme-key contract**: POSIX `dir/file` keys inside {assets,config,layout,locales,snippets,templates,sections}; CRLF→LF before any checksum; `.haravanignore` + DEFAULT_THEME_IGNORE_PATTERNS as the exclusion model.
- **Mark Liquid-rendered assets** (`*.css.liquid` etc.) in compiled output metadata as server-rendered so downstream sync/diff tooling knows not to hash-compare.
- **Include `sections/` in any generated sync manifest** — the CLI's omission is the canonical bug to avoid.

## 7. Concrete Improvements for AntiFan Core & Site Clone

**AntiFan Core**
- **Adopt the CLI's remote-truth baseline model**: `.haravan-cli_remote.json` (anchored SHA256 claims about remote state) is conceptually identical to Core's anchored claims — AntiFan verification claims could ingest this file as evidence, and Core could emit a compatible baseline so `hrv push` trusts AntiFan-fetched state. Shared format = free interop.
- **Port `assertWritableTarget` + `PROTECTED_THEME_REFUSAL`**: AntiFan's live-theme guard should use the same fail-closed gate (id match + role verify via API, never trust local dotfile) — and decide deliberately whether `main` is warn-or-refuse, since the CLI is internally inconsistent here.
- **Fix the URL-paste corruption the CLI works around**: AntiFan's Electron browser converts newlines in pasted text to spaces then percent-encodes — sanitize/trim pasted URLs at the input layer.
- **Reuse the eventual-consistency playbook** for CDP telemetry/verification: a read-after-write that disagrees isn't proof of failure — re-probe with backoff before recording a claim verdict.
- **Dev-watch equivalent**: if AntiFan drives theme watching, copy serialized-push + checksum-rollback + bulk-delete-confirm; and wire the prompt responder the CLI leaves dangling.
- **Auth interop**: CLI tokens live in `~/.haravan-cli.json` (or keychain service `haravan-cli`) keyed by org_id — AntiFan can read/refresh them instead of re-authenticating; honor `invalidateAuthCache` semantics on write.

**Site Clone**
- **Asset materialization pipeline = the CLI's pull**: split `public_url` stream-download (strip query, skip `.liquid` URLs — they're server-rendered and would bake wrong content into an offline clone) vs `asset[key]` API fetch; dedup by key keeping last; tmp-dir + atomic swap; failure journal for retry.
- **IR model**: adopt the theme-key contract (POSIX `dir/file`, 7 folders incl. sections) as the component/asset addressing scheme; carry `isBinaryAttachment`/`isLiquidRendered`/`isServerMutated` flags on IR nodes.
- **Offline standalone mode**: settings_data.json must be snapshotted as data (not re-derived); Liquid-rendered assets need their *rendered* form captured (public_url/CDN) since source won't render offline.
- **DoD validator**: reuse doctor's check set (missing refs, heavy images, risky names, mojibake, SEO basics, tag balance) as clone-fidelity gates — plus a "sections present" check the CLI itself would fail.
- **Respect `.haravanignore`/ignore-pattern parity** so cloned output matches what sync tooling will later push.

Key files for follow-up reads: `src/helper/files.ts` (sync engine), `src/helper/remote-state.ts` (lock), `src/helper/theme-dev-watcher.ts` (watch pipeline), `src/services/live-ops-service.ts` (write gate + jobs), `src/helper/auth.ts` + `fetch_hrv.ts` (OAuth + retry), `src/helper/theme-asset-patterns.ts` (key rules), `src/config/config.json` (endpoints/scopes/retry table).
