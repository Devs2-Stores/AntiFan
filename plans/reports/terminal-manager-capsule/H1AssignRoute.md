# H1AssignRoute — shared terminal manager: assign-to-capsule route, `managerAll` scope, agent write gate

Status: **DONE** (scoped smoke 14/14; typecheck clean for the two files I own).

Files written:

- `src/main/browser/native-tab-host.ts` (mine).
- `src/main/index.ts` — **one statement added** at `:906` (see "Deviations"). No other main-side change was needed.

## 1. Routes touched (channel constant, line, refusal codes)

| Channel (constant) | Line of `channel:` | Gate added | Typed refusals it can answer |
|---|---|---|---|
| `TERMINAL_CHANNELS.ASSIGN_CAPSULE` (`antifan:terminal:assign-capsule`) | 3745 | admitThenRun + presence + gate + visibility | `INVALID_PAYLOAD`, `UNKNOWN_CAPSULE`, `CAPSULE_WITHOUT_PROJECT`, `TARGET_WINDOW_ABSENT`, `MANAGER_AGENT_SESSION_READ_ONLY`, `SESSION_NOT_VISIBLE`, `UNKNOWN_SESSION` |
| `TERMINAL_CHANNELS.INPUT` | 2605 | `assertManagerMayOperate` (:2626-2630) | drop + `console.warn`, channel has no reply |
| `'antifan:terminal:input-session'` | 2640 | `:2651-2655` | drop + warn (fire-and-forget channel) |
| `TERMINAL_CHANNELS.KILL` | 2694 | `:2714-2718` | resolves `false` |
| `TERMINAL_CHANNELS.RESTART` | 2723 | `:2760-2764` | resolves `false` |
| `'antifan:terminal:split-session'` | 2847 | `:2885-2889` | resolves `false` |
| `'antifan:terminal:close-session'` | 3001 | `:3013-3017` | resolves `false` |
| `'antifan:terminal:delete-session'` | 3023 | `:3035-3039` | resolves `false` |
| `TERMINAL_CHANNELS.SLEEP_SESSION` | 3117 | `:3130-3134` | resolves `false` |
| `TERMINAL_CHANNELS.WAKE_SESSION` | 3139 | `:3155-3159` | resolves `false` |
| `'antifan:capsule:list'` | 3607 | none (read) — adds `resolvedProjectId` at `:3619` | — |
| `TERMINAL_CHANNELS.DUMP_DIAGNOSTICS` | 2507 | passes the sender into `scopeTerminalDiagnostics` | — |
| `TERMINAL_CHANNELS.LIST_SESSIONS` | 2939 | passes the sender into `visibleTerminalSessions` | — |

Refusal code strings introduced (exact): `'INVALID_PAYLOAD'`, `'UNKNOWN_CAPSULE'`, `'CAPSULE_WITHOUT_PROJECT'`, `'TARGET_WINDOW_ABSENT'`, `'UNKNOWN_SESSION'`, `'SESSION_NOT_VISIBLE'`, `'MANAGER_AGENT_SESSION_READ_ONLY'` (the last one is also the reason on the write gate). Vocabulary is the frozen `TerminalCapsuleAssignReason` union at `native-tab-host.ts:150`; every route answer is `{ ok: false, reason, message }`, never a throw — the only throws are the host's pre-existing admission errors (`RUNTIME_DRAINING` / `TARGET_STALE`) from `admitThenRun`.

## 2. The manager scope (superset view)

- `windowSessionScope()` `:5304` now returns a fourth field `managerAll`.
- `isSharedTerminalManagerSender()` `:5335` — true only when the shell owner is `unassigned` **and** the sender is a surface this host presents (`ownsChromeSender`: chrome views and this host's own terminal windows — never a page, never the bridge/MCP, never an unplaceable webContents). No sender at all (the host pushing to its own renderers) is the host's own scope.
- `isSessionVisibleToWindow()` `:5501` returns `true` early under `managerAll` (`:5511`) — one funnel, so the pushed projection (`:1542`, `:1730`, `:1738`, `:3978`), `visibleTerminalSessions()` `:5540`, `scopeTerminalDiagnostics()` `:5556` and `windowActiveSessionId()` `:5433` all agree. `agent:*` rows included; reads untouched.
- Push sites now pass the recipient's webContents id (`this.shell.sidebarView?.webContents?.id`, the terminal window's id, the diagnostics caller's sender) so a manager's own chrome gets the process-wide projection while a project window keeps its own.
- Project-window behaviour is unchanged: owner-key equality first, legacy key-less rows by capsule tag, unclaimed fallback exactly as before.

## 3. The write gate

`assertManagerMayOperate(sessionId, senderId?)` `:5353` → `true` when the caller is not the manager (a project window keeps full control of its own rows) or the row is not `agent:*`; otherwise `{ ok: false, reason: 'MANAGER_AGENT_SESSION_READ_ONLY', message }`. `sessionOwnerKey()` `:5367` reads the owner through the manager seam (optional member, `undefined` when the seam cannot answer). `reportManagerWriteRefusal()` `:5375` logs the reason on the channels that cannot reply.

## 4. Deviations (both per instruction / justified)

1. **Window opening is the renderer's step — the route does not create a window.** Per Main's live revision on this ticket ("DO NOT open a window from the route… ensureProjectWindow stays the renderer's step"), the target window was originally to be opened by the route via `ensureProjectWindow`. The route now resolves `project:<projectId>` from the capsule (`capsuleAffiliation` `:1142`, `capsuleOwnerKey` `:1150` — `capsule.projectId` + `workspaceId`, legacy records through `uniqueAffiliationByRoot`), verifies presence through a Main-injected seam, and answers `TARGET_WINDOW_ABSENT` otherwise; the renderer opens the window (`openProject`) and retries. Consequence: the `standalone:open-workspace` seam and `ensureProjectWindow` are **not** used, and `index.ts` needed no open path.
   - The ambiguous-affiliation rule is honoured: a capsule that names no single project is `CAPSULE_WITHOUT_PROJECT`, never a guess.
2. **`src/main/index.ts` touched — one statement, strictly required.** `attachSharedServices()` `:894-907` now injects `host.setOwnerWindowPresence((ownerKey) => liveShellFor(ownerKey) !== undefined)` (`:906`). The host cannot see Main's window directory (importing it would be a cycle), and without the fact a move could file a row under a window that does not exist. `setOwnerWindowPresence` `:10473`, `ownerWindowPresenceFor` `:1161`; a host that was never given the seam refuses with `TARGET_WINDOW_ABSENT` (fail closed). No window is ever created from the tab host.

## 5. Verification (what a verifier must run)

- `npx tsc -p ./ --noEmit` — **my two files are clean**. The only errors in the tree are 3 in the sibling test file `test/main/terminal-assign-capsule.test.ts:470-474` (`.ok` read on a `true | refusal` union; fix sent to `T1Tests`: add `if (refusal === true) throw new Error('expected a refusal')` before the field reads). Their fixtures also need the recording manager installed (see §6).
- Scoped smoke (real route table, real chrome router, real host prototype, doubled manager/shell/Electron only):
  `npx tsc -p ./ -y >/dev/null; node .compiled/h1assign-smoke.mjs` → **14/14 steps pass** (`.compiled/h1assign-smoke.mjs`, output `.compiled/h1assign-smoke.out`). It covers: manager sees all rows incl. `agent:*`; project window sees only its own; foreign sender is not the manager; gate refusals with the exact reason; all six mutation routes + both input routes refused and the seam never reached; `assign` success/legacy-capsule/`INVALID_PAYLOAD`/`UNKNOWN_CAPSULE`/`CAPSULE_WITHOUT_PROJECT`/`TARGET_WINDOW_ABSENT`/`UNKNOWN_SESSION`/`MANAGER_AGENT_SESSION_READ_ONLY`/`SESSION_NOT_VISIBLE`/`RUNTIME_DRAINING`; windowless caller refused by the router (`UNKNOWN_CHROME_SENDER`) before any route runs. It is a scratch file in build output, not a repo test; delete both files or re-run them as evidence.
- Both files live under `.compiled/`; they are regenerated/deleted by `npm run clean`.

## 6. Findings for other owners (not my files, not changed by me)

- `test/main/terminal-assign-capsule.test.ts` (T1Tests) — 11 failures, all fixture-side: (a) module-level `ROWS` objects are **mutated** by the recording manager's `transferSessionOwner`, so a row moved in one test is already re-owned in the next (`OWN_ROW` aliasing is why the last case saw `SESSION_NOT_VISIBLE`); clone rows per fixture; (b) the scope/gate tests never install the recording manager, so the host reads the real singleton (unknown session → legacy unclaimed fallback → `true`); wrap them in `withRecordingManager`; (c) `assert.rejects(() => Promise.resolve(harness.invoke(...)))` cannot work for a **synchronous** throw — the router refuses an unknown sender synchronously, so the case needs `assert.throws`; (d) the 3 type errors above.
- `test/main/terminal-assign-capsule.test.ts` fake spawn installs a session row with **no `buffer`**; `TerminalManager.getSessionStats` (`src/main/browser/terminal-manager.ts:2403`) then throws `ERR_INVALID_ARG_TYPE` from `Buffer.byteLength(session.buffer)`, which kills the whole `getSessionState()` — i.e. one malformed row would break every window's projection. Manager owner's call; the fixture could also set `buffer: ''`.

## 7. Notes

- No new dependency, no stub/TODO, no doc file touched. The user-visible surface (context-menu action) is the renderer's; Main owns the integration report.
- `agent:*` rows are readable by the manager through the same funnel as every other read — `GET_FULL_BUFFER` included, as the smoke asserts.
