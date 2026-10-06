---
phase: 4
title: "Settings Ratchet & Gate Hook Enforcement"
status: pending
priority: P1
effort: "4h"
dependencies: [2, 3]
---

# Phase 4: Settings Ratchet & Gate Hook Enforcement

## Goal
Implement the persisted monotonic baseline ratchet (`<ws>/.antifan/settings-baseline.json`), compute multiset finding diffs on `(rule, id, file)` ignoring line shifts, integrate findings into `theme.qa_validate` receipts, and enforce via `theme-qa-gate.ts` so that new findings result in `verdict: 'QA_FAILED'` and maintain an armed pending gate status with context reminders, while legacy findings remain non-blocking debt. In Direct-Edit and Super-Fast modes, emit a concise 1-line count at `turn_end` without gate reminders.
---

## Tasks & Steps

### Task 4.1 — Implement Settings Baseline Ratchet Module
- **Goal:** Manage persistent baseline finding counts and calculate multiset deltas between baseline and working tree findings.
- **Target files and symbols:**
  - Create: `src/main/qa/settings-ratchet.ts` (`export interface SettingsFinding`, `export interface BaselineFile`, `export function loadOrBootstrapBaseline(...)`, `export function evaluateSettingsRatchet(...)`)
- **Steps:**
  1. Define finding key:
     `function findingKey(f: SettingsFinding): string { return `${f.rule}::${f.id ?? ''}::${f.file}`; }`
  2. Implement `loadOrBootstrapBaseline(workspaceRoot, currentFindings, options = {})`:
     - Target path: `path.join(workspaceRoot, '.antifan', 'settings-baseline.json')`.
    - Schema: `{ reviewed: boolean, bootstrappedAt: string, counts: Record<string, number>, totalFindings: number }`.
    - Review Gate (AC #3 Protection): On first bootstrap, set `reviewed: false`. A baseline marked `reviewed: false` runs in AUDIT mode (findings recorded in receipts with warning, but not setting `verdict: 'QA_FAILED'`).
    - `reviewed: true` is activated ONLY via `node scripts/batch-audit-themes.mjs --approve <dir>`, which refuses unless a complete human review artifact (`plans/reports/theme-batch-audit/<name>-review.md`) dispositions every finding (Phase 6). No flag-only promotion exists.
  3. Implement `evaluateSettingsRatchet(baseline, currentFindings)`:
     - Count current working findings: `workingMap: key -> count`.
     - Compare with baseline:
       * `diff = (workingMap.get(key) || 0) - (baseline.counts[key] || 0)`
       * If `diff > 0`: add to `newFailures` with count = `diff`.
       * If `diff <= 0` and `workingMap.get(key) > 0`: add to `legacyDebt` with count = `workingMap.get(key)`.
     - Blocking flag: `blocking = Boolean(baseline.reviewed && newFailures.length > 0)`.
     - Return `{ ok: !blocking, newFailures, legacyDebt, baselineUpdated, auditOnly: !baseline.reviewed }`.
  4. Monotonic ratchet down: if any `diff < 0` (debt fixed), write updated lower count to `settings-baseline.json`. Never ratchet up automatically.
- **Success criteria:** First run bootstraps an audit-mode baseline (`reviewed: false`). It reports finding counts without failing QA receipts until human review certifies zero false positives per AC #3.
- **Verify:** Run compile check:
  `npm run compile`
  Pass condition: Exits 0.

---

### Task 4.2 — Integrate Ratchet into `theme.qa_validate` Receipt Generation
- **Goal:** Ensure `theme.qa_validate` runs the settings check and fails the receipt verdict if new settings findings are introduced.
- **Target files and symbols:**
  - Modify: `src/main/tools/browser-capabilities.ts:1630-1730` (`theme.qa_validate` handler).
- **Steps:**
  1. In `theme.qa_validate` execution:
     - If `canonicalWorkspaceRoot` is a Haravan theme workspace:
       * Execute `checkHaravanLiquidContracts(canonicalWorkspaceRoot, { platform: 'haravan' })`.
       * Execute `checkSettingsBinding(canonicalWorkspaceRoot)`.
       * Flatten failures into `SettingsFinding[]`.
       * Evaluate ratchet: `ratchetResult = evaluateSettingsRatchet(baseline, findings)`.
       * Attach to receipt payload: `settingsRatchet: { ok: ratchetResult.ok, newFailures: ratchetResult.newFailures.length, legacyDebt: ratchetResult.legacyDebt.length, findings: ratchetResult.newFailures }`.
  2. Verdict decision logic:
     - If `ratchetResult.ok === false`:
       Set receipt `verdict = 'QA_FAILED'`.
       Set `errorReason = `Settings contract regression: ${ratchetResult.newFailures.length} new finding(s) introduced.``.
  3. Write receipt JSON to `<workspaceRoot>/.antifan/qa-receipts/*.json`.
- **Success criteria:** Calling `theme.qa_validate` on a workspace with newly added invalid upload reads produces a receipt with `verdict: 'QA_FAILED'`.
- **Verify:** Run theme MCP capability tests:
  `node --test --test-force-exit ".compiled/test/main/**/theme-mcp-capabilities.test.js"`
  Pass condition: Exits 0.

---

### Task 4.3 — Update Gate Hook Enforcement in `theme-qa-gate.ts`
- **Goal:** Maintain armed pending gate status and emit reminders when a receipt carries `verdict: 'QA_FAILED'` from settings regressions, without claiming a runtime tool call veto.
- **Target files and symbols:**
  - Modify: `src/omp-hooks/theme-qa-gate.ts` (`reconcileReceipts`, `reminderText`, `pi.on('turn_end')`).
- **Steps:**
  1. In `reconcileReceipts(root)`:
     - Read latest receipt.
     - If latest receipt exists and has `verdict === 'QA_FAILED'` and carries `settingsRatchet`:
       DO NOT clear `pendingEdits.delete(root)`. Keep gate armed.
       Store latest settings findings in a cache for reminder formatting.
  2. In `reminderText()`:
     - If gate is pending due to settings regression, format findings:
       `[theme-qa-gate] QA GATE PENDING — Settings regression detected: ${f.rule} at ${f.file}:${f.line} (${f.id}). Fix: replace with '${f.id}' | asset_url.`
  3. In `pi.on('turn_end')`:
     - If session is in `direct` or `fast` mode (`SCOPED_MODES`):
       Do not block; read latest ratchet stats if dirty and print 1 single line:
       `[theme-qa-gate:scoped] Settings check: ${newCount} new finding(s), ${debtCount} legacy debt items. (Direct-Edit non-blocking)`
- **Success criteria:** An invalid settings edit prevents `reconcileReceipts` from clearing pending status. Direct-Edit sessions print a one-line count at turn end.
- **Verify:** Run theme QA gate hook tests:
  `node --test --test-force-exit test/unit/theme-qa-gate-hook.test.mjs`
  Pass condition: Exits 0.

---

### Task 4.4 — Comprehensive Ratchet Unit Tests
- **Goal:** Verify that line number shifts do not trigger failures, that multiset count additions trigger failures, and that baseline bootstrapping is idempotent.
- **Target files and symbols:**
  - Modify: `test/unit/theme-qa-gate-hook.test.mjs`
- **Steps:**
  1. Create test: `settings ratchet bootstrap creates baseline file with correct multiset counts`.
  2. Create test: `settings ratchet ignores line movement when read count remains identical`.
  3. Create test: `settings ratchet fails when a second duplicate bad read is added to an existing file`.
  4. Create test: `settings ratchet updates baseline downwards when legacy bad read is deleted`.
- **Success criteria:** All ratchet behavior is proven with isolated temp directories and zero false positives.
- **Verify:** Run test command:
  `node --test --test-force-exit test/unit/theme-qa-gate-hook.test.mjs`
  Pass condition: Exits 0 and all assertions pass.

---

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.
