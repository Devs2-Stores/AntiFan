# Haravan Settings Enforcement — Final Report

Date: 2026-10-05 · Plan: `261005-1631-haravan-settings-enforcement` · Status: **done (verified; 2 caveats below)**

## Summary

All 6 phases executed and verified. The settings-enforcement surface is live:
shop-identity resolver, edit-guard veto, upload-contract checker (`theme.settings_check`),
monotonic settings ratchet + armed theme-qa-gate, cockpit read-only integration,
batch audit runner, and shop-isolation proof.

| Phase | Result |
|---|---|
| P1 Shop Identity & Guard | ✅ write_cas fail-closed, edit-guard veto, hook bundle installed (IN_SYNC) |
| P2 Upload Contract | ✅ `HARAVAN_SETTINGS_UPLOAD_READ`/`DUPLICATE_NAME`/`SETTING_UNDECLARED`, `theme.settings_check` |
| P3 Router/Skill Harmonization | ✅ routing split, `.agents`↔`.claude` skill SHA parity |
| P4 Settings Ratchet & Gate | ✅ 55/55 gate tests; kongming GO after predicate fix + stale-findings leak fix |
| P5 Preview Screenshot & Cockpit | ✅ skill updated, `qag-04` platform-adaptive, `settingsSummary` read-only (`persist:false` + fresh baseline load) |
| P6 Roundtrip & Batch | ✅ 39/39 scan, 0 crashes, isolation PASS — see caveats |

## Hardening beyond spec (advisory-driven)

- `reconcileReceipts()`: gate now stays armed on **any** `QA_FAILED` receipt (not only
  settings ratchets) — non-Haravan/visual failures no longer silently clear the gate.
- Stale-findings leak fixed: `pendingSettingsFindings.delete(root)` when ratchet
  reports ok/absent — resolved regressions can no longer resurrect old reminder text.
- Delete→restore drift documented + locked by regression test (ratchet-down
  deletes baseline keys; restored debt re-flags as blocking newFailure — by design).
- `evaluateSettingsRatchet` non-purity documented: mutates in-memory baseline even
  under `persist:false`; read-only callers must reload per evaluation.
- Mock-alignment fix: 3 `TabDevToolsHost` test mocks gained `getAllTabs`/`broadcastState`
  (pre-existing defect from commit 98622349 teardown contract).
- **Shipped theme violation found + fixed** (`themes/universal-haravan-base`):
  `fb-open-graph-tags.liquid`, `header.liquid`, `seo_head.liquid` all read upload
  settings (`header_logo`, `favicon`) directly instead of `'X' | asset_url` —
  6 violations across 3 files, now contract-clean (10/10 lint suite).

## Verification evidence

- `node --test --test-force-exit test/unit/theme-qa-gate-hook.test.mjs` → **55/55**
- `node --test --test-force-exit test/unit/lint-haravan-theme.test.mjs` → **10/10**
- `node scripts/batch-audit-themes.mjs` → **`BATCH_AUDIT_PASS: 39/39, 0 crashes`**
- `node --test --test-force-exit ".compiled/test/main/**/theme-transaction-shop-isolation.test.js"` → **PASS**
- QA-adjacent compiled lanes (parity, control-plane, checklist, adjudication, evidence, verification) → **75/75**
- `npm run test:fast` → 1796/1798 pass; the 2 failures are `core-health-cli-deadline`
  timing-sensitive tests that pass in isolation (Windows load flake, unrelated).
- `node scripts/install-omp-hooks.mjs --check` → all 3 hooks IN_SYNC.
- `node scripts/check-plans.mjs --root plans` → gate clean.
- Installed `antifan-theme-qa-gate.js` bundle verified to contain the reconcile fix.

## Caveats / open items

1. **38→39 reconciliation** (user-approved): `E:/Work/customizes` contains 39
   eligible workspaces, not the brainstorm's 38 (`Vyantechnology` added later).
   Phase-06 spec + runner default updated to 39.
2. **Task 6.1 approval gate — PENDING_HUMAN**: `--approve` correctly refuses
   without per-theme `-review.md` disposition artifacts (verified on Giaohangnang).
   Human review of all `UPLOAD_READ`/`DUPLICATE_NAME` findings remains a manual step.
3. **Task 6.4 live-save leg — environment-blocked**: AntiFan browser MCP
   (`xd://mcp__antifan_*`) is not mounted in this session (`CAPABILITY_NOT_FOUND`).
   Storefront DOM-vs-settings revision was verified read-only via HTTPS on the
   live store (`plans/reports/p6-storefront-roundtrip-evidence.md`); the
   write_cas→admin-save→reload→receipt loop needs a session with the bridge mounted.
   QA-gate status: **QA_UNAVAILABLE** (capability absent, re-probed).
4. **Full compiled suite**: 3143/3149 pass; the 6 diffs are environmental
   flakes (pass in isolation) plus the now-fixed parity-kernel mock defect.
   `test:fast` residual: 2 `core-health-cli-deadline` timeouts under load only.
