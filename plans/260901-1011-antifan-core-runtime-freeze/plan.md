---
title: "AntiFan Core Runtime Freeze & Authority-First Execution Architecture"
description: "Freeze AntiFan's Main-owned capability authority, durable invocation semantics, identity-coherent browser observation, deterministic waits, actionability, bounded infrastructure, and production verification before downstream design-to-code workflows."
status: in-progress
priority: P0
effort: "8d + release soak window"
branch: "main"
tags: [core, runtime, authority, mcp, idempotency, verification, freeze]
blockedBy: []
blocks: [260830-1630-chrome-native-messaging-bridge, 260901-1548-browser-target-rebinding-and-server-500-detection, 260901-1736-tiered-playwright-parity-and-gap-telemetry-engine]
supersedes: [260828-1033-qa-fresh-target-reliability, 260831-0936-main-owned-semantic-ref-authority, 260831-1000-lean-annotation-context-engine, 260831-1344-runtime-performance-and-modular-tabhost-hardening, 260831-1500-multi-project-two-tier-concurrency, 260831-1600-antifan-final-hardening-and-runtime-verification]
created: 2026-09-01
---

# AntiFan Core Runtime Freeze & Authority-First Execution Architecture

## Delivery Contract

### Outcome
AntiFan becomes a deterministic Main-owned sensory and execution runtime. MCP and Bridge clients submit serializable intent only; Main resolves immutable authority, assigns canonical invocation IDs, applies catalogue-owned effect policy, executes at most once for each deduplication binding, and returns durable receipts that converge after lost responses without re-running side effects. Browser observation reports exact target/document identity plus per-component timing and drift rather than false same-document atomicity; browser and terminal waits are bounded, cancellable capabilities; interactive effects pass a centralized actionability gate and report the actual `cdp_trusted` or `isolated_synthetic` execution tier, with synthetic fallback permitted only after a proven pre-effect trusted-path failure.

### Constraints
- Preserve existing MCP tool names and Bridge transport compatibility where they do not bypass authority.
- Bridge WebSocket remains authenticated by bridge token or attachment token; the defect to remove is bridge-token compatibility execution that bypasses per-invocation attachment, lease, grant, and target authorization.
- External standard MCP tool arguments do not expose or ask an LLM to synthesize kernel authority. The trusted AntiFan session/stdio/Bridge adapter must inject the exact Main-issued revision and retry identity into the adapter-to-Main intent.
- External callers never supply resolved authority, effect/replay policy, `AbortSignal`, or canonical `invocationId`; Main may carry a non-serializable signal only as internal dispatch runtime state.
- New OWNER execution fails closed on stale lease, grant, browser epoch, tab, or document generation using the existing `TARGET_STALE` / `TARGET_MISMATCH` taxonomy.
- Execution authority and retained-receipt disclosure are separate lifecycles. Expiry/inactive attempt state denies new OWNER work; explicit security revocation denies both. Before ledger lookup, authenticate the presented attachment credential and exact immutable tenant/run lineage `(attachmentId, projectId, workspaceId, runId, attemptId, authorityRevision)`; mismatched lineage receives no receipt-existence signal. Existing JOIN/REPLAY authorizes disclosure only through the intersection of recorded visibility and current receipt-read permission.
- Reuse `CapabilityCatalogue`, `CapabilityTransportAdapter`, `AttachmentRegistry`, `ReceiptStore`, `EventStore`, `BrowserControlPort`, `ViewportGate`, `PassiveExecutionPool`, and existing service owners. Do not create a second control plane.
- Production thresholds remain fail-closed; do not weaken tests or acceptance limits to obtain a green freeze.

### Non-goals
- Figma import/parsing, PageSpeed recommendation logic, screenshot-to-code generation, or autonomous source mutation.
- Rebuilding the renderer, Chrome Native Messaging feature delivery, or changing end-user product UI.
- Replacing high-level run/turn `ReceiptStore` or audit `EventStore` with the capability invocation ledger.
- Broad renames or abstractions unrelated to the authority, runtime, infrastructure, and freeze contracts below.

### Acceptance Criteria
- Every adapter-to-Main execution intent carries caller `requestId`, `idempotencyKey`, attachment credentials, and a mandatory opaque Main-issued `authorityRevision`; Main issues `invocationId`. Standard MCP adapters inject the revision from authenticated session bootstrap, not from LLM-authored tool args.
- A dedicated durable `InvocationLedger` guarantees one OWNER for `(attachmentId, idempotencyKey)`, in-process JOIN for identical in-flight requests, exact binding collision rejection, terminal receipt replay, and explicit `interrupted`/`unknown` recovery.
- Historical JOIN/REPLAY authenticates the current attachment credential and exact tenant/run/revision lineage before lookup, then authorizes receipt disclosure through current receipt-read permission and recorded visibility. It may bypass current execution target/generation/lease checks only because it cannot dispatch. A missing record requires an active revision plus current lease, grant, target, and policy validation before atomic OWNER creation.
- Master-token compatibility methods cannot directly execute browser, terminal, eval, or workflow capabilities; execution routes through the authenticated transport pipeline. Mobile/remote HTML never embeds the reusable master token.
- Interactive OWNER calls revalidate target generation after queue acquisition and before the first side effect. A trusted-path failure proven to have emitted no input may fall back to isolated World 1004 synthetic execution; any possibly emitted trusted event forbids fallback and persists `unknown`, never `interrupted` or clean `failed`.
- Navigate, reload, tab-binding changes, and multi-step workflows rotate and propagate authority revisions deterministically.
- Exact target semantics, truthful bounded `browser.observe`, separately bounded `browser.wait`/`terminal.wait`, centralized actionability, ambiguity-safe semantic refs, observable trusted-CDP-first/isolated-synthetic input tiers, authenticated restart-safe attachment/artifact disclosure, secure mobile/discovery/terminal streams, two-tier scheduling, terminal/preview/artifact limits, process cleanup, canonical `theme.qa_validate` ownership, and retention behavior pass focused and end-to-end verification.
- The 40-directory reconciliation ledger accounts for every timestamped plan directory exactly once while preserving header truth separately from implementation evidence.
- `npm run verify:freeze` and the separate release soak gates emit machine-readable evidence on pass or failure, measure every declared threshold, exit correctly, and leave zero orphaned processes.
- Every executable workflow child call enters the same ledger-owned internal intent pipeline, receives deterministic identity derived from `(parentInvocationId, stepId, attemptIndex, invocationSeq)`, records a child receipt linked to the parent invocation, propagates replacement authority revisions, retries only catalogue `read`/`idempotent-write` effects, and stops on `unknown`/`interrupted` cancellation settlement rather than continuing with untracked effects.
- Catalogue policy separates OWNER cancellation from subscriber disconnect. `ownerCancellationBehavior: 'abort-immediate' | 'drain-and-persist'`, `subscriberDisconnectBehavior: 'abort-when-unobserved' | 'detach-and-continue'`, the absolute `timeoutMs`, and bounded `cancellationAckTimeoutMs` determine transport behavior; the legacy conflated `ignore-disconnect` value is removed.
- Transport never maps an abort through the generic error catch to `failed`. Normal success is `completed`; an ordinary non-cancellation error is `failed` only when execution is known non-ambiguous; a matching cancellation acknowledgement proving no effect and no future effect is `interrupted`; possible/committed effect, missing acknowledgement, or expired grace/deadline is `unknown`. `interrupted`/`unknown` are never automatically retried and always stop workflow continuation.

## Authority and Dispatch Contract

```mermaid
sequenceDiagram
    autonumber
    actor Client as MCP / Bridge Client
    participant Transport as MCP or Bridge Adapter
    participant Registry as AttachmentRegistry
    participant Ledger as InvocationLedger
    participant Catalogue as CapabilityCatalogue
    participant Target as Browser / Terminal / Workflow Port

    Client->>Transport: external tool args or direct intent; trusted adapter injects requestId, idempotencyKey, authorityRevision
    Transport->>Registry: authenticate credential + exact tenant/run/revision lineage
    Registry-->>Transport: authenticated immutable lineage
    Transport->>Ledger: lookup(attachmentId, idempotencyKey)
    alt existing record
        Ledger-->>Transport: recorded binding + policy snapshot
        Transport->>Catalogue: authorize current receipt-read permission
        Transport-->>Client: disclosure-only JOIN or authorized recorded receipt
    else missing record
        Transport->>Registry: resolve active immutable authority + validate attempt/lease/grant
        Transport->>Catalogue: resolve current immutable execution policy
        Transport->>Ledger: atomic OWNER claim(bindingDigest) + durable pre_dispatch
        Transport->>Ledger: durable dispatch_started before executor invocation
        Transport->>Target: execute with Main-owned policy-scoped execution control
        Target-->>Transport: result / typed failure
        Transport->>Ledger: persist terminal or unknown receipt; settle JOINers
        Transport-->>Client: requestId + invocationId + result + evidence
    end
```

### Canonical Ordering
1. The trusted AntiFan adapter canonicalizes the external call, injects its authenticated session revision, assigns/reuses the caller retry identity, derives a stable parameter digest, and rejects caller-provided internal fields. Direct Bridge clients must already hold and send the exact revision.
2. Authenticate the presented attachment credential and bind it to the exact immutable historical lineage `(attachmentId, projectId, workspaceId, runId, attemptId, authorityRevision)`. Explicit security revocation fails here; execution expiry/inactive attempt state does not by itself erase retained receipt-read eligibility. Do not reveal whether a receipt exists to unauthenticated or mismatched lineage.
3. Only after lineage authentication, lookup `(attachmentId, idempotencyKey)` in `InvocationLedger`; the stored binding owns the historical policy snapshot/digest.
4. **Existing record:** require the stored tenant/run/revision lineage, capability, parameter digest, and recorded policy digest to match. Resolve current receipt-read permission from `CapabilityCatalogue`/grant, intersect it with recorded visibility, then JOIN an in-process OWNER or disclose the recorded terminal/ambiguous receipt. JOIN/REPLAY is disclosure-only: it never dispatches and therefore may bypass current target, document-generation, and execution-lease checks without turning a stale revision into execution authority.
5. **Missing record:** require `authorityRevision` to be active, resolve immutable `MainResolvedAuthority`, validate current attempt/PID/backend/lease/grant/workspace/runtime/target and current execution policy, then atomically create the OWNER record via `claimOrObserve`. A stale handle cannot create a record. A race loser re-enters the existing-record path and repeats disclosure authorization.
6. Durably persist OWNER state before dispatch. Main binds authoritative parent/run cancellation, absolute deadline, and claimed catalogue disconnect/cancellation policy. A subscriber disconnect follows `subscriberDisconnectBehavior`, never an implicit generic abort. Before dispatch, authoritative cancellation settles `interrupted`. After dispatch, `abort-immediate` signals the OWNER and applies bounded acknowledgement settlement; `drain-and-persist` detaches the requester, leaves the OWNER unsignalled, and awaits natural durable settlement until the absolute deadline. Monotonic ledger state rejects every late overwrite.
7. Interactive OWNER calls acquire `ViewportGate`, then revalidate browser epoch, tab, and document generation inside the lock immediately before the selected input tier's first side effect. Trusted CDP is attempted first for existing auto-tier click/hover semantics; isolated World 1004 fallback is allowed only when the trusted path proves that no input event was emitted. If a mouse-down may have been emitted, attempt bounded best-effort release cleanup, persist ambiguity, and never cross tiers. Remove any path that overwrites expected generation with live generation before comparison.
8. Persist sanitized terminal receipts before responding. The OWNER claim records `dispatchStage: pre_dispatch`; immediately before invoking executor code, transport durably appends `dispatchStage: dispatch_started`, and failure of that append prevents dispatch. Initial claim-append failure evicts the in-memory binding only after checksummed tail reconciliation under the partition lock proves no durable frame exists. If a frame exists or absence cannot be proven—or if the later `dispatch_started` append fails—the live `.jsonl` partition file remains in place on disk (never renamed to `.quarantine-*`), the binding is marked with a process-local poison gate, all OWNER/JOINers receive one typed durability failure, and the attachment partition rejects new OWNER claims while running. Verified historical terminal replay remains readable. On restart, rehydration discovers and replays the intact `.jsonl` partition file and recovers durable frames (`pre_dispatch -> interrupted`, `dispatch_started -> unknown`) before reopening new execution. File renaming to `.quarantine-*` and hot-map deletion are reserved exclusively for checksum-invalid or unparseable corruption discovered on startup/replay.
9. Cancellation settlement is policy-owned and classified before the ledger write. Transport creates a process-local `CapabilityExecutionControl` with a unique cancellation ID, monotonic `not-started -> effect-started -> effect-committed` markers, and a matching acknowledgement that is valid only after cleanup guarantees no later effect. It never detects cancellation from error text or a generic capability code.
10. For `abort-immediate`, an authoritative run/parent abort, capability deadline, or permitted last-subscriber disconnect signals the OWNER and waits at most `cancellationAckTimeoutMs` within the remaining absolute deadline. A normal result settled first remains `completed`/ordinary `failed`; a matching no-effect acknowledgement settles `interrupted`; possible/committed effect, missing acknowledgement, or grace expiry atomically settles `unknown`. For `drain-and-persist`, pre-dispatch cancellation settles `interrupted`, but after dispatch the subscriber detaches and the OWNER is not signalled; transport awaits its natural `completed`/ordinary `failed` receipt within `timeoutMs`, then settles `unknown` if the absolute deadline expires. Workflow parents remain pending until that durable receipt exists.
11. Subscriber disconnect is not run/parent cancellation. `detach-and-continue` only removes that waiter. `abort-when-unobserved` may request OWNER cancellation only after the final subscriber leaves and is valid only with `abort-immediate`; JOINER disconnect never settles or cancels the OWNER. Same-key replay of `interrupted`/`unknown` is inspection-only and never dispatches; a separately authorized new operation requires explicit state inspection and a new identity, never workflow automatic retry.
12. Durable crash disposition uses only the last checksummed ledger frame: `pre_dispatch` proves executor code was never invoked; `dispatch_started` proves only that invocation was authorized and may have begun. No startup path fabricates a no-effect acknowledgement from process-local state. Recovery persists `interrupted` for the former and `unknown` for the latter before MCP/Bridge readiness; same-key replay remains disclosure-only. An in-place append-ambiguity quarantine reopens execution only after restart rehydration validates the in-place partition and persists required recovery receipts. Checksum-corrupted files renamed to `.quarantine-*` require administrative intervention and fail closed.

### Identifier and State Rules
- `requestId`: caller correlation only; echoed in the response and not used as authority.
- `idempotencyKey`: caller retry identity scoped to the attachment; mandatory for effectful capabilities and accepted for reads. The AntiFan adapter reuses it only for a true retry of the same binding.
- `authorityRevision`: opaque Main-issued handle for one immutable authority snapshot; mandatory at the adapter-to-Main boundary and exact, never resolved as “latest” implicitly by Main dispatch.
- `invocationId`: Main-issued durable canonical execution identity.
- `InvocationState`: `claiming -> in_progress -> completed | failed | interrupted | unknown`; terminal states are monotonic.
- `InvocationDispatchStage`: durable `pre_dispatch | dispatch_started`; terminal receipts retain the last stage. Missing stage on a legacy `in_progress` record is treated as dispatched/ambiguous. Process-local `effect-started`/`effect-committed` markers may classify a live cancellation but never downgrade crash recovery from `unknown` to `interrupted`.
- Duplicate binding includes attachment ID, idempotency key, authority revision, canonical capability name, parameter digest, and catalogue policy version/digest.
- A proven pre-effect `TARGET_STALE` may be retried only with a newly issued revision and a new idempotency key. Reusing the old key with a new revision is a binding collision. Ambiguous effects require state inspection before any new key.
- Receipt replay never means re-execution. Recorded policy defines historical semantics; current receipt-read permission may further redact or deny disclosure but never silently dispatches again.
- Workflow child identity is transport-derived from `(parentInvocationId, stepId, attemptIndex, invocationSeq)`, where `parentInvocationId` is the Main-issued invocation ID of the transport-owned `workflow.execute` OWNER. `ControlPlaneRuntime.executeWorkflow` enters through `CapabilityTransportAdapter.dispatchIntent(intent, runtimeOptions)`, never `dispatchTrusted`. The serializable intent contains workflow/workspace inputs only; process-local runtime options carry caller cancellation and an optional progress-event sink outside parameter/policy digests. Transport creates an authenticated runtime context with the exact revision and a Main-only child-dispatch closure. Its child request accepts capability params, revision, step, attempt, sequence and linked signal but no attachment secret, parent ID, request ID or idempotency key. `invocationSeq` is monotonic within each step attempt. No clock/random fallback, session-attempt substitute or step-name inference participates in identity.
- Every transport response carries explicit `InvocationState` in addition to `ok`; replay/JOIN/OWNER responses preserve `completed | failed | interrupted | unknown`. `WorkflowEngine` advances one shared authority-revision cursor immediately on every child response before interpreting data/error, so a later failure, retry, or `continueOnError` path cannot strand a completed target transition.
- `workflow.execute` is an orchestration owner and never holds `ViewportGate` or passive/wait capacity across child execution; each child acquires only its catalogue lane. Authenticated runtime context—not public params—supplies `context.invocationId`, `context.signal`, exact authority revision, the bound internal child dispatcher and optional progress sink. Progress delivery is best-effort/non-authoritative: callback failure or subscriber detach cannot alter OWNER execution or receipt settlement. Workflow retry authority comes from an exhaustive `WorkflowStep.type -> canonical capability set` mapping and current catalogue policies. A retry is permitted only when every reachable capability effect is `read` or `idempotent-write`; interactive/destructive/management effects and missing mappings/policies are single-attempt fail-closed. Canonical `report.generate` is ledger-owned management work.
- A workflow timeout or parent abort is carried as runtime-only policy input, never serialized into `ClientInvocationIntent`. Before dispatch it settles `interrupted`. After dispatch, `abort-immediate` signals and waits one bounded acknowledgement grace; `drain-and-persist` leaves the child unsignalled and waits for natural durable settlement until the absolute deadline. `unknown` or `interrupted` blocks retry and all later steps even when `continueOnError` is true, and late completion cannot rewrite terminal state.
- `CapabilityTransportAdapter` uses one policy-aware settlement classifier before `InvocationLedger.settle`; the generic execution catch cannot write `failed` when the OWNER cancellation ID is active or execution-control evidence is ambiguous. Monotonic ledger settlement resolves every JOINer from the same persisted state and rejects late completion.

## Phase Roadmap

| Phase | Title | Priority | Dependencies | Objective |
|---:|---|:---:|---|---|
| [01](./phase-01-canonical-contract-ledger-and-mcp-envelope.md) | Canonical Authority Contracts, Policy & Envelopes | P0 | None | Freeze wire intent, immutable authority revision, effect policy, ID separation, and response contracts. |
| [02](./phase-02-orchestration-lifecycle-and-cancellation.md) | Invocation Ledger, Dispatch Ordering & Recovery | P0 | Phase 01 | Implement atomic OWNER/JOIN/REPLAY semantics, remove master-token execution bypasses, and link cancellation/recovery. |
| [03](./phase-03-browser-observation-and-action-kernel.md) | Exact Browser Target, Coherent Observation & Action Kernel | P0 | Phases 01-02 | Enforce exact targets, truthful multi-modal observation, deterministic waits, ambiguity-safe actionability, two-tier scheduling, and observable trusted-CDP-first/isolated-synthetic input. |
| [04](./phase-04-terminal-preview-artifact-services.md) | Bounded Terminal, Preview & Artifact Services | P1 | Phases 01-03 | Close resource, path-containment, watcher, process-tree, and retention contracts. |
| [05](./phase-05-production-freeze-verification.md) | Production Freeze Verification | P0 | Phases 01-04 | Run contract, security, runtime, smoke, performance, and soak gates and publish evidence. |

## Deep Planning Evidence
- Source research: authority/ledger, browser-terminal kernel, and freeze certification surfaces inspected independently against HEAD `e206a4e`.
- Per-phase scouting: every named existing path was checked; planned create/delete paths were separated from disk truth.
- Scope decision: HOLD. Extend existing owners; introduce only one new core service (`InvocationLedger`). Keep the bounded browser wait registry colocated with the browser kernel rather than creating another control plane.
- Confirmed source deltas: partial authority contracts still have legacy callers; `AttachmentRegistry` retains volatile replay nonces; `WorkflowEngine` uses scalar retry and `Promise.race`; selector wait polls at 100 ms; trusted input retains synthetic fallback; artifact metadata is memory-only; preview subscriptions alias duplicate callback identity; smoke evidence destinations are inconsistent.
- Planning corrections: Phase 01 completes/migrates partial contracts instead of recreating them; Phase 05 compiles once and invokes tests/smokes directly through the certification runner.
- Red-team corrections: standard MCP retry identity is the SDK `extra.requestId`; grants retain explicit scope semantics instead of an inferred ordinal hierarchy; workflow child effects cannot call `CapabilityCatalogue` directly; attachment/ledger persistence paths and recovery order are concrete; failure-to-persist rejects all JOINers; target transition generations come from completed browser operations; terminal teardown and run-local artifact byte accounting preserve ownership.
- Convergence correction: current source proves automatic trusted-CDP-first/isolated-synthetic fallback, first-match semantic fingerprint recovery, random child identity fallback, scalar retry, and an unpropagated authenticated signal. The plan preserves the valid two-tier input behavior while making its tier observable, rejects ambiguous semantic fallback, derives child identity deterministically, delegates retry eligibility to catalogue effect policy, and requires durable abort settlement.
- Hostile-review correction: attachment persistence becomes awaited asynchronous serialized I/O; failed pre-dispatch claims reject every JOINer; browser action signals reach the gate; gate release is idempotent; semantic fallback is boundary-confined, full-fingerprint validated, and capped at 500 inspected nodes or 50 ms; network waits require live instrumentation and abort-clean all resources; duplicate run-local artifact content is hashed before quota charge; watcher/PTY teardown retains ownership until every settlement.


## Cross-Plan Dependency Decision
- This plan is not blocked by downstream product work.
- `260830-1630-chrome-native-messaging-bridge` consumes frozen Bridge/capsule authority and remains blocked by this plan while its cookie-sync implementation stays out of scope.
- `260901-1548-browser-target-rebinding-and-server-500-detection` was created after the earlier 37-directory sweep. Its HTTP-status telemetry and server-crash detection remain valid downstream scope. It is blocked by this freeze because its draft live-generation overwrite, implicit target-bound tab adoption, and `buildFallbackThemeQaResult` parity conflict with exact revisions and canonical `ThemeQaWorkflow`; those mechanisms must be rewritten after the freeze.
- `260901-1630-decoupled-dual-plane-background-automation` is completed foundation for focus-isolated human/agent planes and strict interactive-write fencing. Phase 03 preserves those outcomes but supersedes its passive-read live-generation auto-sync with exact authority revisions and operation-proven generation transitions.
- `260901-1736-tiered-playwright-parity-and-gap-telemetry-engine` remains in-progress downstream work. Its parity and sanitized gap-telemetry outcomes are valid, but semantic re-anchoring, eval/upload authority, actionability, input scheduling, and CDP ownership must be reconciled against this freeze before its pending benchmarks can certify completion.
- `260817-2217-rebuild-chromium-first-project-ui-and-workflow` has a stale `pending` header but its phase files record shipped completion on 2026-08-18. It is evidence/foundation requiring metadata audit, not downstream work blocked by this freeze.
- Bookkeeping-only stale headers are recorded below. They are not silently rewritten to “completed” without a separate evidence audit.

## 40-Directory Reconciliation Ledger

Header status is disk metadata, not an implementation verdict. “Foundation/reference” means this freeze reuses delivered or documented surfaces; it does not overwrite stale metadata. A timestamped directory without `plan.md` is classified explicitly rather than assigned an invented status.

### Canonical authority (1)
| Directory | Header truth | Disposition |
|---|---|---|
| `260901-1011-antifan-core-runtime-freeze` | `pending` | Canonical executing plan; rewritten in place. |

### Absorbed or superseded scope (11)
| Directory | Header truth | Disposition |
|---|---|---|
| `260819-2244-harden-antifan-antigravity-sync` | `pending` | Superseded by exact-routing/trust-boundary work; historical bookkeeping remains separate. |
| `260819-2334-route-antifan-chat-to-exact-antigravity-conversation` | `pending` | Superseded by `260820-0854`; historical bookkeeping remains separate. |
| `260822-refactor-native-tab-host-and-unify-capabilities` | Markdown `Completed` | Semantic/tab-host delta consolidated into Phase 03. |
| `260828-1033-qa-fresh-target-reliability` | `pending` | Exact generation delta absorbed into Phase 03. |
| `260830-1530-antifan-semantic-a11y-telemetry-engine` | `superseded` | Already points to runtime resilience hardening. |
| `260830-1530-electron-cpu-memory-performance-optimization` | `pending` | Remaining bounded-runtime verification absorbed into Phases 04-05. |
| `260831-0936-main-owned-semantic-ref-authority` | `superseded` | World 1004/ref authority consolidated into Phase 03. |
| `260831-1000-lean-annotation-context-engine` | Markdown `Pending` | Relevant diagnostics/token-budget delta consolidated into Phases 03-04. |
| `260831-1344-runtime-performance-and-modular-tabhost-hardening` | `superseded` | Runtime/browser decomposition checks consolidated into Phases 03-04. |
| `260831-1500-multi-project-two-tier-concurrency` | `superseded` | Lease/scheduler delta consolidated into Phases 02-03. |
| `260831-1600-antifan-final-hardening-and-runtime-verification` | `superseded` | Soak/freeze gates consolidated into Phase 05. |

### Foundation or historical reference (21)
| Directory | Header truth | Role |
|---|---|---|
| `260817-2217-rebuild-chromium-first-project-ui-and-workflow` | `pending`; phase 11 records shipped completion | Project UI/IPC/evidence foundation; header requires separate reconciliation. |
| `260818-1533-project-harness-coding-tool-loop` | `in-progress` | Existing RunService/model-tool loop reference; status requires separate audit. |
| `260820-0854-harden-antifan-antigravity-routing-and-local-trust-boundaries` | `completed` | Exact routing and receipt-authority foundation. |
| `260820-1301-build-antifan-standalone-control-plane` | `completed` | ControlPlaneRuntime/RunService/AttachmentRegistry foundation. |
| `260820-standalone-tab-and-legacy-send-fix` | Markdown `active` | Standalone tab and send-path historical reference. |
| `260821-implement-antifan-roadmap` | No status field | Workspace capsule/profile foundation; metadata remains unchanged. |
| `260822-agent-cursor-trajectory-and-kinematics` | Markdown `IMPLEMENTATION_COMPLETE` | Cursor trajectory foundation. |
| `260822-browser-keyboard-press-slice` | Markdown `COMPLETED` | Native keyboard input foundation. |
| `260822-multi-terminal-windows` | No status field | Multi-terminal window foundation. |
| `260822-terminal-process-tree-and-links` | Markdown `COMPLETED` | Process-tree and terminal links foundation. |
| `260825-1851-split-web-desktop-mobile-review` | `completed` | Split review foundation. |
| `260825-2321-harden-external-cli-execution-and-mcp-attachment-enforcement` | `completed` | Attachment and external CLI authority foundation. |
| `260826-2113-design-antifan-agent-adapter-architecture` | `complete` | Agent adapter boundary reference. |
| `260827-1345-production-cutover-release-hardening` | `completed` | Release and workflow foundation. |
| `260827-1600-theme-qa-automation-and-verification-gate` | `completed` | Theme QA foundation. |
| `260827-2211-qa-gate-trust-and-self-qa` | `done` | QA trust foundation. |
| `260830-1109-google-auth-partition-architecture` | `completed` | Session partition/auth foundation. |
| `260830-1617-runtime-resilience-and-semantic-hardening` | `completed` | Runtime resilience, artifacts, and soak foundation. |
| `260830-1903-drive-e-migration-and-low-spec-hardening` | `complete` | Low-spec/storage foundation. |
| `260831-1800-antifan-mcp-industrial-overhaul` | `completed` | MCP transport/catalogue/artifact foundation. |
| `260901-1630-decoupled-dual-plane-background-automation` | `complete` | Dual-plane focus isolation and strict interactive-write fencing foundation; Phase 03 supersedes passive live-generation auto-sync. |

### Independent downstream, blocked by freeze (3)
| Directory | Header truth | Relationship |
|---|---|---|
| `260830-1630-chrome-native-messaging-bridge` | `planned` | Cookie-sync bridge consumes frozen Bridge/capsule authority; functional scope remains independent. |
| `260901-1548-browser-target-rebinding-and-server-500-detection` | `pending` | Preserve main-frame HTTP status telemetry and server-crash scanner intent; redesign Phase 3 and fallback-QA portions against exact target/revision and single-QA-owner contracts after this freeze. |
| `260901-1736-tiered-playwright-parity-and-gap-telemetry-engine` | `in-progress` | Preserve parity and sanitized gap telemetry; reconcile semantic ambiguity, eval/upload authority, actionability, input scheduling, and CDP ownership against this freeze before pending benchmarks. |

### Evidence-only directory without plan header (1)
| Directory | Header truth | Role |
|---|---|---|
| `260828-1400-measured-performance-optimization` | No `plan.md`; reports only | Historical performance baselines/evidence; no status invented. |

### Bookkeeping audit required (3)
| Directory | Header truth | Required evidence decision |
|---|---|---|
| `260815-0816-fix-antigravity-browser-production-review-findings` | `pending` | Template stub; choose abandoned/superseded only after explicit audit. |
| `260817-1931-rebuild-chromium-first-native-harness` | `in-progress` | Historical plan appears replaced by later control-plane work; reconcile before changing status. |
| `260822-terminal-process-tree-and-web-links` | Markdown `IN_PROGRESS` | Duplicate-looking sibling of completed process-tree plan; reconcile before changing status. |

## Verification Strategy
- Phase-local contract/unit tests first; then integration tests for adapter injection, authority ordering, duplicate races, exact-lineage/no-oracle replay after navigation/lease expiry, current receipt-read permission, bridge bypass rejection, cancellation, and recovery.
- Observation verification fences cross-document identity with `(browserEpoch, documentGeneration, documentUrl)` at start/end and checks component timestamps/sequence/drift metadata for same-document changes; it does not assert impossible byte-level DOM/PNG atomicity.
- Bounded wait verification covers dedicated wait-registry capacity, fast/event paths, tracker attach/detach, `FirstPartyNetworkTracker.awaitQuiescence()` abort, timeout cleanup, OWNER/JOIN convergence, and zero leaked resources without starving short passive work.
- Artifact verification covers durable metadata/index recovery, exact lineage/current receipt-read authorization before byte access, uniform no-oracle denial, 1 MiB chunks, MIME framing, hash integrity, run-local reference-aware blob cleanup, and retention coordination.
- Compile and typecheck after shared/public contracts change; no compatibility shim keeps caller-owned authority fields.
- Full test suite after every source, script, bootstrap, smoke client, and test caller migrates.
- Live Electron smoke covers split review, Theme QA, browser interaction, terminal process cleanup, and multi-process soak.
- A dedicated certification harness runs every stage with cleanup/failure capture and always emits machine-readable evidence. No threshold is inferred from a passing unit test.

## Risks and Pre-Decided Responses
| Risk | Observable signal | Response |
|---|---|---|
| Historical lookup becomes a cross-lineage receipt oracle | Wrong tenant/run/revision learns existence or receives data | Block release; authenticate exact attachment lineage before lookup, normalize mismatch/denial responses, and authorize disclosure separately from execution. |
| Two concurrent calls both execute | Duplicate side-effect counter > 1 or two OWNER IDs | Block release; make claim atomic in one Main serialization boundary before dispatch. |
| Queue wait makes target stale | Generation changes while OWNER waits for `ViewportGate` | Persist pre-effect `TARGET_STALE`; do not execute or silently retarget. |
| Effect acknowledgement is lost | Trusted CDP may have emitted one or more events, or isolated synthetic execution may have committed, while transport reports abort | Persist `unknown`; never cross tiers, claim `interrupted`, classify clean failure, or auto-retry. |
| Generic catch collapses cancellation into failure | OWNER signal is active but transport calls `settle(..., 'failed')` | Block release; route all execution outcomes through the policy-aware settlement classifier. Require matching no-effect acknowledgement for `interrupted`; otherwise persist `unknown`, never `failed`. |
| Crash leaves permanent or misclassified in-flight state | Rehydrated OWNER remains joinable or dispatched work becomes `interrupted` | Persist `pre_dispatch`, append `dispatch_started` before executor invocation, recover only explicit pre-dispatch work as `interrupted`, and recover dispatched/legacy unknown-stage work as `unknown`; settle/clear in-memory joiners and never auto-retry. |
| Ledger append fails after an in-memory claim | Disk may contain no frame, `pre_dispatch`, or `dispatch_started` while memory considers the key reclaimable | Reconcile the checksummed tail under the partition lock. Evict only a failed initial claim proven absent on disk. Otherwise keep the `.jsonl` partition file in place on disk, poison the binding in memory, reject all waiters, gate new OWNER claims for the partition while running, and recover from the in-place file on restart before reopening. Reserve `.quarantine-*` file renaming for checksum-invalid corruption. |
| Effect policy drift breaks old replay interpretation | Recorded policy digest differs from current catalogue | Use recorded policy for historical semantics and current receipt-read permission for further restriction. |
| Ledger durability blocks Main or grows without bound | Event-loop delay, file growth, or heap exceeds budget | Use partitioned append-only async durability, bounded indexes, measured compaction, and retention coordinated with referenced artifacts. |
| Multi-modal observation claims false atomicity | DOM/snapshot/screenshot differ inside one document generation | Guarantee target/document identity only; return component timestamps, sequence and drift metadata, and fail closed only on cross-document identity change. |
| Wait/actionability helpers fork or starve observations | Poll loops, duplicate trackers, or long waits consume all short-passive slots | Reuse canonical internal primitives but give event waits an independently bounded registry; block transport-local engines. |
| Semantic fingerprint fallback is non-unique | Traversal path is stale and two live nodes satisfy the full fingerprint | Return `REF_AMBIGUOUS` with bounded non-sensitive evidence; emit no input and require a new observation. |
| Workflow retry classification drifts from executed capabilities | A step retries an interactive/missing-policy child or a new step type lacks a mapping | Fail policy-completeness tests and run single-attempt; never use `step.name` or an optimistic default. |
| Stale plan metadata is presented as delivery truth | Ledger claims completion contrary to header/phase record | Keep header truth and implementation evidence separate; audit metadata independently. |

## Red Team Review

### Session — 2026-09-01
**Findings:** 24 raw findings; 16 accepted corrections after deduplication; 8 rejected as duplicate, already-covered, overstated, or unsafe.
**Severity:** all Critical/High/Medium findings were source-checked before disposition.

| Correction | Disposition | Applied to |
|---|---|---|
| Inject revisions in trusted adapters; do not expose kernel handles in standard MCP schemas | Accept | Phases 01-02 |
| Rotate/propagate revisions through navigate, reload, target changes, and workflows | Accept | Phases 02-03 |
| Migrate executable scripts, bootstrap clients, smoke clients, and tests | Accept | Phase 01 |
| Register terminal capabilities and remove bridge-only execution | Accept | Phases 01, 04 |
| Partition/bound ledger durability and define subscriber cancellation/ambiguity | Accept | Phase 02 |
| Separate receipt-disclosure lifecycle and intersect current receipt-read permission | Accept | Phases 01-02, 04 |
| Protect mobile/remote token delivery | Accept (narrowed to observed routes) | Phase 02 |
| Preserve input fallback while preventing post-effect cross-tier replay | Supersedes the earlier trusted-CDP-only correction: trusted CDP remains first, isolated World 1004 fallback remains valid only after proven pre-effect failure, and the result reports its tier | Phases 01, 03, 05 |
| Add the omitted reports-only plan directory and correct UI metadata classification | Accept | Master ledger |
| Measure every SLO and always emit certification evidence | Accept | Phase 05 |
| Reuse the same idempotency key with a new revision after staleness | Reject | Violates exact binding; use a new key only after proven pre-effect failure. |
| Claim all discovery routes were already authenticated | Superseded by later source check | `/api/remote-info` and `/api/qr` are gated; `/api/lan-ips` was not and is accepted into Phase 02 in the completion-report revision. |

### Session — 2026-09-01 — Completion Report Revision
**Findings:** 25 raw; 17 unique after deduplication; 12 accepted corrections; 5 rejected as already covered or wrong mechanism.
**Severity:** 2 Critical, 12 High, 3 Medium after deduplication.

| Correction | Disposition | Applied to |
|---|---|---|
| Persist versioned one-way historical attachment verifiers/revisions; distinguish inactive execution from security revocation | Accept; no plaintext and no password-KDF overhead for random tokens | Phases 01-02, 05 |
| Authenticate LAN discovery; complete mobile pairing; scope terminal broadcasts | Accept | Phases 02, 05 |
| Keep raw JS out of read-level wait conditions | Accept | Phases 01, 03, 05 |
| Separate wait capacity from short passive work | Accept | Phases 01, 03, 05 |
| Attach network tracker for every target and make quiescence abort-aware | Accept | Phases 03, 05 |
| Add ViewportGate preemption epoch and bounded semantic snapshot history | Accept | Phases 03, 05 |
| Add terminal incarnation plus structured exit/close state | Accept; persist generation, not old PTY sequence continuity | Phases 01, 04, 05 |
| Persist artifact metadata/lineage; authorize before bytes; preserve run-local shared blobs while referenced | Accept | Phases 01, 04, 05 |
| Fix watcher subscription ownership/debounce teardown | Accept | Phases 04-05 |
| Delete fallback QA engine and enforce explicit target equality | Accept | Phases 04-05 |
| Parameterize all certification evidence destinations | Accept | Phase 05 |
| Artifact oracle/hash, process removal ordering, master-token execution and retention findings | Reject as already explicit | Existing Phases 02, 04-05 |

### Session — 2026-09-01 — Deep Mode Revalidation
**Findings:** 15 current raw findings from Failure Mode and Assumption reviewers; 7 accepted as unique corrections, 8 rejected/merged as already explicit, unsafe mechanisms, or estimate-only duplicates. The replacement Security reviewer did not return before its bounded cancellation; existing security findings were source-rechecked against the current plan and produced no additional unique correction.
**Severity:** accepted corrections are release-blocking contract/lifecycle defects regardless of reviewer priority labels.

| Correction | Disposition | Applied to |
|---|---|---|
| Route workflow child effects through internal ledger intent and revision chain | Accept | Phases 02-03, 05 |
| Use MCP SDK request identity only for actual transport retries | Accept; repeated user/model calls remain new operations | Phases 01-02, 05 |
| Persist attachment history and invocation partitions under concrete versioned `dataRoot` paths; rehydrate run/attempt state first | Accept | Phase 02, 05 |
| Distinguish initial claim-append failure from dispatch-marker failure; evict only after proving no durable frame; for append ambiguity keep the `.jsonl` in place and poison in-memory claims rather than renaming to `.quarantine-*` | Accept; preserves historical replay and restart recovery while preventing in-process reclaim | Phases 01-02, 05 |
| Abort, acknowledge, and persist workflow child settlement before timeout/abort returns | Accept | Phase 02, 05 |
| Require operation-proven document generation for binding transitions | Accept | Phase 03, 05 |
| Preserve terminal ownership through `allSettled` teardown and count unique run-local artifact bytes | Accept | Phase 04, 05 |
| Make grants a monotonic `read <= write <= execute <= eval` hierarchy | Reject | Existing grants are explicit scopes; freeze `read`, `read+write`, `read+execute`, and `read+eval` (subject to `allowEval`) instead. |
| Drain all queued actions or increment preemption epoch after ordinary actionability failure | Reject | Lock release plus each queued owner's mandatory target/actionability revalidation is sufficient; epoch changes only on human preemption. |
| Add separate fixes for terminal exit fast path, artifact reachability, semantic handover epoch, or synthetic input | Merge | Already explicit in Phases 03-04 and verified again in Phase 05. |
| Reuse an idempotency key across a changed authority revision | Reject | Exact binding collision is intentional; a proven pre-effect retry uses a new key and revision. |

### Session — 2026-09-01 — Runtime Convergence Correction
**Findings:** five source-proven contradictions; all five accepted because each changes an executable safety or identity contract.

| Correction | Disposition | Applied to |
|---|---|---|
| Preserve trusted-CDP-first/isolated-synthetic behavior, expose the actual tier, and prohibit fallback after possibly emitted trusted input | Accept; replaces trusted-CDP-only plan text without weakening actionability or exact-target gates | Phases 01, 03, 05 |
| Replace semantic first-match fallback with full-fingerprint candidate cardinality and `REF_AMBIGUOUS` | Accept; exact traversal and registry semantics remain unchanged | Phases 01, 03, 05 |
| Derive workflow child keys from parent/step/attempt/invocation sequence with no clock/random fallback | Accept | Phases 02, 05 |
| Permit workflow retries only when every mapped catalogue effect is `read` or `idempotent-write`; make report generation ledger-owned management work | Accept | Phases 01-02, 05 |
| Pass cancellation as runtime-only transport state and await monotonic durable child settlement before return/retry/continuation | Accept | Phases 02, 05 |

### Session — 2026-09-01 — Cancellation Settlement Correction
**Finding:** Current `CapabilityTransportAdapter` catches every executor error and unconditionally persists `failed`, while catalogue policy already distinguishes cancellation behavior.

| Correction | Disposition | Applied to |
|---|---|---|
| Split OWNER cancellation from subscriber disconnect; replace conflated `ignore-disconnect` policy | Accept | Phases 01-02, 05 |
| Add Main-only cancellation identity, effect-stage markers, and post-cleanup acknowledgement | Accept | Phases 01-03, 05 |
| Map `abort-immediate` to bounded acknowledge/settle and `drain-and-persist` to natural settlement within the absolute deadline | Accept | Phases 02, 05 |
| Prohibit generic abort-to-`failed`, automatic retry, and `continueOnError` after `interrupted`/`unknown` | Accept | Phases 02, 05 |
| Persist a durable pre-dispatch/dispatch-started boundary and make crash recovery stage-aware | Accept; avoids falsely treating possibly executed work as clean interruption | Phases 01-05 |


### Advisory Checkpoint Availability — Deep Mode Revalidation
- The runtime agent registry exposed no `kongming` agent; the design checkpoint call failed with `Unknown agent "kongming"`.
- Review and validation do not claim KongMing approval. Authoritative plan gates continue through source-backed red team, mechanical validation, and whole-plan consistency checks.


### Whole-Plan Consistency Sweep — Completion Report Revision
- Files reread: `plan.md` and all five phase files.
- Decision deltas checked: 12 accepted corrections plus five duplicate/wrong-mechanism rejections.
- Reconciled stale references: wait lane ownership, raw predicate scope, snapshot retention, QA fallback, terminal cursor semantics, attachment restart, artifact index/retention, discovery/mobile scope, report destination, and frozen bounds.
- Unresolved contradictions: 0.

### Historical Whole-Plan Consistency Sweep
- Earlier sweep retained as historical evidence; the completion-report revision below supersedes its route-scope and runtime-completion decisions.
- Reconciliation ledger entries counted: 37.
- Unresolved contradictions at that historical checkpoint: 0.

## Validation Log

### Verification Results — 2026-09-01 — Completion Report Revision
- Tier: Full.
- Claims checked: 82 across five phases using Fact Checker, Flow Tracer, Scope Auditor, and Contract Verifier roles.
- Verified: 70; corrected before final validation: 12; failed: 0; unverified: 0.
- Mechanical format validation is rerun after review edits; canonical source remains six files under this plan directory.
- No user questions were required: source evidence fixed every material security, lifecycle, capacity, recovery, ownership, and threshold decision.

### Whole-Plan Consistency Sweep — Completion Report Revision
- Historical receipt authentication survives restart through a versioned one-way verifier and immutable revision lineage without plaintext secrets or a fabricated active lease.
- Event waits have independent bounds; network tracking is attached/abort-aware; snapshots retain two bounded generations; preemption epochs cover FIFO handover.
- Terminal cursors are incarnation-scoped; artifact metadata/authorization precedes byte access; run-local blobs respect retained references; fallback QA execution is removed.
- Discovery/mobile/terminal streams and certification report destinations have explicit end-to-end contracts.
- Decision deltas checked: 12; unresolved contradictions: 0.

### Verification Results — 2026-09-01 — Deep Mode Revalidation
- Tier: Full; 0 user questions because all material choices were resolved by current source, SDK types, and accepted authority policy.
- `ak plan validate`: `valid: true`, errors `null`.
- `ak plan parse`: 5 phases, 130 unchecked durable tasks, 0 malformed phases.
- Dependency DAG: all 5 phase declarations exactly match prior-phase dependencies; no cycle or missing dependency.
- Required phase sections: 8/8 present in all 5 phases; roadmap links exactly match the five canonical phase files.
- Accepted correction propagation: SDK retry identity, non-ordinal grant scope, durable attachment/invocation paths, JOINer failure settlement, run/attempt recovery, workflow child intents, operation-proven generations, terminal `allSettled`, and unique blob quota appear in owning phases and Phase 05 verification.
- Reconciliation ledger: 40 row entries exactly match the current 40 timestamped plan directories after adding completed dual-plane foundation and classifying the in-progress Playwright-parity plan as blocked downstream work.
- Unresolved planning markers: 0. Failed claims: 0. Unverified claims: 0.

### Whole-Plan Consistency Sweep — 2026-09-01 — Deep Mode Revalidation
- Reread `plan.md` and all five phases after correction propagation.
- Canonical ordering, binding collision rules, explicit grant scopes, compile-once certification, dependency direction, and exact target generation agree across outcome, requirements, implementation steps, matrices, success criteria, and risks.
- The downstream server-500 and Playwright-parity plans are preserved but explicitly blocked. Live-generation overwrite, implicit rebinding, fallback-QA, ambiguous semantic re-anchoring, public eval/upload authority, and independent CDP scheduling cannot enter implementation before redesign against this freeze.
- KongMing validation approval is not claimed because the runtime did not expose that agent. Mechanical/source-backed authoritative gates passed without substitution.
- Unresolved contradictions: 0.

### Verification Results — 2026-09-01 — Runtime Convergence Correction
- Source trace covered `WorkflowStepSchema`, every `WorkflowEngine.dispatchStep` branch, `CapabilityTransportAdapter.dispatchChildIntent`/`dispatchIntent`, `CapabilityCatalogue.getPolicy`, authenticated signal context, `ViewportGate`, `TabAutomationHost` trusted and synthetic paths, and `semantic-ref-executor` traversal/fingerprint fallback.
- Rejected stale assumptions: trusted-CDP-only execution, random child-key fallback, scalar retry independent of policy, abort-by-`Promise.race`, and first-match fingerprint recovery.
- Accepted contract: observable two-tier input with pre-effect-only fallback, ambiguity-safe semantic resolution, deterministic child sequence identity, exhaustive effect-policy retry classification, and durable abort settlement.
- KongMing approval is not claimed: the runtime registry still exposes no `kongming` agent.

### Whole-Plan Consistency Sweep — Runtime Convergence Correction
- Owning contracts were reconciled across `plan.md` and Phases 01-03/05; Phase 04 is intentionally unchanged.
- Historical review entries remain labeled by session; the runtime convergence session supersedes the earlier trusted-CDP-only disposition.
- Unresolved contradictions: 0 after final mechanical/source-backed validation.

### Verification Results — 2026-09-01 — Live Plan Inventory Correction
- Live `plans/` inventory contains 40 timestamped directories. `ak plan reindex --json` recognized 39 AgentKit plans and classified `260828-1400-measured-performance-optimization` as the one reports-only directory without parseable `plan.md`.
- `260901-1630-decoupled-dual-plane-background-automation` is recorded as completed foundation; its focus isolation remains valid while passive live-generation auto-sync is superseded by Phase 03 exact-revision rules.
- `260901-1736-tiered-playwright-parity-and-gap-telemetry-engine` is recorded as in-progress downstream work blocked on the freeze where semantic ambiguity, eval/upload authority, actionability, input scheduling, and CDP ownership overlap.
- The reconciliation categories now total `1 + 11 + 21 + 3 + 1 + 3 = 40`; every live timestamped directory appears exactly once.
- Unresolved contradictions: 0 after inventory correction and propagation.

### Verification Results — 2026-09-01 — Cancellation Settlement Correction
- Source proof: `src/main/tools/capability-transport.ts` currently converts every execution exception to `failed`; `src/main/tools/capability-catalogue.ts` validates cancellation policy but transport does not consume it; `src/main/session/invocation-ledger.ts` currently creates `in_progress` without dispatch stage and recovers every `claiming`/`in_progress` frame as `interrupted`.
- Frozen contract: orthogonal owner-cancellation/disconnect policy, typed cancellation identity and post-cleanup acknowledgement, monotonic process-local effect stage, durable `pre_dispatch -> dispatch_started` boundary, policy-aware live settlement, stage-aware crash recovery, bounded abort acknowledgement, drain-to-natural-settlement, and no retry/continuation after `interrupted`/`unknown`.
- `failed` is reserved for an ordinary non-cancellation error whose execution disposition is non-ambiguous. Abort text/code matching is prohibited. Crash recovery reserves `interrupted` for explicit pre-dispatch state and uses `unknown` for dispatched or legacy unknown-stage work.
- Unresolved contradictions: 0 after propagation into Phases 01-05.

## Open Questions
None. Authority/replay ordering, restart authentication, retry identity, receipt/artifact disclosure, bounded observe/wait/actionability, semantic ambiguity, two-tier input evidence, policy-derived workflow retry, durable child cancellation, terminal incarnation, QA ownership, mobile/discovery security, dependency direction, certification thresholds, and redesign boundaries for the downstream server-500 and Playwright-parity plans are fixed by source-reviewed contracts.


<!-- slug: antifan-core-runtime-freeze -->
