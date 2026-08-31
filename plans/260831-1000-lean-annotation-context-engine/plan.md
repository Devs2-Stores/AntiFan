# Plan: Lean Annotation Context Engine & High-SNR Token Optimization

## Overview
Re-architect AntiFan's annotation artifact generation from a heavy boilerplate dump (~5KB, 5,000+ tokens) into a precision **Lean Context Engine** (`AGENT_CONTRACT_VERSION: 3.2.0-lean`, < 1.2KB, < 800 tokens). This reduces token waste by 75%, eliminates Attention Dilution in downstream LLMs (Claude Code, Fable, Codex, OMP), filters active visual CSS styles, and auto-correlates runtime console & network failures directly from `TabDiagnostics`.

## Key Metadata
- **Status:** Pending
- **Priority:** P1 (Core UX & AI Tooling Reliability)
- **Estimated Total Effort:** 3-4 hours
- **Advisory Supervision:** Kongming (`--advice`, Fable Thinking Protocol)

---

## Phase Roadmap

| Phase | Title | Priority | Status | Effort | Dependencies |
|---|---|---|---|---|---|
| **Phase 1** | [Lean Contract & Agent Header](phase-01-lean-contract-and-task-header.md) | P1 | pending | 1h | [] |
| **Phase 2** | [CSS Whitelist & Correlated Diagnostics Engine](phase-02-css-whitelist-and-active-diagnostics.md) | P1 | pending | 1.5h | [phase-1] |
| **Phase 3** | [PTY Terminal Dispatch & Comprehensive Test Verification](phase-03-pty-dispatch-and-test-verification.md) | P1 | pending | 1h | [phase-2] |

---

## Acceptance Criteria
- [ ] 1. Generated Markdown files at `.antifan/annotations/` drop from ~5KB to < 1.5KB, token count < 1,000 tokens.
- [ ] 2. 150 lines of static `STANDALONE_AGENT_CONTRACT` replaced with a 15-line high-impact directive set.
- [ ] 3. Only active, high-signal CSS properties (display, flex, color, font, size, spacing, border) are preserved; browser default CSS noise is dropped.
- [ ] 4. Any relevant 404/500 resource failure or JavaScript exception in the active tab context is automatically injected into `## ⚠️ Correlated Diagnostics`.
- [ ] 5. All existing test suites pass, plus new test assertions verifying artifact byte size and token efficiency.
