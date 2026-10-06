# Ultra Review — haravan-settings-enforcement pending diff
Mode: `ak:code-review --pending --ultra` (Stage-1 spec pass + 5 parallel reviewers + kongming union verifier)
Verdict: **BLOCK — request changes** (2 critical, 5 high, 7 medium, 8 low)
Method note: verifier output spot-re-verified against live source for all critical/high claims; all 7 confirmed.

## Stage-1 spec compliance: PASS
All required symbols present (`resolveWorkspaceShop`, `SHOP_IDENTITY_MISMATCH`, `REFUSED_SETTINGS_DATA_DIRECT_WRITE`, `HARAVAN_SETTINGS_UPLOAD_READ`, ratchet gate wiring, batch audit). Accepted caveats: 38→39 workspace-count reconcile; phase-6.4 env-blocked (CAPABILITY_NOT_FOUND on unmounted `anti.*`).

## Validated findings (deduplicated union)

### Critical
1. **`theme-transaction-capabilities.ts:190`** — `write_cas` shop-isolation bypass. `normalizedRelative` strips `\\`→`/` and leading `/` only; `./config/settings_data.json` or `config//settings_data.json` ≠ `config/settings_data.json`, skipping the entire org/theme identity gate (lines 192–250) while `writeCAS` proceeds with the raw path. Cross-tenant `settings_data.json` write. *(verified live)*
2. **`theme-qa-gate.ts:625`** — corrupt/in-flight receipt JSON disarms the QA gate. `JSON.parse` throw → `latest = mtime`, `latestReceipt = null` → returns `{time, receipt:{}}`; in `reconcileReceipts` `receipt.verdict !== 'QA_FAILED'` hits the else branch → `clearPending(root)` silently drops armed edits. *(verified live)*

### High
3. **`browser-capabilities.ts:1783`** — `theme.qa_validate` returns the unmutated `report` when the ratchet fails. Disk receipt is honest (`passed:false`, `QA_FAILED`, `settingsRatchet` attached at 1826–1828) but the MCP caller sees `summary.passed:true`, `criticalCount:0`, no `settingsRatchet` — contradicts annotation-prompt self-QA contract. *(verified live)*
4. **`cockpit-capabilities.ts:97`** — `collectHaravanSettingsFindings` uses `process.cwd()` for repoRoot; peers use `resolveRepoRoot()`. Non-repo cwd → `theme-checks.mjs` not found → silent `[]` → false-clean `settingsSummary`. *(verified live; corroborated ×3)*
5. **`batch-audit-themes.mjs:111–120`** — `--approve` on a workspace with no baseline writes `{reviewed:true}` with empty `counts`. Next `loadOrBootstrapBaseline` reads `counts:{}` + `reviewed:true` → every pre-existing finding = newFailure → permanent QA_FAILED. *(verified live)*
6. **`batch-audit-themes.mjs:87`** — certification boolean flaw: `id === ''` ⇒ `mentionsId = true` ⇒ `(!mentionsId && !mentionsFile)` false ⇒ ID-less findings (e.g. `HARAVAN_NO_DUAL_SURFACE`, schema errors) certify on rule name alone, no file check. *(verified live)*
7. **`settings-ratchet.ts:163`** — legacy-debt oscillation: `diff > 0` keys are pushed only to `newFailures` and dropped from `legacyDebt`, so baseline debt vanishes from reported metrics while a regression on the same key persists. *(verified live)*

### Medium
8. **`edit-guard.ts:368`** — `isSettingsDataWrite` regex tests raw target; cwd=`config/` + `settings_data.json` bypasses veto in unset mode.
9. **`shop-identity.ts:214`** — fallback loop grabs `match[1]` orgId from ANY `hstatic.net` URL without `match[2] === themeIdCandidate` → hybrid (orgA, themeB) tuple instead of fail-closed null.
10. **`theme-qa-gate.ts:645`** — `latestReceiptRecord` returns root-direct receipt before probing nested dirs; stale root receipt shadows newer nested receipts forever.
11. **`theme-qa-gate.ts:1276`** — terminal bypass tokens (`QA_UNAVAILABLE`, `QA_INCONCLUSIVE`) clear `pendingEdits`/`microEdits` but not `pendingSettingsFindings` → stale findings in later reminders.
12. **`theme-qa-gate.ts:1081/720`** — `pendingEdits.set` only when absent → TTL measures from first edit; active work 10min later gets pruned mid-session.
13. **`theme-qa-gate.ts:1015`** — `reminderText` prescribes `'x' | asset_url` fix for ALL rules incl. DUPLICATE_NAME / SETTING_UNDECLARED → misleading repair guidance. (×2)
14. **`themes/universal-haravan-base/snippets/seo_head.liquid:13`** — `{{ 'favicon' | asset_url }}` (no ext) vs physical `favicon.png`; `localAssetExists` only aliases `.liquid` → `LOCAL_ASSET_MISSING` on self-fixture.

### Low
15. `batch-audit-themes.mjs:36` — `--approve` targetDir unsanitized; basename-keyed report lookup can stamp a foreign dir.
16. `browser-capabilities.ts:1767` / `cockpit-capabilities.ts:194` — receipt `newFailures`/`legacyDebt` count unique keys, not summed `count` occurrences; inconsistent vs `totalFindings`. (×2)
17. `scripts/lib/theme-checks.mjs:673` — `HARAVAN_SETTING_UNRESOLVED` message still cites `settings_data.json`; post-P2 knownSettings derives from declarations only. (×2)
18. `theme-transaction-capabilities.ts:427` — unguarded dynamic import → raw `ERR_MODULE_NOT_FOUND` instead of structured error.
19. `theme-checklist.ts:207` — `themeMode` ternary evaluated at module load; `setChecklistThemeMode` never called → toolbar always F1GENZ text.
20. `theme-transaction-capabilities.ts:217` — `as unknown as {browserPort?}` cast because `registerThemeTransactionCapabilities` is called without the port arg (control-plane-runtime.ts:254).
21. `batch-audit-themes.mjs:183` — `spawnRes.error` uninspected → timeouts/crashes masquerade as generic exit codes.
22. `toolbar.ts:3613` — unrelated FontFinder WIP hunk mixed into this changeset.

## Dropped after verification (4)
- Missing `header_logo` fallback span — contradicts accepted upload contract (no fallbacks).
- "Vacuous QA_FAILED receipt tests" — tests intentionally assert armed-state preservation.
- Receipt-timestamp race — isolated-tmpdir sync tests; deterministic.
- Cockpit `typeof` assertions — covered by subsequent deepStrictEqual drift checks.

## Reviewer false-negatives (cited as clean, actually buggy)
`shop-identity` fallback (finding 9), `edit-guard` cwd bypass (8), ratchet multiset (7), `write_cas` normalization (1), batch-approve (5,6).

## Recommendation
Fix 1–7 before any commit; 8–14 in the same pass (all in touched files except 14, a one-word fixture fix). 15–22 may ride along or follow-up — except 22, which must be split out of the changeset.
Evidence packet: `plans/reports/review-packet/` (diff, classified file list, all 5 candidate outputs in `candidates.md`).
