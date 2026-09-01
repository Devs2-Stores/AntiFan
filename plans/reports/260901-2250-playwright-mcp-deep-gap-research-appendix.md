# Playwright MCP Deep Gap Research — Ultra Verifier Appendix & Source Validation

**Base Report:** `plans/reports/260901-2250-playwright-mcp-deep-gap-research.md` (Candidate D / `ResearchCandidate4` verbatim)  
**Date:** 2026-09-01  
**Mode:** `ak:research --ultra`  

---

## 1. Ultra Verifier Ranking & Selection Record

### Anonymized Candidate Mapping
- **Candidate A:** `ResearchCandidate1`
- **Candidate B:** `ResearchCandidate5`
- **Candidate C:** `ResearchCandidate2`
- **Candidate D:** `ResearchCandidate4`
- **Candidate E:** `ResearchCandidate3`

### Structured Verifier Scores (Rubric R1-R5, 1-20 each)

| Rank | Candidate | R1 (Depth) | R2 (E-Com) | R3 (Arch) | R4 (Action) | R5 (Security) | Total (100) | Verifier Finding / Rationale |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---|
| **1** | **D** | **20** | **20** | **20** | **20** | **20** | **100** | **Winner.** Selected for comprehensive domain coverage across sliders, drag-drop, compound keyboard combos, WCAG focus traps, mobile gestures, and document pipelines with concrete TypeScript designs. |
| 2 | C | 13 | 17 | 18 | 15 | 18 | 81 | Strong CDP Emulation/Localization schemas, but lacked advanced input interactions, document pipelines, and focus trap scanners. |
| 3 | A | 12 | 14 | 16 | 11 | 13 | 66 | Valid architectural directions via CDP Page.createIsolatedWorld, but submitted as a high-level summary lacking full interaction analysis. |
| 4 | E | 10 | 11 | 8 | 9 | 10 | 48 | Fails architectural feasibility by citing a non-existent Electron Main API (`WebFrameMain.executeJavaScriptInIsolatedWorld`). |
| 5 | B | 4 | 5 | 6 | 3 | 4 | 22 | Terse 10-line JSON stub lacking implementation depth. |

---

## 2. Controller Source Validation & Contract Qualifications

Per `ak:research --ultra` protocol, the base report is materialized **verbatim from Candidate D without controller text edits**. To protect downstream implementation (`/ak:plan`, `/ak:cook`), the following technical qualifications and source-backed corrections apply:

### A. Official Canonical Wire Names vs Winning Report Mentions
- **Winning Report Mention:** `browser_emulate`, `browser_throttle_network`, `browser_file_download`.
- **Official Source Fact (`microsoft/playwright-mcp@latest`):** These exact tool names do **not** exist in Playwright MCP canonical wire tools.
  - Media/timezone/CPU/network throttling are CDP/Playwright runtime options, not canonical MCP tools (except `browser_network_state_set` for online/offline).
  - PDF export is canonically named `browser_pdf_save({ filename? })`.
  - Download handling in AntiFan is an Electron-native session workflow, not `browser_file_download`.
- **Direction:** These remain high-value **AntiFan-native capabilities** (`anti.emulation.*`, `anti.download.*`), not canonical Playwright MCP wrappers.

### B. Compatibility Level Clarification
- **Input-Wire vs Full Drop-In:** AntiFan currently wraps tool responses in `{ ok: true, data, evidence }` JSON envelopes (`src/main/mcp/result-envelope.ts`). Playwright MCP serializes distinct action/result/code/snapshot text sections. True drop-in compatibility requires response serialization conformance and ref-lifecycle tests.

### C. Phase 0 Status Clarification
- Phase 0 items marked with `[x]` in Candidate D's roadmap indicate recommended P0 priorities from the candidate's analysis, not already implemented features in the codebase on 2026-09-01.

---

## 3. Grounded Implementation Priorities for Downstream Planning

1. **P0 (Highest Token & Ergonomic ROI):**
   - Bounded snapshot search (`browser_find` / `anti.inspect.find`) & subtree/box/file options for `browser_snapshot`.
   - Numbered request list and detail forensics (`browser_network_requests`, `browser_network_request`).
   - Compound key combo parser in `keyboard-normalizer.ts` (`Shift+Tab`, `Escape`, `Control+Enter`).
   - Range slider control (`anti.agent.slider_set`).
2. **P1 (Storefront QA & Gestures):**
   - Element-to-element trusted mouse drag (`browser_drag` / `anti.agent.drag`).
   - Theme Drawer focus-trap QA scanner (`theme.qa.focus_trap_validate`).
   - CDP Emulation overrides for `prefers-color-scheme`, locale, and network conditions.
   - Storage-state JSON export/import restricted to isolated test capsules.
3. **P2 (Demand-Driven):**
   - Cross-origin iframe isolated world routing.
   - Silent download interception and `browser_pdf_save`.
