---
title: "haravan-settings-enforcement"
description: "Haravan settings automated enforcement, shop isolation, upload contracts, and QA gate ratchet"
status: blocked
priority: P1
effort: "21h"
tags: ["haravan", "settings", "qa-gate", "mcp"]
created: 2026-10-05
---

# Haravan Settings Enforcement — Plan

> **Mode:** `ak:plan --advice`  
> **Source Contract:** `plans/reports/brainstorm-261005-2304-haravan-settings-enforcement.md` (Accepted 2026-10-05)  
> **Target Audience / Executor:** Handover-ready for weaker executors (Flash/Sonnet class). Follows strict comparison-based verification and the mandatory Failure Protocol.

---

## Executive Summary & Architecture Authority Split

Haravan theme settings have suffered repeated human intervention and regression due to un-enforced conventions and silent linters that accepted wrong spellings. This plan transforms settled settings rules into mechanical gates:

```text
               Agent Write Action (OMP Runtime)
                             |
         +-------------------+-------------------+
         |                                       |
    Native Edit/Write                      theme.transaction.write_cas
         |                                       |
         v                                       v
[PRE-HOOK: edit-guard]                 [MCP: Transaction Registry]
Target == config/settings_data.json?   Verify: targetTabId origin shop
- Standard Mode: BLOCK                 (org_id, theme_id) == workspace shop
- Direct/Super-Fast: ALLOW + log       - Match: ALLOW writeCAS
                                       - Mismatch: THROW Refusal
         |                                       |
         +-------------------+-------------------+
                             |
                   Filesystem Modified
                             |
                             v
               [POST-HOOK: theme-qa-gate]
                 Monotonic Ratchet Gate (Evidence Authority)
                 - Arms on theme file edits
                 - Computes Multiset finding diff: (rule, id, file)
                 - count_working - count_base > 0?
                   * YES: Receipt verdict QA_FAILED (persistent reminder emitted; unverified completion disallowed by repo contract)
                   * NO:  Receipt verdict QA_PASSED (receipt emitted cleanly)
```

### Critical Architectural Invariants
1. **Authority Split between Pre-Hook and Post-Hook**:
   - **Pre-Hook (`edit-guard.ts` in `pre/`)**: Runtime tool call veto. Intercepts native OMP tool calls (`write`, `edit`) targeting `config/settings_data.json` before execution, returning `{ block: true, reason }` in standard mode.
   - **Post-Hook (`theme-qa-gate.ts` in `post/`)**: Evidence & Receipt Gate. It has no tool-cancellation capability; instead, it evaluates receipts, records new settings findings in `theme.qa_validate` output with `verdict: 'QA_FAILED'`, keeps `pendingEdits` armed, and injects pending status reminders into turn_end/context.
2. **Shop Identity is a Tuple `(org_id, theme_id)`**: Workspaces like `TestVyan` and `Vyantechnology` share the identical `org_id` (200000878093) with different `theme_id`s (1001510621 vs 1001509080). Shop isolation MUST bind the exact `(org_id, theme_id)` tuple from `.haravan-cli_local.json`.
3. **Upload Control Contract**: An `<input type="file" name="X">` represents a platform asset uploaded to `assets/`. The ONLY valid Liquid spelling to read it is `'X' | asset_url`. All bracket reads `settings['X']`, existence checks `{% if settings['X'] %}`, fallback defaults, and dedicated enable toggles for images are forbidden.
4. **Multiset Ratchet**: Finding comparisons between baseline and working tree use multiset key counting: `key = `${rule}::${id}::${file}``. Only positive count increases (`workingCount > baseCount`) produce failures. Line-shifting edits do not trigger new findings.
---

## Phases Overview

| Phase | Title | Scope & Deliverable | Status |
|---|---|---|---|
| **[Phase 1](./phase-01-start.md)** | Shop Identity & Settings Data Guard | `(org_id, theme_id)` resolver, MCP `write_cas` shop validator, `edit-guard` native write veto | Done (verified; kongming checkpoint) |
| **[Phase 2](./phase-02-upload-contract-checker.md)** | Upload Contract & Theme Settings Check | `HARAVAN_SETTINGS_UPLOAD_READ` rule, prune `settings_data.json` from `knownSettings`, duplicate name detection, `theme.settings_check` tool | Done (verified) |
| **[Phase 3](./phase-03-router-and-skill-alignment.md)** | Router & Skill Harmonization | Route legacy `settings.html` to `haravan-settings`, update `SKILL.md` upload rules, synchronize dual skill trees | Done (verified, SHA-parity) |
| **[Phase 4](./phase-04-settings-ratchet-gate.md)** | Settings Ratchet & Gate Hook Enforcement | Monotonic baseline store, multiset finding diff, `theme-qa-gate` veto on new findings | Done (55/55 gate tests; kongming GO; +leak fix +drift test) |
| **[Phase 5](./phase-05-preview-screenshot-cockpit.md)** | Haravan Preview Screenshot & Cockpit Integration | Badge extraction from fieldsets, MCP viewport screenshot, platform-specific `qag-04` Cockpit check | Done (verified; read-only `{persist:false}` + fresh-load enforced) |
| **[Phase 6](./phase-06-admin-roundtrip-verification.md)** | Admin Save Roundtrip & Storefront Verification | End-to-end multi-theme validation, Seahorse2 / Phukienmaymoc / Giaohangnang live verification | Done with caveat — 6.1–6.3 verified (39/39 scan, 0 crashes, isolation PASS); 6.4 live-save leg environment-blocked (no antifan MCP mount) → see `plans/reports/p6-storefront-roundtrip-evidence.md` |

---

## Verification & Rollback Authority

- **Fast Suite:** `npm run test:fast`
- **Unit Suite:** `node --test --test-force-exit test/unit/theme-checks.test.mjs test/unit/theme-qa-gate-hook.test.mjs test/unit/edit-guard.test.mjs`
- **Hook Installer Check:** `node scripts/install-omp-hooks.mjs --check`
- **Compilation Check:** `npm run compile`
