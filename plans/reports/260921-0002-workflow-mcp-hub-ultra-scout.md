---
title: Workflow & MCP Hub ultra scout
date: 2026-09-21
status: complete
mode: ultra-same-tier
---

# Scout Report — Workflow & MCP Hub

Same-tier best-of-5 (independent samples + rubric selection). Not asymmetric strongest-model verification.

Reject-all: no. Ranking (anonymized): C 98, B 94, A 90, E 90, D 89. Finalizer: evidence-validated union.

## Summary

Historical DEF-01..18: **14 already-fixed**, **4 partially-fixed** (backend done, UI still wrong: DEF-06, DEF-07, DEF-09, DEF-10).

New still-open work: **4 S1**, **10 S2**, **6 S3**. Highest leverage: `qa.check_overflow` false-pass, ungated save/delete IPC, concurrent `run` mutex, scroll `y`/`deltaY` drop.

## Relevant Files

- `src/renderer/toolbar.html` — Hub overlay `#workflowHubOverlay` (616–790), eight-tab `.hub-nav-strip`
- `src/renderer/toolbar.ts` — Hub controller: `openWorkflowHub`, `setHubTab`, `runActiveWorkflow`, badges, `onWorkflowEvent`
- `src/renderer/toolbar.css` — `.workflow-hub-*`, step cards (`.step-skipped` / `.step-passed` / `.step-failed`)
- `src/preload/toolbar-preload.ts` — `antifanToolbar` workflow / core-health / mcp-dispatch APIs (117–141)
- `src/main/browser/native-tab-host.ts` — IPC `antifan:workflow:*`, `antifan:core-health:*`, `antifan:mcp-dispatch:get-state`; `runResponsiveCheck`
- `src/main/workflow/workflow-engine.ts` — execute, `normalizeStepParams`, retry backoff, step dispatch, `report.generate`
- `src/main/workflow/workflow-registry.ts` — `BUILTIN_WORKFLOWS`, `saveCustom` / `deleteCustom`
- `src/main/workflow/workflow-schema.ts` — 19-type `WorkflowStepSchema` discriminated union
- `src/main/workflow/workflow-capabilities.ts` — `workflow.execute` registration
- `src/main/control-plane/control-plane-runtime.ts` — lease + `executeWorkflow`
- `src/main/tools/capability-catalogue.ts` — internal `listAll()`
- `src/main/tools/browser-control-port.ts` — wait / DOM / responsive port
- `src/main/tools/browser-capabilities.ts` — browser capability adapters
- `src/main/mcp/mcp-server.ts` — `AntiFanMcpServer.listTools()` (~99 `anti.*` tools)
- `src/main/diagnostics/core-health.ts` — async CLI + 5s cache, snapshot / task-runs / root causes
- `src/main/diagnostics/mcp-dispatch-service.ts` — dispatch ledger projection
- `src/main/diagnostics/mcp-dispatch-accounting.ts` — invariants / census
- `src/main/diagnostics/crash-report-intake.ts` — dump intake
- `src/main/diagnostics/crash-dump-retention.ts` — `pruneOldCrashDumps`
- `src/main/index.ts` — crashReporter + retention cap 3
- `test/main/workflow-engine.test.ts` — engine contracts
- `test/renderer/core-health-hub.test.ts` — single-overlay Core Health surfaces
- `test/renderer/mcp-stats-hub.test.ts` — MCP Dispatch tab
- `test/e2e/mcp-dispatch-hub-probe.cjs` — live Electron dispatch probe
- `test/e2e/toolbar-qa-hub-empirical-probe.cjs` — live Hub lifecycle probe

## Relationships

```
toolbar.html/ts  --window.antifanToolbar-->  toolbar-preload.ts
       --ipcRenderer.invoke-->  native-tab-host.ts
            ├── workflow:get-state  → registry.getAll() + capabilities.listAll()
            ├── workflow:run/abort/get-artifact  → WorkflowEngine (+ sender gate on run/artifact)
            ├── workflow:save/delete  → registry.saveCustom/deleteCustom (NO sender gate)
            ├── core-health:get-state → CoreHealthService
            └── mcp-dispatch:get-state → McpDispatchService (sender-gated)
```

Eight tabs share one overlay: workflows | mcp | core-health | bridge | task-runs | root-causes | regressions | mcp-dispatch.

MCP tab is **not** the MCP server catalogue. It lists control-plane capabilities.

## DEF-01..18 (HEAD 2026-09-21)

| ID | Status | Note |
|---|---|---|
| 01–05, 08, 11–18 | ALREADY-FIXED | Engine/IPC/schema/retention/retry/abort/UI pills |
| 06 | PARTIAL | Hardcoded 12 gone; still `capabilities.listAll()`, not `listTools()` |
| 07 | PARTIAL | CLI async+cache; `openWorkflowHub` still three sequential awaits |
| 09 | PARTIAL | Backend `UNKNOWN/NO_TASK_RUNS`; badge still sums packs+cases |
| 10 | PARTIAL | Backend P0/P1 aligned; UI maps P2/P3 → `UNKNOWN` |

## Improvement Findings (union, validated)

### S1

1. **`qa.check_overflow` never fails** — `workflow-engine.ts:654-663` checks top-level `hasHorizontalScrollbar`. `runResponsiveCheck` nests `breakpoints[id].hasHorizontalOverflow`. Step always passes.
2. **`save`/`delete` ungated + raw `id` path** — `native-tab-host.ts:2145-2157`; `workflow-registry.ts:323,360-382` `path.join(storageDir, \`${id}.json\`)` with `id = item.id \|\| …`.
3. **Concurrent `run` overwrites AbortController** — `native-tab-host.ts:2216-2252`. Second run steals abort; first cannot be cancelled.
4. **Scroll param corruption** — builtin `{ y: 600, durationMs: 400 }` (`workflow-registry.ts:115-116`) dispatched as `{ deltaY: params.deltaY }` (`workflow-engine.ts:548-554`). `deltaY` undefined; `durationMs` dropped.

### S2

5. Selecting another workflow while running wipes step DOM (`toolbar.ts:1485,1527-1575`).
6. MCP Tools tab shows internal capabilities, not `AntiFanMcpServer.listTools()` (`native-tab-host.ts:2099-2108`).
7. `openWorkflowHub` sequential awaits before `renderHubList` (`toolbar.ts:1378-1392`).
8. Progress bar stuck at 5% until 100% (`toolbar.ts:2356,2410,4630-4656`).
9. Refresh does not call `CoreHealthService.clearCache()` (TTL default **5s**, `core-health.ts:303`; `toolbar.ts:4554-4558`).
10. `setHubTab` empty list leaves stale detail pane (`toolbar.ts:2306-2315`).
11. Renderer ignores `step:retry` (`toolbar.ts:4630-4658` vs `workflow-engine.ts:298-305`).
12. `report.generate` hardcodes JSON, ignores `format:'markdown'`, no prior-step aggregation (`workflow-engine.ts:713-730`).
13. New workflow is a 2-step stub; no step editor (`toolbar.ts:4588-4627`).
14. Highlight drops `color`; screenshot drops `format` (`workflow-registry.ts:134,152` vs `workflow-engine.ts:564-577`).

### S3

15. Artifact cards: no click; non-image stays 📸 (`toolbar.ts:2416-2442`).
16. Task-runs badge = runs+packs+cases (`toolbar.ts:1437`).
17. Delete custom workflow with no confirm (`toolbar.ts:4578-4586`).
18. `badgeWorkflowCount` only set on open (`toolbar.ts:1382,4583,4620`).
19. Root-cause P2/P3 rendered `UNKNOWN` (`toolbar.ts:1654`).
20. Silent `catch {}` on workflow event send (`native-tab-host.ts:2225-2228`).

## Unresolved Questions

- 2026-09-16 ~30 MB/s main-process churn not re-measured.
- Whether super-core will ever write `task_runs`.
- iOS USB runtime not exercised.
- 99 MCP tool handlers not line-audited.
- Renderer `runWorkflow({ workflowId, workflowDef })` always takes the `workflowDef` branch (`native-tab-host.ts:2169-2180`); `JSON.stringify` registry match as grant gate is **unverified** at runtime (verifier eval failed). `[INFERENCE]` if IPC clone/Zod defaults diverge, builtins may run under `read` grant.

## Ranking appendix

| Rank | Candidate (anonymized) | Total /100 |
|---|---|---|
| 1 | C | 98 |
| 2 | B | 94 |
| 3 | A | 90 |
| 4 | E | 90 |
| 5 | D | 89 |
