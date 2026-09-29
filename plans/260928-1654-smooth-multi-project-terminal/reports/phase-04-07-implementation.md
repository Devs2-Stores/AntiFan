# Phase 4 + 7 Implementation Report

## Executed
- Phase 04 — O(1) Session Routing: **done**
- Phase 07 — Renderer Lazy Xterm: **done**

## Files changed
- `src/main/browser/terminal-output-router.ts` — NEW (270 lines). Singleton holding the seam's single `data` listener; `sessionId → Set<TerminalRouteHost>` map refreshed by session lifecycle events + signature-gated `session` pushes + host `invalidateRoutes()` calls; lazy once-per-session route computation for unannounced sessions; seam-agnostic (TerminalManager or DaemonTerminalProxy — same event names/shapes via `HOST_EVENT_TO_LOCAL`).
- `src/main/browser/native-tab-host.ts` — `setupTerminalSubscriptions` drops its per-host `data` listener and registers with the router (unregister folded into `terminalSubscriptionReleases`, so `dispose()` releases it). New `admitSession(sessionId)` delegates to `isSessionVisibleToWindow` (no senderId → host-scope answer). `handleTerminalDataChunk` is now public and is the router's delivery point — 4 ms coalescing + ≤256 B bypass preserved verbatim. `dispatchTerminalData` sends `TERMINAL_CHANNELS.DATA` only to surfaces whose `terminalDisplayedSessions` set contains the session; all other admitted surfaces get `TERMINAL_CHANNELS.ACTIVITY` (same payload, no xterm path). `terminalWindowBindingChanged()` (popout/terminal-window bind, unbind, close) + `setWindowWorkspaceAffiliation` + `dispose()` all call `invalidateRoutes()`.
- `src/main/index.ts` — `TerminalOutputRouter.getInstance().attach(terminalManager)` next to the canonical manager install; new imports (`terminal-output-router`, `node:events`).
- `src/shared/contracts.ts` — `TERMINAL_CHANNELS.ACTIVITY = 'antifan:terminal:activity'` with rationale comment.
- `src/preload/standalone-preload.ts` — `onTerminalActivity` binding (same shape as `onTerminalData`).
- `src/renderer/standalone.js` — the `onTerminalData` body extracted to `handleIncomingTerminalChunk`, registered on BOTH data and activity channels. Chunks now peek `rawTerminalPool` instead of `terminalPool.get` — a session with no pane is acked (`throughSeq`-aware) and left to hydrate on activation; hidden panes mark `needsRehydrate` so `syncTerminalPool` runs `atomicHydratePane` on activation (256 KiB tail via `sliceHydrationTail` + `getFullBuffer` fallback + seq-delta replay). `renderTabs` was already keyed diff (wrap reuse by `data-session-id` + `reorderTabChildren`) — no rebuild exists to remove.
- `test/renderer/standalone-harness.ts` — `terminalActivityListeners` + `emitActivity` seam.
- `test/main/terminal-output-router.test.ts` — NEW, 8 tests.
- `test/renderer/terminal-lazy-pane.test.ts` — NEW, 4 tests.
- `tsconfig.p10.json` — scoped build config for the two test files (siblings mid-edit made full-project emit unsafe).
- `plans/.../phase-04-o1-session-routing.md`, `phase-07-renderer-lazy-xterm.md` — status → done.

## Proof
`node --test .tmp-p10-build/test/main/terminal-output-router.test.js`:
```
✔ 7 hosts 1 session: only the owning host receives each chunk
✔ zero admission calls per steady-state chunk after warm-up        ← isSessionVisibleToWindow-equivalent = 0 per chunk
✔ first chunk of an unannounced session computes the route once, then never again
✔ popout-bound session reaches the popout host and unassigned output reaches the manager
✔ owner transfer re-routes the session on the next session push
✔ session push with unchanged ownership does not recompute routes
✔ 20 register/unregister cycles keep the seam listener counts flat ← no listener leak
✔ host registering after sessions exist still receives pre-existing session output
pass 8 / fail 0
```

`node --test .tmp-p10-build/test/renderer/terminal-lazy-pane.test.js`:
```
✔ 20 background sessions bursting on the data channel materialize zero panes  ← 0 xterms, acks preserved
✔ the activity channel drives the tab indicator and ack without a pane        ← is-streaming on, no pane
✔ activating a background session hydrates the full transcript then applies live deltas ← writes.join === fullBuffer, then +delta
✔ a known session that never got a pane still acks and does not create one on data
pass 4 / fail 0
```

`npx tsc --noEmit --incremental --tsBuildInfoFile .compiled/.tsbuildinfo-p10 -p tsconfig.json` — clean (0 diagnostics) at the final run.

## Notes
- `isSessionVisibleToWindow` calls per chunk = 0 by construction: `dispatchData` is a `Map.get`; admission is computed only on route refresh events (once per session/ownership change, not per chunk), proven by the counter test.
- Unassigned/manager fallback preserved: `managerAll` admits every row including `agent:` and unclaimed — verified by test.
- `.tmp-p10-build/` + `tsconfig.p10.json` are throwaway build artifacts; left in place because deletion requires approval under the destructive-command rule.
- Per-popout surface suppression uses the `terminalDisplayedSessions` sets recorded on every projection push + `did-finish-load`; ACTIVITY still carries the full `TerminalDataPayload`, so a late-activating renderer applies it harmlessly.

## Status: DONE
