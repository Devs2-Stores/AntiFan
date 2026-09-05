---
title: "AntiFan Core Pre-Freeze Hardening & Live Proof"
description: "Harden evidence identity, verification retry semantics, and source candidacy; prove two real Chromium theme slices; certify Core on Windows before product-workflow expansion."
status: in-progress
priority: P1
effort: "7-10d implementation + 3x45m certification"
branch: main
tags: [refactor, critical, verification, theme-intelligence, chromium, windows]
blockedBy: []
blocks: [260904-0036-antifan-core-verification-and-primitives]
created: 2026-09-05
---

# AntiFan Core Pre-Freeze Hardening & Live Proof

## Outcome

AntiFan Core becomes authority-first for one real theme workflow: every multi-modal observation belongs to one browser/document/mutation identity; verification retries are bounded and auditable per runtime batch; source output remains defensible candidacy rather than fabricated truth; Product Card and Hamburger/Drawer pass through real Chromium, CDP, workspace mutation, re-render, responsive proof, and per-invocation receipts; Windows certification is repeatable.

## Constraints

- Reuse `NativeTabHost`, `BrowserControlPort`, `CapabilityTransportAdapter`, `IssueRegister`, `ReceiptStore`, `ArtifactStore`, `WorkspaceFilePort`, and the five-verdict evaluator.
- Preserve `VERIFIED | PARTIAL | REJECTED | INCONCLUSIVE | UNVERIFIED` as the sole public verdict taxonomy.
- Keep product selectors, Liquid fixtures, and workflow intent outside `src/main/`; exact responsive widths remain `320, 375, 768, 1024, 1440`.
- Fail closed on mixed-generation capture, ambiguous source lineage, missing invocation identity, stale context, receipt durability failure, and exhausted retry budgets.
- Existing quick soak and historical 5-hour run are evidence inputs, not final certification.

## Non-Goals

- No Playwright MCP, new browser abstraction, second agent runtime, swarm, verifier v2, Liquid AST engine, causal database, locator framework, plugin/provider platform, Rust/WebMCP/cloud migration, full clone engine, or Figma engine in Core.
- No OMP Theme Skill, ambient context, unified Chat/Annotation/Prompt task contract, or product workflows in this delivery; those begin only after Core freeze.
- No external storefront dependency in proof or soak; fixtures are deterministic and local.

## Cross-Plan Dependencies

| Relationship | Plan | Reason |
|---|---|---|
| Prerequisite complete | `260904-2216-theme-intelligence-and-evidence-boundary` | Current theme capabilities and mocked contract harness already exist. |
| Blocks completion | `260904-0036-antifan-core-verification-and-primitives` | Replaces its unresolved soak/certification boundary with stricter live-proof and repeatability gates. |
| Related, no block | `260828-1033-qa-fresh-target-reliability` | Shares freshness concepts, but this plan owns only `observe()` coherence and verification evidence identity. |
| Related, no block | `260901-1548-browser-target-rebinding-and-server-500-detection` | Must consume explicit authority transitions later; no implicit retargeting is introduced here. |

## Phases

| # | Phase | Status | Depends On | Exit Gate |
|---|---|---|---|---|
| 1 | [Capture and CSS Evidence Integrity](./phase-01-capture-integrity.md) | Complete | — | Mixed epoch/document/mutation evidence cannot escape; `STRONG PASS` requires resolved source position. |
| 2 | [Batch-Scoped Verification Retry Lifecycle](./phase-02-retry-lifecycle.md) | Complete | 1 | Two budgets, truthful state transitions, and one durable receipt per verification invocation. |
| 3 | [Correlated Source Candidacy](./phase-03-source-candidacy.md) | Complete | 1-2 | Token-aware lineage scoring; ambiguous/MEDIUM candidates cannot satisfy authoritative source proof. |
| 4 | [Real Chromium Theme Proof](./phase-04-live-chromium-proof.md) | Complete | 1-3 | Product Card and Hamburger/Drawer pass through the real local runtime with anti-mock assertions. |
| 5 | [Windows Freeze Certification](./phase-05-freeze-certification.md) | In Progress | 1-4 | Three clean 45-minute process starts pass all correctness, resource, teardown, and false-positive gates. |

## Global Acceptance Criteria

- [x] Every accepted observation exposes one live `browserEpoch`, `documentGeneration`, and `mutationRevision`; any pre/post mismatch returns an explicit stale/integrity error and no mixed bundle.
- [x] `RESAMPLE` and repair failures consume separate per-`(runId, attemptId, claimId)` budgets; non-retryable inconclusive reasons halt; no success silently clears another batch's history.
- [x] Every `verify_claim` execution with a receipt store has authenticated `invocationId` identity and a durable terminal receipt; evaluation non-pass is a completed capability result, not a transport failure.
- [x] Source `HIGH` requires correlated same-lineage evidence and deterministic uniqueness; `MEDIUM/LOW/ambiguous` never passes `SOURCE_FILE_IDENTIFIED`.
- [x] Two local live-Chromium slices prove real DOM/CDP/file capability/re-render/responsive/verification behavior; the existing mock-host test remains classified as integration-only.
- [ ] Three fresh-process Windows 45-minute runs pass existing total RSS/renderer SLOs, zero resource leaks, zero stale-context acceptance, and zero injected false verification; artifacts record raw samples and threshold decisions.

## Validation Log

- Deep research: direct source/test/report inspection completed. Eight scout dispatches failed before execution with the same harness `getWorkPoolYieldItems` error; no empty output was used as evidence.
- Advisory checkpoint: `kongming` definition exists on disk but is not registered by this runtime; `--advice` counsel unavailable and not silently substituted.
- Red Team: adversarial source collisions, stale identity, no-op/ambient mutation, forged report, threshold tampering, duplicate process-start, and false-verification canaries passed their fail-closed checks.
- Validation: compile, focused/unit/main/fast suites, two real Chromium slices, and quick freeze smoke pass. The replacement certification is deferred until an uninterrupted workstation window: run 1 passed the hardened validator, but run 2 failed closed on an unverified Drawer trace; no current-build aggregate certificate exists and the next sequence must restart from run 1.

## Open Questions

None. Empirical per-process-class memory thresholds are calibrated and frozen before the first certification run in Phase 5; existing ratified total/renderer limits remain hard gates throughout.

<!-- slug: core-pre-freeze-hardening-and-live-proof -->