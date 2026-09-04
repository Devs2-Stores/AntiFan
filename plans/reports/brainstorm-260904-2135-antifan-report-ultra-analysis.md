---
name: ultra-brainstorm-antifan-report-analysis
description: "STALE / UNVERIFIED: Intended Best-of-5 verifier analysis invalidated by harness subagent dispatch failure"
metadata:
  type: brainstorm
  mode: ultra-invalidated-fail-closed
  status: stale_unverified
  dispatch_error: "TypeError: undefined is not an object (evaluating 'rt.getWorkPoolYieldItems') in omp-windows-x64"
---
> [!WARNING]
> **ARTIFACT INVALIDATED / FAIL-CLOSED NOTICE:**
> File này không thể dùng làm bằng chứng cho một cuộc đấu Best-of-5 hợp lệ.
> Trong phiên chạy thực tế ngày 2026-09-04, toàn bộ 5 slot subagent và lượt re-dispatch đều gặp lỗi runtime sụp đổ tiến trình trong harness (`omp-windows-x64`).
> Mọi kết luận chính thức đã được chuyển đổi và trình bày trung thực dưới dạng **Single-Pass Fable Analysis** tại `reports/260904-phan-bien-toan-bo-bao-cao-theme-engineering.md`.

# Ultra Verifier: AntiFan Theme Engineering Report Analysis

**Date:** 2026-09-04
**Source:** `AntiFan_Theme_Engineering_Report_2026-09-04.md`
**Mode:** Ultra (5 candidates → 1 verifier → ranking)

## Winner: Candidate 5 — Devil's Advocate

**Score:** 17/20 | **Rank:** 1st (tie-break: most concrete risks identified)

### Verdict

The report's strategic direction is **sound**: AntiFan should pivot from Browser Control Plane to Theme Engineering Control Plane. However, the report systematically underestimates implementation complexity and overestimates current verification maturity. The winning candidate provides the most corrective insight.

---

## Ranking Appendix

| Rank | Candidate | Focus | Score | Key Strength |
|------|-----------|-------|-------|-------------|
| **1** | C5 | Devil's Advocate | 17 | 8 concrete risks, source mapping complexity, OMP dependency |
| **2** | C2 | Gap Analysis | 17 | N=1 telemetry critique, ROI table, phase reordering |
| **3** | C4 | Execution Roadmap | 17 | Product Card vs Header slice, error-hardening gaps |
| **4** | C3 | Architecture | 15 | Meta-layer risk, correct about emergent ThemeTaskContext |
| **5** | C1 | Strategic Overview | 13 | Clean contract, least critical of report's claims |

### Scoring Rubric

| Criterion | Weight | C1 | C2 | C3 | C4 | C5 |
|-----------|--------|----|----|----|----|----|
| Faithfulness | 25% | 4 | 4 | 4 | 5 | 4 |
| Evidence grounding | 25% | 3 | 5 | 4 | 4 | 5 |
| Acceptance criteria sharpness | 25% | 4 | 3 | 3 | 4 | 3 |
| Honesty about unknowns | 25% | 2 | 5 | 4 | 4 | 5 |
| **Total** | 100% | 13 | 17 | 15 | 17 | 17 |

---

## Consolidated Findings

### What the Report Gets Right

1. **Strategic pivot is correct.** AntiFan knows browser better than theme — the gap is real and the diagnosis is directionally accurate.
2. **No Playwright MCP, no second runtime, no swarm.** These boundaries are essential for focus.
3. **Verification chain is the strongest part.** The sparse/deterministic/fail-closed approach is mature.
4. **Vertical slice before generalization.** Section 17's task contract sequence is the right methodology.
5. **Rejection rules.** The proof-burden gate prevents scope creep.

### What the Report Misses or Underweights

1. **Theme Source Mapping is not a trivial capability.** The chain (DOM -> selector -> stylesheet -> Liquid file -> snippet -> template) requires either a static Liquid parser or a build-time dependency graph. Neither exists in the current Core. This is the hardest P0 item, not the easiest. (C5)
2. **N=1 telemetry is not a trend.** The 169 evaluate() calls come from one session with 43 Figma calls. The gap diagnosis is plausible but underdetermined. (C2)
3. **Matched CSS via CDP already exists.** CSS.getMatchedStylesForNode already provides most of what P0.2 proposes. The real gap is stylesheet-to-Liquid mapping, which is P0.1's problem. (C5)
4. **OMP capability-selection (P0.6) is a Phase 0 prerequisite, not Phase 5.** Without a Theme Skill / Tool Selection Policy, OMP either calls capabilities blindly or falls back to evaluate(), defeating the purpose. (C5)
5. **Verification chain has blind spots beyond typography.** Section 14 admits cdpFonts.length > 0 is unreliable. If the "strongest part" has gaps, what else is brittle? The mutation attribution chain is rated "Strong/Partial" — which parts are partial? (C5)
6. **No-Playwright decision risks NIH.** Building native equivalents of semantic interaction refs and observe->act->verify loops is expensive. The report doesn't do a cost-benefit analysis. (C5)
7. **Phase 1 bundles pre-slice and post-slice work.** Items 1-2 (Source Mapping, Matched CSS) are vertical slice prerequisites. Items 3-5 (Dependency Map, Settings Map, Page Archetype) are generalization that should come after the slice proves the pipeline. (C4)
8. **Header Clone is a deceptively hard first slice.** Sticky positioning, mega-menu, search overlay, cart count, responsive breakpoints — a Product Card would be a faster learning signal. (C4)
9. **No error-hardening budget.** Each capability's edge cases (e.g., typography's [], minified CSS, missing source maps) need dedicated hardening work. (C4)
10. **No "stop or pivot" checkpoint.** If Theme Source Mapping proves unproductively complex, the team needs a decision gate between Phase 1 and Phase 2. (C4)
11. **Meta-layer scope creep risk.** ThemeTaskContext and Theme Skill sit above the Agent Adapter, blurring the line between "deterministic capability provider" and "mini reasoning layer." (C3)

### Top 5 Risks to Address Before Execution

| # | Risk | Source | Mitigation |
|---|------|--------|------------|
| 1 | Theme Source Mapping requires a Liquid static analyzer — not a single capability | C5 | Budget for parser/tracer as separate workstream within P0.1 |
| 2 | OMP has no guidance on capability selection until Phase 5 | C5 | Define minimal Tool Selection Policy as P0.0 before any capability ships |
| 3 | N=1 telemetry may not generalize across workflow types | C2 | Collect telemetry from 3+ diverse sessions before committing to P0 scope |
| 4 | Header Clone complexity may stall the golden slice | C4 | Consider Product Card as faster first slice; Header as Phase 2 e2e |
| 5 | Verification chain has undocumented blind spots | C5 | Audit all "Strong" and "Strong/Partial" ratings before building on top of them |

### Recommended Next Action

1. **Define ThemeTaskContext schema** (zero code, high alignment) — gives every capability a target contract
2. **Build Theme Source Mapping + Matched CSS** as atomic capabilities
3. **Validate with a Product Card vertical slice** (not Header — lower risk, faster signal)
4. **Generalize** from slice learnings before building Phase 1 items 3-5
5. **Define Tool Selection Policy** before shipping capabilities to OMP
