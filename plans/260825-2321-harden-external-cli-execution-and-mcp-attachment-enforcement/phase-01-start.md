---
title: "Phase 1: Contract and External CLI Bootstrap"
status: completed
priority: P1
effort: "3-5d"
dependencies: []
---

# Phase 1: Contract and External CLI Bootstrap

## Overview

Freeze the trust-boundary contracts and wire the Main-owned launch seam before
changing capability behavior. This phase makes the missing path explicit for
both external MCP entrypoints: `RunService` prepares an Attempt, issues an
attachment, and hands the execution backend a scoped MCP bootstrap reference.
The backend and OMP stdio proxy remain thin process/transport adapters and do
not become an agent runtime.

## Requirements

- Define separate types for untrusted MCP claims, Main-issued attachment
  records, and authenticated capability context. Do not widen optional
  `CapabilityRequestContext` fields and call that authentication.
- Define stable typed errors for absent/invalid/stale attachments, lineage and
  process mismatches, inactive attempts, transport invocation replay, missing
  MCP context, and target mismatch.
- Define a secret-safe launch contract for Codex and future CLI adapters. The
  attachment secret cannot be placed in argv or serialized into ordinary
  event/receipt payloads.
- Main resolves the CLI executable from trusted application configuration or
  an approved installation record. The launch value must be an approved,
  canonical absolute executable path; a bare command, relative path,
  caller-supplied override, or `PATH` lookup fails with a typed launch error
  before `spawn()`.
- `RunService` must obtain the attached `WorkspaceRecord` by the Run's
  immutable project/workspace IDs. A requested launch directory is untrusted:
  Main requires the registered root and candidate to exist as directories,
  resolves native realpaths, rejects `..` escape and every symlink, junction,
  or reparse-point segment, and proves containment beneath or equality with
  the Main-owned root before creating `StartRunInput`. The backend receives
  only the resulting canonical root/cwd and never falls back to caller cwd or
  `process.cwd()`.
- Define process, workflow, capability, evidence, and verification outcomes as
  separate facts. A backend `status: completed` event remains process/run
  state, not proof of verification.
- External MCP mode has no optional production transport. Main constructs the
  long-lived `AntiFanMcpServer` only after startup recovery/hydration succeeds;
  missing bootstrap disables external MCP with a typed unavailable/context-
  required error.
- The child CLI launch contract uses a high-entropy secret delivered through a
  private environment/pipe, an authenticated connection handshake, and the
  Main-owned `ChildProcess` liveness record. PID is diagnostic only; Node.js
  does not assume an unavailable Win32 process handle.
- Workflow IPC and internal UI calls are separate from external MCP. No
  renderer payload or legacy direct adapter may create an external CLI
  capability context.
- The OMP stdio entrypoint `scripts/antifan-omp-mcp.cjs` currently discovers a
  Bridge token/runtime binding and constructs caller-owned context; that is a
  legacy bootstrap, not an attachment. Replace it with its own Phase 1 scoped
  child-adapter contract and keep direct Bridge RPCs unavailable to the proxy.

## Current source anchors

- `src/main/agent/execution-backend.ts:3-15` currently accepts a raw `cwd`
  without a Main-derived canonical workspace root or launch-path proof.
- `src/main/agent/codex-execution-backend.ts:6-25` accepts an executable
  override and defaults to bare `codex`; `:28-34` passes caller-derived `cwd`
  and inherited `PATH` directly to `spawn()`.
- `src/main/run/run-service.ts:48-77` requires `options.cwd` but only calls
  `canonicalizeWorkspaceRoot(options.cwd)` and then forwards the original
  string; it never compares that path with the Run's attached Workspace.
- `src/main/project/workspace-registry.ts:15-25` can resolve the authoritative
  Workspace by project/workspace IDs and enforce containment.
- `src/shared/control-plane-contracts.ts:224-264` owns realpath
  canonicalization, containment, and symlink/junction traversal primitives;
  Phase 1 must use fail-closed existence and segment checks for launch paths.
- `src/main/index.ts:146-216` creates ControlPlaneRuntime and transport but
  never creates a Run/backend application service or attachment bootstrap.
- `src/shared/control-plane-contracts.ts:126-145` currently models optional
  caller context; `:185-197` owns typed capability errors.

```text
Startup recovery/hydration
  -> open long-lived AntiFanMcpServer only after projections load

RunService.prepareAttempt()
  -> issue attachment (immutable tab/browser epoch; live Main document cursor)
  -> child backend spawn -> bind secret/connection/session -> activate MCP
  -> per-attempt CLI adapter consumes its scoped bootstrap
  -> Main derives AuthenticatedCapabilityContext per request
```

The long-lived in-process MCP server and the per-attempt child CLI adapter are
separate lifecycle contracts. The server is not constructed with one Attempt's
attachment; each request presents a Main-provisioned envelope after startup
hydration. The child adapter is activated only after Main observes its
two-phase bind/handshake. The exact CLI mechanism must be selected from the
supported Codex/OMP command contract during implementation (for example a
private inherited environment handle plus a local authenticated stdio/IPC
channel); the plan MUST NOT guess an unsupported vendor flag. Both adapters
must scrub or avoid secret-bearing argv, stderr, stdout, JSONL events, receipts,
and thrown errors.

## Related Code Files

- Modify: `src/main/agent/execution-backend.ts`
- Modify: `src/main/agent/codex-execution-backend.ts`
- Modify: `src/main/control-plane/control-plane-runtime.ts`
- Modify: `src/main/run/run-service.ts`
- Modify: `src/main/project/workspace-registry.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/control-plane-contracts.ts`
- Create or modify: `src/main/run/execution-attachment-registry.ts`
- Modify: `scripts/antifan-omp-mcp.cjs`
- Modify: `README.md`
- Modify: `docs/security-model.md`
- Modify: `test/main/codex-execution-backend.test.ts` (or the existing backend test owner)
- Modify: `test/main/run-lifecycle.test.ts`
- Create or modify: `test/main/omp-mcp-adapter.test.ts`

## Implementation Steps

1. Add explicit `McpAttachmentLaunch`, `UntrustedCapabilityClaims`, and
   Main-derived authenticated context types. Keep immutable lineage, tab, and
   browser-epoch fields stable after issuance; keep document generation as a
   Main-owned cursor advanced only after successful navigation/load.
2. Add a Main-owned launch-path contract. Resolve the Run's attached
   `WorkspaceRecord`, require an existing canonical root and candidate
   directory, reject lexical escape plus symlink/junction/reparse traversal,
   and prove native-realpath containment. Put only the canonical workspace
   root and canonical launch cwd into `StartRunInput`; reject before backend
   invocation when validation fails.
3. Resolve Codex from trusted application configuration or an approved install
   record to a canonical absolute executable. Reject bare commands, relative
   paths, caller overrides, missing/non-file targets, and unapproved canonical
   targets before `spawn()`; pass the approved absolute path directly so a
   forged `PATH` entry cannot select the child process.
4. Add a backend launch hook that receives only the per-attempt bootstrap,
   canonical launch-path contract, and a redacted metadata view. Keep
   `CodexExecutionBackend` limited to process spawn, stream parsing, timeout,
   cancellation, and normalized events.
5. Wire one Main-owned execution application boundary from ControlPlaneRuntime
   through WorkspaceRegistry to RunService/backend. Do not let `NativeTabHost`,
   MCP, or a caller-provided `cwd`/executable construct launch authority,
   Runs, Attempts, or attachments.
6. Add pre-spawn tests for a bare executable and `PATH` hijack, outside-root
   absolute cwd, `..` traversal, symlink traversal, and Windows junction/
   reparse traversal. Each rejection leaves the spawn spy at zero. Add the
   valid-root and contained-subdirectory cases and assert the exact approved
   absolute executable plus canonical cwd passed to `spawn()`.
7. Add secret-redaction and cancellation tests: no token in argv or normalized
   events/errors, and cancellation closes/revokes the attempt attachment.
8. Record the vendor-specific CLI MCP bootstrap assumption and its evidence in
   the implementation notes before choosing flags or config files.
9. Specify the OMP proxy bootstrap separately from Bridge discovery: the proxy
   receives only a scoped launch reference/authoritative transport handle and
   cannot read `bridge.json`, call `getRuntimeBinding`, call `openTab`, or call
   `antifan.agent*` as capability authorization. If that transport cannot be
   provisioned, the proxy is explicitly disabled: it starts no MCP capability
   server, reads no `~/.antifan` credential, opens no websocket, and returns a
   typed unavailable/context-required result to its launcher.

## Success Criteria
- [ ] Startup recovery hydrates Run/Attempt projections before either external
      MCP transport opens; failed hydration leaves both external paths disabled.
- [ ] The long-lived `AntiFanMcpServer` and per-attempt child adapter have
      separate lifecycle tests; neither is treated as the other's bootstrap.
- [ ] If the child-adapter bootstrap cannot be provisioned or bound, it is
      explicitly disabled and its regression test proves no capability handler
      or host-side RPC occurs.
- [ ] Both external MCP shapes receive only Main-scoped connection/bootstrap
      material when enabled; neither can self-authorize from Bridge metadata or
      caller-built IDs.
- [ ] A backend start input contains a scoped MCP launch reference without
      exposing the raw secret to event/receipt serialization.
- [ ] Codex launch uses an approved canonical absolute executable supplied by
      Main; bare/relative/caller-overridden executables and forged `PATH`
      entries reject before spawn.
- [ ] The launch cwd is derived from the Run's attached Workspace, exists as a
      directory, and is native-realpath contained beneath or equal to its
      canonical Main-owned root. Outside-root paths, `..` escape, symlinks,
      Windows junctions/reparse points, and unresolved paths reject before
      backend invocation or process spawn.
- [ ] Rejection tests assert zero spawn calls; positive root and contained-child
      tests assert the exact approved executable and canonical cwd received by
      `spawn()`.
- [ ] Main bootstrap has one execution owner; no new model/agent/provider loop
      is introduced.
- [ ] Tests fail if an attachment secret appears in argv, stdout/stderr
      mapping, normalized events/errors, receipt bindings, or thrown error text.
- [ ] No capability side effect is reachable from this phase without a later
      Phase 3 attachment gate.

## Risks and rollback

Executable and path approval must be deterministic across Windows path casing,
drive/UNC forms, and POSIX paths. Platform-specific symlink/junction tests may
be conditionally skipped only when the host cannot create that filesystem
primitive; the corresponding Windows smoke gate remains required. Do not
weaken the boundary to string-prefix checks or silently accept an unresolved
path.

The current app starts a standalone stdio MCP server from `index.ts` and creates
its own runtime; that process model may not yet support per-attempt attachment
injection. If the vendor CLI or OMP proxy cannot consume the selected bootstrap
contract, keep external CLI attachment launch disabled and return a typed
unavailable error rather than falling back to active-tab, runtime-binding, or
direct-host execution.
