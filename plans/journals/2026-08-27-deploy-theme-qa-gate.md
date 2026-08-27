---
title: Deploy Theme QA Automation Gate (Internal Preview RC1)
date: 2026-08-27
summary: "Deployed the Theme QA automation gate: MCP dispatch + UI badge wiring, HS-04 static fallback fix, and CHANGELOG/plan alignment to implemented HS-01..06 scope. 255 tests green, tree clean."
---

# Deploy Theme QA Automation Gate (Internal Preview RC1)

Deployed the verified Theme QA automation gate and corrected the released documentation to match actual scope.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

## What shipped (origin/main cd88b72..62a3a53)

- `feat(qa)` c70419f — wire Theme QA automation gate: `theme.qa_validate` (optional `multiBreakpoint`), `theme.debug_bundle` (hierarchy + passive cart telemetry), MCP aliases, ControlPlaneRuntime.validateThemeQa, badge reset on active main-frame nav, summary modal.
- `fix(qa)` 999e71e — HS-04 static fallback downgraded `error→warning`: a static HTML scan cannot prove a `deleteAddress` handler is absent (it may load from an external script), so it must never flip the QA gate on the degraded path; the runtime DOM engine (typeof check) stays authoritative.
- `docs(qa)` 62a3a53 — corrected CHANGELOG v1.3.0 HS-03/HS-04 descriptions to match code (comment casing / deleteAddress), added HS-05/HS-06, and aligned the plan to the implemented HS-01..HS-06 scope.

## Evidence

- `npm run verify` → **255 tests / 58 suites / 0 fail**; `tsc` typecheck pass; working tree clean.
- New `test/main/hs-gate-rules.test.ts` (5 tests) pins the static-engine invariant: HS-04 reference without inline handler is a warning, never a gate flip; core HS-01/HS-02 rules still fire.
- UI badge/modal wiring verified end-to-end: `toolbar.ts` click stores the report → `renderThemeQa(state, report)` sets `lastThemeQaReport` → `openThemeQaSummary()` renders findings.

## Open / honest gaps

- Independent code-review delegation blocked by infrastructure: the delegated reviewer agents fail on a google schema-rejection at dispatch (6 attempts: schema ×5, rate-limit ×1). This is NOT counted as a review pass; the backing is a main-agent Fable-thinking review + the 255-test suite.
- HS-07..HS-26 are not implemented; the HS matrix grows from real pilot findings, not a full claim.
- HS-04 static behavior has not been confirmed against a real Sapo storefront via live eval — needs a pilot.
- Release framing is **Internal Preview (RC1)**, not a public production release.