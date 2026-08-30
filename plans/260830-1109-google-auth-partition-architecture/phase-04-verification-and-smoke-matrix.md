---
phase: 4
title: "Verification & Smoke Matrix"
status: pending
priority: P1
effort: "2h"
dependencies: ["1", "2", "3"]
---

# Phase 4: Verification & Smoke Matrix

## Overview
Execute a comprehensive multi-layer verification suite covering direct Google authentication in `native` mode, Cloudflare Turnstile compatibility in `clean` mode, capsule partition isolation, Chrome profile sync, and full test suite regression against baseline.

## Requirements
- **Arm 1: Direct Google Authentication Proof**: Run an isolated Electron instance in `native` mode, navigate to `https://accounts.google.com/`, submit runtime-supplied test account email, and verify the password challenge is rendered with zero "insecure browser" errors.
- **Arm 2: Storefront & Turnstile Compatibility**: Run an isolated Electron instance in `clean` mode, navigate to test merchant storefronts, and verify Cloudflare Turnstile succeeds without bot challenge blocking.
- **Arm 3: Partition Cookie Isolation Check**: Verify that setting cookies in Capsule A partition does not leak to Capsule B partition or `defaultSession`.
- **Arm 4: Regression Suite Baseline**: Run `npm test` and `npm run compile` to verify 0 compiler errors and 0 test failures.

## Test Commands Matrix

| # | Target | Command | Expected Result |
|---|--------|---------|-----------------|
| 1 | TypeScript Compilation | `npm run compile` | 0 errors |
| 2 | Identity Unit Tests | `node --test .compiled/test/main/google-auth-identity.test.js` | 100% passing |
| 3 | Security Policy Tests | `node --test .compiled/test/main/security-policy.test.js` | 100% passing |
| 4 | Workspace Capsule Tests | `node --test .compiled/test/main/workspace-capsule.test.js` | 100% passing |
| 5 | Chrome Sync Tests | `node --test .compiled/test/main/chrome-profile-sync-import.test.js` | 100% passing |
| 6 | Full Test Suite | `npm test` | All test suites passing |
| 7 | Live Google Sign-in | Live Electron launch in isolated userData | Password screen rendered (`hasPassword: true`) |

## Success Criteria
- [x] Direct Google sign-in reaches password screen on live Electron run with `userAgentMode: "native"`
- [x] All automated unit and integration tests pass cleanly
- [x] No regression in Theme QA, layout overflow, split review, or terminal subsystems
