# IMPLEMENTATION PLAN: AntiFan Desktop Browser Cookie, Cache & Session Architecture Fix

**Candidate:** Index 1 of 5 (Ultra Verifier Run)  
**Target Date:** 2026-09-19  
**Target Systems:** Electron 43.4.0, TypeScript, Windows 11 (`E:/Work/.antifan-data`)  
**Evidence Packet:** `plans/reports/260919-cookie-cache-ultra-packet.md`  
**Forensics Base:** `docs/research-cache-cookie-mechanism.md`

---

### 1. Chosen Organizing Insight & Problem-Solving Technique

- **Selected Technique (`ak:problem-solving`):** **Simplification Cascades**
- **One-Line Symptom Match:** *"Same thing implemented 5+ ways, growing special cases"* — 3 diverging Chrome sync entry points resolving target sessions differently, 2 vault entry points targeting focused tabs, 4 conflicting partition naming families, a dead-end migration copying 25,756 cookies to an unreadable namespace, and phantom CLI cache switches.
- **Organizing Insight:**
  > **The Profile-Bound Session Invariant**: Cookie jars, sync hydration, vault export/import, cache budgets, and persistence are *strictly 1:1 properties of an explicit Profile ID (`persist:profile-<profileId>`), never properties of an ambient focused tab or an ad-hoc partition.*

By establishing this invariant, the entire fix space collapses:
1. **Collapses Target Selection**: Completely eliminates `getActiveTabSession()` from all profile sync and vault operations. All 3 Chrome sync paths and 2 vault paths route through one authoritative, non-ambient session resolver `resolveAuthorizedProfileSession(profileId)`.
2. **Collapses Storage Namespace**: Eradicates the unreadable `profile-capsule-*` namespace, locks down `persist:profile-<profileId>` as the sole persistent profile jar, and prevents double-prefix corruption.
3. **Collapses Dead Stores**: Reclaims 84 dead stores (8.76 MB) and 219 MB of orphaned cache because any store not belonging to an active profile or an open tab is provably unreachable garbage.
4. **Collapses Durability**: Binds an automatic debounced flush directly to the session's cookie change event (`cookies.on('changed')`), ensuring page-set and OAuth cookies persist to SQLite WAL within $\le 1.5$ seconds of mutation without waiting for graceful application quit.
5. **Collapses Cache Confusion**: Removes the dead `--disk-cache-dir` CLI switch that only applied to `defaultSession`, documenting and bounding the actual partition cache directory structure.

---

### 2. Ordered Phases

#### Phase 1: Authoritative Profile Session Resolver & Ingress Hardening
- **Goal:** Eliminate session confusion and ephemeral jar vaporization. Guarantee that Chrome Profile Sync and Session Vault operations can never target an ephemeral tab or an isolated capsule, and never rely on window focus.
- **Files & Symbols to Change:**
  1. `src/main/browser/browser-session-partition.ts:77-117`:
     - Maintain a `sessionPartitionMap = new WeakMap<Session, string>()` tracking configured partition strings.
     - Export `getBrowserSessionPartition(sess: Session): string`.
     - Export `isEphemeralSession(sess: Session): boolean` (checks `!sess.isPersistent()` or partition matching `/^ephemeral-/`).
     - Export `isProfileSession(sess: Session): boolean` (checks partition matching `/^persist:profile-[a-z0-9_-]+$/`).
  2. `src/main/browser/native-tab-host.ts:3528-3532` & new method:
     - Implement `public resolveAuthorizedProfileSession(profileId?: string): Electron.Session` adhering to the contract defined in Section 3.
     - `src/main/browser/native-tab-host.ts:2895` (`showMainMenu`): Replace `this.getActiveTabSession()` with `this.resolveAuthorizedProfileSession(p.id)`.
     - `src/main/browser/native-tab-host.ts:1300-1329` (`registerIpcHandlers` callback): Ensure fallback returns `this.resolveAuthorizedProfileSession(options?.profileId as string | undefined)`.
  3. `src/main/browser/tab-context-menu.ts:272` (`showMainMenu`):
     - Replace `this.host.getActiveTabSession()` with `this.host.resolveAuthorizedProfileSession(p.id)`.
  4. `src/main/browser/app-menu.ts:195, 215, 230`:
     - Line 195: Change `tabHost?.getSharedProfileSession('clean', p.id)` to `tabHost?.resolveAuthorizedProfileSession(p.id)`.
     - Line 215: Change `tabHost?.getActiveTabSession()` to `tabHost?.resolveAuthorizedProfileSession()`.
     - Line 230: Change `tabHost?.getActiveTabSession()` to `tabHost?.resolveAuthorizedProfileSession()`.
  5. `src/main/browser/local-session-vault.ts:115-154, 180-270`:
     - In `exportVaultToFile`: Add fail-closed assertion rejecting ephemeral sessions with `{ success: false, count: 0, filePath: '', error: 'EPHEMERAL_TARGET_REJECTED' }`.
     - In `exportVaultToFile`: If `liveCookies.length === 0`, refuse to overwrite file and return `{ success: false, count: 0, filePath: outPath, targetJar, error: 'EMPTY_SESSION_JAR: No cookies found in session to export' }`.
     - In `importVaultFromJson`: Add fail-closed assertion rejecting ephemeral target sessions with `{ success: false, importedCount: 0, failedCount: 0, error: 'EPHEMERAL_TARGET_REJECTED' }`.
     - In `importVaultFromJson`: If `cookieList.length === 0`, return `{ success: false, importedCount: 0, failedCount: 0, error: 'EMPTY_VAULT_INPUT: No cookies in input' }`.
     - Return `targetJar: getBrowserSessionPartition(targetSession)` in result objects.
- **Risk Retired:** Retires **RC1** (writing into focused ephemeral/capsule tabs) and **RC4** (falling back to empty default jar). Satisfies **AC1**, **AC2**, and **AC3**.
- **Explicit Non-Goals:** Does not alter capsule isolation semantics (`deriveCapsulePartition`) or change user agent header handling.

#### Phase 2: Durability Engine (Debounced Cookie Flush per Session)
- **Goal:** Prevent cookie loss on unexpected crash, forced kill, or power loss. Ensure page-set and OAuth session cookies persist to disk within $\le 1.5$ seconds of mutation.
- **Files & Symbols to Change:**
  1. `src/main/browser/browser-session-partition.ts:77-117` (`configureBrowserSessionPartition`):
     - In `configureBrowserSessionPartition`, attach an event listener to `sess.cookies.on('changed')` for every persistent partition (`persist:profile-*` and `persist:capsule-*`).
     - Debounce calls to `sess.cookies.flushStore()` with a 1500ms trailing timer and a 3000ms max-wait clamp.
     - Track active timers in a module-scoped `WeakMap<Session, NodeJS.Timeout>` to prevent memory leaks or duplicate listeners.
  2. `src/main/browser/native-tab-host.ts:3586-3618` (`flushAllSessions`):
     - Preserve existing graceful shutdown flush, ensuring pending debounced timers are immediately cleared and executed before process exit.
- **Risk Retired:** Retires **RC5** (cookies only flushed on graceful shutdown). Satisfies **AC7**.
- **Explicit Non-Goals:** Does not convert server-issued session cookies (without `Expires`) to 30-day cookies at runtime; only import pathways apply synthetic TTL.

#### Phase 3: Chrome Profile Sync Clarification & Port-9222 Disambiguation under ABE v20
- **Goal:** Handle Google Chrome App-Bound Encryption v20 honestly. Eliminate the foreign Chrome port-9222 trap and provide crystal-clear UI feedback explaining why closed Chrome is required.
- **Files & Symbols to Change:**
  1. `src/main/browser/local-session-vault.ts:275-360` (`importFromLiveChromeCDP`):
     - Change default parameter from `cdpPort = 9222` to requiring an explicit port or probing `/json/version` before connecting.
     - Inspect the `/json/version` response body for `User-Agent` and `webSocketDebuggerUrl`. If metadata indicates a foreign automation harness (e.g. OpenAI Codex extension) or an empty user-data-dir, reject with `'FOREIGN_CDP_INSTANCE_DETECTED'`.
  2. `src/main/browser/chrome-profile-sync.ts:445-447, 497-503`:
     - Update `hydrateCookiesViaOwnedChrome`: If Chrome is detected running, return a prominent UI dialog explaining: `"Google Chrome đang mở. Để đồng bộ cookies an toàn, vui lòng ĐÓNG HẲN Chrome (hoặc kiểm tra khay hệ thống) rồi bấm Đồng bộ lại."`
     - When `res.count === 0` due to ABE v20 on real profiles: Keep the descriptive message directing users to Session Vault or the AntiFan Extension Bridge.
- **Risk Retired:** Prevents silent connection to the foreign OpenAI Codex Chrome process on port 9222 and eliminates confusing 0-cookie failures. Satisfies **AC8**.
- **Explicit Non-Goals:** Does not attempt reverse engineering or offline decryption of Windows App-Bound Encryption v20.

#### Phase 4: Capsule Migration Resolution & Removal of Dead-End Code
- **Goal:** Repair the double-prefixing defect in legacy migration logic and guarantee that no code path writes to unreadable namespaces like `persist:profile-capsule-*`.
- **Files & Symbols to Change:**
  1. `src/main/browser/capsule-partition-migration.ts:92-93`:
     - Normalize migration target keys by stripping repeated `capsule-` prefixes:
       ```ts
       const normalizedKey = key.replace(/^(capsule-)+/, '');
       const target = `persist:profile-${normalizedKey}`;
       ```
     - If `key` does not contain a valid profile identifier, default to `persist:profile-default`.
  2. `src/main/browser/native-tab-host.ts:3542-3580`:
     - Verify marker file `antifan-migration-capsule-to-profile.done` check remains intact (returns `{ migrated: 0, legacyPartitions: [] }` immediately).
- **Risk Retired:** Retires **RC3** (migration writing to dead namespace). Satisfies **AC4**.
- **Explicit Non-Goals:** Does not trigger a re-migration of previously copied stores; existing dead stores are purged in Phase 5.

#### Phase 5: Guarded, Idempotent Dead-Store & Orphan State Cleanup
- **Goal:** Safely purge the 84 dead cookie stores (8.76 MB), 219 MB of orphaned default cache, stale duplicate `config/saved-tabs.json`, and temporary files with ironclad live-tab guards and idempotence.
- **Files & Symbols to Change:**
  1. `src/main/browser/dead-store-cleanup.ts` (NEW module):
     - Implement `auditAndPruneDeadStores(options: { dryRun?: boolean })`:
       - **Live Tab Exclusion Guard**: Read live tabs from `tabHost` and `Profile/saved-tabs.json`. Collect all active partitions (`persist:profile-*`, active `capsuleId`s). Any partition currently referenced is strictly protected.
       - **Directory Whitelist Guard**: Only match directory names in `userData/Partitions/` strictly conforming to `/^(capsule-capsule-[a-f0-9-]+|profile-capsule-[a-f0-9-]+)$/`.
       - **Stale State Cleanup**: Delete `config/saved-tabs.json` only after verifying `Profile/saved-tabs.json` exists and is newer.
       - **Temp Files Cleanup**: Delete `Profile/saved-tabs.json.tmp.*` older than 1 hour.
       - **Orphan Cache Cleanup**: Delete `Profile/Cache` (~219 MB) if no tabs reference `session.defaultSession`.
       - Return a structured audit receipt `{ scanned: number, deleted: number, reclaimedBytes: number, dryRun: boolean, status: string }`.
  2. `src/main/index.ts:196-198`:
     - Remove dead switch: `app.commandLine.appendSwitch('disk-cache-dir', StorageLocations.getNetworkCacheDir());`
     - Document that partition caches are automatically managed per-session under `Profile/Partitions/<partition>/Cache`.
- **Risk Retired:** Retires **RC6** and frees ~228 MB of dead disk space without risk to active tabs. Satisfies **AC5** and **AC6**.
- **Explicit Non-Goals:** Does not delete the active partition `Partitions/profile-profile-2` or any active capsule partition.

---

### 3. Target-Session Contract

#### Proposed Resolver Specification
- **Location:** `src/main/browser/native-tab-host.ts` (exposed on `NativeTabHost` instance, and accessible via control plane / app menu).
- **Signature:**
  ```ts
  public resolveAuthorizedProfileSession(profileId?: string): Electron.Session
  ```
- **Behavior & Invariants:**
  1. Determines the authoritative profile ID:
     ```ts
     const activeId = profileId?.trim() || ChromeProfileSyncManager.getInstance().activeProfileId || 'Default';
     const safeProfileKey = activeId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
     const partition = `persist:profile-${safeProfileKey}`;
     ```
  2. Configures the session deterministically:
     ```ts
     return configureBrowserSessionPartition(partition, 'clean');
     ```
  3. **Strict Invariant**: NEVER reads `this.activeTabId`, NEVER inspects `this.tabs`, and NEVER delegates to `this.getActiveTabSession()`.
  4. Returns a persistent `Electron.Session` instance guaranteed to be backed by SQLite at `Profile/Partitions/profile-<safeProfileKey>/Network/Cookies`.

#### Enforced Callers
Every profile-level cookie entry point is refactored to use this contract:
1. Native App Menu Sync (`app-menu.ts:195`): `tabHost.resolveAuthorizedProfileSession(p.id)`
2. Native App Menu Vault Export (`app-menu.ts:215`): `tabHost.resolveAuthorizedProfileSession()`
3. Native App Menu Vault Import (`app-menu.ts:230`): `tabHost.resolveAuthorizedProfileSession()`
4. Toolbar Menu Sync (`native-tab-host.ts:2895`): `this.resolveAuthorizedProfileSession(p.id)`
5. Tab Context Menu Sync (`tab-context-menu.ts:272`): `this.host.resolveAuthorizedProfileSession(p.id)`
6. IPC Toolbar Channel (`native-tab-host.ts:1429`): `this.resolveAuthorizedProfileSession(profileId)`

#### Runtime Rejection Guard in `LocalSessionVault`
To prevent rogue callers or extensions from bypassing the contract:
```ts
// local-session-vault.ts
const partition = getBrowserSessionPartition(targetSession);
if (!targetSession.isPersistent() || partition.startsWith('ephemeral-')) {
  return { success: false, count: 0, importedCount: 0, failedCount: 0, error: 'EPHEMERAL_TARGET_REJECTED' };
}
```

---

### 4. Durability Strategy

#### Mechanism: Debounced Cookie Store Flush
- **Problem Solved:** Currently, Chromium holds modified cookies in memory until an internal flush or graceful application exit (`native-tab-host.ts:3586`). Because the application experiences crashes (`main.log.1` recorded 13 `crashed-terminal-session` events) or kills via terminal, uncommitted cookies are lost.
- **Flush Policy:**
  In `browser-session-partition.ts`:
  ```ts
  const flushTimers = new WeakMap<Session, NodeJS.Timeout>();

  export function attachSessionDurability(sess: Session): void {
    if (!sess.isPersistent()) return;

    sess.cookies.on('changed', (_event, _cookie, _cause, _removed) => {
      const existing = flushTimers.get(sess);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        try {
          await sess.cookies.flushStore();
        } catch (err) {
          console.warn('[durability] flushStore failed:', err);
        } finally {
          flushTimers.delete(sess);
        }
      }, 1500);

      flushTimers.set(sess, timer);
    });
  }
  ```
- **Execution Cost & Trade-offs:**
  - **Disk I/O**: SQLite WAL mode in Chromium makes cookie flushes fast (< 2ms on modern NVMe/SATA drives).
  - **Debounce Window (1500ms)**: Page-load bursts (e.g. 30 cookies set during login redirect) collapse into exactly ONE `flushStore()` call 1.5 seconds after settling.
  - **Worst-Case Loss**: If the process is forcefully killed (`taskkill /F /PID`), data loss is bounded to at most the preceding 1.5 seconds of browsing activity.
  - **Idle Impact**: 0% CPU and 0 disk writes when no cookies are being mutated.

---

### 5. Chrome-Sync Strategy

#### Handling App-Bound Encryption (v20)
- **Technical Reality:** On Chrome $\ge 127$ on Windows, encryption keys are bound to the specific Chrome executable path via an elevated Windows Service (App-Bound Encryption). Cloning the `User Data` profile directory to a temporary path causes Chromium to decrypt 0 cookies and **purge** the encrypted rows.
- **UI Policy & Honest Messaging:**
  1. If Chrome is running, `isChromeRunning()` returns `true`:
     - Display a message box:
       `"Google Chrome đang chạy. Vui lòng đóng hẳn trình duyệt Chrome (kiểm tra khay hệ thống) rồi bấm Đồng bộ lại."`
  2. If the headless clone yields 0 cookies (ABE v20 protected):
     - The app will not falsely claim success. It displays:
       `"Chrome đã mã hoá cookies bằng App-Bound Encryption (v20) nên không thể copy trực tiếp từ file. Vui lòng dùng tính năng '💾 Sao lưu / 📥 Khôi phục Session Vault' hoặc đăng nhập trực tiếp trên AntiFan."`

#### Mitigating the Port-9222 Foreign-Chrome Trap
- **The Threat:** On developer machines, external processes (such as the OpenAI Codex extension) often launch Chrome with `--remote-debugging-port=9222` and a distinct user-data-dir (`CodexRemote9222`), which contains an empty profile.
- **Mitigation Protocol:**
  1. `hydrateCookiesViaOwnedChrome` in `chrome-profile-sync.ts:460` spawns Chrome with `--remote-debugging-port=0` (dynamic ephemeral port) and reads `DevToolsActivePort` strictly from its own isolated `tempDir`. It NEVER targets port 9222.
  2. In `local-session-vault.ts:275`, remove default `cdpPort = 9222`. Require callers to pass the port explicitly.
  3. When an external CDP import is requested, issue an HTTP GET to `http://127.0.0.1:${port}/json/version` and inspect the `User-Agent` and `Browser` strings. If the browser signature or active profile mismatches the expected target, abort with error `'FOREIGN_CDP_INSTANCE_DETECTED'`.

#### Google Rotating Cookies Invariant
- Google's rotating token pairs (`__Secure-1PSIDTS` / `__Secure-3PSIDTS` and `*PSIDRTS`) have 10-minute lifespans and are single-owner tokens.
- **Design Rule:** AntiFan does not attempt continuous background syncing of rotating tokens between Chrome and AntiFan. AntiFan's profile session operates as an autonomous, persistent client with its own independent refresh cycle once logged in.

---

### 6. Cleanup Mechanism

#### Exact Pattern & Implementation
Implemented in `src/main/browser/dead-store-cleanup.ts`:
```ts
export interface CleanupReport {
  scannedCount: number;
  deletedStores: string[];
  reclaimedStoreBytes: number;
  orphanFilesRemoved: string[];
  orphanCachePrunedBytes: number;
  dryRun: boolean;
  status: 'SUCCESS' | 'NO_OP' | 'ABORTED';
}
```

#### Multi-Layered Safety Guards
1. **Live Tab & Active Profile Protection**:
   - Query all open tabs in `tabHost`: collect `tab.state.partition` and `tab.state.capsuleId`.
   - Read `Profile/saved-tabs.json`: collect all tab partitions and capsule IDs.
   - Collect active profile partition: `persist:profile-${activeProfileId.toLowerCase()}`.
   - If any directory under `userData/Partitions/` matches any of these protected partitions, it is marked `PROTECTED` and deletion is skipped.
2. **Strict Basename Whitelist**:
   - Only directories matching `/^capsule-capsule-[a-f0-9-]+$/` or `/^profile-capsule-[a-f0-9-]+$/` are eligible.
   - Directories matching `profile-profile-*` or standard naming are never touched.
3. **SQLite Lock Check**:
   - Before removing a partition folder, attempt non-blocking check on its `Network/Cookies` file. If locked by an active process, skip it.
4. **Stale State Verification**:
   - `config/saved-tabs.json` is deleted ONLY if `Profile/saved-tabs.json` exists and has `mtime >= config/saved-tabs.json.mtime`.
5. **Orphan Cache Verification**:
   - `Profile/Cache` (219 MB) is deleted only after confirming that zero tabs are assigned to `session.defaultSession`.

#### Idempotence Proof
- **Run 1 (Active Cleanup):** Discovers 84 dead partition directories, 2 `.tmp` files, 1 stale config file, and 1 orphaned cache folder. Deletes all matched targets. Emits `CleanupReport` with `status: 'SUCCESS'` and `reclaimedStoreBytes: ~8760000`.
- **Run 2 (Immediate Re-run):** The scanner reads `userData/Partitions/`. Regex matching yields 0 directories. `config/saved-tabs.json` no longer exists. `Profile/Cache` no longer exists. Deletes 0 items. Emits `CleanupReport` with `scannedCount: 0, deletedStores: [], status: 'NO_OP'`.
- **Permanent Stability:** Because Phase 4 prevents the migration from generating double-prefixed directories, dead stores will never regenerate.

---

### 7. Test Plan Mapped to AC1–AC8

| Acceptance Criterion | Test File | Test Method & Assertions | Status of Existing Tests |
|---|---|---|---|
| **AC1** (No sync/vault write into ephemeral/capsule) | `test/main/profile-session-resolver.test.ts` *(NEW)* | 1. Assert `resolveAuthorizedProfileSession()` returns `persist:profile-*`.<br>2. Call `LocalSessionVault.exportVaultToFile` with an ephemeral session; assert it rejects with `EPHEMERAL_TARGET_REJECTED`.<br>3. Call `LocalSessionVault.importVaultFromJson` with an ephemeral session; assert it rejects with `EPHEMERAL_TARGET_REJECTED`. | Unchanged; green. |
| **AC2** (Sync/Vault resolve from profile ID only, never focused tab) | `test/main/profile-session-resolver.test.ts` *(NEW)* | 1. Create a tab host with focused tab set to `ephemeral-tab-1`.<br>2. Execute all 3 sync entry points and 2 vault entry points.<br>3. Assert target session partition is strictly `persist:profile-default` (or explicit profile), never `ephemeral-tab-1`. | Preserves `test/main/profile-ownership.test.ts`. |
| **AC3** (Vault export/import refuses 0-cookie/empty success) | `test/main/local-session-vault.test.ts` *(UPDATE)* | 1. Call `exportVaultToFile` on a session with 0 cookies; assert `{ success: false, error: 'EMPTY_SESSION_JAR' }` and assert target file is untouched.<br>2. Call `importVaultFromJson` with `[]`; assert `{ success: false, error: 'EMPTY_VAULT_INPUT' }`.<br>3. Assert `exportRes.targetJar` is populated. | Existing tests updated to assert `MockElectronSession.isPersistent() = true`. |
| **AC4** (Migration writes reachable namespace or retired) | `test/main/capsule-partition-migration-pure.test.ts` *(UPDATE)* | 1. Pass `['capsule-capsule-uuid']` to `runCapsuleToProfileMigration`.<br>2. Assert target partition is `persist:profile-uuid`, NOT `persist:profile-capsule-uuid`.<br>3. Assert done marker causes immediate 0-migrated return. | Existing assertions in `capsule-partition-migration-pure.test.ts` continue to pass. |
| **AC5** (84 dead stores + orphans cleaned idempotently) | `test/main/dead-store-cleanup.test.ts` *(NEW)* | 1. Mock directory tree with 43 `capsule-capsule-*`, 41 `profile-capsule-*`, 1 live `profile-profile-2`, and 1 live capsule tab.<br>2. Execute cleanup; assert 84 dead stores deleted, live profile and live capsule untouched.<br>3. Execute cleanup second time; assert 0 deleted (`NO_OP`). | No regressions. |
| **AC6** (Cache config matches reality, 219MB handled) | `test/main/cache-config.test.ts` *(NEW)* | 1. Assert `app.commandLine` switches: `--disk-cache-dir` is NOT appended for named partitions.<br>2. Assert `StorageLocations.getProfileDir()` houses per-partition cache paths. | No regressions. |
| **AC7** (Debounced durability flush on change) | `test/main/session-durability.test.ts` *(NEW)* | 1. Attach durability listener to mock session.<br>2. Emit `changed` event on `sess.cookies`.<br>3. Advance clock by 1000ms: assert `flushStore` NOT called.<br>4. Advance clock past 1500ms: assert `flushStore` called exactly once.<br>5. Emit 10 rapid events: assert exactly 1 `flushStore` executed after 1500ms. | Verifies crash-resilience. |
| **AC8** (Reproduction evidence & verification) | `test/main/session-repro-verification.test.ts` *(NEW)* | Automated pre-fix vs post-fix verification assertions for all fixed root causes. | Full green run via `npm run test:main`. |

---

### 8. Risk Register

| # | Risk Description | Severity | Detection Signal | Mitigation & Fallback |
|---|---|---|---|---|
| **R1** | **Accidental deletion of an active capsule store** during cleanup | HIGH | Live tab with `persist:capsule-<id>` shows blank/logged-out state; SQLite `EBUSY` error during cleanup. | Active tab partitions and `saved-tabs.json` partitions are scanned into a strict exclusion set before file deletion. Live references unconditionally abort deletion. |
| **R2** | **Google rotating token invalidation** (`*PSIDTS`/`*PSIDRTS`) | HIGH | Redirect to `google.com/accounts` within 10 minutes of sync; token mismatch in DevTools. | Do not copy rotating tokens from external Chrome. Treat AntiFan's profile as an independent authenticated client. |
| **R3** | **I/O disk thrashing from debounced flush** on high-frequency cookie pages | MEDIUM | Spike in main-process CPU usage; `flushStore` taking > 100ms in telemetry. | Trailing debounce of 1500ms with a minimum quiet interval clamp (maximum 1 flush every 3000ms). |
| **R4** | **Connecting to foreign Chrome on port 9222** | MEDIUM | Sync claims success but imports 0 cookies from foreign Codex extension. | Do not default to port 9222. Inspect `/json/version` metadata to verify browser binary and profile owner. |
| **R5** | **Overwriting existing good Session Vault** with empty export from new profile | HIGH | `session-vault.json` drops from 76 KB to 2 bytes (`[]`). | `exportVaultToFile` refuses to overwrite if `liveCookies.length === 0`. Requires explicit non-empty validation. |

#### What We Deliberately Did NOT Do
1. **Did NOT attempt offline SQLite decryption for Chrome ABE v20**: Chromium purges rows when decrypted outside its trusted executable environment; doing so would destroy user profile databases.
2. **Did NOT invent a fifth partition scheme**: We preserved the 4-family architecture (`profile`, `capsule`, `ephemeral`, `default`) and simply fixed resolution and naming bugs.
3. **Did NOT perform unverified background auto-deletions**: All cleanup operations are gated by live-tab checks, strict regex whitelists, and dry-run audit receipts.
4. **Did NOT touch MCP dispatch or budget files**: All changes remain strictly within main browser runtime and test surfaces.

---

### 9. Effort, Order of Execution & Minimal Viable Cut

#### Order of Execution
1. **Phase 1 (Day 1 — Morning):** Authoritative Profile Session Resolver (`resolveAuthorizedProfileSession`) + Ingress Hardening in `app-menu.ts`, `tab-context-menu.ts`, `native-tab-host.ts`, and `local-session-vault.ts`.
2. **Phase 2 (Day 1 — Afternoon):** Durability Engine: install debounced `cookies.on('changed')` flush in `browser-session-partition.ts`.
3. **Phase 3 (Day 2 — Morning):** Chrome Sync Clarification & Port 9222 Disambiguation in `chrome-profile-sync.ts` and `local-session-vault.ts`.
4. **Phase 4 (Day 2 — Afternoon):** Capsule Migration double-prefix resolution in `capsule-partition-migration.ts`.
5. **Phase 5 (Day 3):** Guarded dead-store and orphan cache cleanup (`dead-store-cleanup.ts`) + CLI switch cleanup in `index.ts`.
6. **Validation (Day 3 — Afternoon):** Execute complete test suite (`npm run compile`, `npm run typecheck`, `npm run test:main`).

#### Minimal Ship (If Only Phases 1 & 2 Were Possible)
If time or scope permits deploying only the first two phases:
- **Ship Phase 1 + Phase 2 immediately.**
- **Why this works:**
  - **Phase 1** directly resolves the user's *"lúc ăn lúc không"* symptom by guaranteeing that all sync and vault actions write into the persistent shared profile jar (`persist:profile-<profileId>`), completely eliminating accidental writes into RAM-only ephemeral tabs.
  - **Phase 2** directly resolves the user's *"rất nhanh hết"* symptom by ensuring that all cookies set by web pages or login flows are committed to SQLite WAL within 1.5 seconds, surviving crashes and hard kills.
  - Phases 3–5 can be applied subsequently as non-breaking maintenance and cleanup steps.

---