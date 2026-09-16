# Code Review — pending changes (ak:code-review --pending --ultra)

Date: 2026-09-16 · Mode: best-of-5 verifier (same-tier — runtime cannot route per-subagent model tiers; independent samples + rubric selection, not asymmetric verification).

## Scope

Full pending diff: 22 modified + 7 untracked files (~2,300 lines). Session work: OSR capture crash fix, crash forensics/intake/retention, hidden-window NO_RENDER_SURFACE refusal, capture-settle rework, CLI coverage, test hermeticity, site-clone improvements, misc.

## Process

- Stage 1 spec-compliance: controller pass over diffstat — all changes in scope, no unjustified extras.
- Stage 2: five independent read-only reviewers (anonymized A–E for the verifier; mapping: A=RevC, B=RevA, C=RevE, D=RevB, E=RevD).
- Verifier: kongming — evidence-validated every finding against real source; 0 hard drops; 2 mechanism corrections; 1 severity downgrade.
- Candidate scores: B=18, C=18, A=17, D=16, E=16 (B/C lead on evidence depth — real-dump verification, empirical parser probes).

## Union findings: 8 IMPORTANT + 28 MINOR → all 8 IMPORTANTs fixed + 20 MINORs fixed

### IMPORTANT — all fixed and verified

| # | Finding | Fix |
|---|---------|-----|
| 1 | `attachment-registry.ts` heartbeat renewals not persisted → ATTACHMENT_STALE after restart for live owners | Drift-threshold persistence (`RENEWAL_PERSIST_THRESHOLD_MS=60s` + `lastPersistedExpiresAt` map); ~60× fewer appends than persist-every-heartbeat |
| 2 | `capture-settle.ts` consecutive-pair-only layout convergence → monotonic sub-tolerance growth admitted while still growing | Cumulative `|first−last|` check added; `layoutDriftPx` reports max(pairwise, cumulative) |
| 3 | `capture-settle.ts` mid-window `readSample` failure → refusal blaming unobserved movement | Treated as inconclusive (judge last good pair); distinct early-end reason |
| 4 | `crash-report-intake.test.ts` fixture wrote relative dictionary offsets → `readAnnotations` dead code in suite | Absolute RVAs; new dictionary-only test with strings outside pool-scan window |
| 5 | `index.ts` prune ran unconditionally after failed intake → unnamed deaths | `CrashReportIntakeResult.completed` gates prune; intake/prune hoisted to own try |
| 6 | `crash-dump-forensics.ts` stale 32-bit header docs + ungated `stream.size` | Docs rewritten to 64-bit record; `readException` returns null unless `size >= 168` |
| 7 | `independent-html-clone-generator.ts` overlay parity CSS lacked `!important` → inline `display:flex` beats the rule | `!important` on all four declarations; test asserts each |
| 8 | `asset-localizer.ts` bare path+query map key → cross-origin asset collision | Path key registered only when unique across selectedItems; test 6.16b proves it |

### MINOR — fixed in the same pass (20)

capture-settle: rotatedImages position-free identity, multiset movingWitness, real observation count in reason, raw-size ±4px compare (snap grid removed), ≤2px beacon exemption extended to pending/broken.
forensics/intake: readModules bounds check, crash-key pool pairing guard, relative-path dedupe + strict errorCode filter, module-name sanitization + basename headline, deferred→discarded rename, retention-test temp cleanup.
site-clone: iframe data-src comment narrowed (generic click-to-load impossible — about:blank iframe clicks never reach parent), scroll-lock regex rewrite preserving quote char, `Number.isFinite(zIndex) && >=40` gate, `body > *` selector, `&#39;`/`&#x27;` decode, quoted-aware tagEnd scan.
misc: `replay`/`observe` arg coercion + usage errors, smoke script indentation, CHANGELOG overclaims corrected, `.tmp-cap-parity.cjs` moved to `.tmp-af-hub-audit/cap-parity.cjs` (gitignored).
Extra: `isWindowRenderable` re-check added immediately before `Page.captureScreenshot` dispatch (closes mid-capture hide → 60s hang residual).

### Open MINORs (accepted, documented)

- `clones/comnieuthienly/index.html` still embeds GTM + Facebook Pixel beacons — generated artifact, not source; sanitizer tracker-pattern extension is a separate feature decision.
- `package.json` e2e `--test-concurrency=1` masks a latent shared-state bug (`theme-golden-live.test.ts` fixed report path) — accepted; per-run report paths would make serialization a choice.
- Same-size image swap passes `imageIdentityStable` — documented-as-intentional in code; disclosed via `warnings.rotatedImages`.

## Final verification

- `npm run compile` — clean.
- `npm run test:unit` — 963/968 pass, 0 fail, 5 skip.
- `npm run test:main` — 1242/1244 pass, 0 fail, 2 skip.
- `node scripts/run-electron.cjs .tmp-af-hub-audit/cap-parity.cjs gpu-on` — all rows OK/typed-refusal; hidden/verify-fullpage NO_RENDER_SURFACE in 4ms.
- `node --test test/unit/bridge-receipt-coverage.test.mjs` — pass.
- site-clone suite — 475/475 pass.

## Artifacts

- Evidence packet: `.tmp-af-hub-audit/review-packet.md`
- Candidate reviews: `.tmp-af-hub-audit/reviews/candidate-{A..E}.json`
- Probe: `.tmp-af-hub-audit/cap-parity.cjs`
