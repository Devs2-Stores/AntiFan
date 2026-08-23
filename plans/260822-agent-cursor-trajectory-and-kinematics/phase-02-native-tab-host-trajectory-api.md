# Phase 2: Main Process & Port Wiring

## Goal
Implement `agentTrajectory(params)` in `src/main/browser/native-tab-host.ts` with navigation tracking, and expose it in `browser-control-port.ts` & `browser-capabilities.ts`.

## Changes
- In `src/main/browser/native-tab-host.ts`:
  - Add `agentTrajectory(params: { steps: TrajectoryStep[]; speed?: string; smoothScroll?: boolean; tabId?: string }): Promise<TrajectoryResult>`
  - Inject trajectory script and execute `window.__antifanAgentTrajectory(...)`.
  - Handle navigation cancellation and return structured waypoint execution summaries.
- In `src/main/tools/browser-control-port.ts`:
  - Add `agentTrajectory` method definition and delegate call to `this.host.agentTrajectory`.
- In `src/main/tools/browser-capabilities.ts`:
  - Register `browser.agent-trajectory` capability with full input schema.
  - Register alias `antifan_agent_trajectory`.
