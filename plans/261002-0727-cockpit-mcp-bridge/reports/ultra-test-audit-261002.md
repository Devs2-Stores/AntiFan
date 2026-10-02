# Ultra test audit — pending cockpit diff (5 candidates + verifier)

**Verdict: CONDITIONAL GO — suite is structurally blind to the review's worst defects.** All 22 substantive claims validated, 0 rejections, AU23 (re-pins legitimate) confirmed. Union: `.scratch/ultra-audit-union.md`. Verifier: `agent://AuditVerifier`.

## Critical test-suite defects

- **AU1** — toolbar IPC lane dark at every tier: `theme-checklist-studio.test.ts` stub omits the 3 checklist APIs → latch to localStorage; review findings A,F,G,H,R,P unreachable.
- **AU2** — no gate verifies `filesToCopy` covers consumed assets; dirty `.compiled` ships stale standalone today (8315 vs 8197 lines live in tree).

## Important

AU3 (navigateAndWait never fails → D sails), AU5 (no provisional fixture → C,E unreachable), AU8 (missing-base CAS blessed mislabeled), AU9 (same-ms CAS unexercised), AU4 (params.tabId never dispatched → L unexercised), AU13 (pairing `!body.tabId` tautological), AU15 (pet zero behavioral coverage), AU6 (parity-gate cockpit stub written-to-pass), AU7 (fake-omp-mcp parity broken), AU10 (corrupt≠absent pinned ambiguous), AU12 (no checklist route-harness case → B untested), AU14 (precedence test wrong order → Q sails), AU11 (sweep test requires defect O).

## Minor

AU19–22 + AU16–18: provisional host CAS, registry subset assertion, mint-leg replay, push-channel static-only, IDLE_MS asymmetric pin, stray untracked .js shadows in test/.

## Advisor order (kongming)

1. Reconcile defect-enshrining tests first (AU8, AU10, AU11) — they lie under repair.
2. A: AU1 stub extension → red two-saves-one-RTT → fix `toolbar.ts:871`.
3. D: AU3 red → fix `cockpit-capabilities.ts:310`.
4. B: AU12 route-harness red → confine workspaceRoot in LOAD/SAVE routes.
5. E: fix-first + paired characterization test (no honest seam today).
6. M: interleaved — the consumed-asset gate IS the regression test; delete stale `.compiled/src/renderer/standalone.*` now.
