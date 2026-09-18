> Carried from `plan.md § Cross-plan dependencies` + goal 11 (2026-09-18): this
> phase's gate reads `npm run accounting:mcp-dispatch` (per-name aggregate from the
> dispatcher / invocation ledger — never a client-side tally), and it does not edit
> the `mcp-dispatch` regions of `toolbar.ts` that `plans/260917-0341-mcp-dispatch-accounting`
> owns.

---
title: "Phase 6: MCP surface & args transport"
status: todo
---

# Phase 6: MCP surface & args transport

## Overview

On OMP every AntiFan call rides the `write` tool as
`path:"xd://mcp__antifan_browser_anti_*"` with **JSON args as string content**.
Measured (audit §2 rank 4, §4.3):

| Observation | Value |
|---|---|
| AntiFan calls disguised as `write` | 2 037 (write lane: 2 373 calls / 343 errors = 14.5 %) |
| args-parse failures | 41–49 (19 `Expected '}'`, 18 `Unterminated string`, 4 `Invalid escape character`, 2 `Unable to parse JSON string`) |
| `No such tool` with doubled `mcp__mcp__` prefix | 25 |
| `xd://mcp__antifan` occurrences | 2 257 in one session |
| `terminal.*` lines in `scripts/antifan-omp-mcp.cjs` | **0** (52-tool map, `termNames = 0`) |

Root cause is **outside this repo** (`@oh-my-pi/pi-coding-agent/src/tools/xdev.ts:147-160`:
`parseDeviceArgs` runs a strict `JSON.parse` on the write content). Two bounded
fixes exist, in this order: remove the channel (`tools.xdev:false`, user decision E),
and remove the reason the channel breaks (`expressionFile`, so the JSON payload is
one path token instead of an escaped expression).

## Requirements

- **R1 — `expressionFile` (one-of with `expression`).** Applies to
  `anti.browser.evaluate`, `anti.browser.evaluate_frame`, and `anti.inspect.eval`.
  The path is workspace-relative and read through the existing workspace-boundary
  reader. **Same commit** must update `src/main/tools/required-args.ts` (its
  `required` array is flat today) and `src/main/mcp/mcp-server.ts` (`:719-735`
  gates every call on it) to one-of semantics, plus a new `required-args.test.ts`
  case — do not delete or loosen an existing case. Without this the file form is
  refused with "missing `expression`" and the fix looks inert.
- **R2 — Advertise the recovery surface** (user decision B, gated by
  `accounting:mcp-dispatch`): `browser.wait` (registered primitive, lane
  `event-wait`, 30 s) and `terminal.*` in `scripts/antifan-omp-mcp.cjs`. No new
  capability is registered — these already exist on the catalogue and in
  `registerTerminalCapabilities`; only the MCP surface is missing them.
- **R3 — Close the silent gap that let R2 happen.** Extend
  `scripts/check-mcp-budget-dominance.mjs` (its completeness rule currently runs
  for `core.*` only, ~`:259-268`) so a catalogue namespace that has zero surface
  lines fails the compile — starting with `terminal.*`. Never a new tool *name*
  without `npm run accounting:mcp-dispatch` (plan non-goal).
- **R4 — `tools.xdev: false` behind a routing precheck** (user decision E, no
  Level-0 gate): precheck on a throwaway profile before touching the real config;
  revert immediately if a native `mcp__antifan` call fails. This change lives in
  the user's OMP settings, **outside the repo**, and is accepted only from
  session-log evidence (0 `xd://mcp__antifan`, 0 `expects a JSON args object as
  content`) plus the compaction count (today 63), never from inside the product.
  If the native path does not exist, the precheck fails and the revert is the
  deliverable (the honest outcome, recorded).
- **R5** `browser-capabilities.ts` `:385` passes an explicit `outputPath: '.'`
  through as a bare EISDIR (phase-11 U38): return a typed, named refusal instead.
- **R6 — the ambient `tabId` default may not fabricate a filter value.** `invoke()`
  currently writes `effectiveParams.tabId = boundTabId` for every call that omits
  `tabId` (`:2243`). For `anti.verification.list` that field is a **record
  filter**, not a target selector, so an unscoped call is silently narrowed to the
  bound tab (measured: bound tab holds 0 of the register's 1001 records →
  `totalCount: 0`, phase 1's headline symptom). The default becomes **opt-in per
  advertised row**: only a capability whose `tabId` names the tab to act on
  receives it. Measured blast radius (`.probe-tmp/tabid-ambient-injection.cjs`,
  which compares the 52 rows declaring `tabId` against the compiled app
  catalogue): 44 rows consume a browser target (injected value equals the bound
  target — unchanged), 7 more are target/viewport selectors
  (`tabs.close`, `rebind_target`, `set_automation_target`, `set_viewport`,
  `get_viewport` and the two `browser.*` aliases; the two `*_target` rows declare
  `tabId` required, so the default never applied), and `anti.verification.list` is
  the single filter-shaped casualty. A compile-time gate must assert the
  classification against the app catalogue so a future list-shaped capability
  cannot silently inherit the default.

## Related code files

- Modify: `src/main/tools/browser-capabilities.ts` — `evaluate`/`evaluate_frame`/
  `inspect.eval` schemas + execute (~:340-420, ~:897-915), `:385`.
- Modify: `src/main/tools/required-args.ts` + `src/main/mcp/mcp-server.ts` (`:719-735`).
- Modify: `scripts/antifan-omp-mcp.cjs` — add `browser.wait`, `terminal.*`;
  document `expressionFile`.
- Modify: `scripts/check-mcp-budget-dominance.mjs` — completeness rule.
- Test: `src/main/tools/required-args.test.ts` (extend), plus a transport case for
  the file form. Runner: `npm run accounting:mcp-dispatch` must pass.

## Implementation steps

1. One-of validation (required-args + mcp-server) **with** the capability params,
   in one change; unit cases for both forms and for the missing-both refusal.
2. Capability: read `expressionFile` through the workspace reader; mutual exclusion
   with `expression`; same on the frame and inspect.eval paths.
3. Surface: add the missing tools to the proxy with their real schemas; run
   `npm run accounting:mcp-dispatch`; extend the completeness gate and prove it
   fails when a surface line is removed.
4. xdev precheck: throwaway profile → attempt one native call → decide; revert on
   failure; record the observed evidence either way.
5. `npm run compile` + `test:main` + `test:mcp-dispatch-hub`.

## Todo

- [ ] One-of `expression`/`expressionFile` in the gate AND the capabilities (same commit)
- [ ] `required-args.test.ts` extended (no loosened case)
- [ ] `browser.wait` + `terminal.*` advertised; accounting gate run
- [ ] Completeness gate covers the terminal namespace (fails on regression)
- [ ] xdev precheck run, decision recorded, reverted if the native path is absent
- [ ] `outputPath: '.'` typed refusal
- [ ] Ambient `tabId` default is opt-in per row (no `tabId` for `anti.verification.list`)

## Success criteria

- [ ] A call passing `expressionFile` validates and evaluates; passing neither is
      refused with a message naming both forms; passing both is refused.
- [ ] `npm run accounting:mcp-dispatch` passes and the per-name aggregate includes
      the newly advertised names.
- [ ] Removing a `terminal.*` line from the proxy fails the compile gate.
- [ ] xdev: either a session log with 0 `xd://mcp__antifan` and 0 args-parse
      failures, or a recorded revert with the failing native call.
- [ ] `anti.verification.list` with **no** `tabId` reaches the capability without
      one (file count returned), while a target-consuming capability
      (`anti.browser.get_viewport`) still resolves the bound tab by default; the
      gate fails when a row is misclassified.

## Risks / rollback

| Risk | Mitigation |
|---|---|
| `tools.xdev:false` removes the only working AntiFan path. | Precheck on a throwaway profile; immediate revert; acceptance only from session-log evidence. |
| One-of validation loosens the existing `required` contract. | Additive only: both-forms-present refused, neither refused, existing single-form cases untouched and still passing. |
| Rollback | Revert the touched files; the xdev key reverts to its default. |
