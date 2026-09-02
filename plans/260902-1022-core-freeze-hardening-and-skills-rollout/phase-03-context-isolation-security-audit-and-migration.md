---
phase: 3
title: "Decouple HS-01..HS-06 Rules & Freeze Core Raw Scanners"
status: blocked
priority: P1
effort: "45m"
dependencies: [2]
blocker: "Prerequisite: External skill://theme-qa-az workspace must be provisioned before removing hs-gate-rules.ts from Core. Until then, retain hs-gate-rules.ts in Core without destructive deletion."
---

# Phase 3: Decouple HS-01..HS-06 Rules & Freeze Core Raw Scanners

## 1. Overview
`src/main/qa/rules/hs-gate-rules.ts` contains e-commerce compliance rules HS-01 through HS-06 (Sapo/Haravan cart `variantId`, `/postcontact`, comment casing `Author/Email/Body`, `deleteAddress`, CDN image URL, and `noPS` analytics guards).

While the architectural end-state is to move all mutable business heuristics to OMP Skills, **this phase is marked BLOCKED pending the creation/provisioning of the external `theme-qa-az` skill workspace**.

**Invariant for Core Freeze:**
- **DO NOT** delete or destabilize `src/main/qa/rules/hs-gate-rules.ts` until the external `theme-qa-az` skill workspace is available.
- Core raw scanners in `src/main/qa/scanners/` (`LiquidErrorScanner`, `ServerCrashScanner`, `BrokenAssetScanner`, `LayoutOverflowEngine`) remain frozen and provide unadulterated sensory telemetry.

## 2. Requirements & Prerequisite
- Prerequisite: `theme-qa-az` skill workspace established.
- Retain existing HS-01..HS-06 implementation in Core as a baseline compatibility layer.
- Ensure all raw diagnostic scanners export structured telemetry without throwing unhandled exceptions.

## 3. Current In-Tree Rule Inventory (HS-01..HS-06)
1. **HS-01:** Sapo/Haravan Cart `variantId` vs `id` form attribute check.
2. **HS-02:** Sapo `/postcontact` vs `/contact` endpoint and `contact[email]` verification.
3. **HS-03:** Sapo blog comment field casing (`Author`, `Email`, `Body`).
4. **HS-04:** Customer address deletion handler (`deleteAddress`).
5. **HS-05:** Absolute platform CDN image URL check (`hstatic.net`, `dktcdn.net`, `shopifycdn.com`).
6. **HS-06:** Analytics / heavy script `data-nops` or `StartOptimize` attribute guard.

## 4. Related Code Files
- Retain: `src/main/qa/rules/hs-gate-rules.ts`
- Retain: `src/main/qa/scanners/*.ts`

## 5. Success Criteria & Verification
- [ ] `hs-gate-rules.ts` preserved without breaking existing tests.
- [ ] Raw scanners in `src/main/qa/scanners/` remain pure telemetry producers.
- [ ] Phase status explicitly tracked as `BLOCKED` until external skill handoff.
