---
title: Local-First Persistent Profile and Session Vault Architecture
date: 2026-09-03
summary: "Eliminate recurring session loss in AntiFan Desktop via NativeTabHost shared profile routing, active partition flushStore on shutdown, and LocalSessionVault JSON/CDP import"
---

# Local-First Persistent Profile and Session Vault Architecture

## Context
In local-first development without Cloud synchronization, users experienced recurring session and cookie data loss across tabs and restarts in AntiFan Browser Desktop.
Scouting revealed:
1. `deriveCapsulePartition` bound each tab to a separate capsule partition (`persist:capsule-<id>`), creating 30+ isolated partition jars where logins in one tab did not exist in other tabs.
2. `src/main/index.ts` only called `session.defaultSession.cookies.flushStore()` upon shutdown, leaving Chromium's in-memory WAL buffers in partition sessions uncommitted.
3. Windows 11 Chrome 127+ introduced `v20` App-Bound encryption, making offline SQLite decryption impossible outside `chrome.exe`.
4. Chrome Companion Extension background sync broke on MV3 service worker suspension and token rotation.

## Implementation Details
1. **Contract Preservation**: Kept `deriveCapsulePartition` contract 100% intact, maintaining full compatibility with `google-auth-identity` and multi-workspace isolation test suites.
2. **TabHost Shared Profile Routing**: Standard browsing tabs in `NativeTabHost.createTab` are now routed to `persist:profile-${activeProfileId || 'default'}`. Isolated capsule mode remains available via `options.isolateSession: true`.
3. **Graceful Shutdown Flush**: `NativeTabHost.flushAllSessions()` iterates all active tab sessions, the shared profile session, and the default session, executing `cookies.flushStore()` in parallel during `app.on('before-quit')` in `src/main/index.ts`.
4. **LocalSessionVault Module (`src/main/browser/local-session-vault.ts`)**:
   - Backup: Exports cookies to `E:\Work\.antifan-data\config\session-vault.json`.
   - Restore: Imports JSON cookies with a 30-day durable fallback TTL for session cookies, mapping CDP `expires` and title-case `SameSite` (`None` -> `no_restriction`).
   - Live Chrome CDP Extraction: Direct 1-click cookie ingestion via port 9222 bypassing `v20` encryption.
5. **UI & Menu Integration**: Exposed Session Vault backup, restore, and CDP sync options in `app-menu.ts` and `toolbar.ts`.

## Verification
- Unit test suite: `node --test .compiled/test/main/local-session-vault.test.js .compiled/test/main/google-auth-identity.test.js .compiled/test/main/capsule-partition-cookie-isolation.test.js .compiled/test/main/multi-workspace-target-settle.test.js` (23/23 tests passed).
- Smoke test: `npm run smoke:persistence` passed process restart write/read persistence verification.
- Code review: `CodeReviewer` subagent conducted an in-depth audit; all 4 findings resolved and verified.
