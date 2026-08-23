# Plan: Agent Cursor Trajectory & In-Page Bézier Kinematics Engine

## Status: IMPLEMENTATION_COMPLETE (15/15 Unit Tests Passing; Live MCP Verification Blocked on Host Broker Reload)
## Architecture Supervision: KongMing Advisory (`ak:fable-thinking` + `ak:cook`)

### Outcome
Enable seamless, continuous, multi-step mouse trajectories for AntiFan Browser AI Agent. Replaces sequential stop-and-go 1-1 tool calls with 60 FPS in-page Cubic Bézier spline motion, Fitts's law velocity profiles, lazy DOM element coordinate resolution, robust navigation interruption guards, and single-click activation.

### Phases Summary
- [X] [Phase 1: In-Page Kinematics Engine](phase-01-in-page-bezier-kinematics-engine.md) - [COMPLETED] Cubic Bézier path generator, Fitts's law easing, ambient wandering, multi-action loop (`window.__antifanAgentTrajectory`), single-activation click.
- [X] [Phase 2: Main Process & Port Wiring](phase-02-native-tab-host-trajectory-api.md) - [COMPLETED] `NativeTabHost.agentTrajectory` with `try/finally` navigation guard, `BrowserControlPort.agentTrajectory`, and `browser.agent-trajectory` capability.
- [X] [Phase 3: Tool & RPC Surface](phase-03-mcp-and-bridge-tool-registration.md) - [COMPLETED] `anti.agent.cursor.trajectory` alias & MCP tool handler, `antifan.agentTrajectory` WebSocket RPC handler.
- [X] [Phase 4: Tests & Verification](phase-04-tests-and-live-verification.md) - [COMPLETED] 15/15 unit tests pass, zero TypeScript typecheck errors. Live MCP invocation blocked pending broker reload.

### Verification Evidence
1. **TypeScript Typecheck:** `npm run typecheck` ➔ **0 errors (100% clean)**.
2. **In-Page Script, Trajectory & Bézier Unit Tests (`agent-browser-script.test.ts`):** 6/6 PASS.
   - Verified single-click activation (`clickCount === 1`).
   - Verified trajectory contract accounting and navigation interruption invariants (`success: false`, exact step count, explicit reason).
3. **Capability Catalogue Suite (`capability-catalogue.test.ts`):** 3/3 PASS.
4. **Multi-Window Terminal Suite (`multi-window-terminal.test.ts`):** 6/6 PASS.
