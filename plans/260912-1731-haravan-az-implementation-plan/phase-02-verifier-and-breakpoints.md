# Phase 02 — Verifier repair: fresh-diff dominance, breakpoints, degeneracy gate, run ledger
Status: BLOCKED_ON_PREDECESSOR
Depends on: 00

## Context
`scripts/verify-all-visual-compare.mjs` (247 lines) generated the historical artifacts `reports/visual-compare-45-cases.json` and `reports/VISUAL-COMPARE-15-PAGES-VERIFICATION.md` (addendum-03 §1). Those root files are immutable historical records and must remain read-only. Scouting and gate forensics verified two critical scoring defects:

1. **Defect D6 (Fail-open scoring, L193–200):** The script executes `effectiveMismatch = min(fresh, recorded)`. When fresh diff exists alongside a recorded value in `<vp>.json`, it selects the smaller value (L194–195), suppressing visual regressions. When fresh PNGs are absent, it falls back to `recordedMismatch` (L196–197) rather than reporting an unmeasured state.
2. **Defect D7 (Fail-open pass count, L220–225):** The script counts passes using `if (r.mismatchPercentage < 2.0) passCount++`. In JavaScript, `null < 2.0 === true` (`Number(null) === 0`). Unmeasured cases (`null`) increment the console pass count, producing totals that contradict the JSON status (addendum-03 §3).
3. **Viewport mismatch (L109, L206):** The script hardcodes `['1440', '1024', '390']`. The 1024px viewport (1024x900) is a desktop layout masquerading as tablet coverage. The client mandate requires `390 / 768 / 1440`.
4. **Degenerate comparison flaw (0.01% mobile cases):** Seven mobile cases (`page-02, 03, 04, 05, 08, 09, 10` at 390) report 0.01% mismatch with `dimsMatch: true` (addendum-03 §5). Inspection confirms zero PNGs existed in attempt evidence; the score was imported from a recorded JSON that had failed structural parity. Verifying captures requires provenance, decode validation, and content presence per `plan.md §4 Capture validity`. Arbitrary byte-size and entropy thresholds are excluded. Equal PNG hashes on valid rendered content are legitimate visual matches.
5. **Output isolation & run identity provenance:** Previous runs mutated root reports in place without cryptographically binding run metadata. Per controller directive, root historical reports are read-only. All new verification runs must write to isolated `reports/runs/<runId>/` directories and atomically publish `reports/run-identity-manifest.json`.

## Requirements
1. **Fresh-diff dominance (Fix D6):**
   - Delete `effectiveMismatch = min(fresh, recorded)` and remove all fallback to recorded `<vp>.json` values.
   - Only a fresh pixel diff computed from valid decoded PNG pairs produces a numeric mismatch score.
   - Missing or undecodable pairs yield `null` and force status `INCONCLUSIVE`.
2. **Null-safe pass counting (Fix D7):**
   - Neutralize `null < 2.0 === true`.
   - Increment `passCount` only when `r.status === 'PASS' && typeof r.mismatchPercentage === 'number' && r.mismatchPercentage < 2.0`.
   - Tally and print three distinct totals: `PASS`, `FAIL`, and `INCONCLUSIVE`.
3. **Breakpoint reconciliation (Client mandate 390 / 768 / 1440):**
   - Client mandate **390 / 768 / 1440** replaces `['1440', '1024', '390']` unconditionally.
   - 1024px captures are quarantined as legacy historical artifacts and never used as tablet substitutes.
   - Absent 768px captures evaluate to `mismatchPercentage: null` and `status: 'INCONCLUSIVE'`.
4. **Capture validity gate (plan.md §4 alignment):**
   - Enforce independent source/baseline provenance, verifiable file existence, successful PNG decode, and valid non-zero dimensions ($W > 0, H > 0$).
   - Reject unrendered blank-vs-blank captures where both images consist entirely of a single uniform pixel value indicating render failure.
   - Exclude arbitrary byte-size (<1024B) and entropy thresholds; permit legitimate identical PNG hashes (`refSha === cloneSha`) when content is valid.
5. **Run ledger and output isolation:**
   - Root historical artifacts (`reports/visual-compare-45-cases.json`, `reports/VISUAL-COMPARE-15-PAGES-VERIFICATION.md`) are strictly read-only.
   - Every run allocates a distinct `runId` and writes artifacts into `reports/runs/<runId>/`:
     - `reports/runs/<runId>/run-identity-manifest.json`
     - `reports/runs/<runId>/visual-compare-cases.json`
     - `reports/runs/<runId>/VISUAL-COMPARE-VERIFICATION.md`
   - Atomically publish the run manifest to `reports/run-identity-manifest.json` via `writeRecordAtomic` from `scripts/lib/atomic-record.mjs`.
   - Manifest entry tuple: `{ runId, store: 'phukienmaymoc.com', orgId: '200001207485', themeId: '1001512581', route, viewport, referenceSha256, captureSha256, hashContract: HASH_CONTRACT.BYTE_EXACT, timestamp }`.

## Files
| Path | Action | Why |
|---|---|---|
| `scripts/verify-all-visual-compare.mjs` | edit | Primary visual comparison script: enforce fresh-diff dominance (D6), fix pass counting (D7), switch viewports to 390/768/1440, add capture validity gate, and route outputs to `reports/runs/<runId>/`. |
| `scripts/lib/atomic-record.mjs` | read | Import `writeRecordAtomic`, `sha256File`, and `HASH_CONTRACT` for atomic manifest publishing. |
| `reports/visual-compare-45-cases.json` | read | Historical root report; preserved read-only. |
| `reports/VISUAL-COMPARE-15-PAGES-VERIFICATION.md` | read | Historical root markdown report; preserved read-only. |
| `reports/run-identity-manifest.json` | create | Current-run manifest pointer recording identity tuple `{runId, store, orgId, themeId, route, viewport, referenceSha256, captureSha256, hashContract, timestamp}`. |
| `reports/runs/<runId>/` | create | Run-scoped directory holding immutable run manifest, case-level JSON, and markdown report. |

## Steps
1. **L1–4 (Imports):** Import `crypto` and `{ writeRecordAtomic, sha256File, HASH_CONTRACT }` from `./lib/atomic-record.mjs`.
2. **L104+ (Capture validity helper):** Add `evaluateCaptureValidity(pngA, pngB, refPath, clonePath)` verifying:
   - Successful decode and non-zero dimensions ($W > 0, H > 0$).
   - Non-blank content: reject blank-vs-blank captures where both images consist entirely of a uniform single-color pixel value.
   - Permit legitimate identical image hashes (`refSha === cloneSha`) on content-bearing images. No arbitrary byte-size or entropy thresholds.
3. **L109, L123, L206 (Viewport configuration):**
   - Update `viewports` at L109 to `['1440', '768', '390']`.
   - Update attempt filename regex at L123 to match `^(1440|768|390)\.json$`.
   - Update viewport label mapping at L206 to output `768x1024 (Tablet)`.
4. **L165–181 (Remove recorded fallback):** Delete the block reading `vpJson` and populating `recordedMismatch`. Do not import or score recorded mismatches.
5. **L183–201 (Fresh-diff dominance):** Replace the min-selection logic:
   - Compute `sha256File` for available PNGs.
   - If PNGs exist and pass `evaluateCaptureValidity`, compute `diffResult = calculatePixelDiff(a, b)`.
   - If `diffResult !== null`, set `effectiveMismatch = diffResult.mismatchPercentage` and `status = effectiveMismatch < 2.0 ? 'PASS' : 'FAIL'`.
   - If capture validity fails, files are missing, or decode errors occur, set `effectiveMismatch = null` and `status = 'INCONCLUSIVE'`.
6. **L219–225 (Null-safe pass tally):**
   - Count passes strictly via `r.status === 'PASS' && typeof r.mismatchPercentage === 'number' && r.mismatchPercentage < 2.0`.
   - Tally `failCount` and `inconclusiveCount` explicitly.
   - Print the three-state summary: `PASS: <count> | FAIL: <count> | INCONCLUSIVE: <count> / <total>`.
7. **L227–245 (Output isolation to `reports/runs/<runId>/`):**
   - Initialize `runId = 'run-' + crypto.randomUUID()` and `runTimestamp = new Date().toISOString()`.
   - Create output directory `reports/runs/<runId>/`.
   - Construct manifest records containing `{ runId, store: 'phukienmaymoc.com', orgId: '200001207485', themeId: '1001512581', route: r.page, viewport: r.vpLabel, referenceSha256, captureSha256, hashContract: HASH_CONTRACT.BYTE_EXACT, timestamp: runTimestamp }`.
   - Write `reports/runs/<runId>/visual-compare-cases.json`, `reports/runs/<runId>/VISUAL-COMPARE-VERIFICATION.md`, and `reports/runs/<runId>/run-identity-manifest.json`.
   - Atomically publish `reports/run-identity-manifest.json` via `writeRecordAtomic`.
   - Do NOT overwrite root `reports/visual-compare-45-cases.json` or `reports/VISUAL-COMPARE-15-PAGES-VERIFICATION.md`.

## Validation
1. **D6 validation (Fresh-diff dominance):** Run test where fresh diff is 4.5% and recorded is 0.5%. Verify result records 4.5% (`FAIL`), never 0.5% (`PASS`). Confirm missing PNGs evaluate to `mismatchPercentage: null` and `status: 'INCONCLUSIVE'`.
2. **D7 validation (Null arithmetic trap):** Run test batch with 1 PASS (1.2%), 1 FAIL (3.4%), and 1 unmeasured (null). Verify output prints `PASS: 1, FAIL: 1, INCONCLUSIVE: 1`, confirming `null < 2.0` cannot increment `passCount`.
3. **Viewport reconciliation (390 / 768 / 1440):** Verify script checks 1440, 768, and 390. Confirm legacy 1024 evidence is ignored.
4. **Capture validity gate:** Verify unrendered blank-vs-blank frames trigger `INCONCLUSIVE`. Verify identical PNG hashes on valid rendered content evaluate honestly as `PASS` (0.00% mismatch).
5. **Output isolation & ledger integrity:** Confirm root historical files (`reports/visual-compare-45-cases.json`, `reports/VISUAL-COMPARE-15-PAGES-VERIFICATION.md`) remain unmodified. Verify output directory `reports/runs/<runId>/` contains all run artifacts and `reports/run-identity-manifest.json` correctly reflects the current run tuple.

## Risk
1. **Reported pass rate collapse:** Reported pass rates will drop from the historical unsupported claim of 100% (or 29/45) to the truthful rate (~8 PASS / 45).
   - *Mitigation:* Calibrate stakeholders per plan.md §5; a first honest run must fail or be inconclusive.
2. **Immediate inconclusive status for 768px:** Because historical runs only captured 1024px, all 15 cases at 768px will initially evaluate to `INCONCLUSIVE`.
   - *Mitigation:* Expected behavior; fresh 768px captures will be collected in Phase 07.

## Rollback
1. Revert edits to `scripts/verify-all-visual-compare.mjs` via `git checkout HEAD -- scripts/verify-all-visual-compare.mjs`.
2. Remove any uncommitted run directory: `rm -rf reports/runs/<runId>` and `rm -f reports/run-identity-manifest.json`.
3. Note: Never roll back to restore `min(fresh, recorded)` or bypass the null check; preserve fail-closed scoring invariants.
