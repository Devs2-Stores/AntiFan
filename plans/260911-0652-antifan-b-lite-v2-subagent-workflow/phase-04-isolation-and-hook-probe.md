---
title: "Phase 4: Isolation-at-Merge & Hook Probe"
status: done
---

# Phase 4: Isolation-at-Merge & Hook Probe

## Overview

This is the enforcement phase, and it inverts the loop's polarity: instead of detecting an out-of-scope edit after it lands, the loop prevents it from landing. A fixer attempt works in an isolated staged workspace; Main audits the result; only an audited subset is merged into the real workspace.

The isolation unit is a **staged workspace copy with a hash manifest**, not a git worktree. Measured reason: `dist/` is ignored with zero tracked files, so a worktree could never contain the primary target; `.canary/` is tracked despite its ignore rule (169 files), so a worktree would carry the wrong half and `git diff` there would say nothing about `dist/`. The manifest makes both audits transport-independent — if the target ever becomes tracked, the same run can move to a worktree without changing the audit.

Option A is **not** complete by having been chosen. It must satisfy the five acceptance gates in Success Criteria, each with a receipt.

## Requirements

- [ ] A staged workspace is materialized per attempt from the real workspace, with a base manifest (path → hash, size) minted at stage time. Staging copies the live working tree, **not** a revision: the instrument carries uncommitted changes today (fact 12), so a worktree at HEAD would not contain the retry — the second measured reason the staged copy is the right isolation unit. The stage receipt therefore records `HEAD` **and** each staged file's content hash, and the attempt's receipt names the instrument revision its verdict descends from.
- [ ] After the fixer returns, an audit computes the touched set from the manifest diff: `touchedPaths ⊆ allowedFiles` must hold, else the attempt is refused **before** any merge.
- [ ] A separate `diffBudget` audit (changed file count and change volume) and a separate `maxScopeExpansion` audit each refuse independently.
- [ ] The merge gate applies only the audited subset to the real workspace, re-verifies the base manifest first, and mints a receipt (attempt id, staged root, touched paths, budgets, decision).
- [ ] A drift between stage-time manifest and merge-time base refuses the merge instead of applying onto an unknown base.
- [ ] The fixer session's effective workspace root is pinned to the staged root, and the resolved root is recorded in the request and receipt; a staged write whose resolved path escapes the staged root refuses the attempt (evidence: `file.write` resolves against the effective workspace root, which otherwise points at the real workspace).
- [ ] Before applying, the merge gate stores the pre-merge content of every file it will overwrite inside the attempt's staging area, so Option B restore has real bytes to restore — a hash manifest is not restorable data.
- [ ] After applying, the merge gate re-hashes the written result and asserts equality with `base ⊕ staged diff`; a mismatch is a typed merge failure followed by path-scoped restore from the stored content, never a success receipt.
- [ ] Option B (fallback) is path-scoped restore: it restores only files the loop itself wrote, from the stored pre-merge content, named by the audit, and never touches git state. `git checkout -- .`, `git clean -fd`, `git reset --hard` are forbidden.
- [ ] Before any variant is interpreted, the probe records **load evidence**: the extension package is registered by an authority-verified path and its load is observable (load diagnostics in the active state root's `logs/`, plus a `session_start` side effect). A probe that blocks nothing must never be read as "hooks don't see child calls" when the package never loaded. Measured caveat from this workspace: a `-p` session does not persist its system prompt, so a session-file grep can never prove or disprove sibling discovery — use the loader-diagnostics channel.
- [ ] Probe runs are budget-aware and keep off the browser plane by construction, not by convention: measured on omp v18.1.17, `--no-tools` does **not** disable MCP tools, so a nested `-p` run still invoked `anti_browser_tabs_list` and minted live tabs (`d4fc0179-…`, `807c01fe-…`). Two later probes passed `--tools=read` and invoked no tab tool, but that flag is a built-in-tool selector and is not an established guard. The probe therefore runs with a `--config` overlay that drops the AntiFan MCP server (or with the proxy unreachable), and records the managed-tab census before and after each variant, ending anything it mints; a variant that genuinely needs a browser tab is classified as a separate, budgeted action.
- [ ] The hook probe runs 4 variants with recorded results: (a) restricted file scope + `blocking: true`; (b) restricted file scope, non-blocking; (c) default-tools control; (d) a forbidden-tool call (`anti.theme.style_override`) by the child, which must be refused.
- [ ] The probe's conclusion is written down: hook = second lever, or hook = documented no-op with the merge gate as sole machine enforcement.

## Implementation Steps

1. Implement stage: copy the target workspace subtree into `.canary/staging/<runId>/`, mint the manifest (sorted path list with hashes, plus stored content for every file the merge may overwrite), pin the fixer session's workspace root to the staged directory, and record the resolved source root + base revision.
2. Implement the audits as pure functions over (base manifest, post manifest, request): touched paths, budget usage, scope expansion, tool surface. Each returns a typed decision from the Phase 3 enum with the offending paths.
3. Implement the merge gate: refuse on drift or audit failure; otherwise store pre-merge content for each file to overwrite, apply only the touched subset, re-hash the result, and refuse unless it equals `base ⊕ staged diff`; then mint the receipt (attempt id, staged root, resolved target root, touched paths, budgets, post-merge verification, decision).
4. Build the probe harness for the 4 variants around a non-destructive sentinel write (a file under the staged root), so the probe never risks real workspace content.
5. Run the probe matrix with a child subagent, record for each variant whether the parent hook observed the call, whether the write was blocked, and whether the reason named the offending path; the forbidden-tool variant must additionally prove no runtime override reached the tab.
6. Wire the recorded verdict into `.omp/extensions/antifan-fix-guard/rules/loop-contract.md` (which lever is live) and, if the hook works, add `.omp/extensions/antifan-fix-guard/hooks/pre/` to the same loaded package with the same pure audit functions so the hook and the merge gate cannot disagree. A bare `.omp/hooks/pre/` is not a discovery source; the hook only exists as a sibling of the loaded package.
7. Test the negative path first: an attempt that touches `src/**` or `package.json` must be refused with those paths listed and zero workspace change.

## Evidence Anchors

- `.gitignore:4` (`dist/`, 0 tracked files), `:30` (`.canary/`, 169 tracked files despite the rule); `packages/site-clone/src/generators/theme-compiler.ts` (atomic swap into `outputDir`)
- `src/main/tools/file-capabilities.ts:68-71` (`file.write` write-class); `capability-catalogue.ts:261-267`
- `omp://skills/examples/safety-hook/README.md` (`tool_call` → `{ block: true, reason }`)
- `omp://docs/extension-loading.md` (native roots `<cwd>/.omp/extensions` and `~/.omp/agent/extensions`; legacy `settings.json#extensions`; project `.omp/config.yml` `extensions`); `omp://skills/authoring-extensions.md` (sibling `skills/`, `hooks/pre|post/`, `tools/`, `commands/`, `rules/`, `prompts/`, `.mcp.json` are discovered only from a loaded package)
- `plans/260910-2008-clone-campaign-evidence-provenance/phase-01-…` (attempt immutability, single-writer, fail-closed verification)

## Todo

- [x] Implement staged workspace + base manifest (`.canary/tools/fix-loop/stage-workspace.mjs`)
- [x] Implement touched-path audit (`⊆ allowedFiles`) (`audits.mjs:auditTouchedPaths`)
- [x] Implement `diffBudget` and `maxScopeExpansion` audits (`audits.mjs`)
- [x] Implement merge gate + receipt + drift refusal (`merge-gate.mjs`)
- [x] Implement path-scoped restore fallback (`restore.mjs`)
- [x] Prove the extension package loads at its authority-verified path (load evidence recorded: `.canary/hook-probe/load-evidence/session-start.json` + loader diagnostics `omp.2026-09-11.25508.log`)
- [x] Build and run the 4-variant hook probe matrix (`evidence/phase-04-hook-probe.md`)
- [x] Record the probe verdict and wire the live lever into the contract (`rules/loop-contract.md` §2.2 "SECOND LEVER")
- [x] Negative test: out-of-scope attempt refused with zero workspace change (proof 2 of `run-cli-proof.mjs`: `REFUSED_TOUCHED_PATH`, zero bytes changed)

## Success Criteria

- [ ] Chain gate 1: an attempt operates in an isolated staged workspace whose base manifest is recorded.
- [ ] Chain gate 2: a fixer edit is visible as a manifest diff, not as an in-place workspace mutation.
- [ ] Chain gate 3: an out-of-scope touched path refuses the attempt before merge, naming the paths.
- [ ] Chain gate 4: exceeding `diffBudget` or `maxScopeExpansion` refuses independently, naming the measured usage.
- [ ] Chain gate 5: only the audited subset reaches the real workspace, and the receipt records the decision.
- [ ] Drift between stage and merge refuses rather than applying.
- [ ] Chain gate 6: pre-merge content is stored for every overwritten file, and Option B restores exactly those files from it.
- [ ] Chain gate 7: the post-merge manifest equals `base ⊕ staged diff`; a mismatch refuses and restores instead of publishing a receipt. Measured decision semantics: the merge gate reports a post-merge re-hash mismatch under `REFUSED_DRIFT` with `restored: true` and `postMergeVerification: { verified: false, mismatches: [...] }`, and publishes **no success receipt** — a reader must not read the `REFUSED_DRIFT` code as a stage-time-only refusal. Proven by fault injection: `ANTIFAN_TEST_FAULT_INJECT_POST_MERGE` (test-only seam in `merge-gate.mjs`, inert when unset) produced `Exit code: 13`, `Verified: false`, `expected 7bb6508924… vs actual ee213df6dc…`, workspace restored to the original bytes, "No success receipt was published".
- [ ] A staged write resolving outside the staged root is refused with its typed code; tool-surface enforcement is split by what each lever can actually see. **Observed** enforcement — a tool actually called during the attempt — belongs to the session's capability **name filter** or the `tool_call` guard; the merge gate cannot supply it, because a runtime override or `theme.qa_repair.*` leaves no file effect to audit. **Declared** enforcement is the merge gate's static `auditToolSurface` over the `toolSurface` list the FixResult declares: refusing a declared non-permitted tool is valid defense in depth, but it is never evidence that a call was observed, and no report may present it as such.
- [ ] Probe matrix executed (4 variants) only after load evidence exists; conclusion recorded; enforcement claim matches the measured lever.
- [ ] The extension package's discoverability is verified against the authority **and** by measurement: the entry loads (`.omp/extensions/antifan-fix-guard/index.ts` natively, and/or explicitly named in `.omp/config.yml`'s `extensions` array), a `session_start` side effect is observed, and every sibling root the contract relies on is either observably loaded in a fresh session or replaced by the module/plan-dir carrier.
- [ ] No git destructive command executed; fallback restore touched only loop-written files.

## Risk & Rollback

Risk: staging doubles disk usage for the target subtree and can go stale mid-round. Mitigation: stage per attempt under `.canary/staging/<runId>/`, prune completed runs, and fail closed on base drift. Risk: the hook and merge gate implement divergent audit rules. Mitigation: share one audit module; the hook calls it, the merge gate calls it. Rollback: the staged root is untracked and additively named; deleting a run's staging directory reverts the mechanism, and the merge gate can be disabled while leaving the audit functions testable.
