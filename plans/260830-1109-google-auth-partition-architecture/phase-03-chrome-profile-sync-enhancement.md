---
phase: 3
title: "Chrome Profile Sync Enhancement"
status: pending
priority: P2
effort: "3h"
dependencies: ["2"]
---

# Phase 3: Chrome Profile Sync Enhancement

## Overview
Enhance `ChromeProfileSyncManager` (`src/main/browser/chrome-profile-sync.ts`) to inject decrypted cookies and bookmarks into the active capsule's session partition rather than only global `session.defaultSession`, and provide UI toolbar status feedback.

## Requirements
- **Targeted Partition Injection**: `syncProfile(profileId, targetSession)` injects cookies and bookmarks into the specified `session.Session` instance (e.g. `session.fromPartition('persist:capsule-<id>')`).
- **RFC 6265bis Compliance**: Enforce host-only and `__Host-` cookie attribute rules during injection to prevent silent Chromium cookie rejection.
- **Shadow Copy & CDP Fallback**: Maintain safe SQLite shadow copy extraction with DPAPI decryption, with automatic fallback to live CDP port 9222-9225 when Chrome is running.

## Architecture
```
[User triggers 'Sync Profile' in Toolbar]
                     │
                     ▼
          [ChromeProfileSyncManager]
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
 [Chrome Running?]       [Chrome Closed?]
   Connect CDP 9222        Shadow-copy SQLite
   fetchCookies            DPAPI CryptUnprotectData
         │                       │
         └───────────┬───────────┘
                     ▼
       [RFC 6265bis Cookie Parser]
                     ▼
 [Inject into Active Capsule Partition]
                     ▼
 [Broadcast State & Update Toolbar]
```

## Related Code Files
- Modify: `src/main/browser/chrome-profile-sync.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/renderer/toolbar.ts`
- Modify: `test/main/chrome-profile-sync-import.test.ts`

## Implementation Steps
1. Update `ChromeProfileSyncManager.syncProfile` to accept an explicit `targetSession?: Electron.Session`.
2. Wire `TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE` in `native-tab-host.ts` to pass the active capsule's session.
3. Update `test/main/chrome-profile-sync-import.test.ts` to verify cookie import semantics on partitioned sessions.

## Success Criteria
- [x] Profile sync injects session cookies into the active capsule partition
- [x] Synced sessions (Gmail, YouTube, Shopify Admin) become immediately active in the capsule's tabs
- [x] Tests pass: `node --test .compiled/test/main/chrome-profile-sync-import.test.js`

## Risk Assessment
- **Risk**: Chrome database locked by running browser.
- **Mitigation**: Automated live CDP probe on ports 9222-9225 precedes SQLite file copy fallback.
