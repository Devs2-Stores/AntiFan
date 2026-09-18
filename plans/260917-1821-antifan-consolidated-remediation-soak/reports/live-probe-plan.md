# Live probe plan & evidence log

Ordered so that each probe's evidence is admissible. Results are appended as they
run; `PENDING` means not yet executed. Nothing here is credible until its result
line cites an observed value.

Preconditions: `npm run compile` green on the final tree; app launched once
(`npm start`); data root snapshots already taken (`reports/pre-boot/`).

| # | Phase | Probe | Expectation | Result |
|---|---|---|---|---|
| P1 | 1 | `anti.verification.list()` as the FIRST live call after boot | `totalCount == 1001` == parsed on-disk count; register byte length unchanged by the call | PENDING |
| P2a | 2 | boot side effect on `attachments-v1.jsonl` | foreign runtime `binding-695ac771…` record dropped and file compacted (pre-boot copy is the before) | PENDING |
| P2b | 2 | `renewSession` on a fresh pair-minted attachment | succeeds (no `RUNTIME_MISMATCH`) | PENDING |
| P2c | 2 | attach/act with a foreign runtime id | typed `RUNTIME_MISMATCH` — the negative probe that makes a zero count enforcement, not absence | PENDING |
| P3a | 3 | `anti.browser.tabs.list` with no args | exactly one entry with `isBoundTab: true`, equal to the `all: false` id | PENDING |
| P3b | 3 | a tab id the app does not own | typed `TARGET_MISMATCH` refusal | PENDING |
| P3c | 3 | `anti.agent.sequence [wait 10000, click]` | completes within bound | PENDING |
| P4a | 4 | capture racing a target teardown | typed `TARGET_BUSY_DRAINING` code, not a generic failure | PENDING |
| P4b | 4 | `evaluate` of a JS error | message relayed verbatim | PENDING |
| P5a | 5 | WAAPI-animated page: `anti.screenshot.viewport` then `anti.screenshot.full_page` | both complete inside bound; remedy names `Animation`/WAAPI as the dominant class; animations observed running again after the call | PENDING |
| P5b | 5 | CSS-animated page | remedy names the CSS class | PENDING |
| P5c | 5 | static page | remedy names no animation class at all | PENDING |
| P5d | 5 | `anti.visual.compare` against the pre-bump baseline in `pre-boot-state.md` | typed refusal/label naming the policy identity; never a silent diff | PENDING |
| P6a | 6 | `anti.browser.evaluate` with `expressionFile` / neither / both | file form evaluates; neither refused naming both forms; both refused | PENDING |
| P6b | 6 | proxy `tools/list` | includes `browser.wait` + all six `terminal.*` with mirrored schemas | PENDING |
| P6c | 6 | `tools.xdev: false` precheck on a throwaway profile | one native `mcp__antifan*` call succeeds → flip the real config; else revert and record | PENDING |
| P7a | 7 | split pane in the live strip | its own entry, own id/activity, two splits of one parent both listed | PENDING |
| P7b | 7 | resolver/QA cursor naming the split | the split is claimable by id | PENDING |
| P7c | 7 | TUI in alt-screen | labelled lossy transcript offered; `altScreen: true` in diagnostics | PENDING |
| P8 | 8 | fresh attachment `tabs.create` then close/re-create repeatedly | tab created inside the 2-tab window; the window never exhausts | PENDING |
| P9 | 9 | after phase 1: adjudicate candidates, replay regression, seed the two zero-claim platforms | `core.health` before/after each write; usage line sampled at least twice | PENDING |
| P10 | 2 | one scripted OMP turn, then session end, then re-entry | exactly one `BRIDGE_TURN_END` + one `BRIDGE_AGENT_END`; one `BRIDGE_SESSION_SHUTDOWN`; zero duplicates | PENDING |
| P11 | 6/10 | fresh OMP session log after the xdev flip | 0 `xd://mcp__antifan`, 0 `expects a JSON args object`, 0 `mcp__mcp__`; compaction count recorded against the 63 baseline | PENDING |

## Population separation (non-negotiable)

The 120-minute soak runs its **own** Electron harness on a temp data root
(`run-omp-soak.cjs` spawns `smoke-omp-closed-loop.cjs`), while the sampler watches
the **live** app. Fixture counters and live counters are reported separately; a
fixture zero is never presented as live evidence, and the sampler's rotation (not
the fixture) is what puts the newly advertised names into the live ledger.
