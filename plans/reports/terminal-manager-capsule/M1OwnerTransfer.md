# Owner transfer (TerminalManager + daemon parity)

Status: DONE — implemented and proven end to end (40/40 checks: in-process manager lane + a real
`daemon-entry` child process over a real WebSocket with a real `DaemonTerminalProxy`), including the
base+split-pane cascade in both lanes.

## What changed

### 1. `src/main/browser/terminal-manager.ts` — the one sanctioned re-stamp

Signature (line **1232**):

```ts
public transferSessionOwner(sessionId: string, ownerKey: string, capsuleId: string): boolean
```

- Resolves the addressed id to its base session first — `const baseId = direct.splitOf || sessionId`
  (line **1240**), `const base = this.sessions.get(baseId) || direct` — the same shape `setCategory`
  uses (line 2283). Assigning a pane therefore moves the whole tab; assigning a tab takes its panes.
- Cascades over every `split.splitOf === baseId` record (loop at lines 1242-1244) and re-stamps
  `ownerKey` (line **1251**) + `capsuleId` (line **1252**) on the base and on each pane, marking each
  affected record dirty (`this.dirtySessionIds.add(s.id)`, line **1253**) exactly like `setCategory`
  does for its panes.
- Refusals, all `false` with no throw: unknown `sessionId`, `disposed`/`state === 'closed'` record,
  and an empty (or whitespace-only) `ownerKey`/`capsuleId`.
- No-op when every affected record already carries the target owner+capsule (line **1246**): returns
  `true` without writing or broadcasting.
- Sleeping and exited records transfer like running ones — their tabs are still on screen.
- Does NOT touch global creation state: `currentCapsuleId`, `currentCwd`, `creationOwnerKey` are all
  left alone; the call re-stamps existing records, it does not adopt anything, so the caller's next
  session still lands where it would have (asserted below).
- Persistence: `this.schedulePersist(baseId)` at line **1259** — the same debounced writer the
  category/sleep mutations use, which reaches `serializePersistPayload` → `serializeSessionFragment`
  (whose payload and fragment cache both carry `ownerKey`/`capsuleId`). The panes were marked dirty in
  the loop, so one write re-serializes the tab and all of its panes. Because the owner is a persisted
  field, the restore stamps (`s.ownerKey = item.ownerKey`, lines ~1293 / ~1334 / ~1668 / ~1693) read
  the NEW key back — verified for the base AND the pane.
- Push: a single `this.emitSession()` at line **1260** for the whole cascade, the same `'session'`
  broadcast `setCategory` uses, so the window losing the rows and the window gaining them re-render
  from one push. In daemon mode that emit is broadcast as `antifan:terminal:session` and updates the
  proxy's cached summaries for the base and the pane.

### 2. `src/main/terminal-daemon/protocol.ts`

- `HOST_METHOD.transferOwner = 'terminal.transferOwner'` (line 51).
- `HostTransferOwnerParams` (line 132): `{ sessionId: string; ownerKey: string; capsuleId: string }`
  plus the file's usual `[key: string]: unknown` forward-compat index signature.

### 3. `src/main/terminal-daemon/daemon-entry.ts`

- `case HOST_METHOD.transferOwner` (line 401) → `tm.transferSessionOwner(String(p.sessionId || ''), …)`
  (line 406). The handler does NOT resolve panes itself: it passes the raw id through, so the
  base-resolution and cascade live in exactly one place and both lanes are identical by construction.
- Answers `respond(true, { transferred })` deliberately: a refusal is the manager's ANSWER, not a
  transport failure. `respond(false, …)` makes `DaemonClient.call` throw (`success:false` → reject),
  which would give the same call two different shapes depending on which side it ran on.

### 4. `src/main/terminal-daemon/daemon-client.ts`

- `async transferOwner(sessionId: string, ownerKey: string, capsuleId: string): Promise<boolean>`
  (line 566), payload typed `HostTransferOwnerParams`, returns `r.transferred === true`. Only a
  transport failure or a malformed request rejects; `false` resolves, matching in-process.
- `sessionOwnerKey`/`sessionCapsuleId` on the proxy answer from the cached summaries, which the
  `'session'` broadcast refreshes — the daemon emits before it responds, and both frames share one
  socket, so the cache already carries the new owner for the base and the pane when the promise
  settles (verified).

## What was verified (throwaway harness)

Run against a scoped compile of the real sources (compiled into the scratch dir
`.smoke-terminal-owner` with the project's own strict options, driven by a scratch `smoke.cjs`).
Harness, scratch compile and their OS-temp state dirs were removed after the run using
non-recursive, explicitly enumerated deletes only (no `rm -r`/`-f`); no daemon process from the
runs survived (checked by command line).

In-process manager (base `terminal-N` + pane `split-N`): pane is its own record; transfer by the
BASE id re-stamps the base immediately and the pane follows; both records marked dirty; transfer by
the PANE id moves the base too; unknown base id and unknown pane id → `false` with no throw; closed
session → `false` with no throw; empty owner/capsule → `false` with base and pane untouched;
idempotent re-transfer from the pane → `true`; global creation state (`currentCapsuleId`/
`currentCwd`) unchanged by the transfer; `persistSync()` writes the new `ownerKey`/`capsuleId` for
base AND pane; a fresh manager restoring that file keeps the transferred owner and capsule on both.

Daemon: a real `daemon-entry.js` child (token via env, `ANTIFAN_TERMINAL_HOST_TOKEN`) with a real
`DaemonTerminalProxy` — base+pane created through the proxy, pane projected as its own row, transfer
by base → `true` with both cached rows carrying the new owner/capsule, transfer by the pane id →
both rows move, unknown session → `false` with no throw, empty owner → `false` with rows intact,
idempotent → `true`, and after `shutdownHost()` the persisted file carries the transferred owner and
capsule for base AND pane.

## What a verifier must run

1. `npm run typecheck` (project-wide; the scoped compile of the four files passed clean already).
2. The terminal lanes: `npm run test:unit` and `npm run test:main` — in particular the terminal
   persistence/ownership lanes (`terminal-category-persistence`, `terminal-canonical-ownership`,
   `native-tab-host-terminal-window-ownership`, `terminal-daemon-client`) plus whatever
   `transferSessionOwner` test T1Tests landed.
3. Confirm by grep that `transferSessionOwner` has exactly one call path from the route owner
   (`ASSIGN_CAPSULE` → `TerminalManager.getInstance().transferSessionOwner(...)`) and that no other
   file mutates `SessionRecord.ownerKey` outside creation/restore.
4. Restore assertion worth re-checking by hand: transfer a session that has a split pane, quit the
   app cleanly (`persistSync`), relaunch — the tab AND its pane must come back under the NEW
   window/capsule, not the source.
