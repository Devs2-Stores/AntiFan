# ANONYMIZED VERIFY PACKET — 5 reframings (identity-stripped)

Candidates were relabeled **A–E** with a randomized mapping the controller keeps privately.
The labels inside any text are the candidates' own and carry no information — score content only.

**Task given to every candidate:** diagnose the stuck-type, pick a problem-solving technique,
choose F1 ("the audit list is wrong") / F2 ("the list is right but never closed") / a third framing,
apply the technique to this repo, and give an unblock path the controller can implement immediately.

---

## Controller ground truth (measured this session — authoritative)

Any candidate claim contradicting these is factually wrong and must be docked.

| Fact | Measured value |
|---|---|
| Repo-root files by extension | **14 `.md`**, 57 `.png`, 1 `.docx`, 2 `.log`, 1 `.cjs`, 5 `.json`, 1 `.js`, 1 `.vbs`, 1 `.txt` |
| `plans/**/plan.md` count | **57** |
| plan `status:` histogram | pending 10 · in-progress 8 · **completed 16** · active 1 · *(no status)* 10 · complete 5 · done 1 · superseded 1 · `"superseded"` (quoted) 4 |
| `plans/260830-1617-runtime-resilience-and-semantic-hardening/plan.md` | `status: completed` (read directly) |
| `.canary/15-pages/_verdicts.json` | **EXISTS** — 5,137 B, mtime `2026-09-10T15:27:48Z`; keys `runId, generatedAt, startedAt, finishedAt, instance, instanceRecord, runLock, tabCensus, refusals, tally, executiveVerdict, cases, superseded, exit`; `executiveVerdict: "INCONCLUSIVE"`; `tally` all zeros; `cases: 0` |
| `test/unit/*.test.mjs` | **7** files |
| `tsconfig.json` | no `incremental`, no `tsBuildInfoFile`; `include` = src/scripts/test `**/*.ts`; `outDir` `.compiled`; `strict`, `noUncheckedIndexedAccess`, `skipLibCheck` |
| `.gitignore` | contains `.canary/` and `*.tsbuildinfo` |
| `package.json` | `:18` clean = `fs.rmSync('.compiled',…)`; `:21` compile starts `npm run clean &&`; `:37` test starts `npm run clean &&`; `:38` verify = typecheck + test; no file-scoped test script; test globs cover `.compiled/test/**` only (no `.compiled/src/**`, no `.mjs`) |
| `enableRetentionCleaner` | grep over `src` + `scripts` → only `src/main/tools/artifact-store.ts:48` (declaration) and `:71` (guard). No caller passes `true`. |

---

## Candidate A

**Technique:** Inversion Exercise (Meta-Pattern as supporting lens).
**Framing:** F3 — the repo has no closure substrate. A closure transaction needs three premises:
(1) a durable, tracked, status-bearing record; (2) a cheap re-check; (3) a way to run that re-check
without destroying the running environment. Measured: **all three fail.** Audit is therefore the only
activity with near-zero marginal cost, so the list grows. F2 is right on observation, wrong on causality.

**Key evidence offered:** `.canary/CORE-BOTTLENECKS.md` is a real 415-line finding ledger with a
`claim | status | evidence` table — but it lives inside gitignored `.canary/`. 60 campaign dirs in `plans/`
(260815→260910). "Root `.md` reports = 12." `.canary/15-pages/_verdicts.json` now exists (scout's
"does not exist" is stale). Packet O14 (root has 2 `.md`) is wrong; packet O6 path `src/main/artifact-store.ts`
is wrong (real path `src/main/tools/artifact-store.ts`).

**Unblock path (4 steps):**
1. Create tracked `plans/BOTTLENECKS.md` ledger: `ID | claim | evidence path:line | re-verify command | status | verdict artifact`; statuses `OPEN|FIXED|REFUTED|STALE`; seed `REFUTED` rows from the scout's correction section so dead findings cannot resurrect; rules: no row without a runnable re-verify command, `REFUTED` rows are never deleted.
2. `package.json`: add `test:file` (compile-prefixed) and `test:canary` running the 7 `test/unit/*.test.mjs`; insert `test:canary` into the `test` chain. Risk: `test:canary` depends on `.canary/` surviving ⇒ do **not** execute any `.canary` cleanup before step 4.
3. `package.json`: drop `clean` from `compile`; add `rebuild = clean && compile`; point `test`/`package` at `rebuild`; the 14 `smoke:*` need no edit. **Explicitly argues AGAINST writing a prune script**: `scripts/copy-static.mjs` writes `.js` files with no `.ts` sibling into `.compiled/src/renderer/` (`exports-shim.js`, `standalone.js`, generated `terminal-write-dispatcher.js`), so an orphan rule would delete them and break the standalone renderer. Instead: glob-based gates always cold-build; the incremental path is name-addressed only.
4. Move `atomic-record.mjs`, `process-identity.mjs`, `campaign-lock`, `evidence-provenance`, `canary-floors`, `campaign-verdicts`, `build-report.mjs` from `.canary/tools/` to tracked `scripts/lib/`; repoint `run-electron.cjs:119-120` and the 7 `.test.mjs` importers; only then may `.canary` junk be deleted. Optional guard: scope `kill-all.mjs`.

---

## Candidate B

**Technique:** Simplification Cascades.
**Framing:** F3. F1 is refuted (findings converge across blind/unblind verifier runs and self-correct
in-session). F2 is right but **mis-located**: closure demonstrably works in this repo when work has a
same-day plan container with per-phase probes, while the 13-item bottleneck union has **no plan at all**
and is roadmap-shaped.

**Key evidence offered:** `plans/260909-1721-restore-visual-fidelity-canary/plan.md` completed 6/6 phases
with all success criteria checked = proof closure works when a container exists.
`.canary/15-pages/_verdicts.json` generated `2026-09-10T15:27:45Z` with `executiveVerdict INCONCLUSIVE`,
tally zero, 15/15 pages superseded ⇒ phase-01 provenance tooling is built, wired and has run.
`260910-2008` plan's 15 facts collapse (facts 1–4 + 14 are one blocker: the settle predicate).
The 13 items collapse to **one stem** (destructive non-incremental shared build, 6 addresses) plus two branches.

**Unblock path (4 steps):** (1) give the union a plan container; (2) make the build non-destructive and
incremental; (3) make the gate scoped and honest about its own coverage; (4) close retention + leaf items
with named probes. Explicitly defers/rejects the rest.

---

## Candidate C

**Technique:** Meta-Pattern Recognition.
**Framing:** F3 — the repo has **two registries that never meet**: a prose finding ledger (no status
field, no probe) and a plan ledger (frontmatter `status:`, phases). Open-ness can therefore only be
established by re-reading source.

**Key evidence offered:** the same union finding was re-derived **8 times in one round** (5 candidates +
blind packet + anonymized packet + verifier verdict), and the 5-candidate procedure has run **6 times in
9 days** (30 candidate files + 6 verifier verdicts + 15 evidence packets). A dead item still circulates:
background-tab throttling is listed as unfixed, but at HEAD `native-tab-host.ts:3489-3491` creates
offscreen views with `backgroundThrottling: false` and `:3702-3740` applies scoped unthrottling, and plan
`260901-1630/phase-02` is `status: complete`. `main.cjs:12` trusts a stale bundle (existsSync only).
"40 plan files, 8 distinct status spellings." "Root `.md` reports = 10 + README + canary note".

**Unblock path (5 steps):**
1. `plans/reports/audit-register.json` (tracked) + `scripts/audit-register.mjs`. Probe kinds limited to **4**, no free shell: `file-regex`, `file-absent-regex`, `package-script-regex`, `test`. `--close <id>` refuses unless the probe currently returns ABSENT; writes `closedBy {at, digest}` where digest = sha256 canonical of `{probe outputs, buildIdentity}`, reusing `scripts/freeze-certification-core.cjs`. Supports `wontfix` + one-line reason. Add `npm run audit`. Verify: `--id B1` → PRESENT; `--id A5` (the removed throttling item) → ABSENT; `--id B6` → PRESENT.
2. Cut tracked→gitignored: move `atomic-record.mjs` + `process-identity.mjs` to `scripts/lib/`, repoint `run-electron.cjs:119-120`, sweep remaining importers. Verify: grep empty; `git check-ignore` gives no output for the new paths.
3. Cut the dev-loop feedback unit: `tsconfig.json` `incremental: true` + `tsBuildInfoFile .compiled/.tsbuildinfo`; `package.json` drop `clean` from `compile`/`test`, add `rebuild`, `test:file`, `check:orphans`; `dev.mjs` gets its own watch buildinfo file; NEW `scripts/check-orphan-build.mjs` (orphan = `.compiled/**/*.js` with no sibling `.ts/.js/.mjs/.cjs`; claims verified no false positive against copy-static's emitted list); NEW `scripts/rebuild-guard.mjs` (reads `node_modules/.cache/antifan-dev.pid`; refuses `rebuild` while the dev watcher lives).
4. Close rows in root order (R1 then R2), one commit each: B1/B2/B3/B4 via step 3; retention via composing `enableRetentionCleaner` at the **production call site** (not by changing the class default) + lazy `rehydrateIndex()`; `main.cjs` mtime guard; provenance rows via the existing `260910-2008` plan phases; capability-registry parity last; A1 stays `open` with `blockedBy: decision`; C-class either `wontfix` + reason or `open` labelled consequence.
5. Make the register a mandatory input to every future audit round, so a closed finding cannot re-enter.

---

## Candidate D

**Technique:** Simplification Cascades (Meta-Pattern Recognition as supporting tool).
**Framing:** F3 — the audit pipeline ends in a prose verdict, not a state change.

**Key evidence offered:** artifact count grows monotonically while state changes zero — 31 candidate
files, 24 `ultra-*` files + 4 dirs with 21 more, 7 ultra cycles, **47 `plan.md`**, **316 `.md`** under
`plans/`, and **0 lines of code** changed for B1 since 2026-09-05 (`brainstorm-260905:33`) through
`ultra-260910-bottleneck-scout-final.md:76-78` to a blind verifier. Positive control: the repo **has**
closed work correctly when the artifact carried a *repair table + real command log*
(`plans/reports/test-suite-audit-report-2026-09-06.md` §3 + §5; also
`plans/260828-1400-measured-performance-optimization/reports/code-review-ultra-findings.md:24-28`).
The gap is exactly between the "report" layer (no lifecycle) and the "plan" layer (has lifecycle).
`test/main` = **128** `.test.ts` + 1 fixture, not 129. Packet O6's `artifact-store.ts` path is missing `tools/`.

**Unblock path (5 steps):**
1. NEW `scripts/prune-orphan-emit.mjs` — recursive over `.compiled/src|test|scripts`, **SKIP `.compiled/src/renderer/**`** (copy-static owns it), map `.js`→`.ts`/`.tsx` (and strip `.map`), delete when no source exists, always exit 0. Verify with a temp orphan file, and confirm `.compiled/src/renderer/standalone.js` survives.
2. `package.json`: `clean` also removes `*.tsbuildinfo`; `compile` drops `clean` and inserts the prune step; add `rebuild`; `test` drops `clean`. Note that the 14 `smoke:*` need no edit because the fix is at the `compile` layer. Verify with a live `npm run dev` plus a 50 ms `existsSync` poller asserting `.compiled/src/main/index.js` is never absent.
3. `tsconfig.json`: `incremental: true` + `tsBuildInfoFile ./tsconfig.tsbuildinfo`; **and** change `typecheck` to `tsc -p ./ --noEmit --tsBuildInfoFile ./tsconfig.typecheck.tsbuildinfo` so the noEmit path cannot leave a buildinfo that makes a later emit skip output. Cites microsoft/TypeScript#50646 for the non-pruning behaviour. Fallback if TS5053: a `tsconfig.typecheck.json` with `incremental: false`.
4. `package.json`: add `test:file`; add `.compiled/test/renderer/**` and `.compiled/src/**` globs to `test:fast` (recovers `test/renderer/terminal-gap-state-machine.test.ts` + 3 `src/main` tests). Explicitly does NOT try to gate the 6 `.cjs` e2e harnesses — records them as a manual gate in the ledger instead.
5. NEW `plans/audit-closure.jsonl` + `scripts/audit-ledger.mjs` (`list --open`; `check` exits 1 on unparseable rows, `status:"fixed"` with empty `proof`/`fix`, or an `evidence` path that does not exist) + wire `ledger -- check` into `verify`.

---

## Candidate E

**Technique:** Meta-Pattern Recognition (cascade used as resolution, not diagnosis).
**Framing:** F3 — **no closure predicate**: nothing in the repo evaluates a declaration against HEAD, so
declarations and facts are indistinguishable. F1 and F2 are both downstream symptoms.

**Key evidence offered:** six verified instances of *declared-without-activating-condition*:
(1) `.gitignore:7` ignores `*.tsbuildinfo` while `tsconfig.json` never enables `incremental`;
(2) `enableRetentionCleaner` declared at `artifact-store.ts:48`, guarded at `:71-73`, never passed `true`
by any caller (`control-plane-runtime.ts:61` populates only max bytes; `index.ts:235` passes the resolver
output through);
(3) `isHotSwappable` at `dev-watcher-helpers.mjs:43` matches `^scripts/cdp/([^/]+)\.source\.js$` but
`scripts/cdp/` contains **no files** — `dev.mjs:33-36` only creates the directory empty;
(4) the 7 `test/unit/*.test.mjs` canary tests are reachable by no npm glob and are never compiled
(no `allowJs`);
(5) a **tracked** file imports a **gitignored** tree — `scripts/run-electron.cjs:119-120`;
(6) plan frontmatter `status:` has 8 distinct spellings and nothing reads the field.
Strongest single artifact: `plans/260830-1617-runtime-resilience-and-semantic-hardening/plan.md:4`
`status: completed`, its phase-03 `status: completed`, its SC-3 checked `[x]` ("old `.artifact` files are
periodically swept under the 200 MB threshold at startup and when idle"), and `:64-65` declaring
`artifact-store.ts` modified — while at HEAD the cleaner is dead code. Claims root has **exactly 2** `.md`
files (explicitly calling the PRIOR "14 root .md" figure refuted), and that `.canary/15-pages/*` contains
no `_verdicts.json`.

**Unblock path (5 steps):**
1. NEW `plans/bottlenecks.json` + `scripts/check-bottlenecks.mjs`. Predicate kinds: `contains`, `absent`,
   `importsResolvable`, `orphanScan`, `manual` (must carry `lastVerifiedAt`/`lastVerifiedBy`). Exit 1 on
   **REOPENED** (row `closed` but predicate still true) and on **STALE** (a `manual` row older than the
   newest `plans/**/plan.md` mtime) — so a plan cannot be marked completed while a manual row naming it is
   stale. A row with no predicate makes the checker refuse to run. Verify: seed the retention row `closed`
   → must exit 1 `REOPENED`; flip to `open` → must exit 0.
2. `package.json` only: drop `clean` from `compile` and `test`; add `rebuild`; point `package` at `rebuild`.
   Claims every transitive caller then inherits the fix with no further edit. Risk mitigation: `rebuild` is
   the release path and the orphanScan predicate is the standing guard, landing in the same commit.
3. `tsconfig.json` `incremental: true` + `tsBuildInfoFile .compiled/.tsbuildinfo`; add `test:file`. Notes the
   ordering dependency: enabling incremental before step 2 would be inert because compile deletes the build info.
4. Move 7 modules out of gitignored `.canary/tools/` into tracked `scripts/canary-lib/`
   (`atomic-record`, `process-identity`, `campaign-lock`, `evidence-provenance`, `campaign-verdicts`,
   `canary-floors`, `build-report`), repoint `run-electron.cjs` and all 7 `.test.mjs` importers, add
   `test:canary` + `test:renderer`, and add `.compiled/src/**/*.test.js` to `test:unit`. Risk: the other
   ~38 `.canary/tools/*` scripts import each other, so sweep every reference in one isolated change.
   Verify by temporarily moving `.canary/tools/` aside and re-running `test:canary`.
5. Enable retention at the production composition site and make `rehydrateIndex()` lazy; resolve the
   dead hot-swap branch in the same commit. Optional step 6: give the pending `260910-2008` plan a
   ledger row with a verify predicate so it closes on an exit code rather than a checkbox.

---

## Divergences the verifier must adjudicate

- Root `.md` count: A says 12, E says 2, D does not state a number.
- `plans/` file counts: D says 47 plan.md / 316 .md; C says 40 plan files.
- `_verdicts.json`: B says it exists with content; E says the directory has no such file.
