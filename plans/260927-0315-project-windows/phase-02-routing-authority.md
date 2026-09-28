---
phase: 2
title: "Trusted affiliation and sender-scoped routing"
status: in-progress
priority: P1
effort: ""
dependencies: [1]
---

# Phase 2: Trusted affiliation and sender-scoped routing

> Implementation status (2026-09-27): steps 1–4 are implemented and verified, step 7 is partially verified,
> step 8 is not started. Step 5 is implemented in source — terminal creation resolves the sender's
> verified workspace (and `capsuleId` now crosses the terminal-daemon wire) — and its live acceptance
> has since run: the project-window matrix reports 36 passed, 0 failed, 3 hardware-only blocked rows,
> including `R2b` (per-window terminals: input, listing and diagnostics, plus the refusal of a named
> foreign session) and `R2c` (a mint that names no cwd lands in the window's own workspace and capsule).
> The earlier revision of this note cited `R7` for that acceptance; `R7` is the close-idle-A row and
> proves B's terminal session survives A closing, which is a different claim. Evidence, including a
> channel-parity audit against the pre-migration host and the two-window Electron probe, is in
> [reports/phase-02-verification.md](reports/phase-02-verification.md);
> the terminal-scoping lane has its own report, [reports/per-window-terminal-scoping.md](reports/per-window-terminal-scoping.md).
> The checklists below are the phase contract; only the items marked `[x]` were verified.

## Overview

Route creation and operations through verified project/workspace/capsule relationships before constructing pages. Preserve the existing attachment authority, not a new window permission system.

## Requirements

- GUI focus never supplies agent authority.
- A project can contain multiple workspaces; projectId, workspaceId and capsuleId remain distinct.
- Conflicts fail closed; missing required agent context retains existing errors. Historical unresolved pages use Unassigned.
- Shared session pools and target revision checks remain singular.

## Architecture

Dependency map: authenticated intent → capability transport → BrowserControlPort → existing NativeTabHost tab authority → owning shell. Renderer intention → validated sender mapping → local tab operation. Explicit cross-window search activation has a separate Main-validated user navigation entrypoint.

Extend existing capsule metadata with optional explicit projectId/workspaceId references and a versioned migration marker. Main validates references against existing registries. On explicit project/workspace open, establish the relationship using the supplied existing IDs. For legacy capsules, canonical root-path equality is only a migration candidate: accept only a unique existing workspace/project match; missing or ambiguous matches remain Unassigned. Never pick first match, active capsule or create a project from an authenticated request's untrusted path. Multiple workspaces in a project retain individual capsules and partition policy.

For a new user tab, use the shell's selected verified workspace; for an agent child use the bound parent's verified workspace and capsule, cross-checked against authenticated project/workspace. Native window.open inherits its source. Creation must atomically reserve ownership with the tab ID before making it externally visible; adoption failure cleans up only the newly created child and does not retarget its parent.

## Related Code Files

Paths relative to `E:/Work/apps/AntiFan`.

| Action | File | Change |
|---|---|---|
| Modify | src/main/project/workspace-capsule.ts | Explicit association metadata, unique legacy mapping |
| Reuse/modify | src/main/project/project-registry.ts; src/main/project/workspace-registry.ts | Validate existing identity relationships, no duplicate registry |
| Modify | src/main/tools/browser-control-port.ts | Carry verified affiliation through openTab and host interface |
| Modify | src/main/tools/capability-transport.ts | Preserve authenticated context and close admission seam |
| Modify | src/main/browser/native-tab-host.ts | createTab/adoptChildTab containment and sender-local resolution |
| Modify | src/main/index.ts | Host adapter no longer drops affiliation |
| Modify | src/shared/contracts.ts | Minimal tab/shell projection metadata |
| Modify | src/shared/control-plane-contracts.ts | Only if explicit host context typing requires it; keep error vocabulary |
| Modify | test/unit/browser/open-tab-anchor-liveness.test.ts; test/unit/browser/session-scoped-tab-listing.test.ts | Child identity, stale anchors and visibility boundary |
| Modify | test/main/project-workspace-ownership.test.ts; test/main/workspace-capsule.test.ts | Mapping and migration behavior |
| Modify | test/integration/concurrency-multi-project.test.ts; test/integration/mcp-multi-tab-e2e.test.ts | Exact routing across shells |

Six existing directly relevant test files listed; none proves physical multi-window focus today.

## Implementation Steps

1. **[done]** Trace all BrowserHostPort.createTab implementations and callers, NativeTabHost.createTab/adoptChildTab callers, native popup handlers, restore path and terminal-preview creation. Record references before interface edits; update each caller in one cutover.
2. **[done]** Remove absent-capsule → globally-active fallback for routed creation. Represent explicit Unassigned separately from omitted required context.
3. **[done]** In BrowserControlPort.openTab, validate context.target against its parent anchor before host.createTab (current creation precedes adoption). Carry authenticated projectId/workspaceId explicitly through capability transport, openTab and the index host adapter. A stale target cleared by transport must not become permission to use the GUI capsule. Validate the full runtime/workspace/tab chain before allocation and preserve existing generation, quota and lease errors.
4. **[done, except teardown]** Make IPC local by default. Validate sender origin/frame and surface role, not only a webContents numeric ID. Registration is now once per process and every call resolves its sender live from the window directory, so a stale numeric-id mapping cannot be reused; dropping subscriptions and releasing a closed window's registration is phase 4's close contract.
5. **[done]** Filter sidebar/terminal initial state and events by explicit workspace association without changing existing PTY cwd or calling TerminalManager.setCapsule on focus. `TERMINAL_CHANNELS.START` and `antifan:terminal:new-session` now resolve the sender's verified workspace (`resolveTerminalCreationTarget`) and pass explicit `cwd`/`capsuleId` to creation when the user omits cwd; `capsuleId` crosses the daemon wire via `HostStartParams`/`HostNewSessionParams` (`src/main/terminal-daemon/protocol.ts`), and every caller of the daemon-backed singleton awaits creation. Never inherit global TerminalManager.currentCwd from another window. Terminal popouts keep their bound session's workspace. Live acceptance in A/B has now run: matrix `R2b` proves the scoping half (a window's input, list and diagnostics name only its own session, and its typing stays in its own session while another window owns the process-wide active one) and the new `R2c` proves the creation half — a mint through a window's own sidebar with no cwd given lands in that window's verified workspace and capsule, in a run where the previous window's session was the one the manager most recently touched (36 passed, 0 failed, 3 hardware-only blocked; the ambient-cwd/ambient-capsule half of this step is pinned in the unit lane, `test/main/project-window-persistence.test.ts`, which sets both and shows neither is inherited — see [reports/per-window-terminal-scoping.md](reports/per-window-terminal-scoping.md)).
6. **[partial]** Keep GET_SUGGESTIONS history/bookmark/network behavior intact; cross-project search is a separate explicit user operation in phase 3. Foreign tab IDs are refused at the port and the owning window is resolved per call; `GET_SUGGESTIONS` itself is untouched and cross-project search still waits on phase 3.
7. **[partial]** Test conflicts, duplicate roots, stale IDs, parent closure during child creation, session separation and unchanged partition selection. Conflicts, duplicate roots, stale anchors and session separation have passing tests; unchanged partition selection still has no direct test. "Parent closes while its child is being created" is covered for the native popup path: the deferred creation re-checks the opener's exact tab and closes a child that adoption refuses (`test/main/native-popup-inheritance.test.ts`, three cases), and the popup now inherits the opener's partition and user agent mode as well as its capsule.
8. **[not started]** Migrate all zero-argument active-tab presentation queries to an explicit sender/shell context, including getInitialState and broadcastState. The phase-1 directory's tabId-to-owner mapping is the single presentation index; no deprecated global getActiveTabId shim. Agent callers continue to require exact targets.

## Function and Interface Checklist

- [x] BrowserHostPort.createTab, openTab and index adapter signatures migrated together.
- [x] NativeTabHost.createTab/adoptChildTab/window-open/restore paths covered.
- [x] AuthenticatedCapabilityContext and BrowserTarget remain authoritative.
- [ ] Sender registration and removal are lifecycle-bound. (Registration is now once per process and resolution is computed from live windows, but no teardown unregisters a closed window: phase 4.)

## Test Scenario Matrix

| Scenario | Result |
|---|---|
| B agent opens while A focused | Child B/workspace/capsule; A focus unchanged |
| Caller project conflicts with parent | No WebContents allocated; existing policy failure |
| Same canonical root belongs to multiple projects | Legacy page Unassigned, no guessed ownership |
| Parent dies before adoption | Child creation fails/cleans up, no orphan target |
| A renderer passes B tab ID | Refused except explicit user search navigation |
| Two sessions in one project | No expanded close/rebind authority |

## Success Criteria

- [x] Six focused regression owners plus new edge cases pass after compile. (All six pass: see the verification report; the added cases cover anchor liveness, Unassigned refusal, affiliation conflicts, capsule v1→v2 migration, ambiguous roots, and pool-adoption failure.)
- [ ] Live background open/navigation observes unchanged foreground input and exact authenticated target. (The exact authenticated target is proven for routing; unchanged foreground *input* under real OS focus is phase 5.)
- [ ] No cookie or partition migration from window assignment.

## Risk Assessment

The control-plane defaults and GUI capsule IDs now share one runtime authority: the `projectRegistry` instance in `index.ts` is both the `WorkspaceCapsuleManager` affiliation authority and `ControlPlaneRuntime.projects`, and `synchronizeCapsulesWithRegistry` projects every explicitly-affiliated capsule into it at boot, per `ensureWindow`, and in `whenReady`. If no unique mapping exists, show Unassigned/recovery instead of creating false authority. Unknown callers are an implementation blocker, not permission for a permissive default. Cross-project search is a deliberate user exception to local navigation, not an exception to agent authorization.
