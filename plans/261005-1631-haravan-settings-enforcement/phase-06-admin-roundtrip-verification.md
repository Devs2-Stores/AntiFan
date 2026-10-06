---
phase: 6
title: "Admin Roundtrip & Storefront Verification"
status: pending
priority: P2
effort: "4h"
dependencies: [5]
---

# Phase 6: Admin Roundtrip & Storefront Verification

## Goal
Execute full end-to-end verification against real workspace themes (`E:/Work/customizes/*`), verify acceptance criteria 1 through 8 from the accepted contract, certify multi-tenant `(org_id, theme_id)` isolation on `TestVyan` vs `Vyantechnology`, and establish the Admin Save -> Storefront live roundtrip check.

---

## Tasks & Steps

### Task 6.1 — Comprehensive Batch Scan Across All Custom Themes
- **Goal:** Execute `theme.settings_check` across all 39 theme workspaces in `E:/Work/customizes/*` (reconciled: 46 dirs on disk, 39 eligible — Vyantechnology added post-brainstorm, already referenced by Task 6.3), persist per-theme stdout/stderr and exit status, manually review all `HARAVAN_SETTINGS_UPLOAD_READ` and `HARAVAN_SETTINGS_DUPLICATE_NAME` findings, verify 0 false positives, and transition baselines from audit mode to blocking mode (`reviewed: true`) per AC #3.
- **Target files and symbols:**
  - Create: `scripts/batch-audit-themes.mjs` (batch runner writing `plans/reports/theme-batch-audit.json`).
  - Runner: `scripts/theme-checks.mjs`.
  1. Create `scripts/batch-audit-themes.mjs`:
     - Iterates over subdirectories of `E:/Work/customizes/` that contain `config/settings.html` or `.haravan-cli_local.json`; records every discovered eligible path in the manifest.
    - Executes `node scripts/theme-checks.mjs --theme <dir> --platform haravan --out plans/reports/theme-batch-audit/<name>.json` (reports stay inside the repo, never written into the 39 external workspace trees).
     - Captures exit status (`0` = clean, `3` = findings reported, `2` = fatal/unreadable crash — verified CLI semantics) plus `stdout`/`stderr` and finding counts.
    - Fails unless `eligibleWorkspaces.length === 39` (reconciled count; was 38 in brainstorm, +1 Vyantechnology) — unexpected extras or shortfalls hard-fail.
    - Exits non-zero if any theme exits `2`, count !== 39, or uncertified findings remain.
     - Supports `--approve <dir>` ONLY as a human-review gate: refuses unless a review artifact `plans/reports/theme-batch-audit/<name>-review.md` exists listing EVERY finding for that theme with an explicit human disposition (`true-positive` / `false-positive` + reason). On success writes `{ reviewed: true }` into `<dir>/.antifan/settings-baseline.json`.
     - Saves aggregated audit manifest to `plans/reports/theme-batch-audit.json`.
  2. Human review of the aggregated report (explicit reviewer action, NOT runner inference):
     - Verify that Giaohangnang's 10 duplicate names are confirmed as genuine duplicates (or radio buttons properly excluded per AC #4).
     - A human reviewer opens every `HARAVAN_SETTINGS_UPLOAD_READ` / `HARAVAN_SETTINGS_DUPLICATE_NAME` finding across all themes and writes each disposition into the per-theme `-review.md` artifact. 0 certified false positives required (AC #3).
  3. Sign off and flip `reviewed: true` via:
     `node scripts/batch-audit-themes.mjs --approve E:/Work/customizes/<name>`
- **Success criteria:** Batch audit discovers exactly 39 eligible workspaces (count mismatch fails), persists `plans/reports/theme-batch-audit.json` + per-theme reports under `plans/reports/theme-batch-audit/` with 0 fatal crashes, and `--approve` succeeds only where a complete human review artifact exists.
- **Verify:** Run batch audit command:
  `node scripts/batch-audit-themes.mjs`
  Pass condition: Exits 0 and prints `BATCH_AUDIT_PASS: 39/39 workspaces scanned, 0 crashes` — printed only when count === 39 and zero exit-2 crashes; findings remain valid non-zero data, not failures.
---

### Task 6.2 — Acceptance Verification on Reference Themes
- **Goal:** Prove exact expected failure patterns on `Phukienmaymoc`, `Seahorse2`, and `Levents`.
- **Target files and symbols:**
  - Target workspaces: `E:/Work/customizes/Phukienmaymoc`, `E:/Work/customizes/Seahorse2`, `E:/Work/customizes/Levents`.
- **Steps:**
  1. Phukienmaymoc: Run `theme-checks.mjs` and verify it reports exactly 13 `HARAVAN_SETTINGS_UPLOAD_READ` failures (at `snippets/footer.liquid:15`, `snippets/header.liquid:17-18`, `layout/theme.liquid:12`).
  2. Seahorse2: the LIVE theme already reads images via `asset_url` (patched). Encode the historical `settings['m1_file_' + i + '.jpg']` dynamic-read failure as a named fixture `theme-dynamic-upload-read` in `test/unit/theme-checks.test.mjs` simulating the pre-patch pattern; assert it is flagged while `asset_url` references pass.
  3. Levents: keys read in Liquid that exist ONLY in `settings_data.json` (no control in `settings.html`) are flagged as `SETTING_UNDECLARED` (from `checkSettingsBinding` — declared-set excludes `settings_data.json`). `HARAVAN_SETTING_UNRESOLVED` is the inverse check (read but absent from data) and must NOT be the expected rule here.
- **Verify:** Run verification on Phukienmaymoc:
  `node scripts/theme-checks.mjs --theme E:/Work/customizes/Phukienmaymoc --platform haravan`
  Pass condition: Exits 3 with 13 upload findings.

---

### Task 6.3 — Multi-Tenant Shop Isolation Proof
- **Goal:** Verify that `TestVyan` and `Vyantechnology` (which share identical `org_id` 200000878093) cannot cross-contaminate due to distinct `theme_id`s (1001510621 vs 1001509080).
- **Target files and symbols:**
  - Test: `test/main/theme-transaction-shop-isolation.test.ts`
- **Steps:**
  1. Create a test case setting up workspace `TestVyan` (`themeId: "1001510621"`).
  2. Attempt `theme.transaction.write_cas` targeting `config/settings_data.json` using a simulated tab for `Vyantechnology` (`themeId: "1001509080"`).
  3. Verify `write_cas` throws `CapabilityError('SHOP_IDENTITY_MISMATCH')`.
  4. Attempt direct native OMP `write` to `config/settings_data.json` without Direct-Edit mode.
  5. Verify `edit-guard` intercepts and blocks the call with `REFUSED_SETTINGS_DATA_DIRECT_WRITE`.
- **Success criteria:** Neither tool allows cross-shop writes between tenants sharing the same `org_id`.
- **Verify:** Run shop isolation test:
  `node --test --test-force-exit ".compiled/test/main/**/theme-transaction-shop-isolation.test.js"`
  Pass condition: Exits 0.

---

### Task 6.4 — Admin Save -> Storefront Live Roundtrip Certification
- **Goal:** Verify that modifying settings in the Haravan theme admin, saving, and reloading the storefront renders the exact new revision without desynchronization.
- **Target files and symbols:**
  - Capability: `theme.qa_validate`, `theme.transaction.write_cas`.
- **Steps:**
  1. Record storefront revision before mutation.
  2. Apply valid setting change via `write_cas` with matching shop tab.
  3. Trigger storefront reload via `browser.reload` or `anti.browser.tabs.navigate`.
  4. Observe DOM update on storefront.
  5. Verify `theme.qa_validate` outputs a clean receipt with monotonic baseline updated.
- **Success criteria:** Storefront DOM matches saved settings revision and receipt is valid.
- **Verify:** Run compile check and fast test suite:
  `npm run test:fast`
  Pass condition: Exits 0 and all tests pass.

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
