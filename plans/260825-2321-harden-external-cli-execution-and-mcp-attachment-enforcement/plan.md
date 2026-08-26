---
title: "Harden External CLI Execution and MCP Attachment Enforcement"
description: "Make external CLI runs trustworthy by binding every MCP capability call to a Main-issued Run/Attempt attachment and removing unauthenticated MCP fallbacks."
status: completed
priority: P1
effort: "L (3-5 weeks)"
blockedBy: []
blocks: []
tags: [security, architecture, electron, mcp, execution, recovery]
created: 2026-08-25
---

# Harden External CLI Execution and MCP Attachment Enforcement

## Overview

The current control-plane primitives are present, but external CLI execution is
not yet a trustworthy end-to-end path. `RunService` creates Run/Attempt state;
`CodexExecutionBackend` spawns `codex exec --json`; `CapabilityCatalogue` checks
runtime lease, project/workspace, grant, and exact browser target. The missing
boundary is authoritative attachment: caller-supplied `runId`, `attemptId`,
and target fields are currently treated as context values without a Main-owned
proof that the referenced Run/Attempt exists, belongs together, is active, and
is attached to the calling process.

This plan closes that boundary without building an AntiFan model runtime. Main
remains the sole side-effect authority. OMP/Codex/Claude-like CLIs remain
replaceable process or transport adapters. The two external MCP shapes have
different lifecycles and MUST NOT be conflated: the in-process
`AntiFanMcpServer` is a long-lived stdio connection endpoint whose requests
arrive after startup, while a child CLI backend gets a per-attempt adapter and
bootstrap. Both shapes enter one authoritative capability path before browser,
file, terminal, workflow, or future capability side effects.
- A long-lived attachment does not require a custom nonce in standard MCP tool
  arguments. The authoritative transport assigns connection-scoped invocation
  identity/ordering and applies bounded deduplication; a replayed transport
  request cannot execute a mutation twice.
- Browser `tabId` and `browserEpoch` are immutable attachment identity. The
  document generation is a Main-owned live cursor: successful navigation
  advances it, subsequent calls derive the new value, and operations requiring
  the same document reject an old expected generation.

## Outcome

After implementation:

- An external CLI can run only inside a Main-created Run and active
  ExecutionAttempt with an opaque, expiring attachment issued by Main.
- `runId` and `attemptId` in an MCP payload are untrusted claims. They are
  compared with the attachment and RunService state; they never authenticate a
  request.
 - Every external CLI `tools/call`, from either stdio entrypoint, reaches
  `CapabilityTransportAdapter -> CapabilityCatalogue` only after attachment,
  process, lineage, lifecycle, grant, lease, and target checks succeed.
 - Missing, forged, mismatched, stale, revoked, expired, replayed, or
  stopped-attempt requests fail before the capability executor is called.
- Neither external MCP entrypoint can use the Bridge token or
  `getRuntimeBinding()` result as an attachment. The OMP proxy is an external
  capability adapter, not an authority, and cannot call direct Bridge
  side-effect RPCs.
- `AntiFanMcpServer.callTool()` has no unauthenticated direct-switch fallback.
  The OMP proxy's `anti.browser.tabs.create` and all `anti.agent.cursor.*`
  methods use the same authoritative capability protocol; they cannot call
  `openTab` or `antifan.agent*` legacy RPCs directly.
- External MCP mode requires an explicit authoritative transport. The OMP
  entrypoint has exactly two permitted states: **enabled**, where it receives
  the Main-scoped bootstrap and forwards every method through the authoritative
  transport; or **disabled**, where it exposes no capability server, reads no
  `~/.antifan` bridge credential, opens no Bridge connection, and returns a
  typed unavailable result to its launcher. There is no internal-adapter or
  legacy-RPC fallback state.
- Renderer IPC is a first-class Bridge trust boundary. The toolbar remote-info
  handler proves sender/window ownership and the permitted UI pairing action
  before Main creates a pending pairing record. It returns only non-secret
  metadata, an opaque transaction handle, and a client-enrollment challenge;
  no raw Bridge bearer, session key, token-bearing URL, or token-bearing QR
  crosses Main to preload/renderer code.


- Process completion, workflow completion, capability result, evidence capture,
  and verification are distinct states. `completed` is never emitted as proof
  that the user's requested outcome was verified.
- Restart recovery hydrates Run/Attempt facts and marks live attachments
  interrupted or unknown; it never silently reuses an old secret or retries an
  unknown mutation. Resuming or retrying requires explicit reconciliation,
  then a new attachment.

## Non-goals

- No model router, provider runtime, AntiFan-owned agent loop, swarm engine,
  planner, or plugin marketplace.
- No replacement of Chromium, the current browser control plane, or the
  existing Project/UI roadmap.
- No automatic retry of an unknown side effect.
- No active-tab fallback for external CLI-originated requests.
- No Haravan/HRV CLI execution.

## Current evidence and design constraints

| Evidence | Consequence for this plan |
|---|---|
| `src/main/run/run-service.ts:25-96` creates Runs/Attempts and consumes backend events; `:112-176` validates backend event identity but only after the backend emits it | RunService remains lifecycle authority; add attachment issuance/validation there rather than trusting backend payloads |
| `src/main/agent/codex-execution-backend.ts:6-25` accepts an executable override and defaults to bare `codex`; `:28-34` passes caller-derived `cwd` and inherited `PATH` directly to `spawn` | Phase 1 must resolve an approved canonical absolute executable without PATH lookup and perform pre-spawn path/workspace validation; no caller override, bare command, or inherited PATH selection may determine the child |
| `src/main/run/run-service.ts:48-77` requires `options.cwd` but only calls `canonicalizeWorkspaceRoot(options.cwd)` and forwards the original string; it never compares the candidate to the Run's attached Workspace | Phase 1 must derive the WorkspaceRecord from immutable Run project/workspace IDs, validate native realpath containment and no symlink/junction/reparse traversal, and pass only the canonical launch root/cwd to the backend |
| `src/main/project/workspace-registry.ts:15-25` resolves the authoritative Workspace and exposes containment enforcement; `src/shared/control-plane-contracts.ts:224-264` provides canonicalization, containment, and traversal primitives | Use these Main-owned authorities before `StartRunInput` creation; unresolved, outside-root, traversal, or non-directory paths fail before backend/spawn |
| `src/main/mcp/mcp-server.ts:430-466` derives `effectiveTarget` from request context or active automation target and dispatches only when three fields are present | External MCP must require authoritative context; it must not derive a target from the active tab |
| `src/main/mcp/mcp-server.ts:476-752` directly switches into `NativeTabHost` when transport context is absent | Delete or disable this MCP fallback; missing context must fail before side effects |
| `src/main/bridge/bridge-server.ts:52-94,276-291` creates a long-lived bearer token, returns token-bearing remote-info, and persists it in `~/.antifan/bridge*.json` and optionally `~/.gemini/antifan_bridge*.json`; the WebSocket at `:207-273` grants the full legacy RPC switch at `:324-705` after token/origin checks | Phase 3 must remove secret persistence and token-bearing discovery, use short-lived single-use pairing/session exchange, rotate/revoke in-memory session keys, and authorize high-risk legacy RPC separately from generic pairing or MCP attachment |
| `src/main/browser/native-tab-host.ts:344-346` returns `BridgeServer.getRemoteConnectionInfo()` without checking `event.sender`; `src/main/bridge/bridge-server.ts:89-94` returns the raw bearer, URLs, and QR; preload/toolbar code exposes and renders it | Renderer IPC is a first-class Phase 3 secret boundary: authorize the Main-owned toolbar sender and permitted pairing action before issuance, return only non-secret metadata plus an opaque one-time handle and enrollment challenge, require separately approved fresh client proof for exchange, and test all renderer-visible surfaces for raw-token absence |
| `docs/security-model.md:49-55` requires OS-user-scoped short-lived session keys and “No secrets in URLs, logs, or persisted config”; `:13-16` includes same-OS hostile clients as untrusted | The hostile finding is a real contract violation, not an accepted same-user exclusion; Phase 3 must implement the security-model requirement or keep the affected Bridge/LAN path disabled |
| `src/main/browser/native-tab-host.ts:686-694` returns `{ status: 'passed' }` without executing a workflow | Fix the false-positive workflow IPC in the verification phase; do not count the stub as execution evidence |

## Authority model

```text
Main / ControlPlaneRuntime
  RunService (durable Run + Attempt lifecycle; source of lineage truth)
       |
       +-- ExecutionAttachmentRegistry (live secret/process/replay index;
       |   no independent Run/Attempt identity authority)
       |
       +-- ExecutionBackend adapter (Codex/OMP/Claude process only)
       |       |
       |       +-- per-attempt MCP attachment bootstrap
       |
       +-- CapabilityTransportAdapter
               |
               +-- CapabilityCatalogue
                       |
                       +-- browser/files/terminal/workflow executors
```

`RunService` issues an attachment only for a known Run and newly prepared
Attempt, records the attachment binding, and revokes it on terminal attempt,
cancel, process exit, drain, or host epoch change. A narrow registry may hold
hashed secrets, an authenticated connection binding, an owned process/session
reference, bounded transport invocation identities, expiry, and revocation
state, but it MUST ask RunService for authoritative Run/Attempt state. PID is
diagnostic only and MUST NOT establish process ownership. The registry MUST NOT
create parallel Run records or accept a caller's IDs as proof.

Both external MCP entrypoints use the same required authoritative transport and
attachment validator. The in-process server receives it from Main. The OMP
proxy receives only the scoped Phase 1 bootstrap reference and forwards
capability calls; it never treats the Bridge connection token, runtime binding,
caller IDs, or active browser target as proof. The public Bridge protocol must
not expose its legacy direct side-effect methods to that external MCP session.

The Bridge HTTP surface is a separate trust boundary from both WebSocket and
MCP. Default startup binds HTTP/WebSocket to loopback. An explicit LAN mode may
bind to a LAN interface only when every normal HTTP route is authenticated and
authorized, including `/status`, `/api/lan-ips`, `/api/remote-info`, `/api/qr`,
`/api/screenshot`, `/`, `/mobile`, and `/remote`. Use an Authorization header
or an authenticated short-lived HttpOnly session; never accept a bearer token
from a query string as the sole HTTP credential. A narrowly scoped
`/api/pairing/exchange` bootstrap endpoint may accept an opaque transaction
handle only together with a fresh client public-key proof and a pending
Main-owned approval; it returns no sensitive data and issues the HttpOnly
session only once. The handle, endpoint, challenge, and public key are
non-secret rendezvous data, not credentials. Do not emit raw tokens in URLs,
HTML, QR payloads, JSON, redirects, logs, referrers, or error bodies.
`/api/screenshot` must authorize before calling `captureScreenshot()`. Remove
wildcard CORS and allow only the authenticated UI origin policy.
Unauthenticated or malformed requests fail closed without revealing
route-sensitive data.

Bridge credential storage and legacy RPC authorization are separate controls.
Raw Bridge bearer tokens and session keys MUST NOT be written to persisted
config. Metadata files, if retained for non-secret discovery, contain only
port/protocol/process facts and use atomic replacement. Main creates a pending
pairing record from an authorized toolbar action, binds the opaque handle and
enrollment challenge to the client instance, host epoch, origin, and
permission profile, and requires explicit trusted-toolbar approval of the
client proof before `/api/pairing/exchange` can issue a session. The handle
alone, a copied QR/URL, a public key, or a WebSocket cannot mint a session.
Successful exchange creates an in-memory OS-user-scoped session key bound to
that proof and profile; keys expire, rotate on reconnect/restart or elevation,
and revoke on disconnect. The handle/challenge is single-use. The OMP proxy
never reads `~/.antifan` bridge credentials.
The generic paired session cannot authorize high-risk legacy RPC. Main keeps an
explicit allowlist and requires a separately approved short-lived
`legacy-high-risk` authorization for `evalJS`, terminal control, tab mutations,
screenshot capture, cursor/agent mutations, chat push, and inspection/sidebar/
ruler controls. Unknown methods fail closed, and external MCP cannot construct
this compatibility adapter.

Renderer IPC is a separate credential egress boundary. The
`antifan:toolbar:get-mobile-remote-info` handler authenticates `event.sender`
to the Main-owned toolbar window and verifies the permitted UI pairing action
before Main creates a pending pairing record. `getRemoteConnectionInfo()`,
preload, and toolbar rendering receive only non-secret metadata, an opaque
transaction handle, and a client-enrollment challenge. The handle and
challenge are not bearers, session keys, or credentials; handle-only or
identifier-only completion cannot authorize pairing. A separate fresh client
proof plus explicit trusted-toolbar approval is required at the dedicated
exchange endpoint. Raw Bridge bearers, session keys, token-bearing URLs, and
token-bearing QR payloads never leave Main through IPC. Same-OS callers remain
untrusted under `docs/security-model.md`.

The authenticated context passed to the catalogue is derived from the registry
record and RunService lookup. Caller fields are claims only:

1. Validate the opaque attachment secret against a Main-owned hash.
2. Resolve the registry record and reject missing, expired, revoked, stale, or
   replayed transport invocation state.
3. Verify the authenticated connection and Main-owned ChildProcess liveness
   record; PID is a diagnostic consistency field, not authority.
4. Load Run and Attempt by registry IDs; verify Attempt.runId, project,
   workspace, chat, backend, and active lifecycle.
5. Compare caller claims (if present) to the immutable attachment binding.
6. Compare requested capability grant and browser target to the attachment
   binding and current BrowserControlPort target/cursor.
7. Only then call `CapabilityCatalogue.dispatch()`; executors receive the
   derived IDs and target, not caller-selected replacements.

## Resolved design decisions

- **External MCP entrypoints:** enforce the same contract in both
  `AntiFanMcpServer` and `scripts/antifan-omp-mcp.cjs`. The in-process server
  receives Main's transport; the OMP proxy is a thin external forwarding
  adapter that receives only its scoped Phase 1 bootstrap. It never reads a
  Bridge credential, and `getRuntimeBinding()` is discovery metadata, not an
  attachment. Every proxy method, including cursor and tab creation, must
  reach the authoritative capability protocol. If the bootstrap cannot be
  provisioned, the OMP entrypoint is explicitly disabled with no credential
  read, websocket, or capability RPC; it must not fall back to a legacy adapter.
- **Bridge HTTP security:** default bind is loopback. LAN exposure is explicit
  and all normal HTTP routes require independent authentication and
  authorization; query-string tokens are not accepted as the sole credential.
  A narrowly scoped `/api/pairing/exchange` bootstrap accepts only a pending
  opaque handle plus fresh client public-key proof and explicit Main-owned
  approval, then issues one HttpOnly session without sensitive response data.
  Sensitive responses, QR/pairing payloads, HTML, screenshot capture, and CORS
  headers are covered by the same fail-closed policy. No raw Bridge token or
  session key is persisted in bridge metadata; pairing handles/challenges are
  non-secret rendezvous data and never authorize by themselves. Session keys
  are in-memory OS-user-scoped values with expiry/rotation/revocation, and
  non-secret metadata is written atomically if retained.
- **Renderer IPC security:** `antifan:toolbar:get-mobile-remote-info` verifies
  sender/window ownership and the permitted UI pairing action before Main
  creates a pending pairing record. `getRemoteConnectionInfo()` and every
  preload/renderer consumer receive only non-secret metadata, an opaque handle,
  and an enrollment challenge. A separate fresh client proof plus explicit
  trusted-toolbar approval is required before the exchange endpoint issues an
  HttpOnly session. Raw bearers, session keys, token-bearing URLs, and
  token-bearing QR payloads never cross Main-to-renderer IPC.
- **Legacy Bridge RPC:** WebSocket token/origin authentication is not enough
  for high-risk compatibility methods. Main classifies the RPC surface;
  high-risk methods require a separately approved short-lived authorization
  bound to client/session, while unknown methods fail closed. A generic paired
  session, runtime binding, or MCP attachment cannot authorize them, and the
  OMP proxy cannot instantiate the compatibility adapter.
- **Workflow IPC:** use a Main-owned internal workflow application API. The
  renderer selects a stored workflow only; Main proves sender/window ownership,
  resolves immutable Run/Attempt/target state, and passes a Main-derived
  context to `WorkflowEngine`. Unknown callers fail closed through the
  attachment boundary.
- **Process binding:** use the attachment secret, authenticated connection,
  and Main-owned `ChildProcess` liveness record. PID may be recorded for
  diagnostics but cannot authenticate a request.
- **Recovery:** an `interrupted` or `unknown` Attempt cannot restart directly.
  Main records explicit reconciliation, issues a new attachment, and never
  automatically replays an unknown mutation.

## Phases

| # | Phase | Status | Depends on |
|---|---|---|---|
| 1 | [Phase 1: Contract and external CLI bootstrap](./phase-01-start.md) | Pending | - |
| 2 | [Phase 2: Run and attachment authority](./phase-02-run-and-attachment-authority.md) | Pending | 1 |
| 3 | [Phase 3: MCP capability enforcement](./phase-03-mcp-capability-enforcement.md) | Pending | 1, 2 |
| 4 | [Phase 4: Verification and recovery](./phase-04-verification-and-recovery.md) | Pending | 2, 3 |

## Global acceptance criteria

- [ ] Main issues an opaque, expiring, revocable attachment only for an
      existing Run/Attempt and records its immutable project/workspace/target,
      capability grant, backend, host epoch, and owned process/session binding.
- [ ] The catalogue never treats payload `runId`/`attemptId` as authenticated;
      it receives a Main-derived context after registry and RunService checks.
- [ ] Missing attachment/context, nonexistent Run/Attempt, lineage mismatch,
      project/workspace mismatch, stopped attempt, expired/revoked attachment,
      replayed transport invocation, process mismatch, grant mismatch, and
      target or stale same-document expected-generation mismatch all reject
      before any executor call.
- [ ] Bridge credentials follow `docs/security-model.md`: raw Bridge bearer
      tokens and session keys are absent from persisted bridge metadata,
      `.gemini` compatibility files, URLs, HTML, QR, JSON, logs, redirects,
      referrers, and errors. Non-secret metadata is atomically written only if
      retained; otherwise discovery is in-memory/Main-mediated.
- [ ] Pairing displays only an opaque, non-secret, short-lived transaction
      identifier. It is not a bearer, credential, or session key, and its
      presence alone cannot mint a session, authorize a WebSocket, or authorize
      legacy RPC. Pairing completion requires a separate authenticated
      Main-owned proof bound to client instance, host epoch, origin, and
      permission profile. Identifiers are single-use; stale, replayed, or
      identifier-only completion fails before session/WebSocket or host setup.
      Resulting in-memory session keys are OS-user-scoped, expire, rotate on
      reconnect/restart/elevation, and revoke on disconnect. The OMP proxy never
      reads `~/.antifan` bridge credentials.
- [ ] Renderer IPC is independently authorized: the toolbar remote-info
      handler proves `event.sender` belongs to the Main-owned toolbar window
      and the permitted UI pairing action before exchange issuance.
- [ ] `getRemoteConnectionInfo()`, IPC responses, preload payloads, rendered
      QR/URLs, and copied links contain no raw Bridge bearer, session key, or
      token-bearing URL; authorized UI receives only non-secret metadata plus
      the opaque non-secret transaction identifier. Identifier-only, stale, and
      replayed pairing attempts fail before session/WebSocket or host setup; a
      separate authenticated Main-owned proof is required.
- [ ] Legacy Bridge RPC has an explicit classification and deny-by-default
      unknown-method policy. High-risk RPC (`evalJS`, terminal control, tab
      mutation, screenshot, cursor/agent mutation, chat push, and
      inspection/sidebar/ruler controls) requires separate short-lived
      `legacy-high-risk` authorization; generic pairing, WebSocket possession,
      runtime binding, or MCP attachment cannot authorize it.
- [ ] In explicit LAN mode, requests lacking an Authorization credential and
      requests with a forged, mismatched, stale, or replayed credential reject
      for `/status`, `/api/lan-ips`, `/api/remote-info`, `/api/qr`,
      `/api/screenshot`, `/`, `/mobile`, and `/remote` before sensitive data,
      HTML, or host capture is produced.
- [ ] `/api/remote-info` and `/api/qr` are never public in LAN mode and never
      return the raw Bridge token or token-bearing URLs; `/api/screenshot`
      rejects before `captureScreenshot()` for missing and forged credentials.
- [ ] HTTP authorization is independent from the existing WebSocket token and
      origin checks; a valid WebSocket cannot authorize an unauthenticated HTTP
      request.
- [ ] External MCP construction requires an authoritative transport; there is
      no internal-adapter or legacy-RPC fallback for the OMP entrypoint.
- [ ] MCP `tools/call` cannot reach the current direct `switch` when transport
      context is absent. The test proves no browser/file/terminal/workflow host
      method ran.
- [ ] Workflow IPC authenticates sender/window ownership or fails closed via
      attachment validation; renderer-supplied lineage, lease, grant, and
      target fields never reach the engine as authority.
- [ ] MCP and capability-shaped Bridge calls have stable typed errors and no
      active-tab fallback. Legacy UI RPCs are explicitly classified and cannot
      be used by either external CLI attachment path.
- [ ] Codex/OMP launch receives a per-attempt MCP attachment through a
      documented, secret-safe bootstrap contract; tokens never appear in argv,
      stdout, stderr, receipts, events, or error messages.
- [ ] Codex launch uses a Main-approved canonical absolute executable. Bare or
      relative commands, caller executable overrides, missing/non-file or
      unapproved targets, and forged `PATH` entries reject before `spawn()`;
      the child is never selected through PATH lookup.
- [ ] Launch cwd is derived from the Run's attached WorkspaceRecord, exists as
      a directory, and is native-realpath contained beneath or equal to the
      canonical Main-owned root. Outside-root paths, `..` traversal, symlink,
      junction, reparse-point, and unresolved-path cases reject before backend
      invocation or process spawn.
- [ ] Pre-spawn tests prove zero spawn calls for PATH hijacking, outside-root
      cwd, traversal, symlink, and junction/reparse cases; valid root and
      contained-child cases assert the exact approved absolute executable and
      canonical cwd.
- [ ] Run/Attempt status distinguishes process exit, workflow execution,
      capability result, evidence capture, and verification. A process exit 0
      alone cannot produce a verified final result.
- [ ] Restart/recovery revokes or invalidates old attachments, marks in-flight
      attempts interrupted/unknown according to observed process state, and
      requires explicit reconciliation plus a new attachment before resume.
- [ ] Forged workflow IPC lineage/target tests reject before WorkflowEngine,
      capability catalogue, browser, file, terminal, workflow, or artifact
      executors; host-side spy counts remain zero.
- [ ] Focused tests cover happy path plus missing, mismatch, forgery, stale,
      replay, stopped-attempt, target-generation, process-binding, fallback,
      secret-redaction, recovery, false-positive workflow, Bridge HTTP
      unauthenticated/LAN/CORS/token-leak/screenshot-gating, and renderer IPC
      sender/window/permission/token-egress cases.
- [ ] The proxy adapter test covers each declared OMP method:
      `anti.browser.tabs.list`, `anti.browser.tabs.create`,
      `anti.browser.navigate`, `anti.browser.reload`, `anti.inspect.dom`,
      `anti.screenshot.viewport`, `anti.agent.cursor.click`,
      `anti.agent.cursor.move`, `anti.agent.cursor.type`,
      `anti.agent.cursor.scroll`, `anti.agent.cursor.hover`,
      `anti.agent.cursor.highlight`, and `anti.agent.cursor.clear`; every
      method uses the authoritative transport and none calls `openTab`,
      `getRuntimeBinding`, or `antifan.agent*` directly.
- [ ] README and the security model document the two external MCP entrypoints,
      the authoritative bootstrap requirement, and the separate legacy UI
      compatibility boundary.
- [ ] `npm run typecheck`, focused lifecycle/MCP tests, `npm test`, and the
      relevant Windows smoke scenario pass before handoff.

Implement behind the existing runtime lifecycle/drain switch. During rollout,
new external CLI attachments may be disabled while existing legacy UI/Bridge
operations remain available only where their explicit classification permits it.
The Bridge HTTP listener defaults to loopback. LAN mode is opt-in and cannot
start until its route authentication, authorization, pairing/token-redaction,
CORS, and screenshot pre-gate are active. The toolbar remote-info action must
remain disabled until Main sender/window authorization, permitted-action
verification, one-time transaction-identifier issuance, separate authenticated
Main-owned pairing proof, and renderer credential-redaction tests pass. Both
external MCP entrypoints are constructed or launched only with the authoritative
transport/bootstrap and attachment validator. If bootstrap is unavailable,
either entrypoint returns a typed unavailable/error result and performs no side
effect; neither reads Bridge credentials, restores the direct switch, calls
`openTab`, or calls `antifan.agent*` through the legacy Bridge route. Internal
UI calls remain available only through the separately classified non-MCP
adapter. Drain owned attempts and revoke attachments before switching transport
mode.

This plan supersedes neither the completed standalone control-plane plan nor
the broader Chromium/project UI roadmap. It supplies the missing execution
trust boundary those plans assumed.

## Handoff

Implementation starts only after the plan passes parser validation and hostile
review. The intended handoff is:

```text
/ak:cook E:/Work/apps/antifan-browser-desktop/plans/260825-2321-harden-external-cli-execution-and-mcp-attachment-enforcement/plan.md
```

<!-- slug: harden-external-cli-execution-and-mcp-attachment-enforcement -->
## Validation Log

### Verification Results

- Claims checked: current-source anchors across all four phases, plus the
  Bridge HTTP route/bind/screenshot/CORS/token-exposure evidence and the
  external CLI launch-path evidence cited in the latest amendments.
- Verified: `CodexExecutionBackend` currently defaults to bare `codex`, passes
  inherited `PATH`, and forwards `input.cwd`; `RunService` currently
  canonicalizes `options.cwd` without checking it against the Run's attached
  WorkspaceRecord. The plan now assigns the required fail-closed boundary to
  Phase 1.
- Verified: the Bridge HTTP handler and separately authenticated WebSocket
  path are distinct source paths; Phase 3 owns their independent HTTP policy.
- Tier: Standard (Fact Checker + Contract Verifier).
- Unverified design facts requiring implementation evidence: the supported
  Codex/OMP MCP bootstrap contract, the concrete Main-owned process/session
  handle available on Windows, the approved executable-installation source,
  and the exact runtime mechanism for rejecting Windows reparse traversal.
  The plan constrains these facts without guessing an unsupported vendor flag,
  treating PID as proof, using PATH lookup, or treating the Bridge token as an
  attachment.

### Validation Decisions

- External MCP mode requires an explicit authoritative transport for both
  `AntiFanMcpServer` and `scripts/antifan-omp-mcp.cjs`; the latter is not an
  internal exception. Internal legacy UI operations use a separately named
  non-MCP adapter.
- Phase 1 launch authority is Main-owned: Codex uses an approved canonical
  absolute executable with no PATH lookup, and RunService derives and validates
  launch cwd against the attached WorkspaceRecord with native-realpath
  containment plus symlink/junction/reparse rejection before spawn.
- The OMP proxy receives only a Main-scoped Phase 1 bootstrap when enabled;
  it never reads a Bridge credential or uses `getRuntimeBinding()` as an
  attachment. Cursor and tab-creation methods use the same attachment-backed
  capability endpoint as mapped browser tools.
- Workflow IPC uses a Main-owned internal application API that proves
  sender/window ownership and derives immutable Run/Attempt/target context;
  unknown callers fail closed through attachment validation.
- Process authority is the attachment secret, authenticated connection, and
  Main-owned `ChildProcess` liveness record; PID is diagnostic only.
- Transport invocation identity is connection-scoped and transport-issued;
  bounded deduplication prevents replayed mutation frames without requiring a
  custom nonce in standard MCP tool arguments.
- Recovered `interrupted` or `unknown` Attempts require explicit
  reconciliation and a new attachment before resume/retry; unknown mutations
  are never replayed automatically.

### Hostile Finding Adjudication

- Finding `BRIDGE-RENDERER-BEARER-EGRESS`: accepted as a real high-severity
  credential-exposure and authorization-bypass risk (CWE-522, CWE-669,
  CWE-862), not an accepted same-user exclusion.
- Evidence chain: `src/main/browser/native-tab-host.ts:344-346` exposes
  `getRemoteConnectionInfo()` without sender/window authorization;
  `src/main/bridge/bridge-server.ts:89-94` returns the bearer, token-bearing
  URLs, and QR; `src/preload/toolbar-preload.ts:60-62` exposes the result; and
  `src/renderer/toolbar.ts:1295-1312` renders/copies it. A bearer holder can
  then reach the token-authenticated WebSocket and the direct legacy RPC path
  at `src/main/bridge/bridge-server.ts:210-215,334-351`.
- Resolution: Phase 3 now owns this renderer IPC boundary. It requires
  Main-owned toolbar sender/window authorization and permitted UI pairing
  authorization before creating a pending record; exposes only non-secret
  metadata plus an opaque single-use handle and enrollment challenge; requires
  fresh client public-key proof and explicit trusted-toolbar approval at the
  dedicated exchange endpoint; forbids handle-only authorization and raw
  bearer/session-key/token-bearing URL/QR egress; and adds unauthorized,
  wrong-window, missing-permission, invalid-proof, unapproved, stale, replay,
  and renderer-surface redaction tests.
- Hostile review verdict: `CLOSED` at the plan-design level. The replacement
  security reviewer re-read the amended global plan, Phase 3, security model,
  and source anchors and found no material contradiction or remaining finding.
  This does not prove runtime enforcement.
- Implementation closure condition: the production risk remains open until
  Phase 3 implementation and focused tests prove these controls. Plan text
  coverage and hostile-review closure are not implementation evidence.

<!-- Updated: Accepted BRIDGE-RENDERER-BEARER-EGRESS and added renderer IPC trust boundary -->

### Whole-Plan Consistency Sweep

- Re-read `plan.md` and all four phase files after the process-binding,
  Bridge HTTP, and external CLI launch-boundary amendments.
- Confirmed Phase 1 names approved executable resolution, no-PATH launch,
  WorkspaceRecord-derived cwd, native-realpath containment, and
  symlink/junction/reparse rejection before spawn; its tests cover PATH
  hijacking, outside-root cwd, `..` traversal, symlink, and junction/reparse
  cases with zero-spawn assertions.
- Confirmed the process-binding contract uses the attachment secret,
  authenticated connection, and Main-owned `ChildProcess` liveness record;
  PID remains diagnostic only and cannot authenticate a request.
- Confirmed both external MCP entrypoints and the Bridge HTTP trust boundary
  are named in the outcome, authority model, affected files, implementation
  steps, rejection matrix, and acceptance criteria.
- Confirmed `/status`, `/api/lan-ips`, `/api/remote-info`, `/api/qr`,
  `/api/screenshot`, `/`, `/mobile`, and `/remote` are covered by independent
  authorization, with screenshot authorization before capture, explicit CORS,
  and token-redaction requirements.
- Replacement hostile security review completed with verdict `CLOSED` and no
  material findings. It confirmed the pairing state machine, Main-owned toolbar
  authorization, fresh client proof plus explicit approval, one-time HttpOnly
  session exchange, credential-redaction boundary, authoritative OMP/MCP
  transport, and separate high-risk legacy RPC authorization. The minor file
  inventory concern was resolved by naming `src/main/bridge/mobile-remote-html.ts`
  in Phase 3.
- Consistency result: no unresolved contradictions were found in the re-read
  plan text. This is a source-text and plan-design result only; implementation
  facts remain unverified until the phase evidence and tests exist.

<!-- Updated: Dual MCP Entrypoint Boundary + Whole-Plan Consistency Sweep -->

<!-- Updated: Validation Session 1 + Dual MCP Entrypoint Advisory - resolved MCP, workflow IPC, process binding, recovery, and OMP proxy boundaries. -->
