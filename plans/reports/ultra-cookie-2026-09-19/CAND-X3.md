# IMPLEMENTATION PLAN: AntiFan Desktop Browser Session/Cookie Architecture Fix
**Candidate Index:** 5 of 5  
**Packet Reference:** `plans/reports/260919-cookie-cache-ultra-packet.md` (`ultra-cookie-2026-09-19`)  
**Repo Root:** `E:\Work\apps\AntiFan` (Electron 43.4.0, TypeScript, Windows 11)  

---

## 1. Chosen Organizing Insight

- **Selected ak:problem-solving technique:** `simplification cascades`
- **One-line symptom-to-technique match:** The three user symptoms ("rất nhanh hết", "lúc ăn lúc không", "không đồng bộ được từ Chrome") cascade directly from ambient focus-dependent target resolution across 3 decoupled menus, 86 fragmented partition jars, and un-flushed memory buffers; simplifying target authority into a single canonical resolver and active debounced store-flush collapses the entire failure domain.
- **Organizing Insight:**
  The root defect across all symptoms is **Ambient Authority & Deferred Durability**. The system currently treats the *currently focused tab* as the ambient destination for profile-level cookie mutations (`native-tab-host.ts:2895`, `tab-context-menu.ts:272`, `app-menu.ts:215,230`), allowing in-memory/ephemeral jars (`ephemeral-profile-*`) to silently swallow imported logins that vanish when the tab closes. Simultaneously, disk persistence is deferred entirely to graceful shutdown (`tabHost.flushAllSessions`), leaving page-set logins to die on any crash or hard kill (`prevCleanShutdown: false`). By collapsing all profile sync, vault, and fallback routing into a single immutable, non-ambient **Target-Session Resolver** (`resolvePersistentProfileSession`), attaching an active debounced (2000ms) `cookies.on('changed')` flush policy to persistent profile sessions, surfacing Windows App-Bound Encryption (v20) constraints honestly in the UI, and running a triple-guarded idempotent dead-store purge, we resolve all 10 verified forensic findings without introducing any new runtime dependencies or altering capsule isolation semantics.

---

## 2. Ordered Phases

### Phase 1: Single Target-Session Resolver & Menu Harmonization
- **Goal:** Eliminate ambient focused-tab session selection. Force all Chrome profile sync and Vault operations to target the explicit persistent profile partition (`persist:profile-*`).
- **Files & Symbols to Change:**
  - `src/main/browser/native-tab-host.ts:3445-3620`: Add public method `resolvePersistentProfileSession(profileId?: string, mode?: BrowserSessionUserAgentMode): Electron.Session`.
  - `src/main/browser/native-tab-host.ts:2885-2915`: In `showMainMenu()` (toolbar menu, line 2895), change `this.getActiveTabSession()` to `this.resolvePersistentProfileSession(p.id)`.
  - `src/main/browser/tab-context-menu.ts:265-290`: In `showMainMenu()` (context menu, line 272), change `this.host.getActiveTabSession()` to `this.host.resolvePersistentProfileSession(p.id)`.
  - `src/main/browser/app-menu.ts:185-250`: In Session Vault Export (line 215) and Import (line 230), change `tabHost?.getActiveTabSession()` to `tabHost?.resolvePersistentProfileSession()`.
  - `src/main/browser/native-tab-host.ts:1300-1345`: In `LocalSessionVault` IPC handler options fallback, route ambient requests strictly through `this.resolvePersistentProfileSession()`, never `this.getTabSession(tabId)` unless explicit authorized `tabId` is supplied by an internal agent.
  - `src/main/browser/native-tab-host.ts:3449-3452`: In `getTabSession(tabId)`, replace fallback `session.defaultSession` with `this.resolvePersistentProfileSession()`.
- **Code-level Changes:**
  `resolvePersistentProfileSession` validates that the computed partition begins with `persist:profile-`. It throws a fail-closed error if an ephemeral (`ephemeral-*`), capsule (`persist:capsule-*`), or default session is resolved.
- **Risk Retired:** Retires RC1 (writing cookies into RAM or isolated capsule jars depending on which tab is focused). Guarantees AC1 and AC2.
- **Explicit Non-Goals:** Does not alter `deriveCapsulePartition` or workspace isolation logic for isolated agent tabs.

### Phase 2: LocalSessionVault Contract Hardening & Rejection
- **Goal:** Prevent silent false-positive backups/restores, reject ephemeral sessions, and require non-empty payload verification.
- **Files & Symbols to Change:**
  - `src/main/browser/local-session-vault.ts:100-170`: In `exportVaultToFile(targetSession, targetFilePath)`:
    - Inspect `targetSession`: if session partition is ephemeral or in-memory, fail immediately with `{ success: false, count: 0, error: 'TARGET_SESSION_EPHEMERAL: Cannot export from ephemeral session' }`.
    - If `liveCookies.length === 0`, return `{ success: false, count: 0, filePath: outPath, error: 'EMPTY_SESSION: Target session contains 0 cookies' }` unless explicit `allowEmpty: true` is passed.
    - Include `targetPartition` in return payload.
  - `src/main/browser/local-session-vault.ts:175-270`: In `importVaultFromJson(targetSession, input, options)`:
    - If `targetSession` is ephemeral/in-memory, fail immediately with `{ success: false, importedCount: 0, failedCount: 0, error: 'TARGET_SESSION_EPHEMERAL: Cannot import into ephemeral session' }`.
    - If `cookieList.length === 0`, return `{ success: false, importedCount: 0, failedCount: 0, error: 'EMPTY_PAYLOAD: No cookies found in vault payload' }`.
    - Always call `await targetSession.cookies.flushStore()`.
- **Risk Retired:** Retires RC2 (false success reporting when 0 cookies imported or imported into memory). Guarantees AC3.
- **Explicit Non-Goals:** Does not attempt offline SQLite decryption of DPAPI/ABE encrypted databases.

### Phase 3: Active Durability & Change-Flush Policy
- **Goal:** Ensure page-set cookies survive hard process kills (`taskkill /F`, power loss, crashes) without relying solely on clean shutdown.
- **Files & Symbols to Change:**
  - `src/main/browser/browser-session-partition.ts:60-120`: In `configureBrowserSessionPartition(partition, mode)`:
    - When `partition.startsWith('persist:profile-')`, attach a debounced cookie store flusher to `sess.cookies`:
      ```ts
      const flushTimers = new Map<string, NodeJS.Timeout>();
      sess.cookies.on('changed', (_event, _cookie, _cause, _removed) => {
        const prev = flushTimers.get(partition);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(async () => {
          flushTimers.delete(partition);
          try { await sess.cookies.flushStore(); } catch {}
        }, 2000);
        flushTimers.set(partition, timer);
      });
      ```
  - `src/main/browser/native-tab-host.ts:3580-3620`: Retain existing `flushAllSessions()` as redundant safety step on clean quit.
- **Risk Retired:** Retires RC5 and durability vulnerability (`prevCleanShutdown: false`). Page-set logins survive hard kills with at most a 2-second loss window. Guarantees AC7.
- **Explicit Non-Goals:** Does not attempt to override Google's server-side session revocation for shared rotating tokens (`*PSIDTS`).

### Phase 4: Transparent Chrome Sync & ABE v20 Gate
- **Goal:** Eliminate confusion over Windows 11 App-Bound Encryption (v20) and isolate CDP communication from external Chrome processes (port 9222 trap).
- **Files & Symbols to Change:**
  - `src/main/browser/chrome-profile-sync.ts:440-510`: In `hydrateCookiesViaOwnedChrome(profileId, profilePath, targetSession)`:
    - Isolate CDP port allocation: spawn with `--remote-debugging-port=0` (ephemeral port), reading port exclusively from `tempDir/DevToolsActivePort`. Never connect to port 9222.
    - ABE v20 Detection: If `getAllCookies` returns 0 cookies, check if `profilePath/Network/Cookies` exists and is > 32 KB. If so, detect App-Bound Encryption v20 with certainty.
    - Return explicit user-facing message:
      `"Google Chrome trên Windows 11 đã bảo vệ cookie bằng cơ chế App-Bound Encryption (v20). Chrome chặn ứng dụng ngoài đọc cookie từ bản clone.\n\nGiải pháp:\n1. Khuyên dùng: Đăng nhập trực tiếp trên AntiFan (phiên được lưu vĩnh viễn).\n2. Hoặc: Sử dụng tiện ích Session Vault Export/Import JSON."`
- **Risk Retired:** Prevents connecting to alien Chrome instances (Codex on port 9222), clarifies failed syncs to user. Guarantees AC2, AC8.
- **Explicit Non-Goals:** No reverse-engineering of Windows DPAPI or Chrome elevation services.

### Phase 5: Dead-End Migration Normalization
- **Goal:** Fix `runCapsuleToProfileMigration` target namespace so it maps legacy capsules to readable profile partitions, while preserving the existing completion marker contract.
- **Files & Symbols to Change:**
  - `src/main/browser/capsule-partition-migration.ts:80-130`: In `runCapsuleToProfileMigration(deps)`:
    - Fix namespace derivation at line 93:
      `const target = persist:${key.replace(/^(capsule-)+/, 'profile-')};`
      Ensures `capsule-capsule-<uuid>` maps to `persist:profile-capsule-<uuid>` or directly to the canonical profile target `persist:profile-default`.
    - Retain strict failure accounting: `markerReady: true` only if every candidate succeeded.
- **Risk Retired:** Retires RC3 (future migration passes writing unreachable namespaces). Guarantees AC4.
- **Explicit Non-Goals:** Does not re-run migration on installations where `antifan-migration-capsule-to-profile.done` already exists.

### Phase 6: Guarded, Idempotent Dead-Store Cleanup
- **Goal:** Cleanly and safely purge 84 dead SQLite stores (~8.76 MB), 2 orphan temp files, and 1 stale duplicate config file.
- **Files & Symbols to Change:**
  - `src/main/browser/partition-cleanup.ts` (NEW): Implement `executeGuardedPartitionCleanup(deps, options)`.
  - `src/main/browser/native-tab-host.ts`: Wire cleanup into startup sequence after tab restore and profile initialization.
  - `src/main/config/storage-locations.ts`: Add path resolution for cleanup audit receipts.
- **Risk Retired:** Retires RC3/RC5 disk leakage, frees 8.76 MB, purges 58 abandoned Google auth stores. Guarantees AC5.
- **Explicit Non-Goals:** Does not touch active profile `profile-profile-2` or any partition with an open tab.

### Phase 7: Cache Configuration Alignment
- **Goal:** Remove ineffective switches that target dead directories, and redirect default session fallbacks.
- **Files & Symbols to Change:**
  - `src/main/index.ts:190-215`: Remove `app.commandLine.appendSwitch('disk-cache-dir', ...)` and `gpu-cache-dir` which do not affect partition sessions. Document partition cache location in `Profile/Partitions/<partition>/Cache`.
- **Risk Retired:** Retires RC6 (cache misalignment and confusion). Guarantees AC6.
- **Explicit Non-Goals:** Does not disable Chromium HTTP caching.

---

## 3. Target-Session Resolver Contract

- **Proposed Method Name:** `resolvePersistentProfileSession`
- **Location:** `NativeTabHost` class (`src/main/browser/native-tab-host.ts`)
- **Signature:**
  ```ts
  public resolvePersistentProfileSession(
    profileId?: string,
    userAgentMode: BrowserSessionUserAgentMode = 'clean'
  ): Electron.Session
  ```
- **Contract & Invariants:**
  1. Resolves `profileId` using parameter or `ChromeProfileSyncManager.getInstance().activeProfileId ?? 'Default'`.
  2. Generates partition string: `this.getSharedProfilePartition(userAgentMode, false, profileId)`.
  3. **Runtime Invariant Assertion:**
     ```ts
     if (!partition.startsWith('persist:profile-')) {
       throw new Error(`INVARIANT_VIOLATION: resolvePersistentProfileSession refused non-persistent partition '${partition}'`);
     }
     ```
  4. Calls `configureBrowserSessionPartition(partition, userAgentMode)` to ensure UA, Client Hints, and debounced flush listeners are active.
  5. Returns `session.fromPartition(partition)`.
- **Callers Forced Through This Contract:**
  1. `app-menu.ts:195` (App Menu: Sync Chrome Profile)
  2. `app-menu.ts:215` (App Menu: Vault Export)
  3. `app-menu.ts:230` (App Menu: Vault Import)
  4. `native-tab-host.ts:2895` (Toolbar Menu: Sync Chrome Profile)
  5. `tab-context-menu.ts:272` (Tab Context Menu: Sync Chrome Profile)
  6. `native-tab-host.ts:1300-1345` (LocalSessionVault IPC handler when ambient request is received)
  7. `native-tab-host.ts:3449-3452` (`getTabSession` fallback when tab state has no partition)

---

## 4. Durability Strategy

### How Page-Set Cookies Survive a Kill
1. **The Vulnerability:** Chromium buffers SQLite cookie writes in memory WAL frames. In Electron, `session.cookies.flushStore()` commits these frames to disk. If an app crashes or receives `SIGKILL` / Windows `TerminateProcess`, uncommitted frames in memory vanish.
2. **The Active Flush Policy:**
   - Instead of flushing only on exit, `configureBrowserSessionPartition` registers an active listener on `session.cookies`:
     ```ts
     sess.cookies.on('changed', (_event, _cookie, _cause, _removed) => {
       scheduleDebouncedFlush(partition, sess, 2000);
     });
     ```
   - **Cost Analysis:** SQLite WAL commit takes < 5ms on modern SSDs. Debouncing to 2000ms ensures that rapid bursts (e.g. an OAuth redirection chain setting 15 cookies in 200ms) collapse into a single disk write. CPU overhead is negligible (< 0.1%), renderer process is never blocked, and any sudden process kill loses at most 2 seconds of state.
3. **Session Cookie Preservation:**
   - Web applications often set session cookies (`expires_utc = 0`).
   - For imported cookies: `LocalSessionVault` preserves its durable policy (`persistSessionCookies: true, sessionTtlSeconds: 30*24*3600`), converting ephemeral session cookies into durable 30-day cookies upon import.
   - For natural web logins: Active flush ensures session cookies remain present in the SQLite DB across graceful and ungraceful restarts.

---

## 5. Chrome-Sync Strategy under App-Bound Encryption v20

1. **Cryptographic Reality:**
   On Windows 11 with Chrome >= 127, Google Chrome's `Cookies` database is encrypted with App-Bound Encryption (ABE). A standalone cloned profile executed under a different binary or outside Chrome's COM service cannot retrieve the decryption key; Chromium returns 0 cookies and purges undecryptable rows.
2. **What Is Refused:**
   - The app will NOT attempt offline SQLite decryption or silent headless CDP syncs without validation.
   - The app will NOT connect to port 9222 without verifying the process ownership (mitigating the `CodexRemote9222` trap where an alien Chrome extension runs an empty profile on 9222).
3. **Port 9222 Foreign-Chrome Trap Mitigation:**
   In `hydrateCookiesViaOwnedChrome`:
   - Always spawn owned Chrome with `--remote-debugging-port=0`.
   - Read the assigned port exclusively from `tempDir/DevToolsActivePort`.
   - Verify that the browser target path in the CDP JSON metadata matches the spawned Chrome executable.
4. **UI Messaging Contract:**
   When owned Chrome returns 0 cookies and the target profile has a non-empty `Cookies` file:
   - Display informative Warning Dialog:
     - **Title:** `Đồng Bộ Google Chrome (Bảo Mật Windows 11)`
     - **Message:** `"Google Chrome trên Windows 11 sử dụng App-Bound Encryption (v20) để bảo vệ cookie đăng nhập, ngăn ứng dụng bên ngoài tự động sao chép.\n\nĐể sử dụng phiên đăng nhập:\n1. Khuyên dùng: Đăng nhập trực tiếp trên AntiFan (tài khoản sẽ được lưu vĩnh viễn trong Profile AntiFan).\n2. Hoặc: Sử dụng tiện ích Session Vault (Export JSON từ Chrome -> Import JSON vào AntiFan)."`
5. **Fallback:**
   - Non-ABE profiles (e.g. unencrypted test profiles, portable Chromium) continue to sync cleanly via owned CDP.
   - Session Vault JSON import remains the authorized, durable cross-browser bridge.

---

## 6. Guarded Dead-Store Cleanup Mechanism

- **Target Candidate Inventory:**
  - 43 dead legacy capsule stores: `Partitions/capsule-capsule-*`
  - 41 dead migration stores: `Partitions/profile-capsule-*`
  - 2 orphan temp files: `Profile/saved-tabs.json.tmp.*`
  - 1 stale duplicate config file: `config/saved-tabs.json` (394 B, stale Aug 31)
  - Reclaims: ~8.76 MB across 84 dead SQLite databases containing 58 abandoned Google auth stores.
- **Triple-Guard Safety Rules (Fail-Closed):**
  1. **Live Tab Reference Guard:**
     Collect all partitions currently referenced by any open tab in `NativeTabHost`:
     `const activePartitions = new Set(Array.from(this.tabs.values()).map(t => t.state.partition));`
     If candidate directory matches any active tab partition, it is **strictly skipped**.
  2. **Active Profile Guard:**
     Candidate directory starting with `profile-${activeProfileId.toLowerCase()}` or `profile-default` is **strictly skipped**.
  3. **Strict Regex Whitelist Guard:**
     Candidate directory name MUST strictly match:
     `/^(capsule-capsule-[0-9a-fA-F-]{36}|profile-capsule-capsule-[0-9a-fA-F-]{36})$/`
     Any name not matching this exact pattern is ignored.
- **Idempotence Proof:**
  - Run 1: Enumerates 84 matching directories, verifies guards, deletes via `fs.rmSync(dir, { recursive: true, force: true })`, unlinks temp/stale files. Returns `deletedCount: 84, reclaimedBytes: 9185280`.
  - Run 2: Enumeration finds 0 matching candidates. Returns `deletedCount: 0, reclaimedBytes: 0, status: 'IDEMPOTENT_NOOP'`.
- **Audit Receipt:**
  Persists JSON audit log to `StorageLocations.getConfigDir() / 'partition-cleanup-audit.json'`:
  `{ timestamp: string, dryRun: boolean, removedDirectories: string[], removedFiles: string[], bytesReclaimed: number }`.

---

## 7. Test Plan Mapped to AC1–AC8

| Criterion | Target Test File | What It Asserts / Changes |
|---|---|---|
| **AC1** (No ephemeral/capsule writes) | `test/main/target-session-resolver.test.ts` (NEW) | Asserts `resolvePersistentProfileSession()` returns session with `persist:profile-*`. Asserts `LocalSessionVault` throws/rejects when passed ephemeral session. |
| **AC2** (Menus target explicit profile id) | `test/main/menu-target-session-dispatch.test.ts` (NEW) | Mocks `NativeTabHost` with focused tab set to `ephemeral-profile-*`. Executes menu click handlers for Toolbar Sync, Context Sync, App Menu Sync, Vault Export, Vault Import. Asserts all 5 dispatch to persistent profile session, never focused tab. |
| **AC3** (Vault rejects empty / ephemeral) | `test/main/local-session-vault.test.ts` (EXISTING) | **Changed assertion (line 116):** Change `assert.strictEqual(res.success, true)` on empty array to `assert.strictEqual(res.success, false)` with `assert.match(res.error, /EMPTY_PAYLOAD/)`. Add tests asserting ephemeral session rejection. |
| **AC4** (Migration namespace normalized) | `test/main/capsule-partition-migration-pure.test.ts` (EXISTING) | **Changed assertion:** Verify `key.replace(/^(capsule-)+/, 'profile-')` maps `capsule-capsule-a` to reachable `persist:profile-capsule-a` or canonical target. Verify `markerReady: true` preserved on clean run. |
| **AC5** (Guarded 84 dead stores cleanup) | `test/main/partition-cleanup.test.ts` (NEW) | Mocks filesystem with 43 capsule-capsule, 41 profile-capsule, 1 live profile-profile-2, temp files, stale config. Asserts dryRun flags 84, live run deletes 84 + temp files, second run is no-op, and active tab partition is protected. |
| **AC6** (Cache configuration verified) | `test/main/cache-configuration.test.ts` (NEW) | Asserts removal of dead `--disk-cache-dir` command-line switch; asserts per-partition cache path resolution. |
| **AC7** (Session durability & active flush) | `test/main/session-durability-flush.test.ts` (NEW) | Tests debounced `cookies.on('changed')` flush logic: sets cookie, advances mock timers 2000ms, verifies `flushStore()` executed. Verifies imported session cookies have > 25 days TTL. |
| **AC8** (Reproduction before & after) | All test suites above | Provides executable unit tests executable via `npm run test:file <path>` that fail on legacy code and pass on updated code. |

---

## 8. Risk Register

### Top 5 Risks & Detection Signals:
1. **Accidental Deletion of Live Session Data during Cleanup**
   - *Severity:* Critical.
   - *Mitigation:* Triple-guard system (live tab membership check, active profile ID exclusion, strict regex whitelist).
   - *Detection Signal:* Audit receipt logged to disk; unit test verifying rejection when active tab matches candidate.
2. **I/O Churn from Frequent Cookie Mutations**
   - *Severity:* Low-Medium.
   - *Mitigation:* 2000ms debounce timer per session partition collapses high-frequency cookie changes into a single SQLite sync.
   - *Detection Signal:* Monitor `main.log` for flush errors or frame drops during rapid navigation.
3. **Google Rotating Token De-synchronization (Two-Client Revocation)**
   - *Severity:* High.
   - *Mitigation:* Do not attempt automated continuous background synchronization of short-lived `*PSIDTS` tokens from Chrome. Encourage direct AntiFan logins which remain single-owner.
   - *Detection Signal:* User remains logged into Google services without sudden redirects to login page.
4. **Foreign CDP Port 9222 Conflict**
   - *Severity:* Medium.
   - *Mitigation:* Explicit `--remote-debugging-port=0` with private `tempDir/DevToolsActivePort` resolution.
   - *Detection Signal:* Owned Chrome connects only to ephemeral OS-assigned ports.
5. **Regression of Existing Extension Bridge & Attachment Security**
   - *Severity:* High.
   - *Mitigation:* Strictly preserve `isTrustedSessionVaultSender` and attachment binding verification in `LocalSessionVault`.
   - *Detection Signal:* Existing tests in `test/main/local-session-vault.test.ts` remain 100% green.

### What Was Deliberately NOT Done:
- Did NOT attempt to build an offline DPAPI / App-Bound Encryption decrypter (proven impossible in user-mode; causes Chromium to purge rows).
- Did NOT rewrite the 4-family partition model (shared, capsule, ephemeral, default).
- Did NOT touch the MCP capability catalog or budget gates (`scripts/antifan-omp-mcp.cjs`).
- Did NOT add any new external npm dependencies.
- Did NOT delete or weaken any existing test suite; only updated the zero-cookie import assertion to satisfy AC3.

---

## 9. Effort and Order of Execution

- **Total Implementation Effort:** ~1.5 to 2 engineering days.
- **Execution Order:**
  - **Phase 1 & Phase 2 (First Ship):** Implement `resolvePersistentProfileSession` in `NativeTabHost`, rewire all 3 sync menus and 2 vault menus, and harden `LocalSessionVault`.
    - *Impact if only Phase 1 & 2 ship:* **Immediately eliminates "lúc ăn lúc không"**. No cookie can ever again be written into an ephemeral RAM jar or an isolated capsule jar via sync or vault operations.
  - **Phase 3 & Phase 4:** Implement active debounced flush (2000ms) on persistent partitions, isolate CDP port resolution, and wire transparent ABE v20 dialog.
    - *Impact:* Solves "rất nhanh hết" for page-set cookies across hard kills/crashes, eliminates port 9222 collision.
  - **Phase 5 & Phase 6:** Normalize migration namespace and execute guarded cleanup of 84 dead stores (~8.76 MB reclaimed).
    - *Impact:* Frees disk space, cleans orphaned Google auth databases, preserves migration marker contract.
  - **Phase 7:** Clean up command-line cache switches and verify full test suite.