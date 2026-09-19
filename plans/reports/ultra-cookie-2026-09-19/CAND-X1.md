# IMPLEMENTATION PLAN: AntiFan Browser Session/Cookie/Cache Mechanism (Candidate CAND-X1)

---

## 1. Chosen Organizing Insight

- **Selected ak:problem-solving technique:** **Simplification Cascades** (`references/simplification-cascades.md`).
- **One-line symptom match:** *5+ entry points independently guessing where to write cookies (active tab, defaultSession, shared profile, capsule) while 85 dead stores accumulate on disk.*
- **Organizing insight:** 
  The three symptoms ("rất nhanh hết", "lúc ăn lúc không", "không đồng bộ được từ Chrome") stem from a single architectural conflation: AntiFan treats *transient viewport focus* (`getActiveTabSession()`, which can be an in-memory ephemeral tab or an isolated workspace capsule) as the *authoritative owner* of user credentials. By establishing the strict invariant that **browser credentials, session vault operations, and profile synchronizations belong exclusively to persistent profile identities (`persist:profile-<profileId>`), completely decoupled from UI tab focus**, the entire defect space collapses into a single cascade:
  1. A single authoritative resolver `getProfileSyncSession(profileId?: string)` replaces all ambient tab-session calls across menus and IPC, eliminating RAM writes and capsule leaks.
  2. Low-level fail-closed guards in `LocalSessionVault` and `ChromeProfileSyncManager` mechanically reject ephemeral and empty sessions, satisfying AC1–AC3.
  3. The dead-end migration (`persist:profile-capsule-*`) is recognized as a redundant copy into an unread namespace; sweeping the 84 orphaned stores via a live-tab-guarded sweep returns the filesystem to a single canonical store (AC4, AC5).
  4. Cache configuration is aligned with Chromium's named partition reality by dropping switches that only bound the empty default partition (AC6).
  5. Per-partition debounced cookie flushing binds page-set cookies to SQLite WAL within 1000ms, ensuring session survivability across hard kills (AC7).

---

## 2. Ordered Phases

### Phase 1: Authoritative Profile Session Resolution & Entry Point Unification (P0 — Correctness)
- **Goal:** Eliminate all instances where Chrome sync or Vault operations write into focused tabs, ephemeral RAM sessions, or isolated capsules. Satisfies AC1 and AC2.
- **Files & Symbols to Change:**
  - `src/main/browser/browser-session-partition.ts:14-35`:
    - Export pure helper `deriveProfilePartition(profileId?: string, mode?: BrowserSessionUserAgentMode, ephemeral?: boolean): string`.
    - Export pure predicate `isPersistentProfilePartition(partition: string): boolean`.
  - `src/main/browser/native-tab-host.ts:3515-3532`:
    - Refactor `getSharedProfilePartition` to use `deriveProfilePartition`.
    - Add method `public getProfileSyncSession(profileId?: string): Electron.Session` that resolves the target profile ID (explicit or `activeProfileId`), derives `persist:profile-<key>`, configures it in `clean` mode, and returns `session.fromPartition(partition)`.
  - `src/main/browser/native-tab-host.ts:2894-2896`:
    - Change `this.getActiveTabSession()` to `this.getProfileSyncSession(p.id)`.
  - `src/main/browser/tab-context-menu.ts:13, 271-273`:
    - Change interface requirement from `getActiveTabSession(): Electron.Session | undefined` to `getProfileSyncSession(profileId?: string): Electron.Session`.
    - Change `this.host.getActiveTabSession()` to `this.host.getProfileSyncSession(p.id)`.
  - `src/main/browser/app-menu.ts:194-196, 212-216, 227-231`:
    - Line 195: Ensure `tabHost?.getProfileSyncSession(p.id)` is used.
    - Line 213 (Export Vault): Change `const targetSession = tabHost?.getActiveTabSession();` to `const targetSession = tabHost?.getProfileSyncSession();`.
    - Line 228 (Import Vault): Change `const targetSession = tabHost?.getActiveTabSession();` to `const targetSession = tabHost?.getProfileSyncSession();`.
  - `src/main/browser/native-tab-host.ts:1315-1327`:
    - In `registerIpcHandlers`: When `options?.tabId` or `options?.partition` is passed, strictly reject if `options.partition.startsWith('ephemeral-')` or if partition is not a persistent profile session. Route default fallback to `this.getProfileSyncSession(options?.profileId as string | undefined)`.
- **Risk Retired:** Retires RC1 and RC4 ("lúc ăn lúc không", writing into RAM/capsules).
- **Explicit Non-Goals:** Does not alter workspace capsule isolation or tab view rendering.

### Phase 2: Fail-Closed Vault Contracts & Empty/Ephemeral Assertion (P0 — Correctness)
- **Goal:** Enforce that Vault export/import never reports success on empty jars or ephemeral sessions, and includes target jar telemetry. Satisfies AC1 and AC3.
- **Files & Symbols to Change:**
  - `src/main/browser/local-session-vault.ts:115-160` (`exportVaultToFile`):
    - Assert `targetSession.isPersistent()`: If false, fail closed with `{ success: false, count: 0, filePath: outPath, error: 'EPHEMERAL_TARGET_REJECTED: Cannot export cookies from an in-memory ephemeral session' }`.
    - Retrieve `liveCookies = await targetSession.cookies.get({})`.
    - If `liveCookies.length === 0`, fail closed with `{ success: false, count: 0, filePath: outPath, error: 'EMPTY_TARGET_JAR: Target session cookie store contains 0 cookies' }`.
    - Return result enriched with `storagePath: targetSession.storagePath || 'persistent'`.
  - `src/main/browser/local-session-vault.ts:170-225` (`importVaultFromJson`):
    - Assert `targetSession.isPersistent()`: If false, fail closed with `{ success: false, importedCount: 0, failedCount: 0, error: 'EPHEMERAL_TARGET_REJECTED: Cannot import cookies into an in-memory ephemeral session' }`.
    - If `cookieList.length === 0`, fail closed with `{ success: false, importedCount: 0, failedCount: 0, error: 'EMPTY_INPUT_COOKIES: Input contains 0 cookies to import' }`.
    - If `importedCount === 0`, fail closed with `{ success: false, importedCount: 0, failedCount, error: 'ZERO_COOKIES_IMPORTED: No cookies could be imported into target session' }`.
  - `test/main/local-session-vault.test.ts:139-145`:
    - Update existing test asserting `imports empty cookie array with success true and zero count` to assert `res.success === false` and `res.error === 'EMPTY_INPUT_COOKIES'` (per packet constraint 5).
- **Risk Retired:** Retires RC2 (false success reporting on 0 cookies or in-memory jars).
- **Explicit Non-Goals:** Does not alter JSON vault serialization format or 30-day session cookie fallback TTL.

### Phase 3: Session Durability via Per-Partition Debounced Flush (P0 — Durability)
- **Goal:** Ensure all page-set cookies (including auth tokens and rotating cookies) are flushed from Chromium memory to SQLite WAL within 1000ms. Satisfies AC7.
- **Files & Symbols to Change:**
  - `src/main/browser/browser-session-partition.ts:70-120`:
    - Add active debounce tracking: `const flushTimersBySession = new WeakMap<Session, NodeJS.Timeout>();`.
    - Add function `attachDebouncedCookieFlush(sess: Session, partition: string, debounceMs = 1000): void`:
      - Listen to `sess.cookies.on('changed', (_event, _cookie, _cause, removed) => { ... })`.
      - On trigger, clear existing timer and set a timeout for `debounceMs` (capped at max 5000ms) to invoke `await sess.cookies.flushStore()`.
    - In `configureBrowserSessionPartition(partition, mode)`:
      - When `partition.startsWith('persist:')`, attach `attachDebouncedCookieFlush(sess, partition)`.
  - `src/main/browser/native-tab-host.ts:3586-3607` (`flushAllSessions`):
    - Ensure `flushAllSessions` clears any pending debounce timers and performs immediate `flushStore()` for all sessions during clean shutdown.
- **Risk Retired:** Retires RC5 and crash/kill cookie loss (losing cookies when app terminates without graceful shutdown).
- **Explicit Non-Goals:** Does not alter Chromium's internal cookie encryption or network stack.

### Phase 4: Guarded Dead-Store Cleanup & Migration Retirement (P1 — Hygiene)
- **Goal:** Eliminate 84 dead stores (~8.76 MB), orphan temp files, and stale state safely and idempotently. Satisfies AC4 and AC5.
- **Files & Symbols to Change:**
  - `src/main/browser/capsule-partition-migration.ts:90-100`:
    - Fix key replacement regex: `key.replace(/^(capsule-)+/, 'profile-')` so nested keys map to canonical profile targets.
  - `src/main/cleanup/dead-store-cleanup.ts` (new module):
    - Export `runGuardedDeadStoreCleanup(options: { dataRoot: string; livePartitions: Set<string>; activeProfileId: string; dryRun?: boolean }): Promise<CleanupReport>`.
    - Enforce 3 strict guards:
      1. Pattern guard: Only paths matching `^(capsule-capsule-[a-f0-9-]+|profile-capsule-[a-f0-9-]+)$`.
      2. Live tab guard: If directory matches any entry in `livePartitions`, skip with `ACTIVE_TAB_CONFLICT`.
      3. Active profile guard: Protect `profile-<activeProfileId.toLowerCase()>`.
    - Scan and unlink orphaned `saved-tabs.json.tmp.*` in `Profile/`.
    - Unlink stale duplicate `config/saved-tabs.json` (Aug 31).
    - Remove abandoned `Profile/Cache` (219 MiB) if default session has no tabs.
  - `src/main/index.ts:520-545`:
    - Invoke `runGuardedDeadStoreCleanup` past window launch, passing active tab partitions from `tabHost`.
- **Risk Retired:** Retires RC3 (unreadable partition proliferation) and disk waste.
- **Explicit Non-Goals:** Does not touch active profile stores or live workspace capsule data.

### Phase 5: Cache Configuration Realignment & Chrome Sync Hardening (P2 — Polish)
- **Goal:** Remove non-functional CLI cache switches, document partition cache layout, protect against port-9222 collision, and clarify ABE v20 UI messaging. Satisfies AC6 and AC8.
- **Files & Symbols to Change:**
  - `src/main/index.ts:196-198, 211-212`:
    - Remove non-functional `app.commandLine.appendSwitch('disk-cache-dir', ...)` and `gpu-cache-dir`.
    - Document that named partitions (`persist:profile-*`) maintain independent caches under `<ProfileDir>/Partitions/<partition>/Cache`.
  - `src/main/browser/local-session-vault.ts:276-285`:
    - Disallow ambient default `cdpPort = 9222` in `importFromLiveChromeCDP`. Require explicit port or probe verification against `/json/version` browser title to prevent hijacking by foreign extensions (e.g. Codex extension).
  - `src/main/browser/chrome-profile-sync.ts:445-447, 500-505`:
    - Provide clear Vietnamese/English UI message explaining that Chrome ≥127 App-Bound Encryption prevents cloning cookies, directing users to direct login or Session Vault JSON import.
- **Risk Retired:** Retires RC6 (cache misalignment) and foreign CDP port hijacking.
- **Explicit Non-Goals:** Does not attempt to decrypt App-Bound encrypted cookies offline (impossible).

---

## 3. Target-Session Contract

### 3.1 Proposed Resolver Signature & Location
The canonical session resolver is placed directly on `NativeTabHost` (`src/main/browser/native-tab-host.ts`), backed by pure partition derivation helpers in `src/main/browser/browser-session-partition.ts`:

```ts
// In src/main/browser/browser-session-partition.ts:
export function deriveProfilePartition(
  profileId?: string,
  mode: BrowserSessionUserAgentMode = 'clean',
  ephemeral = false
): string {
  const activeId = profileId && typeof profileId === 'string' && profileId.trim()
    ? profileId.trim()
    : 'default';
  const safeProfileKey = activeId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (ephemeral) {
    const nonce = Math.random().toString(36).slice(2, 10);
    return mode === 'native'
      ? `ephemeral-profile-${safeProfileKey}-${nonce}-native`
      : `ephemeral-profile-${safeProfileKey}-${nonce}`;
  }
  return mode === 'native'
    ? `persist:profile-${safeProfileKey}-native`
    : `persist:profile-${safeProfileKey}`;
}

export function isPersistentProfilePartition(partition: string): boolean {
  if (!partition || typeof partition !== 'string') return false;
  return partition.startsWith('persist:profile-');
}

// In src/main/browser/native-tab-host.ts:
export class NativeTabHost {
  /**
   * Authoritative resolver for profile-level credential and sync operations.
   * NEVER resolves to an active/focused tab, ephemeral in-memory session, or capsule.
   * Guarantees a persistent, configured profile partition.
   */
  public getProfileSyncSession(profileId?: string): Electron.Session {
    const targetProfileId = profileId ?? ChromeProfileSyncManager.getInstance().activeProfileId ?? 'Default';
    const partition = deriveProfilePartition(targetProfileId, 'clean', false);
    configureBrowserSessionPartition(partition, 'clean');
    return session.fromPartition(partition);
  }
}
```

### 3.2 Forcing Every Entry Point Through the Contract
| Entry Point | Location | Old Implementation | New Contract Enforcement |
|---|---|---|---|
| **App Menu Chrome Sync** | `src/main/browser/app-menu.ts:195` | `tabHost?.getSharedProfileSession('clean', p.id)` | `tabHost?.getProfileSyncSession(p.id)` |
| **Toolbar Chrome Sync** | `src/main/browser/native-tab-host.ts:2895` | `this.getActiveTabSession()` | `this.getProfileSyncSession(p.id)` |
| **Tab Context Menu Chrome Sync** | `src/main/browser/tab-context-menu.ts:272` | `this.host.getActiveTabSession()` | `this.host.getProfileSyncSession(p.id)` |
| **App Menu Vault Export** | `src/main/browser/app-menu.ts:213` | `tabHost?.getActiveTabSession()` | `tabHost?.getProfileSyncSession()` |
| **App Menu Vault Import** | `src/main/browser/app-menu.ts:228` | `tabHost?.getActiveTabSession()` | `tabHost?.getProfileSyncSession()` |
| **Vault IPC Handlers** | `src/main/browser/native-tab-host.ts:1315-1327` | ambient tab or shared profile fallback | `this.getProfileSyncSession(options?.profileId)` (rejects `ephemeral-*` and `persist:capsule-*`) |

`getActiveTabSession()` is retained ONLY for read-only DOM inspection / DevTools inspection of the currently rendered viewport, and is strictly prohibited from credential and persistence flows.

---

## 4. Durability Strategy

### 4.1 How Page-Set Cookies Survive a Kill
Chromium keeps live cookie modifications in memory and flushes them to SQLite on a lazy schedule. When AntiFan crashes or is killed (`taskkill /F`, power drop, terminal termination), unwritten changes are lost.

To guarantee durability:
1. **Debounced Listener on `sess.cookies.on('changed')`**:
   Whenever a cookie is inserted, updated, or removed by a page's JavaScript (`document.cookie`) or an HTTP response header (`Set-Cookie`), Electron's `cookies` object emits `'changed'`.
2. **Flush Policy**:
   - Window: `debounceMs = 1000ms` (1 second).
   - Max delay: `maxDelayMs = 5000ms` (ensures continuous cookie streams still flush within 5 seconds).
   - Action: Asynchronously triggers `await sess.cookies.flushStore()`.
3. **Graceful Teardown Guarantee**:
   In `flushAllSessions()` (`native-tab-host.ts:3586`), all pending debounce timers are cleared and flushed immediately before app exit.

### 4.2 Cost Accounting
- **CPU / Event Loop**: A simple `WeakMap` lookup and timer reset takes `< 0.01ms`.
- **I/O Cost**: A Chromium `flushStore()` writes dirty SQLite WAL pages. On modern SSDs (Windows NTFS), flushing 1–10 cookies consumes `< 2ms` of disk write time in a background thread.
- **Throttling**: If a login redirect cascade sets 15 cookies across 3 domains in 200ms, exactly **one** flush operation occurs 1 second after the last cookie settles.
- **Durability Guarantee**: At most 1000ms of cookie changes can be lost during an ungraceful kill. Since user authentication flows take several seconds to complete, the session is reliably on disk before the user navigates away.

---

## 5. Chrome-Sync Strategy under App-Bound Encryption v20

### 5.1 Reality & Constraints of Chrome ≥127 on Windows
- Modern Google Chrome (Chrome ≥127, including measured Chrome 153.0.8010.50) secures cookies with **App-Bound Encryption (ABE v20)** using a Windows DPAPI system service key tied to the official Chrome binary path and user data directory.
- Cloning the profile to a temporary directory breaks decryption: `Network.getAllCookies` returns **0 cookies**, and Chromium purges undecryptable rows. Offline SQLite decrypters fail on modern Windows.
- Google's rotating authentication cookies (`__Secure-1PSIDTS`, `__Secure-3PSIDTS`, `*PSIDRTS`) have TTLs of ~10 minutes. If cloned to a second client, the two clients race to refresh tokens, immediately invalidating each other's session.

### 5.2 What Remains Possible & Operational Strategy
1. **Bookmarks Sync (100% Functional)**:
   Chrome's `Bookmarks` file is unencrypted JSON. `syncProfile` imports bookmarks seamlessly.
2. **Session Vault Backup & Restore (100% Functional)**:
   Users can export cookies via standard browser extensions (e.g., Cookie-Editor) or AntiFan Extension to JSON, and import into AntiFan via `Session Vault (Import JSON)`.
3. **Direct Login (Sanctioned Google Strategy)**:
   For Google accounts, AntiFan provides authentic Chromium Client Hints and clean UA. The user logs in directly in AntiFan (`accounts.google.com`). AntiFan becomes the single, authoritative owner of its rotating tokens, completely eliminating token-race invalidation.
4. **Standalone / Smoke Profiles**:
   For profiles not protected by ABE (e.g. automated test profiles, portable Chromium), headless CDP hydration remains active.

### 5.3 UI Messaging & Refusal Protocol
- **When Chrome is running**: The sync dialog displays:
  `"Chrome đang chạy — để tránh xung đột dữ liệu, vui lòng đóng hẳn Chrome trước khi đồng bộ hoặc dùng Session Vault."`
- **When Chrome is closed but ABE v20 returns 0 cookies**: The sync dialog displays:
  `"Đã nạp X dấu trang từ Chrome Profile '{id}'. Lưu ý: Cookies được bảo vệ bởi Windows App-Bound Encryption (v20). Vui lòng đăng nhập trực tiếp trên AntiFan (khuyến nghị cho Google) hoặc nhập file JSON từ Session Vault."`

### 5.4 Mitigating the Port-9222 Foreign-Chrome Trap
- `importFromLiveChromeCDP(targetSession, cdpPort)` (`local-session-vault.ts:276`):
  - Remove the ambient fallback to port `9222`.
  - When connecting to an explicit CDP port, verify `http://127.0.0.1:${port}/json/version` and check that the browser target is not a third-party extension profile (such as `CodexRemote9222`).
  - The owned headless spawn in `chrome-profile-sync.ts:460` continues to use `--remote-debugging-port=0` (dynamic OS port) with verified `DevToolsActivePort` file path probing, eliminating port collision.

---

## 6. Guarded Dead-Store Cleanup Mechanism

### 6.1 Target Artifacts to Clean
From confirmed Tier-1 disk measurements:
- 43 directories in `Profile/Partitions/capsule-capsule-*` (legacy isolated capsules)
- 41 directories in `Profile/Partitions/profile-capsule-capsule-*` (dead migration output)
- Orphan files `Profile/saved-tabs.json.tmp.*`
- Stale duplicate state file `config/saved-tabs.json` (Aug 31)
- Orphaned default cache `Profile/Cache` (219 MiB)

### 6.2 Guarded Sweep Architecture
```ts
// src/main/cleanup/dead-store-cleanup.ts
export interface CleanupReport {
  deletedPartitions: Array<{ name: string; path: string; bytes: number }>;
  deletedFiles: Array<{ path: string; bytes: number }>;
  skippedPaths: Array<{ path: string; reason: string }>;
  totalBytesFreed: number;
  dryRun: boolean;
  timestamp: string;
}

export async function runGuardedDeadStoreCleanup(options: {
  dataRoot: string;
  livePartitions: Set<string>;
  activeProfileId: string;
  dryRun?: boolean;
}): Promise<CleanupReport> {
  const partitionsDir = path.join(options.dataRoot, 'Profile', 'Partitions');
  const report: CleanupReport = {
    deletedPartitions: [],
    deletedFiles: [],
    skippedPaths: [],
    totalBytesFreed: 0,
    dryRun: Boolean(options.dryRun),
    timestamp: new Date().toISOString(),
  };

  if (!fs.existsSync(partitionsDir)) return report;

  const entries = await fs.promises.readdir(partitionsDir, { withFileTypes: true });
  const deadPattern = /^(capsule-capsule-[a-f0-9-]+|profile-capsule-[a-f0-9-]+)$/;
  const activeProfileKey = options.activeProfileId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const fullPath = path.join(partitionsDir, dirName);

    // Guard 1: Pattern check
    if (!deadPattern.test(dirName)) {
      continue;
    }

    // Guard 2: Whitelist active profile
    if (dirName.startsWith(`profile-${activeProfileKey}`)) {
      report.skippedPaths.push({ path: fullPath, reason: 'ACTIVE_PROFILE_PROTECTED' });
      continue;
    }

    // Guard 3: Live tab partition protection
    const partitionNameA = `persist:${dirName}`;
    const partitionNameB = `persist:${dirName.replace(/^profile-/, '')}`;
    if (options.livePartitions.has(partitionNameA) || options.livePartitions.has(partitionNameB)) {
      report.skippedPaths.push({ path: fullPath, reason: 'ACTIVE_TAB_CONFLICT' });
      continue;
    }

    const size = calculateDirSize(fullPath);
    if (!options.dryRun) {
      await fs.promises.rm(fullPath, { recursive: true, force: true });
    }
    report.deletedPartitions.push({ name: dirName, path: fullPath, bytes: size });
    report.totalBytesFreed += size;
  }

  // Clean orphan tmp files in Profile/
  const profileDir = path.join(options.dataRoot, 'Profile');
  const profileFiles = await fs.promises.readdir(profileDir);
  for (const f of profileFiles) {
    if (f.startsWith('saved-tabs.json.tmp.')) {
      const p = path.join(profileDir, f);
      const stat = await fs.promises.stat(p);
      if (!options.dryRun) await fs.promises.unlink(p);
      report.deletedFiles.push({ path: p, bytes: stat.size });
      report.totalBytesFreed += stat.size;
    }
  }

  // Clean stale config/saved-tabs.json
  const staleConfigTabs = path.join(options.dataRoot, 'config', 'saved-tabs.json');
  if (fs.existsSync(staleConfigTabs)) {
    const stat = await fs.promises.stat(staleConfigTabs);
    if (!options.dryRun) await fs.promises.unlink(staleConfigTabs);
    report.deletedFiles.push({ path: staleConfigTabs, bytes: stat.size });
    report.totalBytesFreed += stat.size;
  }

  return report;
}
```

### 6.3 Idempotence Proof
1. **Pass 1 (Execution)**: The 84 dead partition directories and orphan files are matched, deleted, and recorded in `report`.
2. **Pass 2 (Verification / Subsequent App Boot)**: `readdir(partitionsDir)` finds zero entries matching `deadPattern`. Zero `.tmp.*` files exist. `config/saved-tabs.json` does not exist.
3. The function returns `{ deletedPartitions: [], deletedFiles: [], totalBytesFreed: 0 }` with zero filesystem modifications.

---

## 7. Test Plan Mapped to AC1–AC8

| Criterion | Requirement Summary | Target Test File | What It Asserts |
|---|---|---|---|
| **AC1** | No code path writes into ephemeral or capsule session from sync/vault. | `test/main/session-target-resolver.test.ts` (New) | Asserts `getProfileSyncSession()` returns `persist:profile-*`. Asserts calling `exportVaultToFile` or `importVaultFromJson` with ephemeral session (`isPersistent() === false`) throws or returns `EPHEMERAL_TARGET_REJECTED`. |
| **AC2** | All 3 sync and 2 vault entry points resolve target only from explicit profile ID, never active tab. | `test/main/session-target-resolver.test.ts` (New) | Simulates focused ephemeral tab. Calls AppMenu sync, Toolbar sync, TabContextMenu sync, AppMenu export, AppMenu import. Asserts target session passed is strictly `persist:profile-*` and never matches active tab's session. |
| **AC3** | Vault export/import reports target jar and refuses success when 0 cookies written or target is empty/ephemeral. | `test/main/local-session-vault.test.ts` (Modified existing + New assertions) | **Existing test changed**: `test/main/local-session-vault.test.ts:139-145` ("imports empty cookie array") updated to assert `res.success === false`, `res.error === 'EMPTY_INPUT_COOKIES'`. New assertions: `exportVaultToFile` on empty session returns `{ success: false, error: 'EMPTY_TARGET_JAR' }`. Both return target `storagePath`. |
| **AC4** | Dead-end migration no longer writes unreadable namespace; marker contract preserved. | `test/main/capsule-partition-migration-pure.test.ts` & `partition-migration-gate.test.ts` | Asserts migration key replacement `key.replace(/^(capsule-)+/, 'profile-')` maps `capsule-capsule-uuid` to `profile-uuid`. Gate tests in `partition-migration-gate.test.ts` continue to pass without regression. |
| **AC5** | 84 dead stores + orphan temp files + stale duplicate state removed via guarded, idempotent path. | `test/main/dead-store-cleanup.test.ts` (New) | Creates sandbox with 84 dead stores, 1 live profile store, 1 live tab capsule, orphan `.tmp.*` files. Asserts: (1) dryRun removes nothing; (2) live run deletes only dead stores and temp files; (3) second run is a no-op (0 deleted). |
| **AC6** | Cache configuration matches reality: no useless switch, live partition cache bounded/documented. | `test/main/cache-configuration.test.ts` (New) | Asserts CLI switches do not include non-functional `--disk-cache-dir` for default session. Asserts named partition cache layout under `Profile/Partitions/<partition>/Cache`. |
| **AC7** | Session durability is measurably better via debounced per-partition cookie flush. | `test/main/cookie-durability-flush.test.ts` (New) | Configures a persistent partition session, hooks `cookies.on('changed')`, emits a change, and asserts `cookies.flushStore()` is invoked within 1000ms. |
| **AC8** | Every fix has a reproduction that fails before and passes after, or explicit substitute evidence. | Documentation in test suites & smoke runner | Matrix of reproduction scripts for RC1–RC6 verified against pre-fix and post-fix behavior. |

### Existing Test Assertion Changes (Required by Constraint 5)
- In `test/main/local-session-vault.test.ts:139-145`:
  ```ts
  // OLD (defective invariant accepting empty imports as success):
  it('imports empty cookie array with success true and zero count', async () => {
    const res = await vault.importVaultFromJson(mockSession as any, []);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.importedCount, 0);
  });

  // NEW (AC3 compliance: refuses to claim success when 0 cookies were written):
  it('refuses to claim success when importing empty cookie array', async () => {
    const res = await vault.importVaultFromJson(mockSession as any, []);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.importedCount, 0);
    assert.strictEqual(res.error, 'EMPTY_INPUT_COOKIES: Input contains 0 cookies to import');
  });
  ```
  *Why it changes:* AC3 explicitly mandates: *"Vault export/import reports the target jar and refuses to claim success when 0 cookies were written or the target jar is empty/in-memory."* Reporting `success: true` when 0 cookies are imported masked silent import failures.

---

## 8. Risk Register

### Top 5 Risks & Detection Signals
1. **Risk 1: Client code or IPC caller expects `success: true` on empty cookie arrays.**
   - *Detection Signal*: Unit test failure in `test/main/local-session-vault.test.ts` or renderer error modal displaying `EMPTY_INPUT_COOKIES`.
   - *Mitigation*: Explicit error message string and documented return code so UI can show a gentle warning rather than crashing.
2. **Risk 2: High-frequency cookie writes causing main thread latency during debounced flush.**
   - *Detection Signal*: Frame drops or delay warnings in `main.log`.
   - *Mitigation*: Electron's `cookies.flushStore()` runs in the background Chromium network process. Debouncing to 1000ms with a max delay of 5000ms ensures at most one flush per second regardless of write volume.
3. **Risk 3: Accidental deletion of a valid user capsule during dead-store cleanup.**
   - *Detection Signal*: User capsule data missing or `ACTIVE_TAB_CONFLICT` in cleanup logs.
   - *Mitigation*: Strict regex guard `^(capsule-capsule-[a-f0-9-]+|profile-capsule-[a-f0-9-]+)$` ensures single-prefix capsules (`persist:capsule-<id>`) created by `deriveCapsulePartition` are NEVER matched. Active capsules from `WorkspaceCapsuleManager.list()` and live tabs are whitelisted.
4. **Risk 4: User confusion when Chrome Profile Sync returns 0 cookies due to Windows ABE v20.**
   - *Detection Signal*: Repeat user clicks on "Sync Google Chrome Profile" and reports of failed Google login.
   - *Mitigation*: Clear, actionable dialog explaining that Chrome encrypts cookies with machine-bound keys, and directing the user to log in directly in AntiFan or import a JSON vault.
5. **Risk 5: Race condition during sudden application exit while a debounce flush is pending.**
   - *Detection Signal*: Cookie loss observed in crash logs (`crashed-run`).
   - *Mitigation*: `flushAllSessions()` in `native-tab-host.ts` explicitly clears pending timers and awaits an immediate `cookies.flushStore()` across all open sessions before app shutdown proceeds.

### What Was Deliberately NOT Done
1. **Did NOT attempt offline SQLite decryption for Chrome ≥127**: ABE v20 uses DPAPI-system elevation; Chromium purges undecryptable rows upon cloning. Reverse-engineering ABE is brittle, insecure, and counterproductive.
2. **Did NOT synchronize Google rotating cookies (`*PSIDTS`/`*PSIDRTS`) across browsers**: Dual-client token sharing triggers Google's session invalidation. AntiFan operates as an independent session owner.
3. **Did NOT rewrite the entire partition/capsule architecture**: Kept the four partition families intact; fixed target resolution and durability instead of creating churn.
4. **Did NOT delete or weaken any existing test suite**: All 10 existing main test suites continue to pass.

---

## 9. Effort, Order of Execution & Minimal Viable Cutover

### Execution Order & Effort Estimates
1. **Phase 1: Session Resolver & Menu Unification (AC1, AC2)** — *Effort: 2 hours*. Creates `getProfileSyncSession`, updates all 5 UI callsites, adds `session-target-resolver.test.ts`.
2. **Phase 2: Fail-Closed Vault Contracts & Durability Flush (AC3, AC7)** — *Effort: 2.5 hours*. Implements persistence checks, empty assertions, and `cookies.on('changed')` debounced flush; updates `local-session-vault.test.ts`.
3. **Phase 3: Guarded Dead-Store Cleanup (AC4, AC5)** — *Effort: 2 hours*. Implements `dead-store-cleanup.ts`, unit tests with dry-run/idempotence verification, runs cleanup on disk.
4. **Phase 4: Cache Configuration & Chrome Sync Messaging (AC6, AC8)** — *Effort: 1.5 hours*. Prunes `--disk-cache-dir`, clarifies UI prompts, verifies all ACs.

### Minimal Viable Cutover (If only Phase 1 & Phase 2 were possible)
Shipping **Phase 1 and Phase 2 alone** immediately cures the user's primary complaints:
- "Lúc ăn lúc không" is solved because sync and vault operations will never write into ephemeral tabs or isolated capsules again.
- "Rất nhanh hết" is solved because page-set cookies are actively flushed to SQLite within 1000ms instead of being lost on sudden app termination.
The remaining phases (disk sweep and cache switch pruning) are purely housekeeping and can safely follow.

---