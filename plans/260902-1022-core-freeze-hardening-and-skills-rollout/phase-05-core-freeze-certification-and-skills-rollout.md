---
phase: 5
title: "Core Freeze Certification & OMP Skills Rollout"
status: pending
priority: P1
effort: "1h"
dependencies: [4]
---

# Phase 5: Core Freeze Certification & OMP Skills Rollout

## Overview
Formally certify AntiFan Core Runtime Freeze, lock control plane contracts, and establish the transition roadmap to building OMP Agent Skills (Figma-to-Code, PageSpeed PSI 90+, Sapo/Haravan Theme Automation).

## Requirements
- Verify clean compilation (`tsc -p .`) and zero test failures across the entire codebase.
- Lock Core Runtime public APIs and ControlPlaneRuntime interfaces against further structural additions.
- Define the architectural contract for OMP Agent Skills consuming AntiFan via MCP and Stdio WebSocket bridges.

## Architecture
```text
┌────────────────────────────────────────────────────────┐
│             OMP AGENT SKILLS LAYER (NEW FOCUS)         │
│  ├─ skill:figma-to-code (Design Token Extraction)      │
│  ├─ skill:pagespeed-optimizer (noPS / CWV Fixes)       │
│  └─ skill:sapo-theme-clone (Liquid Mapping / Schemas)  │
└───────────────────────────┬────────────────────────────┘
                            │ (MCP / Stdio WS Bridge)
┌───────────────────────────▼────────────────────────────┐
│         ANTIFAN CORE RUNTIME (FROZEN & HARDENED)       │
│  ├─ Chromium WebContents & Semantic Ref Engine         │
│  ├─ ControlPlaneRuntime & InvocationLedger             │
│  ├─ ViewportGate & WaitRegistry Concurrency            │
│  └─ Authoritative Theme QA Scanner Suite               │
└────────────────────────────────────────────────────────┘
```

## Related Code Files
- Inspect: `src/main/control-plane/control-plane-runtime.ts`
- Inspect: `scripts/antifan-omp-mcp.cjs`
- Inspect: `CHANGELOG.md`
- Inspect: `README.md`

## Implementation Steps
1. Perform full-suite verification: `npm run clean && npm run compile && npm test`.
2. Update `CHANGELOG.md` and `README.md` recording Core Freeze completion and P1/P2 resolution.
3. Establish guidelines for future OMP Agent Skills consuming AntiFan tools (`anti.agent.cursor.*`, `theme.qa_validate`, `browser_press_key`).

## Success Criteria
- [ ] Core Freeze officially certified with green verification evidence.
- [ ] OMP Agent Skills development path unblocked and clearly defined.

## Risk Assessment
- Risk: Premature feature additions creeping into Core during Skill development.
- Mitigation: Enforce strict Core Freeze rule: all new intelligence must live in OMP Skills; Core only accepts critical bug fixes.
