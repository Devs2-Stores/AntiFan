# AntiFan Visual Verification + Codebase Adversarial Audit v5 — Grounded Evidence Packet

**Document ID:** `antifan-visual-audit-v5-evidence-packet-2026-09-06`  
**Primary Source:** `E:\Download\AntiFan-Visual-Verification-Codebase-Adversarial-Audit-v5-2026-09-06.md` (1,742 lines, Adversarial Audit v5)  
**Target Repository:** `Devs2-Stores/AntiFan` (`E:\Work\apps\antifan-browser-desktop`)  
**Verified Git HEAD:** `dd33cf67828613ac4401c19f1d6676d9d7c56669` (Matches Audited HEAD; `src/` tree uncommitted changes = 0)
**Host Workstation Environment:** Windows 11 Pro x64 (10.0.22000), Intel Core i5-9300H @ 2.40GHz (4C/8T), Intel UHD Graphics 630, 16–32 GB RAM, VSCode, single developer workflow (Sapo / Haravan / Shopify theme engineering + OMP / Agent CLI runtime).

---

## 1. Codebase Validation Against HEAD `dd33cf6`

Findings P0-1 through P0-5 and P1-1 were directly inspected and validated against `src/main/tools/browser-control-port.ts` in this session. Findings P1-2 through P1-4 are cited directly from Audit v5:

| Audit Finding | Code Location | Session Observation (HEAD `dd33cf6`) | Status |
|---|---|---|---|
| **P0-1: Coordinate Space Mismatch** | `browser-control-port.ts:2416-2419, 2575` | `el.getBoundingClientRect()` CSS viewport coords (`r.x, r.y`) passed directly to `computePixelDiff` at line 2575 without affine transform for crop origin, scroll offset, or DPR. | **Directly Inspected (Confirmed Defect)** |
| **P0-2: Fail-Open Mask Resolution** | `browser-control-port.ts:2410-2430` | `maskSelectors` wrapped in empty `try { ... } catch {}`. Syntax errors or missing elements silently default to `maskBoxes = []`, comparing unmasked. | **Directly Inspected (Confirmed Defect)** |
| **P0-3: Asymmetric Masks on Comparison Tab** | `browser-control-port.ts:2408-2430, 2493-2538` | Masks extracted only on `tabId` (lines 2408-2430). Tab B (`compTabId`) is never queried for local masks; Tab A's mask geometry is blindly stamped. | **Directly Inspected (Confirmed Defect)** |
| **P0-4: `normalizeScroll` Style Leak** | `browser-control-port.ts:2394-2405` | Injects `<style id="__antifan_normalize_scroll">` with no cleanup or `finally` block in `visualCompare()`, leaking layout mutations into DOM. | **Directly Inspected (Confirmed Defect)** |
| **P0-5: Lack of Coherence Transaction** | `browser-control-port.ts:2368-2590` | Zero pre/post capture checks on `browserEpoch`, `documentGeneration`, or `mutationRevision` (unlike `observe()` at lines 726-800). | **Directly Inspected (Confirmed Defect)** |
| **P1-1: Tab B Not Locked Jointly** | `browser-control-port.ts:2393` | Only `tabId` acquires `passivePool.execute()`. Comparison tab `compTabId` is read without joint resource locking. | **Directly Inspected (Confirmed Defect)** |
| **P1-2: Capture Backend Variance** | `tab-devtools-host.ts:316-430` | Cited from Audit v5: Tiered fallback between `webContents.capturePage()` and CDP `Page.captureScreenshot` lacks backend recording. | *Cited from Audit v5 (Pending direct session inspection)* |
| **P1-3: Baseline Scope Coupling** | `artifact-store.ts:16-160` | Cited from Audit v5: `readBytesById` restricted to current `{ runId, attemptId }`, blocking durable cross-attempt regression baselines. | *Cited from Audit v5 (Pending direct session inspection)* |
| **P1-4: Ad-Hoc Settle Logic** | `theme-qa-workflow.ts:200-240` | Cited from Audit v5: Settle relies on arbitrary timeouts rather than composed network, font, image, and DOM quietness gates. | *Cited from Audit v5 (Pending direct session inspection)* |
---

## 2. Core Architecture Invariants & Decisions

1. **Rejection of Standalone "Visual Verification Engine":**
   - Audit v5 firmly rejects building a new parallel verdict engine (the v4 proposal).
   - AntiFan ALREADY has `src/main/verification/verification-evaluator.ts` (`VerificationEvaluator`, `ProofObligation`, `MetricSample`, `EvidenceSampleBundle`).
   - `visualCompare` MUST emit structured `MetricSample[]` items (`visual.pixel_mismatch_pct`, `visual.dimensions_match`, `visual.geometry_within_tolerance`, `visual.cardinality_match`, etc.). `VerificationEvaluator` remains the single source of truth.
2. **Role Division:**
   - **AntiFan Core:** Deterministic observation, canonical coordinate mapping, scoped normalization, fail-closed mask accounting, and mechanical telemetry collection.
   - **OMP / Agent CLI:** Task definition, intent framing, reasoning, and high-level strategy selection.
3. **Structural Primacy Over Paint Normalization:**
   - E-commerce storefronts legitimately vary dynamic paint (prices, stock counts, countdown timers, promo badges, recommendations).
   - Dynamic pixels may be masked, but underlying layout geometry (bounding boxes, aspect ratios, grid cardinality, overflow) MUST remain authoritative. A visual regression hidden behind a dynamic mask MUST be caught and rejected by structural proof obligations.
4. **Sapo-First Product Priority:**
   - Shift from generic browser sprawl to the solo Sapo theme development loop (`SapoPlatformDriver`, CLI sync attestation, store identity protection).

---

## 3. Discriminating Test Matrix (V-01 to V-25)

The implementation contract MUST commit to satisfying the 25 discriminating test gates:
- **V-01:** Missing required mask selector $\to$ `INCONCLUSIVE / MASK_RESOLUTION_FAILED` (never silent pass).
- **V-02:** Invalid selector syntax (`div[`) $\to$ explicit mask error.
- **V-03:** Selector crop offset: dynamic element inside cropped selector with non-zero origin $\to$ raster mask lands precisely.
- **V-04:** `clipRect` offset: explicit clipRect $\to$ raster mask lands precisely.
- **V-05:** Full-page capture + `scrollY > 0` $\to$ dynamic element uses document-coordinate position.
- **V-06:** `deviceScaleFactor = 2` $\to$ CSS-to-raster transform masks exact pixels.
- **V-07:** `zoom = 1.25` $\to$ deterministic coordinate mapping or explicit incompatible-state verdict.
- **V-08:** Independent comparison-tab masks: different coordinate/width for same dynamic selector in A and B $\to$ both normalized independently.
- **V-09:** Geometry regression hidden behind dynamic paint (parent height +100px) $\to$ `REJECTED` by structural proof obligation.
- **V-10:** Cardinality regression (grid 4 $\to$ 3 items with masked card bodies) $\to$ `REJECTED`.
- **V-11:** `normalizeScroll` cleanup: `#__antifan_normalize_scroll` absent after successful compare.
- **V-12:** `normalizeScroll` cleanup on exception: cleanup guaranteed in `finally`.
- **V-13:** Asymmetric normalization failure $\to$ `INCONCLUSIVE`, pixel comparison aborted.
- **V-14:** DOM mutation between mask resolution and screenshot $\to$ `RESAMPLE`.
- **V-15:** Navigation during compare (advance `documentGeneration`) $\to$ `TARGET_STALE / INCONCLUSIVE`.
- **V-16:** Font swap / delayed webfont $\to$ bounded settle wait, no arbitrary false diff.
- **V-17:** Visible image decode delay $\to$ relevant-image gate awaits decode.
- **V-18:** Broken image $\to$ explicit resource failure, not masked pass.
- **V-19:** Background tab capture $\to$ canonical backend with equivalent state receipt.
- **V-20:** Backend consistency $\to$ verification mode never switches backends between baseline and current.
- **V-21:** Baseline state mismatch (e.g. DPR 1 vs DPR 2) $\to$ `INCONCLUSIVE / CAPTURE_STATE_MISMATCH`.
- **V-22:** Cross-attempt promoted baseline $\to$ verified through promoted immutable baseline authority.
- **V-23:** Masked-area ratio abuse (> 70% masked) $\to$ `INCONCLUSIVE` policy rejection.
- **V-24:** 3-run static determinism $\to$ identical state, receipts, and verdicts; zero leftover styles.
- **V-25:** Real Sapo-oriented workflow proof: theme edit $\to$ CLI sync $\to$ document generation advance $\to$ settle $\to$ compare $\to$ verified evidence receipt.

---

## 4. 18-Point Freeze Checklist (Audit v5 Section 26)

```text
[ ] 1. required masks fail closed (V-01, V-02)
[ ] 2. mask boxes use canonical CSS→raster transform (V-03, V-04, V-05, V-06, V-07)
[ ] 3. selector/clip masking tested with non-zero origins (V-03, V-04)
[ ] 4. full-page + scroll masking tested (V-05)
[ ] 5. DPR/zoom behavior tested (V-06, V-07)
[ ] 6. target and comparison masks resolve independently (V-08)
[ ] 7. target + comparison capture identity coherent (V-14, V-15)
[ ] 8. normalizeScroll restored in finally (V-11, V-12)
[ ] 9. normalization symmetry is verified (V-13)
[ ] 10. verification capture backend is recorded/canonical (V-19, V-20)
[ ] 11. capture-state compatibility checked before pixel verdict (V-21)
[ ] 12. network/fonts/relevant-images/DOM settle produces explicit receipt (V-16, V-17, V-18)
[ ] 13. geometry/cardinality survive pixel normalization (V-09, V-10)
[ ] 14. visual metrics flow into VerificationEvaluator (V-09, V-10)
[ ] 15. baseline promotion across attempts is explicit and checksum-bound (V-22)
[ ] 16. static capture is deterministic across repeated runs (V-24)
[ ] 17. background tab proof passes (V-19)
[ ] 18. real Sapo-oriented theme workflow proof passes (V-25)
```

---

## 5. Modular Implementation Target (`src/main/visual/`)

```text
src/main/visual/
├── visual-types.ts             # CaptureIdentity, VisualPairIdentity, receipts, options
├── visual-space.ts             # VisualCaptureSpace: CSS viewport -> Document/Clip -> Raster matrix
├── mask-ledger.ts              # MaskLedger: fail-closed query, bounds validation, ratio guards
├── capture-transaction.ts      # withVisualCaptureTargets lock + NormalizationTransaction
├── capture-coherence.ts        # TwoSourceCoherenceGuard (epoch, generation, mutation revision)
├── capture-settle.ts           # CaptureSettleGate (first-party network, fonts, images, DOM quietness)
├── baseline-authority.ts       # Workspace-scoped VisualBaselineRef & checksum verification
└── visual-compare-runner.ts    # Orchestrator integrating all components into BrowserControlPort
```
