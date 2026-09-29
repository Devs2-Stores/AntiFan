---
phase: 5
title: "Space manifest"
status: done
priority: P1
effort: "2d"
dependencies: [2, 3]
---

# Phase 5: Space manifest

## Overview

A folder declares its working set in `<folder>/.antifan/space.json`: terminals (agent, theme
watcher, shell) and web tabs (yeu cau, Trello, feedback, ref mau, storefront, local HTML).
`Mo Space` opens exactly that set. Mirrors Warp launch configs / tmuxinator / Arc Spaces
(research report §3).

## Evidence

- `.antifan/space.json` collides with nothing (ProjectRegistryScout).
- `AntiFanTab` already has `role`, `alias`, `aliasColor` → tabs map directly.
- Terminal creation in folder = phase 2 handler with `{ folder }`.
- Sync terminals have no role field today (RunStateSyncScout (d)).
- `file:` is blocked on every load path (`security-policy.ts:8` `BLOCKED_SCHEMES`). `createTab`
  already routes `file://` / drive paths to `createPreviewTab` (`native-tab-host.ts:7395`, `:13172`),
  which serves them as `antifan-preview://<capsuleId>/<rel>` with canonical containment in
  `preview-protocol-handler.ts`. Reuse that route — no new `file:` whitelist.
  Gap: `createPreviewTab(rel, capsuleId)` resolves a RELATIVE path against process cwd
  (`:13220-13222`), so the manifest layer passes an ABSOLUTE contained path + capsuleId.
- `resolveProjectFromFolder` (`index.ts:2196-2280`) already turns a resolved folder into a project
  id (adopt via `findWorkspacesByRoot`, else create project + workspace + affiliate capsule). Extract
  its post-dialog half as `projectIdForResolvedFolder(resolved)`; `openProjectWindow` accepts
  `{ folder }`. No new ensure-project module.
- Daemon `createSession` forwards only `cwd/capsuleId/ownerKey` (`daemon-client.ts:453-460`).
- Persist cache: `serializeSessionFragment` early-return (`terminal-manager.ts:923-929`) and both
  fragments (`:944`, `:961`) must carry every new field or it is dropped on next persist.

## Schema (v1)

```json
{
  "version": 1,
  "name": "Bagamuioto",
  "terminals": [
    { "id": "agent", "label": "omp", "command": "omp", "role": "agent" },
    { "id": "sync", "label": "hrv watch", "command": "hrv theme watch", "role": "sync", "idlePolicy": "never" }
  ],
  "tabs": [
    { "url": "https://trello.com/b/...", "role": "task", "alias": "Trello" },
    { "url": "https://store.myharavan.com", "role": "storefront", "alias": "Store" },
    { "path": "ref/index.html", "role": "reference", "alias": "Ref" }
  ]
}
```

- `role`: terminal `agent|sync|shell`; `idlePolicy`: `never|manual` (default `manual`; `sync` forces `never`).
- `command` typed into the new shell after spawn (same write path as user input), never evaluated by Main.
- `url` tabs: `isAllowedNavigation` (http/https only in practice). `path` tabs: folder-relative;
  the manifest parser resolves against the canonical folder and refuses absolute, UNC, `..` escape
  and (when it exists) a realpath outside the folder; the route opens it with
  `host.createPreviewTab(absolutePath, capsuleId)`.

## Requirements

- `src/main/project/space-manifest.ts` (create): `parseSpaceManifest(buffer)` → `{ ok, manifest, hash } | { ok:false, errors:[{path, message}] }`;
  pure, no fs. `readSpaceManifest(folder)` reads the file ONCE; the same buffer is validated,
  hashed, and shown in the confirm (no re-read → no TOCTOU).
- `projectIdForResolvedFolder(resolved)` extracted in `index.ts`; Main injects a
  `SpaceWindowOpener` seam into the host (same pattern as `setTerminalLinkOpener`, `index.ts:956`)
  returning the project window host for the folder.
- Channel `TERMINAL_CHANNELS.SPACE_OPEN = 'antifan:space:open'` in `src/shared/contracts.ts`, surface
  `['sidebar']`, sender must be the shared manager (`isSharedTerminalManagerSender`, `native-tab-host.ts:6104`)
  or the project window whose affiliation canonicalises to `folder`;
  `assertApplicationAdmitsHostWork` before/after the confirm, `admitThenRun` around mints.
- Per-folder open lock (`Map<folderKey, Promise>`): a second `Mo Space` while one runs awaits it,
  then re-checks reuse → idempotent under concurrency.
- Flow: read+validate → hash unseen → return `{ needsConfirm, commands }`; renderer confirms →
  call again with `{ folder, confirmHash }` (hash must equal the buffer read in THIS call) →
  Space window opener + open window → terminals: reuse live session with same
  `spaceTerminalId` in that folder, else phase-2 mint (awaited) + write `command` → stamp
  `spaceTerminalId`, `role`, `idlePolicy` at creation (passed through `createSession`) → tabs
  in that project window with role/alias. Store confirmed hash in data root.
- Hub group header: `Mo Space` when manifest exists; `Tao space.json` writes a template from current
  folder terminals + tabs (user-initiated write, inside the folder).
- Warn once if `.antifan/` is not gitignored and the folder is a git repo (URLs may be private).

## Related Code Files

- Create: `src/main/project/space-manifest.ts`, `test/unit/space-manifest.test.ts`,
  `test/main/space-open.test.ts`
- Modify: `src/main/browser/terminal-manager.ts` (`SessionSummary` :463 + record fields `spaceTerminalId`, `role`,
  `idlePolicy`; `createSession` signature; `serializeSessionFragment` :923-961; restore)
- Modify: `src/main/terminal-daemon/protocol.ts` (`HostNewSessionParams`), `daemon-client.ts` (:453-460), `daemon-entry.ts` (:311)
- Modify: `src/main/browser/native-tab-host.ts` (route), `src/shared/contracts.ts`, `src/preload/standalone-preload.ts`, `src/renderer/standalone.js`
- Modify: `src/main/index.ts` (expose `openProjectWindow` to the route if not already injected)
- Modify: `docs/ui-architecture.md` (Space manifest section: owner, schema link)

## Success Criteria

- [ ] Invalid manifest → field-level errors, zero side effects (test)
- [ ] Valid manifest → N terminals + M tabs; second open → 0 new (test, daemon + in-process)
- [ ] Fields survive app restart (persist/restore test)
- [ ] `path` tab with `..`/absolute/UNC refused; valid `path` opens via `antifan-preview://`
- [ ] Two concurrent `Mo Space` calls → one set of sessions (test)
- [ ] Manifest edited between confirm and open → hash mismatch, nothing opened (test)
- [ ] Unaffiliated folder → project resolved/registered and window opened with no dialog

## Risk

- Command auto-run is code execution from a file in the folder. Mitigation: confirm shows exact
  commands per content hash; any edit re-prompts.
- Registering a project for an unaffiliated folder adds a registry record — additive only, never
  deletes; shown in Project Manager like any other.
