---
phase: 1
title: "Partition Configurator & UserAgentMode"
status: in-progress
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Partition Configurator & UserAgentMode

## Overview
Implement a session partition configurator in `src/main/browser/browser-session-partition.ts` that configures `userAgentMode: "native" | "clean"` when a partition is first resolved before view construction. In `src/main/index.ts`, remove global `onBeforeSendHeaders` interceptors from `defaultSession`. When a partition is configured in `native` mode, it preserves the authentic native Electron User-Agent without any header tampering. In `clean` mode, it applies `cleanElectronUserAgent` for storefront compatibility. All existing `getSecureWebPreferences` sandbox invariants remain strictly enforced.

## Requirements
- **Session Partition Configurator**: Export `configureBrowserSessionPartition(partition: string, mode?: 'clean' | 'native')` in `src/main/browser/browser-session-partition.ts`.
- **First-Resolution Hook**: Track configured partitions in a `Set<string>` to ensure policies are installed once on the partition's `session.fromPartition(partition)` instance before any `WebContentsView` is constructed with that partition.
- **Native Mode Invariant**: In `native` mode, the runtime's native User-Agent is preserved without any `onBeforeSendHeaders` interceptors tampering with HTTP headers.
- **Clean Mode Invariant**: In `clean` mode, `cleanElectronUserAgent` is applied to ensure Cloudflare Turnstile and storefront compatibility.
- **Global Policy Removal**: Remove `onBeforeSendHeaders` tampering on `defaultSession` in `src/main/index.ts`.

## Architecture
```
[Pre-View Construction]
          │
          ▼
configureBrowserSessionPartition(partition, userAgentMode)
          │
          ├─► Already configured? Return existing session
          │
          ▼
   sess = session.fromPartition(partition)
          │
          ├── userAgentMode === "native"
          │     └─► Zero UA laundering / Zero onBeforeSendHeaders
          │
          └── userAgentMode === "clean"
                └─► cleanElectronUserAgent(sess)
```

## Related Code Files
- Create: `src/main/browser/browser-session-partition.ts`
- Modify: `src/main/browser/google-auth-identity.ts`
- Modify: `src/main/index.ts`
- Modify: `test/main/google-auth-identity.test.ts`

## Implementation Steps
1. Create `src/main/browser/browser-session-partition.ts` with `configureBrowserSessionPartition` and partition registry tracking.
2. In `src/main/index.ts`, remove global `onBeforeSendHeaders` tampering on `defaultSession`, routing session policies through `configureBrowserSessionPartition`.
3. Update `test/main/google-auth-identity.test.ts` to test partition-level `native` vs `clean` behavior.

## Success Criteria
- [x] `configureBrowserSessionPartition('persist:test-native', 'native')` preserves authentic Electron UA with zero header listeners
- [x] `configureBrowserSessionPartition('persist:test-clean', 'clean')` applies clean desktop Chrome UA
- [x] `src/main/index.ts` does not install global header-mangling interceptors on `defaultSession`
- [x] Unit tests pass: `node --test .compiled/test/main/google-auth-identity.test.js`

## Risk Assessment
- **Risk**: Double-attaching listeners if partition is configured multiple times.
- **Mitigation**: Track configured partition names in an internal `Set<string>` guard.
