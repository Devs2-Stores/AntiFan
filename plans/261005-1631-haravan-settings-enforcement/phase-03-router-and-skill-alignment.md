---
phase: 3
title: "Router & Skill Harmonization"
status: pending
priority: P1
effort: "2h"
dependencies: [2]
---

# Phase 3: Router & Skill Harmonization

## Goal
Align agent skill instructions and routing so that legacy `settings.html` requests route to `haravan-settings` (never `haravan-settings-schema`), add the explicit `'X' | asset_url` upload contract to `haravan-settings`, clarify that toggles apply to sections/items rather than images, and synchronize both user skill trees (`~/.claude/skills` and `~/.agents/skills`).

---

## Tasks & Steps

### Task 3.1 — Update Haravan Skill Router
- **Goal:** Direct legacy `settings.html` work to `haravan-settings` and prevent agent deflection to F1GENZ `settings_schema.json`.
- **Target files and symbols:**
  - Modify: `C:/Users/Admin/.agents/skills/haravan/SKILL.md`
  - Modify: `C:/Users/Admin/.claude/skills/haravan/SKILL.md`
- **Steps:**
  1. Inspect skill routing tables and guidelines in `haravan/SKILL.md`.
  2. Clarify theme mode detection:
     - If `config/settings.html` exists and `config/settings_schema.json` is absent/inert: theme is **Haravan Legacy** -> MUST invoke `haravan-settings`.
     - If `config/settings_schema.json` declares live settings: theme is **F1GENZ** -> MUST invoke `haravan-settings-schema`.
     - `haravan-theme` handles Liquid templates, layout, and snippets, but delegates configuration file creation to the respective settings skill.
- **Success criteria:** The routing table in `haravan/SKILL.md` unambiguously routes `settings.html` tasks to `haravan-settings`.
- **Verify:** Run grep verifying routing entry:
  `grep -n "haravan-settings" "C:/Users/Admin/.agents/skills/haravan/SKILL.md"`
  Pass condition: Matches the explicit legacy settings rule.

---

### Task 3.2 — Add Upload Rule & Clarify Toggles in `haravan-settings`
- **Goal:** Document the strict upload contract in `haravan-settings/SKILL.md` and clarify that toggles belong to blocks/sections, never image fields.
- **Target files and symbols:**
  - Modify: `C:/Users/Admin/.agents/skills/haravan-settings/SKILL.md`
  - Modify: `C:/Users/Admin/.claude/skills/haravan-settings/SKILL.md`
- **Steps:**
  1. In `haravan-settings/SKILL.md`, add the **Upload Setting Contract**:
     - `<input type="file" name="X">` registers an uploaded asset file under `assets/`.
     - Liquid templates MUST reference it exclusively as `'X' | asset_url`.
     - FORBIDDEN: `settings['X']`, `settings.X`, `{% if settings['X'] %}`, `| default:`, or creating separate enable checkboxes for images.
     - Accept broken image on development stores until the merchant uploads the file; do not hide or wrap with synthetic conditionals.
  2. Clarify **Rule 4 (Toggles)**:
     - Checkbox controls (`type="checkbox"`) are reserved for enabling/disabling entire functional sections, promotional banners, or repeatable list items.
     - NEVER create a toggle checkbox whose sole purpose is to hide an un-uploaded image asset.
- **Success criteria:** Both rules are clearly stated with concrete examples of allowed vs forbidden Liquid syntax.
- **Verify:** Run grep on updated rules:
  `grep -n "asset_url" "C:/Users/Admin/.agents/skills/haravan-settings/SKILL.md"`
  Pass condition: Returns matches for the new upload rule.

---

### Task 3.3 — Harmonize Dual Skill Trees
- **Goal:** Ensure `~/.claude/skills` and `~/.agents/skills` are completely synchronized and have matching SHA-256 hashes.
- **Target files and symbols:**
  - Check: `C:/Users/Admin/.agents/skills/haravan-settings/SKILL.md` vs `C:/Users/Admin/.claude/skills/haravan-settings/SKILL.md`
  - Check: `C:/Users/Admin/.agents/skills/haravan/SKILL.md` vs `C:/Users/Admin/.claude/skills/haravan/SKILL.md`
- **Steps:**
  1. Compare the contents of `haravan-settings/SKILL.md` in both locations using SHA-256.
  2. Compare the contents of `haravan/SKILL.md` in both locations using SHA-256.
  3. If any discrepancy exists, copy the authoritative `.agents` version over to `.claude`.
- **Success criteria:** Both pairs of skill files have identical SHA-256 checksums.
- **Verify:** Run checksum verification command:
  `node -e "const crypto = require('crypto'), fs = require('fs'); const h1 = crypto.createHash('sha256').update(fs.readFileSync('C:/Users/Admin/.agents/skills/haravan-settings/SKILL.md')).digest('hex'); const h2 = crypto.createHash('sha256').update(fs.readFileSync('C:/Users/Admin/.claude/skills/haravan-settings/SKILL.md')).digest('hex'); console.log(h1 === h2 ? 'MATCH' : 'MISMATCH'); if (h1 !== h2) process.exit(1);"`
  Pass condition: Exits 0 and prints `MATCH`.

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
