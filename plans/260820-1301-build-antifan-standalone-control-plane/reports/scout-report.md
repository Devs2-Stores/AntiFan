---
title: "Standalone Control Plane Scout Report"
status: complete
created: 2026-08-20
scope: planning-only
---

# Standalone Control Plane Scout Report

## Summary

The live repository is a small, single-window Electron browser companion, not the
Project-owned Harness architecture described in `docs/` and the 260817 plans.
Production starts one `NativeTabHost`, one global terminal singleton, one local
WebSocket bridge, and optionally an MCP stdio server that calls the host directly.
There is no Project runtime, Workspace registry, Run service, CapabilityBroker,
Harness utility process, provider gateway, or Project renderer in `src/`.

The standalone-control-plane plan therefore needs an explicit reconciliation
gate before implementation. It must use the live source tree as implementation
authority, treat the Project/Harness documents as accepted target constraints,
and either depend on or formally supersede overlapping unfinished plan domains.
Otherwise phases 3, 5, and 6 will create a second Project/broker/run architecture
beside plans 260817-1931 and 260818-1533.

Current verification: `npm run typecheck` passes. No source file was changed by
this scout. The worktree already had user/controller edits in several target
files; findings below describe those live bytes and label unfinished additions.

## Authority Classification

| Evidence | Classification | Planning consequence |
|---|---|---|
| `package.json`, `tsconfig.json`, `src/`, and current tests | Authoritative current executable behavior | Use for extraction seams, compatibility tests, and migration order |
| Dirty working-tree files, including new `delivery-ledger.ts` | Current in-progress behavior, not yet stable authority | Preserve and characterize; do not design as if fully integrated or committed |
| `docs/ui-architecture.md` | Aspirational/target architecture for this checkout | Keep its Chromium-first and immutable-scope constraints, but do not cite its “Phase 11 shipped” claims as current implementation evidence |
| `docs/security-model.md` | Aspirational security contract with a few current matches | Convert contradictions into Phase 2 acceptance tests before exposing a standalone service |
| Plans 260817-1931, 260817-2217, 260818-1533 | Unfinished durable decisions and claimed evidence, but many named source files are absent | Reuse decisions and domain ownership; verify every “done” claim against the live tree before dependency closure |
| Plan 260820-1301 phase files | Controller-created placeholders at scout time | Populate only after resolving overlap and choosing the actual control-plane boundary |

## Current Runtime Topology

```text
src/main/index.ts
  -> one BrowserWindow
  -> one NativeTabHost
       -> toolbar WebContentsView
       -> sidebar WebContentsView
       -> terminal WebContentsView
       -> many remote-page WebContentsViews
       -> one TranscriptSyncer
       -> global TerminalManager singleton
       -> AntigravityCommandClient instances for prompt/abort receipts
  -> one BridgeServer on 127.0.0.1
  -> optional AntiFanMcpServer over stdio, in the same Electron process
```

There is no second, standalone control-plane process and no backend-neutral run
or execution contract. `--mcp-server` still materializes the Electron window and
`NativeTabHost`; it only skips the single-instance lock.

## Relevant File Inventory

| Path | Current owner/behavior | Standalone seam | Key caution |
|---|---|---|---|
| `package.json` | Electron/TypeScript package; `main` is compiled `src/main/index.ts`; dependencies are MCP SDK, `ws`, and `zod` | Add a distinct control-plane entry/build/start script only after the process boundary is accepted | Current `test` compiles then runs only `test/main/*.test.js`; there is no E2E or renderer test tree |
| `src/main/index.ts` | Global bootstrap, profile path, one window/host, BridgeServer, optional MCP server | Extract argument parsing and lifecycle into a thin bootstrap; inject a control-plane/runtime service instead of constructing adapters inline | MCP mode is not plain Node, creates Chromium, starts BridgeServer, restores cookies, and logs to stdout |
| `src/main/browser/native-tab-host.ts` | 2,450-line UI composition, IPC registration, tab ownership, automation, annotations, terminal routing, chat dispatch, persistence, and receipt reconciliation | Extract narrow browser, chat-delivery, layout, and IPC adapters around stable behavior; keep WebContents ownership here until a verified runtime owner replaces it | Global/active-tab fallbacks, global IPC handlers, `process.cwd()` workspace guesses, unsandboxed local views, inline base64, and direct filesystem writes prevent safe standalone reuse |
| `src/main/browser/terminal-manager.ts` | One process-wide interactive shell with mutable `currentCwd` | Replace behind an injected terminal port; preserve interactive behavior only as a legacy UI adapter | Singleton, no Project/Workspace identity, arbitrary caller cwd, no output budget, forced `taskkill /F`, no PID/birth/port ledger, and no tests |
| `src/main/browser/browser-action-registry.ts` | Unused in production; tested catalogue/alias/high-risk wrapper for 15 host actions | Best current seed for a single declarative browser capability catalogue, after changing its dependency from concrete `NativeTabHost` to an explicit-target browser port | MCP and WebSocket do not use it; several handlers resolve the active tab; it omits agent actions and returns inline screenshot/DOM payloads |
| `src/main/mcp/mcp-server.ts` | Hand-written MCP tool list and switch calling `NativeTabHost` directly | Make it a transport adapter over the shared capability catalogue/control-plane API | Catalogue and dispatch are duplicated; Chrome profile cases are callable in the switch but absent from `tools`; mutations are exposed by default; no MCP tests; no broker attachment |
| `src/main/bridge/bridge-server.ts` | Token-gated localhost WebSocket RPC with another direct action switch | Treat as a compatibility transport over the same catalogue, or explicitly retire it | Duplicates MCP/registry behavior; exposes direct `evalJS` without the registry's high-risk gate; active-tab fallback remains |
| `src/main/bridge/transcript-syncer.ts` | Reads Antigravity/Gemini brain directories, discovers sessions/workspaces, watches transcript JSONL, parses messages | Keep behind an Antigravity compatibility/read-model adapter; do not make it the standalone chat/run store | Session/workspace correlation is heuristic and provider-specific; parsed timestamps are `Date.now()`; image files can become renderer base64; no durable run identity |
| `src/main/bridge/antigravity-command-client.ts` | Protocol-v2 filesystem command/receipt client with atomic request write, polling, timeout-to-unknown, liveness, and late receipt scan | Preserve as an Antigravity execution-backend adapter behind a backend-neutral dispatch contract | Still provider-specific; result workspace matching accepts ancestor/descendant paths; late receipts are not bound to the original command/workspace/digest; duplicated stale-cleanup methods |
| `src/main/bridge/delivery-ledger.ts` | New, uncommitted JSON ledger for command delivery states | Potential migration input for a proper standalone run/mutation journal, not the journal itself | Imported but unused; global `~/.gemini` path; stores prompt text; swallows all errors; lacks schema/version/locking; in-memory map is not pruned; only one narrow test |
| `src/shared/contracts.ts` | Current tab, annotation, chat, Antigravity protocol, and IPC channel DTOs | Split transport-neutral control-plane contracts from legacy renderer/Antigravity contracts; add runtime validation | Uses `any`, inline image data URLs/base64, no Project/Workspace/Run/target generations, and compile-time interfaces only |
| `docs/ui-architecture.md` | Declares Project Home, ProjectRuntime, typed layout snapshot, immutable scopes, and completed atomic cutover | Use as target UX/scope constraints if standalone control is still embedded in this product | Named production renderer/preload/app-shell files are absent; live UI remains toolbar/sidebar/terminal HTML and direct bounds math |
| `docs/security-model.md` | Declares Project ownership, brokered MCP, exact generations, stdio purity, artifact refs, and delivery semantics | Turn each applicable statement into a verified gate | Multiple live contradictions are listed below |
| `test/main/*.test.ts` | 12 node:test files covering contracts, bridge auth, command protocol, transcript parsing/containment, registry mocks, and small utilities | Retain as characterization; add control-plane contract/integration/process tests before refactor | No test constructs `NativeTabHost`, `AntiFanMcpServer`, `TerminalManager`, or `src/main/index.ts` end to end |

## Authoritative Current Behavior Versus Docs

| Domain | Live behavior | Documented target | Reconciliation required |
|---|---|---|---|
| Ownership | One global window/host/profile and active tab | One Project runtime/window/partition; immutable Project/Workspace/Run/Tab scope | Decide whether standalone MVP first wraps the singleton or first delivers Project ownership. Do not claim both at once |
| Browser targeting | Many commands use `tabId || getActiveTabId()` | Mutations require exact Project, tab runtime, browser epoch, and document generation | New control-plane mutation contract must require explicit targets; legacy UI may resolve active tab once at its adapter edge |
| Layout/UI | Main computes hard-coded toolbar/sidebar/terminal bounds | Renderer reports validated `BrowserLayoutSnapshot`; Chromium minimum 960x640 behavior | Keep UI-plan ownership outside the standalone backend unless the MVP explicitly changes renderer behavior |
| Local view sandbox | Toolbar/sidebar/terminal use `sandbox:false` | Every window/view sandboxed | Characterize preload requirements and either sandbox these views or narrow the security doc claim before external exposure |
| MCP process | MCP runs inside Electron, owns `NativeTabHost`, and starts with GUI/bridge/cookies | Plain-Node child, broker attachment required, cannot own/launch Chromium | Process separation is a required early architecture decision, not Phase 9 packaging polish |
| MCP surface | Open/switch/close/navigate/reload/inspect and agent interactions are default tools | Default read/introspect only; mutating/high-risk explicitly gated | Add capability classes and exposure policy; current single boolean only gates `eval_js` |
| MCP stdio | `console.log` startup/bridge messages share stdout path | stdout contains only MCP frames | Add a stdio-purity test and log routing before any standalone release |
| Capability authority | Registry, MCP switch, and WebSocket switch are three catalogues; production bypasses registry | One Project CapabilityBroker/catalogue | Consolidate schema/dispatch first, then adapt transports; do not add a fourth standalone switch |
| Terminal | One mutable global shell, arbitrary cwd | Project/Workspace-bound PTYs and separately journaled command execution | Do not expose the current TerminalManager to autonomous tools |
| Chat/run truth | Sidebar array plus watched provider transcript; delivery receipt is message metadata | Main-owned durable chats, turns, runs, events, receipts, replay | Add a standalone store/service; keep TranscriptSyncer import-only |
| Artifacts | DOM and screenshots return strings/base64; prompt attachments use absolute file paths | Bounded artifact handles/metadata only | Introduce artifact store/refs before large control-plane results or renderer replay |
| Delivery | Filesystem command polling reaches `unknown`; late receipts are scanned in memory | Durable prepared/dispatching/accepted/failed/unknown with explicit reconciliation | Preserve no-auto-retry, but move state transitions to one durable journal |

## Exact Function And Interface Checklist

### Bootstrap And Process Boundary

- [ ] Extract mode/config parsing around `IS_PROD`, `IS_MCP_SERVER`, and `IS_MCP_HIGH_RISK` from `src/main/index.ts:23` into a pure validated config function.
- [ ] Separate GUI lifecycle (`BrowserWindow`, cookies, BridgeServer) from standalone transport lifecycle; `--mcp-server` must not implicitly construct a new browser owner.
- [ ] Define `ControlPlaneRuntime.start()`, `attachBrowser(...)`, `detachBrowser(...)`, and `dispose()` with observable shutdown.
- [ ] Add stdio log routing before MCP transport connects; stdout must remain frame-only.
- [ ] Keep `NativeTabHost` materialization under the GUI/bootstrap owner until the Project-runtime decision is implemented and tested.

### Browser Capability Boundary

- [ ] Introduce a transport-neutral `BrowserControlPort`/adapter rather than importing `NativeTabHost` into MCP, WebSocket, or backend orchestration.
- [ ] Extract/readapt `getTabList()` (`native-tab-host.ts:1040`) as `listTabs(scope)`.
- [ ] Replace `getActiveTabId()` fallback use with explicit `BrowserTarget` containing at minimum owner/runtime ID and tab ID; add browser epoch/document generation when Project ownership lands.
- [ ] Wrap `createTab`, `switchTab`, `closeTab`, `navigate`, `reload`, `goBack`, and `goForward` as classified capabilities with input/output schemas.
- [ ] Wrap `agentClick`, `agentType`, `agentScroll`, `agentHover`, `agentHighlight`, and `agentClear` with the same explicit target and post-action revalidation.
- [ ] Wrap `captureScreenshot()` and `getDom()` behind bounded artifact results; do not propagate unbounded base64/HTML through shared run state.
- [ ] Keep `evalJs()` absent by default and independently permissioned; do not inherit the WebSocket bridge's unconditional direct eval path.
- [ ] Move the declarative parts of `BrowserActionRegistry.registerCoreActions()` into the single catalogue; production transports must enumerate and execute from that catalogue.
- [ ] Add catalogue uniqueness validation for canonical names and aliases; reject duplicate/ambiguous registration.

### Workspace, Chat, And Delivery

- [ ] Do not extract `resolveTargetWorkspace()` (`native-tab-host.ts:1831`) as authority. Replace it with an explicit registered Workspace ID/path contract and canonical containment.
- [ ] Extract attachment budgeting from `handleSendPrompt()` (`native-tab-host.ts:1898`) into a bounded artifact staging service; remove `process.cwd()`/`e:\Work` snapshot fallbacks.
- [ ] Move command construction/polling from `AntigravityCommandClient.dispatchCommand()` (`antigravity-command-client.ts:262`) behind `ExecutionBackend.dispatch(runAttempt)`.
- [ ] Preserve `validateCommandV2`, `validateResultV2`, `validateHostV2`, prompt digesting, atomic write, timeout-to-unknown, and no-auto-retry as Antigravity adapter behavior.
- [ ] Tighten receipt binding to exact canonical Workspace identity; do not accept arbitrary ancestor/descendant path matches.
- [ ] Persist the original expected command binding for `checkLateReceipt()`; validate command ID, Workspace, digest, and host epoch before reconciliation.
- [ ] Define standalone `Project`, `Workspace`, `ChatSession`, `Turn`, `Run`, `RunEvent`, `ExecutionAttempt`, `MutationReceipt`, and `ArtifactRef` contracts with versions and runtime validators.
- [ ] Treat `TranscriptSyncer` as provider import/projection only; its session switch, rename, delete, and JSONL parser must not own standalone run truth.
- [ ] Replace the unused `DeliveryLedger` with or migrate it into the accepted durable run/mutation store; never maintain two ledgers for the same delivery.

### Terminal And Filesystem Tools

- [ ] Split interactive PTY behavior from autonomous one-shot command execution.
- [ ] Replace `TerminalManager.getInstance()` with an owner-scoped interface receiving immutable Workspace/cwd identity at creation.
- [ ] Add canonical cwd containment, command policy, timeout, output budget/artifact spill, cancellation semantics, and process identity tracking before tool exposure.
- [ ] Track PID, start/birth identity, process group/job, command, cwd, port, owner, and shutdown result; stop only owned processes.
- [ ] Reuse the 260818 tool catalogue names only through one broker/catalogue; do not create alternate `terminal_run_command` or workspace tool implementations.

### MCP And Compatibility Transports

- [ ] Replace `AntiFanMcpServer.setupHandlers()`'s static `tools` array and switch with catalogue enumeration/dispatch.
- [ ] Remove or register the unreachable `antifan_get_chrome_profiles` and `antifan_sync_chrome_profile` cases; current `ListTools` never advertises them.
- [ ] Adapt `BridgeServer` to the same dispatcher or freeze it as a compatibility-only surface with an explicit removal plan.
- [ ] Define read, browser-mutation, workspace-mutation, terminal, credential/profile, and arbitrary-code risk classes; exposure must be policy-driven, not one `isHighRiskAllowed` boolean.
- [ ] Require explicit runtime/project attachment for every standalone client; no implicit active GUI or newly launched Chromium fallback.

## Test Inventory And Gaps

### Existing Tests To Preserve

| Test | Current coverage | Limitation |
|---|---|---|
| `test/main/action-registry.test.ts` | Core catalogue names, aliases, high-risk eval guard, mock dispatch | Registry is unused by production; mock has no target generations or error paths |
| `test/main/antigravity-command-client.test.ts` | Digest, v2 validation, atomic write, matching receipt, timeout unknown, host liveness, late receipt | No exact canonical containment, host epoch/replay, malformed partial receipt timeout, cancellation race, or real filesystem integration |
| `test/main/delivery-ledger.test.ts` | Record/update/reload one JSON record | No corrupt schema, write failure, concurrency, pruning, privacy, atomic recovery, or integration; source is uncommitted and unused |
| `test/main/bridge-server.test.ts` | Token required, invalid token rejected, browser Origin rejected, basic RPC | No method authorization/risk classes, eval restriction, catalogue parity, backpressure, shutdown, or cross-owner routing |
| `test/main/contracts.test.ts` | Channel constants and one picked-element compile shape | No runtime validation or Project/run/execution contracts |
| `test/main/ipc-audit.test.ts` | Static handler/string parity and duplicate renderer listeners | Static presence can pass while sender ownership and behavior are unsafe |
| `test/main/transcript-correlation.test.ts` | Basic JSONL parsing and attachment name projection | No stable timestamps/IDs, provider variants, dedupe, large-file budgets, or replay correlation |
| `test/main/transcript-syncer-security.test.ts` | Rename/delete traversal containment | No symlink/junction race matrix for all reads/import paths |
| `test/main/security-policy.test.ts` | Remote navigation and remote tab webPreferences | Does not cover the three local `sandbox:false` views or MCP/Bridge capability policy |

### Required Test Matrix

| Priority | Layer | Scenario | Expected result |
|---|---|---|---|
| Critical | Bootstrap/process | Start standalone MCP/control-plane mode with GUI app already running | No second browser owner/profile; deterministic attach or fail-closed result |
| Critical | MCP stdio | Capture stdout from process start through shutdown | Only valid MCP frames; all logs on stderr |
| Critical | Catalogue | Compare listed tools, schemas, risk class, and dispatcher registrations across MCP and WebSocket adapters | One authoritative catalogue; no unreachable or transport-only cases |
| Critical | Browser target | Queue action for tab A, switch visible tab to B, navigate/reload/crash A | Action never affects B; stale A binding rejects or reconciles explicitly |
| Critical | Workspace target | Run request names missing, traversal, symlink/junction, relocated, or changed Workspace | Fail closed; no `process.cwd()` or `e:\Work` fallback |
| Critical | Mutation receipts | Crash/timeout before dispatch, after dispatch, after acceptance, and after effect before terminal receipt | At-most-once dispatch; accepted uncertain state becomes durable `unknown`; no auto-retry |
| Critical | Recovery | Restart control plane with queued/running/unknown/completed runs and late receipts | Deterministic replay/reconciliation without duplicate tool or provider calls |
| Critical | Terminal ownership | Two Workspaces run commands/processes concurrently; kill/restart one | Cwd/output/PID/port and shutdown remain isolated; no unrelated process killed |
| Critical | Security | Default external client lists/calls mutation, terminal, profile, and eval tools | Only policy-granted tools visible/callable; denials are stable typed errors |
| High | Artifact boundary | Large DOM, screenshot, terminal output, transcript attachment | Bounded metadata/artifact ref returned; no inline huge base64 in run/event state |
| High | Antigravity adapter | Receipt has correct ID but wrong Workspace/digest/host epoch; late file arrives after timeout | Rejected/quarantined unless exact original binding matches |
| High | Backend contract | Codex spike and Antigravity adapter emit the same normalized text/tool/usage/error events | Backend-neutral Run service remains unchanged between adapters |
| High | Provider uncertainty | Backend disconnects after paid/model request dispatch | Attempt becomes durable unknown/interrupted; no automatic duplicate completion |
| High | Local view security | Toolbar/sidebar/terminal preloads under sandboxed settings | Required API parity works without Node/global leakage |
| Medium | Compatibility import | TranscriptSyncer imports/synchronizes legacy session twice | Idempotent projection; standalone IDs/timestamps and delivery truth remain stable |
| Medium | Shutdown | stdin close, SIGTERM/app quit, window close with active run/process | Owned timers/watchers/transports/processes stop; no orphan or hung test process |

### Test Files Likely Needed

- `test/main/control-plane-runtime.test.ts`
- `test/main/control-plane-contracts.test.ts`
- `test/main/capability-catalogue.test.ts`
- `test/main/browser-control-adapter.test.ts`
- `test/main/workspace-registry.test.ts`
- `test/main/terminal-capability-adapter.test.ts`
- `test/main/run-store-recovery.test.ts`
- `test/main/execution-backend-contract.test.ts`
- `test/main/antigravity-execution-adapter.test.ts`
- `test/main/mcp-server.test.ts`
- `test/integration/mcp-stdio-process.test.ts` or an equivalent spawned-process test included by the package test script
- Focused Electron E2E only when GUI attachment/browser ownership changes; no such test directory currently exists

## Dependency And Overlap Analysis

### Plan 260817-1931: Chromium-First Native Harness

This plan already owns Project identity/runtime isolation, Workspace/chat/terminal
ownership, Harness utility supervision, CapabilityBroker, leases, durable
receipts, and recovery. Its phase frontmatter says done, but its index still says
phases 1-5 pending, and the source files named by those phases do not exist.

Standalone overlap:

- Phase 3 “Add Project Workspace Chat and Run Ownership” duplicates 260817 phases 2, 4, and 7.
- Phase 5 “Broker Browser Files and Terminal Tools” duplicates 260817 phase 6.
- Phase 6 “Persist and Recover Standalone Runs” duplicates 260817 phases 2, 5, 6, and 7.

Avoidance rule: make Phase 2 choose one authority. Either (A) this plan depends on
verified implementation of the 260817 contracts and only adds standalone
transport/backend adapters, or (B) this plan explicitly supersedes named 260817
phases for the current simplified tree and imports their accepted invariants.
Do not implement parallel Project IDs, run journals, broker catalogues, leases,
or terminal managers under new names.

### Plan 260817-2217: Project UI And Workflow

This plan owns Project Home/window UI, browser shell/layout, Workspace/chat/run
presentation, terminal UI, evidence UI, and post-fix QA presentation. The live
renderer remains `toolbar.html`, `sidebar.html`, and `terminal.html`; its claimed
React/project renderer files are absent.

Standalone overlap:

- Phase 9 “Ship Standalone Theme QA MVP” overlaps UI plan phases 8 and 9 if it
  includes annotation, evidence, QA views, browser-control banners, or layout.
- Any Project window, binding rail, renderer, or dock work belongs to the UI plan.

Avoidance rule: standalone Phase 9 should own backend-neutral QA orchestration,
contracts, artifacts, and release gating only. Reuse the UI plan for visible
surfaces, or explicitly scope the MVP to the existing sidebar without claiming
the documented Project UI has shipped.

### Plan 260818-1533: Project Harness Coding Tool Loop

This plan owns the in-app model-tool-model loop, provider structured tool
normalization, the coding tool catalogue, broker dispatch, continuation, and
durable tool events. It explicitly excludes an external MCP server or CLI. The
live source files cited by its report are absent in this checkout, although the
plan claims only live-provider verification remains.

Standalone overlap:

- Phase 4 execution-backend/Codex work overlaps provider normalization and loop
  orchestration unless limited to a backend adapter contract and empirical spike.
- Phase 5 browser/files/terminal catalogue directly duplicates its v1 tool map.
- Phase 6 run persistence duplicates its durable run/tool event ownership.

Avoidance rule: reuse one normalized `ExecutionBackend` and one capability
catalogue for both in-app and standalone callers. Keep the standalone plan's new
scope to process/transport independence, attachment/authorization, backend
selection, and compatibility adapters. Do not fork tool names or continuation
semantics.

## Recommended Phase Boundaries

1. **Reconcile and freeze authority.** Inventory live behavior, resolve which
   earlier contracts are dependencies versus superseded decisions, and add
   characterization/security tests. This is a hard gate.
2. **Create transport-neutral contracts and lifecycle.** Define Project,
   Workspace, Chat, Run, events, artifacts, execution backend, and control-plane
   attachment without yet changing browser behavior.
3. **Consolidate the capability catalogue.** Adapt MCP and WebSocket to one
   dispatcher; start with read-only browser inspection and explicit targets.
4. **Add durable run/receipt storage.** Migrate useful command-client/ledger
   behavior; preserve unknown/no-auto-retry and recovery semantics.
5. **Add safe Workspace and terminal adapters.** Only after ownership,
   containment, leases/policy, process tracking, and tests exist.
6. **Spike backend adapters.** Prove Codex and later DeepSeek against the same
   normalized contract; keep Antigravity behind its protocol-v2 compatibility
   adapter.
7. **Ship a bounded Theme QA vertical slice.** Reuse browser/artifact/tool/run
   services and whichever UI plan is authoritative; do not introduce a separate
   QA store or browser controller.

## Risks And Recommendations

- **Highest risk: false architectural authority.** “Done” phase labels and docs
  conflict with the live tree. Phase 2 must require source/test evidence, not
  labels, before depending on earlier work.
- **Highest security risk: external mutation surface.** Current MCP default tools
  mutate the browser, and BridgeServer exposes eval directly. Ship no standalone
  external endpoint until catalogue policy and attachment ownership are tested.
- **Highest correctness risk: implicit targeting.** Active tab and heuristic
  Workspace selection can redirect work. New control-plane APIs must never use
  those fallbacks.
- **Highest duplication risk: a fourth dispatcher.** Consolidate registry, MCP,
  and WebSocket before adding standalone transports.
- **Highest recovery risk: multiple ledgers.** Select one durable run/mutation
  authority; the in-memory pending-delivery list and new JSON DeliveryLedger are
  migration inputs only.
- **Process risk: MCP inside Electron.** Decide and test whether standalone means
  a plain-Node process attached to a running GUI or a headless browser owner. The
  security model already rejects MCP-owned Chromium; changing that requires an
  explicit threat-model decision.

## Unresolved Questions For The Controller

1. Does “standalone” mean a plain-Node control plane attached to an existing
   AntiFan GUI runtime, or may it own a browser when no GUI is running? Current
   security docs require attachment and forbid MCP-owned Chromium.
2. Are plans 260817-1931 and 260818-1533 intended as still-binding architecture,
   or should this new plan formally supersede their absent implementation for
   this simplified repository?
3. Is Phase 9 allowed to change the renderer, or must it expose Theme QA through
   the existing sidebar while plan 260817-2217 retains UI ownership?
4. Which backend is required for the first shippable vertical slice: Codex,
   Antigravity compatibility, or both? The answer changes Phase 4/8 ordering but
   should not change the backend-neutral contracts.

