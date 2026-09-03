---
title: "Terminal-to-Tab Affinity and Concurrency Isolation Architecture"
description: "Implementation plan to establish deterministic Terminal-to-Tab Affinity, eliminate redundant LLM tabList polling, isolate multi-terminal session acquisition, optimize O(1) tab existence validation, and support multi-tab Clone workflows."
status: in-progress
priority: P1
effort: "2h"
tags: ["terminal", "affinity", "concurrency", "control-plane", "mcp"]
created: 2026-09-03
---

# Terminal-to-Tab Affinity and Concurrency Isolation Architecture

## Executive Summary
This plan delivers deterministic Terminal-to-Tab Affinity in AntiFan Browser Desktop:
1. **PTY Lifecycle Identity:** Inject `ANTIFAN_TERMINAL_SESSION_ID` and `ANTIFAN_TERMINAL_GENERATION` into terminal PTY environments in `TerminalManager.spawn()`, with split terminals inheriting parent affinity.
2. **Main-Process Affinity Registry:** Maintain an authoritative `terminalTabAffinity` registry keyed by `sessionId@generation` with enforced 1:1 uniqueness and explicit tombstoning upon tab/terminal closure.
3. **Atomic Main Creation Binding:** Automatically bind active tabs to newly created sessions in `ipcMain.handle('antifan:terminal:new-session')` and startup/restoration without renderer round-trips.
4. **Launcher & Bridge Propagation:** Propagate terminal session parameters in `scripts/antifan-agent.cjs` to `antifan.cli.startSession` on `BridgeServer`, eliminating the singleton `currentAutoTab` fallback.
5. **O(1) Tab Validation:** Introduce `hasTab(tabId)` in `NativeTabHost` backed by `this.tabs.has()`, replacing O(n) array scans in `BrowserControlPort.resolveTargetTab`.

## Phases

| # | Phase | Priority | Effort | Status | Description |
|---|---|---|---|---|---|
| 1 | [Phase 1: PTY Lifecycle Identity & Split Inheritance](./phase-01-pty-identity.md) | P1 | 30m | In Progress | Inject session identity and generation into PTY environment; normalize split terminals to parent session |
| 2 | [Phase 2: Authoritative Affinity Registry & O(1) Tab Host](./phase-02-affinity-registry.md) | P1 | 30m | Pending | Enforce 1:1 uniqueness, lifecycle-keyed registry, atomic new-session binding, and O(1) `hasTab` in NativeTabHost |
| 3 | [Phase 3: Launcher Propagation & Bridge Resolution](./phase-03-launcher-bridge.md) | P1 | 30m | Pending | Propagate terminal session ID in antifan-agent.cjs and resolve attachment browserTarget deterministically in BridgeServer |
| 4 | [Phase 4: Verification & Concurrency Stress Test](./phase-04-verification.md) | P1 | 30m | Pending | Verify multi-terminal concurrency, O(1) validation performance, fail-closed closed-tab handling, and typechecks |

## Acceptance Criteria
- [ ] `TerminalManager.spawn()` injects `ANTIFAN_TERMINAL_SESSION_ID` and `ANTIFAN_TERMINAL_GENERATION`.
- [ ] Split terminals inherit parent session affinity when launching agents.
- [ ] `NativeTabHost` enforces 1:1 uniqueness per terminal session and exposes `hasTab(tabId): boolean` via Map lookup.
- [ ] `antifan:terminal:new-session` atomically binds `this.activeTabId` to the newly created session.
- [ ] `antifan-agent.cjs` sends `terminalSessionId` and `terminalGeneration` to `antifan.cli.startSession`.
- [ ] `BridgeServer` sets `browserTarget.tabId` from terminal affinity; fails closed with clear error if the bound tab was closed.
- [ ] `BrowserControlPort.resolveTargetTab` checks tab existence using `hasTab(tabId)` in O(1).
- [ ] Zero build/typecheck errors (`npm run check` or `tsc --noEmit`).
