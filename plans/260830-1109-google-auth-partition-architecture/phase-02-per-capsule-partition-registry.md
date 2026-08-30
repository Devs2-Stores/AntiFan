---
phase: 2
title: "Tab Ownership Migration & Partition Routing"
status: pending
priority: P1
effort: "4h"
dependencies: ["1"]
---

# Phase 2: Tab Ownership Migration & Partition Routing

## Overview
Migrate tab ownership and state so `capsuleId` and `userAgentMode` are persisted in `AntiFanTab` and passed into `createTab`, `restoreTabs`, and split-view creation before `WebContentsView` construction. Ensure all tabs (standard, restored, preview, and split views) resolve their deterministic partition (`persist:capsule-<id>` or `persist:capsule-<id>-native`), call `configureBrowserSessionPartition`, and pass `partition` to `getSecureWebPreferences(partition)`.

## Requirements
- **State Migration**: Update `AntiFanTab` contract in `src/shared/contracts.ts` to include `capsuleId?: string` and `userAgentMode?: 'clean' | 'native'`.
- **Pre-Construction Creation Routing**: Update `NativeTabHost.createTab(url, activate, options?: { capsuleId?: string; userAgentMode?: 'clean' | 'native' })` to:
  1. Determine the effective capsule ID (from options or active capsule fallback).
  2. Resolve the partition string: `persist:capsule-<id>` (or `persist:capsule-<id>-native` if `userAgentMode === 'native'`).
  3. Call `configureBrowserSessionPartition(partition, userAgentMode)` before view instantiation.
  4. Pass `partition` to `getSecureWebPreferences(partition)`.
  5. Construct `new WebContentsView({ webPreferences })`.
- **Restoration Routing**: In `restoreTabs`, pass the persisted `capsuleId` and `userAgentMode` from `saved-tabs.json` directly into `createTab` so restored tabs never misroute to `defaultSession`.
- **Split-View Routing**: In split-view creation, pass the parent tab's `capsuleId` and `userAgentMode` to the secondary mobile `WebContentsView`.
- **Persistence**: Persist `capsuleId` and `userAgentMode` in `persistTabs` to `saved-tabs.json`.

## Architecture
```
[createTab(url, activate, { capsuleId, userAgentMode })]
               │
               ▼
[Resolve Partition: 'persist:capsule-' + id]
               │
               ▼
[configureBrowserSessionPartition(partition, userAgentMode)]
               │
               ▼
[getSecureWebPreferences(partition)]
  returns {
    partition: 'persist:capsule-' + id,
    contextIsolation: true,
    sandbox: true,
    preload: resolvedPreload,
    ...
  }
               │
               ▼
[new WebContentsView({ webPreferences })]
```

## Related Code Files
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/security/security-policy.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/main/project/workspace-capsule.ts`
- Modify: `test/main/security-policy.test.ts`
- Modify: `test/main/workspace-capsule.test.ts`
- Modify: `test/main/native-tab-host-agent-lifecycle.test.ts`

## Implementation Steps
1. Update `AntiFanTab` interface in `src/shared/contracts.ts`.
2. Update `getSecureWebPreferences(partition?: string)` in `src/main/security/security-policy.ts`.
3. Update `NativeTabHost.createTab`, `restoreTabs`, and split-view creation in `src/main/browser/native-tab-host.ts`.
4. Update `persistTabs` in `native-tab-host.ts` to write `capsuleId` and `userAgentMode`.
5. Update unit tests in `test/main/security-policy.test.ts` and `test/main/workspace-capsule.test.ts`.

## Success Criteria
- [x] Restored tabs load with their persisted capsule partition instead of `defaultSession`
- [x] Tabs across different capsules have isolated cookie jars without cross-talk
- [x] Tests pass: `node --test .compiled/test/main/security-policy.test.js .compiled/test/main/workspace-capsule.test.js`

## Risk Assessment
- **Risk**: Legacy `saved-tabs.json` files lacking `capsuleId`.
- **Mitigation**: Gracefully fall back to the active capsule ID or default partition `persist:capsule-default`.
