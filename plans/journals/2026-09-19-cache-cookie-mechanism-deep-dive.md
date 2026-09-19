---
title: Cache/Cookie Mechanism Deep Dive — Where the Session Vault Design Leaks
date: 2026-09-19
summary: "Forensics on 86 on-disk cookie stores (two of three Chrome-sync menus wrote into the focused tab's jar; the vault never held a Google login; capsule migration copied 25.756 cookies into a namespace no code resolves) then the fixes and their verification: one fail-closed resolver, per-change cookie flush that survives a hard kill, 84 dead stores reclaimed (4.9 GB)"
---

# Cache/Cookie Mechanism Deep Dive

## Context
User symptom: "rất nhanh hết, lúc ăn lúc không, không đồng bộ được từ Chrome". The 2026-09-03 design (shared profile routing + LocalSessionVault + shutdown flush) was believed to have closed session loss. Measured live on 2026-09-19 instead of trusting the design.

Full report: `docs/research-cache-cookie-mechanism.md`.

## Findings (all Tier-1)

1. **Two of three "Sync Google Chrome Profile" menus write into the focused tab's jar.**
   `app-menu.ts:195` correctly passes `getSharedProfileSession('clean', p.id)`; `native-tab-host.ts:2895` (toolbar) and `tab-context-menu.ts:272` pass `getActiveTabSession()`. When the focused tab is ephemeral (`ephemeral-profile-*` = in-memory) or an isolated capsule, imported cookies die with that tab. A live ephemeral tab existed during the measurement.
2. **The vault never held a Google login.** `config/session-vault.json` = 267 cookies, 0 session cookies, 29 already expired, mtime `2026-09-05 13:40`; Google entries are only `NID`, `SNID` (path `/verify`), `OTZ`, `SEARCH_SAMESITE`. No `SID`/`HSID`/`SSID`/`__Secure-1PSIDTS`. The CDP path deliberately writes no vault (`local-session-vault.ts:417-421`). Vault Export/Import also target `getActiveTabSession()` (`app-menu.ts:215,230`).
3. **86 cookie stores on disk, 1 live.** 43 `capsule-capsule-*` + 41 `profile-capsule-*` (dead) + 1 `profile-profile-2` (live). 25.756 cookies, 8,76 MB, **58 stores contain Google auth cookies**, 0 session cookies anywhere.
4. **The capsule migration is a write-only dead end.** `capsule-partition-migration.ts:92-93` targets `persist:profile-capsule-<uuid>`; `grep 'profile-capsule' src/ scripts/` returns 0 matches. Marker `antifan-migration-capsule-to-profile.done` written 2026-09-05 19:27, so it never retries.
5. **The default session jar is empty** (`Profile/Network/Cookies` = 20.480 B). `getTabSession` falls back to `session.defaultSession` when a tab has no partition, so any such tab has no cookies at all.
6. **Cache is layered wrong.** `--disk-cache-dir` only applies to the default partition: `Profile-cache/network` = 0 B, `Profile/Cache` = 224.350 KB orphaned (default partition, no tab uses it), while the live jar's cache is `Partitions/profile-profile-2/Cache` = 171.073 KB and is not bounded by `--disk-cache-size=134217728`.
7. **Identity mismatch measured live:** app UA `Chrome/150.0.7871.224` vs Chrome that minted the cookies `153.0.8010.50`; `navigator.userAgentData.brands = []`; `setupClientHintsOverride` rewrites `sec-ch-ua` per request (`google-auth-identity.ts:110-124`). Google cookies (`SID`, `SAPISID`, `OTZ`, `SIDCC`) are readable from `document.cookie`, which is not how Chrome stores them — evidence that a non-Chrome writer created/overwrote those rows.
8. **Restore ordering is correct today**: `restoreTabs` applies `activeChromeProfileId` before creating tabs, and tabs carry no persisted partition. A stale duplicate `config/saved-tabs.json` (Default, Aug 31) survives from the state-dir move.

## Assessment
The 2026-09-03 hardening fixed the *shared-jar routing* and the *shutdown flush*, but left three target-selection paths that bypass it, and the data migration it introduced writes to a namespace nothing reads. "Lúc ăn lúc không" is therefore still by design: the destination jar depends on which tab is focused and which menu is used.

## Open decisions (not implemented — research only)
- Route all cookie writes through the profile-scoped session; refuse ephemeral/isolated targets explicitly.
- Delete or re-point the 84 dead stores; fix the migration target or remove the migration.
- Drop the ineffective `--disk-cache-dir`/`gpu-cache-dir` switches; decide per-partition cache policy.
- Verify (A/B) whether the UA/client-hint mismatch contributes to Google session revocation before acting on it.

---

## Implemented & verified (same day)

The findings above are closed; this section records what changed and how it was checked. Every claim has a re-runnable command.

**Target selection (finding 1).** `getActiveTabSession()` no longer exists in `src/main` (`grep` = 0 call sites). All six credential entry points — the three Chrome-sync menus (`app-menu.ts:195`, `native-tab-host.ts:2903`, `tab-context-menu.ts:277`) and the three vault/extension paths (`app-menu.ts:213,228`, `native-tab-host.ts:1437`) — resolve through one non-ambient resolver, `NativeTabHost.resolveTargetProfileSession()`, which throws `TARGET_SESSION_INVALID` unless the partition matches `persist:profile-*`. Below it, `local-session-vault.resolveCredentialJar()` rejects a RAM jar (`EPHEMERAL_TARGET_REJECTED`) and a workspace jar (`CAPSULE_TARGET_REJECTED`), and export refuses to overwrite the vault with an empty store (`EMPTY_STORE_REJECTED`). "Lúc ăn lúc không" was a target-selection property, and the target is now a parameter, never a focus side effect.

**Durability (finding 6, "rất nhanh hết").** `browser/cookie-durability.ts` subscribes to `cookies.on('changed')` for every partition configured through the app path, debounces 1000 ms and calls `flushStore()`. Imported session cookies get a 30-day TTL so they are not memory-only. Verified by a real kill: two jars (one armed by `configureBrowserSessionPartition`, one opened directly), page sets both cookies, then `taskkill /F` with no graceful quit — the armed jar keeps its cookie, the control jar loses it, exactly as the defect predicts. The worker also reports `armCookieDurability()` returning `false` on the armed jar, which proves the production configure path (not the test) armed it, and prints `FLUSH_OBSERVED` so the kill happens after the mechanism commits instead of after a guessed delay. Two earlier versions of this smoke were timing-dependent (a fixed 2.5 s, then 6 s settle windows) and flaked under CPU load; a filesystem probe is impossible because Chromium holds the cookie store exclusively (measured `copyFileSync` → `EBUSY`).

**Migration and dead stores (findings 3, 5, 6).** `capsule-partition-migration.ts` now strips every leading `capsule-` before mapping, so the copy target is `persist:profile-<id>` — a namespace a resolver actually opens. The 84 unreachable stores and the leftovers (stale `config/saved-tabs.json`, four `.tmp.*` files, the stale default-session cache) are reclaimed by the shipped guarded cleaner. New `npm run prune:dead-stores` runs that cleaner offline with the same vetoes the boot pass builds (tab partitions and capsule ids from `saved-tabs.json`, derivable partitions for every Chrome profile, fail-closed if the state file cannot be parsed); `--apply` is required to delete. Measured on the real root, with the app running: 84 partitions + 5 files, 4,925.21 MB reclaimed, `errors: []`, `Partitions/` left with only the live `profile-profile-2`; re-running reports `scanned: 0`. `Profile/Cache` was deferred (the running app's network service holds it) and reclaimed on the offline pass: 220 MB → 2 KB. Data root 5.7 GB → 854 MB.

**Cache (finding 6, correction).** `--disk-cache-dir` is gone from `index.ts`. The earlier reading that `--disk-cache-size` is "the real bound" was wrong and is corrected in the comment: the live jar's own cache measured 168–171 MB while that switch was set to 128 MB, so partition caches are evicted by Chromium's own policy, not by the switch.

**Still open, by design.** Chrome ≥ 127 App-Bound Encryption v20 makes a real profile unreadable through a clone, so CDP import returns zero cookies for a signed-in real profile; the app now names that cause and points at the Session Vault instead of reporting a silent success. Which client owns Google's rotating `*PSIDTS`/`*PSIDRTS` remains a policy choice (one owner per account), not a code fix. The UA/`userAgentData.brands` fingerprint mismatch is still only a measured correlation — the A/B that would settle it has not been run.

**Evidence commands.** `npm run test:main` → 1365 tests, 0 fail. Contract group (`chrome-profile-sync*`, `local-session-vault`, `capsule-partition-migration-pure`, `partition-migration-gate`, `profile-ownership`, `capsule-partition-cookie-isolation`, `dead-store-cleaner`, `cookie-durability`) → 58/58. `node scripts/smoke-cookie-hardkill-durability.cjs`, `node scripts/smoke-boot-housekeeping.cjs`, `node scripts/smoke-cdp-hydration.cjs` → PASS. `npm run prune:dead-stores` → idempotent.

Full write-up: `docs/research-cache-cookie-mechanism.md` §5 (status per proposal) and `CHANGELOG.md` (v1.3.6 entry).
