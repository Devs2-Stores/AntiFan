# [Bug] `TypeError: undefined is not an object (evaluating 'rt.getWorkPoolYieldItems')` — crashes every subagent dispatch on Windows (introduced in v18.1.7)

## Summary

Since **v18.1.7** (present through current v18.1.10, both stable and canary channels), every subagent spawn on Windows x64 crashes during startup with:

```
TypeError: undefined is not an object (evaluating 'rt.getWorkPoolYieldItems')
    at getWorkPoolYieldItems (B:/~BUN/root/omp-windows-x64:920001:38)
```

Affected paths: the `task` tool (workpool batches, any `--ultra` / scout fan-out) **and** `eval agent()` subagents. The controller session survives; every dispatched subagent dies. Single-process builds/tests/smokes are unaffected.

## Impact

- All parallel subagent workflows are unusable on Windows: 5/5 ultra-verifier slots, 8/8 scout dispatches, and an `eval agent()` probe all failed identically across multiple sessions.
- Users must fall back to controller-grounded single-pass analysis or sequential work.
- macOS/Linux builds are unaffected only because the same unguarded code path is not exercised there — the defect is in shared JS, so it is latent on all platforms.

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

Note: v18.1.7 is published to GitHub releases but **not** on the npm registry (the canary channel also reports "No canary release has been published"). `omp update --check` on stable reports 18.1.10 as latest.

## Suggested fix

```js
getWorkPoolYieldItems:  () => rt?.getWorkPoolYieldItems(),
setWorkPoolYieldItems:  (ye) => rt?.setWorkPoolYieldItems(ye),
getTodoPhases:          () => rt?.getTodoPhases(),
setTodoPhases:          (ye) => rt?.setTodoPhases(ye),
// ...and the other unguarded methods listed above
```

Or, preferably: guarantee `rt` is assigned before the bridge object is exposed, and add a regression test that dispatches one workpool subagent at startup.

## Environment

- OS: Windows 11 Pro x64 (10.0.22000)
- `omp --version`: v18.1.10 → v18.1.7 (verified via GitHub release asset decompilation, SHA256-verified)
- Install: `C:\Users\Admin\AppData\Local\omp\omp.exe` (Bun standalone, `B:/~BUN/root/omp-windows-x64`), self-update channel: canary
- `omp update --check`: "Already up to date" (18.1.10), no newer build on either channel

## Workaround for affected users

Do not dispatch subagents (`task` / `eval agent()`) on v18.1.7+ until fixed; perform controller-side inspection directly. Downgrading the Windows binary to v18.1.6 restores subagent dispatch.