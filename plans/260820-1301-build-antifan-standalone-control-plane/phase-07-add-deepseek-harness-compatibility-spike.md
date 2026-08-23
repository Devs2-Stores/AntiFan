---
phase: 7
title: "Add DeepSeek Harness compatibility spike"
status: completed
priority: P2
effort: "3d"
dependencies: [4, 6]
---

# Phase 7: Add DeepSeek Harness Compatibility Spike

## Overview

Test whether DSH can attach to AntiFan's backend/event/tool contracts without
vendoring its runtime or weakening Windows/security guarantees.

## Requirements

- Functional: map DSH session/tool/provider events to AntiFan events in a
  disposable spike; prove cancellation/result attribution gaps explicitly.
- Non-functional: optional package/process, no production dependency, no DSH
  on-disk format or sandbox claims.

## Architecture

Use an adapter or subprocess boundary only. AntiFan remains the source of truth
for Project/Workspace/Run/receipt policy. DSH may supply a plugin/event loop;
it may not own Chromium, workspace policy, or durable AntiFan IDs.

## Related Code Files

- Create: `src/main/agent/deepseek-harness-adapter.ts` (spike-only, feature-gated)
- Create: `test/integration/deepseek-harness-compatibility.test.ts`
- Record: `plans/260820-1301-build-antifan-standalone-control-plane/reports/deepseek-spike.md`

## Implementation Steps

1. Pin the tested DSH commit and record Node/package/runtime prerequisites.
2. Map session event log, tool pre/execute/post/result, provider stream, and
   approval events to AntiFan's normalized envelope.
3. Test Windows startup, workspace confinement, cancellation, shutdown,
   prompt/run attribution, and malformed event behavior.
4. Decide `adopt adapter`, `keep research-only`, or `reject` with evidence; do
   not add DSH to the shipping package graph unless every gate passes.

## Success Criteria

- [x] Spike proves or disproves Windows and lifecycle compatibility.
- [x] No DSH event/schema/format is required by production AntiFan storage.
- [x] Decision and rollback are recorded; failed spike leaves no runtime import.

## Risk Assessment

DSH is a developer preview with breaking changes, partial Windows sandboxing,
and incomplete SDK cancellation/result attribution. Any failed gate defaults to
research-only, not a workaround in the core runtime.
