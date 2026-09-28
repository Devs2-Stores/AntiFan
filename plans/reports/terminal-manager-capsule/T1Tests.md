# T1Tests — tests for the terminal → capsule handover

Status: DONE. `tsc -p ./` exit 0; 92/92 in the five files below.

## Files touched

| File | Change |
|---|---|
| `test/main/terminal-assign-capsule.test.ts` | NEW. 18 rows: Layers 1–4 (seam, window scope, agent read-only, assign route). |
| `test/renderer/terminal-capsule-picker.test.ts` | NEW. 6 rows: context-menu action → picker → filter → `assignTerminalCapsule(sessionId, capsuleId)`. |
| `test/main/ipc-audit.test.ts` | `TERMINAL_CHANNELS.ASSIGN_CAPSULE` in the required terminal-channel list (preload ↔ host parity). |
| `test/renderer/standalone-harness.ts` | `capsulePickerPopover` element; `openProject` / `listCapsules` / `assignTerminalCapsule` on `StandaloneApi`; `contextMenuActions` seeding. |
| `test/renderer/terminal-tab-categories-sleep.test.ts` | Action pin: `contextMenuActions` includes `assign-capsule`. |
| `test/main/chrome-ipc-routes.test.ts` | Route-count pin 115 → 116 (the one new route). |
| `test/main/terminal-daemon-client.test.ts` | EXTENDED: new `describe('DaemonTerminalProxy — owner handover contract')` with 3 rows over the file's existing deferred-call transport fake + the proxy's real `wireEvents` wiring. |

## Anchors (what each layer rests on)

- Seam: `TerminalManager.transferSessionOwner` re-stamps `ownerKey` + `capsuleId` in one call; refuses unknown/closed/blank-key/blank-capsule with `false`; the re-stamped row is what `startTerminal` restores off disk.
- Scope: `windowSessionScope` (`native-tab-host.ts:5304`) + `isSessionVisibleToWindow` (`:5501`) — manager (`unassigned` + its own chrome) sees every row; a project window sees only its own key, key-less rows fall back to the window's capsule tags (`acceptsUnclaimed` only when the window has no verified workspace).
- Gate: `assertManagerMayOperate` (`:5353`) → `MANAGER_AGENT_SESSION_READ_ONLY` for `agent:*` under the manager; reads (`GET_FULL_BUFFER`) still pass, writes never reach the manager.
- Daemon facade: `DaemonTerminalProxy.transferOwner` (`daemon-client.ts:566`) sends `HOST_METHOD.transferOwner` with the three fields, resolves `r.transferred === true`, and rejects when the transport cannot answer — the cache the host scopes by (`sessionOwnerKey` / `sessionCapsuleId`) carries the new owner once the host's session push lands.
- Route: `TERMINAL_CHANNELS.ASSIGN_CAPSULE` (`native-tab-host.ts:3753-3806`) → `INVALID_PAYLOAD` / `UNKNOWN_CAPSULE` / `CAPSULE_WITHOUT_PROJECT` / `TARGET_WINDOW_ABSENT` / `SESSION_NOT_VISIBLE` / `UNKNOWN_SESSION`; a committed quit still throws `RUNTIME_DRAINING` out of the admission instead of answering.

Fixtures double only the OS boundaries: the Electron module (`test/support/electron-stub`), the PTY spawn step (prototype `spawn` returning a faithful session record), and the capsule registry. The manager, host, route table and scope rules under test are the real ones.

## Verifier commands

```bash
npm run compile                 # tsc + copy-static; copy-static is REQUIRED, see below
node --test --test-force-exit ".compiled/test/main/terminal-assign-capsule.test.js"
node --test --test-force-exit ".compiled/test/main/ipc-audit.test.js" ".compiled/test/main/chrome-ipc-routes.test.js"
node --test --test-force-exit ".compiled/test/main/terminal-daemon-client.test.js"
node --test --test-force-exit ".compiled/test/renderer/terminal-capsule-picker.test.js" ".compiled/test/renderer/terminal-tab-categories-sleep.test.js"
```

`npm run test:main` / `test:fast` cover the same files once compiled. Row counts: daemon 12/12 (3 new), assign-capsule 18/18, ipc-audit + routes green, renderer 6 + 1 files green — 104/104 across the six files.

## Two things a verifier must know

1. **`tsc` alone is not enough for renderer rows.** The harness loads the *copied* renderer at `.compiled/src/renderer/standalone.js`. Before `node scripts/copy-static.mjs` runs, that copy is stale and every picker row fails with "the picker must offer a search input" — a false red, not a code fault. Use `npm run compile`.
2. **A manager-shell seed is required.** The context-menu row is enabled only when `shellScope.ownerKind === 'unassigned'`; rows load with `initialState: { projectWindow: { owner: { kind: 'unassigned' } } }` and clear `apiCalls` after boot, because a manager shell reads the capsule index once at startup.

## Assertions I could not write

None. Every frozen interface in the brief exists and is exercised. Two behaviours the brief did not name are now pinned because they are observable and would otherwise regress silently: the route's `INVALID_PAYLOAD` refusal, and the `RUNTIME_DRAINING` throw on a committed quit.

## Not covered (by design, stated so it is not mistaken for coverage)

- Nothing crosses a real daemon socket: the daemon rows drive `DaemonTerminalProxy` over the file's own deferred-call transport fake joined to the proxy's real `wireEvents` wiring, so the request shape, the true/false/rejection trichotomy and the cache seam are covered, while the wire protocol itself is not.
- The renderer's *window open* hop (`openProject`) is stubbed per row to `{ status: 'OPENED' }` / `{ status: 'CANCELLED' }`; the real open path (`openProjectWindow`) is not driven.
