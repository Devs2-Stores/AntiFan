---
title: "Phase 3: MCP Capability Enforcement"
status: completed
priority: P1
effort: "5-8d"
dependencies: [1, 2]
---

# Phase 3: MCP Capability Enforcement

## Overview

Make MCP `tools/call` fail closed in both external entrypoints. The current
`AntiFanMcpServer.callTool()` uses the catalogue only when `runtimeLease`,
`projectId`, and `workspaceId` are present (`src/main/mcp/mcp-server.ts:453-475`),
then falls through to a direct `NativeTabHost` switch (`:476-752`) otherwise.
The OMP stdio proxy independently reads Bridge metadata, calls `openTab`, and
routes cursor tools to `antifan.agent*`. Those two gaps permit unauthenticated
mutations and active-tab targeting. This phase removes both bypass families and
makes every external CLI capability call pass the attachment and catalogue gates.

## Requirements

- `AntiFanMcpServer` must be constructed with an authoritative transport and
  attachment validator for external MCP mode. The constructor contract is
  explicit, not optional: a missing transport/bootstrap produces a typed
  `MCP_CONTEXT_REQUIRED` or unavailable error and cannot select active-tab or
  direct-host behavior.
- `tools/call` must reject missing lease, project, workspace, attachment,
  process binding, Run/Attempt lineage, grant, or exact target before any
  browser/file/terminal/workflow host method runs.
- Remove or disable the direct `switch` fallback for MCP. If legacy direct host
  calls are retained for an internal UI adapter, move them behind a separately
  named non-MCP interface that external CLI code cannot instantiate.
- `tools/list` must enumerate only catalogue-backed tools in authoritative MCP
  mode. A static list without a callable authoritative path is not a valid
  external CLI capability surface.
- Canonical aliases must normalize before validation; aliases cannot bypass
  policy, attachment, target, or transport-invocation deduplication checks.
- Apply the same rule to capability-shaped Bridge dispatch. Keep only an
  explicit compatibility allowlist for unrelated extension/UI RPCs; do not let
  omitted capability context reach browser/file/terminal mutation.
- Reject active-tab fallback for external CLI requests even when the requested
  tool does not require a browser target. Target omission must not be filled
  from `getAutomationTarget()` for an attached CLI.
- `scripts/antifan-omp-mcp.cjs` is an external MCP capability entrypoint, not an
  internal adapter. When enabled it must forward canonical capability calls
  through the authoritative transport. It must not use `getRuntimeBinding()`
  as an attachment, call `openTab` for tab creation, or map cursor tools to
  `antifan.agent*` RPCs. When the scoped bootstrap is unavailable it must be
  explicitly disabled before credential discovery or websocket setup and
  return a typed unavailable/context-required result; no legacy fallback exists.
- The OMP proxy must preserve typed rejection/error envelopes and must not leak
  attachment secrets into MCP content, stderr, or Bridge RPC error text.
- The Bridge HTTP handler is a separate trust boundary from WebSocket and MCP.
  Phase 3 owns `src/main/bridge/bridge-server.ts` and
  `test/main/bridge-capability-enforcement.test.ts` for this boundary. The
  current HTTP routes at `:97-150` do not check a request token before serving
  data, HTML, or screenshot capture: `/api/remote-info` exposes the raw token,
  token-bearing URLs, and QR; `/api/qr` exposes a token-bearing QR; and
  `/api/screenshot` calls `captureScreenshot()` without authorization. The
  existing WebSocket path at `:207-273` separately checks token and origin and
  must not be treated as HTTP authorization.
- Bind to loopback by default; explicit LAN mode must independently
  authenticate and authorize `/status`, `/api/lan-ips`, `/api/remote-info`,
  `/api/qr`, `/api/screenshot`, `/`, `/mobile`, and `/remote` before generating
  any response or invoking host capture. Do not treat `?token=` as the sole
  credential. Pairing payloads contain only an opaque short-lived, single-use
  handle plus an enrollment challenge; neither value authorizes by itself. Raw
  tokens must not appear in URLs, HTML, QR payloads, JSON, redirects,
  referrer-visible markup, logs, or errors. `/api/screenshot` must authorize
  `captureScreenshot()`, and CORS must use an explicit allowlist rather than
  `*`.

- Bridge credentials must follow the repository security model: raw bearer
  tokens and session keys are never persisted in `~/.antifan/bridge*.json`,
  `~/.gemini/antifan_bridge*.json`, URLs, HTML, QR payloads, JSON, logs,
  redirects, referrers, or error text. Persisted bridge metadata may contain
  only non-secret port/protocol/process facts and must be written atomically;
  if a compatibility path cannot avoid secret persistence, that path remains
  disabled rather than weakening the contract.
- Renderer IPC is a first-class Bridge secret boundary. The
  `antifan:toolbar:get-mobile-remote-info` handler must authenticate
  `event.sender` to the Main-owned toolbar window and verify the permitted UI
  pairing action before issuing anything. The handler and
  `getRemoteConnectionInfo()` contract return only non-secret metadata plus an
  opaque short-lived, single-use handle and enrollment challenge; neither is a
  bearer or independent authority. No bearer token, session key, token-bearing
  URL, or token-bearing QR crosses Main-to-renderer IPC. Preload
  and toolbar code must not reconstruct a raw credential. Unauthorized or
  compromised renderers receive no usable Bridge credential. Same-OS callers
  remain untrusted under `docs/security-model.md` and are not excluded.
- Legacy UI pairing uses an opaque, non-secret, short-lived transaction
  identifier from an authenticated local/Main-owned channel. The identifier is
  not a bearer, credential, or session key; its presence alone cannot mint a
  session, authorize a WebSocket, or authorize any legacy RPC. Pairing
  completion requires a separate authenticated Main-owned proof bound to the
  client instance, host epoch, origin, and permission profile. The identifier
  is single-use, and stale, replayed, or identifier-only completion fails
  before WebSocket setup or host calls. The resulting in-memory session key is
  OS-user-scoped; it expires, rotates on reconnect/restart or elevation, and is
  revoked on disconnect. External OMP MCP never discovers or reads a bridge
  credential from disk and uses only its scoped Phase 1 bootstrap.
- The authenticated legacy WebSocket session is not a blanket grant. Main
  classifies every legacy RPC explicitly. High-risk methods, including
  `evalJS`, terminal input/session control, tab creation/close/switch/
  navigation/reload, screenshot capture, agent cursor mutations, chat push,
  and inspection/sidebar/ruler controls, require a separately approved,
  short-lived `legacy-high-risk` authorization bound to that client/session.
  A generic paired session, WebSocket possession, Bridge metadata, runtime
  binding, or MCP attachment cannot supply that authorization. Unknown or
  unclassified methods fail closed; external MCP cannot instantiate the
  legacy compatibility adapter.

## Current source anchors

- `src/main/mcp/mcp-server.ts:19-53` owns MCP request handlers; `:388-476`
  parses aliases, derives effective target, and conditionally dispatches.
- `src/main/mcp/mcp-server.ts:430-435` currently uses request target or active
  automation target; `:476-752` directly calls `NativeTabHost`.
- `src/main/mcp/mcp-server.ts:800-851` can build catalogue-backed aliases but
  `:818-820` still supports a static fallback list.
- `src/main/tools/capability-transport.ts:6-13` is the shared dispatch wrapper.
- `src/main/tools/capability-catalogue.ts:44-56` is the final catalogue gate
  before `definition.execute`.
- `src/main/bridge/bridge-server.ts:335-351` has a transport-or-direct
  fallback; `:354-705` contains direct RPC handlers.
- Existing tests intentionally instantiate fallback MCP servers at
  `test/main/capability-catalogue.test.ts:294-309` and `:311-387`; those tests
  must be rewritten to assert fail-closed behavior for MCP.
- `scripts/antifan-omp-mcp.cjs:34-81` is a second external stdio MCP entrypoint;
  its Bridge-token bootstrap, direct `openTab`, and legacy cursor mappings are
  all bypass paths covered by this phase.
- `src/main/bridge/bridge-server.ts:97-150` owns the HTTP handler; `:103-106`
  is `/status`, `:109-116` is LAN/remote-info, `:119-125` is QR,
  `:128-138` is screenshot, and `:141-145` is HTML. These routes currently
  lack HTTP auth and expose wildcard CORS/token material; `:153-192` owns
  startup, fallback binding, and listen behavior, including the current
  `0.0.0.0` bind.
- `src/main/bridge/bridge-server.ts:207-273` separately authenticates
  WebSocket token and origin; this existing check is not an HTTP session and
  cannot authorize a separate HTTP request.
- `src/main/browser/native-tab-host.ts:344-346` currently handles
  `antifan:toolbar:get-mobile-remote-info` without checking `event.sender` and
  returns `BridgeServer.getRemoteConnectionInfo()`. That method returns the raw
  bearer, token-bearing URLs, and QR at `src/main/bridge/bridge-server.ts:89-94`;
  `src/preload/toolbar-preload.ts:60-62` exposes it and
  `src/renderer/toolbar.ts:1295-1312` renders/copies it. This Main-to-renderer
  path is a separate credential egress boundary from HTTP and WebSocket.

## Architecture

```text
In-process external MCP
  -> parse/normalize alias
  -> require Main-provisioned request envelope on hydrated connection
  -> validate attachment + process/session + Run/Attempt + target + current cursor
  -> reserve transport-issued invocation identity in bounded window
  -> CapabilityTransportAdapter.dispatch(derivedContext)

Per-attempt child CLI MCP adapter
  -> complete Main bind/handshake before activation
  -> parse/normalize proxy method
  -> use only its scoped authoritative bootstrap
  -> forward through the authoritative capability transport
  -> validate attachment + process/session + Run/Attempt + target + current cursor
  -> reserve transport-issued invocation identity in bounded window
  -> CapabilityTransportAdapter.dispatch(derivedContext)
```

No edge after `require authoritative request envelope` may call
`NativeTabHost`, `TerminalManager`, filesystem, workflow engine, or artifact
store. Error serialization must expose stable code/message without secret,
raw token, or private process details.

For Bridge, split the existing handler into capability dispatch and legacy UI
RPC classification. Capability methods always use transport and attachment
validation. `getRuntimeBinding` may remain a binding-discovery operation only
if it does not grant a capability and does not return raw attachment secrets.
Direct legacy methods must not be callable by the external CLI MCP bootstrap.

### Pairing exchange contract

The pairing flow has four Main-owned states: `pending`, `approved`, `exchanged`,
and `revoked`. An authorized toolbar IPC action creates a pending record with
an opaque transaction handle, an expiry, a client-enrollment challenge, the
expected client instance/host epoch/origin/permission profile, and no session
secret. The remote client generates a fresh key pair and submits a proof of
the challenge plus its public key to Main through the dedicated
`/api/pairing/exchange` bootstrap request. Main accepts that request only when
the handle is pending, the proof is valid, the origin/client binding matches,
and the trusted toolbar has explicitly approved that client proof. On success,
Main atomically marks the record exchanged, creates the in-memory session key,
and sets it only as an authenticated `HttpOnly; Secure; SameSite=Strict`
session cookie; the response body, URL, QR, logs, and errors contain no
credential. Missing proof, handle-only, stale, replayed, mismatched, or
unapproved requests return before session/WebSocket/host setup. The exchange
endpoint is the sole unauthenticated bootstrap exception and exposes no
sensitive route data; all other HTTP routes require the resulting session or a
separately authorized non-query credential.


## Related Code Files

- Phase owner: Phase 3 owns the Bridge HTTP authorization, LAN bind policy,
  sensitive-response redaction, screenshot pre-gate, and renderer IPC
  credential boundary.
- Modify: `src/main/mcp/mcp-server.ts`
- Modify: `src/main/tools/capability-transport.ts`
- Modify: `src/main/tools/capability-catalogue.ts`
- Modify: `src/main/bridge/bridge-server.ts`
- Modify: `src/main/bridge/mobile-remote-html.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/toolbar-preload.ts`
- Modify: `src/renderer/toolbar.ts`
- Modify: `scripts/antifan-omp-mcp.cjs`
- Modify: `README.md`
- Modify: `docs/security-model.md`
- Modify: `src/shared/control-plane-contracts.ts`
- Modify: `test/main/capability-catalogue.test.ts`
- Create or modify: `test/main/mcp-attachment-enforcement.test.ts`
- Create or modify: `test/main/bridge-capability-enforcement.test.ts`
- Create or modify: `test/main/toolbar-remote-info-ipc.test.ts`
- Create or modify: `test/main/omp-mcp-adapter.test.ts`

## Implementation Steps

1. Require the authoritative transport in external MCP mode and add a
   fail-closed context parser. Preserve alias normalization but remove target
   fallback and direct host dispatch for MCP.
2. Move any still-needed internal direct calls to a non-MCP adapter or delete
   them when catalogue coverage exists. Do not leave an unreachable-looking
   `switch` that can be re-enabled by omission.
3. Pass the attachment secret through the authenticated transport envelope; do
   not require a custom nonce in standard MCP tool arguments. Derive invocation
   identity, IDs, grant, and target from Main/transport authority. Do not merge
   caller objects over derived fields.
4. Make `CapabilityTransportAdapter` the sole MCP/Bridge capability entry and
   ensure `CapabilityCatalogue.dispatch` performs the final lifecycle/target
   invariant check immediately before `definition.execute`.
5. Update tools/list so discovery matches the actual callable, policy-filtered
   catalogue. Add tests proving aliases and direct names share identical
   enforcement.
6. Add host-side spies to assert missing, stale, forged, and mismatched calls
   do not invoke browser, file, terminal, workflow, or artifact executors.
7. Test the OMP adapter as an external caller, not as an internal exception:
   verify every mapped browser, tab-creation, and `anti.agent.cursor.*` method
   reaches the authoritative transport; assert no test path invokes
   `openTab`, `getRuntimeBinding`, or `antifan.agent*` as a capability route.
8. In `bridge-server.ts`, implement the Phase 3 HTTP authorization policy
   before any route-specific work. Keep loopback as the default bind and gate
   explicit LAN mode on the policy. Reject missing, forged, mismatched, stale,
   replayed, malformed, and query-only credentials for every normal HTTP route;
   do not reuse WebSocket-authenticated state as HTTP authorization. Implement
   the dedicated `/api/pairing/exchange` bootstrap as the sole exception: it
   accepts only a pending opaque handle, fresh client public-key challenge
   proof, matching binding, and explicit trusted-toolbar approval; it consumes
   the handle exactly once and sets an authenticated HttpOnly session cookie
   without returning sensitive data.
9. Remove raw bearer/session-key persistence from `persistBridgeInfo()` and
   replace token-bearing discovery with the Main-owned pairing state machine
   above. Persist only non-secret metadata, if any, by atomic replacement;
   otherwise keep discovery in memory. Mint OS-user-scoped in-memory session
   keys bound to client instance, host epoch, origin, and permission profile;
   expire, rotate, and revoke them on reconnect/restart, elevation, and
   disconnect. Delete stale compatibility credential files. Apply the same
   cutover to `getRemoteConnectionInfo()` and the toolbar IPC handler:
   authorize sender/window ownership and the UI pairing action before creating
   a pending record; return only its non-secret handle/challenge payload to
   preload or renderer.
10. Split WebSocket RPC authorization from capability dispatch. Define an
    explicit low-risk compatibility allowlist and a deny-by-default unknown
    method policy. Require a separately approved short-lived
    `legacy-high-risk` authorization for `evalJS`, terminal control, tab
    mutations, screenshot capture, cursor/agent mutations, chat push, and
    inspection/sidebar/ruler controls. Generic pairing/session possession,
    runtime binding, or MCP attachment cannot satisfy that authorization.
11. Protect `/api/remote-info` and `/api/qr` before generating responses.
    Replace raw-token/token-bearing URL payloads with the non-secret pairing
    handle plus enrollment challenge only; the handle/challenge alone cannot
    mint a session. The dedicated exchange requires fresh client proof and
    explicit trusted-toolbar approval, consumes the handle once, and sets only
    an authenticated HttpOnly session. Redact tokens from HTML, JSON, QR,
    redirects, referrers, logs, and errors, remove wildcard CORS, and require
    an explicit origin allowlist. Authorize `/api/screenshot` before calling
    `captureScreenshot()`.
12. Add route and credential tests in `bridge-capability-enforcement.test.ts`:
    in explicit LAN mode, missing and forged credentials must reject for every
    normal route (`/status`, `/api/lan-ips`, `/api/remote-info`, `/api/qr`,
    `/api/screenshot`, `/`, `/mobile`, `/remote`) before response generation;
    the sole `/api/pairing/exchange` exception must reject handle-only,
    missing/invalid challenge proof, mismatched binding, unapproved client,
    stale, and replayed requests, and must issue one HttpOnly session only
    after explicit approval. Remote-info/QR responses must never be public or
    contain raw token material; screenshot host spies must remain untouched on
    rejection. Add tests that persisted bridge metadata has no secret, writes
    are atomic when metadata is retained, handles/challenges are non-secret and
    single-use, session keys expire/rotate/revoke, generic sessions cannot
    invoke high-risk RPC, unknown methods fail closed, and WebSocket
    authentication does not authorize HTTP. Add a same-user file-read
    regression proving the persisted path contains no usable credential.
13. Add `toolbar-remote-info-ipc.test.ts` coverage for unauthorized senders,
    wrong-window senders, and missing UI permission; each must fail before
    pending-record creation. An authorized toolbar request may return only
    non-secret metadata, an opaque handle, and an enrollment challenge. Assert
    the IPC result, preload payload, rendered QR, rendered URLs, and copied link
    contain no bearer token, session key, or token-bearing URL; assert
    handle-only and identifier-only exchange cannot create a session, while a
    fresh approved client proof creates exactly one HttpOnly session; and prove
    no renderer path can reconstruct a raw credential.

## Mandatory MCP rejection scenarios

For both `AntiFanMcpServer.callTool()` and the OMP stdio adapter:

- Call with no transport context: `MCP_CONTEXT_REQUIRED`; zero host calls.
- Call with lease/project/workspace but no attachment: `ATTACHMENT_REQUIRED`;
  zero host calls.
- Valid attachment plus forged `runId`, `attemptId`, project, workspace, grant,
  tab, or browser epoch: typed mismatch; zero host calls.
- Valid attachment plus an old same-document expected generation:
  `TARGET_STALE`; zero host calls.
- Valid attachment after expiry, revocation, cancellation, terminal state, or
  host epoch change: typed stale/replay error; zero host calls.
- Valid attachment from another process/session: `PROCESS_MISMATCH`; zero host
  calls.
- OMP proxy without the scoped bootstrap: typed unavailable/context-required
  error before `readBridge()`, websocket creation, or MCP capability-server
  startup; zero Bridge and host calls. This explicit disabled state must not
  send `openTab` or `antifan.agent*` legacy RPCs and is not an internal-adapter
  fallback.
- Bridge capability method with omitted context: reject; unrelated legacy RPC
  behavior is tested separately and cannot be reached through MCP.
- HTTP request with no credential, a query-only token, a mismatched token, a
  stale pairing reference, a replayed pairing reference, or a disallowed
  origin: typed unauthorized response; zero sensitive response generation and
  zero host calls.
- In explicit LAN mode, missing and forged credentials reject independently for
  `/status`, `/api/lan-ips`, `/api/remote-info`, `/api/qr`, `/api/screenshot`,
  `/`, `/mobile`, and `/remote`; `/api/remote-info` and `/api/qr` remain
  non-public and contain no raw token or token-bearing URL.
- HTTP `/api/screenshot` with invalid authorization: reject before
  `captureScreenshot()`; the host spy must remain untouched.
- HTTP `/api/lan-ips`, `/api/remote-info`, `/api/qr`, HTML, redirects, and
  errors must not expose raw Bridge tokens or token-bearing URLs.
- WebSocket-authenticated state alone must not authorize a separate HTTP
  request; each request is independently authenticated and authorized.
- Renderer IPC request from an unauthorized sender, wrong window, or without
  the permitted UI pairing action: typed unauthorized response before exchange
  issuance; zero usable credentials cross Main-to-renderer IPC.
- Authorized toolbar IPC response and every preload/renderer QR, URL, or copied
  link surface contain only non-secret metadata plus an opaque, non-secret,
  short-lived transaction identifier. The identifier is not a bearer and
  cannot authorize pairing or RPC without the separate authenticated
  Main-owned proof; no raw bearer or session key appears.

## Success Criteria

- [ ] No external MCP `tools/call` path can execute a direct host switch.
- [ ] The OMP proxy has no direct `openTab` or `antifan.agent*` capability path.
- [ ] The OMP adapter test covers each declared method exactly once:
      `anti.browser.tabs.list`, `anti.browser.tabs.create`,
      `anti.browser.navigate`, `anti.browser.reload`, `anti.inspect.dom`,
      `anti.screenshot.viewport`, `anti.agent.cursor.click`,
      `anti.agent.cursor.move`, `anti.agent.cursor.type`,
      `anti.agent.cursor.scroll`, `anti.agent.cursor.hover`,
      `anti.agent.cursor.highlight`, and `anti.agent.cursor.clear`.
      Each call must reach the authoritative transport with the canonical
      envelope, and spies must prove it never calls `openTab`,
      `getRuntimeBinding`, or `antifan.agent*` directly.
- [ ] Missing, stale, forged, replayed transport invocation, stopped,
      target-mismatched, and process-mismatched contexts all fail before side
      effects in both entrypoints.
- [ ] Navigation/reload multi-step calls advance the Main document cursor and
      do not reuse a frozen generation; stale same-document expectations fail
      closed.
- [ ] Catalogue-backed names and aliases have identical grants and errors.
- [ ] Bridge capability methods cannot bypass MCP/transport enforcement.
- [ ] `tools/list` exposes only tools with an authoritative callable path.
- [ ] Error output is stable and redacted.
- [ ] The Bridge HTTP surface has loopback-default binding and an explicit LAN
  mode owned by Phase 3; every listed route enforces independent authorization
  before response generation or host capture.
- [ ] In explicit LAN mode, the bridge test sends missing and forged
  credentials to every listed route and observes rejection before sensitive
  response generation; authorized requests remain functional.
- [ ] `/api/remote-info` and `/api/qr` are not public and contain neither the
      raw Bridge token nor token-bearing URLs; any displayed pairing value is an
      opaque non-secret transaction identifier, not a bearer, and cannot mint a
      session without separate authenticated Main-owned proof. Identifiers are
      short-lived and single-use.
- [ ] Query-only token authentication is rejected; raw tokens are absent from
  URL/HTML/QR/JSON/log/error/referrer surfaces, wildcard CORS is absent, and
  allowed origins are explicit.
- [ ] `/api/screenshot` authorization is proven to occur before
  `captureScreenshot()`, including missing, forged, stale, replayed, and
  disallowed-origin cases.
- [ ] HTTP and WebSocket authentication are independently enforced; a valid
      WebSocket cannot authorize a separate HTTP request.
- [ ] `antifan:toolbar:get-mobile-remote-info` authenticates `event.sender` to
      the Main-owned toolbar window and the permitted pairing action before
      issuing a reference; unauthorized and wrong-window senders fail closed.
- [ ] `getRemoteConnectionInfo()`, toolbar IPC, preload, rendered QR/URLs, and
      copied links expose no raw Bridge bearer, session key, or token-bearing URL;
      authorized UI receives only non-secret metadata plus an opaque,
      short-lived, single-use transaction identifier. Identifier-only, stale,
      and replayed pairing attempts fail before session/WebSocket or host setup;
      only a separate authenticated Main-owned proof can complete pairing.

## Risks and rollback

Existing unit tests and perhaps internal callers rely on `new AntiFanMcpServer(
mockHost)` and direct calls. Update those callers to an explicit internal test
adapter or authoritative test transport; do not restore production fallback.
If a legacy extension needs a direct method, keep it behind its separately
authenticated compatibility protocol and document that it is not an external
CLI capability path.

The long-lived in-process MCP server and the per-attempt child CLI adapter are
not interchangeable test fixtures. Test startup hydration, server connection
envelopes, child bind-before-activation, transport-issued invocation ordering,
and bounded deduplication independently. If a supported vendor adapter cannot
prove its bootstrap or handshake, keep that external path disabled rather than
falling back to Bridge metadata, PID, active-tab targeting, or direct host RPC.
The HTTP route tests must remain separate from MCP/WebSocket tests because
WebSocket authentication cannot establish HTTP authorization. If a compatible
LAN pairing flow cannot prove short-lived exchange, raw-token redaction, and
route-level fail-closed behavior, keep LAN mode disabled rather than exposing
the current `0.0.0.0` listener.
