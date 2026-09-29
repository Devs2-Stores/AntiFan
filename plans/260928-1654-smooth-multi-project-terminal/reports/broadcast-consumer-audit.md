# Broadcast Consumer Audit — `antifan:terminal:session` payload

Phase 6, plan `260928-1654-smooth-multi-project-terminal`.

## Broadcast shape (before)

`TerminalManager.emitSession()` → `getSessionState()` →
`{ activeSessionId, sessions: SessionSummary[], splitSessionId, snapshot, snapshotThroughSeq }`
where each `SessionSummary.buffer` (and `splitBuffer`, and the top-level `snapshot`) carries a
JSON-budgeted transcript **tail up to 160 KiB total** (`GLOBAL_JSON_BUFFER_BUDGET_BYTES`).

Delivery paths for the same payload:
1. `TerminalManager`/`DaemonTerminalProxy` `'session'` event → `native-tab-host.sendTerminalProjections`
   → `antifan:terminal:session` IPC → `standalone.js` (sidebar + every terminal popout).
2. `daemon-entry.ts:152` forwards the identical projection as `HOST_EVENT.session` to every
   `DaemonClient`/`DaemonTerminalProxy`; `daemon-client._updateLocalCache` stores it and serves
   `listSessions()`/`getSessionState()`/`getSession()` from the cache.
3. `bridge-server.ts:2153` rebroadcasts it over WebSocket; `broadcastEvent` rebuilds a
   `mobileSessionFrame` (`snapshot` = active row's `buffer`) for companion grants → `mobile-remote-html`.
4. `native-tab-host.ts` popout/`did-finish-load` initial pushes — these additionally send the
   **unbounded** `s.buffer` via `tm.getSession(activeId, { includeBuffer: true })`.

## Every consumer of `buffer` / `splitBuffer` / `snapshot` / `snapshotThroughSeq`

| # | Consumer | Reads | Use | Replacement under pruning |
|---|----------|-------|-----|---------------------------|
| 1 | `standalone.js` `resolveHydrationSnapshot` → `atomicHydratePane` / `atomicHydrateSplitPane` (L2385, L2397, L2470) | `providedSnapshot` fallback only | Pane hydration | **Already RPC-first**: `api.getFullBuffer` is authoritative; the pushed snapshot is only a fallback when the RPC is missing. No change needed; preview still feeds the fallback path. |
| 2 | `standalone.js` `getOrCreateTerminalPane` (L2747-2858) | `s.buffer`, `s.snapshotThroughSeq` | Seed pane then `atomicHydratePane` + `syncPaneWithBackend` (`syncTerminalView` RPC) | Unchanged — hydration is RPC; row preview keeps the no-RPC fallback working. |
| 3 | `standalone.js` `syncTerminalPool` (L2861) | `s.buffer`, `state.snapshot`, seq fields | Decide lazy vs eager pane creation | Unchanged — a session with an empty preview just stays lazy until activation; `bufferLength` still says it has content. |
| 4 | `standalone.js` `mountSplit` + `onTerminalSession` handler (L3292, L7048-7052) | `splitEntry.buffer` / `activeSession.splitBuffer`, seq | Split pane mount snapshot | Unchanged — `atomicHydrateSplitPane` pulls `getFullBuffer` authoritatively (probe `terminal-split-hydration-probe.cjs` verifies). |
| 5 | `standalone.js` `previewTranscriptText` + `loadFullTranscriptInto` (L1319, L1331) | `session.buffer`, then `api.getFullBuffer` | Read-only sleep/lossy preview | Unchanged — preview text renders instantly (small tail), `getFullBuffer` upgrades to full transcript. This is the "small preview" the phase keeps. |
| 6 | `standalone.js` activity/tab-strip paths (`notifySessionActivity`, `isSessionSleeping`, `renderTabs`) | `state`, activity frames — never the buffer | 💤/streaming indicators | Unchanged. |
| 7 | `mobile-remote-html.ts` `adoptSleepingTranscripts`, `data.snapshot`, `sessionBuffers` (L741-763, 982-993) | `s.buffer`, `s.snapshot`, `data.snapshot` | Phone transcript panes | **NEW bridge RPC `antifan.terminalGetFullBuffer`** (`terminal.sync` scope, `userPlaneMayReachTerminal` gate) = the same `getFullBuffer` the GUI uses. `ensureTranscriptForActive` fetches on first render, per session generation. Adoption is guarded so a preview can never truncate a longer streamed cache, and `\x1b[3J` in a data frame resets the cache (clear-screen parity with desktop). |
| 8 | `bridge-server.ts` `broadcastEvent` → `mobileSessionFrame` (L3855-3878) | `activeSummary.buffer` → `snapshot` | Mobile frame snapshot | Preview `snapshot`; client-side guard (#7) prevents clobbering. |
| 9 | `bridge-server.ts` init payload `terminalSessions` (L1919, L1929) and `antifan:init` | `tm.listSessions()` rows | Mobile + attachment boot | Preview rows; phone fetches transcripts via #7. |
| 10 | `bridge-server.ts` `antifan.getTerminalSessions` / `terminalNewSession` / `terminalCloseSession` / `terminalRenameSession` / `terminalSwitchSession` responses (L2845-2964) | `tm.listSessions()` rows | Phone session lists | Preview rows; transcripts via #7. |
| 11 | `native-tab-host.ts` `sendTerminalProjections`, `toggleSidebar` push, `contents` send (L1738, L1905, L4584, L10919) | whole projection | Sidebar/popout pushes | Projection now carries preview rows only (removed at source in `listSessions`). |
| 12 | `native-tab-host.ts` popout `did-finish-load` initial pushes (L13367-13384, L13474-13490) | `tm.getSession().buffer` — **unbounded full buffer** | First paint of a popout | Switched to the active row's preview `buffer` + `snapshotThroughSeq`; pane hydrates via `getFullBuffer` (`resolveHydrationSnapshot`). Also fixes missing `snapshotThroughSeq` on this projection. |
| 13 | `daemon-entry.ts` `tm.on('session')` forward (L152), `listSessions`/`start`/`getSessionState` RPCs | projection / rows | Wire to GUI proxy | Unchanged — emits the already-pruned shape. |
| 14 | `daemon-client.ts` `_updateLocalCache`, `listSessions`, `getSessionState`, `getSession`, reconnect replay (L260-330, 373-375, 516-597) | cached rows incl. `snapshot` | GUI-side sync facade | Unchanged — cache stores preview rows; `getFullBuffer`/`getTerminalDelta`/`syncTerminalView` already RPC the daemon. `getSession({includeBuffer:true})` RPCs the daemon — the only full-buffer path, kept. |
| 15 | `terminal.list` capability (`terminal-capabilities.ts:393`) | `listSessions(paged)` rows | MCP terminal list | Rows are previews now (same 16 KiB budget the daemon proxy could always only serve). Transcript consumers use `terminal.wait` `outputTail` / `getFullBuffer`. Documented contract change. |
| 16 | `daemon-entry.ts` `shellLooksReady` (L561) | `tm.getFullBuffer().buffer` | Wait-ready scan | Uses `getFullBuffer` directly — unaffected. |
| 17 | `TerminalOutputRouter`, `run-state-service`, `selectAnnotationTargets`, `element-picker`, `control-plane-runtime`, `index.ts` health/`listSessions` scalars, omp-hooks | `id`/`state`/`cwd`/`ownerKey`/`capsuleId` only | Scoping/liveness | Unchanged — never read `buffer`. |
| 18 | Tests/probes: `terminal-renderer-smoke.cjs`, `terminal-recovery-smoke.cjs`, `terminal-paint-bench.cjs`, `terminal-transport-sync.cjs`, `terminal-split-hydration-probe.cjs`, `terminal-rename-space.test.cjs`, `e2e-combined-preload.js` | mock `buffer`/`snapshot` fields | Renderer harnesses | Already model "hydrate via getFullBuffer" (smoke test comment: "the session-state payload carries only a tail; the pane must hydrate from the authoritative full buffer"). Keep working — preview is still a bounded tail. |

## Verdict

Every consumer that needs transcript content already has (or now gets) an RPC path:
`getFullBuffer` (renderer, mobile via new `antifan.terminalGetFullBuffer`), `getDelta`/`syncTerminalView`
(renderer seq sync), `getSession({includeBuffer:true})` (popout audit path, kept for scalar use).

Pruning change: `GLOBAL_JSON_BUFFER_BUDGET_BYTES` 160 KiB → **16 KiB** total preview budget
(~90% broadcast bytes reduction). `SessionSummary.buffer`/`splitBuffer`/`snapshot` remain present
as **preview tails** so hydration fallbacks, the sleep preview, and legacy producers keep working;
`snapshotThroughSeq`/`bufferLength`/`sessionGeneration` are unchanged.

`listSessions(paged=false)` keeps returning the full composed transcript — it is the explicit
non-paged escape used by `terminal-sleep-lifecycle` tests and any main-process caller that needs
the whole transcript in one shot.
