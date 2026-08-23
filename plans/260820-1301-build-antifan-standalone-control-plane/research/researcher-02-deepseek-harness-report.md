# Research Report: DeepSeek Harness for AntiFan

**Research date:** 2026-08-20  
**Pinned source:** [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness/tree/141eb6fef83422698aef7a981029e843e8161534) (`master`, commit `141eb6f`, merged 2026-08-19; release line `dsh-0.1.0-rc.8`).

## Executive Summary

DeepSeek Harness (DSH) is strong prior art for AntiFan's missing control plane: an append-only session event log, a model-neutral streaming seam, a guarded tool pipeline, provider registration, explicit approval/sandbox policy, and process-separated JSON-RPC. Its most useful lesson is the separation of durable facts from live extension points. DSH logs model-visible inputs and tool outcomes, derives model history from the log, and exposes agent/tool/LLM waterfalls instead of hard-coding integrations into the loop ([architecture](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/architecture.md), [session](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/session.md)).

Do not vendor DSH wholesale. The upstream README explicitly calls it a **developer preview** with compatibility-breaking changes ([README](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/README.md#developer-preview)). Its package graph assumes Cordis plugin composition, vendored Cordis source, Node 22+/pnpm, and a broad CLI/Web/ACP product. Its SDK intentionally lacks protocol negotiation, per-prompt result attribution, and mid-turn cancellation. Its Windows sandbox is reported as partial, and PTY state is process-local. AntiFan should borrow the contracts and invariants, implement a smaller provider-neutral runtime in its existing Electron main process, and keep the existing browser/MCP broker as first-class AntiFan capabilities.

## Research Methodology

- Sources: official repository README, `AGENTS.md`, architecture/subsystem docs, package READMEs, and source-tree inspection at the pinned commit; current AntiFan plan, README, security model, contracts, `NativeTabHost`, transcript syncer, and MCP server.
- Topics: session/event/tool/LLM seams, plugins, JSONL persistence, providers, SDK/CLI, approval/sandbox, Windows/PTY support, and AntiFan integration risk.
- External calls: one shallow clone plus local analysis (within the five-call limit).

## Key Findings

### 1. Runtime architecture and seams

DSH makes "everything a plugin": service definitions, providers, tool registry, session log, and agent loop are Cordis plugins with reversible registrations. Profiles compose ordered bundle patches and user overlays ([architecture: profiles/bundles](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/architecture.md#profiles-and-bundles)). This is useful as a design principle, but Cordis itself is a major framework decision, not a drop-in AntiFan dependency.

The documented turn flow is precise: `turn/start` claims inbox input; prompt/tool schemas are assembled; `agent/pre-step` and `agent/request` can intercept; `llm/stream` emits chunks; `tool/call` goes through `tools/pre-execute` -> guards -> `tools/execute` -> `tools/post-execute`; durable `step/end`/`turn/end` close the cycle ([architecture: turn flow](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/architecture.md#turn-flow), [tool pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/tool-execution-pipeline.md)).

**Reusable for AntiFan:** define a small `AgentRuntime` around explicit `turn`, `step`, `model request`, `tool call/result`, `approval`, and cancellation events. Keep live hooks separate from durable events. Do not copy Cordis dispatch semantics until AntiFan has a concrete need for dynamic plugin unloading.

### 2. Session and event model

DSH's `Session` is an append-only typed event log and the sole source of model context; `deriveMessages()` reconstructs history. Core events include `turn/*`, `step/*`, `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, and `request/header`. Raw assistant chunks remain durable for replay/UI fidelity; the assembled assistant message is authoritative for future model history ([session docs](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/session.md)).

The important invariant is **model-visible means logged**: prompt assembly, tool schemas, provider/model config, and returned tool order are reconstructable from `request/header` plus the event log. This directly addresses AntiFan's standalone-resume requirement and prevents renderer state or Antigravity transcripts from becoming hidden context.

**Comparison:** current AntiFan stores `ChatMessage`/`ChatToolCall` values and routes the sidebar through `TranscriptSyncer`; `NativeTabHost` initializes chat from Antigravity's `.gemini/antigravity-ide/brain/.../transcript.jsonl` and resolves workspace from that session (`src/main/browser/native-tab-host.ts:134`, `:1831`; `src/main/bridge/transcript-syncer.ts:2`). The shared contracts contain chat/bridge DTOs but no provider-neutral session event vocabulary (`src/shared/contracts.ts:51`).

**Plan implication:** make AntiFan's `Project`, `Workspace`, `Chat`, and `Session` stores authoritative before adding providers. Start with an AntiFan event envelope and derived chat projection; treat Antigravity transcript import/sync as an adapter only.

### 3. JSONL persistence

`dsh-session-persistence-jsonl` stores one append-only logical JSONL log per session. Default files are concatenated checksummed Zstandard frames; raw newline-delimited UTF-8 is available with `compression: none`. Appends are durable batches, and load repairs an incomplete final frame/line with synthetic closers for interrupted tool/step/turn work. The backend rejects unknown/future format versions rather than silently guessing ([JSONL README](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/session/session-persistence-jsonl/README.md), [persistence subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/persistence.md)).

**Reuse:** AntiFan should use JSONL (or SQLite later) as an append-only event source, with a separate header for workspace/lineage/format metadata, explicit flush checkpoints, and interrupted-turn recovery. Raw JSONL is preferable for the first MVP because it is inspectable and avoids adding Zstandard framing.

**Do not copy blindly:** DSH's current format is version `0` with no migration promise (its `AGENTS.md` says backends reject old on-disk formats). AntiFan needs its own `SESSION_FORMAT_VERSION`, schema tests, and migration policy; never make DSH's on-disk rows a public AntiFan contract.

### 4. Tool registry, approvals, and policy

DSH `ToolDefinition.execute(args, exec)` is wrapped by a typed pipeline. Arguments are materialized once; identity and abort signal are carried through immutable execution state; pre-execute listeners can allow/deny/ask; monotonic guards run; execution/post-execution hooks may transform outcomes; only the final JSON-safe result is persisted ([tools subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/tools.md)). Approval is fail-closed: only `allowed-once` grants, while missing/throwing answerers become `unavailable` ([approval subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/approval.md)).

**Reuse:** AntiFan's planned Tool Bus should copy the conceptual order: immutable call id + abort signal, permission decision before side effects, bounded/JSON-safe result, and durable `tool/call`/`tool/result`. This maps cleanly onto the existing MCP `CapabilityBroker`, whose high-risk mode and project attachment already fail closed (`docs/security-model.md:71-95`).

**Boundary:** do not expose DSH's broad shell/filesystem tool set by default. AntiFan's browser tools must retain exact Project/runtime/document-generation binding and no active-tab fallback. MCP remains a transport, not the owner of AntiFan's agent loop.

### 5. LLM/provider compatibility

DSH's `ctx.llm` is provider-neutral: adapters register provider routes, expose advisory model catalogs, resolve exact model metadata, and stream a common `StreamChunk` vocabulary. Adapter selection is atomic; one prepared call holds the same adapter registration across model resolution, request-header logging, and dispatch. The base service does not execute retries; retry policy is a separate agent-request extension ([LLM README](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/llm/llm/README.md)).

The direct DeepSeek adapter uses `fetch` + SSE, one provider request per `stream()` call, stable abort/idle-timeout behavior, and a distinct `deepseek-official` route. The pi-ai adapter supports configured OpenAI-compatible gateways but deliberately disables SDK retries so durable agent-step retries remain authoritative ([DeepSeek adapter](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/llm/llm-deepseek/README.md), [pi-ai adapter](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/llm/llm-pi-ai/README.md)).

**Plan implication:** AntiFan's proposed `AgentProvider` should adopt only the narrow seam: `id`, model resolution/capabilities, streaming events, cancellation, and provider-owned error normalization. Keep retries, token accounting, and context compaction outside adapters. DeepSeek can be one provider; do not make the runtime DeepSeek-shaped.

### 6. SDK/CLI and process boundaries

DSH exposes newline-delimited JSON-RPC over stdio for TypeScript/Python clients. The SDK prompt call returns only an inbox `messageId`; clients observe the open-ended `session.event` stream and whole-agent idle. There is no protocol-version negotiation, per-prompt result, per-session close, or prompt-cancel; abandoning work means closing the runtime process ([protocol](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/sdk/protocol/README.md), [client](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/sdk/client/README.md), [server](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/sdk/server/README.md)).

**Reuse:** use JSON-RPC/JSONL only if AntiFan later needs an out-of-process agent or plugin host. Define protocol version, project/session scope, cancellation, delivery receipts, and stdout purity up front. AntiFan already runs a plain-Node MCP child because Electron main cannot reliably read piped stdin on Windows (`docs/security-model.md:86-93`); this is a strong reason to keep the first runtime in-process.

### 7. Sandbox and Windows/PTY limitations

DSH has a clean sandbox seam (`confine(argv, policy)`) and refuses silent unconfined passthrough. However, its local Windows ACL backend reports `enforcement: partial`: Everyone grants and NTFS hard links can bypass the intended boundary ([sandbox subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/sandbox.md), [sandbox-local limitations](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work)).

PTY state/raw bytes are process-local and only bounded tool input/results are durable ([terminal subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/terminal.md)). DSH selects Bash on POSIX and PowerShell on Windows via profile gating; the non-PTY PowerShell executor explicitly documents no persistent shell, no Windows signal semantics, and possible non-ASCII stdin decoding under Windows PowerShell 5.1 ([minimal preset](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/apps/cli/config/agent-presets/minimal/agent.cordis.yml), [pwsh-local limitations](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/shell/pwsh-local/README.md#known-limitations-and-deferred-work)).

**Plan implication:** AntiFan should reuse policy vocabulary (`read-only`, `workspace-write`, `danger-full-access`) and fail-closed classification, but implement against its existing `TerminalManager`/Windows process lifecycle. Do not vendor DSH's POSIX PTY assumptions as the Windows baseline. Treat persistent terminal bytes as live state; persist only commands/results and explicit process metadata.

## Comparative Analysis

| Concern | DeepSeek Harness | Current AntiFan | Decision |
|---|---|---|---|
| Session authority | Typed append-only event log; derived model messages | Antigravity transcript watcher + `ChatMessage[]` in `NativeTabHost` | Adopt event log; transcript becomes optional import |
| Agent loop | `turn`/`step` loop with live waterfalls | No standalone loop; prompt routed to `AntigravityCommandClient` | Build AntiFan-owned loop |
| Tools | Scoped registry, immutable execution, approval before execute | Browser MCP and broker, high-risk flag, exact project binding | Reuse broker; add native registry around it |
| Providers | Atomic route registration + common streaming chunks | No provider-neutral contract in `src/shared/contracts.ts` | Add narrow provider seam |
| Persistence | JSONL/Zstd or raw JSONL, crash recovery/version checks | Transcript files and local UI/session state | New AntiFan session store; no DSH format dependency |
| Process API | JSON-RPC SDK, no cancel/result attribution | MCP stdio child; Electron main/renderer IPC | Keep first runtime in-process; design future protocol explicitly |
| Sandbox | Cross-platform seam; Windows partial | Security policy + broker; terminal is local | Borrow vocabulary/invariants; validate Windows behavior independently |

## What Is Safe to Reuse vs Unsafe to Vendor

**Safe reference patterns:**

- Durable event taxonomy and `deriveMessages()` projection.
- Separate live extension hooks from durable session facts.
- Immutable tool execution identity, abort propagation, fail-closed approval.
- Provider adapter seam with atomic registration and one-shot call snapshots.
- JSONL append/flush/checkpoint/recovery concepts.
- Explicit capability seams: definition, provider, consumer.

**Unsafe to vendor as-is:**

- Cordis and the entire DSH package/bundle/profile graph.
- DSH session rows, `SESSION_FORMAT_VERSION=0`, or generated event catalog.
- DSH SDK protocol (no negotiation/cancel/per-prompt result).
- DSH local sandbox/PTY implementations as AntiFan's Windows security boundary.
- DeepSeek-specific adapter internals or pi-ai model catalog assumptions.
- DSH CLI/Web/ACP startup and process ownership in an Electron desktop app.

## Concrete AntiFan Plan Implications

1. **Phase 1 contracts:** add AntiFan-owned `Project`, `Workspace`, `Chat`, `Session`, `AgentEvent`, `ToolCall`, `Provider`, and `AgentEvent` types; keep Antigravity DTOs under `integrations/antigravity`.
2. **Session store:** append JSONL events under an AntiFan data root, with a separate header containing project/workspace identity and format version. Add flush, replay, interrupted-turn closure, and schema rejection tests.
3. **Runtime:** implement one in-process loop: user message -> provider stream -> tool approval/execute -> tool result -> next step. Emit UI projections from events; never read `.gemini/antigravity-ide` for standalone context.
4. **Tools:** wrap existing browser/MCP capabilities in a registry that requires project/runtime/document-generation binding. Add filesystem and terminal tools only after workspace and approval gates exist.
5. **Providers:** implement one direct provider first (Anthropic or OpenAI-compatible), then DeepSeek through the same adapter interface. Normalize stream chunks/errors; retry at step boundaries, not inside provider SDKs.
6. **Optional integration:** adapt Antigravity behind the provider/integration seam; transcript sync remains import/compatibility functionality.
7. **Out-of-process later:** if an SDK/plugin host is needed, define version negotiation, cancellation, scoped subscriptions, prompt receipts, and shutdown before copying any DSH JSON-RPC types.

## Risks and Unknowns

- DSH's plugin model is powerful but adds a large lifecycle/debugging surface; AntiFan's first runtime should remain explicit classes/services.
- AntiFan's current `NativeTabHost` owns browser, chat, Antigravity routing, terminal, and persistence concerns; extraction order must avoid breaking existing bridge behavior.
- Windows ACL limitations mean "workspace sandbox" cannot be claimed as absolute without AntiFan-specific tests for reparse points, hard links, inherited ACLs, and temp directories.
- DSH's event model is highly detailed; AntiFan should start with the minimum events needed for resumability and add new events only when a model-visible fact requires durable replay.
- SDK result attribution is unresolved in DSH; AntiFan should tie each user prompt to a turn/run id and explicit terminal status from the beginning.

## Unresolved Questions

- Should AntiFan's first durable backend be raw JSONL or SQLite with a JSONL export/debug path?
- Which provider is the first direct implementation, and what tool-call/vision subset is required for the MVP?
- Does the existing `TerminalManager` need a persistent-session redesign, or should MVP terminal calls be one-shot only on Windows?
- What exact project data root and secret-store mechanism will be used for provider credentials?

## Resources

- [DSH README / developer preview](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/README.md)
- [Architecture and turn flow](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/architecture.md)
- [Session events and projection](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/session.md)
- [Persistence and JSONL backend](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/persistence.md)
- [Tools and execution pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/tools.md)
- [LLM seam and adapters](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/llm/llm/README.md)
- [Sandbox/Windows limitations](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/docs/subsystems/sandbox.md)
- [SDK protocol limitations](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6f/packages/sdk/protocol/README.md)

Status: DONE
Summary: Official DSH architecture, seams, persistence, provider/SDK behavior, approval/sandbox, and Windows/PTY limitations were compared against current AntiFan; the report recommends adopting contracts/invariants as design references and avoiding wholesale vendoring.
Concerns/Blockers: DSH is a developer preview with no compatibility promise; Windows sandbox enforcement is explicitly partial and SDK cancellation/result attribution are incomplete.
