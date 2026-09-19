---
name: anti-direct
description: AntiFan direct-edit mode — edit storefront and application code directly without retrieving context packs, claims, or historical recommendations from Personal Core. Use whenever the user asks for direct editing, says 'sửa trực tiếp', 'không tra core', 'tắt core', 'bỏ qua core', 'skip core', or wants fast, unencumbered source code edits without historical context overhead.
disable-model-invocation: true
user-invocable: true
---

# AntiFan Direct Edit Mode (`anti-direct`)

This skill arms **Direct Edit Mode** for the current AntiFan session and child subagents.

## Scope

- **Handles**: Direct source code editing, local repository diagnosis, and unencumbered storefront changes without retrieving context packs or historical claims.
- **Does NOT handle**: Disabling write-plane learning loop (`core.record_*`), bypassing receipt validation where required, or skipping Theme QA gate checks.

## Core Invariants

1. **Zero Core Retrieval Injections**:
   - Zero tokens of historical Core claims or context packs are injected into turn prompts.
   - Any retrieval or search tool (`core.query`, `core.context_pack*`, `core.find_similar*`, `core.recommend`, `core.receipt_v2`, `core.search`) is blocked by `antifan-core-bridge` with `REFUSED_CORE_RETRIEVAL_POLICY`.
2. **Direct Source Grounding**:
   - Inspect and edit workspace files directly using `read`, `grep`, `edit`, and live browser tools (`anti.inspect.*`).
   - Base all decisions on live repository code, never on speculative historical patterns.
3. **Active Learning Loop**:
   - The write plane remains intact: `core.record_fix_pattern`, `core.record_anti_pattern`, `core.ingest_outcome`, and standard `core.receipt` (v1) remain fully permitted to capture lessons learned.

## Workflow

1. Identify affected source files using workspace search (`grep`, `read`).
2. Implement surgical modifications directly with `edit`.
3. Verify changes through live browser telemetry (`anti.inspect.*`) or targeted unit tests.
4. Record verified fix patterns or observations to the learning loop if applicable.
