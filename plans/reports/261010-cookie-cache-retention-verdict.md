# VERDICT - ak:scout --ultra: Cookie/Cache retention (2026-10-10)

Packet: `261010-cookie-cache-retention-ultra-packet.md`. Candidates: `261010-cookie-cache-retention-candidates.md`.
Verifier: single kongming pass. Anonymization map: X1=C, X2=E, X3=A, X4=D, X5=B. Slots A, D, E were recovered from session transcripts after their yields were rejected (data+error fields); B and C returned normally.

Scores (/80): X1 67, X2 74, X3 76, X4 74, X5 74.

## Union (T1..T6)

### T1 — Cookie lifetime and durability

- **Claim:** Cookie imports preserve a supplied future expiration and skip already-expired inputs; an expiry is assigned to a session cookie only when the import option requests it. The vault import requests a 30-day TTL. Persistent (`persist:`) sessions get a debounced cookie-store flush after changes, which improves disk durability but does not extend the site's expiry or establish server-side validity. Current live cookie expiry distribution was not measured. **Citations:** `src/main/browser/chrome-profile-sync.ts:70-83,165-178`; `src/main/browser/local-session-vault.ts:454-456,473-475`; `src/main/browser/cookie-durability.ts:26-32,43-60`; `src/main/browser/browser-session-partition.ts:124-132`; packet §3 rows 38–40.
  - **Verified:** Yes for code behavior and packet-reported measurement/gap.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** Keep useful logins through their intended validity for convenience; do not equate durable local storage with a valid login, or treat a 30-day import fallback as a blanket cookie policy.

- **Claim:** Chrome's cookie lifetime cap is 400 days for `Expires`/`Max-Age`. **Citation:** `[EXTERNAL: developer.chrome.com/blog/cookie-max-age-expires]`. The repository's import mapping has no visible app-level maximum cap in the cited logic (`src/main/browser/chrome-profile-sync.ts:70-83`); this external fact is not a measurement of all behavior in the running Electron build.
  - **Verified:** Yes as an externally established fact supplied by the controller; runtime-specific application remains unresolved.
  - **Candidates:** None had valid source-backed evidence for the numeric cap; X1/X2/X3/X5 raised the gap.
  - **Impact:** “As long as possible” is not an unlimited cookie lifetime policy.

- **Claim:** The current cookie DB's expiry/session-cookie distribution was not measured because the live DB was locked; a prior 2026-09-19 scan found zero session cookies across 86 stores and a farthest expiry of 2027-10-10. **Citation:** packet §3 rows 38–39.
  - **Verified:** Yes (packet measurement/limitation).
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** No assertion about which current login expires next is supported.

### T2 — Deletion and clearing

- **Claim:** The built-in clear action requires an HTTP(S) origin and invokes `clearStorageData` for that origin with `cookies`, `localstorage`, and `cachestorage`, then reloads the view. It is origin-scoped; its explicit store list does not name HTTP cache, IndexedDB, or Code Cache. **Citations:** `src/main/browser/native-tab-host.ts:6958-6988`; `src/main/browser/app-menu.ts:720-723`; packet §3 rows 28–34 for measured stores.
  - **Verified:** Yes for the explicit code arguments and reload. The exact underlying Electron semantics beyond those arguments were not independently established.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** This is a targeted reset, not a guarantee that every layer affecting stale preview content is cleared; it can also remove that origin's login cookies.

- **Claim:** Boot cleanup targets narrowly named unreachable legacy partitions, stale default-session `Profile/Cache`, and listed state/temp debris; the cleaner's partition-name pattern excludes ordinary named profile partitions, and it checks live partitions before deleting. It is not a general age/size purge of a live partition. **Citations:** `src/main/browser/dead-store-cleaner.ts:7-30,42-56,180-219`; `src/main/index.ts:4595-4616`.
  - **Verified:** Yes.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** No evidence the boot cleaner routinely deletes the active login jar or active partition caches; it does reclaim some obsolete data, not all data.

- **Claim:** The extension drops cookie removals caused by eviction/expiry/overwrite unless the cause is `explicit`; the bridge refuses pure-removal batches and ignores removals in mixed batches while hydrating upserts. **Citations:** `src/extension/cookie-debouncer.ts:52-68`; `src/main/bridge/bridge-server.ts:1710-1726`.
  - **Verified:** Yes for this sync path.
  - **Candidates:** X1, X3, X4.
  - **Impact:** A cookie may remain in AntiFan after a source-browser removal event; that favors intentional cleanup rather than maximizing retention of copied credentials.

- **Claim:** Ephemeral sessions are non-persistent/in-memory by contract, while persistent sessions arm cookie durability. The inspected unconfigure path only removes ephemeral tracking; it does not establish the exact storage deletion timing. **Citations:** `src/main/browser/browser-session-partition.ts:20-28,114-132`.
  - **Verified:** Yes for classification and durability setup; cleanup timing remains unverified.
  - **Candidates:** X1, X3, X4, X5.
  - **Impact:** Choose ephemeral browsing when retaining site state is not wanted; do not assume it behaves like a long-lived profile jar.

### T3 — Cache bounds and observed stores

- **Claim:** `DISK_CACHE_BYTES` is 128 MB and `MEDIA_CACHE_BYTES` 64 MB; startup comments say these switches bind default-session caches, not the live explicit-partition HTTP cache. `gpu-cache-dir` is set separately. Packet measurements show the active partition's HTTP Cache at 150.0 MB, V8 Code Cache/js+wasm at 751.9 MB, Service Worker CacheStorage at 204.9 MB, ScriptCache at 6.9 MB, and IndexedDB at 32.6 MB. **Citations:** `src/main/config/storage-locations.ts:12-19`; `src/main/index.ts:295-305,318-319`; packet §3 rows 28–35.
  - **Verified:** Yes (switch scope from code; occupancy from packet).
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** The nominal cache switches are not a global budget for the measured active partition. Retaining all cache/site data indefinitely has a real disk cost; current figures are occupancy, not proof of future growth rate.

- **Claim:** The packet measured HTTP Cache at 150 MB/727 files with oldest mtime 2026-10-02 and newest 2026-10-10, described as rolling eviction of approximately eight days. **Citation:** packet §3 row 28.
  - **Verified:** Yes as a snapshot observation, not a promise of a stable retention window.
  - **Candidates:** X1, X2, X3, X5.
  - **Impact:** HTTP cache is already cycling; do not depend on a particular asset remaining cached for a fixed duration.

- **Claim:** The inspected app code and cleaner evidence establish no app-level global bound for the active partition's Code Cache, CacheStorage, IndexedDB, or cookies. The cleaner does not target active partition internals; the measured sizes do not prove that these stores grow without limit or define Chromium eviction/quota policy. **Citations:** `src/main/browser/dead-store-cleaner.ts:7-30,180-219`; packet §3 rows 29–34; `src/main/index.ts:295-305` (specifically for HTTP partition-cache switch scope).
  - **Verified:** Yes for cleaner scope and measured occupancy; no claim about unmeasured upstream eviction behavior.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** “Unbounded growth” is a risk of absent app-level active-store cleanup/budget evidence, not a proven growth trajectory. Monitor size and remove site data selectively if it becomes useful.

### T4 — Development freshness

- **Claim:** Ordinary app reload calls `webContents.reload()` without an explicit ignore-cache option. The workspace preview watcher appends/updates `antifan_ts` on stylesheet URLs for CSS-swap events; other changes call ordinary reload. Local `antifan-preview` responses include `Cache-Control: no-cache, no-store, must-revalidate`. These mechanisms do not establish deterministic freshness for every remote theme CSS/JS/Liquid/resource path. **Citations:** `src/main/browser/native-tab-host.ts:10663-10688,15519-15538`; `src/main/server/preview-protocol-handler.ts:71-79`.
  - **Verified:** Yes for the described code paths.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** Stale CSS/JS during remote theme development remains a concrete risk: normal reload is not an app-level cache-bypass guarantee. Local preview responses and the CSS watcher have narrower freshness protections.

- **Claim:** The built-in site-clear action's explicit store list includes CacheStorage but not HTTP cache, IndexedDB, or Code Cache. **Citations:** `src/main/browser/native-tab-host.ts:6978-6988`; packet §3 rows 28–34.
  - **Verified:** Yes for the explicit list; do not infer undocumented Electron side effects.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** If a theme remains stale after that action, it is not evidence that every relevant cache layer was cleared.

- **Claim:** `reloadZeroNetwork` is a separate local/offline verification capability, guarded to local origins; it is not general remote-storefront cache bypass. **Citation:** `src/main/tools/browser-control-port.ts:2328-2367`.
  - **Verified:** Yes.
  - **Candidates:** X1, X5.
  - **Impact:** It is not a substitute for a remote preview hard refresh/cache-debug workflow.

### T5 — At-rest protection

- **Claim:** Session-vault export serializes cookie name/value and metadata as JSON and writes UTF-8; no encryption operation appears in the cited export path. The separate password vault explicitly uses `safeStorage`, which is not evidence that cookie exports or the Chromium cookie DB are encrypted. **Citations:** `src/main/browser/local-session-vault.ts:318-341`; `src/main/browser/local-credential-vault.ts:1-5,15-18`.
  - **Verified:** Yes for export behavior and the distinct password-vault description.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** Exported cookie values are credential material at rest. Do not keep/export session-vault backups longer than needed without protecting/deleting them deliberately.

- **Claim:** Windows data-root setup attempts asynchronous protected DACL enforcement and swallows failures; the ACL helper verifies a protected DACL with SYSTEM and current-user entries. This does not establish the effective ACL on the live data root or vault file. **Citations:** `src/main/config/storage-locations.ts:148-159`; `src/main/security/windows-acl.ts:171-206,239-260`; packet §3 row 40 for absence of repo fuse configuration references.
  - **Verified:** Yes for code intent and error handling; live ACL state is not verified.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** Intended ACL hardening is useful, but not proof of effective protection; do not treat it as justification for indefinite credential retention.

- **Claim:** No repository matches for `EnableCookieEncryption`, `flipFuses`, `FuseV1Options`, or `@electron/fuses` were reported in the packet. Electron fuse documentation says `EnableCookieEncryption` defaults to Disabled. **Citations:** packet §3 row 40; `[EXTERNAL: electron docs/tutorial/fuses.md]`.
  - **Verified:** Yes as a repo-search result plus supplied external default. Whether this particular packaged/running binary overrides that default remains unverified.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** Do not assume cookie-database encryption at rest; this strengthens the case for treating a long-lived cookie jar as sensitive.

### T6 — Disk budget and housekeeping

- **Claim:** At measurement, the active profile partition was 1,200.8 MB and the Profile total 1,213.7 MB; other listed data-root directories included baselines 263.6 MB, control-plane-v2 175.5 MB, runtime 109.5 MB, daemon-host 82.5 MB, and config 31.3 MB. Drive E had 95.6 GB free. This is a snapshot, not a growth trend. **Citation:** packet §3 rows 26–37.
  - **Verified:** Yes (packet measurement).
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** Current reported headroom is comfortable, but neither current free space nor one snapshot proves indefinite retention is harmless.

- **Claim:** The boot cleaner reclaims specifically enumerated dead partitions, stale default cache, duplicate state, and temporary debris; its scope is not a universal retention policy for live profile/cache data. Run-scoped artifact retention is separate and is not evidence of cleanup for browser-partition caches. **Citations:** `src/main/browser/dead-store-cleaner.ts:7-30,42-56,180-219`; `src/main/index.ts:4595-4616`; packet §3 rows 26–37.
  - **Verified:** Yes for dead-store cleaner scope. The artifact-cleaner-specific limits mentioned by X1 do not change this conclusion.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** Live profile cache/site data does not appear covered by the identified boot reclamation; some old/orphan data does get reclaimed.

### T6 — App data and retained state

- **Claim:** Baselines, control-plane, runtime, daemon-host, and config occupy the packet-reported space above; the packet provides no trend or retention/lifecycle evidence establishing that these app-data categories are safely retained forever. **Citation:** packet §3 rows 36–37.
  - **Verified:** Yes for measured sizes and lack of a trend in this evidence packet; no claim that each directory grows indefinitely.
  - **Candidates:** X1, X2, X3, X4, X5.
  - **Impact:** Do not conflate app data (such as baselines or runtime/control-plane state) with disposable browser cache; decide cleanup by the owning data class and its purpose, not by a blanket “keep everything” rule.

## Answer per data class

| Data class | Recommendation for a solo local dev | Evidence-grounded reason / risk |
|---|---|---|
| **Cookies / logins** | Keep the active, useful login jar while it remains valid and useful; do not try to maximize every expiry or keep exported copies indefinitely. | Imports preserve supplied future expiry; selected session-cookie imports get a 30-day fallback; persistent jars flush after changes, which improves durability but not server validity (`src/main/browser/chrome-profile-sync.ts:70-83,165-178`; `src/main/browser/local-session-vault.ts:454-456`; `src/main/browser/cookie-durability.ts:26-32,53-60`). Chrome's cap is 400 days `[EXTERNAL: developer.chrome.com/blog/cookie-max-age-expires]`. Cookie sync may not propagate non-explicit removals (`src/extension/cookie-debouncer.ts:56-63`; `src/main/bridge/bridge-server.ts:1710-1726`), so stale copied credentials are possible. Cookie DB encryption is not assured by repo evidence; Electron fuse default is Disabled `[EXTERNAL: electron docs/tutorial/fuses.md]`; packet §3 row 40 reports no repo fuse references. |
| **HTTP cache** | Let normal cache eviction operate; retain for speed only, not as durable user data. Clear/reset when stale remote preview assets interfere, recognizing the site's clear action does not explicitly list HTTP cache. | Measured 150 MB and ~8-day rolling mtime span (packet §3 row 28); 128 MB switch is documented as not bounding the named partition cache (`src/main/index.ts:295-305`). Ordinary reload is not an explicit cache bypass (`src/main/browser/native-tab-host.ts:10663-10688`). Risk: stale theme CSS/JS in remote previews; the local preview protocol instead sends no-cache/no-store headers (`src/main/server/preview-protocol-handler.ts:71-79`). |
| **V8 Code Cache (JS/Wasm)** | Keep as a performance cache where useful, but do not assume a configured size cap or indefinite retention is safe. | Measured 301.1 MB JS + 450.8 MB Wasm (packet §3 rows 29–30). The named-partition switches do not cap HTTP cache (`src/main/index.ts:295-305`); these measurements and code do not establish Code Cache's exact eviction policy or future growth. |
| **Service Worker CacheStorage** | Retain for sites that benefit from it; selectively clear when a site's stale/offline state is a development problem. | Measured 204.9 MB (packet §3 row 31); origin clear explicitly includes `cachestorage` (`src/main/browser/native-tab-host.ts:6978-6988`). Its upstream quota/eviction behavior is unresolved; risk includes stale site/service-worker assets. |
| **IndexedDB / LocalStorage** | Treat as site state, not generic cache. Preserve application data that is useful; clear only the affected origin when acceptable. | IndexedDB measured 32.6 MB and Local Storage 5.0 MB (packet §3 rows 33–34). Clear action explicitly lists `localstorage` but not IndexedDB (`src/main/browser/native-tab-host.ts:6978-6982`); do not assume it resets IndexedDB. |
| **App data (baselines, control-plane, runtime, daemon-host, config)** | Preserve according to purpose; do not use browser-cache cleanup as a substitute for app-data lifecycle decisions. Avoid an indiscriminate wipe, but inspect/manage growth because no trend is available here. | Sizes are packet §3 row 36; disk free space row 37. The boot cleaner's scope is enumerated and narrow (`src/main/browser/dead-store-cleaner.ts:7-30`). No growth-rate claim is supported. |

**Bottom line:** not “keep all of these as long as possible.” Keep useful logins for convenience subject to validity and credential exposure; keep expendable caches while they help performance, but allow eviction and selectively clear them for stale theme output or disk pressure. The demonstrated risks are stale remote CSS/JS, plaintext exported cookies and unconfirmed cookie-DB encryption, and significant active-partition storage without a demonstrated global cap. The evidence shows substantial use, not proof of literally unbounded growth.

## Unresolved

- What is the current live cookie expiry distribution, without inspecting the locked credential DB? Packet §3 row 38 explicitly says it was not measured; row 39 is historical.
- Do page-set session cookies survive restart in this precise Electron/Chromium build? The code proves configured flushing/promotion paths, not the runtime behavior for ordinary page-set session cookies (`src/main/browser/cookie-durability.ts:26-32`; packet §3 row 38).
- Does the packaged/running Electron binary override the default-disabled `EnableCookieEncryption` fuse? Packet §3 row 40 reports no repo configuration references; `[EXTERNAL: electron docs/tutorial/fuses.md]` gives the default only.
- What are the exact Chromium/Electron quotas and eviction guarantees for named-partition HTTP cache, Code Cache, CacheStorage, and IndexedDB? The measured sizes are a snapshot (packet §3 rows 28–34); no cited primary-source policy was supplied here.
- What are the actual NTFS ACLs on the current data root, cookie DB, and session-vault file? Code only shows asynchronous attempted enforcement (`src/main/config/storage-locations.ts:148-159`).
- Does Electron clear additional stores beyond those explicitly listed by `clearStorageData`, and does the current DevTools/session provide manual cache-disable or service-worker bypass? The code citations establish the arguments passed, not unlisted runtime/UI semantics (`src/main/browser/native-tab-host.ts:6978-6988`).
- What are the growth rates and retention policies for Code Cache, CacheStorage, IndexedDB, baselines, control-plane, and runtime data? Packet §3 is one snapshot, not a time series.

## Controller verification (fresh evidence, after the verdict)

- **Cookie DB encryption - resolved: plaintext.** The fuse wire read from `node_modules/electron/dist/electron.exe` (the binary `run-antifan.vbs` launches) is `101100011`, so `EnableCookieEncryption` is off. That is Electron's default: the Chromium cookie SQLite stores values in plaintext.
- **Data-root ACL - resolved: restricted.** `icacls E:\Work\.antifan-data` shows only explicit entries for `NT AUTHORITY\SYSTEM` (F) and `DESKTOP-B0H4B60\Admin` (F), with no inherited entries. `Partitions\profile-profile-2\Network` inherits those two entries and adds the Chromium network-service AppContainer SID (M).
- **Force Reload is not a cache bypass.** `Ctrl+Shift+R` and the "Force Reload Page" menu item (`src/main/browser/app-menu.ts:277-283,644-650`) call `host.reload`, which runs plain `webContents.reload()` (`src/main/browser/native-tab-host.ts:10663-10688`). Nothing in the app calls `reloadIgnoringCache` (grep across `src`).
