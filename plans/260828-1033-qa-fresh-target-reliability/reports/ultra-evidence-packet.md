# Evidence Packet — REV 4 (final, for ak:plan --ultra)

Plan: **AntiFan QA Fresh-Target Reliability** — fix `ThemeQaWorkflow.validate()` so a QA round evaluates the state produced by the latest edit/reload, plus conditional hardening and a release-confidence gate. Repo: `E:/Work/apps/antifan-browser-desktop`, HEAD `ae6b4358`. Extends plan `260827-2211-qa-gate-trust-and-self-qa` (DONE) — do NOT re-do what that plan already delivered (buffer clear on navigation, origin filter, shared filter module, annotation self-QA prompt).

## Verified facts (controller read source directly; candidates may re-verify)

1. **P0-1 (sole MUST) — stale target propagation after reload.**
   - `src/main/qa/theme-qa-workflow.ts` `validate()` (lines ~93-122): `const reload = await this.ports.reload(input.target);` — but then continues using **`input.target`** (OLD documentGeneration) for every subsequent call: `inspect()` DOM/screenshot (line ~119, actually BEFORE reload), `browser.eval` scanners (liquid/overflow/assets/HS), `listTabs`. **`reload.target` (with the fresh documentGeneration) is ignored.**
   - `BrowserControlPort.resolveTargetTab()` calls `assertCurrent()` → `host.isCurrentTarget(target)` → `native-tab-host.ts:4390-4392`: `target.documentGeneration !== currentGen` → returns false → `TARGET_STALE` thrown → every scanner's try/catch silently falls back to the PRE-reload `rawHtml`/defaults. Net effect: live scanners evaluate stale-or-fallback data; the QA verdict does not reflect the latest edit.
   - Two reload wirings, both without load-stability: `control-plane-runtime.ts:99` `reload: (target) => browser.reload(target)`; production wiring `index.ts:182` `reload: (tabId) => tabHost!.reloadAndWait(tabId)`. `reloadAndWait` uses `createNavigationStartWaiter` which resolves at **`did-start-navigation`**, NOT `did-finish-load` (`native-tab-host.ts:2502-2563`; 3s timeout). At `did-start-navigation` (`native-tab-host.ts:1724-1745`) generation bumps + diagnostics buffer clears synchronously; `did-finish-load` does NOT clear (parse errors kept for QA). ⇒ Diagnostics read AFTER reload + load-stable wait are the FRESH generation; reading with stale target yields nothing or old data.
   - Required fix: propagate `reload.target` (fresh generation) into all post-reload calls (dom/screenshot/eval/listTabs) AND wait for load completion/generation stability (with timeout → `TARGET_STALE` or explicit warning, NO silent catch-fallback to old rawHtml). Optionally reorder `inspect()` after reload. Full fresh-capture with generation assert is Final-grade; minimal is target propagation + stability wait.
   - Test gap: `test/integration/theme-qa-vertical-slice.test.ts` uses a MOCK host (static getDom, sync reload returns true) — cannot catch this. Need a regression test on the real reload lifecycle (generation bump + fresh DOM/diagnostics).

2. **P1-4 — conditional hardening, NOT MUST.** `theme-qa-workflow.ts` ~277-283/308-330: `validate()` accepts `checklist?: Partial<ThemeQaChecklist>` and applies caller overrides after computing statuses; `summary.passed = every(Boolean)`. BUT no current caller passes it: public `theme.qa_validate` schema (`browser-capabilities.ts:166-176`) takes only `{tabId, workspaceRoot, multiBreakpoint}`; `ControlPlaneRuntime.validateThemeQa` (`control-plane-runtime.ts:102-110`) passes no checklist. ⇒ Latent integrity hole in an internal API. Fix is cheap (`enabledChecks` input, engine owns verdict) — promote to issuer-level only when a caller appears or during this plan's refactor while touching the file; otherwise record as hardening with trigger.

3. **Full-chain Test A + CI — release-confidence gate, NOT blocker unless user defines Final=requires-CI.** Tests B (heartbeat), C (stale-reject), D (shutdown/revoke) already exist and pass (controller ran 14/14: `cli-agent-launcher.test.js`, `bridge-attachment-dispatch.test.js`, `omp-mcp-adapter.test.js`). No CI config exists (no `.github/`, `.gitlab-ci.yml`, `azure-pipelines.yml`). Gap: one end-to-end CLI→MCP→Browser→QA test wired into `npm test`; CI hosting needs a user decision. Put in Deferred with explicit promotion trigger (`Final` acceptance list requires CI) unless the user confirms otherwise.

4. **P1-3 (openTab retarget) — defer.** `browser-control-port.ts:85-92` openTab sets automation tab; `bridge-attachment-dispatch.test.js` asserts `antifan_open_tab` retargets — alias contract depends on it. Requires migration; not Final-blocking.

5. **P1-6 (terminal capsule) — policy, not code.** `terminal-manager.ts:239-248` deliberate migration ("tabs never disappear"). Drop from action list.

6. **P1-5 (2-round QA loop) — no engine change.** Stateless single-shot validator; round cap belongs in capability/prompt layer.

7. **Unanchored surfaces (audit, not code):** `scripts/antifan-omp-mcp.cjs` (stdio proxy, 16 tools), `antifan_eval_js` (risk:eval), `ANTIFAN_DSH_SPIKE` spike, `packages/plugin-sdk`, `plugins/overflow-audit`, packaged artifact (~100s MB) committed under `plans/260827-1345-.../reports/artifacts/`.

## Scope boundary for candidates
- MUST: P0-1 target propagation + load-stable wait + regression test on real lifecycle.
- Conditional: P1-4 `enabledChecks` (only if touched while refactoring `validate()` — keep internal; do not change public schema).
- Deferred (listed with triggers): full-chain Test A in `npm test`; CI; P1-3 alias migration; surface audit; artifact hygiene.
- Dropped: P1-6 (policy), P1-5 (no engine change).
- Do NOT re-implement plan `260827-2211` deliverables (buffer/origin filter already done).

## Rubric (verifier, 1-20 per criterion)
1. Faithfulness — plan targets the stale-target bug, not a rewrite.
2. Evidence grounding — file/line anchors for every change.
3. Phase sharpness — phases ≤ properly: file inventory, implement steps, success criteria, risk+signal.
4. Honesty — labeled assumptions; no claim on unread APIs; P1-4 scoped as conditional.