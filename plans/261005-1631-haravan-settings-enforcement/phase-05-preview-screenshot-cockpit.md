---
phase: 5
title: "Haravan Preview Screenshot & Cockpit Integration"
status: complete
priority: P2
effort: "3h"
dependencies: [4]
---

# Phase 5: Haravan Preview Screenshot & Cockpit Integration

## Goal
Update `haravan-preview-screenshot` to extract badge numbers directly from fieldset hierarchy, execute viewport screenshots through AntiFan MCP (AGENTS.md §3.1), default uploads to Haravan Files (`haravan-upload-file`) with dual-step approval, adapt Cockpit `qag-04` dynamically by platform mode, and surface settings findings in Cockpit reports without blocking checklist ticking.

---

## Tasks & Steps

### Task 5.1 — Update `haravan-preview-screenshot` Skill
- **Goal:** Drive numbered badges from child fieldsets, prioritize AntiFan MCP for captures, and use Haravan Files as primary upload destination.
- **Target files and symbols:**
  - Modify: `C:/Users/Admin/.agents/skills/haravan-preview-screenshot/SKILL.md`
- **Steps:**
  1. Fieldset badge extraction logic:
     - Parse `config/settings.html` preview sections.
     - For each top-level fieldset, find all child `<fieldset>` containers.
     - Number badges sequentially `1..N` matching the count and visual order of child fieldsets.
     - If a control is not grouped into a child fieldset, map it to the active section badge rather than inventing synthetic numbers.
  2. Surface hierarchy compliance (AGENTS.md §3.1):
     - AntiFan MCP `anti.screenshot.viewport` (or `anti.inspect.dom` -> viewport capture) is the PRIMARY surface.
     - Playwright MCP is permitted ONLY if AntiFan bridge is confirmed offline (`[PLAYWRIGHT-FALLBACK]` recorded).
  3. Upload destination & two-step approval:
     - Destination default: `haravan-upload-file` (Haravan Files / hstatic CDN). Catbox is the fallback only if merchant file upload fails.
     - Step 1 Approval: Ask merchant confirmation before uploading image file.
     - Step 2 Approval: Ask separate merchant confirmation before updating preview image URL in `config/settings.html`.
- **Success criteria:** Screenshot generation produces exact N badges for N fieldsets and conforms to AGENTS.md §3.1.
- **Verify:** Run grep on updated skill:
  `grep -n "anti.screenshot.viewport" "C:/Users/Admin/.agents/skills/haravan-preview-screenshot/SKILL.md"`
  Pass condition: Matches AntiFan MCP primary surface directive.

---

### Task 5.2 — Platform-Adaptive Cockpit Checklist Item `qag-04`
- **Goal:** Update `qag-04` description in Cockpit checklist to refer to `settings.html` for legacy themes and `settings_schema.json` for F1GENZ, without blocking ticking.
- **Target files and symbols:**
  - Modify: `src/shared/theme-checklist.ts:164` (`qag-04`).
- **Steps:**
  1. In `src/shared/theme-checklist.ts`:
     - Update `qag-04` definition:
       ```ts
       description: (themeMode === 'legacy')
         ? 'Validate settings.html controls, duplicate names, and upload asset_url references via theme.settings_check.'
         : 'Validate settings_schema.json definitions and Liquid bindings via theme.settings_check.'
       ```
     - Ensure `action` links directly to `theme.settings_check`.
  2. Invariance: Retain non-blocking checklist ticking. Even if `theme.settings_check` has open findings, merchants and agents CAN toggle the checkbox (Plan 261002 decision).
- **Success criteria:** Inspecting `qag-04` on a legacy workspace displays `settings.html` instructions, and ticking remains unblocked.
- **Verify:** Run compile check:
  `npm run compile`
  Pass condition: Exits 0.

---

### Task 5.3 — Surface Settings Summary in Cockpit Findings & Reports
- **Goal:** Include the latest settings check status (`newFailures` vs `legacyDebt`) in `theme.cockpit_findings` and `theme.cockpit_report`.
- **Target files and symbols:**
  - Modify: `src/main/tools/cockpit-capabilities.ts` (`theme.cockpit_findings`, `theme.cockpit_report`).
- **Steps:**
  1. In `theme.cockpit_findings` and `theme.cockpit_report` handlers:
     - If workspace is a Haravan theme:
       Query `settingsRatchet = evaluateSettingsRatchet(...)`.
       Include in output:
       `settingsSummary: { ok: settingsRatchet.ok, newFailures: settingsRatchet.newFailures.length, legacyDebt: settingsRatchet.legacyDebt.length, topViolations: settingsRatchet.newFailures.slice(0, 5) }`.
  2. Display in Cockpit UI panel as an informational card beside `qag-04`.
- **Success criteria:** Calling `theme.cockpit_report` includes the `settingsSummary` object.
- **Verify:** Run Cockpit MCP capability unit tests:
  `node --test --test-force-exit ".compiled/test/main/**/cockpit-capabilities.test.js"`
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
