# Ultra Code Review — Pending Diff (5-reviewer union)

Scope: unstaged working-tree diff (`.antifan/review-pending.diff`, 15 files,
+314/-261). Mode: `--pending --ultra` — Stage 1 spec-compliance single pass,
Stage 2 fanned to 5 independent reviewers, kongming verifier built the
evidence-validated deduplicated union.

```
ultra: union=15/28 single_candidate_only=10
```

## Verdict: CHANGES REQUESTED (2 major findings)

## Validated union

| # | Severity | File:line | Finding | Reported by |
|---|----------|-----------|---------|-------------|
| 1 | **major** | plans/260905-0012…/live-theme-proof.json:1-109 | Deleted PASSED freeze-certification artifact from working tree (still committed in HEAD — restorable; committing the deletion would erase it from the baseline). `theme-golden-live.test.ts:32` unlinkSync on launch leaves repo without proof after aborted runs. Restore via `git checkout HEAD --` before commit | R1,R2,R3,R4,R5 (all) |
| 2 | **major** | blueprint-extractor.ts:77-104,148-152 | Nested `<section>` children of inactive Framer variants bypass pruning (no `data-framer-name` on children) → mobile-variant content leaks into desktop blueprint | R1,R3,R5 |
| 3 | minor | blueprint-extractor.ts:135-146 | `visibility:hidden` matched without whitespace; `aria-hidden` compared case-sensitively (parseAttributes preserves value casing) | R1,R3,R4,R5 |
| 4 | minor | blueprint-extractor.ts:139-146 | `aria-hidden='true'` alone prunes visible decorative Framer sections (WCAG-hidden but rendered) — over-pruning risk | R2 only |
| 6 | minor | tab-devtools-host.ts:408-416 | `tab.mobileView.webContents` accessed unguarded — codebase treats `.webContents` on possibly-destroyed WebContentsView as throwable (project-window-shell.ts:879-885 wraps it in try/catch). Correct fix is try/catch, not `?.` (optional chaining does not catch getter throws). Zombie-tab consequence unproven [INFERENCE] | R4,R5 |
| 7 | minor | blueprint-extractor.test.ts:320-326 | Test 14 sets BOTH `display:none` AND `aria-hidden` — aria-hidden short-circuits first, style branch never exercised | R5 only |
| 9 | minor | mcp-dispatch-hub-probe.json churn | `mcp-dispatch-hub-probe.cjs:56` hardcodes output into milestone plan dir — regenerated telemetry overwrites Sept-17 certification hashes; revert before commit | R1 only |
| 10 | nit | tab-devtools-host.ts:409-415 | Cleanup broadcast reaches offscreen/agent tabs (idempotent but wasteful IPC); filter `tab.state.offscreen` | R2 only |
| 11 | nit | native-tab-host.ts:9024-9032 | Font Finder persists across tab switch (re-injects into target) vs GPU Lens teardown — asymmetric lifecycle policy; document or harmonize | R3 only |
| 12 | nit | tab-devtools-host.test.ts:233-245 | Test 1d asserts same boolean twice; reload non-reinjection actually covered by Issue-2c test — rename | R5 only |
| 13 | nit | split-view-fixes-regression.test.ts:270-277 | Test 2c stubs `stopFontFinder` on instance — prototype→devToolsHost delegation unexercised (covered elsewhere) | R5 only |
| 14 | nit | playwright-parity-kernel.test.ts:380,433,905 | `getAllTabs` mock returns empty iterator; desyncs from `getTabRecord`, masks missing `executeJavaScript` on mockWc1 in dispose path | R5 only |
| 15 | nit | tab-devtools-host.test.ts:246-249 | Double blank line between test 1d and test 2 | R1 only |

## Dropped (not validated)

- **R2-F1** "did-finish-load stops Font Finder globally breaks split view" —
  rejected: teardown on navigation is the *intended* parity fix with
  `stopLens()` (native-tab-host.ts:8364); re-injection on reload was the bug
  being fixed.
- **R1-F3** untracked junction `..AntiFan-base19fnode_modules` — out of
  `--pending` scope (not in diff). **But still real**: it can escape
  `.gitignore` on `git add -A`; remove with `rmdir` before staging.

## Verifier judgment calls

- Split-view parity: intended lifecycle alignment with GPU Lens, not defect.
- `aria-hidden` pruning: real but calibrated minor — typical Framer variants
  pair `aria-hidden` with `display:none`; sole-aria-hidden visible sections are
  an edge case.
- Historical report churn: hygiene issue (revert regenerated files), not
  product defect.

## What was NOT reviewed

Untracked `plans/reports/*` dirs, `plans/261006-1846-*` brainstorm artifacts,
`src/renderer/session-activity.js` line-ending churn (generated, benign per
project convention).
