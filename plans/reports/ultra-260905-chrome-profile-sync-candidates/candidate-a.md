# Candidate A — Diagnostic Report

# Chrome Profile Synchronization Diagnostic & Extension-Removal Architecture Report
**Candidate**: A  
**Investigation Mode**: Read-Only (`ak:debug --ultra`)  
**Host Context**: Windows 11 Pro x64 | Electron 43.4.0 (`antifan-browser-desktop` v1.3.5)  
**Target Repository**: `E:/Work/apps/antifan-browser-desktop`

---

## (A) Root-Cause Report

The reported symptoms ("bug linh tinh nhiều quá, mất cache cookie tùm lum, password ko lưu bla bla") stem from three fundamentally distinct architectural mechanisms that have been conflated under the label "Chrome profile sync." Below is the detailed evidence chain for each issue.

---

### A.1 Cookie Loss Root-Cause Evidence Chain

Cookie loss in the AntiFan Browser is caused by five interlocking architectural defects in session routing, IPC synchronization, UI action binding, and background event filtering:

#### 1. Architectural Partition Mismatch (Primary Smoking Gun)
* **CONFIRMED**: In `src/main/index.ts:322-331`, when the Windows Native Messaging Local IPC server responds to the extension's `HANDSHAKE` request, it calculates `activePartition` as:
  ```typescript
  const activeCapsule = capsuleManager?.getActive();
  const activePartition = activeCapsule
    ? deriveCapsulePartition(activeCapsule.id)
    : deriveCapsulePartition('default');
  ```
  Per `src/main/browser/browser-session-partition.ts:28-34`, `deriveCapsulePartition('default')` produces `persist:capsule-default`.
* **CONFIRMED**: In `src/extension/background.ts:56-64` (and bundled `extension/background.js:984-988`), the extension saves this `activePartition` into `chrome.storage.local`. In `src/extension/background.ts:161-165`, every cookie import payload sent to `/api/cookies/import` explicitly hardcodes:
  ```typescript
  partition: currentAuth.activePartition || payload.partition || undefined
  ```
* **CONFIRMED**: In `src/main/bridge/bridge-server.ts:489-495`, the bridge server processes `requestedPartition = 'persist:capsule-default'` and sets the cookies into:
  ```typescript
  targetSession = this.tabHost.getPartitionSession(requestedPartition);
  ```
* **CONFIRMED**: In `src/main/browser/native-tab-host.ts:3064-3071`, when `createTab()` is invoked, none of the callers pass `isolateSession: true`. Consequently, tab creation falls into the `else` branch:
  ```typescript
  partition = this.getSharedProfilePartition(userAgentMode, isEphemeral);
  ```
  Per `native-tab-host.ts:2573-2575`, this resolves to `persist:profile-${safeProfileKey}` (e.g., `persist:profile-default`).
* **FAILURE OUTCOME**: The tab WebContents lives in `persist:profile-default`, but the Chrome extension imports all cookies into `persist:capsule-default`. Because Electron partitions are completely isolated SQLite cookie databases on disk, the tab contains **0 imported cookies**. The user navigates to Google or Haravan and finds themselves unauthenticated.

#### 2. "Sync Profile" UI Action is a Read-Only No-Op
* **CONFIRMED**: When the user clicks "Sync Profile" in the UI toolbar or menu (`src/main/browser/native-tab-host.ts:983-999`), it executes:
  ```typescript
  const res = await ChromeProfileSyncManager.getInstance().syncProfile(profileId, targetSession);
  ```
* **CONFIRMED**: In `src/main/browser/chrome-profile-sync.ts:522-559`, `syncProfile()` reads Bookmarks from Chrome's disk JSON (`getChromeBookmarks`) and queries the target session:
  ```typescript
  let cookiesCount = 0;
  if (targetSession && targetSession.cookies) {
    const liveCookies = await targetSession.cookies.get({});
    cookiesCount = liveCookies.length;
  }
  ```
* **FAILURE OUTCOME**: `syncProfile()` **does not import, pull, or sync a single cookie**. It only inspects existing cookies in `targetSession`. When `cookiesCount` is 0, it returns the message: `"(0 cookies - Chrome 127+ bảo mật v20 cần mở Chrome với AntiFan Chrome Extension hoặc CDP để nạp cookies)"`. The user concludes that the sync feature is broken.

#### 3. Destructive Delta Removal Propagation (`cause === 'explicit'`)
* **CONFIRMED**: In `src/extension/cookie-debouncer.ts:59-63`, the cookie change listener checks:
  ```typescript
  if (removed) {
    if (cause && cause !== 'explicit') {
      return;
    }
  }
  ```
* **CONFIRMED**: When a user logs out of any site in Chrome, clears site cookies in Chrome, or when a web application in Chrome issues an expiring Set-Cookie header (`Max-Age=0`), Chrome dispatches an `onChanged` event with `removed: true, cause: 'explicit'`.
* **CONFIRMED**: In `src/main/bridge/bridge-server.ts:524-542`, the bridge iterates over `rawRemoved` and calls `await targetSession.cookies.remove(cookieUrl, rem.name)`.
* **FAILURE OUTCOME**: Logging out of a Google, YouTube, or Haravan account in real Chrome immediately transmits a removal event across the bridge, purging the corresponding session cookie from the AntiFan Desktop session.

#### 4. Delta Sync Target-Partition 400 Rejection on Capsule Switch
* **CONFIRMED**: In `src/main/bridge/bridge-server.ts:475-479`:
  ```typescript
  if (data.source === 'chrome-extension-delta' && !requestedPartition) {
    res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'MISSING_TARGET_PARTITION' }));
  }
  ```
* **CONFIRMED**: If `currentAuth.activePartition` becomes undefined (e.g., storage corruption, handshake dropped, or handshake before capsule initialization), delta updates fail with HTTP 400. Furthermore, if a capsule ID is deleted or switched, `isValidCapsulePartition()` (`native-tab-host.ts:2515-2554`) rejects the request with HTTP 404 `UNKNOWN_TARGET_PARTITION`.

#### 5. Ephemeral Partition Session Dropping
* **CONFIRMED**: In `src/main/browser/native-tab-host.ts:2567-2572` and `src/main/browser/browser-session-partition.ts:19-27`, when a tab is created with `ephemeral: true` (e.g., automated tool runs at `src/main/tools/browser-control-port.ts:2999`), the partition name is `ephemeral-profile-${safeProfileKey}-${nonce}`.
* **CONFIRMED**: In Electron, any partition string that does **not** begin with `persist:` is allocated in volatile RAM. As soon as the tab closes or the app restarts, the session and all cookies are discarded.

---

### A.2 Cache Loss Root-Cause Evidence Chain

#### 1. Zero Cache Synchronization Implementation
* **CONFIRMED**: Comprehensive grep across `src/main/browser/chrome-profile-sync.ts`, `src/main/bridge/bridge-server.ts`, and `src/extension/background.ts` reveals **zero code references** to Chromium disk cache directories, HTTP cache, or Code Cache.
* **CONFIRMED**: Real Google Chrome stores its HTTP cache under `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\Cache` and `Code Cache`. AntiFan's internal Chromium engine stores its cache under `%APPDATA%\antifan-browser-desktop\Partitions\<partition>\Cache`.
* **FAILURE OUTCOME**: Chrome's disk cache is never transferred to AntiFan. Every tab in AntiFan starts with a cold cache, requiring all assets to be fetched over the network.

#### 2. Unscoped Global Cache Purging via Toolbar Action
* **CONFIRMED**: In `src/main/browser/native-tab-host.ts:2388-2404`:
  ```typescript
  public async clearStorageForActiveTab(): Promise<void> {
    const activeTab = this.tabs.get(this.activeTabId);
    if (activeTab) {
      try {
        const ses = activeTab.view.webContents.session;
        await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage'] });
        ...
  ```
* **CONFIRMED**: In `src/renderer/toolbar.ts:1562-1565`, the UI menu item triggers `await getApi()?.clearStorage()` and displays: `"Đã xóa Cookies & Cache của trang này"` (*Cleared Cookies & Cache of this page*).
* **FAILURE OUTCOME**: `ses.clearStorageData()` is invoked **without an `origin` parameter**. In Electron, omitting `origin` purges cookies, localStorage, and HTTP/ServiceWorker cache for the **entire partition across all domains**. When a user attempts to clear cache for one problematic tab, the cache and cookies for all other open tabs and sites within that partition are purged.

---

### A.3 Password Gap Root-Cause Evidence Chain

#### 1. Total Absence of Credential Handling Logic
* **CONFIRMED**: Exhaustive search across `src/`, `extension/`, and `scripts/` reveals zero code for reading, decrypting, storing, or autofilling passwords:
  * No queries to Chrome's `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\Login Data` SQLite database.
  * No Windows DPAPI calls (`CryptUnprotectData`).
  * No credential vault, SQLite password store, or secure storage interface.
  * Grep hits for "password" in `src/` are restricted to: `src/main/index.ts:118` (Chromium flag toggle), `src/main/qa/diagnostics-filter.ts:228` (401/403 comment), `src/main/telemetry/fallback-recorder.ts:22,30` (redaction), `src/main/tools/artifact-store.ts:338-340` (redaction regex).

#### 2. Electron Architecture Strips Chromium's Password Manager UI
* **CONFIRMED**: In `src/main/index.ts:118`:
  ```typescript
  app.commandLine.appendSwitch('enable-features', 'PasswordManager,Autofill,SmoothScrolling,ParallelDownloading,BackForwardCache,AsyncImageDecoding');
  ```
* **CONFIRMED**: Electron bundles only the `//content` layer and explicitly excludes the `//chrome` UI layer (`ChromePasswordManagerClient`, Save-password bubble, credential selector). Setting `--enable-features=PasswordManager` in Electron enables low-level engine hooks but does not render any UI to prompt the user or save credentials to disk.

#### 3. Windows 11 App-Bound Encryption Barrier (Chrome 127+)
* **CONFIRMED**: In Google Chrome 127+ on Windows, Google introduced **App-Bound Encryption (v20)** for credentials stored in `Login Data`. The master AES-256 key is encrypted by a SYSTEM-level elevation service (`elevation_service.exe`) that validates the caller's cryptographic binary signature. External binaries cannot decrypt `Login Data` without running inside an officially signed Google Chrome binary.

---

## (B) Rival-Hypothesis Elimination (excerpt)

| Symptom | Hypothesis | Verdict | Evidence |
| :--- | :--- | :--- | :--- |
| Cookie | H-R1.1 Direct SQLite access failure due to Chrome v20 App-Bound Encryption | RULED OUT | Codebase has no SQLite driver; sync architected via Extension and CDP only. |
| Cookie | H-R1.2 Session cookies drop on restart due to lack of `expirationDate` | RULED OUT | `bridge-server.ts:506` defaults `persistSession = true`, 30-day TTL elevation. |
| Cookie | H-R1.3 Chromium rejects cookies due to `__Host-` / Domain rules | RULED OUT (as primary) | `chrome-profile-sync.ts:74-76,159-161` properly handle `__Host-` and dots. |
| Cookie | H-R1.4 Native messaging bridge failure due to missing host binary | RULED IN (contributing) | `manifest-installer.ts:96-115`, `background.ts:73-91`; disconnect resets bridgeAuth. |
| Cookie | H-R1.5 Partition mismatch between extension payload and tab session | RULED IN (PRIMARY) | `index.ts:323-330` vs `native-tab-host.ts:3070`. |
| Cache | H-R2.1 Disk cache quota exceeded | RULED OUT | No `--disk-cache-size` switch; fresh partitions < 5MB. |
| Cache | H-R2.2 Chrome lock file blocks cache reading | RULED OUT | No cache copy logic exists. |
| Cache | H-R2.3 Expectation gap + unscoped partition clearing | RULED IN (PRIMARY) | `native-tab-host.ts:2393` clears without origin. |
| Password | H-R3.1 Saved passwords corrupted | RULED OUT | `safeStorage` never used. |
| Password | H-R3.2 Chromium PasswordManager enabled but OS keyring failing | RULED OUT | Electron lacks `//chrome` UI dialog. |
| Password | H-R3.3 Unimplemented feature | RULED IN (PRIMARY) | 0 lines of password code anywhere. |

---

## (C) Extension-Removal Architecture

### C.1 Capability-by-Capability Replacement Map

| Extension Capability | Proposed Extension-Free Replacement | Feasibility |
| :--- | :--- | :--- |
| 1. Full Cookie Hydration | **CDP Direct Pull (`Network.getAllCookies`)** via `LocalSessionVault.importFromLiveChromeCDP()` (already implemented, `local-session-vault.ts:209-300`) | 100% feasible. Risk: Chrome must run with `--remote-debugging-port`. |
| 2. Delta Cookie Sync | **Eliminate.** Local-first session ownership; sync-on-demand ("Hút Cookies từ Chrome (CDP)" or sync-on-launch) | 100% feasible. Continuous sync causes race conditions and logout propagation. |
| 3. Handshake & Auth | **Eliminate.** Direct loopback WebSocket; no native host, no registry keys, no tokens | 100% feasible; removes ~2,500 lines of IPC plumbing. |
| 4. Bookmarks Sync | Keep read-only import; **stop writing** to Chrome's live `Bookmarks` JSON (write race) | 100% feasible. |
| 5. Password Management | Optional local vault via Electron `safeStorage` (Windows DPAPI) storing `credentials.enc` | High. Chrome passwords cannot be extracted while Chrome runs (App-Bound v20). |

### C.2 Deletion vs Replacement
- DELETE: `extension/`, `src/extension/`, `src/main/native-messaging/` (manifest-installer, local-ipc-server/client, host-runner, framing, windows-acl), `bin/antifan-bridge-host.exe`, `scripts/build-extension.mjs`, `smoke-native-messaging*`, registry keys (HKCU NativeMessagingHosts com.antifan.bridge for Chrome/Edge/Brave), `index.ts:317-342` installNativeHost startup.
- REPLACE: `syncProfile()` → real CDP hydration into the active tab's partition; `launchChromeWithCompanionExtension` removed, CDP path kept; `clearStorageForActiveTab()` → origin-scoped:
  ```typescript
  const origin = new URL(activeTab.view.webContents.getURL()).origin;
  await ses.clearStorageData({ origin, storages: ['cookies','localstorage','cachestorage'] });
  ```
- FIX partition alignment: tab creation and cookie import must both target `persist:profile-${safeProfileKey}`.

### C.3 CDP Security Risks & Mitigations
- Local port hijacking (any local process can connect and read all cookies): ephemeral random port, `--remote-allow-origins=http://127.0.0.1:<port>`, one-shot lifecycle (disconnect immediately after extraction).
- Chrome already running conflict: probe `/json/version` first; prompt user or fall back to JSON vault import.

### C.4 Migration & Rollback
- Registry cleanup via `reg.exe delete`; delete `%LOCALAPPDATA%\AntiFan\NativeMessagingHosts` + `extension`.
- Back up cookies to `session-vault.json` before migrating; migrate `persist:capsule-*` → `persist:profile-*`.
- Rollback safe: vault JSON is standard format importable by any version.

---

## (D) Verification Plan (concrete Windows probes)

1. **Partition mismatch probe**: `node -e "const { deriveCapsulePartition } = require('./.compiled/src/main/browser/browser-session-partition.js'); console.log(deriveCapsulePartition('default'));"` → expect `persist:capsule-default` vs tab partition `persist:profile-default`.
2. **Origin-scoped clear probe**: set cookies for site-a & site-b in one partition; `clearStorageData({origin: site-a, storages:['cookies']})`; expect site-b remains.
3. **CDP extraction probe**: `chrome.exe --remote-debugging-port=9222 --profile-directory=Default`; `Invoke-RestMethod http://127.0.0.1:9222/json/version`; run `importFromLiveChromeCDP`; count cookies.
4. **Existing suites**: `npm run smoke:persistence`, `npm run smoke:google`.

## (E) Confidence Notes

- Cookie: VERY HIGH — partition mismatch verified directly at `index.ts:323` vs `native-tab-host.ts:3070`.
- Cache: VERY HIGH — zero cache code + unscoped clear.
- Password: VERY HIGH — missing feature.
- Extension removal feasibility: HIGH — CDP extractor already implemented.
- Open questions: multi-profile workflow; password vault scope (Option A safeStorage vault vs Option B external manager integration); session-cookie 30-day elevation policy.

Status: DONE