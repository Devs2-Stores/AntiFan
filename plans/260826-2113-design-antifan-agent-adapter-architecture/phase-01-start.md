---
title: "Phase 1: Grounding and current-state inventory"
status: complete
---

# Phase 1: Grounding and current-state inventory

## Overview

Establish the verified starting point for the adapter design. Inventory the existing execution backend, Codex JSONL translation, DeepSeek compatibility adapter, control-plane ownership, browser-control boundary, current tests, and overlapping plans before proposing new interfaces.

## Requirements

- [x] Read the repository README and relevant architecture, operations, security, and browser-agent seam documents.
- [x] Inspect the current execution contracts, concrete backends, control-plane consumers, event types, capability policy, and adjacent tests.
- [x] Record verified ACP lifecycle facts from primary protocol documentation without treating ACP naming as an AntiFan implementation mandate.
- [x] Identify overlap with existing Chromium-first and project UI/workflow plans; this plan MUST add the missing adapter architecture rather than duplicate their deliverables.

## Implementation Steps

1. Read the repository entry points and docs that define runtime, browser, security, and operational ownership.
2. Trace `ExecutionBackend` from interface through the control plane, Codex backend, DeepSeek adapter, and tests.
3. Trace event and capability types to determine the smallest stable translation vocabulary.
4. Compare existing plans and report dependencies, conflicts, and the exact seam this plan owns.
5. Use ACP initialization, session setup, prompt-turn, tool-call, cancellation, and elicitation documents as primary references for compatibility concepts.

## Todo

- [x] Verify current execution and control-plane call graph
- [x] Verify event, capability, permission, cancellation, and evidence contracts
- [x] Verify ACP lifecycle facts and version-sensitive terminology
- [x] Record overlaps, non-goals, and design constraints

## Success Criteria

- [x] Every adapter-design claim in later phases points to a repository file, test, or primary ACP reference.
- [x] No proposed interface duplicates an existing public contract without a stated migration reason.
- [x] The boundary between AntiFan-owned policy/evidence and adapter-owned runtime translation is explicit.
