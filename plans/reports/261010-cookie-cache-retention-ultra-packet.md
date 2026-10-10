# EVIDENCE PACKET — ak:scout --ultra: Cookie/Cache retention for a solo local dev

**packetId:** ultra-retention-2026-10-10 · **Controller:** main session · **Mode:** best-of-5 read-only scout, evidence-validated union finalizer
**Repo root:** `E:\Work\apps\AntiFan` (Electron 43.x, Chromium 150, TypeScript → `.compiled/`, Windows 11 22000)
**Data root:** `E:\Work\.antifan-data` (live jar: `Profile/Partitions/profile-profile-2` = partition `persist:profile-profile-2`)

## 1. User question (verbatim, Vietnamese)

> "Tiếp theo là Cookie/Cache, với một Solo Dev Local như tôi, các cái này nên giữ càng lâu càng tốt nhỉ?"

The user is a solo developer (Haravan/Sapo/Shopify theme engineer) running AntiFan Desktop locally on one Windows machine. Prior work on this repo already fixed: wrong-jar writes, dead-store reclamation (84 stores, 4.9 GB), per-change cookie flush (survives hard kill), identity-cookie refusal on the Companion channel, Client Hints/UA consistency (commit 85bea6a9), Google sign-in Safari identity (commit 920dd0fc).

## 2. Scout targets (cover all six)

- **T1 Cookie lifetime.** Where a cookie's lifetime is decided: page-set cookies, import TTL (`persistSessionCookies`, `sessionTtlSeconds`), flush/durability, Chromium's own expiry cap, and whether session cookies (no `Expires`) survive an app restart.
- **T2 Deletion paths.** Every code path that deletes or clears cookies/site data: `clearStorageData`, `cookies.remove`, dead-store cleaner, partition deletion, ephemeral partitions, extension-side suppression, logout/clear UI.
- **T3 Cache bounds.** Every cache bound or eviction control (`--disk-cache-size`, `--media-cache-size`, `gpu-cache-dir`, V8 Code Cache js/wasm, Service Worker CacheStorage, quota/IndexedDB) and which of them actually bind the live partition.
- **T4 Dev correctness.** Paths that let a theme developer bypass or invalidate cache (reload ignoring cache, DevTools "disable cache", service-worker bypass, cache-busting on preview URLs, scope of "clear site data") — risk of stale CSS/JS/Liquid output during theme development.
- **T5 At-rest protection.** How long-lived cookies and session exports are protected on disk: Electron cookie-encryption fuse, `safeStorage`, `session-vault.json`, ACLs on the data root.
- **T6 Disk budget / housekeeping.** What reclaims space under the data root and what grows unbounded.

## 3. Measured facts (Tier-1, controller, 2026-10-10; do not re-measure the locked DB)

| Item | Value |
|---|---|
| `Profile` total | 1,213.7 MB |
| `Partitions/profile-profile-2` total | 1,200.8 MB |
| └ `Cache` (HTTP) | 150.0 MB, 727 files, oldest mtime 2026-10-02, newest 2026-10-10 (rolling eviction ≈ 8 days) |
| └ `Code Cache/js` | 301.1 MB, 3,228 files, oldest 2026-09-03 |
| └ `Code Cache/wasm` | 450.8 MB, 317 files, oldest 2026-09-03 |
| └ `Service Worker/CacheStorage` | 204.9 MB (largest origin hash 49.4 MB, next 45.3, 39.2) |
| └ `Service Worker/ScriptCache` | 6.9 MB |
| └ `IndexedDB` | 32.6 MB (pancake.vn 10.9, facebook 6.3, trello 4.5, canva 2.7, music.youtube 2.5, shopee 2.1) |
| └ `Local Storage` / `Cookies` / `GPUCache` | 5.0 / 1.0 / 5.8 MB |
| Default-session `Profile/Cache` | 5.6 MB |
| Other data-root dirs | baselines 263.6 MB, control-plane-v2 175.5 MB, runtime 109.5 MB, daemon-host 82.5 MB, config 31.3 MB |
| Drive E: | 95.6 GB free / 121.2 GB used |
| Live `Network/Cookies` DB | **exclusively locked** by the running app (copy → EBUSY; FileShare.ReadWrite open → in use; VSS → denied). Live expiry distribution NOT measured this session. |
| Prior measurement (2026-09-19, `docs/research-cache-cookie-mechanism.md` §2.3) | 0 session cookies across 86 stores; farthest expiry 2027-10-10 |
| Repo grep `EnableCookieEncryption|flipFuses|FuseV1Options|@electron/fuses` | 0 matches |

## 4. Known code anchors (verify; do not trust blindly)

- `src/main/config/storage-locations.ts:18-19` — `DISK_CACHE_BYTES` 128 MB, `MEDIA_CACHE_BYTES` 64 MB.
- `src/main/index.ts:295-305,318-319` — cache switches + comment: switches do NOT bound partition caches.
- `src/main/browser/cookie-durability.ts:32` — `COOKIE_FLUSH_DEBOUNCE_MS = 1000`.
- `src/main/browser/native-tab-host.ts:6963-6984` — per-origin clear: `storages: ['cookies','localstorage','cachestorage']`.
- `src/main/browser/dead-store-cleaner.ts`, `scripts/prune-dead-stores.cjs`, `src/main/index.ts:4583-4616` — boot reclaim.
- `src/main/browser/local-session-vault.ts`, `src/main/browser/chrome-profile-sync.ts` — import TTL, vault.
- `src/main/browser/browser-session-partition.ts` — partition configuration, ephemeral naming.
- `docs/research-cache-cookie-mechanism.md` — prior forensics (§2.4 cache, §3.2 expiry, §5 status).

## 5. Constraints for candidates

- READ-ONLY. Do not edit, create, or delete files. Do not run the app, `npm run compile`, tests, or any `prune`/`--apply` command.
- Never open, copy, or query `E:\Work\.antifan-data\**\Cookies`, `session-vault.json` values, or any credential store. Directory stat/size only.
- Cite every claim as `path:line` (verified by reading the line) or as a row from §3. Mark anything not verified `[INFERENCE]`.
- External Chromium/Electron behavior (e.g. cookie expiry caps, quota eviction, code-cache sizing) must be labeled `[EXTERNAL]` with the source name; do not invent version numbers.

## 6. Rubric (verifier, 1–20 per criterion)

1. **Coverage** — all six targets T1–T6 addressed with concrete files.
2. **Evidence quality** — paths/lines exist and say what is claimed; roles accurate.
3. **Signal density** — findings that change the answer to the user's question, not inventory noise.
4. **Honesty about gaps** — unverified items marked; unresolved questions listed.

Finalizer: evidence-validated, deduplicated **union** of findings across the five candidates. Findings whose citation does not check out are dropped.
