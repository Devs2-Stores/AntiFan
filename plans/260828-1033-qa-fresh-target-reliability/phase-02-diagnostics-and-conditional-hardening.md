---
phase: 2
title: "Diagnostics Refresh & Conditional Hardening"
status: pending
priority: P1
effort: "3-4h"
dependencies: [1]
---

# Phase 2: Diagnostics Refresh & Conditional Hardening

## Overview

Give `validate()` a generation-consistent diagnostics read (pre-navigation retained + fresh post-load read, verdict isolated to the fresh generation), then apply the conditional P1-4 hardening (`enabledChecks`) inside the same refactor — including the fallback quick path — without touching the public schema.

## Requirements

- Functional: diagnostics read twice — pre-navigation snapshot retained (existing deliberate behavior: snapshot before any `await` because `did-start-navigation` clears the buffer), and a fresh post-load read after the Phase 1 load-stable settle.
- Functional: ONLY the settled post-load diagnostics feed `checklist.diagnostics`, `summary.criticalCount`, and `summary.passed` (Finding R3). Pre-navigation errors are stored in a distinct audit field/artifact and never gate the verdict.
- Functional: `enabledChecks` behaves identically in the full workflow AND the fallback quick path (`buildFallbackThemeQaResult`) — parity (Finding R11).
- Non-functional: `theme.qa_validate` public schema (`browser-capabilities.ts:166-176`) unchanged; no caller can force a checklist verdict.

## Architecture

```
validate() start
  ├─ pre-navigation diagnostics snapshot        (RT-11: before any await; buffer clears at did-start-navigation)
  ├─ ports.reload(input.target) ──► settle ──► activeTarget (gen N+1)      [Phase 1 seal]
  ├─ FRESH post-load diagnostics read           (gen N+1 parse/runtime errors)
  │    └─ gates checklist.diagnostics / summary.criticalCount / summary.passed   (R3)
  ├─ pre-navigation snapshot ──► preReloadDiagnostics audit field only            (R3)
  ├─ inspect + evals on activeTarget (Phase 1)
  └─ checklist verdicts computed by engine only; enabledChecks filters scope      (P1-4, both paths — R11)
```

Diagnostics buffer semantics (`native-tab-host.ts:1724-1745`): `did-start-navigation` synchronously clears the buffer (`diagnosticsManager.clear(id)`) and bumps `documentGenerations`; `did-finish-load` does NOT clear — parse/runtime errors of the loaded page accumulate until the next navigation. The report schema must be updated EXPLICITLY (typed): `ThemeQaDetailedFindings` (`theme-qa-workflow.ts:20-48`) currently contains only `diagnosticIssues`/`diagnosticWarnings` (R3/R13-report). Pre-reload data cannot ride an untyped field or TypeScript breaks and fallback parity breaks (`theme-qa-parity.test.ts`).

## Related Code Files

- Modify: `src/main/qa/theme-qa-workflow.ts` (diagnostics ordering ~93-122, 213-249; checklist handling ~265-284; `ThemeQaDetailedFindings` type ~20-48; catch policy consumes Phase 1)
- Modify: `src/main/tools/browser-control-port.ts` (reload → settle — seam built in Phase 1; here only wire pickup), `src/main/control-plane/control-plane-runtime.ts` (~102-110)
- Modify: `src/main/tools/browser-capabilities.ts` — `buildFallbackThemeQaResult` (~73-105) to honor `enabledChecks` AND default `preReloadDiagnostics` (empty); the `theme.qa_validate` schema itself stays `{ tabId, workspaceRoot, multiBreakpoint }`
- Do NOT change: public schema (`browser-capabilities.ts:166-176`); `BrowserHostPort.reload` signature (Phase 1)

## Implementation Steps

1. **Fresh post-load diagnostics (after Phase 1 settle):** read diagnostics with `activeTarget`; classify (`classifyDiagnostics`) over the fresh buffer only. These results feed `checklist.diagnostics` (requires `diagnosticIssues.length === 0` at `theme-qa-workflow.ts:257-268`) and `summary.criticalCount`/`summary.passed`.
2. **Pre-navigation retention (R3):** keep the existing pre-`await` snapshot; store it in an OPTIONAL typed report field `preReloadDiagnostics?: DiagnosticIssue[]` on `ThemeQaDetailedFindings` (or a labeled artifact `kind: 'diagnostics-prereload'` per the repo's artifact contract — pick the smallest typed option that keeps `theme-qa-parity.test.ts` structure assertions valid). Invariant: pre-navigation diagnostics NEVER enter `checklist.diagnostics`/`summary.*`; verdict reflects only the settled post-load generation. AC-4 asserts both reads exist and that gen-N errors do not contaminate gen-N+1 findings.
3. **P1-4 conditional hardening (`enabledChecks`):**
   - Refactor input from `checklist?: Partial<ThemeQaChecklist>` to `enabledChecks?: Array<keyof ThemeQaChecklist>`; compute statuses purely from scanner findings; `summary.passed = enabledChecks ? enabledChecks.every(k => checklist[k]) : Object.values(checklist).every(Boolean)`.
   - Update `buildFallbackThemeQaResult` (`browser-capabilities.ts:73-105`) to apply `enabledChecks` identically (R11) so parity tests (`theme-qa-parity.test.ts`) stay green and a caller selecting a subset gets the same verdict from both paths.
   - Internal call sites verified to pass NO `checklist` today (`scripts/smoke-theme-qa-gate.cjs:125`, `control-plane-runtime.ts:104`, `browser-capabilities.ts:175`, `theme-qa-vertical-slice.test.ts:45,89,133`, `theme-qa-parity.test.ts:74,167,204`) → zero-migration refactor; no shims.
4. **Report:** `contextUrl`/tab context resolved from `activeTarget` (Phase 1); report carries generation of the post-load diagnostics; `preReloadDiagnostics` populated only when non-empty.

## Success Criteria

- [ ] `grep "input.checklist" src/main/qa/theme-qa-workflow.ts` → 0 matches; `enabledChecks` only narrows the verdict set.
- [ ] `browser-capabilities.ts:166-176` diff = empty; `buildFallbackThemeQaResult` honors `enabledChecks` and defaults `preReloadDiagnostics` to empty.
- [ ] Post-load diagnostics feed the gate; pre-navigation snapshot is a typed audit field, never the verdict.
- [ ] `theme-qa-parity.test.ts` passes with `enabledChecks` on both paths.
- [ ] Settle timeout / generation mismatch semantics handled in Phase 1 (`LOAD_SETTLE_TIMEOUT` vs `TARGET_STALE`), no re-evaluation mid-navigation.

## Risk Assessment

- **Risk (R3):** pre-navigation errors leak into the verdict → repaired theme rejected or gate confusion. *Signal:* `summary.passed === false` from a pre-QA error. *Response:* verdict reads ONLY the post-settle diagnostics; audit field is inert for gating (AC-4 test enforces).
- **Risk:** adding the typed report field breaks parity tests or schemas. *Signal:* typecheck / `theme-qa-parity.test.ts` failures. *Response:* update the fallback path in the same change; keep report shape superset-compatible.
- **Risk (R11):** `enabledChecks` divergence full vs fallback. *Signal:* parity test fails when a subset is selected. *Response:* both paths share the same subset-evaluation helper.
- **Risk:** settle seam (Phase 1) touches waiter state used elsewhere. *Signal:* `stopLoading`/navigation-waiter cleanup regressions. *Response:* additive settle option; default behavior unchanged; existing navigation tests must pass.