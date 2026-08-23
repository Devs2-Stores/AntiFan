# Research Report: Onorca Terminal-first Harness Architecture

Conducted: 2026-08-20 18:20 Asia/Saigon

## Summary

Onorca does not treat each coding agent as a custom chat backend. Its durable primitive is a PTY terminal session bound to a workspace. Codex, Claude Code, OpenCode, Pi, or another CLI are startup commands inside that terminal. Agent-specific hooks improve status and transcript visibility but do not replace terminal ownership.

AntiFan should adopt this boundary. Standalone becomes a terminal workspace with harness presets and Chromium context attachments. The existing Antigravity sidebar remains a compatibility view.

## Findings

### PTY is the primary runtime

- Onorca uses `node-pty`, session IDs, explicit lifecycle states, cwd, dimensions, PID, shell readiness, attach/replay, resize, kill, and restart.
- Scrollback and process state are owned outside the renderer. Renderer reconnects to a session instead of owning the child process.
- Interactive PTY and non-interactive agent execution are separate contracts. `agent.execNonInteractive` exists for bounded jobs that need clean stdout/stderr and exit code.
- Windows launch resolution handles `.cmd`, `.bat`, `.exe`, PowerShell, cmd, WSL, quoting, and process-tree termination explicitly.

### Harnesses are commands, not UI implementations

- Any CLI agent works if it runs in a terminal.
- A harness preset should define executable, args, environment, startup delivery, capabilities, and optional hook adapter.
- Agent hook listeners add structured status, subagent and transcript observations. Terminal output remains display/telemetry, not authoritative completion proof.

### Shell readiness prevents lost startup commands

- Onorca distinguishes terminal creation from shell readiness.
- Startup commands may use a `shell-ready` delivery contract instead of writing immediately after spawn.
- This prevents commands being lost during shell initialization, profile loading, WSL startup, or remote reconnect.

### Workspace and session ownership are durable

- A session records its exact cwd and lifecycle.
- Terminal commands and quick actions run from the selected terminal context.
- Worktrees isolate concurrent agents. AntiFan does not initially need Orca's full worktree/SSH machinery, but it should retain Project/Workspace/Terminal/Run ownership.

### Browser context is attached as artifacts

- Onorca Design Mode captures a real Chromium element's HTML, CSS, and cropped screenshot and sends them into the agent prompt.
- For AntiFan, browser context should become bounded artifact files plus a generated prompt fragment. Do not inject large base64 blobs into terminal input.

## Recommended AntiFan Design

```text
Chromium tab / selected element / console / screenshot
                         |
                         v
                 Artifact Context Pack
                         |
                         v
Project -> Workspace -> TerminalSession -> HarnessPreset
                         |
                         +-> Codex
                         +-> Claude Code
                         +-> DeepSeek/OpenCode
                         +-> Antigravity compatibility launcher
```

### Minimum contracts

| Contract | Required fields |
|---|---|
| `TerminalSession` | id, projectId, workspaceId, cwd, shell, pid, cols, rows, lifecycle, createdAt |
| `HarnessPreset` | id, label, executable, args, env allowlist, startup delivery, interactive |
| `TerminalEvent` | sessionId, sequence, type, payload, timestamp |
| `BrowserContextPack` | projectId, workspaceId, tabId, URL, artifact paths, digest, createdAt |
| `HarnessRun` | runId, terminalSessionId, harnessId, contextPackId, start/exit timestamps, exit code |

### UI

- Header: Workspace selector, Harness selector, New Terminal, Stop, Reconnect.
- Main body: xterm.js terminal, not a chat transcript.
- Context tray: current URL, selected element, screenshot, console/network evidence; each can be attached or removed.
- Run strip: process state and verified exit/receipt state.
- Antigravity sidebar remains separate and cannot consume Standalone terminal events.

### Implementation order

1. Replace the Standalone chat renderer with xterm.js connected to a real PTY session manager.
2. Extend existing `TerminalManager` into durable multi-session ownership rather than spawning Codex directly.
3. Add harness preset detection using exact executable probing and report unavailable presets explicitly.
4. Implement shell-ready startup delivery, Windows-safe command resolution, resize, input, kill-tree, attach and bounded replay.
5. Convert selected Chromium data into artifact paths and insert only a small context reference into terminal input.
6. Add optional structured adapters for Codex/Claude/DeepSeek status. Do not scrape output to authoritatively mark completion.

## What Not to Port Yet

- Remote relay, SSH hosts, mobile control, parallel worktrees, account switching, infinite terminal splits.
- Full Onorca daemon topology. A local Electron main-process PTY manager is sufficient for the personal-tool target, provided sessions survive renderer reloads.
- Agent-specific custom chat UIs.

## Risks

- `node-pty` native packaging on Electron/Windows requires version and ABI verification.
- Process-tree cleanup must target only processes owned by one terminal session.
- Shell startup commands can be lost without readiness gating.
- Chromium artifacts require size limits and exact workspace containment.
- CLI authentication stays inside each harness terminal; AntiFan must not copy credentials.

## Sources

- [stablyai/orca](https://github.com/stablyai/orca)
- Onorca `src/relay/pty-handler.ts`, `pty-shell-launch.ts`, `terminal-history.ts`
- Onorca `src/preload/api/pty-management-api.ts`, `pty-api.ts`
- Onorca `src/relay/agent-exec-handler.ts`
- Onorca README sections: Terminal Splits, CLI Agents, Design Mode

## Next Steps

- Write an implementation plan replacing the current Standalone composer with a PTY terminal surface.
- Preserve the legacy Antigravity view until the terminal harness path is independently usable.
- Add a Windows PTY packaging spike before changing the production UI.

## Unresolved Questions

- Whether to use `node-pty` directly or Electron UtilityProcess around the PTY owner.
- Which DeepSeek-compatible CLI is the intended default preset.
- Whether terminal sessions must survive full app restart or only renderer reload in the first release.
