---
title: Project Harness coding tool loop
status: in-progress
priority: P0
effort: high
branch: current-worktree
tags: [harness, tools, chromium, workspace, terminal]
created: 2026-08-18
---

# Outcome

Project chat can inspect and modify its bound Workspace, operate its bound Chromium, and use its own Terminal through a durable model-tool-model loop. Chromium remains the primary surface. DSH is not a runtime dependency.

# Constraints

- Reuse Project `CapabilityBroker`, Workspace adapter, browser binding, terminal ownership, receipts, leases, and run journal.
- Never fake tool results or expose secrets.
- Every tool call/result is durable and visible in the run timeline.
- Mutations remain project/workspace/browser-generation scoped.
- Antigravity Subscription remains the default provider.

# Non-goals

- No external MCP server or CLI package.
- No DSH runtime restoration.
- No cross-Project tools or global terminal/browser state.

# Phases

- [x] Scout existing provider, broker, workspace, Chromium, terminal, and run contracts.
- [x] Define the v1 coding tool catalogue and safety tiers.
- [x] Normalize Antigravity structured tool calls and continuation messages.
- [x] Connect Project RunService to CapabilityBroker tool dispatch.
- [x] Implement bounded model -> tool -> model continuation with durable events.
- [x] Surface approval/error/progress states in chat without raw chain-of-thought.
- [ ] Complete live-provider verification after restarting the desktop app with the rebuilt Main bundle.

# Acceptance Criteria

- A prompt such as "analyze this project" reads real Workspace files without asking the user for paths already bound to the Project.
- Read tools include directory structure, file read, and code search.
- Coding flow includes bounded file edit/write and terminal execution through existing safety contracts.
- Chromium tools can inspect the active tab, navigate, interact, capture, and run QA through the Project binding.
- Tool failures produce actionable assistant-visible errors and never silent `completed` runs.
- Two consecutive tool-using prompts retain separate durable assistant replies.
- Typecheck, full tests, and Project Electron E2E pass.

# Execution Detail

- [phase-01-scout-and-tool-map.md](phase-01-scout-and-tool-map.md)
