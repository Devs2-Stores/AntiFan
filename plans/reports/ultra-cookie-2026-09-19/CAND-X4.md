# ULTRA IMPLEMENTATION PLAN: COOKIE, CACHE & SESSION MECHANISM (CANDIDATE 3)

**Packet ID:** `ultra-cookie-2026-09-19`  
**Candidate Index:** 3 of 5  
**Target Root:** `E:\Work\apps\AntiFan` (Electron 43.4.0, TypeScript -> `.compiled/`, Windows 11)  
**Evidence Baseline:** `plans/reports/260919-cookie-cache-ultra-packet.md` & `docs/research-cache-cookie-mechanism.md`  

---

## 1. Chosen Organizing Insight

- **Selected Technique (`ak:problem-solving`):** `simplification cascades`
- **One-line Symptom-to-Technique Match:** The multi-faceted breakdown across three reported symptoms ("rất nhanh hết, lúc ăn lúc không, không đồng bộ được") is not three disjoint bugs, but a combinatorial cascade stemming from a single false assumption: that the *transient visual tab* is the authority for *persistent session identity*.
- **The Organizing Insight:** **Decouple Session Identity from View Focus**. Replace ambient, view-coupled session resolution (`getActiveTabSession()`) with an explicit, sovereign profile session resolver (`resolveTargetProfileSession(profileId)`). By anchoring every sync, vault, and persistence operation to an explicit canonical profile (`persist:profile-<profileId>`) and establishing a fail-closed rejection boundary against in-memory (`ephemeral-*`) and isolated (`persist:capsule-*`) partitions, all disparate failure modes collapse:
  1. *Lúc ăn lúc không* vanishes because cookies are never accidentally injected into ephemeral RAM jars or isolated capsule jars.
  2. *Rất nhanh hết* vanishes because all tabs in a profile share the single canonical on-disk SQLite jar, and page-set cookies are debounced to disk within 1000ms rather than held in volatile memory until graceful exit.
  3. *Không đồng bộ được* is replaced with truthful, deterministic execution: the UI stops attempting impossible App-Bound Encryption (v20) clones, guards against foreign CDP port traps (port 9222), and directs users to verified import paths (Cookie-Editor JSON or native AntiFan login).
  4. The 86-store sprawl is halted and permanently pruned because dead namespaces are eliminated at the source and cleaned under live-tab guards.

---

## 2. Ordered Phases

### Phase 1: Canonical Target-Session Resolver & Entry Point Cutover (P0 — Fixes "Lúc ăn lúc không", AC1, AC2, AC3)
- **Goal:** Eliminate view-coupled session targeting across all Sync and Vault entry points, preventing any cookie write into ephemeral or capsule partitions.
- **Files & Symbols Changed:**
  - `src/main/browser/native-tab-host.ts:3528-3532`: Introduce `resolveTargetProfileSession(profileId?: string, userAgentMode?: BrowserSessionUserAgentMode): Electron.Session`. Resolves strictly to `persist:profile-<safeProfileKey>`, configuring the partition. Rejects ephemeral/capsule derivation.
  - `src/main/browser/native-tab-host.ts:3455-3461`: Deprecate and neutralize `getActiveTabSession()`. Remove all callsites from cookie pathways.
  - `src/main/browser/native-tab-host.ts:2894-2896`: In `showMainMenu()` (toolbar menu sync), replace `this.getActiveTabSession()` with `this.resolveTargetProfileSession(p.id)`.
  - `src/main/browser/tab-context-menu.ts:13, 271-273`: In `TabContextMenuHost` interface and context menu click handler, replace `this.host.getActiveTabSession()` with `this.host.resolveTargetProfileSession(p.id)`.
  - `src/main/browser/app-menu.ts:194-196`: Ensure app menu sync uses `tabHost?.resolveTargetProfileSession(p.id)`.
  - `src/main/browser/app-menu.ts:212-216`: In Vault Export menu item, replace `tabHost?.getActiveTabSession()` with `tabHost?.resolveTargetProfileSession()`.
  - `src/main/browser/app-menu.ts:227-231`: In Vault Import menu item, replace `tabHost?.getActiveTabSession()` with `tabHost?.resolveTargetProfileSession()`.
  - `src/main/browser/native-tab-host.ts:1300-1325`: In `LocalSessionVault.registerIpcHandlers`, restrict session resolution: if `options?.tabId` points to an ephemeral or capsule tab, reject with `TARGET_SESSION_INVALID`. Fall back solely to `resolveTargetProfileSession(options?.profileId)`.
  - `src/main/browser/local-session-vault.ts:115-145, 180-285`: In `exportVaultToFile` and `importVaultFromJson`, add runtime assertions inspecting session partition via `getSessionPartition(targetSession)`: if partition starts with `ephemeral-`, reject immediately with `EPHEMERAL_TARGET_REJECTED`. In export, if `liveCookies.length === 0`, reject with `EMPTY_STORE_REJECTED`. In import, if parsed cookies count === 0 or `importedCount === 0`, reject with `EMPTY_IMPORT_REJECTED` / `ZERO_COOKIES_IMPORTED`. Report `targetJar` in all return payloads.
- **Risk Retired:** Zero probability of writing persistent cookies into volatile in-memory storage or unreachable isolated capsules.
- **Explicit Non-Goals:** Do not alter `deriveCapsulePartition` for workspaces requiring genuine isolation.

### Phase 2: Per-Partition Cookie Durability & Shutdown Reporting (P0 — Fixes "Rất nhanh hết", AC7)
- **Goal:** Ensure cookies set by web pages and scripts survive unexpected crashes and hard kills (`taskkill /F`), and fix the inaccurate `prevCleanShutdown: false` boot reporting.
- **Files & Symbols Changed:**
  - `src/main/browser/browser-session-partition.ts:65-115`: In `configureBrowserSessionPartition(partition, mode)`:
    - Track session in `partitionBySession = new WeakMap<Session, string>()`.
    - If `partition.startsWith('persist:')`, attach a debounced cookie-change listener:
      ```ts
      if (sess?.cookies && typeof sess.cookies.on === 'function') {
        let flushTimer: NodeJS.Timeout | null = null;
        sess.cookies.on('changed', () => {
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = setTimeout(() => {
            flushTimer = null;
            void sess.cookies.flushStore().catch(() => {});
          }, 1000);
        });
      }
      ```
  - `src/main/browser/profile-ownership.ts:285-325`: In `ProfileOwnership.acquire()`, store the predecessor's clean shutdown state (`priorCleanShutdown = recovery.cleanShutdown`) before overwriting `startedRecovery.cleanShutdown = false`. Expose `priorCleanShutdown` on the returned lease.
  - `src/main/index.ts:636-645`: In `boot.profile` lifecycle event, log `prevCleanShutdown: profileLease.priorCleanShutdown` instead of the newly initialized `profileLease.recovery.cleanShutdown`.
- **Risk Retired:** Process kills (`taskkill /F`) lose at most 1000ms of cookie mutations instead of an entire session. False crash telemetry eliminated.
- **Explicit Non-Goals:** Do not flush ephemeral sessions to disk; do not perform synchronous disk flushes on the Chromium UI thread.

### Phase 3: Chrome-Sync Truthful Handling & Foreign-Port Protection (P1 — Fixes "Không đồng bộ được", AC2, AC3)
- **Goal:** Provide truthful user guidance on Chrome ≥127 App-Bound Encryption (v20), protect CDP from hijacking by external Chrome instances (port 9222), and enforce Google token sovereignty.
- **Files & Symbols Changed:**
  - `src/main/browser/chrome-profile-sync.ts:445-515`:
    - In `hydrateCookiesViaOwnedChrome`, clarify the return message when 0 cookies are returned due to ABE v20: inform the merchant that Chrome encrypts cookies with machine-bound keys, and guide them to use "Cookie-Editor -> Export JSON -> Session Vault Restore" or direct login inside AntiFan.
    - Validate profile directory path before spawning headless Chrome: verify `Local State` and target profile folder exist.
  - `src/main/browser/local-session-vault.ts:300-345`:
    - In `importFromLiveChromeCDP(targetSession, cdpPort)`: check `%LOCALAPPDATA%/Google/Chrome/User Data/DevToolsActivePort`. If the port does not match the user's authentic Chrome User Data directory (e.g. hijacked by `CodexRemote9222`), reject with `FOREIGN_CDP_PORT_REJECTED`.
  - `src/main/browser/native-tab-host.ts:1416-1435`:
    - Ensure `TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE` passes explicit `profileId` directly into `resolveTargetProfileSession(profileId)`, updating `bookmarks` and broadcasting state without ambient tab dependency.
- **Risk Retired:** Prevents user confusion from silent 0-cookie syncs; prevents accidental connection to empty foreign CDP profiles.
- **Explicit Non-Goals:** Do not attempt offline SQLite decryption of DPAPI/App-Bound encrypted rows (impossible and causes Chromium to purge tables).

### Phase 4: Guarded Dead-Store Cleaner & Housekeeping (P1 — Reclaims 8,76 MB + 219 MiB Cache, AC5, AC6)
- **Goal:** Safely and idempotently remove 84 orphaned cookie stores, abandoned default cache, duplicate state files, and temporary leftover files.
- **Files & Symbols Changed:**
  - `src/main/browser/dead-store-cleaner.ts` (NEW MODULE): Implement `pruneDeadStores(options: { dryRun?: boolean, tabHost: NativeTabHost }): Promise<CleanupReport>`.
    - Targets:
      1. Dead partitions in `<userData>/Partitions/` matching strict regex: `/^(capsule-capsule-[a-f0-9-]+|profile-capsule-[a-f0-9-]+)$/`.
      2. Abandoned default cache `<userData>/Cache` (~219 MiB).
      3. Stale duplicate state file `<dataRoot>/config/saved-tabs.json`.
      4. Orphan temporary files `<userData>/saved-tabs.json.tmp.*`.
    - Guards:
      - Live Tab Check: Cross-checks each candidate against all active tabs (`tab.state.partition`). If a tab uses the partition, deletion is skipped.
      - Whitelist regex prevents touching `profile-profile-*`, `profile-default`, or standard profiles.
      - Path containment check: asserts target path is strictly within `<userData>/Partitions`.
  - `src/main/index.ts:196-198, 211`:
    - Remove `app.commandLine.appendSwitch('disk-cache-dir', StorageLocations.getNetworkCacheDir());` which creates an unused 0-byte directory. Retain `--disk-cache-size` and document per-partition cache locations.
  - `src/main/index.ts:520-535`: Trigger `pruneDeadStores` during post-startup idle housekeeping (unblocking UI).
- **Risk Retired:** Reclaims ~228 MB of disk space and removes 25,756 dead cookies without risk of data loss on active tabs.
- **Explicit Non-Goals:** Do not run uncoordinated shell commands (`rmdir /s /q`); do not touch active profile directories (`profile-profile-2`).

### Phase 5: Migration Target Realignment & Pure Function Hardening (P2 — AC4)
- **Goal:** Correct the dead-end migration function so it cannot produce unreachable `profile-capsule-*` partitions, while keeping existing pure unit test contracts 100% green.
- **Files & Symbols Changed:**
  - `src/main/browser/capsule-partition-migration.ts:92-93`:
    - Update target derivation:
      ```ts
      // Strip redundant 'capsule-' prefixes so capsule-capsule-<id> maps cleanly to profile-<id>
      const cleanKey = key.replace(/^(capsule-)+/, '');
      const target = `persist:profile-${cleanKey}`;
      ```
    - Preserves single-prefix mapping (`capsule-a` -> `persist:profile-a`), satisfying unit test `test/main/capsule-partition-migration-pure.test.ts`.
    - If `target === legacy`, skip safely.
  - `src/main/browser/native-tab-host.ts:3535-3580`: Maintain the existing marker file gate (`antifan-migration-capsule-to-profile.done`). When the marker exists, return immediately `{ migrated: 0, legacyPartitions: [] }`.
- **Risk Retired:** Eliminates creation of orphaned partition namespaces during future migrations.
- **Explicit Non-Goals:** Do not delete legacy partitions inside the migration loop (deletion belongs strictly to Phase 4 guarded cleaner).

### Phase 6: Comprehensive Verification & Acceptance Suite (AC1–AC8)
- **Goal:** Validate all acceptance criteria with targeted regression and integration tests.
- **Files Changed:** `test/main/target-session-resolver.test.ts` (NEW), `test/main/dead-store-cleaner.test.ts` (NEW), `test/main/local-session-vault.test.ts` (UPDATED).

---

## 3. Target-Session Contract

### 3.1 Proposed Single Resolver API
- **Location:** `src/main/browser/native-tab-host.ts` (with helper in `src/main/browser/browser-session-partition.ts`)
- **Method Signature:**
  ```ts
  public resolveTargetProfileSession(
    profileId?: string,
    userAgentMode: BrowserSessionUserAgentMode = 'clean'
  ): Electron.Session
  ```
- **Contract Specifications:**
  1. **Deterministic Target:** Derives partition via `this.getSharedProfilePartition(userAgentMode, false, profileId)`. Output partition ALWAYS matches `persist:profile-<safeProfileKey>`.
  2. **Non-Ambient / Anti-Focus:** Completely ignores `this.activeTabId` and `this.tabs`. Focused tab state (whether ephemeral, offscreen, or capsule) has zero influence on the returned session.
  3. **Explicit Profile Fallback:** If `profileId` is omitted, defaults strictly to `ChromeProfileSyncManager.getInstance().activeProfileId ?? 'Default'`, sanitized to lowercase alphanumeric.
  4. **Partition Configuration:** Automatically invokes `configureBrowserSessionPartition(partition, userAgentMode)`, registering the session in `partitionBySession` and arming debounced durability.
  5. **Session Verification:** Asserts that the derived partition starts with `persist:profile-`. Throws a fail-closed `Error('TARGET_SESSION_INVALID: Ephemeral or capsule target prohibited')` if violated.

### 3.2 Forcing All Entry Points Through the Resolver
- **Sync Point 1 (`app-menu.ts:195`):** Passes `tabHost?.resolveTargetProfileSession(p.id)`.
- **Sync Point 2 (`native-tab-host.ts:2895`):** Passes `this.resolveTargetProfileSession(p.id)`.
- **Sync Point 3 (`tab-context-menu.ts:272`):** Passes `this.host.resolveTargetProfileSession(p.id)`.
- **Vault Export (`app-menu.ts:213`):** Passes `tabHost?.resolveTargetProfileSession()`.
- **Vault Import (`app-menu.ts:228`):** Passes `tabHost?.resolveTargetProfileSession()`.
- **IPC Vault Handlers (`native-tab-host.ts:1300-1325`):** Restricts the `getSessionFn` callback to invoke `resolveTargetProfileSession(options?.profileId)`. If an explicit `tabId` is requested by an agent, it verifies that the tab's partition is NOT ephemeral or capsule before granting access.

---

## 4. Durability Strategy

### 4.1 Surviving Process Termination (`taskkill /F` / Crash)
- **Problem:** Chromium's cookie store persists cookies in SQLite asynchronously. In AntiFan, `flushStore()` was previously called only during clean shutdown (`NativeTabHost.flushAllSessions()`). Hard process kills lost all cookies set during the active run.
- **Flush Policy:** **Debounced Reactive Flush (Trailing-Edge 1000ms)**:
  - Installed in `configureBrowserSessionPartition` on all `persist:` partitions.
  - Listens to `session.cookies.on('changed', (event, cookie, cause, removed) => ...)`.
  - When a cookie change event fires (from HTTP responses, `document.cookie`, or import operations), a 1000ms timer is set. Subsequent mutations reset the timer.
  - On timeout expiration, `session.cookies.flushStore()` commits all pending WAL journal frames to SQLite on disk.
- **Cost Analysis:**
  - *CPU/IO Impact:* Negligible. 1000ms debounce collapses burst operations (e.g. page loading 50 cookies) into exactly 1 SQLite commit.
  - *Memory:* A single timer handle per partition (< 100 bytes).
  - *Latency:* Asynchronous background thread operation in Chromium network service; zero main-process event loop blocking.
- **Session Cookie Durability:**
  - Cookies imported through Session Vault or Extension Bridge receive an explicit 30-day fallback expiration date via `extensionCookieImportSetDetails` (`options.persistSessionCookies: true`).
  - Chromium treats them as persistent cookies on disk, ensuring they survive process restarts.

---

## 5. Chrome-Sync Strategy

### 5.1 Reality under App-Bound Encryption (v20)
- On Windows with Chrome ≥127, cookies in Chrome's `Network/Cookies` SQLite DB are encrypted using an OS App-Bound key bound to `chrome.exe`.
- Cloning the profile directory into a temp directory and launching headless Chrome with `--user-data-dir=<tempDir>` fails because the ABE key cannot be decrypted outside the authentic Chrome install context. Chromium returns 0 cookies and purges undecryptable rows.
- **Permitted Chrome Sync Capabilities:**
  1. **Bookmarks:** Direct read of `User Data/<Profile>/Bookmarks` (plain JSON). 100% reliable, zero encryption barriers.
  2. **Active Remote Debugging:** If the user intentionally starts their primary Chrome with `--remote-debugging-port=<port>`, cookies can be read via CDP if port is authenticated.

### 5.2 UI Feedback & Refusal Contracts
- When Chrome Sync returns 0 cookies, the app must NOT display a generic "Sync successful" message.
- Dialog explicitly states:
  > *"Chrome trả về 0 cookie do App-Bound Encryption (v20) trên Windows 11. App không thể sao chép trực tiếp cookie từ Chrome đang đóng.*  
  > *Giải pháp đề xuất:*  
  > *1. Sử dụng tiện ích Cookie-Editor trên Chrome -> Export JSON -> Chọn '📥 Khôi phục Session Vault' trong menu AntiFan.*  
  > *2. Hoặc đăng nhập trực tiếp trên AntiFan (phiên làm việc sẽ được lưu bền vững trên đĩa)."*

### 5.3 Mitigating the Port-9222 Foreign-Chrome Trap
- On developer workstations, external tools (e.g. OpenAI Codex extension) may run Chrome with `--remote-debugging-port=9222` using an isolated user data directory (`Chrome/User Data/CodexRemote9222`).
- **Guard Mechanism:**
  - Before connecting to port 9222, `LocalSessionVault` probes `http://127.0.0.1:9222/json/version`.
  - Validates that the active Chrome instance corresponds to the user's primary Chrome installation by checking for `DevToolsActivePort` inside `ChromeProfileSyncManager.getInstance().chromeUserDataPath`.
  - If `DevToolsActivePort` is absent in the target profile directory, AntiFan refuses automatic CDP connection with `FOREIGN_CDP_PORT_REJECTED`.

### 5.4 Sovereign Google Session Handling
- Google rotating cookies (`__Secure-1PSIDTS`, `__Secure-3PSIDTS`, `*PSIDRTS`) have short TTLs (minutes) and are single-client bound.
- AntiFan profile partitions are treated as sovereign browser sessions. Once logged in inside AntiFan, the app maintains its own tokens and user-agent client hints without colliding with or copying tokens from an active external Chrome.

---

## 6. Cleanup Mechanism

### 6.1 Target Inventory
The cleanup module targets 84 dead stores (~8.76 MB, 25,756 cookies) and abandoned cache files:
1. `43 × Profile/Partitions/capsule-capsule-<uuid>` (legacy isolated capsules).
2. `41 × Profile/Partitions/profile-capsule-capsule-<uuid>` (unreachable migration outputs).
3. `1 × Profile/Cache` (~219 MiB abandoned default partition cache).
4. `1 × config/saved-tabs.json` (stale 394B duplicate from Aug 31).
5. `Profile/saved-tabs.json.tmp.*` (orphan temporary write files).

### 6.2 Implementation & Guards (`src/main/browser/dead-store-cleaner.ts`)
```ts
export interface CleanupReport {
  scannedCount: number;
  deletedPartitions: string[];
  skippedPartitions: string[];
  deletedFiles: string[];
  reclaimedBytes: number;
  dryRun: boolean;
}

export async function pruneDeadStores(
  options: { dryRun?: boolean; tabHost: NativeTabHost; dataRoot?: string }
): Promise<CleanupReport>
```

**Guard Invariants:**
1. **Live Tab Conflict Check:** Queries `tabHost.tabs`. Extracts all active partitions (`tab.state.partition`). If an active tab uses `persist:<dirName>`, the directory is skipped immediately and recorded in `skippedPartitions`.
2. **Whitelist Regex Enforcement:** Only directory names strictly matching `/^(capsule-capsule-[a-f0-9-]+|profile-capsule-[a-f0-9-]+)$/` are considered. Standard profiles (`profile-profile-2`, `profile-default`) are mathematically impossible to match.
3. **Path Containment Assertion:** Computes `path.resolve(targetDir)`. Asserts `targetDir.startsWith(path.join(profileDir, 'Partitions'))`. Any path traversal attempt throws immediately.
4. **Dry-Run Certification:** In dry-run mode (`dryRun: true`), files and directories are measured and reported without disk modification.

### 6.3 Idempotence Proof
- **Run 1:** Scans `<userData>/Partitions/`, detects 84 matching directories, confirms 0 live tab conflicts, deletes all 84 directories and stale cache/temp files. Returns `reclaimedBytes ~ 237 MB`.
- **Run 2:** Scans `<userData>/Partitions/`, evaluates 0 matching directories. Returns `deletedPartitions: [], reclaimedBytes: 0`.
- **Run N:** Continues to return `deletedPartitions: []`, performing 0 disk mutations. Fully idempotent.

---

## 7. Test Plan Mapped to AC1–AC8

| Acceptance Criteria | Test File & Location | Test Description & Assertion | Existing Test Assertion Changed |
|---|---|---|---|
| **AC1: Ephemeral/Capsule Write Rejection** | `test/main/target-session-resolver.test.ts` (NEW) & `test/main/local-session-vault.test.ts` | Pass an ephemeral session (`ephemeral-profile-...`) and capsule session (`persist:capsule-...`) to `LocalSessionVault.exportVaultToFile` and `importVaultFromJson`. Assert both return `{ success: false, error: 'EPHEMERAL_TARGET_REJECTED' }`. | None. New negative security assertions. |
| **AC2: Profile-Bound Target Resolution** | `test/main/target-session-resolver.test.ts` (NEW) | Set `activeTabId` to an ephemeral tab. Invoke `resolveTargetProfileSession()`. Assert resolved session partition is `persist:profile-<activeProfileId>`, NOT the focused tab's partition. Verify all 3 Sync entry points and 2 Vault entry points route through this method. | None. Verifies refactored entry points. |
| **AC3: Empty Store / Zero Cookie Rejection** | `test/main/local-session-vault.test.ts:121` | Call `exportVaultToFile` on an empty cookie store -> assert `{ success: false, error: 'EMPTY_STORE_REJECTED' }`. Call `importVaultFromJson` with `[]` -> assert `{ success: false, error: 'EMPTY_IMPORT_REJECTED' }`. Verify `targetJar` is populated in return payload. | **YES**: In `test/main/local-session-vault.test.ts:121-128`, the test `'imports empty cookie array with success true and zero count'` asserted `res.success === true`. Updated to assert `res.success === false, res.error === 'EMPTY_IMPORT_REJECTED'`. |
| **AC4: Pure Migration Reachability** | `test/main/capsule-partition-migration-pure.test.ts` | Feed `capsule-capsule-uuid` and `capsule-a` into `runCapsuleToProfileMigration`. Assert `deps.__writeTargets` maps to reachable `persist:profile-uuid` and `persist:profile-a`, never `profile-capsule-*`. Marker gate verified. | Retains existing assertions for `capsule-a` -> `persist:profile-a`. Adds multi-prefix regression case. |
| **AC5: Guarded Dead-Store Cleanup** | `test/main/dead-store-cleaner.test.ts` (NEW) | Create mock directory containing `capsule-capsule-1`, `profile-capsule-2`, and `profile-profile-2`. Mock active tab on `persist:capsule-capsule-1`. Run cleaner: assert `capsule-capsule-1` is skipped; `profile-capsule-2` is deleted; `profile-profile-2` untouched. Run second time: assert 0 deletions. | None. New unit test suite. |
| **AC6: Cache Configuration Truth** | `test/main/cache-configuration.test.ts` (NEW) | Assert app command line switch inventory: `--disk-cache-dir` is removed; per-partition cache paths verified; abandoned `Profile/Cache` directory cleaned. | None. Verifies switch list. |
| **AC7: Cookie Durability on Hard Kill** | `test/main/session-durability.test.ts` (NEW) | Simulate cookie change event on `persist:` partition: assert `cookies.flushStore` is invoked after 1000ms debounce. In smoke test, launch app, set cookie, execute hard kill (`taskkill /F`), relaunch, assert cookie is read back. | None. New persistence regression test. |
| **AC8: Pre-fix Reproduction Proof** | Repro script `test/repro-cookie-loss.ts` | Test script reproduces cookie loss when targeting active ephemeral tab and process kill. Fails pre-fix; passes post-fix. | None. |

---

## 8. Risk Register

| # | Risk Description | Detection Signal | Prevention / Mitigation Mechanism |
|---|---|---|---|
| **R1** | Accidental deletion of a partition holding active user data during dead-store cleanup. | Cleaner log outputs a folder name not matching whitelist regex; or tab session reports missing cookies. | Triple guards: strict regex whitelist `^(capsule-capsule-[a-f0-9-]+|profile-capsule-[a-f0-9-]+)$`, live-tab cross-referencing, and path containment check. |
| **R2** | Breaking intentional capsule isolation (`isolateSession: true`) by over-unifying partitions. | Existing tests `capsule-partition-cookie-isolation.test.ts` or `workspace-capsule.test.ts` fail. | `deriveCapsulePartition` and `isolateSession` logic for workspace capsules remain strictly intact. Only shared profile tabs and sync pathways are unified. |
| **R3** | Disk IO thrashing or UI event-loop lag caused by excessive `flushStore()` calls. | High disk write throughput or dropped frames during rapid navigation. | 1000ms trailing-edge debounce timer batches multiple cookie changes into a single asynchronous background SQLite flush. |
| **R4** | User confusion when Chrome Sync returns 0 cookies due to Windows App-Bound Encryption (v20). | User reports "Sync does nothing" or repeatedly clicks Sync menu items. | Modal dialog with clear, educational Vietnamese text explaining ABE v20 and providing direct actionable alternatives (Cookie-Editor JSON or AntiFan login). |
| **R5** | Concurrency race condition during profile switching where `activeProfileId` mutates during an in-flight sync. | Sync operation writes Profile A cookies into Profile B cookie store. | Explicit `profileId` parameter is passed end-to-end through `resolveTargetProfileSession(profileId)` and `syncProfile(profileId, session)`, decoupling execution from mutable global state. |

### Deliberate Non-Actions (What Was NOT Done)
1. **Did NOT attempt offline SQLite decryption of App-Bound Encryption (v20):** Proven technically impossible without Google Chrome's private service-worker keys; Chromium explicitly purges undecryptable database rows.
2. **Did NOT rewrite the four-partition family model:** Kept the existing architecture (shared, capsule, ephemeral, default) intact; fixed targeting and durability instead of destabilizing working subsystems.
3. **Did NOT weaken or delete existing partition tests:** Every contract in `.compiled/test/main/*` is preserved; only line 121 in `local-session-vault.test.ts` is explicitly tightened to reject empty imports per AC3.
4. **Did NOT implement background syncing of Google rotating cookies (`*PSIDTS`):** Copying rotating tokens across two concurrent clients causes mutual session invalidation. AntiFan acts as a sovereign client.
5. **Did NOT add any external npm dependencies:** Zero-dependency addition, relying exclusively on Node.js and Electron core APIs.

---

## 9. Effort, Order of Execution & Minimal Viable Cutover

### Execution Order
1. **Day 1 (Morning): Phase 1 — Target-Session Resolver Cutover** (P0, ~2 hours)
   - Implement `resolveTargetProfileSession` in `native-tab-host.ts`.
   - Update 3 Sync entry points and 2 Vault entry points.
   - Add ephemeral/empty guards in `local-session-vault.ts`.
   - Update line 121 in `test/main/local-session-vault.test.ts`. Run `npm run test:file test/main/local-session-vault.test.ts`.
2. **Day 1 (Afternoon): Phase 2 — Cookie Durability & Shutdown Telemetry** (P0, ~2 hours)
   - Add debounced `flushStore` listener in `browser-session-partition.ts`.
   - Fix `priorCleanShutdown` reporting in `profile-ownership.ts` and `index.ts`.
   - Run `npm run smoke:persistence`.
3. **Day 2 (Morning): Phase 3 — Chrome-Sync ABE v20 Messaging & Port 9222 Guard** (P1, ~2 hours)
   - Add DevToolsActivePort guard and informative dialogs in `chrome-profile-sync.ts`.
4. **Day 2 (Afternoon): Phase 4 & 5 — Dead-Store Cleaner & Migration Target Fix** (P1/P2, ~3 hours)
   - Implement `dead-store-cleaner.ts`. Test in dry-run mode on host; execute guarded cleanup.
   - Adjust `capsule-partition-migration.ts:92-93` regex. Run `npm run test:file test/main/capsule-partition-migration-pure.test.ts`.
5. **Day 3 (Morning): Phase 6 — Full Verification & Acceptance Checks** (~2 hours)
   - Run `npm run compile`, `npm run test:main`, `npm run test:unit`.

### Minimal Viable Cutover (If Only Phases 1 & 2 Shipped)
If constrained to shipping only two phases, **ship Phase 1 and Phase 2 immediately**.
- **Rationale:** Phase 1 permanently stops cookies from being routed to ephemeral RAM or isolated capsule jars (retiring "lúc ăn lúc không"). Phase 2 guarantees that page-set cookies and imported session cookies are flushed to disk within 1000ms (retiring "rất nhanh hết").
- These two phases directly solve the user's primary daily pain points with minimal code footprint and zero data loss risk. Subsequent cleanup and messaging phases can follow safely without blocking core session reliability.