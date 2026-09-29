# Bridge health surface — Manager status, client-failure journal, QA-gate suspension — design

Status: landed in the tree on 2026-09-28 (item S3 of the forensic-audit roadmap; S1 edit-mode
guard, S2 capture/focus, S4 run cards are specced separately). `recordBridgeFailure` and
the derived `AntiFanBridgeStatus.health`, the discovery-record publish cadence, the
launcher journal in `scripts/antifan-omp-mcp.cjs`, the `antifan:bridge:get-status` route +
`STATUS_CHANGED` push, and the chip/banner/poll surface in `src/renderer/standalone.js`
are all on disk. Code is cited by owning symbol
and file rather than by line, because these files were moving while it was written — search the
symbol.

Date: 2026-09-28

## Intent

The AntiFan bridge (`BridgeServer`, `src/main/bridge/bridge-server.ts`) is the one socket every MCP
client — the OMP coding agents embedded in the app's terminals — reaches the live browser through.
Today it can be dead for the better part of an hour and nothing in the app says so.

Evidence from the 2026-09-28 forensic audit of the Phukienmaymoc session:

- The bridge was unreachable for ~46 minutes (08:53 → 09:58, seventeen `connect-failed` attempts by
  the MCP launcher `scripts/antifan-omp-mcp.cjs`) while the Manager window gave no indication. The
  only surfaces that know anything are `BridgeServer.getStatus()` — which answers
  `{ active, port, clientCount, activeTabId, tabCount, inspecting }` and records no failure history —
  and stderr lines the user never reads.
- Worse, the failure modes are asymmetric. The launcher distinguishes "not listening" from "up but
  did not grant access" (`MCP_BRIDGE_OFFLINE` emits both sentences). A server that believes it is
  fine while every client is refused is invisible to any health model that only asks the server.
- The user-scope `theme-qa-gate` hook kept appending its QA reminder on every unmarked
  `tool_result` — roughly seventeen reminders of pure noise across the outage — because nothing told
  it the QA evidence path was dead.

The Manager is where the user already goes to see what the agents are doing (`isSharedManagerShell`,
`src/renderer/standalone.js`). This design gives it a truthful, always-visible bridge status, feeds
it the client side of the story, and silences the gate for the duration of an outage — once, not
seventeen times.

## The surface this extends (read this before the decisions)

The bridge already publishes itself to disk, and that publication is the authority this design
extends. Nothing below is a new status file.

| Existing element | Where | What it already guarantees |
| --- | --- | --- |
| `persistBridgeInfo()` | `src/main/bridge/bridge-server.ts` | Writes `{ port, host, pid, startedAt, isDev, protocolVersion, endpoints }` to `bridge.json` (dev: `bridge-dev.json`) under `process.env.ANTIFAN_CONFIG_DIR \|\| StorageLocations.getConfigDir()`, and mirrors it to `~/.gemini/antifan_bridge.json` (`_dev` variant). |
| `publishesDiscovery` | same | `port !== 0`. Ephemeral (test/probe) instances never touch the shared record; their in-process `getStatus()` still works. Reused verbatim by this design. |
| `atomicWriteManyWithDacl` | same | Temp-file + rename **and** a DACL pass per target. The health fields inherit it because they ride the same write, not a parallel one. |
| `canPublishLegacyMirror()` | same | Machine-global mirror protection: a live holder's `~/.gemini` entry is never clobbered (pid liveness, `EPERM` counts as alive). |
| `unlinkDiscoveryIfOwned()` | same | `dispose()` removes the record only if this pid wrote it, so a lost port-collision instance cannot erase the winner's entry. |
| `resolveBridgeCandidates()` | `scripts/antifan-agent.cjs` | The launcher's single candidate authority: env pin first, then `bridge-dev.json`/`bridge.json`/`antifan_bridge_dev.json`/`antifan_bridge.json` across `ANTIFAN_CONFIG_DIR`, `<ANTIFAN_DATA_ROOT>/config`, the Drive/APPDATA locations and `~/.gemini`, ranked with `isPidAlive` + `startedAt`. Additive fields only — it reads `port`/`host`/`token`/`pid`/`startedAt`/`isDev` and must keep working unchanged. |
| `getStatus()` / `BridgeStatusAnswer` | `bridge-server.ts`, `src/shared/contracts.ts` | The live in-process snapshot (`AntiFanBridgeStatus` + `activeTabRefusal`); `/status`, the WS init payload and the extension serialize it, so additions stay optional fields. |

Consequences the design accepts because of this choice:

- The readers are the *same* processes that already read the record: the MCP launcher (candidate
  authority), the Manager (new route), the QA-gate hook (file lane). One record, three readers, no
  reconciliation between competing files.
- The record is reachable from an OMP session without a new env var: `getConfigDir()` is
  `<dataRoot>/config`, and terminal-spawned sessions always carry `ANTIFAN_DATA_ROOT` (they inherit
  `ANTIFAN_CONFIG_DIR` when the app sets it).
- `startedAt` currently means "time of the last publish" — `persistBridgeInfo()` stamps `Date.now()`
  on every call, and the launcher ranks candidates with it (`compareCandidates` rule 4, "newer
  startedAt"). A 5 s heartbeat would turn that rank into a coin flip between two live instances, so
  this design **freezes `startedAt` at construction** (the process that launched later wins, which is
  what the ranking intends) and makes the new `updatedAt` the publish/heartbeat stamp. Consumers
  need no edit: `resolveBridgeCandidates` reads the field the same way, `resolveDevBridgeInfo`
  (`scripts/dev-watcher-helpers.mjs`) returns the parsed file whole and its only consumer
  (`sendBridgeAdmin`) reads `port` *and* the `token` field (`ANTIFAN_BRIDGE_TOKEN` as fallback) —
  neither is touched by these additions, and no test pins the old `startedAt` value.
- The launcher's disk *discovery* stays where it is. `resolveBridgeCandidates` is not touched
  beyond tolerating the added fields, and this design adds no second scan of the Drive/APPDATA
  locations anywhere.

## Decisions

1. **Two evidence planes, one published record.** The server knows whether it is listening and what
   it last refused; the clients know whether they can actually connect. Server health rides *in the
   discovery record `BridgeServer` already publishes* — `bridge.json`/`bridge-dev.json` under the
   config dir, plus the `~/.gemini` mirror — which gains `health`, `lastFailure` and `updatedAt`.
   There is no second status file: the launcher, the Manager and the QA-gate hook read that one
   record, so the port a client dials and the health it trusts cannot disagree. The client side is a
   journal the launcher owns (`runtime/bridge-client-failures.jsonl`) — evidence, not a second
   health authority. The rendered answer joins both: a `listening` record with fresh client failures
   is *not* reported healthy.
2. **The published record is the cross-process authority, written by the writer that already owns
   it.** `persistBridgeInfo()` keeps its ownership and its guarantees — `publishesDiscovery` gate,
   `atomicWriteManyWithDacl`, `canPublishLegacyMirror`, `unlinkDiscoveryIfOwned` on dispose — and
   gains memory and freshness: `recordBridgeFailure()` publishes on every recorded failure (the
   failure edge), a 5 s `healthTimer` heartbeat republishes while the process is healthy, and
   `updatedAt` makes staleness readable. Readers (the Manager route, the QA-gate hook inside OMP)
   decide `down` themselves from `updatedAt` freshness and pid liveness — a dead writer cannot claim
   to be alive, because the record's staleness is itself the signal. The heartbeat runs on the main
   thread deliberately: a main loop wedged long enough to go stale is a bridge that cannot serve
   sockets either, so a stale record during a capture hang is honest, not a false positive. The
   record is **additive**: `port`/`host`/`pid`/`isDev`/`protocolVersion`/`endpoints` keep their names
   and meanings, and `startedAt` narrows to a single constructor-captured value (see the consequences
   above) while `updatedAt` becomes the publish stamp — so `resolveBridgeCandidates` and every
   existing reader keep working without a change.
3. **The record stays non-secret.** `persistBridgeInfo()` is scanned for credential *field names*
   (`smoke-dual-plane-cutover-runner.cjs`, `scanBridgeInfoBody` ⇒ "persisted-secret-in-bridge-info").
   Health data rides that same write, so the scan's coverage is a claim this design depends on — and
   it was not actually covered: the scan matched the method body with
   `/private persistBridgeInfo\(\):\s*void\s*{([\s\S]*?)\n\s*}/`, which stopped matching the moment
   the method became `async … : Promise<void>`, so it could not produce a finding for any body
   content. The scan now locates the body by brace matching over string-and-comment-blanked source
   and fails with `bridge-info-scan-unavailable` when the method cannot be found, so a rename fails
   the gate instead of retiring it silently. The scan is name-based, so the guarantee does not rest on
   it alone: `lastFailure.message` is a **fixed server-side string chosen per `code`**, never echoed
   client input, never a token, URL secret, pairing code or origin string. `health`, `lastFailure`,
   `heartbeatMs` and `updatedAt` are the only fields added.
4. **One banner for the whole surface, a chip that is always there.** Every `standalone.js` surface
   (project sidebars, the shared Manager, terminal popouts) paints a compact chip in its header.
   Exactly one `#bridgeHealthBanner` element per window exists while the report is unhealthy —
   keyed by id, never per row, never duplicated across `renderTabs` passes. Dismissal persists
   across pushes for the same failure signature and lapses the moment the signature changes.
5. **`sidebar`/`terminalPopout` surfaces only.** The invoke route `antifan:bridge:get-status` is
   refuse-by-construction everywhere else. The toolbar already owns a different health surface
   (`antifan:core-health:get-state`, Super Core context-bridge telemetry — not the MCP socket), and
   this spec adds no toolbar widget; a `tab` page must never read app-internal state. The surface
   allowlist matches the files that can legitimately render it: `standalone.js`/`standalone.html`/
   `standalone-preload.ts` are exactly the `sidebar`+`terminalPopout` bundle
   (`fileSurfaceMap`, `test/main/chrome-ipc-routes.test.ts`).
6. **The gate suspends on evidence, not on one file.** The QA-gate hook's repo source is
   `src/omp-hooks/theme-qa-gate.ts` (installed by `scripts/install-omp-hooks.mjs` as
   `~/.omp/agent/hooks/post/antifan-theme-qa-gate.js`; the generated copy replaces the legacy
   `theme-qa-gate.ts`). It suspends when the bridge record reads down-or-stale *or* when an observed
   `tool_result` carries a launcher failure code (`MCP_BRIDGE_OFFLINE`, `BRIDGE_UNREACHABLE`,
   `CONNECTION_FAILED`, `PAIRING_UNAVAILABLE`). The second source matters because AntiFan MCP calls
   arrive as generic `write`/`read` tool calls with `input.path = "xd://mcp__antifan_browser_*"` —
   tool-name filtering cannot see them, but their failure text flows through `tool_result` content
   the hook already scans. While suspended it emits exactly one notice per outage and resumes on
   recovery; it never auto-declares `QA_UNAVAILABLE`, which stays the agent's own attestation
   (`BYPASS_TOKENS`). The suspension lives inside the unscoped lane only: `tool_result`/`context`
   already open with `if (SCOPED_MODES.includes(sessionMode(ctx))) return undefined;` — a scoped
   (Direct/Super-Fast) session is silent by the S1 contract, `turn_end` states the skip, and a
   bridge outage changes nothing about that silence.
7. **A dedicated push channel, not a piggyback.** Bridge health rides its own event
   `antifan:bridge:status` rather than growing the `antifan:terminal:session` projection: that
   payload is re-derived per window by `terminalStateForWindow` and fires on session mutations, so a
   health change between mutations would either be delayed or force a spurious session emit. Push
   covers transitions; a 10-second renderer poll covers the time-window decay (a degraded report
   ageing back to listening, a client-failure window closing) that no event fires for.

## The gap this design closes

`BridgeServer.getStatus()` reports a live snapshot with no memory: `active` is hardcoded `true`, and
every refusal the server issued — a burned pairing code, a rejected token, a socket that died — is
gone the instant it was answered. The client side is equally silent: `rememberAutohealFailure`
(`scripts/antifan-omp-mcp.cjs`) keeps the last few causes *in the launcher's own memory* and writes
them only to stderr. Neither artefact reaches a renderer, and no IPC channel carries bridge status
to the chrome at all today (`antifan:core-health:get-state` is a different bridge). The design adds
memory on both sides and one place that reads them together.

## Architecture

Six components, in the order one failure travels from socket to screen.

### 1. Failure bookkeeping and health state in `BridgeServer`

(`src/main/bridge/bridge-server.ts`; types in `src/shared/contracts.ts`.)

- **`BridgeFailureRecord`** (`contracts.ts`): `{ code: string; message: string; at: number }`.
- **`BridgeHealthState`** (`contracts.ts`): `'listening' | 'degraded' | 'down'`.
- **`AntiFanBridgeStatus`** gains `health: BridgeHealthState` and `lastFailure?: BridgeFailureRecord`.
  `active` keeps today's meaning — the WS init payload (`setupWssEvents`) and `/status` serialize
  this shape to agent and extension clients, so the extension is additive-only.
- New private fields: `lastFailure: BridgeFailureRecord | null`, `listening: boolean`,
  `healthTimer: NodeJS.Timeout | null`, `readonly startedAt = Date.now()`, plus
  `recordBridgeFailure(code, message)` — sets `lastFailure`, recomputes state, publishes the
  discovery record (see below) and emits on the health event channel (component 6).
- **Recording points** — every place the server refuses or loses a *real* client attempt:
  - `start()` listen error: `EADDRINUSE` records `LISTEN_EADDRINUSE` *before* the port-0 retry —
    the rebind recovers the server but every pinned client now fails, which is exactly the degraded
    story; the alt-server `error` handler records `LISTEN_FAILED` and rejects as today.
  - `rebindListener()`'s `newServer.once('error', reject)` records `LISTEN_REBIND_FAILED`.
  - `setupWssEvents` `ws.on('error')` records `CLIENT_SOCKET_ERROR` alongside the existing
    `clients.delete(ws)`.
  - The connection handler's `ws.close(4001|4003, …)` refusals record `WS_AUTH_REFUSED` with the
    close reason verbatim (`SECRETS_IN_URL_FORBIDDEN`, missing/invalid token, LAN disabled,
    untrusted/malformed origin).
  - The pairing-exchange and attachment-verify 4xx paths that carry an availability `error` code
    record `PAIRING_REFUSED` with that code (`PAIRING_CODE_NOT_FOUND`, `PAIRING_CODE_REVOKED`,
    `PAIRING_CODE_ALREADY_USED`, `PAIRING_CODE_EXPIRED`, `PAIRING_ATTEMPTS_EXCEEDED`,
    `PAIRING_CLIENT_*_MISMATCH`, `PAIRING_GRANT_*`, `CHALLENGE_QUEUE_DEPLETED`, `EXPIRED_GRANT`,
    invalid/expired attachment secret).
  - Request-shape 400s (`INVALID_JSON_BODY`, `INVALID_PAIRING_REQUEST`, `INVALID_CLIENT_CLASS`)
    deliberately do **not** record: they describe a malformed request, not a refused client, and a
    scanner spraying garbage at the port must not keep the banner lit.
- **`message` is composed server-side, per code** — a fixed phrase like
  `'pairing code already used'`, never the client's own text. The record is non-secret by contract
  and is mirrored to `~/.gemini`; a refusal that echoed a token, an origin header or a code would
  leak into a file other tools read (decision 3).
- **State derivation** is computed, never stored: `down` when `isDisposed` or the listener is not
  bound; `degraded` while `lastFailure` is inside `BRIDGE_FAILURE_RECENCY_MS` (120 000 ms — the same
  window the client-failure journal uses, so both halves of the report decay together); otherwise
  `listening`. `listening` is set in the `start()`/`rebindListener()` listen callbacks and cleared
  in `dispose()` and on a rejected bind.
- `getStatus()` returns the extended shape; `dispose()` clears `healthTimer` next to the existing
  `heartbeatTimer` cleanup, stops the heartbeat, and publishes the final `down` record before
  `unlinkDiscoveryIfOwned()` removes it (order matters: a reader that arrives in between sees `down`,
  never a stale `listening`).
- **The record's new fields ride `persistBridgeInfo()`.** The write keeps `port`/`host`/`pid`/
  `isDev`/`protocolVersion`/`endpoints` byte-for-byte, changes `startedAt` from `Date.now()` to the
  constructor-captured `this.startedAt` (frozen instance birth; the launcher's ranking becomes
  deterministic — see the consequences), and adds `health`, `lastFailure`, `heartbeatMs` and
  `updatedAt: Date.now()`:
  - on every `recordBridgeFailure()`,
  - on the listen-success transition of `start()` (the existing 1500 ms past-first-paint publish on
    both of its listen callbacks is reused) and of `rebindListener()` (which today publishes
    immediately, inside its `listen` callback, with no deferral — and keeps doing so: it runs after
    first paint by construction, so a delay there would only make the record lag a live rebind),
  - every `BRIDGE_HEALTH_HEARTBEAT_MS` while the process lives (`healthTimer`), which is what makes
    `updatedAt` a liveness signal rather than a change log,
  - once on `dispose()` with `health: 'down'`.
  `canPublishLegacyMirror` still decides whether the `~/.gemini` mirror is written; the heartbeat
  does not lift that protection, so a live holder's mirror entry survives a second instance's beats.
  The record's `health` field is written from the live derivation above, so a heartbeat after the
  120 s recency window naturally republishes `listening`.

### 2. `src/main/bridge/bridge-health.ts` (new module)

One module owns the *reading* rules and the composite answer so the route, the pusher, the tests and
the QA-gate hook share one definition. It owns no writer: the record is written by `BridgeServer`,
the journal by the launcher.

- **Constants:** `BRIDGE_HEALTH_HEARTBEAT_MS = 5000`, `BRIDGE_FAILURE_RECENCY_MS = 120_000`,
  `BRIDGE_HEALTH_STALE_MULTIPLIER = 3`, `BRIDGE_CLIENT_FAILURE_WINDOW_MS = 120_000`,
  `BRIDGE_CLIENT_FAILURE_JOURNAL_MAX_BYTES = 256 * 1024`, `BRIDGE_CLIENT_FAILURE_TAIL_BYTES = 32 * 1024`.
  `BRIDGE_HEALTH_HEARTBEAT_MS` and `BRIDGE_HEALTH_STALE_MULTIPLIER` are the two values the hook
  duplicates inline (component 6); `BRIDGE_FAILURE_RECENCY_MS` is the one the server imports.
- **Paths:**
  - `bridgeInfoPath()` → the writer's own rule, unedited:
    `path.join(process.env.ANTIFAN_CONFIG_DIR || StorageLocations.getConfigDir(), isDev ? 'bridge-dev.json' : 'bridge.json')`.
    The Manager answers about *this* process's record; it never scans the launcher's Drive/APPDATA
    candidate list, because a second scanner is a second authority.
  - `bridgeClientFailuresPath()` → `path.join(StorageLocations.getRuntimeDir(), 'bridge-client-failures.jsonl')`.
- **Record shape** (existing fields unchanged, new fields appended):

  ```json
  {
    "port": 20129,
    "host": "127.0.0.1",
    "pid": 1234,
    "startedAt": 1759…,
    "isDev": false,
    "protocolVersion": 1,
    "endpoints": { "pairingExchange": "…", "pairingChallenge": "…", "status": "/status", "mobile": "/mobile", "ws": "/" },
    "health": "listening",
    "lastFailure": { "code": "PAIRING_REFUSED", "message": "…", "at": 1759… },
    "heartbeatMs": 5000,
    "updatedAt": 1759…
  }
  ```


- **Readers:**
  - `readBridgeInfo(file?)` → parsed discovery record or `null`; never throws.
  - **Two names, on purpose.** The record's `health` is the writer's self-report (`listening`/
    `degraded`/`down`, the same vocabulary as `AntiFanBridgeStatus.health`); the report's `state` is
    the *evaluated* verdict and may contradict it — a record saying `listening` with a stale
    `updatedAt` or a dead pid evaluates to `state: 'down'` with a `reasonCode`. Consumers read
    `state`; only the record carries `health`.
  - `isPidAlive(pid)` → `process.kill(pid, 0)`: `ESRCH` ⇒ dead, `EPERM` ⇒ alive (alive but
    uninspectable is not down; freshness carries the answer instead). Any other throw ⇒ treated
    dead-but-flagged via `updatedAt` staleness rather than a direct verdict.
  - `evaluateBridgeHealth(record | null, now)` → `{ state, reasonCode }`:
    `HEALTH_RECORD_ABSENT` when no record; `HEALTH_PID_DEAD` when the recorded pid is gone;
    `HEALTH_STALE` when `now - updatedAt > 3 * (record.heartbeatMs || BRIDGE_HEALTH_HEARTBEAT_MS)`;
    `HEALTH_RECORD_CORRUPT` when the record exists but does not parse (fail-closed — the writer is
    atomic, so an unparseable record is damage, not a partial read); `HEALTH_RECORD_LEGACY` when the
    record parses but has no `health`/`updatedAt` (written by a build older than this change: a live
    pid then answers `degraded`, not `listening`, because nothing has republished since the upgrade —
    a restart publishes within one heartbeat — and a dead pid answers `down`/`HEALTH_PID_DEAD`);
    otherwise the record's own `health`.
  - `readRecentClientFailures(file?, now, windowMs)` → reads at most the last
    `BRIDGE_CLIENT_FAILURE_TAIL_BYTES` of the journal, parses line-wise skipping malformed rows, and
    returns `{ count, latestAt, latest }` for rows inside the window.
  - `buildBridgeHealthReport(now)` → `BridgeHealthReport` (`contracts.ts`): the live
    `BridgeServer.getInstance()?.getStatus()` fields (or a synthesized `{ active: false, … }` when
    the server has not been constructed yet — the deferred start, `startBridgeAndIpc` in
    `src/main/index.ts`, means this is a normal boot state, not an error), plus `state` + `reasonCode`
    + the resolved `lastFailure` from `evaluateBridgeHealth(record, now)`, plus `clientFailures` from
    `readRecentClientFailures()` and the record it judged. **Field ownership is explicit, because
    getStatus() already carries a `health`**: that field and the record's `health` are the *writer's
    self-report* (the live process saying what it thinks it is), while `state` is the *evaluated*
    verdict — so a `health: 'listening'` with a dead pid is reported as `state: 'down'`, and no
    consumer reads the verdict out of `health`. Two rules keep the record honest against the live
    process:
    - **Same pid ⇒ prefer memory.** When the record's `pid` is this process and the instance exists,
      the in-process derivation is the answer; the record is only its durable projection, and a
      mid-heartbeat file can lag by up to `BRIDGE_HEALTH_HEARTBEAT_MS`.
    - **Different or absent pid ⇒ the record rules.** Then `evaluateBridgeHealth` wins, so a *dead*
    server can never report itself `listening` and an absent instance (deferred start, or a previous
    run's clean-exit `down` record) reports `down`, never `active: true`.
    The report also carries `bridgeRecord: { present, stale, updatedAt }` and
    `clientFailures: { count, latestAt, latest }`.
- **Event channel:** `subscribeBridgeHealth(listener)` / `emitBridgeHealthChanged()` — a tiny
  module-level emitter `BridgeServer` fires after every `recordBridgeFailure` and listen/dispose
  transition. Module-level, not server-level: `NativeTabHost` wires its fan-out once at construction
  while the bridge instance only exists after the ~1.5 s deferred start, and a subscription on the
  server object would either miss that window or force a re-wire.

### 3. Client-failure journal in the launcher

(`scripts/antifan-omp-mcp.cjs`.)

- `recordClientFailure(code, message)` appends one JSON line to `bridgeClientFailuresPath()` —
  `<ANTIFAN_DATA_ROOT>/runtime/bridge-client-failures.jsonl`, derived from
  `process.env.ANTIFAN_DATA_ROOT` only, so the Manager and the QA-gate hook resolve the same path by
  the same rule (`StorageLocations.getRuntimeDir()` is `<dataRoot>/runtime`). The journal is the
  *client* plane: fresh rows never override the server's own record, they annotate it. The launcher
  journals *only* when it inherited the app's data root: terminal-spawned OMP sessions carry it
  (`TerminalManager` injects `ANTIFAN_DATA_ROOT` next to
  `ANTIFAN_TERMINAL_SESSION_ID`/`ANTIFAN_BRIDGE_*`), hand-invoked or foreign proxies do not — the
  same boundary `hasTerminalInstanceContext()` already draws for discovery. No env ⇒ no file, no
  probing of the app's directories.
- Row: `{ at, code, message, terminalSessionId, pid }` with `terminalSessionId` from
  `process.env.ANTIFAN_TERMINAL_SESSION_ID` — the field that lets the banner say *which* terminal's
  agent is failing.
- **Hook points** — the code paths that already emit `MCP_BRIDGE_OFFLINE` or per-candidate
  connect failures, so the journal can never disagree with what the user could grep:
  - `autohealSession()` zero-candidate branch (`BRIDGE_NOT_RUNNING`),
  - each per-candidate catch in `autohealSession()` (`CONNECT_FAILED` + the candidate's own reason —
    the "17 connect-failed" series is the signal, journaled at its real granularity),
  - the terminal `MCP_BRIDGE_OFFLINE` write after all candidates failed (code
    `MCP_BRIDGE_OFFLINE`, message = `composeAutohealCause()`),
  - the no-bootstrap post-autoheal `MCP_BRIDGE_OFFLINE` + `MCP_CONTEXT_REQUIRED` throw,
  - the TTY/early-exit `MCP_BRIDGE_OFFLINE` in the `require.main` block.
- **Bound:** before appending, a file larger than `BRIDGE_CLIENT_FAILURE_JOURNAL_MAX_BYTES` is
  renamed to `bridge-client-failures.jsonl.1` (one backup generation, the rotation shape
  `main-lifecycle-log.ts` uses) and a fresh file started. Journal writes are best-effort telemetry —
  any failure is swallowed; the launcher must never lose a real reconnect for its own log line.
  Malformed or torn lines from concurrent appenders are skipped by the reader.
- Exported (`module.exports`) for tests: `recordClientFailure`, `bridgeClientFailuresPath`.

### 4. Route and push

(`src/shared/contracts.ts`, `src/main/browser/native-tab-host.ts`.)

- **`BRIDGE_CHANNELS`** (`contracts.ts`): `GET_STATUS = 'antifan:bridge:get-status'`,
  `STATUS_CHANGED = 'antifan:bridge:status'`.
- **Route:** a `CHROME_ROUTES` entry `channel: BRIDGE_CHANNELS.GET_STATUS`,
  `surface: ['sidebar', 'terminalPopout']`, `run: () => buildBridgeHealthReport()`. No `sessionArgs`
  (it names no session) and no answer-shape refusal: a bridge that does not exist is a *report* of
  `state: 'down'`, never a throw — the renderer distinguishes "bridge down" from "IPC broken" by
  getting a well-formed payload back. `ChromeSurfaceMismatchError` refuses toolbar/tab/frameBackdrop
  senders and `UnknownChromeSenderError` refuses non-chrome senders in the router, unchanged.
- **Push:** inside `setupTerminalSubscriptions()` (`native-tab-host.ts`), a
  `subscribeBridgeHealth` handler — tracked in `terminalSubscriptionReleases` so the host's
  `dispose()` releases exactly its own — that sends `BRIDGE_CHANNELS.STATUS_CHANGED` with
  `buildBridgeHealthReport()` to `this.shell.sidebarView.webContents` and to every live
  `terminalWindows` entry, the same fan-out shape `onTerminalSession` uses
  (`safeSendWebContents` in both places). Events fire on transitions only; heartbeat writes emit
  nothing.

### 5. Renderer

(`src/preload/standalone-preload.ts`, `src/renderer/standalone.js`.)

- **Preload:** `getBridgeStatus()` → `ipcRenderer.invoke(BRIDGE_CHANNELS.GET_STATUS)`;
  `onBridgeStatus(cb)` → `ipcRenderer.on(BRIDGE_CHANNELS.STATUS_CHANGED, …)` returning an
  unsubscribe, the shape `onTerminalPopoutChanged` already uses. The push channel is a listener
  channel, not a route — the audit test only checks renderer-referenced channels against registered
  *routes*, so it needs no `CHROME_ROUTES` entry (precedent:
  `antifan:terminal:popout-state-changed`).
- **Chip:** `renderBridgeChip(report)` creates `#bridgeHealthChip` once — inline-styled like
  `showTerminalNotice`'s element so it survives a stylesheet that predates it — prepended into
  `header .header-actions`. Content: `● Bridge` with port + client count in the tooltip and
  `lastFailure.code` when degraded/down. Clicking re-invokes `getBridgeStatus`. Always rendered,
  including `listening` — an absence that meant "probably fine" is exactly the blind spot this
  spec removes.
- **Banner:** `renderBridgeBanner(report)` maintains exactly one `#bridgeHealthBanner`, inserted
  once as the first child of `main.standalone`, `role="alert"`. Shown while
  `report.state !== 'listening' || report.clientFailures.count > 0`, and only then:
  - `down` → `Bridge MCP không hoạt động — agent không thể điều khiển trình duyệt (<reasonCode/code>)`;
  - `degraded` → `Bridge MCP đang suy giảm — <lastFailure.code>`;
  - listening but `clientFailures.count > 0` → `<count> MCP client kết nối thất bại trong 2 phút
    qua — server vẫn đang lắng nghe` (+ the latest row's `terminalSessionId` when present).
- **Dismissal:** a close button stores a signature in `localStorage`
  (`antifan.bridgeHealth.dismissed`). The signature is `state | lastFailure.code | hasClientFailures`
  — no timestamps — so a dismiss persists across every re-render and push of the *same* condition
  and lapses the instant the state moves, a different failure code arrives, or client failures start
  or stop. Recovery to `listening` removes the banner and clears the stored signature outright.
- **Poll:** `setInterval(refreshBridgeStatus, 10_000)`, started in `bootstrapTerminalState` and
  cleared on unload — the decay half of the contract: nothing emits when `degraded` ages into
  `listening` or the 2-minute failure window empties, so the poll is what clears a stale banner
  and what notices a journal filling while the server stays quiet. `document.hidden` gates nothing;
  the invoke is a local read.

### 6. QA-gate suspension

(`src/omp-hooks/theme-qa-gate.ts` — the repo source `scripts/install-omp-hooks.mjs` generates to
`~/.omp/agent/hooks/post/antifan-theme-qa-gate.js`. The hook's installable set is `src/omp-hooks/**`;
it already imports `./edit-mode` for the scoped-mode check, so this design adds no `src/main` import
— the health constants are duplicated inline and pinned by test.)

- **New state:** `let bridgeOutageKey: string | null` — null when not suspended — reset in the
  `session_start` handler beside `sessionModes.clear()`/`mcpFirstInjected`. No mode-cache
  interaction: appending `antifan-bridge-*` entries moves the branch tail, so `sessionModes`
  re-derives on the next call and re-finds the same `antifan.edit-mode` latch — correct by
  construction, no invalidation hook.
- **`bridgeOutageEvidence(content, now)`** returns `{ down: boolean; code: string; key: string }`:
  - *Record lane:* only when `process.env.ANTIFAN_DATA_ROOT` is set — a plain OMP session outside the
    app must behave exactly as today, including performing no file probes. Resolves the config dir
    the way the writer does — `process.env.ANTIFAN_CONFIG_DIR || <ANTIFAN_DATA_ROOT>/config` — and
    reads `bridge-dev.json`, then `bridge.json` (the hook cannot know `isDev`), preferring the record
    with the newest `updatedAt` whose `pid` is alive. It never scans the launcher's Drive/APPDATA
    candidate list and never touches `~/.gemini`: the hook reads the one record its own app instance
    wrote, not the machine's ambient state. Applies the component-2 rules inline — the hook's
    installable set is `src/omp-hooks/**`, never `src/main`, so `BRIDGE_HEALTH_HEARTBEAT_MS` and
    `BRIDGE_HEALTH_STALE_MULTIPLIER` are duplicated deliberately and
    `test/unit/theme-qa-gate-hook.test.mjs` pins them against `src/main/bridge/bridge-health.ts`.
    Key = `pid` + the record's `health`/`reasonCode`.
    Honest limit, and why the observed lane exists: if the session did not inherit the app's
    `ANTIFAN_DATA_ROOT`/`ANTIFAN_CONFIG_DIR` (a foreign instance's config dir, a hand-invoked
    session), no record is found and this lane answers not-down rather than guessing.
  - *Observed lane:* `contentText(content)` — the flattening the hook already owns — matched for
    `MCP_BRIDGE_OFFLINE`, `BRIDGE_UNREACHABLE`, `CONNECTION_FAILED`, `PAIRING_UNAVAILABLE`. AntiFan
    MCP calls surface as generic `write`/`read` tool calls against `xd://mcp__antifan_browser_*`
    paths, so their failure text is observable here even though no tool name says "bridge". Key =
    the first matched marker. This lane is what suspends the gate during a "server listening, every
    client refused" outage — the server's own record can still read `listening`.
- **`tool_result` handler, ahead of the reminder block but after the scoped-mode early return**
  (`if (SCOPED_MODES.includes(sessionMode(ctx))) return undefined;` — scoped sessions deliver no
  suspension notice by contract): evaluate the evidence on the current content plus the bridge
  record. If `down`:
  - `bridgeOutageKey !== key` → set it, push **one** chunk:
    `[theme-qa-gate:bridge] QA gate suspended: bridge down (<code>) — declare the QA_UNAVAILABLE
    status explicitly when closing work; reminders resume when bridge health recovers.`
    The notice names the status without reproducing the `qaStatus:` declaration shape, the same
    discipline `reminderText()` already keeps. Audit: `bypassLog.push({ token:
    'QA_GATE_SUSPENDED', …code })` in memory and `pi.appendEntry('antifan-bridge-suspension',
    { key, code, at })` for durability. `appendEntry` is the verified persistence primitive
    (`src/omp-hooks/edit-guard.ts` declares and uses it) but this hook's own `HookAPI` declares only
    `on`/`sendMessage`, so the write is a **required prerequisite**: extend `HookAPI` in
    `src/omp-hooks/theme-qa-gate.ts` with `appendEntry?(customType, data)`, keep the call optional
    (`pi.appendEntry?.(…)`) so a host without it degrades to the in-memory log, and add the same
    method to the lane's fake `pi` (`test/unit/theme-qa-gate-hook.test.mjs`) so the assertion is not
    an `undefined is not a function` in the only lane that runs this hook.
  - `bridgeOutageKey === key` → the outage is already announced: skip the pending-edits reminder
    **and** the MCP-first injection (it directs the agent at tools that cannot answer), still drain
    churn hints, still let `tool_call` arm `pendingEdits` — suspension silences reminders, it does
    not blind the gate to edits it will enforce after recovery.
  - If `down` is false and `bridgeOutageKey` is set → clear it, push one
    `[theme-qa-gate:bridge] bridge recovered (<code>) — QA gate reminders resumed` chunk, append a
    matching `antifan-bridge-resumed` entry. Missed reminders are never backfilled.
- The `context` handler gets the same suspension check in the same position — after its own
  `SCOPED_MODES` early return, in front of its MCP-first injection — for the symmetric reason.

## Data flow: one outage

1. The listener dies (or every candidate is refused at boot). `BridgeServer` records
   `LISTEN_FAILED`/`PAIRING_REFUSED` → `recordBridgeFailure` → `persistBridgeInfo()` republishes the
   discovery record with `health: 'degraded'`, `lastFailure` and a fresh `updatedAt` (atomic, DACL,
   mirror protection intact) + `emitBridgeHealthChanged`.
2. Each host's subscription pushes `antifan:bridge:status` with `buildBridgeHealthReport()` to its
   sidebar and popouts; the Manager's `renderBridgeBanner` mounts the one banner, chips go red in
   every standalone surface.
3. Meanwhile the OMP-side launcher fails: `autohealSession()` appends `CONNECT_FAILED` rows per
   candidate and a final `MCP_BRIDGE_OFFLINE` row to `bridge-client-failures.jsonl` with the
   terminal's session id. The Manager's next poll (≤10 s) folds `clientFailures` into the banner —
   including the "server says listening" case the server-side record cannot see.
4. Inside the OMP session, the next `tool_result` hits the gate's evidence check: record
   stale/down or a failure marker in content → one suspension notice, then silence; the remaining
   sixteen tool_results of the Phukienmaymoc outage produce nothing. `pi.appendEntry` persists both
   edges of the outage.
5. The bridge returns: listen success publishes a fresh `listening` record, the push clears chips and
   the banner, and the gate's next `tool_result` emits one resume notice and restores reminders —
   including for edits armed during the outage, which `pendingEdits` never dropped.

## Error handling & fail-closed rules

| Condition | Behaviour |
|---|---|
| Bridge not constructed yet (deferred-start window) | `buildBridgeHealthReport` synthesizes `{ active: false, state: 'down', reasonCode: 'BRIDGE_NOT_STARTED' }` from the absent instance plus whatever the previous run's record says — a report, never a throw. A clean-exit record already reads `down`, so the chip may show red through the ~1.5 s until `start()` publishes `listening`; truthful, and it self-clears on the first push. |
| Discovery record absent | Readers answer `down`/`HEALTH_RECORD_ABSENT` — absence is information because a live bridge republishes on a heartbeat. The QA gate's record lane additionally requires `ANTIFAN_DATA_ROOT`: no env, no read, no suspension. |
| Record written by a build older than this change (no `health`/`updatedAt`) | Parses, so it is not corrupt: `evaluateBridgeHealth` answers `HEALTH_RECORD_LEGACY` — alive pid ⇒ `degraded`, dead pid ⇒ `down`/`HEALTH_PID_DEAD`. A legacy record must never read as `listening` (nothing has republished since the upgrade, so its liveness is unknowable) and must never read as corrupt damage. A restarting bridge republishes `listening` within one heartbeat. |
| Discovery record corrupt or unparsable | `down`/`HEALTH_RECORD_CORRUPT`. The writer is atomic, so a parse failure is never a torn read. |
| Recorded pid dead (`ESRCH`) | `down`/`HEALTH_PID_DEAD` regardless of `updatedAt` — a fresh record from a dead process is a crash artifact. `EPERM` ⇒ alive; freshness carries the verdict. |
| `updatedAt` older than `3 * heartbeatMs` | `down`/`HEALTH_STALE`. A main loop stalled past three heartbeats cannot service sockets either — staleness reports service-ability, not disk freshness. |
| Ephemeral instance (`publishesDiscovery === false`, port 0) | Full in-process `getStatus()` health; `persistBridgeInfo()` is skipped exactly as today, so no record is published and no channel carries its state to another instance — the same isolation the discovery file already enforces. |
| `dispose()` | Publishes the final `health: 'down'` record, then `healthTimer` is cleared beside `heartbeatTimer` and `unlinkDiscoveryIfOwned()` removes a record this pid wrote. |
| Heartbeat republish fails (EPERM/EBUSY, disk full) | `console.warn` inside the existing persist path; in-memory health is unaffected and the next beat retries. The record then ages into `HEALTH_STALE`, which is the correct degraded answer — never a silent healthy reading. |
| Launcher discovers a record whose `health`/`updatedAt` it does not understand (older app, newer launcher) | `resolveBridgeCandidates` ignores unknown fields and keeps using `port`/`host`/`pid`; health fields are additive, so a launcher that predates this design keeps working unchanged. |
| Journal write fails | Swallowed inside the launcher — telemetry must never cost a reconnect. Reader skips malformed lines; a torn tail cannot inflate `count`. |
| Journal absent / only old rows | `clientFailures.count = 0`; contributes nothing. |
| Invoke from `toolbar`, `tab`, `frameBackdrop`, `devtools`, or a non-chrome sender | Refused by the router (`ChromeSurfaceMismatchError` / `UnknownChromeSenderError`) before `run`; there is no surface-specific fallback. |
| Push with no subscriber / destroyed webContents | `safeSendWebContents` drops it, as for `antifan:terminal:session`. |
| A renderer that missed every push | The 10 s poll converges within one interval; bootstrap calls `getBridgeStatus` once. |
| Hook runs outside AntiFan (no `ANTIFAN_DATA_ROOT`, no failure markers) | Identical to today — the suspension check returns not-down without touching the filesystem. |
| Outage during a scoped (Direct/Super-Fast) session | Silent by contract: the `SCOPED_MODES` early return runs first, so no suspension notice, no reminder, no MCP-first — `turn_end`'s `[edit-guard]` skip line remains the whole story. `pendingEdits` is untouched. |
| Installed hook older than this change | Old `.js` keeps reminding — `install-omp-hooks.mjs --check` is how the installed copy is proven current; the repo source is what this spec changes. |

## Testing strategy

Acceptance intent, by lane.

- **`test/main/bridge-server-health.test.ts` (new).** Ephemeral port-0 instance: `getStatus()`
  carries `health: 'listening'` and no `lastFailure` after start; a `ws` error /
  `recordBridgeFailure('PAIRING_REFUSED', …)` flips `health` to `degraded` and stamps
  `lastFailure`; ageing `at` past `BRIDGE_FAILURE_RECENCY_MS` (via an injected `now` or by
  backdating the record) returns it to `listening`; `dispose()` leaves `health: 'down'`. A
  `publishesDiscovery === false` instance leaves the discovery record untouched (temp
  `ANTIFAN_DATA_ROOT`) exactly as the existing discovery tests assert.
- **`test/main/bridge-health-record.test.ts` (new).** With `ANTIFAN_DATA_ROOT`/`ANTIFAN_CONFIG_DIR`
  pointed at a scratch dir and a real (non-ephemeral) instance: the published record carries
  `port`+`host`+`pid`+`health` in the *same* file — the assertion that keeps this an extension of
  the discovery record rather than a second status file — and the heartbeat advances `updatedAt`
  without changing `port`/`pid`/`startedAt`. `canPublishLegacyMirror` protection still holds: a
  second instance's beats do not clobber a live holder's `~/.gemini` mirror entry. Then, pure
  reading rules on a hand-written record: absent, corrupt, dead pid, `EPERM`-alive pid, boundary of
  `3 * heartbeatMs` (one ms inside is fresh, outside is stale), foreign `heartbeatMs` honoured over
  the default, and same-pid preferring live memory over a lagging file.
  `readRecentClientFailures`: window boundary at 120 s, malformed lines skipped, tail bounded by
  `BRIDGE_CLIENT_FAILURE_TAIL_BYTES`, `terminalSessionId` carried through.
- **`test/unit/bridge-client-failure-journal.test.mjs` (new).** Drives
  `scripts/antifan-omp-mcp.cjs` exports with a scratch `ANTIFAN_DATA_ROOT`: rows land as JSONL with
  the session env stamped; rotation at `BRIDGE_CLIENT_FAILURE_JOURNAL_MAX_BYTES` leaves `.1` plus a
  fresh head; no env ⇒ nothing written; a failing append leaves the launcher path working.
- **Route authorization.** Extend the audit lane: `test/main/chrome-ipc-routes.test.ts`'s pinned
  route count moves 117 → 118, and `fileSurfaceMap` already declares `standalone.js` /
  `standalone-preload.ts` / `standalone.html` as `['sidebar','terminalPopout']`, so the new literals
  are covered automatically. A new `test/main/bridge-health-route.test.ts` drives the dispatcher
  with a fake registrar + sender resolver (`ipc-router.ts` seams): sidebar sender gets a report;
  toolbar and `tab` senders get `CHROME_SURFACE_MISMATCH`; an unowned webContents gets
  `UNKNOWN_CHROME_SENDER`; a null `BridgeServer` instance still answers `state: 'down'`.
- **`test/renderer/bridge-health-banner.test.ts` (new)** on the `loadStandalone` harness
  (`test/renderer/standalone-harness.ts`): chip exists after bootstrap; a `down` push mounts exactly
  one `#bridgeHealthBanner` across repeated pushes and `renderTabs` passes; dismiss hides it and a
  same-signature push keeps it hidden; a changed `state` or `lastFailure.code` re-shows it;
  `clientFailures.count > 0` with `state: 'listening'` still shows the banner; recovery removes the
  element and clears the dismissal. These assert the DOM, not wiring.
- **`test/unit/theme-qa-gate-hook.test.mjs` (extended).** The lane now loads the repo hook through
  `loadHook()` — which stages `src/omp-hooks/theme-qa-gate.ts` plus its `src/omp-hooks` imports as
  `.mts` in a temp dir and returns `{ handlers, sent }` — run with
  `node --test --test-force-exit test/unit/theme-qa-gate-hook.test.mjs`. With
  `ANTIFAN_DATA_ROOT`/`ANTIFAN_CONFIG_DIR` pointed at a scratch dir: a fresh `listening` record →
  today's behaviour unchanged; `health: 'down'` or a stale `updatedAt` → an armed gate + 17
  `tool_result`s yields **1** suspension chunk and **0** reminders (the Phukienmaymoc count); a
  `tool_result` whose text carries `MCP_BRIDGE_OFFLINE` suspends with *no* record present and again
  with a `listening` record present (observed-evidence lane); a `bridge-dev.json` beside a
  `bridge.json` resolves to the live pid's record; a scoped-mode session stays silent through the
  same outage (the `SCOPED_MODES` early return wins); on recovery the next `tool_result` emits one
  resume chunk and reminders resume; env unset ⇒ no file access and no suspension. The outage
  constants are pinned against `src/main/bridge/bridge-health.ts` by text read.
- **e2e smoke** (manual acceptance script shape, `test/e2e/` convention): real app — banner appears
  on `dispose()` and clears on restart.

## Acceptance criteria

1. With the Manager open, stopping the bridge listener (or occupying its port so `start()` takes
   the `EADDRINUSE` path) surfaces a banner and a red chip within **15 s** — bound: 3× heartbeat
   staleness or the failure push, plus one poll interval.
2. Restoring the bridge clears the banner and returns the chip to green within **10 s** (push on
   the listen-success transition, or the next poll).
3. During an outage, an armed QA gate emits **exactly 1** `[theme-qa-gate:bridge]` suspension notice
   across an arbitrary number of `tool_result`s — the audit's 17-reminder scenario collapses to 1 —
   and resumes reminders with a single resume notice after recovery.
4. A "clients failing while the server reports `listening`" state shows the client-failure banner
   line with the failing terminal's id; the report's `clientFailures.count` is sourced from the
   journal, not the server.
5. `antifan:bridge:get-status` invoked from a toolbar, tab, or non-chrome sender is refused by the
   router; `antifan:bridge:status` arrives only at `sidebar`/`terminalPopout` contents.
6. No bridge state changes terminal behaviour: no PTY writes, no focus moves, no tab activation —
   the surface is read-only projection.

## Risks & rollback

- **False `down` during long main-thread work.** Full-page capture raster has hit 60 s (S2
  evidence), longer than `3 * heartbeatMs`. Accepted deliberately: the WS accept loop stalls with
  the loop, so `down` is the honest answer; it self-heals on the next heartbeat. If it proves noisy
  the multiplier is one constant, not a redesign.
- **Concurrent journal appends.** Several launcher processes append at once; a torn line is skipped
  by the reader, and the bounded tail read means worst case is an under-count — never a hang or a
  wrong "healthy".
- **`chrome-ipc-routes.test.ts` pin.** The exact route count is asserted; the spec accounts for the
  bump to 118, and forgetting it fails that lane immediately rather than silently.
- **Rollback order:** renderer chip/banner + preload calls → `CHROME_ROUTES` entry + host
  subscription → launcher journal (`recordClientFailure` is additive; removing call sites orphans
  the export harmlessly) → QA-gate suspension block (repo source; the installed copy only changes
  through S1's installer, so rollback is `--rollback` or a re-install of the prior source) →
  heartbeat + `health`/`lastFailure`/`updatedAt` fields in `persistBridgeInfo()` +
  `healthTimer` → `lastFailure`/`listening` fields. Because the record is the existing discovery
  file, the last step degrades cleanly: an older app writes the same file without the new fields and
  an older launcher reads `port`/`host`/`pid` from it as before. Leftover
  `runtime/bridge-client-failures.jsonl` is inert data — no migration in either direction. (Do not
  leave the heartbeat writing a record shape that `resolveBridgeCandidates` has never seen *and*
  cannot ignore — that is why the journal/fields are additive, not a separate file.)

## Files touched

| File | Change |
|---|---|
| `src/main/bridge/bridge-server.ts` | `lastFailure`/`listening`/`healthTimer` fields, `recordBridgeFailure`, recording at listen/rebind/`ws.on('error')`/auth-close/pairing-refusal sites, `persistBridgeInfo()` extended with `health`/`lastFailure`/`heartbeatMs`/`updatedAt` + heartbeat republish, `getStatus()` + `dispose()` extensions |
| `src/main/bridge/bridge-health.ts` (new) | Paths (`bridgeInfoPath`, `bridgeClientFailuresPath`), constants, `readBridgeInfo`, `isPidAlive`, `evaluateBridgeHealth`, `readRecentClientFailures`, `buildBridgeHealthReport`, `subscribeBridgeHealth`/`emitBridgeHealthChanged` |
| `src/shared/contracts.ts` | `BridgeHealthState` (`listening`/`degraded`/`down`), `BridgeHealthReasonCode` (`HEALTH_RECORD_ABSENT`, `HEALTH_PID_DEAD`, `HEALTH_STALE`, `HEALTH_RECORD_CORRUPT`, `HEALTH_RECORD_LEGACY`, `BRIDGE_NOT_STARTED`), `BridgeFailureRecord`, `BridgeClientFailure`, `BridgeHealthReport`, `AntiFanBridgeStatus` fields, `BRIDGE_CHANNELS` |
| `src/main/browser/native-tab-host.ts` | `CHROME_ROUTES` entry for `antifan:bridge:get-status`; `subscribeBridgeHealth` fan-out in `setupTerminalSubscriptions` |
| `src/preload/standalone-preload.ts` | `getBridgeStatus`, `onBridgeStatus` |
| `src/renderer/standalone.js` | `#bridgeHealthChip`, single-instance `#bridgeHealthBanner`, signature-dismiss via `localStorage`, 10 s poll, push handler |
| `scripts/antifan-omp-mcp.cjs` | `recordClientFailure`, `bridgeClientFailuresPath`, journal calls at the five bridge-state `MCP_BRIDGE_OFFLINE` sites — no candidates discovered, all candidates refused, no-bootstrap post-autoheal, terminal-host OFFLINE write, TTY early exit — plus `rememberAutohealFailure`'s per-candidate catch, rotation, exports. The sixth `MCP_BRIDGE_OFFLINE` emitter, the `server.connect(new StdioServerTransport()).catch(...)` transport-attach handler, is **deliberately not journalled**: it reports a stdio transport error that can happen while the bridge is healthy, and a journal row there would make the journal claim an outage the bridge never had. The rule is therefore scoped to bridge-state failures, not to every line containing that string. |
| `src/omp-hooks/theme-qa-gate.ts` | `bridgeOutageKey`, `bridgeOutageEvidence`, suspension/resume blocks placed after the `SCOPED_MODES` early returns in `tool_result` and `context`, `HookAPI.appendEntry?` declaration, `appendEntry` audit |
| `test/main/bridge-server-health.test.ts`, `test/main/bridge-health-record.test.ts` (incl. the `HEALTH_RECORD_LEGACY` row: legacy record + alive pid ⇒ `degraded`, + dead pid ⇒ `down`), `test/main/bridge-health-route.test.ts`, `test/unit/bridge-client-failure-journal.test.mjs`, `test/renderer/bridge-health-banner.test.ts` | New lanes above |
| `test/main/chrome-ipc-routes.test.ts`, `test/unit/theme-qa-gate-hook.test.mjs` | Count pin 117→118; suspension cases; fake `pi` gains `appendEntry` capture |
| `docs/ui-architecture.md` | Amendments below |

**`docs/ui-architecture.md` amendments.** In `## Scope Rules`, append to the shared-manager
paragraph (after the `openTerminalLinkInOwner` sentence): "Every standalone surface also carries
bridge health: a compact chip in the header, and a single banner while the MCP bridge is down or
degraded or clients are failing to reach it. The signal's authority is the bridge discovery record
plus the client-failure journal, read through `antifan:bridge:get-status`
(`src/main/bridge/bridge-health.ts`) — never the toolbar's Super Core health plane." In
`## State Model`, append to the durable-stores sentence: "discovery and bridge health (the
per-instance `bridge.json`/`bridge-dev.json` under the config dir, written by `BridgeServer` with
`health`/`lastFailure`/`updatedAt`; and `runtime/bridge-client-failures.jsonl` under the data root,
appended by the MCP launcher — the first is the authority on the socket, the second is client-side
evidence, and neither is authority over sessions)."

## Owning sources

| Question | Owner |
|---|---|
| What the server last refused, and whether it is bound | `BridgeServer.lastFailure` / `listening`, `src/main/bridge/bridge-server.ts` |
| The persisted record's fields, DACL write, mirror guard, ownership on dispose | `persistBridgeInfo()` / `atomicWriteManyWithDacl()` / `canPublishLegacyMirror()` / `unlinkDiscoveryIfOwned()`, `src/main/bridge/bridge-server.ts` |
| Reading rules, stale rule, composite answer | `src/main/bridge/bridge-health.ts` |
| The record's location the Manager reads | `process.env.ANTIFAN_CONFIG_DIR \|\| StorageLocations.getConfigDir()` + `isDev`, `src/main/bridge/bridge-server.ts` |
| What a failing client saw, keyed to its terminal | `recordClientFailure` journal, `scripts/antifan-omp-mcp.cjs` |
| Which surface may ask | `CHROME_ROUTES` allowlist + `authorize`, `src/main/browser/ipc-router.ts` |
| One banner, one chip, one dismiss signature | `src/renderer/standalone.js` |
| When the QA gate stops reminding | `bridgeOutageEvidence` / `bridgeOutageKey`, `src/omp-hooks/theme-qa-gate.ts` |
| Where the journal lives | `StorageLocations.getRuntimeDir()`, `src/main/config/storage-locations.ts` |
