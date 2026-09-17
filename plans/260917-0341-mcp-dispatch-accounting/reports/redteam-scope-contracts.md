# Red-Team Review — Scope & Complexity Critic + Contract Verifier

**Plan:** `plans/260917-0341-mcp-dispatch-accounting/` (plan.md + phase-01…phase-07)
**Reviewer posture:** HOSTILE. Scope & Complexity Critic (unrequested-scope detector) with the Contract Verifier verification role.
**Subject request (verbatim):** *"Bổ sung bộ thống kê MCP để xem mức độ hiệu quả của từng MCP được gọi"* — add an MCP statistics suite showing how effective each MCP tool that gets called actually is.
**Date of evidence:** 2026-09-17, working tree `main` @ `41d662ee`, `git status --short` shows only the untracked plan directory (no implementation drift).
**Method:** every interface change was enumerated with grep/glob/read against the live tree; the plan's own measurement claims were re-measured where they are load-bearing. No lint/build/test was run, per instructions.

Bound note: the user's requested scope is treated as a constraint, not a finding. Where a *requested* feature is doubtful it is raised as a question. Additions beyond the request are flagged as unrequested scope.

---

## Finding 1: The Phase 7 gate is wired onto the app's launch path, and it is the only compile-chain gate whose inputs are live mutable data

- **Severity:** Critical
- **Location:** Phase 7, section "Requirements" / "Architecture" (`phase-07-gates-docs-and-followup.md:20`, `:32-35`, `:61`) and Phase 4 step 6 (`phase-04-delivery-surface.md:81`)
- **Flaw:** The plan inserts `check-panel-separation.mjs` into the `compile` chain "exactly like the existing `check-mcp-budget-dominance.mjs`" (`plan.md:53`, `phase-07:20`). That analogy is false about inputs: `check-mcp-budget-dominance.mjs` reads **only source** — it resolves the proxy module, the catalogue and `packages/super-core` src/dist, and contains **zero** references to `invocations`, `.antifan`, `gaps`, `dataRoot`, `ANTIFAN_DATA_ROOT`, `telemetry`, `os.tmpdir` or `process.cwd`. The new gate must build the **Panel A** payload from the compiled reader and the **Panel B** payload from `.antifan/telemetry/gaps*.jsonl` (`phase-07:58`), i.e. from live, machine-specific, concurrently-mutating stores. The plan never counts the compile chain's invocation sites, and one of them is app launch.
- **Failure scenario / cost:** `npm run compile` is invoked from **26** sites, including the launcher itself: `main.cjs:42` (`execSync('npm run compile')`) whose failure path shows `'AntiFan Browser Build Error'` and calls `process.exit(1)` (`main.cjs:43-54`), and `run-electron.cjs:92`. A Panel A/B payload that trips the gate's "shared total" or "new key" or ratio-key rule on a developer's live store bricks `npm start` and `npm run dev` until the data is cleaned — an observability gate taking down the application it observes. The repo's two other structural gates deliberately refuse this: `check-emit-integrity.mjs:24` "**Always exits 0** — the guard repairs the cause, it does not fail the build", `prune-orphan-emit.mjs:31` "Always exits 0: a prune failure must never fail a build".
- **Evidence:** `main.cjs:42`, `main.cjs:43-54`, `scripts/run-electron.cjs:91-92`, `scripts/check-emit-integrity.mjs:24`, `scripts/prune-orphan-emit.mjs:31`, `scripts/check-mcp-budget-dominance.mjs:38-47` and no data-dir reads anywhere in that file, `package.json:24` (chain), 19 × `npm run compile` in `package.json:20,49-57,60,61,65-69,72,73` plus `main.cjs:42`, `scripts/run-electron.cjs:92`, `scripts/certify-core-freeze.cjs:25`, `scripts/dev.mjs:160`, `scripts/install-windows-shortcut.mjs:38`, `scripts/benchmark-electron-performance.mjs:635,637`, `scripts/run-goal-ladder.mjs:91`.
- **Suggested fix:** keep the gate in the compile chain but make it **source/type-only**, exactly like the budget gate: assert the two payload **type declarations / allowlists** and the absence of a join in the compiled module surface, plus a seeded fixture. Never let it read `invocations/` or `.antifan/telemetry/`. If live-data enforcement is genuinely wanted, put it in `npm run audit` (already a fail-capable, developer-invoked script) and state explicitly that launch must not depend on it.

---

## Finding 2: The gate's own acceptance criteria are mutually contradictory and, in the compile chain, provably vacuous — a reader cannot verify them

- **Severity:** Critical
- **Location:** Phase 7, section "Implementation Steps" step 1 (`phase-07:58`), "Test Scenario Matrix" T7-2 (`:85`), "Success Criteria" (`:71`), "Risk Assessment" (`:114-115`); Phase 1 Constraint A (`plan.md:65`, `phase-01:26`); Phase 4 C3 (`phase-04:114`)
- **Flaw:** Three incompatible statements about what the gate examines, and one structural reason none of them can assert anything in the chain it is wired into:
  1. `phase-07:58` — the gate "builds both payloads … **against a fixture directory**".
  2. `phase-07:85` (T7-2) — "run the gate against the **live** service payloads".
  3. `phase-07:71` — "`npm run compile` … **passes on the real tree**".
  If (1) holds, the gate only ever inspects a fixture the same phase authored — the allowlist check becomes circular (the fixture is defined by the allowlist it is meant to police). If (2) holds, Finding 1's launch-blocking risk is real. And in the compile chain the gate receives no `--store` and may receive no `ANTIFAN_DATA_ROOT`, so by the plan's own Constraint A the CLI/reader "returns `UNMEASURED` when neither resolves" (`phase-01:26`) — the gate then compares two `UNMEASURED` payloads and passes. `phase-04:114` (C3) confirms this is the designed behaviour. A gate that passes because it read nothing cannot be distinguished from a gate that passes because the surface is honest, which is precisely the property `phase-07:43` calls "the plan's honesty keystone".
- **Failure scenario / cost:** the plan ships a build-failing gate whose green result carries no information on a clean machine, while its red result can block launch on a dirty one. Success Criterion `phase-07:71` ("fails when the gate fails … and passes on the real tree") is unfalsifiable as written: both outcomes are reachable with an empty payload set. Secondary instance of the same class: `phase-04:61` marks the `test/main/ipc-audit.test.ts` edit "**optional**" while `phase-04:98` makes it a mandatory Success Criterion ("The IPC channel exists and appears in the `test/main/ipc-audit.test.ts` required set").
- **Evidence:** `phase-07:58`, `phase-07:71`, `phase-07:85`, `phase-07:43`, `phase-01:26`, `plan.md:65`, `phase-04:114`, `phase-04:61` vs `phase-04:98`, `scripts/check-bottlenecks.mjs:281-283` (the registry's own model of what a real failure is).
- **Suggested fix:** pick one input and say what a green result proves. Recommended: gate reads **compiled types/allowlists + a fixture**, and a separate explicit success criterion states "the gate's real-tree mode requires `--store`; absent a store it reports `GATE_VACUOUS` and does not claim enforcement". Delete T7-2's "live" variant or make it a manual `npm run audit` step with captured output.

---

## Finding 3: Panel B's classification mechanism cannot produce the class the plan requires, and its "11 keys" measurement is false

- **Severity:** Critical
- **Location:** Phase 5, section "Requirements" (`phase-05-self-report-panel.md:20`), "Architecture / Why classification is by key presence" (`:44`), Success Criteria (`:75`), T5-3 (`:87`)
- **Flaw:** `phase-05:20` fixes the rule: "Records are classified **by key presence**". `phase-05:44` then states that "405 on-disk records carry exactly these 11 keys" and that the 4 fabricated records "are indistinguishable from a real event by shape alone — but they are *recognizable by name*". Re-measured, both halves are wrong:
  - The store has **5 distinct key sets**, not one, and only **1** of the 405 records carries all 11 keys: 324 records → `contextMode,errorCode,fallbackResult,fallbackTool,primaryTool,timestamp` (6 keys); 74 → `contextMode,fallbackResult,fallbackTool,primaryTool,timestamp` (5 keys); 5 → the 5-key set + `notes`; 1 → 10 keys; 1 → 11 keys.
  - The 4 fabricated records are **inside the 324-record 6-key set**: `{"timestamp":…,"contextMode":"STANDALONE_PLAYWRIGHT_DIAGNOSTIC_PROBE","primaryTool":"unknown","errorCode":"UNKNOWN_ERROR","fallbackTool":"browser_*","fallbackResult":"FAILED"}`. Their exact key set is shared with **320 other records**. A key-presence classifier therefore cannot yield `LEGACY_SUBSTITUTED` for 4 records without also labelling 320 measured records the same way — or it must discriminate on **values**, which contradicts the stated rule and which the plan never specifies (which value combinations count, and why).
- **Failure scenario / cost:** T5-3 and Success Criterion `phase-05:75` ("The 4 pre-fix fabricated records are displayed under `LEGACY_SUBSTITUTED` and never counted as measured events") are unreachable as specified. An implementer following the rule literally either mislabels 320/405 records (81% of the panel) as fabricated, or invents an unspecified value rule and ships an unversioned, undocumented heuristic — the exact "telemetry that cannot be distinguished from measurement" the recorder's own refusal rationale exists to prevent (`fallback-recorder.ts:43-52`).
- **Evidence:** measured on `E:\Work\apps\AntiFan\.antifan\telemetry\gaps.jsonl` (405 lines, 5 key sets, 324 records sharing the fabricated records' 6-key set; the 4 fabricated lines dumped verbatim); `phase-05:20`, `phase-05:44`, `phase-05:75`, `phase-05:87`; writer shape `src/main/telemetry/fallback-recorder.ts:17-20`, `:103-120` (optionals dropped by `JSON.stringify`, so <11 keys is the *normal* shape, not an anomaly).
- **Suggested fix:** replace "classify by key presence" with an explicit, written value predicate for `LEGACY_SUBSTITUTED` — e.g. `primaryTool === 'unknown' && fallbackTool === 'browser_*'` (which is defensible: `assertRecordableFallbackPayload` at `fallback-recorder.ts:53-72` refuses a blank `primaryTool`, so the literal `unknown` cannot be produced post-fix) — and state the count re-derived at run time. Delete the false "exactly these 11 keys" claim and the "shape alone" sentence.

---

## Finding 4: Panel B's mirrored root resolution provably cannot reach the second live store it must display

- **Severity:** Critical
- **Location:** Phase 5, section "Requirements" (`phase-05:26`), "Architecture" (`:33-39`), Success Criteria (`:73`), T5-5 (`:89`); plan.md Design Decision D (`plan.md:71`)
- **Flaw:** The plan requires two roots to be shown as two rows ("the repo root with 405 records, the app data root with 2", `phase-05:21`, `:73`, `plan.md:71`) and specifies the resolution rule as a mirror of the writer: "registry `rootPath` with its exclusions (empty, `=== dataRoot`, `=== path.resolve(dataRoot,'..')`, `!existsSync` — `control-plane-runtime.ts:262-271`), then `THEME_WORKSPACE_ROOT || ANTIFAN_WORKSPACE_ROOT || WORKSPACE_ROOT` (`:276`)". That rule **explicitly excludes `dataRoot`**, and the second live store is `<dataRoot>/.antifan/telemetry/gaps.jsonl`: measured, `E:\Work\.antifan-data\.antifan\telemetry\gaps.jsonl` (2 records) while `StorageLocations.getDataRoot()` resolves to `E:\Work\.antifan-data` (first writable candidate, `storage-locations.ts:41-62`). The store exists precisely *because* the writer collapsed `path.join('', '.antifan','telemetry','gaps.jsonl')` to a CWD-relative path while its CWD **was** the data root. A reader that mirrors the writer's *exclusions* can never look there, so Success Criterion "two live roots produce two rows" is unreachable by the specified mechanism. Compounding this: `getWorkspaceRoot()` is memoized on `${workspaceId}|${this.workspaceRoot}` (`control-plane-runtime.ts:250-255`) and its result changes with the lease, so "mirror the writer's resolution" is not a single well-defined value even in principle — it is a *set* of roots over time.
- **Failure scenario / cost:** the panel ships reporting one root (405) and a `NO_DATA` for the second, while the plan's own success criterion and manual step (`phase-05:67`) require 405 **and** 2. Either the criterion fails on the author's own machine, or the implementer silently adds a `dataRoot` glob that the plan never specifies — an undocumented fourth root rule that no test row covers.
- **Evidence:** measured `E:\Work\.antifan-data\.antifan\telemetry\gaps.jsonl` (2 lines) and `E:\Work\apps\AntiFan\.antifan\telemetry\gaps.jsonl` (405 lines); `src/main/config/storage-locations.ts:41-62`; `src/main/control-plane/control-plane-runtime.ts:250-255`, `:262-271`, `:276-286`; writer call site `src/main/tools/browser-capabilities.ts:968` → `src/main/telemetry/fallback-recorder.ts:122-128`.
- **Suggested fix:** specify the candidate root **set** explicitly as an enumerated list (registry `rootPath`; the env trio; `dataRoot` itself as the CWD-collapse candidate; and the launching process's CWD as the documented collapse origin), with a per-candidate `NO_DATA` + path row when a candidate has no file. State that the set, not a single value, is what is mirrored.

---

## Finding 5: Two load-bearing citations do not survive checking — one is a file that does not exist, one is a document that says something else

- **Severity:** High
- **Location:** plan.md `:65`; Phase 1 `:25`, `:26`, `:52` and Risk Assessment `:111`; Phase 5 `:27` and `:46`
- **Flaw, instance 1 — nonexistent path cited 5 times as the zero-write invariant's justification:** the plan repeatedly cites `src/main/session/storage-locations.ts` for the probe-write hazard (`plan.md:65`, `phase-01:25`, `phase-01:26`, `phase-01:52`, `phase-01:111`). That file does not exist. The class lives at **`src/main/config/storage-locations.ts`**. The cited line numbers are right (`getDataRoot` :29, the `mkdirSync` + `.probe-<pid>-<ts>` + `unlink` triple :52-55, `getControlPlaneDir` :101-103), which is what makes the error dangerous: an implementer will `read` a nonexistent path, and a reviewer will assume Constraint A was grounded. Instance 2 — a citation that asserts the opposite of what the document says: `phase-05:27` and `:46` cite `docs/operations.md:143-145` as the place that "states the [sanitization] guarantee" for the self-report panel. That section is "PII Sanitization Guarantee" for **Theme QA reports** — "All generated Theme QA reports automatically redact customer emails, phone numbers, and bearer tokens before saving artifacts" — and says nothing about `fallback-recorder.ts` or `gaps.jsonl`.
- **Failure scenario / cost:** the plan's single hardest invariant ("zero new writes on the app's hot dispatch path", P0, `plan.md:33`) rests on a path that cannot be read; and Panel B's "no new redaction logic is needed" argument is corroborated by a document that does not corroborate it. Both are the class of defect the plan's own Non-Goals section says it is fixing elsewhere (prose claims with no truth value).
- **Evidence:** `glob **/storage-locations.ts` → `src\main\config\storage-locations.ts` (only match); `src/main/config/storage-locations.ts:29`, `:52-55`, `:101-103`; `docs/operations.md:143-145`; `docs/operations.md:145` text vs `phase-05:27`, `phase-05:46`.
- **Suggested fix:** correct the module path in all five citations. For Panel B, cite `src/main/telemetry/fallback-recorder.ts:74-101` (the real sanitizer) and drop the `docs/operations.md:143-145` corrobation, or add the missing PII sentence to that section as a Phase 7 doc edit (which the plan does not currently propose).

---

## Finding 6: Panel B — and the build gate built to police it — are additions beyond what the user asked for

- **Severity:** High
- **Location:** Phase 5 in full (`phase-05-self-report-panel.md`, 8h) and Phase 7's gate (`phase-07:19`, `:43`)
- **Flaw (unrequested scope):** the user asked for a statistics suite showing how effective each called MCP tool is. Panel B measures a **different artefact family** — the agent's own fallback self-reports in `.antifan/telemetry/gaps.jsonl`, produced by `anti.telemetry.record_fallback`, not by MCP dispatch. The plan itself states it "carries **no field that feeds a Panel A total**" (`phase-05:23`), "is structurally incapable of being added to, averaged with, or divided by the ledger numbers" (`phase-05:14`), and has "no field that feeds a Panel A total". So Panel B contributes **zero** to the requested outcome by construction. It nonetheless lands: a second IPC channel, a second preload method, a second payload type, a Panel A/Panel B toggle in the renderer, a four-class classifier, a mirror-of-writer root resolver, per-root rows, rotation-aware re-globbing, and two new files. Phase 7 then adds `check-panel-separation.mjs` — a build-failing allowlist whose **only** purpose is to prevent a future feature from joining two things the user never asked to have separated (`phase-07:43`). The honesty machinery for the requested ledger surface (Phases 1-3) is one population; the unrequested population is given equal or greater build weight (8h + 6h against Phase 3's 6h).
- **Failure scenario / cost:** roughly a third of the plan's effort and one of its two headline build gates exist to serve a metric that, by the plan's own design, can never be combined with the requested one. Every future change to either panel now pays a compile-chain tax, and every reviewer must learn a two-panel contract.
- **Evidence:** `phase-05:14`, `:23`, `:16`; `plan.md:19` ("plus an optional best-effort proxy-side emitter") versus `plan.md:32` (Goal 5, P1) and `plan.md:134` (Success Criterion); `phase-07:19`, `:43`; effort table `plan.md:118-124` (Phase 5 = 8h vs Phase 3 = 6h).
- **Suggested fix:** keep the delivery (it is a genuine divergence signal and the user's three scope decisions did not cover it), but re-classify it honestly: put Phase 5 and the separation gate **behind an explicit user decision** the way the `core.*` emitter was, and state in the plan header that the user's request is satisfied by Phases 1-4 alone. If Panel B is kept, cut the gate to an `npm run audit` check rather than a compile-chain entry (see Findings 1-2).

*Question form for the requested-surface items, per the review constraint:* the ledger reader itself is in scope and not challenged. Two related doubts raised as questions rather than cuts — (i) is byte-level reproducibility (`--freeze`, `--as-of`, `--no-memo`, two-run byte-identity as a Success Criterion, `plan.md:137`, `phase-04:96`) part of "xem mức độ hiệu quả", or a determinism laboratory layered on it? (ii) Goal 2 makes it P1 to recover 247 quarantined frames out of ~19,119 (`plan.md:28`, `:49`) — 1.3% of the population — which is what justifies the whole admission apparatus; if the user wanted the tool-level effectiveness view, could admitted-frame coverage be reported as a labelled `UNMEASURED` margin instead of being recovered? Both are questions, not recommendations to cut.

---

## Finding 7: The e2e probe that justifies Phase 4's bridge design is misdescribed, is in no test lane, and the hazard it is said to cover is not the hazard that exists

- **Severity:** High
- **Location:** Phase 4, section "Requirements" (`phase-04:26`), Risk Assessment (`:144`), Success Criteria (`:95`), R6 (`:110`)
- **Flaw:** `phase-04:26` states that "the e2e hub probe, which **stubs only 7 channels** (`test/e2e/toolbar-qa-hub-empirical-probe.cjs:41-138`)" requires optional-chaining on the new bridge method. Three verifiable problems:
  1. The probe does **not** stub a partial bridge. Its seven entries at `:41, :55, :76, :122, :136, :137, :138` are **`ipcMain.handle` registrations in the main process**, and the window is created with the **real preload** (`preload: path.resolve(__dirname, '../../.compiled/src/preload/toolbar-preload.js')`, `:145`). The renderer therefore always has the full bridge object; `getMcpDispatchState` will exist the moment Phase 4 adds it to the preload. Optional chaining guards nothing here.
  2. The real hazard is the inverse of the one stated: with the real preload but **no** `ipcMain.handle('antifan:mcp-dispatch:get-state')` registered in the probe, `ipcRenderer.invoke` **rejects**. The plan's R6 ("bridge without the method") tests a synthetic condition that cannot occur, while the condition that can occur (handler absent → rejected promise) is covered by nothing in the 9 edits unless `refreshMcpDispatchState()` carries its own `try/catch` — the precedent `refreshCoreHealthState()` has one (`toolbar.ts:518-530`), but the plan never says the new function must.
  3. The probe is in **no lane**: it is a `.cjs` under `test/e2e/` with no `.test.` in its name, so `test:e2e`'s glob `".compiled/test/e2e/**/*.test.js"` (`package.json:45`) cannot match it, `tsc`'s `include` (`tsconfig.json: include: ["src/**/*.ts","scripts/**/*.ts","test/**/*.ts"]`) does not emit it, and no npm script references it. It also asserts nothing — it `console.log`s telemetry and writes a JSON file (`test/e2e/toolbar-qa-hub-empirical-probe.cjs:290-298`).
  Moreover the probe never clicks the new tab at all: TRACE 2 clicks `tabNavWorkflows`, `tabNavMcp`, then `tabNavWorkflows` (`:250`, `:273`), so it never reaches `refreshMcpDispatchState()` under any design.
- **Failure scenario / cost:** a design constraint (`getMcpDispatchState?:` optional, `phase-04:71`) and a whole test row (R6) are justified by an artifact that no lane runs and that does not exercise the path. The genuine "no handler registered" rejection path ships untested, and a future reviewer who deletes the optional marker on the strength of this citation will not be corrected by any test.
- **Evidence:** `test/e2e/toolbar-qa-hub-empirical-probe.cjs:41`, `:55`, `:76`, `:122`, `:136-138` (7 × `ipcMain.handle`), `:145` (real preload), `:250`, `:273` (tabs clicked), `:290-298` (no assertions); `package.json:45` (`test:e2e` glob), `tsconfig.json` `include`; no `toolbar-qa-hub-empirical-probe` reference anywhere in `package.json`; precedent `src/renderer/toolbar.ts:518-530`.
- **Suggested fix:** restate the risk as "the probe (or any host that loads the real preload without the new handler) makes `invoke` reject"; make `refreshMcpDispatchState()` `try/catch → UNMEASURED` in the edit list (mirroring `:518-530`); and cite the probe accurately or drop it and cite the renderer unit harness instead.

---

## Finding 8: The delivery surface omits the Hub's own open path, and the HTML anchor is off by one against the plan's own acceptance test

- **Severity:** High
- **Location:** Phase 4, step 4 edit list (`phase-04:70-79`), Related Code Files (`:59`), R1 (`:105`)
- **Flaw:** `openWorkflowHub()` (`src/renderer/toolbar.ts:488-515`) is the function that populates the Hub when the overlay opens. It unconditionally awaits `refreshCoreHealthState()` (`:505`) and then `renderHubList()` (`:507`) plus a per-tab dispatch (`:508-514`). The plan's nine edits touch `:89`, `:430-446`, `:448`, `:450-458`, `:459-466`, `:563`, `~:693`, `:949-955` and `:2819` — **`openWorkflowHub` is not among them**, and no refresh is added to it. So the `mcp-dispatch` tab renders from whatever `hubMcpDispatch` happens to hold; on the first open after a window reload with the tab already active, or on any re-open, the list is stale or empty while the sibling tabs refresh. Every test row starts from a fresh load (R1-R7), so none of them can catch this. Separately, the HTML edit says "one nav button at `:503`" (`phase-04:59`) while `toolbar.html:503` is the closing `</button>` of `#tabNavRegressions`; `.hub-nav-strip` closes at `:504`. An implementer anchoring *on* line 503 rather than *after* it lands the button outside the strip and fails the plan's own R1 ("`#tabNavMcpDispatch` non-null, **inside** `.hub-nav-strip`", `phase-04:105`, `:99`).
- **Failure scenario / cost:** the marquee deliverable of Phase 4 ("a new tab in the existing Workflow & MCP Hub", `phase-04:14`) intermittently shows an empty list in normal use — close the Hub, reopen it, and the dispatch rows are whatever the previous render left. This is the classic gap that survives a green test suite built only from `loadToolbar()`.
- **Evidence:** `src/renderer/toolbar.ts:488-515` (`openWorkflowHub`, `refreshCoreHealthState()` at `:505`, tab dispatch `:508-514`), edit list `phase-04:70-79` (no `openWorkflowHub` entry), `phase-04:59` ("one nav button at `:503`"), `src/renderer/toolbar.html:499-504` (`#tabNavRegressions` closes at `503`, `.hub-nav-strip` closes at `504`, opens at `468`), `phase-04:99`, `:105`.
- **Suggested fix:** add a tenth edit: in `openWorkflowHub()`, `void refreshMcpDispatchState()` beside the existing `refreshCoreHealthState()` call, and a test row that opens the Hub, closes it, reopens it and asserts rows are present. Change the HTML anchor to "immediately before the closing `</div>` of `.hub-nav-strip` (`toolbar.html:504`)", which is unambiguous.

---

## Finding 9: The `plans/bottlenecks.json` follow-up row is not expressible in the registry's predicate grammar, and `npm run plans:check` is cited as an acceptance gate it cannot be

- **Severity:** High
- **Location:** Phase 7, Requirements (`phase-07:22`), step 5 (`:62`), T7-6 (`:89`), T7-8 (`:91`), Success Criteria (`:74`)
- **Flaw:** The plan asks for a bottleneck row "with a predicate that is true while the defect is present (e.g. it asserts that a frame containing an `undefined` array slot still fails strict verification after round-tripping, **or an equivalent executable check**)". `scripts/check-bottlenecks.mjs` evaluates predicates through `evaluateRaw()`, which supports exactly: `any-of`, `all-of`, `campaign-verdict-ledger`, `manual`, `file-regex`, `file-absent-regex`, `json-path-equals`, `json-path-missing`, `script-exists`, `script-matches`. There is **no** executable/DOM-free code predicate kind, and an unknown kind returns `{present: null}` → `NO_PREDICATE` → **exit 1** (`check-bottlenecks.mjs:224-226`, `:277-279`). So the requested row is unimplementable as described; only a static proxy (`file-regex` over `src/shared/control-plane-contracts.ts` matching the array branch's `.join(',')`, or `file-absent-regex` for the fix) can work, and the plan does not say so. The registry's 36 existing rows confirm this: measured kinds are `any-of`, `campaign-verdict-ledger`, `file-absent-regex`, `file-regex`, `manual`, `script-exists`, `script-matches`. Related: T7-8 makes `npm run plans:check` an acceptance criterion, but `check-plans.mjs` only validates that each `plans/**/plan.md` carries a recognised `status:` spelling (`check-plans.mjs:15-25`, `:27-37`, `:53`) — it cannot detect a missing deliverable, a stale doc, or a wrong receipt.
- **Failure scenario / cost:** the "machine-tracked follow-up" the plan's whole Non-Goals construction rests on degenerates into a speculative string regex (which does not actually test the defect) or a hard `NO_PREDICATE` build failure on first `npm run audit`, discovered only after the phase is written. And a reader of the acceptance receipt sees `plans:check` green and reasonably infers the deliverables were validated.
- **Evidence:** `scripts/check-bottlenecks.mjs:137-226` (predicate kinds), `:224-226` (`unknown predicate kind` → `present: null`), `:277-279` (`NO_PREDICATE` → `fail` → exit 1), `:14-25` (verdict table); `plans/bottlenecks.json` (36 rows; kinds enumerated above); `scripts/check-plans.mjs:15-25`, `:53`, `:39-60`.
- **Suggested fix:** specify the row as a `file-regex` (or `file-absent-regex`) predicate over `src/shared/control-plane-contracts.ts` with the exact pattern and the exact intended status (`open`, predicate present → `OPEN`, exit 0), and state that the executable round-trip check lives in a unit test, not in the registry. Restate T7-8 as "`plans:check` validates plan frontmatter only" so the receipt does not overclaim.

---

## Finding 10: Where the plan meets duplicated logic it keeps the duplication and pins it with tests; where the reader and writer disagree on the population rule it keeps the disagreement

- **Severity:** Medium
- **Location:** Phase 2, section "Line splitting (one definition, three call sites)" (`phase-02:53-55`); Phase 1, Requirements (`phase-01:27`) and X1 (`phase-01:83`); Phase 4, `test/main/ipc-audit.test.ts` (`:61`, `:98`)
- **Flaw:** (i) `phase-02:55` offers as an acceptable outcome: "If a reviewer judges the ledger edit too broad for this phase, the fallback is to **accept the duplication explicitly and pin it with matrix rows T1/T3**". That converts a three-line regex into either one shared definition or two definitions kept honest by fixtures — in a plan whose stated thesis is "a second copy would be a second source of truth" (`phase-02:35`). The same paragraph says a divergence "silently reclassifies lines between `UNPARSEABLE` and blank", i.e. the duplication is known to be load-bearing. An escape hatch with no decision procedure will be taken under schedule pressure. (ii) The reader's population rule is deliberately **not** the writer's: `phase-01:27` locks `name.includes('.jsonl')` while the ledger uses `endsWith('.jsonl')` (`invocation-ledger.ts:126`, `:142`). Two definitions of "what a partition is" now exist, with the divergence justified by 7 quarantine files. `phase-01:61` (X1) even describes a `.jsonl.bak`-style decoy as "non-matching … that must be **included** by the `includes('.jsonl')` rule" — the fixture labels as non-matching the very file the rule admits, which is how a rule this wide stops being auditable. (iii) `phase-04:61` marks the `ipc-audit` edit optional while `:98` requires it; and the target array is not a channel registry — `test/main/ipc-audit.test.ts:419-425` is a five-entry **workflow** channel list inside the test "enforces single workflow authority in native-tab-host delegating through control-plane runtime" (`:415`). Adding an MCP-dispatch channel there dilutes an authority invariant rather than covering the new surface.
- **Failure scenario / cost:** the plan ships either one or two line-splitters depending on reviewer mood, and a reader that admits `x.jsonl.bak` while the writer would ignore it — a divergence with no contract test, only fixtures. The `ipc-audit` edit, being both optional and mandatory, is the kind of ambiguity that resolves to "skip it", leaving the new channel with no existence assertion beyond the renderer test.
- **Evidence:** `phase-02:35`, `:53-55`; `invocation-ledger.ts:126`, `:142`, `:177`, `:418`; `phase-01:27`, `:61`, `:83`; `test/main/ipc-audit.test.ts:415-431` (required set at `:419-425`, five workflow channels); `phase-04:61` vs `phase-04:98`.
- **Suggested fix:** delete the duplication fallback — make the `splitFrameLines` export mandatory (`phase-02:55` already gives the seam module, so the ledger edit is two lines), and record the two existing `split` sites as part of the same move. For the population rule, state it as exactly one string (`/\.jsonl/` test on the entry name) with the writer's narrower rule named as the *reason* files are treated as extended partitions, and fix X1's wording. Move the channel-existence assertion into the new `test/renderer/mcp-stats-hub.test.ts` or a dedicated IPC-surface test rather than the workflow-authority test.

---

## Consumer Inventory

Every count below was produced by grep/glob/read against the live tree at `41d662ee`. "Plan says" quotes the plan; "verified" is the measured result.

### (a) `computeFrameChecksum` extraction out of `invocation-ledger.ts`

| | Plan says | Verified |
|---|---|---|
| Definition | `invocation-ledger.ts:90` | ✅ `:90-93` |
| Call sites | 4 — `:198`, `:429`, `:796`, `:834` | ✅ exactly 4 |
| Repo-wide occurrences | "exactly one file" | ✅ only `src/main/session/invocation-ledger.ts` (plus plan prose) |
| Test files importing the module | 6, each `import { InvocationLedger }` only | ✅ exactly 6, each single-symbol: `test/main/invocation-ledger.test.ts:6`, `capability-catalogue.test.ts:6`, `historical-authority-replay.test.ts:6`, `nested-cancellation.test.ts:8`, `target-transition.test.ts:8`, `workflow-engine.test.ts:28` |
| `crypto` in ledger | used only at `:92` | ✅ `:3`, `:92` only |
| `canonicalJsonStringify` in ledger | used only at `:91`; `canonicalDigest` stays (`:308`, `:373`) | ✅ `:10`, `:91` and `canonicalDigest` at `:9`, `:308`, `:373` |
| `InvocationRecord` exported for the new seam module | asserted importable | ✅ `export interface InvocationRecord` at `:19` |
| Compile gates need no edit | `check-emit-integrity.mjs`, `prune-orphan-emit.mjs` | ✅ both structural: `check-emit-integrity.mjs:54-72` derives emit from the source tree; `prune-orphan-emit.mjs:41`, `:75-82` keeps emit whose source stem exists |
| **Non-test consumers the plan never lists** | — | ⚠️ **4**: `src/main/tools/capability-transport.ts:21` (value import), `src/main/control-plane/control-plane-runtime.ts:11` (value + `InvocationLedgerStats` type), and two **script** consumers of the compiled module: `scripts/certify-core-freeze.cjs:43` (member of the 11-file build-identity hash at `:38-56`) + `:60` (`DEFAULT_MAX_INVOCATION_FRAME_BYTES`), `scripts/smoke-real-soak.cjs:25` (same destructure) |
| **Freeze-identity side effect the plan never lists** | — | ⚠️ the extraction changes the bytes of `.compiled/src/main/session/invocation-ledger.js`, a named input to `computeBuildIdentity()` (`certify-core-freeze.cjs:43`), which is compared run-to-run (`:142`) and written into `freeze-certificate.json` (`:176`). Existing certificates are invalidated even though the comparison itself stays green. |

**Verdict:** the plan's *test* blast-radius claim is correct and was proven (6/6). It is **incomplete**: 4 non-test consumers exist (2 source, 2 script), and the extraction mutates a certification input.

### (b) New IPC channel `antifan:mcp-dispatch:get-state` + preload method `getMcpDispatchState`

| Consumer | Verified |
|---|---|
| Producer (main) | 1 — `src/main/browser/native-tab-host.ts` after `:2247` (core-health block `:2226-2247`, `antifan:capsule:list` at `:2248` — both anchors correct) |
| Preload definition | 1 — `src/preload/toolbar-preload.ts` after `:131` (`getCoreHealthState` at `:130`, `getCoreTaskRunTrace` at `:131` — anchor correct) |
| Bridge exposure | 1 — `contextBridge.exposeInMainWorld('antifanToolbar', toolbarApi)` at `toolbar-preload.ts:207` (fans the whole surface out to the renderer) |
| Renderer type | 1 — `src/renderer/toolbar.ts:89` (`getCoreHealthState?`), `:123` (`antifanToolbar?: AntiFanToolbarApi`), `:128` |
| Renderer call sites | 1 new (`refreshMcpDispatchState`); precedent `toolbar.ts:519` |
| Renderer tests consuming the bridge | 2 — `test/renderer/core-health-hub.test.ts:105-125` (`makeApi`, needs no change if the type stays optional) and the new `test/renderer/mcp-stats-hub.test.ts` |
| **"e2e probe stubs a partial bridge"** | ❌ **false.** `test/e2e/toolbar-qa-hub-empirical-probe.cjs` registers **7 real `ipcMain.handle` channels** (`:41`, `:55`, `:76`, `:122`, `:136`, `:137`, `:138`) and loads the **real preload** (`:145`). Count of 7 is right; the mechanism is a real main process + real preload, not a stub object. |
| Probe's coverage of the new channel | ❌ the probe clicks `tabNavWorkflows`/`tabNavMcp`/`tabNavWorkflows` (`:250`, `:273`) and never the new tab; it asserts nothing (`:290-298`); and it is in **no lane** (`test:e2e` glob `package.json:45` requires `.test.js` under `.compiled/test/e2e/`; `tsconfig.json` `include` excludes `.cjs`; no npm script names it) |
| Channel-registry test | 1 candidate, and it is the wrong one: `test/main/ipc-audit.test.ts:419-425` is the 5-channel **workflow authority** required-set inside the test at `:415` |

**Verdict:** 1 producer, 1 preload definition, 3 renderer touch-points, 2 renderer tests, 0 real e2e coverage. The plan's "7 channels" count is correct; its characterisation of the probe, its justification for optional chaining, and its chosen channel-registry test are all wrong (Findings 7, 10).

### (c) `HubTab` union / `HUB_NAV_BUTTONS` / `HUB_CORE_TABS`

| Symbol | Consumers | Verified list |
|---|---|---|
| `HubTab` (type) | 7 sites | `toolbar.ts:448` (decl), `:449` (`HUB_CORE_TABS` annotation), `:450` (`Record<HubTab,…>`), `:460`, `:462`, `:941` (param), `:943` (cast) |
| `HUB_NAV_BUTTONS` | **1** | `toolbar.ts:450-458` (decl) and its only read at `:943-945` (the active-class loop). Missing key = TS2739 on the `Record<HubTab, …>` annotation — the plan's compile-enforcement claim holds |
| `HUB_CORE_TABS` | **2 reads + 1 decl** | `:449` (decl), `:512` (`openWorkflowHub` tab dispatch), `:601` (`renderHubList` branch). Both are `coreListItems()`-bound; the plan's "do not add to `HUB_CORE_TABS`" instruction is correct, and `:706` (`if (!s) return []`) plus `:789` (`'Đang tải dữ liệu Core…'`) are the stated consequences — both verified |
| `hubActiveTab` readers | 9 | `:512`, `:568`, `:601`, `:707`, `:723`, `:737`, `:756`, `:764`, and `:948`/`:953` via `setHubTab` |
| `setHubTab` call sites | **7** | `:2813`, `:2814`, `:2815`, `:2816`, `:2817`, `:2818`, `:2819` — the plan's "seven click-listener call sites" is exactly right; no other caller exists |
| `renderHubList` call sites | **10** | `:507` (`openWorkflowHub`), `:640` (`selectWorkflow`), `:827` (`renderCoreListSelection`), `:948` (`setHubTab`), `:960` (`selectMcpTool`), `:2822` (`btnCoreRefresh`), `:2829` (`#hubSearchInput` `input`), `:2834` (`hubSearchClear`), `:2849` (delete workflow), `:2886` (new workflow). The plan's single edit at the function head covers all ten; the plan names only `:563`/`:565` |
| Search path for R7 | ✅ | `:2825-2830` — `hubSearchInput` `input` → `renderHubList()` |
| Anchors | `renderHubList` `:563`/`:565`, `HUB_CORE_TABS` check `:601`, `setHubTab` `:941`/`:949-955`, click wiring `:2819`, nav refs `:430-446`, state `:459-466`, `:89` | all ✅ (the plan's prose uses both `:563` and `:565` for one function head) |

**Verdict:** the plan's counts for `setHubTab` (7) and its "do not add to `HUB_CORE_TABS`" reasoning are correct. It never enumerates `HUB_CORE_TABS`' two read sites or `renderHubList`'s ten call sites, and it omits `openWorkflowHub` from the edit list (Finding 8).

### (d) New `package.json` script and the compile-chain insertion

| | Plan says | Verified |
|---|---|---|
| Chain location | `package.json:24`, after `check-mcp-budget-dominance`, before `prune-orphan-emit` | ✅ `package.json:24` is exactly `build-native-host-shim && check-emit-integrity && tsc && check-mcp-budget-dominance && prune-orphan-emit && copy-static && build:extension` |
| Fixture-mode precedent | `check-mcp-budget-dominance.mjs --proxy <fixture>` | ✅ `:30` (doc), `:42-43` (parse), single `process.exit(1)` at `:382` |
| New script anchor | "after `:64`" (`certify:core-freeze`) | ✅ `package.json:64` |
| **Chain invocation sites** | not counted anywhere in the plan | ⚠️ **26**: 19 in `package.json` (`:20` rebuild, `:49-57` nine `smoke:*`, `:60` `smoke:soak`, `:61` `smoke:theme-golden-live`, `:65-69` five `smoke:*`/`test:*`, `:72` `smoke:device`, `:73` `smoke:phone-ui`) plus `main.cjs:42` (**launch path, `process.exit(1)` on failure**), `scripts/run-electron.cjs:92`, `scripts/certify-core-freeze.cjs:25`, `scripts/dev.mjs:160`, `scripts/install-windows-shortcut.mjs:38`, `scripts/benchmark-electron-performance.mjs:635`, `:637`, `scripts/run-goal-ladder.mjs:91` |
| Gate class | "same class as the budget gate" | ❌ the budget gate reads no runtime data (zero matches for `invocations`/`.antifan`/`gaps`/`dataRoot`/`ANTIFAN_DATA_ROOT`/`telemetry`/`cwd`); the new gate must read both stores |

**Verdict:** the insertion point is right; the blast radius is 26 invocation sites including the app launcher, and the claimed gate equivalence is false (Findings 1, 2).

### (e) `startSession` response extension in `bridge-server.ts`

| Consumer | Verified |
|---|---|
| Producer | 1 — `src/main/bridge/bridge-server.ts:2156-2173` (`respond(true, { runId, attemptId, attachmentId, secret, projectId, workspaceId, tabId, authorityRevision, host, port, expiresAt, allowedCapabilityNames, forbiddenCapabilityNames, runtimePid })`) — anchor correct |
| **In-process consumer #1** | `scripts/antifan-agent.cjs:515` (`rpcCall(ws,'antifan.cli.startSession',…)`), validated field-by-field at `:517-528`, `runtimePid` consumed at `:535-546` — the plan names this one |
| **In-process consumer #2 (plan says "the one app-side injection point")** | ❌ `scripts/antifan-omp-mcp.cjs:1301-1345` — the proxy's own autoheal calls `antifan.cli.startSession` (`:1342`), resolves the raw response at `:1313`, validates the same four fields at `:1347-1357`, and builds `dynamicBootstrap` at `:1359-1371`. There are **two** consumers, not one |
| Other consumers | `scripts/smoke-packaged-theme-developer.cjs:200`; `test/unit/bridge/bridge-terminal-affinity.test.ts:110,121,131,145,155,166,176,184,192` (9 call sites); `test/main/bridge-server.test.ts:273-325` (asserts `attachmentId`/`authorityRevision` individually — additive-safe); `test/main/bridge-attachment-dispatch.test.ts:1239,1248,1282`; `test/main/cli-agent-launcher.test.ts:337,610,670` (mock bridge); `test/main/mcp-industrial-e2e.test.ts:200` |
| Additive safety | all validators are field-specific (`!session?.attachmentId && 'attachmentId'`, … `antifan-agent.cjs:517-527`; `antifan-omp-mcp.cjs:1347-1356`) → a new key cannot trip them ✅ |
| Injection reaches the proxy | ✅ via `resolveAgentCommand` `args[0]==='mcp'` → `antifan-omp-mcp.cjs` (`antifan-agent.cjs`, `resolveAgentCommand`) and `childEnv` at `:761-793` → `spawnAgentChild(..., childEnv)` `:798`. The plan's plumbing is real |

**Verdict:** 1 producer, **2** in-process consumers (plan enumerates 1 and asserts it is "the one"), plus 1 smoke script and 6 test files. Additive-safety verified. The unenumerated second consumer matters because the proxy can receive the response in-process without the launcher's `childEnv` (Finding under (f)).

### (f) New environment variable `ANTIFAN_PROXY_TELEMETRY_DIR`

| | Verified |
|---|---|
| Readers today | **0** — the variable does not exist in the tree; the proxy has no `node:fs` and no file sink (`scripts/antifan-omp-mcp.cjs` — diagnostics go to `process.stderr` only) |
| Writers today | **0**; proposed writers: `src/main/bridge/bridge-server.ts:2156-2173` (produce the field) and `scripts/antifan-agent.cjs:761-793` (forward into `childEnv`) |
| Nearest existing path-like variable | `SUPER_CORE_DB` at `scripts/antifan-omp-mcp.cjs:451-452`, which **does** default to `path.join(__dirname,'..','.super-core','core.db')` — the plan's named anti-pattern, verified |
| Env-inheritance blast radius | ⚠️ `childEnv` spreads `sanitizedParentEnv = { ...process.env }` (`antifan-agent.cjs:756`, `:762`) and is passed to `spawnAgentChild` (`:798`). The variable therefore reaches the **agent process and every descendant it spawns**, not only the one proxy the plan describes. Any second/instrumented proxy, or an agent-run shell command that exports the same name, can append to the store |
| Second injection opportunity not enumerated | ⚠️ the proxy's own `autohealSession()` already holds the full `startSession` response in-process (`antifan-omp-mcp.cjs:1313`); the plan does not say whether the proxy should read the root from that response too, nor what happens when `antifan-agent.cjs` omits the field while the proxy's own autoheal response carries it (`phase-06:84`: "Do not add a default when the response omits it") |
| Compile-gate safety of the wrap point | ✅ `check-mcp-budget-dominance.mjs:305-317` executes every advertised `core.*` binding through `def.execute(SENTINEL_PARAMS, {})`, so wrapping `invokeCore` (`:522-542`) would run the emitter during `npm run compile`; wrapping the call site at `:1533-1536` (before identity at `:1561`) avoids that — the plan's reasoning is correct |
| Anchor correctness | ✅ `:1534-1535` core branch, `:1561` identity mint, `:1979-1988` exports, `:451-452` `SUPER_CORE_DB` |

**Verdict:** 0 existing readers/writers (a genuinely new variable), 2 proposed writers, and the inheritance surface is wider than the plan states (the whole agent subtree, not one proxy). The plan's compile-gate reasoning about the wrap point is correct and verified.

---

## Summary table

| # | Finding | Severity |
|---|---|---|
| 1 | Panel-separation gate wired onto the app launch path; only compile-chain gate with live-data inputs | Critical |
| 2 | Gate's acceptance criteria mutually contradictory; vacuous in the chain it is wired into | Critical |
| 3 | Panel B key-presence classifier cannot yield `LEGACY_SUBSTITUTED`; "11 keys" claim false (5 key sets; 324 share the fabricated set) | Critical |
| 4 | Panel B root rule excludes `dataRoot`, so the second live store is unreachable | Critical |
| 5 | `src/main/session/storage-locations.ts` does not exist (5 citations); `docs/operations.md:143-145` cited for a guarantee it does not make | High |
| 6 | Panel B (8h) + its exclusive build gate (6h) are unrequested scope and contribute zero to the requested outcome | High |
| 7 | e2e-probe justification false (real preload + 7 real handlers, probe in no lane, new tab never clicked); the real rejection hazard is unmitigated | High |
| 8 | `openWorkflowHub` omitted from the 9 edits → stale/empty tab on reopen; `toolbar.html:503` anchor off by one against R1 | High |
| 9 | Bottleneck predicate not expressible in `check-bottlenecks.mjs`'s grammar; `plans:check` cited as a gate it cannot be | High |
| 10 | Duplicated `splitFrameLines` offered as an acceptable outcome; divergent population rule kept; `ipc-audit` edit simultaneously optional and mandatory | Medium |
