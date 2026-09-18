---
title: "Phase 3: Tab identity & adoption symmetry"
status: todo
---

# Phase 3: Tab identity & adoption symmetry

## Overview

Two defects, one root: the bound tab is a single fact with several disagreeing
readings, and the scheduler's admission bound is smaller than the policy it
admits.

Measured live (audit report §2 rank 1, §3.5, §4.4):

| Observation | Value |
|---|---|
| `TARGET_MISMATCH` (one session) | 91 — largest single error class |
| `TARGET_STALE` | 21 |
| `TARGET_BUSY_DRAINING` | 34 |
| `anti.browser.tabs.list` default branch (`all` omitted) | returns the raw strip **without** `isBoundTab` |
| `anti.agent.sequence` lock admission | **10 000 ms** (`browser-control-port.ts` `withLock`: `options.timeoutMs ?? 10_000`) |
| the same capability's registered policy | **30 000 ms** (`makeBrowserPolicy` default) |
| `wait` step clamp | `Math.min(10000, action.waitMs || 100)` → `[wait 10000, click]` is deterministically over the lock |

Every other capability refuses a foreign `tabId` and is enforced three times on
one call, so the only honest way for a client to learn its bound tab is
`tabs.list` — which is exactly where the default branch drops the field.

## Requirements

- **R1** A no-argument `tabs.list` (and `anti.browser.tabs.list` / `antifan_list_tabs`
  with `all` omitted) returns every tab with **exactly one** `isBoundTab: true`,
  and that id equals the id `all: false` lists.
  Anchor: `browser-control-port.ts` `listTabs(context: { target?: BrowserTarget })` —
  `if (!boundTabId) return this.host.getTabList() || []` returns the raw strip;
  `browser-capabilities.ts` `anti.browser.tabs.list` passes `target: undefined`
  when `all !== false`. Keep the session-scoped branch (`all:false`) exactly as it
  is — it is the one branch that is correct today.
- **R2** Adoption symmetry: every capability that moves the bound tab
  (`set_automation_target`, `rebind_target`, `switch-tab`/`tabs_activate`,
  `open-tab`/`tabs_create`, close-with-failover) leaves the port and the MCP proxy
  agreeing on one id. The proxy already mirrors the authority through
  `recordBoundTab` (`scripts/antifan-omp-mcp.cjs:1981, :2236, :2240, :2250`);
  prove each rotation kind is covered and that a no-arg `tabs.list` afterwards
  names the same id the next omitted-`tabId` call rides.
- **R3** The viewport-gate admission bound is not smaller than the policy it
  admits: `withLock`'s default becomes the capability-policy budget
  (30 000 ms, the same value `makeBrowserPolicy` gives every viewport-gated
  capability), documented as the inner bound of the tool policy, so
  `[wait 10000, click]` completes and a capture step bounded at
  `VIEWPORT_CAPTURE_EXECUTION_BUDGET_MS` (25 000 ms) is not killed by the lock at
  10 000 ms. No capability policy changes.
- **R4** The wait step may not consume the whole admission budget on its own:
  keep the per-step clamp at 10 000 ms and state why in the comment (a sequence
  of waits is legal; one wait may not starve the remainder of the sequence).
- **R5** `assertDeadlineChain()` still passes, and a test asserts the port's
  default lock budget ≥ the catalogue's default policy budget (read the real
  constants, do not re-derive literals).

## Design decisions

1. **Annotate the strip, do not widen the session list.** The fix passes the
   bound target into `listTabs` for the `all` branch and annotates the full
   window strip with `isBoundTab`/`isPrimaryTab` against that id — the same
   projection the session branch already applies. The session branch's
   visibility rules (offscreen/ephemeral tabs stay hidden from the strip) are
   untouched.
2. **One scope parameter, not two code paths.** `listTabs` gains an explicit
   scope so the default branch is a parameter value, not an omitted argument that
   happens to mean "no identity".
3. **The lock default follows the policy, the policy does not follow the lock.**
   Raising the lock to 30 000 ms aligns the scheduler with the already-registered
   policy; lowering the policy to 10 000 ms would change a public contract.

## Related code files

- Modify: `src/main/tools/browser-control-port.ts` — `listTabs` (~:1519-1540),
  `withLock` default (~:584).
- Modify: `src/main/tools/browser-capabilities.ts` — the three `tabs.list`
  registrations (~:265, ~:1102, ~:1944) and their `execute` wiring.
- Verify (do not edit unless a rotation is missing): `scripts/antifan-omp-mcp.cjs`
  `recordBoundTab` call sites (~:1981, :2236, :2240, :2250).
- Create: `test/main/tab-identity-adoption.test.ts` (or extend the existing
  capture-lane/industrial harness tests if a closer convention exists —
  check `test/main/` first).

## Implementation steps

1. Add the scope parameter to `listTabs`; resolve `boundTabId` from the passed
   target in both scopes; annotate the full strip in the `all` scope.
2. Update the three registrations so a missing/true `all` passes the bound target
   with scope `all`, and `all: false` keeps the session scope.
3. Change `withLock`'s default timeout to the shared policy-budget constant with
   the reasoning above it; leave the wait clamp, add its rationale comment.
4. Test: no-arg list has exactly one `isBoundTab:true` equal to the `all:false`
   id; a foreign-tab call still refuses (no widening of enforcement); the lock
   budget assertion; `[wait 10000, click]`-shaped sequence completes against the
   port's existing fake host.
5. Re-run the covering lanes (`npm run compile`, `test:main`, `test:fast`).

## Todo

- [ ] `tabs.list` default branch annotates `isBoundTab` (one true, equal to `all:false`)
- [ ] Session branch behavior unchanged (offscreen/ephemeral stay hidden)
- [ ] Adoption rotations verified end-to-end (port id == proxy default id)
- [ ] `withLock` default ≥ the registered policy budget
- [ ] Wait clamp rationale documented, `[wait 10000, click]` covered by a test
- [ ] Deadline-chain assertion test reads real constants

## Success criteria

- [ ] One no-argument `tabs.list` returns N tabs with **exactly one**
      `isBoundTab: true`, equal to the `all: false` id.
- [ ] A sequence containing `[wait 10000, click]` completes;
      `assertDeadlineChain` reports no violation.
- [ ] Foreign `tabId` still refused by every capability (enforcement not widened).
- [ ] `npm run compile` and the unit suite pass with **no test widened**.

## Risks / rollback

| Risk | Mitigation |
|---|---|
| Annotating the full strip leaks which tab is bound where it previously did not. | The field is already promised by the tool description and returned by the session branch; this is the documented contract, not a new disclosure. |
| Raising the lock budget lets a stuck action hold the viewport gate for 30 s. | That is the policy the capability already advertises and the client already budgets; the lock was the only layer smaller than the policy. The gate still aborts on the caller's signal. |
| Rollback | Revert the two files. |
