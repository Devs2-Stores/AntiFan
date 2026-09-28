# D1SpecDoc — shared Terminal Manager design doc

Scope: documentation only. No source, test, config, or agent-context file was touched.

## Files

- `docs/superpowers/specs/2026-09-28-shared-terminal-manager-capsule-assignment-design.md` — new
  spec (Intent, Decisions, the invariant relaxed, Architecture 1–4, Data flow, Error handling,
  Testing strategy, Rollback, Owning sources).
- `docs/ui-architecture.md` — the terminal/window-scope paragraph in `## Scope Rules`, plus one line
  in `## Surface Hierarchy` pointing the `Unassigned` window at the shared manager.

## What the docs now say

- One shared Terminal Manager window; project = capsule/storefront + its Chromium partition.
- Ownership stays window-derived (`ownerKey` is the authority); the manager is a superset view plus
  control, view-only over `agent:*` rows.
- Assignment opens (or focuses) the target capsule's window first, then re-stamps `ownerKey` +
  `capsuleId` together — the one user-ordered reassignment of a minted owner key. `setCapsule` keeps
  its capsule-only rule; no implicit path (focus, tab activation, capsule switch) gains that power.
- The manager scope is reachable only from that window's own chrome renderer; MCP/bridge keep the
  "name a window" refusal.

## Anchors verified (read on 2026-09-28; the tree moved while this landed)

| Claim | Anchor |
|---|---|
| Channel + payload | `TERMINAL_CHANNELS.ASSIGN_CAPSULE` `src/shared/contracts.ts:491` |
| Preload call | `assignTerminalCapsule` `src/preload/standalone-preload.ts:74` |
| Owner vocabulary | `WindowOwner` `src/main/browser/window-owner.ts:13`, `ownerKey` `:16-18` |
| Route (allowlist, no `sessionArgs`) | `channel: TERMINAL_CHANNELS.ASSIGN_CAPSULE` `src/main/browser/native-tab-host.ts:3745`, `surface: ['sidebar','terminalPopout']` `:3746` |
| Reason vocabulary | `TerminalCapsuleAssignReason` `src/main/browser/native-tab-host.ts:150-157` |
| Typed answer | `TerminalCapsuleAssignResult` `src/main/browser/native-tab-host.ts:160-162` |
| Write-gate refusal shape | `ManagerWriteRefusal` `src/main/browser/native-tab-host.ts:169`, `reportManagerWriteRefusal` `:5375` |
| Capsule → owner | `capsuleOwnerKey` `src/main/browser/native-tab-host.ts:1150-1153` |
| Target window must exist | `ownerWindowPresenceFor` `src/main/browser/native-tab-host.ts:1161` |
| Manager scope | `windowSessionScope` `src/main/browser/native-tab-host.ts:5304`, `isSharedTerminalManagerSender` `:5335`, `UNASSIGNED_OWNER_KEY` `:137` |
| Visibility funnel | `isSessionVisibleToWindow` / `admitsSessionForWindow` `src/main/browser/native-tab-host.ts:5476`, `terminalStateForWindow` same file |
| Agent class | `AGENT_OWNER_KEY_PREFIX` `src/main/browser/native-tab-host.ts:143`, `agentTerminalOwnerKey` `src/main/browser/terminal-manager.ts:653` |
| Write gate | `assertManagerMayOperate` `src/main/browser/native-tab-host.ts:5353`, `MANAGER_AGENT_SESSION_READ_ONLY` `:157`, `:5353-5364` |
| Router seam | `assertSessionScope` `src/main/browser/ipc-router.ts:141-148`, `setChromeSenderResolver` `:80` |
| Admission | `admitThenRun` `src/main/browser/native-tab-host.ts:7340`, route call `:3790-3793` |
| Handover seam | `TerminalManager.transferSessionOwner` `src/main/browser/terminal-manager.ts:1232-1262` |
| Persistence | `SavedSession` `:344`, `serializeSessionFragment` `:853-908`, `schedulePersist` `:1052`, `emitSession` `:2728`, `statePath` `:797`, `sessionOwnerKey` `:2723` |
| Capsule-only switch | `setCapsule` `src/main/browser/terminal-manager.ts:1077` |
| Window open path | `ensureProjectWindow` `src/main/index.ts:1448`, `openProjectWindow` `:1796`, `ProjectOpenResult` `src/shared/contracts.ts:398-403` |
| Renderer | `isSharedManagerShell` `src/renderer/standalone.js:785`, `isAgentOwnedSession` `:3701`, `capsuleProjectIdOf` `:3693`, `assignRefusalText` `:3680`, `showCapsulePicker` `:3724`, `assignSessionToCapsule` `:3996`, `moveSessionToCapsuleLocally` `:4066`, item markup `src/renderer/standalone.html:130` inside `#tabContextMenu` |
| Daemon path | `HOST_METHOD.transferOwner` `src/main/terminal-daemon/protocol.ts:51` + `TransferOwnerParams` `:132`, `daemon-entry.ts:401`, `daemon-client.ts:566` (`sessionOwnerKey` `:563`) |
| Agent-plane refusal | `resolveTerminalCallerScope` `src/main/tools/terminal-capabilities.ts:141-168` |

Every backticked identifier in the spec (76 tokens) was checked to exist in `src/` or `test/`; the
symbol/file pairings were re-checked by proximity after the final edit.

## Evidence gaps the doc states instead of papering over

- `'user-intent'` as the recorded admission reason does **not** exist anywhere in `src/`. The
  Admission bullet therefore says the tree admits with the window's `ownerKey` and no reason field,
  and marks the user-ordered label as design intent.
- The assign route declares **no** `sessionArgs`; it admits the row inside the handler
  (`assertManagerMayOperate`, then `isSessionVisibleToWindow` → `SESSION_NOT_VISIBLE`). The doc says
  exactly that instead of claiming a router-level gate.
- The route is not manager-exclusive: a window may still hand over its own row; only cross-project
  reach needs the manager scope. The error table says so.
- Line numbers were deliberately stripped from the spec's code references: four of the cited files
  (`native-tab-host.ts`, `terminal-manager.ts`, `standalone.js`, `index.ts`) were being rewritten by
  sibling agents while this task ran, and today's numbers would be wrong tomorrow. The spec cites the
  owning symbol and file, which survive; the read-once numbers live in this report.

## Test lanes the docs point at (existence verified, not executed here)

`test/main/terminal-assign-capsule.test.ts` (handover, scope, agent-row gate, route),
`test/e2e/terminal-capsule-assign.test.ts` (live two-window smoke),
`test/main/terminal-daemon-provenance.test.ts`, `test/main/terminal-daemon-client.test.ts`,
`test/main/native-tab-host-terminal-window-ownership.test.ts`,
`test/main/per-tab-terminal-session.test.ts`, `test/main/chrome-ipc-routes.test.ts` (pinned
taxonomy/count/map), `test/renderer/standalone-harness.ts`, `test/e2e/terminal-renderer-smoke.cjs`.

## What a verifier must run

1. `git diff docs/ui-architecture.md docs/superpowers/specs/2026-09-28-shared-terminal-manager-capsule-assignment-design.md`
   — confirm no source file is in the diff.
2. Grep the spec's named symbols in their named files (the table above is the checklist); fix any
   claim whose symbol no longer exists rather than re-adding a line number.
3. `npm run verify` (main agent, after all siblings land) — the doc itself adds no test.

No build, lint, typecheck, or test suite was run by this task, per the assignment.
