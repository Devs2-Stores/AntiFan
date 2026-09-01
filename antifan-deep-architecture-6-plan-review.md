# AntiFan — Deep Architecture & 6-Plan Review

**Repository:** `https://github.com/Devs2-Stores/AntiFan`  
**Review scope:** Source code + implementation plans  
**README:** **Explicitly excluded** from architectural conclusions  
**Review date:** 2026-09-01

---

## Executive Summary

AntiFan is no longer best understood as a simple Chromium shell or browser companion. Based on the runtime/source structure inspected during this review, it is evolving into an **Electron agent workbench / deterministic execution runtime** that combines:

- browser execution authority in Electron Main,
- multi-tab / multi-pane browser state,
- control-plane runtime,
- workflow execution,
- MCP / bridge transports,
- semantic DOM references,
- terminal / PTY,
- workspace / capsule boundaries,
- artifact storage,
- diagnostics and QA capabilities,
- agent execution adapters.

The direction is strong. The central architectural idea — **agents express intent while Main owns execution authority** — is appropriate for a production browser-agent runtime.

However, the repository is not yet consistently enforcing that model across every side-effect path.

The dominant architectural risk is not missing functionality. It is **authority ambiguity**:

1. more than one path can still reach side-effecting browser/runtime operations;
2. browser target authority can become mutable in places where it should remain fail-closed;
3. workflow timeout/retry semantics can be unsafe for non-idempotent mutations;
4. transport authentication and execution authorization are not yet cleanly separated everywhere.

### Overall assessment

| Area | Score |
|---|---:|
| Browser automation primitives | 8.5/10 |
| Semantic-ref architecture | 8.5/10 |
| Workspace/capsule direction | 7.5/10 |
| MCP artifact design | 9/10 |
| External authority boundary | 5/10 |
| Workflow mutation safety | 4.5/10 |
| Process lifecycle | 6/10 |
| Maintainability | 6.5/10 |
| Testing culture | 8/10 |
| Performance planning | 6/10 |

**Engineering maturity:** ~7/10  
**Readiness for unattended high-impact automation:** ~5.5–6/10

The repository is worth continuing. Its architecture is not fundamentally broken. The immediate requirement is to **close authority and mutation-safety invariants before optimizing concurrency and performance further**.

---

# 1. What AntiFan Actually Is

The source structure indicates AntiFan is converging toward this architecture:

```text
                         ┌─────────────────────────┐
 UI / Renderer ── IPC ──►│                         │
                         │   ControlPlaneRuntime   │
 MCP / external agent ──►│                         │
                         └───────────┬─────────────┘
                                     │
                            authenticated context
                                     │
                                     ▼
                         ┌─────────────────────────┐
                         │  CapabilityCatalogue    │
                         │ authorization / routing │
                         └───────────┬─────────────┘
                                     │
                  ┌──────────────────┼──────────────────┐
                  ▼                  ▼                  ▼
          BrowserControlPort    File/Terminal       Theme / QA
                  │
                  ▼
             NativeTabHost
                  │
          ┌───────┴────────┐
          ▼                ▼
 TabAutomationHost    TabDevToolsHost
          │
          ▼
 Chromium WebContents
```

This is a good target architecture.

The fundamental security principle should be:

> External agents never own browser authority. They receive a constrained capability context, while Electron Main remains the only component allowed to materialize side effects.

The problem is that the repository still contains evidence of an additional legacy path:

```text
Bridge WebSocket / HTTP
        │
        ├──── Capability / attachment path ────► desired path
        │
        └──── Legacy direct RPC ───────────────► NativeTabHost / terminal / eval / actions
```

As long as both paths coexist, AntiFan has a **layered architecture**, but not yet a fully **single-authority architecture**.

---

# 2. Strongest Architectural Decisions

## 2.1 Main-owned semantic references

The semantic-ref architecture is one of the strongest parts of the system.

The intended model is approximately:

```text
Snapshot
  ├── tabId / paneId
  ├── browserEpoch
  ├── documentGeneration
  ├── URL
  ├── collection nonce
  └── @e1 ... @eN
```

A semantic reference is therefore not merely a selector convenience. It is an **authority-bearing reference bound to a concrete browser state**.

This is the correct direction because it allows Main to reject:

- stale references,
- references from a different tab,
- references from a different document generation,
- references collected before navigation,
- potentially mismatched snapshots.

The custom isolated execution world (`World 1004`) further reduces the need to expose agent-owned state inside the storefront page's JavaScript world.

### Keep this architecture.

It should become one of the core frozen invariants of AntiFan.

---

## 2.2 ArtifactRef instead of large raw payload propagation

The move toward content/artifact references instead of sending large binary/base64 payloads through the entire capability pipeline is also strong.

Preferred model:

```text
Capability execution
        │
        ▼
   ArtifactRef
        │
        ▼
Authorized resolver
        │
        ▼
binary / MCP image block / download edge
```

Benefits:

- reduced MCP/context payload size,
- easier ownership checks,
- explicit run/attempt provenance,
- easier quota enforcement,
- easier retention policy,
- better auditability.

This design should remain.

---

## 2.3 Synthetic vs trusted input distinction

The plans correctly distinguish:

```text
Synthetic DOM event
    → dispatchEvent(...)
    → isTrusted = false
```

from:

```text
CDP input
    → Input.dispatchMouseEvent / Input.dispatchKeyEvent
    → browser-generated trusted event behavior
```

This distinction matters.

A browser-agent runtime should never describe synthetic JavaScript input as equivalent to native/trusted browser input.

The implementation should expose the effective input tier in execution evidence:

```json
{
  "inputTier": "cdp",
  "trusted": true
}
```

or, on degradation:

```json
{
  "inputTier": "synthetic",
  "trusted": false,
  "degraded": true,
  "reason": "debugger_busy"
}
```

---

# 3. Primary Architectural Risk: Mutable Target Authority

This is the most important issue identified in the review.

A safe browser capability invocation should conceptually be authorized against:

```text
Attachment / invocation authority
    ├── projectId
    ├── workspaceId
    ├── runId
    ├── attemptId
    ├── runtime lease
    └── browser target
          ├── tabId
          ├── paneId
          ├── browserEpoch
          └── documentGeneration
```

Once issued, this target should behave like a **frozen execution intent** for that invocation/revision.

If the document changes:

```text
TARGET_STALE
```

If the caller uses a different tab:

```text
TARGET_MISMATCH
```

Those errors are not design failures.

They are correctness/security signals.

## Problematic philosophy

A dangerous pattern is:

```text
Caller is authorized for Target A
        │
        ▼
Caller asks to use Target B
        │
        ▼
Target B exists
        │
        ▼
Server updates caller authority to Target B
```

The existence of Target B does not prove authorization for Target B.

This can become a confused-deputy class of bug.

### Correct objective

Do **not** aim to eliminate `TARGET_MISMATCH` and `TARGET_STALE`.

Aim to eliminate:

> **spurious** target mismatch / stale failures while preserving fail-closed detection of real authority drift.

---

# 4. Recommended Target Transition Model

Instead of silently mutating attachment target state:

```text
attachment.target = tabB
```

use an explicit transition:

```text
tabs.create()
   │
   ▼
NewBrowserTarget {
  tabId,
  paneId,
  browserEpoch,
  documentGeneration,
  projectId,
  workspaceId
}
   │
   ▼
Main issues AttachmentRevision N+1
   │
   ▼
Caller explicitly adopts new authority
```

Previous attachment revisions remain valid only for their original target.

This gives the system:

- explicit audit history,
- no hidden target rebinding,
- safe multi-tab behavior,
- preserved fail-closed semantics,
- deterministic replay/debugging.

---

# 5. Second P0 Risk: Workflow Retry and Mutation Safety

A generic workflow retry mechanism is dangerous when steps can mutate external state.

Example:

```text
click "Place order"
      │
      ├─ request still running
      │
timeout reached
      │
workflow marks attempt failed
      │
retry click
```

If the first request completed slightly after the timeout, the second attempt duplicates the action.

Possible duplicate side effects include:

- form submission,
- purchase confirmation,
- add-to-cart,
- button click,
- navigation side effects,
- typed text,
- file mutation,
- terminal command execution.

## Required retry taxonomy

| Operation class | Auto-retry |
|---|---|
| Pure read | Yes |
| Idempotent mutation with idempotency key | Yes |
| Mutation proven not started | Maybe |
| Mutation with unknown outcome | **No** |
| Irreversible operation | **No automatic retry** |

Timeout must also propagate cancellation into the underlying operation.

This is not sufficient:

```text
Promise.race(operation, timeout)
```

because winning the timeout race does not imply the operation stopped.

The desired model is:

```text
Parent AbortSignal
      │
      ▼
Internal AbortController
      │
      ├─ capability dispatch
      ├─ browser operation
      ├─ process execution
      └─ timers
```

When timeout or cancellation fires, all subordinate work must receive the signal.

---

# 6. Bridge Trust Surface

The bridge remains a disproportionately large trust surface because it combines several concerns:

```text
HTTP routing
WebSocket lifecycle
authentication
artifact delivery
tab RPC
agent RPC
terminal RPC
legacy compatibility
connection state
```

Recommended decomposition:

```text
BridgeServer
    ├── BridgeAuthenticator
    ├── AttachmentTransport
    ├── ArtifactHttpController
    ├── ConnectionManager
    └── LegacyRpcAdapter
```

Then aggressively shrink `LegacyRpcAdapter` until it can be deleted.

## Authentication rule

Preferred design:

```text
Bridge token
    = discovery/bootstrap only

Attachment secret / scoped credential
    = invocation authority

Capability context
    = exact run/workspace/target authority
```

A persistent bridge/master token should not be sufficient to invoke arbitrary side effects across multiple attachments.

Transport authentication and execution authorization are separate concerns.

---

# 7. Process Lifecycle / Cancellation

A robust execution backend should follow:

```text
spawn child
   │
   ▼
processes.set(runId, child)
   │
   ├──────── drain stdout
   ├──────── drain stderr
   └──────── await exit
   │
   ▼
finally
   ├── processes.delete(runId)
   └── cleanup resources
```

Cancellation should terminate the entire process tree:

### Windows

```text
taskkill /PID <pid> /T /F
```

### POSIX

Prefer a process group and terminate the group, not merely the direct child.

Also ensure stdout and stderr are consumed concurrently to avoid pipe backpressure deadlocks.

---

# 8. Semantic-Ref Clean Cut Is Not Finished Until All Agent Helpers Leave Main World

The semantic architecture should enforce:

```text
Storefront main world
        X
        │ no authority-bearing globals
        │ no semantic ref globals
        │ no agent callback globals
        ▼
Isolated World 1004
        │
        ▼
Main-owned registry
```

The success condition should not literally be "zero DOM mutation."

An overlay may legitimately mutate the DOM.

The better invariant is:

> **Zero authority-bearing or customer-data semantic mutation in storefront scope.**

Allowed:

- visual overlay,
- highlight box,
- transient non-authority presentation nodes.

Not allowed:

- `data-antifan-ref`,
- semantic reference IDs,
- attachment secrets,
- Main authority tokens,
- privileged agent globals.

---

# 9. `contextIsolation` and Page Boundary

Long-term target:

```text
Untrusted webpage
      │
      X cannot access privileged JS
      │
isolated preload
      │ narrow IPC
      ▼
Electron Main
```

The existence of World 1004 helps browser automation isolation, but does not by itself substitute for a clean Electron preload/page isolation boundary.

This should stay on the hardening backlog even if it is not the first P0 issue.

---

# 10. Maintainability

`NativeTabHost` decomposition into smaller browser controllers is directionally good.

However, line count should not be the architectural KPI.

Prefer decomposition by **state ownership**:

```text
NativeTabHost
    ├── TabLifecycle
    ├── TabAutomationHost
    ├── TabDevToolsHost
    ├── NavigationState
    └── Viewport / Pane state
```

A relatively large facade is acceptable if authority is clear.

The more urgent decomposition target is the bridge because it mixes authentication with multiple side-effect transports.

---

# 11. Review of the 6 Plans

## Plan 1 — Main-Owned Semantic Ref Authority

**Score: 8.5/10**

### Strong

- Main owns semantic references.
- refs bind to concrete browser target state.
- generation / stale validation.
- exact-target execution.
- isolated-world semantic processing.
- trusted CDP input direction.

### Needs correction

Do not define success as absolute zero DOM mutation.

Use:

> Zero authority-bearing storefront DOM/global mutation.

Also finish removal of any remaining `window.__antifanAgent*`-style main-world helpers.

### Verdict

**Keep. High priority. Finish completely.**

---

## Plan 2 — Lean Annotation Context Engine

**Score: 6.5/10**

The goal is correct: minimize noisy DOM/CSS/diagnostic context sent to agents.

### Concerns

#### Byte count is not token count

Avoid assumptions such as:

```text
5 KB ≈ 5,000 tokens
```

Measure:

- bytes,
- characters,
- actual tokenizer estimate,
- p50/p95 prompt contribution.

#### Diagnostics must be correlated

A useful diagnostic needs provenance:

```text
tab
document generation
action span
time window
origin/resource
```

Appending arbitrary recent browser errors can lower signal quality.

#### Priority

This is useful optimization, but less urgent than authority/cancellation correctness.

### Verdict

**Keep, but move behind P0 runtime correctness work.**

---

## Plan 3 — Runtime Performance & Modular TabHost Hardening

**Score: 5.5/10**

Direction is valid, but several acceptance criteria are too brittle or stale.

### Problems

- microbenchmark thresholds are hardware/runtime dependent;
- performance claims should be measured against a baseline commit;
- line-count decomposition targets become stale quickly;
- algorithmic complexity claims should be technically precise;
- benchmark and architecture refactor should not share one completion gate.

### Better benchmark form

```text
fixed fixture
fixed Electron/Node version
baseline commit
warmup
p50
p95
max RSS delta
heap allocation delta
```

### Verdict

**Split into two plans:**

1. Runtime performance benchmarks.
2. Module ownership/decomposition.

---

## Plan 4 — Multi-Project Two-Tier Concurrency

**Score: 4/10 in current form**

The idea of multi-project scheduling is good.

The authority model is not.

### Main error

The plan should not attempt to permanently remove:

```text
TARGET_MISMATCH
TARGET_STALE
```

Those are required correctness errors.

### AttachmentRegistry should not become a super-authority

Recommended ownership:

| State | Owner |
|---|---|
| Run / attempt lifecycle | RunService |
| project/workspace identity | WorkspaceRegistry |
| external attachment authentication | AttachmentRegistry |
| capability policy | CapabilityCatalogue |
| browser live state | Browser host |
| semantic refs | SemanticRefRegistry |

### Concurrency model

A blanket "4 operations per tab" does not guarantee useful parallelism.

Better:

| Operation | Suggested scheduling |
|---|---|
| semantic snapshot / DOM JS | low concurrency per WebContents |
| screenshot | separate bounded queue |
| diagnostics | bounded passive pool |
| interactive click/type/hover | exclusive visual-surface gate |
| different WebContents | concurrent |

### Verdict

**Rewrite before implementation.**

Keep multi-workspace scheduling. Remove silent target rebinding.

---

## Plan 5 — Final Hardening & Runtime Verification

**Score: 8/10**

This is one of the strongest plans.

### Good areas

- workspace fail-closed,
- process cleanup,
- Windows handling,
- live soak,
- trusted-vs-synthetic input,
- verification gates.

### Wording to fix

Do not claim structural prompt delimiting "neutralizes prompt injection."

Use:

> Untrusted DOM provenance is preserved and structurally delimited; system security does not depend on the model obeying the delimiter.

Likewise replace "fully settled page" with:

> bounded quiescence under explicit timeout rules.

Process checks should test:

> zero orphan processes attributable to the terminated run/session.

not all Chromium helpers globally.

### Verdict

**Keep. Finish live soak before freeze.**

---

## Plan 6 — MCP Industrial Overhaul

**Score: 6/10**

### Strong

- ArtifactRef pipeline.
- ownership-checked artifact resolution.
- no raw large payload propagation.
- CDP coordinate model.
- structured evidence.

### Needs redesign

Persistent transport should not make a master bridge token equivalent to invocation authority.

Preferred:

```text
transport authenticated
        │
        ▼
attachment validated
        │
        ▼
run/workspace/target validated
        │
        ▼
capability authorized
        │
        ▼
execution
```

### Dual socket design

Do not commit to:

```text
dispatch socket
heartbeat socket
```

unless measurements prove a single multiplexed WebSocket cannot meet lease/dispatch latency requirements.

### Verdict

**Keep artifact and CDP work. Rewrite authentication/authority semantics.**

---

# 12. 6-Plan Scorecard

| Plan | Concept | Source alignment | Risk if implemented as-is | Decision |
|---|---:|---:|---:|---|
| Semantic Ref Authority | 9/10 | 8/10 | Low | **Keep + finish** |
| Lean Annotation | 7/10 | 6/10 | Low | Keep, lower priority |
| Runtime/TabHost | 6/10 | 5/10 | Medium | **Split + rebaseline** |
| Multi-project concurrency | 7/10 | 4/10 trust model | **High** | **Rewrite** |
| Final hardening | 9/10 | 8/10 | Low–Medium | **Keep** |
| MCP overhaul | 8/10 feature | 5/10 auth model | **High** | **Partial keep + auth rewrite** |

Recommended priority:

```text
Semantic Ref / Runtime Hardening
        >
Authority-safe Multi-project + MCP
        >
Runtime performance
        >
Context/token optimization
```

---

# 13. Cross-Plan Conflicts

| Conflict | Explanation |
|---|---|
| Semantic ref ↔ TabHost refactor | refactoring browser ownership before authority invariants are frozen increases regression risk |
| Multi-project ↔ fail-closed security | mutable target rebinding undermines stale/mismatch correctness |
| Multi-project ↔ MCP | both change attachment/target authority but need one shared authority definition |
| Annotation ↔ security provenance | context compression must not destroy trust/provenance markers |
| Capsule isolation ↔ shared login | per-capsule partitions change authentication/session sharing |
| Final hardening ↔ MCP bridge token | strict authority model conflicts with broad master-token invocation |

The two plans that must **not** evolve independently are:

```text
Multi-project concurrency
MCP transport/auth
```

They must share one answer to:

> What exact proof authorizes an MCP invocation to create a browser side effect on this target?

---

# 14. Recommended Replacement Roadmap

## P0 — Authority & Mutation Safety Gate

Before performance/concurrency expansion:

- freeze exact attachment/target semantics;
- forbid caller-driven silent target rebinding;
- remove active-tab fallback from authenticated external paths;
- separate bridge bootstrap token from invocation authority;
- force legacy side effects through `CapabilityCatalogue`;
- classify workflow retries by mutability;
- propagate cancellation into underlying operations;
- fix process-tree cancellation and child bookkeeping.

### Exit condition

There is exactly one defensible answer for:

```text
WHO can act?
ON WHICH target?
UNDER WHICH run/workspace?
WITH WHICH mutation semantics?
```

---

## P1 — Semantic Ref Clean Cut

Finish the semantic authority architecture:

- Main-owned refs only,
- World 1004,
- no page-visible authority state,
- exact-target FIFO,
- document generation checks,
- browser epoch checks,
- stale ref race tests,
- navigation/crash/frame lifecycle tests.

---

## P1 — Runtime Hardening Gate

Finish:

- long soak,
- process ownership cleanup,
- bounded page quiescence,
- workspace fail-closed,
- storage consistency,
- process cancellation.

Do not declare runtime freeze before live evidence exists.

---

## P2 — Multi-Project Scheduler v2

Reintroduce concurrency only after authority is frozen.

Use:

```text
per-WebContents scheduler
operation-class weights
surface-scoped interactive locks
explicit TargetTransition
attachment revisioning
```

Do not use implicit target mutation.

---

## P2 — MCP Transport v2

Keep:

- ArtifactRef,
- structured envelopes,
- evidence,
- CDP path.

Require:

- attachment-scoped invocation authority,
- exact target binding,
- no broad master-token capability bypass.

Benchmark one vs multiple sockets before freezing transport topology.

---

## P3 — Context & Performance Optimization

Then optimize:

- prompt/token size,
- DOM summaries,
- diagnostics correlation,
- terminal slicing,
- p50/p95 latency,
- memory allocation,
- module ownership.

These optimizations become safer once correctness invariants are stable.

---

# 15. Target End-State Architecture

The clean target should be:

```text
UI
MCP
OMP
CLI
Workflow
Compatibility layer
        │
        ▼
AuthenticatedCapabilityContext
        │
        ▼
CapabilityCatalogue
        │
        ├── validate attachment
        ├── validate run / attempt
        ├── validate project / workspace
        ├── validate target / generation
        ├── classify risk / mutation
        ├── audit invocation
        ▼
Executor Ports
        │
        ├── Browser
        ├── Terminal
        ├── Files
        ├── Artifact
        └── QA
```

There should be no alternate side-effect authority such as:

```text
Bridge → nativeTabHost.click()
Bridge → evalJS()
MCP → silently change target
Workflow → blindly retry mutation
```

When every side effect converges through one capability gateway, AntiFan genuinely becomes a control plane rather than a collection of control-plane-like modules.

---

# 16. Three Core Freeze Invariants

Before freezing the runtime, lock these three questions:

## 1. Who is authorized?

```text
One scoped attachment / lease model
```

No master-token ambiguity.

## 2. What exact target is authorized?

```text
Immutable Main-issued target identity
```

including:

- project,
- workspace,
- runtime,
- tab,
- pane where relevant,
- browser epoch,
- document generation.

## 3. What happens when mutation outcome is unknown?

```text
Never silently retry
Never silently rebind
Never silently fallback
```

Return explicit uncertainty and require recovery logic.

---

# 17. Release Recommendation

If this repository were entering a production release gate today:

### Approve continued development

**Yes.**

The architectural core is promising and several primitives are already well-designed.

### Approve permanent core-runtime freeze

**Not yet.**

Block the freeze on:

1. immutable authority semantics;
2. workflow mutation-safe cancellation/retry;
3. bridge/capability convergence;
4. process cancellation verification;
5. completion of real soak evidence.

### Approve unattended high-impact browser automation

**Not yet.**

Read-only inspection and controlled automation are much closer to production readiness than irreversible autonomous actions.

---

# 18. Final Assessment

AntiFan's main problem is not architecture quality.

Its main problem is that **good architectural boundaries are not yet universally authoritative**.

The project already contains the right concepts:

- Main-owned execution,
- capabilities,
- attachment contexts,
- semantic refs,
- browser generations,
- isolated worlds,
- CDP input,
- artifact references,
- process lifecycle,
- two-tier scheduling.

The next step should therefore not be "add more abstractions."

It should be:

> Remove every path that bypasses the abstractions already chosen.

Once the following invariant is true:

```text
Every side effect
    ↓
one authenticated capability path
    ↓
one immutable target
    ↓
one explicit mutation outcome
```

the rest of the roadmap — concurrency, MCP scaling, context compression and performance work — becomes much easier to reason about, test and certify.

---

## Bottom line

**Keep:** Semantic-ref authority, artifact pipeline, trusted CDP input, runtime hardening.  
**Rewrite:** Multi-project target rebinding and MCP master-token authority.  
**Split/rebaseline:** Performance + TabHost refactor.  
**Deprioritize until correctness is frozen:** annotation/token optimization.

**Most important next action:** freeze a single authority model before declaring AntiFan Core Runtime production-frozen.
