---
phase: 2
title: "Dual-Channel Persistent Transport & RPC Multiplexing"
status: pending
priority: P0
effort: "2.5h"
dependencies: [1]
---

# Phase 02: Dual-Channel Persistent Transport & RPC Multiplexing

## Overview
Refactors `scripts/antifan-omp-mcp.cjs` to eliminate the per-call `new WebSocket()` and `ws.close()` lifecycle. Establishes a long-lived multiplexed dispatch socket with UUID request correlation, preserves an isolated heartbeat channel for periodic session renewal (`antifan.cli.renewSession`), and supports both `bridgeToken` and `secret-only` authentication modes with exponential backoff auto-reconnect.

## Requirements
- **Functional:**
  - `antifan-omp-mcp.cjs` maintains a persistent WebSocket connection for capability dispatching across the entire lifetime of the MCP stdio server.
  - RPC calls use unique message IDs (`id = crypto.randomUUID()`) tracked via an in-memory `Map<string, { resolve, reject, timer }>`.
  - Independent heartbeat channel (`heartbeatWs`) continues sending `antifan.cli.renewSession` every 30 seconds without blocking capability traffic.
  - Automatic reconnection with exponential backoff (1s, 2s, 4s, max 10s) upon connection drop or bridge server restart.
  - Support both `token: session.bridgeToken` (normal launcher) and `secret: bootstrap.secret` (headless/fallback).
- **Non-functional:**
  - Zero connection churn: Single persistent dispatch socket serves sequential or concurrent tool invocations.
  - Fault isolation: A long-running command (e.g. `theme.qa_validate`) does not delay or block session renewal heartbeats.
  - Safe teardown: Process signals (SIGINT, SIGTERM, stdin close) cleanly terminate all active sockets.

## Architecture
```
┌────────────────────────────────────────────────────────────────────────┐
│ scripts/antifan-omp-mcp.cjs (Stdio Server Lifetime)                    │
│                                                                        │
│  ┌───────────────────────────┐        ┌─────────────────────────────┐  │
│  │ Channel A: Heartbeat WS   │        │ Channel B: Dispatch WS      │  │
│  │  - Sends renewSession     │        │  - Persistent Multiplexer   │  │
│  │  - Cadence: 30s           │        │  - In-flight Pending Map    │  │
│  │  - Isolated from tools    │        │  - Per-RPC UUID Correlation │  │
│  └─────────────┬─────────────┘        └──────────────┬──────────────┘  │
└────────────────┼─────────────────────────────────────┼─────────────────┘
                 │ (ws://127.0.0.1:20129)              │ (ws://127.0.0.1:20129)
                 ▼                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ src/main/bridge/bridge-server.ts (Electron Main)                       │
│  ├── Handles antifan.cli.renewSession (Extends attachment expiry)      │
│  └── Handles antifan.capability.dispatch (Dispatches to Control Plane) │
└────────────────────────────────────────────────────────────────────────┘
```

## Related Code Files
- Modify: `scripts/antifan-omp-mcp.cjs` (Implement `ensureDispatchSocket`, `dispatchRpc`, remove `new WebSocket()` inside `invoke()`).
- Create: `test/main/mcp-persistent-transport.test.ts` (E2E transport unit test testing multiplexing, concurrent RPC dispatch, and auto-reconnect).

## Implementation Steps
1. **Multiplexed Dispatch Socket Manager:**
   - In `scripts/antifan-omp-mcp.cjs`, declare `let dispatchWs = null`, `const pendingCalls = new Map()`, `let reconnectTimer = null`.
   - Implement `ensureDispatchSocket(bootstrap, onReady)` returning a single connected socket.
   - Attach message handler that extracts `response.id`, looks up `pendingCalls.get(response.id)`, clears timer, and resolves/rejects the call promise.
2. **Refactor `invoke()` to Use Persistent Channel:**
   - Replace ephemeral socket creation in `invoke()` with `ensureDispatchSocket()`.
   - Generate `const id = crypto.randomUUID()`.
   - Set 15s timer for normal capabilities (60s for `theme.qa_validate`).
   - Register in `pendingCalls`, send JSON payload, await resolution.
3. **Reconnection & Failover:**
   - On dispatch socket `close` or `error`, reject all in-flight calls with `CAPABILITY_ERROR` (`Connection dropped`).
   - Clean up socket reference and trigger backoff reconnection if stdio is still active.
4. **Unit & Stress Testing:**
   - Test firing 10 concurrent tool calls through the multiplexed channel and verify all 10 resolve correctly via UUID matching.
   - Test simulate bridge crash and verify auto-reconnect restores capability dispatch.

## Success Criteria
- [ ] No socket creation/destruction logs during successive tool calls.
- [ ] 10 concurrent capability dispatches resolve without cross-talk or race conditions.
- [ ] Heartbeat renewal runs continuously without interference from tool dispatch.
- [ ] `test/main/mcp-persistent-transport.test.ts` passes 100% green.

## Risk Assessment
- **Risk:** Socket disconnects while a request is in flight.
- **Mitigation:** Cleanly reject pending promises with structured `CONNECTION_LOST` error and schedule immediate socket rebuild.
