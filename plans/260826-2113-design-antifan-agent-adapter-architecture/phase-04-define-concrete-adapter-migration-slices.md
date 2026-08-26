---
title: "Phase 4: Define concrete adapter migration slices"
status: complete
---

# Phase 4: Define concrete adapter migration slices

## Overview

Turn the frozen contract into an incremental implementation sequence. Each slice has an owner boundary, exact files, compatibility behavior, and a narrow verification target. The sequence avoids simultaneous rewrites of process management, browser control, control-plane state, and UI.

## Requirements

- [x] Preserve the existing `ExecutionBackend` interface until every consumer has an equivalent adapter-backed path.
- [x] Migrate Codex first because it is the current authoritative subprocess implementation and has the richest existing contract/tests.
- [x] Keep DeepSeek behind its existing feature flag and compatibility adapter; migrate its event mapping only after normalized events are stable.
- [x] Keep browser registration/attachment, executable validation, approvals, evidence collection, and final verification in existing control-plane owners.
- [x] Add new files only where they establish a real boundary; otherwise extend existing execution modules and tests.

## Implementation Steps

1. Slice A — contract/types: add the runtime-neutral adapter types and registry/selection contract near `src/main/agent/`, with no caller behavior change. Add contract tests for identity, capabilities, event sequencing, terminal uniqueness, and bounded payloads.
2. Slice B — Codex translation: extract `CodexExecutionBackend` process/JSONL translation behind the adapter contract. Preserve executable allowlisting, argument construction, environment handling, owned-process tracking, and current normalized event behavior. Keep a compatibility facade implementing `ExecutionBackend`.
3. Slice C — control-plane selection: update `src/main/agent/execution-backend.ts` consumers and `src/main/control-plane/` integration points to select an adapter by validated runtime identity. Unknown runtimes and invalid paths fail before process spawn.
4. Slice D — session/capability metadata: persist handshake/session metadata and expose it to the existing control-plane/UI event path without making UI state authoritative. Resume/load paths remain capability-gated and identity-bound.
5. Slice E — DeepSeek migration: map `src/main/agent/deepseek-harness-adapter.ts` to the normalized adapter events under the existing opt-in flag. Do not make DeepSeek default or silently change its fallback semantics.
6. Slice F — cleanup: after compatibility and integration callers are migrated, remove duplicate Codex-specific orchestration, stale aliases, and dead paths. Only then consider changing or retiring `ExecutionBackend`.
7. Every migration slice MUST include a caller inventory and a negative-path check for cancellation, duplicate/late events, and consumer failure; a slice is not complete when only the happy-path adapter output matches.

## Todo

- [x] Implement runtime-neutral contract and registry
- [x] Wrap Codex process translation with compatibility facade
- [x] Migrate control-plane adapter selection and metadata
- [x] Migrate DeepSeek event translation behind feature flag
- [x] Remove obsolete paths after caller and test cutover

## Success Criteria

- [x] Each slice can land independently without breaking the current run lifecycle.
- [x] Codex behavior is unchanged at the public event/control-plane boundary.
- [x] DeepSeek remains explicitly opt-in and cannot become an accidental fallback.
- [x] No adapter can bypass executable validation, capability policy, browser ownership, approval handling, or evidence verification.
- [x] The final cutover has a complete caller/test inventory and removes obsolete code rather than leaving permanent compatibility clutter.
