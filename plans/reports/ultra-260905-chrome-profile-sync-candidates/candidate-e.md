# Candidate E — Diagnostic Report

# Comprehensive Diagnostic & Architectural Report: Chrome Profile Sync & Extension-Free Transition
**Candidate:** E  
**Role:** Read-Only Diagnostic & Architecture Review (`ak:debug --ultra`)  
**Host Environment:** Windows 11 Pro x64, Electron 43 (`antifan-browser-desktop` v1.3.5)

---

## (A) Root-Cause Report

### 1. Cookie Loss: Analysis & Evidence Chain

#### [Cause 1.1] Primary Architectural Fault: Partition Mismatch between Extension Sync and Browser Tabs [CONFIRMED]
1. **Handshake Initialization** `src/main/index.ts:321-331`: `activePartition = activeCapsule ? deriveCapsulePartition(activeCapsule.id) : deriveCapsulePartition('default')` → `"persist:capsule-default"` (`browser-session-partition.ts:33`).
2. **Extension Ingestion** `src/extension/background.ts:56-64`: caches `bridgeAuth` incl. `activePartition` to `chrome.storage.local`.
3. **Payload Construction** `src/extension/background.ts:161-165`: `partition: currentAuth.activePartition || payload.partition || undefined` → `data.partition = "persist:capsule-default"`.
4. **Bridge Routing** `bridge-server.ts:442-450,489-495`: `targetSession = this.tabHost.getPartitionSession(requestedPartition)` → `cookies.set(...)` (516-518) into `persist:capsule-default` only.
5. **Tab Partition Disconnect** `native-tab-host.ts:3064-3071`: standard tab creation (New Tab `toolbar.ts:1048`, `CmdOrCtrl+T` `app-menu.ts:197`, bookmarks, URL nav, tab restore `native-tab-host.ts:5116-5119`) never passes `isolateSession` → `getSharedProfilePartition` (`native-tab-host.ts:2574-2575`) → `"persist:profile-default"`.
- Direct consequence: strictly isolated SQLite cookie jars; cookie writes to `persist:capsule-default` invisible to `persist:profile-default` tabs → unauthenticated login pages.

#### [Cause 1.2] Destructive Delta Removal Propagation (Chrome Logout Nukes App Session) [CONFIRMED]
- `src/extension/background.ts:285-300`: `if (removed) { if (cause && cause !== 'explicit') return; }` — logout/cookie-clear/JS token clear forwarded.
- Debouncer batches deletions → `dispatchDeltaSync` (`background.ts:223-238`).
- `bridge-server.ts:524-542`: `targetSession.cookies.remove(cookieUrl, rem.name)`.
- Direct consequence: logout/switch account in Chrome immediately deletes the app's session.

#### [Cause 1.3] Silent `--load-extension` No-Op When Chrome is Already Running [CONFIRMED]
- `chrome-profile-sync.ts:413-419`: returns `success:true, isRunning:true` with manual instructions ("đóng hẳn Google Chrome... Load unpacked").
- Chromium process architecture: `--load-extension` flag silently dropped on handoff to existing instance; no extension → no native messaging → no hydration.

---

### 2. Cache Loss: Analysis & Evidence Chain

#### [Cause 2.1] Total Absence of Chrome Cache Synchronization Path [CONFIRMED]
- `chrome-profile-sync.ts` operations: `Local State` read (line 219), `Bookmarks` read/write (line 269), executable discovery & spawn (352, 407, 461), cookie counting (542). Zero references to `Cache`, `Code Cache`, `GPUCache`.
- Neither extension nor CDP (`Network.getAllCookies`) can transfer disk cache blocks / SW caches between binaries.
- Direct consequence: 100% cold cache every start for every origin (Haravan Admin, Shopify Admin, Google Workspace re-download everything).

#### [Cause 2.2] Cache Partitioning & Ephemeral Cache Eviction [CONFIRMED]
- Each partition owns its disk cache at `<userData>/Partitions/<partition>/Cache`; regular tabs `persist:profile-default` vs previews `persist:capsule-<id>` never share cached assets.
- Ephemeral tabs (`ephemeral-profile-*`) use in-memory cache; discarded on close.
- Manual clearance: `native-tab-host.ts:2393` `clearStorageData({storages:['cookies','localstorage','cachestorage']})` (invoked by `renderer/toolbar.ts:1563`) wipes cache+storage on explicit user menu interaction.

---

### 3. Password Gap: Analysis & Evidence Chain

#### [Cause 3.1] Total Absence of Password Import from Google Chrome [CONFIRMED]
- Search for `Login Data`, `crypt32`, `CryptUnprotectData`, `dpapi`, `safeStorage`, `passwords`: zero references to Chrome `Login Data`; zero DPAPI/App-Bound unwrap; "password" hits only in feature flag (`index.ts:118`), redaction sanitizers (`artifact-store.ts:338-340`, `fallback-recorder.ts:22-30`), DOM query in `smoke-google-cookies.cjs:209`.
- Chrome 127+ App-Bound Encryption (v20): AES-256-GCM master key encrypted via SYSTEM `elevation_service.exe` tied to chrome.exe identity; external binaries cannot decrypt.
- `chrome.passwordsPrivate` is a private Google API forbidden to unpacked third-party extensions.

#### [Cause 3.2] Missing Password Manager UI & Credential Storage in Electron [CONFIRMED]
- `index.ts:118` `enable-features=PasswordManager,Autofill` — Blink-level flag only; Electron's content layer lacks `ChromePasswordManagerClient`, `PasswordBubbleView`, infobar prompts; no profile-level password SQLite store or auto-save dialogs.
- `safeStorage` (CryptProtectData-based) not imported anywhere.

---

## (B) Rival-Hypothesis Elimination

**Cookie:**
| Hypothesis | Verdict | Evidence |
| :--- | :--- | :--- |
| R1.1 RFC 6265bis `__Host-`/Domain rejection | RULED OUT as primary | `chrome-profile-sync.ts:72-76,159-161` sanitize `__Host-`; host-only correctly omits Domain. |
| R1.2 Session cookies expire on exit | RULED OUT as primary | `chrome-profile-sync.ts:172-176` `persistSessionCookies:true`, 30-day TTL. |
| R1.3 Background auto-clear/timer eviction | RULED OUT | Audited all `cookies.remove`/`clearStorageData`; only `bridge-server.ts:537` (delta) and `native-tab-host.ts:2393` (manual click). |
| R1.4 Partition mismatch traps cookies in `persist:capsule-default` while tabs run `persist:profile-default` | **RULED IN (Primary)** | `index.ts:324`, `background.ts:163`, `bridge-server.ts:495`, `native-tab-host.ts:3070`. |

**Cache:**
| Hypothesis | Verdict | Evidence |
| :--- | :--- | :--- |
| R2.1 Cache dir corrupt/read-only | RULED OUT | Disk healthy; smoke-persistence writes pass; user-writable paths. |
| R2.2 Watchdog/linter calls `clearCache()` | RULED OUT | `clearCache` = 0 results. |
| R2.3 AntiFan fails to copy Chrome disk cache | **RULED IN (Primary)** | Zero migration code; Chrome locks cache exclusively while running. |
| R2.4 Cold starts + partition fragmentation | RULED IN (contributing) | Separate partitions rebuild caches independently. |

**Password:**
| Hypothesis | Verdict | Evidence |
| :--- | :--- | :--- |
| R3.1 DPAPI key wrong | RULED OUT | No DPAPI code exists. |
| R3.2 passwords in localStorage/JSON cleared on restart | RULED OUT | 0 occurrences. |
| R3.3 Electron engine saves passwords but DB locked/missing | RULED OUT | Electron lacks PasswordManagerClient; never saves regardless of flags. |
| R3.4 Complete absence of password feature | **RULED IN (Primary)** | No credential vault or sync logic in codebase. |

---

## (C) Extension-Removal Architecture

### 1. Capability-by-Capability Replacement Map

| Extension Capability | Extension-Free Replacement | Feasibility & Risk |
| :--- | :--- | :--- |
| 1. Full Cookie Hydration | **Direct CDP (`Network.getAllCookies`)**: spawn Chrome `--remote-debugging-port=<ephemeralPort>` or connect existing CDP; extract in 1 roundtrip. `LocalSessionVault.importFromLiveChromeCDP` already implements (`local-session-vault.ts:209-300`); must target `persist:profile-*`. | Low risk. |
| 2. Delta Cookie Events (`onChanged`) | **Session Independence (Zero-Sync Architecture)**: hydrate once, operate independently; optional periodic poll & diff via CDP `Network.getAllCookies` on active domains, WITHOUT removal propagation. | Zero/low risk; prevents logout collisions. |
| 3. Auth / Token Handshake | **Eliminated entirely**: no external process, registry keys, HTTP bridge; Electron Main ↔ TabHost IPC handles storage. | Zero risk; −~2,000 lines brittle plumbing. |
| 4. Bookmarks Sync | **Read-only import + in-app bookmark store**; stop direct writes to Chrome `Bookmarks` (`chrome-profile-sync.ts:268-346` race/corruption risk). | Low risk. |

### 2. Deletion vs. Replacement Inventory
DELETE: `extension/` tree; `src/extension/` (background.ts, cookie-debouncer.ts, domain-scoper.ts); `src/main/native-messaging/` (all); `bin/antifan-bridge-host.exe`; registry keys (Chrome/Edge/Brave); bridge endpoint `/api/cookies/import` (`bridge-server.ts:411-565`); obsolete IPC handlers (`launch-with-extension`, `open-extension-folder`).
REPLACE/REFACTOR:
1. `chrome-profile-sync.ts`: delete `launchChromeWithCompanionExtension`/`openExtensionFolderAndGuide`; enhance `launchChromeWithCdp` (auto-detect running Chrome; prompt close or use headless/isolated clone); refactor `syncProfile` → real CDP hydration into active tab partition.
2. `local-session-vault.ts`: promote `importFromLiveChromeCDP`; target `tabHost.getSharedProfileSession()` or active tab partition.
3. `native-tab-host.ts`: partition alignment; remove destructive bookmark mutations; keep bookmarks local.
4. (Optional) password: local vault via `safeStorage` + preload autofill.

### 3. CDP Security Evaluation & Hardening
- Risk: same-user processes can connect to `127.0.0.1:<port>` and dump cookies/execute scripts.
- Mitigations: (1) ephemeral dynamic port (30000-60000), never static 9222; (2) `--remote-debugging-address=127.0.0.1` + `--remote-allow-origins=http://127.0.0.1:<port>`; (3) one-shot lifecycle (spawn→extract→close WS); (4) isolated `--user-data-dir` clone when real Chrome already running (Chrome forbids second CDP instance on the same profile dir).

### 4. Migration & Rollback Strategy
- Registry cleanup (`reg.exe delete ...com.antifan.bridge /f` × 3 browsers); disk cleanup of `%LOCALAPPDATA%\AntiFan\NativeMessagingHosts` + `extension`.
- Cookie migration: `persist:capsule-default` → `persist:profile-default` copy on first launch (`cookies.get` → `cookies.set` → `flushStore`).
- Rollback: `session-vault.json` export = 100% offline backup; re-import via toolbar.

---

## (D) Concrete Windows Verification Plan

| Command | Purpose | Expected |
| :--- | :--- | :--- |
| `npm run smoke:persistence` | Session persistence across restarts | Exit 0, cookies/localStorage/IndexedDB survive in `session.defaultSession`. |
| `npm run smoke:google` | Google auth identity/headers/expiration rules | Verifies `cookieImportSetDetails` math + `persist:capsule-test-*` partitions. |
| `npm run smoke:native-messaging` | Packaged host binary/manifest | Succeeds pre-migration; obsolete post-migration. |
| `reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.antifan.bridge" /ve` | Registry state | Pre: manifest path; post: missing. |
| `node -e "...session.fromPartition('persist:capsule-default') vs 'persist:profile-default' cookie isolation..."` | Partition disjointness | `Capsule cookies: 1 Profile cookies: 0`. |
| `chrome.exe --remote-debugging-port=9222 --profile-directory=Default` + `curl http://127.0.0.1:9222/json/version` | CDP endpoint | `webSocketDebuggerUrl` present; `importFromLiveChromeCDP` pulls cookies. |

## (E) Confidence Notes & Open Questions

- Partition mismatch 100% confidence (`index.ts:323-330`, `background.ts:163`, `bridge-server.ts:495`, `native-tab-host.ts:3070`).
- Missing password path 100% confidence (exhaustive search).
- CDP replacement feasibility 95% (core logic exists; constraint = Chrome already running without the flag).
- Open: (1) workflow when Chrome already running — prompt restart with `--remote-debugging-port` vs 1-click JSON import; (2) password vault scope — full in-app storage (new master-password/safeStorage UI) vs merely importing Chrome's existing passwords (blocked by App-Bound v20 while Chrome runs).

Status: DONE