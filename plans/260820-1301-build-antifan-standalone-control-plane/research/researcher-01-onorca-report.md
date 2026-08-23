# Research Report: Orca Patterns for AntiFan Standalone Control Plane

---
date: 2026-08-20
scope: current OnOrca docs and stablyai/orca source
upstream-commit: 4daace62511c15cb8ba87686e1b8faf7142c7344
local-project: antifan-browser-desktop
verdict: adopt-reliability-contracts-defer-product-surface
---

## Executive Summary

Orca's most reusable idea is an ownership rule: the PTY/agent process is the
source of truth; chat UI, status hooks, CLI output, and persisted records are
projections or recovery metadata. The current docs state this explicitly for
native Chat UI (the terminal remains the source of truth), and the source backs
it with PTY daemon identity, incarnation, stream cursors, hook provenance, and
failure-injection tests.

For AntiFan's standalone theme/web tool, adopt the contracts behind that rule
now: real PTY sessions, stable session/instance identity, bounded cursor reads,
provider-owned resume locators, authenticated restart-safe hook endpoints,
durable run/receipt state, and redacted browser evidence budgets. Do not port
Orca's Electron/React/Zustand/worktree architecture.

Defer hibernation until sessions are durable and resumable; defer worktrees,
multi-agent orchestration, remote/SSH/cloud runtimes, mobile, and broad CLI
surface. These are useful later, but they expand the control plane before the
standalone MVP has proven its single-project/single-agent workflow.

## Sources and Method

- Official docs: [What is Orca?](https://www.onorca.dev/docs), [native Chat UI](https://www.onorca.dev/docs/agents/native-chat), [terminal](https://www.onorca.dev/docs/terminal), [CLI reference](https://www.onorca.dev/docs/cli/reference), [hooks & memory](https://www.onorca.dev/docs/agents/hooks-memory), [session history](https://www.onorca.dev/docs/agents/session-history), [agent hibernation](https://www.onorca.dev/docs/agents/hibernation), [session restore](https://www.onorca.dev/docs/model/session-restore), [worktrees](https://www.onorca.dev/docs/model/worktrees), [Design Mode](https://www.onorca.dev/docs/browser/design-mode), [orchestration](https://www.onorca.dev/docs/cli/orchestration), [skills/MCP](https://www.onorca.dev/docs/cli/skills), [supported agents](https://www.onorca.dev/docs/agents/supported), and [ways to run](https://www.onorca.dev/docs/ways-to-run).
- Official sitemap last modified `2026-08-19T22:06:00.647Z`: [sitemap.xml](https://www.onorca.dev/sitemap.xml).
- Upstream source at `origin/main` commit `4daace62511c15cb8ba87686e1b8faf7142c7344`, 2026-08-19 22:54 PDT: [commit](https://github.com/stablyai/orca/commit/4daace62511c15cb8ba87686e1b8faf7142c7344). Key files: [agent status observations](https://github.com/stablyai/orca/blob/4daace62511c15cb8ba87686e1b8faf7142c7344/src/shared/agent-status-observation.ts), [hook listener/endpoint writer](https://github.com/stablyai/orca/blob/4daace62511c15cb8ba87686e1b8faf7142c7344/src/shared/agent-hook-listener.ts), [terminal CLI handler](https://github.com/stablyai/orca/blob/4daace62511c15cb8ba87686e1b8faf7142c7344/src/cli/handlers/terminal.ts), [terminal formatting/cursors](https://github.com/stablyai/orca/blob/4daace62511c15cb8ba87686e1b8faf7142c7344/src/cli/terminal-format.ts), [provider resume contract](https://github.com/stablyai/orca/blob/4daace62511c15cb8ba87686e1b8faf7142c7344/src/shared/agent-session-resume.ts), [hibernation planner](https://github.com/stablyai/orca/blob/4daace62511c15cb8ba87686e1b8faf7142c7344/src/renderer/src/lib/agent-hibernation-planner.ts), [browser evidence contract](https://github.com/stablyai/orca/blob/4daace62511c15cb8ba87686e1b8faf7142c7344/src/shared/browser-grab-types.ts), and [local PTY provider](https://github.com/stablyai/orca/blob/4daace62511c15cb8ba87686e1b8faf7142c7344/src/main/providers/local-pty-provider.ts).
- Local AntiFan evidence: `src/main/browser/terminal-manager.ts`, `src/main/mcp/mcp-server.ts`, `src/main/browser/browser-action-registry.ts`, `src/main/bridge/annotation-manager.ts`, and `docs/security-model.md`.
- Earlier local comparison: `plans/reports/260820-1146-orca-adaptation-research.md` (useful reliability findings; this report updates the upstream revision and focuses on the standalone control plane).

## Evidence Findings

### 1. PTY and native chat

**Observed evidence**

- Orca docs describe Chat UI as an optional structured transcript/composer over
  a supported agent terminal; “the terminal remains the source of truth.” It
  can toggle between chat and terminal for the same session and warns that raw
  TUI is the fidelity path when every OSC/status detail matters.
- Orca's CLI exposes terminal handles, `terminal read`, bounded cursors,
  `oldestCursor`, `latestCursor`, `nextCursor`, and an explicit warning when
  output has been truncated. The source separates a rendered screen read from
  accumulated output pagination.
- Upstream source uses `node-pty` in `src/main/providers/local-pty-provider.ts`
  and a daemon/provider model rather than one global child process. The source
  contains Windows shell fallback, WSL path handling, process identity, and
  PTY adoption/recovery tests.

**AntiFan comparison**

- `src/main/browser/terminal-manager.ts` uses a singleton
  `child_process.spawn`, merges stdout/stderr, has one `ptyProcess`, and uses
  `taskkill /T /F` on Windows. It is a process pipe, not a PTY source of truth;
  there is no durable handle, cursor, buffer, incarnation, or restart attach.
- The standalone plan requires terminal streaming and resume, so this is a
  direct MVP risk, not a cosmetic parity issue.

**Recommendation: ADOPT NOW (P0)**

1. Replace the singleton manager with one session object per run/workspace,
   backed by `node-pty` (Windows PowerShell/CMD/WSL and POSIX shell).
2. Give each session a stable `sessionId`, `ptyId`, `workspaceId`,
   `instance/incarnation`, creation epoch, and current owner.
3. Keep a bounded append-only output buffer with `cursor`, `oldestCursor`,
   `latestCursor`, `nextCursor`, and `truncated`; expose `read --json`-style
   machine output internally even before adding a public CLI.
4. Treat browser/chat/status as projections. A reconnect must reattach/replay
   the PTY buffer instead of claiming a transcript snapshot is new delivery.

**Do not adopt** Orca's terminal theming, panes, floating terminal, or full
keyboard command surface in the first standalone slice.

### 2. CLI `--json` and agent status/hooks

**Observed evidence**

- Orca's CLI docs require `--json` for automation and recommend explicit
  selectors (`id:`, `path:`, `branch:`, `active/current` only when context is
  unambiguous). Terminal handles are runtime-scoped and must be reacquired
  after restart.
- Hooks & memory docs describe managed status hooks reporting working/waiting/
  done, per-repo hooks, and endpoint files persisted on disk. On Windows the
  endpoint is `endpoint.cmd`; POSIX uses `endpoint.env`. Endpoints are
  re-sourced on every invocation so an old PTY can reach a restarted runtime.
- Source `src/shared/agent-status-observation.ts` defines
  `(authorityId, incarnation, revision)` ordering. Different authorities are
  incomparable; restart/rebind increments incarnation. Source
  `src/shared/agent-hook-listener.ts` writes endpoint files through a temp file
  and atomic `renameSync`, with stale-temp cleanup and POSIX permissions.

**Recommendation: ADOPT NOW (P0/P1)**

- Define one internal JSON envelope for every control-plane command/result:
  `requestId`, `workspaceId`, `sessionId`, `hostEpoch`, `route`, `state`,
  `acceptedAt`, `completedAt`, `errorCode`, and bounded evidence refs.
- Add observation provenance (`authorityId`, `incarnation`, `revision`,
  `origin`, `kind`) to status events. A hydrated snapshot is `snapshot`, never
  a new transition; a different authority is not “older” or “newer” by revision.
- Persist a loopback endpoint/lease file with a random token, protocol version,
  workspace binding, and host epoch. Write temp + atomic rename; use owner-only
  permissions where supported; use a Windows `.cmd` form rather than assuming
  POSIX shell syntax.
- Make unknown delivery explicit. Never infer success from a queued composer,
  transcript text, or a socket that merely remains open.

**Risk**: authority metadata is ordering/provenance, not authentication. Keep
HMAC/token/lease validation separate from `authorityId` and `revision`.

### 3. Native chat, session history, and resume

**Observed evidence**

- Orca scans each agent's on-disk session store and resumes by provider-specific
  command in a fresh terminal with the same working directory and session ID.
  Examples in the docs include `claude --resume <id>`, `codex resume <id>`, and
  file-based resume for agents whose authoritative locator is a transcript file.
- Upstream `src/shared/agent-session-resume.ts` stores both provider session ID
  and an optional authoritative `transcriptPath`; it rejects unsafe IDs and
  preserves provider-specific argv. The source comments explain that recent
  Claude/Codex transcript filenames can differ from the hook session ID.
- `workspace-session-sleeping-agents.ts` persists the exact launch command,
  environment, provider session metadata, and origin to avoid duplicate resume.

**Recommendation: ADOPT NOW for persistence contract; DEFER the history UI**

- AntiFan Chat Store should own messages for standalone mode. Agent transcripts
  are import/observation sources, not the canonical chat store.
- Persist `provider`, `providerSessionId`/conversation ID, optional transcript
  path, exact launch argv, cwd/workspace, model/options, and environment allowlist.
  Validate control characters, length, and path scope before cold restore.
- Resume only when the provider locator and PTY/session ownership match the
  requested workspace. A missing transcript path should make resume unavailable,
  not trigger a guessed glob or a new unrelated session.
- Build a small “recent sessions” list after the MVP persistence path works;
  do not copy Orca's cross-agent scanner or mobile drag/drop now.

### 4. Hibernation

**Observed evidence**

- Orca hibernation is an experimental idle planner. The source uses bounded idle
  settings, excludes foreground/input-active panes, records provider session
  identity, and has extensive tests for wake races, duplicate resume, and
  Windows command quoting.
- Hibernation is not simply “kill the process”: it records enough state to wake
  the exact provider session and suppresses duplicate tabs during restore.

**Recommendation: DEFER (P2)**

Do not hibernate AntiFan agents until P0 PTY ownership, durable session records,
and cold restore are passing. Later, start with explicit user “sleep” for an
idle completed run; add automatic idle sleep only after measuring memory/CPU
pressure. A naïve kill/relaunch would lose unsent input and can fork the same
provider session.

### 5. Worktrees and orchestration

**Observed evidence**

- Orca docs model a worktree as the unit containing agent, terminal, browser,
  and review state. Its current CLI has selectors, `worktree create`, task/run
  namespaces, dispatch IDs, FIFO delivery with `--ack`, decision gates, worker
  completion contracts, and recovery commands. The current docs explicitly say
  the legacy `orchestration run` command is retired in favor of Run/Task/worker
  primitives and the full skill guide.
- Source contains a large database-backed orchestration subsystem with worker
  terminal ownership/release/recovery and federation tests. This is mature but
  operationally broad.

**Recommendation: DEFER/REJECT FOR PERSONAL MVP**

- Keep AntiFan's initial unit as `Project -> Workspace -> Chat -> Session ->
  AgentRun`, one active agent and one PTY per run.
- Do not add Git worktrees, parallel agents, worker mailboxes, dispatch IDs,
  gates, or remote federation until a real user needs concurrent theme tasks.
- If a future task needs concurrency, reuse the invariants (immutable target,
  explicit owner, durable delivery ID, ack/replay, release/recovery), not Orca's
  database or command namespace wholesale.

**Why**: worktrees solve isolation between concurrent diffs. They do not solve
the standalone MVP's first failure mode (a single run losing PTY/session truth).

### 6. Browser/design mode and evidence budgets

**Observed evidence**

- Orca's browser-grab source at
  `src/shared/browser-grab-types.ts` defines bounded text/HTML/ancestor/nearby
  entries, six nearby elements, a 20-annotation/page cap, a 2 MiB screenshot
  budget, safe attribute allowlists, and secret-like attribute redaction.
  Persisted annotations drop transient screenshots while retaining DOM context.
- The official Design Mode docs position browser selection/annotation as a
  focused agent workflow, not as arbitrary page evaluation.

**AntiFan comparison**

- AntiFan already has a richer annotation pipeline in
  `src/main/bridge/annotation-manager.ts`, with screenshots, markdown evidence,
  computed styles, accessibility/runtime diagnostics, and a 30-minute TTL.
- `docs/security-model.md` already requires redaction, byte budgets, stale
  generation rejection, and deny-by-default high-risk MCP.

**Recommendation: ADOPT SELECTIVELY (P1)**

- Keep AntiFan's existing capture contract; add Orca-like explicit per-field
  limits, safe attribute allowlist, secret-pattern redaction, and a hard total
  evidence budget to every browser-to-agent envelope.
- Persist references/metadata by default and keep screenshots transient unless
  the user explicitly attaches them. Never let page HTML or annotation text be
  interpreted as instructions.
- Do not port Orca's browser pane/profile model or replace NativeTabHost.

### 7. MCP and skills

**Observed evidence**

- Orca docs register MCP servers under settings and expose installable skills;
  agents are instructed to load the current CLI skill and use `--json` rather
  than inventing flags.
- AntiFan already has a centralized `BrowserActionRegistry` and MCP server.
  `docs/security-model.md` says default MCP is read/introspect-only, high-risk
  tools require an explicit flag, and MCP cannot launch/own Chromium.

**Recommendation: ADOPT THE BOUNDARY, NOT ORCA'S REGISTRY**

- Make the existing `BrowserActionRegistry` the sole tool registry and generate
  MCP schemas from it (avoid duplicate switch statements between registry and
  `src/main/mcp/mcp-server.ts`).
- Add stable JSON error codes, capability/permission metadata, workspace and
  browser-epoch binding, and explicit high-risk opt-in. Keep arbitrary JS eval
  disabled by default.
- Add an internal “tool/CLI skill” manifest only when standalone agent runtime
  needs it. Defer remote MCP servers, skill marketplace, and MCP orchestration.

### 8. Windows

**Observed evidence**

- Orca officially supports Windows installers and PowerShell/CMD/WSL shells.
  Docs call out Windows-specific WSL path translation and PowerShell defaults.
  Hooks use `endpoint.cmd`; orchestration docs warn that PowerShell strips JSON
  quotes and require quoting group addresses.
- Upstream uses `node-pty`, Windows shell fallback/preflight, WSL runtime
  detection, and quoting tests.

**Recommendation: ADOPT NOW (P0 for this repo)**

- Use `node-pty` and a shell adapter (`PowerShell`, `cmd.exe`, optional WSL)
  instead of `child_process.spawn` pipes. Keep shell choice explicit in the
  session record.
- Never construct `taskkill` strings from unvalidated PIDs; retain a validated
  process-tree owner and graceful-then-force termination path.
- Test PowerShell JSON transport, CMD quoting, WSL path translation, endpoint
  sourcing, and PTY resize/Unicode behavior on the target Windows build.

## Adoption Matrix

| Orca pattern | Decision | AntiFan action |
|---|---|---|
| PTY is source of truth | Adopt now | Replace singleton child-process terminal with session-owned `node-pty` |
| Native Chat UI over PTY | Adopt later in MVP | Build as a projection after PTY/reconnect contract |
| Cursor-based `terminal read --json` | Adopt now | Bounded output buffer + deterministic JSON envelope |
| Authority/incarnation/revision | Adopt now | Add to agent/run/receipt observations; not auth |
| Restart-safe hook endpoint | Adopt now | Token + epoch + atomic endpoint file; `.cmd` on Windows |
| Provider session history/resume | Adopt now | Persist exact provider locator/argv/cwd; history UI later |
| Automatic hibernation | Defer | Explicit sleep only after cold restore is proven |
| Browser evidence budget/redaction | Adopt selectively | Extend existing annotation manager and security model |
| MCP registry/capability boundary | Adopt selectively | Generate tools from existing action registry |
| Git worktrees | Defer | Add only for concurrent isolated theme tasks |
| Multi-agent orchestration | Defer/reject MVP | Keep one run/one agent; later reuse ack/owner invariants |
| SSH/remote/cloud/mobile | Reject MVP | Personal local Windows theme tool has no current need |

## Proposed Standalone Control-Plane Shape

```text
Project / Workspace (durable, user selected)
        |
     AgentRun (request/route/permission/receipt identity)
        |
     PTY Session (authoritative process + bounded output/cursors)
        |
     Provider session locator (resume id/path + exact argv/cwd)
        |
     Projections: Chat Store, status hooks, terminal view, browser evidence
        |
     BrowserActionRegistry -> MCP adapter (capability/epoch checked)
```

The critical invariant is that every projection carries the run/session/host
identity it describes. A transcript, screenshot, status callback, or MCP result
without that binding is observation only, never proof that a new turn was
delivered or that a mutating action completed.

## Risks and Unknowns

1. **Provider API variance**: session IDs and resume commands differ; some
   providers expose only a transcript path. Keep provider adapters narrow and
   make “resume unavailable” a valid state.
2. **Antigravity remains optional**: Orca supports Antigravity as a CLI agent,
   but neither its docs nor the inspected source proves private IDE
   conversation routing. Do not infer exact Antigravity routing from hook status.
3. **PTY native packaging**: `node-pty` requires Electron/Node ABI rebuild and
   Windows packaging tests. This is a build/release risk, but avoiding a PTY
   would undermine the standalone terminal contract.
4. **Durability boundary**: AntiFan's current security model has strong browser
   generations/leases, but standalone run/session persistence is not yet the
   canonical owner. Add storage and recovery tests before hibernation or
   orchestration.
5. **Evidence budget tuning**: Orca's 2 MiB screenshot/20 annotation values are
   useful defaults, not AntiFan product requirements. Measure theme QA prompts
   and retain user-visible truncation reasons.
6. **MCP prompt injection**: browser HTML, screenshots, console output, and MCP
   results remain untrusted evidence. Preserve AntiFan's deny-by-default and
   high-risk gate even if a future native chat makes tool calls feel local.

## Next Steps

1. Freeze a standalone `AgentRun`/`PtySession`/`ProviderSessionLocator` type
   contract before UI refactoring.
2. Spike `node-pty` on Windows PowerShell, CMD, and WSL; add cursor replay and
   process-tree cleanup tests.
3. Add authenticated endpoint/lease and observation provenance to the existing
   bridge/receipt flow; test restart, stale epoch, replay, and unknown delivery.
4. Move browser MCP schemas to `BrowserActionRegistry`, preserving existing
   high-risk gating and browser epoch checks.
5. Revisit session history UI, hibernation, and worktrees only after the MVP
   success test (AntiFan closed/reopened, same workspace/chat resumed) passes.

## Unresolved Questions

- Which direct provider is first for standalone AntiFan (Codex/OpenAI-compatible,
  Anthropic, DeepSeek, or another CLI/API)? This determines the first resume and
  streaming adapter.
- Should the standalone run store retain full PTY output, a bounded ring, or
  artifact references only after a run settles? The cursor contract supports all
  three, but retention affects disk/privacy.
- Is WSL required for the first Windows release, or should PowerShell/CMD be the
  only supported shells initially? The answer changes native dependency/test
  scope.
