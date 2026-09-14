# Advertised-schema enforcement on the MCP surface

Why a capability can no longer be called with a field its own advertised schema marks
required, where that rule is enforced, and what it measured before it existed.

## The rule

> No layer may fabricate a value the caller did not supply for a field that the layer's own
> advertised schema marks `required`.

The rule exists because the surface used to *advertise* a contract and then *satisfy it on
the caller's behalf*. An agent that omitted `tabId` was not told it had made a mistake; the
call succeeded against a tab it had never named. That is worse than a refusal, because a
successful call that acted on an unintended target is indistinguishable from a correct one.

## Where it is enforced, and why only there

| Boundary | File | Reason |
|---|---|---|
| The surface that publishes the schema | `scripts/antifan-omp-mcp.cjs` (`invoke`, before any transport arg handling) | The stdio proxy is the live MCP surface: it produces `tools/list`, so it owns the promise. Enforcing against the caller's *literal* arguments here is the only place where an omission is still visible. |
| The application's authenticated dispatch | `src/main/tools/capability-catalogue.ts` (`dispatchAuthenticated`) | Any client — not just this proxy — must be unable to call a capability with a required field absent. |

`browser-action-registry.ts` deliberately keeps `params.tabId || tabHost.getActiveTabId()`
for `navigate`, `reload`, `goBack` and `goForward`: those schemas describe `tabId` as
"Optional Tab ID", so the default implements the contract rather than violating it. The
distinction is the schema, not the operation.

`src/main/browser/browser-capabilities.ts` still declares `rebind-target` without a
`required` list while the proxy advertises `anti.browser.rebind_target` as requiring
`tabId`. Enforcing at the publishing boundary resolves the disagreement without changing the
internal capability: an agent must name the tab, and a programmatic caller that holds the
target may still re-synchronise it. The two descriptions were always two operations.

## Measurements

Before the rule (live bridge, 2026-09-14):

| Call | Result |
|---|---|
| `anti.browser.tabs.activate {}` | `{"switched":true,"tabId":"<bound tab>"}` in 62ms |
| `anti.browser.set_automation_target {}` | `{"success":true,...}` |
| `anti.browser.rebind_target {}` | `{"success":true,...}` |
| all nine spellings of those three operations, no arguments | accepted, all returning the same bound tab |
| `anti.telemetry.record_fallback {}` | `{"recorded":true,...}` and `gaps.jsonl` grew by one line |

The proxy filled `tabId` in from the session's bound tab (`if (!effectiveParams.tabId &&
boundTabId)`), so the application gate that was added first could never see an omission: by
the time the intent crossed the bridge the contract had already been satisfied.

After the rule (`scratch/smoke-proxy-contract.mjs`, 19/19 assertions):

- 12 omissions refused, including `set_viewport {width:1200}` ("requires height") and
  `device.tap {x:10}` ("requires y");
- 7 calls that supply their fields still work, including `reload {}` and `inspect.dom {}`,
  whose schemas keep `tabId` optional.

`anti.telemetry.record_fallback` is additionally guarded in
`src/main/telemetry/fallback-recorder.ts`, which validates required fields *before* any
filesystem work and no longer substitutes `'unknown'`, `'browser_*'` or `'FAILED'`. A
fabricated fallback record cannot be told apart from a measured one, so it is refused
instead of written.

## What the test suite caught in this change

Running `npm run test:main` after the first commit surfaced 38 failures. Analysis by stack
frame and message attributed 21 of them to this work, at four sites in
`src/main/browser/native-tab-host.ts` — all of them the same mistake in different clothes:
the new `targetOperationOwners` map was read without the field guard that every other map in
that class has, on hosts that tests build by hand without field initializers.

| Site | Symptom | Fix |
|---|---|---|
| `closeTab` cleanup loop | `reading 'keys'` | guarded by its own field, like the queue map above it |
| `dispose` | `reading 'clear'` | optional-chained, like every other map cleared there |
| `runTargetOperation` finally | `reading 'get'`, and it **replaced** the exception it was unwinding | optional-chained: a `finally` must never mask the error that caused it |
| `runTargetOperation` acquire | `reading 'set'` | guarded: an observability aid must not be why the operation it observes fails |

The finally case is the one worth remembering: the reported error was about the owner map,
while the real failure was a designed preflight rejection underneath it. Guarding that read
moved the reported frame to the next site down and turned the symptom into `reading 'set'`,
which is how the fourth site was found. It also shows why the first count was too low: the
two files inspected first showed 8 failures and went from 31/39 to 37/39, but the same
unguarded reads were failing tests across the suite that had not been inspected yet.

Measured end state on the same tree, before and after the four guards:

| Run | tests | pass | fail |
|---|---|---|---|
| after the first commit | 1132 | 1093 | 38 |
| after the guards | 1132 | 1114 | 17 |

The string `targetOperationOwners` no longer appears in any failure stack; the 17 that
remain point at `native-tab-host.js` lines 370, 590, 3943, 4071, 4083 and 5095, none of
which this work wrote.

## Repository state: HEAD does not compile

The isolated check that produced these numbers is also what exposed this: `origin/main`
carries a syntax error from `e2d6e89` in `src/main/browser/tab-devtools-host.ts`, where the
`softBudgetMs` and `hardBudgetMs` declarations sit inside the parameter list and
`): Promise<unknown> {` closes the signature two lines later (`TS1359: Identifier expected`).
It is invisible in a working tree that happens to hold the uncommitted repair, which is
exactly how a `tsc` run there reported success. At HEAD, `tsc -p ./` reports 6 errors, all
in that file and none in the files this work touched. The repair is two lines: the two
`const` declarations belong after `): Promise<unknown> {`.

## Pre-existing gaps this work did not touch

- `src/main/browser/native-tab-host.ts` reads `this.ownedReloadTokens` unguarded in
  `consumeReloadToken` (source line 445) and `closeTab` (line 4130). Hosts built without
  field initializers throw `reading 'get'` / `reading 'delete'` there. Every other map in the
  class is guarded; these two are not, and 8 of the 17 remaining failures are the `closeTab`
  read at line 3943 alone. The change is two characters (`?.`) and it is deliberately not in
  this commit: the file's owner is mid-edit there, and treating "no token map" as "no token"
  is a fail-closed decision about a security-relevant path that its owner should make
  knowingly rather than inherit from a drive-by cleanup.
- Several failures are source-characterisation tests that match a regex against
  `native-tab-host.ts` text (`ipc-audit.test.ts`), so they fail on any edit in those regions
  regardless of behaviour.
- `test/main/omp-mcp-adapter.test.ts` requires `./antifan-agent.cjs`, which `copy-static`
  places next to the emitted test; a plain `tsc` emit does not, so that check reports a
  missing relative require in an incremental build.

## Open items

- The wedging operation that the acquire bound protects against is still unidentified: a
  restart clears the in-process state that causes the silences, but the operation that
  creates it has not been caught.
- `browser.set-viewport`'s alias validity has not been measured on a live app.
- The in-process `AntiFanMcpServer` (`src/main/mcp/mcp-server.ts`) carries the same rule at
  its single `tools/call` entry point. The Electron `--mcp-server` flag it belongs to is
  discontinued (`src/main/index.ts`), so that path is defensive rather than load-bearing;
  the class itself is still exercised by tests and smoke scripts.
