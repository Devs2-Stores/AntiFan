---
title: "Local-First Persistent Profile & Session Vault Architecture"
description: "Implementation of shared profile session routing at tab-host level, active partition flushStore on shutdown, and local JSON cookie vault."
status: completed
priority: P1
effort: "2h"
tags: [profile, session, persistence, cookies, local-vault, tab-host]
created: 2026-09-03
---

# Local-First Persistent Profile & Session Vault Architecture

## Overview
Eliminate recurring session and cookie loss in AntiFan Browser Desktop for local-first, cloud-free workflows.
Route browsing tabs to a unified persistent profile partition at the `NativeTabHost` level while preserving the `deriveCapsulePartition` contract for Google Auth identity and multi-workspace isolation tests.
Ensure all active partition sessions execute `cookies.flushStore()` upon application shutdown. Provide a 100% offline Local Session Vault for JSON cookie import/export.

## Goals
1. Preserve `deriveCapsulePartition` contract verbatim to prevent breaking `google-auth-identity` and multi-workspace tests.
2. Route shared profile sessions at the `NativeTabHost` level (`persist:profile-${profileId || 'default'}`) for standard browsing tabs.
3. Flush all active partition cookie stores during `app.on('before-quit')` in `src/main/index.ts`.
4. Create `src/main/browser/local-session-vault.ts` supporting backup/restore and Cookie-Editor JSON import with 30-day durable fallback TTL.
5. Expose Vault actions in App Menu and Toolbar with accurate feedback.
6. Verify all test suites pass with 0 regressions.

## Phases
- [x] Phase 1: Shutdown Session Flush & Active Partition Tracking
- [x] Phase 2: TabHost Shared Profile Routing & Contract Preservation
- [x] Phase 3: Local Session Vault Module & IPC
- [x] Phase 4: UI & Toolbar Integration
- [x] Phase 5: Verification, Tests & Final Review

## Verification Results
- `node --test .compiled/test/main/local-session-vault.test.js .compiled/test/main/google-auth-identity.test.js .compiled/test/main/capsule-partition-cookie-isolation.test.js .compiled/test/main/multi-workspace-target-settle.test.js`: 23/23 tests passed.
- `npm run smoke:persistence`: Process restart write/read persistence verification passed (cookie + localStorage + IndexedDB survived restart).
- `npm run typecheck`: 0 errors.
- `CodeReviewer` subagent audit completed; all 4 review findings remediated and verified.
