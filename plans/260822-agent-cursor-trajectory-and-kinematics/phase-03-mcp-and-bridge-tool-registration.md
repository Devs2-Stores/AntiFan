# Phase 3: Tool & RPC Surface

## Goal
Expose the Trajectory capability to MCP tools (`anti.agent.cursor.trajectory` and `antifan_agent_trajectory`) and WebSocket RPC bridge (`antifan.agentTrajectory`).

## Changes
- In `src/main/mcp/mcp-server.ts`:
  - Add tool definition `antifan_agent_trajectory` and alias map for `anti.agent.cursor.trajectory`.
  - Handle execution dispatch and response envelopes.
- In `src/main/bridge/bridge-server.ts`:
  - Add cases `agentTrajectory` and `antifan.agentTrajectory` to WebSocket RPC switch router.
