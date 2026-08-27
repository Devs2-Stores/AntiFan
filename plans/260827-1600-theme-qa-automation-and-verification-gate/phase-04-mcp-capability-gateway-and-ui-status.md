---
phase: "04"
title: "MCP Stdio Capability Gateway & UI Status"
status: pending
priority: P2
effort: "2h"
dependencies: ["03"]
---

# Phase 04: MCP Stdio Capability Gateway & UI Status

## Overview
Expose the upgraded Theme QA verification capabilities to external AI coding agents (OMP, Codex, Claude Code, Cursor) via the authenticated Stdio MCP Server, and surface live QA health indicators on the AntiFan Browser Desktop toolbar.

## Requirements
- **MCP Capability Registration (`src/main/tools/browser-capabilities.ts`)**:
  - `theme.qa_validate`: Execute full static and live QA inspection on the active tab and workspace, returning the structured `ThemeQaReport` and artifact refs.
  - `theme.debug_bundle`: Return a single atomic bundle containing platform metadata, active template/section hierarchy, zero-Liquid error scan, and active cart telemetry.
  - `theme.assert_cart`: Test and verify the storefront AJAX cart contracts (`/cart/add.js`, `/cart/change.js`, `/cart.js`).
- **Toolbar & UI Health Indicators (`src/renderer/toolbar.ts` / `src/renderer/toolbar.html`)**:
  - Display a visual QA status badge on the toolbar next to the omnibox (`✓ QA Clean` in green or `⚠ N Issues` in amber/red).
  - Clicking the badge opens the QA Summary Modal with detected Liquid errors, layout overflows, and broken assets.

## Architecture & Data Flow
```text
External AI Agent (Claude Code / Codex / OMP)
                   │
                   ▼ (Stdio MCP RPC)
     `theme.qa_validate` / `theme.debug_bundle`
                   │
                   ▼
     CapabilityCatalogue & ControlPlaneRuntime
                   │
                   ▼
           ThemeQaWorkflow.validate()
                   │
                   ▼
     Returns ResultEnvelope<ThemeQaReport>
                   │
                   ▼
     Agent consumes exact culprit element & fixes code!
```

## Related Code Files
- Modify:
  - `src/main/tools/browser-capabilities.ts`
  - `src/main/mcp/mcp-server.ts`
  - `src/renderer/toolbar.html`
  - `src/renderer/toolbar.ts`
  - `src/renderer/toolbar.css`
- Tests:
  - `test/main/theme-qa-mcp-capability.test.ts`
  - `test/main/capability-catalogue.test.ts`

## Implementation Steps
1. Register `theme.qa_validate`, `theme.debug_bundle`, and `theme.assert_cart` in `src/main/tools/browser-capabilities.ts`.
2. Map MCP Stdio tool declarations in `src/main/mcp/mcp-server.ts` and `scripts/antifan-omp-mcp.cjs`.
3. Add a compact QA badge in `src/renderer/toolbar.html` and wire IPC state listener in `src/renderer/toolbar.ts`.
4. Add unit and contract tests verifying that MCP tools serialize and deserialize `ThemeQaReport` payloads safely.

## Success Criteria
- [ ] AI Agent calling `theme.qa_validate` via MCP receives valid JSON report in $< 2\text{s}$.
- [ ] Agent calling `theme.debug_bundle` receives single comprehensive diagnostic payload.
- [ ] Toolbar displays real-time QA status badge updating on page reload or verification run.

## Risk Assessment
- **Risk:** High-frequency validation calls from autonomous agents overloading CPU during heavy reload cycles.
- **Mitigation:** Debounce rapid validation requests ($300\text{ms}$ cooldown) and return cached report if document generation has not changed.
