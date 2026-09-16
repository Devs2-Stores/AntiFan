# AntiFan Browser Desktop — Security Model

Threat model for remote content, the local bridge, artifacts, live MCP, and
the declarative plugin SDK v1. This is the authoritative record the Phase 8
review gates against; any P0/P1 finding here blocks opt-in rollout.
(Historical note: Originally drafted as Antigravity Browser Desktop; consolidated
for AntiFan Browser Desktop).

## Trust boundaries

| Boundary | Trusted | Untrusted |
|---|---|---|
| Electron main | yes | — |
| Local toolbar / sidebar renderer | yes (allowlisted `antifanToolbar`, `antifanStandalone`) | — |
| Remote page (WebContentsView) | — | arbitrary storefront JS |
| Extension bridge peer | paired session | same-OS hostile client |
| Plugins (SDK v1) | isolated safe adapter | declared-but-ungranted caps |
## Project authority (Chromium-first)

In AntiFan Browser Desktop, desktop Chromium partitions are unified and profile-owned:
each profile maps to a dedicated persistent partition (`persist:profile-${safeProfileKey}`,
with `-native` mode for clean user agents), migrated from legacy `persist:capsule-*` partitions
(managed via `src/main/browser/native-tab-host.ts` and `capsule-partition-migration.ts`). Main is the sole authority:

- No Harness process, MCP server, plugin, or renderer can launch, own,
  restart, or silently substitute Chromium. `Main` materializes runtimes
  lazily; there is no active-Project singleton and no global default
  partition fallback.
- Lease binding is explicit: Capability requests carry `lease` and `leaseToken`,
  enforcing workspace and runtime authority (`assertRuntimeLease` in
  `src/main/tools/capability-catalogue.ts`). Requests fail closed with
  `WORKSPACE_MISMATCH` or `RUNTIME_MISMATCH` if boundaries drift. Raw Electron
  objects, credentials, and base64 byte payloads never cross shared contracts;
  artifact refs are metadata only.
- Generation equality is exact: stale AND future generations both fail
  closed; run targets are immutable (no active-tab fallback). Browser epochs
  rotate on restart and invalidate every captured ref, lease, and selection.
- The legacy global trajectory/DSH path is removed; `exportLegacyTrajectory`
  returns an empty archive and existing DSH archives exist only as immutable
  legacy-reference artifacts (see `legacy:detect` / `legacy:apply` import).

## Remote content

- Every window/view uses `contextIsolation`, `sandbox`, `webSecurity`, and
  `nodeIntegration:false` (constructor-enforced; never after navigation).
- `file:` / `data:` / `javascript:` navigation and `window.open` are denied or
  routed externally via `SecurityPolicy`; permissions are deny-by-default.
- Arbitrary `eval` and raw IPC/filesystem are never exposed to a page.

## Local bridge

- OS-user-scoped transport with explicit pairing and short-lived session keys;
  monotonic sequence + nonce reject replays and flag rotation.
- Every request carries folder URI + client instance + host epoch + lease +
  deadline; `authorize` rejects expired/supplied-unknown before any side effect.
- No secrets in URLs, logs, or persisted config. Contract bundle is
  hash-verified before registration.

## Artifacts

- Staged via no-follow handles; reparse/symlink rejected; hash computed over
  the COPIED bytes; per-file and total byte budgets bound disk.
- Path traversal out of the staging root is refused.

## Live MCP

- Single-consumer lease: one of `extension | desktop | unavailable`. Mutating
  requests bind to a backend + generation and NEVER fail over after dispatch;
  ownership loss returns `BACKEND_DISCONNECTED` / `DELIVERY_UNKNOWN`.
- Stale document generation fails closed. Arbitrary evaluate is absent.
- Console/network output is redacted (secrets, cookies, auth) by default.

## MCP stdio adapter (`--mcp-server`)

Standard MCP over stdio for external agent harnesses. Trust is **spawner-only**: whoever
spawns the process can call the exposed tools — an LLM agent is a
prompt-injectable caller, so exposure is gated:

- Default surface is read/introspect only; mutating/eval/cookie tools require
  an explicit `--mcp-high-risk` flag; `terminal_run_command` and the other
  terminal-execution tools are never exposed.
- Tool calls are executed through the Project `CapabilityBroker` with an
  explicit `McpBrokerAttachment`; without a materialized Project the server
  fails closed (`mcp-broker-attachment-required`) — MCP can never launch or
  own Chromium. The in-app command security policy (deny-list for
  `haravan`/`hrv`, see `decideCommandSecurity`) applies to whatever reaches
  the broker.
- stdout carries only MCP frames (logs routed to stderr via
  `setMcpStdioMode`); the workspace must be outside the app directory
  (self-modification guard); the single-instance lock is skipped so the
  service coexists with a running GUI instance; stdin close / SIGTERM tears
  down terminal sessions and exits.
- The MCP server runs in a plain-Node child sharing the parent's fds because
  Electron main cannot read piped stdin on Windows; tool calls are proxied
  over IPC and subject to the same engine path as the in-app loop.

Exclusions: MCP Resources/Prompts are not exposed; the window is visible in
MCP mode (compositor needed for capture).

## Plugin SDK v1

- Data-only packages; manifest has NO Node entrypoint/fs/network field.
- Permission gate grants only known capabilities; never chat send/consent,
  arbitrary MCP eval, fs, net, or node execute. Deny-by-default.
- A throwing or malformed adapter disables that plugin only; the browser app
  never restarts.

## Chat delivery

- `prepared → dispatching → accepted | failed | unknown`. `unknown` requires
  explicit user reconciliation and is never auto-resent. `failed` is only
  emitted when no acceptance is proven.
- Send Now is OFF until the host empirically proves submit+ack AND a one-time
  bound consent is valid. No queued composer state is ever reported as
  submitted.

## Known accepted exclusions (Phase 8, non-blocking)

- OS named-pipe ACL transport + live `sendToAgentPanel` are not exercised in
  the test env (no provable delivery receipt); Send Now stays off.
- Code signing / auto-update infra is an external operational dependency; a
  verified local installer/manual update is used rather than weakening OS
  security prompts.