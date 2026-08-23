# Phase 4: Tests & Verification Report

## Goal
Verify trajectory script syntax, Bézier execution algorithms, single-click activation, step accounting, lifecycle cleanup, and navigation interruption handling.

## Verification Evidence
1. **TypeScript Typecheck:** `npm run typecheck` ➔ **0 errors (100% clean)**.
2. **Behavioral In-Page Trajectory & Bézier Unit Tests (`test/main/agent-browser-script.test.ts`):**
   - Syntax validation of `AGENT_BROWSER_SCRIPT` and `ELEMENT_PICKER_SCRIPT`.
   - Global hooks validation (`__antifanAgentTrajectory`, `__antifanRefMap`, `generateBezierPath`, etc.).
   - Deep query selector and `@ref` resolution tests.
   - Algorithmic structure test for Cubic Bézier interpolation (`getCubicBezierPoint`).
   - **In-VM Behavioral Execution:** Executed multi-step trajectory (`hover` ➔ `click` ➔ `scroll`) inside an isolated VM DOM context with mock element dimensions and deterministic timers:
     - `result.success === true`
     - `result.executedSteps === 3`
     - `result.totalSteps === 3`
     - Final coordinates match target element center (`{ x: 225, y: 215 }`).
     - **Single-Click Activation:** Verified `click` event is dispatched exactly 1 time on target element.
     - **Deterministic Timer Teardown:** Verified active timer pool is cleared without leaving background timer leaks.
3. **Capability Catalogue Suite (`test/main/capability-catalogue.test.ts`):**
   - Verified `browser.agent-trajectory` capability registration and policy enforcement (3/3 PASS).
4. **Navigation Interruption Handling (`NativeTabHost.agentTrajectory`):**
   - Attached `did-start-navigation` listener with guaranteed removal in `finally` block to prevent lingering listeners.
   - Preserves script accounting if result was returned prior to navigation completion.
   - Returns `{ success: false, executedSteps: 0, reason: 'Page navigated away during trajectory execution' }` if the execution context was destroyed by mid-flight navigation.
5. **Live MCP Verification Status:**
   - Blocked on MCP server process reload: runtime tool schema must be reloaded by the host broker to expose newly declared `anti.agent.cursor.trajectory` tool.
