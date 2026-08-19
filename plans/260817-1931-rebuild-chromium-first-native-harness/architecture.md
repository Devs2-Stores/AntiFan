# Architecture Decision

## Decision

Use one Project-owned BrowserWindow and ProjectRuntime inside a shared Electron
Main process. Each materialized Project also owns a supervised Harness utility
process.

```text
AppSupervisor
  ProjectCatalog
  CredentialVault
  ProjectRuntimeManager
    ProjectRuntime(projectId)
      BrowserWindow
      ProjectBrowserGateway
        NativeTabHost
        persistent Chromium partition
        project tab registry
      WorkspaceRegistry
        Workspace -> terminals/processes/checkpoints
      ProjectStateStore
        chats/turns/runs/events/artifacts
      HarnessSupervisor
        one utility process for this materialized Project
```

The shared Main process is infrastructure authority, not a global product
session. It must not retain singleton active Project, active Workspace,
NativeTabHost, AgentEngine, ChatStore, TerminalService, or broadcast run channel.
App-level update services, the Project catalog, and the encrypted credential
vault remain shared infrastructure. A Project stores only its provider-profile
selection/handle; sharing one credential across Projects must be explicit.

## Why Project Is The Aggregate Root

- Project identity survives folder moves and worktree changes.
- Chromium login/profile state belongs to the customer/theme Project, while a
  Workspace is one concrete checkout or worktree used to edit code.
- A Project may have several Workspaces, but they share the Project browser and
  can open different dev-server tabs.
- Normal UX remains one Project with one default Workspace; additional Workspaces
  appear only when the user adds another checkout/worktree.
- Chats belong to the Project and are pinned to one Workspace. Browser evidence
  may come from any Project tab but retains its exact origin binding.
- Project deletion and Chromium-profile deletion are separate decisions.

## Alternatives

| Option | Result | Decision |
|--------|--------|----------|
| One app window with switchable Project runtimes | Lower window overhead, but reintroduces mutable current-project routing and hidden-host ambiguity | Reject |
| One BrowserWindow/runtime/partition per Project in shared Main | Visible ownership, strong storage/tab isolation, manageable lifecycle and memory | Adopt |
| One full Electron OS process per Project | Strongest crash boundary, but high RAM, startup, IPC authentication, update, version-skew, and orphan-process costs | Defer as optional future isolation mode |

## Ownership Invariants

1. Every durable and IPC record carries `projectId`; project-owned records also
   carry their local resource ID and revision/generation.
2. Main maps every renderer sender WebContents to exactly one ProjectRuntime and
   rejects a mismatched `projectId` before dispatch.
3. Every tab belongs to one Project. Popup-created tabs inherit that Project.
4. Every terminal belongs to `{projectId, workspaceId, cwd}` and never changes
   target when the UI switches Workspace.
5. Every ChatSession belongs to one Project and exactly one Workspace.
6. Every HarnessRun captures immutable Project, Workspace, ChatSession, provider,
   browser epoch, and initial browser binding.
7. Harness may list and read all tabs in its Project. Tab-sensitive mutations
   require explicit `tabId`, `webContentsId`, and `documentGeneration`.
8. No resource lookup falls back to globally focused window, active Project,
   active Workspace, or active tab during tool execution.
9. Chromium sessions, Electron objects, credentials, and lease secrets never
   enter the Harness utility process.
10. Main is the sole durable writer and side-effect authority.
11. Project materialization/teardown is single-flight and generation-fenced;
    callbacks from an older runtime cannot mutate its replacement.
12. Each live tab has a `tabRuntimeInstanceId`; renderer crash/destruction revokes
    bindings immediately without waiting for browser epoch rotation.

## Project And Workspace Model

```text
Project
  id: durable UUID
  chromiumPartition: stable unique partition owned by this Project
  browserEpoch
  workspaces[]
  chats[]
  runtimeState

Workspace
  id: durable UUID
  projectId
  canonicalPath/folderUri
  fingerprint + generation
  terminals[]
  processes[]
  checkpoints[]

HarnessRun
  projectId + workspaceId + chatSessionId
  immutable initial BrowserBinding
  leases + mutation receipts + event sequence
```

A tab may optionally carry a Workspace association for a dev-server URL, but
browser ownership remains Project-level. Switching Workspace does not close,
move, or retarget browser tabs.

## Chromium Semantics

- New Projects use `persist:antigravity-project-<UUID>`, never a path hash.
- One explicitly selected imported Project may retain
  `persist:antigravity-browser` as its stable unique legacy alias. The catalog
  enforces one-Project ownership; the partition is never cloned or renamed.
- Let Chromium own cookie/localStorage/cache persistence. Do not export broad
  plaintext cookie JSON.
- A Project window shows only that Project's tabs and terminal/chat state.
- Allowed popups are recreated/adopted into the source Project registry; unmanaged
  native popup windows are denied.
- Reopening the same Project focuses its existing runtime rather than creating a
  second Chromium owner.
- Browser restart rotates `browserEpoch`; restored tabs receive new runtime IDs.
  Old run bindings become interrupted/stale and require explicit reconciliation.

## Harness Semantics

- One utility process per materialized Project provides crash and context
  isolation between Projects. It is trusted app code, not an OS security sandbox;
  authorization and secret protection never rely on process isolation alone.
- Utility proposes revisioned run-state transitions and owns context assembly,
  model/tool orchestration decisions, pruning, and final synthesis.
- Main validates each transition against the expected run revision, persists the
  transition and event atomically, then acknowledges the committed sequence.
  Utility recovery starts only from Main snapshots and replayed events.
- Main owns ProviderGateway credentials/network streaming and sends normalized
  bounded deltas to Utility; Utility never receives raw credentials.
- Main's Project CapabilityBroker owns browser, filesystem, terminal, process,
  checkpoint, artifact, and mutation execution.
- Multiple read-only runs may coexist. Workspace mutations require an exclusive
  workspace lease; browser mutations serialize per tab.

## Add Element And Multi Annotate

- Selection starts from a sender-validated Project window and snapshots an exact
  `{projectId, browserEpoch, tabId, tabRuntimeInstanceId, webContentsId,
  documentGeneration}`.
- A single annotation session remains on one tab/document. Tab switch or
  navigation pauses/fails it as stale.
- A multi-tab evidence collection is an aggregate of explicit per-tab sessions,
  never an implicit continuation after switching tabs.
- Each selection produces an ordered `SelectionEvidence` plus artifact handles.
- Main creates the Turn atomically with attachment references before renderer
  clears the composer.

## Post-fix QA

```text
baseline identity
  -> workspace mutation receipt
  -> dev-server/process readiness
  -> reload explicit target tabs
  -> browser binding transition
  -> DOM/network/render stability barrier
  -> screenshot + DOM + console + network + accessibility probes
  -> comparison
  -> evidence-backed QaRun report
```

QA may target several tabs inside one Project. Each target retains its own URL,
scenario, viewport/device, browser epoch, and generation lineage. Missing or
mismatched baselines are failures, never zero-diff successes.

## Lifecycle And Memory

Project runtime states are `foreground`, `background-active`, `background-warm`,
`suspended`, `recovering`, and `closed`.

- Materialize Chromium and Utility lazily when a Project opens.
- Closing a window with live work offers explicit keep-running or stop-and-close
  behavior. Keep-running hides the window and enters `background-active` without
  destroying Chromium, Utility, PTYs, or tracked processes.
- Keep a deterministic memory budget/LRU for idle warm Projects.
- A Project with an active run, PTY, tracked process, capture, annotation session,
  lease, pending/unknown mutation, download, DevTools/auxiliary WebContents, or
  debugger/CDP attachment is not suspendable.
- Suspension flushes Chromium storage and persists tab metadata, then destroys
  views/window and stops an idle utility process.
- PTYs and live page JavaScript state are not serializable. The app must not claim
  exact restoration or silently kill them to satisfy suspension.
- Profile deletion requires an exclusive Project lock, durable tombstone, awaited
  Chromium flush/destruction, and delete-on-restart recovery. It remains separate
  from deleting the Project record.

## Release Position

Conditional GO. Multi-project operation is NO-GO until project identity is
mandatory in every IPC/tool/event contract and global singleton/broadcast paths
are removed. Background or concurrent mutations are NO-GO until immutable
bindings, leases, accepted-versus-terminal receipts, and crash reconciliation
are production-tested.
