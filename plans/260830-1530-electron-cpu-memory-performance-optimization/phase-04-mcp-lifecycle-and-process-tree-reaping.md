---
phase: 4
title: "Process Tree Reaper & Clean MCP Termination"
status: pending
priority: P1
effort: "45m"
dependencies: [3]
---

# Phase 04: Process Tree Reaper & Clean MCP Termination

## Overview
Hardens process lifecycle management for MCP servers and terminal sub-processes. Ensures that when AI agent harnesses disconnect or when terminal sessions close, child processes (such as `@playwright/mcp`, `node_repl.exe`, `tsx`, and shell instances) are cleanly and recursively terminated on Windows without leaving background orphan processes.

## Requirements
- Functional:
  - `scripts/antifan-omp-mcp.cjs` must cleanly exit immediately upon parent stdin close, IPC disconnect, or SIGTERM/SIGINT.
  - When `TerminalManager` closes or restarts a session, recursive process tree kill (`taskkill /pid <pid> /T /F`) must reliably execute before the session object is deleted.
  - Provide a clean exit handler for all spawned child CLI adapters.
- Non-functional:
  - 0 orphan Node or Chromium processes left running after agent sessions end or AntiFan closes.

## Architecture & Code Changes

### Target: `scripts/antifan-omp-mcp.cjs`
Ensure clean disconnect and parent death detection:
```javascript
function cleanupAndExit(code = 0) {
  try { stopHeartbeat(); } catch {}
  try { server.close(); } catch {}
  process.exit(code);
}

process.stdin.on('close', () => cleanupAndExit(0));
process.stdin.on('end', () => cleanupAndExit(0));
if (typeof process.on === 'function') {
  process.on('disconnect', () => cleanupAndExit(0));
  process.on('SIGINT', () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(143));
}
```

### Target: `src/main/browser/terminal-manager.ts`
1. Ensure `safelyKillSession()` and `restart()` handle process tree teardown asynchronously:
   - Run `await killProcessTree(s.pty.pid)` and confirm termination before executing `this.spawn()` to prevent `EADDRINUSE` port collision and file lock conflicts on Windows.
   - Guard against PID reuse races by validating that the target process is still active before sending termination signals.
2. In `app.on('will-quit')` or `NativeTabHost.destroy()`, ensure `TerminalManager.getInstance().killAll()` awaits all process tree kills before process termination.
## Related Code Files
- Modify: `scripts/antifan-omp-mcp.cjs`
- Modify: `src/main/browser/terminal-manager.ts`
- Verify: `src/main/agent/codex-execution-backend.ts`

## Implementation Steps
1. Add strict parent-lifecycle bindings in `scripts/antifan-omp-mcp.cjs`.
2. Review and verify `killProcessTree` in `src/main/browser/terminal-manager.ts`.
3. Test terminal session creation, process spawning, and session closing to ensure child processes vanish from Windows Task Manager immediately.

## Success Criteria
- [ ] Closing an MCP connection terminates `antifan-omp-mcp.cjs` cleanly within 500ms.
- [ ] Closing a terminal session running a long task terminates all descendant processes.
- [ ] No phantom node.exe instances remain in `Get-Process node`.

## Risk Assessment
- *Risk:* `taskkill /F` might fail if child process has elevated permissions.
- *Mitigation:* AntiFan and its child processes run in standard user session; standard permissions allow tree termination of all owned children.
