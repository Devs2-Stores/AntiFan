# Phase 00 — Baseline Freeze, Safety Policy, and Identity Contract
Status: READY
Depends on: none

## Context
This phase establishes the read-only store inventory, frozen defect baseline, safety policies against live theme mutation, and theme identity contracts for the Haravan A→Z implementation program (`260912-1731`). Prior certifications in this repository produced unsupported `100.0% PASS` claims driven by fail-open adjudication, insufficient viewport attestation, inert preview parameters, and fallback metrics. Before modifying any generator, scanner, or theme code, the exact defect baseline must be frozen, production theme mutation must be blocked by generic role guards in shared tooling, and theme identity contracts must be defined.

### 1. Frozen Defect Baseline (D1–D11)
All 11 architectural findings are grounded in verified repository evidence:

| ID | Location / Source Anchor | Defect Mechanism | Observable Consequence |
|---|---|---|---|
| **D1** | `src/main/qa/theme-qa-workflow.ts:725–792` | Unmeasured viewports default to `{ mismatchPercent: null, passed: true, measured: false }` (L727, 731, 735), defaulting `visualScore` and `responsiveScore` to 100 (L737–745), excluding unmeasured dimensions from `scoredDimensions` (L782–783), and passing via `(!vpDesktop.measured \|\| vpDesktop.passed)` (L789–792). | False `passed: true` verdict; arithmetic mean inflated to 98–100 without measuring diffs. |
| **D2** | `src/main/qa/theme-qa-workflow.ts:763` | Hardcodes `'Haravan OS 2.0 sections, schema presets, and Liquid templates'` into `dimensions.haravanCompliance.details`. | Self-certifies an architecture absent from Haravan. |
| **D3** | `reports/visual-compare-45-cases.json` vs `reports/HARAVAN-STOREFRONT-FINAL-CAMPAIGN-REPORT.md:124,150` | Campaign report headline claims `45 / 45 ca (100.0% PASS)`, whereas `visual-compare-45-cases.json` records 29 PASS and 16 REVIEW cases. The artifacts lack common run bindings to prove they reflect the same execution. | Unreconciled reporting discrepancy between summary headline and case-level measurements. |
| **D4** | `src/main/qa/scanners/platform-detector.ts:78–88` | Line 84 states `// Both Shopify and Haravan use .liquid sections` and L86 awards `haravanScore += 10` for `sections/*.liquid`. | Misidentifies Shopify OS 2.0 structure as Haravan evidence. Haravan scoring must be platform-scoped without disrupting shared Shopify/Sapo detection. |
| **D5** | `packages/site-clone/src/generators/theme-compiler.ts:133,190,317,455–480`; `dod-validator.ts:5,47,235,241` | Compiler synthesizes `templates/index.json`, `sections/*.liquid`, and `{% schema %}` blocks (e.g., `themes/roahtrip-haravan/`). | Emits Shopify OS 2.0 structures unrenderable on Haravan storefronts. |
| **D6** | `scripts/verify-all-visual-compare.mjs:190–197` | Selects `effectiveMismatch = min(fresh, recorded)`, preferring recorded numbers over worse fresh results. | Silently masks regressions; scoring is not fresh-diff dominant. |
| **D7** | `scripts/verify-all-visual-compare.mjs:212–215` | Loop calculates `if (r.mismatchPercentage < 2.0) passCount++`. In JavaScript, `null < 2.0 === true`. | Unmeasured cases (`null`) coerce to 0 and increment pass totals. |
| **D8** | `src/main/browser/theme-source-mapper.ts:222–267,386` | Maps `sections/` to `'section'` and awards `section_lineage` weight 2. This is not inherently a bug in a multi-platform module, but lacks Haravan-scoped policy handling. | Biases resolution toward nonexistent section wrappers for Haravan themes. Shared Shopify/Sapo mapping must remain intact. |
| **D9** | `reports/chromium-verification/chromium-45-cases-results.json:15` | Verification URLs used Shopify parameter `?preview_theme_id=1001512581`. Diagnostic probing shows cookie-less GETs return HTML byte-identical to bare storefront (sha `c6d8127e597ebe7d`), whereas `?themeid=` sets `preview_theme_id` cookie and produces different HTML. | Historical Chromium run lacked identity receipts and measured the live storefront. |
| **D10** | `reports/chromium-verification/chromium-45-cases-results.json:25,49,73` | All 45 cases record `docWidth: 1905`, `hasFooter: false`, and identical content metrics across viewports. | Proves recorded overflow and missing viewport attestation (root canvas unconstrained), not that emulation was unapplied. Equal heights/text or equal PNG hashes can be legitimate; no arbitrary inequality thresholds. |
| **D11** | `.canary/tools/theme-fidelity.mjs:86,456,1539,1546` (reflected in `.canary/state/subset-r2.json:39–120`) | The producer hardcodes `PRODUCTION_THEME = '-1'` into URL safety evaluation, whitelisting `themeid=-1`. | Allows unparameterized/live theme requests to bypass isolation gates. The producer must be fixed; historical artifacts must not be modified to simulate a fix. |

### 2. Store Tenancy and Ownership Boundaries
- **Target Store:** `phukienmaymoc.com` (Haravan Org `200001207485`).
- **Protected Live Theme:** `1001510509` (role: `main`). Must never be mutated, targeted for push, or overwritten. Diagnostic read-only inspection of the main theme is allowed.
- **Authorized Staging Theme:** `1001512581` (role: `unpublished` / draft copy, named "Bản sao chép của clothing"). Sole authorized target for theme updates.
- **Reference Storefront:** `hoplongtech.com` (external reference for fidelity comparison).

### 3. Empirical Corpus Observations vs Platform Policy
A census of 30 production Haravan themes in `E:/Work/customizes` demonstrates consistent recurrence:
- `layout/` singular in 30/30; `sections/` absent in 0/30; JSON templates absent in 0/30; `{% schema %}` absent in 0/30; `{% render %}` absent in 0/30; Shopify-only filters absent in 0/30.
- `config/settings.html` present in 30/30; `config/settings_schema.json` present in 24/30.
- Carousels rely on theme-specific vendor libraries (Slick: 19, Swiper: 9, Owl: 6, Flickity: 5).
- Server sets cookie `preview_theme_id` upon receiving `?themeid=<id>`. This cookie name is native to Haravan and must not be deleted or banned.
These corpus findings reflect common industry practice rather than formal platform limits. AntiFan Base Theme conventions will align with this empirical consensus without claiming it as universal platform law.

### 4. Existing Fail-Closed Primitives
The repository already owns fail-closed synchronization and verification primitives that must be wired rather than rebuilt:
- `src/main/qa/haravan-sync-barrier.ts`: `awaitSync()` enforces watcher upload attestation (throws `DURABILITY_FAILED`); `awaitReloadAndSettle()` enforces tab reload and document generation advance (throws `STALE_LINEAGE`). Baseline terminal cursors must be captured **before** mutations.
- `src/main/qa/theme-mutation-session.ts`: `awaitSyncAndReload()` coordinates sync barrier and reload settling; `writeCAS()` enforces atomic CAS updates; `settle()` enforces `HARD_FAIL_ROLLBACK` on `REJECTED` verdicts.
- `src/main/qa/theme-transaction-registry.ts`: `begin()`, `writeCAS()`, `awaitSyncAndReload()`, `settle()` manage in-flight workspace reservations and tenancy isolation.
- `src/main/verification/capture-settle.ts`: `evaluatePreCaptureQuiescence()` evaluates 6 strict predicates (`documentGenerationSettled`, `viewportStable`, `fontsSettled`, `imagesSettled`, `imageIdentityStable`, `layoutStable`).
- `src/main/browser/semantic-ref-registry.ts`: Enforces DOM reference staleness checks, throwing `REF_STALE` and `TARGET_STALE` on document generation drift.
- `scripts/lib/atomic-record.mjs`: `sha256Buffer()`, `sha256Text()` (CRLF→LF normalized), `sha256File()`, `HASH_CONTRACT` (`lf-normalized`, `byte-exact`), `textDigest()`, `writeRecordAtomic()`, `readRecord()`, `removeRecordIf()`, `pruneTempRecords()`.

### 5. Controller Invariants
- In `theme-qa-workflow.ts:218–234`, `settleCapture` is **optional when the method is absent** on the host adapter (`typeof ... === 'function'` skips cleanly), but **fail-closed when present and incomplete** (`settleReceipt.settleComplete === false` throws `SETTLE_INCOMPLETE`).
- `checkAborted()` (L206–214) already enforces document generation checks (`TARGET_STALE`).
- Existing guards must remain untouched; only missing sync barrier invocations and pre-inspection quiescence must be wired in Phase 01.

### 6. Theme Identity Limits
Raw HTML hash differences do **not** establish theme identity. Dynamic antiforgery tokens, session state, and unauthenticated routing cause hash variation, while distinct draft themes may share identical shell markup. The utility `scripts/probe-theme-identity.mjs` is a diagnostic tool for query parameter behavior. Authoritative theme identity requires read-only store inventory, API role verification (`role !== "main"`), approved write binding, and browser session custody.

---

## Requirements

### R0-1: Generic Role Guard & Project-Scoped Binding in Theme Push
- In shared CLI `E:/Work/apps/Haravan CLI/src/commands/theme/theme-push.ts:34–60`, implement an unconditional generic role guard that blocks pushes whenever target theme `role === "main"`.
- The refusal must execute **unconditionally**, prior to evaluating `--force` and without interactive override prompts (`confirm({ message: ... })`).
- Do not hardcode client-specific theme IDs in shared CLI code; enforce protection through generic role verification and project-scoped configuration bindings.
- If the remote role cannot be verified via API, fail closed for any push to a non-explicitly approved draft target.
- On trigger, emit `[SECURITY_ABORT] PROTECTED_THEME_REFUSAL: Target theme has role "main". Pushing to live themes is blocked.` and exit with code `1`.

### R0-2: Producer Whitelist Correction in Theme Fidelity Tool
- In producer `.canary/tools/theme-fidelity.mjs:86,456,1539,1546`, remove hardcoded `PRODUCTION_THEME = '-1'` from URL safety evaluation and allowed themes sets.
- Ensure `evaluateUrlSafety()` validates targets strictly against explicitly configured `allowedThemes` (`'1001512581'`).
- Any target carrying `themeid=-1` or an empty theme parameter must evaluate to `allowed: false` and trigger `THEME_ID_NOT_ALLOWED` refusal.
- Historical artifact `.canary/state/subset-r2.json` must be retained as historical evidence and not edited.

### R0-3: Read-Only Store Inventory Pre-Flight
- Before any mutation or capture campaign, execute a read-only inventory of target store entities (`phukienmaymoc.com`, org `200001207485`) covering products, collections, pages, blogs, articles, and theme roles.
- Attest that target theme `1001512581` has role `unpublished` and protected theme `1001510509` has role `main`.
- Document query parameter diagnostics using `scripts/probe-theme-identity.mjs` to confirm `?preview_theme_id=` inertness and `?themeid=` cookie behavior (diagnostic read-only inspection of the main theme is permitted).

### R0-4: Execution Identity Tuple Schema and Persistence
- Every test, capture, and verification run must persist an immutable identity tuple using `scripts/lib/atomic-record.mjs`:
  ```ts
  export interface ExecutionIdentityTuple {
    runId: string;
    store: string;             // 'phukienmaymoc.com'
    orgId: string;             // '200001207485'
    themeId: string;           // '1001512581'
    route: string;             // e.g. '/', '/collections/cam-bien'
    viewport: {
      width: number;           // 390 | 768 | 1440
      height: number;          // 844 | 1024 | 900
      mobile: boolean;
    };
    referenceSha256: string;
    captureSha256: string;
    hashContract: 'lf-normalized' | 'byte-exact';
    timestamp: string;         // ISO-8601 UTC
  }
  ```
- Persistence must be performed atomically via `writeRecordAtomic()` to `reports/runs/<runId>/identities/<caseId>.json`.
- Invariant:
  - Attempted unauthorized mutation (write, push, delete) targeting a live theme (role `main`, e.g., `1001510509`), `-1`, or an unapproved theme ID yields `SECURITY_ABORT`.
  - Capture target mismatch during verification (where the captured theme does not match the authorized staging theme `1001512581`) yields `INCONCLUSIVE`, never `PASS`.
  - Diagnostic read-only inspection of the live/main theme (e.g., baseline parameter comparison in `scripts/probe-theme-identity.mjs`) is explicitly allowed.

### R0-5: Fail-Closed Primitive Wiring Roster
- Subsequent phases must directly wire existing primitives:
  - Phase 01: Wire `HaravanSyncBarrier.awaitSync` (with cursor captured before mutation) and `awaitReloadAndSettle` into `theme-qa-workflow.ts:187–205`, and wire `evaluatePreCaptureQuiescence` into `theme-qa-workflow.ts:262`.
  - Phase 02: Replace `scripts/verify-all-visual-compare.mjs` with fresh-diff dominance, recording actual viewport metrics (`innerWidth`, `clientWidth`, `visualViewport`, `DPR`, raster size). Overflow is an explicit failure; equal heights/text or identical PNG hashes are not penalized by arbitrary thresholds.
  - Phase 03: Wire `ExecutionIdentityTuple` and custody checks into capture orchestration.
  - Phase 04: Remove section scoring from `platform-detector.ts:78–88` and `theme-source-mapper.ts:222–267,386` strictly scoped to Haravan, preserving shared Shopify and Sapo capabilities.

### R0-6: Scope Preservation
- No wiki or accessibility scope drops are authorized. Full documentation, operator runbooks, WCAG/a11y evaluations, and test coverage must be preserved throughout implementation.

---

## Files

| path | action | why |
|---|---|---|
| `plans/260912-1731-haravan-az-implementation-plan/phase-00-baseline-freeze-and-guards.md` | create | Author this phase specification and baseline freeze document |
| `E:/Work/apps/Haravan CLI/src/commands/theme/theme-push.ts` | edit | Implement generic live theme role guard in shared CLI, blocking push to `role === "main"` regardless of `--force` |
| `.canary/tools/theme-fidelity.mjs` | edit | Remove hardcoded `PRODUCTION_THEME = '-1'` from producer URL safety evaluation |
| `.canary/state/subset-r2.json` | read | Historical canary state artifact showing defect D11 symptom |
| `scripts/probe-theme-identity.mjs` | read | Diagnostic probe inspecting query parameter inertness (`?preview_theme_id=`) vs cookie setting (`?themeid=`) |
| `src/main/qa/haravan-sync-barrier.ts` | read | Source of truth for `HaravanSyncBarrier`, `awaitSync`, and `awaitReloadAndSettle` |
| `src/main/qa/theme-mutation-session.ts` | read | Source of truth for `ThemeMutationSession`, CAS writes, and rollback contracts |
| `src/main/qa/theme-transaction-registry.ts` | read | Source of truth for `ThemeTransactionRegistry` concurrency reservation |
| `src/main/verification/capture-settle.ts` | read | Source of truth for 6-predicate pre-capture quiescence evaluation |
| `src/main/browser/semantic-ref-registry.ts` | read | Source of truth for semantic reference and target staleness detection |
| `scripts/lib/atomic-record.mjs` | read | Source of truth for atomic record persistence and LF-normalized hashing |
| `reports/fidelity-campaign-matrix.json` | read | Baseline campaign artifact establishing 8 PASS / 17 FAIL / 20 INCONCLUSIVE |
| `reports/visual-compare-45-cases.json` | read | Baseline evidence establishing 29 PASS / 16 REVIEW cases |
| `reports/chromium-verification/chromium-45-cases-results.json` | read | Baseline evidence showing viewport overflow / attestation gap (`docWidth: 1905` across 45 cases) |
| `src/main/qa/theme-qa-workflow.ts` | read | Adjudication workflow containing defects D1 and D2 |
| `src/main/qa/scanners/platform-detector.ts` | read | Platform scanner containing defect D4 |
| `scripts/verify-all-visual-compare.mjs` | read | Verification script containing defects D6 and D7 |
| `src/main/browser/theme-source-mapper.ts` | read | Source mapper containing defect D8 |
| `packages/site-clone/src/generators/theme-compiler.ts` | read | Compiler containing defect D5 |

---

## Steps

1. **Implement Generic Live Theme Role Guard in `Haravan CLI/src/commands/theme/theme-push.ts:34–60`:**
   - In lines 34–62, ensure the live theme verification executes unconditionally before checking `force`.
   - Remove the interactive confirmation prompt (`confirm({ message: ... })`) at lines 47–57.
   - If `ti?.theme?.role === "main"`, abort immediately with an error log and `process.exit(1)`.
   - If the API call fails to verify the theme role, fail closed unless the target theme ID is explicitly confirmed as a non-live draft in project configuration.

2. **Correct Producer URL Safety in `.canary/tools/theme-fidelity.mjs:86,456,1539,1546`:**
   - Remove line 86 (`const PRODUCTION_THEME = '-1';`).
   - In line 456 (`evaluateUrlSafety`), construct `allowed` exclusively from `allowedThemes`.
   - In lines 485–487 and 1539–1546, eliminate references to `PRODUCTION_THEME` so that any target naming `-1` is rejected with `THEME_ID_NOT_ALLOWED`.

3. **Run Diagnostic Pre-Flight and Store Inventory:**
   - Execute `scripts/probe-theme-identity.mjs` to diagnostically confirm that `?preview_theme_id=` is inert on `https://phukienmaymoc.com` and that `?themeid=` triggers Haravan preview cookie behavior.
   - Attest target theme `1001512581` has role `unpublished` and protected theme `1001510509` has role `main` via Haravan API before scheduling any mutation.

4. **Lock Execution Identity Persistence:**
   - Standardize `ExecutionIdentityTuple` schema and ensure downstream verification loops persist each case identity atomically using `scripts/lib/atomic-record.mjs` (`HASH_CONTRACT.LF_NORMALIZED`).

---

## Validation

All validation steps are runnable commands:

1. **Inspect Query Parameter Behavior via Diagnostic Probe:**
   ```bash
   node scripts/probe-theme-identity.mjs https://phukienmaymoc.com 1001512581 1001510509
   ```
   *Expected Output:* Diagnostic output confirming `?preview_theme_id=` is inert (byte-identical to bare storefront) and `?themeid=` returns differing HTML with preview cookie.

2. **Verify Producer Rejection of `-1` in `theme-fidelity.mjs`:**
   ```bash
   node -e "import('./.canary/tools/theme-fidelity.mjs').then(m => { const res = m.evaluateUrlSafety([{ name: 'test', url: 'https://phukienmaymoc.com/?themeid=-1' }], ['1001512581']); if (res.gates[0].allowed === false && res.refusals.length > 0) { console.log('PASS: -1 refused by producer'); } else { console.error('FAIL: -1 allowed by producer'); process.exit(1); } })"
   ```
   *Expected Output:* `PASS: -1 refused by producer` (exit code `0`).

3. **Verify Generic Role Guard in `theme-push.ts`:**
   ```bash
   node -e "const fs = require('fs'); const src = fs.readFileSync('../Haravan CLI/src/commands/theme/theme-push.ts', 'utf8'); if (!src.includes('role === \"main\"') && !src.includes(\"role === 'main'\")) { console.error('FAIL: role check missing'); process.exit(1); } if (src.includes('Tiếp tục sửa theme LIVE?')) { console.error('FAIL: interactive prompt still present'); process.exit(1); } console.log('PASS: generic live role guard configured');"
   ```
   *Expected Output:* `PASS: generic live role guard configured` (exit code `0`).

4. **Verify Atomic Record Digest Contract:**
   ```bash
   node -e "import('./scripts/lib/atomic-record.mjs').then(m => { const d = m.textDigest('sample\r\ntext'); if (d.hashContract !== 'lf-normalized') process.exit(1); console.log('PASS: atomic-record digest contract verified'); })"
   ```
   *Expected Output:* `PASS: atomic-record digest contract verified` (exit code `0`).

---

## Risk

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Probe fails due to transient Haravan storefront network errors | Pre-flight exits non-zero, pausing verification | Low | Probe includes single retry with backoff. If storefront is down, run yields `INCONCLUSIVE` rather than scoring invalid diffs. |
| Developer runs `theme push --force` targeting live theme | Accidental live storefront overwrite | Low (after fix) | Unconditional generic role check executes before `--force` evaluation, terminating with exit code 1. |
| Removing `-1` breaks legacy canary invocations | Legacy scripts targeting `-1` fail closed | Low | All active canary runs configure explicit staging theme IDs; staging copy `1001512581` remains permitted. |

---

## Rollback

If Phase 00 changes need to be reverted:
1. Revert `E:/Work/apps/Haravan CLI/src/commands/theme/theme-push.ts` via git checkout to restore prompt-based live theme confirmation.
2. Revert `.canary/tools/theme-fidelity.mjs` via git checkout to restore legacy `PRODUCTION_THEME` handling.
3. Remove `plans/260912-1731-haravan-az-implementation-plan/phase-00-baseline-freeze-and-guards.md`.
