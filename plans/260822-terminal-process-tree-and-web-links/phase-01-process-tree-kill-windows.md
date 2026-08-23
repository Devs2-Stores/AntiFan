# Phase 01: Process Tree Kill on Windows

## Context
- File to modify: `src/main/browser/terminal-manager.ts`
- Related: `src/main/browser/native-tab-host.ts`

## Requirements
1. Define a robust helper `killProcessTree(pid: number | undefined): void`:
   - On Windows: Run `taskkill /pid <pid> /T /F` via `exec` (with `windowsHide: true`). Catch any errors silently (e.g., if process already exited or PID not found).
   - On POSIX (macOS/Linux): Run `process.kill(-pid, 'SIGKILL')` (process group) with fallback to `process.kill(pid, 'SIGKILL')`.
2. Define `safelyKillSession(session: Session | undefined): void`:
   - Mark `session.disposed = true`.
   - Retrieve `pid = session.pty?.pid`.
   - Call `killProcessTree(pid)`.
   - Call `session.pty.kill()` inside try/catch.
3. Replace all raw `s.pty.kill()` calls in `TerminalManager`:
   - `closeSession(id)` (for both parent session and split session)
   - `closeSplit(sessionId)`
   - `restart(cwd)` (for target session and its split)
   - `kill()` (for active session)
   - `destroy()` (for all active sessions during app exit/cleanup)

## Validation
- Verify typecheck passes (`npm run typecheck`).
- Verify existing tests pass (`npm test`).
