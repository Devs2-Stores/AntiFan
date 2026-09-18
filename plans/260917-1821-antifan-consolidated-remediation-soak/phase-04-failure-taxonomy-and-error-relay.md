---
title: "Phase 4: Failure taxonomy & error relay"
status: todo
---

# Phase 4: Failure taxonomy & error relay

## Overview

Errors must name their real class. Today two relays lose or invert the truth,
and one set of consumers reads a token the producer never sets.

Measured (audit §2 rank 6, §3.5 mechanism 2, §4.4):

| Observation | Value |
|---|---|
| `[object Object]` capability bodies | 14 |
| Captures mislabelled `NO_RENDER_SURFACE` while a drain was the real cause | part of the 85 class |
| `NO_RENDER_SURFACE` class (2 sessions) | 85 (+111 on `browser.evaluate`) |
| Drain guard throw site | `tab-devtools-host.ts:683` throws a plain `Error` carrying the token **in the message** |
| Consumer that reads it | `browser-control-port.ts:1933-1940` inspects `err.code` → falls through to `NO_RENDER_SURFACE` |

The matcher `isTargetDrainFailure` (`browser-control-port.ts:1062-1068`) already
accepts **code or message**, so attaching the code at the throw site fixes every
`.code` consumer without breaking any existing one.

## Requirements

- **R1** The drain guard throws a typed error whose `code` is
  `TARGET_BUSY_DRAINING` (`tab-devtools-host.ts:683` — keep the message text; add
  the code through the file's existing typed-error pattern, see `:1134-1135` and
  `:1833`). The consumer at `browser-control-port.ts:1933-1940` then reports the
  real class; the `NO_RENDER_SURFACE` label is reserved for the two measured-surface
  forms (`could not be measured` vs `reports no laid-out surface` — only the
  former is a mislabel; keep the distinction visible in the receipt).
- **R2** Every `[object Object]` relay site in `capability-transport.ts`
  (`:246, :361, :380, :456, :495, :1086`) renders a real message using the
  repo's existing pattern (`browser-capabilities.ts` `safeErrorText` ~:209-215):
  typed `.message` first, `Error.message` second, `String(err)` last — never
  `String(object)` into a template.
- **R3** The relay change must not reword legitimate relays: raw JS errors from
  the agent's own expression (`getEventListeners is not defined`,
  `missing ) after argument list`) stay verbatim (`plan.md § Non-goals`).
- **R4** An induced drain returns **code** `TARGET_BUSY_DRAINING`, never message
  `TARGET_BUSY_DRAINING` with code `NO_RENDER_SURFACE` (plan acceptance criterion).
- **R5** Dead-target contract (phase-11 unit U17): `getDom` returns `''` and
  `evalJs` returns `undefined` for dead targets while `evalJsInFrame` throws
  `TARGET_STALE`; a teardown race can stage an empty DOM as a successful artifact.
  Audit every caller first; then make the three paths agree on one contract
  (recommended: throw `TARGET_STALE` in all three). If the caller audit shows a
  legitimate `''` consumer, record it and keep that path's contract explicit.
  This unit closes only with the audit written into the commit body.

## Related code files

- Modify: `src/main/browser/tab-devtools-host.ts` — throw site `:683`; also
  `:2126` re-labels a real `CAPTURE_TIMEOUT` as `NO_RENDER_SURFACE` when
  `capturePage` hangs past its 4 s bound (phase-11 U38) — same class of defect,
  fix together.
- Modify: `src/main/tools/capability-transport.ts` — the six relay sites.
- Verify only: `src/main/tools/browser-control-port.ts` `:1062-1068` matcher
  (already code-or-message), `:1933-1940` consumer, `:1045-1056` typed-code pattern.
- Dead-target paths for R5: `getDom` / `evalJs` / `evalJsInFrame` implementations
  (locate in `tab-devtools-host.ts` / `browser-control-port.ts`).
- Test: extend the existing drain/`tab-devtools-host` case file that already pins
  `TARGET_BUSY_DRAINING` behaviour (phase-11 U25 mentions case 22), plus the
  `required-args`-style unit conventions in `test/unit/`.

## Implementation steps

1. Attach the code at the throw site; add/extend a unit case that asserts
   `.code === 'TARGET_BUSY_DRAINING'` **and** that the port reports the code, not
   the `NO_RENDER_SURFACE` label.
2. Fix the six relay sites with the shared pattern; add a unit case feeding an
   object-shaped error through the transport and asserting the rendered message.
3. Fix the `:2126` timeout relabel with the same code discipline.
4. Do the U17 caller audit (grep every `getDom(`/`evalJsInFrame(` caller), then
   align the three dead-target paths and record the audit in the commit body.
5. `npm run compile` + `test:main` + the drain-covering lane.

## Todo

- [ ] Drain throw site carries `code: TARGET_BUSY_DRAINING`
- [ ] Consumer reports the code; label reserved for the measured-surface forms
- [ ] Six `capability-transport` relay sites render real messages
- [ ] `:2126` timeout relabel fixed
- [ ] U17 caller audit + three dead-target paths aligned
- [ ] Unit cases: code classes, message rendering, no reworded legitimate relays

## Success criteria

- [ ] An induced drain yields code `TARGET_BUSY_DRAINING`; a genuine missing
      surface still yields `NO_RENDER_SURFACE` with its measured-form message.
- [ ] Zero `[object Object]` in a session that exercises the error paths.
- [ ] Legitimate interpreter errors still relayed verbatim.
- [ ] `npm run compile` and the unit suite pass with **no test widened**.

## Risks / rollback

| Risk | Mitigation |
|---|---|
| Attaching `.code` changes a consumer that branches on the message only. | `isTargetDrainFailure` accepts both; grep every `TARGET_BUSY_DRAINING` consumer before editing (done in reconnaissance; re-verify at edit time). |
| Aligning the three dead-target paths breaks a caller relying on `''`. | That is why R5 starts with the caller audit; no path changes without it. |
| Rollback | Revert the files. |
