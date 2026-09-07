# [Bug] `TypeError: undefined is not an object (evaluating 'rt.getWorkPoolYieldItems')` — crashes every subagent dispatch on Windows (introduced in v18.1.7)

## Summary

> [!NOTE]
> **STATUS: RESOLVED UPSTREAM IN v18.1.11+ (verified in v18.1.13).**
> The fix `() => at?.getWorkPoolYieldItems() ?? []` was landed in v18.1.11. This document is preserved as a post-mortem record.

Between **v18.1.7** and **v18.1.10** (reproduced on Windows x64 release binaries), every subagent spawn crashed during startup with:

```
TypeError: undefined is not an object (evaluating 'rt.getWorkPoolYieldItems')
    at getWorkPoolYieldItems (B:/~BUN/root/omp-windows-x64:920001:38)
```

Affected paths: the `task` tool (workpool batches, any `--ultra` / scout fan-out) **and** `eval agent()` subagents. The controller session survives; every dispatched subagent dies. Single-process builds/tests/smokes are unaffected.

## Impact

- All parallel subagent workflows were unusable on Windows: 5/5 ultra-verifier slots, 8/8 scout dispatches, and an `eval agent()` probe all failed identically across multiple sessions.
- Users had to fall back to controller-grounded single-pass analysis or sequential work.

## Root cause (from binary inspection)

In the compiled bundle, the runtime bridge object exposes workpool/todo/checkpoint methods **without the optional-chaining guard every sibling method has**:

```js
// guarded siblings:
getToolByName:        (ye) => rt?.getToolByName(ye),
getPlanModeState:     () => rt?.getPlanModeState(),
getHindsightSessionState: () => rt?.getHindsightSessionState(),

// UNGUARDED — throw when rt is undefined:
getTodoPhases:        () => rt.getTodoPhases(),
getWorkPoolYieldItems: () => rt.getWorkPoolYieldItems(),   // ← the crash
setWorkPoolYieldItems: (ye) => rt.setWorkPoolYieldItems(ye),
setTodoPhases:        (ye) => rt.setTodoPhases(ye),
getCheckpointState:   () => rt.getCheckpointState(),
setCheckpointState:   (ye) => rt.setCheckpointState(ye ?? undefined),
getLastCompletedRewind: () => rt.getLastCompletedRewind(),
getToolChoiceQueue:   () => rt.toolChoiceQueue,
steer:                (ye) => rt.agent.steer({ ... }),
```

`rt` is declared `let rt;` (no initializer → `undefined`) in the runtime factory. When the subagent bootstrap resolves the task/agent `description` (`get → description → #d → getWorkPoolYieldItems`), the bridge forwards to `rt.getWorkPoolYieldItems()` before `rt` is assigned, throwing the exact error above. The `rt?.` guard on sibling methods exists precisely because `rt` is not yet assigned during this window.

## Introduced in v18.1.7 — reproduction of the introduction point

Scanned every Windows release asset (SHA256-verified against each release's `SHA256SUMS.txt`) for the bridge symbol:

| Version | `getWorkPoolYieldItems` occurrences | `setWorkPoolYieldItems` occurrences | Verdict |
|---|---|---|---|
| 18.1.0 … 18.1.6 | 0 | 0 | clean |
| **18.1.7** | **3** | **5** | **first bad** |
| 18.1.8 … 18.1.10 | 3 | 5 | bad |

Note: v18.1.7 was published to GitHub releases but omitted from the npm registry index. The defect persisted through v18.1.10 until resolved in v18.1.11. Current latest stable on npm and GitHub releases is v18.1.13.

## Resolution & Live Runtime Verification (v18.1.11, v18.1.12, v18.1.13)

Upstream resolved this in **v18.1.11** by applying the optional-chaining guard with fallback:

```js
getWorkPoolYieldItems: () => at?.getWorkPoolYieldItems() ?? [],
```

Verified across release binaries `omp-18.1.11.exe`, `omp-18.1.12.exe`, and `omp-18.1.13.exe`. All three binaries contain the guard.

### Live Fresh-Process Probes on v18.1.13:
1. **Single Scout Dispatch (`task` tool):**
   - Command: `omp -p "Dispatch exactly 1 scout subagent using the task tool to return 'PING'..." --no-session`
   - Result: `PingScout` spawned, completed, and returned payload in 24.4s (exit 0).
2. **Parallel Batch Dispatch (2 concurrent scouts in 1 `task` call):**
   - Command: `omp -p "Dispatch exactly 2 scout subagents (ScoutA and ScoutB) in parallel in a single task tool call..." --no-session`
   - Result: Both subagents completed in parallel in 24.1s (exit 0), workpool yield items resolved cleanly.

## Environment

- OS: Windows 11 Pro x64 (10.0.22000)
- Defect span: v18.1.7 through v18.1.10 (verified via GitHub release asset decompilation, SHA256-verified)
- Resolution version: v18.1.11 (and verified in v18.1.12, v18.1.13)
- Installed binary: `C:\Users\Admin\AppData\Local\omp\omp.exe` running v18.1.13 (SHA256: `5d75a584acd1d8775d2ea6a14c3ea0dbdf8eb71a54bdab6ae7f38ab971aef877`)

## Remediation

Upgrade to **v18.1.11+** (latest **v18.1.13**). For pinned legacy environments unable to upgrade past v18.1.6, stay on v18.1.6 (the last release prior to bridge introduction). Avoid running v18.1.7 through v18.1.10 for subagent-dependent workflows.