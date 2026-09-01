---
title: Validated AntiFan core runtime freeze plan
date: 2026-09-01
summary: "Completed source-grounded planning, adversarial review, validation, and consistency reconciliation for the five-phase runtime freeze."
---

# Validated AntiFan core runtime freeze plan

## What happened
Reworked the active AntiFan core runtime freeze plan in place after source inspection, two research tracks, phase-level validation, adversarial review, and a whole-plan consistency sweep. The canonical plan remains `plans/260901-1011-antifan-core-runtime-freeze/plan.md` with five phase files.

## Decisions
- Standard MCP arguments contain capability parameters only; trusted adapters inject attachment credentials, retry identity, and the exact Main-issued authority revision.
- Main owns canonical invocation IDs, durable OWNER/JOIN/REPLAY semantics, effect policy, target resolution, cancellation, and receipt disclosure.
- Browser observation guarantees exact document identity and truthful component drift, not impossible byte-level DOM/PNG atomicity.
- Event waits have independent bounded capacity; interactive effects require post-queue target revalidation and centralized actionability before trusted CDP input.
- Historical attachment authentication persists a versioned one-way verifier for random secrets with constant-time comparison, never plaintext or password-KDF overhead.
- Artifact retention is run-local and reference-aware because blobs are namespaced by run ID; no cross-run blob-sharing abstraction is introduced.

## Evidence
`ak plan reindex --apply --json` recognized the plan and all five phases. `ak plan validate plans/260901-1011-antifan-core-runtime-freeze --json` returned `valid: true`. Final stale-contract scanning and rereading of all six canonical files found zero unresolved contradictions.

## Next steps
Run `/ak:cook plans/260901-1011-antifan-core-runtime-freeze` to implement phases 01 through 05 in dependency order, or stop for human review.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
