# Candidate D — Diagnostic Report

# Diagnostic Report: AntiFan Browser Desktop — Chrome Profile Sync Architecture & Extension-Removal Strategy
**Candidate:** D  
**Host Platform:** Windows 11 Pro x64 (Build 10.0.22000)  
**Target Environment:** Electron 43.4.0 / Chromium (`antifan-browser-desktop` v1.3.5, CJS)  
**Investigation Mode:** Strictly Read-Only Codebase Audit & Architectural Diagnosis

---

## Executive Summary

The reported instability (cookie loss, total cache absence, unpersisted passwords) is the confluence of **three fundamentally distinct failure paths**:
1. **Cookie Loss:** partition routing mismatch between Native Messaging handshake (`persist:capsule-default`) and standard browsing tabs (`persist:profile-default`), inert `syncProfile()` (zero cookie import), cross-browser logout propagation via delta removal sync, silent `--load-extension` failure when Chrome runs.
2. **Cache Loss:** complete absence of disk cache mirroring + unscoped `clearStorageData()` wiping session-wide.
3. **Password Gap:** architectural void — zero credential extraction/decryption/storage code; `enable-features=PasswordManager,Autofill` inert in Electron; Chrome 127+ App-Bound Encryption (v20) blocks external decryption.

The Companion Extension + native-messaging infra can be **safely eliminated** in favor of 100% offline local-first: CDP on-demand hydration, session vault JSON snapshots, local `safeStorage` credential encryption.

---

## (A) Root-Cause Report

### 1. Cookie Loss Root Cause & Evidence Chain

Data-flow diagram: Real Chrome → `chrome.cookies` → LocalIpcServer (`index.ts:321-331`) → handshake `activePartition = "persist:capsule-default"` → extension POST `/api/cookies/import { partition: "persist:capsule-default" }` → BridgeServer (`bridge-server.ts:489-498`) → `Session("persist:capsule-default")` — **[DISCONNECT GAP]** — Browser Tabs (`native-tab-host.ts:3064-3071`) → `Session("persist:profile-default")` → **[0 COOKIES FOUND / USER LOGGED OUT]**.

1. **Partition Routing Disconnect (Primary Mechanism):**
   - CONFIRMED `index.ts:321-331`: credentials callback resolves `activePartition = activeCapsule ? deriveCapsulePartition(activeCapsule.id) : deriveCapsulePartition('default')` → `"persist:capsule-default"`.
   - CONFIRMED `extension/background.js:984-985` & `src/extension/background.ts:59-61`: extension stores `activePartition` into `chrome.storage.local`.
   - CONFIRMED `background.js:1075` & `background.ts:163`: all pushes inject `partition: currentAuth.activePartition || payload.partition || undefined` → `"persist:capsule-default"`.
   - CONFIRMED `bridge-server.ts:489-498`: validates via `isValidCapsulePartition()` → `getPartitionSession(requestedPartition)`.
   - CONFIRMED `native-tab-host.ts:3064-3071`: standard tabs (toolbar, shortcuts, context menu, startup restore) never pass `isolateSession` → `getSharedProfilePartition(userAgentMode, isEphemeral)` (`native-tab-host.ts:2573-2575`) → **`persist:profile-default`**.
   - Verdict: cookies imported into `persist:capsule-default`, user browses in `persist:profile-default` — completely isolated Chromium sessions.
2. **Inert Toolbar / Menu Sync Button:**
   - CONFIRMED `chrome-profile-sync.ts:522-559`: `syncProfile()` only reads bookmarks + passive `targetSession.cookies.get({})` count. **Never imports cookies from Chrome.** 0-cookie note references Chrome 127+ v20. Sync action is an illusion.
3. **Destructive Delta Removal Synchronization:**
   - CONFIRMED `background.ts:106-116` & `background.js:1016-1025`: `onChanged` propagates removals when `cause === 'explicit'`.
   - CONFIRMED `bridge-server.ts:524-547`: executes `targetSession.cookies.remove(url, name)`.
   - Verdict: logout in Chrome / site clearing cookies on logout → immediate deletion in AntiFan.
4. **Silent Failure of `--load-extension` Under Running Chrome:**
   - CONFIRMED `chrome-profile-sync.ts:407-425`: `--load-extension` silently ignored when Chrome already running (single-process instance gate); returns `success:true` + warning; user believes sync active.

### 2. Cache Loss Root Cause & Evidence Chain

1. **Total Absence of Cache Ingestion Architecture:** zero lines touch/copy Chrome's disk cache (`Cache`, `Code Cache`, `GPUCache`). Chrome locks cache files (`ERROR_SHARING_VIOLATION`); addresses bound to Chrome binary version. AntiFan tabs always start cold.
2. **Session-Wide Cache Annihilation via Unscoped `clearStorageData()`:**
   - CONFIRMED `native-tab-host.ts:2388-2404` (full body quoted): `ses.clearStorageData({ storages: ['cookies','localstorage','cachestorage'] })` **without origin filter**.
   - CONFIRMED `renderer/toolbar.ts:1562-1565`: `clearStorage()` → toast `'Đã xóa Cookies & Cache của trang này'`.
   - Verdict: single click wipes cookies + localStorage + cache for every site across all tabs sharing `persist:profile-default`.

### 3. Password Gap Root Cause & Evidence Chain

1. **Architectural Void in Credential Persistence:** No SQLite reader for `Login Data`, no DPAPI/AES-GCM decryption, no import/export/storage manager anywhere in `src/main`, `src/extension`, `scripts`.
2. **Inert Chromium Feature Switch:** `index.ts:118` `enable-features=PasswordManager,Autofill` — Electron's Content Shell strips Chrome desktop UI: no Save bubble, no PasswordManagerClient, no settings page.
3. **Chrome 127+ App-Bound Encryption (v20):** master key in `Local State` (`os_crypt.app_bound_encrypted_key`) encrypted via SYSTEM-level `elevation_service.exe` validating caller binary; non-Chrome executables cannot decrypt; Extension API has no `chrome.passwords` access.

---

## (B) Rival-Hypothesis Elimination

**Cookie:**
| # | Hypothesis | Status | Evidence |
|---|---|---|---|
| 1.1 | Partition name mismatch (handshake vs tab) | **CONFIRMED (Primary)** | `index.ts:323-330` (`persist:capsule-default`) vs `native-tab-host.ts:3070` (`persist:profile-default`). |
| 1.2 | Expiration calculation bug revives/drops cookies | RULED OUT | `chrome-profile-sync.ts:78-92` & `smoke-google-cookies.cjs:47-59` — RFC-compliant; expired → null. |
| 1.3 | Host-only / `__Host-` rejection | RULED OUT (edge only) | `chrome-profile-sync.ts:74,159` strips domain for `__Host-`. |
| 1.4 | Bridge 10MB payload limit (413) | RULED OUT | 1,500 cookies ≈ 450KB « 10MB (`bridge-server.ts:414`). |
| 1.5 | Native messaging stdio framing overflow | RULED OUT | Extension never sends cookies over native messaging — handshake only (~120B JSON); cookies over HTTP loopback. |

**Cache:**
| # | Hypothesis | Status | Evidence |
|---|---|---|---|
| 2.1 | Unscoped `clearStorageData()` annihilation | **CONFIRMED (Primary)** | `native-tab-host.ts:2393`, no origin → whole partition. |
| 2.2 | Chrome cache ingestion failure (file lock) | RULED OUT (as cause) | Zero code reads Chrome cache; feature never built. |
| 2.3 | Electron disables HTTP disk cache on custom partitions | RULED OUT | `persist:` partitions allocate disk cache under userData/Partitions. |
| 2.4 | Ephemeral partition nonce mutation | RULED OUT (for standard tabs) | Standard tabs default `isEphemeral=false` (`native-tab-host.ts:3063`). |

**Password:**
| # | Hypothesis | Status | Evidence |
|---|---|---|---|
| 3.1 | Complete architectural omission | **CONFIRMED (Primary)** | Zero password code anywhere. |
| 3.2 | DPAPI/App-Bound decryption failure | RULED OUT | No decryption code exists. |
| 3.3 | Extension missing `passwords` permission | RULED OUT | Chrome has no extension password API. |
| 3.4 | Electron Chromium password manager broken | RULED OUT | Engine fine; Electron lacks UI delegate; flag inert. |

---

## (C) Extension-Removal Architecture

### 1. Capability Replacement Map

| Current Extension Function | Local/Offline Replacement | Implementation Details |
|---|---|---|
| Cookie Full Hydration (`chrome.cookies.getAll` via bridge) | **Direct Chrome CDP Extraction** (`Network.getAllCookies`) **+ Local Session Vault JSON file** | `LocalSessionVault.importFromLiveChromeCDP()`; fallback: Cookie-Editor JSON import. |
| Real-Time Delta Cookie Sync (`onChanged`) | **ELIMINATED BY DESIGN** (Decoupled Local Sessions) | Delta sync causes cross-browser logout contamination. Hydrate once; browse independently. |
| Native Messaging Handshake (`com.antifan.bridge`) | **ELIMINATED BY DESIGN** (Port-bound loopback protocol) | CDP directly via localhost WebSocket; no host/registry. |
| Bookmarks Synchronization | Direct JSON read (kept & hardened); **disable unsynchronized writes** | Remove `saveChromeBookmark` write-back race. |
| Password Persistence (nonexistent) | **Local SafeStorage Credential Vault** + 1-Click Chrome CSV Import | Electron `safeStorage` (DPAPI); CSV import. |

### 2. Concrete Component Deletion & Replacement Inventory

DELETE: `extension/`; `src/extension/`; `src/main/native-messaging/` (manifest-installer, local-ipc-server/client, host-runner, framing, windows-acl); `bin/antifan-bridge-host.exe`; `scripts/build-extension.mjs`; `smoke-native-messaging-packaged.mjs`; native-messaging e2e/ipc tests.
REPLACE/REFACTOR:
- `chrome-profile-sync.ts`: remove `launchChromeWithCompanionExtension`, `openExtensionFolderAndGuide`, `saveChromeBookmark`, `removeChromeBookmark`; rewire `syncProfile()` → `importFromLiveChromeCDP` into active tab session; harden `getChromeBookmarks` read-only.
- `local-session-vault.ts`: primary session hydration manager; target `persist:profile-${safeProfileKey}`.
- `native-tab-host.ts`: fix `clearStorageForActiveTab()` → origin-scoped (`new URL(url).origin`); remove obsolete IPC handlers.
- `index.ts`: remove LocalIpcServer startup + `installNativeHost()` (lines 317-342); add registry cleanup on start.

### 3. CDP Security Risk Analysis & Mitigations
| Threat | Risk | Mitigation |
|---|---|---|
| Local port hijacking (read all cookies / inject code) | High | Ephemeral random port (38400-45000); `--remote-allow-origins=http://127.0.0.1:<port>`; close-on-complete (disconnect WS + close debug connection after extraction). |
| Running-Chrome conflict (flag ignored) | High | Probe `http://127.0.0.1:<port>/json/version` first; prompt modal (restart Chrome with CDP or JSON import fallback). |
| Network attack surface | Low | Chromium binds `--remote-debugging-port` to loopback only; enforce loopback check. |

### 4. Migration & Rollback Strategy
1. Registry cleanup: `reg.exe delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.antifan.bridge" /f` (+ Edge, Brave).
2. Unified vault migration: dump all sessions to `%LOCALAPPDATA%\AntiFan\config\session-vault.json` via `exportVaultToFile()` first.
3. Rollback: vault JSON (name/value/domain/path/secure/httpOnly/sameSite/expirationDate) is portable; `importVaultFromFile()` restores in any version.

---

## (D) Verification Plan (Concrete Windows Probes)

Probe 1 — partition routing integrity:
```powershell
node -e "const { deriveCapsulePartition } = require('./.compiled/src/main/browser/browser-session-partition.js');
console.log('Tab Partition:', 'persist:profile-default');
console.log('Handshake Partition:', deriveCapsulePartition('default'));
// expect mismatch → [VERIFIED DEFECT]"
```
Probe 2 — origin-scoped clearStorageData: set `g_user` on google.com + `h_shop` on haravan.com in one partition; `clearStorageData({origin:'https://google.com',storages:['cookies']})`; expect `h_shop` survives, `g_user` gone (current codebase fails: no origin).
Probe 3 — CDP extraction: `start chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\antifan-chrome-test" https://google.com`; `curl http://127.0.0.1:9222/json/version`; run `importFromLiveChromeCDP`; count cookies.
Probe 4 — existing suites: `npm run smoke:persistence`; `npm run smoke:google`.

## (E) Confidence Notes & Open Questions

1. `persist:` vs ephemeral — CONFIRMED (`browser-session-partition.ts:18-34`, `native-tab-host.ts:2564-2576`).
2. `bridgeAuth.activePartition` provenance — CONFIRMED (`index.ts:323-330` → host → extension → POST payload).
3. `clearStorageData`/`clearCache` callers — CONFIRMED: sole caller `native-tab-host.ts:2393` via toolbar IPC; no origin → wipes all tabs.
4. `safeStorage` — CONFIRMED 0 occurrences.
5. Password save — CONFIRMED 0 occurrences.
- Open: multi-profile concurrency; password vault scope (A: internal safeStorage vault vs B: 1Password/Bitwarden/CSV); 30-day session elevation policy.

Status: DONE