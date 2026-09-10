---
title: Restore Real Chromium Visual Fidelity Canary and Evidence Reporting
date: 2026-09-10
summary: "Recovered full-page evidence integrity, bounded compare transaction, Chromium smoke recovery, and completed Hoplongtech 15-page canary harness with zero false PASS claims."
---

# Restore Real Chromium Visual Fidelity Canary and Evidence Reporting

Recovered full-page evidence integrity, bounded compare transaction, Chromium smoke recovery, and completed Hoplongtech 15-page canary harness with zero false PASS claims.

## Problem
The visual compare pipeline suffered from capture integrity issues, timeout lock starvation during CDP stalls, and reporting scripts emitting false PASS or ungrounded assertions when runs failed or timed out.

## Changes
1. **Evidence Integrity**: Implemented raw PNG disk inspection verifying magic bytes (`89 50 4E 47 0D 0A 1A 0A`), IEND chunks, exact byte counts, and SHA256 hashes for all viewport artifacts.
2. **Bounded Compare Transaction**: Added two-stage timeout and reservation semantics with pre-dispatch cancellation and post-dispatch target quarantine/recovery.
3. **Chromium Smoke Suite**: Verified 26/26 tests across 4 focused suites ensuring no lock poisoning or authority leakage.
4. **Hoplongtech Canary Harness**: Built and hardened `.canary/tools/fifteen-pages-run.mjs` and `viewport-run.mjs`, producing `15-PAGE-HOPLONGTECH-CLONE-CANARY.md` driven 100% by real captured disk telemetry.

## Evidence
- All 6 raw PNG artifacts on disk verified valid (6/6 magic bytes, 6/6 IEND, 0 corrupt).
- Network audits verified 0 reference visual requests.
- Structural comparison accurately flagged clone missing cards and horizontal overflow on 390px mobile.
- Overall verdict: Defensible `INCONCLUSIVE` due to visual/layout mismatch between live reference and independent clone.
> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
