---
phase: 6
title: "Watcher guard + sync conflict warning"
status: done
priority: P1
effort: "1d"
dependencies: [5]
---

# Phase 6: Watcher guard + sync conflict warning

## Overview

Sleeping a terminal kills its process tree, so a theme watcher must never be slept by accident;
two terminals pushing the same store+theme must warn before the second starts.

## Evidence

- `sleepSession` (`terminal-manager.ts:2268`) → `parkRecord` → `teardownSessionPty` →
  `killProcessTree` (2039, 2044); `haravan-sync-barrier.ts` documents the watcher is gone after sleep.
- Sleep entry points (red-team verified): IPC `antifan:terminal:sleep-session`
  (`native-tab-host.ts:3350`) and daemon `sleepSession` (`daemon-entry.ts:336`, via
  `daemon-client.ts:499`). Tools/mobile only probe state. `sleepSession` returns `boolean`; renderer
  consumes it at `src/preload/standalone-preload.ts:71` → `standalone.js:~4795`.
  No auto-sleep exists — guard is on the manual path, enforced once in `TerminalManager`.
- Store identity: Haravan `.haravan-cli_local.json` `org_id`, `theme_id`
  (`docs/haravan/cli-operations-and-guards.md:15`); `CapsuleBrief.themeId/storefrontUrl` fallback.
  Shopify/Sapo: no local identity file confirmed → folder-level duplicate check only.
- No duplicate-watcher detection exists; transaction registry locks per workspace root only.

## Requirements

- `TerminalManager.sleepSession(id)` returns `{ ok: true } | { ok: false, reason: 'SLEEP_REFUSED_WATCHER' | 'NOT_RUNNING' }`
  (refuse when `idlePolicy === 'never'`); shape carried through daemon protocol, `daemon-client`,
  IPC route, preload and `standalone.js`, which shows the reason. A separate explicit
  `Dung watcher` (kill) stays available.
- `syncIdentity(folder)`: Haravan → `haravan:<org_id>:<theme_id>`; else brief `themeId` → `brief:<themeId>`;
  else `folder:<canonicalFolderKey>`.
- Before a `role: sync` terminal starts (phase-5 open, or hub row menu `Danh dau la sync`), if a live
  session with the same identity exists → return `SYNC_DUPLICATE` with the other session's label;
  renderer asks confirm; confirmed call passes `acknowledgeDuplicate: true`.
- `Danh dau la sync` / `Bo danh dau`: new route `TERMINAL_CHANNELS.SET_ROLE` sets `role` +
  `idlePolicy` on an existing human-owned session (gated by `assertManagerMayOperate`), so
  manually started watchers get the same protection. Persisted via phase-5 fields.
- Hub row badge "sync" + identity tooltip.

## Related Code Files

- Create: `src/main/project/sync-identity.ts`, `test/unit/sync-identity.test.ts`
- Modify: `src/main/browser/terminal-manager.ts` (sleep guard + result shape, `setRole`),
  `src/main/terminal-daemon/protocol.ts`, `daemon-entry.ts` (:336), `daemon-client.ts` (:499)
- Modify: `src/main/browser/native-tab-host.ts` (sleep route :3340-3350, SET_ROLE), `src/shared/contracts.ts`,
  `src/preload/standalone-preload.ts` (:71), `src/renderer/standalone.js` (:~4795)
- Test: extend `test/unit/browser/terminal-sleep-lifecycle.test.ts` with the refusal case (add, never weaken)

## Success Criteria

- [ ] Sleep on `idlePolicy:'never'` refused in-process and in daemon mode; reason visible in UI
- [ ] `Danh dau la sync` on a running shell → subsequent sleep refused; survives restart
- [ ] Same `org_id+theme_id` in two folders → warning; different theme → none
- [ ] Missing/garbled `.haravan-cli_local.json` → falls back, never throws

## Risk

- Identity for Shopify/Sapo is weak (folder-level only) — stated in UI tooltip, not hidden.
- Changing `sleepSession` return shape touches every caller; list them with LSP references first.
