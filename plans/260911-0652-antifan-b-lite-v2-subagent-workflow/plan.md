---
title: "AntiFan B-Lite v2 — Enforced Subagent Fix Loop"
description: "Close B-Lite v2 as an executed contract, not a document: a reference-route-identity gate that makes the canary measurement trustworthy, a builder-fixer whose file scope and change volume are machine-enforced, isolation-at-merge as the primary enforcement (hook as a probed second lever), and one supervised proof on a static surface before any visual-only or Liquid expansion."
status: active
priority: P0
effort: "30h"
tags: [subagent-workflow, enforcement, isolation-at-merge, evidence-integrity, capture-integrity, omp-extension, critical]
created: 2026-09-11
blockedBy: []
blocks: ["260911-0133-haravan-customize-theme-fidelity"]
---

# AntiFan B-Lite v2 — Enforced Subagent Fix Loop

## Outcome Contract

A Main session can hand one bounded visual fix to a builder-fixer subagent whose write scope and change volume are enforced by machine (`allowedFiles`, `diffBudget`, `maxScopeExpansion`), whose bytes reach the theme workspace only through a merge gate Main audits, and whose result is adjudicated by AntiFan's existing evidence engine — never by the fixer itself.

Done means three properties hold together:

1. **The measurement is trustworthy first.** A fix loop must not run on a harness that gives the verdict a different route's document. Today it does: `https://hoplongtech.com/cart` was captured as `https://hoplongtech.com/?openLogin=1`, so the cart's published fidelity number is the homepage's number. Phase 1 fixes the assertion, Phase 2 fixes the navigation/readiness that let it happen.
2. **Scope is enforced before merge, not detected after.** A fixer attempt that touches a path outside `allowedFiles`, or exceeds its `diffBudget` / `maxScopeExpansion`, must be refused before any workspace byte changes, with the offending paths named. Detection after the fact is a report; prevention is the requirement.
3. **The loop terminates with a typed outcome.** Every round ends as `FIXED_VERIFIED`, `REFUSED_SCOPE`, or `STALEMATE`, carries an evidence path, and never yields a self-verified claim.

This plan does not promise a fidelity PASS on any storefront surface. It promises that a fix round is bounded, auditable, and measured by a harness whose reference identity is asserted.

## Why This Plan Exists (measured, not assumed)

The B-Lite v2 contract closed on the owner's Round 3.1 verdict. Its Gate P0 ("hash/key integrity") was an empirical unknown; it is now measured, and the measurement changed its shape. Facts below are live tool telemetry from this session (grep/read on the cited files), not model priors.

| # | Measured fact | Evidence |
|---|---|---|
| 1 | **Gate P0 root cause: unasserted reference route identity.** The harness is already told the cart redirects (`specialNote: 'Cart layout, product row, totals. (Unauthenticated redirect -> openLogin=1).'`) but never asserts it; the reference tab is accepted when `readyState === 'complete'`, and `pageResult.finalUrl` is recorded and never compared to `p.url`. | `.canary/tools/fifteen-pages-run.mjs:94`, `:97`; accepted-URL loop `:621-636`; per-viewport loop `:696-709`; `finalUrl` assignment `:629` |
| 2 | **The redirect is in the stored telemetry, at every viewport.** page-06-cart's `bundle.sourceUrl` is `https://hoplongtech.com/cart` at 390/1024/1440, but its `stages.reference.metrics.url` is `https://hoplongtech.com/?openLogin=1` at **all three**; page-01-home's reference is `https://hoplongtech.com/` at all three. Same attempt, same viewport, `docHeight 3156`. The cart's reference *is* the homepage, at every width. | `.canary/15-pages/page-06-cart/attempts/attempt-ebf4c709-…/evidence/{390,1024,1440}.json` (`stages.reference.metrics.url`, `bundle.sourceUrl`); page-01-home same paths |
| 3 | **A false PASS was published for the cart.** Per viewport, page-06: @390 `INCONCLUSIVE` with refusal `WIDGET_PHASE_MISMATCH` (slick phases `[0,1,…]` vs `[0,1,2,…]`) and no PNG artifacts; @1024 `INCONCLUSIVE` / `VISUAL_INCONCLUSIVE` / `2.21%` with `refusal: null`; @1440 **`PASS` / `MATCH` / `1.81%` with `refusal: null` — adjudicated against the homepage**. page-01 shows the same verdicts and percentages. The refusal exists only at 390, so the 1024/1440 outcomes are untyped aliasing, not refusals: the campaign's headline number for the cart surface is a homepage PASS. | `.canary/15-pages/_verdicts.json` page-01/page-06 records, all three viewports |
| 4 | **No identical hash exists anywhere for these two cases, on disk or in the index.** The @390 records carry `artifacts.referencePng/clonePng: null`; the non-null 1024/1440 reference hashes differ (`5bee8c…` vs `04f1d1…`, `27ece4…` vs `7864d0…`); and the on-disk `390-standalone-*.png` files are all four distinct (`reference`: `48800f…` vs `7e8e6f…`; `clone`: `ba4244…` vs `2b2b2f…`). The hash-alias hypothesis is retired: the two cases rendered the *same route* at different moments, so their bytes legitimately differ. The alias is route identity, established by URL telemetry + geometry + identical refusal, never by equal hashes. | `_verdicts.json` @390/1024/1440; `.canary/15-pages/page-01-home/attempts/attempt-658308ae-…/evidence/390-standalone-*.png`; `page-06-cart/attempts/attempt-ebf4c709-…/evidence/390-standalone-*.png` |
| 5 | **H2 (artifact-store key collision) is disproved.** The store is content-addressed from the exact decoded buffer (`sha256` of `storedData`) with per-record `crypto.randomUUID()` ids, and PNG evidence is written per page × attempt, so two routes share no key that could collide. | `src/main/tools/artifact-store.ts:358-370`; `.canary/tools/viewport-run.mjs:1222`; `scripts/lib/evidence-provenance.mjs:29-33` |
| 6 | **Navigation is fire-and-forget.** `navigate()` is synchronous, calls `loadURL().catch(() => {})` and returns a boolean immediately; `navigateAndWait()` exists and is exposed to the automation host, but the control port calls the sync one and then reads `documentGeneration`. | `src/main/browser/native-tab-host.ts:3942-3972`; `:3973` (`navigateAndWait`); `:522` (exposed); `src/main/tools/browser-control-port.ts:1229-1232` |
| 7 | **No capture-side readiness gate either.** `captureVerificationScreenshot` probes only `vw/vh > 0`; the pre-capture wait is two animation frames + 120 ms. `documentGenerations` increments only for non-in-place main-frame navigations — an SPA `pushState` swap does not bump it — while a separate SPA-aware counter (`semanticDocumentGenerations`) does. | `src/main/browser/tab-devtools-host.ts:1470-1485`, `:1431-1436`; `native-tab-host.ts:3090-3091`; `:3082-3085` |
| 8 | **Launcher/grant asymmetry blocks the fixer on the dev path.** `run-antifan.vbs` hardcodes `--allow-eval`; `scripts/dev.mjs` and `scripts/run-electron.cjs` forward CLI args only, so `npm run dev` runs `ALLOW_EVAL=false`. Under the MCP proxy's hardcoded `grant: 'eval'`, every `write`/`eval` capability is invisible and throws `POLICY_DENIED`; measurement tools are `risk: 'read'` and unaffected. | `run-antifan.vbs:3`; `scripts/dev.mjs:27-31`, `:108`; `scripts/run-electron.cjs:20-30`; `src/main/index.ts:67-71`; `scripts/antifan-omp-mcp.cjs:620`; `src/main/tools/capability-catalogue.ts:261-267`, `:204`, `:236` |
| 9 | **The published theme output is untracked; the harness's own run directory is not.** The compiler stages and atomically swaps 7 directories into `outputDir`; `dist/` is ignored with **0** tracked files and no theme directory exists at repo root. `.canary/` matches `.gitignore:30` yet **169 `.canary` files are tracked** — gitignore does not apply to already-tracked paths — so a worktree would carry the wrong half of the target. | `packages/site-clone/src/generators/theme-compiler.ts`; `scripts/compile-haravan-theme.mjs:16`; `.gitignore:4`, `:30`; `git check-ignore` + `git ls-files .canary` (169 tracked) measured in-repo |
| 10 | **The extension surface can block, and sibling discovery works where it was doubted.** A `tool_call` handler returning `{ block: true, reason }` stops execution and delivers the reason as the tool error; whether a *parent* hook observes a *child subagent's* tool calls is still unprobed — hence the Phase 4 matrix. Measured on omp v18.1.17: `<cwd>/.omp/extensions/<dir>/index.ts` loads natively, a package named in `.omp/config.yml` `extensions:` loads, and its sibling `skills/` root **is** discovered — the marker skill appeared in a fresh session's catalogue (between `pagespeed` and `sandbox-migrate-to-next`; control: 12 `haravan*` skills listed). An earlier probe reported none; that was model under-reporting, not a wiring gap. Sibling `rules/` and `prompts/` remain unverified. | `omp://skills/examples/safety-hook/README.md`; `omp://docs/extension-loading.md`; local probe runs (catalogue listing captured) |
| 11 | **A nested `-p` session is not isolated from the browser plane, and its file root is the data root, not the theme root.** `--no-tools` does not disable MCP tools: a probe run invoked `anti_browser_tabs_list` and minted live tabs (`d4fc0179-…`, `807c01fe-…`). Two later probes passed `--tools=read` and invoked no tab tool (measured: zero `anti_browser_tabs_list` occurrences in those session files; session-owned tab census = 1 bound tab), but `--tools` is a built-in-tool selector and is **not** an established guard — MCP tools come from the server registration. The only reliable isolation is a `--config` overlay that drops the AntiFan MCP server, plus a managed-tab census before and after. Its file tool resolved `e:\work\.antifan-data\package.json` — the app **data root** — which the workspace resolver explicitly rejects: a candidate root containing `.antifan-data` is skipped, and resolution falls back to `THEME_WORKSPACE_ROOT`/`ANTIFAN_WORKSPACE_ROOT`/`WORKSPACE_ROOT`, then to cwd only if cwd looks like a theme. So the effective theme root is env/registry-controlled and must be **pinned by env to the staged root** and recorded, never assumed. | `~/.omp/agent/sessions/--E--Work-apps-AntiFan--/2026-09-11T07-14-33-839Z_01a08f51-….jsonl`, `…07-14-58-216Z_01a08f51-….jsonl`; `src/main/control-plane/control-plane-runtime.ts:214-224` |
| 12 | **The renewal fix is half-landed and unmeasured.** The instrument at HEAD `c714892` carries the committed ordering fix (`874060e`: mint before the previous tab closes) plus an **uncommitted** bounded transport-only retry (`MINT_ATTEMPTS = 3`, `MINT_RETRY_GAP_MS = 3_000`, attempts recorded into `record.sessionRenewal`; 21 insertions / 5 deletions in `.canary/tools/theme-fidelity.mjs`). The fixture that would validate the retry was launched (`pairfix-out2`) and that session's transcript ends while waiting, so its effect is unmeasured — measure it, do not re-implement it. | `git log --oneline` (`c714892`, `874060e`); `git diff -- .canary/tools/theme-fidelity.mjs`; `.canary/tools/theme-fidelity.mjs:1156-1157`, `:1242-1264`; session `2026-09-09T11-31-20-180Z_01a085ef-….jsonl:23875-23880` |
| 13 | **The browser plane is shared and single-runner.** `antifan-canary` is hub-managed and shared with the session that took over `260911-0133`; `hub ps` lists hub-managed processes only and a peer session's in-flight compare does not appear there, so idleness must also be checked with `hub list` — two concurrent browser-plane runs corrupt both verdict sets. Same handover's operating constraints: never edit `.canary/tools/**` while a run is in flight, `git add -f` for `.canary/**`, never signal-kill the plane (`hub restart antifan-canary` is the lever). | `plans/reports/260911-1310-theme-fidelity-run4-verdicts.md:289-298`; `hub ps` (`antifan-canary: ready pid=22136`) |

Facts 1–5 invalidate the harness as a measurement device for route-distinct surfaces; 6–7 are why the redirect survived; 8 gates the fixer path; 9 decides the isolation unit (Phase 4); 10's only remaining unknown is whether a parent hook observes a child subagent's tool calls — a probe, not a design blocker, since enforcement lives in the merge gate; 11 records the probe's own side effects and why the theme root must be pinned by env rather than assumed; 12 fixes the starting point for the renewal work; 13 makes the plane single-runner so concurrent runs cannot corrupt verdict sets.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Reference identity is asserted at the harness **and** the control port: no DOM dump, capture, or verdict may proceed against a redirected/stale route; a mismatch is a typed refusal, never a fidelity verdict | P0 |
| 2 | Every launcher grants or withholds `write`/`eval` coherently, capture asserts a settled document generation (SPA-aware) before rasterizing, and session renewal is deterministic — a 4-pair run loses no leg to `SESSION_RENEWAL_FAILED`, with per-session quota exhaustion typed as the product's `POLICY_DENIED` rather than reported as a page verdict | P0 |
| 3 | The B-Lite contract exists as a loadable package — `.omp/extensions/antifan-fix-guard/` (`index.ts`, `rules/loop-contract.md`, `prompts/builder-fixer.md`, `skills/antifan-theme/SKILL.md`) named in `.omp/config.yml`, plus FixRequest v2 — with `allowedFiles`, `diffBudget`, and `maxScopeExpansion` machine-enforced | P0 |
| 4 | Isolation-at-merge is the primary enforcement; the hook probe is measured with 4 variants (including a forbidden-tool child call) and its result is recorded, not assumed | P0 |
| 5 | One static surface is fixed end-to-end under supervision with a typed outcome and an audited merge | P0 |
| 6 | The loop has a lifecycle: repair budget, STALEMATE/circuit breaker, `SCOPE_DISCOVERY` class, and an explicit ownership split (Main owns source/workspace recovery; AntiFan owns evidence/artifact/lifecycle state) | P1 |
| 7 | Visual-only surfaces and the Liquid exception are reachable only after 1–6 hold, behind a blueprint gate and a `semanticWitness` | P2 |

## Constraints

- **Never** `git checkout -- .`, `git clean -fd`, `git reset --hard`, or any repo-wide rollback. Recovery is path-scoped to files the loop itself wrote, and only after the touched-path audit names them.
- Reference route identity is asserted twice (harness pre-dump/pre-compare; control port at capture start). The port assertion is **side-aware** — the expected identity is supplied per capture, because the clone is served from loopback (`http://127.0.0.1:<clonePort>/`) and would otherwise be refused wholesale. A mismatch refuses with the requested URL, the actual URL, and the redirect chain — it never becomes `PASS`/`FAIL` about fidelity.
- The browser plane is **single-runner**: a loop run refuses to launch unless idleness is shown by `hub ps` **and** `hub list` (a peer's in-flight compare is invisible to `hub ps`), `.canary/tools/**` is never edited while a run is in flight, `.canary/**` is staged with `git add -f`, and the plane is never signal-killed — `hub restart antifan-canary` is the lifecycle lever.
- Inherited invariants stay binding: no timeout inflation, no tolerance reduction, no added masks, no auto-drain-and-retry, `useDefaultWidgetMasks:false` / `allowHeightDrift:false` unchanged, `INCONCLUSIVE` precedence preserved.
- Dual-plane isolation stays intact: pinned instance pid **plus** `processStartToken`, no `activeTabId` fallback, no user-plane read/write. Write confinement is precise, not blanket: a loop session writes only inside its staged root and the resolved theme workspace root it was granted; every other path is refused. If the effective workspace root resolves outside this repository, that run requires explicit owner approval recorded in the merge receipt.
- Attempt directories stay immutable and single-writer; the stale HTML/CSS snapshot is not carried into the contract.
- The fixer never self-verifies. Only AntiFan's engine adjudicates, and a fixer's own claim about a surface is never evidence.
- `maxScopeExpansion` is a distinct number from `diffBudget`; Main audits both separately and either can refuse a merge.
- MCP measurement capabilities stay `risk: 'read'`; the fixer's only write lever is the staged workspace's `file.write`-class path. Because `grant` filters by risk class only (`isVisible` has no name filter), the fixer session must also be filtered **by capability name** — otherwise a no-file-trace write tool (`anti.theme.style_override`, `theme.qa_repair.*`) remains reachable and no file audit can ever see it.

## Non-Goals

- Do not re-architect the clone pipeline, the theme compiler, or the comparator.
- Do not chase the content-level fidelity of any storefront surface — that acceptance belongs to `260911-0133`.
- Do not build a general multi-agent orchestration framework: one exception worker, one owner loop.
- Do not give the AntiFan verification engine filesystem rollback responsibility; it owns evidence, artifact, and lifecycle state, nothing else.
- Do not clear the ten orphaned tabs or any other hygiene item that does not gate this loop.
- Do not claim `260910-2008`'s bundle-identity acceptance, nor `260911-0133`'s masks-active criteria.
- Do not root-cause-repair the `antifan.cli.endSession` RPC hang if it lies outside the session-teardown path: Phase 2 owns "no leaked bindings, typed on timeout", and a surviving server-side hang is recorded as an external dependency with its evidence.
- Do not build a srcset/script-driven loader contract for image identity: Phase 2 refuses an unsettled image witness and types it; expanding the loader contract is `260911-0133`'s or the owner's call.

## Status (2026-09-11, after execution rounds 1-7)

| Phase | State | Evidence |
|---|---|---|
| 1 Route identity gate | **done** | commits `467f997`, `0d628b4`, `f2bcddf`; live page-06 refusal (run `ROUTE_REFUSAL`, exit 4); `test/unit/route-identity-gate.test.mjs` 14/14; the expectation reader pruned to the 14 branches its producers actually emit; rows A-F of the report keyed on the pages that reached the pipeline, not on a refused page |
| 2 Launcher alignment & capture readiness | **partial** | commits `72aee8b`, `0d628b4` (readiness codes, session name filter, single policy source, launcher proven live, and its failed-launch path now revokes instead of exiting with a live session). Open: mutation-revision readiness, launcher/grant matrix + drift test, in-page-swap ordering, shared-plane launch gate, renewal residual |
| 3 Contract files & FixRequest v2 | **done** | commit `d814cf1`; contract validator 8/8 with a negative control; fix-loop self-tests 16/16 |
| 4 Isolation-at-merge & hook probe | **done** | phase-04 proof; fault injection refused and `restored: true` with no receipt, re-run exit 13; hook probe measured parent+child scope, netMinted 0; the audits now accept every shape their callers legitimately pass (`f2bcddf`) and were re-proven on a real staged tree - out-of-scope edit exit 10 `REFUSED_TOUCHED_PATH`, in-scope edit exit 0 `OK` with a real merge into a throwaway target, real workspace byte-identical |
| 5 Supervised fix proof | **done (target withdrawn on measurement)** | `04ef707`; the pinned page-02 @390 `deltaGeometry 10` does not reproduce across five independent designs (paired capture 4270/170 both sides and 0 of 458 header nodes differing; 6 loads; an 84-sample 25s series under measured mobile emulation; a viewport sequence; the campaign's own desktop-then-mobile document order), while the live reference reproduces the campaign's recorded 4270 exactly - so the clone has no defect to fix and no `packages/site-clone` edit was made. The loop's refusal and merge paths were proven on a real tree in both directions. Residual gap recorded, not papered over: a structural refusal was published from an unreproducible read, and requiring two consecutive identical structural reads before minting one (else `INCONCLUSIVE`) is an open owner decision |
| 6 Lifecycle & STALEMATE | **done** | commits `72aee8b`, `0e90761`; the signature comes from the evaluator's own `proofProfile.violations` for `REJECTED` verdicts, not from caller-supplied sample flags; the previous-lifecycle lookup no longer requires a matching attempt id, so a repeated identical failure can actually halt the batch - a test fails on the old lookup and passes on the new one; lifecycle suite 14 cases, compiled suites 72/72 |
| 7 Visual expansion & Liquid exception | **untouched** | its gate (Phase 5) closed with a withdrawn target rather than a verified fix, so this phase is still correctly unstarted |

Two measured facts belong to whoever runs this next. `maxScopeExpansion` is evaluated against
`requestedTargets`, **not** against `allowedFiles`: a request that omits its targets is refused with
`REFUSED_SCOPE_EXPANSION` even when the edit is inside the allowlist - a malformed request, not a gate
defect. And the recorded page-02 refusal proves the structural gate can mint a refusal from a single
unstable read; a stability precondition before publishing one is the open decision named in row 5.

`blocks` still names `260911-0133`, whose `blockedBy` names this plan: its route-identity precondition
is satisfied by Phase 1 (committed, not merely on disk). Its other two preconditions - the image-identity
class and the r1 reference asymmetry - are the owner's.


## Phases

| # | Phase | Status | Effort |
|---|-------|--------|--------|
| 1 | [Gate P0 — Reference Route Identity & Capture Integrity](./phase-01-gate-p0-hash-key-integrity.md) | Done | 4h |
| 2 | [Launcher/Eval Alignment & Capture Readiness](./phase-02-launcher-and-eval-alignment.md) | Partial | 3h |
| 3 | [B-Lite Contract Files & FixRequest v2](./phase-03-b-lite-contract-files.md) | Done | 4h |
| 4 | [Isolation-at-Merge & Hook Probe](./phase-04-isolation-and-hook-probe.md) | Done | 6h |
| 5 | [Supervised Fix Proof on One Static Surface](./phase-05-supervised-fix-proof.md) | Done (target withdrawn) | 5h |
| 6 | [Loop Lifecycle, STALEMATE & Ownership Split](./phase-06-lifecycle-and-stalemate.md) | Done | 4h |
| 7 | [Visual-Only Expansion & Liquid Exception](./phase-07-visual-expansion-and-liquid-exception.md) | Pending | 4h |

Owner ladder mapping: Phase 1 = P0 (hash/key integrity, reframed by measurement as route identity), Phase 2 = P1 (launcher/eval alignment, and it hosts the accepted Visual Quiescence Check), Phase 3 = P2, Phase 4 = P3 (isolation + hook probe), Phase 5 = P4, Phase 6 = P5, Phase 7 = P6.

## Contract Artifacts & Ownership

OMP discovery is authoritative, not inferred: sibling capability dirs (`skills/`, `rules/`, `prompts/`, `hooks/pre|post/`, `tools/`, `commands/`, `.mcp.json`) are discovered only from a **loaded extension package**; a bare `.omp/rules/`, `.omp/hooks/pre/` or `.omp/agents/` is not a discovery source, and `agents/` is not a documented sibling dir at all (`omp://skills/authoring-extensions.md`, `omp://docs/extension-loading.md`). Measured on omp v18.1.17: the package's sibling `skills/` root **is** discovered (a marker skill appeared in a fresh session's catalogue, with 12 `haravan*` skills as control); sibling `rules/`/`prompts/` are not yet verified, and the load-bearing carriers do not depend on them. The contract therefore ships as one package:

| Artifact | Path (authority-verified) | Purpose | Owner |
|---|---|---|---|
| Extension entry | `.omp/extensions/antifan-fix-guard/index.ts` | Registers the `tool_call` guard / tool allowlist | Main |
| Loop contract rule | `.omp/extensions/antifan-fix-guard/rules/loop-contract.md` | Enforcement precedence, forbidden moves, typed outcomes, ownership split | Main |
| Fixer brief | `.omp/extensions/antifan-fix-guard/prompts/builder-fixer.md` | The exception worker's procedure: read staged workspace, edit only `allowedFiles`, never verify | Main |
| Domain skill | `.omp/extensions/antifan-fix-guard/skills/antifan-theme/SKILL.md` | Theme surfaces, evidence calls, refusal reporting | Main |
| Tool-call guard | `.omp/extensions/antifan-fix-guard/hooks/pre/*` (conditional on the probe) | File-scope enforcement at tool-call time, if hooks see child calls | Main |
| Explicit load | `.omp/config.yml` → `extensions: ["./.omp/extensions/antifan-fix-guard"]` | Makes the package explicitly named, so its sibling roots are eligible | Main |
| FixRequest v2 / FixResult v2 schema | `.omp/extensions/antifan-fix-guard/schemas/` | Machine-readable request and return contract | Main |
| Merge-gate receipt | `.canary/staging/<runId>/receipt.json` | Touched-path audit + budget audit + post-merge verification + decision | Main |
| Verdict / evidence / lifecycle records | AntiFan run dirs (`.canary/…`) | Adjudication, capture artifacts, run state, repair-attempt accounting | AntiFan engine |

The fixer worker is spawned with its brief supplied in the prompt by Main; no custom agent *type* registration is load-bearing. A convenience copy under `<repo>/.claude/agents/` is optional and never part of enforcement.

## Relationship to existing plans

- `plans/260910-2008-clone-campaign-evidence-provenance` (**complete**) owns bundle identity minting and process-token anti-PID-reuse. It explicitly covers the HTML bundle on disk; it does **not** cover reference route identity or capture readiness. Phase 1–2 of this plan fill exactly that gap and inherit its attempt-immutability and fail-closed verification invariants.
- `plans/260911-0133-haravan-customize-theme-fidelity` (**blocked**) reuses this harness and carries `blockedBy: ["260910-2008-…", "260911-0652-antifan-b-lite-v2-subagent-workflow"]` — written by that workstream, matched by this plan's `blocks`, live in both directions. Its publication gates are three, and this plan now says which it carries: **route assertion → this plan's Phase 1**; **session pool returning its bindings → this plan's Phase 2** (scoped to "no leaked bindings, typed on timeout": the product-side RPC hang is characterized, and root-causing it is an explicit Non-Goal unless it falls inside the teardown path); **image-identity class → this plan's Phase 2** as a typed refusal on a moved witness, with any srcset/script loader contract recorded as an explicit Non-Goal and left to that plan or the owner. The handover section appended to this file by that workstream also carries the measured harness fixes at `0cbd91b` as context.
- `plans/260909-1721-restore-visual-fidelity-canary` (**completed**) and `plans/260909-0032-explicit-authority-dual-plane-cutover` (**completed**) supply binding invariants: strict compare parameters, no synthetic screenshots, single explicit owner per tab, fail-closed authority.
- `plans/260910-2008` remains the active-plan pointer in `plans.db`; this plan is a separate workstream. Run `ak plan reindex` after this plan's first execution so the index tracks the new statements.

## Success Criteria

- [x] Re-running page-06 with the assertion refuses with a typed route code carrying requested URL, observed URL, and redirect chain — measured live: `URL_PATH_MISMATCH`, run `ROUTE_REFUSAL`, exit 4, `executiveVerdict: INCONCLUSIVE`, `cases: 0`. No route-refused case can enter the pass tally, and a homepage-derived `PASS` cannot be published as the cart's.
- [x] No case in `_verdicts.json` has a reference URL whose path differs from the requested page URL without a typed refusal (25 historical artifacts audited; the only live mismatch, page-06 `/cart` -> `/?openLogin=1`, is now refused).
- [x] The acceptance chain ran end-to-end on a real tree with receipts at every step (staged `scripts/lib`, positive control edit, audits `OK`, merge into a throwaway target with an `OK` receipt); the fixer-session leg is proven separately by the launcher proof (`CHILD_OK grant=write allowed=file.read,file.write`).
- [x] Measured: an edit outside `allowedFiles` is refused with exit 10 `REFUSED_TOUCHED_PATH` naming `process-identity.mjs`; an edit absent from `requestedTargets` is refused with exit 12 `REFUSED_SCOPE_EXPANSION` and the `|T \\ R|` arithmetic; the real workspace stayed byte-identical through both.
- [x] Executed: the hook is a **confirmed second lever** (parent and child scope measured, `netMinted 0`), and the merge gate remains primary.
- [x] Asserted by test (`cli-agent-launcher.test.js`, 13 pass), including the failed-launch revocation path fixed in `0d628b4`.
- [x] Settle predicates and the terminal-state capture path are committed with tests; the route gate refuses before a capture can be attributed to the wrong document.
- [x] Typed outcomes with evidence paths were measured (`REFUSED_TOUCHED_PATH`, `REFUSED_SCOPE_EXPANSION`, `OK`), and a self-verification claim is a refusal class, not an accepted result. No `FIXED_VERIFIED` - the pinned surface's delta was measured away, and the phase's own risk clause admits a typed audited outcome as a pass.
- [x] File-only surface enforced by the name filter in the mint list plus the probed hook; the visual/eval capabilities are refused with `REFUSED_TOOL_SURFACE` at that layer, never by the merge gate (which only sees file effects).
- [x] Proven by fault injection: `REFUSED_DRIFT` with `restored: true` and no receipt; the re-run exits 13 and the restore is path-scoped from real pre-merge bytes.
- [x] The package load is proven in-session before the probe result is read.
- [x] The name filter is built in the mint/capability list and the refusal code is `REFUSED_TOOL_SURFACE` at that layer or by the `tool_call` guard; the audit accepts the request-object shape the schema declares, so no valid request is refused for the wrong reason.
- [x] No destructive git command was used; every restore was path-scoped and named its files.

## Key Design Decisions

1. **Enforcement order: merge gate primary, hook secondary.** The merge gate is deterministic and testable without the extension runtime; the hook's visibility into child sessions is unproven (fact 10). If the probe fails, nothing about enforcement weakens.
2. **Isolation unit is a staged workspace copy with a hash manifest, not a git worktree.** Measured constraint, stated precisely: `dist/` is ignored with zero tracked files, so a worktree could never contain the primary target, while `.canary/` is tracked in spite of its ignore rule (169 files) — so a worktree would isolate exactly the half that matters least and none of the half that matters. The manifest makes the touched-path and diff-budget audits transport-independent. Switching cost if `dist/` later becomes tracked: low — the run can move to a worktree without changing the audit.
3. **Ownership split is explicit.** Main owns source/workspace checkpoint, staged recovery, and merge; AntiFan owns evidence/artifacts/lifecycle. Rollback of source files is never delegated to the verification engine, and never implemented as a repo-wide git reset.
4. **Route identity is a refusal class, not a tolerance.** A redirected reference makes the case unmeasurable; it must be typed, counted, and excluded from adjudication.
5. **The fixer needs a capability *name* filter, because `grant` alone does not exist as a sufficient control.** Measured: `isVisible` (`capability-catalogue.ts:261-268`) filters only by risk class and `allowEval` — `grant === 'write'` returns `definition.risk === 'write'`, `grant === 'eval'` additionally requires `allowEval`. No name-level allowlist exists anywhere in `src` or `scripts` (grep for `allowedCapabilityNames` / `REFUSED_TOOL_SURFACE`: no matches), and the proxy hardcodes `grant: 'eval'` with no tool filter (`scripts/antifan-omp-mcp.cjs:620`). So running the fixer at `'write'` (a) removes the `--allow-eval` premise and hides every `risk:'eval'` tool, but (b) still exposes `anti.theme.style_override`, `anti.agent.cursor.*`, `browser.dump_dom`, `theme.qa_repair.begin/verify` (which can roll the workspace back to R0) and `browser.agent-sequence`. The plan therefore specifies the missing primitive rather than assuming it: a session-level **allow-name set** filtered in `isVisible`/the capability list (or an equivalently narrow grant), plus stopping the proxy's `grant: 'eval'` hardcode for fixer sessions. `REFUSED_TOOL_SURFACE` is emitted by that mint/guard layer or by the extension's `tool_call` guard where the probe passes — **never** by the merge gate, which audits file effects and cannot observe a call that leaves no file trace.
6. **Staging isolates only if the session's workspace root points at it, and that root is env-controlled.** `file.write` resolves relative paths against the effective workspace root; the resolver skips any candidate containing `.antifan-data` and falls back to `THEME_WORKSPACE_ROOT`/`ANTIFAN_WORKSPACE_ROOT`/`WORKSPACE_ROOT`, then to a theme-shaped cwd (`control-plane-runtime.ts:214-224`). The loop therefore **pins the root by env to the staged directory** (env wins before cwd), records the resolved root in request and receipt, and refuses any staged write that resolves outside it; a change that landed only in the real workspace is a failed attempt, not a partial success.

## Open Decisions (implementation-level; architecture is closed)

1. **Route-match normalization.** Compare origin + pathname with a trailing-slash rule, ignoring query — or also reject unexpected `?openLogin=1`-style query mutations? Recommended: origin+pathname for identity, and record the full final URL plus query as evidence so a query-only redirect is visible without failing the case.
2. **Typed code name — resolved by measurement: reuse the existing family.** `.canary/tools/theme-fidelity.mjs` already carries `checkObservedUrl` with `URL_HOST_MISMATCH` / `URL_THEME_MISMATCH` and `EXIT.REFUSAL` (`:1121-1140`). Phase 1 adds `URL_PATH_MISMATCH` to that function instead of minting a second convention; the aggregate report counts all three as the route-refusal class.
3. **Staged workspace location.** `.canary/staging/<runId>/` (existing untracked root) vs a temp dir outside the repo (forbidden by constraint). Recommended: inside `.canary/`.
4. **Hook probe verdict criteria.** What constitutes "the hook sees the child call": a blocked write attempt must name the offending path in the returned reason and leave the staged file unchanged.
5. **`maxScopeExpansion` unit and formula.** Files. With requested set `R` (the files the FixRequest names as the fix target) and touched set `T`: `expanded = T \ R`, `scopeExpansion = |expanded|`; refuse when `|expanded| > maxScopeExpansion`, naming every expanded path. `diffBudget` separately bounds `|T|` and changed bytes. Neither field can be widened by the fixer.
6. **Whether Phase 1 also repairs the already-published aliased verdicts** (recommended: no — regenerate them; attempt directories are immutable, so the fix is a new attempt plus a report note, never a rewrite).
7. **Effective workspace root — env/registry-controlled, pinned by env, never assumed.** Not an external-root question after all: the resolver explicitly skips any candidate containing `.antifan-data` (that path is the app's data root, not a theme root) and falls back to `THEME_WORKSPACE_ROOT`/`ANTIFAN_WORKSPACE_ROOT`/`WORKSPACE_ROOT`, then to a theme-shaped cwd (`control-plane-runtime.ts:214-224`). Phase 4 therefore sets the fixer session's root by env to the staged directory and records the resolved value in request and receipt; an unset/unresolvable root refuses the attempt rather than defaulting to whatever cwd happens to be. If a run must target a root outside this repository, the receipt records explicit owner approval.
8. **Fixer tool-surface enforcement mechanism — the primitive must be built, not assumed.** None exists today: `isVisible` filters by risk class only, and the proxy hardcodes `grant: 'eval'`. Required, in order: (a) an allow-name filter in the session mint/capability list (or an equivalently narrow grant) admitting only `file.read` + `file.write`; (b) the proxy stopping its `grant: 'eval'` hardcode for fixer sessions; (c) the extension's `tool_call` guard as a second lever where the Phase 4 probe passes. `REFUSED_TOOL_SURFACE` is raised by (a)/(c); the merge gate cannot raise it, because a runtime override or `theme.qa_repair.*` leaves no file trace to audit.
9. **Load evidence as a probe precondition.** A probe that blocks nothing is ambiguous between "hooks do not see child calls" and "the package never loaded". The probe therefore records load evidence first (extension load diagnostics in the active state root's `logs/`, plus a `session_start` side effect) and only then interprets variant results.

## Risks

| Risk | Mitigation |
|---|---|
| The route assertion breaks legitimate storefront redirects (e.g. locale or `/` canonicalization) | Assert identity on origin+pathname, carry the full final URL as evidence, and refuse only on a path change; the exception path is recorded, not silenced |
| Hooks do not see child sessions, weakening the "machine-enforced" claim | Merge gate is primary and independent; the probe result is recorded as an explicit finding and the contract states which lever is live |
| Isolation staging drifts from the real workspace before the fixer reads it | Manifest is minted at stage time and re-verified at merge; a drifted base refuses the merge rather than applying onto an unknown base |
| The loop is used to manufacture a PASS by loosening tolerance | Constraints restate the inherited prohibitions; Phase 5's success criteria require a typed outcome, and `FIXED_VERIFIED` cannot be produced by the fixer |
| A repo-wide rollback is reached for during a failed fix | Destructive git commands are forbidden by constraint; recovery is path-scoped and must name files; Phase 6 wires the typed `STALEMATE` path so a bad round has a non-destructive exit |
| Phase 1's own fix accidentally rewrites immutable attempt directories | Regenerate as new attempts; never rewrite an existing attempt or published verdict file |
| A runtime override (`anti.theme.style_override` / `anti.browser.evaluate`) produces a visual "fix" that never touches a file, bypassing staging and merge | The fixer's capability surface is file-only, and a runtime override is rejected both as a fix and as evidence |
| The fixer session resolves a workspace root other than the staged one, so edits land in the real workspace | The root is pinned and recorded in the request and receipt; a staged write resolving outside the staged root refuses the attempt |
| A partial or interrupted merge publishes a success receipt | The merge gate stores pre-merge content, re-hashes the result, and refuses unless it equals `base ⊕ staged diff` |

## Handover from `260911-0133` (theme-fidelity campaign, stopped at a clean boundary)

This plan declares itself the blocker of `260911-0133-haravan-customize-theme-fidelity`, and that plan now
carries `blockedBy` naming this one. Its campaign is stopped with no run in flight. Four items belong to this
side of the boundary.

**1. Phase 1 should gate this harness too, not only `fifteen-pages-run.mjs`.** The publication gate waiting on
Phase 1 is the compare set produced by `.canary/tools/theme-fidelity.mjs`, whose `checkObservedUrl`
(`theme-fidelity.mjs:1118-1140`) asserts only host and `themeid` — pathname and query are recorded at
`targets[].dom.observedUrl` and never compared. Add the same assertion there with the same typed code. Two
measured facts keep it honest:

- All 21 legs of the retained run were route-faithful — each side was served its own requested route with its
  own requested theme (`/cart?themeid=1001512581`, `/products/ong-han-laser?themeid=-1`, …), with no
  `?openLogin=1`-style substitution — so the gate must not refuse this evidence.
- `?themeid=` is a legitimate parameter, not a redirect. Open decision 1's recommended rule (identity on
  origin + pathname, full final URL kept as evidence) covers this exactly; a rule that also rejects unknown
  query keys would refuse every subject leg of this campaign.

**2. A transport defect in session renewal, on the harness side too.** `canary-session.mjs` fails its mint with
`read ECONNRESET` inside its own pairing/lifecycle calls — 11 of 42 legs before the release existed, 6 of 21 in
the post-anchor run, 2 of 4 in the fast fixture. It is **not** a quota refusal: the port's 10-tab limit is per
bound session (`src/main/tools/browser-control-port.ts:2071-2079`, `getManagedTabIds(boundTabId).size >= 10`),
so a superseded session cannot block a fresh session's mint, and the harness's release is a red herring for
this class. Judge a release only by `doc.sessionRelease.released === true`. The bounded transport-only mint retry
is **implemented and it measures**: up to 3 attempts with a 3 s gap, re-running the mint and never a measurement,
each attempt recorded as `sessionRenewal`. Measured on the 4-pair fixture: **0 of 4 legs refused the renewal**,
`released: true` on all four, against 2 of 4 in every earlier fixture run and 6 of 21 in the post-anchor full run
— closed at fixture scale, not yet at campaign scale (21 legs). The adjacency reorder is kept for its failure
handling, not as a demonstrated remedy. Publication is therefore gated by the other classes: the same run refused
`article__1024x900` and `home__1440x900` on `content-changed-between-passes` and `cart__1440x900` on
`REFERENCE_IDENTITY_DRIFT+SUBJECT_IDENTITY_DRIFT`, so a campaign re-run still lands `INCOMPLETE` until those and
this plan's route assertion are addressed.

**3. Reference-side health before any settle tuning.** The same subject bundle scored 0 PASS against r1 and 5
against r2; r1's extra failures are reference-side (7 legs `REFERENCE_IDENTITY_DRIFT`, including 404@1024 and
404@1440, with r1 home@1440 recording `referenceHeight` 7532 where r2 records 5426), and in r2 every PASS is
desktop while all seven `390x844` legs refuse. Part of r1's reference side needs re-capture rather than tuning,
and the mobile-only pattern survives any image-stability change.

**4. Two instrument notes for whoever continues.** Promoting `data-src` without additionally *adding*
`lazyloaded` leaves a mixed loader state the theme keys CSS on (`style-all.scss.liquid:237/239/245`,
`style-ldpage-01.scss.liquid:617`, `ll-style-all.scss.liquid:113`; lazysizes declares
`loadedClass:"lazyloaded"`). And the settlement signal is only as strong as its path: the strict path needs four
consecutive stable samples, while the 9 s deadline path returns
`imagesSettled: pendingImages === 0 && stableSamples >= 2` — a floor, not proof.

**5. Assets and state.** Harness fixes are on disk and pushed at `0cbd91b`: the scroll offset is anchored before
the settle read, the superseded session is ended after each mint, and image identity plus document geometry
decide settlement alongside completeness. Fast validation loop, measured at 4 pairs in 197 s against a
50-minute campaign run — builder
`C:/Users/Admin/.omp/agent/sessions/--E--Work-apps-AntiFan--/2026-09-09T11-31-20-180Z_01a085ef-cbf4-765d-9a4f-ecf6ff8f7c77/local/build-fast-fixture.mjs`,
then `node .canary/tools/theme-fidelity.mjs compare --reference .canary/theme-fidelity-fast/r2mini --subject .canary/theme-fidelity-fast/subjectmini --out <dir>`.
The compare driver rebuilds its set directory at stage start, so a cancelled compare wipes working copies — the
committed copies under `.canary/theme-fidelity-run4/compare/` are the recovery source, restored path-scoped and
never repo-wide. `antifan-canary` is left running as shared infrastructure; `hub restart antifan-canary` is the
lifecycle lever, never a signal. Full evidence: `plans/reports/260911-1310-theme-fidelity-run4-verdicts.md`,
Handover section.

## Advisory Status

Architecture closed by the owner's Round 3.1 verdict; no further advisory round. This plan resolves implementation and verification gates only. The one remaining unknown (fact 10) is a Phase 4 probe with explicit pass/fail criteria.

Three implementation-level advisories arrived after the first red-team close and were each resolved by measurement, not by argument: (1) the "identical hash" alias claim was retired outright — on-disk `390-standalone-*.png` hashes are all distinct and the 1024/1440 reference hashes differ, so the alias is route identity alone (facts 3–4); (2) the contract-artifact layout was wrong — `.omp/RULES.md`, `.omp/skills/…`, `.omp/agents/…` and a bare `.omp/hooks/pre/` are not discovery sources, so the contract now ships as one loaded extension package registered in `.omp/config.yml` (Phase 3/4); (3) the fixer's capability surface is now `grant:'write'` + a `file.read`/`file.write` allowlist, because `grant:'write'` needs no `allowEval` while the write-class leak (`style_override`, `dump_dom`, `qa_repair.*`, `cursor.*`) still requires the allowlist (KDD 5). A parallel handover from `260911-0133` was folded into Phases 1–2 without weakening any constraint.

<!-- slug: antifan-b-lite-v2-subagent-workflow -->
