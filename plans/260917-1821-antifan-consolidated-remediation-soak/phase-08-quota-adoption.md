---
title: "Phase 8: Quota adoption"
status: todo
---

# Phase 8: Quota adoption

## Overview

The per-session tab quota meters **adoption**, not open tabs, and never releases.
Closing tabs therefore cannot help, which is exactly what the user reported.

Forensic findings on the user's own log (audit §4.2, 6.88 MB / 2 670 lines):

| Evidence | Reading |
|---|---|
| `tabs_list {all:false}` → `[]` 12 s **before** the second refusal | the counter does not read the session's live tabs |
| The window held exactly 2 tabs 10 s before the first refusal | not a small cap on open tabs |
| Every refusal carries a **new** tab id + "the tab was closed instead of leaking outside the session" | create succeeds, **adopt** is refused |
| Session id equals a tab id that used to exist and is now absent | the session outlives its anchor tab [INFERENCE] |
| 7 successful `rebind_target` + 1 create, none released | the prime slot consumer; attaching to the user's own tab spends a slot |
| Counter frozen for 4 m 23.8 s while the window shrank 9 → 2 | **no release path** |

Gates: `browser-control-port.ts:2992-2993` (`getManagedTabIds(boundTabId).size >= 10`
→ `POLICY_DENIED`, message says **"Terminal tab limit"** for a *browser* tab) and
`:3007-3013` (`adoptChildTab` false → closes the just-created tab).
Asymmetry: `getManagedTabIds` returns a raw copy **without prune**
(`native-tab-host.ts:6093-6124`) while the adopt path prunes (`:6032-6036`).

## Requirements

- **R1** A slot is released when its tab closes, when the session rebinds away
  from it, and when the session ends. `rebind_target` must not consume a slot it
  immediately releases (attach-to-user-tab is not an adoption).
- **R2** The two gates read the **same pruning source** as the adopt path; a
  closed tab can never be counted by one gate and ignored by the other.
- **R3** The refusal payload is self-diagnosing: it carries `used` / `limit`
  (and the ids it counted, or a bounded sample of them) so the agent never has to
  guess. The message names the right object (browser tab vs terminal tab) and the
  release action that actually helps.
- **R4** Honest recovery: with the user's live window (2 tabs) a `tabs.create`
  from a **fresh** session attachment must succeed. If it fails, the cap is
  global, not session-scoped, and the requirement is re-raised (not papered over).
- **R5** No widening: the cap value and the refusal semantics stay; only release,
  accounting and payload change.

## Related code files

- Modify: `src/main/tools/browser-control-port.ts` — gates `:2992-2993`,
  `:3007-3013`.
- Modify: `src/main/browser/native-tab-host.ts` — `getManagedTabIds` `:6093-6124`,
  adopt path `:6032-6036`, `adoptChildTab` `:5952-6052`, close prune `:4508-4527`,
  `removeManagedTab` `:6344-6359`, `tombstoneTerminalAgentAffinity` `:6518`.
- Modify: `src/main/tools/browser-capabilities.ts` — only if the refusal payload
  is shaped there; the error object's shape must reach the MCP envelope.
- Tests: extend the tab-quota unit/lane cases; the fresh-attachment probe is live
  (phase 10 scenario matrix).

## Implementation steps

1. Find the adoption counter's single owner; route both gates and the adopt path
   through the pruning source.
2. Add release on close, on rebind away, and on session end; make `rebind_target`
   release-or-not-count consistently.
3. Enrich the refusal payload with `used`/`limit`/sampled ids and correct the
   message noun.
4. Unit cases: adopt → close → adopt again succeeds; rebind does not exhaust;
   two gates agree after a close; payload shape.
5. Live probe (phase 10): fresh attachment `tabs.create` with the 2-tab window.

## Todo

- [ ] Release on close / rebind-away / session end
- [ ] Both gates and adopt share one pruning counter
- [ ] Refusal payload carries used/limit (+ sampled ids), noun corrected
- [ ] Unit cases for release, agreement, payload
- [ ] Live fresh-attachment create succeeds

## Success criteria

- [ ] With the window held at 2 tabs, a fresh session attachment creates a tab
      successfully, and repeated close/re-create cycles never exhaust.
- [ ] A refusal (when genuinely at cap) reports `used`/`limit` and the counted
      ids; no refusal message names the wrong tab kind.
- [ ] `npm run compile` and the unit suite pass with **no test widened**.

## Risks / rollback

| Risk | Mitigation |
|---|---|
| Releasing on rebind might let a session exceed the cap by hopping tabs. | R5: the cap and refusal semantics stay; the release happens when the session stops owning the tab, which is the same event that removes it from `sessionTabPools`. |
| The counter is shared with terminal sessions. | Prove the ownership split in a unit case before changing release behavior. |
| Rollback | Revert the touched files. |
