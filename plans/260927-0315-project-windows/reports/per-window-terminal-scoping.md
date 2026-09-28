# Per-window terminal scoping — verification report

Scope: every terminal channel answers for the window that sent the request. A session id
arriving from a renderer is an address, not a capability. Related to phase-02 step 5
(sender-scoped routing) and phase-03 (project window surfaces).

Every command below was run against this working tree on 2026-09-27; the numbers are the ones
observed, not targets.

## The rule

1. A window's session scope is the provenance tag it can prove: the capsule it is affiliated
   with, plus the sessions it created itself, plus the sessions no window claimed **only** when
   the window has no workspace at all.
2. A route that names a session is checked against that scope before the manager is touched
   (`ChromeSessionScopeError` / `does not belong`), and a route that omits the session resolves
   this window's own session instead of the process-wide active one.
3. Projections (sidebar state, listings, diagnostics) are narrowed by the same scope, so a
   window is never handed another project's session ids, names, capsules or buffers.

## What changed

| Area | Change |
|---|---|
| Scope seam (`native-tab-host.ts`) | `windowTerminalProvenance`, `windowSessionScope`, `isSessionVisibleToWindow`, `admitsSessionForWindow`, `terminalStateForWindow`, `windowActiveSessionId`, `runAgainstWindowActive`, `visibleTerminalSessions`, `scopeTerminalDiagnostics`. One rule, used by every projection and route. |
| Route gate (`ipc-router.ts`) | `ChromeSessionScopeError` plus the declarative `sessionArgs` hook: 21 terminal routes declare the session ids in their payload, and the router refuses a foreign id before the route body runs. |
| Implicit-target routes | `GET_FULL_BUFFER`, `KILL`, `RESTART`, `INPUT`, `RESIZE`, split, rebind and affinity routes resolve through `windowActiveSessionId(sender)` / `runAgainstWindowActive` — the process-wide active session is no longer what "the active terminal" means to a window. |
| Listings | `LIST_SESSIONS` returns `visibleTerminalSessions()`; the sidebar projection and the annotation picker (`selectAnnotationTargets`) read the same narrowed list. |
| Diagnostics | `DUMP_DIAGNOSTICS` awaits the seam's answer and narrows the report (sessions, `sessionCount`, `activeSessionId`, `subscribers`) to the sending window. `TerminalManager.getDiagnostics()` went back to returning the process-wide report: narrowing is a presentation rule and lives with the other window-scoped projections, so there is exactly one implementation of it. |

## Evidence

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | clean |
| Compile | `npm run compile` | clean |
| Main lane | `npm run test:main` | 1839 tests, 1838 pass, 0 fail, 1 pre-existing skip |
| Unit lane | `npm run test:unit` | 1242 tests, 1237 pass, 0 fail, 5 pre-existing skips |
| Focused suite | `node --test --test-force-exit .compiled/test/main/project-window-persistence.test.js` | 34/34, including the new diagnostics row |
| E2E, real app | `node --test .compiled/test/e2e/project-windows.test.js` | 1/1, exit 0, 18 rows |
| Live matrix | `node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs` then `--verify-orphans` | 36 passed, 0 failed, 3 blocked — the blocked rows are hardware-only (`R1-HW`, `R2-HW`, `R6-HW`). Receipt: `project-windows-matrix.json` |

Two matrix rows carry this lane, both in `scripts/probe-project-windows-matrix.cjs`.

`R2b` (scoping) drives two project windows A/B, each with its own terminal session in its own
workspace, then asks A for diagnostics while the process-wide active session belongs to B.

`R2c` (creation provenance) closes the half `R2b` cannot reach: `R2b` creates its sessions through
the manager, so it says nothing about where a session minted *by a window* opens. `R2c` mints
three sessions through each window's own sidebar preload with **no cwd named at all** — B first,
then A twice — and reads each `cwd` back from that window's own `listTerminals()`, plus the capsule
from `sessionCapsuleId`. B going first is the point: by the time A asks, the terminal state another
window last touched is B's, which is exactly the wrong answer for A. It also asserts the two roots
differ before comparing anything (Windows temp roots are matched in both their written and resolved
spellings), because two windows sharing one root would make the comparison vacuous.

What this row does **not** show, and must not be read as showing: the daemon manager's ambient
`currentCwd`. In daemon mode the handle is a proxy whose `getCurrentCwd()` answers a local cache
seeded at connect and then overwritten from session events — including the active session's own cwd,
because `getSessionState()` carries no cwd field (`daemon-client.ts`, `_updateLocalCache`). The
receipt therefore records that reading under `proxyCachedCwdBeforeA` /
`proxyCachedCwdWasAnotherWindows`, as context about the session A was minting alongside, and the
row claims nothing about ambient manager state. The ambient path is pinned where it can actually be
manipulated — the unit lane, which holds the real manager: `test/main/project-window-persistence.test.ts`
sets the manager's ambient cwd to a foreign workspace (`:1182`) and the ambient capsule to another
window's (`:1214`), then asserts that `TERMINAL_CHANNELS.START` and `antifan:terminal:new-session`
still receive exactly `{ cwd: <this window's workspace>, capsuleId: <this window's capsule> }`
(`:1203-1204`) and that `resolveTerminalCreationTarget()` never returns the foreign capsule
(`:1221-1222`). That is the disconfirmation the live row cannot perform, and the two together are
the claim: the route resolves the sender, and the unit lane shows what it would have resolved
otherwise.

## Failing before, passing after

Same row, same harness, only the route changed. Before (`diagnosticsKeysFromA`):

```json
{ "listedFromA": ["terminal-2"], "diagnosedFromA": [], "diagnosticsKeysFromA": ["fanoutMessages"], "diagnosticsSessionCountFromA": null }
```

After (strengthened row):

```json
{ "selectedA": true, "selectedB": true, "activeSessionAfterBSwitch": "terminal-3",
  "listedFromA": ["terminal-2"], "diagnosedFromA": ["terminal-2"],
  "ownMarkerReachedA": true, "ownMarkerReadErrorA": null,
  "ownMarkerReachedB": false, "ownMarkerReadErrorB": null,
  "afterSwitchMarkerReachedA": true, "afterSwitchMarkerReachedB": false,
  "crossMarkerReachedB": false, "crossMarkerReadErrorB": null,
  "diagnosticsKeysFromA": ["timestamp","sessionCount","activeSessionId","sessions","subscribers","fanoutMessages"],
  "diagnosticsSessionCountFromA": 1, "diagnosticsActiveSessionIdFromA": "" }
```

Three facts are visible in that pair. The pending-promise spread returned the fanout counter and
nothing else — under the detached daemon's proxy, the diagnostics payload had been empty for
every window, not just cross-project ones. `activeSessionId` is blank for A rather than naming
`terminal-3`, which belonged to B at that moment. And `activeSessionAfterBSwitch: "terminal-3"` is
the row proving its own premise before it relies on it.

The row was hardened while verifying, because three of its claims were weaker than they read:

- `selectedA`/`selectedB` were recorded but never asserted, so a silently failed selection would
  have left the process-wide active session on A and let A's second write pass for reasons that
  have nothing to do with per-window routing. Both are asserted now, and B's own diagnostics are
  read to prove the process-wide active session is really B's before A types again (B's report
  blanks a sibling's active session, so naming `terminal-3` there *is* the proof).
- The marker reader caught every read error and returned an empty transcript, so an unreadable
  sibling session satisfied all three "B never saw the marker" assertions. A read failure is now
  carried separately (`*ReadError`) and every absence assertion fails when the read did not
  succeed.
- The R2b observable text now says "after B is observed to own the process-wide active session"
  rather than "after B makes it active", which is what the row measures.

`test/main/project-window-persistence.test.ts` pins the same rule in the unit lane: the route is
driven twice, once against the in-process report and once against a proxy that answers with a
promise, and the deferred case carries a foreign subscriber row to prove the subscriber list is
narrowed by the same scope. The popup path is a separate contract with its own report:
[popup-inheritance.md](popup-inheritance.md).

## Deliberately still process-wide

These are not gaps in this lane; they are callers that own their own authority decision.

| Surface | Why it stays as it is |
|---|---|
| Daemon RPC handlers (`daemon-entry.ts`) | The daemon executes the session the request names. The caller already decided; the daemon holds no window identity. |
| `bridge-server.ts` mobile-grant surface | The mobile plane authorises with `mobileMayDriveTerminal(mobileGrant, ...)`, a different authority model than a desktop window's affiliation. |
| Annotation prompt target (`tab-devtools-host.ts`) | The picker reads the narrowed list now, but the prompt's fallback still resolves the process-wide active session. It needs a port-aware change and its own live proof. |
| Tab diagnostics (`tab-diagnostics.ts`) | Console/failure records per tab, not per terminal session. |

## Not asserted live

Subscriber narrowing is asserted in the unit lane only: the live row cannot mint renderer acks
without a second renderer, and the sessions rows it does assert travel through the same scope
function.
