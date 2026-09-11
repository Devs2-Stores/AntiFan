---
title: "Phase 3: B-Lite Contract Files & FixRequest v2"
status: done
---

# Phase 3: B-Lite Contract Files & FixRequest v2

## Overview

The Round 3.1 contract is closed as a decision; this phase turns it into files an executing session actually loads. Nothing here is enforcement — this phase defines the vocabulary (`allowedFiles`, `diffBudget`, `maxScopeExpansion`, typed outcomes) that Phase 4 enforces and Phase 5 exercises.

The stale HTML/CSS snapshot is dropped: the fixer reads the **actual** workspace, and the contract no longer carries a frozen DOM/CSS artifact as its input.

## Requirements

- [ ] The contract ships as one loadable extension package, because sibling capability dirs (`rules/`, `prompts/`, `skills/`, `hooks/`) are discovered only from a loaded package: `.omp/extensions/antifan-fix-guard/index.ts` (entry), and siblings `rules/loop-contract.md`, `prompts/builder-fixer.md`, `skills/antifan-theme/SKILL.md`. A bare `.omp/RULES.md`, `.omp/skills/…` or `.omp/agents/…` is not a discovery source.
- [ ] `rules/loop-contract.md` states the loop contract: enforcement precedence (merge gate primary, hook secondary), forbidden moves (repo-wide rollback, tolerance loosening, self-verification), typed outcomes, and the evidence-ownership split.
- [ ] `prompts/builder-fixer.md` defines the single exception worker: it reads the staged actual workspace, edits only `allowedFiles`, never self-verifies, and returns a typed result. Main supplies this brief in the worker's prompt; no custom agent *type* registration is load-bearing.
- [ ] `skills/antifan-theme/SKILL.md` carries the domain procedure for theme surfaces: where files live (`layout/`, `templates/`, `sections/`, `snippets/`, `assets/`, `config/`, `locales/`), which evidence calls to make, how to report a refusal.
- [ ] Load evidence covers the sibling roots the contract relies on. Measured on omp v18.1.17: `<cwd>/.omp/extensions/<dir>/index.ts` loads natively, a package named in `.omp/config.yml` `extensions:` loads, and its sibling `skills/` root **is** discovered — a marker skill appeared in a fresh session's skill catalogue (control: 12 `haravan*` skills listed). An earlier probe reported none; that was model under-reporting, so a negative probe result must be re-checked against a positive control before it is believed. Sibling `rules/` and `prompts/` are still unverified, and they load by different mechanisms (context injection, not an enumerable skill list), so they need their own per-root evidence; `hooks/pre/` is Phase 4's probe with its own pass/fail criteria. The channel matters: **model enumeration of the skill catalogue in a `-p` session is what worked — session-file grep cannot decide it, because `-p` sessions do not persist the system prompt.** Record each root as a probe result, and keep the module/plan-dir carrier wherever a root is still unmeasured.
- [ ] The fixer's forbidden surface is named as data, not prose: `anti.theme.style_override`, `anti.agent.cursor.*`, `browser.dump_dom`, `theme.qa_repair.begin/verify`, `browser.agent-sequence`, and every `risk:'eval'` tool. The allowlist is `file.read` + `file.write`. Because `isVisible` filters by risk class only and the proxy hardcodes `grant: 'eval'`, this list requires the **name filter specified in plan.md KDD 5** to exist — the contract names the primitive, it does not assume one.
- [ ] FixRequest v2 is machine-readable and carries: run/fix ids, surface id, staged workspace root, base manifest hash, `allowedFiles[]`, `forbiddenPaths[]`, `diffBudget`, `maxScopeExpansion` (separate), evidence refs, verdict cause code, and the required return shape.
- [ ] `maxScopeExpansion` and `diffBudget` are distinct fields with distinct formulas: `diffBudget` bounds `|T|` and changed bytes; `maxScopeExpansion` bounds `|T \ R|` where `R` is the requested target set. Neither can be widened by the fixer; each refuses independently.
- [ ] FixResult v2 carries a typed audit decision set — `OK | REFUSED_TOUCHED_PATH | REFUSED_DIFF_BUDGET | REFUSED_SCOPE_EXPANSION | REFUSED_DRIFT | REFUSED_TOOL_SURFACE` — and Phase 6's lifecycle states (`STALEMATE`, `SCOPE_DISCOVERY`) wrap these rather than redefining them.
- [ ] The contract enumerates the fixer's permitted tool surface (`file.read`, `file.write` against the staged root) and the forbidden set (`anti.browser.evaluate`, `anti.theme.style_override`, `anti.agent.cursor.*`, any other write/eval-class capability).
- [ ] The contract states that no HTML/CSS snapshot is carried; the fixer's input is the live staged workspace, whose root is pinned in the request.

## Implementation Steps

1. Scaffold `.omp/extensions/antifan-fix-guard/` with `index.ts` and register the package in `.omp/config.yml` (`extensions: ["./.omp/extensions/antifan-fix-guard"]`); verify the load is observable before authoring content that depends on it.
2. Author `rules/loop-contract.md` from the closed contract, with the enforcement order and the forbidden-move list verbatim in intent.
3. Author `prompts/builder-fixer.md` with the read/refuse/return procedure and an explicit "never verify" clause.
4. Author `skills/antifan-theme/SKILL.md` against the measured theme layout (7 compiler output directories) and the AntiFan evidence surface.
5. Define FixRequest v2 and FixResult v2 as a JSON schema, plus a worked example request/result pair using a real surface and real `allowedFiles` patterns.
6. Validate the schema against the worked example and against one deliberately invalid request per refusal class (out-of-scope path, `diffBudget` exceeded, `maxScopeExpansion` exceeded, drift, forbidden tool surface, self-verification claim); each invalid example must fail with its expected typed code, executable as a check.
7. Record in the phase report which file each artifact lives in, and the exact read order a session follows to start a round.

## Evidence Anchors

- `packages/site-clone/src/generators/theme-compiler.ts` (atomic 7-directory swap)
- `scripts/compile-haravan-theme.mjs:16` (`dist/haravan-theme`)
- `.gitignore:4`, `:30` (`dist/`, `.canary/` untracked)
- `src/main/tools/file-capabilities.ts:26-30`, `:68-71` (`file.read` read-class, `file.write` write-class)
- `src/main/tools/capability-catalogue.ts:261-267` (write/eval gating)
- `omp://skills/examples/safety-hook/README.md` (hook contract shape, for Phase 4 cross-reference)

## Todo

- [x] Scaffold `.omp/extensions/antifan-fix-guard/` + register in `.omp/config.yml`
- [x] Write `rules/loop-contract.md`
- [x] Write `prompts/builder-fixer.md`
- [x] Write `skills/antifan-theme/SKILL.md`
- [x] Encode the forbidden write-class surface as data
- [x] Define FixRequest v2 / FixResult v2 schema
- [x] Add worked example + invalid-request examples
- [x] Validate schema and record artifact locations

## Success Criteria

- [ ] The schema validates the worked example and rejects each invalid example with its expected typed code, runnable as a check rather than read as prose.
- [ ] `allowedFiles`, `diffBudget`, and `maxScopeExpansion` are machine-readable, separate, and formula-linked to the audit in Phase 4.
- [ ] The fixer tool surface is enumerated in the contract and asserted by the same check (a forbidden-tool example fails with `REFUSED_TOOL_SURFACE`).
- [ ] No snapshot artifact is part of the contract.

## Measured Verification (2026-09-11)

Landed as one commit, `d814cf1`, with 25 files: `.omp/config.yml` registering the package, the
extension itself, six invalid examples and the worked pair, and the fix-loop harness under
`.canary/tools/fix-loop/` (staged with `git add -f` - `.canary/` is ignored by `.gitignore:31`, so a
plain `git add` cannot carry it).

| Check | Command | Result |
|---|---|---|
| Contract validator | `node .omp/extensions/antifan-fix-guard/tools/validate-contract.mjs` | **8/8 cases, exit 0** - schema invariant (no HTML/CSS snapshot), the worked pair audits `OK`, and one invalid example per refusal class returns its own code |
| Validator negative control | drop the offence from `refused-touched-path.json` | `[FAIL] refused-touched-path`, 7/8, exit 1 - the validator can fail |
| Fix-loop self-tests | `node .canary/tools/fix-loop/test-fix-loop.mjs` | **15/15** - stage, in-scope merge with receipt, `REFUSED_TOUCHED_PATH` with zero bytes changed, diff-budget and scope-expansion refusals, drift detection, path-scoped restore without git, CLI exit-code map, declared-surface parsing |

Two decisions taken while validating, both recorded in the files:

- **One executable source for the tool-surface policy.** `audits.mjs` holds `DEFAULT_PERMITTED_TOOLS` /
  `DEFAULT_FORBIDDEN_TOOLS`; the hook, the merge gate, the contract validator, the launcher and the MCP
  proxy all read it. `schemas/tool-surface.json` now describes the shape and names that source instead
  of carrying a second list, and its description no longer claims to feed a Phase 2 filter that never
  read it. The forbidden list gained `theme.qa_repair.*` and `risk:eval` when the copies were merged, so
  the union is wider than the narrowest previous copy.
- **A malformed declaration refuses instead of passing.** `auditToolSurface` accepted a non-array by
  falling back to `[]`, which made an unparseable declaration indistinguishable from a clean no-op; it
  now refuses a malformed shape while keeping "absent declaration" a documented no-op, and accepts the
  `{ usedTools: [...] }` form the FixResult v2 schema allows.


## Risk & Rollback

Risk: the contract over-specifies and becomes a second, competing rule set beside the root agent contract. Mitigation: `rules/loop-contract.md` is scoped to the loop and inherits the root contract; it adds constraints, never relaxes them. Rollback: these are new files inside `.omp/extensions/antifan-fix-guard/` plus a schema and one `.omp/config.yml` entry; deleting them restores the previous state with no code impact (Phase 4/5 artefacts depend on them, so rollback is only safe before those phases run).
