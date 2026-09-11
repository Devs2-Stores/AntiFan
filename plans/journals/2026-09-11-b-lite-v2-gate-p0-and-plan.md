# AntiFan B-Lite v2 — Gate P0 resolved in measurement, plan written and red-teamed

Date: 2026-09-11. Plan: `plans/260911-0652-antifan-b-lite-v2-subagent-workflow/` (7 phases, 0/134 tasks).
Entry path: B-Lite v2 contract closed on the owner's Round 3.1 verdict → `ak:plan` handoff (hard mode).

## Gate P0 was opened as "hash/key integrity" and closed as route identity

The contract's Gate P0 assumed an artifact-store or buffer defect: two routes' records looked identical
(`page-01-home` and `page-06-cart` @390). Measurement reframed it, and the reframing matters because a
"hash collision" fix would have repaired nothing.

- **H2 (artifact-store key collision) is disproved.** The store hashes the exact decoded buffer
  (`artifact-store.ts:358`, content-addressed `${sha256}.artifact`, per-record `crypto.randomUUID()`), and
  PNG evidence is written per page × attempt (`viewport-run.mjs:1222`, `evidence-provenance.mjs:29-33`).
  There is no shared key to collide.
- **H1 is confirmed, with the mechanism named.** The storefront redirects `/cart` to `/?openLogin=1`; the
  harness accepts a reference tab on `readyState === 'complete'` and records `finalUrl` without ever
  comparing it to the requested URL (`fifteen-pages-run.mjs:621-636`, `finalUrl` at `:629`). The route's
  own `specialNote` (`:97`) already said the redirect would happen.
- The stored telemetry proves both sides measured the homepage: page-06's reference URL is
  `https://hoplongtech.com/?openLogin=1` while page-01's is `https://hoplongtech.com/`, same
  `docHeight 3156` (`evidence/390.json:214-215` on both attempts). The cart's published numbers
  (`1.81%` @1440, `2.21%` @1024) are homepage numbers.
- Correction to the original phrasing: at @390 the two records carry `artifacts.referencePng/clonePng:
  null`. The aliasing signature is URL + geometry + refusal reason + a 1-byte bundle delta, **not** an
  identical PNG hash.

## Why the redirect survived, and what it says about the harness

Two environment defects, both measured: `navigate()` is synchronous fire-and-forget
(`native-tab-host.ts:3942-3972`) while `navigateAndWait` exists and is already exposed (`:3973`, `:522`)
but unused by the control port (`browser-control-port.ts:1229-1232`); and capture asserts only `vw/vh > 0`
(`tab-devtools-host.ts:1470-1485`), with `documentGenerations` not even bumping for in-place SPA
navigations (`:3090-3091`) although a semantic counter does (`:3082-3085`).

Launcher asymmetry is a separate gate for the fixer: `run-antifan.vbs` hardcodes `--allow-eval` but
`npm run dev` / `npm start` do not, so `ALLOW_EVAL=false` while the MCP proxy hardcodes `grant:'eval'` —
every write/eval capability then throws `POLICY_DENIED` (`capability-catalogue.ts:261-267`). Measurement
tools (`anti.inspect.*`, `anti.screenshot.*`, `anti.visual.compare`) are `risk:'read'` and unaffected.

## The isolation decision changed on a measured constraint

The contract said "builder-fixer → isolated worktree". The fixer's actual target (`dist/`, `.canary/`) is
gitignored, so a worktree can neither contain nor audit it. The plan's isolation unit is therefore a
staged workspace copy with a hash manifest; enforcement is the merge gate (touched-path audit →
`diffBudget` → `maxScopeExpansion` → post-merge manifest equality), and the OMP `tool_call` hook is a
probed second lever rather than the load-bearing one. This is recorded as a Key Design Decision plus an
Open Decision with its switching cost, not as a silent redefinition.

## Red-team found real holes; all nine are closed

First reviewer run died on `MALFORMED_FUNCTION_CALL` (model glitch, not a plan defect); the narrow re-run
produced 4 blockers + 5 majors. The valuable ones were not style findings:

1. `grant:'eval'` also opens `anti.theme.style_override` / `anti.browser.evaluate` / `anti.agent.cursor.*`
   — a runtime DOM/CSS override would have bypassed staging, every audit and the merge gate while looking
   like a fix. Fixed: the fixer's capability surface is file-only, with `REFUSED_TOOL_SURFACE` and a
   forbidden-tool probe variant.
2. `file.write` resolves relative paths against the effective workspace root, so a staged fixer would have
   written straight into the real workspace. Fixed: the session root is pinned to the staged root and a
   staged write resolving outside it refuses the attempt.
3. A Liquid merge followed immediately by re-measurement would have measured the stale bundle. Fixed:
   compile → mint bundle identity → measure.
4. Phase 1's live verification would have raced Phase 2's fire-and-forget navigation. Fixed: steps 5–6 are
   gated on Phase 2's navigation/readiness revision.
5. The merge gate stored no pre-merge content, so path-scoped restore had nothing to restore. Fixed:
   pre-merge content stored per overwritten file, plus post-merge `base ⊕ staged diff` verification.

Verification pass on the revised plan: 9/9 CLOSED, verdict `READY`. `ak plan validate` exits 0.

## Not done here

No execution: no harness code changed, no attempt regenerated, no `.omp/` artifact authored. Phases 1–2
contain the route-identity assertion and the navigation/readiness fixes; Phase 4 carries the hook probe
(four variants) and the acceptance chain; the already-published aliased verdicts are to be regenerated as
new attempts, never rewritten.

## Post-close round: three advisories, one parallel handover, three empirical probes

The plan was already validated and red-team-closed when three advisories and a handover arrived. All four were
resolved by measurement; none by argument.

**1. The "identical hash" alias claim is retired, not restated.** The advisory was right that the hash claim
did not belong in `_verdicts.json`. Measuring it settled more than the citation: the @390 records carry
`referencePng/clonePng: null`; the non-null 1024/1440 reference hashes differ (`5bee8c…` vs `04f1d1…`,
`27ece4…` vs `7864d0…`); and all four on-disk `390-standalone-*.png` files are distinct (`48800f…` vs
`7e8e6f…` references, `ba4244…` vs `2b2b2f…` clones). There is no byte-level alias to find. What the index
does show is worse than a hash collision: at 1440 both page-01 and page-06 read `PASS` / `MATCH` / `1.81%` —
the cart published a homepage PASS, not just an inconclusive. The alias is route identity, and Phase 1 is the
gate that stops a homepage number being published as the cart's.

**2. The contract-artifact layout was wrong, and authority beat convention.** `omp://skills/authoring-extensions.md`
and `omp://docs/extension-loading.md` are explicit: sibling capability dirs (`rules/`, `prompts/`, `skills/`,
`hooks/pre|post/`) are discovered only from a **loaded extension package**; a bare `.omp/RULES.md`,
`.omp/skills/…`, `.omp/hooks/pre/` is not a discovery source, and `.omp/agents/` is not a documented sibling
dir at all. The contract now ships as one package (`.omp/extensions/antifan-fix-guard/`) named explicitly in
`.omp/config.yml`. Had this not been caught, Phase 4's hook probe would have produced a false negative and the
"machine-enforced" claim would have been vacuous.

Probes run on omp v18.1.17: a native `<cwd>/.omp/extensions/<dir>/index.ts` loads (`factory-ran` +
`session_start` side effects observed), and a package named in `.omp/config.yml` `extensions:` loads too. The
sibling-`skills/` question is **not** settled: a probe session reported none, but the control was inconclusive
because `-p` sessions do not persist their system prompt, so a session-file grep can never decide it. Phase 3
therefore records each sibling root's observability as a probe result, with a fallback carrier that provably
works (the extension module and the plan directory). Probe artifacts were removed path-scoped afterwards.

**3. The fixer's grant changed from `eval` to `write` + allowlist.** Measured: `grant:'write'` exposes
write-class tools with **no** `allowEval` requirement while every `risk:'eval'` tool becomes invisible, so the
fixer needs no `--allow-eval`. But `'write'` alone is not sufficient — `file.write` is `risk:'write'`
(`file-capabilities.ts:72-74`) and so are `anti.theme.style_override`, `anti.agent.cursor.*`,
`browser.dump_dom`, `theme.qa_repair.begin/verify` (an existing workspace-rollback path) and
`browser.agent-sequence`. The allowlist (`file.read` + `file.write`) is the load-bearing control, with the
`tool_call` guard as a second lever and the merge gate's `REFUSED_TOOL_SURFACE` audit as the always-on backstop.

**4. A parallel handover from `260911-0133` was folded in, and one of its claims was corrected.** That plan
now carries `blockedBy` naming this one, so the relation is live in both directions. Its route-assertion claim
was partly wrong: `.canary/tools/theme-fidelity.mjs` **already** asserts route identity for host and theme
(`checkObservedUrl`, `:1121-1140`, called at `:1010`) — the missing comparison is **pathname**. Phase 1 now
extends the existing function with `URL_PATH_MISMATCH` instead of minting a second refusal convention, and its
regression guard is that the 21 retained legs (all carrying `?themeid=`) must never be refused.

**Probe side effects, disclosed.** Probing discovery consumed real resources before the cost was visible:
`--no-tools` does not disable MCP tools, so a nested `-p` run invoked `anti_browser_tabs_list` and minted live
tabs (`d4fc0179-…`, `807c01fe-…`) — against a tab budget the handover already reports as exhausted. Both tabs
died with their nested process and the live census (8 user tabs, plus this session's bound `about:blank` tab)
shows none of mine remaining, so nothing user-owned was touched. The fact is recorded in the plan as fact 11,
and Phase 4 now requires a managed-tab census before/after every probe variant. The same nested session also
resolved `package.json` to `e:\work\.antifan-data`, which converts Open Decision 7 from hypothetical to
measured: the merge target is external by construction and needs recorded owner approval.

Plan state after this round: `ak plan validate` exits 0 for both `260911-0652` and `260911-0133`; 7 phases,
154 tasks; no source file changed, no attempt regenerated, no `.omp` artifact authored (probe only, removed).

**5. A fifth fact turned out to be half wrong, found while proving the repo was clean.** `git status` showed
47 modified files under `.canary/`, which should not happen for an ignored path. Measured: `dist/` is ignored
with 0 tracked files, but `.canary/` has **169 tracked files** — gitignore never applies to already-tracked
paths. So the plan's claim that "`dist/` and `.canary/` are both gitignored, therefore a worktree cannot
isolate or audit the target" was wrong about `.canary/`. The decision it supported (staged copy + manifest
rather than a worktree) survives, and is now argued from the sharper true premise: a worktree would contain
`.canary/` and none of `dist/` — the wrong half of the target. Fact 9, KDD 2 and Phase 4's overview were
corrected. Those 47 modified `.canary` files are the concurrent campaign workstream's, not this session's; this
session wrote only plan and journal files.

## Second round: five more corrections, two of them to my own corrections

**A. The false PASS is now stated precisely.** Measured per viewport from the attempt evidence: page-06's
`bundle.sourceUrl` is `https://hoplongtech.com/cart` while `stages.reference.metrics.url` is
`https://hoplongtech.com/?openLogin=1` at **390, 1024 and 1440** (page-01's reference is `/` at all three).
`WIDGET_PHASE_MISMATCH` exists only at 390; at 1024 the record is `VISUAL_INCONCLUSIVE`/`2.21%` with
`refusal: null`, and at 1440 it is `PASS`/`MATCH`/`1.81%` with `refusal: null`. So the earlier "one published
a PASS" understated it: the cart's headline number is a homepage PASS, published without any refusal. Fact 3 is
now per-viewport and the Success Criteria carry the regression directly.

**B. I over-read the nested session — corrected.** The nested run's `e:\work\.antifan-data\package.json` is the
app **data root**, and `control-plane-runtime.ts:214-224` explicitly skips any candidate containing
`.antifan-data` before falling back to `THEME_WORKSPACE_ROOT`/`ANTIFAN_WORKSPACE_ROOT`/`WORKSPACE_ROOT` and then
a theme-shaped cwd. Fact 11 and Open Decision 7 now say what the code says: the theme root is
env/registry-controlled and must be **pinned by env to the staged root** — the earlier "external by
construction" reading was wrong.

**C. The capability allowlist does not exist, so the plan now specifies the primitive.** `isVisible` filters by
risk class plus `allowEval` only; grep for `allowedCapabilityNames` / `REFUSED_TOOL_SURFACE` over `src` and
`scripts` returns nothing; the proxy hardcodes `grant: 'eval'` (`antifan-omp-mcp.cjs:620`). `grant:'write'`
therefore hides eval-class tools but still exposes `anti.theme.style_override`, `theme.qa_repair.*`,
`browser.dump_dom`, `cursor.*` and `agent-sequence`. KDD 5, Open Decision 8 and Phases 2–4 now require a
name-level filter in the mint/capability list, and they attribute `REFUSED_TOOL_SURFACE` to that layer or the
`tool_call` guard — **not** to the merge gate, which audits file effects and cannot see a call that leaves
none. The previous draft had claimed an always-on backstop that could not exist.

**D. Sibling discovery works; my earlier "not proven" was the wrong conclusion from a bad channel.** The first
probe asked a nested session to list skills and got NONE, which I recorded as unproven. Re-probing with the
channel validated — `--tools=read` (which also avoids minting tabs) and a positive control — the package's
marker skill appeared in the catalogue between `pagespeed` and `sandbox-migrate-to-next`, with 12 `haravan*`
skills listed as control. So sibling `skills/` discovery from an explicitly named package is a measured fact;
the earlier NONE was model under-reporting. Sibling `rules/` and `prompts/` remain unverified and are not
load-bearing. The lesson is recorded in Phase 3: a negative probe result must be re-checked against a positive
control before it is believed.

**E. Ownership of `260911-0133`'s three publication gates is now explicit.** That plan waits on the route
assertion, the session pool returning its bindings (product side), and the image-identity class. This plan
carries: Phase 1 for the route assertion; **Phase 2 as an owned deliverable** for the pool — the leak is the
ended session that never released its tabs (`openTab` throws `POLICY_DENIED 'Terminal tab limit reached'` at
`getManagedTabIds().size >= 10`, `browser-control-port.ts:2055-2080`), acceptance being a 4-pair run whose
census returns to baseline; and Phase 2 for image identity as a typed refusal on a moved witness. Root-causing
the `endSession` RPC hang and building a srcset/script loader contract are explicit **Non-Goals** recorded as
external dependencies — otherwise that plan stays blocked on work no plan carries, which is how a dependency
link becomes a dead end.

Probe hygiene held this round: the sibling re-probe invoked no tab tool (measured: zero `anti_browser_tabs_list`
occurrences in those session files; session-owned census = 1 bound tab, this session's own), and the probe
package and `.omp/config.yml` were removed path-scoped afterwards. That is a behavioural measurement of those
runs, **not** proof that `--tools=read` is a guard — it is a built-in-tool selector, and its sibling
`--no-tools` demonstrably did not stop MCP calls. The plan now requires a `--config` overlay dropping the
AntiFan MCP server (or an unreachable proxy) plus a before/after census, so the isolation is structural rather
than incidental.

## Third round: the port gate would have refused every clone, and two error classes were one

**A. The port-side identity gate was written wrong and would have broken the clone side.** Measured, page-06 at
all three viewports: `stages.reference.metrics.url` is `https://hoplongtech.com/?openLogin=1`,
`bundle.sourceUrl` is `https://hoplongtech.com/cart`, but `stages.clone.metrics.url` is
`http://127.0.0.1:7866/` — and `…/mobile/` at 390. The clone is served from loopback by the runner, so a gate
phrased as "refuse when the tab's URL does not match the case's requested route" would have refused every clone
capture and turned a fidelity defect into a total capture failure. Phase 1 now supplies the expected identity
**per side** (reference → the case's page route; clone → the served loopback entry the runner navigated to —
`fifteen-pages-run.mjs:852`, `:885`, with the entry's sha256 already verified in `viewport-run.mjs:80`, `:90`,
`:194`, `:423-490`), and carries an added criterion that a clone capture is never refused by the route gate.

**B. `SESSION_RENEWAL_FAILED` is real, and my "fix the pool leak" framing had merged two unrelated failures.**
Reading `.canary/tools/theme-fidelity.mjs:1263` and `reports/260911-1310-theme-fidelity-run4-verdicts.md:226`,
`:233-235`: the harness code is a `NotMeasurable` raised from `renewSession` when the mint child exits
non-zero, and the report records a full run losing **6 of its 21 legs** to it, each a `read ECONNRESET` on the
renewal mint. The product's `POLICY_DENIED 'Terminal tab limit reached'` (`browser-control-port.ts:2061`) is a
**per bound session** quota, and that same report explicitly notes a superseded session holding bindings cannot
block a fresh session's mint — i.e. the causal link I had asserted between the two was wrong, and Phase 1's fix
would not have touched the actual 6-leg loss. Phase 2 now owns both classes explicitly, with the report's own
open items as the work (settle the teardown before the next mint, a bounded transport-only retry, per-pair
lifecycle isolation) and a 4-pair acceptance that names each code.

**C. A negative probe result needs a positive control before it is believed.** The sibling-`skills/` question
flips the other way too: re-probing with the catalogue channel showed the marker skill present (control: 12
`haravan*` skills), so `skills/` discovery through the `.omp/config.yml` package route is a measured fact and
Phase 3 says so. The channel is part of the finding: model enumeration works, session-file grep never could,
because `-p` sessions do not persist the system prompt. `rules/` and `prompts/` stay unverified with their own
mechanism note; the fallback carrier remains for exactly those roots.

Circling the same ground three times on advisory input is now itself the signal: each round found a defect in
the previous round's correction (a wrong workspace reading, then a wrong causal link, then a port gate that
would have broken the clone). The architecture is unchanged; what moved each time was a claim I had made from
one artifact instead of from the code that produces it.

Plan state: `ak plan validate` exits 0 for `260911-0652`; facts 1–11, KDD 1–6, Open Decisions 1–9 and Phases
1–4/6 all carry the corrections above; no source file, attempt, or `.omp` artifact was left behind.

## Fourth round: the handover inside the 2026-09-09 session, and a gate that covered half the surfaces

**A. The handover is real, and it is mid-flight, not final.** The session file the owner pointed at is the one that
took over `260911-0133` (23,880 lines, 81 MB; its own tail index is what made it readable without opening the
blob). Its last entries show the bounded mint retry being edited in, `node --check` returning `SYNTAX_OK`, and a
validating fixture launched as `bg_7` into `pairfix-out2` — then the transcript stops while waiting on it. So the
retry's effect has **never been measured anywhere**, and the plan now says exactly that (new fact 12, rewritten
Phase 2 class (a), new criterion, new todo): measure the landed reorder+retry on a clean fixture, then add
per-pair lifecycle isolation. Measured current state: HEAD `c714892`, ordering fix committed in `874060e`,
`.canary/tools/theme-fidelity.mjs` still dirty with the retry (21 insertions / 5 deletions; `MINT_ATTEMPTS = 3`,
`MINT_RETRY_GAP_MS = 3_000`, `record.sessionRenewal`). A plan that had treated this as unwritten work would have
had the loop re-implement a fix that already exists; one that had treated it as done would have shipped an
unvalidated one.

**B. The plane is shared, and the handover's own resume notes are the authority on how to run in it.** Its
`Assets for whoever resumes` section (`260911-1310-…:289-298`) is not prose: `hub ps` lists hub-managed processes
only, and a peer session's in-flight compare is invisible to it — so idleness must be checked with `hub list` as
well, because two concurrent browser-plane runs corrupt **both** verdict sets. It also fixes the operating
constraints (never edit `.canary/tools/**` while a run is in flight, `git add -f` for `.canary/**`, never
signal-kill the plane — `hub restart antifan-canary`). Those are now a plan constraint, a Phase 2 requirement with
a criterion, and a todo (new fact 13). The loop's run gate was missing them entirely; the previous round's tab
census was not the same check.

**C. The port gate covered one of three surfaces.** `theme-fidelity.mjs` drives `anti.screenshot.full_page`
(`:959`) and `anti.visual.compare` (`:1632`) — the same two capabilities whose captures produce every verdict — and
Phase 1 had specified the per-side expectation only for the 15-pages harness. A gate threaded into one path and
not the others is worse than no gate: it reads as enforcement while the verdicts that matter come out unchecked.
`captureStageSide` already carries `side: 'target' | 'baseline'` (`browser-control-port.ts:4378`, called `:4719`,
`:4778`), so the plumbing point already exists. Phase 1 now names all three surfaces and the no-expectation
branch explicitly: enforce when supplied, record a typed `URL_EXPECTATION_MISSING` when absent, and refuse at
verdict minting — so an interactive capture keeps working, while a capture with no expectation can never become a
published verdict. That resolves the "silent no-op or refuse every leg" fork without breaking callers that have no
requested route to compare against.

Four rounds in, the recurring shape is the same: the plan keeps being right about the architecture and wrong
about the blast radius — which surface a rule actually reaches, and whether the thing it describes has been run.

Addendum to this round: the two new fact rows had been inserted below the table's blank line, and a blank line
ends a GFM table — rows 12–13 would have rendered as loose text while `ak plan validate` still passed. They are
now contiguous with row 11. And Phase 2 now says what the uncommitted retry **is**: the canonical starting
implementation, to be measured and pinned (committed path-scoped, or superseded in writing) before any validation
run, with the receipt naming the instrument revision. That pairs with Phase 4's staging rule, which copies the
live working tree rather than a revision — a worktree at HEAD would not contain the retry, which is now the
second measured reason the staged copy is the right isolation unit.

## Fifth round: execution. The gate refuses the cart live, and three render paths had to be told what a refusal is

The plan's Phase 1 was verified against the storefront, not against a fixture:

```text
node .canary/tools/fifteen-pages-run.mjs --pages 6 --viewports 1440,1024,390
[P6] PAGE ROUTE REFUSAL: URL_PATH_MISMATCH — GIỎ HÀNG was requested at path /cart but the tab reports /
15-page canary run finished: ROUTE_REFUSAL (exit 4) — ["URL_PATH_MISMATCH@page-6"]
```

The attempt is `status: REFUSED` with `refusal.detail {requested: https://hoplongtech.com/cart, observed:
https://hoplongtech.com/?openLogin=1, requestedPath: /cart, observedPath: /}`, the run index carries
`cases: 0` and `refusals[0].code = URL_PATH_MISMATCH`, and nothing was compared — so the `PASS / MATCH /
1.81%` this page used to publish from the homepage is no longer producible. `--viewports` takes `1440`,
not `1440x900`: the first invocation refused with `INVALID_VIEWPORT_FILTER` (exit 2) before acquiring the
lock, which is the validator doing its job.

**A.** The verification found three places where a route refusal would have been *reported* as something
else, even though the process refused correctly. A refused page mints no case, so the executive page
table, the master table and the responsive section all fell through to the metrics branch and printed
`INCONCLUSIVE (Missing complete structural metrics)` — the refusal never reached the reader — and
`scanRequestedCases` named the legs `CASE_NOT_RUN`, dropping the reason they did not exist. Behind them
sat a fourth problem: the route-refusal code family was written out inline in three places. Fixed as one
source (`ROUTE_REFUSAL_CODES` → `ROUTE_REFUSAL_CODE_SET`), a page-status helper
(`pageRouteRefusal`/`renderPageStatus`) used by all three render sites, a `REFUSED` block in the hub
(which iterates cases and so showed a refused page as a missing row), and a reconciliation that names the
refusal code. Guards: `test/unit/route-identity-gate.test.mjs` grew to 13 cases and the pre-existing
`canary-campaign-verdicts.test.mjs` stayed green at 15. This is the round's recurring shape again — the
architecture was right and the *blast radius* was wrong: one refusal path, four reporting surfaces.

**B. The predicate-vocabulary fix was wrong the first time, and the advisory caught it.** I mapped
capture-settle's failure predicates from `grep failingPredicate | head -8`, which returned
`VisualSettleReceipt.evaluate`'s vocabulary (`'network' | 'fonts' | 'images' | 'dom'`) — a function the
call site never consumes. The consumed `evaluatePreCaptureQuiescence` reports
`'documentGenerationSettled' | 'viewportStable' | 'fontsSettled' | 'imagesSettled' | 'imageIdentityStable' |
'layoutStable'`, so both typed codes were unreachable and my "fix" was as dead as the code it replaced.
Corrected to `imageIdentityStable` → `IMAGE_IDENTITY_UNSTABLE` and `documentGenerationSettled` →
`DOCUMENT_GENERATION_UNSETTLED`. The lesson is sharper than "grep more": *map from the producer the call
site actually consumes*, and never let `head` bound a vocabulary search — the truncation is what made the
wrong function look like the only one.

**C. The budget advisory was right, and it was right against me.** After a review round proposed carrying
`repairAttempts`/`resampleAttempts` across attempts, I implemented it and proved it with a throwaway
script that failed against the old build and passed against the new one. The advisory then pointed at
`test/unit/semantic-evidence-and-guardrails.test.ts`, a pre-existing test asserting counters restart per
attempt (`otherAttempt.resampleAttempts === 0`, `repairAttempts === 1`), and at the plan's own wording.
Checked both: the test is a verified decision, and cross-attempt termination is already reachable through
the carried `consecutiveRefusalCount`/`lastFailureSignature` (default `maxIdenticalFailures = 2`). So the
carry-over was reverted, the terminal fast-exit gap kept, and the contract recorded in Phase 6 as
deliberately settled so the next audit that floats the same idea meets the reasoning instead of the code.
The throwaway proof was promoted to `test/unit/verification-lifecycle-budget.test.ts` (7 cases: per-attempt
counters, both exhaustion paths, the carried signature, both terminal fast-exits, a clean run). A passing
proof I had already run is not authority to break a repo test — the test was the stronger evidence.

**D. The hook probe's result is measured, and I re-measured the part it claimed about shared state.**
Four variants under nested `omp` sessions: a restricted-scope write is blocked with the offending path
named (parent and child), the non-blocking mode records without blocking, the default-tools control
writes cleanly (so the guard is not always-refusing), and the child's `anti.theme.style_override` call is
refused with `REFUSED_TOOL_SURFACE`. The hook imports `audits.mjs` (verified in all three carriers: the
hook, the extension entry, the contract validator), so the lever and the merge gate cannot disagree. Its
tab census claimed no leak; I checked the live census myself — the same 8 pre-existing tabs before and
after — and the gate probe's own run likewise ended with both of its tabs gone.

**E. Scoped live runs have side effects a verification plan must handle.** The harness publishes a run's
report **over the repo-root copy**: a `--pages 6` run replaced the 15/15 campaign report (45 cases, 780
deletions) with its own 1-page report. Restored path-scoped from `HEAD` via `git show ... > ...` (no
forbidden git command) and verified clean; the harness behaviour is recorded for the owner rather than
silently repaired. `current-report.json` now names the scoped run — same behaviour, identified by run id.
The minted session tab logged `NOT closed: TARGET_MISMATCH` and did end with its process; recorded as an
observation for Phase 2's session lifecycle, not as a leak.

**Retraction.** I read the still-running harness as dead because `ps | grep -c node` returned 0 — on this
host `ps` lists MSYS processes, not native Windows node, so the check was meaningless; `hub jobs` was the
authority and the run was alive. Same class of error as the `head`-bounded grep: a measurement channel was
used outside the scope where it is valid.


## Sixth round: the loop lands as three commits, and the launcher that had never once started

**A. Integration gate.** `npm run compile` failed with eight type errors, all in the new lifecycle test:
`proofProfile: {}` does not satisfy `ProofProfile` (`completeness`, `freshness`, `source`,
`evaluatedMetricsCount`, `passedMetricsCount`, `violations`). Fixed with one explicit fixture; compile
exit 0, and the compiled suites ran 68 tests / 13 suites / 68 pass, 0 fail. One agent had reported this
work as failed while its edits were in fact complete and correct — the compiler was the authority, not
the report, and its actual exit status was the only thing that settled it.

**B. Independent review, five findings, one of them rejected by measurement.** The reviewer read the
tree at 0.95 confidence and found: (1) the readiness consumer compared `failingPredicate` against
`imageIdentity` / `documentGeneration` while the producer emits `network | fonts | images | dom`, so
both branches were dead — real, fixed by mapping `images -> IMAGE_IDENTITY_UNSTABLE` and
`dom -> DOCUMENT_GENERATION_UNSETTLED`, with `CAPTURE_NOT_READY` otherwise; (2) `requestedUrl`
unpopulated — stale, it is populated at all seven return sites; (3) carry the attempt counters across
attempts so a repeated failure is seen — **applied, measured, reverted**: the pre-existing verified
contract (`test/unit/semantic-evidence-and-guardrails.test.ts`) requires `resampleAttempts === 0` and
`repairAttempts === 1` on attempt 2, and cross-attempt termination is already provided by the carried
failure signature, so the change contradicted a verified decision rather than a preference; the
rejection is now written into phase 6 so a later agent does not re-apply it; (4) the fast-exit guard
tested `FIXED_VERIFIED`, which is written to `terminalOutcome` and never to `state`, and omitted
`VERIFIED` and `REFUSED_SCOPE` — real, fixed to the states `recordAttempt` actually assigns;
(5) routed to the hook probe, which had already measured it.

**C. A fault in the merge is refused and rolled back, measured.** A test-only seam
(`ANTIFAN_TEST_FAULT_INJECT_POST_MERGE`, inert when unset) made the post-merge verification disagree
with the merge. Observed: `decision: REFUSED_DRIFT`, `restored: true`,
`postMergeVerification.verified: false` with the mismatches listed, **no success receipt published**,
and on re-run `Exit code: 13` naming the expected/actual hashes and confirming restoration to the
pre-merge bytes. The gate is not merely a happy-path receipt printer.

**D. The hook is a second lever, and its scope is measured.** Four variants: an offending path was
blocked and named; a session the hook does not own was not blocked but the path was named; where the
tool was not observed the path was not named; a forbidden tool was blocked and named. Load evidence was
recorded first (`[antifan-fix-guard] extension loaded`, `session_start` verified in
`omp.2026-09-11.25508.log`), so a non-blocking variant is distinguishable from "the package never
loaded". The observability scope is the parent session **and the sessions it spawns**. The tab census
was 8 before and 8 after (netMinted 0), corroborated on the live plane. The hook imports
`DEFAULT_PERMITTED_TOOLS` / `FORBIDDEN_TOOL_PATTERNS` from the same audit module the merge gate uses —
verified by reading the import and the constant, so there is no second copy of the matching rules.
Conclusion recorded as: hook = second lever, merge gate = physical authority.

**E. A fourth instance of the same reporting class.** A page refused by the route gate was still being
counted in the asset-pipeline section as a failed clone ("Unknown error"): the section measured over
every executed page instead of the pages that reached clone generation. Now the section counts
`pipelinePages`, prints a `Not Reached — route refused before clone generation` block, the per-viewport
`Assets:` line reads `NOT_RUN`, rows B/E/F read `NOT_TESTED`, and `CLONE_PIPELINE_BLOCKED` requires at
least one page to have reached the pipeline. Verified in a third live run of the scoped page-06 case,
not only in unit tests.

**F. The cross-attempt STALEMATE lever was dead in production.** Measured: the only `src` call site
passed five arguments, so `currentSignature` was always `undefined`, and `recordAuditRefusal`,
`recordScopeDiscovery` and `recordFailureSignature` had **zero callers repo-wide**. The signature is now
derived from the evidence the probe actually observed — the failed proof obligations of a `REJECTED`
verdict — and passed at `browser-capabilities.ts:3509-3522`; non-`REJECTED` verdicts return no
signature, so resample semantics are untouched. The engine-side audit-refusal route still has no
production caller by construction, and is recorded that way rather than described as a working lever.

**G. Advisories closed by measurement, not by deference.** (i) The tool-surface audit fell open on a
malformed declaration (a non-array silently became `[]`); it now refuses a malformed shape and accepts
the `{ usedTools: [...] }` form the schema allows, while "absent declaration" stays a documented no-op.
(ii) The policy had **three** copies: the audit module, the extension's `tool-surface.json`, and two
hardcoded `['file.read','file.write']` returns in the launcher and the MCP proxy — and the JSON's
description claimed a consumer that did not exist while the contract validator *did* read it, so it was
policy in two places. All of them now read `audits.mjs`; the union is wider than the narrowest previous
copy (it gained `theme.qa_repair.*` and `risk:eval`). (iii) The child harness persisted a `Refusal`
Error instance, and measurably `JSON.stringify` drops `message` on an Error
(`{"name":"Refusal","code":…}` versus `{"code","reason","detail"}` for a plain object), so the reason
would have vanished for that path; it now persists the same plain shape the sibling refusal uses.
(iv) `expectedComparisonUrl` and the `expectedUrls` map had writers and no readers — dropped, leaving
the two-parameter contract (`expectedUrl` for the target side, `expectedBaselineUrl` for the comparison
side) that the port actually implements. (v) The refusal carries requested and observed URLs and paths
but not a hop list, because `redirectCount` is 0 for a server-side 302; Phase 1's criterion was amended
to the measured contract instead of being ticked as if it named a chain.

**H. The handover: three commits, and a launcher that had never once started end to end.** The handover
was right on both hard points: `test/unit/route-identity-gate.test.mjs` was untracked, and HEAD's
`.canary/tools/theme-fidelity.mjs` had no `URL_PATH_MISMATCH` and no exports (measured: 0 occurrences),
so a fresh clone could not reproduce the gate. Commits: `467f997` (the gate — tool, harness library and
test together, so the clone reproduces it), `72aee8b` (engine: per-side route identity at capture
start, readiness, lifecycle terminal states, the session name filter and its single policy source), and
`d814cf1` (the contract package, its guard and the isolation-at-merge harness). Running the launcher to
prove the filter landed exposed a defect no test had: `targetGrant`, `allowedCaps` and `forbiddenCaps`
were referenced in `main()` but only in scope inside the session-acquisition loop — HEAD contains no
occurrence of `targetGrant` at all — so **every** launch crashed after acquiring a session
(`ReferenceError`, exit 1). A static scan with `tsc --allowJs --checkJs` found eight TS2304 sites; all
are resolved, and the proof is a real launch: `--fixer node -e …` printed
`CHILD_OK grant=write allowed=file.read,file.write fixer=true`, exit 0. The inventory check the handover
asked for holds: all seven surfaces of each run4 inventory carry their own themeid (`-1` live,
`1001512581` copy and subject), and the expected URL is threaded side-correctly — the capture stage
passes the inventory URL it navigated to, the compare stage passes each side's own loopback replay URL —
which is why the gate cannot refuse the campaign's faithful legs, consistent with the owner's offline
replay of the 84 recorded legs (0 refusals). The plane had exited while I worked; it was brought back
with the sanctioned `hub restart antifan-canary` (never a signal kill) and reported ready before the
launcher proof ran.

**I. Not done, and one scheduling hazard named.** Phase 2 is partial (mutation-revision readiness, the
launcher/grant matrix and its drift test, live in-page-swap ordering, the shared-plane launch gate, the
renewal residual). Phase 5 — the supervised fix proof on one static surface — is not run: its diagnosis
and re-measure need the shared browser plane, and the owner's campaign re-run needs the same plane, so
running both concurrently would corrupt both verdict sets. It must be serialized, and I have not
started it. Phase 7 is untouched. Two throwaway proof scripts from earlier rounds are gone from
`.canary/staging/` (the harness cleans its staging root); their measured results are what the phase
files and this journal record.

**J. Post-commit sweep: one real regression of my own, and five failures that are not mine.** Running the
whole `test:canary` suite (not just the two files I had been running) caught a defect I had introduced:
the clone-pipeline decision reads `p.phases.cloneGeneration`, and a page record that carries no `phases`
made the branch throw instead of deciding, which broke four cases in
`test/unit/canary-fifteen-pages-report.test.mjs`. Both decision branches now read through optional
chaining — no assertion weakened, and the four cases are green (`80037e6`). The suite then reports
**152 pass / 5 fail**, and all five are the owner's known fresh-clone fixture gap, reproduced here as
machine-local evidence rather than a code defect: `build-report-bundle-ordering`,
`build-report-embedded-drift` and `build-report-next-action` fail with *"referenced artifact missing"*
against a store that lives outside the repository (`E:/Work/.antifan-canary/control-plane-v2/artifacts/…`
and the gitignored `.antifan-data/control-plane-v2/artifacts/…`), and the bundle-ordering pair also
depends on `.canary/run3/evidence/**`, which HEAD does not track. Fixing those tests (materialising each
fixture into a temp artifact root, or a guarded skip naming the missing prerequisite) is the owner's
declared work and I did not touch it.

## Seventh round: a refusal that would not reproduce, and the loop proven in both directions

**A. The page-02 "10px" was measured to death, and it is not there.** The pinned Phase 5 surface was
page-02 `/brands` @390 with `deltaGeometry 10` (recorded reference `4270` / header 170, clone `4280` /
180, main and footer pixel-identical). Five designs re-measured the same clone bytes: a paired capture
against the live reference in one session (both **4270 / 170**, **0 of 458** header nodes differing,
11 fonts loaded each side); six full loads (4270 every time); an 84-sample, 25s series at 300ms under
measured mobile emulation (`...Mobile Safari/537.36`, touch 5, `(max-width:767px)` true) which stayed
flat at 170 with no late reflow; a viewport sequence 390 -> 1440 -> 1024 -> 390; and the campaign's own
document order - the clone root's desktop document first at 1440 and 1024, then the mobile entry
navigated into the same tab, which the harness actually does (`fifteen-pages-run.mjs:871-874, :904,
:914`) and which no fresh-tab probe can imitate. Every design agreed with the reference, and the
reference reproduced the campaign's own recorded number exactly, so the instrument is validated rather
than merely convenient. The recorded 4280 was a property of that capture, not of the clone. The fix
target is withdrawn in the plan; no `packages/site-clone` edit was made. What remains open, and is
recorded as an owner decision rather than fixed quietly, is that a *structural refusal was published
from an unreproducible read*: requiring two consecutive identical structural reads before minting one
(otherwise `INCONCLUSIVE`) is a behavior change on the same boundary the plan protects.

**B. Advisories were weighed, not obeyed, and the two that mattered were measured first.** (i) The
fail-closed expectation reader had been widened into a 30-branch ladder that accepted shapes no producer
emits; it is pruned to **14 sourced branches** (the port's `expectationMarker` / `missingExpectation` /
`routeAssertion` at `:1866-1868`, `:1929-1931`, `:4521-4524`, `:5353-5354`, the harness's
`refusal.code` / `causeCode` / `capture.reference|clone` records, and the previously accepted persisted
shapes), with the marker canonicalized at the producer - `route-identity-gate.test.mjs` 14/14, and the
test that fails against the pre-change reader is kept. (ii) `auditToolSurface` had been made to refuse a
non-array declaration, but **FixRequest v2 declares `toolSurface` as an object**
(`{allowedTools, forbiddenToolPatterns}` while FixResult v2 allows `string[]` or `{usedTools}`), so that
rule would have refused every schema-valid request - a false refusal introduced into the merge gate.
Measured after the fix: request object -> `OK`, `{usedTools}` -> `OK`, array -> `OK`, absent -> `OK`,
`{nope:1}` -> `REFUSED_TOOL_SURFACE` naming the shape; fix-loop suite 16/16. (iii) Rows A, C and D of
the section-15 table still claimed a FAIL and two PASSes for a page refused before any pipeline work;
they now read `NOT_RUN` like B/E/F, with a test (5/5). (iv) The launcher's post-acquisition throw path
exited without revoking, and the same gap exists at HEAD (`8e71915`) - attributed, not assumed; the
catch now runs `cleanup('failed', ...)` and the signals register at acquisition (13/13, `node --check`
clean).

**C. Two engine claims of mine were wrong, and are corrected by measurement.** The failure signature had
been derived from `MetricSample.passed`, a caller-supplied flag that can be empty or claimant-influenced;
it now comes from the evaluator's own `proofProfile.violations[].metric` for `REJECTED` verdicts only
(`verification-evaluator.ts:305-318`). And the cross-attempt claim did not hold at all: the previous
lifecycle was resolved only when `attemptId` matched (`browser-capabilities.ts:3034-3036`), so `previous`
was never supplied for a new attempt and the breaker's carry branch could not fire. With
`resolvePreviousLifecycle(claim, runId)` resolving the run's latest lifecycle regardless of attempt, a
fresh attempt now inherits the prior signature and trips `STALEMATE` at `maxIdenticalFailures = 2`, with
a test that fails on the old lookup and passes on the new one. Compiled suites 72/72, evaluator 18/18,
lifecycle 14/14, typecheck 0, `npm run compile` clean.

**D. The loop was proven on a real tree in both directions.** Against a staged copy of `scripts/lib`,
an edit to a file outside `allowedFiles` returned exit **10 `REFUSED_TOUCHED_PATH`** with the path named;
the same request's lawful edit returned exit **0 `OK`**; and `merge` into a throwaway target applied the
change with an `OK` receipt while the real workspace stayed byte-identical. A third run taught a fact
worth keeping: a request whose `requestedTargets` omitted the touched file was refused with exit **12
`REFUSED_SCOPE_EXPANSION`** and *"Scope expansion |T \\ R| = 1 exceeds maxScopeExpansion (0)"*, because
that audit measures against `requestedTargets`, not `allowedFiles`. The refusal was correct and the
request was malformed - an operator error, not a gate defect.

**E. Operational facts measured the hard way, for the next operator.** The MCP dispatch binding dies
when the plane restarts; the harness CLI (`lib-rpc.mjs`) keeps working, so probes must go through it.
`browser.set-viewport` needs `browser.switch-tab` first in this build (without it: `CAPABILITY_NOT_FOUND`
against a tab that exists), and it rejects `reload: false` with `VIEWPORT_NOT_APPLIED` (observed
689x1489 for a requested 390x844). A CLI session admits a bounded number of tab creations, and closing
the tab it was bound to kills the session - so a probe run should mint, create only what it names, close
it, and mint again rather than sweeping by URL (a sweep closed the session's own anchor and every later
create was refused). Full `test:canary` now stands at **154 pass / 5 fail**; all five failures are the
owner's machine-local fixture gap in the `build-report` family ("referenced artifact missing" against
`.antifan-data/...` and `E:/Work/.antifan-canary/...`, plus the untracked `.canary/run3/evidence/**`),
which I did not touch.

## Eighth round: the loop finally ran end-to-end on the repository, and the last 390 channel closed

**A. A proof that only ran on a fixture was not a proof of the loop.** `run-cli-proof.mjs` builds its own
`theme-target/assets` + `theme-target/sections` (`:22-42`) and deletes the sandbox (`:308`), so every
end-to-end run of stage -> audit -> merge had a synthetic subject, and my own earlier "chain exercised"
wording described a hand edit plus a throwaway merge target. A real subject existed and needed no browser:
`scripts/lib/campaign-verdicts.mjs`, consumed by the verdict pipeline, whose confirmation is the
route-identity gate suite. I removed its five expectation branches to recreate the pre-fix state and
measured the reproduction first: the suite went to **13 pass / 1 fail**, failing at
`route-identity-gate.test.mjs:202` (`hasMissingExpectation` returning false for the persisted
marker-only envelope).

**B. The round itself, with receipts.** Staged `scripts/lib` under run `fixround-20260911-154329` (11 files,
`baseManifestHash 913d5030...`); a FixRequest v2 whose `allowedFiles` and `requestedTargets` both named
`campaign-verdicts.mjs`, `diffBudget` one file, `maxScopeExpansion 0`, tool surface `file.read` +
`file.write`, with the failing assertion and the producer's emit sites materialized as evidence inside the
run dir; then an independent agent session as the fixer, under the builder-fixer brief, forbidden from git
history and from running tests. It returned `decision OK`, one touched path, 413 bytes,
`selfVerificationClaimed: false`. Audit exit **0 OK** (`touched ⊆ allowedFiles`, 1 file <= 1, no expansion,
no self-verification claim). Merge exit **0 OK** with `postMergeVerification.verified: true` on
`campaign-verdicts.mjs` and receipts persisted. Confirmation on the merged real workspace: **14 pass /
0 fail** - a typed `FIXED_VERIFIED` rather than a claim.

Two things are recorded rather than glossed. The fixer was an independent agent session obeying a file-only
brief and audited on its declared surface - **not** a launcher-mediated session carrying the capability name
filter, which stays proven separately by the Phase 4 launcher proof; this round exercises the merge-gate
chain. And its insertion order differed from the earlier hand-written layout by three lines, so Main
normalized the placement after the merge: the final bytes are byte-identical to the committed file, the
suite was re-run green on them (14/14), and the file is clean in git. The round's product is the audited
chain and its receipts, not new bytes.

**C. The last 390 channel is closed.** The refinement worth having: `viewport-run.mjs` navigates the clone
entry *before* it writes the clone viewport (`:630-634` before `:723`), so the mobile document's first load
happens under the previous pass's 1024 desktop emulation and is only then reloaded at 390 - the one channel
in which same-origin state could have produced the recorded 4280. Replayed in exactly that order in one tab:
create at `/` -> 1440 (docH 3975 / header 166) -> 1024 (4200 / 159) -> navigate `/mobile/index.html` while
still at 1024 desktop (**3743 / 170**) -> 390 mobile with reload (**4270 / 170**, `(max-width:767px)` true,
mobile UA, touch true) -> twelve further samples flat at 4270 / 170 with zero unfinished images. No 4280 and
no 180 in any regime. With this, the recorded structural refusal is disproven by measurement across every
modeled capture order, and the residual issue named in the plan is the one that remains: a single unstable
read was enough to mint a structural refusal.

**D. Landing state.** `scripts/lib/campaign-verdicts.mjs` byte-identical to its committed content;
`route-identity-gate` 14/14 on those bytes; full `test:canary` 154 pass / 5 fail, all five being the owner's
machine-local `build-report` fixture gap; no compiler or clone-pipeline edit was made at any point.
