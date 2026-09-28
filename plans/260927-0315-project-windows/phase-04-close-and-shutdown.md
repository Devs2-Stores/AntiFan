---
phase: 4
title: "Protected close and coordinated application quit"
status: pending
priority: P1
effort: ""
dependencies: [1, 2, 3]
---

# Phase 4: Protected close and coordinated application quit

## Overview

Coordinate close admission with attachment/operation admission and native unload. No tray mode, silent force-kill, global dispose from a project window or transactional-Undo claim.

## Requirements

- Busy or unknown-use pages block window destruction with actionable reasons.
- New arrivals and bindings cannot be lost during asynchronous unload.
- Closing A preserves B and detached daemon sessions.
- Last browser close and explicit Quit use the same shared-work gate.

## Architecture

Dependency map: close event → close coordinator → authoritative live-use snapshot/admission gate → per-page native close → shell disposal. Quit additionally reserves application admission and checks all shared work before disposing services. Proposed `project-close-coordinator.ts` is a focused state machine, not a second task scheduler.

States: open → checking → closing-pages → closed, or back to open after refusal/veto/failure. Prevent the native shell close synchronously, then await policy/unload. Serialize duplicate close/quit requests. A closing tab reservation is consulted by attachment creation/rebind/adoption and operation admission; a final check alone is insufficient. Do not hold a JS mutex while waiting on user unload interaction. Release reservations on cancellation/error. New tabs created outside the snapshot keep the shell open. Quitting reserves all application admission before the final busy check; cancellation reopens admission.

Busy evidence includes active attachment authority, active/queued/awaiting runs, in-flight browser/QA/workflow operations and verified live agent affinities. An idle shell process alone is not proof of agent activity; terminal state unavailable means unknown, not idle. Provide links/identities to existing stop/release controls. No force override. Do not invent run completion from transport disconnect.

## Related Code Files

Paths relative to `E:/Work/apps/AntiFan`.

| Action | File | Change |
|---|---|---|
| Create | src/main/browser/project-close-coordinator.ts | Close reservations and per-page outcomes |
| Modify | src/main/index.ts | before-quit, window-all-closed, shutdown admission and reentrancy |
| Modify | src/main/browser/native-tab-host.ts | Native unload-aware close and local cleanup |
| Modify | src/main/browser/project-window-manager.ts | Shell lifecycle and final-browser counting |
| Modify | src/main/run/attachment-registry.ts | Admission checks for bindings/rebinds |
| Modify | src/main/tools/capability-transport.ts; src/main/tools/browser-control-port.ts | Admission and in-flight accounting integration |
| Reuse/modify | src/main/run/run-service.ts | Active work query, no new execution model |
| Reuse | src/main/browser/terminal-manager.ts; src/main/terminal-daemon/daemon-spawner.ts | Preserve detached lifecycle; no host-kill operation |
| Modify | test/main/native-tab-host-agent-lifecycle.test.ts; test/main/process-lifecycle.test.ts; test/main/attachment-runtime-scoping.test.ts | Close/dispose boundaries and binding admission |
| Create | test/main/project-close-coordinator.test.ts | Deterministic race/partial close outcomes |

Three existing regression owners and one new state-machine suite. Real native unload requires Electron proof, not a fake successful close mock.

## Implementation Steps

1. Read current closeTab, native unload handlers, attachment mint/rebind/adoption, transport queues and shutdown. Enumerate every path that can admit work or destroy a view before changing the close gate.
2. Centralize page close reservations at the singleton tab authority. Name the consumers at the seam rather than leaving them implicit: AttachmentRegistry issue/rebind/adoption must consult the reservation and refuse while a page is reserved, and CapabilityTransportAdapter dispatch plus BrowserControlPort in-flight accounting must register and clear the counter for every admitted operation so the busy snapshot is not a guess. Reject/retry through existing error vocabulary, never silently redirect.
3. Snapshot visible member IDs. On busy/unknown, keep the entire shell and present reasons before closing any page. Register exact-instance `destroyed` and `will-prevent-unload` observers before calling `webContents.close({ waitForBeforeUnload: true })`; close returns no awaitable result. Never call preventDefault on will-prevent-unload: it overrides the veto. A missing terminal outcome is unknown and retains the shell; no timeout-driven destroy. Explicitly manage child WebContentsView contents because shell closure does not prove their disposal.
4. Report closed/skipped/failed separately. On first veto stop the serial queue immediately, restore a surviving active page's native layout within that shell without raising another window, and release reservations. New arrivals, ownership changes or busy state retain the shell. Detached/offscreen automation views remain outside a project snapshot but inside application busy checks. Coalesce repeated window close and application Quit into the same active attempt; application admission reservation and committed shutdown are separate states.
5. Count browser shells, not BrowserWindow.getAllWindows (capture hosts and terminal popouts are auxiliary). Last browser close refuses if shared work is active/unknown; idle success initiates orderly Quit and closes idle auxiliaries.
6. Explicit before-quit prevents default until the same guard completes. Keep admission reserved while native child, shell and auxiliary closures settle; approval alone does not authorize service teardown. Any late shell/auxiliary veto retains functioning services and releases reservations. Only after all native closures succeed enter committed shutdown and perform awaited persistence/session flush, global authority disposal, bridge close and daemon-client disconnect once. Use guarded will-quit/final app.quit reentry for asynchronous cleanup, not early before-quit disposal; window-all-closed is not emitted during app.quit. Do not call daemon shutdownHost or kill external processes.
7. Preserve existing daemon restart-survival policy. In-process fallback PTYs require active/unknown protection before disposal. Intentionally detached daemon is not an orphan; no new hidden browser engine may survive.
8. Remove global shutdown/app.quit from the per-project `closed` callback (current index.ts:531–548). Call preventDefault synchronously before any await in close/before-quit/will-quit listeners. Use attempt-specific native-close authorization, reset on veto/error; never interpret early isShuttingDown as authorization. Cleanup failure is not success: no unconditional app.quit in finally. Test repeated Quit and late veto preserve service access. Trace updater quit entrypoints if present because quitAndInstall has different ordering.

## Function and Interface Checklist

- [ ] closeTab/dispose and all shell destruction paths participate.
- [ ] Attachment mint/rebind/adopt and capability admission share reservation state.
- [ ] before-quit/window-all-closed/shutdown reentrancy traced.
- [ ] Busy evidence source failures retain a visible recovery route.

## Test Scenario Matrix

| Scenario | Result |
|---|---|
| Binding arrives during unload | Refused while reserved; cannot bind then be destroyed |
| New tab during close | Survives, shell retained |
| Second page vetoes after first closed | Honest partial outcome; no Undo promise |
| Quit while B run queued/awaiting | Refusal, no service teardown |
| Close A with idle B visible | Only A shell/pages disposed |
| Idle final browser plus terminal popout | Orderly GUI exit; daemon survival unchanged |
| Busy query errors | Unknown/refused, controls remain usable |
| Shell or auxiliary veto after child pages close | Shared services remain usable; honest partial outcome |

## Success Criteria

- [ ] Race tests and existing lifecycle suites pass.
- [ ] Native beforeunload veto and two-window close exercised in real Electron.
- [ ] Daemon process/session identity persists across allowed GUI close/reopen.

## Risk Assessment

Fail-closed can become permanent lockout if stale attachments cannot be released. Verify existing expiration/release/recovery paths before release; otherwise replan the recovery path, not bypass the gate. OS forced termination is outside graceful-close guarantees. A background window receiving unload UI must not steal focus without an explicit user close request.

## Electron contract sources

- [WebContents.close and unload](https://www.electronjs.org/docs/latest/api/web-contents#contentscloseopts)
- [will-prevent-unload cancellation meaning](https://www.electronjs.org/docs/latest/api/web-contents#event-will-prevent-unload)
- [Application quit lifecycle](https://www.electronjs.org/docs/latest/api/app#appquit)
- [Child view resource management](https://www.electronjs.org/docs/latest/api/base-window#resource-management)

These document API constraints; the installed Electron build still requires the phase's native probe.

## Wave 3 wiring status (`src/main/index.ts`)

- One `PageCloseReservations` instance is injected into every named consumer (each window's
  `NativeTabHost`, `AttachmentRegistry`, capability transport and browser control port), and one
  `ProjectCloseCoordinator` owns the user close (`onCloseRequest`), the explicit Quit
  (`before-quit`), the last browser shell going away and `window-all-closed`. `preventDefault()`
  runs synchronously before every await; `app.quit()` is reached only from a committed report.
- Admission order is application-wide first, then per-page, at every seam that can admit work:
  `AttachmentRegistry` mint/rebind/adoption, `CapabilityTransportAdapter` dispatch, the
  browser-control port's pool/wait/viewport gates, and `NativeTabHost.admitAgentAction` (the agent
  action entry points). A reserved page refuses `TARGET_STALE`; a quit in progress refuses
  `RUNTIME_DRAINING`. Works admitted before the reservation are what the busy snapshot counts, via
  the same table (`beginAdmittedOperation`).
- Outcomes are honest and bounded. A page is `closed` only from the destroyed fact, `vetoed` when
  it refuses to unload, and everything else is `unknown`, which retains the shell. Silence is
  bounded on every surface that can go unanswered: the coordinator bounds each answer it awaits
  through its injected seams, the host bounds the platform's own answer inside `closePage` (that
  is the bound that releases the tab's reservation, so a later attempt can ask the page again),
  and the shell bounds its own close attempt, settling `closed` only when the window is provably
  destroyed and owing the same disposal audit either way. A bound never decides a closure and
  nothing is destroyed on a timer. *Measured on this platform*, a close issued while a previous
  refusal is still being processed is answered with no event at all, so a gate that trusted the
  event alone never settled and application admission stayed held — the bounds are what turn that
  into a retryable refusal. A refusal always names the existing stop/release controls for the work
  that blocks it, and the rows that pin this behavior are in
  `test/main/close-outcome-deadline.test.ts`.
- Member pages are read from the hosting tab authority (`withHostMembers` in `index.ts`), not from
  `ProjectWindowManager`'s own tab directory: that map has no writer anywhere in `src/`, so the
  close surface reported an empty member list and a shell closed with its pages never
  busy-checked, reserved or closed. The host answers for the pages it presents, which is also the
  source `ownerOfPage`, `closePage` and the tab directory use.
- A binding whose owner process is provably gone is released (`revokeGoneOwnerAttachments`) before
  each live-use measurement, so a crashed client cannot hold a window shut until its lease expires.
- Verification: `scripts/probe-quit-coordination.cjs` (real Electron, throwaway profile and data
  root, in-process fallback terminals) drives the shipping entrypoints; evidence in
  `plans/260927-0315-project-windows/reports/quit-coordination-probe.{json,log}`. Phase-5 criteria
  and their instruments are listed in the design spec's acceptance receipts.
