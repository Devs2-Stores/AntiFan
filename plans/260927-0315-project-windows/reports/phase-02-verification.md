# Phase 02 — verification report

Scope: "Trusted affiliation and sender-scoped routing" (`phase-02-routing-authority.md`).
Every line below is a command that was run against this working tree on 2026-09-27, with its observed result.

## What changed

| Area | Change |
|---|---|
| Chrome IPC registration | `NativeTabHost` registered ~115 channels directly with `ipcMain` in its constructor, so a second project window threw "Attempted to register a second handler". Registration is now the declarative `NativeTabHost.CHROME_ROUTES` table installed once through `src/main/browser/ipc-router.ts`. |
| Sender authority | `TabAuthorityDirectory` resolves a sending `webContents` to `{ host, surface }` from live windows on every call: unknown sender, subframe, and wrong-surface invocations are refused before the route body runs. |
| Per-window hosts | `src/main/index.ts` holds one adapter over a directory of hosts; tab-scoped calls resolve the owning window instead of a single global host (74 closures converted). |
| Affiliation | Capsules carry optional `projectId`/`workspaceId` plus a migration marker; persisted file version 2 with a lossless v1 upgrade; legacy capsules are never guessed from an ambiguous root. |
| Routed creation | `BrowserControlPort.openTab` verifies the anchor's own capsule affiliation against the authenticated target before any WebContents is allocated, and binds the child to the verified capsule instead of whatever capsule is globally active. |

## Evidence

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | clean |
| Compile | `npx tsc -p ./` | clean |
| Two project windows, one registration | `npm run smoke:two-shell` | 8/8 checks: 115 channels after window A, still 115 after window B; each window's toolbar resolves to its own host; a toolbar action in B changes only B; a toolbar-only channel from the sidebar is refused `CHROME_SURFACE_MISMATCH`; a tab page is refused as a non-chrome surface |
| Channel parity with the pre-migration host | one-shot audit, method below | pre-migration host registered 115 distinct channels; the route table declares 115; 0 lost, 0 added |
| Main lane | `node --test --test-force-exit ".compiled/test/main/**/*.test.js"` | 1460 tests, 1459 pass, 0 fail, 1 pre-existing skip |
| Unit lane | `node --test --test-force-exit ".compiled/test/unit/**/*.test.js"` | 668 tests, 668 pass, 0 fail |
| Integration lane | `node --test --test-force-exit ".compiled/test/integration/**/*.test.js"` | 13 tests, 13 pass, 0 fail |
| `open-tab-anchor-liveness` | focused run | 10/10 (4 pre-existing + 6 new gate cases) |
| `workspace-capsule` | focused run | 10/10 (v1→v2 migration, no invented affiliation, ambiguity refusal) |
| `project-workspace-ownership`, `session-scoped-tab-listing`, `concurrency-multi-project`, `mcp-multi-tab-e2e` | focused runs | 1/1, 2/2, 1/1, 2/2 |

Probe artifacts: `two-shell-ipc-probe.json`, `two-shell-ipc-probe.log` in this directory. The probe runs against a throwaway profile, so it does not touch a working profile.

Channel-parity method (one-shot, run before the cutover was committed, so it cannot be re-run unchanged — after a commit `HEAD` already contains the router). It extracted every channel name passed to `ipcMain.handle`/`ipcMain.on` from `git show HEAD:src/main/browser/native-tab-host.ts`, collected the declared names from `NativeTabHost.CHROME_ROUTES`, and diffed the two sets: 115 vs 115, symmetric difference empty. A future change to the route table needs its own audit rather than this script.

## Defects found and fixed while verifying

1. **Unknown-tab behaviour regression.** The fan-out initially resolved the owning host with a function that threw `Error('No live project window owns tab …')`. The pre-migration host answers an unknown id gracefully (`closeTab`/`switchTab`/`navigate`/`reload` return `false`, `isTabOffscreen` returns `false`, `getTabWebContents` returns `null`, `getDocumentGeneration` returns `1`) and reports stale eval/DOM targets as `CapabilityError('TARGET_STALE')`. A blanket throw would have turned every stale-id call into an exception — including the port's own cleanup path after a failed adopt, which would have masked the original error. Resolution now falls back to the bootstrap host, which is exactly the single-window path this replaced. `hostForTabOrBootstrap` in `src/main/index.ts`.
2. **Payload with no consumer.** The port passed `projectId`/`workspaceId` into `createTab` while the host ignores them, which forced an unchecked cast in the adapter. Only `capsuleId` (the binding) and `anchorTabId` (which window) are passed now; the adapter consumes the latter and never forwards it.
3. **Probe judged routing before the chrome views had loaded.** Sender resolution matches a view by the page it actually loaded, so the probe read a pre-load URL and reported four routing failures that were really a race. The probe now waits for every chrome view to resolve, and its "wrong surface" check names the observed refusal code instead of implying a silent allow. The stale expectation that `antifan:toolbar:toggle-sidebar` is toolbar-only was replaced by the real contract: `src/preload/standalone-preload.ts` really does invoke it, so that route declares toolbar+sidebar+terminalPopout, and the check now asserts both the allowance and a genuine toolbar-only refusal.
4. **Six test doubles lacked the new optional port method**, so routed creation was refused with `CAPABILITY_NOT_FOUND` in suites that were about something else (`tab-lease-fast-rebinding`, `chromium-terminal-comprehensive-tab-interaction`, `render-surface-and-viewport-gates`, `terminal-tab-affinity`, `two-tier-concurrency`, `mcp-multi-tab-e2e`). Each double now answers with the project/workspace its own scenario asserts. No assertion was weakened or deleted.
5. **Source-text tests** in `mcp-dispatch-ipc-surface` and `preview-protocol-and-watcher` asserted that a channel was registered by an `ipcMain.handle` call in a specific source region. Registration is declarative now, so they were replaced by behaviour: the channel is present in the installed set, and a refused sender never reaches the route body. The surface and sender gates themselves are covered once, centrally, in `test/main/ipc-router.test.ts`.

## Not done in this phase (do not read the checkboxes as complete)

- **Step 5**, terminal workspace resolution, was still unimplemented at this run: `TERMINAL_CHANNELS.START` and `antifan:terminal:new-session` still inherited `TerminalManager.currentCwd` from whichever window last set it. *Later on 2026-09-27 it landed*: creation now resolves the sender's verified workspace (`resolveTerminalCreationTarget`) and `capsuleId` crosses the daemon wire (`HostStartParams`/`HostNewSessionParams`). Its live acceptance has since re-run against the current tree: [per-window-terminal-scoping.md](per-window-terminal-scoping.md) records 36 passed / 0 failed / 3 hardware-only blocked rows (matrix `R2b` for per-window scoping, and `R2c` — added for this — for creation resolving the window's own workspace and capsule; `R7` is the close-idle-A row and does not cover creation). This report still describes its own run, not current behaviour.
- **Step 8**, zero-argument active-tab queries: `getActiveTabId` is still answered by the first registered host for `bridge-server` and `app-menu` callers. The chrome renderers no longer need it (their channels resolve per window), but the bridge and menu surfaces do.
- **Step 7** is partially covered: affiliation conflicts, Unassigned capsules, stale anchors, duplicate roots and session separation have tests; an explicit "parent closes while its child is being created" case does not.
  *Addendum (recorded after this report's run, not part of it):* that case is covered now, for the native popup path, by `test/main/native-popup-inheritance.test.ts` — the deferred creation re-checks the opener's exact tab and creates nothing when it is gone, and a child that adoption refuses is closed again. The same file shows the popup inheriting the opener's partition and user agent mode, which the run recorded above did not measure (it opened a popup from a default-profile tab, where inheritance and coincidence are indistinguishable). The matrix has since gained `R2c` for terminal-creation provenance; `R7`, cited elsewhere for that acceptance, is the close-idle-A row and does not prove it.
- The task asks for window teardown (`TabAuthorityDirectory.unregister`, host disposal, dropping subscriptions on renderer destruction). The directory is written for it and the resolver ignores destroyed windows, but nothing calls it yet — that is phase 4's close/shutdown contract.
- Live acceptance for "background open/navigation leaves foreground input untouched" beyond the two-shell probe (real OS focus, real navigation) belongs to phase 5.
