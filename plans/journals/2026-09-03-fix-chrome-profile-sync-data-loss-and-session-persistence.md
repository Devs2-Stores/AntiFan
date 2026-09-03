---
title: Fix Chrome Profile Sync Data Loss and Session Persistence
date: 2026-09-03
summary: "Fix session cookie volatile drop with durable 30-day fallback TTL, prevent Chrome shutdown delta deletions, and enhance profile sync contract"
---

# Fix Chrome Profile Sync Data Loss and Session Persistence

## Problem
- Intermittent session data loss: login cookies imported from Google Chrome disappeared after restarting AntiFan Desktop or reloading partitions.
- Chrome exit data loss: closing Google Chrome immediately wiped cookies in AntiFan Desktop.
- Manual sync dependency: AntiFan Desktop's UI sync only imported bookmarks, forcing users to manually open Chrome and click the Companion Extension popup to push cookies.

## Root Causes
1. **Session Cookie Volatility**: Cookies without `expirationDate` in `extensionCookieImportSetDetails` remained in-memory session cookies in Electron, never flushed to the SQLite disk store.
2. **Delta Removal Propagation on Exit**: When Chrome closed or purged session/temporary cookies, `chrome.cookies.onChanged` emitted deletions with `cause: 'expired'` or `'evicted'`. The extension debouncer queued these and posted them to `/api/cookies/import`, which called `targetSession.cookies.remove()`, wiping the cookies from AntiFan Desktop.
3. **Premature `bridgeAuth` Wipe**: In `background.ts`, `port.onDisconnect` wiped `bridgeAuth` from `chrome.storage.local` 200ms after startup when the native host finished handshaking, breaking automatic background delta syncs.

## Solution
1. **Durable Fallback Session TTL**: Added `ExtensionCookieImportOptions` with `persistSessionCookies: true` (default 30 days) so session cookies imported via the bridge are written to disk SQLite.
2. **Delta Removal Guarding**: Filtered out non-explicit removals (`expired`, `evicted`, `overwrite`) in `CookieDebouncer.addChange()`. Only explicit user/script logouts (`cause === 'explicit'`) are propagated. Added `debouncer.clear()` on `chrome.runtime.onSuspend`.
3. **Wildcard & All Profile Domain Scoper**: Enhanced `domain-scoper.ts` to support `'all'` and `'*'` profiles for unrestricted cookie synchronization.
4. **Target Session Cookie Querying**: Updated `syncProfile()` to inspect live target session cookies and report accurate status in toast messages.

## Verification
- Unit tests added in `test/main/chrome-profile-sync-import.test.ts` verifying fallback TTL, debouncer removal filtering, and wildcard scoping.
- `npm run typecheck` passed with 0 errors.
- `node --test ".compiled/test/main/chrome-profile-sync*.test.js" ".compiled/test/main/bridge-cookie-import.test.js" ".compiled/test/main/zero-touch-popup-sync-pipeline.test.js"` passed 21/21 tests.
- `npm run smoke:persistence` passed process restart write/read persistence verification.
