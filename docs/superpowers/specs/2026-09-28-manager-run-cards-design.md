# Manager run cards and capsule briefs — design

Status: target contract, decided with the user on 2026-09-28. Symbols and files are the authority
for what is wired — `NativeTabHost.CHROME_ROUTES`, `TerminalManager`, `WorkspaceCapsuleManager` and
the standalone sidebar renderer — not this prose. This spec is S4 of the day's set; S1's edit-mode
guard (`2026-09-28-edit-mode-guard-design.md`) owns the mode file, the guard log and the
`install-omp-hooks.mjs` installer this design's hook ships through.

Date: 2026-09-28

## Intent

The shared Terminal Manager lists every project's terminals but cannot answer the questions a person
watching agent work actually asks: *which terminal has a run in flight right now, what is it doing,
how long has it been going, what did it touch, and can I stop or steer it without hijacking the
terminal?* Today's answers to the forensic audit are all "no": a dead bridge went unnoticed for ~46
minutes (17 connect-failed log lines, no surface signal), and the user had to type "Huỷ subagents làm
trực tiếp đi" twice because no run was visible anywhere.

This design borrows the Orca/Claude-Projects idea — a card per live run with state, elapsed time,
Cancel and Steer — without changing the project model: a card belongs to a terminal row, the row's
existing owner/capsule attribution does all scope work, and a pinned *capsule brief* carries
storefront context (URL, site name, theme id, standing rules) into every prompt a terminal-bound
agent receives. No new identity is minted for a run; the run-state the card shows is reported by the
OMP process itself through a file the S1-installed user-scope hook maintains.

## Evidence

- The manager already lists every project's rows and gates writes on them: `managerAll` in
  `windowSessionScope`, `isSharedTerminalManagerSender`, `assertManagerMayOperate` refusing
  `agent:` rows with `MANAGER_AGENT_SESSION_READ_ONLY`, all in `src/main/browser/native-tab-host.ts`;
  `agentTerminalOwnerKey` in `src/main/browser/terminal-manager.ts`.
- A terminal PTY already stamps its OMP-spawn environment: `ANTIFAN_TERMINAL_SESSION_ID`,
  `ANTIFAN_TERMINAL_GENERATION`, `ANTIFAN_DATA_ROOT`, `ANTIFAN_BRIDGE_PORT/HOST/PID` in
  `terminalEnv` (`TerminalManager.startSession`, `src/main/browser/terminal-manager.ts`).
- The OMP hook API is verified by live probe (2026-09-28): `pi.on(event, handler)` over
  `session_start | before_agent_start | tool_call | tool_result | agent_end | turn_end |
  session_shutdown`; `event.prompt` on `before_agent_start` fires per user prompt including
  dequeued steer batches; `ctx.sessionManager.getSessionId()` is stable across `omp -c` resume;
  `ctx.abort()` exists; `pi.sendUserMessage(text, { deliverAs })` steers; `pi.appendEntry` +
  `getBranch()` survive resume; `agent_end` may fire repeatedly (retry loops) so handlers must
  tolerate re-entry. The shipped harness already exercised `agent_end` re-entry
  (`willContinue`) in `.omp/hooks/pre/antifan-core-bridge.ts` and `test/unit/context-bridge.test.mjs`.
- Rows and pushes exist: `SessionSummary` (`src/main/browser/terminal-manager.ts`) rides
  `antifan:terminal:session` per window via `terminalStateForWindow` and the `onTerminalSession`
  fan-out in `src/main/browser/native-tab-host.ts`; the renderer's wrap lifecycle is
  `ensureTerminalTabWrap` / `renderTabs` in `src/renderer/standalone.js`.
- The manager's capsule grouping (`buildGroupForKey`, `isSharedManagerShell`,
  `src/renderer/standalone.js`) already knows which capsule each row belongs to — the brief dialog's
  anchor is the capsule group header, no new grouping is needed.
- `WorkspaceCapsule` (`src/main/project/workspace-capsule.ts`) has no brief field; `load()` is
  field-tolerant and `persist()` is already atomic tmp+rename.
- The prompt path `/queue …` (`handleInspectPickResult`, `src/main/browser/tab-devtools-host.ts`)
  writes into the PTY via `dispatchAnnotationToTerminal`
  (`src/main/browser/annotation-dispatch.ts`). It is deliberately NOT the control path: control must
  never write the PTY.
- `openInVSCode(targetPath)` (`src/main/browser/native-tab-host.ts`, route
  `TERMINAL_CHANNELS.OPEN_IN_VSCODE`) accepts any existing path — a file opens in VS Code the same
  as a folder; the change list needs no new open route.
- Control-plane runs: `RunService.cancel(runId, backend)` revokes the attempt's attachments and calls
  `backend.cancel` (`src/main/run/run-service.ts`); `ExecutionBackend` is
  `src/main/agent/execution-backend.ts`, and `CodexExecutionBackend.cancel` kills its owned child
  process. Terminal-origin OMP sessions minted by `antifan.cli.startSession`
  (`src/main/bridge/bridge-server.ts` → `ControlPlaneRuntime.createCliSession`,
  `src/main/control-plane/control-plane-runtime.ts`) are control-plane runs of backend `'cli'` whose
  process is the terminal PTY itself — no `ExecutionBackend` owns it, which is why their cancel is
  the hook channel, not `backend.cancel`.
- `isProcessAlive` / `killProcessTree` conventions live in
  `src/main/process/process-registry.ts`; `StorageLocations.getRuntimeDir()` is
  `<dataRoot>/runtime` (`src/main/config/storage-locations.ts`).

## Non-goals

- No new window, panel or "runs" surface: the card rides the existing terminal row in the existing
  manager and project sidebars. No Orca-style job queue, no project model change, no chat UI.
- No PTY signalling. Cancel and Steer never write `\x03` or any byte through
  `TerminalManager.write`/`writeTo` — the run-state hook inside the OMP process is the only actuator.
- No takeover of agent rows: `agent:` rows show cards (watching an agent run is the point) but keep
  their view-only gate; Cancel/Steer on them are refused by the same `assertManagerMayOperate`.
- No session-history browser: the card shows the live run and the current run's change list; it is
  not a log viewer.
- No prompt-tag reinvention: mode badges read the S1 mode file; the card never parses prompts.
- No QA reminders: brief injection is context only. The QA nag mechanism belongs to
  `theme-qa-gate` (its source moves to `src/omp-hooks/theme-qa-gate.ts` under S1) and this hook must
  not emit reminders of its own.

## Decisions

1. **The run file is the only state authority for terminal runs.** The hook owns
   `runtime/runs/<terminalSessionId>.json` content; Main reads, projects, sweeps staleness and prunes
   — it never edits the file's fields, so there is no write conflict to arbitrate. A dead writer is
   detected by `pid` + `updatedAt`, not guessed.
2. **Control is a directory of small files, not a socket and not the PTY.** Main writes a request,
   the hook answers an ack file. Files survive focus loss, popouts and renderer restarts, and the
   request's `runSeq` + `expiresAt` make a stale Cancel harmless. The renderer never learns a nonce.
3. **One card per terminal session, both run kinds unified.** A card is emitted when the terminal row
   has a run file (hook-observed OMP run — the common case, backend `'cli'`-flavoured or none) or a
   live control-plane run bound via `originTerminalSessionId`. Cancel routes by run kind, not by
   which button the user pressed: hook channel for terminal runs, `RunService.cancel` for
   control-plane runs with a real `ExecutionBackend`.
4. **The brief is capsule metadata, not session metadata.** It lives on `WorkspaceCapsule`, survives
   restarts, is edited from the manager's capsule group header, and is mirrored per terminal as
   `runtime/runs/<terminalSessionId>.brief.json` so the hook reads it without IPC and every prompt —
   typed or picker-built — carries it.
5. **Project windows get cards for free, popouts for their bound session.** The renderer is shared;
   the per-window push reuses `terminalStateForWindow`'s visibility predicate. Horizontal tab strips
   show only the state dot (a full card would not fit); no tooltip duplication is built — YAGNI.
6. **Every control failure is typed, never thrown and never a silent no-op.** The route answers
   `RunControlResult`; the hook answers `RunControlAck`; silence is `RUN_CONTROL_TIMEOUT` after a
   bounded wait, which the card renders as text.

## The invariant this design preserves

`assertManagerMayOperate` (`src/main/browser/native-tab-host.ts`) is the one write gate over rows the
manager can see. The control route does not add a second authorization story: `agent:` rows remain
refused (`MANAGER_AGENT_SESSION_READ_ONLY`), cross-project rows remain refused by the router's
session scope (`sessionArgs` → `admitsSessionForWindow`), and a Cancel cannot escape into the PTY
because no code path on it ever calls the manager's write methods. The one new act —
`ctx.abort()` inside the agent's own process — is what the agent runtime itself exposes for this
purpose; the alternative (`writeTo(session, '\x03')`) is a keystroke the agent may swallow, queue or
misread, and it doubles as user input the transcript then misattributes.

## Architecture

Six components, in the order a Cancel travels.

### 1. Run-state hook — `src/omp-hooks/run-state.ts`

A user-scope OMP hook (`export default function (pi)`) installed by the S1 installer to
`~/.omp/agent/hooks/pre/antifan-run-state.js` — `pre/` because `before_agent_start` must return the
brief message. It is inert unless `ANTIFAN_TERMINAL_SESSION_ID` and `ANTIFAN_DATA_ROOT` are both set,
which is exactly the env `terminalEnv` stamps (`terminal-manager.ts`); an OMP run in a foreign shell
never writes run files.

**File.** `<ANTIFAN_DATA_ROOT>/runtime/runs/<terminalSessionId>.json`, written atomically
(tmp + `fs.renameSync`, the `WorkspaceCapsuleManager.persist` pattern):

```ts
interface TerminalRunStateFile {
  schema: 1;
  terminalSessionId: string;
  ompSessionId: string;        // ctx.sessionManager.getSessionId()
  pid: number;                 // process.pid of the OMP runtime
  cwd: string;                 // session cwd; Main locates the guard log under its .antifan ancestor
  mode: 'unset' | 'core' | 'direct' | 'fast';   // mirrored from runtime/edit-mode/<ompSessionId>.json (S1)
  state: 'idle' | 'running' | 'waiting_user' | 'ended';
  runSeq: number;              // increments per before_agent_start (prompt or steer batch)
  runStartedAt?: number;       // ms epoch of current/last run start
  lastEventAt: number;         // last OMP event observed
  lastTool?: string;           // last toolName on tool_call/tool_result
  promptHead?: string;         // first ≤120 chars of the normalized current prompt
  updatedAt: number;           // heartbeat stamp, rewritten on every write
}
```

`promptHead` is whitespace-collapsed and capped at 120 chars — a preview, not a transcript. There is
no secrets redaction pass: the prompt is text the user just typed into their own terminal, the file
never leaves the local data root, and the cap bounds accidental paste exposure; the field exists so
the card's tooltip can show what the run is doing.

`mode` is read fresh from `runtime/edit-mode/<ompSessionId>.json` (written by the S1 guard) on each
state write — absent file → `'unset'`, malformed file → `'unset'`. The hook never parses the prompt
for tags itself.

**Event → state map** (all writes also bump `lastEventAt`/`updatedAt`):

| OMP event | Effect |
|---|---|
| `session_start` | Resolve `ompSessionId`/`cwd`, write the file `state:'idle'`. **`runSeq` is carried over only for the session that wrote it**: keep the stored value when the file's `ompSessionId` matches this session, reset it to `0` when it does not — the run file and the guard log must agree on what run number `1` means. The counter itself is fixed on the guard side (see the correlation rule below). |
| `before_agent_start` | `state:'running'`, `runSeq++`, `runStartedAt=now`, `promptHead` from `event.prompt`; returns the brief message (§6) when a brief file exists. |
| `tool_call` | `lastTool=toolName`; if the tool is an ask-tool → `state:'waiting_user'`. |
| `tool_result` | `lastTool=toolName`; if `state==='waiting_user'` and the result answers the pending ask-tool → `state:'running'` (else unchanged). |
| `agent_end` | `willContinue` truthy → unchanged (mid-run retry); settling event → `state:'idle'`. Re-entry tolerant: a second settling `agent_end` is a no-op. |
| `turn_end` | No state change (turns occur inside a run); still bumps `lastEventAt`. |
| `session_shutdown` | `state:'ended'`, watchers/timers disposed, final write. |

**Ask-tools.** `OMP_ASK_TOOLS` is an exported constant set — `{'ask', 'ask_user', 'askUser',
'ask_user_question', 'confirm', 'input', 'elicit', 'elicitation'}` matched case-insensitively on
`toolName` — extended by env `ANTIFAN_RUN_ASK_TOOLS` (CSV). An unlisted interactive tool degrades the
card to `running`-until-`agent_end`: fail-visible, never stuck `waiting_user` forever, because the
sweep (§3) still ends dead runs.

**Heartbeat.** An unref'd `setInterval` (`RUN_HEARTBEAT_MS = 15_000`) rewrites `updatedAt` while the
process lives. Main's stale rule: `state !== 'ended'` AND (`!isProcessAlive(pid)` OR
`updatedAt` older than `RUN_STALE_MS = 45_000`) → projected as `ended`/`stale`. Process kill is never
the sweep's job — marking is.

**Control watcher.** The hook watches `runtime/runs/control/<ompSessionId>/` with `fs.watch` plus a
1s `readdir` fallback poll (unreliable watch on Windows/networked roots is the common failure, not
the rare one). For each `<nonce>.json` request: validate shape, drop silently (no ack) when
`expiresAt` is past — an ancient Cancel must not land inside the *next* run; refuse
`{ok:false,error:'STALE_RUN_SEQ'}` when the file's `runSeq` ≠ the request's; refuse
`{ok:false,error:'RUN_NOT_ACTIVE'}` when `state ∉ {running, waiting_user}`; else execute —
`cancel` → `ctx.abort()`, `steer` → `pi.sendUserMessage(text, {deliverAs:'steer'})` — and write
`<nonce>.ack.json` `{schema:1, ok, error?, at}` atomically, then delete the request file
(best-effort). The hook keeps the latest `ctx` seen on any event: `abort` lives on the context, not
`pi`, and the runtime reuses the session's context across events. A thrown actuator error acks
`{ok:false,error:'ACTUATOR_FAILED'}` with a ≤160-char message.

Every hook body is wrapped so it never throws into the OMP runtime (the shipped convention in
`antifan-core-bridge.ts`: "logger must never break the session").

### 2. Control channel — `antifan:run:control`

`TERMINAL_CHANNELS.RUN_CONTROL = 'antifan:run:control'` and the push
`TERMINAL_CHANNELS.RUN_STATE = 'antifan:run:state'` in `src/shared/contracts.ts`; preload wrappers
`runControl(terminalSessionId, op, text?)` and `onRunCardState(cb)` in
`src/preload/standalone-preload.ts`.

**Route.** A `CHROME_ROUTES` entry beside the assign/open-link routes
(`src/main/browser/native-tab-host.ts`), `kind:'handle'`, `surface:['sidebar','terminalPopout']`,
`sessionArgs: (args) => [(args[0] as { terminalSessionId?: string })?.terminalSessionId]` so the
router's scope check refuses cross-window rows before the handler runs. Payload
`{terminalSessionId?, runId?, op:'cancel'|'steer', text?}`.

**Answer.** `RunControlResult` settles as `{ok:true, op, at}` or `{ok:false, reason, message}` —
same shape discipline as `TerminalProjectAssignResult`. `RunControlReason`:
`INVALID_PAYLOAD`, `UNKNOWN_SESSION`, `SESSION_NOT_VISIBLE`,
`MANAGER_AGENT_SESSION_READ_ONLY`, `RUN_NOT_ACTIVE`, `STALE_RUN_SEQ`,
`RUN_CONTROL_TIMEOUT`, `RUN_CONTROL_UNSUPPORTED`, `RUN_BACKEND_UNAVAILABLE`,
`ACTUATOR_FAILED`, `RUN_CONTROL_FAILED` (untyped ack error or malformed ack — never invented
success).

**Terminal branch** (`terminalSessionId`): `assertManagerMayOperate` →
`isSessionVisibleToWindow` → read the run file → `state ∉ {running,waiting_user}` or no
`ompSessionId` → `RUN_NOT_ACTIVE` → else write
`runtime/runs/control/<ompSessionId>/<nonce>.json`
`{schema:1, op, text?, runSeq, requestedAt, expiresAt: now+15_000}` atomically, poll for
`<nonce>.ack.json` every 100 ms up to `RUN_CONTROL_ACK_TIMEOUT_MS = 5_000`, then delete the request
file. Ack `ok` → `{ok:true}`; ack `error` in the reason vocabulary → echoed as `reason`; anything
else → `RUN_CONTROL_FAILED`; no ack → `RUN_CONTROL_TIMEOUT`. Steer requires non-empty `text` ≤ 4000
chars — `INVALID_PAYLOAD` otherwise — and is refused `RUN_CONTROL_UNSUPPORTED` on control-plane
cards (no user-message channel exists there).

**Control-plane branch** (`runId`, no terminalSessionId): the run is resolved through
`host.controlPlane.runs`; its `originTerminalSessionId` (`ExecutionAttachmentRecord`,
`src/shared/control-plane-contracts.ts` — the record's own definition; `attachment-registry.ts` is
the registry that stores it) must resolve to a session the caller may both see and operate
— the same two gates — else `SESSION_NOT_VISIBLE`. A `'cli'`-backend run with a live run file on
that terminal is redirected into the terminal branch (its process is the PTY's child; only the hook
can abort it). A run with a real `ExecutionBackend` cancels through
`RunService.cancel(runId, backend)` with the backend instance resolved by a host seam
(`runBackendFor(backendId)` / `setRunBackendResolver`, the `setProjectAssignmentResolver` pattern);
an unregistered backend id refuses `RUN_BACKEND_UNAVAILABLE`. Attachments the cancel revokes are the
existing owner/attachment authorization (`RunService.cancel`, `run-service.ts`) — no new authority
is minted.

**Never the PTY.** Neither branch calls `TerminalManager.write`, `writeTo`, `safelyKillSession` or
`closeSession`; the acceptance test spies on all four. (`sendTerminalInputTo` is not a
`TerminalManager` method at all — it is the preload API over the `antifan:terminal:input-session`
route, so the zero-PTY-input invariant is covered by those four plus a route-level assertion that
neither branch reaches that channel.)

### 3. Run-state service — `src/main/run/run-state-service.ts`

One process-wide `RunStateService` constructed in `src/main/index.ts` beside the control-plane
bootstrap and handed to each host by `attachSharedServices` (`host.setRunStateService`) — the same
wiring the control plane uses.

- **Projection.** Reads `runtime/runs/*.json` **except `<sid>.brief.json`** — the run-state files and
  the brief mirrors share one directory, and a brief mirror has no `terminalSessionId` at all, so the
  glob must carve it out by name or the projection (and, worse, the prune below) reads the feature's
  own mirror as a malformed run file. Each remaining file is joined to its `SessionSummary` by
  `terminalSessionId`, the stale rule applied (`isProcessAlive(pid)`, `RUN_STALE_MS`), the card's
  capsule looked up via `TerminalManager.sessionCapsuleId`, `viewOnly` computed per receiving window
  (manager + `agent:` owner → true), and the change-review summary (§5) and the bound control-plane
  run attached when `AttachmentRegistry` has a live record with that
  `originTerminalSessionId`. Output: `RunCardState[]`.
- **Watch & push.** `fs.watch` on `runtime/runs/` + a `RUN_SWEEP_MS = 5_000` sweep; on change it
  emits `'change'` and each host pushes its scoped projection as `{runs: RunCardState[]}` on
  `antifan:run:state` through a `runCardsForWindow(runs, senderId)` that reuses
  `isSessionVisibleToWindow` — placed next to `onTerminalSession`'s fan-out (sidebar + each popout,
  popouts filtered to their bound session). The sidebar's `antifan:sidebar:get-initial-state`
  reply gains `runCards` so a freshly mounted surface is not blank until the next tick.
- **Prune.** A run file is removed when its terminal session no longer exists, or when
  `state:'ended'` for > 24 h; expired control requests and acks older than their request's
  `expiresAt` + 1 h are swept; orphaned `control/<ompSessionId>` dirs vanish with their run file.
  A brief mirror is pruned **only** with the run file of the session named in its own filename — it
  is never judged by a `terminalSessionId` field it does not have, which would otherwise delete a
  live mirror (a session with a capsule brief and no `omp` running has no run file to keep it alive).
- **Brief mirror.** `syncBriefs()` writes `runtime/runs/<sid>.brief.json`
  `{schema:1, capsuleId, briefSeq, brief, updatedAt}` for every live session whose capsule carries a
  brief, deletes it when the capsule's brief is cleared or the session's capsule changes, and runs on
  `set-brief`, on capsule assignment (`transferSessionOwner`'s `session` broadcast diff), and on
  session creation. `briefSeq` is `capsule.updatedAt`.

`RunCardState` (`src/shared/contracts.ts`):

```ts
interface RunCardState {
  terminalSessionId: string;
  ompSessionId?: string;
  state: 'idle' | 'running' | 'waiting_user' | 'ended';
  stale: boolean;
  mode: 'unset' | 'core' | 'direct' | 'fast';
  runSeq: number;
  runStartedAt?: number;
  lastEventAt?: number;
  lastTool?: string;
  promptHead?: string;
  cwd?: string;
  capsuleId?: string;
  viewOnly: boolean;                                   // computed per receiving window
  controlPlane?: { runId: string; attemptId?: string; backendId: string };
  changes?: { files: string[]; fileCount: number; blockedCount: number };
}
```

### 4. Run card UI — `src/renderer/standalone.js`

The card is a child of `.terminal-tab-wrap` (`ensureTerminalTabWrap`), built once and updated in
place like the activity beacon (`updateTabActivityUi`), keyed by `runCards: Map<sid, RunCardState>`
maintained from `api.onRunCardState`.

- Sidebar layout shows the full card: state dot (running = teal pulse, waiting_user = amber,
  idle = muted, ended = dim), elapsed `mm:ss` ticking locally from `runStartedAt` (1 s interval, no
  IPC), mode badge (`Direct`/`Fast`/`Core`; `unset` shows none), `lastTool` in mono, capsule label,
  and `Hủy` / `Chỉ đạo` buttons. `promptHead` is the card's title tooltip.
- Horizontal strips show only the state dot folded into the existing status beacon — no second
  tooltip surface is built (decision 5).
- Steer opens an inline input row inside the wrap (created in JS, like the rename field); Enter posts
  `api.runControl(sid,'steer',text)`, Esc closes, a refused answer renders via the existing
  `showTerminalNotice`.
- `card.viewOnly` (agent rows under the manager) renders both buttons disabled with title
  `Terminal do agent sở hữu chỉ được xem, không chuyển được` — the verbatim string the context menu
  already uses (`standalone.js`); the
  renderer additionally guards clicks with `isAgentOwnedSession`, mirroring the assign item.
- `ended` + `stale` renders a dimmed `kết thúc` chip with the last state/tool — honest corpse
  evidence for the "run died silently" failure this feature exists to kill — and no buttons; the row
  clears when the sweep prunes the file.
- Group headers for `kind:'capsule'` groups (`ensureCategoryHeader`, manager only) gain a small
  brief button that opens the capsule brief dialog (§6) for `group.capsuleId`.

### 5. Per-run change review

**Correlation rule (the join key, and the counter it depends on).** A run is `(ompSessionId, runSeq)` on both sides, and the two counters only agree because S1's guard counter survives a resume. It did not: `runSeq` lived in the guard's per-process `sessions` Map and started at `0` (`buildSession`, `src/omp-hooks/edit-guard.ts`), so `omp -c` minted a fresh session whose first run was `1` again while the run file kept the previous process's number - and a join on the log's own maximum then read the *previous* process's rows as the current run's change list. **Landed in S1**: `buildSession` seeds `runSeq` from the maximum already present in that session's own log (`lastRunSeqInLog`, the same read `changedFilesThisRun` in `src/omp-hooks/theme-qa-gate.ts` performs), so numbers stay monotonic per session file and a resumed session continues instead of restarting; a torn line or a non-numeric `runSeq` is skipped, and the only reset both sides see together is a log rotation (`<name>.1.jsonl`). The run-state writer's half of the rule is in the event map above (`session_start` keeps the stored `runSeq` only when the stored `ompSessionId` matches). Invariant for every reader: rows whose `runSeq` is not the current run's number are **history** - never folded into the current card, and never a substitute for "this run changed nothing".

Main-side, inside `RunStateService`: for a card's `ompSessionId` + `runSeq`, read the S1 guard log
`<workspaceRoot>/.antifan/edit-guard/<ompSessionId>.jsonl` where `workspaceRoot` is the run file's
`cwd` walked up to the nearest ancestor containing `.antifan/` — the same convention the shipped
`theme-qa-gate` uses for `.antifan/qa-receipts`. Rows `decision==='allow'` for that `runSeq` produce
the deduped file list (`changes.files`, capped at 24 paths + `fileCount` total); refused rows count
into `blockedCount`. The guard writes a row only for a block or for a file-changing call, never for an
inspection, so the list cannot contain a path the run merely read. Unreadable/absent log → `changes`
absent, never an error — a run in a workspace without a guard is normal.

The card footer shows `N file đã sửa · M bị chặn` when either count is nonzero and expands to the
path list on click; a path click calls `api.openInVSCode(path)` — a new preload wrapper invoking
`TERMINAL_CHANNELS.OPEN_IN_VSCODE` with the absolute path (`openInVSCode` accepts any existing path).

### 6. Capsule pinned brief

`WorkspaceCapsule` gains `brief?: CapsuleBrief` (`src/main/project/workspace-capsule.ts`):

```ts
interface CapsuleBrief {
  storefrontUrl?: string;   // http(s) only, ≤300 chars
  siteName?: string;        // ≤80 chars
  themeId?: string;         // ≤64 chars, ^[0-9A-Za-z_-]+$
  rules?: string[];         // ≤8 entries, each ≤200 chars
}
```

- **Validation.** `sanitizeCapsuleBrief(input)` normalizes; `load()` is tolerant per field (bad
  fields drop, the capsule survives — the existing per-field guard style in `load()`); the write
  path `setBrief(capsuleId, brief|null)` refuses the whole write on any failed field —
  `INVALID_BRIEF` — because a silently truncated brief would feed an agent rules the user never
  agreed to. `null` deletes the field and its `.brief.json` mirrors.
- **Routes.** `antifan:capsule:get-brief` `{capsuleId}` → `{ok:true, capsuleId, brief|null}`;
  `antifan:capsule:set-brief` `{capsuleId, brief|null}` → `{ok:true, capsule}` /
  `{ok:false, reason:'INVALID_BRIEF'|'UNKNOWN_CAPSULE'|'INVALID_PAYLOAD'}` — `CHROME_ROUTES`,
  `surface:['sidebar','terminalPopout']`, no `sessionArgs` (capsule metadata, like `capsule:list`).
- **Dialog.** A `capsuleBriefDialog` popover in `src/renderer/standalone.html` (storefront URL, site
  name, theme id, rules textarea one-per-line) opened from capsule group headers in the manager;
  preload `capsuleGetBrief`/`capsuleSetBrief`.
- **Injection.** On `before_agent_start` the hook reads `runtime/runs/<sid>.brief.json`; when present
  it returns `{message:{customType:'antifan-capsule-brief', display:false, attribution:'agent',
  details:{capsuleId, briefSeq}, content}}` with `content` a single compact block ≤ 1 KB —
  `storefront=… site=… theme=… rules: a · b · c` truncated to fit. Every prompt carries it (typed,
  steered, or picker-built `/queue` prompts all fire `before_agent_start`); a missing or malformed
  file injects nothing — fail-open for context, never an error into the session. No reminder text,
  no QA nudge: that mechanism belongs to `theme-qa-gate`.

### 7. `docs/ui-architecture.md` boundary paragraph

Append to `## Product Thesis`:

> AntiFan's place in the toolchain is narrower than its cockpit suggests: Orca orchestrates the
> development of AntiFan itself, while AntiFan is the cockpit for live client themes. The run cards
> in the shared Terminal Manager observe and steer agent runs that work on merchant storefronts —
> they are not a surface for driving this repository's own build or test agents, and they bind to a
> terminal session and a capsule, never to a focused tab. A pinned capsule brief carries storefront
> context (URL, site name, theme id, standing rules) into every prompt a terminal-bound agent run
> receives, keeping client-work state where client work lives.

The State Model section's store enumeration gains `runtime/runs/` as a Main-owned projection source
reported by agent processes — durable truth stays Main-owned; the run file is evidence *about* a
terminal session, owned and swept by Main even though an agent process writes it.

## Error handling

| Condition | Behaviour |
|---|---|
| No run file / `state:'ended'` / missing `ompSessionId` | `RUN_NOT_ACTIVE`; the card already renders ended/disabled, so this is the race answer, not a new UI path. |
| `runSeq` moved on between paint and request | Hook acks `STALE_RUN_SEQ` → surfaced verbatim. A stale Cancel never lands inside the newer run. |
| `expiresAt` already past when the hook reads the request | Dropped without an ack; Main's poll ends in `RUN_CONTROL_TIMEOUT`. Both sides agree an ancient request does nothing. |
| No ack within `RUN_CONTROL_ACK_TIMEOUT_MS` (5 s) | `RUN_CONTROL_TIMEOUT`: hook absent (never installed, old build), dead mid-flight, or busy past the bound. Request file deleted best-effort. |
| `ctx.abort`/`sendUserMessage` throws inside the hook | `{ok:false,error:'ACTUATOR_FAILED'}` with a bounded message; the run file is untouched. |
| Corrupt request JSON / wrong `schema` | `{ok:false,error:'INVALID_CONTROL_PAYLOAD'}` ack when a nonce is recoverable; the file is deleted either way. |
| `agent:` row | `MANAGER_AGENT_SESSION_READ_ONLY` from `assertManagerMayOperate` — same refusal every other write route answers. |
| Session not visible to the calling window | Router `sessionArgs` refusal (`admitsSessionForWindow`), or `SESSION_NOT_VISIBLE` from the handler on the `runId` branch. |
| Control-plane run with unregistered `backendId` | `RUN_BACKEND_UNAVAILABLE` — never falls back to poking the PTY. |
| Steer on a control-plane run, or empty/oversized text | `RUN_CONTROL_UNSUPPORTED` / `INVALID_PAYLOAD`. |
| `fs.watch` unsupported or silent on the data root | The hook's 1 s readdir fallback and the service's 5 s sweep cover it; correctness never depends on watch fidelity. |
| Run file malformed JSON | Treated as absent by the projection (row shows no card); prune removes it when its session is gone. Never rewritten by Main. |
| `.antifan/edit-guard` log absent or unreadable | `changes` omitted from the card — a workspace without the guard is normal, not an error. |
| Brief file malformed | Hook injects nothing; fail-open context only. |
| `setBrief` with any invalid field | `INVALID_BRIEF`, whole write refused, previous brief kept. |

## Tests

Named lanes, each owning what can actually regress:

- `test/unit/antifan-run-state-hook.test.mjs` — the `anti-direct-policy.test.mjs` convention (read
  `src/omp-hooks/run-state.ts`, transpile in-memory, drive a fake `pi`/`ctx`): inert without
  the env pair; `session_start` writes `idle` and preserves `runSeq` over a seeded file;
  `before_agent_start` → `running`, `runSeq++`, `promptHead` capped; `tool_call` ask-tool →
  `waiting_user`, its `tool_result` → `running`; `agent_end` with `willContinue` keeps `running`,
  settling → `idle`, re-entry is a no-op; `session_shutdown` → `ended`; heartbeat bumps `updatedAt`;
  cancel request → `ctx.abort()` called + `ok` ack; steer → `sendUserMessage` with
  `{deliverAs:'steer'}` + `ok` ack; expired request deleted, no ack, no abort; `STALE_RUN_SEQ` and
  `RUN_NOT_ACTIVE` acks; corrupt request acked `INVALID_CONTROL_PAYLOAD`; brief present →
  `before_agent_start` returns a ≤ 1 KB `antifan-capsule-brief` message; malformed/absent brief →
  none; mode file absent/corrupt → `'unset'`.
- `test/main/run-state-service.test.ts` — scratch `ANTIFAN_DATA_ROOT`: projection joins sessions
  with run files; dead-pid and silent-heartbeat runs project `stale`/`ended`; the control route's
  full roundtrip against a fake hook that writes acks (`{ok:true}`, typed errors, timeout →
  `RUN_CONTROL_TIMEOUT`, `RUN_NOT_ACTIVE`); `agent:` row → `MANAGER_AGENT_SESSION_READ_ONLY`;
  foreign-session → router refusal; **the zero-PTY invariant — spies on `TerminalManager.writeTo`,
  `write`, `safelyKillSession`, `closeSession` assert 0 calls across cancel and steer**; `runId`
  branch resolves `originTerminalSessionId` and re-uses the same gates; brief mirror writes, updates
  and deletes `.brief.json` on `setBrief` and on capsule reassignment; sweep prunes ended files and
  expired control dirs.
- `test/main/workspace-capsule.test.ts` (existing lane, new cases): brief round-trips through
  persist/load; tolerant load drops a bad `storefrontUrl` but keeps the capsule and good fields;
  `setBrief` refuses `ftp://`, overlong rules and non-string fields with `INVALID_BRIEF`; `null`
  clears.
- `test/renderer/terminal-run-cards.test.ts` — the `standalone-harness` convention: a running card
  renders dot/elapsed/mode badge and ticks; `viewOnly` cards disable both buttons with the reason
  title; ended+stale renders the dimmed chip; steer opens the inline input and posts
  `runControl` with its text; a `{ok:false,reason}` answer surfaces via `showTerminalNotice`; the
  change footer lists deduped files and a path click calls `openInVSCode` with that path.
- `test/main/chrome-ipc-routes.test.ts` + `test/main/ipc-audit.test.ts` — **the pinned route count moves
  117 → 120** for the three new `CHROME_ROUTES` entries (`antifan:run:control`,
  `antifan:capsule:get-brief`, `antifan:capsule:set-brief`), plus surfaces
  (`['sidebar','terminalPopout']`) and preload↔host payload parity for them and for the two capsule
  routes. `antifan:run:state` is **not** a route: it is a push constant with a preload subscription
  and no surface, so it adds no entry to the pin. (If S3's bridge-health route lands as well, the same
  lane's pin reads 121 — the number to assert is the tree's, and each spec states its own delta.)

## Acceptance criteria (observable)

1. In the shared manager, a terminal running `omp` shows a card within ~5 s of `session_start`:
   state dot, elapsed ticking, mode badge matching `runtime/edit-mode/<ompSessionId>.json` (the guard's
   mirror is keyed by the *omp session id*, not the terminal session id), last tool live.
2. Typing a prompt flips the card to `running` and bumps elapsed from ~0; an ask-tool call shows
   `waiting_user`; session end shows `kết thúc`. A killed OMP process is marked stale/ended by the
   sweep without any input.
3. `Hủy` on a user-owned running card aborts the OMP run (agent returns to prompt; card goes `idle`)
   while the terminal transcript gains no `^C` and no stray bytes — `writeTo`/`write` spies stay at
   0 in the route test.
4. `Chỉ đạo` text arrives as a steered user message in that OMP session; an `agent:` row refuses both
   buttons with `MANAGER_AGENT_SESSION_READ_ONLY`; a foreign window's sender is refused before the
   handler.
5. The change footer lists exactly the files the guard log allowed for that `runSeq`, counts
   refused rows as `bị chặn`, and a click opens the file in VS Code.
6. Editing a capsule's brief in the manager makes every subsequent prompt in terminals of that
   capsule carry the ≤ 1 KB brief message; clearing it stops injection.
7. A run with no bridge attachment still shows a full card — the card owes the bridge nothing.

## Risks & rollback

- **Hook absent** (older installs, foreign shells): no run file, no card, control refuses
  `RUN_NOT_ACTIVE` — degraded visibility, never broken terminals. The S1 installer's `--check` mode
  reports the missing file.
- **Stale `pid` reuse** marking a live run stale: guarded by `updatedAt` heartbeat AND
  `isProcessAlive` — both must fail before the card lies. A pid recycled into a live process stays
  fresh via heartbeats.
- **fs.watch reliability** on Windows roots: covered by poll fallbacks on both sides; worst case is
  the 5 s sweep cadence, not silence.
- **Brief prompt noise**: capped ≤ 1 KB and `display:false`; larger briefs are truncated rather than
  dropped so injection stays bounded.
- **Rollback order**: renderer cards + dialog and their preload calls first, then the four routes'
  `CHROME_ROUTES` entries, then `RunStateService` wiring in `index.ts`, then the hook file (removing
  it orphans no main code — a run file is self-describing), then the `WorkspaceCapsule.brief` field
  last (tolerant load makes old builds ignore a field new builds wrote, and new builds ignore a
  missing field — no migration either direction). Control/request leftovers under `runtime/runs/`
  are inert without a watcher.

## Files touched

| File | Change |
|---|---|
| `src/omp-hooks/run-state.ts` | New: run-state writer, control watcher/actuator, brief injector (installed to `~/.omp/agent/hooks/pre/antifan-run-state.js` by S1's `install-omp-hooks.mjs`; **no installer edit is needed because that array already carries a `run-state` entry marked `optional: true`** — the installer does not glob `src/omp-hooks/*.ts`, and a non-optional entry whose source is missing throws). |
| `src/main/run/run-state-service.ts` | New: projection, watch/sweep/prune, control request writer + ack poll, change-review reader, brief mirror. |
| `src/omp-hooks/edit-guard.ts` *(landed in S1)* | `runSeq` seeded from the maximum already in the session's own audit log (`buildSession` / `lastRunSeqInLog`), so a resumed session continues counting instead of restarting at 1 — the counter §5's `(ompSessionId, runSeq)` join depends on. |
| `src/shared/contracts.ts` | `TERMINAL_CHANNELS.RUN_CONTROL`/`RUN_STATE`; `RunCardState`, `RunControlResult`, `RunControlReason`, `CapsuleBrief`, brief push/get/set payloads. |
| `src/main/browser/native-tab-host.ts` | `CHROME_ROUTES`: `antifan:run:control`, `antifan:capsule:get-brief`, `antifan:capsule:set-brief`; `runBackendFor`/`setRunBackendResolver` seam; `runCardsForWindow` projection + `antifan:run:state` fan-out beside `onTerminalSession`; `runCards` in `get-initial-state`; `setRunStateService`. |
| `src/main/index.ts` | Construct `RunStateService`, install the backend resolver, hand the service to hosts in `attachSharedServices`. |
| `src/main/project/workspace-capsule.ts` | `brief?: CapsuleBrief`, `sanitizeCapsuleBrief`, `setBrief`, tolerant `load()` copy. |
| `src/preload/standalone-preload.ts` | `runControl`, `onRunCardState`, `capsuleGetBrief`, `capsuleSetBrief`, `openInVSCode`. |
| `src/renderer/standalone.js` | `runCards` map + card render/update in `ensureTerminalTabWrap`, steer inline row, capsule-group brief button + dialog flow, change list. |
| `src/renderer/standalone.html` | `capsuleBriefDialog` markup. |
| `src/renderer/standalone.css` | Card, dot, badge, steer row, dialog styles. |
| `docs/ui-architecture.md` | Product Thesis boundary paragraph; `runtime/runs/` in the State Model enumeration. |
| `test/unit/antifan-run-state-hook.test.mjs`, `test/main/run-state-service.test.ts`, `test/main/workspace-capsule.test.ts`, `test/renderer/terminal-run-cards.test.ts`, `test/main/chrome-ipc-routes.test.ts`, `test/main/ipc-audit.test.ts` | Test lanes above. |

## Owning sources

| Question | Owner |
| --- | --- |
| What a run's state *is*, on disk, and who writes it | new `src/omp-hooks/run-state.ts` → `runtime/runs/<terminalSessionId>.json` (atomic tmp + rename); `pid` + `updatedAt` are the staleness facts |
| Which rows this window sees, and how a card is projected | `terminalStateForWindow` + `isSessionVisibleToWindow` (`src/main/browser/native-tab-host.ts`); the run projection joins them |
| What may be *done* to a row | `assertManagerMayOperate` (`native-tab-host.ts`) + the router's `sessionArgs` → `admitsSessionForWindow` (`src/main/browser/ipc-router.ts`); `MANAGER_AGENT_SESSION_READ_ONLY` is the agent-row refusal |
| How a Cancel or steer reaches the run, and what a failure looks like | new `src/main/run/run-state-service.ts` (request file + ack poll) → `ctx.abort()` in the hook; typed answers `RunControlResult` / `RunControlAck`; `RUN_CONTROL_TIMEOUT` is the bounded-silence answer |
| A control-plane run's cancel | `RunService.cancel(runId, backend)`, `src/main/run/run-service.ts` — reached only for rows carrying a real `ExecutionBackend` |
| The quiet brief a run starts with | `WorkspaceCapsule.brief` / `sanitizeCapsuleBrief` / `setBrief` (`src/main/project/workspace-capsule.ts`) + the `runtime/runs/<id>.brief.json` mirror the hook reads |
| Which surface may ask for any of it | `CHROME_ROUTES` (`antifan:run:control`, `antifan:capsule:get-brief`, `antifan:capsule:set-brief`) + `authorize`, `src/main/browser/ipc-router.ts` |
| What the user reads on the card | `src/renderer/standalone.js` (+ `standalone.html`, `standalone.css`) |
| Where the run files live | `StorageLocations.getRuntimeDir()` |

Status: complete spec; implementation lands under the shared S1–S4 contract.
