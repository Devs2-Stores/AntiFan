# EVIDENCE PACKET — Ultra Verifier Run: Cookie/Cache Architecture Fix Plan
**packetId:** ultra-cookie-2026-09-19  **Controller:** main session  **Mode:** best-of-5, read-only candidates, 1 immutability contract
**Repo root:** `E:\Work\apps\AntiFan` (Electron 43.4.0, TypeScript → `.compiled/`, Windows 11)
**User directive (verbatim):** "--ultra Chốt phương án rồi triển khai toàn bộ cho tôi đi, sau đó test lại cho thật kĩ dùm"

---

## 1. TASK

The user reports three symptoms in AntiFan Desktop Browser (Electron app that hosts real Chromium tabs with real logged-in sessions):

1. **"Rất nhanh hết"** — sessions/logins expire very quickly.
2. **"Lúc ăn lúc không"** — sometimes the login works, sometimes not, intermittently.
3. **"Không đồng bộ được từ Chrome"** — cannot sync cookies/session from real Google Chrome.

A read-only forensics pass is complete. Your job: produce a **complete, ordered implementation plan** that fixes the mechanism (not the symptom), plus its test/verification strategy. The controller will implement the winner and test it.

**Source report (read it; do not re-derive from scratch):** `docs/research-cache-cookie-mechanism.md`
**Journal:** `plans/journals/2026-09-19-cache-cookie-mechanism-deep-dive.md`

---

## 2. CONFIRMED EVIDENCE (Tier-1, measured 2026-09-19; treat as ground truth — do not re-litigate)

### 2.1 Data/partition model
- Data root `E:/Work/.antifan-data`; userData/sessionData = `<root>/Profile`; state file `<root>/Profile/saved-tabs.json`.
- Four partition families (`src/main/browser/browser-session-partition.ts`, `src/main/browser/native-tab-host.ts`):
  - shared profile → `persist:profile-<profileId.toLowerCase()>` (`native-tab-host.ts:3515-3526`)
  - isolated capsule → `persist:capsule-<capsuleId>` (`browser-session-partition.ts:31-33`)
  - ephemeral → `ephemeral-profile-<key>-<nonce>` = **in-memory, nothing on disk** (`native-tab-host.ts:3517-3521`)
  - default → `session.defaultSession`, only when a tab has no `partition` (`native-tab-host.ts:3449-3452`, `3505-3508`)
- `getSharedProfilePartition()` reads `ChromeProfileSyncManager.activeProfileId` when no explicit `profileId` is passed. `activeProfileId` is a **mutable global** (`chrome-profile-sync.ts:175`), default `'Default'`, set by menu clicks (`app-menu.ts:194`, `native-tab-host.ts:1428`, `chrome-profile-sync.ts:556`) and restored from `saved-tabs.json` in `restoreTabs` (`native-tab-host.ts:7478-7480`) — **before** the tab loop (correct order today).

### 2.2 On-disk reality (measured with SQLite reads)
```
86 stores total:
  43 × Partitions/capsule-capsule-<uuid>/Network/Cookies      (dead, legacy isolated capsules)
  41 × Partitions/profile-capsule-capsule-<uuid>/Network/Cookies (dead, migration output)
   1 × Partitions/profile-profile-2/Network/Cookies            (LIVE, 589.824 B, mtime now)
   + Profile/Network/Cookies                                   (default session, 20.480 B = EMPTY DB)
25.756 cookies total across dead stores; 8,76 MB; 58 dead stores contain Google auth cookies
  (SID / HSID / SSID / __Secure-1PSID / __Secure-3PSID / __Secure-1PSIDTS / __Secure-3PSIDTS, 15-19 per store)
session cookies (expires_utc = 0) across ALL 86 stores: 0
Partitions/profile-default: does not exist on disk
```
- Live tabs at measurement time: 10 tabs, **all** `partition: persist:profile-profile-2` (so today's shared routing works), plus 1 `ephemeral-profile-profile-2-6g9ayx3i` offscreen ephemeral tab.
- `Profile-cache/network` = **0 B** (`--disk-cache-dir` target, never written); `Profile/Cache` = 224.350 KB (default partition, orphaned, mtime Aug 30); `Partitions/profile-profile-2/Cache` = 171.073 KB (the only cache actually serving traffic, and *not* bounded by `--disk-cache-size=134217728`).

### 2.3 Target-selection defects (root cause of "lúc ăn lúc không")
Three UI paths share the label "Sync Google Chrome Profile" but pass different target sessions:
| Entry point | Target session | Verdict |
|---|---|---|
| `src/main/browser/app-menu.ts:195` (native app menu) | `getSharedProfileSession('clean', p.id)` | correct |
| `src/main/browser/native-tab-host.ts:2895` (toolbar menu) | `getActiveTabSession()` | **writes into whatever tab is focused** |
| `src/main/browser/tab-context-menu.ts:272` (context menu) | `getActiveTabSession()` | same defect |
Plus the Session Vault menu items: `app-menu.ts:215` (export) and `app-menu.ts:230` (import) both use `getActiveTabSession()`.
`getActiveTabSession()` (`native-tab-host.ts:3455-3461`) → `getTabSession(activeTabId)` → `session.fromPartition(tab.state.partition)`, so an ephemeral or capsule focused tab redirects the write into an in-memory jar or a capsule jar.

### 2.4 Vault defects (root cause of "không đồng bộ được")
- `config/session-vault.json` (76.579 B, mtime **2026-09-05 13:40**): 267 cookies, **0 session cookies**, 29 already expired when measured, expiry range 2026-09-05 14:18 → 2027-10-10.
- Google entries in the vault are ONLY `NID`, `SNID` (path `/verify`), `OTZ`, `SEARCH_SAMESITE` — **no `SID`/`HSID`/`SSID`/`APISID`/`__Secure-1PSIDTS`**. Restoring it cannot restore a Google login.
- The live Chrome-CDP import path deliberately does **not** write the vault (`src/main/browser/local-session-vault.ts:417-421`, comment "NO plaintext backup here").
- Import TTL policy: `local-session-vault.ts:145-147` — `persistSessionCookies: true, sessionTtlSeconds: 30*24*3600`; applies **only** to cookies passing through import.
- Chrome import is structurally impossible for real profiles on Chrome ≥127 (App-Bound Encryption v20): owned-clone + headless CDP returns 0 cookies; app documents this at `chrome-profile-sync.ts:497-503`. Independent probe previously confirmed Chromium **purges** undecryptable rows, so offline SQLite decryption is not an option.
- Node of risk: `Chrome/User Data/CodexRemote9222/DevToolsActivePort` contains `9222` — a foreign Chrome (OpenAI Codex extension) already occupies CDP port 9222 with a different user-data-dir, so the "live Chrome on port 9222" branch can silently target an empty profile.
- `chrome-profile-sync.ts:445-447` refuses to run while Chrome is open — a legitimate gate the UI does not explain.

### 2.5 Dead-end migration (data-loss-shaped)
`src/main/browser/capsule-partition-migration.ts:92-93`:
```ts
const legacy = `persist:${key}`;                                   // persist:capsule-capsule-<uuid>
const target = `persist:${key.replace(/^capsule-/, 'profile-')}`;  // persist:profile-capsule-capsule-<uuid>
```
`grep -rn 'profile-capsule' src/ scripts/` → **0 matches**. Nothing resolves the target namespace, so 41 copies (~25k cookies incl. 58 Google logins) were written into a namespace no code path reads. Marker `<root>/config/antifan-migration-capsule-to-profile.done` written 2026-09-05 19:27, so it never retries. Caller: `src/main/index.ts:529`. Migration copies are intentional ("legacy partitions are never removed here") — see `capsule-partition-migration.ts:11-14`.

### 2.6 Session durability
- Graceful quit flushes: `main.log` shows `shutdown.step.begin/done` for `tabHost.flushAllSessions` then `cookies.flushStore`; `flushAllSessions` iterates default + shared profile + all open tab sessions (`native-tab-host.ts:3586-3607`).
- Boot log line: `boot.profile … prevCleanShutdown: false` even immediately after a `shutdown.clean` event (log/report defect); `main.log.1` contains 13 `crashed-terminal-session`/`crashed-run` events.
- Consequence: page-set cookies are only durable on a clean quit; a kill/crash loses them, and session cookies never persist at all (2.2: 0 session cookies on disk).
- Live session state at measurement: `https://myaccount.google.com/` redirected to `https://www.google.com/account/about/?hl=en-US` (signed in), and `document.cookie` in the live jar exposes `SID`, `APISID`, `SAPISID`, `__Secure-1PAPISID`, `__Secure-3PAPISID`, `OTZ`, `SEARCH_SAMESITE`, `SIDCC` — cookies that are `HttpOnly` in real Chrome, i.e. some non-Chrome writer created/overwrote those rows.
- Identity mismatch measured: app UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36`; `navigator.userAgentData.brands = []`; the Chrome that minted the cookies is `153.0.8010.50`. `setupClientHintsOverride` rewrites `sec-ch-ua` / `sec-ch-ua-full-version-list` on every https request (`google-auth-identity.ts:110-124`).
- Google rotating cookies (`__Secure-1PSIDTS` / `__Secure-3PSIDTS` / `*PSIDRTS`, TTL minutes) are single-owner: copying them to a second client means the two clients invalidate each other's session. Prior probe recorded a `__Secure-3PSIDRTS` expiring ~10 minutes after capture.

### 2.7 Housekeeping leftovers
- Duplicate state file `<root>/config/saved-tabs.json` (394 B, `activeChromeProfileId: "Default"`, mtime Aug 31) vs the live `<root>/Profile/saved-tabs.json` (`"Profile 2"`). The config copy is stale from the state-dir move.
- Two orphan temp files in `<root>/Profile/`: `saved-tabs.json.tmp.1789467266030.3lipqk`, `saved-tabs.json.tmp.1789467468226.hvv5sg` (Sep 15).
- `<root>/Profile/Network/Cookies` is an empty DB (20.480 B) — the default session jar has no cookies, so any code path that resolves to `defaultSession` gets an empty jar.

---

## 3. HARD CONSTRAINTS

1. **No new runtime dependencies.** Electron 43 + existing deps only (`ws`, `zod`, `tldts`, …). No new npm packages.
2. **Compiled pipeline is authoritative**: `npm run compile` runs `tsc -p ./`, emit-integrity, MCP budget/dispatch checks, static copy, extension build. Any plan must compile clean and keep those gates green.
3. **Do not break existing contracts.** These test files must keep passing (they encode current invariants): `.compiled/test/main/{capsule-partition-cookie-isolation,capsule-partition-migration-pure,partition-migration-gate,local-session-vault,chrome-profile-sync,chrome-profile-sync-import,bridge-cookie-import,session-restore-profile,profile-ownership,workspace-capsule}.test.js`. Also `test/unit/*.test.mjs` via `npm run test:unit`.
4. **`deriveCapsulePartition` is a public contract** used by `google-auth-identity` and workspace isolation. Changing where *shared* tabs write is in scope; silently breaking capsule isolation semantics is not.
5. **No placeholders, no mocks, no "TODO implement".** Real logic only. Never weaken or delete an existing test to get green — if a test encodes the *old* (defective) target session, the plan must say which assertion changes and why, and the replacement must assert observable behavior.
6. **Windows-only paths**, backslash-safe. Uses `fs`, `path`, `session.fromPartition`, `session.cookies.*`.
7. **Data deletion is allowed but must be provable and guarded.** The user approved cleaning the ~8,76 MB of dead stores. The plan must make deletion: (a) scoped to an exact verified pattern, (b) impossible while a live tab references the partition, (c) idempotent, (d) auditable (report what was removed). Prefer in-app guarded code over a one-off shell `rm -rf`.
8. **Do not touch** the MCP capability catalogue unless a fix requires it; `scripts/antifan-omp-mcp.cjs` has a budget-dominance check (`check-mcp-budget-dominance.mjs`) — if you add a tool name, say so explicitly and account for the budget gate.

## 4. NON-GOALS

- Rewriting the whole session/partition layer. Keep the four-family model; make target selection correct and durability real.
- Replacing App-Bound-Encryption-blocked Chrome import with an offline SQLite decrypter (proven impossible + Chromium purges the rows).
- Solving Google's rotating-cookie ownership by "syncing harder"; a sanctioned strategy (single owner, or independent profile with one-time login) is acceptable and must be argued.
- Any change to user-visible browsing behavior beyond login/session durability.

## 5. ACCEPTANCE CRITERIA (must be objectively checkable; the controller will test these)

- **AC1** — No code path can write cookies into an ephemeral (`ephemeral-*`) or capsule (`persist:capsule-*`) session as a side effect of a "Sync Chrome profile" / "Vault export" / "Vault import" action. Verify by unit test over the exported session resolver(s), plus a runtime assertion/rejection path.
- **AC2** — All three "Sync Google Chrome Profile" entry points and both Session Vault entry points resolve the target session **only** from an explicit profile id (or refuse), never from the focused tab. Verify by test enumerating the entry points (or by testing the single shared resolver they all must call).
- **AC3** — Vault export/import reports the target jar and refuses to claim success when 0 cookies were written or the target jar is empty/in-memory. Verify with a test that drives the vault functions with an ephemeral session and an empty session.
- **AC4** — The dead-end migration no longer writes an unreadable namespace: either its target becomes reachable, or the migration is removed with the marker contract preserved (idempotent, never deletes legacy data outside the approved cleanup). Verify by unit test on the pure migration function.
- **AC5** — The 84 dead stores + orphan temp files + stale duplicate state are removed via a guarded, idempotent, auditable path that refuses when a live tab owns a matching partition. Verify by dry-run output + live run on this machine, and by re-running it (must be a no-op).
- **AC6** — Cache configuration matches reality: no switch that provably does nothing, and the live partition cache is bounded/documented. Verify by asserting the switch list + measuring that the abandoned 219 MiB path is handled.
- **AC7** — Session durability is measurably better in at least one of: (a) page-set cookies flushed per-partition on change or on a bounded interval (so a kill loses ≤ N seconds), (b) imported session cookies keep working after a forced kill + relaunch. Verify by running the app, setting a cookie, killing the process (hard), relaunching, and reading the cookie back.
- **AC8** — Every fix has a reproduction that fails before and passes after, or an explicit statement of why a reproduction is impractical (with the substitute evidence).

## 6. PROTECTED SURFACES (do not regress)

- Multi-workspace/capsule isolation (`capsuleId`, `workspace-capsules.json`), preview watchers, terminal affinity, MCP authority/attachment contracts (`AGENTS.md` invariants: no authority implied from focus).
- Split mobile/desktop panes, `userAgentMode` (`clean`/`native`) semantics, `google-auth-identity` UA/hint pipeline.
- Control-plane leases, `TARGET_STALE`/authority checks in `browser-control-port.ts`.

## 7. VERIFICATION COMMANDS AVAILABLE

```
npm run compile                     # tsc + integrity + static copy + extension + budget gates
npm run typecheck                   # tsc --noEmit
npm run test:main                   # .compiled/test/main/**
npm run test:unit                   # test/unit/*.test.mjs + .compiled/test/unit/**
npm run test:file <path>            # single file
npm run smoke:persistence           # profile persistence smoke (compile + electron runner)
npm run smoke:vault                 # vault smoke
npm run smoke:google                # google cookie smoke
npm run smoke:cdp / smoke:owned-cdp # CDP hydration smokes
```
MCP live tools exist for runtime verification (app must be running): `anti.browser.tabs.list`, `anti.browser.evaluate`, `anti.inspect.*`, `anti.theme.*`.

## 8. REQUIRED OUTPUT SHAPE (per candidate)

1. **Chosen organizing insight** — one paragraph: what collapses/inverts/generalizes across the findings (the plan must not be 10 unrelated patches).
2. **Ordered phases** — each phase: goal, exact files + symbols to change (`path:line`), the change in code-level terms, and the risk it retires. Name explicit non-goals per phase.
3. **Target-session contract** — the single resolver API you propose (name, signature, where it lives, who calls it) and how every entry point is forced through it.
4. **Durability strategy** — how page-set cookies survive a kill; what flush policy, and its cost.
5. **Chrome-sync strategy** — precisely what remains possible given ABE v20 (state what the UI must say, what is refused, and the fallback), and how the port-9222 foreign-Chrome trap is handled.
6. **Cleanup mechanism** — exact pattern, guard, idempotence proof, artifact/report.
7. **Test plan mapped to AC1–AC8** — file names for new/changed tests, what each asserts, which existing test assertion changes and why.
8. **Risk register** — top 5 risks with detection signal, and what you deliberately did NOT do.
9. **Effort/order of execution** and what to ship first if only the first two phases were possible.

Be concrete and cite `path:line`. Generic advice scores zero. Read the report and the cited files before answering.
