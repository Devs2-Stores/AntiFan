---
phase: 4
title: "Add execution backend contract and Codex spike"
status: completed
priority: P1
effort: "4d"
dependencies: [3]
---

# Phase 4: Add Execution Backend Contract and Codex Spike

## Overview

Define the backend-neutral streaming/resume/cancel contract and empirically
capture the local Codex JSONL lifecycle before choosing the first standalone
backend implementation.

## Requirements

- Functional: start, stream, cancel, resume, and fail a Run through one
  `ExecutionBackend` interface with normalized events.
- Non-functional: backend retries do not duplicate durable mutations; external
  commands run with explicit cwd, policy, timeout, and output budgets.

## Architecture

Keep `ExecutionBackend` separate from `ModelProvider`. A backend may wrap Codex,
Claude, or Antigravity CLI/session semantics; an embedded loop may compose a
provider with AntiFan tools later.

```ts
interface ExecutionBackend {
  startRun(input: StartRunInput): AsyncIterable<RunEvent>;
  cancel(runId: string): Promise<void>;
  resume?(ref: BackendSessionRef): AsyncIterable<RunEvent>;
}
```

## Related Code Files

- Create: `src/main/agent/execution-backend.ts`, `src/main/agent/codex-execution-backend.ts`
- Modify: `src/main/run/run-service.ts`
- Create: `test/main/execution-backend-contract.test.ts`, `test/integration/codex-backend-spike.test.ts`
- Record: `plans/260820-1301-build-antifan-standalone-control-plane/reports/codex-spike.md`

## Implementation Steps

1. Capture `codex exec --json`, resume, cancellation, exit, stderr, and malformed
   JSON behavior on the target Windows installation.
2. Normalize text, tool, usage, approval, error, and completion events with
   `runId`/`attemptId` attribution.
3. Define explicit `starting`, `streaming`, `waiting-tool`, `cancelling`,
   `completed`, `failed`, `interrupted`, and `unknown` states; cancellation
   must reach the owned process or be recorded as unresolved.
4. Persist opaque backend session refs and exact argv/cwd; never infer resume
   from a transcript glob.
5. Add timeout hierarchy: desktop deadline exceeds bridge deadline plus buffer;
   late reconciliation remains a state transition, not an auto-retry.

## Success Criteria

- [x] Codex spike report contains captured event examples and limitations.
- [x] RunService is unchanged when switching between a fake contract adapter
   and Codex adapter in tests.
- [x] Cancel and disconnect states are explicit and replayable.
- [x] A disconnect after provider dispatch is attributed to the exact Attempt and
      cannot silently become a successful or retried mutation.
- [x] No backend-specific DTO leaks into shared Chat/Run contracts.

## Risk Assessment

Codex CLI/app-server protocols are experimental. Keep the adapter behind a
feature flag and fail closed on unknown events; do not make undocumented fields
part of the AntiFan contract.
