---
type: code-review
date: 2026-08-20
timestamp: "2026-08-20T08:51:24+07:00"
status: complete
scope:
  - E:/Work/apps/antifan-browser-desktop
  - E:/Work/apps/antigravity-browser
  - plans/260819-2244-harden-antifan-antigravity-sync
  - plans/260819-2334-route-antifan-chat-to-exact-antigravity-conversation
---

# AntiFan / Antigravity Deep Code Review

## Executive Verdict

The current exact-conversation Auto route is **NO-GO**. It is not installed or
runnable from the shipped artifacts, silently falls back to the active panel,
accepts receipts without adequate binding, and loses late success evidence due
to inverted deadlines. The Desktop also has three independent local trust-boundary
failures that can reach page data, PowerShell, or recursive filesystem deletion.

The proposed rule "Desktop timeout > Bridge timeout + buffer" is necessary but
not sufficient. The correct design is:

1. Propagate absolute execution and receipt deadlines through every layer.
2. Retain and verify authoritative receipts after the foreground wait expires.
3. Keep transcript observation separate from delivery authority.
4. Fail closed for exact Auto and exact abort when the exact route is unavailable.

## Review Scope and Method

- Read the Desktop, Extension, Sidecar, installer, probe, renderer, bridge,
  transcript, packaging, operations, security, and test surfaces.
- Compared the two cooked plans with current source and live machine state.
- Ran independent Desktop, Extension, and architecture reviews in parallel.
- Applied a Fable Full decision pass: competing hypotheses, concrete failure
  timelines, discriminating evidence, and adversarial attack review.
- Kept application source read-only. This report and the follow-up plan are the
  only intended workspace writes.

## Fresh Verification Evidence

| Check | Result |
|---|---|
| Desktop `npm run verify` | 26/26 tests pass; typecheck and compile pass |
| Extension `npm test` | 103/103 tests pass; compile passes |
| Extension `npx tsc -p . --noEmit` | Pass |
| Desktop `npm audit --audit-level=high` | 0 vulnerabilities |
| Extension `npm audit --audit-level=high` | 0 vulnerabilities |
| `npx @vscode/vsce ls` | Router included, imported probe module excluded |
| Sidecar installation state | No config entry and no runtime data directory |
| Plan status | Both cooked plans report 0 completed phases/tasks via `ak` |

Passing tests do not establish production safety. Several tests mock the missing
entrypoints or deliberately accept unsafe contracts such as tokenless WebSocket
connections and unsigned Sidecar results.

## Critical Findings

### C1. Tokenless local WebSocket clients receive privileged browser RPC

`src/main/bridge/bridge-server.ts:110` accepts a WebSocket connection. The token
check at `src/main/bridge/bridge-server.ts:114` rejects only when a token is
present and wrong; an absent token is accepted. The same connection can invoke
`getDOM`, `captureScreenshot`, `evalJS`, navigation, click, and typing methods,
including `evalJS` at `src/main/bridge/bridge-server.ts:291`.

Impact: any same-user process, and potentially drive-by browser content able to
reach loopback WebSocket, can inspect or control authenticated pages. This
contradicts the explicit pairing boundary in `docs/security-model.md`.

The test at `test/main/bridge-server.test.ts:62` currently locks in a tokenless
connection as valid.

### C2. Terminal output is HTML injection that can execute PowerShell

`src/renderer/terminal.ts:39` replaces ANSI escapes but does not escape HTML,
then assigns process stdout/stderr to `innerHTML` at
`src/renderer/terminal.ts:64`. `src/renderer/terminal.html` has no CSP, while
`src/preload/terminal-preload.ts:9` exposes `sendTerminalInput`.

Impact: attacker-controlled output, including repository metadata, script logs,
or remote development-server output, can render an event handler that sends an
arbitrary command to the live PowerShell process.

### C3. Assistant Markdown can execute JavaScript and recursively delete files

The code-block Copy handler at `src/renderer/sidebar.ts:542` embeds assistant
content inside an inline JavaScript template literal at
`src/renderer/sidebar.ts:553`. It escapes HTML, backticks, and backslashes, but
does not neutralize `${...}` interpolation. The generated markup enters
`innerHTML`, and `src/renderer/sidebar.html` has no CSP.

The exposed preload API permits `deleteSession` at
`src/preload/sidebar-preload.ts:38`. The IPC handler forwards an arbitrary ID at
`src/main/browser/native-tab-host.ts:472`. `TranscriptSyncer` joins the value
without containment validation at `src/main/bridge/transcript-syncer.ts:337`
and recursively removes the result at `src/main/bridge/transcript-syncer.ts:340`.

Concrete path resolution on this machine:

```text
brain + ..\..\..\Desktop => C:\Users\Admin\Desktop
```

Impact: a malicious or prompt-injected assistant code block can call the delete
API when the user clicks Copy and remove data outside the Antigravity brain
directory.

### C4. Exact Auto silently sends to the active panel when Sidecar is unavailable

`src/desktopCommandBridge.ts:277` attempts Sidecar routing only when its
heartbeat is live. If it is not live, execution falls through to the active
panel callback at `src/desktopCommandBridge.ts:286`, still carrying Auto mode.
`src/runtime.ts:819` forwards `autoSend: true` to `sendToAgentPanel`, which is an
active-panel API rather than an exact-conversation API.

Fresh reproduction with target conversation B and Sidecar offline:

```json
{"callbackCount":1,"deliveryState":"ide-api-accepted","actualRoute":"active-panel"}
```

Impact: the strongest user-visible guarantee, sending to the selected
conversation, can instead send to whichever Antigravity chat is active.

### C5. The Sidecar release path cannot start, install, or run from the VSIX

- `sidecars/antifan-chat-router/router.mjs:47` defines a class, but the file ends
  at line 372 without constructing or starting it.
- `scripts/install-sidecar.mjs` and `scripts/probe-agentapi-sidecar.mjs` export
  functions but have no CLI entrypoint; the documented `node ... --action`
  commands exit without doing the requested work.
- `.vscodeignore:7` excludes `scripts/**`, while
  `sidecars/antifan-chat-router/router.mjs:18` imports the excluded probe module.
- The package manifest has no Sidecar install/probe commands.
- The checked machine has neither the Sidecar config entry nor the expected
  runtime data directory.

Impact: the tested class can work under mocks, but the shipped operational path
cannot create a heartbeat or route a real command.

## High Findings

### H1. Conversation identity was asserted, not empirically proven

Desktop directly assigns transcript session ID as the Sidecar conversation ID
at `src/main/browser/native-tab-host.ts:1936`. The required live two-conversation
probe is not present. The report at
`plans/260819-2334-route-antifan-chat-to-exact-antigravity-conversation/research/sidecar-contract-probe.md`
states conclusions without raw commands, Antigravity version fingerprint,
heartbeat evidence, busy-target evidence, or repeated A-active/B-target results.

The phase file still contains unchecked todos and acceptance criteria even
though the plan table says Completed.

### H2. Nested relative timeouts discard valid late receipts

- Desktop foreground wait: 15 seconds at
  `src/main/browser/native-tab-host.ts:1927`.
- Extension command deadline: 20 seconds at
  `src/desktopCommandBridge.ts:54`.
- Sidecar client wait: about 19 seconds at
  `src/desktopCommandBridge.ts:281`.
- Router child deadline: 25 seconds at
  `sidecars/antifan-chat-router/router.mjs:57`.

Desktop permanently stops polling at
`src/main/bridge/antigravity-command-client.ts:313`. A real acceptance between
seconds 15 and 25 becomes `unknown`, and no durable reconciler upgrades it from
an authoritative late receipt.

### H3. Receipts are unsigned, unbound, or weakly validated across layers

`src/sidecarRouterClient.ts:167` consumes a Sidecar result without verifying its
HMAC or binding it to request ID, source command, workspace, conversation,
prompt digest, expiry, or expected Sidecar instance. It reports the cached
pre-dispatch instance rather than the receipt's instance.

Desktop validation at
`src/main/bridge/antigravity-command-client.ts:92` checks only basic field
types. Polling at line 284 does not compare the embedded command ID, workspace,
host epoch, route, or completion time with the dispatched command.

Malformed HMAC length also throws a `RangeError` at
`sidecars/antifan-chat-router/router.mjs:44`, allowing a corrupt command file to
destabilize the router loop.

### H4. Claim, invocation, crash recovery, and acknowledgement are not durable

The Sidecar claims with write-plus-unlink at
`sidecars/antifan-chat-router/router.mjs:251`, not atomic rename. Failure to
persist `isInvoking: true` is ignored at line 260, but `agentapi` is still
started. Recovery can therefore emit a definitive pre-invocation failure after
the external send already occurred.

The Extension renames commands to `.processing.*` at
`src/desktopCommandBridge.ts:259`, but restart polling excludes these files and
cleanup later deletes them without emitting `unknown`. Filename-only existence
of a result is treated as an idempotency barrier.

Desktop deletes the result file immediately after consumption at
`src/main/bridge/antigravity-command-client.ts:297`, so the producer has no
durable acknowledgement and startup reconciliation cannot rely on retained
terminal evidence.

### H5. A workspace can pre-seed an unauthenticated legacy send or abort

The Extension activates broadly, scans `cmd-*.json`, and accepts legacy command
documents at `src/desktopCommandBridge.ts:209`. It replaces their target with
the current workspace and grants a fresh expiry at line 215. A repository can
therefore include a legacy Auto send or global abort that executes after open.

For a personal tool, the simplest safe policy is to remove automatic legacy
execution rather than add another compatibility trust layer.

### H6. Exact abort is not exact and can stop the wrong conversation

Desktop dispatches abort at `src/main/browser/native-tab-host.ts:405` without a
top-level target conversation or exact route, returns success without awaiting
a receipt, and the Extension invokes global `antigravity.abort` at
`src/runtime.ts:183`.

Impact: Stop for background conversation B can stop active conversation A.
Until Antigravity exposes a scoped abort, exact abort must be rejected.

### H7. Attachment integrity and containment are declarations only

Desktop stages images in global/CWD fallback locations at
`src/main/browser/native-tab-host.ts:1828`. Attachment descriptors omit a
mandatory digest. Extension validation does not validate attachment shape,
active-panel delivery checks only file existence, and Sidecar converts the
provided path directly into a prompt reference.

There is no all-or-nothing set validation, copied-byte hash check, symlink or
reparse containment check, MIME verification, or total-byte enforcement at the
consumer boundary. Files can change between command creation and `agentapi`
read while retaining stale metadata.

### H8. Workspace and queued-conversation ownership can drift

Workspace resolution falls back to `E:\Work` or `process.cwd()` at
`src/main/browser/native-tab-host.ts:1802`, allowing command and artifact writes
outside the selected project.

Auto-follow queue entries persist with no immutable target at
`src/renderer/sidebar.ts:1418`. On restart, `isAgentWorking` begins false and the
watchdog may dispatch the queued item against whichever transcript is active
then. A prompt queued for A can be sent to B.

### H9. Transcript refresh destroys delivery metadata and source time

Main replaces the full message collection on session change at
`src/main/browser/native-tab-host.ts:131`; renderer repeats replacement at
`src/renderer/sidebar.ts:2072`. Parsed transcript messages use `Date.now()` at
`src/main/bridge/transcript-syncer.ts:648` and line 671 rather than preserving
the source timestamp.

Impact: `commandId`, route, delivery state, errors, and observation correlation
can disappear or attach to the wrong message. Transcript refresh must merge
content into a separate durable delivery overlay keyed by stable correlation.

### H10. Windows process and deadline handling can continue after `unknown`

Executable resolution accepts `.cmd` and `.bat` at
`scripts/probe-agentapi-sidecar.mjs:68`, but execution uses `shell:false`; a
normal npm-style Windows wrapper can synchronously fail with `EINVAL`.

On timeout, the router sends `SIGTERM` and immediately resolves `unknown` at
`sidecars/antifan-chat-router/router.mjs:310` without awaiting child exit or
terminating descendants. The original command expiry is not propagated to the
Sidecar child. External delivery can therefore continue after the system has
declared the foreground attempt terminal.

### H11. Installer ownership and shared-config updates are unsafe

Malformed existing config is silently replaced with `{}` at
`scripts/install-sidecar.mjs:49`. The shared config is then overwritten without
backup, compare-and-swap, or concurrent mutation detection. The manifest stores
paths but no ownership hashes, and removal deletes the matching ID even if the
entry was modified by the user or another installer.

### H12. Extension/Sidecar source is outside release version control

The parent `.gitignore` ignores the entire `apps/antigravity-browser/` directory.
The Sidecar, client, installer, tests, and package rules are not tracked by a
dedicated repository. Desktop commit `40d4a0f` claims Sidecar implementation but
contains only Desktop, plan, and documentation changes.

Impact: a passing local tree cannot be reproduced, reviewed, or shipped from
the commit that claims the feature.

### H13. MCP stdio emits ordinary logs before protocol frames

MCP mode starts the regular bridge and writes to stdout at
`src/main/index.ts:119` and line 123 before connecting `StdioServerTransport` at
`src/main/mcp/mcp-server.ts:355`. Standard clients can reject the stream. This
contradicts the stdout-only MCP frame guarantee in `docs/security-model.md`.

### H14. Site-scoped storage clearing is global and stale cookies can return

The UI promises site-only clearing, but
`src/main/browser/native-tab-host.ts:952` calls `clearStorageData` without an
origin. Cookie removals do not trigger persistence at
`src/main/browser/cookie-persister.ts:92`, while startup restoration extends
expired/session cookies for one year at line 41 and persists raw values at line
83.

Impact: clearing one site logs out every site, then stale cached sessions may be
restored after restart.

### H15. Long-running terminal descendants are not owned through app shutdown

`TerminalManager` starts PowerShell and can spawn dev-server descendants, but
`NativeTabHost.dispose` does not terminate it. Direct production launch can
leave shells or child servers holding ports after the app exits.

## Plan and Documentation Integrity Findings

- Both plan frontmatters remain `status: pending` while phase tables claim
  completion.
- `ak plan status` reports `0/5 phases, 0/26 tasks` and `0/4 phases, 0/73 tasks`.
- Phase todos and live acceptance matrices remain unchecked.
- `docs/operations.md` documents CLI commands that have no executable entrypoint.
- `docs/security-model.md` claims pairing, sandboxing, stdout-only MCP, artifact
  containment, and sender binding that current code does not enforce.

The two plans are useful design records, but they are not valid completion
evidence and should not be used as operational authority.

## Timeout and Late-Reconciliation Decision

### Competing hypotheses

| Hypothesis | Evidence | Decision |
|---|---|---|
| Increase Desktop timeout to 25-30s and promote from transcript | Fixes early hang-up, but forged/missing receipts and wrong-route observations remain | Reject as incomplete |
| Propagate absolute deadlines and reconcile retained authoritative receipts | Preserves late success without making transcript authoritative | Adopt |
| Abandon exact routing and use active panel only | Operable but violates the selected-conversation goal | Keep only as explicit Draft action |

### Recommended timeline

Use one issued-at time and explicit absolute deadlines rather than unrelated
layer constants:

```text
T0 + 18s  provider execution deadline (Sidecar/agentapi)
T0 + 22s  Extension terminal receipt deadline
T0 + 30s  Desktop foreground receipt deadline
T0 + 10m  retained signed-receipt reconciliation window, plus startup scan
```

The exact numbers are initial personal-tool defaults and should be measured, but
the ordering and absolute propagation are invariants.

### State model

```text
deliveryState:
  queued | ide-api-accepted | failed | unknown

observationState:
  none | prompt-observed | response-observed
```

Only a verified receipt fully bound to command, workspace, conversation, prompt
and attachment digests, route, Sidecar instance, and deadline may perform:

```text
unknown -> ide-api-accepted
```

Transcript may perform only:

```text
none -> prompt-observed -> response-observed
```

If a response appears without authoritative delivery evidence, render:

```text
Response observed - receipt still unknown
```

Never auto-resend an `unknown` command.

## Recommended Remediation Order

1. Kill-switch exact Auto fallback, exact abort, tokenless WebSocket, and unsafe
   renderer HTML execution.
2. Make Extension/Sidecar source reproducible, package its complete runtime
   closure, and add real install/probe/router entrypoints.
3. Run a version-fingerprinted live two-conversation probe before treating
   transcript folder IDs as `conversation_id`.
4. Implement strict receipt binding, atomic durable state transitions,
   acknowledgements, absolute deadlines, child termination, and late receipt
   reconciliation.
5. Preserve delivery overlays across transcript refresh and bind queued work,
   attachments, and workspaces immutably.
6. Close the remaining browser lifecycle, cookie, MCP, and process ownership
   regressions; then run the full live acceptance matrix.

## Unresolved Questions

1. What Antigravity-owned source is authoritative for `conversation_id` on the
   installed version, and is it restart-stable? This blocks exact-route release.
2. What precisely does `agentapi send-message` exit 0 prove on the installed
   Antigravity build? The live probe must distinguish API acceptance from
   transcript observation and first-token timing.
3. Does Antigravity expose a scoped conversation abort? Until proven, exact
   abort remains unsupported and must fail closed.
4. Are 18/22/30-second budgets sufficient on this machine under image-heavy
   load? Benchmarking may tune values but must not change their ordering.

## Final Recommendation

Continue integrating with Antigravity through the supported Sidecar route; do
not build a separate full harness or use private Antigravity RPC. For this
personal tool, the smallest robust architecture is a fail-closed Sidecar adapter,
an authenticated local bridge, a durable receipt ledger, and transcript-only
observation. The current implementation should remain disabled for exact Auto
until the live and security gates pass.
