---
phase: 1
title: "Shared tab authority and project window shells"
status: in-progress
priority: P1
effort: ""
dependencies: []
---

# Phase 1: Shared tab authority and project window shells

> Implementation status (2026-09-27): the shared plan below is implemented — `ipc-router.ts`, `tab-authority-directory.ts`,
> `project-window-shell.ts`, `project-window-manager.ts`, and host resolution in `src/main/index.ts`. A live Electron probe
> opens two project windows against one registration set and proves per-window sender resolution; see
> [reports/phase-02-verification.md](reports/phase-02-verification.md). Phrases such as "proposed" below describe the
> planning contract and were not rewritten after implementation.

## Overview

Retain one NativeTabHost tab/automation authority. Extract per-window presentation rather than constructing multiple current hosts. Context: [spec](../../docs/superpowers/specs/2026-09-27-project-windows-design.md), [plan](plan.md).

## Requirements

- One shared bridge, control plane, terminal client and global IPC registration set.
- Project windows own only native view attachment, local selection, geometry and subscriptions.
- No second project registry, service runtime or compatibility alias layer.
- No public multi-window rollout until phases 2–4 are integrated.

## Architecture

Proposed new `ProjectWindowManager` owns a directory of project/Unassigned shells and serializes open requests. Proposed `ProjectWindowShell` owns BrowserWindow, toolbar/backdrop/sidebar views, local active tab and split layout. Existing NativeTabHost retains the global tab map, automation queues, session pools, CDP and capture authority. A tab has exactly one presentation owner. Existing Main bootstrap remains the shared-service owner; no new AppRuntime wrapper.

Dependency map: index bootstrap → manager → shells; NativeTabHost → manager to resolve tab/sender presentation. Shared bridge/control plane → singleton NativeTabHost. Neither shell owns terminal daemon shutdown.

### Proposed cross-phase interface contract

Define these types alongside the manager; phases 2–4 consume them rather than inventing another window directory. They are proposed APIs, not claims about current exports.

```ts
type WindowOwner =
  | { kind: 'project'; projectId: string }
  | { kind: 'unassigned' };
type OpenIntent = 'user' | 'agent';
interface ProjectWindowDirectory {
  ensureWindow(owner: WindowOwner, intent: OpenIntent): Promise<ProjectWindowShell>;
  shellForTab(tabId: string): ProjectWindowShell | undefined;
  shellForSender(webContentsId: number): ProjectWindowShell | undefined;
  assignTab(tabId: string, owner: WindowOwner): void;
  releaseTab(tabId: string): void;
}
```

`ensureWindow` deduplicates creation; user intent may present an existing shell, agent intent never does. `assignTab` rejects conflicting existing ownership and receives only Main-validated identity. Sender lookup is necessary but insufficient: phase 2 checks frame/surface role. `releaseTab` follows exact contents destruction, never transport disconnect. ProjectWindowShell contains presentation state only and cannot mint attachment authority.

### Per-task execution cycle

- [x] Add the phase matrix's first failing consumer-behavior test in its named test owner. (`test/main/project-window-manager.test.ts`, 8 cases)
- [x] Compile and run that focused test; record the expected behavioral failure rather than an unrelated import failure.
- [x] Implement the smallest ownership slice and migrate all its callers together. (shell owns BrowserWindow + chrome + geometry; host reads `this.shell`; 14 harness call sites migrated)
- [ ] Run focused tests and the real two-shell probe; capture failure/repair evidence. (focused suites green; two-shell probe blocked on the global IPC registration step below — a second host would register duplicate `ipcMain.handle` channels)
- [ ] Review the slice before proceeding to dependent phases. Commit only when separately authorized; no automatic publication.

## Related Code Files

Paths relative to `E:/Work/apps/AntiFan`.

| Action | File | Change |
|---|---|---|
| Modify | src/main/index.ts | Separate service startup from window open; replace global primary-window callbacks |
| Modify | src/main/browser/native-tab-host.ts | Extract window/view fields and layout/disposal; keep tab authority |
| Create | src/main/browser/project-window-manager.ts | Unique project-window directory and open serialization |
| Create | src/main/browser/project-window-shell.ts | Native presentation, local subscriptions, local active tab |
| Modify | src/main/browser/window-state.ts | Inject stable owner key rather than global filename assumptions |
| Modify | test/main/main-entry-bootstrap.test.ts | Behavior-level singleton startup coverage |
| Create | test/main/project-window-manager.test.ts | Duplicate opens, failure cleanup, local disposal |

Existing directly relevant baseline: two files `test/main/main-entry-bootstrap.test.ts`, `test/main/window-state.test.ts`; not evidence of existing multi-window coverage. Scout whole-repo counts disagreed and are not used as a certification baseline.

## Implementation Steps

1. Enumerate NativeTabHost constructor registrations, `setupToolbarIpc`, `setupTerminalIpc`, `setupSidebarIpc`, `setupFrameBackdropIpc`, `broadcastState`, `updateLayout`, `dispose`, plus index `createWindow`, `second-instance`, `activate`, menu and shutdown callbacks. Record each shared versus shell-local resource. Use LSP references if available; planning environment had no server configured.
2. Extract shells without changing tab identity. NativeTabHost construction no longer requires a permanent primary BrowserWindow. Route layouts and broadcasts through an explicit shell; eliminate global active-window fallback.
3. Keep IPC registration once. Sender-to-shell mapping covers toolbar, sidebar, backdrop and known terminal popout surfaces; unknown senders fail closed. Global/user navigation privileges are added explicitly in phase 3, not granted by accepting arbitrary IDs.
4. Migrate index startup, app events, menu callbacks, profile/partition housekeeping and metrics to aggregate live shells/tabs. One close never calls global NativeTabHost.dispose.
5. Keep the tab-restore writer singular and, critically, the tab-restore *reader* singular: exactly one global saved-tabs.json is loaded by the shared authority, never once per shell (today the load happens in the host constructor). No per-shell `saved-tabs-<owner>.json` files, otherwise every shell restores every project's tabs. Owner attribution rides inside the one versioned record set. Add versioned window metadata beside it; legacy reads remain idempotent and migration specifics stay in phase 3.
6. Add behavior tests for simultaneous opening, initialize failure, duplicate click, closing A while B remains. Remove obsolete source-layout assertions rather than preserving stubs.

## Function and Interface Checklist

- [x] NativeTabHost construction/disposal and service ownership inventoried.
- [ ] Per-shell active tab, split state, view bounds and broadcasts independent. (view bounds, chrome geometry and shell disposal are shell-owned now; per-shell active tab/split/broadcast is the routing-authority phase)
- [ ] App events and menu actions use explicit user shell context.
- [x] Shared daemon client, vault and protocols created once.

## Test Scenario Matrix

| Scenario | Expected proof |
|---|---|
| Two opens for A before first resolves | One window and one promise result |
| A fails initialization | No dead mapping; later explicit open succeeds |
| Dispose A | B views and shared automation remain usable |
| Unknown renderer sends IPC | Refused, never routed to focused shell |

## Success Criteria

- [x] Focused tests pass after compile; `npm run typecheck` passes.
- [ ] Throwaway real Electron two-shell probe proves no duplicate IPC handler exception or toolbar cross-talk; capture logs and remove probe afterward. (blocked: per-host `ipcMain.handle` registration must become one global set with sender→shell resolution first; the manager's `shellForSender` is the seam)
- [x] Product changes remain unexposed until routing and close gates land. (single project window; the manager directory admits exactly one owner today)

## Evidence (2026-09-27)

- `npm run typecheck` — clean; `npm run compile` — clean.
- Full pipeline `npm test`: `test:main` 1411+ passed / 0 failed after the harness migration; `test:fast` and `test:integration` exit 0 (they failed before the migration with `Cannot read properties of undefined (reading 'window'|'frameBackdropView')`).
- `test:e2e:strict` — pre-existing, documented, not a regression from this phase:
  - Run 1 failed the p95 tail gate (679ms vs a 120ms budget at p50 ≈ 13ms), run 2 failed it again (926ms), run 3 passed (exit 0), run 4 failed milestone 2 after the actionability gate logged `trusted click downgraded to synthetic: Element is disabled`.
  - The same assert on a pristine tree was already recorded in `plans/reports/260916-osr-capture-crash-fix-live-proof.md:83-88` (p95 867ms, 46 × `is gone and no failover target exists`), with the mechanism being an attachment that lost its bound tab. The same signature appears 82 times in this run's log, so this lane fails for the same pre-existing attachment-lifecycle reason and needs its gate reworked upstream.
  - Isolation recipe used for the real-boot evidence: `ANTIFAN_DATA_ROOT=<tmp>` alone is sufficient (`StorageLocations.getConfigDir/getProfileDir/getControlPlaneDir` all derive from it); `--user-data-dir` is inert because `index.ts` calls `app.setPath('userData', …)` from `ANTIFAN_USER_DATA`/`ANTIFAN_DATA_ROOT`, and the single-instance mutex keys off that resolved path. A probe launched without the override exits on the lock, and its `second-instance` delivery to the running app is focus-only (no http(s) argv).
- `.compiled/test/main/project-window-manager.test.ts` — 8/8.
- Live smokes: `smoke-split-review` PASSED, `test/e2e/site-mute-smoke` PASSED (both phases), `smoke-ephemeral-isolation` CERTIFICATION SUCCESSFUL, `smoke-background-multitasking` ALL CHECKS PASSED.
- Real boot through `index.ts` → manager → shell → host with an isolated data root (`ANTIFAN_DATA_ROOT=<tmp>`): `windowCtor`, `tabHostCtor`, `tabsRestored`, `firstVisible`, `windowCreated`, `browserRegistered`, `deviceRegistered` all emitted; 4 tabs restored and the first switch completed. A plain boot cannot be used as a probe while another AntiFan instance holds the single-instance lock — use a separate `ANTIFAN_DATA_ROOT`.
- Static-absence gate fails on a pre-existing finding (`scripts/smoke-mcp-industrial-e2e.cjs` sends a token in a query string on purpose to assert rejection); the same finding reproduces at HEAD, so it is not a regression from this phase.

## Risk Assessment

The singleton contains capture and presentation coupling. If extracting a shell requires duplicating the tab map or authority queues, stop and replan; do not create two sources of tab truth. Capture hosts and terminal popouts are auxiliary windows, not project shells. No destructive migration or unrelated host decomposition.
