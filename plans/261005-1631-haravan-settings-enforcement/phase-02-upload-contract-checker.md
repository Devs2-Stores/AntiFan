---
phase: 2
title: "Upload Contract & Theme Settings Check"
status: pending
priority: P1
effort: "4h"
dependencies: [1]
---

# Phase 2: Upload Contract & Theme Settings Check

## Goal
Implement the strict upload control read contract (`HARAVAN_SETTINGS_UPLOAD_READ`), prune `settings_data.json` values from `knownSettings` so orphan values trigger `HARAVAN_SETTING_UNRESOLVED`, detect duplicate control names in `settings.html`, update tests and fixtures, and expose the checker via tabless capability `theme.settings_check`.

---

## Tasks & Steps

### Task 2.1 — Implement `HARAVAN_SETTINGS_UPLOAD_READ` Rule
- **Goal:** Forbid reading upload controls via `settings['X']` or `settings.X`; require `'X' | asset_url`.
- **Target files and symbols:**
  - Modify: `scripts/lib/theme-checks.mjs` (`checkHaravanLiquidContracts`).
- **Steps:**
  1. Parse `config/settings.html` to find all `<input\b[^>]*\btype\s*=\s*(['"])file\1[^>]*>` elements and extract their `name` attribute into a Set `fileInputNames`.
  2. In the Liquid source line scanner (`checkHaravanLiquidContracts`):
     - Scan for `settings['X']` and `settings.X`.
     - If `fileInputNames.has(X)`:
       Emit failure:
       `{ rule: 'HARAVAN_SETTINGS_UPLOAD_READ', id: X, file: relativePath, line: lineNum, message: `Upload setting '${X}' must be referenced via '${X}' | asset_url, not settings['${X}']`, detail: `An <input type="file"> uploads an asset to assets/. Reading it via settings object fails or breaks asset resolution.` }`.
     - Scan for dynamic bracket reads preceded by a capture block whose template string ends in an image extension (e.g. `{% capture m_file %}...-img-{{ m }}.jpg{% endcapture %} ... settings[m_file]`):
       Emit failure with rule `HARAVAN_SETTINGS_UPLOAD_READ` and `id: capturedPattern`.
- **Success criteria:** Running `theme-checks.mjs` on `Phukienmaymoc` flags 13 upload reads; on the LIVE `Seahorse2` (already patched to `asset_url`) flags 0 upload reads — the historical dynamic pattern is proven via named fixture `theme-dynamic-upload-read` in `test/unit/theme-checks.test.mjs` (Phase 6 Task 6.2); clean `asset_url` references produce zero findings.
- **Verify:** Run theme check on Phukienmaymoc:
  `node scripts/theme-checks.mjs --theme E:/Work/customizes/Phukienmaymoc --platform haravan`
  Pass condition: Exits 3 and output contains `HARAVAN_SETTINGS_UPLOAD_READ`.

---

### Task 2.2 — Prune `settings_data.json` from `knownSettings`
- **Goal:** Ensure settings values in `settings_data.json` that lack an active control declaration in `settings.html` or `settings_schema.json` are reported as `HARAVAN_SETTING_UNRESOLVED`.
- **Target files and symbols:**
  - Modify: `scripts/lib/theme-checks.mjs:456-473` (`checkHaravanLiquidContracts`).
- **Steps:**
  1. Remove lines 457-469 in `scripts/lib/theme-checks.mjs` where keys from `settings_data.json` are added to `knownSettings`.
  2. Populate `knownSettings` exclusively from `collectDeclaredSettingIds(themeDir)`.
  3. Ensure that when Liquid reads `settings.foo`, if `foo` exists in `settings_data.json` but has no `<input name="foo">` in `settings.html` and no entry in `settings_schema.json`, it is flagged with `HARAVAN_SETTING_UNRESOLVED` (`id: 'foo'`).
- **Success criteria:** On `E:/Work/customizes/Levents`, settings without controls are surfaced as unresolved findings.
- **Verify:** Run check on Levents:
  `node scripts/theme-checks.mjs --theme E:/Work/customizes/Levents --platform haravan`
  Pass condition: Exits 3 and output includes `HARAVAN_SETTING_UNRESOLVED`.

---

### Task 2.3 — Implement Duplicate Control Name Detection in `settings.html`
- **Goal:** Refuse duplicate control names in `config/settings.html`, excluding legitimate `<input type="radio">` button groups.
- **Target files and symbols:**
  - Modify: `scripts/lib/theme-checks.mjs` (`checkHaravanLiquidContracts`).
- **Steps:**
  1. Parse `config/settings.html` for all `<input>`, `<select>`, `<textarea>` tags.
  2. Collect their `name` and `type` attributes.
  3. Track occurrences in a Map: `name -> Array<{ type, line }>`.
  4. For any `name` with count > 1:
     - If all occurrences have `type === 'radio'`, this is a valid radio group: DO NOT emit failure.
     - Otherwise, emit failure:
       `{ rule: 'HARAVAN_SETTINGS_DUPLICATE_NAME', id: name, file: 'config/settings.html', line: occurrences[1].line, message: `Duplicate setting control name '${name}' in config/settings.html`, detail: `Found ${occurrences.length} controls sharing name '${name}'. Every non-radio control must have a unique name.` }`.
- **Success criteria:** Giaohangnang duplicate names are caught if they are not radio buttons; single-control files pass cleanly.
- **Verify:** Run unit test for duplicate controls:
  `node --test --test-force-exit test/unit/theme-checks.test.mjs`
  Pass condition: Exits 0 and all tests pass.

---

### Task 2.4 — Update Test Fixtures and Unit Test Assertions
- **Goal:** Align `test/unit/theme-checks.test.mjs` with the new upload contract and verify new rules pass and fail on designated fixtures.
- **Target files and symbols:**
  - Modify: `test/unit/theme-checks.test.mjs`
  - Modify: `test/fixtures/theme-checks/theme-haravan-upload/snippets/hero.liquid`
  - Modify: `test/fixtures/theme-checks/theme-haravan-upload/config/settings.html`
- **Steps:**
  1. In `test/fixtures/theme-checks/theme-haravan-upload/snippets/hero.liquid`, change `settings['header_logo.png']` to `'header_logo.png' | asset_url`.
  2. In `test/unit/theme-checks.test.mjs`:
     - Delete or update lines 14-18 and assertions expecting `settings['logo.png']` to PASS.
     - Add new test: `HARAVAN_SETTINGS_UPLOAD_READ refuses settings['logo.png'] when logo.png is a file input`.
     - Add new test: `HARAVAN_SETTINGS_DUPLICATE_NAME ignores radio groups but flags duplicate text inputs`.
     - Add new test: `HARAVAN_SETTING_UNRESOLVED flags keys present in settings_data.json but missing from settings.html`.
- **Success criteria:** Unit test suite runs with 0 failures and confirms all three new rules.
- **Verify:** Run test command:
  `node --test --test-force-exit test/unit/theme-checks.test.mjs`
  Pass condition: Exits 0 with all test cases passing.

---

### Task 2.5 — Expose `theme.settings_check` MCP Capability
- **Goal:** Expose the file-scan settings checker as a first-class MCP tool requiring no browser target (`requiresBrowserTarget: false`).
- **Target files and symbols:**
  - Modify: `src/main/tools/theme-transaction-capabilities.ts` or `src/main/tools/cockpit-capabilities.ts` (`theme.settings_check`).
- **Steps:**
  1. Define tool schema for `theme.settings_check`:
     - Input: `{ workspaceRoot?: string }`.
     - Policy: `requiresBrowserTarget: false`, `risk: 'read'`, `lane: 'unbounded'`.
  2. Handler execution:
     - Resolve canonical workspace root via `resolveRoot(context)`.
     - Execute `checkHaravanLiquidContracts(root, { platform: 'haravan' })`.
     - Execute `checkSettingsBinding(root)`.
     - Execute `checkAssetReferences(root)`.
     - Return `{ ok, failures, totalFailures, refusals, settingsBinding, assets }`.
- **Success criteria:** Calling `theme.settings_check` via MCP returns full structured findings without error even when browser is offline.
- **Verify:** Run compile and test:
  `npm run compile && node --test --test-force-exit ".compiled/test/main/**/theme-mcp-capabilities.test.js"`
  Pass condition: Exits 0.

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
