# Candidate C — Diagnostic Report

# AntiFan Browser Desktop — Chrome Profile Sync Deep Diagnostic & Extension-Removal Architecture Report
**Candidate**: C  
**Date**: 2026-09-05  
**Host Environment**: Windows 11 Pro x64 (Build 22000), Electron 43.4.0  
**Investigation Mode**: Strict READ-ONLY diagnostic audit (`ak:debug --ultra`)

---

## (A) Root-Cause Report

### 1. Cookie Loss Root Cause & Evidence Chain

"Cookie loss" is not a single bug but the compounded result of **four structural defects**:

#### 1.1 Partition Split: The Disjoint Cookie Jar Bug [CONFIRMED]
- Extension syncs into capsule partition (`persist:capsule-<id>`), user browsing tabs run in shared profile partition (`persist:profile-<safeKey>`); fully separate SQLite cookie jars.
- Evidence chain:
  1. `src/main/index.ts:321-332` — handshake callback computes `activePartition` via `deriveCapsulePartition(activeCapsule.id)` or `deriveCapsulePartition('default')` → `persist:capsule-default`.
  2. `src/extension/background.ts:56-64` / `background.js:984-988` — extension caches `bridgeAuth` incl. `activePartition` in `chrome.storage.local`.
  3. `src/extension/background.ts:161-164` / `background.js:1074-1076` — payload stamps `partition: currentAuth.activePartition || payload.partition || undefined`.
  4. `src/main/bridge/bridge-server.ts:489-495` — resolves `targetSession = this.tabHost.getPartitionSession(requestedPartition)` → `session.fromPartition("persist:capsule-<id>")`.
  5. `src/main/browser/native-tab-host.ts:3064-3071` — standard tabs never pass `isolateSession:true`; fall to `getSharedProfilePartition()` (`native-tab-host.ts:2573-2575`) → `persist:profile-default`.
  6. Consequence: extension reports success; cookies land in an unrendered partition; user sees logged-out pages.

#### 1.2 Destructive Delta Removal Propagation [CONFIRMED]
- `src/extension/cookie-debouncer.ts:59-63`: `if (removed) { if (cause && cause !== 'explicit') return; }` — explicit removals forwarded.
- `cookie-debouncer.ts:114-121`: removals enqueued as `type:'remove'`.
- `src/main/bridge/bridge-server.ts:524-542`: `await targetSession.cookies.remove(cookieUrl, rem.name)`.
- Consequence: explicit logout / token rotation in Chrome nukes app session; debouncing jitter (300-1000ms) can reorder remove vs upsert, leaving app logged out even on token refresh.

#### 1.3 Silent Failure of `--load-extension` When Chrome Is Running [CONFIRMED]
- Windows: launching chrome.exe with `--load-extension` while Chrome runs delegates to existing process and silently drops the flag.
- `chrome-profile-sync.ts:406-420`: returns `success:true` with `isRunning:true` + Vietnamese warning ("...đóng hẳn Google Chrome rồi mở lại, hoặc ...Load unpacked...").
- Consequence: green toast; extension never loads; zero-touch hydration never fires.

#### 1.4 `syncProfile()` Is a Zero-Cookie No-Op [CONFIRMED]
- `chrome-profile-sync.ts:535-558`: bookmarks read + `targetSession.cookies.get({})` count only. No extraction/decrypt/import.
- UI handler `native-tab-host.ts:983-998` (SYNC_CHROME_PROFILE) calls it + flushStore + bookmarks update.
- Consequence: users clicking "Sync Profile" get zero cookies from Chrome.

---

### 2. Cache Loss Root Cause & Evidence Chain

#### 2.1 Destructive Global Wipe by "Clear Storage" Button [CONFIRMED]
- `src/renderer/toolbar.ts:1562-1565`: button "Xóa Cookies & Cache của trang này" → `getApi()?.clearStorage()` → toast "Đã xóa Cookies & Cache của trang này".
- `native-tab-host.ts:2388-2404`: `ses.clearStorageData({ storages: ['cookies','localstorage','cachestorage'] })` — **no origin filter**; all tabs share `persist:profile-default` → wipes cookies, localStorage, HTTP cache for EVERY site in the partition.
- Electron API semantics: omitting `origin` clears the whole partition.

#### 2.2 Complete Omission of Chrome Disk Cache Mirroring [CONFIRMED]
- Zero code paths reference `Cache_Data`, `SimpleIndexFile`, net::DiskCache, or cache migration; grep yields 0.
- Chrome locks cache files exclusively while running (`ERROR_SHARING_VIOLATION` 0x20) — even attempted reads would fail.
- Consequence: every partition starts cold.

#### 2.3 Ephemeral Partition Cache Eviction on Restart [CONFIRMED]
- `browser-session-partition.ts:19-27`, `native-tab-host.ts:2567-2572`: `ephemeral-<id>-<nonce>[-native]` names without `persist:` → in-memory only.

---

### 3. Password Gap Root Cause & Evidence Chain

#### 3.1 Total Absence of Password Sync / Decryption Code [CONFIRMED]
- Zero references to `Login Data`, DPAPI `CryptUnprotectData`, `os_crypt`, App-Bound key retrieval.
- Only 4 "password" hits in `src/`: `index.ts:118` flag; `diagnostics-filter.ts:228` comment; `fallback-recorder.ts:22,30` redaction; `artifact-store.ts:338,340` redaction. `smoke-google-cookies.cjs:209` merely detects `input[type="password"]` DOM.
- Chrome 127+ App-Bound Encryption (v20) blocks external decryption of `Login Data`.

#### 3.2 Electron Architectural Inability to Save Passwords [CONFIRMED]
- `index.ts:118` `enable-features=PasswordManager,Autofill` is a no-op for end users: Chromium password management requires embedder UI delegate (`password_manager::PasswordManagerClient`, `ManagePasswordsBubbleModel` — Save bubble); Electron doesn't implement or export it to WebContentsView.
- Grep `safeStorage` in `src/`: 0 matches. No credential interceptors in renderer.

---

## (B) Rival-Hypothesis Elimination

| Symptom | Hypothesis | Verdict | Evidence |
| :--- | :--- | :--- | :--- |
| Cookie | C1: Electron SQLite cookie DB corruption | RULED OUT | `smoke-profile-persistence.cjs:67-83` & `native-tab-host.ts:5068` show clean read/write across restarts. |
| Cookie | C2: sameSite/Host-only rejection | RULED IN (partial contributor) | `chrome-profile-sync.ts:143-147,159-161`: `no_restriction` + non-secure rejected; `__Host-` + domain blocked → some cookies skipped/failed. |
| Cookie | C3: volatile session cookie expiry on restart | RULED OUT (as primary) | `bridge-server.ts:506` `persistSession = data.persistSessionCookies !== false` → 30-day elevation (`extensionCookieImportSetDetails:172-176`). |
| Cookie | C4: native messaging disconnect/crash loop | RULED IN (primary fragility) | `background.ts:73-91`: disconnect wipes bridgeAuth; missing host binary (`manifest-installer.ts:96-115`) → `REAUTH_FAILED_AFTER_401`. |
| Cache | K1: disk cache quota exceeded | RULED OUT | No quota flags; dynamic quota on Windows; loss is sudden (button/restart), not LRU. |
| Cache | K2: storefront `Cache-Control: no-store` | RULED OUT | CDN assets send `public, max-age=31536000`; loss caused by partition destroy/wipe. |
| Cache | K3: `--disable-http-cache` appended | RULED OUT | `index.ts:100-145` has no such switch. |
| Cache | K4: partition mismatch prevents cache reuse | RULED IN (structural) | Capsule partition cache is inaccessible to profile partition tabs. |
| Password | P1: DPAPI failure (different user accounts) | RULED OUT | Same interactive user; DPAPI never called anyway. |
| Password | P2: `Login Data` file locked while Chrome runs | RULED OUT | No reader exists; App-Bound v20 blocks even unlocked reads. |
| Password | P3: `safeStorage.isEncryptionAvailable()` false | RULED OUT | `safeStorage` never called (0 hits). |

---

## (C) Extension-Removal Architecture

### 1. Capability-by-Capability Replacement Map

| Extension Capability | Replacement | Feasibility |
| :--- | :--- | :--- |
| Full Cookie Hydration | **Direct CDP `Network.getAllCookies`** via `LocalSessionVault.importFromLiveChromeCDP()` (`local-session-vault.ts:209-300`) — bypasses App-Bound v20; writes to target partition. | 100% feasible, partially implemented. |
| Delta Cookie Sync | **Eliminate; on-demand pull / independent in-app browsing.** Delta sync proven anti-pattern (cross-browser contamination). | Architectural decision. |
| Handshake & Auth | **Eliminate entirely** (native host exe, stdio framing, local IPC socket, registry keys, tokens). | 100%. |
| Bookmarks Sync | Read-only import; cease write-back to Chrome `Bookmarks` (`saveChromeBookmark`/`removeChromeBookmark` race); store locally. | 100%. |
| Session Persistence | Built-in `persist:` partitions + `LocalSessionVault` export/import. | 100%. |

### 2. Component Lifecycle
- DELETE: `extension/`, `src/extension/` (background.ts, cookie-debouncer.ts, domain-scoper.ts), `src/main/native-messaging/` (manifest-installer, local-ipc-server/client, host-runner, framing, windows-acl), `bin/antifan-bridge-host.exe`, `index.ts:317-342` (LocalIpcServer startup + installNativeHost), IPC handlers `antifan:chrome:launch-with-extension` / `open-extension-folder`, HKCU registry keys (Chrome/Edge/Brave NativeMessagingHosts com.antifan.bridge).
- REPLACE/ENHANCE:
  1. Partition unification: tabs + imports → `persist:profile-${profileId}`.
  2. CDP puller: enhance `importFromLiveChromeCDP`; UI "⚡ Hút Cookies từ Chrome (CDP)" + "📁 Import Cookies (JSON/Cookie-Editor)".
  3. Scoped clear: `const currentOrigin = new URL(activeTab.state.url).origin; await ses.clearStorageData({ origin: currentOrigin, storages: [...] });`
  4. Offline password vault (optional phase): `safeStorage` (DPAPI) + preload credential capture (form with `input[type="password"]` → IPC save prompt → encrypted vault → autofill).

### 3. CDP Security Risk Evaluation
- Local port hijacking / cookie theft: HIGH → ephemeral random port (29100-29999), `--remote-allow-origins`, one-shot connect/extract/close (`local-session-vault.ts:255` closes WS).
- Profile contamination when using real profile: launch with `--user-data-dir` clone or refuse when Chrome running (`launchChromeWithCdp` `chrome-profile-sync.ts:446-451`).
- Malicious page DNS-rebinding: LOW — Chromium v111+ validates Host header / requires WS UUID token.

### 4. Migration & Rollback
1. Registry cleaner on update (`reg.exe delete .../com.antifan.bridge /f`), delete `%LOCALAPPDATA%\AntiFan\NativeMessagingHosts` + `extension`.
2. Partition alignment + automatic import of `persist:capsule-default` cookies into `persist:profile-default`.
3. Toolbar: replace extension buttons with CDP + JSON import.
- Rollback: `importVaultFromJson()` fallback (works even if enterprise policy disables `--remote-debugging-port`; RemoteDebuggingAllowed:false ADMX).

---

## (D) Concrete Windows Verification Plan

```powershell
# PROBE 1: registry state
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.antifan.bridge"
# PROBE 2: partition alignment via existing smoke
npm run compile && node scripts/run-electron.cjs scripts/smoke-google-cookies.cjs
# PROBE 3: persistence two-phase
npm run smoke:persistence   # expect exit 0, "[profile-smoke-runner] PASSED"
# PROBE 4: CDP extraction
taskkill /F /IM chrome.exe
Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222","--profile-directory=Default","--no-first-run"
Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version"   # expect webSocketDebuggerUrl
# then Node WS probe: send {"id":1,"method":"Network.getAllCookies"} → count cookies
# PROBE 5: origin-scoped clear invariant
# set cookie site-a + site-b; clearStorageData({origin:'https://site-a.com',storages:['cookies']});
# expect site-b preserved → "PASS: Origin scoping protected site-b"
```

## (E) Confidence Notes & Open Questions

1. `persist:` vs ephemeral — CONFIRMED: non-ephemeral → `persist:` (disk); ephemeral → RAM.
2. `bridgeAuth.activePartition` provenance — CONFIRMED: `index.ts:321-332` → local-ipc-server handshake → extension storage → payload.
3. `clearStorageData` callers — CONFIRMED: sole caller `native-tab-host.ts:2388-2404` via toolbar `CLEAR_STORAGE`; no origin → wipes partition.
4. `safeStorage` — CONFIRMED 0 usages. Password save — CONFIRMED 0 occurrences.
- Open: enterprise policy blocking remote debugging is handled by JSON fallback; partition migration timing.

Status: DONE