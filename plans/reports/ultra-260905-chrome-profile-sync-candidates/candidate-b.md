# Candidate B — Diagnostic Report

# Diagnostic Report & Extension-Removal Architecture: Chrome Profile Sync
**Candidate:** B  
**Host Environment:** Windows 11 Pro x64 (`win32 10.0.22000`)  
**Runtime:** Electron 43 (`antifan-browser-desktop` v1.3.5, `main.cjs`, CJS)  
**Execution Mode:** Strictly Read-Only

---

## (A) Root-Cause Report

### 1. Cookie Loss: Triad of Mismatches, Fragile Delta Removal, and Placebo UI

#### Evidence Chain:
1. **The Partition Target Mismatch (The Smoking Gun) [CONFIRMED]**:
   - `src/main/index.ts:321-331`: handshake credentials callback resolves `activePartition`:
     ```ts
     const activeCapsule = capsuleManager?.getActive();
     const activePartition = activeCapsule
       ? deriveCapsulePartition(activeCapsule.id)
       : deriveCapsulePartition('default');
     ```
     `deriveCapsulePartition('default')` (`browser-session-partition.ts:28-33`) → `persist:capsule-default`.
   - `src/extension/background.ts:54-64`: extension caches `bridgeAuth = { token, port, activeCapsuleId, activePartition }` in `chrome.storage.local`.
   - `src/extension/background.ts:161-165`: every import payload stamps `partition: currentAuth.activePartition || payload.partition || undefined` → targets `persist:capsule-default`.
   - `src/main/bridge/bridge-server.ts:489-498`: bridge imports into `session.fromPartition("persist:capsule-default")`.
   - However, in `native-tab-host.ts:3009-3072`, tabs opened by the user (toolbar `btnNewTab` `renderer/toolbar.ts:1048`, app menu `CmdOrCtrl+T` `app-menu.ts:197`, context menus) call `createTab()` **without** `options.isolateSession`/`partition`; falls to `native-tab-host.ts:3070` → `getSharedProfilePartition(userAgentMode, isEphemeral)` → `persist:profile-default` (or `persist:profile-<safeProfileKey>`).
   - **Consequence:** Cookies deposited into `persist:capsule-default` are invisible to tabs in `persist:profile-default`; user sees 0 cookies.
2. **Destructive Delta Removals (`cause === 'explicit'`) [CONFIRMED]**:
   - `src/extension/cookie-debouncer.ts:59-63` / `background.ts:284-297`: `if (removed) { if (cause && cause !== 'explicit') return; }` — explicit deletions (logout, clear-site-data, JS token rotation) pass through.
   - `bridge-server.ts:524-542`: `targetSession.cookies.remove(cookieUrl, rem.name)`.
   - **Consequence:** Logout/expiry in Chrome immediately evicts the app session.
3. **`syncProfile()` is a UI Placebo for Cookies [CONFIRMED]**:
   - `chrome-profile-sync.ts:522-559`: only reads bookmarks + counts `targetSession.cookies.get({})`. **No cookie extraction/import.** 0-cookie path returns warning string `"(0 cookies - Chrome 127+ bảo mật v20...)"` (`chrome-profile-sync.ts:550`).
4. **Silent Failure of `--load-extension` on Running Chrome [CONFIRMED]**:
   - `chrome-profile-sync.ts:407-425`: if Chrome already running, still returns `{ success: true, isRunning: true, message: "Đã gọi mở Chrome. Chú ý: Chrome đang chạy sẵn...Load unpacked..." }`. Chromium drops `--load-extension` flags on handoff to an existing process; no handshake, no hydration.

### 2. Cache Loss: Non-Existent Sync Mechanism & Shared Partition Storage Wiping

#### Evidence Chain:
1. **Zero HTTP/Disk Cache Synchronization Path [CONFIRMED]**: "cache" in `chrome-profile-sync.ts` only refers to `cachedProfiles` (in-memory list cache, `CACHE_TTL_MS=5000`) and Chrome's `profile.info_cache` JSON key. Zero code copies `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\Cache\Cache_Data`; Chromium locks Simple Cache blockfiles exclusively while running; extension API has no disk-cache interface. AntiFan tabs always start cold.
2. **Broad Storage Clearing Impact on Shared Partitions [CONFIRMED]**: `native-tab-host.ts:2388-2404`: `ses.clearStorageData({ storages: ['cookies','localstorage','cachestorage'] })` without origin. All regular tabs share `persist:profile-default` → clearing on one tab wipes cookies/localStorage/CacheStorage for EVERY tab in the partition.
3. **Ephemeral Partitions on Tab Crash or Transient Actions [CONFIRMED]**: `native-tab-host.ts:2567-2572`, `browser-session-partition.ts:19-27`: `ephemeral-<id>-<nonce>` names lack `persist:` → volatile RAM (browser-control-port.ts:899, bridge-server.ts:1020 create ephemeral tabs). All cache + session gone on close.

### 3. Password Gap: Confirmed Missing Feature vs. App-Bound Encryption Boundary

#### Evidence Chain:
1. **Total Absence of Password Import / Decryption Logic [CONFIRMED]**: zero references to Chrome's `Login Data` SQLite, zero DPAPI `CryptUnprotectData`, zero `safeStorage` across the codebase.
2. **Chrome 127+ App-Bound Encryption (v20) [CONFIRMED]**: `Login Data`/`Network/Cookies` master key sealed by `elevation_service.exe` (SYSTEM) bound to chrome.exe signature; external processes cannot decrypt. Extensions have no `chrome.passwords` API in MV3 (manifest.json:7-14); CDP exposes no credentials dump.
3. **Placebo Chromium Switch in Electron [CONFIRMED]**: `index.ts:118` `enable-features=PasswordManager,Autofill` is a no-op in Electron — no native UI delegates (Save bubble, password settings), no credential store.

---

## (B) Rival-Hypothesis Elimination

| Symptom | Hypothesis | Verdict | Evidence |
| :--- | :--- | :--- | :--- |
| Cookie | R1: cookies expired before import, dropped by filters | RULED OUT (secondary) | `chrome-profile-sync.ts:54-58` drops expired; active session cookies promoted to 30-day TTL via `persistSessionCookies=true` (`bridge-server.ts:506-509`). |
| Cookie | R2: native messaging host crash / handshake fail | RULED OUT | `smoke-native-messaging-packaged.mjs:42-85` verifies host handshake works; logs show successful imports into the wrong partition. |
| Cookie | R3: Partition mismatch (`persist:capsule-default` vs `persist:profile-default`) | **RULED IN (PRIMARY)** | `index.ts:323-330` vs `native-tab-host.ts:3070`. |
| Cache | R4: disk cache corrupt / quota eviction | RULED OUT | No `--disk-cache-size` flags; standard Chromium cache under AppData Partitions. |
| Cache | R5: `clearCache()` called during tab switch/reload | RULED OUT | 0 occurrences of `clearCache` in `src/`. |
| Cache | R6: expectation gap (cache never imported) + shared-partition clearing | **RULED IN (PRIMARY)** | Zero cache migration code; `clearStorageForActiveTab():2393` purges `cachestorage`. |
| Password | R7: extension missing passwords permission | RULED OUT | Chrome platform has no password API for extensions. |
| Password | R8: DPAPI decryption failure | RULED OUT | No DPAPI code exists. |
| Password | R9: missing feature (no extraction path + Electron UI absence) | **RULED IN (PRIMARY)** | No Login Data reader, no CDP credentials domain, `index.ts:118` alone cannot persist passwords. |

---

## (C) Extension-Removal Architecture: Local-First, Zero-Extension

### 1. Capability-by-Capability Replacement Map

| Extension Capability | Local-First Replacement | Risk |
| :--- | :--- | :--- |
| Full Cookie Hydration | **CDP One-Shot Pull via `LocalSessionVault.importFromLiveChromeCDP()`** (`local-session-vault.ts:209-300`) — launch Chrome once with `--remote-debugging-port`, `Network.getAllCookies`, 30-day persistent TTL elevation, write into target session. Bypasses v20 encryption without extensions. | Low; Chrome must be started with the flag. |
| Delta Cookie Sync (`onChanged`) | **Eliminate live delta; explicit snapshot / on-demand sync.** Continuous delta was the root cause of unexpected logouts. Optional manual "Re-sync from Chrome" or low-frequency CDP poll WITHOUT removal propagation. | Zero. |
| Auth & Handshake Bridge | **Eliminated entirely.** No tokens, no registry keys, no `local-ipc-server.ts`, no `antifan-bridge-host.exe`; direct `127.0.0.1:<cdpPort>` WebSocket. | Zero. |
| Bookmarks Sync | Keep `getChromeBookmarks()` read; **stop write-backs** (`saveChromeBookmark`/`removeChromeBookmark` `chrome-profile-sync.ts:301-346`) — race with running Chrome. AntiFan keeps own `bookmarks.json`. | Low. |

### 2. Deletion vs Replacement
- DELETE: `extension/` tree, `src/extension/` (`background.ts`, `cookie-debouncer.ts`, `domain-scoper.ts`), `src/main/native-messaging/` (entire), `bin/antifan-bridge-host.exe`, scripts `build:extension`/`smoke:native-messaging`/`verify:native-messaging`, `installNativeHost` at `index.ts:317-342`, HKCU registry keys (Chrome/Edge/Brave).
- RETAIN + REFACTOR: `local-session-vault.ts` as primary ingestion engine; `chrome-profile-sync.ts` (drop launchWithCompanionExtension, keep/enhance launchChromeWithCdp, make `syncProfile` real CDP/VAULT import into `getSharedProfileSession()`); `native-tab-host.ts` partition unification to `persist:profile-${safeProfileKey}`.

### 3. CDP Security Risks & Mitigations
- Unrestricted local access on static 9222: dynamic ephemeral port (32000-39999) + `--remote-allow-origins=http://127.0.0.1:<port>`.
- Prolonged debugging state: one-shot lifecycle (launch→extract→flush→disconnect/close helper).

### 4. Migration & Rollback
- On first boot: run `uninstallNativeHost()` (`manifest-installer.ts:213-238`) to remove registry keys; clean `%LOCALAPPDATA%\AntiFan\NativeMessagingHosts` + `extension`.
- One-time migration: copy `persist:capsule-default` cookies → `persist:profile-default`.
- Rollback: `session-vault.json` export before changes; `importVaultFromFile()` restores without Chrome/extension.

---

## (D) Verification Plan (Windows 11 x64)

1. Partition mismatch: `node -e` require `.compiled/src/main/browser/browser-session-partition.js` → expect `Handshake Partition: persist:capsule-default` vs `User Tab Partition: persist:profile-default`.
2. Registry: `reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.antifan.bridge" /ve` → pre-fix manifest path; post-fix key gone.
3. CDP one-shot: `chrome.exe --remote-debugging-port=9222 --profile-directory=Default`; `Invoke-RestMethod http://127.0.0.1:9222/json/version` for `webSocketDebuggerUrl`; then `npm run smoke:persistence` + `npm run smoke:google`.
4. Password negative test: confirm `safeStorage` uncalled in app code.

## (E) Confidence Notes & Open Questions

- Partition isolation 100% confirmed (`index.ts:323-330`, `native-tab-host.ts:3070`). Delta deletions 100% confirmed (`cookie-debouncer.ts:59-63`, `bridge-server.ts:524-542`). Password gap 100% confirmed. CDP bypass 100% confirmed (`importFromLiveChromeCDP` existing).
- Open: onboarding UX for launching Chrome with CDP (auto background launch vs single button); password vault strategy (embedded safeStorage credential manager vs external managers).

Status: DONE