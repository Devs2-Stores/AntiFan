---
title: "Phase 2: Anchor capsule pinning at mint"
status: pending
---

# Phase 2: Anchor capsule pinning at mint

## Overview

`antifan.cli.startSession` mints the anchor agent tab via
`createTab('about:blank', false, {offscreen:true, ephemeral:true})` with no `capsuleId`
(bridge-server.ts:2478 terminal branch, :2496 non-terminal, openTab :2729).
`resolveNewTabCapsuleId` (native-tab-host.ts:1053-1064) then falls back to
window affiliation → process-wide `activeCapsuleId`. Worse: `BridgeServer` is
constructed with `host = bootstrapHost` (index.ts:3586-3589) and `private tabHost`
is constructor-set and never rebound — every `createTab` (:2478/:2496), affinity
bind/reuse (:2441/:2479), `hostTabExists` (:3548) resolves against the BOOT window's
host regardless of which project owns the terminal. The incident anchor landed in
the other project's window because bootstrapHost was that window's host, and the
precedence stamps `windowWorkspaceCapsuleId` BEFORE `activeCapsuleId` — so the tab
got that window's capsule. An anchor minted in the wrong window also dies with that
window (disposeChildViewContents :14576) — reproducing the dead-tab topology.

## Requirements

- [ ] **Host-resolution seam (blocker):** `BridgeServer` gains a host-resolution seam,
      e.g. `(opts:{terminalSessionId?, projectId?, boundTabId?}) => host`, wired in
      index.ts; the terminal branch resolves the terminal's owning host via
      `sessionOwnerKey`/`sessionCapsuleId` → `hostForOwnerKey` (index.ts:1109-1112) /
      project capsule. `createTab`, `bindTerminalAgentAffinity`, and
      `getTerminalAgentAffinity` must ALL target that host so affinity, tab ownership,
      and capsule agree. If no owning host resolves for a project-claimed terminal →
      fail closed (same TERMINAL_SCOPE_UNRESOLVED family).

- [ ] Terminal branch: read `TerminalManager.getInstance().sessionCapsuleId(terminalSessionId)`
      (terminal-manager.ts:3013-3016; daemon facade daemon-client.ts:619-622); filter
      `DEFAULT_TERMINAL_CAPSULE_ID` ('default' sentinel, terminal-manager.ts:745) and
      non-existent capsule ids; pass the resolved `capsuleId` to `createTab`.
- [ ] Project-claimed session with no resolvable capsule → fail closed (POLICY_DENIED /
      TERMINAL_SCOPE_UNRESOLVED family) rather than minting into the ambient capsule.
      Genuinely unattributed sessions (daemon rows, default capsule) keep minting unpinned.
- [ ] Non-terminal branch: pin from `boundTabId`'s `getTabCapsuleId`; fresh provision
      resolves capsule from `p.projectId`/`p.workspaceId` via `resolveProjectAssignment`
      (index.ts:695-702 → project-context.ts `resolveProjectContext` :135-145, :226-229);
      validated claim only.
- [ ] `antifan.openTab` (:2729): pin `capsuleId` from the bound tab's `getTabCapsuleId`.
- [ ] Optional hardening: stamp `expectedCapsuleId` on the attachment record
      (attachment-registry.ts:93-108) so later checks don't depend on terminal resolvability.
- [ ] Verify line (kongming): `restoreTabs` (native-tab-host.ts:~13562) already forwards
      `migrated.capsuleId`; confirm via sanitizeTabForPersistence merge (:13308) — verify,
      do not reimplement.
- [ ] Do NOT add capsule-equality to `assertTerminalOriginScope` without an
      `expectedCapsuleId` record field — breaks unassigned-anchor rebinds, sentinel
      'default' rows, transferred sessions, and pre-fix records (fail-open reproduces
      the hole).

## Related Code Files

- Modify: `src/main/bridge/bridge-server.ts` (:2478, :2496, :2729 + constructor/
  `setControlPlane` injection of a `(projectId, workspaceId) → capsuleId` resolver seam)
- Modify: `src/main/index.ts` — wire resolver seam (uses existing
  `resolveProjectAssignment`/`resolveProjectContext`)
- Read: `src/main/browser/terminal-manager.ts` (:3013, :745 sentinel),
  `src/main/browser/native-tab-host.ts` (:8280-8284 fallback chain, :1053-1064 helper),
  `src/main/control-plane/control-plane-runtime.ts` (:642-668 mint gate),
  `src/main/run/attachment-registry.ts` (:93-108 record shape, :695-704 scope gate)

## Implementation Steps

1. Extend `BridgeServer` injection with a capsule resolver seam (TerminalManager already
   imported).
2. Pin at the three mint call sites per rules above; fail-closed only on
   claimed-project + unresolved-capsule.
3. Update `BrowserControlPort.resolveTargetTab` auto-provision note if it mints agent
   tabs (bookkeeping tab, documented non-authoritative — confirm scope).

## Test Coverage

- `test/unit/bridge/bridge-terminal-affinity.test.ts`: extend MockTabHost.createTab to
  record options; add cases — capsule pinning, 'default' sentinel filtered, fail-closed
  unresolved capsule on claimed project, unattributed session mints unpinned.
- `test/main/control-plane-terminal-scope.test.ts`: bound tab carrying session capsule
  passes; foreign-project capsule still POLICY_DENIED.
- Watch `capability-catalogue.test.ts:1704` which encodes 'ephemeral agent surface has
  no capsule stamp' — update to the new contract.

## Success Criteria

A startSession on a `project:<id>` terminal mints its anchor tab stamped with that
terminal's capsule; no anchor ever lands in the process-global active capsule again.

## Risks / Rollback

- Per-host `getTerminalAgentAffinity`/`bindTerminalAgentAffinity` maps are invisible
  across hosts → spurious re-mint is a known adjacent edge; out of scope but noted.
- Revert = drop `capsuleId` at mint sites; additive, low blast radius.
