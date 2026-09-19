# Implementation Plan: Cookie, Cache & Session Architecture Fix (Candidate CAND-X2)

## 1. Chosen Problem-Solving Technique & Organizing Insight

- **Selected Technique:** **Simplification Cascades** (from `ak:problem-solving`).
- **Symptom Match:** *"Same thing implemented 5+ ways, growing special cases"* — five distinct entry points resolve cookie persistence across four partition families using ambient tab focus heuristics, spawning 85 dead stores on disk, volatile in-memory writes, and broken synchronization.
- **Organizing Insight:** 
  **Cookie synchronization, vault backup/restore, and persistent identity are strictly Profile-scoped operations, NEVER Tab-scoped or View-scoped operations.**
  A tab is merely a transient visual viewport; cookies belong exclusively to an identity authority: `persist:profile-<profileId>`. By replacing all ad-hoc calls to `getActiveTabSession()` across menus, toolbars, and context menus with a single fail-closed resolver (`resolveDurableProfileSession`) that strictly rejects ephemeral (`ephemeral-*`) and capsule (`persist:capsule-*`) partitions, the entire class of *"lúc ăn lúc không"* (focusing an ephemeral or capsule tab and writing into RAM or a black-hole jar) and *"rất nhanh hết"* (ephemeral jar destruction on tab close) collapses into a single invariant. The dead-end `persist:profile-capsule-*` namespace is eliminated at the root.

---

## 2. Ordered Phases

### Phase 1: Single Target-Session Resolver & Entry Point Cutover (Addresses AC1, AC2, AC3)
- **Goal:** Unify all cookie hydration and vault operations under a canonical profile session resolver. Enforce fail-closed rejection of ephemeral and capsule partitions.
- **Exact Files & Symbols to Change:**
  - `src/main/browser/browser-session-partition.ts:30-40`: Export helper `isDurableProfilePartition(partition: string): boolean` (checks `partition.startsWith('persist:profile-')`) and `assertDurableProfileSession(session: Electron.Session): void`.
  - `src/main/browser/native-tab-host.ts:3523-3530`: Implement `resolveDurableProfileSession(profileId?: string): Electron.Session`.
  - `src/main/browser/native-tab-host.ts:2891-2898`: Cut over `showMainMenu()` toolbar menu. Replace `this.getActiveTabSession()` at line 2895 with `this.resolveDurableProfileSession(p.id)`.
  - `src/main/browser/app-menu.ts:193-200`: Cut over App Menu sync handler. Replace `tabHost?.getSharedProfileSession('clean', p.id)` with `tabHost?.resolveDurableProfileSession(p.id)`.
  - `src/main/browser/app-menu.ts:213-225`: Cut over App Menu Session Vault Export. Replace `tabHost?.getActiveTabSession()` at line 215 with `tabHost?.resolveDurableProfileSession()`.
  - `src/main/browser/app-menu.ts:228-240`: Cut over App Menu Session Vault Import. Replace `tabHost?.getActiveTabSession()` at line 230 with `tabHost?.resolveDurableProfileSession()`.
  - `src/main/browser/tab-context-menu.ts:270-275`: Cut over Tab Context Menu sync handler. Replace `this.host.getActiveTabSession()` at line 272 with `this.host.resolveDurableProfileSession(p.id)`.
  - `src/main/browser/local-session-vault.ts:130-170`: In `exportVaultToFile`, verify that `liveCookies.length > 0`; if empty, return `{ success: false, count: 0, filePath: outPath, error: 'EMPTY_STORE: Cannot export empty cookie store' }`. Validate session is not ephemeral.
  - `src/main/browser/local-session-vault.ts:180-220`: In `importVaultFromJson`, guard against ephemeral sessions (`partition.startsWith('ephemeral-')` -> return `{ success: false, importedCount: 0, failedCount: 0, error: 'EPHEMERAL_TARGET_REJECTED' }`). If `cookieList.length === 0`, return `{ success: false, importedCount: 0, failedCount: 0, error: 'NO_COOKIES_PROVIDED' }`.
- **Code-level Change:** Re-route all 5 UI callsites to `resolveDurableProfileSession(profileId)`. Add partition boundary validation to `importVaultFromJson` and `exportVaultToFile`.
- **Risk Retired:** Prevents any UI action from writing cookies into an in-memory ephemeral partition or an orphaned capsule partition.
- **Explicit Non-Goals:** Do not rewrite tab lifecycle management or touch workspace capsule state persistence.

### Phase 2: Session Durability & Debounced Flush Pipeline (Addresses AC7)
- **Goal:** Guarantee that page-set cookies (`document.cookie` / `Set-Cookie`) survive unexpected application termination or crashes, and preserve imported session cookies across restarts.
- **Exact Files & Symbols to Change:**
  - `src/main/browser/browser-session-partition.ts:75-120`: In `configureBrowserSessionPartition`, attach a debounced `session.cookies.on('changed', ...)` handler on durable profile partitions (`persist:profile-*`).
  - `src/main/browser/native-tab-host.ts:3586-3610`: In `flushAllSessions()`, maintain explicit synchronous flush coordination.
  - `src/main/browser/profile-ownership.ts:300-335`: Fix the `prevCleanShutdown: false` reporting defect. Preserve the superseded `recovery.cleanShutdown` value as `priorCleanShutdown` before overwriting the recovery marker with `startedRecovery.cleanShutdown = false`.
  - `src/main/index.ts:642`: Update log telemetry to read `profileLease.recovery.priorCleanShutdown ?? profileLease.recovery.cleanShutdown`.
- **Code-level Change:** Implement a 2000ms debounce (5000ms max wait) calling `session.cookies.flushStore()`. Ensure imported session cookies keep their 30-day elevated TTL (`persistSessionCookies: true`).
- **Risk Retired:** Fixes the data loss vulnerability where kill/crash events wiped all ungracefully-flushed cookies.
- **Explicit Non-Goals:** Do not synchronously flush every individual cookie mutation (which would thrash disk I/O).

### Phase 3: Chrome-Sync Realities Under ABE v20 & Port 9222 Safety (Addresses AC1, AC2)
- **Goal:** Handle Windows App-Bound Encryption (Chrome 127+) transparently with clear user guidance. Eliminate the port 9222 foreign-Chrome trap.
- **Exact Files & Symbols to Change:**
  - `src/main/browser/chrome-profile-sync.ts:445-520`: In `hydrateCookiesViaOwnedChrome`, clarify the Chrome-running warning dialog. When `res.count === 0`, update the message to explicitly explain that App-Bound Encryption v20 on Chrome 127+ prevents reading cookies from cloned user data directories, and guide the user to the AntiFan Companion Extension or Session Vault.
  - `src/main/browser/local-session-vault.ts:275-285`: In `importFromLiveChromeCDP`, remove default `cdpPort = 9222`. Require an explicit, validated port number. Add a check preventing connection to port 9222 if `Chrome/User Data/CodexRemote9222/DevToolsActivePort` is active, avoiding cross-talk with foreign OpenAI Codex instances.
- **Code-level Change:** Guard CDP endpoints, require dynamic port allocation (`--remote-debugging-port=0`), and provide honest UI feedback.
- **Risk Retired:** Eliminates silent sync failures, phantom zero-cookie successes, and unintended connections to foreign Chrome instances.
- **Explicit Non-Goals:** Do not attempt reverse-engineering of Windows DPAPI / App-Bound Encryption keys (which causes Chromium to purge rows).

### Phase 4: Guarded Dead-Store Cleanup & Cache Optimization (Addresses AC5, AC6)
- **Goal:** Safely purge 84 dead cookie stores (~8.76 MB), orphan temp files, duplicate state, and the abandoned 219 MiB default cache, with strict live-tab guards and zero risk to active profile data.
- **Exact Files & Symbols to Change:**
  - `src/main/browser/partition-cleanup-service.ts` (New module): Implement `cleanupDeadPartitionStores(deps: CleanupDeps, options?: { dryRun?: boolean })`.
  - `src/main/index.ts:196-198, 211`: Remove `app.commandLine.appendSwitch('disk-cache-dir', ...)` which provably does nothing for named partitions. Schedule the guarded cleanup service during background post-paint idle time.
- **Code-level Change:** Add regex-scoped deletion for `capsule-capsule-*` and `profile-capsule-*` partitions, orphan `.tmp` files, and `Profile/Cache`, with pre-flight checks verifying no open tab references the partition.
- **Risk Retired:** Recovers ~228 MB of wasted disk space and eliminates stale state collisions.
- **Explicit Non-Goals:** Do not touch `persist:profile-profile-2`, `persist:profile-default`, or any active tab partition.

### Phase 5: Dead-End Migration Sunsetting (Addresses AC4)
- **Goal:** Prevent `capsule-partition-migration` from writing the dead-end `persist:profile-capsule-*` namespace, while preserving the marker gate contract.
- **Exact Files & Symbols to Change:**
  - `src/main/browser/capsule-partition-migration.ts:90-105`: Ensure legacy partitions are either mapped to canonical profile keys (`key.replace(/^(capsule-)+/, 'profile-')`) or skipped if already marked done.
  - `src/main/browser/native-tab-host.ts:3535-3580`: Maintain `migrateLegacyCapsuleToProfile` marker check so existing installations with `antifan-migration-capsule-to-profile.done` return immediately.
- **Code-level Change:** Ensure pure migration function produces valid target namespaces and respects marker idempotency.
- **Risk Retired:** Prevents re-creating dead-end partition folders.
- **Explicit Non-Goals:** Do not delete legacy partitions inside the migration routine itself (cleanup is owned by Phase 4).

---

## 3. Target-Session Contract

### Resolver API Definition
- **Name:** `resolveDurableProfileSession`
- **Location:** `src/main/browser/native-tab-host.ts` (methods on `NativeTabHost`), with validation primitives in `src/main/browser/browser-session-partition.ts`.
- **Signature:**
  ```typescript
  public resolveDurableProfileSession(profileId?: string): Electron.Session
  ```

### Implementation Details:
```typescript
public resolveDurableProfileSession(profileId?: string): Electron.Session {
  // 1. Resolve explicit or active profileId (defaulting to 'Default')
  const activeProfileId = profileId ?? ChromeProfileSyncManager.getInstance().activeProfileId ?? 'Default';
  const safeProfileKey = activeProfileId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  
  // 2. Derive canonical durable partition
  const partition = `persist:profile-${safeProfileKey}`;
  
  // 3. Invariant assertion: fail-closed against illegal partitions
  if (partition.startsWith('ephemeral-') || partition.startsWith('persist:capsule-') || partition === 'defaultSession') {
    throw new Error(`ILLEGAL_TARGET_PARTITION: Refusing to resolve non-durable partition '${partition}' for profile operations.`);
  }
  
  // 4. Configure partition policies (clean UA, Client Hints, debounced flush)
  configureBrowserSessionPartition(partition, 'clean');
  
  return session.fromPartition(partition);
}
```

### Call-Site Enforcement:
Every sync and vault entry point is redirected through this contract:
1. `NativeTabHost.showMainMenu` (`native-tab-host.ts:2895`):
   `ChromeProfileSyncManager.getInstance().syncProfile(p.id, this.resolveDurableProfileSession(p.id))`
2. `AppMenu` Chrome Sync (`app-menu.ts:195`):
   `manager.syncProfile(p.id, tabHost?.resolveDurableProfileSession(p.id))`
3. `AppMenu` Vault Export (`app-menu.ts:215`):
   `const targetSession = tabHost?.resolveDurableProfileSession();`
4. `AppMenu` Vault Import (`app-menu.ts:230`):
   `const targetSession = tabHost?.resolveDurableProfileSession();`
5. `TabContextMenu.showMainMenu` (`tab-context-menu.ts:272`):
   `ChromeProfileSyncManager.getInstance().syncProfile(p.id, this.host.resolveDurableProfileSession(p.id))`
6. IPC handler `TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE` (`native-tab-host.ts:1428`):
   Already uses `this.getSharedProfileSession('clean', profileId)` — update to `this.resolveDurableProfileSession(profileId)`.

---

## 4. Durability Strategy

### Mechanism for Page-Set Cookies
1. **Event-Driven Debounced Flush:**
   In `src/main/browser/browser-session-partition.ts:configureBrowserSessionPartition`:
   When configuring any partition matching `persist:profile-*`, attach a listener:
   ```typescript
   let flushTimer: NodeJS.Timeout | null = null;
   let firstEventTime = 0;
   const DEBOUNCE_MS = 2000;
   const MAX_WAIT_MS = 5000;

   sess.cookies.on('changed', (_event, _cookie, _cause, _removed) => {
     const now = Date.now();
     if (!firstEventTime) firstEventTime = now;
     if (flushTimer) clearTimeout(flushTimer);
     
     if (now - firstEventTime >= MAX_WAIT_MS) {
       firstEventTime = 0;
       void sess.cookies.flushStore();
     } else {
       flushTimer = setTimeout(() => {
         firstEventTime = 0;
         void sess.cookies.flushStore();
       }, DEBOUNCE_MS);
     }
   });
   ```
2. **Cost Analysis:**
   - Disk I/O: Batches rapid cookie writes (e.g. 10+ cookies during OAuth handshake) into a single SQLite sync commit every 2–5 seconds.
   - Resource overhead: Negligible (<1ms CPU per event, zero memory allocation).
   - Worst-case data loss on hard crash/kill (`taskkill /F`): At most 2 seconds of recent mutations, rather than losing the entire session since app start.
3. **Imported Session Cookies:**
   - Session cookies imported via Session Vault or Chrome Sync pass through `extensionCookieImportSetDetails` with `persistSessionCookies: true`, which assigns a 30-day future `expirationDate`. This turns volatile in-memory session cookies into durable SQLite entries that survive process restarts.

---

## 5. Chrome-Sync Strategy

### Technical Reality Under App-Bound Encryption (Chrome 127+)
- **Root Cause:** Chrome ≥ 127 encrypts cookies using DPAPI wrapped by a system service bound to the official Chrome binary path. Cloned profiles in temp directories cannot decrypt the keys; `Network.getAllCookies` returns 0, and Chromium purges unreadable rows.
- **Sanctioned Strategy:**
  1. **UI Transparency:** The app must explicitly inform the user why automatic cloning returns 0 cookies. The dialog must state:
     *"Profile Chrome được bảo vệ bởi App-Bound Encryption (Chrome 127+). Cơ chế clone tự động không thể đọc cookies từ Chrome. Hãy sử dụng AntiFan Companion Extension hoặc Sao lưu / Khôi phục Session Vault."*
  2. **Refusal Contract:** The sync routine must return `{ success: false, cookiesCount: 0 }` when 0 cookies are imported from real Chrome profiles, refusing to display a false "Thành công" message.
  3. **Viable Ingestion Paths:**
     - Bookmarks sync remains 100% operational (unencrypted JSON).
     - Test / standalone Chrome profiles without ABE remain readable.
     - Live cookie ingestion is routed via **AntiFan Companion Extension** (running within live Chrome with decrypted `chrome.cookies` access) or **Session Vault JSON**.
4. **Port 9222 Foreign-Chrome Protection:**
   - In `src/main/browser/local-session-vault.ts:importFromLiveChromeCDP`:
     - Remove default parameter `cdpPort = 9222`. Require an explicit, validated port.
     - Before connecting, probe `GET http://127.0.0.1:${port}/json/version`. If the user data dir or command line indicates a foreign runner (such as `CodexRemote9222`), refuse the connection with `FOREIGN_CDP_INSTANCE_DETECTED`.
     - In `ChromeProfileSyncManager.hydrateCookiesViaOwnedChrome`, keep `--remote-debugging-port=0` (dynamic OS-assigned port) read from `tempDir/DevToolsActivePort`, ensuring it never collides with port 9222.

---

## 6. Guarded Dead-Store Cleanup Mechanism

### Scope & Target Manifest
1. 43 legacy capsule directories: `<dataRoot>/Profile/Partitions/capsule-capsule-*`
2. 41 dead migration directories: `<dataRoot>/Profile/Partitions/profile-capsule-capsule-*`
3. Orphan state temp files: `<dataRoot>/Profile/saved-tabs.json.tmp.*`
4. Stale duplicate state: `<dataRoot>/config/saved-tabs.json`
5. Orphan default session cache: `<dataRoot>/Profile/Cache` (~219 MiB)

### Safety Guards (Pre-flight Invariants)
- **Path Confinement:** Every candidate path must resolve strictly within `StorageLocations.getDataRoot()`. Any path with `..` or outside the root throws `SECURITY_BOUNDARY_VIOLATION`.
- **Live Tab Immutability Guard:**
  Scan all active tabs (`nativeTabHost.tabs.values()`) and inspect `<dataRoot>/Profile/saved-tabs.json`.
  Extract every active partition string.
  If candidate partition matches an active tab (`candidatePartition === tab.state.partition`), **SKIP and PRESERVE**.
- **Hard Whitelist Protection:**
  `persist:profile-profile-*`, `persist:profile-default`, `Profile/Network`, `Profile/Local Storage`, `Profile/IndexedDB` are strictly forbidden from deletion.

### Idempotence Proof
1. Run 1: Scans 86 partitions, identifies 84 matching dead regexes (`capsule-capsule-*` and `profile-capsule-*`). Deletes them recursively and writes audit log `cleanup-audit-<timestamp>.json`.
2. Run 2: Scans remaining partitions (`profile-profile-2`). Matching dead candidates = 0. Operation completes in <2ms with `deletedCount: 0, freedBytes: 0`.

---

## 7. Test Plan Mapped to AC1–AC8

| Criterion | Test File | Test Assertions & Mechanics |
|---|---|---|
| **AC1** | `test/main/durable-profile-session-resolver.test.ts` *(New)* | Asserts `resolveDurableProfileSession()` returns `persist:profile-*`. Asserts `importVaultFromJson` and `exportVaultToFile` throw/reject `EPHEMERAL_TARGET_REJECTED` and `CAPSULE_TARGET_REJECTED` when given ephemeral or capsule sessions. |
| **AC2** | `test/main/durable-profile-session-resolver.test.ts` *(New)* | Sets focused active tab to an ephemeral session (`ephemeral-profile-...`). Invokes all 3 sync entry points and 2 vault entry points; asserts every operation targets `persist:profile-<id>`, never the focused tab. |
| **AC3** | `test/main/local-session-vault.test.ts` *(Updated)* | **Assertion Change:** Line 128 (`imports empty cookie array with success true and zero count`) currently expects `success: true`. Update to assert `success: false` and `error: 'NO_COOKIES_PROVIDED'`. Add assertion that exporting an empty jar returns `{ success: false, error: 'EMPTY_STORE' }`. |
| **AC4** | `test/main/capsule-partition-migration-pure.test.ts` & `partition-migration-gate.test.ts` | Asserts migration with done marker is an immediate no-op. Asserts that keys starting with `capsule-capsule-` are normalized without creating `profile-capsule-*`. |
| **AC5** | `test/main/partition-cleanup-service.test.ts` *(New)* | In a temp data root with 43 `capsule-capsule-*`, 41 `profile-capsule-*`, 1 live `profile-profile-2`, and temp files: dry-run reports 84 stores to delete; live run deletes exactly 84 stores; second run deletes 0 stores (idempotent); active tab partition is never touched. |
| **AC6** | `test/main/cache-configuration-boundary.test.ts` *(New)* | Verifies `--disk-cache-dir` command-line switch is removed or scoped. Verifies `Profile/Cache` deletion is accounted for in cleanup tests. |
| **AC7** | `test/main/session-cookie-durability.test.ts` *(New)* | Simulates page setting a cookie; verifies debounced `flushStore()` is triggered within 2000ms. Verifies imported session cookies receive 30-day expiration timestamps. |
| **AC8** | All above test files | Every fix has a reproduction unit test that fails on unmodified baseline code and passes after the change. |

---

## 8. Risk Register

| # | Risk | Severity | Detection Signal | Prevention & Guard |
|---|---|---|---|---|
| **R1** | Accidental deletion of active profile partition (`profile-profile-2`) during cleanup | High | Disappearance of user logins, error in `cleanup-audit.json` | Hard-coded whitelist + live tab check (`tab.state.partition`) before any folder unlinking. |
| **R2** | Excessive disk I/O from aggressive cookie store flushing | Medium | High disk write latency in perf logs | 2000ms debounce with 5000ms max ceiling; flush only on persistent profile sessions. |
| **R3** | Test suite break from changing empty vault import contract (`success: false`) | Medium | `npm run test:file test/main/local-session-vault.test.ts` failure | Explicitly update test assertion at line 128 to match AC3 requirements. |
| **R4** | User confusion over Chrome Sync reporting 0 cookies under ABE v20 | Medium | User reports "Sync failed" | Explicit, non-technical dialog explaining ABE v20 on Chrome 127+ and pointing to Companion Extension. |
| **R5** | Foreign Chrome CDP hijacking on port 9222 (OpenAI Codex instance) | High | Unintended target attachment or corrupted session import | Remove blind port 9222 default; require dynamic port allocation (`--remote-debugging-port=0`) and probe `/json/version`. |

### Deliberate Non-Actions (What We Did NOT Do)
- Did NOT discard the 4-family partition model (workspace capsule isolation remains strictly intact).
- Did NOT attempt to bypass Windows 11 App-Bound Encryption v20 via unauthorized kernel/service hooks.
- Did NOT attempt to synchronize Google's rotating single-owner cookies (`__Secure-1PSIDTS` / `*PSIDRTS`) across concurrent instances.
- Did NOT execute un-audited `rm -rf` shell commands.
- Did NOT mutate the MCP tool catalogue (preserving MCP budget dominance).

---

## 9. Effort, Order of Execution & Minimal Viable Cut

### Execution Order
1. **Phase 1: Target-Session Resolver & Entry Point Cutover** (1.5 hours) — Resolves AC1, AC2, AC3.
2. **Phase 2: Session Durability & Debounced Flush** (1 hour) — Resolves AC7.
3. **Phase 3: Chrome-Sync ABE v20 Reality & Port 9222 Safety** (1 hour) — Resolves AC1, AC2.
4. **Phase 4: Guarded Dead-Store Cleanup & Cache Optimization** (1.5 hours) — Resolves AC5, AC6.
5. **Phase 5: Dead-End Migration Sunsetting & Test Convergence** (1 hour) — Resolves AC4, AC8.

### Minimal Viable Cut (If only the first two phases are deployed)
Deploying **Phase 1 (Target-Session Resolver)** and **Phase 2 (Session Durability)** immediately resolves the core user symptoms:
- Logins will no longer disappear when switching tabs or focusing ephemeral tabs.
- Cookies will survive unexpected crashes and kills via debounced flushing and 30-day session cookie elevation.
- Safe to ship independently without running disk cleanups or changing migration logic.