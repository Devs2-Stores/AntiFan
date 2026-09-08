---
phase: 3
title: "MCP Client-Only Cutover"
status: pending
priority: P0
effort: "1-1.5d"
dependencies: [2]
---

# Phase 3: MCP Client-Only Cutover

## Overview

Make the Node stdio adapter the sole external MCP entry and route every execution through the running GUI Bridge and a bound attachment; remove the second Electron Core/profile-owner path.

## Requirements

- Functional: MCP stdio discovers/authenticates the GUI Bridge, starts one attachment-scoped session, and receives browser authority before tools become ready.
- Functional: Desktop unavailable produces `MCP_BRIDGE_OFFLINE` on stderr and a non-zero exit.
- Non-functional: No MCP process acquires the persistent Chromium profile, creates GUI windows, or hosts an unbound `AntiFanMcpServer`.

## Architecture

```text
IDE/OMP --stdio--> scripts/antifan-omp-mcp.cjs
                    └── authenticated WebSocket --> GUI BridgeServer
                                                     └── attachment-bound transport
```

The GUI remains the only Core/profile owner. Bridge and proxy protocol changes are one atomic deployment boundary.

## Related Code Files

- Modify: `src/main/index.ts`
- Modify: `src/main/bridge/bridge-server.ts`
- Modify: `scripts/antifan-omp-mcp.cjs`
- Modify: `src/main/mcp/mcp-server.ts` to remove only stdio `start()`/`stop()` and `StdioServerTransport`; retain `AntiFanMcpServer`, `callTool()`, `listTools()`, and `buildMcpToolList` for in-memory tests/benchmarks
- Modify: `scripts/antifan-agent.cjs`
- Modify: `package.json` to expose the canonical Node MCP proxy entrypoint
- Modify: MCP adapter, Bridge, startup, and profile ownership tests under `test/main/`
- Delete: Electron `--mcp-server` Core bootstrap and standalone unbound execution paths

## Implementation Steps

1. Freeze the proxy-to-Bridge bootstrap response: attachment ID, scoped secret, authority revision, and browser target are mandatory before exposing capability readiness.
2. Make the `startSession` WebSocket upgrade bind the connection to the issued attachment; reject subsequent calls whose attachment lineage differs.
3. Route every MCP capability through `CapabilityTransportAdapter` with injected attachment authority; remove master-token direct execution paths.
4. Remove Electron `--mcp-server` bypass of the single-instance/profile ownership lifecycle and any path that starts another Core or GUI window for stdio.
5. Make the Node proxy the configured stdio executable; remove only the stdio transport lifecycle from `AntiFanMcpServer`, retaining its in-memory tool catalogue/test surface.
6. Define deterministic discovery failure: bounded connection attempts, sanitized `MCP_BRIDGE_OFFLINE`, non-zero process exit, no auto-started Core.
7. Make Bridge shutdown/session expiry settle outstanding calls and close owned agent tabs without affecting the user plane.
8. Update behavior tests; replace source-text policy tests only when they assert an obsolete implementation rather than consumer behavior.
9. Run process-level smoke with GUI running, GUI absent, two simultaneous proxies, proxy crash, GUI shutdown, and restart.

## Success Criteria

- [ ] GUI and MCP never contend for the same profile lock.
- [ ] Successful stdio initialization has a valid attachment, scoped credential, authority revision, and browser target.
- [ ] Master-authenticated but attachment-unbound sockets cannot execute capabilities.
- [ ] Two MCP proxies receive independent bindings and cannot invoke through each other's credentials.
- [ ] GUI absent returns `MCP_BRIDGE_OFFLINE` and non-zero exit without opening Electron.
- [ ] Proxy termination expires its attachment and closes only its agent resources.

## Risk Assessment

- **Atomic protocol compatibility:** mismatched Bridge/proxy versions can make all MCP tools unavailable. Signal: bootstrap response lacks mandatory authority fields. Response: ship and roll back both sides together; fail readiness rather than run degraded.
- **Stdio corruption:** diagnostics on stdout can break MCP framing. Signal: client JSON parse failure. Response: reserve stdout for protocol frames and send sanitized diagnostics to stderr.
- **Socket privilege retention:** a socket may remain master-scoped after session creation. Signal: direct RPC succeeds without attachment credentials. Response: bind or replace the socket atomically at `startSession` and test post-upgrade authorization.
