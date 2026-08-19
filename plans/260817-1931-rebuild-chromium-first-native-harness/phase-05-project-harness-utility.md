---
title: "Phase 5: Project Harness Utility Process"
status: done
---

# Phase 5: Project Harness Utility Process

## Overview

Move model/tool orchestration out of Electron Main into one app-owned utility
process per materialized Project. Keep credentials, persistence, providers, and
side effects behind Main-owned gateways.

## Requirements

- ProjectRuntime lazily starts and supervises exactly one compatible Utility.
- Utility receives only Project-scoped opaque IDs, bounded sanitized context,
  artifact handles, events, and capability/provider responses.
- Utility is trusted application code, not a security sandbox. Normal architecture
  gives it no Electron objects, credentials, Project DB handles, or direct
  mutation APIs; Main authorization remains mandatory even if Utility is buggy.
- A run is durably accepted in Main before Utility execution starts.
- Renderer reconnect and Utility restart replay events by sequence.
- Crash/restart policy is bounded; repeated failure marks runs interrupted rather
  than creating an infinite restart loop.
- Structured provider tool calls replace DSH textual pseudo-tool parsing.

## File Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Add | `src/harness/utility-main.ts` | Utility entrypoint, handshake, message-port lifecycle |
| Add | `src/harness/run-machine.ts` | Local transition proposal/projection and cancellation policy |
| Add | `src/harness/context-assembler.ts` | Ordered context manifest, budgets, compaction, provenance |
| Add | `src/harness/tool-orchestrator.ts` | Structured tool selection, dispatch, result shaping, synthesis |
| Add | `src/harness/output-budget.ts` | Bounded model/tool/event payload handling |
| Add | `src/main/harness/harness-supervisor.ts` | Per-Project Utility lifecycle and protocol handshake |
| Add | `src/main/harness/harness-controller.ts` | Durable accept/cancel/resume/reconcile/snapshot/events API |
| Add | `src/main/harness/provider-gateway.ts` | Main-owned credentials/network stream and normalized provider events |
| Modify | `src/main/providers/types.ts` | Structured tool and normalized stream contracts without DSH terminology |
| Modify | `src/main/providers/anthropic-driver.ts` | Provider normalization behind ProviderGateway |
| Modify | `src/main/providers/antigravity-direct-driver.ts` | Provider normalization behind ProviderGateway |
| Modify | `src/main/providers/codex-direct-driver.ts` | Provider normalization behind ProviderGateway |
| Modify | `src/main/providers/gemini-driver.ts` | Provider normalization behind ProviderGateway |
| Modify | `src/main/providers/openai-compatible-driver.ts` | Provider normalization, including DeepSeek |
| Modify | `src/main/ai-service.ts` | Become migration facade, then remove old run ownership |
| Modify | `forge.config.ts` | Package Utility entry and required runtime files |
| Add | `test/main/harness-supervisor.test.ts` | Handshake, crash, restart, timeout, and process-epoch tests |
| Add | `test/main/harness-controller.test.ts` | Acceptance, replay, cancel, resume, and reconciliation tests |
| Add | `test/main/context-assembler.test.ts` | Ordering, provenance, token budget, truncation, and secret exclusion |
| Add | `test/e2e/harness-utility-smoke.cjs` | Packaged Project Utility start/run/reconnect smoke |

## Implementation Steps

1. Implement versioned handshake with protocol version, Project identity, process
   epoch, payload limits, and capability/provider catalogue revisions.
2. Make Main transactionally create Chat Turn, HarnessRun, initial event, context
   inputs, and idempotency key before acknowledging run acceptance.
3. Start Utility with a dedicated MessagePort, minimal environment/cwd, and no
   broad filesystem or secret payload. Validate every envelope at both ends and
   scan the packaged Utility bundle for accidental credential/store imports; this
   is defense in depth, not OS containment.
4. Implement run states: accepted, queued, running, awaiting_model,
   awaiting_tool, awaiting_user, completed, failed, cancelled, interrupted,
   unknown. Utility proposes transitions with expected revision; Main commits the
   transition plus event atomically and returns the committed sequence.
5. Build context manifests from explicit Workspace, chat, evidence, browser, skill,
   memory, and prior-run sources with hashes/revisions and included/omitted reasons.
6. Stream provider requests through Main ProviderGateway; send normalized bounded
   deltas/tool calls/results to Utility without raw credential material. Persist
   `ProviderAttempt` states before dispatch (`prepared`, `dispatched`, `streaming`,
   terminal/`unknown`), plus bounded transcript and usage artifacts. Never
   auto-issue a duplicate completion after an uncertain dispatched request.
7. Add per-run event sequences, replay, cancellation, watchdogs, utility crash
   reconciliation, and bounded restart policy.
8. Support one Utility per materialized Project and prove events cannot be delivered to
   another Project window or Utility.
9. Keep Utility alive for `background-active` Projects and stop only an idle,
   receipt-reconciled Utility during suspension/close.

## Provider Boundary

- Provider profiles store non-secret configuration plus a vault credential handle.
- Main performs credential lookup, request signing, network streaming, redaction,
  cancellation, model listing, and connection tests.
- Utility controls orchestration decisions and receives normalized structured
  model deltas, usage, finish reasons, and tool calls.
- DeepSeek remains an OpenAI-compatible provider and has parity tests with other
  providers; no provider is treated as Harness backend authority.

## Validation

- Utility crash before dispatch, after dispatch, after tool acceptance, and after
  completion-before-event-delivery produces correct durable state.
- Provider crash/restart before dispatch, mid-stream, and after provider completion
  cannot create a duplicate paid/non-deterministic request automatically.
- Renderer reload reconstructs identical run output from snapshot plus replay.
- Two Project Utilities cannot query or act on each other's IDs.
- Protocol mismatch, malformed message, oversized payload, stale process epoch,
  duplicate client request, and late event are rejected deterministically.
- Secrets are absent from Utility environment, IPC fixtures, events, logs, and
  crash diagnostics.
- Direct Utility filesystem/network/store imports are absent from the packaged
  bundle; security still assumes trusted app code rather than sandbox enforcement.

## Success Criteria

Harness/model failure no longer restarts or owns Chromium, and each Project can
run, reconnect, cancel, and recover through an isolated utility process with
durable Main-owned truth.

## Risks And Rollback

The Main ProviderGateway remains a shared availability boundary. Keep its work
asynchronous, bounded, cancellable, and project-routed; do not move raw secrets to
Utility as a shortcut.
