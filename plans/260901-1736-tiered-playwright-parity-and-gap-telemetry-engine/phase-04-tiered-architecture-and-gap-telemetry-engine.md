---
phase: 4
title: "Tiered Architecture & Gap Telemetry Engine"
status: in-progress
priority: P1
effort: "0.5d"
dependencies: ["phase-02-semantic-aria-snapshot-and-actionability-waiter", "phase-03-deep-evaluation-and-cdp-file-upload-synthesizer"]
---

# Phase 4: Tiered Architecture & Gap Telemetry Engine

## Overview
Standardize the AntiFan MCP tool catalogue under the canonical `anti.*` namespace without shadowing or aliasing Playwright's `browser_*` namespace. Implement a dedicated Correlation Gap-Analysis Telemetry recorder (`anti.telemetry.record_fallback` and persistent `.antifan/telemetry/gaps.jsonl`) that captures sanitized, structured comparative data whenever an AI agent falls back to Playwright, transforming edge-case failures into actionable feature roadmap items.

## Requirements
- **Functional:**
  - Standardize all AntiFan tools under explicit `anti.*` canonical namespace:
    - `anti.inspect.snapshot`
    - `anti.browser.evaluate` / `anti.inspect.eval`
    - `anti.agent.cursor.click` / `anti.agent.cursor.type` / `anti.agent.cursor.hover` / `anti.agent.cursor.scroll`
    - `anti.agent.file_upload` / `anti.agent.drop`
    - `anti.screenshot.viewport`
    - `anti.devtools.console.list` / `anti.devtools.console.errors` / `anti.devtools.console.warnings`
    - `anti.browser.tabs.*` (list, create, activate, close, navigate, reload)
    - `theme.qa_validate` / `theme.assert_cart` / `theme.debug_bundle`
  - Maintain strict namespace isolation: **NEVER alias `browser_*` to AntiFan tools**, preserving the standalone Playwright MCP server intact for true fallback.
  - Implement `anti.telemetry.record_fallback` MCP tool: records structured telemetry when orchestrator/agent falls back to Playwright after an AntiFan failure.
  - **Sanitization & Security in Telemetry:**
    - Sanitize `targetUrl` by stripping basic auth credentials and query tokens (`access_token`, `auth`, `token`, `secret`).
    - Escape control characters and newlines in `errorMessage` and `notes` to prevent JSONL injection attacks.
    - Bound telemetry file growth (max 10MB per log file with timestamped rotation).
  - Explicitly document in telemetry metadata that Playwright fallback runs in a separate browser/profile context (providing cross-engine capability comparison data rather than continuous session execution).
- **Non-functional:**
  - Telemetry recording latency < 5ms.
  - JSONL append is crash-resilient and non-blocking.
  - Clear, un-biased tool descriptions directing AI agents to use `anti.*` as Tier 1 primary for storefront/theme development.

## Architecture
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AI Orchestrator / Agent                           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            │                                                     │
            ▼ (Tier 1: Primary)                                   ▼ (Tier 2: Fallback)
┌──────────────────────────────────────┐              ┌──────────────────────────────────────┐
│       AntiFan MCP (`anti.*`)         │              │    Playwright MCP (`browser_*`)      │
│ • Full Storefront Superpowers        │              │ • Isolated Standalone Browser Engine │
│ • Native Theme Hot-Reload & Split    │              │ • Safety Net Baseline                │
└──────────────────┬───────────────────┘              └──────────────────┬───────────────────┘
                   │                                                     │
                   │ (On Failure / Error)                                │ (Fallback Result)
                   └───────────────────────────┬─────────────────────────┘
                                               │
                                               ▼
                              [anti.telemetry.record_fallback]
                                               │
                                               ▼
                              [.antifan/telemetry/gaps.jsonl]
                              * primaryCapability
                              * sanitizedTargetUrl
                              * errorCode & escapedErrorMessage
                              * fallbackTool & fallbackResult
                              * comparisonClassification
```

## Related Code Files
- Modify: `src/main/mcp/mcp-server.ts` (Canonical tool definitions, tool descriptions, sanitization, and record_fallback route)
- Modify: `scripts/antifan-omp-mcp.cjs` (MCP adapter registration for all new `anti.*` tools)
- Modify: `src/main/tools/browser-capabilities.ts` (Capability definitions for telemetry recorder)

## Implementation Steps
1. In `mcp-server.ts`, define clean tool schemas and un-biased descriptions for all `anti.*` tools.
2. In `mcp-server.ts`, add `anti.telemetry.record_fallback` tool schema with sanitization helper `sanitizeTelemetryPayload`:
   - `sessionId`: string
   - `targetUrl`: string (sanitized against tokens/passwords)
   - `primaryTool`: string
   - `errorCode`: string
   - `errorMessage`: string (newlines escaped)
   - `fallbackTool`: string
   - `fallbackResult`: "SUCCESS" | "FAILED" | "SKIPPED"
   - `durationMs`: number
   - `notes`?: string
3. Implement file appender writing JSONL records to `.antifan/telemetry/gaps.jsonl` (creating directory if missing, rotating at 10MB).
4. Update `scripts/antifan-omp-mcp.cjs` to register the new tool definitions in stdio tool listing.

## Success Criteria
- [ ] All `anti.*` tools appear in `mcp-server.ts` and `antifan-omp-mcp.cjs` tool lists.
- [ ] No `browser_*` tools are shadowed or overridden by AntiFan.
- [ ] Calling `anti.telemetry.record_fallback` with credentials in URL strips them in `.antifan/telemetry/gaps.jsonl`.
- [ ] Error messages with newlines serialize into a single valid JSON line.
- [ ] Log entry contains complete comparative capability analysis.

## Risk Assessment
- **Risk:** Agent forgets to call `anti.telemetry.record_fallback` after invoking Playwright.
- **Mitigation:** Document tool instructions clearly in system prompt and include automated telemetry hook in AntiFan agent test harnesses.
