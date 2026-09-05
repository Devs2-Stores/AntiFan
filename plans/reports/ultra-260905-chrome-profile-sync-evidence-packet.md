# Ultra Evidence Packet — Chrome Profile Sync (2026-09-05)

Immutable evidence packet for `ak:debug --ultra` (same-tier best-of-5). Candidates: READ-ONLY.
Do not modify any file. Do not run mutating commands. Do not run formatters/linters/tests.
You may run read-only probes (node -e eval, fs.stat, reading files). Windows 11 x64 host.

## 1. User request (verbatim intent)

> "Kiểm tra toàn bộ tính năng đồng bộ Profile từ Chrome, hiện nó bug linh tinh nhiều quá,
> mất cache cookie tùm lum, password ko lưu bla bla. Với tiêu chí làm việc Local và độc lập,
> tôi muốn tìm phương án có thể bỏ Extension."

Translation: Audit the entire Chrome Profile sync feature — many random bugs: losing cache/cookies,
passwords not saved. Criteria: work locally and independently. Goal: find an approach that can
REMOVE the Chrome Companion Extension.

## 2. Confirmed constraints

- Windows 11 Pro x64; app = Electron 43 (`antifan-browser-desktop` v1.3.5, main.cjs, CJS).
- App bundles its OWN Chromium; tabs run inside the app via `NativeTabHost` + Electron `session` partitions.
- "Chrome" elsewhere = the user's REAL installed Google Chrome (`%PROGRAMFILES%` / `%LOCALAPPDATA%`).
- Must be local-first / offline / independent of the extension.
- Hard boundary from audit of evidence: **cookies, cache, and passwords are three DISTINCT paths —
  do not merge them into one "sync bug".**

## 3. Architecture map (confirmed by source read)

Canvas: Profile sync mirrors data from real Chrome into the app's Electron sessions.
Three data kinds: Bookmarks (direct JSON file I/O), Cookies (Extension → native messaging →
local HTTP bridge, or CDP pull), Passwords (NO CODE PATH EXISTS).

### 3.1 `src/main/browser/chrome-profile-sync.ts` (560 lines) — ChromeProfileSyncManager
- `getAvailableProfiles()`: reads `%LOCALAPPDATA%\Google\Chrome\User Data\Local State` →
  `profile.info_cache`. Caches 5s.
- `getChromeBookmarks(profileId)` / `saveChromeBookmark` / `removeChromeBookmark`: direct read/write of
  Chrome's own `<User Data>\<profile>\Bookmarks` JSON (rewrites whole file, own `date_added`/`id` scheme).
  No lock, no awareness that live Chrome owns this file.
- `getChromeExecutablePath()`: chrome.exe under PROGRAMFILES / PROGRAMFILES(X86) / LOCALAPPDATA.
- `isChromeRunning()`: `tasklist /FI "IMAGENAME eq chrome.exe"`.
- `launchChromeWithCompanionExtension(profileId?)`: spawns real Chrome detached with
  `--load-extension=<getPermanentExtensionDir()>` + `--profile-directory=<profile>` +
  `--no-first-run`. **If Chrome already running: still returns success:true with warning that the
  user must fully close Chrome or manually "Load unpacked" — i.e. --load-extension silently no-ops.**
- `launchChromeWithCdp(port=9222, profileId?)`: spawns real Chrome with `--remote-debugging-port=
  <port>` + `--profile-directory=<profile>`; **refuses (success:false) if Chrome is already running**.
- `syncProfile(profileId, targetSession?)`: ONLY (1) reads bookmarks, (2) counts
  `targetSession.cookies.get({})` length, (3) builds a message. **It never imports cookies, never
  touches Chrome's cookie DB, never touches cache or passwords.** 0-cookie note references
  "Chrome 127+ bảo mật v20" (app-bound encryption) needing extension or CDP.
- `cookieImportSetDetails` / `extensionCookieImportSetDetails`: build `Electron.CookiesSetDetails`.
  Key semantics: host-only vs domain cookies (leading-dot handling), `__Host-` prefix must not carry
  Domain, sameSite numeric→string mapping (0→no_restriction only if secure), expired cookies → null
  (skipped), `persistSessionCookies` elevates session cookies to `expirationDate = now + TTL`
  (default 30 days, `DEFAULT_PERSISTENT_SESSION_COOKIE_TTL_SECONDS`).

### 3.2 `extension/background.js` (1276 lines, bundled tldts; source at `src/extension/background.ts`)
- Scope profiles: `google` (google.com, youtube.com, googleusercontent.com, accounts.google.com,
  gstatic.com, google.com.vn), `ecommerce` (haravan.com, myharavan.com, myshopify.com, shopify.com,
  shopifycloud.com, sapo.vn, mysapo.net, bizweb.vn). Filter via ETLD+1 (`tldts` bundled).
- `CookieDebouncer` (delay 300ms / maxWait 1000ms): queues upsert/remove per
  `domain|path|name`; flush → `dispatchDeltaSync({upserted, removed})`.
- `connectNativeMessaging()`: `chrome.runtime.connectNative('com.antifan.bridge')`; HANDSHAKE →
  bridgeAuth = {token, port, activeCapsuleId, activePartition}; persisted in `chrome.storage.local`.
  onDisconnect → clears auth, retries every 5s; alarm watchdog reconnect (1 min period).
- `executeAuthenticatedCookieImport(payload, authSupplier, reauthSupplier, fetchFn)`:
  `POST http://127.0.0.1:<port>/api/cookies/import` with `Authorization: Bearer <token>` and
  `x-antifan-attachment-secret: <token>`; on 401 → `ensureBridgeAuth(true)` then retry once.
- `dispatchFullSync` (payload profileName "Chrome Live (Zero-Touch Native)"), `dispatchDeltaSync`.
- `triggerAutoHydration()`: on successful handshake → `chrome.cookies.getAll({})` → filter by scope →
  full sync.
- Delta listener: `chrome.cookies.onChanged` → **`if (removed) { if (cause && cause !== 'explicit')
  return; }`** → i.e. removals with cause `expired`/`evicted`/`overwrite` are dropped, but `explicit`
  removals (user logout, delete, clear-site-data) ARE propagated to the app session.
- Message API: SYNC_ALL_COOKIES, SYNC_ACTIVE_TAB, GET_STATUS, RECONNECT.
- `onSuspend` → `debouncer.clear()`.

### 3.3 `src/main/native-messaging/` — bridge plumbing
- `manifest-installer.ts`: `HOST_NAME='com.antifan.bridge'`;
  `COMPANION_EXTENSION_ID='khjcaadjohoclofjkkfblkbfbpmjjedp'`; registry keys per browser
  (`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.antifan.bridge`, plan; Edge; Brave) via
  `reg.exe add HKCU\...` (HKCU, no admin). Manifest at `%LOCALAPPDATA%\AntiFan\NativeMessagingHosts\
  com.antifan.bridge.json`; extension exported to `%LOCALAPPDATA%\AntiFan\extension`; host binary
  candidates: packaged sibling `antifan-bridge-host.exe`, workspace `bin/antifan-bridge-host.exe`,
  `%LOCALAPPDATA%\AntiFan\bin\antifan-bridge-host.exe`.
- `local-ipc-server.ts`: net server; per-launch instanceUuid + launchNonce; start(bridgePort,
  onHandshakeRequest) → {socketPath, instanceUuid}; heartbeat; auth file under secure runtime dir
  (`windows-acl.ts` prepareSecureRuntimeDirectory / writeRuntimeAuthFile).
- `local-ipc-client.ts`, `host-runner.ts`, `framing.ts`, `windows-acl.ts`: native messaging stdio
  framing between Chrome's native host and the app.

### 3.4 `src/main/bridge/bridge-server.ts` (1618 lines) — local HTTP bridge
- HTTP server on 127.0.0.1 (port with EADDRINUSE fallback to port 0 → persistBridgeInfo).
- `/api/cookies/import` POST (10 MB cap):
  - Partition resolution order: `data.partition` → `data.targetPartition` → `data.targetCapsuleId`
    → `data.capsuleId` (via `deriveCapsulePartition`) → `data.tabId` → active capsule partition →
    active tab session.
  - Attachment-token calls: FORBIDDEN to target arbitrary partitions; bound to one tab.
  - Master bridge token: **if `data.source === 'chrome-extension-delta'` and no partition → 400
    MISSING_TARGET_PARTITION** (background delta sync REQUIRES an explicit target partition).
  - **`const persistSession = data.persistSessionCookies !== false;`** → session cookies are by
    DEFAULT elevated to 30-day durable expiration.
  - Upserts: `extensionCookieImportSetDetails(cookie, {persistSessionCookies: persistSession})` →
    `targetSession.cookies.set(details)`.
  - Removals: `targetSession.cookies.remove(url, name)`.
  - `targetSession.cookies.flushStore()`.
- Response: {success, importedCount, removedCount, skippedCount, failedCount, totalReceived,
  targetTabId, targetPartition}.

### 3.5 `src/main/browser/local-session-vault.ts` — 100% offline vault
- JSON cookie backup/restore; Cookie-Editor format import; durable 30-day fallback TTL
  (`persistSessionCookies: true`, `sessionTtlSeconds: 30*24*60*60`).
- **`importFromLiveChromeCDP(targetSession, cdpPort=9222)`**: "Pulls all decrypted cookies from a
  live Google Chrome instance running with --remote-debugging-port via CDP. Bypasses Windows 11
  App-Bound Encryption (v20) cleanly."
- registerIpcHandlers (export vault etc.).

### 3.6 `src/main/browser/browser-session-partition.ts`
- `deriveCapsulePartition(capsuleId?, mode='clean', ephemeral=false)` — deterministic partition name;
  `configureBrowserSessionPartition(partition, mode)`; UA modes `clean` (stripped Electron tokens)
  vs `native`. **READ the body: determine whether produced partition names use the `persist:` prefix
  (durable across restarts) or not (in-memory → everything lost on restart).**

### 3.7 `src/main/browser/native-tab-host.ts` (5k+ lines)
- `getSharedProfilePartition(userAgentMode, ephemeral=false)` (~line 2564): uses
  `ChromeProfileSyncManager.getInstance().activeProfileId` → safe key → partition name; if ephemeral,
  nonce suffix (`Math.random().toString(36).slice(2,10)`).
- IPC: GET_CHROME_PROFILES (~981), SYNC_CHROME_PROFILE (~983-992: syncProfile + bookmarks →
  this.bookmarks), `antifan:chrome:launch-with-extension` (~1001), `launch-with-cdp` (~1004-1007),
  `open-extension-folder` (~1008-1011), `is-running` (~1012-1015), CLEAR_STORAGE (~980),
  bookmark save (~1028-1034 writes back to CHROME's Bookmarks file), bookmark remove (~1141-1145).
- State persistence (~5055-5105): persisted field `activeChromeProfileId` → on restore sets
  `ChromeProfileSyncManager.activeProfileId` and rebuilds session via
  `deriveCapsulePartition(activeCapsule?.id)` + `session.fromPartition`.

### 3.8 `src/main/index.ts`
- ~line 118: `app.commandLine.appendSwitch('enable-features',
  'PasswordManager,Autofill,SmoothScrolling,ParallelDownloading,BackForwardCache,
  AsyncImageDecoding')`.
- ~line 119: `disable-blink-features: AutomationControlled`.
- UA fallback set to a Chrome UA (chromeSessionUserAgent()).

### 3.9 UI + preload surfaces
- `preload/toolbar-preload.ts` (~104-109): exposes launchChromeWithExtension, launchChromeWithCdp,
  openExtensionFolder, isChromeRunning, exportSessionVault.
- `renderer/toolbar.ts` (~1245, ~1408): buttons → launchChromeWithExtension toasts.
- `app-menu.ts` (~118-130), `tab-context-menu.ts` (~264-276): "Sync: <profile>" menu → syncProfile.

### 3.10 Evidence of the password gap (grep across src/, extension/, scripts/)
- No code reads Chrome's `Login Data` SQLite; no DPAPI decryption; no credential import/save.
- Only hits for "password": index.ts feature flag (`PasswordManager,Autofill`), redaction helpers
  (artifact-store.ts, fallback-recorder.ts), attachment "credentials" naming, and
  `scripts/smoke-google-cookies.cjs` which merely DETECTS `input[type=password]` on the login page.
- Conclusion at this tier: the "password ko lưu" complaint maps to a MISSING FEATURE
  (no password import, no in-app password save/autofill persistence), not a broken sync path.

## 4. Confirmed failure modes / hypotheses to test (NOT conclusions)

- **H1 Cookie loss via delta removal propagation**: extension forwards `cause === 'explicit'`
  removals (logout / delete cookies / clear-site-data in Chrome) → bridge-server deletes the cookie
  from the app session. Cross-product: logging out of a site in Chrome logs out the app's tab.
- **H2 Cookie loss after app restart (volatile partition)**: if the targeted partition is NOT
  `persist:`-prefixed — e.g. ephemeral shared profile partition (nonce suffix), or active tab in an
  ephemeral capsule — cookies.set() writes into RAM; tab close / app exit → gone. Confirm which
  partitions are ephemeral by reading tab creation + deriveCapsulePartition.
- **H3 Delta sync target-partition mismatch**: bridgeAuth.activePartition comes from the handshake;
  if it does not match the current active tab's partition (capsule switch), delta pushes hit 400
  MISSING_TARGET_PARTITION and are lost; full hydration may target the wrong tab entirely.
- **H4 --load-extension silently no-ops when Chrome is running** (code admits it; success:true +
  warning). User believes sync active; no extension → no hydration → 0 cookies.
- **H5 Bookmarks JSON write race**: app rewrites Chrome's Bookmarks file while live Chrome owns it
  (Chrome flushes its own in-memory copy on change/exit) → app's bookmarks silently lost, or app
  overwrites newer Chrome state. Writing requires `cheat_code`-era formats? Verify.
- **H6 Cache**: NO cache path exists at all in the sync feature (no code copies Chrome's Cache/Code
  Cache dirs, no disk-cache migration). App tabs always start cold; the app's own disk cache is
  Electron's userData cache — check whether anything clears it (grep `clearCache|clearStorageData`).
- **H7 Password**: missing feature (3.10). Even reading Chrome's passwords is blocked by Chrome
  127+ app-bound encryption (v20) while Chrome runs; only extension/CDP cookie APIs bypass it.
- **H8 Extension/auth fragility**: native host binary resolution (packaged vs bin vs LocalAppData),
  registry keys per browser, disconnect→retry loop, reauth on 401. If the bridge port/auth file is
  stale or the host binary is missing, extension sits at lastNativeError and silently retries.

## 5. The second deliverable — extension-removal feasibility

For EACH extension capability enumerate a local, extension-free replacement and its risk:
1. Full cookie hydration (auto on startup) — candidate: CDP `Network.getAllCookies` via
   `--remote-debugging-port` (app already has launchChromeWithCdp + LocalSessionVault
   importFromLiveChromeCDP) or one-shot import; note CDP cannot fire change events.
2. Delta cookie change events (onChanged) — CDP has NO cookieChanged event; alternatives:
   poll+diff `Network.getAllCookies`, or in-app browsing makes sync moot, or page-script hooks
   (miss httpOnly + Set-Cookie). Evaluate which is safe/local.
3. Auth/token handshake (native messaging) — gone with the extension; CDP port-only auth model.
4. Security: --remote-debugging-port on a REAL profile exposes ALL cookies to any local process
   for the session's lifetime — evaluate risk and mitigations (random port, close-on-idle,
   dedicated volatile user-data-dir instead of the real profile, --remote-allow-origins).
5. What stays (must keep): bookmarks import (file read is fine), in-app session persistence
   (persist: partitions + vault), and the decision whether PasswordManager is implemented locally.

Concrete proposal expected: architecture of "extension-free local-first" — which components are
deleted (extension/, native-messaging/, registry keys, extension IPC handlers) vs which are replaced
(CDP puller, vault, persist: partitions), plus migration/rollback.

## 6. Scope rules for candidates

- READ-ONLY. No file writes, no git state changes, no process start/kill, no Chrome launch.
- Read the exact files/sections cited; pull exact line numbers for every claim.
- Separate CONFIRMED (quoted code) from HYPOTHESIS/[INFERENCE] explicitly.
- Produce: (A) root-cause report for cookie loss, cache loss, password gap — each its own section;
  (B) rival-hypothesis elimination; (C) extension-removal architecture; (D) verification plan with
  concrete Windows commands/probes; (E) confidence + open questions.