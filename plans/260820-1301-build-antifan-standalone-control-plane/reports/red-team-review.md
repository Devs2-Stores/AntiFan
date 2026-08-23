---
title: "Standalone control plane red-team review"
status: complete
created: 2026-08-20
scope: planning-only
---

# Standalone Control Plane Red-Team Review

## Method

Hostile security and failure-mode reviewers read the current plan and verified
claims against the live AntiFan repository and the coordinated Antigravity
extension/sidecar repository. Findings without source evidence were excluded.

## Accepted Findings

1. **Critical - Late receipt correlation is not restart-safe.** AntiFan keeps
   pending deliveries in memory (`src/main/browser/native-tab-host.ts:60,
   2063-2114`) and `checkLateReceipt()` validates a late file without the
   original expected binding (`src/main/bridge/antigravity-command-client.ts:415-432`).
2. **Critical - Crash boundaries can duplicate or lose dispatch state.** The
   command file is written and polled in memory (`src/main/bridge/antigravity-command-client.ts:295-363`),
   while startup does not rebuild pending work (`src/main/browser/native-tab-host.ts:70-138`).
3. **Critical - DeliveryLedger is not a durable event authority.** It is an
   unversioned mutable JSON array/map and parse failures reset to empty
   (`src/main/bridge/delivery-ledger.ts:25-72`).
4. **High - PTY ownership/shutdown is global and incomplete.** TerminalManager
   is singleton/process-global and uses unbound cwd/taskkill behavior
   (`src/main/browser/terminal-manager.ts:9-103`); host disposal does not own
   terminal shutdown (`src/main/browser/native-tab-host.ts:2439-2449`).
5. **High - Backend cancellation/disconnect/resume is unspecified.** No
   ExecutionBackend/RunService exists; current dispatch only polls files and
   times out to unknown (`src/main/bridge/antigravity-command-client.ts:336-352`).
6. **High - Rollback has no drain boundary.** Bootstrap constructs legacy host
   and bridge directly and lacks a retained runtime switch/ownership lifecycle
   (`src/main/index.ts:78-126, 177-185`).
7. **High - MCP lacks authenticated Project attachment.** It stores only a host
   and boolean risk flag and directly dispatches browser/profile operations
   (`src/main/mcp/mcp-server.ts:20-23, 219-341`).
8. **High - Attachment paths are arbitrary/unbounded.** Renderer-supplied paths
   are copied into command JSON without root/reparse/hash/size staging
   (`src/main/bridge/antigravity-command-client.ts:286-301`; extension
   `src/runtime.ts:164-243`).
9. **High - Receipt binding can be bypassed.** Result validation treats several
   binding fields as optional and late reconciliation does not pass the expected
   command (`src/main/bridge/antigravity-command-client.ts:117-136, 415-430`).
10. **High - Terminal accepts arbitrary cwd and inherited environment.** IPC
    controls the singleton terminal with renderer cwd and full `process.env`
    (`src/main/browser/native-tab-host.ts:412-431`; `src/main/browser/terminal-manager.ts:13,35-50`).
11. **High - Active-tab fallback permits cross-tab races.** MCP, bridge, and
    registry use `tabId || getActiveTabId()` (`src/main/mcp/mcp-server.ts:246-275`,
    `src/main/bridge/bridge-server.ts:237-309`, `src/main/browser/browser-action-registry.ts:170-262`).
12. **High - WebSocket bridge bypasses the catalogue and high-risk boundary.**
    It directly switches mutating actions and eval (`src/main/bridge/bridge-server.ts:201-313`),
    while its lease file lacks atomic/epoch/project binding (`:164-179`).
13. **Medium/High - Browser outputs are unbounded/unredacted.** MCP/bridge return
    full DOM and screenshot base64 (`src/main/mcp/mcp-server.ts:256-275`,
    `src/main/bridge/bridge-server.ts:294-305`).
14. **High - Sidecar claim/recovery and receipt binding need parity.** The
    coordinated repo must be checked for atomic claim, stale processing recovery,
    exact workspace/digest/host/instance matching, and timeout behavior before
    AntiFan accepts its receipt (`E:/Work/apps/antigravity-browser/sidecars/antifan-chat-router/router.mjs`,
    `E:/Work/apps/antigravity-browser/src/sidecarRouterClient.ts`).

## Plan Changes

- Added authenticated lease/Project attachment, explicit browser target for
  reads and mutations, staged artifact IDs, strict receipt binding, startup
  recovery, process drain/rollback, and sidecar parity gates to Phases 2, 4, 5,
  6, 8, and 9.
- Added external bridge/sidecar files to the related-code audit surface.
- Whole-plan sweep found zero unresolved contradictions after propagation.

