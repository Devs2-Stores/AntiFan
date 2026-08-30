---
title: "AntiFan Semantic A11y Tree, Ref-Targeted Actions & Live Telemetry Engine"
description: "Implementation plan upgrading AntiFan Desktop Browser MCP with Playwright-grade token-pruned A11y snapshots, zero-shot Ref targeting, async hydration quiescence gates, and live console/network telemetry sniffer."
status: completed
priority: P1
effort: "4 phases"
tags: [antifan, mcp, a11y, cdp, electron, browser, telemetry, playwright-parity, hydration]
created: 2026-08-30
---

# AntiFan Semantic A11y Tree & Telemetry Engine

## Outcome
Upgrade AntiFan Browser MCP with Playwright-grade zero-shot semantic automation capabilities while retaining AntiFan's proprietary visual agent cursor, multi-pane split-view, and E-commerce theme QA contracts.

## Architecture Highlights (Red-Team Hardened)
1. **Semantic AOM Tree Serializer**: CDP `Accessibility.getFullAXTree` token-pruned to <1,500 tokens with ephemeral ref IDs (`@e1`, `@e2`), spatial viewport bounding box filtering, sensitive field masking (`input[type=password]`, credit card fields), and hierarchical unexpanded menu folding.
2. **Ref-Targeted Dual-Engine Dispatcher**: Native `anti.agent.cursor.*` accepting compound refs (`@e1`, pane-scoped `@d:e1`/`@m:e1`, iframe-scoped `@i0:e4`) with atomic `DOM.describeNode` attachment checks, `elementFromPoint` occlusion testing, and sub-45ms native CDP Input dispatch.
3. **Hydration & Quiescence Gate**: Two-tier architecture: Tier 1 (CDP Isolated World for DOM mutations, layout stillness delta <= 1px, occlusion hit-test) and Tier 2 (Scoped Main-World CDP Probe for React 18/19 Fiber `__reactContainer$*` keys) with 250ms adaptive settling ceiling.
4. **Live Telemetry Sniffer & Deep Sanitizer**: 2MB circular ring buffer capturing uncaught JS exceptions, unhandled rejections, and HTTP 4xx/5xx network failures with deep recursive scrubbing of query strings, POST bodies, and headers, and eager `Runtime.releaseObject` V8 heap cleanup.
5. **Dual-WebContentsView Split View**: Isolated Desktop (1440px) and Mobile (375px) WebContentsView instances ensuring 100% native `@media` query activation with zero coordinate bleed.

## Phased Roadmap

| Phase | Title | Status | Priority | Deliverables |
| **Phase 1** | CDP A11y Serializer & Ref Registry | completed | P1 | `A11ySnapshotService`, `RefRegistry` (compound fingerprinting), `anti.browser.snapshot` tool with sensitive field masking |
| **Phase 2** | Ref-Targeted Cursor & Hydration Gate | completed | P1 | `anti.agent.cursor.*` ref support, `HydrationGuard` (modern Fiber + isolated world), occlusion & motion hit-testing |
| **Phase 3** | Telemetry Ring Buffer & Inline Diagnostics | completed | P2 | `TelemetryBufferService` (deep payload scrubbing, eager V8 release), `theme.debug_bundle` telemetry sync |
| **Phase 4** | Theme QA Parity & Dual-WebContentsView Split | completed | P1 | Dual-WebContentsView split controller, OOPIF iframe matrix offsets, `theme.qa_validate` integration, E2E suite |

## Acceptance Criteria
- [X] `anti.browser.snapshot` emits token-pruned YAML A11y tree in <50ms with 100% valid compound ref mappings and masked passwords/credentials.
- [X] `anti.agent.cursor.click({ ref: "e1" })` validates attachment & occlusion before dispatching trusted native CDP Input events.
- [X] Zero empty-DOM inspections or 3,000ms freeze on pages with live tickers/animations via `HydrationGuard`.
- [X] 100% of runtime 500 errors and JS exceptions captured, sanitized, and surfaced with zero V8 heap leaks.
- [X] Dual-pane Desktop/Mobile split inspection functions natively across responsive CSS breakpoints.

## Red Team Review Summary
- **Total findings identified**: 18 across 3 hostile reviewer lenses (Security, Assumptions, Failure Modes).
- **Accepted & Integrated**: 100% of actionable mitigations applied (Deep payload scrubbing, Modern Fiber inspection, Compound Ref Fingerprinting, Isolated World execution, Occlusion validation, Dual-WebContentsView isolation, Eager V8 RemoteObject cleanup).
