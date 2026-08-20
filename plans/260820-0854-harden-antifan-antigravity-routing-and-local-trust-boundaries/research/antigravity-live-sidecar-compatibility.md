# Antigravity Live Sidecar Compatibility & Semantics Report

**Date**: 2026-08-20  
**Phase**: Phase 3 (Prove Antigravity Conversation and AgentAPI Semantics)  
**Status**: VERIFIED & AUDITED  

---

## 1. System & Runtime Environment Fingerprint

| Property | Live Discovered Value | Verification Method |
|---|---|---|
| **OS Platform** | Windows 11 (win32, x64) | `process.platform`, `process.arch` |
| **Node.js Runtime** | `v24.13.0` (`C:\Program Files\nodejs\node.exe`) | `node scripts/probe-agentapi-sidecar.mjs --json` |
| **AgentAPI Executable** | `C:\Users\Admin\.gemini\antigravity-ide\bin\agentapi.bat` | `resolveAgentApiExecutable()` path search |
| **Brain Root Path** | `C:\Users\Admin\.gemini\antigravity-ide\brain\` | `path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain')` |
| **Sidecar Router ID** | `antifan-chat-router` | `sidecars/antifan-chat-router/sidecar.json` |
| **Protocol Version** | Protocol v2 (Command Bridge) / Protocol v1 (Sidecar HMAC) | Hash/AuthTag canon signed envelope |

---

## 2. Conversation ID Discovery & Invariants

1. **Format & Regular Expression**:
   - UUID pattern: `/^[A-Za-z0-9_.-]{4,128}$/`
   - Canonical format matches standard UUIDv4 (e.g. `1d321a18-37bd-4165-bd69-39d808c91ace`).

2. **Containment & Boundary Validation**:
   - Every target conversation must be a direct child directory of `brainDir`.
   - Path resolution (`path.resolve`) and symlink resolution (`fs.realpathSync`) are verified before reading, writing, or managing session assets.
   - Any path traversal attempt (such as `../` or `..\..\..\Desktop`) is rejected fail-closed.

---

## 3. Strict State Separation (Proof vs. Telemetry)

Following the master workspace engineering invariant:

```text
┌────────────────────────────────────────────────────────┐
│               Independent Dual-Axis Model              │
├──────────────────────────┬─────────────────────────────┤
│ deliveryState            │ observationState            │
│ (Authoritative Proof)    │ (Passive Telemetry)         │
├──────────────────────────┼─────────────────────────────┤
│ - queued                 │ - none                      │
│ - ide-api-accepted       │ - prompt-observed           │
│ - failed                 │ - response-observed         │
│ - unknown                │                             │
│                          │                             │
│ * Driven ONLY by bound   │ * Driven passively by       │
│   HMAC signed .res.json  │   transcript.jsonl polling  │
│   receipts or error code │                             │
└──────────────────────────┴─────────────────────────────┘
```

1. **Authoritative Receipt Proof**:
   - `deliveryState` is ONLY set to `ide-api-accepted` upon consuming a valid, signed `.res.json` receipt from the Sidecar/Extension bridge.
   - Passive observation of text in `transcript.jsonl` NEVER alters `deliveryState`.

2. **Timeout Inversion Invariant**:
   - Extension / Sidecar deadline: 20s.
   - Desktop Client timeout: 30s.
   - Eliminates false-negative `unknown` timeouts.

3. **Fail-Closed Auto Routing**:
   - If Sidecar is offline or unmapped, `mode === 'auto'` returns `EXACT_ROUTE_UNAVAILABLE` and `failed`.
   - Never falls through to active panel without explicit user command (`draft` mode).

---

## 4. GO/NO-GO Verdict

- [x] **GO**: Sidecar runtime closure packaged in `sidecars/antifan-chat-router/`.
- [x] **GO**: Fail-closed exact Auto and abort routes verified.
- [x] **GO**: Session containment and path traversal protections verified.
- [x] **GO**: Strict separation of Authoritative Proof vs. Passive Telemetry established.

Phase 3 is complete. Proceed to Phase 4 (Build Durable Exact Routing and Receipt Reconciliation).
