---
title: "Phase 1: Dead-tab affiliation & typed ambient error"
status: done
---

# Phase 1: Dead-tab affiliation & typed ambient error

## Overview

A bound tab id that no longer exists (or was never owned by any live host) currently
routes through `hostForTabOrBootstrap` → `ambientHostOrThrow` (index.ts:735-742), which
throws an untyped `Error("N project windows are live…")` whenever ≥2 hosts exist and no
automation tab is set. Transport maps that to `UNAUTHENTICATED`/`AUTHENTICATION_DENIED`,
so even `tabs.list` and `rebind_target` die — the observed deadlock.

Rule (kongming condition): **explicit-but-unowned id degrades** (`[]`/`false`/`undefined`
per seam contract); **only absent id consults ambient**. Every consumer of
`measuredTabAffiliation` already tolerates `undefined` (attachment-registry.ts:695-706,
control-plane-runtime.ts:659-665, verifyRoutedAnchorCapsule, rebindTarget).

## Requirements

- [x] `measuredTabAffiliation` (index.ts:3034-3042): resolve the host via
- [x] Dead-tolerant variants for the read/recovery seams hit on the claims/list/rebind
      path, each degrading to the value a live host returns for an unknown id
      (never a type outside the seam's contract):
      `getSessionTabList` (:3292) → `[]`; `getManagedTabIds` (:3285) → `new Set()`
      (callers use `.has`, browser-control-port.ts:1890/:1921/:3801 — `[]`/`undefined`
      throws TypeError → UNAUTHENTICATED again); `isTabAllowed` BOTH sites —
      control-plane transport seam :3069 (consumed at control-plane-runtime.ts:205-209
      for EVERY retarget; this is the seam that deadlocks rebind_target) AND port seam
      :3290 → `false`; `terminalAuthority.allowsTab` (:3056) → `false`;
      `releaseSessionTab` (:3086) → `false`; `isTabOffscreen` (:3329) → `false`;
      `getDocumentGeneration` (:3068/:3444) → `1` (host contract :14256-14259 answers
      1 for unknown, not undefined); `measuredTabAffiliation` → `undefined`.
- [x] Default rule for the remaining ~45 unlisted functional seams: explicit-but-unowned
      id → `CapabilityError('TARGET_STALE')` (matching the host's own dead-tab answer,
      native-tab-host.ts:14097) — today they inherit the untyped ambient throw that
      becomes UNAUTHENTICATED.
- [x] Full `hostForTabOrBootstrap` call-site inventory — verified 61 call sites
      (62 occurrences in index.ts minus the :779 definition; the helper is file-private
      so the inventory is exactly index.ts).
- [x] Journal a `recordLifecycleEvent` line when a bound-but-dead id degrades (keeps the
      misroute diagnosable).

## Related Code Files

- Modify: `src/main/index.ts` (ambientHostOrThrow :735-742, hostForTabOrBootstrap
  :779-785, measuredTabAffiliation :3034-3042, read-seam adapters :3056-3473)
- Read: `src/main/run/attachment-registry.ts` (:695-706, :807-814, :1375),
  `src/main/control-plane/control-plane-runtime.ts` (:236, :245, :642-668),
  `src/main/tools/browser-control-port.ts` (:1887-1900, :3583-3606, :3782-3844)
- Read: `src/main/browser/capability-catalogue.ts` (:188-220 — already defensive),
  `src/main/capability-transport.ts` (:276-287, :409-421, :1068-1216)

## Implementation Steps

1. Extract `ambientHostOrThrow`/`hostForTabOrBootstrap`/`measuredTabAffiliation` into a
   small pure module (e.g. `src/main/browser/tab-ambient-authority.ts`) taking the
   authority directory + capsule manager — enables unit tests (seams are file-private
   today).
2. Apply the degrade rule to the read seams; typed refusal on write seams.
3. Change `ambientHostOrThrow` to `CapabilityError('TARGET_REQUIRED')`.
4. Add degrade journal event (e.g. `tabhost.boundTabDegraded`).

## Test Coverage

- `test/main/control-plane-terminal-scope.test.ts`: resolver returns `undefined` for a
  dead bound id → `validateAttachment`/`resolveAuthority` do not throw.
- `test/main/partition-selection-invariance.test.ts` `makeAuthorityPort` (:164-213):
  **rewrite the fixture** — today `ownerOf = windowOfTab(tabId) ?? args.bootstrap`
  (:186) silently falls back for unknown ids, so degrade assertions would pass
  vacuously. Route dead/unknown ids through the extracted tab-ambient-authority
  module instead, mirroring production wiring (index.ts:3337-3348); then assert
  `tabs.list` returns in-scope rows and `rebind` succeeds with a dead boundId under
  2 registered windows.
- `test/integration/mcp-multi-tab-e2e.test.ts`: transport-level end-to-end.
- Watch: `terminal-capsule-assign.test.ts:918-940` expects `TERMINAL_FORBIDDEN` on the
  windowless path — verify the checked row doesn't route through the ambient arm now
  returning `TARGET_REQUIRED`.

## Success Criteria

`tabs.list` succeeds with a dead bound tab under ≥2 live project windows;
`rebind_target` to an explicit live tabId succeeds; errors carry typed codes.

## Risks / Rollback

- Partial seam coverage leaves the deadlock alive — the inventory gate mitigates.
- Revert = restore untyped throw; no persisted state changes.
