---
phase: 1
title: "Reality ledger and contract freeze"
status: completed
priority: P1
effort: "2d"
dependencies: []
---

# Phase 1: Reality Ledger and Contract Freeze

## Overview

Create the evidence ledger for the live repository and turn the Orca/DeepSeek
research into explicit AntiFan invariants before implementation begins.

## Requirements

- Functional: record source-owned behavior, absent documented files, existing
  tests, dirty worktree constraints, and plan overlap.
- Non-functional: no code behavior change; every decision has a source/report
  reference or is marked unresolved.

## Architecture

Use the live source tree and tests as authority. Keep research reports as
decision input, not as runtime dependencies. Freeze the vocabulary:
`Project`, `Workspace`, `Chat`, `Run`, `ExecutionAttempt`, `ToolInvocation`,
`ArtifactRef`, `BrowserBinding`, `ExecutionBackend`, and `ModelProvider`.

## Related Code Files

- Create: `plans/260820-1301-build-antifan-standalone-control-plane/reports/reality-ledger.md`
- Read: `src/main/browser/native-tab-host.ts`, `src/main/browser/terminal-manager.ts`, `src/main/mcp/mcp-server.ts`, `src/main/bridge/transcript-syncer.ts`
- Read: `docs/ui-architecture.md`, `docs/security-model.md`

## Implementation Steps

1. Inventory current bootstrap, browser, bridge, MCP, terminal, transcript,
   receipt, and renderer entry points with line references.
2. Record each accepted/rejected Orca and DSH pattern and the Windows-specific
   assumptions that require empirical tests.
3. Mark old plans as dependency, source of invariants, or superseded absent
   implementation; do not change their status silently.
4. Freeze public IDs, event naming, target-binding and unknown-delivery rules.

## Success Criteria

- [x] Reality ledger cites all implementation owners and missing claims.
- [x] No phase uses `Session` as an overloaded replacement for Chat/Run.
- [x] No phase assumes DSH or Orca is a production dependency.
- [x] Unresolved product choices are isolated to explicit spike decisions.

## Risk Assessment

The primary risk is planning from stale docs. If a referenced symbol/file is
missing, Phase 2 owns the reconciliation and no later phase may claim it exists.
