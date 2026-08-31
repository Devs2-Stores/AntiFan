---
title: "AntiFan MCP Industrial-Grade Overhaul"
status: pending
priority: P1
totalPhases: 4
planSlug: "260831-1800-antifan-mcp-industrial-overhaul"
created: "2026-08-31T18:00:00Z"
targetBranch: "HEAD 9e06cc4"
---

# AntiFan MCP Industrial-Grade Overhaul Plan

## Executive Summary
This plan delivers an industrial-grade overhaul of AntiFan's Model Context Protocol (MCP) subsystem, resolving the root causes of visual QA blindness, transport latency churn, synthetic event unreliability, and debugger contention:
1. **Secure Visual QA & MCP Image Pipeline:** Reconciles with `docs/security-model.md:31-32,54` by keeping capability contracts strictly artifact-referenced (`ArtifactRef`, zero raw-base64 fallback), providing an authenticated, bounded HTTP binary artifact resource endpoint (`GET /api/artifacts/:id`) backed by `ArtifactStore.readBytesById()`, enforcing single-header authentication (`x-antifan-attachment-secret`) with zero query-token leakage, enforcing mandatory run/attempt ownership matching (`ref.runId/attemptId === record.runId/attemptId`) with zero caller exemptions (bridge-token-only rejected), enforcing strict `ref.truncated === true` rejection, and formatting binary image bytes into standard MCP Image blocks (`type: 'image'`) solely within the Stdio adapter.
2. **Dual-Channel Persistent Transport:** Eliminates per-call WebSocket handshake churn by implementing a persistent multiplexed dispatch socket with UUID message correlation in `antifan-omp-mcp.cjs` alongside a dedicated session renewal channel, supporting both `bridgeToken` and `secret-only` auth fallbacks with exponential backoff auto-reconnect.
3. **Pure CSS-Pixel CDP Input & Actionability Pre-flight:** Leverages pane-specific `WebContents` from `getTabWebContents(tabId, paneId)` with pure in-page CSS viewport coordinates (zero DPR scaling / zero window offset distortion), executes genuine hardware-level CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` (`isTrusted: true`), integrates in-page `MutationObserver` actionability gates (1.5s timeout), and provides seamless fallback to synthetic isolated-world events if `wc.debugger` is held by manual DevTools.
4. **E2E Integration & Storefront Verification Suite:** Validates MCP visual image delivery to vision models, transport multiplexing latency reduction, and trusted hardware click interactions against complex dynamic e-commerce components (Haravan/Shopify variant swatches, ajax cart drawers).

---

## Phase Roadmap

| Phase | Title | Priority | Status | Description |
|:---:|---|:---:|:---:|---|
| [01](./phase-01-secure-screenshot-and-artifact-resolver.md) | Secure Screenshot & Server-Side Artifact Resolver | P0 | pending | Enforce `ArtifactRef` contract sanctity (zero legacy raw-text fallback), add authenticated HTTP binary resource endpoint with single `x-antifan-attachment-secret` header auth, mandatory attachment record ownership matching (bridge-token-only rejected), root containment / symlink defense, guard `ref.truncated`, and format MCP `{ type: 'image' }` payload in stdio adapter. |
| [02](./phase-02-dual-channel-persistent-transport.md) | Dual-Channel Persistent Transport & RPC Multiplexing | P0 | pending | Refactor `antifan-omp-mcp.cjs` to use a long-lived multiplexed dispatch socket with request ID map, separate heartbeat channel, token/secret auth dual-mode, and failover auto-reconnect. |
| [03](./phase-03-pure-css-cdp-input-and-actionability.md) | Pure CSS-Pixel CDP Input & Actionability Gate | P0 | pending | Target pane-specific `WebContents`, calculate in-page CSS center coordinates, dispatch native CDP mouse/key events (`isTrusted: true`), integrate in-page actionability pre-flight, and handle debugger contention gracefully. |
| [04](./phase-04-e2e-integration-and-storefront-benchmarks.md) | E2E Integration Suite & Real-Storefront Benchmarks | P1 | pending | Implement comprehensive E2E test suite covering MCP image delivery, transport multiplexing throughput, CDP trusted input on interactive storefront drawers, and fail-closed security boundaries. |

---

## Key Invariants
- **Security Authority Adherence (`docs/security-model.md:31-32,54`):** Raw image Base64 payloads never cross internal capability dispatch contracts; capability outputs return `ArtifactRef` exclusively (all legacy raw-text/base64 fallbacks deleted). Conversion to Base64 occurs strictly at the edge (MCP Stdio Adapter) after authorized binary streaming over single-header authenticated HTTP (`x-antifan-attachment-secret`).
- **Fail-Closed Artifact Ownership & Safety:** Any artifact read must satisfy `ArtifactStore.readBytesById()` root containment, symlink rejection, realpath verification, and mandatory attachment record `runId`/`attemptId` matching. Bridge-token-only callers are rejected without attachment secret. Query string tokens are forbidden on artifact endpoints, and truncated artifacts (`ref.truncated === true`) must fail closed immediately.
- **Zero Coordinate Distortion:** CDP input coordinates must be pure CSS pixels relative to the targeted pane's `WebContents` viewport. No DPR multiplier or Electron host window offsets may be applied.
- **Fault-Isolated Dual Channels:** Transport multiplexing must prevent slow capabilities (e.g. `theme.qa_validate`) from blocking session renewal heartbeats or lightweight inspection calls.
- **Graceful Debugger Fallback:** If `wc.debugger` is attached by manual user DevTools (F12), input actions must log an explicit warning and fall back to Isolated World synthetic dispatch rather than crashing.

---

## Red Team & Advisory Review (Integrated)
- **Advisory Check 1 (Contract Authority):** Fixed Phase 1 architecture so capability layer remains strictly `ArtifactRef`-driven. Binary byte resolution occurs via authorized server boundary, avoiding contract bloat.
- **Advisory Check 2 (Auth Rationale):** Clarified that while `bridgeToken` permits multiplexed traffic, a dual-channel architecture (dedicated heartbeat + multiplexed dispatch) provides strict fault isolation and clean secret-only fallback.
- **Advisory Check 3 (CDP Coordinate System):** Grounded CDP coordinates to pure in-page CSS pixels of the pane's `WebContents`. Banned artificial host window / DPR transformations.
