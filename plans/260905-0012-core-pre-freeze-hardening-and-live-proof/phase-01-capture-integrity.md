---
phase: 1
title: "Capture and CSS Evidence Integrity"
status: complete
priority: P1
effort: "1.5-2d"
dependencies: []
---

# Phase 1: Capture and CSS Evidence Integrity

## Context Links

- [Plan](./plan.md)
- [Integrated report — optimistic evidence boundaries](../../../E:/Download/AntiFan_Final_Integrated_Architecture_Report_2026-09-04.md) (external source; sections 6-10, 26-27)
- Owners: `src/main/tools/browser-control-port.ts`, `src/main/browser/native-tab-host.ts`, `src/main/browser/css-cascade-analyzer.ts`

## Overview

Make each accepted observation one coherent point-in-time evidence bundle and tighten CSS provenance. Current `observe()` fences only `documentGeneration`; a same-document mutation can mix DOM, screenshot, snapshot, and diagnostics, while returned `browserEpoch` is copied from the caller rather than re-read from the live host. Current CSS `STRONG PASS` needs only an active rule, stylesheet ID, and URL; it does not require a proven source position.

## Requirements

- Functional:
  - Sample live `(browserEpoch, documentGeneration, mutationRevision)` before capture, after every component, and once before commit.
  - Return the live tuple, component timestamps, capture ordering, and total drift only when all fences match.
  - Throw `TARGET_STALE` for epoch/document identity changes and `INTEGRITY_COMPROMISED` for same-document mutation drift; never return a mixed bundle.
  - Buffer bounded raw component payloads until the final fence passes; stage artifacts only after validation so failed capture leaves no authoritative partial artifact set.
  - Preserve raw CDP matched-style identity. Mark analyzer winner/loser classification as derived enrichment; require resolved stylesheet URL **and** CDP source range for `STRONG PASS`.
- Non-functional:
  - No global lock. Reuse the existing per-tab `passivePool`; added checks are constant-time map reads.
  - Preserve four-component and current byte bounds. No duplicate theme evidence database or lifecycle fields.

## Architecture

```text
resolve target
  -> read live IdentityTuple(epoch, document, mutation)
  -> capture bounded component in memory
  -> re-read tuple after component
  -> mismatch? fail closed, discard buffered payloads
  -> final tuple fence
  -> stage bounded artifacts
  -> return one coherent observation
```

`BrowserHostPort.getBrowserEpoch?()` is the only new seam. Production wiring delegates to `NativeTabHost.getBrowserEpoch()`. Missing epoch/mutation accessors are tolerated only for legacy test hosts and make those fields explicit as caller-bound/unknown; production registration must expose both and a contract test enforces that wiring.

CSS evidence remains two layers:

```text
raw CDP matched rules + matching selector/range
  -> conservative derived classification
  -> PASS: matched rule identity present
  -> STRONG PASS: asserted active rule has stylesheet ID + resolved URL + source range
```

## File Inventory

| Action | File | Rough Change | Test Impact |
|---|---|---:|---|
| Modify | `src/main/tools/browser-control-port.ts` | Add live epoch seam, identity tuple, mutation metadata, capture-then-commit flow | Main observe coherence tests |
| Modify | `src/main/index.ts` | Wire `getBrowserEpoch` from `NativeTabHost` | Production adapter contract |
| Modify | `src/main/browser/css-cascade-analyzer.ts` | Preserve CDP range, derived classification provenance, strict `STRONG PASS` | Theme evidence unit tests |
| Modify | `test/main/browser-observe-coherence.test.ts` | Add epoch/mutation/partial-artifact race cases | Focused behavioral coverage |
| Modify | `test/unit/theme-evidence-capabilities.test.ts` | Correct CSS strong/pass expectations | Focused contract coverage |
| Modify | `scripts/smoke-mcp-industrial-e2e.cjs` | Wire live epoch/mutation getters in existing real adapter | Prevent smoke divergence |

No files are deleted. Do not add a capture coordinator class; the existing `observe()` method owns the transaction boundary.

## Function and Interface Checklist

- [x] `BrowserHostPort.getBrowserEpoch` reads live host authority.
- [x] `BrowserObserveResult.target` includes `mutationRevision` and never reports a stale caller epoch as live truth.
- [x] `BrowserControlPort.observe` checks the identity tuple after each awaited component and before staging.
- [x] Artifact staging occurs only after the final coherence check.
- [x] `CssDeclaration` carries CDP line/column only when a real range exists.
- [x] `CssCascadeAnalyzer.analyze` cannot mint `STRONG PASS` from URL presence alone.
- [x] Production and live-smoke adapters wire every identity accessor used by the fence.

## Dependency Map

```text
NativeTabHost identity maps
  -> BrowserHostPort adapter
  -> BrowserControlPort.observe
  -> Phase 2 verification samples
  -> Phase 4 live proof
```

Phase 2 consumes coherent capture semantics. Phase 3 can proceed after the result contract is stable. Phase 4 must exercise this phase in real Chromium.

## Implementation Steps

1. Add a private immutable `ObservationIdentity` tuple and a single comparison helper in `browser-control-port.ts`; do not spread identity comparisons across each branch.
2. Add optional `getBrowserEpoch()` to `BrowserHostPort`, wire it in `src/main/index.ts` and every live smoke adapter touched by this plan, and fail production registration tests if the adapter omits it.
3. Refactor `observe()` to capture each requested component into bounded local values, fence after every `await`, perform one final fence, then stage artifacts and build the result.
4. Include the initial live tuple in returned target metadata. Keep `timestamps` and `sequence`; add no second envelope.
5. Extend raw CSS rule/property types only for CDP-provided source range and selector-match metadata. Preserve raw facts separately from derived precedence.
6. Tighten `definitionOfDone`: `STRONG PASS` only when all active declarations used by the asserted contract have resolvable stylesheet identity and source position; otherwise `PASS`/`PARTIAL`.
7. Update focused tests and existing real-smoke wiring; compile, then run the narrow test files.

## Test Scenario Matrix

| Priority | Scenario | Observable Contract | Expected |
|---|---|---|---|
| Critical | Document generation changes after DOM capture | No mixed result/artifacts | `TARGET_STALE` |
| Critical | Mutation revision changes between DOM and screenshot | No mixed result/artifacts | `INTEGRITY_COMPROMISED` |
| Critical | Browser epoch changes during capture | Caller epoch is not echoed as success | `TARGET_STALE` |
| High | Four stable components | Same tuple, ordered timestamps, bounded payloads | Success |
| High | Artifact sink configured and final fence fails | No staged authoritative component refs | Zero new artifacts |
| High | CSS URL but no real CDP range | Provenance incomplete | `PASS`, never `STRONG PASS` |
| Medium | Stable capture with legacy mock lacking optional getters | Explicit fallback only in unit harness | Deterministic result; production wiring test still fails omissions |

## Verification Commands

```text
npm run compile
node --test .compiled/test/main/browser-observe-coherence.test.js
node --test .compiled/test/unit/theme-evidence-capabilities.test.js
```

Phase 4 supplies the real-runtime proof; these focused tests alone do not certify Chromium behavior.

## Todo

- [x] Add live epoch and mutation identity contract.
- [x] Make observation capture atomic at the evidence boundary.
- [x] Prevent partial artifact publication on capture drift.
- [x] Tighten CSS source-position and derived-causality semantics.
- [x] Pass focused capture and CSS evidence tests.

## Success Criteria

- [x] All stable observation components share exactly one live identity tuple.
- [x] Navigation, host restart, and in-document mutation races each fail with the specified code.
- [x] A failed capture publishes no authoritative partial artifact bundle.
- [x] URL-only CSS provenance cannot produce `STRONG PASS`; real source ranges can.
- [x] No new lock, store, background worker, or product-specific Core code is introduced.

## Risk Assessment

- **Mutation revisions may advance from unrelated ambient page activity.** Signal: live pages fail capture repeatedly without agent action. Response: do not weaken the fence; use existing media freeze/quiescence before retry and let Phase 2's resample budget bound the loop.
- **Artifact buffering may increase peak memory.** Signal: four-component capture exceeds current bounded sum. Response: retain current component limits and stage only after final validation; do not clone buffers.
- **Some CDP rules lack source ranges.** Signal: former `STRONG PASS` cases downgrade. Response: accept truthful `PASS`; do not synthesize line/column.

## Security Considerations

- Keep workspace/project/run/attempt identity on staged artifacts unchanged.
- Do not expose raw page secrets in new metadata; identity tuple contains counters only.
- Fail closed if the live host cannot establish authoritative identity in production.

## Rollback Boundary

One phase-local revert restores the prior observe result shape and CSS DoD. Do not proceed to Phase 2 if the real adapter cannot expose live epoch/mutation without reaching into private host fields.

## Next Steps

Proceed to Phase 2 only after the focused tests pass and the capture result contract is fixed.
