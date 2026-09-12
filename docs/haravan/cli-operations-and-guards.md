# Haravan CLI Operations, Safety Guards, and Synchronization Architecture

**Document:** `docs/haravan/cli-operations-and-guards.md`  
**Phase:** 08A — Knowledge Acquisition & Canonical Base Contract  
**Created:** 2026-09-12  
**Authority Hierarchy:** Official Haravan Docs > Real Store Admin > Real Haravan API > Real Haravan CLI > Theme Source Code > Live Storefront Behavior.

---

## 1. CLI Architecture & Environment

The official command-line interface for Haravan theme engineering in this workspace is `@f1genz/haravan-cli` (v1.2.0, executable `hrv`).

- **Runtime Dependencies:** Built on Node.js / TypeScript, `chokidar@4.0.3` (file watching), `liquidjs@10.27.0` (syntax validation), `openid-client@5.4.3` (OAuth 2.0 PKCE auth), `adm-zip@0.5.17` (backup packaging).
- **Project Scope Binding:** Tracks workspace bindings locally via `.haravan-cli_local.json` (`org_id`, `theme_id`, `theme_name`).
- **Remote Synchronization Tracking:** Tracks asset SHA-256 digests and mtimes in `.hrv-sync-state.json`.

---

## 2. Comprehensive Command Matrix

```text
hrv CLI Subsystems
├── Top-Level Operations
│   ├── login / logout / refresh / whoiam    # OAuth 2.0 PKCE authentication management
│   ├── select                               # Interactive Org and Theme binding
│   ├── backup / restore / rollback          # Automated timestamped ZIP backup management
│   ├── diff / doctor                        # Local vs remote drift analysis and diagnostics
│   ├── assets                               # Static asset and CDN upload management
│   └── open                                 # Browser preview launcher (?themeid={id})
└── Theme Operations (hrv theme <cmd>)
    ├── dev                                  # Chokidar file watcher & serial upload pipeline
    ├── push                                 # Upload local theme assets to remote theme
    ├── fetch                                # Download remote theme assets to local workspace
    ├── publish                              # Promote unpublished theme to live (role: main)
    ├── lint                                 # LiquidJS template syntax validator
    ├── list / info                          # Organization theme query and inspection
    └── delete / rename / export / retry     # Theme lifecycle operations
```

### Key Command Specifications

| Command | Primary Function | Relevant Safety Flags | Verified CLI Source Anchor |
|---|---|---|---|
| `hrv theme dev` | Watches local theme files and pushes changes via `serial-queue.ts`. Emits preview link. | `--backup-on-exit` | `commands/theme/theme-dev.ts:70–85` |
| `hrv theme push` | Pushes local files to remote theme via `PUT/POST /web/themes/{id}/assets.json`. | `--force`, `-n`/`--nodelete` (accepted and ignored), `--only`, `--ignore` | `commands/theme/theme-push.ts:50–183` |
| `hrv theme fetch` | Fetches remote theme files to disk. | `--clean`, `--only` | `commands/theme/theme-fetch.ts` |
| `hrv theme publish` | Sets remote theme `role = "main"`. | Interactive confirmation | `commands/theme/theme-publish.ts:35` |
| `hrv theme lint` | Validates syntax of local `.liquid` files using LiquidJS. | — | `commands/theme/theme-lint.ts` |
| `hrv backup` | Creates timestamped `.zip` backup of theme assets. | — | `services/safe-ops-service.ts:40–95` |
| `hrv open` | Opens theme customizer or preview URL (`?themeid={id}`). | — | `services/open-service.ts:80` |

---

## 3. Fail-Closed Security Guards (`theme-push.ts`)

To prevent catastrophic accidental overwrites of live production storefronts, `hrv theme push` executes a chain of non-bypassable fail-closed security gates before transmitting any theme payload:

```text
Local Execution Invoked (hrv theme push)
  │
  ▼
[Gate 1: Context Theme ID Check] ──── Missing? ───► ABORT: [SECURITY_ABORT] PROTECTED_THEME_REFUSAL
  │ Verified present
  ▼
[Gate 2: Argument vs Context Mismatch] ─ Mismatch? ─► ABORT: [SECURITY_ABORT] PROTECTED_THEME_REFUSAL
  │ Verified match
  ▼
[Gate 3: Remote API Query] ────────── API Fail? ──► ABORT: [SECURITY_ABORT] (Cannot verify role)
  │ GET /web/themes/{id}.json
  ▼
[Gate 4: Remote ID Consistency] ───── Mismatch? ──► ABORT: [SECURITY_ABORT] Remote ID mismatch
  │ Remote ID verified
  ▼
[Gate 5: Remote Role === "main"?] ─── Yes (LIVE) ─► ABORT: [SECURITY_ABORT] Target theme is LIVE!
  │ Role is NOT "main"
  ▼
[Gate 6: Remote Role === "unpublished"?] ── No ───► ABORT: [SECURITY_ABORT] Role is not unpublished
  │ Verified "unpublished"
  ▼
Proceed to Serial Upload Pipeline
```

### Exact Guard Implementation Anchor

From `Haravan CLI/src/commands/theme/theme-push.ts:82–169`:

```typescript
// Guard 1: Missing target theme ID in project context
if (!resolvedThemeId) {
    return reportRefusal(`[SECURITY_ABORT] PROTECTED_THEME_REFUSAL: Missing target theme ID in project context.`);
}

// Guard 2: Parameter mismatch against project dotfile
if (getSettingProject?.theme_id && String(getSettingProject.theme_id).trim() !== resolvedThemeId) {
    return reportRefusal(`[SECURITY_ABORT] PROTECTED_THEME_REFUSAL: Theme ID mismatch... Push aborted.`);
}

// Guard 3 & 4: Verified remote query and remote ID match
const remoteTheme = (await HaravanAPI.get(`/web/themes/${resolvedThemeId}.json`, ...))?.theme;
if (!remoteTheme || String(remoteTheme.id).trim() !== resolvedThemeId) {
    return reportRefusal(`[SECURITY_ABORT] PROTECTED_THEME_REFUSAL: Remote theme ID mismatch. Push aborted.`);
}

// Guard 5: Live production theme protection (ABSOLUTE REFUSAL)
const remoteRole = typeof remoteTheme.role === "string" ? remoteTheme.role.trim() : "";
if (remoteRole === "main") {
    return reportRefusal(`[SECURITY_ABORT] PROTECTED_THEME_REFUSAL: Target theme has role "main". Pushing to live themes is blocked.`);
}

// Guard 6: Explicit unpublished role requirement
if (remoteRole !== "unpublished") {
    return reportRefusal(`[SECURITY_ABORT] PROTECTED_THEME_REFUSAL: Unknown remote theme role "${remoteTheme.role}". Pushing is only permitted to verified unpublished themes.`);
}
```

---

## 4. Deletion Protection & Risky Asset Guards (corrected 2026-09-12)

This section previously credited two mechanisms: a `--no-delete` flag (a no-op, and misnamed) and a "risky asset" guard (a size-suffix naming warning for `assets/*` images, called from reporting paths only). The only real deletion protection is a batch-size confirmation, and it does not cover a single-file `unlink`:

1. **`-n` / `--nodelete` flag is a no-op (corrected 2026-09-12):** the option is registered as `-n, --nodelete` (`helper/command-registry.ts:117`) and threaded (`commands/theme/index.ts:36,97` → `theme-push.ts:60,179` → `services/live-ops-service.ts:246`), but `noDelete` appears in no condition anywhere in `src/`: `helper/files.ts:714` and `services/live-ops-service.ts:246` declare it as a type field only. Local deletions therefore still reach the delete path with a single-file unlink (subject to the layers in item 2), regardless of the flag. Do not present this flag as deletion protection; the only structural protection is the remote role gate (see §3).
2. **Remote deletion is gated by extension, plus a batch-size confirm (corrected 2026-09-12):** a watcher-driven `unlink` passes through these layers, and only these:
   1. **Watcher key filter** — `handleDebouncedEvent` returns early unless `isSyncableThemeKey(key)` and not `.haravanignore`-matched (`helper/theme-dev-watcher.ts:273,282-283`).
   2. **Bulk-delete confirm** — every `unlink` awaits `BulkDeleteQueue.queue` (`theme-dev-watcher.ts:284-290`). The queue flushes 3 s after the last enqueue or at a 10 s hard deadline (`:12-14`, `:105-114`) and calls `onConfirm` **only when the flushed batch has ≥ 3 files** (`:85`). A refusal resolves every queued delete `false`, logs "✓ Đã hủy xóa N file", and the watcher returns before syncing (`:87-90`, `:287-290`). **A batch of 1–2 unlinks never reaches this layer.** The handler that actually ships is the service one: `hrv theme dev` calls `LiveOpsService.startDev` (`commands/theme/theme-dev.ts:75`), which starts the watcher with `onBulkDeleteConfirm` set (`services/live-ops-service.ts:533`, handler at `:576-585`) — it emits a `confirm` prompt event and then **returns `false` unconditionally**, so a batch of ≥ 3 is always cancelled with no consent path in the dev flow. The `@inquirer/prompts` `select` fallback (`theme-dev-watcher.ts:24-45`) is only reached when `onBulkDeleteConfirm` is absent, i.e. through `runThemeDevSession` (`:555-558`), which has no callers in `src/`; treat it as dead code for the shipped CLI.
   3. **Extension-only gate** — `commands/theme/helpers.ts:deleteFile` (the only `processingDeleteFile` caller; called from the sync pipeline at `services/live-ops-service.ts:547` and the retry path at `:642`) runs `checkFilePush(filePath, true, opts?.root)` (`:194`). With `notDelete = true` that check skips **both** the local-existence check (`helper/files.ts:406`) and the 3 MB size check (`:409-421`), leaving `isThemePushableByExtension` (`:422`) against `THEME_PUSH_ALLOWED_EXTENSIONS` (`helper/theme-asset-patterns.ts:4-26`).
   4. **No guard at all** — `processingDeleteFile` itself (`helper/files.ts:836-863`) reads `theme_id` from the project dotfile, builds `/web/themes/{id}/assets.json?asset[key]=…` and calls `HaravanAPI.delete`; a direct caller bypasses layers 1–3.

   That allowlist is 19 extensions — `.liquid`, `.json`, `.html`, images (`.png .jpg .jpeg .gif .svg .webp .ico`), fonts (`.ttf .woff .woff2 .eot`) and code (`.js .css .scss .sass`) — so for a single-file change `layout/theme.liquid`, `config/settings_data.json`, `config/settings.html` or `config/settings_schema.json` all pass with no prompt. `getRiskyAssetKeyReason` is **not** a delete guard either: it flags `assets/*` image names ending in Haravan size suffixes (`_icon`, `_large`, …) and is called only from the asset listing and doctor reports (`commands/assets.ts:120`, `services/safe-ops-service.ts:651`). Separately, `compareFileAndRemove` (`helper/files.ts:864-894`) never deletes remotely — it moves local files missing from the remote listing into the local trash. The only structural write protection in the CLI is the fail-closed remote **role** gate, which refuses any target whose role is not `unpublished`.

---

## 5. Preview URL Generation & Tier-1 Proof

The Haravan CLI code provides definitive proof that `?themeid=` is the correct preview query parameter on Haravan storefronts:

1. `Haravan CLI/src/commands/theme/theme-dev.ts:70`:
   ```typescript
   console.log(`   ${COLORS.FgGreen}Preview:${COLORS.Reset}    ${base}?themeid=${themeId}`);
   ```
2. `Haravan CLI/src/services/open-service.ts:80`:
   ```typescript
   return `${base}?themeid=${themeId}`;
   ```
3. `Haravan CLI/src/commands/open.test.ts:51,58`:
   ```typescript
   expect(url).toBe("https://my-store.myharavan.com?themeid=123");
   ```
4. **Enforcement (2026-09-12):** only a numeric `?themeid=<id>` certifies a preview. `packages/site-clone/src/qa/dod-validator.ts:auditHaravanPreview` no longer accepts `theme_id=` or `preview_theme_id=` (the Shopify spellings), because a URL carrying those selects no Haravan theme.

---

## 6. CLI Operations and Guards Claims Ledger

| Claim | Evidence Status | Source (Path or URL + Observed Date) | Contradiction | Next Probe |
|---|---|---|---|---|
| `hrv theme push` aborts with `[SECURITY_ABORT]` if remote theme has `role === "main"`. | `VERIFIED` | `Haravan CLI/src/commands/theme/theme-push.ts:147–153` (2026-09-12). | None. Fail-closed security guard. | None. |
| `hrv theme push` aborts if remote theme role is anything other than `"unpublished"`. | `VERIFIED` | `Haravan CLI/src/commands/theme/theme-push.ts:163–169` (2026-09-12). | None. | None. |
| The Haravan CLI generates storefront preview URLs using `?themeid=`. | `VERIFIED` | `Haravan CLI/src/commands/theme/theme-dev.ts:70` (2026-09-12); `open-service.ts:80`. | RESOLVED 2026-09-12: `packages/site-clone/src/qa/dod-validator.ts` accepted `theme_id=`/`preview_theme_id=` and certified `reports/chromium-verification/chromium-45-cases-results.json` (45/45) over URLs that addressed no Haravan theme; the predicate now requires a numeric `themeid` and the artifact is demoted. The artifact itself was removed from the repository on 2026-09-13 together with the rest of the old-target verification output, so this row keeps the demotion record rather than a live path. | None. CLI ground truth. |
| `hrv theme dev` uses Chokidar v4.0.3 and tracks sync states via `.hrv-sync-state.json`. | `VERIFIED` | `Haravan CLI/package.json` (2026-09-12); `helper/sync-state.ts`. | None. | None. |
| Project context is bound via `.haravan-cli_local.json` storing `org_id` and `theme_id`. | `VERIFIED` | `Haravan CLI/src/core/project-context.ts:40` (2026-09-12); `.haravan-cli_local.json`. | None. | None. |
| CLI protects `layout/theme.liquid` and `config/settings_data.json` from deletion. | `CORRECTED — FALSE` | `Haravan CLI/src/helper/theme-dev-watcher.ts:12-14,85,105-114,284-290` (`BulkDeleteQueue`: confirm only for batches ≥ 3, 3 s debounce / 10 s hard flush), `src/services/live-ops-service.ts:576-585` (service handler always returns `false`), `src/commands/theme/helpers.ts:194-203`, `src/helper/files.ts:404-426`, `:836-863`, `src/helper/theme-asset-patterns.ts:4-26` (2026-09-12). | The earlier `VERIFIED` row cited `getRiskyAssetKeyReason`, which only flags size-suffixed `assets/*` image names (`_icon`, `_large`) and is called solely from the asset listing and doctor reports. Real protection is a batch-size confirm that the shipped dev path always denies: a batch of 1–2 unlinks passes to the API with only the 19-extension allowlist as a gate, `.liquid`/`.json`/`.html` all pass, and `processingDeleteFile` itself has no check. The inquirer `select` fallback is unreachable from the shipped CLI (`runThemeDevSession` has no callers). | Add a structural-key refusal to the CLI delete path (requires approval: separate app). |
| `.workspace-context.json` is present in 26 of 30 corpus themes declaring `platform: haravan`, `kind: theme`, `layout: flat`. | `OBSERVED` | `E:/Work/customizes` corpus audit (2026-09-12). | None. Factual corpus pattern. | None. |
| The CLI fail-closed check on `role === "main"` guarantees that `hrv theme push` cannot accidentally overwrite a production theme even if `theme_id` is mistyped. | `DERIVED` | Source code analysis of `theme-push.ts:145–170` (2026-09-12). | None. Architectural invariant. | None. |
| Behavior of `hrv theme dev` file watcher under legacy Windows character code pages (e.g. `chcp 1258` vs `65001`). | `UNKNOWN` | None. Undocumented terminal encoding interaction. | None. | Probe BQ-05: run watcher in Vietnamese Windows terminal. |
| The serial upload queue in `serial-queue.ts` rate-limits outbound API requests to avoid tripping the 4 req/sec leaky bucket threshold. | `INFERRED` | Architectural intent of `serial-queue.ts` in Haravan CLI (2026-09-12). | None. | Benchmark upload concurrency under 100 simultaneous file mutations. |
