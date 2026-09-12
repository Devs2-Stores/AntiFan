# Phase 07 — Live Verification Loop and Terminal Verdicts
Status: BLOCKED_ON_PREDECESSOR
Depends on: 01, 02, 03, 06, 08B

## Context

Phase 07 owns the orchestration of the live storefront verification loop and terminal verdict adjudication for the Haravan A→Z implementation plan.

Key boundaries from authoritative `plan.md`:
1. Three-Tier Separation: The unbranded Base Theme (Phase 06) provides brand-neutral ecommerce foundations and settings. Reference visual fidelity (<2% mismatch against `hoplongtech.com`) is evaluated strictly against the **Project Theme** (adapted in Phase 08B), which applies project-specific styling, typography, and data bindings. Demanding pixel parity on the Base Theme is prohibited.
2. Ownership Boundary: Phase 07 owns the verification orchestrator and final verdict consolidation. It does not duplicate work owned by predecessors: fail-closed scoring mechanics belong to Phase 01; fresh-only diffing and breakpoint matrix belong to Phase 02; theme attestation, measured viewports, and full-page coverage belong to Phase 03; Project Theme implementation and accessibility belong to Phase 08B.
3. Identity & Diagnostics: `scripts/probe-theme-identity.mjs` is a diagnostic tool only. Raw HTML hash differences do not establish theme identity because server responses contain dynamic antiforgery tokens and timestamps. True identity requires multi-factor attestation (store/org match, verified unpublished staging role, API theme/asset identity corroboration, and session cookie `preview_theme_id` set via `?themeid=1001512581`).
4. Viewport & Content Bounds: Viewport emulation attestation records actual `innerWidth`, `clientWidth`, `visualViewport`, DPR, and raster dimensions. `docWidth = 1905` in historical records confirms recorded layout overflow and insufficient viewport attestation, not that emulation was never applied. Equal heights, text lengths, or equal PNG hashes can be legitimate for static sections; arbitrary inequality or entropy thresholds are prohibited.
5. Catalog Safety & Data Ownership: Catalog data is shared store-wide on Haravan; unpublished staging themes do not isolate products or pages from production. Existing catalog data must be reused first. Entity creation requires explicit operator approval, and all created entities must have exact IDs recorded in the run ledger. Blanket deletion by prefix across the store is prohibited; cleanup operates strictly on approved, tracked IDs.
6. Baseline & Expected Outcome: Historical campaign results (8 PASS, 17 FAIL, 20 INCONCLUSIVE in `reports/fidelity-campaign-matrix.json`) provide context but do not forecast post-remediation pass rates. A green run is not inherently a bug; it is accepted if and only if complete, independent receipts are verified across all gates.

## Requirements

1. Pre-Flight Execution Sequence:
   - Diagnostic Probe: Run `scripts/probe-theme-identity.mjs` as a pre-flight connectivity and parameter probe. Failure to connect or invalid response yields `INCONCLUSIVE`.
   - Multi-Factor Theme Identity Attestation: Corroborate store (`phukienmaymoc.com`), org (`200001207485`), target theme ID (`1001512581`), unpublished role, and asset CDN path (`/1001512581/`). Missing credentials or unverified identity yields `INCONCLUSIVE`.
   - Staging Containment: Enforce that all write operations strictly target `1001512581`. Any attempted remote mutation, push, or publish to live theme `1001510509` immediately triggers `SECURITY_ABORT`.
   - Sync Attestation: Baseline terminal cursor must be captured prior to mutation. Remote synchronization must be attested via `HaravanSyncBarrier` before reload. Failure yields `INCONCLUSIVE`.

2. Verification Loop Execution:
   - Route Scope: Ingest the approved route manifest locked in Phase 08B. Do not hardcode legacy route counts.
   - Viewport Surface: Execute full-page evaluation at mandatory breakpoints: Mobile ($390 \times 844$, mobile: true), Tablet ($768 \times 1024$, mobile: false), Desktop ($1440 \times 900$, mobile: false). Optional $1024 \times 900$ serves only as supplemental coverage.
   - Landmark & Overflow Assertion: Record actual `innerWidth`, `clientWidth`, and raster dimensions. Layout exceeding target viewport width is recorded as layout overflow. Full-page capture must verify materialization completion and header/main/footer landmarks.
   - Fresh-Only Scoring: Diff scores must be computed fresh from runtime captures against locked reference baselines. Missing, NaN, infinite, or null diffs yield `INCONCLUSIVE`. Equal image hashes or metrics are permitted when legitimate.

3. Tracked Entity Lifecycle:
   - Reuse existing catalog products, custom collections, and pages before creating data.
   - Any required entity creation requires operator approval and must record exact IDs in the run ledger.
   - Teardown operates strictly on approved tracked IDs from the ledger. Wildcard prefix deletion across the store is prohibited.

4. Deterministic Terminal Verdicts:
   - `FINAL_PASS` (Display: `FINAL PASS`): 100% of cases in the locked route manifest achieve valid measurements meeting visual fidelity (<2% mismatch on Project Theme), layout bounds, landmark completeness, functional flows, zero Hoplong asset/domain leaks, and clean tracked entity reconciliation.
   - `FAIL`: Any case with valid, reliable measurement fails behavior, fidelity, layout bounds, landmark structure, or quality criteria.
   - `INCONCLUSIVE`: Any case with missing, null, NaN, or infinite measurements; unverified theme identity; reference drift; corrupt capture; missing credentials; or unfulfilled sync/settle dependencies. `INCONCLUSIVE` cannot convert to PASS and halts certification.
   - `SECURITY_ABORT`: Attempted unauthorized mutation, push, publish, or destructive write operation on protected live theme `1001510509` or unauthorized write targets. Read-only observation of live state is permitted and does not trigger abort.

## Files

| path | action | why |
|---|---|---|
| `scripts/run-haravan-verification-loop.mjs` | create | Verification orchestrator executing pre-flight checks, Project Theme test matrix, and verdict ledger sealing |
| `reports/storefront-verification-verdict.json` | create | Sealed terminal verdict ledger recording run receipts, case outcomes, and terminal status |
| `reports/fixture-teardown-receipt.json` | create | Receipt recording status and cleanup confirmation for approved, run-tracked entity IDs |
| `reports/fidelity-campaign-matrix.json` | read | Route structure, failure taxonomy, and historical baseline reference |
| `scripts/probe-theme-identity.mjs` | read | Pre-flight diagnostic network and cookie probe (diagnostic only) |
| `scripts/deploy-copy-theme.mjs` | read | Reference for staging deployment containment assertions (`TARGET_THEME_ID = 1001512581`) |
| `scripts/lib/atomic-record.mjs` | read | Primitives for atomic record persistence and SHA-256 ledger sealing |

## Steps

1. Lock Campaign Configuration and Route Manifest:
   - Ingest approved route manifest and comparator configuration from Phase 08B.
   - Set execution target to staging theme `1001512581` on `phukienmaymoc.com` (org `200001207485`).
   - Define mandatory breakpoint triplets: 390 (mobile), 768 (tablet), 1440 (desktop).

2. Pre-Flight Diagnostics and Theme Identity Corroboration:
   - Execute diagnostic pre-flight via `scripts/probe-theme-identity.mjs`. If host unreachable or HTTP error, halt with `INCONCLUSIVE`.
   - Validate multi-factor identity: corroborate unpublished role, API theme identity, and asset CDN path. If credentials missing or identity unverified, halt with `INCONCLUSIVE`.
   - Validate write containment guard: assert target is `1001512581` and strictly forbid `1001510509`.

3. Pre-Mutation Cursor Capture and Sync Attestation:
   - Capture baseline terminal cursor from Theme CLI watcher before any file modification.
   - Await remote synchronization acknowledgment via `HaravanSyncBarrier.awaitSync` and advance document generation via `awaitReloadAndSettle`.
   - If sync barrier or document reload times out, mark step `INCONCLUSIVE`.

4. Execute Full-Page Storefront Captures:
   - Iterate through routes in the locked manifest across 390, 768, and 1440 viewports.
   - Apply CDP viewport emulation and record actual `innerWidth`, `clientWidth`, and raster dimensions.
   - Trigger scroll materialization to capture complete document height and verify header, main, and footer landmarks.
   - Evaluate pre-capture quiescence (fonts, images, layout stability). If quiescence fails, record case as `INCONCLUSIVE`.

5. Fresh Pixel Diff and Functional Gate Evaluation:
   - Perform fresh pixel comparison between Project Theme captures and locked reference captures.
   - Flag layout overflow as `FAIL` if content width exceeds target viewport width.
   - Flag visual mismatch ≥ 2.0% as `FAIL`.
   - Flag missing landmarks, broken assets, Liquid syntax errors, or Hoplong domain leaks as `FAIL`.
   - If measurement is missing, null, NaN, or capture buffer is unreadable, record case as `INCONCLUSIVE`.
   - Legitimate identical image hashes or equal metrics across viewports are accepted and evaluated normally.

6. Tracked Entity Reconciliation and Approved Teardown:
   - Verify all entities created during run match approved tracked IDs in the ledger.
   - Execute approved deletion strictly for tracked IDs. Do not execute wildcard prefix deletions.
   - Emit `reports/fixture-teardown-receipt.json` confirming zero orphan entities remain from the run.

7. Terminal Verdict Adjudication and Ledger Sealing:
   - Consolidate case results across the locked manifest.
   - Assign terminal verdict: `FINAL_PASS`, `FAIL`, `INCONCLUSIVE`, or `SECURITY_ABORT` according to deterministic gate rules.
   - Write immutable run record to `reports/storefront-verification-verdict.json` using `writeRecordAtomic` from `scripts/lib/atomic-record.mjs`, sealed with SHA-256 digest.

## Validation

1. Pre-Flight Diagnostic Probe Validation:
   - Execute `node scripts/probe-theme-identity.mjs https://phukienmaymoc.com 1001512581 1001510509`.
   - Confirm probe completes with exit code 0 and logs diagnostic parameters without treating raw HTML diff as identity proof.

2. Security Abort Validation:
   - Test write guard by simulating mutation targeting live theme `1001510509`.
   - Verify orchestrator immediately terminates with `SECURITY_ABORT` and executes no remote requests.

3. Missing Credentials / Inconclusive Gate Validation:
   - Test orchestrator with missing Haravan API token.
   - Verify orchestrator exits with `INCONCLUSIVE` (not `SECURITY_ABORT` and not `PASS`).

4. Viewport Layout Overflow Assertion Validation:
   - Probe viewport metrics under constrained width. Confirm layout exceeding viewport bound produces explicit `FAIL` for overflow while recording actual measured dimensions.

5. Ledger Sealing and Teardown Validation:
   - Verify `reports/storefront-verification-verdict.json` is written atomically with complete run metadata and SHA-256 seal.
   - Verify `reports/fixture-teardown-receipt.json` records zero remaining tracked orphans without performing store-wide prefix deletion.

## Risk

1. Production Theme Contamination:
   - Risk: Accidental upload, mutation, or publish targeting live production theme `1001510509`.
   - Mitigation: Hard-coded security gate strictly confines all writes to `TARGET_THEME_ID = 1001512581` and immediately triggers `SECURITY_ABORT` on any live theme write attempt.

2. Shared Catalog State Mutation:
   - Risk: Creation or deletion of store catalog entities affecting live storefront operations.
   - Mitigation: Require existing data reuse first; require operator approval for entity creation; restrict cleanup strictly to tracked ledger IDs; prohibit wildcard prefix deletion.

3. Reference Site Unavailability or Drift:
   - Risk: Changes or downtime on external reference `hoplongtech.com` during verification run.
   - Mitigation: Compare against locked reference baselines; any detected reference baseline hash change marks affected cases `INCONCLUSIVE` (reference drift).

4. Network & Rate Limiting:
   - Risk: HTTP 429 Too Many Requests during automated route probing.
   - Mitigation: Enforce bounded request spacing and exponential backoff on API calls.

## Rollback

1. Security Abort Rollback:
   - On `SECURITY_ABORT`, immediately terminate all running processes and inspect live theme status to confirm zero remote changes occurred.

2. Tracked Entity Rollback:
   - If verification run terminates unexpectedly, run approved cleanup targeting only the ledger's recorded entity IDs to restore catalog to pre-run state.

3. Staging Theme Rollback:
   - Restore only from a freshly verified backup of the exact approved unpublished theme, with explicit remote-write approval. Do not assume themes/phukienmaymoc-copy is clean; historical audit records contamination.

4. Orchestrator Script Rollback:
   - Revert only owned changes using an approved recovery operation that preserves user work; no blanket checkout.
