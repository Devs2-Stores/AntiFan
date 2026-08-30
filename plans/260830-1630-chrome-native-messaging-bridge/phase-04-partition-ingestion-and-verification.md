---
phase: 4
title: "Capsule Partition Ingestion, Isolation & Full Verification Suite"
status: ready
priority: P1
effort: "4h"
dependencies: ["3"]
---

# Phase 4: Capsule Partition Ingestion, Isolation & Full Verification Suite

## Overview
Phase 4 connects the entire pipeline together by ingesting domain-scoped, delta-synced cookies directly into isolated capsule session partitions (`persist:capsule-<id>`) or active tab sessions within AntiFan Browser Desktop. It enforces strict partition isolation (preventing cross-capsule account pollution), executes RFC 6265bis cookie sanitization, provides real-time UI telemetry to the Desktop toolbar, and executes a comprehensive regression test suite.

---

## Requirements

1. **Target Partition Resolution & Explicit Capsule Binding**:
   - `POST /api/cookies/import` and Native IPC handlers resolve the target session using explicit `targetPartition` / `targetCapsuleId` (e.g. `persist:capsule-<id>`).
   - **Anti-Race Condition Guard**: Background delta-sync requests MUST supply an explicit `targetPartition` or `targetCapsuleId`. Requests with missing partition targets are rejected with HTTP 400 (`MISSING_TARGET_PARTITION`) to prevent cross-tab contamination when the user switches tabs during an in-flight sync.
   - 1-Click Sync UI captures the exact `targetTabId` and `targetPartition` at the moment the user clicks, locking the destination before transmitting.
2. **RFC 6265bis Cookie Sanitization & Delta Execution**:
   - Upsert path: Processes cookies via `extensionCookieImportSetDetails`:
     - `__Host-` prefix validation: forces `secure: true`, `path: '/'`, and strips `domain` attribute per RFC 6265bis.
     - `__Secure-` prefix validation: forces `secure: true`.
     - `sameSite` policy preservation (`unspecified`, `no_restriction`, `lax`, `strict`).
     - Drops expired cookies (`expirationDate <= Date.now() / 1000`).
   - Removal path: Processes delta removals via `targetSession.cookies.remove(url, name)`.
   - Store Durability: Executes `await targetSession.cookies.flushStore()` to commit changes to SQLite on disk immediately.
3. **Partition Isolation & Cross-Account Protection**:
   - Total isolation: Cookies imported into Capsule 1 (e.g. Merchant Store A) must NEVER be accessible or visible in Capsule 2 (Merchant Store B) or `session.defaultSession`.
   - Prevents session hijacking, multi-store account mixing, and CSRF cross-talk.
4. **Desktop Toolbar UI & Live Feedback**:
   - Dispatches `TOOLBAR_CHANNELS.COOKIE_SYNC_COMPLETED` with sync stats (`{ count, domains, targetPartition }`).
   - Toolbar status indicator displays synced status with timestamp and active capsule indicator.
5. **Comprehensive Verification Matrix**:
  - Automated unit test coverage for framing, manifest installer, domain scoping, and IPC handshake.
  - End-to-end integration test verifying full pipeline: Built Chrome extension in browser -> Native Host stdio framing -> nonce-authenticated Named Pipe -> BridgeServer -> Partitioned Session.
---

## Architecture & Partition Routing Matrix

```
┌────────────────────────────────────────────────────────────────────────┐
│             BridgeServer Ingestion Handler (/api/cookies/import)       │
│                                                                        │
│  Payload: {                                                            │
│    targetPartition: 'persist:capsule-haravan-store-1',                 │
│    upserted: [ { name: 'HRV_SESSION', domain: '.haravan.com', ... } ], │
│    removed:  [ { name: 'OLD_TOKEN', domain: '.haravan.com', ... } ]   │
│  }                                                                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Partition Resolver (NativeTabHost Session)               │
│                                                                        │
│  targetSession = tabHost.getPartitionSession(targetPartition)          │
│  (Isolated Electron Session with its own SQLite Cookie Jar)            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          ▼                                                   ▼
┌───────────────────────────────────┐       ┌───────────────────────────────────┐
│     Delta Ingestion: Upserts      │       │     Delta Ingestion: Removals     │
│                                   │       │                                   │
│  1. extensionCookieImportSetDetails│       │  1. Compute cookie URL            │
│  2. await cookies.set(details)    │       │  2. await cookies.remove(url, name│
└─────────────────┬─────────────────┘       └─────────────────┬─────────────────┘
                  │                                           │
                  └─────────────────────┬─────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   await targetSession.cookies.flushStore()             │
│              (Guarantees immediate SQLite persistence on disk)         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│            Broadcast State & Update AntiFan Desktop Toolbar            │
│                 (TOOLBAR_CHANNELS.COOKIE_SYNC_COMPLETED)               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Related Code Files

| Action | Path | Purpose |
|---|---|---|
| **Modify** | `src/main/bridge/bridge-server.ts` | Support delta sync (`upserted` / `removed`), target partition routing, and token validation. |
| **Modify** | `src/main/browser/chrome-profile-sync.ts` | Ensure `extensionCookieImportSetDetails` handles all RFC 6265bis edge cases. |
| **Modify** | `src/main/browser/native-tab-host.ts` | Wire partition resolution and toolbar status broadcast. |
| **Create** | `test/main/capsule-partition-cookie-isolation.test.ts` | Rigorous tests verifying complete isolation between multiple capsule partitions. |
| **Create** | `test/main/native-messaging-e2e-pipeline.test.ts` | End-to-end integration test exercising the built extension loaded in browser -> packaged native host with stdin/stdout framing -> nonce-authenticated Named Pipe -> live BridgeServer -> real isolated Electron session pipeline. |

---

## Implementation Steps

### 1. Partitioned Delta Ingestion in `BridgeServer` (`src/main/bridge/bridge-server.ts`)
```typescript
if (pathname === '/api/cookies/import' && req.method === 'POST') {
  // Read body & verify ephemeral/bridge token...
  const data = JSON.parse(body || '{}');
  const upserted: ExtensionCookieInput[] = Array.isArray(data.cookies) ? data.cookies : (Array.isArray(data.upserted) ? data.upserted : []);
  const removed: Array<{ name: string; domain: string; path?: string; secure?: boolean }> = Array.isArray(data.removed) ? data.removed : [];
  
  // Strict partition resolution & anti-race validation (no silent fallback to active tab)
  let targetSession: Electron.Session | null = null;
  const rawPartition = data.targetPartition || (data.targetCapsuleId ? `persist:capsule-${data.targetCapsuleId}` : null);
  
  if (!rawPartition || typeof rawPartition !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'MISSING_TARGET_PARTITION', message: 'Explicit targetPartition or targetCapsuleId is required.' }));
    return;
  }

  // Validate partition against registered capsule sessions (reject arbitrary partition injection)
  if (!this.tabHost.isValidCapsulePartition(rawPartition)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'UNKNOWN_TARGET_PARTITION', message: `Partition "${rawPartition}" is not an active or registered capsule session.` }));
    return;
  }

  targetSession = this.tabHost.getPartitionSession(rawPartition);
  let importedCount = 0;
  let removedCount = 0;
  let skippedCount = 0;

  // 1. Process Upserts
  for (const cookie of upserted) {
    const setDetails = extensionCookieImportSetDetails(cookie);
    if (!setDetails) {
      skippedCount++;
      continue;
    }
    try {
      await targetSession.cookies.set(setDetails);
      importedCount++;
    } catch {
      skippedCount++;
    }
  }

  // 2. Process Removals
  for (const rem of removed) {
    const scheme = rem.secure ? 'https://' : 'http://';
    const host = (rem.domain || '').replace(/^\./, '');
    const url = `${scheme}${host}${rem.path || '/'}`;
    try {
      await targetSession.cookies.remove(url, rem.name);
      removedCount++;
    } catch {}
  }

  // 3. Flush Cookie Store
  try {
    await targetSession.cookies.flushStore();
  } catch {}

  res.writeHead(200, responseHeaders);
  res.end(JSON.stringify({
    status: 'SUCCESS',
    importedCount,
    removedCount,
    skippedCount,
    targetPartition: targetSession === session.defaultSession ? 'default' : 'capsule-partition',
  }));
}
```

### 2. Capsule Partition Isolation Test (`test/main/capsule-partition-cookie-isolation.test.ts`)
```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { session } from 'electron';
import { extensionCookieImportSetDetails } from '../../src/main/browser/chrome-profile-sync';

test('Capsule partition cookie isolation guarantees zero cross-partition leakage', async () => {
  const capsuleASession = session.fromPartition('persist:capsule-test-store-a');
  const capsuleBSession = session.fromPartition('persist:capsule-test-store-b');
  const defaultSession = session.defaultSession;

  // 1. Ingest cookie into Capsule A using extensionCookieImportSetDetails
  const cookieDetails = extensionCookieImportSetDetails({
    name: 'haravan_session',
    value: 'auth-token-store-a',
    domain: '.haravan.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  });
  assert.ok(cookieDetails, 'cookieDetails should be valid');
  await capsuleASession.cookies.set(cookieDetails);

  // 2. Query all three sessions
  const cookiesA = await capsuleASession.cookies.get({ name: 'haravan_session' });
  const cookiesB = await capsuleBSession.cookies.get({ name: 'haravan_session' });
  const cookiesDefault = await defaultSession.cookies.get({ name: 'haravan_session' });

  // 3. Verify exact partition isolation
  assert.equal(cookiesA.length, 1);
  assert.equal(cookiesA[0].value, 'auth-token-store-a');
  assert.equal(cookiesB.length, 0);
  assert.equal(cookiesDefault.length, 0);

  // Clean up test cookie
  await capsuleASession.cookies.remove('https://haravan.com/', 'haravan_session');
});
```


---

## Success Criteria & Test Plan

- [ ] **Verification Matrix**:
  | Test Suite | File | Coverage Area | Status |
  |---|---|---|---|
  | Framing & Protocol | `test/main/native-messaging-framing.test.ts` | 32-bit LE uint32 parsing, stream chunking, asymmetric 64 MiB inbound / 1 MiB outbound limits | Planned |
  | Manifest & Installer | `test/main/native-messaging-installer.test.ts` | Windows Registry keys (`HKCU`), manifest generation, idempotent install/uninstall | Planned |
  | Windows ACL & Nonce Security | `test/main/windows-acl.test.ts` | User SID resolution, fail-closed DACL enforcement & invariant assertions | Planned |
  | IPC & Handshake | `test/main/native-messaging-ipc-handshake.test.ts` | Windows Named Pipe, 256-bit launchNonce verification, ephemeral token generation | Planned |
  | Domain Scoping & PSL | `test/main/domain-scoper.test.ts` | Google, E-Commerce, active tab eTLD+1 extraction, complex TLD handling | Planned |
  | MV3 Extension Bundling | `test/main/extension-bundle.test.ts` | Classic IIFE bundle validation, zero runtime imports, manifest compatibility | Planned |
  | Partition Isolation & Validation | `test/main/capsule-partition-cookie-isolation.test.ts` | Capsule A vs B isolation, RFC 6265bis rules, missing/unknown partition rejection, delta removal | Planned |
  | End-to-End Pipeline | `test/main/native-messaging-e2e-pipeline.test.ts` | Built extension in Chrome -> native host stdio framing -> nonce-authenticated Named Pipe -> BridgeServer -> Real Partition Sessions | Planned |
  | Packaged Artifact Smoke | `scripts/smoke-native-messaging-packaged.mjs` | Spawns packaged `antifan-bridge-host.exe`, executes `connectNative` handshake | Planned |

- [ ] **Acceptance Criteria**:
  - `npm test` runs with 0 failures across the entire test suite.
  - Packaged executable `antifan-bridge-host.exe` launches without external Node install and communicates via stdio framing.
  - Zero-touch pairing succeeds in <50ms without user token copying.
  - Domain-scoped sync transfers targeted cookies with 0 cross-capsule contamination.
---

## Risk Assessment & Mitigation
- **Risk**: Target partition destroyed while cookie sync is in-flight.
  - **Mitigation**: BridgeServer checks `webContents.isDestroyed()` and safely catches unhandled session errors during `cookies.set()`.
- **Risk**: Disk write bottleneck during high-frequency delta sync.
  - **Mitigation**: Debouncer aggregates writes so `flushStore()` is called at most once per debounced burst.
